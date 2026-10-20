import { DatabaseSync } from 'node:sqlite';
import { existsSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { exclusions, hash, json, readJson, requireThat, utc, validateRecord } from './common.js';
import { adoResolutionField, requireAdoEvidenceCohort } from './ado-cohort.js';

const text = value => typeof value === 'string' && value.trim().length > 0;
function immutable(path, value) {
  const bytes = `${JSON.stringify(value, null, 2)}\n`;
  if (existsSync(path)) requireThat(readFileSync(path, 'utf8') === bytes,
    'Filter output exists with different content', 'invalid-record');
  else writeFileSync(path, bytes, { flag: 'wx', mode: 0o600 });
  return { path: resolve(path), sha256: hash(readFileSync(path)) };
}
function sourceRead(source, retained = null, expected = null) {
  requireThat(text(source?.ledgerPath) && text(source.runId) && existsSync(source.ledgerPath),
    'Filter source requires an existing ledgerPath and runId', 'invalid-record');
  const ledgerPath = realpathSync(source.ledgerPath);
  const db = new DatabaseSync(ledgerPath, { readOnly: true });
  try {
    db.exec('BEGIN');
    const run = db.prepare('SELECT body FROM app_runs WHERE id=?').get(source.runId);
    requireThat(run, 'Filter source run missing', 'invalid-record');
    const passes = db.prepare('SELECT pass,body FROM app_passes WHERE run_id=? ORDER BY pass').all(source.runId);
    // Project title/identity/provenance and cohort selectors, never description/RCA/capture bodies.
    const entries = db.prepare(`SELECT DISTINCT r.id AS evidenceId,
      json_extract(r.body,'$.title') AS title, json_extract(r.body,'$.source') AS source,
      json_extract(r.body,'$.capture') AS capture,
      json_extract(r.body,'$.sourceStatus') AS sourceStatus,
      json_extract(r.body,'$.fields."System.State"') AS state,
      json_extract(r.body,'$.fields."${adoResolutionField}"') AS resolution
      FROM records r JOIN observations o ON o.evidence_id=r.id
      WHERE r.kind='evidence' AND substr(o.run_id,1,length(?)+1)=?||':' ORDER BY r.id`)
      .all(source.runId, source.runId).map(row => {
        const origin = JSON.parse(row.source), capture = JSON.parse(row.capture);
        requireAdoEvidenceCohort({ source: origin, sourceStatus: row.sourceStatus,
          fields: { 'System.State': row.state, [adoResolutionField]: row.resolution } });
        requireThat((row.title === null || typeof row.title === 'string') &&
          /^[a-f0-9]{64}$/.test(capture.sha256 ?? ''),
        'Title index requires a valid title and captured source version', 'invalid-record');
        return { evidenceId: row.evidenceId, title: row.title,
          source: Object.fromEntries(['kind', 'namespace', 'recordId', 'revision', 'versionBasis'].map(k => [k, origin[k]])),
          provenance: origin.provenance, captureSha256: capture.sha256, artifactRef: capture.artifactRef,
          ...(origin.kind === 'ado' ? { cohort: { state: row.state,
            resolutionField: adoResolutionField, resolution: row.resolution } } : {}) };
      });
    const snapshotSha256 = hash(json([run.body, passes, entries]));
    if (expected) requireThat(snapshotSha256 === expected,
      'Filter source changed since title index preparation', 'blocked-reconciliation');
    const evidence = [], captures = new Map();
    if (retained) for (const entry of entries.filter(e => retained.has(e.evidenceId))) {
      const row = db.prepare("SELECT body FROM records WHERE kind='evidence' AND id=?").get(entry.evidenceId);
      const record = JSON.parse(row.body);
      validateRecord(record);
      requireAdoEvidenceCohort(record);
      const capture = db.prepare('SELECT body FROM captures WHERE hash=?').get(entry.captureSha256);
      requireThat(capture && hash(capture.body) === entry.captureSha256 &&
        record.capture.sha256 === entry.captureSha256,
      'Retained filter evidence capture missing or corrupt', 'invalid-record');
      evidence.push(record);
      captures.set(entry.captureSha256, { sha256: entry.captureSha256, artifactRef: entry.artifactRef,
        contentBase64: Buffer.from(capture.body).toString('base64') });
    }
    const threads = new Set(evidence.filter(e => e.fields?.thread).map(e => {
      const t = e.fields.thread;
      return json([t.teamId, t.channelId, t.rootId]);
    }));
    const contexts = retained && threads.size ? db.prepare(
      'SELECT body FROM app_thread_context WHERE run_id=? ORDER BY pass,id').all(source.runId)
      .map(row => JSON.parse(row.body)).filter(c => threads.has(json([c.teamId, c.channelId, c.rootId]))) : [];
    return { ledgerPath, runId: source.runId, window: JSON.parse(run.body).window, snapshotSha256,
      coverage: passes.map(p => JSON.parse(p.body)), entries, evidence, contexts, captures: [...captures.values()] };
  } finally { db.close(); }
}
function buildIndex(config, input) {
  requireThat(config.statePolicy.accessApproved, 'Private filter storage approval required');
  requireThat(input?.format === 'stage2-sources-v1' && Array.isArray(input.sources) && input.sources.length > 0,
    'Filter requires an explicit source-ledger manifest', 'invalid-record');
  const sources = input.sources.map(source => sourceRead(source));
  requireThat(new Set(sources.map(s => json([s.ledgerPath, s.runId]))).size === sources.length,
    'Duplicate filter source run', 'invalid-record');
  const entries = new Map();
  for (const source of sources) for (const entry of source.entries) {
    requireThat(!entries.has(entry.evidenceId) || json(entries.get(entry.evidenceId)) === json(entry),
      'Conflicting filter evidence identity across sources', 'invalid-record');
    entries.set(entry.evidenceId, entry);
  }
  return { format: 'filter-title-index-v1', stage: 'filter', dispatchAllowed: false,
    sources: sources.map(({ ledgerPath, runId, window, snapshotSha256 }) => ({ ledgerPath, runId, window, snapshotSha256 })),
    policy: { exclusions, dispositions: ['likely-relevant', 'needs-details', 'no-title', 'screen-out'],
      rules: [
        'Agent 2 FILTER loosely reviews every title before detailed reasoning; full-record inputs need no deferred retrieval.',
        'Screen out only confidently excluded titles with a typed exclusion, reason and exact title quote.',
        'Ambiguous and absent titles retain details. Never infer a defect or missing test from a title.',
        'No broad keyword rejection, including reliability, security, performance or Voice Access.',
        'ADO inputs require Resolved or Closed with Microsoft.VSTS.Common.ResolvedReason Fixed or Duplicate; no System.Reason fallback.',
        'Duplicate resolution is not an exclusion. Preserve source identities and canonical links even when the target is outside scope; do not fetch it.',
        'A validated decision is not semantic qualification. Retained bodies must be read before RCA/coverage.',
        'Apply all exclusions to both defect and improvement handoffs; later source/coverage gates are unchanged.'
      ] },
    entries: [...entries.values()].sort((a, b) => a.evidenceId.localeCompare(b.evidenceId)) };
}
export function prepareTitleIndex(config, input, outputPath) {
  const index = buildIndex(config, input);
  return { state: 'awaiting-filter-title-decisions', ...immutable(outputPath, index), count: index.entries.length };
}
export function loadFilterCorpus(config, input) {
  const index = buildIndex(config, input), ids = new Set(index.entries.map(e => e.evidenceId));
  const sources = index.sources.map(source => sourceRead(source, ids, source.snapshotSha256));
  const evidence = new Map(), captures = new Map(), contexts = new Map();
  for (const source of sources) {
    for (const record of source.evidence) {
      requireThat(!evidence.has(record.id) || json(evidence.get(record.id)) === json(record),
        'Conflicting full evidence across filter sources', 'blocked-reconciliation');
      evidence.set(record.id, record);
    }
    for (const capture of source.captures) captures.set(capture.sha256, capture);
    for (const context of source.contexts) contexts.set(hash(json(context)), context);
  }
  return { index, evidence: [...evidence.values()].sort((a, b) => a.id.localeCompare(b.id)),
    captures: [...captures.values()].sort((a, b) => a.sha256.localeCompare(b.sha256)),
    contexts: [...contexts].sort(([a], [b]) => a.localeCompare(b)).map(([sha256, content]) => ({ sha256, content })),
    coverage: sources.map(s => ({ ledgerPath: s.ledgerPath, runId: s.runId, coverage: s.coverage })) };
}
export function validateTitleDecisions(index, decisions, indexSha256) {
  validateRecord(decisions, 'filterTitleDecisions');
  utc(decisions.reviewedAt);
  requireThat(text(decisions.reviewer) && decisions.indexSha256 === indexSha256,
    'Title decisions require matching index and reviewer', 'invalid-record');
  const entries = new Map(index.entries.map(e => [e.evidenceId, e])), seen = new Set();
  for (const decision of decisions.decisions) {
    const entry = entries.get(decision.evidenceId);
    requireThat(entry && !seen.has(decision.evidenceId), 'Unknown or duplicate title decision ID', 'invalid-record');
    seen.add(decision.evidenceId);
    requireThat(Object.keys(entry.source).every(k => decision.source[k] === entry.source[k]) &&
      decision.captureSha256 === entry.captureSha256,
    'Title decision source identity/version mismatch', 'blocked-reconciliation');
    requireThat(text(decision.reason), 'Title decision requires a reason', 'invalid-record');
    if (!text(entry.title)) requireThat(decision.disposition === 'no-title',
      'Absent or blank titles must retain details as no-title', 'invalid-record');
    else requireThat(decision.disposition !== 'no-title', 'Present title cannot be classified no-title', 'invalid-record');
    if (decision.disposition === 'screen-out') requireThat(exclusions.includes(decision.exclusionType) &&
      text(decision.titleQuote) && entry.title.includes(decision.titleQuote),
    'Title exclusion requires an existing typed reason and exact title quote', 'invalid-record');
    else requireThat(decision.exclusionType === null && decision.titleQuote === null,
      'Retained decisions cannot assert title exclusions', 'invalid-record');
  }
  requireThat(seen.size === entries.size, 'Missing title decisions; all evidence IDs must be screened', 'invalid-record');
}
export function validateTitleScreen(config, indexPath, decisionsPath) {
  const index = readJson(indexPath), decisions = readJson(decisionsPath);
  validateRecord(decisions, 'filterTitleDecisions');
  utc(decisions.reviewedAt);
  requireThat(text(decisions.reviewer), 'Title decisions require an identified reviewer', 'invalid-record');
  requireThat(index.format === 'filter-title-index-v1' &&
    decisions.indexSha256 === hash(readFileSync(indexPath)),
  'Title decisions do not match the exact index bytes', 'invalid-record');
  const current = buildIndex(config, { format: 'stage2-sources-v1', sources: index.sources });
  requireThat(json(current) === json(index), 'Title index or source version changed', 'blocked-reconciliation');
  validateTitleDecisions(index, decisions, decisions.indexSha256);
  return { index, decisions, indexSha256: decisions.indexSha256, decisionsSha256: hash(readFileSync(decisionsPath)),
    retainedIds: decisions.decisions.filter(d => d.disposition !== 'screen-out').map(d => d.evidenceId) };
}
export function materializeTitleScreen(config, indexPath, decisionsPath, outputPath) {
  // Validate the entire decision set before reading even one full retained record.
  const screen = validateTitleScreen(config, indexPath, decisionsPath), retained = new Set(screen.retainedIds);
  const evidence = new Map(), captures = new Map();
  for (const source of screen.index.sources) {
    const current = sourceRead(source, retained, source.snapshotSha256);
    for (const record of current.evidence) {
      requireThat(!evidence.has(record.id) || json(evidence.get(record.id)) === json(record),
        'Retained evidence differs across source ledgers', 'invalid-record');
      evidence.set(record.id, record);
    }
    for (const capture of current.captures) captures.set(capture.sha256, capture);
  }
  const entries = new Map(screen.index.entries.map(e => [e.evidenceId, e]));
  const output = { format: 'filter-details-v1', stage: 'filter', dispatchAllowed: false,
    indexSha256: screen.indexSha256, decisionsSha256: screen.decisionsSha256,
    reviewer: screen.decisions.reviewer, reviewedAt: screen.decisions.reviewedAt,
    sourceSnapshots: screen.index.sources, retainedIds: screen.retainedIds,
    titleAudit: screen.decisions.decisions.map(d => ({ ...d, title: entries.get(d.evidenceId).title,
      detailsRead: false, detailReview: d.disposition === 'screen-out' ? 'excluded-title-audit-only' : 'required-not-attested' })),
    evidence: [...evidence.values()], captures: [...captures.values()],
    limitations: ['Agent title judgments are not semantically verified by this validator.',
      'Materialization is not proof the filter read details or performed RCA/coverage.',
      'Local offline export only; no automatic hosted lazy retrieval or dispatch.'] };
  return { state: 'awaiting-filter-detail-review', ...immutable(outputPath, output),
    retainedCount: evidence.size, screenedOutCount: screen.index.entries.length - evidence.size };
}
