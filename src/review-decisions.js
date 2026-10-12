import { exclusions, requireThat } from './common.js';

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
