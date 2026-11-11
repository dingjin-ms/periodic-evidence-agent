import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Ledger } from '../../src/ledger.js';
import { json, now } from '../../src/common.js';
import { beginCaseDiscovery, captureDiscoveryReceipt, discoveryContext, finalizeDiscovery, reserveDiscoveryTask } from '../../src/case-discovery.js';
import { caseFixture } from './case-generation.js';

export async function discoveryFixture(t, limits = {}) {
  let cleanup;
  const ctx = await caseFixture({ after: callback => { cleanup = callback; } });
  const skill = join(ctx.root, '.github', 'skills', 'discover-test-evidence');
  mkdirSync(skill, { recursive: true });
  writeFileSync(join(skill, 'SKILL.md'), 'Synthetic pinned discovery procedure.');
  const base = { ...ctx.config, stateDirectory: join(ctx.root, 'case-state') };
  const ledger = new Ledger(join(base.stateDirectory, 'discovery'));
  t.after(() => { ledger.close(); cleanup(); });
  const request = { format: 'case-discovery-request-v1', approvalRef: 'synthetic-discovery-approval',
    scope: 'Synthetic four-surface persistence source discovery only',
    surfaces: ['Bizchat', 'GHCP', 'CPNB', 'Code'],
    allowedUrlPrefixes: ['https://example.sharepoint.com/sites/agent', 'https://dev.azure.com/example/Demo',
      'https://www.figma.com/design/synthetic', 'https://github.com/example/product'],
    tools: [{ name: 'workiq-fetch', version: null }, { name: 'workiq-search', version: null },
      { name: 'repository-read', version: null }, { name: 'figma-whoami', version: null },
      { name: 'figma-get-metadata', version: null }],
    model: null, limits: { maxCalls: 30, maxMinutes: 90, maxResponseBytes: 8192,
      maxTotalBytes: 262144, maxCandidates: 20, maxSelected: 15, ...limits } };
  const start = () => beginCaseDiscovery(base, ledger, request, { authorizeDiscovery: true }, { projectRoot: ctx.root });
  const runId = start().runId;
  const task = (id, changes = {}) => ({ id, kind: 'search', provider: 'workiq', toolName: 'workiq-search',
    url: 'https://example.sharepoint.com/sites/agent', query: id,
    surfaces: request.surfaces, identityRef: 'identity', ...changes });
  const reserve = value => reserveDiscoveryTask(base, ledger, runId, value, true);
  const capture = (operationId, changes = {}) => captureDiscoveryReceipt(base, ledger, runId,
    { operationId, observedAt: now(), response: { text: 'Actual synthetic source content' }, access: 'partial',
      identity: null, candidate: null, limitations: 'Synthetic host receipt; no live source claim.', ...changes }, true);
  const identity = () => {
    reserve(task('identity', { kind: 'identity', toolName: 'workiq-fetch',
      url: 'https://graph.microsoft.com/v1.0/me', query: null, identityRef: null }));
    return capture('identity', { access: 'full', identity: { id: base.identity.objectId,
      userPrincipalName: base.identity.designatedUser },
    response: { id: base.identity.objectId, userPrincipalName: base.identity.designatedUser } });
  };
  const qualify = (id = 'source', changes = {}) => {
    reserve(task(id, { kind: 'read', toolName: 'workiq-fetch',
      url: `https://example.sharepoint.com/sites/agent/${id}`, query: null, ...changes }));
    capture(id, { candidate: { type: 'requirements', title: 'Synthetic source',
      exactLocation: 'Section R1', sourceVersion: '1', authority: 'unknown', authorityBasis: null,
      applicability: 'unknown', limitations: 'Approval and applicability not established.' } });
    return discoveryContext(base, ledger, runId).candidates.find(item => item.operationId === id);
  };
  const selection = () => ({ decisions: discoveryContext(base, ledger, runId).candidates.map(item => ({
    sourceId: item.id, decision: 'selected', reason: 'Substantive synthetic requirement candidate.' })),
  coverage: request.surfaces.map(surface => ({ surface, status: 'searched', operationIds: ['search'],
    reason: 'Bounded synthetic scoped search performed; not exhaustive.' })), gaps: [],
  stopReason: 'The selected bounded evidence objective is complete.' });
  const ready = () => { identity(); reserve(task('search')); capture('search'); qualify(); };
  const seal = () => finalizeDiscovery(base, ledger, runId, selection(), true);
  return { ...ctx, base, discoveryLedger: ledger, request, runId, start, task, reserve, capture, identity,
    qualify, selection, ready, seal, configuration: () => JSON.parse(readFileSync(join(ctx.root, 'generateE2E.config.json'), 'utf8')),
    saveConfiguration: value => writeFileSync(join(ctx.root, 'generateE2E.config.json'), json(value)) };
}
