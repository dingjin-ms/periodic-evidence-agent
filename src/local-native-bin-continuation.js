import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, json, now, requireThat, utc } from './common.js';
import { importReviewedContinuation, selectLocalValidationRoleOrigin } from './local-continuation.js';
import { verifyNativeCacheContinuation } from './local-native-cache-continuation.js';
import { verifyNativeWrapperContinuation } from './local-native-wrapper-continuation.js';
import { qualifyRepositorySkill } from './repository-skills.js';
import { nativeTemporaryDirectory } from './native-command.js';
import { command, minimalEnvironment, verifyContinuationPredecessor, verifyPreservedChange,
  requireCurrentAssignment, makePlannedImprovementAssignment } from './workers.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const pin = ref => {
  requireThat(isAbsolute(ref?.path ?? '') && hash(readFileSync(ref.path)) === ref.sha256,
    'Native bin continuation evidence changed');
  return JSON.parse(readFileSync(ref.path));
};
export const nativeBinContinuationOperationId = id => `${id}:native-bin-continuation`;
export function correctNativeWrapperToolEnvironment(profile) {
  const before = "Invoke-Checked node 'docs\\skills\\Integration-test-core\\scripts\\run-integration-tests.mjs' '--' ";
  requireThat(profile.split(before).length === 2, 'Expected exactly one plain Node native wrapper invocation');
  return profile.replace(before, before.replace('Invoke-Checked node ', 'Invoke-Checked $corepack yarn node '));
}
export function verifyNativeBinProof(proof) {
  requireThat(proof.kind === 'native-workspace-bin-resolution-proof' &&
    proof.nativeCaseInvocations === 0 && proof.modelCalls === 0 && proof.network === false &&
    proof.timeoutMs === 30000 && proof.acceptanceEvidence === false && proof.publicationEligible === false &&
    proof.before?.exitCode === 127 && proof.before.stderr.includes('command not found: gulp') &&
    !proof.before.stdout.includes('SYNTHETIC_GULP:') && proof.after?.exitCode === 0 &&
    proof.after.stdout.includes('SYNTHETIC_GULP:["build"]') &&
    proof.after.stdout.includes('SYNTHETIC_CHILD:') &&
    json(proof.after.args) === json([proof.yarn.path, 'node', ...proof.before.args]) &&
    proof.before.args[0] === proof.nativeWrapper.path && proof.before.args[1] === '--',
  'Exact offline native-wrapper tool-environment comparison required');
}
export function verifyNativeBinFailure(targeted, native, artifact, revision, name) {
  const cases = targeted.testResults?.flatMap(suite => suite.assertionResults ?? []);
  requireThat(targeted.success === true && targeted.numTotalTests === 1 && targeted.numPassedTests === 1 &&
    cases?.length === 1 && cases[0].title === name && cases[0].status === 'passed' &&
    cases[0].invocations === 1 && cases[0].numPassingAsserts === 26 &&
    native.result === 'failed' && native.exitCode === 127 && native.testScope === 'manual' &&
    native.jestResultSource === 'unavailable' && native.failedTestCaseCount === 0 &&
    native.failedTestSuiteCount === 0 && native.command?.includes('check:integration') &&
    native.command.includes('--runTestsByPath') &&
    artifact.status === 'failed' && artifact.revision === revision && artifact.output?.exitCode === 1 &&
    artifact.output.timeout === false && artifact.output.stderr.includes('command not found: gulp') &&
    artifact.telemetry.validationRevision === revision &&
    artifact.telemetry.successorNative?.initiallyAbsent === true &&
    artifact.telemetry.successorNative.revision === revision,
  'Only the exact first-leg pass and native gulp-resolution failure may continue');
}
export function verifyNativeBinContinuation(config, detail) {
  const correction = detail.nativeBinCorrection;
  requireThat(detail.authorization.kind === 'native-workspace-bin-path' &&
    detail.authorization.maxModelAttempts === 0 && correction,
  'Missing zero-model native bin correction');
  for (const ref of Object.values(detail.authorization.evidence)) pin(ref);
  const proof = pin(detail.authorization.evidence.binProof);
  verifyNativeBinProof(proof);
  for (const ref of [proof.yarn, proof.nativeWrapper])
    requireThat(hash(readFileSync(ref.path)) === ref.sha256, 'Synthetic tool source changed');
  const original = correction.priorContinuation;
  requireThat(original.authorization.kind === 'native-launcher-cache-path' &&
    original.nextAttemptId === detail.priorJob.session_id &&
    proof.predecessorAttempt === detail.priorJob.session_id &&
    proof.sourceRevision === detail.priorResult.sourceRevision,
  'Native bin correction lost its source-bound cache predecessor');
  verifyContinuationPredecessor(original, `${original.priorJob.id}:validation-continuation`, original.nextAttemptId);
  verifyNativeWrapperContinuation(correction.priorConfig, original);
  verifyNativeCacheContinuation(original);
  const previousGate = correction.priorConfig.repositories[0].validationGates[0];
  const gate = config.repositories[0].validationGates[0];
  requireThat(hash(readFileSync(gate.profilePath)) === gate.profileSha256 &&
    readFileSync(gate.profilePath, 'utf8') ===
      correctNativeWrapperToolEnvironment(readFileSync(previousGate.profilePath, 'utf8')),
  'Native wrapper may change only to the declared root Yarn tool environment');
  const comparable = structuredClone(config);
  comparable.repositories[0].validationGates[0].profilePath = previousGate.profilePath;
  comparable.repositories[0].validationGates[0].profileSha256 = previousGate.profileSha256;
  requireThat(json({ ...comparable, stateDirectory: null }) ===
    json({ ...correction.priorConfig, stateDirectory: null }), 'Native bin correction changed other configuration');
}
export async function prepareNativeBinContinuation(config, ledger, id, nextConfig, nextLedger, authorization, proposal) {
  const priorRoot = realpathSync(ledger.directory), nextRoot = realpathSync(nextLedger.directory);
  requireThat([relative(priorRoot, nextRoot), relative(nextRoot, priorRoot)].every(path => path.startsWith('..')) &&
    realpathSync(config.stateDirectory) === priorRoot && realpathSync(nextConfig.stateDirectory) === nextRoot &&
    !nextRoot.split(/[\\/]/).some(part => part.startsWith('.')) && config.repositories.length === 1 &&
    nextConfig.repositories.length === 1 && config.repositories[0].validationGates.length === 1,
  'Native bin continuation requires separate private state and one unchanged repository/gate');
  const refs = authorization?.evidence;
  requireThat(authorization?.kind === 'native-workspace-bin-path' && authorization.approved === true &&
    authorization.authorizedBy === 'user' && authorization.scope === 'future-local-runs' &&
    authorization.maxModelAttempts === 0 && authorization.previousAssignmentId === id &&
    authorization.nextConfigSha256 === hash(json(nextConfig)) && authorization.proposalSha256 === hash(json(proposal)) &&
    nextConfig.limits.maxValidationRepairRounds === 0 && nextConfig.limits.maxValidationInfrastructureRetries === 0 &&
    nextConfig.limits.maxAiCreditsPerSession <= 100 && refs &&
    Object.keys(refs).sort().join(',') === 'binProof,terminalReport,userAuthorization' &&
    pin(refs.userAuthorization).userResponse === 'all runs authorized',
  'Exact source/config/proposal-bound zero-model bin correction authority required');
  utc(authorization.recordedAt);
  const report = pin(refs.terminalReport), perCase = pin(report.perCase);
  requireThat(report.kind === 'controlled-native-cache-continuation-terminal' &&
    report.publication.remoteBranchPresent === false && report.publication.matchingPRsAcrossAllStatuses === 0 &&
    report.processTermination.activePreTerminalProcesses.length === 0 && report.nativeRuns.length === 1 &&
    report.nativeArtifacts.length === 1 && perCase.legs[1].verdict === 'not-established',
  'Native bin continuation requires a sealed, drained and unpublished native cache attempt');
  const targeted = pin(perCase.legs[0]), native = pin(report.nativeRuns[0]), artifact = pin(report.nativeArtifacts[0]);
  verifyNativeBinFailure(targeted, native, artifact, authorization.sourceRevision, perCase.legs[0].cases[0].title);
  requireThat(!existsSync(native.jestResultsFile) && !existsSync(native.unitJestResultsFile) &&
    native.runFile === report.nativeRuns[0].path &&
    dirname(native.runFile) === join(artifact.telemetry.successorNative.temporaryDirectory, 'officeagent-integration-runs') &&
    Date.parse(authorization.recordedAt) >= Date.parse(report.reportedAt) &&
    Date.parse(authorization.recordedAt) <= Date.now() + 60000 &&
    (await command('git', ['rev-parse', 'HEAD'], root, 30000, minimalEnvironment())).stdout.trim() === authorization.controllerRevision &&
    !(await command('git', ['status', '--porcelain'], root, 30000, minimalEnvironment())).stdout.trim(),
  'Native bin continuation requires no second case and a clean terminal-bound controller');
  nativeTemporaryDirectory(nextRoot, 'placement-preflight');
  const owner = ledger.acquire('dispatch'); let nextOwner;
  try {
    nextOwner = nextLedger.acquire('dispatch');
    const state = nextLedger.status();
    requireThat(!state.jobs.length && !state.counts.length && !state.operations.length && !state.runs.length,
      'Native bin correction requires an unused ledger');
    const job = ledger.job(id), assignment = ledger.get('assignment', id);
    const results = ledger.all('workerResult').filter(result => result.assignmentId === id), result = results[0];
    const operations = ledger.status().operations.filter(row => row.job_id === id);
    requireThat(job?.state === 'blocked' && job.session_id === authorization.previousAttemptId &&
      result?.sourceRevision === authorization.sourceRevision && report.assignmentId === id &&
      results.length === 1 && json(result) === json(report.workerResult) &&
      result.toolUsage.used === 0 && result.toolUsage.rounds.length === 0 && result.validationAttempts.length === 1 &&
      json(operations.map(row => ({ ...row, detail: JSON.parse(row.detail) }))) === json(report.operations),
    'Native bin correction cannot replay or reinterpret predecessor state');
    for (const ref of report.rawArtifacts)
      requireThat(hash(readFileSync(ref.path)) === ref.sha256, 'Sealed native cache artifact changed');
    const row = operations.find(row => row.kind === 'continued-from-validation-failure');
    const original = row && JSON.parse(row.detail);
    requireThat(row?.state === 'prepared' && original.authorization.kind === 'native-launcher-cache-path',
      'Only the first cache correction can take the bin-resolution successor');
    requireThat(native.command.includes(original.nativeWrapperCorrection.testPath.replace(/^agents\/excel-agent\//, '')),
      'Native bin failure did not select the preserved case');
    const files = await verifyPreservedChange(config, assignment, job, result, proposal);
    requireCurrentAssignment(config, ledger, ledger.get('investigation', assignment.investigationId), assignment);
    selectLocalValidationRoleOrigin(config, ledger, id);
    const qualification = await qualifyRepositorySkill(nextConfig, assignment.repoId, assignment.capability, assignment.skillBindingId);
    requireThat(qualification.baseRevision === job.base_revision &&
      qualification.skillSha256 === assignment.skillQualification.skillSha256, 'Native skill changed');
    const detail = { priorStateDirectory: priorRoot, nextStateDirectory: nextRoot,
      priorAssignment: assignment, priorJob: job, priorResult: result, proposal, files,
      priorResultSha256: hash(json(result)), priorOperationsSha256: hash(json(operations)),
      authorization, authorizationSha256: hash(json(authorization)), qualification, preparedAt: now(),
      nativeWrapperCorrection: original.nativeWrapperCorrection,
      nativeBinCorrection: { priorConfig: config, priorContinuation: original } };
    verifyNativeBinContinuation(nextConfig, detail);
    const operationId = nativeBinContinuationOperationId(id);
    ledger.operation(operationId, id, 'validation-continuation', detail);
    let rebuilt;
    nextLedger.transaction(() => {
      importReviewedContinuation(nextConfig, ledger, nextLedger, assignment, qualification,
        'native-bin-continuation:captured-evidence-import');
      rebuilt = makePlannedImprovementAssignment(nextConfig, nextLedger,
        ledger.get('investigation', assignment.investigationId), assignment.testCoveragePlanId,
        assignment.requestedOutcome, assignment.testCoveragePlanVersion);
      requireThat(json({ ...assignment, id: null, skillQualification: null }) ===
        json({ ...rebuilt, id: null, skillQualification: null }), 'Native bin correction changed assignment semantics');
      const nextJob = nextLedger.prepare(rebuilt, { bucket: operationId, maxNew: 1 });
      Object.assign(detail, { nextAttemptId: nextJob.session_id, nextAssignmentId: rebuilt.id });
      nextLedger.operation(operationId, rebuilt.id, 'continued-from-validation-failure', detail);
      nextLedger.finishOperation(operationId, 'prepared', detail);
    });
    ledger.finishOperation(operationId, 'prepared', detail);
    return { assignment: rebuilt, job: nextLedger.job(rebuilt.id), audit: detail };
  } finally { if (nextOwner) nextLedger.release('dispatch', nextOwner); ledger.release('dispatch', owner); }
}
