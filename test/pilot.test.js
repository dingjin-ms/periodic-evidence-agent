import test from 'node:test';
import { loadAuthoringFeedback } from '../src/workers.js';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync,
  realpathSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CopilotClient } from '@github/copilot-sdk';
import { probeWorkiq } from '../scripts/Workiq-Auth-Repro.mjs';
import { Ledger } from '../src/ledger.js';
import { configAt, hash, json, now, exclusions, PilotError, Budget, boundedPath, validateRecord, workspaceCleanupPolicy, proposerExecutorFlight, validationLfsPaths } from '../src/common.js';
import { collectAdo, collectWorkiq, collectIcm, evidenceEnvelope, workiqTitle, area, wiql, adoRecord } from '../src/sources.js';
import { dryRun } from '../src/dry-run.js';
import { followRelated, readRelatedWorkiq } from '../src/followup.js';
import { revisitTracked } from '../src/revisit.js';
import { collect, acceptReview, report, latestEvidence, reconcile, tick, previousUtcDay, nextDailyWake, readinessFingerprint } from '../src/coordinator.js';
import { validateSeed, restrictedSession, authoringSession, principalPath, unwrapWorkiq, verifyPrincipal, channelRoot, messageSelect, nextWorkiqPage, validateWorkiqPath, workiqRuntimeError, prepareWorkiq } from '../src/runtime.js';
import { makeAssignment, makePlannedImprovementAssignment, WorkerTools, provision, checkoutEnvironment, hydrateValidationLfs, prepareValidation, preflightValidationAuthentication, runValidation, pushDraftBranch, newCaseBuildSelection, newCaseBuildGroups, queueAdoDraftBuild, createAdoDraft, command, minimalEnvironment, dispatch, repoFor, requireAllowedSkillChanges, verifyPreparedOutputs, verifyTestOnlyProfileChange, rebindPreparedTestProfile } from '../src/workers.js';
import { recordAreaToImprove, recordTestCoveragePlan } from '../src/improvements.js';
import { repositoryValidationContract, skillQualificationId } from '../src/repository-skills.js';
import { outputPathFingerprint } from '../src/output-fingerprint.js';
import { cleanupWorkspace, cleanupWorkspaces } from '../src/workspace-gc.js';
import { schedulePreparedAssignments } from '../src/assignment-scheduler.js';
import { bindAlModelExecution } from '../src/al-workflow.js';
import { alReference } from '../src/al-adapter.js';
import {
  setup,
  adoItem,
  transport,
  addEvidence,
  review,
  repoConfig,
  fixture,
  stagedValidationFixture,
  deliveredWorkspace,
  packageToken,
  longPathFixture,
  gitLfsAvailable,
  useFixtureLfsTransfer,
  lfsValidationFixture,
  channelConfig,
  message,
  principal,
  workiqLifecycle
} from '../scripts/test-fixtures/pilot.mjs';


test('named contract validation does not compile the unused document root union', () => {
  const script = `
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
const originalRead = fs.readFileSync;
let intercepted = 0;
fs.readFileSync = function (path, ...options) {
  const value = originalRead.call(this, path, ...options);
  if (path instanceof URL && path.href === ${JSON.stringify(new URL('../scaffold/contracts.schema.json', import.meta.url).href)}) {
    intercepted++;
    const schema = JSON.parse(value);
    schema.oneOf.push({ $ref: '#/$defs/unused-root-union-member' });
    return JSON.stringify(schema);
  }
  return value;
};
syncBuiltinESMExports();
const { validateRecord } = await import(${JSON.stringify(new URL('../src/common.js', import.meta.url).href)});
const examples = JSON.parse(originalRead(${JSON.stringify(fileURLToPath(new URL('../scaffold/example-flows.json', import.meta.url)))}, 'utf8'));
validateRecord(examples, 'examples');
const configuration = JSON.parse(originalRead(${JSON.stringify(fileURLToPath(new URL('../scaffold/configuration.template.json', import.meta.url)))}, 'utf8'));
validateRecord(configuration, 'configuration');
const invalid = structuredClone(examples.records.find(record => record.recordType === 'workerResult'));
delete invalid.validation[0].attemptCount;
assert.throws(() => validateRecord(invalid), error => error.code === 'invalid-record');
assert.throws(() => validateRecord({}, 'missing-record-type'), error => error.code === 'invalid-record');
assert.equal(intercepted, 1);
`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script],
    { cwd: process.cwd(), encoding: 'utf8', timeout: 10000, windowsHide: true });
  assert.equal(result.status, 0, result.stderr);
});
test('portable scaffold config and all synthetic example records remain valid', () => {
  validateRecord(JSON.parse(readFileSync('scaffold/configuration.template.json')), 'configuration');
  validateRecord(JSON.parse(readFileSync('scaffold/example-flows.json')), 'examples');
});
test('dependency fingerprint rejects chained links that resolve outside the workspace', t => {
  const root = mkdtempSync(join(tmpdir(), 'dependency-fingerprint-test-'));
  const workspace = join(root, 'workspace');
  const outside = join(root, 'outside');
  mkdirSync(join(workspace, 'node_modules'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, 'package.js'), 'external\n');
  symlinkSync(outside, join(workspace, 'bridge'),
    process.platform === 'win32' ? 'junction' : 'dir');
  symlinkSync(join(workspace, 'bridge'), join(workspace, 'node_modules', 'package'),
    process.platform === 'win32' ? 'junction' : 'dir');
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(outputPathFingerprint(workspace, 'node_modules'), null);
});
test('worker-result audit fields and validation attempt metadata are mandatory', () => {
  const examples = JSON.parse(readFileSync('scaffold/example-flows.json'));
  const result = examples.records.find(record => record.recordType === 'workerResult');
  for (const field of ['validationAttempts', 'toolUsage', 'skillExecution']) {
    const invalid = structuredClone(result);
    delete invalid[field];
    assert.throws(() => validateRecord(invalid, 'workerResult'), /workerResult/);
  }
  for (const field of ['attemptCount', 'blockedReason']) {
    const invalid = structuredClone(result);
    delete invalid.validation[0][field];
    assert.throws(() => validateRecord(invalid, 'workerResult'), /workerResult/);
  }
});
test('worker-result validation permits an authentication blocker', () => {
  const examples = JSON.parse(readFileSync('scaffold/example-flows.json'));
  const result = structuredClone(
    examples.records.find(record => record.recordType === 'workerResult'));
  result.outcome = 'blocked';
  result.validation[0].status = 'blocked';
  result.validation[0].blockedReason = 'blocked-auth';
  result.validation[0].nextCheckAt = null;
  result.validationAttempts[0].validation = structuredClone(result.validation);
  result.draftPR = null;
  result.blocker = {
    owner: 'synthetic-worker',
    reason: 'Authentication is required',
    unblockCondition: 'Refresh approved validation authentication'
  };
  validateRecord(result, 'workerResult');
});
test('portable example uses a fixed UTC fixture window and leaves live permissions unapproved', () => {
  const config = configAt('pilot.example.json');
  assert.deepEqual(config.window, { start: '2026-10-08T00:00:00Z', end: '2026-10-09T00:00:00Z' });
  assert.deepEqual(config.activation, { collect: false, review: false, dispatch: false });
  assert.equal(config.schedule.enabled, false);
  assert.equal(config.statePolicy.accessApproved, false);
  assert.ok(Object.values(config.sources).every(s => !s.enabled && !s.scopeApproved));
  assert.ok(config.repositories.every(r => !r.projectId && !r.referenceCheckout && !r.routingApproved));
  assert.ok(config.repositories.every(r => proposerExecutorFlight(r) === 'local'));
  assert.match(config.identity.designatedUser, /@example\.invalid$/);
  assert.equal(config.limits.maxValidationRepairRounds, 10);
});
test('validation repair budget defaults to ten and rejects larger values', t => {
  const root = mkdtempSync(join(tmpdir(), 'repair-budget-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync('pilot.example.json'));
  delete config.limits.maxValidationRepairRounds;
  const configPath = join(root, 'pilot.json');
  writeFileSync(configPath, JSON.stringify(config));
  assert.equal(configAt(configPath).limits.maxValidationRepairRounds, 10);
  config.limits.maxValidationRepairRounds = 11;
  writeFileSync(configPath, JSON.stringify(config));
  assert.throws(() => configAt(configPath), /must not exceed 10/);
});
test('Draft build configuration is explicit, ADO-only and bounded to one definition', t => {
  const root = mkdtempSync(join(tmpdir(), 'draft-build-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync('pilot.example.json'));
  const repo = config.repositories.find(item => item.id === '1js');
  const configPath = join(root, 'pilot.json');
  repo.draftBuild.enabled = true;
  repo.pr.targetRef = 'refs/heads/main';
  writeFileSync(configPath, JSON.stringify(config));
  assert.deepEqual(configAt(configPath).repositories.find(item => item.id === '1js').draftBuild, {
    enabled: true,
    provider: 'ado',
    id: '1js-pipeline-36540',
    definitionId: 36540,
    templateParameters: {}
  });
  for (const invalid of [
    { enabled: true, provider: 'github', id: 'build', definitionId: 1 },
    { enabled: true, provider: 'ado', id: '../build', definitionId: 1 },
    { enabled: true, provider: 'ado', id: 'build', definitionId: 0 },
    { enabled: true, provider: 'ado', id: 'build', definitionId: 1,
      templateParameters: { 'bad key': 'value' } },
    { enabled: true, provider: 'ado', id: 'build', definitionId: 1,
      templateParameters: { account: { secret: true } } },
    { enabled: true, provider: 'ado', id: 'build', definitionId: 1,
      templateParameters: { newCaseSelection: '{}' } },
    { enabled: true, provider: 'ado', id: 'build', definitionId: 1,
      templateParameters: { newCaseGroups: 'excelAgentDeclarative' } }
  ]) {
    repo.draftBuild = invalid;
    writeFileSync(configPath, JSON.stringify(config));
    assert.throws(() => configAt(configPath),
      /invalid Draft build configuration|new-case build parameters are controller-owned/);
  }
});
test('OfficeAgent Excel validation profile converts selectors to package-relative paths', () => {
  const profile = readFileSync('scripts/validation/office-agent-excel-entry-model.ps1', 'utf8');
  assert.match(profile, /PILOT_VALIDATION_BASE_REVISION/);
  assert.match(profile, /git diff --name-only "\$baseRevision\.\.HEAD" -- 'agents\/office-agent\/tests\/integration/);
  assert.match(profile, /\^agents\/office-agent\/\(tests\/integration\/\.\+\\\.test\\\.ts\)\$/);
  assert.match(profile, /Join-Path 'agents\\office-agent' \$test/);
  assert.match(profile, /PILOT_VALIDATION_PROFILE_ERROR:/);
  assert.doesNotMatch(profile,
    /--runTestsByPath\s+agents\/office-agent\/tests\/integration/);
});
test('executor flights validate exact backend choices and preserve omitted legacy configuration', t => {
  const { root } = setup(t);
  const config = JSON.parse(readFileSync('pilot.example.json'));
  const repo = config.repositories.find(r => r.id === 'office-agent');
  const configPath = join(root, 'flight-config.json');
  for (const executor of ['local', 'agency']) {
    repo.flights = { proposerExecutor: executor };
    writeFileSync(configPath, json(config));
    const loaded = configAt(configPath);
    assert.equal(proposerExecutorFlight(loaded.repositories.find(r => r.id === 'office-agent')), executor);
    assert.equal(proposerExecutorFlight(loaded.repositories.find(r => r.id === '1js')), 'local');
    assert.deepEqual(loaded.activation, { collect: false, review: false, dispatch: false });
  }
  const doctor = spawnSync(process.execPath, ['src/cli.js', 'doctor', '--config', configPath],
    { encoding: 'utf8' });
  assert.equal(doctor.status, 0, doctor.stderr);
  assert.deepEqual(JSON.parse(doctor.stdout).proposerExecutors.find(r => r.repoId === 'office-agent'),
    { repoId: 'office-agent', selection: 'agency', readinessVerified: false });
  for (const flights of [null, false, [], {}, { proposerExecutor: null },
    { proposerExecutor: 'hosted' }, { proposerExecutor: true },
    { proposerExecutor: 'agency', fallback: 'local' }, { proposerExecuter: 'agency' }]) {
    repo.flights = flights;
    writeFileSync(configPath, json(config));
    assert.throws(() => configAt(configPath), /executorFlights/);
    assert.throws(() => proposerExecutorFlight(repo), /executorFlights/);
  }
  delete repo.flights;
  writeFileSync(configPath, json(config));
  assert.equal(proposerExecutorFlight(configAt(configPath).repositories.find(r => r.id === 'office-agent')), null);
});
test('configuration resolves and content-binds relative validation profiles', t => {
  const root = mkdtempSync(join(tmpdir(), 'profile-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = 'Write-Output profile';
  const profilePath = join(root, 'scripts', 'validation', 'profile.ps1');
  mkdirSync(join(root, 'scripts', 'validation'), { recursive: true });
  writeFileSync(profilePath, profile);
  const config = JSON.parse(readFileSync('pilot.example.json'));
  const gate = {
    id: 'profiled', approved: false, isolationVerified: false,
    profilePath: 'scripts/validation/profile.ps1', profileSha256: hash(profile),
    executable: null, args: ['-File', '{profile}'], timeoutMs: 10000
  };
  config.repositories.find(repo => repo.id === 'office-agent').validationGates.push(gate);
  const configPath = join(root, 'pilot.json');
  writeFileSync(configPath, JSON.stringify(config));

  const loaded = configAt(configPath);
  assert.equal(loaded.repositories.find(repo => repo.id === 'office-agent')
    .validationGates[0].profilePath, profilePath);

  gate.profileSha256 = '0'.repeat(64);
  writeFileSync(configPath, JSON.stringify(config));
  assert.throws(() => configAt(configPath), /profile hash mismatch/);

  delete gate.profileSha256;
  writeFileSync(configPath, JSON.stringify(config));
  assert.throws(() => configAt(configPath), /bind profilePath and profileSha256 together/);
});

test('package authentication configuration is explicit, value-free and contract-bound', t => {
  const { root } = setup(t);
  const config = JSON.parse(readFileSync('pilot.example.json'));
  const repo = config.repositories[0];
  const gate = { id: 'auth-config', args: [], timeoutMs: 1000 };
  repo.validationGates = [gate];
  const originalContract = repositoryValidationContract(repo);
  const configPath = join(root, 'auth-config.json');
  gate.packageAuth = { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN' };
  writeFileSync(configPath, json(config));
  assert.deepEqual(configAt(configPath).repositories[0].validationGates[0].packageAuth,
    gate.packageAuth);
  assert.notEqual(repositoryValidationContract(repo).sha256, originalContract.sha256);
  for (const invalid of [null, false, [], {}, { kind: 'azure-cli' },
    { kind: 'yarn-token', tokenEnvironmentVariable: 'PATH' },
    { kind: 'yarn-token', tokenEnvironmentVariable: 'YARN_NPM_AUTH_TOKEN' },
    { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN', token: 'secret' }]) {
    gate.packageAuth = invalid;
    writeFileSync(configPath, json(config));
    assert.throws(() => configAt(configPath), /Validation packageAuth/);
    assert.throws(() => repositoryValidationContract(repo), /Validation packageAuth/);
  }
  delete gate.packageAuth;
  assert.deepEqual(repositoryValidationContract(repo), originalContract);
});
test('worker writes honor exact files without broadening directory prefixes', t => {
  const { root, config } = setup(t);
  const repo = repoConfig(config, root);
  repo.allowedWritePrefixes = [];
  repo.allowedWriteFiles = ['config/allowed.yaml'];
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, 'config'), { recursive: true });
  const assignment = {
    repoId: repo.id,
    permissions: { editCode: true },
    bounds: { maxToolCalls: 3 }
  };
  const tools = new WorkerTools(config, assignment, workspace);
  assert.equal(tools.write('config\\allowed.yaml', 'allowed\n'), 'written');
  assert.throws(() => tools.write('config\\other.yaml', 'blocked\n'), /approved edit bounds/);
});
test('ADO WIQL preserves full area and distinct created/changed lanes', () => {
  const window = configAt('pilot.example.json').window;
  assert.match(wiql(window), /\[System.CreatedDate\]/);
  assert.match(wiql(window, 'changed'), /\[System.ChangedDate\]/);
  assert.ok(wiql(window).includes(`UNDER '${area}'`));
  assert.match(wiql(window), /\[System.State\] IN \('Resolved', 'Closed'\)/);
  assert.match(wiql(window), /\[Microsoft.VSTS.Common.ResolvedReason\] IN \('Fixed', 'Duplicate'\)/);
  assert.doesNotMatch(wiql(window), /Bug Bash|Automation/);
  assert.throws(() => wiql({ start: '2026-10-08', end: window.end }));
});
test('ADO batches at most 200, pins snapshot, distinguishes missing fields and retains revisions', async t => {
  const { config } = setup(t), calls = [], evidence = [];
  await collectAdo(config, config.window, async e => evidence.push(e), 'created',
    transport(Array.from({ length: 201 }, (_, i) => adoItem(i + 1)), calls));
  const batches = calls.filter(c => c.endpoint === 'workitemsbatch');
  assert.deepEqual(batches.map(c => c.body.ids.length), [200, 1]);
  assert.ok(batches.every(c => c.body.asOf === '2026-10-09T01:00:00Z' && c.body.errorPolicy === 'Fail'));
  assert.equal(evidence.length, 201);
  assert.equal(evidence[0].source.revision, '1');
  assert.ok(evidence[0].missingFields.includes('Office.Common.IcMID'));
  assert.equal(evidence[0].discoveryChannel, 'unknown');
});
test('ADO missing batches fail instead of treating omissions as empty success', async t => {
  const { config } = setup(t), real = transport([adoItem()]);
  await assert.rejects(collectAdo(config, config.window, async () => {}, 'created',
    (endpoint, body) => endpoint === 'workitemsbatch' ? { value: [] } : real(endpoint, body)), /missing/);
});
test('ADO out-of-scope area rejected before evidence acceptance', async t => {
  const { config } = setup(t), item = adoItem();
  item.fields['System.AreaPath'] = `${area}Unrelated`;
  await assert.rejects(collectAdo(config, config.window, async () => {}, 'created', transport([item])), /out-of-scope/);
});
test('ADO budget exhaustion is explicit and does not silently truncate', async t => {
  const { config } = setup(t), evidence = [], calls = []; config.limits.maxItems = 1;
  await assert.rejects(collectAdo(config, config.window, async e => evidence.push(e), 'created',
    transport([adoItem(1), adoItem(2)], calls)),
    e => e.code === 'partial');
  assert.deepEqual(evidence.map(e => e.source.recordId), ['1']);
  assert.deepEqual(calls.at(-1).body.ids, [1]);
});
for (const lane of ['created', 'changed']) for (const count of [0, 49, 50, 62, 251]) {
  test(`ADO ${lane} hydrates the permitted prefix for ${count} IDs without expanding budgets`, async t => {
    const { config } = setup(t), evidence = [], calls = [];
    config.limits.maxItems = count === 251 ? 250 : 50;
    const pending = collectAdo(config, config.window, async e => evidence.push(e), lane,
      transport(Array.from({ length: count }, (_, i) => adoItem(i + 1)), calls));
    if (count > config.limits.maxItems) await assert.rejects(pending, e => e.code === 'partial');
    else assert.equal((await pending).end, config.window.end);
    const expected = Math.min(count, config.limits.maxItems);
    assert.deepEqual(evidence.map(e => Number(e.source.recordId)), Array.from({ length: expected }, (_, i) => i + 1));
    assert.equal(calls.length, 2 + Math.ceil(expected / 200));
    assert.equal(calls[1].body.query, wiql(config.window, lane, '2026-10-09T01:00:00Z'));
    assert.ok(calls.slice(2).every(c => c.body.ids.length <= 200 &&
      c.body.asOf === '2026-10-09T01:00:00Z' && c.body.errorPolicy === 'Fail'));
  });
}
test('ADO permitted selection does not bypass call exhaustion', async t => {
  const { config } = setup(t), calls = [], evidence = [];
  config.limits.maxItems = 50; config.limits.maxCalls = 2;
  await assert.rejects(collectAdo(config, config.window, async e => evidence.push(e), 'changed',
    transport(Array.from({ length: 62 }, (_, i) => adoItem(i + 1)), calls)), /Tool-call budget/);
  assert.equal(calls.length, 2);
  assert.equal(evidence.length, 0);
});
test('ADO split windows share the item budget and skip previously hydrated IDs', async t => {
  const { config } = setup(t), calls = [], evidence = [];
  config.limits.maxItems = 3;
  const items = Array.from({ length: 4 }, (_, i) => adoItem(i + 1));
  for (const item of items.slice(2)) item.fields['System.CreatedDate'] = '2026-10-08T13:00:00Z';
  let queryCount = 0;
  const request = async (endpoint, body) => {
    calls.push({ endpoint, body });
    if (endpoint === 'workitemsbatch') return { value: items.filter(i => body.ids.includes(i.id)) };
    if (++queryCount === 2) throw new PilotError('query-limit', 'synthetic query limit');
    return { asOf: '2026-10-09T01:00:00Z',
      workItems: (queryCount === 1 ? [] : queryCount === 3 ? [1, 1, 2] : [2, 3, 4]).map(id => ({ id })) };
  };
  await assert.rejects(collectAdo(config, config.window, async e => evidence.push(e), 'created', request),
    e => e.code === 'partial');
  assert.deepEqual(evidence.map(e => e.source.recordId), ['1', '2', '3']);
  assert.deepEqual(calls.filter(c => c.endpoint === 'workitemsbatch').map(c => c.body.ids), [[1, 2], [3]]);
  assert.equal(calls.length, 6);
  assert.ok(calls.filter(c => c.endpoint === 'wiql').slice(1)
    .every(c => c.body.query.includes("ASOF '2026-10-09T01:00:00Z'")));
});
test('ADO limit splits the half-open window at one stable asOf', async t => {
  const { config } = setup(t);
  const calls = [];
  let enumerations = 0;
  const request = async (endpoint, body) => {
    calls.push(body.query);
    if (body.query.includes('[System.Id] = 0')) return { asOf: '2026-10-09T01:00:00Z', workItems: [] };
    if (++enumerations === 1) throw new PilotError('query-limit', 'limit');
    return { asOf: '2026-10-09T01:00:00Z', workItems: [] };
  };
  await collectAdo(config, config.window, async () => {}, 'created', request);
  assert.equal(calls.length, 4);
  assert.ok(calls[2].includes('2026-10-08T12:00:00.000Z'));
  assert.ok(calls[3].includes('2026-10-08T12:00:00.000Z'));
  assert.ok(calls.slice(1).every(q => q.includes("ASOF '2026-10-09T01:00:00Z'")));
});
test('partial source capture is durable, keeps cursor and deduplicates on replay', async t => {
  const { config, ledger } = setup(t);
  const adapter = async (c, window, emit) => {
    const record = evidenceEnvelope('ado', 'office/OC', 1, '1', 'https://example.invalid/1', 'synthetic', now());
    record.source.provenance = 'synthetic';
    await emit(record, { raw: 'fixture' });
    throw new PilotError('blocked-auth', 'Synthetic expired sign-in');
  };
  const result = await collect(config, ledger, { adapters: { ado: adapter } });
  assert.equal(result[0].state, 'blocked-auth');
  assert.equal(ledger.cursor('ado:created'), null);
  const skipped = await collect(config, ledger, { adapters: { ado: adapter } });
  assert.equal(skipped[0].state, 'blocked');
  assert.equal(ledger.status().runs.length, 1);
  ledger.unblockSource('ado:created', 'Synthetic reauthentication confirmed');
  ledger.unblockSource('auth:ado', 'Synthetic reauthentication confirmed');
  await collect(config, ledger, { adapters: { ado: adapter } });
  assert.equal(ledger.all('evidence').length, 1);
  assert.equal(ledger.db.prepare('SELECT COUNT(*) AS n FROM observations').get().n, 2);
});
test('complete source cursor survives a fresh database connection', async t => {
  const { config, ledger } = setup(t);
  await collect(config, ledger, { adapters: { ado: async () => ({ end: config.window.end }) } });
  const reopened = new Ledger(config.stateDirectory);
  try { assert.equal(reopened.cursor('ado:created').end, config.window.end); } finally { reopened.close(); }
});
test('immutable evidence retains both revision versions and actual capture byte hashes', t => {
  const { ledger } = setup(t);
  const first = addEvidence(ledger), second = addEvidence(ledger, '1', '2', { text: 'changed' });
  assert.notEqual(first.id, second.id);
  const bytes = ledger.db.prepare('SELECT body FROM captures WHERE hash=?').get(first.capture.sha256).body;
  assert.equal(hash(bytes), first.capture.sha256);
  assert.throws(() => ledger.db.prepare("UPDATE records SET body='{}'").run(), /immutable/);
  assert.throws(() => ledger.put({ ...first, title: 'changed' }), /Immutable/);
});
test('older ADO revision does not replace newer evidence on a later historical read', t => {
  const { ledger } = setup(t);
  const newest = addEvidence(ledger, '1', '2');
  addEvidence(ledger, '1', '1', { historical: true });
  assert.equal(latestEvidence(ledger)[0].id, newest.id);
});
test('atomic ownership rejects another connection and wrong release token', t => {
  const { config, ledger } = setup(t), other = new Ledger(config.stateDirectory);
  try {
    const owner = ledger.acquire('collection');
    assert.throws(() => other.acquire('collection'), e => e.code === 'overlap');
    other.release('collection', 'wrong');
    assert.throws(() => other.acquire('collection'));
    ledger.release('collection', owner);
    const token = other.acquire('collection'); other.release('collection', token);
  } finally { other.close(); }
});
test('live process lock cannot be recovered even with exact owner', t => {
  const { ledger } = setup(t), owner = ledger.acquire('collection');
  assert.throws(() => ledger.recoverLock('collection', owner), /still present/);
  ledger.release('collection', owner);
});
test('owner lock remains exclusive in a separate process', t => {
  const { ledger, config } = setup(t), owner = ledger.acquire('collection');
  const script = `import {Ledger} from './src/ledger.js'; const l=new Ledger(${json(config.stateDirectory)}); try{l.acquire('collection');process.exitCode=5}catch(e){process.stdout.write(e.code)}finally{l.close()}`;
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  assert.equal(result.status, 0); assert.equal(result.stdout, 'overlap');
  ledger.release('collection', owner);
});
test('WorkIQ only accepts exact selected entity paths, never tenant-wide search', () => {
  const valid = { id: 'seed', path: '/teams/team/channels/channel/messages/message?$select=id,body', url: 'https://teams.microsoft.com/message' };
  assert.equal(validateSeed(valid), valid);
  for (const path of ['/me/messages?$select=id', '/me/messages/one?$expand=attachments&$select=id',
    '/teams/team/channels/channel/messages/../members?$select=id', 'https://graph.microsoft.com/me/messages/one?$select=id',
    '/me/messages/%2fsecret?$select=id', '/me/messages/one?$select=id&$top=50']) {
    assert.throws(() => validateSeed({ ...valid, path }));
  }
});
test('empty WorkIQ seeds block instead of broadening', async t => {
  const { config } = setup(t); config.sources.workiq.scopeApproved = true; config.sources.workiq.identityConfirmed = true;
  let called = false;
  await assert.rejects(collectWorkiq(config, config.window, async () => {}, async () => { called = true; }), /no approved/);
  assert.equal(called, false);
});
test('WorkIQ captures only configured seeds and labels current-snapshot coverage', async t => {
  const { config } = setup(t);
  config.sources.workiq = { enabled: true, scopeApproved: true, identityConfirmed: true,
    seeds: [{ id: 'seed', path: '/me/messages/id?$select=id,body', url: 'https://outlook.office.com/mail/id' }] };
  const captured = [];
  const cursor = await collectWorkiq(config, config.window, async (e, payload) => captured.push({ e, payload }),
    async path => path === principalPath ? { id: config.identity.objectId, userPrincipalName: config.identity.designatedUser }
      : { entity: { id: 'seed' }, synthetic: true });
  assert.equal(captured.length, 1); assert.equal(cursor.coverage[0].kind, 'exact-seed-snapshot-only');
  assert.equal(captured[0].e.source.revision, null);
});
test('IcM has an explicit unverified-query/connector blocker', async t => {
  const { config } = setup(t);
  await assert.rejects(collectIcm(config, config.window, async () => {}), /not verified/);
  config.sources.icm.scopeApproved = true; config.sources.icm.filtersVerified = true;
  await assert.rejects(collectIcm(config, config.window, async () => {}), /No supported authenticated/);
});
test('IcM incident-created selection is opt-in and cannot reuse the saved-query export adapter', async t => {
  const { config, root } = setup(t);
  assert.equal(config.sources.icm.timestampContract, null);
  const file = join(root, 'icm-config.json');
  delete config.sources.icm.timestampContract;
  writeFileSync(file, json(config));
  assert.equal(configAt(file).sources.icm.timestampContract, undefined);
  config.sources.icm.timestampContract = 'incident-created';
  writeFileSync(file, json(config));
  assert.equal(configAt(file).sources.icm.timestampContract, 'incident-created');
  await assert.rejects(collectIcm(config, config.window, async () => {}), /use app-append/);
  config.sources.icm.timestampContract = 'sourceCreateTime';
  writeFileSync(file, json(config));
  assert.throws(() => configAt(file), /timestampContract/);
});
test('IcM owner export cannot masquerade as authenticated collection', async t => {
  const { config, root } = setup(t);
  const record = evidenceEnvelope('icm', 'icm/query/599514', 1, null, 'https://portal.microsofticm.com/imp/v5/incidents/details/1', '599514');
  record.createdAt = '2026-10-08T01:00:00Z';
  const file = join(root, 'icm.json');
  config.sources.icm = { enabled: true, scopeApproved: true, filtersVerified: true, queryId: '599514', ownerExport: file };
  writeFileSync(file, json({ queryId: '599514', window: config.window, evidence: [record] }));
  await assert.rejects(collectIcm(config, config.window, async () => {}), /owner-confirmed/);
  record.source.provenance = 'owner-provided';
  record.source.ownerConfirmation = { confirmedBy: 'synthetic-owner', confirmedAt: now(), confirmedScope: 'icm/query/599514' };
  writeFileSync(file, json({ queryId: '599514', window: config.window, evidence: [record] }));
  let captured;
  const cursor = await collectIcm(config, config.window, async e => { captured = e; });
  assert.equal(captured.source.provenance, 'owner-provided'); assert.equal(cursor.coverage, 'owner-export-only');
});
test('review requires configured method, stable identity and full exclusion checklist', t => {
  const { config, ledger } = setup(t), e = addEvidence(ledger), r = review(e);
  assert.throws(() => acceptReview(config, ledger, { investigation: r, exclusionsChecked: [] }), /All scanner exclusions/);
  assert.throws(() => acceptReview(config, ledger, { investigation: { ...r, id: 'random' }, exclusionsChecked: exclusions }), /identity/);
  const wrong = structuredClone(r); wrong.review.method = 'agent-evidence-review';
  assert.throws(() => acceptReview(config, ledger, { investigation: wrong, exclusionsChecked: exclusions }), /method/);
  assert.equal(acceptReview(config, ledger, { investigation: r, exclusionsChecked: exclusions }).defectConfirmation, 'unconfirmed');
  assert.throws(() => acceptReview(config, ledger, { investigation: r, exclusionsChecked: exclusions }), /version/);
});
test('superseded evidence cannot be reviewed using an old version', t => {
  const { config, ledger } = setup(t), e = addEvidence(ledger);
  addEvidence(ledger, '1', '2', { changed: true });
  assert.throws(() => acceptReview(config, ledger, { investigation: review(e), exclusionsChecked: exclusions }), /superseded/);
});
for (const exclusion of exclusions) {
  test(`both defect and improvement handoffs enforce ${exclusion}`, t => {
    const { config, ledger, root } = setup(t), repo = repoConfig(config, root), r = review(addEvidence(ledger));
    r.repoIds = [repo.id]; r.exclusionReasons = [exclusion]; r.handoffEligibility = 'excluded'; r.reportEligibility = 'excluded';
    for (const intent of ['defect-fix', 'improvement']) assert.throws(() => makeAssignment(config, r, repo.id, intent), /Excluded/);
  });
}
test('report distinguishes source candidates, eligibility and code-defect confirmation', t => {
  const { config, ledger } = setup(t), e = addEvidence(ledger);
  acceptReview(config, ledger, { investigation: review(e), exclusionsChecked: exclusions });
  const result = report(ledger);
  assert.equal(result.summary.functionalIds.length, 1);
  assert.equal(result.summary.confirmedCodeDefectIds.length, 0);
  assert.equal(result.issues[0].source.provenance, 'synthetic');
});
test('assignment prepare is idempotent and newer review cannot launch duplicate work', async t => {
  const { config, ledger, assignment, investigation, repo } = await fixture(t);
  const first = ledger.prepare(assignment), second = ledger.prepare(assignment);
  assert.equal(first.session_id, second.session_id);
  repo.validationGates = [{ id: 'source-test', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 1000 }];
  const differentIntent = makeAssignment(config, investigation, repo.id, 'defect-fix');
  assert.notEqual(differentIntent.id, assignment.id);
  assert.throws(() => ledger.prepare(differentIntent), /different execution semantics/);
  const newer = { ...investigation, version: 2 };
  assert.throws(() => ledger.prepare(makeAssignment(config, newer, repo.id, 'rca-only')), /Prior assignment/);
});
test('crash after prepared dispatch is reconciled, not automatically reset to prepared', async t => {
  const { ledger, job } = await fixture(t);
  ledger.moveJob(job.id, 'prepared', 'dispatching');
  const pending = reconcile(ledger).jobs[0];
  assert.equal(pending.state, 'dispatching'); assert.match(pending.nextAction, /never relaunch/);
});
test('provisioning uses separate clone without hardlinked objects or primary changes', async t => {
  const { config, job, repo, g } = await fixture(t);
  const before = (await g(['rev-parse', 'HEAD'])).stdout;
  const result = await provision(config, job, repo);
  assert.notEqual(result.workspace, repo.referenceCheckout);
  assert.equal(existsSync(`${result.workspace}.provisioning`), false);
  assert.equal((await g(['status', '--porcelain'])).stdout, '');
  assert.equal((await g(['rev-parse', 'HEAD'])).stdout, before);
  assert.equal(readFileSync(join(result.workspace, 'src', 'value.js'), 'utf8').replaceAll('\r\n', '\n'), 'export const value = 1;\n');
  await assert.rejects(provision(config, job, repo), /already exists/);
});
test('provisioning retains and identifies an incomplete staged workspace without publishing it', async t => {
  const { config, job, repo, g } = await fixture(t);
  const workspace = join(config.stateDirectory, 'workspaces', job.session_id);
  const baseRevision = (await g(['rev-parse', 'HEAD'])).stdout.trim();
  await assert.rejects(provision(config, job, repo, {
    baseRevision,
    qualificationSource: 'trusted-remote'
  }, {
    fetchQualifiedRevision: async () => { throw new Error('synthetic fetch failure'); }
  }), error => {
    assert.equal(error.code, 'blocked-provision');
    assert.match(error.message, /qualified-revision-fetch/);
    assert.match(error.message, /\.provisioning/);
    assert.doesNotMatch(error.message, /synthetic fetch failure/);
    return true;
  });
  assert.equal(existsSync(workspace), false);
  assert.equal(existsSync(`${workspace}.provisioning`), true);
  await assert.rejects(provision(config, job, repo), /Incomplete workspace provisioning exists/);
});
test('Windows provisioned authoring checkout supports native Git long paths without changing the reference', {
  skip: process.platform !== 'win32'
}, async t => {
  const { config, job, repo } = await fixture(t);
  const { path } = await longPathFixture(repo.referenceCheckout);
  const referenceConfig = readFileSync(join(repo.referenceCheckout, '.git', 'config'), 'utf8');
  const { workspace, baseRevision } = await provision(config, job, repo);
  assert.ok(join(workspace, path).length > 260);
  assert.equal((await command('git', ['config', '--local', '--get', 'core.longpaths'],
    workspace)).stdout.trim(), 'true');
  const source = await command('git', ['show', `${baseRevision}:${path.replaceAll('\\', '/')}`],
    workspace);
  assert.equal(source.stdout, 'export const value = 1;\n');
  assert.equal(readFileSync(join(repo.referenceCheckout, '.git', 'config'), 'utf8'), referenceConfig);
});
test('repository provisioning timeout must be a positive integer', async t => {
  const { config, repo } = await fixture(t);
  repo.provisionTimeoutMs = 0;
  assert.throws(() => repoFor(config, repo.id), /provisionTimeoutMs must be a positive integer/);
  repo.provisionTimeoutMs = 900000;
  assert.equal(repoFor(config, repo.id).provisionTimeoutMs, 900000);
});
test('sparse provisioning materializes configured directories and keeps bounded listings', async t => {
  const { config, job, repo, assignment, g } = await fixture(t);
  mkdirSync(join(repo.referenceCheckout, 'unrelated'), { recursive: true });
  writeFileSync(join(repo.referenceCheckout, 'unrelated', 'large.js'), 'export const unrelated = true;\n');
  await g(['add', '.']);
  await g(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Add unrelated fixture']);
  repo.sparseCheckoutPaths = ['src'];
  const { workspace } = await provision(config, job, repo);
  assert.equal(existsSync(join(workspace, 'src', 'value.js')), true);
  assert.equal(existsSync(join(workspace, 'unrelated', 'large.js')), false);
  const tools = new WorkerTools(config, assignment, workspace);
  assert.equal((await tools.list()).includes('src/value.js'), true);
});
test('trusted qualification fetches its exact revision before isolated checkout', async t => {
  const { config, job, repo, g } = await fixture(t);
  const revision = (await g(['rev-parse', 'HEAD'])).stdout.trim();
  let fetched = null;
  const result = await provision(config, job, repo, {
    baseRevision: revision,
    qualificationSource: 'trusted-remote'
  }, {
    fetchQualifiedRevision: async (currentConfig, workspace, currentRepo, exactRevision,
      getToken, timeout) => {
      fetched = { workspace, repo: currentRepo.id, exactRevision, timeout };
    }
  });
  assert.equal(fetched.repo, repo.id);
  assert.equal(fetched.exactRevision, revision);
  assert.equal(fetched.timeout, 120000);
  assert.equal((await command('git', ['rev-parse', 'HEAD'], result.workspace)).stdout.trim(), revision);
});
test('provisioning skips unrelated Git LFS smudges without mutating the controller environment', () => {
  const original = process.env.GIT_LFS_SKIP_SMUDGE;
  const env = checkoutEnvironment();
  assert.equal(env.GIT_LFS_SKIP_SMUDGE, '1');
  assert.equal(process.env.GIT_LFS_SKIP_SMUDGE, original);
});
test('worker file callbacks reject traversal, alternate streams, protected paths and links', async t => {
  const { config, job, repo, assignment, root } = await fixture(t);
  const { workspace } = await provision(config, job, repo);
  const editable = structuredClone(assignment); editable.permissions.editCode = true;
  const tools = new WorkerTools(config, editable, workspace);
  for (const path of ['..\\outside', '.git\\config', 'src\\x:stream', 'src\\..\\..\\outside', 'src\\..\\README.md']) assert.throws(() => tools.write(path, 'bad'));
  assert.throws(() => tools.write('other\\value.js', 'bad'), /edit bounds/);
  mkdirSync(join(root, 'outside'));
  symlinkSync(join(root, 'outside'), join(workspace, 'src', 'linked'), process.platform === 'win32' ? 'junction' : 'dir');
  assert.throws(() => tools.write('src\\linked\\value.js', 'bad'), /Symlink/);
  tools.write('src\\new.js', 'export const value = 2;');
  assert.ok(existsSync(join(workspace, 'src', 'new.js')));
  assert.ok(!existsSync(join(repo.referenceCheckout, 'src', 'new.js')));
  assert.match(tools.read('src\\value.js', 1, 1), /value = 1/);
  assert.ok((await tools.search('value = 1', 'src')).some(match =>
    match.includes('src/value.js')));
  assert.deepEqual(await tools.list('src'), ['src/value.js']);
  mkdirSync(join(workspace, 'docs'));
  writeFileSync(join(workspace, 'docs', 'value.js'), 'export const documented = true;\r\n');
  await command('git', ['add', 'docs/value.js'], workspace);
  const boundedConfig = structuredClone(config);
  boundedConfig.limits.maxFileBytes = 12;
  const boundedTools = new WorkerTools(boundedConfig, editable, workspace);
  await assert.rejects(boundedTools.list(), /narrow pilot_list/);
  assert.deepEqual(await boundedTools.list('src'), ['src/value.js']);
  const surgicalEdit = tools.tools().find(tool => tool.name === 'pilot_replace_lines');
  assert.ok(surgicalEdit, 'The real SDK toolset must expose the surgical editor');
  await surgicalEdit.handler({ path: 'src\\value.js', startLine: 1, endLine: 1,
    expected: 'export const value = 1;', replacement: 'export const value = 3;' });
  assert.equal(tools.read('src\\value.js', 1, 1), 'export const value = 3;');
  assert.throws(() => tools.replaceLines('src\\value.js', 1, 1,
    'export const value = 1;', 'bad'), /does not match/);
  tools.allowedWritePrefixes = ['src/value.js'];
  tools.replaceLines('src\\value.js', 1, 1,
    'export const value = 3;', 'export const value = 4;');
  assert.equal(tools.read('src\\value.js', 1, 1), 'export const value = 4;');
  assert.throws(() => tools.write('src\\another.js', 'bad'), /bounds/);
  assert.equal((await tools.search('value = 1', 'src')).some(match =>
    match.includes('src/value.js')), false);
});
test('model-visible worker contract exposes bounded surgical edits', async t => {
  const { config, job, repo, assignment } = await fixture(t);
  const { workspace } = await provision(config, job, repo);
  const editable = structuredClone(assignment);
  editable.permissions.editCode = true;
  const tools = new WorkerTools(config, editable, workspace);
  const exposedPatch = tools.tools().find(tool => tool.name === 'pilot_replace_lines');
  assert.ok(exposedPatch, 'The model-visible tool contract must expose surgical edits');
  assert.equal(exposedPatch.parameters.additionalProperties, false);
  assert.deepEqual(exposedPatch.parameters.required,
    ['path', 'startLine', 'endLine', 'expected', 'replacement']);
  await exposedPatch.handler({
    path: 'src\\value.js', startLine: 1, endLine: 1,
    expected: 'export const value = 1;', replacement: 'export const value = 2;'
  });
  assert.equal(tools.read('src\\value.js', 1, 1), 'export const value = 2;');
  await assert.rejects(async () => exposedPatch.handler({
    path: 'other\\value.js', startLine: 1, endLine: 1, expected: '', replacement: 'bad'
  }), /edit bounds/);
  await assert.rejects(async () => exposedPatch.handler({
    path: 'src\\value.js', startLine: 1, endLine: 1,
    expected: 'export const value = 1;', replacement: 'bad'
  }), /does not match/);
  await assert.rejects(async () => exposedPatch.handler({
    path: 'src\\value.js', startLine: 1, endLine: 501, expected: '', replacement: 'bad'
  }), /at most 500 lines/);
  assert.equal(tools.read('src\\value.js', 1, 1), 'export const value = 2;');
  assert.equal(tools.usage.byTool.pilot_replace_lines, 4);
});
test('RCA-only workers cannot write and submitted workers cannot keep editing', async t => {
  const { config, assignment, job, repo } = await fixture(t);
  const { workspace } = await provision(config, job, repo);
  const tools = new WorkerTools(config, assignment, workspace);
  assert.throws(() => tools.write('src\\value.js', 'bad'), /not permitted/);
  await assert.rejects(async () =>
    tools.tools().find(tool => tool.name === 'pilot_replace_lines').handler({
      path: 'src\\value.js', startLine: 1, endLine: 1,
      expected: 'export const value = 1;', replacement: 'bad'
    }), /not permitted/);
  tools.finish({ outcome: 'investigated', findings: 'Synthetic findings' });
  assert.throws(() => tools.finish({ outcome: 'investigated', findings: 'again' }), /already submitted/);
});
test('SDK configuration exposes no built-in tools and denies unrelated permissions', () => {
  const config = restrictedSession([{ name: 'pilot_read' }], { model: 'gpt-6-luna' });
  assert.equal(config.model, 'gpt-6-luna');
  assert.equal(restrictedSession([]).model, undefined);
  assert.deepEqual(config.availableTools.toArray(), ['custom:pilot_read']);
  assert.equal(config.hooks.onPreToolUse({ toolName: 'powershell' }).permissionDecision, 'deny');
  assert.equal(config.onPermissionRequest({ kind: 'shell' }).kind, 'denied-by-rules');
});
test('SDK authoring repairs resume the same persisted session with only bounded tools', async () => {
  const calls = [];
  const client = {
    createSession: async config => { calls.push({ kind: 'create', config }); return 'created'; },
    resumeSession: async (id, config) => { calls.push({ kind: 'resume', id, config }); return 'resumed'; }
  };
  const tools = [{ name: 'pilot_replace_lines' }];
  const options = { sessionId: 'same-attempt', workingDirectory: 'fixture', prompt: 'bounded',
    model: 'gpt-6-luna' };
  assert.equal(await authoringSession(client, tools, options, 0), 'created');
  assert.equal(await authoringSession(client, tools, options, 1), 'resumed');
  assert.equal(calls[1].id, options.sessionId);
  for (const call of calls) {
    assert.equal(call.config.model, options.model);
    assert.deepEqual(call.config.availableTools.toArray(), ['custom:pilot_replace_lines']);
    assert.equal(call.config.onPermissionRequest({ kind: 'shell' }).kind, 'denied-by-rules');
  }
});
test('authoring feedback is optional pinned data and rejects changed or relative inputs', async t => {
  const { root, config } = await fixture(t);
  assert.equal(loadAuthoringFeedback(config), null);
  const path = join(root, 'native-feedback.json');
  writeFileSync(path, '{"nativeFailure":"lint"}\n');
  config.runtime.authoringFeedback = { path, sha256: hash(readFileSync(path)) };
  assert.equal(loadAuthoringFeedback(config).evidence.nativeFailure, 'lint');
  writeFileSync(path, '{"nativeFailure":"changed"}\n');
  assert.throws(() => loadAuthoringFeedback(config), /feedback changed/);
  config.runtime.authoringFeedback.path = 'relative.json';
  assert.throws(() => loadAuthoringFeedback(config), /absolute path/);
});
test('validation records real terminal command execution at exact fixture HEAD and forbids duplicates', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  const current = { ...job, workspace: isolated.workspace };
  // Only this synthetic fixture authorizes a local test command; no product runner is qualified.
  repo.validationGates = [{ id: 'synthetic-node', approved: true, isolationVerified: true,
    executable: process.execPath, args: ['--input-type=module', '-e',
      "import {value} from './src/value.js'; import assert from 'node:assert/strict'; assert.equal(value,1)"], timeoutMs: 10000 }];
  const result = await runValidation(config, ledger, current, repo, isolated.baseRevision);
  assert.equal(result[0].status, 'passed', json(result));
  assert.equal(result[0].sourceRevision, isolated.baseRevision);
  assert.ok(existsSync(result[0].artifactRefs[0]));
  await assert.rejects(runValidation(config, ledger, current, repo, isolated.baseRevision), /already started/);
});
test('failed validation is terminal evidence, not a success-shaped result', async t => {
  const { config, ledger, job, repo } = await fixture(t), isolated = await provision(config, job, repo);
  repo.validationGates = [{ id: 'fail', approved: true, isolationVerified: true,
    executable: process.execPath, args: ['-e', 'process.exit(9)'], timeoutMs: 10000 }];
  const result = await runValidation(config, ledger, { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision);
  assert.equal(result[0].status, 'failed');
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.equal(artifact.output.exitCode, 9);
});
test('validation profile errors block without entering source repair retries', async t => {
  const { config, ledger, job, repo } = await fixture(t), isolated = await provision(config, job, repo);
  config.limits.maxValidationInfrastructureRetries = 2;
  repo.validationGates = [{ id: 'profile-error', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 10000 }];
  let attempts = 0;
  const result = await runValidation(config, ledger,
    { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision,
    async () => {
      attempts++;
      throw Object.assign(new Error('invalid profile selection'), {
        code: 1, stdout: '', stderr: 'PILOT_VALIDATION_PROFILE_ERROR: no authored test selected'
      });
    });
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'validation-profile-error');
  assert.equal(result[0].attemptCount, 1);
  assert.equal(attempts, 1);
});
test('source mutation during validation retries in a clean checkout then blocks', async t => {
  const { config, ledger, job, repo } = await fixture(t), isolated = await provision(config, job, repo);
  config.limits.maxValidationInfrastructureRetries = 1;
  repo.validationGates = [{ id: 'mutates', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 10000 }];
  let attempts = 0;
  const result = await runValidation(config, ledger,
    { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision,
    async (executable, args, cwd) => {
    attempts++;
    writeFileSync(join(cwd, 'src', 'value.js'), 'changed');
    return { stdout: '', stderr: '' };
  });
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'runner-mutated-source');
  assert.equal(result[0].attemptCount, 2);
  assert.equal(result[0].artifactRefs.length, 2);
  assert.equal(attempts, 2);
  assert.equal(await command('git', ['status', '--porcelain'], isolated.workspace).then(value => value.stdout.trim()), '');
});
test('transient validation timeout retries once in a fresh checkout and can recover', async t => {
  const { config, ledger, job, repo } = await fixture(t), isolated = await provision(config, job, repo);
  config.limits.maxValidationInfrastructureRetries = 1;
  repo.validationGates = [{
    id: 'transient', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 10000
  }];
  let attempts = 0;
  const result = await runValidation(config, ledger,
    { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision,
    async () => {
      attempts++;
      if (attempts === 1)
        throw Object.assign(new Error('timed out'), {
          killed: true, code: null, stdout: '', stderr: 'timeout'
        });
      return { stdout: 'passed', stderr: '' };
    });
  assert.equal(result[0].status, 'passed');
  assert.equal(result[0].blockedReason, null);
  assert.equal(result[0].attemptCount, 2);
  assert.equal(result[0].artifactRefs.length, 2);
  assert.equal(JSON.parse(readFileSync(result[0].artifactRefs[0])).blockedReason, 'runner-timeout');
});
test('validation requires approved runner and never inherits credential environment values', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  repo.validationGates = [{ id: 'unqualified', executable: process.execPath, args: [], timeoutMs: 1000 }];
  await assert.rejects(runValidation(config, ledger, job, repo, 'abc'), /approved repo-native runner/);
  process.env.PILOT_TEST_SECRET = 'not-a-real-secret';
  const localAppData = process.env.LOCALAPPDATA;
  process.env.LOCALAPPDATA = 'safe-build-path';
  try {
    assert.equal(minimalEnvironment().PILOT_TEST_SECRET, undefined);
    assert.equal(minimalEnvironment().LOCALAPPDATA, 'safe-build-path');
  } finally {
    delete process.env.PILOT_TEST_SECRET;
    if (localAppData === undefined) delete process.env.LOCALAPPDATA;
    else process.env.LOCALAPPDATA = localAppData;
  }
});
test('opt-in package auth reaches only the selected runner and redacts successful output', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  const token = packageToken(t);
  packageToken(t, 'NPM_CONFIG_USERCONFIG', 'untrusted-config');
  packageToken(t, 'PILOT_UNRELATED_TOKEN', 'unrelated-secret');
  repo.validationGates = ['authenticated', 'legacy'].map(id => ({
    id, approved: true, isolationVerified: true, executable: process.execPath,
    args: [], timeoutMs: 10000,
    ...(id === 'authenticated' ? {
      packageAuth: { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN' }
    } : {})
  }));
  let calls = 0;
  const results = await runValidation(config, ledger, { ...job, workspace: isolated.workspace },
    repo, isolated.baseRevision, async (executable, args, cwd, timeout, env) => {
      assert.equal(env.YARN_NPM_AUTH_TOKEN, calls++ === 0 ? token : undefined);
      for (const name of ['PILOT_FIXTURE_TOKEN', 'PILOT_UNRELATED_TOKEN', 'NPM_CONFIG_USERCONFIG'])
        assert.equal(env[name], undefined);
      assert.equal(args.includes(token), false);
      return { stdout: calls === 1 ? token : 'legacy', stderr: calls === 1
        ? `${Buffer.from(token).toString('base64')} ${encodeURIComponent(token)}` : '' };
    });
  assert.ok(results.every(result => result.status === 'passed'));
  const artifact = readFileSync(results[0].artifactRefs[0], 'utf8');
  for (const secret of [token, Buffer.from(token).toString('base64'), encodeURIComponent(token)])
    assert.equal(artifact.includes(secret), false);
  assert.match(artifact, /\[REDACTED\]/);
  assert.equal(process.env.PILOT_FIXTURE_TOKEN, token);
  assert.equal(minimalEnvironment().YARN_NPM_AUTH_TOKEN, undefined);
});
test('authenticated runner failures redact diagnostics without losing exit status', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  const token = packageToken(t);
  repo.validationGates = [{ id: 'auth-failure', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 10000,
    packageAuth: { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN' } }];
  const results = await runValidation(config, ledger, { ...job, workspace: isolated.workspace },
    repo, isolated.baseRevision, async () => {
      throw Object.assign(new Error(token), { code: 7, stdout: token, stderr: token,
        secret: token });
    });
  assert.equal(results[0].status, 'failed');
  const artifact = readFileSync(results[0].artifactRefs[0], 'utf8');
  assert.equal(artifact.includes(token), false);
  assert.equal(JSON.parse(artifact).output.exitCode, 7);
});
test('real authenticated subprocesses receive an isolated environment and leave redacted artifacts', async t => {
  const token = packageToken(t);
  for (const exitCode of [0, 7]) {
    const { config, ledger, job, repo } = await fixture(t);
    const isolated = await provision(config, job, repo);
    repo.validationGates = [{ id: 'auth-process', approved: true, isolationVerified: true,
      executable: process.execPath, args: ['-e', `
        const assert = require('node:assert/strict');
        assert.ok(process.env.YARN_NPM_AUTH_TOKEN);
        assert.equal(process.env.PILOT_FIXTURE_TOKEN, undefined);
        console.log(process.env.YARN_NPM_AUTH_TOKEN);
        console.error(Buffer.from(process.env.YARN_NPM_AUTH_TOKEN).toString('base64'));
        process.exit(${exitCode});
      `], timeoutMs: 10000,
      packageAuth: { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN' } }];
    const results = await runValidation(config, ledger,
      { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision);
    assert.equal(results[0].status, exitCode ? 'failed' : 'passed');
    const artifact = readFileSync(results[0].artifactRefs[0], 'utf8');
    assert.equal(artifact.includes(token), false);
    assert.equal(artifact.includes(Buffer.from(token).toString('base64')), false);
    assert.match(artifact, /\[REDACTED\]/);
  }
});
test('missing package auth blocks without executing or retrying the runner', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  packageToken(t, 'PILOT_FIXTURE_TOKEN', '');
  config.limits.maxValidationInfrastructureRetries = 2;
  repo.validationGates = [{ id: 'auth-missing', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 10000,
    packageAuth: { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN' } }];
  const results = await runValidation(config, ledger, { ...job, workspace: isolated.workspace },
    repo, isolated.baseRevision, async () => assert.fail('Must not execute'));
  assert.equal(results[0].status, 'blocked');
  assert.equal(results[0].blockedReason, 'blocked-auth');
  assert.equal(results[0].attemptCount, 1);
});
test('omitted package auth preserves legacy runner error classification', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  repo.validationGates = [{ id: 'legacy-error', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 10000 }];
  const results = await runValidation(config, ledger, { ...job, workspace: isolated.workspace },
    repo, isolated.baseRevision, async () => { throw new PilotError('blocked-auth', 'fixture'); });
  assert.equal(results[0].blockedReason, 'runner-unavailable');
});
test('staged package auth stays out of fingerprint, policy, test and preparation receipts', async t => {
  const ctx = await stagedValidationFixture(t);
  const token = packageToken(t);
  ctx.repo.validationGates[0].packageAuth =
    { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN' };
  const execute = async (executable, args, cwd, timeout, env) => {
    const needsAuth = ['dependencies', 'compile'].includes(env.PILOT_VALIDATION_STAGE);
    assert.equal(env.YARN_NPM_AUTH_TOKEN, needsAuth ? token : undefined);
    const output = await ctx.execute(executable, args, cwd, timeout, env);
    return needsAuth ? { stdout: token, stderr: token } : output;
  };
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, execute);
  assert.ok(prepared.staged.receiptPath, json(prepared));
  for (const path of [prepared.staged.receiptPath, prepared.staged.dependencyReceiptPath]) {
    const receipt = readFileSync(path, 'utf8');
    assert.equal(receipt.includes(token), false);
    assert.equal(JSON.parse(receipt).inputs.packageAuth.kind, 'yarn-token');
  }
  process.env.PILOT_FIXTURE_TOKEN = 'rotated-synthetic-package-token';
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.deepEqual(ctx.calls, ['fingerprint', 'dependencies', 'compile',
    'fingerprint', 'policy', 'test']);
  assert.equal(readFileSync(result[0].artifactRefs[0], 'utf8').includes(token), false);
});
test('reused native validation transfers only the candidate closure from a promisor workspace', async t => {
  const ctx = await stagedValidationFixture(t);
  ctx.config.limits.maxValidationInfrastructureRetries = 0;
  const source = ctx.current.workspace;
  const git = (cwd, args) => command('git', ['-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false', '-c', 'core.hooksPath=.git/no-hooks', ...args], cwd);
  const commit = async title => {
    await git(source, ['add', '-A']);
    await git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '-m', title]);
    return (await git(source, ['rev-parse', 'HEAD'])).stdout.trim();
  };
  writeFileSync(join(source, 'test', 'historical.txt'), 'Unrelated promised history only\n');
  const historical = await commit('Synthetic historical blob');
  const missing = (await git(source, ['rev-parse', `${historical}:test/historical.txt`])).stdout.trim();
  rmSync(join(source, 'test', 'historical.txt'));
  const base = await commit('Remove historical blob before prepared base');
  const current = { ...ctx.current, base_revision: base };
  const prepared = await prepareValidation(ctx.config, current, ctx.repo, base, ctx.execute);
  assert.ok(prepared.staged.receiptPath, json(prepared));
  const target = prepared.staged.workspace;
  const refs = (await git(target, ['for-each-ref', '--format=%(refname)'])).stdout.trim();
  for (const ref of refs.split(/\r?\n/).filter(Boolean)) await git(target, ['update-ref', '-d', ref]);
  writeFileSync(join(source, 'test', 'candidate.txt'), 'Synthetic candidate test-only addition\n');
  const revision = await commit('Add candidate without changing prepared inputs');
  await git(source, ['config', 'remote.origin.promisor', 'true']);
  await git(source, ['config', 'remote.origin.partialclonefilter', 'blob:none']);
  await git(source, ['remote', 'set-url', 'origin', join(ctx.root, 'offline-missing-promisor')]);
  const objects = (await git(source, ['rev-parse', '--git-path', 'objects'])).stdout.trim();
  rmSync(join(source, objects, missing.slice(0, 2), missing.slice(2)));
  await assert.rejects(git(target, ['fetch', '--dry-run', '--no-tags', '--', source, revision]),
    /promisor|bad pack|missing/i);
  ctx.calls.length = 0;
  const results = await runValidation(ctx.config, ctx.ledger, current, ctx.repo, revision,
    ctx.execute, rmSync, prepared);
  assert.equal(results[0].status, 'passed', json(results));
  assert.equal(results[0].attemptCount, 1);
  assert.deepEqual(ctx.calls, ['fingerprint', 'policy', 'test']);
  const artifact = JSON.parse(readFileSync(results[0].artifactRefs[0], 'utf8'));
  assert.equal(artifact.telemetry.validationRevision, revision);
  assert.equal(artifact.telemetry.validationTimings.find(stage => stage.id === 'cleanup').cache, 'preserved');
  assert.equal((await git(target, ['rev-parse', 'HEAD'])).stdout.trim(), base);
  assert.equal((await git(source, ['rev-parse', 'HEAD'])).stdout.trim(), revision);
});
test('staged dependency auth failures are redacted before telemetry and receipts', async t => {
  const ctx = await stagedValidationFixture(t);
  const token = packageToken(t);
  ctx.repo.validationGates[0].packageAuth =
    { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN' };
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, async (...args) => {
      if (args[4].PILOT_VALIDATION_STAGE === 'dependencies')
        throw Object.assign(new Error(token), { code: 1, stdout: token, stderr: token });
      return ctx.execute(...args);
    });
  assert.equal(result[0].status, 'failed');
  const artifact = readFileSync(result[0].artifactRefs[0], 'utf8');
  assert.equal(artifact.includes(token), false);
  assert.equal(JSON.parse(artifact).output.stderr, '[REDACTED]');
});
test('missing staged package auth blocks after fingerprint without restore or retries', async t => {
  const ctx = await stagedValidationFixture(t);
  packageToken(t, 'PILOT_FIXTURE_TOKEN', '');
  ctx.repo.validationGates[0].packageAuth =
    { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN' };
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'blocked-auth');
  assert.equal(result[0].attemptCount, 1);
  assert.deepEqual(ctx.calls, ['fingerprint']);
});
test('changing the package auth contract invalidates prepared dependencies and compile', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  packageToken(t);
  ctx.repo.validationGates[0].packageAuth =
    { kind: 'yarn-token', tokenEnvironmentVariable: 'PILOT_FIXTURE_TOKEN' };
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 2);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
});
test('Windows staged native Git handles long paths in new and reused validation clones', {
  skip: process.platform !== 'win32'
}, async t => {
  const ctx = await stagedValidationFixture(t);
  const authoredConfig = readFileSync(join(ctx.isolated.workspace, '.git', 'config'), 'utf8');
  const referenceConfig = readFileSync(join(ctx.repo.referenceCheckout, '.git', 'config'), 'utf8');
  const longPath = await longPathFixture(ctx.isolated.workspace);
  const execute = async (executable, args, cwd, timeout, env) => {
    if (env.PILOT_VALIDATION_STAGE !== 'fingerprint') {
      const path = join(cwd, longPath.path);
      assert.ok(path.length > 260, `Expected an actual long path, got ${path.length}`);
      const local = await command('git', ['config', '--local', '--get', 'core.longpaths'], cwd);
      assert.equal(local.stdout.trim(), 'true');
      const native = await command('git', ['hash-object', '--', path], cwd);
      assert.match(native.stdout.trim(), /^[a-f0-9]{40,64}$/);
    }
    return ctx.execute(executable, args, cwd, timeout, env);
  };
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    longPath.revision, execute);
  assert.ok(prepared.staged.receiptPath, json(prepared));
  await command('git', ['config', '--local', '--unset', 'core.longpaths'],
    prepared.staged.workspace);
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    longPath.revision, execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.deepEqual(ctx.calls, ['fingerprint', 'dependencies', 'compile',
    'fingerprint', 'policy', 'test']);
  assert.equal(readFileSync(join(ctx.isolated.workspace, '.git', 'config'), 'utf8'), authoredConfig);
  assert.equal(readFileSync(join(ctx.repo.referenceCheckout, '.git', 'config'), 'utf8'), referenceConfig);
});
test('Windows non-staged native Git gets clone-local long paths without editing authored config', {
  skip: process.platform !== 'win32'
}, async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  const authoredConfig = readFileSync(join(isolated.workspace, '.git', 'config'), 'utf8');
  const longPath = await longPathFixture(isolated.workspace);
  repo.validationGates = [{ id: 'native-longpaths', approved: true, isolationVerified: true,
    executable: process.execPath, timeoutMs: 10000, args: ['-e', `
      const assert = require('node:assert/strict');
      const path = require('node:path').resolve(${JSON.stringify(longPath.path)});
      assert.ok(path.length > 260);
      const hash = require('node:child_process').execFileSync('git',
        ['hash-object', '--', path], {encoding: 'utf8'}).trim();
      assert.match(hash, /^[a-f0-9]{40,64}$/);
    `] }];
  const results = await runValidation(config, ledger, { ...job, workspace: isolated.workspace },
    repo, longPath.revision);
  assert.equal(results[0].status, 'passed');
  assert.equal(readFileSync(join(isolated.workspace, '.git', 'config'), 'utf8'), authoredConfig);
});
test('validation profiles are content-bound and substituted by the controller', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  const profilePath = join(config.stateDirectory, 'validation-profile.ps1');
  writeFileSync(profilePath, 'Write-Output profile');
  repo.validationGates = [{
    id: 'profiled', approved: true, isolationVerified: true,
    executable: process.execPath, args: ['-e', 'process.exit(0)', '{profile}'],
    profilePath, profileSha256: hash('Write-Output profile'), timeoutMs: 10000
  }];
  let observedArgs;
  const result = await runValidation(config, ledger,
    { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision,
    async (executable, args) => {
      observedArgs = args;
      return { stdout: '', stderr: '' };
    });
  assert.equal(result[0].status, 'passed');
  assert.notEqual(observedArgs.at(-1), profilePath);
  assert.match(observedArgs.at(-1), /validation-profiles/);
  assert.equal(existsSync(observedArgs.at(-1)), false);
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.equal(artifact.profileSha256, hash('Write-Output profile'));

  const second = await fixture(t);
  const secondIsolated = await provision(second.config, second.job, second.repo);
  second.repo.validationGates = [{
    ...repo.validationGates[0],
    profilePath,
    profileSha256: '0'.repeat(64)
  }];
  await assert.rejects(runValidation(second.config, second.ledger,
    { ...second.job, workspace: secondIsolated.workspace }, second.repo,
    secondIsolated.baseRevision), /profile hash mismatch/);
});
test('validation blocks when a content-bound private profile changes during execution', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  config.limits.maxValidationInfrastructureRetries = 1;
  const profilePath = join(config.stateDirectory, 'validation-profile.ps1');
  writeFileSync(profilePath, 'Write-Output profile');
  repo.validationGates = [{
    id: 'profile-toctou', approved: true, isolationVerified: true,
    executable: process.execPath, args: ['{profile}'],
    profilePath, profileSha256: hash('Write-Output profile'), timeoutMs: 10000
  }];
  let attempts = 0;
  const result = await runValidation(config, ledger,
    { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision,
    async (executable, args) => {
      attempts++;
      writeFileSync(args[0], 'changed-after-verification');
      return { stdout: '', stderr: '' };
    });
  assert.equal(attempts, 1);
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'validation-profile-changed');
  assert.equal(result[0].attemptCount, 1);
});
test('validation cleanup failures still finalize blocked evidence and operations', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  repo.validationGates = [{
    id: 'cleanup', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 10000
  }];
  const result = await runValidation(config, ledger,
    { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision,
    async () => ({ stdout: '', stderr: '' }),
    () => { throw Object.assign(new Error('synthetic cleanup failure'), {
      code: 'ETIMEDOUT', killed: true, ownedProcessesExited: true,
      stderr: 'synthetic-private-native-output'
    }); });
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'validation-cleanup-failed');
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.match(artifact.output.cleanupError, /Operation failed/);
  assert.ok(artifact.output.residualPaths.length > 0);
  assert.equal(artifact.output.cleanupFailures[0].targetRole, 'validation-workspace');
  assert.equal(artifact.output.cleanupFailures[0].reason, 'command-timeout');
  assert.equal(artifact.output.cleanupFailures[0].ownedProcessesExited, true);
  assert.ok(artifact.output.cleanupFailures[0].durationMs >= 0);
  assert(!JSON.stringify(artifact).includes('synthetic-private-native-output'));
  const operations = ledger.status().operations;
  assert.equal(operations.length, 1);
  assert.equal(operations[0].state, 'blocked');
});
test('post-run inspection failures preserve runner diagnostics in blocked evidence', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  repo.validationGates = [{
    id: 'inspection', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 10000
  }];
  const result = await runValidation(config, ledger,
    { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision,
    async (executable, args, cwd) => {
      rmSync(join(cwd, '.git'), { recursive: true, force: true });
      const error = new Error('synthetic runner failure');
      error.code = 9;
      error.stdout = 'runner stdout';
      error.stderr = 'runner stderr';
      throw error;
    });
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'validation-workspace-unavailable');
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.equal(artifact.output.exitCode, 9);
  assert.equal(artifact.output.stdout, 'runner stdout');
  assert.equal(artifact.output.stderr, 'runner stderr');
  assert.match(artifact.output.inspectionError, /Operation failed/);
});
test('validation retains its primary timeout when cleanup also fails', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  repo.validationGates = [{
    id: 'timeout-cleanup', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 10000
  }];
  const result = await runValidation(config, ledger,
    { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision,
    async () => { throw Object.assign(new Error('synthetic timeout'),
      { killed: true, ownedProcessesExited: true, stdout: '', stderr: '' }); },
    () => { throw new Error('synthetic cleanup failure'); });
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.notEqual(result[0].blockedReason, 'validation-cleanup-failed');
  assert.equal(artifact.output.primaryBlockedReason, result[0].blockedReason);
  assert.equal(artifact.output.timeout, true);
  assert.ok(artifact.output.cleanupError);
});
test('unconfirmed native process exit retains the workspace without inspection or cleanup', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  repo.validationGates = [{
    id: 'containment', approved: true, isolationVerified: true,
    executable: process.execPath, args: [], timeoutMs: 10000
  }];
  let cleanupCalls = 0, retained;
  const result = await runValidation(config, ledger,
    { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision,
    async (_executable, _args, cwd) => {
      retained = cwd;
      rmSync(join(cwd, '.git'), { recursive: true, force: true });
      throw Object.assign(new Error('synthetic containment failure'),
        { killed: true, containmentFailure: true, stdout: '', stderr: '' });
    }, () => { cleanupCalls++; });
  assert.equal(result[0].blockedReason, 'process-tree-exit-unconfirmed');
  assert.equal(cleanupCalls, 0);
  assert(existsSync(retained));
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.deepEqual(artifact.output.residualPaths, [retained]);
});
test('staged native preparation preserves explicit sparse paths in dependency and compile clones', async t => {
  const ctx = await stagedValidationFixture(t);
  mkdirSync(join(ctx.current.workspace, 'unrelated'));
  writeFileSync(join(ctx.current.workspace, 'unrelated', 'large.txt'), 'out of scope\n');
  await command('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
    'add', '--', 'unrelated/large.txt'], ctx.current.workspace);
  await command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Add excluded fixture'], ctx.current.workspace);
  const revision = (await command('git', ['rev-parse', 'HEAD'], ctx.current.workspace)).stdout.trim();
  ctx.repo.sparseCheckoutPaths = ['src', 'test'];
  const execute = async (...args) => {
    const cwd = args[2], stage = args[4].PILOT_VALIDATION_STAGE;
    if (['dependencies', 'compile', 'policy', 'test'].includes(stage)) {
      assert.equal(existsSync(join(cwd, 'unrelated', 'large.txt')), false,
        `${stage} must not materialize excluded source`);
      assert.equal(existsSync(join(cwd, 'src', 'value.js')), true);
      assert.equal(existsSync(join(cwd, 'test', 'behavior.test.js')), true);
      assert.equal((await command('git', ['config', '--bool', 'core.sparseCheckout'], cwd)).stdout.trim(), 'true');
    }
    return ctx.execute(...args);
  };
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo, revision, execute);
  assert.ok(prepared.staged.receiptPath, json(prepared));
  const results = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, execute, rmSync, prepared);
  assert.equal(results[0].status, 'passed', json(results));
  assert.deepEqual(ctx.calls.filter(stage => ['dependencies', 'compile', 'policy', 'test'].includes(stage)),
    ['dependencies', 'compile', 'policy', 'test']);
  assert.equal(existsSync(join(ctx.current.workspace, 'unrelated', 'large.txt')), true);
  assert.equal((await command('git', ['status', '--porcelain'], ctx.current.workspace)).stdout.trim(), '');
});
test('explicit sparse path changes invalidate staged caches and supplied prepared receipts', async t => {
  const ctx = await stagedValidationFixture(t);
  const base = ctx.isolated.baseRevision;
  const full = await prepareValidation(ctx.config, ctx.current, ctx.repo, base, ctx.execute);
  assert.ok(full.staged.receiptPath, json(full));
  assert.equal(full.staged.inputs.sparseCheckoutPaths, undefined);
  const fullDependencyKey = full.staged.inputs.dependencyKey, fullReceiptPath = full.staged.receiptPath;
  ctx.repo.sparseCheckoutPaths = ['test', 'src'];
  ctx.calls.length = 0;
  const results = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    base, ctx.execute, rmSync, full);
  assert.equal(results[0].status, 'passed', json(results));
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1, json(ctx.calls));
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1, json(ctx.calls));
  const sparse = await prepareValidation(ctx.config, ctx.current, ctx.repo, base, ctx.execute);
  assert.deepEqual(JSON.parse(readFileSync(sparse.staged.dependencyReceiptPath, 'utf8')).inputs.sparseCheckoutPaths,
    ['src', 'test']);
  assert.notEqual(sparse.staged.inputs.dependencyKey, fullDependencyKey);
  assert.notEqual(sparse.staged.receiptPath, fullReceiptPath);
  ctx.repo.sparseCheckoutPaths = ['src', 'test', 'src'];
  ctx.calls.length = 0;
  const reordered = await prepareValidation(ctx.config, ctx.current, ctx.repo, base, ctx.execute);
  assert.equal(reordered.staged.receiptPath, sparse.staged.receiptPath);
  assert.equal(ctx.calls.filter(stage => ['dependencies', 'compile'].includes(stage)).length, 0);
  ctx.repo.sparseCheckoutPaths.push('extra');
  ctx.calls.length = 0;
  const expanded = await prepareValidation(ctx.config, ctx.current, ctx.repo, base, ctx.execute);
  assert.ok(expanded.staged.receiptPath, json(expanded));
  assert.notEqual(expanded.staged.inputs.dependencyKey, sparse.staged.inputs.dependencyKey);
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
  assert.equal((await command('git', ['status', '--porcelain'], ctx.current.workspace)).stdout.trim(), '');
});
test('test-only repair reuses dependency and compile receipts with phase telemetry', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  assert.equal(prepared.staged.error, undefined,
    JSON.stringify(prepared.staged.error));
  const revision = await ctx.commit('test/behavior.test.js', 'repaired\n', 'Repair test only');
  const receipt = prepared.staged;
  const persisted = JSON.parse(readFileSync(receipt.receiptPath, 'utf8'));
  const { integrity, ...body } = persisted;
  assert.equal(hash(json(body)), integrity);
  assert.equal((await command('git', ['diff', '--name-only',
    receipt.inputs.sourceRevision, revision], ctx.current.workspace)).stdout.trim(),
  'test/behavior.test.js');
  assert.equal((await command('git', ['status', '--porcelain'],
    receipt.workspace)).stdout.trim(), '');
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed', JSON.stringify(result[0]));
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1,
    JSON.stringify(ctx.calls));
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'policy').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'test').length, 1);
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.equal(artifact.telemetry.cache, 'hit');
  assert.equal(artifact.telemetry.preparedSourceRevision, ctx.isolated.baseRevision);
  assert.equal(artifact.telemetry.validationRevision, revision);
  assert.equal(artifact.telemetry.validationTimings.find(stage => stage.id === 'dependencies').cache, 'hit');
  assert.equal(artifact.telemetry.validationTimings.find(stage => stage.id === 'compile').cache, 'hit');
  assert.ok(artifact.telemetry.preparationTimings.every(stage =>
    stage.startedAt && stage.finishedAt));
  assert.ok(artifact.telemetry.validationTimings.every(stage =>
    stage.startedAt && stage.finishedAt));
  assert.deepEqual(artifact.telemetry.validationTimings
    .filter(stage => stage.id.startsWith('reuse-')).map(stage => stage.id), [
    'reuse-receipts', 'reuse-changed-paths', 'reuse-inputs', 'reuse-prepared-outputs'
  ]);
  assert.deepEqual(artifact.telemetry.validationTimings.find(stage =>
    stage.id === 'cleanup').subphases.map(stage => stage.id), [
    'restore-source', 'verify-prepared-outputs', 'verify-source'
  ]);
});
test('cold staged validation passes with one complete prepared pipeline', async t => {
  const ctx = await stagedValidationFixture(t);
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, {});
  assert.equal(result[0].status, 'passed');
  assert.deepEqual(ctx.calls, [
    'fingerprint', 'dependencies', 'compile', 'policy', 'test'
  ]);
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.equal(artifact.telemetry.cache, 'miss');
  assert.ok(artifact.telemetry.preparationDurationMs >= 0);
  assert.ok(artifact.telemetry.validationDurationMs >= 0);
});
test('staged policy and test receive the exact base and candidate revisions', async t => {
  const ctx = await stagedValidationFixture(t);
  const revision = await ctx.commit('test/behavior.test.js', 'candidate\n', 'Add candidate test');
  const current = { ...ctx.current, base_revision: ctx.isolated.baseRevision };
  const seen = [];
  const execute = async (executable, args, cwd, timeout, env) => {
    if (['policy', 'test'].includes(env.PILOT_VALIDATION_STAGE)) {
      assert.equal(env.PILOT_VALIDATION_BASE_REVISION, ctx.isolated.baseRevision);
      assert.equal(env.PILOT_VALIDATION_REVISION, revision);
      assert.equal((await command('git', ['rev-parse', 'HEAD'], cwd)).stdout.trim(), revision);
      seen.push(env.PILOT_VALIDATION_STAGE);
    }
    return ctx.execute(executable, args, cwd, timeout, env);
  };
  const result = await runValidation(ctx.config, ctx.ledger, current, ctx.repo,
    revision, execute, rmSync, {});
  assert.equal(result[0].status, 'passed');
  assert.deepEqual(seen, ['policy', 'test']);
});
for (const variable of ['PILOT_VALIDATION_REVISION', 'PILOT_VALIDATION_BASE_REVISION']) {
  test(`missing ${variable} blocks staged validation instead of requesting model repair`, async t => {
    const ctx = await stagedValidationFixture(t);
    let policyCalls = 0;
    const execute = async (executable, args, cwd, timeout, env) => {
      if (env.PILOT_VALIDATION_STAGE === 'policy') {
        policyCalls++;
        throw Object.assign(new Error('invalid validation input'), {
          code: 1, stdout: '', stderr: `${variable} is missing or invalid\r\nAt profile.ps1:31 char:9\r\n`
        });
      }
      return ctx.execute(executable, args, cwd, timeout, env);
    };
    const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, execute, rmSync, {});
    assert.equal(result[0].status, 'blocked');
    assert.equal(result[0].blockedReason, 'validation-profile-error');
    assert.equal(result[0].attemptCount, 1);
    assert.equal(policyCalls, 1);
    assert.equal(ctx.calls.includes('test'), false);
  });
}
test('sequential ledger successors can reuse an explicitly shared verified native cache', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  const successor = structuredClone(ctx.config);
  successor.runtime.validationCacheDirectory = join(ctx.config.stateDirectory, 'pv');
  successor.stateDirectory = join(ctx.config.stateDirectory, 'successor-ledger');
  const reused = await prepareValidation(successor, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  assert.equal(reused.staged.receiptPath, prepared.staged.receiptPath);
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
  successor.runtime.validationCacheDirectory = 'relative-cache';
  const invalid = await prepareValidation(successor, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  assert.equal(invalid.staged.error.code, 'blocked-config');
});
