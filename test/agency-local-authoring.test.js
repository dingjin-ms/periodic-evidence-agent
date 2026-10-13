import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { connect } from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { createInterface } from 'node:readline';
import { configAt, PilotError } from '../src/common.js';
import {
  agencyArguments, launchAgency, runAgencyLocal, startWorkerRpcServer
} from '../src/agency-local-authoring.js';
import { workerToolCliNames, workerToolNames } from '../src/worker-tool-contract.js';

function rpc(endpoint, token, tool, args = {}) {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let output = '';
    socket.setEncoding('utf8');
    socket.on('connect', () =>
      socket.end(`${JSON.stringify({ id: 'test-request', token, tool, args })}\n`));
    socket.on('data', chunk => { output += chunk; });
    socket.on('error', reject);
    socket.on('close', () => {
      try { resolve(JSON.parse(output.trim())); }
      catch (error) { reject(error); }
    });
  });
}

test('Agency arguments expose only pilot MCP tools and resume the exact session', () => {
  const config = {
    stateDirectory: '.state',
    limits: { maxAiCreditsPerSession: 3 }
  };
  const provider = { profile: 'periodic-evidence-isolated' };
  const current = { session_id: '11111111-1111-4111-8111-111111111111', workspace: 'C:\\fixture' };
  const first = agencyArguments(config, provider, current, { round: 0 }, 'mcp.json', 'usage.json');
  const repair = agencyArguments(config, provider, current, { round: 1 }, 'mcp.json', 'usage.json');
  assert.deepEqual(first.slice(0, 11), [
    '--no-aec', '--log-dir', resolve(config.stateDirectory, 'agency-local-logs'),
    'copilot', '--session-id', current.session_id,
    '--profile-only', provider.profile, '--no-default-mcps', '--no-config-plugins', '--'
  ]);
  assert.equal(first[first.indexOf('--available-tools') + 1],
    workerToolCliNames.join(','));
  assert.ok(first.includes('--allow-all-tools'));
  assert.ok(first.includes('--disable-builtin-mcps'));
  assert.ok(first.includes('--no-custom-instructions'));
  assert.ok(first.includes('--no-ask-user'));
  assert.ok(!first.includes('--resume'));
  assert.deepEqual(repair.slice(-2), ['--resume', current.session_id]);
  assert.ok(!first.some(value => /shell|powershell|github-mcp-server|workiq/i.test(value)));
});

test('controller RPC authenticates, validates and forwards only bounded pilot tools', async t => {
  const calls = [];
  let finished = false;
  const toolkit = {
    list: async path => {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
      return [path ? `${path}/value.js` : 'src/value.js'];
    },
    search: async (query, path) => ({ query, path }),
    read: (path, start, end) => ({ path, start, end }),
    write: (path, content) => {
      calls.push({ path, content });
      return 'written';
    },
    finish: proposal => {
      if (finished) throw new PilotError('blocked-result', 'Proposal already submitted');
      finished = true;
      return proposal.outcome;
    }
  };
  const runtime = await startWorkerRpcServer(toolkit);
  t.after(() => runtime.close());
  assert.deepEqual(await rpc(runtime.endpoint, runtime.token, 'pilot_list'), {
    id: 'test-request', ok: true, result: ['src/value.js']
  });
  assert.deepEqual(await rpc(runtime.endpoint, runtime.token, 'pilot_list', {
    path: 'test'
  }), {
    id: 'test-request', ok: true, result: ['test/value.js']
  });
  assert.equal((await rpc(runtime.endpoint, runtime.token, 'pilot_write', {
    path: 'test/value.test.js', content: 'test'
  })).ok, true);
  assert.deepEqual(calls, [{ path: 'test/value.test.js', content: 'test' }]);
  assert.equal((await rpc(runtime.endpoint, 'wrong-token', 'pilot_list')).error.code,
    'blocked-protocol');
  assert.equal((await rpc(runtime.endpoint, runtime.token, 'shell', {})).error.code,
    'blocked-protocol');
  assert.equal((await rpc(runtime.endpoint, runtime.token, 'pilot_list', {
    unexpected: true
  })).error.code, 'blocked-protocol');
  assert.equal((await rpc(runtime.endpoint, runtime.token, 'pilot_finish', {
    outcome: 'investigated', findings: 'done'
  })).ok, true);
  assert.equal((await rpc(runtime.endpoint, runtime.token, 'pilot_finish', {
    outcome: 'investigated', findings: 'again'
  })).error.code, 'blocked-result');
});

test('stdio MCP bridge advertises and invokes only the controller pilot tools', async t => {
  const toolkit = {
    list: async path => {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 20));
      return [path ? `${path}/value.js` : 'src/value.js'];
    },
    search: async () => {
      await new Promise(resolveDelay => setTimeout(resolveDelay, 10));
      return ['src/value.js:1:value'];
    },
    read: () => 'value',
    write: () => 'written',
    finish: () => 'accepted'
  };
  const runtime = await startWorkerRpcServer(toolkit);
  const bridge = spawn(process.execPath, [
    new URL('../src/agency-mcp-bridge.js', import.meta.url).pathname.slice(1)
  ], {
    env: {
      ...process.env,
      PILOT_MCP_ENDPOINT: runtime.endpoint,
      PILOT_MCP_TOKEN: runtime.token
    },
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true
  });
  const lines = createInterface({ input: bridge.stdout, crlfDelay: Infinity });
  const pending = new Map();
  lines.on('line', line => {
    const response = JSON.parse(line);
    pending.get(response.id)?.(response);
    pending.delete(response.id);
  });
  t.after(async () => {
    lines.close();
    bridge.kill();
    await runtime.close();
  });
  const request = message => new Promise(resolveResponse => {
    pending.set(message.id, resolveResponse);
    bridge.stdin.write(`${JSON.stringify(message)}\n`);
  });
  const initialized = await request({
    jsonrpc: '2.0', id: 1, method: 'initialize',
    params: { protocolVersion: '2025-06-18' }
  });
  assert.equal(initialized.result.serverInfo.name, 'periodic-evidence-pilot');
  const listed = await request({ jsonrpc: '2.0', id: 2, method: 'tools/list' });
  assert.deepEqual(listed.result.tools.map(tool => tool.name), workerToolNames);
  const called = await request({
    jsonrpc: '2.0', id: 3, method: 'tools/call',
    params: { name: 'pilot_list', arguments: {} }
  });
  assert.equal(called.result.content[0].text, '["src/value.js"]');
  const concurrent = await Promise.all([
    request({
      jsonrpc: '2.0', id: 31, method: 'tools/call',
      params: { name: 'pilot_list', arguments: { path: 'test' } }
    }),
    request({
      jsonrpc: '2.0', id: 32, method: 'tools/call',
      params: { name: 'pilot_search', arguments: { query: 'value' } }
    }),
    request({
      jsonrpc: '2.0', id: 33, method: 'tools/call',
      params: { name: 'pilot_read', arguments: { path: 'src/value.js' } }
    })
  ]);
  assert.deepEqual(concurrent.map(response => response.id).sort(), [31, 32, 33]);
  assert.equal(concurrent.every(response => response.result.isError !== true), true);
  const denied = await request({
    jsonrpc: '2.0', id: 4, method: 'tools/call',
    params: { name: 'shell', arguments: {} }
  });
  assert.equal(denied.result.isError, true);
});

test('configuration keeps SDK default and validates explicit Agency providers', t => {
  const root = mkdtempSync(join(tmpdir(), 'agency-config-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const base = JSON.parse(JSON.stringify(configAt('pilot.example.json')));
  const validPath = join(root, 'valid.json');
  base.stateDirectory = '.state';
  base.authoringProviders = {
    'agency-oa': {
      type: 'agency-local',
      executable: process.execPath,
      profile: 'periodic-evidence-isolated'
    }
  };
  base.limits.maxAiCreditsPerSession = 30;
  base.repositories[2].skillBindings[0].authoringProvider = 'agency-oa';
  writeFileSync(validPath, JSON.stringify(base));
  const valid = configAt(validPath);
  assert.equal(valid.repositories[2].skillBindings[0].authoringProvider, 'agency-oa');

  const invalidPath = join(root, 'invalid.json');
  base.repositories[2].skillBindings[0].authoringProvider = 'missing';
  writeFileSync(invalidPath, JSON.stringify(base));
  assert.throws(() => configAt(invalidPath), /unknown authoring provider/);
});

test('Local Agency requires pilot_finish even after a successful process exit', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agency-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = {
    stateDirectory: relative(process.cwd(), join(root, 'state')),
    limits: { workerMinutes: 1, maxAiCreditsPerSession: 30 }
  };
  const current = {
    session_id: '22222222-2222-4222-8222-222222222222',
    workspace: root
  };
  const provider = {
    executable: process.execPath,
    profile: 'periodic-evidence-isolated'
  };
  const toolkit = {
    proposal: null,
    list: async () => [],
    search: async () => [],
    read: () => '',
    write: () => 'written',
    finish(proposal) {
      this.proposal = proposal;
      return 'accepted';
    }
  };
  const launches = [];
  await assert.rejects(runAgencyLocal(
    config, current, toolkit, 'prompt', provider, { round: 0 },
    {
      launch: async (executable, args, options) => {
        launches.push({ executable, args, options });
        return { stdout: 'final prose', stderr: '' };
      }
    }
  ), /without pilot_finish/);
  assert.equal(launches.length, 2);
  assert.equal(launches[0].options.prompt, 'prompt');
  assert.deepEqual(launches[1].args.slice(-2), ['--resume', current.session_id]);
  assert.match(launches[1].options.prompt, /call pilot_finish exactly once/);
});

test('Local Agency resumes the exact session once to finalize an authored result', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agency-finalize-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = {
    stateDirectory: relative(process.cwd(), join(root, 'state')),
    limits: { workerMinutes: 1, maxAiCreditsPerSession: 30 }
  };
  const current = {
    session_id: '23232323-2323-4232-8232-232323232323',
    workspace: root
  };
  const provider = {
    executable: process.execPath,
    profile: 'periodic-evidence-isolated'
  };
  const toolkit = {
    proposal: null,
    list: async () => [],
    search: async () => [],
    read: () => '',
    write: () => 'written',
    finish(proposal) {
      this.proposal = proposal;
      return 'accepted';
    }
  };
  let launches = 0;
  await runAgencyLocal(config, current, toolkit, 'author', provider, { round: 0 }, {
    launch: async (executable, args, options) => {
      launches++;
      if (launches === 1) return { stdout: '', stderr: '' };
      assert.deepEqual(args.slice(-2), ['--resume', current.session_id]);
      const result = await rpc(options.env.PILOT_MCP_ENDPOINT,
        options.env.PILOT_MCP_TOKEN, 'pilot_finish', {
          outcome: 'investigated',
          findings: 'Finalized through the exact resumed session'
        });
      assert.equal(result.ok, true);
      return { stdout: '', stderr: '' };
    }
  });
  assert.equal(launches, 2);
  assert.equal(toolkit.proposal.findings, 'Finalized through the exact resumed session');
});

test('Local Agency accepts only a proposal delivered through its authenticated controller', async t => {
  const root = mkdtempSync(join(tmpdir(), 'agency-run-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = {
    stateDirectory: relative(process.cwd(), join(root, 'state')),
    limits: { workerMinutes: 1, maxAiCreditsPerSession: 30 }
  };
  const current = {
    session_id: '33333333-3333-4333-8333-333333333333',
    workspace: root
  };
  const provider = {
    executable: process.execPath,
    profile: 'periodic-evidence-isolated'
  };
  const toolkit = {
    proposal: null,
    list: async () => [],
    search: async () => [],
    read: () => '',
    write: () => 'written',
    finish(proposal) {
      this.proposal = proposal;
      return 'accepted';
    }
  };
  await runAgencyLocal(config, current, toolkit, 'prompt', provider, { round: 0 }, {
    launch: async (executable, args, options) => {
      assert.equal(executable, process.execPath);
      assert.equal(options.prompt, 'prompt');
      assert.equal(options.cwd, resolve(config.stateDirectory, 'agency-local', current.session_id));
      assert.equal(readFileSync(join(options.cwd, 'agency.toml'), 'utf8'),
        `[profiles."${provider.profile}"]\n`);
      const mcpConfig = args[args.indexOf('--additional-mcp-config') + 1].slice(1);
      const logDirectory = args[args.indexOf('--log-dir') + 1];
      assert.equal(isAbsolute(mcpConfig), true);
      assert.equal(existsSync(mcpConfig), true);
      assert.equal(isAbsolute(logDirectory), true);
      const result = await rpc(options.env.PILOT_MCP_ENDPOINT,
        options.env.PILOT_MCP_TOKEN, 'pilot_finish', {
          outcome: 'investigated',
          findings: 'Controller-authenticated result'
        });
      assert.equal(result.ok, true);
      return { stdout: '', stderr: '' };
    }
  });
  assert.equal(toolkit.proposal.findings, 'Controller-authenticated result');
});

test('Agency process failures and timeouts fail closed', async () => {
  await assert.rejects(launchAgency(process.execPath, ['-e', 'process.exit(7)'], {
    cwd: process.cwd(), env: process.env, timeoutMs: 5000, prompt: ''
  }), /code=7/);
  await assert.rejects(launchAgency(process.execPath, [
    '-e', 'setTimeout(() => {}, 10000)'
  ], {
    cwd: process.cwd(), env: process.env, timeoutMs: 50, prompt: ''
  }), /without a successful result/);
});

test('Local Agency enforces the CLI minimum credit ceiling', async () => {
  await assert.rejects(runAgencyLocal({
    stateDirectory: 'C:\\state',
    limits: { workerMinutes: 1, maxAiCreditsPerSession: 29 }
  }, {
    session_id: '44444444-4444-4444-8444-444444444444',
    workspace: process.cwd()
  }, {}, 'prompt', {
    executable: process.execPath,
    profile: 'periodic-evidence-isolated'
  }, {
    round: 0,
    validationFeedback: []
  }), /at least 30/);
});
