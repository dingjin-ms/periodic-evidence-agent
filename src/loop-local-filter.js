import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { hash, requireThat } from './common.js';
import { loadFilterCorpus } from './filter.js';
import { prepareFilterBatches } from './filter-batches.js';
import { readLoopArtifact } from './loop-controller.js';

const bytes = value => JSON.stringify(value, null, 2) + '\n';
const sha = value => hash(bytes(value));

// A deterministic membership partition, not semantic review. FILTER still makes
// every decision from the complete source-bound payload through restricted tools.
export async function prepareLoopLocalFilter(settings, request, ledger, counter) {
  const plan = settings.bundle.localFilterPlan;
  requireThat(plan?.instructions && plan.groupingReview && plan.sharing?.audience && plan.sharing.approvalRef &&
    plan.authorization && plan.routing, 'Local FILTER needs explicit grouping/sharing/release policy');
  const handoffPath = join(settings.root, 'handoff.json');
  if (existsSync(handoffPath)) return;
  const collected = JSON.parse(readLoopArtifact(ledger, request.upstream[0].artifacts[0]));
  const instructions = plan.instructions + (collected.sourceCoverageComplete === false
    ? '\nSource coverage is incomplete. Review only the supplied complete source cohorts. Missing sources: ' +
      JSON.stringify(collected.missingSources) + '. Do not infer absence of findings in excluded sources.' : '');
  const corpus = loadFilterCorpus(settings.proposer, { format: 'stage2-sources-v1', sources: collected.snapshot.sources });
  const manifestPath = join(settings.root, 'filter-manifest.json');
  const materials = [...new Set([...corpus.evidence.map(sha), ...corpus.captures.map(c => c.sha256),
      ...corpus.contexts.map(c => c.sha256), hash(instructions),
      sha(corpus.coverage.map(({ runId, coverage }) => ({ runId, coverage })))])];
  const batchRequest = { format: 'filter-batch-request-v1',
      sources: collected.snapshot.sources, instructions,
      groups: requiredSourceGroups(corpus.evidence),
      groupingReview: plan.groupingReview,
      sharing: { ...plan.sharing, materials: materials.map(sha256 =>
        ({ sha256, eligibility: 'approved', restrictions: ['Approved bounded FILTER review only'] })) }
    };
  if (!existsSync(manifestPath)) await prepareFilterBatches(settings.proposer, batchRequest, manifestPath, counter);
  const manifest = JSON.parse(readFileSync(manifestPath));
  requireThat(sha(manifest.request) === sha(batchRequest), 'Local FILTER preparation request changed', 'blocked-reconciliation');
  const handoff = { format: 'one-shot-handoff-v1', owner: request.pins.stateOwner.id,
    collection: { stateDirectory: settings.collector.stateDirectory, runId: settings.collectionRunId ?? request.runId,
      receiptSha256: settings.collectionReceiptSha256 },
    filter: { manifestPath, manifestSha256: hash(readFileSync(manifestPath)),
      executionLedgerPath: join(settings.root, 'filter-execution', 'ledger.sqlite'),
      resultPaths: manifest.batches.map((_batch, index) => join(settings.root, 'filter-result-' + index + '.json')) },
    routing: plan.routing, authorization: plan.authorization };
  writeFileSync(handoffPath, bytes(handoff), { flag: 'wx', mode: 0o600 });
}

export function requiredSourceGroups(records) {
  const parent = new Map(records.map(record => [record.id, record.id]));
  const find = id => parent.get(id) === id ? id : find(parent.get(id));
  const union = (a, b) => parent.set(find(a), find(b));
  const keys = new Map(), urls = new Map();
  for (const record of records) {
    const source = record.source, t = record.fields?.thread;
    for (const key of [JSON.stringify([source.kind, source.namespace, source.recordId]),
      ...(t ? [JSON.stringify(['thread', t.teamId, t.channelId, t.rootId])] : [])]) {
      if (keys.has(key)) union(record.id, keys.get(key));
      else keys.set(key, record.id);
    }
    urls.set(record.url, [...(urls.get(record.url) ?? []), record.id]);
  }
  for (const record of records) for (const link of record.links ?? [])
    for (const other of urls.get(link.url) ?? []) union(record.id, other);
  const groups = new Map();
  for (const record of records) { const key = find(record.id); groups.set(key, [...(groups.get(key) ?? []), record.id]); }
  return [...groups.values()].map(ids => ids.sort()).map(memberIds => ({
    id: 'related-' + hash(JSON.stringify(memberIds)).slice(0, 24), memberIds, contextIds: [],
    reason: 'Required source-version, thread and explicit-link closure; no semantic grouping asserted'
  })).sort((a, b) => a.id.localeCompare(b.id));
}
