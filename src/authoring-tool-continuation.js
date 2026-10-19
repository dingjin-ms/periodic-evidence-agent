import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, json, now, requireThat, utc } from './common.js';
import { Ledger } from './ledger.js';
import { importReviewedContinuation } from './local-continuation.js';
import { qualifyRepositorySkill, skillQualificationId, verifyRepositorySkillWorkspace } from './repository-skills.js';
import { workerToolNames } from './worker-tool-contract.js';
import { command, makePlannedImprovementAssignment, requireCurrentAssignment } from './workers.js';

const kind = 'continued-from-authoring-tool-failure';
const operationId = (id, attempt) => `${id}:authoring-tool-continuation:${attempt}`;
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

export async function verifyExistingCapability(authorization, workspace, revision) {
  const reference = authorization?.capabilityResolution;
  requireThat(isAbsolute(reference?.path ?? '') && /^[a-f0-9]{64}$/.test(reference?.sha256 ?? ''),
    'A source-bound existing-capability review is required', 'blocked-reconciliation');
  const bytes = readFileSync(reference.path);
  requireThat(hash(bytes) === reference.sha256, 'Capability review changed', 'blocked-reconciliation');
  const report = JSON.parse(bytes);
  requireThat(report.format === 'existing-declarative-capability-v1' &&
    report.sourceRevision === revision && report.primitive === 'assert' &&
    report.property === 'visible' && report.nativeLoaderVerified === true &&
    Array.isArray(report.sourceFiles) && report.sourceFiles.length >= 3 &&
    typeof report.explanation === 'string' && report.explanation.trim(),
  'Capability review must prove an existing mid-flow assertion, not authorize a harness change',
  'blocked-reconciliation');
  for (const source of report.sourceFiles) {
    requireThat(typeof source.path === 'string' &&
      source.path.startsWith('ooui/') && !source.path.split('/').includes('..') &&
      /^[a-f0-9]{64}$/.test(source.sha256 ?? '') &&
      hash(await git(workspace, ['show', `${revision}:${source.path}`])) === source.sha256,
    'Reviewed capability differs from the qualified source', 'blocked-reconciliation');
  }
  return report;
}

async function predecessor(config, ledger, id, reservation = null, authorization = null, depth = 0) {
  requireThat(depth <= 3, 'Read-only recovery lineage exceeds its bounded depth', 'blocked-reconciliation');
  const job = ledger.job(id), assignment = ledger.get('assignment', id);
  const results = ledger.all('workerResult').filter(result => result.assignmentId === id);
  const result = results[0], usage = result?.toolUsage, skill = result?.skillExecution;
  requireThat(job?.state === 'blocked' && !JSON.parse(job.error ?? 'null') &&
    assignment?.execution === 'local' && assignment.skillBindingId && assignment.testCoveragePlanId &&
    results.length === 1 && result.attemptId === job.session_id && result.outcome === 'blocked' &&
    result.sourceRevision === job.base_revision && result.draftPR === null &&
    result.validation.length === 0 && result.validationAttempts.length === 0 &&
    (result.remoteValidation ?? []).length === 0 &&
    skill?.status === 'blocked' &&
    ['bounded-edit-capability-unavailable', 'missing-mid-flow-protected-assertion-capability']
      .includes(skill.classification) &&
    skill.bindingId === assignment.skillBindingId && skill.skillRevision === job.base_revision &&
    skill.changedFiles.length === 0 && skill.testsAddedOrUpdated.length === 0 &&
    skill.behaviorCardsAddedOrUpdated.length === 0 &&
    (skill.classification !== 'bounded-edit-capability-unavailable' || skill.unknowns.length === 0) &&
    usage?.used > 1 && usage.limit === assignment.bounds.maxToolCalls &&
    usage.remaining === usage.limit - usage.used && usage.byTool.pilot_finish === 1 &&
    Object.entries(usage.byTool).every(([name, count]) =>
      ['pilot_list', 'pilot_search', 'pilot_read', 'pilot_finish'].includes(name) || count === 0) &&
    Object.values(usage.byTool).reduce((sum, count) => sum + count, 0) === usage.used &&
    usage.rounds.length === 1 && usage.rounds[0].round === 0 && usage.rounds[0].status === 'completed' &&
    usage.rounds[0].used === usage.used && usage.rounds[0].cumulativeUsed === usage.used,
  'Only an admitted read-only capability failure without changes, validation or publication may continue',
  'blocked-reconciliation');
  const operations = ledger.status().operations.filter(row => row.job_id === id);
  const reservationId = reservation?.id ?? operationId(id, job.session_id);
  const reservations = operations.filter(row => row.id === reservationId);
  requireThat(reservation
    ? reservations.length === 1 && reservations[0].state === reservation.state
    : reservations.length === 0,
  'Tool continuation is absent or already reserved', 'blocked-reconciliation');
  const origins = operations.filter(row => row.id !== reservationId);
  let owned = join(ledger.directory, 'workspaces', job.session_id);
  let originAuthorization = null;
  if (origins.length) {
    requireThat(origins.length === 1 &&
      ['continued-from-runtime-launch-failure', kind].includes(origins[0].kind) &&
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
        json({ ...assignment, bounds: previous.get('assignment', id)?.bounds }) ===
          json(previous.get('assignment', id)),
      'Consumed runtime lineage changed', 'blocked-reconciliation');
      if (origins[0].kind === kind) {
        sameConfig(origin.priorConfig, config, origin.authorization);
        requireThat(origin.nextConfigSha256 === hash(json(config)),
          'Consumed authoring configuration changed', 'blocked-reconciliation');
        const parent = await predecessor(origin.priorConfig, previous, id,
          { id: origins[0].id, state: 'claimed' }, origin.authorization, depth + 1);
        owned = parent.job.workspace;
        originAuthorization = origin.authorization;
      } else owned = join(previous.directory, 'workspaces', priorJob.session_id);
    } finally { previous.close(); }
  }
  requireThat(realpathSync(job.workspace) === realpathSync(owned) &&
    await git(job.workspace, ['rev-parse', 'HEAD']) === job.base_revision &&
    !await git(job.workspace, ['status', '--porcelain']),
  'Tool recovery requires the unchanged owned qualified checkout', 'blocked-reconciliation');
  requireCurrentAssignment(config, ledger, ledger.get('investigation', assignment.investigationId), assignment);
  verifyRepositorySkillWorkspace(config, assignment, job.workspace, job.base_revision,
    ledger.qualification(skillQualificationId(assignment.repoId, assignment.skillBindingId)));
  if (skill.classification === 'missing-mid-flow-protected-assertion-capability')
    await verifyExistingCapability(authorization, job.workspace, job.base_revision);
  return { job, assignment, result, originAuthorization };
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
    const { job, assignment, result, originAuthorization } =
      await predecessor(config, ledger, id, null, authorization);
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
    const continuingGrant = authorization.scope === 'until-native-validation' && originAuthorization &&
      authorization.priorAuthorizationSha256 === hash(json(originAuthorization)) &&
      authorization.authorizedAt === originAuthorization.authorizedAt;
    requireThat((Date.parse(authorization.authorizedAt) >= Date.parse(result.reportedAt) || continuingGrant) &&
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
    const reservationId = operationId(id, job.session_id);
    ledger.operation(reservationId, id, 'authoring-tool-continuation', detail);
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
      const nextJob = nextLedger.prepare(rebuilt, { bucket: reservationId, maxNew: 1 });
      detail.nextAttemptId = nextJob.session_id;
      nextLedger.operation(reservationId, id, kind, detail);
      nextLedger.finishOperation(reservationId, 'prepared', detail);
    });
    ledger.finishOperation(reservationId, 'prepared', detail);
    return { assignment: rebuilt, job: nextLedger.job(id), audit: detail };
  } finally {
    if (nextOwner) nextLedger.release(`dispatch:${id}`, nextOwner);
    ledger.release(`dispatch:${id}`, owner);
  }
}

export async function claimAuthoringToolWorkspace(config, ledger, id) {
  const row = ledger.status().operations.find(operation => operation.job_id === id && operation.kind === kind);
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
    const previous = await predecessor(detail.priorConfig, prior, id,
      { id: row.id, state: 'prepared' }, detail.authorization);
    const origin = prior.status().operations.find(operation => operation.id === row.id);
    requireThat(json(JSON.parse(origin.detail)) === json(detail) &&
      hash(json(previous.job)) === detail.priorJobSha256 &&
      hash(json(previous.result)) === detail.priorResultSha256 &&
      json({ ...ledger.get('assignment', id), bounds: previous.assignment.bounds }) ===
        json(previous.assignment),
    'Tool predecessor or bilateral reservation changed', 'blocked-reconciliation');
    const claimed = { ...detail, claimedAt: now() };
    prior.finishOperation(row.id, 'claimed', claimed);
    ledger.finishOperation(row.id, 'claimed', claimed);
    return { workspace: previous.job.workspace, baseRevision: previous.job.base_revision };
  } finally {
    if (owner) prior.release(`dispatch:${id}`, owner);
    prior.close();
  }
}
