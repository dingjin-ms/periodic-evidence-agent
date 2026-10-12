import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../src/common.js';
import { inspectAgencyCaptureLog, inspectAgencySourceLog } from '../src/agency-executor.js';

function fixture() {
  const jobId = 'synthetic-job', executionId = '11111111-2222-4333-8444-555555555555';
  const pipeline = { buildId: '123', definitionId: '456', sourceRevision: 'a'.repeat(40) };
  const envelope = { format: 'agency-filter-capture-execution-v1', jobId, executionKind: 'pipeline-step', executionId,
    pipeline: { ...pipeline, bootstrapSha256: hash('synthetic-bootstrap'), stepName: 'AgencyTrustedExecutionGate' },
    verifierSha256: hash('synthetic-verifier'), inputSerialization: 'json-stringify-v1',
    inputEvidenceKind: 'source-bound-stdin-digest-v1',
    inputSha256: hash('synthetic-input'), stdinByteLength: 15, exitCode: 0, stdout: '{"synthetic":true}\n' };
  const observed = { jobId, pipeline, step: { executionId, stepName: 'AgencyTrustedExecutionGate',
    state: 'completed', result: 'succeeded', logId: '7' }, logText: '',
    evidenceRefs: [{ ref: `job-local:${jobId}:gate-log`, sha256: hash('synthetic-evidence') }] };
  const encode = () => {
    observed.logText = `2026-10-12T04:00:00.0000000Z AGENCY_FILTER_CAPTURE_RECEIPT_V1 ${JSON.stringify(envelope)}\n`;
    return observed;
  };
  return { envelope, observed, encode };
}

test('sanitized gate log preserves stdout and digest evidence without inventing literal stdin', () => {
  const f = fixture(), observed = f.encode(), execution = inspectAgencyCaptureLog(observed);
  assert.equal(execution.stdout, f.envelope.stdout);
  assert.equal(execution.inputEvidenceKind, 'source-bound-stdin-digest-v1');
  assert.equal(execution.stdinByteLength, 15);
  assert.equal(execution.inputSha256, f.envelope.inputSha256);
  assert.equal(Object.hasOwn(execution, 'stdin'), false);
  assert.deepEqual(execution.pipeline.log, { id: '7', sha256: hash(observed.logText) });
});

for (const [name, mutate] of [
  ['job', f => { f.envelope.jobId = 'foreign-job'; }],
  ['build', f => { f.envelope.pipeline.buildId = 'other-build'; }],
  ['definition', f => { f.envelope.pipeline.definitionId = 'other-definition'; }],
  ['source', f => { f.envelope.pipeline.sourceRevision = 'b'.repeat(40); }],
  ['task GUID', f => { f.envelope.executionId = '22222222-2222-4333-8444-555555555555'; }],
  ['task name', f => { f.envelope.pipeline.stepName = 'ModelAnalysis'; }],
  ['unfinished task', f => { f.observed.step.state = 'inProgress'; }],
  ['failed task', f => { f.observed.step.result = 'failed'; }],
  ['missing log ID', f => { f.observed.step.logId = ''; }],
  ['raw stdin export', f => { f.envelope.stdin = 'forbidden raw input'; }]
]) test(`sanitized gate log rejects ${name} mismatch`, () => {
  const f = fixture(); mutate(f);
  assert.throws(() => inspectAgencyCaptureLog(f.encode()),
    /does not match|Invalid Agency derived contract|Invalid inspected/);
});

test('ADO numeric pipeline and log IDs normalize losslessly without changing raw log bytes', () => {
  const f = fixture();
  f.envelope.pipeline.buildId = 123;
  f.envelope.pipeline.definitionId = 456;
  f.observed.step.logId = 7;
  const observed = f.encode(), execution = inspectAgencyCaptureLog(observed);
  assert.equal(execution.pipeline.buildId, '123');
  assert.equal(execution.pipeline.definitionId, '456');
  assert.deepEqual(execution.pipeline.log, { id: '7', sha256: hash(observed.logText) });
  for (const value of [0, -1, 1.5, Number.MAX_SAFE_INTEGER + 1, null]) {
    assert.throws(() => inspectAgencyCaptureLog({
      ...observed, pipeline: { ...observed.pipeline, buildId: value }
    }), /Invalid inspected/);
  }
});

test('sanitized gate log rejects missing, duplicate and malformed envelopes', () => {
  const f = fixture(), observed = f.encode(), original = observed.logText;
  for (const logText of ['', original + original, original.replace('Z AGENCY_', 'Z untrusted AGENCY_')]) {
    assert.throws(() => inspectAgencyCaptureLog({ ...observed, logText }), /exactly one|Malformed/);
  }
});

test('sanitized gate log enforces exact 1 MiB UTF8 inspection bound', () => {
  const f = fixture(), observed = f.encode();
  const logText = `${'x'.repeat(1024 * 1024 - Buffer.byteLength(observed.logText) - 1)}\n${observed.logText}`;
  assert.equal(Buffer.byteLength(logText), 1024 * 1024);
  assert.equal(inspectAgencyCaptureLog({ ...observed, logText }).jobId, observed.jobId);
  assert.throws(() => inspectAgencyCaptureLog({ ...observed, logText: logText + 'x' }), /exceeds the 1 MiB/);
});

test('post-analysis source log uses a separate exact envelope without prompt or publication claims', () => {
  const f = fixture();
  const envelope = { format: 'agency-filter-source-execution-v1', jobId: f.envelope.jobId,
    executionKind: 'pipeline-step', executionId: f.envelope.executionId,
    pipeline: { ...f.envelope.pipeline, stepName: 'AgencyFilterSourceAttestation' },
    source: { repoId: 'synthetic', targetRef: 'refs/heads/main', revision: 'a'.repeat(40), status: '' } };
  const observed = { ...f.observed,
    step: { ...f.observed.step, stepName: 'AgencyFilterSourceAttestation' },
    logText: `AGENCY_FILTER_SOURCE_RECEIPT_V1 ${JSON.stringify(envelope)}\n` };
  assert.deepEqual(inspectAgencySourceLog(observed).source, envelope.source);
  assert.equal(Object.hasOwn(inspectAgencySourceLog(observed), 'publication'), false);
  assert.throws(() => inspectAgencySourceLog({ ...observed,
    step: { ...observed.step, stepName: 'AgencyTrustedExecutionGate' } }), /does not match/);
  assert.throws(() => inspectAgencySourceLog({ ...observed,
    logText: `AGENCY_FILTER_SOURCE_RECEIPT_V1 ${JSON.stringify({ ...envelope, prompt: 'not permitted' })}\n` }),
  /Invalid Agency derived contract/);
});
