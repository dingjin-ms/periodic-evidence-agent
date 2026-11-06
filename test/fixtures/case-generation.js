import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { configAt, hash, json } from '../../src/common.js';
import { Ledger } from '../../src/ledger.js';
import { admitCaseSources, approveCaseBatch, recordCaseDraft } from '../../src/case-generation.js';
import { casePublicationFields } from '../../src/case-publication.js';

export async function caseFixture(t, { files = false, missing = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'case-generation-')), revision = 'a'.repeat(40);
  const config = configAt('pilot.example.json');
  config.stateDirectory = join(root, 'state'); config.statePolicy.accessApproved = true;
  config.caseGeneration = { enabled: true, scopeApproved: true, approvalRef: 'synthetic-source-approval', inputRoot: root,
    maxInputBytes: 1048576, maxOutputBytes: 262144, maxFixtureBytes: 65536, maxCases: 15,
    publication: { enabled: true, scopeApproved: true, approvalRef: 'synthetic-write-approval', maxItems: 15, maxCalls: 200 },
    workflow2: { enabled: true, scopeApproved: true, approvalRef: 'synthetic-e2e-route', layer: 'e2e',
      repoId: '1js', capability: 'declarative-e2e-authoring' } };
  config.adoTestRequests = { organization: 'example', project: 'Demo', repoId: '1js',
    capability: 'declarative-e2e-authoring', automation: { requireSupportMatrix: true } };
  const ledger = new Ledger(config.stateDirectory);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const templateId = '12345678-1234-1234-1234-123456789abc', teamId = 'abcdefab-1234-1234-1234-123456789abc';
  const urls = { checklist: 'https://example.invalid/checklist', bugs: 'https://example.invalid/bugs',
    template: `https://dev.azure.com/example/Demo/_workitems/create/Bug?templateId=${templateId}&ownerId=${teamId}`,
    sample: 'https://dev.azure.com/example/Demo/_workitems/edit/1', figma: 'https://example.invalid/figma' };
  writeFileSync(join(root, 'generateE2E.md'), 'Design only. Never publish or execute from the generation session.');
  writeFileSync(join(root, 'generateE2E.config.json'), json({ inputs: {
    CHECKLIST_URL: urls.checklist, BUG_LIST_URL: urls.bugs, TEST_CASE_TEMPLATE_URL: urls.template,
    TEST_CASE_SAMPLE_URL: urls.sample, FIGMA_URL: urls.figma } }));
  const sources = Object.entries(urls).map(([type, url]) => {
    const text = type === 'checklist' ? 'R1: Save a synthetic document and verify persistence.' : `Synthetic approved ${type} export.`;
    writeFileSync(join(root, `${type}.txt`), text);
    return { id: type, type, url, title: `Synthetic ${type}`, revision: '1', modifiedAt: null,
      retrievedAt: '2026-10-01T00:00:00Z', approval: 'approved', applicability: 'applicable', access: 'complete',
      limitations: 'Approved synthetic export only; not a live read.', path: `${type}.txt`, sha256: hash(text),
      itemIds: type === 'checklist' ? ['R1'] : [] };
  });
  const fixtures = [];
  if (files) {
    const bytes = Buffer.from('synthetic fixture bytes\n');
    writeFileSync(join(root, 'fixture-data.txt'), bytes);
    fixtures.push({ id: 'data', path: missing ? null : 'fixture-data.txt', name: 'sample.txt', purpose: 'Synthetic input',
      provenance: 'Synthetic local fixture', version: '1', size: missing ? null : bytes.length,
      sha256: missing ? null : hash(bytes), handling: 'Read-only synthetic data; no extraction required',
      shareApprovalRef: missing ? null : 'synthetic-share-approval',
      availability: missing ? 'missing' : 'available', blocker: missing ? 'Owner needed: supply the approved synthetic fixture' : null });
  }
  const admission = { format: 'case-generation-admission-v1', baselineId: 'baseline-one', previousBatchId: null,
    scope: 'Synthetic persistence journey only; no real product or environment claims', product: 'Unknown build',
    environment: 'Synthetic controller-only environment', repoId: '1js', repositoryRevision: revision,
    promptPath: 'generateE2E.md', sources, fixtures,
    destination: { organization: 'example', project: 'Demo', workItemType: 'Bug', areaPath: 'Demo\\Automation',
      tag: 'AgenticTestRequest', template: { id: templateId, teamId, sourceId: 'template', verifiedAt: '2026-10-01T00:00:00Z',
        fields: { 'System.AreaPath': 'Demo\\Automation', 'System.State': 'New' } } } };
  const execute = async (_program, args) => ({ stdout: args.includes('HEAD') ? `${'b'.repeat(40)}\n` : `${revision}\n` });
  const bundle = await admitCaseSources(config, ledger, admission, { authorizeImport: true }, { execute });
  const sourceRefs = [{ sourceId: 'checklist', section: 'R1' }];
  const draft = { requirements: [{ id: 'R1', kind: 'requirement', behavior: 'Save persists document state', sourceRefs,
    disposition: 'selected', depth: 'full', caseIds: ['CASE1'], reason: 'Persistence crosses component boundaries',
    residualRisk: 'Other formats not assessed', owner: 'Synthetic owner', nextAction: 'Review the proposed assertion' }],
  cases: [{ id: 'CASE1', revision: 1, title: 'Save and reopen a synthetic document', objective: 'Persist a synthetic document',
    journey: 'Save and reopen', risk: 'Loss of saved state', e2eRationale: 'Checks the integrated save and reopen boundary',
    priority: 'High impact per synthetic R1; no production frequency claimed', categories: ['persistence/data integrity'],
    owner: 'Synthetic owner', readiness: missing ? 'blocked' : 'designed', blockers: missing ? ['Required fixture is missing'] : [],
    cadence: 'daily', cadenceReason: 'Proposed daily integrated regression; budget approval pending', sourceRefs,
    request: { startingContext: 'Synthetic workspace with a new document', inputFiles: files ? 'data: sample.txt' : 'No files required: create an in-memory synthetic document',
      steps: 'Save the document, close and reopen it.', expectedResult: 'The reopened document retains the synthetic value.',
      constraints: 'Do not write production data; delete the synthetic document afterward.' },
    steps: ['setup', 'action', 'assertion', 'cleanup'].map((phase, index) => ({ number: index + 1, phase,
      action: `${phase} the synthetic document`, input: files ? 'data' : 'Synthetic inline text',
      expected: `${phase} completes with the documented synthetic state`, evidence: 'Redacted controller-only assertion',
      sourceRefs, timeoutMs: null })),
    fixtureIds: files ? ['data'] : [], noFilesReason: files ? null : 'All data is created in memory by the test.',
    existingTest: null, executionPlan: { configurationCount: 1, parameterRows: 1, projectedExecutions: 1,
      environment: 'Synthetic environment', identityRole: 'Test identity not provisioned', versions: 'Unknown build',
      dependencies: 'Actual native harness not qualified here', proposedTrigger: 'Proposed daily; not deployed',
      timeZone: 'UTC', estimatedRuntimeMs: null, measuredRuntimeMs: null, timeoutMs: null, retries: 0,
      isolation: 'Unique run-scoped document', cleanup: 'Delete run-scoped document even after failure',
      diagnostics: 'Redacted logs; retention approval needed', triageOwner: 'Synthetic owner', readinessEvidence: [] } }],
  retiredCaseIds: [], decisions: ['This is synthetic design evidence, not product validation.'], conflicts: [] };
  const record = (input = draft, source = bundle.id) => recordCaseDraft(config, ledger, source, input, 'synthetic-generator');
  const approve = record => approveCaseBatch(config, ledger, { batchId: record.id,
    batchSha256: hash(json(record.batch)), reviewer: 'independent-synthetic-reviewer', approvalRef: 'synthetic-qa-approval' },
  { authorizeApproval: true });
  return { root, config, ledger, admission, bundle, draft, execute, record, approve };
}
export function fakeCaseAdo(ctx, { badBytes = false, lostCreate = false, failUpload = false } = {}) {
  const counts = { create: 0, update: 0, upload: 0, link: 0, read: 0 }, items = new Map(), blobs = new Map();
  let nextItem = 10, nextFile = 0;
  const fields = casePublicationFields(ctx.bundle, ctx.draft.cases[0]);
  const transport = {
    template: async () => ({ id: ctx.admission.destination.template.id, workItemTypeName: 'Bug',
      fields: ctx.admission.destination.template.fields }),
    schema: async () => ({ name: 'Bug', fields: Object.keys(fields).map(referenceName => ({ referenceName, alwaysRequired: true })) }),
    lookup: async caseId => [...items.values()].filter(item => item.fields['System.Title'].startsWith(`[${caseId}]`)).map(item => item.id),
    read: async id => { counts.read++; return structuredClone(items.get(id)); },
    create: async fields => {
      counts.create++; const item = { id: ++nextItem, rev: 1, fields: structuredClone(fields), relations: [] };
      items.set(item.id, item);
      if (lostCreate) { lostCreate = false; throw new Error('simulated lost create response'); }
      return structuredClone(item);
    },
    update: async (id, revision, fields) => {
      counts.update++; const item = items.get(id); if (item.rev !== revision) throw new Error('revision conflict');
      Object.assign(item.fields, fields); item.rev++; return structuredClone(item);
    },
    upload: async (file, bytes) => {
      counts.upload++; if (failUpload) throw new Error('simulated unavailable upload');
      const url = `https://dev.azure.com/example/Demo/_apis/wit/attachments/00000000-0000-0000-0000-${String(++nextFile).padStart(12, '0')}`;
      blobs.set(url, Buffer.from(bytes)); return { url };
    },
    link: async (id, revision, file, url) => {
      counts.link++; const item = items.get(id); if (item.rev !== revision) throw new Error('revision conflict');
      item.relations.push({ rel: 'AttachedFile', url, attributes: { name: file.name } }); item.rev++;
      return structuredClone(item);
    },
    download: async url => badBytes ? Buffer.from('wrong attachment bytes') : blobs.get(url)
  };
  return { transport, counts, items, blobs };
}
