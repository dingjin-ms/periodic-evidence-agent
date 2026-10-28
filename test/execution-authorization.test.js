import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { alReference } from '../src/al-adapter.js';
import { bindAlModelExecution } from '../src/al-workflow.js';
import { configAt } from '../src/common.js';
import { requireExecutionAuthorization, authorizedModelTimeout } from '../src/execution-authorization.js';
import { commitRepositoryChanges, pushDraftBranch, createAdoDraft } from '../src/workers.js';

function setup(t, standalone = false) {
  const root = mkdtempSync(join(tmpdir(), 'execution-authority-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const started = Date.now(), file = join(root, 'authority.json');
  const repo = { id: 'augloop-workflows', baseRef: 'a'.repeat(40),
    allowedWritePrefixes: [],
    remote: 'https://dev.azure.com/office/ISS/_git/augloop-workflows',
    commitIdentity: { name: 'Synthetic', email: 'synthetic@example.invalid' },
    pr: { provider: 'ado', organization: 'office', project: 'ISS', repositoryId: 'synthetic',
      targetRef: 'refs/heads/main' } };
  const authority = standalone ? {
    format: 'al-e2e-model-allocation-v1', approvedBy: 'parent', model: 'gpt-6-luna',
    repoId: repo.id, baseRevision: repo.baseRef, runDirectory: root,
    maxTotalSessions: 30, priorActualSessions: 0, maxAdditionalSessions: 1,
    purposes: ['proposer'], allowPublication: true,
    deadlineAt: new Date(started + 1000).toISOString()
  } : { format: 'al-recurring-authorization-v1', planSha256: 'c'.repeat(64),
    approvedAt: new Date(started - 1000).toISOString(), expiresAt: new Date(started + 1000).toISOString(),
    allowModels: true, allowPublication: true };
  writeFileSync(file, JSON.stringify(authority));
  const config = { runtime: { timeoutMs: 1000, authoringModel: 'gpt-6-luna', executionAuthorization: {
    reference: alReference(file), repoId: repo.id, baseRevision: repo.baseRef, planSha256: authority.planSha256
  } }, repositories: [repo] };
  if (standalone) bindAlModelExecution(config, alReference(file), root, 1, 'proposer');
  return { root, file, repo, config, started, authority };
}
for (const standalone of [false, true]) {
  const kind = standalone ? 'standalone' : 'recurring';
  test(`${kind} execution guard remains opt-in and caps a running model at the finite authorization deadline`, t => {
    const f = setup(t, standalone);
    t.mock.method(Date, 'now', () => f.started);
    assert.equal(requireExecutionAuthorization({}, f.repo, 'model'), null);
    assert.equal(authorizedModelTimeout({}, f.repo, 5000), 5000);
    assert.equal(authorizedModelTimeout(f.config, f.repo, 5000), 1000);
    assert.throws(() => requireExecutionAuthorization(f.config, { ...f.repo, id: 'other' }, 'push'), /repository\/source/);
    writeFileSync(f.file, '{}');
    assert.throws(() => requireExecutionAuthorization(f.config, f.repo, 'model'), /changed after reservation/);
  });
  test(`${kind} native commit rechecks expiry after staging and prevents the actual commit`, async t => {
    const f = setup(t, standalone);
    let time = f.started;
    t.mock.method(Date, 'now', () => time);
    const calls = [];
    await assert.rejects(commitRepositoryChanges(f.config, f.root, f.repo, 'synthetic', async (_exe, args) => {
      calls.push(args);
      time = f.started + 1001;
      return { stdout: '', stderr: '' };
    }), error => error.code === 'blocked-authorization');
    assert.equal(calls.length, 1);
    assert.ok(calls[0].includes('add'));
    assert.ok(!calls[0].includes('commit'));
  });
  test(`${kind} native push and Draft creation cannot use an authorization that expired during prior native work`, async t => {
    const f = setup(t, standalone);
    t.mock.method(Date, 'now', () => f.started + 1001);
    await assert.rejects(pushDraftBranch(f.config, f.root, f.repo, 'HEAD:refs/heads/synthetic', {
      getToken: () => assert.fail('expired push must not request credentials'),
      execute: () => assert.fail('expired push must not execute')
    }), error => error.code === 'blocked-authorization');
    const calls = [];
    await assert.rejects(createAdoDraft(f.config, { operation: () => assert.fail('no mutation intent') },
      { id: 'synthetic' }, f.repo, 'b'.repeat(40), { title: 'synthetic', description: 'synthetic' },
      async method => { calls.push(method); assert.equal(method, 'GET'); return { value: [] }; }),
    error => error.code === 'blocked-authorization');
    assert.deepEqual(calls, ['GET']);
  });
}

test('standalone allocation is content-, repository-, source-, run-, purpose- and model-bound', t => {
  const f = setup(t, true);
  t.mock.method(Date, 'now', () => f.started);
  for (const mutate of [
    c => { c.runtime.executionAuthorization.repoId = 'other'; },
    c => { c.repositories[0].id = c.runtime.executionAuthorization.repoId = 'other'; },
    c => { c.repositories[0].baseRef = 'b'.repeat(40); },
    c => { c.runtime.executionAuthorization.runDirectory = join(f.root, 'other'); },
    c => { c.runtime.executionAuthorization.purpose = 'filter'; },
    c => { c.runtime.executionAuthorization.sessionCount = 2; },
    c => { c.runtime.authoringModel = 'other'; },
    c => { c.repositories[0].skillBindings = [{ authoringProvider: 'agency-local' }]; }
  ]) {
    const config = structuredClone(f.config); mutate(config);
    assert.throws(() => requireExecutionAuthorization(config, config.repositories[0], 'model'),
      error => error.code === 'blocked-authorization');
  }
  const raw = JSON.parse(readFileSync(new URL('../pilot.example.json', import.meta.url), 'utf8'));
  raw.stateDirectory = f.root;
  raw.runtime = { ...raw.runtime, ...f.config.runtime };
  raw.repositories = [f.repo];
  const path = join(f.root, 'normalized-config.json');
  writeFileSync(path, JSON.stringify(raw));
  const normalized = configAt(path);
  assert.deepEqual(normalized.runtime.executionAuthorization, f.config.runtime.executionAuthorization);
  assert.equal(authorizedModelTimeout(normalized, normalized.repositories[0], 5000), 1000);
});

test('standalone publication needs its explicit grant and cannot borrow FILTER authority', t => {
  const f = setup(t, true);
  t.mock.method(Date, 'now', () => f.started);
  for (const action of ['model', 'commit', 'push', 'draft'])
    assert.doesNotThrow(() => requireExecutionAuthorization(f.config, f.repo, action));
  f.authority.allowPublication = false;
  writeFileSync(f.file, JSON.stringify(f.authority));
  bindAlModelExecution(f.config, alReference(f.file), f.root, 1, 'proposer');
  assert.doesNotThrow(() => requireExecutionAuthorization(f.config, f.repo, 'model'));
  for (const action of ['commit', 'push', 'draft'])
    assert.throws(() => requireExecutionAuthorization(f.config, f.repo, action), /does not permit/);
  f.authority.allowPublication = true;
  f.authority.purposes = ['filter'];
  writeFileSync(f.file, JSON.stringify(f.authority));
  bindAlModelExecution(f.config, alReference(f.file), f.root, 1, 'filter');
  assert.doesNotThrow(() => requireExecutionAuthorization(f.config, f.repo, 'model'));
  assert.throws(() => requireExecutionAuthorization(f.config, f.repo, 'draft'), /does not permit/);
});

test('standalone push and Draft recheck expiry after asynchronous provider work', async t => {
  const f = setup(t, true);
  let time = f.started;
  t.mock.method(Date, 'now', () => time);
  await assert.rejects(pushDraftBranch(f.config, f.root, f.repo, 'HEAD:refs/heads/synthetic', {
    getToken: async () => { time += 1001; return 'synthetic-token'; },
    execute: () => assert.fail('expiry during credential work must prevent push')
  }), error => error.code === 'blocked-authorization');
  time = f.started;
  await assert.rejects(createAdoDraft(f.config, { operation: () => assert.fail('no mutation intent') },
    { id: 'synthetic' }, f.repo, 'b'.repeat(40), { title: 'synthetic', description: 'synthetic' },
    async method => {
      assert.equal(method, 'GET');
      time += 1001;
      return { value: [] };
    }), error => error.code === 'blocked-authorization');
});
