import {
  acceptReviewedHandoff, prepareReviewedHandoff, validateReviewedHandoffReceipt
} from './reviewed-handoff.js';

export const validateReviewedHandoff = validateReviewedHandoffReceipt;

export function prepareReviewedHandoffE2E(config, ledger, input) {
  return prepareReviewedHandoff(config, ledger, input, { source: 'downstream-e2e' });
}

export function runReviewedHandoffE2E(config, ledger, input, options = {}) {
  return acceptReviewedHandoff(config, ledger, input, {
    ...options,
    source: 'downstream-e2e'
  });
}
