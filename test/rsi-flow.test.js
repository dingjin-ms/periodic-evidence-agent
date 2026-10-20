import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { configAt, hash, json } from '../src/common.js';
import { beginApp, openApp, endApp, appendApp } from '../src/app-native.js';
import { bindRsiProducer, rsiWork, rsiPolicy } from '../src/rsi-flow.js';
import { principalPath } from '../src/runtime.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
const appModule = new URL('../src/app-native.js', import.meta.url).href;
const policy = JSON.parse(readFileSync(new URL('../scaffold/rsi-flow.example.json', import.meta.url)));

function fixture(t, configure = () => {}) {
  const root = realpathSync.native(mkdtempSync(join(tmpdir(), 'rsi-flow-')));
  const config = configAt('pilot.example.json');
  config.stateDirectory = join(root, 'state');
  config.statePolicy.accessApproved = true;
  config.repositories = [];
  config.rsi = { ...policy, targetRepository: 'fixture/rsi-agent' };
  const referenceCheckout = join(root, 'reference');
  mkdirSync(join(referenceCheckout, 'test'), { recursive: true });
  writeFileSync(join(referenceCheckout, 'test', 'coverage.txt'), 'original fixture\n');
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=.git/no-hooks',
    '-c', 'core.autocrlf=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
  { cwd: referenceCheckout, encoding: 'utf8', timeout: 10000, windowsHide: true }).trim();
  git(['init', '-b', 'main', '--quiet']);
  git(['remote', 'add', 'origin', 'https://github.com/fixture/rsi-agent.git']);
  git(['add', '.']); git(['commit', '--quiet', '-m', 'Fixture baseline']);
  config.rsi.targetBaseline = { referenceCheckout, revision: git(['rev-parse', 'HEAD']), branch: 'main' };
  configure(config);
  beginApp(config, { runId: 'flow', dryRun: true, provenance: 'synthetic' });
  const ctx = { root, config, ...openApp(config, 'flow') };
  ctx.reopen = () => {
    ctx.ledger.close();
    ctx.ledger = openApp(config, 'flow').ledger;
  };
  t.after(() => {
    ctx.ledger.close();
    rmSync(root, { recursive: true, force: true });
  });
  ctx.capture = () => endApp(config, ctx.ledger, 'flow').rsi;
  ctx.request = observationId => ({ observationId, claimId: 'claim', executorId: 'host' });
  return ctx;
}

function candidate(ctx, protectedAncestor = false) {
  const workspace = join(ctx.root, 'candidate');
  execFileSync('git', ['clone', '--quiet', '--no-hardlinks', ctx.config.rsi.targetBaseline.referenceCheckout, workspace],
    { encoding: 'utf8', windowsHide: true, timeout: 10000 });
  const git = args => execFileSync('git', [
    '-c', 'core.hooksPath=.git/no-hooks', '-c', 'core.autocrlf=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args
  ], { cwd: workspace, encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  git(['remote', 'set-url', 'origin', 'https://github.com/fixture/rsi-agent.git']);
  if (protectedAncestor) {
    mkdirSync(join(workspace, 'src'), { recursive: true });
    writeFileSync(join(workspace, 'src', 'common.js'), '// protected ancestor change\n');
    git(['add', '.']); git(['commit', '--quiet', '-m', 'Protected ancestor']);
  }
  const baselineRevision = git(['rev-parse', 'HEAD']);
  writeFileSync(join(workspace, 'test', 'coverage.txt'), 'expanded fixture\n');
  git(['add', '.']); git(['commit', '--quiet', '-m', 'Fixture candidate']);
  return { workspace, baselineRevision, candidateRevision: git(['rev-parse', 'HEAD']), git };
}

function proposal(ctx, request) {
  const { git, ...source } = candidate(ctx);
  return {
    ...request, kind: 'improvement', failureFamily: 'missing-phase-evidence',
    title: 'Improve fixture coverage', rationale: 'Synthetic protocol test; no real improvement is claimed.',
    ...source, changedFiles: ['test/coverage.txt'],
    artifacts: [{ role: 'analysis', ref: 'fixture:analysis', sha256: hash('fixture analysis') }]
  };
}

test('a caller cannot hide a protected ancestor behind a substituted baseline', t => {
  const ctx = fixture(t, config => { config.rsi.allowDraftPR = true; });
  const request = ctx.request(ctx.capture().observationId);
  rsiWork(ctx.config, ctx.ledger, 'claim', request);
  const { git, ...source } = candidate(ctx, true);
  const input = { ...request, ...source, kind: 'fix', failureFamily: 'hidden-ancestor',
    title: 'Fixture candidate', rationale: 'Regression for caller-selected baseline substitution.',
    changedFiles: ['test/coverage.txt'],
    artifacts: [{ role: 'analysis', ref: 'fixture:analysis', sha256: hash('fixture') }] };
  assert.throws(() => rsiWork(ctx.config, ctx.ledger, 'propose', input), /independently pinned/);
  assert.throws(() => rsiWork(ctx.config, ctx.ledger, 'propose', {
    ...input, baselineRevision: ctx.config.rsi.targetBaseline.revision
  }), /actual candidate diff/);
  assert.throws(() => rsiWork(ctx.config, ctx.ledger, 'propose', {
    ...input, baselineRevision: ctx.config.rsi.targetBaseline.revision,
    changedFiles: ['src/common.js', 'test/coverage.txt']
  }), /judge\/authority/);
  assert.equal(ctx.ledger.latest('rsiWorkItem')[0].state, 'claimed');
});

test('target advancement invalidates draft admission including a previous reservation', t => {
  const ctx = fixture(t, config => { config.rsi.allowDraftPR = true; });
  const request = ctx.request(ctx.capture().observationId);
  rsiWork(ctx.config, ctx.ledger, 'claim', request);
  rsiWork(ctx.config, ctx.ledger, 'propose', proposal(ctx, request));
  rsiWork(ctx.config, ctx.ledger, 'reserve-publication', request);
  const reference = ctx.config.rsi.targetBaseline.referenceCheckout;
  writeFileSync(join(reference, 'test', 'coverage.txt'), 'new target state\n');
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=.git/no-hooks',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
  { cwd: reference, encoding: 'utf8', windowsHide: true, timeout: 10000 });
  git(['add', '.']); git(['commit', '--quiet', '-m', 'Target advanced']);
  assert.throws(() => rsiWork(ctx.config, ctx.ledger, 'reserve-publication', request), /target baseline is stale/);
  assert.equal(ctx.ledger.latest('rsiWorkItem')[0].state, 'publishing');
});

test('candidate and draft verification preserve the existing Git long-path contract', t => {
  const ctx = fixture(t, config => { config.rsi.allowDraftPR = true; });
  const request = ctx.request(ctx.capture().observationId);
  rsiWork(ctx.config, ctx.ledger, 'claim', request);
  const input = proposal(ctx, request);
  const parent = join(ctx.root, 'nested-'.repeat(Math.ceil((220 - ctx.root.length) / 7)));
  mkdirSync(parent);
  const workspace = join(parent, 'candidate');
  renameSync(input.workspace, workspace);
  assert.ok(workspace.length >= 220);
  assert.equal(rsiWork(ctx.config, ctx.ledger, 'propose', { ...input, workspace }).state, 'proposed');
  assert.equal(rsiWork(ctx.config, ctx.ledger, 'reserve-publication', request).createAllowed, true);
});

for (const operation of ['claim', 'propose', 'reserve-publication']) {
  test(`expiry during ${operation} verification refuses the next Git child and state effect`, t => {
    const ctx = fixture(t, config => { config.rsi.allowDraftPR = true; });
    const request = ctx.request(ctx.capture().observationId);
    const input = operation === 'propose' ? proposal(ctx, request) : request;
    if (operation !== 'claim') rsiWork(ctx.config, ctx.ledger, 'claim', request);
    if (operation === 'reserve-publication') rsiWork(ctx.config, ctx.ledger, 'propose', proposal(ctx, request));
    const original = json(ctx.ledger.latest('rsiWorkItem'));
    t.mock.timers.enable({ apis: ['Date'] });
    const deadline = Date.now() + 8000;
    const native = execFileSync;
    const commands = t.mock.method(childProcess, 'execFileSync', (executable, args, options) => {
      assert.equal(executable, 'git');
      assert.equal(options.timeout, 8000);
      const result = native(executable, args, options);
      t.mock.timers.setTime(deadline);
      return result;
    });
    syncBuiltinESMExports();
    t.after(() => { commands.mock.restore(); syncBuiltinESMExports(); });
    const admit = () => {
      const left = deadline - Date.now();
      if (left <= 0) throw Object.assign(new Error('Expired fixture admission'), { code: 'blocked-budget' });
      return left;
    };
    assert.throws(() => rsiWork(ctx.config, ctx.ledger, operation, input, { admit }), { code: 'blocked-budget' });
    assert.equal(commands.mock.callCount(), 1);
    assert.equal(json(ctx.ledger.latest('rsiWorkItem')), original);
  });
}

test('RSI disabled is inert; malformed policy cannot enable it', t => {
  const ctx = fixture(t, config => { config.rsi = { enabled: false }; });
  assert.equal(ctx.ledger.all('rsiFlowBinding').length, 0);
  assert.equal(bindRsiProducer(ctx.config, ctx.ledger, 'app-flow', 'flow'), null);
  assert.equal(ctx.capture().state, 'disabled');
  assert.throws(() => rsiWork(ctx.config, ctx.ledger, 'status'), /disabled/);
  assert.throws(() => rsiPolicy({ ...ctx.config, rsi: { enabled: true } }), /Invalid rsiPolicy/);
});

test('app flow outcomes become pinned RSI inputs without asserting missing execution', t => {
  const ctx = fixture(t);
  const delivery = ctx.capture();
  assert.equal(delivery.nextRole, 'rsi');
  assert.equal(delivery.skill.name, 'evidence-rsi');
  assert.equal(delivery.modelExecutedByHelper, false);
  const inspected = rsiWork(ctx.config, ctx.ledger, 'inspect', { observationId: delivery.observationId });
  assert.equal(inspected.observation.payload.outcome, 'partial-or-blocked');
  assert.ok(inspected.observation.payload.data.summary.collection.every(row =>
    row.state === 'not-started' && row.evidenceCount === null));
  assert.equal(inspected.observation.payload.data.run.provenance, 'synthetic');
  assert.equal(inspected.binding.controller.skillSha256, delivery.skill.sha256);
  assert.equal(inspected.qualification, 'not-inferred');
  assert.equal(hash(json(inspected.observation.payload)), delivery.payloadSha256);
  const status = rsiWork(ctx.config, ctx.ledger, 'status');
  assert.equal(status.observations[0].payload, undefined);
  assert.equal(status.pending.length, 1);
});

test('failed collection receipts reach RSI with unknown coverage intact', async t => {
  const ctx = fixture(t, config => {
    config.sources.workiq.enabled = true;
    config.sources.workiq.scopeApproved = true;
  });
  await appendApp(ctx.config, ctx.ledger, 'flow', {
    eventId: 'auth-failure', pass: 'workiq:created', calls: [{
      id: 'me', observedAt: '2026-10-09T09:00:00Z', tool: 'workiq-fetch',
      request: { entityUrls: [principalPath] },
      failure: { code: 'blocked-auth', statusCode: 500 }
    }]
  });
  const delivery = ctx.capture();
  const { observation } = rsiWork(ctx.config, ctx.ledger, 'inspect', { observationId: delivery.observationId });
  const summary = observation.payload.data.summary;
  assert.equal(summary.collection.find(row => row.pass === 'workiq:created').state, 'blocked-auth');
  assert.equal(summary.workers.length, 0);
  assert.equal(observation.payload.data.events.length, 1);
  assert.ok(summary.collection.some(row => row.state === 'not-started' && row.evidenceCount === null));
});

test('two capture/resume cycles need no manual artifact transfer or duplicate task', t => {
  const ctx = fixture(t);
  for (let cycle = 0; cycle < 2; cycle++) {
    const runId = cycle ? 'next-flow' : 'flow';
    if (cycle) beginApp(ctx.config, { runId, dryRun: true, provenance: 'synthetic' });
    const current = cycle ? openApp(ctx.config, runId).ledger : ctx.ledger;
    const first = endApp(ctx.config, current, runId).rsi;
    if (cycle) current.close(); else ctx.ledger.close();
    const reopened = openApp(ctx.config, runId).ledger;
    if (!cycle) ctx.ledger = reopened;
    const second = endApp(ctx.config, reopened, runId).rsi;
    assert.deepEqual(second, first);
    assert.equal(reopened.all('rsiFlowObservation').length, 1);
    assert.equal(reopened.latest('rsiWorkItem').length, 1);
    const request = { observationId: first.observationId, claimId: `claim-${cycle}`, executorId: 'host' };
    rsiWork(ctx.config, reopened, 'claim', request);
    const result = rsiWork(ctx.config, reopened, 'result', {
      ...request, outcome: 'insufficient-evidence',
      rationale: 'Source passes have not executed; do not manufacture an improvement.'
    });
    assert.equal(result.state, 'finished');
    assert.equal(endApp(ctx.config, reopened, runId).rsi.nextRole, null);
    if (cycle) reopened.close();
  }
});

test('abrupt process exit after durable capture replays from committed state', t => {
  const ctx = fixture(t);
  ctx.ledger.close();
  const configFile = join(ctx.root, 'config.json');
  writeFileSync(configFile, json(ctx.config));
  const source = `
    import { readFileSync } from 'node:fs';
    import { openApp, endApp } from ${JSON.stringify(appModule)};
    const config = JSON.parse(readFileSync(process.argv[1], 'utf8'));
    const { ledger } = openApp(config, 'flow');
    endApp(config, ledger, 'flow');
    process.exit(37);
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, configFile],
    { encoding: 'utf8', timeout: 30000, windowsHide: true });
  ctx.ledger = openApp(ctx.config, 'flow').ledger;
  assert.equal(child.status, 37, child.stderr);
  const before = ctx.ledger.all('rsiFlowObservation')[0];
  assert.ok(before);
  assert.equal(ctx.capture().observationId, before.id);
  assert.equal(ctx.ledger.all('rsiFlowObservation').length, 1);
  assert.equal(ctx.ledger.all('rsiWorkItem').length, 1);
});

test('claims resume only for the exact executor and one task at a time', t => {
  const ctx = fixture(t);
  const observationId = ctx.capture().observationId;
  const request = ctx.request(observationId);
  const first = rsiWork(ctx.config, ctx.ledger, 'claim', request);
  ctx.reopen();
  assert.deepEqual(rsiWork(ctx.config, ctx.ledger, 'claim', request), first);
  assert.throws(() => rsiWork(ctx.config, ctx.ledger, 'claim', { ...request, executorId: 'other' }), /executor changed/);
  assert.throws(() => rsiWork(ctx.config, ctx.ledger, 'result', {
    ...request, claimId: 'other', outcome: 'no-change', rationale: 'Not the owning claim'
  }), /executor changed/);
  assert.equal(ctx.ledger.latest('rsiWorkItem')[0].state, 'claimed');
});

test('producer discovery distinguishes unknown execution from recoverable outcome delivery', t => {
  const ctx = fixture(t);
  bindRsiProducer(ctx.config, ctx.ledger, 'worker', 'unfinished-worker');
  const status = rsiWork(ctx.config, ctx.ledger, 'status');
  assert.equal(status.undelivered.length, 0);
  assert.equal(status.pending.length, 0);
  assert.equal(status.unresolvedProducers.length, 1);
  assert.equal(status.unresolvedProducers[0].state, 'execution-unreconciled');
  assert.equal(status.unresolvedProducers[0].assignmentId, 'unfinished-worker');
  assert.match(status.unresolvedProducers[0].nextAction, /never redispatch/);
  assert.equal(ctx.ledger.all('rsiWorkItem').length, 0);
});

test('proposal and publication use a clean scoped candidate and an irreversible reservation', t => {
  const ctx = fixture(t, config => { config.rsi.allowDraftPR = true; });
  const request = ctx.request(ctx.capture().observationId);
  rsiWork(ctx.config, ctx.ledger, 'claim', request);
  const input = proposal(ctx, request);
  assert.throws(() => rsiWork(ctx.config, ctx.ledger, 'propose', {
    ...input, candidateRevision: input.baselineRevision
  }), /current\/current/);
  assert.throws(() => rsiWork(ctx.config, ctx.ledger, 'propose', {
    ...input, changedFiles: ['src/common.js']
  }), /judge\/authority/);
  assert.throws(() => rsiWork(ctx.config, ctx.ledger, 'propose', {
    ...input, changedFiles: ['test/not-the-diff.txt']
  }), /actual candidate diff/);
  const proposed = rsiWork(ctx.config, ctx.ledger, 'propose', input);
  assert.equal(proposed.state, 'proposed');
  assert.equal(proposed.qualification, undefined);
  assert.deepEqual(rsiWork(ctx.config, ctx.ledger, 'propose', input), proposed);
  const reservation = rsiWork(ctx.config, ctx.ledger, 'reserve-publication', request);
  assert.equal(reservation.createAllowed, true);
  assert.equal(reservation.mergeAllowed, false);
  assert.equal(reservation.qualification, 'unverified-proposal');
  ctx.reopen();
  const resumed = rsiWork(ctx.config, ctx.ledger, 'reserve-publication', request);
  assert.equal(resumed.createAllowed, false);
  assert.equal(resumed.publicationKey, reservation.publicationKey);
  assert.throws(() => rsiWork(ctx.config, ctx.ledger, 'result', {
    ...request, outcome: 'blocked', rationale: 'Lost publication response'
  }), /publication must be reconciled/);
  const result = {
    ...request, outcome: 'draft-reported', rationale: 'Synthetic receipt; no GitHub write occurred.',
    draftPR: {
      url: 'https://github.com/fixture/rsi-agent/pull/1', isDraft: true,
      headRevision: input.candidateRevision, publicationKey: reservation.publicationKey
    }
  };
  assert.throws(() => rsiWork(ctx.config, ctx.ledger, 'result', {
    ...result, draftPR: { ...result.draftPR, headRevision: 'f'.repeat(40) }
  }), /candidate\/publication identity/);
  assert.throws(() => rsiWork(ctx.config, ctx.ledger, 'result', {
    ...result, draftPR: { ...result.draftPR, url: 'https://github.com/other/repo/pull/1' }
  }), /configured repository/);
  const finished = rsiWork(ctx.config, ctx.ledger, 'result', result);
  assert.equal(finished.state, 'finished');
  assert.deepEqual(rsiWork(ctx.config, ctx.ledger, 'result', result), finished);
  assert.equal(rsiWork(ctx.config, ctx.ledger, 'status').pending.length, 0);
});

test('draft permission is not implied by an enabled RSI skill', t => {
  const ctx = fixture(t);
  const request = ctx.request(ctx.capture().observationId);
  rsiWork(ctx.config, ctx.ledger, 'claim', request);
  rsiWork(ctx.config, ctx.ledger, 'propose', proposal(ctx, request));
  assert.throws(() => rsiWork(ctx.config, ctx.ledger, 'reserve-publication', request), /not authorized/);
  assert.equal(ctx.ledger.latest('rsiWorkItem')[0].state, 'proposed');
});

test('source/config conflicts, missing bindings and budgets cannot rewrite an outcome', t => {
  const ctx = fixture(t);
  const delivery = ctx.capture();
  const original = json(ctx.ledger.all('rsiFlowObservation'));
  assert.throws(() => rsiWork({
    ...ctx.config, rsi: { ...ctx.config.rsi, maxProposals: 3 }
  }, ctx.ledger, 'claim', ctx.request(delivery.observationId)), /original pre-execution/);
  const binding = ctx.ledger.all('rsiFlowBinding')[0];
  assert.throws(() => ctx.ledger.put({ ...binding, controller: {
    ...binding.controller, sourceSha256: 'f'.repeat(64)
  } }), /Immutable record/);
  assert.throws(() => rsiWork(ctx.config, ctx.ledger, 'capture', { workerResultId: 'absent' }), /Unknown immutable/);
  assert.equal(json(ctx.ledger.all('rsiFlowObservation')), original);
  const exhausted = fixture(t, config => { config.rsi.maxObservations = 1; });
  assert.throws(() => bindRsiProducer(exhausted.config, exhausted.ledger, 'worker', 'second'), /bound reached/);
  assert.equal(exhausted.ledger.all('rsiFlowBinding').length, 1);
});

test('failed RSI admission cannot leave an executable app run without its binding', t => {
  const ctx = fixture(t, config => {
    config.activation.collect = true;
    config.limits.maxItems = 20;
    config.limits.maxCalls = 20;
    config.rsi.maxObservations = 1;
  });
  const admitted = { runId: 'admitted', dryRun: false, provenance: 'synthetic' };
  beginApp(ctx.config, admitted);
  const shared = openApp(ctx.config, 'admitted', false).ledger;
  try {
    assert.throws(() => beginApp(ctx.config, {
      ...admitted, runId: 'refused'
    }), /admission bound reached/);
    assert.equal(shared.db.prepare('SELECT COUNT(*) n FROM app_runs').get().n, 1);
    assert.equal(shared.all('rsiFlowBinding').length, 1);
    assert.throws(() => openApp(ctx.config, 'refused', false), /Unknown app-native run/);
    beginApp(ctx.config, admitted);
    assert.equal(shared.db.prepare('SELECT COUNT(*) n FROM app_runs').get().n, 1);
  } finally { shared.close(); }
});

test('status retains historical skill pins and never schedules a stale-controller task', t => {
  const ctx = fixture(t);
  const current = ctx.capture();
  const original = rsiWork(ctx.config, ctx.ledger, 'inspect', { observationId: current.observationId });
  const binding = ctx.ledger.put({
    ...original.binding, id: `rsi-flow-${hash(json(['app-flow', 'historical']))}`, flowId: 'historical',
    controller: { ...original.binding.controller, sourceSha256: 'e'.repeat(64), skillSha256: 'f'.repeat(64) }
  });
  const observation = ctx.ledger.put({
    ...original.observation,
    id: `rsi-observation-${hash(json([binding.id, original.observation.payloadSha256]))}`,
    bindingId: binding.id
  });
  ctx.ledger.put({ ...original.work, id: `rsi-task-${hash(observation.id)}`, observationId: observation.id });
  ctx.reopen();
  const pending = rsiWork(ctx.config, ctx.ledger, 'status').pending;
  const stale = pending.find(row => row.observationId === observation.id);
  assert.equal(stale.bindingState, 'stale-controller');
  assert.equal(stale.invocation, 'blocked-stale-controller');
  assert.equal(stale.nextRole, null);
  assert.equal(stale.skill.sha256, binding.controller.skillSha256);
  assert.deepEqual(stale.controller, binding.controller);
  assert.equal(pending.find(row => row.observationId === current.observationId).nextRole, 'rsi');
  assert.throws(() => rsiWork(ctx.config, ctx.ledger, 'claim',
    ctx.request(observation.id)), /original pre-execution/);
  assert.deepEqual(ctx.ledger.get('rsiFlowObservation', observation.id), observation);
});

for (const maxObservationBytes of [4096, 1048576]) test(
  `oversized flow capture at ${maxObservationBytes} bytes is refused atomically without dropping producer state`, t => {
  const ctx = fixture(t, config => { config.rsi.maxObservationBytes = maxObservationBytes; });
  ctx.ledger.db.prepare('INSERT INTO app_events VALUES(?,?,?,?)').run('large-source-event',
    'flow', 'workiq:created', json({ fixturePayload: 'x'.repeat(maxObservationBytes) }));
  assert.throws(() => ctx.capture(), /byte bound/);
  assert.equal(ctx.ledger.all('rsiFlowObservation').length, 0);
  assert.equal(ctx.ledger.all('rsiWorkItem').length, 0);
  assert.equal(ctx.ledger.db.prepare('SELECT COUNT(*) n FROM app_events').get().n, 1);
});

test('app-scoped RSI operations cannot inspect or claim another run in a shared ledger', t => {
  const ctx = fixture(t, config => {
    config.activation.collect = true;
    config.limits.maxItems = 20;
    config.limits.maxCalls = 20;
  });
  for (const runId of ['first-live-shaped', 'second-live-shaped'])
    beginApp(ctx.config, { runId, dryRun: false, provenance: 'synthetic' });
  const shared = openApp(ctx.config, 'first-live-shaped', false).ledger;
  try {
    const first = endApp(ctx.config, shared, 'first-live-shaped').rsi;
    const second = endApp(ctx.config, shared, 'second-live-shaped').rsi;
    const scope = { runId: 'second-live-shaped' };
    const status = rsiWork(ctx.config, shared, 'status', {}, scope);
    assert.deepEqual(status.observations.map(row => row.id), [second.observationId]);
    assert.throws(() => rsiWork(ctx.config, shared, 'inspect',
      { observationId: first.observationId }, scope), /different app run/);
    assert.throws(() => rsiWork(ctx.config, shared, 'claim',
      ctx.request(first.observationId), scope), /different app run/);
    assert.equal(shared.latest('rsiWorkItem').filter(row => row.state === 'queued').length, 2);
  } finally { shared.close(); }
});

test('app captures do not copy unrelated report rows from a shared ledger', t => {
  const ctx = fixture(t);
  const original = ctx.ledger.candidates;
  // The producer's general report can contain rows from other app runs.
  ctx.ledger.candidates = () => [{
    id: 'other-run-evidence', source: { namespace: 'fixture', recordId: 'other' },
    title: 'Unrelated source', missingFields: [], links: []
  }];
  try {
    const delivery = ctx.capture();
    const captured = rsiWork(ctx.config, ctx.ledger, 'inspect', { observationId: delivery.observationId });
    assert.deepEqual(captured.observation.payload.data.summary.report.issues, []);
    assert.deepEqual(captured.observation.payload.data.summary.report.summary.candidateIds, []);
  } finally { ctx.ledger.candidates = original; }
});

test('CLI role handoff stays in the original dry-run namespace', t => {
  const ctx = fixture(t);
  const configFile = join(ctx.root, 'config.json');
  writeFileSync(configFile, json(ctx.config));
  const invoke = args => spawnSync(process.execPath, ['--no-warnings', cli, ...args, '--config', configFile],
    { encoding: 'utf8', timeout: 30000, windowsHide: true });
  const ended = invoke(['agent', 'collector', 'app-end', '--run', 'flow']);
  assert.equal(ended.status, 2, ended.stderr);
  const delivery = JSON.parse(ended.stdout).result.rsi;
  assert.equal(delivery.nextRole, 'rsi');
  const inspected = invoke(['agent', 'rsi', 'app-rsi-work', '--run', 'flow', '--operation', 'status']);
  assert.equal(inspected.status, 0, inspected.stderr);
  const status = JSON.parse(inspected.stdout);
  assert.equal(status.role, 'rsi');
  assert.equal(status.result.observations.length, 1);
  const recursive = invoke(['agent', 'rsi', 'app-end', '--run', 'flow']);
  assert.equal(recursive.status, 1);
  assert.match(recursive.stderr, /blocked-agent/);
});

test('CLI refuses a qualification-root marker before opening or pruning state', t => {
  const ctx = fixture(t);
  const state = join(ctx.root, 'protected-state');
  mkdirSync(state);
  const marker = join(state, '.rsi-root.json');
  writeFileSync(marker, '{"fixture":"do-not-open"}');
  const configFile = join(ctx.root, 'protected-config.json');
  writeFileSync(configFile, json({ ...ctx.config, stateDirectory: state }));
  const child = spawnSync(process.execPath, ['--no-warnings', cli, 'agent', 'rsi', 'rsi-work',
    '--operation', 'status', '--config', configFile],
  { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(child.status, 1, child.stderr);
  assert.match(child.stderr, /qualification root/);
  assert.deepEqual(readFileSync(marker, 'utf8'), '{"fixture":"do-not-open"}');
  assert.equal(existsSync(join(state, 'ledger.sqlite')), false);
  assert.equal(ctx.ledger.all('rsiFlowObservation').length, 0);
});

test('CLI rejects malformed or disabled RSI requests before opening state', t => {
  const ctx = fixture(t);
  const stateDirectory = join(ctx.root, 'unopened-state');
  const configFile = join(ctx.root, 'preflight-config.json');
  writeFileSync(configFile, json({ ...ctx.config, stateDirectory, rsi: { enabled: false } }));
  const cases = [
    { args: ['rsi-work', '--operation', 'status', '--unexpected'], error: /Unknown or duplicate/ },
    { args: ['rsi-work', '--operation', 'status', '--operation', 'status'], error: /Unknown or duplicate/ },
    { args: ['rsi-work', '--operation'], error: /requires a value/ },
    { args: ['rsi-work', '--operation', 'status', '--file', 'absent.json'], error: /status takes no file/ },
    { args: ['app-rsi-work', '--run', 'absent', '--operation', 'capture', '--file', 'absent.json'],
      error: /Unknown RSI work operation/ },
    { args: ['rsi-work', '--operation', 'status'], error: /RSI is disabled/ }
  ];
  for (const { args, error } of cases) {
    const child = spawnSync(process.execPath, ['--no-warnings', cli, 'agent', 'rsi',
      ...args, '--config', configFile], { encoding: 'utf8', timeout: 30000, windowsHide: true });
    assert.equal(child.status, 1, child.stderr);
    assert.match(child.stderr, error);
    assert.equal(existsSync(stateDirectory), false);
  }
});
