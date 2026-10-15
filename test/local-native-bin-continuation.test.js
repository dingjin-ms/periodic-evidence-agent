import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';
import { correctNativeWrapperToolEnvironment, verifyNativeBinProof, verifyNativeBinFailure,
  verifyNativeBinContinuation, nativeBinContinuationOperationId } from '../src/local-native-bin-continuation.js';

test('bin reservation cannot collide with incoming same-assignment continuation or be replayed', t => {
  const root = mkdtempSync(join(tmpdir(), 'native-bin-reservation-'));
  const ledger = new Ledger(root);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const incoming = 'assignment-same:validation-continuation';
  ledger.operation(incoming, 'assignment-same', 'continued-from-validation-failure', { prior: true });
  ledger.finishOperation(incoming, 'prepared', { prior: true });
  const outgoing = nativeBinContinuationOperationId('assignment-same');
  ledger.operation(outgoing, 'assignment-same', 'validation-continuation', { next: true });
  assert.throws(() => ledger.operation(outgoing, 'assignment-same', 'validation-continuation', {}),
    /Operation already started/);
  const original = ledger.status().operations.find(row => row.id === incoming);
  assert.equal(original.state, 'prepared');
  assert.deepEqual(JSON.parse(original.detail), { prior: true });
});

test('bin correction changes only the one native wrapper launcher, preserving separator and both legs', () => {
  const before = "Invoke-Checked node 'docs\\skills\\Integration-test-core\\scripts\\run-integration-tests.mjs' '--' ";
  const profile = `first-leg unchanged\r\n${before}\`\r\ncheck:integration unchanged\r\n`;
  assert.equal(correctNativeWrapperToolEnvironment(profile),
    profile.replace('Invoke-Checked node ', 'Invoke-Checked $corepack yarn node '));
  for (const value of ['', before + before, correctNativeWrapperToolEnvironment(profile)])
    assert.throws(() => correctNativeWrapperToolEnvironment(value), /exactly one plain Node/);
});
function proof() {
  return { kind: 'native-workspace-bin-resolution-proof', nativeCaseInvocations: 0, modelCalls: 0,
    network: false, timeoutMs: 30000, acceptanceEvidence: false, publicationEligible: false,
    yarn: { path: 'yarn.cjs' }, nativeWrapper: { path: 'wrapper.mjs' },
    before: { exitCode: 127, stderr: 'command not found: gulp', stdout: '',
      args: ['wrapper.mjs', '--', 'node', 'yarn.cjs', 'workspace', 'leaf', 'check:integration'] },
    after: { exitCode: 0, stdout: 'SYNTHETIC_GULP:["build"]\nSYNTHETIC_CHILD:{}',
      args: ['yarn.cjs', 'node', 'wrapper.mjs', '--', 'node', 'yarn.cjs', 'workspace', 'leaf', 'check:integration'] } };
}
test('bin proof requires actual synthetic child dispatch without native acceptance', () => {
  verifyNativeBinProof(proof());
  for (const mutate of [
    p => { p.nativeCaseInvocations = 1; }, p => { p.modelCalls = 1; },
    p => { p.network = true; }, p => { p.acceptanceEvidence = true; },
    p => { p.publicationEligible = true; }, p => { p.before.exitCode = 1; },
    p => { p.before.stdout = 'SYNTHETIC_GULP:'; }, p => { p.after.exitCode = 127; },
    p => { p.after.args.pop(); }, p => { p.after.stdout = 'configured only'; },
    p => { p.timeoutMs = 1800000; }
  ]) {
    const p = proof(); mutate(p);
    assert.throws(() => verifyNativeBinProof(p), /Exact offline/);
  }
});
function failure() {
  return {
    targeted: { success: true, numTotalTests: 1, numPassedTests: 1,
      testResults: [{ assertionResults: [{ title: 'case', status: 'passed', invocations: 1, numPassingAsserts: 26 }] }] },
    native: { result: 'failed', exitCode: 127, testScope: 'manual', jestResultSource: 'unavailable',
      failedTestCaseCount: 0, failedTestSuiteCount: 0, command: ['check:integration', '--runTestsByPath'] },
    artifact: { status: 'failed', revision: 'revision',
      output: { exitCode: 1, timeout: false, stderr: 'command not found: gulp' },
      telemetry: { validationRevision: 'revision', successorNative: { initiallyAbsent: true, revision: 'revision' } } }
  };
}
test('bin successor rejects test failures, timeouts, repeat cases and unbound evidence', () => {
  const f = failure(); verifyNativeBinFailure(f.targeted, f.native, f.artifact, 'revision', 'case');
  for (const mutate of [
    f => { f.targeted.success = false; }, f => { f.targeted.numTotalTests = 2; },
    f => { f.targeted.testResults[0].assertionResults[0].invocations = 2; },
    f => { f.targeted.testResults[0].assertionResults[0].numPassingAsserts = 4; },
    f => { f.native.jestResultSource = 'json'; }, f => { f.native.failedTestCaseCount = 1; },
    f => { f.native.exitCode = 1; }, f => { f.native.testScope = 'full'; },
    f => { f.artifact.output.timeout = true; },
    f => { f.artifact.telemetry.successorNative.initiallyAbsent = false; },
    f => { f.artifact.revision = 'other'; }
  ]) {
    const value = failure(); mutate(value);
    assert.throws(() => verifyNativeBinFailure(value.targeted, value.native, value.artifact,
      'revision', 'case'), /exact first-leg/);
  }
  assert.throws(() => verifyNativeBinContinuation({}, { authorization: { kind: 'native-workspace-bin-path',
    maxModelAttempts: 0 } }), /Missing zero-model/);
});
