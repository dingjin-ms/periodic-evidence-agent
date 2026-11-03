import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { existsSync, mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { benchmarkOptions, sampleSummary } from '../scripts/benchmark-fingerprint.mjs';

test('benchmark requires an explicit new local output and bounded sample counts', () => {
  const path = join(tmpdir(), `benchmark-options-${process.pid}.json`);
  assert.deepEqual(benchmarkOptions(['--output', path]), {
    output: path, samples: 3, files: 4096
  });
  for (const args of [
    [], ['--output', 'relative.json'], ['--output', path, '--samples', '0'],
    ['--output', path, '--files', '32769'], ['--output', path, '--samples', '1.5'],
    ['--output', path, '--unknown', '1'], ['--output', path, '--samples'],
    ['--output', path, '--output', path],
    ['--output', fileURLToPath(import.meta.url)],
    ['--output', join(tmpdir(), 'e2e-evidence', 'benchmark.json')]
  ]) assert.throws(() => benchmarkOptions(args));
});

test('small benchmark samples report honest raw ranges, not percentile claims', () => {
  assert.deepEqual(sampleSummary([4, 1, 7]), {
    sampleCount: 3, minMs: 1, maxMs: 7, meanMs: 4, rawMs: [4, 1, 7],
    percentileClaim: 'None: small local samples, not a stable p50/p95 estimate'
  });
  assert.throws(() => sampleSummary([]));
  assert.throws(() => sampleSummary([NaN]));
});

test('benchmark output cannot enter e2e-evidence through a directory alias', t => {
  const root = mkdtempSync(join(tmpdir(), 'benchmark-output-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'e2e-evidence'));
  symlinkSync(join(root, 'e2e-evidence'), join(root, 'alias'),
    process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => benchmarkOptions([
    '--output', join(root, 'alias', 'new', 'benchmark.json')
  ]), /e2e-evidence/);
});

test('dependency benchmarks reject aliased frozen evidence before creating directories', t => {
  const root = mkdtempSync(join(tmpdir(), 'dependency-benchmark-boundary-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'e2e-evidence'));
  symlinkSync(join(root, 'e2e-evidence'), join(root, 'alias'),
    process.platform === 'win32' ? 'junction' : 'dir');
  for (const [script, prefix] of [
    ['benchmark-dependency-scan.mjs', []],
    ['benchmark-file-hash.mjs', ['--baseline', '0'.repeat(40)]],
    ['benchmark-prepared-reverification.mjs', ['--baseline', '0'.repeat(40)]]
  ]) {
    const child = spawnSync(process.execPath, [
      fileURLToPath(new URL(`../scripts/${script}`, import.meta.url)),
      ...prefix, '--output', join(root, 'alias', 'new', 'result.json')
    ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.ifError(child.error);
    assert.notEqual(child.status, 0);
    assert.match(child.stderr, /e2e-evidence/);
    assert.equal(existsSync(join(root, 'e2e-evidence', 'new')), false);
  }
});
