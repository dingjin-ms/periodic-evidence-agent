import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';
import { configAt, hash, json, now } from '../src/common.js';
import { evidenceEnvelope } from '../src/sources.js';
import { recordAreaToImprove, recordTestCoveragePlan } from '../src/improvements.js';
import { makeAssignment, makePlannedImprovementAssignment, requireCurrentAssignment } from '../src/workers.js';
import { repositoryValidationContract, skillQualificationId } from '../src/repository-skills.js';

function setup(t, state = 'Resolved', resolution = 'Fixed', fixes = [], kind = 'ado') {
  const root = mkdtempSync(join(tmpdir(), 'improvement-planner-'));
  const ledger = new Ledger(join(root, 'state'));
  const config = configAt('pilot.example.json');
  config.limits = { ...config.limits, maxItems: 100, workerMaxToolCalls: 20 };
  config.repositories = [{
    id: 'office-src', projectId: 'oa-project', owner: 'oa-owner', routingApproved: true,
    routingRules: ['Office Agent integration tests'], referenceCheckout: join(root, 'oa-reference'),
    baseRef: 'main', remote: 'https://dev.azure.com/example/project/_git/OfficeAgent',
    allowedWritePrefixes: ['test'], commitIdentity: { name: 'Fixture', email: 'fixture@example.invalid' },
    validationGates: [{ id: 'oa-test', approved: true, executable: process.execPath, args: [], timeoutMs: 1000 }],
    skillBindings: [{
      id: 'oa-integration-test-core', capability: 'integration-test-authoring',
      skillPath: 'docs/skills/Integration-test-core/SKILL.md', enabled: true, qualification: 'qualified',
      requestedOutcomes: ['add-or-update-tests'],
      allowedWritePrefixes: ['test'], requiresBehaviorCard: true,
      sideEffects: { commit: false, push: false, createDraftPR: false }
    }]
  }];
  const evidence = evidenceEnvelope(kind, 'office/OC', '42', '1',
    'https://example.invalid/ado/42', 'fixture', now());
  evidence.source.provenance = 'authenticated-source';
  evidence.sourceStatus = state;
  evidence.fields = { 'System.State': state, 'Microsoft.VSTS.Common.ResolvedReason': resolution };
  evidence.links = fixes.map(url => ({ url, relation: 'ArtifactLink',
    evidenceId: null, access: 'not-followed-out-of-scope' }));
  evidence.capture = { artifactRef: null, sha256: null, unavailableReason: 'Fixture' };
  evidence.id = `ev-${hash(json(['fixture', 42]))}`;
  ledger.put(evidence);
  const investigation = {
    recordType: 'investigation', schemaVersion: '1.0',
    id: `investigation-${hash(json([evidence.source.namespace, evidence.source.recordId]))}`, version: 1,
    evidenceIds: [evidence.id], state: 'triaged', observedBehavior: 'An established OA behavior lacks regression coverage.',
    expectedBehavior: 'The established behavior remains covered by an integration test.',
    hypotheses: [], counterEvidence: [], classification: 'functional', defectConfirmation: 'unconfirmed',
    reportEligibility: 'included', handoffEligibility: 'eligible', exclusionReasons: [],
    rationale: 'The evidence describes existing behavior and a test coverage improvement.', confidence: 0.9,
    review: { method: config.reviewMethod, reviewer: 'fixture', reviewedAt: now() },
    repoIds: ['office-src'], existingFixes: fixes, nextAction: 'Add or link focused integration coverage.'
  };
  ledger.put(investigation);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, ledger, config, evidence, investigation };
}

function improvementInput(investigation) {
  return {
    investigationIds: [investigation.id], category: 'missing-test-coverage',
    theme: 'OA established behavior integration coverage',
    observedBehavior: investigation.observedBehavior, expectedBehavior: investigation.expectedBehavior,
    rationale: 'Multiple reports of this behavior should resolve to one durable improvement.',
    priority: 'medium', repoIds: ['office-src'], capabilities: ['integration-test-authoring']
  };
}

function planned(s, overrides = {}, assign = true) {
  const improvement = recordAreaToImprove(s.ledger, improvementInput(s.investigation));
  const plan = recordTestCoveragePlan(s.ledger, {
    improvementId: improvement.id, improvementVersion: improvement.version,
    repoId: 'office-src', capability: 'integration-test-authoring',
    sourceRevision: 'a'.repeat(40), searchStatus: 'complete', existingTests: [],
    coverageGaps: ['Missing regression assertion'], unknowns: [], rationale: 'Synthetic source-bound search',
    ...overrides
  });
  const repo = s.config.repositories[0], binding = repo.skillBindings[0];
  const contract = repositoryValidationContract(repo);
  s.ledger.qualify(skillQualificationId(repo.id, binding.id), {
    state: 'qualified-read-only', repoId: repo.id, bindingId: binding.id,
    capability: binding.capability, remote: repo.remote, baseRef: repo.baseRef,
    baseRevision: plan.sourceRevision, skillPath: binding.skillPath, skillSha256: 'd'.repeat(64),
    qualificationSource: 'local-reference',
    validationContractVersion: contract.version, validationContractSha256: contract.sha256,
    sideEffects: binding.sideEffects
  });
  return { plan, assignment: assign
    ? makePlannedImprovementAssignment(s.config, s.ledger, s.investigation, plan.id) : null };
}

function existingFixFixture(t, kind = 'ado') {
  const fixes = ['https://example.invalid/product/pull/42', 'https://example.invalid/product/pull/43'];
  const s = setup(t, kind === 'ado' ? 'Resolved' : 'active', 'Fixed', fixes, kind);
  const { plan } = planned(s, {}, false);
  const receipt = {
    investigationId: s.investigation.id, investigationVersion: s.investigation.version,
    evidenceIds: s.investigation.evidenceIds, planId: plan.id, planVersion: plan.version + 1,
    sourceRevision: plan.sourceRevision,
    review: { method: s.config.reviewMethod, reviewer: 'synthetic-coverage-agent', reviewedAt: now() },
    fixes: fixes.map(url => ({ url, disposition: 'product-fix-with-remaining-coverage-gap',
      rationale: 'The landed product fix restores behavior; the exact-source test inventory still lacks the requested regression assertion.' }))
  };
  return { ...s, fixes, plan, receipt,
    save: review => recordTestCoveragePlan(s.ledger, { ...plan, existingFixesReview: review }) };
}

test('a landed product fix can retain its URL and reach qualified test-only work after exact-source reconciliation', t => {
  const s = existingFixFixture(t);
  assert.throws(() => makePlannedImprovementAssignment(s.config, s.ledger, s.investigation, s.plan.id),
    /Existing fix requires/);
  const reconciled = s.save(s.receipt);
  assert.equal(reconciled.version, 2);
  assert.deepEqual(s.save(s.receipt), reconciled);
  const assignment = makePlannedImprovementAssignment(s.config, s.ledger, s.investigation, reconciled.id);
  assert.deepEqual(requireCurrentAssignment(s.config, s.ledger, s.investigation, assignment), assignment);
  assert.deepEqual(s.ledger.get('investigation', s.investigation.id).existingFixes, s.fixes);
  assert.deepEqual(s.ledger.get('evidence', s.evidence.id).links.map(link => link.url), s.fixes);
  for (const intent of ['rca-only', 'defect-fix', 'improvement'])
    assert.throws(() => makeAssignment(s.config, s.investigation, 'office-src', intent), /Existing fix requires/);
  const update = { ...s.investigation, version: 2, rationale: 'New review after product change' };
  s.ledger.put(update);
  assert.throws(() => requireCurrentAssignment(s.config, s.ledger, update, assignment),
    /superseded/);
});

test('existing-fix review rejects missing, duplicate, mismatched, stale and unknown bindings before persistence', t => {
  const mutations = [
    r => { delete r.planId; },
    r => { r.unrecognized = true; },
    r => { r.fixes[0].unrecognized = true; },
    r => { r.planId = 'wrong'; },
    r => { r.planVersion++; },
    r => { r.sourceRevision = 'b'.repeat(40); },
    r => { r.investigationId = 'wrong'; },
    r => { r.investigationVersion++; },
    r => { r.evidenceIds = ['missing']; },
    r => { r.evidenceIds.push(r.evidenceIds[0]); },
    r => { r.fixes.pop(); },
    r => { r.fixes[0].url = 'https://example.invalid/unrelated'; },
    r => { r.fixes[1] = { ...r.fixes[0], rationale: 'Different text does not make a URL unique' }; },
    r => { r.fixes[0].disposition = 'approved'; },
    r => { r.fixes[0].rationale = ' '; },
    r => { r.review.reviewer = ' '; },
    r => { r.review.reviewedAt = '2000-01-01T00:00:00Z'; },
    r => { r.review.reviewedAt = '2999-01-01T00:00:00Z'; },
    r => { r.review.method = 'human-review'; }
  ];
  for (const mutate of mutations) {
    const s = existingFixFixture(t), receipt = structuredClone(s.receipt);
    mutate(receipt);
    assert.throws(() => s.save(receipt), error => ['invalid-record', 'blocked-reconciliation'].includes(error.code));
    assert.equal(s.ledger.all('testCoveragePlan').length, 1);
    assert.deepEqual(s.ledger.get('investigation', s.investigation.id).existingFixes, s.fixes);
  }
  const invalid = existingFixFixture(t);
  assert.throws(() => invalid.save(null), error => error.code === 'invalid-record');
});

test('satisfied, in-flight and unresolved existing test work stays blocked with its review preserved', t => {
  for (const disposition of ['coverage-already-satisfied', 'coverage-in-flight', 'unresolved']) {
    const s = existingFixFixture(t);
    s.receipt.fixes[0].disposition = disposition;
    const plan = s.save(s.receipt);
    assert.equal(plan.existingFixesReview.fixes[0].disposition, disposition);
    assert.throws(() => makePlannedImprovementAssignment(s.config, s.ledger, s.investigation, plan.id),
      /no duplicate test work/);
  }
});

test('product-fix reconciliation cannot authorize non-ADO test work outside the regression cohort', t => {
  const s = existingFixFixture(t, 'workiq');
  const plan = s.save(s.receipt);
  const assignment = makePlannedImprovementAssignment(s.config, s.ledger, s.investigation, plan.id);
  assert.throws(() => requireCurrentAssignment(s.config, s.ledger, s.investigation, assignment),
    /limited to the ADO regression cohort/);
});

test('all four resolved cohort combinations qualify only for current bounded test-coverage work', t => {
  for (const state of ['Resolved', 'Closed']) for (const resolution of ['Fixed', 'Duplicate']) {
    const s = setup(t, state, resolution), { assignment } = planned(s);
    assert.deepEqual(requireCurrentAssignment(s.config, s.ledger, s.investigation, assignment), assignment);
    s.ledger.setTrackedState(s.evidence, 'current', 'Unchanged approved cohort');
    assert.deepEqual(requireCurrentAssignment(s.config, s.ledger, s.investigation, assignment), assignment);
    for (const intent of ['rca-only', 'defect-fix', 'improvement']) {
      const generic = makeAssignment(s.config, s.investigation, 'office-src', intent);
      assert.throws(() => requireCurrentAssignment(s.config, s.ledger, s.investigation, generic),
        /only for qualified, bounded test-coverage/);
    }
    s.ledger.setTrackedState(s.evidence, 'reconciliation-required', 'Unresolved canonical ownership');
    assert.throws(() => requireCurrentAssignment(s.config, s.ledger, s.investigation, assignment),
      /tracked eligibility/);
  }
});

test('noncohort resolutions, ambiguous coverage, missing qualification and source drift cannot use the test-only exception', t => {
  for (const [state, resolution] of [['Active', 'Fixed'], ['Removed', 'Duplicate'],
    ['Closed', 'By Design'], ['Resolved', null]]) {
    const s = setup(t, state, resolution), { assignment } = planned(s);
    assert.throws(() => requireCurrentAssignment(s.config, s.ledger, s.investigation, assignment),
      error => error.code === 'blocked-scope');
  }
  for (const overrides of [{ unknowns: ['Canonical ownership unknown'] },
    { searchStatus: 'partial' }, { coverageGaps: [], existingTests: [{ path: 'test/covered.js', identifier: 'already covered' }] }]) {
    const s = setup(t), { assignment } = planned(s, overrides);
    assert.throws(() => requireCurrentAssignment(s.config, s.ledger, s.investigation, assignment),
      /complete source-bound coverage gap/);
  }
  const s = setup(t), { assignment, plan } = planned(s);
  s.config.repositories[0].skillBindings[0].qualification = 'unqualified';
  assert.throws(() => requireCurrentAssignment(s.config, s.ledger, s.investigation, assignment), /unqualified/);
  s.config.repositories[0].skillBindings[0].qualification = 'qualified';
  const missing = setup(t);
  assert.throws(() => makePlannedImprovementAssignment(missing.config, missing.ledger, missing.investigation, plan.id),
    /Unknown test coverage plan/);
  s.ledger.qualify(skillQualificationId('office-src', 'oa-integration-test-core'), { state: 'blocked' });
  assert.throws(() => requireCurrentAssignment(s.config, s.ledger, s.investigation, assignment), /receipt is missing/);
  const changed = setup(t), current = planned(changed);
  const update = structuredClone(changed.evidence);
  update.id += '-new-revision'; update.source.revision = '2';
  changed.ledger.put(update);
  assert.throws(() => requireCurrentAssignment(changed.config, changed.ledger, changed.investigation, current.assignment),
    /New source evidence/);
});

test('area-to-improve aggregation is stable, idempotent and versions material changes', t => {
  const { ledger, investigation, evidence } = setup(t);
  const first = recordAreaToImprove(ledger, improvementInput(investigation));
  const replay = recordAreaToImprove(ledger, improvementInput(investigation));
  assert.deepEqual(replay, first);
  assert.equal(ledger.all('areaToImprove').length, 1);
  const updated = recordAreaToImprove(ledger, {
    ...improvementInput(investigation), evidenceIds: [evidence.id],
    rationale: 'New review confirms the same durable improvement with stronger evidence.', priority: 'high'
  });
  assert.equal(updated.id, first.id);
  assert.equal(updated.version, 2);
  assert.equal(ledger.all('areaToImprove').length, 2);
});

test('coverage planning treats incomplete empty search as unknown, not a confirmed gap', t => {
  const { ledger, investigation } = setup(t);
  const improvement = recordAreaToImprove(ledger, improvementInput(investigation));
  const unknown = recordTestCoveragePlan(ledger, {
    improvementId: improvement.id, improvementVersion: improvement.version,
    repoId: 'office-src', capability: 'integration-test-authoring',
    sourceRevision: null, searchStatus: 'partial', existingTests: [], coverageGaps: [], unknowns: [],
    rationale: 'The OA repository search was not complete.'
  });
  assert.equal(unknown.disposition, 'unknown');
  assert.match(unknown.unknowns[0], /not completely established/);
  assert.throws(() => recordTestCoveragePlan(ledger, {
    improvementId: improvement.id, improvementVersion: improvement.version,
    repoId: 'office-src', capability: 'integration-test-authoring',
    sourceRevision: null, searchStatus: 'complete', existingTests: [],
    coverageGaps: ['A claimed gap without a source revision.'], unknowns: [],
    rationale: 'This complete result is not source-bound.'
  }), /bound to a repository commit/);
  const gap = recordTestCoveragePlan(ledger, {
    improvementId: improvement.id, improvementVersion: improvement.version,
    repoId: 'office-src', capability: 'integration-test-authoring',
    sourceRevision: 'a'.repeat(40), searchStatus: 'complete', existingTests: [],
    coverageGaps: ['No integration test exercises the observed behavior.'], unknowns: [],
    rationale: 'A complete source-bound search found no matching test.'
  });
  assert.equal(gap.disposition, 'coverage-gap');
  assert.equal(gap.version, 2);
});

test('existing test links are deduplicated and take precedence over proposed gaps', t => {
  const { ledger, investigation } = setup(t);
  const improvement = recordAreaToImprove(ledger, improvementInput(investigation));
  const plan = recordTestCoveragePlan(ledger, {
    improvementId: improvement.id, improvementVersion: improvement.version,
    repoId: 'office-src', capability: 'integration-test-authoring',
    sourceRevision: 'b'.repeat(40), searchStatus: 'complete',
    existingTests: [
      { path: 'test/behavior.test.js', identifier: 'preserves established behavior' },
      { path: 'test/behavior.test.js', identifier: 'preserves established behavior' }
    ],
    coverageGaps: ['Stale tentative gap'], unknowns: [], rationale: 'Existing source-bound coverage was found.'
  });
  assert.equal(plan.disposition, 'linked');
  assert.equal(plan.existingTests.length, 1);
});

test('planned OA assignment pins improvement, plan and qualified repository skill binding', t => {
  const { ledger, config, investigation } = setup(t);
  const improvement = recordAreaToImprove(ledger, improvementInput(investigation));
  const plan = recordTestCoveragePlan(ledger, {
    improvementId: improvement.id, improvementVersion: improvement.version,
    repoId: 'office-src', capability: 'integration-test-authoring',
    sourceRevision: 'c'.repeat(40), searchStatus: 'complete', existingTests: [],
    coverageGaps: ['Missing focused integration coverage.'], unknowns: [],
    rationale: 'Create an OA integration-test assignment.'
  });
  const validationContract = repositoryValidationContract(config.repositories[0]);
  ledger.qualify(skillQualificationId('office-src', 'oa-integration-test-core'), {
    state: 'qualified-read-only', repoId: 'office-src', bindingId: 'oa-integration-test-core',
    capability: 'integration-test-authoring', remote: config.repositories[0].remote,
    baseRef: 'main', baseRevision: plan.sourceRevision,
    skillPath: 'docs/skills/Integration-test-core/SKILL.md', skillSha256: 'd'.repeat(64),
    qualificationSource: 'local-reference',
    validationContractVersion: validationContract.version,
    validationContractSha256: validationContract.sha256,
    sideEffects: { commit: false, push: false, createDraftPR: false }
  });
  const assignment = makePlannedImprovementAssignment(config, ledger, investigation, plan.id);
  assert.equal(assignment.intent, 'improvement');
  assert.equal(assignment.improvementId, improvement.id);
  assert.equal(assignment.testCoveragePlanId, plan.id);
  assert.equal(assignment.skillBindingId, 'oa-integration-test-core');
  assert.equal(assignment.skillQualification.baseRevision, plan.sourceRevision);
  assert.ok(assignment.requiredCapabilities.includes('repository-skill:oa-integration-test-core'));
  const superseded = recordTestCoveragePlan(ledger, {
    improvementId: improvement.id, improvementVersion: improvement.version,
    repoId: 'office-src', capability: 'integration-test-authoring',
    sourceRevision: plan.sourceRevision, searchStatus: 'complete', existingTests: [],
    coverageGaps: ['Missing focused integration coverage.'], unknowns: [],
    rationale: 'A later source-bound review supersedes the prepared plan.'
  });
  assert.equal(superseded.id, plan.id);
  assert.equal(superseded.version, plan.version + 1);
  assert.throws(() => requireCurrentAssignment(config, ledger, investigation, assignment), /superseded/);
  config.repositories[0].skillBindings[0].qualification = 'unqualified';
  assert.throws(() => makePlannedImprovementAssignment(config, ledger, investigation, plan.id), /unqualified/);
});

test('planned assignment rejects incomplete coverage without a pinned source revision', t => {
  const { ledger, config, investigation } = setup(t);
  const improvement = recordAreaToImprove(ledger, improvementInput(investigation));
  const plan = recordTestCoveragePlan(ledger, {
    improvementId: improvement.id, improvementVersion: improvement.version,
    repoId: 'office-src', capability: 'integration-test-authoring',
    sourceRevision: null, searchStatus: 'partial', existingTests: [], coverageGaps: [], unknowns: [],
    rationale: 'Repository coverage is not source-bound yet.'
  });
  assert.throws(() => makePlannedImprovementAssignment(config, ledger, investigation, plan.id),
    /source-bound coverage revision/);
});
