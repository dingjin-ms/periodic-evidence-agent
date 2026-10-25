// Runtime-independent orchestration. Provider code belongs in adapters.
import { readFileSync, realpathSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { hash, now, requireThat, safeError, utc, windowCheck } from './common.js';
import { failureDetails } from './failure-details.js';
import { reviewLoopFailure } from './loop-failure-review.js';

export const loopStages = Object.freeze(['collect', 'filter', 'proposer', 'rsi']);
export const canonical = value => JSON.stringify(value, (_key, item) =>
  item && typeof item === 'object' && !Array.isArray(item)
    ? Object.fromEntries(Object.keys(item).sort().map(key => [key, item[key]])) : item);
export const digest = value => hash(canonical(value));
const positive = n => Number.isSafeInteger(n) && n > 0;
const text = s => typeof s === 'string' && s.trim().length > 0;
const sha = s => typeof s === 'string' && /^[a-f0-9]{64}$/.test(s);
export const loopOperation = (ledger, id) => {
  const value = ledger.db.prepare('SELECT * FROM operations WHERE id=?').get(id);
  return value ? { ...value, detail: JSON.parse(value.detail) } : null;
};

// Search calendar boundaries instead of subtracting 24 hours across DST.
export function previousCalendarDay(occurrence, timeZone) {
  utc(occurrence);
  const formatter = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' });
  const day = ms => {
    const p = Object.fromEntries(formatter.formatToParts(ms).map(p => [p.type, p.value]));
    return p.year + '-' + p.month + '-' + p.day;
  };
  const current = day(Date.parse(occurrence));
  const previous = new Date(Date.parse(current + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
  const start = date => {
    const center = Date.parse(date + 'T00:00:00Z');
    let low = center - 48 * 3600000, high = center + 48 * 3600000;
    while (low < high) {
      const mid = Math.floor((low + high) / 2);
      if (day(mid) < date) low = mid + 1; else high = mid;
    }
    requireThat(day(low) === date, 'Calendar day does not exist in this timezone');
    return new Date(low).toISOString();
  };
  return { start: start(previous), end: start(current) };
}

export function normalizeLoopRequest(input) {
  const request = structuredClone(input);
  requireThat(request.format === 'evidence-loop-v1' && text(request.workflowId) &&
    ['manual', 'scheduled'].includes(request.origin) && text(request.timeZone), 'Invalid loop identity/origin');
  request.window ??= previousCalendarDay(request.occurrence, request.timeZone);
  utc(request.occurrence);
  new Intl.DateTimeFormat('en', { timeZone: request.timeZone });
  windowCheck(request.window);
  request.window = { start: new Date(request.window.start).toISOString(), end: new Date(request.window.end).toISOString() };
  requireThat(text(request.stateOwner?.id) && isAbsolute(request.stateOwner?.directory ?? '') &&
    request.stateOwner.accessApproved === true && positive(request.stateOwner.retentionDays) &&
    request.stateOwner.retentionDays <= 7, 'Approved absolute local state owner and bounded retention required');
  requireThat(sha(request.sourcePolicySha256) && sha(request.executionPolicySha256), 'Policy hashes required');
  requireThat(['capture-only', 'evaluated'].includes(request.rsiMode), 'Explicit RSI mode required');
  requireThat(Array.isArray(request.configuration) && request.configuration.length > 0 &&
    request.configuration.every(p => isAbsolute(p.path ?? '') && sha(p.sha256)), 'Pinned configuration files required');
  for (const stage of loopStages) {
    requireThat(text(request.adapters?.[stage]?.id) && sha(request.adapters[stage].revision), 'Missing adapter binding: ' + stage);
    requireThat(positive(request.budgets?.[stage]?.maxEffects) && positive(request.budgets[stage].timeoutMs),
      'Finite effect/time reservation required: ' + stage, 'blocked-budget');
  }
  utc(request.deadlineAt);
  const { origin, occurrence, ...pins } = request;
  // Config/adapter drift conflicts; it cannot create a replacement for this logical day/policy.
  const runId = 'loop-' + digest({ workflowId: pins.workflowId, timeZone: pins.timeZone, window: pins.window,
    sourcePolicySha256: pins.sourcePolicySha256, executionPolicySha256: pins.executionPolicySha256 }).slice(0, 32);
  return { request, pins, runId, plan: [...loopStages] };
}

export function fileArtifact(path) {
  return { kind: 'file', path: realpathSync(path), sha256: hash(readFileSync(path)) };
}
export function captureArtifact(ledger, value) {
  const body = Buffer.from(canonical(value)), sha256 = hash(body);
  ledger.db.prepare('INSERT OR IGNORE INTO captures VALUES(?,?)').run(sha256, body);
  return { kind: 'capture', sha256 };
}
export function readLoopArtifact(ledger, artifact) {
  requireThat(sha(artifact?.sha256), 'Artifact SHA256 required', 'blocked-reconciliation');
  const bytes = artifact.kind === 'file' && isAbsolute(artifact.path ?? '') ? readFileSync(artifact.path)
    : artifact.kind === 'capture' ? ledger.db.prepare('SELECT body FROM captures WHERE hash=?').get(artifact.sha256)?.body : null;
  requireThat(bytes && hash(bytes) === artifact.sha256, 'Artifact missing or changed', 'blocked-reconciliation');
  return Buffer.from(bytes);
}

const outcomes = { collect: ['collected'], filter: ['eligible', 'no-candidate', 'held'],
  proposer: ['proposed', 'no-candidate', 'held'], rsi: ['captured', 'evaluated'] };
function validateReceipt(ledger, request, receipt) {
  requireThat(receipt?.format === 'loop-role-receipt-v1' && receipt.operationId === request.operationId &&
    receipt.requestSha256 === digest(request) && outcomes[request.stage].includes(receipt.outcome) &&
    Array.isArray(receipt.artifacts) && receipt.artifacts.length > 0 &&
    Array.isArray(receipt.ledgerIds) && receipt.ledgerIds.length > 0 && receipt.ledgerIds.every(text),
  'Invalid role receipt or upstream contract', 'blocked-reconciliation');
  receipt.artifacts.forEach(a => readLoopArtifact(ledger, a));
  if (request.stage === 'rsi') requireThat(receipt.outcome ===
    (request.pins.rsiMode === 'evaluated' ? 'evaluated' : 'captured'), 'RSI mode/result mismatch', 'blocked-reconciliation');
}

export function roleReceipt(request, outcome, artifacts, ledgerIds) {
  return { format: 'loop-role-receipt-v1', operationId: request.operationId,
    requestSha256: digest(request), outcome, artifacts, ledgerIds };
}

export async function runEvidenceLoop(input, ledger, adapters) {
  const { request, pins, runId, plan } = normalizeLoopRequest(input);
  requireThat(realpathSync(ledger.directory) === realpathSync(pins.stateOwner.directory), 'Wrong state owner');
  const lock = 'evidence-loop:' + runId, owner = ledger.acquire(lock);
  const releases = [];
  const receipts = [];
  let activeRole = null;
  let coverage = null, sourceFailureReview = null;
  const report = (state, extra = {}) => ({ format: 'evidence-loop-report-v1', runId, state,
    window: pins.window, plan, pinsSha256: digest(pins),
    ...(coverage ? { coverage } : {}), ...(sourceFailureReview ? { sourceFailureReview } : {}), ...extra });
  const failureReview = async value => {
    if (!activeRole || activeRole.stage === 'rsi') return value;
    try {
      const evidence = await adapters[activeRole.stage].failureEvidence?.(activeRole, ledger) ?? null;
      value.failureReview = reviewLoopFailure(ledger, pins, value, evidence);
    } catch (error) { value.failureReview = { state: 'blocked', ...safeError(error) }; }
    return value;
  };
  const summarizeCollection = async (role, receipt) => {
    if (role.stage !== 'collect' || !adapters.collect.collectionSummary) return;
    coverage = await adapters.collect.collectionSummary(receipt, ledger);
    if (coverage.sourceCoverageComplete === false && coverage.filterReady === true) {
      activeRole = role;
      const observation = report('degraded', { stage: 'collect', code: 'partial-source-coverage',
        action: 'Proceed only with complete source cohorts; excluded sources remain unavailable.', receipts });
      await failureReview(observation);
      sourceFailureReview = observation.failureReview;
    }
  };
  try {
    const slot = 'loop-occurrence:' + digest({ workflowId: pins.workflowId, timeZone: pins.timeZone, window: pins.window });
    ledger.transaction(() => {
      const admission = loopOperation(ledger, slot);
      requireThat(!admission || admission.detail.runId === runId,
        'This occurrence already belongs to another policy; explicit reconciliation required', 'blocked-reconciliation');
      if (!admission) ledger.operation(slot, runId, 'loop-occurrence', { runId });
    });
    const prior = loopOperation(ledger, runId);
    requireThat(!prior || digest(prior.detail.pins) === digest(pins),
      'Loop configuration, owner, budget or adapter drift; reconcile the original run', 'blocked-reconciliation');
    if (!prior) ledger.operation(runId, runId, 'evidence-loop', { pins, state: 'preflight' });
    const audit = runId + ':trigger:' + digest({ origin: request.origin, occurrence: request.occurrence });
    if (!loopOperation(ledger, audit)) {
      ledger.operation(audit, runId, 'loop-trigger-audit', {});
      ledger.finishOperation(audit, 'recorded', { origin: request.origin, occurrence: request.occurrence, observedAt: now() });
    }
    for (const p of pins.configuration) requireThat(hash(readFileSync(p.path)) === p.sha256,
      'Pinned configuration bytes changed', 'blocked-reconciliation');
    for (const stage of plan) {
      const adapter = adapters[stage];
      requireThat(adapter && digest(adapter.binding) === digest(pins.adapters[stage]) &&
        adapter.capabilities.includes(stage) && typeof adapter.resume === 'function' &&
        typeof adapter.verify === 'function', 'Unavailable or changed capability: ' + stage, 'blocked-capability');
      await adapter.preflight({ runId, pins, stage });
    }
    for (const adapter of new Set(plan.map(stage => adapters[stage])))
      if (adapter.acquireRun) releases.push(await adapter.acquireRun({ pins, runId }, ledger));
    const preflightId = runId + ':preflight';
    if (!loopOperation(ledger, preflightId)) {
      ledger.operation(preflightId, runId, 'loop-preflight', {});
      ledger.finishOperation(preflightId, 'recorded', { pinsSha256: digest(pins), plan });
    }
    // Reserve all stages before effects; no recycling reservations after failure.
    ledger.transaction(() => {
      for (const stage of plan) {
        const id = runId + ':reservation:' + stage;
        if (!loopOperation(ledger, id)) ledger.operation(id, runId, 'loop-reservation', pins.budgets[stage]);
      }
    });
    for (const stage of plan) {
      const operationId = runId + ':' + stage;
      const role = { format: 'loop-role-request-v1', operationId, runId, stage, pins,
        upstream: structuredClone(receipts), budget: pins.budgets[stage] };
      activeRole = null;
      const operation = loopOperation(ledger, operationId);
      const filter = receipts.find(r => r.operationId === runId + ':filter');
      const skipped = stage === 'proposer' && filter.outcome !== 'eligible';
      requireThat(!operation || digest(operation.detail.request) === digest(role),
        'Persisted role request changed', 'blocked-reconciliation');
      if (operation?.detail.receipt) {
        activeRole = role;
        validateReceipt(ledger, role, operation.detail.receipt);
        if (!skipped) await adapters[stage].verify(role, operation.detail.receipt, ledger);
        receipts.push(operation.detail.receipt);
        await summarizeCollection(role, operation.detail.receipt);
        continue;
      }
      if (!operation) {
        requireThat(Date.now() < Date.parse(pins.deadlineAt), 'Run admission deadline exhausted', 'blocked-budget');
        ledger.operation(operationId, runId, 'loop-role', { request: role, state: 'intent' });
      }
      activeRole = role;
      const result = skipped ? { state: 'complete', receipt: roleReceipt(role, filter.outcome, filter.artifacts, filter.ledgerIds) }
        : await adapters[stage][operation ? 'resume' : 'execute'](role, ledger);
      requireThat(['complete', 'awaiting-host', 'blocked'].includes(result?.state), 'Invalid adapter outcome', 'blocked-reconciliation');
      if (result.state !== 'complete') {
        requireThat(text(result.code) && text(result.action), 'Adapter hold requires a concrete code/action');
        ledger.finishOperation(operationId, 'started', { request: role, state: result.state, outcome: result });
        const value = report(result.state, { stage, code: result.code, action: result.action,
          ...failureDetails(result), receipts });
        if (result.state === 'blocked') await failureReview(value);
        ledger.finishOperation(runId, 'started', { pins, report: value });
        return value;
      }
      validateReceipt(ledger, role, result.receipt);
      if (!skipped) await adapters[stage].verify(role, result.receipt, ledger);
      ledger.finishOperation(operationId, 'recorded', { request: role, receipt: result.receipt });
      receipts.push(result.receipt);
      await summarizeCollection(role, result.receipt);
    }
    const value = report('complete', { proposer: receipts[2].outcome, rsi: receipts[3].outcome, receipts });
    ledger.finishOperation(runId, 'recorded', { pins, report: value });
    return value;
  } catch (error) {
    const value = report('blocked', { ...safeError(error), reconciliationRequired: true,
      ...(activeRole ? { stage: activeRole.stage, receipts } : {}) });
    await failureReview(value);
    const original = loopOperation(ledger, runId);
    if (original && digest(original.detail.pins) === digest(pins))
      ledger.finishOperation(runId, 'started', { pins, report: value });
    return value;
  } finally {
    try { for (const release of releases.reverse()) release(); }
    finally { ledger.release(lock, owner); }
  }
}
