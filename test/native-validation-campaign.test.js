import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, json } from '../src/common.js';
import { nativeCampaignValidationRepository, verifyNativeCampaignAuthority } from '../src/native-validation-campaign.js';

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'native-campaign-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const pin = (name, body) => {
    const path = join(directory, name);
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, json(body));
    return { path, sha256: hash(json(body)) };
  };
  const revision = 'a'.repeat(40), profile = 'b'.repeat(64);
  const job = { id: 'assignment', session_id: 'failed-attempt', state: 'blocked',
    workspace: join(directory, 'author'), base_revision: 'c'.repeat(40) };
  const gate = { gateId: 'native', status: 'blocked', blockedReason: 'validation-profile-error',
    sourceRevision: revision, attemptCount: 1, artifactRefs: [] };
  const result = { id: 'sealed-result', assignmentId: job.id, attemptId: job.session_id,
    reportedAt: '2026-01-01T00:00:00Z', outcome: 'blocked', sourceRevision: revision,
    draftPR: null, remoteValidation: [], toolUsage: { used: 0, rounds: [], byTool: { pilot_finish: 0 } },
    skillExecution: { status: 'succeeded', needsHumanDecision: false,
      registration: { caseIds: ['original-case'] } },
    validation: [gate], validationAttempts: [{ round: 0, validation: [gate] }] };
  const assignment = { id: job.id, repoId: 'synthetic', skillQualification: { qualifiedAt: 'old' } };
  const operations = [
    { id: 'native-operation', kind: 'validation', state: 'blocked' },
    { id: 'continuation', kind: 'continued-from-validation-failure', state: 'prepared',
      detail: json({ legacyConsumed: true }) },
    { id: 'reuse', kind: 'reuse-authored-revision', state: 'completed' },
    { id: 'registration', kind: 'declarative-registration-continuation', state: 'completed' }
  ];
  const previous = { stateDirectory: join(directory, 'prior'),
    limits: { maxValidationRepairRounds: 10, maxValidationInfrastructureRetries: 0 },
    repositories: [{ id: 'synthetic', sparseCheckoutPaths: ['ooui'], validationGates: [{
      id: 'native', profile: '1js-declarative-e2e-v1', profileSha256: profile, timeoutMs: 3600000,
      declarativeE2E: { cdpEndpoint: 'http://127.0.0.1:9222' }
    }] }] };
  const config = { ...previous, stateDirectory: join(directory, 'next') };
  const failure = pin('failure.json', { status: 'blocked', blockedReason: gate.blockedReason,
    revision, gateId: gate.gateId, attempt: 0, profileSha256: profile,
    output: { exitCode: 1, timeout: false } });
  gate.artifactRefs = [failure.path];
  const nativeSummary = pin(join('prior', 'native-validation', hash(operations[0].id),
    'native-batch', 'summary.json'), { status: 'failed', cases: [{
    status: 'failed', expectedStatus: 'passed', repeatEachIndex: 0, retry: 0
  }] });
  const source = { authorization: { repairedRevision: revision, unitFile: 'approved.unit.ts',
    ownerRequest: { path: 'preserved-request', sha256: 'd'.repeat(64) },
    ownerApproval: { path: 'preserved-approval', sha256: 'e'.repeat(64) } },
    files: [{ path: 'original-case.yaml', sha256: 'f'.repeat(64) }],
    proposal: { title: 'Original candidate', description: 'Original approved description' } };
  const historicalFiles = ['src/cli.js', 'src/workers.js', 'src/native-business-revalidation.js',
    'src/native-environment-revalidation.js', 'src/native-source-continuation.js',
    'src/native-preparation-continuation.js', 'src/native-command.js'];
  const history = { format: 'consumed-native-environment-historical-attestation-v1',
    verifiedAt: '2026-01-02T00:00:00Z', controllerRevision: '1'.repeat(40),
    controllerFiles: Object.fromEntries(historicalFiles.map(file =>
      [file, hash(readFileSync(new URL(`../${file}`, import.meta.url)))])),
    configSha256: hash(json(previous)), priorStateDirectory: previous.stateDirectory,
    currentLegacyAuthorityVerifiedByUnchangedRecordedCode: true,
    ownerReviewedSourceSnapshotVerified: true, consumedGrantIsNotNewDispatchAuthority: true,
    nativeInvocations: 0, publicationActions: 0, sourceRevision: revision,
    originalSourceContinuation: source, job, result, assignment, operations,
    continuationSha256: hash(operations[1].detail) };
  const instruction = { format: 'full-live-loop-user-instruction-v1',
    requestedAt: '2026-01-01T00:00:00Z', assignmentId: job.id, approvedSourceRevision: revision,
    userText: 'Continue until the live E2E works.', followUpUserText: 'Require five new passes.',
    preserveExistingBoundaries: Object.fromEntries(['recollectOrReauthorExistingCandidate',
      'newAuthorCheckout', 'alterSealedResults', 'combineHistoricalPasses', 'skipBusinessAssertions',
      'productHarnessProviderOrSchemaFreezeLifted', 'publicationBeforeNewFormalFivePasses']
      .map(key => [key, false])) };
  const analysis = { format: 'native-campaign-failure-analysis-v1',
    previousAttemptId: job.session_id, previousResultId: result.id, sourceRevision: revision,
    countsTowardFormalFive: false, productOrHarnessChanged: false,
    findings: 'Original assertions fail on a service response title.',
    nextBatchRationale: 'The unchanged case passed in a controlled environment comparison.',
    evidence: [nativeSummary] };
  const workspace = join(directory, 'prepared-validation');
  const files = ['src/workers.js', 'src/validation-workspace.js', 'src/native-command.js',
    'src/native-command.ps1', 'src/dependency-snapshot-copy.cjs', 'src/output-fingerprint.js',
    'src/output-fingerprint-worker.js', 'scripts/validation/preflight.mjs',
    'scripts/validation/native-preflight.cjs', 'src/native-preparation-continuation.js'];
  const proof = { format: 'validation-preflight-v1', status: 'passed',
    completedAt: '2026-01-03T00:00:00Z', assignmentId: job.id,
    priorAttemptId: job.session_id, priorResultId: result.id,
    sourceRevision: revision, baseRevision: job.base_revision, profileSha256: profile,
    originalLedgerSha256: hash(json({ job, result, assignment, operations })), workspace,
    nativeCaseInvocations: 0, modelInvocations: 0, publicationInvocations: 0,
    acceptanceEvidence: false, publicationEligible: false,
    preparation: { strategy: 'detached-worktree', workspace, sourceRevision: revision,
      sparseCheckoutPaths: ['ooui'], dependencySeed: { format: 'declarative-dependency-seed-v1',
        sourceRevision: revision, sha256: 'a'.repeat(64), paths: ['ooui/.store'] } },
    native: { caseIds: ['original-case'], nativeCaseInvocations: 0 },
    timings: ['native-load-typecheck-selection', 'post-native-clean']
      .map(id => ({ id, status: 'passed' })),
    controllerFiles: Object.fromEntries(files.map(file =>
      [file, hash(readFileSync(new URL(`../${file}`, import.meta.url)))])) };
  const authorization = { ...source.authorization, kind: 'native-validation-campaign-batch',
    approved: true, authorizedBy: 'user', scope: 'one-complete-batch-in-until-pass-campaign',
    maxInitialModelAttempts: 0, maxNativeBatches: 1, requiredRepeats: 5, nativeRetries: 0,
    batchIndex: 0, previousAssignmentId: job.id, previousAttemptId: job.session_id,
    sourceRevision: revision, baseRevision: job.base_revision, controllerRevision: '2'.repeat(40),
    recordedAt: '2026-01-03T00:00:01Z', nextConfigSha256: hash(json(config)),
    isolatedCdpEndpoint: 'http://127.0.0.1:9338', failure, nativeSummary,
    historicalAttestation: pin('history.json', history),
    campaignInstruction: pin('instruction.json', instruction),
    failureAnalysis: pin('analysis.json', analysis), preflight: pin('preflight.json', proof) };
  const detail = { previousConfig: previous, priorStateDirectory: previous.stateDirectory,
    priorJob: job, priorAssignment: assignment, priorResult: result,
    priorResultSha256: hash(json(result)), operations, priorOperationsSha256: hash(json(operations)),
    authorization, authorizationSha256: hash(json(authorization)),
    nativeSourceCorrection: true, nativeCampaignRevalidation: true,
    files: source.files, proposal: source.proposal };
  return { config, detail, history, instruction, analysis, proof, pin };
}
function rehash(detail) {
  detail.authorizationSha256 = hash(json(detail.authorization));
}

test('admits a separate full batch without replaying or rewriting the consumed legacy grant', t => {
  const { config, detail } = fixture(t);
  const before = structuredClone({ config, detail });
  assert.doesNotThrow(() => verifyNativeCampaignAuthority(config, detail));
  assert.deepEqual({ config, detail }, before);
  const repo = config.repositories[0];
  const runtime = nativeCampaignValidationRepository(repo, detail);
  assert.equal(runtime.validationGates[0].declarativeE2E.cdpEndpoint, 'http://127.0.0.1:9338');
  assert.equal(repo.validationGates[0].declarativeE2E.cdpEndpoint, 'http://127.0.0.1:9222');
});
test('rejects source drift, retries, combined passes, widened limits and legacy masquerading', t => {
  const f = fixture(t);
  for (const mutate of [
    d => { d.authorization.requiredRepeats = 4; },
    d => { d.authorization.nativeRetries = 1; },
    d => { d.authorization.maxNativeBatches = 2; },
    d => { d.authorization.maxInitialModelAttempts = 1; },
    d => { d.authorization.batchIndex = 10; },
    d => { d.authorization.repairedRevision = '9'.repeat(40); },
    d => { d.authorization.ownerApproval = null; },
    d => { d.nativeBusinessRevalidation = {}; },
    d => { d.files = []; },
    d => { d.proposal.description = 'Reauthored'; },
    d => { d.authorization.isolatedCdpEndpoint = 'http://127.0.0.1:9222'; },
    d => { d.authorization.isolatedCdpEndpoint = 'http://example.com:9338'; },
    d => { d.authorization.isolatedCdpEndpoint = 'http://127.0.0.1:65536'; },
    d => { d.priorResult.remoteValidation = [{ id: 42 }]; },
    d => { d.priorResult.sourceRevision = '9'.repeat(40); }
  ]) {
    const detail = structuredClone(f.detail); mutate(detail); rehash(detail);
    assert.throws(() => verifyNativeCampaignAuthority(f.config, detail));
  }
});
test('requires pinned ongoing user boundaries, failure analysis and current preparation', t => {
  const f = fixture(t);
  for (const [field, value] of [
    ['campaignInstruction', { ...f.instruction, preserveExistingBoundaries: {
      ...f.instruction.preserveExistingBoundaries, skipBusinessAssertions: true } }],
    ['campaignInstruction', { ...f.instruction, approvedSourceRevision: '9'.repeat(40) }],
    ['historicalAttestation', { ...f.history, consumedGrantIsNotNewDispatchAuthority: false }],
    ['historicalAttestation', { ...f.history, ownerReviewedSourceSnapshotVerified: false }],
    ['historicalAttestation', { ...f.history, configSha256: '9'.repeat(64) }],
    ['failureAnalysis', { ...f.analysis, previousResultId: 'unrelated-result' }],
    ['failureAnalysis', { ...f.analysis, countsTowardFormalFive: true }],
    ['failureAnalysis', { ...f.analysis, evidence: [] }],
    ['preflight', { ...f.proof, nativeCaseInvocations: 1 }],
    ['preflight', { ...f.proof, priorAttemptId: 'different-attempt' }],
    ['preflight', { ...f.proof, controllerFiles: {} }]
  ]) {
    const detail = structuredClone(f.detail);
    detail.authorization[field] = f.pin(`invalid-${field}.json`, value);
    rehash(detail);
    assert.throws(() => verifyNativeCampaignAuthority(f.config, detail));
  }
  const detail = structuredClone(f.detail);
  writeFileSync(detail.authorization.failureAnalysis.path, '{}');
  assert.throws(() => verifyNativeCampaignAuthority(f.config, detail), /evidence changed/);
});
test('cannot skip a campaign batch or import an unrelated earlier acceptance', t => {
  const f = fixture(t), detail = structuredClone(f.detail);
  detail.authorization.batchIndex = 1;
  rehash(detail);
  assert.throws(() => verifyNativeCampaignAuthority(f.config, detail), /reserved same-source chain/);
  const same = structuredClone(f.detail);
  same.priorResult.id = 'different-result';
  same.priorResultSha256 = hash(json(same.priorResult));
  rehash(same);
  assert.throws(() => verifyNativeCampaignAuthority(f.config, same), /exact attested consumed predecessor/);
});
function nextCampaign(f) {
  const detail = structuredClone(f.detail);
  const previous = structuredClone(f.detail);
  Object.assign(previous, { nextStateDirectory: f.config.stateDirectory,
    nextAssignmentId: detail.priorJob.id, nextAttemptId: 'campaign-zero-attempt' });
  detail.previousConfig = f.config;
  detail.priorStateDirectory = f.config.stateDirectory;
  detail.priorJob.session_id = previous.nextAttemptId;
  Object.assign(detail.priorResult, { id: 'campaign-zero-failed-result',
    attemptId: previous.nextAttemptId, reportedAt: '2026-01-04T00:00:00Z' });
  const config = { ...f.config, stateDirectory: join(f.config.stateDirectory, '..', 'campaign-one') };
  detail.operations.find(row => row.kind === 'continued-from-validation-failure').detail = json(previous);
  const native = detail.operations.find(row => row.kind === 'validation');
  native.id = 'campaign-zero-validation';
  const summary = JSON.parse(readFileSync(detail.authorization.nativeSummary.path));
  detail.authorization.nativeSummary = f.pin(join('next', 'native-validation', hash(native.id),
    'native-batch', 'summary.json'), summary);
  Object.assign(detail.authorization, { batchIndex: 1, previousAttemptId: previous.nextAttemptId,
    nextConfigSha256: hash(json(config)), recordedAt: '2026-01-05T00:00:00Z',
    failureAnalysis: f.pin('next-analysis.json', { ...f.analysis,
      previousAttemptId: previous.nextAttemptId, previousResultId: detail.priorResult.id }) });
  const proof = structuredClone(f.proof);
  Object.assign(proof, { priorAttemptId: previous.nextAttemptId, priorResultId: detail.priorResult.id,
    completedAt: '2026-01-05T00:00:00Z', workspace: join(config.stateDirectory, 'prepared'),
    originalLedgerSha256: hash(json({ job: detail.priorJob, result: detail.priorResult,
      assignment: detail.priorAssignment, operations: detail.operations })) });
  proof.preparation.workspace = proof.workspace;
  detail.authorization.preflight = f.pin('next-preflight.json', proof);
  detail.priorResultSha256 = hash(json(detail.priorResult));
  detail.priorOperationsSha256 = hash(json(detail.operations));
  rehash(detail);
  return { config, detail, previous };
}
test('admits the next sealed campaign failure only with new preparation and the same campaign root', t => {
  const { config, detail, previous } = nextCampaign(fixture(t));
  assert.doesNotThrow(() => verifyNativeCampaignAuthority(config, detail));
  previous.authorization.batchIndex = 8;
  detail.operations.find(row => row.kind === 'continued-from-validation-failure').detail = json(previous);
  detail.priorOperationsSha256 = hash(json(detail.operations));
  assert.throws(() => verifyNativeCampaignAuthority(config, detail), /reserved same-source chain/);
});

function interruptedCampaign(t) {
  const f = fixture(t), next = nextCampaign(f), { config, detail } = next;
  const budget = { kind: 'native-command-budget-adjustment-v1',
    sourceRevision: detail.authorization.sourceRevision,
    previousCommandTimeoutMs: 1800000, commandTimeoutMs: 3000000,
    originalConfig: f.pin('original-config.json', detail.previousConfig) };
  config.repositories[0].validationGates[0].declarativeE2E.commandTimeoutMs = 3000000;
  const summary = { status: 'running', cases: Array.from({ length: 4 }, (_, index) => ({
    repeatEachIndex: index, status: 'passed', expectedStatus: 'passed', retry: 0,
    durationMs: 250000 + index
  })) };
  const nativeSummary = f.pin(join('next', 'native-validation', hash('campaign-zero-validation'),
    'native-batch', 'summary.json'), summary);
  const failure = { ...JSON.parse(readFileSync(detail.authorization.failure.path)),
    output: { exitCode: 1, timeout: false, stderr: 'Native pages were not restored',
      cleanupDetails: [{ rootRemoved: true }] } };
  const failureRef = f.pin('interrupted-failure.json', failure);
  detail.priorResult.validation[0].artifactRefs = [failureRef.path];
  const job = { startedAt: '2026-01-04T00:00:00Z', completedAt: '2026-01-04T00:40:00Z',
    exitCode: 1, timeout: false, ownedProcessesExited: true, containmentFailure: false };
  const closed = { ownedBrowserClosed: true, originalBrowserContacted: false };
  const outerPages = { existingOwnedPagesPreserved: false, originalBrowserContacted: false };
  const driverFailure = { automaticReplayAllowed: false };
  const refs = [failureRef, nativeSummary,
    f.pin(join('formal', 'job.json'), job),
    f.pin(join('formal', 'owned-browser-closed.json'), closed),
    f.pin(join('formal', 'owned-browser-cleanup.json'), outerPages),
    f.pin(join('formal', 'driver-failure.json'), driverFailure),
    f.pin(join('next', 'native-validation', hash('campaign-zero-validation'), 'browser-cleanup.json'),
      { before: [{}], after: [{}, {}] })];
  const evidence = {
    resultId: detail.priorResult.id, attemptId: detail.priorJob.session_id,
    sourceRevision: detail.priorResult.sourceRevision, outcome: 'blocked', summaryStatus: 'running',
    fifthCaseFinalized: false, nativePageCounts: { before: 1, after: 2 }, workspaceAbsent: true,
    cases: summary.cases.map(item => ({ repeat: item.repeatEachIndex, status: item.status,
      expectedStatus: item.expectedStatus, retry: item.retry, durationMs: item.durationMs })),
    artifact: { path: failureRef.path, output: {
      ...failure.output, cleanupFailures: [], residualPaths: []
    } },
    job, closed, outerPages, driverFailure,
    evidence: Object.fromEntries(refs.map(ref => [ref.path, { sha256: ref.sha256 }]))
  };
  Object.assign(detail.authorization, { failure: failureRef, nativeSummary,
    nextConfigSha256: hash(json(config)), commandBudgetAdjustment: budget,
    interruptedNativeBatch: f.pin('interruption.json', evidence) });
  const proof = JSON.parse(readFileSync(detail.authorization.preflight.path));
  proof.originalLedgerSha256 = hash(json({ job: detail.priorJob, result: detail.priorResult,
    assignment: detail.priorAssignment, operations: detail.operations }));
  detail.authorization.preflight = f.pin('interrupted-preflight.json', proof);
  detail.priorResultSha256 = hash(json(detail.priorResult));
  rehash(detail);
  return { ...f, ...next, evidence };
}

test('admits a sealed interrupted batch without rewriting its running summary or loosening business checks', t => {
  const { config, detail } = interruptedCampaign(t);
  const before = structuredClone({ config, detail });
  const summaryBefore = readFileSync(detail.authorization.nativeSummary.path);
  assert.doesNotThrow(() => verifyNativeCampaignAuthority(config, detail));
  assert.deepEqual({ config, detail }, before);
  assert.deepEqual(readFileSync(detail.authorization.nativeSummary.path), summaryBefore);
  delete detail.authorization.interruptedNativeBatch;
  rehash(detail);
  assert.throws(() => verifyNativeCampaignAuthority(config, detail), /original failed native batch/);
});

test('bounded command budget adjustment cannot change profile, gate deadline, flight or retries', t => {
  const f = interruptedCampaign(t);
  for (const mutate of [
    c => { c.repositories[0].validationGates[0].profileSha256 = '9'.repeat(64); },
    c => { c.repositories[0].validationGates[0].timeoutMs = 7200000; },
    c => { c.repositories[0].validationGates[0].declarativeE2E.commandTimeoutMs = 7200000; },
    c => { c.repositories[0].validationGates[0].declarativeE2E.flight = true; },
    c => { c.limits.maxValidationInfrastructureRetries = 1; }
  ]) {
    const config = structuredClone(f.config), detail = structuredClone(f.detail);
    mutate(config); detail.authorization.nextConfigSha256 = hash(json(config)); rehash(detail);
    assert.throws(() => verifyNativeCampaignAuthority(config, detail), /budget adjustment/);
  }
});

test('interrupted admission rejects live or invented termination and missing original evidence', t => {
  const f = interruptedCampaign(t);
  let index = 0;
  for (const mutate of [
    e => { e.job.ownedProcessesExited = false; },
    e => { e.closed.ownedBrowserClosed = false; },
    e => { e.sourceRevision = '9'.repeat(40); },
    e => { e.cases[0].retry = 1; },
    e => { e.fifthCaseFinalized = true; },
    e => { e.workspaceAbsent = false; },
    e => { delete e.evidence[Object.keys(e.evidence).find(path => /[\\/]job.json$/.test(path))]; }
  ]) {
    const detail = structuredClone(f.detail), evidence = structuredClone(f.evidence);
    mutate(evidence);
    detail.authorization.interruptedNativeBatch = f.pin(`invalid-interruption-${index++}.json`, evidence);
    rehash(detail);
    assert.throws(() => verifyNativeCampaignAuthority(f.config, detail));
  }
});
