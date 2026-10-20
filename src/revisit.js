import { Budget, json, now, requireThat, safeError } from './common.js';
import { readRelatedAdo, evidenceEnvelope, workiqTitle } from './sources.js';
import { withWorkiq, principalPath, verifyPrincipal, channelRoot, messageSelect } from './runtime.js';

export function trackedOpenEvidence(ledger) {
  const ids = new Set(ledger.latest('investigation').filter(i => i.state !== 'closed').flatMap(i => i.evidenceIds));
  const keys = new Set([...ids].map(id => {
    const e = ledger.get('evidence', id);
    requireThat(e, 'Tracked investigation has missing evidence');
    return json([e.source.namespace, e.source.recordId]);
  }));
  return ledger.latestEvidence().filter(e => keys.has(json([e.source.namespace, e.source.recordId])));
}
export async function revisitTracked(config, ledger, readers = {}) {
  requireThat(config.schedule.changedEvidencePolicy === 'tracked-open-and-area-changed',
    'Tracked revisits require the approved changed-evidence policy');
  const results = [];
  for (const kind of ['ado', 'workiq', 'icm']) {
    const tracked = trackedOpenEvidence(ledger).filter(e => e.source.kind === kind);
    if (!tracked.length) continue;
    const sourceKey = `${kind}:revisit`;
    const blocked = ledger.sourceBlock(`auth:${kind}`) ?? ledger.sourceBlock(sourceKey);
    if (blocked) { results.push({ source: sourceKey, state: 'blocked', error: blocked }); continue; }
    const window = { start: config.window.start, end: now() }, runId = ledger.startRun(sourceKey, window);
    const budget = new Budget(config.limits);
    try {
      requireThat(config.sources[kind].enabled && config.sources[kind].scopeApproved, 'Tracked source is not approved/enabled');
      const process = async (old, read) => {
        budget.item();
        try {
          let update;
          if (kind === 'ado') update = await (readers.ado ?? readRelatedAdo)(config, old.source.recordId, budget);
          else if (kind === 'workiq') {
            const seed = config.sources.workiq.seeds.find(s => old.scopeId === `workiq:${s.id}`);
            requireThat(seed?.kind === 'teams-channel', 'Tracked WorkIQ resource is no longer in an approved channel', 'blocked-scope');
            const parent = /\/thread\/([^/]+)$/.exec(old.source.namespace)?.[1] ?? old.source.recordId;
            requireThat(/^[\w-]+$/.test(parent) && /^[\w-]+$/.test(old.source.recordId), 'Invalid tracked message identity', 'blocked-scope');
            const path = `${channelRoot(seed)}/${encodeURIComponent(parent)}${parent === old.source.recordId ? '' : `/replies/${encodeURIComponent(old.source.recordId)}`}?$select=${messageSelect}`;
            budget.call(); const message = await read(path);
            requireThat(message.id === old.source.recordId, 'Tracked message identity mismatch', 'blocked-scope');
            if (message.channelIdentity) requireThat(message.channelIdentity.teamId === seed.teamId &&
              message.channelIdentity.channelId === seed.channelId, 'Tracked message outside approved channel', 'blocked-scope');
            const record = evidenceEnvelope('workiq', old.source.namespace, message.id, message.etag ?? null,
              message.webUrl ?? old.url, json({ entityUrls: [path], purpose: 'tracked-open-revisit' }));
            record.scopeId = old.scopeId; record.createdAt = message.createdDateTime ?? null;
            record.title = workiqTitle(message.subject); record.sourceStatus = message.deletedDateTime ? 'Removed' : null;
            record.fields = { message }; update = { record, payload: { message } };
          } else {
            requireThat(false, 'Authenticated tracked IcM revisits are unavailable; obtain an updated confirmed owner export', 'blocked-source');
          }
          ledger.evidence(update.record, update.payload, runId);
          const fixed = ['Removed', 'Resolved', 'Closed'].includes(update.record.sourceStatus);
          ledger.setTrackedState(old, fixed ? 'reconciliation-required' : 'current',
            fixed ? 'Tracked item is removed/fixed/closed; review existing fix and assignment before further work'
              : 'Tracked identity still appears in the approved source boundary; current evidence captured');
        } catch (error) {
          if (['blocked-scope', 'unavailable'].includes(error.code)) {
            ledger.setTrackedState(old, 'reconciliation-required',
              'Tracked identity absent from approved scope or unavailable (possibly moved/removed). No out-of-scope details fetched; explicit reconciliation required.');
            return;
          }
          throw error;
        }
      };
      if (kind === 'workiq') {
        const body = async read => {
          budget.call(); verifyPrincipal(config, await read(principalPath));
          for (const old of tracked) await process(old, read);
        };
        if (readers.workiq) await body(readers.workiq);
        else await withWorkiq(config, body);
      } else for (const old of tracked) await process(old);
      ledger.finishRun(runId, 'complete');
      results.push({ source: sourceKey, runId, state: 'complete', itemsRevisited: tracked.length });
    } catch (error) {
      const detail = safeError(error);
      const state = detail.code === 'partial' ? 'partial' : detail.code === 'blocked-auth' ? 'blocked-auth' : 'blocked';
      ledger.finishRun(runId, state, detail);
      if (state !== 'partial') ledger.blockSource(sourceKey, { ...detail, owner: config.identity.designatedUser });
      if (detail.code === 'blocked-auth')
        ledger.blockSource(`auth:${kind}`, { ...detail, owner: config.identity.designatedUser });
      results.push({ source: sourceKey, runId, state, error: detail });
    }
  }
  return results;
}
