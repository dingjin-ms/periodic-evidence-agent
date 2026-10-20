import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Budget, configAt, hash, json } from '../src/common.js';
import { adoResolutionField } from '../src/ado-cohort.js';
import { adoRecord, area, collectAdo, evidenceEnvelope, readRelatedAdo, wiql } from '../src/sources.js';
import { Ledger } from '../src/ledger.js';
import { beginApp, openApp } from '../src/app-native.js';
import { loadFilterCorpus, prepareTitleIndex } from '../src/filter.js';
import { importCapturedEvidence } from '../src/filter-handoff.js';
import { coverageSkillName, prepareStage2 } from '../src/stage2.js';
import { revisitTracked } from '../src/revisit.js';

const snapshot = '2026-10-09T01:00:00Z';
const accepted = ['Resolved', 'Closed'].flatMap(state =>
  ['Fixed', 'Duplicate'].map(resolution => [state, resolution]));
const rejected = [
  ...['New', 'Active', 'Removed', '', null, undefined].map(state => [state, 'Fixed']),
  ...['By Design', "Won't Fix", 'Not Repro', 'External', 'Unknown', 'fixed', '', null, undefined]
    .map(resolution => ['Resolved', resolution])
];
function item(state = 'Resolved', resolution = 'Fixed', id = 1) {
  return { id, rev: 3, fields: {
    'System.Id': id, 'System.WorkItemType': 'Bug', 'System.Title': 'Synthetic regression',
    'System.AreaPath': `${area}\\Synthetic`, 'System.State': state,
    [adoResolutionField]: resolution, 'System.Reason': 'Fixed',
    'System.CreatedDate': '2026-10-08T01:00:00Z', 'System.ChangedDate': '2026-10-08T02:00:00Z'
  } };
}
function transport(items, calls) {
  return async (endpoint, body) => {
    calls.push({ endpoint, body });
    if (endpoint === 'wiql') return { asOf: snapshot,
      workItems: body.query.includes('[System.Id] = 0') ? [] : items.map(({ id }) => ({ id })) };
    return { value: items.filter(row => body.ids.includes(row.id)) };
  };
}
function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'ado-cohort-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = configAt('pilot.example.json');
  config.stateDirectory = root; config.statePolicy.accessApproved = true;
  config.sources.ado = { enabled: true, scopeApproved: true };
  config.limits = { ...config.limits, maxItems: 20, maxCalls: 20 };
  return { root, config };
}
function source(t, state, resolution, relations = []) {
  const s = setup(t);
  beginApp(s.config, { runId: 'source', dryRun: true, provenance: 'synthetic' });
  const { ledger } = openApp(s.config, 'source');
  const record = evidenceEnvelope('ado', 'office/OC', 1, '3',
    'https://example.invalid/bugs/1', 'Synthetic saved source', snapshot);
  record.fields = item().fields;
  record.fields['System.State'] = state;
  if (resolution === undefined) delete record.fields[adoResolutionField];
  else record.fields[adoResolutionField] = resolution;
  record.sourceStatus = state || null; record.links = relations;
  const payload = { id: 1, rev: 3, fields: record.fields, relations };
  const stored = ledger.evidence(record, payload, 'source:ado:created');
  const ledgerPath = join(ledger.directory, 'ledger.sqlite');
  ledger.close();
  return { ...s, stored, payload, ledgerPath,
    input: { format: 'stage2-sources-v1', sources: [{ ledgerPath, runId: 'source' }] } };
}

test('both ADO lanes accept exactly all four state/resolution combinations and preserve query boundaries', async t => {
  const { config } = setup(t);
  for (const lane of ['created', 'changed']) {
    const calls = [], records = [];
    const items = accepted.map(([state, resolution], index) => item(state, resolution, index + 1));
    const result = await collectAdo(config, config.window, record => records.push(record),
      lane, transport(items, calls));
    assert.equal(records.length, 4); assert.equal(result.snapshot, snapshot);
    assert.equal(calls.length, 3);
    const query = calls[1].body.query;
    assert.ok(query.includes(`UNDER '${area}'`));
    assert.ok(query.includes(`[System.${lane === 'created' ? 'CreatedDate' : 'ChangedDate'}] >= '${config.window.start}'`));
    assert.ok(query.includes(`< '${config.window.end}'`));
    assert.ok(query.endsWith(`ORDER BY [System.Id] ASOF '${snapshot}'`));
    assert.match(query, /\[System.State\] IN \('Resolved', 'Closed'\)/);
    assert.match(query, /\[Microsoft.VSTS.Common.ResolvedReason\] IN \('Fixed', 'Duplicate'\)/);
    assert.doesNotMatch(query, /System.Reason/);
    assert.deepEqual(records.map(record => [record.sourceStatus, record.fields[adoResolutionField]]), accepted);
  }
  const template = JSON.parse(readFileSync('scaffold\\configuration.template.json', 'utf8'));
  assert.ok(json(template).includes(json(wiql(config.window)
    .replace(config.window.start, '<START_UTC>').replace(config.window.end, '<END_UTC_EXCLUSIVE>'))));
});

test('post-fetch cohort guard rejects nonterminal states and missing/other resolutions without System.Reason fallback', async t => {
  const { config } = setup(t);
  for (const [state, resolution] of rejected) for (const lane of ['created', 'changed']) {
    const bad = item();
    bad.fields['System.State'] = state;
    if (resolution === undefined) delete bad.fields[adoResolutionField];
    else bad.fields[adoResolutionField] = resolution;
    const calls = [];
    await assert.rejects(collectAdo(config, config.window, () => assert.fail('Ineligible evidence emitted'),
      lane, transport([bad], calls)), error => error.code === 'blocked-scope');
    assert.equal(calls.length, 3);
  }
});

test('date, snapshot, item and call limits still fail closed for eligible resolved records', async t => {
  const { config } = setup(t);
  for (const lane of ['created', 'changed']) {
    const key = lane === 'created' ? 'System.CreatedDate' : 'System.ChangedDate';
    for (const date of ['2026-10-07T23:59:59Z', config.window.end]) {
      const row = item(); row.fields[key] = date;
      await assert.rejects(collectAdo(config, config.window, () => assert.fail('Out-of-window record'),
        lane, transport([row], [])), /outside query window/);
    }
    const row = item(); row.fields[key] = config.window.start;
    let emitted = 0;
    await collectAdo(config, config.window, () => emitted++, lane, transport([row], []));
    assert.equal(emitted, 1);
  }
  await assert.rejects(collectAdo(config, config.window, () => assert.fail('Drifting snapshot'),
    'created', async (_endpoint, body) => ({ asOf: body.query.includes('[System.Id] = 0')
      ? snapshot : '2026-10-09T02:00:00Z', workItems: [] })), /snapshot changed/);
  for (const limits of [{ maxItems: 1, maxCalls: 20 }, { maxItems: 20, maxCalls: 2 }]) {
    await assert.rejects(collectAdo({ ...config, limits }, config.window,
      () => assert.fail('Exhausted budget'), 'created', transport([item(), item('Closed', 'Duplicate', 2)], [])),
    error => error.code === 'partial');
  }
});

test('duplicate canonical links survive collection and FILTER/import without any linked source reads', async t => {
  const links = [{ url: 'https://dev.azure.com/office/OC/_apis/wit/workItems/999',
    relation: 'System.LinkTypes.Duplicate-Forward', evidenceId: null, access: 'not-followed-out-of-scope' }];
  const s = source(t, 'Closed', 'Duplicate', links), before = hash(readFileSync(s.ledgerPath));
  const row = item('Closed', 'Duplicate');
  row.relations = [{ url: links[0].url, rel: links[0].relation }];
  const calls = [], collected = [];
  await collectAdo(s.config, s.config.window, record => collected.push(record), 'created', transport([row], calls));
  assert.deepEqual(collected[0].links, links);
  assert.equal(collected[0].source.recordId, '1');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls[2].body.ids, [1]);
  const corpus = loadFilterCorpus(s.config, s.input);
  assert.deepEqual(corpus.evidence[0], s.stored);
  assert.deepEqual(corpus.index.entries[0].cohort, {
    state: 'Closed', resolutionField: adoResolutionField, resolution: 'Duplicate'
  });
  const destination = new Ledger(join(s.root, 'destination'));
  try {
    const binding = { retainedIds: [s.stored.id], cohortId: 'synthetic' };
    assert.deepEqual(importCapturedEvidence(destination, binding, corpus), [s.stored]);
    assert.deepEqual(importCapturedEvidence(destination, binding, corpus), [s.stored]);
    assert.deepEqual(destination.get('evidence', s.stored.id).links, links);
  } finally { destination.close(); }
  assert.equal(hash(readFileSync(s.ledgerPath)), before);
});

test('related ADO reads use the same cohort and never fetch details outside the scope query', async t => {
  const { config } = setup(t), calls = [];
  await assert.rejects(readRelatedAdo(config, '999', new Budget(config.limits), async (endpoint, body) => {
    calls.push({ endpoint, body }); return { asOf: snapshot, workItems: [] };
  }), /details were not fetched/);
  assert.equal(calls.length, 1);
  assert.match(calls[0].body.query, /Resolved.*Closed.*ResolvedReason.*Fixed.*Duplicate/);
  assert.ok(calls[0].body.query.includes(`UNDER '${area}'`));
  for (const [state, resolution] of accepted) {
    const related = await readRelatedAdo(config, '1', new Budget(config.limits),
      transport([item(state, resolution)], []));
    assert.equal(related.record.sourceStatus, state);
  }
});

test('FILTER, unscreened Stage2 and direct import reject ineligible historical inputs without rewriting them', t => {
  for (const [state, resolution] of rejected) {
    const s = source(t, state, resolution), before = hash(readFileSync(s.ledgerPath));
    const output = join(s.root, 'must-not-exist.json');
    assert.throws(() => prepareTitleIndex(s.config, s.input, output), error => error.code === 'blocked-scope');
    assert.throws(() => loadFilterCorpus(s.config, s.input), error => error.code === 'blocked-scope');
    s.config.stage2 = { skillDirectory: join(s.root, coverageSkillName) };
    mkdirSync(join(s.config.stage2.skillDirectory, 'references'), { recursive: true });
    writeFileSync(join(s.config.stage2.skillDirectory, 'SKILL.md'),
      `---\nname: ${coverageSkillName}\n---\nRead references/coverage-map.md.`);
    writeFileSync(join(s.config.stage2.skillDirectory, 'references', 'coverage-map.md'), 'Synthetic');
    assert.throws(() => prepareStage2(s.config, s.input, output), error => error.code === 'blocked-scope');
    const destination = new Ledger(join(s.root, 'destination'));
    try {
      const binding = { retainedIds: [s.stored.id], cohortId: 'synthetic' };
      const corpus = { evidence: [s.stored], captures: [], index: { sources: [] } };
      assert.throws(() => importCapturedEvidence(destination, binding, corpus), error => error.code === 'blocked-scope');
      assert.equal(destination.status().runs.length, 0);
      destination.put(s.stored);
      assert.throws(() => importCapturedEvidence(destination, binding, corpus), error => error.code === 'blocked-scope');
    } finally { destination.close(); }
    assert.equal(existsSync(output), false);
    assert.equal(hash(readFileSync(s.ledgerPath)), before);
  }
});

test('FILTER accepts both terminal states with either approved resolution and rejects conflicting sourceStatus', t => {
  for (const [state, resolution] of accepted) {
    const s = source(t, state, resolution);
    assert.equal(loadFilterCorpus(s.config, s.input).evidence.length, 1);
    const conflicting = structuredClone(s.stored); conflicting.sourceStatus = 'Active';
    const destination = new Ledger(join(s.root, 'destination'));
    try {
      assert.throws(() => importCapturedEvidence(destination,
        { retainedIds: [conflicting.id] }, { evidence: [conflicting] }), /sourceStatus differs/);
    } finally { destination.close(); }
  }
});

test('unchanged terminal cohort revisits stay current but changed captures and prior blockers require reconciliation', async t => {
  for (const [state, resolution] of accepted) {
    const { root, config } = setup(t), ledger = new Ledger(join(root, 'tracked'));
    try {
      config.schedule.changedEvidencePolicy = 'tracked-open-and-area-changed';
      const original = adoRecord(item(state, resolution), 'Synthetic', snapshot);
      const payload = { id: 1, rev: 3, fields: original.fields, relations: original.links };
      const evidence = ledger.evidence(original, payload, 'synthetic');
      // The revisit only needs the already-recorded investigation evidence identities.
      const trackedLedger = Object.create(ledger);
      trackedLedger.latest = () => [{ state: 'triaged', evidenceIds: [evidence.id] }];
      const readers = { ado: async () => ({ record: structuredClone(original), payload }) };
      await revisitTracked(config, trackedLedger, readers);
      assert.equal(ledger.trackedState(evidence).state, 'current');
      ledger.setTrackedState(evidence, 'reconciliation-required', 'Unresolved ownership review');
      await revisitTracked(config, trackedLedger, readers);
      assert.equal(ledger.trackedState(evidence).state, 'reconciliation-required');
      ledger.setTrackedState(evidence, 'current', 'Synthetic resolved review');
      const changed = item(state, resolution); changed.rev++;
      readers.ado = async () => ({ record: adoRecord(changed, 'Synthetic update', snapshot), payload: changed });
      await revisitTracked(config, trackedLedger, readers);
      assert.equal(ledger.trackedState(evidence).state, 'reconciliation-required');
    } finally { ledger.close(); }
  }
});
