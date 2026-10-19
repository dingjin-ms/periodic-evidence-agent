import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { boundedPath, hash, json, now, requireThat } from './common.js';
import { declarativeRegistrationFiles, skillChangePopulation } from './declarative-e2e.js';

export const ownerReviewTimeoutMs = 1800000;

export function verifyOwnerReviewRecovery(authorization, assignment, job, result) {
  const reference = authorization?.ownerReviewRecovery;
  requireThat(isAbsolute(reference?.path ?? '') && /^[a-f0-9]{64}$/.test(reference?.sha256 ?? ''),
    'An immutable owner-timeout recovery review is required', 'blocked-reconciliation');
  const bytes = readFileSync(reference.path);
  requireThat(hash(bytes) === reference.sha256, 'Owner-timeout recovery review changed',
    'blocked-reconciliation');
  const review = JSON.parse(bytes), registration = result.skillExecution?.registration;
  requireThat(review.format === 'owner-review-timeout-recovery-v1' &&
    review.assignmentId === assignment.id && review.attemptId === job.session_id &&
    review.workerResultSha256 === hash(json(result)) && review.sourceRevision === job.base_revision &&
    review.productInvocations === 0 && typeof review.explanation === 'string' && review.explanation.trim() &&
    registration?.format === '1js-declarative-registration-v1' &&
    registration.assignmentId === assignment.id && registration.baseRevision === job.base_revision &&
    json([...registration.changedFiles].sort()) === json([...declarativeRegistrationFiles].sort()) &&
    isAbsolute(reference.ownerReviewDirectory ?? ''),
  'Owner recovery must retain a successful source-bound proposal and complete registration',
  'blocked-reconciliation');
  const requestPath = join(reference.ownerReviewDirectory, `${job.session_id}-0.request.json`);
  const requestBytes = readFileSync(requestPath), request = JSON.parse(requestBytes);
  requireThat(review.requestSha256 === hash(requestBytes) &&
    request.format === 'repository-owner-review-request-v1' &&
    request.assignmentId === assignment.id && request.attemptId === job.session_id &&
    request.round === 0 && request.workspace === job.workspace &&
    request.baseRevision === job.base_revision &&
    Date.parse(request.requestedAt) <= Date.parse(result.reportedAt) &&
    request.publication?.title && request.publication.description &&
    !existsSync(join(reference.ownerReviewDirectory, `${job.session_id}-0.approval.json`)) &&
    json(Object.keys(request.fileSha256).sort()) === json(skillChangePopulation(result.skillExecution)) &&
    json(review.fileSha256) === json(request.fileSha256) &&
    isAbsolute(review.checks?.path ?? '') &&
    hash(readFileSync(review.checks.path)) === review.checks.sha256,
  'Owner recovery request, publication text or checks differ from the timed-out snapshot',
  'blocked-reconciliation');
  const checks = JSON.parse(readFileSync(review.checks.path, 'utf8'));
  requireThat(checks.format === 'repository-owner-precommit-checks-v1' &&
    checks.requestPath === requestPath && checks.requestSha256 === review.requestSha256 &&
    json(checks.stages.map(stage => stage.stage)) === json(['build', 'unit', 'prettier', 'lint']) &&
    checks.stages.every(stage => stage.exitCode === 0 && isAbsolute(stage.log) &&
      hash(readFileSync(stage.log)) === review.stageLogSha256?.[stage.stage] &&
      Date.parse(stage.startedAt) >= Date.parse(request.requestedAt) &&
      Date.parse(stage.finishedAt) >= Date.parse(stage.startedAt)),
  'Owner recovery requires all four completed snapshot-bound precommit checks',
  'blocked-reconciliation');
  for (const [file, digest] of Object.entries(request.fileSha256))
    requireThat(hash(readFileSync(boundedPath(job.workspace, file))) === digest,
      'Retained owner-review source changed', 'blocked-reconciliation');
  for (const file of registration.changedFiles)
    requireThat(request.fileSha256[file] === registration.fileSha256[file],
      'Retained registration metadata changed', 'blocked-reconciliation');
  requireThat(hash(readFileSync(registration.artifactRef)) === review.registrationArtifactSha256,
    'Retained registration artifact changed', 'blocked-reconciliation');
  return { review, request, proposal: {
    outcome: 'propose-change', findings: result.findings,
    title: request.publication.title, description: request.publication.description,
    skillExecution: structuredClone(result.skillExecution)
  } };
}

export async function awaitOwnerReview(ledger, job, round, directory, files, timeoutMs = ownerReviewTimeoutMs,
  publication = null) {
  requireThat(isAbsolute(directory) && Number.isInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= ownerReviewTimeoutMs,
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
    baseRevision: job.base_revision, fileSha256, requestedAt: now(),
    ...(publication ? { publication } : {})
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
    requireThat(approval.publicationDescription === undefined ||
      (typeof approval.publicationDescription === 'string' &&
        approval.publicationDescription.trim() && approval.publicationDescription.length <= 3000),
    'Owner publication description must reserve space for source/build receipts', 'blocked-owner');
    for (const [file, digest] of Object.entries(fileSha256))
      requireThat(hash(readFileSync(join(job.workspace, file))) === digest,
        'Source changed after owner review was requested', 'blocked-reconciliation');
    ledger.finishOperation(id, 'approved', {
      requestPath, requestSha256: hash(bytes), approvalPath,
      approvalSha256: hash(readFileSync(approvalPath)), fileSha256
    });
    return approval.publicationDescription ?? null;
  } catch (error) {
    ledger.finishOperation(id, 'blocked', { requestPath, code: error.code ?? 'failed' });
    throw error;
  }
}
