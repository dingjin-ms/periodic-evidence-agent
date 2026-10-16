import { randomBytes, timingSafeEqual } from 'node:crypto';
import { spawn } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createServer } from 'node:net';
import { PilotError, json, positive, requireThat, safeError, uuid } from './common.js';
import { workerToolCliNames, workerToolDefinitions } from './worker-tool-contract.js';

const bridgePath = fileURLToPath(new URL('./agency-mcp-bridge.js', import.meta.url));

function validateArguments(tool, args) {
  requireThat(args && typeof args === 'object' && !Array.isArray(args),
    `Invalid ${tool.name} arguments`, 'blocked-protocol');
  const schema = tool.inputSchema;
  const keys = Object.keys(args);
  requireThat(keys.every(key => Object.hasOwn(schema.properties, key)) &&
    schema.required.every(key => Object.hasOwn(args, key)),
  `Invalid ${tool.name} arguments`, 'blocked-protocol');
  for (const [key, value] of Object.entries(args)) {
    const expected = schema.properties[key];
    if (expected.type === 'string')
      requireThat(typeof value === 'string', `Invalid ${tool.name} arguments`, 'blocked-protocol');
    if (expected.type === 'integer')
      requireThat(Number.isInteger(value), `Invalid ${tool.name} arguments`, 'blocked-protocol');
  }
}

async function invokeTool(toolkit, name, args) {
  switch (name) {
    case 'pilot_list': return toolkit.list(args.path);
    case 'pilot_search': return toolkit.search(args.query, args.path);
    case 'pilot_read': return toolkit.read(args.path, args.startLine ?? null, args.endLine ?? null);
    case 'pilot_write': return toolkit.write(args.path, args.content);
    case 'pilot_replace_lines': return toolkit.replaceLines(
      args.path, args.startLine, args.endLine, args.expected, args.replacement);
    case 'pilot_finish': return toolkit.finish(args);
    default: throw new PilotError('blocked-protocol', 'Unknown pilot tool');
  }
}

export async function startWorkerRpcServer(toolkit, options = {}) {
  const token = options.token ?? randomBytes(32).toString('hex');
  const endpoint = options.endpoint ?? (process.platform === 'win32'
    ? `\\\\.\\pipe\\periodic-evidence-${uuid()}`
    : join(tmpdir(), `periodic-evidence-${uuid()}.sock`));
  const tools = new Map(workerToolDefinitions.map(tool => [tool.name, tool]));
  const server = createServer({ allowHalfOpen: true }, socket => {
    socket.setEncoding('utf8');
    let input = '';
    let handled = false;
    const respond = payload => socket.end(`${json(payload)}\n`);
    socket.on('data', async chunk => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input) > 1024 * 1024) {
        handled = true;
        respond({ ok: false, error: { code: 'blocked-protocol', message: 'Pilot request exceeded the protocol limit' } });
        return;
      }
      const newline = input.indexOf('\n');
      if (newline < 0) return;
      handled = true;
      try {
        requireThat(!input.slice(newline + 1).trim(), 'Only one pilot request is allowed per connection',
          'blocked-protocol');
        const request = JSON.parse(input.slice(0, newline));
        const actual = Buffer.from(String(request.token ?? ''));
        const expected = Buffer.from(token);
        requireThat(actual.length === expected.length && timingSafeEqual(actual, expected),
          'Pilot controller authentication failed', 'blocked-protocol');
        requireThat(typeof request.id === 'string' && request.id.length > 0,
          'Pilot request ID is required', 'blocked-protocol');
        const tool = tools.get(request.tool);
        requireThat(tool, 'Unknown pilot tool', 'blocked-protocol');
        validateArguments(tool, request.args);
        respond({ id: request.id, ok: true,
          result: await invokeTool(toolkit, request.tool, request.args) });
      } catch (error) {
        respond({ ok: false, error: safeError(error) });
      }
    });
    socket.on('error', () => {});
  });
  await new Promise((resolveListen, rejectListen) => {
    server.once('error', rejectListen);
    server.listen(endpoint, () => {
      server.off('error', rejectListen);
      resolveListen();
    });
  });
  return {
    endpoint,
    token,
    close: async () => {
      await new Promise((resolveClose, rejectClose) =>
        server.close(error => error ? rejectClose(error) : resolveClose()));
      if (process.platform !== 'win32') rmSync(endpoint, { force: true });
    }
  };
}

export function agencyArguments(config, provider, current, authoring, mcpConfigPath, usagePath) {
  const available = workerToolCliNames.join(',');
  const extra = [
    '-C', current.workspace,
    '--silent',
    '--output-format', 'json',
    '--disable-builtin-mcps',
    '--additional-mcp-config', `@${mcpConfigPath}`,
    '--available-tools', available,
    '--allow-all-tools',
    '--max-ai-credits', String(config.limits.maxAiCreditsPerSession),
    '--usage-output-file', usagePath,
    '--no-custom-instructions',
    '--no-auto-update',
    '--no-ask-user',
    '--no-remote',
    '--no-remote-export'
  ];
  if (authoring.round > 0) extra.push('--resume', current.session_id);
  return [
    '--no-aec',
    '--log-dir', resolve(config.stateDirectory, 'agency-local-logs'),
    'copilot',
    '--session-id', current.session_id,
    '--profile-only', provider.profile,
    '--no-default-mcps',
    '--no-config-plugins',
    '--',
    ...extra
  ];
}

export function launchAgency(executable, args, { cwd, env, timeoutMs, prompt }) {
  return new Promise((resolveLaunch, rejectLaunch) => {
    const child = spawn(executable, args, {
      cwd, env, windowsHide: true, timeout: timeoutMs,
      stdio: ['pipe', 'pipe', 'pipe']
    });
    let stdout = '', stderr = '';
    const collect = (current, chunk) => {
      const next = current + chunk;
      if (Buffer.byteLength(next) > 4 * 1024 * 1024) {
        child.kill();
        throw new PilotError('blocked-runtime', 'Agency output exceeded the protocol limit');
      }
      return next;
    };
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', chunk => {
      try { stdout = collect(stdout, chunk); } catch (error) { rejectLaunch(error); }
    });
    child.stderr.on('data', chunk => {
      try { stderr = collect(stderr, chunk); } catch (error) { rejectLaunch(error); }
    });
    child.once('error', () =>
      rejectLaunch(new PilotError('blocked-runtime', 'Agency process could not be started')));
    child.once('close', (code, signal) => {
      if (code === 0) resolveLaunch({ stdout, stderr });
      else rejectLaunch(new PilotError('blocked-runtime',
        `Agency process exited without a successful result (code=${code ?? 'none'}, signal=${signal ?? 'none'}); inspect local Agency logs.`));
    });
    child.stdin.on('error', () => {});
    child.stdin.end(prompt);
  });
}

export async function runAgencyLocal(config, current, toolkit, prompt, provider, authoring,
  dependencies = {}) {
  requireThat(Number.isFinite(config.limits.maxAiCreditsPerSession) &&
    config.limits.maxAiCreditsPerSession >= 30,
  'Local Agency requires maxAiCreditsPerSession of at least 30', 'blocked-config');
  const runtime = await startWorkerRpcServer(toolkit, dependencies.rpcOptions);
  const directory = resolve(config.stateDirectory, 'agency-local', current.session_id);
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'agency.toml'),
    `[profiles."${provider.profile}"]\n`, { mode: 0o600 });
  const mcpConfigPath = join(directory, 'mcp-config.json');
  const usagePath = join(directory, `usage-round-${authoring.round}.json`);
  const finalizationUsagePath = join(directory,
    `usage-round-${authoring.round}-finalization.json`);
  writeFileSync(mcpConfigPath, json({
    mcpServers: {
      pilot: {
        type: 'stdio',
        command: process.execPath,
        args: [bridgePath],
        cwd: dirname(bridgePath),
        tools: ['*']
      }
    }
  }), { mode: 0o600 });
  const env = {
    ...process.env,
    PILOT_MCP_ENDPOINT: runtime.endpoint,
    PILOT_MCP_TOKEN: runtime.token
  };
  try {
    const launch = dependencies.launch ?? launchAgency;
    const options = {
      cwd: directory,
      env,
      timeoutMs: positive(config.limits.workerMinutes, 'workerMinutes') * 60000
    };
    await launch(
      provider.executable,
      agencyArguments(config, provider, current, authoring, mcpConfigPath, usagePath),
      { ...options, prompt });
    if (!toolkit.proposal) {
      await launch(
        provider.executable,
        agencyArguments(config, provider, current, {
          ...authoring,
          round: Math.max(1, authoring.round)
        }, mcpConfigPath, finalizationUsagePath),
        {
          ...options,
          prompt: 'Your previous Agency turn ended without pilot_finish. Do not restart broad investigation. ' +
            'Use the existing session context and workspace state. If that context already identifies a concrete ' +
            'mechanical defect in files you authored, correct it with the bounded tools; otherwise do not edit further. ' +
            'Then call pilot_finish exactly once. ' +
            'The controller accepts no final prose and will block the assignment if pilot_finish is omitted.'
        });
    }
    requireThat(toolkit.proposal, 'Agency ended without pilot_finish', 'blocked-result');
  } finally {
    await runtime.close();
  }
}
