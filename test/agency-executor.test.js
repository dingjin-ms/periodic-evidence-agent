import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';
import { configAt, hash, json, now } from '../src/common.js';
import { evidenceEnvelope } from '../src/sources.js';
import { makeAssignment, dispatch, requireCurrentAssignment, reconcileHostedAssignment } from '../src/workers.js';
import { beginApp, openApp, appWorker } from '../src/app-native.js';
import { selectAgency, requireAgencyQualification, reserveAgencyRequest, inspectAgencyRequest,
  recordAgencySubmission, reconcileAgencyResult, recordAgencyAnalysisCheck,
  agencyFilterRunnerMetadata, validateFilterAnalysisPolicy } from '../src/agency-executor.js';

test('local FILTER policy requires explicit provenance and cannot relax proposer or validation', () => {
  const policy = { id: 'local-readonly-filter-v1', approvedBy: 'synthetic-user',
    approvedAt: now(), approvalRef: 'synthetic:approved-policy' };
  const scope = { role: 'filter', resultKind: 'analysis', allowPush: false };
  assert.deepEqual(validateFilterAnalysisPolicy(policy, scope), policy);
  for (const changed of [{ role: 'proposer' }, { role: 'collector' },
    { resultKind: 'validation' }, { allowPush: true }])
    assert.throws(() => validateFilterAnalysisPolicy(policy, { ...scope, ...changed }), /read-only FILTER scope/);
  for (const changed of [{ id: 'unknown' }, { approvedBy: '' }, { approvalRef: '' },
    { approvedAt: new Date(Date.now() + 86400000).toISOString() }])
    assert.throws(() => validateFilterAnalysisPolicy({ ...policy, ...changed }, scope));
});

function fixture(t, { analysis = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agency-offline-'));
  const config = configAt('pilot.example.json');
  config.stateDirectory = root; config.statePolicy.accessApproved = true;
  config.activation = { collect: true, review: true, dispatch: true };
  config.limits = { ...config.limits, maxWorkers: 1, maxAssignments: 1, maxItems: 100, maxCalls: 10, workerMaxToolCalls: 10 };
  config.repositories = [{ id: 'fixture', owner: 'fixture-owner', routingApproved: true,
    referenceCheckout: join(root, 'missing-reference'), remote: 'https://example.invalid/repository.git',
    baseRef: 'main', allowedWritePrefixes: ['src', 'test'],
    validationGates: analysis ? [] : [{ id: 'integration' }] }];
  const ledger = new Ledger(root);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const e = evidenceEnvelope('ado', 'fixture', '1', '1', 'https://example.invalid/bug/1',
    'synthetic query', '2026-10-09T00:00:00Z');
  // Authenticated-shaped fixture exercises the live-entry guards without any transport.
  e.source.provenance = 'authenticated-source';
  const evidence = ledger.evidence(e, { synthetic: true }, 'fixture-run');
  const investigation = { recordType: 'investigation', schemaVersion: '1.0', id: 'fixture-investigation',
    version: 1, evidenceIds: [evidence.id], state: 'triaged', observedBehavior: 'Synthetic behavior',
    expectedBehavior: 'Synthetic invariant', hypotheses: [], counterEvidence: [], classification: 'functional',
    defectConfirmation: 'unconfirmed', reportEligibility: 'included', handoffEligibility: 'eligible',
    exclusionReasons: [], rationale: 'Offline fixture', confidence: 1,
    review: { method: 'human-review', reviewer: 'fixture-owner', reviewedAt: now() },
    repoIds: ['fixture'], existingFixes: [], nextAction: 'Check the synthetic invariant' };
  ledger.put(investigation);
  const intent = analysis ? 'rca-only' : 'defect-fix';
  const local = makeAssignment(config, investigation, 'fixture', intent);
  const profile = { organization: 'fixture', project: 'fixture', repository: 'fixture', initMode: 'lite' };
  const prompt = 'Synthetic complete payload. No product data or real provider calls.';
  const caseContract = analysis ? { cases: [], scenarios: [], commands: [] } : {
    cases: [{ suite: 'test/integration.test.js', title: 'required invariant', status: 'passed' },
      { suite: 'test/integration.test.js', title: 'existing authored skip', status: 'skipped' }],
    scenarios: ['required-path'], commands: [
      { id: 'build', phase: 'build', command: 'fixture build', cwd: '.' },
      { id: 'integration', phase: 'test', command: 'fixture test --exact integration', cwd: '.' }
    ]
  };
  const selection = { taskId: local.id, repoId: 'fixture', role: 'proposer', suiteId: 'integration',
    profileId: 'fixture-profile', qualificationId: 'fixture-qualification', qualificationSha256: '',
    sourceRevision: 'a'.repeat(40), targetRef: 'refs/heads/main', payloadSha256: hash(prompt),
    instructionsSha256: hash('synthetic instruction bytes'), resultKind: analysis ? 'analysis' : 'validation',
    allowPush: !analysis, dispatchAllowed: true, maxExecutionSeconds: 600,
    allowedPaths: ['src', 'test'], forbiddenPaths: ['src/auth'], caseContract };
  const q = { status: 'qualified', binding: {
    repoId: selection.repoId, role: selection.role, suiteId: selection.suiteId, profileId: selection.profileId,
    profileSha256: hash(json(profile)), sourceRevision: selection.sourceRevision, targetRef: selection.targetRef,
    instructionsSha256: selection.instructionsSha256, caseContractSha256: hash(json(caseContract))
  }, runtime: { modelId: 'fixture-model', tokenizerId: 'fixture-tokenizer', contextTokens: 4096, maxOutputTokens: 1024 },
  expiresAt: new Date(Date.now() + 86400000).toISOString(), evidenceRef: 'private:synthetic-qualification' };
  selection.qualificationSha256 = hash(json(q)); ledger.qualify(selection.qualificationId, q);
  config.agency = { profiles: { 'fixture-profile': profile }, selections: [selection], budgetId: 'fixture-budget',
    maxRequests: 1, maxConcurrent: 1, maxDraftPullRequests: 1, maxExecutionSeconds: 600, preflightMaxAgeSeconds: 300,
    monitorOwner: 'fixture-owner', monitorCadenceSeconds: 60 };
  const assignment = makeAssignment(config, investigation, 'fixture', intent);
  const request = json({ organization: profile.organization, project: profile.project, repository: profile.repository,
    targetBranch: 'main', prompt, options: { allowPush: selection.allowPush, pullRequest: { create: false, publish: false } },
    metadata: { initMode: 'lite' } });
  const input = { request, requestSha256: hash(request), preflight: { repoId: 'fixture',
    targetRef: selection.targetRef, sourceRevision: selection.sourceRevision, observedAt: now(), requestSha256: hash(request) },
  tokenBudget: { payloadSha256: hash(prompt), modelId: q.runtime.modelId, tokenizerId: q.runtime.tokenizerId, inputTokens: 100 } };
  const submission = { operation: 'jobs-create', state: 'accepted', requestSha256: hash(request), jobId: 'fixture-job', httpStatus: 202, observedAt: now() };
  const refs = [{ ref: 'job-local:fixture-job:derived-proof', sha256: hash('synthetic derived proof') }];
  const output = analysis ? selection.sourceRevision : 'b'.repeat(40);
  const result = { requestSha256: hash(request), jobId: submission.jobId, observedAt: now(),
    provider: { state: 'Completed', result: 'Success' }, pipeline: { id: 'fixture-build', state: 'completed', result: 'succeeded' },
    runtime: { profileId: selection.profileId, instructionsSha256: selection.instructionsSha256,
      modelId: q.runtime.modelId, tokenizerId: q.runtime.tokenizerId },
    source: { repoId: 'fixture', targetRef: selection.targetRef, baseRevision: selection.sourceRevision,
      checkoutRevision: selection.sourceRevision, outputRevision: output, testedRevision: analysis ? null : output,
      commitParents: [selection.sourceRevision], changedPaths: analysis ? [] : ['test/integration.test.js'],
      unchangedDuringValidation: analysis ? null : true, evidenceRefs: refs },
    inspection: { approved: true, evidenceRefs: refs },
    publication: { pushPerformed: !analysis, createdPullRequests: analysis ? 0 : 1,
      otherPullRequestsModified: false, merged: false, pullRequest: analysis ? null : { url: 'https://example.invalid/pull/1',
      state: 'active', isDraft: true, autoComplete: null, headRevision: output, remoteRevision: output,
      targetRef: selection.targetRef, evidenceRefs: refs } },
    validation: analysis ? null : { commands: caseContract.commands.map(c => ({ ...c, exitCode: 0,
      sourceRevision: output, evidenceRefs: refs })),
    cases: caseContract.cases.map(c => ({ ...c, bodyExecuted: c.status === 'passed',
      invocations: c.status === 'passed' ? 1 : 0, retryCount: 0, evidenceRefs: refs })),
    scenarios: [{ id: 'required-path', preconditionVerified: true, pathActivated: true, evidenceRefs: refs }],
    assertionsPreserved: true },
    analysis: analysis ? { payloadSha256: selection.payloadSha256, resultSha256: hash('audited analysis'),
      validator: 'fixture-membership-validator', membershipValidated: true, evidenceRefs: refs } : null };
  return { root, config, ledger, evidence, investigation, local, assignment, selection, q, input, submission, result };
}
function reserve(f) {
  reserveAgencyRequest(f.config, f.ledger, f.selection.taskId, f.input);
  recordAgencySubmission(f.ledger, f.selection.taskId, f.submission);
}

test('Agency is per task/suite/profile, while local assignments and E2E stay local by default', t => {
  const f = fixture(t);
  assert.equal(f.local.execution, 'local');
  assert.equal(selectAgency(f.config, 'other-e2e-task'), null);
  assert.equal(f.assignment.execution, 'hosted');
  assert.notEqual(f.assignment.id, f.local.id);
  requireCurrentAssignment(f.config, f.ledger, f.investigation, f.assignment);
  f.selection.suiteId = 'e2e';
  assert.throws(() => requireAgencyQualification(f.config, f.ledger, f.selection.taskId), /exact repository/);
  assert.throws(() => requireCurrentAssignment(f.config, f.ledger, f.investigation, f.assignment), /changed/);
});

test('request is durable before injected transport and hosted dispatch never uses local model/provision/push', async t => {
  const f = fixture(t);
  f.ledger.prepare(f.assignment);
  let calls = 0;
  const receipt = await dispatch(f.config, f.ledger, f.assignment.id, {
    agencyRequest: f.input,
    agencyTransport: async bytes => {
      calls++;
      assert.equal(bytes, f.input.request);
      const persisted = inspectAgencyRequest(f.ledger, f.selection.taskId);
      assert.equal(persisted.request, bytes);
      assert.equal(persisted.submissionState, 'uncertain');
      return f.submission;
    },
    runModel: () => assert.fail('local model must not run'),
    pushBranch: () => assert.fail('local push must not run'),
    createDraft: () => assert.fail('local PR creation must not run')
  });
  assert.equal(receipt.submissionState, 'accepted'); assert.equal(calls, 1);
  assert.equal(existsSync(join(f.root, 'workspaces')), false);
  assert.equal(f.ledger.job(f.assignment.id).workspace, null);
  const completed = reconcileHostedAssignment(f.ledger, f.assignment.id, f.result);
  assert.equal(completed.result.outcome, 'draft-pr-validated');
  assert.equal(completed.verdict.validationQualified, true);
  assert.equal(f.ledger.job(f.assignment.id).state, 'completed');
  assert.deepEqual(reconcileHostedAssignment(f.ledger, f.assignment.id, f.result), completed);
  await assert.rejects(dispatch(f.config, f.ledger, f.assignment.id), /never-dispatched/);
});

test('uncertain POST stays latched across restart and cannot fall back or resubmit', async t => {
  const f = fixture(t);
  f.ledger.prepare(f.assignment);
  let calls = 0;
  const dependencies = { agencyRequest: f.input, agencyTransport: async () => { calls++; throw Error('timeout'); } };
  const result = await dispatch(f.config, f.ledger, f.assignment.id, dependencies);
  assert.equal(result.submissionState, 'uncertain'); assert.equal(result.submission.jobId, null);
  const reopened = new Ledger(f.root);
  try {
    assert.equal(inspectAgencyRequest(reopened, f.selection.taskId).submissionState, 'uncertain');
    assert.throws(() => reserveAgencyRequest(f.config, reopened, f.selection.taskId, f.input), /never resubmit/);
    await assert.rejects(dispatch(f.config, reopened, f.assignment.id, dependencies), /never-dispatched/);
    assert.throws(() => reconcileAgencyResult(reopened, f.selection.taskId, f.result), /unbound/);
  } finally { reopened.close(); }
  assert.equal(calls, 1);
});

test('crash after reservation with no POST receipt remains uncertain and immutable', t => {
  const f = fixture(t);
  reserveAgencyRequest(f.config, f.ledger, f.selection.taskId, f.input);
  const reopened = new Ledger(f.root);
  try {
    assert.equal(inspectAgencyRequest(reopened, f.selection.taskId).submissionState, 'uncertain');
    assert.throws(() => reserveAgencyRequest(f.config, reopened, f.selection.taskId, f.input), /already reserved/);
    assert.throws(() => reopened.db.prepare('UPDATE agency_requests SET body=?').run('{}'), /immutable/);
  } finally { reopened.close(); }
});

test('hosted dispatch with no approved transport does not provision or consume request budget', async t => {
  const f = fixture(t); f.ledger.prepare(f.assignment);
  await assert.rejects(dispatch(f.config, f.ledger, f.assignment.id), /no local fallback/);
  assert.equal(f.ledger.job(f.assignment.id).state, 'prepared');
  assert.equal(inspectAgencyRequest(f.ledger, f.selection.taskId), null);
});

for (const [name, mutate, pattern] of [
  ['changed payload', f => { const wire = JSON.parse(f.input.request); wire.prompt += ' extra'; f.input.request = json(wire);
    f.input.requestSha256 = hash(f.input.request); }, /qualified payload/],
  ['stale ref preflight', f => { f.input.preflight.sourceRevision = 'c'.repeat(40); }, /exact-source/],
  ['token overflow', f => { f.input.tokenBudget.inputTokens = 4096; }, /budget/],
  ['unknown tokenizer', f => { f.input.tokenBudget.tokenizerId = 'unknown'; }, /budget/],
  ['raw wire override', f => { const wire = JSON.parse(f.input.request); wire.modelConfiguration = {};
    f.input.request = json(wire); f.input.requestSha256 = hash(f.input.request); }, /undeclared/],
  ['unapproved task', f => { f.selection.dispatchAllowed = false; }, /authorized/],
  ['changed qualification', f => { f.ledger.qualify(f.selection.qualificationId, { ...f.q, status: 'unknown' }); }, /qualification/]
]) test(`reservation rejects ${name} before consuming the latch`, t => {
  const f = fixture(t); mutate(f);
  assert.throws(() => reserveAgencyRequest(f.config, f.ledger, f.selection.taskId, f.input), pattern);
  assert.equal(inspectAgencyRequest(f.ledger, f.selection.taskId), null);
});

for (const [name, mutate] of [
  ['Completed without positive result', r => { r.provider.result = null; }],
  ['provider failure with green pipeline', r => { r.provider.result = 'Failure'; }],
  ['unknown provider state', r => { r.provider.state = 'Finished'; }],
  ['pipeline policy status without run', r => { r.pipeline.id = null; }],
  ['wrong checkout source', r => { r.source.checkoutRevision = 'c'.repeat(40); }],
  ['different tested source', r => { r.source.testedRevision = 'c'.repeat(40); }],
  ['output without ancestry', r => { r.source.commitParents = []; }],
  ['forbidden path edits', r => { r.source.changedPaths = ['src/auth/credentials.js']; }],
  ['wrong PR head', r => { r.publication.pullRequest.headRevision = 'c'.repeat(40); }],
  ['ready PR', r => { r.publication.pullRequest.isDraft = false; }],
  ['closed PR', r => { r.publication.pullRequest.state = 'completed'; }],
  ['autocomplete set', r => { r.publication.pullRequest.autoComplete = 'enabled'; }],
  ['extra PR mutation', r => { r.publication.otherPullRequestsModified = true; }],
  ['more than one draft', r => { r.publication.createdPullRequests = 2; }],
  ['runtime mismatch', r => { r.runtime.modelId = 'different'; }],
  ['uninspected export', r => { r.inspection.approved = false; }],
  ['missing validation', r => { r.validation = null; }],
  ['green with no cases', r => { r.validation.cases = []; }],
  ['extra skip', r => { r.validation.cases[0].status = 'skipped'; }],
  ['case body not executed', r => { r.validation.cases[0].bodyExecuted = false; }],
  ['retried case', r => { r.validation.cases[0].retryCount = 1; }],
  ['failed command', r => { r.validation.commands[0].exitCode = 1; }],
  ['missing command', r => { r.validation.commands.pop(); }],
  ['missing coverage', r => { r.validation.scenarios = []; }],
  ['precondition unproven', r => { r.validation.scenarios[0].preconditionVerified = null; }],
  ['path not activated', r => { r.validation.scenarios[0].pathActivated = false; }],
  ['weakened assertions', r => { r.validation.assertionsPreserved = false; }]
]) test(`strict terminal reconciliation blocks ${name}`, t => {
  const f = fixture(t); reserve(f); mutate(f.result);
  const verdict = reconcileAgencyResult(f.ledger, f.selection.taskId, f.result);
  assert.equal(verdict.state, 'blocked'); assert.equal(verdict.validationQualified, false);
  assert.ok(verdict.reasons.length > 0);
});

test('raw test exports and non-job-local evidence are rejected rather than retained', t => {
  const f = fixture(t); reserve(f);
  f.result.validation.rawResults = { stdout: 'not allowed' };
  assert.throws(() => reconcileAgencyResult(f.ledger, f.selection.taskId, f.result), /raw output/);
  delete f.result.validation.rawResults;
  f.result.inspection.evidenceRefs = [{ ref: 'https://example.invalid/raw-jest.json', sha256: hash('raw') }];
  assert.throws(() => reconcileAgencyResult(f.ledger, f.selection.taskId, f.result), /job-local/);
  assert.equal(inspectAgencyRequest(f.ledger, f.selection.taskId).terminal, null);
});

test('analysis results bind full payload and membership without claiming test coverage', t => {
  const f = fixture(t, { analysis: true }); reserve(f);
  recordAgencyAnalysisCheck(f.ledger, f.selection.taskId, 'audited analysis', bytes => ({
    state: 'checked-not-qualified', payloadSha256: f.selection.payloadSha256,
    resultSha256: hash(bytes), validator: 'fixture-membership-validator'
  }));
  const verdict = reconcileAgencyResult(f.ledger, f.selection.taskId, f.result);
  assert.equal(verdict.state, 'completed'); assert.equal(verdict.analysisPassed, true);
  assert.equal(verdict.validationQualified, false); assert.equal(verdict.testsPassed, false);
});

test('analysis author self-attestation cannot replace the local membership validator', t => {
  const f = fixture(t, { analysis: true }); reserve(f);
  const verdict = reconcileAgencyResult(f.ledger, f.selection.taskId, f.result);
  assert.equal(verdict.state, 'blocked'); assert.equal(verdict.analysisPassed, false);
});

test('analysis with allowPush false forbids publication and unknown side effects', t => {
  const f = fixture(t, { analysis: true }); reserve(f);
  f.result.publication.pushPerformed = null;
  assert.equal(reconcileAgencyResult(f.ledger, f.selection.taskId, f.result).state, 'blocked');
});

test('app-native hosted path shares assignment budget/claim CAS without local project or workspace', t => {
  const f = fixture(t);
  f.config.limits.maxAssignments = 2;
  f.config.repositories[0].projectId = 'fixture-local-project';
  beginApp(f.config, { runId: 'agency-run', dryRun: false, provenance: 'app-tool' });
  const { ledger } = openApp(f.config, 'agency-run', false);
  ledger.put(f.evidence); ledger.put(f.investigation); ledger.qualify(f.selection.qualificationId, f.q);
  const prepared = appWorker(f.config, ledger, 'agency-run', 'prepare', {
    investigationId: f.investigation.id, repoId: 'fixture', intent: 'defect-fix'
  });
  assert.equal(prepared.projectId, null); assert.equal(prepared.execution, 'agency');
  assert.equal(ledger.db.prepare('SELECT COUNT(*) n FROM assignment_budgets').get().n, 1);
  const claim = { assignmentId: prepared.id, claimId: 'fixture-claim', coordinatorAgentId: f.config.agent.id };
  appWorker(f.config, ledger, 'agency-run', 'claim', claim);
  const secondInvestigation = { ...f.investigation, id: 'another-investigation' };
  ledger.put(secondInvestigation);
  const local = appWorker(f.config, ledger, 'agency-run', 'prepare', {
    investigationId: secondInvestigation.id, repoId: 'fixture', intent: 'rca-only'
  });
  assert.equal(local.execution, 'external-app-native-session');
  assert.throws(() => appWorker(f.config, ledger, 'agency-run', 'claim', {
    assignmentId: local.id, claimId: 'local-claim', coordinatorAgentId: f.config.agent.id
  }), /worker cap/);
  assert.throws(() => appWorker(f.config, ledger, 'agency-run', 'claim', { ...claim, claimId: 'other' }), /already claimed/);
  assert.throws(() => appWorker(f.config, ledger, 'agency-run', 'bind', claim), /cannot bind/);
  const reserved = appWorker(f.config, ledger, 'agency-run', 'agency-reserve', { ...claim, agencyRequest: f.input });
  assert.equal(reserved.state, 'uncertain');
  assert.throws(() => appWorker(f.config, ledger, 'agency-run', 'agency-reserve', { ...claim, agencyRequest: f.input }), /freshly claimed/);
  appWorker(f.config, ledger, 'agency-run', 'agency-submission', { ...claim, agencySubmission: f.submission });
  const result = appWorker(f.config, ledger, 'agency-run', 'agency-result', { ...claim, agencyResult: f.result });
  assert.equal(result.state, 'completed'); assert.equal(result.validationQualified, true);
  assert.equal(ledger.job(prepared.id).workspace, null);
  ledger.close();
});

test('shared hosted request and draft budgets are durable across connections', t => {
  const f = fixture(t); reserve(f);
  const next = structuredClone(f.selection); next.taskId = 'second-task';
  f.config.agency.selections.push(next);
  const reopened = new Ledger(f.root);
  try {
    assert.throws(() => reserveAgencyRequest(f.config, reopened, next.taskId, f.input), /request budget/);
    f.config.agency.maxRequests = 2;
    assert.throws(() => reserveAgencyRequest(f.config, reopened, next.taskId, f.input), /draft budget/);
  } finally { reopened.close(); }
});

function estimatedFilter(f) {
  f.selection.role = 'filter';
  f.q.binding.role = 'filter';
  f.selection.captureVerification = { protocol: 'filter-capture-verification-v1', verifierSha256: hash('synthetic verifier'),
    pipelineDefinitionId: 'synthetic-definition', stepName: 'SyntheticCaptureGate',
    pipelineSourceRevision: 'a'.repeat(40), bootstrapSha256: hash('synthetic bootstrap') };
  f.q.binding.captureVerification = f.selection.captureVerification;
  const wire = JSON.parse(f.input.request);
  f.selection.analysisPayloadSha256 = hash(wire.prompt);
  wire.prompt = json({ payloadSha256: hash(wire.prompt), payload: wire.prompt });
  f.selection.payloadSha256 = hash(wire.prompt);
  f.input.request = json(wire); f.input.requestSha256 = hash(f.input.request);
  f.input.preflight.requestSha256 = f.input.requestSha256;
  f.submission.requestSha256 = f.input.requestSha256; f.result.requestSha256 = f.input.requestSha256;
  f.q.runtime = { modelId: 'fixture-model', tokenizerId: null, contextTokens: null, maxOutputTokens: null,
    estimation: { approvalId: 'bounded-fixture-trial', approvedBy: 'fixture-user', approvedAt: now(),
      accountingMethod: 'utf8-byte-conservative-estimate-v1', planningCap: 1000, maxInputTokens: 500,
      instructionReserve: 100, codeReserve: 100, outputReserve: 100, safetyReserve: 100, requestOverheadReserve: 100,
      uncertainty: 'Estimated byte units; deployed framing and tokenizer unknown', maxConcurrent: 2 } };
  f.selection.qualificationSha256 = hash(json(f.q));
  f.ledger.qualify(f.selection.qualificationId, f.q);
  f.config.limits.maxWorkers = 2;
  f.config.agency.maxConcurrent = 2; f.config.agency.maxRequests = 3;
  f.input.tokenBudget = { mode: 'estimated', payloadSha256: f.selection.payloadSha256,
    modelId: f.q.runtime.modelId, tokenizerId: null, inputTokens: Buffer.byteLength(JSON.parse(f.input.request).prompt, 'utf8'),
    approvalId: f.q.runtime.estimation.approvalId, accountingMethod: f.q.runtime.estimation.accountingMethod,
    uncertainty: f.q.runtime.estimation.uncertainty };
  f.result.runtime.tokenizerId = null;
}

function runnerFilter(f) {
  estimatedFilter(f);
  Object.assign(f.selection.captureVerification, { inputEvidenceKind: 'source-bound-stdin-digest-v1',
    agentProfileSha256: hash('synthetic reader profile\n'), sourceAttestationStepName: 'AgencyFilterSourceAttestation' });
  f.selection.qualificationSha256 = hash(json(f.q)); f.ledger.qualify(f.selection.qualificationId, f.q);
  const wire = JSON.parse(f.input.request);
  Object.assign(wire, { sourceBranch: 'refs/heads/main', targetBranch: 'refs/heads/main',
    agent: { name: 'filter-evidence-reader', type: 'Repo' }, metadata: agencyFilterRunnerMetadata(f.selection) });
  wire.options.branch = { createSourceBranch: false };
  return wire;
}
function setRequest(f, wire) {
  f.input.request = json(wire); f.input.requestSha256 = hash(f.input.request);
  f.input.preflight.requestSha256 = f.input.requestSha256;
}

test('qualified FILTER runner admits only its exact repo-agent and protected capture metadata', t => {
  const f = fixture(t, { analysis: true }), wire = runnerFilter(f); setRequest(f, wire);
  const reserved = reserveAgencyRequest(f.config, f.ledger, f.selection.taskId, f.input);
  assert.equal(JSON.parse(reserved.request).agent.name, 'filter-evidence-reader');
  assert.equal(JSON.parse(reserved.request).metadata.agentProfileDigest, f.selection.captureVerification.agentProfileSha256);
  assert.ok(Object.values(wire.metadata).every(value => typeof value === 'string'));
  assert.equal(reserved.selection.captureVerification.inputEvidenceKind, 'source-bound-stdin-digest-v1');
});

for (const [name, mutate] of [
  ['agent', wire => { wire.agent.name = 'other-agent'; }],
  ['agent type', wire => { wire.agent.type = 'Plugin'; }],
  ['source branch', wire => { wire.sourceBranch = 'refs/heads/other'; }],
  ['short target ref', wire => { wire.targetBranch = 'main'; }],
  ['branch creation', wire => { wire.options.branch.createSourceBranch = true; }],
  ['model override', wire => { wire.model = 'unqualified'; }],
  ['plugin override', wire => { wire.agent.pluginName = 'unqualified'; }],
  ['pipeline override', wire => { wire.pipeline = 'unqualified'; }],
  ['extra metadata', wire => { wire.metadata.sourceJobAttempt = '1'; }],
  ...['trustProfile', 'expectedAgent', 'expectedProtectedSourceSha', 'agentProfileDigest', 'requestDigest',
    'captureProtocol', 'captureVerifierSha256', 'captureAnalysisPayloadSha256', 'captureRepoId',
    'capturePipelineSourceRevision', 'captureBootstrapSha256', 'copilotTaskWaitTimeoutSeconds']
    .map(key => [key, wire => { wire.metadata[key] = 'unqualified'; }]),
  ['numeric duration metadata', wire => { wire.metadata.copilotTaskWaitTimeoutSeconds = 600; }]
]) test(`qualified FILTER runner rejects changed ${name} before reservation`, t => {
  const f = fixture(t, { analysis: true }), wire = runnerFilter(f); mutate(wire); setRequest(f, wire);
  assert.throws(() => reserveAgencyRequest(f.config, f.ledger, f.selection.taskId, f.input),
    /Invalid Agency derived contract|differs from/);
  assert.equal(inspectAgencyRequest(f.ledger, f.selection.taskId), null);
});

test('digest input and reader-profile pins cannot be added without requalification', t => {
  const f = fixture(t, { analysis: true }); estimatedFilter(f);
  f.selection.captureVerification = { ...f.selection.captureVerification,
    inputEvidenceKind: 'source-bound-stdin-digest-v1', agentProfileSha256: hash('new reader'),
    sourceAttestationStepName: 'AgencyFilterSourceAttestation' };
  assert.throws(() => requireAgencyQualification(f.config, f.ledger, f.selection.taskId), /does not cover/);
});

test('FILTER runner task-wait metadata enforces the inclusive supported integer range', t => {
  const f = fixture(t, { analysis: true }); runnerFilter(f);
  for (const seconds of [300, 14100])
    assert.equal(agencyFilterRunnerMetadata({ ...f.selection, maxExecutionSeconds: seconds })
      .copilotTaskWaitTimeoutSeconds, String(seconds));
  for (const seconds of [299, 14101, 600.5])
    assert.throws(() => agencyFilterRunnerMetadata({ ...f.selection, maxExecutionSeconds: seconds }), /300..14100/);
  assert.throws(() => agencyFilterRunnerMetadata({ ...f.selection, analysisPayloadSha256: undefined }), /complete source/);
});

test('explicit estimated FILTER approval keeps provider capacity unknown and caps concurrency at two', t => {
  const f = fixture(t, { analysis: true }); estimatedFilter(f);
  const a = reserveAgencyRequest(f.config, f.ledger, f.selection.taskId, f.input);
  assert.equal(a.runtime.contextTokens, null); assert.equal(a.runtime.tokenizerId, null);
  assert.equal(a.tokenBudget.mode, 'estimated');
  for (const id of ['second-filter', 'third-filter']) f.config.agency.selections.push({ ...f.selection, taskId: id });
  reserveAgencyRequest(f.config, f.ledger, 'second-filter', f.input);
  assert.throws(() => reserveAgencyRequest(f.config, f.ledger, 'third-filter', f.input), /concurrency budget/);
});

for (const [name, mutate] of [
  ['missing capture contract', f => { delete f.selection.captureVerification; delete f.q.binding.captureVerification; }],
  ['changed capture contract', f => { f.selection.captureVerification = { ...f.selection.captureVerification,
    verifierSha256: '0'.repeat(64) }; }],
  ['digest mode without profile pin', f => {
    f.selection.captureVerification.inputEvidenceKind = 'source-bound-stdin-digest-v1';
  }],
  ['digest mode without post-analysis source step', f => {
    Object.assign(f.selection.captureVerification, { inputEvidenceKind: 'source-bound-stdin-digest-v1',
      agentProfileSha256: hash('synthetic profile') });
  }],
  ['unsupported input evidence kind', f => {
    Object.assign(f.selection.captureVerification, { inputEvidenceKind: 'model-attestation',
      agentProfileSha256: hash('synthetic profile') });
  }],
  ['missing approval', f => { delete f.q.runtime.estimation; }],
  ['non-FILTER exception', f => { f.selection.role = 'proposer'; f.q.binding.role = 'proposer'; }],
  ['fake verified capacity', f => { f.q.runtime.contextTokens = 400000; }],
  ['changed estimator', f => { f.input.tokenBudget.accountingMethod = 'chars-divided-by-four'; }],
  ['unmeasured units', f => { f.input.tokenBudget.inputTokens = 1; }],
  ['cap without reserves', f => { f.q.runtime.estimation.planningCap = f.input.tokenBudget.inputTokens; }],
  ['input over explicit cap', f => { f.q.runtime.estimation.maxInputTokens = f.input.tokenBudget.inputTokens - 1; }],
  ['higher concurrency', f => { f.config.agency.maxConcurrent = 3; }]
]) test(`estimated FILTER trial rejects ${name}`, t => {
  const f = fixture(t, { analysis: true }); estimatedFilter(f); mutate(f);
  f.selection.qualificationSha256 = hash(json(f.q)); f.ledger.qualify(f.selection.qualificationId, f.q);
  assert.throws(() => reserveAgencyRequest(f.config, f.ledger, f.selection.taskId, f.input));
  assert.equal(inspectAgencyRequest(f.ledger, f.selection.taskId), null);
});

test('validation-only response is not an accepted job even with 2xx and a would-be UUID', t => {
  const f = fixture(t); reserveAgencyRequest(f.config, f.ledger, f.selection.taskId, f.input);
  assert.throws(() => recordAgencySubmission(f.ledger, f.selection.taskId, { ...f.submission, operation: 'jobs-validate' }),
    /validation-only/);
  assert.equal(inspectAgencyRequest(f.ledger, f.selection.taskId).submissionState, 'uncertain');
});

for (const state of ['uncertain', 'rejected']) test(`${state} POST stops remaining requests in the approved trial`, t => {
  const f = fixture(t, { analysis: true }); estimatedFilter(f);
  reserveAgencyRequest(f.config, f.ledger, f.selection.taskId, f.input);
  recordAgencySubmission(f.ledger, f.selection.taskId, { ...f.submission, state, jobId: null,
    httpStatus: state === 'rejected' ? 400 : null });
  f.config.agency.selections.push({ ...f.selection, taskId: 'next-filter' });
  assert.throws(() => reserveAgencyRequest(f.config, f.ledger, 'next-filter', f.input), /stopped this Agency budget/);
});

test('FILTER envelope delivers the inner hash while budget and request bind exact outer bytes', t => {
  const f = fixture(t, { analysis: true }); estimatedFilter(f);
  const wire = JSON.parse(f.input.request), inner = wire.prompt;
  f.selection.analysisPayloadSha256 = hash(inner);
  wire.prompt = JSON.stringify({ payloadSha256: hash(inner), payload: inner }, null, 2) + '\n';
  f.selection.payloadSha256 = hash(wire.prompt);
  f.input.request = json(wire); f.input.requestSha256 = hash(f.input.request);
  f.input.preflight.requestSha256 = f.input.requestSha256;
  f.input.tokenBudget.payloadSha256 = hash(wire.prompt);
  f.input.tokenBudget.inputTokens = Buffer.byteLength(wire.prompt, 'utf8');
  f.submission.requestSha256 = f.input.requestSha256; f.result.requestSha256 = f.input.requestSha256;
  reserve(f);
  const reserved = inspectAgencyRequest(f.ledger, f.selection.taskId);
  assert.equal(reserved.selection.analysisPayloadSha256, hash(inner));
  assert.equal(reserved.selection.payloadSha256, hash(wire.prompt));
  assert.notEqual(reserved.selection.payloadSha256, reserved.selection.analysisPayloadSha256);
});
