import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';
import { hash } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import { describeAgent, describeAgents, agentInvocation, agentOperationResult, agentOperationError } from '../src/agents.js';

const cli = fileURLToPath(new URL('../src/cli.js', import.meta.url));
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agent-entrypoints-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync(new URL('../pilot.example.json', import.meta.url)));
  config.stateDirectory = join(root, 'state');
  config.statePolicy.accessApproved = true;
  config.sources.workiq.enabled = true;
  config.sources.workiq.scopeApproved = true;
  const file = (name, value) => {
    const path = join(root, `${name}.json`);
    writeFileSync(path, JSON.stringify(value));
    return path;
  };
  const configPath = file('pilot.local', config);
  const invoke = (...args) => spawnSync(process.execPath,
    ['--no-warnings', cli, ...args, '--config', configPath],
    { cwd: root, encoding: 'utf8', timeout: 30000 });
  const result = (...args) => {
    const child = invoke(...args);
    assert.ok([0, 2].includes(child.status), child.stderr);
    return JSON.parse(child.stdout);
  };
  return { root, config, file, invoke, result };
}

test('exactly three role packages expose pinned existing procedures and detached descriptors', () => {
  const roles = describeAgents();
  assert.deepEqual(roles.map(row => row.role), ['collector', 'filter', 'proposer']);
  for (const row of roles) {
    assert.equal(row.format, 'agent-definition-v1');
    for (const skill of [row.skill, ...row.procedures])
      assert.equal(skill.sha256, hash(readFileSync(new URL(`../${skill.path}`, import.meta.url))));
    assert.match(row.resumePolicy, /Never reset, retry or redispatch/);
  }
  roles[0].operations.push('dispatch');
  assert.ok(!describeAgent('collector').operations.includes('dispatch'));
  assert.deepEqual(describeAgent('proposer').procedures.map(row => row.name),
    ['evidence-1js-owner', 'evidence-office-owner', 'evidence-oa-owner']);
  assert.ok(describeAgent('proposer').operations.includes('diagnose-local-validation'));
  assert.ok(describeAgent('proposer').operations.includes('continue-local-authoring'));
});

test('role routing rejects unknown and cross-role operations without echoing untrusted input', () => {
  for (const role of ['__proto__', 'constructor', 'unknown', undefined])
    assert.throws(() => agentInvocation(role, 'help'), error => error.code === 'blocked-agent');
  for (const [role, command] of [
    ['collector', 'dispatch'], ['collector', 'run'], ['filter', 'app-ado'],
    ['filter', 'app-worker'], ['proposer', 'review'], ['proposer', 'collect'],
    ['proposer', 'serve'], ['proposer', 'secret-value'],
    ['collector', 'diagnose-local-validation'], ['filter', 'diagnose-local-validation'],
    ['collector', 'continue-local-authoring'], ['filter', 'continue-local-authoring']
  ]) {
    assert.throws(() => agentInvocation(role, command), error =>
      error.code === 'blocked-agent' && !error.message.includes(command));
  }
});

test('result envelope preserves exact references, pending states and acceptance scope', () => {
  const invocation = agentInvocation('filter', 'filter-consolidate');
  const original = {
    state: 'partial', acceptance: 'single-batch-only',
    source: { revision: 'a'.repeat(40), sha256: 'b'.repeat(64) },
    cohort: { expected: 94, accounted: 15 },
    unresolved: ['unreviewed-members'], nextGate: 'held'
  };
  const result = agentOperationResult(invocation, original);
  assert.deepEqual(result, {
    format: 'agent-operation-result-v1', role: 'filter', operation: 'filter-consolidate',
    kind: 'result', acceptance: 'not-inferred', result: original
  });
  const error = { code: 'blocked-auth', message: 'Supported sign-in required' };
  assert.deepEqual(agentOperationError(invocation, error), {
    format: 'agent-operation-result-v1', role: 'filter', operation: 'filter-consolidate',
    kind: 'error', error
  });
  assert.equal(agentOperationResult({ ...invocation, format: 'untrusted' }, original).format,
    'agent-operation-result-v1');
  assert.throws(() => agentOperationResult({ role: 'collector', operation: 'dispatch' }, original),
    error => error.code === 'blocked-agent');
});

test('diagnostic role envelope preserves its receipt without inferring validation acceptance', () => {
  const receipt = {
    diagnosticId: 'fixture-diagnostic', outcome: 'diagnostic-completed',
    sourceRevision: 'a'.repeat(40), caseCommandInvocations: 1,
    acceptanceEvidence: false, publicationEligible: false
  };
  const result = agentOperationResult(agentInvocation('proposer', 'diagnose-local-validation'), receipt);
  assert.equal(result.result, receipt);
  assert.equal(result.acceptance, 'not-inferred');
  assert.equal(result.workerResult, undefined);
});

test('discovery and role help require no configured state or runtime', t => {
  const { root, config, result } = fixture(t);
  assert.deepEqual(result('agents').map(row => row.role), ['collector', 'filter', 'proposer']);
  for (const role of ['collector', 'filter', 'proposer']) {
    const help = result('agent', role, 'help');
    assert.equal(help.kind, 'result');
    assert.equal(help.result.skill.name, `evidence-${role}`);
    assert.equal(help.acceptance, 'not-inferred');
  }
  assert.equal(existsSync(config.stateDirectory), false);
  const unknown = spawnSync(process.execPath,
    ['--no-warnings', cli, 'agent', 'collector', 'dispatch', '--config', 'missing.local.json'],
    { cwd: root, encoding: 'utf8' });
  assert.equal(unknown.status, 1);
  assert.equal(JSON.parse(unknown.stderr).code, 'blocked-agent');
  assert.equal(existsSync(config.stateDirectory), false);
});

test('facade preserves legacy helper behavior and durable collector run identity', t => {
  const { config, file, result, invoke } = fixture(t);
  const begin = file('begin', { runId: 'agent-run', dryRun: true, provenance: 'synthetic' });
  const created = result('agent', 'collector', 'app-begin', '--file', begin);
  assert.equal(created.operation, 'app-begin');
  assert.equal(created.result.runId, 'agent-run');
  assert.equal(created.result.productionLedgerTouched, false);
  const wrappedRun = invoke('agent', 'collector', 'app-status', '--run', 'agent-run');
  const legacyRun = invoke('app-status', '--run', 'agent-run');
  assert.equal(wrappedRun.status, 2);
  assert.equal(wrappedRun.status, legacyRun.status);
  const wrapped = JSON.parse(wrappedRun.stdout);
  const legacy = JSON.parse(legacyRun.stdout);
  assert.equal(legacy.format, undefined);
  assert.deepEqual(wrapped.result.collection, legacy.collection);
  assert.equal(wrapped.result.summaryPath, legacy.summaryPath);
  for (const role of ['filter', 'proposer']) {
    const inspected = result('agent', role, 'app-status', '--run', 'agent-run');
    assert.equal(inspected.result.summaryPath, legacy.summaryPath);
    assert.deepEqual(inspected.result.collection, legacy.collection);
  }
  assert.equal(existsSync(join(config.stateDirectory, 'app-native', 'live', 'ledger.sqlite')), false);
});

test('three roles retain dry-run gates without reviewing or dispatching fixture evidence', t => {
  const { file, result, invoke } = fixture(t);
  result('agent', 'collector', 'app-begin', '--file',
    file('begin', { runId: 'handoff-run', dryRun: true, provenance: 'synthetic' }));
  for (const [role, command, extra] of [
    ['filter', 'app-review', []],
    ['proposer', 'app-worker', ['--operation', 'prepare']]
  ]) {
    const child = invoke('agent', role, command, '--run', 'handoff-run',
      '--file', file(`${role}-input`, {}), ...extra);
    assert.equal(child.status, 1);
    const rejected = JSON.parse(child.stderr);
    assert.equal(rejected.role, role);
    assert.equal(rejected.kind, 'error');
    assert.match(rejected.error.message, /production|dry.run|disabled/i);
  }
  const status = result('agent', 'collector', 'app-status', '--run', 'handoff-run').result;
  assert.equal(status.productionLedgerTouched, false);
  assert.equal(status.workers.length, 0);
  assert.equal(status.report.summary.reviewedIds.length, 0);
});

test('SDK execution is not an implicit fallback from a role invocation', t => {
  const { invoke, config } = fixture(t);
  for (const [role, command] of [
    ['collector', 'collect'], ['filter', 'review-pending'], ['proposer', 'dispatch']
  ]) {
    const child = invoke('agent', role, command);
    assert.equal(child.status, 1);
    const failure = JSON.parse(child.stderr);
    assert.equal(failure.kind, 'error');
    assert.match(failure.error.message, /explicit --execution-mode standalone-sdk/);
  }
  assert.equal(existsSync(config.stateDirectory), false);
});

for (const route of [
  {
    operation: 'diagnose-local-validation', idKey: 'diagnosticId',
    module: 'local-diagnostic.js', prepare: 'prepareLocalValidationDiagnostic',
    dispatch: 'dispatchLocalValidationDiagnostic',
    success: 'diagnostic-completed', failure: 'diagnostic-failed'
  },
  {
    operation: 'continue-local-authoring', idKey: 'assignmentId',
    module: 'local-authoring-successor.js', prepare: 'prepareLocalAuthoringSuccessor',
    dispatch: 'dispatchLocalAuthoringSuccessor',
    success: 'draft-pr-validated', failure: 'blocked'
  }
]) {
  test(`${route.operation} requires explicit paths and one mode before configuration access`, t => {
    const { root, config, file } = fixture(t);
    const request = file('request', {});
    const missingConfig = join(root, 'missing-config.json');
    for (const flags of [
      ['--file', request, '--config', missingConfig],
      ['--prepare', '--execute', '--file', request, '--config', missingConfig],
      ['--prepare', '--prepare', '--file', request, '--config', missingConfig],
      ['--execute', '--execute', '--file', request, '--config', missingConfig],
      ['--prepare', '--config', missingConfig],
      ['--execute', '--file', request],
      ['--prepare', '--file', '--config', missingConfig],
      ['--execute', '--file', request, '--config']
    ]) {
      const child = spawnSync(process.execPath, ['--no-warnings', cli, 'agent', 'proposer',
        route.operation, ...flags], { cwd: root, encoding: 'utf8', timeout: 30000 });
      assert.equal(child.status, 1, child.stderr);
      const failure = JSON.parse(child.stderr);
      assert.equal(failure.role, 'proposer');
      assert.equal(failure.operation, route.operation);
      assert.equal(failure.error.code, 'blocked-authorization');
      assert.match(failure.error.message, /explicit --file, --config and exactly one/);
      assert.equal(child.stdout, '');
    }
    assert.equal(existsSync(config.stateDirectory), false);
  });

  test(`${route.operation} retains the standalone-mode gate for both phases and entry forms`, t => {
    const { config, file, invoke } = fixture(t);
    const request = file('request', {});
    for (const prefix of [[], ['agent', 'proposer']]) {
      for (const mode of ['--prepare', '--execute']) {
        const child = invoke(...prefix, route.operation, mode, '--file', request);
        assert.equal(child.status, 1, child.stderr);
        const failure = JSON.parse(child.stderr);
        assert.match((failure.error ?? failure).message, /explicit --execution-mode standalone-sdk/);
        assert.equal(child.stdout, '');
      }
    }
    assert.equal(existsSync(config.stateDirectory), false);
  });

  test(`${route.operation} rejects missing IDs and extra execution input without echoing values`, t => {
    const { config, file, invoke } = fixture(t);
    file('pilot.local', { ...config, executionMode: 'standalone-sdk' });
    for (const input of [null, {}, { [route.idKey]: '' }, { [route.idKey]: 7 },
      { untrustedId: 'private-fixture-value' },
      { [route.idKey]: 'fixture-id', override: 'private-fixture-value' }]) {
      const child = invoke('agent', 'proposer', route.operation, '--execute',
        '--file', file('request', input));
      assert.equal(child.status, 1, child.stderr);
      const failure = JSON.parse(child.stderr);
      assert.equal(failure.kind, 'error');
      assert.equal(failure.error.code, 'blocked-reconciliation');
      assert.ok(failure.error.message.includes(`only its prepared ${route.idKey}`));
      assert.ok(!child.stderr.includes('private-fixture-value'));
      assert.equal(child.stdout, '');
    }
  });

  test(`${route.operation} delegates both phases and preserves result/exit semantics with a synthetic core`, t => {
    const { root, config, file } = fixture(t);
    const configPath = file('standalone.local', { ...config, executionMode: 'standalone-sdk' });
    const coreUrl = new URL(`../src/${route.module}`, import.meta.url).href;
    const shim = join(root, 'core-fixture.mjs');
    for (const [mode, outcome, expectedStatus] of [
      ['prepare', undefined, 0], ['execute', route.success, 0], ['execute', route.failure, 2]
    ]) {
      const request = mode === 'prepare'
        ? { previousAssignmentId: 'fixture', authorization: { approved: false } }
        : { [route.idKey]: 'fixture-id' };
      const result = { [route.idKey]: 'fixture-id', outcome };
      if (route.idKey === 'diagnosticId')
        Object.assign(result, { acceptanceEvidence: false, publicationEligible: false });
      const forwardedInput = JSON.stringify(mode === 'prepare' ? request : request[route.idKey]);
      const source = `
        function forward(mode, config, ledger, input) {
          if (mode !== ${JSON.stringify(mode)} ||
            config.stateDirectory !== ${JSON.stringify(config.stateDirectory)} ||
            ledger.directory !== config.stateDirectory ||
            JSON.stringify(input) !== ${JSON.stringify(forwardedInput)})
            throw new Error('Unexpected core delegation');
          return ${JSON.stringify(result)};
        }
        export async function ${route.prepare}(config, ledger, input) {
          return forward('prepare', config, ledger, input);
        }
        export async function ${route.dispatch}(config, ledger, id) {
          return forward('execute', config, ledger, id);
        }
        ${route.idKey === 'diagnosticId' ? `
          export async function inspectCompletedLocalDiagnostic() {
            throw new Error('Unexpected diagnostic inspection in routing fixture');
          }` : ''}`;
      writeFileSync(shim, `
        import { registerHooks } from 'node:module';
        registerHooks({ load(url, context, nextLoad) {
          return url === ${JSON.stringify(coreUrl)}
            ? { format: 'module', shortCircuit: true, source: ${JSON.stringify(source)} }
            : nextLoad(url, context);
        }});`);
      const child = spawnSync(process.execPath, ['--no-warnings', '--import', pathToFileURL(shim).href, cli,
        'agent', 'proposer', route.operation, `--${mode}`, '--file', file('request', request),
        '--config', configPath], { cwd: root, encoding: 'utf8', timeout: 30000 });
      assert.equal(child.status, expectedStatus, child.stderr);
      assert.equal(child.stderr, '');
      const envelope = JSON.parse(child.stdout);
      assert.deepEqual(envelope.result, JSON.parse(JSON.stringify(result)));
      assert.equal(envelope.operation, route.operation);
      assert.equal(envelope.acceptance, 'not-inferred');
    }
  });
}

test('diagnostic CLI preserves real core authorization and never-executed guards without workers', t => {
  const { config, file, invoke } = fixture(t);
  file('pilot.local', { ...config, executionMode: 'standalone-sdk' });
  for (const [mode, request, message] of [
    ['--prepare', {}, /Diagnostic input artifact changed/],
    ['--execute', { diagnosticId: 'unprepared-diagnostic' }, /never-executed diagnostic.*no retry/]
  ]) {
    const child = invoke('agent', 'proposer', 'diagnose-local-validation', mode,
      '--file', file('diagnostic', request));
    assert.equal(child.status, 1, child.stderr);
    assert.match(JSON.parse(child.stderr).error.message, message);
    assert.equal(child.stdout, '');
  }
  const ledger = new Ledger(config.stateDirectory, { readOnly: true });
  try {
    assert.equal(ledger.status().operations.length, 0);
    assert.equal(ledger.status().jobs.length, 0);
    assert.equal(ledger.all('workerResult').length, 0);
  } finally { ledger.close(); }
});

test('authoring successor CLI preserves real core request and prepared-job guards without a model', t => {
  const { config, file, invoke } = fixture(t);
  file('pilot.local', { ...config, executionMode: 'standalone-sdk' });
  for (const [mode, request, message] of [
    ['--prepare', {}, /Invalid authoring successor request/],
    ['--execute', { assignmentId: 'unprepared-successor' }, /never-dispatched authoring successor/]
  ]) {
    const child = invoke('agent', 'proposer', 'continue-local-authoring', mode,
      '--file', file('successor', request));
    assert.equal(child.status, 1, child.stderr);
    const failure = JSON.parse(child.stderr);
    assert.equal(failure.operation, 'continue-local-authoring');
    assert.equal(failure.kind, 'error');
    assert.match(failure.error.message, message);
    assert.equal(child.stdout, '');
  }
  const ledger = new Ledger(config.stateDirectory, { readOnly: true });
  try {
    assert.equal(ledger.status().operations.length, 0);
    assert.equal(ledger.status().jobs.length, 0);
    assert.equal(ledger.all('workerResult').length, 0);
  } finally { ledger.close(); }
});

test('auth-blocked collector state is reported without discarding coverage or granting continuation', t => {
  const { config, file, result, invoke } = fixture(t);
  result('agent', 'collector', 'app-begin', '--file',
    file('begin', { runId: 'blocked-run', dryRun: true, provenance: 'synthetic' }));
  const seed = config.sources.workiq.seeds[0];
  const page = `/teams/${encodeURIComponent(seed.teamId)}/channels/${encodeURIComponent(seed.channelId)}/messages?$select=id,createdDateTime,lastModifiedDateTime,webUrl&$top=50`;
  const call = (id, path, data) => ({
    id, observedAt: '2026-10-09T09:00:00Z', tool: 'workiq-fetch',
    request: { entityUrls: [path] }, response: { results: [{ statusCode: 200, data }] }
  });
  const captured = {
    eventId: 'captured-page', pass: 'workiq:created', calls: [
      call('identity', '/me?$select=id,userPrincipalName',
        { id: config.identity.objectId, userPrincipalName: config.identity.designatedUser }),
      call('page', page, { value: [{
        id: 'retained-root', createdDateTime: '2026-10-08T09:00:00Z',
        lastModifiedDateTime: '2026-10-08T09:00:00Z',
        webUrl: 'https://teams.microsoft.com/l/message/fixture'
      }] })
    ]
  };
  const imported = result('agent', 'collector', 'app-append', '--run', 'blocked-run',
    '--file', file('captured', captured));
  const prior = imported.result.collection.find(row => row.pass === 'workiq:created');
  assert.equal(prior.evidenceCount, 1);
  const failed = file('auth-failure', {
    eventId: 'auth-block', pass: 'workiq:created', call: {
      id: 'identity-failure', observedAt: '2026-10-09T09:00:00Z', tool: 'workiq-fetch',
      request: { entityUrls: ['/me?$select=id,userPrincipalName'] },
      failure: { code: 'blocked-auth', statusCode: 401 }
    }
  });
  const blocked = result('agent', 'collector', 'app-block', '--run', 'blocked-run', '--file', failed);
  const pass = blocked.result.collection.find(row => row.pass === 'workiq:created');
  assert.equal(pass.state, 'blocked-auth');
  assert.equal(pass.evidenceCount, 1);
  assert.deepEqual(pass.evidenceIds, prior.evidenceIds);
  assert.equal(pass.partialEvidenceRetained, true);
  assert.equal(pass.nextRequest, null);
  assert.equal(pass.cursor, null);
  assert.equal(blocked.acceptance, 'not-inferred');
  const continued = result('agent', 'collector', 'app-status', '--run', 'blocked-run');
  assert.deepEqual(continued.result.collection, blocked.result.collection);
  const unauthorizedResume = invoke('agent', 'collector', 'app-append', '--run', 'blocked-run',
    '--file', file('unauthorized-resume', { ...captured, eventId: 'new-unapproved-event' }));
  assert.equal(unauthorizedResume.status, 1);
  assert.match(JSON.parse(unauthorizedResume.stderr).error.message, /terminal|blocked/i);
  assert.equal(existsSync(join(config.stateDirectory, 'app-native', 'live', 'ledger.sqlite')), false);
});
