import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, json, now, requireThat, utc } from './common.js';
import { Ledger } from './ledger.js';
import { importReviewedContinuation } from './local-continuation.js';
import { qualifyRepositorySkill, skillQualificationId, verifyRepositorySkillWorkspace } from './repository-skills.js';
import { workerToolNames } from './worker-tool-contract.js';
import { skillChangePopulation, verifyDeclarativeRegistration } from './declarative-e2e.js';
import { verifyOwnerReviewRecovery } from './owner-review.js';
import { command, makePlannedImprovementAssignment, requireAllowedSkillChanges,
  requireCurrentAssignment } from './workers.js';

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

export async function verifyRegistrationRecovery(authorization, assignment, job, result,
  verifyWorkspace = true) {
  const reference = authorization?.registrationRecovery;
  requireThat(isAbsolute(reference?.path ?? '') && /^[a-f0-9]{64}$/.test(reference?.sha256 ?? ''),
    'An immutable registration recovery review is required', 'blocked-reconciliation');
  const bytes = readFileSync(reference.path);
  requireThat(hash(bytes) === reference.sha256, 'Registration recovery review changed', 'blocked-reconciliation');
  const review = JSON.parse(bytes);
  requireThat(review.format === 'uncommitted-registration-recovery-v1' &&
    review.assignmentId === assignment.id && review.attemptId === job.session_id &&
    review.workerResultSha256 === hash(json(result)) && review.sourceRevision === job.base_revision &&
    review.dependencySetup === 'passed' && review.nativeLoader === 'passed' &&
    review.productInvocations === 0 && review.unknownsResolved === true &&
    typeof review.explanation === 'string' && review.explanation.trim() &&
    json(Object.keys(review.fileSha256 ?? {}).sort()) === json([...result.skillExecution.changedFiles].sort()),
  'Registration recovery must bind the retained proposal and repaired native prerequisites',
  'blocked-reconciliation');
  if (!verifyWorkspace) return review;
  const changed = [...new Set([
    ...(await git(job.workspace, ['diff', '--name-only', 'HEAD'])).split('\n'),
    ...(await git(job.workspace, ['ls-files', '--others', '--exclude-standard'])).split('\n')
  ].filter(Boolean))].sort();
  requireAllowedSkillChanges(changed, assignment.allowedWritePrefixes,
    result.skillExecution.changedFiles, assignment.allowedWriteFiles);
  for (const file of changed)
    requireThat(hash(readFileSync(join(job.workspace, file))) === review.fileSha256[file],
      'Uncommitted proposal changed after recovery review', 'blocked-reconciliation');
  return review;
}

async function predecessor(config, ledger, id, reservation = null, authorization = null,
  depth = 0, descendantHasReviewedChanges = false) {
  requireThat(depth <= 3, 'Read-only recovery lineage exceeds its bounded depth', 'blocked-reconciliation');
  const job = ledger.job(id), assignment = ledger.get('assignment', id);
  const results = ledger.all('workerResult').filter(result => result.assignmentId === id);
  const result = results[0], usage = result?.toolUsage, skill = result?.skillExecution;
  const registrationRecovery = Boolean(authorization?.registrationRecovery);
  const ownerRecovery = Boolean(authorization?.ownerReviewRecovery);
  requireThat(!(registrationRecovery && ownerRecovery),
    'Recovery modes must not be combined', 'blocked-reconciliation');
  const admittedSkill = registrationRecovery || ownerRecovery
    ? skill?.status === 'succeeded' && skill.classification === 'regression-coverage' &&
      skill.changedFiles.length > 0 && skill.testsAddedOrUpdated.length > 0 &&
      skill.unknowns.length === 0 && skill.needsHumanDecision === false
    : skill?.status === 'blocked' &&
      ['bounded-edit-capability-unavailable', 'missing-mid-flow-protected-assertion-capability']
        .includes(skill.classification) &&
      skill.changedFiles.length === 0 && skill.testsAddedOrUpdated.length === 0 &&
      (skill.classification !== 'bounded-edit-capability-unavailable' || skill.unknowns.length === 0);
  requireThat(job?.state === 'blocked' &&
    (ownerRecovery
      ? JSON.parse(job.error ?? 'null')?.code === 'blocked-owner' &&
        JSON.parse(job.error).message === 'Owner review did not arrive before commit'
      : registrationRecovery
      ? ['failed', 'blocked-auth'].includes(JSON.parse(job.error ?? 'null')?.code)
      : !JSON.parse(job.error ?? 'null')) &&
    assignment?.execution === 'local' && assignment.skillBindingId && assignment.testCoveragePlanId &&
    results.length === 1 && result.attemptId === job.session_id && result.outcome === 'blocked' &&
    result.sourceRevision === job.base_revision && result.draftPR === null &&
    result.validation.length === 0 && result.validationAttempts.length === 0 &&
    (result.remoteValidation ?? []).length === 0 &&
    admittedSkill &&
    skill.bindingId === assignment.skillBindingId && skill.skillRevision === job.base_revision &&
    skill.behaviorCardsAddedOrUpdated.length === 0 &&
    usage?.used > 1 && usage.limit === assignment.bounds.maxToolCalls &&
    usage.remaining === usage.limit - usage.used && usage.byTool.pilot_finish === 1 &&
    Object.entries(usage.byTool).every(([name, count]) =>
      ['pilot_list', 'pilot_search', 'pilot_read', 'pilot_finish',
        ...(registrationRecovery || ownerRecovery ? ['pilot_write', 'pilot_replace_lines'] : [])].includes(name) || count === 0) &&
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
  const finalization = operations.filter(row => row.kind === 'declarative-registration');
  if (registrationRecovery) {
    requireThat(finalization.length === 1 && finalization[0].state === 'blocked' &&
      finalization[0].id === `${id}:declarative-registration:0` &&
      JSON.parse(finalization[0].detail).revision === job.base_revision &&
      JSON.parse(finalization[0].detail).round === 0,
    'Only the first failed pre-commit registration may resume authoring', 'blocked-reconciliation');
    await verifyRegistrationRecovery(authorization, assignment, job, result, !descendantHasReviewedChanges);
  }
  const reviews = operations.filter(row => row.kind === 'owner-review');
  if (ownerRecovery) {
    requireThat(finalization.length === 1 && finalization[0].state === 'completed' &&
      finalization[0].id === `${id}:declarative-registration:0` &&
      reviews.length === 1 && reviews[0].state === 'blocked' &&
      reviews[0].id === `${id}:owner-review:0` &&
      JSON.parse(reviews[0].detail).code === 'blocked-owner' &&
      assignment.capability === 'declarative-e2e-authoring',
    'Only the first completed registration with an uncommitted owner-review timeout may continue',
    'blocked-reconciliation');
    verifyOwnerReviewRecovery(authorization, assignment, job, result);
    verifyDeclarativeRegistration(config, config.repositories.find(repo => repo.id === assignment.repoId),
      assignment, job.workspace, skill);
    requireAllowedSkillChanges(skill.changedFiles, assignment.allowedWritePrefixes,
      skill.changedFiles, assignment.allowedWriteFiles);
    const changed = [...new Set([
      ...(await git(job.workspace, ['diff', '--name-only', 'HEAD'])).split('\n'),
      ...(await git(job.workspace, ['ls-files', '--others', '--exclude-standard'])).split('\n')
    ].filter(Boolean))].sort();
    requireThat(json(changed) === json(skillChangePopulation(skill)),
      'Owner recovery requires the exact retained skill and registration diff',
      'blocked-reconciliation');
  }
  const origins = operations.filter(row => row.id !== reservationId &&
    !((registrationRecovery || ownerRecovery) && row === finalization[0]) &&
    !(ownerRecovery && row === reviews[0]));
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
          { id: origins[0].id, state: 'claimed' }, origin.authorization, depth + 1,
          descendantHasReviewedChanges || registrationRecovery || ownerRecovery);
        owned = parent.job.workspace;
        originAuthorization = origin.authorization;
      } else owned = join(previous.directory, 'workspaces', priorJob.session_id);
    } finally { previous.close(); }
  }
  requireThat(realpathSync(job.workspace) === realpathSync(owned) &&
    await git(job.workspace, ['rev-parse', 'HEAD']) === job.base_revision &&
    (registrationRecovery || ownerRecovery || descendantHasReviewedChanges ||
      !await git(job.workspace, ['status', '--porcelain'])),
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
