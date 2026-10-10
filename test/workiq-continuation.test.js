import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAt, json } from '../src/common.js';
import { beginApp, openApp, appStatus, appendApp, prepareWorkiqContinuation, threadContext } from '../src/app-native.js';
import { collectCliWorkiq, reconcileCliWorkiq } from '../src/cli-collection.js';
import { principalPath, channelRoot } from '../src/runtime.js';

const pass = 'workiq:created';
const wrapped = data => ({ structuredContent: { results: [{ statusCode: 200, data }] } });
const message = (id, createdDateTime = '2026-10-08T01:00:00Z', extra = {}) => ({
  id, createdDateTime, lastModifiedDateTime: createdDateTime,
  body: { contentType: 'text', content: `Synthetic ${id}` }, ...extra
});
function setup(t, limits = {}) {
  const config = configAt('pilot.example.json');
  config.stateDirectory = mkdtempSync(join(tmpdir(), 'workiq-continuation-'));
  config.statePolicy.accessApproved = true;
  config.sources.workiq.enabled = true; config.sources.workiq.scopeApproved = true;
  config.runtime.workiqCli = { enabled: true, executable: process.execPath, packageVersion: '1.0.1', timeoutMs: 1000 };
  Object.assign(config.dryRun.limits, limits);
  beginApp(config, { runId: 'first', dryRun: true, provenance: 'app-tool' });
  const { ledger } = openApp(config, 'first');
  t.after(() => { ledger.close(); rmSync(config.stateDirectory, { recursive: true, force: true }); });
  return { config, ledger };
}
function client(config, pages) {
  const reads = [];
  return { reads, factory: async () => ({
    read: async path => {
      reads.push(path);
      if (reads.length === 1) {
        assert.equal(path, principalPath);
        return wrapped({ id: config.identity.objectId, userPrincipalName: config.identity.designatedUser });
      }
      assert.ok(pages.length, `Unexpected read: ${path}`);
      const page = pages.shift();
      return typeof page === 'function' ? page(path) : wrapped(page);
    },
    close: async () => {}
  }) };
}
const selection = result => result.collection.find(p => p.pass === pass);
const continuation = (fromRunId = 'first', runId = 'second', selectedPass = pass) =>
  ({ fromRunId, runId, pass: selectedPass, additionalBudgetApproved: true });

test('root page tail survives two independently authorized continuations without root refetch', async t => {
  const { config, ledger } = setup(t, { maxItems: 1, maxCalls: 10 });
  const first = client(config, [{ value: [message('a'), message('b'), message('c')] }]);
  const original = selection(await collectCliWorkiq(config, ledger, 'first', first.factory));
  assert.equal(original.unexaminedReturnedRecords, 2);
  const originalState = json(original);
  const prepared = await prepareWorkiqContinuation(config, continuation());
  assert.equal(prepared.continuation.inheritedBufferedRecords, 2);
  assert.equal(prepared.continuation.additionalBudget.maxItems, 1);
  assert.equal((await prepareWorkiqContinuation(config, continuation())).runId, 'second');
  await assert.rejects(prepareWorkiqContinuation(config, continuation('first', 'competing')), /reserved/);
  const second = openApp(config, 'second').ledger;
  try {
    const source = client(config, []);
    const result = selection(await collectCliWorkiq(config, second, 'second', source.factory));
    assert.equal(result.state, 'partial');
    assert.equal(result.examinedRecords, 1);
    assert.equal(result.cumulativeExaminedRecords, 2);
    assert.equal(result.unexaminedReturnedRecords, 1);
    assert.deepEqual(source.reads, [principalPath]);
    assert.equal(result.evidenceCount, 2);
    const context = threadContext(second, 'second', pass);
    assert.equal(context.find(c => c.messageId === 'b').observation.runId, 'first');
    assert.equal(context.find(c => c.messageId === 'b').observation.observedAt,
      threadContext(ledger, 'first', pass)[0].observation.observedAt);
  } finally { second.close(); }
  await prepareWorkiqContinuation(config, continuation('second', 'third'));
  const third = openApp(config, 'third').ledger;
  try {
    const source = client(config, [{ value: [] }, { value: [] }, { value: [] }]);
    const result = selection(await collectCliWorkiq(config, third, 'third', source.factory));
    assert.equal(result.state, 'complete');
    assert.equal(result.examinedRecords, 1);
    assert.equal(result.cumulativeExaminedRecords, 3);
    assert.equal(result.evidenceCount, 3);
    assert.equal(result.returnedRecords, 0);
    assert.ok(source.reads.slice(1).every(path => path.includes('/replies')));
    assert.equal(third.all('evidence').length, 3);
    assert.ok(third.cursor(`app:${pass}`));
  } finally { third.close(); }
  assert.equal(json(selection(appStatus(ledger, 'first'))), originalState);
  assert.equal(ledger.cursor(`app:${pass}`), null);
});

test('reply tail preserves root context and both reply/root nextLinks across a budget stop', async t => {
  const { config, ledger } = setup(t, { maxItems: 3, maxCalls: 10 });
  let rootNext;
  const original = client(config, [
    path => { rootNext = `${path}&$skiptoken=roots`; return wrapped({
      value: [message('old', '2026-01-01T00:00:00Z')], '@odata.nextLink': rootNext
    }); },
    path => wrapped({ value: ['a', 'b', 'c', 'd'].map(id => message(id)),
      '@odata.nextLink': `${path}&$skiptoken=replies` })
  ]);
  const partial = selection(await collectCliWorkiq(config, ledger, 'first', original.factory));
  assert.equal(partial.unexaminedReturnedRecords, 2);
  assert.equal(partial.cumulativeTraversal.threadsExhausted, 0);
  await prepareWorkiqContinuation(config, continuation());
  const child = openApp(config, 'second').ledger;
  try {
    const source = client(config, [
      path => { assert.match(path, /skiptoken=replies/); return wrapped({ value: [message('e')] }); },
      path => { assert.match(path, /skiptoken=roots/); return wrapped({ value: [] }); }
    ]);
    const result = selection(await collectCliWorkiq(config, child, 'second', source.factory));
    assert.equal(result.state, 'complete'); assert.equal(result.examinedRecords, 3);
    assert.equal(result.evidenceCount, 5); assert.equal(result.readCalls, 3);
    assert.equal(result.cumulativeTraversal.threadsExhausted, 1);
    const contexts = threadContext(child, 'second', pass);
    assert.equal(contexts.length, 6);
    const c = contexts.find(row => row.messageId === 'c');
    assert.equal(c.rootId, 'old'); assert.equal(c.parentContext.id, 'old');
    assert.equal(c.observation.runId, 'first'); assert.equal(c.parentObservation.runId, 'first');
    assert.equal(contexts.find(row => row.messageId === 'e').observation.runId, 'second');
    assert.ok(result.cursor.coverage.every(c => !c.snapshotConsistent));
  } finally { child.close(); }
});

test('read-call continuation never repeats a previously received page and counts fresh identity', async t => {
  const { config, ledger } = setup(t, { maxCalls: 2 });
  const source = client(config, [{ value: [message('root')] }]);
  assert.equal(selection(await collectCliWorkiq(config, ledger, 'first', source.factory)).readCalls, 2);
  await prepareWorkiqContinuation(config, continuation());
  const child = openApp(config, 'second').ledger;
  try {
    const followup = client(config, [path => {
      assert.match(path, /root\/replies/);
      return wrapped({ value: [message('reply')] });
    }]);
    const result = selection(await collectCliWorkiq(config, child, 'second', followup.factory));
    assert.equal(result.state, 'complete'); assert.equal(result.readCalls, 2);
    assert.equal(result.inheritedReadCalls, 1);
    assert.equal(result.examinedRecords, 1); assert.equal(result.evidenceCount, 2);
  } finally { child.close(); }
});

test('continuation rejects missing authorization, scope changes, pending reservations and active ownership', async t => {
  const { config, ledger } = setup(t, { maxItems: 1 });
  await collectCliWorkiq(config, ledger, 'first', client(config, [{ value: [message('a'), message('b')] }]).factory);
  await assert.rejects(prepareWorkiqContinuation(config, { ...continuation(), additionalBudgetApproved: false }), /authorization/);
  await assert.rejects(prepareWorkiqContinuation(config, continuation('first', 'first')), /distinct/);
  const changed = structuredClone(config); changed.sources.workiq.seeds[0].channelId = 'another-channel';
  await assert.rejects(prepareWorkiqContinuation(changed, continuation()), /configuration changed/);
  const owner = ledger.acquire('cli-workiq:first');
  await assert.rejects(prepareWorkiqContinuation(config, continuation()), /Ownership held/);
  ledger.release('cli-workiq:first', owner);
  ledger.operation('workiq-continuation:first:workiq:created', 'first', 'workiq-continuation-reservation',
    { input: continuation() });
  await assert.rejects(prepareWorkiqContinuation(config, continuation()), /[Rr]eserved/);
});

test('incomplete continuation preparation cannot launch a client or import receipts', async t => {
  const { config } = setup(t);
  beginApp(config, { runId: 'unfinished', dryRun: true, provenance: 'app-tool', continuationFrom: 'first' });
  const child = openApp(config, 'unfinished').ledger;
  try {
    await assert.rejects(collectCliWorkiq(config, child, 'unfinished', () => assert.fail('No launch')), /incomplete/);
    await assert.rejects(appendApp(config, child, 'unfinished', { eventId: 'x', pass, calls: [{}] }), /incomplete/);
  } finally { child.close(); }
});

test('auth failures cannot become continuations and block changed-pass retry', async t => {
  const { config, ledger } = setup(t);
  const source = client(config, [{ value: [message('a')] },
    () => ({ structuredContent: { results: [{ statusCode: 401, data: null }] } })]);
  assert.equal(selection(await collectCliWorkiq(config, ledger, 'first', source.factory)).state, 'blocked-auth');
  await assert.rejects(prepareWorkiqContinuation(config, continuation()), /budget-stopped|authentication/);
  await assert.rejects(collectCliWorkiq(config, ledger, 'first', () => assert.fail('No cross-pass launch'), 'workiq:changed'), /cross-pass/);
});

test('expired continuation fails visibly without restart, fallback, or cursor', async t => {
  const { config, ledger } = setup(t, { maxCalls: 2 });
  await collectCliWorkiq(config, ledger, 'first', client(config, [
    path => wrapped({ value: [], '@odata.nextLink': `${path}&$skiptoken=expiring` })
  ]).factory);
  await prepareWorkiqContinuation(config, continuation());
  const child = openApp(config, 'second').ledger;
  try {
    const source = client(config, [path => {
      assert.match(path, /skiptoken=expiring/);
      return { structuredContent: { results: [{ statusCode: 410, data: null }] } };
    }]);
    const result = selection(await collectCliWorkiq(config, child, 'second', source.factory));
    assert.equal(result.state, 'failed-source');
    assert.equal(source.reads.length, 2); assert.equal(result.continuation, null);
    assert.equal(child.cursor(`app:${pass}`), null);
  } finally { child.close(); }
});

test('dedup retains different content versions and counts duplicate returned rows against budget', async t => {
  const { config, ledger } = setup(t);
  const first = message('root'), edited = message('root', first.createdDateTime, {
    lastModifiedDateTime: '2026-10-08T02:00:00Z', body: { contentType: 'text', content: 'Edited synthetic' }
  });
  const source = client(config, [{ value: [first, first, edited] },
    { value: [message('reply'), message('reply')] }]);
  const result = selection(await collectCliWorkiq(config, ledger, 'first', source.factory));
  assert.equal(result.state, 'complete');
  assert.equal(result.examinedRecords, 5); assert.equal(result.evidenceCount, 3);
  assert.equal(result.duplicateVersions, 2); assert.equal(result.unexaminedReturnedRecords, 0);
  assert.equal(source.reads.length, 3);
  assert.equal(ledger.all('evidence').filter(e => e.source.recordId === 'root').length, 2);
  assert.equal(ledger.all('evidence').find(e => e.source.recordId === 'reply').fields.parentContext.body.content,
    'Edited synthetic');
});

test('duplicates cannot mask a budget stop or discard buffered distinct versions', async t => {
  const { config, ledger } = setup(t, { maxItems: 1 });
  const source = client(config, [{ value: [message('a'), message('a'), message('b')] }]);
  const result = selection(await collectCliWorkiq(config, ledger, 'first', source.factory));
  assert.equal(result.examinedRecords, 1); assert.equal(result.unexaminedReturnedRecords, 2);
  await prepareWorkiqContinuation(config, continuation());
  const child = openApp(config, 'second').ledger;
  try {
    const result2 = selection(await collectCliWorkiq(config, child, 'second', client(config, []).factory));
    assert.equal(result2.examinedRecords, 1); assert.equal(result2.duplicateVersions, 1);
    assert.equal(result2.evidenceCount, 1); assert.equal(result2.unexaminedReturnedRecords, 1);
  } finally { child.close(); }
});

test('changed lane includes edits on old roots/replies and preserves tombstones without claiming history', async t => {
  const { config, ledger } = setup(t);
  const source = client(config, [{ value: [
    message('edited-root', '2026-01-01T00:00:00Z', { lastModifiedDateTime: '2026-10-08T02:00:00Z' }),
    message('old-root', '2026-01-01T00:00:00Z')
  ] }, { value: [message('deleted-reply', '2026-01-01T00:00:00Z', {
    replyToId: 'edited-root', lastModifiedDateTime: '2026-10-08T03:00:00Z',
    deletedDateTime: '2026-10-08T03:00:00Z', body: null
  })] }, { value: [message('new-reply')] }]);
  const status = await collectCliWorkiq(config, ledger, 'first', source.factory, 'workiq:changed');
  const result = status.collection.find(p => p.pass === 'workiq:changed');
  assert.equal(result.state, 'complete'); assert.equal(result.evidenceCount, 3);
  assert.equal(threadContext(ledger, 'first', 'workiq:changed').length, 4);
  assert.ok(ledger.all('evidence').every(e => e.fields.selectionLane === 'changed'));
  assert.equal(ledger.all('evidence').find(e => e.source.recordId === 'deleted-reply').fields.message.body, null);
  assert.ok(ledger.cursor('app:workiq:changed'));
  assert.equal(ledger.cursor('app:workiq:created'), null);
});

test('changed lane missing modified timestamp fails explicitly, not a complete empty scan', async t => {
  const { config, ledger } = setup(t);
  const value = message('root'); delete value.lastModifiedDateTime;
  const status = await collectCliWorkiq(config, ledger, 'first', client(config, [{ value: [value] }]).factory, 'workiq:changed');
  assert.equal(status.collection.find(p => p.pass === 'workiq:changed').state, 'blocked-protocol');
  assert.equal(ledger.cursor('app:workiq:changed'), null);
});

test('replies with a contradictory parent identity are rejected before evidence acceptance', async t => {
  const { config, ledger } = setup(t);
  const source = client(config, [{ value: [message('root')] },
    { value: [message('reply', undefined, { replyToId: 'other-root' })] }]);
  const status = await collectCliWorkiq(config, ledger, 'first', source.factory);
  assert.equal(selection(status).state, 'blocked-scope');
  assert.equal(ledger.all('evidence').length, 1);
});

test('offline reconciliation retains a fully received budget checkpoint rather than retrying', async t => {
  const { config, ledger } = setup(t, { maxItems: 1 });
  const result = await collectCliWorkiq(config, ledger, 'first',
    client(config, [{ value: [message('a'), message('b')] }]).factory);
  assert.ok(selection(result).continuation);
  ledger.db.prepare("UPDATE operations SET state='started' WHERE id='cli-workiq:first'").run();
  const reconciled = await reconcileCliWorkiq(config, ledger, 'first');
  assert.ok(selection(reconciled).continuation);
  await prepareWorkiqContinuation(config, continuation());
});

test('receipt-import continuations preserve imported provenance even when the child uses local CLI', async t => {
  const { config, ledger } = setup(t, { maxItems: 1 });
  const observedAt = '2026-10-09T01:00:00Z';
  const root = `${channelRoot(config.sources.workiq.seeds[0])}?$select=id,createdDateTime&$top=50`;
  const receipt = (id, path, data) => ({ id, observedAt, tool: 'workiq-fetch',
    request: { entityUrls: [path] }, response: { results: [{ statusCode: 200, data }] } });
  await appendApp(config, ledger, 'first', { eventId: 'import', pass, calls: [
    receipt('identity', principalPath, { id: config.identity.objectId, userPrincipalName: config.identity.designatedUser }),
    receipt('roots', root, { value: [message('a'), message('b')] })
  ] });
  await prepareWorkiqContinuation(config, continuation());
  const child = openApp(config, 'second').ledger;
  try {
    const result = await collectCliWorkiq(config, child, 'second', client(config, [{ value: [] }, { value: [] }]).factory);
    assert.equal(selection(result).state, 'complete');
    assert.ok(child.all('evidence').every(e => e.source.provenance === 'app-tool-reported' && e.observedAt === observedAt));
  } finally { child.close(); }
});

test('pagination cycles are not mislabeled as continuable budget stops', async t => {
  const { config, ledger } = setup(t);
  const source = client(config, [path => wrapped({ value: [], '@odata.nextLink': path })]);
  const result = selection(await collectCliWorkiq(config, ledger, 'first', source.factory));
  assert.equal(result.state, 'partial');
  assert.equal(result.continuation, null);
  assert.equal(source.reads.length, 2);
  await assert.rejects(prepareWorkiqContinuation(config, continuation()), /reconstructed/);
});

test('changed-pass continuations stay lane-bound and independently count edits', async t => {
  const { config, ledger } = setup(t, { maxItems: 1 });
  const modified = id => message(id, '2026-01-01T00:00:00Z', { lastModifiedDateTime: '2026-10-08T01:00:00Z' });
  await collectCliWorkiq(config, ledger, 'first', client(config, [{ value: [modified('a'), modified('b')] }]).factory,
    'workiq:changed');
  await prepareWorkiqContinuation(config, continuation('first', 'second', 'workiq:changed'));
  const child = openApp(config, 'second').ledger;
  try {
    await assert.rejects(collectCliWorkiq(config, child, 'second', () => assert.fail('No wrong-lane client')), /incomplete|different/);
    const result = await collectCliWorkiq(config, child, 'second', client(config, [{ value: [] }, { value: [] }]).factory,
      'workiq:changed');
    assert.equal(result.collection.find(p => p.pass === 'workiq:changed').state, 'complete');
    assert.equal(child.all('evidence').length, 2);
  } finally { child.close(); }
});

test('continuation verifies the current identity before accepting buffered records', async t => {
  const { config, ledger } = setup(t, { maxItems: 1 });
  await collectCliWorkiq(config, ledger, 'first', client(config, [{ value: [message('a'), message('b')] }]).factory);
  await prepareWorkiqContinuation(config, continuation());
  const child = openApp(config, 'second').ledger;
  try {
    let calls = 0;
    const result = await collectCliWorkiq(config, child, 'second', async () => ({
      read: async path => { calls++; assert.equal(path, principalPath); return wrapped({ id: 'wrong' }); },
      close: async () => {}
    }));
    assert.equal(calls, 1);
    assert.equal(selection(result).state, 'blocked-auth');
    assert.equal(child.all('evidence').length, 0);
    assert.equal(threadContext(child, 'second', pass).length, 0);
  } finally { child.close(); }
});

test('interrupted child preparation recovers the same reservation offline without a second child', async t => {
  const { config, ledger } = setup(t, { maxItems: 1 });
  await collectCliWorkiq(config, ledger, 'first', client(config, [{ value: [message('a'), message('b')] }]).factory);
  await prepareWorkiqContinuation(config, continuation());
  const child = openApp(config, 'second').ledger;
  let snapshot;
  try {
    snapshot = JSON.parse(child.db.prepare('SELECT body FROM app_workiq_continuations').get().body);
  } finally { child.close(); }
  // Model a crash after reservation but before creating the child's database.
  rmSync(join(config.stateDirectory, 'app-native', 'dry-runs', 'second'), { recursive: true, force: true });
  ledger.db.prepare("UPDATE operations SET state='started',detail=? WHERE id='workiq-continuation:first:workiq:created'")
    .run(json({ input: continuation(), continuation: snapshot }));
  const recovered = await prepareWorkiqContinuation(config, continuation());
  assert.equal(recovered.runId, 'second');
  assert.equal(recovered.continuation.callsHash, snapshot.callsHash);
  assert.ok(recovered.collection.every(p => p.state === 'not-started'));
  await assert.rejects(prepareWorkiqContinuation(config, continuation('first', 'third')), /reserved/);
});

test('metadata-only projection cannot start an edit scan', async t => {
  const { config } = setup(t);
  config.sources.workiq.projection = 'id,createdDateTime';
  beginApp(config, { runId: 'metadata', dryRun: true, provenance: 'app-tool' });
  const child = openApp(config, 'metadata').ledger;
  try {
    await assert.rejects(collectCliWorkiq(config, child, 'metadata', () => assert.fail('No launch'), 'workiq:changed'),
      /lastModifiedDateTime/);
  } finally { child.close(); }
});

test('changed-lane startup and first-identity failures persist a terminal pass', async t => {
  const { config, ledger } = setup(t);
  const result = await collectCliWorkiq(config, ledger, 'first', async () => ({
    read: async () => wrapped({ id: 'wrong', userPrincipalName: 'wrong@example.invalid' }),
    close: async () => {}
  }), 'workiq:changed');
  assert.equal(result.collection.find(p => p.pass === 'workiq:changed').state, 'blocked-auth');
  assert.equal(ledger.cursor('app:workiq:changed'), null);
});

test('empty interrupted changed-lane journal reconciles without another launch', async t => {
  const { config, ledger } = setup(t);
  ledger.operation('cli-workiq:first:changed', 'first', 'local-workiq-cli-collection', {});
  const result = await reconcileCliWorkiq(config, ledger, 'first', 'workiq:changed');
  assert.equal(result.collection.find(p => p.pass === 'workiq:changed').state, 'blocked-reconciliation');
});

test('imported continuation identity failure is recorded without processing its inherited buffer', async t => {
  const { config, ledger } = setup(t, { maxItems: 1 });
  await collectCliWorkiq(config, ledger, 'first', client(config, [
    { value: [message('a'), message('b'), message('c'), message('d')] }
  ]).factory);
  await prepareWorkiqContinuation(config, continuation());
  const child = openApp(config, 'second').ledger;
  try {
    const result = await appendApp(config, child, 'second', { eventId: 'failed-me', pass, calls: [{
      id: 'failed-me', observedAt: '2026-10-10T01:00:00Z', tool: 'workiq-fetch',
      request: { entityUrls: [principalPath] }, failure: { code: 'blocked-auth', statusCode: 401 }
    }] });
    assert.equal(selection(result).state, 'blocked-auth');
    assert.equal(selection(result).examinedRecords, 0);
    assert.equal(selection(result).returnedRecords, 0);
    assert.equal(selection(result).continuation, null);
    assert.equal(child.all('evidence').length, 0);
    assert.equal(threadContext(child, 'second', pass).length, 0);
  } finally { child.close(); }
});

test('transport cleanup failure retains the previous cursor even after terminal page receipt', async t => {
  const { config, ledger } = setup(t);
  ledger.db.prepare('INSERT INTO cursors VALUES(?,?)').run(`app:${pass}`, json({ end: 'previous' }));
  const source = client(config, [{ value: [] }]);
  await assert.rejects(collectCliWorkiq(config, ledger, 'first', async readConfig => ({
    ...await source.factory(readConfig),
    close: async () => { throw new Error('Synthetic close failure'); }
  })), /Synthetic close failure/);
  assert.deepEqual(ledger.cursor(`app:${pass}`), { end: 'previous' });
  assert.notEqual(selection(appStatus(ledger, 'first')).state, 'complete');
});

test('CLI exposes offline continuation authorization and durable thread-context output', async t => {
  const { config, ledger } = setup(t, { maxItems: 1 });
  await collectCliWorkiq(config, ledger, 'first', client(config, [{ value: [message('a'), message('b')] }]).factory);
  const configPath = join(config.stateDirectory, 'synthetic-config.json');
  writeFileSync(configPath, json(config));
  const command = (...args) => spawnSync(process.execPath,
    [fileURLToPath(new URL('../src/cli.js', import.meta.url)), ...args, '--config', configPath],
    { encoding: 'utf8', timeout: 30000 });
  const denied = command('app-workiq-continue', '--from-run', 'first', '--run', 'second');
  assert.equal(denied.status, 1); assert.match(denied.stderr, /authorization/);
  const prepared = command('app-workiq-continue', '--from-run', 'first', '--run', 'second',
    '--authorize-additional-budget');
  assert.equal(prepared.status, 2, prepared.stderr);
  const status = JSON.parse(prepared.stdout);
  assert.equal(status.continuation.parentRunId, 'first');
  assert.equal(status.continuation.inheritedBufferedRecords, 1);
  const context = command('app-thread-context', '--run', 'first');
  assert.equal(context.status, 0, context.stderr);
  assert.equal(JSON.parse(context.stdout)[0].messageId, 'a');
});

test('cleanup failure cannot erase an authentication blocker and permit a cross-pass retry', async t => {
  const { config, ledger } = setup(t);
  await assert.rejects(collectCliWorkiq(config, ledger, 'first', async () => ({
    read: async () => wrapped({ id: 'wrong', userPrincipalName: 'wrong@example.invalid' }),
    close: async () => { throw new Error('Synthetic cleanup failure'); }
  })), /cleanup failure/);
  assert.equal(selection(appStatus(ledger, 'first')).state, 'blocked-auth');
  await assert.rejects(collectCliWorkiq(config, ledger, 'first', () => assert.fail('No retry'), 'workiq:changed'),
    /cross-pass/);
});
