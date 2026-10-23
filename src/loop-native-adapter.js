// Supported local helper bridge. FILTER remains owned by an explicitly bound host.
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configAt, hash, json, requireThat } from './common.js';
import { Ledger } from './ledger.js';
import { beginOneShotCollection, advanceOneShotCollection, readOneShotCollectionReceipt,
  oneShotCollectionStatus } from './one-shot-collection.js';
import { advanceOneShotHandoff } from './one-shot-handoff.js';
import { openApp, appStatus } from './app-native.js';
import { rsiPolicy, rsiAutomationPolicy, rsiWork, captureAppRsiOutcome } from './rsi-flow.js';
import { runRsiPending } from './rsi-execution.js';
import { repositoryValidationContract } from './repository-skills.js';
import { canonical, digest, fileArtifact, captureArtifact, readLoopArtifact, roleReceipt, loopOperation } from './loop-controller.js';

const sourceDirectory = dirname(fileURLToPath(import.meta.url));
export function loopAdapterRevision() {
  return digest(readdirSync(sourceDirectory).filter(name => name.endsWith('.js')).sort()
    .map(name => [name, hash(readFileSync(join(sourceDirectory, name)))]));
}
export const nativeBinding = () => ({ id: 'local-one-shot-v1', revision: loopAdapterRevision() });
const blocked = (code, action) => ({ state: 'blocked', code, action });
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
    proposer.agency.selections = derived.agency.selections;
  }
  requireThat(digest({ identity: collector.identity, sources: collector.sources, passes: bundle.collection.passes }) ===
    pins.sourcePolicySha256, 'Source policy pin mismatch', 'blocked-reconciliation');
  requireThat(digest({ collector: pins.configuration[1], proposer: pins.configuration[2],
    executeProposer: bundle.executeProposer, rsiMode: pins.rsiMode }) === pins.executionPolicySha256,
  'Execution policy pin mismatch', 'blocked-reconciliation');
  return { bundle, collector, proposer, root };
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
    requireThat(input.collection.runId === request.runId &&
      input.collection.stateDirectory === settings.collector.stateDirectory &&
      input.collection.receiptSha256 === oneShotCollectionStatus(collector, request.runId).receiptSha256 &&
      digest(JSON.parse(readLoopArtifact(ledger, request.upstream[0].artifacts[0]))) ===
        digest(readOneShotCollectionReceipt(settings.collector, collector, request.runId)),
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

export function createNativeLoopAdapter({ collectionDependencies = {}, dispatchDependencies = {}, rsiDependencies = {} } = {}) {
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
    requireThat(b.filterHost?.id && b.filterHost?.approvalRef && b.filterHost?.qualificationRef &&
      ['maxRequests', 'maxExecutionSeconds', 'maxReservedTokens'].every(k => positive(b.filterHost[k])) &&
      b.filterHost.maxRequests <= pins.budgets.filter.maxEffects &&
      b.filterHost.maxExecutionSeconds * 1000 <= pins.budgets.filter.timeoutMs,
    'Bind an approved bounded FILTER host and qualification before collection', 'blocked-capability');
    requireThat(p.agency && Array.isArray(p.agency.selections) &&
      positive(p.agency.maxRequests) && p.agency.maxRequests <= b.filterHost.maxRequests &&
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
      if (!existsSync(path)) writeFileSync(path, json(config), { flag: 'wx', mode: 0o600 });
    }
    const complete = (outcome, value, ids, artifacts = []) => ({ state: 'complete',
      receipt: roleReceipt(request, outcome, [captureArtifact(ledger, value), ...artifacts], ids) });
    if (request.stage === 'collect') {
      const collector = new Ledger(s.collector.stateDirectory);
      try {
        if (resume && !collector.db.prepare("SELECT 1 FROM sqlite_master WHERE name='one_shot_collections'").get())
          return blocked('blocked-reconciliation', 'Collection intent has no helper journal; inspect original owner. Do not relaunch.');
        if (!resume) beginOneShotCollection(s.collector, collector, collectionInput(s, request));
        const status = await advanceOneShotCollection(s.collector, collector, request.runId, collectionDependencies);
        if (!status.sourceCoverageComplete) return blocked(status.blocker?.code ?? 'partial-collection',
          status.blocker?.action ?? 'Selected source coverage is incomplete; reconcile original collection passes.');
        return complete('collected', readOneShotCollectionReceipt(s.collector, collector, request.runId), [request.runId]);
      } finally { collector.close(); }
    }
    if (request.stage === 'filter' || request.stage === 'proposer') {
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
      requireThat(a.maxFilterRequests <= b.maxRequests && a.maxFilterExecutionSeconds <= b.maxExecutionSeconds &&
        a.maxFilterReservedTokens <= b.maxReservedTokens && Date.parse(a.deadlineAt) <= Date.parse(request.pins.deadlineAt),
      'Host handoff exceeds preflight reservation', 'blocked-budget');
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
    const { ledger: source } = openApp(s.collector, request.runId, true);
    try {
      // The existing pre-execution app binding now captures the connected loop,
      // including its actual accepted FILTER and proposer results, not a fabricated worker.
      const summary = { ...appStatus(source, request.runId), loop: {
        runId: request.runId, receipts: request.upstream,
        results: request.upstream.map(receipt => JSON.parse(readLoopArtifact(ledger, receipt.artifacts[0])))
      } };
      const observation = captureAppRsiOutcome(s.collector, source, request.runId, summary);
      if (request.pins.rsiMode === 'capture-only') {
        const status = rsiWork(s.collector, source, 'status', {}, { runId: request.runId });
        requireThat(status.observations.length > 0, 'RSI capture did not create an observation');
        return complete('captured', { collector: status.observations, upstream: request.upstream,
          scope: 'connected loop observation; manual analysis pending' },
        status.observations.map(o => o.id));
      }
      const status = rsiWork(s.collector, source, 'status', {}, { runId: request.runId });
      requireThat(status.observations.length === 1, 'Multiple RSI observations require explicit reconciliation', 'blocked-reconciliation');
      const work = status.work.find(item => item.observationId === observation.observationId);
      requireThat(work, 'Missing RSI work item for this exact loop observation', 'blocked-reconciliation');
      const prior = loopOperation(source, work.id + ':execution');
      requireThat(prior || Date.now() < Date.parse(request.pins.deadlineAt),
        'RSI start deadline exhausted', 'blocked-budget');
      const execution = prior?.state === 'completed' ? prior.detail.result
        : await runRsiPending(s.collector, source, { runId: request.runId }, rsiDependencies);
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
      try { requireThat(digest(readOneShotCollectionReceipt(s.collector, collector, request.runId)) === digest(value),
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
      const { ledger: source } = openApp(s.collector, request.runId, true);
      try {
        const status = rsiWork(s.collector, source, 'status', {}, { runId: request.runId });
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
    qualification: 'supported-local-helpers; live host/source/product/evaluator qualification not inferred',
    preflight, execute: (request, ledger) => perform(request, ledger, false),
    resume: (request, ledger) => perform(request, ledger, true), verify };
}
