import { existsSync, lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { boundedPath, hash, json, now, requireThat, utc } from './common.js';
import { importReviewedContinuation } from './local-continuation.js';
import { qualifyRepositorySkill } from './repository-skills.js';
import { skillChangePopulation } from './declarative-e2e.js';
import { verifyPreparationPreflight, verifyUninvokedPreparation } from './native-preparation-continuation.js';
import { command, makePlannedImprovementAssignment, requireCurrentAssignment,
  verifyContinuationPredecessor } from './workers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
async function git(workspace, args) {
  return (await command('git', ['-c', 'core.longpaths=true', ...args], workspace)).stdout.trim();
}
function pinned(ref) {
  requireThat(isAbsolute(ref?.path ?? '') && /^[a-f0-9]{64}$/.test(ref.sha256 ?? '') &&
    hash(readFileSync(ref.path)) === ref.sha256,
  'Native source-repair evidence changed', 'blocked-reconciliation');
  return JSON.parse(readFileSync(ref.path, 'utf8'));
}
export function verifyNativeUnitFailure(job, result, operations, failure, profileSha256) {
  const validation = result?.validation?.[0];
  requireThat(job?.state === 'blocked' && result?.outcome === 'blocked' &&
    result.assignmentId === job.id && result.attemptId === job.session_id &&
    /^[a-f0-9]{40}$/.test(result.sourceRevision ?? '') &&
    result.draftPR === null && result.remoteValidation.length === 0 &&
    result.toolUsage.used === 0 && result.toolUsage.rounds.length === 0 &&
    Object.values(result.toolUsage.byTool).every(value => value === 0) &&
    result.skillExecution?.status === 'succeeded' &&
    result.skillExecution.needsHumanDecision === false &&
    result.validation.length === 1 && result.validationAttempts.length === 1 &&
    result.validationAttempts[0].round === 0 &&
    json(result.validationAttempts[0].validation) === json(result.validation) &&
    validation.status === 'blocked' && validation.blockedReason === 'validation-profile-error' &&
    validation.attemptCount === 1 && validation.artifactRefs.length === 1 &&
    validation.sourceRevision === result.sourceRevision &&
    operations.filter(row => row.kind === 'validation').length === 1 &&
    operations.every(row => ({
      validation: 'blocked', 'continued-from-validation-failure': 'prepared',
      'reuse-authored-revision': 'completed', 'declarative-registration-continuation': 'completed'
    })[row.kind] === row.state) &&
    failure.status === 'blocked' && failure.blockedReason === validation.blockedReason &&
    failure.revision === result.sourceRevision && failure.gateId === validation.gateId &&
    failure.attempt === 0 && failure.profileSha256 === profileSha256 &&
    failure.output.exitCode === 1 && failure.output.timeout === false &&
    failure.output.stdout === '' && !failure.output.nativeReceipt,
  'Source repair requires one sealed, unpublished, zero-model native unit failure',
  'blocked-reconciliation');
  const failed = stripVTControlCharacters(failure.output.stderr).match(
    /(?:^|\n)\s+1 failed\r?\n\s+(declarative[\\/][^\r\n:]+\.unit\.ts):\d+:\d+/);
  requireThat(failed && /^declarative\/src\/tests\/[a-zA-Z0-9_/-]+\.unit\.ts$/
    .test(failed[1].replaceAll('\\', '/')) &&
    !failed[1].replaceAll('\\', '/').split('/').includes('..'),
  'Source repair accepts only the single failed native unit test file',
  'blocked-reconciliation');
  return `ooui/apps/excel-agent-declarative-e2e/${failed[1].replaceAll('\\', '/')}`;
}
export function verifySourceRepairApproval(detail) {
  const auth = detail.authorization;
  const request = pinned(auth.ownerRequest), approval = pinned(auth.ownerApproval);
  const files = detail.files;
  requireThat(request.format === 'repository-owner-review-request-v1' &&
    request.assignmentId === detail.priorJob.id &&
    request.workspace === detail.priorJob.workspace &&
    request.baseRevision === detail.priorJob.base_revision &&
    request.attemptId === auth.reviewAttemptId && request.round === 0 &&
    Date.parse(request.requestedAt) > Date.parse(detail.priorResult.reportedAt) &&
    approval.format === 'repository-owner-review-v1' &&
    approval.requestSha256 === auth.ownerRequest.sha256 &&
    approval.status === 'approved' && approval.reviewedBy === 'security-review-agent' &&
    Array.isArray(approval.findings) && approval.findings.length === 0 &&
    (approval.publicationDescription === undefined ||
      (typeof approval.publicationDescription === 'string' &&
        approval.publicationDescription.trim() && approval.publicationDescription.length <= 3000)) &&
    json(Object.keys(request.fileSha256).sort()) === json(files.map(file => file.path).sort()) &&
    files.every(file => request.fileSha256[file.path] === file.sha256) &&
    typeof request.publication?.title === 'string' && request.publication.title.trim() &&
    typeof request.publication?.description === 'string' && request.publication.description.trim() &&
    detail.proposal.title === request.publication.title &&
    detail.proposal.description === (approval.publicationDescription ?? request.publication.description),
  'Source repair requires fresh owner approval of the complete exact source population',
  'blocked-owner');
}
export async function verifyNativeSourceSnapshot(detail) {
  if (detail.sourcePreparedContinuation)
    return verifyNativeSourceSnapshot(detail.sourcePreparedContinuation.originalContinuation);
  if (detail.sourcePreparationRecovery)
    return verifyNativeSourceSnapshot(detail.sourcePreparationRecovery.originalContinuation);
  verifySourceRepairApproval(detail);
  const { priorJob: job, priorResult: result, authorization: auth } = detail;
  requireThat(await git(job.workspace, ['rev-parse', 'HEAD']) === auth.repairedRevision &&
    !await git(job.workspace, ['status', '--porcelain']) &&
    await git(job.workspace, ['rev-list', '--parents', '-n', '1', auth.repairedRevision]) ===
      `${auth.repairedRevision} ${result.sourceRevision}` &&
    await git(job.workspace, ['rev-list', '--parents', '-n', '1', result.sourceRevision]) ===
      `${result.sourceRevision} ${job.base_revision}` &&
    await git(job.workspace, ['diff', '--no-renames', '--name-status',
      result.sourceRevision, auth.repairedRevision]) === `M\t${auth.unitFile}` &&
    json((await git(job.workspace, ['diff', '--no-renames', '--name-only',
      job.base_revision, auth.repairedRevision])).split(/\r?\n/).sort()) ===
      json(detail.files.map(file => file.path).sort()),
  'Source repair must be one clean child commit changing only the failed unit file',
  'blocked-reconciliation');
  for (const file of detail.files) {
    const path = boundedPath(job.workspace, file.path);
    requireThat(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() &&
      hash(readFileSync(path)) === file.sha256,
    'Approved source-repair bytes changed', 'blocked-reconciliation');
  }
}
export function verifyNativeSourceAuthority(config, detail) {
  if (detail.sourcePreparedContinuation) {
    verifySourcePreparedContinuation(config, detail);
    return;
  }
  if (detail.sourcePreparationRecovery) {
    verifyNativeSourcePreparationRecovery(config, detail);
    return;
  }
  const auth = detail.authorization, previous = detail.previousConfig;
  requireThat(detail.nativeSourceCorrection === true &&
    !detail.nativePreparationCorrection && !detail.preparationRecovery &&
    auth.kind === 'native-unit-source-repair' && auth.approved === true &&
    auth.authorizedBy === 'user' && auth.maxInitialModelAttempts === 0 &&
    auth.previousAssignmentId === detail.priorJob.id &&
    auth.previousAttemptId === detail.priorJob.session_id &&
    auth.sourceRevision === detail.priorResult.sourceRevision &&
    auth.baseRevision === detail.priorJob.base_revision &&
    /^[a-f0-9]{40}$/.test(auth.repairedRevision ?? '') &&
    auth.repairedRevision !== auth.sourceRevision &&
    auth.nextConfigSha256 === hash(json(config)) &&
    previous.stateDirectory === detail.priorStateDirectory &&
    detail.authorizationSha256 === hash(json(auth)) &&
    json({ ...config, stateDirectory: null }) === json({ ...previous, stateDirectory: null }) &&
    config.limits.maxValidationInfrastructureRetries === 0 &&
    config.limits.maxValidationRepairRounds === previous.limits.maxValidationRepairRounds &&
    detail.priorResultSha256 === hash(json(detail.priorResult)) &&
    detail.priorOperationsSha256 === hash(json(detail.operations)),
  'Source repair changed its source, configuration, authority or retry bounds',
  'blocked-authorization');
  const repo = config.repositories.find(row => row.id === detail.priorAssignment.repoId);
  requireThat(repo?.validationGates.length === 1 &&
    repo.validationGates[0].profile === '1js-declarative-e2e-v1' &&
    auth.failure.path === detail.priorResult.validation[0].artifactRefs[0],
  'Source repair requires the original single native gate', 'blocked-reconciliation');
  const unitFile = verifyNativeUnitFailure(detail.priorJob, detail.priorResult,
    detail.operations, pinned(auth.failure), repo.validationGates[0].profileSha256);
  requireThat(auth.unitFile === unitFile &&
    !skillChangePopulation(detail.priorResult.skillExecution).includes(unitFile) &&
    json(detail.files.map(file => file.path).sort()) ===
      json([...skillChangePopulation(detail.priorResult.skillExecution), unitFile].sort()),
  'Source repair cannot expand beyond the original candidate and failed unit file',
  'blocked-scope');
  verifySourceRepairApproval(detail);
}
export function verifyNativeSourcePreparationFailure(job, result, operations, failure, profileSha256) {
  const gate = result?.validation?.[0], output = failure?.output;
  requireThat(job?.state === 'blocked' && result?.outcome === 'blocked' &&
    result.assignmentId === job.id && result.attemptId === job.session_id &&
    result.draftPR === null && result.remoteValidation.length === 0 &&
    result.toolUsage.used === 0 && result.toolUsage.rounds.length === 0 &&
    Object.values(result.toolUsage.byTool).every(value => value === 0) &&
    result.skillExecution?.status === 'succeeded' &&
    result.validation.length === 1 && result.validationAttempts.length === 1 &&
    result.validationAttempts[0].round === 0 &&
    json(result.validationAttempts[0].validation) === json(result.validation) &&
    gate.status === 'blocked' && gate.blockedReason === 'validation-workspace-unavailable' &&
    gate.attemptCount === 1 && gate.artifactRefs.length === 1 &&
    gate.sourceRevision === result.sourceRevision &&
    operations.length === 4 && new Set(operations.map(row => row.kind)).size === 4 &&
    operations.every(row => ({
      validation: 'blocked', 'continued-from-validation-failure': 'prepared',
      'reuse-authored-revision': 'completed', 'declarative-registration-continuation': 'completed'
    })[row.kind] === row.state) &&
    failure.status === 'blocked' && failure.blockedReason === gate.blockedReason &&
    failure.revision === result.sourceRevision && failure.gateId === gate.gateId &&
    failure.attempt === 0 && failure.profileSha256 === profileSha256 &&
    json(failure.preparationTimings?.map(row => [row.id, row.status])) ===
      json([['source-check', 'passed'], ['worktree-create', 'passed'], ['checkout', 'blocked']]) &&
    output?.exitCode === null && output.timeout === false && output.stdout === '' &&
    !output.nativeReceipt && !output.unitDiagnostics && !output.inspectionError &&
    !output.cleanupError && !output.residualPaths &&
    output.preparationFailure?.stage === 'checkout' &&
    output.preparationFailure.reason === 'command-timeout' &&
    output.preparationFailure.timeout === true &&
    output.preparationFailure.ownedProcessesExited === true &&
    output.preparationFailure.containmentFailure === false,
  'Source preparation recovery requires its sealed zero-native checkout timeout and completed cleanup',
  'blocked-reconciliation');
}
export function nativeSourceValidationRepository(repo, detail) {
  if (detail.sourcePreparedContinuation)
    return nativeSourceValidationRepository(repo,
      detail.sourcePreparedContinuation.originalContinuation);
  const recovery = detail.sourcePreparationRecovery;
  if (!recovery) return repo;
  const original = recovery.originalContinuation, auth = detail.authorization;
  const preparation = JSON.parse(original.operations.find(row =>
    row.kind === 'continued-from-validation-failure')?.detail ?? 'null');
  requireThat(json(auth.preparationStrategy) === json(preparation?.authorization?.preflight),
    'Source preparation must retain the historical reviewed strategy', 'blocked-reconciliation');
  const proof = pinned(auth.preparationStrategy);
  const paths = ['ooui', 'packages', 'scripts', 'tools', '.github', '.config', '.buildXL', '.scoper'];
  requireThat(auth.kind === 'native-source-preparation-recovery' &&
    proof.format === 'validation-preflight-v1' && proof.status === 'passed' &&
    proof.assignmentId === detail.priorJob.id &&
    proof.sourceRevision === original.priorResult.sourceRevision &&
    proof.baseRevision === detail.priorJob.base_revision &&
    proof.profileSha256 === repo.validationGates[0].profileSha256 &&
    proof.preparation?.strategy === 'detached-worktree' &&
    proof.nativeCaseInvocations === 0 && proof.modelInvocations === 0 &&
    proof.publicationInvocations === 0 && proof.acceptanceEvidence === false &&
    json(proof.preparation.sparseCheckoutPaths) === json(paths) &&
    json(auth.sparseCheckoutPaths) === json(paths) &&
    (!repo.sparseCheckoutPaths?.length || json(repo.sparseCheckoutPaths) === json(paths)),
  'Source recovery changes only checkout population, never reuses old-SHA acceptance',
  'blocked-reconciliation');
  return { ...repo, sparseCheckoutPaths: [...paths] };
}
function verifyNativeSourcePreparationRecovery(config, detail) {
  const { authorization: auth, previousConfig: previous } = detail;
  const original = detail.sourcePreparationRecovery.originalContinuation;
  requireThat(!original?.sourcePreparationRecovery &&
    detail.nativeSourceCorrection === true &&
    !detail.nativePreparationCorrection && !detail.preparationRecovery &&
    auth.kind === 'native-source-preparation-recovery' &&
    auth.approved === true && auth.authorizedBy === 'user' &&
    auth.maxInitialModelAttempts === 0 &&
    auth.previousAssignmentId === detail.priorJob.id &&
    auth.previousAttemptId === detail.priorJob.session_id &&
    auth.sourceRevision === detail.priorResult.sourceRevision &&
    auth.repairedRevision === auth.sourceRevision &&
    auth.repairedRevision === original?.authorization.repairedRevision &&
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
    json({ ...config, stateDirectory: null }) === json({ ...previous, stateDirectory: null }) &&
    json(detail.priorAssignment) === json(original.priorAssignment) &&
    detail.priorJob.workspace === original.priorJob.workspace &&
    detail.priorJob.base_revision === original.priorJob.base_revision &&
    json(detail.files) === json(original.files) &&
    json(detail.proposal) === json(original.proposal) &&
    json(auth.ownerRequest) === json(original.authorization.ownerRequest) &&
    json(auth.ownerApproval) === json(original.authorization.ownerApproval) &&
    json(JSON.parse(detail.operations.find(row =>
      row.kind === 'continued-from-validation-failure')?.detail ?? 'null')) === json(original),
  'Source preparation recovery must preserve its exact reviewed repair and predecessor',
  'blocked-authorization');
  verifyNativeSourceAuthority(previous, original);
  const repo = config.repositories.find(row => row.id === detail.priorAssignment.repoId);
  requireThat(auth.failure.path === detail.priorResult.validation[0].artifactRefs[0],
    'Source preparation failure artifact changed', 'blocked-reconciliation');
  verifyNativeSourcePreparationFailure(detail.priorJob, detail.priorResult, detail.operations,
    pinned(auth.failure), repo.validationGates[0].profileSha256);
  nativeSourceValidationRepository(repo, detail);
}
export function verifyNativeSourceCopyFailure(detail, failure, profileSha256) {
  verifyUninvokedPreparation(detail.priorJob, detail.priorResult, detail.operations, failure,
    profileSha256, detail.priorStateDirectory);
  const validation = detail.operations.find(row => row.kind === 'validation');
  const residual = join(detail.priorStateDirectory, 'validation-workspaces', hash(validation.id));
  requireThat(detail.operations.length === 4 &&
    new Set(detail.operations.map(row => row.kind)).size === 4 &&
    failure.blockedReason === 'validation-workspace-unavailable' &&
    detail.priorResult.validation[0].blockedReason === failure.blockedReason &&
    !failure.output.unitDiagnostics && !failure.output.inspectionError &&
    typeof failure.output.cleanupError === 'string' && failure.output.cleanupError &&
    json(failure.output.residualPaths) === json([residual]) &&
    !existsSync(join(residual, '.git')) &&
    failure.output.preparationFailure?.stage === 'dependency-copy' &&
    failure.output.preparationFailure.reason === 'command-timeout' &&
    failure.output.preparationFailure.timeout === true &&
    failure.output.preparationFailure.ownedProcessesExited === true &&
    failure.output.preparationFailure.containmentFailure === false &&
    json(failure.preparationTimings?.map(row => [row.id, row.status])) === json([
      ['source-check', 'passed'], ['worktree-create', 'passed'], ['sparse-checkout', 'passed'],
      ['checkout', 'passed'], ['head-clean-check', 'passed'], ['lfs', 'passed'],
      ['dependencies', 'blocked'], ['dependency-source-fingerprint', 'passed'],
      ['dependency-copy', 'blocked']
    ]),
  'Prepared source continuation requires the exact sealed zero-native copy timeout',
  'blocked-reconciliation');
  return residual;
}
function verifySourcePreparedContinuation(config, detail) {
  const previous = detail.sourcePreparedContinuation.originalContinuation;
  const auth = detail.authorization;
  requireThat(previous?.sourcePreparationRecovery && !previous.sourcePreparedContinuation &&
    detail.nativeSourceCorrection === true && !detail.sourcePreparationRecovery &&
    !detail.nativePreparationCorrection && !detail.preparationRecovery &&
    auth.kind === 'native-source-prepared-continuation' &&
    auth.approved === true && auth.authorizedBy === 'user' &&
    auth.maxInitialModelAttempts === 0 &&
    auth.previousAssignmentId === detail.priorJob.id &&
    auth.previousAttemptId === detail.priorJob.session_id &&
    auth.sourceRevision === detail.priorResult.sourceRevision &&
    auth.repairedRevision === auth.sourceRevision &&
    auth.repairedRevision === previous.authorization.repairedRevision &&
    auth.baseRevision === detail.priorJob.base_revision &&
    auth.unitFile === previous.authorization.unitFile &&
    auth.priorAuthorizationSha256 === previous.authorizationSha256 &&
    auth.nextConfigSha256 === hash(json(config)) &&
    detail.authorizationSha256 === hash(json(auth)) &&
    detail.priorResultSha256 === hash(json(detail.priorResult)) &&
    detail.priorOperationsSha256 === hash(json(detail.operations)) &&
    previous.nextStateDirectory === detail.priorStateDirectory &&
    previous.nextAssignmentId === detail.priorJob.id &&
    previous.nextAttemptId === detail.priorJob.session_id &&
    detail.previousConfig.stateDirectory === detail.priorStateDirectory &&
    detail.priorJob.workspace === previous.priorJob.workspace &&
    detail.priorJob.base_revision === previous.priorJob.base_revision &&
    json(detail.priorAssignment) === json(previous.priorAssignment) &&
    json(detail.files) === json(previous.files) && json(detail.proposal) === json(previous.proposal) &&
    json(auth.ownerRequest) === json(previous.authorization.ownerRequest) &&
    json(auth.ownerApproval) === json(previous.authorization.ownerApproval) &&
    json({ ...config, stateDirectory: null }) ===
      json({ ...detail.previousConfig, stateDirectory: null }) &&
    config.limits.maxValidationInfrastructureRetries === 0 &&
    config.limits.maxValidationRepairRounds === 10 &&
    json(JSON.parse(detail.operations.find(row =>
      row.kind === 'continued-from-validation-failure')?.detail ?? 'null')) === json(previous),
  'Prepared source continuation must preserve its exact authority and cannot recurse',
  'blocked-authorization');
  verifyNativeSourceAuthority(detail.previousConfig, previous);
  const repo = config.repositories.find(row => row.id === detail.priorAssignment.repoId);
  requireThat(auth.failure.path === detail.priorResult.validation[0].artifactRefs[0],
    'Prepared source continuation changed its sealed failure reference', 'blocked-reconciliation');
  const residual = verifyNativeSourceCopyFailure(detail, pinned(auth.failure),
    repo.validationGates[0].profileSha256);
  const proof = pinned(auth.preflight);
  verifyPreparationPreflight(proof, detail.priorJob, detail.priorResult, detail.priorAssignment,
    detail.operations, repo.validationGates[0].profileSha256);
  const outside = (a, b) => {
    const name = relative(resolve(a), resolve(b));
    return name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name);
  };
  requireThat(outside(residual, proof.workspace) && outside(proof.workspace, residual) &&
    json(proof.preparation.sparseCheckoutPaths) ===
      json(nativeSourceValidationRepository(repo, previous).sparseCheckoutPaths) &&
    ['src/native-source-continuation.js', 'src/retained-dependency-copy.js'].every(file =>
      proof.controllerFiles[file] === hash(readFileSync(join(root, file)))),
  'Prepared source continuation needs current isolated preparation, not the failed residual',
  'blocked-reconciliation');
}
export async function verifyPreparedNativeSource(config, detail, operationId, attemptId) {
  verifyNativeSourceAuthority(config, detail);
  requireThat(await git(root, ['rev-parse', 'HEAD']) === detail.authorization.controllerRevision &&
    !await git(root, ['status', '--porcelain']),
  'Source repair controller must remain clean at its approved revision',
  'blocked-reconciliation');
  verifyContinuationPredecessor(detail, operationId, attemptId);
  await verifyNativeSourceSnapshot(detail);
}
export async function prepareNativeSourceContinuation(config, ledger, id,
  nextConfig, nextLedger, authorization) {
  const priorRoot = realpathSync(ledger.directory), nextRoot = realpathSync(nextLedger.directory);
  const outside = (a, b) => {
    const path = relative(a, b);
    return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
  };
  requireThat(outside(priorRoot, nextRoot) && outside(nextRoot, priorRoot) &&
    realpathSync(config.stateDirectory) === priorRoot &&
    realpathSync(nextConfig.stateDirectory) === nextRoot &&
    await git(root, ['rev-parse', 'HEAD']) === authorization.controllerRevision &&
    !await git(root, ['status', '--porcelain']),
  'Source repair requires separate ledgers and a clean pinned controller',
  'blocked-reconciliation');
  utc(authorization.authorizedAt); utc(authorization.recordedAt);
  requireThat(Date.parse(authorization.authorizedAt) <= Date.parse(authorization.recordedAt) &&
    Date.parse(authorization.recordedAt) <= Date.now() + 60000 &&
    typeof authorization.reason === 'string' && authorization.reason.trim(),
  'Source repair needs bounded recorded authority', 'blocked-authorization');
  const owner = ledger.acquire('dispatch'); let nextOwner;
  try {
    nextOwner = nextLedger.acquire('dispatch');
    const state = nextLedger.status();
    requireThat(!state.jobs.length && !state.counts.length && !state.operations.length && !state.runs.length,
      'Source repair requires an unused destination ledger', 'blocked-reconciliation');
    const job = ledger.job(id), assignment = ledger.get('assignment', id);
    const results = ledger.all('workerResult').filter(row => row.assignmentId === id);
    requireThat(results.length === 1 &&
      Date.parse(authorization.recordedAt) >= Date.parse(results[0].reportedAt),
    'Source repair needs exactly one sealed predecessor', 'blocked-reconciliation');
    const request = pinned(authorization.ownerRequest), approval = pinned(authorization.ownerApproval);
    const detail = {
      previousConfig: config, priorStateDirectory: priorRoot, nextStateDirectory: nextRoot,
      priorJob: job, priorAssignment: assignment, priorResult: results[0],
      priorResultSha256: hash(json(results[0])),
      operations: ledger.status().operations.filter(row => row.job_id === id),
      authorization, authorizationSha256: hash(json(authorization)),
      nativeSourceCorrection: true, preparedAt: now(),
      proposal: { outcome: 'propose-change', findings: results[0].findings,
        title: request.publication.title,
        description: approval.publicationDescription ?? request.publication.description,
        skillResult: structuredClone(results[0].skillExecution) },
      files: Object.entries(request.fileSha256).map(([path, sha256]) => ({ path, sha256 }))
        .sort((a, b) => a.path.localeCompare(b.path))
    };
    detail.priorOperationsSha256 = hash(json(detail.operations));
    if (authorization.kind === 'native-source-preparation-recovery') {
      const original = JSON.parse(detail.operations.find(row =>
        row.kind === 'continued-from-validation-failure')?.detail ?? 'null');
      detail.sourcePreparationRecovery = { originalContinuation: original };
      detail.proposal = structuredClone(original?.proposal);
    } else if (authorization.kind === 'native-source-prepared-continuation') {
      const original = JSON.parse(detail.operations.find(row =>
        row.kind === 'continued-from-validation-failure')?.detail ?? 'null');
      detail.sourcePreparedContinuation = { originalContinuation: original };
      detail.proposal = structuredClone(original?.proposal);
    }
    verifyNativeSourceAuthority(nextConfig, detail);
    await verifyNativeSourceSnapshot(detail);
    requireCurrentAssignment(config, ledger, ledger.get('investigation', assignment.investigationId), assignment);
    const qualification = await qualifyRepositorySkill(nextConfig, assignment.repoId,
      assignment.capability, assignment.skillBindingId);
    requireThat(qualification.baseRevision === job.base_revision &&
      qualification.skillSha256 === assignment.skillQualification.skillSha256,
    'Source repair changed the skill or qualified baseline', 'blocked-reconciliation');
    detail.qualification = qualification;
    const operationId = `${id}:native-source-continuation:${job.session_id}`;
    ledger.operation(operationId, id, 'validation-continuation', detail);
    let rebuilt;
    nextLedger.transaction(() => {
      importReviewedContinuation(config, ledger, nextLedger, assignment, qualification,
        'native-source-repair:captured-evidence-import');
      rebuilt = makePlannedImprovementAssignment(nextConfig, nextLedger,
        ledger.get('investigation', assignment.investigationId), assignment.testCoveragePlanId,
        assignment.requestedOutcome, assignment.testCoveragePlanVersion);
      requireThat(rebuilt.id === assignment.id &&
        json({ ...assignment, id: null, skillQualification: null }) ===
        json({ ...rebuilt, id: null, skillQualification: null }),
      'Source repair changed assignment semantics', 'blocked-reconciliation');
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
