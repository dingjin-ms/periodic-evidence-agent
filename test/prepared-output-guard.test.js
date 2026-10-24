import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire, syncBuiltinESMExports } from 'node:module';
import { EventEmitter } from 'node:events';
import {
  mkdtempSync, mkdirSync, writeFileSync, readFileSync, renameSync, rmSync, symlinkSync
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
  watcher.options = options;
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
const { command, prepareValidation: prepare, runValidation: validate, capturePreparedOutputs: captureOutputs,
  outputFingerprint, verifyPreparedOutputs: verifyOutputs, coalescePreparedOutputChanges,
  planPreparedOutputChanges } =
  await import('../src/workers.js');
const { Ledger } = await import('../src/ledger.js');
const { hash, json, PilotError } = await import('../src/common.js');
const { withPreparedOutputObserver } = await import('../src/prepared-output-observer.js');
const observerFactory = async () => ({ watch: fs.watch, ready: async () => {}, close() {} });
const prepareValidation = (...args) =>
  withPreparedOutputObserver(observerFactory, () => prepare(...args));
const runValidation = (...args) =>
  withPreparedOutputObserver(observerFactory, () => validate(...args));
const capturePreparedOutputs = (receipt, workspace, paths, expected = null, telemetry = null) =>
  captureOutputs(receipt, workspace, paths, expected, telemetry, observerFactory);
const verifyPreparedOutputs = (receipt, workspace, outputs, baseline = null) =>
  verifyOutputs(receipt, workspace, outputs, baseline, observerFactory);
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
  return { workspace, root, nested, file, outputs, receipt, verify, initialize, watcher };
}

test('cold receipt verification observes one complete scan and warm reuse reads no contents', async t => {
  const ctx = await fixture(t);
  let tasks = 0;
  onWorkerResult = () => { tasks++; };
  const result = await ctx.verify();
  assert.equal(result.valid, true);
  assert.equal(result.method, 'content+watch');
  assert.equal(result.fullVerification.baseline.observation.verified, true);
  assert.deepEqual(result.fullVerification.verification, {});
  assert.equal(tasks, 1);
  assert.equal((await ctx.verify()).valid, true);
  assert.equal(tasks, 1);
});

test('new receipt capture keeps observation through receipt verification without a second scan', async t => {
  const ctx = await fixture(t);
  let tasks = 0;
  onWorkerResult = () => { tasks++; };
  const captured = await capturePreparedOutputs(ctx.receipt, ctx.workspace, ctx.outputs.paths);
  assert.equal(captured.sha256, ctx.outputs.sha256);
  const result = await verifyPreparedOutputs(
    ctx.receipt, ctx.workspace, ctx.outputs, captured.entries);
  assert.equal(result.valid, true);
  assert.equal(result.method, 'watch');
  assert.equal(tasks, 1);
});

test('content capture waits for asynchronous observer readiness before reading', async t => {
  const ctx = await fixture(t);
  let ready = false, tasks = 0;
  onWorkerResult = () => {
    assert.equal(ready, true);
    tasks++;
  };
  const factory = async () => ({
    watch: fs.watch,
    ready: async () => {
      await new Promise(resolve => setTimeout(resolve, 20));
      ready = true;
    },
    close() {}
  });
  const captured = await captureOutputs(
    ctx.receipt, ctx.workspace, ctx.outputs.paths, null, null, factory);
  assert.equal(captured.sha256, ctx.outputs.sha256);
  assert.equal(tasks, 1);
  assert.equal(ready, true);
});

for (const evicted of [false, true]) {
  test(`replacement waits for ${evicted ? 'evicted' : 'active'} observer shutdown`,
    { timeout: 15000 }, async t => {
      const ctx = await fixture(t);
      const closing = Promise.withResolvers();
      const release = Promise.withResolvers();
      let installations = 0;
      const factory = async () => {
        installations++;
        return {
          watch: fs.watch, ready: async () => {},
          close() {
            closing.resolve();
            return release.promise;
          }
        };
      };
      try {
        await captureOutputs(
          ctx.receipt, ctx.workspace, ctx.outputs.paths, null, null, factory);
        if (evicted) {
          for (let index = 0; index < 2; index++) {
            const other = await fixture(t);
            await capturePreparedOutputs(other.receipt, other.workspace, other.outputs.paths);
          }
        }
        const replacement = captureOutputs(
          ctx.receipt, ctx.workspace, ctx.outputs.paths, null, null, factory);
        await closing.promise;
        await new Promise(resolve => setImmediate(resolve));
        assert.equal(installations, 1, 'Old native handles must be released before replacement');
        release.resolve();
        assert.equal((await replacement).sha256, ctx.outputs.sha256);
        assert.equal(installations, 2);
      } finally {
        release.resolve();
      }
    });
}

test('cold receipt verification retains the full comparison when observation is unavailable', async t => {
  const ctx = await fixture(t);
  let tasks = 0;
  onWorkerResult = () => { tasks++; };
  onWatch = () => { throw new Error('recursive observation unavailable'); };
  const result = await ctx.verify();
  assert.equal(result.valid, true);
  assert.equal(result.method, 'content');
  assert.equal(result.fullVerification.baseline.observation.available, false);
  assert.equal(tasks, 2);
});

test('metadata-only changes during cold capture rehash the touched file without another full scan', async t => {
  const ctx = await fixture(t);
  let tasks = 0;
  onWorkerResult = () => {
    if (++tasks !== 1) return;
    writeFileSync(ctx.file, readFileSync(ctx.file));
    ctx.watcher().callback('change', 'fixture/nested/value.js');
  };
  const result = await ctx.verify();
  assert.equal(result.valid, true);
  assert.equal(result.details.hashedFileCount, 1);
  assert.equal(tasks, 2);
});

for (const mutation of ['child-change', 'parent-rename', 'unknown-child']) {
  test(`partitioned native-store observation rejects ${mutation}`, async t => {
    const ctx = await fixture(t, 'midgard/.store');
    for (let bucket = 0; bucket < 18; bucket++) {
      const directory = join(ctx.nested, `bucket-${bucket}`);
      mkdirSync(directory);
      for (let file = 0; file < 120; file++)
        writeFileSync(join(directory, `${file}.js`), `${file}\n`);
    }
    ctx.outputs.sha256 = await outputFingerprint(ctx.workspace, ctx.outputs.paths);
    assert.equal((await ctx.verify()).valid, true);
    assert.equal(ctx.watcher().options.recursive, false);
    assert.equal(watchers.get(ctx.nested).options.recursive, false);
    const child = join(ctx.nested, 'bucket-0');
    const childWatcher = watchers.get(child);
    assert.equal(childWatcher.options.recursive, true);
    if (mutation === 'child-change') {
      writeFileSync(join(child, '0.js'), 'changed\n');
      childWatcher.callback('change', '0.js');
    } else if (mutation === 'parent-rename') {
      renameSync(child, join(ctx.nested, 'renamed'));
      watchers.get(ctx.nested).callback('rename', 'bucket-0');
    } else {
      childWatcher.callback('rename', null);
    }
    const result = await ctx.verify();
    assert.equal(result.valid, false);
    assert.equal(ctx.watcher().closed, true);
    assert.equal(childWatcher.closed, true);
  });
}

for (const event of ['change', 'ancestor-change', 'delete', 'add', 'rename', 'watch-error', 'null-filename']) {
  test(`cold capture rejects ${event} delivered after a file was hashed`, async t => {
    const ctx = await fixture(t);
    let injected = false;
    onWorkerResult = () => {
      if (injected) return;
      injected = true;
      if (event === 'change' || event === 'ancestor-change') {
        writeFileSync(ctx.file, 'changed after hashing\n');
        ctx.watcher().callback('change',
          event === 'change' ? 'fixture/nested/value.js' : 'fixture');
      } else if (event === 'delete') {
        rmSync(ctx.file);
        ctx.watcher().callback('rename', 'fixture/nested/value.js');
      } else if (event === 'add') {
        writeFileSync(join(ctx.nested, 'injected.js'), 'injected\n');
        ctx.watcher().callback('rename', 'fixture/nested/injected.js');
      } else if (event === 'rename') {
        renameSync(ctx.file, join(ctx.nested, 'renamed.js'));
        ctx.watcher().callback('rename', 'fixture/nested/value.js');
      } else if (event === 'watch-error') {
        ctx.watcher().emit('error', new Error('injected watcher failure'));
      } else {
        writeFileSync(ctx.file, 'changed with an anonymous notification\n');
        ctx.watcher().callback('change', null);
      }
    };
    const result = await ctx.verify();
    assert.equal(injected, true);
    assert.equal(result.valid, false);
    assert.equal(ctx.watcher().closed, true);
  });
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

test('change coalescing preserves ancestor coverage, path boundaries and ordering', () => {
  const paths = [
    'dist/pkg/nested/a.js', 'dist/pkg-extra/a.js', 'dist/pkg',
    'dist/other/b.js', 'dist/other/a.js', 'dist/pkg/nested', 'dist/pkg',
    'dist/A/a.js', 'dist/a', 'dist', 'dist-extra', 'dist-extra/value.js',
    '/absolute/child', '', '/absolute', 'bare', 'barely/value.js'
  ];
  const original = [...paths];
  const reference = [...paths].sort((a, b) => a.length - b.length || a.localeCompare(b))
    .filter((path, index, values) => !values.slice(0, index)
      .some(parent => path.startsWith(`${parent}/`)));
  assert.deepEqual(coalescePreparedOutputChanges(paths), reference);
  assert.deepEqual(paths, original);
  assert.deepEqual(coalescePreparedOutputChanges([]), []);
  assert.deepEqual(coalescePreparedOutputChanges([
    'dist/pkg/a.js', 'dist/pkg-extra/b.js', 'dist/pkg'
  ]), ['dist/pkg', 'dist/pkg-extra/b.js']);
});

test('change coalescing does not compare every pair of sibling paths', () => {
  const paths = Array.from({ length: 2048 }, (_, index) =>
    `dist/pkg/${String(index).padStart(5, '0')}.js`);
  const startsWith = String.prototype.startsWith;
  let comparisons = 0;
  let result;
  try {
    String.prototype.startsWith = function (...args) {
      comparisons++;
      return startsWith.apply(this, args);
    };
    result = coalescePreparedOutputChanges(paths);
  } finally {
    String.prototype.startsWith = startsWith;
  }
  assert.deepEqual(result, paths);
  assert.ok(comparisons <= paths.length * 3,
    `${comparisons} prefix comparisons for ${paths.length} sibling paths`);
});

test('change planning preserves exact roots, nested dependency roots and path boundaries', () => {
  assert.deepEqual(planPreparedOutputChanges([
    'node_modules', 'node_modules/nested/node_modules',
    'node_modules/nested/node_modules/pkg/dist', 'dist', 'dist-extra'
  ], [
    'dist', 'node_modules/pkg/a.js',
    'node_modules/nested/node_modules/child/a.js',
    'node_modules/nested/node_modules/pkg/dist/a.js',
    'dist-extra/a.js', 'dist-other/a.js'
  ]), {
    roots: ['dist'],
    requestedTasks: [
      { mode: 'dependency-entry', dependencyPath: 'node_modules', entryPath: 'pkg/a.js' },
      { mode: 'dependency-entry', dependencyPath: 'node_modules/nested/node_modules',
        entryPath: 'child/a.js' },
      { mode: 'path', path: 'node_modules/nested/node_modules/pkg/dist/a.js' },
      { mode: 'path', path: 'dist-extra/a.js' },
      null
    ]
  });
  const caseSensitive = process.platform !== 'win32';
  assert.deepEqual(planPreparedOutputChanges(['Dist', 'dist'], ['dist', 'dist/a.js']), {
    roots: [caseSensitive ? 'dist' : 'Dist'],
    requestedTasks: [{ mode: 'path', path: 'dist/a.js' }]
  });
  if (!caseSensitive) {
    const parent = 'i\u0307i\u0307/node_modules';
    const nested = '\u0130\u0130/node_modules/a';
    const path = `${parent}/a/file.js`;
    assert.deepEqual(planPreparedOutputChanges([parent, nested], [path]), {
      roots: [],
      requestedTasks: [{ mode: 'dependency-entry', dependencyPath: parent,
        entryPath: 'a/file.js' }]
    });
    assert.deepEqual(planPreparedOutputChanges([nested, parent], [path]), {
      roots: [], requestedTasks: [{ mode: 'path', path }]
    });
  }
});

test('change planning normalizes output roots once instead of once per event', () => {
  const roots = Array.from({ length: 128 }, (_, index) =>
    `packages/pkg-${index}/node_modules`);
  const paths = Array.from({ length: 256 }, (_, index) =>
    `${roots[index % roots.length]}/dependency/${index}.js`);
  const replaceAll = String.prototype.replaceAll;
  let normalizations = 0;
  let result;
  try {
    String.prototype.replaceAll = function (...args) {
      normalizations++;
      return replaceAll.apply(this, args);
    };
    result = planPreparedOutputChanges(roots, paths);
  } finally {
    String.prototype.replaceAll = replaceAll;
  }
  assert.equal(normalizations, roots.length);
  assert.deepEqual(result.roots, []);
  assert.equal(result.requestedTasks.length, paths.length);
  assert.ok(result.requestedTasks.every(task => task.mode === 'dependency-entry'));
});

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
  for (const event of ['rename', 'delete', 'watch-error', 'null-rename', 'null-filename-with-mutation']) {
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
          } else if (event === 'null-rename') {
            ctx.watcher().callback('rename', null);
          } else {
            writeFileSync(ctx.file, 'changed behind an unknown event\n');
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

for (const rootPath of ['node_modules', 'dist']) {
  for (const initial of [false, true]) {
    test(`${initial ? 'initial' : 'warm'} unknown ${rootPath} change revalidates the complete root`,
      async t => {
        const ctx = await fixture(t, rootPath);
        if (initial) {
          onWatch = watcher => setImmediate(() => watcher.callback('change', null));
        } else {
          assert.equal((await ctx.initialize()).valid, true);
          ctx.watcher().callback('change', null);
        }
        const result = await (initial ? ctx.initialize() : ctx.verify());
        assert.equal(result.valid, true);
        assert.equal(result.details.nullFilenameEventCount, 1);
        assert.equal(result.details.fullRootRevalidationCount, 1);
        assert.equal(result.details.hashedFileCount, 1);
      });
  }
  for (const mutation of ['modify', 'delete', 'add']) {
    test(`unknown ${rootPath} change detects nested ${mutation}`, async t => {
      const ctx = await fixture(t, rootPath);
      assert.equal((await ctx.initialize()).valid, true);
      if (mutation === 'modify') writeFileSync(ctx.file, 'corrupt\n');
      if (mutation === 'delete') rmSync(ctx.file);
      if (mutation === 'add')
        writeFileSync(join(ctx.nested, 'injected.js'), 'injected\n');
      ctx.watcher().callback('change', null);
      const result = await ctx.verify();
      assert.equal(result.valid, false);
      assert.match(result.reason, /content-changed/);
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
    ctx.watcher().callback('rename', null);
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
  let targetPath = null;
  let injected = false;
  onWatch = (watcher, path) => {
    const type = snapshot === 'dependencies' ? 'd' : 'c';
    if (!path.startsWith(stateDirectory) ||
      !path.includes(`${sep}pv${sep}${type}${sep}`) ||
      !path.endsWith(`${sep}node_modules`)) return;
    targetWatcher = watcher;
    targetPath = path;
    if (rejection === 'registration-unknown') {
      watcher.callback('rename', null);
      injected = true;
    }
    if (injected) onRejection?.();
  };
  onWorkerResult = result => {
    if (!rejection || !targetWatcher || injected) return;
    if (rejection === 'content-mismatch' && !(result.entries ?? []).some(([path]) =>
      path.replaceAll('\\', '/') === 'node_modules/fixture/index.js')) return;
    injected = true;
    if (rejection === 'content-mismatch') {
      writeFileSync(join(targetPath, 'fixture', 'index.js'), 'changed after capture\n');
      targetWatcher.callback('change', 'fixture/index.js');
    }
    if (rejection === 'unknown-event') targetWatcher.callback('rename', null);
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
  assert.equal(stage.details.method, 'watch');
  assert.equal(stage.details.fullVerification, undefined);
  if (rejection === 'registration-unknown') {
    assert.equal(stage.details.details.durationMs, 0);
  }
  if (rejection === 'content-mismatch') {
    assert.match(stage.details.reason, /^content-changed:node_modules\/fixture\/index.js$/);
    assert.equal(stage.details.details.observedEventCount, 1);
  } else if (['unknown-event', 'registration-unknown'].includes(rejection)) {
    assert.match(stage.details.reason, /:rename:unknown$/);
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
        const reason = recorded ? 'content-changed:node_modules/fixture/index.js' : 'node_modules:rename:unknown';
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

for (const unstable of [false, true]) {
  test(`complete-root verification rejects ${unstable ? 'unsettled notifications' : 'mutation after hashing'}`,
    async t => {
      const ctx = await fixture(t, 'dist');
      assert.equal((await ctx.initialize()).valid, true);
      const originalReadFile = fs.readFileSync;
      let injected = 0;
      fs.readFileSync = (path, ...args) => {
        const bytes = originalReadFile(path, ...args);
        if (String(path) === ctx.file && (unstable || injected === 0)) {
          injected++;
          if (!unstable) writeFileSync(ctx.file, 'changed during complete-root hashing\n');
          ctx.watcher().callback('change', null);
        }

        return bytes;
      };
      syncBuiltinESMExports();
      try {
        ctx.watcher().callback('change', null);
        const result = await ctx.verify();
        assert.equal(result.valid, false);
        assert.match(result.reason, unstable
          ? /content-revalidation-unstable/ : /content-changed/);
        assert.equal(result.details.settlementPassCount, unstable ? 4 : 2);
        assert.equal(result.details.fullRootRevalidationCount, unstable ? 4 : 2);
        assert.ok(injected > 0);
      } finally {
        fs.readFileSync = originalReadFile;
        syncBuiltinESMExports();
      }
    });
}

test('large ancestor dependency events use bounded subtree tasks without losing coverage', async t => {
  const ctx = await fixture(t);
  for (const name of ['first', 'second']) {
    const directory = join(ctx.root, '@scope', name);
    mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 1100; index++)
      writeFileSync(join(directory, `${index}.js`), `export default ${index};\n`);
  }
  const captured = await outputFingerprint(ctx.workspace, ['node_modules'], true);
  ctx.outputs.sha256 = captured.sha256;
  assert.equal((await verifyPreparedOutputs(join(ctx.workspace, 'receipt.json'),
    ctx.workspace, ctx.outputs, captured.entries)).valid, true);
  ctx.watcher().callback('change', '@scope');
  const unchanged = await ctx.verify();
  assert.equal(unchanged.valid, true);
  assert.equal(unchanged.details.coalescedPathCount, 1);
  assert.equal(unchanged.details.workerTaskCount, 2);
  assert.equal(unchanged.details.hashedFileCount, 2200);
  writeFileSync(join(ctx.root, '@scope', 'second', '1099.js'), 'mutated\n');
  ctx.watcher().callback('change', '@scope');
  const changed = await ctx.verify();
  assert.equal(changed.valid, false);
  assert.match(changed.reason, /content-changed/);
});

test('complete dependency-root revalidation detects a redirected chained junction', async t => {
  const ctx = await fixture(t);
  const first = join(ctx.workspace, 'first');
  const second = join(ctx.workspace, 'second');
  const redirect = join(ctx.workspace, 'redirect');
  mkdirSync(first);
  mkdirSync(second);
  symlinkSync(first, redirect, 'junction');
  symlinkSync(redirect, join(ctx.nested, 'alias'), 'junction');
  const captured = await outputFingerprint(ctx.workspace, ['node_modules'], true);
  ctx.outputs.sha256 = captured.sha256;
  assert.equal((await verifyPreparedOutputs(join(ctx.workspace, 'receipt.json'),
    ctx.workspace, ctx.outputs, captured.entries)).valid, true);
  rmSync(redirect);
  symlinkSync(second, redirect, 'junction');
  ctx.watcher().callback('change', null);
  const result = await ctx.verify();
  assert.equal(result.valid, false);
  assert.match(result.reason, /content-changed/);
});
