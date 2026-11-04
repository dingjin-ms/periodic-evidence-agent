import test from 'node:test';
import assert from 'node:assert/strict';
import { hash } from '../src/common.js';
import { requestSkillPayload, skillDeliveryReceipt } from '../src/skill-delivery.js';

const content = '# Canonical cross-app skill\nUse the ready harness.\n';
const revision = 'a'.repeat(40);
const binding = { skillPath: '.github/skills/author-declarative-e2e-test/SKILL.md' };
const qualification = { baseRevision: revision, skillPath: binding.skillPath, skillSha256: hash(content) };
test('qualified skill bytes are delivered with exact revision/hash', async () => {
  const payload = await requestSkillPayload({ limits: { maxFileBytes: 1000 } }, { referenceCheckout: 'fixture' }, binding,
    qualification, revision, async (_exe, args) => {
      assert.deepEqual(args, ['--no-pager', 'show', `${revision}:${binding.skillPath}`]);
      return { stdout: content };
    });
  const records = [];
  const ledger = { operation: (...args) => records.push(args), finishOperation: () => {} };
  const receipt = skillDeliveryReceipt(ledger, 'job', 'FILTER', 'session', payload);
  assert.equal(receipt.skillSha256, hash(content));
  assert.equal(receipt.bytes, Buffer.byteLength(content));
  assert.equal(records.length, 1);
});
for (const mode of ['missing', 'stale', 'bytes', 'oversized', 'external']) test(`skill delivery rejects ${mode}`, async () => {
  const q = mode === 'missing' ? undefined : { ...qualification, ...(mode === 'stale' ? { baseRevision: 'b'.repeat(40) } : {}) };
  await assert.rejects(requestSkillPayload({ limits: { maxFileBytes: mode === 'oversized' ? 1 : 1000 } }, {},
    { ...binding, ...(mode === 'external' ? { externalBundle: {} } : {}) }, q, revision,
    async () => ({ stdout: mode === 'bytes' ? 'changed' : content })));
});
