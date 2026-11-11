import { requireThat, validateRecord } from './common.js';

export const caseSourceInputs = {
  checklist: 'CHECKLIST_URL', bugs: 'BUG_LIST_URL', template: 'TEST_CASE_TEMPLATE_URL',
  sample: 'TEST_CASE_SAMPLE_URL', figma: 'FIGMA_URL'
};
export const discoverySurfaces = ['Bizchat', 'GHCP', 'CPNB', 'Code'];
export function sourceHttpsUrl(value) {
  let url;
  try { url = new URL(value); } catch {}
  requireThat(url?.protocol === 'https:' && !url.username && !url.password &&
    !/\\|%2f|%5c|%2e/i.test(url.pathname) &&
    ![...url.searchParams.keys()].some(key => /token|secret|password|signature|^sig$|^code$/i.test(key)),
  'Sources must use credential-free absolute HTTPS URLs', 'blocked-scope');
  return url;
}
export function canonicalSourceUrl(value) {
  const url = sourceHttpsUrl(value);
  const legacyAdo = /^([a-z0-9-]+)\.visualstudio\.com$/i.exec(url.hostname);
  if (legacyAdo) {
    url.hostname = 'dev.azure.com';
    url.pathname = `/${legacyAdo[1]}${url.pathname}`;
  }
  if (url.hostname === 'www.figma.com' && /^\/(?:design|file)\//.test(url.pathname)) {
    const parts = url.pathname.split('/').filter(Boolean);
    url.pathname = `/design/${parts[1]}${parts[2] === 'branch' ? `/branch/${parts[3]}` : ''}`;
    for (const key of ['p', 'f', 'm']) url.searchParams.delete(key);
    const node = url.searchParams.get('node-id');
    if (node) url.searchParams.set('node-id', node.replace(':', '-'));
  }
  url.hash = '';
  url.searchParams.sort();
  return url;
}
export function caseSourceInventory(configuration) {
  const inputs = configuration.inputs;
  if (!configuration.discovery) {
    requireThat(configuration.sources === undefined, 'A selected source catalog requires discovery lineage', 'blocked-reconciliation');
    return Object.entries(caseSourceInputs).map(([id, key]) => {
      sourceHttpsUrl(inputs?.[key]);
      return { id, type: id, url: inputs[key], surfaces: [] };
    });
  }
  validateRecord(configuration.discovery, 'caseDiscoveryConfig');
  validateRecord(configuration.sources, 'caseDiscoverySources');
  const fixed = ['template', 'sample'].map(id => {
    sourceHttpsUrl(inputs?.[caseSourceInputs[id]]);
    return { id, type: id, url: inputs[caseSourceInputs[id]], surfaces: [] };
  });
  const sources = configuration.sources.map(source => {
    sourceHttpsUrl(source.url);
    return structuredClone(source);
  });
  requireThat(new Set(sources.map(source => source.id)).size === sources.length &&
    new Set(sources.map(source => canonicalSourceUrl(source.url).href)).size === sources.length,
  'Selected sources require unique stable IDs and URLs', 'invalid-record');
  return [...fixed, ...sources];
}
export function urlWithinScope(value, prefixes) {
  const url = canonicalSourceUrl(value);
  return prefixes.some(prefix => {
    const root = canonicalSourceUrl(prefix);
    return root.origin === url.origin && (url.pathname === root.pathname ||
      url.pathname.startsWith(root.pathname.endsWith('/') ? root.pathname : `${root.pathname}/`)) &&
      [...root.searchParams].every(([key, item]) => url.searchParams.get(key) === item);
  });
}
