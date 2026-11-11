import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { boundedPath, hash, json, now, requireThat, utc, validateRecord } from './common.js';
import { completedOperation, operationRow } from './case-generation.js';
import { canonicalSourceUrl, discoverySurfaces, sourceHttpsUrl, urlWithinScope } from './case-source-inventory.js';

const instructions = ['AGENTS.md', '.github\\copilot-instructions.md',
  '.github\\skills\\discover-test-evidence\\SKILL.md', 'scaffold\\CASE-DISCOVERY.md'];
const assurance = 'Host tool-reported evidence; structural checks do not prove source authority, exhaustive coverage or semantic reasoning. URL selection is not approved test-design readiness.';
function fingerprint(root, request) {
  return { files: instructions.filter(path => existsSync(join(root, path)))
    .map(path => ({ path, sha256: hash(readFileSync(boundedPath(root, path))) })),
  tools: request.tools, model: request.model };
}
const callRows = (ledger, runId) => ledger.status().operations
  .filter(row => row.job_id === runId && row.kind === 'case-discovery-call');
const callDetail = row => JSON.parse(row.detail);
function candidatesFor(ledger, runId) {
  const found = new Map();
  for (const row of callRows(ledger, runId)) {
    const candidate = callDetail(row).candidate;
    if (row.state === 'complete' && candidate) {
      requireThat(!found.has(candidate.id), 'Duplicate candidate identity; reconcile the original qualification', 'blocked-reconciliation');
      found.set(candidate.id, candidate);
    }
  }
  return [...found.values()].sort((a, b) => a.id.localeCompare(b.id));
}
export function loadDiscoveryRun(base, ledger, runId) {
  requireThat(/^discovery-[a-f0-9]{24}$/.test(runId), 'Invalid discovery run ID', 'invalid-record');
  requireThat(base.statePolicy?.accessApproved === true, 'Discovery requires approved private storage', 'blocked-authorization');
  const run = completedOperation(ledger, runId, 'case-discovery-run');
  requireThat(run.id === runId && run.identitySha256 === hash(json(base.identity)),
    'Discovery identity changed; preserve the original run', 'blocked-auth');
  validateRecord(run.request, 'caseDiscoveryRequest');
  const binding = hash(json({ root: run.projectRoot, request: run.request, identity: base.identity,
    configuration: run.configuration, instructionFingerprint: run.instructionFingerprint }));
  requireThat(run.configurationSha256 === hash(run.configuration) &&
    runId === `discovery-${hash(json([binding, run.createdAt, run.nonce])).slice(0, 24)}`,
  'Discovery run scope or configuration integrity changed', 'blocked-reconciliation');
  requireThat(json(fingerprint(run.projectRoot, run.request)) === json(run.instructionFingerprint),
    'Discovery instructions changed; review impact and authorize a child run', 'blocked-reconciliation');
  return run;
}
export function beginCaseDiscovery(base, ledger, input, { authorizeDiscovery = false, refresh = false } = {}, { projectRoot } = {}) {
  requireThat(authorizeDiscovery && base.statePolicy?.accessApproved === true,
    'Discovery needs explicit scoped read and private storage authorization', 'blocked-authorization');
  const request = validateRecord(structuredClone(input), 'caseDiscoveryRequest');
  requireThat(new Set(request.tools.map(tool => tool.name)).size === request.tools.length,
    'Discovery tool names must be unique', 'invalid-record');
  for (const prefix of request.allowedUrlPrefixes) {
    const url = sourceHttpsUrl(prefix);
    requireThat(!url.hash && url.pathname !== '/', 'Approve concrete source namespaces, not an entire provider', 'blocked-scope');
  }
  requireThat(request.limits.maxSelected <= request.limits.maxCandidates &&
    request.limits.maxResponseBytes <= request.limits.maxTotalBytes, 'Inconsistent discovery limits', 'invalid-record');
  const root = resolve(projectRoot), path = boundedPath(root, 'generateE2E.config.json');
  const configuration = readFileSync(path, 'utf8');
  requireThat(Buffer.byteLength(configuration) <= 1048576, 'Source configuration exceeds its byte limit', 'blocked-budget');
  const parsed = JSON.parse(configuration);
  requireThat(parsed.inputs && parsed.guidance !== null, 'Existing source configuration needs inputs', 'invalid-record');
  const instructionFingerprint = fingerprint(root, request);
  requireThat(instructionFingerprint.files.some(file => file.path.includes('discover-test-evidence')),
    'Discovery skill is missing from this checkout', 'blocked-config');
  const binding = hash(json({ root, request, identity: base.identity, configuration, instructionFingerprint }));
  const slot = `discovery-active-${binding}`, owner = ledger.acquire(slot);
  try {
    const old = operationRow(ledger, slot);
    if (old && !refresh) return discoveryContext(base, ledger, completedOperation(ledger, slot, 'case-discovery-active').runId);
    const parentRunId = old ? completedOperation(ledger, slot, 'case-discovery-active').runId : null;
    const createdAt = now(), nonce = crypto.randomUUID();
    const id = `discovery-${hash(json([binding, createdAt, nonce])).slice(0, 24)}`;
    const run = { format: 'case-discovery-run-v1', id, request, projectRoot: root, createdAt, cutoff: createdAt, nonce,
      recentDays: 90, parentRunId, configuration, configurationSha256: hash(configuration),
      identitySha256: hash(json(base.identity)), instructionFingerprint, assurance };
    ledger.transaction(() => {
      ledger.operation(id, id, 'case-discovery-run', {});
      ledger.finishOperation(id, 'complete', run);
      if (!old) ledger.operation(slot, id, 'case-discovery-active', {});
      ledger.finishOperation(slot, 'complete', { runId: id });
    });
    return discoveryContext(base, ledger, id);
  } finally { ledger.release(slot, owner); }
}
export function discoveryContext(base, ledger, runId) {
  const run = loadDiscoveryRun(base, ledger, runId), rows = callRows(ledger, runId);
  const selection = operationRow(ledger, `${runId}:selection`);
  const consumed = rows.reduce((total, row) => total + (callDetail(row).bytes ?? 0), 0);
  return { state: selection ? completedOperation(ledger, selection.id, selection.kind).state : 'awaiting-discovery',
    runId, scope: run.request.scope, surfaces: run.request.surfaces, cutoff: run.cutoff,
    recentDays: run.recentDays, instructionFingerprint: run.instructionFingerprint,
    limits: run.request.limits, callsReserved: rows.length, bytesCaptured: consumed,
    tasks: rows.map(row => ({ ...callDetail(row).task, state: row.state })),
    candidates: candidatesFor(ledger, runId), assurance,
    ...(selection ? { selection: completedOperation(ledger, selection.id, selection.kind) } : {}) };
}
export function reserveDiscoveryTask(base, ledger, runId, input, authorizeDiscovery) {
  requireThat(authorizeDiscovery === true, 'Discovery task needs scoped read authorization', 'blocked-authorization');
  const run = loadDiscoveryRun(base, ledger, runId), task = validateRecord(structuredClone(input), 'caseDiscoveryTask');
  const owner = ledger.acquire(`${runId}:calls`);
  try {
    requireThat(!operationRow(ledger, `${runId}:selection`), 'Discovery selection is sealed', 'blocked-reconciliation');
    const rows = callRows(ledger, runId), limits = run.request.limits;
    requireThat(Date.now() - Date.parse(run.createdAt) < limits.maxMinutes * 60000 && rows.length < limits.maxCalls,
      'Discovery time/call budget exhausted; retain partial coverage', 'blocked-budget');
    const reservedBytes = rows.reduce((total, row) => total +
      (row.state === 'complete' ? callDetail(row).bytes : limits.maxResponseBytes), 0);
    requireThat(reservedBytes + limits.maxResponseBytes <= limits.maxTotalBytes,
      'Discovery aggregate byte reservation exhausted', 'blocked-budget');
    requireThat(run.request.tools.some(tool => tool.name === task.toolName),
      'Tool was not included in the approved discovery contract', 'blocked-scope');
    if (task.kind === 'identity') {
      const url = sourceHttpsUrl(task.url);
      const approved = task.provider === 'workiq' ? url.href === 'https://graph.microsoft.com/v1.0/me' :
        task.provider === 'figma' ? url.href === 'https://api.figma.com/v1/me' :
          task.provider === 'ado' && url.origin === 'https://dev.azure.com' && !url.search && !url.hash &&
          /^\/[^/]+\/_apis\/connectionData$/.test(url.pathname) &&
          run.request.allowedUrlPrefixes.some(prefix => {
            const allowed = canonicalSourceUrl(prefix);
            return allowed.origin === url.origin && allowed.pathname.split('/')[1] === url.pathname.split('/')[1];
          });
      requireThat(approved, 'Identity task must use its exact provider identity locator', 'blocked-scope');
      requireThat(task.query === null, 'Identity task cannot include a search query', 'invalid-record');
    } else requireThat(urlWithinScope(task.url, run.request.allowedUrlPrefixes),
      'Discovery task escaped its approved source namespace', 'blocked-scope');
    requireThat(!rows.some(row => {
      const prior = callDetail(row).task;
      return prior.id === task.id || json([prior.kind, prior.provider, prior.url, prior.query]) ===
        json([task.kind, task.provider, task.url, task.query]);
    }), 'Discovery task already reserved; reconcile its actual response, do not repeat it', 'blocked-reconciliation');
    if (task.provider !== 'repository' && task.kind !== 'identity') {
      requireThat(!rows.some(row => row.state === 'complete' &&
        callDetail(row).task.provider === task.provider && callDetail(row).receipt.failureKind === 'auth'),
      'Provider is blocked; remediate and authorize a new pass, do not loop', 'blocked-auth');
      const verified = rows.find(row => callDetail(row).task.id === task.identityRef && row.state === 'complete');
      const detail = verified && callDetail(verified);
      requireThat(detail?.task.kind === 'identity' && detail.task.provider === task.provider && detail.receipt.access !== 'blocked',
        'Verify the executing provider identity before discovery content/search reads', 'blocked-auth');
    } else requireThat(task.identityRef === null, 'Identity/repository tasks do not inherit another provider identity', 'invalid-record');
    requireThat(task.kind !== 'search' || task.query?.trim(), 'Search tasks require their exact query', 'invalid-record');
    const record = { task, reservedAt: now() };
    ledger.operation(`${runId}:call:${task.id}`, runId, 'case-discovery-call', record);
    return { state: 'discovery-read-reserved', runId, ...record, maxResponseBytes: limits.maxResponseBytes,
      nextAction: 'Execute this exact bounded approved host operation once; capture the actual sanitized response.' };
  } finally { ledger.release(`${runId}:calls`, owner); }
}
function checkIdentity(base, task, receipt) {
  if (task.kind !== 'identity' || receipt.access === 'blocked') return;
  const expected = base.identity, actual = receipt.identity;
  if (task.provider === 'figma') requireThat(
    actual?.email?.toLowerCase() === expected.designatedUser?.toLowerCase() &&
    receipt.response.email?.toLowerCase() === expected.designatedUser?.toLowerCase(),
  'Figma whoami must match the designated account', 'blocked-auth');
  else requireThat(actual?.userPrincipalName?.toLowerCase() === expected.designatedUser?.toLowerCase() &&
    (task.provider === 'ado'
      ? typeof actual.id === 'string' && actual.id.length > 0 && receipt.response.authenticatedUser?.id === actual.id &&
        receipt.response.authenticatedUser?.properties?.Account?.$value?.toLowerCase() === actual.userPrincipalName.toLowerCase()
      : actual.id === expected.objectId && receipt.response.id === actual.id &&
        receipt.response.userPrincipalName === actual.userPrincipalName),
  'Executing provider identity must match the designated account and actual response', 'blocked-auth');
}
export function captureDiscoveryReceipt(base, ledger, runId, input, authorizeDiscovery) {
  requireThat(authorizeDiscovery === true, 'Discovery capture needs scoped authorization', 'blocked-authorization');
  const run = loadDiscoveryRun(base, ledger, runId), receipt = validateRecord(structuredClone(input), 'caseDiscoveryReceipt');
  const id = `${runId}:call:${receipt.operationId}`, owner = ledger.acquire(`${runId}:calls`);
  try {
    requireThat(!operationRow(ledger, `${runId}:selection`), 'Discovery selection is sealed', 'blocked-reconciliation');
    const row = operationRow(ledger, id);
    requireThat(row?.kind === 'case-discovery-call', 'Reserve a discovery operation before capture', 'blocked-reconciliation');
    const prior = callDetail(row), receiptSha256 = hash(json(receipt));
    if (row.state === 'complete') {
      requireThat(prior.receiptSha256 === receiptSha256, 'Discovery response changed; preserve its original receipt', 'blocked-reconciliation');
      return discoveryContext(base, ledger, runId);
    }
    const bytes = Buffer.byteLength(json(receipt));
    requireThat(bytes <= run.request.limits.maxResponseBytes, 'Discovery response exceeds its reserved byte limit', 'blocked-budget');
    utc(receipt.observedAt);
    requireThat(Date.parse(receipt.observedAt) >= Date.parse(prior.reservedAt) && Date.parse(receipt.observedAt) <= Date.now(),
      'Discovery observation must follow reservation and not be future-dated', 'invalid-record');
    requireThat(!/(?:authorization|access_token|refresh_token|password|cookie)"\s*:/i.test(json(receipt.response)),
      'Do not persist transport credentials in discovery responses', 'blocked-scope');
    requireThat(receipt.access === 'blocked' || !receipt.response.error,
      'Source errors cannot establish successful discovery', 'invalid-record');
    requireThat(receipt.access === 'blocked' ? ['auth', 'access', 'source', 'capability'].includes(receipt.failureKind) :
      receipt.failureKind == null, 'Blocked receipts require an explicit failure kind; successful receipts cannot claim failures', 'invalid-record');
    checkIdentity(base, prior.task, receipt);
    requireThat(prior.task.kind === 'identity' || receipt.identity === null,
      'Content calls reference the pinned provider identity; do not inject another identity', 'invalid-record');
    let candidate = null;
    if (receipt.candidate) {
      requireThat(prior.task.kind === 'read' && ['full', 'partial'].includes(receipt.access),
        'Candidates need substantive exact-source qualification, not search metadata', 'invalid-record');
      requireThat(!/search|ask/i.test(prior.task.toolName),
        'Search tools cannot qualify candidates by relabeling their operation as a read', 'invalid-record');
      requireThat(receipt.candidate.authority !== 'approved' || receipt.candidate.authorityBasis?.trim(),
        'Claimed approval requires an exact source-backed authority basis', 'invalid-record');
      requireThat(!/search|retrieve|ask/i.test(prior.task.toolName) || receipt.access !== 'full',
        'Search/retrieval is not a full exact-source read', 'invalid-record');
      if (prior.task.provider === 'repository' || receipt.candidate.type === 'repository') requireThat(
        prior.task.provider === 'repository' && receipt.candidate.type === 'repository' &&
        /^[a-f0-9]{40}$/.test(receipt.candidate.sourceVersion ?? '') && receipt.candidate.exactLocation.trim(),
      'Repository evidence requires a commit and exact file location', 'invalid-record');
      const url = canonicalSourceUrl(prior.task.url);
      candidate = { ...receipt.candidate, id: `src-${hash(url.href).slice(0, 24)}`, url: url.href,
        surfaces: prior.task.surfaces, provider: prior.task.provider, readStatus: receipt.access,
        operationId: prior.task.id, retrievedAt: receipt.observedAt, receiptSha256 };
      requireThat(candidatesFor(ledger, runId).length < run.request.limits.maxCandidates &&
        !candidatesFor(ledger, runId).some(item => item.id === candidate.id),
      'Candidate limit or duplicate source identity; preserve the original qualification', 'blocked-budget');
    }
    ledger.finishOperation(id, 'complete', { ...prior, receipt, receiptSha256, bytes, candidate,
      provenance: 'app-host-tool-reported' });
    return discoveryContext(base, ledger, runId);
  } finally { ledger.release(`${runId}:calls`, owner); }
}
export function finalizeDiscovery(base, ledger, runId, input, authorizeDiscovery) {
  requireThat(authorizeDiscovery === true, 'Selection requires explicit discovery authorization', 'blocked-authorization');
  const run = loadDiscoveryRun(base, ledger, runId), selection = validateRecord(structuredClone(input), 'caseDiscoverySelection');
  const id = `${runId}:selection`, owner = ledger.acquire(`${runId}:calls`);
  try {
    const old = operationRow(ledger, id);
    if (old) {
      const result = completedOperation(ledger, id, 'case-discovery-selection');
      requireThat(json(result.manifest.selection) === json(selection), 'Discovery selection changed; authorize a child run', 'blocked-reconciliation');
      return result;
    }
    const rows = callRows(ledger, runId);
    requireThat(rows.every(row => row.state === 'complete'), 'Reconcile pending discovery operations before sealing', 'blocked-reconciliation');
    const candidates = candidatesFor(ledger, runId), expectedIds = candidates.map(item => item.id).sort();
    const examinedIds = selection.decisions.map(item => item.sourceId).sort();
    requireThat(json(expectedIds) === json(examinedIds),
      'Selection must examine every candidate exactly once; missing, extra or duplicate source IDs', 'invalid-record');
    requireThat(json(selection.coverage.map(row => row.surface).sort()) === json([...discoverySurfaces].sort()),
      'Coverage must include all four surfaces exactly once', 'invalid-record');
    requireThat(new Set(selection.gaps.map(gap => gap.id)).size === selection.gaps.length, 'Duplicate discovery gap IDs', 'invalid-record');
    for (const coverage of selection.coverage) {
      const referenced = coverage.operationIds.map(callId => rows.find(row => callDetail(row).task.id === callId));
      requireThat(referenced.every(row => row && callDetail(row).task.surfaces.includes(coverage.surface)),
        'Coverage references must resolve to actual in-surface calls', 'invalid-record');
      const searched = referenced.some(row => callDetail(row).task.kind === 'search' &&
        callDetail(row).receipt.access !== 'blocked');
      requireThat(!['searched', 'not-found'].includes(coverage.status) || searched,
        'Searched/not-found coverage requires an actual successful scoped search', 'invalid-record');
      requireThat(coverage.status !== 'not-found' || !candidates.some(item => item.surfaces.includes(coverage.surface)),
        'Not-found coverage contradicts qualified candidates', 'invalid-record');
      requireThat(coverage.status === 'searched' || selection.gaps.some(gap => gap.surfaces.includes(coverage.surface)),
        'Incomplete surface coverage needs an explicit gap', 'invalid-record');
    }
    const selected = selection.decisions.filter(item => item.decision === 'selected');
    requireThat(selected.length <= run.request.limits.maxSelected, 'Selected source limit exceeded', 'blocked-budget');
    for (const decision of selection.decisions.filter(item => item.decision === 'held')) {
      const candidate = candidates.find(item => item.id === decision.sourceId);
      requireThat(selection.gaps.some(gap => candidate.surfaces.some(surface => gap.surfaces.includes(surface))),
        'Held ambiguous candidates require a visible surface gap', 'invalid-record');
    }
    const sources = selected.map(decision => {
      const candidate = candidates.find(item => item.id === decision.sourceId);
      requireThat(candidate.applicability !== 'superseded', 'Superseded sources cannot be selected as current evidence', 'invalid-record');
      return { id: candidate.id, type: candidate.type, url: candidate.url, surfaces: candidate.surfaces };
    }).sort((a, b) => a.id.localeCompare(b.id));
    if (sources.length) validateRecord(sources, 'caseDiscoverySources');
    const acceptance = { validator: 'case-discovery-v1', expectedIds, examinedIds,
      expectedCount: expectedIds.length, examinedCount: examinedIds.length,
      selectedCount: sources.length, callsExamined: rows.length, surfacesExamined: selection.coverage.map(row => row.surface),
      failures: 0, notRun: ['independent-source-authority-review', 'product-test-execution'],
      checks: ['candidate-set-equality', 'coverage-reference-integrity', 'four-surface-accounting', 'selection-scope-and-limits'] };
    const state = !sources.length ? 'blocked' :
      selection.gaps.length || selection.decisions.some(item => item.decision === 'held') ? 'partial' : 'selection-qualified';
    const manifest = { format: 'case-discovery-manifest-v1', runId, scope: run.request.scope,
      cutoff: run.cutoff, sources, candidates, selection, acceptance, assurance };
    const result = { state, manifest, manifestSha256: hash(json(manifest)) };
    ledger.operation(id, runId, 'case-discovery-selection', {});
    ledger.finishOperation(id, 'complete', result);
    return result;
  } finally { ledger.release(`${runId}:calls`, owner); }
}
