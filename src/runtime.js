import { CopilotClient, RuntimeConnection, defineTool, ToolSet } from '@github/copilot-sdk';
import { join, delimiter, isAbsolute } from 'node:path';
import { existsSync } from 'node:fs';
import { requireThat, PilotError, json, safeError } from './common.js';

export { defineTool };
export function cliPath(name) {
  if (isAbsolute(name)) return name;
  const candidates = (process.env.PATH ?? '').split(delimiter).map(dir => join(dir, process.platform === 'win32' && !name.endsWith('.exe') ? `${name}.exe` : name));
  const found = candidates.find(path => existsSync(path));
  requireThat(found, 'Copilot executable not found on PATH', 'blocked-runtime');
  return found;
}
export function createClient(config, workingDirectory, workplace = false) {
  return new CopilotClient({
    connection: RuntimeConnection.forStdio({ path: cliPath(config.runtime.cliPath),
      args: config.limits.maxAiCreditsPerSession > 0 ? ['--max-ai-credits', String(config.limits.maxAiCreditsPerSession)] : [] }),
    mode: workplace ? 'copilot-cli' : 'empty',
    ...(workplace ? {} : { baseDirectory: join(config.stateDirectory, 'runtime') }),
    workingDirectory,
    logLevel: 'error',
    useLoggedInUser: true
  });
}
export function restrictedSession(tools, { sessionId, workingDirectory, prompt = '' } = {}) {
  const names = new Set(tools.map(t => t.name));
  return {
    sessionId, workingDirectory, tools,
    availableTools: tools.reduce((set, tool) => set.addCustom(tool.name), new ToolSet()),
    onPermissionRequest: () => ({ kind: 'denied-by-rules' }),
    hooks: {
      onPreToolUse: ({ toolName }) => ({
        permissionDecision: names.has(toolName) ? 'allow' : 'deny',
        permissionDecisionReason: 'Only bounded pilot callbacks are authorized'
      })
    },
    systemMessage: { mode: 'append', content: prompt },
    onUserInputRequest: () => { throw new PilotError('blocked-input', 'Worker needs operator input; no implicit approval'); }
  };
}
export function authoringSession(client, tools, options, round) {
  const configuration = restrictedSession(tools, options);
  return round > 0
    ? client.resumeSession(options.sessionId, configuration)
    : client.createSession(configuration);
}
export async function withClient(config, cwd, fn, workplace = false) {
  const client = createClient(config, cwd, workplace);
  try { await client.start(); return await fn(client); }
  finally { await client.stop(); }
}
export async function smokeRuntime(config, cwd) {
  return withClient(config, cwd, async client => {
    const tool = defineTool('pilot_echo', {
      description: 'Offline permission-boundary probe', parameters: { type: 'object', properties: {}, additionalProperties: false },
      handler: () => 'pilot-runtime-ok'
    });
    const session = await client.createSession(restrictedSession([tool], { workingDirectory: cwd }));
    try {
      await session.rpc.tools.initializeAndValidate();
      const response = await session.rpc.tools.execute({ name: 'pilot_echo', arguments: {} });
      requireThat(json(response).includes('pilot-runtime-ok'), 'SDK custom-tool execution not confirmed', 'blocked-runtime');
      let denied = false;
      try {
        const output = await session.rpc.tools.execute({ name: 'powershell', arguments: { command: 'Write-Output forbidden' } });
        denied = typeof output === 'object' && ['denied', 'rejected', 'failure'].includes(output.resultType);
      } catch { denied = true; }
      requireThat(denied, 'SDK failed to reject an unavailable tool', 'blocked-runtime');
      return { customTool: 'executed', unavailableShell: 'rejected', modelInvoked: false, workplaceRead: false };
    } finally { await session.disconnect(); }
  });
}
export function validateSeed(seed) {
  requireThat(seed && typeof seed.id === 'string' && typeof seed.path === 'string', 'WorkIQ seed needs id and exact entity path');
  const url = new URL(seed.path, 'https://scope.invalid');
  requireThat(url.origin === 'https://scope.invalid' && seed.path.startsWith('/') && !seed.path.startsWith('//'),
    'WorkIQ accepts only relative entity paths', 'blocked-scope');
  const exact = /^\/teams\/[^/]+\/channels\/[^/]+\/messages\/[^/]+$/.test(url.pathname) ||
    /^\/drives\/[^/]+\/items\/[^/]+$/.test(url.pathname) ||
    /^\/me\/messages\/[^/]+$/.test(url.pathname);
  requireThat(exact && !/%2f|%5c|%2e|\.\./i.test(url.pathname), 'Only exact Teams messages, mail messages or drive items are enabled', 'blocked-scope');
  requireThat(url.searchParams.has('$select') &&
    [...url.searchParams.keys()].every(k => k === '$select'), 'Exact seeds require $select; expansions/search/pagination are disabled', 'blocked-scope');
  requireThat(typeof seed.url === 'string' && seed.url.startsWith('https://'), 'Seed must retain its source URL');
  return seed;
}
export const principalPath = '/me?$select=id,userPrincipalName';
export function unwrapWorkiq(result) {
  if (!result || typeof result !== 'object' || result.resultType !== 'success') {
    const text = typeof result === 'string' ? result : `${result?.error ?? ''} ${result?.textResultForLlm ?? ''}`;
    const auth = /unauthenticated|authentication required|sign.in|token.{0,20}expired|\b401\b|\b403\b/i.test(text);
    const unavailable = /not found|does not exist|not available|unknown tool/i.test(text);
    const denied = /permission|denied|not allowed/i.test(text);
    throw new PilotError(auth ? 'blocked-auth' : unavailable ? 'blocked-runtime' : denied ? 'blocked-permission' : 'blocked-source',
      `WorkIQ did not confirm retrieval (result=${result?.resultType ?? typeof result}; ${auth ? 'authentication diagnostic' : unavailable ? 'tool unavailable diagnostic' : denied ? 'permission diagnostic' : 'no recognized safe diagnostic'}). No source data accepted.`);
  }
  let payload;
  try { payload = JSON.parse(result.textResultForLlm); }
  catch { throw new PilotError('blocked-protocol', 'WorkIQ returned an unrecognized non-JSON response; no source data accepted'); }
  requireThat(Array.isArray(payload.results) && payload.results.length === 1, 'WorkIQ response envelope is not the verified single-entity result shape', 'blocked-protocol');
  const entry = payload.results[0];
  requireThat(entry.statusCode === 200 && entry.data && typeof entry.data === 'object',
    `WorkIQ entity read was not successful (status ${Number.isInteger(entry.statusCode) ? entry.statusCode : 'unknown'})`,
    [401, 403].includes(entry.statusCode) ? 'blocked-auth' : entry.statusCode === 404 ? 'unavailable' : 'blocked-source');
  return entry.data;
}
export function verifyPrincipal(config, principal) {
  requireThat(principal?.id === config.identity.objectId &&
    principal.userPrincipalName?.toLowerCase() === config.identity.designatedUser?.toLowerCase(),
  'WorkIQ runtime principal does not match the designated user; no seed reads allowed', 'blocked-auth');
}
export function channelRoot(seed) {
  requireThat(seed.kind === 'teams-channel' && typeof seed.teamId === 'string' && typeof seed.channelId === 'string' &&
    /^[a-zA-Z0-9-]+$/.test(seed.teamId) && !/[\/\\?#\0]/.test(seed.channelId) && seed.channelId.length > 0,
  'Invalid approved Teams channel identity', 'blocked-scope');
  return `/teams/${encodeURIComponent(seed.teamId)}/channels/${encodeURIComponent(seed.channelId)}/messages`;
}
export function validateWorkiqPath(config, path) {
  if (path === principalPath) return;
  for (const seed of config.sources.workiq.seeds) {
    if (seed.kind !== 'teams-channel' && seed.path === path) { validateSeed(seed); return; }
    if (seed.kind !== 'teams-channel') continue;
    const root = channelRoot(seed);
    const url = new URL(path, 'https://scope.invalid');
    if (url.origin !== 'https://scope.invalid' || !path.startsWith('/')) continue;
    const normalizedPath = url.pathname.split('/').map(p => encodeURIComponent(decodeURIComponent(p))).join('/');
    const suffix = normalizedPath.slice(root.length);
    if (!normalizedPath.startsWith(root) || !(suffix === '' || /^\/[^/]+(?:\/replies(?:\/[^/]+)?)?$/.test(suffix))) continue;
    requireThat(!/%2f|%5c|%2e|\.\./i.test(url.pathname), 'Invalid Teams resource segment', 'blocked-scope');
    requireThat([...url.searchParams.keys()].every(k => ['$select', '$top', '$skiptoken'].includes(k)),
      'Unapproved Teams query parameter', 'blocked-scope');
    const collection = suffix === '' || suffix.endsWith('/replies');
    const top = Number(url.searchParams.get('$top'));
    const projection = config.sources.workiq.projection ?? messageSelect;
    requireThat(projection.split(',').every(field => messageSelect.split(',').includes(field)) &&
      projection.split(',').includes('id') && projection.split(',').includes('createdDateTime') &&
      (collection ? Number.isInteger(top) && top >= 1 && top <= 50 : !url.searchParams.has('$top')) &&
      url.searchParams.get('$select') === projection && (collection || !url.searchParams.has('$skiptoken')),
      'Teams page must retain the bounded projection', 'blocked-scope');
    return;
  }
  throw new PilotError('blocked-scope', 'WorkIQ path is outside exact seeds and approved channels');
}
export const messageSelect = 'id,createdDateTime,lastModifiedDateTime,deletedDateTime,etag,subject,body,webUrl,replyToId,channelIdentity';
export function nextWorkiqPage(config, nextLink, expectedPath) {
  requireThat(typeof nextLink === 'string' && nextLink.length < 16384, 'Invalid WorkIQ continuation link', 'blocked-scope');
  let path = nextLink;
  if (nextLink.startsWith('https://')) {
    const link = new URL(nextLink);
    requireThat(link.origin === 'https://graph.microsoft.com' && link.pathname.startsWith('/v1.0/'),
      'Unexpected pagination authority', 'blocked-scope');
    path = link.pathname.slice('/v1.0'.length) + link.search;
  }
  const target = new URL(path, 'https://scope.invalid');
  const expected = new URL(expectedPath, 'https://scope.invalid');
  requireThat(target.origin === 'https://scope.invalid' &&
    !/%2f|%5c|%2e|\.\./i.test(target.pathname) &&
    decodeURIComponent(target.pathname) === decodeURIComponent(expected.pathname),
    'Continuation escaped the current channel/thread collection', 'blocked-scope');
  // Restore the same bounded projection when the server omits it in a nextLink.
  if (!target.searchParams.has('$top')) target.searchParams.set('$top', '50');
  if (!target.searchParams.has('$select')) target.searchParams.set('$select', config.sources.workiq.projection ?? messageSelect);
  path = expected.pathname + target.search;
  validateWorkiqPath(config, path);
  return path;
}
export function workiqRuntimeError(error, phase) {
  if (error instanceof PilotError) return error;
  const safePhase = ['mcp-status', 'mcp-running-check', 'mcp-start', 'mcp-tools-list', 'tool-initialization', 'read-controller', 'fetch'].includes(phase) ? phase : 'runtime';
  const message = String(error?.message ?? '');
  const requiresAuthentication = message === 'MCP server "workiq" requires authentication' ||
    message === 'Request session.mcp.startServer failed with message: MCP server "workiq" requires authentication';
  const discoveryChallenge = /^(?:Request session\.mcp\.listTools failed with message: )?(?:Error: )?MCP OAuth challenge required \(HTTP 401\)$/.test(message);
  const auth = requiresAuthentication || discoveryChallenge || /\bunauthenticated\b|\bauthentication\b|\bsign[ -]?in\b|\btoken\b.{0,30}\bexpired\b|\b(?:401|403)\b/i.test(message);
  const rpc = Number.isSafeInteger(error?.code) ? `; RPC code ${error.code}` : '';
  const diagnostic = discoveryChallenge ? 'tools/list received an OAuth challenge (HTTP 401); the reason for rejection is not established'
    : requiresAuthentication ? 'configured WorkIQ server requires authentication'
    : auth ? 'authentication-related failure; unrecognized raw details suppressed'
      : `unrecognized runtime failure (${safeError(error).code}); raw details suppressed`;
  return new PilotError(auth ? 'blocked-auth' : 'blocked-runtime',
    `WorkIQ ${safePhase} failed${rpc}: ${diagnostic}. ${
      discoveryChallenge ? 'Explicit recovery is /mcp auth workiq in the existing interactive CLI; stop on any new consent request.'
        : 'Inspect the matching host authentication context before another sign-in or retry;'
    } no automatic retry.`);
}
export async function prepareWorkiq(session, diagnostics = {}) {
  diagnostics.phase = 'mcp-status';
  diagnostics.calls = { listConfigured: 0, isServerRunning: 0, startServer: 0, listTools: 0, initializeAndValidate: 0 };
  diagnostics.observations = [];
  const observe = async () => {
    diagnostics.phase = 'mcp-status';
    diagnostics.calls.listConfigured++;
    const configured = await session.rpc.mcp.listConfigured();
    requireThat(Array.isArray(configured?.servers), 'WorkIQ configuration response has no server list', 'blocked-protocol');
    const matches = configured.servers.filter(s => s.name === 'workiq');
    requireThat(matches.length <= 1, 'WorkIQ configuration has ambiguous matching entries; no start attempted', 'blocked-protocol');
    const server = matches[0];
    const status = server?.live?.status;
    const knownStatus = ['connected', 'pending', 'stopped', 'needs-auth', 'failed', 'disabled', 'not_configured'].includes(status);
    diagnostics.observations.push({
      configuredServerCount: configured.servers.length,
      serverName: server ? 'workiq' : null,
      enabled: typeof server?.enabled === 'boolean' ? server.enabled : null,
      pluginSourceMatches: server?.source === undefined ? null
        : server.source !== 'plugin' ? false
          : server.sourcePlugin === undefined ? null : server.sourcePlugin === 'workiq',
      liveStatus: knownStatus ? status : 'unknown'
    });
    requireThat(server?.enabled === true, 'WorkIQ is not configured and enabled in this runtime', 'blocked-runtime');
    requireThat(knownStatus, 'WorkIQ returned an unknown connection status; no start attempted', 'blocked-protocol');
    requireThat(status !== 'needs-auth', 'WorkIQ mcp-status reports needs-auth; no start or retry attempted', 'blocked-auth');
    // Effective enabled configuration can precede materialization of its live server.
    requireThat(['connected', 'pending', 'stopped', 'not_configured'].includes(status),
      `WorkIQ mcp-status reports ${status}; no automatic restart attempted`, 'blocked-runtime');
    return status;
  };
  try {
    const status = await observe();
    if (status !== 'connected') {
      diagnostics.phase = 'mcp-running-check';
      diagnostics.calls.isServerRunning++;
      const { running } = await session.rpc.mcp.isServerRunning({ serverName: 'workiq' });
      requireThat(running === false, 'WorkIQ transport is active but initialization is pending; no redundant start attempted', 'blocked-readiness');
      diagnostics.phase = 'mcp-start';
      diagnostics.calls.startServer++;
      await session.rpc.mcp.startServer({ serverName: 'workiq' });
      requireThat(await observe() === 'connected', 'WorkIQ start returned before confirmed readiness; no tool call or restart attempted', 'blocked-readiness');
    }
    diagnostics.phase = 'mcp-tools-list';
    diagnostics.calls.listTools++;
    const metadata = await session.rpc.mcp.listTools({ serverName: 'workiq' });
    requireThat(metadata.tools?.some(tool => tool.name === 'fetch'),
      'WorkIQ is connected but tools/list has not exposed fetch; no principal read attempted', 'blocked-readiness');
    diagnostics.phase = 'tool-initialization';
    diagnostics.calls.initializeAndValidate++;
    await session.rpc.tools.initializeAndValidate();
    diagnostics.phase = 'ready';
  } catch (error) {
    throw workiqRuntimeError(error, diagnostics.phase);
  }
}
export async function withWorkiq(config, fn) {
  requireThat(config.runtime.workiqPluginDirectory && existsSync(config.runtime.workiqPluginDirectory),
    'Configure the already-installed WorkIQ plugin directory; SDK config discovery is off by default', 'blocked-runtime');
  return withClient(config, config.stateDirectory, async client => {
    let allowed = null;
    const session = await client.createSession({
      pluginDirectories: [config.runtime.workiqPluginDirectory],
      enableConfigDiscovery: false,
      mcpOAuthTokenStorage: 'persistent',
      availableTools: new ToolSet().addMcp('workiq-fetch'),
      onPermissionRequest: request => request.kind === 'mcp' && request.serverName === 'workiq' && request.toolName === 'fetch'
        ? { kind: 'approved' } : { kind: 'denied-by-rules' },
      hooks: {
        onPreToolUse: ({ toolName, toolArgs }) => ({
          permissionDecision: allowed && toolName === 'workiq-fetch' && json(toolArgs) === json(allowed) ? 'allow' : 'deny'
        }),
        onPreMcpToolCall: ({ serverName, toolName, arguments: args }) => {
          requireThat(serverName === 'workiq' && toolName === 'fetch' && json(args) === json(allowed),
            'WorkIQ boundary mismatch', 'blocked-scope');
        }
      }
    });
    let phase = 'read-controller';
    try {
      await prepareWorkiq(session);
      return await fn(async path => {
        requireThat(allowed === null, 'Concurrent WorkIQ requests are not supported');
        validateWorkiqPath(config, path);
        allowed = { entityUrls: [path] };
        phase = 'fetch';
        try { return unwrapWorkiq(await session.rpc.tools.execute({ name: 'workiq-fetch', arguments: allowed })); }
        finally { allowed = null; }
      });
    } catch (error) {
      throw workiqRuntimeError(error, phase);
    } finally { await session.disconnect(); }
  }, true);
}
