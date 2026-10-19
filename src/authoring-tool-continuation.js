import { realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, json, now, requireThat, utc } from './common.js';
import { Ledger } from './ledger.js';
import { importReviewedContinuation } from './local-continuation.js';
import { qualifyRepositorySkill, skillQualificationId, verifyRepositorySkillWorkspace } from './repository-skills.js';
import { workerToolNames } from './worker-tool-contract.js';
import { command, makePlannedImprovementAssignment, requireCurrentAssignment } from './workers.js';

const kind = 'continued-from-authoring-tool-failure';
const operationId = id => `${id}:authoring-tool-continuation`;
const controllerRoot = fileURLToPath(new URL('..', import.meta.url));
const git = async (cwd, args) =>
  (await command('git', ['-c', 'core.longpaths=true', ...args], cwd)).stdout.trim();
const separate = (a, b) => {
  const part = relative(resolve(a), resolve(b));
  return part.startsWith('..') || isAbsolute(part);
};
const sameConfig = (before, after, authorization) => {
  const comparable = structuredClone(after);
  for (const key of ['workerMaxToolCalls', 'maxValidationRepairRounds']) {
    if (before.limits[key] === after.limits[key]) continue;
    const change = authorization?.executionBounds?.[key];
    requireThat(change?.before === before.limits[key] && change?.after === after.limits[key] &&
      Number.isInteger(change.after) && change.after >= (key === 'workerMaxToolCalls' ? 1 : 0) &&
      change.after <= (key === 'workerMaxToolCalls' ? 240 : 10),
    'Changed authoring/repair bounds require explicit bounded authorization', 'blocked-authorization');
    comparable.limits[key] = before.limits[key];
  }
  requireThat(json({ ...before, stateDirectory: null }) ===
    json({ ...comparable, stateDirectory: null }),
  'Tool continuation cannot change source, native gates, permissions or other budgets',
  'blocked-reconciliation');
};

async function predecessor(config, ledger, id, reserved = false) {
  const job = ledger.job(id), assignment = ledger.get('assignment', id);
  const results = ledger.all('workerResult').filter(result => result.assignmentId === id);
  const result = results[0], usage = result?.toolUsage, skill = result?.skillExecution;
  requireThat(job?.state === 'blocked' && !JSON.parse(job.error ?? 'null') &&
    assignment?.execution === 'local' && assignment.skillBindingId && assignment.testCoveragePlanId &&
    results.length === 1 && result.attemptId === job.session_id && result.outcome === 'blocked' &&
    result.sourceRevision === job.base_revision && result.draftPR === null &&
    result.validation.length === 0 && result.validationAttempts.length === 0 &&
    (result.remoteValidation ?? []).length === 0 &&
    skill?.status === 'blocked' && skill.classification === 'bounded-edit-capability-unavailable' &&
    skill.bindingId === assignment.skillBindingId && skill.skillRevision === job.base_revision &&
    skill.changedFiles.length === 0 && skill.testsAddedOrUpdated.length === 0 &&
    skill.behaviorCardsAddedOrUpdated.length === 0 && skill.unknowns.length === 0 &&
    usage?.used > 1 && usage.byTool.pilot_finish === 1 &&
    Object.entries(usage.byTool).every(([name, count]) =>
      ['pilot_list', 'pilot_search', 'pilot_read', 'pilot_finish'].includes(name) || count === 0) &&
    Object.values(usage.byTool).reduce((sum, count) => sum + count, 0) === usage.used &&
    usage.rounds.length === 1 && usage.rounds[0].round === 0 && usage.rounds[0].status === 'completed' &&
    usage.rounds[0].used === usage.used && usage.rounds[0].cumulativeUsed === usage.used,
  'Only the exact read-only missing-edit-tool result without changes, validation or publication may continue',
  'blocked-reconciliation');
  const operations = ledger.status().operations.filter(row => row.job_id === id);
  const reservation = operations.filter(row => row.id === operationId(id));
  requireThat(reserved
    ? reservation.length === 1 && reservation[0].state === 'prepared'
    : reservation.length === 0,
  'Tool continuation is absent or already reserved', 'blocked-reconciliation');
  const origins = operations.filter(row => row.id !== operationId(id));
  let owned = join(ledger.directory, 'workspaces', job.session_id);
  if (origins.length) {
    requireThat(origins.length === 1 && origins[0].kind === 'continued-from-runtime-launch-failure' &&
      origins[0].state === 'claimed', 'Other predecessor operations prohibit tool recovery',
    'blocked-reconciliation');
    const origin = JSON.parse(origins[0].detail);
    const previous = new Ledger(origin.priorStateDirectory, { readOnly: true });
    try {
      const priorJob = previous.job(id), priorResult = previous.get('workerResult', origin.priorResultId);
      const mirrored = previous.status().operations.find(row => row.id === origins[0].id);
      requireThat(origin.nextAttemptId === job.session_id && mirrored?.state === 'claimed' &&
        json(JSON.parse(mirrored.detail)) === json(origin) &&
        hash(json(priorJob)) === origin.priorJobSha256 &&
        hash(json(priorResult)) === origin.priorResultSha256 &&
        json(previous.get('assignment', id)) === json(assignment),
      'Consumed runtime lineage changed', 'blocked-reconciliation');
      owned = join(previous.directory, 'workspaces', priorJob.session_id);
    } finally { previous.close(); }
  }
  requireThat(realpathSync(job.workspace) === realpathSync(owned) &&
    await git(job.workspace, ['rev-parse', 'HEAD']) === job.base_revision &&
    !await git(job.workspace, ['status', '--porcelain']),
  'Tool recovery requires the unchanged owned qualified checkout', 'blocked-reconciliation');
  requireCurrentAssignment(config, ledger, ledger.get('investigation', assignment.investigationId), assignment);
  verifyRepositorySkillWorkspace(config, assignment, job.workspace, job.base_revision,
    ledger.qualification(skillQualificationId(assignment.repoId, assignment.skillBindingId)));
  return { job, assignment, result };
}

export async function prepareAuthoringToolContinuation(config, ledger, id, nextConfig, nextLedger, authorization) {
  requireThat(separate(ledger.directory, nextLedger.directory) &&
    separate(nextLedger.directory, ledger.directory) &&
    realpathSync(config.stateDirectory) === realpathSync(ledger.directory) &&
    realpathSync(nextConfig.stateDirectory) === realpathSync(nextLedger.directory),
  'Tool continuation requires a separate empty state directory', 'blocked-reconciliation');
  sameConfig(config, nextConfig, authorization);
  const owner = ledger.acquire(`dispatch:${id}`);
  let nextOwner;
  try {
    nextOwner = nextLedger.acquire(`dispatch:${id}`);
    const { job, assignment, result } = await predecessor(config, ledger, id);
    requireThat(authorization?.kind === 'bounded-authoring-tool' &&
      authorization.approved === true && authorization.authorizedBy === 'user' &&
      authorization.maxModelAttempts === 1 && authorization.previousAssignmentId === id &&
      authorization.previousAttemptId === job.session_id &&
      authorization.sourceRevision === job.base_revision &&
      authorization.nextConfigSha256 === hash(json(nextConfig)) &&
      authorization.controllerRevision === await git(controllerRoot, ['rev-parse', 'HEAD']) &&
      workerToolNames.includes('pilot_replace_lines'),
    'A fresh source/config/controller-bound tool-recovery authorization is required',
    'blocked-authorization');
    utc(authorization.authorizedAt);
    requireThat(Date.parse(authorization.authorizedAt) >= Date.parse(result.reportedAt) &&
      Date.parse(authorization.authorizedAt) <= Date.now() + 60000,
    'Tool recovery authorization must follow the blocked authoring attempt', 'blocked-authorization');
    const status = nextLedger.status();
    requireThat(status.counts.length === 0 && status.jobs.length === 0 &&
      status.operations.length === 0 && status.runs.length === 0,
    'Tool continuation destination must be empty', 'blocked-reconciliation');
    const qualification = await qualifyRepositorySkill(nextConfig, assignment.repoId,
      assignment.capability, assignment.skillBindingId);
    verifyRepositorySkillWorkspace(nextConfig, assignment, job.workspace, job.base_revision, qualification);
    const detail = {
      priorStateDirectory: ledger.directory, priorConfig: config,
      priorJobSha256: hash(json(job)), priorResultId: result.id, priorResultSha256: hash(json(result)),
      assignmentId: id, authorization, nextConfigSha256: hash(json(nextConfig)), preparedAt: now()
    };
    ledger.operation(operationId(id), id, 'authoring-tool-continuation', detail);
    let rebuilt;
    nextLedger.transaction(() => {
      importReviewedContinuation(config, ledger, nextLedger, assignment, qualification,
        'authoring-tool-continuation:captured-evidence-import');
      rebuilt = makePlannedImprovementAssignment(nextConfig, nextLedger,
        ledger.get('investigation', assignment.investigationId), assignment.testCoveragePlanId,
        assignment.requestedOutcome, assignment.testCoveragePlanVersion);
      requireThat(json({ ...rebuilt, bounds: assignment.bounds }) === json(assignment),
        'Tool continuation changed assignment semantics beyond authorized tool bounds',
        'blocked-reconciliation');
      const nextJob = nextLedger.prepare(rebuilt, { bucket: operationId(id), maxNew: 1 });
      detail.nextAttemptId = nextJob.session_id;
      nextLedger.operation(operationId(id), id, kind, detail);
      nextLedger.finishOperation(operationId(id), 'prepared', detail);
    });
    ledger.finishOperation(operationId(id), 'prepared', detail);
    return { assignment: rebuilt, job: nextLedger.job(id), audit: detail };
  } finally {
    if (nextOwner) nextLedger.release(`dispatch:${id}`, nextOwner);
    ledger.release(`dispatch:${id}`, owner);
  }
}

export async function claimAuthoringToolWorkspace(config, ledger, id) {
  const row = ledger.status().operations.find(operation => operation.id === operationId(id));
  requireThat(row?.kind === kind && row.state === 'prepared',
    'Tool continuation is absent or already consumed', 'blocked-reconciliation');
  const detail = JSON.parse(row.detail);
  sameConfig(detail.priorConfig, config, detail.authorization);
  requireThat(detail.nextAttemptId === ledger.job(id)?.session_id &&
    detail.nextConfigSha256 === hash(json(config)) &&
    detail.authorization.controllerRevision === await git(controllerRoot, ['rev-parse', 'HEAD']),
  'Tool continuation config, controller or attempt changed', 'blocked-reconciliation');
  const prior = new Ledger(detail.priorStateDirectory);
  let owner;
  try {
    owner = prior.acquire(`dispatch:${id}`);
    const previous = await predecessor(detail.priorConfig, prior, id, true);
    const origin = prior.status().operations.find(operation => operation.id === operationId(id));
    requireThat(json(JSON.parse(origin.detail)) === json(detail) &&
      hash(json(previous.job)) === detail.priorJobSha256 &&
      hash(json(previous.result)) === detail.priorResultSha256 &&
      json({ ...ledger.get('assignment', id), bounds: previous.assignment.bounds }) ===
        json(previous.assignment),
    'Tool predecessor or bilateral reservation changed', 'blocked-reconciliation');
    const claimed = { ...detail, claimedAt: now() };
    prior.finishOperation(operationId(id), 'claimed', claimed);
    ledger.finishOperation(operationId(id), 'claimed', claimed);
    return { workspace: previous.job.workspace, baseRevision: previous.job.base_revision };
  } finally {
    if (owner) prior.release(`dispatch:${id}`, owner);
    prior.close();
  }
}
