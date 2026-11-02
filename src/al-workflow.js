import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { configAt, hash, json, now, requireThat, safeError } from './common.js';
import {
  alNativeConfig, alReference, alTestPrefixes, authenticateAlNative,
  requireAlQualification, withAlPreparationProgress
} from './al-adapter.js';
import { Ledger } from './ledger.js';
import { beginOneShotCollection, advanceOneShotCollection } from './one-shot-collection.js';
import { prepareFilterBatches, validateFilterManifest } from './filter-batches.js';
import { executeLocalFilterBatch, localFilterPreflight } from './local-filter.js';
import { reconcileFilterExecutionCohort } from './filter-execution.js';
import { acceptFilterProposerHandoff } from './filter-handoff.js';
import { qualifyRepositorySkill, skillQualificationId } from './repository-skills.js';
import { prepareLocalValidationContinuation } from './local-continuation.js';
import { dispatchLocalValidationContinuation } from './workers.js';
import { requireAlCandidateOwner, requireAlRepository } from './al-capabilities.js';
import { requireStandaloneAlAllocation, requireExecutionAuthorization } from './execution-authorization.js';

const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));
const put = (path, value) => writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { flag: 'wx', mode: 0o600 });
export function pinnedInput(reference) {
  requireThat(reference && isAbsolute(reference.path) &&
    alReference(reference.path).sha256 === reference.sha256,
  'AL workflow input is missing or changed from its explicit content pin', 'blocked-reconciliation');
  return read(reference.path);
}
export function requireAlFilter(config, manifest) {
  requireThat(config.filterExecutor === 'local-sdk' && config.filterBatching.mode === 'verified' &&
    config.repositories.length === 1 && !config.repositories[0].skillBindings?.some(binding => binding.externalBundle),
  'AL FILTER requires verified local execution and native-main guidance, never an external skill namespace', 'blocked-config');
  requireThat(config.repositories[0].skillBindings?.some(binding => binding.skillPath === '.github/skills/tests/SKILL.md'),
    'AL FILTER native-main testing guidance is missing', 'blocked-config');
  requireThat(alTestPrefixes.every(prefix => manifest.request.instructions.includes(prefix)),
    'AL FILTER decision contract must retain all four discovery scopes', 'blocked-scope');
  requireAlRepository(config.repositories[0]);
  validateFilterManifest(config, manifest);
}

function inspectAlFilter(request) {
  pinnedInput(request.filterConfig);
  const config = configAt(request.filterConfig.path), manifest = pinnedInput(request.manifest);
  requireAlFilter(config, manifest);
  const resultBytes = request.results.map(reference => {
    pinnedInput(reference);
    return readFileSync(reference.path, 'utf8');
  });
  const path = join(config.stateDirectory, 'ledger.sqlite');
  requireThat(existsSync(path), 'Original FILTER execution ledger is unavailable', 'blocked-reconciliation');
  const db = new DatabaseSync(path, { readOnly: true });
  try {
    const result = reconcileFilterExecutionCohort(config, { db }, manifest, resultBytes);
    return { config, manifest, result };
  } finally { db.close(); }
}
export function reconcileAlFilter(request) {
  const inspected = inspectAlFilter(request);
  requireThat(inspected.result.state === 'complete-held',
    'Original FILTER execution/cohort is not completely reconciled', 'blocked-reconciliation');
  return inspected;
}

export function requireRetainedAlResults(references, inspected) {
  const retained = new Map();
  for (const reference of references) {
    const result = pinnedInput(reference);
    const batch = inspected.batches.find(value => value.batchId === result.batchId);
    requireThat(batch?.state === 'completed' && batch.analysisPassed === true &&
      batch.resultSha256 === reference.sha256 && !retained.has(result.batchId),
    'Retained AL result must uniquely match an independently reconciled completed batch', 'blocked-reconciliation');
    retained.set(result.batchId, reference);
  }
  return retained;
}

export function requireAlModelAllocation(approval, root, count, purpose, repo) {
  if (approval.format === 'al-recurring-model-allocation-v1') {
    const authority = pinnedInput(approval.authorization);
    requireThat(authority.format === 'al-recurring-authorization-v1' && authority.allowModels === true &&
      Date.parse(authority.expiresAt) > Date.now() && approval.deadlineAt === authority.expiresAt &&
      approval.model === 'gpt-6-luna' && approval.runDirectory === root &&
      Number.isSafeInteger(count) && count > 0 && count <= approval.maxAdditionalSessions &&
      approval.purposes?.includes(purpose) && isAbsolute(approval.ledgerPath),
    'Recurring model allocation needs current finite authority and its durable reservation', 'blocked-authorization');
    const db = new DatabaseSync(approval.ledgerPath, { readOnly: true });
    try {
      const row = db.prepare('SELECT kind,state,detail FROM operations WHERE id=?').get(approval.reservationId);
      const reservation = row && JSON.parse(row.detail);
      const grant = db.prepare("SELECT state FROM operations WHERE id=? AND kind='al-recurring-grant'")
        .get(`al-grant:${approval.authorization.sha256}`);
      requireThat(row?.kind === 'al-cycle-model-budget' && row.state === 'reserved' &&
        grant?.state === 'active' &&
        reservation.authorizationSha256 === approval.authorization.sha256 &&
        reservation.runDirectory === root && reservation.purpose === purpose &&
        reservation.count === approval.maxAdditionalSessions &&
        reservation.credits === reservation.count * 30 &&
        Number.isSafeInteger(reservation.totalCreditsReserved) &&
        reservation.totalCreditsReserved <= authority.maxTotalAiCredits &&
        reservation.totalReserved <= authority.maxTotalModelSessions,
      'Recurring allocation does not match a live pre-execution budget reservation', 'blocked-budget');
    } finally { db.close(); }
    return;
  }
  requireStandaloneAlAllocation(approval, root, count, purpose, repo);
}
function reserveModels(request, root, count, purpose, repo) {
  const approval = pinnedInput(request.modelAllocation);
  requireAlModelAllocation(approval, root, count, purpose, repo);
  put(join(root, 'model-reservation.json'), { observedAt: now(), purpose, count, allocation: request.modelAllocation,
    accounting: 'Reservation is not an actual session. Reconcile original controller session receipts; never retry this reservation automatically.',
    softCreditLimit: 30, hardCreditEnforcementClaimed: false });
  return approval;
}

export function requireAlSdkAuthoring(config) {
  requireThat(config.repositories.length === 1 && config.repositories.every(repo =>
    (repo.skillBindings ?? []).every(binding => (binding.authoringProvider ?? 'copilot-sdk') === 'copilot-sdk')),
  'AL Proposer supports only copilot-sdk authoring; Agency and unknown providers are not qualified',
  'blocked-config');
}

export const alAuthoringSkillPath =
  'utils/excel-agent-in-container-proxy/.github/skills/excel-agent-in-container-proxy-integration-tests/SKILL.md';

export function requireAlProposerSkills(config) {
  requireAlSdkAuthoring(config);
  for (const repo of config.repositories) {
    for (const binding of repo.skillBindings ?? []) {
      requireThat(binding.externalBundle || binding.skillPath === alAuthoringSkillPath,
        'AL Proposer requires the merged repository-native integration skill path, or an explicitly pinned historical external bundle',
        'blocked-config');
    }
  }
}

export function bindAlModelExecution(config, reference, root, count, purpose) {
  const repo = config.repositories[0], allocation = pinnedInput(reference);
  if (purpose === 'proposer') requireAlSdkAuthoring(config);
  requireAlModelAllocation(allocation, root, count, purpose, repo);
  config.runtime.executionAuthorization = allocation.format === 'al-recurring-model-allocation-v1'
    ? { reference: allocation.authorization, repoId: repo.id, baseRevision: repo.baseRef,
      planSha256: pinnedInput(allocation.authorization).planSha256 }
    : { reference, repoId: repo.id, baseRevision: repo.baseRef,
      runDirectory: root, purpose, sessionCount: count };
  requireExecutionAuthorization(config, repo, 'model');
}

export function alWorkflowNativeConfig(template, root, workerStateDirectory) {
  requireAlProposerSkills(template);
  requireThat(!workerStateDirectory || isAbsolute(workerStateDirectory),
    'Shared AL worker state needs an absolute approved location', 'blocked-config');
  const config = alNativeConfig(template, workerStateDirectory ?? root, 'candidate');
  if (workerStateDirectory) config.stateDirectory = workerStateDirectory;
  return config;
}
async function proposerConfig(request, root, workerStateDirectory) {
  const qualification = pinnedInput(request.qualification);
  pinnedInput(request.templateConfig);
  const config = alWorkflowNativeConfig(configAt(request.templateConfig.path), root, workerStateDirectory);
  const repo = config.repositories[0];
  requireAlQualification(qualification, repo);
  config.runtime.validationCacheDirectory = qualification.cacheDirectory;
  config.runtime.authoringModel = 'gpt-6-luna';
  config.activation.review = true;
  repo.routingApproved = true;
  repo.validationGates[0].isolationVerified = true;
  for (const binding of repo.skillBindings) {
    binding.enabled = true;
    binding.qualification = 'qualified';
  }
  return config;
}

export async function runAlWorkflow(operation, request, { workerStateDirectory } = {}) {
  requireThat(['collect', 'batch', 'filter', 'reconcile', 'prepare', 'propose', 'continue'].includes(operation),
    'Unknown AL workflow stage', 'blocked-config');
  requireThat(isAbsolute(request.runDirectory) && !existsSync(request.runDirectory),
    'AL workflow stage needs a fresh absolute receipt directory', 'blocked-reconciliation');
  const root = resolve(request.runDirectory);
  mkdirSync(root, { recursive: true });
  put(join(root, 'request.json'), request);
  put(join(root, 'start.json'), { observedAt: now(), operation,
    flow: 'Composed existing native controller APIs; not the certified global one-shot wrapper' });
  let ledger, previousLedger;
  try {
    let result;
    if (operation === 'collect') {
      requireThat(request.liveCollectionApproved === true, 'Live AL collection requires explicit approval', 'blocked-authorization');
      pinnedInput(request.collectorConfig);
      const config = configAt(request.collectorConfig.path), input = pinnedInput(request.collectionRequest);
      ledger = new Ledger(config.stateDirectory);
      put(join(root, 'collection-begin.json'), beginOneShotCollection(config, ledger, input));
      result = await advanceOneShotCollection(config, ledger, input.runId);
    } else if (operation === 'batch') {
      pinnedInput(request.filterConfig);
      const config = configAt(request.filterConfig.path), input = pinnedInput(request.batchRequest);
      requireThat(config.filterBatching.mode === 'verified' && alTestPrefixes.every(prefix => input.instructions.includes(prefix)),
        'AL batching needs exact verified token accounting and all four scopes', 'blocked-config');
      result = await prepareFilterBatches(config, input, join(root, 'manifest.json'));
    } else if (operation === 'filter') {
      pinnedInput(request.filterConfig);
      const config = configAt(request.filterConfig.path), manifest = pinnedInput(request.manifest);
      requireAlFilter(config, manifest);
      requireThat(manifest.budget.model === 'gpt-6-luna' &&
        config.limits.maxAiCreditsPerSession === 30 && localFilterPreflight(config).state === 'ready',
      'AL FILTER model/runtime preflight must be ready at the approved soft ceiling', 'blocked-config');
      const references = request.retainedResults ?? [];
      const retained = references.length ? requireRetainedAlResults(references,
        inspectAlFilter({ ...request, results: references }).result) : new Map();
      const pending = manifest.batches.filter(batch => !retained.has(batch.id));
      const allocation = pending.length
        ? reserveModels(request, root, pending.length, 'filter', config.repositories[0]) : null;
      if (pending.length) bindAlModelExecution(config, request.modelAllocation, root, pending.length, 'filter');
      if (pending.length) ledger = new Ledger(config.stateDirectory);
      for (const batch of pending) {
        requireAlModelAllocation(allocation, root, pending.length, 'filter', config.repositories[0]);
        put(join(root, `${batch.id}-launch-intent.json`), { observedAt: now(), batchId: batch.id, predecessor: null,
          model: 'gpt-6-luna', actualSessionStarted: false });
        const executed = await executeLocalFilterBatch(config, ledger, manifest, batch.id);
        put(join(root, `${batch.id}-terminal.json`), executed);
        requireThat(executed.state === 'complete-held', 'AL FILTER batch blocked; retain it and authorize a bounded successor separately', 'blocked-result');
        const outputPath = join(root, `${batch.id}-result.json`);
        put(outputPath, executed.result);
        retained.set(batch.id, alReference(outputPath));
      }
      const results = manifest.batches.map(batch => retained.get(batch.id));
      const binding = { filterConfig: request.filterConfig, manifest: request.manifest, results };
      result = { ...binding, newBatchCount: pending.length, retainedBatchCount: references.length,
        mode: pending.length ? 'executed-filter-batches' : 'read-only-retained-filter-reconciliation',
        reconciliation: reconcileAlFilter(binding).result };
    } else if (operation === 'reconcile') {
      result = reconcileAlFilter(request).result;
    } else if (operation === 'prepare' || operation === 'propose') {
      const config = await proposerConfig(request, root, workerStateDirectory), repo = config.repositories[0];
      const checked = reconcileAlFilter(request);
      put(join(root, 'original-filter-reconciliation.json'), checked.result);
      requireAlCandidateOwner(checked.result.consolidation.selected, repo);
      requireThat(checked.config.localFilter.sources.some(source =>
        source.repoId === repo.id && source.revision === repo.baseRef),
      'Original FILTER and qualified AL Proposer source pins differ', 'blocked-reconciliation');
      // Reuse only the reconciled budget, never FILTER execution or collection authority.
      // An explicitly approved template budget must agree before it can be replaced.
      if (config.filterBatching?.approved === true) validateFilterManifest(config, checked.manifest);
      config.filterBatching = structuredClone(checked.config.filterBatching);
      const execute = operation === 'propose';
      let modelAllocation;
      if (execute) {
        requireThat(request.authorizeCommit === true && request.authorizePush === true && request.authorizeDraftPR === true,
          'AL publication needs explicit commit, push and Draft authorization', 'blocked-authorization');
        requireThat(config.limits.maxAiCreditsPerSession === 30,
          'AL Proposer must retain the approved 30-credit soft ceiling', 'blocked-budget');
        modelAllocation = reserveModels(request, root, 1, 'proposer', repo);
        bindAlModelExecution(config, request.modelAllocation, root, 1, 'proposer');
        requireExecutionAuthorization(config, repo, 'commit');
        config.activation.dispatch = true;
        config.limits.maxValidationRepairRounds = 0;
        for (const binding of repo.skillBindings) binding.sideEffects = { commit: true, push: true, createDraftPR: true };
      }
      put(join(root, 'proposer-config.json'), config);
      ledger = new Ledger(config.stateDirectory);
      const skill = await qualifyRepositorySkill(config, repo.id, 'integration-test-authoring');
      ledger.qualify(skillQualificationId(repo.id, skill.bindingId), skill);
      put(join(root, 'skill-qualification.json'), skill);
      if (execute) {
        await authenticateAlNative(config, repo, repo.baseRef, root, request.authenticationRemediationApproved);
        requireAlModelAllocation(modelAllocation, root, 1, 'proposer', repo);
      }
      const handoff = {
        format: 'filter-proposer-handoff-v1',
        filter: { manifestPath: request.manifest.path, resultPaths: request.results.map(reference => reference.path) },
        routing: { capability: 'integration-test-authoring', requestedOutcome: 'add-or-update-tests',
          ...(request.existingFixesReview ? { existingFixesReview: pinnedInput(request.existingFixesReview) } : {}) }
      };
      put(join(root, 'handoff.json'), handoff);
      result = await withAlPreparationProgress(root, () => acceptFilterProposerHandoff(config, ledger, handoff, {
        execute, authorizeCommit: execute, authorizePush: execute, authorizeDraftPR: execute
      }));
    } else {
      const authorization = pinnedInput(request.authorization);
      requireThat(authorization.maxModelAttempts === 0 && authorization.kind === 'native-jest-cache-isolation',
        'AL native continuation only accepts the existing zero-model, source-preserving cache recovery contract',
        'blocked-authorization');
      pinnedInput(request.previousConfig); pinnedInput(request.nextConfig);
      const previous = configAt(request.previousConfig.path), next = configAt(request.nextConfig.path);
      const proposal = pinnedInput(request.originalProposal);
      previousLedger = new Ledger(previous.stateDirectory);
      ledger = new Ledger(next.stateDirectory);
      result = await prepareLocalValidationContinuation(previous, previousLedger, request.assignmentId,
        next, ledger, authorization, proposal);
      put(join(root, 'continuation-prepared.json'), result);
      if (request.execute === true) {
        requireThat(request.authorizeCommit === true && request.authorizePush === true && request.authorizeDraftPR === true,
          'Continuation publication requires explicit side-effect authority', 'blocked-authorization');
        result = await withAlPreparationProgress(root,
          () => dispatchLocalValidationContinuation(next, ledger, result.assignment.id));
      }
    }
    put(join(root, 'result.json'), result);
    return result;
  } catch (error) {
    put(join(root, 'failure.json'), { observedAt: now(), operation, error: safeError(error),
      diagnostic: error.message, automaticRetry: false });
    throw error;
  } finally { ledger?.close(); previousLedger?.close(); }
}
