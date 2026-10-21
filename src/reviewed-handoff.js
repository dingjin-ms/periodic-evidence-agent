import { hash, json, requireThat, utc, validateRecord } from './common.js';
import { persistReviewedInvestigation } from './coordinator.js';
import { planImprovement } from './improvements.js';
import { withRsiWorker } from './rsi-flow.js';
import {
  requireCompleteExclusionReview, requireEligibleImprovementInvestigation
} from './review-decisions.js';
import { resolveSkillBinding, skillQualificationId } from './repository-skills.js';
import {
  dispatchReviewedHandoff, makePlannedImprovementAssignment
} from './workers.js';

function evidenceRecord(receipt, submissionSource) {
  const timestamp = utc(receipt.reviewedAt);
  return {
    recordType: 'evidence',
    schemaVersion: '1.0',
    id: 'pending-capture',
    source: {
      kind: receipt.source.kind,
      namespace: receipt.source.namespace,
      recordId: receipt.source.recordId,
      revision: receipt.source.revision,
      versionBasis: 'Versioned reviewed-handoff receipt',
      provenance: receipt.source.provenance,
      ownerConfirmation: null
    },
    scopeId: `reviewed-handoff:${submissionSource}:${receipt.id}`,
    title: receipt.evidence.title,
    url: `https://example.invalid/reviewed-handoff/${receipt.id}`,
    createdAt: timestamp,
    queriedAt: timestamp,
    observedAt: timestamp,
    snapshotAt: timestamp,
    queryText: 'Versioned reviewed-handoff receipt; no source query was executed.',
    sourceStatus: 'Active',
    ring: 'unknown',
    discoveryChannel: 'E2E',
    permittedSummary: receipt.evidence.summary,
    fields: receipt.evidence.fields,
    missingFields: [],
    links: [],
    discoveredFrom: null,
    discoveryReason: `Authorized reviewed-handoff submission from ${submissionSource}`,
    capture: { artifactRef: null, sha256: null, unavailableReason: 'Pending receipt capture' }
  };
}

function investigationRecord(receipt, evidence) {
  const review = receipt.review;
  return {
    recordType: 'investigation',
    schemaVersion: '1.0',
    id: `investigation-${hash(json([evidence.source.namespace, evidence.source.recordId]))}`,
    version: receipt.version,
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
    review: { method: review.method, reviewer: review.reviewer, reviewedAt: receipt.reviewedAt },
    repoIds: review.repoIds,
    existingFixes: review.existingFixes,
    nextAction: review.nextAction
  };
}

export function validateReviewedHandoffReceipt(input) {
  const receipt = validateRecord(structuredClone(input), 'reviewedHandoff');
  requireThat(Date.parse(receipt.reviewedAt) <= Date.now(),
    'Reviewed handoff timestamp cannot be in the future', 'blocked-reconciliation');
  requireThat(receipt.source.kind === 'fixture' &&
    receipt.source.provenance === 'synthetic' &&
    receipt.source.namespace.startsWith('reviewed-handoff/') &&
    receipt.source.recordId === receipt.id &&
    receipt.source.revision === String(receipt.version),
  'Reviewed handoff source reference is inconsistent or not source-neutral synthetic fixture provenance',
  'blocked-reconciliation');
  requireCompleteExclusionReview(receipt.review.exclusionsChecked);
  requireEligibleImprovementInvestigation(receipt.review);
  const improvement = receipt.planning.improvement;
  const coverage = receipt.planning.testCoverage;
  requireThat(receipt.review.repoIds.includes(coverage.repoId) &&
    improvement.repoIds.includes(coverage.repoId) &&
    improvement.capabilities.includes(coverage.capability),
  'Reviewed handoff planning is outside the reviewed repository or capability',
  'blocked-scope');
  requireThat(coverage.searchStatus === 'complete' && coverage.coverageGaps.length > 0 &&
    coverage.unknowns.length === 0,
  'Reviewed handoff requires a complete coverage gap with no unresolved unknowns',
  'blocked-reconciliation');
  return receipt;
}

export function prepareReviewedHandoff(config, ledger, input, {
  source = 'controller'
} = {}) {
  const receipt = validateReviewedHandoffReceipt(input);
  requireThat(config.statePolicy.accessApproved === true,
    'Reviewed handoff requires approved local state storage', 'blocked-config');
  const investigationId = `investigation-${hash(json([
    receipt.source.namespace, receipt.source.recordId
  ]))}`;
  const currentInvestigation = ledger.get('investigation', investigationId);
  requireThat(!currentInvestigation ||
    receipt.version === currentInvestigation.version ||
    receipt.version === currentInvestigation.version + 1,
  'Reviewed handoff receipt is stale, superseded or skips a version',
  'blocked-reconciliation');
  const coverage = receipt.planning.testCoverage;
  const { binding } = resolveSkillBinding(config, coverage.repoId, coverage.capability);
  requireThat(binding.requestedOutcomes.includes(receipt.planning.requestedOutcome),
    `Repository skill binding ${binding.id} does not support ${receipt.planning.requestedOutcome}`,
    'blocked-scope');
  const qualification = ledger.qualification(skillQualificationId(coverage.repoId, binding.id));
  requireThat(qualification?.baseRevision,
    'Reviewed handoff requires a current repository skill qualification',
    'blocked-config');
  return ledger.transaction(() => {
    const evidence = ledger.evidence(evidenceRecord(receipt, source), receipt.evidence,
      `reviewed-handoff:${receipt.id}:v${receipt.version}`);
    const investigation = persistReviewedInvestigation(config, ledger, {
      investigation: investigationRecord(receipt, evidence),
      exclusionsChecked: receipt.review.exclusionsChecked
    }, {
      requireReviewActivation: false,
      allowImportedInitialVersion: true,
      allowIdempotentReplay: true
    });
    const planned = planImprovement(ledger, {
      improvement: {
        ...receipt.planning.improvement,
        investigationIds: [investigation.id],
        observedBehavior: investigation.observedBehavior,
        expectedBehavior: investigation.expectedBehavior
      },
      testCoverage: {
        ...coverage,
        sourceRevision: qualification.baseRevision,
        ...(receipt.planning.skillInput
          ? { skillInput: receipt.planning.skillInput }
          : {})
      }
    });
    const assignment = makePlannedImprovementAssignment(config, ledger, investigation,
      planned.testCoveragePlan.id, receipt.planning.requestedOutcome);
    const job = ledger.job(assignment.id) ?? ledger.prepare(assignment);
    return { receipt, evidence, investigation, ...planned, assignment, job };
  });
}

export async function acceptReviewedHandoff(config, ledger, input, {
  execute = false,
  authorizeSynthetic = false,
  authorizeCommit = false,
  authorizePush = false,
  authorizeDraftPR = false,
  source = 'controller',
  dispatchDependencies = {}
} = {}) {
  const receipt = validateReviewedHandoffReceipt(input);
  if (execute) {
    requireThat(authorizeSynthetic === true,
      'Execution requires --authorize-synthetic', 'blocked-config');
    requireThat(authorizeCommit === true,
      'Execution requires --authorize-commit', 'blocked-config');
    requireThat(authorizePush === true,
      'Execution requires --authorize-push', 'blocked-config');
    requireThat(authorizeDraftPR === true,
      'Execution requires --authorize-draft-pr', 'blocked-config');
    const coverage = receipt.planning.testCoverage;
    const { binding } = resolveSkillBinding(config, coverage.repoId, coverage.capability);
    requireThat(binding.sideEffects.commit === true && binding.sideEffects.push === true &&
      binding.sideEffects.createDraftPR === true,
    'Repository skill binding is not authorized for commit, push and Draft PR side effects',
    'blocked-config');
  }
  const prepared = prepareReviewedHandoff(config, ledger, receipt, { source });
  if (!execute) return { state: 'prepared', ...prepared };
  const { result, rsi } = await withRsiWorker(config, ledger, prepared.assignment.id,
    () => dispatchReviewedHandoff(config, ledger, prepared.assignment.id, dispatchDependencies),
    { kind: 'reviewed-handoff', receipt }, dispatchDependencies.rsi);
  return { state: result.outcome ?? result.state, ...prepared, result, ...(rsi ? { rsi } : {}) };
}
