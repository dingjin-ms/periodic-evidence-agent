import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { Ledger } from '../src/ledger.js';
import { hash } from '../src/common.js';
import {
  remoteValidationContract, runAgencyRemoteValidation, verifyRemoteValidation,
  reconcileAgencyRemoteValidation
} from '../src/agency-remote-validation.js';
import { agencyArtifactTransportPath, createAgencyValidationTransport } from '../src/agency-validation-transport.js';

const candidate = 'a'.repeat(40), pipelineRevision = 'b'.repeat(40);
const stageNames = ['fingerprint', 'authentication-check', 'authentication', 'dependencies', 'compile', 'policy', 'test'];
function fixture(t, failed = false) {
  const started = Date.now(), date = ms => new Date(started + ms).toISOString();
  const directory = mkdtempSync(join(tmpdir(), 'remote-validation-'));
  let ledger;
  t.after(() => {
    ledger?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const workspace = join(directory, 'source');
  mkdirSync(workspace);
  writeFileSync(join(workspace, 'package.json'), '{}\n');
  const profile = join(directory, 'profile.ps1');
  writeFileSync(profile, 'exit 0\n');
  const contract = {
    schema: 'agency-oa-validation-contract-v1', repoId: 'fixture', candidate,
    gateId: 'integration', profileSha256: hash(readFileSync(profile)),
    pipeline: { revision: pipelineRevision, yamlSha256: hash('qualified pipeline\n'),
      definitionId: 10, definitionRevision: 2, ref: 'refs/heads/qualified-validation',
      yamlPath: '/pipeline.yml', organization: 'https://dev.azure.com/example',
      project: 'Fixture', repositoryId: 'fixture', artifactPrefix: 'Fixture-' },
    requiredTasks: ['prepare', 'validate', 'seal'], prepareTask: 'prepare', validationTask: 'validate',
    testPopulation: { suites: 1, tests: 3, path: 'tests/integration/fixture.test.ts' },
    sourceInputs: ['package.json'], executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    profilePath: 'F:\\1\\a\\validation-profile.ps1',
    maximumRunnerMinutes: 60, maximumArtifactBytes: 2 * 1024 ** 3,
    queueMinutes: 15, cancellationMinutes: 5, pollSeconds: 1
  };
  contract.request = {
    prompt: 'Read-only availability check; trusted pipeline runs validation.',
    compute: { $type: 'pipeline', pipelineId: 10, pipelineRefOverride: contract.pipeline.ref },
    context: { repository: { $type: 'ado', organization: 'example', project: 'Fixture' } },
    additionalOptions: { pluginOptions: { includeDefaults: false } },
    metadata: { candidate, pipelineCommit: pipelineRevision, profileSha256: contract.profileSha256,
      pipelineYamlSha256: contract.pipeline.yamlSha256, productPullRequests: 'forbidden' }
  };
  const contractPath = join(directory, 'contract.json');
  writeFileSync(contractPath, JSON.stringify(contract));
  const repo = {
    id: 'fixture', owner: 'fixture-owner',
    remoteValidation: { type: 'agency-remote', contractPath, contractSha256: hash(readFileSync(contractPath)) },
    validationGates: [{ id: 'integration', approved: true, profilePath: profile, profileSha256: contract.profileSha256 }]
  };
  ledger = new Ledger(join(directory, 'ledger'));
  const config = { activation: { dispatch: true }, statePolicy: { accessApproved: true },
    limits: { maxRemoteValidationJobs: 1 },
    stateDirectory: join(directory, 'state') };
  const observation = {
    job: { jobId: 'job-one', state: failed ? 'Failed' : 'Completed', result: failed ? 'Failure' : 'Success',
      pipelineRun: { runId: 100, definitionId: 10 } },
    build: { id: 100, status: 'completed', result: failed ? 'failed' : 'succeeded',
      sourceVersion: pipelineRevision, sourceBranch: contract.pipeline.ref, definitionId: 10,
      definitionRevision: 2, startTime: date(0), finishTime: date(60000) },
    timeline: ['prepare', 'validate', 'seal'].map((name, i) =>
      ({ id: name, type: 'Task', name, state: 'completed', result: failed && name === 'validate' ? 'failed' : 'succeeded', logId: i + 1 })),
    pipelineYaml: 'qualified pipeline\n', artifacts: [{ id: 1, name: 'Fixture-100' }]
  };
  function artifacts(destination) {
    const root = join(destination, 'job-artifact', 'validation-probe');
    mkdirSync(root, { recursive: true });
    const records = [];
    const put = (name, value) => {
      const bytes = typeof value === 'string' ? value : JSON.stringify(value);
      writeFileSync(join(root, name), bytes);
      records.push({ name, bytes: Buffer.byteLength(bytes), sha256: hash(bytes) });
      return hash(bytes);
    };
    const cwd = 'F:\\1\\s';
    const prepared = { schema: 'agency-real-validation-probe-v1', candidate, buildId: '100', definitionId: '10', cwd, agentOs: 'Windows_NT',
      profileSha256: contract.profileSha256, localReceiptsImported: false,
      initialNodeModulesPresent: false, productWritesAuthorized: false,
      inputs: { 'package.json': hash(readFileSync(join(workspace, 'package.json'))) } };
    const preparedHash = put('prepared.json', prepared);
    put('validation-profile.ps1', readFileSync(profile, 'utf8'));
    const stageRecords = stageNames.map((stage, i) => {
      const output = stage === 'test'
        ? 'PASS tests/integration/fixture.test.ts\nTest Suites: 1 passed, 1 total\nTests: 3 passed, 3 total\n'
        : `Executed ${stage}\n`;
      const logSha256 = put(`${stage}.log`, output);
      return { stage, executable: contract.executable,
        arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', contract.profilePath],
        cwd, candidate, startedAt: date(i * 1000), finishedAt: date(i * 1000 + 500),
        exitCode: failed && stage === 'test' ? 1 : 0, log: `${stage}.log`, logSha256 };
    });
    const result = {
      schema: 'agency-real-validation-probe-v1', controllerAcceptance: false,
      candidate, buildId: '100', cwd, profileSha256: contract.profileSha256,
      startedAt: date(0), gatesPassed: !failed,
      state: failed ? 'blocked' : 'passed-probe-awaiting-independent-inspection',
      failedStage: failed ? 'test' : null, sourceCleanAfter: !failed,
      authentication: { state: 'ready', tokenRecorded: false, provider: 'artifacts-npm-credprovider',
        providerVersion: '1.2.1' }, stages: stageRecords
    };
    put('result.json', result);
    put('artifacts.json', records);
    observation.logs = [
      { taskId: 'prepare', logId: 1, lines: [
        `PROBE_PREPARED candidate=${candidate} build=100 cwd=${cwd} profile=${contract.profileSha256} preparedSha256=${preparedHash}`] },
      { taskId: 'validate', logId: 2, lines: [
        ...stageRecords.map(s => `PROBE_STAGE_END stage=${s.stage} exit=${s.exitCode} logSha256=${s.logSha256}`),
        `PROBE_RESULT state=${result.state} gatesPassed=${failed ? 'False' : 'True'} candidate=${candidate}`] }
    ];
    return root;
  }
  const calls = [];
  const transport = async (operation, input, destination) => {
    calls.push(operation);
    if (operation === 'preflight') return { preflightPassed: true };
    if (operation === 'submit') return { jobId: 'job-one' };
    assert.equal(input.jobId, 'job-one');
    if (operation === 'download') artifacts(destination);
    return observation;
  };
  return { directory, workspace, config, ledger, repo, contract, observation, artifacts, calls,
    job: { id: 'validation-only:fixture', workspace }, transport };
}

function httpFixture(t) {
  const f = fixture(t), scopes = [], requests = [];
  const identity = { tenantId: '11111111-1111-1111-1111-111111111111',
    objectId: '22222222-2222-2222-2222-222222222222' };
  f.config.identity = { ...identity };
  const credential = { getToken: async scope => {
    scopes.push(scope);
    const claims = Buffer.from(JSON.stringify({ tid: identity.tenantId, oid: identity.objectId })).toString('base64url');
    return { token: `fixture.${claims}.fixture`, expiresOnTimestamp: Date.now() + 3600000 };
  } };
  const fetch = async (url, options) => {
    requests.push({ url, ...options });
    let value;
    if (url.includes('/items?')) value = { commitId: pipelineRevision, content: 'qualified pipeline\n' };
    else if (url.endsWith('/v2/jobs/validate')) return new Response(null, { status: 204 });
    else if (url.endsWith('/v2/jobs')) value = { jobId: 'job-one' };
    else if (url.endsWith('/jobs/job-one')) value = f.observation.job;
    else if (url.includes('/builds/100?')) value = { ...f.observation.build, definition: { id: 10, revision: 2 } };
    else assert.fail(`Unexpected synthetic endpoint: ${url}`);
    return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
  };
  const save = (path, value) => writeFileSync(path, JSON.stringify(value), { flag: 'wx' });
  return { ...f, scopes, requests, dependencies: { credential, fetch, save },
    client: createAgencyValidationTransport(f.config, { credential, fetch, save }) };
}

async function unresolvedFixture(t) {
  const f = fixture(t);
  f.config.repositories = [f.repo];
  await assert.rejects(runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate, {}, {
    transport: async (operation, input, directory) => {
      const result = await f.transport(operation, input, directory);
      if (operation === 'submit') throw new Error('Disconnected before recording creation identity');
      return result;
    }
  }), /submission uncertain/i);
  const operation = f.ledger.db.prepare("SELECT * FROM operations WHERE kind='agency-remote-validation'").get();
  const detail = JSON.parse(operation.detail);
  f.observation.job.metadata = JSON.parse(readFileSync(join(detail.directory, 'request.json'))).metadata;
  f.observation.job.createdAt = detail.reservedAt;
  return { ...f, operation, detail, recovery: {
    schema: 'controller-remote-validation-reconciliation-v1',
    operationId: operation.id, repoId: f.repo.id, revision: candidate,
    jobId: 'job-one', requestSha256: detail.requestSha256
  } };
}

test('HTTP identity reconciliation fetches only the named job, without build reads or writes', async t => {
  const f = httpFixture(t);
  f.observation.job.metadata = { candidate };
  f.observation.job.createdAt = new Date().toISOString();
  const result = await f.client('reconcile', { contract: f.contract, jobId: 'job-one' }, f.directory);
  assert.deepEqual(result.job, f.observation.job);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, 'GET');
  assert.ok(f.requests[0].url.endsWith('/jobs/job-one'));
});

test('Unknown validation identity is independently reconciled, then normal resume verifies gates without another submit', async t => {
  const f = await unresolvedFixture(t);
  f.config.activation.dispatch = false;
  const result = await reconcileAgencyRemoteValidation(f.config, f.ledger, f.recovery, { transport: f.transport });
  assert.equal(result.state, 'identity-verified');
  assert.equal(result.validationPerformed, false);
  assert.equal(result.newJobSubmitted, false);
  assert.equal(existsSync(join(f.detail.directory, 'created.json')), false);
  const accepted = f.ledger.db.prepare('SELECT * FROM operations WHERE id=?').get(f.operation.id);
  const detail = JSON.parse(accepted.detail);
  assert.equal(accepted.state, 'accepted');
  assert.equal(detail.jobId, 'job-one');
  assert.equal(detail.deadline, f.detail.deadline);
  assert.equal(detail.reservedAt, f.detail.reservedAt);
  assert.equal(hash(readFileSync(detail.reconciliationArtifact)), detail.reconciliationArtifactSha256);
  assert.deepEqual(f.calls, ['preflight', 'submit', 'reconcile']);
  await assert.rejects(reconcileAgencyRemoteValidation(f.config, f.ledger, f.recovery,
    { transport: async () => assert.fail('Already bound identity must use normal resume') }), /unresolved/);
  f.config.activation.dispatch = true;
  const validation = await runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate,
    { resume: true }, { transport: f.transport });
  assert.equal(validation[0].status, 'passed');
  assert.deepEqual(f.calls, ['preflight', 'submit', 'reconcile', 'inspect', 'download']);
});

for (const mutation of ['request-hash', 'reserved-wire', 'metadata', 'creation-time', 'job-id',
  'pipeline', 'created-file', 'state-permission', 'operation-kind', 'terminal-operation']) {
  test(`Identity recovery rejects changed ${mutation} without binding or resubmission`, async t => {
    const f = await unresolvedFixture(t);
    if (mutation === 'request-hash') f.recovery.requestSha256 = 'c'.repeat(64);
    if (mutation === 'reserved-wire')
      writeFileSync(join(f.detail.directory, 'request.json'), '{}');
    if (mutation === 'metadata') f.observation.job.metadata.controllerContractSha256 = 'c'.repeat(64);
    if (mutation === 'creation-time') f.observation.job.createdAt = '2020-01-01T00:00:00Z';
    if (mutation === 'job-id') f.observation.job.jobId = 'different-job';
    if (mutation === 'pipeline') f.observation.job.pipelineRun.definitionId++;
    if (mutation === 'created-file')
      writeFileSync(join(f.detail.directory, 'created.json'), JSON.stringify({ jobId: 'another-job' }));
    if (mutation === 'state-permission') f.config.statePolicy.accessApproved = false;
    if (mutation === 'operation-kind')
      f.ledger.db.prepare("UPDATE operations SET kind='agency-workspace-loop' WHERE id=?").run(f.operation.id);
    if (mutation === 'terminal-operation')
      f.ledger.db.prepare("UPDATE operations SET state='passed' WHERE id=?").run(f.operation.id);
    const before = f.ledger.db.prepare('SELECT * FROM operations WHERE id=?').get(f.operation.id);
    await assert.rejects(reconcileAgencyRemoteValidation(f.config, f.ledger, f.recovery,
      { transport: f.transport }), error => error.code === 'blocked-reconciliation');
    assert.deepEqual(f.ledger.db.prepare('SELECT * FROM operations WHERE id=?').get(f.operation.id), before);
    assert.equal(existsSync(join(f.detail.directory, 'reconciled.json')), false);
    assert.equal(f.calls.filter(call => call === 'submit').length, 1);
    assert.equal(f.ledger.status().locks.length, 0);
  });
}

test('Failed read-only identity lookup preserves the unresolved reservation and redacts transport diagnostics', async t => {
  const f = await unresolvedFixture(t);
  await assert.rejects(reconcileAgencyRemoteValidation(f.config, f.ledger, f.recovery, {
    transport: async operation => {
      assert.equal(operation, 'reconcile');
      throw new Error('sensitive-transport-diagnostic');
    }
  }), error => /Read-only job lookup failed/.test(error.message) &&
    !error.message.includes('sensitive-transport-diagnostic'));
  assert.equal(f.ledger.db.prepare('SELECT detail FROM operations WHERE id=?').get(f.operation.id).detail,
    f.operation.detail);
  assert.equal(existsSync(join(f.detail.directory, 'reconciled.json')), false);
});

test('Identity evidence survives interrupted ledger persistence and recovery retries only the GET', async t => {
  const f = await unresolvedFixture(t);
  const finish = f.ledger.finishOperation.bind(f.ledger);
  f.ledger.finishOperation = () => { throw new Error('sensitive-storage-diagnostic'); };
  await assert.rejects(reconcileAgencyRemoteValidation(f.config, f.ledger, f.recovery,
    { transport: f.transport }), error => /could not be durably reconciled/.test(error.message) &&
      !error.message.includes('sensitive-storage-diagnostic'));
  const artifact = join(f.detail.directory, 'reconciled.json');
  const original = readFileSync(artifact, 'utf8');
  assert.equal(f.ledger.db.prepare('SELECT detail FROM operations WHERE id=?').get(f.operation.id).detail,
    f.operation.detail);
  await assert.rejects(runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate,
    { resume: true }, { transport: f.transport }), /identity is uncertain/);
  f.ledger.finishOperation = finish;
  await reconcileAgencyRemoteValidation(f.config, f.ledger, f.recovery, { transport: f.transport });
  assert.equal(readFileSync(artifact, 'utf8'), original);
  assert.deepEqual(f.calls, ['preflight', 'submit', 'reconcile', 'reconcile']);
});

test('A conflicting saved recovery identity cannot be overwritten after interrupted persistence', async t => {
  const f = await unresolvedFixture(t);
  const finish = f.ledger.finishOperation.bind(f.ledger);
  f.ledger.finishOperation = () => { throw new Error('storage interrupted'); };
  await assert.rejects(reconcileAgencyRemoteValidation(f.config, f.ledger, f.recovery,
    { transport: f.transport }), /could not be durably reconciled/);
  f.ledger.finishOperation = finish;
  const artifact = join(f.detail.directory, 'reconciled.json');
  const changed = JSON.parse(readFileSync(artifact));
  changed.jobId = 'different-job';
  writeFileSync(artifact, JSON.stringify(changed));
  const bytes = readFileSync(artifact, 'utf8');
  await assert.rejects(reconcileAgencyRemoteValidation(f.config, f.ledger, f.recovery,
    { transport: f.transport }), /could not be durably reconciled/);
  assert.equal(readFileSync(artifact, 'utf8'), bytes);
  assert.equal(f.ledger.db.prepare('SELECT detail FROM operations WHERE id=?').get(f.operation.id).detail,
    f.operation.detail);
});

test('HTTP transport caches designated tokens across polls and submits exact reserved wire bytes once', async t => {
  const f = httpFixture(t), input = { contract: f.contract };
  await f.client('preflight', input, f.directory);
  const wire = JSON.stringify(f.contract.request, null, 2) + '\n';
  writeFileSync(join(f.directory, 'request.json'), wire);
  const submission = { ...input, request: f.contract.request, requestSha256: hash(wire) };
  await f.client('submit', submission, f.directory);
  await f.client('inspect', { ...input, jobId: 'job-one' }, f.directory);
  await f.client('inspect', { ...input, jobId: 'job-one' }, f.directory);
  assert.equal(f.scopes.length, 2);
  assert.equal(new Set(f.scopes).size, 2);
  const posts = f.requests.filter(request => request.method === 'POST');
  assert.equal(posts.length, 2);
  assert.ok(posts.every(request => request.body === wire && request.redirect === 'error'));
  for (const phase of ['validate-started', 'validated', 'create-started']) {
    const record = JSON.parse(readFileSync(join(f.directory, `submission-${phase}.json`)));
    assert.equal(record.phase, phase);
    assert.equal(record.requestSha256, hash(wire));
    assert.ok(Number.isFinite(Date.parse(record.observedAt)));
  }
  await assert.rejects(f.client('submit', submission, f.directory), /never resubmit/);
  assert.equal(f.requests.filter(request => request.method === 'POST').length, 2);
});

test('HTTP artifact download does not launch from a Windows-length operation directory', async t => {
  const f = httpFixture(t);
  f.artifacts(f.directory);
  const destination = join(f.directory, 'nested-private-state-'.repeat(10), 'd'.repeat(64));
  assert.ok(destination.length >= 260);
  mkdirSync(destination, { recursive: true });
  let executions = 0;
  const client = createAgencyValidationTransport(f.config, { ...f.dependencies,
    fetch: async (url, options) => {
      let value;
      if (url.includes('/timeline?')) value = { records: f.observation.timeline.map(task =>
        ({ ...task, log: { id: task.logId } })) };
      else if (url.includes('/logs/')) {
        const id = Number(new URL(url).pathname.split('/').at(-1));
        value = f.observation.logs.find(log => log.logId === id).lines;
      } else if (url.includes('/artifacts?')) value = { value: f.observation.artifacts };
      else return f.dependencies.fetch(url, options);
      f.requests.push({ url, ...options });
      return new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
    },
    execute: async (executable, args, cwd, timeout, env) => {
      executions++;
      assert.equal(executable, 'pwsh.exe');
      assert.equal(cwd, dirname(agencyArtifactTransportPath));
      assert.notEqual(cwd, destination);
      assert.deepEqual(args, ['-NoLogo', '-NoProfile', '-NonInteractive', '-File',
        agencyArtifactTransportPath, '-InputFile', join(destination, 'artifact-download-100.json'),
        '-OutputDirectory', destination]);
      assert.ok(timeout > 0 && timeout <= 10 * 60000);
      assert.equal(env, process.env);
      assert.deepEqual(JSON.parse(readFileSync(join(destination, 'artifact-download-100.json'))),
        { contract: f.contract, jobId: 'job-one', buildId: 100 });
      return { stdout: '{"downloaded":true}', stderr: '' };
    } });
  const result = await client('download', { contract: f.contract, jobId: 'job-one' }, destination);
  assert.equal(executions, 1);
  assert.equal(result.build.id, 100);
  assert.deepEqual(result.artifacts, f.observation.artifacts.map(artifact => ({ ...artifact, type: undefined })));
  assert.ok(f.requests.every(request => request.method === 'GET'));
});

for (const [endpoint, phase, markerCount, causeCode] of [
  ['/v2/jobs/validate', 'request-validation', 1, 'UND_ERR_SOCKET'],
  ['/v2/jobs', 'job-creation', 3, 'Bearer fixture-secret']
]) test(`Submission records ${phase} failures without secrets or a replacement job`, async t => {
  const f = httpFixture(t), secret = 'Bearer fixture-secret';
  const client = createAgencyValidationTransport(f.config, { ...f.dependencies,
    fetch: async (url, options) => {
      if (!url.endsWith(endpoint)) return f.dependencies.fetch(url, options);
      f.requests.push({ url, ...options });
      throw new TypeError(secret, { cause: { code: causeCode } });
    } });
  await assert.rejects(runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate,
    {}, { transport: client }), /submission uncertain/i);
  const operation = f.ledger.db.prepare("SELECT state,detail FROM operations WHERE kind='agency-remote-validation'").get();
  const detail = JSON.parse(operation.detail);
  assert.equal(operation.state, 'uncertain');
  assert.ok(detail.error.message.includes(phase));
  assert.ok(!detail.error.message.includes(secret));
  if (causeCode === 'UND_ERR_SOCKET') assert.ok(detail.error.message.includes(causeCode));
  const phases = ['validate-started', 'validated', 'create-started']
    .filter(name => existsSync(join(detail.directory, `submission-${name}.json`)));
  assert.equal(phases.length, markerCount);
  const count = f.requests.length;
  await assert.rejects(runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate,
    { resume: true }, { transport: client }), /identity is uncertain/);
  await assert.rejects(client('submit', { contract: f.contract, requestSha256: detail.requestSha256 },
    detail.directory), /never resubmit/);
  assert.equal(f.requests.length, count);
});

test('A creation-recording failure retains its phase and forbids a second creation POST', async t => {
  const f = httpFixture(t);
  const client = createAgencyValidationTransport(f.config, { ...f.dependencies,
    save: (path, value) => {
      if (path === join(f.directory, 'created.json')) throw new Error('Bearer fixture-secret');
      f.dependencies.save(path, value);
    } });
  const wire = JSON.stringify(f.contract.request, null, 2) + '\n';
  writeFileSync(join(f.directory, 'request.json'), wire);
  const input = { contract: f.contract, requestSha256: hash(wire) };
  await assert.rejects(client('submit', input, f.directory), error =>
    error.message.includes('creation-recording') && !error.message.includes('fixture-secret'));
  await assert.rejects(client('submit', input, f.directory), /never resubmit/);
  assert.equal(f.requests.filter(request => request.url.endsWith('/v2/jobs')).length, 1);
});

test('HTTP transport rejects a different delegated identity before any service request', async t => {
  const f = httpFixture(t);
  f.config.identity.objectId = '33333333-3333-3333-3333-333333333333';
  await assert.rejects(f.client('preflight', { contract: f.contract }, f.directory), /designated tenant\/user/);
  assert.equal(f.requests.length, 0);
});

for (const schema of ['agency-oa-workspace-loop-contract-v1', 'agency-oa-workspace-authoring-contract-v1'])
test(`${schema} preflight binds the agent and its containing plugin manifest before submission`, async t => {
  const f = httpFixture(t), agent = 'Fixture bounded agent.\n', manifest = '{"name":"fixture"}\n';
  const yaml = `    - pwsh: ${JSON.stringify('x'.repeat(32764))}\n`;
  f.contract.schema = schema;
  f.contract.pipeline.yamlSha256 = hash(yaml);
  f.contract.loop = { agentPath: 'plugins/fixture/agents/fixture.md', agentSha256: hash(agent),
    pluginManifestPath: 'plugins/fixture/plugin.json', pluginManifestSha256: hash(manifest) };
  let substitute = false;
  const client = createAgencyValidationTransport(f.config, { ...f.dependencies,
    fetch: async (url, options) => {
      const path = new URL(url).searchParams.get('path');
      assert.ok([f.contract.pipeline.yamlPath, f.contract.loop.agentPath, f.contract.loop.pluginManifestPath].includes(path));
      f.requests.push({ url, ...options });
      const content = path === f.contract.pipeline.yamlPath ? yaml : path === f.contract.loop.agentPath
        ? agent : substitute ? '{"name":"substituted"}' : manifest;
      return new Response(JSON.stringify({ commitId: pipelineRevision, content }),
        { headers: { 'Content-Type': 'application/json' } });
    } });
  assert.deepEqual(await client('preflight', { contract: f.contract }, f.directory), { preflightPassed: true });
  substitute = true;
  await assert.rejects(client('preflight', { contract: f.contract }, f.directory), /plugin manifest/);
  assert.ok(f.requests.every(request => request.method === 'GET'));
});

for (const schema of ['agency-oa-workspace-loop-contract-v1', 'agency-oa-workspace-authoring-contract-v1'])
for (const [name, yaml, error] of [
  ['an oversized Windows inline script', `    - pwsh: ${JSON.stringify('x'.repeat(32767))}\n`,
    /inline PowerShell.*Windows/],
  ['an accidentally split generated string', '    - pwsh: "Write-Host first\n    - pwsh: "injected"\n',
    /valid single-line JSON\/YAML string/]
]) test(`${schema} preflight rejects ${name} before reserving a job`, async t => {
  const f = httpFixture(t);
  f.contract.schema = schema;
  f.contract.pipeline.yamlSha256 = hash(yaml);
  const client = createAgencyValidationTransport(f.config, { ...f.dependencies,
    fetch: async (url, options) => {
      f.requests.push({ url, ...options });
      return new Response(JSON.stringify({ commitId: pipelineRevision, content: yaml }),
        { headers: { 'Content-Type': 'application/json' } });
    } });
  await assert.rejects(client('preflight', { contract: f.contract }, f.directory), error);
  assert.equal(f.requests.length, 1);
  assert.equal(f.requests[0].method, 'GET');
});

test('HTTP transport refuses cancellation of a build outside the reserved pipeline source', async t => {
  const f = httpFixture(t);
  f.observation.build.sourceVersion = 'c'.repeat(40);
  await assert.rejects(f.client('cancel', { contract: f.contract, jobId: 'job-one', buildId: 100 }, f.directory),
    /outside the reserved pipeline/);
  assert.equal(f.requests.filter(request => request.method !== 'GET').length, 0);
});

test('HTTP transport rejects oversized metadata without submitting a job', async t => {
  const f = httpFixture(t);
  const client = createAgencyValidationTransport(f.config, { ...f.dependencies,
    fetch: async () => new Response('x'.repeat(4 * 1024 * 1024 + 1)) });
  await assert.rejects(client('preflight', { contract: f.contract }, f.directory), /metadata exceeds/);
});

test('Remote validation independently accepts fresh source, real stages and exact test population', async t => {
  const f = fixture(t);
  const results = await runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate, {}, { transport: f.transport });
  assert.equal(results[0].status, 'passed');
  const receipt = JSON.parse(readFileSync(results[0].artifactRefs[0]));
  assert.equal(receipt.controllerAcceptance, true);
  assert.equal(receipt.executionLocation, 'agency-remote');
  assert.equal(receipt.inventory.length, 11);
  assert.equal(receipt.stages.length, 7);
  assert.deepEqual(f.calls, ['preflight', 'submit', 'inspect', 'download']);
});

test('Candidate or profile mismatch is rejected before any remote submission', t => {
  const f = fixture(t);
  assert.throws(() => remoteValidationContract(f.repo, 'c'.repeat(40)), /candidate\/profile/);
  writeFileSync(f.repo.validationGates[0].profilePath, 'weakened gate');
  assert.throws(() => remoteValidationContract(f.repo, candidate), /candidate\/profile/);
  assert.deepEqual(f.calls, []);
});

test('Unconfirmed preflight consumes no job reservation or submission budget', async t => {
  const f = fixture(t), calls = [];
  await assert.rejects(runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate, {}, {
    transport: async operation => { calls.push(operation); return { preflightPassed: false }; }
  }), /no job reserved/);
  assert.deepEqual(calls, ['preflight']);
  assert.equal(f.ledger.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE kind='agency-remote-validation'").get().n, 0);
});

test('Persisted creation response recovers a disconnected submit without a replacement job', async t => {
  const f = fixture(t);
  const transport = async (operation, input, directory) => {
    const result = await f.transport(operation, input, directory);
    if (operation === 'submit') {
      writeFileSync(join(directory, 'created.json'), JSON.stringify(result));
      throw new Error('Disconnected after durable creation response');
    }
    return result;
  };
  await assert.rejects(runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate, {}, { transport }), /uncertain/);
  const results = await runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate,
    { resume: true }, { transport });
  assert.equal(results[0].status, 'passed');
  assert.equal(f.calls.filter(operation => operation === 'submit').length, 1);
});

test('Deadline reserves one cancellation and never turns a cancelled real failure green', async t => {
  const f = fixture(t, true);
  let clock = Date.now(), inspected = false, cancellations = 0;
  const transport = async (operation, input, directory) => {
    if (operation === 'cancel') { cancellations++; return { cancellationRequested: true }; }
    const result = await f.transport(operation, input, directory);
    if (operation === 'inspect' && !inspected) {
      inspected = true;
      clock += 76 * 60000;
      return { job: { ...result.job, state: 'Running' }, build: { ...result.build, status: 'inProgress' } };
    }
    if (inspected && ['inspect', 'download'].includes(operation)) {
      return { ...result, job: { ...result.job, state: 'Cancelled', result: 'Cancelled' },
        build: { ...result.build, result: 'canceled' } };
    }
    return result;
  };
  const results = await runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate, {},
    { transport, clock: () => clock, sleep: async () => {} });
  assert.equal(results[0].status, 'failed');
  assert.equal(cancellations, 1);
  assert.equal(f.calls.filter(operation => operation === 'submit').length, 1);
  assert.equal(JSON.parse(readFileSync(results[0].artifactRefs[0])).controllerAcceptance, false);
});

test('Green Agency status cannot replace the actual terminal build', async t => {
  const f = fixture(t);
  f.artifacts(f.directory);
  f.observation.build.status = 'inProgress';
  await assert.rejects(verifyRemoteValidation(f.contract, f.directory, f.observation, 'job-one', f.workspace), /Actual build/);
});

test('Explicit artifact byte budget rejects oversized evidence without partial acceptance', async t => {
  const f = fixture(t);
  f.artifacts(f.directory);
  f.contract.maximumArtifactBytes = 1;
  await assert.rejects(verifyRemoteValidation(f.contract, f.directory, f.observation, 'job-one', f.workspace),
    /inventory exceeds policy/);
});

for (const mutation of ['source', 'pipeline', 'producer', 'profile', 'log', 'population']) {
  test(`Remote acceptance rejects changed ${mutation} evidence`, async t => {
    const f = fixture(t), root = f.artifacts(f.directory);
    if (mutation === 'source') writeFileSync(join(f.workspace, 'package.json'), '{"changed":true}');
    if (mutation === 'pipeline') f.observation.build.sourceVersion = 'c'.repeat(40);
    if (mutation === 'producer') f.observation.logs[1].taskId = 'model-task';
    if (mutation === 'profile') writeFileSync(join(root, 'validation-profile.ps1'), 'exit 0; # different');
    if (mutation === 'log') writeFileSync(join(root, 'test.log'), 'tampered');
    if (mutation === 'population') f.contract.testPopulation.tests = 4;
    await assert.rejects(verifyRemoteValidation(f.contract, f.directory, f.observation, 'job-one', f.workspace));
  });
}

test('A failed real test remains failed and cannot silently fall back to local validation', async t => {
  const f = fixture(t, true);
  const results = await runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate, {}, { transport: f.transport });
  assert.equal(results[0].status, 'failed');
  assert.equal(JSON.parse(readFileSync(results[0].artifactRefs[0])).controllerAcceptance, false);
  assert.deepEqual(f.calls, ['preflight', 'submit', 'inspect', 'download']);
});

test('Uncertain submission never permits a second POST, including resume without a known ID', async t => {
  const f = fixture(t);
  let submissions = 0;
  const transport = async operation => {
    if (operation === 'preflight') return { preflightPassed: true };
    submissions++;
    throw new Error('connection lost');
  };
  await assert.rejects(runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate, {}, { transport }), /uncertain/);
  await assert.rejects(runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate, {}, { transport }), /already reserved/);
  await assert.rejects(runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate, { resume: true }, { transport }), /identity is uncertain/);
  assert.equal(submissions, 1);
});

test('Accepted job resumes observation after disconnect without repeating authoring or submission', async t => {
  const f = fixture(t);
  const transport = async (operation, input, directory) => {
    if (operation === 'inspect') throw new Error('observation interrupted');
    return f.transport(operation, input, directory);
  };
  await assert.rejects(runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate, {}, { transport }), /inspection failed/);
  const result = await runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate, { resume: true }, { transport: f.transport });
  assert.equal(result[0].status, 'passed');
  assert.equal(f.calls.filter(call => call === 'submit').length, 1);
});

test('Controller waits after early Agency success until the actual build terminates', async t => {
  const f = fixture(t);
  let inspections = 0, waits = 0;
  const transport = async (operation, input, directory) => {
    if (operation === 'inspect' && inspections++ === 0)
      return { ...f.observation, build: { ...f.observation.build, status: 'inProgress', startTime: new Date().toISOString() } };
    return f.transport(operation, input, directory);
  };
  const result = await runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate, {},
    { transport, sleep: async () => { waits++; } });
  assert.equal(result[0].status, 'passed');
  assert.equal(waits, 1);
});

test('Completed resume rechecks the downloaded artifact inventory without a new job', async t => {
  const f = fixture(t);
  const result = await runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate, {}, { transport: f.transport });
  const receipt = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  const directory = f.ledger.db.prepare("SELECT detail FROM operations WHERE kind='agency-remote-validation'").get();
  writeFileSync(join(JSON.parse(directory.detail).directory, 'job-artifact', 'validation-probe', 'test.log'), 'changed');
  assert.equal(receipt.controllerAcceptance, true);
  await assert.rejects(runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate,
    { resume: true }, { transport: f.transport }), /receipt changed/);
  assert.equal(f.calls.filter(call => call === 'submit').length, 1);
});

test('New-job budget survives distinct invocation identities', async t => {
  const f = fixture(t);
  await runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo, candidate, {}, { transport: f.transport });
  await assert.rejects(runAgencyRemoteValidation(f.config, f.ledger, { ...f.job, id: 'another-invocation' },
    f.repo, candidate, {}, { transport: f.transport }), /budget exhausted/);
  assert.equal(f.calls.filter(call => call === 'submit').length, 1);
});

for (const limit of [undefined, null]) {
  test(`Remote validation has no cumulative job ceiling when the limit is ${limit}`, async t => {
    const f = fixture(t);
    if (limit === undefined) delete f.config.limits.maxRemoteValidationJobs;
    else f.config.limits.maxRemoteValidationJobs = limit;
    const kinds = ['agency-remote-validation', 'agency-workspace-loop', 'agency-workspace-authoring'];
    for (let index = 0; index < 11; index++)
      f.ledger.operation(`prior-${index}`, 'prior-assignment', kinds[index % kinds.length], {});
    const result = await runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo,
      candidate, {}, { transport: f.transport });
    assert.equal(result[0].status, 'passed');
    assert.equal(f.ledger.status().operations.length, 12);
    await assert.rejects(runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo,
      candidate, {}, { transport: f.transport }), /already reserved/);
    assert.deepEqual(await runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo,
      candidate, { resume: true }, { transport: f.transport }), result);
    assert.equal(f.calls.filter(call => call === 'submit').length, 1);
  });
}

test('An explicitly configured job ceiling above ten remains opt-in and enforced', async t => {
  const f = fixture(t);
  f.config.limits.maxRemoteValidationJobs = 11;
  for (let index = 0; index < 10; index++)
    f.ledger.operation(`prior-${index}`, 'prior-assignment', 'agency-remote-validation', {});
  const result = await runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo,
    candidate, {}, { transport: f.transport });
  assert.equal(result[0].status, 'passed');
  await assert.rejects(runAgencyRemoteValidation(f.config, f.ledger,
    { ...f.job, id: 'over-explicit-limit' }, f.repo, candidate, {}, { transport: f.transport }), /budget exhausted/);
  assert.equal(f.calls.filter(call => call === 'submit').length, 1);
});

test('Invalid optional job ceilings are rejected before remote preflight', async t => {
  const f = fixture(t);
  for (const limit of [0, -1, 1.5, '10', false, Number.MAX_SAFE_INTEGER + 1]) {
    f.config.limits.maxRemoteValidationJobs = limit;
    await assert.rejects(runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo,
      candidate, {}, { transport: f.transport }), /positive safe integer, null or omitted/);
  }
  assert.deepEqual(f.calls, []);
  assert.equal(f.ledger.status().operations.length, 0);
});

test('No cumulative ceiling does not grant dispatch or state-storage permission', async t => {
  const f = fixture(t);
  delete f.config.limits.maxRemoteValidationJobs;
  f.config.activation.dispatch = false;
  await assert.rejects(runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo,
    candidate, {}, { transport: f.transport }), /dispatch activation/);
  f.config.activation.dispatch = true;
  f.config.statePolicy.accessApproved = false;
  await assert.rejects(runAgencyRemoteValidation(f.config, f.ledger, f.job, f.repo,
    candidate, {}, { transport: f.transport }), /approved state storage/);
  assert.deepEqual(f.calls, []);
});
