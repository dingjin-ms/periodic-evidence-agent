import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hash } from '../src/common.js';
import { verifyTestOnlyProfileChange } from '../src/workers.js';
import { isolateNativeJestCache, verifyNativeJestCacheFailure }
  from '../src/local-jest-cache-continuation.js';

const original = [
  'Invoke-Checked native-compile',
  "if ($stage -in @('all', 'test')) {",
  "    $resultDirectory = Join-Path $PSScriptRoot 'al-native-results'",
  '    Invoke-Checked node native-test `',
  '            --passWithNoTests=false --json --outputFile $output',
  '}', ''
].join('\n');
const artifact = () => ({
  status: 'blocked', blockedReason: 'prepared-cache-corrupt', revision: 'authored',
  telemetry: { validationRevision: 'authored', validationTimings: [
    { id: 'test', outputSha256: 'test-output' },
    { id: 'cleanup', cache: 'invalidated', subphases: [
      { id: 'verify-prepared-outputs', reason: 'rename:node_modules/.cache/jest' }
    ] }
  ] },
  output: {
    stdout: 'PILOT_VALIDATION_TEST_RESULT:' + JSON.stringify({
      suiteCount: 2, testCount: 3, selectedTests: ['tests/case.integration.test.ts'],
      resultSha256: 'a'.repeat(64)
    }),
    stderr: 'Test Suites: 2 passed, 2 total\nTests:       3 passed, 3 total\n'
  }
});

test('native Jest isolation changes only supported cache/result locations', () => {
  const corrected = isolateNativeJestCache(original, resolve('private-runtime/artifacts'));
  assert.match(corrected, /--cacheDirectory \$cacheDirectory/);
  assert.match(corrected, /--passWithNoTests=false --json --outputFile \$output/);
  assert.ok(corrected.startsWith('Invoke-Checked native-compile\n'));
  assert.throws(() => isolateNativeJestCache(original + original, resolve('artifacts')), /exactly one/);
  assert.throws(() => isolateNativeJestCache(original, 'relative'), /absolute literal/);
  assert.throws(() => isolateNativeJestCache(original, resolve("bad'path")), /absolute literal/);
});
test('flat native test profile rebinding rejects preparation changes and hash drift', t => {
  const parent = resolve('private-runtime/ct');
  mkdirSync(parent, { recursive: true });
  const root = mkdtempSync(join(parent, 'jest-profile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const corrected = isolateNativeJestCache(original, join(root, 'artifacts'));
  const previous = { profilePath: join(root, 'before.ps1'), profileSha256: hash(original) };
  const next = { profilePath: join(root, 'after.ps1'), profileSha256: hash(corrected) };
  writeFileSync(previous.profilePath, original);
  writeFileSync(next.profilePath, corrected);
  assert.ok(verifyTestOnlyProfileChange(previous, next));
  const changed = corrected.replace('native-compile', 'different-compile');
  writeFileSync(next.profilePath, changed);
  assert.throws(() => verifyTestOnlyProfileChange(previous, next), /content-bound/);
  assert.throws(() => verifyTestOnlyProfileChange(previous,
    { ...next, profileSha256: hash(changed) }), /only the final test runner/);
});
test('only actual passing full-suite output with the exact cache cleanup failure can continue', () => {
  assert.equal(verifyNativeJestCacheFailure(artifact(), 'authored').testCount, 3);
  for (const mutate of [
    a => { a.revision = 'different'; },
    a => { a.status = 'passed'; },
    a => { a.telemetry.validationTimings[1].subphases[0].reason = 'rename:node_modules/package'; },
    a => { a.telemetry.validationTimings[0].outputSha256 = null; },
    a => { a.output.stdout = ''; },
    a => { a.output.stderr = 'Tests: 1 failed, 3 total'; },
    a => { a.output.stdout += '\n' + a.output.stdout; }
  ]) {
    const value = artifact(); mutate(value);
    assert.throws(() => verifyNativeJestCacheFailure(value, 'authored'));
  }
});
