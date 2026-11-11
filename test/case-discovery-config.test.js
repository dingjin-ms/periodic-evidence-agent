import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { hash, json, uuid } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import { completedOperation, operationRow } from '../src/case-generation.js';
import { beginCaseDiscovery, loadDiscoveryRun } from '../src/case-discovery.js';
import { applyDiscoveryConfig, verifyDiscoveryHandoff } from '../src/case-discovery-config.js';
import { caseSourceInventory, discoverySurfaces } from '../src/case-source-inventory.js';

function fixture(t) {
  const root = resolve('.state', `discovery-config-test-${uuid()}`);
  mkdirSync(join(root, '.github', 'skills', 'discover-test-evidence'), { recursive: true });
  writeFileSync(join(root, '.github', 'skills', 'discover-test-evidence', 'SKILL.md'), 'Synthetic discovery instructions.');
  writeFileSync(join(root, 'AGENTS.md'), 'Synthetic source-bound instructions.');
  const original = {
    inputs: { CHECKLIST_URL: 'https://legacy.invalid/checklist', BUG_LIST_URL: 'https://legacy.invalid/bugs',
      FIGMA_URL: 'https://legacy.invalid/design', TEST_CASE_TEMPLATE_URL: 'https://example.invalid/template',
      TEST_CASE_SAMPLE_URL: 'https://example.invalid/sample', UNRECOGNIZED_INPUT: 'preserved' },
    guidance: { prompt: 'generateE2E.md', nested: ['preserve', { enabled: true }] },
    unknownRoot: { futureOption: ['unchanged', 7] }, template: 'keep', sample: { keep: true }
  };
  const originalBytes = ` \n${JSON.stringify(original, null, 3)}\n`;
  const target = join(root, 'generateE2E.config.json');
  writeFileSync(target, originalBytes);
  const base = { stateDirectory: join(root, 'case-generation'), statePolicy: { accessApproved: true },
    identity: { objectId: 'synthetic-user', designatedUser: 'synthetic@example.invalid' } };
  const ledger = new Ledger(join(base.stateDirectory, 'discovery'));
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const request = { format: 'case-discovery-request-v1', approvalRef: 'synthetic-scope-approval',
    scope: 'Synthetic document persistence', surfaces: [...discoverySurfaces],
    allowedUrlPrefixes: ['https://example.invalid/evidence'], tools: [{ name: 'synthetic-read', version: '1' }],
    model: null, limits: { maxCalls: 4, maxMinutes: 5, maxResponseBytes: 4096,
      maxTotalBytes: 16384, maxCandidates: 4, maxSelected: 4 } };
  const { runId } = beginCaseDiscovery(base, ledger, request, { authorizeDiscovery: true }, { projectRoot: root });
  const sources = [{ id: `src-${'a'.repeat(24)}`, type: 'requirements',
    url: 'https://example.invalid/evidence/requirements', surfaces: [...discoverySurfaces] }];
  const manifest = { format: 'case-discovery-manifest-v1', runId, scope: request.scope,
    cutoff: loadDiscoveryRun(base, ledger, runId).cutoff, sources,
    selection: { coverage: discoverySurfaces.map(surface => ({
      surface, status: 'searched', operationIds: [], reason: 'Synthetic scoped search fixture.'
    })), gaps: [], decisions: [{ sourceId: sources[0].id, decision: 'selected',
      reason: 'Synthetic applicable behavioral source.' }], stopReason: 'Synthetic bounded stop.' },
    candidates: [{ ...sources[0], provider: 'repository', exactLocation: 'docs\\synthetic-requirements.md',
      sourceVersion: 'a'.repeat(40), authority: 'approved', applicability: 'applicable',
      authorityBasis: 'Synthetic requirement R1 approval recorded at revision 1.',
      limitations: 'Synthetic qualification only.', response: { private: 'Must not escape.' } },
    { id: `src-${'b'.repeat(24)}`, provider: 'repository', exactLocation: 'not-selected.md' }],
    acceptance: { synthetic: true },
    assurance: 'Synthetic fixture only; no live source authority or exhaustive coverage claim.' };
  const selection = { state: 'selection-qualified', manifest, manifestSha256: hash(json(manifest)) };
  ledger.operation(`${runId}:selection`, runId, 'case-discovery-selection', {});
  ledger.finishOperation(`${runId}:selection`, 'complete', selection);
  const apply = (authorization = true, dependencies = {}) =>
    applyDiscoveryConfig(base, ledger, runId, { authorizeConfigUpdate: authorization }, dependencies);
  const replaceSelection = (change, rehash = true) => {
    change(selection);
    if (rehash) selection.manifestSha256 = hash(json(selection.manifest));
    ledger.finishOperation(`${runId}:selection`, 'complete', selection);
  };
  const read = () => readFileSync(target, 'utf8');
  const parsed = () => JSON.parse(read());
  const assertBaseline = () => {
    assert.equal(read(), originalBytes);
    assert.deepEqual(readdirSync(root).filter(name => name.endsWith('.discovery')), []);
    assert.equal(ledger.status().locks.length, 0);
    assert.equal(operationRow(ledger, `${runId}:config`), undefined);
  };
  return { root, base, ledger, target, original, originalBytes, runId, sources, selection,
    apply, replaceSelection, read, parsed, assertBaseline };
}

test('discovery configuration publication requires explicit authorization and approved storage', async t => {
  const ctx = fixture(t);
  await assert.rejects(ctx.apply(false), { code: 'blocked-authorization' });
  ctx.assertBaseline();
  assert.equal(operationRow(ctx.ledger, `${ctx.runId}:config-intent`), undefined);
  ctx.base.statePolicy.accessApproved = false;
  await assert.rejects(ctx.apply(), { code: 'blocked-authorization' });
  ctx.assertBaseline();
});

test('publication preserves all original keys and primary URL hints, adds only the sanitized selected catalog', async t => {
  const ctx = fixture(t), receipt = await ctx.apply(), configuration = ctx.parsed();
  for (const [key, value] of Object.entries(ctx.original)) assert.deepEqual(configuration[key], value);
  assert.deepEqual(configuration.sources, ctx.sources);
  assert.deepEqual(configuration.discovery, { format: 'case-discovery-config-v1',
    runId: ctx.runId, manifestSha256: ctx.selection.manifestSha256 });
  assert.equal(receipt.configurationSha256, hash(ctx.read()));
  assert.equal(receipt.oldSha256, hash(ctx.originalBytes));
  assert.equal(receipt.target, ctx.target);
  assert.equal(receipt.state, 'configuration-applied');
  assert.deepEqual(completedOperation(ctx.ledger, `${ctx.runId}:config`,
    'case-discovery-config-publication'), receipt);
  const inventory = caseSourceInventory(configuration);
  assert.deepEqual(inventory.map(source => source.type), ['template', 'sample', 'requirements']);
  assert.ok(!inventory.some(source => source.url.startsWith('https://legacy.invalid')));
  const intent = JSON.parse(operationRow(ctx.ledger, `${ctx.runId}:config-intent`).detail);
  assert.equal(Buffer.from(intent.originalBytes, 'base64').toString(), ctx.originalBytes);
  assert.equal(Buffer.from(intent.newBytes, 'base64').toString(), ctx.read());
});

test('completed publication replay neither writes configuration nor rewrites the receipt', async t => {
  const ctx = fixture(t), receipt = await ctx.apply();
  const before = statSync(ctx.target, { bigint: true }).mtimeNs;
  const row = { ...operationRow(ctx.ledger, `${ctx.runId}:config`) };
  assert.deepEqual(await ctx.apply(false, { beforeReplace: () => assert.fail('Unexpected replacement') }), receipt);
  assert.equal(statSync(ctx.target, { bigint: true }).mtimeNs, before);
  assert.deepEqual({ ...operationRow(ctx.ledger, `${ctx.runId}:config`) }, row);
});

test('external edits before publication and after publication are conflicts, never overwritten', async t => {
  const ctx = fixture(t);
  writeFileSync(ctx.target, `${ctx.originalBytes} `);
  await assert.rejects(ctx.apply(), { code: 'blocked-reconciliation' });
  assert.equal(ctx.read(), `${ctx.originalBytes} `);
  writeFileSync(ctx.target, ctx.originalBytes);
  await ctx.apply();
  const changed = `${ctx.read()} `;
  writeFileSync(ctx.target, changed);
  await assert.rejects(ctx.apply(), { code: 'blocked-reconciliation' });
  assert.equal(ctx.read(), changed);
});

test('pre-rename fault retains exact baseline and private journal; recovery needs renewed authorization', async t => {
  const ctx = fixture(t);
  const unrelated = join(ctx.root, 'generateE2E.config.json.someone-elses.discovery');
  writeFileSync(unrelated, 'Unrelated synthetic sibling.');
  let candidateBytes;
  await assert.rejects(ctx.apply(true, { beforeReplace: ({ temporary }) => {
    candidateBytes = readFileSync(temporary, 'utf8');
    throw new Error('Synthetic before-rename fault');
  } }), /Synthetic before-rename fault/);
  assert.equal(ctx.read(), ctx.originalBytes);
  assert.deepEqual(readdirSync(ctx.root).filter(name => name.endsWith('.discovery')),
    ['generateE2E.config.json.someone-elses.discovery']);
  assert.equal(readFileSync(unrelated, 'utf8'), 'Unrelated synthetic sibling.');
  rmSync(unrelated);
  ctx.assertBaseline();
  const intent = operationRow(ctx.ledger, `${ctx.runId}:config-intent`);
  assert.ok(intent);
  assert.equal(Buffer.from(JSON.parse(intent.detail).newBytes, 'base64').toString(), candidateBytes);
  await assert.rejects(ctx.apply(false), { code: 'blocked-authorization' });
  ctx.assertBaseline();
  await ctx.apply();
  assert.equal(ctx.read(), candidateBytes);
  assert.deepEqual(operationRow(ctx.ledger, `${ctx.runId}:config-intent`), intent);
});

test('post-rename fault reconciles the saved new hash without another write or authorization', async t => {
  const ctx = fixture(t);
  await assert.rejects(ctx.apply(true, { afterReplace: () => { throw new Error('Synthetic after-rename fault'); } }),
    /Synthetic after-rename fault/);
  const bytes = ctx.read(), before = statSync(ctx.target, { bigint: true }).mtimeNs;
  assert.equal(operationRow(ctx.ledger, `${ctx.runId}:config`), undefined);
  assert.equal(ctx.ledger.status().locks.length, 0);
  const receipt = await ctx.apply(false, { beforeReplace: () => assert.fail('Unexpected replacement') });
  assert.equal(receipt.configurationSha256, hash(bytes));
  assert.equal(ctx.read(), bytes);
  assert.equal(statSync(ctx.target, { bigint: true }).mtimeNs, before);
});

test('an interrupted journal rejects external conflicts and altered saved projections', async t => {
  const ctx = fixture(t);
  await assert.rejects(ctx.apply(true, { beforeReplace: () => { throw new Error('Synthetic interruption'); } }));
  const changed = `${ctx.originalBytes}\n`;
  writeFileSync(ctx.target, changed);
  await assert.rejects(ctx.apply(), { code: 'blocked-reconciliation' });
  assert.equal(ctx.read(), changed);
  writeFileSync(ctx.target, ctx.originalBytes);
  const row = operationRow(ctx.ledger, `${ctx.runId}:config-intent`);
  const intent = JSON.parse(row.detail);
  intent.newBytes = Buffer.from('{}').toString('base64');
  ctx.ledger.finishOperation(row.id, 'started', intent);
  await assert.rejects(ctx.apply(), { code: 'blocked-reconciliation' });
  ctx.assertBaseline();
});

test('replacement checks both baseline and exclusive candidate bytes after injected callbacks', async t => {
  const ctx = fixture(t);
  await assert.rejects(ctx.apply(true, { beforeReplace: ({ temporary }) => writeFileSync(temporary, '{}') }),
    { code: 'blocked-reconciliation' });
  ctx.assertBaseline();
  const changed = `${ctx.originalBytes} `;
  await assert.rejects(ctx.apply(true, { beforeReplace: () => writeFileSync(ctx.target, changed) }),
    { code: 'blocked-reconciliation' });
  assert.equal(ctx.read(), changed);
  assert.equal(ctx.ledger.status().locks.length, 0);
});

test('per-target lock prevents a second cooperating publisher during replacement', async t => {
  const ctx = fixture(t);
  await ctx.apply(true, { beforeReplace: async () => {
    await assert.rejects(ctx.apply(), { code: 'overlap' });
  } });
  assert.equal(ctx.ledger.status().locks.length, 0);
});

for (const [name, change, rehash, code] of [
  ['blocked selection', value => { value.state = 'blocked'; }, true, 'blocked-reconciliation'],
  ['empty sources', value => { value.manifest.sources = []; }, true, 'invalid-record'],
  ['schema extra content', value => { value.manifest.sources[0].content = 'Never project raw content'; }, true, 'invalid-record'],
  ['template source', value => { value.manifest.sources[0].type = 'template'; }, true, 'invalid-record'],
  ['private local path', value => { value.manifest.sources[0].url = 'file:///C:/private/data'; }, true, 'blocked-scope'],
  ['credential URL', value => { value.manifest.sources[0].url += '?token=synthetic'; }, true, 'blocked-scope'],
  ['outside scope', value => { value.manifest.sources[0].url = 'https://example.invalid/unapproved'; }, true, 'blocked-scope'],
  ['duplicate source', value => { value.manifest.sources.push(structuredClone(value.manifest.sources[0])); }, true, 'invalid-record'],
  ['hash tamper', value => { value.manifest.assurance = 'Changed'; }, false, 'blocked-reconciliation'],
  ['foreign run', value => { value.manifest.runId = `discovery-${'b'.repeat(24)}`; }, true, 'blocked-reconciliation']
]) test(`invalid discovery ${name} cannot mutate baseline`, async t => {
  const ctx = fixture(t);
  ctx.replaceSelection(change, rehash);
  await assert.rejects(ctx.apply(), { code });
  ctx.assertBaseline();
});

test('partial selected sources can be applied while preserving honest gaps in the verified handoff', async t => {
  const ctx = fixture(t);
  ctx.replaceSelection(value => {
    value.state = 'partial';
    value.manifest.selection.gaps = [{ id: 'gap-one', surfaces: ['Code'], reason: 'Synthetic inaccessible code.' }];
  });
  const receipt = await ctx.apply();
  const before = { bytes: ctx.read(), mtime: statSync(ctx.target, { bigint: true }).mtimeNs,
    database: hash(readFileSync(join(ctx.ledger.directory, 'ledger.sqlite'))),
    operations: ctx.ledger.status().operations };
  const result = verifyDiscoveryHandoff(ctx.base, ctx.parsed(), receipt.configurationSha256);
  assert.deepEqual(result, { runId: ctx.runId, manifestSha256: ctx.selection.manifestSha256,
    coverage: ctx.selection.manifest.selection.coverage, gaps: ctx.selection.manifest.selection.gaps,
    assurance: ctx.selection.manifest.assurance, qualifications: [{
      id: ctx.sources[0].id, provider: 'repository', exactLocation: 'docs\\synthetic-requirements.md',
      sourceVersion: 'a'.repeat(40), authority: 'approved', applicability: 'applicable',
      authorityBasis: 'Synthetic requirement R1 approval recorded at revision 1.',
      limitations: 'Synthetic qualification only.'
    }] });
  assert.equal(ctx.read(), before.bytes);
  assert.equal(statSync(ctx.target, { bigint: true }).mtimeNs, before.mtime);
  assert.equal(hash(readFileSync(join(ctx.ledger.directory, 'ledger.sqlite'))), before.database);
  assert.deepEqual(ctx.ledger.status().operations, before.operations);
  assert.equal(Object.hasOwn(result, 'target'), false);
  assert.equal(Object.hasOwn(result, 'configuration'), false);
});

test('legacy handoff without an approval basis preserves an explicit unknown instead of inventing provenance', async t => {
  const ctx = fixture(t);
  ctx.replaceSelection(value => {
    value.manifest.candidates[0].authority = 'unknown';
    delete value.manifest.candidates[0].authorityBasis;
  });
  const receipt = await ctx.apply();
  const result = verifyDiscoveryHandoff(ctx.base, ctx.parsed(), receipt.configurationSha256);
  const qualification = JSON.parse(json(result)).qualifications[0];
  assert.equal(qualification.authority, 'unknown');
  assert.equal(qualification.authorityBasis, null);
});

test('handoff rejects discovery without a local trusted publication, and never creates that receipt', t => {
  const ctx = fixture(t), configuration = { ...ctx.original,
    discovery: { format: 'case-discovery-config-v1', runId: ctx.runId,
      manifestSha256: ctx.selection.manifestSha256 }, sources: ctx.sources };
  assert.throws(() => verifyDiscoveryHandoff(ctx.base, configuration, hash(json(configuration))),
    { code: 'blocked-reconciliation' });
  ctx.assertBaseline();
});

test('handoff validates metadata, exact catalog, input byte hash, selection hash and original root keys', async t => {
  const ctx = fixture(t), receipt = await ctx.apply();
  for (const change of [
    value => { value.discovery.manifestSha256 = 'f'.repeat(64); },
    value => { value.sources[0].url += '/other'; },
    value => { value.unknownRoot.futureOption = []; }
  ]) {
    const configuration = ctx.parsed();
    change(configuration);
    assert.throws(() => verifyDiscoveryHandoff(ctx.base, configuration, receipt.configurationSha256),
      { code: 'blocked-reconciliation' });
  }
  const invalid = ctx.parsed();
  invalid.discovery.extra = 'not-allowed';
  assert.throws(() => verifyDiscoveryHandoff(ctx.base, invalid, receipt.configurationSha256),
    { code: 'invalid-record' });
  assert.throws(() => verifyDiscoveryHandoff(ctx.base, ctx.parsed(), hash(ctx.originalBytes)),
    { code: 'blocked-reconciliation' });
  const bytes = ctx.read();
  writeFileSync(ctx.target, `${bytes} `);
  assert.throws(() => verifyDiscoveryHandoff(ctx.base, JSON.parse(bytes), receipt.configurationSha256),
    { code: 'blocked-reconciliation' });
  writeFileSync(ctx.target, bytes);
  ctx.replaceSelection(value => { value.manifest.assurance = 'Tampered manifest'; }, false);
  assert.throws(() => verifyDiscoveryHandoff(ctx.base, ctx.parsed(), receipt.configurationSha256),
    { code: 'blocked-reconciliation' });
});

test('completed publication receipt tampering cannot authorize replay or downstream generation', async t => {
  const ctx = fixture(t), receipt = await ctx.apply();
  ctx.ledger.finishOperation(`${ctx.runId}:config`, 'complete',
    { ...receipt, oldSha256: 'f'.repeat(64) });
  await assert.rejects(ctx.apply(), { code: 'blocked-reconciliation' });
  assert.throws(() => verifyDiscoveryHandoff(ctx.base, ctx.parsed(), receipt.configurationSha256),
    { code: 'blocked-reconciliation' });
});

test('handoff and publication reject identity and instruction drift through the shared run loader', async t => {
  const ctx = fixture(t), receipt = await ctx.apply();
  ctx.base.identity.objectId = 'different-synthetic-user';
  await assert.rejects(ctx.apply(), { code: 'blocked-auth' });
  assert.throws(() => verifyDiscoveryHandoff(ctx.base, ctx.parsed(), receipt.configurationSha256), { code: 'blocked-auth' });
  ctx.base.identity.objectId = 'synthetic-user';
  writeFileSync(join(ctx.root, 'AGENTS.md'), 'Changed synthetic instruction.');
  await assert.rejects(ctx.apply(), { code: 'blocked-reconciliation' });
  assert.throws(() => verifyDiscoveryHandoff(ctx.base, ctx.parsed(), receipt.configurationSha256),
    { code: 'blocked-reconciliation' });
});
