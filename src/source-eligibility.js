import { requireThat } from './common.js';

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

export function requireCurrentSourceEligibility(ledger, assignment) {
  const latest = new Set(ledger.latestEvidence().map(evidence => evidence.id));
  requireThat(assignment.evidenceIds.every(id => latest.has(id)),
    'New source evidence requires review before dispatch', 'blocked-reconciliation');
  const plan = assignment.testCoveragePlanId
    ? ledger.get('testCoveragePlan', assignment.testCoveragePlanId) : null;
  const regression = assignment.intent === 'improvement' && assignment.skillBindingId && plan &&
    plan?.version === assignment.testCoveragePlanVersion &&
    plan.sourceRevision === assignment.skillQualification?.baseRevision &&
    plan.capability === assignment.capability &&
    isRegressionCoveragePlan(plan, assignment.requestedOutcome);
  requireThat(assignment.evidenceIds.every(id => {
    const evidence = ledger.get('evidence', id);
    if (ledger.trackedState(evidence)?.state === 'reconciliation-required') return false;
    if (!['Removed', 'Resolved', 'Closed'].includes(evidence.sourceStatus)) return true;
    const resolution = evidence.fields['Microsoft.VSTS.Common.ResolvedReason'] ??
      evidence.fields['System.Reason'];
    return regression && ['Resolved', 'Closed'].includes(evidence.sourceStatus) &&
      evidence.source.kind === 'ado' && resolution === 'Fixed';
  }), 'Tracked source eligibility changed or a fix is recorded; reconcile before dispatch. ' +
    'Fixed ADO sources require an explicit qualified regression-coverage plan.',
  'blocked-reconciliation');
}
