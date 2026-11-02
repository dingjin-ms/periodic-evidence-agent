import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { hash, requireThat } from './common.js';
import { noCredentials } from './app-native.js';
import { describeLocalFilterAttempt } from './local-filter.js';

const digest = value => hash(`${JSON.stringify(value, null, 2)}\n`);
export function prepareLocalFilterRetry(config, ledger, input) {
  const keys = ['format', 'batchId', 'authorizationRef', 'reviewRef', 'reason'];
  requireThat(input && Object.keys(input).length === keys.length &&
    keys.every(key => typeof input[key] === 'string' && input[key].trim()) &&
    input.format === 'local-filter-retry-request-v1' && isAbsolute(input.reviewRef) &&
    input.reason.length <= 4000 && input.reviewRef.length <= 4000,
  'Retry preparation requires exact fields, an absolute review JSON path and an actionable reason of at most 4000 characters',
  'invalid-record');
  noCredentials(input);
  const previous = describeLocalFilterAttempt(config, ledger, input.batchId);
  requireThat(previous.request && previous.terminal &&
    (previous.terminal.state === 'blocked' && previous.terminal.analysisPassed === false ||
      previous.terminal.state === 'completed' && previous.terminal.analysisPassed === true && previous.result),
  'Retry requires an existing terminal predecessor, never an active or unknown attempt', 'blocked-reconciliation');
  const review = JSON.parse(readFileSync(input.reviewRef, 'utf8'));
  noCredentials(review);
  const retry = { batchId: input.batchId, previousAttemptId: previous.attemptId,
    previousTerminalSha256: digest(previous.terminal), authorizationRef: input.authorizationRef,
    review: { reviewRef: input.reviewRef, reviewSha256: digest(review), reason: input.reason } };
  if (previous.terminal.state === 'completed') {
    requireThat(previous.terminal.resultSha256 === digest(previous.result),
      'Completed predecessor result changed', 'blocked-reconciliation');
    retry.reassessment = { resultSha256: previous.terminal.resultSha256,
      reviewRef: input.reviewRef, reason: input.reason };
  }
  const byBatch = new Map();
  if (config.localFilter.retry) byBatch.set(config.localFilter.retry.batchId, config.localFilter.retry);
  for (const existing of config.localFilter.cohortRetries ?? []) byBatch.set(existing.batchId, existing);
  byBatch.set(input.batchId, retry);
  const localFilter = { ...structuredClone(config.localFilter), cohortRetries: [...byBatch.values()] };
  delete localFilter.retry;
  const next = describeLocalFilterAttempt({ ...config, localFilter }, ledger, input.batchId);
  return { state: 'prepared-not-executed', attemptId: next.attemptId, retry, localFilter,
    executionAcceptanceVerifiedByHelper: false,
    action: 'Use this configuration with the original manifest and ledger. Execution still enforces source pins, authorization, cumulative budget and no-fork lineage.' };
}
