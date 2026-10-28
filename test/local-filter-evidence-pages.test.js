import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../src/common.js';
import { localFilterEvidencePage, inspectLocalFilterSourceReads } from '../src/local-filter.js';

function fixture(description = 'Original source details') {
  const evidence = { id: 'ev-one', fields: { description }, capture: { sha256: hash(description) } };
  const capture = { evidenceId: evidence.id, sha256: evidence.capture.sha256,
    representation: 'reconstructed-from-full-evidence', recipe: 'ado-fields-relations-v1' };
  const payload = { index: { entries: [{ evidenceId: evidence.id }] }, evidence: [evidence], captures: [capture] };
  return { batch: { analysisPayloadSha256: hash(JSON.stringify(payload)),
    payload: JSON.stringify({ payload: JSON.stringify(payload) }) }, evidence, capture };
}

test('paged FILTER delivers full original evidence and capture binding without truncation', () => {
  const { batch, evidence, capture } = fixture('Actual retained UTF-8 details: 中文 😀 '.repeat(4000));
  let offset = 0, content = '';
  const observations = [];
  do {
    const page = localFilterEvidencePage(batch, 0, offset);
    assert(Buffer.byteLength(page.response) <= 32768);
    const response = JSON.parse(page.response);
    assert.equal(hash(response.content), page.observation.sha256);
    content += response.content;
    observations.push(page.observation);
    offset = response.nextOffset;
  } while (offset !== null);
  assert.deepEqual(JSON.parse(content), { evidence, captures: [capture] });
  const [read] = inspectLocalFilterSourceReads(observations);
  assert.equal(read.complete, true);
  assert.equal(read.valid, true);
  assert.equal(read.sourceSha256, hash(content));
});

test('paged FILTER rejects unknown record indexes and invalid offsets', () => {
  const { batch } = fixture();
  for (const index of [-1, 1, 1.1, undefined]) {
    assert.throws(() => localFilterEvidencePage(batch, index), /outside this exact batch/);
  }
  for (const offset of [-1, 100000, 1.5]) {
    assert.throws(() => localFilterEvidencePage(batch, 0, offset), /valid UTF-8 boundary/);
  }
});

test('paged FILTER cannot claim complete delivery from tail-only or missing pages', () => {
  const { batch } = fixture('original '.repeat(12000));
  const first = localFilterEvidencePage(batch, 0);
  const next = localFilterEvidencePage(batch, 0, first.observation.nextOffset);
  assert.equal(inspectLocalFilterSourceReads([next.observation])[0].complete, false);
  assert.equal(inspectLocalFilterSourceReads([first.observation])[0].complete, false);
});
