import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
import { runInNewContext } from 'node:vm';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync,
  realpathSync, symlinkSync, renameSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { configAt, hash, json, validateRecord } from '../src/common.js';
import {
  configureDeclarativeGate, declarativeProfile, declarativeRegistrationFiles,
  declarativeRequest, skillChangePopulation, verifyDeclarativeRegistration
} from '../src/declarative-e2e.js';
import { repositoryValidationContract } from '../src/repository-skills.js';
import {
  command, finalizeDeclarativeSkill, rebindDeclarativeRegistration, runValidation,
  seedDeclarativeDependencies
} from '../src/workers.js';
import { prepareValidationWorkspace } from '../src/validation-workspace.js';
import { updateResource, resourceRecord } from '../src/resource-lifecycle.js';

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

for (const failure of [false, true]) {
  test(`standalone native preflight ${failure ? 'stops with sanitized typecheck evidence' :
    'loads and selects before existing checks without executing cases'}`, () => {
    const calls = [], lines = [];
    const request = { options: { installDependencies: false, yarnEntryPoint: 'synthetic-yarn.cjs' } };
    const runtime = {
      execPath: process.execPath, cwd: () => process.cwd(),
      env: { PILOT_DECLARATIVE_REQUEST: json(request), EXCELAGENT_CDP_ENDPOINT: 'synthetic-browser' }
    };
    const profile = {
      APP: native.APP,
      validateRequest: value => value,
      nativeApi: () => {
        calls.push('load');
        assert.equal(runtime.env.EXCELAGENT_CDP_ENDPOINT, undefined);
        return { loader: { loadExcelAgentExecutionSelection:
          () => ({ enabledCaseKeys: [CASE] }) } };
      },
      selectCases: () => { calls.push('select'); return selected; }
    };
    runInNewContext(readFileSync(new URL('../scripts/validation/native-preflight.cjs',
      import.meta.url), 'utf8'), {
      require: name => name === './1js-declarative-e2e.cjs' ? profile :
        name === 'node:child_process' ? {
          execFileSync: (_executable, args) => {
            calls.push(args.at(-1));
            if (failure) throw Object.assign(new Error('SECRET_MUST_NOT_PERSIST'), {
              status: 2, stdout: 'SECRET_MUST_NOT_PERSIST error TS2307'
            });
          }
        } : require(name),
      process: runtime, console: { log: line => lines.push(line) }
    });
    assert.deepEqual(calls, failure
      ? ['load', 'select', 'typecheck']
      : ['load', 'select', 'typecheck', 'declarative:validate-repair']);
    assert(!lines.join('\n').includes('SECRET_MUST_NOT_PERSIST'));
    if (failure) {
      const diagnostic = JSON.parse(lines.find(line =>
        line.startsWith('PILOT_PREFLIGHT_FAILURE:')).split('PILOT_PREFLIGHT_FAILURE:')[1]);
      assert.equal(diagnostic.stage, 'typecheck');
      assert.equal(diagnostic.exitCode, 2);
      assert.deepEqual(diagnostic.typeErrors, ['TS2307']);
      assert.equal(runtime.exitCode, 1);
      assert(!lines.includes('PILOT_PREFLIGHT_NATIVE:passed'));
    } else {
      assert(lines.includes('PILOT_PREFLIGHT_NATIVE:passed'));
      assert.equal(runtime.exitCode, undefined);
    }
  });
}

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

for (const condition of ['timeout-leftover', 'failed-restored', 'passed-leftover', 'passed-restored',
  'cancelled-restored', 'query-failed', 'receipt-failed', 'passed-receipt-failed']) {
  test(`native attempt independently persists command and restoration: ${condition}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'native-attempt-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const batch = join(root, 'native-batch');
    mkdirSync(batch);
    const { summary } = nativeSummary();
    const failed = ['timeout-leftover', 'failed-restored', 'cancelled-restored',
      'query-failed', 'receipt-failed'].includes(condition);
    if (failed) { summary.status = 'running'; summary.cases.pop(); }
    const bytes = json(summary);
    const summaryFile = join(batch, 'summary.json');
    writeFileSync(summaryFile, bytes);
    const request = { assignmentId: 'synthetic-attempt', sourceRevision: 'a'.repeat(40),
      attemptId: 'c'.repeat(64), profileSha256: 'd'.repeat(64), outputRoot: root,
      options: { commandTimeoutMs: 1000 }, controllerTimeoutMs: 10000 };
    const before = [{ id: 'existing', url: 'https://example.invalid/private?token=canary-secret' }];
    const leftover = { id: 'owned', url: 'https://example.invalid/workbook/private' };
    const stdout = '[local-owned-page] {"targetId":"owned","testTitle":"Synthetic protected regression"}\n';
    let queries = 0;
    const run = () => {
      if (condition === 'timeout-leftover') {
        return execFileSync(process.execPath, ['-e',
          'process.stdout.write(process.argv[1]); setInterval(() => {}, 1000);', stdout],
        { timeout: 1000, encoding: 'utf8', windowsHide: true });
      }
      if (failed) throw Object.assign(new Error('primary canary-secret'), {
        code: condition === 'cancelled-restored' ? 'ABORT_ERR' : undefined,
        status: 7, stdout, stderr: `canary-secret ${'x'.repeat(20000)}`
      });
      return stdout;
    };
    const options = {
      run,
      sanitize: value => value.replaceAll('canary-secret', '[redacted]')
        .replace(/https?:\/\/\S+/g, '[url]'),
      targets: async () => {
        queries++;
        if (queries === 1) return before;
        assert.equal(JSON.parse(readFileSync(join(root, 'primary-command.json'))).status,
          failed ? 'failed' : 'passed', 'Primary result must be durable before querying pages');
        if (condition === 'query-failed') throw new Error('query canary-secret');
        return condition.endsWith('leftover') ? [...before, leftover] : before;
      }
    };
    if (condition.endsWith('receipt-failed')) options.write = (file, value, exclusive = true) => {
      if (file.endsWith('browser-cleanup.json') && !exclusive)
        throw Object.assign(new Error('receipt canary-secret'), { code: 'EACCES' });
      writeFileSync(file, json(value), { flag: exclusive ? 'wx' : 'w' });
    };
    let caught;
    try { await native.runNativeAttempt(request, options); }
    catch (error) { caught = error; }
    assert.equal(Boolean(caught), condition !== 'passed-restored');
    const primary = JSON.parse(readFileSync(join(root, 'primary-command.json')));
    const diagnostic = JSON.parse(readFileSync(join(root, 'controller-diagnostic.json')));
    assert.equal(primary.attemptId, request.attemptId);
    assert.equal(diagnostic.cleanup.attemptId, request.attemptId);
    assert.equal(diagnostic.profileSha256, request.profileSha256);
    assert.equal(primary.status, failed ? 'failed' : 'passed');
    assert.equal(diagnostic.cleanup.status,
      condition.endsWith('leftover') || condition === 'query-failed' ? 'failed' : 'verified');
    assert.equal(diagnostic.native.summaryRef.sha256, hash(bytes));
    assert.equal(diagnostic.native.completedRounds.length, failed ? 4 : 5);
    assert.equal(diagnostic.native.lastCompletedRound.repeatEachIndex, failed ? 3 : 4);
    assert.equal(readFileSync(summaryFile, 'utf8'), bytes, 'Never rewrite the native summary');
    assert.equal(diagnostic.native.nativeStatus, failed ? 'running' : 'passed');
    assert.equal(diagnostic.effectiveBudgets.nativeCommandMs, 1000);
    assert.equal(diagnostic.effectiveBudgets.controllerMs, 10000);
    assert(!existsSync(join(root, 'receipt.json')), 'The diagnostic is not a publication receipt');
    assert(!json(diagnostic).includes('canary-secret'));
    assert(!json(diagnostic).includes('https://'));
    assert(Buffer.byteLength(json(diagnostic)) < 100000);
    if (condition === 'timeout-leftover') {
      assert.equal(diagnostic.interruption, 'timeout');
      assert.equal(primary.error.code, 'ETIMEDOUT');
      assert.match(caught.message, /native command: timeout.*browser restoration failed/);
      assert.equal(diagnostic.ownedPages[0].presentAfter, true);
      assert.equal(diagnostic.ownedPages[0].preExisting, false);
    }
    if (condition === 'cancelled-restored') assert.equal(diagnostic.interruption, 'cancelled');
    if (condition === 'receipt-failed') {
      assert.equal(primary.error.exitCode, 7);
      assert.match(caught.message, /native command: command-failure.*persist-browser-cleanup/);
      assert.equal(diagnostic.secondaryErrors[0].code, 'EACCES');
    }
    if (condition === 'passed-leftover') assert.equal(diagnostic.interruption, null);
    if (condition === 'failed-restored') {
      assert.equal(primary.error.exitCode, 7);
      assert.equal(primary.error.stderr.truncated, true);
    }
    if (condition === 'passed-receipt-failed') {
      assert.equal(primary.exitCode, 0);
      assert.equal(diagnostic.secondaryErrors[0].stage, 'persist-browser-cleanup.json');
    }
    if (['failed-restored', 'cancelled-restored'].includes(condition)) {
      assert.equal(diagnostic.ownedPages[0].presentAfter, false);
      assert.deepEqual(diagnostic.cleanup.before, diagnostic.cleanup.after);
    }
  });
}

test('diagnostics do not fabricate missing, oversized or malformed native history', t => {
  const root = mkdtempSync(join(tmpdir(), 'native-history-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  assert.equal(native.nativeProgress(root).lastCompletedRound, null);
  const batch = join(root, 'batch');
  mkdirSync(batch);
  const file = join(batch, 'summary.json');
  for (const content of ['{invalid', 'x'.repeat(4 * 1024 * 1024 + 1)]) {
    writeFileSync(file, content);
    const progress = native.nativeProgress(root);
    assert.equal(progress.lastCompletedRound, null);
    assert(progress.error);
    assert.equal(readFileSync(file, 'utf8'), content);
  }
});

test('profile failure reporting preserves feed authentication classification without raw output', () => {
  const output = native.profileFailure(Object.assign(new Error('canary-secret'), {
    stdout: 'Your token is invalid. canary-secret',
    stderr: 'Authentication to package feed failed canary-secret', status: 2
  }));
  assert.match(output, /Authentication to package feed failed/);
  assert.equal(JSON.parse(output).exitCode, 2);
  assert(!output.includes('canary-secret'));
});

for (const condition of ['timeout-leftover', 'failed-restored', 'passed-leftover', 'passed-restored']) {
  test(`standalone profile publication gate: ${condition}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'native-profile-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const scenarioFile = join(root, file);
    mkdirSync(dirname(scenarioFile), { recursive: true });
    writeFileSync(scenarioFile, 'synthetic L3 declaration');
    const declarationSha = hash(readFileSync(scenarioFile));
    const outputRoot = join(root, 'output');
    const yarnEntryPoint = join(root, 'yarn.cjs');
    writeFileSync(yarnEntryPoint, '');
    const request = {
      format: declarativeProfile, assignmentId: 'synthetic-profile',
      baseRevision: 'a'.repeat(40), sourceRevision: 'a'.repeat(40),
      evidenceIds: ['synthetic'], inputItemIds: ['synthetic'],
      changedFiles: [file], testsAddedOrUpdated: [CASE], outputRoot,
      options: { yarnEntryPoint, maxCases: 1, cdpEndpoint: 'http://127.0.0.1:9222/' }
    };
    const runtime = { execPath: process.execPath, cwd: () => root, env: {
      PILOT_DECLARATIVE_REQUEST: json(request)
    } };
    const loader = {
      loadExcelAgentDeclarationConfig: () => ({}),
      loadExcelAgentScenarios: () => [scenario],
      loadExcelAgentScenario: () => scenario,
      loadExcelAgentExecutionSelection: () => ({ enabledCaseKeys: [CASE] })
    };
    const appRequire = name => {
      if (name === 'ts-node') return { register() {} };
      if (name.endsWith('excelAgentDeclaration.ts')) return loader;
      if (name.endsWith('catalogParity.ts')) return { scenarioCatalogEntry: () => entry };
      if (name === 'yaml') return { parse: () => ({}) };
      if (name === '@1js/declarative-e2e-runtime')
        return { sanitizeDiagnosticText: () => '[sanitized synthetic diagnostic]' };
      throw new Error(`Unexpected synthetic module: ${name}`);
    };
    let inventories = 0;
    const context = {
      module: { exports: {} }, process: runtime, Buffer, URL, AbortSignal,
      console: { log() {} },
      fetch: async () => ({ ok: true, json: async () => {
        inventories++;
        return [{ id: 'existing', type: 'page', url: 'about:blank' },
          ...(inventories > 1 && condition.endsWith('leftover')
            ? [{ id: 'owned', type: 'page', url: 'about:blank' }] : [])];
      } }),
      require: name => {
        if (name === 'node:module') return { createRequire: () => appRequire };
        if (name !== 'node:child_process') return require(name);
        return { execFileSync: (executable, args) => {
          if (executable === 'git')
            return args.includes('rev-parse') ? request.sourceRevision : '';
          if (!args.includes('declarative:local')) return '';
          const batch = join(outputRoot, 'batch');
          mkdirSync(batch);
          const { summary, execution } = nativeSummary();
          execution.declarations[0].sha256 = declarationSha;
          if (condition.startsWith('timeout') || condition.startsWith('failed')) {
            summary.status = 'running';
            summary.cases.pop();
          }
          for (const result of summary.cases) {
            result.attachments[0].file = join(batch, result.attachments[0].file);
            writeFileSync(result.attachments[0].file, json(execution));
          }
          writeFileSync(join(batch, 'summary.json'), json(summary));
          writeFileSync(join(batch, 'selection.json'), json({
            kind: 'runtime-selection', lane: 'aad-enterprise', repeats: 5,
            selected: [{ id: CASE, sha256: declarationSha }]
          }));
          if (condition.startsWith('timeout') || condition.startsWith('failed'))
            throw Object.assign(new Error('synthetic command failure'), {
              code: condition.startsWith('timeout') ? 'ETIMEDOUT' : undefined, status: 3
            });
          return '';
        } };
      }
    };
    runInNewContext(readFileSync(new URL('../scripts/validation/1js-declarative-e2e.cjs',
      import.meta.url), 'utf8'), context);
    if (condition === 'passed-restored') {
      await context.module.exports.main();
      const receipt = JSON.parse(readFileSync(join(outputRoot, 'receipt.json')));
      assert.equal(receipt.status, 'passed');
      assert.equal(receipt.browserCleanup, 'verified');
    } else {
      await assert.rejects(context.module.exports.main(), /Native attempt failed/);
      assert(!existsSync(join(outputRoot, 'receipt.json')));
    }
    assert.equal(inventories, 2);
  });
}

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
    }, undefined, null, { skillExecution: execution });
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
    undefined, null, { skillExecution: execution });
  assert.equal(calls, 1);
  assert.equal(results[0].status, 'blocked');
});

test('Controller records outer process interruption even when the profile cannot finish', async t => {
  const ctx = await fixture(t);
  const execution = await finalize(ctx);
  await ctx.g(['add', '.']);
  await ctx.g(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Synthetic final revision']);
  const revision = await ctx.g(['rev-parse', 'HEAD']);
  let summaryFile, summaryBytes, attemptId;
  const results = await runValidation(ctx.config, ctx.ledger, ctx.job, ctx.repo, revision,
    async (_exe, _args, _cwd, _timeout, env) => {
      const request = JSON.parse(env.PILOT_DECLARATIVE_REQUEST);
      attemptId = request.attemptId;
      const batch = join(request.outputRoot, 'batch');
      mkdirSync(batch, { recursive: true });
      const { summary } = nativeSummary();
      summary.status = 'running';
      summary.cases.pop();
      summaryBytes = json(summary);
      summaryFile = join(batch, 'summary.json');
      writeFileSync(summaryFile, summaryBytes);
      writeFileSync(join(request.outputRoot, 'primary-command.json'),
        json({ attemptId, status: 'running' }));
      throw Object.assign(new Error('canary-secret'), {
        killed: true, signal: 'SIGTERM', code: null, ownedProcessesExited: true
      });
    }, undefined, null, { skillExecution: execution });
  assert.equal(results[0].status, 'blocked');
  assert.equal(results[0].attemptCount, 1);
  const artifact = JSON.parse(readFileSync(results[0].artifactRefs[0]));
  const diagnostic = JSON.parse(readFileSync(artifact.output.nativeInterruption));
  assert.equal(diagnostic.attemptId, attemptId);
  assert.equal(diagnostic.interruption, 'controller-termination');
  assert.equal(diagnostic.timeoutConfirmed, false);
  assert.equal(diagnostic.primary.signal, 'SIGTERM');
  assert.equal(diagnostic.effectiveBudgets.controllerMs, ctx.gate.timeoutMs);
  assert.equal(diagnostic.browserRestoration, 'unverified');
  assert.equal(diagnostic.native.lastCompletedRound.repeatEachIndex, 3);
  assert.equal(diagnostic.native.completedRounds.length, 4);
  assert.equal(readFileSync(summaryFile, 'utf8'), summaryBytes);
  assert.equal(JSON.parse(readFileSync(diagnostic.profileCommandRef)).status, 'running');
  assert(!json(diagnostic).includes('canary-secret'));
});

for (const condition of ['valid', 'tampered', 'proof-drift', 'managed', 'managed-cleanup-failure']) {
  test(`validation reuses accepted detached dependencies ${condition}`, async t => {
    const ctx = await fixture(t);
    const execution = await finalize(ctx);
    writeFileSync(join(ctx.workspace, '.gitignore'), 'node_modules/\n');
    await ctx.g(['add', '.']);
    await ctx.g(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '-m', 'Synthetic final revision']);
    const revision = await ctx.g(['rev-parse', 'HEAD']);
    const output = 'ooui/node_modules/synthetic/index.js';
    mkdirSync(dirname(join(ctx.workspace, output)), { recursive: true });
    writeFileSync(join(ctx.workspace, output), 'Synthetic dependency\n');
    const managed = condition.startsWith('managed'), cleanupFailure = condition === 'managed-cleanup-failure';
    const passed = condition === 'valid' || condition === 'managed';
    const workspace = managed
      ? join(ctx.config.stateDirectory, 'preflight-workspaces', 'accepted') : join(ctx.root, 'accepted');
    const preparation = await prepareValidationWorkspace({
      source: ctx.workspace, workspace, revision, timeoutMs: 30000,
      seed: (source, target) => seedDeclarativeDependencies(source, target, revision, 30000),
      lifecycle: managed ? { stateDirectory: ctx.config.stateDirectory, kind: 'preflight',
        assignmentId: ctx.job.id, attemptId: 'managed-preflight', references: ['validation-handoff'],
        created: () => {} } : null
    });
    const proof = { format: 'validation-preflight-v1', status: 'passed',
      sourceRevision: revision, profileSha256: ctx.gate.profileSha256, workspace, preparation };
    const proofPath = join(ctx.root, 'preflight.json');
    writeFileSync(proofPath, json(proof));
    const preflight = { path: proofPath, sha256: hash(readFileSync(proofPath)) };
    if (managed) await updateResource(ctx.config.stateDirectory, preparation.resourceId, {
      processesExited: true, evidence: [preflight]
    });
    if (condition === 'tampered') writeFileSync(join(workspace, output), 'Changed dependency');
    if (condition === 'proof-drift') writeFileSync(proofPath, '{}');
    let calls = 0;
    let artifactPath;
    const run = () => runValidation(ctx.config, ctx.ledger, ctx.job, ctx.repo, revision,
      async (_exe, _args, cwd, _timeout, env) => {
        calls++;
        assert.equal(cwd, workspace);
        const request = JSON.parse(env.PILOT_DECLARATIVE_REQUEST);
        assert.equal(request.options.installDependencies, false);
        if (cleanupFailure) {
          renameSync(workspace, `${workspace}-original`);
          mkdirSync(workspace);
          writeFileSync(join(workspace, 'canary'), 'replacement must survive');
          throw Object.assign(new Error('Synthetic primary runner failure'), {
            code: 1, stderr: 'Synthetic primary runner failure', stdout: ''
          });
        }
        const receipt = { format: declarativeProfile, assignmentId: ctx.job.id,
          sourceRevision: revision, baseRevision: ctx.base, status: 'passed',
          repeats: 5, retries: 0, workers: 1, browserCleanup: 'verified',
          caseIds: [CASE], evidenceIds: request.evidenceIds, inputItemIds: request.inputItemIds };
        mkdirSync(request.outputRoot, { recursive: true });
        writeFileSync(join(request.outputRoot, 'receipt.json'), json(receipt));
        return { stdout: `PILOT_DECLARATIVE_RECEIPT:${json(receipt)}`, stderr: '' };
      }, undefined, { [ctx.gate.id]: { preflight } }, { skillExecution: execution });
    if (condition === 'proof-drift') await assert.rejects(run(), /evidence changed/);
    else {
      const result = await run();
      assert.equal(result[0].status, passed ? 'passed' : 'blocked');
      artifactPath = result[0].artifactRefs.at(-1);
    }
    assert.equal(calls, passed || cleanupFailure ? 1 : 0);
    if (managed) {
      const resource = resourceRecord(ctx.config.stateDirectory, preparation.resourceId);
      if (cleanupFailure) {
        assert.notEqual(resource.stage, 'complete');
        assert.equal(resource.primaryError.status, 'blocked');
        assert.match(resource.cleanupError.message, /identity changed/);
        assert.equal(readFileSync(join(workspace, 'canary'), 'utf8'), 'replacement must survive');
        const artifact = JSON.parse(readFileSync(artifactPath, 'utf8'));
        assert.match(artifact.output.stderr, /Synthetic primary runner failure/);
        assert.match(artifact.output.cleanupError, /identity changed/);
      } else {
        assert.equal(resource.stage, 'complete', resource.cleanupError?.message);
        assert(!existsSync(workspace));
      }
      assert.equal(hash(readFileSync(proofPath)), preflight.sha256);
      assert(resource.archivedEvidence.some(ref => ref.sha256 === preflight.sha256));
      assert.equal(readFileSync(join(ctx.workspace, output), 'utf8'), 'Synthetic dependency\n');
    }
    assert.equal(await ctx.g(['status', '--porcelain']), '');
  });
}

for (const condition of ['valid', 'source-dirty', 'different-revision', 'existing-output',
  'external-link', 'retained-valid', 'retained-byte-mismatch']) {
  test(`declarative final-SHA dependency seed ${condition}`, async t => {
    const ctx = await fixture(t);
    writeFileSync(join(ctx.workspace, '.gitignore'), 'node_modules/\nlib/\n.store/\n.npmrc\n');
    const packageRoot = join(ctx.workspace, 'ooui', 'packages', 'synthetic');
    mkdirSync(packageRoot, { recursive: true });
    writeFileSync(join(packageRoot, 'package.json'), '{"name":"synthetic"}\n');
    await ctx.g(['add', '.']);
    await ctx.g(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '-m', 'Synthetic final revision']);
    const revision = await ctx.g(['rev-parse', 'HEAD']);
    for (const path of ['ooui/.store/synthetic/node_modules/synthetic/index.js',
      'ooui/packages/synthetic/lib/index.js', 'ooui/node_modules/fixture/index.js']) {
      mkdirSync(dirname(join(ctx.workspace, path)), { recursive: true });
      writeFileSync(join(ctx.workspace, path), 'Synthetic built output\n');
    }
    writeFileSync(join(ctx.workspace, '.npmrc'), 'SYNTHETIC-EXCLUDED-FILE\n');
    if (condition === 'valid')
      for (let index = 0; index < 51; index++) {
        const output = join(ctx.workspace, 'ooui', 'packages', `extra-${index}`, 'lib');
        mkdirSync(output, { recursive: true });
        writeFileSync(join(output, 'index.js'), `Built package ${index}\n`);
      }
    const target = join(ctx.root, 'validation');
    await command('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
      'clone', '--quiet', '--no-hardlinks', '--', ctx.workspace, target], ctx.root);
    if (condition === 'source-dirty') writeFileSync(join(ctx.workspace, file), 'Changed source');
    if (condition === 'different-revision')
      await command('git', ['checkout', '--quiet', '--detach', ctx.base], target);
    if (condition === 'existing-output') {
      mkdirSync(join(target, 'ooui', 'packages', 'synthetic', 'lib'));
      writeFileSync(join(target, 'ooui', 'packages', 'synthetic', 'lib', 'existing.js'), 'Existing');
    }
    symlinkSync(condition === 'external-link' ? ctx.root : packageRoot,
      join(ctx.workspace, 'ooui', 'node_modules', 'workspace-synthetic'),
      process.platform === 'win32' ? 'junction' : 'dir');
    if (condition.startsWith('retained-')) {
      const owned = fileURLToPath(new URL(`../.state/copy-diagnostic-test-${randomUUID()}`, import.meta.url));
      const retained = join(owned, randomUUID());
      t.after(() => rmSync(owned, { recursive: true, force: true }));
      const paths = ['ooui/.store', 'ooui/node_modules', 'ooui/packages/synthetic/lib'];
      for (const path of ['ooui/.store/synthetic/node_modules/synthetic/index.js',
        'ooui/packages/synthetic/lib/index.js', 'ooui/node_modules/fixture/index.js']) {
        mkdirSync(dirname(join(retained, path)), { recursive: true });
        writeFileSync(join(retained, path), 'Synthetic built output\n');
      }
      symlinkSync(packageRoot, join(retained, 'ooui', 'node_modules', 'workspace-synthetic'),
        process.platform === 'win32' ? 'junction' : 'dir');
      if (condition === 'retained-byte-mismatch')
        writeFileSync(join(retained, 'ooui', 'packages', 'synthetic', 'lib', 'index.js'),
          'Tampered diagnostic output\n');
      const progressPath = `${retained}.dependency-copy-test.jsonl`;
      writeFileSync(progressPath, `${json({
        format: 'dependency-copy-progress-v1', directoryOffset: 0, paths, checkpointInterval: 10
      })}\n${json({
        status: 'passed', completedPaths: paths.length, activePaths: [], failedPath: null
      })}\n`);
      const proof = {
        format: 'standalone-dependency-copy-diagnostic-v1',
        status: 'diagnostic-copy-completed-not-qualified', phase: 'post-source-check',
        directoryBatchCopyCompleted: true, source: ctx.workspace, workspace: retained,
        expectedSource: revision,
        expectedHelper: hash(readFileSync(new URL('../src/dependency-snapshot-copy.cjs', import.meta.url))),
        currentPaths: paths, omittedNonDirectories: [], isFormalValidation: false,
        countsTowardBusinessFive: false, eligibleAsDependencySeed: false,
        nativeUnitStarted: false, businessStarted: false, completedAt: new Date().toISOString(),
        batches: [{ index: 0, paths, status: 'passed', ownedProcessesExited: true, progressPath }]
      };
      const manifest = join(owned, 'diagnostic.json');
      writeFileSync(manifest, json(proof));
      const options = { retainedCopy: { path: manifest, sha256: hash(json(proof)) } };
      if (condition === 'retained-byte-mismatch')
        await assert.rejects(seedDeclarativeDependencies(ctx.workspace, target, revision, 30000,
          options), /copied output bytes/);
      else {
        const seeded = await seedDeclarativeDependencies(ctx.workspace, target, revision, 30000, options);
        assert.equal(seeded.sourceRevision, revision);
        assert.match(seeded.sha256, /^[a-f0-9]{64}$/);
        assert.equal(realpathSync(join(target, 'ooui', 'node_modules', 'workspace-synthetic')),
          realpathSync(join(target, 'ooui', 'packages', 'synthetic')));
        assert.equal(readFileSync(join(target, 'ooui', 'packages', 'synthetic', 'lib', 'index.js'),
          'utf8'), 'Synthetic built output\n');
      }
      assert(existsSync(`${retained}.dependency-copy-consumed.json`));
      assert(!existsSync(join(retained, 'ooui', '.store')));
      assert.equal(await ctx.g(['status', '--porcelain']), '');
    } else if (condition === 'valid') {
      assert.equal((await command('git', ['rev-parse', 'HEAD'], target)).stdout.trim(), revision);
      assert.equal((await command('git', ['-c', 'core.autocrlf=false',
        'status', '--porcelain'], target)).stdout.trim(), '');
      const seeded = await seedDeclarativeDependencies(ctx.workspace, target, revision, 30000);
      assert.equal(seeded.sourceRevision, revision);
      assert.match(seeded.sha256, /^[a-f0-9]{64}$/);
      assert.equal(readFileSync(join(target, 'ooui', 'packages', 'synthetic', 'lib', 'index.js'), 'utf8'),
        'Synthetic built output\n');
      assert.equal(realpathSync(join(target, 'ooui', 'node_modules', 'workspace-synthetic')),
        realpathSync(join(target, 'ooui', 'packages', 'synthetic')));
      assert.equal(existsSync(join(target, '.npmrc')), false);
      assert.equal(readFileSync(join(target, 'ooui', 'packages', 'extra-50', 'lib', 'index.js'), 'utf8'),
        'Built package 50\n');
      assert.equal(await ctx.g(['status', '--porcelain']), '');
      const verified = await seedDeclarativeDependencies(ctx.workspace, target, revision, 30000,
        { expectedSeed: seeded });
      assert.deepEqual(verified, seeded);
      writeFileSync(join(target, 'ooui', 'packages', 'synthetic', 'lib', 'index.js'),
        'Changed isolated bytes\n');
      await assert.rejects(seedDeclarativeDependencies(ctx.workspace, target, revision, 30000,
        { expectedSeed: seeded }), /copied output bytes/);
      assert.equal(readFileSync(join(target, 'ooui', 'packages', 'synthetic', 'lib', 'index.js'), 'utf8'),
        'Changed isolated bytes\n', 'Verification must not overwrite damaged output');
      await assert.rejects(seedDeclarativeDependencies(ctx.workspace, target, revision, 30000,
        { expectedSeed: { ...seeded, sourceRevision: '0'.repeat(40) } }), /receipt/);
    } else await assert.rejects(seedDeclarativeDependencies(ctx.workspace, target, revision, 30000));
  });
}
