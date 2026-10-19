import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configAt, hash, json, validateRecord } from '../src/common.js';
import {
  configureDeclarativeGate, declarativeProfile, declarativeRegistrationFiles,
  declarativeRequest, skillChangePopulation, verifyDeclarativeRegistration
} from '../src/declarative-e2e.js';
import { repositoryValidationContract } from '../src/repository-skills.js';
import {
  command, finalizeDeclarativeSkill, rebindDeclarativeRegistration, runValidation
} from '../src/workers.js';

const require = createRequire(import.meta.url);
const native = require('../scripts/validation/1js-declarative-e2e.cjs');
const CASE = 'excel-agent.aad.synthetic-regression';
const file = `${native.SCENARIOS}synthetic-regression.yaml`;
const scenario = {
  id: CASE, name: 'Synthetic protected regression',
  tags: ['omni-supported', 'arcadia-supported', 'omni-observing'],
  metadata: { account: { lane: 'aad-enterprise' } },
  cleanup: [{ id: 'restore-mode' }],
  verification: { assertions: [{ protected: true, provider: 'workbook' }] }
};
const entry = {
  semanticId: CASE, title: scenario.name, tags: scenario.tags,
  accountLane: 'aad-enterprise', composites: [], assertions: [{ provider: 'workbook', assertion: 'equals',
    parameters: { cell: 'A1', expected: 'synthetic-canary' } }],
  providers: ['workbook'], operations: ['read'], resources: ['A1'], fixtures: [],
  cleanup: [{ type: 'invoke-provider', provider: 'mode', operation: 'restore', parameters: {} }]
};
const selected = [{ file, sha256: 'b'.repeat(64), scenario, entry }];
function documents() {
  const catalog = {
    schemaVersion: 1, packageName: '@1js/excel-agent-declarative-e2e',
    sourceTestVerb: 'test:e2e:excel-agent:declarative', cases: [],
    disabledCases: [{ number: 7, semanticId: 'excel-agent.aad.disabled', title: 'Keep disabled' }]
  };
  return [catalog, structuredClone(catalog), { schemaVersion: 1, cases: [] }, { scripts: {} }];
}
const policy = { approved: true, priority: 'P1' };

function nativeSummary() {
  const execution = {
    format: 'local-declarative-execution-summary-v1', scenarioId: CASE,
    declarations: [{ path: `declarative/scenarios/synthetic-regression.yaml`, sha256: selected[0].sha256 }],
    events: [
      { phase: 'scenario', status: 'passed' },
      { phase: 'protected-contract', status: 'passed' },
      { phase: 'cleanup', status: 'passed', stepId: 'restore-mode' }
    ]
  };
  const summary = {
    status: 'passed',
    cases: Array.from({ length: 5 }, (_, repeatEachIndex) => ({
      title: scenario.name, status: 'passed', expectedStatus: 'passed',
      repeatEachIndex, retry: 0, errors: [], diagnosticErrors: [],
      attachments: [{ name: 'local-declarative-execution-summary', file: `attempt-${repeatEachIndex}.json` }]
    }))
  };
  return { summary, execution };
}

test('registration enrolls only the selected scenario and preserves disabled history', () => {
  const original = documents();
  const result = native.registrationUpdates(original, selected, policy);
  assert.equal(original[0].cases.length, 0);
  assert.deepEqual(result[0], result[1]);
  assert.deepEqual(result[0].disabledCases, original[0].disabledCases);
  assert.equal(result[0].cases[0].number, 8);
  assert.equal(result[0].cases[0].priority, 'P1');
  assert.equal(result[2].cases[0].semanticId, CASE);
  assert.equal(result[2].cases[0].tags, undefined);
  assert.equal(result[3].scripts['e2e:ci:excel-agent:aad:synthetic-regression'],
    `cross-env EXCEL_AGENT_DECLARATIVE_SCENARIO=${CASE} yarn test:e2e`);
  assert.deepEqual(native.registrationUpdates(result, selected, policy), result);
  assert(!declarativeRegistrationFiles.some(path => path.includes('execution-selection')));
});

test('registration rejects unapproved metadata, blocking newcomers and disabled identities', () => {
  assert.throws(() => native.registrationUpdates(documents(), selected, { ...policy, approved: false }),
    /explicit.*approval/);
  const blocking = structuredClone(selected);
  blocking[0].scenario.tags = ['omni-supported', 'omni-blocking'];
  assert.throws(() => native.registrationUpdates(documents(), blocking, policy), /observing/);
  const disabled = documents();
  disabled[0].disabledCases[0].semanticId = CASE;
  disabled[1] = structuredClone(disabled[0]);
  assert.throws(() => native.registrationUpdates(disabled, selected, policy), /re-enable/);
  const drift = documents();
  drift[1].cases.push({ semanticId: CASE });
  assert.throws(() => native.registrationUpdates(drift, selected, policy), /drift/);
});

test('registration cannot weaken prior assertions, cleanup, tags or identity', () => {
  const registered = native.registrationUpdates(documents(), selected, policy);
  for (const field of ['assertions', 'cleanup']) {
    const weaker = structuredClone(selected);
    weaker[0].entry[field] = [];
    assert.throws(() => native.registrationUpdates(registered, weaker, policy), /remove or replace/);
  }
  for (const field of ['name', 'tags']) {
    const renamed = structuredClone(selected);
    renamed[0].scenario[field] = field === 'name' ? 'Renamed' : ['omni-supported'];
    assert.throws(() => native.registrationUpdates(registered, renamed, policy), /rename or retag/);
  }
  const expanded = structuredClone(selected);
  expanded[0].entry.assertions.push({ provider: 'workbook', assertion: 'unchanged', parameters: { cell: 'A4' } });
  assert.equal(native.registrationUpdates(registered, expanded, policy)[2].cases[0].assertions.length, 2);
});

test('shared additions preserve existing consumers instead of silently widening the live batch', () => {
  const ui = { version: 1, scopes: {}, targets: { existing: { role: 'button', name: 'Keep' } } };
  native.assertAdditiveShared(ui, {
    ...ui, targets: { ...ui.targets, added: { role: 'heading', name: 'Synthetic plan' } }
  }, 'ui-map');
  assert.throws(() => native.assertAdditiveShared(ui, {
    ...ui, targets: { existing: { role: 'heading', name: 'Changed' } }
  }, 'ui-map'), /consumer-closure/);
  const composites = { version: 1, composites: [{ id: 'existing', steps: { keep: {} } }] };
  native.assertAdditiveShared(composites, {
    ...composites, composites: [...composites.composites, { id: 'added', steps: {} }]
  }, 'composites');
  assert.throws(() => native.assertAdditiveShared(composites, {
    ...composites, composites: [{ id: 'existing', steps: { changed: {} } }]
  }, 'composites'), /consumer-closure/);
  assert.throws(() => native.assertAdditiveShared({ version: 1, providers: {} },
    { version: 1, providers: { invented: {} } }, 'resources'), /consumer-closure/);
});

test('native proof accepts exactly five expected passes with source and cleanup evidence', () => {
  const { summary, execution } = nativeSummary();
  native.assertExecution(summary, selected, () => execution);
});

for (const [label, mutate] of [
  ['missing repetition', value => value.cases.pop()],
  ['duplicate repetition', value => { value.cases[4].repeatEachIndex = 0; }],
  ['automatic retry', value => { value.cases[0].retry = 1; }],
  ['expected failure', value => { value.cases[0].expectedStatus = 'failed'; }],
  ['skipped test', value => { value.cases[0].status = 'skipped'; }],
  ['other scenario', value => { value.cases[0].title = 'Unrelated passing test'; }],
  ['hidden error', value => { value.cases[0].errors.push('failure'); }],
  ['missing diagnostics', value => { delete value.cases[0].diagnosticErrors; }],
  ['diagnostic error', value => { value.cases[0].diagnosticErrors.push('missing execution log'); }],
  ['no execution attachment', value => { value.cases[0].attachments = []; }]
]) {
  test(`native proof rejects ${label}`, () => {
    const { summary, execution } = nativeSummary();
    mutate(summary);
    assert.throws(() => native.assertExecution(summary, selected, () => execution));
  });
}

for (const [label, mutate] of [
  ['wrong declaration SHA', value => { value.declarations[0].sha256 = 'c'.repeat(64); }],
  ['wrong scenario', value => { value.scenarioId = 'excel-agent.aad.unrelated'; }],
  ['missing protected assertion', value => { value.events.splice(1, 1); }],
  ['missing cleanup', value => { value.events.pop(); }],
  ['skipped cleanup', value => { value.events[2].status = 'skipped'; }],
  ['wrong cleanup step', value => { value.events[2].stepId = 'unrelated-cleanup'; }]
]) {
  test(`native proof rejects ${label}`, () => {
    const { summary, execution } = nativeSummary();
    mutate(execution);
    assert.throws(() => native.assertExecution(summary, selected, () => execution));
  });
}

test('CDP cleanup preserves all pre-existing tabs without closing leftovers automatically', () => {
  const before = [{ id: 'existing', url: 'https://example.invalid/' }];
  native.assertBrowserCleanup(before, structuredClone(before));
  assert.throws(() => native.assertBrowserCleanup(before, []));
  assert.throws(() => native.assertBrowserCleanup(before, [...before, { id: 'leftover', url: 'about:blank' }]));
  assert.throws(() => native.assertBrowserCleanup(before, [{ id: 'existing', url: 'about:blank' }]));
});

test('native units do not inherit the live experience, CDP or output settings', () => {
  const environment = {
    PATH: 'synthetic-path', DONT_UPDATE_ENV: 'true', XLO_OMNI_FLIGHT: 'true',
    xlo_shared_agent_shell_flight: 'true', EXCELAGENT_CDP_ENDPOINT: 'http://127.0.0.1:9222',
    EXCEL_AGENT_LOCAL_OUTPUT_ROOT: 'synthetic-live-output'
  };
  assert.deepEqual(native.nativeUnitEnvironment(environment),
    { PATH: 'synthetic-path', DONT_UPDATE_ENV: 'true' });
  assert.equal(environment.XLO_OMNI_FLIGHT, 'true');
});

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'onejs-adapter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  mkdirSync(join(workspace, native.SCENARIOS), { recursive: true });
  const g = async args => (await command('git', [
    '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args
  ], workspace)).stdout.trim();
  await g(['init', '--quiet']);
  writeFileSync(join(workspace, file), 'synthetic source v1\n');
  for (const [index, target] of declarativeRegistrationFiles.entries()) {
    mkdirSync(dirname(join(workspace, target)), { recursive: true });
    writeFileSync(join(workspace, target), json(documents()[index]));
  }
  await g(['add', '.']);
  await g(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Synthetic qualified base']);
  const base = await g(['rev-parse', 'HEAD']);
  writeFileSync(join(workspace, file), 'synthetic source v2\n');
  const yarn = join(root, 'synthetic-yarn.cjs');
  writeFileSync(yarn, '');
  const config = configAt('pilot.example.json');
  config.stateDirectory = join(root, 'state');
  config.limits.maxValidationInfrastructureRetries = 3;
  const gate = config.repositories[0].validationGates[0];
  gate.approved = true;
  gate.executable = process.execPath;
  gate.declarativeE2E = {
    cdpEndpoint: 'http://127.0.0.1:9222', yarnEntryPoint: yarn,
    maxCases: 1, installDependencies: false, registration: policy
  };
  const repo = {
    id: '1js', owner: 'synthetic-owner', validationGates: [gate],
    allowedWritePrefixes: [native.SCENARIOS.replace(/\/$/, '')]
  };
  config.repositories = [repo];
  const assignment = {
    id: 'synthetic-onejs', capability: 'declarative-e2e-authoring',
    evidenceIds: ['synthetic-evidence'],
    skillInput: { format: 'declarative-e2e-mini-spec-batch-v1', items: [{ inputItemId: 'synthetic-input' }] },
    skillQualification: { baseRevision: base },
    allowedWritePrefixes: repo.allowedWritePrefixes, allowedWriteFiles: []
  };
  const job = { id: assignment.id, workspace, base_revision: base };
  const operations = new Map();
  const ledger = {
    get: () => assignment,
    operation: (id, jobId, kind, detail) => {
      assert(!operations.has(id), 'duplicate operation');
      operations.set(id, { state: 'started', detail });
    },
    finishOperation: (id, state, detail) => operations.set(id, { state, detail })
  };
  const execution = {
    capability: assignment.capability, changedFiles: [file], testsAddedOrUpdated: [CASE]
  };
  return { root, workspace, g, base, config, gate, repo, assignment, job, ledger, operations, execution };
}

async function finalize(ctx, execute = null) {
  const run = execute ?? (async (_exe, _args, cwd, _timeout, env) => {
    assert.equal(env.PILOT_DECLARATIVE_ACTION, 'register');
    assert.equal(env.GITHUB_TOKEN, undefined);
    const request = JSON.parse(env.PILOT_DECLARATIVE_REQUEST);
    assert.equal(request.assignmentId, ctx.assignment.id);
    assert.equal(request.baseRevision, ctx.base);
    writeFileSync(join(cwd, declarativeRegistrationFiles[0]), '{"synthetic":"registered"}\n');
    return { stdout: `PILOT_DECLARATIVE_REGISTRATION:${json({
      caseIds: [CASE], changedFiles: [declarativeRegistrationFiles[0]],
      fileSha256: { [declarativeRegistrationFiles[0]]:
        hash(readFileSync(join(cwd, declarativeRegistrationFiles[0]))) }
    })}`, stderr: '' };
  });
  return finalizeDeclarativeSkill(ctx.config, ctx.ledger, ctx.job, ctx.repo,
    ctx.assignment, ctx.execution, 0, run);
}

test('built-in profile is packaged once, content-bound and qualification includes execution policy', async t => {
  const ctx = await fixture(t);
  const contract = repositoryValidationContract(ctx.repo);
  ctx.gate.declarativeE2E.maxCases = 2;
  assert.notEqual(repositoryValidationContract(ctx.repo).sha256, contract.sha256);
  const raw = { profile: declarativeProfile, approved: false, declarativeE2E: ctx.gate.declarativeE2E };
  configureDeclarativeGate(raw, join(ctx.root, 'config.json'));
  assert.match(raw.profilePath, /1js-declarative-e2e\.cjs$/);
  assert.equal(raw.profileSha256, hash(readFileSync(ctx.gate.profilePath)));
  assert.deepEqual(raw.args, ['{profile}']);
  configureDeclarativeGate(raw, join(ctx.root, 'config.json'));
  assert.throws(() => configureDeclarativeGate({ ...raw, args: ['arbitrary'] },
    join(ctx.root, 'config.json')), /owns its profile/);
});

test('requests reject unbound source, non-local browsers and batch widening', async t => {
  const ctx = await fixture(t);
  const request = declarativeRequest(ctx.gate, ctx.assignment, ctx.job, ctx.base, ctx.execution);
  assert.deepEqual(request.inputItemIds, ['synthetic-input']);
  for (const endpoint of ['https://example.invalid/', 'http://user:secret@localhost:9222/',
    'http://127.0.0.1:9222/?extra=true']) {
    assert.throws(() => native.validateRequest({
      ...request, options: { ...request.options, cdpEndpoint: endpoint }
    }), /loopback/);
  }
  assert.throws(() => declarativeRequest(ctx.gate, { ...ctx.assignment, capability: 'defect-fix' },
    ctx.job, ctx.base, ctx.execution), /qualified/);
  assert.throws(() => native.validateRequest({
    ...request, options: { ...request.options, maxCases: 99 }
  }), /maxCases/);
  assert.throws(() => native.changedScenarios([`${native.APP}/declarative/ui-map.yaml`]), /explicitly/);
});

test('registration surfaces feed authentication failure without retaining credential-bearing output', async t => {
  const ctx = await fixture(t);
  await assert.rejects(finalize(ctx, async () => {
    throw Object.assign(new Error('secret transport diagnostic'), {
      stdout: 'Your token is invalid. SECRET_VALUE_MUST_NOT_PERSIST',
      stderr: 'Authentication to package feed failed'
    });
  }), error => error.code === 'blocked-auth' && /yarn auth/.test(error.message));
  const operation = [...ctx.operations.values()][0];
  assert.equal(operation.state, 'blocked');
  assert.equal(operation.detail.prerequisite, 'package-feed-authentication');
  assert.equal(operation.detail.productInvocations, 0);
  assert(!json(operation).includes('SECRET_VALUE'));
  assert(!json(operation).includes('secret transport'));
});

test('Controller finalizes only owner metadata, persists its receipt and rejects later tampering', async t => {
  const ctx = await fixture(t);
  const execution = await finalize(ctx);
  validateRecord(execution.registration, 'declarativeRegistration');
  assert.deepEqual(verifyDeclarativeRegistration(ctx.config, ctx.repo, ctx.assignment,
    ctx.workspace, execution), [declarativeRegistrationFiles[0]]);
  assert.deepEqual(execution.changedFiles, [file]);
  assert.deepEqual(skillChangePopulation(execution), [declarativeRegistrationFiles[0], file].sort());
  writeFileSync(join(ctx.workspace, declarativeRegistrationFiles[0]), 'tampered');
  assert.throws(() => verifyDeclarativeRegistration(ctx.config, ctx.repo, ctx.assignment,
    ctx.workspace, execution), /changed after finalization/);
});

test('Controller does not accept author-written registration or arbitrary finalizer edits', async t => {
  const ctx = await fixture(t);
  writeFileSync(join(ctx.workspace, declarativeRegistrationFiles[0]), 'model-edited');
  await assert.rejects(finalize(ctx), /outside its test-only bounds/);
});

for (const [label, change] of [
  ['different case', value => { value.caseIds = ['excel-agent.aad.unreviewed']; }],
  ['unreported owner edit', value => { value.changedFiles = []; value.fileSha256 = {}; }],
  ['false owner hash', value => { value.fileSha256[declarativeRegistrationFiles[0]] = '0'.repeat(64); }]
]) {
  test(`registration rejects ${label} even when the native process exits zero`, async t => {
    const ctx = await fixture(t);
    await assert.rejects(finalize(ctx, async (_exe, _args, cwd) => {
      writeFileSync(join(cwd, declarativeRegistrationFiles[0]), '{"synthetic":"registered"}\n');
      const result = {
        caseIds: [CASE], changedFiles: [declarativeRegistrationFiles[0]],
        fileSha256: { [declarativeRegistrationFiles[0]]:
          hash(readFileSync(join(cwd, declarativeRegistrationFiles[0]))) }
      };
      change(result);
      return { stdout: `PILOT_DECLARATIVE_REGISTRATION:${json(result)}`, stderr: '' };
    }), /invalid identities or owner file bounds/);
  });
}

test('continuation rebinds verified owner metadata without rerunning registration or widening scope', async t => {
  const ctx = await fixture(t);
  const prior = await finalize(ctx);
  const next = { ...ctx.assignment, id: 'synthetic-continuation' };
  const config = { ...ctx.config, stateDirectory: join(ctx.root, 'next-state') };
  const job = { ...ctx.job, id: next.id };
  const continuation = {
    priorStateDirectory: ctx.config.stateDirectory, priorAssignment: ctx.assignment,
    priorJob: ctx.job, priorResult: { skillExecution: prior, sourceRevision: ctx.base }
  };
  assert.throws(() => rebindDeclarativeRegistration(config, ctx.ledger, ctx.repo,
    { ...next, evidenceIds: ['unreviewed'] }, job, continuation), /changed its reviewed source/);
  const registration = rebindDeclarativeRegistration(config, ctx.ledger, ctx.repo,
    next, job, continuation);
  assert.equal(registration.assignmentId, next.id);
  assert.deepEqual(registration.fileSha256, prior.registration.fileSha256);
  assert.deepEqual(verifyDeclarativeRegistration(config, ctx.repo, next,
    ctx.workspace, { ...prior, registration }), registration.changedFiles);
  assert.equal(JSON.parse(readFileSync(prior.registration.artifactRef)).assignmentId, ctx.assignment.id);
  assert.throws(() => verifyDeclarativeRegistration(config, ctx.repo, next,
    ctx.workspace, prior), /no longer matches/);
});

test('validation preserves native receipts outside the clean final-SHA clone', async t => {
  const ctx = await fixture(t);
  const execution = await finalize(ctx);
  await ctx.g(['add', '.']);
  await ctx.g(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Synthetic authored scenario and owner registration']);
  const revision = await ctx.g(['rev-parse', 'HEAD']);
  let calls = 0;
  const results = await runValidation(ctx.config, ctx.ledger, ctx.job, ctx.repo, revision,
    async (_exe, args, cwd, _timeout, env) => {
      calls++;
      assert.notEqual(cwd, ctx.workspace);
      assert(existsSync(args[0]));
      const request = JSON.parse(env.PILOT_DECLARATIVE_REQUEST);
      assert.equal(request.sourceRevision, revision);
      const receipt = {
        format: declarativeProfile, assignmentId: ctx.job.id,
        sourceRevision: revision, baseRevision: ctx.base, status: 'passed',
        repeats: 5, retries: 0, workers: 1, browserCleanup: 'verified',
        caseIds: [CASE], evidenceIds: request.evidenceIds, inputItemIds: request.inputItemIds
      };
      mkdirSync(request.outputRoot, { recursive: true });
      writeFileSync(join(request.outputRoot, 'receipt.json'), json(receipt));
      return { stdout: `PILOT_DECLARATIVE_RECEIPT:${json(receipt)}`, stderr: '' };
    }, undefined, null, execution);
  assert.equal(calls, 1);
  assert.equal(results[0].status, 'passed');
  const artifact = JSON.parse(readFileSync(results[0].artifactRefs[0], 'utf8'));
  assert(existsSync(artifact.output.nativeReceipt));
  assert.equal(await ctx.g(['rev-parse', 'HEAD']), revision);
  assert.equal(await ctx.g(['status', '--porcelain']), '');
});

test('an exit-zero runner without native five-pass proof is blocked without automatic retry', async t => {
  const ctx = await fixture(t);
  const execution = await finalize(ctx);
  await ctx.g(['add', '.']);
  await ctx.g(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Synthetic final revision']);
  const revision = await ctx.g(['rev-parse', 'HEAD']);
  let calls = 0;
  const results = await runValidation(ctx.config, ctx.ledger, ctx.job, ctx.repo, revision,
    async () => { calls++; return { stdout: 'exit zero is not proof', stderr: '' }; },
    undefined, null, execution);
  assert.equal(calls, 1);
  assert.equal(results[0].status, 'blocked');
});
