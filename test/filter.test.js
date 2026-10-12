import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configAt, hash, readJson } from '../src/common.js';
import { beginApp, openApp } from '../src/app-native.js';
import { evidenceEnvelope } from '../src/sources.js';
import { prepareTitleIndex, validateTitleScreen, materializeTitleScreen } from '../src/filter.js';
import { prepareStage2, checkStage2Proposal, coverageSkillName } from '../src/stage2.js';

function setup(t, titles = ['Add copy-only punctuation', 'Voice Access freezes', null, '   ',
  'Reliability timeout', 'Security routing loses data', 'Performance regression']) {
  const root = mkdtempSync(join(tmpdir(), 'filter-title-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = configAt('pilot.example.json');
  config.stateDirectory = root; config.statePolicy.accessApproved = true;
  beginApp(config, { runId: 'source', dryRun: true, provenance: 'synthetic' });
  const { ledger } = openApp(config, 'source');
  const records = titles.map((title, i) => {
    const record = evidenceEnvelope('ado', 'synthetic/issues', i + 1, '1',
      `https://example.invalid/issues/${i + 1}`, 'Synthetic query', '2026-10-09T01:00:00Z');
    record.source.provenance = 'synthetic'; record.title = title;
    record.fields = { description: `PRIVATE_DETAIL_${i}`, requiredProvenance: { original: true } };
    return ledger.evidence(record, { description: `PRIVATE_CAPTURE_${i}`, original: true }, 'source:ado:created');
  });
  const ledgerPath = join(ledger.directory, 'ledger.sqlite'); ledger.close();
  const input = { format: 'stage2-sources-v1', sources: [{ ledgerPath, runId: 'source' }] };
  const indexPath = join(root, 'titles.json'), decisionsPath = join(root, 'decisions.json'),
    outputPath = join(root, 'details.json');
  const prepared = prepareTitleIndex(config, input, indexPath), index = readJson(indexPath);
  const decisions = { format: 'filter-title-decisions-v1', indexSha256: prepared.sha256,
    reviewer: 'synthetic-filter-agent', reviewedAt: '2026-10-12T02:00:00Z',
    decisions: index.entries.map(e => ({ evidenceId: e.evidenceId, source: e.source,
      captureSha256: e.captureSha256, disposition: e.title?.trim() ? 'needs-details' : 'no-title',
      exclusionType: null, reason: 'Requires full evidence review', titleQuote: null })) };
  const excluded = decisions.decisions.find(d => d.evidenceId === records[0]?.id);
  if (titles[0] === 'Add copy-only punctuation') Object.assign(excluded, {
    disposition: 'screen-out', exclusionType: 'copy_text_only',
    reason: 'Title explicitly requests copy-only punctuation', titleQuote: 'copy-only punctuation'
  });
  const save = () => writeFileSync(decisionsPath, JSON.stringify(decisions));
  save();
  return { root, config, input, records, ledgerPath, indexPath, decisionsPath, outputPath, prepared, index, decisions, save };
}
test('FILTER title packet contains every stable version, policy and no full bodies', t => {
  const s = setup(t), before = hash(readFileSync(s.ledgerPath));
  assert.equal(s.index.entries.length, s.records.length);
  assert.equal(s.index.policy.exclusions.length, 14);
  assert.doesNotMatch(readFileSync(s.indexPath, 'utf8'), /PRIVATE_DETAIL|PRIVATE_CAPTURE|requiredProvenance/);
  for (const entry of s.index.entries) {
    const record = s.records.find(r => r.id === entry.evidenceId);
    assert.equal(entry.captureSha256, record.capture.sha256);
    assert.equal(entry.source.revision, record.source.revision);
    assert.equal(entry.provenance, 'synthetic');
  }
  assert.deepEqual(prepareTitleIndex(s.config, s.input, s.indexPath), s.prepared);
  assert.equal(hash(readFileSync(s.ledgerPath)), before);
});
test('validated agent decisions materialize only retained bodies and preserve excluded title audit', t => {
  const s = setup(t), before = hash(readFileSync(s.ledgerPath));
  s.decisions.decisions.find(d => d.evidenceId === s.records[1].id).disposition = 'likely-relevant'; s.save();
  const result = materializeTitleScreen(s.config, s.indexPath, s.decisionsPath, s.outputPath);
  const packet = readJson(s.outputPath);
  assert.equal(result.retainedCount, s.records.length - 1); assert.equal(result.screenedOutCount, 1);
  assert.equal(packet.dispatchAllowed, false);
  assert.doesNotMatch(readFileSync(s.outputPath, 'utf8'), /PRIVATE_DETAIL_0/);
  assert.deepEqual(packet.evidence.map(e => e.id).sort(), s.records.slice(1).map(e => e.id).sort());
  for (const record of packet.evidence) {
    assert.deepEqual(record, s.records.find(r => r.id === record.id));
    const capture = packet.captures.find(c => c.sha256 === record.capture.sha256);
    assert.equal(hash(Buffer.from(capture.contentBase64, 'base64')), record.capture.sha256);
    assert.doesNotMatch(Buffer.from(capture.contentBase64, 'base64').toString(), /PRIVATE_CAPTURE_0/);
  }
  assert.equal(packet.titleAudit.find(d => d.disposition === 'screen-out').title, s.records[0].title);
  assert.ok(packet.titleAudit.every(d => d.detailsRead === false));
  assert.equal(hash(readFileSync(s.ledgerPath)), before);
  assert.deepEqual(materializeTitleScreen(s.config, s.indexPath, s.decisionsPath, s.outputPath), result);
});
test('all IDs, versions, reasons and exclusions are validated before materializing details', t => {
  const s = setup(t), original = structuredClone(s.decisions);
  const cases = [
    d => d.decisions.pop(),
    d => d.decisions.push(d.decisions[0]),
    d => { d.decisions[0].evidenceId = 'unknown'; },
    d => { d.decisions[0].source.revision = '2'; },
    d => { d.decisions[0].source.namespace = 'wrong'; },
    d => { d.decisions[0].captureSha256 = '0'.repeat(64); },
    d => { d.indexSha256 = 'f'.repeat(64); },
    d => { d.reviewer = ' '; },
    d => { d.decisions[0].reason = ' '; },
    d => { d.decisions[0].disposition = 'confirmed-defect'; },
    d => { d.decisions.find(x => x.disposition === 'screen-out').exclusionType = null; },
    d => { d.decisions.find(x => x.disposition === 'screen-out').exclusionType = 'performance'; },
    d => { d.decisions.find(x => x.disposition === 'screen-out').titleQuote = 'not in title'; },
    d => { d.decisions.find(x => x.disposition === 'no-title').disposition = 'screen-out'; },
    d => { d.decisions.find(x => x.disposition === 'no-title').disposition = 'needs-details'; },
    d => { d.decisions.find(x => x.disposition === 'needs-details').exclusionType = 'by_design'; },
    d => { d.decisions[0].detailsRead = true; }
  ];
  for (const mutate of cases) {
    const value = structuredClone(original); mutate(value);
    writeFileSync(s.decisionsPath, JSON.stringify(value));
    assert.throws(() => materializeTitleScreen(s.config, s.indexPath, s.decisionsPath, s.outputPath),
      e => ['invalid-record', 'blocked-reconciliation'].includes(e.code));
    assert.equal(existsSync(s.outputPath), false);
  }
});
test('changed index/source and corrupt retained captures fail closed; originals are never rewritten', t => {
  const s = setup(t);
  const edited = structuredClone(s.index); edited.entries[0].title = 'tampered title';
  writeFileSync(s.indexPath, JSON.stringify(edited));
  s.decisions.indexSha256 = hash(readFileSync(s.indexPath)); s.save();
  assert.throws(() => validateTitleScreen(s.config, s.indexPath, s.decisionsPath), /index or source version changed/);
  writeFileSync(s.indexPath, `${JSON.stringify(s.index, null, 2)}\n`);
  s.decisions.indexSha256 = hash(readFileSync(s.indexPath)); s.save();
  const { ledger } = openApp(s.config, 'source');
  ledger.db.prepare('DELETE FROM captures WHERE hash=?').run(s.records[1].capture.sha256); ledger.close();
  assert.throws(() => materializeTitleScreen(s.config, s.indexPath, s.decisionsPath, s.outputPath), /missing or corrupt/);
  assert.equal(existsSync(s.outputPath), false);
  const { ledger: changed } = openApp(s.config, 'source');
  const record = structuredClone(s.records[1]); record.source.revision = '2';
  changed.evidence(record, { changed: true }, 'source:ado:created'); changed.close();
  assert.throws(() => validateTitleScreen(s.config, s.indexPath, s.decisionsPath), /index or source version changed/);
});
test('empty corpus, all retained and all excluded are explicit, with no automatic title classifier', t => {
  for (const titles of [[], [null, 'Voice Access freeze', 'Reliability security performance timeout'],
    ['Add copy-only punctuation']]) {
    const s = setup(t, titles);
    const result = materializeTitleScreen(s.config, s.indexPath, s.decisionsPath, s.outputPath);
    assert.equal(result.retainedCount, titles[0] === 'Add copy-only punctuation' ? 0 : titles.length);
  }
});
test('duplicate sources and conflicting immutable outputs are rejected', t => {
  const s = setup(t);
  assert.throws(() => prepareTitleIndex(s.config,
    { ...s.input, sources: [s.input.sources[0], s.input.sources[0]] }, join(s.root, 'duplicate.json')),
  /Duplicate filter source/);
  materializeTitleScreen(s.config, s.indexPath, s.decisionsPath, s.outputPath);
  const before = readFileSync(s.outputPath, 'utf8');
  s.decisions.decisions.find(d => d.disposition === 'needs-details').reason = 'Revised explicit rationale'; s.save();
  assert.throws(() => materializeTitleScreen(s.config, s.indexPath, s.decisionsPath, s.outputPath),
    /output exists with different content/);
  assert.equal(readFileSync(s.outputPath, 'utf8'), before);
});
test('invalid decision set fails before an unreadable retained capture is accessed', t => {
  const s = setup(t);
  const { ledger } = openApp(s.config, 'source');
  ledger.db.prepare('DELETE FROM captures WHERE hash=?').run(s.records[1].capture.sha256); ledger.close();
  s.decisions.decisions.pop(); s.save();
  assert.throws(() => materializeTitleScreen(s.config, s.indexPath, s.decisionsPath, s.outputPath),
    /Missing title decisions/);
  assert.equal(existsSync(s.outputPath), false);
});
test('screened Stage2 handoff and proposal checker reject excluded evidence and changed decisions', t => {
  const s = setup(t);
  s.config.stage2 = { skillDirectory: join(s.root, coverageSkillName) };
  mkdirSync(join(s.config.stage2.skillDirectory, 'references'), { recursive: true });
  writeFileSync(join(s.config.stage2.skillDirectory, 'SKILL.md'),
    `---\nname: ${coverageSkillName}\n---\nRead references/coverage-map.md.`);
  writeFileSync(join(s.config.stage2.skillDirectory, 'references', 'coverage-map.md'), 'Synthetic coverage');
  const input = { ...s.input, titleScreen: { indexPath: s.indexPath, decisionsPath: s.decisionsPath } };
  const path = join(s.root, 'handoff.json');
  prepareStage2(s.config, input, path);
  const handoff = readJson(path);
  assert.equal(handoff.sources[0].evidenceRefs.length, s.records.length - 1);
  assert.ok(!handoff.sources[0].evidenceRefs.some(e => e.evidenceId === s.records[0].id));
  const proposal = { schemaVersion: 1, proposalId: 'synthetic', status: 'held-not-dispatched', dispatchAllowed: false,
    skill: handoff.skill, examinedScope: ['synthetic'], candidates: [], replay: {
      cohort: { window: { start: s.config.window.start, endExclusive: s.config.window.end } },
      verifiedIndexRef: s.indexPath, baselines: [{ repository: 'synthetic', ref: 'a'.repeat(40), approval: 'inspected-not-approved' }]
    } };
  assert.equal(checkStage2Proposal(s.config, proposal, handoff).candidateCount, 0);
  proposal.candidates = [{ id: 'excluded', classification: 'unknown', dispatchAllowed: false,
    evidenceRefs: [{ evidenceId: s.records[0].id, recordId: s.records[0].source.recordId,
      revision: s.records[0].source.revision, artifactRef: s.records[0].capture.artifactRef, sha256: s.records[0].capture.sha256 }],
    behavior: { runtimeReproduced: false }, existingCoverage: ['unreviewed'], missingAssertion: 'unknown',
    harnessReuse: ['unknown'], target: { repository: 'synthetic', inspectedRef: 'a'.repeat(40), approvedTarget: null },
    ownership: { owner: null }, confidence: 0, blockers: ['unreviewed'], proposedValidation: ['none'] }];
  assert.throws(() => checkStage2Proposal(s.config, proposal, handoff), /exact captured source version/);
  s.decisions.decisions.find(d => d.disposition === 'screen-out').reason += ' revised'; s.save();
  assert.throws(() => checkStage2Proposal(s.config, proposal, handoff), /title screening changed/);
});
test('offline FILTER CLI persists title/details artifacts without opening a main writable ledger', t => {
  const s = setup(t), configPath = join(s.root, 'pilot.local.json'), inputPath = join(s.root, 'sources.json');
  s.config.stateDirectory = join(s.root, 'must-not-create');
  writeFileSync(configPath, JSON.stringify(s.config)); writeFileSync(inputPath, JSON.stringify(s.input));
  for (const args of [
    ['filter-title-index', '--file', inputPath, '--output', s.indexPath],
    ['filter-title-materialize', '--file', s.decisionsPath, '--index', s.indexPath, '--output', s.outputPath]
  ]) {
    const child = spawnSync(process.execPath, ['src/cli.js', ...args, '--config', configPath], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); assert.equal(existsSync(s.config.stateDirectory), false);
  }
});
