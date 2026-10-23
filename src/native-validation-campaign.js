import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, json, now, requireThat, utc } from './common.js';
import { importReviewedContinuation } from './local-continuation.js';
import { verifyNativeBusinessFailure } from './native-business-revalidation.js';
import { verifyCampaignCommandBudget, verifyInterruptedNativeBatch } from './native-campaign-interruption.js';
import { verifyPreparationPreflight } from './native-preparation-continuation.js';
import { nativeSourceValidationRepository, verifyNativeSourceSnapshot } from './native-source-continuation.js';
import { qualifyRepositorySkill } from './repository-skills.js';
import { command, makePlannedImprovementAssignment, requireCurrentAssignment,
  verifyContinuationPredecessor } from './workers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const git = async args => (await command('git', args, root)).stdout.trim();
const historicalFiles = ['src/cli.js', 'src/workers.js', 'src/native-business-revalidation.js',
  'src/native-environment-revalidation.js', 'src/native-source-continuation.js',
  'src/native-preparation-continuation.js', 'src/native-command.js'];
function pinned(ref) {
  requireThat(isAbsolute(ref?.path ?? '') && /^[a-f0-9]{64}$/.test(ref.sha256 ?? '') &&
    hash(readFileSync(ref.path)) === ref.sha256,
  'Campaign evidence changed', 'blocked-reconciliation');
  return JSON.parse(readFileSync(ref.path, 'utf8'));
}
function outside(parent, child) {
  const path = relative(resolve(parent), resolve(child));
  return path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path);
}
async function verifyHistoricalCode(history) {
  await git(['merge-base', '--is-ancestor', history.controllerRevision, 'HEAD']);
  for (const file of historicalFiles) {
    const { stdout } = await command('git', ['show', `${history.controllerRevision}:${file}`], root);
    requireThat([stdout, stdout.replace(/\r?\n/g, '\r\n')]
      .some(bytes => hash(bytes) === history.controllerFiles[file]),
    'Historical verification code differs from its recorded Git revision', 'blocked-reconciliation');
  }
}
export function nativeCampaignValidationRepository(repo, detail) {
  const original = pinned(detail.authorization.historicalAttestation).originalSourceContinuation;
  const validation = nativeSourceValidationRepository(repo, original);
  return { ...validation, validationGates: validation.validationGates.map(gate => ({
    ...gate, declarativeE2E: {
      ...gate.declarativeE2E, cdpEndpoint: detail.authorization.isolatedCdpEndpoint,
      ...(detail.authorization.commandBudgetAdjustment ? {
        commandTimeoutMs: detail.authorization.commandBudgetAdjustment.commandTimeoutMs
      } : {})
    }
  })) };
}
export function verifyNativeCampaignAuthority(config, detail) {
  const { authorization: auth, previousConfig: previous } = detail;
  const originalConfig = verifyCampaignCommandBudget(config, detail, pinned);
  requireThat(detail.nativeCampaignRevalidation === true &&
    detail.nativeSourceCorrection === true && !detail.nativeBusinessRevalidation &&
    !detail.sourcePreparedContinuation && !detail.sourcePreparationRecovery &&
    !detail.nativePreparationCorrection &&
    auth?.kind === 'native-validation-campaign-batch' && auth.approved === true &&
    auth.authorizedBy === 'user' && auth.scope === 'one-complete-batch-in-until-pass-campaign' &&
    auth.maxInitialModelAttempts === 0 && auth.maxNativeBatches === 1 &&
    auth.requiredRepeats === 5 && auth.nativeRetries === 0 &&
    Number.isInteger(auth.batchIndex) && auth.batchIndex >= 0 &&
    auth.batchIndex < config.limits.maxValidationRepairRounds &&
    config.limits.maxValidationRepairRounds === 10 &&
    config.limits.maxValidationInfrastructureRetries === 0 &&
    auth.previousAssignmentId === detail.priorJob.id &&
    auth.previousAttemptId === detail.priorJob.session_id &&
    auth.sourceRevision === detail.priorResult.sourceRevision &&
    auth.repairedRevision === auth.sourceRevision &&
    auth.baseRevision === detail.priorJob.base_revision &&
    auth.nextConfigSha256 === hash(json(config)) &&
    detail.authorizationSha256 === hash(json(auth)) &&
    detail.priorResultSha256 === hash(json(detail.priorResult)) &&
    detail.priorOperationsSha256 === hash(json(detail.operations)) &&
    previous.stateDirectory === detail.priorStateDirectory &&
    (auth.commandBudgetAdjustment ||
      json({ ...config, stateDirectory: null }) === json({ ...previous, stateDirectory: null })),
  'Campaign admission must preserve one approved source and one complete zero-retry batch',
  'blocked-authorization');
  const history = pinned(auth.historicalAttestation);
  const source = history.originalSourceContinuation;
  requireThat(history.format === 'consumed-native-environment-historical-attestation-v1' &&
    history.currentLegacyAuthorityVerifiedByUnchangedRecordedCode === true &&
    history.ownerReviewedSourceSnapshotVerified === true &&
    history.consumedGrantIsNotNewDispatchAuthority === true &&
    history.nativeInvocations === 0 && history.publicationActions === 0 &&
    /^[a-f0-9]{40}$/.test(history.controllerRevision ?? '') &&
    json(Object.keys(history.controllerFiles ?? {}).sort()) === json([...historicalFiles].sort()) &&
    historicalFiles.every(file => /^[a-f0-9]{64}$/.test(history.controllerFiles[file])) &&
    history.configSha256 === hash(json({ ...originalConfig, stateDirectory: history.priorStateDirectory })) &&
    history.sourceRevision === auth.sourceRevision &&
    source?.authorization?.repairedRevision === auth.sourceRevision &&
    json(auth.ownerRequest) === json(source.authorization.ownerRequest) &&
    json(auth.ownerApproval) === json(source.authorization.ownerApproval) &&
    auth.unitFile === source.authorization.unitFile &&
    json(detail.files) === json(source.files) && json(detail.proposal) === json(source.proposal) &&
    detail.priorJob.workspace === history.job.workspace &&
    detail.priorJob.base_revision === history.job.base_revision &&
    json({ ...detail.priorAssignment, skillQualification: null }) ===
      json({ ...history.assignment, skillQualification: null }),
  'Historical verification preserves owner approval; it is not new dispatch authority',
  'blocked-reconciliation');
  const instruction = pinned(auth.campaignInstruction);
  const boundaries = instruction.preserveExistingBoundaries;
  requireThat(instruction.format === 'full-live-loop-user-instruction-v1' &&
    instruction.assignmentId === detail.priorJob.id &&
    instruction.approvedSourceRevision === auth.sourceRevision &&
    typeof instruction.userText === 'string' && instruction.userText.trim() &&
    typeof instruction.followUpUserText === 'string' && instruction.followUpUserText.trim() &&
    ['recollectOrReauthorExistingCandidate', 'newAuthorCheckout', 'alterSealedResults',
      'combineHistoricalPasses', 'skipBusinessAssertions',
      'productHarnessProviderOrSchemaFreezeLifted', 'publicationBeforeNewFormalFivePasses']
      .every(key => boundaries?.[key] === false),
  'A campaign requires the recorded ongoing user instruction without lifting frozen boundaries',
  'blocked-authorization');
  for (const time of [instruction.requestedAt, history.verifiedAt, auth.recordedAt])
    utc(time);
  requireThat(Date.parse(instruction.requestedAt) <= Date.parse(auth.recordedAt) &&
    Date.parse(history.verifiedAt) <= Date.parse(auth.recordedAt) &&
    Date.parse(detail.priorResult.reportedAt) <= Date.parse(auth.recordedAt) &&
    Date.parse(auth.recordedAt) <= Date.now() + 60000,
  'Campaign admission must be recorded after the sealed failure and original instruction',
  'blocked-authorization');
  const priorContinuation = JSON.parse(detail.operations.find(row =>
    row.kind === 'continued-from-validation-failure')?.detail ?? 'null');
  if (auth.batchIndex === 0) {
    requireThat(json(detail.priorJob) === json(history.job) &&
      json(detail.priorResult) === json(history.result) &&
      json(detail.operations) === json(history.operations) &&
      hash(json(priorContinuation)) === history.continuationSha256,
    'The first campaign batch must follow its exact attested consumed predecessor',
    'blocked-reconciliation');
  } else {
    requireThat(priorContinuation?.nativeCampaignRevalidation === true &&
      priorContinuation.authorization?.kind === auth.kind &&
      priorContinuation.authorization.batchIndex === auth.batchIndex - 1 &&
      priorContinuation.nextStateDirectory === detail.priorStateDirectory &&
      priorContinuation.nextAssignmentId === detail.priorJob.id &&
      priorContinuation.nextAttemptId === detail.priorJob.session_id &&
      priorContinuation.authorizationSha256 === hash(json(priorContinuation.authorization)) &&
      priorContinuation.authorization.sourceRevision === auth.sourceRevision &&
      json(priorContinuation.authorization.historicalAttestation) === json(auth.historicalAttestation) &&
      json(priorContinuation.authorization.campaignInstruction) === json(auth.campaignInstruction) &&
      json(priorContinuation.files) === json(detail.files) &&
      json(priorContinuation.proposal) === json(detail.proposal),
    'Campaign batches must follow the reserved same-source chain without forks or skipped batches',
    'blocked-reconciliation');
    if (priorContinuation.authorization.commandBudgetAdjustment)
      requireThat(json(priorContinuation.authorization.commandBudgetAdjustment) ===
        json(auth.commandBudgetAdjustment),
      'A command budget adjustment must retain its original pinned lineage', 'blocked-reconciliation');
  }
  const repo = config.repositories.find(row => row.id === detail.priorAssignment.repoId);
  const native = detail.operations.find(row => row.kind === 'validation');
  requireThat(repo?.validationGates.length === 1 &&
    repo.validationGates[0].profile === '1js-declarative-e2e-v1' &&
    auth.failure.path === detail.priorResult.validation[0].artifactRefs[0] &&
    !outside(join(detail.priorStateDirectory, 'native-validation', hash(native.id)),
      auth.nativeSummary.path) &&
    /^http:\/\/127\.0\.0\.1:[1-9][0-9]{0,4}$/.test(auth.isolatedCdpEndpoint ?? '') &&
    Number(auth.isolatedCdpEndpoint.split(':').at(-1)) <= 65535 &&
    auth.isolatedCdpEndpoint !== 'http://127.0.0.1:9222',
  'Campaign admission requires its own failed native evidence and isolated loopback browser',
  'blocked-reconciliation');
  const failure = pinned(auth.failure);
  if (auth.interruptedNativeBatch) {
    requireThat(auth.batchIndex > 0 && auth.commandBudgetAdjustment,
      'Interrupted continuation needs a separately pinned bounded Controller budget adjustment',
      'blocked-authorization');
    verifyInterruptedNativeBatch(detail, failure, pinned(auth.nativeSummary),
      repo.validationGates[0].profileSha256, pinned(auth.interruptedNativeBatch));
  } else {
    verifyNativeBusinessFailure(detail.priorJob, detail.priorResult, detail.operations,
      failure, pinned(auth.nativeSummary), repo.validationGates[0].profileSha256);
  }
  const analysis = pinned(auth.failureAnalysis);
  requireThat(analysis.format === 'native-campaign-failure-analysis-v1' &&
    analysis.previousAttemptId === detail.priorJob.session_id &&
    analysis.previousResultId === detail.priorResult.id &&
    analysis.sourceRevision === auth.sourceRevision &&
    analysis.countsTowardFormalFive === false &&
    analysis.productOrHarnessChanged === false &&
    typeof analysis.findings === 'string' && analysis.findings.trim() &&
    typeof analysis.nextBatchRationale === 'string' && analysis.nextBatchRationale.trim() &&
    Array.isArray(analysis.evidence) && analysis.evidence.length > 0 &&
    analysis.evidence.every(ref => isAbsolute(ref.path ?? '') &&
      /^[a-f0-9]{64}$/.test(ref.sha256 ?? '') && hash(readFileSync(ref.path)) === ref.sha256),
  'A subsequent complete batch requires pinned failure analysis, not unexplained blind replay',
  'blocked-reconciliation');
  const proof = pinned(auth.preflight);
  verifyPreparationPreflight(proof, detail.priorJob, detail.priorResult,
    detail.priorAssignment, detail.operations, repo.validationGates[0].profileSha256);
  requireThat(json(proof.preparation.sparseCheckoutPaths) ===
    json(nativeCampaignValidationRepository(repo, detail).sparseCheckoutPaths) &&
    [detail.priorJob.workspace, ...(failure.output.residualPaths ?? [])].every(path =>
      outside(path, proof.workspace) && outside(proof.workspace, path)),
  'A campaign batch requires fresh current preparation outside the author and failed workspace',
  'blocked-reconciliation');
}
export async function verifyPreparedNativeCampaign(config, detail, operationId, attemptId) {
  verifyNativeCampaignAuthority(config, detail);
  requireThat(await git(['rev-parse', 'HEAD']) === detail.authorization.controllerRevision &&
    !await git(['status', '--porcelain']),
  'Campaign controller must remain clean at its recorded revision', 'blocked-reconciliation');
  verifyContinuationPredecessor(detail, operationId, attemptId);
  const history = pinned(detail.authorization.historicalAttestation);
  await verifyHistoricalCode(history);
  await verifyNativeSourceSnapshot(history.originalSourceContinuation);
}
export async function prepareNativeCampaignBatch(config, ledger, id, nextConfig, nextLedger, authorization) {
  const priorRoot = realpathSync(ledger.directory), nextRoot = realpathSync(nextLedger.directory);
  requireThat(outside(priorRoot, nextRoot) && outside(nextRoot, priorRoot) &&
    realpathSync(config.stateDirectory) === priorRoot &&
    realpathSync(nextConfig.stateDirectory) === nextRoot &&
    await git(['rev-parse', 'HEAD']) === authorization.controllerRevision &&
    !await git(['status', '--porcelain']),
  'Campaign preparation requires unused separate storage and a clean recorded controller',
  'blocked-reconciliation');
  const owner = ledger.acquire('dispatch'); let nextOwner;
  try {
    nextOwner = nextLedger.acquire('dispatch');
    const state = nextLedger.status();
    requireThat(!state.jobs.length && !state.counts.length && !state.operations.length && !state.runs.length,
      'Campaign destination must be unused', 'blocked-reconciliation');
    const job = ledger.job(id), assignment = ledger.get('assignment', id);
    const results = ledger.all('workerResult').filter(row => row.assignmentId === id);
    requireThat(results.length === 1, 'Campaign admission requires exactly one sealed predecessor',
      'blocked-reconciliation');
    const operations = ledger.status().operations.filter(row => row.job_id === id);
    const history = pinned(authorization.historicalAttestation);
    const source = history.originalSourceContinuation;
    const detail = { previousConfig: config, priorStateDirectory: priorRoot,
      nextStateDirectory: nextRoot, priorJob: job, priorAssignment: assignment,
      priorResult: results[0], priorResultSha256: hash(json(results[0])), operations,
      priorOperationsSha256: hash(json(operations)), authorization,
      authorizationSha256: hash(json(authorization)), nativeSourceCorrection: true,
      nativeCampaignRevalidation: true, files: source.files, proposal: source.proposal,
      preparedAt: now() };
    verifyNativeCampaignAuthority(nextConfig, detail);
    await verifyHistoricalCode(history);
    await verifyNativeSourceSnapshot(source);
    requireCurrentAssignment(config, ledger, ledger.get('investigation', assignment.investigationId), assignment);
    const qualification = await qualifyRepositorySkill(nextConfig, assignment.repoId,
      assignment.capability, assignment.skillBindingId);
    requireThat(qualification.baseRevision === job.base_revision &&
      qualification.skillSha256 === assignment.skillQualification.skillSha256,
    'Campaign changed the qualified skill or baseline', 'blocked-reconciliation');
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
      'Campaign changed assignment identity or semantics', 'blocked-reconciliation');
      ledger.operation(operationId, id, 'validation-continuation', detail);
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
