import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync, mkdirSync, rmSync, readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configAt, hash, json } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import { alOwners, alReference, alTestPrefixes, alNativeConfig, inspectAlNativeProof } from '../src/al-adapter.js';
import { prepareFilterBatches } from '../src/filter-batches.js';
import { loadFilterCorpus } from '../src/filter.js';
import { executeLocalFilterBatch } from '../src/local-filter.js';
import { alAuthoringSkillPath, reconcileAlFilter, runAlWorkflow } from '../src/al-workflow.js';
import { classifyAlOwner, requireAlCandidateOwner, routeAlCandidate, readAlGitBlobs } from '../src/al-capabilities.js';
import { runAlRecurring, requireRecurringAuthority, reserveAlCycleModels, requireUnstartedAlFilter } from '../src/al-recurring.js';
import { area } from '../src/sources.js';

const remote = 'https://dev.azure.com/office/ISS/_git/augloop-workflows';
const revision = 'a'.repeat(40);
function setup(t, { maxCycles = 2, nativeReceiptFixture = false, localSkillCheckout = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'al-recurring-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const put = (name, value) => {
    const path = join(root, name);
    writeFileSync(path, JSON.stringify(value));
    return alReference(path);
  };
  const config = configAt('pilot.example.json');
  config.stateDirectory = join(root, 'unused-template-state');
  config.statePolicy.accessApproved = true;
  config.sources.ado = { enabled: true, scopeApproved: true };
  config.sources.workiq.enabled = config.sources.icm.enabled = false;
  config.repositories = [{ id: 'augloop-workflows', remote, baseRef: revision,
    referenceCheckout: root, allowedWritePrefixes: alTestPrefixes, skillBindings: [], validationGates: [] }];
  if (localSkillCheckout) {
    const checkout = join(root, 'synthetic-source');
    mkdirSync(dirname(join(checkout, alAuthoringSkillPath)), { recursive: true });
    writeFileSync(join(checkout, alAuthoringSkillPath), '# Synthetic repository-native authoring skill\n');
    const git = args => execFileSync('git', ['-c', 'core.hooksPath=.git/no-hooks', ...args],
      { cwd: checkout, encoding: 'utf8', stdio: 'pipe' }).trim();
    git(['init', '--quiet']);
    git(['config', 'core.autocrlf', 'false']);
    git(['add', '.']);
    git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
      '-c', 'commit.gpgsign=false', 'commit', '--quiet', '-m', 'Synthetic offline skill']);
    git(['remote', 'add', 'origin', remote]);
    Object.assign(config.repositories[0], { referenceCheckout: checkout, baseRef: git(['rev-parse', 'HEAD']),
      projectId: 'synthetic-project', owner: 'synthetic-owner',
      commitIdentity: { name: 'Synthetic', email: 'synthetic@example.invalid' } });
  }
  const qualification = nativeReceiptFixture ? configureFinalizationFixture(config, put, root) : null;
  const template = put('template.json', config);
  const nativeTemplate = structuredClone(config);
  for (const binding of nativeTemplate.repositories[0].skillBindings) binding.skillPath = alAuthoringSkillPath;
  const proposerTemplate = put('proposer-template.json', nativeTemplate);
  const first = { start: '2026-10-07T00:00:00.000Z', end: '2026-10-08T00:00:00.000Z' };
  const second = { start: first.end, end: '2026-10-09T00:00:00.000Z' };
  const plan = { format: 'al-recurring-plan-v1', enabled: true, repoId: 'augloop-workflows',
    stateDirectory: join(root, 'durable'), firstWindowStart: first.start,
    collectorConfig: template, templateConfig: proposerTemplate, filterConfig: template,
    ...(qualification ? { qualification } : {}),
    passes: ['ado:created', 'ado:changed'],
    limits: { maxItems: 3, maxCalls: 8, maxFilterSessions: nativeReceiptFixture ? 1 : 0, maxProposers: nativeReceiptFixture ? 1 : 0,
      maxAiCreditsPerSession: 30, maxWindowHours: 24 } };
  const planRef = put('plan.json', plan);
  const authorization = { format: 'al-recurring-authorization-v1', planSha256: planRef.sha256,
    approvedBy: 'synthetic-unit-test', approvedAt: new Date(Date.now() - 1000).toISOString(),
    expiresAt: new Date(Date.now() + 120000).toISOString(),
    maxCycles, maxTotalModelSessions: nativeReceiptFixture ? 2 : 0,
    maxTotalAiCredits: nativeReceiptFixture ? 60 : 0, maxTotalDrafts: nativeReceiptFixture ? 1 : 0,
    allowCollection: true, allowModels: nativeReceiptFixture, allowPublication: nativeReceiptFixture,
    stopAfterFirstSuitableDraftPR: true };
  const authorityRef = put('authorization.json', authorization);
  const input = { plan: planRef, authorization: authorityRef, action: 'begin', window: first };
  const calls = [];
  const dependencies = { collectionDependencies: { adoTransport: async () => async (endpoint, body) => {
    calls.push({ endpoint, body });
    return { asOf: '2026-10-09T00:00:00Z', workItems: [] };
  } } };
  return { root, put, plan, planRef, authorization, input, first, second, calls, dependencies };
}
function syntheticNativeProof(put, mode, head, profileSha256) {
  const owners = alOwners.map(owner => {
    const raw = put(`${mode}-${owner.runner}-${owner.path.replaceAll('/', '-')}.json`, { syntheticUnitFixture: true });
    return { mode, owner: owner.path, package: owner.package, runner: owner.runner,
      sourceRevision: head, suiteCount: 1, testCount: 1,
      selectedTests: [`${owner.path}/${owner.tests}/synthetic.integration.test.ts`],
      resultPath: raw.path, resultSha256: raw.sha256 };
  });
  const artifact = put(`${mode}-native-artifact.json`, { syntheticUnitFixture: true, status: 'passed',
    revision: head, profileSha256,
    output: { stdout: owners.map(value => `PILOT_VALIDATION_TEST_RESULT:${json(value)}`).join('\n') } });
  return [{ status: 'passed', sourceRevision: head, artifactRefs: [artifact.path] }];
}
test('recurring AL rejects non-SDK templates before creating a ledger or reserving a model', async t => {
  const s = setup(t);
  const template = JSON.parse(readFileSync(s.plan.templateConfig.path, 'utf8'));
  template.authoringProviders = {
    local: { type: 'agency-local', executable: process.execPath, profile: 'synthetic' }
  };
  template.limits.maxAiCreditsPerSession = 30;
  template.repositories[0].skillBindings = [{
    id: 'synthetic', capability: 'integration-test-authoring', skillPath: 'SKILL.md',
    authoringProvider: 'local', enabled: false, qualification: 'unqualified',
    requestedOutcomes: ['add-or-update-tests'], allowedWritePrefixes: ['test'],
    requiresBehaviorCard: false, sideEffects: { commit: false, push: false, createDraftPR: false }
  }];
  s.plan.templateConfig = s.put('non-sdk-template.json', template);
  const plan = s.put('non-sdk-plan.json', s.plan);
  await assert.rejects(runAlRecurring({ ...s.input, plan }, s.dependencies), /only copilot-sdk/);
  assert.equal(existsSync(s.plan.stateDirectory), false);
  assert.equal(s.calls.length, 0);
});
test('recurring AL rejects FILTER guidance as the native Proposer skill before opening state', async t => {
  const s = setup(t, { nativeReceiptFixture: true });
  const template = JSON.parse(readFileSync(s.plan.templateConfig.path, 'utf8'));
  template.repositories[0].skillBindings[0].skillPath = '.github/skills/tests/SKILL.md';
  s.plan.templateConfig = s.put('wrong-native-skill.json', template);
  const plan = s.put('wrong-native-skill-plan.json', s.plan);
  await assert.rejects(runAlRecurring({ ...s.input, plan }, s.dependencies),
    /merged repository-native integration skill path/);
  assert.equal(existsSync(s.plan.stateDirectory), false);
  assert.equal(s.calls.length, 0);
});
function configureFinalizationFixture(config, put, root) {
  const revision = config.repositories[0].baseRef;
  const verification = put('synthetic-tokenizer-verification.json', { syntheticUnitFixture: true });
  config.filterBatching = { approved: true, mode: 'verified', model: 'gpt-6-luna', profile: 'synthetic',
    tokenizer: 'synthetic-v1', verifiedBy: 'synthetic-test', verifiedAt: '2026-10-12T00:00:00Z',
    verificationRef: verification.path, verificationSha256: verification.sha256,
    contextTokens: 1000, maxInputTokens: 250, maxPayloadBytes: 1000000, maxBatches: 1,
    reserves: { instructions: 10, sourceAnalysis: 20, output: 100, safety: 10, requestOverhead: 5 } };
  config.filterExecutor = 'local-sdk';
  config.activation.review = true;
  config.limits.maxAiCreditsPerSession = 30;
  config.localFilter = { enabled: true, acceptSoftCreditLimit: true, maxRequests: 2, maxToolCalls: 5,
    timeoutMs: 10000, maxSourceBytes: 10000, maxRequestBytes: 1000000,
    sources: [{ repoId: 'augloop-workflows', revision }] };
  config.repositories[0].skillBindings = [{ id: 'synthetic-main-guidance', capability: 'integration-test-authoring',
    skillPath: '.github/skills/tests/SKILL.md', enabled: false, qualification: 'unqualified',
    requestedOutcomes: ['draft-pr-validated'], allowedWritePrefixes: alTestPrefixes, allowedWriteFiles: [],
    requiresBehaviorCard: false, sideEffects: { commit: false, push: false, createDraftPR: false } }];
  config.repositories[0].validationGates = [{ executable: process.execPath }];
  const native = alNativeConfig(config, join(root, 'synthetic-native-baseline'), 'qualification');
  const profileSha256 = native.repositories[0].validationGates[0].profileSha256;
  const validation = syntheticNativeProof(put, 'qualification', revision, profileSha256);
  return put('synthetic-qualification.json', { syntheticUnitFixture: true,
    state: 'qualified-native-backend', baseRevision: revision, revision, profile: { sha256: profileSha256 },
    config: put('synthetic-native-config.json', native), cacheDirectory: native.runtime.validationCacheDirectory,
    validation, ...inspectAlNativeProof(validation, revision, 'qualification', profileSha256) });
}
async function completedPublicationFixture(f, collected, { filterOnly = false } = {}) {
  const cycle = structuredClone(collected), config = configAt(cycle.filterConfig.path);
  const revision = config.repositories[0].baseRef;
  const ledger = new Ledger(f.plan.stateDirectory);
  const stage = (name, input, result) => {
    const directory = join(cycle.root, name);
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'request.json'), json(input));
    writeFileSync(join(directory, 'result.json'), json(result));
    ledger.operation(`${cycle.id}:${name}`, cycle.id, 'al-cycle-stage', { input, stage: name });
    ledger.finishOperation(`${cycle.id}:${name}`, 'completed', { input });
    cycle.stages[name] = { runDirectory: directory, result: alReference(join(directory, 'result.json')) };
  };
  try {
    const corpus = loadFilterCorpus(config, { format: 'stage2-sources-v1', sources: cycle.collection.snapshot.sources });
    const pretty = value => `${JSON.stringify(value, null, 2)}\n`;
    const instructions = `Synthetic unit fixture: ${alTestPrefixes.join(', ')}`;
    const materials = [...new Set([...corpus.evidence.map(value => hash(pretty(value))),
      ...corpus.captures.map(value => value.sha256), ...corpus.contexts.map(value => value.sha256),
      hash(instructions), hash(pretty(corpus.coverage.map(({ runId, coverage }) => ({ runId, coverage }))))])];
    const request = { format: 'filter-batch-request-v1', sources: cycle.collection.snapshot.sources, instructions,
      groups: [{ id: 'synthetic-group', memberIds: cycle.evidenceIds, contextIds: [], reason: 'Synthetic fixture' }],
      groupingReview: { reviewer: 'synthetic-test', reviewedAt: new Date().toISOString(), rationale: 'Synthetic fixture only' },
      sharing: { audience: 'synthetic', approvalRef: 'synthetic-test',
        materials: materials.map(sha256 => ({ sha256, eligibility: 'approved', restrictions: ['synthetic-only'] })) } };
    const batchDirectory = join(cycle.root, 'batch'); mkdirSync(batchDirectory);
    const manifestPath = join(batchDirectory, 'manifest.json');
    const batchResult = await prepareFilterBatches(config, request, manifestPath,
      async (_config, input) => ({ sha256: input.sha256, model: input.model, tokenizer: input.tokenizer,
        tokens: input.text.startsWith('{') ? 120 : 5 }));
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')), manifestRef = alReference(manifestPath);
    stage('batch', { runDirectory: batchDirectory, filterConfig: cycle.filterConfig,
      batchRequest: f.put('synthetic-batch-request.json', request) }, batchResult);
    const filterDirectory = join(cycle.root, 'filter'), batch = manifest.batches[0];
    reserveAlCycleModels(ledger, cycle, f.plan, f.input.authorization, f.authorization, 'filter', 1, filterDirectory);
    const filtering = new Ledger(config.stateDirectory);
    let outcome;
    try {
      outcome = await executeLocalFilterBatch(config, filtering, manifest, batch.id, {
        execute: async (executable, args) => {
          assert.equal(executable, 'git');
          if (args[1] === 'show') {
            assert.deepEqual(args, ['--no-pager', 'show', `${revision}:.github/skills/tests/SKILL.md`]);
            return { stdout: 'Synthetic unit-only source; no real repository or native qualification.', stderr: '', code: 0 };
          }
          assert.deepEqual(args, ['--no-pager', 'rev-parse', '--verify', `${revision}^{commit}`]);
          return { stdout: revision, stderr: '', code: 0 };
        },
        connect: async (_config, _cwd, action) => action({ createSession: async options => {
          let listener;
          return { sessionId: 'synthetic-unit-session-not-an-actual-model', on: handler => {
            listener = handler; return () => {};
          }, rpc: { tools: { initializeAndValidate: async () => {} }, options: { update: async () => {} } },
          sendAndWait: async input => {
            assert.equal(input.prompt, batch.payload);
            const payload = JSON.parse(JSON.parse(input.prompt).payload);
            const reviewed = { format: 'filter-batch-result-v1', cohortId: manifest.cohortId, batchId: batch.id,
              payloadSha256: batch.analysisPayloadSha256, status: 'complete',
              titles: { format: 'filter-title-decisions-v1', indexSha256: batch.indexSha256,
                reviewer: 'synthetic-unit-test', reviewedAt: new Date().toISOString(),
                decisions: payload.index.entries.map(entry => ({ evidenceId: entry.evidenceId,
                  source: entry.source, captureSha256: entry.captureSha256, disposition: 'needs-details',
                  exclusionType: null, reason: 'Synthetic full review', titleQuote: null })) },
              details: payload.index.entries.map(entry => ({ evidenceId: entry.evidenceId,
                recordSha256: entry.recordSha256, captureSha256: entry.captureSha256,
                status: 'reviewed', reason: 'Synthetic unit review only' })),
              candidates: [{ id: 'synthetic-candidate', evidenceIds: cycle.evidenceIds, repository: cycle.repoId,
                sourceRevision: revision, layer: 'integration', missingAssertion: 'Synthetic recurring finalization assertion',
                existingCoverage: ['Synthetic unit fixture'], harness: `${alTestPrefixes[3]}/synthetic.integration.test.ts`,
                coverageStatus: 'gap', blockers: [], priority: 50, confidence: 0.8,
                rationale: 'Synthetic controller unit fixture; not product evidence or a real model decision' }] };
            listener({ id: 'synthetic-turn', type: 'assistant.turn_start' });
            await options.tools.find(tool => tool.name === 'pilot_filter_source').handler({
              repoId: cycle.repoId, action: 'read', path: '.github/skills/tests/SKILL.md'
            });
            const finished = JSON.parse(await options.tools.find(tool => tool.name === 'pilot_filter_finish')
              .handler({ result: reviewed }));
            assert.equal(finished.state, 'held', JSON.stringify(finished));
          }, disconnect: async () => {} };
        } })
      });
    } finally { filtering.close(); }
    assert.equal(outcome.state, 'complete-held', JSON.stringify(outcome));
    const resultPath = join(cycle.root, 'synthetic-filter-result.json');
    writeFileSync(resultPath, pretty(outcome.result));
    const filterInput = { runDirectory: filterDirectory, filterConfig: cycle.filterConfig,
      manifest: manifestRef, results: [alReference(resultPath)] };
    const reconciled = reconcileAlFilter(filterInput);
    stage('filter', filterInput, { ...filterInput, reconciliation: reconciled.result });
    if (filterOnly) return filterInput;
    const proposeDirectory = join(cycle.root, 'propose');
    reserveAlCycleModels(ledger, cycle, f.plan, f.input.authorization, f.authorization, 'propose', 1, proposeDirectory);
    const assignment = { recordType: 'assignment', id: 'synthetic-assignment', repoId: cycle.repoId,
      evidenceIds: cycle.evidenceIds };
    const head = 'b'.repeat(40), qualified = JSON.parse(readFileSync(f.plan.qualification.path, 'utf8'));
    const published = { recordType: 'workerResult', id: 'synthetic-publication', assignmentId: assignment.id,
      outcome: 'draft-pr-validated', evidenceIds: cycle.evidenceIds, sourceRevision: head,
      draftPR: { isDraft: true, headRevision: head, url: 'https://example.invalid/synthetic-draft' },
      validation: syntheticNativeProof(f.put, 'candidate', head, qualified.profile.sha256) };
    const workers = new Ledger(join(f.plan.stateDirectory, 'workers'));
    try {
      for (const record of [assignment, published])
        workers.db.prepare('INSERT INTO records(kind,id,body,created_at) VALUES(?,?,?,?)')
          .run(record.recordType, record.id, json(record), new Date().toISOString());
      workers.db.prepare(`INSERT INTO jobs(id,investigation_id,version,repo,state,session_id,base_revision,updated_at)
        VALUES(?,?,?,?,?,?,?,?)`).run(assignment.id, 'synthetic-investigation', 1, cycle.repoId,
        'completed', 'synthetic-unit-session', revision, new Date().toISOString());
    } finally { workers.close(); }
    stage('propose', { ...filterInput, runDirectory: proposeDirectory,
      templateConfig: f.plan.templateConfig, qualification: f.plan.qualification },
    { state: 'draft-pr-validated', assignment, result: published });
    cycle.state = 'propose-complete';
    ledger.finishOperation(cycle.id, cycle.state, cycle);
  } finally { ledger.close(); }
  return cycle;
}
async function nonemptyCollectionFixture(f) {
  const begun = await runAlRecurring(f.input);
  const item = { id: 1, rev: 1, fields: { 'System.WorkItemType': 'Bug', 'System.AreaPath': area,
    'System.Title': 'Synthetic nonempty publication finalization fixture', 'System.State': 'Resolved',
    'Microsoft.VSTS.Common.ResolvedReason': 'Fixed',
    'System.CreatedDate': '2026-10-07T01:00:00Z', 'System.ChangedDate': '2026-10-07T02:00:00Z' } };
  const collected = await runAlRecurring({ ...f.input, action: 'collect', cycleId: begun.id },
    { collectionDependencies: { adoTransport: async () => async (endpoint, body) => {
      f.calls.push({ endpoint, body });
      return endpoint === 'workitemsbatch' ? { value: [item] } :
        { asOf: '2026-10-09T00:00:00Z', workItems: body.query.includes('[System.CreatedDate] >=') ? [{ id: 1 }] : [] };
    } } });
  assert.equal(collected.state, 'collected');
  assert.equal(collected.evidenceIds.length, 1);
  return collected;
}
test('AL prepare binds the original FILTER budget to a separate native template without FILTER authority', async t => {
  const f = setup(t, { nativeReceiptFixture: true, localSkillCheckout: true });
  const filter = await completedPublicationFixture(f, await nonemptyCollectionFixture(f), { filterOnly: true });
  const original = configAt(filter.filterConfig.path);
  const native = JSON.parse(readFileSync(f.plan.templateConfig.path, 'utf8'));
  delete native.filterBatching;
  delete native.filterExecutor;
  delete native.localFilter;
  native.limits.maxItems = 3;
  native.limits.workerMaxToolCalls = 5;
  native.repositories[0].skillBindings[0].requestedOutcomes = ['add-or-update-tests'];
  const request = { ...filter, qualification: f.plan.qualification };
  const sourceHash = hash(readFileSync(join(original.stateDirectory, 'ledger.sqlite')));
  for (const mode of ['native-only', 'unapproved-placeholder', 'full']) {
    const template = structuredClone(native);
    if (mode !== 'native-only') template.filterBatching = {
      ...original.filterBatching, approved: mode === 'full'
    };
    const runDirectory = join(f.root, `prepare-${mode}`);
    const result = await runAlWorkflow('prepare', { ...request, runDirectory,
      templateConfig: f.put(`${mode}-template.json`, template) });
    assert.equal(result.state, 'prepared');
    const resolved = JSON.parse(readFileSync(join(runDirectory, 'proposer-config.json'), 'utf8'));
    assert.deepEqual(resolved.filterBatching, original.filterBatching);
    assert.equal(resolved.filterExecutor, undefined);
    assert.equal(resolved.localFilter, undefined);
    assert.equal(resolved.activation.collect, false);
    assert.equal(resolved.activation.dispatch, false);
    assert.equal(resolved.repositories[0].skillBindings[0].skillPath, alAuthoringSkillPath);
    assert.deepEqual(resolved.repositories[0].skillBindings[0].sideEffects,
      { commit: false, push: false, createDraftPR: false });
    const workers = new Ledger(resolved.stateDirectory);
    try {
      assert.equal(workers.all('assignment').length, 1);
      assert.deepEqual(workers.all('assignment')[0].evidenceIds,
        reconcileAlFilter(filter).result.consolidation.selected.evidenceIds);
      assert.equal(workers.status().jobs.length, 1);
      assert.equal(workers.job(result.assignment.id).state, 'prepared');
      assert.equal(workers.db.prepare(
        "SELECT count(*) AS n FROM sqlite_master WHERE name='local_filter_receipts'").get().n, 0);
    } finally { workers.close(); }
    assert.equal(existsSync(join(runDirectory, 'model-reservation.json')), false);
  }
  const templateConfig = f.put('blocked-native-template.json', native);
  const reject = async (name, overrides, pattern, operation = 'prepare') => {
    const runDirectory = join(f.root, `reject-${name}`);
    await assert.rejects(runAlWorkflow(operation, { ...request, templateConfig, ...overrides, runDirectory }),
      pattern);
    assert.equal(existsSync(join(runDirectory, 'model-reservation.json')), false);
    assert.equal(existsSync(join(runDirectory, 'proposer-config.json')), false);
    assert.equal(existsSync(join(runDirectory, 'state', 'ledger.sqlite')), false);
  };
  for (const operation of ['prepare', 'propose'])
    await t.test(`${operation} rejects an approved conflicting template budget before admission`, async () => {
      const conflicting = structuredClone(native);
      conflicting.filterBatching = { ...original.filterBatching, maxInputTokens: 251 };
      await reject(`conflicting-${operation}`, {
        templateConfig: f.put(`conflicting-${operation}.json`, conflicting)
      }, /changed|differ/i, operation);
    });
  for (const key of ['filterConfig', 'manifest', 'results'])
    await t.test(`rejects changed original ${key} bytes at the pinned path`, async () => {
      const reference = key === 'results' ? filter.results[0] : filter[key];
      const bytes = readFileSync(reference.path);
      try {
        writeFileSync(reference.path, `${bytes.toString('utf8')}\n`);
        await reject(key, {}, /explicit content pin/);
      } finally { writeFileSync(reference.path, bytes); }
    });
  await t.test('rejects a repinned original budget that differs from the complete manifest', async () => {
    const changed = JSON.parse(readFileSync(filter.filterConfig.path, 'utf8'));
    changed.filterBatching.maxInputTokens++;
    await reject('repinned-budget', { filterConfig: f.put('changed-budget.json', changed) }, /changed|differ/i);
  });
  await t.test('rejects changed original token budget receipt bytes', async () => {
    const path = original.filterBatching.verificationRef, bytes = readFileSync(path);
    try {
      writeFileSync(path, '{"syntheticUnitFixture":"changed"}');
      await reject('receipt', {}, /Token budget verification receipt changed/);
    } finally { writeFileSync(path, bytes); }
  });
  await t.test('rejects an incomplete original FILTER cohort', async () => {
    await reject('incomplete', { results: [] }, /not completely reconciled/);
  });
  assert.equal(hash(readFileSync(join(original.stateDirectory, 'ledger.sqlite'))), sourceHash);
});
test('AL nonempty published cycle finalizes after expiry using receipts only, then a new grant advances contiguously', async t => {
  const f = setup(t, { nativeReceiptFixture: true });
  const cycle = await completedPublicationFixture(f, await nonemptyCollectionFixture(f));
  const sourceReads = f.calls.length;
  t.mock.method(Date, 'now', () => Date.parse(f.authorization.expiresAt) + 1);
  await assert.rejects(runAlRecurring({ ...f.input, action: 'propose', cycleId: cycle.id }), /expired/);
  await assert.rejects(runAlRecurring({ ...f.input, action: 'observe-pr', cycleId: cycle.id }), /expired/);
  const finished = await runAlRecurring({ ...f.input, action: 'finish', cycleId: cycle.id }, f.dependencies);
  assert.equal(finished.state, 'complete');
  assert.equal(f.calls.length, sourceReads);
  const nextAuthorization = f.put('next-finite-authorization.json', { ...f.authorization,
    approvedAt: new Date(Date.now()).toISOString(), expiresAt: new Date(Date.now() + 120000).toISOString() });
  const secondInput = { ...f.input, authorization: nextAuthorization, window: f.second };
  const next = await runAlRecurring(secondInput);
  assert.equal((await runAlRecurring({ ...secondInput, action: 'collect', cycleId: next.id }, f.dependencies)).state,
    'no-new-evidence');
  assert.deepEqual(await runAlRecurring({ ...f.input, action: 'stop', cycleId: cycle.id }), finished);
  await assert.rejects(runAlRecurring({ ...f.input, action: 'finish', cycleId: cycle.id, resume: true }),
    /Cycle is complete/);
  const ledger = new Ledger(f.plan.stateDirectory);
  try {
    assert.deepEqual(ledger.cursor('al:augloop-workflows'), f.second);
    assert.equal(ledger.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='al-cycle-model-budget'").get().n, 2);
  } finally { ledger.close(); }
  const filter = new Ledger(join(f.plan.stateDirectory, 'filter'));
  const workers = new Ledger(join(f.plan.stateDirectory, 'workers'));
  try {
    assert.equal(filter.db.prepare("SELECT count(*) AS n FROM local_filter_receipts WHERE kind='request'").get().n, 1);
    assert.equal(workers.status().jobs.length, 1);
    assert.equal(workers.db.prepare("SELECT count(*) AS n FROM records WHERE kind='workerResult'").get().n, 1);
  } finally { filter.close(); workers.close(); }
});
test('AL expired nonempty finalization rejects a changed completed receipt without advancing state', async t => {
  const f = setup(t, { nativeReceiptFixture: true });
  const cycle = await completedPublicationFixture(f, await nonemptyCollectionFixture(f));
  const reference = cycle.stages.propose.result;
  writeFileSync(reference.path, json({ state: 'draft-pr-validated', syntheticTampering: true }));
  t.mock.method(Date, 'now', () => Date.parse(f.authorization.expiresAt) + 1);
  await assert.rejects(runAlRecurring({ ...f.input, action: 'finish', cycleId: cycle.id }), /changed|hash|differ/i);
  const ledger = new Ledger(f.plan.stateDirectory);
  try {
    assert.equal(ledger.cursor('al:augloop-workflows'), null);
    assert.equal(ledger.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='al-reviewed-evidence'").get().n, 0);
    assert.equal(JSON.parse(ledger.db.prepare('SELECT detail FROM operations WHERE id=?').get(cycle.id).detail).state,
      'propose-complete');
  } finally { ledger.close(); }
});
test('AL stale finalization cannot rewind the cursor or partially mark nonempty evidence reviewed', async t => {
  const f = setup(t, { nativeReceiptFixture: true });
  const cycle = await completedPublicationFixture(f, await nonemptyCollectionFixture(f));
  const ledger = new Ledger(f.plan.stateDirectory);
  ledger.db.prepare('INSERT INTO cursors VALUES(?,?)').run('al:augloop-workflows', json(f.second));
  ledger.close();
  await assert.rejects(runAlRecurring({ ...f.input, action: 'finish', cycleId: cycle.id }), /Stale cycle/);
  const after = new Ledger(f.plan.stateDirectory);
  try {
    assert.deepEqual(after.cursor('al:augloop-workflows'), f.second);
    assert.equal(after.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='al-reviewed-evidence'").get().n, 0);
    assert.equal(JSON.parse(after.db.prepare('SELECT detail FROM operations WHERE id=?').get(cycle.id).detail).state,
      'propose-complete');
  } finally { after.close(); }
});
for (const nonempty of [false, true])
test(`AL legacy stopped ${nonempty ? 'published' : 'empty'} cycle rejects stale finish and admits next cycle after explicit recovery`, async t => {
  const f = setup(t, { nativeReceiptFixture: nonempty });
  const first = nonempty ? await completedPublicationFixture(f, await nonemptyCollectionFixture(f))
    : await runAlRecurring(f.input);
  const completed = await runAlRecurring({ ...f.input, action: nonempty ? 'finish' : 'collect', cycleId: first.id },
    f.dependencies);
  assert.equal(completed.state, nonempty ? 'complete' : 'no-new-evidence');
  const nextGrant = f.put('legacy-next-finite-grant.json', { ...f.authorization,
    expiresAt: new Date(Date.parse(f.authorization.expiresAt) + 120000).toISOString() });
  const nextInput = { ...f.input, authorization: nextGrant, window: f.second };
  const second = await runAlRecurring(nextInput);
  assert.equal((await runAlRecurring({ ...nextInput, action: 'collect', cycleId: second.id }, f.dependencies)).state,
    'no-new-evidence');
  const ledger = new Ledger(f.plan.stateDirectory);
  let before;
  try {
    assert.deepEqual(ledger.cursor('al:augloop-workflows'), f.second);
    // Reproduce durable state left by the old terminal-stop bug, not the fixed stop action.
    ledger.finishOperation(completed.id, 'stopped', { ...completed, state: 'stopped' });
    before = ledger.db.prepare("SELECT id,state,detail FROM operations WHERE kind='al-reviewed-evidence' ORDER BY id").all();
    assert.equal(before.length, nonempty ? 1 : 0);
  } finally { ledger.close(); }
  t.mock.method(Date, 'now', () => Date.parse(f.authorization.expiresAt) + 1);
  await assert.rejects(runAlRecurring({ ...f.input, action: 'finish', cycleId: completed.id, resume: true }),
    /Stale cycle/);
  const after = new Ledger(f.plan.stateDirectory);
  try {
    assert.deepEqual(after.cursor('al:augloop-workflows'), f.second);
    assert.deepEqual(after.db.prepare("SELECT id,state,detail FROM operations WHERE kind='al-reviewed-evidence' ORDER BY id").all(),
      before);
    const cycle = after.db.prepare('SELECT state,detail FROM operations WHERE id=?').get(completed.id);
    assert.equal(cycle.state, 'stopped');
    assert.deepEqual(JSON.parse(cycle.detail), { ...completed, state: 'stopped' });
  } finally { after.close(); }
  const thirdWindow = { start: f.second.end, end: '2026-10-10T00:00:00.000Z' };
  await assert.rejects(runAlRecurring({ ...nextInput, window: thirdWindow }), /no overlapping cycle/);
  const sourceReads = f.calls.length;
  const recovered = await runAlRecurring({ ...f.input, action: 'reconcile-stage', stage: 'completion',
    cycleId: completed.id }, f.dependencies);
  assert.equal(recovered.state, completed.state);
  assert.equal(f.calls.length, sourceReads);
  assert.deepEqual(recovered.completionRecovery, { sourceReads: 0, modelCalls: 0, publicationCalls: 0,
    cursorUnchanged: true, reviewedEvidenceUnchanged: true });
  const restored = new Ledger(f.plan.stateDirectory);
  try {
    assert.deepEqual(restored.cursor('al:augloop-workflows'), f.second);
    assert.deepEqual(restored.db.prepare("SELECT id,state,detail FROM operations WHERE kind='al-reviewed-evidence' ORDER BY id").all(),
      before);
  } finally { restored.close(); }
  const third = await runAlRecurring({ ...nextInput, window: thirdWindow });
  assert.equal((await runAlRecurring({ ...nextInput, action: 'collect', cycleId: third.id }, f.dependencies)).state,
    'no-new-evidence');
  const final = new Ledger(f.plan.stateDirectory);
  try { assert.deepEqual(final.cursor('al:augloop-workflows'), thirdWindow); }
  finally { final.close(); }
});
for (const corruption of ['missing-cursor', 'unreviewed-evidence', 'missing-intent', 'altered-proof'])
test(`AL legacy completion recovery rejects ${corruption} without inventing cursor or dedup state`, async t => {
  const f = setup(t, { nativeReceiptFixture: true });
  const published = await completedPublicationFixture(f, await nonemptyCollectionFixture(f));
  const completed = await runAlRecurring({ ...f.input, action: 'finish', cycleId: published.id });
  const ledger = new Ledger(f.plan.stateDirectory);
  try {
    ledger.finishOperation(completed.id, 'stopped', { ...completed, state: 'stopped' });
    if (corruption === 'missing-cursor') ledger.db.prepare('DELETE FROM cursors').run();
    else if (corruption === 'unreviewed-evidence')
      ledger.db.prepare("DELETE FROM operations WHERE kind='al-reviewed-evidence'").run();
    else if (corruption === 'missing-intent')
      ledger.db.prepare('DELETE FROM operations WHERE id=?').run(`${completed.id}:propose`);
    else writeFileSync(completed.stages.propose.result.path, json({ syntheticAlteredProof: true }));
  } finally { ledger.close(); }
  t.mock.method(Date, 'now', () => Date.parse(f.authorization.expiresAt) + 1);
  const sourceReads = f.calls.length;
  await assert.rejects(runAlRecurring({ ...f.input, action: 'reconcile-stage', stage: 'completion',
    cycleId: completed.id }), /no covering cursor|unreviewed evidence|original stage intent|missing or changed/);
  assert.equal(f.calls.length, sourceReads);
  const after = new Ledger(f.plan.stateDirectory);
  try {
    assert.deepEqual(after.cursor('al:augloop-workflows'), corruption === 'missing-cursor' ? null : f.first);
    assert.equal(after.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='al-reviewed-evidence'").get().n,
      corruption === 'unreviewed-evidence' ? 0 : 1);
    assert.equal(after.db.prepare('SELECT state FROM operations WHERE id=?').get(completed.id).state, 'stopped');
  } finally { after.close(); }
});
test('AL expired finalization independently checks native receipts, not just completed stage flags', async t => {
  for (const corruption of ['missing-intent', 'changed-filter-summary', 'noncompleted-native-job'])
    await t.test(corruption, async t => {
      const f = setup(t, { nativeReceiptFixture: true });
      const cycle = await completedPublicationFixture(f, await nonemptyCollectionFixture(f));
      if (corruption === 'noncompleted-native-job') {
        const workers = new Ledger(join(f.plan.stateDirectory, 'workers'));
        workers.db.prepare("UPDATE jobs SET state='blocked' WHERE id='synthetic-assignment'").run();
        workers.close();
      } else {
        const ledger = new Ledger(f.plan.stateDirectory);
        if (corruption === 'missing-intent') ledger.db.prepare('DELETE FROM operations WHERE id=?')
          .run(`${cycle.id}:propose`);
        else {
          const path = cycle.stages.filter.result.path, result = JSON.parse(readFileSync(path, 'utf8'));
          result.reconciliation.consolidation.selected = null;
          writeFileSync(path, json(result));
          cycle.stages.filter.result = alReference(path);
          ledger.finishOperation(cycle.id, cycle.state, cycle);
        }
        ledger.close();
      }
      t.mock.method(Date, 'now', () => Date.parse(f.authorization.expiresAt) + 1);
      await assert.rejects(runAlRecurring({ ...f.input, action: 'finish', cycleId: cycle.id }),
        /original stage intent|native execution reconciliation|exact-head Draft/);
      const ledger = new Ledger(f.plan.stateDirectory);
      try {
        assert.equal(ledger.cursor('al:augloop-workflows'), null);
        assert.equal(ledger.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='al-reviewed-evidence'").get().n, 0);
      } finally { ledger.close(); }
    });
});
test('AL finalization rolls back cursor, evidence and cycle together after a bookkeeping failure', async t => {
  const f = setup(t, { nativeReceiptFixture: true });
  const cycle = await completedPublicationFixture(f, await nonemptyCollectionFixture(f));
  const ledger = new Ledger(f.plan.stateDirectory);
  ledger.db.exec(`CREATE TRIGGER synthetic_bookkeeping_failure BEFORE INSERT ON operations
    WHEN NEW.kind='al-reviewed-evidence' BEGIN SELECT RAISE(ABORT,'synthetic bookkeeping failure'); END`);
  ledger.close();
  await assert.rejects(runAlRecurring({ ...f.input, action: 'finish', cycleId: cycle.id }), /synthetic bookkeeping failure/);
  const after = new Ledger(f.plan.stateDirectory);
  try {
    assert.equal(after.cursor('al:augloop-workflows'), null);
    assert.equal(after.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='al-reviewed-evidence'").get().n, 0);
    assert.equal(JSON.parse(after.db.prepare('SELECT detail FROM operations WHERE id=?').get(cycle.id).detail).state,
      'propose-complete');
  } finally { after.close(); }
});
test('AL recurring second empty cycle advances contiguous windows without model/job work or duplicate collection', async t => {
  const f = setup(t);
  const first = await runAlRecurring(f.input);
  const collected = await runAlRecurring({ ...f.input, action: 'collect', cycleId: first.id }, f.dependencies);
  assert.equal(collected.state, 'no-new-evidence', JSON.stringify(collected.collectionStatus));
  assert.equal(collected.collection.sourceCoverageComplete, true);
  const reads = f.calls.length;
  assert.ok(reads > 0);
  assert.equal((await runAlRecurring(f.input)).state, 'no-new-evidence');
  assert.equal(f.calls.length, reads);
  const second = await runAlRecurring({ ...f.input, window: f.second });
  assert.equal(configAt(first.collectorConfig.path).stateDirectory, configAt(second.collectorConfig.path).stateDirectory);
  assert.equal(configAt(first.filterConfig.path).stateDirectory, configAt(second.filterConfig.path).stateDirectory);
  const next = await runAlRecurring({ ...f.input, action: 'collect', cycleId: second.id }, f.dependencies);
  assert.equal(next.state, 'no-new-evidence');
  assert.equal(f.calls.length, reads * 2);
  assert.equal((await runAlRecurring({ ...f.input, action: 'stop', cycleId: first.id })).state, 'no-new-evidence');
  await assert.rejects(runAlRecurring({ ...f.input, action: 'finish', cycleId: first.id, resume: true }),
    /Cycle is complete/);
  const ledger = new Ledger(f.plan.stateDirectory);
  try {
    assert.deepEqual(ledger.cursor('al:augloop-workflows'), f.second);
    assert.equal(ledger.status().jobs.length, 0);
    assert.equal(ledger.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='al-cycle-model-budget'").get().n, 0);
  } finally { ledger.close(); }
  await assert.rejects(runAlRecurring({ ...f.input,
    window: { start: f.second.end, end: '2026-10-10T00:00:00.000Z' } }), /allowance.exhausted/);
});
test('AL recurring uses native overlap locks, explicit stop/resume and does not silently skip windows', async t => {
  const f = setup(t), first = await runAlRecurring(f.input);
  await assert.rejects(runAlRecurring({ ...f.input, window: f.second }), /overlapping cycle/);
  await runAlRecurring({ ...f.input, action: 'stop', cycleId: first.id });
  await assert.rejects(runAlRecurring({ ...f.input, action: 'collect', cycleId: first.id }, f.dependencies),
    /explicitly stopped/);
  assert.equal(f.calls.length, 0);
  const ledger = new Ledger(f.plan.stateDirectory), owner = ledger.acquire('coordinator');
  try {
    await assert.rejects(runAlRecurring(f.input), /Ownership held/);
    await assert.rejects(runAlRecurring({ ...f.input, action: 'collect', cycleId: first.id, resume: true },
      f.dependencies), /Ownership held/);
  } finally { ledger.release('coordinator', owner); ledger.close(); }
  assert.equal((await runAlRecurring({ ...f.input, action: 'collect', cycleId: first.id, resume: true },
    f.dependencies)).state, 'no-new-evidence');
  await assert.rejects(runAlRecurring({ ...f.input,
    window: { start: f.second.end, end: '2026-10-10T00:00:00.000Z' } }), /coverage gap/);
});
test('AL recurring preserves a whole nonempty cohort and deduplicates its native evidence identity', async t => {
  const f = setup(t, { maxCycles: 3 }), first = await runAlRecurring(f.input);
  const item = { id: 1, rev: 1, fields: { 'System.WorkItemType': 'Bug', 'System.AreaPath': area,
    'System.Title': 'Synthetic recurring identity fixture', 'System.State': 'Resolved',
    'Microsoft.VSTS.Common.ResolvedReason': 'Fixed',
    'System.CreatedDate': '2026-10-07T01:00:00Z', 'System.ChangedDate': '2026-10-08T02:00:00Z' } };
  let changedPass = false;
  const dependencies = { collectionDependencies: { adoTransport: async () => async (endpoint, body) =>
    endpoint === 'workitemsbatch' ? { value: [item] } :
      { asOf: '2026-10-09T00:00:00Z', workItems: body.query.includes(changedPass
        ? '[System.ChangedDate] >=' : '[System.CreatedDate] >=') ? [{ id: 1 }] : [] }
  } };
  const collected = await runAlRecurring({ ...f.input, action: 'collect', cycleId: first.id }, dependencies);
  assert.equal(collected.state, 'collected', JSON.stringify(collected.collectionStatus));
  assert.equal(collected.evidenceIds.length, 1);
  await assert.rejects(runAlRecurring({ ...f.input, action: 'finish', cycleId: first.id }), /complete FILTER/);
  const batch = f.put('bad-batch.json', { sources: [] });
  const stage = f.put('bad-stage.json', { batchRequest: batch, filterConfig: collected.filterConfig,
    runDirectory: join(collected.root, 'batch') });
  await assert.rejects(runAlRecurring({ ...f.input, action: 'batch', cycleId: first.id, stageRequest: stage }),
    /complete authenticated cohort/);
  // Seed a prior reviewed-state fixture, not a fabricated live FILTER receipt.
  const ledger = new Ledger(f.plan.stateDirectory);
  const key = `al-seen:augloop-workflows:${revision}:${collected.evidenceIds[0]}`;
  ledger.operation(key, 'synthetic-prior-review', 'al-reviewed-evidence', { syntheticUnitFixture: true });
  ledger.finishOperation(key, 'reviewed', { syntheticUnitFixture: true });
  ledger.close();
  await runAlRecurring({ ...f.input, action: 'stop', cycleId: first.id });
  const second = await runAlRecurring({ ...f.input, predecessor: first.id, recoveryApproved: true,
    reason: 'Synthetic prior-reviewed identity fixture; source-only bounded replay.' });
  const repeated = await runAlRecurring({ ...f.input, action: 'collect', cycleId: second.id }, dependencies);
  assert.equal(repeated.state, 'no-new-evidence');
  assert.deepEqual(repeated.evidenceIds, collected.evidenceIds);
  assert.deepEqual(repeated.unseenEvidenceIds, []);
  changedPass = true;
  const next = await runAlRecurring({ ...f.input, window: f.second });
  const unchanged = await runAlRecurring({ ...f.input, action: 'collect', cycleId: next.id }, dependencies);
  assert.equal(unchanged.state, 'no-new-evidence');
  assert.deepEqual(unchanged.evidenceIds, collected.evidenceIds);
  const final = new Ledger(f.plan.stateDirectory);
  try {
    assert.deepEqual(final.cursor('al:augloop-workflows'), f.second);
    assert.equal(final.status().jobs.length, 0);
    assert.equal(final.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='al-cycle-model-budget'").get().n, 0);
  } finally { final.close(); }
});
test('AL recurring source failure is durable and cannot be converted into no-new-evidence or retried silently', async t => {
  const f = setup(t), first = await runAlRecurring(f.input);
  let reads = 0;
  const failed = await runAlRecurring({ ...f.input, action: 'collect', cycleId: first.id },
    { collectionDependencies: { adoTransport: async () => async () => { reads++; throw Error('synthetic source failure'); } } });
  assert.equal(failed.state, 'blocked');
  assert.equal(failed.collection, undefined);
  await assert.rejects(runAlRecurring({ ...f.input, action: 'batch', cycleId: first.id }),
    /Complete collection is required/);
  const repeated = await runAlRecurring({ ...f.input, action: 'collect', cycleId: first.id }, f.dependencies);
  assert.equal(repeated.state, 'blocked');
  assert.equal((await runAlRecurring({ ...f.input, action: 'collect', cycleId: first.id, resume: true },
    f.dependencies)).state, 'blocked');
  assert.equal(reads, 1, JSON.stringify(failed.collectionStatus));
  assert.equal(f.calls.length, 0);
  await assert.rejects(runAlRecurring({ ...f.input, action: 'finish', cycleId: first.id }), /complete FILTER|collection/i);
  await assert.rejects(runAlRecurring({ ...f.input, action: 'reconcile-stage', cycleId: first.id, stage: 'filter' }),
    /No original stage intent/);
  await assert.rejects(runAlRecurring({ ...f.input, predecessor: first.id }), /explicit diagnosis/);
  const successor = await runAlRecurring({ ...f.input, predecessor: first.id, recoveryApproved: true,
    reason: 'Synthetic transport failure diagnosed; authorize one bounded source-only successor.' });
  assert.equal(successor.predecessor, first.id);
  const recovered = await runAlRecurring({ ...f.input, action: 'collect', cycleId: successor.id }, f.dependencies);
  assert.equal(recovered.state, 'no-new-evidence');
  assert.equal((await runAlRecurring({ ...f.input, action: 'stop', cycleId: first.id })).state,
    'superseded-source-cycle');
});
test('AL finite grant preserves cumulative credit reservations and exhaustion across reopened cycles', async t => {
  const f = setup(t);
  const plan = { ...f.plan, limits: { ...f.plan.limits, maxFilterSessions: 1 } };
  const planRef = f.put('credit-plan.json', plan);
  const authority = { ...f.authorization, planSha256: planRef.sha256,
    allowModels: true, maxTotalModelSessions: 2, maxTotalAiCredits: 30 };
  const input = { ...f.input, plan: planRef, authorization: f.put('credit-authority.json', authority) };
  const first = await runAlRecurring(input);
  let ledger = new Ledger(plan.stateDirectory);
  try {
    // Reservation-only unit fixture: no model execution or successful FILTER is asserted.
    reserveAlCycleModels(ledger, first, plan, input.authorization, authority, 'filter', 1, join(first.root, 'filter'));
  } finally { ledger.close(); }
  await runAlRecurring({ ...input, action: 'collect', cycleId: first.id }, f.dependencies);
  const second = await runAlRecurring({ ...input, window: f.second });
  ledger = new Ledger(plan.stateDirectory);
  try {
    assert.throws(() => reserveAlCycleModels(ledger, second, plan, input.authorization, authority,
      'filter', 1, join(second.root, 'filter')), /cumulative model\/AI-credit/);
  } finally { ledger.close(); }
  const status = await runAlRecurring({ ...input, action: 'grant-status' });
  assert.equal(status.state, 'exhausted');
  assert.equal(status.modelSessionsReserved, 1);
  assert.equal(status.aiCreditsReserved, 30);
  assert.equal(status.aiCreditsRemaining, 0);
  assert.equal(status.publications, 0);
  await assert.rejects(runAlRecurring({ ...input, action: 'collect', cycleId: second.id }), /grant is exhausted/);
  ledger = new Ledger(plan.stateDirectory);
  try {
    assert.equal(ledger.status().jobs.length, 0);
    assert.equal(ledger.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='al-cycle-model-budget'").get().n, 1);
  } finally { ledger.close(); }
});
test('AL shared FILTER state blocks same-manifest retries without blocking the next distinct cohort', t => {
  const f = setup(t), config = { stateDirectory: f.plan.stateDirectory };
  const oldManifest = { syntheticUnitFixture: true, cohortId: 'old' };
  const oldRef = f.put('old-manifest.json', oldManifest);
  const nextRef = f.put('next-manifest.json', { syntheticUnitFixture: true, cohortId: 'next' });
  const ledger = new Ledger(config.stateDirectory);
  try {
    ledger.db.exec('CREATE TABLE local_filter_receipts(task_id TEXT,kind TEXT,body TEXT)');
    ledger.db.prepare('INSERT INTO local_filter_receipts VALUES(?,?,?)')
      .run('synthetic-old-attempt', 'request', json({ manifestSha256: hash(json(oldManifest)) }));
  } finally { ledger.close(); }
  assert.doesNotThrow(() => requireUnstartedAlFilter(config, nextRef));
  assert.throws(() => requireUnstartedAlFilter(config, oldRef), /already has native requests/);
});
test('AL grant stop and expiry survive restart without source reads or permission renewal', async t => {
  const f = setup(t), first = await runAlRecurring(f.input);
  assert.equal((await runAlRecurring({ ...f.input, action: 'stop-grant' })).state, 'stopped');
  await assert.rejects(runAlRecurring({ ...f.input, action: 'collect', cycleId: first.id }), /grant is stopped/);
  assert.equal((await runAlRecurring({ ...f.input, action: 'grant-status' })).reason, 'operator-stop');
  assert.equal(f.calls.length, 0);
  const other = setup(t);
  await runAlRecurring(other.input);
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() + 121000 });
  await assert.rejects(runAlRecurring(other.input), /authorization expired/);
  assert.equal((await runAlRecurring({ ...other.input, action: 'grant-status' })).state, 'expired');
  t.mock.timers.reset();
  assert.equal((await runAlRecurring({ ...other.input, action: 'grant-status' })).state, 'expired');
  assert.equal(other.calls.length, 0);
});
for (const kind of ['sessions', 'publications']) test(`AL ${kind} reservation limit survives a second-cycle restart`, async t => {
  const f = setup(t);
  const plan = { ...f.plan, limits: { ...f.plan.limits, maxFilterSessions: 1, maxProposers: 1 } };
  const planRef = f.put(`${kind}-plan.json`, plan);
  const authority = { ...f.authorization, planSha256: planRef.sha256, allowModels: true, allowPublication: true,
    maxTotalModelSessions: kind === 'sessions' ? 1 : 3, maxTotalAiCredits: 90, maxTotalDrafts: 1 };
  const input = { ...f.input, plan: planRef, authorization: f.put(`${kind}-authority.json`, authority) };
  const first = await runAlRecurring(input), stage = kind === 'sessions' ? 'filter' : 'propose';
  let ledger = new Ledger(plan.stateDirectory);
  try {
    reserveAlCycleModels(ledger, first, plan, input.authorization, authority, stage, 1, join(first.root, stage));
  } finally { ledger.close(); }
  await runAlRecurring({ ...input, action: 'collect', cycleId: first.id }, f.dependencies);
  const second = await runAlRecurring({ ...input, window: f.second });
  ledger = new Ledger(plan.stateDirectory);
  try {
    assert.throws(() => reserveAlCycleModels(ledger, second, plan, input.authorization, authority,
      stage, 1, join(second.root, stage)), kind === 'sessions' ? /cumulative model/ : /publication stop/);
  } finally { ledger.close(); }
  const status = await runAlRecurring({ ...input, action: 'grant-status' });
  assert.equal(status.state, 'exhausted');
  assert.equal(status.modelSessionsReserved, 1);
  assert.equal(status.publications, 0, 'Reservation-only fixture must never be reported as an actual PR');
  assert.equal(status.publicationsReserved, kind === 'publications' ? 1 : 0);
  await assert.rejects(runAlRecurring({ ...input, action: 'collect', cycleId: second.id }), /grant is exhausted/);
});
test('AL publication stop is durable and does not turn spare session allowance into a new cycle', async t => {
  const f = setup(t), first = await runAlRecurring(f.input);
  await runAlRecurring({ ...f.input, action: 'collect', cycleId: first.id }, f.dependencies);
  const reads = f.calls.length;
  const ledger = new Ledger(f.plan.stateDirectory);
  try {
    const row = ledger.db.prepare('SELECT detail FROM operations WHERE id=?').get(first.id);
    const cycle = JSON.parse(row.detail);
    // Clearly synthetic prior-publication state; the test performs no publisher call.
    cycle.stages.propose = { result: f.put('synthetic-prior-publication.json', { syntheticUnitFixture: true }) };
    ledger.finishOperation(first.id, cycle.state, cycle);
  } finally { ledger.close(); }
  const status = await runAlRecurring({ ...f.input, action: 'grant-status' });
  assert.equal(status.state, 'stopped');
  assert.equal(status.reason, 'first-suitable-draft');
  assert.equal(status.publications, 1);
  await assert.rejects(runAlRecurring({ ...f.input, window: f.second }), /first-suitable-draft/);
  assert.equal(f.calls.length, reads);
});
test('AL same invariant with a different evidence root in the next cycle is held before Proposer or PR reservation', async t => {
  const f = setup(t), first = await runAlRecurring(f.input);
  await runAlRecurring({ ...f.input, action: 'collect', cycleId: first.id }, f.dependencies);
  const key = JSON.stringify(['augloop-workflows', revision, 'integration', 'Synthetic stable missing assertion']);
  const priorResult = f.put('synthetic-prior-filter.json', { syntheticUnitFixture: true,
    reconciliation: { consolidation: { selected: { key, evidenceIds: ['synthetic-old-root'] } } } });
  let ledger = new Ledger(f.plan.stateDirectory);
  try {
    const prior = JSON.parse(ledger.db.prepare('SELECT detail FROM operations WHERE id=?').get(first.id).detail);
    prior.stages.filter = { result: priorResult };
    ledger.finishOperation(first.id, prior.state, prior);
  } finally { ledger.close(); }
  const second = await runAlRecurring({ ...f.input, window: f.second });
  const item = { id: 2, rev: 1, fields: { 'System.WorkItemType': 'Bug', 'System.AreaPath': area,
    'System.Title': 'Synthetic second-cycle evidence root', 'System.State': 'Resolved',
    'Microsoft.VSTS.Common.ResolvedReason': 'Fixed', 'System.CreatedDate': '2026-10-08T01:00:00Z',
    'System.ChangedDate': '2026-10-08T02:00:00Z' } };
  const dependencies = { collectionDependencies: { adoTransport: async () => async (endpoint, body) =>
    endpoint === 'workitemsbatch' ? { value: [item] } :
      { asOf: '2026-10-09T00:00:00Z', workItems: body.query.includes('[System.CreatedDate] >=') ? [{ id: 2 }] : [] }
  } };
  const collected = await runAlRecurring({ ...f.input, action: 'collect', cycleId: second.id }, dependencies);
  assert.equal(collected.evidenceIds.length, 1);
  const batchRoot = join(second.root, 'batch'); mkdirSync(batchRoot);
  const manifestFile = join(batchRoot, 'manifest.json'); writeFileSync(manifestFile, '{"syntheticUnitFixture":true}');
  const currentFilter = f.put('synthetic-current-filter.json', { syntheticUnitFixture: true, results: [],
    reconciliation: { consolidation: { selected: { key, evidenceIds: collected.evidenceIds } } } });
  ledger = new Ledger(f.plan.stateDirectory);
  try {
    const current = JSON.parse(ledger.db.prepare('SELECT detail FROM operations WHERE id=?').get(second.id).detail);
    current.stages = { batch: { runDirectory: batchRoot }, filter: { result: currentFilter } };
    ledger.finishOperation(second.id, 'filter-complete', current);
  } finally { ledger.close(); }
  const stage = f.put('duplicate-prepare.json', { runDirectory: join(second.root, 'prepare'),
    filterConfig: second.filterConfig, manifest: alReference(manifestFile), results: [],
    templateConfig: f.plan.templateConfig });
  await assert.rejects(runAlRecurring({ ...f.input, action: 'prepare', cycleId: second.id, stageRequest: stage }),
    /Existing candidate work across cycles/);
  const held = await runAlRecurring({ ...f.input, action: 'status', cycleId: second.id });
  assert.equal(held.candidateHold.prior[0].cycleId, first.id);
  ledger = new Ledger(f.plan.stateDirectory);
  try {
    assert.equal(ledger.status().jobs.length, 0);
    assert.equal(ledger.db.prepare("SELECT count(*) AS n FROM operations WHERE kind='al-cycle-model-budget'").get().n, 0);
  } finally { ledger.close(); }
});
test('AL recurring rejects historical/expired permissions and binds repository, plan and finite budgets', async t => {
  const f = setup(t);
  for (const change of [{ format: 'al-e2e-authorization-v2' }, { expiresAt: '2000-01-01T00:00:00Z' },
    { planSha256: 'b'.repeat(64) }, { maxCycles: Infinity }, { maxTotalModelSessions: -1 }])
    assert.throws(() => requireRecurringAuthority(f.plan, f.planRef, { ...f.authorization, ...change }), /finite plan-bound/);
  const bad = { ...f.plan, repoId: 'another-repository' };
  await assert.rejects(runAlRecurring({ ...f.input, action: 'inspect', plan: f.put('bad-plan.json', bad) }),
    /repository\/source routing/);
  assert.equal((await runAlRecurring({ ...f.input, action: 'inspect' })).state, 'configured-not-activated');
  for (const [name, change] of [['legacy', { executionMode: 'standalone-sdk' }],
    ['scheduled', { schedule: { ...configAt(f.plan.collectorConfig.path).schedule, enabled: true } }]]) {
    const config = { ...configAt(f.plan.collectorConfig.path), ...change };
    const invalid = { ...f.plan, collectorConfig: f.put(`${name}-collector.json`, config) };
    await assert.rejects(runAlRecurring({ ...f.input, action: 'inspect', plan: f.put(`${name}-plan.json`, invalid) }),
      /app-native collection and disabled/);
  }
});
test('AL capability discovery never promotes similar scripts or unrelated owners by substitution', () => {
  const entries = alOwners.map(owner => classifyAlOwner(owner.path,
    { name: owner.package, scripts: { build: 'gulp build', test: owner.testScript } },
    [`${owner.path}/${owner.tests}/arbitrary.integration.test.ts`]));
  assert.ok(entries.every(owner => owner.nativeContractSupported && !owner.qualified && !owner.candidateAccepted));
  const other = classifyAlOwner('workflows/another', { name: '@augloop/another',
    scripts: { build: 'gulp build', test: 'run -T jest' } }, ['workflows/another/tests/new.integration.test.ts']);
  assert.equal(other.family, 'jest'); assert.equal(other.nativeContractSupported, false);
  const repo = { id: 'augloop-workflows', remote, baseRef: revision };
  for (const owner of alOwners) {
    const path = `${owner.path}/${owner.tests}/any.integration.test.ts`;
    assert.equal(requireAlCandidateOwner({ definition: { repository: repo.id, sourceRevision: revision,
      layer: 'integration', harness: `${path} (existing harness)` } }, repo).path, owner.path);
    const matrix = { format: 'al-owner-capabilities-v1', repoId: repo.id, remote, revision, owners: entries };
    assert.throws(() => routeAlCandidate(matrix, repo, [path]), /qualified authorized/);
    assert.deepEqual(routeAlCandidate({ ...matrix, owners: entries.map(value => ({ ...value, qualified: true })) },
      repo, [path]), [owner.path]);
    assert.throws(() => routeAlCandidate({ ...matrix, revision: 'b'.repeat(40) }, repo, [path]), /another repository or revision/);
  }
  assert.throws(() => requireAlCandidateOwner({ definition: { repository: repo.id, sourceRevision: revision,
    layer: 'integration', harness: 'workflows/another/tests/new.integration.test.ts' } }, repo), /supported owner/);
});
test('AL manifest discovery uses bounded exact native Git blob frames, including UTF-8 bytes', t => {
  const root = mkdtempSync(join(tmpdir(), 'al-git-blobs-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=.git/no-hooks', ...args],
    { cwd: root, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '--quiet']); git(['config', 'core.autocrlf', 'false']);
  git(['config', 'user.email', 'synthetic@example.invalid']); git(['config', 'user.name', 'Synthetic AL discovery']);
  mkdirSync(join(root, 'nested'));
  const first = JSON.stringify({ name: `caf${String.fromCodePoint(233)}` });
  writeFileSync(join(root, 'package.json'), first);
  writeFileSync(join(root, 'nested/package.json'), '{"name":"second"}\n');
  git(['add', '.']); git(['commit', '--quiet', '-m', 'Synthetic blob fixtures']);
  const repo = { id: 'augloop-workflows', remote, baseRef: git(['rev-parse', 'HEAD']), referenceCheckout: root };
  assert.deepEqual(readAlGitBlobs(repo, ['package.json', 'nested/package.json']), [first, '{"name":"second"}\n']);
  assert.throws(() => readAlGitBlobs(repo, ['missing/package.json']), /incomplete manifest frame/);
  assert.throws(() => readAlGitBlobs(repo, Array(17).fill('package.json')), /not bounded/);
});
