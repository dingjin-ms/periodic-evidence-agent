import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { Ledger } from '../src/ledger.js';
import { hash, json, PilotError } from '../src/common.js';
import { readAppFlowPlan, runAppRoleFlow } from '../src/rsi-app-flow.js';

function fixture(t, { host = false, database = true, terminal = true } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'rsi-app-flow-'));
  const ledger = new Ledger(join(root, 'ledger'));
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const roles = ['collector', 'filter', 'proposer'];
  const profile = { cases: ['recovery', 'healthy', 'guard'].map(population =>
    ({ id: population, population, assertions: roles })), timeoutMs: 10000 };
  const plan = { format: 'rsi-app-role-flow-plan-v1', cases: profile.cases.map(item => ({
    id: item.id, runId: 'test', production: false,
    config: { executionMode: 'app-native', stateDirectory: '${state}' },
    steps: roles.map((role, i) => ({ id: role, role,
      operation: ['app-begin', 'app-status', 'app-end'][i],
      ...role === 'collector' ? { input: { runId: '${runId}', dryRun: true, provenance: 'synthetic' } } : {},
      ...host && role === 'filter' ? { hostInput: { instructions: 'Offline semantic continuation fixture.' } } : {} })),
    workStarted: { step: 'collector', pointer: '/0/ok', equals: 1,
      ledger: { path: 'checks.sqlite', query: "SELECT ok FROM checks WHERE role='collector'" } },
    assertions: roles.map(role => ({ id: role, step: role, pointer: '/0/ok', equals: 1,
      ledger: { path: 'checks.sqlite', query: `SELECT ok FROM checks WHERE role='${role}'` } }))
  })) };
  const updatePlan = () => {
    const path = join(root, 'plan.json');
    writeFileSync(path, json(plan));
    profile.flowPlan = { path, sha256: hash(json(plan)) };
  };
  updatePlan();
  const input = { profile, workspace: process.cwd(), revision: 'a'.repeat(40),
    observationSha256: 'b'.repeat(64), directory: join(root, 'cases'), phase: 'baseline',
    executionId: 'unit-fixture', deadline: Date.now() + 10000, env: process.env };
  const persist = (path, value) => {
    if (existsSync(path)) assert.equal(readFileSync(path, 'utf8'), json(value), 'immutable fixture receipt');
    else writeFileSync(path, json(value));
    return { ref: path, sha256: hash(json(value)) };
  };
  const calls = [];
  const dependencies = {
    admit: () => 10000, persist, ledger,
    hostInput: async () => ({}),
    retainRaw: (key, value) => {
      const path = join(root, `${hash(key)}.json`);
      const receipt = persist(path, value);
      return { path, sha256: receipt.sha256 };
    },
    readRaw: reference => {
      assert.equal(hash(readFileSync(reference.path)), reference.sha256);
      return JSON.parse(readFileSync(reference.path, 'utf8'));
    },
    execute: async (_executable, args) => {
      const index = args.indexOf('agent'), role = args[index + 1], operation = args[index + 2];
      calls.push({ role, operation });
      if (database) {
        const config = JSON.parse(readFileSync(args[args.indexOf('--config') + 1], 'utf8'));
        const db = new DatabaseSync(join(dirname(config.stateDirectory), 'checks.sqlite'));
        try {
          db.exec('CREATE TABLE IF NOT EXISTS checks(role TEXT PRIMARY KEY,ok INTEGER)');
          db.prepare('INSERT OR REPLACE INTO checks VALUES(?,?)').run(role, role === 'proposer' && !terminal ? 0 : 1);
        } finally { db.close(); }
      }
      return { stdout: json({ format: 'agent-operation-result-v1', role, operation,
        kind: 'result', acceptance: 'not-inferred', result: { state: 'prepared' } }), stderr: '' };
    }
  };
  return { root, input, profile, plan, updatePlan, dependencies, calls, ledger };
}

test('role envelopes and prepared assignments cannot replace durable intended-work assertions', async t => {
  const ctx = fixture(t, { terminal: false });
  const result = await runAppRoleFlow(ctx.input, ctx.dependencies);
  assert.equal(ctx.calls.length, 9);
  assert.ok(result.result.cases.every(item => item.started && item.outcome === 'failed' &&
    item.assertions.find(row => row.id === 'proposer').state === 'failed'));
  assert.deepEqual(result.diagnostics, []);
});

test('missing role ledger evidence stays unknown despite successful command envelopes', async t => {
  const ctx = fixture(t, { database: false });
  const result = await runAppRoleFlow(ctx.input, ctx.dependencies);
  assert.ok(result.result.cases.every(item => !item.started && item.outcome === 'unknown' &&
    item.assertions.every(row => row.state === 'unknown')));
});

test('semantic yields resume completed role steps without executing them twice', async t => {
  const ctx = fixture(t, { host: true });
  let request;
  ctx.dependencies.hostInput = async (name, task) => {
    request = { name, task };
    throw new PilotError('awaiting-host', 'Offline host is paused');
  };
  await assert.rejects(runAppRoleFlow(ctx.input, ctx.dependencies), { code: 'awaiting-host' });
  assert.equal(ctx.calls.length, 1);
  assert.equal(request.task.role, 'filter');
  assert.equal(request.task.publicationAllowed, false);
  assert.equal(request.task.deadline, ctx.input.deadline);
  ctx.dependencies.hostInput = async () => ({});
  const result = await runAppRoleFlow(ctx.input, ctx.dependencies);
  assert.equal(ctx.calls.length, 9);
  assert.ok(result.result.cases.every(item => item.outcome === 'passed'));
  assert.deepEqual(await runAppRoleFlow(ctx.input, ctx.dependencies), result);
  assert.equal(ctx.calls.length, 9);
});

test('interrupted role commands retain unknown effects and are never automatically repeated', async t => {
  const ctx = fixture(t);
  let attempts = 0;
  ctx.dependencies.execute = async () => {
    attempts++;
    throw Object.assign(new Error('Interrupted child'), {
      code: 'ETIMEDOUT', killed: true, stdout: '', stderr: 'partial fixture trace'
    });
  };
  await assert.rejects(runAppRoleFlow(ctx.input, ctx.dependencies), /Interrupted child/);
  const operation = ctx.ledger.db.prepare("SELECT state,detail FROM operations WHERE kind='rsi-app-flow-step'").get();
  assert.equal(operation.state, 'unknown');
  assert.equal(ctx.dependencies.readRaw(JSON.parse(operation.detail).artifact).stderr, 'partial fixture trace');
  await assert.rejects(runAppRoleFlow(ctx.input, ctx.dependencies), /unknown prior effect/);
  assert.equal(attempts, 1);
});

test('interrupted output storage failure is explicit without renewing the execution budget', async t => {
  const ctx = fixture(t);
  const retain = ctx.dependencies.retainRaw;
  ctx.dependencies.retainRaw = (key, value) => {
    if (key.endsWith('-interrupted')) throw new PilotError('blocked-budget', 'Expired budget');
    return retain(key, value);
  };
  ctx.dependencies.execute = async () => { throw new Error('Interrupted child'); };
  await assert.rejects(runAppRoleFlow(ctx.input, ctx.dependencies), /Interrupted child/);
  const operation = ctx.ledger.db.prepare("SELECT state,detail FROM operations WHERE kind='rsi-app-flow-step'").get();
  assert.equal(operation.state, 'unknown');
  const detail = JSON.parse(operation.detail);
  assert.equal(detail.artifact, null);
  assert.equal(detail.artifactError.code, 'blocked-budget');
  await assert.rejects(runAppRoleFlow(ctx.input, ctx.dependencies), /unknown prior effect/);
});

test('unstructured terminal output is retained and cannot trigger a replay', async t => {
  const ctx = fixture(t);
  let attempts = 0;
  ctx.dependencies.execute = async () => {
    attempts++;
    return { stdout: 'not a role result', stderr: 'fixture diagnostic' };
  };
  await assert.rejects(runAppRoleFlow(ctx.input, ctx.dependencies), { code: 'blocked-result' });
  const operation = ctx.ledger.db.prepare("SELECT state,detail FROM operations WHERE kind='rsi-app-flow-step'").get();
  assert.equal(operation.state, 'completed');
  const receipt = JSON.parse(readFileSync(JSON.parse(operation.detail).ref, 'utf8'));
  assert.equal(ctx.dependencies.readRaw(receipt.artifact).stderr, 'fixture diagnostic');
  await assert.rejects(runAppRoleFlow(ctx.input, ctx.dependencies), { code: 'blocked-result' });
  assert.equal(attempts, 1);
});

test('unavailable retained outputs block resumption instead of recreating old raw bytes', async t => {
  const ctx = fixture(t, { host: true });
  ctx.dependencies.hostInput = async () => { throw new PilotError('awaiting-host', 'Paused'); };
  await assert.rejects(runAppRoleFlow(ctx.input, ctx.dependencies), { code: 'awaiting-host' });
  ctx.dependencies.readRaw = () => { throw new PilotError('unavailable', 'Expired raw fixture'); };
  await assert.rejects(runAppRoleFlow(ctx.input, ctx.dependencies), { code: 'unavailable' });
  assert.equal(ctx.calls.length, 1);
});

test('comparison plans reject reordered roles, mutable sources, self-grading and recursive RSI', t => {
  const ctx = fixture(t);
  const pristine = structuredClone(ctx.plan);
  const mutations = [
    plan => { plan.cases[0].steps[1].role = 'collector'; },
    plan => { plan.cases[0].steps[0].hostInput = { instructions: 'recollect' }; },
    plan => { plan.cases[0].steps[0].options = ['--config', 'another.json']; },
    plan => { delete plan.cases[0].assertions[1].ledger; },
    plan => { plan.cases[0].config.rsi = { enabled: true }; },
    plan => { plan.cases[0].steps[0].input.dryRun = false; },
    plan => { plan.cases[0].assertions[0].ledger.query = 'DELETE FROM checks'; },
    plan => { plan.cases[0].assertions[0].ledger.path = '..\\outside.sqlite'; }
  ];
  for (const mutate of mutations) {
    ctx.plan.cases = structuredClone(pristine.cases);
    mutate(ctx.plan); ctx.updatePlan();
    assert.throws(() => readAppFlowPlan(ctx.profile));
  }
  ctx.plan.cases = pristine.cases; ctx.updatePlan();
  writeFileSync(ctx.profile.flowPlan.path, json({ ...ctx.plan, changed: true }));
  assert.throws(() => readAppFlowPlan(ctx.profile), /changed/);
});

test('a slow read-only SQL assertion is bounded and remains unknown', async t => {
  const ctx = fixture(t);
  for (const selected of ctx.plan.cases)
    selected.workStarted.ledger.query = 'SELECT (WITH RECURSIVE n(x) AS (VALUES(1) UNION ALL SELECT x+1 FROM n) SELECT sum(x) FROM n)';
  ctx.updatePlan();
  ctx.dependencies.admit = () => 100;
  const result = await runAppRoleFlow(ctx.input, ctx.dependencies);
  assert.equal(result.diagnostics.length, 3);
  assert.ok(result.result.cases.every(item => item.outcome === 'unknown'));
});

test('a success envelope cannot hide a command failure outside the partial-result contract', async t => {
  const ctx = fixture(t);
  const execute = ctx.dependencies.execute;
  ctx.dependencies.execute = async (...args) => {
    const output = await execute(...args);
    throw Object.assign(new Error('Command failed'), { ...output, code: 1 });
  };
  await assert.rejects(runAppRoleFlow(ctx.input, ctx.dependencies), { code: 'blocked-result' });
});
