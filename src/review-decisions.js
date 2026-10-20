import { exclusions, json, requireThat, validateRecord } from './common.js';

export function requireCompleteExclusionReview(exclusionsChecked) {
  requireThat(Array.isArray(exclusionsChecked) &&
    exclusionsChecked.length === exclusions.length &&
    exclusions.every(exclusion => exclusionsChecked.includes(exclusion)),
  'All scanner exclusions must be reviewed for both handoff intents',
  'blocked-exclusion');
}

export function requireEligibleImprovementInvestigation(investigation) {
  requireThat(investigation.handoffEligibility === 'eligible' &&
    investigation.reportEligibility === 'included' &&
    investigation.classification === 'functional' &&
    investigation.exclusionReasons.length === 0,
  'Excluded or incomplete investigations cannot create repository improvements',
  'blocked-exclusion');
  return investigation;
}

export function validateExistingFixesReview(investigation, plan) {
  const receipt = plan?.existingFixesReview;
  requireThat(receipt, 'Existing fix requires a source-bound coverage reconciliation review', 'blocked-reconciliation');
  validateRecord(receipt, 'existingFixesReview');
  const sameSet = (a, b) => a.length === b.length && json([...a].sort()) === json([...b].sort());
  requireThat(receipt.investigationId === investigation.id &&
    receipt.investigationVersion === investigation.version &&
    sameSet(receipt.evidenceIds, investigation.evidenceIds) &&
    receipt.planId === plan.id && receipt.planVersion === plan.version &&
    receipt.sourceRevision === plan.sourceRevision &&
    receipt.review.method === investigation.review.method &&
    receipt.review.reviewer.trim().length > 0 &&
    Date.parse(receipt.review.reviewedAt) >= Date.parse(investigation.review.reviewedAt) &&
    Date.parse(receipt.review.reviewedAt) <= Date.now(),
  'Existing fix review is stale or differs from the exact investigation, evidence, plan or source revision',
  'blocked-reconciliation');
  const urls = receipt.fixes.map(fix => fix.url);
  requireThat(new Set(urls).size === urls.length && sameSet(urls, investigation.existingFixes),
    'Existing fix review must account for every original fix URL exactly once', 'blocked-reconciliation');
  requireThat(receipt.fixes.every(fix => fix.rationale.trim().length > 0),
    'Every existing fix review requires a nonblank rationale', 'blocked-reconciliation');
  return receipt;
}

export function requireExistingFixesReview(investigation, plan) {
  const receipt = validateExistingFixesReview(investigation, plan);
  requireThat(receipt.fixes.every(fix => fix.disposition === 'product-fix-with-remaining-coverage-gap'),
  'Existing coverage is satisfied, in-flight or unresolved; no duplicate test work is authorized',
  'blocked-reconciliation');
}
