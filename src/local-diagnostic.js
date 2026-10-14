import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configAt, hash, json, now, requireThat, safeError, utc } from './common.js';
import { Ledger } from './ledger.js';
import { selectLocalValidationRoleOrigin } from './local-continuation.js';
import { verifyRecordedRoleHandoff, roleExecutionIdentity } from './role-replay.js';
import { command, materializeDiagnosticSnapshot, minimalEnvironment, repoFor,
  requireCurrentAssignment, verifyContinuationPredecessor, verifyPreservedChange } from './workers.js';
import { nativeCommand } from './native-command.js';

const controllerRoot = fileURLToPath(new URL('..', import.meta.url));
const marker = 'PILOT_DIAGNOSTIC_TRACE';
const git = async (cwd, args) => (await command('git',
  ['-c', 'core.longpaths=true', ...args], cwd, 120000, minimalEnvironment())).stdout.trim();
const pin = reference => {
  requireThat(reference && isAbsolute(reference.path ?? '') &&
    /^[a-f0-9]{64}$/.test(reference.sha256 ?? '') &&
    hash(readFileSync(reference.path)) === reference.sha256,
  'Diagnostic input artifact changed', 'blocked-reconciliation');
  return JSON.parse(readFileSync(reference.path));
};
const inside = (root, path) => {
  const part = relative(resolve(root), resolve(path));
  return part && !part.startsWith('..') && !isAbsolute(part);
};

export function instrumentDiagnosticSource(source, points) {
  requireThat(Array.isArray(points) && points.length > 0 && points.length <= 40 &&
    !source.includes(marker), 'Diagnostic requires bounded fresh logging points');
  let text = source;
  const labels = new Set();
  for (const point of points) {
    requireThat(/^[a-z][a-z0-9-]{0,79}$/.test(point.label ?? '') &&
      !labels.has(point.label) && ['before', 'after'].includes(point.position) &&
      typeof point.needle === 'string' && point.needle.trim() &&
      source.split(point.needle).length === 2 && text.split(point.needle).length === 2,
    'Diagnostic point must identify one unchanged source anchor');
    labels.add(point.label);
    const statement = `require('node:fs').appendFileSync(process.env.${marker}, ` +
      `JSON.stringify({point:${JSON.stringify(point.label)},hrtime:process.hrtime.bigint().toString(),` +
      `pid:process.pid})+'\\n');`;
    text = text.replace(point.needle, point.position === 'before'
      ? `${statement}\n${point.needle}` : `${point.needle}\n${statement}`);
  }
  return text;
}

export function diagnosticProfile(test, resultPath, cachePath) {
  requireThat(/^@?[a-z0-9][a-z0-9._/-]+$/.test(test.packageName ?? '') &&
    /^agents\/[a-z0-9-]+\/tests\/integration\/[a-zA-Z0-9_./-]+\.test\.ts$/.test(test.path ?? '') &&
    !test.path.split('/').includes('..') &&
    typeof test.name === 'string' && test.name.trim() &&
    [resultPath, cachePath].every(path => isAbsolute(path) && !/[\r\n']/.test(path)),
  'Diagnostic requires one exact integration case and safe output paths');
  const selector = test.path.split('/').slice(2).join('/');
  return `$ErrorActionPreference = 'Stop'\n` +
    `$env:OAGENT_ADO_ARTIFACTS_AUTHENTICATED = '1'\n` +
    `$corepack = (Get-Command corepack.cmd -ErrorAction Stop).Source\n` +
    `& $corepack yarn workspace '${test.packageName}' test:integration ` +
    `--runTestsByPath '${selector}' --runInBand --json ` +
    `'--outputFile=${resultPath}' '--cacheDirectory=${cachePath}'\n` +
    `exit $LASTEXITCODE\n`;
}

async function inspectPredecessor(config, input) {
  requireThat(isAbsolute(input.previousConfigPath ?? '') &&
    typeof input.previousAssignmentId === 'string', 'Diagnostic predecessor identity required');
  const previousConfig = configAt(input.previousConfigPath);
  requireThat(json({ ...previousConfig, stateDirectory: null, activation: null }) ===
    json({ ...config, stateDirectory: null, activation: null }) &&
    Object.values(config.activation).every(value => value === false) &&
    config.limits.maxAiCreditsPerSession <= 100 &&
    config.limits.maxValidationRepairRounds === 0 &&
    config.limits.maxValidationInfrastructureRetries === 0 &&
    !inside(previousConfig.stateDirectory, config.stateDirectory) &&
    !inside(config.stateDirectory, previousConfig.stateDirectory) &&
    resolve(config.stateDirectory) !== resolve(previousConfig.stateDirectory),
  'Diagnostic changes only state and disables ordinary role activation', 'blocked-authorization');
  const ledger = new Ledger(previousConfig.stateDirectory, { readOnly: true });
  try {
    const id = input.previousAssignmentId, job = ledger.job(id);
    const assignment = ledger.get('assignment', id);
    const results = ledger.all('workerResult').filter(row => row.assignmentId === id);
    const result = results[0];
    const operations = ledger.status().operations.filter(row => row.job_id === id);
    const continuation = operations.find(row => row.kind === 'continued-from-validation-failure');
    const role = operations.find(row => row.kind === 'recorded-role-handoff');
    requireThat(job?.state === 'blocked' && assignment?.execution === 'local' &&
      results.length === 1 && result.outcome === 'blocked' && result.draftPR === null &&
      result.attemptId === job.session_id && result.toolUsage.used === 0 &&
      result.validation.length === 1 && result.validationAttempts.length === 1 &&
      result.validation[0].status === 'failed' && result.validation[0].attemptCount === 1 &&
      continuation?.state === 'prepared' && role?.state === 'recorded' &&
      !operations.some(row => ['push', 'draft-pr', 'commit'].includes(row.kind)),
    'Diagnostic requires one sealed failed native-only predecessor', 'blocked-reconciliation');
    const detail = JSON.parse(continuation.detail), linked = JSON.parse(role.detail);
    requireThat(detail.originalContinuation && detail.authorization.kind === 'discovery-placement' &&
      detail.nextAttemptId === job.session_id && linked.nextAttemptId === job.session_id &&
      linked.previousAssignmentId === detail.priorJob.id &&
      linked.nextAssignmentId === id, 'Diagnostic lineage is not the preserved placement attempt');
    verifyContinuationPredecessor(detail, continuation.id, job.session_id);
    const original = detail.originalContinuation;
    verifyContinuationPredecessor(original.detail, original.operationId, original.detail.nextAttemptId);
    const parentConfig = configAt(linked.previousConfigPath);
    const parent = new Ledger(parentConfig.stateDirectory, { readOnly: true });
    let origin;
    try {
      requireThat(realpathSync(parent.directory) === detail.priorStateDirectory,
        'Diagnostic immediate predecessor origin changed');
      origin = selectLocalValidationRoleOrigin(parentConfig, parent, linked.previousAssignmentId);
    } finally { parent.close(); }
    requireThat(json(origin) === json(linked.roleVerificationOrigin),
      'Diagnostic recorded original role origin changed');
    const originLedger = new Ledger(origin.stateDirectory, { readOnly: true });
    let handoff;
    try {
      handoff = verifyRecordedRoleHandoff(input.recordedRoleHandoff, originLedger, origin.assignmentId);
      requireThat(json(handoff) === json(linked.recordedRoleHandoff),
        'Diagnostic recorded role handoff differs from predecessor');
    } finally { originLedger.close(); }
    requireCurrentAssignment(previousConfig, ledger,
      ledger.get('investigation', assignment.investigationId), assignment);
    await verifyPreservedChange(previousConfig, assignment, job, result, detail.proposal);
    const report = pin(input.sealed.terminalReport), raw = pin(input.sealed.rawCase);
    const native = pin(input.sealed.nativeArtifact), prepared = pin(input.sealed.preparedReceipt);
    const perCase = pin(report.validation.perCase);
    const tests = raw.testResults?.flatMap(suite => suite.assertionResults ?? []);
    requireThat(report.attemptId === job.session_id && report.sourceRevision === result.sourceRevision &&
      report.outcome === 'blocked' && report.publication.remoteBranchPresent === false &&
      report.publication.matchingPRsAcrossAllStatuses === 0 &&
      report.validation.rawArtifacts.some(ref => json(ref) === json(input.sealed.nativeArtifact)) &&
      perCase.legs.some(leg => leg.sha256 === input.sealed.rawCase.sha256 &&
        leg.path === input.sealed.rawCase.path && leg.verdict === 'failed') &&
      result.validation[0].artifactRefs.includes(input.sealed.nativeArtifact.path) &&
      native.status === 'failed' && native.revision === result.sourceRevision &&
      native.telemetry.preparedReceipt === input.sealed.preparedReceipt.path &&
      prepared.preparedFromRevision === result.sourceRevision && prepared.type === 'compile' &&
      raw.numTotalTests === 1 && raw.numFailedTests === 1 && tests?.length === 1 &&
      tests[0].title === input.test.name && tests[0].invocations === 1 &&
      tests[0].failureMessages.some(message => message.includes('Exceeded timeout of 10000 ms')),
    'Diagnostic evidence must bind the actual one-case timeout and compiled source');
    const repo = repoFor(previousConfig, assignment.repoId);
    requireThat(assignment.repoId === 'office-agent' && repo.allowedWriteFiles.includes(input.test.path) &&
      JSON.parse(readFileSync(join(job.workspace, 'agents', 'excel-agent', 'package.json'))).name ===
        input.test.packageName &&
      raw.testResults[0].name.replaceAll('\\', '/').endsWith(`/${input.test.path}`) &&
      input.instrumentation.length === 2 &&
      input.instrumentation.some(file => file.path === input.test.path) &&
      input.instrumentation.every(file => file.path === input.test.path ||
        file.path === 'agents/excel-agent/tests/integration-harness/runtime/ExcelAgentIntegrationHarness.ts'),
    'Diagnostic instrumentation exceeds the approved disposable test/harness scope');
    return { previousConfig, job, assignment, result, repo, gate: repo.validationGates[0],
      origin, handoff, snapshotSha256: hash(json({ job, assignment, result, operations })) };
  } finally { ledger.close(); }
}

async function verifyInputs(config, input) {
  requireThat(input && Object.keys(input).every(key =>
    ['previousConfigPath', 'previousAssignmentId', 'authorization', 'sealed', 'test',
      'instrumentation', 'recordedRoleHandoff'].includes(key)),
  'Diagnostic request contains unsupported input fields');
  const auth = input.authorization;
  const grant = pin(auth?.userAuthorization);
  requireThat(auth.approved === true && auth.authorizedBy === 'user' &&
    auth.kind === 'case-timeout-diagnostic' && auth.maxCaseInvocations === 1 &&
    auth.maxModelAttempts === 0 && auth.acceptanceEvidence === false &&
    auth.nextConfigSha256 === hash(json(config)) &&
    auth.contractSha256 === hash(json({ sealed: input.sealed, test: input.test,
      instrumentation: input.instrumentation, recordedRoleHandoff: input.recordedRoleHandoff })) &&
    typeof grant.userResponse === 'string' && grant.userResponse === 'all runs authorized' &&
    !resolve(config.stateDirectory).split(/[\\/]/).some(part => part.startsWith('.')),
  'Explicit hash-bound diagnostic-only user authority required', 'blocked-authorization');
  utc(auth.recordedAt);
  requireThat(Date.parse(auth.recordedAt) <= Date.now() + 60000 &&
    await git(controllerRoot, ['rev-parse', 'HEAD']) === auth.controllerRevision &&
    !await git(controllerRoot, ['status', '--porcelain']),
  'Diagnostic controller must remain clean at its authorized pin');
  const prior = await inspectPredecessor(config, input);
  if (auth.previousDiagnostic) {
    const interrupted = pin(auth.previousDiagnostic.receipt);
    const old = new Ledger(auth.previousDiagnostic.stateDirectory, { readOnly: true });
    try {
      const row = old.db.prepare('SELECT state,detail FROM operations WHERE id=?')
        .get(auth.previousDiagnostic.diagnosticId);
      requireThat(row?.state === 'interrupted' && json(JSON.parse(row.detail)) === json(interrupted) &&
        interrupted.caseCommandInvocations === 0 && interrupted.acceptanceEvidence === false &&
        interrupted.originalDetail.input.previousAssignmentId === input.previousAssignmentId &&
        interrupted.originalDetail.sourceRevision === prior.result.sourceRevision,
      'Diagnostic follow-on must bind its sealed pre-case interruption');
    } finally { old.close(); }
  }
  requireThat(auth.previousAttemptId === prior.job.session_id &&
    auth.sourceRevision === prior.result.sourceRevision &&
    Date.parse(auth.recordedAt) >= Date.parse(prior.result.reportedAt),
  'Diagnostic authorization differs from its failed predecessor');
  const files = input.instrumentation.map(file => {
    const bytes = readFileSync(join(prior.job.workspace, file.path));
    requireThat(hash(bytes) === file.sha256, 'Diagnostic instrumentation base changed');
    const content = instrumentDiagnosticSource(bytes.toString('utf8'), file.points);
    return { path: file.path, beforeSha256: file.sha256, afterSha256: hash(content), content };
  });
  requireThat(new Set(files.map(file => file.path)).size === files.length,
    'Diagnostic instrumentation paths must be unique');
  return { ...prior, files };
}

export async function inspectCompletedLocalDiagnostic(configPath, reference) {
  const config = configAt(configPath), result = pin(reference);
  const ledger = new Ledger(config.stateDirectory, { readOnly: true });
  try {
    const row = ledger.db.prepare('SELECT * FROM operations WHERE id=?').get(result.diagnosticId);
    requireThat(row?.kind === 'local-validation-diagnostic' && row.state === 'completed' &&
      json(JSON.parse(row.detail)) === json({ ...result, receipt: reference }) &&
      result.diagnosticId === `diagnostic-${hash(json(result.input))}` &&
      hash(json(config)) === result.input.authorization.nextConfigSha256 &&
      result.modelCalls === 0 && result.caseCommandInvocations === 1 &&
      result.newCommits === 0 && result.acceptanceEvidence === false &&
      result.publicationEligible === false && result.cacheInitiallyAbsent === true &&
      result.outcome === 'diagnostic-failed' && result.exitCode === 1 && !result.timedOut,
    'Authoring successor requires a sealed completed diagnostic, not acceptance');
    for (const artifact of [...result.artifacts, result.diff])
      requireThat(hash(readFileSync(artifact.path)) === artifact.sha256,
        'Diagnostic successor evidence changed');
    requireThat(hash(readFileSync(result.profilePath)) === result.profileSha256,
      'Diagnostic profile changed');
    const prior = await inspectPredecessor(config, result.input);
    requireThat(prior.snapshotSha256 === result.predecessorSha256,
      'Diagnostic acceptance predecessor changed');
    const interruptedRef = result.input.authorization.previousDiagnostic;
    requireThat(interruptedRef, 'Diagnostic successor must retain its safety interruption');
    const interruption = pin(interruptedRef.receipt);
    const interruptedLedger = new Ledger(interruptedRef.stateDirectory, { readOnly: true });
    try {
      const interrupted = interruptedLedger.db.prepare('SELECT state,detail FROM operations WHERE id=?')
        .get(interruptedRef.diagnosticId);
      requireThat(interrupted?.state === 'interrupted' &&
        json(JSON.parse(interrupted.detail)) === json(interruption) &&
        interruption.caseCommandInvocations === 0 &&
        interruption.originalDetail.sourceRevision === result.sourceRevision,
      'Diagnostic safety-interruption lineage changed');
    } finally { interruptedLedger.close(); }
    const raw = JSON.parse(readFileSync(result.resultPath));
    const cases = raw.testResults?.flatMap(suite => suite.assertionResults ?? []);
    requireThat(raw.numTotalTests === 1 && raw.numFailedTests === 1 && cases?.length === 1 &&
      cases[0].title === result.input.test.name && cases[0].invocations === 1 &&
      cases[0].failureMessages.some(message => message.includes('Exceeded timeout of 10000 ms')),
    'Diagnostic did not reproduce the selected case timeout');
    return { config, result, prior };
  } finally { ledger.close(); }
}

export async function prepareLocalValidationDiagnostic(config, ledger, input) {
  if (input?.authorization?.kind === 'native-launcher-timeout-diagnostic')
    return (await import('./local-launcher-diagnostic.js')).prepareLauncherDiagnostic(config, ledger, input);
  requireThat(realpathSync(ledger.directory) === realpathSync(config.stateDirectory),
    'Diagnostic ledger differs from configured state');
  const owner = ledger.acquire('diagnostic');
  try {
    const state = ledger.status();
    requireThat(!state.jobs.length && !state.counts.length && !state.operations.length,
      'Diagnostic requires a fresh empty ledger; no repeat');
    const prior = await verifyInputs(config, input);
    const diagnosticId = `diagnostic-${hash(json(input))}`;
    const workspace = join(config.stateDirectory, 'w');
    const profilePath = join(config.stateDirectory, 'diagnostic-profile.ps1');
    const resultPath = join(config.stateDirectory, 'case-results.json');
    const cachePath = join(config.stateDirectory, 'jest-cache');
    const profile = diagnosticProfile(input.test, resultPath, cachePath);
    const detail = { diagnosticId, input, inputSha256: hash(json(input)),
      predecessorSha256: prior.snapshotSha256, sourceRevision: prior.result.sourceRevision,
      workspace, profilePath, profileSha256: hash(profile), resultPath, cachePath,
      tracePath: join(config.stateDirectory, 'trace.jsonl'),
      files: prior.files.map(({ content, ...file }) => file),
      preparedAt: now(), execution: await roleExecutionIdentity('proposer'),
      acceptanceEvidence: false, publicationEligible: false };
    requireThat([workspace, profilePath, resultPath, cachePath, detail.tracePath]
      .every(path => !existsSync(path)), 'Diagnostic runtime paths must be fresh');
    ledger.operation(diagnosticId, input.previousAssignmentId, 'local-validation-diagnostic', detail);
    writeFileSync(profilePath, profile, { flag: 'wx', mode: 0o600 });
    ledger.finishOperation(diagnosticId, 'prepared', detail);
    return detail;
  } finally { ledger.release('diagnostic', owner); }
}

export async function dispatchLocalValidationDiagnostic(config, ledger, diagnosticId) {
  if (ledger.db.prepare('SELECT kind FROM operations WHERE id=?').get(diagnosticId)?.kind === 'local-launcher-diagnostic')
    return (await import('./local-launcher-diagnostic.js')).dispatchLauncherDiagnostic(config, ledger, diagnosticId);
  requireThat(realpathSync(ledger.directory) === realpathSync(config.stateDirectory),
    'Diagnostic ledger differs from configured state');
  const owner = ledger.acquire('diagnostic');
  let detail, started = false;
  const receiptPath = join(config.stateDirectory, 'diagnostic-result.json');
  try {
    const row = ledger.db.prepare('SELECT * FROM operations WHERE id=?').get(diagnosticId);
    requireThat(row?.kind === 'local-validation-diagnostic' && row.state === 'prepared',
      'Only a never-executed diagnostic may launch; no retry');
    detail = JSON.parse(row.detail);
    requireThat(detail.workspace === join(config.stateDirectory, 'w') &&
      detail.profilePath === join(config.stateDirectory, 'diagnostic-profile.ps1') &&
      detail.resultPath === join(config.stateDirectory, 'case-results.json') &&
      detail.cachePath === join(config.stateDirectory, 'jest-cache') &&
      detail.tracePath === join(config.stateDirectory, 'trace.jsonl') &&
      detail.diagnosticId === diagnosticId &&
      diagnosticId === `diagnostic-${hash(json(detail.input))}`,
    'Diagnostic runtime paths or identity changed');
    const prior = await verifyInputs(config, detail.input);
    requireThat(hash(json(detail.input)) === detail.inputSha256 &&
      prior.snapshotSha256 === detail.predecessorSha256 &&
      hash(readFileSync(detail.profilePath)) === detail.profileSha256 &&
      hash(diagnosticProfile(detail.input.test, detail.resultPath, detail.cachePath)) ===
        detail.profileSha256 &&
      json(prior.files.map(({ content, ...file }) => file)) === json(detail.files) &&
      !existsSync(detail.cachePath) && !existsSync(detail.tracePath) &&
      !existsSync(detail.resultPath) && !existsSync(detail.workspace),
    'Diagnostic inputs, predecessor or fresh execution paths changed');
    detail = { ...detail, startedAt: now(), pid: process.pid,
      execution: await roleExecutionIdentity('proposer'), phase: 'materialization' };
    ledger.finishOperation(diagnosticId, 'running', detail);
    started = true;
    const materialization = await materializeDiagnosticSnapshot(config, prior.job,
      prior.repo, prior.gate, detail.sourceRevision, detail.input.sealed.preparedReceipt.path,
      detail.workspace);
    for (const file of prior.files) {
      const path = join(detail.workspace, file.path);
      requireThat(hash(readFileSync(path)) === file.beforeSha256,
        'Diagnostic clone instrumentation base changed');
      writeFileSync(path, file.content);
    }

    const diffPath = join(config.stateDirectory, 'instrumentation.diff');
    writeFileSync(diffPath, await git(detail.workspace, ['diff', '--no-ext-diff', '--no-color']),
      { flag: 'wx', mode: 0o600 });
    const changed = (await git(detail.workspace, ['diff', '--name-only'])).split(/\r?\n/).sort();
    requireThat(json(changed) === json(prior.files.map(file => file.path).sort()),
      'Diagnostic instrumented an unexpected source file');
    const env = { ...minimalEnvironment(), [marker]: detail.tracePath };
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', detail.profilePath];
    detail = { ...detail, phase: 'diagnostic-case', caseStartedAt: now(), materialization,
      command: [prior.gate.executable, ...args], cacheInitiallyAbsent: !existsSync(detail.cachePath),
      diff: { path: diffPath, sha256: hash(readFileSync(diffPath)) } };
    ledger.finishOperation(diagnosticId, 'running', detail);
    let output, exitCode = 0, timedOut = false;
    try {
      output = await nativeCommand(prior.gate.executable, args, detail.workspace, prior.gate.timeoutMs, env);
    } catch (error) {
      output = { stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
      exitCode = typeof error.code === 'number' ? error.code : null;
      timedOut = Boolean(error.killed);
      if (exitCode === null && !timedOut) throw error;
    }
    const artifacts = [];
    for (const [name, value] of [['stdout.txt', output.stdout], ['stderr.txt', output.stderr]]) {
      const path = join(config.stateDirectory, name);
      writeFileSync(path, value, { flag: 'wx', mode: 0o600 });
      artifacts.push({ path, sha256: hash(readFileSync(path)) });
    }
    for (const path of [detail.tracePath, detail.resultPath])
      if (existsSync(path)) artifacts.push({ path, sha256: hash(readFileSync(path)) });
    requireThat(await git(detail.workspace, ['rev-parse', 'HEAD']) === detail.sourceRevision &&
      prior.files.every(file => hash(readFileSync(join(detail.workspace, file.path))) === file.afterSha256) &&
      json((await git(detail.workspace, ['diff', '--name-only'])).split(/\r?\n/).sort()) === json(changed) &&
      !await git(detail.workspace, ['ls-files', '--others', '--exclude-standard']),
    'Diagnostic source changed beyond its pinned instrumentation');
    requireThat((await inspectPredecessor(config, detail.input)).snapshotSha256 === detail.predecessorSha256,
      'Diagnostic predecessor changed during execution');
    const result = { ...detail, finishedAt: now(), phase: 'terminal', exitCode, timedOut,
      outcome: exitCode === 0 ? 'diagnostic-completed' : 'diagnostic-failed',
      artifacts, modelCalls: 0, caseCommandInvocations: 1, newCommits: 0,
      acceptanceEvidence: false, publicationEligible: false };
    writeFileSync(receiptPath, json(result), { flag: 'wx', mode: 0o600 });
    ledger.finishOperation(diagnosticId, 'completed', { ...result,
      receipt: { path: receiptPath, sha256: hash(readFileSync(receiptPath)) } });
    return result;
  } catch (error) {
    if (started) {
      const failed = { ...detail, finishedAt: now(), phase: 'blocked', error: safeError(error),
        acceptanceEvidence: false, publicationEligible: false };
      if (!existsSync(receiptPath)) writeFileSync(receiptPath, json(failed), { flag: 'wx', mode: 0o600 });
      ledger.finishOperation(diagnosticId, 'failed', failed);
    }
    throw error;
  } finally { ledger.release('diagnostic', owner); }
}

export function reconcileInterruptedLocalDiagnostic(ledger, diagnosticId, reason) {
  const row = ledger.db.prepare('SELECT * FROM operations WHERE id=?').get(diagnosticId);
  const detail = row ? JSON.parse(row.detail) : null;
  requireThat(row?.kind === 'local-validation-diagnostic' && row.state === 'running' &&
    detail.phase === 'materialization' && !detail.caseStartedAt &&
    typeof reason === 'string' && reason.trim().length >= 20 &&
    ![detail.tracePath, detail.resultPath, join(ledger.directory, 'instrumentation.diff'),
      join(ledger.directory, 'diagnostic-result.json')].some(existsSync),
  'Only a recorded pre-case diagnostic interruption can be reconciled');
  let dead = false;
  try { process.kill(detail.pid, 0); }
  catch (error) { if (error.code === 'ESRCH') dead = true; else throw error; }
  requireThat(dead, 'Diagnostic owner is still alive; never steal or restart it');
  const lock = ledger.db.prepare('SELECT * FROM locks WHERE name=?').get('diagnostic');
  if (lock) {
    requireThat(lock.pid === detail.pid, 'Diagnostic lock owner differs');
    ledger.recoverLock('diagnostic', lock.owner);
  }
  const result = { kind: 'pre-case-diagnostic-interruption', diagnosticId,
    originalOperation: row, originalDetail: detail, reconciledAt: now(), reason,
    caseCommandInvocations: 0, acceptanceEvidence: false, publicationEligible: false,
    limitation: 'No diagnostic test command was recorded or its output created; unrelated or unobserved external effects are not inferred.' };
  const path = join(ledger.directory, 'interruption.json');
  writeFileSync(path, json(result), { flag: 'wx', mode: 0o600 });
  ledger.finishOperation(diagnosticId, 'interrupted', result);
  return { path, sha256: hash(readFileSync(path)), diagnosticId, ...result };
}
