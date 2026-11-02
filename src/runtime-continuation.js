import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, json, now, requireThat, utc } from './common.js';
import { Ledger } from './ledger.js';
import { importReviewedContinuation } from './local-continuation.js';
import { qualifyRepositorySkill, skillQualificationId, verifyRepositorySkillWorkspace } from './repository-skills.js';
import { command, makePlannedImprovementAssignment, requireCurrentAssignment } from './workers.js';

const kind = 'continued-from-runtime-launch-failure';
const operationId = id => `${id}:runtime-launch-continuation`;
const controllerRoot = fileURLToPath(new URL('..', import.meta.url));
const separate = (a, b) => {
  const part = relative(resolve(a), resolve(b));
  return part.startsWith('..') || isAbsolute(part);
};
const git = async (cwd, args) =>
  (await command('git', ['-c', 'core.longpaths=true', ...args], cwd)).stdout.trim();

function launcherProof(config, authorization, reportedAt) {
  const proof = authorization?.runtimeSmoke;
  requireThat(isAbsolute(config.runtime.cliPath) &&
    isAbsolute(proof?.path ?? '') && /^[a-f0-9]{64}$/.test(proof?.sha256 ?? '') &&
    /^[a-f0-9]{64}$/.test(authorization.cliSha256 ?? ''),
  'Runtime continuation requires an absolute, content-bound launcher and offline smoke',
  'blocked-authorization');
  const bytes = readFileSync(proof.path);
  requireThat(hash(bytes) === proof.sha256 &&
    hash(readFileSync(config.runtime.cliPath)) === authorization.cliSha256,
  'Runtime launcher or smoke evidence changed', 'blocked-reconciliation');
  const smoke = JSON.parse(bytes);
  requireThat(smoke.cliPath === config.runtime.cliPath &&
    smoke.cliSha256 === authorization.cliSha256 && smoke.customTool === 'executed' &&
    smoke.unavailableShell === 'rejected' && smoke.modelInvoked === false &&
    smoke.workplaceRead === false && Number.isFinite(Date.parse(smoke.checkedAt)) &&
    Date.parse(smoke.checkedAt) >= Date.parse(reportedAt) &&
    Date.parse(smoke.checkedAt) <= Date.now() + 60000,
  'Runtime continuation requires a successful post-failure offline permission smoke',
  'blocked-reconciliation');
}

async function predecessor(config, ledger, id, continuationExists = false) {
  const job = ledger.job(id), assignment = ledger.get('assignment', id);
  const results = ledger.all('workerResult').filter(result => result.assignmentId === id);
  const result = results[0], failure = JSON.parse(job?.error ?? 'null');
  requireThat(job?.state === 'blocked' && job.workspace && assignment?.execution === 'local' &&
    assignment.skillBindingId && assignment.testCoveragePlanId && results.length === 1 &&
    failure?.code === 'blocked-runtime' &&
    failure.message === 'Copilot executable not found on PATH' &&
    result.attemptId === job.session_id && result.outcome === 'blocked' &&
    result.sourceRevision === job.base_revision &&
    result.sourceRevision === assignment.skillQualification.baseRevision &&
    result.draftPR === null && result.skillExecution === null &&
    result.validation.length === 0 && result.validationAttempts.length === 0 &&
    (result.remoteValidation ?? []).length === 0 &&
    result.toolUsage?.used === 0 &&
    Object.values(result.toolUsage.byTool).every(count => count === 0) &&
    result.toolUsage.rounds.length === 1 && result.toolUsage.rounds[0].round === 0 &&
    result.toolUsage.rounds[0].status === 'failed' &&
    result.toolUsage.rounds[0].used === 0 && result.toolUsage.rounds[0].cumulativeUsed === 0,
  'Only the exact pre-authoring CLI-path rejection with zero tools, validation and publication may continue',
  'blocked-reconciliation');
  const operations = ledger.status().operations.filter(operation => operation.job_id === id);
  requireThat(continuationExists
    ? operations.length === 1 && operations[0].id === operationId(id) &&
      operations[0].kind === 'runtime-launch-continuation' && operations[0].state === 'prepared'
    : operations.length === 0,
  'Prior operations or an existing runtime continuation prohibit another attempt',
  'blocked-reconciliation');
  requireThat(realpathSync(job.workspace) ===
    realpathSync(join(ledger.directory, 'workspaces', job.session_id)) &&
    await git(job.workspace, ['rev-parse', 'HEAD']) === job.base_revision &&
    !await git(job.workspace, ['status', '--porcelain']),
  'Runtime continuation requires the unchanged owned checkout at its qualified base',
  'blocked-reconciliation');
  requireCurrentAssignment(config, ledger, ledger.get('investigation', assignment.investigationId), assignment);
  const qualification = ledger.qualification(skillQualificationId(assignment.repoId, assignment.skillBindingId));
  verifyRepositorySkillWorkspace(config, assignment, job.workspace, job.base_revision, qualification);
  return { job, assignment, result };
}

export async function prepareRuntimeContinuation(config, ledger, id, nextConfig, nextLedger, authorization) {
  requireThat(separate(ledger.directory, nextLedger.directory) &&
    separate(nextLedger.directory, ledger.directory) &&
    realpathSync(config.stateDirectory) === realpathSync(ledger.directory) &&
    realpathSync(nextConfig.stateDirectory) === realpathSync(nextLedger.directory) &&
    json({ ...config, stateDirectory: null }) === json({ ...nextConfig, stateDirectory: null }),
  'Runtime continuation changes only to a separate fresh state directory',
  'blocked-reconciliation');
  const owner = ledger.acquire(`dispatch:${id}`);
  let nextOwner;
  try {
    nextOwner = nextLedger.acquire(`dispatch:${id}`);
    const { job, assignment, result } = await predecessor(config, ledger, id);
    requireThat(authorization?.kind === 'runtime-launch-path' &&
      authorization.approved === true && authorization.authorizedBy === 'user' &&
      authorization.maxModelAttempts === 1 && authorization.previousAssignmentId === id &&
      authorization.previousAttemptId === job.session_id &&
      authorization.sourceRevision === job.base_revision &&
      authorization.nextConfigSha256 === hash(json(nextConfig)) &&
      typeof authorization.reason === 'string' && authorization.reason.trim() &&
      authorization.controllerRevision === await git(controllerRoot, ['rev-parse', 'HEAD']),
    'A fresh source/config/controller-bound one-attempt user authorization is required',
    'blocked-authorization');
    utc(authorization.authorizedAt);
    requireThat(Date.parse(authorization.authorizedAt) >= Date.parse(result.reportedAt) &&
      Date.parse(authorization.authorizedAt) <= Date.now() + 60000,
    'Runtime continuation authorization must follow the failed attempt', 'blocked-authorization');
    launcherProof(nextConfig, authorization, result.reportedAt);
    const status = nextLedger.status();
    requireThat(status.counts.length === 0 && status.jobs.length === 0 &&
      status.operations.length === 0 && status.runs.length === 0,
    'Runtime continuation destination must be empty', 'blocked-reconciliation');
    const qualification = await qualifyRepositorySkill(nextConfig, assignment.repoId,
      assignment.capability, assignment.skillBindingId);
    verifyRepositorySkillWorkspace(nextConfig, assignment, job.workspace, job.base_revision, qualification);
    const detail = {
      priorStateDirectory: ledger.directory, priorConfig: config,
      priorJobSha256: hash(json(job)), priorResultId: result.id, priorResultSha256: hash(json(result)),
      assignmentId: id, authorization, nextConfigSha256: hash(json(nextConfig)), preparedAt: now()
    };
    // Reserve the predecessor first: an interrupted import cannot authorize a second attempt.
    ledger.operation(operationId(id), id, 'runtime-launch-continuation', detail);
    nextLedger.transaction(() => {
      importReviewedContinuation(config, ledger, nextLedger, assignment, qualification,
        'runtime-launch-continuation:captured-evidence-import');
      const rebuilt = makePlannedImprovementAssignment(nextConfig, nextLedger,
        ledger.get('investigation', assignment.investigationId), assignment.testCoveragePlanId,
        assignment.requestedOutcome, assignment.testCoveragePlanVersion);
      requireThat(json(rebuilt) === json(assignment),
        'Runtime continuation changed assignment semantics', 'blocked-reconciliation');
      const nextJob = nextLedger.prepare(rebuilt, { bucket: operationId(id), maxNew: 1 });
      detail.nextAttemptId = nextJob.session_id;
      nextLedger.operation(operationId(id), id, kind, detail);
      nextLedger.finishOperation(operationId(id), 'prepared', detail);
    });
    ledger.finishOperation(operationId(id), 'prepared', detail);
    return { assignment, job: nextLedger.job(id), audit: detail };
  } finally {
    if (nextOwner) nextLedger.release(`dispatch:${id}`, nextOwner);
    ledger.release(`dispatch:${id}`, owner);
  }
}

export async function claimRuntimeWorkspace(config, ledger, id) {
  const row = ledger.status().operations.find(operation => operation.id === operationId(id));
  requireThat(row?.kind === kind && row.state === 'prepared',
    'Runtime continuation is absent or already consumed', 'blocked-reconciliation');
  const detail = JSON.parse(row.detail);
  requireThat(detail.assignmentId === id && detail.nextAttemptId === ledger.job(id)?.session_id &&
    detail.nextConfigSha256 === hash(json(config)) &&
    detail.authorization.controllerRevision === await git(controllerRoot, ['rev-parse', 'HEAD']),
  'Runtime continuation config, controller or attempt changed', 'blocked-reconciliation');
  const prior = new Ledger(detail.priorStateDirectory);
  let owner;
  try {
    owner = prior.acquire(`dispatch:${id}`);
    const previous = await predecessor(detail.priorConfig, prior, id, true);
    const origin = prior.status().operations.find(operation => operation.id === operationId(id));
    requireThat(json(JSON.parse(origin.detail)) === json(detail) &&
      hash(json(previous.job)) === detail.priorJobSha256 &&
      previous.result.id === detail.priorResultId &&
      hash(json(previous.result)) === detail.priorResultSha256 &&
      json(previous.assignment) === json(ledger.get('assignment', id)),
    'Runtime predecessor or its once-only reservation changed', 'blocked-reconciliation');
    launcherProof(config, detail.authorization, previous.result.reportedAt);
    const claimed = { ...detail, claimedAt: now() };
    prior.finishOperation(operationId(id), 'claimed', claimed);
    ledger.finishOperation(operationId(id), 'claimed', claimed);
    return { workspace: previous.job.workspace, baseRevision: previous.job.base_revision };
  } finally {
    if (owner) prior.release(`dispatch:${id}`, owner);
    prior.close();
  }
}
