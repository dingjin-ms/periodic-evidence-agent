import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';
import { configAt, hash, json, now, exclusions } from '../src/common.js';
import { acceptReview } from '../src/coordinator.js';
import { evidenceEnvelope } from '../src/sources.js';
import { recordAreaToImprove, recordTestCoveragePlan } from '../src/improvements.js';
import { makeAssignment, makePlannedImprovementAssignment, requireCurrentAssignment, dispatch } from '../src/workers.js';
import { requireCurrentSourceEligibility } from '../src/source-eligibility.js';
import { importReviewedContinuation } from '../src/local-continuation.js';
import { repositoryValidationContract, skillQualificationId } from '../src/repository-skills.js';

function setup(t, {
  sourceStatus = 'Resolved', reason = 'Fixed', stateReason = 'Resolved', existingFixes = [], kind = 'ado'
} = {}) {
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
  evidence.links = existingFixes.map(url => ({ url, relation: 'ArtifactLink',
    evidenceId: null, access: 'not-followed-out-of-scope' }));
  evidence.capture = { artifactRef: null, sha256: null, unavailableReason: 'Fixture' };
  evidence.id = `ev-${hash(json(['fixture', 42]))}`;
  evidence.sourceStatus = sourceStatus;
  evidence.fields = { 'System.State': sourceStatus, 'System.Reason': stateReason,
    ...(reason !== null ? { 'Microsoft.VSTS.Common.ResolvedReason': reason } : {}) };
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
    repoIds: ['office-src'], existingFixes, nextAction: 'Add or link focused integration coverage.'
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
  const s = setup(t, { sourceStatus: kind === 'ado' ? 'Resolved' : 'active', existingFixes: fixes, kind });
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
    const s = setup(t, { sourceStatus: state, reason: resolution }), { assignment } = planned(s);
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
    const s = setup(t, { sourceStatus: state, reason: resolution }), { assignment } = planned(s);
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

test.describe('resolved regression coverage', () => {
  function regressionFixture(t, {
    planChanges = {}, capability = 'integration-test-authoring', ...sourceOptions
  } = {}) {
    const ctx = setup(t, { sourceStatus: 'Resolved', ...sourceOptions });
    const binding = ctx.config.repositories[0].skillBindings[0];
    binding.capability = capability;
    const outcome = capability === 'declarative-e2e-authoring'
      ? 'add-declarative-e2e-tests' : 'add-or-update-tests';
    binding.requestedOutcomes = [outcome];
    const improvement = recordAreaToImprove(ctx.ledger, {
      ...improvementInput(ctx.investigation), capabilities: [capability]
    });
    let plan = recordTestCoveragePlan(ctx.ledger, {
      improvementId: improvement.id, improvementVersion: improvement.version,
      repoId: 'office-src', capability,
      purpose: 'regression-coverage', sourceRevision: 'a'.repeat(40),
      searchStatus: 'complete', existingTests: [],
      coverageGaps: ['The fixed behavior has no focused regression assertion.'],
      unknowns: [], rationale: 'Cover the fixed behavior without changing production.',
      ...planChanges
    });
    if (ctx.investigation.existingFixes.length) {
      plan = recordTestCoveragePlan(ctx.ledger, {
        ...plan,
        existingFixesReview: {
          investigationId: ctx.investigation.id, investigationVersion: ctx.investigation.version,
          evidenceIds: ctx.investigation.evidenceIds, planId: plan.id, planVersion: plan.version + 1,
          sourceRevision: plan.sourceRevision,
          review: { method: ctx.config.reviewMethod, reviewer: 'synthetic-coverage-agent', reviewedAt: now() },
          fixes: ctx.investigation.existingFixes.map(url => ({
            url, disposition: 'product-fix-with-remaining-coverage-gap',
            rationale: 'The exact-source inventory retains a missing regression assertion after the landed fix.'
          }))
        }
      });
    }
    const repo = ctx.config.repositories[0];
    const contract = repositoryValidationContract(repo);
    const qualification = {
      state: 'qualified-read-only', repoId: repo.id, bindingId: repo.skillBindings[0].id,
      capability: plan.capability, remote: repo.remote, baseRef: repo.baseRef,
      baseRevision: plan.sourceRevision, skillPath: repo.skillBindings[0].skillPath,
      skillSha256: 'b'.repeat(64), qualificationSource: 'local-reference',
      validationContractVersion: contract.version, validationContractSha256: contract.sha256,
      sideEffects: { commit: false, push: false, createDraftPR: false }
    };
    ctx.ledger.qualify(skillQualificationId(repo.id, repo.skillBindings[0].id), qualification);
    return { ...ctx, plan, qualification,
      assign: (requestedOutcome = outcome) => {
        const assignment = makePlannedImprovementAssignment(
          ctx.config, ctx.ledger, ctx.investigation, plan.id, requestedOutcome);
        return requireCurrentAssignment(ctx.config, ctx.ledger, ctx.investigation, assignment);
      } };
  }

  test('resolved 1JS regression uses the native declarative authoring outcome', t => {
    const ctx = regressionFixture(t, { capability: 'declarative-e2e-authoring' });
    const assignment = ctx.assign();
    assert.equal(assignment.requestedOutcome, 'add-declarative-e2e-tests');
    assert.doesNotThrow(() => requireCurrentSourceEligibility(ctx.ledger, assignment));
    assert.throws(() => ctx.assign('add-or-update-tests'), /test-only outcome/);
  });

  for (const sourceStatus of ['Resolved', 'Closed']) {
    test(`${sourceStatus}/Fixed supports explicit qualified regression coverage and preserves known fixes`, t => {
      const ctx = regressionFixture(t, {
        sourceStatus, existingFixes: ['https://example.invalid/fix/42']
      });
      const assignment = ctx.assign();
      assert.equal(assignment.intent, 'improvement');
      assert.equal(assignment.requestedOutcome, 'add-or-update-tests');
      assert.deepEqual(assignment.allowedWritePrefixes, ['test']);
      assert.equal(assignment.permissions.mutateEvidenceSources, false);
      assert.equal(ctx.ledger.get('evidence', ctx.evidence.id).sourceStatus, sourceStatus);
      assert.deepEqual(ctx.ledger.get('investigation', ctx.investigation.id).existingFixes,
        ['https://example.invalid/fix/42']);
      assert.doesNotThrow(() => requireCurrentAssignment(
        ctx.config, ctx.ledger, ctx.investigation, assignment));
      assert.doesNotThrow(() => requireCurrentSourceEligibility(ctx.ledger, assignment));
    });
  }

  test('Fixed in the state reason cannot replace the captured dedicated resolution field', t => {
    const ctx = regressionFixture(t, { reason: null, stateReason: 'Fixed' });
    assert.throws(() => ctx.assign(), /ResolvedReason Fixed or Duplicate/);
  });

  for (const [name, options] of [
    ['removed source', { sourceStatus: 'Removed' }],
    ['non-fixed resolution', { reason: 'By Design' }],
    ['conflicting non-fixed resolution', { reason: 'By Design', stateReason: 'Fixed' }],
    ['missing resolution', { reason: null }],
    ['incomplete coverage search', { planChanges: { searchStatus: 'partial' } }],
    ['no remaining coverage gap', { planChanges: { coverageGaps: [] } }],
    ['unresolved coverage unknowns', { planChanges: { unknowns: ['Unknown fixture'] } }]
  ]) {
    test(`resolved regression eligibility rejects ${name}`, t => {
      const ctx = regressionFixture(t, options);
      assert.throws(() => ctx.assign(), error =>
        ['blocked-reconciliation', 'blocked-scope'].includes(error.code));
      assert.equal(ctx.ledger.status().jobs.length, 0);
    });
  }

  test('regression plans cannot request production-fix outcomes or bypass unresolved reconciliation', t => {
    const ctx = regressionFixture(t);
    ctx.config.repositories[0].skillBindings[0].requestedOutcomes.push('fix-production');
    assert.throws(() => ctx.assign('fix-production'), /test-only outcome/);
    ctx.ledger.setTrackedState(ctx.evidence, 'reconciliation-required', 'Source moved or changed.');
    assert.throws(() => ctx.assign(), error => error.code === 'blocked-reconciliation');
  });

  test('dispatch rechecks every regression source after preparation without launching a worker', async t => {
    const ctx = regressionFixture(t);
    const assignment = ctx.assign();
    const job = ctx.ledger.prepare(assignment);
    ctx.config.activation.dispatch = true;
    ctx.ledger.setTrackedState(ctx.evidence, 'reconciliation-required', 'Source requires a new review.');
    await assert.rejects(dispatch(ctx.config, ctx.ledger, job.id, {
      runModel: () => assert.fail('Ineligible evidence must not launch a model')
    }), error => error.code === 'blocked-reconciliation');
    assert.equal(ctx.ledger.job(job.id).state, 'prepared');
    assert.equal(ctx.ledger.all('workerResult').length, 0);
  });

  test('superseded resolved source still invalidates a prepared regression assignment', t => {
    const ctx = regressionFixture(t);
    const assignment = ctx.assign();
    const next = structuredClone(ctx.evidence);
    next.id = 'ev-next-source-revision';
    next.source.revision = '2';
    ctx.ledger.put(next);
    assert.throws(() => requireCurrentSourceEligibility(ctx.ledger, assignment),
      /New source evidence/);
  });

  test('superseded regression plan cannot authorize the previous assignment', t => {
    const ctx = regressionFixture(t);
    const assignment = ctx.assign();
    recordTestCoveragePlan(ctx.ledger, { ...ctx.plan, purpose: undefined });
    assert.throws(() => requireCurrentAssignment(
      ctx.config, ctx.ledger, ctx.investigation, assignment), /superseded/);
    assert.throws(() => requireCurrentSourceEligibility(ctx.ledger, assignment),
      error => error.code === 'blocked-reconciliation');
  });

  test('a changed qualification invalidates the prepared regression assignment', t => {
    const ctx = regressionFixture(t);
    const assignment = ctx.assign();
    ctx.ledger.qualify(skillQualificationId('office-src', assignment.skillBindingId), {
      ...ctx.qualification, baseRevision: 'c'.repeat(40)
    });
    assert.throws(() => requireCurrentAssignment(
      ctx.config, ctx.ledger, ctx.investigation, assignment),
    /different source revisions/);
  });

  test('each source in a regression assignment must independently remain eligible', t => {
    const ctx = regressionFixture(t);
    const assignment = ctx.assign();
    const other = {
      ...ctx.evidence, id: 'ev-other-non-fixed-source',
      source: { ...ctx.evidence.source, recordId: '43' },
      fields: { ...ctx.evidence.fields, 'Microsoft.VSTS.Common.ResolvedReason': 'By Design' }
    };
    ctx.ledger.put(other);
    assert.throws(() => requireCurrentSourceEligibility(ctx.ledger, {
      ...assignment, evidenceIds: [...assignment.evidenceIds, other.id]
    }), error => error.code === 'blocked-scope' && /Fixed or Duplicate/.test(error.message));
  });

  for (const intent of ['rca-only', 'defect-fix', 'improvement']) {
    test(`unplanned ${intent} dispatch remains blocked for a resolved source`, async t => {
      const ctx = regressionFixture(t);
      const assignment = makeAssignment(ctx.config, ctx.investigation, 'office-src', intent);
      const job = ctx.ledger.prepare(assignment);
      ctx.config.activation.dispatch = true;
      await assert.rejects(dispatch(ctx.config, ctx.ledger, job.id, {
        runModel: () => assert.fail('Resolved sources only permit planned regression coverage')
      }), error => error.code === 'blocked-reconciliation');
    });
  }

  test('resolved regression continuation imports real capture identity and preserves the same policy', t => {
    const ctx = regressionFixture(t);
    const capture = ctx.ledger.evidence(
      { ...ctx.evidence, source: { ...ctx.evidence.source, revision: '2' } },
      { fixture: 'fixed-source' }, 'fixture-capture');
    ctx.config.activation.review = true;
    const investigation = acceptReview(ctx.config, ctx.ledger, {
      investigation: { ...ctx.investigation, version: 2, evidenceIds: [capture.id],
        review: { ...ctx.investigation.review, method: ctx.config.reviewMethod, reviewedAt: now() } },
      exclusionsChecked: exclusions
    });
    const improvement = recordAreaToImprove(ctx.ledger, improvementInput(investigation));
    const plan = recordTestCoveragePlan(ctx.ledger, {
      ...ctx.plan, improvementVersion: improvement.version
    });
    const assignment = makePlannedImprovementAssignment(
      ctx.config, ctx.ledger, investigation, plan.id);
    const destination = new Ledger(join(ctx.root, 'continuation-state'));
    try {
      importReviewedContinuation(ctx.config, ctx.ledger, destination, assignment,
        ctx.qualification, 'fixture-continuation');
      assert.equal(destination.get('evidence', capture.id).sourceStatus, 'Resolved');
      assert.equal(destination.get('evidence', capture.id).capture.sha256, capture.capture.sha256);
      assert.doesNotThrow(() => requireCurrentSourceEligibility(destination, assignment));
      ctx.ledger.setTrackedState(capture, 'reconciliation-required', 'Do not replay stale evidence.');
      assert.throws(() => importReviewedContinuation(ctx.config, ctx.ledger, destination,
        assignment, ctx.qualification, 'blocked-continuation'),
      error => error.code === 'blocked-reconciliation');
    } finally { destination.close(); }
  });
});
