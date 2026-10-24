// Supported local helper bridge. FILTER remains owned by an explicitly bound host.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configAt, hash, json, requireThat } from './common.js';
import { failureDetails } from './failure-details.js';
import { Ledger } from './ledger.js';
import { beginOneShotCollection, advanceOneShotCollection, readOneShotCollectionReceipt,
  oneShotCollectionStatus } from './one-shot-collection.js';
import { advanceOneShotHandoff, executeOneShotLocalFilter } from './one-shot-handoff.js';
import { localOneShotPreflight } from './one-shot-local-filter.js';
import { prepareLoopLocalFilter } from './loop-local-filter.js';
import { openApp, appStatus } from './app-native.js';
import { rsiPolicy, rsiAutomationPolicy, rsiWork, captureAppRsiOutcome } from './rsi-flow.js';
import { runRsiPending } from './rsi-execution.js';
import { repositoryValidationContract, qualifyRepositorySkill, skillQualificationId } from './repository-skills.js';
import { canonical, digest, fileArtifact, captureArtifact, readLoopArtifact, roleReceipt, loopOperation, normalizeLoopRequest } from './loop-controller.js';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
export function loopAdapterRevision() {
  return digest(readdirSync(sourceDirectory).filter(name => name.endsWith('.js')).sort()
    .map(name => [name, hash(readFileSync(join(sourceDirectory, name)))]));
}
export const nativeBinding = () => ({ id: 'local-one-shot-v1', revision: loopAdapterRevision() });
const blocked = (code, action, details) => ({ state: 'blocked', code, action, ...failureDetails(details) });
const awaiting = action => ({ state: 'awaiting-host', code: 'host-continuation-required', action });
const positive = n => Number.isFinite(n) && n > 0;

export function nativeLoopSettings(pins, runId) {
  const bundle = JSON.parse(readFileSync(pins.configuration[0].path));
  requireThat(bundle.format === 'loop-native-settings-v1', 'Expected native loop settings');
  for (const path of [bundle.collectorConfig, bundle.proposerConfig])
    requireThat(isAbsolute(path) && pins.configuration.some(p => p.path === realpathSync(path) && p.sha256 === hash(readFileSync(path))),
      'Every native configuration must be hash pinned', 'blocked-reconciliation');
  const collector = configAt(bundle.collectorConfig), proposer = configAt(bundle.proposerConfig);
  const root = join(pins.stateOwner.directory, 'loops', runId);
  // Same deterministic specialization for every trigger. No runtime working-directory defaults.
  for (const [config, name] of [[collector, 'collector'], [proposer, 'proposer']]) {
    config.stateDirectory = join(root, name);
    config.window = structuredClone(pins.window);
    config.dryRun.window = structuredClone(pins.window);
  }
  if (proposer.agency) proposer.agency.budgetId = runId;
  const derivedPath = join(root, 'proposer.config.json');
  if (existsSync(derivedPath)) {
    const derived = configAt(derivedPath);
    const withoutSelections = config => {
      const copy = structuredClone(config);
      if (copy.agency) copy.agency.selections = [];
      return copy;
    };
    requireThat(digest(withoutSelections(derived)) === digest(withoutSelections(proposer)),
      'Host may only specialize agency selections in the derived proposer config', 'blocked-reconciliation');
    if (proposer.agency) proposer.agency.selections = derived.agency.selections;
  }
  requireThat(digest({ identity: collector.identity, sources: collector.sources, passes: bundle.collection.passes }) ===
    pins.sourcePolicySha256, 'Source policy pin mismatch', 'blocked-reconciliation');
  requireThat(digest({ collector: pins.configuration[1], proposer: pins.configuration[2],
    executeProposer: bundle.executeProposer, rsiMode: pins.rsiMode }) === pins.executionPolicySha256,
  'Execution policy pin mismatch', 'blocked-reconciliation');
  const result = { bundle, collector, proposer, root, collectionRunId: runId };
  if (bundle.collectionReuse) {
    const reuse = bundle.collectionReuse;
    requireThat(bundle.adapter === 'native' && reuse.approvalRef && reuse.approvedBy && reuse.requestPath && reuse.requestSha256,
      'Collection reconciliation requires an explicit approved original request', 'blocked-reconciliation');
    const bytes = readFileSync(reuse.requestPath);
    requireThat(hash(bytes) === reuse.requestSha256, 'Original request changed', 'blocked-reconciliation');
    const old = normalizeLoopRequest(JSON.parse(bytes));
    const oldBundle = JSON.parse(readFileSync(old.pins.configuration[0].path));
    requireThat(!oldBundle.collectionReuse && old.runId !== runId &&
      digest(old.pins.stateOwner) === digest(pins.stateOwner) &&
      digest(old.pins.window) === digest(pins.window) && old.pins.sourcePolicySha256 === pins.sourcePolicySha256 &&
      digest(old.pins.configuration[1]) === digest(pins.configuration[1]) && old.pins.rsiMode === pins.rsiMode,
    'Reconciliation must retain the exact original source policy, configuration, window and owner', 'blocked-reconciliation');
    const prior = nativeLoopSettings(old.pins, old.runId);
    const sourceControl = new Ledger(old.pins.stateOwner.directory);
    try {
      const collected = loopOperation(sourceControl, old.runId + ':collect')?.detail.receipt;
      requireThat(collected?.outcome === 'collected' &&
        !loopOperation(sourceControl, old.runId + ':filter')?.detail.receipt &&
        !loopOperation(sourceControl, old.runId + ':proposer') && !loopOperation(sourceControl, old.runId + ':rsi') &&
        !loopOperation(sourceControl, old.runId + ':native-handoff-input') &&
        !existsSync(join(prior.root, 'filter-execution')) && !existsSync(join(prior.root, 'handoff.json')),
      'Only a completed collection with no downstream execution may be reconciled', 'blocked-reconciliation');
      result.reusedReceipt = JSON.parse(readLoopArtifact(sourceControl, collected.artifacts[0]));
      const source = new Ledger(prior.collector.stateDirectory);
      try {
        requireThat(digest(readOneShotCollectionReceipt(prior.collector, source, old.runId, reuse.receiptSha256)) ===
          digest(result.reusedReceipt), 'Original collection receipt changed', 'blocked-reconciliation');
      } finally { source.close(); }
    } finally { sourceControl.close(); }
    result.collector = prior.collector;
    result.collectionRunId = old.runId;
  }
  return result;
}

function collectionInput(settings, request) {
  return { ...settings.bundle.collection, format: 'one-shot-collection-v1', runId: request.runId,
    owner: request.pins.stateOwner.id };
}
function handoffInput(settings, request, ledger) {
  const path = join(settings.root, 'handoff.json');
  if (!existsSync(path)) return null;
  const bytes = readFileSync(path), input = JSON.parse(bytes);
  const collector = new Ledger(settings.collector.stateDirectory);
  try {
    requireThat(input.collection.runId === settings.collectionRunId &&
      input.collection.stateDirectory === settings.collector.stateDirectory &&
      input.collection.receiptSha256 === oneShotCollectionStatus(collector, settings.collectionRunId).receiptSha256 &&
      digest(JSON.parse(readLoopArtifact(ledger, request.upstream[0].artifacts[0]))) ===
        digest(readOneShotCollectionReceipt(settings.collector, collector, settings.collectionRunId)),
    'Host handoff must reference this exact collected receipt', 'blocked-reconciliation');
  } finally { collector.close(); }
  const id = request.runId + ':native-handoff-input';
  const prior = loopOperation(ledger, id);
  const configSha256 = digest(settings.proposer);
  if (prior) requireThat(prior.detail.sha256 === hash(bytes) && prior.detail.configSha256 === configSha256,
    'Host handoff/config changed', 'blocked-reconciliation');
  else ledger.operation(id, request.runId, 'loop-native-handoff', { sha256: hash(bytes), configSha256 });
  return { input, path };
}

export function createNativeLoopAdapter({ collectionDependencies = {}, dispatchDependencies = {}, rsiDependencies = {}, filterDependencies = {} } = {}) {
  const binding = nativeBinding();
  async function preflight({ pins, runId }) {
    requireThat(binding.revision === loopAdapterRevision(), 'Adapter code changed after loading', 'blocked-reconciliation');
    const s = nativeLoopSettings(pins, runId), { collector: c, proposer: p, bundle: b } = s;
    requireThat(process.platform !== 'win32' ||
      join(c.stateDirectory, 'app-native', 'dry-runs', runId, 'ledger.sqlite').length < 240,
    'Native SQLite needs a shorter approved durable state root on Windows; do not relocate existing runs implicitly', 'blocked-binding');
    requireThat(c.executionMode === 'app-native' && c.schedule.enabled === false && p.schedule.enabled === false,
      'Native loop requires app-native collection and disabled inner schedulers');
    for (const config of [c, p]) requireThat(config.statePolicy.accessApproved &&
      config.statePolicy.retention === 'bounded-local' && config.statePolicy.rawEvidenceDays <= pins.stateOwner.retentionDays,
    'Approve private state and compatible retention before collection');
    requireThat(b.collection.dryRun === true && c.dryRun.collectionOnly,
      'Native loop preserves isolated collection-only namespace; no production WorkIQ bypass', 'blocked-scope');
    requireThat(b.collection.passes?.length > 0 && new Set(b.collection.passes).size === b.collection.passes.length &&
      b.collection.passes.every(pass => ['ado:created', 'ado:changed', 'workiq:created', 'workiq:changed'].includes(pass)),
    'Only supported explicit source passes may be collected', 'blocked-capability');
    const enabled = Object.entries(c.sources).filter(([, source]) => source.enabled);
    requireThat(enabled.length > 0 && enabled.every(([kind, source]) => source.scopeApproved &&
      b.collection.passes.includes(kind + ':created')) && b.collection.passes.every(pass =>
      c.sources[pass.split(':')[0]]?.enabled && c.sources[pass.split(':')[0]]?.scopeApproved),
    'Selected passes must exactly cover approved enabled source kinds', 'blocked-scope');
    const count = b.collection.passes.length, limits = c.dryRun.limits, a = b.collection.authorization;
    requireThat([limits.maxItems, limits.maxCalls, a?.maxItems, a?.maxCalls].every(positive) &&
      limits.maxItems * count <= a.maxItems && limits.maxCalls * count <= a.maxCalls &&
      a.maxCalls <= pins.budgets.collect.maxEffects &&
      Date.parse(a.deadlineAt) <= Date.parse(pins.deadlineAt), 'Collection exceeds aggregate reservation', 'blocked-budget');
    const local = p.filterExecutor === 'local-sdk';
    if (local) {
      localOneShotPreflight(p);
      requireThat(p.repositories.every(repo => repo.qualificationRefresh === 'local' &&
        p.localFilter.sources.some(source => source.repoId === repo.id && source.revision === repo.baseRef)),
      'Local FILTER requires exact repository revisions and read-only local qualification', 'blocked-binding');
      requireThat(b.localFilterPlan?.sharing?.approvalRef && b.localFilterPlan?.groupingReview &&
        b.localFilterPlan?.authorization && b.localFilterPlan?.instructions,
      'Local FILTER grouping, sharing and release authorization must be pinned before collection');
      requireThat(p.localFilter.maxRequests <= pins.budgets.filter.maxEffects &&
        p.localFilter.timeoutMs * p.localFilter.maxRequests <= pins.budgets.filter.timeoutMs,
      'Local FILTER exceeds the controller request/time reservation', 'blocked-budget');
      const a = b.localFilterPlan.authorization, batches = p.localFilter.maxRequests;
      requireThat(a.maxFilterRequests >= batches &&
        a.maxFilterExecutionSeconds * 1000 >= p.localFilter.timeoutMs * batches &&
        a.maxFilterAiCredits >= p.limits.maxAiCreditsPerSession * batches &&
        a.maxProposerAiCredits >= p.limits.maxAiCreditsPerSession * (1 + p.limits.maxValidationRepairRounds) &&
        a.maxFilterReservedTokens >= (p.filterBatching?.maxInputTokens + p.filterBatching?.reserves.output) * batches &&
        Date.parse(a.deadlineAt) <= Date.parse(pins.deadlineAt),
      'Local FILTER/proposer whole-run allocation is incomplete before collection', 'blocked-budget');
    } else requireThat(b.filterHost?.id && b.filterHost?.approvalRef && b.filterHost?.qualificationRef &&
      ['maxRequests', 'maxExecutionSeconds', 'maxReservedTokens'].every(k => positive(b.filterHost[k])) &&
      b.filterHost.maxRequests <= pins.budgets.filter.maxEffects &&
      b.filterHost.maxExecutionSeconds * 1000 <= pins.budgets.filter.timeoutMs,
    'Bind an approved bounded FILTER host and qualification before collection', 'blocked-capability');
    requireThat((local || (p.agency && Array.isArray(p.agency.selections) &&
      positive(p.agency.maxRequests) && p.agency.maxRequests <= b.filterHost.maxRequests)) &&
      p.filterBatching?.approved && p.filterBatching.mode === 'verified' &&
      existsSync(p.filterBatching.verificationRef) &&
      hash(readFileSync(p.filterBatching.verificationRef)) === p.filterBatching.verificationSha256,
    'Preflight requires approved FILTER profiles/budgets and verified tokenizer evidence', 'blocked-binding');
    requireThat(typeof b.executeProposer === 'boolean' && p.repositories.length > 0,
      'Declare proposer release and repository bindings');
    for (const repo of p.repositories) {
      requireThat(repo.routingApproved && repo.referenceCheckout && repo.skillBindings.some(skill =>
        skill.enabled && skill.qualification === 'qualified') && repo.validationGates.length > 0 &&
        repo.validationGates.every(gate => gate.approved && gate.isolationVerified),
      'Repository authoring and validation bindings are incomplete: ' + repo.id, 'blocked-binding');
      repositoryValidationContract(repo);
    }
    requireThat(['maxWorkers', 'maxAssignments', 'workerMinutes', 'workerMaxToolCalls', 'maxAiCreditsPerSession']
      .every(k => positive(p.limits[k])) && p.limits.workerMinutes * 60000 <= pins.budgets.proposer.timeoutMs &&
      pins.budgets.proposer.maxEffects >= 1 + p.limits.maxValidationRepairRounds,
    'Finite proposer model/tool/time/repair bounds required', 'blocked-budget');
    for (const config of [c, p]) {
      requireThat(rsiPolicy(config).enabled, 'Enable RSI before producer admission', 'blocked-binding');
      const automation = rsiAutomationPolicy(config);
      requireThat(pins.rsiMode === 'evaluated' ? Boolean(automation) : !automation,
        'Declared RSI mode differs from configured capture/evaluation mode', 'blocked-binding');
      if (automation) requireThat(positive(automation.timeoutMs) && automation.timeoutMs <= pins.budgets.rsi.timeoutMs &&
        config.rsi.maxProposals <= pins.budgets.rsi.maxEffects,
      'RSI automation exceeds the declared reservation', 'blocked-budget');
    }
  }
  async function perform(request, ledger, resume) {
    const s = nativeLoopSettings(request.pins, request.runId);
    mkdirSync(s.root, { recursive: true, mode: 0o700 });
    for (const [name, config] of [['collector', s.collector], ['proposer', s.proposer]]) {
      const path = join(s.root, name + '.config.json');
      if (!existsSync(path)) {
        const serialized = structuredClone(config);
        for (const repo of serialized.repositories) for (const gate of repo.validationGates) {
          if (gate.profilePath && isAbsolute(gate.profilePath))
            gate.profilePath = relative(dirname(path), gate.profilePath);
        }
        writeFileSync(path, json(serialized), { flag: 'wx', mode: 0o600 });
      }
    }
    const complete = (outcome, value, ids, artifacts = []) => ({ state: 'complete',
      receipt: roleReceipt(request, outcome, [captureArtifact(ledger, value), ...artifacts], ids) });
    if (request.stage === 'collect') {
      if (!resume && s.proposer.filterExecutor === 'local-sdk') {
        const proposer = new Ledger(s.proposer.stateDirectory);
        try {
          for (const repo of s.proposer.repositories) for (const skill of repo.skillBindings.filter(skill => skill.enabled)) {
            const qualification = await qualifyRepositorySkill(s.proposer, repo.id, skill.capability, skill.id);
            proposer.qualify(skillQualificationId(repo.id, skill.id), qualification);
          }
        } finally { proposer.close(); }
      }
      if (s.reusedReceipt)
        return complete('collected', s.reusedReceipt, [s.collectionRunId]);
      const collector = new Ledger(s.collector.stateDirectory);
      try {
        if (resume && !collector.db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_shot_collections'").get())
          return blocked('blocked-reconciliation', 'Collection intent has no helper journal; inspect original owner. Do not relaunch.');
        if (!resume) beginOneShotCollection(s.collector, collector, collectionInput(s, request));
        const status = await advanceOneShotCollection(s.collector, collector, request.runId, collectionDependencies);
        if (!status.sourceCoverageComplete) return blocked(status.blocker?.code ?? 'partial-collection',
          status.blocker?.action ?? 'Selected source coverage is incomplete; reconcile original collection passes.', status.blocker);
        return complete('collected', readOneShotCollectionReceipt(s.collector, collector, request.runId), [request.runId]);
      } finally { collector.close(); }
    }
    if (request.stage === 'filter' || request.stage === 'proposer') {
      const local = s.proposer.filterExecutor === 'local-sdk';
      if (local && request.stage === 'filter') {
        const source = new Ledger(s.collector.stateDirectory);
        try { s.collectionReceiptSha256 = oneShotCollectionStatus(source, s.collectionRunId).receiptSha256; }
        finally { source.close(); }
        await prepareLoopLocalFilter(s, request, ledger, filterDependencies.counter);
      }
      const handoff = handoffInput(s, request, ledger);
      if (!handoff) {
        const path = join(s.root, 'filter-request.json');
        const content = canonical({ request, settings: request.pins.configuration,
          output: join(s.root, 'handoff.json'), host: s.bundle.filterHost,
          action: 'Use ONE-SHOT.md: prepare complete batches, reserve aggregate/task budgets BEFORE host submission, then inspect/reconcile original FILTER receipts. Write the exact one-shot handoff here. Never resubmit uncertain work.' });
        if (existsSync(path)) requireThat(readFileSync(path, 'utf8') === content, 'Host role request changed');
        else writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
        return awaiting('Bound host ' + s.bundle.filterHost.id + ' must continue ' + path);
      }
      const a = handoff.input.authorization, b = s.bundle.filterHost;
      requireThat((local ? a.maxFilterRequests <= request.pins.budgets.filter.maxEffects &&
        a.maxFilterExecutionSeconds * 1000 <= request.pins.budgets.filter.timeoutMs
        : a.maxFilterRequests <= b.maxRequests && a.maxFilterExecutionSeconds <= b.maxExecutionSeconds &&
          a.maxFilterReservedTokens <= b.maxReservedTokens) && Date.parse(a.deadlineAt) <= Date.parse(request.pins.deadlineAt),
      'Host handoff exceeds preflight reservation', 'blocked-budget');
      if (local && request.stage === 'filter') {
        const execution = new Ledger(dirname(handoff.input.filter.executionLedgerPath));
        try { await executeOneShotLocalFilter(s.proposer, execution, handoff.input, filterDependencies); }
        finally { execution.close(); }
      }
      const proposer = new Ledger(s.proposer.stateDirectory);
      try {
        const status = await advanceOneShotHandoff(s.proposer, proposer, handoff.input,
          { execute: request.stage === 'proposer' && s.bundle.executeProposer, dispatchDependencies });
        if (status.state === 'blocked') return blocked(status.blocker.code, status.blocker.action);
        requireThat(['complete-no-candidate', 'complete-held', 'completed'].includes(status.state),
          'Unrecognized one-shot completion state', 'blocked-reconciliation');
        const outcome = request.stage === 'filter'
          ? status.state === 'complete-no-candidate' ? 'no-candidate' : s.bundle.executeProposer ? 'eligible' : 'held'
          : status.state === 'completed' ? 'proposed' : 'held';
        const value = request.stage === 'filter' ? status.accepted : { assignment: status.assignment, result: status.result };
        return complete(outcome, value, [status.operationId, ...(status.assignment ? [status.assignment.id] : [])],
          [fileArtifact(handoff.path), fileArtifact(join(s.root, 'proposer.config.json')), fileArtifact(handoff.input.filter.manifestPath),
            ...handoff.input.filter.resultPaths.map(fileArtifact)]);
      } finally { proposer.close(); }
    }
    // RSI uses the producer binding created before collection. No retroactive binding or old dry-run promotion.
    const { ledger: source } = openApp(s.collector, s.collectionRunId, true);
    try {
      // The existing pre-execution app binding now captures the connected loop,
      // including its actual accepted FILTER and proposer results, not a fabricated worker.
      const summary = { ...appStatus(source, s.collectionRunId), loop: {
        runId: request.runId, receipts: request.upstream,
        results: request.upstream.map(receipt => JSON.parse(readLoopArtifact(ledger, receipt.artifacts[0])))
      } };
      const observation = captureAppRsiOutcome(s.collector, source, s.collectionRunId, summary);
      if (request.pins.rsiMode === 'capture-only') {
        const status = rsiWork(s.collector, source, 'status', {}, { runId: s.collectionRunId });
        requireThat(status.observations.length > 0, 'RSI capture did not create an observation');
        return complete('captured', { collector: status.observations, upstream: request.upstream,
          scope: 'connected loop observation; manual analysis pending' },
        status.observations.map(o => o.id));
      }
      const status = rsiWork(s.collector, source, 'status', {}, { runId: s.collectionRunId });
      requireThat(status.observations.length === 1, 'Multiple RSI observations require explicit reconciliation', 'blocked-reconciliation');
      const work = status.work.find(item => item.observationId === observation.observationId);
      requireThat(work, 'Missing RSI work item for this exact loop observation', 'blocked-reconciliation');
      const prior = loopOperation(source, work.id + ':execution');
      requireThat(prior || Date.now() < Date.parse(request.pins.deadlineAt),
        'RSI start deadline exhausted', 'blocked-budget');
      const execution = prior?.state === 'completed' ? prior.detail.result
        : await runRsiPending(s.collector, source, { runId: s.collectionRunId }, rsiDependencies);
      if (execution.state === 'awaiting-host') return awaiting('Continue existing RSI execution ' + execution.executionId + ' through app-rsi-run; preserve its original host claim.');
      if (!execution.comparison || !execution.report)
        return blocked('rsi-evaluation-incomplete', 'Existing RSI execution has no paired comparison; inspect ' + work.id);
      requireThat(fileArtifact(execution.report.ref).sha256 === execution.report.sha256,
        'RSI comparison artifact changed', 'blocked-reconciliation');
      return complete('evaluated', execution, [work.id + ':execution', observation.observationId],
        [fileArtifact(execution.report.ref)]);
    } finally { source.close(); }
  }
  async function verify(request, receipt, ledger) {
    const s = nativeLoopSettings(request.pins, request.runId);
    const value = JSON.parse(readLoopArtifact(ledger, receipt.artifacts[0]));
    if (request.stage === 'collect') {
      const collector = new Ledger(s.collector.stateDirectory);
      try { requireThat(digest(readOneShotCollectionReceipt(s.collector, collector, s.collectionRunId)) === digest(value),
        'Collection receipt changed', 'blocked-reconciliation'); }
      finally { collector.close(); }
    } else if (request.stage === 'filter' || request.stage === 'proposer') {
      const h = handoffInput(s, request, ledger), proposer = new Ledger(s.proposer.stateDirectory);
      try {
        requireThat(loopOperation(proposer, receipt.ledgerIds[0])?.kind === 'one-shot-handoff',
          'Original one-shot operation is missing; do not reconstruct an accepted receipt', 'blocked-reconciliation');
        const status = await advanceOneShotHandoff(s.proposer, proposer, h.input);
        requireThat(status.state !== 'blocked' && digest(request.stage === 'filter' ? status.accepted
          : { assignment: status.assignment, result: status.result }) === digest(value),
        'Accepted FILTER/proposer state changed', 'blocked-reconciliation');
      } finally { proposer.close(); }
    } else {
      const { ledger: source } = openApp(s.collector, s.collectionRunId, true);
      try {
        const status = rsiWork(s.collector, source, 'status', {}, { runId: s.collectionRunId });
        requireThat(status.observations.length > 0 && (receipt.outcome !== 'captured' ||
          digest(status.observations) === digest(value.collector)), 'RSI observation changed', 'blocked-reconciliation');
        if (receipt.outcome === 'evaluated') {
          const execution = loopOperation(source, receipt.ledgerIds[0]);
          requireThat(execution?.state === 'completed' && digest(execution.detail.result) === digest(value),
            'RSI comparison does not match the original execution', 'blocked-reconciliation');
        }
      } finally { source.close(); }
    }
  }
  return { binding, capabilities: ['collect', 'filter', 'proposer', 'rsi'],
    failureEvidence(request, ledger) {
      const s = nativeLoopSettings(request.pins, request.runId);
      const path = join(s.collector.stateDirectory, 'app-native', 'dry-runs', s.collectionRunId, 'ledger.sqlite');
      if (!existsSync(path)) return { availability: 'source-ledger-missing', artifacts: [],
        effectCertainty: 'unknown; no source replay permitted' };
      const { ledger: source } = openApp(s.collector, s.collectionRunId, true);
      const collector = new Ledger(s.collector.stateDirectory);
      try {
        const status = oneShotCollectionStatus(collector, s.collectionRunId);
        const artifacts = [];
        const transports = source.db.prepare('SELECT body FROM app_transport WHERE run_id=? ORDER BY rowid')
          .all(s.collectionRunId).map(row => {
            // WorkIQ wraps its call with transport state; ADO journals the call directly.
            const record = JSON.parse(row.body), call = record.call ?? record;
            const hasResponse = Object.hasOwn(call, 'response');
            const state = record.state ?? (call.failure ? 'failed' : hasResponse ? 'received' : 'requested');
            if (record.captureSha256) {
              const artifact = { kind: 'capture', sha256: record.captureSha256 };
              const bytes = readLoopArtifact(source, artifact);
              ledger.db.prepare('INSERT OR IGNORE INTO captures VALUES(?,?)').run(artifact.sha256, bytes);
              artifacts.push(artifact);
            }
            return { state, callId: call.id, requestSha256: digest(call.request),
              captureSha256: record.captureSha256 ?? null,
              effectCertainty: hasResponse || record.captureSha256 ? 'response-recorded' : 'unknown',
              failure: call.failure ? { code: call.failure.code, ...failureDetails(call.failure) } : null };
          });
        return { availability: 'recorded', artifacts, transports,
          producerBindings: source.all('rsiFlowBinding'),
          configurationSha256: status.configSha256, requestSha256: status.requestSha256,
          sourceCoverageComplete: status.sourceCoverageComplete,
          reserved: status.reserved,
          passes: status.passes.map(p => ({ pass: p.pass, state: p.state, reservation: p.reservation,
            calls: p.result?.readCalls ?? null, examined: p.result?.examinedRecords ?? null,
            evidence: p.result?.evidenceCount ?? null, failure: failureDetails(p.result?.error) })) };
      } finally { collector.close(); source.close(); }
    },
    acquireRun: ({ pins, runId }, ledger) => {
      const s = nativeLoopSettings(pins, runId);
      if (!s.reusedReceipt) return () => {};
      const key = 'evidence-loop:' + s.collectionRunId, owner = ledger.acquire(key);
      try {
        nativeLoopSettings(pins, runId); // Recheck after acquiring the predecessor's enforced lock.
        const id = s.collectionRunId + ':collection-successor';
        const prior = loopOperation(ledger, id);
        requireThat(!prior || prior.detail.runId === runId,
          'Original collection already has a different successor', 'blocked-reconciliation');
        if (!prior) ledger.operation(id, runId, 'loop-collection-reconciliation', {
          runId, originalRunId: s.collectionRunId, authorization: s.bundle.collectionReuse });
        return () => ledger.release(key, owner);
      } catch (error) { ledger.release(key, owner); throw error; }
    },
    qualification: 'supported-local-helpers; live host/source/product/evaluator qualification not inferred',
    preflight, execute: (request, ledger) => perform(request, ledger, false),
    resume: (request, ledger) => perform(request, ledger, true), verify };
}
