import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash, json } from '../src/common.js';
import { awaitOwnerReview, ownerReviewTimeoutMs, verifyOwnerReviewRecovery } from '../src/owner-review.js';
import { declarativeRegistrationFiles } from '../src/declarative-e2e.js';

for (const mode of ['approved', 'publication-template', 'oversized-publication',
  'wrong-snapshot', 'source-drift', 'timeout', 'inside-worker', 'extended-window',
  'default-window', 'unbounded-window']) {
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
      ['test.yaml'], mode === 'timeout' ? 1 :
        mode === 'extended-window' ? 300001 :
        mode === 'default-window' ? undefined :
        mode === 'unbounded-window' ? ownerReviewTimeoutMs + 1 : 1000);
    if (!['timeout', 'inside-worker', 'unbounded-window'].includes(mode)) {
      const request = readFileSync(join(directory, 'attempt-0.request.json'));
      writeFileSync(join(directory, 'attempt-0.approval.json'), json({
        format: 'repository-owner-review-v1', requestSha256: mode === 'wrong-snapshot' ? 'f'.repeat(64) : hash(request),
        status: 'approved', reviewedBy: 'security-review-agent', findings: [],
        ...(mode === 'publication-template' ? { publicationDescription: 'Synthetic reviewed template' } : {}),
        ...(mode === 'oversized-publication' ? { publicationDescription: 'x'.repeat(3001) } : {})
      }));
      if (mode === 'source-drift') writeFileSync(join(workspace, 'test.yaml'), 'Changed\n');
    }
    if (['approved', 'publication-template', 'extended-window', 'default-window'].includes(mode)) {
      assert.equal(await pending, mode === 'publication-template' ? 'Synthetic reviewed template' : null);
      assert.equal(operations.at(-1)[1], 'approved');
      await assert.rejects(awaitOwnerReview(ledger, job, 0, directory, ['test.yaml'], 1),
        /already exists/);
    } else await assert.rejects(pending);
  });
}

for (const condition of ['valid', 'proof-drift', 'result-drift', 'source-drift', 'metadata-drift',
  'missing-registration', 'artifact-drift', 'late-approval', 'incomplete-checks', 'failed-check',
  'log-drift', 'wrong-request', 'wrong-publication']) {
  test(`owner timeout proposal reuse ${condition}`, t => {
    const root = mkdtempSync(join(tmpdir(), 'owner-recovery-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const workspace = join(root, 'workspace'), directory = join(root, 'reviews');
    mkdirSync(workspace);
    mkdirSync(directory);
    const assignment = { id: 'synthetic-assignment' };
    const job = { id: assignment.id, session_id: 'synthetic-attempt', workspace,
      base_revision: 'a'.repeat(40) };
    const authored = ['test/first.yaml', 'test/second.yaml', 'test/third.yaml'];
    const fileSha256 = {};
    for (const file of [...authored, ...declarativeRegistrationFiles]) {
      mkdirSync(dirname(join(workspace, file)), { recursive: true });
      writeFileSync(join(workspace, file), 'Synthetic source\n');
      fileSha256[file] = hash(readFileSync(join(workspace, file)));
    }
    const artifactRef = join(root, 'registration.json');
    writeFileSync(artifactRef, json({ synthetic: true }));
    const result = { findings: 'Synthetic retained proposal', reportedAt: '2026-10-19T01:00:01Z',
      skillExecution: { changedFiles: authored, registration: {
        format: '1js-declarative-registration-v1', assignmentId: assignment.id,
        baseRevision: job.base_revision, changedFiles: [...declarativeRegistrationFiles],
        fileSha256: Object.fromEntries(declarativeRegistrationFiles.map(file => [file, fileSha256[file]])),
        artifactRef
      } } };
    const requestPath = join(directory, `${job.session_id}-0.request.json`);
    writeFileSync(requestPath, json({
      format: 'repository-owner-review-request-v1', assignmentId: assignment.id,
      attemptId: job.session_id, round: 0, workspace, baseRevision: job.base_revision,
      requestedAt: '2026-10-19T01:00:00Z', fileSha256,
      publication: { title: 'Synthetic title', description: 'Synthetic description' }
    }));
    const checksPath = join(root, 'checks.json'), stageLogSha256 = {};
    const checks = {
      format: 'repository-owner-precommit-checks-v1', requestPath,
      requestSha256: hash(readFileSync(requestPath)),
      stages: ['build', 'unit', 'prettier', 'lint'].map(stage => {
        const log = join(root, `${stage}.log`);
        writeFileSync(log, `Synthetic ${stage} passed\n`);
        stageLogSha256[stage] = hash(readFileSync(log));
        return { stage, exitCode: 0, log, startedAt: '2026-10-19T01:00:00Z',
          finishedAt: '2026-10-19T01:00:01Z' };
      })
    };
    if (condition === 'incomplete-checks') checks.stages.pop();
    if (condition === 'failed-check') checks.stages[0].exitCode = 1;
    if (condition === 'wrong-request') checks.requestSha256 = 'f'.repeat(64);
    writeFileSync(checksPath, json(checks));
    const path = join(root, 'recovery.json'), review = {
      format: 'owner-review-timeout-recovery-v1', assignmentId: assignment.id,
      attemptId: job.session_id, sourceRevision: job.base_revision, productInvocations: 0,
      workerResultSha256: hash(json(result)), explanation: 'Synthetic owner timeout recovery',
      requestSha256: hash(readFileSync(requestPath)), fileSha256,
      registrationArtifactSha256: hash(readFileSync(artifactRef)),
      checks: { path: checksPath, sha256: hash(readFileSync(checksPath)) }, stageLogSha256
    };
    writeFileSync(path, json(review));
    const authorization = { ownerReviewRecovery: {
      path, sha256: hash(readFileSync(path)), ownerReviewDirectory: directory
    } };
    if (condition === 'proof-drift') writeFileSync(path, '{}');
    if (condition === 'result-drift') result.findings = 'Changed';
    if (condition === 'source-drift') writeFileSync(join(workspace, authored[0]), 'Changed');
    if (condition === 'metadata-drift')
      result.skillExecution.registration.fileSha256[declarativeRegistrationFiles[0]] = 'f'.repeat(64);
    if (condition === 'missing-registration') delete result.skillExecution.registration;
    if (condition === 'artifact-drift') writeFileSync(artifactRef, '{}');
    if (condition === 'late-approval')
      writeFileSync(join(directory, `${job.session_id}-0.approval.json`), '{}');
    if (condition === 'log-drift') writeFileSync(checks.stages[0].log, 'Changed');
    if (condition === 'wrong-publication') {
      const request = JSON.parse(readFileSync(requestPath, 'utf8'));
      request.publication.title = 'Changed title';
      writeFileSync(requestPath, json(request));
    }
    if (condition === 'valid') {
      const recovered = verifyOwnerReviewRecovery(authorization, assignment, job, result);
      assert.equal(recovered.proposal.title, 'Synthetic title');
      assert.equal(recovered.proposal.outcome, 'propose-change');
      assert.deepEqual(recovered.proposal.skillExecution, result.skillExecution);
    } else assert.throws(() => verifyOwnerReviewRecovery(authorization, assignment, job, result));
  });
}
