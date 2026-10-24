import test from 'node:test';
import assert from 'node:assert/strict';
import { cliError } from '../scripts/test-support/cli-error.mjs';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import {
  existsSync, lstatSync, linkSync, mkdirSync, mkdtempSync, readFileSync,
  readdirSync, realpathSync, renameSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { hash, json, uuid, validateRecord } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import {
  initializeSelfImprovement, inspectRsiPath, openSelfImprovementStore, persistSelfImprovementArtifact,
  prepareSelfImprovementExperiment, recordSelfImprovementDecision, recordSelfImprovementObservation,
  reserveSelfImprovementEvaluation, selfImprovementOperation, selfImprovementStatus,
  rsiDirectoryBytes, selfImprovementRoot, selfImprovementWorkload, updateSelfImprovementOperation
} from '../src/self-improvement.js';

function fixture(t) {
  const checkoutRoot = mkdtempSync(join(tmpdir(), 'rsi-state-test-'));
  execFileSync('git', ['init', '--quiet'], { cwd: checkoutRoot, windowsHide: true });
  writeFileSync(join(checkoutRoot, '.gitignore'), '.state/\n');
  const policy = JSON.parse(readFileSync(new URL('../scaffold/self-improvement.example.json', import.meta.url)));
  policy.stateDirectory = '.state/rsi/state-test';
  policy.stateOwner = 'offline-state-test';
  policy.executionApproved = true;
  const options = { checkoutRoot };
  const stores = [];
  t.after(() => {
    for (const store of stores) store.close();
    rmSync(checkoutRoot, { recursive: true, force: true });
  });
  return { checkoutRoot, policy, options, stores,
    initialize: () => initializeSelfImprovement(policy, options),
    open: () => {
      const store = openSelfImprovementStore(policy, options);
      stores.push(store);
      return store;
    } };
}

function files(root) {
  if (!existsSync(root)) return {};
  const result = {};
  function visit(path, label) {
    const stat = lstatSync(path);
    if (stat.isDirectory()) for (const name of readdirSync(path).sort()) visit(join(path, name), `${label}/${name}`);
    else result[label] = { sha256: hash(readFileSync(path)), modified: stat.mtimeMs };
  }
  visit(root, '');
  return result;
}

function prepare(store) {
  const observation = recordSelfImprovementObservation(store, selfImprovementWorkload());
  return prepareSelfImprovementExperiment(store, { observationId: observation.id, observationVersion: 1 });
}

test('RSI CLI error parser accepts known SQLite warnings around structured errors', () => {
  const error = { code: 'blocked-scope', message: 'Rejected fixture operation' };
  const warning = '(node:123) ExperimentalWarning: SQLite is an experimental feature and might change at any time\n' +
    '(Use `node --trace-warnings ...` to show where the warning was created)\n';
  const plain = JSON.stringify(error);
  const stderr = warning + warning.replace('123', '456') + JSON.stringify(error, null, 2) + '\n';
  assert.deepEqual(cliError(plain), error);
  assert.deepEqual(cliError(stderr), error);
  assert.deepEqual(cliError(stderr.replaceAll('\n', '\r\n')), error);
  assert.deepEqual(cliError(plain + '\n' + warning), error);
  assert.deepEqual(cliError(warning.split('\n')[0] + '\n' + plain), error);
});

test('RSI CLI error parser rejects unknown diagnostics, malformed JSON and extra errors', () => {
  const error = JSON.stringify({ code: 'blocked-scope' });
  for (const stderr of [
    `unexpected diagnostic\n${error}`,
    `(node:123) ExperimentalWarning: different warning\n${error}`,
    '{',
    `${error}\n${error}`,
    ''
  ]) assert.throws(() => cliError(stderr), SyntaxError);
});

test('RSI policy is opt-in, strictly bounded and rejects product configuration', () => {
  const policy = JSON.parse(readFileSync(new URL('../scaffold/self-improvement.example.json', import.meta.url)));
  assert.equal(validateRecord(policy, 'selfImprovementPolicy').executionApproved, false);
  for (const [key, value] of [['maxEpisodes', null], ['caseTimeoutMs', 0],
    ['maxRuntimeMs', Infinity], ['maxOutputBytes', -1], ['maxArtifactBytes', 0],
    ['maxFixtureBytes', 0], ['maxCandidateVersions', 3]]) {
    assert.throws(() => validateRecord({ ...policy, limits: { ...policy.limits, [key]: value } },
      'selfImprovementPolicy'), /Invalid selfImprovementPolicy/);
  }
  assert.throws(() => validateRecord({ ...policy, repositories: [] }, 'selfImprovementPolicy'),
    /Invalid selfImprovementPolicy/);
});

test('RSI status never creates state and initialized status is byte-preserving', async t => {
  const ctx = fixture(t);
  const before = files(ctx.checkoutRoot);
  assert.deepEqual(await selfImprovementStatus(ctx.policy, ctx.options),
    { state: 'uninitialized', createsState: false });
  assert.deepEqual(files(ctx.checkoutRoot), before);
  const initialized = ctx.initialize();
  const initializedBytes = files(initialized.root);
  const status = await selfImprovementStatus(ctx.policy, ctx.options);
  assert.equal(status.storeId, initialized.storeId);
  assert.equal(status.automaticCleanup, false);
  assert.equal(status.archiveAllowed, false);
  assert.deepEqual(files(initialized.root), initializedBytes);
});

test('RSI root guards reject aliases, foreign stores and links before writable admission', t => {
  const ctx = fixture(t);
  for (const stateDirectory of ['.state', '.state/rsi', '.state/rsi/../foreign',
    '.state/./rsi/alias', '.state//rsi/alias', join(ctx.checkoutRoot, '.state', 'rsi', 'alias')])
    assert.throws(() => initializeSelfImprovement({ ...ctx.policy, stateDirectory }, ctx.options), /explicit named child/);
  const root = join(ctx.checkoutRoot, '.state', 'rsi', 'state-test');
  const foreign = new Ledger(root);
  foreign.db.prepare('INSERT INTO cursors VALUES(?,?)').run('fixture-source', '{}');
  foreign.close();
  const original = files(root);
  assert.throws(() => ctx.initialize(), /new or empty/);
  assert.throws(() => ctx.open(), /unavailable/);
  assert.deepEqual(files(root), original);
  const elsewhere = join(ctx.checkoutRoot, 'link-target');
  mkdirSync(elsewhere);
  const linkRoot = join(ctx.checkoutRoot, '.state', 'rsi', 'linked');
  symlinkSync(elsewhere, linkRoot, 'junction');
  assert.throws(() => initializeSelfImprovement({ ...ctx.policy, stateDirectory: '.state/rsi/linked' },
    ctx.options), /linked or unsupported/);
});

test('marked mixed namespaces and hardlinked ownership files are refused without writes', t => {
  const ctx = fixture(t);
  const initialized = ctx.initialize();
  const store = ctx.open();
  store.ledger.db.prepare('INSERT INTO cursors VALUES(?,?)').run('foreign-source', '{}');
  const original = files(initialized.root);
  assert.throws(() => openSelfImprovementStore(ctx.policy, ctx.options), /Populated fixture\/product/);
  assert.deepEqual(files(initialized.root), original);
  store.ledger.db.exec('DELETE FROM cursors');
  linkSync(join(initialized.root, '.rsi-root.json'), join(ctx.checkoutRoot, 'linked-marker.json'));
  const linked = files(initialized.root);
  assert.throws(() => openSelfImprovementStore(ctx.policy, ctx.options), /linked or unsupported/);
  assert.deepEqual(files(initialized.root), linked);
});

test('RSI directory accounting canonicalizes each inspected path once without caching sizes', t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'rsi-accounting-')));
  t.after(() => rmSync(root, { recursive: true }));
  const directory = join(root, 'a', 'b', 'c', 'd');
  mkdirSync(directory, { recursive: true });
  const file = join(directory, 'value');
  writeFileSync(file, 'before');
  const canonicalize = t.mock.method(realpathSync, 'native');
  const metadata = t.mock.method(fs, 'lstatSync');
  syncBuiltinESMExports();
  t.after(() => { metadata.mock.restore(); syncBuiltinESMExports(); });
  assert.equal(rsiDirectoryBytes(root), 6);
  assert.equal(canonicalize.mock.callCount(), 6, 'Canonicalization must not multiply with ancestor depth');
  assert.equal(metadata.mock.callCount(), 6, 'Metadata checks must not multiply with ancestor depth');
  canonicalize.mock.resetCalls();
  metadata.mock.resetCalls();
  writeFileSync(file, 'changed bytes');
  assert.equal(rsiDirectoryBytes(root), 13, 'Every scan must observe current file sizes');
  assert.equal(canonicalize.mock.callCount(), 6);
  assert.equal(metadata.mock.callCount(), 6);
});

test('RSI accounting rejects an ancestor replaced by a junction during enumeration', t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'rsi-accounting-swap-')));
  t.after(() => rmSync(root, { recursive: true }));
  const tree = join(root, 'tree'), directory = join(tree, 'deep'), target = join(root, 'target');
  mkdirSync(directory, { recursive: true });
  mkdirSync(target);
  writeFileSync(join(directory, 'value'), 'owned');
  writeFileSync(join(target, 'value'), 'foreign');
  const enumerate = fs.readdirSync;
  const enumeration = t.mock.method(fs, 'readdirSync', path => {
    const names = enumerate(path);
    if (path === directory) {
      renameSync(directory, `${directory}-original`);
      symlinkSync(target, directory, 'junction');
    }
    return names;
  });
  syncBuiltinESMExports();
  t.after(() => { enumeration.mock.restore(); syncBuiltinESMExports(); });
  assert.throws(() => rsiDirectoryBytes(tree),
    error => error.code === 'blocked-rsi-root');
  assert.equal(readFileSync(join(target, 'value'), 'utf8'), 'foreign');
});

test('RSI accounting still refuses nested links and canonical aliases including missing targets', t => {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'rsi-accounting-guards-')));
  t.after(() => rmSync(root, { recursive: true }));
  const tree = join(root, 'tree'), target = join(root, 'target');
  mkdirSync(join(tree, 'deep'), { recursive: true });
  mkdirSync(target);
  const alias = join(tree, 'deep', 'alias');
  symlinkSync(target, alias, 'junction');
  assert.throws(() => rsiDirectoryBytes(tree), /linked or unsupported/);
  rmSync(alias);
  writeFileSync(join(tree, 'value'), 'original');
  linkSync(join(tree, 'value'), join(tree, 'deep', 'linked'));
  assert.throws(() => rsiDirectoryBytes(tree), /linked or unsupported/);
  const missing = join(tree, 'deep', 'missing', 'value');
  assert.equal(inspectRsiPath(tree, missing, { missing: true }), missing);
  t.mock.method(realpathSync, 'native', path => `${path}-different-canonical-path`);
  assert.throws(() => inspectRsiPath(tree, missing, { missing: true }), /canonical path alias/);
  assert.equal(existsSync(join(tree, 'deep', 'missing')), false);
});

test('interrupted marker initialization requires its exact store identity', async t => {
  const ctx = fixture(t);
  assert.throws(() => initializeSelfImprovement(ctx.policy, {
    ...ctx.options, afterMarker: () => { throw new Error('simulated initialization interruption'); }
  }), /simulated initialization/);
  const status = await selfImprovementStatus(ctx.policy, ctx.options);
  assert.equal(status.state, 'initialization-incomplete');
  assert.throws(() => ctx.initialize(), /explicit initialization resume/);
  assert.throws(() => initializeSelfImprovement(ctx.policy, {
    ...ctx.options, resume: true, expectedStoreId: 'wrong'
  }), /store ID changed/);
  assert.equal(initializeSelfImprovement(ctx.policy, {
    ...ctx.options, resume: true, expectedStoreId: status.storeId
  }).storeId, status.storeId);
  assert.equal((await selfImprovementStatus(ctx.policy, ctx.options)).state, 'initialized');
});

test('RSI observations and preparations are immutable, exact-source-bound and idempotent', t => {
  const ctx = fixture(t);
  ctx.initialize();
  const store = ctx.open();
  const observation = recordSelfImprovementObservation(store, selfImprovementWorkload());
  assert.deepEqual(recordSelfImprovementObservation(store, selfImprovementWorkload()), observation);
  assert.throws(() => recordSelfImprovementObservation(store, { ...selfImprovementWorkload(), provenance: 'live' }),
    /Only the pinned synthetic/);
  const experiment = prepare(store);
  assert.deepEqual(prepare(store), experiment);
  assert.deepEqual(prepareSelfImprovementExperiment(store, {
    observationVersion: 1, observationId: observation.id
  }), experiment);
  assert.equal(experiment.purpose, 'current-current-qualification');
  assert.match(experiment.identity.evaluatorSha256, /^[a-f0-9]{64}$/);
  assert.match(experiment.identity.dependenciesSha256, /^[a-f0-9]{64}$/);
  assert.throws(() => store.ledger.put({ ...experiment, family: 'different' }), /Invalid selfImprovementExperiment/);
  assert.throws(() => store.ledger.db.exec('UPDATE records SET version=2'), /immutable/);
  assert.throws(() => openSelfImprovementStore({ ...ctx.policy, stateOwner: 'another-owner' },
    ctx.options), /identity differs/);
  assert.throws(() => prepareSelfImprovementExperiment(store, {
    observationId: experiment.id, observationVersion: 1
  }), /Missing or changed synthetic observation/);
});

test('initialization resume refuses interrupted database sidecars before opening the database', t => {
  const ctx = fixture(t);
  assert.throws(() => initializeSelfImprovement(ctx.policy, {
    ...ctx.options, afterMarker: () => { throw new Error('synthetic initialization interruption'); }
  }), /synthetic initialization interruption/);
  const root = join(ctx.checkoutRoot, ctx.policy.stateDirectory);
  const marker = JSON.parse(readFileSync(join(root, '.rsi-root.json')));
  const ledger = new Ledger(root);
  ledger.db.exec('PRAGMA journal_mode=DELETE');
  ledger.close();
  writeFileSync(join(root, 'ledger.sqlite-wal'), 'synthetic interrupted sidecar');
  const before = files(root);
  assert.throws(() => initializeSelfImprovement(ctx.policy, {
    ...ctx.options, resume: true, expectedStoreId: marker.storeId
  }), /sidecars require explicit reconciliation/);
  assert.deepEqual(files(root), before);
});

test('reserve consumes one attempt, stale versions cannot execute and abandonment does not refund', async t => {
  const ctx = fixture(t);
  ctx.initialize();
  const store = ctx.open(), prepared = prepare(store);
  assert.throws(() => reserveSelfImprovementEvaluation(store, prepared.id, 99), /exact never-evaluated/);
  const reserved = reserveSelfImprovementEvaluation(store, prepared.id, prepared.version);
  assert.equal(selfImprovementOperation(store, reserved).detail.budgetConsumed, true);
  assert.throws(() => reserveSelfImprovementEvaluation(store, reserved.id, reserved.version),
    /exact never-evaluated/);
  const disposition = { action: 'abandon', expectedVersion: reserved.version,
    experimentId: reserved.id, operatorConfirmedStopped: true, reason: 'Synthetic interrupted evaluation abandoned',
    storeId: store.marker.storeId };
  await assert.rejects(recordSelfImprovementDecision(store, disposition), /process remains present/);
  updateSelfImprovementOperation(store, reserved, { ownerCompleted: true });
  updateSelfImprovementOperation(store, reserved, {
    children: [{ pid: process.pid, exited: false }]
  });
  await assert.rejects(recordSelfImprovementDecision(store, disposition), /process remains present/);
  updateSelfImprovementOperation(store, reserved, { children: [] });
  const abandoned = await recordSelfImprovementDecision(store, disposition);
  assert.equal(abandoned.state, 'abandoned');
  assert.equal(selfImprovementOperation(store, abandoned).detail.budgetConsumed, true);
  assert.deepEqual(prepare(store), abandoned);
  await assert.rejects(recordSelfImprovementDecision(store, { ...disposition, action: 'promote' }),
    /no promotion/);
  assert.throws(() => persistSelfImprovementArtifact(store, abandoned, 'late.json', {}),
    /current reserved evaluation/);
});

test('distinct roots cannot share experiment identities or execution grants', t => {
  const first = fixture(t), second = fixture(t);
  first.initialize();
  second.initialize();
  const one = prepare(first.open()), two = prepare(second.open());
  assert.deepEqual(one.identity, two.identity);
  assert.equal(one.policySha256, two.policySha256);
  assert.notEqual(one.id, two.id);
});

test('source-family admission has a finite nonrefundable two-version bound', t => {
  const source = fixture(t), target = fixture(t);
  source.initialize();
  target.initialize();
  const template = prepare(source.open()), store = target.open();
  const observation = recordSelfImprovementObservation(store, selfImprovementWorkload());
  const request = { observationId: observation.id, observationVersion: 1 };
  for (const index of [1, 2]) {
    const identity = { ...template.identity, sourceSha256: hash(`historical-synthetic-source-${index}`) };
    const id = `rsi-experiment-${hash(json([request, identity, template.policySha256, store.marker.storeId]))}`;
    store.ledger.put({ ...template, id, identity });
    store.ledger.put({ ...template, id, identity, version: 2, state: 'abandoned' });
  }
  assert.equal(store.ledger.latest('selfImprovementExperiment').length, 2);
  assert.throws(() => prepareSelfImprovementExperiment(store, request), /family admission budget exhausted/);
  assert.equal(store.ledger.latest('selfImprovementExperiment').length, 2);
});

test('RSI partial/orphaned evidence is retained, never auto-adopted, retried or pruned', async t => {
  const ctx = fixture(t);
  ctx.initialize();
  const store = ctx.open();
  const prepared = prepare(store);
  const reserved = reserveSelfImprovementEvaluation(store, prepared.id, prepared.version);
  persistSelfImprovementArtifact(store, reserved, 'inputs.json', { partial: true });
  writeFileSync(join(store.root, 'runs', reserved.id, 'orphan.json'), '{"unregistered":true}');
  updateSelfImprovementOperation(store, reserved, { ownerCompleted: true });
  const before = files(store.root);
  const status = await selfImprovementStatus(ctx.policy, ctx.options);
  assert.equal(status.experiments[0].evidence.state, 'uncertain-or-invalid');
  assert.deepEqual(files(store.root), before);
  await assert.rejects(recordSelfImprovementDecision(store, {
    action: 'adopt-sealed-completion', expectedVersion: reserved.version, experimentId: reserved.id,
    operatorConfirmedStopped: true, reason: 'Attempting adoption of intentionally incomplete fixture',
    storeId: store.marker.storeId
  }), /unsealed, incomplete, duplicated or orphaned/);
  assert.deepEqual(files(store.root), before);
  assert.throws(() => persistSelfImprovementArtifact(store, reserved, 'orphan.json', '{}'), /Unregistered/);
});

test('RSI artifact ceiling is enforced before writing and execution requires explicit approval', t => {
  const ctx = fixture(t);
  ctx.policy.limits.maxArtifactBytes = 32;
  ctx.initialize();
  const store = ctx.open(), prepared = prepare(store);
  const reserved = reserveSelfImprovementEvaluation(store, prepared.id, prepared.version);
  assert.throws(() => persistSelfImprovementArtifact(store, reserved, 'too-large.json', { large: 'x'.repeat(40) }),
    /storage ceiling/);
  assert.equal(existsSync(join(store.root, 'runs')), false);
  assert.throws(() => { store.policy.executionApproved = false; }, TypeError);
  const disabled = fixture(t);
  disabled.policy.executionApproved = false;
  disabled.initialize();
  assert.throws(() => reserveSelfImprovementEvaluation(disabled.open(), prepared.id, prepared.version),
    /explicit policy approval/);
});

test('RSI CLI rejects role/product/config drift and status bypasses ordinary creation/pruning', t => {
  const temporary = mkdtempSync(join(tmpdir(), 'rsi-cli-test-'));
  const policy = JSON.parse(readFileSync(new URL('../scaffold/self-improvement.example.json', import.meta.url)));
  policy.stateDirectory = `.state/rsi/cli-test-${uuid()}`;
  const root = join(selfImprovementRoot, policy.stateDirectory);
  const policyFile = join(temporary, 'rsi.local.json');
  writeFileSync(policyFile, json(policy));
  t.after(() => {
    rmSync(temporary, { recursive: true, force: true });
    if (existsSync(root)) rmSync(root, { recursive: true, force: true });
  });
  const cli = args => spawnSync(process.execPath, [
    join(selfImprovementRoot, 'src', 'cli.js'), ...args
  ], { cwd: selfImprovementRoot, encoding: 'utf8', windowsHide: true, timeout: 30000 });
  let result = cli(['self-improvement', 'status', '--policy', policyFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout).state, 'uninitialized');
  assert.equal(existsSync(root), false);
  for (const [args, code] of [
    [['agent', 'proposer', 'self-improvement', 'status', '--policy', policyFile], 'blocked-scope'],
    [['self-improvement', 'status', '--policy', policyFile, '--config', 'not-readable.local.json'], 'blocked-scope'],
    [['self-improvement', 'status', '--policy', policyFile, '--policy', policyFile], 'blocked-scope'],
    [['self-improvement', 'rollout', '--policy', policyFile], 'blocked-scope'],
    [['self-improvement', 'init', '--policy', policyFile, '--resume'], 'blocked-reconciliation']
  ]) {
    result = cli(args);
    assert.equal(result.status, 1);
    assert.equal(cliError(result.stderr).code, code, result.stderr);
    assert.equal(existsSync(root), false);
  }
  result = cli(['self-improvement', 'init', '--policy', policyFile]);
  assert.equal(result.status, 0, result.stderr);
  const before = files(root);
  result = cli(['self-improvement', 'status', '--policy', policyFile]);
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(files(root), before);
});
