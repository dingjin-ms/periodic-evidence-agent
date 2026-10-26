import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { hash, json, now, requireThat } from './common.js';
import { executeLocalFilterBatch, localFilterPreflight, reconcileLocalFilterCohort } from './local-filter.js';

const bytes = value => JSON.stringify(value, null, 2) + '\n';
const sha = value => hash(bytes(value));
const operation = (ledger, id) => {
  const row = ledger.db.prepare('SELECT detail FROM operations WHERE id=?').get(id);
  return row ? JSON.parse(row.detail) : null;
};
function receipts(ledger) {
  if (!ledger.db.prepare("SELECT 1 FROM sqlite_master WHERE name='local_filter_receipts'").get()) return [];
  return ledger.db.prepare('SELECT task_id,kind,body FROM local_filter_receipts ORDER BY task_id,kind').all()
    .map(row => ({ ...row, value: JSON.parse(row.body) }));
}
export function localOneShotPreflight(config) {
  const ready = localFilterPreflight(config);
  requireThat(ready.state === 'ready', ready.reason ?? 'Local FILTER is unavailable', ready.state);
  requireThat(!config.localFilter.retry && !(config.localFilter.cohortRetries ?? []).length,
    'One-shot local FILTER does not authorize retry forks; reconcile the original cohort', 'blocked-reconciliation');
}
export function prepareLocalOneShotBudget(config, ledger, input, manifest, id) {
  localOneShotPreflight(config);
  return ledger.transaction(() => {
    const prior = operation(ledger, id);
    if (prior) {
      requireThat(prior.executor === 'local-sdk' && prior.inputSha256 === hash(json(input)) &&
        prior.configSha256 === hash(json(config)), 'Local FILTER budget pins changed', 'blocked-reconciliation');
      return prior;
    }
    requireThat(Date.now() < Date.parse(input.authorization.deadlineAt), 'FILTER authorization expired', 'blocked-budget');
    requireThat(!receipts(ledger).some(row => row.kind === 'request') &&
      !ledger.db.prepare("SELECT 1 FROM operations WHERE kind='one-shot-filter-budget'").get() &&
      (!ledger.db.prepare("SELECT 1 FROM sqlite_master WHERE name='agency_requests'").get() ||
        !ledger.db.prepare('SELECT 1 FROM agency_requests').get()),
    'Local FILTER requires an unused isolated execution ledger; no retroactive or cross-executor admission', 'blocked-reconciliation');
    const requests = manifest.batches.map(batch => ({ taskId: batch.id,
      payloadSha256: batch.payloadSha256, inputTokens: batch.tokenReceipt.tokens,
      outputTokens: manifest.budget.reserves.output, executionSeconds: Math.ceil(config.localFilter.timeoutMs / 1000) }));
    const reserved = requests.reduce((sum, r) => ({ filterRequests: sum.filterRequests + 1,
      filterExecutionSeconds: sum.filterExecutionSeconds + r.executionSeconds,
      filterReservedTokens: sum.filterReservedTokens + r.inputTokens + r.outputTokens,
      filterAiCredits: sum.filterAiCredits + config.limits.maxAiCreditsPerSession }),
    { filterRequests: 0, filterExecutionSeconds: 0, filterReservedTokens: 0, filterAiCredits: 0 });
    const a = input.authorization;
    requireThat(config.localFilter.maxRequests <= a.maxFilterRequests &&
      reserved.filterRequests <= a.maxFilterRequests && reserved.filterExecutionSeconds <= a.maxFilterExecutionSeconds &&
      reserved.filterReservedTokens <= a.maxFilterReservedTokens && Number.isFinite(a.maxFilterAiCredits) &&
      a.maxFilterAiCredits > 0 && reserved.filterAiCredits <= a.maxFilterAiCredits &&
      Object.values(reserved).every(Number.isSafeInteger),
    'Whole local FILTER cohort exceeds its explicit request/time/token/soft-credit reservation', 'blocked-budget');
    const budget = { format: 'one-shot-filter-budget-v1', executor: 'local-sdk', state: 'reserved-not-submitted',
      dispatchAllowed: false, inputSha256: hash(json(input)), configSha256: hash(json(config)),
      reservedAt: now(), requests, reserved, creditLimit: 'explicitly-accepted-soft-limit' };
    ledger.operation(id, input.collection.runId, 'one-shot-filter-budget', budget);
    ledger.finishOperation(id, 'reserved', budget);
    return budget;
  });
}

export function acceptLocalOneShotCohort(config, ledger, input, manifest, collected, budget, resultBytes) {
  localOneShotPreflight(config);
  requireThat(budget.executor === 'local-sdk', 'FILTER executor changed', 'blocked-reconciliation');
  const rows = receipts(ledger), requests = rows.filter(row => row.kind === 'request');
  requireThat(requests.length === manifest.batches.length && requests.every(row =>
    manifest.batches.some(batch => batch.id === row.task_id)), 'Local FILTER cohort has missing or foreign attempts', 'blocked-reconciliation');
  for (const { task_id: taskId, value: request } of requests) {
    const planned = budget.requests.find(value => value.taskId === taskId);
    const intent = operation(ledger, 'one-shot-local:' + taskId);
    requireThat(intent?.budgetSha256 === hash(json(budget)) && planned &&
      request.payloadSha256 === planned.payloadSha256 && request.requestedModel === manifest.budget.model &&
      request.manifestSha256 === sha(manifest) &&
      Date.parse(request.requestedAt) >= Math.max(Date.parse(collected.completedAt), Date.parse(budget.reservedAt),
        Date.parse(input.authorization.approvedAt)) && Date.parse(request.requestedAt) < Date.parse(input.authorization.deadlineAt),
    'Local FILTER must retain its original post-collection intent and immutable request', 'blocked-reconciliation');
  }
  // This gate reconstructs model submissions, source read pages, session events,
  // terminal receipts and exact result membership. A JSON result alone is insufficient.
  const cohort = reconcileLocalFilterCohort(config, ledger, manifest, resultBytes);
  requireThat(cohort.state === 'complete-held', 'Local FILTER execution is incomplete or unqualified', 'blocked-reconciliation');
  return { collectionReceiptSha256: input.collection.receiptSha256, manifestSha256: input.filter.manifestSha256,
    results: input.filter.resultPaths.map((path, i) => ({ path, sha256: hash(resultBytes[i]) })),
    requests: requests.map(row => ({ taskId: row.task_id, requestSha256: sha(row.value),
      receiptSha256: hash(json(rows.filter(r => r.task_id === row.task_id))),
      sessionId: rows.find(r => r.task_id === row.task_id && r.kind === 'session')?.value.sessionId })),
    reserved: budget.reserved, aggregateReservationSha256: hash(json(budget)),
    sourceCoverageComplete: collected.sourceCoverageComplete,
    ...(collected.sourceFailurePolicy ? { eligibleSourceKinds: collected.eligibleSourceKinds,
      missingSources: collected.missingSources, selectedSourceCoverageComplete: true } : {}),
    semanticAnalysisVerifiedByHelper: false, cohort };
}

export async function executeLocalOneShotCohort(config, ledger, input, manifest, budget, dependencies = {}) {
  localOneShotPreflight(config);
  const lock = 'one-shot-local-cohort:' + manifest.cohortId, owner = ledger.acquire(lock);
  try {
    for (const [index, batch] of manifest.batches.entries()) {
      const id = 'one-shot-local:' + batch.id, prior = operation(ledger, id);
      if (prior) requireThat(prior.budgetSha256 === hash(json(budget)), 'Local FILTER intent changed', 'blocked-reconciliation');
      else {
        requireThat(Date.now() < Date.parse(input.authorization.deadlineAt), 'Local FILTER start deadline expired', 'blocked-budget');
        requireThat(!receipts(ledger).some(row => row.task_id === batch.id), 'Unowned local FILTER attempt exists', 'blocked-reconciliation');
        ledger.operation(id, input.collection.runId, 'one-shot-local-filter', { budgetSha256: hash(json(budget)) });
        await executeLocalFilterBatch(config, ledger, manifest, batch.id, dependencies);
      }
      const rows = receipts(ledger).filter(row => row.task_id === batch.id);
      const terminal = rows.find(row => row.kind === 'terminal')?.value;
      const analysis = rows.find(row => row.kind === 'analysis')?.value;
      requireThat(terminal?.state === 'completed' && analysis,
        'Original local FILTER attempt is blocked or uncertain; no automatic model retry', 'blocked-reconciliation');
      const content = bytes(analysis.result);
      const checked = reconcileLocalFilterCohort(config, ledger, manifest, [content]);
      requireThat(checked.batches.find(row => row.batchId === batch.id)?.analysisPassed,
        'Local FILTER result lacks accepted execution receipts', 'blocked-reconciliation');
      const path = input.filter.resultPaths[index];
      if (existsSync(path)) requireThat(readFileSync(path, 'utf8') === content, 'Local FILTER result file changed', 'blocked-reconciliation');
      else writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
    }
    return { state: 'complete-held', dispatchAllowed: false };
  } finally { ledger.release(lock, owner); }
}
