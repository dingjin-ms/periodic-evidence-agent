import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAt, json } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import { skillQualificationId } from '../src/repository-skills.js';
import { runTestRequest, runTestRequestQueue } from '../src/test-request-flow.js';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'request-flow-'));
  const config = configAt('pilot.example.json');
  const policy = JSON.parse(readFileSync('scaffold/ado-test-request.policy.example.json'));
  config.executionMode = 'standalone-sdk';
  config.stateDirectory = root; config.statePolicy.accessApproved = true; config.activation.review = true;
  config.limits.maxAiCreditsPerSession = 30;
  config.filterExecutor = 'local-sdk';
  const revision = 'a'.repeat(40);
  config.localFilter = { enabled: true, maxRequests: 2, maxToolCalls: 12, timeoutMs: 10000,
    maxSourceBytes: 12000, maxRequestBytes: 100000, acceptSoftCreditLimit: true, sources: [{ repoId: policy.repoId, revision }] };
  config.adoTestRequests = { ...policy, enabled: true, scopeApproved: true, approvalRef: 'fixture',
    feedback: { enabled: true, scopeApproved: true, approvalRef: 'fixture-feedback' },
    automation: { enabled: true, scopeApproved: true, approvalRef: 'fixture-flow', maxRequests: 2, model: 'fixture-model', sourcePaths: ['src'] } };
  const repo = config.repositories.find(repo => repo.id === policy.repoId);
  repo.routingApproved = true; repo.owner = 'fixture'; repo.referenceCheckout = root;
  const binding = repo.skillBindings.find(binding => binding.capability === policy.capability);
  binding.enabled = true; binding.qualification = 'qualified';
  repo.allowedWritePrefixes = binding.allowedWritePrefixes; repo.allowedWriteFiles = binding.allowedWriteFiles ?? [];
  const ledger = new Ledger(root);
  ledger.qualify(skillQualificationId(repo.id, binding.id), { baseRevision: revision });
  const item = { id: 123, rev: 1, snapshotAt: '2026-10-01T00:00:00Z', fields: {
    'System.TeamProject': 'OC', 'System.AreaPath': policy.areaPath, 'System.WorkItemType': 'Bug',
    'System.State': 'New', 'System.Tags': policy.tag, 'System.Title': 'Synthetic request',
    'System.CreatedDate': '2026-10-01T00:00:00Z', 'System.Description': readFileSync('scaffold/ado-test-request.sample.md', 'utf8')
  } };
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return { config, ledger, item, calls: 0, comments: 0, read: async () => item };
}
function dependencies(ctx, { decision = 'blocked-environment', crash = false, incomplete = false } = {}) {
  return { read: ctx.read, execute: async () => ({ stdout: incomplete ? 'x'.repeat(30000) : 'export const supported = false;\n' }),
    feedback: { getToken: async () => 'fixture', fetchResponse: async (_url, options) => {
      ctx.comments++; assert.equal(options.redirect, 'error');
      assert.match(JSON.parse(options.body).text, /holding this test request/);
      return Response.json({ id: 1, workItemId: 123 });
    } },
    connect: async (_config, _cwd, action) => {
      ctx.calls++;
      return action({ createSession: async options => {
        let onEvent;
        return { sessionId: 'fixture-session', on: callback => { onEvent = callback; return () => {}; },
          rpc: { options: { update: async () => {} }, tools: { initializeAndValidate: async () => {} } },
          sendAndWait: async () => {
            onEvent({ type: 'assistant.turn_start' });
            if (crash) throw new Error('interrupted');
            const source = options.tools.find(tool => tool.name === 'pilot_request_source');
            const denied = JSON.parse(await source.handler({ action: 'read', path: '../secret' }));
            assert.ok(denied.error);
            const page = JSON.parse(await source.handler({ action: 'read', path: 'src/verifier.js' }));
            assert.equal(page.revision, 'a'.repeat(40));
            const finish = options.tools.find(tool => tool.name === 'pilot_request_finish');
            const result = JSON.parse(await finish.handler({ decision, missingCapabilities: [], sourcePaths: ['src/verifier.js'],
              rationale: 'The test environment cannot read protected workbooks.', verificationEvidence: [], handoff: null }));
            assert.equal(Boolean(result.error), incomplete);
          }, disconnect: async () => {} };
      } });
    } };
}

test('one command collects, runs FILTER, records a hold and comments once; replay launches nothing', async t => {
  const ctx = setup(t), deps = dependencies(ctx);
  const options = { authorizeReview: true, authorizeComment: true };
  const first = await runTestRequest(ctx.config, ctx.ledger, 123, options, deps);
  assert.equal(first.state, 'blocked-environment'); assert.equal(first.feedback.state, 'commented');
  const second = await runTestRequest(ctx.config, ctx.ledger, 123, options, deps);
  assert.equal(second.replayed, true); assert.equal(ctx.calls, 1); assert.equal(ctx.comments, 1);
  assert.equal(ctx.ledger.all('assignment').length, 0);
});

test('system feedback revision changes reuse a hold without another model or comment', async t => {
  const ctx = setup(t), deps = dependencies(ctx);
  const options = { authorizeReview: true, authorizeComment: true };
  await runTestRequest(ctx.config, ctx.ledger, 123, options, deps);
  ctx.item.rev++;
  const replay = await runTestRequest(ctx.config, ctx.ledger, 123, options, deps);
  assert.equal(replay.priorOutcomeOnly, true);
  assert.equal(replay.observedRevision, '2');
  assert.deepEqual([ctx.calls, ctx.comments], [1, 1]);
  ctx.item.rev++;
  ctx.item.fields['System.Description'] += '<p>Changed request.</p>';
  await runTestRequest(ctx.config, ctx.ledger, 123, options, deps);
  assert.deepEqual([ctx.calls, ctx.comments], [2, 2]);
});

test('interrupted model attempt cannot be relaunched', async t => {
  const ctx = setup(t), deps = dependencies(ctx, { crash: true });
  await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps), /interrupted/);
  await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps), /incomplete or uncertain/);
  assert.equal(ctx.calls, 1);
});

test('incomplete source reads cannot create an accepted assessment', async t => {
  const ctx = setup(t);
  await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, dependencies(ctx, { incomplete: true })), /did not complete/);
  assert.equal(ctx.ledger.status().operations.filter(row => row.kind === 'ado-test-request-capability').length, 0);
});

test('model invocation and publication require independent explicit grants', async t => {
  const ctx = setup(t), deps = dependencies(ctx);
  await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, {}, deps), /model-review authorization/);
  await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true, execute: true }, deps), /separate commit/);
  assert.equal(ctx.calls, 0); assert.equal(ctx.comments, 0);
});

test('changed configuration cannot create a second model attempt for the same intake', async t => {
  const ctx = setup(t), deps = dependencies(ctx);
  await runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps);
  ctx.config.localFilter.maxToolCalls++;
  await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps), /different pins/);
  assert.equal(ctx.calls, 1);
});

test('bounded queue tick discovers requests and reuses their completion receipts', async t => {
  const ctx = setup(t), deps = { ...dependencies(ctx), discover: async () => ({ ids: [123], snapshotAt: '2026-10-01T00:00:00Z' }) };
  const result = await runTestRequestQueue(ctx.config, ctx.ledger, { authorizeReview: true }, deps);
  assert.equal(result.results[0].workItemId, 123);
  await runTestRequestQueue(ctx.config, ctx.ledger, { authorizeReview: true }, deps);
  assert.equal(ctx.calls, 1);
});

test('post-finish session failure does not activate a capability assessment', async t => {
  const ctx = setup(t), deps = dependencies(ctx), connect = deps.connect;
  deps.connect = async (...args) => { await connect(...args); throw new Error('disconnect failed'); };
  await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps), /disconnect failed/);
  assert.equal(ctx.ledger.status().operations.filter(row => row.kind === 'ado-test-request-capability').length, 0);
});

test('request-scoped ledger lock excludes concurrent review before source calls', async t => {
  const ctx = setup(t), deps = dependencies(ctx);
  const name = 'ado-request-flow:office:OC:123', owner = ctx.ledger.acquire(name);
  await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps));
  ctx.ledger.release(name, owner); assert.equal(ctx.calls, 0);
});
