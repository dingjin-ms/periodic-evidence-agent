import { existsSync, readFileSync, realpathSync, writeFileSync, mkdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configAt, hash, json, now, requireThat, safeError, utc } from './common.js';
import { Ledger } from './ledger.js';
import { roleExecutionIdentity } from './role-replay.js';
import { verifyNativeWrapperContinuation } from './local-native-wrapper-continuation.js';
import { command, minimalEnvironment, materializeDiagnosticSnapshot, requireCurrentAssignment,
  verifyContinuationPredecessor, verifyPreservedChange, repoFor } from './workers.js';
import { nativeCommand } from './native-command.js';

const controllerRoot = fileURLToPath(new URL('..', import.meta.url));
const tracerPath = fileURLToPath(new URL('./launcher-trace.cjs', import.meta.url));
const git = async (cwd, args) => (await command('git',
  ['-c', 'core.longpaths=true', ...args], cwd, 120000, minimalEnvironment())).stdout.trim();
const reference = path => ({ path, sha256: hash(readFileSync(path)) });
const pin = ref => {
  requireThat(isAbsolute(ref?.path ?? '') && hash(readFileSync(ref.path)) === ref.sha256,
    'Launcher diagnostic evidence changed', 'blocked-reconciliation');
  return JSON.parse(readFileSync(ref.path));
};
export const launcherDiagnosticMethod = Object.freeze({
  kind: 'bounded-native-launcher-layer-progress', timeoutMs: 60000,
  maxModelAttempts: 0, maxCaseInvocations: 1, acceptanceEvidence: false, publicationEligible: false,
  stopCondition: 'Natural first-leg exit or contained 60-second deadline; no retry',
  instrumentation: 'NODE_OPTIONS preload on the first Node launcher only; no inspector; bounded module, command and mkdir-error traces',
  unchanged: 'Native first-leg profile prefix, selected test, assertions and case timeout; matched private placement lengths'
});

export function nativeWrapperResultName(profile) {
  const matches = [...profile.matchAll(/^    \$scopedPath = Join-Path \$PSScriptRoot '([A-Za-z0-9._-]+\.json)'\r?$/gm)];
  requireThat(matches.length === 1, 'Native profile requires one exact wrapper result boundary');
  return matches[0][1];
}

export function launcherDiagnosticProfile(profile) {
  const boundary = `    $scopedPath = Join-Path $PSScriptRoot '${nativeWrapperResultName(profile)}'`;
  requireThat(profile.split(boundary).length === 2 &&
    profile.includes("$env:OAGENT_ADO_ARTIFACTS_AUTHENTICATED = '1'") &&
    profile.includes("test:integration `") && profile.includes('PILOT_CHANGED_CASE:'),
  'Launcher diagnostic requires the exact native first-leg boundary');
  return profile.slice(0, profile.indexOf(boundary)) + '}\n';
}

export function verifyLauncherTimeout(report, artifact) {
  const result = report.workerResult;
  requireThat(result?.outcome === 'blocked' && result.draftPR === null &&
    result.toolUsage?.used === 0 && result.toolUsage.rounds.length === 0 &&
    result.validation?.length === 1 && result.validationAttempts?.length === 1 &&
    result.validation[0].status === 'blocked' && result.validation[0].blockedReason === 'runner-timeout' &&
    result.validation[0].attemptCount === 1 && artifact.attempt === 0 &&
    artifact.status === 'blocked' && artifact.blockedReason === 'runner-timeout' &&
    artifact.revision === result.sourceRevision && artifact.output.timeout === true &&
    artifact.output.exitCode === null && report.nativeTransform === null &&
    report.publication.remoteBranchPresent === false && report.publication.matchingPRsAcrossAllStatuses === 0 &&
    report.processTermination.activePreTerminalProcesses.length === 0 &&
    !report.operations.some(row => ['commit', 'push', 'draft-pr'].includes(row.kind)),
  'Launcher diagnostic requires a sealed drained zero-model native timeout, never a validation pass');
}

function matchedPath(root, lane, original) {
  const prefix = join(root, lane), size = original.length - prefix.length - 1;
  requireThat(size > 0 && size < 160, 'Diagnostic placement cannot match original path length');
  return join(prefix, 'd'.repeat(size));
}

async function inspect(config, input) {
  requireThat(input && Object.keys(input).sort().join(',') ===
    'authorization,previousAssignmentId,previousConfigPath,sealed' &&
    isAbsolute(input.previousConfigPath ?? ''), 'Exact launcher diagnostic input required');
  const auth = input.authorization, refs = input.sealed;
  requireThat(refs && Object.keys(refs).sort().join(',') ===
    'launcherDiagnosis,nativeArtifact,preparedReceipt,terminalReport,userAuthorization',
  'Exact sealed launcher evidence references required');
  const grant = pin(refs.userAuthorization), report = pin(refs.terminalReport);
  const diagnosis = pin(refs.launcherDiagnosis), artifact = pin(refs.nativeArtifact), prepared = pin(refs.preparedReceipt);
  requireThat(auth?.kind === 'native-launcher-timeout-diagnostic' && auth.approved === true &&
    auth.authorizedBy === 'user' && grant.userResponse === 'all runs authorized' &&
    auth.nextConfigSha256 === hash(json(config)) && auth.evidenceSha256 === hash(json(refs)) &&
    auth.methodSha256 === hash(json(launcherDiagnosticMethod)) &&
    auth.tracerSha256 === hash(readFileSync(tracerPath)), 'Hash-bound launcher diagnostic authority required');
  utc(auth.recordedAt);
  requireThat(Date.parse(auth.recordedAt) >= Date.parse(report.reportedAt) &&
    Date.parse(auth.recordedAt) <= Date.now() + 60000, 'Launcher diagnostic authorization time invalid');
  requireThat(await git(controllerRoot, ['rev-parse', 'HEAD']) === auth.controllerRevision &&
    !await git(controllerRoot, ['status', '--porcelain']), 'Launcher diagnostic requires its clean controller pin');
  const previousConfig = configAt(input.previousConfigPath);
  requireThat(json({ ...config, stateDirectory: null, activation: null }) ===
    json({ ...previousConfig, stateDirectory: null, activation: null }) &&
    Object.values(config.activation).every(value => value === false) &&
    config.limits.maxAiCreditsPerSession <= 100 && config.limits.maxValidationRepairRounds === 0 &&
    config.limits.maxValidationInfrastructureRetries === 0 &&
    [relative(config.stateDirectory, previousConfig.stateDirectory),
      relative(previousConfig.stateDirectory, config.stateDirectory)].every(path => path.startsWith('..')),
  'Launcher diagnostic must use separate state, disable roles and preserve configuration');
  verifyLauncherTimeout(report, artifact);
  requireThat(diagnosis.kind === 'post-timeout-read-only-launcher-diagnosis' &&
    json(diagnosis.terminal) === json(refs.terminalReport) &&
    diagnosis.attemptId === report.attemptId && pin(diagnosis.cleanup) &&
    artifact.telemetry.preparedReceipt === refs.preparedReceipt.path &&
    prepared.type === 'compile' && prepared.preparedFromRevision === report.sourceRevision &&
    report.workerResult.validation[0].artifactRefs.includes(refs.nativeArtifact.path),
  'Launcher diagnosis must bind the sealed timeout, cleanup and exact compiled source');
  for (const ref of [diagnosis.sourceMetadata.corepack, diagnosis.sourceMetadata.yarnCurrent,
    diagnosis.sourceMetadata.yarnPrior])
    requireThat(hash(readFileSync(ref.path)) === ref.sha256, 'Pinned launcher bytes changed');
  for (const ref of report.rawArtifacts) requireThat(hash(readFileSync(ref.path)) === ref.sha256,
    'Launcher predecessor raw evidence changed');
  const ledger = new Ledger(previousConfig.stateDirectory, { readOnly: true });
  try {
    const id = input.previousAssignmentId, job = ledger.job(id), assignment = ledger.get('assignment', id);
    const results = ledger.all('workerResult').filter(row => row.assignmentId === id);
    const operations = ledger.status().operations.filter(row => row.job_id === id);
    requireThat(job?.state === 'blocked' && job.session_id === report.attemptId &&
      report.assignmentId === id && assignment?.execution === 'local' && assignment.repoId === 'office-agent' &&
      results.length === 1 && json(results[0]) === json(report.workerResult) &&
      json(operations.map(row => ({ ...row, detail: JSON.parse(row.detail) }))) === json(report.operations),
    'Launcher diagnostic predecessor changed after terminal reconciliation');
    const row = operations.find(row => row.kind === 'continued-from-validation-failure');
    requireThat(row?.state === 'prepared', 'Launcher diagnostic requires preserved continuation lineage');
    const detail = JSON.parse(row.detail);
    verifyContinuationPredecessor(detail, row.id, job.session_id);
    verifyNativeWrapperContinuation(previousConfig, detail);
    requireCurrentAssignment(previousConfig, ledger, ledger.get('investigation', assignment.investigationId), assignment);
    const files = await verifyPreservedChange(previousConfig, assignment, job, results[0], detail.proposal);
    const repo = repoFor(previousConfig, assignment.repoId), gate = repo.validationGates[0];
    const root = config.stateDirectory;
    const profileDirectory = matchedPath(root, 'p', join(dirname(refs.preparedReceipt.path), 'validation-profiles'));
    const paths = {
      workspace: matchedPath(root, 'w', join(dirname(refs.preparedReceipt.path), 'w')),
      temporaryDirectory: matchedPath(root, 't', artifact.telemetry.successorNative.temporaryDirectory),
      profileDirectory, profilePath: join(profileDirectory, 'launcher-profile.ps1'),
      tracePath: join(root, 'launcher-trace.jsonl')
    };
    return { job, assignment, repo, gate, files, paths, sourceRevision: results[0].sourceRevision,
      predecessorSha256: hash(json({ job, assignment, results, operations })),
      profile: launcherDiagnosticProfile(readFileSync(gate.profilePath, 'utf8')) };
  } finally { ledger.close(); }
}

export async function prepareLauncherDiagnostic(config, ledger, input) {
  requireThat(realpathSync(ledger.directory) === realpathSync(config.stateDirectory), 'Diagnostic ledger mismatch');
  const owner = ledger.acquire('diagnostic');
  try {
    const state = ledger.status();
    requireThat(!state.jobs.length && !state.counts.length && !state.operations.length && !state.runs.length,
      'Launcher diagnostic requires a fresh empty ledger; no replay');
    const prior = await inspect(config, input);
    requireThat(Object.values(prior.paths).every(path => !existsSync(path)), 'Fresh diagnostic paths required');
    const diagnosticId = `launcher-diagnostic-${hash(json(input))}`;
    const detail = { diagnosticId, input, inputSha256: hash(json(input)), ...prior.paths,
      sourceRevision: prior.sourceRevision, predecessorSha256: prior.predecessorSha256, files: prior.files,
      profileSha256: hash(prior.profile), method: launcherDiagnosticMethod, preparedAt: now(),
      execution: await roleExecutionIdentity('proposer'), acceptanceEvidence: false, publicationEligible: false };
    ledger.operation(diagnosticId, input.previousAssignmentId, 'local-launcher-diagnostic', detail);
    mkdirSync(prior.paths.profileDirectory, { recursive: true });
    writeFileSync(detail.profilePath, prior.profile, { flag: 'wx', mode: 0o600 });
    ledger.finishOperation(diagnosticId, 'prepared', detail);
    return detail;
  } finally { ledger.release('diagnostic', owner); }
}

export async function dispatchLauncherDiagnostic(config, ledger, diagnosticId) {
  requireThat(realpathSync(ledger.directory) === realpathSync(config.stateDirectory), 'Diagnostic ledger mismatch');
  const owner = ledger.acquire('diagnostic');
  let detail, started = false;
  try {
    const row = ledger.db.prepare('SELECT * FROM operations WHERE id=?').get(diagnosticId);
    requireThat(row?.kind === 'local-launcher-diagnostic' && row.state === 'prepared',
      'Only a never-executed prepared launcher diagnostic may run');
    detail = JSON.parse(row.detail);
    const prior = await inspect(config, detail.input);
    requireThat(diagnosticId === `launcher-diagnostic-${hash(json(detail.input))}` &&
      detail.inputSha256 === hash(json(detail.input)) && detail.predecessorSha256 === prior.predecessorSha256 &&
      json(detail.files) === json(prior.files) && json(detail.method) === json(launcherDiagnosticMethod) &&
      Object.entries(prior.paths).every(([key, value]) => detail[key] === value) &&
      hash(readFileSync(detail.profilePath)) === detail.profileSha256 &&
      detail.profileSha256 === hash(prior.profile) &&
      [detail.workspace, detail.temporaryDirectory, detail.tracePath].every(path => !existsSync(path)),
    'Launcher diagnostic preparation or immutable predecessor changed');
    detail = { ...detail, phase: 'materialization', startedAt: now(), pid: process.pid,
      execution: await roleExecutionIdentity('proposer') };
    ledger.finishOperation(diagnosticId, 'running', detail); started = true;
    const materialization = await materializeDiagnosticSnapshot(config, prior.job, prior.repo, prior.gate,
      detail.sourceRevision, detail.input.sealed.preparedReceipt.path, detail.workspace);
    mkdirSync(detail.temporaryDirectory, { recursive: true });
    const env = { ...minimalEnvironment(), PILOT_VALIDATION_STAGE: 'test',
      TEMP: detail.temporaryDirectory, TMP: detail.temporaryDirectory, TMPDIR: detail.temporaryDirectory,
      NODE_OPTIONS: `--require=${JSON.stringify(tracerPath)}`,
      PILOT_LAUNCHER_DIAGNOSTIC: json({ directory: config.stateDirectory }) };
    const args = ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', detail.profilePath];
    detail = { ...detail, phase: 'launcher', launcherStartedAt: now(), materialization,
      command: [prior.gate.executable, ...args], environmentNames: Object.keys(env).sort(),
      additionalNodeOptions: env.NODE_OPTIONS, modelCalls: 0, newCommits: 0 };
    ledger.finishOperation(diagnosticId, 'running', detail);
    let output, exitCode = 0, timedOut = false;
    try {
      const execution = nativeCommand(prior.gate.executable, args, detail.workspace,
        launcherDiagnosticMethod.timeoutMs, env);
      detail.supervisorPid = execution.child.pid;
      ledger.finishOperation(diagnosticId, 'running', detail);
      output = await execution;
    } catch (error) {
      output = { stdout: error.stdout ?? '', stderr: error.stderr ?? '' };
      exitCode = typeof error.code === 'number' ? error.code : null;
      timedOut = Boolean(error.killed);
      if (exitCode === null && !timedOut) throw error;
    }
    const artifacts = [];
    for (const [name, text] of [['stdout.txt', output.stdout], ['stderr.txt', output.stderr]]) {
      const path = join(config.stateDirectory, name);
      writeFileSync(path, text, { flag: 'wx', mode: 0o600 }); artifacts.push(reference(path));
    }
    const outputNames = [...prior.profile.matchAll(/Join-Path \$PSScriptRoot '([A-Za-z0-9._-]+\.json)'/g)]
      .map(match => match[1]);
    for (const path of [detail.tracePath,
      ...new Set(outputNames.map(name => join(detail.profileDirectory, name)))])
      if (existsSync(path)) artifacts.push(reference(path));
    requireThat(await git(detail.workspace, ['rev-parse', 'HEAD']) === detail.sourceRevision &&
      !await git(detail.workspace, ['status', '--porcelain']) &&
      (await inspect(config, detail.input)).predecessorSha256 === detail.predecessorSha256,
    'Launcher diagnostic or predecessor source changed during execution');
    const result = { ...detail, finishedAt: now(), phase: 'terminal', exitCode, timedOut, artifacts,
      firstLegCommandInvocations: 1, caseEntry: 'consult-raw-evidence',
      outcome: exitCode === 0 ? 'diagnostic-completed' : 'diagnostic-failed' };
    const receiptPath = join(config.stateDirectory, 'diagnostic-result.json');
    writeFileSync(receiptPath, json(result), { flag: 'wx', mode: 0o600 });
    const receipt = reference(receiptPath);
    ledger.finishOperation(diagnosticId, 'completed', { ...result, receipt });
    return { ...result, receipt };
  } catch (error) {
    if (started) ledger.finishOperation(diagnosticId, 'failed', { ...detail, finishedAt: now(),
      error: safeError(error), acceptanceEvidence: false, publicationEligible: false });
    throw error;
  } finally { ledger.release('diagnostic', owner); }
}
