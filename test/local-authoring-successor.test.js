import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';
import { command, dispatch, prepareValidation, runValidation } from '../src/workers.js';
import { hash, json } from '../src/common.js';
import { prepareLocalAuthoringSuccessor, dispatchLocalAuthoringSuccessor,
  verifySetupOnlyChange, verifyTransformedSetupOrder,
  verifyCredentialAdmissionFailure } from '../src/local-authoring-successor.js';

const before = "import '../../../integration-harness/runtime/setup-officeagent-mocks';\n" +
  "jest.mock('fs/promises', () => ({mkdir: jest.fn()}));\n" +
  "describe('synthetic lifecycle contract', () => {\n" +
  "it('case', async () => { await action(); expect(condition).toBe(true); });\n});\n";
const statement = "import '../../../../src/excel-agent';\n";
const after = before.replace('describe(', `${statement}describe(`);

function admissionFixture() {
  const job = { session_id: 'synthetic-attempt', workspace: 'synthetic-workspace',
    state: 'blocked', base_revision: 'synthetic-revision' };
  const result = { attemptId: job.session_id, outcome: 'blocked', sourceRevision: job.base_revision,
    draftPR: null, skillExecution: null, validation: [], validationAttempts: [],
    toolUsage: { used: 0, byTool: { pilot_read: 0 },
      rounds: [{ status: 'failed', used: 0, cumulativeUsed: 0 }] } };
  const events = [
    { type: 'session.start', data: { sessionId: job.session_id, context: { cwd: job.workspace } } },
    { type: 'session.error', data: { errorType: 'query',
      message: 'Execution failed: InvalidArg, No GitHub OAuth token or Copilot HMAC key provided' } },
    { type: 'session.shutdown', data: { shutdownType: 'routine', totalPremiumRequests: 0,
      totalNanoAiu: 0, totalApiDurationMs: 0, conversationTokens: 0, modelMetrics: {},
      codeChanges: { linesAdded: 0, linesRemoved: 0, filesModified: [] } } }
  ];
  return { job, result, events };
}

test('credential successor classifies only exact terminal admission evidence, not generic zero tools', () => {
  const { events, job, result } = admissionFixture();
  verifyCredentialAdmissionFailure(events, job, result);
});
for (const [label, alter] of [
  ['generic sign-in wording', f => { f.events[1].data.message = 'Please sign in'; }],
  ['invalid credential', f => { f.events[1].data.message = 'Invalid token'; }],
  ['missing usage', f => { delete f.events[2].data.totalNanoAiu; }],
  ['reported consumption', f => { f.events[2].data.totalNanoAiu = 1; }],
  ['request duration', f => { f.events[2].data.totalApiDurationMs = 1; }],
  ['model metrics', f => { f.events[2].data.modelMetrics = { model: {} }; }],
  ['assistant event', f => { f.events.splice(2, 0, { type: 'assistant.message', data: {} }); }],
  ['wrong session', f => { f.events[0].data.sessionId = 'other'; }],
  ['wrong workspace', f => { f.events[0].data.context.cwd = 'other'; }],
  ['missing shutdown', f => { f.events.pop(); }],
  ['SDK code change', f => { f.events[2].data.codeChanges.filesModified.push('test.ts'); }],
  ['tool execution', f => { f.result.toolUsage.byTool.pilot_read = 1; }],
  ['native validation', f => { f.result.validation.push({ status: 'failed' }); }],
  ['changed source', f => { f.result.sourceRevision = 'changed'; }],
  ['draft publication', f => { f.result.draftPR = {}; }],
  ['extra authoring round', f => { f.result.toolUsage.rounds.push(f.result.toolUsage.rounds[0]); }],
  ['nonterminal job', f => { f.job.state = 'running'; }]
]) test(`credential successor rejects ${label}`, () => {
  const fixture = admissionFixture();
  alter(fixture);
  assert.throws(() => verifyCredentialAdmissionFailure(fixture.events, fixture.job, fixture.result));
});

test('setup successor permits only the real SUT module import before the unchanged suite', () => {
  verifySetupOnlyChange(before, after);
  verifySetupOnlyChange(before, after.replaceAll('\n', '\r\n'));
});
for (const [label, changed] of [
  ['unchanged proposal', before],
  ['removed assertion', after.replace('expect(condition).toBe(true);', '')],
  ['altered precondition', after.replace('condition', 'true')],
  ['moved await', after.replace('await action();', '')],
  ['global timeout increase', after.replace('describe(', 'jest.setTimeout(60000);\ndescribe(')],
  ['case timeout increase', after.replace('toBe(true); });', 'toBe(true); }, 60000);')],
  ['new mock', after.replace('describe(', "jest.mock('../../../../src/excel-agent');\ndescribe(")],
  ['import before mocks', statement + before],
  ['duplicate import', statement + after],
  ['diagnostic instrumentation', after.replace('await action();', "trace('await'); await action();")],
  ['test skipped', after.replace("it('case'", "it.skip('case'")],
  ['changed original mock', after.replace('mkdir: jest.fn()', 'mkdir: noOp')],
  ['renamed suite', after.replace('synthetic lifecycle contract', 'different suite')],
  ['extra top-level suite', after + "describe('extra suite', () => {\n});\n"],
]) test(`setup successor rejects ${label}`, () => {
  assert.throws(() => verifySetupOnlyChange(before, changed));
});

test('successor preparation cannot reuse a populated ledger', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'authoring-successor-ledger-'));
  const ledger = new Ledger(directory);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  ledger.operation('existing', 'prior', 'fixture', {});
  await assert.rejects(prepareLocalAuthoringSuccessor({ stateDirectory: directory }, ledger, {}),
    /fresh ledger/);
});

test('ordinary dispatch cannot bypass a recorded successor entrypoint', async t => {
  const directory = mkdtempSync(join(tmpdir(), 'authoring-successor-entrypoint-'));
  const ledger = new Ledger(directory);
  t.after(() => { ledger.close(); rmSync(directory, { recursive: true, force: true }); });
  ledger.db.prepare('INSERT INTO jobs(id,investigation_id,version,repo,state,session_id,updated_at) VALUES(?,?,?,?,?,?,?)')
    .run('fixture', 'investigation', 1, 'office-agent', 'prepared', 'attempt', new Date().toISOString());
  ledger.operation('reservation', 'fixture', 'authoring-successor-from-diagnostic', {});
  await assert.rejects(dispatch({ activation: { dispatch: true } }, ledger, 'fixture'),
    /explicit recorded dispatch entrypoint/);
  assert.equal(ledger.job('fixture').state, 'prepared');
  await assert.rejects(dispatchLocalAuthoringSuccessor({ activation: { dispatch: true } },
    ledger, 'fixture'), /immutable preparation/);
  assert.equal(ledger.job('fixture').state, 'prepared');
});

const emitted = "jest.mock('fs/promises', () => ({}));\n" +
  'require("../../../integration-harness/runtime/setup-officeagent-mocks");\n' +
  'require("../../../../src/excel-agent");\n' +
  "describe('synthetic lifecycle contract', () => {});\n";
test('emitted-code guard requires a surviving runtime import after both mocks', () => {
  verifyTransformedSetupOrder(emitted);
  assert.throws(() => verifyTransformedSetupOrder(emitted.replace(
    'require("../../../../src/excel-agent");', '')));
  assert.throws(() => verifyTransformedSetupOrder(emitted.replace(
    'require("../../../../src/excel-agent");', '// require("../../../../src/excel-agent");')));
  assert.throws(() => verifyTransformedSetupOrder(
    'require("../../../../src/excel-agent");\n' + emitted));
});

test('successor native stage delivers a fresh private temp directory to the actual child', async t => {
  const root = mkdtempSync(join(tmpdir(), 'successor-native-temp-'));
  const workspace = join(root, 'source');
  mkdirSync(workspace);
  writeFileSync(join(workspace, '.gitignore'), 'deps.txt\nbuilt.txt\n');
  writeFileSync(join(workspace, 'package.json'), '{"name":"fixture"}\n');
  const git = args => command('git', ['-c', 'core.autocrlf=false', ...args], workspace);
  await git(['init', '--quiet']);
  await git(['add', '.']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Synthetic native environment']);
  const revision = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const profilePath = join(root, 'profile.mjs'), captured = join(root, 'child.json');
  const plan = { version: 2, stages: ['dependencies', 'compile', 'policy', 'test'],
    testOnlyPrefixes: ['test/'], lockfilePaths: ['package.json'], buildConfigPaths: ['package.json'],
    dependencySnapshotPaths: ['deps.txt'], preparedOutputPaths: ['built.txt'] };
  writeFileSync(profilePath, `// PILOT_VALIDATION_PLAN: ${json(plan)}\n` +
    `import{writeFileSync}from'node:fs';import{tmpdir}from'node:os';const s=process.env.PILOT_VALIDATION_STAGE;\n` +
    `if(s==='fingerprint')console.log('PILOT_VALIDATION_FINGERPRINT:'+JSON.stringify({node:process.version,corepack:'fixture',yarn:'fixture',platform:process.platform,architecture:process.arch}));\n` +
    `else if(s==='dependencies')writeFileSync('deps.txt','dependency');\n` +
    `else if(s==='compile')writeFileSync('built.txt','compiled');\n` +
    `else if(s==='test')writeFileSync(${json(captured)},JSON.stringify({temp:tmpdir(),token:process.env.YARN_NPM_AUTH_TOKEN??null}));\n`);
  const gate = { id: 'native', executable: process.execPath, args: ['{profile}'],
    timeoutMs: 30000, approved: true, isolationVerified: true,
    profilePath, profileSha256: hash(readFileSync(profilePath)) };
  const repo = { id: 'fixture', owner: 'fixture', routingApproved: true, baseRef: revision,
    remote: workspace, referenceCheckout: workspace, validationGates: [gate], allowedWritePrefixes: ['test'] };
  const config = { stateDirectory: join(root, 'state'), repositories: [repo],
    limits: { maxValidationInfrastructureRetries: 0 } };
  const ledger = new Ledger(config.stateDirectory);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const job = { id: 'fixture-job', repo: repo.id, workspace };
  ledger.operation('fixture-successor', job.id, 'authoring-successor-from-diagnostic', {});
  const prepared = await prepareValidation(config, job, repo, revision);
  const results = await runValidation(config, ledger, job, repo, revision, undefined, undefined, prepared);
  assert.equal(results[0].status, 'passed', json(results));
  const artifact = JSON.parse(readFileSync(results[0].artifactRefs[0]));
  const fresh = artifact.telemetry.successorNative;
  assert.equal(fresh.initiallyAbsent, true);
  assert.equal(fresh.revision, revision);
  const child = JSON.parse(readFileSync(captured));
  assert.equal(child.temp, fresh.temporaryDirectory);
  assert.equal(child.token, null);
  assert.ok(fresh.temporaryDirectory.startsWith(config.stateDirectory));
});
