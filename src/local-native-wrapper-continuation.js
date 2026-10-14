import { readFileSync, realpathSync, existsSync } from 'node:fs';
import { isAbsolute, relative, resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { hash, json, now, requireThat, utc } from './common.js';
import { importReviewedContinuation, selectLocalValidationRoleOrigin } from './local-continuation.js';
import { qualifyRepositorySkill } from './repository-skills.js';
import { command, minimalEnvironment, makePlannedImprovementAssignment,
  requireCurrentAssignment, verifyPreservedChange } from './workers.js';
import { verifySetupOnlyChange, verifyTransformedSetupOrder } from './local-authoring-successor.js';
import { nativeWrapperResultName } from './local-launcher-diagnostic.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const pin = reference => {
  requireThat(isAbsolute(reference?.path ?? '') && /^[a-f0-9]{64}$/.test(reference?.sha256 ?? '') &&
    hash(readFileSync(reference.path)) === reference.sha256, 'Native wrapper evidence changed');
  return JSON.parse(readFileSync(reference.path));
};
const separate = (a, b) => relative(a, b).startsWith('..') || isAbsolute(relative(a, b));

export function correctNativeWrapperSeparator(profile) {
  const before = "Invoke-Checked node 'docs\\skills\\Integration-test-core\\scripts\\run-integration-tests.mjs' -- ";
  const after = before.replace(' -- ', " '--' ");
  requireThat(profile.split(before).length === 2 && !profile.includes(after),
    'Only the single unquoted PowerShell native-wrapper separator may change');
  return profile.replace(before, after);
}

export function verifyNativeWrapperFailure(targeted, native, artifact, revision, name) {
  const cases = targeted.testResults?.flatMap(suite => suite.assertionResults ?? []);
  requireThat(targeted.success === true && targeted.numTotalTests === 1 && targeted.numPassedTests === 1 &&
    cases?.length === 1 && cases[0].title === name && cases[0].status === 'passed' &&
    cases[0].invocations === 1 && cases[0].numPassingAsserts === 26 &&
    native.result === 'harness_failure' && native.command?.length === 0 &&
    native.harnessFailureCount === 1 && native.harnessFailures?.length === 1 &&
    native.harnessFailures[0].stage === 'missing_command' && native.durationMs === 0 &&
    native.exitCode === 1 && native.jestResultSource === 'pending' &&
    native.failedTestCaseCount === 0 && native.failedTestSuiteCount === 0 &&
    artifact.status === 'failed' && artifact.revision === revision && artifact.output?.exitCode === 1 &&
    artifact.output.stderr.includes('Missing required integration command.') &&
    artifact.telemetry.validationRevision === revision &&
    artifact.telemetry.successorNative?.initiallyAbsent === true &&
    artifact.telemetry.successorNative.revision === revision,
  'Only a passed exact first leg followed by the native missing-command refusal may continue');
}

export function verifyNativeWrapperContinuation(config, detail) {
  const correction = detail.nativeWrapperCorrection;
  requireThat(['native-wrapper-separator', 'native-launcher-cache-path'].includes(detail.authorization.kind) && correction &&
    detail.authorization.maxModelAttempts === 0, 'Missing zero-model wrapper correction contract');
  for (const ref of correction.references) pin(ref);
  const gate = config.repositories.find(repo => repo.id === detail.priorAssignment.repoId)
    ?.validationGates.find(gate => gate.id === correction.gateId);
  requireThat(gate?.profileSha256 === correction.newProfileSha256 &&
    hash(readFileSync(gate.profilePath)) === correction.newProfileSha256 &&
    hash(readFileSync(correction.oldProfilePath)) === correction.oldProfileSha256 &&
    readFileSync(gate.profilePath, 'utf8') ===
      correctNativeWrapperSeparator(readFileSync(correction.oldProfilePath, 'utf8')),
  'Native wrapper profile correction changed after preparation');
}

export async function prepareNativeWrapperContinuation(config, ledger, id, nextConfig,
  nextLedger, authorization, proposal) {
  const priorRoot = realpathSync(ledger.directory), nextRoot = realpathSync(nextLedger.directory);
  requireThat(separate(priorRoot, nextRoot) && separate(nextRoot, priorRoot) &&
    realpathSync(config.stateDirectory) === priorRoot && realpathSync(nextConfig.stateDirectory) === nextRoot &&
    !nextRoot.split(/[\\/]/).some(part => part.startsWith('.')),
  'Native wrapper continuation requires fresh private non-dot placement');
  requireThat(authorization?.approved === true && authorization.authorizedBy === 'user' &&
    authorization.scope === 'future-local-runs' && authorization.maxModelAttempts === 0 &&
    authorization.previousAssignmentId === id && authorization.nextConfigSha256 === hash(json(nextConfig)) &&
    authorization.proposalSha256 === hash(json(proposal)) &&
    nextConfig.limits.maxValidationRepairRounds === 0 && nextConfig.limits.maxValidationInfrastructureRetries === 0 &&
    nextConfig.limits.maxAiCreditsPerSession <= 100,
  'Native wrapper correction requires exact source/config/proposal-bound zero-model authority');
  utc(authorization.authorizedAt); utc(authorization.recordedAt);
  requireThat(Date.parse(authorization.authorizedAt) <= Date.parse(authorization.recordedAt) &&
    Date.parse(authorization.recordedAt) <= Date.now() + 60000 &&
    (await command('git', ['rev-parse', 'HEAD'], root, 30000, minimalEnvironment())).stdout.trim() ===
      authorization.controllerRevision &&
    !(await command('git', ['status', '--porcelain'], root, 30000, minimalEnvironment())).stdout.trim(),
  'Native wrapper correction requires its clean pinned controller');
  const refs = authorization.evidence;
  requireThat(refs && Object.keys(refs).sort().join(',') ===
    'nativeArtifact,nativeFailure,targetedResults,terminalReport,transportProof,userAuthorization',
  'Exact native wrapper evidence references required');
  const grant = pin(refs.userAuthorization), report = pin(refs.terminalReport);
  const targeted = pin(refs.targetedResults), native = pin(refs.nativeFailure);
  const artifact = pin(refs.nativeArtifact), transport = pin(refs.transportProof);
  requireThat(grant.userResponse === 'all runs authorized' &&
    transport.kind === 'native-wrapper-separator-transport-proof' &&
    transport.nativeCaseInvocations === 0 && transport.modelInvoked === false &&
    transport.beforeArgv[0] !== '--' && transport.afterArgv[0] === '--' &&
    json(transport.afterArgv.slice(1)) === json(transport.beforeArgv) &&
    transport.nativeParser.beforeCommand.length === 0 &&
    json(transport.nativeParser.afterCommand) === json(transport.beforeArgv),
  'Logging-only child/parser proof must establish the precise separator correction');
  const owner = ledger.acquire('dispatch');
  let nextOwner;
  try {
    nextOwner = nextLedger.acquire('dispatch');
    const state = nextLedger.status();
    requireThat(!state.jobs.length && !state.counts.length && !state.operations.length && !state.runs.length,
      'Native wrapper successor cannot reuse a ledger');
    const job = ledger.job(id), assignment = ledger.get('assignment', id);
    const results = ledger.all('workerResult').filter(result => result.assignmentId === id), result = results[0];
    const operations = ledger.status().operations.filter(row => row.job_id === id);
    const authored = operations.find(row => row.kind === 'authoring-successor-from-diagnostic');
    const trace = authored && JSON.parse(authored.detail);
    requireThat(job?.state === 'blocked' && assignment?.execution === 'local' &&
      authored?.state === 'prepared' && trace?.credentialAdmission &&
      trace.nextAttemptId === job.session_id && trace.inputSha256 === hash(json(trace.input)) &&
      results.length === 1 && result.attemptId === authorization.previousAttemptId &&
      result.sourceRevision === authorization.sourceRevision && json(result) === json(report.workerResult) &&
      result.toolUsage.rounds.length === 1 && result.toolUsage.rounds[0].status === 'completed' &&
      result.toolUsage.byTool.pilot_write > 0 && result.toolUsage.byTool.pilot_finish === 1 &&
      result.validation.length === 1 && result.validationAttempts.length === 1 &&
      result.validation[0].artifactRefs.length === 1 &&
      result.validation[0].artifactRefs[0] === refs.nativeArtifact.path &&
      result.draftPR === null && report.publication.remoteBranchPresent === false &&
      report.publication.matchingPRsAcrossAllStatuses === 0 &&
      report.processTermination.activePreTerminalProcesses.length === 0 &&
      Date.parse(authorization.recordedAt) >= Date.parse(report.reportedAt) &&
      operations.length === 4 && operations.every(row =>
        ['authoring-successor-from-diagnostic', 'role-authoring-execution', 'commit', 'validation'].includes(row.kind)) &&
      json(operations.map(row => ({ ...row, detail: JSON.parse(row.detail) }))) === json(report.operations) &&
      operations.filter(row => row.kind === 'commit' && row.state === 'completed').length === 1,
    'Wrapper continuation requires the exact sealed first authoring successor, with no later activity');
    for (const ref of report.rawArtifacts)
      requireThat(hash(readFileSync(ref.path)) === ref.sha256, 'Sealed native predecessor raw evidence changed');
    for (const ref of [trace.input.diagnosticReceipt, trace.input.diagnosticReport,
      trace.input.sourceReview, trace.input.userAuthorization,
      trace.credentialAdmission.terminalReport, trace.credentialAdmission.authDiagnosis]) pin(ref);
    const testPath = trace.testPath;
    const repo = config.repositories.find(repo => repo.id === assignment.repoId);
    const gate = repo.validationGates[0], nextGate = nextConfig.repositories.find(repo =>
      repo.id === assignment.repoId)?.validationGates[0];
    verifyNativeWrapperFailure(targeted, native, artifact, result.sourceRevision,
      report.perCase ? pin(report.perCase).legs[0].cases[0].title : '');
    requireThat(refs.nativeFailure.path === native.runFile &&
      dirname(native.runFile) === join(artifact.telemetry.successorNative.temporaryDirectory,
        'officeagent-integration-runs') &&
      !existsSync(native.jestResultsFile) && !existsSync(native.unitJestResultsFile) &&
      !existsSync(join(dirname(artifact.telemetry.preparedReceipt), 'validation-profiles',
        nativeWrapperResultName(readFileSync(gate.profilePath, 'utf8')))) &&
      report.perCase && pin(report.perCase).legs[0].sha256 === refs.targetedResults.sha256,
    'Native missing-command result is not bound to the failed child or contains case execution');
    requireThat(repo.validationGates.length === 1 && nextGate &&
      transport.oldProfileSha256 === gate.profileSha256 &&
      hash(readFileSync(gate.profilePath)) === gate.profileSha256 &&
      hash(readFileSync(nextGate.profilePath)) === nextGate.profileSha256 &&
      readFileSync(nextGate.profilePath, 'utf8') ===
        correctNativeWrapperSeparator(readFileSync(gate.profilePath, 'utf8')),
    'Only literal separator quoting may change in the native profile');
    const comparable = structuredClone(nextConfig);
    const compareGate = comparable.repositories.find(repo => repo.id === assignment.repoId).validationGates[0];
    compareGate.profilePath = gate.profilePath; compareGate.profileSha256 = gate.profileSha256;
    requireThat(json({ ...config, stateDirectory: null }) === json({ ...comparable, stateDirectory: null }),
      'Wrapper correction cannot alter any other configuration or gate field');
    const parserPath = join(job.workspace, 'docs', 'skills', 'Integration-test-core', 'scripts', 'run-integration-tests.mjs');
    requireThat(transport.nativeParser.path === parserPath &&
      hash(readFileSync(parserPath)) === transport.nativeParser.sha256,
    'Transport proof used a different native parser');
    const files = await verifyPreservedChange(config, assignment, job, result, proposal);
    verifySetupOnlyChange(readFileSync(join(repo.referenceCheckout, testPath), 'utf8'),
      readFileSync(join(job.workspace, testPath), 'utf8'));
    for (const proof of transport.emittedImportProofs) {
      requireThat(hash(readFileSync(proof.path)) === proof.sha256 &&
        relative(artifact.telemetry.successorNative.temporaryDirectory, proof.path).startsWith('..') === false,
      'Prior emitted import proof changed');
      verifyTransformedSetupOrder(readFileSync(proof.path, 'utf8'));
    }
    requireThat(transport.emittedImportProofs.length > 0, 'Prior executed runtime import proof is missing');
    const investigation = ledger.get('investigation', assignment.investigationId);
    requireCurrentAssignment(config, ledger, investigation, assignment);
    selectLocalValidationRoleOrigin(config, ledger, id);
    const qualification = await qualifyRepositorySkill(nextConfig, assignment.repoId,
      assignment.capability, assignment.skillBindingId);
    requireThat(qualification.baseRevision === job.base_revision &&
      qualification.skillSha256 === assignment.skillQualification.skillSha256,
    'Wrapper correction changes the native skill or authoring base');
    const detail = { priorStateDirectory: priorRoot, nextStateDirectory: nextRoot,
      priorAssignment: assignment, priorJob: job, priorResult: result, proposal, files,
      priorResultSha256: hash(json(result)), priorOperationsSha256: hash(json(operations)),
      authorization, authorizationSha256: hash(json(authorization)), qualification, preparedAt: now(),
      nativeWrapperCorrection: { references: Object.values(refs), gateId: gate.id, testPath,
        oldProfilePath: gate.profilePath, oldProfileSha256: gate.profileSha256,
        newProfileSha256: nextGate.profileSha256 } };
    const operationId = `${id}:validation-continuation`;
    ledger.operation(operationId, id, 'validation-continuation', detail);
    let rebuilt;
    nextLedger.transaction(() => {
      importReviewedContinuation(nextConfig, ledger, nextLedger, assignment, qualification,
        'native-wrapper-continuation:captured-evidence-import');
      rebuilt = makePlannedImprovementAssignment(nextConfig, nextLedger, investigation,
        assignment.testCoveragePlanId, assignment.requestedOutcome, assignment.testCoveragePlanVersion);
      requireThat(json({ ...assignment, id: null, skillQualification: null }) ===
        json({ ...rebuilt, id: null, skillQualification: null }), 'Wrapper correction changed assignment semantics');
      const nextJob = nextLedger.prepare(rebuilt, { bucket: operationId, maxNew: 1 });
      Object.assign(detail, { nextAttemptId: nextJob.session_id, nextAssignmentId: rebuilt.id });
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
