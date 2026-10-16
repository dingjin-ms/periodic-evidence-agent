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
  sourceStatus = null, reason = 'Fixed', stateReason = 'Resolved', existingFixes = []
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
  const evidence = evidenceEnvelope('ado', 'office/OC', '42', '1',
    'https://example.invalid/ado/42', 'fixture', now());
  evidence.source.provenance = 'authenticated-source';
  evidence.capture = { artifactRef: null, sha256: null, unavailableReason: 'Fixture' };
  evidence.id = `ev-${hash(json(['fixture', 42]))}`;
  evidence.sourceStatus = sourceStatus;
  evidence.fields = { 'System.Reason': stateReason,
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
    review: { method: 'human-review', reviewer: 'fixture', reviewedAt: now() },
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
    const plan = recordTestCoveragePlan(ctx.ledger, {
      improvementId: improvement.id, improvementVersion: improvement.version,
      repoId: 'office-src', capability,
      purpose: 'regression-coverage', sourceRevision: 'a'.repeat(40),
      searchStatus: 'complete', existingTests: [],
      coverageGaps: ['The fixed behavior has no focused regression assertion.'],
      unknowns: [], rationale: 'Cover the fixed behavior without changing production.',
      ...planChanges
    });
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
      assign: (requestedOutcome = outcome) => makePlannedImprovementAssignment(
        ctx.config, ctx.ledger, ctx.investigation, plan.id, requestedOutcome) };
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

  test('processes with Fixed in the state reason work without a dedicated resolution field', t => {
    const ctx = regressionFixture(t, { reason: null, stateReason: 'Fixed' });
    assert.doesNotThrow(() => ctx.assign());
  });

  for (const [name, options] of [
    ['removed source', { sourceStatus: 'Removed' }],
    ['non-fixed resolution', { reason: 'By Design' }],
    ['conflicting non-fixed resolution', { reason: 'By Design', stateReason: 'Fixed' }],
    ['missing resolution', { reason: null }],
    ['implicit generic improvement', { planChanges: { purpose: undefined } }],
    ['incomplete coverage search', { planChanges: { searchStatus: 'partial' } }],
    ['no remaining coverage gap', { planChanges: { coverageGaps: [] } }],
    ['unresolved coverage unknowns', { planChanges: { unknowns: ['Unknown fixture'] } }]
  ]) {
    test(`resolved regression eligibility rejects ${name}`, t => {
      const ctx = regressionFixture(t, options);
      assert.throws(() => ctx.assign(), error => error.code === 'blocked-reconciliation');
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
      fields: { 'Microsoft.VSTS.Common.ResolvedReason': 'By Design' }
    };
    ctx.ledger.put(other);
    assert.throws(() => requireCurrentSourceEligibility(ctx.ledger, {
      ...assignment, evidenceIds: [...assignment.evidenceIds, other.id]
    }), error => error.code === 'blocked-reconciliation');
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
