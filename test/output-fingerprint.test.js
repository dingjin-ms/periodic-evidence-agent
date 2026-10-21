import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync
} from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import { channel } from 'node:diagnostics_channel';
import {
  outputPathFingerprint, outputPathFingerprintWithEntries,
  dependencyEntriesFingerprint, dependencyEntryFingerprintWithEntries
} from '../src/output-fingerprint.js';
import { outputFingerprint } from '../src/workers.js';
import { hash } from '../src/hash.js';

test('parallel fingerprint workers stay schema-free and preserve complete output hashes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'output-fingerprint-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'output'));
  writeFileSync(join(root, 'output', 'synthetic.txt'), 'synthetic output\n');
  const paths = ['output', 'output/synthetic.txt', 'missing'];
  const expected = paths.map(path => outputPathFingerprint(root, path));
  const entry = new URL('../src/output-fingerprint-worker.js', import.meta.url).href;
  const bootstrap = `
    const fs = require('node:fs');
    const { syncBuiltinESMExports } = require('node:module');
    const { workerData } = require('node:worker_threads');
    const readFile = fs.readFileSync;
    fs.readFileSync = (path, ...args) => {
      if (String(path).endsWith('contracts.schema.json'))
        throw Error('Fingerprint workers must not initialize controller schemas');
      return readFile(path, ...args);
    };
    syncBuiltinESMExports();
    import(workerData.entry).catch(error => { throw error; });
  `;
  for (let round = 0; round < 4; round++) {
    const workers = Array.from({ length: 8 }, () =>
      new Worker(bootstrap, { eval: true, workerData: { entry } }));
    try {
      await Promise.all(workers.map(async worker => {
        for (const [index, path] of paths.entries()) {
          const reply = once(worker, 'message');
          worker.postMessage({ workspace: root, index, path });
          const [result] = await reply;
          assert.deepEqual(result, {
            index, valid: expected[index] !== null,
            serialized: JSON.stringify(expected[index])
          });
        }
      }));
    } finally {
      await Promise.all(workers.map(worker => worker.terminate()));
    }
  }
});

test('bounded dependency batches preserve serial hashes and every captured entry', async t => {
  const root = mkdtempSync(join(tmpdir(), 'fingerprint-batches-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = ['node_modules', 'extra/node_modules', 'dist'];
  for (const path of paths)
    mkdirSync(join(root, path), { recursive: true });
  for (const [name, count] of [
    ['wide', 4097], ['nested/a/b', 2048], ['boundary', 2047], ['empty', 0]
  ]) {
    mkdirSync(join(root, 'node_modules', name), { recursive: true });
    for (let index = 0; index < count; index++)
      writeFileSync(join(root, 'node_modules', name, `${index}.js`), `${index}\n`);
  }
  mkdirSync(join(root, 'extra/node_modules', '@scope', 'pkg'), { recursive: true });
  writeFileSync(join(root, 'extra/node_modules', '@scope', 'pkg', 'large.bin'),
    Buffer.alloc(1024 * 1024 + 17, 97));
  symlinkSync(join(root, 'dist'), join(root, 'node_modules', 'internal-link'),
    process.platform === 'win32' ? 'junction' : 'dir');
  writeFileSync(join(root, 'node_modules', '.yarn-state.yml'), 'state\n');
  writeFileSync(join(root, 'dist', 'output.js'), 'compiled\n');
  const expected = paths.map(path => outputPathFingerprintWithEntries(root, path));
  const expectedHash = hash(JSON.stringify(expected.map(result => result.value)));
  const telemetry = {};
  const captured = await outputFingerprint(root, paths, true, telemetry);
  assert.equal(captured.sha256, expectedHash);
  assert.deepEqual(captured.entries, new Map(expected.flatMap(result => result.entries)));
  assert.equal(await outputFingerprint(root, paths), expectedHash);
  if (telemetry.taskCount != null) {
    assert.ok(telemetry.taskCount < 16, JSON.stringify(telemetry));
    assert.equal(telemetry.hashedFileCount, 8195);
    for (const key of ['planningMs', 'durationMs', 'processCpuMs',
      'workerPoolWallMs', 'dispatchQueueMaxMs', 'taskRoundTripMaxMs',
      'workerComputeMaxMs', 'workerSerializeSumMs'])
      assert.ok(Number.isFinite(telemetry[key]) && telemetry[key] >= 0, key);
    assert.ok(telemetry.serializedBytes > 0);
  }
  writeFileSync(join(root, 'node_modules', 'wide', '4096.js'), 'evil\n');
  assert.notEqual(await outputFingerprint(root, paths), expectedHash);
});

test('a batch containing an escaping dependency link fails closed', async t => {
  const root = mkdtempSync(join(tmpdir(), 'fingerprint-invalid-batch-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'node_modules'));
  writeFileSync(join(root, 'node_modules', 'valid.js'), 'valid\n');
  symlinkSync(tmpdir(), join(root, 'node_modules', 'escape'),
    process.platform === 'win32' ? 'junction' : 'dir');
  assert.equal(await outputFingerprint(root, ['node_modules'], true), null);
  assert.equal(await outputFingerprint(root, ['node_modules']), null);
});

test('large native stores split into bounded tasks without changing generic tree hashes', async t => {
  const root = mkdtempSync(join(tmpdir(), 'fingerprint-store-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = 'midgard/.store';
  const packageRoot = join(root, path, 'package', 'node_modules', 'pkg');
  mkdirSync(packageRoot, { recursive: true });
  for (let index = 0; index < 2100; index++)
    writeFileSync(join(packageRoot, `${index}.js`), `${index}\n`);
  mkdirSync(join(root, path, 'empty'));
  symlinkSync(packageRoot, join(root, path, 'internal-link'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const expected = outputPathFingerprintWithEntries(root, path);
  const expectedHash = hash(JSON.stringify([expected.value]));
  const telemetry = {};
  const actual = await outputFingerprint(root, [path], true, telemetry);
  assert.equal(actual.sha256, expectedHash);
  assert.deepEqual(actual.entries, new Map(expected.entries));
  assert.equal(await outputFingerprint(root, [path]), expectedHash);
  if (telemetry.taskCount != null) {
    assert.ok(telemetry.taskCount > 1);
    assert.ok(telemetry.taskCount <= 4, JSON.stringify(telemetry));
    assert.equal(telemetry.hashedFileCount, 2100);
  }
  writeFileSync(join(packageRoot, '2099.js'), 'changed\n');
  assert.notEqual(await outputFingerprint(root, [path]), expectedHash);
});

test('generic tree batches stay bounded across the split threshold and multiple output roots', async t => {
  const root = mkdtempSync(join(tmpdir(), 'fingerprint-tree-batches-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const paths = ['midgard/.store', 'dist/empty', 'dist/value.js'];
  mkdirSync(join(root, paths[0]), { recursive: true });
  mkdirSync(join(root, paths[1]), { recursive: true });
  writeFileSync(join(root, paths[2]), 'compiled\n');
  let files = 0;
  for (const count of [2047, 2048, 8192]) {
    for (; files < count; files++)
      writeFileSync(join(root, paths[0], `${files}.js`), `${files}\n`);
    const expected = paths.map(path => outputPathFingerprintWithEntries(root, path));
    const expectedHash = hash(JSON.stringify(expected.map(result => result.value)));
    const telemetry = {};
    const actual = await outputFingerprint(root, paths, true, telemetry);
    assert.equal(actual.sha256, expectedHash);
    assert.deepEqual(actual.entries, new Map(expected.flatMap(result => result.entries)));
    assert.equal(await outputFingerprint(root, paths), expectedHash);
    if (telemetry.taskCount != null) {
      assert.ok(telemetry.taskCount <= Math.ceil(count / 2048) + 1, JSON.stringify(telemetry));
      assert.equal(telemetry.hashedFileCount, count + 1);
    }
  }
  writeFileSync(join(root, paths[0], '8191.js'), 'changed\n');
  const expected = paths.map(path => outputPathFingerprint(root, path));
  assert.equal(await outputFingerprint(root, paths), hash(JSON.stringify(expected)));
});

test('generic tree worker batches reject a missing member without returning partial captures', async t => {
  const root = mkdtempSync(join(tmpdir(), 'fingerprint-tree-missing-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  writeFileSync(join(root, 'present.js'), 'present\n');
  const worker = new Worker(new URL('../src/output-fingerprint-worker.js', import.meta.url));
  try {
    for (const captureEntries of [false, true]) {
      const reply = once(worker, 'message');
      worker.postMessage({
        workspace: root, index: 0, mode: 'tree-paths',
        paths: ['present.js', 'missing.js'], captureEntries
      });
      const [result] = await reply;
      assert.deepEqual(result, {
        index: 0, valid: false, serialized: 'null',
        ...(captureEntries ? { entries: null } : {})
      });
    }
  } finally {
    await worker.terminate();
  }
});

test('generic tree batches propagate cancellation while the worker pool is active', async t => {
  const root = mkdtempSync(join(tmpdir(), 'fingerprint-tree-abort-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = 'midgard/.store';
  mkdirSync(join(root, path), { recursive: true });
  for (let index = 0; index < 2100; index++)
    writeFileSync(join(root, path, `${index}.js`), 'content\n');
  const controller = new AbortController();
  const reason = new Error('Cancel active tree batches');
  const progress = channel('periodic-evidence-agent.validation-preparation');
  let dispatched = false;
  const cancel = event => {
    if (event.workspace === root && event.event === 'output-fingerprint-tasks' &&
      event.completed === 0) {
      dispatched = true;
      setImmediate(() => controller.abort(reason));
    }
  };
  progress.subscribe(cancel);
  try {
    if (availableParallelism() > 1) {
      await assert.rejects(outputFingerprint(root, [path], true, null, controller.signal),
        error => error === reason);
      assert.equal(dispatched, true);
    } else {
      controller.abort(reason);
      await assert.rejects(outputFingerprint(root, [path], true, null, controller.signal),
        error => error === reason);
    }
  } finally {
    progress.unsubscribe(cancel);
  }
});

test('empty dependency roots retain the serial fingerprint schema', async t => {
  const root = mkdtempSync(join(tmpdir(), 'fingerprint-empty-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'node_modules'));
  const expected = outputPathFingerprintWithEntries(root, 'node_modules');
  assert.deepEqual(await outputFingerprint(root, ['node_modules'], true), {
    sha256: hash(JSON.stringify([expected.value])), entries: new Map(expected.entries)
  });
});

test('one dependency batch resolves its physical workspace once without skipping entries', t => {
  const root = mkdtempSync(join(tmpdir(), 'fingerprint-physical-root-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'node_modules'));
  const paths = Array.from({ length: 32 }, (_, index) => `${index}.js`);
  for (const path of paths) writeFileSync(join(root, 'node_modules', path), 'same\n');
  const original = realpathSync.native;
  let calls = 0;
  realpathSync.native = (...args) => { calls++; return original(...args); };
  try {
    const expected = paths.map(path =>
      dependencyEntryFingerprintWithEntries(root, 'node_modules', path));
    assert.equal(calls, 32);
    calls = 0;
    const actual = dependencyEntriesFingerprint(root, 'node_modules', paths, true);
    assert.equal(calls, 1);
    assert.deepEqual(actual, {
      value: expected.map(result => result.value),
      entries: expected.flatMap(result => result.entries)
    });
    assert.equal(dependencyEntriesFingerprint(root, 'node_modules', ['../outside'], true), null);
    assert.equal(dependencyEntriesFingerprint(root, 'node_modules', ['missing'], true), null);
  } finally {
    realpathSync.native = original;
  }
});
