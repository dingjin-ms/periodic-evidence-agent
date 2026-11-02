import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, availableParallelism } from 'node:os';
import { join } from 'node:path';
import { hash, json } from '../src/common.js';
import { outputFingerprint, verifyContinuationPredecessor } from '../src/workers.js';
import { outputPathFingerprintWithEntries } from '../src/output-fingerprint.js';
import { Ledger } from '../src/ledger.js';
import { nativePreparationWorkspace, verifyNativePreparationFailure,
  verifyNativePreparationContinuation, verifyPreparationPreflight } from '../src/native-preparation-continuation.js';

function preparationProof(job, result, assignment, operations, profileSha256, workspace) {
  const files = ['src/workers.js', 'src/validation-workspace.js', 'src/native-command.js',
    'src/native-command.ps1', 'src/dependency-snapshot-copy.cjs',
    'src/output-fingerprint.js', 'src/output-fingerprint-worker.js',
    'scripts/validation/preflight.mjs', 'scripts/validation/native-preflight.cjs',
    'src/native-preparation-continuation.js'];
  return { format: 'validation-preflight-v1', status: 'passed',
    completedAt: new Date().toISOString(), assignmentId: job.id,
    priorAttemptId: job.session_id, priorResultId: result.id,
    sourceRevision: result.sourceRevision, baseRevision: job.base_revision, profileSha256,
    workspace, originalLedgerSha256: hash(json({ job, result, assignment, operations })),
    nativeCaseInvocations: 0, modelInvocations: 0, publicationInvocations: 0,
    acceptanceEvidence: false, publicationEligible: false,
    preparation: { strategy: 'detached-worktree', workspace, sourceRevision: result.sourceRevision,
      dependencySeed: { format: 'declarative-dependency-seed-v1',
        sourceRevision: result.sourceRevision, sha256: 'd'.repeat(64), paths: ['ooui/node_modules'] } },
    native: { caseIds: result.skillExecution.registration?.caseIds, nativeCaseInvocations: 0 },
    timings: ['native-load-typecheck-selection', 'post-native-clean']
      .map(id => ({ id, status: 'passed' })),
    controllerFiles: Object.fromEntries(files.map(file =>
      [file, hash(readFileSync(new URL(`../${file}`, import.meta.url)))])) };
}

function fixture() {
  const revision = 'b'.repeat(40);
  const job = { id: 'synthetic-assignment', session_id: 'synthetic-attempt', state: 'blocked' };
  const validation = { gateId: 'synthetic-native', status: 'blocked',
    blockedReason: 'validation-workspace-unavailable', attemptCount: 1,
    artifactRefs: ['synthetic-artifact'], sourceRevision: revision };
  const result = { assignmentId: job.id, attemptId: job.session_id, outcome: 'blocked',
    sourceRevision: revision, draftPR: null, remoteValidation: [],
    toolUsage: { used: 0, rounds: [], byTool: { pilot_write: 0 } },
    skillExecution: { status: 'succeeded' }, validation: [validation],
    validationAttempts: [{ round: 0, sourceRevision: revision, validation: [validation] }] };
  const operations = [
    ['commit', 'completed'], ['continued-from-authoring-tool-failure', 'claimed'],
    ['declarative-registration-continuation', 'completed'], ['owner-review', 'approved'],
    ['reuse-owner-reviewed-proposal', 'completed'], ['validation', 'blocked']
  ].map(([kind, state]) => ({ kind, state }));
  const failure = { gateId: validation.gateId, revision, attempt: 0, status: 'blocked',
    blockedReason: validation.blockedReason, profileSha256: 'c'.repeat(64),
    output: { stdout: '', exitCode: null, timeout: false,
      stderr: 'Output fingerprint task timed out after 300000 ms: ' +
        json({ mode: 'path', path: 'ooui/.store/synthetic-large-package' }) } };
  return { job, result, operations, failure };
}
for (const condition of ['valid', 'published', 'native-output', 'model', 'native-exit',
  'different-failure', 'different-profile', 'more-rounds', 'more-attempts',
  'extra-operation', 'pending-owner', 'source', 'outside-dependency']) {
  test(`native preparation failure admission ${condition}`, () => {
    const { job, result, operations, failure } = fixture();
    if (condition === 'published') result.draftPR = { isDraft: true };
    if (condition === 'native-output') failure.output.stdout = 'PILOT_DECLARATIVE_RECEIPT:{}';
    if (condition === 'model') result.toolUsage.rounds.push({ round: 0 });
    if (condition === 'native-exit') failure.output.exitCode = 1;
    if (condition === 'different-failure') failure.output.stderr = 'Native case failed';
    if (condition === 'different-profile') failure.profileSha256 = 'd'.repeat(64);
    if (condition === 'more-rounds') result.validationAttempts.push(result.validationAttempts[0]);
    if (condition === 'more-attempts') result.validation[0].attemptCount = 2;
    if (condition === 'extra-operation') operations.push({ kind: 'push', state: 'started' });
    if (condition === 'pending-owner') operations.find(row => row.kind === 'owner-review').state = 'started';
    if (condition === 'source') failure.revision = 'e'.repeat(40);
    if (condition === 'outside-dependency')
      failure.output.stderr = 'Output fingerprint task timed out after 300000 ms: ' +
        json({ mode: 'path', path: '../elsewhere' });
    const verify = () => verifyNativePreparationFailure(job, result, operations, failure, 'c'.repeat(64));
    if (condition === 'valid') assert.doesNotThrow(verify);
    else assert.throws(verify, error => error.code === 'blocked-reconciliation');
  });
}

for (const condition of ['valid', 'grant-time', 'unlinked-grant', 'request-drift', 'approval-drift',
  'native-directory', 'file-drift', 'result-drift', 'operation-drift', 'description-drift', 'config-drift',
  'commit-source', 'commit-extra-field', 'base-authority', 'dispatch-recovery',
  'dispatch-native', 'dispatch-model', 'dispatch-nested', 'dispatch-operation', 'dispatch-source',
  'verified-valid', 'verified-proof', 'verified-native', 'verified-grant', 'verified-source']) {
  test(`native preparation recovery bindings ${condition}`, t => {
    const directory = mkdtempSync(join(tmpdir(), 'native-preparation-proof-'));
    t.after(() => rmSync(directory, { recursive: true, force: true }));
    const { job, result, operations, failure } = fixture();
    job.base_revision = 'a'.repeat(40); job.workspace = join(directory, 'workspace');
    const previous = join(directory, 'previous');
    const config = { stateDirectory: join(directory, 'next'), limits: { maxValidationInfrastructureRetries: 0 } };
    const grant = { approved: true, authorizedBy: 'user', scope: 'until-native-validation',
      authorizedAt: '2026-01-01T00:00:00Z', sourceRevision: job.base_revision,
      nextConfigSha256: hash(json({ ...config, stateDirectory: previous })),
      ownerReviewRecovery: { ownerReviewDirectory: join(directory, 'reviews') } };
    const pin = (name, value) => {
      const path = join(directory, name);
      writeFileSync(path, json(value));
      return { path, sha256: hash(json(value)) };
    };
    const request = { format: 'repository-owner-review-request-v1', assignmentId: job.id,
      attemptId: job.session_id, round: 0, baseRevision: job.base_revision, workspace: job.workspace,
      fileSha256: { 'test/synthetic.yaml': 'f'.repeat(64) },
      publication: { title: 'Synthetic title', description: 'Synthetic description' } };
    const requestRef = pin('request.json', request);
    const approvalRef = pin('approval.json', { format: 'repository-owner-review-v1',
      requestSha256: requestRef.sha256, status: 'approved',
      reviewedBy: 'security-review-agent', findings: [] });
    const failureRef = pin('failure.json', failure);
    result.validation[0].artifactRefs = [failureRef.path];
    for (const row of operations) row.detail = '{}';
    operations.find(row => row.kind === 'validation').id = 'synthetic-validation-operation';
    operations.find(row => row.kind === 'commit').detail = json({
      revision: result.sourceRevision, round: 0 });
    operations.find(row => row.kind === 'owner-review').detail = json({
      requestPath: requestRef.path, requestSha256: requestRef.sha256,
      approvalPath: approvalRef.path, approvalSha256: approvalRef.sha256,
      fileSha256: request.fileSha256 });
    operations.find(row => row.kind === 'continued-from-authoring-tool-failure').detail =
      json({ authorization: grant });
    const auth = { kind: 'native-preparation-only', approved: true, authorizedBy: 'user',
      scope: grant.scope, maxInitialModelAttempts: 0, authorizedAt: grant.authorizedAt,
      priorAuthorizationSha256: hash(json(grant)), previousAttemptId: job.session_id,
      sourceRevision: result.sourceRevision, baseRevision: job.base_revision,
      nextConfigSha256: hash(json(config)), failure: failureRef, ownerRequest: requestRef, ownerApproval: approvalRef };
    const detail = { authorization: auth, priorJob: job, priorResult: result,
      priorStateDirectory: previous, priorResultSha256: hash(json(result)),
      priorOperationsSha256: hash(json(operations)),
      proposal: { ...request.publication },
      files: [{ path: 'test/synthetic.yaml', sha256: 'f'.repeat(64) }],
      nativePreparationCorrection: { originalGrant: grant, operations,
        profileSha256: failure.profileSha256, ownerReviewDirectory: grant.ownerReviewRecovery.ownerReviewDirectory } };
    if (condition.startsWith('verified-')) {
      detail.authorizationSha256 = hash(json(auth));
      const original = structuredClone(detail);
      const immediateJob = { ...job, session_id: 'synthetic-immediate-attempt' };
      const immediateResult = { ...structuredClone(result), id: 'synthetic-immediate-result',
        attemptId: immediateJob.session_id };
      immediateResult.skillExecution.registration = { caseIds: ['synthetic-case'] };
      const immediateArtifact = { ...failure, output: {
        stdout: '', stderr: 'Sanitized preparation failure', exitCode: null, timeout: false } };
      const immediateFailure = pin('immediate-failure.json', immediateArtifact);
      immediateResult.validation[0].artifactRefs = [immediateFailure.path];
      const immediateOperations = [
        { id: 'synthetic-continued', kind: 'continued-from-validation-failure',
          state: 'prepared', detail: json(original) },
        { id: 'synthetic-immediate-validation', kind: 'validation', state: 'blocked' }
      ];
      const previousConfig = structuredClone(config);
      const recovery = { previousConfig, priorStateDirectory: config.stateDirectory,
        priorJob: immediateJob, priorAssignment: {}, priorResult: immediateResult,
        operations: immediateOperations, originalContinuation: original };
      config.stateDirectory = join(directory, 'verified-next');
      Object.assign(auth, { kind: 'native-preparation-verified',
        previousAssignmentId: immediateJob.id, previousAttemptId: immediateJob.session_id,
        priorAuthorizationSha256: original.authorizationSha256,
        nextConfigSha256: hash(json(config)), failure: immediateFailure });
      if (condition === 'verified-native')
        mkdirSync(join(recovery.priorStateDirectory, 'native-validation',
          hash('synthetic-immediate-validation')), { recursive: true });
      if (condition === 'verified-grant') auth.priorAuthorizationSha256 = 'e'.repeat(64);
      if (condition === 'verified-source') immediateResult.sourceRevision = 'e'.repeat(40);
      const proof = preparationProof(immediateJob, immediateResult, {},
        immediateOperations, failure.profileSha256, join(directory, 'accepted-workspace'));
      if (condition === 'verified-proof') proof.controllerFiles['src/workers.js'] = 'e'.repeat(64);
      auth.preflight = pin('accepted-preflight.json', proof);
      recovery.priorResultSha256 = hash(json(immediateResult));
      recovery.priorOperationsSha256 = hash(json(immediateOperations));
      detail.preparationRecovery = recovery;
    }
    if (condition.startsWith('dispatch-')) {
      detail.nextAttemptId = 'synthetic-dispatch-attempt'; detail.nextAssignmentId = job.id;
      detail.authorizationSha256 = hash(json(auth));
      const original = structuredClone(detail);
      const previousRoot = config.stateDirectory;
      const dispatchJob = { id: job.id, session_id: detail.nextAttemptId, state: 'blocked',
        base_revision: null, workspace: job.workspace,
        error: json({ code: 'blocked-reconciliation',
          message: 'Repository skill qualification does not match the isolated source revision' }) };
      const dispatchResult = { assignmentId: job.id, attemptId: dispatchJob.session_id,
        outcome: 'blocked', sourceRevision: null, skillExecution: null, draftPR: null,
        remoteValidation: [], validation: [], validationAttempts: [],
        toolUsage: { used: 0, rounds: [], byTool: { pilot_write: 0 } } };
      const dispatchOperations = [{ id: `${job.id}:validation-continuation`,
        kind: 'continued-from-validation-failure', state: 'prepared',
        detail: json(original) }];
      const recovery = { priorStateDirectory: previousRoot, priorJob: dispatchJob,
        priorResult: dispatchResult, priorResultSha256: hash(json(dispatchResult)),
        operations: dispatchOperations, priorOperationsSha256: hash(json(dispatchOperations)),
        originalContinuation: original };
      detail.nativePreparationDispatchFailure = recovery;
      config.stateDirectory = join(directory, 'dispatch-next');
      auth.nextConfigSha256 = hash(json(config));
      auth.previousAttemptId = dispatchJob.session_id;
      auth.priorAuthorizationSha256 = hash(json(original.authorization));
      if (condition === 'dispatch-native') dispatchResult.validation.push({ status: 'failed' });
      if (condition === 'dispatch-model') dispatchResult.toolUsage.used = 1;
      if (condition === 'dispatch-nested') original.nativePreparationDispatchFailure = {};
      if (condition === 'dispatch-operation') dispatchOperations.push({ kind: 'validation' });
      if (condition === 'dispatch-source') detail.priorJob = { ...job, base_revision: 'd'.repeat(40) };
      recovery.priorResultSha256 = hash(json(dispatchResult));
      recovery.priorOperationsSha256 = hash(json(dispatchOperations));
    }
    if (condition === 'grant-time') auth.authorizedAt = '2026-01-02T00:00:00Z';
    if (condition === 'unlinked-grant') auth.priorAuthorizationSha256 = 'e'.repeat(64);
    if (condition === 'request-drift') writeFileSync(requestRef.path, '{}');
    if (condition === 'approval-drift') writeFileSync(approvalRef.path, '{}');
    if (condition === 'native-directory')
      mkdirSync(join(previous, 'native-validation', hash('synthetic-validation-operation')), { recursive: true });
    if (condition === 'file-drift') detail.files[0].sha256 = 'e'.repeat(64);
    if (condition === 'result-drift') result.sourceRevision = 'e'.repeat(40);
    if (condition === 'operation-drift') operations.find(row => row.kind === 'commit').state = 'started';
    if (condition === 'commit-source')
      operations.find(row => row.kind === 'commit').detail = json({ revision: 'd'.repeat(40), round: 0 });
    if (condition === 'commit-extra-field')
      operations.find(row => row.kind === 'commit').detail = json({
        revision: result.sourceRevision, round: 0, baseRevision: job.base_revision });
    if (condition === 'base-authority') auth.baseRevision = 'd'.repeat(40);
    if (condition === 'description-drift') detail.proposal.description = 'Changed';
    if (condition === 'config-drift') {
      config.limits.maxValidationInfrastructureRetries = 1;
      auth.nextConfigSha256 = hash(json(config));
    }
    detail.authorizationSha256 = hash(json(auth));
    detail.priorOperationsSha256 = hash(json(operations));
    const verify = () => verifyNativePreparationContinuation(config, detail);
    if (['valid', 'dispatch-recovery', 'verified-valid'].includes(condition)) assert.doesNotThrow(verify);
    else assert.throws(verify, error => ['blocked-reconciliation', 'blocked-authorization'].includes(error.code));
  });
}

test('real preflight acceptance rejects incomplete stages, changed bytes and invocation claims', () => {
  const { job, result, operations, failure } = fixture();
  job.base_revision = 'a'.repeat(40);
  result.skillExecution.registration = { caseIds: ['synthetic-case'] };
  const proof = preparationProof(job, result, {}, operations, failure.profileSha256,
    join(tmpdir(), 'synthetic-accepted-workspace'));
  const verify = value => verifyPreparationPreflight(value, job, result, {},
    operations, failure.profileSha256);
  assert.doesNotThrow(() => verify(proof));
  for (const change of [
    value => { value.timings[0].status = 'blocked'; },
    value => { value.timings.pop(); },
    value => { value.modelInvocations = 1; },
    value => { value.nativeCaseInvocations = 1; },
    value => { value.native.caseIds = ['different-case']; },
    value => { value.originalLedgerSha256 = 'e'.repeat(64); },
    value => { value.preparation.dependencySeed.sourceRevision = 'e'.repeat(40); },
    value => { value.controllerFiles['src/native-command.ps1'] = 'e'.repeat(64); }
  ]) {
    const changed = structuredClone(proof);
    change(changed);
    assert.throws(() => verify(changed), error => error.code === 'blocked-reconciliation');
  }
});

test('native preparation workspace maps its original base into the actual ledger contract', t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-preparation-ledger-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = new Ledger(directory);
  try {
    const id = 'synthetic-assignment';
    ledger.db.prepare(`INSERT INTO jobs
      (id,investigation_id,version,repo,state,session_id,updated_at) VALUES(?,?,?,?,?,?,?)`)
      .run(id, 'synthetic-investigation', 1, 'synthetic-repo',
        'prepared', 'synthetic-attempt', new Date().toISOString());
    ledger.moveJob(id, 'prepared', 'dispatching');
    const detail = { nativePreparationCorrection: {}, priorJob: {
      workspace: join(directory, 'workspace'), base_revision: 'a'.repeat(40) } };
    ledger.moveJob(id, 'dispatching', 'running', nativePreparationWorkspace(detail));
    assert.equal(ledger.job(id).base_revision, detail.priorJob.base_revision);
    assert.equal(ledger.job(id).workspace, detail.priorJob.workspace);
    assert.throws(() => nativePreparationWorkspace({ ...detail,
      priorJob: { ...detail.priorJob, base_revision: null } }));
  } finally { ledger.close(); }
});

test('dispatch correction preserves both reservations using distinct operation identifiers', t => {
  const directory = mkdtempSync(join(tmpdir(), 'native-preparation-reservations-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledgers = [new Ledger(join(directory, 'original')), new Ledger(join(directory, 'dispatch'))];
  try {
    const id = 'synthetic-assignment', stamp = new Date().toISOString();
    for (const [index, ledger] of ledgers.entries()) {
      ledger.db.prepare(`INSERT INTO jobs
        (id,investigation_id,version,repo,state,session_id,updated_at) VALUES(?,?,?,?,?,?,?)`)
        .run(id, 'synthetic-investigation', 1, 'synthetic-repo', 'blocked', `attempt-${index}`, stamp);
      ledger.db.prepare('INSERT INTO records(kind,id,body,created_at) VALUES(?,?,?,?)')
        .run('workerResult', `result-${index}`, json({ id: `result-${index}` }), stamp);
    }
    const [originalLedger, dispatchLedger] = ledgers;
    const originalId = `${id}:validation-continuation`;
    const nextId = `${id}:native-preparation-dispatch-continuation`;
    const original = { priorStateDirectory: originalLedger.directory,
      priorJob: originalLedger.job(id), priorResult: { id: 'result-0' },
      priorResultSha256: hash(json({ id: 'result-0' })), priorOperationsSha256: hash(json([])) };
    originalLedger.operation(originalId, id, 'validation-continuation', {});
    originalLedger.finishOperation(originalId, 'prepared', { nextAttemptId: 'attempt-1' });
    dispatchLedger.operation(originalId, id, 'continued-from-validation-failure', original);
    dispatchLedger.finishOperation(originalId, 'prepared', original);
    const recovery = { priorStateDirectory: dispatchLedger.directory,
      priorJob: dispatchLedger.job(id), priorResult: { id: 'result-1' },
      priorResultSha256: hash(json({ id: 'result-1' })),
      operations: dispatchLedger.status().operations,
      priorOperationsSha256: hash(json(dispatchLedger.status().operations)),
      originalContinuation: original };
    dispatchLedger.operation(nextId, id, 'validation-continuation', {});
    dispatchLedger.finishOperation(nextId, 'prepared', { nextAttemptId: 'attempt-2' });
    const detail = { nativePreparationDispatchFailure: recovery };
    assert.doesNotThrow(() => verifyContinuationPredecessor(detail, nextId, 'attempt-2'));
    assert.doesNotThrow(() => verifyContinuationPredecessor(
      { preparationRecovery: recovery }, nextId, 'attempt-2'));
    assert.throws(() => verifyContinuationPredecessor(detail, originalId, 'attempt-2'));
    originalLedger.finishOperation(originalId, 'prepared', { nextAttemptId: 'other-attempt' });
    assert.throws(() => verifyContinuationPredecessor(detail, nextId, 'attempt-2'));
  } finally { for (const ledger of ledgers) ledger.close(); }
});

test('partitioned ordinary dependency paths retain the complete canonical digest and entries',
  { skip: availableParallelism() < 2 }, async t => {
    const workspace = mkdtempSync(join(tmpdir(), 'large-path-fingerprint-'));
    t.after(() => rmSync(workspace, { recursive: true, force: true }));
    const path = 'ooui/.store/synthetic-large', directory = join(workspace, path);
    mkdirSync(join(directory, 'nested'), { recursive: true });
    mkdirSync(join(directory, 'empty'));
    for (let index = 0; index < 2050; index++)
      writeFileSync(join(directory, 'nested', `${index}.txt`), `Synthetic ${index}`);
    symlinkSync(join(directory, 'nested'), join(directory, 'linked'),
      process.platform === 'win32' ? 'junction' : 'dir');
    const expected = outputPathFingerprintWithEntries(workspace, path);
    const digest = hash(json([expected.value]));
    assert.equal(await outputFingerprint(workspace, [path]), digest);
    const captured = await outputFingerprint(workspace, [path], true);
    assert.equal(captured.sha256, digest);
    assert.deepEqual(captured.entries, new Map(expected.entries));
    writeFileSync(join(directory, 'nested', '2049.txt'), 'Changed');
    assert.notEqual(await outputFingerprint(workspace, [path]), digest);
  });
