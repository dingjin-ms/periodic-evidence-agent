import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { configAt, hash, json, now, exclusions } from '../src/common.js';
import { beginApp, openApp, appendApp, blockApp, unavailableApp, appStatus, appReview, appWorker, appPlanImprovement, collectAppAdo, listAppRuns } from '../src/app-native.js';
import { principalPath, channelRoot } from '../src/runtime.js';
import { wiql, area, adoRecord } from '../src/sources.js';
import { icmSearchRequest } from '../src/icm-replay.js';
import { repositoryValidationContract, skillQualificationId } from '../src/repository-skills.js';

function setup(t, { dry = true, provenance = 'synthetic', configure = () => {} } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'app-pilot-'));
  const config = configAt('pilot.example.json'); config.stateDirectory = root;
  config.statePolicy.accessApproved = true;
  config.sources.ado = { enabled: true, scopeApproved: true };
  config.sources.workiq.enabled = true; config.sources.workiq.scopeApproved = true;
  config.activation = { collect: !dry, review: !dry, dispatch: !dry };
  config.limits = { ...config.limits, maxItems: 2000, maxCalls: 300, workerMaxToolCalls: 100 };
  config.repositories = [{ id: 'fixture', projectId: 'test-project', owner: 'test-owner', routingApproved: true,
    referenceCheckout: join(root, 'reference'), remote: 'https://example.invalid/test.git', baseRef: 'HEAD',
    allowedWritePrefixes: ['src'], validationGates: [] }];
  configure(config);
  beginApp(config, { runId: 'test-run', executorSessionId: 'test-session', dryRun: dry, provenance });
  const { ledger } = openApp(config, 'test-run', dry);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return { config, ledger, root, runId: 'test-run' };
}
function call(id, path, data) {
  return { id, observedAt: '2026-10-09T09:00:00Z', tool: 'workiq-fetch',
    request: { entityUrls: [path] }, response: { results: [{ statusCode: 200, data }] } };
}
function identityCall(config) { return call('me', principalPath, { id: config.identity.objectId, userPrincipalName: config.identity.designatedUser }); }
function rootPath(config) {
  return `${channelRoot(config.sources.workiq.seeds[0])}?$select=id,createdDateTime,lastModifiedDateTime,webUrl&$top=50`;
}
function message(id = 'root', date = '2026-10-08T09:00:00Z') {
  return { id, createdDateTime: date, lastModifiedDateTime: date, webUrl: 'https://teams.microsoft.com/l/message/test' };
}
const event = calls => ({ eventId: calls.at(-1).id, pass: 'workiq:created', calls });

test('app native run is isolated and keeps unstarted counts unknown', t => {
  const { config, ledger, root } = setup(t);
  const status = appStatus(ledger, 'test-run');
  assert.equal(status.executionMode, 'app-native'); assert.equal(status.productionLedgerTouched, false);
  assert.ok(status.collection.every(p => p.evidenceCount === null));
  assert.equal(existsSync(join(root, 'ledger.sqlite')), false);
  assert.equal(existsSync(status.summaryPath), true);
  assert.throws(() => beginApp(config, { runId: '../escape', dryRun: true, provenance: 'app-tool' }));
});
function enableIcm(config) {
  Object.assign(config.sources.icm, { enabled: true, scopeApproved: true,
    timestampContract: 'incident-created', owningTeamId: 123, severity: [1, 2, 25], top: 3 });
}
function icmCalls(config, rows, token = 'next-page') {
  return [
    { id: 'icm-me', tool: 'get_my_icm_context', request: {},
      requestedAt: '2026-10-09T09:00:00Z', observedAt: '2026-10-09T09:00:01Z',
      response: { structuredContent: { contact: { alias: 'collector',
        emailAddress: config.identity.designatedUser, status: 'Active' } } } },
    { id: 'icm-page', tool: 'search_incidents', request: icmSearchRequest(config.sources.icm, config.window),
      requestedAt: '2026-10-09T09:00:02Z', observedAt: '2026-10-09T09:00:03Z',
      response: { structuredContent: { success: true, value: rows, nextPageToken: token, '@odata.count': 46 } } }
  ];
}
const icmRow = (id = 42) => ({ id, title: 'Synthetic incident', owningTeamId: 123, severity: 25,
  state: 'Active', createdDate: '2026-10-08T01:00:00.6Z' });
const icmEvent = calls => ({ eventId: calls.at(-1).id, pass: 'icm:created', calls });
test('app ingests explicit incident-created receipts as partial evidence without saved-query parity', async t => {
  const { config, ledger } = setup(t, { provenance: 'app-tool', configure: enableIcm });
  const original = structuredClone(config), row = icmRow();
  const input = icmEvent(icmCalls(config, [row]));
  const status = await appendApp(config, ledger, 'test-run', input);
  const pass = status.collection.find(p => p.pass === input.pass);
  assert.equal(config.sources.icm.filtersVerified, false);
  assert.equal(pass.state, 'partial'); assert.equal(pass.cohortCoverage, 'partial');
  assert.equal(pass.timestampContract, 'incident-created'); assert.equal(pass.identityVerified, true);
  assert.equal(pass.readCalls, 2); assert.equal(pass.examinedRecords, 1);
  assert.deepEqual(pass.reportedTotals, [46]); assert.equal(pass.remainingSourceRecords, null);
  assert.equal(pass.nextRequest.arguments.incidentAdvancedSearchRequest.nextPageToken, 'next-page');
  assert.equal(pass.sourceCallsByHelper, 0); assert.equal(pass.classification, 'not-performed');
  assert.equal(ledger.cursor('app:icm:created'), null);
  const evidence = ledger.get('evidence', pass.evidenceIds[0]);
  assert.equal(evidence.source.namespace, 'icm/team/123/incident-created');
  assert.equal(evidence.source.provenance, 'app-tool-reported');
  assert.equal(evidence.source.ownerConfirmation, null);
  assert.equal(evidence.createdAt, row.createdDate);
  assert.equal(evidence.observedAt, input.calls[1].observedAt);
  assert.equal(evidence.snapshotAt, null);
  assert.deepEqual(evidence.fields, row);
  assert.equal(Object.hasOwn(evidence.fields, 'sourceCreateTime'), false);
  assert.ok(evidence.missingFields.includes('sourceCreateTime'));
  const payload = ledger.db.prepare('SELECT body FROM captures WHERE hash=?').get(evidence.capture.sha256).body;
  assert.deepEqual(JSON.parse(Buffer.from(payload).toString()), row);
  assert.equal(status.sourceArtifacts.filter(a => a.kind === 'icm-app-receipt').length, 2);
  assert.equal(status.report.summary.newCohortIds.length, 1);
  assert.equal(status.workers.length, 0);
  assert.deepEqual(await appendApp(config, ledger, 'test-run', input), status);
  assert.deepEqual(config, original);
});
test('app IcM records mismatched continuation as blocked instead of treating a repeated head as a new page', async t => {
  const { config, ledger } = setup(t, { configure: enableIcm });
  const input = icmEvent(icmCalls(config, [icmRow()]));
  await appendApp(config, ledger, 'test-run', input);
  const status = await appendApp(config, ledger, 'test-run',
    { ...input, eventId: 'restart', calls: [{ ...input.calls[1], id: 'head-retry' }] });
  const pass = status.collection.find(p => p.pass === 'icm:created');
  assert.equal(pass.state, 'blocked'); assert.equal(pass.nextRequest, null);
  assert.match(pass.error.message, /exact scoped next request/);
  assert.equal(pass.evidenceCount, 1); assert.equal(ledger.all('evidence').length, 1);
  assert.equal(ledger.cursor('app:icm:created'), null);
});
test('app IcM resumes only the returned token and advances an explicitly typed cursor on exhaustion', async t => {
  const { config, ledger } = setup(t, { configure: enableIcm });
  let status = await appendApp(config, ledger, 'test-run', icmEvent(icmCalls(config, [icmRow()])));
  let pass = status.collection.find(p => p.pass === 'icm:created');
  const next = { id: 'icm-last', tool: pass.nextRequest.tool, request: pass.nextRequest.arguments,
    requestedAt: '2026-10-09T09:01:00Z', observedAt: '2026-10-09T09:01:01Z',
    response: { structuredContent: { success: true, value: [], '@odata.count': 46 } } };
  status = await appendApp(config, ledger, 'test-run', icmEvent([next]));
  pass = status.collection.find(p => p.pass === 'icm:created');
  assert.equal(pass.state, 'complete'); assert.equal(pass.nextRequest, null);
  assert.equal(pass.remainingSourceRecords, 0); assert.equal(pass.evidenceCount, 1);
  assert.equal(ledger.cursor('app:icm:created').timestampContract, 'incident-created');
  assert.equal(ledger.all('evidence')[0].source.provenance, 'synthetic');
  await assert.rejects(appendApp(config, ledger, 'test-run',
    icmEvent([{ ...next, id: 'after-complete' }])), /terminal/);
});
test('app IcM preserves empty success, explicit nulls and exact fractional timestamp strings', async t => {
  const { config, ledger } = setup(t, { configure: enableIcm });
  const rows = ['.6Z', '.79Z', '.413Z'].map((fraction, i) => ({
    ...icmRow(i + 1), createdDate: `2026-10-08T01:00:00${fraction}`,
    sourceCreateTime: i === 0 ? null : `2026-10-07T00:00:00${fraction}`
  }));
  const status = await appendApp(config, ledger, 'test-run', icmEvent(icmCalls(config, rows, null)));
  assert.equal(status.collection.find(p => p.pass === 'icm:created').state, 'complete');
  const saved = ledger.all('evidence');
  for (const row of rows) {
    const e = saved.find(e => e.source.recordId === String(row.id));
    assert.equal(e.createdAt, row.createdDate);
    assert.equal(e.fields.sourceCreateTime, row.sourceCreateTime);
    assert.equal(e.missingFields.includes('sourceCreateTime'), false);
  }
  beginApp(config, { runId: 'icm-empty', dryRun: true, provenance: 'synthetic' });
  const empty = openApp(config, 'icm-empty');
  try {
    const result = await appendApp(config, empty.ledger, 'icm-empty', icmEvent(icmCalls(config, [], null)));
    const pass = result.collection.find(p => p.pass === 'icm:created');
    assert.equal(pass.state, 'complete'); assert.equal(pass.evidenceCount, 0);
    assert.equal(pass.examinedRecords, 0);
  } finally { empty.ledger.close(); }
});
for (const kind of ['items', 'calls']) {
  test(`app IcM ${kind} cap keeps evidence partial and forbids additional reads in the same pass`, async t => {
    const { config, ledger } = setup(t, { configure: config => {
      enableIcm(config);
      config.dryRun.limits[kind === 'items' ? 'maxItems' : 'maxCalls'] = kind === 'items' ? 1 : 2;
    } });
    const input = icmEvent(icmCalls(config, [icmRow(), icmRow(43)]));
    const status = await appendApp(config, ledger, 'test-run', input);
    const pass = status.collection.find(p => p.pass === 'icm:created');
    assert.equal(pass.state, 'partial'); assert.equal(pass.nextRequest, null);
    assert.equal(pass.examinedRecords, kind === 'items' ? 1 : 2);
    assert.equal(pass.unexaminedReturnedRecords, kind === 'items' ? 1 : 0);
    assert.equal(ledger.cursor('app:icm:created'), null);
    await assert.rejects(appendApp(config, ledger, 'test-run', { ...input, eventId: 'extra' }), /budget exhausted/);
  });
}
test('app IcM rejects source-created mode, unapproved scope and relabeling an existing blocker', async t => {
  const { config, ledger } = setup(t, { configure: enableIcm });
  const input = icmEvent(icmCalls(config, [icmRow()]));
  unavailableApp(ledger, 'test-run', { pass: 'icm:created', reason: 'no-approved-connector' });
  await assert.rejects(appendApp(config, ledger, 'test-run', input), /terminal/);
  for (const change of [{ timestampContract: null }, { scopeApproved: false }, { enabled: false }]) {
    const local = structuredClone(config); Object.assign(local.sources.icm, change);
    await assert.rejects(appendApp(local, ledger, 'test-run', input), /explicitly selected incident-created/);
  }
  assert.equal(ledger.all('evidence').length, 0);
});
for (const invalid of ['missing-created', 'upper-bound', 'wrong-team', 'severity-zero', 'identity']) {
  test(`app IcM ${invalid} is blocked without an invented empty successful cohort`, async t => {
    const { config, ledger } = setup(t, { configure: enableIcm });
    const row = icmRow(), calls = icmCalls(config, [row], null);
    if (invalid === 'missing-created') { delete row.createdDate; row.sourceCreateTime = config.window.start; }
    if (invalid === 'upper-bound') row.createdDate = config.window.end;
    if (invalid === 'wrong-team') row.owningTeamId = 124;
    if (invalid === 'severity-zero') row.severity = 0;
    if (invalid === 'identity') calls[0].response.structuredContent.contact.alias = 'someone-else';
    const status = await appendApp(config, ledger, 'test-run', icmEvent(calls));
    const pass = status.collection.find(p => p.pass === 'icm:created');
    assert.equal(pass.state, invalid === 'identity' ? 'blocked-auth' : 'blocked');
    assert.equal(pass.nextRequest, null); assert.equal(pass.cursor, null);
    assert.equal(pass.evidenceCount, 0); assert.equal(ledger.all('evidence').length, 0);
    assert.ok(pass.error); assert.equal(status.sourceArtifacts.length, 2);
  });
}
test('app imports full metadata page before pending replies, replays idempotently and resumes to completeness', async t => {
  const { config, ledger } = setup(t);
  const batch = event([identityCall(config), call('page', rootPath(config), { value: [message('old', '2026-10-07T09:00:00Z'), message()] })]);
  let status = await appendApp(config, ledger, 'test-run', batch);
  let pass = status.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.state, 'partial'); assert.equal(pass.evidenceCount, 1); assert.equal(pass.examinedRecords, 2);
  assert.match(pass.nextRequest.entityUrls[0], /old\/replies/);
  assert.equal(ledger.cursor('app:workiq:created'), null);
  const evidenceId = pass.evidenceIds[0];
  assert.ok(ledger.get('evidence', evidenceId).missingFields.includes('body'));
  await appendApp(config, ledger, 'test-run', batch);
  assert.equal(ledger.all('evidence').length, 1);
  status = await appendApp(config, ledger, 'test-run', event([call('old-replies', pass.nextRequest.entityUrls[0], { value: [message('reply')] })]));
  pass = status.collection.find(p => p.pass === 'workiq:created');
  status = await appendApp(config, ledger, 'test-run', event([call('root-replies', pass.nextRequest.entityUrls[0], { value: [] })]));
  pass = status.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.state, 'complete'); assert.equal(pass.evidenceCount, 2);
  assert.ok(ledger.cursor('app:workiq:created'));
  assert.equal(status.report.summary.newCohortIds.length, 2);
});
test('app external auth failure overrides continuation and preserves earlier real-source-shaped metadata', async t => {
  const { config, ledger } = setup(t);
  await appendApp(config, ledger, 'test-run', event([identityCall(config), call('page', rootPath(config), { value: [message()] })]));
  const failed = call('detail-failed', `${channelRoot(config.sources.workiq.seeds[0])}/root?$select=id,createdDateTime,body,webUrl`, {});
  delete failed.response;
  failed.failure = { code: 'blocked-auth', statusCode: 500, errorCode: 'AuthenticationRequired', recoveryAction: 'Reauthenticate' };
  const blocked = { eventId: 'auth-block', pass: 'workiq:created', call: failed };
  let result = blockApp(config, ledger, 'test-run', blocked);
  blockApp(config, ledger, 'test-run', blocked);
  const pass = result.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.state, 'blocked-auth'); assert.equal(pass.readCalls, 3);
  assert.equal(pass.evidenceCount, 1); assert.equal(pass.nextRequest, null); assert.equal(pass.cursor, null);
  await assert.rejects(appendApp(config, ledger, 'test-run', event([identityCall(config)])), /terminal/);
});
test('app empty-subject replies commit under the existing item cap without changing raw captures', async t => {
  const { config, ledger } = setup(t, { configure: config => { config.dryRun.limits.maxItems = 3; } });
  const root = { ...message(), subject: 'Root title' };
  let status = await appendApp(config, ledger, 'test-run',
    event([identityCall(config), call('page', rootPath(config), { value: [root] })]));
  let pass = status.collection.find(p => p.pass === 'workiq:created');
  const originalRoot = ledger.get('evidence', pass.evidenceIds[0]);
  const replies = ['', null, 'unexamined'].map((subject, index) => ({
    ...message(`reply-${index}`), replyToId: root.id, subject
  }));
  const receipt = event([call('replies', pass.nextRequest.entityUrls[0], { value: replies })]);
  status = await appendApp(config, ledger, 'test-run', receipt);
  pass = status.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.state, 'partial');
  assert.equal(pass.readCalls, 3);
  assert.equal(pass.evidenceCount, 3);
  assert.equal(pass.examinedRecords, 3);
  assert.equal(pass.returnedRecords, 4);
  assert.equal(pass.unexaminedReturnedRecords, 1);
  assert.equal(pass.cumulativeTraversal.threadsExhausted, 0);
  assert.equal(pass.nextRequest, null);
  assert.equal(pass.cursor, null);
  assert.equal(ledger.cursor('app:workiq:created'), null);
  assert.deepEqual(ledger.get('evidence', originalRoot.id), originalRoot);
  const captured = pass.evidenceIds.map(id => ledger.get('evidence', id));
  for (const record of captured.filter(record => record.fields.thread.isReply)) {
    assert.equal(record.title, null);
    const raw = replies.find(reply => reply.id === record.source.recordId);
    assert.deepEqual(record.fields.message, raw);
    assert.equal(record.capture.sha256, hash(json({ message: raw, parentContext: root })));
  }
  assert.equal(ledger.db.prepare('SELECT COUNT(*) n FROM app_events WHERE run_id=?').get('test-run').n, 2);
});
test('app malformed nonstring subjects still reject atomically instead of being dropped or normalized', async t => {
  const { config, ledger } = setup(t);
  const status = await appendApp(config, ledger, 'test-run',
    event([identityCall(config), call('page', rootPath(config), { value: [message()] })]));
  const prior = status.collection.find(p => p.pass === 'workiq:created');
  await assert.rejects(appendApp(config, ledger, 'test-run', event([
    call('bad-reply', prior.nextRequest.entityUrls[0], { value: [{ ...message('reply'), subject: false }] })
  ])), error => error.code === 'invalid-record' && /data\/title/.test(error.message));
  assert.deepEqual(appStatus(ledger, 'test-run').collection.find(p => p.pass === 'workiq:created'), prior);
  assert.equal(ledger.all('evidence').length, 1);
  assert.equal(ledger.db.prepare('SELECT COUNT(*) n FROM app_events WHERE run_id=?').get('test-run').n, 1);
});
test('app records failed native me without inventing identity or clean empty collection', async t => {
  const { config, ledger } = setup(t);
  const failed = identityCall(config); delete failed.response; failed.failure = { code: 'blocked-auth', statusCode: 500 };
  const result = await appendApp(config, ledger, 'test-run', event([failed]));
  const pass = result.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.identityVerified, false); assert.equal(pass.state, 'blocked-auth');
  assert.equal(result.report.issues.length, 0); assert.equal(pass.nextRequest, null);
});
test('app receipt scope, credentials, query ordering and immutable event conflicts fail closed', async t => {
  const { config, ledger } = setup(t);
  await assert.rejects(appendApp(config, ledger, 'test-run', event([call('wrong', '/me/messages?$select=id', { value: [] })])), /First WorkIQ/);
  const secret = identityCall(config); secret.response.headers = { authorization: 'secret' };
  await assert.rejects(appendApp(config, ledger, 'test-run', event([secret])), /credentials/);
  await appendApp(config, ledger, 'test-run', event([identityCall(config)]));
  const changed = identityCall(config); changed.response.results[0].data.id = 'different-user';
  await assert.rejects(appendApp(config, ledger, 'test-run', event([changed])), /different content/);
  await assert.rejects(appendApp(config, ledger, 'test-run', event([call('escape',
    '/teams/other/channels/other/messages?$select=id,createdDateTime&$top=50', { value: [] })])), /outside/);
});
test('app accepts backend smaller nextLink page cap without broadening channel or claiming completeness', async t => {
  const { config, ledger } = setup(t);
  const path = rootPath(config);
  const next = path.replace('$top=50', '$top=20') + '&$skiptoken=opaque';
  let result = await appendApp(config, ledger, 'test-run', event([identityCall(config), call('page', path,
    { value: [], '@odata.nextLink': `https://graph.microsoft.com/v1.0${next}` })]));
  let pass = result.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.state, 'partial');
  assert.equal(new URL(pass.nextRequest.entityUrls[0], 'https://scope.invalid').searchParams.get('$top'), '20');
  result = await appendApp(config, ledger, 'test-run', event([call('last', pass.nextRequest.entityUrls[0], { value: [] })]));
  assert.equal(result.collection.find(p => p.pass === 'workiq:created').state, 'complete');
});
async function adoBatch(config, ledger, lane = 'created', id = 'ado-event', fields = {}) {
  const date = '2026-10-09T00:00:00Z', pass = `ado:${lane}`;
  const principal = { objectId: config.identity.objectId, tenantId: config.identity.tenantId,
    userPrincipalName: config.identity.designatedUser, verifiedAt: date, toolCallId: 'test-ado-identity' };
  const query0 = "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'OC' AND [System.Id] = 0";
  const calls = [
    { endpoint: 'wiql', body: { query: query0 }, response: { asOf: date, workItems: [] } },
    { endpoint: 'wiql', body: { query: wiql(config.window, lane, date) }, response: { asOf: date, workItems: [{ id: 1 }] } },
    { endpoint: 'workitemsbatch', body: { ids: [1], asOf: date, errorPolicy: 'Fail', $expand: 'Relations' },
      response: { value: [{ id: 1, rev: 1, fields: { 'System.WorkItemType': 'Bug', 'System.AreaPath': area,
        'System.Title': 'Synthetic test', 'System.State': 'Resolved',
        'Microsoft.VSTS.Common.ResolvedReason': 'Fixed',
        'System.CreatedDate': '2026-10-08T01:00:00Z', 'System.ChangedDate': '2026-10-08T02:00:00Z',
        ...fields } }] } }
  ].map((c, index) => ({ id: `${id}-${index}`, tool: 'ado-delegated-read', observedAt: date,
    request: { endpoint: c.endpoint, body: c.body }, response: c.response }));
  return appendApp(config, ledger, 'test-run', { eventId: id, pass, principal, calls });
}
test('app ADO created/changed replay deduplicates revision and separates new cohort counts', async t => {
  const { config, ledger } = setup(t);
  await adoBatch(config, ledger);
  const result = await adoBatch(config, ledger, 'changed', 'changed');
  assert.equal(ledger.all('evidence').length, 1);
  assert.equal(result.report.summary.newCohortIds.length, 1);
  assert.equal(result.collection.find(p => p.pass === 'ado:changed').evidenceCount, 1);
  unavailableApp(ledger, 'test-run', { pass: 'icm:created', reason: 'no-approved-connector' });
  assert.equal(appStatus(ledger, 'test-run').collection.find(p => p.pass === 'icm:created').evidenceCount, null);
});
test('ADO receipt imports reject noncohort fields and retain the prior committed cursor', async t => {
  for (const fields of [
    { 'System.State': 'New' }, { 'System.State': 'Active' }, { 'System.State': 'Removed' },
    { 'Microsoft.VSTS.Common.ResolvedReason': undefined, 'System.Reason': 'Fixed' },
    { 'Microsoft.VSTS.Common.ResolvedReason': 'Not Repro' }
  ]) {
    const { config, ledger } = setup(t);
    await adoBatch(config, ledger);
    const cursor = ledger.cursor('app:ado:created');
    await assert.rejects(adoBatch(config, ledger, 'changed', 'ineligible', fields),
      error => error.code === 'blocked-scope');
    assert.equal(ledger.cursor('app:ado:changed'), null);
    assert.deepEqual(ledger.cursor('app:ado:created'), cursor);
    assert.equal(ledger.all('evidence').length, 1);
    assert.equal(ledger.db.prepare('SELECT COUNT(*) n FROM app_events WHERE id=?').get('ineligible').n, 0);
  }
});
function cappedAdoReceipts(config, lane, count = 62) {
  const date = '2026-10-09T00:00:00Z';
  const ids = Array.from({ length: count }, (_, i) => i + 1);
  const selected = ids.slice(0, config.limits.maxItems);
  const principal = { objectId: config.identity.objectId, tenantId: config.identity.tenantId,
    userPrincipalName: config.identity.designatedUser, verifiedAt: date, toolCallId: 'synthetic-identity' };
  const requests = [
    { endpoint: 'wiql', body: { query: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'OC' AND [System.Id] = 0" } },
    { endpoint: 'wiql', body: { query: wiql(config.window, lane, date) } },
    { endpoint: 'workitemsbatch', body: { ids: selected, asOf: date, errorPolicy: 'Fail', $expand: 'Relations' } }
  ];
  const responses = [
    { asOf: date, workItems: [] }, { asOf: date, workItems: ids.map(id => ({ id })) },
    { value: selected.map(id => ({ id, rev: 1, fields: { 'System.WorkItemType': 'Bug',
      'System.AreaPath': area, 'System.Title': `Synthetic capped item ${id}`, 'System.State': 'Resolved',
      'Microsoft.VSTS.Common.ResolvedReason': 'Fixed',
      'System.CreatedDate': '2026-10-08T01:00:00Z', 'System.ChangedDate': '2026-10-08T02:00:00Z' } })) }
  ];
  return { principal, calls: requests.map((request, i) => ({ id: `synthetic-${lane}-${i}`,
    observedAt: date, tool: 'ado-delegated-read', request, response: responses[i] })) };
}
for (const lane of ['created', 'changed']) {
  test(`app ADO ${lane} awaits bounded hydration before a truthful cap stop`, async t => {
    const { config, ledger } = setup(t, { configure: c => { c.limits.maxItems = c.dryRun.limits.maxItems = 50; } });
    const { principal, calls } = cappedAdoReceipts(config, lane), pass = `ado:${lane}`;
    let result = await appendApp(config, ledger, 'test-run', {
      eventId: 'synthetic-selection', pass, principal, calls: calls.slice(0, 2) });
    let state = result.collection.find(p => p.pass === pass);
    assert.equal(state.error.code, 'awaiting-receipt');
    assert.deepEqual(state.nextRequest, calls[2].request);
    assert.equal(state.examinedRecords, 0);
    assert.equal(state.evidenceCount, 0);
    assert.equal(state.returnedRecords, 62);
    assert.equal(state.unexaminedReturnedRecords, 62);
    result = await appendApp(config, ledger, 'test-run', {
      eventId: 'synthetic-hydration', pass, principal, calls: calls.slice(2) });
    state = result.collection.find(p => p.pass === pass);
    assert.equal(state.state, 'partial');
    assert.equal(state.error.code, 'partial');
    assert.equal(state.nextRequest, null);
    assert.equal(state.cursor, null);
    assert.equal(state.readCalls, 3);
    assert.equal(state.examinedRecords, 50);
    assert.equal(state.evidenceCount, 50);
    assert.equal(state.returnedRecords, 62);
    assert.equal(state.unexaminedReturnedRecords, 12);
    assert.equal(state.duplicateReturnedIds, 0);
    assert.equal(state.examinationBasis, 'hydrated-valid-records');
    assert.equal(ledger.all('evidence').length, 50);
    assert.ok(ledger.all('evidence').every(e => e.source.provenance === 'synthetic'));
  });
  test(`app ADO ${lane} injected adapter agrees with bounded receipt replay`, async t => {
    const { config, ledger } = setup(t, { provenance: 'app-tool',
      configure: c => { c.limits.maxItems = c.dryRun.limits.maxItems = 50; } });
    const { calls } = cappedAdoReceipts(config, lane);
    let count = 0;
    const result = await collectAppAdo(config, ledger, 'test-run', `ado:${lane}`, async () => async (endpoint, body) => {
      const expected = calls[count++];
      assert.deepEqual({ endpoint, body }, expected.request);
      return expected.response;
    });
    const state = result.collection.find(p => p.pass === `ado:${lane}`);
    assert.equal(count, 3);
    assert.equal(state.state, 'partial');
    assert.equal(state.readCalls, 3);
    assert.equal(state.examinedRecords, 50);
    assert.equal(state.evidenceCount, 50);
    assert.equal(state.unexaminedReturnedRecords, 12);
    assert.equal(state.cursor, null);
  });
}
for (const failure of ['failed-source', 'missing', 'duplicate', 'unexpected', 'invalid-date', 'outside-area', 'outside-window']) {
  test(`app ADO capped hydration ${failure} is not successful body examination`, async t => {
    const { config, ledger } = setup(t, { configure: c => { c.limits.maxItems = c.dryRun.limits.maxItems = 50; } });
    const { principal, calls } = cappedAdoReceipts(config, 'created');
    if (failure === 'failed-source') { delete calls[2].response; calls[2].failure = { code: failure }; }
    else {
      const value = calls[2].response.value;
      if (failure === 'missing') value.pop();
      if (failure === 'duplicate') value[1] = value[0];
      if (failure === 'unexpected') value[0].id = 999;
      if (failure === 'invalid-date') value[0].fields['System.CreatedDate'] = 'not-a-date';
      if (failure === 'outside-area') value[0].fields['System.AreaPath'] = 'Other';
      if (failure === 'outside-window') value[0].fields['System.CreatedDate'] = config.window.end;
    }
    const pending = appendApp(config, ledger, 'test-run', {
      eventId: 'synthetic-invalid', pass: 'ado:created', principal, calls });
    if (['invalid-date', 'outside-area', 'outside-window'].includes(failure)) await assert.rejects(pending);
    else {
      const state = (await pending).collection.find(p => p.pass === 'ado:created');
      assert.notEqual(state.state, 'complete');
      assert.equal(state.examinedRecords, 0);
      assert.equal(state.evidenceCount, 0);
      assert.equal(state.unexaminedReturnedRecords, 62);
      assert.equal(state.nextRequest, null);
      assert.equal(state.cursor, null);
    }
    assert.equal(ledger.all('evidence').length, 0);
  });
}
test('app ADO duplicate metadata is separate from unexamined unique IDs', async t => {
  const { config, ledger } = setup(t);
  const { principal, calls } = cappedAdoReceipts(config, 'created', 2);
  calls[1].response.workItems.push({ id: 1 });
  const result = await appendApp(config, ledger, 'test-run', {
    eventId: 'synthetic-duplicate-metadata', pass: 'ado:created', principal, calls });
  const state = result.collection.find(p => p.pass === 'ado:created');
  assert.equal(state.state, 'complete');
  assert.equal(state.returnedRecords, 3);
  assert.equal(state.examinedRecords, 2);
  assert.equal(state.duplicateReturnedIds, 1);
  assert.equal(state.unexaminedReturnedRecords, 0);
});
test('app ADO malformed WIQL stays failed-source without invented examination', async t => {
  const { config, ledger } = setup(t);
  const { principal, calls } = cappedAdoReceipts(config, 'created');
  calls[1].response.workItems = 'invalid';
  const result = await appendApp(config, ledger, 'test-run', {
    eventId: 'synthetic-malformed', pass: 'ado:created', principal, calls: calls.slice(0, 2) });
  const state = result.collection.find(p => p.pass === 'ado:created');
  assert.equal(state.state, 'failed-source');
  assert.equal(state.examinedRecords, 0);
  assert.equal(state.evidenceCount, 0);
  assert.equal(state.returnedRecords, 0);
});
test('app ADO capped selection preserves call budgets and rejects extra detail receipts', async t => {
  const { config, ledger } = setup(t, {
    configure: c => { c.limits.maxItems = c.dryRun.limits.maxItems = 50; c.dryRun.limits.maxCalls = 2; } });
  const { principal, calls } = cappedAdoReceipts(config, 'created');
  const result = await appendApp(config, ledger, 'test-run', {
    eventId: 'synthetic-call-cap', pass: 'ado:created', principal, calls: calls.slice(0, 2) });
  const state = result.collection.find(p => p.pass === 'ado:created');
  assert.equal(state.state, 'partial');
  assert.match(state.error.message, /Tool-call budget/);
  assert.equal(state.readCalls, 2);
  assert.equal(state.examinedRecords, 0);
  assert.equal(state.nextRequest, null);
  await assert.rejects(appendApp(config, ledger, 'test-run', {
    eventId: 'synthetic-beyond-cap', pass: 'ado:created', principal, calls: calls.slice(2) }));
  assert.equal(ledger.all('evidence').length, 0);
});
test('app dry run rejects reviews/native workers and ignores historic SDK auth blocks', t => {
  const { config, ledger } = setup(t);
  ledger.blockSource('auth:workiq', { code: 'blocked-auth', message: 'Historical SDK failure' });
  assert.throws(() => appReview(config, ledger, 'test-run', {}), /Collection-only/);
  assert.throws(() => appWorker(config, ledger, 'test-run', 'prepare', {}), /disabled/);
  assert.match(appStatus(ledger, 'test-run').sdkWorkiqGate, /not-applicable/);
});
test('app native assignment claim/bind/result is idempotent and cannot use primary checkout', async t => {
  const { config, ledger, root } = setup(t, { dry: false, provenance: 'app-tool' });
  await appendApp(config, ledger, 'test-run', event([
    identityCall(config), call('page', rootPath(config), { value: [message()] })
  ]));
  const evidence = ledger.all('evidence')[0];
  const investigation = {
    recordType: 'investigation', schemaVersion: '1.0', id: `investigation-${hash(json([evidence.source.namespace, evidence.source.recordId]))}`,
    version: 1, evidenceIds: [evidence.id], state: 'triaged', observedBehavior: 'Synthetic fixture only',
    expectedBehavior: 'Expected', hypotheses: [], counterEvidence: [], classification: 'functional',
    defectConfirmation: 'unconfirmed', reportEligibility: 'included', handoffEligibility: 'eligible',
    exclusionReasons: [], rationale: 'Test all guards', confidence: 0.8,
    review: { method: config.reviewMethod, reviewer: 'fixture', reviewedAt: now() },
    repoIds: ['fixture'], existingFixes: [], nextAction: 'Investigate'
  };
  appReview(config, ledger, 'test-run', { investigation, exclusionsChecked: exclusions });
  const job = appWorker(config, ledger, 'test-run', 'prepare', { investigationId: investigation.id, repoId: 'fixture', intent: 'rca-only' });
  const claim = { assignmentId: job.id, claimId: 'claim-one', coordinatorAgentId: config.agent.id };
  appWorker(config, ledger, 'test-run', 'claim', claim);
  appWorker(config, ledger, 'test-run', 'claim', claim);
  assert.throws(() => appWorker(config, ledger, 'test-run', 'claim', { ...claim, claimId: 'claim-two' }), /already claimed/);
  const binding = { assignmentId: job.id, claimId: 'claim-one', sessionId: 'native-session', projectId: 'test-project',
    workspace: config.repositories[0].referenceCheckout, baseRevision: 'a'.repeat(40) };
  assert.throws(() => appWorker(config, ledger, 'test-run', 'bind', binding), /primary checkout/);
  binding.workspace = join(root, 'worktree');
  appWorker(config, ledger, 'test-run', 'bind', binding);
  appWorker(config, ledger, 'test-run', 'bind', binding);
  const result = { assignmentId: job.id, claimId: 'claim-one', sessionId: 'native-session',
    outcome: 'rca-complete', evidenceRef: 'local-test-artifact' };
  assert.equal(appWorker(config, ledger, 'test-run', 'result', result).state, 'completed');
  assert.equal(appWorker(config, ledger, 'test-run', 'result', result).state, 'completed');
  assert.equal(ledger.job(job.id).session_id, 'native-session');
});

test('app status includes only workers owned by the requested run', t => {
  const { config, ledger } = setup(t, { dry: false, provenance: 'app-tool' });
  beginApp(config, { runId: 'other-run', dryRun: false, provenance: 'app-tool' });
  ledger.db.prepare('INSERT INTO app_workers VALUES(?,?)').run(
    'worker-one', JSON.stringify({ id: 'worker-one', runId: 'test-run' }));
  ledger.db.prepare('INSERT INTO app_workers VALUES(?,?)').run(
    'worker-two', JSON.stringify({ id: 'worker-two', runId: 'other-run' }));
  assert.deepEqual(appStatus(ledger, 'test-run').workers.map(worker => worker.id),
    ['worker-one']);
  assert.deepEqual(appStatus(ledger, 'other-run').workers.map(worker => worker.id),
    ['worker-two']);
});

async function nativeCoveragePlanning(t, sourceStatus) {
  const { root, config, ledger } = setup(t, { dry: false, provenance: 'app-tool', configure: config => {
    config.repositories[0].allowedWritePrefixes = ['test'];
    config.repositories[0].validationGates = [{ id: 'oa-integration', approved: true,
      executable: process.execPath, args: [], timeoutMs: 1000 }];
    config.repositories[0].skillBindings = [{
      id: 'oa-integration-test-core', capability: 'integration-test-authoring',
      skillPath: 'docs/skills/Integration-test-core/SKILL.md', enabled: true, qualification: 'qualified',
      requestedOutcomes: ['add-or-update-tests'],
      allowedWritePrefixes: ['test'], requiresBehaviorCard: true,
      sideEffects: { commit: false, push: false, createDraftPR: false }
    }];
  } });
  const workspace = join(root, 'oa-worktree');
  const skillText = '# Synthetic OA integration skill\n';
  mkdirSync(join(workspace, 'docs', 'skills', 'Integration-test-core'), { recursive: true });
  writeFileSync(join(workspace, 'docs', 'skills', 'Integration-test-core', 'SKILL.md'), skillText);
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=.git/no-hooks', '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false', ...args], { cwd: workspace, windowsHide: true, encoding: 'utf8' }).trim();
  git(['init', '--quiet']);
  git(['add', '.']);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Synthetic OA skill workspace']);
  git(['remote', 'add', 'origin', config.repositories[0].remote]);
  const baseRevision = git(['rev-parse', 'HEAD']);
  const validationContract = repositoryValidationContract(config.repositories[0]);
  ledger.qualify(skillQualificationId('fixture', 'oa-integration-test-core'), {
    state: 'qualified-read-only', repoId: 'fixture', bindingId: 'oa-integration-test-core',
    capability: 'integration-test-authoring', remote: config.repositories[0].remote,
    baseRef: config.repositories[0].baseRef, baseRevision,
    skillPath: 'docs/skills/Integration-test-core/SKILL.md', skillSha256: hash(skillText),
    qualificationSource: 'local-reference',
    validationContractVersion: validationContract.version,
    validationContractSha256: validationContract.sha256,
    sideEffects: { commit: false, push: false, createDraftPR: false }
  });
  await adoBatch(config, ledger, 'created', 'ado-event', {
    'System.State': sourceStatus, 'System.Reason': 'Resolved',
    'Microsoft.VSTS.Common.ResolvedReason': 'Fixed'
  });
  const evidence = ledger.all('evidence')[0];
  const investigation = {
    recordType: 'investigation', schemaVersion: '1.0',
    id: `investigation-${hash(json([evidence.source.namespace, evidence.source.recordId]))}`, version: 1,
    evidenceIds: [evidence.id], state: 'triaged', observedBehavior: 'OA behavior lacks integration coverage.',
    expectedBehavior: 'The behavior is protected by a focused integration test.', hypotheses: [], counterEvidence: [],
    classification: 'functional', defectConfirmation: 'unconfirmed', reportEligibility: 'included',
    handoffEligibility: 'eligible', exclusionReasons: [], rationale: 'Test-coverage improvement fixture.',
    confidence: 0.8, review: { method: config.reviewMethod, reviewer: 'fixture', reviewedAt: now() },
    repoIds: ['fixture'], existingFixes: [], nextAction: 'Add focused OA integration coverage.'
  };
  appReview(config, ledger, 'test-run', { investigation, exclusionsChecked: exclusions });
  assert.throws(() => appWorker(config, ledger, 'test-run', 'prepare', {
    investigationId: investigation.id, repoId: 'fixture', intent: 'rca-only'
  }), error => error.code === 'blocked-reconciliation');
  const planned = appPlanImprovement(config, ledger, 'test-run', {
    improvement: {
      investigationIds: [investigation.id], category: 'missing-test-coverage',
      theme: 'OA focused integration coverage', observedBehavior: investigation.observedBehavior,
      expectedBehavior: investigation.expectedBehavior, rationale: 'Create one durable OA improvement.',
      priority: 'medium', repoIds: ['fixture'], capabilities: ['integration-test-authoring']
    },
    testCoverage: {
      repoId: 'fixture', capability: 'integration-test-authoring', sourceRevision: baseRevision,
      purpose: 'regression-coverage',
      searchStatus: 'complete', existingTests: [], coverageGaps: ['No matching integration test.'],
      unknowns: [], rationale: 'Source-bound search confirmed the coverage gap.'
    }
  });
  assert.throws(() => appWorker(config, ledger, 'test-run', 'prepare', {
    investigationId: investigation.id, repoId: 'fixture', intent: 'defect-fix'
  }), /only for qualified, bounded test-coverage/);
  ledger.setTrackedState(evidence, 'current', 'Unchanged resolved coverage source');
  const worker = appWorker(config, ledger, 'test-run', 'prepare', {
    investigationId: investigation.id, repoId: 'fixture', intent: 'improvement',
    testCoveragePlanId: planned.testCoveragePlan.id, requestedOutcome: 'add-or-update-tests'
  });
  assert.equal(worker.assignment.improvementId, planned.improvement.id);
  assert.equal(worker.assignment.testCoveragePlanId, planned.testCoveragePlan.id);
  assert.equal(worker.assignment.skillBindingId, 'oa-integration-test-core');
  assert.equal(ledger.all('areaToImprove').length, 1);
  assert.equal(ledger.all('testCoveragePlan').length, 1);
  const claimId = 'oa-claim';
  appWorker(config, ledger, 'test-run', 'claim', {
    assignmentId: worker.id, claimId, coordinatorAgentId: worker.coordinatorAgentId
  });
  assert.throws(() => appWorker(config, ledger, 'test-run', 'bind', {
    assignmentId: worker.id, claimId, sessionId: 'oa-session', projectId: worker.projectId,
    workspace: join(root, 'missing-workspace'), baseRevision
  }), /readable Git checkout/);
  const bound = appWorker(config, ledger, 'test-run', 'bind', {
    assignmentId: worker.id, claimId, sessionId: 'oa-session', projectId: worker.projectId,
    workspace, baseRevision
  });
  assert.equal(bound.baseRevision, baseRevision);
}

for (const sourceStatus of ['Closed', 'Resolved']) {
  test(`app native ${sourceStatus} OA planning pins coverage and qualification before claim`,
    t => nativeCoveragePlanning(t, sourceStatus));
}

test('app successful run A cursor survives blocked run B in the shared live ledger', async t => {
  const { config, ledger } = setup(t, { dry: false, provenance: 'app-tool' });
  await appendApp(config, ledger, 'test-run', event([identityCall(config), call('empty-page', rootPath(config), { value: [] })]));
  const cursor = ledger.cursor('app:workiq:created');
  assert.ok(cursor);
  beginApp(config, { runId: 'run-B', dryRun: false, provenance: 'app-tool' });
  const failed = identityCall(config); failed.id = 'B-failed';
  delete failed.response; failed.failure = { code: 'blocked-auth', statusCode: 500 };
  blockApp(config, ledger, 'run-B', { eventId: 'B-auth-failure', pass: 'workiq:created', call: failed });
  assert.deepEqual(ledger.cursor('app:workiq:created'), cursor);
  const summary = appStatus(ledger, 'run-B');
  assert.equal(summary.collection.find(p => p.pass === 'workiq:created').nextRequest, null);
  assert.equal(listAppRuns(config).runs.length, 2);
});

test('app receipts persist app-tool-reported provenance rather than local authenticated-source', async t => {
  const { config, ledger } = setup(t, { provenance: 'app-tool' });
  await appendApp(config, ledger, 'test-run', event([identityCall(config), call('page', rootPath(config), { value: [message()] })]));
  await adoBatch(config, ledger);
  assert.ok(ledger.all('evidence').every(e => e.source.provenance === 'app-tool-reported'));
  assert.equal(appStatus(ledger, 'test-run').collection.find(p => p.pass === 'ado:created').identityVerification,
    'validated-app-reported-principal');
});

test('app first ADO source error remains failed-source rather than invented authentication failure', async t => {
  const { config, ledger } = setup(t, { provenance: 'app-tool' });
  let requests = 0;
  const result = await collectAppAdo(config, ledger, 'test-run', 'ado:created', async () => async () => {
    requests++; throw Object.assign(new Error('synthetic service unavailable'), { code: 'failed-source' });
  });
  const pass = result.collection.find(p => p.pass === 'ado:created');
  assert.equal(pass.state, 'failed-source');
  assert.equal(pass.identityVerified, false);
  assert.equal(requests, 1);
  await assert.rejects(collectAppAdo(config, ledger, 'test-run', 'ado:created'), /already recorded/);
});

test('app ADO authentication failure suppresses changed pass without another factory/request', async t => {
  const { config, ledger } = setup(t, { provenance: 'app-tool' });
  await collectAppAdo(config, ledger, 'test-run', 'ado:created', async () => async () => {
    throw Object.assign(new Error('synthetic auth failure'), { code: 'blocked-auth' });
  });
  await assert.rejects(collectAppAdo(config, ledger, 'test-run', 'ado:changed', async () => {
    assert.fail('Must not acquire another client'); }), /cross-pass retry/);
});

test('source links with whitespace are URI normalized while original receipt bytes are unchanged', () => {
  const item = { id: 1, rev: 2, fields: { 'System.WorkItemType': 'Bug', 'System.AreaPath': area, 'System.State': 'Resolved',
    'Microsoft.VSTS.Common.ResolvedReason': 'Fixed' },
    relations: [{ rel: 'Hyperlink', url: 'https://example.invalid/path with space' }] };
  const record = adoRecord(item, 'synthetic query', '2026-10-09T00:00:00Z');
  assert.equal(record.links[0].url, 'https://example.invalid/path%20with%20space');
  assert.equal(item.relations[0].url, 'https://example.invalid/path with space');
});

test('nested ledger evidence operations roll back atomically with app event failures', t => {
  const { ledger } = setup(t);
  assert.throws(() => ledger.transaction(() => {
    ledger.db.prepare('INSERT INTO captures VALUES(?,?)').run('test-digest', Buffer.from('test'));
    ledger.transaction(() => ledger.db.prepare('INSERT INTO captures VALUES(?,?)').run('nested-digest', Buffer.from('nested')));
    throw new Error('synthetic failure');
  }));
  assert.equal(ledger.db.prepare('SELECT COUNT(*) n FROM captures').get().n, 0);
});

test('app item budget retains permitted evidence and reports excess returned records unexamined', async t => {
  const { config, ledger } = setup(t);
  const saved = JSON.parse(ledger.db.prepare('SELECT body FROM app_runs WHERE id=?').get('test-run').body);
  saved.limits.maxItems = 1;
  ledger.db.prepare('UPDATE app_runs SET body=? WHERE id=?').run(json(saved), 'test-run');
  const result = await appendApp(config, ledger, 'test-run', event([identityCall(config),
    call('limited-page', rootPath(config), { value: [message('one'), message('two')] })]));
  const pass = result.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.state, 'partial'); assert.equal(pass.examinedRecords, 1);
  assert.equal(pass.returnedRecords, 2); assert.equal(pass.unexaminedReturnedRecords, 1);
  assert.equal(pass.evidenceCount, 1); assert.equal(pass.nextRequest, null);
  assert.equal(ledger.cursor('app:workiq:created'), null);
});

test('app read-call exhaustion remains visible partial without an executable continuation', async t => {
  const { config, ledger } = setup(t);
  const saved = JSON.parse(ledger.db.prepare('SELECT body FROM app_runs WHERE id=?').get('test-run').body);
  saved.limits.maxCalls = 1;
  ledger.db.prepare('UPDATE app_runs SET body=? WHERE id=?').run(json(saved), 'test-run');
  const result = await appendApp(config, ledger, 'test-run', event([identityCall(config)]));
  const pass = result.collection.find(p => p.pass === 'workiq:created');
  assert.equal(pass.state, 'partial'); assert.equal(pass.readCalls, 1); assert.equal(pass.nextRequest, null);
  assert.match(pass.error.message, /budget/);
});
