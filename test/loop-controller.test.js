import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { Ledger } from '../src/ledger.js';
import { hash } from '../src/common.js';
import { loopStages, normalizeLoopRequest, previousCalendarDay, digest, captureArtifact,
  fileArtifact, readLoopArtifact, roleReceipt, runEvidenceLoop, loopOperation } from '../src/loop-controller.js';
import { createMailboxLoopAdapter } from '../src/loop-mailbox-adapter.js';
import { reviewLoopFailure } from '../src/loop-failure-review.js';

// Deliberately synthetic domain adapter. It performs real local reads, filtering,
// test generation and comparison, but qualifies no source/provider/product integration.
function fixture(t, mode = 'direct', options = {}) {
  const root = mkdtempSync(join(tmpdir(), 'loop-conformance-'));
  const config = join(root, 'config.json'), source = join(root, 'evidence.json');
  writeFileSync(config, JSON.stringify({ qualification: 'synthetic-only' }));
  writeFileSync(source, JSON.stringify([{ id: 'bug-1', expected: 4, actual: 3, covered: options.noCandidate ?? false }]));
  let ledger = new Ledger(root);
  const calls = Object.fromEntries(loopStages.map(stage => [stage, 0]));
  const binding = { id: 'synthetic-domain-v1', revision: hash('synthetic-domain-v1') };
  const backend = {
    binding, capabilities: [...loopStages], qualification: 'synthetic-only',
    preflight: async () => {},
    async execute(request, ledger) {
      calls[request.stage]++;
      if (options.pause) await options.pause(request.stage);
      const id = request.operationId + ':effect';
      ledger.operation(id, request.runId, 'synthetic-effect', { request });
      if (options.uncertain === request.stage) throw new Error('Lost provider outcome');
      if (options.partial && request.stage === 'collect') return { state: 'blocked', code: 'partial-collection', action: 'Reconcile original source page' };
      let value, outcome;
      const upstream = index => JSON.parse(readLoopArtifact(ledger, request.upstream[index].artifacts[0]));
      if (request.stage === 'collect') {
        value = JSON.parse(readFileSync(source)); outcome = 'collected';
      } else if (request.stage === 'filter') {
        value = upstream(0).filter(bug => bug.expected !== bug.actual && !bug.covered);
        outcome = value.length ? 'eligible' : 'no-candidate';
      } else if (request.stage === 'proposer') {
        const bugs = upstream(1);
        assert.equal(bugs.length, 1);
        const validate = actual => spawnSync(process.execPath, ['--input-type=module', '-e',
          'import assert from "node:assert/strict"; assert.equal(' + actual + ',' + bugs[0].expected + ');'],
        { cwd: root, encoding: 'utf8', timeout: 10000, windowsHide: true }).status;
        const validation = { baselineExit: validate(bugs[0].actual), candidateExit: validate(2 + 2) };
        assert.equal(validation.baselineExit, 1); assert.equal(validation.candidateExit, 0);
        value = { assertions: bugs.map(bug => ({ evidenceId: bug.id, expected: bug.expected })),
          generatedTest: 'assert.equal(add(2, 2), 4)', validation };
        outcome = 'proposed';
      } else {
        const proposed = upstream(2);
        value = { baselineCoverage: 0, candidateCoverage: proposed.assertions?.length ?? 0,
          improvement: proposed.validation?.baselineExit === 1 && proposed.validation?.candidateExit === 0,
          upstream: request.upstream.map(r => r.requestSha256) };
        outcome = request.pins.rsiMode === 'evaluated' ? 'evaluated' : 'captured';
      }
      const receipt = roleReceipt(request, outcome, [captureArtifact(ledger, value)], [id]);
      const result = { state: 'complete', receipt };
      ledger.finishOperation(id, 'recorded', { request, result });
      if (options.lostAck === request.stage) throw new Error('Lost acknowledgment after durable completion');
      return result;
    },
    async resume(request, ledger) {
      return loopOperation(ledger, request.operationId + ':effect')?.detail.result ??
        { state: 'blocked', code: 'blocked-reconciliation', action: 'Original effect uncertain; no repeat permitted' };
    },
    async verify(request, receipt, ledger) {
      assert.deepEqual(loopOperation(ledger, request.operationId + ':effect').detail.result.receipt, receipt);
      receipt.artifacts.forEach(a => readLoopArtifact(ledger, a));
    }
  };
  const adapter = mode === 'mailbox' ? createMailboxLoopAdapter(backend) : backend;
  const adapters = Object.fromEntries(loopStages.map(stage => [stage, adapter]));
  const request = { format: 'evidence-loop-v1', workflowId: 'conformance', occurrence: '2026-10-23T01:00:00Z',
    origin: 'manual', timeZone: 'Asia/Singapore', sourcePolicySha256: hash('source-policy'),
    executionPolicySha256: hash('execution-policy'), rsiMode: 'evaluated',
    configuration: [fileArtifact(config)], stateOwner: { id: 'synthetic', directory: root, accessApproved: true, retentionDays: 7 },
    adapters: Object.fromEntries(loopStages.map(stage => [stage, adapter.binding])),
    deadlineAt: '2099-01-01T00:00:00Z',
    budgets: Object.fromEntries(loopStages.map(stage => [stage, { maxEffects: 1, timeoutMs: 10000 }])) };
  async function run(input = request) {
    let result = await runEvidenceLoop(input, ledger, adapters);
    // Explicit foreground host drain in the test only. The scheduled wrapper never does this.
    while (mode === 'mailbox' && result.state === 'awaiting-host') {
      const role = loopOperation(ledger, result.runId + ':' + result.stage).detail.request;
      try { await adapter.drain(role, ledger); } catch { /* resume from durable receipt below */ }
      result = await runEvidenceLoop(input, ledger, adapters);
      if (result.state === 'awaiting-host') {
        await adapter.drain(role, ledger);
        result = await runEvidenceLoop(input, ledger, adapters);
      }
    }
    return result;
  }
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, config, request, calls, adapters, backend, run,
    get ledger() { return ledger; }, reopen() { ledger.close(); ledger = new Ledger(root); } };
}

test('previous complete day uses occurrence timezone, including DST and delayed invocation', () => {
  assert.deepEqual(previousCalendarDay('2026-10-23T01:00:00Z', 'Asia/Singapore'),
    { start: '2026-10-21T16:00:00.000Z', end: '2026-10-22T16:00:00.000Z' });
  const spring = previousCalendarDay('2026-03-09T12:00:00Z', 'America/New_York');
  assert.equal(Date.parse(spring.end) - Date.parse(spring.start), 23 * 3600000);
  const fall = previousCalendarDay('2026-11-02T12:00:00Z', 'America/New_York');
  assert.equal(Date.parse(fall.end) - Date.parse(fall.start), 25 * 3600000);
});

for (const mode of ['direct', 'mailbox']) {
  for (const stage of ['collect', 'filter', 'proposer']) test(mode + ': durable diagnosis after ' + stage + ' exception', async t => {
    const s = fixture(t, mode, { uncertain: stage });
    const first = await s.run();
    assert.equal(first.state, 'blocked');
    assert.equal(first.failureReview.state, 'diagnosed-and-proposed', JSON.stringify(first));
    const snapshot = JSON.parse(readLoopArtifact(s.ledger, first.failureReview.artifacts[0]));
    const review = JSON.parse(readLoopArtifact(s.ledger, first.failureReview.artifacts[1]));
    assert.equal(snapshot.failure.stage, stage);
    assert.equal(review.lifecycle.execution, 'not-authorized');
    assert.equal(review.actualUsage.modelSessions, 0);
    const before = { ...s.calls };
    s.reopen();
    const again = await s.run();
    const repeated = await s.run();
    assert.deepEqual(again.failureReview, repeated.failureReview);
    assert.deepEqual(s.calls, before);
  });
  test(mode + ': connected four-stage contract, manual/scheduled parity and distinct days', async t => {
    const s = fixture(t, mode);
    const first = await s.run();
    assert.equal(first.state, 'complete', JSON.stringify(first));
    assert.equal(first.rsi, 'evaluated');
    assert.equal(first.proposer, 'proposed');
    const comparison = JSON.parse(readLoopArtifact(s.ledger, first.receipts[3].artifacts[0]));
    assert.equal(comparison.improvement, true);
    s.reopen();
    const second = await s.run({ ...s.request, origin: 'scheduled', occurrence: '2026-10-23T12:00:00Z' });
    assert.deepEqual(first, second);
    assert.deepEqual(Object.values(s.calls), [1, 1, 1, 1]);
    assert.equal((await s.run({ ...s.request, occurrence: '2026-10-24T01:00:00Z' })).state, 'complete');
    assert.deepEqual(Object.values(s.calls), [2, 2, 2, 2]);
  });
  test(mode + ': no candidate is an accepted decision, not missing coverage', async t => {
    const s = fixture(t, mode, { noCandidate: true });
    const result = await s.run();
    assert.equal(result.state, 'complete'); assert.equal(result.proposer, 'no-candidate');
    assert.equal(s.calls.proposer, 0); assert.equal(s.calls.rsi, 1);
  });
  for (const stage of loopStages) test(mode + ': lost acknowledgment after ' + stage + ' never repeats effect', async t => {
    const s = fixture(t, mode, { lostAck: stage });
    await s.run(); s.reopen();
    const result = await s.run({ ...s.request, origin: 'scheduled' });
    assert.equal(result.state, 'complete', JSON.stringify(result));
    assert.deepEqual(Object.values(s.calls), [1, 1, 1, 1]);
  });
  test(mode + ': uncertain effect remains blocked across restart', async t => {
    const s = fixture(t, mode, { uncertain: 'collect' });
    await s.run(); s.reopen();
    assert.equal((await s.run()).state, 'blocked');
    assert.equal(s.calls.collect, 1); assert.equal(s.calls.filter, 0);
  });
  test(mode + ': partial collection never becomes no-candidate', async t => {
    const s = fixture(t, mode, { partial: true });
    assert.equal((await s.run()).state, 'blocked');
    assert.equal(s.calls.filter, 0);
    await s.run(); assert.equal(s.calls.collect, 1);
  });
}

test('review completion survives lost acknowledgment and missing artifacts preserve the original failure', t => {
  const s = fixture(t);
  const { pins, runId } = normalizeLoopRequest(s.request);
  const failure = { runId, stage: 'collect', state: 'blocked', statusCode: 429, retryAfterSeconds: 60, receipts: [] };
  const first = reviewLoopFailure(s.ledger, pins, failure);
  s.reopen();
  assert.deepEqual(reviewLoopFailure(s.ledger, pins, failure), first);
  assert.equal(s.ledger.db.prepare("SELECT COUNT(*) n FROM operations WHERE kind='loop-failure-review'").get().n, 1);
  const review = JSON.parse(readLoopArtifact(s.ledger, first.artifacts[1]));
  assert.equal(review.details.retryAfterSeconds, 60);
  s.ledger.db.prepare('DELETE FROM captures WHERE hash=?').run(first.artifacts[0].sha256);
  assert.equal(reviewLoopFailure(s.ledger, pins, failure).state, 'blocked');
  assert.equal(failure.state, 'blocked');
  assert.equal(s.ledger.db.prepare("SELECT COUNT(*) n FROM operations WHERE kind='loop-failure-review'").get().n, 1);
});

test('RSI failure does not launch a recursive failure review', async t => {
  const s = fixture(t, 'direct', { uncertain: 'rsi' });
  const result = await s.run();
  assert.equal(result.state, 'blocked');
  assert.equal(result.failureReview, undefined);
});

test('concurrent admission uses enforced ledger ownership', async t => {
  let release, entered;
  const started = new Promise(resolve => { entered = resolve; });
  const paused = new Promise(resolve => { release = resolve; });
  const s = fixture(t, 'direct', { pause: async stage => { if (stage === 'collect') { entered(); await paused; } } });
  const first = s.run(); await started;
  const other = new Ledger(s.root);
  try { await assert.rejects(runEvidenceLoop(s.request, other, s.adapters), { code: 'overlap' }); }
  finally { other.close(); release(); }
  assert.equal((await first).state, 'complete'); assert.equal(s.calls.collect, 1);
});

test('config, artifact, policy and adapter drift cannot reset an occurrence', async t => {
  const s = fixture(t);
  await s.run();
  const changedAdapter = structuredClone(s.request);
  changedAdapter.adapters.collect.id = 'different-host';
  assert.equal((await s.run(changedAdapter)).code, 'blocked-reconciliation');
  assert.equal((await s.run({ ...s.request, executionPolicySha256: hash('new-policy') })).code, 'blocked-reconciliation');
  writeFileSync(s.config, 'changed');
  assert.equal((await s.run()).code, 'blocked-reconciliation');
  assert.deepEqual(Object.values(s.calls), [1, 1, 1, 1]);
  const artifact = fileArtifact(s.config); writeFileSync(s.config, 'again');
  assert.throws(() => readLoopArtifact(s.ledger, artifact), { code: 'blocked-reconciliation' });
});

test('unavailable capabilities and exhausted budget stop before any effect', async t => {
  const s = fixture(t);
  s.backend.capabilities = ['collect'];
  assert.equal((await s.run()).code, 'blocked-capability');
  assert.equal(s.calls.collect, 0);
  const other = fixture(t);
  assert.equal((await other.run({ ...other.request, deadlineAt: '2000-01-01T00:00:00Z' })).code, 'blocked-budget');
  assert.equal(other.calls.collect, 0);
  const bad = structuredClone(other.request); bad.budgets.rsi.maxEffects = 0;
  assert.throws(() => normalizeLoopRequest(bad), { code: 'blocked-budget' });
});

test('explicit identical windows and canonical config order preserve contract identity', t => {
  const s = fixture(t), a = normalizeLoopRequest(s.request);
  const b = normalizeLoopRequest({ ...s.request, origin: 'scheduled', window: a.pins.window });
  assert.equal(a.runId, b.runId); assert.equal(digest(a.pins), digest(b.pins));
  assert.equal(normalizeLoopRequest({ ...s.request, window: {
    start: a.pins.window.start.replace('.000Z', 'Z'), end: a.pins.window.end.replace('.000Z', 'Z')
  } }).runId, a.runId);
});

test('mailbox drain repeats preflight and rejects changed pins before effects', async t => {
  const s = fixture(t, 'mailbox');
  const result = await runEvidenceLoop(s.request, s.ledger, s.adapters);
  const role = loopOperation(s.ledger, result.runId + ':collect').detail.request;
  writeFileSync(s.config, 'changed after queueing');
  await assert.rejects(s.adapters.collect.drain(role, s.ledger), { code: 'blocked-reconciliation' });
  assert.equal(s.calls.collect, 0);
});

test('crash after intent but before adapter effect stays uncertain, not a new execution', async t => {
  const s = fixture(t);
  const execute = s.backend.execute;
  s.backend.execute = async () => { throw new Error('Host lost immediately after intent'); };
  assert.equal((await s.run()).state, 'blocked');
  s.reopen(); s.backend.execute = execute;
  assert.equal((await s.run()).code, 'blocked-reconciliation');
  assert.equal(s.calls.collect, 0);
});

test('stale request-bound receipt cannot advance the next stage or repeat its effect', async t => {
  const s = fixture(t);
  const execute = s.backend.execute;
  s.backend.execute = async (request, ledger) => {
    const result = await execute(request, ledger);
    return { ...result, receipt: { ...result.receipt, requestSha256: hash('another-request') } };
  };
  assert.equal((await s.run()).code, 'blocked-reconciliation');
  assert.equal(s.calls.filter, 0);
  s.backend.execute = execute; s.reopen();
  assert.equal((await s.run()).state, 'complete');
  assert.equal(s.calls.collect, 1);
});
