import { existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join } from 'node:path';
import { hash, json, now, requireThat, safeError, utc, validateRecord } from './common.js';
import { noCredentials } from './app-native.js';
import { validateFilterManifest } from './filter-batches.js';
import { describeLocalFilterAttempt, executeLocalFilterBatch } from './local-filter.js';
import { reconcileFilterExecutionCohort } from './filter-execution.js';
import { prepareFilterProposerHandoff, validateFilterProposerHandoff } from './filter-handoff.js';
import { preDispatchAuthProof, reconcileProposer } from './one-shot-handoff.js';
import { dispatch } from './workers.js';
import { withRsiWorker } from './rsi-flow.js';

const bytes = value => `${JSON.stringify(value, null, 2)}\n`;
const text = value => typeof value === 'string' && value.trim().length > 0;
const positive = value => Number.isSafeInteger(value) && value > 0;
function fields(value, keys) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key)),
  'Unexpected local E2E fields', 'invalid-record');
}
function validateInput(config, input) {
  fields(input, ['format', 'runId', 'filter', 'routing', 'authorization']);
  fields(input.filter, ['manifestPath', 'manifestSha256']);
  fields(input.authorization, ['approvedBy', 'approvedAt', 'approvalRef', 'deadlineAt',
    'maxFilterRequests', 'maxProposers', 'maxProposerAiCredits',
    'authorizeCommit', 'authorizePush', 'authorizeDraftPR']);
  Object.values(input).forEach(noCredentials);
  const a = input.authorization;
  requireThat(input.format === 'local-e2e-v1' && typeof input.runId === 'string' &&
    /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(input.runId) &&
    typeof input.filter.manifestPath === 'string' && isAbsolute(input.filter.manifestPath) &&
    typeof input.filter.manifestSha256 === 'string' && /^[a-f0-9]{64}$/.test(input.filter.manifestSha256),
  'Local E2E requires a safe run ID and exact absolute manifest binding', 'invalid-record');
  requireThat(config.statePolicy.accessApproved && config.filterExecutor === 'local-sdk' &&
    config.executionMode === 'standalone-sdk' && config.schedule.enabled === false,
  'Local E2E requires approved standalone-sdk state, local-sdk FILTER and scheduling disabled',
  'blocked-authorization');
  requireThat(text(a.approvedBy) && text(a.approvalRef) && positive(a.maxFilterRequests) &&
    a.maxProposers === 1 && Number.isFinite(a.maxProposerAiCredits) && a.maxProposerAiCredits > 0 &&
    positive(config.localFilter?.maxRequests) && config.localFilter.maxRequests <= a.maxFilterRequests &&
    ['authorizeCommit', 'authorizePush', 'authorizeDraftPR'].every(key => typeof a[key] === 'boolean'),
  'Finite ledger-wide FILTER and single-proposer authorization required', 'blocked-budget');
  requireThat(config.localFilter.cohortRetries === undefined || Array.isArray(config.localFilter.cohortRetries),
    'FILTER cohortRetries must be an array', 'invalid-record');
  const retries = [...(config.localFilter.cohortRetries ?? []),
    ...(config.localFilter.retry ? [config.localFilter.retry] : [])];
  requireThat(retries.every(retry => retry && typeof retry === 'object' &&
    ['maxRequests', 'maxToolCalls', 'timeoutMs'].every(key =>
    retry.execution?.[key] === undefined || positive(retry.execution[key]) &&
      retry.execution[key] <= config.localFilter[key])),
  'FILTER successors cannot enlarge this run\'s original request/tool/time caps', 'blocked-budget');
  utc(a.approvedAt); utc(a.deadlineAt);
  requireThat(Date.parse(a.approvedAt) <= Date.now() && Date.parse(a.deadlineAt) > Date.parse(a.approvedAt),
    'Invalid local E2E authorization interval', 'blocked-authorization');
}
function configBinding(config) {
  const value = structuredClone(config);
  // Only explicit predecessor-bound FILTER successors may change within a run.
  delete value.localFilter.cohortRetries;
  delete value.localFilter.retry;
  return hash(json(value));
}
function immutableResult(path, result) {
  const value = bytes(result);
  if (existsSync(path)) requireThat(readFileSync(path, 'utf8') === value,
    'Existing E2E result artifact changed; preserve and inspect it', 'blocked-reconciliation');
  else writeFileSync(path, value, { flag: 'wx' });
  return value;
}
function save(ledger, id, detail) {
  ledger.finishOperation(id, detail.state, detail);
  return { format: 'local-e2e-status-v1', operationId: id, ...detail,
    semanticAnalysisVerifiedByHelper: false };
}
function deadline(input) {
  requireThat(Date.now() < Date.parse(input.authorization.deadlineAt),
    'Local E2E authorization expired; no new FILTER or Proposer execution', 'blocked-budget');
}
function acceptReview(input, review, bindingSha256, selected) {
  fields(review, ['format', 'runId', 'reviewedBy', 'reviewedAt', 'decision',
    'bindingSha256', 'selectedCandidateKey', 'rationale']);
  noCredentials(review);
  utc(review.reviewedAt);
  requireThat(review.format === 'local-e2e-review-v1' && review.runId === input.runId &&
    text(review.reviewedBy) && text(review.rationale) && review.rationale.length <= 4000 &&
    Date.parse(review.reviewedAt) <= Date.now() &&
    ['approve', 'reject'].includes(review.decision) &&
    review.bindingSha256 === bindingSha256 && review.selectedCandidateKey === selected.key,
  'Semantic review must bind this exact complete cohort and selected candidate; references alone are not review',
  'blocked-review');
  return review.decision === 'approve';
}

export async function advanceLocalE2E(config, ledger, input, {
  filter = false, execute = false, review = null, resumeAuth = false,
  authorizeCommit = false, authorizePush = false, authorizeDraftPR = false,
  filterDependencies = {}, dispatchDependencies = {}
} = {}) {
  config = structuredClone(config);
  input = structuredClone(input);
  review = structuredClone(review);
  validateInput(config, input);
  requireThat(realpathSync(config.stateDirectory) === realpathSync(ledger.directory),
    'E2E must use its original approved state ledger', 'blocked-binding');
  const id = `local-e2e:${input.runId}`, owner = ledger.acquire(id);
  let detail;
  try {
    const prior = ledger.db.prepare('SELECT kind,detail FROM operations WHERE id=?').get(id);
    requireThat(!prior || prior.kind === 'local-e2e', 'Run ID belongs to another operation', 'blocked-binding');
    if (!prior) ledger.operation(id, input.runId, 'local-e2e', {
      inputSha256: hash(json(input)), configSha256: configBinding(config),
      state: 'held-awaiting-filter', results: [], accepted: null, assignment: null,
      dispatchStarted: false, authRequired: false, authRetryUsed: false, result: null, blocker: null
    });
    detail = JSON.parse(ledger.db.prepare('SELECT detail FROM operations WHERE id=?').get(id).detail);
    requireThat(detail.inputSha256 === hash(json(input)) && detail.configSha256 === configBinding(config),
      'Original E2E input/config changed; do not reset its ledger or authorization', 'blocked-reconciliation');
    requireThat(!resumeAuth || detail.dispatchStarted && detail.authRequired && !detail.authRetryUsed,
      'Auth resume requires the original positive pre-dispatch block and unused retry', 'blocked-reconciliation');
    const manifestBytes = readFileSync(input.filter.manifestPath);
    requireThat(hash(manifestBytes) === input.filter.manifestSha256,
      'E2E manifest changed', 'blocked-reconciliation');
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    validateFilterManifest(config, manifest);
    requireThat(manifest.budget.mode === 'verified' &&
      manifest.batches.length <= input.authorization.maxFilterRequests &&
      manifest.batches.length <= config.localFilter.maxRequests,
      'E2E requires the verified-tokenizer whole cohort within the request cap', 'blocked-budget');
    const hasReceipts = ledger.db.prepare(
      "SELECT 1 FROM sqlite_master WHERE type='table' AND name='local_filter_receipts'").get();
    const spent = hasReceipts ? ledger.db.prepare(
      "SELECT COUNT(*) n FROM local_filter_receipts WHERE kind='request'").get().n : 0;
    const missing = manifest.batches.filter(batch => !describeLocalFilterAttempt(config, ledger, batch.id).request);
    requireThat(spent + missing.length <= config.localFilter.maxRequests,
      'Local FILTER request budget exhausted for the remaining whole cohort; preserve the original ledger',
      'blocked-budget');
    const directory = join(config.stateDirectory, 'local-e2e', input.runId);
    const handoff = { format: 'filter-proposer-handoff-v1',
      filter: { manifestPath: input.filter.manifestPath,
        resultPaths: manifest.batches.map(batch => join(directory, `${hash(batch.id)}.json`)) },
      routing: input.routing };
    validateRecord(handoff, 'filterProposerHandoff');
    detail.blocker = null;
    if (!detail.dispatchStarted) {
      delete detail.reviewRequired;
      delete detail.review;
    }
    const results = [], resultBytes = [];
    for (const batch of manifest.batches) {
      let attempt = describeLocalFilterAttempt(config, ledger, batch.id);
      if (detail.dispatchStarted) requireThat(detail.results.some(result =>
        result.batchId === batch.id && result.attemptId === attempt.attemptId),
      'Accepted FILTER attempt changed after Proposer release', 'blocked-reconciliation');
      if (!attempt.request && filter && !detail.dispatchStarted) {
        deadline(input);
        detail.state = 'filtering';
        save(ledger, id, detail);
        const outcome = await executeLocalFilterBatch(config, ledger, manifest, batch.id, filterDependencies);
        attempt = describeLocalFilterAttempt(config, ledger, batch.id);
        if (!attempt.request) {
          detail.state = outcome.state ?? 'blocked';
          detail.filterOutcome = outcome;
          detail.blocker = { code: outcome.state ?? 'blocked-reconciliation',
            action: outcome.reason ?? 'FILTER returned without reserving an immutable request; inspect filterOutcome.' };
          return save(ledger, id, detail);
        }
      }
      if (!attempt.request || !attempt.terminal || !attempt.result ||
        attempt.terminal.state !== 'completed' || attempt.terminal.analysisPassed !== true) {
        detail.state = attempt.request ? 'blocked' : 'held-awaiting-filter';
        detail.blocker = { code: attempt.request ? 'blocked-reconciliation' : 'filter-required',
          batchId: batch.id, attemptId: attempt.attemptId,
          action: !attempt.request ? 'Explicitly request --filter to execute the missing batch.'
            : !attempt.terminal ? 'Attempt is active or uncertain. Inspect its existing session; never redispatch it.'
              : 'Terminal attempt has no accepted result. Prepare an explicit predecessor-bound retry; never overwrite receipts.' };
        return save(ledger, id, detail);
      }
      mkdirSync(directory, { recursive: true });
      const path = join(directory, `${hash(attempt.attemptId)}.json`);
      const raw = immutableResult(path, attempt.result);
      results.push({ batchId: batch.id, attemptId: attempt.attemptId, path, sha256: hash(raw) });
      resultBytes.push(raw);
      if (!detail.dispatchStarted) {
        detail.results = [...results];
        save(ledger, id, detail);
      }
    }
    handoff.filter.resultPaths = results.map(result => result.path);
    const execution = reconcileFilterExecutionCohort(config, ledger, manifest, resultBytes);
    requireThat(execution.state === 'complete-held' &&
      execution.batches.length === manifest.batches.length &&
      execution.batches.every(batch => batch.analysisPassed === true),
      'Every current FILTER attempt must pass whole-cohort execution reconciliation', 'blocked-reconciliation');
    const bindingSha256 = hash(json({ inputSha256: detail.inputSha256,
      configSha256: detail.configSha256, results }));
    if (detail.dispatchStarted) requireThat(detail.accepted.bindingSha256 === bindingSha256,
      'Accepted FILTER results changed after Proposer release', 'blocked-reconciliation');
    detail.results = results;
    detail.accepted = { bindingSha256, consolidation: execution.consolidation };
    const selected = execution.consolidation.selected;
    if (!selected) {
      detail.state = 'held-no-candidate';
      detail.blocker = { code: 'no-eligible-candidate',
        action: 'FILTER completed without an eligible candidate; this is not a completed E2E. Review evidence or prepare an explicit reassessment.' };
      return save(ledger, id, detail);
    }
    if (detail.dispatchStarted) {
      if (detail.authRequired && resumeAuth) {
        requireThat(execute && detail.preDispatchAuthSha256 === preDispatchAuthProof(ledger, detail),
          'Auth retry requires the exact positively unstarted assignment', 'blocked-reconciliation');
      } else {
        if (!detail.authRequired || ledger.job(detail.assignment.id)?.state !== 'prepared')
          reconcileProposer(ledger, detail);
        return save(ledger, id, detail);
      }
    } else {
      detail.reviewRequired = { format: 'local-e2e-review-v1', runId: input.runId,
        reviewedBy: '', reviewedAt: now(), decision: 'reject', bindingSha256,
        selectedCandidateKey: selected.key, rationale: '' };
      detail.state = 'held-awaiting-review';
      if (!review) return save(ledger, id, detail);
      if (!acceptReview(input, review, bindingSha256, selected)) {
        detail.state = 'held-review-rejected';
        return save(ledger, id, detail);
      }
      detail.review = review;
    }
    if (!execute) {
      detail.state = 'complete-held';
      return save(ledger, id, detail);
    }
    deadline(input);
    const a = input.authorization, { skill } = validateFilterProposerHandoff(config, handoff);
    requireThat(authorizeCommit && authorizePush && authorizeDraftPR &&
      a.authorizeCommit && a.authorizePush && a.authorizeDraftPR &&
      skill.sideEffects.commit && skill.sideEffects.push && skill.sideEffects.createDraftPR &&
      config.activation.dispatch === true,
    'Execute needs explicit CLI, run and skill commit/push/Draft PR permissions', 'blocked-authorization');
    const sessions = 1 + config.limits.maxValidationRepairRounds;
    requireThat([config.limits.maxAssignments, config.limits.maxWorkers,
      config.limits.workerMaxToolCalls, sessions].every(positive) &&
      Number.isFinite(config.limits.workerMinutes) && config.limits.workerMinutes > 0 &&
      Number.isFinite(config.limits.maxAiCreditsPerSession) && config.limits.maxAiCreditsPerSession > 0 &&
      config.limits.maxAiCreditsPerSession * sessions <= a.maxProposerAiCredits,
    'Finite Proposer limits and whole-run session credit reservation required', 'blocked-budget');
    ledger.transaction(() => {
      const prepared = prepareFilterProposerHandoff(config, ledger, handoff);
      requireThat(prepared.assignment.execution === 'local' && prepared.job.state === 'prepared',
        'Existing or nonlocal Proposer must be reconciled, never redispatched', 'blocked-reconciliation');
      if (detail.assignment) requireThat(detail.assignment.id === prepared.assignment.id &&
        detail.assignment.sha256 === hash(json(prepared.assignment)) &&
        detail.assignment.attemptId === prepared.job.session_id,
      'Prepared Proposer changed during auth recovery', 'blocked-reconciliation');
      if (detail.authRequired) {
        detail.authRequired = false;
        detail.authRetryUsed = true;
      }
      detail.assignment = { id: prepared.assignment.id, sha256: hash(json(prepared.assignment)),
        attemptId: prepared.job.session_id };
      preDispatchAuthProof(ledger, detail);
      detail.dispatchStarted = true;
      detail.reservedProposerAiCredits = config.limits.maxAiCreditsPerSession * sessions;
      detail.state = 'dispatching';
      save(ledger, id, detail);
    });
    const { result, rsi } = await withRsiWorker(config, ledger, detail.assignment.id,
      () => dispatch(config, ledger, detail.assignment.id, dispatchDependencies),
      { kind: 'local-e2e', handoff, filter: detail.accepted }, dispatchDependencies.rsi);
    if (rsi) detail.rsi = rsi;
    if (result.state === 'action-required-auth') {
      requireThat(result.id === detail.assignment.id && result.assignmentId === detail.assignment.id &&
        Array.isArray(result.actions) && result.actions.length > 0,
      'Unrecognized authentication outcome cannot authorize a retry', 'blocked-reconciliation');
      detail.preDispatchAuthSha256 = preDispatchAuthProof(ledger, detail);
      detail.state = 'action-required-auth';
      detail.authRequired = true;
      detail.blocker = { code: 'action-required-auth', actions: result.actions,
        action: detail.authRetryUsed ? 'The single auth retry is exhausted; stop and inspect preserved evidence.'
          : 'Recover authentication externally, then explicitly use --resume-auth with the original execution permissions.' };
    } else reconcileProposer(ledger, detail);
    return save(ledger, id, detail);
  } catch (error) {
    if (!detail) throw error;
    detail.state = 'blocked';
    detail.blocker = { code: error.code ?? 'blocked-reconciliation', action: safeError(error).message };
    return save(ledger, id, detail);
  } finally { ledger.release(id, owner); }
}
