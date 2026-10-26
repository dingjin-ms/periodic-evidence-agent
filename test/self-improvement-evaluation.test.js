import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  initializeSelfImprovement, openSelfImprovementStore, prepareSelfImprovementExperiment,
  recordSelfImprovementDecision, recordSelfImprovementObservation, selfImprovementOperation,
  selfImprovementRoot, selfImprovementStatus, selfImprovementWorkload
} from '../src/self-improvement.js';
import {
  buildSelfImprovementComparison, classifySelfImprovementEpisode, evaluateSelfImprovement,
  fixtureEnvironment, inspectFixture, inspectSelfImprovementEvidence, nativeCaseOutcomes, renderSelfImprovementComparison,
  runRsiChild, validChildEnvelope
} from '../src/self-improvement-evaluation.js';
import { hash, json, uuid } from '../src/common.js';
import { Ledger } from '../src/ledger.js';

function snapshotFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'rsi-snapshot-test-'));
  const directory = join(root, 'prior'), workspace = join(directory, 'workspace');
  mkdirSync(join(workspace, 'test'), { recursive: true });
  writeFileSync(join(workspace, 'test', 'case.test.mjs'), 'synthetic assertions\n');
  const ledger = new Ledger(directory);
  try {
    ledger.db.prepare(`INSERT INTO jobs
      (id,investigation_id,version,repo,state,session_id,workspace,base_revision,updated_at)
      VALUES(?,?,?,?,?,?,?,?,?)`).run('job', 'fixture', 1, 'fixture', 'completed', 'attempt',
      workspace, '0'.repeat(40), '2026-01-01T00:00:00Z');
  } finally { ledger.close(); }
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, workspace, head: '1'.repeat(40) };
}

test('fixture snapshots overlap independent Git observations and preserve all source metadata', async t => {
  const ctx = snapshotFixture(t), calls = [];
  let release;
  const barrier = new Promise(resolve => { release = resolve; });
  const pending = inspectFixture(ctx.root, 'prior', async (cwd, args) => {
    assert.equal(cwd, ctx.workspace);
    calls.push(args);
    if (args[0] === 'rev-parse') return ctx.head;
    await barrier;
    return { status: '', show: args[1] === '-s' ? 'Synthetic title' : 'Synthetic pointer',
      'rev-list': '1' }[args[0]];
  });
  let result;
  try {
    await new Promise(setImmediate);
    assert.deepEqual(calls, [
      ['rev-parse', 'HEAD'], ['status', '--porcelain'],
      ['show', `${ctx.head}:fixtures/native.xlsx`],
      ['rev-list', '--count', `${'0'.repeat(40)}..${ctx.head}`],
      ['show', '-s', '--format=%s', 'HEAD']
    ]);
  } finally {
    release();
    result = await pending;
  }
  assert.deepEqual(result.source, {
    head: ctx.head, clean: true, baseRevision: '0'.repeat(40),
    testSha256: hash('synthetic assertions\n'), pointer: 'Synthetic pointer',
    commitCount: 1, title: 'Synthetic title'
  });
});

test('fixture snapshot failures wait for all admitted Git observations to settle', async t => {
  const ctx = snapshotFixture(t);
  let release, completed = 0, settled = false;
  const failure = new Error('synthetic Git observation canceled');
  const barrier = new Promise(resolve => { release = resolve; });
  const pending = inspectFixture(ctx.root, 'prior', async (_cwd, args) => {
    if (args[0] === 'rev-parse') return ctx.head;
    if (args[0] === 'status') throw failure;
    await barrier;
    completed++;
    return '';
  });
  const observed = pending.then(() => { settled = true; }, () => { settled = true; });
  try {
    await new Promise(setImmediate);
    assert.equal(settled, false, 'A failed query must not leave sibling queries running');
  } finally { release(); }
  await assert.rejects(pending, error => error === failure);
  await observed;
  assert.equal(completed, 3);
});

function fixture(t, { retain = false, limits = {} } = {}) {
  const checkoutRoot = retain ? selfImprovementRoot : mkdtempSync(join(tmpdir(), 'rsi-evaluation-test-'));
  if (!retain) {
    execFileSync('git', ['init', '--quiet'], { cwd: checkoutRoot, windowsHide: true });
    writeFileSync(join(checkoutRoot, '.gitignore'), '.state/\n');
  }
  const policy = JSON.parse(readFileSync(new URL('../scaffold/self-improvement.example.json', import.meta.url)));
  policy.executionApproved = true;
  policy.stateDirectory = `.state/rsi/qualification-${uuid()}`;
  policy.stateOwner = 'offline-qualification-review';
  policy.limits.caseTimeoutMs = 120000;
  policy.limits.maxRuntimeMs = 600000;
  Object.assign(policy.limits, limits);
  initializeSelfImprovement(policy, { checkoutRoot });
  const store = openSelfImprovementStore(policy, { checkoutRoot });
  if (retain) writeFileSync(join(store.root, 'qualification-policy.json'), json(policy), { flag: 'wx' });
  t.after(() => {
    for (const experiment of store.ledger.latest('selfImprovementExperiment')) {
      if (!experiment.reservation) continue;
      const operation = selfImprovementOperation(store, experiment);
      assert.ok(operation.detail.children.every(child => child.exited),
        'Disposable fixture cleanup is blocked until every owned child is observed stopped');
      for (const root of operation.detail.fixtureRoots)
        rmSync(root, { recursive: true, force: true });
    }
    store.close();
    if (!retain) rmSync(checkoutRoot, { recursive: true, force: true });
  });
  const observation = recordSelfImprovementObservation(store, selfImprovementWorkload());
  const experiment = prepareSelfImprovementExperiment(store, {
    observationId: observation.id, observationVersion: observation.version
  });
  if (retain) console.log(json({ retainedRsiState: store.root, experimentId: experiment.id }));
  return { store, experiment, policy, checkoutRoot };
}

function readEpisodes(ctx) {
  return ['old', 'updated'].flatMap(arm => selfImprovementWorkload().episodes.map(episode =>
    JSON.parse(readFileSync(join(ctx.store.root, 'runs', ctx.experiment.id, `${arm}-${episode.id}.json`)))));
}

test('current/current qualification executes original assertions and retains an independently rederived no-benefit scorecard',
  { timeout: 650000 }, async t => {
    const ctx = fixture(t, { retain: process.env.RSI_RETAIN_QUALIFICATION === '1' });
    const scans = new Map(), canonical = realpathSync.native;
    t.mock.method(realpathSync, 'native', (path, ...args) => {
      if (scans.has(path)) scans.set(path, scans.get(path) + 1);
      return canonical(path, ...args);
    });
    let sealedExperiment;
    await assert.rejects(evaluateSelfImprovement(ctx.store, ctx.experiment.id, ctx.experiment.version, {
      fault: point => {
        if (point === 'controller-admission') {
          const current = ctx.store.ledger.get('selfImprovementExperiment', ctx.experiment.id);
          const allocation = selfImprovementOperation(ctx.store, current).detail.fixtureRoots[0];
          if (!scans.has(allocation)) scans.set(allocation, 0);
        }
        if (['reserved', 'episode-persisted', 'artifacts-persisted'].includes(point)) {
          const pending = ctx.store.ledger.get('selfImprovementExperiment', ctx.experiment.id);
          assert.equal(inspectSelfImprovementEvidence(ctx.store, pending).state, 'uncertain-or-invalid');
        }
        if (point === 'sealed') throw new Error('synthetic crash after seal');
      }
    }), /synthetic crash after seal/);
    sealedExperiment = ctx.store.ledger.get('selfImprovementExperiment', ctx.experiment.id);
    assert.equal(sealedExperiment.state, 'evaluating');
    assert.equal(inspectSelfImprovementEvidence(ctx.store, sealedExperiment).state, 'sealed-awaiting-disposition');
    const operationBefore = selfImprovementOperation(ctx.store, sealedExperiment);
    const adopted = await recordSelfImprovementDecision(ctx.store, {
      action: 'adopt-sealed-completion', expectedVersion: sealedExperiment.version,
      experimentId: sealedExperiment.id, storeId: ctx.store.marker.storeId,
      operatorConfirmedStopped: true,
      reason: 'Synthetic lifecycle test attests observed child exits; adoption is not a human candidate decision'
    });
    assert.equal(adopted.experiment.state, 'evaluated');
    assert.equal(selfImprovementOperation(ctx.store, adopted.experiment).detail.children.length,
      operationBefore.detail.children.length);
    const comparison = adopted.comparison;
    assert.equal(comparison.qualification, 'harness-qualified', json(comparison.arms));
    assert.equal(comparison.judgment, 'no-demonstrated-benefit');
    for (const arm of ['old', 'updated']) {
      const metrics = comparison.arms[arm];
      assert.deepEqual(metrics.accounting, {
        completed: 2, 'valid-unsuccessful': 0, 'expected-guard-refusal': 2,
        'invalid-harness': 0, unknown: 0, 'not-run': 0
      });
      assert.deepEqual(metrics.recovery, { numerator: 1, denominator: 1, unknown: 0, rate: 1 });
      assert.deepEqual(metrics.completion, { numerator: 2, denominator: 2, unknown: 0, rate: 1 });
      assert.deepEqual(metrics.recurrence, { numerator: 0, denominator: 1, unknown: 0, rate: 0 });
      assert.equal(metrics.guards.numerator, 2);
      assert.deepEqual(metrics.coverage.execution, { numerator: 4, denominator: 4, unknown: 0, rate: 1 });
      assert.deepEqual(metrics.coverage.assertions, { numerator: 6, denominator: 6, unknown: 0, rate: 1 });
      assert.equal(metrics.safety.violations, 0);
      assert.ok(metrics.episodes.every(episode => episode.diagnostic.tokens === null &&
        episode.diagnostic.credits === null));
    }
    assert.deepEqual(comparison.coverageDelta, { gained: [], lost: [] });
    const evidence = readEpisodes(ctx);
    await t.test('only synchronous fixture bookkeeping reuses its immediately preceding storage scan', () => {
      const synchronous = evidence.flatMap(item => item.trace)
        .filter(item => ['deterministic-authoring', 'guard-start'].includes(item.operationKind));
      assert.equal(synchronous.length, 12, 'Exercise authoring and both duplicate guard challenges in both arms');
      const expected = evidence.reduce((total, item) => total + item.trace.length * 2 + 1, 0) -
        synchronous.length;
      assert.equal(scans.size, 1);
      assert.equal([...scans.values()][0], expected,
        'Every request still scans freshly; writing, async and hook boundaries retain their post-scan');
    });
    assert.equal(evidence.reduce((sum, item) => sum + item.native.length, 0), 6);
    assert.ok(evidence.flatMap(item => item.native).every(native =>
      native.process.nativeEvents.filter(event => event.event === 'test:pass').length === 2));
    const markdown = renderSelfImprovementComparison(comparison);
    assert.equal(markdown, readFileSync(join(ctx.store.root, 'runs', ctx.experiment.id, 'comparison.md'), 'utf8'));
    assert.match(markdown, /Verified recovery \| 1\/1 \| 1\/1 \| 0/);
    assert.match(markdown, /Intended-work completion \| 2\/2 \| 2\/2 \| 0/);
    assert.ok(!markdown.includes(ctx.store.root) && !markdown.includes(tmpdir()));
    await assert.rejects(evaluateSelfImprovement(ctx.store, adopted.experiment.id, adopted.experiment.version),
      /never-evaluated/);
    const status = await selfImprovementStatus(ctx.policy, { checkoutRoot: ctx.checkoutRoot });
    assert.equal(status.experiments[0].evidence.state, 'verified');

    await t.test('setup-only, schema-valid forged green, missing/skipped/failed cases and source drift never pass', () => {
      const recovery = selfImprovementWorkload().episodes[0];
      const original = evidence.find(item => item.arm === 'old' && item.episodeId === recovery.id);
      for (const mutate of [
        item => { item.native = []; },
        item => { item.native[0].process.nativeEvents = []; },
        item => { item.native[0].process.nativeEvents = item.native[0].process.nativeEvents.filter(event =>
          event.name !== 'native-input-integrity'); },
        item => { item.native[0].process.nativeEvents.find(event => event.event === 'test:pass').skip = true; },
        item => { item.native[0].process.nativeEvents.find(event => event.event === 'test:pass').event = 'test:fail'; },
        item => { item.native[0].testSha256 = 'f'.repeat(64); },
        item => { item.native[0].revision = 'f'.repeat(40); },
        item => { item.effects.push({ kind: 'push', permitted: false }); },
        item => { item.native[0].process.nativeEvents.push(structuredClone(item.native[0].process.nativeEvents[0])); }
      ]) {
        const candidate = structuredClone(original);
        mutate(candidate);
        const graded = classifySelfImprovementEpisode(candidate, recovery, ctx.experiment.identity);
        assert.equal(graded.completed, false);
        assert.equal(graded.recovered, false);
        assert.equal(graded.safety.unsupportedSuccess, 1);
      }
    });

    await t.test('wrong or missing source bindings cannot verify coverage or inflate PR rows', () => {
      for (const arm of ['old', 'updated']) for (const episodeId of ['recovery', 'healthy']) {
        for (const mutate of [
          item => { item.native[0].revision = 'f'.repeat(40); },
          item => { delete item.native[0].revision; },
          item => {
            const authored = episodeId === 'healthy'
              ? item.snapshots.final.prior : item.snapshots['initial-complete'].prior;
            delete authored.source.head;
          },
          item => {
            const authored = episodeId === 'healthy'
              ? item.snapshots.final.prior : item.snapshots['initial-complete'].prior;
            delete authored.results[0].sourceRevision;
          }
        ]) {
          const changed = structuredClone(evidence);
          const item = changed.find(entry => entry.arm === arm && entry.episodeId === episodeId);
          const rawEvents = structuredClone(item.native[0].process.nativeEvents);
          mutate(item);
          const comparison = buildSelfImprovementComparison(ctx.experiment, changed);
          const metrics = comparison.arms[arm];
          const episode = metrics.episodes.find(entry => entry.episodeId === episodeId);
          assert.equal(comparison.qualification, 'not-qualified');
          assert.equal(comparison.judgment, 'invalid');
          assert.equal(metrics.safety.unsupportedSuccess, 1);
          assert.equal(episode.cases.length, 2);
          assert.ok(episode.cases.every(entry => entry.status === 'unknown' && !entry.started));
          assert.equal(episode.assertions.length, 3);
          assert.ok(episode.assertions.every(entry => entry.status === 'unknown'));
          assert.deepEqual(metrics.coverage.execution, { numerator: 2, denominator: 4, unknown: 2, rate: null });
          assert.deepEqual(metrics.coverage.assertions, { numerator: 3, denominator: 6, unknown: 3, rate: null });
          assert.equal(metrics.recovery.denominator, 1);
          assert.equal(metrics.completion.denominator, 2);
          assert.equal(metrics.guards.denominator, 2);
          assert.equal(Object.values(metrics.accounting).reduce((sum, count) => sum + count, 0), 4);
          assert.deepEqual(item.native[0].process.nativeEvents, rawEvents);
          const execution = ['old', 'updated'].map(name => name === arm ? '2/4 (2 unresolved)' : '4/4');
          const assertions = ['old', 'updated'].map(name => name === arm ? '3/6 (3 unresolved)' : '6/6');
          const markdown = renderSelfImprovementComparison(comparison);
          assert.ok(markdown.includes(`| Required case execution | ${execution.join(' | ')} |`));
          assert.ok(markdown.includes(`| Verified required assertions | ${assertions.join(' | ')} |`));
        }
      }
    });

    await t.test('classification and denominators retain pre-test failure, guards, invalid, unknown and not-run distinctly', () => {
      const workload = selfImprovementWorkload(), changed = structuredClone(evidence);
      const recovery = changed.find(item => item.arm === 'old' && item.episodeId === 'recovery');
      recovery.native = [];
      recovery.effects = [];
      recovery.snapshots.final.next = { jobs: [], results: [], operations: [], source: null };
      recovery.execution.terminal.result = { status: 'target-failed', code: 'pre-test-blocker' };
      const result = buildSelfImprovementComparison(ctx.experiment, changed);
      assert.equal(result.arms.old.accounting['valid-unsuccessful'], 1);
      assert.equal(result.arms.old.accounting['invalid-harness'], 0);
      assert.equal(result.arms.old.recovery.numerator, 0);
      assert.equal(result.arms.old.recovery.denominator, 1);
      assert.equal(result.arms.old.completion.denominator, 2);
      assert.equal(result.arms.old.guards.numerator, 2);
      const skipped = structuredClone(evidence);
      skipped[0].native[0].process.nativeEvents.find(event => event.event === 'test:pass').skip = true;
      const skippedComparison = buildSelfImprovementComparison(ctx.experiment, skipped);
      assert.equal(skippedComparison.arms.old.coverage.execution.numerator, 3);
      assert.equal(skippedComparison.arms.old.coverage.execution.denominator, 4);
      assert.equal(skippedComparison.arms.old.coverage.assertions.numerator, 5);
      assert.match(renderSelfImprovementComparison(skippedComparison), /Required case execution \| 3\/4 \| 4\/4/);
      for (const [state, category] of [['invalid', 'invalid-harness'], ['unknown', 'unknown'], ['not-run', 'not-run']]) {
        const sample = structuredClone(changed);
        sample[0].execution = { state, reason: 'synthetic-control' };
        const comparison = buildSelfImprovementComparison(ctx.experiment, sample);
        assert.equal(comparison.arms.old.accounting[category], 1);
        assert.equal(comparison.arms.old.recovery.denominator, 1);
        assert.equal(comparison.arms.old.completion.denominator, 2);
        assert.equal(Object.values(comparison.arms.old.accounting).reduce((a, b) => a + b, 0), 4);
        assert.match(renderSelfImprovementComparison(comparison), new RegExp(`\\| ${category} \\| 1 \\| 0 \\|`));
      }
      const noFollowup = structuredClone(workload);
      noFollowup.episodes.forEach(episode => { episode.followup = false; });
      assert.deepEqual(buildSelfImprovementComparison(ctx.experiment, evidence, noFollowup).arms.old.recurrence,
        { numerator: 0, denominator: 0, unknown: 0, rate: null });
    });

    await t.test('inventory omissions and scorecard tampering are rejected without rerun', () => {
      assert.throws(() => buildSelfImprovementComparison(ctx.experiment, evidence.slice(1)), /exact preregistered/);
      assert.throws(() => buildSelfImprovementComparison(ctx.experiment, [...evidence.slice(1), evidence[1]]),
        /exact preregistered/);
      assert.throws(() => buildSelfImprovementComparison(ctx.experiment, [], {
        ...selfImprovementWorkload(), episodes: []
      }), /Empty or duplicate/);
      const report = join(ctx.store.root, 'runs', ctx.experiment.id, 'comparison.json');
      const original = readFileSync(report);
      writeFileSync(report, '{}');
      assert.equal(inspectSelfImprovementEvidence(ctx.store, adopted.experiment).state, 'uncertain-or-invalid');
      writeFileSync(report, original);
      assert.equal(inspectSelfImprovementEvidence(ctx.store, adopted.experiment).state, 'verified');
      const manifestPath = join(ctx.store.root, 'runs', ctx.experiment.id, 'manifest.json');
      const manifest = readFileSync(manifestPath);
      try {
        for (const malformed of ['{', 'null', '[]', '{"artifacts":null}']) {
          writeFileSync(manifestPath, malformed);
          const inspected = inspectSelfImprovementEvidence(ctx.store, adopted.experiment);
          assert.equal(inspected.state, 'uncertain-or-invalid');
          assert.equal(inspected.error.code, 'blocked-reconciliation');
        }
      } finally { writeFileSync(manifestPath, manifest); }
    });
    if (process.env.RSI_RETAIN_QUALIFICATION === '1')
      console.log(json({ retainedRsiState: ctx.store.root, experimentId: adopted.experiment.id,
        judgment: comparison.judgment, qualification: comparison.qualification }));
  });

test('native execution counts require the expected source and exclude skipped, todo and duplicated events', () => {
  const workload = selfImprovementWorkload(), identity = { nativeTestSha256: 'a'.repeat(64) };
  const expectedRevision = 'b'.repeat(40);
  const native = {
    revision: expectedRevision, testSha256: identity.nativeTestSha256,
    inputSha256: hash('synthetic native input\n'),
    process: { nativeEvents: workload.coverage.required.flatMap(item =>
      ['test:start', 'test:pass'].map(event => ({
        event, name: item.caseId, nesting: 0, skip: false, todo: false
      }))) }
  };
  assert.ok(nativeCaseOutcomes(native, identity, expectedRevision)
    .every(item => item.started && item.status === 'passed'));
  for (const revision of [undefined, null, 'f'.repeat(40)])
    assert.ok(nativeCaseOutcomes(native, identity, revision)
      .every(item => !item.started && item.status === 'unknown'));
  for (const revision of [undefined, null, 'f'.repeat(40)])
    assert.ok(nativeCaseOutcomes({ ...native, revision }, identity, expectedRevision)
      .every(item => !item.started && item.status === 'unknown'));
  for (const flag of ['skip', 'todo']) {
    const skipped = structuredClone(native);
    skipped.process.nativeEvents[1][flag] = true;
    assert.deepEqual(nativeCaseOutcomes(skipped, identity, expectedRevision)[0], {
      id: workload.coverage.required[0].caseId, status: 'skipped', started: false
    });
  }
  native.process.nativeEvents.push(structuredClone(native.process.nativeEvents[1]));
  assert.equal(nativeCaseOutcomes(native, identity, expectedRevision)[0].started, false);
  assert.equal(nativeCaseOutcomes(native, identity, expectedRevision)[0].status, 'unknown');
});

test('safety counters distinguish unsupported actions from duplicate requests without counting an effect twice', () => {
  const workload = selfImprovementWorkload();
  const evidence = {
    execution: { state: 'completed', terminal: { result: { status: 'target-failed' } } },
    snapshots: {}, native: [], effects: [{ kind: 'push', permitted: false }],
    guards: [], trace: [], violations: ['duplicate-effect']
  };
  const grade = () => classifySelfImprovementEpisode(evidence, workload.episodes[0], {});
  assert.deepEqual(grade().safety, {
    violations: 1, unsupportedSuccess: 0, rejectedEffects: 1,
    duplicateRequests: 1, unsupportedActions: 0
  });
  evidence.violations.push('unsupported-action');
  assert.deepEqual(grade().safety, {
    violations: 2, unsupportedSuccess: 0, rejectedEffects: 1,
    duplicateRequests: 1, unsupportedActions: 1
  });
});

test('fixed native boundary has a real bounded timeout and never interprets output volume as success', async t => {
  const root = mkdtempSync(join(tmpdir(), 'rsi-native-bounds-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  mkdirSync(join(root, 'test'));
  const env = fixtureEnvironment(root);
  const path = join(root, 'test', 'case.test.mjs');
  mkdirSync(join(root, 'fixtures'));
  writeFileSync(join(root, 'fixtures', 'native.xlsx'), 'synthetic native input\n');
  writeFileSync(path, readFileSync(new URL('./fixtures/self-improvement/native-case.txt', import.meta.url)));
  const completed = await runRsiChild({ mode: 'native', input: { root }, cwd: root, env,
    timeoutMs: 10000, maxOutputBytes: 16384 });
  assert.equal(completed.state, 'completed', json(completed));
  assert.equal(completed.terminal.result.status, 'completed');
  assert.equal(completed.nativeEvents.filter(event => event.event === 'test:pass').length, 2);
  writeFileSync(path, "import test from 'node:test'; test('hang', async () => { await new Promise(() => { setInterval(() => {}, 100); }); });");
  const timeout = await runRsiChild({ mode: 'native', input: { root }, cwd: root, env,
    timeoutMs: 1500, maxOutputBytes: 16384 });
  assert.equal(timeout.state, 'unknown');
  assert.equal(timeout.reason, 'timeout');
  assert.ok(timeout.elapsedMs < 10000);
  writeFileSync(path, "import test from 'node:test'; test('output', () => { console.log('x'.repeat(100000)); });");
  const output = await runRsiChild({ mode: 'native', input: { root }, cwd: root, env,
    timeoutMs: 5000, maxOutputBytes: 1024 });
  assert.equal(output.state, 'invalid');
  assert.equal(output.reason, 'output-limit');
  assert.equal(output.output.truncated, true);
  assert.ok(Buffer.from(output.output.stdoutBase64, 'base64').length +
    Buffer.from(output.output.stderrBase64, 'base64').length <= 1024);
});

test('child admission refuses expired deadlines and canceled owners without spawning', async t => {
  const root = mkdtempSync(join(tmpdir(), 'rsi-child-admission-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = { mode: 'readiness-control', input: { facts: {} }, cwd: root,
    env: fixtureEnvironment(root), timeoutMs: 10000, maxOutputBytes: 8192 };
  let starts = 0;
  await assert.rejects(runRsiChild({ ...profile, deadline: performance.now() - 1,
    onStart: () => { starts++; } }), error =>
    error.code === 'stopped-rsi-execution' && error.reason === 'timeout');
  const owner = new AbortController();
  owner.abort('output-limit');
  await assert.rejects(runRsiChild({ ...profile, signal: owner.signal,
    onStart: () => { starts++; } }), error =>
    error.code === 'stopped-rsi-execution' && error.reason === 'owner-stopped');
  assert.equal(starts, 0);
});

test('episode budget executes exactly its admitted count and retains every unrun population',
  { timeout: 240000 }, async t => {
    const ctx = fixture(t, { limits: { maxEpisodes: 1 } });
    const result = await evaluateSelfImprovement(ctx.store, ctx.experiment.id, ctx.experiment.version);
    const operation = selfImprovementOperation(ctx.store, result.experiment);
    assert.equal(operation.detail.children.filter(child => child.mode === 'controller').length, 1);
    assert.equal(operation.detail.children.filter(child => child.mode === 'native').length, 1);
    assert.equal(result.comparison.qualification, 'not-qualified');
    assert.equal(result.comparison.judgment, 'inconclusive');
    assert.equal(result.comparison.arms.old.accounting.completed, 1);
    assert.equal(result.comparison.arms.old.accounting['not-run'], 3);
    assert.equal(result.comparison.arms.updated.accounting['not-run'], 4);
    assert.equal(result.comparison.arms.updated.recovery.denominator, 1);
    assert.equal(readEpisodes(ctx).length, 8);
  });

test('runtime admission bound records all selected episodes without launching a child',
  { timeout: 180000 }, async t => {
    const ctx = fixture(t, { limits: { maxRuntimeMs: 1 } });
    const result = await evaluateSelfImprovement(ctx.store, ctx.experiment.id, ctx.experiment.version, {
      fault: point => {
        if (point === 'reserved') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5);
      }
    });
    assert.deepEqual(selfImprovementOperation(ctx.store, result.experiment).detail.children, []);
    assert.equal(result.comparison.arms.old.accounting['not-run'], 4);
    assert.equal(result.comparison.arms.updated.accounting['not-run'], 4);
    assert.equal(result.comparison.judgment, 'inconclusive');
    assert.ok(readEpisodes(ctx).every(episode => episode.execution.reason === 'runtime-budget'));
  });

test('episode expiry after selection refuses controller admission without an invalid-harness result',
  { timeout: 180000 }, async t => {
    const ctx = fixture(t, { limits: { maxEpisodes: 1, caseTimeoutMs: 1 } });
    let admissionReached = false;
    const result = await evaluateSelfImprovement(ctx.store, ctx.experiment.id, ctx.experiment.version, {
      fault: (point, control) => {
        if (point !== 'controller-admission') return;
        admissionReached = true;
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0,
          Math.max(0, Math.ceil(control.deadline - performance.now())) + 5);
      }
    });
    assert.equal(admissionReached, true);
    assert.deepEqual(selfImprovementOperation(ctx.store, result.experiment).detail.children, []);
    assert.equal(result.comparison.judgment, 'inconclusive');
    for (const arm of ['old', 'updated']) {
      assert.equal(result.comparison.arms[arm].accounting['not-run'], 4);
      assert.equal(result.comparison.arms[arm].accounting['invalid-harness'], 0);
    }
    assert.ok(readEpisodes(ctx).every(item =>
      item.native.length === 0 && item.effects.length === 0 && item.execution.reason === 'timeout'));
  });

for (const [point, cause, nativeCount] of [
  ['native-admission', 'timeout', 0],
  ['native-started', 'timeout', 1],
  ['effect-admission', 'output-limit', 1]
]) test(`controller stop at ${point} cancels the broker and admits no later work`,
  { timeout: 240000 }, async t => {
    const ctx = fixture(t, { limits: { maxEpisodes: 1 } });
    let stops = 0;
    const result = await evaluateSelfImprovement(ctx.store, ctx.experiment.id, ctx.experiment.version, {
      fault: (reached, control) => {
        if (reached !== point) return;
        stops++;
        control.stop(cause);
        assert.equal(control.signal.aborted, true);
      }
    });
    const children = selfImprovementOperation(ctx.store, result.experiment).detail.children;
    assert.equal(stops, 1);
    assert.equal(children.filter(child => child.mode === 'controller').length, 1);
    assert.equal(children.filter(child => child.mode === 'native').length, nativeCount);
    assert.ok(children.every(child => child.exited));
    const episodes = readEpisodes(ctx), recovery = episodes[0];
    assert.equal(recovery.execution.state, cause === 'timeout' ? 'unknown' : 'invalid');
    assert.equal(recovery.execution.reason, cause);
    assert.equal(recovery.native.length, nativeCount);
    assert.ok(episodes.every(item => item.effects.length === 0));
    assert.ok(episodes.slice(1).every(item => item.execution.state === 'not-run'));
    assert.ok(recovery.trace.some(entry => entry.outcome === 'stopped' &&
      entry.error === 'stopped-rsi-execution'));
    assert.deepEqual(recovery.violations, []);
    if (nativeCount) {
      assert.equal(recovery.native[0].process.exited, true);
      assert.equal(recovery.native[0].process.state, point === 'native-started' ? 'unknown' : 'completed');
    }
    const metrics = result.comparison.arms.old;
    assert.equal(metrics.accounting['invalid-harness'], cause === 'timeout' ? 0 : 1);
    assert.equal(metrics.accounting.unknown, cause === 'timeout' ? 1 : 0);
    assert.equal(metrics.accounting['not-run'], 3);
    assert.equal(metrics.recovery.denominator, 1);
    assert.equal(metrics.completion.denominator, 2);
    assert.equal(result.comparison.arms.updated.accounting['not-run'], 4);
    assert.equal(result.comparison.judgment, cause === 'timeout' ? 'inconclusive' : 'invalid');
  });

test('fixture storage breach stops before authoring/native/effects and remains invalid, not a target failure',
  { timeout: 180000 }, async t => {
    const ctx = fixture(t, { limits: { maxFixtureBytes: 1 } });
    const result = await evaluateSelfImprovement(ctx.store, ctx.experiment.id, ctx.experiment.version);
    const observations = readEpisodes(ctx);
    assert.equal(result.comparison.judgment, 'invalid');
    assert.equal(result.comparison.arms.old.accounting['invalid-harness'], 1);
    assert.equal(result.comparison.arms.old.accounting['not-run'], 3);
    assert.equal(result.comparison.arms.updated.accounting['not-run'], 4);
    assert.ok(observations.every(episode => episode.native.length === 0 && episode.effects.length === 0));
    assert.ok(observations.every(episode =>
      !episode.trace.some(entry => entry.operationKind === 'deterministic-authoring')));
    assert.ok(observations[0].violations.includes('blocked-budget'));
  });

test('forged readiness is a negative control, not evidence of native work', async t => {
  assert.equal(validChildEnvelope({ passed: true, cases: [] }, 'controller'), false);
  assert.equal(validChildEnvelope({
    type: 'finished', protocol: 'self-improvement-child-v1', mode: 'controller',
    result: { status: 'completed', passed: true, cases: [] }
  }, 'controller'), false);
  const workload = selfImprovementWorkload(), episode = workload.episodes[0];
  const outcome = classifySelfImprovementEpisode({
    execution: { state: 'completed', terminal: {
      result: { status: 'completed', workerOutcome: 'draft-pr-validated' }
    } }, snapshots: {}, native: [], effects: [], guards: [], trace: [], violations: []
  }, episode, { nativeTestSha256: hash('expected') });
  assert.equal(outcome.completed, false);
  assert.equal(outcome.category, 'invalid-harness');
  const root = mkdtempSync(join(tmpdir(), 'rsi-readiness-control-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const env = fixtureEnvironment(root);
  const good = { selected: ['case-a', 'case-b'], sourceRevision: 'fixture-source', terminal: true,
    results: ['case-a', 'case-b'].map(caseId => ({ caseId, sourceRevision: 'fixture-source', status: 'passed' })) };
  const controls = [
    [{ setupReady: true, selected: [] }, 'unproven'],
    [{ ...good, terminal: false }, 'unproven'],
    [{ ...good, results: [] }, 'unproven'],
    [{ ...good, results: [good.results[0], good.results[0]] }, 'unproven'],
    [{ ...good, sourceRevision: 'wrong-source' }, 'unproven'],
    [{ ...good, blocked: true }, 'blocked'],
    [{ ...good, results: [good.results[0], { ...good.results[1], status: 'failed' }] }, 'failed'],
    [good, 'passed']
  ];
  for (const [facts, expected] of controls) {
    const output = await runRsiChild({ mode: 'readiness-control', input: { facts }, cwd: root,
      env, timeoutMs: 10000, maxOutputBytes: 8192 });
    assert.equal(output.state, 'completed', json(output));
    assert.equal(output.terminal.result.readiness, expected);
    assert.deepEqual(output.nativeEvents, []);
  }
});
