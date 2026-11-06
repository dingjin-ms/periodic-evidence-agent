import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { hash, json } from '../src/common.js';
import { admitCaseSources, approveCaseBatch, generateCaseBatch, loadCaseBatch, recordCaseDraft, validateCaseDraft } from '../src/case-generation.js';
import { caseAdoTransport, casePublicationFields, publishCaseBatch } from '../src/case-publication.js';
import { requireGeneratedCaseLineage } from '../src/case-lineage.js';
import { caseArtifactSheets, caseArtifactView, renderCaseArtifacts } from '../src/case-artifacts.js';
import { collectTestRequest, parseTestRequest } from '../src/ado-test-request.js';
import { caseRequestOptions, runCaseCommand } from '../src/case-cli.js';
import { runGeneratedCaseRequest } from '../src/case-workflow.js';
import { skillQualificationId } from '../src/repository-skills.js';
import { caseFixture, fakeCaseAdo } from './fixtures/case-generation.js';

test('approved export admission is pinned, bounded, replayable and never authorizes other stages', async t => {
  const ctx = await caseFixture(t);
  const replay = await admitCaseSources(ctx.config, ctx.ledger, ctx.admission, { authorizeImport: true }, { execute: ctx.execute });
  assert.equal(replay.id, ctx.bundle.id);
  await assert.rejects(admitCaseSources(ctx.config, ctx.ledger, ctx.admission), /explicit authorization/);
  const record = ctx.record();
  assert.equal(record.state, 'review-held');
  assert.equal(ctx.ledger.all('assignment').length, 0);
  await assert.rejects(publishCaseBatch(ctx.config, ctx.ledger, record.id, { authorizePublication: true }), /receipt/);
  assert.deepEqual(ctx.record(), record);
});

test('source hash mismatch, missing configured URL, escaped file and baseline drift fail closed', async t => {
  const ctx = await caseFixture(t);
  for (const change of [
    input => { input.sources[0].sha256 = '0'.repeat(64); },
    input => { input.sources[0].url = 'https://example.invalid/unapproved'; },
    input => { input.sources[0].path = '..\\outside.txt'; },
    input => { input.scope = 'Different scope under the same baseline'; }
  ]) {
    const input = structuredClone(ctx.admission); change(input);
    await assert.rejects(admitCaseSources(ctx.config, ctx.ledger, input, { authorizeImport: true }, { execute: ctx.execute }));
  }
  writeFileSync(join(ctx.root, 'generateE2E.config.json'), json({ inputs: { CHECKLIST_URL: 'https://example.invalid' } }));
  await assert.rejects(admitCaseSources(ctx.config, ctx.ledger, ctx.admission, { authorizeImport: true }, { execute: ctx.execute }), /HTTPS/);
});

test('15 selected unique cases pass; 16 require explicit risk-backed approval', async t => {
  const ctx = await caseFixture(t), draft = structuredClone(ctx.draft);
  draft.cases = Array.from({ length: 15 }, (_, index) => ({ ...structuredClone(draft.cases[0]),
    id: `CASE${index + 1}`, objective: `Distinct synthetic objective ${index + 1}` }));
  draft.requirements[0].caseIds = draft.cases.map(item => item.id);
  assert.doesNotThrow(() => validateCaseDraft(ctx.bundle, draft, null, ctx.config.caseGeneration));
  draft.cases.push({ ...structuredClone(draft.cases[0]), id: 'CASE16', objective: 'Distinct synthetic objective 16' });
  draft.requirements[0].caseIds.push('CASE16');
  assert.throws(() => validateCaseDraft(ctx.bundle, draft, null, ctx.config.caseGeneration), /ceiling/);
});

test('coverage accounting, unresolved conflicts, duplicate protection and false readiness are rejected', async t => {
  const ctx = await caseFixture(t);
  for (const change of [
    draft => { draft.requirements = []; },
    draft => { draft.requirements[0].sourceRefs[0].section = 'invented requirement'; },
    draft => { draft.requirements[0].caseIds = ['missing']; },
    draft => { draft.cases[0].readiness = 'automation-ready'; },
    draft => { draft.cases[0].steps.pop(); },
    draft => { draft.cases.push({ ...structuredClone(draft.cases[0]), id: 'CASE2' }); },
    draft => { draft.cases[0].executionPlan.parameterRows = 10; },
    draft => { draft.conflicts = [{ requirementIds: ['R1'], sourceRefs: [{ sourceId: 'checklist', section: 'R1' }],
      reason: 'Two incompatible expectations', owner: 'Owner needed', nextAction: 'Resolve before publication' }]; }
  ]) {
    const draft = structuredClone(ctx.draft); change(draft);
    assert.throws(() => ctx.record(draft));
  }
});

test('automation readiness checks step and mapped-requirement source authority', async t => {
  const ctx = await caseFixture(t);
  for (const location of ['step', 'requirement']) {
    for (const field of ['approval', 'applicability']) {
      const bundle = structuredClone(ctx.bundle), draft = structuredClone(ctx.draft);
      const source = bundle.sources.find(source => source.id === 'bugs');
      source[field] = 'unknown';
      const ref = { sourceId: 'bugs', section: 'B1' };
      if (location === 'step') {
        const assertion = draft.cases[0].steps.find(step => step.phase === 'assertion');
        assertion.sourceRefs = [...assertion.sourceRefs, ref];
      } else {
        source.itemIds = ['B1'];
        draft.requirements[0].sourceRefs = [...draft.requirements[0].sourceRefs, ref];
      }
      draft.cases[0].readiness = 'automation-ready';
      Object.assign(draft.cases[0].executionPlan, {
        readinessEvidence: ['Synthetic design assessment'], timeoutMs: 10000, estimatedRuntimeMs: 1000
      });
      assert.throws(() => validateCaseDraft(bundle, draft, null, ctx.config.caseGeneration),
        /unresolved source or execution gates/, `${location}: ${field}`);
    }
  }
});

test('publication holds unknown step and mapped-requirement sources before writes', async t => {
  const ctx = await caseFixture(t);
  for (const location of ['step', 'requirement']) {
    for (const field of ['approval', 'applicability']) {
      const admission = structuredClone(ctx.admission), draft = structuredClone(ctx.draft);
      admission.baselineId = `source-gate-${location}-${field}`;
      const source = admission.sources.find(source => source.id === 'bugs');
      source[field] = 'unknown';
      const ref = { sourceId: 'bugs', section: 'B1' };
      if (location === 'step') {
        const assertion = draft.cases[0].steps.find(step => step.phase === 'assertion');
        assertion.sourceRefs = [...assertion.sourceRefs, ref];
      } else {
        source.itemIds = ['B1'];
        draft.requirements[0].sourceRefs = [...draft.requirements[0].sourceRefs, ref];
      }
      const bundle = await admitCaseSources(ctx.config, ctx.ledger, admission,
        { authorizeImport: true }, { execute: ctx.execute });
      const record = ctx.record(draft, bundle.id), ado = fakeCaseAdo(ctx);
      ctx.approve(record);
      const result = await publishCaseBatch(ctx.config, ctx.ledger, record.id,
        { authorizePublication: true }, ado);
      assert.equal(result.state, 'partial-or-blocked', `${location}: ${field}`);
      assert.equal(ado.counts.create, 0);
      assert.match(result.results[0].error.message, /approved applicable source evidence/);
    }
  }
});

test('supporting steps and mapped requirements cannot turn templates or samples into product authority', async t => {
  const ctx = await caseFixture(t);
  for (const sourceId of ['template', 'sample']) {
    for (const location of ['step', 'requirement']) {
      const bundle = structuredClone(ctx.bundle), draft = structuredClone(ctx.draft);
      const ref = { sourceId, section: 'formatting-only' };
      if (location === 'step') {
        const assertion = draft.cases[0].steps.find(step => step.phase === 'assertion');
        assertion.sourceRefs = [...assertion.sourceRefs, ref];
      } else {
        bundle.sources.find(source => source.id === sourceId).itemIds = ['formatting-only'];
        draft.requirements[0].sourceRefs = [...draft.requirements[0].sourceRefs, ref];
      }
      assert.throws(() => validateCaseDraft(bundle, draft, null, ctx.config.caseGeneration),
        /Template and formatting sample are not product requirements/, `${sourceId}: ${location}`);
    }
  }
});

test('QA approval normalizes generator provenance prefixes consistently', async t => {
  for (const prefix of [
    'import:', 'local-sdk:', 'app-host:', 'import:app-host:',
    '  import:  app-host:  ', 'local-sdk:import:app-host:'
  ]) {
    const ctx = await caseFixture(t);
    const record = recordCaseDraft(ctx.config, ctx.ledger, ctx.bundle.id, ctx.draft,
      `${prefix}synthetic-author  `);
    assert.throws(() => approveCaseBatch(ctx.config, ctx.ledger, {
      batchId: record.id, batchSha256: hash(json(record.batch)),
      reviewer: '  synthetic-author  ', approvalRef: 'synthetic-self-approval'
    }, { authorizeApproval: true }), /independent/, prefix);
  }
});

test('QA approval is independent and prompt or config changes invalidate it', async t => {
  const ctx = await caseFixture(t), record = ctx.record();
  assert.throws(() => approveCaseBatch(ctx.config, ctx.ledger, { batchId: record.id, batchSha256: hash(json(record.batch)),
    reviewer: 'synthetic-generator', approvalRef: 'not-independent' }, { authorizeApproval: true }), /independent/);
  ctx.approve(record);
  writeFileSync(join(ctx.root, 'generateE2E.md'), 'Changed generation instructions');
  assert.throws(() => loadCaseBatch(ctx.config, ctx.ledger, record.id), /prompt or configuration changed/);
});

test('changing an admitted source export invalidates approval instead of silently reusing stale evidence', async t => {
  const ctx = await caseFixture(t), record = ctx.record(); ctx.approve(record);
  writeFileSync(join(ctx.root, 'checklist.txt'), 'R1 changed: different required behavior');
  assert.throws(() => loadCaseBatch(ctx.config, ctx.ledger, record.id), /source export changed/);
  const historical = await renderCaseArtifacts(ctx.config, ctx.ledger, record.id);
  assert.match(readFileSync(historical.artifacts[1].path, 'utf8'), /captured snapshots only/);
});

test('new baselines preserve stable IDs and exact case revisions, including changed guidance', async t => {
  const ctx = await caseFixture(t), first = ctx.record();
  writeFileSync(join(ctx.root, 'generateE2E.md'), 'Revised synthetic guidance');
  const input = { ...ctx.admission, baselineId: 'baseline-two', previousBatchId: first.id };
  const bundle = await admitCaseSources(ctx.config, ctx.ledger, input, { authorizeImport: true }, { execute: ctx.execute });
  const draft = structuredClone(ctx.draft);
  draft.cases[0].title = 'Revised title';
  assert.throws(() => ctx.record(draft, bundle.id), /revisions/);
  draft.cases[0].revision = 2;
  const second = ctx.record(draft, bundle.id);
  assert.equal(second.batch.changes[0].change, 'changed');
  assert.equal(second.batch.draft.cases[0].id, first.batch.draft.cases[0].id);
});

test('generation has only a finish tool, persists a QA hold and never automatically retries uncertainty', async t => {
  const ctx = await caseFixture(t);
  ctx.config.executionMode = 'standalone-sdk';
  ctx.config.limits.maxAiCreditsPerSession = 30;
  ctx.config.caseGeneration.model = { enabled: true, approvalRef: 'synthetic-model',
    name: 'synthetic-model', timeoutMs: 10000, acceptSoftCreditLimit: true };
  // Model policy is part of admission, so changing it requires a fresh baseline.
  const input = { ...ctx.admission, baselineId: 'model-baseline' };
  const bundle = await admitCaseSources(ctx.config, ctx.ledger, input, { authorizeImport: true }, { execute: ctx.execute });
  let sessions = 0;
  const connect = async (_config, _cwd, action) => action({ createSession: async options => {
    sessions++; assert.deepEqual(options.tools.map(tool => tool.name), ['pilot_case_generation_finish']);
    assert.equal(options.onPermissionRequest().kind, 'denied-by-rules');
    let event;
    return { sessionId: 'synthetic-session', on: fn => { event = fn; return () => {}; },
      rpc: { options: { update: async () => {} }, tools: { initializeAndValidate: async () => {} } },
      sendAndWait: async () => { event({ type: 'assistant.turn_start' });
        const result = JSON.parse(await options.tools[0].handler(ctx.draft)); assert.equal(result.state, 'review-held'); },
      disconnect: async () => {} };
  } });
  const result = await generateCaseBatch(ctx.config, ctx.ledger, bundle.id, { authorizeGeneration: true }, { connect });
  await generateCaseBatch(ctx.config, ctx.ledger, bundle.id, { authorizeGeneration: true }, { connect });
  assert.equal(result.state, 'review-held'); assert.equal(sessions, 1);
  assert.equal(ctx.ledger.all('assignment').length, 0);
  const failedBundle = await admitCaseSources(ctx.config, ctx.ledger, { ...input, baselineId: 'interrupted-model' },
    { authorizeImport: true }, { execute: ctx.execute });
  await assert.rejects(generateCaseBatch(ctx.config, ctx.ledger, failedBundle.id, { authorizeGeneration: true },
    { connect: async () => { throw new Error('interrupted synthetic model'); } }), /interrupted/);
  await assert.rejects(generateCaseBatch(ctx.config, ctx.ledger, failedBundle.id, { authorizeGeneration: true }, { connect }), /uncertain/);
  assert.equal(sessions, 1);
});

test('all five canonical fields round-trip without interpreting HTML or formulas', async t => {
  const ctx = await caseFixture(t);
  ctx.draft.cases[0].request.expectedResult = '=1+2\nLiteral <script> and & and | remain text';
  const fields = casePublicationFields(ctx.bundle, ctx.draft.cases[0]);
  assert.deepEqual(parseTestRequest(fields['System.Description']).fields, ctx.draft.cases[0].request);
  assert.deepEqual(parseTestRequest(fields['System.Description']).missing, []);
});

test('publication refuses parser placeholders rather than creating an incomplete Workflow 2 request', async t => {
  const ctx = await caseFixture(t); ctx.draft.cases[0].request.expectedResult = '[TBD]';
  const record = ctx.record(), ado = fakeCaseAdo(ctx); ctx.approve(record);
  const result = await publishCaseBatch(ctx.config, ctx.ledger, record.id, { authorizePublication: true }, ado);
  assert.equal(result.state, 'partial-or-blocked'); assert.equal(ado.counts.create, 0);
  assert.match(result.results[0].error.message, /five-field parser/);
});

test('publisher verifies synthetic adapter effects once; replay preserves the original receipt', async t => {
  const ctx = await caseFixture(t, { files: true }), record = ctx.record(), ado = fakeCaseAdo(ctx);
  ctx.approve(record);
  const first = await publishCaseBatch(ctx.config, ctx.ledger, record.id, { authorizePublication: true }, ado);
  assert.equal(first.state, 'published'); assert.equal(first.results[0].revision, 2);
  const before = ctx.ledger.status().operations.find(row => row.kind === 'case-publication').detail;
  const second = await publishCaseBatch(ctx.config, ctx.ledger, record.id, { authorizePublication: true }, ado);
  assert.equal(second.results[0].replayed, true);
  assert.deepEqual([ado.counts.create, ado.counts.upload, ado.counts.link], [1, 1, 1]);
  assert.equal(ctx.ledger.status().operations.find(row => row.kind === 'case-publication').detail, before);
});

test('lost create responses reconcile by lookup and readback, not a second POST', async t => {
  const ctx = await caseFixture(t), record = ctx.record(), ado = fakeCaseAdo(ctx, { lostCreate: true });
  ctx.approve(record);
  assert.equal((await publishCaseBatch(ctx.config, ctx.ledger, record.id, { authorizePublication: true }, ado)).state, 'partial-or-blocked');
  assert.equal((await publishCaseBatch(ctx.config, ctx.ledger, record.id, { authorizePublication: true }, ado)).state, 'published');
  assert.equal(ado.counts.create, 1);
});

test('an uncertain create with no discoverable effect is held without blind retry', async t => {
  const ctx = await caseFixture(t), record = ctx.record(), ado = fakeCaseAdo(ctx, { lostCreate: true });
  ctx.approve(record);
  await publishCaseBatch(ctx.config, ctx.ledger, record.id, { authorizePublication: true }, ado);
  ado.items.clear();
  const result = await publishCaseBatch(ctx.config, ctx.ledger, record.id, { authorizePublication: true }, ado);
  assert.match(result.results[0].error.message, /blind duplicate/);
  assert.equal(ado.counts.create, 1);
});

test('attachment byte failures retain the item and verified upload for safe resumption', async t => {
  const ctx = await caseFixture(t, { files: true }), record = ctx.record(), ado = fakeCaseAdo(ctx, { badBytes: true });
  ctx.approve(record);
  assert.equal((await publishCaseBatch(ctx.config, ctx.ledger, record.id, { authorizePublication: true }, ado)).state, 'partial-or-blocked');
  assert.equal(caseArtifactView(ctx.config, ctx.ledger, record.id).publication[0].itemId, 11);
  ado.transport.download = async url => ado.blobs.get(url);
  const resumed = await publishCaseBatch(ctx.config, ctx.ledger, record.id, { authorizePublication: true }, ado);
  assert.equal(resumed.state, 'published');
  assert.deepEqual([ado.counts.create, ado.counts.upload, ado.counts.link], [1, 1, 1]);
});

test('missing files stay explicit design blockers, not invented uploads or automation-ready cases', async t => {
  const ctx = await caseFixture(t, { files: true, missing: true }), record = ctx.record(), ado = fakeCaseAdo(ctx);
  ctx.approve(record);
  const result = await publishCaseBatch(ctx.config, ctx.ledger, record.id, { authorizePublication: true }, ado);
  assert.equal(result.state, 'partial-or-blocked'); assert.equal(ado.counts.create, 0);
  const draft = structuredClone(ctx.draft); draft.cases[0].readiness = 'automation-ready'; draft.cases[0].blockers = [];
  assert.throws(() => validateCaseDraft(ctx.bundle, draft, null, ctx.config.caseGeneration), /Missing fixtures/);
});

test('user revisions, template drift and missing attachment relations prevent publication completeness', async t => {
  const ctx = await caseFixture(t, { files: true }), record = ctx.record(), ado = fakeCaseAdo(ctx);
  ctx.approve(record);
  await publishCaseBatch(ctx.config, ctx.ledger, record.id, { authorizePublication: true }, ado);
  const item = ado.items.get(11); item.relations = [];
  let result = await publishCaseBatch(ctx.config, ctx.ledger, record.id, { authorizePublication: true }, ado);
  assert.equal(result.state, 'partial-or-blocked');
  assert.match(caseArtifactView(ctx.config, ctx.ledger, record.id).publication[0].state, /latest verification blocked/);
  item.rev++;
  result = await publishCaseBatch(ctx.config, ctx.ledger, record.id, { authorizePublication: true }, ado);
  assert.match(result.results[0].error.message, /revision changed/);
  ado.transport.template = async () => ({ id: 'wrong', workItemTypeName: 'Bug', fields: {} });
  await assert.rejects(publishCaseBatch(ctx.config, ctx.ledger, record.id, { authorizePublication: true }, ado), /template changed/);
});

test('approved iteration updates the existing mapped item with a revision test and preserves user edits', async t => {
  const ctx = await caseFixture(t), first = ctx.record(), ado = fakeCaseAdo(ctx);
  ctx.approve(first);
  await publishCaseBatch(ctx.config, ctx.ledger, first.id, { authorizePublication: true }, ado);
  const nextBundle = await admitCaseSources(ctx.config, ctx.ledger, { ...ctx.admission,
    baselineId: 'updated-cases', previousBatchId: first.id }, { authorizeImport: true }, { execute: ctx.execute });
  const draft = structuredClone(ctx.draft); draft.cases[0].revision = 2; draft.cases[0].title = 'Revised canonical title';
  const next = ctx.record(draft, nextBundle.id); ctx.approve(next);
  const updated = await publishCaseBatch(ctx.config, ctx.ledger, next.id, { authorizePublication: true }, ado);
  assert.equal(updated.state, 'published'); assert.equal(updated.results[0].operation, 'updated');
  assert.deepEqual([ado.counts.create, ado.counts.update], [1, 1]);
  const thirdBundle = await admitCaseSources(ctx.config, ctx.ledger, { ...ctx.admission,
    baselineId: 'user-edit-conflict', previousBatchId: next.id }, { authorizeImport: true }, { execute: ctx.execute });
  const thirdDraft = structuredClone(draft); thirdDraft.cases[0].revision = 3; thirdDraft.cases[0].title = 'Third proposed title';
  const third = ctx.record(thirdDraft, thirdBundle.id); ctx.approve(third);
  ado.items.get(11).fields['System.Description'] += '<p>User-authored change</p>'; ado.items.get(11).rev++;
  const held = await publishCaseBatch(ctx.config, ctx.ledger, third.id, { authorizePublication: true }, ado);
  assert.equal(held.state, 'partial-or-blocked'); assert.match(held.results[0].error.message, /User edited/);
  assert.equal(ado.counts.update, 1);
});

test('trusted lineage rejects orphan markers, missing native fixtures and lower-layer substitution', async t => {
  const ctx = await caseFixture(t, { files: true }), record = ctx.record(), ado = fakeCaseAdo(ctx);
  ctx.approve(record);
  const marked = { id: 11, rev: 1, fields: casePublicationFields(ctx.bundle, ctx.draft.cases[0]) };
  assert.throws(() => requireGeneratedCaseLineage(ctx.config, ctx.ledger, marked), /trusted local lineage/);
  await publishCaseBatch(ctx.config, ctx.ledger, record.id, { authorizePublication: true }, ado);
  const item = await ado.transport.read(11);
  assert.equal(requireGeneratedCaseLineage(ctx.config, ctx.ledger, item).caseId, 'CASE1');
  assert.throws(() => requireGeneratedCaseLineage(ctx.config, ctx.ledger, item, { execution: true }), /fixture-access adapter/);
  item.rev++;
  assert.throws(() => requireGeneratedCaseLineage(ctx.config, ctx.ledger, item), /publication revision/);
  assert.equal(requireGeneratedCaseLineage(ctx.config, ctx.ledger, { id: 999, rev: 1, fields: {} }), null);
});

test('normal request intake enforces generated lineage and refuses a mismatched E2E route', async t => {
  const ctx = await caseFixture(t), record = ctx.record(), ado = fakeCaseAdo(ctx);
  Object.assign(ctx.config.adoTestRequests, { enabled: true, scopeApproved: true, approvalRef: 'synthetic-intake',
    areaPath: 'Demo\\Automation', workItemTypes: ['Bug'], states: ['New'], tag: 'AgenticTestRequest',
    requestedOutcome: 'test-coverage', maxResponseBytes: 262144 });
  ctx.approve(record);
  await publishCaseBatch(ctx.config, ctx.ledger, record.id, { authorizePublication: true }, ado);
  const item = await ado.transport.read(11);
  item.fields['System.CreatedDate'] = '2026-10-01T00:00:00Z'; item.snapshotAt = '2026-10-01T00:00:00Z';
  const receipt = await collectTestRequest(ctx.config, ctx.ledger, 11, { read: async () => item });
  assert.equal(receipt.state, 'needs-review');
  assert.equal(requireGeneratedCaseLineage(ctx.config, ctx.ledger, item, { execution: true }).caseId, 'CASE1');
  ctx.config.adoTestRequests.capability = 'integration-test-authoring';
  assert.throws(() => requireGeneratedCaseLineage(ctx.config, ctx.ledger, item, { execution: true }), /E2E route/);
  ctx.config.adoTestRequests.capability = 'declarative-e2e-authoring';
  const orphan = structuredClone(item); orphan.id = 12;
  await assert.rejects(collectTestRequest(ctx.config, ctx.ledger, 12, { read: async () => orphan }), /trusted local lineage/);
});

test('generated-request adapter reuses actual Workflow 2 review and retains a native environment hold', async t => {
  const ctx = await caseFixture(t), record = ctx.record(), ado = fakeCaseAdo(ctx);
  Object.assign(ctx.config.adoTestRequests, { enabled: true, scopeApproved: true, approvalRef: 'synthetic-intake',
    areaPath: 'Demo\\Automation', workItemTypes: ['Bug'], states: ['New'], tag: 'AgenticTestRequest',
    requestedOutcome: 'test-coverage', maxResponseBytes: 262144,
    automation: { enabled: true, scopeApproved: true, approvalRef: 'synthetic-flow', maxRequests: 2,
      model: 'synthetic-model', sourcePaths: ['src'], requireSupportMatrix: true } });
  ctx.config.executionMode = 'standalone-sdk'; ctx.config.filterExecutor = 'local-sdk';
  ctx.config.activation.review = true;
  ctx.config.limits.maxAiCreditsPerSession = 30;
  ctx.config.localFilter = { enabled: true, maxRequests: 2, maxToolCalls: 12, timeoutMs: 10000,
    maxSourceBytes: 12000, maxRequestBytes: 200000, acceptSoftCreditLimit: true,
    sources: [{ repoId: '1js', revision: ctx.admission.repositoryRevision }] };
  const repo = ctx.config.repositories.find(repo => repo.id === '1js');
  repo.routingApproved = true; repo.owner = 'Synthetic owner'; repo.referenceCheckout = ctx.root;
  const binding = repo.skillBindings.find(binding => binding.capability === 'declarative-e2e-authoring');
  binding.enabled = true; binding.qualification = 'qualified'; binding.skillPath = 'src/verifier.js';
  repo.allowedWritePrefixes = binding.allowedWritePrefixes; repo.allowedWriteFiles = binding.allowedWriteFiles ?? [];
  const skillSource = 'export const syntheticVerifier = true;\n';
  ctx.ledger.qualify(skillQualificationId(repo.id, binding.id), {
    baseRevision: ctx.admission.repositoryRevision,
    skillPath: binding.skillPath,
    skillSha256: hash(skillSource)
  });
  ctx.approve(record);
  await publishCaseBatch(ctx.config, ctx.ledger, record.id, { authorizePublication: true }, ado);
  ado.items.get(11).fields['System.CreatedDate'] = '2026-10-01T00:00:00Z';
  let sessions = 0;
  const dependencies = { read: async () => ({ ...await ado.transport.read(11), snapshotAt: '2026-10-01T00:00:00Z' }),
    execute: async () => ({ stdout: skillSource }),
    connect: async (_config, _cwd, action) => action({ createSession: async options => {
      sessions++;
      let event;
      return { sessionId: 'synthetic-workflow2-review', on: fn => { event = fn; return () => {}; },
        rpc: { options: { update: async () => {} }, tools: { initializeAndValidate: async () => {} } },
        sendAndWait: async payload => {
          assert.equal(JSON.parse(payload.prompt).generatedCase.requiredTestLayer, 'e2e');
          event({ type: 'assistant.turn_start' });
          await options.tools.find(tool => tool.name === 'pilot_request_source').handler({ action: 'read', path: 'src/verifier.js' });
          const result = JSON.parse(await options.tools.find(tool => tool.name === 'pilot_request_finish').handler({
            decision: 'blocked-environment', missingCapabilities: [], sourcePaths: ['src/verifier.js'],
            rationale: 'Synthetic environment is not provisioned; do not lower the business assertion.',
            verificationEvidence: [], handoff: null, support: { skill: 'supported', environment: 'blocked', testLayer: 'e2e',
              requirements: [{ requirement: 'Persistence', status: 'supported', sourcePaths: ['src/verifier.js'],
                reason: 'Synthetic verifier source read; environment remains blocked.' }] } }));
          assert.equal(result.error, undefined);
        }, disconnect: async () => {} };
    } }) };
  await assert.rejects(runGeneratedCaseRequest(ctx.config, ctx.ledger, record.id, 'CASE1', {}, dependencies), /explicit grants/);
  const outcome = await runGeneratedCaseRequest(ctx.config, ctx.ledger, record.id, 'CASE1', { authorizeReview: true }, dependencies);
  assert.equal(outcome.state, 'blocked-environment');
  await runGeneratedCaseRequest(ctx.config, ctx.ledger, record.id, 'CASE1', { authorizeReview: true }, dependencies);
  assert.equal(sessions, 1); assert.equal(ctx.ledger.all('assignment').length, 0);
  assert.equal(caseArtifactView(ctx.config, ctx.ledger, record.id).delivery[0].state, 'blocked-environment');
});

test('later render reflects verified ADO state without rewriting the approved case batch', async t => {
  const ctx = await caseFixture(t, { files: true }), record = ctx.record(), ado = fakeCaseAdo(ctx);
  const before = await renderCaseArtifacts(ctx.config, ctx.ledger, record.id);
  ctx.approve(record);
  await publishCaseBatch(ctx.config, ctx.ledger, record.id, { authorizePublication: true }, ado);
  const after = await renderCaseArtifacts(ctx.config, ctx.ledger, record.id);
  assert.notEqual(after.artifacts[0].path, before.artifacts[0].path);
  const workbook = new ExcelJS.Workbook(); await workbook.xlsx.load(readFileSync(after.artifacts[0].path));
  assert.equal(workbook.getWorksheet('Cases').getCell('Q2').value, 11);
  assert.equal(loadCaseBatch(ctx.config, ctx.ledger, record.id).batch.draft.cases[0].revision, 1);
  assert.match(readFileSync(after.artifacts[1].path, 'utf8'), /published/);
  assert.equal(ctx.ledger.all('assignment').length, 0);
});

test('renderer creates eight real readable XLSX sheets and a consistent report, safely before publication', async t => {
  const ctx = await caseFixture(t), draft = structuredClone(ctx.draft);
  draft.cases[0].title = '=HYPERLINK("https://example.invalid","literal formula text")';
  draft.cases[0].steps[0].action = Array.from({ length: 12 }, (_, index) =>
    `Checkpoint ${index + 1}: record the visible workbook state.`).join('\n');
  draft.cases[0].steps[1].action = 'Observe the workbook update without repairing the output. '.repeat(60);
  const record = ctx.record(draft);
  const receipt = await renderCaseArtifacts(ctx.config, ctx.ledger, record.id);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(readFileSync(receipt.artifacts[0].path));
  assert.deepEqual(workbook.worksheets.map(sheet => sheet.name), [
    'Read Me', 'Cases', 'Steps', 'Test Files', 'Execution Plan', 'Coverage', 'Sources', 'Decisions and Changes'
  ]);
  assert.equal(workbook.getWorksheet('Cases').getCell('C2').type, ExcelJS.ValueType.String);
  assert.equal(workbook.getWorksheet('Cases').getCell('C2').value, draft.cases[0].title);
  assert.equal(workbook.getWorksheet('Steps').rowCount, 5);
  assert.ok(workbook.getWorksheet('Steps').getRow(2).height > 75);
  assert.ok(workbook.getWorksheet('Steps').getRow(3).height > 75);
  assert.ok(workbook.getWorksheet('Steps').getRow(3).height <= 409.5);
  assert.equal(workbook.getWorksheet('Steps').getCell('E3').value, draft.cases[0].steps[1].action);
  assert.equal(workbook.getWorksheet('Sources').getCell('D2').value.hyperlink, ctx.admission.sources[0].url);
  for (const sheet of workbook.worksheets) {
    assert.equal(sheet.views[0].state, 'frozen'); assert.ok(sheet.autoFilter);
  }
  const report = readFileSync(receipt.artifacts[1].path, 'utf8');
  assert.match(report, /Unpublished draft/); assert.match(report, /CASE1/);
  assert.match(report, /not execution/); assert.match(report, /Not deployed/);
  assert.deepEqual(await renderCaseArtifacts(ctx.config, ctx.ledger, record.id), receipt);
  assert.equal(ctx.ledger.all('assignment').length, 0);
  const tables = caseArtifactSheets(caseArtifactView(ctx.config, ctx.ledger, record.id));
  assert.equal(tables.Coverage[0]['Requirement ID'], 'R1');
});

test('real REST transport pins URLs, content types, redirects, bytes and post-auth admission', async t => {
  const ctx = await caseFixture(t);
  const calls = [];
  let checks = 0;
  const transport = await caseAdoTransport(ctx.config, ctx.admission.destination, ctx.config.caseGeneration.publication, {
    getToken: async () => 'synthetic-not-a-token', beforeRequest: () => { checks++; },
    fetchResponse: async (url, options) => {
      calls.push({ url, options }); return Response.json({ id: 1, rev: 1 });
    }
  });
  await transport.create({ 'System.Title': 'Synthetic' });
  await transport.update(1, 1, { 'System.Title': 'Synthetic revised' });
  assert.equal(checks, 2);
  assert.match(calls[0].url, /workitems\/\$Bug/);
  assert.equal(calls[0].options.headers['Content-Type'], 'application/json-patch+json');
  assert.equal(calls[1].options.redirect, 'error');
  assert.deepEqual(JSON.parse(calls[1].options.body)[0], { op: 'test', path: '/rev', value: 1 });
  const organizationAttachment = 'https://dev.azure.com/example/_apis/wit/attachments/00000000-0000-0000-0000-000000000001?fileName=sample.txt';
  await transport.download(organizationAttachment);
  assert.match(calls[2].url, /\/example\/_apis\/wit\/attachments\//);
  assert.match(calls[2].url, /api-version=7.1/);
  assert.throws(() => transport.download('https://outside.invalid/attachment'), /approved organization/);
});

test('case CLI accepts optional execution phases and preserves ordinary request options', async t => {
  const ctx = await caseFixture(t);
  const switches = {
    '--authorize-review': true, '--execute': true, '--authorize-commit': true,
    '--authorize-push': true, '--authorize-draft-pr': true
  };
  const ordinary = {
    authorizeReview: true, execute: true, authorizeCommit: true, authorizePush: true,
    authorizeDraftPR: true, authorizeComment: false
  };
  assert.deepEqual(caseRequestOptions(switches), ordinary);
  for (const phase of ['prepare', 'author', 'commit', 'validate-native-gate', 'publish']) {
    assert.deepEqual(caseRequestOptions({ ...switches, '--phase': phase }), { ...ordinary, phase });
  }
  assert.deepEqual(caseRequestOptions({ '--authorize-review': true }), {
    authorizeReview: true, execute: false, authorizeCommit: false, authorizePush: false,
    authorizeDraftPR: false, authorizeComment: false
  });
  const args = ['--config', join(ctx.root, 'missing.local.json'), '--batch', 'x', '--case', 'CASE1',
    '--authorize-review'];
  await assert.rejects(runCaseCommand('case-run-request', [...args, '--phase', 'prepare']),
    /phase requires --execute/);
  await assert.rejects(runCaseCommand('case-run-request',
    [...args, '--execute', '--phase', 'prepare']), /independent grants/);
  const execution = [...args, '--execute', '--authorize-commit', '--authorize-push', '--authorize-draft-pr'];
  for (const phase of ['invalid', 'validate-', 'validate-bad/path']) {
    await assert.rejects(runCaseCommand('case-run-request', [...execution, '--phase', phase]),
      /Unknown request phase/);
  }
  await assert.rejects(runCaseCommand('case-run-request', [...execution, '--phase', 'prepare']),
    error => error.code === 'ENOENT');
  await assert.rejects(runCaseCommand('case-run-request', execution),
    error => error.code === 'ENOENT');
});

test('case CLI rejects unknown switches and stage authorization omissions before state access', async () => {
  await assert.rejects(runCaseCommand('case-sources', ['--config', 'missing.local.json', '--file', 'missing.json']), /stage authorization/);
  await assert.rejects(runCaseCommand('case-render', ['--config', 'missing.local.json', '--batch', 'case-batch-x', '--execute']), /Unknown/);
  await assert.rejects(runCaseCommand('case-run-request', ['--config', 'missing.local.json', '--batch', 'x', '--case', 'x',
    '--authorize-review', '--execute']), /independent grants/);
});
