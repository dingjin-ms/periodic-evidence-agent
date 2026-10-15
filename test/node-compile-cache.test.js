import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { nativeCommand, nativeTemporaryDirectory } from '../src/native-command.js';
import { minimalEnvironment } from '../src/workers.js';

test('Node 24.19 Windows compile-cache threshold reproduces the captured launcher boundary', {
  skip: process.platform !== 'win32' || process.version !== 'v24.19.0'
}, async t => {
  const root = mkdtempSync(join(tmpdir(), 'compile-cache-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const temporaryDirectory = join(root, 't'.repeat(224 - root.length - 1));
  mkdirSync(temporaryDirectory);
  const script = join(root, 'cache.cjs');
  writeFileSync(script, `console.log('before-cache');console.log(JSON.stringify(require('module').enableCompileCache()));`);
  const env = { ...minimalEnvironment(), TEMP: temporaryDirectory, TMP: temporaryDirectory, TMPDIR: temporaryDirectory };
  let first;
  try { first = await nativeCommand(process.execPath, [script], root, 5000, env); }
  catch (error) { first = { killed: error.killed, code: error.code, stdout: error.stdout, stderr: error.stderr }; }
  console.log(JSON.stringify({ longTemporaryLength: temporaryDirectory.length, first }));
  assert.equal(first.killed, true);
  assert.equal(first.stdout.trim(), 'before-cache');
  const priorTemp = join(root, 'p'.repeat(230 - root.length - 1));
  mkdirSync(priorTemp);
  const prior = await nativeCommand(process.execPath, [script], root, 5000,
    { ...env, TEMP: priorTemp, TMP: priorTemp, TMPDIR: priorTemp });
  console.log(JSON.stringify({ priorPassingTemporaryLength: priorTemp.length, prior }));
  assert.match(prior.stdout, /"status":0/);
});

test('short fresh native TEMP enables compile cache without opt-outs or extra cache configuration', async t => {
  const root = mkdtempSync(join(tmpdir(), 'compile-cache-short-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const temporaryDirectory = nativeTemporaryDirectory(root, 'synthetic-validation');
  mkdirSync(temporaryDirectory, { recursive: true });
  const script = join(root, 'cache.cjs');
  writeFileSync(script, `console.log(JSON.stringify(require('module').enableCompileCache()));`);
  const result = await nativeCommand(process.execPath, [script], root, 5000, {
    ...minimalEnvironment(), TEMP: temporaryDirectory, TMP: temporaryDirectory, TMPDIR: temporaryDirectory
  });
  const cache = JSON.parse(result.stdout);
  assert.equal(cache.status, 1);
  assert.ok(cache.directory.startsWith(join(temporaryDirectory, 'node-compile-cache')));
  console.log(JSON.stringify({ temporaryPathLength: temporaryDirectory.length, cache }));
  assert.equal(result.stderr, '');
  if (process.platform === 'win32')
    assert.throws(() => nativeTemporaryDirectory(join(root, 'x'.repeat(180)), 'synthetic'), /shorter private/);
});
