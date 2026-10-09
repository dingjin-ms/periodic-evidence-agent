import { join } from 'node:path';
import { writeFileSync } from 'node:fs';
import { Ledger } from './ledger.js';
import { uuid, collectionPreflight, safeError, json, now, requireThat } from './common.js';
import { collect, report } from './coordinator.js';
import { followRelated } from './followup.js';

export async function dryRun(input, { collectRequested = false, authRefreshed = false, adapters = {}, readers = {} } = {}) {
  const config = structuredClone(input);
  requireThat(config.dryRun?.collectionOnly === true, 'Explicit collection-only dry-run settings are required');
  requireThat(json(config.dryRun.window) === json(config.window), 'Dry-run limits are approved only for the configured initial window');
  requireThat(json(config.dryRun.passes) === json(['ado:created', 'ado:changed', 'workiq:created']),
    'Dry-run limits are approved only for the three configured source passes');
  config.limits = { ...config.limits, ...config.dryRun.limits };
  const id = uuid();
  config.stateDirectory = join(input.stateDirectory, 'dry-runs', id);
  config.activation = { collect: true, review: false, dispatch: false };
  config.schedule.enabled = false;
  const ledger = new Ledger(config.stateDirectory);
  const summary = {
    dryRunId: id, startedAt: now(), stateDirectory: config.stateDirectory,
    window: config.window, phase: 'preflight', state: 'blocked', collection: [],
    classification: 'Not performed; no model execution is enabled for dry runs',
    proposedRoutes: [], workerDispatches: 0, externalWrites: 0, scheduleEnabled: false,
    productionLedgerTouched: false, authPrincipal: 'Must be verified by each adapter; configuration metadata is not proof'
  };
  summary.collectionLimits = { ...config.dryRun.limits, appliesTo: config.dryRun.passes, recurringDefault: false };
  summary.followUpLimits = config.followUp;
  try {
    try { collectionPreflight(config); }
    catch (error) {
      summary.error = safeError(error);
      summary.missingNumericSettings = ['maxItems', 'maxCalls'].filter(k => !Number.isInteger(config.limits[k]) || config.limits[k] < 1);
      return summary;
    }
    if (!collectRequested || !authRefreshed) {
      summary.error = { code: 'awaiting-auth-refresh',
        message: 'No source reads attempted. Complete supported WorkIQ and Azure CLI sign-in, then explicitly run dry-run --collect --auth-refreshed. No automatic retry.' };
      return summary;
    }
    summary.phase = 'collection';
    summary.collection = await collect(config, ledger, { adapters, follow: false });
    if (config.schedule.changedEvidencePolicy === 'tracked-open-and-area-changed')
      summary.collection.push(...await collect(config, ledger, { adapters, lane: 'changed', onlySources: ['ado'], follow: false }));
    const roots = ledger.evidenceForRuns(summary.collection.filter(r => r.runId).map(r => r.runId));
    if (roots.length && config.followUp.maxDepth > 0)
      summary.collection.push({ source: 'followup', ...await followRelated(config, ledger, roots, config.window, readers) });
    const output = report(ledger);
    summary.report = output;
    summary.state = summary.collection.every(r => r.state === 'complete') ? 'complete' : 'partial-or-blocked';
    summary.proposedRoutes = output.issues.map(i => ({ evidenceId: i.evidenceId, repoId: null,
      reason: 'No model classification or ownership decision in read-only dry run' }));
    return summary;
  } catch (error) {
    summary.error = safeError(error);
    return summary;
  } finally {
    summary.finishedAt = now();
    writeFileSync(join(config.stateDirectory, 'summary.json'), json(summary), { mode: 0o600 });
    ledger.close();
  }
}
