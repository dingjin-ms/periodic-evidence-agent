import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { configAt, hash, json, now } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import { loopStages, normalizeLoopRequest, fileArtifact, digest, runEvidenceLoop, loopOperation, readLoopArtifact } from '../src/loop-controller.js';
import { createNativeLoopAdapter, nativeLoopSettings } from '../src/loop-native-adapter.js';
import { createMailboxLoopAdapter } from '../src/loop-mailbox-adapter.js';
import { readOneShotCollectionReceipt, oneShotCollectionStatus } from '../src/one-shot-collection.js';
import { loadFilterCorpus } from '../src/filter.js';
import { prepareFilterBatches } from '../src/filter-batches.js';
import { prepareOneShotFilterBudget } from '../src/one-shot-handoff.js';
import { openApp } from '../src/app-native.js';

for (const mode of ['native', 'mailbox', 'native-throttled', 'mailbox-throttled', 'native-mixed-throttled', 'mailbox-mixed-throttled', 'local-sdk', 'local-unapproved', 'local-reconcile', 'local-rsi-recover']) test(mode + ': fresh collection, FILTER continuation, empty cohort, RSI and wrapper parity', async t => {
  const root = mkdtempSync(join(tmpdir(), 'loop-native-'));
  const c = configAt('pilot.example.json');
  c.statePolicy.accessApproved = true;
  c.sources.ado = { enabled: true, scopeApproved: true };
  c.dryRun.limits = { maxItems: 10, maxCalls: 10 };
  c.rsi = JSON.parse(readFileSync('scaffold/rsi-flow.example.json'));
  writeFileSync(join(root, 'validation-profile.js'), '// Synthetic profile binding');
  c.repositories = [{ id: 'fixture', projectId: 'fixture', routingApproved: true, referenceCheckout: root,
    validationGates: [{ id: 'synthetic', approved: true, isolationVerified: true,
      profilePath: 'validation-profile.js', profileSha256: hash(readFileSync(join(root, 'validation-profile.js'))),
      executable: process.execPath, args: ['--test'], timeoutMs: 10000 }],
    allowedWritePrefixes: ['test'], skillBindings: [{ id: 'synthetic', enabled: true, qualification: 'qualified',
      capability: 'integration-test-authoring', skillPath: 'synthetic/SKILL.md', requestedOutcomes: ['add-or-update-tests'],
      allowedWritePrefixes: ['test'], requiresBehaviorCard: false,
      sideEffects: { commit: false, push: false, createDraftPR: false } }] }];
  Object.assign(c.limits, { workerMinutes: 1, workerMaxToolCalls: 10, maxAiCreditsPerSession: 1, maxValidationRepairRounds: 0 });
  c.agency = { profiles: {}, selections: [], budgetId: 'derived', maxRequests: 1, maxConcurrent: 1,
    maxDraftPullRequests: 0, maxExecutionSeconds: 600, preflightMaxAgeSeconds: 300,
    monitorOwner: 'synthetic', monitorCadenceSeconds: 60 };
  const verificationRef = join(root, 'token-approval.json');
  writeFileSync(verificationRef, '{"synthetic":true}');
  c.filterBatching = { approved: true, mode: 'verified', model: 'synthetic', profile: 'synthetic',
    tokenizer: 'synthetic', verifiedBy: 'test', verifiedAt: now(), verificationRef,
    verificationSha256: hash(readFileSync(verificationRef)), contextTokens: 1000, maxInputTokens: 500,
    maxPayloadBytes: 1000000, maxBatches: 1,
    reserves: { instructions: 10, sourceAnalysis: 20, output: 100, safety: 10, requestOverhead: 5 } };
  if (mode.startsWith('local-')) {
    mkdirSync(join(root, 'synthetic'));
    writeFileSync(join(root, 'synthetic', 'SKILL.md'), '# Synthetic read-only qualification fixture');
    const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8', windowsHide: true }).trim();
    git(['init', '--quiet']); git(['add', 'synthetic/SKILL.md']);
    git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Fixture skill']);
    git(['remote', 'add', 'origin', 'https://example.invalid/fixture']);
    const revision = git(['rev-parse', 'HEAD']);
    Object.assign(c.repositories[0], { baseRef: revision, remote: 'https://example.invalid/fixture', qualificationRefresh: 'local' });
    c.filterExecutor = 'local-sdk'; c.activation.review = true; c.limits.maxAiCreditsPerSession = 30;
    c.localFilter = { enabled: true, acceptSoftCreditLimit: mode !== 'local-unapproved', maxRequests: 1,
      maxToolCalls: 5, timeoutMs: 10000, maxSourceBytes: 10000, maxRequestBytes: 1000000,
      sources: [{ repoId: 'fixture', revision }] };
  }
  const throttled = mode.endsWith('-throttled');
  const mixed = mode.includes('-mixed-');
  if (mixed) c.dryRun.limits = { maxItems: 5, maxCalls: 5 };
  if (throttled) {
    c.sources.ado.enabled = mixed;
    c.sources.workiq.enabled = true; c.sources.workiq.scopeApproved = true;
    c.runtime.workiqCli = { enabled: true, executable: process.execPath, packageVersion: '1.0.1', timeoutMs: 1000 };
  }
  const collectorConfig = join(root, 'collector.local.json'), proposerConfig = join(root, 'proposer.local.json');
  writeFileSync(collectorConfig, json(c)); writeFileSync(proposerConfig, json(c));
  const deadlineAt = new Date(Date.now() + 600000).toISOString();
  const bundle = { format: 'loop-native-settings-v1', collectorConfig, proposerConfig, executeProposer: false,
    workflowId: 'native-test', timeZone: 'Asia/Singapore', adapter: mode === 'mailbox' ? 'mailbox' : 'native', rsiMode: 'capture-only', deadlineAt,
    stateOwner: { id: 'synthetic', directory: join(root, 'state'), accessApproved: true, retentionDays: 7 },
    budgets: Object.fromEntries(loopStages.map(stage => [stage, { maxEffects: 10, timeoutMs: 600000 }])),
    collection: { dryRun: true, passes: mixed ? ['ado:created', 'workiq:created'] : [throttled ? 'workiq:created' : 'ado:created'], authorization: { approvedBy: 'test', approvedAt: now(),
      approvalRef: 'synthetic-only', deadlineAt, maxItems: 10, maxCalls: 10 } },
    filterHost: { id: 'synthetic-host', approvalRef: 'synthetic-only', qualificationRef: verificationRef,
      maxRequests: 1, maxExecutionSeconds: 600, maxReservedTokens: 1000 } };
  if (mode.startsWith('local-')) bundle.localFilterPlan = {
    instructions: 'Synthetic complete corpus review',
    groupingReview: { reviewer: 'test', reviewedAt: now(), rationale: 'Exact singleton membership only' },
    sharing: { audience: 'synthetic-only', approvalRef: 'synthetic-only' },
    routing: { capability: 'integration-test-authoring' },
    authorization: { approvedBy: 'test', approvedAt: now(), approvalRef: 'synthetic-only', deadlineAt,
      maxFilterRequests: 1, maxFilterExecutionSeconds: 600, maxFilterReservedTokens: 1000,
      maxFilterAiCredits: 30, maxProposers: 1, maxProposerAiCredits: 30,
      authorizeCommit: false, authorizePush: false, authorizeDraftPR: false }
  };
  const bundlePath = join(root, 'bundle.local.json'); writeFileSync(bundlePath, json(bundle));
  let calls = 0, workiqCalls = 0;
  let failPreparation = mode === 'local-reconcile';
  const native = createNativeLoopAdapter({ collectionDependencies: {
    workiqFactory: async () => ({ read: async () => {
      calls++;
      return ++workiqCalls === 1 ? { structuredContent: { results: [{ statusCode: 200,
        data: { id: c.identity.objectId, userPrincipalName: c.identity.designatedUser } }] } }
        : { isError: true, structuredContent: { results: [{ statusCode: 429, retryAfterSeconds: 60 }] } };
    }, close: async () => {} }),
    adoTransport: async () => async () => { calls++; return { asOf: '2026-10-23T00:00:00Z', workItems: [] }; }
  }, filterDependencies: { counter: async (_config, input) => {
    if (failPreparation) throw new Error('Known pre-submission preparation failure');
    return { sha256: input.sha256, model: input.model, tokenizer: input.tokenizer, tokens: 5 };
  },
    connect: async () => { throw new Error('An empty cohort must not launch a model'); } } });
  const adapter = mode.startsWith('mailbox') ? createMailboxLoopAdapter(native) : mode === 'local-rsi-recover'
    ? { ...native, execute: (request, ledger) => request.stage === 'rsi'
      ? { state: 'blocked', code: 'fixture-capture-hold', action: 'Exercise explicit original-producer recovery' }
      : native.execute(request, ledger) } : native;
  const configuration = [bundlePath, collectorConfig, proposerConfig].map(fileArtifact);
  const request = { format: 'evidence-loop-v1', workflowId: 'native-test', occurrence: '2026-10-23T01:00:00Z',
    origin: 'manual', timeZone: 'Asia/Singapore', rsiMode: 'capture-only', configuration, deadlineAt,
    stateOwner: { id: 'synthetic', directory: join(root, 'state'), accessApproved: true, retentionDays: 7 },
    sourcePolicySha256: digest({ identity: c.identity, sources: c.sources, passes: bundle.collection.passes }),
    executionPolicySha256: digest({ collector: configuration[1], proposer: configuration[2], executeProposer: false, rsiMode: 'capture-only' }),
    adapters: Object.fromEntries(loopStages.map(stage => [stage, adapter.binding])),
    budgets: Object.fromEntries(loopStages.map(stage => [stage, { maxEffects: 10, timeoutMs: 600000 }])) };
  const ledger = new Ledger(request.stateOwner.directory);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const adapters = Object.fromEntries(loopStages.map(stage => [stage, adapter]));
  let waiting = await runEvidenceLoop(request, ledger, adapters);
  if (throttled) {
    if (mode.startsWith('mailbox')) {
      await adapter.drain(loopOperation(ledger, waiting.runId + ':collect').detail.request, ledger);
      waiting = await runEvidenceLoop(request, ledger, adapters);
    }
    assert.equal(waiting.state, 'blocked', json(waiting));
    assert.equal(waiting.statusCode, 429, json(waiting));
    assert.equal(waiting.retryAfterSeconds, 60);
    assert.equal(waiting.failureReview.state, 'diagnosed-and-proposed', json(waiting));
    const snapshot = JSON.parse(readLoopArtifact(ledger, waiting.failureReview.artifacts[0]));
    assert.equal(snapshot.evidence.sourceCoverageComplete, false);
    assert.equal(snapshot.evidence.transports.at(-1).failure.retryAfterSeconds, 60);
    assert.equal(snapshot.evidence.producerBindings.length, 1);
    assert.equal(snapshot.evidence.passes.at(-1).calls, 2);
    if (mixed) {
      assert.equal(snapshot.evidence.passes[0].state, 'complete');
      assert.equal(snapshot.evidence.transports.length, 4);
      assert.equal(snapshot.evidence.transports[0].state, 'received');
      assert.equal(snapshot.evidence.transports[0].effectCertainty, 'response-recorded');
      assert.match(snapshot.evidence.transports[0].requestSha256, /^[a-f0-9]{64}$/);
      assert.equal(snapshot.evidence.transports[0].failure, null);
    }
    assert.equal(loopOperation(ledger, waiting.runId + ':filter'), null);
    assert.equal(loopOperation(ledger, waiting.runId + ':rsi'), null);
    assert.equal(calls, mixed ? 4 : 2);
    assert.deepEqual(await runEvidenceLoop(request, ledger, adapters), waiting);
    assert.equal(calls, mixed ? 4 : 2);
    return;
  }
  if (mode === 'local-rsi-recover') {
    assert.equal(waiting.code, 'fixture-capture-hold', json(waiting));
    const originalCalls = calls, requestPath = join(root, 'rsi-request.json');
    writeFileSync(requestPath, json(request));
    const recover = producerRoot => spawnSync(process.execPath, ['scripts/loop-reconcile-rsi.mjs',
      '--request', requestPath, '--producer-root', producerRoot, '--approval-ref', 'synthetic-only'],
    { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.notEqual(recover(root).status, 0, 'Unqualified producer must fail before capture');
    assert.equal(loopOperation(ledger, waiting.runId + ':rsi').detail.receipt, undefined);
    const originalBundle = readFileSync(bundlePath);
    writeFileSync(bundlePath, Buffer.concat([originalBundle, Buffer.from(' ')]));
    try { assert.notEqual(recover(process.cwd()).status, 0, 'Byte-level configuration drift must block recovery'); }
    finally { writeFileSync(bundlePath, originalBundle); }
    const recovered = recover(process.cwd());
    assert.equal(recovered.status, 0, recovered.stdout + recovered.stderr);
    assert.equal(JSON.parse(recovered.stdout).newModelCalls, 0);
    const completed = await runEvidenceLoop({ ...request, origin: 'scheduled' }, ledger, adapters);
    assert.equal(completed.state, 'complete', json(completed));
    assert.equal(completed.rsi, 'captured'); assert.equal(calls, originalCalls);
    return;
  }
  if (mode === 'local-reconcile') {
    assert.equal(waiting.state, 'blocked');
    const originalCalls = calls, original = normalizeLoopRequest(request);
    const originalPath = join(root, 'original-request.json'); writeFileSync(originalPath, json(request));
    const oldSettings = nativeLoopSettings(original.pins, original.runId);
    const source = new Ledger(oldSettings.collector.stateDirectory);
    const receiptSha256 = oneShotCollectionStatus(source, original.runId).receiptSha256; source.close();
    const nextBundle = { ...bundle, collectionReuse: { approvedBy: 'test', approvalRef: 'synthetic-only',
      requestPath: originalPath, requestSha256: hash(readFileSync(originalPath)), receiptSha256 } };
    const nextPath = join(root, 'successor-settings.json'); writeFileSync(nextPath, json(nextBundle));
    const next = { ...request, workflowId: 'successor', configuration: [fileArtifact(nextPath), ...configuration.slice(1)] };
    failPreparation = false;
    const predecessorLock = 'evidence-loop:' + original.runId, predecessorOwner = ledger.acquire(predecessorLock);
    try {
      const refused = await runEvidenceLoop(next, ledger, adapters);
      assert.equal(refused.state, 'blocked'); assert.equal(calls, originalCalls);
      assert.equal(loopOperation(ledger, original.runId + ':collection-successor'), null);
    } finally { ledger.release(predecessorLock, predecessorOwner); }
    const completed = await runEvidenceLoop(next, ledger, adapters);
    assert.equal(completed.state, 'complete', json(completed));
    assert.equal(completed.rsi, 'captured'); assert.equal(calls, originalCalls);
    assert.deepEqual(await runEvidenceLoop({ ...next, origin: 'scheduled' }, ledger, adapters), completed);
    assert.equal(calls, originalCalls);
    const conflict = await runEvidenceLoop({ ...next, workflowId: 'second-successor' }, ledger, adapters);
    assert.equal(conflict.state, 'blocked'); assert.equal(conflict.code, 'blocked-reconciliation');
    assert.equal(calls, originalCalls);
    return;
  }
  if (mode === 'local-unapproved') {
    assert.equal(waiting.code, 'action-required-budget', json(waiting));
    assert.equal(calls, 0); return;
  }
  if (mode === 'local-sdk') {
    assert.equal(waiting.state, 'complete', json(waiting));
    assert.equal(waiting.proposer, 'no-candidate'); assert.equal(waiting.rsi, 'captured');
    const firstCalls = calls;
    assert.deepEqual(await runEvidenceLoop({ ...request, origin: 'scheduled' }, ledger, adapters), waiting);
    assert.equal(calls, firstCalls); return;
  }
  if (mode === 'mailbox') {
    await adapter.drain(loopOperation(ledger, waiting.runId + ':collect').detail.request, ledger);
    waiting = await runEvidenceLoop(request, ledger, adapters);
    const driftPath = join(root, 'drift.local.json'), drift = structuredClone(request);
    drift.budgets.rsi.maxEffects--;
    writeFileSync(driftPath, json(drift));
    const refused = spawnSync(process.execPath, ['scripts/loop-manual.mjs', '--request', driftPath, '--drain', 'filter'],
      { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(refused.status, 2, refused.stdout + refused.stderr);
    assert.equal(JSON.parse(refused.stdout).code, 'blocked-reconciliation');
    await adapter.drain(loopOperation(ledger, waiting.runId + ':filter').detail.request, ledger);
    waiting = await runEvidenceLoop(request, ledger, adapters);
  }
  assert.equal(waiting.state, 'awaiting-host', json(waiting));
  assert.equal(waiting.stage, 'filter');
  const originalCalls = calls; assert.ok(originalCalls > 0);
  const { pins, runId } = normalizeLoopRequest(request), s = nativeLoopSettings(pins, runId);
  const source = new Ledger(s.collector.stateDirectory);
  const collected = readOneShotCollectionReceipt(s.collector, source, runId);
  const receiptSha256 = oneShotCollectionStatus(source, runId).receiptSha256; source.close();
  const corpus = loadFilterCorpus(s.proposer, { format: 'stage2-sources-v1', sources: collected.snapshot.sources });
  assert.equal(corpus.evidence.length, 0);
  const instructions = 'Synthetic empty cohort';
  const pretty = value => JSON.stringify(value, null, 2) + '\n';
  const manifestPath = join(s.root, 'manifest.json');
  await prepareFilterBatches(s.proposer, { format: 'filter-batch-request-v1', sources: collected.snapshot.sources,
    instructions, groups: [], groupingReview: { reviewer: 'test', reviewedAt: now(), rationale: 'Empty captured source' },
    sharing: { audience: 'synthetic-only', approvalRef: 'synthetic-only', materials: [hash(instructions),
      hash(pretty(corpus.coverage.map(({ runId, coverage }) => ({ runId, coverage }))))]
      .map(sha256 => ({ sha256, eligibility: 'approved', restrictions: ['synthetic-only'] })) } }, manifestPath,
  async (_config, input) => ({ sha256: input.sha256, model: input.model, tokenizer: input.tokenizer, tokens: 5 }));
  const execution = new Ledger(join(s.root, 'filter-execution'));
  const handoff = { format: 'one-shot-handoff-v1', owner: 'synthetic',
    collection: { stateDirectory: s.collector.stateDirectory, runId, receiptSha256 },
    filter: { manifestPath, manifestSha256: hash(readFileSync(manifestPath)),
      executionLedgerPath: join(execution.directory, 'ledger.sqlite'), resultPaths: [] },
    routing: { capability: 'integration-test-authoring' },
    authorization: { approvedBy: 'test', approvedAt: now(), approvalRef: 'synthetic-only', deadlineAt,
      maxFilterRequests: 1, maxFilterExecutionSeconds: 600, maxFilterReservedTokens: 1000,
      maxProposers: 1, maxProposerAiCredits: 1, authorizeCommit: false, authorizePush: false, authorizeDraftPR: false } };
  prepareOneShotFilterBudget(s.proposer, execution, handoff); execution.close();
  writeFileSync(join(s.root, 'handoff.json'), json(handoff));
  if (mode === 'mailbox') await adapter.drain(loopOperation(ledger, runId + ':filter').detail.request, ledger);
  let done = await runEvidenceLoop({ ...request, origin: 'scheduled' }, ledger, adapters);
  if (mode === 'mailbox') {
    assert.equal(done.stage, 'rsi');
    await adapter.drain(loopOperation(ledger, runId + ':rsi').detail.request, ledger);
    done = await runEvidenceLoop({ ...request, origin: 'scheduled' }, ledger, adapters);
  }
  assert.equal(done.state, 'complete', json(done));
  assert.equal(done.proposer, 'no-candidate'); assert.equal(done.rsi, 'captured');
  const app = openApp(s.collector, runId, true);
  const observation = app.ledger.get('rsiFlowObservation', done.receipts[3].ledgerIds[0]);
  assert.deepEqual(observation.payload.data.summary.loop.receipts.map(r => r.outcome),
    ['collected', 'no-candidate', 'no-candidate']);
  assert.equal(observation.payload.data.summary.loop.results.length, 3);
  app.ledger.close();
  assert.equal(calls, originalCalls);
  const requestPath = join(root, 'run.local.json'); writeFileSync(requestPath, json(request));
  const builtPath = join(root, 'built.local.json');
  const built = spawnSync(process.execPath, ['scripts/loop-request.mjs', '--settings', bundlePath,
    '--occurrence', request.occurrence, '--output', builtPath], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(built.status, 0, built.stdout + built.stderr);
  assert.deepEqual(JSON.parse(readFileSync(builtPath)), request);
  for (const wrapper of ['manual', 'scheduled']) {
    const result = spawnSync(process.execPath, ['scripts/loop-' + wrapper + '.mjs', '--request', requestPath],
      { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(result.status, 0, result.stdout + result.stderr);
    assert.deepEqual(JSON.parse(result.stdout), done);
  }
  const original = new Ledger(s.proposer.stateDirectory);
  original.db.prepare('DELETE FROM operations WHERE id=?').run(done.receipts[1].ledgerIds[0]);
  original.close();
  assert.equal((await runEvidenceLoop(request, ledger, adapters)).code, 'blocked-reconciliation');
  assert.equal(calls, originalCalls);
});
