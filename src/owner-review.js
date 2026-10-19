import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { hash, json, now, requireThat } from './common.js';

export async function awaitOwnerReview(ledger, job, round, directory, files, timeoutMs = 300000) {
  requireThat(isAbsolute(directory) && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 300000,
    'Owner review needs an explicit directory and bounded timeout', 'blocked-owner');
  mkdirSync(directory, { recursive: true });
  const part = relative(realpathSync(job.workspace), realpathSync(directory));
  requireThat(part && (part.startsWith('..') || isAbsolute(part)),
    'Owner approval must be outside the restricted worker workspace', 'blocked-owner');
  const prefix = join(directory, `${job.session_id}-${round}`);
  const requestPath = `${prefix}.request.json`, approvalPath = `${prefix}.approval.json`;
  const fileSha256 = Object.fromEntries(files.map(file =>
    [file, hash(readFileSync(join(job.workspace, file)))]));
  const request = {
    format: 'repository-owner-review-request-v1', assignmentId: job.id,
    attemptId: job.session_id, round, workspace: job.workspace,
    baseRevision: job.base_revision, fileSha256, requestedAt: now()
  };
  const bytes = json(request), id = `${job.id}:owner-review:${round}`;
  requireThat(!existsSync(requestPath) && !existsSync(approvalPath),
    'Owner review already exists; reconcile instead of replaying', 'blocked-reconciliation');
  ledger.operation(id, job.id, 'owner-review', { requestPath, requestSha256: hash(bytes) });
  writeFileSync(requestPath, bytes, { flag: 'wx', mode: 0o600 });
  try {
    const deadline = Date.now() + timeoutMs;
    while (!existsSync(approvalPath) && Date.now() < deadline)
      await new Promise(resolve => setTimeout(resolve, 250));
    requireThat(existsSync(approvalPath), 'Owner review did not arrive before commit',
      'blocked-owner');
    const approval = JSON.parse(readFileSync(approvalPath, 'utf8'));
    requireThat(approval.format === 'repository-owner-review-v1' &&
      approval.requestSha256 === hash(bytes) && approval.status === 'approved' &&
      approval.reviewedBy === 'security-review-agent' &&
      Array.isArray(approval.findings) && approval.findings.length === 0,
    'Owner review did not approve this exact source snapshot', 'blocked-owner');
    for (const [file, digest] of Object.entries(fileSha256))
      requireThat(hash(readFileSync(join(job.workspace, file))) === digest,
        'Source changed after owner review was requested', 'blocked-reconciliation');
    ledger.finishOperation(id, 'approved', {
      requestPath, requestSha256: hash(bytes), approvalPath,
      approvalSha256: hash(readFileSync(approvalPath)), fileSha256
    });
  } catch (error) {
    ledger.finishOperation(id, 'blocked', { requestPath, code: error.code ?? 'failed' });
    throw error;
  }
}
