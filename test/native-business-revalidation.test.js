import test from 'node:test';
import assert from 'node:assert/strict';
import { verifyNativeBusinessFailure, verifyNativeBusinessAuthority } from '../src/native-business-revalidation.js';
import { hash, json } from '../src/common.js';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dispatch, dispatchLocalValidationContinuation } from '../src/workers.js';

function fixture() {
  const job = { id: 'assignment', session_id: 'old-attempt', state: 'blocked' };
  const gate = { gateId: 'native', status: 'blocked', blockedReason: 'validation-profile-error',
    sourceRevision: 'a'.repeat(40), attemptCount: 1, artifactRefs: ['failure.json'] };
  const result = { assignmentId: job.id, attemptId: job.session_id, outcome: 'blocked',
    sourceRevision: gate.sourceRevision, draftPR: null, remoteValidation: [],
    toolUsage: { used: 0, rounds: [], byTool: { pilot_finish: 0 } },
    skillExecution: { status: 'succeeded', needsHumanDecision: false },
    validation: [gate], validationAttempts: [{ round: 0, validation: [gate] }] };
  const operations = [
    { kind: 'validation', state: 'blocked' },
    { kind: 'continued-from-validation-failure', state: 'prepared' },
    { kind: 'reuse-authored-revision', state: 'completed' },
    { kind: 'declarative-registration-continuation', state: 'completed' }
  ];
  const failure = { status: 'blocked', blockedReason: gate.blockedReason,
    revision: result.sourceRevision, gateId: gate.gateId, attempt: 0,
    profileSha256: 'b'.repeat(64), output: { exitCode: 1, timeout: false } };
  const summary = { status: 'failed', cases: [
    { status: 'passed', expectedStatus: 'passed', repeatEachIndex: 0, retry: 0 },
    { status: 'failed', expectedStatus: 'passed', repeatEachIndex: 1, retry: 0 }
  ] };
  return { job, result, operations, failure, summary };
}
const verify = f => verifyNativeBusinessFailure(f.job, f.result, f.operations,
  f.failure, f.summary, 'b'.repeat(64));

test('admits the failed native batch without treating earlier passes as new acceptance', () => {
  const f = fixture();
  assert.doesNotThrow(() => verify(f));
  assert.equal(f.summary.cases.length, 2);
});
test('rejects preparation failures, diagnostic passes, retries and publication', () => {
  for (const mutate of [
    f => { f.summary.cases = []; },
    f => { f.summary.status = 'passed'; },
    f => { f.summary.cases[1].retry = 1; },
    f => { f.summary.cases[1].repeatEachIndex = 3; },
    f => { f.result.remoteValidation = [{ id: 123 }]; },
    f => { f.result.draftPR = { isDraft: true }; },
    f => { f.result.toolUsage.used = 1; },
    f => { f.failure.output.exitCode = null; },
    f => { f.failure.output.timeout = true; },
    f => { f.failure.output.nativeReceipt = { passed: true }; },
    f => { f.operations.push({ kind: 'push', state: 'completed' }); },
    f => { f.failure.profileSha256 = 'c'.repeat(64); }
  ]) {
    const f = fixture(); mutate(f);
    assert.throws(() => verify(f), error => error.code === 'blocked-reconciliation');
  }
});
function authorityFixture(t) {
  const f = fixture(), directory = mkdtempSync(join(tmpdir(), 'business-revalidation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pin = (name, value) => {
    const path = join(directory, name); mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, json(value)); return { path, sha256: hash(json(value)) };
  };
  Object.assign(f.job, { workspace: join(directory, 'author'), base_revision: 'c'.repeat(40) });
  Object.assign(f.result, { id: 'failed-result', reportedAt: '2026-01-01T00:00:00Z' });
  f.result.skillExecution.registration = { caseIds: ['original-case'] };
  const previous = { stateDirectory: join(directory, 'prior'),
    limits: { maxValidationRepairRounds: 10, maxValidationInfrastructureRetries: 0 },
    repositories: [{ id: 'synthetic', validationGates: [
      { profile: '1js-declarative-e2e-v1', profileSha256: f.failure.profileSha256 }
    ] }] };
  const config = { ...previous, stateDirectory: join(directory, 'next') };
  const assignment = { id: f.job.id, repoId: 'synthetic', skillQualification: { qualifiedAt: 'fresh' } };
  const original = { sourcePreparedContinuation: { originalContinuation: {} },
    nextStateDirectory: previous.stateDirectory, nextAssignmentId: f.job.id,
    nextAttemptId: f.job.session_id, priorJob: f.job,
    priorAssignment: { ...assignment, skillQualification: { qualifiedAt: 'old' } },
    authorization: { repairedRevision: f.result.sourceRevision, unitFile: 'approved.unit.ts',
      ownerRequest: { path: 'preserved-request', sha256: 'd'.repeat(64) },
      ownerApproval: { path: 'preserved-approval', sha256: 'e'.repeat(64) } },
    files: [{ path: 'original-case.yaml', sha256: 'f'.repeat(64) }],
    proposal: { title: 'Original candidate', description: 'Original approved description' } };
  f.operations[0].id = 'validation-operation';
  f.operations[1].detail = json(original);
  const failure = pin('failure.json', f.failure);
  f.result.validation[0].artifactRefs = [failure.path];
  const nativeSummary = pin(join('prior', 'native-validation', hash(f.operations[0].id),
    'native-batch', 'summary.json'), f.summary);
  const workspace = join(directory, 'fresh-validation');
  const controllerFiles = ['src/workers.js', 'src/validation-workspace.js', 'src/native-command.js',
    'src/native-command.ps1', 'src/dependency-snapshot-copy.cjs', 'src/output-fingerprint.js',
    'src/output-fingerprint-worker.js', 'scripts/validation/preflight.mjs',
    'scripts/validation/native-preflight.cjs', 'src/native-preparation-continuation.js'];
  const proof = { format: 'validation-preflight-v1', status: 'passed',
    completedAt: '2026-01-02T00:00:00Z', assignmentId: f.job.id,
    priorAttemptId: f.job.session_id, priorResultId: f.result.id,
    sourceRevision: f.result.sourceRevision, baseRevision: f.job.base_revision,
    profileSha256: f.failure.profileSha256,
    originalLedgerSha256: hash(json({ job: f.job, result: f.result, assignment, operations: f.operations })),
    workspace, nativeCaseInvocations: 0, modelInvocations: 0, publicationInvocations: 0,
    acceptanceEvidence: false, publicationEligible: false,
    preparation: { strategy: 'detached-worktree', workspace, sourceRevision: f.result.sourceRevision,
      dependencySeed: { format: 'declarative-dependency-seed-v1',
        sourceRevision: f.result.sourceRevision, sha256: 'a'.repeat(64), paths: ['ooui/.store'] } },
    native: { caseIds: ['original-case'], nativeCaseInvocations: 0 },
    timings: ['native-load-typecheck-selection', 'post-native-clean']
      .map(id => ({ id, status: 'passed' })),
    controllerFiles: Object.fromEntries(controllerFiles.map(file =>
      [file, hash(readFileSync(new URL(`../${file}`, import.meta.url)))])) };
  const authorization = { ...original.authorization, kind: 'native-business-revalidation',
    approved: true, authorizedBy: 'user', scope: 'one-complete-native-batch',
    maxInitialModelAttempts: 0, maxNativeBatches: 1, requiredRepeats: 5,
    previousAssignmentId: f.job.id, previousAttemptId: f.job.session_id,
    sourceRevision: f.result.sourceRevision, baseRevision: f.job.base_revision,
    authorizedAt: '2026-01-02T00:00:00Z', recordedAt: '2026-01-02T00:00:01Z',
    reason: 'Explicit new complete-batch instruction', failure, nativeSummary,
    preflight: pin('preflight.json', proof), nextConfigSha256: hash(json(config)) };
  const detail = { previousConfig: previous, priorStateDirectory: previous.stateDirectory,
    priorJob: f.job, priorResult: f.result, priorAssignment: assignment,
    priorResultSha256: hash(json(f.result)), operations: f.operations,
    priorOperationsSha256: hash(json(f.operations)), authorization,
    authorizationSha256: hash(json(authorization)), nativeSourceCorrection: true,
    nativeBusinessRevalidation: { originalContinuation: original },
    files: original.files, proposal: original.proposal };
  return { config, detail, pin, proof };
}
test('fresh business authority preserves source, scope, single-batch bounds and exact predecessor', t => {
  const f = authorityFixture(t);
  assert.doesNotThrow(() => verifyNativeBusinessAuthority(f.config, f.detail));
  for (const mutate of [
    (c, d) => { d.authorization.requiredRepeats = 4; },
    (c, d) => { d.authorization.maxNativeBatches = 2; },
    (c, d) => { d.authorization.maxInitialModelAttempts = 1; },
    (c, d) => { d.authorization.authorizedAt = '2025-12-31T00:00:00Z'; },
    (c, d) => { d.authorization.repairedRevision = 'f'.repeat(40); },
    (c, d) => { d.files = []; },
    (c, d) => { d.proposal = { title: 'Changed candidate' }; },
    (c, d) => { d.authorization.ownerApproval = null; },
    (c, d) => { d.nativeBusinessRevalidation.originalContinuation.nativeBusinessRevalidation = {}; },
    (c, d) => { c.limits.maxValidationInfrastructureRetries = 1; },
    (c, d) => { d.priorResult.id = 'different-sealed-result'; }
  ]) {
    const config = structuredClone(f.config), detail = structuredClone(f.detail);
    mutate(config, detail); detail.authorizationSha256 = hash(json(detail.authorization));
    assert.throws(() => verifyNativeBusinessAuthority(config, detail));
  }
  const detail = structuredClone(f.detail), proof = structuredClone(f.proof);
  proof.nativeCaseInvocations = 1;
  detail.authorization.preflight = f.pin('invalid-preflight.json', proof);
  detail.authorizationSha256 = hash(json(detail.authorization));
  assert.throws(() => verifyNativeBusinessAuthority(f.config, detail), /real preparation acceptance/);
});
test('cannot use ordinary dispatch or silently turn an existing continuation into revalidation', async () => {
  const detail = { nativeSourceCorrection: true, nativeBusinessRevalidation: {},
    nextAttemptId: 'new-attempt', authorization: {} };
  const ledger = {
    job: () => ({ id: 'assignment', state: 'prepared', session_id: 'new-attempt' }),
    workspaceCleanup: () => null, get: () => ({}),
    status: () => ({ operations: [{ job_id: 'assignment',
      kind: 'continued-from-validation-failure', state: 'prepared', detail: json(detail) }] })
  };
  const config = { activation: { dispatch: true } };
  await assert.rejects(dispatch(config, ledger, 'assignment'), /explicit recorded dispatch entrypoint/);
  await assert.rejects(dispatchLocalValidationContinuation(config, ledger, 'assignment'),
    /explicit recorded dispatch entrypoint/);
  assert.throws(() => verifyNativeBusinessAuthority({ limits: {} }, detail),
    error => error.code === 'blocked-authorization');
});
