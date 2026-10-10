import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, appendFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configAt, hash, readJson } from '../src/common.js';
import { beginApp, openApp, appendApp } from '../src/app-native.js';
import { principalPath, channelRoot } from '../src/runtime.js';
import { prepareStage2, checkStage2Proposal, coverageSkillName } from '../src/stage2.js';

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'stage2-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = configAt('pilot.example.json');
  config.stateDirectory = root; config.statePolicy.accessApproved = true;
  config.sources.workiq.scopeApproved = true;
  config.stage2 = { skillDirectory: join(root, 'skills', coverageSkillName) };
  mkdirSync(join(config.stage2.skillDirectory, 'references'), { recursive: true });
  writeFileSync(join(config.stage2.skillDirectory, 'SKILL.md'),
    `---\nname: ${coverageSkillName}\ndescription: Synthetic fixture\n---\nRead references/coverage-map.md.`);
  writeFileSync(join(config.stage2.skillDirectory, 'references', 'coverage-map.md'), 'Synthetic baseline');
  beginApp(config, { runId: 'source_one', dryRun: true, provenance: 'synthetic' });
  const { ledger } = openApp(config, 'source_one');
  const call = (id, path, data) => ({ id, tool: 'workiq-fetch', observedAt: '2026-10-09T02:00:00Z',
    request: { entityUrls: [path] }, response: { results: [{ statusCode: 200, data }] } });
  await appendApp(config, ledger, 'source_one', { eventId: 'page', pass: 'workiq:created', calls: [
    call('me', principalPath, { id: config.identity.objectId, userPrincipalName: config.identity.designatedUser }),
    call('root', `${channelRoot(config.sources.workiq.seeds[0])}?$select=id,createdDateTime,lastModifiedDateTime,webUrl&$top=50`,
      { value: [{ id: 'root', createdDateTime: '2026-10-08T01:00:00Z', lastModifiedDateTime: '2026-10-08T01:00:00Z',
        webUrl: 'https://example.invalid/root' }] })
  ] });
  const ledgerPath = join(ledger.directory, 'ledger.sqlite'); ledger.close();
  const input = { format: 'stage2-sources-v1', sources: [{ ledgerPath, runId: 'source_one' }] };
  const path = join(root, 'handoff.json'), before = hash(readFileSync(ledgerPath));
  const prepared = prepareStage2(config, input, path), handoff = readJson(path);
  const proposal = { schemaVersion: 1, proposalId: 'fixture', status: 'held-not-dispatched', dispatchAllowed: false,
    skill: handoff.skill, examinedScope: ['synthetic fixture'], replay: {
      cohort: { window: { start: config.window.start, endExclusive: config.window.end } },
      verifiedIndexRef: 'private-index.json',
      baselines: [{ repository: 'synthetic', ref: 'a'.repeat(40), approval: 'inspected-not-approved' }]
    }, candidates: [{ id: 'candidate', classification: 'extend existing test', dispatchAllowed: false,
      evidenceRefs: handoff.sources[0].evidenceRefs, behavior: { runtimeReproduced: false },
      existingCoverage: ['actual assertion'], missingAssertion: 'synthetic invariant', harnessReuse: ['existing fixture'],
      target: { repository: 'synthetic', inspectedRef: 'a'.repeat(40), approvedTarget: null },
      ownership: { owner: null }, confidence: { boundary: 'static-only' }, blockers: ['target not approved'],
      proposedValidation: ['held; no execution'] }] };
  return { root, config, input, path, prepared, handoff, proposal, ledgerPath, before };
}
test('Stage2 reads source evidence and captures read-only, pins installed skill/reference and stays held', async t => {
  const s = await setup(t);
  assert.equal(s.handoff.sources[0].evidenceRefs.length, 1);
  assert.equal(s.prepared.dispatchAllowed, false);
  assert.match(s.handoff.instructions.join(' '), /invoke installed skill/);
  assert.equal(checkStage2Proposal(s.config, s.proposal, s.handoff).candidateCount, 1);
  assert.equal(hash(readFileSync(s.ledgerPath)), s.before);
  assert.deepEqual(prepareStage2(s.config, s.input, s.path), s.prepared);
});
test('Stage2 missing skill or reference blocks without generic instruction fallback', async t => {
  const s = await setup(t);
  s.config.stage2.skillDirectory = join(s.root, 'missing');
  assert.throws(() => prepareStage2(s.config, s.input, join(s.root, 'other.json')), e => e.code === 'blocked-skill');
  assert.throws(() => checkStage2Proposal(s.config, s.proposal, s.handoff), e => e.code === 'blocked-skill');
});
test('Stage2 rejects changed reference pins, source changes and invalid evidence capture refs', async t => {
  const s = await setup(t);
  const invalid = structuredClone(s.proposal);
  invalid.candidates[0].evidenceRefs[0].sha256 = 'f'.repeat(64);
  assert.throws(() => checkStage2Proposal(s.config, invalid, s.handoff), /exact captured/);
  const changed = structuredClone(s.handoff); changed.sources[0].snapshotSha256 = '0'.repeat(64);
  assert.throws(() => checkStage2Proposal(s.config, s.proposal, changed), /Source changed/);
  appendFileSync(s.handoff.skill.referencePath, '\nchanged');
  assert.throws(() => checkStage2Proposal(s.config, s.proposal, s.handoff), e => e.code === 'blocked-skill');
});
test('Stage2 rejects dispatch, unsupported target approval, omitted baseline and missing behavioral contract', async t => {
  const s = await setup(t);
  for (const mutate of [
    p => { p.dispatchAllowed = true; },
    p => { p.candidates[0].dispatchAllowed = true; },
    p => { p.candidates[0].target.approvedTarget = 'main'; },
    p => { p.replay.baselines = []; },
    p => { delete p.candidates[0].missingAssertion; },
    p => { p.candidates[0].classification = 'confirmed defect'; },
    p => { delete p.candidates[0].behavior.runtimeReproduced; }
  ]) {
    const p = structuredClone(s.proposal); mutate(p);
    assert.throws(() => checkStage2Proposal(s.config, p, s.handoff));
  }
});
function approveDirection(candidate) {
  candidate.target.approvedTarget = { repository: candidate.target.repository, baseRef: 'main', layer: 'integration',
    inspectedBaseline: candidate.target.inspectedRef, implementationCommit: null, freshTargetReconciliationRequired: true };
  candidate.target.approvalProvenance = { decision: 'Approve contract and main-based target',
    authority: 'user decision relayed by parent', relayedBySession: 'synthetic-parent',
    receivedAt: '2026-10-10T16:51:48.241+08:00', contract: ['Preserve newer rendered turn'],
    target: 'main-based integration; exact future commit unselected',
    excludedAuthorization: ['product edits', 'test edits', 'fixes', 'CI', 'PRs', 'dispatch'] };
}
test('Stage2 accepts candidate-specific contract/target approval without permitting implementation', async t => {
  const s = await setup(t);
  const held = structuredClone(s.proposal.candidates[0]); held.id = 'still-held';
  s.proposal.candidates.push(held);
  approveDirection(s.proposal.candidates[0]);
  const r = checkStage2Proposal(s.config, s.proposal, s.handoff);
  assert.equal(r.state, 'held-not-dispatched'); assert.equal(r.dispatchAllowed, false);
  assert.equal(r.candidateGates[0].contractTargetApproval, 'approved-direction-only');
  assert.equal(r.candidateGates[1].contractTargetApproval, 'not-approved');
  assert.ok(r.candidateGates.every(g => !g.implementationAuthorized && !g.dispatchAllowed && g.implementationCommit === null));
  assert.equal(hash(readFileSync(s.ledgerPath)), s.before);
});
test('Stage2 direction approval rejects missing provenance, scope mismatch and execution escalation', async t => {
  const s = await setup(t); approveDirection(s.proposal.candidates[0]);
  for (const mutate of [
    c => { delete c.target.approvalProvenance; },
    c => { c.target.approvalProvenance.receivedAt = 'not-a-time'; },
    c => { c.target.approvalProvenance.excludedAuthorization = ['dispatch']; },
    c => { c.target.approvalProvenance.contract = []; },
    c => { c.target.approvedTarget.repository = 'different'; },
    c => { c.target.approvedTarget.inspectedBaseline = 'b'.repeat(40); },
    c => { c.target.approvedTarget.implementationCommit = 'a'.repeat(40); },
    c => { c.target.approvedTarget.freshTargetReconciliationRequired = false; },
    c => { c.dispatchAllowed = true; }
  ]) {
    const p = structuredClone(s.proposal); mutate(p.candidates[0]);
    assert.throws(() => checkStage2Proposal(s.config, p, s.handoff));
  }
});
test('Stage2 CLI validates held proposal offline without creating main source ledger', async t => {
  const s = await setup(t), cfg = join(s.root, 'config.json'), file = join(s.root, 'proposal.json');
  writeFileSync(cfg, JSON.stringify(s.config)); writeFileSync(file, JSON.stringify(s.proposal));
  const output = spawnSync(process.execPath, ['src\\cli.js', 'stage2-proposal-check', '--file', file,
    '--handoff', s.path, '--config', cfg], { encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr);
  assert.equal(JSON.parse(output.stdout).sourceLedgersMutated, false);
  assert.equal(hash(readFileSync(s.ledgerPath)), s.before);
});
