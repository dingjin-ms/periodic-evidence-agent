import { readFileSync, realpathSync } from 'node:fs';
import { dirname, isAbsolute, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, json, now, requireThat, utc } from './common.js';
import { Ledger } from './ledger.js';
import { importReviewedContinuation, selectLocalValidationRoleOrigin } from './local-continuation.js';
import { verifyLauncherTimeout } from './local-launcher-diagnostic.js';
import { verifyNativeWrapperContinuation } from './local-native-wrapper-continuation.js';
import { qualifyRepositorySkill } from './repository-skills.js';
import { command, minimalEnvironment, verifyContinuationPredecessor, verifyPreservedChange,
  requireCurrentAssignment, makePlannedImprovementAssignment } from './workers.js';
import { nativeTemporaryDirectory } from './native-command.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const pin = ref => {
  requireThat(isAbsolute(ref?.path ?? '') && hash(readFileSync(ref.path)) === ref.sha256,
    'Native cache continuation evidence changed');
  return JSON.parse(readFileSync(ref.path));
};
export function verifyCompileCacheProof(proof) {
  const [blocked, prior, fixed] = proof.syntheticObservations ?? [];
  requireThat(proof.kind === 'native-node-compile-cache-path-diagnosis' &&
    proof.platform === 'win32' && proof.nodeVersion === 'v24.19.0' &&
    proof.nativeCaseInvocations === 0 && proof.modelCalls === 0 &&
    proof.acceptanceEvidence === false && proof.publicationEligible === false &&
    blocked?.longTemporaryLength === 224 && blocked.first.killed === true &&
    blocked.first.stdout.trim() === 'before-cache' && blocked.first.stderr === '' &&
    prior?.priorPassingTemporaryLength === 230 && prior.prior.stdout.includes('"status":0') &&
    fixed?.temporaryPathLength <= 180 && fixed.cache.status === 1,
  'Native cache correction requires the isolated exact Node threshold reproduction, not a native pass');
}
export function verifyNativeCacheContinuation(detail) {
  const correction = detail.nativeCacheCorrection;
  requireThat(detail.authorization.kind === 'native-launcher-cache-path' && correction,
    'Missing source-bound native cache correction');
  const proof = pin(correction.diagnosis);
  verifyCompileCacheProof(proof);
  const terminal = pin(proof.terminal), diagnostic = pin(proof.diagnosticReceipt);
  requireThat(terminal.kind === 'sealed-native-launcher-diagnostic' &&
    terminal.sourceRevision === detail.priorResult.sourceRevision &&
    terminal.activeOwnedProcesses.length === 0 &&
    json(terminal.predecessor) === json(correction.terminalReport) &&
    json(terminal.receipt) === json(proof.diagnosticReceipt) &&
    diagnostic.input.previousAssignmentId === detail.priorJob.id &&
    diagnostic.sourceRevision === detail.priorResult.sourceRevision &&
    diagnostic.outcome === 'diagnostic-failed' && diagnostic.timedOut === true &&
    diagnostic.firstLegCommandInvocations === 1 && diagnostic.modelCalls === 0 &&
    diagnostic.newCommits === 0 && diagnostic.acceptanceEvidence === false &&
    diagnostic.publicationEligible === false && diagnostic.method.timeoutMs === 60000 &&
    pin(terminal.processTermination).processes.length === 0,
  'Native cache continuation requires its sealed, drained diagnostic and unchanged revision');
  for (const ref of [...diagnostic.artifacts, proof.rawSyntheticResults, proof.reproductionTest,
    proof.correction, terminal.corepackEntry])
    requireThat(hash(readFileSync(ref.path)) === ref.sha256, 'Cache diagnosis raw source or output changed');
  const ledger = new Ledger(dirname(proof.diagnosticReceipt.path), { readOnly: true });
  try {
    const row = ledger.db.prepare('SELECT * FROM operations WHERE id=?').get(diagnostic.diagnosticId);
    requireThat(row?.kind === 'local-launcher-diagnostic' && row.state === 'completed' &&
      json(JSON.parse(row.detail)) === json({ ...diagnostic, receipt: proof.diagnosticReceipt }),
    'Cache diagnosis is not the recorded completed diagnostic operation');
  } finally { ledger.close(); }
}

export async function prepareNativeCacheContinuation(config, ledger, id, nextConfig, nextLedger, authorization, proposal) {
  const priorRoot = realpathSync(ledger.directory), nextRoot = realpathSync(nextLedger.directory);
  requireThat([relative(priorRoot, nextRoot), relative(nextRoot, priorRoot)].every(path => path.startsWith('..')) &&
    realpathSync(config.stateDirectory) === priorRoot && realpathSync(nextConfig.stateDirectory) === nextRoot &&
    !nextRoot.split(/[\\/]/).some(part => part.startsWith('.')) &&
    json({ ...config, stateDirectory: null }) === json({ ...nextConfig, stateDirectory: null }),
  'Cache correction changes only fresh private state placement, not native configuration');
  const refs = authorization?.evidence;
  requireThat(authorization?.kind === 'native-launcher-cache-path' && authorization.approved === true &&
    authorization.authorizedBy === 'user' && authorization.scope === 'future-local-runs' &&
    authorization.maxModelAttempts === 0 && authorization.previousAssignmentId === id &&
    authorization.nextConfigSha256 === hash(json(nextConfig)) &&
    authorization.proposalSha256 === hash(json(proposal)) &&
    nextConfig.limits.maxValidationRepairRounds === 0 && nextConfig.limits.maxValidationInfrastructureRetries === 0 &&
    nextConfig.limits.maxAiCreditsPerSession <= 100 &&
    refs && Object.keys(refs).sort().join(',') === 'cacheDiagnosis,terminalReport,userAuthorization',
  'Exact zero-model cache continuation authority required');
  requireThat(pin(refs.userAuthorization).userResponse === 'all runs authorized', 'All-runs user authority required');
  utc(authorization.recordedAt);
  const report = pin(refs.terminalReport), artifact = pin(report.nativeArtifacts[0]);
  verifyLauncherTimeout(report, artifact);
  requireThat(Date.parse(authorization.recordedAt) >= Date.parse(report.reportedAt) &&
    Date.parse(authorization.recordedAt) <= Date.now() + 60000 &&
    (await command('git', ['rev-parse', 'HEAD'], root, 30000, minimalEnvironment())).stdout.trim() === authorization.controllerRevision &&
    !(await command('git', ['status', '--porcelain'], root, 30000, minimalEnvironment())).stdout.trim(),
  'Cache continuation requires a clean pinned controller and terminal-bound authorization');
  nativeTemporaryDirectory(nextRoot, 'placement-preflight');
  const owner = ledger.acquire('dispatch'); let nextOwner;
  try {
    nextOwner = nextLedger.acquire('dispatch');
    const state = nextLedger.status();
    requireThat(!state.jobs.length && !state.counts.length && !state.operations.length && !state.runs.length,
      'Cache continuation requires an unused ledger');
    const job = ledger.job(id), assignment = ledger.get('assignment', id);
    const results = ledger.all('workerResult').filter(result => result.assignmentId === id), result = results[0];
    const operations = ledger.status().operations.filter(row => row.job_id === id);
    requireThat(job?.state === 'blocked' && job.session_id === authorization.previousAttemptId &&
      result?.sourceRevision === authorization.sourceRevision && report.assignmentId === id &&
      results.length === 1 && json(result) === json(report.workerResult) &&
      json(operations.map(row => ({ ...row, detail: JSON.parse(row.detail) }))) === json(report.operations),
    'Cache continuation cannot replay or reinterpret a changed predecessor');
    for (const ref of report.rawArtifacts) requireThat(hash(readFileSync(ref.path)) === ref.sha256,
      'Sealed timeout raw artifacts changed');
    const row = operations.find(row => row.kind === 'continued-from-validation-failure');
    const original = row && JSON.parse(row.detail);
    requireThat(row?.state === 'prepared' && original.authorization.kind === 'native-wrapper-separator',
      'Only the first measured native-wrapper timeout may take this cache correction');
    verifyContinuationPredecessor(original, row.id, job.session_id);
    verifyNativeWrapperContinuation(config, original);
    const files = await verifyPreservedChange(config, assignment, job, result, proposal);
    requireCurrentAssignment(config, ledger, ledger.get('investigation', assignment.investigationId), assignment);
    selectLocalValidationRoleOrigin(config, ledger, id);
    const qualification = await qualifyRepositorySkill(nextConfig, assignment.repoId, assignment.capability, assignment.skillBindingId);
    requireThat(qualification.baseRevision === job.base_revision &&
      qualification.skillSha256 === assignment.skillQualification.skillSha256, 'Native skill qualification changed');
    const detail = { priorStateDirectory: priorRoot, nextStateDirectory: nextRoot,
      priorAssignment: assignment, priorJob: job, priorResult: result, proposal, files,
      priorResultSha256: hash(json(result)), priorOperationsSha256: hash(json(operations)),
      authorization, authorizationSha256: hash(json(authorization)), qualification, preparedAt: now(),
      nativeWrapperCorrection: original.nativeWrapperCorrection,
      nativeCacheCorrection: { diagnosis: refs.cacheDiagnosis, terminalReport: refs.terminalReport } };
    verifyNativeCacheContinuation(detail);
    const operationId = `${id}:validation-continuation`;
    ledger.operation(operationId, id, 'validation-continuation', detail);
    let rebuilt;
    nextLedger.transaction(() => {
      importReviewedContinuation(nextConfig, ledger, nextLedger, assignment, qualification,
        'native-cache-continuation:captured-evidence-import');
      rebuilt = makePlannedImprovementAssignment(nextConfig, nextLedger,
        ledger.get('investigation', assignment.investigationId), assignment.testCoveragePlanId,
        assignment.requestedOutcome, assignment.testCoveragePlanVersion);
      requireThat(json({ ...assignment, id: null, skillQualification: null }) ===
        json({ ...rebuilt, id: null, skillQualification: null }), 'Cache correction changed assignment semantics');
      const nextJob = nextLedger.prepare(rebuilt, { bucket: operationId, maxNew: 1 });
      Object.assign(detail, { nextAttemptId: nextJob.session_id, nextAssignmentId: rebuilt.id });
      nextLedger.operation(operationId, rebuilt.id, 'continued-from-validation-failure', detail);
      nextLedger.finishOperation(operationId, 'prepared', detail);
    });
    ledger.finishOperation(operationId, 'prepared', detail);
    return { assignment: rebuilt, job: nextLedger.job(rebuilt.id), audit: detail };
  } finally { if (nextOwner) nextLedger.release('dispatch', nextOwner); ledger.release('dispatch', owner); }
}
