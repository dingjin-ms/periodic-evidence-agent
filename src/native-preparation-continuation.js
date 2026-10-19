import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, json, now, requireThat, utc } from './common.js';
import { importReviewedContinuation } from './local-continuation.js';
import { qualifyRepositorySkill } from './repository-skills.js';
import { command, makePlannedImprovementAssignment, requireCurrentAssignment,
  verifyPreservedChange } from './workers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
function pinned(ref) {
  requireThat(isAbsolute(ref?.path ?? '') && /^[a-f0-9]{64}$/.test(ref.sha256 ?? '') &&
    hash(readFileSync(ref.path)) === ref.sha256,
  'Native preparation evidence changed', 'blocked-reconciliation');
  return JSON.parse(readFileSync(ref.path));
}
export function verifyNativePreparationFailure(job, result, operations, failure, profileSha256) {
  const kinds = ['commit', 'continued-from-authoring-tool-failure',
    'declarative-registration-continuation', 'owner-review',
    'reuse-owner-reviewed-proposal', 'validation'];
  requireThat(job?.state === 'blocked' && result?.assignmentId === job.id &&
    result.attemptId === job.session_id && result.outcome === 'blocked' &&
    /^[a-f0-9]{40}$/.test(result.sourceRevision ?? '') && result.draftPR === null &&
    result.remoteValidation.length === 0 && result.toolUsage?.used === 0 &&
    result.toolUsage.rounds.length === 0 && Object.values(result.toolUsage.byTool).every(n => n === 0) &&
    result.skillExecution?.status === 'succeeded' && result.validation.length === 1 &&
    result.validationAttempts.length === 1 && result.validationAttempts[0].round === 0 &&
    json(result.validationAttempts[0].validation) === json(result.validation) &&
    json(operations.map(row => row.kind).sort()) === json(kinds),
  'Only the exact zero-model, unpublished committed preparation failure can continue',
  'blocked-reconciliation');
  const gate = result.validation[0];
  requireThat(gate.status === 'blocked' && gate.blockedReason === 'validation-workspace-unavailable' &&
    gate.attemptCount === 1 && gate.artifactRefs.length === 1 &&
    gate.sourceRevision === result.sourceRevision && failure.revision === result.sourceRevision &&
    failure.gateId === gate.gateId && failure.attempt === 0 && failure.status === 'blocked' &&
    failure.blockedReason === gate.blockedReason && failure.profileSha256 === profileSha256 &&
    json(Object.keys(failure.output).sort()) === json(['exitCode', 'stderr', 'stdout', 'timeout']) &&
    failure.output.stdout === '' && failure.output.exitCode === null && failure.output.timeout === false &&
    failure.output.stderr.startsWith('Output fingerprint task timed out after 300000 ms: '),
  'Native preparation recovery cannot replay an invoked native runner', 'blocked-reconciliation');
  const task = JSON.parse(failure.output.stderr.slice(
    'Output fingerprint task timed out after 300000 ms: '.length));
  requireThat(task.mode === 'path' && typeof task.path === 'string' &&
    task.path.startsWith('ooui/.store/') && !task.path.includes('..') && !task.path.includes('\0'),
  'Preparation recovery requires the measured dependency fingerprint failure',
  'blocked-reconciliation');
  const state = Object.fromEntries(operations.map(row => [row.kind, row.state]));
  requireThat(state.commit === 'completed' && state['owner-review'] === 'approved' &&
    state['continued-from-authoring-tool-failure'] === 'claimed' &&
    state['declarative-registration-continuation'] === 'completed' &&
    state['reuse-owner-reviewed-proposal'] === 'completed' && state.validation === 'blocked',
  'Preparation predecessor has incomplete or unexpected operations', 'blocked-reconciliation');
}
export function verifyNativePreparationDispatchFailure(recovery) {
  const { priorJob: job, priorResult: result, operations, originalContinuation: original } = recovery;
  requireThat(original?.nativePreparationCorrection && !original.nativePreparationDispatchFailure &&
    operations.length === 1 && operations[0].kind === 'continued-from-validation-failure' &&
    operations[0].id === `${job.id}:validation-continuation` &&
    operations[0].state === 'prepared' && json(JSON.parse(operations[0].detail)) === json(original) &&
    hash(json(operations)) === recovery.priorOperationsSha256 &&
    hash(json(result)) === recovery.priorResultSha256 &&
    job.state === 'blocked' && job.session_id === original.nextAttemptId &&
    job.id === original.nextAssignmentId && job.base_revision === null &&
    job.workspace === original.priorJob.workspace &&
    json(JSON.parse(job.error)) === json({ code: 'blocked-reconciliation',
      message: 'Repository skill qualification does not match the isolated source revision' }) &&
    result.assignmentId === job.id && result.attemptId === job.session_id &&
    result.outcome === 'blocked' && result.sourceRevision === null && result.skillExecution === null &&
    result.draftPR === null && result.remoteValidation.length === 0 &&
    result.validation.length === 0 && result.validationAttempts.length === 0 &&
    result.toolUsage.used === 0 && result.toolUsage.rounds.length === 0 &&
    Object.values(result.toolUsage.byTool).every(n => n === 0),
  'Only the sealed zero-stage preparation field-mapping failure can continue once',
  'blocked-reconciliation');
}
export function nativePreparationWorkspace(detail) {
  requireThat(detail?.nativePreparationCorrection &&
    isAbsolute(detail.priorJob?.workspace ?? '') &&
    /^[a-f0-9]{40}$/.test(detail.priorJob?.base_revision ?? ''),
  'Preparation recovery requires its pinned owned workspace and base', 'blocked-reconciliation');
  return { workspace: detail.priorJob.workspace, baseRevision: detail.priorJob.base_revision };
}
export function verifyNativePreparationContinuation(config, detail) {
  const auth = detail.authorization, correction = detail.nativePreparationCorrection;
  const recovery = detail.nativePreparationDispatchFailure;
  if (recovery) {
    verifyNativePreparationDispatchFailure(recovery);
    verifyNativePreparationContinuation({ ...config, stateDirectory: recovery.priorStateDirectory },
      recovery.originalContinuation);
    requireThat(json(detail.priorJob) === json(recovery.originalContinuation.priorJob) &&
      json(detail.priorResult) === json(recovery.originalContinuation.priorResult) &&
      json(detail.priorAssignment) === json(recovery.originalContinuation.priorAssignment) &&
      detail.priorStateDirectory === recovery.originalContinuation.priorStateDirectory &&
      json(correction) === json(recovery.originalContinuation.nativePreparationCorrection),
    'Preparation dispatch correction changed its approved source lineage', 'blocked-reconciliation');
  }
  requireThat(auth.kind === 'native-preparation-only' && correction &&
    auth.approved === true && auth.authorizedBy === 'user' &&
    detail.authorizationSha256 === hash(json(auth)) &&
    detail.priorResultSha256 === hash(json(detail.priorResult)) &&
    detail.priorOperationsSha256 === hash(json(correction.operations)) &&
    json(correction.originalGrant) === json(JSON.parse(correction.operations.find(row =>
      row.kind === 'continued-from-authoring-tool-failure')?.detail ?? 'null')?.authorization) &&
    auth.scope === 'until-native-validation' && auth.maxInitialModelAttempts === 0 &&
    auth.priorAuthorizationSha256 === hash(json(recovery
      ? recovery.originalContinuation.authorization : correction.originalGrant)) &&
    auth.authorizedAt === correction.originalGrant.authorizedAt &&
    correction.originalGrant.scope === 'until-native-validation' &&
    correction.originalGrant.approved === true && correction.originalGrant.authorizedBy === 'user' &&
    auth.previousAttemptId === (recovery?.priorJob ?? detail.priorJob).session_id &&
    auth.sourceRevision === detail.priorResult.sourceRevision &&
    auth.baseRevision === detail.priorJob.base_revision &&
    correction.originalGrant.sourceRevision === detail.priorJob.base_revision &&
    correction.originalGrant.nextConfigSha256 ===
      hash(json({ ...config, stateDirectory: detail.priorStateDirectory })) &&
    auth.nextConfigSha256 === hash(json(config)),
  'Native preparation authority must retain the original bounded user grant',
  'blocked-authorization');
  const failure = pinned(auth.failure), request = pinned(auth.ownerRequest), approval = pinned(auth.ownerApproval);
  verifyNativePreparationFailure(detail.priorJob, detail.priorResult, correction.operations,
    failure, correction.profileSha256);
  const owner = correction.operations.find(row => row.kind === 'owner-review');
  const commit = JSON.parse(correction.operations.find(row => row.kind === 'commit').detail);
  const native = correction.operations.find(row => row.kind === 'validation');
  const ownerDetail = JSON.parse(owner.detail);
  requireThat(auth.failure.path === detail.priorResult.validation[0].artifactRefs[0] &&
    !existsSync(join(detail.priorStateDirectory, 'native-validation', hash(native.id))) &&
    commit.revision === detail.priorResult.sourceRevision && commit.round === 0 &&
    json(Object.keys(commit).sort()) === json(['revision', 'round']) &&
    ownerDetail.requestPath === auth.ownerRequest.path &&
    ownerDetail.requestSha256 === auth.ownerRequest.sha256 &&
    ownerDetail.approvalPath === auth.ownerApproval.path &&
    ownerDetail.approvalSha256 === auth.ownerApproval.sha256 &&
    request.format === 'repository-owner-review-request-v1' &&
    approval.format === 'repository-owner-review-v1' &&
    json(ownerDetail.fileSha256) === json(request.fileSha256) &&
    request.assignmentId === detail.priorJob.id && request.attemptId === detail.priorJob.session_id &&
    request.round === 0 && request.baseRevision === detail.priorJob.base_revision &&
    request.workspace === detail.priorJob.workspace &&
    approval.requestSha256 === auth.ownerRequest.sha256 && approval.status === 'approved' &&
    approval.reviewedBy === 'security-review-agent' && json(approval.findings) === '[]' &&
    json(detail.files) === json(Object.entries(request.fileSha256).map(([path, sha256]) =>
      ({ path, sha256 })).sort((a, b) => a.path.localeCompare(b.path))) &&
    detail.proposal.title === request.publication.title &&
    detail.proposal.description === (approval.publicationDescription ?? request.publication.description) &&
    correction.ownerReviewDirectory === correction.originalGrant.ownerReviewRecovery?.ownerReviewDirectory,
  'Preparation recovery does not match the exact approved commit or zero-native proof',
  'blocked-reconciliation');
}
export async function prepareNativePreparationContinuation(config, ledger, id,
  nextConfig, nextLedger, authorization) {
  const priorRoot = realpathSync(ledger.directory), nextRoot = realpathSync(nextLedger.directory);
  const outside = (a, b) => {
    const path = relative(a, b);
    return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
  };
  requireThat(outside(priorRoot, nextRoot) && outside(nextRoot, priorRoot) &&
    realpathSync(config.stateDirectory) === priorRoot && realpathSync(nextConfig.stateDirectory) === nextRoot &&
    json({ ...config, stateDirectory: null }) === json({ ...nextConfig, stateDirectory: null }),
  'Preparation continuation changes only fresh private state, not native gates or bounds',
  'blocked-reconciliation');
  requireThat(authorization?.approved === true && authorization.authorizedBy === 'user' &&
    authorization.previousAssignmentId === id && typeof authorization.reason === 'string' &&
    authorization.reason.trim(),
  'Preparation continuation needs explicit source-bound user authority', 'blocked-authorization');
  utc(authorization.authorizedAt); utc(authorization.recordedAt);
  requireThat(Date.parse(authorization.authorizedAt) <= Date.parse(authorization.recordedAt) &&
    Date.parse(authorization.recordedAt) <= Date.now() + 60000 &&
    (await command('git', ['rev-parse', 'HEAD'], root)).stdout.trim() === authorization.controllerRevision &&
    !(await command('git', ['status', '--porcelain'], root)).stdout.trim(),
  'Preparation continuation needs a clean pinned controller', 'blocked-authorization');
  const owner = ledger.acquire('dispatch'); let nextOwner;
  try {
    nextOwner = nextLedger.acquire('dispatch');
    const state = nextLedger.status();
    requireThat(!state.jobs.length && !state.counts.length && !state.operations.length && !state.runs.length,
      'Preparation continuation needs an unused ledger', 'blocked-reconciliation');
    const job = ledger.job(id), assignment = ledger.get('assignment', id);
    const results = ledger.all('workerResult').filter(row => row.assignmentId === id);
    requireThat(results.length === 1 && Date.parse(authorization.recordedAt) >= Date.parse(results[0].reportedAt),
      'Preparation predecessor must have one sealed result', 'blocked-reconciliation');
    const terminalResult = results[0], repo = config.repositories.find(row => row.id === assignment.repoId);
    requireThat(repo.validationGates.length === 1 &&
      repo.validationGates[0].profile === '1js-declarative-e2e-v1' &&
      nextConfig.limits.maxValidationInfrastructureRetries === 0,
    'Preparation recovery requires the unchanged retry-disabled native gate', 'blocked-reconciliation');
    const operations = ledger.status().operations.filter(row => row.job_id === id);
    const previousContinuation = operations.length === 1 &&
      operations[0].kind === 'continued-from-validation-failure'
      ? JSON.parse(operations[0].detail) : null;
    const recovery = previousContinuation ? { priorStateDirectory: priorRoot, priorJob: job,
      priorResult: terminalResult, priorResultSha256: hash(json(terminalResult)),
      operations, priorOperationsSha256: hash(json(operations)),
      originalContinuation: previousContinuation } : null;
    if (recovery) verifyNativePreparationDispatchFailure(recovery);
    const preservedJob = previousContinuation?.priorJob ?? job;
    const preservedAssignment = previousContinuation?.priorAssignment ?? assignment;
    const result = previousContinuation?.priorResult ?? terminalResult;
    const preservedRoot = previousContinuation?.priorStateDirectory ?? priorRoot;
    const preservedOperations = previousContinuation?.nativePreparationCorrection.operations ?? operations;
    const grant = JSON.parse(preservedOperations.find(row =>
      row.kind === 'continued-from-authoring-tool-failure')?.detail ?? 'null')?.authorization;
    const request = pinned(authorization.ownerRequest), approval = pinned(authorization.ownerApproval);
    const proposal = { outcome: 'propose-change', findings: result.findings,
      title: request.publication.title,
      description: approval.publicationDescription ?? request.publication.description,
      skillResult: structuredClone(result.skillExecution) };
    const files = (await verifyPreservedChange({ ...config, stateDirectory: preservedRoot },
      preservedAssignment, preservedJob, result, proposal))
      .sort((a, b) => a.path.localeCompare(b.path));
    const detail = { priorStateDirectory: preservedRoot, nextStateDirectory: nextRoot,
      priorAssignment: preservedAssignment, priorJob: preservedJob, priorResult: result, proposal, files,
      priorResultSha256: hash(json(result)), priorOperationsSha256: hash(json(preservedOperations)),
      authorization, authorizationSha256: hash(json(authorization)), preparedAt: now(),
      ...(recovery ? { nativePreparationDispatchFailure: recovery } : {}),
      nativePreparationCorrection: { operations: preservedOperations, originalGrant: grant,
        profileSha256: repo.validationGates[0].profileSha256,
        ownerReviewDirectory: grant?.ownerReviewRecovery?.ownerReviewDirectory } };
    verifyNativePreparationContinuation(nextConfig, detail);
    requireCurrentAssignment(config, ledger, ledger.get('investigation', assignment.investigationId), assignment);
    const qualification = await qualifyRepositorySkill(nextConfig, assignment.repoId,
      assignment.capability, assignment.skillBindingId);
    requireThat(qualification.baseRevision === preservedJob.base_revision &&
      qualification.skillSha256 === assignment.skillQualification.skillSha256,
    'Preparation recovery changed the repository skill pin', 'blocked-reconciliation');
    detail.qualification = qualification;
    const operationId = `${id}:${recovery
      ? 'native-preparation-dispatch-continuation' : 'validation-continuation'}`;
    ledger.operation(operationId, id, 'validation-continuation', detail);
    let rebuilt;
    nextLedger.transaction(() => {
      importReviewedContinuation(config, ledger, nextLedger, assignment, qualification,
        'native-preparation-continuation:captured-evidence-import');
      rebuilt = makePlannedImprovementAssignment(nextConfig, nextLedger,
        ledger.get('investigation', assignment.investigationId), assignment.testCoveragePlanId,
        assignment.requestedOutcome, assignment.testCoveragePlanVersion);
      requireThat(json({ ...assignment, id: null, skillQualification: null }) ===
        json({ ...rebuilt, id: null, skillQualification: null }),
      'Preparation recovery changed assignment semantics', 'blocked-reconciliation');
      const nextJob = nextLedger.prepare(rebuilt, { bucket: operationId, maxNew: 1 });
      Object.assign(detail, { nextAssignmentId: rebuilt.id, nextAttemptId: nextJob.session_id });
      nextLedger.operation(operationId, rebuilt.id, 'continued-from-validation-failure', detail);
      nextLedger.finishOperation(operationId, 'prepared', detail);
    });
    ledger.finishOperation(operationId, 'prepared', detail);
    return { assignment: rebuilt, job: nextLedger.job(rebuilt.id), audit: detail };
  } finally { if (nextOwner) nextLedger.release('dispatch', nextOwner); ledger.release('dispatch', owner); }
}
