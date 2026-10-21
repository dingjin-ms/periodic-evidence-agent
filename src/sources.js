import { AzureCliCredential } from '@azure/identity';
import { Budget, PilotError, hash, json, now, requireThat, readJson, utc, validateRecord, windowCheck } from './common.js';
import { withWorkiq, validateSeed, principalPath, verifyPrincipal, channelRoot, messageSelect, nextWorkiqPage } from './runtime.js';
import { adoCohortWiql, requireAdoCohort } from './ado-cohort.js';

export const area = 'OC\\Excel\\Intelligence\\Copilot\\Excel Agent';
export const adoFields = [
  'System.Id', 'System.WorkItemType', 'System.Title', 'System.State', 'System.Reason',
  'System.CreatedDate', 'System.ChangedDate', 'System.AreaPath', 'System.Tags',
  'Microsoft.VSTS.Common.ResolvedReason', 'Microsoft.VSTS.CMMI.HowFound',
  'Office.Common.FeedbackSources', 'Office.Common.CustomerType', 'Office.Common.IcMID',
  'Office.Common.IcMIncidentIDs', 'System.Description', 'Microsoft.VSTS.TCM.ReproSteps',
  'Office.Common.IssueType', 'Office.Common.LinkedToOCVIssue'
];
export function wiql(window, lane = 'created', asOf = null) {
  windowCheck(window);
  requireThat(['created', 'changed'].includes(lane), 'Unknown query lane');
  const field = lane === 'created' ? 'System.CreatedDate' : 'System.ChangedDate';
  return `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'OC' AND [System.WorkItemType] = 'Bug' AND [System.AreaPath] UNDER '${area}' AND ${adoCohortWiql} AND [${field}] >= '${window.start}' AND [${field}] < '${window.end}' ORDER BY [System.Id]${asOf ? ` ASOF '${utc(asOf)}'` : ''}`;
}
export function evidenceEnvelope(kind, namespace, id, revision, url, query, snapshot = null) {
  const time = now();
  return {
    recordType: 'evidence', schemaVersion: '1.0', id: 'pending-capture',
    source: { kind, namespace, recordId: String(id), revision, versionBasis: revision ? 'source-revision' : 'captured-payload-hash',
      provenance: 'authenticated-source', ownerConfirmation: null },
    scopeId: kind === 'ado' ? 'excel-agent-ado' : kind === 'icm' ? 'excel-agent-icm' : `workiq:${id}`,
    title: null, url, createdAt: null, queriedAt: time, observedAt: time, snapshotAt: snapshot,
    queryText: query, sourceStatus: null, ring: 'unknown', discoveryChannel: 'unknown',
    permittedSummary: 'Captured source evidence; not reviewed or confirmed as a code defect.',
    fields: {}, missingFields: [], links: [], discoveredFrom: null, discoveryReason: 'Configured exact seed',
    capture: { artifactRef: null, sha256: null, unavailableReason: 'Not yet persisted' }
  };
}
export function workiqTitle(subject) {
  return subject === '' ? null : subject ?? null;
}
export async function adoTransport(config) {
  const { tenantId, objectId } = config.identity;
  requireThat(tenantId && objectId, 'ADO requires approved tenantId and delegated user objectId');
  const credential = new AzureCliCredential({ tenantId, processTimeoutInMs: 30000 });
  return async (endpoint, body) => {
    requireThat(['wiql', 'workitemsbatch'].includes(endpoint), 'ADO endpoint is not read-allowlisted', 'blocked-scope');
    let token;
    try { token = await credential.getToken('499b84ac-1321-427f-aa17-267ca6975798/.default'); }
    catch { throw new PilotError('blocked-auth', 'ADO Azure CLI delegated sign-in unavailable; use supported az login for the designated account'); }
    requireThat(token?.token, 'ADO delegated sign-in returned no token', 'blocked-auth');
    const claims = JSON.parse(Buffer.from(token.token.split('.')[1], 'base64url').toString('utf8'));
    requireThat(claims.tid === tenantId && claims.oid === objectId, 'ADO account differs from the designated tenant/user', 'blocked-auth');
    const response = await fetch(`https://dev.azure.com/office/OC/_apis/wit/${endpoint}?timePrecision=true&api-version=7.1`, {
      method: 'POST', headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
      body: json(body), redirect: 'error', signal: AbortSignal.timeout(60000)
    });
    if ([401, 403].includes(response.status)) throw new PilotError('blocked-auth', `ADO returned HTTP ${response.status}; refresh approved delegated access`);
    if (!response.ok) {
      const text = await response.text();
      if (endpoint === 'wiql' && response.status === 400 && /VS402337|exceeds.*20000/i.test(text))
        throw new PilotError('query-limit', 'ADO WIQL query result limit reached');
      throw new PilotError('failed-source', `ADO ${endpoint} returned HTTP ${response.status}; no cursor advanced`);
    }
    return response.json();
  };
}
export function adoRecord(item, query, snapshot) {
  const f = item.fields;
  requireThat(f && Number.isInteger(item.rev) && f['System.WorkItemType'] === 'Bug' &&
    (f['System.AreaPath'] === area || f['System.AreaPath']?.startsWith(`${area}\\`)),
  'ADO returned out-of-scope or unversioned record', 'blocked-scope');
  requireAdoCohort(f);
  const record = evidenceEnvelope('ado', 'office/OC', item.id, String(item.rev),
    `https://dev.azure.com/office/OC/_workitems/edit/${item.id}`, query, snapshot);
  record.title = f['System.Title'] ?? null; record.createdAt = f['System.CreatedDate'] ?? null;
  record.fields = Object.fromEntries(adoFields.filter(key => key in f).map(key => [key, f[key]]));
  record.missingFields = adoFields.filter(key => !(key in f));
  record.sourceStatus = f['System.State'];
  record.links = (item.relations ?? []).filter(r => /^https:\/\//.test(r.url)).map(r => ({
    url: new URL(r.url).href, relation: r.rel, evidenceId: null, access: 'not-followed-out-of-scope'
  }));
  return record;
}
export async function readRelatedAdo(config, id, budget, request = null) {
  requireThat(config.sources.ado.scopeApproved && /^\d+$/.test(id), 'Related ADO scope is not approved', 'blocked-scope');
  request ??= await adoTransport(config);
  const query = `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'OC' AND [System.WorkItemType] = 'Bug' AND [System.AreaPath] UNDER '${area}' AND ${adoCohortWiql} AND [System.Id] = ${id}`;
  budget.call();
  const candidate = await request('wiql', { query });
  utc(candidate.asOf);
  requireThat(Array.isArray(candidate.workItems) && candidate.workItems.length === 1 &&
    String(candidate.workItems[0].id) === id, 'Related ADO item not returned by approved scope query; details were not fetched', 'blocked-scope');
  budget.call();
  const batch = await request('workitemsbatch', { ids: [Number(id)], asOf: candidate.asOf, errorPolicy: 'Fail', $expand: 'Relations' });
  requireThat(batch.value?.length === 1 && String(batch.value[0].id) === id, 'Related ADO batch is incomplete', 'partial');
  const record = adoRecord(batch.value[0], query, candidate.asOf);
  return { record, payload: { id: Number(id), rev: batch.value[0].rev, fields: record.fields, relations: record.links } };
}
export async function collectAdo(config, window, emit, lane = 'created', transport = null) {
  requireThat(config.sources.ado.scopeApproved, 'ADO scope approval is unresolved');
  const request = transport ?? await adoTransport(config);
  const budget = new Budget(config.limits);
  const seen = new Set();
  let snapshot = null;
  async function scan(part, depth = 0) {
    requireThat(depth <= 24, 'ADO query splitting exhausted; reduce the requested window', 'partial');
    const query = wiql(part, lane, snapshot);
    let candidates;
    try { budget.call(); candidates = await request('wiql', { query }); }
    catch (error) {
      if (error.code !== 'query-limit') throw error;
      requireThat(snapshot, 'WIQL limit before a snapshot was established; reduce the window explicitly', 'partial');
      const middle = Math.floor((Date.parse(part.start) + Date.parse(part.end)) / 2);
      requireThat(middle > Date.parse(part.start) && middle < Date.parse(part.end), 'Unsplittable WIQL window', 'partial');
      await scan({ start: part.start, end: new Date(middle).toISOString() }, depth + 1);
      await scan({ start: new Date(middle).toISOString(), end: part.end }, depth + 1);
      return;
    }
    utc(candidates.asOf);
    snapshot ??= candidates.asOf;
    requireThat(Date.parse(snapshot) === Date.parse(candidates.asOf), 'ADO query snapshot changed during enumeration', 'partial');
    requireThat(Array.isArray(candidates.workItems), 'WIQL missing candidate list', 'failed-source');
    if (candidates.workItems.length >= 20000) {
      const middle = Math.floor((Date.parse(part.start) + Date.parse(part.end)) / 2);
      requireThat(middle > Date.parse(part.start) && middle < Date.parse(part.end), 'Unsplittable WIQL window', 'partial');
      await scan({ start: part.start, end: new Date(middle).toISOString() }, depth + 1);
      await scan({ start: new Date(middle).toISOString(), end: part.end }, depth + 1);
      return;
    }
    const ids = [...new Set(candidates.workItems.map(item => item.id))].filter(id => !seen.has(id));
    requireThat(ids.every(id => Number.isSafeInteger(id) && id > 0), 'Invalid ADO candidate IDs', 'failed-source');
    const selected = ids.slice(0, budget.items);
    budget.item(selected.length);
    for (let offset = 0; offset < selected.length; offset += 200) {
      const batch = selected.slice(offset, offset + 200);
      budget.call();
      const result = await request('workitemsbatch', { ids: batch, asOf: snapshot, errorPolicy: 'Fail', $expand: 'Relations' });
      requireThat(Array.isArray(result.value) && result.value.length === batch.length &&
        new Set(result.value.map(i => i.id)).size === batch.length &&
        result.value.every(i => batch.includes(i.id)), 'ADO batch missing, duplicate or unexpected records', 'partial');
      for (const item of result.value) {
        const f = item.fields;
        const record = adoRecord(item, query, snapshot);
        const date = f[lane === 'created' ? 'System.CreatedDate' : 'System.ChangedDate'];
        utc(date);
        requireThat(Date.parse(date) >= Date.parse(part.start) && Date.parse(date) < Date.parse(part.end), 'ADO date outside query window', 'blocked-scope');
        await emit(record, { id: item.id, rev: item.rev, fields: record.fields, relations: record.links });
        seen.add(item.id);
      }
    }
    requireThat(selected.length === ids.length, 'Item budget exhausted; coverage is partial', 'partial');
  }
  // A zero-result seed establishes one snapshot before potentially splitting a large interval.
  budget.call();
  const anchor = await request('wiql', { query: "SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = 'OC' AND [System.Id] = 0" });
  snapshot = utc(anchor.asOf);
  await scan(window);
  return { end: window.end, snapshot, lane };
}
export async function collectWorkiq(config, window, emit, retrieve = null, lane = 'created', options = {}) {
  const source = config.sources.workiq;
  requireThat(['created', 'changed'].includes(lane), 'Unknown WorkIQ collection lane');
  requireThat(source.scopeApproved, 'WorkIQ scope needs approval');
  requireThat(source.seeds.length > 0, 'WorkIQ has no approved exact seeds; broad search is disabled');
  const budget = new Budget(config.limits);
  const stats = options.stats ?? {};
  Object.assign(stats, { examined: 0, returned: 0, duplicates: 0, roots: 0, replies: 0, threads: 0 });
  const context = query => ({ query, observedAt: now(), provenance: 'authenticated-source', ...options.readContext?.() });
  const execute = async read => {
    budget.call();
    verifyPrincipal(config, await read(principalPath));
    const coverage = [];
    for (const seed of source.seeds) {
      if (seed.kind === 'teams-channel') {
        requireThat(seed.includeReplies, 'Channel collection requires approved reply traversal', 'blocked-scope');
        const root = channelRoot(seed), visited = new Set(), seen = new Set(), threads = new Set();
        const examinedBeforeSeed = stats.examined;
        async function* pages(path) {
          let next = path;
          while (next) {
            const canonical = new URL(next, 'https://scope.invalid');
            canonical.searchParams.sort();
            const key = decodeURIComponent(canonical.pathname) + '?' + canonical.searchParams.toString();
            requireThat(!visited.has(key), 'WorkIQ pagination cycle; coverage is partial', 'partial');
            visited.add(key); budget.call();
            const page = await read(next);
            requireThat(Array.isArray(page.value), 'WorkIQ channel response lacks a message collection', 'blocked-protocol');
            stats.returned += page.value.length;
            yield { messages: page.value, query: next, observation: context(next) };
            next = page['@odata.nextLink'] ? nextWorkiqPage(config, page['@odata.nextLink'], path) : null;
          }
        }
        async function accept(message, observation, parent = null, parentObservation = null) {
          // Every returned row costs examination budget, including duplicate versions.
          budget.item(); stats.examined++;
          requireThat(typeof message.id === 'string' && message.id && !/[\/\\?#]|\.\./.test(message.id),
            'Invalid channel message identity', 'blocked-protocol');
          if (parent) requireThat(message.replyToId == null || message.replyToId === parent.id,
            'Reply points outside the enumerated thread', 'blocked-scope');
          else requireThat(message.replyToId == null, 'Root collection returned a reply', 'blocked-protocol');
          if (message.channelIdentity) requireThat(
            message.channelIdentity.teamId === seed.teamId && message.channelIdentity.channelId === seed.channelId,
            'Message identity is outside the approved channel', 'blocked-scope');
          const key = json([parent?.id ?? null, message.id, hash(json(message))]);
          const duplicate = seen.has(key);
          if (duplicate) stats.duplicates++;
          else { seen.add(key); stats[parent ? 'replies' : 'roots']++; }
          await options.onMessage?.({ seedId: seed.id, teamId: seed.teamId, channelId: seed.channelId,
            rootId: parent?.id ?? message.id, messageId: message.id, isReply: Boolean(parent),
            message, parentContext: parent, observation, parentObservation, duplicate,
            versionHash: hash(json(message)) });
          if (duplicate) return;
          const date = lane === 'changed' ? message.lastModifiedDateTime : message.createdDateTime;
          requireThat(date != null, `WorkIQ ${lane} timestamp is missing; lane coverage is unknown`, 'blocked-protocol');
          utc(date);
          if (Date.parse(date) < Date.parse(window.start) || Date.parse(date) >= Date.parse(window.end)) return;
          const revision = message.etag ?? message['@odata.etag'] ?? null;
          const record = evidenceEnvelope('workiq', `workiq/${seed.teamId}/${seed.channelId}${parent ? `/thread/${parent.id}` : ''}`,
            message.id, revision, message.webUrl ?? seed.url, json({ entityUrls: [observation.query], lane, window }));
          record.queriedAt = observation.observedAt; record.observedAt = observation.observedAt;
          record.source.provenance = observation.provenance;
          record.scopeId = `workiq:${seed.id}`;
          record.title = workiqTitle(message.subject); record.createdAt = message.createdDateTime ?? null;
          record.source.versionBasis = revision ? 'source-etag' : 'captured-payload-hash';
          record.fields = { message, parentContext: parent, sourceObservation: observation, parentObservation,
            thread: { teamId: seed.teamId, channelId: seed.channelId, rootId: parent?.id ?? message.id,
              messageId: message.id, isReply: Boolean(parent) },
            requestedWindow: window, selectionLane: lane,
            modifiedAfterWindow: message.lastModifiedDateTime ? Date.parse(message.lastModifiedDateTime) >= Date.parse(window.end) : null,
            coverage: 'Current channel enumeration, not a historical snapshot' };
          record.missingFields = ['etag', 'webUrl', 'body'].filter(k => message[k] === undefined || message[k] === null);
          record.discoveryReason = parent ? 'In-window reply in the approved channel, with parent context' : 'In-window root message in the approved channel';
          if (parent) record.links = [{ url: parent.webUrl ?? seed.url, relation: 'reply-to', evidenceId: null, access: 'retrieved-in-scope' }];
          await emit(record, { message, parentContext: parent });
        }
        const querySuffix = `?$select=${source.projection ?? messageSelect}&$top=50`;
        for await (const page of pages(`${root}${querySuffix}`)) {
          const freshParents = new Map();
          for (const parent of page.messages) {
            await accept(parent, page.observation);
            if (!threads.has(parent.id)) freshParents.set(parent.id, parent);
            else if (freshParents.has(parent.id) &&
              Date.parse(parent.lastModifiedDateTime ?? parent.createdDateTime) >=
              Date.parse(freshParents.get(parent.id).lastModifiedDateTime ?? freshParents.get(parent.id).createdDateTime))
              freshParents.set(parent.id, parent);
            threads.add(parent.id);
          }
          for (const parent of freshParents.values()) {
            // An old root can have an in-window reply: do not stop or skip replies based on root age.
            for await (const replies of pages(`${root}/${encodeURIComponent(parent.id)}/replies${querySuffix}`))
              for (const reply of replies.messages) await accept(reply, replies.observation, parent, page.observation);
            stats.threads++;
          }
        }
        coverage.push({ seedId: seed.id, kind: 'channel-pages-and-replies-exhausted',
          messagesExamined: stats.examined - examinedBeforeSeed, uniqueVersions: seen.size,
          pagesRead: visited.size, snapshotConsistent: false, incrementalMethod: 'full-enumeration-local-timestamp-filter',
          limitations: ['No WorkIQ delta contract established', 'Concurrent edits/reordering can move messages across pages',
            'Only returned tombstones are visible; absent messages do not prove deletion',
            'Previously traversed threads are not revisited within this enumeration'] });
      } else {
        validateSeed(seed); budget.item(); budget.call();
        stats.examined++;
        const result = await read(seed.path);
        stats.returned++;
        const record = evidenceEnvelope('workiq', 'workiq/exact-seeds', seed.id, null, seed.url, json({ entityUrls: [seed.path] }));
        const observation = context(seed.path);
        record.queriedAt = observation.observedAt; record.observedAt = observation.observedAt;
        record.source.provenance = observation.provenance;
        record.fields = { retrieval: result, coverage: 'Exact current entity snapshot; not an exhaustive time-window search', requestedWindow: window };
        record.missingFields = ['sourceRevision', 'sourceCreatedAt'];
        await emit(record, result);
        coverage.push({ seedId: seed.id, kind: 'exact-seed-snapshot-only' });
      }
    }
    return { end: window.end, coverage };
  };
  return retrieve ? execute(retrieve) : withWorkiq(config, execute);
}
export async function collectIcm(config, window, emit) {
  const source = config.sources.icm;
  requireThat(source.timestampContract == null,
    'Incident-created IcM receipts use app-append; owner exports remain saved-query only', 'blocked-source');
  requireThat(source.scopeApproved && source.filtersVerified && source.queryId === '599514',
    'IcM query 599514 filters and scope are not verified', 'blocked-source');
  requireThat(source.ownerExport, 'No supported authenticated IcM connector is configured; supply an approved owner export', 'blocked-source');
  const bundle = readJson(source.ownerExport);
  requireThat(bundle.queryId === '599514' && json(bundle.window) === json(window) && Array.isArray(bundle.evidence),
    'Owner export does not match query/window', 'invalid-record');
  const budget = new Budget(config.limits);
  for (const record of bundle.evidence) {
    budget.item(); validateRecord(record, 'evidence');
    requireThat(record.source.kind === 'icm' && record.source.namespace === 'icm/query/599514' &&
      record.scopeId === 'excel-agent-icm' && record.source.provenance === 'owner-provided' &&
      record.source.ownerConfirmation?.confirmedScope === 'icm/query/599514',
    'IcM export requires owner-confirmed query scope and owner-provided provenance', 'invalid-record');
    requireThat(record.createdAt && Date.parse(record.createdAt) >= Date.parse(window.start) &&
      Date.parse(record.createdAt) < Date.parse(window.end), 'Incident outside approved UTC creation window', 'blocked-scope');
    const original = structuredClone(record);
    record.observedAt = now();
    await emit(record, original);
  }
  return { end: window.end, coverage: 'owner-export-only', exportHash: hash(json(bundle)) };
}
