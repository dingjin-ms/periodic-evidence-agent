import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { command, minimalEnvironment, localProposerEnvironment } from '../src/workers.js';
import { defineTool, restrictedSession } from '../src/runtime.js';
import { ToolSet, defineTool as sdkDefineTool } from '@github/copilot-sdk';
import { AzureCliCredential } from '@azure/identity';
import { adoAccessToken } from '../src/ado-auth.js';
import { adoTransport } from '../src/sources.js';
import { teamsArmToken } from '../src/teams-notifications.js';

const names = ['COPILOT_GITHUB_TOKEN', 'GH_TOKEN', 'GITHUB_TOKEN'];
const synthetic = Object.fromEntries(names.map(name => [name, `synthetic-${name}`]));

test('offline CLI and validation worker bootstrap do not resolve unused service SDKs or compile FILTER schemas', async t => {
  const root = mkdtempSync(join(tmpdir(), 'offline-sdk-bootstrap-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const preload = join(root, 'reject-sdk.mjs');
  writeFileSync(preload, `
import { registerHooks } from 'node:module';
import Ajv2020 from ${JSON.stringify(new URL('../node_modules/ajv/dist/2020.js', import.meta.url).href)};
Ajv2020.prototype.compile = () => { throw new Error('unused-filter-schema-bootstrap'); };
registerHooks({ resolve(specifier, context, nextResolve) {
  if (['@github/copilot-sdk', '@azure/identity'].includes(specifier))
    throw new Error('unused-service-sdk-bootstrap');
  return nextResolve(specifier, context);
} });
`);
  for (const args of [
    [fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'help'],
    ['--input-type=module', '-e',
      `await import(${JSON.stringify(new URL('../src/workers.js', import.meta.url).href)});`],
    ['--input-type=module', '-e',
      `await import(${JSON.stringify(new URL('../src/teams-notifications.js', import.meta.url).href)});`]
  ]) {
    await command(process.execPath, ['--import', pathToFileURL(preload).href, ...args],
      process.cwd(), 10000, minimalEnvironment());
  }
});

test('deferred Azure credentials preserve delegated scopes and reject identity drift before transport', async t => {
  const identity = { tenantId: '00000000-0000-4000-8000-000000000001',
    objectId: '00000000-0000-4000-8000-000000000002' };
  const teams = { enabled: true, identity, teamId: identity.tenantId,
    channelId: '19:fixture@thread.tacv2',
    workflowResourceId: `/subscriptions/${identity.tenantId}/resourceGroups/fixture/providers/Microsoft.Logic/workflows/fixture` };
  const scopes = [];
  let mismatch = false, requests = 0;
  t.mock.method(AzureCliCredential.prototype, 'getToken', async scope => {
    scopes.push(scope);
    return { token: `synthetic.${Buffer.from(JSON.stringify({
      tid: identity.tenantId, oid: mismatch ? 'wrong-user' : identity.objectId
    })).toString('base64url')}.synthetic` };
  });
  t.mock.method(globalThis, 'fetch', async () => {
    requests++;
    return { ok: true, json: async () => ({ workItems: [] }) };
  });
  await adoAccessToken({ identity }, 'Synthetic fixture');
  const transport = await adoTransport({ identity });
  assert.deepEqual(await transport('wiql', { query: 'Synthetic fixture' }), { workItems: [] });
  await teamsArmToken(teams);
  assert.deepEqual(scopes, ['499b84ac-1321-427f-aa17-267ca6975798/.default',
    '499b84ac-1321-427f-aa17-267ca6975798/.default', 'https://management.azure.com/.default']);
  mismatch = true;
  await assert.rejects(adoAccessToken({ identity }, 'Synthetic fixture'), { code: 'blocked-auth' });
  await assert.rejects(transport('wiql', {}), { code: 'blocked-auth' });
  await assert.rejects(teamsArmToken(teams), { code: 'blocked-auth' });
  assert.equal(requests, 1, 'identity drift must never reach source transport');
});

test('deferred SDK factories retain the ESM ToolSet identity and actual tool definitions', () => {
  const options = { description: 'Synthetic tool', parameters: {
    type: 'object', properties: {}, additionalProperties: false
  }, handler: () => 'fixture' };
  assert.deepEqual(defineTool('fixture', options), sdkDefineTool('fixture', options));
  const session = restrictedSession([{ name: 'fixture' }]);
  assert.ok(session.availableTools instanceof ToolSet);
  assert.deepEqual(session.availableTools.toArray(), ['custom:fixture']);
  assert.equal(session.hooks.onPreToolUse({ toolName: 'powershell' }).permissionDecision, 'deny');
});

test('local proposer forwards only documented model credentials without changing native filtering', () => {
  const source = { PATH: 'synthetic-path', ...synthetic, COPILOT_HMAC_KEY: 'not-forwarded',
    PILOT_OA_PACKAGE_TOKEN: 'not-forwarded', UNRELATED_SECRET: 'not-forwarded',
    COPILOT_HOME: 'not-forwarded', NODE_OPTIONS: 'not-forwarded' };
  assert.deepEqual(localProposerEnvironment(source), { PATH: source.PATH, ...synthetic });
  assert.deepEqual(minimalEnvironment(source), { PATH: source.PATH });
  assert.deepEqual(localProposerEnvironment({ GH_TOKEN: '', GITHUB_TOKEN: undefined }), {});
  assert.equal(source.UNRELATED_SECRET, 'not-forwarded');
});

test('filtered proposer child passes synthetic credentials through the real SDK to its runtime child', async t => {
  const root = mkdtempSync(join(tmpdir(), 'proposer-sdk-env-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const output = join(root, 'runtime-observation.json');
  const runtime = join(root, 'synthetic-runtime.js');
  const controller = join(root, 'controller.mjs');
  const state = join(root, 'state');
  writeFileSync(runtime, `
const fs = require('node:fs');
const expected = ${JSON.stringify(synthetic)};
fs.writeFileSync(${JSON.stringify(output)}, JSON.stringify({
  matches: Object.fromEntries(Object.entries(expected).map(([name, value]) => [name, process.env[name] === value])),
  unrelatedAbsent: !process.env.UNRELATED_SECRET && !process.env.PILOT_OA_PACKAGE_TOKEN,
  privateHome: process.env.COPILOT_HOME === ${JSON.stringify(join(state, 'runtime'))},
  keytarDisabled: process.env.COPILOT_DISABLE_KEYTAR === '1',
  args: process.argv.slice(2)
}));
process.exit(1);
`);
  writeFileSync(controller, `
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { createClient } from ${JSON.stringify(new URL('../src/runtime.js', import.meta.url).href)};
const client = createClient({
  runtime: { cliPath: ${JSON.stringify(runtime)} },
  limits: { maxAiCreditsPerSession: 100 },
  stateDirectory: ${JSON.stringify(state)}
}, ${JSON.stringify(root)});
try {
  await assert.rejects(client.start());
  assert.ok(existsSync(${JSON.stringify(output)}));
} finally { await client.stop(); }
`);
  await command(process.execPath, [controller], root, 30000,
    localProposerEnvironment({ ...minimalEnvironment(), ...synthetic,
      UNRELATED_SECRET: 'synthetic-excluded', PILOT_OA_PACKAGE_TOKEN: 'synthetic-excluded' }));
  const observation = JSON.parse(readFileSync(output));
  assert.deepEqual(observation.matches, Object.fromEntries(names.map(name => [name, true])));
  assert.equal(observation.unrelatedAbsent, true);
  assert.equal(observation.privateHome, true);
  assert.equal(observation.keytarDisabled, true);
  assert.deepEqual(observation.args.slice(0, 2), ['--max-ai-credits', '100']);
  assert.equal(observation.args.includes('--no-auto-login'), false);
  assert.equal(observation.args.some(arg => Object.values(synthetic).includes(arg)), false);

  const native = await command(process.execPath, ['-e',
    `console.log(JSON.stringify(${JSON.stringify(names)}.map(name => Boolean(process.env[name]))))`],
  root, 10000, minimalEnvironment(localProposerEnvironment({ ...minimalEnvironment(), ...synthetic })));
  assert.deepEqual(JSON.parse(native.stdout), [false, false, false]);
});
