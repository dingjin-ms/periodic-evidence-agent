import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { configAt, json } from '../src/common.js';
import { beginApp, openApp } from '../src/app-native.js';
import { collectCliWorkiq, reconcileCliWorkiq } from '../src/cli-collection.js';
import { cliEnvelope, cliFailure, workiqCli } from '../src/workiq-cli.js';
import { principalPath } from '../src/runtime.js';

function setup(t, limits = {}) {
  const config = configAt('pilot.example.json');
  config.stateDirectory = mkdtempSync(join(tmpdir(), 'cli-collector-'));
  config.statePolicy.accessApproved = true;
  config.sources.workiq.enabled = true; config.sources.workiq.scopeApproved = true;
  config.sources.workiq.projection = 'id,createdDateTime,lastModifiedDateTime,body,webUrl';
  config.runtime.workiqCli = { enabled: true, executable: process.execPath, packageVersion: '1.0.1', timeoutMs: 1000 };
  Object.assign(config.dryRun.limits, limits);
  beginApp(config, { runId: 'cli-test', dryRun: true, provenance: 'app-tool' });
  const { ledger } = openApp(config, 'cli-test');
  t.after(() => { ledger.close(); rmSync(config.stateDirectory, { recursive: true, force: true }); });
  return { config, ledger };
}
const wrapped = data => ({ content: [{ type: 'text', text: json({ results: [{ statusCode: 200, data }] }) }] });
function transport(config, pages) {
  const paths = [];
  let closed = false;
  return { paths, get closed() { return closed; }, factory: async () => ({
    read: async path => {
      paths.push(path);
      if (paths.length === 1) {
        assert.equal(path, principalPath);
        return wrapped({ id: config.identity.objectId, userPrincipalName: config.identity.designatedUser });
      }
      assert.ok(pages.length, 'Unexpected extra source request');
      const page = pages.shift();
      return typeof page === 'function' ? page(path) : page;
    },
    close: async () => { closed = true; }
  }) };
}
const message = (id, createdDateTime = '2026-10-08T01:00:00Z') => ({
  id, createdDateTime, body: { content: 'Synthetic body', contentType: 'text' },
  webUrl: `https://example.invalid/${id}`
});

test('plain-text HTTP failure keeps status without retry or body leakage', async t => {
  const { config, ledger } = setup(t);
  const text = "Remote tool 'fetch' failed: Response status code does not indicate success: 500 (Internal Server Error). Response body: private-diagnostic";
  const tr = transport(config, [{ isError: true, content: [{ type: 'text', text }] }]);
  const result = await collectCliWorkiq(config, ledger, 'cli-test', tr.factory);
  const pass = result.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.state, 'failed-source');
  assert.equal(pass.error.statusCode, 500);
  assert.equal(tr.paths.length, 2);
  assert.equal(ledger.cursor('app:workiq:created'), null);
  assert.ok(!JSON.stringify(pass.error).includes('private-diagnostic'));
  assert.throws(() => cliEnvelope({ content: [{ type: 'text', text }] }), e => e.code === 'blocked-protocol');
  assert.throws(() => cliEnvelope({ isError: true, content: [{ type: 'text', text: 'body mentions 500' }] }), e => e.code === 'blocked-protocol');
});

for (const isError of [true, false]) test('429 details survive collection, isError=' + isError, async t => {
  const { config, ledger } = setup(t);
  const tr = transport(config, [{ isError, structuredContent: { results: [{ statusCode: 429,
    retryAfterSeconds: 60, errorCode: 'Throttled', rawDiagnostic: 'must-not-escape' }] } }]);
  const result = await collectCliWorkiq(config, ledger, 'cli-test', tr.factory);
  const pass = result.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.state, 'blocked-throttled');
  assert.equal(pass.error.statusCode, 429); assert.equal(pass.error.retryAfterSeconds, 60);
  const row = JSON.parse(ledger.db.prepare("SELECT body FROM app_transport ORDER BY rowid DESC LIMIT 1").get().body);
  assert.equal(row.call.failure.retryAfterSeconds, 60);
  assert.match(row.captureSha256, /^[a-f0-9]{64}$/);
  assert.equal(row.call.failure.rawDiagnostic, undefined);
  assert.equal(tr.paths.length, 2); assert.equal(ledger.cursor('app:workiq:created'), null);
  assert.equal(pass.nextRequest, null);
});

test('CLI collector journals all calls, old-root replies, provenance and complete cursor without dispatch', async t => {
  const { config, ledger } = setup(t);
  const tr = transport(config, [
    wrapped({ value: [message('old', '2026-10-07T01:00:00Z'), message('new')] }),
    path => { assert.match(path, /old\/replies/); return wrapped({ value: [message('reply')] }); },
    wrapped({ value: [] })
  ]);
  const status = await collectCliWorkiq(config, ledger, 'cli-test', tr.factory);
  const pass = status.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.state, 'complete', JSON.stringify(pass.error)); assert.equal(pass.readCalls, 4);
  assert.equal(pass.evidenceCount, 2); assert.equal(pass.examinedRecords, 3);
  assert.equal(pass.provenance, 'workiq-cli-verified');
  assert.ok(ledger.all('evidence').every(e => e.source.provenance === 'workiq-cli-verified'));
  assert.equal(ledger.db.prepare('SELECT COUNT(*) n FROM app_transport').get().n, 4);
  assert.equal(status.sourceArtifacts.length, 4);
  assert.ok(ledger.cursor('app:workiq:created'));
  assert.equal(status.workers.length, 0); assert.equal(status.scheduleEnabledByHelper, false);
  assert.ok(tr.closed);
  await assert.rejects(collectCliWorkiq(config, ledger, 'cli-test', () => assert.fail('duplicate launch')), /already recorded/);
});

test('CLI auth failure retains partial bodies and prior cursor with no retry or fallback', async t => {
  const { config, ledger } = setup(t);
  ledger.db.prepare('INSERT INTO cursors VALUES(?,?)').run('app:workiq:created', json({ end: 'previous' }));
  const tr = transport(config, [wrapped({ value: [message('root')] }),
    { structuredContent: { results: [{ statusCode: 500, data: null, errorCode: 'AuthenticationRequired', recoveryAction: 'Reauthenticate' }] } }]);
  const result = await collectCliWorkiq(config, ledger, 'cli-test', tr.factory);
  const pass = result.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.state, 'blocked-auth'); assert.equal(pass.readCalls, 3);
  assert.equal(pass.evidenceCount, 1); assert.equal(pass.nextRequest, null);
  assert.deepEqual(ledger.cursor('app:workiq:created'), { end: 'previous' });
  assert.equal(tr.paths.length, 3); assert.ok(tr.closed);
});

test('CLI identity mismatch stops before seed read and keeps observed identity receipt', async t => {
  const { config, ledger } = setup(t);
  let reads = 0;
  const status = await collectCliWorkiq(config, ledger, 'cli-test', async () => ({
    read: async () => { reads++; return wrapped({ id: 'wrong', userPrincipalName: 'wrong@example.invalid' }); },
    close: async () => {}
  }));
  assert.equal(reads, 1);
  assert.equal(status.collection.find(p => p.pass === 'workiq:created').state, 'blocked-auth');
  assert.equal(status.sourceArtifacts.length, 1);
  assert.equal(ledger.all('evidence').length, 0);
});

test('CLI policy denial is not diagnosed as authentication and cannot advance a cursor', async t => {
  const { config, ledger } = setup(t);
  const tr = transport(config, [{ structuredContent: { results: [{ statusCode: 403, errorCode: 'AccessDenied', data: null }] } }]);
  const status = await collectCliWorkiq(config, ledger, 'cli-test', tr.factory);
  assert.equal(status.collection.find(p => p.pass === 'workiq:created').state, 'blocked-permission');
  assert.equal(ledger.cursor('app:workiq:created'), null); assert.equal(tr.paths.length, 2);
});

test('CLI budgets stop reads and retain extra returned records as unexamined, not complete', async t => {
  const { config, ledger } = setup(t, { maxItems: 1 });
  const tr = transport(config, [wrapped({ value: [message('one'), message('two')] })]);
  const status = await collectCliWorkiq(config, ledger, 'cli-test', tr.factory);
  const pass = status.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.state, 'partial'); assert.equal(pass.examinedRecords, 1);
  assert.equal(pass.unexaminedReturnedRecords, 1); assert.equal(pass.evidenceCount, 1);
  assert.equal(tr.paths.length, 2); assert.equal(ledger.cursor('app:workiq:created'), null);
});

test('CLI read ceiling includes identity and cannot fetch a reply after exhaustion', async t => {
  const { config, ledger } = setup(t, { maxCalls: 2 });
  const tr = transport(config, [wrapped({ value: [message('one')] })]);
  const status = await collectCliWorkiq(config, ledger, 'cli-test', tr.factory);
  assert.equal(status.collection.find(p => p.pass === 'workiq:created').state, 'partial');
  assert.equal(tr.paths.length, 2);
});

test('CLI exhausts capped reply pagination and then resumes root pagination', async t => {
  const { config, ledger } = setup(t);
  let rootNext;
  const tr = transport(config, [
    path => {
      rootNext = path.replace('$top=50', '$top=20') + '&$skiptoken=next-root';
      return wrapped({ value: [message('root')], '@odata.nextLink': rootNext });
    },
    path => wrapped({ value: [message('reply-one')], '@odata.nextLink': path.replace('$top=50', '$top=5') + '&$skiptoken=next-reply' }),
    path => { assert.match(path, /next-reply/); return wrapped({ value: [message('reply-two')] }); },
    path => { assert.match(path, /next-root/); return wrapped({ value: [] }); }
  ]);
  const status = await collectCliWorkiq(config, ledger, 'cli-test', tr.factory);
  const pass = status.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.state, 'complete'); assert.equal(pass.readCalls, 5);
  assert.equal(pass.evidenceCount, 3); assert.equal(tr.paths.length, 5);
});

test('CLI interrupted request cannot relaunch; offline reconciliation makes zero reads', async t => {
  const { config, ledger } = setup(t);
  ledger.operation('cli-workiq:cli-test', 'cli-test', 'local-workiq-cli-collection', {});
  ledger.db.prepare('INSERT INTO app_transport VALUES(?,?,?,?)').run('uncertain', 'cli-test', 'workiq:created',
    json({ execution: 'local-workiq-cli-stdio', state: 'requested', call: { request: { entityUrls: [principalPath] } } }));
  await assert.rejects(collectCliWorkiq(config, ledger, 'cli-test', () => assert.fail('Must not relaunch')), /already started/);
  const status = await reconcileCliWorkiq(config, ledger, 'cli-test');
  assert.equal(status.collection.find(p => p.pass === 'workiq:created').state, 'blocked-reconciliation');
  assert.equal(ledger.all('evidence').length, 0);
});

test('CLI source scope escape in nextLink stops without requesting it', async t => {
  const { config, ledger } = setup(t);
  const tr = transport(config, [wrapped({ value: [], '@odata.nextLink': 'https://example.invalid/escape' })]);
  const status = await collectCliWorkiq(config, ledger, 'cli-test', tr.factory);
  assert.equal(status.collection.find(p => p.pass === 'workiq:created').state, 'blocked-scope');
  assert.equal(tr.paths.length, 2); assert.equal(ledger.cursor('app:workiq:created'), null);
});

test('MCP parser supports explicit structured/text shapes and refuses unknown envelopes', () => {
  assert.equal(cliEnvelope(wrapped({ id: 'fixture' })).results[0].data.id, 'fixture');
  assert.throws(() => cliEnvelope({ structuredContent: { response: { results: [] } } }), /unrecognized/);
  assert.throws(() => cliEnvelope({ content: [{ type: 'text', text: 'private runtime text' }] }), /suppressed/);
  assert.equal(cliFailure({ results: [{ statusCode: 403 }] }).code, 'blocked-permission');
});

test('real stdio process verifies handshake, allows only scoped fetch and suppresses diagnostics', async t => {
  const { config } = setup(t);
  const script = `
    const rl=require('node:readline').createInterface({input:process.stdin});
    process.stderr.write('synthetic private diagnostic');
    rl.on('line',line=>{
      const m=JSON.parse(line); if(!m.id)return;
      let result;
      if(m.method==='initialize')result={protocolVersion:'2025-03-26'};
      else if(m.method==='tools/list')result={tools:[{name:'fetch',inputSchema:{properties:{entityUrls:{}}}}]};
      else if(m.method==='tools/call'&&m.params.name==='fetch')result={structuredContent:{results:[{statusCode:200,data:{fixture:true}}]}};
      else process.exit(8);
      process.stdout.write(JSON.stringify({jsonrpc:'2.0',id:m.id,result})+'\\n');
    });
  `;
  config.runtime.workiqCli.minReadIntervalMs = 80;
  const client = await workiqCli(config, { spawnProcess: (exe, args, options) => {
    assert.equal(exe, config.runtime.workiqCli.executable);
    assert.deepEqual(args, ['--account', config.identity.designatedUser, 'mcp']);
    return spawn(process.execPath, ['-e', script], options);
  } });
  try {
    assert.equal(cliEnvelope(await client.read(principalPath)).results[0].data.fixture, true);
    const completedAt = Date.now();
    assert.equal(cliEnvelope(await client.read(principalPath)).results[0].data.fixture, true);
    assert.ok(Date.now() - completedAt >= 70, 'configured pacing applies before the next read');
    await assert.rejects(client.read('/me/messages?$select=id'), /scope|outside|approved/i);
    assert.equal(client.rpc, undefined);
  } finally { await client.close(); }
});

test('CLI reports explicit throttling and its server delay without disguising it as authentication', () => {
  assert.deepEqual(cliFailure({ results: [{ statusCode: 429, retryAfterSeconds: 60 }] }),
    { code: 'blocked-throttled', statusCode: 429, retryAfterSeconds: 60 });
});

test('CLI startup timeout closes child and does not retry', async t => {
  const { config } = setup(t);
  config.runtime.workiqCli.timeoutMs = 25;
  let launches = 0;
  await assert.rejects(workiqCli(config, { spawnProcess: (_, __, options) => {
    launches++; return spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], options);
  } }), /timed out/);
  assert.equal(launches, 1);
});
