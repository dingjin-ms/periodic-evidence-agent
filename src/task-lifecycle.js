import { existsSync, readFileSync, readdirSync, lstatSync } from 'node:fs';
import { dirname, join, resolve, relative, isAbsolute, sep } from 'node:path';
import { hash, json, requireThat, now, safeError, uuid } from './common.js';
import { nativeCommand } from './native-command.js';
import { prepareValidationWorkspace, preparationGit } from './validation-workspace.js';
import { updateResource, resourceRecord, reconcileResources, resourceLeaseActive } from './resource-lifecycle.js';
import { persistRunArtifact, completeRunEvidence } from './state-retention.js';

function boundReceipt(ref, format, close, status) {
  requireThat(ref && isAbsolute(ref.path) && /^[a-f0-9]{64}$/.test(ref.sha256) &&
    lstatSync(ref.path).isFile() && !lstatSync(ref.path).isSymbolicLink() &&
    lstatSync(ref.path).size < 1024 * 1024 &&
    hash(readFileSync(ref.path)) === ref.sha256,
  'Coding task close needs intact external validation and handover receipts', 'blocked-task-close');
  const receipt = JSON.parse(readFileSync(ref.path, 'utf8'));
  requireThat(receipt.format === format && receipt.status === status &&
    receipt.repository === close.repository && receipt.number === close.number &&
    receipt.revision === close.revision,
  'Coding task close receipt does not bind the delivered PR revision', 'blocked-task-close');
}
function checkClose(close) {
  requireThat(close && /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(close.repository) &&
    Number.isSafeInteger(close.number) && close.number > 0 &&
    /^[a-f0-9]{40,64}$/.test(close.revision),
  'Coding task close requires an exact repository, PR and delivered revision', 'blocked-task-close');
  boundReceipt(close.validation, 'coding-task-validation-v1', close, 'passed');
  boundReceipt(close.handover, 'coding-task-handover-v1', close, 'complete');
}
async function pullRequest(record) {
  const { stdout } = await nativeCommand('gh', ['pr', 'view', String(record.close.number),
    '--repo', record.close.repository,
    '--json', 'state,isDraft,mergedAt,headRefOid,statusCheckRollup'],
  record.source, 30000, process.env);
  return JSON.parse(stdout);
}
async function mergedTask(record, getPullRequest) {
  checkClose(record.close);
  const pr = await getPullRequest(record);
  requireThat(pr.headRefOid === record.close.revision,
    'Coding task PR head no longer matches the closed delivery', 'blocked-task-close');
  if (pr.state !== 'MERGED' || pr.isDraft || !pr.mergedAt) return false;
  requireThat(Array.isArray(pr.statusCheckRollup) && pr.statusCheckRollup.every(check =>
    check.__typename === 'StatusContext'
      ? check.state === 'SUCCESS'
      : check.status === 'COMPLETED' && ['SUCCESS', 'NEUTRAL', 'SKIPPED'].includes(check.conclusion)),
  'Merged coding task still has unsuccessful or pending PR checks', 'blocked-task-close');
  return true;
}

// This is the task-close boundary for Controller-launched coding commands.
// It deliberately cannot enroll an arbitrary existing CLI checkout.
export async function closeCodingTask(config, request, { getPullRequest = pullRequest } = {}) {
  const record = resourceRecord(config.stateDirectory, request.resourceId);
  if (record.close) {
    requireThat(json(record.close) === json({
      repository: request.repository, number: request.number, revision: request.revision,
      validation: request.validation, handover: request.handover
    }), 'Cannot replace an existing coding task handover', 'blocked-task-close');
    return monitorResourceLifecycle(config, { getPullRequest });
  }
  requireThat(record.kind === 'task' && record.processesExited === true &&
    record.runnerEvidence && record.references.every(ref => ref === `task:${record.assignmentId}`),
  'Only a drained Controller-owned coding task can enter close/merge monitoring', 'blocked-task-close');
  const close = { repository: request.repository, number: request.number,
    revision: request.revision, validation: request.validation, handover: request.handover };
  checkClose(close);
  for (const ref of [close.validation, close.handover]) {
    const rel = relative(resolve(record.workspace), resolve(ref.path));
    requireThat(rel && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)),
      'Coding task receipts must be outside its worktree', 'blocked-task-close');
  }
  requireThat(await preparationGit(record.workspace, ['rev-parse', 'HEAD'], 30000) === close.revision,
    'Coding task worktree no longer matches its handover revision', 'blocked-task-close');
  await updateResource(config.stateDirectory, record.id, {
    close, references: [`merge:${close.repository}#${close.number}`], releaseRequested: false,
    evidence: [...record.evidence, close.validation, close.handover]
  });
  return monitorResourceLifecycle(config, { getPullRequest });
}

export async function monitorResourceLifecycle(config, { getPullRequest = pullRequest } = {}) {
  const root = join(config.stateDirectory, 'resource-lifecycle');
  if (!existsSync(root)) return [];
  const transitions = [];
  for (const file of readdirSync(root).filter(file => /^[a-f0-9-]{36}\.json$/.test(file))) {
    const record = resourceRecord(config.stateDirectory, file.slice(0, -5));
    if (record.kind !== 'task' || !record.close || record.releaseRequested ||
      record.stage === 'complete' || resourceLeaseActive(record)) continue;
    try {
      requireThat(record.processesExited === true, 'Coding task process exit is unconfirmed', 'blocked-task-close');
      requireThat(record.references.length === 1 &&
        record.references[0] === `merge:${record.close.repository}#${record.close.number}`,
      'Coding task has another active seed, proof or downstream reference', 'blocked-task-close');
      if (!await mergedTask(record, getPullRequest)) {
        transitions.push({ id: record.id, status: 'retained', reason: 'PR is not merged; merge reference retained' });
        continue;
      }
      await updateResource(config.stateDirectory, record.id, {
        references: [], releaseRequested: true, monitorError: null
      });
    } catch (error) {
      await updateResource(config.stateDirectory, record.id, { monitorError: safeError(error) });
      transitions.push({ id: record.id, status: 'blocked', error: safeError(error) });
    }
  }
  const results = await reconcileResources(config.stateDirectory, {
    verifyTask: record => mergedTask(record, getPullRequest)
  });
  for (const record of results) {
    if (record.kind === 'task' && record.stage === 'complete' && record.status !== 'blocked')
      completeRunEvidence(config, record.assignmentId);
  }
  return [...transitions, ...results];
}

export async function runCodingTask(config, request, execute = nativeCommand) {
  requireThat(isAbsolute(request.source) && isAbsolute(request.executable) &&
    Array.isArray(request.args) && request.args.every(arg => typeof arg === 'string') &&
    Number.isSafeInteger(request.timeoutMs) && request.timeoutMs > 0 &&
    typeof request.branch === 'string' && request.branch,
  'Coding task requires an explicit source, executable, arguments, branch and timeout', 'blocked-task-run');
  await preparationGit(request.source, ['check-ref-format', '--branch', request.branch], 30000);
  const id = uuid(), workspace = join(config.stateDirectory, 'task-workspaces', id);
  const start = persistRunArtifact(config, id, join('task', 'start.json'), json({
    format: 'coding-task-start-v1', workspace, startedAt: now()
  }));
  const closeRequest = join(dirname(start.path), 'close-request.json');
  let resourceId = null, failure = null, processesExited = false;
  try {
    await prepareValidationWorkspace({
      source: request.source, workspace, revision: request.revision, timeoutMs: 120000,
      lifecycle: { stateDirectory: config.stateDirectory, kind: 'task',
        assignmentId: id, attemptId: id, references: [`task:${id}`],
        cachePaths: request.cachePaths ?? [],
        created: resource => { resourceId = resource.id; } }
    });
    await preparationGit(workspace, ['switch', '-c', request.branch], 30000);
    const output = await execute(request.executable, request.args, workspace, request.timeoutMs, {
      ...process.env, PILOT_TASK_RESOURCE_ID: resourceId, PILOT_TASK_CLOSE_REQUEST: closeRequest
    });
    requireThat(output.ownedProcessesExited === true,
      'Coding task runner did not confirm owned process-tree exit', 'blocked-task-run');
    processesExited = true;
  } catch (error) {
    processesExited = error.ownedProcessesExited === true && error.containmentFailure !== true;
    failure = safeError(error);
  }
  const artifact = persistRunArtifact(config, id, join('task', 'runner.json'), json({
    format: 'coding-task-runner-v1', resourceId, workspace, processesExited,
    status: failure ? 'blocked' : 'passed', error: failure, completedAt: now()
  }));
  if (resourceId) {
    const ref = { path: artifact.path, sha256: hash(readFileSync(artifact.path)) };
    await updateResource(config.stateDirectory, resourceId, {
      processesExited, primaryError: failure, evidence: [ref], runnerEvidence: ref
    });
    if (!failure && existsSync(closeRequest)) {
      requireThat(lstatSync(closeRequest).isFile() && !lstatSync(closeRequest).isSymbolicLink() &&
        lstatSync(closeRequest).size < 1024 * 1024, 'Invalid task close request', 'blocked-task-close');
      const close = JSON.parse(readFileSync(closeRequest, 'utf8'));
      requireThat(close.resourceId === resourceId, 'Task close request names another resource', 'blocked-task-close');
      return { resourceId, workspace, resources: await closeCodingTask(config, close) };
    }
  }
  return { resourceId, workspace, status: failure ? 'blocked' : 'retained',
    error: failure, reason: failure ? 'Failed coding task retained for investigation' : 'Waiting for task-close handover' };
}
