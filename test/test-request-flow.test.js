import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAt, json, hash } from '../src/common.js';
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
  binding.enabled = true; binding.qualification = 'qualified'; binding.skillPath = 'src/verifier.js';
  repo.allowedWritePrefixes = binding.allowedWritePrefixes; repo.allowedWriteFiles = binding.allowedWriteFiles ?? [];
  const ledger = new Ledger(root);
  ledger.qualify(skillQualificationId(repo.id, binding.id), { baseRevision: revision, skillPath: binding.skillPath,
    skillSha256: hash('export const supported = false;\n') });
  const item = { id: 123, rev: 1, snapshotAt: '2026-10-01T00:00:00Z', fields: {
    'System.TeamProject': 'OC', 'System.AreaPath': policy.areaPath, 'System.WorkItemType': 'Bug',
    'System.State': 'New', 'System.Tags': policy.tag, 'System.Title': 'Synthetic request',
    'System.CreatedDate': '2026-10-01T00:00:00Z', 'System.Description': readFileSync('scaffold/ado-test-request.sample.md', 'utf8')
  } };
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return { config, ledger, item, calls: 0, comments: 0, read: async () => item };
}
function dependencies(ctx, { decision = 'blocked-environment', crash = false, incomplete = false, support, rejectedFinish = false } = {}) {
  let sourceCalls = 0;
  return { read: ctx.read, execute: async () => ({ stdout: incomplete && sourceCalls++ > 0 ? 'x'.repeat(30000) : 'export const supported = false;\n' }),
    feedback: { getToken: async () => 'fixture', fetchResponse: async (_url, options) => {
      ctx.comments++; assert.equal(options.redirect, 'error');
      assert.match(JSON.parse(options.body).text, /holding this test request/);
      return Response.json({ id: 1, workItemId: 123 });
    } },
    connect: async (_config, _cwd, action) => {
      ctx.calls++;
      return action({ createSession: async options => {
        ctx.sessionOptions = options;
        let onEvent;
        return { sessionId: 'fixture-session', on: callback => { onEvent = callback; return () => {}; },
          rpc: { options: { update: async () => {} }, tools: { initializeAndValidate: async () => {} } },
          sendAndWait: async (payload, timeout) => {
            ctx.payload = payload; ctx.timeout = timeout;
            onEvent({ type: 'assistant.turn_start' });
            if (crash) throw new Error('interrupted');
            const source = options.tools.find(tool => tool.name === 'pilot_request_source');
            const denied = JSON.parse(await source.handler({ action: 'read', path: '../secret' }));
            assert.ok(denied.error);
            const page = JSON.parse(await source.handler({ action: 'read', path: 'src/verifier.js' }));
            assert.equal(page.revision, 'a'.repeat(40));
            const finish = options.tools.find(tool => tool.name === 'pilot_request_finish');
            const result = JSON.parse(await finish.handler({ decision, missingCapabilities: [], sourcePaths: ['src/verifier.js'],
              rationale: 'The test environment cannot read protected workbooks.', verificationEvidence: [], handoff: null,
              ...(support ? { support } : {}) }));
            assert.equal(Boolean(result.error), incomplete || rejectedFinish);
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

test('ordinary request automation cannot bypass upstream generated-case approval', async t => {
  const ctx = setup(t), deps = dependencies(ctx);
  ctx.item.fields['System.Description'] += '<p>GeneratedCaseOrigin:untrusted-marker</p>';
  await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps),
    /trusted local lineage/);
  assert.equal(ctx.calls, 0);
  assert.equal(ctx.ledger.all('assignment').length, 0);
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

test('parallel source reads keep unique receipt IDs and finish waits for delivery', async t => {
  const ctx = setup(t), deps = dependencies(ctx);
  deps.connect = async (_config, _cwd, action) => action({ createSession: async options => {
    let event;
    return { sessionId: 'parallel-source-session', on: fn => { event = fn; return () => {}; },
      rpc: { options: { update: async () => {} }, tools: { initializeAndValidate: async () => {} } },
      sendAndWait: async () => {
        event({ type: 'assistant.turn_start' });
        const source = options.tools.find(tool => tool.name === 'pilot_request_source');
        const finish = options.tools.find(tool => tool.name === 'pilot_request_finish');
        const submission = { decision: 'blocked-environment', missingCapabilities: [],
          sourcePaths: ['src/one.js', 'src/two.js'], rationale: 'Fixture environment unavailable.', verificationEvidence: [], handoff: null };
        const reads = ['src/one.js', 'src/two.js'].map(path => source.handler({ action: 'read', path }));
        assert.match(JSON.parse(await finish.handler(submission)).error.message, /outstanding source reads/);
        for (const response of await Promise.all(reads)) assert.equal(JSON.parse(response).error, undefined);
        assert.equal(JSON.parse(await finish.handler(submission)).error, undefined);
      }, disconnect: async () => {} };
  } });
  await runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps);
  const reads = ctx.ledger.status().operations.filter(row => row.kind === 'ado-request-filter-source');
  assert.equal(reads.length, 2);
  assert.equal(new Set(reads.map(row => row.id)).size, 2);
});

test('unknown environment is retained as unknown and a support-only assessment does not publish', async t => {
  const ctx = setup(t);
  ctx.config.adoTestRequests.automation.requireSupportMatrix = true;
  const support = { skill: 'supported', environment: 'unknown', requirements: [{
    requirement: 'Count saved rows', status: 'supported', sourcePaths: ['src/verifier.js'],
    reason: 'The assertion is expressible; execution environment has not been qualified.'
  }] };
  const deps = dependencies(ctx, { decision: 'supported', support });
  const result = await runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps);
  assert.equal(result.support.environment, 'unknown');
  assert.equal(result.state, 'supported');
  assert.equal(result.publication, 'none');
  assert.equal(ctx.ledger.all('assignment').length, 0);
  assert.equal(ctx.comments, 0);
  const replay = await runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps);
  assert.equal(replay.replayed, true);
  assert.equal(ctx.calls, 1);
  await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123,
    { authorizeReview: true, execute: true }, deps), { code: 'blocked-authorization' });
  assert.equal(ctx.calls, 1);
});

test('skill support is distinct from a blocked evidence environment', async t => {
  const ctx = setup(t);
  ctx.config.adoTestRequests.automation.requireSupportMatrix = true;
  const support = { skill: 'supported', environment: 'blocked', requirements: [{
    requirement: 'Count saved rows', status: 'supported', sourcePaths: ['src/verifier.js'], reason: 'Reader supports the assertion; credential access is unavailable.'
  }] };
  const result = await runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, dependencies(ctx, { support }));
  assert.equal(result.support.skill, 'supported'); assert.equal(result.support.environment, 'blocked');
  assert.equal(result.state, 'blocked-environment'); assert.equal(ctx.ledger.all('assignment').length, 0);
});

for (const condition of ['missing-matrix', 'unknown-requirement', 'blocked-dispatch', 'unread-citation']) {
  test(`support assessment rejects ${condition}`, async t => {
    const ctx = setup(t);
    ctx.config.adoTestRequests.automation.requireSupportMatrix = true;
    const support = { skill: 'supported', environment: 'blocked', requirements: [{
      requirement: 'Count saved rows', status: condition === 'unknown-requirement' ? 'unknown' : 'supported',
      sourcePaths: [condition === 'unread-citation' ? 'src/unread.js' : 'src/verifier.js'], reason: 'Fixture source.'
    }] };
    const deps = dependencies(ctx, { support: condition === 'missing-matrix' ? undefined : support,
      decision: condition === 'blocked-dispatch' ? 'supported' : 'blocked-environment', rejectedFinish: true });
    await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps), /did not complete/);
    assert.equal(ctx.ledger.all('assignment').length, 0);
  });
}

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
function authority(ctx, { expired = false, allowModels = true } = {}) {
  const repo = ctx.config.repositories.find(r => r.id === ctx.config.adoTestRequests.repoId);
  const path = join(ctx.config.stateDirectory, 'authority.json');
  const value = { format: 'al-recurring-authorization-v1', planSha256: 'fixture-plan',
    approvedAt: new Date(Date.now() - 60000).toISOString(),
    expiresAt: new Date(Date.now() + (expired ? -1000 : 5000)).toISOString(), allowModels, allowPublication: false };
  writeFileSync(path, json(value));
  ctx.config.runtime.executionAuthorization = { repoId: repo.id, baseRevision: repo.baseRef,
    planSha256: value.planSha256, reference: { path, sha256: hash(readFileSync(path)) } };
  return path;
}
for (const denied of [{ expired: true }, { allowModels: false }]) test('execution authority rejects before reservation ' + JSON.stringify(denied), async t => {
  const ctx = setup(t); authority(ctx, denied);
  await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, dependencies(ctx)), /authorization expired or does not permit/);
  assert.equal(ctx.calls, 0);
  assert.equal(ctx.ledger.status().operations.filter(r => r.kind === 'ado-test-request-flow').length, 0);
});
test('authority caps timeout and forwards approved context tier', async t => {
  const ctx = setup(t); authority(ctx); ctx.config.localFilter.contextTier = 'long_context';
  await runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, dependencies(ctx));
  assert.ok(ctx.timeout > 0 && ctx.timeout <= 5000);
  assert.equal(ctx.sessionOptions.contextTier, 'long_context');
});
test('revocation during connection prevents session creation', async t => {
  const ctx = setup(t), path = authority(ctx); let sessions = 0;
  const deps = dependencies(ctx);
  deps.connect = async (_config, _cwd, action) => {
    writeFileSync(path, '{}');
    return action({ createSession: async () => { sessions++; throw new Error('must not create'); } });
  };
  await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps), /authorization changed/);
  assert.equal(sessions, 0);
});
test('revocation after initialization blocks submission', async t => {
  const ctx = setup(t), path = authority(ctx); let sent = 0, disconnected = 0;
  const deps = dependencies(ctx);
  deps.connect = async (_config, _cwd, action) => action({ createSession: async () => ({
    sessionId: 'revoked', on: () => () => {},
    rpc: { options: { update: async () => {} }, tools: { initializeAndValidate: async () => writeFileSync(path, '{}') } },
    sendAndWait: async () => { sent++; }, disconnect: async () => { disconnected++; }
  }) });
  await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps), /authorization changed/);
  assert.equal(sent, 0); assert.equal(disconnected, 1);
});
test('later action grants preserve accepted review without another FILTER', async t => {
  const ctx = setup(t), deps = dependencies(ctx);
  ctx.config.adoTestRequests.feedback = { enabled: false, scopeApproved: false, approvalRef: '' };
  await runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps);
  ctx.config.activation.dispatch = true;
  for (const repo of ctx.config.repositories) for (const binding of repo.skillBindings ?? [])
    binding.sideEffects = { commit: true, push: true, createDraftPR: true };
  ctx.config.adoTestRequests.feedback = { enabled: true, scopeApproved: true, approvalRef: 'later-grant' };
  const result = await runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true, authorizeComment: true }, deps);
  assert.equal(result.feedback.state, 'commented');
  assert.equal(ctx.calls, 1); assert.equal(ctx.comments, 1);
});
test('external bundle is unsupported before model or source invocation', async t => {
  const ctx = setup(t); let effects = 0;
  const repo = ctx.config.repositories.find(r => r.id === ctx.config.adoTestRequests.repoId);
  repo.execution = 'local';
  repo.skillBindings.find(b => b.capability === ctx.config.adoTestRequests.capability).externalBundle = {
    root: ctx.config.stateDirectory, source: { remote: repo.remote, revision: 'b'.repeat(40), path: 'src/verifier.js' },
    files: [{ path: 'src/verifier.js', sha256: 'c'.repeat(64) }] };
  await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, {
    read: async () => { effects++; }, connect: async () => { effects++; }, execute: async () => { effects++; }
  }), /does not support external skill bundles/);
  assert.equal(effects, 0);
});
test('unsupported context tier has no model effects', async t => {
  const ctx = setup(t); ctx.config.localFilter.contextTier = 'unapproved';
  await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, dependencies(ctx)), /context tier/);
  assert.equal(ctx.calls, 0);
});
test('complete input budget rejects schemas and instructions before reservation', async t => {
  const ctx = setup(t); ctx.config.localFilter.maxRequestBytes = 8000;
  await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, dependencies(ctx)), /complete model input budget/);
  assert.equal(ctx.calls, 0);
  assert.equal(ctx.ledger.status().operations.filter(r => r.kind === 'ado-test-request-flow').length, 0);
});
test('complete session payload has an exact pre-reservation boundary', async t => {
  const baseline = setup(t);
  await runTestRequest(baseline.config, baseline.ledger, 123, { authorizeReview: true }, dependencies(baseline));
  const sessionUpdate = { installedPlugins: [], includedBuiltinSkills: [], skipCustomInstructions: true,
    customAgentsLocalOnly: true, coauthorEnabled: false, manageScheduleEnabled: false };
  const budget = Buffer.byteLength(json({ sessionOptions: baseline.sessionOptions, sessionUpdate, payload: baseline.payload }));
  for (const delta of [-1, 0]) {
    const ctx = setup(t); ctx.config.localFilter.maxRequestBytes = budget + delta; let connected = 0;
    const deps = { ...dependencies(ctx), connect: async () => { connected++; throw new Error('boundary reached'); } };
    await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps),
      delta ? /complete model input budget/ : /boundary reached/);
    assert.equal(connected, delta ? 0 : 1);
  }
});
test('revoked authority denies source and finish callbacks before backend effects', async t => {
  const ctx = setup(t), path = authority(ctx); let reads = 0;
  const deps = dependencies(ctx); deps.execute = async () => { reads++; return { stdout: 'export const supported = false;\n' }; };
  deps.connect = async (_config, _cwd, action) => action({ createSession: async options => ({
    sessionId: 'revoked-tools', on: () => () => {},
    rpc: { options: { update: async () => {} }, tools: { initializeAndValidate: async () => {} } },
    sendAndWait: async () => {
      writeFileSync(path, '{}');
      for (const name of ['pilot_request_source', 'pilot_request_finish']) {
        const value = JSON.parse(await options.tools.find(tool => tool.name === name).handler({ action: 'read', path: 'src/verifier.js' }));
        assert.match(value.error.message ?? value.error, /authorization changed/);
      }
    }, disconnect: async () => {}
  }) });
  await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps), /authorization changed/);
  assert.equal(reads, 1); // Pinned skill delivery occurred before revocation; no callback read followed.
});
test('source pages consume a cumulative input budget', async t => {
  const ctx = setup(t); ctx.config.localFilter.maxRequestBytes = 24000;
  const deps = dependencies(ctx); let reads = 0;
  deps.execute = async () => ({ stdout: reads++ === 0 ? 'export const supported = false;\n' : 'x'.repeat(4000) });
  deps.connect = async (_config, _cwd, action) => action({ createSession: async options => ({
    sessionId: 'budget-pages', on: () => () => {},
    rpc: { options: { update: async () => {} }, tools: { initializeAndValidate: async () => {} } },
    sendAndWait: async () => {
      const source = options.tools.find(tool => tool.name === 'pilot_request_source');
      const first = JSON.parse(await source.handler({ action: 'read', path: 'src/verifier.js' }));
      assert.equal(first.error, undefined);
      let exhausted = false;
      for (let i = 0; i < 5; i++) {
        const response = await source.handler({ action: 'read', path: 'src/verifier.js' });
        if (response === '') { exhausted = true; break; }
        assert.equal(JSON.parse(response).error, undefined);
      }
      assert.equal(exhausted, true);
    }, disconnect: async () => {}
  }) });
  await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps), /budget previously exhausted/);
});
for (const boundary of ['disconnect', 'client-stop']) for (const loss of ['expiry', 'revocation'])
  test('authority lost during ' + boundary + ' by ' + loss + ' cannot accept review', async t => {
    const ctx = setup(t), path = authority(ctx), deps = dependencies(ctx), connect = deps.connect;
    const clock = Date.now;
    const loseAuthority = () => {
      if (loss === 'revocation') writeFileSync(path, '{}');
      else Date.now = () => clock() + 60000;
    };
    deps.connect = async (config, cwd, action) => {
      const value = await connect(config, cwd, async client => action({ createSession: async options => {
        const session = await client.createSession(options), disconnect = session.disconnect;
        session.disconnect = async () => { await disconnect(); if (boundary === 'disconnect') loseAuthority(); };
        return session;
      } }));
      if (boundary === 'client-stop') loseAuthority();
      return value;
    };
    try {
      await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps), /authorization/);
    } finally { Date.now = clock; }
    assert.equal(ctx.ledger.status().operations.filter(r => r.kind === 'ado-test-request-capability').length, 0);
    assert.equal(ctx.ledger.status().operations.find(r => r.kind === 'ado-test-request-flow').state, 'uncertain');
    await assert.rejects(runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps), /incomplete or uncertain/);
    assert.equal(ctx.calls, 1);
  });

test('near-limit errors and completion acknowledgement are all charged or terminally refused', async t => {
  const run = async (ctx, deniedCount) => {
    const responses = []; let sessionOptions, payload;
    const deps = dependencies(ctx);
    deps.connect = async (_config, _cwd, action) => action({ createSession: async options => {
      sessionOptions = options; let event;
      return { sessionId: 'all-responses', on: callback => { event = callback; return () => {}; },
        rpc: { options: { update: async () => {} }, tools: { initializeAndValidate: async () => {} } },
        sendAndWait: async input => {
          payload = input; event({ type: 'assistant.turn_start' });
          const source = options.tools.find(t => t.name === 'pilot_request_source');
          for (let i = 0; i < deniedCount; i++) responses.push(await source.handler({ action: 'read', path: '../denied' }));
          responses.push(await source.handler({ action: 'read', path: 'src/verifier.js' }));
          responses.push(await options.tools.find(t => t.name === 'pilot_request_finish').handler({ invalid: true }));
          responses.push(await options.tools.find(t => t.name === 'pilot_request_finish').handler({
            decision: 'blocked-environment', missingCapabilities: [], sourcePaths: ['src/verifier.js'],
            rationale: 'Synthetic environment hold.', verificationEvidence: [], handoff: null
          }));
        }, disconnect: async () => {} };
    } });
    let error;
    try { await runTestRequest(ctx.config, ctx.ledger, 123, { authorizeReview: true }, deps); } catch (caught) { error = caught; }
    const sessionUpdate = { installedPlugins: [], includedBuiltinSkills: [], skipCustomInstructions: true,
      customAgentsLocalOnly: true, coauthorEnabled: false, manageScheduleEnabled: false };
    return { error, responses, bytes: Buffer.byteLength(json({ sessionOptions, sessionUpdate, payload })) +
      responses.reduce((sum, value) => sum + Buffer.byteLength(value), 0) };
  };
  const baseline = await run(setup(t), 2); assert.equal(baseline.error, undefined);
  for (const delta of [-1, 0]) {
    const ctx = setup(t); ctx.config.localFilter.maxRequestBytes = baseline.bytes + delta;
    const result = await run(ctx, 2);
    assert.ok(result.bytes <= ctx.config.localFilter.maxRequestBytes);
    if (delta) {
      assert.match(result.error.message, /budget previously exhausted/);
      assert.equal(result.responses.at(-1), '');
      assert.equal(ctx.ledger.status().operations.filter(r => r.kind === 'ado-test-request-capability').length, 0);
    } else { assert.equal(result.error, undefined); assert.equal(result.bytes, baseline.bytes); }
  }
});
