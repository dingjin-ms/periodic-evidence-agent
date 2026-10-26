import { requireThat } from './common.js';
import { requireAdoEvidenceCohort } from './ado-cohort.js';
import { requireExistingFixesReview } from './review-decisions.js';

export function isRegressionCoveragePlan(plan, requestedOutcome) {
  const testOutcome = {
    'integration-test-authoring': 'add-or-update-tests',
    'declarative-e2e-authoring': 'add-declarative-e2e-tests'
  }[plan?.capability];
  return plan?.purpose === 'regression-coverage' &&
    Boolean(testOutcome) && requestedOutcome === testOutcome &&
    plan.searchStatus === 'complete' && plan.coverageGaps?.length > 0 &&
    Array.isArray(plan.unknowns) && plan.unknowns.length === 0;
}

export function requireTestCoverageAssignment(assignment, plan) {
  requireThat(assignment.intent === 'improvement' && assignment.testCoveragePlanId &&
    assignment.skillBindingId && assignment.skillQualification &&
    ['integration-test-authoring', 'e2e-test-authoring', 'declarative-e2e-authoring'].includes(assignment.capability) &&
    ['add-or-update-tests', 'add-declarative-e2e-tests'].includes(assignment.requestedOutcome) &&
    assignment.allowedWritePrefixes?.length > 0,
  'Terminal source evidence is eligible only for qualified, bounded test-coverage improvements', 'blocked-reconciliation');
  requireThat(plan?.searchStatus === 'complete' && plan.coverageGaps.length > 0 &&
    plan.unknowns.length === 0 && ['coverage-gap', 'linked'].includes(plan.disposition),
  'Resolved-bug coverage requires a complete source-bound coverage gap without unresolved questions',
  'blocked-reconciliation');
}

export function requireCurrentSourceEligibility(ledger, assignment) {
  const latest = new Set(ledger.latestEvidence().map(evidence => evidence.id));
  requireThat(assignment.evidenceIds.every(id => latest.has(id)),
    'New source evidence requires review before dispatch', 'blocked-reconciliation');
  const evidence = assignment.evidenceIds.map(id => ledger.get('evidence', id));
  requireThat(evidence.every(record => record &&
    ledger.trackedState(record)?.state !== 'reconciliation-required'),
  'Changed tracked eligibility requires reconciliation before dispatch', 'blocked-reconciliation');
  const plan = assignment.testCoveragePlanId
    ? ledger.get('testCoveragePlan', assignment.testCoveragePlanId) : null;
  const investigation = ledger.get('investigation', assignment.investigationId);
  const terminal = evidence.filter(record => ['Removed', 'Resolved', 'Closed'].includes(record.sourceStatus) ||
    (record.source.kind === 'ado' && ['Removed', 'Resolved', 'Closed'].includes(record.fields['System.State'])));
  const adoCoverage = assignment.testCoveragePlanId && evidence.some(record => record.source.kind === 'ado');
  if (!terminal.length && !adoCoverage && !investigation?.existingFixes.length) return;
  requireTestCoverageAssignment(assignment, plan);
  requireThat(plan.version === assignment.testCoveragePlanVersion &&
    plan.sourceRevision === assignment.skillQualification?.baseRevision &&
    plan.capability === assignment.capability,
  'Assignment coverage plan changed or uses a different qualified source revision', 'blocked-reconciliation');
  requireThat(terminal.every(record => record.source.kind === 'ado'),
    'Terminal non-ADO evidence requires reconciliation before execution', 'blocked-reconciliation');
  requireThat(evidence.some(record => record.source.kind === 'ado'),
    'Existing product-fix reconciliation is limited to the ADO regression cohort', 'blocked-reconciliation');
  evidence.forEach(requireAdoEvidenceCohort);
  const improvement = ledger.get('areaToImprove', assignment.improvementId);
  requireThat(improvement?.version === assignment.improvementVersion &&
    improvement.category === 'missing-test-coverage' &&
    assignment.evidenceIds.every(id => improvement.evidenceIds.includes(id)),
  'Resolved-bug coverage requires a complete source-bound coverage gap without unresolved questions',
  'blocked-reconciliation');
  requireThat(investigation?.version === assignment.investigationVersion,
    'Investigation was superseded before execution', 'blocked-reconciliation');
  if (investigation.existingFixes.length || plan.existingFixesReview)
    requireExistingFixesReview(investigation, plan);
}
