import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractReviewReceipt, publishReviewReceipt, renderReviewReceipt, verifyReviewReceipt
} from '../src/pr-review-receipt.js';

const head = '1'.repeat(40);
const base = '2'.repeat(40);
const receipt = {
  schemaVersion: 1,
  reviewedHead: head,
  reviewedBase: base,
  reviewedAt: '2026-10-12T12:00:00.000Z',
  reviewer: 'copilot-session:test',
  outcome: 'no-blocking-findings',
  findings: [],
  validation: [{ name: 'npm test', state: 'passed', details: '100 tests passed' }],
  residualRisks: ['Required branch protection is configured outside this repository.']
};
const pr = (comments = [], author = 'owner') => ({
  number: 7,
  url: 'https://github.example/owner/repo/pull/7',
  state: 'OPEN',
  isDraft: true,
  author: { login: author },
  headRefOid: head,
  baseRefOid: base,
  comments
});

test('renders and extracts the machine-readable review receipt', () => {
  const body = renderReviewReceipt(receipt, { repository: 'owner/repo', number: 7 });
  assert.deepEqual(extractReviewReceipt(body), receipt);
  assert.match(body, /Any push, base update, or conflict resolution requires a new review/);
});

test('publishes an own-PR receipt and rechecks revisions after commenting', async () => {
  const calls = [];
  const result = await publishReviewReceipt({
    repository: 'owner/repo',
    number: 7,
    receipt,
    runGh: async args => {
      calls.push(args);
      if (args[0] === 'api' && args[1] === 'user') return { login: 'owner' };
      if (args[0] === 'api') return {};
      return pr();
    }
  });
  assert.equal(result.state, 'published');
  assert.equal(calls.filter(args => args[0] === 'pr' && args[1] === 'view').length, 2);
  const comment = calls.find(args => args[0] === 'api' && args[1].endsWith('/comments'));
  assert.equal(comment[2], '--method');
  assert.equal(comment[3], 'POST');
  assert.match(comment.at(-1), /Reviewed head/);
});

test('requires explicit approval before commenting on another author PR', async () => {
  await assert.rejects(() => publishReviewReceipt({
    repository: 'owner/repo',
    number: 7,
    receipt,
    runGh: async args => args[0] === 'api' ? { login: 'reviewer' } : pr([], 'owner')
  }), error => error.code === 'approval-required');
});

test('rejects a stale receipt before publishing', async () => {
  await assert.rejects(() => publishReviewReceipt({
    repository: 'owner/repo',
    number: 7,
    receipt: { ...receipt, reviewedHead: '3'.repeat(40) },
    runGh: async args => args[0] === 'api' ? { login: 'owner' } : pr()
  }), error => error.code === 'stale-review-receipt');
});

test('verifies only a receipt bound to the current head and base', async () => {
  const stale = renderReviewReceipt({ ...receipt, reviewedHead: '3'.repeat(40) },
    { repository: 'owner/repo', number: 7 });
  const current = renderReviewReceipt(receipt, { repository: 'owner/repo', number: 7 });
  const result = await verifyReviewReceipt({
    repository: 'owner/repo',
    number: 7,
    runGh: async () => pr([
      { body: stale, createdAt: '2026-10-12T12:00:00Z', author: { login: 'owner' } },
      { body: current, createdAt: '2026-10-12T12:01:00Z', author: { login: 'owner' } }
    ])
  });
  assert.equal(result.state, 'review-receipt-verified');
  assert.equal(result.reviewedHead, head);
});

test('blocks verification after the PR head changes', async () => {
  const body = renderReviewReceipt(receipt, { repository: 'owner/repo', number: 7 });
  await assert.rejects(() => verifyReviewReceipt({
    repository: 'owner/repo',
    number: 7,
    runGh: async () => ({ ...pr([{ body }]), headRefOid: '4'.repeat(40) })
  }), error => error.code === 'stale-review-receipt');
});

test('blocks receipts with incomplete validation', async () => {
  const body = renderReviewReceipt({
    ...receipt,
    validation: [{ name: 'npm test', state: 'not-run' }]
  }, { repository: 'owner/repo', number: 7 });
  await assert.rejects(() => verifyReviewReceipt({
    repository: 'owner/repo',
    number: 7,
    runGh: async () => pr([{ body }])
  }), error => error.code === 'blocking-review-validation');
});
