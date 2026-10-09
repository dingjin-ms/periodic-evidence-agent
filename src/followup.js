import { Budget, json, requireThat, safeError, utc } from './common.js';
import { readRelatedAdo, evidenceEnvelope } from './sources.js';
import { withWorkiq, principalPath, verifyPrincipal, channelRoot, messageSelect } from './runtime.js';

export function explicitLinks(record) {
  const urls = new Set(record.links.map(link => link.url));
  function visit(value) {
    if (typeof value === 'string') {
      for (const match of value.matchAll(/https:\/\/[^\s<>"']+/g)) urls.add(match[0].replaceAll('&amp;', '&'));
    } else if (Array.isArray(value)) value.forEach(visit);
    else if (value && typeof value === 'object') Object.values(value).forEach(visit);
  }
  visit(record.fields);
  urls.delete(record.url);
  return [...urls];
}
export function relatedTarget(config, text) {
  let url;
  try { url = new URL(text); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password) return null;
  const ado = /^\/office\/OC\/(?:_workitems\/edit|_apis\/wit\/workItems)\/(\d+)$/i.exec(url.pathname);
  if (url.origin === 'https://dev.azure.com' && ado && config.sources.ado.enabled && config.sources.ado.scopeApproved)
    return { kind: 'ado', id: ado[1], key: `ado:${ado[1]}` };
  if (url.origin === 'https://teams.microsoft.com') {
    const parts = url.pathname.split('/');
    if (parts.length !== 5 || parts[1] !== 'l' || parts[2] !== 'message') return null;
    let channel, id;
    try { channel = decodeURIComponent(parts[3]); id = decodeURIComponent(parts[4]); } catch { return null; }
    const seed = config.sources.workiq.seeds.find(s => s.kind === 'teams-channel' &&
      s.channelId === channel && s.teamId === url.searchParams.get('groupId'));
    if (!seed || !config.sources.workiq.enabled || !config.sources.workiq.scopeApproved || !/^[\w-]+$/.test(id)) return null;
    const parent = url.searchParams.get('parentMessageId') ?? id;
    if (!/^[\w-]+$/.test(parent)) return null;
    const path = `${channelRoot(seed)}/${encodeURIComponent(parent)}${parent === id ? '' : `/replies/${encodeURIComponent(id)}`}?$select=${messageSelect}`;
    return { kind: 'workiq', id, parent: parent === id ? null : parent, seed, path, key: path };
  }
  return null;
}
export async function readRelatedWorkiq(config, target, budget) {
  return withWorkiq(config, async read => {
    budget.call(); verifyPrincipal(config, await read(principalPath));
    budget.call(); const message = await read(target.path);
    requireThat(message.id === target.id, 'Related Teams message identity mismatch', 'blocked-scope');
    utc(message.createdDateTime);
    if (message.channelIdentity) requireThat(message.channelIdentity.teamId === target.seed.teamId &&
      message.channelIdentity.channelId === target.seed.channelId, 'Related message outside approved channel', 'blocked-scope');
    const record = evidenceEnvelope('workiq',
      `workiq/${target.seed.teamId}/${target.seed.channelId}${target.parent ? `/thread/${target.parent}` : ''}`,
      message.id, message.etag ?? null, message.webUrl ?? target.seed.url, json({ entityUrls: [target.path] }));
    record.scopeId = `workiq:${target.seed.id}`; record.createdAt = message.createdDateTime;
    record.fields = { message }; record.title = message.subject ?? null;
    return { record, payload: { message } };
  });
}
export async function followRelated(config, ledger, roots, window, readers = {}) {
  if (config.followUp.maxDepth === 0) return { state: 'disabled', reason: 'Follow-up disabled' };
  requireThat(config.followUp.maxDepth === 1, 'Only the approved one-level follow-up is supported');
  const budget = new Budget({ maxItems: config.followUp.maxItems, maxCalls: config.followUp.maxToolCalls });
  const runId = ledger.startRun('followup', window), visited = new Map(), attempted = new Set();
  let pending = false;
  try {
    for (const root of roots) {
      for (const url of explicitLinks(root)) {
        const target = relatedTarget(config, url);
        if (!target) {
          ledger.discovery(runId, root.id, url, 'not-followed', 'Outside approved source boundaries or no supported read adapter');
          continue;
        }
        if (visited.has(target.key)) {
          ledger.discovery(runId, root.id, url, 'retrieved', 'Reused this run; no duplicate follow-up call', visited.get(target.key));
          continue;
        }
        if (attempted.has(target.key)) {
          ledger.discovery(runId, root.id, url, 'blocked', 'Related target already attempted; no blind duplicate read');
          continue;
        }
        if (budget.items <= 0 || budget.calls < 2) {
          pending = true;
          ledger.discovery(runId, root.id, url, 'pending', 'Approved follow-up item/tool budget exhausted; not retrieved');
          continue;
        }
        const blockKey = `followup:${target.kind}`;
        if (ledger.sourceBlock(`auth:${target.kind}`) || ledger.sourceBlock(blockKey)) {
          pending = true; ledger.discovery(runId, root.id, url, 'blocked', 'Resolve recorded source blocker before related retrieval'); continue;
        }
        try {
          attempted.add(target.key);
          budget.item();
          const { record, payload } = target.kind === 'ado'
            ? await (readers.ado ?? readRelatedAdo)(config, target.id, budget)
            : await (readers.workiq ?? readRelatedWorkiq)(config, target, budget);
          record.discoveredFrom = root.id;
          record.discoveryReason = 'Explicit one-level relationship within approved source boundary';
          const stored = ledger.evidence(record, payload, runId);
          visited.set(target.key, stored.id);
          ledger.discovery(runId, root.id, url, 'retrieved', 'One-level related evidence; not a new cohort candidate', stored.id);
        } catch (error) {
          const detail = safeError(error);
          const outside = detail.code === 'blocked-scope';
          pending ||= !outside;
          ledger.discovery(runId, root.id, url, outside ? 'not-followed' : 'blocked', detail.message);
          if (['blocked-auth', 'blocked-runtime', 'blocked-protocol'].includes(detail.code))
            ledger.blockSource(blockKey, { ...detail, owner: config.identity.designatedUser });
          if (detail.code === 'blocked-auth')
            ledger.blockSource(`auth:${target.kind}`, { ...detail, owner: config.identity.designatedUser });
        }
      }
    }
    ledger.finishRun(runId, pending ? 'partial' : 'complete', pending ? { code: 'pending-related-evidence', message: 'See discovery audit; no missing links were treated as retrieved' } : null);
    return { runId, state: pending ? 'partial' : 'complete', additionalItems: visited.size };
  } catch (error) {
    ledger.finishRun(runId, 'blocked', safeError(error));
    throw error;
  }
}
