import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { correctNativeWrapperSeparator, verifyNativeWrapperFailure } from '../src/local-native-wrapper-continuation.js';
import { command, minimalEnvironment } from '../src/workers.js';

const invocation = "Invoke-Checked node 'docs\\skills\\Integration-test-core\\scripts\\run-integration-tests.mjs' -- ";
test('native wrapper correction quotes exactly one separator and preserves all other profile bytes', () => {
  const profile = `unchanged\r\n${invocation}\`\r\n    $corepack yarn workspace 'fixture' check:integration\r\n`;
  assert.equal(correctNativeWrapperSeparator(profile), profile.replace(' -- ', " '--' "));
  assert.throws(() => correctNativeWrapperSeparator('missing'));
  assert.throws(() => correctNativeWrapperSeparator(invocation + invocation));
  assert.throws(() => correctNativeWrapperSeparator(correctNativeWrapperSeparator(profile)));
});

test('quoted separator reaches the actual Node child of a PowerShell forwarding function',
  { skip: process.platform !== 'win32' }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'native wrapper argv '));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const child = join(root, 'capture.mjs'), profile = join(root, 'invoke.ps1');
    writeFileSync(child, 'console.log(JSON.stringify(process.argv.slice(2)));');
    writeFileSync(profile, `$ErrorActionPreference='Stop'\n` +
      `function Invoke-Checked { param([string]$Executable,[Parameter(ValueFromRemainingArguments=$true)][string[]]$Arguments)\n` +
      `& $Executable @Arguments\nif($LASTEXITCODE -ne 0){throw 'Child failed'}\n}\n` +
      `Invoke-Checked '${process.execPath}' '${child}' -- 'synthetic command' check:integration --runTestsByPath 'case.test.ts'\n` +
      `Invoke-Checked '${process.execPath}' '${child}' '--' 'synthetic command' check:integration --runTestsByPath 'case.test.ts'\n`);
    const output = await command('pwsh', ['-NoProfile', '-NonInteractive', '-File', profile],
      root, 30000, minimalEnvironment());
    const [before, after] = output.stdout.trim().split(/\r?\n/).map(JSON.parse);
    assert.equal(before[0], 'synthetic command');
    assert.equal(after[0], '--');
    assert.deepEqual(after.slice(1), before);
  });

function fixture() {
  return {
    targeted: { success: true, numTotalTests: 1, numPassedTests: 1,
      testResults: [{ assertionResults: [{ title: 'case', status: 'passed', invocations: 1, numPassingAsserts: 26 }] }] },
    native: { result: 'harness_failure', command: [], harnessFailureCount: 1,
      harnessFailures: [{ stage: 'missing_command' }], durationMs: 0, exitCode: 1,
      jestResultSource: 'pending', failedTestCaseCount: 0, failedTestSuiteCount: 0 },
    artifact: { status: 'failed', revision: 'revision',
      output: { exitCode: 1, stderr: 'Missing required integration command.' },
      telemetry: { validationRevision: 'revision', successorNative: { initiallyAbsent: true, revision: 'revision' } } }
  };
}
test('native wrapper continuation accepts only the exact first-leg pass and pre-command refusal', () => {
  const f = fixture();
  verifyNativeWrapperFailure(f.targeted, f.native, f.artifact, 'revision', 'case');
});
for (const [name, mutate] of [
  ['failed first leg', f => { f.targeted.success = false; }],
  ['different assertion population', f => { f.targeted.testResults[0].assertionResults[0].numPassingAsserts = 4; }],
  ['repeat case', f => { f.targeted.testResults[0].assertionResults[0].invocations = 2; }],
  ['wrong case', f => { f.targeted.testResults[0].assertionResults[0].title = 'other'; }],
  ['second command ran', f => { f.native.command.push('node'); }],
  ['other native error', f => { f.native.harnessFailures[0].stage = 'command_spawn'; }],
  ['native case failure', f => { f.native.failedTestCaseCount = 1; }],
  ['native case output', f => { f.native.jestResultSource = 'json'; }],
  ['native positive duration', f => { f.native.durationMs = 1; }],
  ['different revision', f => { f.artifact.revision = 'other'; }],
  ['warmed native cache', f => { f.artifact.telemetry.successorNative.initiallyAbsent = false; }]
]) test(`native wrapper continuation rejects ${name}`, () => {
  const f = fixture(); mutate(f);
  assert.throws(() => verifyNativeWrapperFailure(f.targeted, f.native, f.artifact, 'revision', 'case'));
});
