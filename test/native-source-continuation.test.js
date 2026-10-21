import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash, json } from '../src/common.js';
import { verifyNativeUnitFailure, verifySourceRepairApproval,
  verifyNativeSourceSnapshot, verifyNativeSourceAuthority, verifyNativeSourcePreparationFailure,
  nativeSourceValidationRepository, verifyNativeSourceCopyFailure } from '../src/native-source-continuation.js';
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
function preparationRecoveryFixture(t) {
  const f = reviewFixture(t), original = f.detail;
  const paths = ['ooui', 'packages', 'scripts', 'tools', '.github', '.config', '.buildXL', '.scoper'];
  const proof = { format: 'validation-preflight-v1', status: 'passed',
    assignmentId: original.priorJob.id, sourceRevision: original.priorResult.sourceRevision,
    baseRevision: original.priorJob.base_revision,
    profileSha256: f.config.repositories[0].validationGates[0].profileSha256,
    nativeCaseInvocations: 0, modelInvocations: 0, publicationInvocations: 0,
    acceptanceEvidence: false,
    preparation: { strategy: 'detached-worktree', sparseCheckoutPaths: paths } };
  const strategy = f.pin('strategy.json', proof);
  original.operations.push({ kind: 'continued-from-validation-failure', state: 'prepared',
    detail: json({ authorization: { preflight: strategy } }) });
  original.priorOperationsSha256 = hash(json(original.operations));
  original.nextStateDirectory = f.config.stateDirectory;
  original.nextAssignmentId = original.priorJob.id;
  original.nextAttemptId = 'source-repaired-attempt';
  const job = { ...original.priorJob, session_id: original.nextAttemptId };
  const result = structuredClone(original.priorResult);
  result.attemptId = job.session_id;
  result.sourceRevision = original.authorization.repairedRevision;
  result.validation[0].sourceRevision = result.sourceRevision;
  result.validation[0].blockedReason = 'validation-workspace-unavailable';
  const failure = { status: 'blocked', blockedReason: result.validation[0].blockedReason,
    revision: result.sourceRevision, gateId: result.validation[0].gateId,
    attempt: 0, profileSha256: proof.profileSha256,
    preparationTimings: [['source-check', 'passed'], ['worktree-create', 'passed'],
      ['checkout', 'blocked']].map(([id, status]) => ({ id, status })),
    output: { exitCode: null, timeout: false, stdout: '', stderr: 'Checkout timed out',
      preparationFailure: { stage: 'checkout', reason: 'command-timeout', timeout: true,
        ownedProcessesExited: true, containmentFailure: false } } };
  const failureRef = f.pin('checkout-failure.json', failure);
  result.validation[0].artifactRefs = [failureRef.path];
  const operations = [
    { kind: 'continued-from-validation-failure', state: 'prepared', detail: json(original) },
    { kind: 'reuse-authored-revision', state: 'completed' },
    { kind: 'declarative-registration-continuation', state: 'completed' },
    { kind: 'validation', state: 'blocked' }
  ];
  const config = { ...f.config, stateDirectory: join(f.directory, 'recovery') };
  const authorization = { ...original.authorization, kind: 'native-source-preparation-recovery',
    previousAttemptId: job.session_id, sourceRevision: result.sourceRevision,
    nextConfigSha256: hash(json(config)), failure: failureRef,
    preparationStrategy: strategy, sparseCheckoutPaths: paths };
  const detail = { ...structuredClone(original), previousConfig: f.config,
    priorStateDirectory: f.config.stateDirectory, priorJob: job, priorResult: result,
    priorResultSha256: hash(json(result)), operations,
    priorOperationsSha256: hash(json(operations)), authorization,
    authorizationSha256: hash(json(authorization)),
    sourcePreparationRecovery: { originalContinuation: original } };
  return { ...f, config, detail, job, result, operations, failure, proof };
}
test('source preparation recovery preserves repaired approval and applies only the attested sparse strategy', t => {
  const f = preparationRecoveryFixture(t);
  assert.doesNotThrow(() => verifyNativeSourceAuthority(f.config, f.detail));
  const repo = f.config.repositories[0];
  const effective = nativeSourceValidationRepository(repo, f.detail);
  assert.deepEqual(effective.sparseCheckoutPaths, f.proof.preparation.sparseCheckoutPaths);
  assert.equal(repo.sparseCheckoutPaths, undefined);
  assert.equal(effective.validationGates, repo.validationGates);
  assert.equal(nativeSourceValidationRepository(repo, f.detail.sourcePreparationRecovery.originalContinuation), repo);
  assert.throws(() => verifyNativeUnitFailure(f.job, f.result, f.operations,
    f.failure, f.failure.profileSha256), /sealed, unpublished/);
  for (const mutate of [
    d => { d.authorization.repairedRevision = 'e'.repeat(40); },
    d => { d.authorization.sparseCheckoutPaths = ['ooui/apps']; },
    d => { d.proposal.description = 'Changed publication'; },
    d => { d.sourcePreparationRecovery.originalContinuation.authorization.ownerApproval.sha256 = 'e'.repeat(64); },
    d => { d.sourcePreparationRecovery.originalContinuation.sourcePreparationRecovery = {}; },
    d => { d.operations.pop(); },
    d => { d.authorization.maxInitialModelAttempts = 1; },
    d => { d.nativePreparationCorrection = true; }
  ]) {
    const detail = structuredClone(f.detail);
    mutate(detail);
    detail.authorizationSha256 = hash(json(detail.authorization));
    detail.priorOperationsSha256 = hash(json(detail.operations));
    assert.throws(() => verifyNativeSourceAuthority(f.config, detail));
  }
});
test('source preparation recovery rejects native invocation, incomplete cleanup and any other failure stage', t => {
  const f = preparationRecoveryFixture(t);
  assert.doesNotThrow(() => verifyNativeSourcePreparationFailure(f.job, f.result,
    f.operations, f.failure, f.failure.profileSha256));
  for (const mutate of [
    d => { d.output.nativeReceipt = {}; },
    d => { d.output.unitDiagnostics = {}; },
    d => { d.output.cleanupError = 'Cleanup failed'; },
    d => { d.output.residualPaths = ['retained-workspace']; },
    d => { d.output.preparationFailure.ownedProcessesExited = false; },
    d => { d.output.preparationFailure.stage = 'dependency-seed'; },
    d => { d.preparationTimings.push({ id: 'native-runner', status: 'blocked' }); }
  ]) {
    const failure = structuredClone(f.failure);
    mutate(failure);
    assert.throws(() => verifyNativeSourcePreparationFailure(f.job, f.result,
      f.operations, failure, f.failure.profileSha256));
  }
});

function preparedSourceFixture(t) {
  const f = preparationRecoveryFixture(t), previous = f.detail;
  previous.nextStateDirectory = f.config.stateDirectory;
  previous.nextAssignmentId = f.job.id;
  previous.nextAttemptId = 'sparse-copy-attempt';
  const job = { ...f.job, session_id: previous.nextAttemptId };
  const result = structuredClone(f.result);
  result.id = 'copy-timeout-result';
  result.attemptId = job.session_id;
  result.skillExecution.registration = { caseIds: ['preserved-case'] };
  const operations = [
    { kind: 'continued-from-validation-failure', state: 'prepared', detail: json(previous) },
    { kind: 'reuse-authored-revision', state: 'completed' },
    { kind: 'declarative-registration-continuation', state: 'completed' },
    { id: 'copy-validation', kind: 'validation', state: 'blocked' }
  ];
  const failure = structuredClone(f.failure);
  failure.preparationTimings = [
    ['source-check', 'passed'], ['worktree-create', 'passed'], ['sparse-checkout', 'passed'],
    ['checkout', 'passed'], ['head-clean-check', 'passed'], ['lfs', 'passed'],
    ['dependencies', 'blocked'], ['dependency-source-fingerprint', 'passed'],
    ['dependency-copy', 'blocked']
  ].map(([id, status]) => ({ id, status }));
  failure.output.preparationFailure.stage = 'dependency-copy';
  failure.output.cleanupError = 'Residual cleanup failed';
  failure.output.residualPaths = [join(f.config.stateDirectory, 'validation-workspaces',
    hash(operations.at(-1).id))];
  const failureRef = f.pin('copy-failure.json', failure);
  result.validation[0].artifactRefs = [failureRef.path];
  const config = { ...f.config, stateDirectory: join(f.directory, 'prepared-run') };
  const workspace = join(f.directory, 'qualified-workspace');
  const files = ['src/workers.js', 'src/validation-workspace.js', 'src/native-command.js',
    'src/native-command.ps1', 'src/dependency-snapshot-copy.cjs', 'src/output-fingerprint.js',
    'src/output-fingerprint-worker.js', 'scripts/validation/preflight.mjs',
    'scripts/validation/native-preflight.cjs', 'src/native-preparation-continuation.js',
    'src/native-source-continuation.js', 'src/retained-dependency-copy.js'];
  const proof = {
    format: 'validation-preflight-v1', status: 'passed', completedAt: '2026-01-04T00:00:00Z',
    assignmentId: job.id, priorAttemptId: job.session_id, priorResultId: result.id,
    sourceRevision: result.sourceRevision, baseRevision: job.base_revision,
    profileSha256: failure.profileSha256,
    originalLedgerSha256: hash(json({ job, result, assignment: previous.priorAssignment, operations })),
    workspace, nativeCaseInvocations: 0, modelInvocations: 0, publicationInvocations: 0,
    acceptanceEvidence: false, publicationEligible: false,
    preparation: { strategy: 'detached-worktree', workspace,
      sourceRevision: result.sourceRevision, sparseCheckoutPaths: f.proof.preparation.sparseCheckoutPaths,
      dependencySeed: { format: 'declarative-dependency-seed-v1', sourceRevision: result.sourceRevision,
        sha256: 'e'.repeat(64), paths: ['ooui/.store'] } },
    native: { caseIds: result.skillExecution.registration.caseIds, nativeCaseInvocations: 0 },
    timings: ['native-load-typecheck-selection', 'post-native-clean']
      .map(id => ({ id, status: 'passed' })),
    controllerFiles: Object.fromEntries(files.map(file =>
      [file, hash(readFileSync(new URL(`../${file}`, import.meta.url)))]))
  };
  const authorization = { ...previous.authorization, kind: 'native-source-prepared-continuation',
    previousAttemptId: job.session_id, priorAuthorizationSha256: previous.authorizationSha256,
    failure: failureRef, preflight: f.pin('qualified-preflight.json', proof),
    nextConfigSha256: hash(json(config)) };
  const detail = { ...structuredClone(previous), previousConfig: f.config,
    priorStateDirectory: f.config.stateDirectory, priorJob: job, priorResult: result,
    priorResultSha256: hash(json(result)), operations, priorOperationsSha256: hash(json(operations)),
    authorization, authorizationSha256: hash(json(authorization)),
    sourcePreparedContinuation: { originalContinuation: previous } };
  delete detail.sourcePreparationRecovery;
  return { ...f, config, detail, previous, failure, proof };
}

test('prepared source continuation accepts only a new qualified workspace for the exact zero-native copy failure', t => {
  const f = preparedSourceFixture(t);
  assert.doesNotThrow(() => verifyNativeSourceAuthority(f.config, f.detail));
  assert.equal(verifyNativeSourceCopyFailure(f.detail, f.failure, f.failure.profileSha256),
    f.failure.output.residualPaths[0]);
  assert.deepEqual(nativeSourceValidationRepository(f.config.repositories[0], f.detail)
    .sparseCheckoutPaths, f.proof.preparation.sparseCheckoutPaths);
  assert.throws(() => verifyNativeSourcePreparationFailure(f.detail.priorJob, f.detail.priorResult,
    f.detail.operations, f.failure, f.failure.profileSha256), /completed cleanup/);
  for (const mutate of [
    d => { d.sourcePreparedContinuation.originalContinuation.sourcePreparedContinuation = {}; },
    d => { d.authorization.maxInitialModelAttempts = 1; },
    d => { d.authorization.repairedRevision = 'e'.repeat(40); },
    d => { d.files.pop(); },
    d => { d.proposal.description = 'Changed candidate'; },
    d => { d.previousConfig.limits.maxValidationInfrastructureRetries = 1; }
  ]) {
    const detail = structuredClone(f.detail);
    mutate(detail);
    detail.authorizationSha256 = hash(json(detail.authorization));
    assert.throws(() => verifyNativeSourceAuthority(f.config, detail));
  }
});

test('prepared source continuation rejects incomplete qualification, residual reuse and native invocation', t => {
  const f = preparedSourceFixture(t);
  for (const mutate of [
    p => { p.status = 'running'; },
    p => { p.nativeCaseInvocations = 1; },
    p => { p.preparation.dependencySeed.sourceRevision = 'f'.repeat(40); },
    p => { p.preparation.sparseCheckoutPaths = ['ooui/apps']; },
    p => { p.controllerFiles['src/retained-dependency-copy.js'] = '0'.repeat(64); },
    p => { p.workspace = join(f.failure.output.residualPaths[0], 'nested');
      p.preparation.workspace = p.workspace; }
  ]) {
    const detail = structuredClone(f.detail), proof = structuredClone(f.proof);
    mutate(proof);
    detail.authorization.preflight = f.pin('invalid-preflight.json', proof);
    detail.authorizationSha256 = hash(json(detail.authorization));
    assert.throws(() => verifyNativeSourceAuthority(f.config, detail));
  }
  for (const mutate of [
    a => { a.output.unitDiagnostics = {}; },
    a => { a.output.nativeReceipt = {}; },
    a => { a.output.preparationFailure.ownedProcessesExited = false; },
    a => { a.output.preparationFailure.stage = 'checkout'; }
  ]) {
    const failure = structuredClone(f.failure);
    mutate(failure);
    assert.throws(() => verifyNativeSourceCopyFailure(f.detail, failure, failure.profileSha256));
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
  await assert.doesNotReject(verifyNativeSourceSnapshot({
    sourcePreparationRecovery: { originalContinuation: f.detail }
  }));
  const artifact = join(workspace, 'untracked-diagnostic.png');
  writeFileSync(artifact, 'diagnostic\n');
  await assert.rejects(verifyNativeSourceSnapshot(f.detail), error => error.code === 'blocked-reconciliation');
  rmSync(artifact);
  writeFileSync(join(workspace, 'scenario.yaml'), 'changed candidate\n');
  await assert.rejects(verifyNativeSourceSnapshot(f.detail), error => error.code === 'blocked-reconciliation');
});
