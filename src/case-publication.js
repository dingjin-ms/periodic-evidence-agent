import { adoAccessToken } from './ado-auth.js';
import { parseTestRequest, requestFields } from './ado-test-request.js';
import { hash, json, now, requireThat, safeError } from './common.js';
import { approvedCaseBatch, casePolicy, caseSupportingSourceRefs, completedOperation, fixtureBytes, httpsUrl, operationRow } from './case-generation.js';

export const generatedTag = 'GeneratedCaseRequest';
export const caseOrigin = (organization, project, repoId, caseId) =>
  `GeneratedCaseOrigin:${hash(json([organization, project, repoId, caseId]))}`;
const escape = text => String(text).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
  .replaceAll('"', '&quot;').replaceAll("'", '&#39;');
const equal = (a, b) => json(Object.entries(a).sort()) === json(Object.entries(b).sort());
export function casePublicationFields(bundle, item) {
  const destination = bundle.admission.destination;
  const marker = caseOrigin(destination.organization, destination.project, bundle.admission.repoId, item.id);
  return { ...destination.template.fields, 'System.Title': `[${item.id}] ${item.title}`,
    'System.TeamProject': destination.project, 'System.AreaPath': destination.areaPath,
    'System.WorkItemType': destination.workItemType,
    'System.Tags': [...new Set([...(destination.template.fields['System.Tags'] ?? '').split(';').map(tag => tag.trim()).filter(Boolean),
      destination.tag, generatedTag])].join('; '),
    'System.Description': `<table><tbody>${requestFields.map(([label, key]) =>
      `<tr><th>${label}</th><td>${escape(item.request[key]).replaceAll('\n', '<br>')}</td></tr>`).join('')}</tbody></table>` +
      `<p>${marker}</p><p>Case ${escape(item.id)}, revision ${item.revision}</p><ul>${item.sourceRefs.map(ref => {
        const source = bundle.sources.find(source => source.id === ref.sourceId);
        return `<li><a href="${escape(source.url)}">${escape(`${ref.sourceId}: ${ref.section}`)}</a></li>`;
      }).join('')}</ul>` };
}
function publicationPolicy(config, options) {
  const policy = casePolicy(config), publish = policy.publication;
  requireThat(options.authorizePublication === true && publish?.enabled === true &&
    publish.scopeApproved === true && publish.approvalRef?.trim() &&
    Number.isSafeInteger(publish.maxItems) && publish.maxItems > 0 && publish.maxItems <= policy.maxCases &&
    Number.isSafeInteger(publish.maxCalls) && publish.maxCalls > 0 && publish.maxCalls <= 1000,
  'ADO publication needs its own bounded write approval', 'blocked-authorization');
  return publish;
}
export async function caseAdoTransport(config, destination, policy, {
  getToken = adoAccessToken, fetchResponse = fetch, beforeRequest = () => {}
} = {}) {
  const base = `https://dev.azure.com/${encodeURIComponent(destination.organization)}/${encodeURIComponent(destination.project)}/_apis/wit/`;
  let calls = 0;
  const request = async (path, method = 'GET', body, binary = false) => {
    requireThat(++calls <= policy.maxCalls, 'Publication API call budget exhausted', 'blocked-budget');
    const url = new URL(path, base);
    requireThat(url.href.startsWith(base) || binary && url.origin === 'https://dev.azure.com' &&
      new RegExp(`^/${destination.organization}/_apis/wit/attachments/[a-f0-9-]{36}$`, 'i').test(url.pathname) || url.href ===
      `https://dev.azure.com/${encodeURIComponent(destination.organization)}/${encodeURIComponent(destination.project)}/${destination.template.teamId}/_apis/wit/templates/${destination.template.id}?api-version=7.1`,
    'ADO operation escaped its approved destination', 'blocked-scope');
    const token = await getToken(config, 'Case publication');
    publicationPolicy(config, { authorizePublication: true });
    beforeRequest();
    const response = await fetchResponse(url.href, { method, redirect: 'error',
      signal: AbortSignal.timeout(60000),
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': Buffer.isBuffer(body) ? 'application/octet-stream'
        : ['PATCH', 'POST'].includes(method) && path.startsWith('workitems/') ? 'application/json-patch+json' : 'application/json' },
      ...(body === undefined ? {} : { body: Buffer.isBuffer(body) ? body : json(body) }) });
    requireThat(response.ok, `Case publication returned HTTP ${response.status}`,
      [401, 403].includes(response.status) ? 'blocked-auth' : 'failed-publication');
    const chunks = [];
    let bytes = 0;
    for await (const chunk of response.body) {
      bytes += chunk.length;
      requireThat(bytes <= (binary ? casePolicy(config).maxFixtureBytes : casePolicy(config).maxInputBytes),
        'Publication response exceeds its byte bound', 'blocked-budget');
      chunks.push(chunk);
    }
    const result = Buffer.concat(chunks);
    return binary ? result : JSON.parse(result.toString('utf8'));
  };
  const itemPath = id => `workitems/${id}?$expand=Relations&api-version=7.1`;
  return {
    template: () => request(`https://dev.azure.com/${encodeURIComponent(destination.organization)}/${encodeURIComponent(destination.project)}/${destination.template.teamId}/_apis/wit/templates/${destination.template.id}?api-version=7.1`),
    schema: () => request(`workitemtypes/${encodeURIComponent(destination.workItemType)}?$expand=Fields&api-version=7.1`),
    lookup: async caseId => {
      const quote = value => `'${value.replaceAll("'", "''")}'`;
      const result = await request('wiql?$top=3&api-version=7.1', 'POST', {
        query: `SELECT [System.Id] FROM WorkItems WHERE [System.TeamProject] = ${quote(destination.project)} AND [System.AreaPath] = ${quote(destination.areaPath)} AND [System.Tags] CONTAINS ${quote(generatedTag)} AND [System.Title] CONTAINS ${quote(`[${caseId}]`)}`
      });
      requireThat(Array.isArray(result.workItems) && result.workItems.length <= 1 &&
        result.workItems.every(item => Number.isSafeInteger(item.id) && item.id > 0),
      'Generated-case lookup is ambiguous or incomplete', 'blocked-reconciliation');
      return result.workItems.map(item => item.id);
    },
    read: id => request(itemPath(id)),
    create: fields => request(`workitems/$${encodeURIComponent(destination.workItemType)}?api-version=7.1`, 'POST',
      Object.entries(fields).filter(([field]) => !['System.TeamProject', 'System.WorkItemType'].includes(field))
        .map(([field, value]) => ({ op: 'add', path: `/fields/${field}`, value }))),
    update: (id, revision, fields) => request(itemPath(id), 'PATCH', [
      { op: 'test', path: '/rev', value: revision },
      ...Object.entries(fields).filter(([field]) => !['System.TeamProject', 'System.WorkItemType'].includes(field))
        .map(([field, value]) => ({ op: 'add', path: `/fields/${field}`, value }))]),
    upload: (file, bytes) => request(`attachments?fileName=${encodeURIComponent(file.name)}&api-version=7.1`, 'POST', bytes),
    link: (id, revision, file, url) => request(itemPath(id), 'PATCH', [
      { op: 'test', path: '/rev', value: revision },
      { op: 'add', path: '/relations/-', value: { rel: 'AttachedFile', url, attributes: { name: file.name } } }]),
    download: value => {
      const url = new URL(attachmentUrl(destination, value));
      url.searchParams.set('api-version', '7.1');
      return request(url.href, 'GET', undefined, true);
    }
  };
}
function validateItem(item, fields) {
  requireThat(Number.isSafeInteger(item?.id) && item.id > 0 && Number.isSafeInteger(item.rev) && item.rev > 0 &&
    Object.entries(fields).every(([key, value]) => item.fields?.[key] === value),
  'ADO item read-back does not match approved fields; user edits require review', 'blocked-reconciliation');
}
function verification(ledger, id, batchId, detail) {
  const key = `${id}:verification`;
  if (!operationRow(ledger, key)) ledger.operation(key, batchId, 'case-publication-verification', {});
  ledger.finishOperation(key, 'complete', { format: 'case-publication-verification-v1', ...detail, observedAt: now() });
}
function attachmentUrl(destination, value) {
  const url = httpsUrl(value);
  const prefix = `/${destination.organization}/`;
  requireThat(url.hostname === 'dev.azure.com' && url.pathname.startsWith(prefix) &&
    new RegExp(`^/${destination.organization}/(?:${destination.project}/)?_apis/wit/attachments/[a-f0-9-]{36}$`, 'i').test(url.pathname),
  'Attachment URL escaped the approved organization/project', 'blocked-scope');
  return url.href;
}
async function mutate(ledger, id, jobId, payload, action) {
  const existing = operationRow(ledger, id);
  if (existing) {
    const stored = JSON.parse(existing.detail);
    requireThat(stored.payloadSha256 === hash(json(payload)), 'Mutation pins changed', 'blocked-reconciliation');
    requireThat(existing.state === 'complete', 'Prior mutation is uncertain; reconcile remote effects before continuing', 'blocked-reconciliation');
    return stored.result;
  }
  ledger.operation(id, jobId, 'case-publication-mutation', { payloadSha256: hash(json(payload)) });
  try {
    const result = await action();
    ledger.finishOperation(id, 'complete', { payloadSha256: hash(json(payload)), result });
    return result;
  } catch (error) {
    ledger.finishOperation(id, 'uncertain', { payloadSha256: hash(json(payload)), error: safeError(error) });
    throw error;
  }
}
export async function publishCaseBatch(config, ledger, batchId, options = {}, dependencies = {}) {
  const policy = publicationPolicy(config, options), { batch, bundle } = approvedCaseBatch(config, ledger, batchId);
  requireThat(batch.draft.cases.length <= policy.maxItems, 'Batch exceeds the independently approved publication limit', 'blocked-budget');
  const destination = bundle.admission.destination, template = destination.template;
  const source = bundle.sources.find(source => source.id === template.sourceId);
  requireThat(template.verifiedAt && source?.type === 'template' && source.access === 'complete' &&
    source.approval === 'approved' && source.applicability === 'applicable' &&
    template.fields['System.AreaPath'] === destination.areaPath,
  'Template and actual Area Path need an approved complete export before publication', 'blocked-authorization');
  const lock = `case-publication:${destination.organization}:${destination.project}`, owner = ledger.acquire(lock);
  try {
    const transport = dependencies.transport ?? await caseAdoTransport(config, destination, policy,
      { ...dependencies, beforeRequest: () => approvedCaseBatch(config, ledger, batchId) });
    const currentTemplate = await transport.template(), schema = await transport.schema();
    requireThat(currentTemplate.id === template.id && currentTemplate.workItemTypeName === destination.workItemType &&
      equal(currentTemplate.fields, template.fields), 'ADO template changed from its approved export', 'blocked-reconciliation');
    requireThat(schema.name === destination.workItemType && Array.isArray(schema.fields),
      'ADO work-item schema could not be verified', 'blocked-reconciliation');
    const results = [];
    for (const item of batch.draft.cases) {
      const id = `${batchId}:publication:${item.id}`;
      try {
        const fields = casePublicationFields(bundle, item), parsed = parseTestRequest(fields['System.Description']);
        requireThat(parsed.missing.length === 0 && equal(parsed.fields, item.request),
          'Canonical request does not round-trip through the five-field parser', 'blocked-result');
        requireThat(item.blockers.length === 0, 'Case has unresolved design blockers; publication held', 'blocked-result');
        requireThat(caseSupportingSourceRefs(batch.draft, item, bundle.sources).every(ref => {
          const source = bundle.sources.find(source => source.id === ref.sourceId);
          return source?.approval === 'approved' && source.applicability === 'applicable' && source.access !== 'blocked';
        }), 'Case expectations need approved applicable source evidence before publication', 'blocked-result');
        const fixtureList = item.fixtureIds.map(id => bundle.admission.fixtures.find(file => file.id === id));
        for (const file of fixtureList) fixtureBytes(config, file);
        const existingReceipt = operationRow(ledger, id);
        if (existingReceipt?.state === 'complete') {
          const receipt = completedOperation(ledger, id, 'case-publication');
          const current = await transport.read(receipt.itemId);
          validateItem(current, receipt.fields);
          requireThat(current.rev === receipt.revision, 'Published revision changed; explicit reconciliation required', 'blocked-reconciliation');
          for (const attached of receipt.attachments) {
            const url = attachmentUrl(destination, attached.url);
            requireThat(current.relations?.some(rel => rel.rel === 'AttachedFile' && rel.url === url &&
              rel.attributes?.name === attached.name), 'Required attachment relation was removed', 'blocked-reconciliation');
            const bytes = await transport.download(url);
            requireThat(bytes.length === attached.size && hash(bytes) === attached.sha256,
              'Previously verified attachment bytes changed', 'blocked-reconciliation');
          }
          verification(ledger, id, batchId, { state: 'verified', publicationSha256: hash(json(receipt)) });
          results.push({ ...receipt, replayed: true });
          continue;
        }
        const knownFields = new Set(schema.fields.map(field => field.referenceName));
        requireThat(Object.keys(fields).every(key => knownFields.has(key)) && schema.fields.every(field =>
          !field.alwaysRequired || fields[field.referenceName] !== undefined || ['System.Id', 'System.Rev',
            'System.CreatedBy', 'System.CreatedDate', 'System.ChangedBy', 'System.ChangedDate',
            'System.AreaId', 'System.IterationId'].includes(field.referenceName)),
        'Approved field mapping does not satisfy the current work-item schema', 'blocked-result');
        const mappingId = `case-ado-map-${hash(json([destination.organization, destination.project, bundle.admission.repoId, item.id]))}`;
        const mapped = operationRow(ledger, mappingId);
        const mapping = mapped ? completedOperation(ledger, mappingId, 'case-ado-mapping') : null;
        const candidates = await transport.lookup(item.id);
        requireThat(!mapping || candidates.length === 1 && candidates[0] === mapping.itemId,
          'Mapped item was moved, withdrawn or no longer discoverable', 'blocked-reconciliation');
        let current = candidates.length ? await transport.read(candidates[0]) : null, operation = 'reused';
        const priorMutation = operationRow(ledger, `${id}:create`);
        if (!current) {
          requireThat(!priorMutation, 'Create response was uncertain; no blind duplicate POST', 'blocked-reconciliation');
          await mutate(ledger, `${id}:create`, batchId, fields, async () => {
            publicationPolicy(config, options); approvedCaseBatch(config, ledger, batchId);
            return transport.create(fields);
          });
          current = await transport.read(completedOperation(ledger, `${id}:create`, 'case-publication-mutation').result.id);
          operation = 'created';
        } else if (mapping && mapping.batchId !== batchId && !equal(
          Object.fromEntries(Object.keys(fields).map(key => [key, current.fields?.[key]])), fields)) {
          requireThat(mapping.caseRevision < item.revision && current.rev === mapping.revision &&
            equal(Object.fromEntries(Object.keys(mapping.fields).map(key => [key, current.fields?.[key]])), mapping.fields),
          'User edited or revised the mapped item; review rather than overwrite', 'blocked-reconciliation');
          await mutate(ledger, `${id}:update`, batchId, { itemId: current.id, revision: current.rev, fields }, async () => {
            publicationPolicy(config, options); approvedCaseBatch(config, ledger, batchId);
            return transport.update(current.id, current.rev, fields);
          });
          current = await transport.read(current.id);
          operation = 'updated';
        }
        validateItem(current, fields);
        for (const suffix of ['create', 'update']) {
          const mutation = operationRow(ledger, `${id}:${suffix}`);
          if (mutation && mutation.state !== 'complete') ledger.finishOperation(mutation.id, 'complete', {
            payloadSha256: JSON.parse(mutation.detail).payloadSha256, result: current, reconciledByReadbackAt: now() });
        }
        const attachments = [];
        for (const file of fixtureList) {
          const fileId = `${id}:file:${file.id}:${file.sha256}`;
          let upload;
          const prior = operationRow(ledger, `${fileId}:upload`);
          if (prior?.state === 'complete') upload = completedOperation(ledger, `${fileId}:upload`, 'case-publication-mutation').result;
          else {
            const relations = (current.relations ?? []).filter(rel => rel.rel === 'AttachedFile' && rel.attributes?.name === file.name);
            for (const relation of relations) {
              const url = attachmentUrl(destination, relation.url), bytes = await transport.download(url);
              if (bytes.length === file.size && hash(bytes) === file.sha256) { upload = { url }; break; }
            }
            if (!upload) upload = await mutate(ledger, `${fileId}:upload`, batchId, file, async () => {
              publicationPolicy(config, options); approvedCaseBatch(config, ledger, batchId);
              return transport.upload(file, fixtureBytes(config, file));
            });
          }
          const url = attachmentUrl(destination, upload.url);
          if (!(current.relations ?? []).some(rel => rel.rel === 'AttachedFile' && rel.url === url &&
            rel.attributes?.name === file.name)) {
            await mutate(ledger, `${fileId}:link`, batchId, { itemId: current.id, revision: current.rev, url }, async () => {
              publicationPolicy(config, options); approvedCaseBatch(config, ledger, batchId);
              return transport.link(current.id, current.rev, file, url);
            });
            current = await transport.read(current.id);
          }
          validateItem(current, fields);
          requireThat(current.relations?.some(rel => rel.rel === 'AttachedFile' && rel.url === url &&
            rel.attributes?.name === file.name), 'Attachment upload lacks a verified named relation', 'blocked-result');
          const downloaded = await transport.download(url);
          requireThat(downloaded.length === file.size && hash(downloaded) === file.sha256,
            'Attachment download bytes do not match the manifest', 'blocked-result');
          attachments.push({ fixtureId: file.id, name: file.name, size: file.size, sha256: file.sha256, url,
            attachmentId: new URL(url).pathname.split('/').pop(), itemId: current.id, verifiedAt: now() });
        }
        current = await transport.read(current.id);
        validateItem(current, fields);
        const receipt = { format: 'case-publication-receipt-v1', batchId, caseId: item.id, caseRevision: item.revision,
          itemId: current.id, revision: current.rev,
          url: `https://dev.azure.com/${destination.organization}/${destination.project}/_workitems/edit/${current.id}`,
          fields, attachments, operation, verifiedAt: now(), state: 'published' };
        ledger.transaction(() => {
          if (!operationRow(ledger, id)) ledger.operation(id, batchId, 'case-publication', {});
          ledger.finishOperation(id, 'complete', receipt);
          if (!mapped) ledger.operation(mappingId, batchId, 'case-ado-mapping', {});
          ledger.finishOperation(mappingId, 'complete', receipt);
          verification(ledger, id, batchId, { state: 'verified', publicationSha256: hash(json(receipt)) });
        });
        results.push(receipt);
      } catch (error) {
        verification(ledger, id, batchId, { state: 'blocked', error: safeError(error) });
        const failureId = `${id}:failure:${hash(json(safeError(error)))}`;
        if (!operationRow(ledger, failureId)) {
          ledger.operation(failureId, batchId, 'case-publication-failure', {});
          ledger.finishOperation(failureId, 'complete', { batchId, caseId: item.id, state: 'partial-or-blocked',
            error: safeError(error), observedAt: now() });
        }
        results.push({ caseId: item.id, state: 'partial-or-blocked', error: safeError(error) });
      }
    }
    return { state: results.every(result => result.state === 'published') ? 'published' : 'partial-or-blocked', batchId, results };
  } finally { ledger.release(lock, owner); }
}
