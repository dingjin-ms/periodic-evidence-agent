import { appendApp, appStatus, noCredentials, workiqContinuation } from './app-native.js';
import { workiqCli, cliEnvelope, cliFailure } from './workiq-cli.js';
import { principalPath, verifyPrincipal, validateWorkiqPath, messageSelect } from './runtime.js';
import { hash, json, now, uuid, requireThat, safeError, PilotError } from './common.js';
import { failureDetails } from './failure-details.js';

function storedRun(ledger, runId) {
  const row = ledger.db.prepare('SELECT body FROM app_runs WHERE id=?').get(runId);
  requireThat(row, 'Unknown CLI collection run');
  return JSON.parse(row.body);
}
function terminal(ledger, runId, error, pendingRequest, readCalls, pass) {
  const prior = appStatus(ledger, runId).collection.find(p => p.pass === pass) ??
    { pass, examinedRecords: 0, evidenceCount: 0, evidenceIds: [], identityVerified: false };
  const preserveAuth = prior.state === 'blocked-auth';
  const result = { ...prior, state: preserveAuth ? 'blocked-auth' : error.code ?? 'failed-source',
    error: preserveAuth ? prior.error : safeError(error),
    ...(preserveAuth ? { secondaryError: safeError(error) } : {}),
    readCalls, nextRequest: null, cursor: null, pendingRequest,
    execution: 'local-workiq-cli-stdio', provenance: prior.provenance ?? 'local-workiq-cli-attempt',
    identityVerified: prior.identityVerified ?? false,
    renewalQualification: 'deferred', continuationAuthorized: false,
    continuation: null,
    coverage: 'Incomplete current channel enumeration; retained receipts do not establish full-day coverage' };
  ledger.db.prepare('INSERT INTO app_passes VALUES(?,?,?) ON CONFLICT(run_id,pass) DO UPDATE SET body=excluded.body')
    .run(runId, pass, json(result));
  ledger.db.prepare('UPDATE runs SET state=?,error=? WHERE id=?')
    .run(result.state, json(result.error), `${runId}:${pass}`);
  return appStatus(ledger, runId);
}
function capture(ledger, runId, raw) {
  noCredentials(raw);
  const bytes = Buffer.from(json(raw)), digest = hash(bytes);
  ledger.db.prepare('INSERT OR IGNORE INTO captures VALUES(?,?)').run(digest, bytes);
  ledger.db.prepare('INSERT OR IGNORE INTO app_artifacts VALUES(?,?,?)')
    .run(runId, `sqlite:capture:${digest}`, 'workiq-cli-mcp-response');
  return digest;
}

export async function collectCliWorkiq(config, ledger, runId, factory = workiqCli, pass = 'workiq:created') {
  requireThat(['workiq:created', 'workiq:changed'].includes(pass), 'Unsupported CLI WorkIQ pass');
  const run = storedRun(ledger, runId);
  requireThat(run.configHash === hash(json(config)), 'Run configuration changed');
  requireThat(run.dryRun && run.provenance === 'app-tool', 'CLI collection is an explicitly authorized real collection-only dry run');
  requireThat(config.runtime.workiqCli?.enabled && config.sources.workiq.enabled && config.sources.workiq.scopeApproved &&
    config.sources.workiq.seeds.length > 0 && config.sources.workiq.seeds.every(s => s.kind === 'teams-channel' && s.includeReplies),
  'Explicit CLI activation and approved Teams roots/replies scope are required');
  requireThat(!ledger.db.prepare('SELECT 1 FROM app_passes WHERE run_id=? AND pass=?').get(runId, pass),
    'WorkIQ pass already recorded; no duplicate collection');
  const binding = ledger.db.prepare('SELECT pass FROM app_workiq_continuations WHERE run_id=?').get(runId);
  requireThat(!run.continuationFrom || workiqContinuation(ledger, runId, pass)?.parentRunId === run.continuationFrom,
    'Continuation preparation is incomplete; no client launched', 'blocked-reconciliation');
  requireThat(!binding || workiqContinuation(ledger, runId, pass), 'Continuation is bound to a different source pass');
  requireThat(!ledger.db.prepare('SELECT body FROM app_passes WHERE run_id=? AND pass LIKE ?').all(runId, 'workiq:%')
    .some(r => JSON.parse(r.body).state === 'blocked-auth'), 'WorkIQ authentication is blocked; no cross-pass retry');
  const readConfig = structuredClone(config);
  const inheritedPage = workiqContinuation(ledger, runId, pass)?.calls[0];
  if (inheritedPage) {
    readConfig.sources.workiq.projection = new URL(inheritedPage.request.entityUrls[0], 'https://scope.invalid')
      .searchParams.get('$select');
    validateWorkiqPath(readConfig, inheritedPage.request.entityUrls[0]);
  }
  requireThat(pass !== 'workiq:changed' ||
    (readConfig.sources.workiq.projection ?? messageSelect).split(',').includes('lastModifiedDateTime'),
  'Changed collection requires lastModifiedDateTime in the approved projection');
  const lock = `cli-workiq:${runId}`, key = pass === 'workiq:created' ? lock : `${lock}:changed`, owner = ledger.acquire(lock);
  const previousCursor = ledger.cursor(`app:${pass}`);
  let client, pendingRequest = { entityUrls: [principalPath] }, readCalls = 0, started = false;
  try {
    ledger.operation(key, runId, 'local-workiq-cli-collection', { execution: 'local-workiq-cli-stdio',
      renewalQualification: 'deferred', maxItems: run.limits.maxItems, maxCalls: run.limits.maxCalls });
    started = true;
    client = await factory(readConfig);
    let status;
    while (pendingRequest) {
      requireThat(readCalls < run.limits.maxCalls, 'CLI read-call cap reached; coverage is partial', 'partial');
      const path = pendingRequest.entityUrls[0];
      validateWorkiqPath(readConfig, path);
      const call = { id: uuid(), requestedAt: now(), tool: 'workiq-fetch', request: pendingRequest };
      // Persist intent before issuing the read. An interrupted request is never retried.
      ledger.db.prepare('INSERT INTO app_transport VALUES(?,?,?,?)').run(call.id, runId, pass,
        json({ execution: 'local-workiq-cli-stdio', state: 'requested', call }));
      readCalls++;
      let captureSha256;
      try {
        const raw = await client.read(path);
        call.observedAt = now();
        captureSha256 = capture(ledger, runId, raw);
        const envelope = cliEnvelope(raw), entry = envelope.results[0];
        if (entry.statusCode !== 200 || !entry.data || typeof entry.data !== 'object') {
          const failure = cliFailure(envelope);
          call.failure = failure;
          throw Object.assign(new PilotError(failure.code, 'CLI entity read failed; see recorded response and safe failure category'), failure);
        }
        call.response = envelope;
        if (path === principalPath) verifyPrincipal(config, entry.data);
        ledger.db.prepare('UPDATE app_transport SET body=? WHERE id=?')
          .run(json({ execution: 'local-workiq-cli-stdio', state: 'received', call, captureSha256 }), call.id);
        status = await appendApp(config, ledger, runId, { eventId: `cli-${call.id}`, pass, calls: [call] },
          { directWorkiqVerified: true });
      } catch (error) {
        call.observedAt ??= now();
        const failure = call.failure ?? { code: error.code ?? 'failed-source', ...failureDetails(error) };
        if (!call.response) call.failure = failure;
        ledger.db.prepare('UPDATE app_transport SET body=? WHERE id=?')
          .run(json({ execution: 'local-workiq-cli-stdio', state: 'failed', call, captureSha256, error: safeError(error) }), call.id);
        throw error;
      }
      const result = status.collection.find(p => p.pass === pass);
      pendingRequest = result.nextRequest;
      if (result.state !== 'partial' || !pendingRequest) break;
    }
    const result = status.collection.find(p => p.pass === pass);
    ledger.finishOperation(key, result.state, { readCalls, renewalQualification: 'deferred', execution: 'local-workiq-cli-stdio' });
    return status;
  } catch (error) {
    if (!started) throw error;
    const result = terminal(ledger, runId, error, pendingRequest, readCalls, pass);
    ledger.finishOperation(key, 'blocked', { error: safeError(error), readCalls, renewalQualification: 'deferred' });
    return result;
  } finally {
    try { await client?.close(); }
    catch (error) {
      if (previousCursor) ledger.db.prepare('INSERT INTO cursors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET value=excluded.value')
        .run(`app:${pass}`, json(previousCursor));
      else ledger.db.prepare('DELETE FROM cursors WHERE source=?').run(`app:${pass}`);
      terminal(ledger, runId, error, pendingRequest, readCalls, pass);
      ledger.finishOperation(key, 'blocked', { error: safeError(error), cleanupFailed: true });
      throw error;
    } finally { ledger.release(lock, owner); }
  }
}

export async function reconcileCliWorkiq(config, ledger, runId, pass = 'workiq:created') {
  requireThat(['workiq:created', 'workiq:changed'].includes(pass), 'Unsupported CLI WorkIQ pass');
  const run = storedRun(ledger, runId), lock = `cli-workiq:${runId}`, key = pass === 'workiq:created' ? lock : `${lock}:changed`;
  requireThat(run.configHash === hash(json(config)), 'Run configuration changed');
  const operation = ledger.db.prepare('SELECT state FROM operations WHERE id=?').get(key);
  requireThat(operation?.state === 'started', 'Only an interrupted CLI collection can be reconciled');
  const owner = ledger.acquire(lock);
  try {
    const rows = ledger.db.prepare('SELECT body FROM app_transport WHERE run_id=? AND pass=? ORDER BY rowid')
      .all(runId, pass).map(r => JSON.parse(r.body));
    for (const row of rows) {
      requireThat(row.execution === 'local-workiq-cli-stdio', 'Not a CLI transport receipt');
      if (row.state !== 'received') break;
      await appendApp(config, ledger, runId, { eventId: `cli-${row.call.id}`, pass, calls: [row.call] },
        { directWorkiqVerified: true });
    }
    const prior = appStatus(ledger, runId).collection.find(p => p.pass === pass);
    const result = rows.every(r => r.state === 'received') && (prior?.state === 'complete' || prior?.continuation)
      ? appStatus(ledger, runId)
      : terminal(ledger, runId, new PilotError('blocked-reconciliation', 'Interrupted collection; no reads retried'),
        rows.at(-1)?.call.request ?? null, rows.length, pass);
    ledger.finishOperation(key, 'reconciled-offline', { newSourceReads: 0, renewalQualification: 'deferred' });
    return result;
  } finally { ledger.release(lock, owner); }
}
