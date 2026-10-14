import { readFileSync, realpathSync, readdirSync } from 'node:fs';
import { basename, isAbsolute, join, resolve, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configAt, hash, json, now, requireThat, safeError, utc } from './common.js';
import { Ledger } from './ledger.js';
import { inspectCompletedLocalDiagnostic } from './local-diagnostic.js';
import { importReviewedContinuation } from './local-continuation.js';
import { recordTestCoveragePlan } from './improvements.js';
import { pinSkillQualification, qualifyRepositorySkill, verifyRepositorySkillWorkspace } from './repository-skills.js';
import { command, dispatchRecordedAuthoringSuccessor, makePlannedImprovementAssignment,
  minimalEnvironment } from './workers.js';
import { roleExecutionIdentity } from './role-replay.js';

const root = fileURLToPath(new URL('..', import.meta.url));
const pin = reference => {
  requireThat(isAbsolute(reference?.path ?? '') && /^[a-f0-9]{64}$/.test(reference?.sha256 ?? '') &&
    hash(readFileSync(reference.path)) === reference.sha256, 'Authoring successor artifact changed');
  return JSON.parse(readFileSync(reference.path));
};
const separate = (a, b) => {
  const part = relative(resolve(a), resolve(b));
  return part.startsWith('..') || isAbsolute(part);
};

export function verifySetupOnlyChange(before, after) {
  const normalize = text => text.replaceAll('\r\n', '\n');
  before = normalize(before);
  after = normalize(after);
  const suites = before.match(/^describe\('[^'\r\n]+', \(\) => \{$/gm);
  requireThat(suites?.length === 1, 'Authoring successor requires one exact top-level behavioral suite');
  const marker = suites[0];
  requireThat(before.split(marker).length === 2 && after.split(marker).length === 2 &&
    before.slice(before.indexOf(marker)) === after.slice(after.indexOf(marker)),
  'Authoring successor must preserve the entire behavioral suite and its assertions');
  const prefix = before.slice(0, before.indexOf(marker));
  const added = after.slice(0, after.indexOf(marker));
  const statement = "import '../../../../src/excel-agent';";
  requireThat(!prefix.includes(statement) && added.split(statement).length === 2 &&
    added.indexOf(statement) > added.indexOf('}));'),
  'Authoring successor permits only the real SUT import after mock registration');
  const withoutImport = added.replace(statement, '');
  const significant = text => text.split('\n').filter(line => line.trim()).join('\n');
  requireThat(significant(withoutImport) === significant(prefix),
    'Authoring successor changed setup beyond the single real SUT import');
}

export function verifyTransformedSetupOrder(code) {
  const setup = code.indexOf('require("../../../integration-harness/runtime/setup-officeagent-mocks");');
  const mock = code.indexOf("jest.mock('fs/promises'");
  const runtime = code.indexOf('require("../../../../src/excel-agent");');
  const suites = [...code.matchAll(/^describe\('[^'\r\n]+', \(\) => \{/gm)];
  requireThat(suites.length === 1, 'Emitted native test must retain one top-level behavioral suite');
  const suite = suites[0].index;
  requireThat(setup >= 0 && mock >= 0 && runtime > setup && runtime > mock && suite > runtime &&
    /^require\("\.\.\/\.\.\/\.\.\/\.\.\/src\/excel-agent"\);$/m.test(code),
  'Emitted native test must execute the real SUT import after mocks and before suite definition');
}

export function verifySuccessorNativeEvidence(config, ledger, id, revision, validation, detail) {
  detail ??= JSON.parse(ledger.status().operations.find(row =>
    row.job_id === id && row.kind === 'authoring-successor-from-diagnostic').detail);
  const proofs = [];
  for (const gate of validation) {
    requireThat(gate.status === 'passed' && gate.sourceRevision === revision,
      'Authoring successor requires passing native evidence at the changed revision');
    const artifact = JSON.parse(readFileSync(gate.artifactRefs.at(-1)));
    const fresh = artifact.telemetry?.successorNative;
    const relativeTemp = fresh && relative(join(config.stateDirectory, 'nt'), fresh.temporaryDirectory);
    requireThat(fresh?.initiallyAbsent === true && fresh.revision === revision && relativeTemp &&
      !relativeTemp.startsWith('..') && !isAbsolute(relativeTemp),
    'Authoring successor native cache provenance is missing');
    const candidates = [];
    const transformPrefix = `${basename(detail.testPath).replace(/\.[^.]+$/, '').replace(/\W/g, '')}_`;
    const visit = directory => {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) visit(path);
        else if (entry.isFile() && !entry.name.endsWith('.map') &&
          entry.name.startsWith(transformPrefix)) candidates.push(path);
      }
    };
    visit(fresh.temporaryDirectory);
    requireThat(candidates.length > 0, 'Native transformed authored test is missing');
    for (const path of candidates) {
      const bytes = readFileSync(path);
      verifyTransformedSetupOrder(bytes.toString('utf8'));
      proofs.push({ path, sha256: hash(bytes), revision, testPath: detail.testPath });
    }
  }
  ledger.operation(`${id}:native-setup-transform`, id, 'native-setup-transform', { revision, proofs });
  ledger.finishOperation(`${id}:native-setup-transform`, 'verified', { revision, proofs,
    scope: 'Actual emitted native code; no extra case invocation or diagnostic acceptance' });
}

function coldLoadEvidence(result) {
  const events = readFileSync(result.tracePath, 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  const time = point => {
    const matches = events.filter(event => event.point === point);
    requireThat(matches.length === 1 && /^\d+$/.test(matches[0].hrtime),
      'Required diagnostic timing point is missing or ambiguous');
    return BigInt(matches[0].hrtime);
  };
  const reset = Number(time('reset-after') - time('reset-before')) / 1e6;
  const requireMs = Number(time('excel-agent-require-after') - time('excel-agent-require-before')) / 1e6;
  const initialize = Number(time('agent-initialize-await-after') - time('agent-initialize-await-before')) / 1e6;
  const postAbortDrain = Number(time('post-abort-drain-after') - time('abort-after')) / 1e6;
  requireThat(reset >= 0 && requireMs > 10000 && initialize >= 0 && initialize < 1000 &&
    postAbortDrain >= 0 && postAbortDrain < 1000 &&
    !events.some(event => event.point === 'successor-call-before'),
  'Diagnostic does not support the narrow cold-module-loading correction');
  return { resetMs: reset, requireMs, initializeMs: initialize, postAbortDrainMs: postAbortDrain };
}

export function verifyCredentialAdmissionFailure(events, job, result) {
  requireThat(events.length === 3 &&
    events.map(event => event.type).join(',') === 'session.start,session.error,session.shutdown' &&
    events[0].data.sessionId === job.session_id && events[0].data.context.cwd === job.workspace &&
    events[1].data.errorType === 'query' &&
    events[1].data.message ===
      'Execution failed: InvalidArg, No GitHub OAuth token or Copilot HMAC key provided' &&
    events[2].data.shutdownType === 'routine' &&
    events[2].data.totalPremiumRequests === 0 && events[2].data.totalNanoAiu === 0 &&
    events[2].data.totalApiDurationMs === 0 && events[2].data.conversationTokens === 0 &&
    json(events[2].data.modelMetrics) === '{}' &&
    events[2].data.codeChanges.linesAdded === 0 && events[2].data.codeChanges.linesRemoved === 0 &&
    events[2].data.codeChanges.filesModified.length === 0 &&
    job.state === 'blocked' && result.attemptId === job.session_id && result.outcome === 'blocked' &&
    result.sourceRevision === job.base_revision && result.draftPR === null &&
    result.skillExecution === null && result.validation.length === 0 &&
    result.validationAttempts.length === 0 && result.toolUsage.used === 0 &&
    Object.values(result.toolUsage.byTool).every(count => count === 0) &&
    result.toolUsage.rounds.length === 1 && result.toolUsage.rounds[0].status === 'failed' &&
    result.toolUsage.rounds[0].used === 0 && result.toolUsage.rounds[0].cumulativeUsed === 0,
  'Only the exact terminal credential-admission rejection with no authoring or native case may continue');
}

async function inspectCredentialPredecessor(config, input, diagnostic) {
  const previous = input.credentialAdmissionPredecessor;
  if (!previous) return null;
  requireThat(Object.keys(previous).sort().join(',') ===
    'assignmentId,authDiagnosis,configPath,terminalReport' &&
    isAbsolute(previous.configPath ?? '') && typeof previous.assignmentId === 'string',
  'Invalid credential-admission predecessor');
  const previousConfig = configAt(previous.configPath);
  requireThat(json({ ...config, stateDirectory: null }) ===
    json({ ...previousConfig, stateDirectory: null }) &&
    separate(previousConfig.stateDirectory, config.stateDirectory) &&
    separate(config.stateDirectory, previousConfig.stateDirectory),
  'Credential successor changes only its private state placement');
  const report = pin(previous.terminalReport), diagnosis = pin(previous.authDiagnosis);
  requireThat(diagnosis.kind === 'local-proposer-launch-auth-diagnosis-v1' &&
    diagnosis.conclusion.classification === 'Established launcher credential-forwarding loss' &&
    json(diagnosis.predecessor) === json(previous.terminalReport) &&
    diagnosis.failed.attemptId === report.attemptId &&
    diagnosis.currentPresence.some(row =>
      ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'].includes(row.name) &&
      row.parentPresent === true && row.oldFilteredChildPresent === false &&
      row.correctedChildPresent === true) &&
    diagnosis.correctionReferences.some(ref => ref.path === join(root, 'src', 'workers.js') &&
      hash(readFileSync(ref.path)) === ref.sha256),
  'Credential successor requires the sealed forwarding diagnosis and corrected launcher helper');
  await command('git', ['merge-base', '--is-ancestor', diagnosis.controllerRevision,
    input.authorization.controllerRevision], root, 30000, minimalEnvironment());
  const tracker = pin(diagnosis.preservedLiveTracker);
  requireThat(tracker.finishedAt && tracker.cliFinishedAt && tracker.attemptId === report.attemptId &&
    report.processTermination.activePreTerminalProcesses.length === 0 &&
    report.publication.remoteBranchPresent === false &&
    report.publication.matchingPRsAcrossAllStatuses === 0 && report.newCommits === 0 &&
    Date.parse(input.authorization.recordedAt) >= Date.parse(report.reportedAt),
  'Credential predecessor is not sealed terminal and unpublished');
  for (const ref of report.rawArtifacts)
    requireThat(hash(readFileSync(ref.path)) === ref.sha256, 'Credential predecessor raw artifact changed');
  const ledger = new Ledger(previousConfig.stateDirectory, { readOnly: true });
  try {
    const job = ledger.job(previous.assignmentId);
    const assignment = ledger.get('assignment', previous.assignmentId);
    const results = ledger.all('workerResult').filter(result => result.assignmentId === previous.assignmentId);
    requireThat(job && assignment && results.length === 1, 'Credential predecessor identity is missing');
    const result = results[0], eventRef = report.sdk.eventRef;
    requireThat(eventRef.path === join(previousConfig.stateDirectory, 'runtime', 'session-state',
      job.session_id, 'events.jsonl') && hash(readFileSync(eventRef.path)) === eventRef.sha256 &&
      json(result) === json(report.workerResult) && report.assignmentId === job.id &&
      job.base_revision === diagnostic.result.sourceRevision,
    'Credential predecessor result or SDK provenance changed');
    verifyCredentialAdmissionFailure(readFileSync(eventRef.path, 'utf8').trim().split(/\r?\n/).map(JSON.parse),
      job, result);
    const operations = ledger.status().operations.filter(row => row.job_id === job.id &&
      row.kind !== 'authoring-credential-successor-reservation');
    const prepared = operations.find(row => row.kind === 'authoring-successor-from-diagnostic');
    const execution = operations.find(row => row.kind === 'role-authoring-execution');
    requireThat(operations.length === 2 && prepared?.state === 'prepared' && execution?.state === 'failed' &&
      hash(json(operations.map(row => ({ ...row, detail: JSON.parse(row.detail) })))) === hash(json(report.operations)),
    'Credential predecessor has other activity or changed operations');
    const detail = JSON.parse(prepared.detail);
    requireThat(!detail.input.credentialAdmissionPredecessor && detail.nextAttemptId === job.session_id &&
      detail.inputSha256 === hash(json(detail.input)) &&
      detail.predecessorSha256 === diagnostic.prior.snapshotSha256 &&
      json(detail.recordedRoleHandoff) === json(diagnostic.prior.handoff) &&
      ['diagnosticConfigPath', 'diagnosticReceipt', 'diagnosticReport', 'userAuthorization']
        .every(key => json(detail.input[key]) === json(input[key])),
    'Credential successor cannot chain retries or change the original diagnostic/role/grant lineage');
    pin(detail.input.sourceReview);
    const original = new Ledger(detail.diagnosticStateDirectory, { readOnly: true });
    try {
      const reservation = original.db.prepare('SELECT state,detail FROM operations WHERE id=?').get(prepared.id);
      requireThat(reservation?.state === 'prepared' && json(JSON.parse(reservation.detail)) === json(detail),
        'Original consumed diagnostic reservation changed');
    } finally { original.close(); }
    requireThat((await command('git', ['rev-parse', 'HEAD'], job.workspace, 30000, minimalEnvironment()))
      .stdout.trim() === job.base_revision &&
      !(await command('git', ['-c', 'core.longpaths=true', 'status', '--porcelain'], job.workspace,
        30000, minimalEnvironment())).stdout.trim(), 'Credential predecessor source is no longer unchanged');
    for (const pid of [tracker.cliPid, tracker.monitorPid]) {
      let alive = false;
      try { process.kill(pid, 0); alive = true; }
      catch (error) { requireThat(error.code === 'ESRCH', 'Cannot establish predecessor process termination'); }
      requireThat(!alive, 'Credential predecessor owner process is still active');
    }
    return { stateDirectory: previousConfig.stateDirectory, assignmentId: job.id,
      attemptId: job.session_id, jobSha256: hash(json(job)), resultSha256: hash(json(result)),
      operationsSha256: hash(json(operations)), terminalReport: previous.terminalReport,
      authDiagnosis: previous.authDiagnosis };
  } finally { ledger.close(); }
}

async function inspectInputs(config, input) {
  const predecessorKeys = input?.credentialAdmissionPredecessor ? ['credentialAdmissionPredecessor'] : [];
  requireThat(input && Object.keys(input).sort().join(',') ===
    ['authorization', 'diagnosticConfigPath', 'diagnosticReceipt', 'diagnosticReport',
      'sourceReview', 'userAuthorization', ...predecessorKeys].sort().join(',') &&
    isAbsolute(input.diagnosticConfigPath ?? ''), 'Invalid authoring successor request');
  const grant = pin(input.userAuthorization), review = pin(input.sourceReview);
  const report = pin(input.diagnosticReport), auth = input.authorization;
  requireThat(grant.userResponse === 'all runs authorized' &&
    auth?.approved === true && auth.authorizedBy === 'user' &&
    auth.kind === 'diagnosed-suite-module-loading' && auth.maxModelAttempts === 1 &&
    auth.nextConfigSha256 === hash(json(config)) &&
    auth.inputsSha256 === hash(json({ diagnosticConfigPath: input.diagnosticConfigPath,
      diagnosticReceipt: input.diagnosticReceipt, diagnosticReport: input.diagnosticReport,
      sourceReview: input.sourceReview, userAuthorization: input.userAuthorization,
      ...(input.credentialAdmissionPredecessor
        ? { credentialAdmissionPredecessor: input.credentialAdmissionPredecessor } : {}) })),
  'Source-bound one-model successor authorization is required', 'blocked-authorization');
  utc(auth.recordedAt);
  requireThat((await command('git', ['rev-parse', 'HEAD'], root, 30000, minimalEnvironment()))
    .stdout.trim() === auth.controllerRevision &&
    !(await command('git', ['status', '--porcelain'], root, 30000, minimalEnvironment())).stdout.trim(),
  'Authoring successor requires its clean qualified controller');
  const diagnostic = await inspectCompletedLocalDiagnostic(input.diagnosticConfigPath, input.diagnosticReceipt);
  const { prior, result } = diagnostic;
  requireThat(report.diagnosticId === result.diagnosticId &&
    json(report.diagnosticReceipt) === json(input.diagnosticReceipt) &&
    report.acceptanceEvidence === false && report.publicationEligible === false &&
    review.sourceRevision === result.sourceRevision && review.testPath === result.input.test.path &&
    review.correction === 'suite-level-real-sut-import-only' &&
    review.targetOverlap === 'none-in-reviewed-admission-or-egress-behavior' &&
    auth.sourceRevision === result.sourceRevision &&
    Date.parse(auth.recordedAt) >= Date.parse(result.finishedAt) &&
    Date.parse(auth.recordedAt) <= Date.now() + 60000,
  'Successor review or authority differs from the completed diagnostic');
  requireThat(Array.isArray(review.priorArt) && review.priorArt.length > 0 &&
    review.priorArt.every(file => typeof file.path === 'string' &&
      !isAbsolute(file.path) && !file.path.split(/[\\/]/).includes('..') &&
      hash(readFileSync(join(prior.job.workspace, file.path))) === file.sha256) &&
    hash(readFileSync(review.targetDelta.path)) === review.targetDelta.sha256,
  'Source-bound setup prior art or reviewed target delta changed');
  const expected = structuredClone(prior.previousConfig);
  expected.stateDirectory = config.stateDirectory;
  expected.activation = { collect: false, review: false, dispatch: true };
  const repo = expected.repositories.find(repo => repo.id === prior.assignment.repoId);
  repo.referenceCheckout = prior.job.workspace;
  repo.baseRef = result.sourceRevision;
  requireThat(json(config) === json(expected) &&
    !resolve(config.stateDirectory).split(/[\\/]/).some(part => part.startsWith('.')) &&
    [prior.previousConfig.stateDirectory, diagnostic.config.stateDirectory].every(directory =>
      separate(directory, config.stateDirectory) && separate(config.stateDirectory, directory)),
  'Successor may change only private placement and the preserved authoring base');
  requireThat(config.limits.maxAiCreditsPerSession <= 100 &&
    config.limits.maxValidationRepairRounds === 0 && config.limits.maxValidationInfrastructureRetries === 0,
  'Successor must retain the credit ceiling and zero in-attempt retries');
  const measurements = coldLoadEvidence(result);
  const credentialAdmission = await inspectCredentialPredecessor(config, input, diagnostic);
  return { ...diagnostic, measurements, review, credentialAdmission };
}

export async function prepareLocalAuthoringSuccessor(config, ledger, input) {
  requireThat(realpathSync(ledger.directory) === realpathSync(config.stateDirectory),
    'Authoring successor ledger differs from configuration');
  const owner = ledger.acquire('dispatch');
  let diagnosticLedger, diagnosticOwner;
  try {
    const state = ledger.status();
    requireThat(!state.jobs.length && !state.counts.length && !state.operations.length && !state.runs.length,
      'Authoring successor requires a fresh ledger; never reset an exhausted attempt');
    const inspected = await inspectInputs(config, input);
    const { prior, result, measurements, credentialAdmission } = inspected;
    const qualification = await qualifyRepositorySkill(config, prior.assignment.repoId,
      prior.assignment.capability, prior.assignment.skillBindingId);
    verifyRepositorySkillWorkspace(config,
      { ...prior.assignment, skillQualification: pinSkillQualification(qualification) }, prior.job.workspace,
      result.sourceRevision, qualification);
    requireThat(qualification.skillSha256 === prior.assignment.skillQualification.skillSha256,
      'Authoring successor cannot change the repository-native skill');
    const reservationStateDirectory = credentialAdmission?.stateDirectory ?? inspected.config.stateDirectory;
    const reservationKind = credentialAdmission
      ? 'authoring-credential-successor-reservation' : 'authoring-successor-reservation';
    diagnosticLedger = new Ledger(reservationStateDirectory);
    diagnosticOwner = diagnosticLedger.acquire('authoring-successor');
    const reservationId = credentialAdmission
      ? `${credentialAdmission.assignmentId}:credential-admission-successor`
      : `${result.diagnosticId}:authoring-successor`;
    requireThat(!diagnosticLedger.db.prepare('SELECT id FROM operations WHERE id=?').get(reservationId),
      'This predecessor already reserved its one authoring successor');
    const trace = { input, inputSha256: hash(json(input)), diagnosticId: result.diagnosticId,
      diagnosticStateDirectory: inspected.config.stateDirectory,
      sourceRevision: result.sourceRevision, originalRoleOrigin: prior.origin,
      recordedRoleHandoff: prior.handoff, predecessorSha256: prior.snapshotSha256,
      ...(credentialAdmission ? { credentialAdmission, reservationStateDirectory, reservationKind } : {}),
      measurements, nextStateDirectory: resolve(config.stateDirectory),
      preparedAt: now(), execution: await roleExecutionIdentity('proposer') };
    diagnosticLedger.operation(reservationId, credentialAdmission?.assignmentId ?? prior.assignment.id,
      reservationKind, trace);
    const original = new Ledger(prior.previousConfig.stateDirectory, { readOnly: true });
    try {
      ledger.transaction(() => {
        importReviewedContinuation(config, original, ledger, prior.assignment, qualification,
          'diagnosed-authoring-successor:captured-evidence-import');
        const oldPlan = ledger.get('testCoveragePlan', prior.assignment.testCoveragePlanId);
        const plan = recordTestCoveragePlan(ledger, {
          ...oldPlan, sourceRevision: result.sourceRevision,
          existingTests: [...oldPlan.existingTests, { path: result.input.test.path,
            identifier: result.input.test.name }],
          coverageGaps: ['The preserved authored case times out during cold suite module loading before successor assertions run.'],
          unknowns: ['Diagnostic evidence is not acceptance; both unchanged native legs must pass the new revision.'],
          rationale: `Same reviewed candidate, not new coverage. Diagnostic ${result.diagnosticId} ` +
            `measured reset ${measurements.resetMs}ms and synchronous require ${measurements.requireMs}ms. ` +
            'Make only a module-level side-effect import of the real ExcelAgent SUT, after the existing mock registration. ' +
            'Use the native top-level SUT import pattern; do not add a warmup case or invoke extra tests. ' +
            'Keep every existing prefix statement and the complete describe/it suite byte-for-byte unchanged, including ' +
            'harness reset/initialize, timeout, behavioral/precondition assertions and cleanup. No comments or other ' +
            'setup changes are needed. Optionally clarify this existing case in its existing behavior card. ' +
            'Do not edit shared harness, product code, Jest/profile configuration, budgets or test selection. ' +
            `Read-only prior-art review: ${input.sourceReview.sha256}.` +
            (credentialAdmission ? ` Separately sealed credential-admission predecessor: ${credentialAdmission.attemptId}; ` +
              'it authored no changes and provides no native acceptance evidence.' : '')
        });
        const assignment = makePlannedImprovementAssignment(config, ledger,
          ledger.get('investigation', prior.assignment.investigationId), plan.id,
          prior.assignment.requestedOutcome, plan.version);
        const job = ledger.prepare(assignment, { bucket: reservationId, maxNew: 1 });
        Object.assign(trace, { nextAssignmentId: assignment.id, nextAttemptId: job.session_id,
          qualification, testPath: result.input.test.path,
          originalTestSha256: result.files.find(file => file.path === result.input.test.path).beforeSha256 });
        ledger.operation(reservationId, assignment.id, 'authoring-successor-from-diagnostic', trace);
        ledger.finishOperation(reservationId, 'prepared', trace);
      });
    } finally { original.close(); }
    diagnosticLedger.finishOperation(reservationId, 'prepared', trace);
    return { assignment: ledger.get('assignment', trace.nextAssignmentId),
      job: ledger.job(trace.nextAssignmentId), audit: trace };
  } finally {
    if (diagnosticOwner) diagnosticLedger.release('authoring-successor', diagnosticOwner);
    diagnosticLedger?.close();
    ledger.release('dispatch', owner);
  }
}

export async function verifyPreparedAuthoringSuccessor(config, ledger, id) {
  const row = ledger.status().operations.find(row =>
    row.job_id === id && row.kind === 'authoring-successor-from-diagnostic');
  requireThat(row?.state === 'prepared', 'Authoring successor has no immutable preparation');
  const detail = JSON.parse(row.detail), job = ledger.job(id);
  requireThat(detail.nextAssignmentId === id && detail.nextAttemptId === job?.session_id &&
    detail.inputSha256 === hash(json(detail.input)) &&
    detail.nextStateDirectory === resolve(config.stateDirectory),
  'Authoring successor attempt binding changed');
  const inspected = await inspectInputs(config, detail.input);
  requireThat(inspected.prior.snapshotSha256 === detail.predecessorSha256 &&
    json(inspected.prior.origin) === json(detail.originalRoleOrigin) &&
    json(inspected.prior.handoff) === json(detail.recordedRoleHandoff) &&
    json(inspected.credentialAdmission) === json(detail.credentialAdmission ?? null),
  'Authoring successor original proposal/role lineage changed');
  const previous = new Ledger(detail.reservationStateDirectory ?? detail.diagnosticStateDirectory, { readOnly: true });
  try {
    const reservation = previous.db.prepare('SELECT kind,state,detail FROM operations WHERE id=?').get(row.id);
    requireThat(reservation?.kind === (detail.reservationKind ?? 'authoring-successor-reservation') &&
      reservation.state === 'prepared' &&
      json(JSON.parse(reservation.detail)) === json(detail), 'Authoring successor reservation changed');
  } finally { previous.close(); }
  return detail;
}

export async function dispatchLocalAuthoringSuccessor(config, ledger, assignmentId) {
  requireThat(ledger.job(assignmentId)?.state === 'prepared',
    'Only a never-dispatched authoring successor may execute');
  const detail = await verifyPreparedAuthoringSuccessor(config, ledger, assignmentId);
  if (detail.credentialAdmission)
    requireThat(['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'].some(name => process.env[name]),
      'Corrected proposer launch must preserve a supported model credential; no model request attempted',
      'blocked-auth');
  const id = `${assignmentId}:role-authoring-execution`;
  const trace = { execution: await roleExecutionIdentity('proposer'), pid: process.pid,
    startedAt: now(), attemptId: detail.nextAttemptId, diagnosticId: detail.diagnosticId,
    originalRoleOrigin: detail.originalRoleOrigin, recordedRoleHandoff: detail.recordedRoleHandoff };
  ledger.operation(id, assignmentId, 'role-authoring-execution', trace);
  try {
    const result = await dispatchRecordedAuthoringSuccessor(config, ledger, assignmentId);
    ledger.finishOperation(id, 'completed', { ...trace, finishedAt: now(),
      workerResultId: result.id, workerResultSha256: hash(json(result)),
      outcome: result.outcome, sourceRevision: result.sourceRevision });
    return result;
  } catch (error) {
    ledger.finishOperation(id, 'failed', { ...trace, finishedAt: now(), error: safeError(error) });
    throw error;
  }
}
