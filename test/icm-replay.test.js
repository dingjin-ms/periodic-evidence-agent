import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { configAt, hash } from '../src/common.js';
import { icmSearchRequest, replayIcm, persistIcmReplay } from '../src/icm-replay.js';

const identity = { designatedUser: 'collector@example.invalid' };
const envelope = data => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });
const row = (id = 42, title = 'Synthetic incident') => ({ id, title, owningTeamId: 123, severity: 25,
  createdDate: '2026-10-08T01:00:00Z' });
function fixture() {
  const b = { format: 'icm-receipts-v1', id: 'synthetic-icm', provenance: 'synthetic',
    window: { start: '2026-10-08T00:00:00Z', end: '2026-10-09T00:00:00Z' },
    limits: { maxItems: 4, maxCalls: 4 }, mapping: { owningTeamId: 123,
      severity: [1, 2, 25], teamVerified: true, severityVerified: true, top: 3, timestampContract: null },
    calls: [{ id: 'identity', tool: 'get_my_icm_context', arguments: {},
      requestedAt: '2026-10-10T01:00:00Z', observedAt: '2026-10-10T01:00:01Z',
      response: envelope({ contact: { alias: 'collector', emailAddress: identity.designatedUser, status: 'Active' } }) }] };
  return b;
}
function page(b, rows, next = null, previous = null) {
  b.calls.push({ id: `call-${b.calls.length}`, tool: 'search_incidents',
    arguments: icmSearchRequest(b.mapping, b.window, previous),
    requestedAt: '2026-10-10T01:00:02Z', observedAt: '2026-10-10T01:00:03Z',
    response: { structuredContent: { success: true, value: rows, nextPageToken: next, '@odata.count': 5 } } });
  return b;
}
test('IcM exact request retains verified wire severities, bounds and opaque MCP token', () => {
  const b = fixture(), request = icmSearchRequest(b.mapping, b.window, 'opaque/+==');
  assert.deepEqual(request.incidentAdvancedSearchRequest.severity, [1, 2, 25]);
  assert.equal(request.incidentAdvancedSearchRequest.nextPageToken, 'opaque/+==');
  assert.deepEqual(request.incidentAdvancedSearchRequest.dateRange,
    { createdAfter: b.window.start, createdBefore: b.window.end });
  assert.equal(request.incidentAdvancedSearchRequest.skip, undefined);
});
test('IcM complete diagnostic enumeration remains blocked for Source Created Time cohort', () => {
  const r = replayIcm(page(fixture(), [row()]), identity);
  assert.equal(r.identityVerified, true); assert.equal(r.enumeration, 'complete');
  assert.equal(r.state, 'blocked'); assert.equal(r.cohortCoverage, 'blocked');
  assert.equal(r.versions[0].sourceCreateTimePresent, false);
  assert.equal(r.sourceCallsByHelper, 0); assert.equal(r.cursorAdvanced, false);
});
test('IcM pages dedupe exact payloads, retain revisions, count all examined rows', () => {
  const b = page(fixture(), [row()], 'page2');
  page(b, [row(), row(42, 'changed'), row(43)], null, 'page2');
  const r = replayIcm(b, identity);
  assert.equal(r.enumeration, 'complete'); assert.equal(r.readCalls, 3);
  assert.equal(r.examinedRecords, 4); assert.equal(r.duplicateVersions, 1);
  assert.equal(r.versions.length, 3); assert.equal(r.uniqueIncidents, 2);
});
test('IcM cap retains returned but unexamined tail and does not mark terminal page complete', () => {
  const b = page(fixture(), [row(), row(43), row(44)]); b.limits.maxItems = 2;
  const r = replayIcm(b, identity);
  assert.equal(r.enumeration, 'partial'); assert.equal(r.returnedRecords, 3);
  assert.equal(r.examinedRecords, 2); assert.equal(r.unexaminedReturnedRecords, 1);
  assert.equal(r.bufferedPosition.offset, 2); assert.equal(r.nextRequest, null);
});
test('IcM call cap leaves pending pages partial, never infers remaining count from total', () => {
  const b = page(fixture(), [row()], 'next'); b.limits.maxCalls = 2;
  const r = replayIcm(b, identity);
  assert.equal(r.enumeration, 'partial'); assert.equal(r.remainingSourceRecords, null);
  assert.match(r.error.message, /read cap/); assert.equal(r.nextRequest, null);
});
test('IcM failures preserve partial captures and reject identity, shape, pagination and scope drift', () => {
  for (const mutate of [
    b => { b.calls[0].response = envelope({ contact: { alias: 'other', emailAddress: identity.designatedUser, status: 'Active' } }); },
    b => { b.calls[1].response = { content: [{ type: 'text', text: 'unknown' }] }; },
    b => { b.calls[1].arguments.incidentAdvancedSearchRequest.owningTeamId = 999; },
    b => { b.calls[1].response.structuredContent.value[0].severity = 0; },
    b => { b.calls[1].response.structuredContent.value[0].createdDate = b.window.end; }
  ]) {
    const b = page(fixture(), [row()]); mutate(b);
    assert.equal(replayIcm(b, identity).enumeration, 'blocked');
  }
  const b = page(fixture(), [row()], 'repeat');
  page(b, [row(43)], 'repeat', 'repeat');
  assert.match(replayIcm(b, identity).error.message, /cycle/);
  delete b.calls[2].response; b.calls[2].failure = { code: 'blocked-auth' };
  const r = replayIcm(b, identity);
  assert.equal(r.state, 'blocked-auth'); assert.equal(r.versions.length, 1);
  assert.equal(r.nextRequest, null);
});
test('IcM refuses invented timestamp mapping and credential-bearing captures', () => {
  const b = fixture(); b.mapping.timestampContract = 'sourceCreateTime';
  assert.throws(() => replayIcm(b, identity), /no verified/);
  b.mapping.timestampContract = null; b.calls[0].response.headers = { value: 'private' };
  assert.throws(() => replayIcm(b, identity), /credentials/);
});
test('IcM offline persistence captures full receipt and row hashes idempotently in separate namespace', t => {
  const root = mkdtempSync(join(tmpdir(), 'icm-replay-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = configAt('pilot.example.json');
  config.statePolicy.accessApproved = true; config.stateDirectory = root;
  const b = page(fixture(), [row(), row(43)]); b.limits.maxItems = 1;
  const r = persistIcmReplay(config, b);
  assert.deepEqual(persistIcmReplay(config, b), r);
  assert.equal(JSON.parse(readFileSync(r.summaryPath)).unexaminedReturnedRecords, 1);
  const db = new DatabaseSync(join(root, 'icm-replays', b.id, 'ledger.sqlite'), { readOnly: true });
  try {
    assert.equal(db.prepare('SELECT COUNT(*) n FROM records').get().n, 0);
    assert.equal(db.prepare('SELECT COUNT(*) n FROM cursors').get().n, 0);
    const bytes = db.prepare('SELECT body FROM captures WHERE hash=?').get(r.bundleCapture.sha256).body;
    assert.equal(hash(bytes), r.bundleCapture.sha256);
  } finally { db.close(); }
  b.calls[1].response.structuredContent.value[0].title = 'changed input';
  assert.throws(() => persistIcmReplay(config, b), /identity conflict|ID conflict/);
});
