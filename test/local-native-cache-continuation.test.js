import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyCompileCacheProof, verifyNativeCacheContinuation } from '../src/local-native-cache-continuation.js';

function proof() {
  return { kind: 'native-node-compile-cache-path-diagnosis', platform: 'win32', nodeVersion: 'v24.19.0',
    nativeCaseInvocations: 0, modelCalls: 0, acceptanceEvidence: false, publicationEligible: false,
    syntheticObservations: [
      { longTemporaryLength: 224, first: { killed: true, stdout: 'before-cache\n', stderr: '' } },
      { priorPassingTemporaryLength: 230, prior: { stdout: '{"status":0}' } },
      { temporaryPathLength: 91, cache: { status: 1 } }
    ] };
}
test('cache continuation requires the precise isolated threshold proof without granting acceptance', () => {
  verifyCompileCacheProof(proof());
  for (const mutate of [
    p => { p.modelCalls = 1; },
    p => { p.nativeCaseInvocations = 1; },
    p => { p.acceptanceEvidence = true; },
    p => { p.publicationEligible = true; },
    p => { p.nodeVersion = 'unclassified'; },
    p => { p.syntheticObservations[0].first.killed = false; },
    p => { p.syntheticObservations[1].prior.stdout = '{"status":1}'; },
    p => { p.syntheticObservations[2].cache.status = 3; },
    p => { p.syntheticObservations[2].temporaryPathLength = 224; }
  ]) {
    const value = proof(); mutate(value);
    assert.throws(() => verifyCompileCacheProof(value), /isolated exact Node threshold/);
  }
});
test('cache continuation cannot bypass its sealed diagnostic references', () => {
  assert.throws(() => verifyNativeCacheContinuation({ authorization: { kind: 'native-launcher-cache-path' } }),
    /Missing source-bound/);
  assert.throws(() => verifyNativeCacheContinuation({ authorization: { kind: 'native-launcher-cache-path' },
    nativeCacheCorrection: { diagnosis: {} } }), /evidence changed/);
});
