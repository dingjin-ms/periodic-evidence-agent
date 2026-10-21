import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash, json } from '../src/common.js';
import { verifyNativeUnitFailure, verifySourceRepairApproval,
  verifyNativeSourceSnapshot, verifyNativeSourceAuthority } from '../src/native-source-continuation.js';
import { dispatch, dispatchLocalValidationContinuation,
  dispatchNativeSourceContinuation } from '../src/workers.js';

const unitFile = 'ooui/apps/excel-agent-declarative-e2e/declarative/src/tests/example.unit.ts';
function failureFixture() {
  const job = { id: 'source-assignment', session_id: 'failed-attempt', state: 'blocked',
    workspace: 'synthetic-workspace', base_revision: 'a'.repeat(40) };
  const validation = { gateId: 'native-gate', status: 'blocked',
    blockedReason: 'validation-profile-error', attemptCount: 1,
    artifactRefs: ['failure.json'], sourceRevision: 'b'.repeat(40) };
  const result = { id: 'failed-result', assignmentId: job.id, attemptId: job.session_id,
    outcome: 'blocked', sourceRevision: validation.sourceRevision, draftPR: null,
    remoteValidation: [], reportedAt: '2026-01-01T00:00:00Z',
    toolUsage: { used: 0, rounds: [], byTool: { pilot_write: 0 } },
    skillExecution: { status: 'succeeded', needsHumanDecision: false,
      changedFiles: ['scenario.yaml'] },
    validation: [validation], validationAttempts: [{ round: 0, validation: [validation] }] };
  const operations = [{ kind: 'validation', state: 'blocked' }];
  const failure = { status: 'blocked', blockedReason: validation.blockedReason,
    revision: result.sourceRevision, gateId: validation.gateId, attempt: 0,
    profileSha256: 'c'.repeat(64), output: { exitCode: 1, timeout: false, stdout: '',
      stderr: '\u001b[1A\u001b[2K  1 failed\n    declarative\\src\\tests\\example.unit.ts:42:5 > stopped response\n  3 skipped\n  363 passed\n' } };
  return { job, result, operations, failure };
}
test('admits only the sealed single-unit zero-model failure and extracts its exact file', () => {
  const { job, result, operations, failure } = failureFixture();
  assert.equal(verifyNativeUnitFailure(job, result, operations, failure, failure.profileSha256), unitFile);
  for (const mutate of [
    f => { f.result.draftPR = { isDraft: true }; },
    f => { f.result.toolUsage.rounds.push({ round: 0 }); },
    f => { f.operations.push({ kind: 'push', state: 'completed' }); },
    f => { f.failure.output.exitCode = null; },
    f => { f.failure.output.nativeReceipt = {}; },
    f => { f.failure.output.stderr = '  2 failed\n    declarative/src/tests/example.unit.ts:42:5'; },
    f => { f.failure.output.stderr = '  1 failed\n    declarative/src/../playwrightAdapter.unit.ts:42:5'; }
  ]) {
    const fixture = failureFixture();
    mutate(fixture);
    assert.throws(() => verifyNativeUnitFailure(fixture.job, fixture.result,
      fixture.operations, fixture.failure, failure.profileSha256),
    error => error.code === 'blocked-reconciliation');
  }
});
test('source correction cannot enter through ordinary dispatch or the preparation continuation permit', async () => {
  const detail = { nativeSourceCorrection: true, nextAttemptId: 'next-attempt',
    authorization: { nextConfigSha256: 'invalid-config' } };
  const ledger = {
    job: () => ({ id: 'next-assignment', state: 'prepared', session_id: 'next-attempt' }),
    workspaceCleanup: () => null,
    get: () => ({}),
    status: () => ({ operations: [{ job_id: 'next-assignment',
      kind: 'continued-from-validation-failure', state: 'prepared', detail: json(detail) }] })
  };
  const config = { activation: { dispatch: true } };
  await assert.rejects(dispatch(config, ledger, 'next-assignment'), /explicit recorded dispatch entrypoint/);
  await assert.rejects(dispatchLocalValidationContinuation(config, ledger, 'next-assignment'),
    /explicit recorded dispatch entrypoint/);
  await assert.rejects(dispatchNativeSourceContinuation(config, ledger, 'next-assignment'),
    /controller\/config\/attempt changed/);
});

function reviewFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'native-source-review-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const fixture = failureFixture();
  const pin = (name, value) => {
    const path = join(directory, name);
    writeFileSync(path, json(value));
    return { path, sha256: hash(json(value)) };
  };
  const files = [{ path: 'scenario.yaml', sha256: hash('scenario\n') },
    { path: unitFile, sha256: hash('synchronized fixture\n') }];
  const request = { format: 'repository-owner-review-request-v1',
    assignmentId: fixture.job.id, attemptId: 'fresh-source-review', round: 0,
    workspace: fixture.job.workspace, baseRevision: fixture.job.base_revision,
    requestedAt: '2026-01-02T00:00:00Z',
    fileSha256: Object.fromEntries(files.map(file => [file.path, file.sha256])),
    publication: { title: 'Preserved candidate', description: 'Preserved description' } };
  const requestRef = pin('request.json', request);
  const approval = { format: 'repository-owner-review-v1', requestSha256: requestRef.sha256,
    status: 'approved', reviewedBy: 'security-review-agent', findings: [] };
  const approvalRef = pin('approval.json', approval);
  const authorization = { kind: 'native-unit-source-repair', approved: true,
    authorizedBy: 'user', maxInitialModelAttempts: 0,
    previousAssignmentId: fixture.job.id, previousAttemptId: fixture.job.session_id,
    sourceRevision: fixture.result.sourceRevision, baseRevision: fixture.job.base_revision,
    repairedRevision: 'd'.repeat(40), unitFile, reviewAttemptId: request.attemptId,
    ownerRequest: requestRef, ownerApproval: approvalRef, failure: pin('failure.json', fixture.failure) };
  fixture.result.validation[0].artifactRefs = [authorization.failure.path];
  const previousConfig = { stateDirectory: join(directory, 'previous'),
    limits: { maxValidationRepairRounds: 10, maxValidationInfrastructureRetries: 0 },
    repositories: [{ id: 'synthetic', validationGates: [{ profile: '1js-declarative-e2e-v1',
      profileSha256: fixture.failure.profileSha256 }] }] };
  const config = { ...previousConfig, stateDirectory: join(directory, 'next') };
  authorization.nextConfigSha256 = hash(json(config));
  const detail = { nativeSourceCorrection: true, priorJob: fixture.job,
    priorResult: fixture.result, priorAssignment: { repoId: 'synthetic' },
    priorResultSha256: hash(json(fixture.result)), operations: fixture.operations,
    priorOperationsSha256: hash(json(fixture.operations)), previousConfig,
    priorStateDirectory: previousConfig.stateDirectory,
    authorization, authorizationSha256: hash(json(authorization)), files,
    proposal: { ...request.publication } };
  return { directory, pin, request, approval, detail, config };
}
test('owner review binds every original and repaired byte and rejects stale or partial reviews', t => {
  const f = reviewFixture(t);
  assert.doesNotThrow(() => verifySourceRepairApproval(f.detail));
  for (const mutate of [
    d => { d.files[1].sha256 = 'e'.repeat(64); },
    d => { d.files.pop(); },
    d => { d.authorization.reviewAttemptId = 'old-review'; },
    d => { d.proposal.description = 'Changed publication'; },
    d => { d.priorResult.reportedAt = '2026-01-03T00:00:00Z'; }
  ]) {
    const detail = structuredClone(f.detail);
    mutate(detail);
    assert.throws(() => verifySourceRepairApproval(detail), error => error.code === 'blocked-owner');
  }
  f.approval.findings.push({ message: 'Unresolved finding' });
  f.detail.authorization.ownerApproval = f.pin('rejected.json', f.approval);
  assert.throws(() => verifySourceRepairApproval(f.detail), error => error.code === 'blocked-owner');
});
test('source authority preserves configuration, original scope, retry limits and predecessor', t => {
  const { config, detail } = reviewFixture(t);
  assert.doesNotThrow(() => verifyNativeSourceAuthority(config, detail));
  for (const mutate of [
    (c, d) => { c.limits.maxValidationInfrastructureRetries = 1; },
    (c, d) => { d.authorization.maxInitialModelAttempts = 1; },
    (c, d) => { d.nativeSourceCorrection = false; },
    (c, d) => { d.nativePreparationCorrection = true; },
    (c, d) => { d.previousConfig.stateDirectory = 'different-predecessor'; },
    (c, d) => { d.files.push({ path: 'playwrightAdapter.ts', sha256: 'f'.repeat(64) }); },
    (c, d) => { d.priorResult.sourceRevision = 'e'.repeat(40); },
    (c, d) => { d.operations.push({ kind: 'push', state: 'completed' }); }
  ]) {
    const c = structuredClone(config), d = structuredClone(detail);
    mutate(c, d);
    assert.throws(() => verifyNativeSourceAuthority(c, d));
  }
});
test('real Git snapshot requires a clean single child commit containing only the approved unit repair', async t => {
  const f = reviewFixture(t);
  const workspace = join(f.directory, 'workspace');
  mkdirSync(workspace);
  const git = args => execFileSync('git', ['-c', 'core.autocrlf=false',
    '-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.test',
    ...args], { cwd: workspace, encoding: 'utf8', windowsHide: true }).trim();
  git(['init', '--quiet']);
  writeFileSync(join(workspace, 'baseline.txt'), 'baseline\n');
  mkdirSync(join(workspace, unitFile, '..'), { recursive: true });
  writeFileSync(join(workspace, unitFile), 'original fixture\n');
  git(['add', '--all']); git(['commit', '--quiet', '-m', 'Baseline']);
  f.detail.priorJob.base_revision = git(['rev-parse', 'HEAD']);
  writeFileSync(join(workspace, 'scenario.yaml'), 'scenario\n');
  git(['add', '--all']); git(['commit', '--quiet', '-m', 'Preserved candidate']);
  f.detail.priorResult.sourceRevision = git(['rev-parse', 'HEAD']);
  writeFileSync(join(workspace, unitFile), 'synchronized fixture\n');
  git(['add', '--', unitFile]); git(['commit', '--quiet', '-m', 'Repair fixture']);
  f.detail.authorization.repairedRevision = git(['rev-parse', 'HEAD']);
  f.detail.priorJob.workspace = workspace;
  f.request.workspace = workspace;
  f.request.baseRevision = f.detail.priorJob.base_revision;
  f.detail.authorization.ownerRequest = f.pin('real-request.json', f.request);
  f.approval.requestSha256 = f.detail.authorization.ownerRequest.sha256;
  f.detail.authorization.ownerApproval = f.pin('real-approval.json', f.approval);
  await assert.doesNotReject(verifyNativeSourceSnapshot(f.detail));
  const artifact = join(workspace, 'untracked-diagnostic.png');
  writeFileSync(artifact, 'diagnostic\n');
  await assert.rejects(verifyNativeSourceSnapshot(f.detail), error => error.code === 'blocked-reconciliation');
  rmSync(artifact);
  writeFileSync(join(workspace, 'scenario.yaml'), 'changed candidate\n');
  await assert.rejects(verifyNativeSourceSnapshot(f.detail), error => error.code === 'blocked-reconciliation');
});
