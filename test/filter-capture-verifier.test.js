import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { captureVerificationProtocol, reconstructFilterCapture, verifyFilterCaptureInput,
  requiredFilterCaptureIds } from '../src/filter-capture-verifier.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const bytes = value => `${JSON.stringify(value, null, 2)}\n`;
const sha = value => hash(bytes(value));
function fixture(kind = 'ado') {
  const record = { id: 'synthetic-record', source: { kind, recordId: '42', revision: '3' },
    fields: { description: 'Full \u4e2d\u6587 \ud83d\ude80 body\nwith quotes " and backslash \\',
      message: { body: { content: '<p>\u00e9</p>' } }, parentContext: null }, links: [],
    capture: { sha256: '' } };
  const recipe = kind === 'ado' ? 'ado-fields-relations-v1' : 'workiq-message-parent-v1';
  const raw = reconstructFilterCapture(record, recipe);
  record.capture.sha256 = hash(raw);
  const entry = { evidenceId: record.id, recordSha256: sha(record), captureSha256: hash(raw) };
  const payload = { format: 'filter-batch-input-v1', cohortId: 'synthetic-cohort', batchId: 'synthetic-batch',
    index: { entries: [entry] }, indexSha256: '', contextCopies: [], evidence: [record],
    groups: [{ memberIds: [record.id], contextIds: [] }],
    captures: [{ representation: 'reconstructed-from-full-evidence', evidenceId: record.id,
      sha256: hash(raw), recipe, originalByteLength: raw.length }] };
  const source = { initialRevision: 'a'.repeat(40), finalRevision: 'a'.repeat(40), initialStatus: '', finalStatus: '' };
  const encode = () => {
    payload.indexSha256 = sha(payload.index);
    const inner = bytes(payload), prompt = bytes({ payloadSha256: hash(inner), payload: inner });
    return { format: captureVerificationProtocol, prompt, binding: { repoId: 'synthetic',
      targetRef: 'refs/heads/main', sourceRevision: source.initialRevision,
      verifierSha256: hash('synthetic-verifier'), payloadSha256: hash(prompt), analysisPayloadSha256: hash(inner) } };
  };
  const result = input => ({ format: 'filter-batch-result-v1', cohortId: payload.cohortId, batchId: payload.batchId,
    status: 'complete', payloadSha256: input.binding.analysisPayloadSha256,
    titles: { indexSha256: payload.indexSha256, decisions: [{ evidenceId: record.id,
      captureSha256: entry.captureSha256, disposition: 'needs-details' }] },
    details: [{ ...entry, status: 'reviewed' }] });
  return { record, raw, entry, payload, source, encode, result };
}
for (const kind of ['ado', 'workiq']) test(`verifier computes exact ${kind} compact UTF8 capture hash and byte length`, () => {
  const f = fixture(kind), receipt = verifyFilterCaptureInput(f.encode(), f.source);
  assert.deepEqual(receipt.captures, [{ evidenceId: f.record.id, captureSha256: hash(f.raw), byteLength: f.raw.length }]);
  assert.ok(f.raw.length > f.raw.toString().length);
  assert.equal(receipt.semanticReadingProven, false);
  assert.equal(Object.hasOwn(receipt, 'resultSha256'), false, 'Pre-analysis receipt must not claim a future result binding');
});

for (const [name, mutate, message] of [
  ['length mismatch', f => f.payload.captures[0].originalByteLength++, /byte length mismatch/],
  ['capture content mismatch', f => {
    f.record.fields.description = f.record.fields.description.replace('Full', 'Void');
    f.entry.recordSha256 = sha(f.record);
  }, /SHA256 mismatch/],
  ['record mismatch', f => { f.record.fields.description = 'changed'; }, /evidence is missing or changed/],
  ['missing capture', f => { f.payload.captures = []; }, /capture missing/],
  ['duplicate capture', f => { f.payload.captures.push(f.payload.captures[0]); }, /Duplicate captures/],
  ['foreign reconstruction ID', f => { f.payload.captures[0].evidenceId = 'foreign'; }, /evidence binding mismatch/],
  ['wrong recipe', f => { f.payload.captures[0].recipe = 'workiq-message-parent-v1'; }, /source mismatch/],
  ['dirty source', f => { f.source.initialStatus = ' M tracked.txt\n'; }, /unchanged clean bound source/],
  ['changed source', f => { f.source.finalRevision = 'b'.repeat(40); }, /unchanged clean bound source/]
]) test(`verifier fails closed for ${name}`, () => {
  const f = fixture(); mutate(f);
  assert.throws(() => verifyFilterCaptureInput(f.encode(), f.source), message);
});

test('inline captures use byte-exact base64 and SHA256 validation', () => {
  const f = fixture();
  f.payload.captures = [{ sha256: hash(f.raw), representation: 'inline-base64', contentBase64: f.raw.toString('base64') }];
  assert.equal(verifyFilterCaptureInput(f.encode(), f.source).captures[0].byteLength, f.raw.length);
  f.payload.captures[0].contentBase64 += '\n';
  assert.throws(() => verifyFilterCaptureInput(f.encode(), f.source), /Invalid capture base64/);
});

test('outer and inner exact byte bindings cannot be inferred or corrected', () => {
  const f = fixture(), input = f.encode();
  input.prompt += '\n';
  assert.throws(() => verifyFilterCaptureInput(input, f.source), /payload\/source binding mismatch/);
  input.binding.payloadSha256 = hash(input.prompt);
  input.binding.analysisPayloadSha256 = '0'.repeat(64);
  assert.throws(() => verifyFilterCaptureInput(input, f.source), /Inner hash binding mismatch/);
});

test('terminal result joins retained and required context IDs, while title exclusions do not attest reads', () => {
  const f = fixture();
  f.payload.groups[0].contextIds = ['context-only'];
  const input = f.encode(), r = f.result(input);
  assert.deepEqual(requiredFilterCaptureIds(input.prompt, bytes(r)).requiredIds, ['context-only', f.record.id]);
  r.titles.decisions[0].disposition = 'screen-out';
  assert.throws(() => requiredFilterCaptureIds(input.prompt, bytes(r)), /must not attest/);
  r.details[0].status = 'excluded-title';
  assert.deepEqual(requiredFilterCaptureIds(input.prompt, bytes(r)),
    { requiredIds: [], titleExcludedIds: [f.record.id] });
});

test('missing, duplicate and foreign terminal membership cannot obtain title exemptions', () => {
  const f = fixture(), input = f.encode();
  for (const mutate of [
    r => { r.details = []; },
    r => { r.details.push(r.details[0]); },
    r => { r.details[0].evidenceId = 'foreign'; },
    r => { r.titles.decisions[0].captureSha256 = '0'.repeat(64); }
  ]) {
    const r = f.result(input); mutate(r);
    assert.throws(() => requiredFilterCaptureIds(input.prompt, bytes(r)));
  }
});
