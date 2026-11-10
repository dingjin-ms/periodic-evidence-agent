import { adoAccessToken } from './ado-auth.js';
import { hash, json, now, requireThat } from './common.js';
import { httpsUrl } from './case-generation.js';
import { caseSourceInputs } from './case-source-inventory.js';
export { caseSourceInputs } from './case-source-inventory.js';
const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i;
export function caseDestination(value) {
  const url = httpsUrl(value), parts = url.pathname.split('/').filter(Boolean);
  requireThat(url.hostname === 'dev.azure.com' && parts.length === 5 &&
    parts[2] === '_workitems' && parts[3] === 'create' &&
    /^[A-Za-z0-9._-]+$/.test(parts[0]) && /^[A-Za-z0-9._-]+$/.test(parts[1]) &&
    uuid.test(url.searchParams.get('templateId')) && uuid.test(url.searchParams.get('ownerId')),
  'Configured ADO template URL must identify organization, project, type, template and team', 'blocked-scope');
  return { organization: parts[0], project: parts[1], workItemType: decodeURIComponent(parts[4]),
    templateId: url.searchParams.get('templateId'), teamId: url.searchParams.get('ownerId') };
}
function adoPath(value, destination) {
  const url = httpsUrl(value);
  const parts = url.pathname.split('/').filter(Boolean);
  if (url.hostname === `${destination.organization}.visualstudio.com`) parts.unshift(destination.organization);
  else requireThat(url.hostname === 'dev.azure.com', 'ADO source escaped its configured organization', 'blocked-scope');
  requireThat(parts[0] === destination.organization && parts[1] === destination.project,
    'ADO source escaped its configured project', 'blocked-scope');
  return parts.slice(2);
}
export function hostSourceTask(id, url) {
  const parsed = httpsUrl(url);
  return { sourceId: id, url, state: 'connector-required',
    connector: /(^|\.)sharepoint(?:-df)?\.com$/i.test(parsed.hostname) ? 'workiq' : id === 'figma' ? 'figma' : 'authenticated-host',
    instructions: 'Use an available authenticated host connector scoped to this exact URL. Save the actual tool response, not an invented export. Search hits are partial, not complete source reads. Record inaccessible content explicitly.' };
}
export function caseSourceConnectors(config, inputs, {
  fetchResponse = fetch, getToken = adoAccessToken, environment = process.env, responseJournal, inventory
} = {}) {
  const sources = inventory ?? Object.entries(caseSourceInputs).map(([id, key]) => ({ id, type: id, url: inputs[key] }));
  const sourceFor = id => {
    const source = sources.find(item => item.id === id);
    requireThat(source, 'Unknown configured source', 'blocked-scope');
    return source;
  };
  const destination = caseDestination(inputs.TEST_CASE_TEMPLATE_URL);
  const base = `https://dev.azure.com/${destination.organization}/${destination.project}/`;
  let calls = 0, bytes = 0, token;
  const request = async (url, headers, sourceId) => {
    const journal = typeof responseJournal === 'function' ? responseJournal(sourceId) : responseJournal;
    requireThat(++calls <= 40, 'Case source API call budget exhausted', 'blocked-budget');
    let saved = journal?.read(url);
    if (!saved) {
      journal?.reserve(url);
      const response = await fetchResponse(url, { method: 'GET', redirect: 'error',
        signal: AbortSignal.timeout(60000), headers });
      const chunks = [];
      if (response.ok) for await (const chunk of response.body) {
        bytes += chunk.length;
        requireThat(bytes <= 3 * 1024 * 1024, 'Source responses exceed the aggregate byte limit', 'blocked-budget');
        chunks.push(chunk);
      }
      saved = { status: response.status, body: Buffer.concat(chunks).toString('utf8') };
      journal?.record(url, saved);
    } else {
      bytes += Buffer.byteLength(saved.body);
      requireThat(bytes <= 3 * 1024 * 1024, 'Source responses exceed the aggregate byte limit', 'blocked-budget');
    }
    requireThat(saved.status >= 200 && saved.status < 300, `Source connector returned HTTP ${saved.status}`,
      [401, 403].includes(saved.status) ? 'blocked-auth' : 'blocked-source');
    let value;
    try { value = JSON.parse(saved.body); } catch {}
    requireThat(value && typeof value === 'object', 'Source connector did not return JSON content', 'blocked-source');
    return value;
  };
  const adoRequest = async (path, sourceId) => {
    token ??= getToken(config, 'Configured case-source collection');
    return request(`${base}${path}`, { Authorization: `Bearer ${await token}` }, sourceId);
  };
  const capture = (id, value, itemIds, revision, limitations = 'Captured configured source only; linked sources are not implicitly collected.') =>
    ({ sourceId: id, url: sourceFor(id).url, content: json(value), itemIds,
      revision: revision == null ? null : String(revision), retrievedAt: now(), access: 'complete',
      limitations, provenance: 'controller-http-read', responseSha256: hash(json(value)) });
  return {
    destination,
    async collect(id) {
      const ado = path => adoRequest(path, id);
      const source = sourceFor(id), url = source.url, type = source.type;
      if (type === 'template') {
        const value = await ado(`${destination.teamId}/_apis/wit/templates/${destination.templateId}?api-version=7.1`);
        requireThat(value.id === destination.templateId && value.workItemTypeName === destination.workItemType &&
          value.fields && typeof value.fields['System.AreaPath'] === 'string' && value.fields['System.AreaPath'].trim(),
        'Live template must provide its actual type, defaults and Area Path; ownerId is not Area Path', 'blocked-source');
        return capture(id, value, [], value.revision ?? null);
      }
      if (type === 'sample') {
        const parts = adoPath(url, destination);
        requireThat(parts.length === 3 && parts[0] === '_workitems' && parts[1] === 'edit' &&
          /^[1-9]\d*$/.test(parts[2]), 'Unsupported ADO sample URL', 'blocked-scope');
        const value = await ado(`_apis/wit/workitems/${parts[2]}?$expand=Relations&api-version=7.1`);
        requireThat(value.id === Number(parts[2]) && value.fields?.['System.TeamProject'] === destination.project,
          'ADO sample identity/project mismatch', 'blocked-source');
        return capture(id, value, [], value.rev);
      }
      const parsedSource = httpsUrl(url);
      if (source.qualification?.provider === 'ado' &&
        !parsedSource.pathname.startsWith(`/${destination.organization}/${destination.project}/`)) {
        return { ...hostSourceTask(id, url), qualification: source.qualification };
      }
      if (['bugs', 'requirements'].includes(type) && parsedSource.hostname === 'dev.azure.com' &&
        parsedSource.pathname.startsWith(`/${destination.organization}/${destination.project}/_workitems/edit/`)) {
        const parts = adoPath(url, destination);
        requireThat(parts.length === 3 && /^[1-9]\d*$/.test(parts[2]), 'Unsupported exact ADO work-item URL', 'blocked-scope');
        const value = await ado(`_apis/wit/workitems/${parts[2]}?$expand=Relations&api-version=7.1`);
        requireThat(value.id === Number(parts[2]) && value.fields?.['System.TeamProject'] === destination.project,
          'ADO evidence item identity/project mismatch', 'blocked-source');
        return capture(id, value, [`ado-${value.id}`], value.rev);
      }
      if (type === 'bugs' && /\/_queries\//.test(parsedSource.pathname)) {
        const parts = adoPath(url, destination);
        requireThat(parts.length === 3 && parts[0] === '_queries' && ['query', 'query-edit'].includes(parts[1]) &&
          uuid.test(parts[2]), 'Unsupported saved ADO query URL', 'blocked-scope');
        const query = await ado(`_apis/wit/wiql/${parts[2]}?$top=101&api-version=7.1`);
        const validReference = item => item && Number.isSafeInteger(item.id) && item.id > 0;
        const flat = Array.isArray(query.workItems), linked = Array.isArray(query.workItemRelations);
        requireThat(typeof query.asOf === 'string' &&
          /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(?:\.\d{1,7})?Z$/.test(query.asOf) && Number.isFinite(Date.parse(query.asOf)) &&
          flat !== linked && (flat
            ? (!query.queryType || query.queryType === 'flat') && query.workItems.every(validReference)
            : ['tree', 'oneHop'].includes(query.queryType) && query.workItemRelations.length <= 1000 &&
              query.workItemRelations.every(link => link && (link.source != null || link.target != null) &&
                (link.source == null || validReference(link.source)) &&
                (link.target == null || validReference(link.target)) &&
                (link.rel == null || typeof link.rel === 'string' && link.rel.trim()))),
        'Saved query requires a bounded flat/tree/oneHop result with valid references and an asOf snapshot', 'blocked-source');
        const references = flat ? query.workItems : query.workItemRelations.flatMap(link =>
          [link.source, link.target].filter(item => item != null));
        const returnedIds = references.map(item => item.id);
        const ids = [...new Set(returnedIds)].slice(0, 100);
        const details = ids.length ? await ado(`_apis/wit/workitems?ids=${ids.join(',')}&asOf=${encodeURIComponent(query.asOf)}&api-version=7.1`) : { value: [] };
        requireThat(Array.isArray(details.value) && details.value.length === ids.length &&
          new Set(details.value.map(item => item.id)).size === ids.length &&
          details.value.every(item => ids.includes(item.id) && item.fields?.['System.TeamProject'] === destination.project),
        'ADO query hydration omitted or substituted work items', 'blocked-source');
        return { ...capture(id, { asOf: query.asOf, queryType: query.queryType ?? 'flat', returnedIds,
          ...(linked ? { workItemRelations: query.workItemRelations } : {}), items: details.value },
        ids.map(id => `ado-${id}`), query.asOf),
        access: new Set(returnedIds).size > 100 || (flat ? query.workItems : query.workItemRelations).length > 100 ? 'partial' : 'complete',
        limitations: 'Saved query snapshot only; maximum 100 hydrated unique items. Returned query relations are retained; attachments and links outside the query are not followed.' };
      }
      if (type === 'figma' && environment.FIGMA_ACCESS_TOKEN && !parsedSource.pathname.includes('/branch/')) {
        const parsed = httpsUrl(url), parts = parsed.pathname.split('/').filter(Boolean);
        requireThat(parsed.hostname === 'www.figma.com' && ['design', 'file'].includes(parts[0]) &&
          /^[A-Za-z0-9_-]+$/.test(parts[1]), 'Unsupported configured Figma file URL', 'blocked-scope');
        const node = parsed.searchParams.get('node-id');
        requireThat(node && /^\d+[-:]\d+$/.test(node), 'Figma collection requires the configured exact node', 'blocked-scope');
        const headers = { 'X-Figma-Token': environment.FIGMA_ACCESS_TOKEN };
        const whoami = await request('https://api.figma.com/v1/me', headers, id);
        const designatedUser = config.identity?.designatedUser;
        requireThat(typeof whoami.email === 'string' && whoami.email.trim() &&
          typeof designatedUser === 'string' && designatedUser.trim() &&
          whoami.email.trim().toLowerCase() === designatedUser.trim().toLowerCase(),
        'Executing Figma REST identity must match the designated account', 'blocked-auth');
        const value = await request(`https://api.figma.com/v1/files/${parts[1]}/nodes?ids=${encodeURIComponent(node.replace('-', ':'))}`,
          headers, id);
        requireThat(value.nodes?.[node.replace('-', ':')]?.document, 'Figma response omitted the requested node', 'blocked-source');
        return { ...capture(id, { ...value, whoami }, [`node-${node.replace(':', '-')}`], value.version ?? null),
          access: 'partial', limitations: 'Configured Figma subtree only; comments, other nodes and linked documents are not collected.' };
      }
      return { ...hostSourceTask(id, url), ...(type === 'repository' ? { connector: 'repository' } : {}),
        ...(type === 'figma' ? { connector: 'figma' } : {}), qualification: source.qualification ?? null };
    }
  };
}
