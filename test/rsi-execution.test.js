import test from 'node:test';
import assert from 'node:assert/strict';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { connect } from 'node:net';
import childProcess, { execFileSync, spawnSync } from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import { fileURLToPath } from 'node:url';
import { configAt, hash, json } from '../src/common.js';
import { beginApp, endApp, finishApp, openApp } from '../src/app-native.js';
import { rsiWork } from '../src/rsi-flow.js';
import { runRsiPending } from '../src/rsi-execution.js';
import { principalPath, channelRoot } from '../src/runtime.js';

const broken = `export async function runFlow(input) {
  const events = ['selected'];
  if (input.refuse) return { events: [...events, 'refused'], value: null };
  const recoveryEnabled = false;
  if (input.recovery && !recoveryEnabled) return { events: [...events, 'failed'], value: null };
  events.push('started');
  const value = input.values.reduce((total, next) => total + next, 0);
  return { events: [...events, 'completed'], value };
}\n`;
const fixed = broken.replace('recoveryEnabled = false', 'recoveryEnabled = true');
const driver = `import { pathToFileURL } from 'node:url';
import { join } from 'node:path';
export async function runFlow({ workspace, cases }) {
  const flow = await import(pathToFileURL(join(workspace, 'src', 'flow.mjs')).href);
  const results = [];
  for (const selected of cases) {
    const value = await flow.runFlow({ values: [1, 2, 3],
      recovery: selected.population === 'recovery', refuse: selected.population === 'guard' });
    const guard = selected.population === 'guard';
    const passed = guard ? value.events.at(-1) === 'refused' && value.value === null :
      value.events.at(-1) === 'completed' && value.value === 6;
    const started = guard || value.events.includes('started');
    results.push({ id: selected.id, started, outcome: passed ? 'passed' : 'failed',
      assertions: selected.assertions.map(id => ({ id, state: passed ? 'passed' : started ? 'failed' : 'not-run' })) });
  }
  return { cases: results, violations: [] };
}\n`;
async function rpc(endpoint, token, tool, args) {
  return new Promise((resolve, reject) => {
    const socket = connect(endpoint);
    let output = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(JSON.stringify({ id: 'fixture', token, tool, args }) + '\n'));
    socket.on('data', chunk => { output += chunk; });
    socket.on('error', reject);
    socket.on('close', () => {
      try {
        const response = JSON.parse(output);
        if (!response.ok) reject(new Error(JSON.stringify(response.error)));
        else resolve(response.result);
      } catch (error) { reject(error); }
    });
  });
}
const decision = {
  outcome: 'propose-change', findings: 'Synthetic fixture deliberately disables recovery; enable its existing path.',
  title: 'Enable synthetic recovery', description: 'Fixture-only protocol exercise, not an actual agent defect.',
  skillResult: {
    status: 'succeeded', classification: 'fix:synthetic-recovery-disabled', changedFiles: ['src/flow.mjs'],
    testsAddedOrUpdated: [], behaviorCardsAddedOrUpdated: [], unknowns: [], needsHumanDecision: false
  }
};

function fixture(t, configure = () => {}, retainProof = false, fullFlow = false) {
  const retained = retainProof ? process.env[fullFlow ?
    'RSI_APP_FLOW_PROOF_DIRECTORY' : 'RSI_NATIVE_PROOF_DIRECTORY'] : null;
  if (retained) {
    assert.ok(isAbsolute(retained));
    mkdirSync(retained);
  }
  // Keep nested native fixtures within Windows path bounds even in deep checkouts.
  const temp = tmpdir();
  const root = realpathSync.native(retained ?? mkdtempSync(join(temp, 'rsi-execution-')));
  if (fullFlow) cpSync(fileURLToPath(new URL('../node_modules', import.meta.url)),
    join(root, 'node_modules'), { recursive: true });
  const reference = join(root, 'reference');
  mkdirSync(join(reference, 'src'), { recursive: true });
  writeFileSync(join(reference, 'src', 'flow.mjs'), broken);
  if (fullFlow) for (const path of ['src', 'scaffold', '.github/skills', 'APP-NATIVE.md',
    'package.json', 'package-lock.json', '.gitignore', 'pilot.example.json'])
    cpSync(fileURLToPath(new URL(`../${path.replaceAll('\\', '/')}`, import.meta.url)), join(reference, path),
      { recursive: true });
  const git = args => execFileSync('git', ['--no-pager', '-c', 'core.hooksPath=.git/no-hooks',
    '-c', 'core.autocrlf=false', '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args],
  { cwd: reference, encoding: 'utf8', windowsHide: true, timeout: 10000 }).trim();
  git(['init', '-b', 'main', '--quiet']);
  git(['remote', 'add', 'origin', 'https://github.com/fixture/rsi-agent.git']);
  git(['add', '.']); git(['commit', '--quiet', '-m', 'Synthetic baseline']);
  const driverPath = join(root, 'trusted-driver.mjs');
  writeFileSync(driverPath, driver);
  const config = configAt('pilot.example.json');
  config.stateDirectory = join(root, 'state');
  config.statePolicy.accessApproved = true;
  config.repositories = [];
  config.authoringProviders = { fixture: { type: 'agency-local', executable: process.execPath, profile: 'fixture' } };
  config.rsi = {
    enabled: true, targetRepository: 'fixture/rsi-agent', allowedWritePrefixes: ['src', 'test'],
    maxObservations: 10, maxObservationBytes: 1048576, maxProposals: 2, allowDraftPR: false,
    automation: {
      authoringApproved: true, localCommitApproved: true, authoringProvider: 'fixture',
      referenceCheckout: reference, baselineRevision: git(['rev-parse', 'HEAD']), targetBranch: 'main',
      gitAuthor: { name: 'Fixture', email: 'fixture@example.invalid' },
      timeoutMs: 120000, maxToolCalls: 12, maxFileBytes: 65536, maxWorkspaceBytes: 8388608, maxAiCredits: 30,
      evaluation: {
        driverPath, driverSha256: hash(driver), dependencies: [], timeoutMs: 20000,
        cases: [
          { id: 'recover', population: 'recovery', assertions: ['intended-work'] },
          { id: 'healthy', population: 'healthy', assertions: ['intended-work'] },
          { id: 'guard', population: 'guard', assertions: ['refused'] }
        ]
      }
    }
  };
  configure(config);
  let ledger;
  t.after(() => {
    ledger?.close();
    if (!retained && !t.error) rmSync(root, { recursive: true, force: true });
    else if (!retained) t.diagnostic(`RSI failed fixture retained at ${root}`);
  });
  beginApp(config, { runId: 'flow', dryRun: true, provenance: 'synthetic' });
  ledger = openApp(config, 'flow').ledger;
  let launches = 0;
  const launch = async (_executable, _args, options) => {
    launches++;
    assert.match(options.prompt, /RSI agent entrypoint/);
    assert.match(options.prompt, /untrusted evidence/);
    const call = (tool, args) => rpc(options.env.PILOT_MCP_ENDPOINT, options.env.PILOT_MCP_TOKEN, tool, args);
    assert.match(await call('pilot_read', { path: 'src/flow.mjs' }), /recoveryEnabled = false/);
    await call('pilot_write', { path: 'src/flow.mjs', content: fixed });
    await call('pilot_finish', decision);
    return { stdout: '', stderr: '' };
  };
  return { root, config, get ledger() { return ledger; }, launch, get launches() { return launches; },
    reopen() { ledger.close(); ledger = openApp(config, 'flow').ledger; } };
}

test('RSI fixture cleanup retains failed evidence and removes successful disposable state', t => {
  for (const failed of [false, true]) {
    const hooks = [], diagnostics = [];
    const context = {
      error: failed ? new Error('Synthetic fixture failure') : null,
      after: hook => hooks.push(hook),
      diagnostic: message => diagnostics.push(message)
    };
    const ctx = fixture(context);
    t.after(() => {
      if (existsSync(ctx.root)) rmSync(ctx.root, { recursive: true, force: true });
    });
    assert.ok(existsSync(join(ctx.root, 'reference', '.git')));
    assert.equal(hooks.length, 1);
    hooks[0]();
    assert.equal(existsSync(ctx.root), failed);
    assert.deepEqual(diagnostics, failed ? [`RSI failed fixture retained at ${ctx.root}`] : []);
  }
});

test('normal flow ending executes RSI, authors a real candidate and independently compares both native flows', async t => {
  const ctx = fixture(t, () => {}, true);
  const result = await finishApp(ctx.config, ctx.ledger, 'flow', { launch: ctx.launch });
  assert.equal(result.rsi.execution.state, 'proposed', JSON.stringify(result.rsi.execution));
  assert.equal(ctx.launches, 1);
  const comparison = result.rsi.execution.comparison;
  assert.equal(comparison.qualified, true);
  assert.equal(comparison.baseline.recovery.verified, 0);
  assert.equal(comparison.candidate.recovery.verified, 1);
  assert.equal(comparison.candidate.guards.verified, 1);
  assert.equal(comparison.baseline.completion.selected, 2);
  assert.equal(result.rsi.execution.publication, 'not-authorized');
  ctx.reopen();
  const resumed = await runRsiPending(ctx.config, ctx.ledger, { runId: 'flow' }, {
    launch: () => assert.fail('must not author twice')
  });
  assert.deepEqual(resumed, result.rsi.execution);
  assert.equal(ctx.launches, 1);
  const configPath = join(ctx.root, 'config.json');
  writeFileSync(configPath, json(ctx.config));
  const cli = spawnSync(process.execPath, [fileURLToPath(new URL('../src/cli.js', import.meta.url)),
    'agent', 'rsi', 'app-rsi-run', '--run', 'flow', '--config', configPath],
  { cwd: ctx.root, encoding: 'utf8', timeout: 20000, windowsHide: true });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).result.executionId, resumed.executionId);
  if (process.env.RSI_NATIVE_PROOF_DIRECTORY) {
    const report = { format: 'rsi-native-synthetic-proof-v1',
      scope: 'real-RSI-controller-RPC-Git-native-evaluator-with-synthetic-source-model-and-flow-driver',
      liveModelExecuted: false, publicationExecuted: false, result: resumed };
    writeFileSync(join(ctx.root, 'proof.json'), json(report), { flag: 'wx', mode: 0o600 });
    console.log(`RSI_NATIVE_PROOF ${ctx.root}`);
  }
});

test('app-hosted RSI claims and resumes in the existing app without a provider profile or model launch', async t => {
  const ctx = fixture(t, config => {
    config.rsi.automation.executionMode = 'app-hosted';
    delete config.rsi.automation.authoringProvider;
    delete config.rsi.automation.maxAiCredits;
    config.authoringProviders = {};
  });
  const dependencies = { launch: () => assert.fail('app host must not launch another model') };
  const first = (await finishApp(ctx.config, ctx.ledger, 'flow', dependencies)).rsi.execution;
  assert.equal(first.state, 'awaiting-host', JSON.stringify(first));
  assert.equal(first.modelExecuted, false);
  assert.equal(first.invocation.request.model, 'existing-copilot-app-model');
  assert.equal(first.invocation.launchAnotherModel, false);
  const request = first.invocation.request;
  const claim = { executionId: first.executionId, phase: 'authoring',
    requestSha256: first.invocation.sha256, hostSessionId: 'existing-app-session', action: 'claim' };
  const invoke = hostAction => runRsiPending(ctx.config, ctx.ledger, { runId: 'flow', hostAction }, dependencies);
  await assert.rejects(invoke({ ...claim, requestSha256: '0'.repeat(64) }), /exact existing execution request/);
  const unclaimed = await invoke({ ...claim, action: 'complete', result: decision });
  assert.equal(unclaimed.state, 'blocked');
  assert.equal(unclaimed.error.code, 'blocked-reconciliation');
  const claimed = await invoke(claim);
  assert.equal(claimed.state, 'awaiting-host', JSON.stringify(claimed));
  assert.equal(claimed.invocation.hostSessionId, claim.hostSessionId);
  assert.equal(claimed.invocation.sha256, first.invocation.sha256);
  const foreign = await invoke({ ...claim, hostSessionId: 'different-app-session' });
  assert.equal(foreign.state, 'blocked');
  assert.equal(foreign.error.code, 'blocked-reconciliation');
  ctx.reopen();
  const resumed = await invoke(null);
  assert.equal(resumed.state, 'awaiting-host', JSON.stringify(resumed));
  assert.equal(resumed.invocation.hostSessionId, claim.hostSessionId);
  writeFileSync(join(request.workspace, 'src', 'flow.mjs'), fixed);
  const completion = { ...claim, action: 'complete', result: decision };
  const completed = await invoke(completion);
  assert.equal(completed.state, 'proposed', JSON.stringify(completed));
  assert.equal(completed.comparison.qualified, true);
  assert.equal(completed.modelExecuted, false);
  assert.equal(completed.modelExecutedByHelper, false);
  assert.equal(completed.hostExecution, 'app-host-reported');
  assert.deepEqual(await invoke(completion), completed);
  await assert.rejects(invoke({ ...completion, result: { ...decision, findings: 'changed' } }),
    /completed result|differs from its receipt/);
  assert.equal(ctx.launches, 0);
});

test('app-hosted configuration cannot silently select a second provider', t => {
  assert.throws(() => fixture(t, config => {
    config.rsi.automation.executionMode = 'app-hosted';
  }), /rsiPolicy|rsiAutomation|Invalid/);
});

test('app-hosted publication grants creation only on the first claim acknowledgment', async t => {
  const ctx = fixture(t, config => {
    config.rsi.automation.executionMode = 'app-hosted';
    delete config.rsi.automation.authoringProvider;
    delete config.rsi.automation.maxAiCredits;
    config.authoringProviders = {};
    config.rsi.allowDraftPR = true;
  });
  const dependencies = {
    launch: () => assert.fail('no extra model'),
    publish: () => assert.fail('no helper publication')
  };
  const invoke = hostAction => runRsiPending(ctx.config, ctx.ledger, { runId: 'flow', hostAction }, dependencies);
  const first = (await finishApp(ctx.config, ctx.ledger, 'flow', dependencies)).rsi.execution;
  let action = { executionId: first.executionId, phase: 'authoring', requestSha256: first.invocation.sha256,
    hostSessionId: 'offline-publication-fixture', action: 'claim' };
  await invoke(action);
  writeFileSync(join(first.invocation.request.workspace, 'src', 'flow.mjs'), fixed);
  const publication = await invoke({ ...action, action: 'complete', result: {
    ...decision, skillResult: { ...decision.skillResult, classification: 'improvement:synthetic-recovery-disabled' }
  } });
  assert.equal(publication.state, 'awaiting-host', JSON.stringify(publication));
  assert.equal(publication.invocation.request.phase, 'publication');
  assert.equal(publication.invocation.request.task.title, '[RSI] Improve agent flow recovery');
  assert.equal(publication.invocation.publication.createAllowed, false);
  assert.equal(ctx.ledger.latest('rsiWorkItem')[0].state, 'proposed');
  action = { ...action, phase: 'publication', requestSha256: publication.invocation.sha256 };
  await assert.rejects(invoke({ ...action, hostSessionId: 'foreign-session' }), /original authoring app session/);
  assert.equal(ctx.ledger.latest('rsiWorkItem')[0].state, 'proposed');
  const fresh = await invoke(action);
  assert.equal(fresh.invocation.publication.createAllowed, true);
  ctx.reopen();
  const replayed = await invoke(action);
  assert.equal(replayed.invocation.publication.createAllowed, false);
  assert.equal(replayed.invocation.publication.reconcileOnly, true);
  assert.equal(replayed.invocation.publication.publicationKey, fresh.invocation.publication.publicationKey);
  const result = { url: 'https://github.com/fixture/rsi-agent/pull/1', isDraft: true,
    headRevision: publication.invocation.request.task.proposal.candidateRevision,
    publicationKey: fresh.invocation.publication.publicationKey };
  const completed = await invoke({ ...action, action: 'complete', result });
  assert.equal(completed.state, 'finished', JSON.stringify(completed));
  assert.equal(completed.result.result.outcome, 'draft-reported');
  assert.deepEqual(await invoke({ ...action, action: 'complete', result }), completed);
});

function appFlowProfile(config, { hostFilter = false } = {}) {
  const flowConfig = configAt('pilot.example.json');
  flowConfig.stateDirectory = '${state}';
  flowConfig.statePolicy.accessApproved = true;
  flowConfig.repositories = [];
  flowConfig.sources.workiq.enabled = true;
  flowConfig.sources.workiq.scopeApproved = true;
  const path = `${channelRoot(flowConfig.sources.workiq.seeds[0])}?$select=id,createdDateTime,lastModifiedDateTime,webUrl&$top=50`;
  const receipt = (id, url, data) => ({ id, observedAt: '2026-10-09T00:00:00Z', tool: 'workiq-fetch',
    request: { entityUrls: [url] }, response: { results: [{ statusCode: 200, data }] } });
  const cases = ['recovery', 'healthy', 'guard'].map(population => ({
    id: population, population, assertions: ['collector-durable', 'filter-empty-cohort', 'proposer-no-dispatch',
      ...population === 'guard' ? ['proposer-dry-run-refusal'] : []]
  }));
  const plans = cases.map(selected => {
    const guard = selected.population === 'guard';
    const identity = { id: guard ? 'wrong-identity' : flowConfig.identity.objectId,
      userPrincipalName: flowConfig.identity.designatedUser };
    const ledger = query => ({ path: join('state', 'app-native', 'dry-runs', 'trial', 'ledger.sqlite'), query });
    const expectedState = guard ? 'blocked-auth' : 'complete';
    return {
      id: selected.id, config: flowConfig, runId: 'trial', production: false,
      steps: [
        { id: 'begin', role: 'collector', operation: 'app-begin',
          input: { runId: '${runId}', dryRun: true, provenance: 'synthetic' } },
        { id: 'collection', role: 'collector', operation: 'app-append',
          input: { eventId: 'source-receipts', pass: 'workiq:created',
            calls: [receipt('me', principalPath, identity), ...guard ? [] : [receipt('page', path, { value: [] })]] } },
        { id: 'filter', role: 'filter', operation: hostFilter && !guard ? 'app-review' : 'app-status',
          ...hostFilter && !guard ? { hostInput: { instructions: 'Exercise the existing dry-run review refusal; return an empty review input. This is an offline fixture, not a fresh model review.' } } : {} },
        { id: 'worker', role: 'proposer', operation: 'app-worker', options: ['--operation', 'prepare'],
          input: { investigationId: 'unreviewed-fixture', repoId: 'fixture', intent: 'repo-rca' } },
        { id: 'end', role: 'proposer', operation: 'app-end' }
      ],
      workStarted: { step: 'collection', pointer: '/0/state', equals: expectedState,
        ledger: ledger("SELECT json_extract(body,'$.state') state FROM app_passes WHERE pass='workiq:created'") },
      assertions: [
        { id: selected.assertions[0], step: 'collection', pointer: '/0/state', equals: expectedState,
          ledger: ledger("SELECT json_extract(body,'$.state') state FROM app_passes WHERE pass='workiq:created'") },
        { id: selected.assertions[1], step: 'filter', pointer: '/0/n', equals: 0,
          ledger: ledger("SELECT COUNT(*) n FROM records WHERE kind='investigation'") },
        { id: selected.assertions[2], step: 'worker', pointer: '/0/n', equals: 0,
          ledger: ledger('SELECT COUNT(*) n FROM app_workers') },
        ...guard ? [{ id: 'proposer-dry-run-refusal', step: 'worker', pointer: '/error',
          equals: { code: 'blocked-config', message: 'Native worker activation is disabled for this run' } }] : []
      ]
    };
  });
  const plan = { format: 'rsi-app-role-flow-plan-v1', cases: plans };
  const pathToPlan = join(dirname(config.rsi.automation.referenceCheckout), 'trusted-app-flow.json');
  writeFileSync(pathToPlan, json(plan));
  return { flowPlan: { path: pathToPlan, sha256: hash(json(plan)) }, timeoutMs: 180000, cases };
}

test('app-hosted paired evaluation invokes the real role CLI entrypoints and independently reads their ledgers', async t => {
  const ctx = fixture(t, config => {
    config.rsi.automation.executionMode = 'app-hosted';
    delete config.rsi.automation.authoringProvider;
    delete config.rsi.automation.maxAiCredits;
    config.authoringProviders = {};
    config.rsi.automation.maxWorkspaceBytes = 67108864;
    config.rsi.automation.timeoutMs = 300000;
    config.rsi.automation.evaluation = appFlowProfile(config, { hostFilter: true });
  }, true, true);
  const dependencies = { launch: () => assert.fail('no additional model or provider') };
  let result = (await finishApp(ctx.config, ctx.ledger, 'flow', dependencies)).rsi.execution;
  assert.equal(result.state, 'awaiting-host', JSON.stringify(result));
  const invoke = hostAction => runRsiPending(ctx.config, ctx.ledger, { runId: 'flow', hostAction }, dependencies);
  let claims = 0;
  while (result.state === 'awaiting-host') {
    assert.ok(++claims <= 5, 'one authoring request and two semantic steps per arm, never a retry loop');
    const invocation = result.invocation;
    const action = { executionId: result.executionId, phase: invocation.request.phase,
      requestSha256: invocation.sha256, hostSessionId: 'offline-app-fixture', action: 'claim' };
    const owner = await invoke(action);
    assert.equal(owner.state, 'awaiting-host', JSON.stringify(owner));
    let value = {};
    if (action.phase === 'authoring') {
      writeFileSync(join(invocation.request.workspace, 'src', 'flow.mjs'), fixed);
      value = decision;
    } else {
      assert.equal(invocation.request.task.role, 'filter');
      assert.equal(invocation.request.task.command, 'app-review');
      assert.match(invocation.request.skill.path, /reference|baseline|candidate/);
      assert.equal(invocation.request.task.rawFlowInput, true);
    }
    result = await invoke({ ...action, action: 'complete', result: value });
  }
  assert.equal(result.state, 'finished', JSON.stringify(result));
  const operation = ctx.ledger.db.prepare("SELECT detail FROM operations WHERE kind='rsi-execution'").get();
  const directory = JSON.parse(operation.detail).execution.directory;
  const before = JSON.parse(readFileSync(join(directory, 'baseline-evaluation.json'), 'utf8')).value;
  assert.equal(claims, 5, JSON.stringify(before.artifacts.map(item =>
    JSON.parse(readFileSync(item.path, 'utf8')))));
  assert.equal(result.comparison.qualified, false);
  for (const arm of ['baseline', 'candidate']) {
    assert.equal(result.comparison[arm].allSelected, 3);
    assert.equal(result.comparison[arm].completion.verified, 0, 'dry-run refusal is not completed FILTER work');
    assert.equal(result.comparison[arm].guards.verified, 1);
  }
  assert.equal(result.modelExecutedByHelper, false);
  const steps = ctx.ledger.db.prepare("SELECT state,detail FROM operations WHERE kind='rsi-app-flow-step'").all();
  assert.equal(steps.length, 26);
  assert.ok(steps.every(item => item.state === 'completed'));
  for (const name of ['baseline-evaluation', 'candidate-evaluation']) {
    const observed = JSON.parse(readFileSync(join(directory, `${name}.json`), 'utf8')).value;
    assert.equal(observed.scope, 'existing-app-role-entrypoints-and-durable-ledger-assertions');
    assert.equal(observed.artifacts.length, 13);
    assert.equal(observed.diagnostics.length, 0);
  }
  if (process.env.RSI_APP_FLOW_PROOF_DIRECTORY) {
    writeFileSync(join(ctx.root, 'config.json'), json(ctx.config));
    writeFileSync(join(ctx.root, 'proof.json'), json({
      scope: 'actual-local-role-CLI-with-synthetic-receipts-and-simulated-host-completions',
      usefulImprovementQualified: false, appHostContinuationQualified: false,
      claimCount: claims, roleCommandCount: steps.length,
      ledger: join(ctx.ledger.directory, 'ledger.sqlite'), executionDirectory: directory,
      comparison: result.comparison, source: result.comparison.bindings.controller
    }));
  }
});

test('app-hosted semantic resumption cannot renew an expired arm deadline', async t => {
  const ctx = fixture(t, config => {
    config.rsi.automation.executionMode = 'app-hosted';
    delete config.rsi.automation.authoringProvider;
    delete config.rsi.automation.maxAiCredits;
    config.rsi.automation.maxWorkspaceBytes = 67108864;
    config.rsi.automation.evaluation = appFlowProfile(config, { hostFilter: true });
    config.rsi.automation.evaluation.timeoutMs = 10000;
  }, false, true);
  t.mock.timers.enable({ apis: ['Date'] });
  let commands = 0;
  const dependencies = {
    launch: () => assert.fail('no model'),
    executeFlowCommand: async (_executable, args) => {
      commands++;
      const index = args.indexOf('agent');
      return { stdout: json({ format: 'agent-operation-result-v1', role: args[index + 1],
        operation: args[index + 2], kind: 'result', result: {} }), stderr: '' };
    }
  };
  const first = (await finishApp(ctx.config, ctx.ledger, 'flow', dependencies)).rsi.execution;
  const invoke = hostAction => runRsiPending(ctx.config, ctx.ledger, { runId: 'flow', hostAction }, dependencies);
  const action = { executionId: first.executionId, phase: 'authoring', requestSha256: first.invocation.sha256,
    hostSessionId: 'offline-deadline-fixture', action: 'claim' };
  await invoke(action);
  writeFileSync(join(first.invocation.request.workspace, 'src', 'flow.mjs'), fixed);
  const semantic = await invoke({ ...action, action: 'complete', result: decision });
  assert.equal(semantic.state, 'awaiting-host', JSON.stringify(semantic));
  const original = ctx.ledger.db.prepare("SELECT detail FROM operations WHERE kind='rsi-baseline-evaluation'").get().detail;
  assert.equal(semantic.invocation.request.deadline, JSON.parse(original).deadline);
  const previousCommands = commands;
  t.mock.timers.setTime(semantic.invocation.request.deadline);
  const expired = await invoke(null);
  assert.equal(expired.state, 'blocked');
  assert.equal(expired.error.code, 'blocked-budget');
  assert.equal(commands, previousCommands);
  assert.equal(ctx.ledger.db.prepare("SELECT detail FROM operations WHERE kind='rsi-baseline-evaluation'").get().detail, original);
});

test('authorized draft adapter follows qualified evidence and reconciles without another model or create', async t => {
  const ctx = fixture(t, config => { config.rsi.allowDraftPR = true; });
  let publications = 0;
  const result = await finishApp(ctx.config, ctx.ledger, 'flow', {
    launch: ctx.launch,
    publish: async ({ proposal, comparison, reservation, reconcileOnly, title }) => {
      publications++;
      assert.equal(title, '[RSI] Fix agent flow recovery');
      assert.equal(comparison.qualified, true);
      assert.equal(reservation.createAllowed, true);
      assert.equal(reconcileOnly, false);
      return { url: 'https://github.com/fixture/rsi-agent/pull/1', isDraft: true,
        headRevision: proposal.candidateRevision, publicationKey: reservation.publicationKey };
    }
  });
  assert.equal(result.rsi.execution.result.result.outcome, 'draft-reported', JSON.stringify(result.rsi.execution));
  assert.equal(publications, 1);
  assert.equal(ctx.launches, 1);
  assert.equal((await runRsiPending(ctx.config, ctx.ledger, { runId: 'flow' })).state, 'idle');
});

test('no-change completes automatically without candidate commit, evaluation or publication', async t => {
  const ctx = fixture(t);
  const result = await finishApp(ctx.config, ctx.ledger, 'flow', {
    launch: async (_executable, _args, options) => {
      await rpc(options.env.PILOT_MCP_ENDPOINT, options.env.PILOT_MCP_TOKEN, 'pilot_finish',
        { outcome: 'not-actionable', findings: 'No supported agent-system change in this observation.' });
      return { stdout: '', stderr: '' };
    },
    evaluate: () => assert.fail('no candidate to evaluate'),
    publish: () => assert.fail('no proposal to publish')
  });
  assert.equal(result.rsi.execution.result.result.outcome, 'no-change', JSON.stringify(result.rsi.execution));
  assert.equal(ctx.ledger.status().operations.filter(row => row.kind === 'rsi-commit').length, 0);
  const original = ctx.ledger.all('rsiFlowObservation')[0];
  const originalBinding = ctx.ledger.get('rsiFlowBinding', original.bindingId);
  const binding = ctx.ledger.put({ ...originalBinding,
    id: `rsi-flow-${hash(json(['app-flow', 'historical']))}`, flowId: 'historical',
    controller: { ...originalBinding.controller, sourceSha256: 'e'.repeat(64) } });
  const observation = ctx.ledger.put({ ...original, bindingId: binding.id,
    id: `rsi-observation-${hash(json([binding.id, original.payloadSha256]))}` });
  ctx.ledger.put({ ...ctx.ledger.latest('rsiWorkItem')[0],
    id: `rsi-task-${hash(observation.id)}`, version: 1, observationId: observation.id,
    state: 'queued', claim: null, proposal: null, publicationKey: null, result: null });
  const blocked = await runRsiPending(ctx.config, ctx.ledger);
  assert.equal(blocked.state, 'blocked');
  assert.equal(blocked.modelExecuted, false);
  assert.equal(blocked.pending[0].bindingState, 'stale-controller');
});

test('process exit after durable skill completion resumes without repeating authoring', async t => {
  const ctx = fixture(t);
  endApp(ctx.config, ctx.ledger, 'flow');
  const configPath = join(ctx.root, 'config.json');
  writeFileSync(configPath, json(ctx.config));
  const source = `
    import { readFileSync } from 'node:fs';
    import { connect } from 'node:net';
    import { openApp } from ${JSON.stringify(new URL('../src/app-native.js', import.meta.url).href)};
    import { runRsiPending } from ${JSON.stringify(new URL('../src/rsi-execution.js', import.meta.url).href)};
    ${rpc.toString()}
    const config = JSON.parse(readFileSync(process.argv[1], 'utf8'));
    const { ledger } = openApp(config, 'flow');
    await runRsiPending(config, ledger, { runId: 'flow' }, {
      launch: async (_executable, _args, options) => {
        await rpc(options.env.PILOT_MCP_ENDPOINT, options.env.PILOT_MCP_TOKEN, 'pilot_write',
          { path: 'src/flow.mjs', content: ${JSON.stringify(fixed)} });
        await rpc(options.env.PILOT_MCP_ENDPOINT, options.env.PILOT_MCP_TOKEN, 'pilot_finish',
          ${JSON.stringify(decision)});
        return { stdout: '', stderr: '' };
      },
      checkpoint: name => { if (name === 'authoring') process.exit(37); }
    });
    ledger.close();
  `;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source, configPath],
    { encoding: 'utf8', timeout: 60000, windowsHide: true });
  assert.equal(child.status, 37, child.stderr + child.stdout);
  ctx.reopen();
  const result = await runRsiPending(ctx.config, ctx.ledger, { runId: 'flow' }, {
    launch: () => assert.fail('durable skill decision must not launch another model')
  });
  assert.equal(result.state, 'proposed', JSON.stringify(result));
  assert.equal(result.comparison.qualified, true);
  assert.equal(result.modelExecuted, false);
  assert.equal(ctx.ledger.status().operations.filter(row => row.kind === 'rsi-authoring').length, 1);
});

test('changed evaluator and uncertain authoring stop without substitution or an automatic retry', async t => {
  const ctx = fixture(t);
  endApp(ctx.config, ctx.ledger, 'flow');
  let launches = 0;
  const first = await runRsiPending(ctx.config, ctx.ledger, { runId: 'flow' }, {
    launch: async () => { launches++; throw new Error('Synthetic unknown model outcome'); }
  });
  assert.equal(first.state, 'blocked');
  const second = await runRsiPending(ctx.config, ctx.ledger, { runId: 'flow' }, {
    launch: () => assert.fail('unknown prior execution cannot be repeated')
  });
  assert.equal(second.state, 'blocked');
  assert.equal(launches, 1);
  writeFileSync(ctx.config.rsi.automation.evaluation.driverPath, driver + '\n// changed');
  await assert.rejects(runRsiPending(ctx.config, ctx.ledger, { runId: 'flow' }), /driver\/dependency changed/);
});

test('invalid baseline evidence cannot qualify or publish an apparently fixed candidate', async t => {
  const ctx = fixture(t, config => { config.rsi.allowDraftPR = true; });
  const result = await finishApp(ctx.config, ctx.ledger, 'flow', {
    launch: ctx.launch,
    evaluate: async () => ({ stdout: '{}', stderr: '' }),
    publish: () => assert.fail('unverified execution cannot publish')
  });
  assert.equal(result.rsi.execution.comparison.qualified, false);
  assert.equal(result.rsi.execution.comparison.baseline.execution.unknown, 3);
  assert.equal(result.rsi.execution.result.result.outcome, 'blocked');
  assert.equal(rsiWork(ctx.config, ctx.ledger, 'status', {}, { runId: 'flow' }).pending.length, 0);
});

test('expired admission after cloning launches no authoring or evaluation', async t => {
  const ctx = fixture(t);
  t.mock.timers.enable({ apis: ['Date'] });
  const result = await finishApp(ctx.config, ctx.ledger, 'flow', {
    checkpoint: phase => {
      if (phase === 'baseline-clone') {
        const current = ctx.ledger.db.prepare("SELECT detail FROM operations WHERE kind='rsi-execution'").get();
        t.mock.timers.setTime(JSON.parse(current.detail).execution.deadline);
      }
    },
    launch: () => assert.fail('expired controller cannot admit a host'),
    evaluate: () => assert.fail('expired controller cannot admit an evaluator')
  });
  assert.equal(result.rsi.execution.state, 'blocked');
  assert.equal(result.rsi.execution.error.code, 'blocked-budget');
  assert.equal(ctx.ledger.status().operations.filter(row => row.kind === 'rsi-authoring').length, 0);
});

test('expired restart admits no verification child or replacement work after a durable finish', async t => {
  const ctx = fixture(t);
  const first = await finishApp(ctx.config, ctx.ledger, 'flow', {
    launch: async (...args) => {
      await ctx.launch(...args);
      throw new Error('Synthetic lost response after durable finish');
    }
  });
  assert.equal(first.rsi.execution.state, 'blocked');
  const operation = ctx.ledger.db.prepare("SELECT detail FROM operations WHERE kind='rsi-execution'").get();
  const { execution } = JSON.parse(operation.detail);
  const receipt = join(execution.directory, 'authoring.json');
  const original = hash(readFileSync(receipt));
  const phases = ctx.ledger.status().operations.length;
  t.mock.timers.enable({ apis: ['Date'], now: execution.deadline });
  const commands = t.mock.method(childProcess, 'execFileSync', () => assert.fail('expired verification child'));
  syncBuiltinESMExports();
  t.after(() => { commands.mock.restore(); syncBuiltinESMExports(); });
  const resumed = await runRsiPending(ctx.config, ctx.ledger, { runId: 'flow' }, {
    launch: () => assert.fail('expired authoring'),
    evaluate: () => assert.fail('expired evaluation'),
    publish: () => assert.fail('expired publication')
  });
  assert.equal(resumed.state, 'blocked');
  assert.equal(resumed.error.code, 'blocked-budget');
  assert.equal(commands.mock.callCount(), 0);
  assert.equal(ctx.ledger.status().operations.length, phases);
  assert.equal(ctx.ledger.latest('rsiWorkItem')[0].state, 'claimed');
  assert.equal(hash(readFileSync(receipt)), original);
  assert.equal(existsSync(join(execution.directory, 'commit.json')), false);
});

test('expiry after final evaluation retains its receipt without a comparison or proposal effect', async t => {
  const ctx = fixture(t, config => { config.rsi.allowDraftPR = true; });
  t.mock.timers.enable({ apis: ['Date'] });
  const result = await finishApp(ctx.config, ctx.ledger, 'flow', {
    launch: ctx.launch,
    checkpoint: phase => {
      if (phase === 'candidate-evaluation') {
        const current = ctx.ledger.db.prepare("SELECT detail FROM operations WHERE kind='rsi-execution'").get();
        t.mock.timers.setTime(JSON.parse(current.detail).execution.deadline);
      }
    },
    publish: () => assert.fail('expired publication')
  });
  assert.equal(result.rsi.execution.state, 'blocked');
  assert.equal(result.rsi.execution.error.code, 'blocked-budget');
  const current = ctx.ledger.db.prepare("SELECT detail FROM operations WHERE kind='rsi-execution'").get();
  const directory = JSON.parse(current.detail).execution.directory;
  assert.equal(existsSync(join(directory, 'candidate-evaluation.json')), true);
  assert.equal(existsSync(join(directory, 'comparison.json')), false);
  assert.equal(ctx.ledger.latest('rsiWorkItem')[0].state, 'claimed');
  assert.equal(ctx.ledger.latest('rsiWorkItem')[0].proposal, null);
});

test('committed phase tampering blocks restart instead of relabelling the receipt', async t => {
  const ctx = fixture(t);
  const result = await finishApp(ctx.config, ctx.ledger, 'flow', { launch: ctx.launch });
  assert.equal(result.rsi.execution.state, 'proposed');
  const execution = ctx.ledger.db.prepare("SELECT id,detail FROM operations WHERE kind='rsi-execution'").get();
  const detail = JSON.parse(execution.detail);
  const path = join(detail.execution.directory, 'authoring.json');
  const receipt = JSON.parse(readFileSync(path, 'utf8'));
  receipt.value.findings = 'Changed receipt';
  writeFileSync(path, json(receipt));
  ctx.ledger.finishOperation(execution.id, 'started', { execution: detail.execution });
  const resumed = await runRsiPending(ctx.config, ctx.ledger, { runId: 'flow' }, {
    launch: () => assert.fail('tampered evidence cannot repeat authoring')
  });
  assert.equal(resumed.state, 'blocked');
  assert.match(resumed.error.message, /phase receipt changed/);
  assert.equal(JSON.parse(readFileSync(path, 'utf8')).value.findings, 'Changed receipt');
});

test('an interrupted host cannot keep an idle RPC connection open indefinitely', async t => {
  const ctx = fixture(t);
  let socket;
  t.after(() => socket?.destroy());
  const result = await finishApp(ctx.config, ctx.ledger, 'flow', {
    launch: async (_executable, _args, options) => {
      socket = connect(options.env.PILOT_MCP_ENDPOINT);
      await new Promise((resolve, reject) => { socket.once('connect', resolve); socket.once('error', reject); });
      throw new Error('Synthetic host interruption with an incomplete RPC request');
    }
  });
  assert.equal(result.rsi.execution.state, 'blocked');
  assert.equal(result.rsi.execution.error.code, 'failed');
});

test('a durable skill finish survives a lost host response without another authoring attempt', async t => {
  const ctx = fixture(t);
  const first = await finishApp(ctx.config, ctx.ledger, 'flow', {
    launch: async (...args) => {
      await ctx.launch(...args);
      throw new Error('Synthetic response loss after the authenticated finish receipt');
    }
  });
  assert.equal(first.rsi.execution.state, 'blocked');
  const resumed = await runRsiPending(ctx.config, ctx.ledger, { runId: 'flow' }, {
    launch: () => assert.fail('persisted decision must not repeat the authoring turn')
  });
  assert.equal(resumed.state, 'proposed', JSON.stringify(resumed));
  assert.equal(resumed.comparison.qualified, true);
  assert.equal(ctx.launches, 1);
});

test('lost publication response reconciles the same draft without repeating authoring or evaluation', async t => {
  const ctx = fixture(t, config => { config.rsi.allowDraftPR = true; });
  let created = 0, receipt;
  const first = await finishApp(ctx.config, ctx.ledger, 'flow', {
    launch: ctx.launch,
    publish: async ({ proposal, reservation, reconcileOnly }) => {
      assert.equal(reconcileOnly, false);
      assert.equal(reservation.createAllowed, true);
      created++;
      receipt = { url: 'https://github.com/fixture/rsi-agent/pull/1', isDraft: true,
        headRevision: proposal.candidateRevision, publicationKey: reservation.publicationKey };
      throw new Error('Synthetic lost publication response');
    }
  });
  assert.equal(first.rsi.execution.state, 'blocked');
  const resumed = await runRsiPending(ctx.config, ctx.ledger, { runId: 'flow' }, {
    launch: () => assert.fail('cannot reauthor after publication uncertainty'),
    evaluate: () => assert.fail('cannot repeat completed evaluations'),
    publish: async ({ reservation, reconcileOnly }) => {
      assert.equal(reconcileOnly, true);
      assert.equal(reservation.createAllowed, false);
      return receipt;
    }
  });
  assert.equal(resumed.state, 'finished', JSON.stringify(resumed));
  assert.equal(resumed.result.result.outcome, 'draft-reported');
  assert.equal(ctx.launches, 1);
  assert.equal(created, 1);
});
