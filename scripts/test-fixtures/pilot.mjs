import test from 'node:test';
import { loadAuthoringFeedback } from '../../src/workers.js';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, renameSync, rmSync,
  realpathSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { CopilotClient } from '@github/copilot-sdk';
import { probeWorkiq } from '../../scripts/Workiq-Auth-Repro.mjs';
import { Ledger } from '../../src/ledger.js';
import { configAt, hash, json, now, exclusions, PilotError, Budget, boundedPath, validateRecord, workspaceCleanupPolicy, proposerExecutorFlight, validationLfsPaths } from '../../src/common.js';
import { collectAdo, collectWorkiq, collectIcm, evidenceEnvelope, workiqTitle, area, wiql, adoRecord } from '../../src/sources.js';
import { dryRun } from '../../src/dry-run.js';
import { followRelated, readRelatedWorkiq } from '../../src/followup.js';
import { revisitTracked } from '../../src/revisit.js';
import { collect, acceptReview, report, latestEvidence, reconcile, tick, previousUtcDay, nextDailyWake, readinessFingerprint } from '../../src/coordinator.js';
import { validateSeed, restrictedSession, authoringSession, principalPath, unwrapWorkiq, verifyPrincipal, channelRoot, messageSelect, nextWorkiqPage, validateWorkiqPath, workiqRuntimeError, prepareWorkiq } from '../../src/runtime.js';
import { makeAssignment, makePlannedImprovementAssignment, WorkerTools, provision, checkoutEnvironment, hydrateValidationLfs, prepareValidation, preflightValidationAuthentication, runValidation, pushDraftBranch, newCaseBuildSelection, newCaseBuildGroups, queueAdoDraftBuild, createAdoDraft, command, minimalEnvironment, dispatch, repoFor, requireAllowedSkillChanges, verifyPreparedOutputs, verifyTestOnlyProfileChange, rebindPreparedTestProfile } from '../../src/workers.js';
import { recordAreaToImprove, recordTestCoveragePlan } from '../../src/improvements.js';
import { repositoryValidationContract, skillQualificationId } from '../../src/repository-skills.js';
import { outputPathFingerprint } from '../../src/output-fingerprint.js';
import { cleanupWorkspace, cleanupWorkspaces } from '../../src/workspace-gc.js';
import { schedulePreparedAssignments } from '../../src/assignment-scheduler.js';
import { bindAlModelExecution } from '../../src/al-workflow.js';
import { alReference } from '../../src/al-adapter.js';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'evidence-pilot-test-'));
  const config = configAt('pilot.example.json');
  config.stateDirectory = join(root, 'state');
  config.statePolicy.accessApproved = true;
  config.activation = { collect: true, review: true, dispatch: false };
  config.identity = { designatedUser: 'synthetic-owner', tenantId: 'synthetic-tenant', objectId: 'synthetic-user' };
  config.limits = { maxItems: 1000, maxCalls: 30, maxWorkers: 1, maxAssignments: 1, workerMinutes: 1, workerMaxToolCalls: 30, maxFileBytes: 262144 };
  config.followUp = { maxDepth: 0, maxItems: 50, maxToolCalls: 100 };
  config.reviewMethod = 'human-review';
  config.sources.ado.scopeApproved = true;
  config.sources.ado.enabled = true;
  config.sources.icm.enabled = false;
  config.sources.workiq.enabled = false;
  config.sources.workiq.seeds = [];
  config.schedule.changedEvidencePolicy = null;
  const ledger = new Ledger(config.stateDirectory);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, config, ledger };
}
function adoItem(id = 1, rev = 1) {
  return { id, rev, fields: {
    'System.Id': id, 'System.WorkItemType': 'Bug', 'System.Title': `Synthetic bug ${id}`,
    'System.AreaPath': `${area}\\Synthetic`, 'System.State': 'Resolved',
    'Microsoft.VSTS.Common.ResolvedReason': 'Fixed',
    'System.CreatedDate': '2026-10-08T01:00:00Z', 'System.ChangedDate': '2026-10-08T02:00:00Z'
  } };
}
function transport(items = [adoItem()], capture = []) {
  return async (endpoint, body) => {
    capture.push({ endpoint, body });
    if (endpoint === 'wiql') return {
      asOf: '2026-10-09T01:00:00Z', workItems: body.query.includes('[System.Id] = 0') ? [] : items.map(({ id }) => ({ id }))
    };
    return { value: items.filter(i => body.ids.includes(i.id)) };
  };
}
function addEvidence(ledger, id = '1', revision = '1', payload = { text: 'synthetic' }, provenance = 'synthetic', overrides = {}) {
  const record = evidenceEnvelope('ado', 'office/OC', id, revision,
    `https://dev.azure.com/office/OC/_workitems/edit/${id}`, 'synthetic query', '2026-10-09T01:00:00Z');
  record.source.provenance = provenance;
  Object.assign(record, overrides);
  return ledger.evidence(record, payload, `run-${revision}-${id}`);
}
function review(evidence, version = 1) {
  return {
    recordType: 'investigation', schemaVersion: '1.0',
    id: `investigation-${hash(json([evidence.source.namespace, evidence.source.recordId]))}`, version,
    evidenceIds: [evidence.id], state: 'triaged', observedBehavior: 'Synthetic failure',
    expectedBehavior: 'Expected behavior', hypotheses: [], counterEvidence: [],
    classification: 'functional', defectConfirmation: 'unconfirmed', reportEligibility: 'included',
    handoffEligibility: 'eligible', exclusionReasons: [], rationale: 'Synthetic review only', confidence: 0.8,
    review: { method: 'human-review', reviewer: 'synthetic-reviewer', reviewedAt: now() },
    repoIds: [], existingFixes: [], nextAction: 'Investigate source cause'
  };
}
function repoConfig(config, root) {
  const repo = {
    id: 'fixture', owner: 'synthetic-owner', routingApproved: true, routingRules: ['synthetic only'],
    referenceCheckout: join(root, 'reference'), baseRef: 'HEAD', remote: join(root, 'remote.git'),
    allowedWritePrefixes: ['src', 'test'], allowedWriteFiles: [],
    validationGates: [], commitIdentity: { name: 'Pilot fixture', email: 'fixture@example.invalid' }
  };
  config.repositories = [repo]; return repo;
}
async function fixture(t, provenance = 'synthetic', intent = 'rca-only') {
  const ctx = setup(t);
  const repo = repoConfig(ctx.config, ctx.root);
  mkdirSync(join(repo.referenceCheckout, 'src'), { recursive: true });
  writeFileSync(join(repo.referenceCheckout, 'src', 'value.js'), 'export const value = 1;\n');
  const g = args => command('git', ['-c', 'core.hooksPath=.git/no-hooks', '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false', ...args], repo.referenceCheckout);
  await g(['init', '--quiet']);
  await g(['add', '.']);
  await g(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Synthetic fixture']);
  const evidence = addEvidence(ctx.ledger, '1', '1', { fixture: true, simulatedProvider: true }, provenance);
  const investigation = review(evidence); investigation.repoIds = [repo.id];
  ctx.ledger.put(investigation);
  if (intent !== 'rca-only') repo.validationGates = [{ id: 'source-test', approved: true, isolationVerified: true,
    executable: process.execPath, args: ['--input-type=module', '-e',
      "import {value} from './src/value.js'; import assert from 'node:assert/strict'; assert.equal(value,2)"], timeoutMs: 10000 }];
  const assignment = makeAssignment(ctx.config, investigation, repo.id, intent);
  const job = ctx.ledger.prepare(assignment);
  return { ...ctx, repo, evidence, investigation, assignment, job, g };
}
async function stagedValidationFixture(t, {
  parallelOutputs = false, authentication = false, provenance = 'synthetic'
} = {}) {
  const ctx = await fixture(t, provenance);
  writeFileSync(join(ctx.repo.referenceCheckout, '.gitignore'),
    '.pilot/\nextra/node_modules/\n');
  writeFileSync(join(ctx.repo.referenceCheckout, 'package.json'), '{"packageManager":"fixture@1.0.0"}\n');
  writeFileSync(join(ctx.repo.referenceCheckout, 'fixture.lock'), 'locked\n');
  writeFileSync(join(ctx.repo.referenceCheckout, 'build.config.js'), 'export default {};\n');
  if (authentication) writeFileSync(
    join(ctx.repo.referenceCheckout, '.yarnrc.yml'), [
      'npmRegistryServer: "https://office.pkgs.visualstudio.com/_packaging/AugmentationLoop/npm/registry/"',
      'npmScopes:',
      '  office:',
      '    npmRegistryServer: "https://office.pkgs.visualstudio.com/_packaging/Office/npm/registry/"'
    ].join('\n'));
  mkdirSync(join(ctx.repo.referenceCheckout, 'src'), { recursive: true });
  writeFileSync(join(ctx.repo.referenceCheckout, 'src', 'value.js'), 'export const value = 1;\n');
  writeFileSync(join(ctx.repo.referenceCheckout, 'src', 'unused.js'), 'export const unused = true;\n');
  mkdirSync(join(ctx.repo.referenceCheckout, 'test'));
  writeFileSync(join(ctx.repo.referenceCheckout, 'test', 'behavior.test.js'), 'pass\n');
  await ctx.g(['add', '.']);
  await ctx.g(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Add staged validation fixture']);
  const isolated = await provision(ctx.config, ctx.job, ctx.repo);
  const current = { ...ctx.job, workspace: isolated.workspace };
  const profilePath = join(ctx.config.stateDirectory, 'staged-profile.mjs');
  const plan = {
    version: authentication ? 3 : 2,
    stages: ['dependencies', 'compile', 'policy', 'test'],
    testOnlyPrefixes: ['test/'],
    lockfilePaths: ['package.json', 'fixture.lock'],
    buildConfigPaths: ['build.config.js'],
    dependencySnapshotPaths: ['.pilot/dependencies', '.pilot/install-state'],
    preparedOutputPaths: parallelOutputs
      ? ['.pilot/install-state', ...Array.from({ length: 8 },
        (_, index) => `.pilot/output-${index}`)]
      : ['.pilot/install-state']
  };
  if (authentication) plan.authentication = {
    type: 'azure-artifacts-npm',
    provider: 'artifacts-npm-credprovider',
    providerVersion: '1.2.1',
    feeds: [
      {
        scope: null,
        registry: 'https://office.pkgs.visualstudio.com/_packaging/AugmentationLoop/npm/registry/'
      },
      {
        scope: 'office',
        registry: 'https://office.pkgs.visualstudio.com/_packaging/Office/npm/registry/'
      }
    ]
  };
  writeFileSync(profilePath, `// PILOT_VALIDATION_PLAN: ${JSON.stringify(plan)}\n`);
  ctx.repo.validationGates = [{
    id: 'staged', approved: true, isolationVerified: true,
    executable: process.execPath, args: ['{profile}'],
    profilePath, profileSha256: hash(readFileSync(profilePath)), timeoutMs: 10000
  }];
  ctx.config.limits.maxValidationInfrastructureRetries = 1;
  const calls = [];
  const behavior = {
    toolchain: '1', failPreparation: false, failTest: false,
    transientPolicy: false, policyAttempts: 0, failAuthentication: false,
    failDependencyAuthentication: false, mutateDuringAuthentication: false,
    invalidAuthenticationEvidence: false, failTestWithAuthenticationText: false,
    authenticationPreflight: 'ready', authenticationCheckDelayMs: 0,
    dependencyVersion: '2.0.0',
    failTestWithProfileError: false
  };
  const execute = async (executable, args, cwd, timeout, env) => {
    const stage = env.PILOT_VALIDATION_STAGE;
    calls.push(stage);
    if (stage === 'fingerprint') return {
      stdout: `PILOT_VALIDATION_FINGERPRINT:${JSON.stringify({
        node: behavior.toolchain, corepack: '1', yarn: '1',
        platform: process.platform, architecture: process.arch
      })}\n`,
      stderr: ''
    };
    if (stage === 'authentication-check') {
      assert.equal(env.PILOT_TEST_SECRET, undefined);
      if (behavior.authenticationCheckDelayMs)
        await new Promise(resolve => setTimeout(
          resolve, behavior.authenticationCheckDelayMs));
      const state = behavior.authenticationPreflight;
      if (state === 'invalid')
        return { stdout: 'authentication check completed without evidence\n', stderr: '' };
      const value = {
        state: state === 'ready' ? 'ready' : 'action-required-auth',
        provider: 'artifacts-npm-credprovider',
        providerVersion: '1.2.1',
        feedCount: 2,
        tokenRecorded: false
      };
      if (state !== 'ready') {
        value.reason = state;
        value.installProvider = state === 'provider-missing';
      }
      return {
        stdout: `PILOT_VALIDATION_AUTH_PREFLIGHT:${JSON.stringify(value)}\n`,
        stderr: ''
      };
    }
    if (stage === 'authentication') {
      assert.equal(env.PILOT_TEST_SECRET, undefined);
      if (behavior.mutateDuringAuthentication)
        writeFileSync(join(cwd, 'src', 'value.js'), 'authentication changed source\n');
      if (behavior.failAuthentication)
        throw Object.assign(new Error('authentication failed'), {
          code: 1, stdout: '',
          stderr: 'No authentication configured for Azure Artifacts'
        });
      return {
        stdout: behavior.invalidAuthenticationEvidence
          ? 'authentication completed without evidence\n'
          : `PILOT_VALIDATION_AUTH:${JSON.stringify({
            provider: 'artifacts-npm-credprovider',
            providerVersion: '1.2.1',
            feedCount: 2,
            tokenRecorded: false
          })}\n`,
        stderr: ''
      };
    }
    if (stage === 'dependencies') {
      if (behavior.failDependencyAuthentication)
        throw Object.assign(new Error('install authentication failed'), {
          code: 1, stdout: '',
          stderr: 'Invalid authentication (as an anonymous user)'
        });
      if (behavior.failPreparation)
        throw Object.assign(new Error('install failed'), {
          code: 1, stdout: '', stderr: 'install failure'
        });
      mkdirSync(join(cwd, '.pilot'), { recursive: true });
      mkdirSync(join(cwd, '.pilot', 'dependencies'), { recursive: true });
      writeFileSync(join(cwd, '.pilot', 'dependencies', 'package.js'), 'dependency\n');
      symlinkSync(join(cwd, 'src'), join(cwd, '.pilot', 'dependencies', 'source-link'),
        process.platform === 'win32' ? 'junction' : 'dir');
      mkdirSync(join(cwd, 'extra', 'node_modules', 'fixture'), { recursive: true });
      writeFileSync(join(cwd, 'extra', 'node_modules', 'fixture', 'package.json'),
        `${JSON.stringify({ version: behavior.dependencyVersion })}\n`);
      writeFileSync(join(cwd, 'extra', 'node_modules', 'fixture', 'resolver.node'),
        'synthetic-native-binary\n');
      symlinkSync(join(cwd, 'src'),
        join(cwd, 'extra', 'node_modules', 'source-link'),
        process.platform === 'win32' ? 'junction' : 'dir');
      writeFileSync(join(cwd, '.pilot', 'install-state'), 'prepared\n');
    }
    if (stage === 'compile') {
      assert.equal(
        readFileSync(join(cwd, '.pilot', 'dependencies', 'source-link', 'value.js'), 'utf8'),
        readFileSync(join(cwd, 'src', 'value.js'), 'utf8'));
      assert.equal(
        readFileSync(join(cwd, 'extra', 'node_modules',
          'source-link', 'value.js'), 'utf8'),
        readFileSync(join(cwd, 'src', 'value.js'), 'utf8'));
      assert.equal(JSON.parse(readFileSync(join(cwd, 'extra', 'node_modules',
        'fixture', 'package.json'))).version, behavior.dependencyVersion);
      if (parallelOutputs) {
        for (let index = 0; index < 8; index++) {
          mkdirSync(join(cwd, '.pilot', `output-${index}`), { recursive: true });
          writeFileSync(join(cwd, '.pilot', `output-${index}`, 'compiled.js'),
            `export const value = ${index};\n`);
        }
      }
    }
    if (stage === 'policy' && behavior.transientPolicy && behavior.policyAttempts++ === 0)
      throw Object.assign(new Error('timeout'), {
        killed: true, code: null, stdout: '', stderr: 'timeout'
      });
    if (stage === 'test' && behavior.failTest)
      throw Object.assign(new Error('test failed'), {
        code: 1, stdout: '', stderr: 'fixture failure'
      });
    if (stage === 'test' && behavior.failTestWithAuthenticationText)
      throw Object.assign(new Error('test failed'), {
        code: 1, stdout: '', stderr: 'expected HTTP 403 in application behavior'
      });
    if (stage === 'test' && behavior.failTestWithProfileError)
      throw Object.assign(new Error('profile failed'), {
        code: 1, stdout: '',
        stderr: 'PILOT_VALIDATION_PROFILE_ERROR: invalid package-relative selector'
      });
    return { stdout: `${stage} passed\n`, stderr: '' };
  };
  const commit = async (path, content, message) => {
    writeFileSync(join(isolated.workspace, path), content);
    const gitArgs = args => command('git', ['-c', 'core.autocrlf=false',
      '-c', 'core.safecrlf=false', ...args], isolated.workspace);
    await gitArgs(['add', '--all']);
    await gitArgs(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '-m', message], isolated.workspace);
    return (await gitArgs(['rev-parse', 'HEAD'])).stdout.trim();
  };
  return { ...ctx, isolated, current, profilePath, calls, behavior, execute, commit };
}

async function deliveredWorkspace(t, { historicalFailure = false } = {}) {
  const ctx = await fixture(t, 'authenticated-source', 'defect-fix');
  const isolated = await provision(ctx.config, ctx.job, ctx.repo);
  ctx.ledger.moveJob(ctx.job.id, 'prepared', 'dispatching');
  ctx.ledger.moveJob(ctx.job.id, 'dispatching', 'running', isolated);
  await command('git', ['init', '--bare', '--quiet', ctx.repo.remote], ctx.root);
  await pushDraftBranch(ctx.config, isolated.workspace, ctx.repo,
    `HEAD:refs/heads/pilot/${ctx.job.id}`);
  const artifact = join(ctx.config.stateDirectory, 'delivery-validation.json');
  const status = historicalFailure ? 'failed' : 'passed';
  writeFileSync(artifact, json({ sourceRevision: isolated.baseRevision, status }));
  const result = structuredClone(JSON.parse(readFileSync('scaffold/example-flows.json'))
    .records.find(record => record.recordType === 'workerResult'));
  Object.assign(result, {
    id: `delivery-${ctx.job.id}`, assignmentId: ctx.job.id, attemptId: ctx.job.session_id,
    reportedAt: now(), outcome: historicalFailure ? 'draft-pr-validation-failed' : 'draft-pr-validated',
    sourceRevision: isolated.baseRevision,
    draftPR: { url: 'https://example.invalid/draft/1', isDraft: true, headRevision: isolated.baseRevision },
    skillExecution: null, blocker: null
  });
  result.validation = [{
    ...result.validation[0], gateId: 'source-test', status,
    sourceRevision: isolated.baseRevision, artifactRefs: [artifact]
  }];
  result.validationAttempts = [{
    round: 0, sourceRevision: isolated.baseRevision, validation: result.validation
  }];
  ctx.ledger.put(result);
  ctx.ledger.moveJob(ctx.job.id, 'running', 'completed');
  return { ...ctx, isolated, result, artifact };
}
function packageToken(t, name = 'PILOT_FIXTURE_TOKEN', token = 'synthetic-package-token:/+=') {
  const previous = process.env[name];
  process.env[name] = token;
  t.after(() => {
    if (previous === undefined) delete process.env[name];
    else process.env[name] = previous;
  });
  return token;
}
async function longPathFixture(workspace) {
  const path = join('src', 'long-native-path-'.repeat(8), 'value.js');
  mkdirSync(dirname(join(workspace, path)), { recursive: true });
  writeFileSync(join(workspace, path), 'export const value = 1;\n');
  await command('git', ['-c', 'core.longpaths=true', '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false', 'add', '--', path], workspace);
  await command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Add long-path fixture'], workspace);
  const revision = (await command('git', ['rev-parse', 'HEAD'], workspace)).stdout.trim();
  return { path, revision };
}
const gitLfsAvailable = spawnSync('git', ['lfs', 'version'], { windowsHide: true }).status === 0;
function useFixtureLfsTransfer(t, ctx) {
  const oid = hash(ctx.content);
  const source = join(ctx.isolated.workspace, '.git', 'lfs', 'objects',
    oid.slice(0, 2), oid.slice(2, 4), oid);
  const requests = join(ctx.root, 'lfs-requests.jsonl');
  const agent = join(ctx.root, 'lfs-transfer.mjs');
  // Keep native fetch/checkout, but avoid the nested Git processes of standalone-file.
  writeFileSync(agent, `
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { appendFileSync, copyFileSync, readFileSync, writeSync } from 'node:fs';
import { createInterface } from 'node:readline';
const input = createInterface({ input: process.stdin });
const send = value => writeSync(1, JSON.stringify(value) + '\\n');
input.on('line', line => {
  const request = JSON.parse(line);
  if (request.event === 'init') {
    assert.equal(request.operation, 'download');
    assert.equal(request.remote, 'pilot-validation-lfs');
    send({});
  } else if (request.event === 'download') {
    assert.equal(request.oid, ${json(oid)});
    assert.equal(request.size, ${ctx.content.length});
    const bytes = readFileSync(${json(source)});
    assert.equal(createHash('sha256').update(bytes).digest('hex'), request.oid);
    assert.equal(bytes.length, request.size);
    appendFileSync(${json(requests)}, JSON.stringify(request) + '\\n');
    const path = ${json(join(ctx.root, 'lfs-download'))};
    copyFileSync(${json(source)}, path);
    send({ event: 'complete', oid: request.oid, path });
  } else if (request.event === 'terminate') {
    process.exit(0);
  } else {
    throw new Error('Unexpected fixture LFS transfer request');
  }
});
`);
  const entries = [
    ['lfs.standalonetransferagent', 'fixture'],
    ['lfs.customtransfer.fixture.path', process.execPath],
    ['lfs.customtransfer.fixture.args', json(agent)],
    ['lfs.customtransfer.fixture.concurrent', 'false']
  ];
  const count = Number(process.env.GIT_CONFIG_COUNT ?? 0);
  assert.ok(Number.isSafeInteger(count) && count >= 0);
  const overrides = [
    ['GIT_CONFIG_COUNT', String(count + entries.length)],
    ...entries.flatMap(([key, value], index) => [
      [`GIT_CONFIG_KEY_${count + index}`, key],
      [`GIT_CONFIG_VALUE_${count + index}`, value]
    ])
  ];
  const previous = overrides.map(([key]) => [key, process.env[key]]);
  t.after(() => {
    for (const [key, value] of previous) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  });
  for (const [key, value] of overrides) process.env[key] = value;
  return requests;
}
async function lfsValidationFixture(t) {
  const ctx = await stagedValidationFixture(t);
  await command('git', ['lfs', 'install', '--local', '--skip-smudge'], ctx.isolated.workspace);
  await command('git', ['config', '--local', 'lfs.storage', 'lfs'], ctx.isolated.workspace);
  mkdirSync(join(ctx.isolated.workspace, 'fixtures'));
  writeFileSync(join(ctx.isolated.workspace, '.gitattributes'),
    'fixtures/*.xlsx filter=lfs diff=lfs merge=lfs -text\n');
  const content = Buffer.from('source-bound native-build fixture\n');
  writeFileSync(join(ctx.isolated.workspace, 'fixtures', 'unrelated.xlsx'), 'unrelated LFS object\n');
  const path = 'fixtures/required template.xlsx';
  const revision = await ctx.commit(path, content, 'Add exact LFS fixtures');
  ctx.repo.remote = ctx.isolated.workspace;
  ctx.repo.validationGates[0].lfsPaths = [path];
  return { ...ctx, path, revision, content };
}

function channelConfig(config) {
  const seed = { id: 'synthetic-channel', kind: 'teams-channel', teamId: 'synthetic-team',
    channelId: 'synthetic-channel', url: 'https://teams.microsoft.com/synthetic', includeReplies: true };
  config.sources.workiq = { enabled: true, scopeApproved: true, seeds: [seed] };
  return seed;
}
function message(id, createdDateTime = '2026-10-08T01:00:00Z') {
  return { id, createdDateTime, lastModifiedDateTime: createdDateTime, etag: '1', body: { content: 'Synthetic' } };
}
function principal(config) {
  return { id: config.identity.objectId, userPrincipalName: config.identity.designatedUser };
}

function workiqLifecycle({ status = 'connected', running = false, afterStart = 'connected', tools = ['fetch'], startError = null } = {}) {
  const calls = [];
  return { calls, session: { rpc: {
    mcp: {
      listConfigured: async () => { calls.push('status'); return { servers: [{ name: 'workiq', enabled: true, live: { status } }] }; },
      isServerRunning: async () => { calls.push('running'); return { running }; },
      startServer: async args => {
        assert.deepEqual(args, { serverName: 'workiq' });
        calls.push('start'); if (startError) throw startError; status = afterStart;
      },
      listTools: async () => { calls.push('tools/list'); return { tools: tools.map(name => ({ name })) }; }
    },
    tools: { initializeAndValidate: async () => { calls.push('initialize'); } }
  } } };
}
export {
  setup,
  adoItem,
  transport,
  addEvidence,
  review,
  repoConfig,
  fixture,
  stagedValidationFixture,
  deliveredWorkspace,
  packageToken,
  longPathFixture,
  gitLfsAvailable,
  useFixtureLfsTransfer,
  lfsValidationFixture,
  channelConfig,
  message,
  principal,
  workiqLifecycle
};
