import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { json, now } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import { loadCaseBatch } from '../src/case-generation.js';
import { beginCaseUrlRun, caseUrlContext, reserveCaseHostSource, captureCaseHostSource,
  submitCaseUrlDraft, runCaseUrlCommand, publishReviewedCaseRun } from '../src/case-url-flow.js';
import { recoverCaseSource } from '../src/case-url-flow.js';
import { caseSourceConnectors } from '../src/case-source-connectors.js';
import { materializeCaseFixtures } from '../src/case-fixtures.js';
import { caseFixture, fakeCaseAdo } from './fixtures/case-generation.js';

async function setup(t, overrides = {}) {
  let cleanup;
  const ctx = await caseFixture({ after: callback => { cleanup = callback; } });
  const inputs = {
    CHECKLIST_URL: 'https://example.sharepoint.com/sites/feature/checklist',
    BUG_LIST_URL: 'https://example.visualstudio.com/Demo/_queries/query-edit/12345678-1234-1234-1234-123456789abc/',
    TEST_CASE_TEMPLATE_URL: ctx.admission.sources.find(source => source.type === 'template').url,
    TEST_CASE_SAMPLE_URL: 'https://dev.azure.com/example/Demo/_workitems/edit/1',
    FIGMA_URL: 'https://www.figma.com/design/synthetic/feature?node-id=1-2'
  };
  writeFileSync(join(ctx.root, 'generateE2E.config.json'), json({ inputs }));
  const config = { ...ctx.config, stateDirectory: join(ctx.root, 'auto-state') };
  const ledger = new Ledger(config.stateDirectory);
  const children = [];
  t.after(() => { for (const child of children) child.close(); ledger.close(); cleanup(); });
  const calls = [];
  const dependencies = { projectRoot: ctx.root, execute: async () => ({ stdout: `${'b'.repeat(40)}\n` }), environment: {},
    getToken: async () => 'synthetic-only',
    fetchResponse: async (url, options) => {
      calls.push({ url, options });
      if (url.includes('/templates/')) return Response.json({ id: ctx.admission.destination.template.id,
        workItemTypeName: 'Bug', fields: ctx.admission.destination.template.fields });
      if (url.includes('/wiql/')) return Response.json({ asOf: '2026-10-01T00:00:00Z', workItems: [{ id: 7 }] });
      if (url.includes('workitems?')) return Response.json({ value: [{ id: 7, rev: 2,
        fields: { 'System.TeamProject': 'Demo', 'System.Title': 'Synthetic persistence regression' } }] });
      return Response.json({ id: 1, rev: 1, fields: { 'System.TeamProject': 'Demo' } });
    }, ...overrides };
  const start = () => beginCaseUrlRun(config, ledger, { authorizeCollection: true, authorizeGeneration: true }, dependencies);
  const capture = (runId, sourceId, change = {}) => {
    reserveCaseHostSource(config, ledger, runId, sourceId, true);
    return captureCaseHostSource(config, ledger, runId, { sourceId,
      url: inputs[sourceId === 'checklist' ? 'CHECKLIST_URL' : 'FIGMA_URL'],
      toolName: sourceId === 'checklist' ? 'workiq-fetch' : 'figma-get-node',
      toolCallId: null, identity: { id: config.identity.objectId, userPrincipalName: config.identity.designatedUser },
      observedAt: now(), access: 'partial', limitations: 'Synthetic exact URL response; no external population claim.',
      response: { text: 'Save and reopen preserves synthetic document state.',
        ...(sourceId === 'figma' ? { whoami: { email: config.identity.designatedUser } } : {}) }, ...change }, true);
  };
  const draft = structuredClone(ctx.draft);
  const refs = [{ sourceId: 'checklist', section: 'checklist' }, { sourceId: 'bugs', section: 'ado-7' },
    { sourceId: 'figma', section: 'figma' }];
  draft.requirements[0].sourceRefs = refs;
  const input = { generator: 'synthetic-app-host', draft, fixtureRequests: [] };
  draft.cases[0].sourceRefs = [refs[0]];
  draft.cases[0].steps.forEach(step => { step.sourceRefs = [refs[0]]; });
  return { ...ctx, config, ledger, children, inputs, dependencies, calls, start, capture, input };
}

test('URL-first start reads checked-in guidance and URLs, collects ADO and requests scoped host connectors without user JSON', async t => {
  const ctx = await setup(t);
  const result = await ctx.start();
  assert.equal(result.state, 'awaiting-source-connectors');
  assert.deepEqual(result.tasks.map(task => task.sourceId), ['checklist', 'figma']);
  assert.equal(result.tasks[0].connector, 'workiq');
  assert.equal(ctx.calls.length, 4);
  assert.ok(ctx.calls.every(call => call.options.method === 'GET' && call.options.redirect === 'error'));
  const count = ctx.calls.length;
  assert.equal((await ctx.start()).runId, result.runId);
  assert.equal(ctx.calls.length, count);
  assert.equal(existsSync(join(ctx.root, 'sources.local.json')), false);
  assert.equal(existsSync(join(ctx.root, 'cases.local.json')), false);
  assert.equal(ctx.ledger.all('assignment').length, 0);
});

test('host capture requires a reserved exact URL, actual provenance and the current designated WorkIQ identity', async t => {
  const ctx = await setup(t), result = await ctx.start();
  assert.throws(() => ctx.capture(result.runId, 'checklist', { identity: { id: 'wrong', userPrincipalName: 'wrong' } }), /identity/);
  assert.throws(() => reserveCaseHostSource(ctx.config, ctx.ledger, result.runId, 'checklist', true), /reconcile/);
  const receipt = { sourceId: 'checklist', url: ctx.inputs.CHECKLIST_URL, toolName: 'workiq-fetch',
    toolCallId: null, identity: { id: ctx.config.identity.objectId, userPrincipalName: ctx.config.identity.designatedUser },
    observedAt: now(), access: 'partial', limitations: 'Scoped synthetic capture', response: { text: 'Original source response' } };
  assert.throws(() => captureCaseHostSource(ctx.config, ctx.ledger, result.runId,
    { ...receipt, toolName: 'workiq-retrieve', access: 'complete' }, true), /complete source read/);
  assert.throws(() => captureCaseHostSource(ctx.config, ctx.ledger, result.runId,
    { ...receipt, url: 'https://outside.invalid' }, true), /exact source URL/);
  captureCaseHostSource(ctx.config, ctx.ledger, result.runId, receipt, true);
  assert.throws(() => captureCaseHostSource(ctx.config, ctx.ledger, result.runId,
    { ...receipt, response: { text: 'Changed source response' } }, true), /changed/);
});

test('design first, then materialize a real synthetic workbook and canonical reviewed-hold artifacts; replay does not regenerate files', async t => {
  const ctx = await setup(t), start = await ctx.start();
  ctx.capture(start.runId, 'checklist');
  assert.equal(ctx.capture(start.runId, 'figma').state, 'ready-for-design');
  const input = structuredClone(ctx.input), item = input.draft.cases[0];
  item.fixtureIds = ['sales']; item.noFilesReason = null;
  item.request.inputFiles = 'sales: synthetic-sales.xlsx';
  item.steps[0].input = 'sales';
  input.fixtureRequests = [{ id: 'sales', name: 'synthetic-sales.xlsx', kind: 'xlsx', synthetic: true,
    purpose: 'The designed persistence case needs a small workbook.', handling: 'Synthetic local test data only.',
    sheets: [{ name: 'Sales', rows: [['Region', 'Amount'], ['Synthetic West', 42], ['=literal-text', 7]] }] }];
  const result = await submitCaseUrlDraft(ctx.config, ctx.ledger, start.runId, input, true, ctx.dependencies);
  assert.equal(result.state, 'review-held');
  assert.equal(result.publicationAuthorized, false);
  assert.equal(result.productExecutionAuthorized, false);
  const childConfig = JSON.parse(readFileSync(result.controllerConfig, 'utf8'));
  const child = new Ledger(childConfig.stateDirectory);
  ctx.children.push(child);
  const { bundle } = loadCaseBatch(childConfig, child, result.batchId);
  assert.equal(bundle.admission.repoId, 'case-design');
  assert.equal(bundle.sources[0].approval, 'unknown');
  const fixture = bundle.admission.fixtures[0];
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(readFileSync(join(childConfig.caseGeneration.inputRoot, fixture.path)));
  assert.equal(workbook.getWorksheet('Sales').getCell('A3').value, '=literal-text');
  assert.equal(workbook.getWorksheet('Sales').getCell('A3').type, ExcelJS.ValueType.String);
  assert.match(fixture.provenance, /CASE1.*recipe SHA-256/);
  assert.deepEqual(await submitCaseUrlDraft(ctx.config, ctx.ledger, start.runId, input, true, ctx.dependencies), result);
  assert.equal(child.status().operations.filter(row => row.kind === 'case-designed-fixture').length, 1);
  assert.equal(child.all('assignment').length, 0);
  assert.equal(result.artifacts.artifacts.length, 3);
  writeFileSync(join(childConfig.caseGeneration.inputRoot, fixture.path), 'changed workbook');
  await assert.rejects(submitCaseUrlDraft(ctx.config, ctx.ledger, start.runId, input, true, ctx.dependencies), /fixture bytes/i);
});

test('missing originals stay blocked; generation cannot replace them with invented synthetic bytes', async t => {
  const ctx = await setup(t), start = await ctx.start();
  ctx.capture(start.runId, 'checklist'); ctx.capture(start.runId, 'figma');
  const input = structuredClone(ctx.input), item = input.draft.cases[0];
  item.fixtureIds = ['original']; item.noFilesReason = null; item.readiness = 'blocked';
  item.blockers = ['Owner must authorize access to the original template'];
  input.fixtureRequests = [{ id: 'original', name: 'original.xlsx', kind: 'missing',
    purpose: 'Requires the actual source template', handling: 'No substitute permitted',
    reason: 'Owner must authorize access to the original template' }];
  const result = await submitCaseUrlDraft(ctx.config, ctx.ledger, start.runId, input, true, ctx.dependencies);
  assert.equal(result.fixtureCount, 1);
  assert.match(readFileSync(result.artifacts.artifacts[1].path, 'utf8'), /original.xlsx/);
});

test('declared fixture recipes cannot execute code, invent formulas, escape paths or add unused files', async t => {
  for (const recipe of [
    { id: 'data', name: '..\\escape.txt', kind: 'text', synthetic: true, content: 'value' },
    { id: 'data', name: 'data.xlsx', kind: 'xlsx', synthetic: true,
      sheets: [{ name: 'Data', rows: [[{ formula: '1+1' }]] }] },
    { id: 'data', name: 'data.csv', kind: 'csv', synthetic: true, rows: [['=HYPERLINK("outside")']] },
    { id: 'data', name: 'data.csv', kind: 'csv', synthetic: true, rows: [['\t=1+1']] },
    { id: 'data', name: 'data.txt', kind: 'text', synthetic: false, content: 'Not synthetic' }
  ]) {
    const ctx = await setup(t), start = await ctx.start();
    ctx.capture(start.runId, 'checklist'); ctx.capture(start.runId, 'figma');
    const input = structuredClone(ctx.input);
    input.draft.cases[0].fixtureIds = ['data']; input.draft.cases[0].noFilesReason = null;
    input.fixtureRequests = [{ purpose: 'Designed input', handling: 'Synthetic only', ...recipe }];
    await assert.rejects(submitCaseUrlDraft(ctx.config, ctx.ledger, start.runId, input, true, ctx.dependencies));
  }
});

test('fixture requests bind design usage and enforce duplicate, unused and byte bounds before writing', async t => {
  const ctx = await setup(t), draft = structuredClone(ctx.input.draft);
  draft.cases[0].fixtureIds = ['data'];
  const recipe = { id: 'data', name: 'data.txt', kind: 'text', synthetic: true,
    purpose: 'Designed input', handling: 'Synthetic local data only', content: 'hello' };
  await assert.rejects(materializeCaseFixtures(ctx.config, ctx.ledger, 'fixture-test', [recipe, recipe], draft), /exactly match/);
  await assert.rejects(materializeCaseFixtures(ctx.config, ctx.ledger, 'fixture-test',
    [recipe, { ...recipe, id: 'unused' }], draft), /exactly match/);
  await assert.rejects(materializeCaseFixtures({ ...ctx.config,
    caseGeneration: { ...ctx.config.caseGeneration, maxFixtureBytes: 4 } }, ctx.ledger, 'fixture-test', [recipe], draft), /byte limit/);
  assert.equal(ctx.ledger.status().operations.filter(row => row.kind === 'case-designed-fixture').length, 0);
  await materializeCaseFixtures(ctx.config, ctx.ledger, 'fixture-test', [recipe], draft);
  draft.cases[0].id = 'CASE2';
  await assert.rejects(materializeCaseFixtures(ctx.config, ctx.ledger, 'fixture-test', [recipe], draft), /recipe or bytes changed/);
});

test('blocked host authentication is recorded without fake identity; credentials and changed designated identity are rejected', async t => {
  const ctx = await setup(t), start = await ctx.start();
  reserveCaseHostSource(ctx.config, ctx.ledger, start.runId, 'checklist', true);
  const receipt = { sourceId: 'checklist', url: ctx.inputs.CHECKLIST_URL, toolName: 'workiq-fetch', toolCallId: null,
    observedAt: now(), access: 'blocked', limitations: 'Synthetic native sign-in required',
    response: { error: { message: 'Synthetic sign-in required' } } };
  assert.throws(() => captureCaseHostSource(ctx.config, ctx.ledger, start.runId,
    { ...receipt, response: { access_token: 'synthetic-not-a-token' } }, true), /transport credentials/);
  const result = captureCaseHostSource(ctx.config, ctx.ledger, start.runId, receipt, true);
  assert.equal(result.blockers[0].sourceId, 'checklist');
  assert.throws(() => caseUrlContext({ ...ctx.config, identity: { ...ctx.config.identity, objectId: 'changed' } },
    ctx.ledger, start.runId), /identity changed/);
});

test('saved-query overflow hydrates only the bounded prefix at its actual snapshot and template Area Path cannot be inferred', async t => {
  const ctx = await setup(t);
  const ids = Array.from({ length: 101 }, (_, index) => ({ id: index + 1 }));
  const calls = [];
  const connectors = caseSourceConnectors(ctx.config, ctx.inputs, { ...ctx.dependencies, fetchResponse: async url => {
    calls.push(url);
    if (url.includes('/templates/')) return Response.json({ id: ctx.admission.destination.template.id,
      workItemTypeName: 'Bug', fields: {} });
    if (url.includes('/wiql/')) return Response.json({ asOf: '2026-10-01T00:00:00Z', workItems: ids });
    return Response.json({ value: ids.slice(0, 100).map(item => ({ ...item, fields: { 'System.TeamProject': 'Demo' } })) });
  } });
  const bugs = await connectors.collect('bugs');
  assert.equal(bugs.access, 'partial');
  assert.equal(bugs.itemIds.length, 100);
  assert.equal(new URL(calls[1]).searchParams.get('asOf'), '2026-10-01T00:00:00Z');
  assert.equal(new URL(calls[1]).searchParams.get('ids').split(',').length, 100);
  await assert.rejects(connectors.collect('template'), /actual type, defaults and Area Path/);
});

test('authentication failures do not produce fake exports or repeatedly request a token', async t => {
  let tokens = 0;
  const ctx = await setup(t, { getToken: async () => { tokens++; throw new Error('Synthetic sign-in required'); } });
  const result = await ctx.start();
  assert.equal(result.blockers.length, 3);
  assert.equal(tokens, 1);
  await ctx.start(); assert.equal(tokens, 1);
  await assert.rejects(submitCaseUrlDraft(ctx.config, ctx.ledger, result.runId, ctx.input, true, ctx.dependencies), /source connectors/);
});

test('tree queries retain roots and link topology, deduplicate hydration and use the actual snapshot', async t => {
  const ctx = await setup(t), calls = [];
  const links = [{ rel: null, source: null, target: { id: 7 } },
    { rel: 'System.LinkTypes.Hierarchy-Forward', source: { id: 7 }, target: { id: 8 } }];
  const connectors = caseSourceConnectors(ctx.config, ctx.inputs, { ...ctx.dependencies, fetchResponse: async url => {
    calls.push(url);
    if (url.includes('/wiql/')) return Response.json({ queryType: 'tree', asOf: '2026-10-01T00:00:00Z', workItemRelations: links });
    return Response.json({ value: [7, 8].map(id => ({ id, fields: { 'System.TeamProject': 'Demo' } })) });
  } });
  const captured = await connectors.collect('bugs'), content = JSON.parse(captured.content);
  assert.equal(captured.access, 'complete');
  assert.deepEqual(captured.itemIds, ['ado-7', 'ado-8']);
  assert.deepEqual(content.returnedIds, [7, 7, 8]);
  assert.deepEqual(content.workItemRelations, links);
  assert.equal(new URL(calls[1]).searchParams.get('ids'), '7,8');
  assert.equal(new URL(calls[1]).searchParams.get('asOf'), content.asOf);
});

test('linked query validation rejects ambiguous shapes, invalid snapshots/references and cross-project hydration', async t => {
  const ctx = await setup(t);
  for (const change of [{ asOf: 'invalid' }, { asOf: '2026-10-01' }, { workItems: [] },
    { workItemRelations: [{ source: null, target: { id: -1 } }] },
    { workItemRelations: [{ source: null, target: null }] },
    { workItemRelations: Array.from({ length: 1001 }, () => ({ source: null, target: { id: 7 } })) }]) {
    let calls = 0;
    const connectors = caseSourceConnectors(ctx.config, ctx.inputs, { ...ctx.dependencies,
      fetchResponse: async () => { calls++; return Response.json({ queryType: 'oneHop',
        asOf: '2026-10-01T00:00:00Z', workItemRelations: [], ...change }); } });
    await assert.rejects(connectors.collect('bugs'), /bounded flat\/tree\/oneHop/);
    assert.equal(calls, 1);
  }
  const connectors = caseSourceConnectors(ctx.config, ctx.inputs, { ...ctx.dependencies, fetchResponse: async url =>
    Response.json(url.includes('/wiql/') ? { queryType: 'tree', asOf: '2026-10-01T00:00:00Z',
      workItemRelations: [{ source: null, target: { id: 7 } }] } :
      { value: [{ id: 7, fields: { 'System.TeamProject': 'Another' } }] }) });
  await assert.rejects(connectors.collect('bugs'), /omitted or substituted/);
});

test('explicit recovery replays persisted query responses before new hydration without changing failed receipts', async t => {
  const ctx = await setup(t);
  const originalFetch = ctx.dependencies.fetchResponse;
  let denyHydration = true, network = 0;
  ctx.dependencies.fetchResponse = async (...args) => {
    network++;
    if (args[0].includes('workitems?') && denyHydration) return Response.json({ value: [] });
    return originalFetch(...args);
  };
  const start = await ctx.start();
  const failed = ctx.ledger.status().operations.find(row => row.id === `${start.runId}:source:bugs`).detail;
  const initialCalls = network;
  await assert.rejects(recoverCaseSource(ctx.config, ctx.ledger, start.runId, 'bugs', {}, ctx.dependencies), /authorization/);
  denyHydration = false;
  await recoverCaseSource(ctx.config, ctx.ledger, start.runId, 'bugs',
    { authorizeCollection: true, authorizeRecovery: true }, ctx.dependencies);
  assert.equal(network, initialCalls);
  assert.equal(ctx.ledger.status().operations.find(row => row.id === `${start.runId}:source:bugs`).detail, failed);
  assert.equal(caseUrlContext(ctx.config, ctx.ledger, start.runId).blockers[0].sourceId, 'bugs');
});

test('host recovery is append-only, captures the actual new connector and cannot reread a successful source', async t => {
  const ctx = await setup(t), start = await ctx.start();
  ctx.capture(start.runId, 'figma', { access: 'blocked', response: { error: 'Prior connector unavailable' } });
  const original = ctx.ledger.status().operations.find(row => row.id === `${start.runId}:host:figma`).detail;
  const recovery = await recoverCaseSource(ctx.config, ctx.ledger, start.runId, 'figma',
    { authorizeCollection: true, authorizeRecovery: true }, ctx.dependencies);
  assert.equal(recovery.state, 'source-read-reserved');
  assert.throws(() => captureCaseHostSource(ctx.config, ctx.ledger, start.runId, { sourceId: 'figma',
    url: ctx.inputs.FIGMA_URL, toolName: 'figma-get_design_context', toolCallId: null,
    observedAt: now(), access: 'partial', limitations: 'Wrong connector account',
    response: { whoami: { email: 'another@example.invalid' }, node: 'Synthetic returned node' } }, true), /Figma connector identity/);
  assert.throws(() => captureCaseHostSource(ctx.config, ctx.ledger, start.runId, { sourceId: 'figma',
    url: ctx.inputs.FIGMA_URL, toolName: 'figma-get_design_context', toolCallId: null,
    observedAt: '2000-01-01T00:00:00Z', access: 'partial',
    limitations: 'Stale receipt from before this reservation',
    response: { whoami: { email: ctx.config.identity.designatedUser }, node: 'Old capture' } }, true), /predates/);
  await assert.rejects(recoverCaseSource(ctx.config, ctx.ledger, start.runId, 'figma',
    { authorizeCollection: true, authorizeRecovery: true }, ctx.dependencies), /reconcile/);
  captureCaseHostSource(ctx.config, ctx.ledger, start.runId, { sourceId: 'figma', url: ctx.inputs.FIGMA_URL,
    toolName: 'figma-get_design_context', toolCallId: null, observedAt: now(), access: 'partial',
    limitations: 'Exact synthetic configured node only',
    response: { whoami: { email: ctx.config.identity.designatedUser }, node: 'Synthetic returned design context' } }, true);
  assert.equal(ctx.ledger.status().operations.find(row => row.id === `${start.runId}:host:figma`).detail, original);
  await assert.rejects(recoverCaseSource(ctx.config, ctx.ledger, start.runId, 'figma',
    { authorizeCollection: true, authorizeRecovery: true }, ctx.dependencies), /Only a recorded blocked/);
});

test('one-hop overflow retains the returned graph but never hydrates beyond 100 unique IDs', async t => {
  const ctx = await setup(t), calls = [];
  const relations = Array.from({ length: 101 }, (_, index) => ({
    rel: 'System.LinkTypes.Related', source: { id: index * 2 + 1 }, target: { id: index * 2 + 2 } }));
  const connectors = caseSourceConnectors(ctx.config, ctx.inputs, { ...ctx.dependencies, fetchResponse: async url => {
    calls.push(url);
    if (url.includes('/wiql/')) return Response.json({ queryType: 'oneHop', asOf: '2026-10-01T00:00:00Z',
      workItemRelations: relations });
    const ids = new URL(url).searchParams.get('ids').split(',').map(Number);
    return Response.json({ value: ids.map(id => ({ id, fields: { 'System.TeamProject': 'Demo' } })) });
  } });
  const result = await connectors.collect('bugs'), content = JSON.parse(result.content);
  assert.equal(result.access, 'partial');
  assert.equal(result.itemIds.length, 100);
  assert.equal(content.workItemRelations.length, 101);
  assert.equal(content.returnedIds.length, 202);
  assert.equal(new URL(calls[1]).searchParams.get('ids').split(',').length, 100);
});

test('uncertain HTTP reads are retained and cannot be retried by explicit recovery', async t => {
  const ctx = await setup(t);
  const original = ctx.dependencies.fetchResponse;
  let queries = 0;
  ctx.dependencies.fetchResponse = async (...args) => {
    if (args[0].includes('/wiql/')) { queries++; throw new Error('Synthetic connection loss after reservation'); }
    return original(...args);
  };
  const start = await ctx.start();
  await recoverCaseSource(ctx.config, ctx.ledger, start.runId, 'bugs',
    { authorizeCollection: true, authorizeRecovery: true }, ctx.dependencies);
  assert.equal(queries, 1);
  assert.equal(caseUrlContext(ctx.config, ctx.ledger, start.runId).blockers[0].error.code, 'blocked-reconciliation');
});

test('native collectors reject destination drift and over-budget/redirect responses, while Figma reads only its configured node', async t => {
  const ctx = await setup(t);
  const calls = [], environment = { FIGMA_ACCESS_TOKEN: 'synthetic' };
  const whoami = { id: 'synthetic-figma-user', email: ctx.config.identity.designatedUser };
  const figma = caseSourceConnectors(ctx.config, ctx.inputs, { environment,
    fetchResponse: async (target, options) => {
      calls.push({ url: target, token: options.headers['X-Figma-Token'] });
      if (target === 'https://api.figma.com/v1/me') {
        environment.FIGMA_ACCESS_TOKEN = 'changed-after-preflight';
        return Response.json(whoami);
      }
      return Response.json({ version: 'v1',
        nodes: { '1:2': { document: { id: '1:2', name: 'Synthetic node' } } } });
    } });
  const capture = await figma.collect('figma');
  assert.equal(capture.access, 'partial');
  assert.deepEqual(calls.map(call => call.url), [
    'https://api.figma.com/v1/me',
    'https://api.figma.com/v1/files/synthetic/nodes?ids=1%3A2'
  ]);
  assert.ok(calls.every(call => call.token === 'synthetic'));
  assert.deepEqual(JSON.parse(capture.content).whoami, whoami);
  const escaped = caseSourceConnectors(ctx.config, { ...ctx.inputs,
    TEST_CASE_SAMPLE_URL: 'https://dev.azure.com/another/Demo/_workitems/edit/1' }, ctx.dependencies);
  await assert.rejects(escaped.collect('sample'), /configured project/);
  const oversized = caseSourceConnectors(ctx.config, ctx.inputs, { ...ctx.dependencies,
    fetchResponse: async () => new Response('x'.repeat(3 * 1024 * 1024 + 1)) });
  await assert.rejects(oversized.collect('template'), /byte limit/);
});

test('Figma REST rejects missing or mismatched identity before reading content', async t => {
  const ctx = await setup(t);
  for (const identity of [{}, { email: 'another-account@example.invalid' }]) {
    const calls = [];
    const connectors = caseSourceConnectors(ctx.config, ctx.inputs, {
      environment: { FIGMA_ACCESS_TOKEN: 'synthetic-only' },
      fetchResponse: async url => {
        calls.push(url);
        return Response.json(identity);
      }
    });
    await assert.rejects(connectors.collect('figma'), error => error.code === 'blocked-auth');
    assert.deepEqual(calls, ['https://api.figma.com/v1/me']);
  }
});

test('Figma REST authentication failures stop before any file-content request without fallback', async t => {
  const ctx = await setup(t);
  for (const status of [401, 403]) {
    const calls = [];
    const connectors = caseSourceConnectors(ctx.config, ctx.inputs, {
      environment: { FIGMA_ACCESS_TOKEN: 'synthetic-only' },
      fetchResponse: async url => {
        calls.push(url);
        return new Response(null, { status });
      }
    });
    await assert.rejects(connectors.collect('figma'), error => error.code === 'blocked-auth');
    assert.deepEqual(calls, ['https://api.figma.com/v1/me']);
  }
});

test('checked-in input drift cannot silently reuse the current run', async t => {
  const ctx = await setup(t), start = await ctx.start();
  writeFileSync(join(ctx.root, 'generateE2E.md'), 'Changed generation guidance');
  assert.throws(() => caseUrlContext(ctx.config, ctx.ledger, start.runId), /configuration changed/);
});

test('one invocation holds the source reservation against concurrent starts', async t => {
  const ctx = await setup(t);
  const first = ctx.start();
  await assert.rejects(ctx.start(), /lock/i);
  await first;
  assert.equal(ctx.calls.length, 4);
});

test('publication needs exact independent source/design approval; controller creates an immutable reviewed baseline and no duplicate items', async t => {
  const ctx = await setup(t), start = await ctx.start();
  ctx.capture(start.runId, 'checklist'); ctx.capture(start.runId, 'figma');
  const submitted = await submitCaseUrlDraft(ctx.config, ctx.ledger, start.runId, ctx.input, true, ctx.dependencies);
  const ado = fakeCaseAdo(ctx), deps = { ...ctx.dependencies, ...ado };
  const review = { batchSha256: submitted.batchSha256, reviewer: 'actual-independent-synthetic-reviewer', approvalRef: 'synthetic-review-record' };
  const grants = { authorizeApproval: true, authorizeSourceReview: true, authorizePublication: true };
  await assert.rejects(publishReviewedCaseRun(ctx.config, ctx.ledger, start.runId, review, {}, deps), /separate explicit grants/);
  await assert.rejects(publishReviewedCaseRun(ctx.config, ctx.ledger, start.runId,
    { ...review, reviewer: ctx.input.generator }, grants, deps), /independent/);
  await assert.rejects(publishReviewedCaseRun(ctx.config, ctx.ledger, start.runId,
    { ...review, batchSha256: '0'.repeat(64) }, grants, deps), /exact displayed batch/);
  assert.equal(ado.counts.create, 0);
  const published = await publishReviewedCaseRun(ctx.config, ctx.ledger, start.runId, review, grants, deps);
  assert.equal(published.state, 'published');
  assert.notEqual(published.batchId, submitted.batchId);
  assert.equal(published.productExecutionAuthorized, false);
  assert.equal(caseUrlContext(ctx.config, ctx.ledger, start.runId).state, 'published');
  assert.equal((await publishReviewedCaseRun(ctx.config, ctx.ledger, start.runId, review, grants, deps)).state, 'published');
  assert.equal(ado.counts.create, 1);
});

test('URL-first review rejects the generator behind nested provenance prefixes', async t => {
  const ctx = await setup(t), start = await ctx.start();
  ctx.capture(start.runId, 'checklist'); ctx.capture(start.runId, 'figma');
  ctx.input.generator = '  import:  app-host:  synthetic-author  ';
  const submitted = await submitCaseUrlDraft(ctx.config, ctx.ledger, start.runId,
    ctx.input, true, ctx.dependencies);
  const ado = fakeCaseAdo(ctx);
  await assert.rejects(publishReviewedCaseRun(ctx.config, ctx.ledger, start.runId, {
    batchSha256: submitted.batchSha256, reviewer: '  synthetic-author  ',
    approvalRef: 'synthetic-self-approval'
  }, {
    authorizeApproval: true, authorizeSourceReview: true, authorizePublication: true
  }, { ...ctx.dependencies, ...ado }), /independent/);
  assert.equal(ado.counts.create, 0);
});

test('URL-first CLI uses project defaults and rejects unauthorized or unknown options before reads', async t => {
  await assert.rejects(runCaseUrlCommand('case-start', []), /stage authorization/);
  await assert.rejects(runCaseUrlCommand('case-start', ['--authorize-collection', '--authorize-generation', '--execute']), /Unknown/);
  await assert.rejects(runCaseUrlCommand('case-publish-reviewed',
    ['--run', 'case-run-' + '0'.repeat(24), '--batch-sha256', '0'.repeat(64), '--reviewer', 'reviewer',
      '--approval-ref', 'review', '--authorize-approval', '--authorize-publication']), /stage authorization/);
  const ctx = await setup(t);
  writeFileSync(join(ctx.root, 'pilot.local.json'), json(ctx.config));
  const result = await runCaseUrlCommand('case-start', ['--authorize-collection', '--authorize-generation'], ctx.dependencies);
  assert.equal(result.state, 'awaiting-source-connectors');
  assert.equal(existsSync(join(ctx.root, 'cases.local.json')), false);
});
