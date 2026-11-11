import { existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedPath, configAt, hash, json, now, readJson, requireThat, safeError, utc, validateRecord } from './common.js';
import { command } from './command.js';
import { Ledger } from './ledger.js';
import { assertStateDirectoryIgnored } from './state-retention.js';
import { admitCaseSources, approveCaseBatch, caseReviewerIdentity, completedOperation, fixtureBytes, httpsUrl,
  loadCaseBatch, operationRow, recordCaseDraft } from './case-generation.js';
import { renderCaseArtifacts } from './case-artifacts.js';
import { publishCaseBatch } from './case-publication.js';
import { materializeCaseFixtures } from './case-fixtures.js';
import { caseDestination, caseSourceConnectors, caseSourceInputs, hostSourceTask } from './case-source-connectors.js';
import { caseSourceInventory } from './case-source-inventory.js';
import { verifyDiscoveryHandoff } from './case-discovery-config.js';

const projectRoot = fileURLToPath(new URL('..', import.meta.url));
const runPattern = /^case-run-[a-f0-9]{24}$/;
const runInventory = run => run.inventory ??
  Object.entries(caseSourceInputs).map(([id, key]) => ({ id, type: id, url: run.inputs[key], surfaces: [] }));
const writeOnce = (path, value) => {
  const content = typeof value === 'string' ? value : JSON.stringify(value, null, 2) + '\n';
  if (existsSync(path)) requireThat(readFileSync(path, 'utf8') === content, 'Recorded run file changed', 'blocked-reconciliation');
  else writeFileSync(path, content, { flag: 'wx' });
};
function filesFor(config, runId) {
  requireThat(runPattern.test(runId), 'Invalid case run ID', 'blocked-scope');
  const root = boundedPath(config.stateDirectory, runId, { write: true });
  return { root, inputs: join(root, 'inputs'), config: join(root, 'controller.local.json'),
    admission: join(root, 'sources.local.json'), context: join(root, 'design-context.json') };
}
function recordedSource(ledger, runId, id) {
  for (const attempt of [2, 1]) {
    const recovery = operationRow(ledger, `${runId}:recovery:${id}:${attempt}`);
    if (!recovery) continue;
    if (recovery.state === 'complete') return completedOperation(ledger, recovery.id, recovery.kind);
    return { sourceId: id, state: 'uncertain', error: { code: 'blocked-reconciliation',
      message: 'A source recovery was reserved; reconcile its actual response instead of starting another read.' } };
  }
  const host = operationRow(ledger, `${runId}:host:${id}`);
  if (host?.state === 'complete') return completedOperation(ledger, host.id, 'case-host-source');
  if (host) return { sourceId: id, state: 'uncertain', error: { code: 'blocked-reconciliation',
    message: 'A host source read was reserved but not captured. Reconcile its actual response; do not repeat it.' } };
  const native = operationRow(ledger, `${runId}:source:${id}`);
  if (native?.state === 'complete') return completedOperation(ledger, native.id, 'case-url-source');
  return { sourceId: id, state: 'uncertain', error: { code: 'blocked-reconciliation',
    message: 'Source operation is incomplete; do not automatically repeat it.' } };
}
function sourceResponseJournal(ledger, runId, sourceId) {
  const prefix = `${runId}:response:${sourceId}:`;
  const key = url => `${prefix}${hash(url)}`;
  return {
    read(url) {
      const row = operationRow(ledger, key(url));
      if (!row) return null;
      const saved = completedOperation(ledger, row.id, 'case-source-response');
      requireThat(saved.url === url && saved.bodySha256 === hash(saved.body),
        'Source response changed; reconcile the original capture', 'blocked-reconciliation');
      return saved;
    },
    reserve(url) {
      requireThat(ledger.status().operations.filter(row => row.id.startsWith(prefix)).length < 4,
        'Source recovery request budget exhausted', 'blocked-budget');
      ledger.operation(key(url), runId, 'case-source-response', { url, reservedAt: now() });
    },
    record(url, response) {
      requireThat(!/(?:authorization|access_token|refresh_token|password|cookie)"\s*:/i.test(response.body),
        'Do not persist transport credentials in source responses', 'blocked-scope');
      ledger.finishOperation(key(url), 'complete', { ...response, url, observedAt: now(), bodySha256: hash(response.body) });
    }
  };
}
export async function recoverCaseSource(base, ledger, runId, sourceId, options = {}, dependencies = {}) {
  requireThat(options.authorizeCollection === true && options.authorizeRecovery === true,
    'Source recovery requires explicit collection and recovery authorization', 'blocked-authorization');
  const { run } = loadRun(base, ledger, runId);
  const selected = runInventory(run).find(source => source.id === sourceId);
  requireThat(selected && !operationRow(ledger, `${runId}:submission`),
    'Recover only an exact configured source before design submission', 'blocked-scope');
  const lock = `${runId}:recover:${sourceId}`, owner = ledger.acquire(lock);
  try {
    const previous = recordedSource(ledger, runId, sourceId);
    requireThat(previous.state === 'blocked', 'Only a recorded blocked source can be recovered; reconcile pending reads', 'blocked-reconciliation');
    const attempt = operationRow(ledger, `${runId}:recovery:${sourceId}:1`) ? 2 : 1;
    const id = `${runId}:recovery:${sourceId}:${attempt}`;
    requireThat(!operationRow(ledger, id), 'Source recovery limit reached; preserve the remaining blocker', 'blocked-budget');
    const host = previous.provenance === 'app-host-tool-reported' ||
      !['template', 'sample', 'bugs'].includes(selected.type) ||
      previous.connector !== undefined;
    ledger.operation(id, runId, host ? 'case-host-source' : 'case-url-source', {
      sourceId, url: selected.url, reservedAt: now(), previousSha256: hash(json(previous)),
      scope: 'Explicit bounded recovery; prior receipts are unchanged. Persisted HTTP responses are replayed, never reread.' });
    if (host) return { ...hostSourceTask(sourceId, selected.url), qualification: selected.qualification ?? null,
      state: 'source-read-reserved', runId, operationId: id };
    try {
      const connectors = caseSourceConnectors(base, run.inputs, { ...dependencies, inventory: runInventory(run),
        responseJournal: sourceResponseJournal(ledger, runId, sourceId) });
      ledger.finishOperation(id, 'complete', await connectors.collect(sourceId));
    } catch (error) {
      ledger.finishOperation(id, 'complete', { sourceId, url: selected.url,
        state: 'blocked', error: safeError(error) });
    }
    return caseUrlContext(base, ledger, runId);
  } finally { ledger.release(lock, owner); }
}
function loadRun(config, ledger, runId) {
  const run = completedOperation(ledger, runId, 'case-url-run');
  requireThat(run.id === runId, 'Run identity mismatch', 'blocked-reconciliation');
  requireThat(run.identitySha256 === hash(json(config.identity)),
    'Designated source identity changed; do not resume under another account', 'blocked-auth');
  for (const [file, expected] of [['generateE2E.md', run.promptSha256], ['generateE2E.config.json', run.configurationSha256]])
    requireThat(hash(readFileSync(boundedPath(run.projectRoot, file))) === expected,
      'Checked-in guidance or URL configuration changed; start an explicitly refreshed run', 'blocked-reconciliation');
  if (run.discovery) verifyDiscoveryHandoff(config,
    JSON.parse(readFileSync(boundedPath(run.projectRoot, 'generateE2E.config.json'), 'utf8')), run.configurationSha256);
  return { run, files: filesFor(config, runId) };
}
export async function beginCaseUrlRun(base, ledger, options = {}, dependencies = {}) {
  requireThat(options.authorizeCollection === true && options.authorizeGeneration === true &&
    base.statePolicy.accessApproved === true,
  'URL-first generation requires explicit source-read, synthetic-file generation and approved private-storage authority', 'blocked-authorization');
  const root = resolve(dependencies.projectRoot ?? projectRoot);
  const prompt = readFileSync(boundedPath(root, 'generateE2E.md'), 'utf8');
  const configuration = readFileSync(boundedPath(root, 'generateE2E.config.json'), 'utf8');
  const parsed = JSON.parse(configuration), inputs = parsed.inputs;
  const discovery = parsed.discovery ? verifyDiscoveryHandoff(base, parsed, hash(configuration)) : null;
  const inventory = caseSourceInventory(parsed).map(source => ({ ...source,
    ...(discovery ? { qualification: discovery.qualifications.find(item => item.id === source.id) ?? null } : {}) }));
  const destination = caseDestination(inputs.TEST_CASE_TEMPLATE_URL);
  const binding = hash(json({ root, prompt: hash(prompt), configuration: hash(configuration),
    identity: base.identity, state: base.stateDirectory }));
  const slot = `case-url-active-${binding}`;
  const owner = ledger.acquire(slot);
  try {
    if (!options.refresh && operationRow(ledger, slot)) {
      const active = completedOperation(ledger, slot, 'case-url-active');
      return caseUrlContext(base, ledger, active.runId);
    }
    const id = `case-run-${hash(json([binding, now(), crypto.randomUUID()])).slice(0, 24)}`;
    const files = filesFor(base, id);
    mkdirSync(files.inputs, { recursive: true });
    const execute = dependencies.execute ?? command;
    const revision = (await execute('git', ['--no-pager', 'rev-parse', 'HEAD'], root, 30000)).stdout.trim();
    requireThat(/^[a-f0-9]{40}$/.test(revision), 'Controller revision is unavailable');
    const generated = structuredClone(base);
    generated.activation = { collect: false, review: false, dispatch: false };
    generated.stateDirectory = join(files.root, 'ledger');
    generated.executionMode = 'app-native';
    generated.repositories = [...base.repositories.filter(repo => repo.id !== 'case-design'), {
      id: 'case-design', owner: 'Design-only controller provenance; product repository not selected',
      referenceCheckout: root, baseRef: revision, routingApproved: false, skillBindings: [],
      allowedWritePrefixes: [], allowedWriteFiles: [], validationGates: [] }];
    generated.caseGeneration = {
      enabled: true, scopeApproved: true, approvalRef: `${id}:authorization`, inputRoot: files.inputs,
      maxInputBytes: 4194304, maxOutputBytes: 1048576, maxFixtureBytes: 10485760, maxCases: 15,
      publication: { enabled: false, scopeApproved: false, approvalRef: null, maxItems: 15, maxCalls: 200 },
      workflow2: { enabled: false }
    };
    writeOnce(join(files.inputs, 'generateE2E.md'), prompt);
    writeOnce(join(files.inputs, 'generateE2E.config.json'), configuration);
    writeOnce(files.config, generated);
    const run = { id, format: 'case-url-run-v1', createdAt: now(), projectRoot: root,
      promptSha256: hash(prompt), configurationSha256: hash(configuration), inputs, destination, inventory, discovery,
      repositoryRevision: revision, generatedConfigSha256: hash(readFileSync(files.config)),
      identitySha256: hash(json(base.identity)),
      generationMode: 'app-host', provenance: 'Controller commit only; no product checkout or existing-test coverage is inferred.' };
    ledger.operation(`${id}:authorization`, id, 'case-url-authorization', {
      requestedAt: run.createdAt, configuredUrls: inputs, sourceReads: true,
      syntheticFixtureGeneration: true, publication: false, productExecution: false });
    ledger.finishOperation(`${id}:authorization`, 'complete', { configuredUrls: inputs,
      sourceReads: true, syntheticFixtureGeneration: true, publication: false, productExecution: false });
    ledger.operation(id, id, 'case-url-run', {});
    ledger.finishOperation(id, 'complete', run);
    if (!operationRow(ledger, slot)) ledger.operation(slot, id, 'case-url-active', {});
    ledger.finishOperation(slot, 'complete', { runId: id });
    const connectors = caseSourceConnectors(base, inputs, { ...dependencies, inventory,
      responseJournal: sourceId => sourceResponseJournal(ledger, id, sourceId) });
    for (const source of inventory) {
      const sourceId = source.id;
      const operationId = `${id}:source:${sourceId}`;
      ledger.operation(operationId, id, 'case-url-source', {});
      try {
        ledger.finishOperation(operationId, 'complete', await connectors.collect(sourceId));
      } catch (error) {
        ledger.finishOperation(operationId, 'complete', { sourceId, url: source.url,
          state: 'blocked', error: safeError(error) });
      }
    }
    return caseUrlContext(base, ledger, id);
  } finally { ledger.release(slot, owner); }
}
export function caseUrlContext(base, ledger, runId) {
  const { run, files } = loadRun(base, ledger, runId);
  const published = operationRow(ledger, `${runId}:publication`);
  if (published?.state === 'complete') return completedOperation(ledger, published.id, 'case-url-publication');
  const submitted = operationRow(ledger, `${runId}:submission`);
  if (submitted?.state === 'complete') return completedOperation(ledger, submitted.id, 'case-url-submission');
  const sources = runInventory(run).map(source => ({ ...recordedSource(ledger, runId, source.id),
    type: source.type, surfaces: source.surfaces }));
  const pending = sources.filter(item => ['connector-required', 'uncertain'].includes(item.state));
  const blocked = sources.filter(item => item.state === 'blocked');
  if (pending.length || blocked.length) return { state: pending.length ? 'awaiting-source-connectors' : 'blocked-sources',
    runId, tasks: pending, blockers: blocked,
    nextAction: 'The agent must connect the requested host sources or report their specific access blocker. No user-authored exports/configuration are required.' };
  const context = { runId, instructions: readFileSync(join(files.inputs, 'generateE2E.md'), 'utf8'),
    sources, discovery: run.discovery ?? null,
    assurance: 'Captured URLs and usable content are not approval of expectations, complete coverage or runnable automation.',
    caseCeiling: 15, designSchema: resolve(run.projectRoot, 'scaffold', 'contracts.schema.json'),
    sourceInventory: 'Controller ADO items/node IDs are preserved. Host captures are source-document inventory only; enumerate atomic requirements in the draft and retain incomplete coverage explicitly.',
    repository: run.provenance, fixtureInstructions: 'Design cases first, then submit exactly their fixtureRequests. Builders support synthetic text, JSON, CSV and XLSX literal cells; missing originals remain explicit blockers. No scripts, macros or formulas.',
    submission: { generator: 'Actual app-host identity, not a fabricated session', draft: 'caseGenerationDraft',
      fixtureRequests: 'Array of {id,name,kind,purpose,handling,synthetic:true,content|rows|sheets}; missing uses kind:missing and reason' } };
  requireThat(Buffer.byteLength(json(context)) <= 4194304, 'Design context exceeds its aggregate byte limit', 'blocked-budget');
  writeOnce(files.context, context);
  return { state: 'ready-for-design', runId, contextPath: files.context,
    nextAction: 'Agent reads the captured context, designs the cases and fixture recipes, then uses case-submit. No separate SDK model or user-written manifest is required.' };
}
export function reserveCaseHostSource(base, ledger, runId, sourceId, authorizeCollection) {
  requireThat(authorizeCollection === true, 'Host source read requires explicit authorization', 'blocked-authorization');
  loadRun(base, ledger, runId);
  const task = recordedSource(ledger, runId, sourceId);
  requireThat(task.state === 'connector-required', 'Source is not pending a fresh host read; reconcile existing receipts', 'blocked-reconciliation');
  ledger.operation(`${runId}:host:${sourceId}`, runId, 'case-host-source', { url: task.url, reservedAt: now() });
  return { ...task, state: 'source-read-reserved', runId,
    nextAction: 'Perform this exact scoped native-tool read once and submit its actual response with case-source-result. Verify WorkIQ /me against the designated identity before any WorkIQ content read.' };
}
export function captureCaseHostSource(base, ledger, runId, receipt, authorizeCollection) {
  requireThat(authorizeCollection === true, 'Host capture requires explicit authorization', 'blocked-authorization');
  const { run } = loadRun(base, ledger, runId);
  const selected = runInventory(run).find(source => source.id === receipt?.sourceId);
  requireThat(receipt && selected &&
    receipt.url === selected.url &&
    typeof receipt.toolName === 'string' && receipt.toolName.trim() &&
    (receipt.toolCallId === null || typeof receipt.toolCallId === 'string') &&
    ['complete', 'partial', 'blocked'].includes(receipt.access) &&
    typeof receipt.limitations === 'string' && receipt.limitations.trim() &&
    receipt.response !== undefined && Buffer.byteLength(json(receipt)) <= 1048576,
  'Host capture needs exact source URL, actual bounded tool response and truthful coverage/provenance', 'invalid-record');
  utc(receipt.observedAt);
  requireThat(Date.parse(receipt.observedAt) <= Date.now(), 'Host observation time is in the future');
  if ((/workiq/i.test(receipt.toolName) || ['workiq', 'ado'].includes(selected.qualification?.provider)) &&
    receipt.access !== 'blocked') requireThat(
    receipt.identity?.id === base.identity.objectId &&
    receipt.identity?.userPrincipalName?.toLowerCase() === base.identity.designatedUser?.toLowerCase(),
  'Executing WorkIQ host identity must match the designated account', 'blocked-auth');
  if ((/figma/i.test(receipt.toolName) || selected.type === 'figma') && receipt.access !== 'blocked') requireThat(
    receipt.response?.whoami?.email?.toLowerCase() === base.identity.designatedUser?.toLowerCase(),
  'Executing Figma connector identity must match the designated account using native whoami', 'blocked-auth');
  if (selected.type === 'repository' && receipt.access !== 'blocked') requireThat(
    receipt.response?.repository?.commit === selected.qualification?.sourceVersion &&
    receipt.response?.repository?.location === selected.qualification?.exactLocation,
  'Repository capture must match its discovered commit and exact file location', 'blocked-reconciliation');
  requireThat(!/retrieve|search|ask/i.test(receipt.toolName) || receipt.access !== 'complete',
    'Search or summarized retrieval cannot establish a complete source read', 'invalid-record');
  requireThat(receipt.access === 'blocked' || receipt.response !== null && !receipt.response.error &&
    json(receipt.response).length > 2, 'Source errors and empty responses are not captured content', 'invalid-record');
  requireThat(!/(?:authorization|access_token|refresh_token|password|cookie)"\s*:/i.test(json(receipt.response)),
    'Do not persist transport credentials in source captures', 'blocked-scope');
  const recovery = [2, 1].map(attempt => operationRow(ledger, `${runId}:recovery:${receipt.sourceId}:${attempt}`))
    .find(Boolean);
  const id = recovery?.id ?? `${runId}:host:${receipt.sourceId}`, owner = ledger.acquire(id);
  try {
    const prior = operationRow(ledger, id);
    requireThat(prior?.kind === 'case-host-source', 'Reserve the scoped host read before capturing its response', 'blocked-reconciliation');
    const receiptSha256 = hash(json(receipt));
    if (prior.state === 'complete') {
      requireThat(completedOperation(ledger, id, 'case-host-source').receiptSha256 === receiptSha256,
        'Host capture changed; preserve its original response', 'blocked-reconciliation');
      return caseUrlContext(base, ledger, runId);
    }
    requireThat(prior.state === 'started' || prior.state === 'pending', 'Host read cannot be silently retried', 'blocked-reconciliation');
    requireThat(Date.parse(receipt.observedAt) >= Date.parse(JSON.parse(prior.detail).reservedAt),
      'Host observation predates its current source reservation', 'blocked-reconciliation');
    ledger.finishOperation(id, 'complete', { sourceId: receipt.sourceId, url: receipt.url,
      content: json(receipt.response), revision: receipt.revision ?? null, retrievedAt: receipt.observedAt,
      access: receipt.access, itemIds: receipt.access === 'blocked' ? [] : [receipt.sourceId],
      limitations: `${receipt.limitations} Host capture is tool-reported; document inventory is not proof of exhaustive atomic-source coverage.`,
      provenance: 'app-host-tool-reported', receiptSha256, toolName: receipt.toolName,
      toolCallId: receipt.toolCallId, identity: receipt.identity ?? null, ...(receipt.access === 'blocked' ? { state: 'blocked',
        error: { code: 'blocked-source', message: receipt.limitations } } : {}) });
  } finally { ledger.release(id, owner); }
  return caseUrlContext(base, ledger, runId);
}
export async function submitCaseUrlDraft(base, ledger, runId, input, authorizeGeneration, dependencies = {}) {
  requireThat(authorizeGeneration === true, 'Case/fixture generation needs explicit authorization', 'blocked-authorization');
  const { run, files } = loadRun(base, ledger, runId);
  requireThat(input && Object.keys(input).sort().join(',') === 'draft,fixtureRequests,generator' &&
    typeof input.generator === 'string' && input.generator.trim(),
  'Submit the actual host generator, complete draft and design-driven fixture requests', 'invalid-record');
  validateRecord(input.draft, 'caseGenerationDraft');
  const owner = ledger.acquire(`${runId}:design`);
  try {
    const payloadSha256 = hash(json(input));
    if (operationRow(ledger, `${runId}:submission`)) {
      const previous = completedOperation(ledger, `${runId}:submission`, 'case-url-submission');
      requireThat(previous.payloadSha256 === payloadSha256, 'Run already has a different design; do not rewrite it', 'blocked-reconciliation');
      const config = configAt(files.config), child = new Ledger(config.stateDirectory);
      try {
        const { bundle } = loadCaseBatch(config, child, previous.batchId);
        for (const fixture of bundle.admission.fixtures) if (fixture.availability === 'available') fixtureBytes(config, fixture);
      } finally { child.close(); }
      return previous;
    }
    requireThat(caseUrlContext(base, ledger, runId).state === 'ready-for-design',
      'Resolve source connectors/access blockers before finalizing a design', 'blocked-source');
    requireThat(hash(readFileSync(files.config)) === run.generatedConfigSha256, 'Internal controller configuration changed', 'blocked-reconciliation');
    const config = configAt(files.config), child = new Ledger(config.stateDirectory);
    try {
      const sources = runInventory(run).map(source => ({ ...recordedSource(ledger, runId, source.id), type: source.type }));
      const fixtures = await materializeCaseFixtures(config, child, runId, input.fixtureRequests, input.draft);
      const template = JSON.parse(sources.find(source => source.sourceId === 'template').content);
      const admission = { format: 'case-generation-admission-v1', baselineId: runId, previousBatchId: null,
        scope: 'Design cases from the configured URLs only; inaccessible populations and unverified product context are not covered.' +
          (run.discovery ? ` Discovery ${run.discovery.runId}: ${run.discovery.coverage.map(row =>
            `${row.surface}=${row.status}`).join('; ')}. Gap references: ${run.discovery.gaps.map(gap => gap.id).join(', ') || 'none'}.` : ''),
        product: 'Product/build not independently verified', environment: 'Design only; product execution environment not qualified',
        repoId: 'case-design', repositoryRevision: run.repositoryRevision, promptPath: 'generateE2E.md', fixtures,
        destination: { organization: run.destination.organization, project: run.destination.project,
          workItemType: run.destination.workItemType, areaPath: template.fields['System.AreaPath'], tag: 'AgenticTestRequest',
          template: { id: run.destination.templateId, teamId: run.destination.teamId, sourceId: 'template',
            verifiedAt: sources.find(source => source.sourceId === 'template').retrievedAt, fields: template.fields } },
        sources: sources.map(source => {
          const path = `${source.sourceId}.txt`;
          writeOnce(join(files.inputs, path), source.content);
          return { id: source.sourceId, type: source.type, url: source.url, title: `Configured ${source.sourceId} source`,
            revision: source.revision, modifiedAt: null, retrievedAt: source.retrievedAt,
            approval: 'unknown', applicability: 'unknown', access: source.access,
            limitations: source.limitations, path, sha256: hash(source.content), itemIds: source.itemIds };
        }) };
      writeOnce(files.admission, admission);
      const bundle = await admitCaseSources(config, child, admission, { authorizeImport: true }, dependencies);
      const batch = recordCaseDraft(config, child, bundle.id, input.draft, input.generator);
      const artifacts = await renderCaseArtifacts(config, child, batch.id);
      const result = { state: 'review-held', runId, bundleId: bundle.id, batchId: batch.id,
        batchSha256: hash(json(batch.batch)), payloadSha256, artifacts, controllerConfig: files.config,
        fixtureCount: fixtures.length, publicationAuthorized: false, productExecutionAuthorized: false };
      ledger.operation(`${runId}:submission`, runId, 'case-url-submission', {});
      ledger.finishOperation(`${runId}:submission`, 'complete', result);
      return result;
    } finally { child.close(); }
  } finally { ledger.release(`${runId}:design`, owner); }
}
export async function publishReviewedCaseRun(base, ledger, runId, review, options = {}, dependencies = {}) {
  requireThat(options.authorizeApproval === true && options.authorizeSourceReview === true &&
    options.authorizePublication === true, 'Independent source/case review and publication require separate explicit grants', 'blocked-authorization');
  const { run, files } = loadRun(base, ledger, runId);
  const original = completedOperation(ledger, `${runId}:submission`, 'case-url-submission');
  requireThat(review?.batchSha256 === original.batchSha256 && review.reviewer?.trim() && review.approvalRef?.trim(),
    'Review must identify the exact displayed batch, actual independent reviewer and approval reference', 'blocked-authorization');
  requireThat(hash(readFileSync(files.config)) === run.generatedConfigSha256, 'Internal controller configuration changed', 'blocked-reconciliation');
  const initialConfig = configAt(files.config), child = new Ledger(initialConfig.stateDirectory);
  const lock = `${runId}:review-publication`;
  let owner;
  try {
    owner = child.acquire(lock);
    const { batch, bundle } = loadCaseBatch(initialConfig, child, original.batchId);
    requireThat(caseReviewerIdentity(review.reviewer) !== caseReviewerIdentity(batch.generator),
      'QA reviewer must be independent of the generator', 'blocked-authorization');
    const reviewId = `${runId}:source-review`;
    if (operationRow(child, reviewId)) requireThat(
      json(completedOperation(child, reviewId, 'case-url-source-review').review) === json(review),
      'Reviewed source/case approval changed; reconcile the original decision', 'blocked-reconciliation');
    else {
      child.operation(reviewId, runId, 'case-url-source-review', {});
      child.finishOperation(reviewId, 'complete', { review, originalBatchId: original.batchId,
        sourceHashes: bundle.sources.map(({ id, sha256 }) => ({ id, sha256 })), approvedAt: now(),
        scope: 'Exact captured source applicability, case design, generated-file sharing and bounded ADO publication; not product execution.' });
    }
    const config = structuredClone(initialConfig);
    config.caseGeneration.publication = { enabled: true, scopeApproved: true, approvalRef: reviewId,
      maxItems: 15, maxCalls: 200 };
    const configPath = join(files.root, 'reviewed-controller.local.json');
    writeOnce(configPath, config);
    const admission = { ...bundle.admission, baselineId: `${runId}-reviewed`, previousBatchId: original.batchId,
      sources: bundle.admission.sources.map(source => ({ ...source, approval: 'approved', applicability: 'applicable' })) };
    const reviewedBundle = await admitCaseSources(config, child, admission, { authorizeImport: true }, dependencies);
    const reviewed = recordCaseDraft(config, child, reviewedBundle.id, batch.draft, batch.generator);
    approveCaseBatch(config, child, { batchId: reviewed.id, batchSha256: hash(json(reviewed.batch)),
      reviewer: review.reviewer, approvalRef: review.approvalRef }, { authorizeApproval: true });
    const publication = await publishCaseBatch(config, child, reviewed.id, { authorizePublication: true }, dependencies);
    const artifacts = await renderCaseArtifacts(config, child, reviewed.id);
    const result = { state: publication.state, runId, originalBatchId: original.batchId, batchId: reviewed.id,
      batchSha256: hash(json(reviewed.batch)), review, publication, artifacts, controllerConfig: configPath,
      productExecutionAuthorized: false };
    if (!operationRow(ledger, `${runId}:publication`)) ledger.operation(`${runId}:publication`, runId, 'case-url-publication', {});
    ledger.finishOperation(`${runId}:publication`, 'complete', result);
    return result;
  } finally {
    if (owner) child.release(lock, owner);
    child.close();
  }
}
export async function runCaseUrlCommand(action, args, dependencies = {}) {
  const definitions = {
    'case-start': { values: ['--config'], flags: ['--authorize-collection', '--authorize-generation', '--refresh'] },
    'case-context': { values: ['--config', '--run'], flags: [] },
    'case-source-begin': { values: ['--config', '--run', '--source'], flags: ['--authorize-collection'] },
    'case-source-recover': { values: ['--config', '--run', '--source'], flags: ['--authorize-collection', '--authorize-recovery'] },
    'case-source-result': { values: ['--config', '--run', '--file'], flags: ['--authorize-collection'] },
    'case-submit': { values: ['--config', '--run', '--file'], flags: ['--authorize-generation'] },
    'case-publish-reviewed': { values: ['--config', '--run', '--batch-sha256', '--reviewer', '--approval-ref'],
      flags: ['--authorize-approval', '--authorize-source-review', '--authorize-publication'] }
  };
  const definition = definitions[action];
  requireThat(definition, 'Unknown URL-first case command');
  const parsed = {};
  for (let index = 0; index < args.length; index++) {
    const key = args[index];
    requireThat([...definition.values, ...definition.flags].includes(key) && !Object.hasOwn(parsed, key),
      'Unknown or duplicate URL-first case option', 'blocked-scope');
    if (definition.values.includes(key)) requireThat(args[index + 1] && !args[index + 1].startsWith('--'),
      'Case option needs a value');
    parsed[key] = definition.values.includes(key) ? args[++index] : true;
  }
  for (const flag of definition.flags.filter(flag => flag !== '--refresh'))
    requireThat(parsed[flag], 'Missing explicit URL-first stage authorization', 'blocked-authorization');
  for (const value of definition.values.filter(value => value !== '--config'))
    requireThat(parsed[value], 'Missing internal run/source/result argument');
  const root = resolve(dependencies.projectRoot ?? projectRoot);
  const config = configAt(resolve(parsed['--config'] ?? join(root, 'pilot.local.json')));
  requireThat(config.statePolicy.accessApproved === true, 'Approve the existing deployment local-storage policy first', 'blocked-authorization');
  const isolated = { ...config, stateDirectory: join(config.stateDirectory, 'case-generation') };
  assertStateDirectoryIgnored(isolated);
  const ledger = new Ledger(isolated.stateDirectory);
  try {
    if (action === 'case-start') return await beginCaseUrlRun(isolated, ledger, {
      authorizeCollection: true, authorizeGeneration: true, refresh: parsed['--refresh'] === true }, dependencies);
    if (action === 'case-context') return caseUrlContext(isolated, ledger, parsed['--run']);
    if (action === 'case-source-begin') return reserveCaseHostSource(isolated, ledger, parsed['--run'], parsed['--source'], true);
    if (action === 'case-source-recover') return await recoverCaseSource(isolated, ledger, parsed['--run'], parsed['--source'],
      { authorizeCollection: true, authorizeRecovery: true }, dependencies);
    if (action === 'case-publish-reviewed') return await publishReviewedCaseRun(isolated, ledger, parsed['--run'],
      { batchSha256: parsed['--batch-sha256'], reviewer: parsed['--reviewer'], approvalRef: parsed['--approval-ref'] },
      { authorizeApproval: true, authorizeSourceReview: true, authorizePublication: true }, dependencies);
    const runFiles = filesFor(isolated, parsed['--run']);
    const path = boundedPath(runFiles.root, relative(runFiles.root, resolve(parsed['--file'])));
    requireThat(statSync(path).isFile() && statSync(path).size <= 1048576,
      'Agent submission exceeds its byte limit', 'blocked-budget');
    const input = readJson(path);
    if (action === 'case-source-result') return captureCaseHostSource(isolated, ledger, parsed['--run'], input, true);
    return await submitCaseUrlDraft(isolated, ledger, parsed['--run'], input, true, dependencies);
  } finally { ledger.close(); }
}
