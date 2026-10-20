import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync
} from 'node:fs';
import { join, sep } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(import.meta.url);
const fs = require('node:fs');
const threads = require('node:worker_threads');
const originalWatch = fs.watch;
const OriginalWorker = threads.Worker;
const watchers = new Map();
let onWorkerResult = null;
let onWatch = null;
fs.watch = (path, options, callback) => {
  const watcher = new EventEmitter();
  watcher.callback = callback;
  watcher.closed = false;
  watcher.close = () => { watcher.closed = true; };
  watcher.unref = () => watcher;
  watchers.set(path, watcher);
  onWatch?.(watcher, path);
  return watcher;
};
threads.Worker = class extends OriginalWorker {
  constructor(...args) {
    super(...args);
    // Deliver the injected OS event after hashing, before the controller
    // receives the result, without mocking the fingerprint computation.
    this.prependListener('message', result => onWorkerResult?.(result));
  }
};
syncBuiltinESMExports();
const { command, outputFingerprint, prepareValidation, runValidation, verifyPreparedOutputs } =
  await import('../src/workers.js');
const { Ledger } = await import('../src/ledger.js');
const { hash, json, PilotError } = await import('../src/common.js');
after(() => {
  fs.watch = originalWatch;
  threads.Worker = OriginalWorker;
  syncBuiltinESMExports();
});

async function fixture(t, rootPath = 'node_modules') {
  onWorkerResult = null;
  onWatch = null;
  const workspace = mkdtempSync(join(tmpdir(), 'prepared-guard-'));
  const root = join(workspace, rootPath);
  const nested = join(root, 'fixture', 'nested');
  mkdirSync(nested, { recursive: true });
  const file = join(nested, 'value.js');
  writeFileSync(file, 'export default 1;\n');
  t.after(() => {
    onWorkerResult = null;
    onWatch = null;
    for (const [path, watcher] of watchers) {
      if (path.startsWith(workspace)) {
        watcher.close();
        watchers.delete(path);
      }
    }
    rmSync(workspace, { recursive: true, force: true });
  });
  const captured = await outputFingerprint(workspace, [rootPath], true);
  const outputs = { paths: [rootPath], sha256: captured.sha256 };
  const receipt = join(workspace, 'receipt.json');
  const verify = () => verifyPreparedOutputs(receipt, workspace, outputs);
  const initialize = () => verifyPreparedOutputs(
    receipt, workspace, outputs, captured.entries);
  const watcher = () => watchers.get(root);
  return { workspace, root, nested, file, outputs, verify, initialize, watcher };
}

for (const rootPath of ['node_modules', 'dist']) {
  for (const mutation of ['modify', 'delete', 'add']) {
    test(`ancestor-only ${rootPath} event detects nested ${mutation}`, async t => {
      const ctx = await fixture(t, rootPath);
      assert.equal((await ctx.initialize()).valid, true);
      if (mutation === 'modify') writeFileSync(ctx.file, 'corrupt\n');
      if (mutation === 'delete') rmSync(ctx.file);
      if (mutation === 'add')
        writeFileSync(join(ctx.nested, 'injected.js'), 'injected\n');
      ctx.watcher().callback('change', 'fixture');
      const result = await ctx.verify();
      assert.equal(result.valid, false);
      assert.match(result.reason, /content-changed/);
    });
  }
}

test('ancestor and leaf metadata events coalesce into one recursive task', async t => {
  const ctx = await fixture(t);
  assert.equal((await ctx.initialize()).valid, true);
  writeFileSync(ctx.file, readFileSync(ctx.file));
  ctx.watcher().callback('change', 'fixture');
  ctx.watcher().callback('change', 'fixture/nested/value.js');
  const result = await ctx.verify();
  assert.equal(result.valid, true);
  assert.equal(result.details.coalescedPathCount, 1);
  assert.equal(result.details.workerTaskCount, 1);
  assert.equal(result.details.recursiveDirectoryCount, 1);
  assert.equal(result.details.hashedFileCount, 1);
});

for (const initial of [false, true]) {
  for (const event of ['rename', 'delete', 'watch-error', 'null-filename']) {
    test(`${initial ? 'initial' : 'warm'} verification rejects ${event} during hashing`,
      async t => {
        const ctx = await fixture(t);
        if (initial) {
          onWatch = watcher => setImmediate(() =>
            watcher.callback('change', 'fixture'));
        } else {
          assert.equal((await ctx.initialize()).valid, true);
          ctx.watcher().callback('change', 'fixture');
        }
        let injected = false;
        onWorkerResult = () => {
          if (injected) return;
          injected = true;
          if (event === 'rename') {
            renameSync(ctx.file, join(ctx.nested, 'renamed.js'));
            ctx.watcher().callback('rename', 'fixture/nested/value.js');
          } else if (event === 'delete') {
            rmSync(ctx.file);
            ctx.watcher().callback('rename', 'fixture/nested/value.js');
          } else if (event === 'watch-error') {
            ctx.watcher().emit('error', new Error('injected watcher failure'));
          } else {
            ctx.watcher().callback('change', null);
          }
        };
        const result = await (initial ? ctx.initialize() : ctx.verify());
        assert.equal(injected, true);
        assert.equal(result.valid, false);
        assert.equal(ctx.watcher().closed, true);
      });
  }
}

test('a repeated change delivered after hashing must be revalidated', async t => {
  const ctx = await fixture(t);
  assert.equal((await ctx.initialize()).valid, true);
  ctx.watcher().callback('change', 'fixture/nested/value.js');
  let injected = false;
  onWorkerResult = () => {
    if (injected) return;
    injected = true;
    setTimeout(() => {
      writeFileSync(ctx.file, 'changed after fingerprint\n');
      ctx.watcher().callback('change', 'fixture/nested/value.js');
    }, 10);
  };
  const result = await ctx.verify();
  assert.equal(injected, true);
  assert.equal(result.valid, false);
  assert.equal(result.details.settlementPassCount, 2);
});

test('watcher loss before settlement reports current events instead of stale warm telemetry',
  async t => {
    const ctx = await fixture(t);
    assert.equal((await ctx.initialize()).valid, true);
    const quiet = await ctx.verify();
    assert.equal(quiet.details.observedEventCount, 0);
    ctx.watcher().callback('change', null);
    const lost = await ctx.verify();
    assert.equal(lost.valid, false);
    assert.match(lost.reason, /unknown/);
    assert.equal(lost.details.observedEventCount, 1);
    assert.equal(lost.details.nullFilenameEventCount, 1);
    assert.equal(lost.details.workerTaskCount, 0);
    assert.equal(lost.details.durationMs, 0);
  });

async function preparationFixture(t, snapshot, rejection, onRejection = null) {
  onWorkerResult = null;
  onWatch = null;
  const root = mkdtempSync(join(tmpdir(), 'prep-diag-'));
  const workspace = join(root, 'source');
  const stateDirectory = join(root, 'state');
  const log = join(root, 'stages.log');
  let ledger;
  t.after(() => {
    onWorkerResult = null;
    onWatch = null;
    ledger?.close();
    for (const [path, watcher] of watchers) {
      if (path.startsWith(root)) {
        watcher.close();
        watchers.delete(path);
      }
    }
    rmSync(root, { recursive: true, force: true, maxRetries: 5 });
  });
  mkdirSync(workspace);
  writeFileSync(join(workspace, '.gitignore'), 'node_modules/\ndist/\n.pilot/\n');
  writeFileSync(join(workspace, 'package.json'), '{"private":true}\n');
  writeFileSync(join(workspace, 'fixture.lock'), 'locked\n');
  writeFileSync(join(workspace, 'build.config.js'), 'export default {};\n');
  const git = args => command('git', ['-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false', ...args], workspace);
  await git(['init', '--quiet']);
  await git(['add', '.']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Local preparation diagnostic fixture']);
  const revision = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const plan = {
    version: 2, stages: ['dependencies', 'compile', 'policy', 'test'],
    testOnlyPrefixes: ['test/'], lockfilePaths: ['package.json', 'fixture.lock'],
    buildConfigPaths: ['build.config.js'],
    dependencySnapshotPaths: ['node_modules', '.pilot/install-state'],
    preparedOutputPaths: ['dist']
  };
  const profilePath = join(root, 'profile.mjs');
  writeFileSync(profilePath, `// PILOT_VALIDATION_PLAN: ${json(plan)}
import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs';
const stage = process.env.PILOT_VALIDATION_STAGE;
appendFileSync(process.argv[2], stage + '\\n');
if (stage === 'fingerprint') console.log('PILOT_VALIDATION_FINGERPRINT:' +
  JSON.stringify({node: process.version, corepack: 'fixture', yarn: 'fixture',
    platform: process.platform, architecture: process.arch}));
if (stage === 'dependencies') {
  mkdirSync('node_modules/fixture', {recursive: true});
  writeFileSync('node_modules/fixture/index.js', 'dependency\\n');
  mkdirSync('.pilot', {recursive: true});
  writeFileSync('.pilot/install-state', 'prepared\\n');
}
if (stage === 'compile') {
  mkdirSync('dist');
  writeFileSync('dist/index.js', 'compiled\\n');
}
`);
  const gate = {
    id: 'diagnostic', approved: true, isolationVerified: true,
    executable: process.execPath, args: ['{profile}', log],
    profilePath, profileSha256: hash(readFileSync(profilePath)), timeoutMs: 30000
  };
  const config = { stateDirectory, limits: { maxValidationInfrastructureRetries: 1 } };
  const repo = { id: 'fixture', owner: 'fixture', validationGates: [gate] };
  const job = { id: 'preparation-diagnostic', workspace };
  ledger = new Ledger(stateDirectory);
  let targetWatcher = null;
  let injected = false;
  onWatch = (watcher, path) => {
    const type = snapshot === 'dependencies' ? 'd' : 'c';
    if (!path.startsWith(stateDirectory) ||
      !path.includes(`${sep}pv${sep}${type}${sep}`) ||
      !path.endsWith(`${sep}node_modules`)) return;
    targetWatcher = watcher;
    if (rejection === 'content-mismatch') {
      writeFileSync(join(path, 'fixture', 'index.js'), 'changed after capture\n');
      injected = true;
    }
    if (rejection === 'registration-unknown') {
      watcher.callback('change', null);
      injected = true;
    }
    if (injected) onRejection?.();
  };
  onWorkerResult = () => {
    if (!rejection || !targetWatcher || injected) return;
    injected = true;
    if (rejection === 'unknown-event') targetWatcher.callback('change', null);
    if (rejection === 'watch-error')
      targetWatcher.emit('error', new Error('fixture watcher failure'));
    onRejection?.();
  };
  return {
    config, repo, gate, job, ledger, revision,
    injected: () => injected,
    stages: () => readFileSync(log, 'utf8').trim().split('\n')
  };
}

function assertRejectionDiagnostic(timings, snapshot, rejection) {
  const stage = timings.find(item =>
    item.id === `${snapshot === 'dependencies' ? 'dependency' : 'compile'}-output-verification`);
  assert.ok(stage, 'Preparation failure must retain the verifier result');
  assert.equal(stage.cache, 'invalidated');
  assert.ok(stage.durationMs >= 0);
  assert.equal(stage.details.valid, false);
  if (rejection === 'registration-unknown') {
    assert.equal(stage.details.method, 'watch');
    assert.equal(stage.details.fullVerification, undefined);
    assert.equal(stage.details.details.durationMs, 0);
  } else {
    assert.equal(stage.details.method, 'content');
    assert.equal(stage.details.fullVerification.baseline, null);
    assert.ok(stage.details.fullVerification.verification.taskCount > 0);
  }
  if (rejection === 'content-mismatch') {
    assert.equal(stage.details.reason, 'content-fingerprint-mismatch');
    assert.equal(stage.details.details.observedEventCount, 0);
  } else if (['unknown-event', 'registration-unknown'].includes(rejection)) {
    assert.match(stage.details.reason, /:change:unknown$/);
    assert.equal(stage.details.details.nullFilenameEventCount, 1);
    assert.equal(stage.details.details.observedEventCount, 1);
  } else {
    assert.match(stage.details.reason, /^node_modules:watch-error:/);
    assert.doesNotMatch(stage.details.reason, /fixture watcher failure/);
  }
  return stage;
}

for (const snapshot of ['dependencies', 'compile']) {
  for (const rejection of [
    'content-mismatch', 'unknown-event', 'watch-error', 'registration-unknown'
  ]) {
    test(`${snapshot} preparation preserves ${rejection} diagnostics through a recorded failure`,
      async t => {
        const ctx = await preparationFixture(t, snapshot, rejection);
        const prepared = await prepareValidation(
          ctx.config, ctx.job, ctx.repo, ctx.revision);
        assert.equal(ctx.injected(), true);
        const failure = prepared[ctx.gate.id];
        assert.equal(failure.error.code, 'blocked-validation');
        const diagnostic = assertRejectionDiagnostic(
          failure.preparationTimings, snapshot, rejection);
        assert.ok(failure.error.message.includes(diagnostic.details.reason));
        const calls = ctx.stages();
        assert.equal(calls.filter(stage => stage === 'dependencies').length, 1);
        assert.equal(calls.filter(stage => stage === 'compile').length,
          snapshot === 'compile' ? 1 : 0);
        assert.equal(calls.includes('policy'), false);
        assert.equal(calls.includes('test'), false);
        const validation = (await runValidation(ctx.config, ctx.ledger,
          ctx.job, ctx.repo, ctx.revision, undefined, undefined, prepared))[0];
        assert.equal(validation.status, 'blocked');
        assert.equal(validation.blockedReason, 'blocked-validation');
        assert.equal(validation.attemptCount, 1);
        const artifact = JSON.parse(readFileSync(validation.artifactRefs[0]));
        assert.deepEqual(artifact.telemetry.preparationTimings, failure.preparationTimings);
        assert.deepEqual(assertRejectionDiagnostic(
          artifact.telemetry.preparationTimings, snapshot, rejection), diagnostic);
        assert.deepEqual(ctx.stages(), calls, 'A recorded preparation failure must not retry');
      });
  }
  test(`${snapshot} direct validation persists verifier rejection diagnostics`, async t => {
    const ctx = await preparationFixture(t, snapshot, 'unknown-event');
    const validation = (await runValidation(
      ctx.config, ctx.ledger, ctx.job, ctx.repo, ctx.revision))[0];
    assert.equal(ctx.injected(), true);
    assert.equal(validation.status, 'blocked');
    assert.equal(validation.blockedReason, 'blocked-validation');
    assert.equal(validation.attemptCount, 1);
    const artifact = JSON.parse(readFileSync(validation.artifactRefs[0]));
    assertRejectionDiagnostic(artifact.telemetry.preparationTimings, snapshot, 'unknown-event');
    assert.equal(ctx.stages().filter(stage => stage === 'dependencies').length, 1);
    assert.equal(ctx.stages().filter(stage => stage === 'compile').length,
      snapshot === 'compile' ? 1 : 0);
    assert.equal(ctx.stages().includes('policy'), false);
    assert.equal(ctx.stages().includes('test'), false);
  });
}

for (const snapshot of ['dependencies', 'compile']) {
  for (const recorded of [true, false]) {
    test(`${snapshot} ${recorded ? 'recorded' : 'direct'} rejection survives telemetry construction failure`,
      async t => {
        const secret = 'fixture-private-credential-do-not-log';
        let armed = false;
        let faults = 0;
        const original = Date.prototype.toISOString;
        t.mock.method(Date.prototype, 'toISOString', function () {
          if (!armed) return original.call(this);
          armed = false;
          faults++;
          const error = recorded ? new Error(secret) : new PilotError(secret, secret);
          throw Object.assign(error, {
            name: secret, code: secret, stack: secret,
            stdout: secret, stderr: secret, environment: { AUTH_TOKEN: secret }
          });
        });
        const rejection = recorded ? 'content-mismatch' : 'unknown-event';
        const reason = recorded ? 'content-fingerprint-mismatch' : 'node_modules:change:unknown';
        const primaryMessage = `Gate diagnostic ${snapshot === 'dependencies'
          ? 'dependency snapshot changed while it was recorded'
          : 'prepared outputs changed while they were recorded'} (${reason})`;
        const ctx = await preparationFixture(t, snapshot, rejection, () => { armed = true; });
        const expectedSecondary = {
          code: 'verification-telemetry-failed',
          message: 'Prepared-output verification telemetry could not be constructed.',
          stage: `${snapshot === 'dependencies' ? 'dependency' : 'compile'}-output-verification`
        };
        let prepared;
        if (recorded) {
          prepared = await prepareValidation(ctx.config, ctx.job, ctx.repo, ctx.revision);
          const failure = prepared[ctx.gate.id];
          assert.equal(failure.error.code, 'blocked-validation');
          assert.equal(failure.error.message, primaryMessage);
          assert.equal(failure.failure.status, 'blocked');
          assert.equal(failure.failure.blockedReason, 'blocked-validation');
          assert.deepEqual(failure.failure.output.secondaryError, expectedSecondary);
          assert.equal(json(failure).includes(secret), false);
        }
        const callsBeforeValidation = recorded ? ctx.stages() : null;
        const validation = (await runValidation(ctx.config, ctx.ledger,
          ctx.job, ctx.repo, ctx.revision, undefined, undefined, prepared))[0];
        assert.equal(ctx.injected(), true);
        assert.equal(faults, 1, 'Only diagnostic construction must be faulted');
        assert.equal(validation.status, 'blocked');
        assert.equal(validation.blockedReason, 'blocked-validation');
        assert.equal(validation.attemptCount, 1);
        const artifact = JSON.parse(readFileSync(validation.artifactRefs[0]));
        assert.equal(artifact.status, 'blocked');
        assert.equal(artifact.blockedReason, 'blocked-validation');
        assert.equal(artifact.output.exitCode, 'blocked-validation');
        assert.equal(artifact.output.stderr, primaryMessage);
        assert.deepEqual(artifact.output.secondaryError, expectedSecondary);
        assert.equal(ctx.ledger.status().operations[0].state, 'blocked');
        assert.equal(json({ validation, artifact }).includes(secret), false);
        assert.equal(artifact.telemetry.preparationTimings.some(stage =>
          stage.id === expectedSecondary.stage), false);
        const stages = ctx.stages();
        assert.equal(stages.filter(stage => stage === 'dependencies').length, 1);
        assert.equal(stages.filter(stage => stage === 'compile').length,
          snapshot === 'compile' ? 1 : 0);
        assert.equal(stages.includes('policy'), false);
        assert.equal(stages.includes('test'), false);
        if (recorded) assert.deepEqual(stages, callsBeforeValidation);
      });
  }
}

test('successful native fixture keeps receipt integrity and reuse unchanged', async t => {
  const ctx = await preparationFixture(t, 'compile', null);
  const prepared = await prepareValidation(ctx.config, ctx.job, ctx.repo, ctx.revision);
  const receipt = prepared[ctx.gate.id];
  assert.equal(receipt.error, undefined, JSON.stringify(receipt.error));
  const receipts = [receipt.receiptPath, receipt.dependencyReceiptPath].map(path => {
    const bytes = readFileSync(path, 'utf8');
    const { integrity, ...body } = JSON.parse(bytes);
    assert.equal(hash(json(body)), integrity);
    assert.equal(body.timings.some(stage => stage.id.endsWith('-output-verification')), false);
    if (body.type === 'compile') {
      assert.deepEqual(receipt.timings, body.timings);
      assert.equal(receipt.integrity, integrity);
    }
    return { path, bytes };
  });
  const validation = (await runValidation(ctx.config, ctx.ledger,
    ctx.job, ctx.repo, ctx.revision, undefined, undefined, prepared))[0];
  assert.equal(validation.status, 'passed');
  const artifact = JSON.parse(readFileSync(validation.artifactRefs[0]));
  assert.equal(artifact.telemetry.dependencyCache, 'hit');
  assert.equal(artifact.telemetry.compileCache, 'hit');
  for (const { path, bytes } of receipts)
    assert.equal(readFileSync(path, 'utf8'), bytes);
  for (const stage of ['dependencies', 'compile', 'policy', 'test'])
    assert.equal(ctx.stages().filter(value => value === stage).length, 1);
});
