import { lstatSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stripVTControlCharacters } from 'node:util';
import { boundedPath, hash, json, now, requireThat, utc } from './common.js';
import { importReviewedContinuation } from './local-continuation.js';
import { qualifyRepositorySkill } from './repository-skills.js';
import { skillChangePopulation } from './declarative-e2e.js';
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
