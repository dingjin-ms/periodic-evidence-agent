import { readFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, json, requireThat, utc } from './common.js';
import { Ledger } from './ledger.js';
import { verifyPreparationPreflight } from './native-preparation-continuation.js';
import { nativeBusinessValidationRepository, verifyNativeBusinessAuthority,
  verifyNativeBusinessFailure } from './native-business-revalidation.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const controllerFiles = ['src/cli.js', 'src/native-business-revalidation.js',
  'src/native-environment-revalidation.js'];
function pinned(ref) {
  requireThat(isAbsolute(ref?.path ?? '') && /^[a-f0-9]{64}$/.test(ref.sha256 ?? '') &&
    hash(readFileSync(ref.path)) === ref.sha256,
  'Environment successor evidence changed', 'blocked-reconciliation');
  return JSON.parse(readFileSync(ref.path, 'utf8'));
}
function outside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}
function endpoint(config, repoId) {
  return config.repositories.find(repo => repo.id === repoId)
    ?.validationGates?.[0]?.declarativeE2E?.cdpEndpoint;
}
function verifyPreparationRecovery(detail) {
  const { authorization: auth } = detail;
  if (!auth.preparationReservationRecovery) {
    requireThat(!detail.recoveredPreparationReservation,
      'Unfinished preparation cannot be recovered without pinned evidence', 'blocked-reconciliation');
    return;
  }
  const recovery = pinned(auth.preparationReservationRecovery), reservation = recovery.reservation;
  const previous = JSON.parse(reservation?.detail ?? 'null');
  const instruction = pinned(recovery.userLoopInstruction);
  requireThat(recovery.format === 'native-environment-preparation-recovery-v1' &&
    typeof recovery.reason === 'string' && recovery.reason.trim() &&
    reservation && previous &&
    reservation.id === `${detail.priorJob.id}:native-environment-revalidation:${detail.priorJob.session_id}` &&
    reservation.kind === 'validation-continuation' && reservation.state === 'started' &&
    json(reservation) === json(detail.recoveredPreparationReservation) &&
    !previous.nextAttemptId && !previous.nextAssignmentId && !previous.recoveredPreparationReservation &&
    previous.authorization?.kind === 'native-environment-revalidation' &&
    previous.authorization.sourceRevision === auth.sourceRevision &&
    json(previous.priorJob) === json(detail.priorJob) &&
    previous.priorResultSha256 === detail.priorResultSha256 &&
    json(previous.operations) === json(detail.operations) &&
    json(previous.files) === json(detail.files) && json(previous.proposal) === json(detail.proposal) &&
    isAbsolute(recovery.abandonedStateDirectory ?? '') &&
    isAbsolute(detail.nextStateDirectory ?? '') &&
    previous.nextStateDirectory === recovery.abandonedStateDirectory &&
    outside(previous.nextStateDirectory, detail.nextStateDirectory) &&
    outside(detail.nextStateDirectory, previous.nextStateDirectory) &&
    instruction.format === 'full-live-loop-user-instruction-v1' &&
    instruction.assignmentId === detail.priorJob.id &&
    instruction.approvedSourceRevision === auth.sourceRevision &&
    typeof instruction.userText === 'string' && instruction.userText.trim() &&
    typeof instruction.followUpUserText === 'string' && instruction.followUpUserText.trim() &&
    Date.parse(instruction.requestedAt) >= Date.parse(detail.priorResult.reportedAt) &&
    Date.parse(instruction.requestedAt) <= Date.parse(auth.recordedAt),
  'Preparation recovery requires its unchanged never-dispatched reservation and actual user loop instruction',
  'blocked-reconciliation');
  const abandoned = new Ledger(recovery.abandonedStateDirectory, { readOnly: true });
  try {
    const state = abandoned.status();
    requireThat(!state.jobs.length && !state.operations.length && !state.runs.length && !state.counts.length,
      'Abandoned preparation must have rolled back completely without a dispatch',
      'blocked-reconciliation');
  } finally { abandoned.close(); }
}
export function verifyNativeEnvironmentAuthority(config, detail) {
  const { authorization: auth, previousConfig: previous } = detail;
  const parent = detail.nativeBusinessRevalidation?.originalContinuation;
  requireThat(detail.nativeBusinessRevalidation?.environmentSuccessor === true &&
    parent?.authorization?.kind === 'native-business-revalidation' &&
    !parent.nativeBusinessRevalidation?.environmentSuccessor &&
    !parent.nativeBusinessRevalidation?.originalContinuation?.nativeBusinessRevalidation &&
    auth.kind === 'native-environment-revalidation' &&
    auth.approved === true && auth.authorizedBy === 'user' &&
    auth.scope === 'one-complete-native-batch' && auth.maxInitialModelAttempts === 0 &&
    auth.maxNativeBatches === 1 && auth.maxEnvironmentSuccessors === 1 &&
    auth.requiredRepeats === 5 && detail.nativeSourceCorrection === true &&
    !detail.sourcePreparedContinuation && !detail.sourcePreparationRecovery &&
    !detail.nativePreparationCorrection &&
    auth.previousAssignmentId === detail.priorJob.id &&
    auth.previousAttemptId === detail.priorJob.session_id &&
    auth.sourceRevision === detail.priorResult.sourceRevision &&
    auth.repairedRevision === auth.sourceRevision &&
    auth.repairedRevision === parent.authorization.repairedRevision &&
    auth.baseRevision === detail.priorJob.base_revision &&
    auth.unitFile === parent.authorization.unitFile &&
    auth.priorAuthorizationSha256 === parent.authorizationSha256 &&
    auth.nextConfigSha256 === hash(json(config)) &&
    detail.authorizationSha256 === hash(json(auth)) &&
    detail.priorResultSha256 === hash(json(detail.priorResult)) &&
    detail.priorOperationsSha256 === hash(json(detail.operations)) &&
    previous.stateDirectory === detail.priorStateDirectory &&
    parent.nextStateDirectory === detail.priorStateDirectory &&
    parent.nextAssignmentId === detail.priorJob.id &&
    parent.nextAttemptId === detail.priorJob.session_id &&
    detail.priorJob.workspace === parent.priorJob.workspace &&
    detail.priorJob.base_revision === parent.priorJob.base_revision &&
    json({ ...detail.priorAssignment, skillQualification: null }) ===
      json({ ...parent.priorAssignment, skillQualification: null }) &&
    json(detail.files) === json(parent.files) && json(detail.proposal) === json(parent.proposal) &&
    json(auth.ownerRequest) === json(parent.authorization.ownerRequest) &&
    json(auth.ownerApproval) === json(parent.authorization.ownerApproval) &&
    json(JSON.parse(detail.operations.find(row =>
      row.kind === 'continued-from-validation-failure')?.detail ?? 'null')) === json(parent),
  'Environment successor requires its exact failed business predecessor and unchanged approved source',
  'blocked-authorization');
  verifyNativeBusinessAuthority(previous, parent);
  const repoId = detail.priorAssignment.repoId;
  const nextEndpoint = auth.isolatedCdpEndpoint;
  requireThat(typeof nextEndpoint === 'string' && nextEndpoint !== endpoint(previous, repoId),
  'Environment successor requires its explicitly pinned isolated CDP endpoint',
  'blocked-authorization');
  const url = new URL(nextEndpoint);
  requireThat(url.protocol === 'http:' &&
    ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) && url.port &&
    !url.username && !url.password && !url.search && !url.hash && url.pathname === '/',
  'Environment successor CDP endpoint must be local and credential-free', 'blocked-authorization');
  const normalized = structuredClone(config);
  normalized.stateDirectory = previous.stateDirectory;
  requireThat(json(normalized) === json(previous) &&
    config.limits.maxValidationInfrastructureRetries === 0 &&
    config.limits.maxValidationRepairRounds === 10 &&
    /^[a-f0-9]{40}$/.test(auth.controllerRevision ?? '') &&
    controllerFiles.every(file => hash(readFileSync(join(root, file))) ===
      auth.controllerFiles?.[file]),
  'Environment successor must preserve its qualified configuration and bind the browser only at execution',
  'blocked-authorization');
  utc(auth.authorizedAt); utc(auth.recordedAt);
  const instruction = pinned(auth.userInstruction), environment = pinned(auth.environmentProof);
  requireThat(instruction.format === 'native-environment-revalidation-instruction-v1' &&
    instruction.requestedAt === auth.authorizedAt &&
    instruction.previousAttemptId === detail.priorJob.session_id &&
    instruction.previousResultId === detail.priorResult.id &&
    instruction.sourceRevision === auth.sourceRevision &&
    typeof instruction.userText === 'string' && instruction.userText.trim() &&
    Date.parse(auth.authorizedAt) >= Date.parse(detail.priorResult.reportedAt) &&
    Date.parse(auth.authorizedAt) <= Date.parse(auth.recordedAt) &&
    Date.parse(auth.recordedAt) <= Date.now() + 60000 &&
    typeof auth.reason === 'string' && auth.reason.trim() &&
    environment.format === 'isolated-hub-route-readiness-not-causal-proof-v1' &&
    environment.sourceRevision === auth.sourceRevision &&
    environment.currentHubParameterRetentionVerified === true &&
    environment.independentCdpClientVerified === true &&
    environment.newNativeBusinessInvocations === 0 &&
    environment.countsTowardFormalFive === false &&
    Date.parse(environment.observedAt) >= Date.parse(detail.priorResult.reportedAt) &&
    Date.parse(environment.observedAt) <= Date.parse(auth.recordedAt) &&
    Array.isArray(environment.evidence) && environment.evidence.length > 0,
  'Environment successor needs a fresh recorded user instruction and non-acceptance environment proof',
  'blocked-authorization');
  environment.evidence.forEach(pinned);
  const repo = config.repositories.find(row => row.id === repoId);
  const native = detail.operations.find(row => row.kind === 'validation');
  requireThat(repo.validationGates.length === 1 &&
    repo.validationGates[0].profile === '1js-declarative-e2e-v1' &&
    auth.failure.path === detail.priorResult.validation[0].artifactRefs[0] &&
    native && !outside(join(detail.priorStateDirectory, 'native-validation', hash(native.id)),
      auth.nativeSummary.path),
  'Environment successor needs its own sealed failed native batch', 'blocked-reconciliation');
  const failure = pinned(auth.failure);
  verifyPreparationRecovery(detail);
  verifyNativeBusinessFailure(detail.priorJob, detail.priorResult, detail.operations,
    failure, pinned(auth.nativeSummary), repo.validationGates[0].profileSha256);
  const proof = pinned(auth.preflight);
  verifyPreparationPreflight(proof, detail.priorJob, detail.priorResult,
    detail.priorAssignment, detail.operations, repo.validationGates[0].profileSha256);
  requireThat(json(proof.preparation.sparseCheckoutPaths) ===
    json(nativeBusinessValidationRepository(repo, detail).sparseCheckoutPaths) &&
    [detail.priorJob.workspace, ...(failure.output.residualPaths ?? [])].every(path =>
      outside(path, proof.workspace) && outside(proof.workspace, path)),
  'Environment successor requires newly attested preparation outside prior workspaces',
  'blocked-reconciliation');
}
