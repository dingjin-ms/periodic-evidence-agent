import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, json, now, requireThat, utc } from './common.js';
import { importReviewedContinuation } from './local-continuation.js';
import { verifyPreparationPreflight } from './native-preparation-continuation.js';
import { nativeSourceValidationRepository, verifyNativeSourceSnapshot } from './native-source-continuation.js';
import { verifyNativeEnvironmentAuthority } from './native-environment-revalidation.js';
import { qualifyRepositorySkill } from './repository-skills.js';
import { command, makePlannedImprovementAssignment, requireCurrentAssignment,
  verifyContinuationPredecessor } from './workers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = async args => (await command('git', args, root)).stdout.trim();
function pinned(ref) {
  requireThat(isAbsolute(ref?.path ?? '') && /^[a-f0-9]{64}$/.test(ref.sha256 ?? '') &&
    hash(readFileSync(ref.path)) === ref.sha256,
  'Business revalidation evidence changed', 'blocked-reconciliation');
  return JSON.parse(readFileSync(ref.path, 'utf8'));
}
function outside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}
export function verifyNativeBusinessFailure(job, result, operations, failure, summary, profileSha256) {
  const gate = result?.validation?.[0], output = failure?.output;
  requireThat(job?.state === 'blocked' && result?.outcome === 'blocked' &&
    result.assignmentId === job.id && result.attemptId === job.session_id &&
    /^[a-f0-9]{40}$/.test(result.sourceRevision ?? '') &&
    result.draftPR === null && result.remoteValidation?.length === 0 &&
    result.toolUsage?.used === 0 && result.toolUsage.rounds?.length === 0 &&
    Object.values(result.toolUsage.byTool).every(value => value === 0) &&
    result.skillExecution?.status === 'succeeded' &&
    result.skillExecution.needsHumanDecision === false &&
    result.validation.length === 1 && result.validationAttempts?.length === 1 &&
    result.validationAttempts[0].round === 0 &&
    json(result.validationAttempts[0].validation) === json(result.validation) &&
    gate.status === 'blocked' && gate.blockedReason === 'validation-profile-error' &&
    gate.sourceRevision === result.sourceRevision && gate.attemptCount === 1 &&
    gate.artifactRefs?.length === 1 &&
    failure.status === 'blocked' && failure.blockedReason === gate.blockedReason &&
    failure.revision === result.sourceRevision && failure.gateId === gate.gateId &&
    failure.attempt === 0 && failure.profileSha256 === profileSha256 &&
    output?.exitCode === 1 && output.timeout === false && !output.nativeReceipt &&
    operations.length === 4 && new Set(operations.map(row => row.kind)).size === 4 &&
    operations.every(row => ({
      validation: 'blocked', 'continued-from-validation-failure': 'prepared',
      'reuse-authored-revision': 'completed', 'declarative-registration-continuation': 'completed'
    })[row.kind] === row.state),
  'Revalidation requires one sealed, unpublished, zero-model native business failure',
  'blocked-reconciliation');
  requireThat(summary?.status === 'failed' && Array.isArray(summary.cases) &&
    summary.cases.length > 0 && summary.cases.length <= 5 &&
    summary.cases.some(item => ['failed', 'timedOut'].includes(item.status)) &&
    summary.cases.every((item, index) => item.repeatEachIndex === index &&
      item.retry === 0 && item.expectedStatus === 'passed' &&
      ['passed', 'failed', 'timedOut'].includes(item.status)),
  'Revalidation requires the original failed native batch, not diagnostic passes',
  'blocked-reconciliation');
}
function sourceContinuation(detail) {
  const original = detail.nativeBusinessRevalidation.originalContinuation;
  return detail.nativeBusinessRevalidation.environmentSuccessor === true
    ? original.nativeBusinessRevalidation.originalContinuation : original;
}
export function nativeBusinessValidationRepository(repo, detail) {
  const validationRepo = nativeSourceValidationRepository(repo, sourceContinuation(detail));
  if (detail.authorization?.kind !== 'native-environment-revalidation') return validationRepo;
  return { ...validationRepo, validationGates: validationRepo.validationGates.map(gate => ({
    ...gate, declarativeE2E: {
      ...gate.declarativeE2E, cdpEndpoint: detail.authorization.isolatedCdpEndpoint
    }
  })) };
}
export function nativeBusinessPredecessorOperations(operations, authorization) {
  const operationId = `${authorization.previousAssignmentId}:${authorization.kind}:${authorization.previousAttemptId}`;
  const reservation = operations.find(row => row.id === operationId);
  if (!reservation) {
    requireThat(!authorization.preparationReservationRecovery,
      'Preparation recovery requires its exact unfinished reservation', 'blocked-reconciliation');
    return operations;
  }
  requireThat(authorization.kind === 'native-environment-revalidation' &&
    authorization.preparationReservationRecovery &&
    reservation.kind === 'validation-continuation' && reservation.state === 'started',
  'Existing continuation requires explicit unfinished-preparation recovery', 'blocked-reconciliation');
  const recovery = pinned(authorization.preparationReservationRecovery);
  requireThat(json(reservation) === json(recovery.reservation),
    'Unfinished preparation reservation changed', 'blocked-reconciliation');
  return operations.filter(row => row.id !== operationId);
}
export function verifyNativeBusinessAuthority(config, detail) {
  if (detail.authorization?.kind === 'native-environment-revalidation')
    return verifyNativeEnvironmentAuthority(config, detail);
  const { authorization: auth, previousConfig: previous } = detail;
  const original = detail.nativeBusinessRevalidation?.originalContinuation;
  requireThat(original?.sourcePreparedContinuation && !original.nativeBusinessRevalidation &&
    !detail.nativeBusinessRevalidation.environmentSuccessor &&
    detail.nativeSourceCorrection === true && !detail.sourcePreparedContinuation &&
    !detail.sourcePreparationRecovery && !detail.nativePreparationCorrection &&
    auth.kind === 'native-business-revalidation' && auth.approved === true &&
    auth.authorizedBy === 'user' && auth.scope === 'one-complete-native-batch' &&
    auth.maxInitialModelAttempts === 0 && auth.maxNativeBatches === 1 &&
    auth.requiredRepeats === 5 &&
    auth.previousAssignmentId === detail.priorJob.id &&
    auth.previousAttemptId === detail.priorJob.session_id &&
    auth.sourceRevision === detail.priorResult.sourceRevision &&
    auth.repairedRevision === auth.sourceRevision &&
    auth.repairedRevision === original.authorization.repairedRevision &&
    auth.baseRevision === detail.priorJob.base_revision &&
    auth.unitFile === original.authorization.unitFile &&
    auth.nextConfigSha256 === hash(json(config)) &&
    detail.authorizationSha256 === hash(json(auth)) &&
    detail.priorResultSha256 === hash(json(detail.priorResult)) &&
    detail.priorOperationsSha256 === hash(json(detail.operations)) &&
    previous.stateDirectory === detail.priorStateDirectory &&
    original.nextStateDirectory === detail.priorStateDirectory &&
    original.nextAssignmentId === detail.priorJob.id &&
    original.nextAttemptId === detail.priorJob.session_id &&
    detail.priorJob.workspace === original.priorJob.workspace &&
    detail.priorJob.base_revision === original.priorJob.base_revision &&
    json({ ...detail.priorAssignment, skillQualification: null }) ===
      json({ ...original.priorAssignment, skillQualification: null }) &&
    json(detail.files) === json(original.files) && json(detail.proposal) === json(original.proposal) &&
    json(auth.ownerRequest) === json(original.authorization.ownerRequest) &&
    json(auth.ownerApproval) === json(original.authorization.ownerApproval) &&
    json(JSON.parse(detail.operations.find(row =>
      row.kind === 'continued-from-validation-failure')?.detail ?? 'null')) === json(original) &&
    json({ ...config, stateDirectory: null }) === json({ ...previous, stateDirectory: null }) &&
    config.limits.maxValidationInfrastructureRetries === 0 &&
    config.limits.maxValidationRepairRounds === 10,
  'Business revalidation must preserve the approved source, assignment and zero-retry gate',
  'blocked-authorization');
  utc(auth.authorizedAt); utc(auth.recordedAt);
  requireThat(Date.parse(auth.authorizedAt) >= Date.parse(detail.priorResult.reportedAt) &&
    Date.parse(auth.authorizedAt) <= Date.parse(auth.recordedAt) &&
    Date.parse(auth.recordedAt) <= Date.now() + 60000 &&
    typeof auth.reason === 'string' && auth.reason.trim(),
  'A fresh explicit user grant is required after the sealed business failure',
  'blocked-authorization');
  const repo = config.repositories.find(row => row.id === detail.priorAssignment.repoId);
  const native = detail.operations.find(row => row.kind === 'validation');
  requireThat(repo?.validationGates.length === 1 &&
    repo.validationGates[0].profile === '1js-declarative-e2e-v1' &&
    auth.failure.path === detail.priorResult.validation[0].artifactRefs[0] &&
    !outside(join(detail.priorStateDirectory, 'native-validation', hash(native.id)),
      auth.nativeSummary.path),
  'Revalidation requires the unchanged gate and its own failed native evidence',
  'blocked-reconciliation');
  const failure = pinned(auth.failure);
  verifyNativeBusinessFailure(detail.priorJob, detail.priorResult, detail.operations,
    failure, pinned(auth.nativeSummary), repo.validationGates[0].profileSha256);
  const proof = pinned(auth.preflight);
  verifyPreparationPreflight(proof, detail.priorJob, detail.priorResult,
    detail.priorAssignment, detail.operations, repo.validationGates[0].profileSha256);
  requireThat(json(proof.preparation.sparseCheckoutPaths) ===
    json(nativeBusinessValidationRepository(repo, detail).sparseCheckoutPaths) &&
    [detail.priorJob.workspace, ...(failure.output.residualPaths ?? [])].every(path =>
      outside(path, proof.workspace) && outside(proof.workspace, path)),
  'Business revalidation must use its newly attested validation workspace',
  'blocked-reconciliation');
}
export async function verifyPreparedNativeBusiness(config, detail, operationId, attemptId) {
  verifyNativeBusinessAuthority(config, detail);
  requireThat(await git(['rev-parse', 'HEAD']) === detail.authorization.controllerRevision &&
    !await git(['status', '--porcelain']),
  'Business revalidation controller must remain clean at its recorded revision',
  'blocked-reconciliation');
  verifyContinuationPredecessor(detail, operationId, attemptId);
  // Historical preparation is not reused; only its unchanged owner-reviewed source is.
  await verifyNativeSourceSnapshot(sourceContinuation(detail));
}
export async function prepareNativeBusinessRevalidation(config, ledger, id,
  nextConfig, nextLedger, authorization) {
  const priorRoot = realpathSync(ledger.directory), nextRoot = realpathSync(nextLedger.directory);
  requireThat(outside(priorRoot, nextRoot) && outside(nextRoot, priorRoot) &&
    realpathSync(config.stateDirectory) === priorRoot &&
    realpathSync(nextConfig.stateDirectory) === nextRoot &&
    await git(['rev-parse', 'HEAD']) === authorization.controllerRevision &&
    !await git(['status', '--porcelain']),
  'Business revalidation needs fresh separate storage and a clean recorded controller',
  'blocked-reconciliation');
  const owner = ledger.acquire('dispatch'); let nextOwner;
  try {
    nextOwner = nextLedger.acquire('dispatch');
    const state = nextLedger.status();
    requireThat(!state.jobs.length && !state.counts.length && !state.operations.length && !state.runs.length,
      'Business revalidation destination must be unused', 'blocked-reconciliation');
    const job = ledger.job(id), assignment = ledger.get('assignment', id);
    const results = ledger.all('workerResult').filter(row => row.assignmentId === id);
    requireThat(results.length === 1, 'Revalidation needs exactly one sealed predecessor',
      'blocked-reconciliation');
    const allOperations = ledger.status().operations.filter(row => row.job_id === id);
    const operations = nativeBusinessPredecessorOperations(allOperations, authorization);
    const original = JSON.parse(operations.find(row =>
      row.kind === 'continued-from-validation-failure')?.detail ?? 'null');
    const detail = {
      previousConfig: config, priorStateDirectory: priorRoot, nextStateDirectory: nextRoot,
      priorJob: job, priorAssignment: assignment, priorResult: results[0],
      priorResultSha256: hash(json(results[0])), operations,
      priorOperationsSha256: hash(json(operations)), authorization,
      authorizationSha256: hash(json(authorization)), nativeSourceCorrection: true,
      nativeBusinessRevalidation: { originalContinuation: original,
        ...(authorization.kind === 'native-environment-revalidation'
          ? { environmentSuccessor: true } : {}) },
      files: original?.files, proposal: original?.proposal, preparedAt: now()
    };
    if (authorization.preparationReservationRecovery)
      detail.recoveredPreparationReservation = pinned(authorization.preparationReservationRecovery).reservation;
    verifyNativeBusinessAuthority(nextConfig, detail);
    await verifyNativeSourceSnapshot(sourceContinuation(detail));
    requireCurrentAssignment(config, ledger, ledger.get('investigation', assignment.investigationId), assignment);
    const qualification = await qualifyRepositorySkill(nextConfig, assignment.repoId,
      assignment.capability, assignment.skillBindingId);
    requireThat(qualification.baseRevision === job.base_revision &&
      qualification.skillSha256 === assignment.skillQualification.skillSha256,
    'Revalidation changed the qualified skill or baseline', 'blocked-reconciliation');
    detail.qualification = qualification;
    const operationId = `${id}:${authorization.kind}:${job.session_id}`;
    let rebuilt;
    nextLedger.transaction(() => {
      importReviewedContinuation(config, ledger, nextLedger, assignment, qualification,
        `${authorization.kind}:preserved-evidence`);
      rebuilt = makePlannedImprovementAssignment(nextConfig, nextLedger,
        ledger.get('investigation', assignment.investigationId), assignment.testCoveragePlanId,
        assignment.requestedOutcome, assignment.testCoveragePlanVersion);
      requireThat(rebuilt.id === assignment.id &&
        json({ ...assignment, skillQualification: null }) ===
        json({ ...rebuilt, skillQualification: null }),
      'Revalidation changed assignment identity or semantics', 'blocked-reconciliation');
      if (detail.recoveredPreparationReservation)
        ledger.finishOperation(operationId, 'started', detail);
      else ledger.operation(operationId, id, 'validation-continuation', detail);
      const nextJob = nextLedger.prepare(rebuilt, { bucket: operationId, maxNew: 1 });
      Object.assign(detail, { nextAssignmentId: rebuilt.id, nextAttemptId: nextJob.session_id });
      nextLedger.operation(operationId, rebuilt.id, 'continued-from-validation-failure', detail);
      nextLedger.finishOperation(operationId, 'prepared', detail);
    });
    ledger.finishOperation(operationId, 'prepared', detail);
    return { assignment: rebuilt, job: nextLedger.job(rebuilt.id), audit: detail };
  } finally {
    if (nextOwner) nextLedger.release('dispatch', nextOwner);
    ledger.release('dispatch', owner);
  }
}
