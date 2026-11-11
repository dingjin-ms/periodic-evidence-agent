import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash, json, now } from '../src/common.js';
import { beginCaseDiscovery, captureDiscoveryReceipt, discoveryContext, finalizeDiscovery, reserveDiscoveryTask } from '../src/case-discovery.js';
import { canonicalSourceUrl, caseSourceInventory, urlWithinScope } from '../src/case-source-inventory.js';
import { applyDiscoveryConfig } from '../src/case-discovery-config.js';
import { beginCaseUrlRun, caseUrlContext, captureCaseHostSource, reserveCaseHostSource, submitCaseUrlDraft } from '../src/case-url-flow.js';
import { loadCaseBatch } from '../src/case-generation.js';
import { runCaseDiscoveryCommand } from '../src/case-discovery-cli.js';
import { discoveryFixture } from './fixtures/case-discovery.js';

test('discovery pins scope/instructions and starts no source calls, assignments or publication', async t => {
  const ctx = await discoveryFixture(t);
  assert.equal(ctx.start().runId, ctx.runId);
  const state = discoveryContext(ctx.base, ctx.discoveryLedger, ctx.runId);
  assert.equal(state.callsReserved, 0);
  assert.equal(state.candidates.length, 0);
  assert.equal(state.instructionFingerprint.tools[0].version, null);
  assert.equal(ctx.discoveryLedger.all('assignment').length, 0);
  assert.equal(ctx.configuration().discovery, undefined);
  assert.throws(() => beginCaseDiscovery(ctx.base, ctx.discoveryLedger, ctx.request, {}, { projectRoot: ctx.root }), /authorization/);
  const bad = structuredClone(ctx.request); bad.allowedUrlPrefixes = ['https://example.sharepoint.com/'];
  assert.throws(() => beginCaseDiscovery(ctx.base, ctx.discoveryLedger, bad, { authorizeDiscovery: true }, { projectRoot: ctx.root }), /concrete/);
  writeFileSync(join(ctx.root, '.github', 'skills', 'discover-test-evidence', 'SKILL.md'), 'Changed instructions');
  assert.throws(() => discoveryContext(ctx.base, ctx.discoveryLedger, ctx.runId), /instructions changed/);
});

test('content/search require the actual executing identity and exact approved scope', async t => {
  const ctx = await discoveryFixture(t);
  assert.throws(() => ctx.reserve(ctx.task('search')), /identity/);
  ctx.reserve(ctx.task('identity', { kind: 'identity', toolName: 'workiq-fetch',
    url: 'https://graph.microsoft.com/v1.0/me', query: null, identityRef: null }));
  assert.throws(() => ctx.capture('identity', { identity: { id: 'wrong', userPrincipalName: ctx.base.identity.designatedUser },
    response: { id: 'wrong', userPrincipalName: ctx.base.identity.designatedUser } }), /identity/);
  ctx.capture('identity', { identity: { id: ctx.base.identity.objectId, userPrincipalName: ctx.base.identity.designatedUser },
    response: { id: ctx.base.identity.objectId, userPrincipalName: ctx.base.identity.designatedUser } });
  assert.throws(() => ctx.reserve(ctx.task('escape', { url: 'https://example.sharepoint.com/sites/agent-other' })), /namespace/);
  assert.throws(() => ctx.reserve(ctx.task('token', { url: 'https://example.sharepoint.com/sites/agent?token=secret' })), /credential-free/);
  assert.throws(() => ctx.reserve(ctx.task('tool', { toolName: 'powershell' })), /approved discovery contract/);
  assert.equal(urlWithinScope('https://example.invalid/scope-other', ['https://example.invalid/scope']), false);
});

test('Figma uses its own identity and cannot borrow a WorkIQ receipt', async t => {
  const ctx = await discoveryFixture(t);
  ctx.identity();
  assert.throws(() => ctx.reserve(ctx.task('figma-read', { kind: 'read', provider: 'figma', query: null,
    toolName: 'figma-get-metadata', url: 'https://www.figma.com/design/synthetic', identityRef: 'identity' })), /provider identity/);
  ctx.reserve(ctx.task('figma-identity', { kind: 'identity', provider: 'figma', toolName: 'figma-whoami',
    url: 'https://api.figma.com/v1/me', query: null, identityRef: null }));
  assert.throws(() => ctx.capture('figma-identity', { identity: { email: 'wrong@example.invalid' },
    response: { email: 'wrong@example.invalid' } }), /whoami/);
  ctx.capture('figma-identity', { identity: { email: ctx.base.identity.designatedUser },
    response: { email: ctx.base.identity.designatedUser } });
  ctx.reserve(ctx.task('figma-read', { kind: 'read', provider: 'figma', toolName: 'figma-get-metadata', query: null,
    url: 'https://www.figma.com/design/synthetic', identityRef: 'figma-identity' }));
  assert.equal(discoveryContext(ctx.base, ctx.discoveryLedger, ctx.runId).callsReserved, 3);
});

test('duplicate or uncertain reads never become another host call on resume', async t => {
  const ctx = await discoveryFixture(t);
  ctx.identity(); ctx.reserve(ctx.task('search'));
  assert.throws(() => ctx.reserve(ctx.task('search')), /already reserved/);
  assert.throws(() => ctx.reserve(ctx.task('same-search', { query: 'search' })), /already reserved/);
  assert.throws(() => finalizeDiscovery(ctx.base, ctx.discoveryLedger, ctx.runId, ctx.selection(), true), /pending/);
  ctx.capture('search');
  const count = discoveryContext(ctx.base, ctx.discoveryLedger, ctx.runId).callsReserved;
  assert.equal(ctx.start().callsReserved, count);
  assert.throws(() => ctx.capture('search', { response: { text: 'changed response' } }), /response changed/);
});

test('receipt bytes and run-call budgets cannot be reset by a fresh invocation', async t => {
  const ctx = await discoveryFixture(t, { maxCalls: 2 });
  ctx.identity(); ctx.reserve(ctx.task('search'));
  ctx.capture('search');
  assert.throws(() => ctx.reserve(ctx.task('over-budget')), /budget exhausted/);
  assert.equal(ctx.start().callsReserved, 2);
  const other = await discoveryFixture(t, { maxResponseBytes: 1024, maxTotalBytes: 2048 });
  other.identity(); other.reserve(other.task('search'));
  assert.throws(() => other.capture('search', { response: { text: 'x'.repeat(2048) } }), /byte limit/);
});

test('metadata, fabricated approval and unpinned repository evidence cannot qualify a source', async t => {
  const ctx = await discoveryFixture(t);
  ctx.identity(); ctx.reserve(ctx.task('search'));
  const candidate = { type: 'requirements', title: 'Synthetic', exactLocation: 'R1', sourceVersion: null,
    authority: 'unknown', authorityBasis: null, applicability: 'unknown', limitations: 'Unknown approval.' };
  assert.throws(() => ctx.capture('search', { candidate }), /exact-source/);
  ctx.capture('search');
  ctx.reserve(ctx.task('read', { kind: 'read', toolName: 'workiq-fetch',
    url: 'https://example.sharepoint.com/sites/agent/read', query: null }));
  assert.throws(() => ctx.capture('read', { candidate, access: 'metadata-only' }), /exact-source/);
  assert.throws(() => ctx.capture('read', { candidate: { ...candidate, authority: 'approved' } }), /authority basis/);
  ctx.capture('read', { candidate });
  ctx.reserve(ctx.task('repo', { kind: 'read', provider: 'repository', toolName: 'repository-read',
    url: 'https://github.com/example/product/blob/main/source.js', query: null, identityRef: null }));
  assert.throws(() => ctx.capture('repo', { candidate: { ...candidate, type: 'repository' } }), /commit/);
});

test('canonical identities deduplicate query ordering, ADO aliases and Figma tracking variants', () => {
  assert.equal(canonicalSourceUrl('https://office.visualstudio.com/OC/_workitems/edit/42').href,
    'https://dev.azure.com/office/OC/_workitems/edit/42');
  assert.equal(canonicalSourceUrl('https://www.figma.com/file/key/title?m=dev&node-id=1%3A2&p=f').href,
    canonicalSourceUrl('https://www.figma.com/design/key/renamed?node-id=1-2').href);
  assert.equal(canonicalSourceUrl('https://example.invalid/path?b=2&a=1').href,
    canonicalSourceUrl('https://example.invalid/path?a=1&b=2').href);
  assert.equal(urlWithinScope('https://dev.azure.com/office/OC/_workitems/edit/42',
    ['https://office.visualstudio.com/OC']), true);
});

test('blocked authentication remains visible and stops further provider calls', async t => {
  const ctx = await discoveryFixture(t);
  ctx.reserve(ctx.task('identity', { kind: 'identity', toolName: 'workiq-fetch',
    url: 'https://graph.microsoft.com/v1.0/me', query: null, identityRef: null }));
  ctx.capture('identity', { access: 'blocked', failureKind: 'auth', response: { error: 'Synthetic sign-in required' } });
  assert.throws(() => ctx.reserve(ctx.task('search')), /blocked|identity/);
  assert.throws(() => ctx.capture('identity', { response: { access_token: 'do-not-store' } }), /response changed|credentials/);
});

test('one inaccessible source does not block unrelated qualified work on the same provider', async t => {
  const ctx = await discoveryFixture(t);
  ctx.identity();
  ctx.reserve(ctx.task('unavailable', { kind: 'read', toolName: 'workiq-fetch',
    url: 'https://example.sharepoint.com/sites/agent/private', query: null }));
  ctx.capture('unavailable', { access: 'blocked', failureKind: 'access', response: { error: 'Synthetic document access denied' } });
  ctx.qualify('accessible');
  assert.equal(discoveryContext(ctx.base, ctx.discoveryLedger, ctx.runId).candidates.length, 1);
});

test('selection reports exact examined IDs and rejects missing/extra/duplicate candidates', async t => {
  const ctx = await discoveryFixture(t); ctx.ready();
  const input = ctx.selection();
  assert.throws(() => finalizeDiscovery(ctx.base, ctx.discoveryLedger, ctx.runId, { ...input, decisions: [] }, true), /every candidate/);
  assert.throws(() => finalizeDiscovery(ctx.base, ctx.discoveryLedger, ctx.runId,
    { ...input, decisions: [...input.decisions, ...input.decisions] }, true), /every candidate/);
  const result = ctx.seal();
  assert.equal(result.state, 'selection-qualified');
  assert.equal(result.manifest.acceptance.expectedCount, 1);
  assert.equal(result.manifest.acceptance.examinedCount, 1);
  assert.deepEqual(result.manifest.acceptance.expectedIds, result.manifest.acceptance.examinedIds);
  assert.equal(result.manifest.acceptance.callsExamined, 3);
  assert.equal(result.manifest.acceptance.surfacesExamined.length, 4);
  assert.ok(result.manifest.acceptance.notRun.includes('independent-source-authority-review'));
  assert.equal(result.manifestSha256, hash(json(result.manifest)));
  assert.deepEqual(ctx.seal(), result);
  assert.throws(() => ctx.reserve(ctx.task('after-seal')), /sealed/);
  assert.throws(() => finalizeDiscovery(ctx.base, ctx.discoveryLedger, ctx.runId,
    { ...input, stopReason: 'Changed selection' }, true), /selection changed/);
});

test('four rows alone cannot masquerade as searched coverage; missing gaps fail', async t => {
  const ctx = await discoveryFixture(t); ctx.ready();
  const input = ctx.selection(), badRows = structuredClone(input.coverage);
  badRows[0].operationIds = [];
  assert.throws(() => finalizeDiscovery(ctx.base, ctx.discoveryLedger, ctx.runId, { ...input, coverage: badRows }, true), /actual successful/);
  badRows[0].status = 'unavailable';
  assert.throws(() => finalizeDiscovery(ctx.base, ctx.discoveryLedger, ctx.runId, { ...input, coverage: badRows }, true), /explicit gap/);
  const duplicated = structuredClone(input.coverage); duplicated[3] = duplicated[0];
  assert.throws(() => finalizeDiscovery(ctx.base, ctx.discoveryLedger, ctx.runId, { ...input, coverage: duplicated }, true), /all four/);
  const broken = structuredClone(input.coverage); broken[0].operationIds = ['missing'];
  assert.throws(() => finalizeDiscovery(ctx.base, ctx.discoveryLedger, ctx.runId, { ...input, coverage: broken }, true), /resolve/);
});

test('zero-source scoped searches seal honestly but cannot publish configuration', async t => {
  const ctx = await discoveryFixture(t);
  ctx.identity(); ctx.reserve(ctx.task('search')); ctx.capture('search', { response: { results: [] } });
  const input = ctx.selection();
  input.coverage.forEach(row => { row.status = 'not-found'; });
  input.gaps = [{ id: 'no-sources', surfaces: ctx.request.surfaces, reason: 'No candidates found within the approved search.' }];
  const result = finalizeDiscovery(ctx.base, ctx.discoveryLedger, ctx.runId, input, true);
  assert.equal(result.state, 'blocked');
  assert.equal(result.manifest.acceptance.examinedCount, 0);
  assert.equal(result.manifest.acceptance.callsExamined, 2);
  await assert.rejects(applyDiscoveryConfig(ctx.base, ctx.discoveryLedger, ctx.runId, { authorizeConfigUpdate: true }), /blocked|source|selection/i);
});

test('held ambiguity is excluded while an unaffected selected slice remains explicit', async t => {
  const ctx = await discoveryFixture(t); ctx.ready(); ctx.qualify('other', { surfaces: ['Code'] });
  const input = ctx.selection();
  input.decisions[0].decision = 'held';
  input.gaps = [{ id: 'ambiguous', surfaces: ctx.request.surfaces, reason: 'Conflicting applicability; hold the affected source.' }];
  const result = finalizeDiscovery(ctx.base, ctx.discoveryLedger, ctx.runId, input, true);
  assert.equal(result.state, 'partial');
  assert.equal(result.manifest.sources.length, 1);
});

test('discovery-backed selected inventory reaches real case context and canonical admission', async t => {
  const ctx = await discoveryFixture(t); ctx.ready();
  const authorityBasis = 'Synthetic requirement R2 approval at revision 1, section Approval.';
  ctx.reserve(ctx.task('second-source', { kind: 'read', toolName: 'workiq-fetch',
    url: 'https://example.sharepoint.com/sites/agent/second-source', query: null }));
  ctx.capture('second-source', { response: { text: `${authorityBasis} Save and reopen preserves the value.` },
    candidate: { type: 'requirements', title: 'Synthetic approved persistence contract',
      exactLocation: 'R2 / Approval', sourceVersion: '1', authority: 'approved', authorityBasis,
      applicability: 'applicable', limitations: 'Synthetic source; independent source/case QA remains required.' } });
  const selection = ctx.seal();
  await applyDiscoveryConfig(ctx.base, ctx.discoveryLedger, ctx.runId, { authorizeConfigUpdate: true });
  const inventory = caseSourceInventory(ctx.configuration());
  assert.equal(inventory.length, 4);
  assert.deepEqual(inventory.map(item => item.type).sort(), ['requirements', 'requirements', 'sample', 'template']);
  const calls = [];
  const deps = { projectRoot: ctx.root, execute: async () => ({ stdout: `${'b'.repeat(40)}\n` }),
    environment: {}, getToken: async () => 'synthetic-only',
    fetchResponse: async url => {
      calls.push(url);
      return Response.json(url.includes('/templates/') ? { id: ctx.admission.destination.template.id,
        workItemTypeName: 'Bug', fields: ctx.admission.destination.template.fields } :
        { id: 1, rev: 1, fields: { 'System.TeamProject': 'Demo' } });
    } };
  const run = await beginCaseUrlRun(ctx.base, ctx.ledger,
    { authorizeCollection: true, authorizeGeneration: true }, deps);
  assert.equal(calls.length, 2);
  assert.equal(run.state, 'awaiting-source-connectors');
  assert.equal(run.tasks.length, 2);
  for (const selected of selection.manifest.sources) {
    reserveCaseHostSource(ctx.base, ctx.ledger, run.runId, selected.id, true);
    captureCaseHostSource(ctx.base, ctx.ledger, run.runId, {
      sourceId: selected.id, url: selected.url, toolName: 'workiq-fetch', toolCallId: null, observedAt: now(),
      identity: { id: ctx.base.identity.objectId, userPrincipalName: ctx.base.identity.designatedUser },
      response: { text: 'R1: Save and reopen retains the synthetic value.' }, access: 'partial',
      limitations: 'Synthetic exact source; product authority remains unknown.' }, true);
  }
  const context = caseUrlContext(ctx.base, ctx.ledger, run.runId);
  assert.equal(context.state, 'ready-for-design');
  const body = JSON.parse(readFileSync(context.contextPath, 'utf8'));
  assert.equal(body.discovery.manifestSha256, selection.manifestSha256);
  const approved = selection.manifest.candidates.find(candidate => candidate.operationId === 'second-source');
  assert.equal(body.discovery.qualifications.find(source => source.id === approved.id).authorityBasis, authorityBasis);
  assert.equal(body.discovery.qualifications.find(source => source.id !== approved.id).authorityBasis, null);
  const selected = selection.manifest.sources[0];
  assert.ok(body.sources.some(item => item.sourceId === selected.id && item.type === 'requirements'));
  const draft = structuredClone(ctx.draft), refs = selection.manifest.sources.map(source => ({
    sourceId: source.id, section: source.id }));
  draft.requirements[0].sourceRefs = refs;
  draft.cases[0].sourceRefs = refs;
  draft.cases[0].steps.forEach(step => { step.sourceRefs = refs; });
  const submitted = await submitCaseUrlDraft(ctx.base, ctx.ledger, run.runId,
    { generator: 'synthetic-app-host', draft, fixtureRequests: [] }, true, deps);
  assert.equal(submitted.state, 'review-held');
  const { configAt } = await import('../src/common.js');
  const { Ledger } = await import('../src/ledger.js');
  const config = configAt(submitted.controllerConfig), child = new Ledger(config.stateDirectory);
  try {
    const { bundle } = loadCaseBatch(config, child, submitted.batchId);
    assert.deepEqual(bundle.admission.sources.map(source => source.id).sort(), inventory.map(source => source.id).sort());
    assert.equal(bundle.admission.sources.find(source => source.id === approved.id).approval, 'unknown');
  } finally { child.close(); }
  assert.equal(ctx.ledger.all('assignment').length, 0);
});

test('discovery CLI rejects unauthorized and unknown stages before opening state', async () => {
  await assert.rejects(runCaseDiscoveryCommand('case-discover-start', ['--file', 'missing.json']), /authorization/);
  await assert.rejects(runCaseDiscoveryCommand('case-discover-apply', ['--run', 'missing', '--execute']), /Unknown/);
  await assert.rejects(runCaseDiscoveryCommand('case-discover-reserve', ['--run', 'missing', '--authorize-discovery']), /inputs/);
});
