import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { Ledger } from './ledger.js';
import { noCredentials } from './app-native.js';
import { hash, json, requireThat, utc, windowCheck, positive, safeError } from './common.js';

export function decodeIcmResponse(response) {
  requireThat(response && response.isError !== true, 'IcM tool returned an error', 'failed-source');
  if (response.structuredContent !== undefined) {
    requireThat(response.structuredContent && typeof response.structuredContent === 'object',
      'Unknown IcM structured envelope', 'invalid-record');
    return response.structuredContent;
  }
  requireThat(Array.isArray(response.content) && response.content.length === 1 &&
    response.content[0].type === 'text', 'Unknown IcM MCP envelope', 'invalid-record');
  try { return JSON.parse(response.content[0].text); }
  catch { requireThat(false, 'IcM text envelope is not JSON', 'invalid-record'); }
}

export function icmSearchRequest(mapping, window, nextPageToken = null) {
  const request = { owningTeamId: mapping.owningTeamId, severity: mapping.severity,
    dateRange: { createdAfter: window.start, createdBefore: window.end },
    top: mapping.top, sortBy: [{ field: 'CreatedDate', direction: 'Descending' }] };
  if (nextPageToken !== null) request.nextPageToken = nextPageToken;
  return { incidentAdvancedSearchRequest: request };
}

export function configuredIcmMapping(source) {
  requireThat(source?.enabled === true && source.scopeApproved === true &&
    source.timestampContract === 'incident-created',
  'IcM receipt ingestion requires enabled, scope-approved, explicitly selected incident-created mode', 'blocked-scope');
  return { owningTeamId: source.owningTeamId, severity: source.severity, top: source.top,
    teamVerified: true, severityVerified: true, timestampContract: source.timestampContract };
}

// This is a receipt adapter, not a connector launcher or source authorization.
export function replayIcm(bundle, identity) {
  requireThat(bundle?.format === 'icm-receipts-v1' && /^[a-zA-Z0-9][\w.-]{0,127}$/.test(bundle.id) &&
    ['app-tool-reported', 'synthetic'].includes(bundle.provenance) && Array.isArray(bundle.calls),
  'Invalid IcM receipt bundle', 'invalid-record');
  noCredentials(bundle); windowCheck(bundle.window);
  positive(bundle.limits?.maxItems, 'maxItems'); positive(bundle.limits?.maxCalls, 'maxCalls');
  const mapping = bundle.mapping;
  positive(mapping?.owningTeamId, 'owningTeamId'); positive(mapping.top, 'top');
  requireThat(mapping.top <= 100 && mapping.teamVerified === true && mapping.severityVerified === true &&
    Array.isArray(mapping.severity) && isDeepStrictEqual([...mapping.severity].sort((a, b) => a - b), [1, 2, 25]),
  'Verified team and UI 1/2/2.5 to API 1/2/25 mapping required', 'blocked-scope');
  requireThat(mapping.timestampContract === null || mapping.timestampContract === 'incident-created',
    'Source Created Time has no verified connector input mapping', 'blocked-scope');
  requireThat(bundle.calls.length <= bundle.limits.maxCalls, 'Receipt bundle exceeds approved read cap', 'blocked-scope');
  const result = { format: 'icm-replay-report-v1', id: bundle.id, provenance: bundle.provenance,
    window: bundle.window, mapping, state: 'partial', enumeration: 'partial', identityVerified: false,
    liveActivation: 'blocked', cohortCoverage: 'blocked', sourceCallsByHelper: 0, cursorAdvanced: false,
    ingestedIntoSourceLedger: false, suppliedReadReceipts: bundle.calls.length,
    unprocessedReadReceipts: bundle.calls.length, readCalls: 0, returnedRecords: 0, examinedRecords: 0,
    duplicateVersions: 0, uniqueIncidents: 0, versions: [], reportedTotals: [], unexaminedReturnedRecords: 0,
    remainingSourceRecords: null, nextRequest: { tool: 'get_my_icm_context', arguments: {} },
    limitations: ['Imported identity is app-tool-reported, not independently authenticated by this replay.',
      'No saved-query Source Created Time equivalence; incident-created diagnostics are not saved-query coverage.',
      'Current search snapshots cannot reconstruct historical contents or prove deletion/change completeness.',
      'Reported totals may change across pages; remaining source count is unknown until observed exhaustion.',
      'Live connector execution remains disabled; no retries, changed lane or cursor advancement.'] };
  const ids = new Set(), versions = new Set(), tokens = new Set(), callIds = new Set();
  let expected = result.nextRequest;
  try {
    for (const [index, call] of bundle.calls.entries()) {
      requireThat(expected && call && typeof call.id === 'string' && call.id && !callIds.has(call.id),
        'Unexpected/duplicate IcM receipt after stop', 'invalid-record');
      callIds.add(call.id); utc(call.requestedAt); utc(call.observedAt);
      requireThat(Date.parse(call.observedAt) >= Date.parse(call.requestedAt), 'IcM receipt time order is invalid', 'invalid-record');
      requireThat(call.tool === expected.tool && isDeepStrictEqual(call.arguments, expected.arguments),
        'IcM receipt does not match exact scoped next request', 'blocked-scope');
      result.readCalls++;
      requireThat(Object.hasOwn(call, 'response') !== Object.hasOwn(call, 'failure'),
        'IcM receipt requires exactly one response or failure', 'invalid-record');
      if (call.failure) {
        requireThat(['blocked-auth', 'failed-source', 'unavailable'].includes(call.failure.code), 'Invalid IcM failure', 'invalid-record');
        requireThat(false, 'Recorded IcM read failed; no retry or head restart authorized', call.failure.code);
      }
      const data = decodeIcmResponse(call.response);
      if (index === 0) {
        requireThat(data.contact?.emailAddress?.toLowerCase() === identity.designatedUser.toLowerCase() &&
          data.contact.alias === identity.designatedUser.split('@')[0] && data.contact.status === 'Active',
        'IcM delegated active identity mismatch', 'blocked-auth');
        result.identityVerified = true;
        expected = { tool: 'search_incidents', arguments: icmSearchRequest(mapping, bundle.window) };
        continue;
      }
      requireThat(data.success === true && Array.isArray(data.value), 'Unknown/failed IcM search response',
        [401, 403].includes(data.httpStatus) ? 'blocked-auth' : 'failed-source');
      result.returnedRecords += data.value.length;
      requireThat(data.nextPageToken === undefined || data.nextPageToken === null ||
        (typeof data.nextPageToken === 'string' && data.nextPageToken.length > 0),
      'Invalid IcM continuation token', 'invalid-record');
      if (data['@odata.count'] !== undefined) {
        requireThat(data['@odata.count'] === null ||
          Number.isSafeInteger(data['@odata.count']) && data['@odata.count'] >= 0, 'Invalid IcM count', 'invalid-record');
        result.reportedTotals.push(data['@odata.count']);
      }
      requireThat(data.value.length <= mapping.top, 'IcM page exceeds configured top', 'partial');
      for (const [offset, row] of data.value.entries()) {
        if (result.examinedRecords >= bundle.limits.maxItems) {
          result.bufferedPosition = { callId: call.id, offset };
          requireThat(false, 'IcM examination budget exhausted; buffered rows retained in capture', 'partial');
        }
        result.examinedRecords++;
        requireThat(row && Number.isSafeInteger(row.id) && row.id > 0 && row.owningTeamId === mapping.owningTeamId &&
          mapping.severity.includes(row.severity), 'IcM returned a row outside team/severity scope', 'blocked-scope');
        utc(row.createdDate);
        for (const field of ['title', 'state'])
          requireThat(row[field] == null || typeof row[field] === 'string',
            `Invalid IcM ${field}`, 'invalid-record');
        requireThat(Date.parse(row.createdDate) >= Date.parse(bundle.window.start) &&
          Date.parse(row.createdDate) < Date.parse(bundle.window.end), 'IcM incident-created date outside request', 'blocked-scope');
        const digest = hash(json(row)), key = `${row.id}:${digest}`;
        if (versions.has(key)) { result.duplicateVersions++; continue; }
        ids.add(row.id); versions.add(key);
        result.versions.push({ recordId: String(row.id), revision: null, versionBasis: 'captured-payload-hash',
          sha256: digest, callId: call.id, offset, observedAt: call.observedAt, requestedAt: call.requestedAt,
          request: call.arguments, createdDate: row.createdDate,
          ...(Object.hasOwn(row, 'sourceCreateTime') ? { sourceCreateTime: row.sourceCreateTime } : {}),
          sourceCreateTimePresent: Object.hasOwn(row, 'sourceCreateTime'), artifactRef: `sqlite:capture:${digest}` });
      }
      const token = data.nextPageToken ?? null;
      requireThat(token === null || !tokens.has(token), 'IcM pagination token cycle', 'failed-source');
      if (token !== null) tokens.add(token);
      expected = token === null ? null : { tool: 'search_incidents',
        arguments: icmSearchRequest(mapping, bundle.window, token) };
    }
    result.enumeration = expected === null ? 'complete' : 'partial';
    if (expected && result.readCalls >= bundle.limits.maxCalls)
      result.error = { code: 'partial', message: 'IcM read cap reached; pending request is audit-only' };
    if (expected && result.examinedRecords >= bundle.limits.maxItems)
      result.error = { code: 'partial', message: 'IcM examination cap reached; pending request is audit-only' };
  } catch (error) {
    result.error = safeError(error);
    result.enumeration = result.error.code === 'partial' ? 'partial' : 'blocked';
  }
  result.uniqueIncidents = ids.size;
  result.unprocessedReadReceipts = bundle.calls.length - result.readCalls;
  result.unexaminedReturnedRecords = result.returnedRecords - result.examinedRecords;
  result.nextRequest = result.error ? null : expected;
  result.pendingRequest = result.error?.code === 'partial' ? expected : null;
  result.state = result.error?.code === 'blocked-auth' ? 'blocked-auth'
    : mapping.timestampContract === null || result.enumeration === 'blocked' ? 'blocked' : result.enumeration;
  if (mapping.timestampContract === null) result.timestampBlocker = 'Saved-query Source Created Time mapping unresolved';
  if (result.enumeration === 'complete') result.remainingSourceRecords = 0;
  return result;
}

export function persistIcmReplay(config, bundle) {
  requireThat(config.statePolicy.accessApproved, 'Local evidence storage approval required');
  const report = replayIcm(bundle, config.identity);
  const ledger = new Ledger(join(config.stateDirectory, 'icm-replays', bundle.id));
  try {
    const body = Buffer.from(json(bundle)), digest = hash(body);
    ledger.transaction(() => {
      const old = ledger.db.prepare("SELECT detail FROM operations WHERE id='receipt-bundle'").get();
      requireThat(!old || JSON.parse(old.detail).sha256 === digest, 'Immutable IcM replay ID conflict', 'invalid-record');
      const capture = value => {
        const bytes = Buffer.from(json(value)), sha = hash(bytes);
        ledger.db.prepare('INSERT OR IGNORE INTO captures VALUES(?,?)').run(sha, bytes);
        return { artifactRef: `sqlite:capture:${sha}`, sha256: sha };
      };
      report.bundleCapture = capture(bundle);
      report.callCaptures = bundle.calls.map(call => ({ callId: call.id, ...capture(call) }));
      for (const version of report.versions) {
        const call = bundle.calls.find(c => c.id === version.callId);
        capture(decodeIcmResponse(call.response).value[version.offset]);
      }
      ledger.db.prepare("INSERT OR IGNORE INTO operations VALUES('receipt-bundle',?,'icm-offline-replay','completed',?,?)")
        .run(bundle.id, json({ sha256: digest }), bundle.calls.at(-1)?.observedAt ?? bundle.window.end);
    });
    report.summaryPath = join(ledger.directory, 'coverage.json');
    writeFileSync(report.summaryPath, json(report), { mode: 0o600 });
    return report;
  } finally { ledger.close(); }
}
