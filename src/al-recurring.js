import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configAt, hash, json, now, requireThat, safeError, utc, windowCheck } from './common.js';
import { Ledger } from './ledger.js';
import { previousUtcDay } from './coordinator.js';
import { beginOneShotCollection, advanceOneShotCollection, readOneShotCollectionReceipt } from './one-shot-collection.js';
import { loadFilterCorpus } from './filter.js';
import { alOwners, alReference, inspectAlNativeProof, requireAlQualification } from './al-adapter.js';
import { requireAlRepository } from './al-capabilities.js';
import { pinnedInput, runAlWorkflow, reconcileAlFilter, requireAlFilter, requireAlProposerSkills } from './al-workflow.js';
import { observeAlDraft } from './al-pr-lifecycle.js';

const put = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
const integer = value => Number.isSafeInteger(value) && value >= 0;
const finished = new Set(['complete', 'no-new-evidence', 'superseded-source-cycle']);
const record = row => row && { ...JSON.parse(row.detail), state: row.state };
const load = (ledger, id) => record(ledger.db.prepare('SELECT state,detail FROM operations WHERE id=?').get(id));
function loadCycle(ledger, id) {
  const value = record(ledger.db.prepare(
    "SELECT state,detail FROM operations WHERE id=? AND kind='al-recurring-cycle'").get(id));
  requireThat(value, 'Unknown recurring cycle', 'blocked-reconciliation');
  return value;
}
function save(ledger, cycle, state, detail = {}) {
  const value = { ...cycle, ...detail, state, updatedAt: now() };
  ledger.finishOperation(cycle.id, state, value);
  return value;
}
function copyConfig(config, path) {
  const copy = structuredClone(config);
  for (const repo of copy.repositories) for (const gate of repo.validationGates ?? [])
    if (gate.profilePath) gate.profilePath = relative(dirname(path), gate.profilePath);
  put(path, copy);
}
function verifyCollection(cycle) {
  pinnedInput(cycle.collectorConfig);
  const config = configAt(cycle.collectorConfig.path);
  const db = new DatabaseSync(join(config.stateDirectory, 'ledger.sqlite'), { readOnly: true });
  try {
    const receipt = readOneShotCollectionReceipt(config, { db }, cycle.id.slice('al-cycle:'.length, 'al-cycle:'.length + 20),
      cycle.collectionReceiptSha256);
    requireThat(json(receipt) === json(cycle.collection),
      'Recurring collected cohort changed after acceptance', 'blocked-reconciliation');
  } finally { db.close(); }
}
export function requireRecurringAuthority(plan, reference, authority, time = Date.now(), allowExpired = false) {
  requireThat(plan.format === 'al-recurring-plan-v1' && authority.format === 'al-recurring-authorization-v1' &&
    authority.planSha256 === reference.sha256 && typeof authority.approvedBy === 'string' &&
    authority.approvedBy.trim().length > 0 && Date.parse(authority.approvedAt) <= time &&
    Date.parse(authority.expiresAt) > Date.parse(authority.approvedAt) &&
    (allowExpired || Date.parse(authority.expiresAt) > time) &&
    ['maxCycles', 'maxTotalModelSessions', 'maxTotalAiCredits', 'maxTotalDrafts']
      .every(key => integer(authority[key])) &&
    authority.maxCycles > 0 &&
    ['allowCollection', 'allowModels', 'allowPublication', 'stopAfterFirstSuitableDraftPR']
      .every(key => typeof authority[key] === 'boolean') &&
    [plan.limits.maxItems, plan.limits.maxCalls, plan.limits.maxFilterSessions,
      plan.limits.maxProposers, plan.limits.maxWindowHours].every(integer) &&
    plan.limits.maxItems > 0 && plan.limits.maxCalls > 0 && plan.limits.maxWindowHours > 0 &&
    plan.limits.maxProposers <= 1 && plan.limits.maxAiCreditsPerSession === 30,
  'AL recurring execution needs a new finite plan-bound authorization, not historical E2E permission',
  'blocked-authorization');
  utc(authority.approvedAt); utc(authority.expiresAt);
}
function grantId(reference) { return `al-grant:${reference.sha256}`; }
function syncGrant(ledger, reference, authority, terminal = null) {
  const id = grantId(reference), previous = load(ledger, id);
  const cycles = ledger.db.prepare("SELECT state,detail FROM operations WHERE kind='al-recurring-cycle'")
    .all().map(record).filter(value => value.authorization.sha256 === reference.sha256);
  const reservations = ledger.db.prepare("SELECT detail FROM operations WHERE kind='al-cycle-model-budget'")
    .all().map(row => JSON.parse(row.detail)).filter(value => value.authorizationSha256 === reference.sha256);
  requireThat(reservations.every(value => integer(value.count) && value.count > 0 &&
    value.credits === value.count * 30),
  'Invalid durable recurring session/credit reservation', 'blocked-budget');
  const sessions = reservations.reduce((sum, value) => sum + value.count, 0);
  const credits = reservations.reduce((sum, value) => sum + value.credits, 0);
  requireThat(integer(sessions) && integer(credits), 'Invalid durable recurring reservation accounting', 'blocked-budget');
  const publicationsReserved = reservations.filter(value => value.purpose === 'proposer').length;
  const publications = cycles.filter(value => value.stages.propose).length;
  const stop = terminal ?? (previous && ['stopped', 'exhausted', 'expired'].includes(previous.state) ? previous : null);
  let state = stop?.state ?? 'active', reason = stop?.reason ?? null;
  if (!stop && Date.parse(authority.expiresAt) <= Date.now()) {
    state = 'expired'; reason = 'authorization-expired';
  } else if (!stop && authority.stopAfterFirstSuitableDraftPR && publications > 0) {
    state = 'stopped'; reason = 'first-suitable-draft';
  } else if (!stop && cycles.length >= authority.maxCycles && cycles.every(value => finished.has(value.state))) {
    state = 'exhausted'; reason = 'cycle-allowance-exhausted';
  }
  const value = { id, authorization: reference, planSha256: authority.planSha256, state, reason,
    cycles: cycles.length, modelSessionsReserved: sessions, aiCreditsReserved: credits,
    publicationsReserved, publications, expiresAt: authority.expiresAt,
    cyclesRemaining: Math.max(0, authority.maxCycles - cycles.length),
    modelSessionsRemaining: Math.max(0, authority.maxTotalModelSessions - sessions),
    aiCreditsRemaining: Math.max(0, authority.maxTotalAiCredits - credits),
    accounting: 'Conservative non-refundable reservations; AI credit ceilings remain soft, not actual billing.',
    updatedAt: now() };
  if (!previous) ledger.operation(id, id, 'al-recurring-grant', value);
  ledger.finishOperation(id, state, value);
  return value;
}
export function reserveAlCycleModels(ledger, cycle, plan, reference, authority, stage, count, root) {
  requireRecurringAuthority(plan, cycle.plan, authority);
  requireThat(['filter', 'propose'].includes(stage), 'Unknown recurring model stage', 'blocked-config');
  const grant = syncGrant(ledger, reference, authority);
  requireThat(grant.state === 'active', `Recurring grant is ${grant.state}: ${grant.reason}`, 'blocked-authorization');
  requireThat(authority.allowModels && integer(count) && count > 0 &&
    count <= (stage === 'filter' ? plan.limits.maxFilterSessions : plan.limits.maxProposers),
  'Recurring per-cycle model budget is unavailable', 'blocked-budget');
  const credits = count * plan.limits.maxAiCreditsPerSession;
  const totalReserved = grant.modelSessionsReserved + count, totalCreditsReserved = grant.aiCreditsReserved + credits;
  if (!integer(credits) || !integer(totalReserved) || !integer(totalCreditsReserved) ||
    totalReserved > authority.maxTotalModelSessions || totalCreditsReserved > authority.maxTotalAiCredits) {
    syncGrant(ledger, reference, authority, { state: 'exhausted', reason: 'model-or-credit-allowance-exhausted' });
    requireThat(false, 'Recurring cumulative model/AI-credit reservation ceiling exceeded', 'blocked-budget');
  }
  if (stage === 'propose') {
    requireThat(authority.allowPublication, 'Recurring publication is not authorized', 'blocked-authorization');
    if (grant.publicationsReserved >= (authority.stopAfterFirstSuitableDraftPR ? 1 : authority.maxTotalDrafts) ||
      grant.publicationsReserved >= authority.maxTotalDrafts) {
      syncGrant(ledger, reference, authority, { state: 'exhausted', reason: 'publication-allowance-exhausted' });
      requireThat(false, 'Recurring publication stop or Draft budget reached', 'blocked-budget');
    }
  }
  const reservationId = `${cycle.id}:${stage}:models`, purpose = stage === 'filter' ? 'filter' : 'proposer';
  const reservation = { authorizationSha256: reference.sha256, runDirectory: root, purpose, count, credits,
    totalReserved, totalCreditsReserved, accounting: 'Reserved capacity, not claimed model starts or actual billing' };
  ledger.transaction(() => {
    ledger.operation(reservationId, cycle.id, 'al-cycle-model-budget', reservation);
    ledger.finishOperation(reservationId, 'reserved', reservation);
    syncGrant(ledger, reference, authority);
  });
  return { format: 'al-recurring-model-allocation-v1', model: 'gpt-6-luna', authorization: reference,
    ledgerPath: join(plan.stateDirectory, 'ledger.sqlite'), reservationId, runDirectory: root,
    maxAdditionalSessions: count, purposes: [purpose], deadlineAt: authority.expiresAt };
}
export function priorAlCandidateWork(ledger, cycle, selected) {
  requireThat(typeof selected?.key === 'string' && selected.key.length > 0,
    'Selected candidate lacks the native FILTER invariant identity', 'blocked-reconciliation');
  return ledger.db.prepare("SELECT state,detail FROM operations WHERE kind='al-recurring-cycle'")
    .all().map(record).filter(value => value.id !== cycle.id && value.repoId === cycle.repoId && value.stages.filter)
    .flatMap(value => {
      const prior = pinnedInput(value.stages.filter.result).reconciliation.consolidation.selected;
      return prior?.key === selected.key ? [{ cycleId: value.id, state: value.state,
        filter: value.stages.filter.result, handoff: value.stages.propose ?? value.stages.prepare ?? null }] : [];
    });
}
export function requireUnstartedAlFilter(config, manifestReference) {
  const manifestSha256 = hash(json(pinnedInput(manifestReference)));
  const path = join(config.stateDirectory, 'ledger.sqlite');
  if (!existsSync(path)) return;
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE name='local_filter_receipts'").get();
    requireThat(!table || !db.prepare(`SELECT 1 FROM local_filter_receipts WHERE kind='request'
      AND json_extract(body,'$.manifestSha256')=? LIMIT 1`).get(manifestSha256),
    'FILTER already has native requests; reconcile existing execution instead of reserving retrospectively',
    'blocked-reconciliation');
  } finally { db.close(); }
}
function requireStageInput(cycle, stage, input) {
  const previous = cycle.stages;
  if (stage === 'batch') {
    const batch = pinnedInput(input.batchRequest);
    requireThat(json(batch.sources) === json(cycle.collection.snapshot.sources),
      'Recurring batching must retain the complete authenticated cohort', 'blocked-reconciliation');
  } else {
    requireThat(previous.batch, 'Complete batch preparation is required', 'blocked-reconciliation');
    requireThat(input.manifest?.path === join(previous.batch.runDirectory, 'manifest.json') &&
      alReference(input.manifest.path).sha256 === input.manifest.sha256,
    'Recurring FILTER manifest differs from this cycle', 'blocked-reconciliation');
  }
  if (['prepare', 'propose'].includes(stage)) {
    requireThat(previous.filter, 'Complete FILTER reconciliation is required', 'blocked-reconciliation');
    const filtered = pinnedInput(previous.filter.result);
    requireThat(json(input.results) === json(filtered.results),
      'Recurring handoff must use every original FILTER result', 'blocked-reconciliation');
  }
  requireThat(input.filterConfig?.sha256 === cycle.filterConfig.sha256 &&
    input.filterConfig.path === cycle.filterConfig.path,
  'Recurring stage changed the bound FILTER configuration', 'blocked-reconciliation');
}
function verifyStageReceipt(ledger, cycle, stage, plan) {
  requireThat(['batch', 'filter', 'prepare', 'propose'].includes(stage),
    'Unknown recurring stage recovery', 'blocked-reconciliation');
  const operation = load(ledger, `${cycle.id}:${stage}`), input = operation?.input;
  requireThat(input && input.runDirectory === join(cycle.root, stage),
    'No original stage intent is available; never reconstruct an execution', 'blocked-reconciliation');
  const requestPath = join(input.runDirectory, 'request.json'), resultPath = join(input.runDirectory, 'result.json');
  if (cycle.stages[stage]) {
    requireThat(cycle.stages[stage].result.path === resultPath,
      'Completed stage result path differs from its original intent', 'blocked-reconciliation');
    pinnedInput(cycle.stages[stage].result);
  }
  requireThat(existsSync(requestPath) && existsSync(resultPath),
    'Native stage has no complete terminal; use its existing diagnostic/continuation interface, not an automatic retry',
    'blocked-reconciliation');
  requireThat(json(JSON.parse(readFileSync(requestPath, 'utf8'))) === json(input),
    'Native stage request differs from durable intent', 'blocked-reconciliation');
  verifyCollection(cycle);
  requireStageInput(cycle, stage, input);
  const result = pinnedInput(alReference(resultPath));
  if (stage === 'batch') {
    const manifest = JSON.parse(readFileSync(join(input.runDirectory, 'manifest.json'), 'utf8'));
    requireAlFilter(configAt(cycle.filterConfig.path), manifest);
    requireThat(json(manifest.request.sources) === json(cycle.collection.snapshot.sources),
      'Recovered batch changed its complete cohort', 'blocked-reconciliation');
  } else if (stage === 'filter') {
    requireThat(json(result.filterConfig) === json(input.filterConfig) && json(result.manifest) === json(input.manifest),
      'Recovered FILTER changed its cycle binding', 'blocked-reconciliation');
    const checked = reconcileAlFilter(result);
    requireThat(json(checked.result) === json(result.reconciliation),
      'Recovered FILTER differs from native execution reconciliation', 'blocked-reconciliation');
  } else {
    requireThat(json(input.templateConfig) === json(plan.templateConfig) &&
      json(input.qualification) === json(plan.qualification),
    'Completed native stage differs from the qualified cycle plan', 'blocked-reconciliation');
    const template = pinnedInput(plan.templateConfig);
    const qualified = pinnedInput(plan.qualification);
    // Bookkeeping binds the original qualified profile, not a later installed profile.
    requireAlQualification(qualified, { ...template.repositories[0], validationGates: [{
      id: 'al-four-owner-native', executable: template.repositories[0].validationGates[0].executable,
      profileSha256: qualified.profile.sha256, testRebuiltOutputPaths: alOwners.map(owner => `${owner.path}/dist`)
    }] });
    const db = new DatabaseSync(join(plan.workerStateDirectory ?? join(plan.stateDirectory, 'workers'),
      'ledger.sqlite'), { readOnly: true });
    try {
      const assignment = db.prepare("SELECT body FROM records WHERE kind='assignment' AND id=? ORDER BY version DESC LIMIT 1")
        .get(result.assignment?.id);
      const job = db.prepare('SELECT id,state,repo,base_revision FROM jobs WHERE id=?').get(result.assignment?.id);
      requireThat(assignment && job && json(JSON.parse(assignment.body)) === json(result.assignment),
        'Recovered handoff is not the original native assignment', 'blocked-reconciliation');
      if (stage === 'prepare') requireThat(result.state === 'prepared', 'Native preparation did not complete', 'blocked-reconciliation');
      else {
        const selected = pinnedInput(cycle.stages.filter.result).reconciliation.consolidation.selected;
        requireThat(result.state === 'draft-pr-validated' && job.state === 'completed' &&
          job.repo === cycle.repoId && job.base_revision === cycle.revision &&
          Array.isArray(selected?.evidenceIds) &&
          result.assignment.repoId === cycle.repoId && result.result?.assignmentId === result.assignment.id &&
          result.result.recordType === 'workerResult' && result.result.outcome === 'draft-pr-validated' &&
          json([...result.assignment.evidenceIds].sort()) === json([...selected.evidenceIds].sort()) &&
          json([...result.result.evidenceIds].sort()) === json([...selected.evidenceIds].sort()) &&
          result.result?.draftPR?.isDraft === true &&
          result.result.draftPR.headRevision === result.result.sourceRevision,
        'Native publisher did not complete an exact-head Draft', 'blocked-reconciliation');
        const published = db.prepare('SELECT body FROM records WHERE kind=? AND id=? ORDER BY version DESC LIMIT 1')
          .get(result.result.recordType, result.result.id);
        requireThat(published && json(JSON.parse(published.body)) === json(result.result),
          'Recovered publisher result is not recorded in the native ledger', 'blocked-reconciliation');
        inspectAlNativeProof(result.result.validation, result.result.sourceRevision, 'candidate',
          qualified.profile.sha256);
      }
    } finally { db.close(); }
  }
  return { input, result, resultPath, requestPath };
}
function reconcileStage(ledger, cycle, stage, plan) {
  const { input, resultPath, requestPath } = verifyStageReceipt(ledger, cycle, stage, plan);
  if (cycle.stages[stage]) return cycle;
  const completed = { runDirectory: input.runDirectory, result: alReference(resultPath), reconciled: true,
    recovery: { sourceReads: 0, modelCalls: 0, publicationCalls: 0, request: alReference(requestPath) } };
  ledger.finishOperation(`${cycle.id}:${stage}`, 'completed', { ...completed, input });
  const budget = load(ledger, `${cycle.id}:${stage}:models`);
  if (budget) ledger.finishOperation(`${cycle.id}:${stage}:models`, 'consumed-or-held', budget);
  return save(ledger, cycle, cycle.state === 'stopped' ? 'stopped' : `${stage}-complete`,
    { stages: { ...cycle.stages, [stage]: completed } });
}
function verifyCompletedCycle(ledger, cycle, plan) {
  requireThat(cycle.collection && (!cycle.unseenEvidenceIds.length || cycle.stages.filter),
    'A nonempty new cohort needs complete FILTER before the cursor advances', 'blocked-reconciliation');
  verifyCollection(cycle);
  if (cycle.stages.filter) {
    verifyStageReceipt(ledger, cycle, 'batch', plan);
    const filtered = verifyStageReceipt(ledger, cycle, 'filter', plan).result;
    requireThat(!filtered.reconciliation.consolidation.selected || cycle.stages.propose,
      'Selected candidate remains held; prepare/publish under current authority or reconcile explicitly before closing',
      'blocked-reconciliation');
    if (filtered.reconciliation.consolidation.selected)
      verifyStageReceipt(ledger, cycle, 'propose', plan);
  }
}
function reconcileCoveredCompletion(ledger, cycle, plan) {
  requireThat(cycle.state === 'stopped',
    'Covered completion recovery requires an explicitly stopped legacy cycle', 'blocked-reconciliation');
  verifyCompletedCycle(ledger, cycle, plan);
  const key = `al:${cycle.repoId}`;
  const expected = ledger.db.prepare('SELECT value FROM cursors WHERE source=?').get(key)?.value;
  requireThat(expected !== undefined, 'Legacy completion has no covering cursor', 'blocked-reconciliation');
  const cursor = JSON.parse(expected);
  windowCheck(cursor); windowCheck(cycle.window);
  requireThat(Date.parse(cycle.window.end) <= Date.parse(cursor.end),
    'Legacy completion is not already covered by the current cursor', 'blocked-reconciliation');
  return ledger.transaction(() => {
    requireThat(json(loadCycle(ledger, cycle.id)) === json(cycle) &&
      ledger.db.prepare('SELECT value FROM cursors WHERE source=?').get(key)?.value === expected,
    'Cycle or cursor changed during legacy completion recovery', 'blocked-reconciliation');
    for (const id of cycle.evidenceIds)
      requireThat(load(ledger, `al-seen:${cycle.repoId}:${cycle.revision}:${id}`)?.state === 'reviewed',
        'Legacy completion has unreviewed evidence; no cursor or dedup repair is inferred', 'blocked-reconciliation');
    return save(ledger, cycle, cycle.unseenEvidenceIds.length ? 'complete' : 'no-new-evidence',
      { completionRecovery: { sourceReads: 0, modelCalls: 0, publicationCalls: 0,
        cursorUnchanged: true, reviewedEvidenceUnchanged: true } });
  });
}

// An invocation is one bounded existing-controller action. Cadence belongs to the operator.
export async function runAlRecurring(request, { collectionDependencies = {} } = {}) {
  requireThat(['inspect', 'begin', 'status', 'stop', 'collect', 'batch', 'filter', 'prepare', 'propose', 'finish',
    'observe-pr', 'reconcile-stage', 'grant-status', 'stop-grant']
    .includes(request.action), 'Unknown AL recurring action', 'blocked-config');
  const plan = pinnedInput(request.plan);
  pinnedInput(plan.collectorConfig); pinnedInput(plan.filterConfig); pinnedInput(plan.templateConfig);
  const config = configAt(plan.collectorConfig.path), filter = configAt(plan.filterConfig.path);
  const template = configAt(plan.templateConfig.path);
  requireAlProposerSkills(template);
  requireThat(config.executionMode === 'app-native' &&
    [config, filter, template].every(value => value.schedule.enabled === false),
  'Recurring AL requires app-native collection and disabled source/FILTER/native schedules',
  'blocked-config');
  requireThat(plan.format === 'al-recurring-plan-v1' && isAbsolute(plan.stateDirectory) &&
    Array.isArray(plan.passes) && new Set(plan.passes).size === plan.passes.length &&
    config.statePolicy.accessApproved === true &&
    (plan.workerStateDirectory === undefined || isAbsolute(plan.workerStateDirectory)) &&
    template.repositories.length === 1 && filter.repositories.length === 1,
  'Recurring AL needs approved durable state and one bound repository', 'blocked-config');
  const repo = template.repositories[0];
  requireAlRepository(repo);
  const enabledSources = Object.entries(config.sources).filter(([, source]) => source.enabled).map(([kind]) => kind);
  requireThat(filter.repositories[0].id === repo.id && filter.repositories[0].remote === repo.remote &&
    filter.repositories[0].baseRef === repo.baseRef && plan.repoId === repo.id &&
    enabledSources.length > 0 && enabledSources.every(kind => ['ado', 'workiq'].includes(kind) &&
      plan.passes.includes(`${kind}:created`) && plan.passes.includes(`${kind}:changed`)) &&
    plan.passes.every(pass => enabledSources.some(kind => [`${kind}:created`, `${kind}:changed`].includes(pass))),
  'Recurring AL repository/source routing or created/changed coverage differs', 'blocked-owner');
  if (request.action === 'inspect') return { state: 'configured-not-activated', repoId: repo.id,
    revision: repo.baseRef, enabled: plan.enabled === true, modelCalls: 0, publication: false,
    required: 'Finite new recurring authorization; operator cadence; native qualification; external exact-head PR/CI follow-through' };
  const ledger = new Ledger(plan.stateDirectory);
  let owner, cycle;
  try {
    if (request.action === 'status') return request.cycleId ? loadCycle(ledger, request.cycleId) :
      ledger.db.prepare("SELECT id,state,detail FROM operations WHERE kind='al-recurring-cycle'").all().map(record);
    owner = ledger.acquire('coordinator');
    if (['grant-status', 'stop-grant'].includes(request.action)) {
      const authority = pinnedInput(request.authorization);
      requireRecurringAuthority(plan, request.plan, authority, Date.now(), true);
      requireThat(load(ledger, grantId(request.authorization)), 'Unknown recurring grant', 'blocked-reconciliation');
      return syncGrant(ledger, request.authorization, authority,
        request.action === 'stop-grant' ? { state: 'stopped', reason: 'operator-stop' } : null);
    }
    if (request.action === 'stop') {
      cycle = loadCycle(ledger, request.cycleId);
      if (finished.has(cycle.state)) return cycle;
      return save(ledger, cycle, 'stopped');
    }
    if (request.action === 'reconcile-stage') {
      cycle = loadCycle(ledger, request.cycleId);
      requireThat(cycle?.plan.sha256 === request.plan.sha256,
        'Unknown or differently configured cycle', 'blocked-reconciliation');
      const authority = pinnedInput(cycle.authorization);
      requireRecurringAuthority(plan, cycle.plan, authority, Date.now(), true);
      const reconciled = request.stage === 'completion'
        ? reconcileCoveredCompletion(ledger, cycle, plan)
        : reconcileStage(ledger, cycle, request.stage, plan);
      syncGrant(ledger, cycle.authorization, authority);
      return reconciled;
    }
    const authority = pinnedInput(request.authorization);
    requireRecurringAuthority(plan, request.plan, authority, Date.now(), true);
    requireThat(plan.enabled === true, 'AL recurring plan is disabled', 'blocked-authorization');
    const grant = syncGrant(ledger, request.authorization, authority);
    if (request.action !== 'finish') {
      requireThat(grant.state !== 'expired', 'Recurring authorization expired', 'blocked-authorization');
      if (!['begin', 'observe-pr'].includes(request.action))
        requireThat(grant.state === 'active', `Recurring grant is ${grant.state}: ${grant.reason}`, 'blocked-authorization');
    }
    if (request.action === 'begin') {
      const window = request.window ?? previousUtcDay();
      windowCheck(window);
      requireThat(Date.parse(window.end) <= Date.now() &&
        Date.parse(window.end) - Date.parse(window.start) <= plan.limits.maxWindowHours * 3600000,
      'Recurring windows must be complete and explicitly bounded', 'blocked-budget');
      const id = `al-cycle:${hash(json([repo.id, request.plan.sha256, window, request.predecessor ?? null]))}`;
      cycle = load(ledger, id);
      if (cycle) {
        requireThat(cycle.authorization.sha256 === request.authorization.sha256,
          'Existing cycle authorization is immutable', 'blocked-reconciliation');
        return cycle;
      }
      requireThat(grant.state === 'active',
        `Recurring grant is ${grant.state}: ${grant.reason}`, 'blocked-authorization');
      const cycles = ledger.db.prepare("SELECT state,detail FROM operations WHERE kind='al-recurring-cycle'")
        .all().map(record);
      requireThat(!authority.stopAfterFirstSuitableDraftPR || !cycles.some(value =>
        value.authorization.sha256 === request.authorization.sha256 && value.stages.propose),
      'Recurring authorization stopped after its first suitable Draft; a remaining budget is not a new grant',
      'blocked-authorization');
      let predecessor;
      if (request.predecessor) {
        predecessor = cycles.find(value => value.id === request.predecessor);
        requireThat(request.recoveryApproved === true && typeof request.reason === 'string' &&
          request.reason.trim().length >= 10 && predecessor?.repoId === repo.id &&
          predecessor.revision === repo.baseRef &&
          ['blocked', 'stopped'].includes(predecessor.state) && json(predecessor.window) === json(window) &&
          !ledger.db.prepare("SELECT 1 FROM operations WHERE job_id=? AND kind='al-cycle-model-budget'")
            .get(predecessor.id),
        'Bounded source successor needs explicit diagnosis and no model/publication reservation; reconcile uncertain model work separately',
        'blocked-reconciliation');
      }
      requireThat(!cycles.some(value => !finished.has(value.state) && value.id !== predecessor?.id),
        'An earlier cycle needs completion/reconciliation; no overlapping cycle', 'overlap');
      requireThat(cycles.filter(value => value.authorization.sha256 === request.authorization.sha256).length <
        authority.maxCycles, 'Recurring cycle allowance exhausted', 'blocked-budget');
      const cursor = ledger.cursor(`al:${repo.id}`);
      requireThat(window.start === (cursor?.end ?? plan.firstWindowStart),
        'Recurring coverage gap/overlap requires explicit operator catch-up', 'blocked-reconciliation');
      const root = join(plan.stateDirectory, 'c', id.slice('al-cycle:'.length, 'al-cycle:'.length + 16));
      requireThat(!existsSync(root), 'Unreconciled recurring directory already exists', 'blocked-reconciliation');
      mkdirSync(root, { recursive: true });
      const collector = structuredClone(config);
      collector.activation = { collect: authority.allowCollection, review: false, dispatch: false };
      collector.stateDirectory = join(plan.stateDirectory, 'sources');
      collector.window = window; collector.dryRun.window = window; collector.schedule.enabled = false;
      collector.dryRun.limits.maxItems = collector.limits.maxItems = plan.limits.maxItems;
      collector.dryRun.limits.maxCalls = collector.limits.maxCalls = plan.limits.maxCalls;
      const filtering = structuredClone(filter);
      if (filtering.localFilter) {
        delete filtering.localFilter.retry;
        delete filtering.localFilter.cohortRetries;
      }
      delete filtering.runtime.authoringFeedback;
      filtering.activation = { collect: false, review: authority.allowModels, dispatch: false };
      filtering.stateDirectory = join(plan.stateDirectory, 'filter');
      filtering.window = window; filtering.dryRun.window = window; filtering.schedule.enabled = false;
      filtering.runtime.executionAuthorization = { reference: request.authorization, repoId: repo.id,
        baseRevision: repo.baseRef, planSha256: request.plan.sha256 };
      copyConfig(collector, join(root, 'collector.json'));
      copyConfig(filtering, join(root, 'filter.json'));
      cycle = { id, repoId: repo.id, revision: repo.baseRef, root, window,
        plan: request.plan, authorization: request.authorization, dryRun: request.dryRun !== false,
        collectorConfig: alReference(join(root, 'collector.json')),
        filterConfig: alReference(join(root, 'filter.json')), stages: {}, createdAt: now(),
        predecessor: predecessor?.id ?? null, recoveryReason: predecessor ? request.reason : null };
      return ledger.transaction(() => {
        ledger.operation(id, id, 'al-recurring-cycle', cycle);
        if (predecessor) save(ledger, predecessor, 'superseded-source-cycle', { successor: id });
        const created = save(ledger, cycle, 'created');
        syncGrant(ledger, request.authorization, authority);
        return created;
      });
    }
    cycle = loadCycle(ledger, request.cycleId);
    requireThat(cycle?.plan.sha256 === request.plan.sha256 &&
      cycle.authorization.sha256 === request.authorization.sha256,
    'Recurring cycle plan/authorization changed; do not resume under different permissions', 'blocked-reconciliation');
    if (request.action === 'observe-pr') {
      requireThat(request.readOnlyApproved === true && cycle.stages.propose,
        'PR observation needs explicit read-only approval and the native publisher result', 'blocked-authorization');
      const published = pinnedInput(cycle.stages.propose.result);
      const observed = await observeAlDraft(template, published.result.draftPR, { deadlineAt: authority.expiresAt });
      const path = join(cycle.root, `pr-observation-${hash(json(observed))}.json`);
      if (!existsSync(path)) put(path, observed);
      return save(ledger, cycle, cycle.state, { latestPrObservation: alReference(path) });
    }
    requireThat(!finished.has(cycle.state) && (cycle.state !== 'stopped' || request.resume === true),
      'Cycle is complete or explicitly stopped', 'blocked-reconciliation');
    if (request.action === 'collect') {
      if (cycle.collection) { verifyCollection(cycle); return cycle; }
      requireThat(authority.allowCollection, 'Recurring live source reads are not authorized', 'blocked-authorization');
      pinnedInput(cycle.collectorConfig);
      const collecting = configAt(cycle.collectorConfig.path), source = new Ledger(collecting.stateDirectory);
      try {
        const input = { format: 'one-shot-collection-v1', runId: cycle.id.slice('al-cycle:'.length, 'al-cycle:'.length + 20),
          owner: authority.approvedBy, dryRun: cycle.dryRun, passes: plan.passes,
          authorization: { approvedBy: authority.approvedBy, approvedAt: authority.approvedAt,
            approvalRef: request.authorization.path, deadlineAt: authority.expiresAt,
            maxItems: plan.limits.maxItems * plan.passes.length,
            maxCalls: plan.limits.maxCalls * plan.passes.length } };
        beginOneShotCollection(collecting, source, input);
        const status = await advanceOneShotCollection(collecting, source, input.runId,
          { ...collectionDependencies, resume: request.resume === true });
        if (!status.sourceCoverageComplete) return save(ledger, cycle, status.state, { collectionStatus: status });
        const receipt = readOneShotCollectionReceipt(collecting, source, input.runId, status.receiptSha256);
        const corpus = loadFilterCorpus(collecting, { format: 'stage2-sources-v1', sources: receipt.snapshot.sources });
        const evidenceIds = corpus.index.entries.map(entry => entry.evidenceId);
        const unseen = evidenceIds.filter(id => !load(ledger, `al-seen:${repo.id}:${repo.baseRef}:${id}`));
        cycle = save(ledger, cycle, 'collected', { collection: receipt, collectionReceiptSha256: status.receiptSha256,
          evidenceIds, unseenEvidenceIds: unseen });
        if (unseen.length) return cycle;
      } finally { source.close(); }
    } else if (request.action !== 'finish') {
      requireThat(cycle.collection, 'Complete collection is required before FILTER/handoff', 'blocked-reconciliation');
      verifyCollection(cycle);
      const stage = request.action, input = pinnedInput(request.stageRequest);
      requireStageInput(cycle, stage, input);
      if (stage === 'filter') {
        requireThat(!input.retainedResults?.length,
          'A recurring first FILTER reservation cannot retroactively adopt outside model executions',
          'blocked-reconciliation');
        requireUnstartedAlFilter(configAt(cycle.filterConfig.path), input.manifest);
      }
      requireThat(input.runDirectory === join(cycle.root, stage),
        'Recurring stage receipt directory differs', 'blocked-reconciliation');
      requireThat(!load(ledger, `${cycle.id}:${stage}`),
        'Stage already started; reconcile its native receipts, never blindly relaunch', 'blocked-reconciliation');
      if (['prepare', 'propose'].includes(stage)) {
        requireThat(json(input.templateConfig) === json(plan.templateConfig) &&
          json(input.qualification) === json(plan.qualification),
        'Recurring native qualification/template changed', 'blocked-reconciliation');
        const selected = pinnedInput(cycle.stages.filter.result).reconciliation.consolidation.selected;
        const prior = priorAlCandidateWork(ledger, cycle, selected);
        if (prior.length) {
          save(ledger, cycle, 'blocked', { candidateHold: { key: selected.key, prior,
            reason: 'Existing native FILTER invariant needs current existing-fix/PR reconciliation; no new handoff or reservation.' } });
          requireThat(false, 'Existing candidate work across cycles requires reconciliation; no duplicate Proposer/PR',
            'blocked-reconciliation');
        }
      }
      const count = stage === 'filter' ? pinnedInput(input.manifest).batches.length : stage === 'propose' ? 1 : 0;
      if (count) {
        const allocation = reserveAlCycleModels(ledger, cycle, plan, request.authorization,
          authority, stage, count, input.runDirectory);
        const path = join(cycle.root, `${stage}-allocation.json`);
        put(path, allocation); input.modelAllocation = alReference(path);
      }
      const operationId = `${cycle.id}:${stage}`;
      ledger.operation(operationId, cycle.id, 'al-cycle-stage', { input, stage });
      try {
        const result = await runAlWorkflow(stage, input, {
          workerStateDirectory: plan.workerStateDirectory ?? join(plan.stateDirectory, 'workers')
        });
        if (stage === 'propose') requireThat(result.state === 'draft-pr-validated' &&
          result.result?.draftPR?.isDraft === true &&
          result.result.draftPR.headRevision === result.result.sourceRevision,
        'Recurring candidate did not produce an exact-head validated Draft; reconcile before advancing',
        'blocked-reconciliation');
        const completed = { runDirectory: input.runDirectory, result: alReference(join(input.runDirectory, 'result.json')) };
        ledger.finishOperation(operationId, 'completed', { ...completed, input });
        if (count) {
          const reservation = load(ledger, `${cycle.id}:${stage}:models`);
          ledger.finishOperation(`${cycle.id}:${stage}:models`, 'consumed-or-held', reservation);
        }
        const completedCycle = save(ledger, cycle, `${stage}-complete`, { stages: { ...cycle.stages, [stage]: completed },
          lastStageState: result.state });
        syncGrant(ledger, request.authorization, authority);
        return completedCycle;
      } catch (error) {
        ledger.finishOperation(operationId, 'blocked', { input, error: safeError(error) });
        save(ledger, cycle, 'blocked', { failedStage: stage, error: safeError(error) });
        throw error;
      }
    }
    verifyCompletedCycle(ledger, cycle, plan);
    const cursorKey = `al:${repo.id}`;
    const expectedCursor = ledger.db.prepare('SELECT value FROM cursors WHERE source=?').get(cursorKey)?.value;
    return ledger.transaction(() => {
      const current = loadCycle(ledger, cycle.id);
      requireThat(!finished.has(current.state) && json(current) === json(cycle),
      'Cycle changed during finalization; no stale completion is allowed', 'blocked-reconciliation');
      const previous = expectedCursor === undefined ? null : JSON.parse(expectedCursor);
      if (expectedCursor !== undefined) windowCheck(previous);
      requireThat(cycle.window.start === (previous?.end ?? plan.firstWindowStart) &&
        Date.parse(cycle.window.end) > Date.parse(cycle.window.start),
      'Stale cycle cannot overwrite or skip the current evidence cursor', 'blocked-reconciliation');
      const update = expectedCursor === undefined
        ? ledger.db.prepare('INSERT INTO cursors VALUES(?,?) ON CONFLICT(source) DO NOTHING')
          .run(cursorKey, json(cycle.window))
        : ledger.db.prepare('UPDATE cursors SET value=? WHERE source=? AND value=?')
          .run(json(cycle.window), cursorKey, expectedCursor);
      requireThat(update.changes === 1, 'Evidence cursor changed during finalization', 'blocked-reconciliation');
      for (const id of cycle.evidenceIds) {
        const key = `al-seen:${repo.id}:${repo.baseRef}:${id}`;
        if (!load(ledger, key)) {
          ledger.operation(key, cycle.id, 'al-reviewed-evidence', { evidenceId: id, cycleId: cycle.id });
          ledger.finishOperation(key, 'reviewed', { evidenceId: id, cycleId: cycle.id });
        }
      }
      const completed = save(ledger, cycle, cycle.unseenEvidenceIds.length ? 'complete' : 'no-new-evidence',
        { publicationLifecycle: 'Any Draft remains owned by existing exact-head publisher and external PR-policy/review operator; no merge or CI queue is scheduled here.' });
      syncGrant(ledger, request.authorization, authority);
      return completed;
    });
  } finally {
    if (owner) ledger.release('coordinator', owner);
    ledger.close();
  }
}
