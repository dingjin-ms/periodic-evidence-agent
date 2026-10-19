import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash, json } from '../src/common.js';
import { awaitOwnerReview } from '../src/owner-review.js';

for (const mode of ['approved', 'wrong-snapshot', 'source-drift', 'timeout', 'inside-worker']) {
  test(`pre-commit owner approval ${mode}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'owner-review-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const workspace = join(root, 'workspace'), directory = join(root, 'reviews');
    mkdirSync(workspace);
    writeFileSync(join(workspace, 'test.yaml'), 'Synthetic source\n');
    const job = { id: 'synthetic', session_id: 'attempt', workspace, base_revision: 'a'.repeat(40) };
    const operations = [];
    const ledger = {
      operation: (...args) => operations.push(args),
      finishOperation: (...args) => operations.push(args)
    };
    const pending = awaitOwnerReview(ledger, job, 0,
      mode === 'inside-worker' ? join(workspace, 'reviews') : directory,
      ['test.yaml'], mode === 'timeout' ? 1 : 1000);
    if (!['timeout', 'inside-worker'].includes(mode)) {
      const request = readFileSync(join(directory, 'attempt-0.request.json'));
      writeFileSync(join(directory, 'attempt-0.approval.json'), json({
        format: 'repository-owner-review-v1', requestSha256: mode === 'wrong-snapshot' ? 'f'.repeat(64) : hash(request),
        status: 'approved', reviewedBy: 'security-review-agent', findings: []
      }));
      if (mode === 'source-drift') writeFileSync(join(workspace, 'test.yaml'), 'Changed\n');
    }
    if (mode === 'approved') {
      await pending;
      assert.equal(operations.at(-1)[1], 'approved');
      await assert.rejects(awaitOwnerReview(ledger, job, 0, directory, ['test.yaml'], 1),
        /already exists/);
    } else await assert.rejects(pending);
  });
}
