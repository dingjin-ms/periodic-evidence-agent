import { exclusions, hash, json, requireThat, utc, validateRecord } from './common.js';
import { planImprovement } from './improvements.js';
import { resolveSkillBinding, skillQualificationId } from './repository-skills.js';
import { dispatchReviewedHandoffE2E, makePlannedImprovementAssignment } from './workers.js';

function sameValues(left, right) {
  return json([...left].sort()) === json([...right].sort());
}

export function validateReviewedHandoff(bundle) {
  validateRecord(bundle, 'reviewedHandoff');
  requireThat(sameValues(bundle.review.exclusionsChecked, exclusions),
    'Reviewed handoff must explicitly check every exclusion', 'blocked-exclusion');
  requireThat(bundle.review.classification === 'functional' &&
    bundle.review.reportEligibility === 'included' &&
    bundle.review.handoffEligibility === 'eligible' &&
    bundle.review.exclusionReasons.length === 0,
  'Downstream E2E requires an included, eligible functional review with no exclusions',
  'blocked-exclusion');
  const improvement = bundle.planning.improvement;
  const coverage = bundle.planning.testCoverage;
  requireThat(bundle.review.repoIds.includes(coverage.repoId) &&
    improvement.repoIds.includes(coverage.repoId) &&
    improvement.capabilities.includes(coverage.capability),
  'Reviewed handoff planning is outside the reviewed repository or capability',
  'blocked-scope');
  requireThat(coverage.searchStatus === 'complete' && coverage.coverageGaps.length > 0 &&
    coverage.unknowns.length === 0,
  'Authorized downstream E2E requires a complete reviewed coverage gap with no unknowns',
  'blocked-reconciliation');
  return bundle;
}

function evidenceRecord(bundle) {
  const timestamp = utc(bundle.reviewedAt);
  return {
    recordType: 'evidence',
    schemaVersion: '1.0',
    id: 'pending-capture',
    source: {
      kind: 'fixture',
      namespace: `reviewed-handoff/${bundle.id}`,
      recordId: bundle.id,
      revision: String(bundle.version),
      versionBasis: 'Versioned reviewed-handoff fixture',
      provenance: 'synthetic',
      ownerConfirmation: null
    },
    scopeId: `downstream-e2e:${bundle.id}`,
    title: bundle.evidence.title,
    url: `https://example.invalid/reviewed-handoff/${bundle.id}`,
    createdAt: timestamp,
    queriedAt: timestamp,
    observedAt: timestamp,
    snapshotAt: timestamp,
    queryText: 'Versioned reviewed-handoff fixture; no source query was executed.',
    sourceStatus: 'Active',
    ring: 'unknown',
    discoveryChannel: 'E2E',
    permittedSummary: bundle.evidence.summary,
    fields: bundle.evidence.fields,
    missingFields: [],
    links: [],
    discoveredFrom: null,
    discoveryReason: 'Authorized downstream E2E fixture',
    capture: { artifactRef: null, sha256: null, unavailableReason: 'Pending fixture capture' }
  };
}

function investigationRecord(bundle, evidence) {
  const review = bundle.review;
  return {
    recordType: 'investigation',
    schemaVersion: '1.0',
    id: `investigation-${hash(json([bundle.format, bundle.id, bundle.version]))}`,
    version: bundle.version,
    evidenceIds: [evidence.id],
    state: 'triaged',
    observedBehavior: review.observedBehavior,
    expectedBehavior: review.expectedBehavior,
    hypotheses: review.hypotheses,
    counterEvidence: review.counterEvidence,
    classification: review.classification,
    defectConfirmation: review.defectConfirmation,
    reportEligibility: review.reportEligibility,
    handoffEligibility: review.handoffEligibility,
    exclusionReasons: review.exclusionReasons,
    rationale: review.rationale,
    confidence: review.confidence,
    review: { method: review.method, reviewer: review.reviewer, reviewedAt: bundle.reviewedAt },
    repoIds: review.repoIds,
    existingFixes: review.existingFixes,
    nextAction: review.nextAction
  };
}

export function prepareReviewedHandoffE2E(config, ledger, input) {
  const bundle = validateReviewedHandoff(structuredClone(input));
  requireThat(config.statePolicy.accessApproved === true,
    'Reviewed handoff E2E requires approved local state storage', 'blocked-config');
  const coverage = bundle.planning.testCoverage;
  const { binding } = resolveSkillBinding(config, coverage.repoId, coverage.capability);
  requireThat(binding.requestedOutcomes.includes(bundle.planning.requestedOutcome),
    `Repository skill binding ${binding.id} does not support ${bundle.planning.requestedOutcome}`,
    'blocked-scope');
  const qualification = ledger.qualification(skillQualificationId(coverage.repoId, binding.id));
  requireThat(qualification?.baseRevision,
    'Reviewed handoff E2E requires a current repository skill qualification',
    'blocked-config');
  const evidence = ledger.evidence(evidenceRecord(bundle), bundle.evidence,
    `reviewed-handoff:${bundle.id}:v${bundle.version}`);
  const investigation = investigationRecord(bundle, evidence);
  validateRecord(investigation);
  ledger.put(investigation);
  const planned = planImprovement(ledger, {
    improvement: {
      ...bundle.planning.improvement,
      investigationIds: [investigation.id],
      observedBehavior: investigation.observedBehavior,
      expectedBehavior: investigation.expectedBehavior
    },
    testCoverage: {
      ...coverage,
      sourceRevision: qualification.baseRevision
    }
  });
  const assignment = makePlannedImprovementAssignment(config, ledger, investigation,
    planned.testCoveragePlan.id, bundle.planning.requestedOutcome);
  const job = ledger.job(assignment.id) ?? ledger.prepare(assignment);
  return { bundle, evidence, investigation, ...planned, assignment, job };
}

export async function runReviewedHandoffE2E(config, ledger, input, {
  execute = false,
  authorizeSynthetic = false,
  authorizeDraftPR = false,
  dispatchDependencies = {}
} = {}) {
  if (execute) {
    requireThat(authorizeSynthetic === true,
      'Execution requires --authorize-synthetic', 'blocked-config');
    requireThat(authorizeDraftPR === true,
      'Execution requires --authorize-draft-pr', 'blocked-config');
  }
  const prepared = prepareReviewedHandoffE2E(config, ledger, input);
  if (!execute) return { state: 'prepared', ...prepared };
  const { binding } = resolveSkillBinding(config, prepared.assignment.repoId,
    prepared.assignment.capability, prepared.assignment.skillBindingId);
  requireThat(binding.sideEffects.commit === true && binding.sideEffects.push === true &&
    binding.sideEffects.createDraftPR === true,
  'Repository skill binding is not authorized for commit, push and Draft PR side effects',
  'blocked-config');
  const result = await dispatchReviewedHandoffE2E(config, ledger, prepared.assignment.id,
    dispatchDependencies);
  return { state: result.outcome, ...prepared, result };
}
