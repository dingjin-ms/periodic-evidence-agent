import { createHash } from 'node:crypto';
import { execFile, spawn } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { DatabaseSync } from 'node:sqlite';
import { promisify } from 'node:util';
import { hash, json, now, PilotError, requireThat, safeError, utc } from './common.js';
import { completeRunEvidence } from './state-retention.js';
import {
  inspectRsiPath, metricContract, nextSelfImprovementVersion, persistSelfImprovementArtifact,
  reserveSelfImprovementEvaluation, rsiDirectoryBytes, selfImprovementFixture,
  selfImprovementIdentity, selfImprovementOperation, selfImprovementWorkload,
  updateSelfImprovementOperation
} from './self-improvement.js';

const execute = promisify(execFile);
const runner = fileURLToPath(new URL('./self-improvement-candidate-runner.js', import.meta.url));
const inputBytes = Buffer.from('synthetic native input\n');
const pointer = `version https://git-lfs.github.com/spec/v1\noid sha256:${hash(inputBytes)}\nsize ${inputBytes.length}`;
const arms = ['old', 'updated'];
const categories = ['completed', 'valid-unsuccessful', 'expected-guard-refusal',
  'invalid-harness', 'unknown', 'not-run'];
const artifactName = (arm, episode) => `${arm}-${episode.id}.json`;

export function fixtureEnvironment(root) {
  const home = join(root, 'home');
  mkdirSync(join(home, 'empty'), { recursive: true });
  writeFileSync(join(home, 'gitconfig'), '', { flag: 'wx' });
  const env = {};
  for (const [key, value] of Object.entries(process.env))
    if (['path', 'systemroot', 'windir', 'comspec', 'pathext', 'lang', 'lc_all']
      .includes(key.toLowerCase())) env[key] = value;
  return { ...env, HOME: home, USERPROFILE: home, XDG_CONFIG_HOME: home, TEMP: home, TMP: home,
    GIT_CONFIG_NOSYSTEM: '1', GIT_CONFIG_GLOBAL: join(home, 'gitconfig'),
    GIT_TEMPLATE_DIR: join(home, 'empty'), GIT_TERMINAL_PROMPT: '0', GIT_ALLOW_PROTOCOL: 'file',
    GIT_LFS_SKIP_SMUDGE: '1', GIT_CONFIG_COUNT: '1',
    GIT_CONFIG_KEY_0: 'credential.helper', GIT_CONFIG_VALUE_0: '',
    GIT_AUTHOR_DATE: '2000-01-01T00:00:00Z', GIT_COMMITTER_DATE: '2000-01-01T00:00:00Z' };
}

async function terminateOwnedChild(child) {
  if (child.exitCode !== null || child.signalCode !== null) return;
  if (process.platform === 'win32') {
    try {
      await execute('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
        windowsHide: true, timeout: 5000, maxBuffer: 16384
      });
    } catch (error) {
      if (child.exitCode === null && child.signalCode === null) throw error;
    }
  } else {
    try { process.kill(-child.pid, 'SIGKILL'); }
    catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export function validChildEnvelope(message, mode) {
  return message && json(Object.keys(message).sort()) ===
    json(['mode', 'protocol', 'result', 'type']) &&
    message.type === 'finished' && message.protocol === 'self-improvement-child-v1' &&
    message.mode === mode && message.result && typeof message.result === 'object' &&
    ['completed', 'failed', 'target-failed', 'fixture-failed'].includes(message.result.status) &&
    Object.keys(message.result).every(key => (mode === 'readiness-control' ?
      ['status', 'readiness'] : ['status', 'code', 'workerOutcome']).includes(key)) &&
    (mode !== 'readiness-control' ||
      ['unproven', 'passed', 'failed', 'blocked'].includes(message.result.readiness)) &&
    Object.values(message.result).every(value => typeof value === 'string' && value.length <= 120);
}

class ExecutionStopped extends PilotError {
  constructor(reason) {
    super('stopped-rsi-execution', 'RSI execution stopped before further work could be admitted');
    this.reason = reason;
  }
}

function remainingExecutionMs(deadline, signal) {
  const remaining = deadline - performance.now();
  if (signal?.aborted || remaining <= 0)
    throw new ExecutionStopped(signal?.aborted && signal.reason !== 'timeout' ? 'owner-stopped' : 'timeout');
  return Math.ceil(remaining);
}

export async function runRsiChild({
  mode, input, cwd, env, timeoutMs, maxOutputBytes, onRequest = null,
  onStart = () => {}, onExit = () => {}, deadline, signal
}) {
  requireThat(['controller', 'native', 'readiness-control'].includes(mode) &&
    Number.isInteger(timeoutMs) && timeoutMs > 0 && Number.isInteger(maxOutputBytes) && maxOutputBytes > 0 &&
    (deadline === undefined || Number.isFinite(deadline)),
  'A finite fixed child profile is required', 'blocked-budget');
  const started = performance.now();
  const end = Math.min(deadline ?? Infinity, started + timeoutMs);
  const startedAt = now();
  remainingExecutionMs(end, signal);
  const child = spawn(process.execPath, [runner, mode], {
    cwd, env, windowsHide: true, shell: false, detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe', 'ipc']
  });
  const output = { stdoutBytes: 0, stderrBytes: 0, protocolBytes: 0 };
  const digests = { stdout: createHash('sha256'), stderr: createHash('sha256') };
  const captured = { stdout: [], stderr: [] };
  let capturedBytes = 0;
  let terminal = null, reason = null, killFailure = false, busy = false, expectedSequence = 1;
  let processing = Promise.resolve(), stopping = Promise.resolve();
  let dispositionTimer;
  let uncertainDisposition;
  const disposition = new Promise(resolve => { uncertainDisposition = resolve; });
  const nativeEvents = [];
  const requests = new AbortController();
  const stop = cause => {
    if (reason) return;
    reason = cause;
    requests.abort(cause);
    if (child.pid) stopping = terminateOwnedChild(child).catch(() => { killFailure = true; });
    dispositionTimer = setTimeout(() => {
      killFailure = true;
      uncertainDisposition({ code: null, signal: null, exited: false });
    }, 6000);
  };
  const ownerStopped = () => stop(signal.reason === 'timeout' ? 'timeout' : 'owner-stopped');
  signal?.addEventListener('abort', ownerStopped, { once: true });
  const active = () => {
    if (reason) return false;
    try { remainingExecutionMs(end, requests.signal); return true; }
    catch (error) {
      if (!(error instanceof ExecutionStopped)) throw error;
      stop(error.reason);
      return false;
    }
  };
  const account = () => {
    if (output.stdoutBytes + output.stderrBytes + output.protocolBytes > maxOutputBytes)
      stop('output-limit');
  };
  for (const stream of ['stdout', 'stderr']) child[stream].on('data', bytes => {
    output[`${stream}Bytes`] += bytes.length;
    digests[stream].update(bytes);
    const retained = bytes.subarray(0, Math.max(0, maxOutputBytes - capturedBytes));
    if (retained.length) captured[stream].push(retained);
    capturedBytes += retained.length;
    account();
  });
  child.on('message', message => {
    output.protocolBytes += Buffer.byteLength(json(message));
    account();
    if (!active()) return;
    if (message?.type === 'finished') {
      if (terminal || busy || !validChildEnvelope(message, mode)) stop('invalid-terminal-envelope');
      else terminal = message;
    } else if (mode === 'native' && message?.type === 'native-case') {
      if (terminal || json(Object.keys(message).sort()) !==
        json(['diagnostic', 'event', 'name', 'nesting', 'skip', 'todo', 'type']) ||
        !['test:start', 'test:pass', 'test:fail'].includes(message.event) ||
        typeof message.name !== 'string' || typeof message.skip !== 'boolean' ||
        typeof message.todo !== 'boolean' || !Number.isInteger(message.nesting) ||
        !(message.diagnostic === null || typeof message.diagnostic === 'string' && message.diagnostic.length <= 1000))
        stop('invalid-native-event');
      else nativeEvents.push(message);
    } else if (mode === 'controller' && message?.type === 'request' && onRequest) {
      if (terminal || busy || message.id !== expectedSequence++ ||
        json(Object.keys(message).sort()) !== json(['id', 'kind', 'payload', 'type']) ||
        typeof message.kind !== 'string' || !message.payload || typeof message.payload !== 'object')
        stop('invalid-request-protocol');
      else {
        busy = true;
        processing = Promise.resolve().then(() => {
          remainingExecutionMs(end, requests.signal);
          return onRequest(message, { signal: requests.signal, stop });
        }).then(value => {
          if (active() && child.connected) child.send({ type: 'reply', id: message.id, value }, error => {
            if (error) stop('reply-failed');
          });
        }, error => {
          if (error instanceof ExecutionStopped) { stop(error.reason); return; }
          if (active() && child.connected) child.send({ type: 'reply', id: message.id,
            error: safeError(error).code }, sendError => {
            if (sendError) stop('reply-failed');
          });
        }).finally(() => { busy = false; });
      }
    } else stop('unexpected-child-message');
  });
  const closed = new Promise(resolve => {
    child.once('error', () => stop('child-start-failed'));
    child.once('close', (code, exitSignal) => {
      if (!reason && performance.now() >= end) stop('timeout');
      if (busy && !reason) stop(exitSignal ? 'owner-stopped' : 'child-exit');
      requests.abort(reason ?? 'owner-stopped');
      resolve({ code, signal: exitSignal, exited: true });
    });
  });
  const timer = setTimeout(() => stop('timeout'), Math.max(0, end - performance.now()));
  try {
    if (child.pid) {
      onStart({ pid: child.pid, mode, startedAt, exited: false });
      if (signal?.aborted) ownerStopped();
      if (active()) child.send({ type: 'start', input }, error => { if (error) stop('child-start-failed'); });
    }
  } catch (error) {
    stop('ownership-record-failed');
    await stopping;
    await Promise.race([closed, disposition]);
    clearTimeout(timer);
    clearTimeout(dispositionTimer);
    signal?.removeEventListener('abort', ownerStopped);
    throw error;
  }
  const exit = await Promise.race([closed, disposition]);
  clearTimeout(timer);
  clearTimeout(dispositionTimer);
  await stopping;
  await processing;
  signal?.removeEventListener('abort', ownerStopped);
  if (exit.exited)
    onExit({ pid: child.pid ?? null, mode, exited: true, exitCode: exit.code, signal: exit.signal });
  else {
    if (child.connected) child.disconnect();
    child.stdout.destroy();
    child.stderr.destroy();
    child.unref();
  }
  reason ??= !terminal ? 'missing-terminal-envelope' :
    terminal.result.status === 'fixture-failed' ? 'fixture-failed' :
      exit.code !== 0 && !(mode === 'native' && terminal.result.status === 'failed') ? 'child-exit' : null;
  return {
    state: killFailure || ['timeout', 'owner-stopped'].includes(reason) || exit.signal && !reason ? 'unknown' :
      reason ? 'invalid' : 'completed',
    reason: killFailure ? 'child-fate-unconfirmed' : reason,
    pid: child.pid ?? null, startedAt, exited: exit.exited,
    exitCode: exit.code, signal: exit.signal, terminal, nativeEvents,
    elapsedMs: Math.round((performance.now() - started) * 1000) / 1000,
    output: { ...output, stdoutSha256: digests.stdout.digest('hex'), stderrSha256: digests.stderr.digest('hex'),
      stdoutBase64: Buffer.concat(captured.stdout).toString('base64'),
      stderrBase64: Buffer.concat(captured.stderr).toString('base64'),
      truncated: capturedBytes < output.stdoutBytes + output.stderrBytes }
  };
}

function requiredCases(workload) { return workload.coverage.required.map(item => item.caseId); }

export function nativeCaseOutcomes(native, identity, expectedRevision, workload = selfImprovementWorkload()) {
  const expected = requiredCases(workload);
  if (!native) return expected.map(id => ({ id, status: 'not-run', started: false }));
  const events = native?.process?.nativeEvents ?? [];
  const unexpected = events.some(event => !expected.includes(event.name) || event.nesting !== 0);
  const binding = native?.testSha256 === identity.nativeTestSha256 &&
    native?.inputSha256 === hash(inputBytes) && typeof expectedRevision === 'string' &&
    /^[a-f0-9]{40,64}$/.test(expectedRevision) && native.revision === expectedRevision;
  return expected.map(id => {
    const starts = events.filter(event => event.name === id && event.event === 'test:start');
    const ends = events.filter(event => event.name === id && ['test:pass', 'test:fail'].includes(event.event));
    const skipped = [...starts, ...ends].some(event => event.skip || event.todo);
    let status = 'not-run';
    if (!binding || unexpected || starts.length > 1 || ends.length > 1) status = 'unknown';
    else if (skipped) status = 'skipped';
    else if (starts.length === 1 && ends.length === 1)
      status = ends[0].event === 'test:pass' ? 'passed' : 'failed';
    else if (native) status = 'unknown';
    return { id, status,
      started: binding && !unexpected && !skipped && starts.length === 1 && ends.length <= 1 };
  });
}

function nativePassed(native, cases) {
  return native?.process?.state === 'completed' && native.process.exitCode === 0 &&
    native.process.terminal?.result.status === 'completed' &&
    cases.every(item => item.status === 'passed');
}

async function inspectFixture(root, name, git) {
  const directory = join(root, name), database = join(directory, 'ledger.sqlite');
  if (!existsSync(database)) return null;
  inspectRsiPath(root, database);
  const db = new DatabaseSync(database, { readOnly: true });
  let snapshot;
  try {
    snapshot = {
      jobs: db.prepare('SELECT * FROM jobs ORDER BY id').all(),
      results: db.prepare("SELECT body FROM records WHERE kind='workerResult' ORDER BY id,version")
        .all().map(row => JSON.parse(row.body)),
      operations: db.prepare('SELECT * FROM operations ORDER BY id').all()
        .map(row => ({ ...row, detail: JSON.parse(row.detail) })),
      source: null
    };
  } finally { db.close(); }
  const job = snapshot.jobs.length === 1 ? snapshot.jobs[0] : null;
  if (job?.workspace) {
    inspectRsiPath(root, job.workspace, { directory: true });
    const head = await git(job.workspace, ['rev-parse', 'HEAD']);
    const testPath = join(job.workspace, 'test', 'case.test.mjs');
    snapshot.source = {
      head, clean: !(await git(job.workspace, ['status', '--porcelain'])),
      baseRevision: job.base_revision,
      testSha256: existsSync(testPath) ? hash(readFileSync(inspectRsiPath(root, testPath))) : null,
      pointer: await git(job.workspace, ['show', `${head}:fixtures/native.xlsx`]),
      commitCount: Number(await git(job.workspace, ['rev-list', '--count', `${job.base_revision}..${head}`])),
      title: await git(job.workspace, ['show', '-s', '--format=%s', 'HEAD'])
    };
  }
  return snapshot;
}

function verifyFixtureConfig(root, name) {
  const config = JSON.parse(readFileSync(inspectRsiPath(root, join(root, `${name}-config.json`)), 'utf8'));
  const repo = config.repositories?.[0], gate = repo?.validationGates?.[0];
  requireThat(config.repositories?.length === 1 && repo.id === 'fixture' &&
    repo.referenceCheckout === join(root, 'reference') && repo.remote === join(root, 'remote.git') &&
    repo.qualificationRefresh === 'local' && !repo.draftBuild &&
    config.stateDirectory === join(root, name) &&
    !config.activation.collect && !config.activation.review && config.activation.dispatch &&
    Object.values(config.sources).every(source => source.enabled === false) &&
    Object.keys(config.authoringProviders).length === 0 && !config.workspaceCleanup.enabled &&
    config.limits.maxValidationRepairRounds === 0 &&
    config.limits.maxValidationInfrastructureRetries === 0 &&
    repo.validationGates.length === 1 && gate.id === 'native' &&
    gate.executable === process.execPath && json(gate.args) === json(['--test', 'test/case.test.mjs']) &&
    Object.keys(gate).every(key =>
      ['id', 'approved', 'isolationVerified', 'executable', 'args', 'timeoutMs', 'lfsPaths'].includes(key)),
  'Synthetic configuration boundary mismatch', 'invalid-fixture');
  return config;
}

function sourceBound(snapshot, identity) {
  return snapshot?.jobs.length === 1 && snapshot.results.length === 1 &&
    snapshot.source?.clean && snapshot.source.testSha256 === identity.nativeTestSha256 &&
    snapshot.source.pointer === pointer && snapshot.source.commitCount === 1 &&
    snapshot.source.title === 'Add synthetic native assertions' &&
    snapshot.results[0].sourceRevision === snapshot.source.head;
}

function initialFailure(snapshot, identity) {
  const result = snapshot?.results[0];
  return sourceBound(snapshot, identity) && snapshot.jobs[0].state === 'blocked' &&
    result.outcome === 'blocked' && result.validationAttempts.length === 1 &&
    result.validation.length === 1 && result.validation[0].status === 'failed' &&
    result.toolUsage.rounds.length === 1 && result.toolUsage.rounds[0].status === 'completed' &&
    result.toolUsage.byTool.pilot_write === 1 && result.toolUsage.byTool.pilot_finish === 1 &&
    snapshot.operations.filter(item => item.kind === 'commit' && item.state === 'completed').length === 1 &&
    !snapshot.operations.some(item => ['push', 'create-pr'].includes(item.kind));
}

function unchangedPrior(before, after) {
  return before && after && json(before.jobs) === json(after.jobs) &&
    json(before.results) === json(after.results) && json(before.source) === json(after.source) &&
    json(before.operations) === json(after.operations.filter(item => item.kind !== 'validation-continuation'));
}

function blankEvidence(arm, episode) {
  return { arm, episodeId: episode.id, execution: { state: 'not-run', reason: 'not-started' },
    trace: [], snapshots: {}, native: [], effects: [], guards: [], violations: [], unblock: null };
}

async function executeEpisode(store, experiment, arm, episode, allocation, deadline, fault) {
  const root = join(allocation, `${arm}-${episode.id}`);
  mkdirSync(root);
  const env = fixtureEnvironment(root);
  const evidence = blankEvidence(arm, episode);
  const end = Math.min(deadline, performance.now() + store.policy.limits.caseTimeoutMs);
  const git = async (cwd, args, signal) => {
    const timeout = Math.min(10000, remainingExecutionMs(end, signal));
    try {
      return (await execute('git', ['--no-pager', '--no-optional-locks',
        '-c', 'core.hooksPath=.git/no-hooks', '-c', 'core.autocrlf=false',
        '-c', 'core.safecrlf=false', ...args], {
        cwd, env, signal, encoding: 'utf8', windowsHide: true, timeout,
        maxBuffer: store.policy.limits.maxOutputBytes
      })).stdout.trim();
    } catch (error) {
      remainingExecutionMs(end, signal);
      throw error;
    }
  };
  const recordStart = child => {
    const operation = selfImprovementOperation(store, experiment);
    updateSelfImprovementOperation(store, experiment, {
      children: [...operation.detail.children, { ...child, arm, episodeId: episode.id }]
    });
  };
  const recordExit = child => {
    const operation = selfImprovementOperation(store, experiment);
    updateSelfImprovementOperation(store, experiment, {
      children: operation.detail.children.map(item => item.pid === child.pid &&
        item.arm === arm && item.episodeId === episode.id ? { ...item, ...child } : item)
    });
  };
  const snapshot = (name, signal) => {
    remainingExecutionMs(end, signal);
    return inspectFixture(root, name, (cwd, args) => git(cwd, args, signal));
  };
  const observeSnapshots = async (phase, signal) => {
    const observed = {};
    evidence.snapshots[phase] = observed;
    observed.prior = await snapshot('prior', signal);
    observed.next = await snapshot('next', signal);
    return observed;
  };
  const request = async (message, { signal, stop }) => {
    const entry = { sequence: message.id, phase: message.payload.phase ?? message.kind,
      operationKind: message.kind, sourceRevision: message.payload.revision ?? null,
      outcome: 'pending', observedAt: now() };
    evidence.trace.push(entry);
    try {
      remainingExecutionMs(end, signal);
      const fields = {
        checkpoint: ['phase'], 'deterministic-authoring': [], unblock: [],
        validation: ['phase', 'revision'], push: [], draft: ['revision'],
        'guard-start': ['guard'], 'guard-refusal': ['code', 'guard']
      }[message.kind];
      requireThat(fields && json(Object.keys(message.payload).sort()) === json(fields),
        'Unsupported boundary request or payload', fields ? 'invalid-fixture' : 'unsupported-action');
      requireThat(rsiDirectoryBytes(allocation) <= store.policy.limits.maxFixtureBytes,
        'Synthetic fixture storage ceiling reached', 'blocked-budget');
      const payload = message.payload;
      let response = null;
      if (message.kind === 'checkpoint') {
        requireThat(['prepared', 'initial-complete', 'continuation-prepared', 'continued'].includes(payload.phase) &&
          !evidence.snapshots[payload.phase], 'Repeated/unrecognized fixture checkpoint', 'invalid-fixture');
        verifyFixtureConfig(root, 'prior');
        const observed = await observeSnapshots(payload.phase, signal);
        entry.attemptReference = (observed.next?.jobs[0] ?? observed.prior?.jobs[0])?.session_id ?? null;
      } else if (message.kind === 'deterministic-authoring') {
        requireThat(evidence.trace.filter(item => item.operationKind === message.kind).length === 1,
          'Repeated deterministic authoring', 'invalid-fixture');
      } else if (message.kind === 'unblock') {
        requireThat(!evidence.unblock &&
          initialFailure(evidence.snapshots['initial-complete']?.prior, experiment.identity),
        'Missing exact authored pre-test failure', 'invalid-fixture');
        const nextConfig = verifyFixtureConfig(root, 'next');
        const prior = evidence.snapshots['initial-complete'].prior;
        entry.attemptReference = prior.jobs[0].session_id;
        entry.sourceRevision = prior.source.head;
        const proposal = JSON.parse(readFileSync(inspectRsiPath(root, join(root, 'proposal.json')), 'utf8'));
        remainingExecutionMs(end, signal);
        writeFileSync(join(root, 'verified-object.bin'), inputBytes, { flag: 'wx' });
        requireThat(hash(readFileSync(join(root, 'verified-object.bin'))) === hash(inputBytes),
          'Synthetic object integrity mismatch', 'invalid-fixture');
        const proof = {
          state: 'passed', clean: true, revision: prior.source.head,
          nativeValidationInvoked: false, modelInvoked: false, publicationInvoked: false,
          materialization: { revision: prior.source.head,
            objects: [{ path: 'fixtures/native.xlsx', oid: hash(inputBytes), size: inputBytes.length }] }
        };
        const proofPath = join(root, 'proof.json');
        remainingExecutionMs(end, signal);
        writeFileSync(proofPath, json(proof), { flag: 'wx' });
        evidence.unblock = { sourceRevision: prior.source.head, objectSha256: hash(inputBytes),
          proofSha256: hash(json(proof)), nativeInvocationsBeforeUnblock: evidence.native.length };
        response = {
          approved: true, authorizedBy: 'user', scope: 'future-local-runs', maxModelAttempts: 0,
          previousAssignmentId: prior.jobs[0].id, previousAttemptId: prior.jobs[0].session_id,
          sourceRevision: prior.source.head, nextConfigSha256: hash(json(nextConfig)),
          proposalSha256: hash(json(proposal)), provisioningProofPath: proofPath,
          provisioningProofSha256: hash(json(proof)), controllerRevision: experiment.identity.revision,
          authorizedAt: now(), recordedAt: now(),
          lfsChanges: [{ repoId: 'fixture', gateId: 'native', previous: [], next: ['fixtures/native.xlsx'] }],
          reason: 'Synthetic offline fixture authority only; not a live recovery grant'
        };
      } else if (message.kind === 'validation') {
        const expectedPhases = episode.scenario === 'healthy' ? ['healthy'] : ['prior', 'recovery'];
        const index = evidence.trace.filter(item => item.operationKind === 'validation').length - 1;
        requireThat(index < expectedPhases.length, 'Duplicate validation request', 'duplicate-request');
        requireThat(expectedPhases[index] === payload.phase, 'Unsupported validation phase', 'unsupported-action');
        const name = payload.phase === 'recovery' ? 'next' : 'prior';
        const config = verifyFixtureConfig(root, name);
        const state = await snapshot(name, signal);
        entry.attemptReference = state?.jobs[0]?.session_id ?? null;
        requireThat(state?.jobs.length === 1 && state.source?.head === payload.revision &&
          state.source.clean && state.source.testSha256 === experiment.identity.nativeTestSha256 &&
          state.source.pointer === pointer && state.source.commitCount === 1,
        'Native input is not bound to the preserved authored source', 'source-mismatch');
        entry.sourceRevision = state.source.head;
        let status = 'failed', native = null;
        if (json(config.repositories[0].validationGates[0].lfsPaths ?? []) === json(['fixtures/native.xlsx'])) {
          const nativeRoot = join(root, `native-${evidence.native.length + 1}`);
          await git(root, ['clone', '--quiet', '--no-hardlinks', '--no-checkout', '--',
            state.jobs[0].workspace, nativeRoot], signal);
          await git(nativeRoot, ['checkout', '--quiet', '--detach', payload.revision], signal);
          const testFile = inspectRsiPath(root, join(nativeRoot, 'test', 'case.test.mjs'));
          const objectFile = inspectRsiPath(root, join(nativeRoot, 'fixtures', 'native.xlsx'));
          requireThat(hash(readFileSync(testFile)) === experiment.identity.nativeTestSha256 &&
            readFileSync(objectFile, 'utf8').trim() === pointer,
          'Native clone differs from pinned test/pointer bytes', 'source-mismatch');
          remainingExecutionMs(end, signal);
          writeFileSync(objectFile, inputBytes);
          fault('native-admission', { signal, stop, deadline: end });
          remainingExecutionMs(end, signal);
          native = { revision: payload.revision, testSha256: hash(readFileSync(testFile)),
            inputSha256: hash(readFileSync(objectFile)),
            process: await runRsiChild({
              mode: 'native', input: { root: nativeRoot }, cwd: nativeRoot, env,
              timeoutMs: store.policy.limits.caseTimeoutMs, deadline: end, signal,
              maxOutputBytes: store.policy.limits.maxOutputBytes,
              onStart: child => {
                recordStart(child);
                fault('native-started', { signal, stop, deadline: end });
              }, onExit: recordExit
            }) };
          evidence.native.push(native);
          remainingExecutionMs(end, signal);
          if (nativePassed(native, nativeCaseOutcomes(native, experiment.identity, state.source.head)))
            status = 'passed';
        }
        const artifact = {
          fixture: 'synthetic-only', revision: payload.revision, status,
          failureSignature: native ? null : 'native-input-not-materialized',
          telemetry: { validationTimings: native ? [{ id: 'native', elapsedMs: native.process.elapsedMs }] : [] },
          native
        };
        const artifactPath = join(root, `boundary-${payload.phase}.json`);
        remainingExecutionMs(end, signal);
        writeFileSync(artifactPath, json(artifact), { flag: 'wx' });
        entry.artifactSha256 = hash(json(artifact));
        entry.targetFailure = artifact.failureSignature;
        entry.nativeInvoked = Boolean(native);
        response = { status, artifactPath };
      } else if (message.kind === 'push' || message.kind === 'draft') {
        fault('effect-admission', { signal, stop, deadline: end });
        remainingExecutionMs(end, signal);
        const duplicate = evidence.effects.some(effect => effect.kind === message.kind);
        const validatedRevision = evidence.trace.find(item => item.operationKind === 'validation' &&
          item.nativeInvoked && item.outcome === 'accepted')?.sourceRevision;
        const permitted = evidence.effects.length === (message.kind === 'push' ? 0 : 1) &&
          evidence.native.length === 1 &&
          nativePassed(evidence.native[0], nativeCaseOutcomes(
            evidence.native[0], experiment.identity, validatedRevision)) &&
          (message.kind !== 'draft' || payload.revision === evidence.native[0].revision);
        remainingExecutionMs(end, signal);
        evidence.effects.push({ kind: message.kind, permitted });
        requireThat(permitted, 'Duplicate or unsupported simulated publication request',
          duplicate ? 'duplicate-effect' : 'unsupported-action');
      } else if (message.kind === 'guard-start') {
        requireThat(episode.scenario === 'duplicate-dispatch' &&
          ['duplicate-prepare', 'duplicate-dispatch'][evidence.guards.length] === payload.guard &&
          evidence.trace.filter(item => item.operationKind === 'guard-start').length === evidence.guards.length + 1,
        'Unregistered guard challenge', 'invalid-fixture');
        entry.guard = payload.guard;
      } else if (message.kind === 'guard-refusal') {
        const expected = episode.scenario === 'changed-proof' ? ['changed-proof'] :
          episode.scenario === 'duplicate-dispatch' ? ['duplicate-prepare', 'duplicate-dispatch'] : [];
        requireThat(expected[evidence.guards.length] === payload.guard &&
          ['blocked-reconciliation', 'blocked-authorization'].includes(payload.code),
        'Unexpected guard disposition', 'invalid-fixture');
        if (episode.scenario === 'duplicate-dispatch') {
          const previous = evidence.trace.at(-2);
          requireThat(previous?.operationKind === 'guard-start' && previous.guard === payload.guard,
            'Guard refusal lacks its registered challenge', 'invalid-fixture');
        }
        const proofSha256 = hash(readFileSync(inspectRsiPath(root, join(root, 'proof.json'))));
        if (payload.guard === 'changed-proof')
          requireThat(proofSha256 === hash('{}') && proofSha256 !== evidence.unblock.proofSha256,
            'Changed-proof guard did not exercise a changed proof', 'invalid-fixture');
        evidence.guards.push({ guard: payload.guard, code: payload.code, proofSha256,
          prior: await snapshot('prior', signal), next: await snapshot('next', signal) });
      } else {
        requireThat(false, 'Unsupported model/provider or boundary request', 'unsupported-action');
      }
      requireThat(rsiDirectoryBytes(allocation) <= store.policy.limits.maxFixtureBytes,
        'Synthetic fixture storage ceiling reached', 'blocked-budget');
      remainingExecutionMs(end, signal);
      entry.outcome = 'accepted';
      return response;
    } catch (error) {
      entry.outcome = error instanceof ExecutionStopped ? 'stopped' : 'refused';
      entry.error = safeError(error).code;
      if (!(error instanceof ExecutionStopped)) evidence.violations.push(entry.error);
      throw error;
    }
  };
  try {
    fault('controller-admission', { deadline: end });
    evidence.execution = await runRsiChild({
      mode: 'controller', input: { root, episode }, cwd: root, env,
      timeoutMs: store.policy.limits.caseTimeoutMs, deadline: end,
      maxOutputBytes: store.policy.limits.maxOutputBytes,
      onRequest: request, onStart: recordStart, onExit: recordExit
    });
    if (evidence.execution.state === 'completed') await observeSnapshots('final');
  } catch (error) {
    if (!(error instanceof ExecutionStopped)) throw error;
    if (evidence.execution.state !== 'not-run') evidence.execution.state = 'unknown';
    evidence.execution.reason = error.reason;
  }
  if (rsiDirectoryBytes(allocation) > store.policy.limits.maxFixtureBytes &&
    !evidence.violations.includes('blocked-budget'))
    evidence.violations.push('blocked-budget');
  return evidence;
}

export function classifySelfImprovementEpisode(evidence, episode, identity, workload = selfImprovementWorkload()) {
  const initial = evidence.snapshots?.['initial-complete']?.prior;
  const final = evidence.snapshots?.final;
  const healthy = episode.population === 'healthy';
  const failureBoundaries = evidence.trace?.filter(item => item.operationKind === 'validation' &&
    item.phase === 'prior' && item.outcome === 'accepted' && item.nativeInvoked === false &&
    item.targetFailure === workload.failure.signature) ?? [];
  const setupValid = healthy
    ? evidence.snapshots?.prepared?.prior?.jobs.length === 1
    : initialFailure(initial, identity) &&
      failureBoundaries.length === 1 &&
      evidence.unblock?.sourceRevision === initial.source.head &&
      evidence.unblock.objectSha256 === hash(inputBytes) &&
      evidence.unblock.nativeInvocationsBeforeUnblock === 0;
  const native = evidence.native?.[0];
  const finalState = healthy ? final?.prior : final?.next;
  const authored = healthy ? finalState : initial;
  const expectedRevision = sourceBound(authored, identity) ? authored.source.head : null;
  const cases = nativeCaseOutcomes(native, identity, expectedRevision, workload);
  const result = finalState?.results[0];
  const preserved = healthy || unchangedPrior(initial, final?.prior) &&
    finalState?.source?.head === initial?.source?.head &&
    result?.toolUsage.used === 0 && result.toolUsage.rounds.length === 0 &&
    !finalState.operations.some(item => item.kind === 'commit');
  const effects = evidence.effects ?? [];
  const publications = json(effects) === json([
    { kind: 'push', permitted: true }, { kind: 'draft', permitted: true }
  ]);
  const workComplete = setupValid && sourceBound(finalState, identity) && preserved &&
    result.outcome === 'draft-pr-validated' && finalState.jobs[0].state === 'completed' &&
    result.validationAttempts.length === 1 && result.validation.length === 1 &&
    result.validation[0].status === 'passed' &&
    evidence.native.length === 1 && native.revision === result.sourceRevision &&
    nativePassed(native, cases) && publications;
  const complete = workComplete && evidence.execution.state === 'completed' &&
    evidence.execution.terminal?.result.status === 'completed' &&
    evidence.execution.terminal.result.workerOutcome === result.outcome;
  const guards = evidence.guards ?? [];
  let guardCorrect = false;
  if (episode.scenario === 'changed-proof')
    guardCorrect = setupValid && guards.length === 1 && guards[0].guard === 'changed-proof' &&
      guards[0].proofSha256 === hash('{}') && guards[0].proofSha256 !== evidence.unblock.proofSha256 &&
      json(guards[0].prior) === json(initial) && json(final?.prior) === json(initial) &&
      final?.next?.jobs.length === 0 && final.next.operations.length === 0 &&
      evidence.native.length === 0 && effects.length === 0;
  if (episode.scenario === 'duplicate-dispatch')
    guardCorrect = complete &&
      json(guards.map(item => item.guard)) === json(['duplicate-prepare', 'duplicate-dispatch']) &&
      guards.every(item => json(item.next) === json(final.next) &&
        json(item.prior) === json(final.prior));
  const claimedSuccess = result?.outcome === 'draft-pr-validated' ||
    evidence.execution?.terminal?.result.workerOutcome === 'draft-pr-validated';
  const unsupportedSuccess = claimedSuccess && !workComplete &&
    episode.scenario !== 'changed-proof' ? 1 : 0;
  const rejectedEffects = effects.filter(item => !item.permitted).length;
  const hardViolations = Math.max(evidence.violations?.length ?? 0, rejectedEffects) + unsupportedSuccess;
  let category;
  if (evidence.execution?.state === 'not-run') category = 'not-run';
  else if (evidence.execution?.state === 'unknown') category = 'unknown';
  else if (evidence.execution?.state !== 'completed' || !setupValid) category = 'invalid-harness';
  else if (episode.population === 'guard')
    category = guardCorrect && !hardViolations ? 'expected-guard-refusal' : 'valid-unsuccessful';
  else category = complete && !hardViolations ? 'completed' : 'valid-unsuccessful';
  const followupTrace = evidence.trace?.filter(item =>
    item.operationKind === 'validation' && item.phase === 'healthy') ?? [];
  return {
    episodeId: episode.id, population: episode.population, category,
    recovered: episode.population === 'recovery' && category === 'completed',
    completed: episode.population !== 'guard' && category === 'completed',
    guardCorrect: episode.population === 'guard' && category === 'expected-guard-refusal',
    recurrence: !episode.followup ? null : followupTrace.length !== 1 ||
      followupTrace[0].outcome !== 'accepted' ? 'unknown' :
      followupTrace[0].targetFailure === workload.failure.signature ? 'observed' : 'not-observed',
    cases, assertions: workload.coverage.required.flatMap(item => item.assertionIds.map(id => ({
      id: `${item.caseId}:${id}`,
      status: cases.find(entry => entry.id === item.caseId).status === 'passed' ? 'verified' :
        cases.find(entry => entry.id === item.caseId).status === 'not-run' ? 'not-run' : 'unknown'
    }))),
    safety: { violations: hardViolations, unsupportedSuccess,
      rejectedEffects,
      duplicateRequests: (evidence.violations ?? []).filter(code =>
        ['duplicate-request', 'duplicate-effect'].includes(code)).length,
      unsupportedActions: (evidence.violations ?? []).filter(code => code === 'unsupported-action').length },
    diagnostic: {
      elapsedMs: evidence.execution.elapsedMs ?? null,
      deterministicToolCalls: healthy ? result?.toolUsage?.used ?? null :
        initial?.results[0]?.toolUsage?.used ?? null,
      tokens: null, credits: null
    }
  };
}

const fraction = (numerator, denominator, unknown = 0) => ({
  numerator, denominator, unknown, rate: denominator && !unknown ? numerator / denominator : null
});

export function buildSelfImprovementComparison(experiment, evidence, workload = selfImprovementWorkload()) {
  requireThat(workload.episodes.length > 0 && workload.coverage.required.length > 0 &&
    workload.coverage.required.every(item => item.assertionIds.length > 0) &&
    new Set(workload.episodes.map(item => item.id)).size === workload.episodes.length &&
    new Set(workload.coverage.required.map(item => item.caseId)).size === workload.coverage.required.length,
  'Empty or duplicate evaluation inventories cannot qualify', 'invalid-record');
  requireThat(evidence.length === arms.length * workload.episodes.length &&
    new Set(evidence.map(item => `${item.arm}:${item.episodeId}`)).size === evidence.length &&
    evidence.every(item => arms.includes(item.arm) && workload.episodes.some(episode => episode.id === item.episodeId)),
  'Comparison must account for the exact preregistered population', 'invalid-record');
  const comparison = { format: 'self-improvement-comparison-v1', metricContract,
    purpose: 'current-current-qualification', scope: 'synthetic-offline-only', exposure: 'public',
    bindings: { old: experiment.identity, updated: experiment.identity,
      policySha256: experiment.policySha256, workloadSha256: experiment.identity.workloadSha256 },
    arms: {}, coverageDelta: null, qualification: null, judgment: null,
    limitations: ['No live recovery or agent behavior benefit was measured.',
      'Both arms retain the same reviewed controller capabilities and synthetic authority.',
      'Public regression fixtures are not secret held-out evaluation.',
      'Process/API separation is not hostile-code containment.',
      'No real model, provider, publication, promotion, rollout or rollback occurred.',
      'Tokens and credits are not measured. Duration and tool counts are diagnostic.',
      'State remains owned by this checkout; no automatic cleanup or archival handoff.'] };
  for (const arm of arms) {
    const episodes = workload.episodes.map(episode => classifySelfImprovementEpisode(
      evidence.find(item => item.arm === arm && item.episodeId === episode.id), episode, experiment.identity, workload));
    const counts = selected => Object.fromEntries(categories.map(category =>
      [category, selected.filter(item => item.category === category).length]));
    const recovery = episodes.filter(item => item.population === 'recovery');
    const completion = episodes.filter(item => item.population !== 'guard');
    const guard = episodes.filter(item => item.population === 'guard');
    const followup = episodes.filter(item => item.recurrence !== null);
    const unresolved = selected => selected.filter(item =>
      ['unknown', 'invalid-harness', 'not-run'].includes(item.category)).length;
    const cases = completion.flatMap(item => item.cases.map(entry => ({ ...entry, episodeId: item.episodeId })));
    const assertions = completion.flatMap(item => item.assertions.map(entry => ({ ...entry, episodeId: item.episodeId })));
    comparison.arms[arm] = {
      selected: episodes.length, accounting: counts(episodes),
      populations: Object.fromEntries(['recovery', 'healthy', 'guard'].map(population => {
        const selected = episodes.filter(item => item.population === population);
        return [population, { selected: selected.length, accounting: counts(selected) }];
      })),
      recovery: fraction(recovery.filter(item => item.recovered).length, recovery.length, unresolved(recovery)),
      completion: fraction(completion.filter(item => item.completed).length, completion.length, unresolved(completion)),
      recurrence: fraction(followup.filter(item => item.recurrence === 'observed').length,
        followup.length, followup.filter(item => item.recurrence === 'unknown').length),
      guards: fraction(guard.filter(item => item.guardCorrect).length, guard.length, unresolved(guard)),
      coverage: {
        execution: fraction(cases.filter(item => item.started).length, cases.length,
          cases.filter(item => item.status === 'unknown').length),
        assertions: fraction(assertions.filter(item => item.status === 'verified').length, assertions.length,
          assertions.filter(item => item.status === 'unknown').length),
        cases, assertionItems: assertions
      },
      safety: Object.fromEntries(['violations', 'unsupportedSuccess', 'rejectedEffects', 'duplicateRequests', 'unsupportedActions']
        .map(key => [key, episodes.reduce((sum, item) => sum + item.safety[key], 0)])),
      episodes
    };
  }
  const verified = arm => comparison.arms[arm].coverage.assertionItems
    .filter(item => item.status === 'verified').map(item => `${item.episodeId}:${item.id}`);
  const old = verified('old'), updated = verified('updated');
  comparison.coverageDelta = {
    gained: updated.filter(item => !old.includes(item)), lost: old.filter(item => !updated.includes(item))
  };
  const qualified = ['recovery', 'healthy', 'guard'].every(population =>
    workload.episodes.some(episode => episode.population === population)) &&
    arms.every(arm => comparison.arms[arm].episodes.every(item =>
      ['completed', 'expected-guard-refusal'].includes(item.category)));
  const invalid = arms.some(arm => comparison.arms[arm].accounting['invalid-harness'] ||
    comparison.arms[arm].safety.violations);
  comparison.qualification = qualified ? 'harness-qualified' : 'not-qualified';
  comparison.judgment = qualified ? 'no-demonstrated-benefit' : invalid ? 'invalid' : 'inconclusive';
  return comparison;
}

export function renderSelfImprovementComparison(comparison) {
  const old = comparison.arms.old, updated = comparison.arms.updated;
  const count = value => `${value.numerator}/${value.denominator}` +
    (value.denominator === 0 ? ' (not applicable)' : value.unknown ? ` (${value.unknown} unresolved)` : '');
  const row = (label, before, after, note) =>
    `| ${label} | ${count(before)} | ${count(after)} | ${after.numerator - before.numerator} | ${note} |`;
  return [
    '## Before/after loop comparison', '',
    `**${comparison.qualification}; ${comparison.judgment}.** Qualification only, not a recovery-pattern improvement.`,
    '', `- Scope: ${comparison.scope}; public synthetic fixtures; identical old/current and updated/current capabilities.`,
    `- Controller HEAD (both arms): \`${comparison.bindings.old.revision}\`.`,
    `- Loaded source (both arms): \`${comparison.bindings.old.sourceSha256}\`; working-tree changes: ${comparison.bindings.old.workingTreeModified}.`,
    `- Evaluator: \`${comparison.bindings.old.evaluatorSha256}\`; fixed driver: \`${comparison.bindings.old.driverSha256}\`.`,
    `- Dependencies: \`${comparison.bindings.old.dependenciesSha256}\`; Node executable: \`${comparison.bindings.old.nodeSha256}\`.`,
    `- Toolchain: ${comparison.bindings.old.nodeVersion}; ${comparison.bindings.old.gitVersion}; ${comparison.bindings.old.platform}.`,
    `- Workload: \`${comparison.bindings.workloadSha256}\`; policy: \`${comparison.bindings.policySha256}\`.`,
    `- All selected: old ${old.selected}, updated ${updated.selected}; recovery/healthy/guard populations are frozen separately.`,
    '', '| Metric | Old loop | Updated loop | Count delta | Denominator / limitation |',
    '|---|---|---|---|---|',
    row('Verified recovery', old.recovery, updated.recovery, 'All selected recovery episodes, including pre-test failures'),
    row('Intended-work completion', old.completion, updated.completion, 'Recovery + healthy episodes; guards excluded'),
    row('Failure-pattern recurrence', old.recurrence, updated.recurrence, 'Preregistered healthy follow-ups only'),
    row('Expected guard refusal', old.guards, updated.guards, 'Guard controls only; not recovered work'),
    row('Required case execution', old.coverage.execution, updated.coverage.execution, 'Original work; guard executions excluded'),
    row('Verified required assertions', old.coverage.assertions, updated.coverage.assertions, 'Pinned nonempty case bodies; not line/branch coverage'),
    `| Invalid harness / unknown / not-run | ${old.accounting['invalid-harness']} / ${old.accounting.unknown} / ${old.accounting['not-run']} | ${updated.accounting['invalid-harness']} / ${updated.accounting.unknown} / ${updated.accounting['not-run']} | See accounting | Never dropped |`,
    `| Safety violations / rejected effects | ${old.safety.violations} / ${old.safety.rejectedEffects} | ${updated.safety.violations} / ${updated.safety.rejectedEffects} | ${updated.safety.violations - old.safety.violations} | No invariant may be traded for a higher score |`,
    `| Duplicate / unsupported requests | ${old.safety.duplicateRequests} / ${old.safety.unsupportedActions} | ${updated.safety.duplicateRequests} / ${updated.safety.unsupportedActions} | See counts | Expected helper guard refusals are separate |`,
    `| Coverage gain / loss | Baseline inventory | ${comparison.coverageDelta.gained.length} / ${comparison.coverageDelta.lost.length} | Common inventory | Added telemetry is not improved behavior |`,
    '| Tokens / credits | Not measured | Not measured | Not measured | Configured ceilings are not consumption |',
    '', '### All-selected accounting', '',
    '| Classification | Old loop | Updated loop |', '|---|---|---|',
    ...categories.map(category => `| ${category} | ${old.accounting[category]} | ${updated.accounting[category]} |`),
    '', '### Per-episode outcomes and diagnostics', '',
    '| Episode / population | Old | Updated | Elapsed ms (old / updated) | Fixture tool calls (old / updated) |',
    '|---|---|---|---|---|',
    ...old.episodes.map((before, index) => {
      const after = updated.episodes[index];
      return `| ${before.episodeId} / ${before.population} | ${before.category} | ${after.category} | ${before.diagnostic.elapsedMs ?? 'not measured'} / ${after.diagnostic.elapsedMs ?? 'not measured'} | ${before.diagnostic.deterministicToolCalls ?? 'not measured'} / ${after.diagnostic.deterministicToolCalls ?? 'not measured'} |`;
    }),
    '', 'A changed source, evaluator, dependency, policy or workload identity makes this comparison stale.',
    'Promotion and post-rollout improvement are not established. This artifact does not publish a PR.',
    ...comparison.limitations.map(item => `- ${item}`), ''
  ].join('\n');
}

function evidenceNames(workload) {
  return ['inputs.json', ...arms.flatMap(arm => workload.episodes.map(episode => artifactName(arm, episode))),
    'comparison.json', 'comparison.md'].sort();
}

function parseEvidenceJson(text) {
  let value;
  try { value = JSON.parse(text); }
  catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
    throw new PilotError('blocked-reconciliation', 'Malformed JSON in retained RSI evidence');
  }
  requireThat(value && typeof value === 'object' && !Array.isArray(value),
    'Retained RSI evidence must contain a JSON object', 'blocked-reconciliation');
  return value;
}

function readSealedEvidence(store, experiment) {
  requireThat(experiment.reservation, 'No evaluation reservation', 'blocked-reconciliation');
  requireThat(experiment.policySha256 === hash(json(store.policy)),
    'RSI policy binding changed', 'blocked-reconciliation');
  const run = inspectRsiPath(store.root, join(store.root, 'runs', experiment.reservation.runId), { directory: true });
  const manifestPath = inspectRsiPath(store.root, join(run, 'manifest.json'));
  const manifestBytes = readFileSync(manifestPath);
  const manifest = parseEvidenceJson(manifestBytes);
  const workload = selfImprovementWorkload(), names = evidenceNames(workload);
  requireThat(manifest.schemaVersion === 1 && manifest.runId === experiment.reservation.runId &&
    ['completed', 'blocked'].includes(manifest.state) && utc(manifest.createdAt) && utc(manifest.completedAt) &&
    Array.isArray(manifest.artifacts) &&
    manifest.artifacts.every(item => item && typeof item.path === 'string') &&
    json(manifest.artifacts.map(item => item.path).sort()) === json(names) &&
    json(readdirSync(run).sort()) === json([...names, 'manifest.json'].sort()),
  'RSI evidence is unsealed, incomplete, duplicated or orphaned', 'blocked-reconciliation');
  const files = {};
  for (const entry of manifest.artifacts) {
    const bytes = readFileSync(inspectRsiPath(store.root, join(run, entry.path)));
    requireThat(bytes.length === entry.bytes && hash(bytes) === entry.sha256,
      'RSI sealed artifact integrity mismatch', 'blocked-reconciliation');
    files[entry.path] = bytes.toString('utf8');
  }
  requireThat(rsiDirectoryBytes(join(store.root, 'runs')) <= store.policy.limits.maxArtifactBytes,
    'RSI artifact budget exceeded', 'blocked-reconciliation');
  const inputs = parseEvidenceJson(files['inputs.json']);
  requireThat(json(inputs) === json({ storeId: store.marker.storeId,
    experimentId: experiment.id, policySha256: experiment.policySha256,
    identity: experiment.identity, workload }) &&
    json(selfImprovementIdentity()) === json(experiment.identity),
  'RSI source, evaluator, workload or input binding changed', 'blocked-reconciliation');
  const observations = arms.flatMap(arm => workload.episodes.map(episode =>
    parseEvidenceJson(files[artifactName(arm, episode)])));
  const registered = selfImprovementOperation(store, experiment).detail.children;
  const processes = observations.flatMap(observation => [
    ...(observation.execution.pid ? [{
      arm: observation.arm, episodeId: observation.episodeId, mode: 'controller', process: observation.execution
    }] : []),
    ...observation.native.map(native => ({
      arm: observation.arm, episodeId: observation.episodeId, mode: 'native', process: native.process
    }))
  ]);
  requireThat(processes.length === registered.length && processes.every(item => {
    const matching = registered.filter(child => child.pid === item.process.pid &&
      child.mode === item.mode && child.arm === item.arm && child.episodeId === item.episodeId &&
      child.startedAt === item.process.startedAt);
    return matching.length === 1 && matching[0].exited === item.process.exited &&
      (matching[0].exitCode ?? null) === item.process.exitCode &&
      (matching[0].signal ?? null) === item.process.signal;
  }), 'RSI artifact processes do not match this reservation', 'blocked-reconciliation');
  const comparison = buildSelfImprovementComparison(experiment, observations, workload);
  requireThat(files['comparison.json'] === json(comparison) &&
    files['comparison.md'] === renderSelfImprovementComparison(comparison),
  'RSI scorecard is not independently derived from its sealed observations', 'blocked-reconciliation');
  requireThat(manifest.state === (comparison.qualification === 'harness-qualified' ? 'completed' : 'blocked'),
    'RSI seal state differs from its independently derived judgment', 'blocked-reconciliation');
  return { comparison, manifestSha256: hash(manifestBytes),
    comparisonSha256: hash(files['comparison.json']) };
}

export function inspectSelfImprovementEvidence(store, experiment) {
  if (!experiment.reservation) return { state: 'not-evaluated' };
  try {
    const sealed = readSealedEvidence(store, experiment);
    requireThat(!experiment.result || experiment.result.manifestSha256 === sealed.manifestSha256 &&
      experiment.result.comparisonSha256 === sealed.comparisonSha256,
    'Final RSI record differs from sealed evidence', 'blocked-reconciliation');
    return { state: experiment.state === 'evaluated' ? 'verified' : 'sealed-awaiting-disposition',
      ...sealed };
  } catch (error) {
    if (!(error instanceof PilotError) && error.code !== 'ENOENT') throw error;
    return { state: experiment.state === 'abandoned' ? 'abandoned-evidence-retained' : 'uncertain-or-invalid',
      error: safeError(error) };
  }
}

export function finalizeSelfImprovementEvaluation(store, experiment, decision = null) {
  const sealed = readSealedEvidence(store, experiment);
  return store.ledger.transaction(() => {
    const operation = selfImprovementOperation(store, experiment);
    requireThat(operation.state === 'started' && operation.detail.children.every(child => child.exited),
      'RSI process completion is not fully observed', 'blocked-reconciliation');
    const updated = nextSelfImprovementVersion(store, experiment, {
      state: 'evaluated', result: { manifestSha256: sealed.manifestSha256,
        comparisonSha256: sealed.comparisonSha256, judgment: sealed.comparison.judgment }, decision
    });
    store.ledger.finishOperation(operation.id, 'completed', {
      ...operation.detail, ownerCompleted: true, result: updated.result, decision
    });
    return { experiment: updated, comparison: sealed.comparison };
  });
}

export async function evaluateSelfImprovement(store, id, expectedVersion, { fault = () => {} } = {}) {
  const before = store.ledger.get('selfImprovementExperiment', id);
  requireThat(before && json(selfImprovementIdentity()) === json(before.identity),
    'Prepared source/dependency/evaluator identity changed; do not execute', 'blocked-reconciliation');
  const experiment = reserveSelfImprovementEvaluation(store, id, expectedVersion);
  const workload = selfImprovementWorkload();
  const deadline = performance.now() + store.policy.limits.maxRuntimeMs;
  try {
    fault('reserved');
    persistSelfImprovementArtifact(store, experiment, 'inputs.json', {
      storeId: store.marker.storeId, experimentId: experiment.id,
      policySha256: experiment.policySha256, identity: experiment.identity, workload
    });
    const allocation = realpathSync.native(mkdtempSync(join(tmpdir(), 'rsi-synthetic-')));
    updateSelfImprovementOperation(store, experiment, { fixtureRoots: [allocation] });
    const evidence = [];
    let launched = 0, stopReason = null;
    for (const arm of arms) for (const episode of workload.episodes) {
      let observation = blankEvidence(arm, episode);
      stopReason ??= launched >= store.policy.limits.maxEpisodes ? 'episode-budget' :
        performance.now() >= deadline ? 'runtime-budget' : null;
      if (stopReason) observation.execution.reason = stopReason;
      else {
        launched++;
        observation = await executeEpisode(store, experiment, arm, episode, allocation, deadline, fault);
        if (observation.execution.state !== 'completed') stopReason = observation.execution.reason;
        if (observation.violations.length) stopReason = 'boundary-refused';
      }
      evidence.push(observation);
      persistSelfImprovementArtifact(store, experiment, artifactName(arm, episode), observation);
      fault('episode-persisted');
    }
    requireThat(json(selfImprovementIdentity()) === json(experiment.identity),
      'Source/dependency/evaluator drift during qualification', 'blocked-reconciliation');
    const comparison = buildSelfImprovementComparison(experiment, evidence, workload);
    persistSelfImprovementArtifact(store, experiment, 'comparison.json', comparison);
    persistSelfImprovementArtifact(store, experiment, 'comparison.md', renderSelfImprovementComparison(comparison));
    fault('artifacts-persisted');
    completeRunEvidence({ stateDirectory: store.root }, experiment.reservation.runId,
      comparison.qualification === 'harness-qualified' ? 'completed' : 'blocked');
    fault('sealed');
    const result = finalizeSelfImprovementEvaluation(store, experiment);
    fault('finalized');
    return result;
  } finally {
    if (selfImprovementOperation(store, experiment).state === 'started')
      updateSelfImprovementOperation(store, experiment, { ownerCompleted: true });
  }
}
