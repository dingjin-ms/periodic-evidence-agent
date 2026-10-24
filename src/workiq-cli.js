import { spawn } from 'node:child_process';
import { isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { setTimeout as delay } from 'node:timers/promises';
import { PilotError, requireThat, positive } from './common.js';
import { principalPath, validateWorkiqPath } from './runtime.js';
import { failureDetails } from './failure-details.js';

export function cliEnvelope(result) {
  let envelope = result?.structuredContent;
  if (!envelope) {
    const texts = result?.content?.filter(c => c.type === 'text');
    requireThat(texts?.length === 1, 'CLI fetch returned no unique structured/text envelope', 'blocked-protocol');
    try { envelope = JSON.parse(texts[0].text); }
    catch {
      throw new PilotError(/AuthenticationRequired|authentication requires|sign in again/i.test(texts[0].text)
        ? 'blocked-auth' : 'blocked-protocol', 'CLI fetch returned non-JSON content; raw diagnostics suppressed');
    }
  }
  if (result.isError) {
    const failure = cliFailure(envelope);
    throw Object.assign(new PilotError(failure.code, 'CLI fetch reported a tool error'), failure);
  }
  requireThat(envelope && Array.isArray(envelope.results) && envelope.results.length === 1,
    'CLI fetch returned an unrecognized entity envelope', 'blocked-protocol');
  return envelope;
}

export function cliFailure(envelope) {
  const entry = envelope?.results?.[0] ?? envelope;
  const auth = entry?.statusCode === 401 || /AuthenticationRequired|InteractionRequired|Unauthenticated/i.test(entry?.errorCode ?? '');
  const policy = entry?.statusCode === 403 || /AccessDenied|PolicyDenied|Forbidden/i.test(entry?.errorCode ?? '');
  const code = auth ? 'blocked-auth' : policy ? 'blocked-permission'
    : entry?.statusCode === 429 ? 'blocked-throttled' : 'failed-source';
  return { code, ...failureDetails(entry) };
}

// No arbitrary tool/method surface escapes this module. Diagnostics are discarded,
// not logged; the official executable owns all authentication state.
export async function workiqCli(config, { spawnProcess = spawn } = {}) {
  const settings = config.runtime.workiqCli;
  requireThat(settings?.enabled && isAbsolute(settings.executable) && existsSync(settings.executable),
    'Configure an approved absolute WorkIQ CLI executable');
  requireThat(settings.packageVersion === '1.0.1', 'Only the qualified CLI package version is configured');
  requireThat(typeof config.identity.designatedUser === 'string' && config.identity.designatedUser.includes('@'),
    'An explicit delegated account is required');
  const timeoutMs = positive(settings.timeoutMs, 'workiqCli.timeoutMs');
  const minReadIntervalMs = settings.minReadIntervalMs ?? 0;
  requireThat(Number.isSafeInteger(minReadIntervalMs) && minReadIntervalMs >= 0 && minReadIntervalMs <= 60000,
    'workiqCli.minReadIntervalMs must be an integer from 0 to 60000');
  const child = spawnProcess(settings.executable, ['--account', config.identity.designatedUser, 'mcp'],
    { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true, shell: false });
  child.stdout.setEncoding('utf8');
  const pending = new Map();
  let nextId = 0, buffer = '', terminal = null, closed = false;
  const exited = new Promise(resolve => child.once('close', resolve));
  function fail(error) {
    terminal ??= error;
    for (const request of pending.values()) { clearTimeout(request.timer); request.reject(terminal); }
    pending.clear();
  }
  child.on('error', () => fail(new PilotError('blocked-runtime', 'WorkIQ CLI failed to launch')));
  child.on('exit', () => { if (!closed) fail(new PilotError('blocked-runtime', 'WorkIQ CLI exited before completion')); });
  child.stdin.on('error', () => fail(new PilotError('blocked-runtime', 'WorkIQ CLI input closed')));
  child.stderr.on('data', () => {});
  child.stdout.on('data', data => {
    buffer += data;
    if (Buffer.byteLength(buffer) > 16 * 1024 * 1024) {
      fail(new PilotError('blocked-protocol', 'WorkIQ CLI response exceeded transport bound')); child.kill(); return;
    }
    let end;
    while ((end = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, end).trim(); buffer = buffer.slice(end + 1);
      if (!line) continue;
      let message;
      try { message = JSON.parse(line); }
      catch { fail(new PilotError('blocked-protocol', 'WorkIQ CLI emitted non-JSON stdout')); child.kill(); return; }
      if (message.method && message.id !== undefined) {
        child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: message.id,
          error: { code: -32601, message: 'Client requests are not supported' } }) + '\n');
        continue;
      }
      const request = pending.get(message.id);
      if (!request) continue;
      pending.delete(message.id); clearTimeout(request.timer);
      if (message.error) {
        const diagnostic = JSON.stringify(message.error);
        request.reject(new PilotError(/AuthenticationRequired|interaction_required|authentication requires/i.test(diagnostic)
          ? 'blocked-auth' : /AccessDenied|policy.denied/i.test(diagnostic) ? 'blocked-permission' : 'failed-source',
        'WorkIQ CLI RPC failed; raw diagnostics suppressed'));
      } else request.resolve(message.result);
    }
  });
  function rpc(method, params) {
    if (terminal) return Promise.reject(terminal);
    const id = ++nextId;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        fail(new PilotError('blocked-runtime', 'WorkIQ CLI request timed out; no retry')); child.kill();
      }, timeoutMs);
      pending.set(id, { resolve, reject, timer });
      child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n');
    });
  }
  async function close() {
    if (closed) return;
    closed = true;
    fail(new PilotError('blocked-runtime', 'WorkIQ CLI closed'));
    child.stdin.end(); child.kill();
    let timer;
    try {
      await Promise.race([exited, new Promise((_, reject) => {
        timer = setTimeout(() => reject(new PilotError('blocked-runtime', 'WorkIQ CLI exit not confirmed')), 5000);
      })]);
    } finally { clearTimeout(timer); }
  }
  try {
    const init = await rpc('initialize', { protocolVersion: '2025-03-26', capabilities: {},
      clientInfo: { name: 'bounded-evidence-collector', version: '1.0.0' } });
    requireThat(init?.protocolVersion === '2025-03-26', 'Unsupported WorkIQ MCP protocol', 'blocked-protocol');
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
    const cursors = new Set();
    let cursor, found = false, count = 0;
    do {
      const page = await rpc('tools/list', cursor ? { cursor } : {});
      requireThat(Array.isArray(page?.tools) && (count += page.tools.length) <= 200, 'Invalid WorkIQ tool discovery', 'blocked-protocol');
      found ||= page.tools.some(t => t.name === 'fetch' && t.inputSchema?.properties?.entityUrls);
      cursor = page.nextCursor;
      requireThat(!cursor || !cursors.has(cursor), 'CLI discovery cycle', 'blocked-protocol');
      if (cursor) cursors.add(cursor);
      requireThat(cursors.size <= 10, 'CLI discovery exceeded page bound', 'blocked-protocol');
    } while (cursor);
    requireThat(found, 'WorkIQ CLI fetch tool is unavailable', 'blocked-runtime');
    let lastReadFinishedAt = 0;
    return {
      read: async path => {
        validateWorkiqPath(config, path);
        requireThat(path === principalPath || path.startsWith('/teams/'), 'CLI pilot permits Teams reads only', 'blocked-scope');
        // Pace sequential reads without hiding retries or changing receipt/call budgets.
        const remaining = minReadIntervalMs - (Date.now() - lastReadFinishedAt);
        if (remaining > 0) await delay(remaining);
        try { return await rpc('tools/call', { name: 'fetch', arguments: { entityUrls: [path] } }); }
        finally { lastReadFinishedAt = Date.now(); }
      },
      close
    };
  } catch (error) { await close(); throw error; }
}
