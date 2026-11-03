import test from 'node:test';
import { loadAuthoringFeedback } from '../src/workers.js';
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
import { probeWorkiq } from '../scripts/Workiq-Auth-Repro.mjs';
import { Ledger } from '../src/ledger.js';
import { configAt, hash, json, now, exclusions, PilotError, Budget, boundedPath, validateRecord, workspaceCleanupPolicy, proposerExecutorFlight, validationLfsPaths } from '../src/common.js';
import { collectAdo, collectWorkiq, collectIcm, evidenceEnvelope, workiqTitle, area, wiql, adoRecord } from '../src/sources.js';
import { dryRun } from '../src/dry-run.js';
import { followRelated, readRelatedWorkiq } from '../src/followup.js';
import { revisitTracked } from '../src/revisit.js';
import { collect, acceptReview, report, latestEvidence, reconcile, tick, previousUtcDay, nextDailyWake, readinessFingerprint } from '../src/coordinator.js';
import { validateSeed, restrictedSession, authoringSession, principalPath, unwrapWorkiq, verifyPrincipal, channelRoot, messageSelect, nextWorkiqPage, validateWorkiqPath, workiqRuntimeError, prepareWorkiq } from '../src/runtime.js';
import { makeAssignment, makePlannedImprovementAssignment, WorkerTools, provision, checkoutEnvironment, hydrateValidationLfs, prepareValidation, preflightValidationAuthentication, runValidation, pushDraftBranch, newCaseBuildSelection, newCaseBuildGroups, queueAdoDraftBuild, createAdoDraft, command, minimalEnvironment, dispatch, repoFor, requireAllowedSkillChanges, verifyPreparedOutputs, verifyTestOnlyProfileChange, rebindPreparedTestProfile } from '../src/workers.js';
import { recordAreaToImprove, recordTestCoveragePlan } from '../src/improvements.js';
import { repositoryValidationContract, skillQualificationId } from '../src/repository-skills.js';
import { outputPathFingerprint } from '../src/output-fingerprint.js';
import { cleanupWorkspace, cleanupWorkspaces } from '../src/workspace-gc.js';
import { schedulePreparedAssignments } from '../src/assignment-scheduler.js';
import { bindAlModelExecution } from '../src/al-workflow.js';
import { alReference } from '../src/al-adapter.js';
import {
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
} from '../scripts/test-fixtures/pilot.mjs';

test('metadata-only ordinary file changes preserve an identical prepared cache', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  const revision = await ctx.commit('test/behavior.test.js', 'repair\n',
    'Exercise ordinary file metadata tolerance');
  const execute = async (...args) => {
    const result = await ctx.execute(...args);
    const [, , cwd, , env] = args;
    if (env.PILOT_VALIDATION_STAGE === 'test') {
      const packageJson = join(cwd, 'extra', 'node_modules', 'fixture',
        'package.json');
      writeFileSync(packageJson, readFileSync(packageJson));
    }
    return result;
  };
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.equal(existsSync(prepared.staged.workspace), true);
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  const cleanup = artifact.telemetry.validationTimings.find(stage =>
    stage.id === 'cleanup');
  assert.equal(cleanup.cache, 'preserved');
  const verification = cleanup.subphases.find(stage =>
    stage.id === 'verify-prepared-outputs');
  assert.ok(verification.details.observedEventCount > 0);
  assert.ok(verification.details.rehashedEntryCount > 0);
  assert.ok(verification.details.hashedFileCount > 0);
  assert.ok(verification.details.durationMs >= 100);
});
test('dependency snapshots retain generated siblings without widening declared roots', async t => {
  const ctx = await stagedValidationFixture(t);
  const execute = async (...args) => {
    const result = await ctx.execute(...args);
    const [, , cwd, , env] = args;
    const generated = join(cwd, '.pilot', 'generated-tools', 'compiler.js');
    if (env.PILOT_VALIDATION_STAGE === 'dependencies') {
      mkdirSync(dirname(generated), { recursive: true });
      writeFileSync(generated, 'generated compiler\n');
    }
    if (env.PILOT_VALIDATION_STAGE === 'compile')
      assert.equal(readFileSync(generated, 'utf8'), 'generated compiler\n');
    return result;
  };
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, execute);
  assert.equal(prepared.staged.error, undefined, JSON.stringify(prepared));
  const dependency = JSON.parse(readFileSync(prepared.staged.dependencyReceipt.path, 'utf8'));
  assert.ok(dependency.outputs.paths.includes('.pilot/dependencies'));
  assert.ok(dependency.outputs.paths.includes('.pilot/generated-tools'));
  assert.ok(dependency.outputs.paths.includes('extra/node_modules'));
  assert.equal(dependency.outputs.paths.includes('.pilot'), false);
  assert.equal(dependency.outputs.paths.includes('extra'), false);
});
test('metadata event batches preserve cache with incremental verification telemetry',
  async t => {
    const ctx = await stagedValidationFixture(t);
    const execute = async (...args) => {
      const result = await ctx.execute(...args);
      const [, , cwd, , env] = args;
      const bulk = join(cwd, 'extra', 'node_modules', 'fixture', 'bulk');
      if (env.PILOT_VALIDATION_STAGE === 'dependencies') {
        mkdirSync(bulk, { recursive: true });
        for (let index = 0; index < 32; index++)
          writeFileSync(join(bulk, `${index}.js`), `export default ${index};\n`);
      }
      if (env.PILOT_VALIDATION_STAGE === 'test') {
        for (let index = 0; index < 32; index++) {
          const path = join(bulk, `${index}.js`);
          writeFileSync(path, readFileSync(path));
        }
      }
      return result;
    };
    const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, execute);
    const revision = await ctx.commit('test/behavior.test.js', 'repair\n',
      'Exercise batched metadata tolerance');
    const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
      revision, execute, rmSync, prepared);
    assert.equal(result[0].status, 'passed',
      readFileSync(result[0].artifactRefs[0], 'utf8'));
    assert.equal(existsSync(prepared.staged.workspace), true);
    const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
    const cleanup = artifact.telemetry.validationTimings.find(stage =>
      stage.id === 'cleanup');
    assert.equal(cleanup.cache, 'preserved');
    const details = cleanup.subphases.find(stage =>
      stage.id === 'verify-prepared-outputs').details;
    assert.ok(details.observedEventCount > 0);
    assert.ok(details.changedEntryCount > 0);
    assert.ok(details.rehashedEntryCount > 0);
    assert.ok(details.hashedFileCount > 0);
});
test('same-revision infrastructure retry reuses expensive prepared stages', async t => {
  const ctx = await stagedValidationFixture(t);
  ctx.behavior.transientPolicy = true;
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.equal(result[0].attemptCount, 2);
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'policy').length, 2);
});
test('concurrent assignments share one controller-owned preparation', async t => {
  const ctx = await stagedValidationFixture(t);
  const [first, second] = await Promise.all([
    prepareValidation(ctx.config, ctx.current, ctx.repo, ctx.isolated.baseRevision, ctx.execute),
    prepareValidation(ctx.config, ctx.current, ctx.repo, ctx.isolated.baseRevision, ctx.execute)
  ]);
  assert.equal(first.staged.receiptPath, second.staged.receiptPath);
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
});
test('profiles without a valid stage plan retain full clean validation fallback', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  const isolated = await provision(config, job, repo);
  const profilePath = join(config.stateDirectory, 'ordinary-profile.mjs');
  writeFileSync(profilePath, '// ordinary profile\n');
  repo.validationGates = [{
    id: 'ordinary', approved: true, isolationVerified: true,
    executable: process.execPath, args: ['{profile}'],
    profilePath, profileSha256: hash(readFileSync(profilePath)), timeoutMs: 10000
  }];
  let runs = 0;
  const result = await runValidation(config, ledger,
    { ...job, workspace: isolated.workspace }, repo, isolated.baseRevision,
    async () => { runs++; return { stdout: '', stderr: '' }; });
  assert.equal(result[0].status, 'passed');
  assert.equal(runs, 1);
});
test('staged preparation failures persist terminal validation evidence', async t => {
  const ctx = await stagedValidationFixture(t);
  ctx.behavior.failPreparation = true;
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, {});
  assert.equal(result[0].status, 'failed');
  assert.equal(result[0].attemptCount, 1);
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.equal(artifact.output.exitCode, 1);
  assert.ok(artifact.telemetry.preparationTimings.some(stage =>
    stage.id === 'dependencies'));
});
for (const failingStage of ['dependencies', 'compile']) {
  test(`prestarted ${failingStage} failure is preserved without an implicit infrastructure retry`, async t => {
    const ctx = await stagedValidationFixture(t);
    ctx.config.limits.maxValidationInfrastructureRetries = 0;
    const calls = [];
    const execute = async (...args) => {
      const stage = args[4].PILOT_VALIDATION_STAGE;
      calls.push(stage);
      if (stage === failingStage)
        throw Object.assign(new Error('original native failure'), {
          code: 17, stderr: 'original native failure', stdout: 'original output'
        });
      return ctx.execute(...args);
    };
    const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, execute);
    assert.equal(prepared.staged.failure.output.exitCode, 17);
    const revision = await ctx.commit('test/behavior.test.js', 'new case\n', 'Add test');
    const before = [...calls];
    const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
      revision, execute, rmSync, JSON.parse(JSON.stringify(prepared)));
    assert.deepEqual(calls, before);
    assert.equal(calls.filter(stage => stage === failingStage).length, 1);
    assert.equal(result[0].status, 'failed');
    assert.equal(result[0].attemptCount, 1);
    assert.equal(result[0].sourceRevision, revision);
    const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
    assert.equal(artifact.output.exitCode, 17);
    assert.equal(artifact.output.stderr, 'original native failure');
    assert.equal(artifact.telemetry.preparedSourceRevision, ctx.isolated.baseRevision);
    assert.equal(artifact.telemetry.validationRevision, revision);
    assert.equal(artifact.telemetry.validationTimings.length, 0);
  });
}
test('LFS paths are exact, bounded and bound into the native validation contract', () => {
  const gate = { id: 'fixture', lfsPaths: ['fixtures/required template.xlsx'] };
  assert.deepEqual(validationLfsPaths(gate), gate.lfsPaths);
  for (const paths of [[], ['../secret'], ['fixtures/*.xlsx'], ['fixtures/a,fixtures/b'],
    ['C:\\file'], ['fixtures\\file'], ['/file'], ['a\nb'], ['a', 'a']])
    assert.throws(() => validationLfsPaths({ lfsPaths: paths }), /lfsPaths/);
  assert.notEqual(repositoryValidationContract({ validationGates: [gate] }).sha256,
    repositoryValidationContract({ validationGates: [{ id: 'fixture' }] }).sha256);
});
test('staged native build hydrates only approved LFS objects at the exact revision', {
  skip: !gitLfsAvailable
}, async t => {
  const ctx = await lfsValidationFixture(t);
  const requests = useFixtureLfsTransfer(t, ctx);
  const execute = async (...args) => {
    const cwd = args[2], stage = args[4].PILOT_VALIDATION_STAGE;
    if (stage === 'compile' || stage === 'test') {
      assert.deepEqual(readFileSync(join(cwd, ctx.path)), ctx.content);
      assert.match(readFileSync(join(cwd, 'fixtures', 'unrelated.xlsx'), 'utf8'),
        /^version https:\/\/git-lfs.github.com\/spec\/v1/);
    }
    return ctx.execute(...args);
  };
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.revision, execute);
  assert.ok(prepared.staged.receiptPath, json(prepared));
  assert.deepEqual(prepared.staged.outputs.lfs, {
    revision: ctx.revision,
    objects: [{ path: ctx.path, oid: hash(ctx.content), size: ctx.content.length }]
  });
  const revision = await ctx.commit('test/behavior.test.js', 'changed test\n', 'Add case');
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
  assert.deepEqual(readFileSync(requests, 'utf8').trim().split('\n')
    .map(line => JSON.parse(line).oid), [hash(ctx.content)],
  'Native LFS must transfer only the approved object, without refetching during reuse');
  assert.equal((await command('git', ['status', '--porcelain'], ctx.isolated.workspace)).stdout, '');
});
test('LFS fetch errors preserve sanitized native evidence and do not start the compiler', {
  skip: !gitLfsAvailable
}, async t => {
  const ctx = await lfsValidationFixture(t);
  const workspace = join(ctx.root, 'lfs-probe');
  await command('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout',
    ctx.isolated.workspace, workspace], ctx.root);
  await command('git', ['-c', 'core.autocrlf=false', 'checkout', '--quiet', '--detach', ctx.revision],
    workspace, 10000, checkoutEnvironment());
  ctx.repo.remote = 'https://dev.azure.com/example/project/_git/repository';
  const token = 'fixture-private-token';
  let calls = 0;
  await assert.rejects(hydrateValidationLfs(ctx.config, ctx.repo, ctx.repo.validationGates[0],
    workspace, ctx.revision, {
      getToken: async () => token,
      executeGit: async (cwd, args, env) => {
        calls++;
        assert.equal(cwd, workspace);
        assert.ok(args.includes(`--include=/${ctx.path}`));
        assert.ok(args.includes(ctx.revision));
        assert.ok(args.includes('lfs.fetchrecentalways=false'));
        assert.ok(args.includes('lfs.transfer.maxretries=0'));
        assert.ok(!json(args).includes(token));
        assert.equal(env.GIT_CURL_VERBOSE, '');
        assert.equal(env.GIT_CONFIG_VALUE_0, `AUTHORIZATION: bearer ${token}`);
        throw Object.assign(new Error(`unsafe ${token}`), {
          code: 2, stderr: `HTTP 403 ${token}`, stdout: ''
        });
      }
    }), error => {
    assert.equal(error.code, 'blocked-validation-lfs');
    assert.equal(error.nativeGitExitCode, 2);
    assert.equal(error.stderr, 'HTTP 403 [REDACTED]');
    assert.ok(!error.message.includes(token));
    return true;
  });
  assert.equal(calls, 1);
  assert.match(readFileSync(join(workspace, ctx.path), 'utf8'), /^version /);
});
test('LFS materialization rejects an unchanged pointer after a success-shaped checkout', {
  skip: !gitLfsAvailable
}, async t => {
  const ctx = await lfsValidationFixture(t);
  const workspace = join(ctx.root, 'lfs-incomplete');
  await command('git', ['clone', '--quiet', '--no-hardlinks', '--no-checkout',
    ctx.isolated.workspace, workspace], ctx.root);
  await command('git', ['-c', 'core.autocrlf=false', 'checkout', '--quiet', '--detach', ctx.revision],
    workspace, 10000, checkoutEnvironment());
  await assert.rejects(hydrateValidationLfs(ctx.config, ctx.repo, ctx.repo.validationGates[0],
    workspace, ctx.revision, { executeGit: async () => '' }), /pointer OID and size/);
});
test('ADO draft provider creates only a draft and reconciles by stable source branch', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  repo.remote = 'https://dev.azure.com/test/project/_git/fixture';
  repo.pr = { provider: 'ado', organization: 'test', project: 'project', repositoryId: 'fixture', targetRef: 'refs/heads/main' };
  const calls = [], revision = 'a'.repeat(40);
  const pr = { pullRequestId: 5, isDraft: true, status: 'active', sourceRefName: `refs/heads/pilot/${job.id}`,
    targetRefName: 'refs/heads/main', lastMergeSourceCommit: { commitId: revision } };
  const result = await createAdoDraft(config, ledger, job, repo, revision, { title: 'Fixture', description: 'Synthetic' },
    async (method, suffix, body) => { calls.push({ method, suffix, body }); return method === 'GET' ? { value: [] } : pr; });
  assert.equal(calls[1].body.isDraft, true);
  assert.equal(calls[1].body.completionOptions, undefined);
  assert.equal(result.isDraft, true);
  let writes = 0;
  await createAdoDraft(config, ledger, job, repo, revision, {}, async method => {
    if (method !== 'GET') writes++; return { value: [pr] };
  });
  assert.equal(writes, 0);
});
test('ADO Draft build queues the exact pushed revision once without polling', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  repo.pr = {
    provider: 'ado',
    organization: 'office',
    project: 'Office',
    repositoryId: '1JS',
    sourceBranchPrefix: 'user/tester/periodic-evidence-agent',
    targetRef: 'refs/heads/main'
  };
  repo.draftBuild = {
    enabled: true,
    provider: 'ado',
    id: '1js-pipeline-36540',
    definitionId: 36540,
    templateParameters: { excelAgentExperience: 'omni' }
  };
  const revision = 'd'.repeat(40);
  const calls = [];
  const receipt = await queueAdoDraftBuild(config, ledger, job, repo, revision, async body => {
    calls.push(body);
    return {
      id: 57329999,
      _links: {
        web: {
          href: 'https://office.visualstudio.com/Office/_build/results?buildId=57329999'
        }
      }
    };
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0], {
    definition: { id: 36540 },
    sourceBranch: `refs/heads/user/tester/periodic-evidence-agent/${job.id}`,
    sourceVersion: revision,
    templateParameters: { excelAgentExperience: 'omni' }
  });
  assert.equal(receipt.status, 'queued');
  assert.equal(receipt.blocking, false);
  assert.equal(receipt.sourceRevision, revision);
  assert.equal(receipt.buildId, 57329999);
  assert.equal(ledger.status().operations.find(operation =>
    operation.id === `${job.id}:draft-build:1js-pipeline-36540`).state, 'queued');
});
test('ADO Draft build accepts the matching response project GUID without requeueing', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  repo.pr = { provider: 'ado', organization: 'office', project: 'Office' };
  repo.draftBuild = { enabled: true, provider: 'ado', id: 'aurora', definitionId: 36540 };
  const projectId = 'a4aa557b-7dca-453d-9d83-2fe9271852b9';
  const url = `https://dev.azure.com/office/${projectId}/_build/results?buildId=57965896`;
  let calls = 0;
  const receipt = await queueAdoDraftBuild(config, ledger, job, repo, 'd'.repeat(40), async () => {
    calls++;
    return { id: 57965896, project: { id: projectId, name: 'Office' }, _links: { web: { href: url } } };
  });
  assert.equal(calls, 1);
  assert.equal(receipt.url, url);
  assert.equal(receipt.buildId, 57965896);
  assert.equal(ledger.status().operations.find(row => row.kind === 'draft-build').state, 'queued');
});
test('ADO Draft build rejects unrelated GUIDs, projects and hosts', async t => {
  const projectId = 'a4aa557b-7dca-453d-9d83-2fe9271852b9';
  const approved = `https://dev.azure.com/office/${projectId}/_build/results?buildId=5`;
  for (const response of [
    { project: { id: projectId, name: 'AnotherProject' }, url: approved },
    { project: { id: projectId, name: 'Office' }, url: approved.replace(projectId, 'b'.repeat(36)) },
    { project: { id: projectId, name: 'Office' }, url: approved.replace('dev.azure.com', 'example.com') },
    { project: undefined, url: approved }
  ]) {
    await t.test(response.url + ':' + response.project?.name, async sub => {
      const { config, ledger, job, repo } = await fixture(sub);
      repo.pr = { provider: 'ado', organization: 'office', project: 'Office' };
      repo.draftBuild = { enabled: true, provider: 'ado', id: 'aurora', definitionId: 36540 };
      let calls = 0;
      await assert.rejects(queueAdoDraftBuild(config, ledger, job, repo, 'd'.repeat(40), async () => {
        calls++;
        return { id: 5, project: response.project, _links: { web: { href: response.url } } };
      }), /approved build URL/);
      assert.equal(calls, 1);
      assert.equal(ledger.status().operations.find(row => row.kind === 'draft-build').state, 'started');
    });
  }
});
test('ADO Draft build URLs accept only configured or response-bound project paths', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  repo.pr = {
    provider: 'ado', organization: 'office', project: 'Office',
    sourceBranchPrefix: 'user/tester/periodic-evidence-agent'
  };
  repo.draftBuild = {
    enabled: true, provider: 'ado', id: 'build', definitionId: 36540
  };
  const projectId = '11111111-2222-3333-4444-555555555555';
  const cases = [
    [true, 'Office', projectId, `https://office.visualstudio.com/${projectId}/_build/results?buildId=42`],
    [true, 'Office', projectId, `https://dev.azure.com/office/${projectId}/_build/results?buildId=42`],
    [false, 'Other', projectId, `https://office.visualstudio.com/${projectId}/_build/results?buildId=42`],
    [false, 'Office', 'other', 'https://office.visualstudio.com/other/_build/results?buildId=42'],
    [false, 'Office', projectId, `https://office.visualstudio.com.attacker.invalid/${projectId}/_build/results?buildId=42`],
    [false, 'Office', projectId, `https://office.visualstudio.com/99999999-2222-3333-4444-555555555555/_build/results?buildId=42`]
  ];
  for (const [index, [accepted, name, id, href]] of cases.entries()) {
    const queued = queueAdoDraftBuild(config, ledger, { ...job, id: `${job.id}-${index}` },
      repo, 'd'.repeat(40), async () => ({
        id: 42, project: { name, id }, _links: { web: { href } }
      }));
    if (accepted) assert.equal((await queued).url, href);
    else await assert.rejects(queued, /approved build URL/);
  }
});
test('1JS Draft builds select only added scenarios at the final authored SHA', async t => {
  const { config, ledger, job, repo, g } = await fixture(t);
  const excelRoot = 'ooui/apps/excel-agent-declarative-e2e/declarative/scenarios';
  const crossRoot = 'ooui/apps/cross-office-client-e2e/scenarios/new-case';
  mkdirSync(join(repo.referenceCheckout, excelRoot), { recursive: true });
  writeFileSync(join(repo.referenceCheckout, excelRoot, 'existing.yaml'), 'id: existing\n');
  await g(['add', '.']);
  await g(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Existing scenario']);
  const baseRevision = (await g(['rev-parse', 'HEAD'])).stdout.trim();
  mkdirSync(join(repo.referenceCheckout, crossRoot), { recursive: true });
  writeFileSync(join(repo.referenceCheckout, excelRoot, 'existing.yaml'), 'id: existing\nname: Updated\n');
  writeFileSync(join(repo.referenceCheckout, excelRoot, 'new-grid.yaml'), 'id: new-grid\n');
  writeFileSync(join(repo.referenceCheckout, crossRoot, 'scenario.yaml'), 'id: new-cross\n');
  writeFileSync(join(repo.referenceCheckout, 'registry.yaml'), 'not a scenario\n');
  await g(['add', '.']);
  await g(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Authored cases and registry']);
  const revision = (await g(['rev-parse', 'HEAD'])).stdout.trim();
  const current = { ...job, workspace: repo.referenceCheckout, base_revision: baseRevision };
  const selection = await newCaseBuildSelection(current, revision);
  assert.deepEqual(selection, {
    format: '1js-new-case-selection-v1',
    baseRevision,
    sourceRevision: revision,
    scenarioPaths: [`${crossRoot}/scenario.yaml`, `${excelRoot}/new-grid.yaml`]
  });
  assert.equal(newCaseBuildGroups(selection), 'excelAgentDeclarative crossOfficeCowork');
  repo.id = '1js';
  repo.pr = { provider: 'ado', organization: 'office', project: 'Office' };
  repo.draftBuild = {
    enabled: true, provider: 'ado', id: 'new-cases', definitionId: 36540,
    templateParameters: { excelAgentExperience: 'omni' }
  };
  let requests = 0;
  const request = async body => {
    requests++;
    assert.equal(body.sourceVersion, revision);
    assert.equal(body.templateParameters.excelAgentExperience, 'omni');
    assert.equal(body.templateParameters.newCaseGroups, 'excelAgentDeclarative crossOfficeCowork');
    assert.deepEqual(JSON.parse(body.templateParameters.newCaseSelection), selection);
    return { id: 42 };
  };
  const receipt = await queueAdoDraftBuild(config, ledger, current, repo, revision, request);
  assert.deepEqual(receipt.caseSelection, selection);
  await assert.rejects(queueAdoDraftBuild(config, ledger, current, repo, revision, request),
    /already started/);
  assert.equal(requests, 1);
  await assert.rejects(newCaseBuildSelection(current, baseRevision), /current authored revision/);
  repo.draftBuild.templateParameters.newCaseSelection = '{}';
  await assert.rejects(queueAdoDraftBuild(config, ledger, current, repo, revision, request),
    /controller-owned/);
  assert.equal(requests, 1);
});
test('new-case builds reject empty, existing-only, non-regular and excessive selections', async t => {
  const { repo, job, g } = await fixture(t);
  const baseRevision = (await g(['rev-parse', 'HEAD'])).stdout.trim();
  const current = { ...job, workspace: repo.referenceCheckout, base_revision: baseRevision };
  await assert.rejects(newCaseBuildSelection(current, baseRevision), /no full-suite fallback/);
  writeFileSync(join(repo.referenceCheckout, 'src', 'value.js'), 'export const value = 2;\n');
  await g(['add', '.']);
  await g(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Update existing source']);
  const updated = (await g(['rev-parse', 'HEAD'])).stdout.trim();
  await assert.rejects(newCaseBuildSelection(current, updated), /no full-suite fallback/);
  const oid = (await g(['hash-object', '-w', 'src/value.js'])).stdout.trim();
  await g(['update-index', '--add', '--cacheinfo',
    `120000,${oid},ooui/apps/excel-agent-declarative-e2e/declarative/scenarios/link.yaml`]);
  await g(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Non-regular scenario']);
  const linked = (await g(['rev-parse', 'HEAD'])).stdout.trim();
  await assert.rejects(newCaseBuildSelection(current, linked), /regular scenario files/);
  await g(['update-index', '--force-remove',
    'ooui/apps/excel-agent-declarative-e2e/declarative/scenarios/link.yaml']);
  for (let batch = 0; batch < 2; batch++) {
    const entries = Array.from({ length: 50 }, (_, index) => [
      '--cacheinfo',
      `100644,${oid},ooui/apps/excel-agent-declarative-e2e/declarative/scenarios/${batch}-${index}-${'x'.repeat(300)}.yaml`
    ]).flat();
    await g(['update-index', '--add', ...entries]);
  }
  await g(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Excessive selection parameter']);
  const excessive = (await g(['rev-parse', 'HEAD'])).stdout.trim();
  await assert.rejects(newCaseBuildSelection(current, excessive), /pipeline parameter limit/);
});
test('ADO draft provider uses a configured user source branch namespace', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  repo.remote = 'https://dev.azure.com/test/project/_git/fixture';
  repo.pr = {
    provider: 'ado',
    organization: 'test',
    project: 'project',
    repositoryId: 'fixture',
    sourceBranchPrefix: 'user/tester/periodic-evidence-agent',
    targetRef: 'refs/heads/main'
  };
  const revision = 'c'.repeat(40);
  const sourceRefName = `refs/heads/user/tester/periodic-evidence-agent/${job.id}`;
  const draft = {
    pullRequestId: 7,
    isDraft: true,
    status: 'active',
    sourceRefName,
    targetRefName: 'refs/heads/main',
    lastMergeSourceCommit: { commitId: revision }
  };
  const calls = [];
  await createAdoDraft(config, ledger, job, repo, revision,
    { title: 'Fixture', description: 'Synthetic' },
    async (method, suffix, body) => {
      calls.push({ method, suffix, body });
      return method === 'GET' ? { value: [] } : draft;
    });
  assert.match(calls[0].suffix, /user%2Ftester%2Fperiodic-evidence-agent/);
  assert.equal(calls[1].body.sourceRefName, sourceRefName);
});
test('ADO draft provider accepts the configured legacy visualstudio.com repository host', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  repo.remote = 'https://office.visualstudio.com/ISS/_git/OfficeAgent';
  repo.pr = { provider: 'ado', organization: 'office', project: 'ISS', repositoryId: 'OfficeAgent',
    targetRef: 'refs/heads/main' };
  const revision = 'b'.repeat(40);
  const draft = {
    pullRequestId: 9, isDraft: true, status: 'active', sourceRefName: `refs/heads/pilot/${job.id}`,
    targetRefName: 'refs/heads/main', lastMergeSourceCommit: { commitId: revision }
  };
  const result = await createAdoDraft(config, ledger, job, repo, revision,
    { title: 'Fixture', description: 'Synthetic' },
    async method => method === 'GET' ? { value: [draft] } : draft);
  assert.equal(result.url, 'https://office.visualstudio.com/ISS/_git/OfficeAgent/pullrequest/9');
});
test('ADO Git push uses a short-lived bearer header without persisting or exposing the token in arguments', async t => {
  const { config, repo } = await fixture(t);
  repo.remote = 'https://office.visualstudio.com/ISS/_git/OfficeAgent';
  repo.pr = { provider: 'ado', organization: 'office', project: 'ISS', repositoryId: 'OfficeAgent',
    targetRef: 'refs/heads/main' };
  const calls = [];
  const originalGitConfigValue = process.env.GIT_CONFIG_VALUE_0;
  await pushDraftBranch(config, 'C:\\synthetic-workspace', repo, 'HEAD:refs/heads/pilot/test', {
    getToken: async () => 'synthetic-sensitive-token',
    execute: async (cwd, args, env) => calls.push({ cwd, args, env })
  });
  assert.equal(calls.length, 1);
  assert.deepEqual(calls[0].args, ['push', 'origin', 'HEAD:refs/heads/pilot/test']);
  assert.doesNotMatch(json(calls[0].args), /synthetic-sensitive-token/);
  assert.equal(calls[0].env.GIT_CONFIG_KEY_0, 'http.extraHeader');
  assert.equal(calls[0].env.GIT_CONFIG_VALUE_0, 'AUTHORIZATION: bearer synthetic-sensitive-token');
  assert.equal(calls[0].env.GIT_TRACE_CURL, '0');
  assert.equal(process.env.GIT_CONFIG_VALUE_0, originalGitConfigValue);
});
test('uncertain PR creation cannot be retried and non-draft heads are rejected', async t => {
  const { config, ledger, job, repo } = await fixture(t);
  repo.remote = 'https://dev.azure.com/test/project/_git/fixture';
  repo.pr = { provider: 'ado', organization: 'test', project: 'project', repositoryId: 'fixture', targetRef: 'refs/heads/main' };
  ledger.operation(`${job.id}:draft`, job.id, 'draft-pr', {});
  await assert.rejects(createAdoDraft(config, ledger, job, repo, 'a'.repeat(40), {}, async () => ({ value: [] })), /already started/);
  await assert.rejects(createAdoDraft(config, ledger, job, repo, 'a'.repeat(40), {}, async () => ({ value: [{ isDraft: false }] })), /not an active draft/);
});
test('disabled schedule cannot perform any scan', async t => {
  const { config, ledger } = setup(t);
  await assert.rejects(tick(config, ledger), /disabled/);
  assert.equal(ledger.status().runs.length, 0);
});
test('unresolved changed-evidence policy blocks recurring collection', async t => {
  const { config, ledger } = setup(t); config.schedule.enabled = true;
  ledger.qualify('manual-run', { fingerprint: readinessFingerprint(config) });
  await assert.rejects(tick(config, ledger), /changed-evidence policy/);
});
test('local flight controller path: simulated adapter/model/PR, real isolated edit commit source-test and local push', async t => {
  const { config, ledger, job, repo, g, root } = await fixture(t, 'authenticated-source', 'defect-fix');
  repo.flights = { proposerExecutor: 'local' };
  config.activation.dispatch = true; config.limits.maxAiCreditsPerSession = 1;
  config.workspaceCleanup.enabled = true;
  await command('git', ['init', '--bare', '--quiet', repo.remote], root);
  const primaryHead = (await g(['rev-parse', 'HEAD'])).stdout;
  let modelCalls = 0, draftCalls = 0, authenticationReady = false;
  const dependencies = {
    agencyTransport: () => assert.fail('local flight must not submit to Agency'),
    preflightValidationAuthentication: async () => authenticationReady ? [] : [{
      state: 'action-required-auth',
      code: 'validation-authentication-required'
    }],
    runModel: async (c, l, current, assignment, investigation, toolkit) => {
      modelCalls++;
      assert.match(toolkit.read('src\\value.js'), /value = 1/);
      toolkit.write('src\\value.js', 'export const value = 2;\n');
      toolkit.finish({ outcome: 'propose-change', findings: 'Synthetic reproduction and source correction',
        title: 'Synthetic fixture correction', description: 'Simulated PR, not workplace evidence.' });
    },
    createDraft: async (c, l, current, r, revision) => {
      draftCalls++;
      const remoteHead = (await command('git', ['--git-dir', repo.remote, 'rev-parse', `refs/heads/pilot/${job.id}`], root)).stdout.trim();
      assert.equal(remoteHead, revision);
      return { url: 'https://example.invalid/synthetic-draft/1', isDraft: true, headRevision: revision };
    }
  };
  const action = await dispatch(config, ledger, job.id, dependencies);
  assert.equal(action.state, 'action-required-auth');
  assert.equal(ledger.job(job.id).state, 'prepared');
  assert.equal(modelCalls, 0);
  assert.equal(ledger.all('workerResult').length, 0);
  authenticationReady = true;
  const result = await dispatch(config, ledger, job.id, dependencies);
  assert.equal(result.outcome, 'draft-pr-validated');
  assert.equal(result.workspaceCleanup.state, 'removed', json(result.workspaceCleanup));
  assert.equal(existsSync(ledger.job(job.id).workspace), false);
  assert.equal(ledger.workspaceCleanup(job.id).sourceRevision, result.sourceRevision);
  assert.ok(result.validation[0].artifactRefs.every(existsSync));
  assert.equal(result.validation[0].sourceRevision, result.draftPR.headRevision);
  assert.equal(ledger.job(job.id).state, 'completed');
  assert.equal(ledger.all('workerResult').length, 1);
  assert.equal(modelCalls, 1); assert.equal(draftCalls, 1);
  await assert.rejects(dispatch(config, ledger, job.id), /never-dispatched/);
  assert.equal((await g(['rev-parse', 'HEAD'])).stdout, primaryHead);
  assert.equal((await g(['status', '--porcelain'])).stdout, '');
});
test('multi-repository scheduler uses isolated real commits, gates and pushes with same-repository exclusion',
  { timeout: 60000 }, async t => {
    const { config, ledger, job, repo, root } =
      await fixture(t, 'authenticated-source', 'defect-fix');
    config.activation.dispatch = true;
    config.limits.maxAiCreditsPerSession = 1;
    config.limits.maxWorkers = 3;
    config.limits.maxWorkersPerRepository = 1;
    const secondRepo = {
      ...structuredClone(repo), id: 'second-fixture',
      referenceCheckout: join(root, 'second-reference'),
      remote: join(root, 'second-remote.git')
    };
    await command('git', ['clone', '--quiet', '--no-hardlinks',
      repo.referenceCheckout, secondRepo.referenceCheckout], root);
    writeFileSync(join(secondRepo.referenceCheckout, 'src', 'value.js'),
      'export const value = 10;\n');
    await command('git', ['-c', 'core.hooksPath=.git/no-hooks',
      '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
      '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
      'commit', '--quiet', '-am', 'Distinct second repository baseline'],
    secondRepo.referenceCheckout);
    secondRepo.validationGates[0].args = [
      '--input-type=module', '-e',
      "import {value} from './src/value.js'; import assert from 'node:assert/strict'; assert.equal(value,20)"
    ];
    config.repositories.push(secondRepo);
    const prepare = (id, target) => {
      const evidence = addEvidence(ledger, id, '1', { fixture: true }, 'authenticated-source');
      const investigation = review(evidence);
      investigation.repoIds = [target.id];
      ledger.put(investigation);
      return ledger.prepare(makeAssignment(config, investigation, target.id, 'defect-fix'));
    };
    const secondJob = prepare('2', secondRepo);
    const deferredJob = prepare('3', repo);
    for (const target of config.repositories)
      await command('git', ['init', '--bare', '--quiet', target.remote], root);
    const references = await Promise.all(config.repositories.map(async target => ({
      workspace: target.referenceCheckout,
      head: (await command('git', ['rev-parse', 'HEAD'], target.referenceCheckout)).stdout.trim()
    })));
    const otherLedger = new Ledger(config.stateDirectory);
    const entered = new Set();
    let release;
    const bothAuthoring = new Promise(resolve => { release = resolve; });
    const dependencies = {
      runModel: async (_config, _ledger, current, assignment, _investigation, toolkit) => {
        entered.add(assignment.repoId);
        if (entered.size === 2) release();
        await bothAuthoring;
        assert.equal(ledger.job(job.id).state, 'running');
        assert.equal(ledger.job(secondJob.id).state, 'running');
        await assert.rejects(dispatch(config, otherLedger, deferredJob.id),
          /Repository worker limit/);
        assert.equal(otherLedger.job(deferredJob.id).state, 'prepared');
        const expected = assignment.repoId === repo.id ? 1 : 10;
        assert.match(toolkit.read('src\\value.js'), new RegExp(`value = ${expected};`));
        toolkit.write('src\\value.js', `export const value = ${expected * 2};\n`);
        toolkit.finish({
          outcome: 'propose-change', findings: 'Isolated synthetic source correction',
          title: 'Synthetic concurrent correction', description: 'Offline concurrency test'
        });
      },
      createDraft: async (_config, _ledger, current, target, revision) => {
        const remoteHead = (await command('git', ['--git-dir', target.remote,
          'rev-parse', `refs/heads/pilot/${current.id}`], root)).stdout.trim();
        assert.equal(remoteHead, revision);
        return {
          url: `https://example.invalid/synthetic-draft/${target.id}`,
          isDraft: true, headRevision: revision
        };
      }
    };
    const result = await schedulePreparedAssignments(config, ledger, {
      execute: true, authorizeCommit: true, authorizePush: true, authorizeDraftPR: true
    }, { dispatchDependencies: dependencies }).finally(() => otherLedger.close());
    assert.deepEqual(result.results.map(value => value.assignmentId), [job.id, secondJob.id]);
    assert.ok(result.results.every(value => value.outcome === 'draft-pr-validated'));
    assert.equal(entered.size, 2);
    assert.equal(ledger.job(deferredJob.id).state, 'prepared');
    assert.notEqual(ledger.job(job.id).workspace, ledger.job(secondJob.id).workspace);
    const outputs = ledger.all('workerResult');
    assert.equal(outputs.length, 2);
    for (const output of outputs) {
      assert.equal(output.validation[0].status, 'passed');
      assert.equal(output.validation[0].sourceRevision, output.sourceRevision);
      assert.equal(output.draftPR.headRevision, output.sourceRevision);
    }
    assert.notEqual(outputs[0].sourceRevision, outputs[1].sourceRevision);
    for (const reference of references) {
      assert.equal((await command('git', ['rev-parse', 'HEAD'], reference.workspace))
        .stdout.trim(), reference.head);
      assert.equal((await command('git', ['status', '--porcelain'], reference.workspace))
        .stdout.trim(), '');
    }
  });
test('real dispatch enforces global capacity and duplicate ownership across ledger connections',
  { timeout: 30000 }, async t => {
    const { config, ledger, job, repo } = await fixture(t, 'authenticated-source');
    config.activation.dispatch = true;
    config.limits.maxAiCreditsPerSession = 1;
    config.limits.maxWorkers = 1;
    config.limits.maxWorkersPerRepository = 1;
    const evidence = addEvidence(ledger, '2', '1', { fixture: true }, 'authenticated-source');
    const investigation = review(evidence);
    investigation.repoIds = [repo.id];
    ledger.put(investigation);
    const waiting = ledger.prepare(makeAssignment(config, investigation, repo.id, 'rca-only'));
    const otherLedger = new Ledger(config.stateDirectory);
    let modelCalls = 0;
    await dispatch(config, ledger, job.id, {
      runModel: async (_config, _ledger, _current, _assignment, _investigation, toolkit) => {
        modelCalls++;
        await assert.rejects(dispatch(config, otherLedger, waiting.id), /Worker limit reached/);
        await assert.rejects(dispatch(config, otherLedger, job.id), /never-dispatched/);
        assert.equal(otherLedger.job(waiting.id).state, 'prepared');
        toolkit.finish({ outcome: 'investigated', findings: 'Synthetic capacity check' });
      }
    }).finally(() => otherLedger.close());
    assert.equal(modelCalls, 1);
    assert.equal(ledger.job(job.id).state, 'completed');
    assert.equal(ledger.job(waiting.id).state, 'prepared');
  });
test('simultaneous dispatches atomically admit only one worker across ledger connections',
  { timeout: 30000 }, async t => {
    const { config, ledger, job, repo } = await fixture(t, 'authenticated-source');
    config.activation.dispatch = true;
    config.limits.maxAiCreditsPerSession = 1;
    const evidence = addEvidence(ledger, '2', '1', { fixture: true }, 'authenticated-source');
    const investigation = review(evidence);
    investigation.repoIds = [repo.id];
    ledger.put(investigation);
    const waiting = ledger.prepare(makeAssignment(config, investigation, repo.id, 'rca-only'));
    const otherLedger = new Ledger(config.stateDirectory);
    let preflights = 0, modelCalls = 0, release;
    const simultaneous = new Promise(resolve => { release = resolve; });
    const dependencies = {
      preflightValidationAuthentication: async () => {
        if (++preflights === 2) release();
        await simultaneous;
        return [];
      },
      runModel: async (_config, _ledger, _current, _assignment, _investigation, toolkit) => {
        modelCalls++;
        toolkit.finish({ outcome: 'investigated', findings: 'Synthetic admission race' });
      }
    };
    const results = await Promise.allSettled([
      dispatch(config, ledger, job.id, dependencies),
      dispatch(config, otherLedger, waiting.id, dependencies)
    ]).finally(() => otherLedger.close());
    assert.equal(preflights, 2);
    assert.equal(modelCalls, 1);
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
    const rejected = results.find(result => result.status === 'rejected');
    assert.equal(rejected.reason.code, 'overlap');
    assert.match(rejected.reason.message, /Worker limit reached/);
    assert.deepEqual([ledger.job(job.id).state, ledger.job(waiting.id).state].sort(),
      ['completed', 'prepared']);
  });
test('planned OA skill path reconciles a landed product fix and creates a source-bound test-only draft result', async t => {
  const ctx = setup(t), repo = repoConfig(ctx.config, ctx.root);
  repo.commitTrailers = ['Copilot-Session: synthetic-session'];
  repo.allowedWritePrefixes = ['test'];
  repo.skillBindings = [{
    id: 'oa-integration-test-core', capability: 'integration-test-authoring',
    skillPath: 'docs/skills/Integration-test-core/SKILL.md', enabled: true, qualification: 'qualified',
    requestedOutcomes: ['add-or-update-tests'],
    allowedWritePrefixes: ['test'], requiresBehaviorCard: true,
    sideEffects: { commit: false, push: false, createDraftPR: false }
  }];
  repo.validationGates = [{
    id: 'oa-integration', approved: true, isolationVerified: true,
    executable: process.execPath, args: ['--test', 'test/behavior.test.js'], timeoutMs: 10000
  }];
  mkdirSync(join(repo.referenceCheckout, 'src'), { recursive: true });
  mkdirSync(join(repo.referenceCheckout, 'docs', 'skills', 'Integration-test-core'), { recursive: true });
  writeFileSync(join(repo.referenceCheckout, 'src', 'value.js'), 'export const value = 1;\n');
  writeFileSync(join(repo.referenceCheckout, 'docs', 'skills', 'Integration-test-core', 'SKILL.md'),
    '# Synthetic OA skill\nAdd focused integration coverage and return structured metadata.\n');
  const g = args => command('git', ['-c', 'core.hooksPath=.git/no-hooks', '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false', ...args], repo.referenceCheckout);
  await g(['init', '--quiet']);
  await g(['add', '.']);
  await g(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Synthetic OA fixture']);
  const record = adoRecord(adoItem(1), 'Synthetic resolved coverage', now());
  const productFix = 'https://example.invalid/product/pull/42';
  record.links = [{ url: productFix, relation: 'ArtifactLink', evidenceId: null, access: 'not-followed-out-of-scope' }];
  const evidence = ctx.ledger.evidence(record, { id: 1, rev: 1, fields: record.fields, relations: record.links }, 'fixture');
  const investigation = review(evidence);
  investigation.repoIds = [repo.id];
  investigation.existingFixes = [productFix];
  investigation.observedBehavior = 'OA behavior lacks a focused integration regression test.';
  investigation.expectedBehavior = 'The established behavior is covered by a focused integration test.';
  ctx.ledger.put(investigation);
  const improvement = recordAreaToImprove(ctx.ledger, {
    investigationIds: [investigation.id], category: 'missing-test-coverage',
    theme: 'OA focused integration regression coverage',
    observedBehavior: investigation.observedBehavior, expectedBehavior: investigation.expectedBehavior,
    rationale: 'Synthetic source-bound OA coverage improvement.', priority: 'medium',
    repoIds: [repo.id], capabilities: ['integration-test-authoring']
  });
  const baseRevision = (await g(['rev-parse', 'HEAD'])).stdout.trim();
  const validationContract = repositoryValidationContract(repo);
  ctx.ledger.qualify(skillQualificationId(repo.id, 'oa-integration-test-core'), {
    state: 'qualified-read-only', repoId: repo.id, bindingId: 'oa-integration-test-core',
    capability: 'integration-test-authoring', remote: repo.remote, baseRef: repo.baseRef,
    baseRevision, skillPath: 'docs/skills/Integration-test-core/SKILL.md',
    skillSha256: hash('# Synthetic OA skill\nAdd focused integration coverage and return structured metadata.\n'),
    qualificationSource: 'local-reference',
    validationContractVersion: validationContract.version,
    validationContractSha256: validationContract.sha256,
    sideEffects: { commit: false, push: false, createDraftPR: false }
  });
  let plan = recordTestCoveragePlan(ctx.ledger, {
    improvementId: improvement.id, improvementVersion: improvement.version,
    repoId: repo.id, capability: 'integration-test-authoring', sourceRevision: baseRevision,
    purpose: 'regression-coverage',
    searchStatus: 'complete', existingTests: [], coverageGaps: ['No focused regression test exists.'],
    unknowns: [], rationale: 'Synthetic complete search confirms the gap.'
  });
  assert.throws(() => makePlannedImprovementAssignment(ctx.config, ctx.ledger, investigation, plan.id),
    /Existing fix requires/);
  plan = recordTestCoveragePlan(ctx.ledger, { ...plan, existingFixesReview: {
    investigationId: investigation.id, investigationVersion: investigation.version,
    evidenceIds: investigation.evidenceIds, planId: plan.id, planVersion: plan.version + 1,
    sourceRevision: baseRevision,
    review: { method: investigation.review.method, reviewer: 'synthetic-coverage-review', reviewedAt: now() },
    fixes: [{ url: productFix, disposition: 'product-fix-with-remaining-coverage-gap',
      rationale: 'The product implementation is fixed on this base, but the focused regression assertion is absent.' }]
  } });
  const assignment = makePlannedImprovementAssignment(ctx.config, ctx.ledger, investigation, plan.id);
  assert.deepEqual(ctx.ledger.get('investigation', investigation.id).existingFixes, [productFix]);
  assert.equal(ctx.ledger.get('evidence', evidence.id).links[0].url, productFix);
  const rejected = new WorkerTools(ctx.config, assignment, repo.referenceCheckout, {
    binding: repo.skillBindings[0],
    skillPath: repo.skillBindings[0].skillPath,
    skillRevision: baseRevision,
    allowedWritePrefixes: ['test']
  });
  assert.throws(() => rejected.finish({
    outcome: 'propose-change', findings: 'Skill could not safely complete.',
    title: 'Must not publish', description: 'Must not publish',
    skillResult: {
      status: 'failed', classification: 'missing-coverage',
      changedFiles: ['test/behavior.test.js'], testsAddedOrUpdated: ['OA behavior'],
      behaviorCardsAddedOrUpdated: [], unknowns: ['Generation failed'], needsHumanDecision: false
    }
  }), /Only a successful repository skill result/);
  assert.equal(rejected.proposal, null);
  const needsDecision = new WorkerTools(ctx.config, assignment, repo.referenceCheckout, {
    binding: repo.skillBindings[0],
    skillPath: repo.skillBindings[0].skillPath,
    skillRevision: baseRevision,
    allowedWritePrefixes: ['test']
  });
  assert.throws(() => needsDecision.finish({
    outcome: 'propose-change', findings: 'Skill needs a human decision.',
    title: 'Must not publish', description: 'Must not publish',
    skillResult: {
      status: 'succeeded', classification: 'missing-coverage',
      changedFiles: ['test/behavior-card.md', 'test/behavior.test.js'],
      testsAddedOrUpdated: ['OA behavior'],
      behaviorCardsAddedOrUpdated: ['test/behavior-card.md'], unknowns: [], needsHumanDecision: true
    }
  }), /Only a successful repository skill result/);
  assert.equal(needsDecision.proposal, null);
  const job = ctx.ledger.prepare(assignment);
  ctx.config.activation.dispatch = true;
  ctx.config.limits.maxAiCreditsPerSession = 1;
  await command('git', ['init', '--bare', '--quiet', repo.remote], ctx.root);
  const result = await dispatch(ctx.config, ctx.ledger, job.id, {
    runModel: async (config, ledger, current, currentAssignment, currentInvestigation, toolkit, loadedSkill) => {
      assert.match(loadedSkill.instructions, /Synthetic OA skill/);
      assert.equal(loadedSkill.skillRevision, baseRevision);
      writeFileSync(join(current.workspace, '.git', 'hooks', 'pre-commit'),
        '#!/bin/sh\nprintf invoked > .git/synthetic-hook-receipt\n', { mode: 0o755 });
      assert.throws(() => toolkit.write('src\\value.js', 'export const value = 2;\n'),
        /outside approved edit bounds/);
      toolkit.write('test\\behavior.test.js',
        "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('OA behavior', () => assert.equal(1, 1));\n");
      toolkit.write('test\\behavior.behavior-card.md', '# OA behavior\n\nSynthetic behavior card.\n');
      toolkit.finish({
        outcome: 'propose-change', findings: 'Added focused OA integration coverage.',
        title: '[Periodic Evidence Agent Canary] Add OA behavior coverage',
        description: 'Synthetic draft used to verify the source-bound OA skill pipeline.',
        skillResult: {
          status: 'succeeded', classification: 'missing-coverage',
          changedFiles: ['test/behavior.behavior-card.md', 'test/behavior.test.js'],
          testsAddedOrUpdated: ['OA behavior'],
          behaviorCardsAddedOrUpdated: ['test/behavior.behavior-card.md'],
          unknowns: [], needsHumanDecision: false
        }
      });
    },
    createDraft: async (config, ledger, current, currentRepo, revision) => ({
      url: 'https://example.invalid/oa/draft/1', isDraft: true, headRevision: revision
    })
  });
  assert.equal(result.outcome, 'draft-pr-validated');
  assert.equal(result.skillExecution.bindingId, 'oa-integration-test-core');
  assert.deepEqual(result.skillExecution.changedFiles,
    ['test/behavior.behavior-card.md', 'test/behavior.test.js']);
  assert.equal(result.validation[0].sourceRevision, result.sourceRevision);
  assert.equal(result.draftPR.headRevision, result.sourceRevision);
  const workspace = ctx.ledger.job(job.id).workspace;
  assert.equal(readFileSync(join(workspace, '.git', 'synthetic-hook-receipt'), 'utf8'), 'invoked');
  const message = (await command('git', ['log', '-1', '--format=%B'], workspace)).stdout;
  assert.match(message, /Co-authored-by: Copilot <223556219\+Copilot@users\.noreply\.github\.com>/);
  assert.match(message, /Copilot-Session: synthetic-session/);
});
test('workspace GC previews delivery, reports deletion failure and safely retries without deleting caches or evidence', async t => {
  const ctx = await deliveredWorkspace(t);
  const { config, ledger, job, repo, root, isolated, artifact, result } = ctx;
  const dependencyCache = join(config.stateDirectory, 'pv', 'd', 'fixture', 'w');
  const compileCache = join(config.stateDirectory, 'pv', 'c', 'fixture', 'w');
  for (const path of [dependencyCache, compileCache]) {
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'preserved'), 'cache\n');
  }
  const operationsBefore = ledger.status().operations.length;
  const preview = await cleanupWorkspaces(config, ledger);
  assert.equal(preview.mode, 'preview');
  assert.equal(preview.workspaces[0].state, 'eligible', json(preview));
  assert.equal(ledger.workspaceCleanup(job.id), null);
  assert.equal(ledger.status().operations.length, operationsBefore);
  assert.equal(existsSync(isolated.workspace), true);
  const configPath = join(root, 'cleanup-config.json');
  const cli = (...args) => spawnSync(process.execPath, [
    fileURLToPath(new URL('../src/cli.js', import.meta.url)), 'workspace-gc',
    '--config', configPath, ...args
  ], { cwd: root, encoding: 'utf8', timeout: 120000 });
  writeFileSync(configPath, json(config));
  const cliPreview = cli();
  assert.equal(cliPreview.status, 0, cliPreview.stderr);
  assert.equal(JSON.parse(cliPreview.stdout).workspaces[0].state, 'eligible');
  assert.equal(ledger.workspaceCleanup(job.id), null);
  const originalRemote = repo.remote;
  repo.remote = join(root, 'missing-remote.git');
  await command('git', ['remote', 'set-url', 'origin', repo.remote], isolated.workspace);
  writeFileSync(configPath, json(config));
  const cliFailure = cli('--execute');
  assert.equal(cliFailure.status, 2, cliFailure.stderr);
  assert.equal(JSON.parse(cliFailure.stdout).workspaces[0].state, 'failed');
  assert.equal(existsSync(isolated.workspace), true);
  repo.remote = originalRemote;
  await command('git', ['remote', 'set-url', 'origin', repo.remote], isolated.workspace);
  const failed = await cleanupWorkspace(config, ledger, job.id, { execute: true }, {
    remove: () => { throw Object.assign(new Error('locked'), { code: 'EBUSY' }); }
  });
  assert.equal(failed.state, 'failed');
  assert.equal(ledger.workspaceCleanup(job.id).state, 'failed');
  assert.equal(ledger.job(job.id).state, 'completed');
  assert.equal(ledger.get('workerResult', result.id).outcome, 'draft-pr-validated');
  assert.equal(existsSync(isolated.workspace), true);
  const removed = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(removed.state, 'removed', json(removed));
  assert.equal(existsSync(isolated.workspace), false);
  assert.ok([repo.referenceCheckout, artifact, dependencyCache, compileCache].every(existsSync));
  const remoteHead = (await command('git', ['--git-dir', repo.remote, 'rev-parse',
    `refs/heads/pilot/${job.id}`], root)).stdout.trim();
  assert.equal(remoteHead, result.sourceRevision);
  const count = ledger.status().operations.length;
  const repeated = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(repeated.state, 'removed');
  assert.equal(ledger.workspaceCleanup(job.id).state, 'removed');
  assert.equal(ledger.status().operations.length, count);
  assert.throws(() => ledger.moveJob(job.id, 'completed', 'prepared'), /Cleaned workspace/);
  const reopened = new Ledger(config.stateDirectory);
  try {
    assert.equal(reopened.workspaceCleanup(job.id).state, 'removed');
  } finally { reopened.close(); }
  mkdirSync(isolated.workspace);
  writeFileSync(join(isolated.workspace, 'preserve.txt'), 'Recreated by another process\n');
  const recreated = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(recreated.state, 'skipped');
  assert.match(recreated.reason, /has been recreated/);
  assert.equal(existsSync(join(isolated.workspace, 'preserve.txt')), true);
  assert.equal(ledger.workspaceCleanup(job.id).state, 'removed');
  assert.equal((await cleanupWorkspace(config, ledger, job.id, { execute: true })).state, 'skipped');
});
test('workspace GC handles Windows short paths without bypassing primary-checkout protection',
  { skip: process.platform !== 'win32' }, async t => {
    const { config, job, repo, root, isolated, artifact } = await deliveredWorkspace(t);
    const shortRoot = (await command('powershell', ['-NoProfile', '-Command',
      '$fs = New-Object -ComObject Scripting.FileSystemObject; $fs.GetFolder($env:PILOT_TEST_ROOT).ShortPath'],
    root, 120000, { ...process.env, PILOT_TEST_ROOT: root })).stdout.trim();
    if (shortRoot === realpathSync.native(root)) {
      t.skip('Windows short-path aliases are unavailable on this volume');
      return;
    }
    config.stateDirectory = join(shortRoot, 'state');
    const workspace = join(config.stateDirectory, 'workspaces', job.session_id);
    const ledger = new Ledger(config.stateDirectory);
    try {
      ledger.db.prepare('UPDATE jobs SET workspace=? WHERE id=?').run(workspace, job.id);
      const reference = repo.referenceCheckout;
      repo.referenceCheckout = realpathSync.native(workspace);
      const retained = await cleanupWorkspace(config, ledger, job.id, { execute: true });
      assert.equal(retained.state, 'skipped', json(retained));
      assert.match(retained.reason, /overlaps a primary checkout/);
      assert.equal(existsSync(workspace), true);
      repo.referenceCheckout = reference;
      const preview = await cleanupWorkspace(config, ledger, job.id);
      assert.equal(preview.state, 'eligible', json(preview));
      const removed = await cleanupWorkspace(config, ledger, job.id, { execute: true });
      assert.equal(removed.state, 'removed', json(removed));
      assert.equal(existsSync(workspace), false);
      assert.ok([reference, artifact].every(existsSync));
    } finally { ledger.close(); }
  });
test('workspace GC retains unfinished tasks, dirty source, ignored files, local branches and missing evidence', async t => {
  const { config, ledger, job, isolated, artifact } = await deliveredWorkspace(t);
  const check = async pattern => {
    const result = await cleanupWorkspace(config, ledger, job.id, { execute: true });
    assert.equal(result.state, 'skipped', json(result));
    assert.match(result.reason, pattern);
    assert.equal(existsSync(isolated.workspace), true);
  };
  ledger.moveJob(job.id, 'completed', 'blocked');
  await check(/not completed/);
  ledger.moveJob(job.id, 'blocked', 'completed');
  writeFileSync(join(isolated.workspace, 'src', 'value.js'), 'uncommitted\n');
  await check(/uncommitted/);
  writeFileSync(join(isolated.workspace, 'src', 'value.js'), 'export const value = 1;\n');
  const untracked = join(isolated.workspace, 'private.log');
  writeFileSync(untracked, 'unpreserved evidence\n');
  await check(/untracked/);
  writeFileSync(join(isolated.workspace, '.git', 'info', 'exclude'), 'private.log\n');
  await check(/ignored files/);
  rmSync(untracked);
  await command('git', ['branch', 'extra'], isolated.workspace);
  await check(/additional local branches/);
  await command('git', ['branch', '-d', 'extra'], isolated.workspace);
  writeFileSync(join(isolated.workspace, 'src', 'value.js'), 'stashed\n');
  await command('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'stash', 'push', '--quiet'], isolated.workspace);
  await check(/stashed changes/);
  await command('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
    'stash', 'pop', '--quiet'], isolated.workspace);
  writeFileSync(join(isolated.workspace, 'src', 'value.js'), 'export const value = 1;\n');
  const linkedWorktree = join(config.stateDirectory, 'linked-worktree');
  await command('git', ['worktree', 'add', '--detach', linkedWorktree], isolated.workspace);
  await check(/Other Git worktrees/);
  await command('git', ['worktree', 'remove', linkedWorktree], isolated.workspace);
  ledger.operation('pending-validation', job.id, 'validation', {});
  await check(/unfinished operation/);
  ledger.finishOperation('pending-validation', 'completed', {});
  const owner = ledger.acquire('validation');
  await check(/holds a lock/);
  ledger.release('validation', owner);
  const evidence = readFileSync(artifact);
  rmSync(artifact);
  await check(/evidence is missing/);
  writeFileSync(artifact, evidence);
  config.workspaceCleanup.retentionHours = 24;
  await check(/retention period/);
  assert.equal(ledger.status().locks.length, 0);
});
test('workspace GC refuses unpushed HEAD, a missing remote branch and primary-checkout redirection', async t => {
  const { config, ledger, job, isolated, repo, root } = await deliveredWorkspace(t);
  await command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--allow-empty', '--quiet', '-m', 'Unpushed change'], isolated.workspace);
  const unpushed = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(unpushed.state, 'skipped');
  assert.match(unpushed.reason, /HEAD differs/);
  await command('git', ['checkout', '--detach', isolated.baseRevision], isolated.workspace);
  const detached = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(detached.state, 'skipped');
  assert.match(detached.reason, /HEAD is detached/);
  assert.equal(existsSync(isolated.workspace), true);
  assert.equal(ledger.job(job.id).state, 'completed');
  await command('git', ['branch', '-f', `pilot/${job.id}`, isolated.baseRevision], isolated.workspace);
  await command('git', ['checkout', `pilot/${job.id}`], isolated.workspace);
  const remoteRevision = (await command('git', ['--git-dir', repo.remote,
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit-tree', `${isolated.baseRevision}^{tree}`, '-p', isolated.baseRevision,
    '-m', 'Remote-only change'], root)).stdout.trim();
  await command('git', ['--git-dir', repo.remote, 'update-ref',
    `refs/heads/pilot/${job.id}`, remoteRevision], root);
  const advanced = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(advanced.state, 'skipped');
  assert.match(advanced.reason, /Remote branch differs/);
  await command('git', ['--git-dir', repo.remote, 'update-ref', '-d', `refs/heads/pilot/${job.id}`], root);
  const absent = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(absent.state, 'skipped');
  assert.match(absent.reason, /remote branch is missing/);
  ledger.db.prepare('UPDATE jobs SET workspace=? WHERE id=?').run(repo.referenceCheckout, job.id);
  const redirected = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(redirected.state, 'skipped');
  assert.match(redirected.reason, /registered task path/);
  assert.equal(existsSync(repo.referenceCheckout), true);
  assert.equal(existsSync(isolated.workspace), true);
  ledger.db.prepare('UPDATE jobs SET workspace=? WHERE id=?').run(isolated.workspace, job.id);
  repo.remote = 'https://dev.azure.com/synthetic/project/_git/repo';
  await command('git', ['remote', 'set-url', 'origin', repo.remote], isolated.workspace);
  const authentication = await cleanupWorkspace(config, ledger, job.id, { execute: true }, {
    getToken: async () => { throw new PilotError('blocked-auth', 'Synthetic authentication unavailable'); }
  });
  assert.equal(authentication.state, 'failed');
  assert.equal(authentication.error.code, 'blocked-auth');
  assert.equal(existsSync(isolated.workspace), true);
});
test('workspace GC refuses linked task paths and absent clones without a deletion receipt', async t => {
  const { config, ledger, job, isolated, repo } = await deliveredWorkspace(t);
  rmSync(isolated.workspace, { recursive: true, force: true });
  const missing = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(missing.state, 'skipped');
  assert.match(missing.reason, /missing without a cleanup receipt/);
  symlinkSync(repo.referenceCheckout, isolated.workspace, process.platform === 'win32' ? 'junction' : 'dir');
  const linked = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(linked.state, 'skipped');
  assert.match(linked.reason, /contains a link/);
  assert.equal(existsSync(join(repo.referenceCheckout, 'src', 'value.js')), true);
});
test('workspace GC cleans historical clones only when the copied base branch has no undelivered commits', async t => {
  const { config, ledger, job, isolated, repo } = await deliveredWorkspace(t);
  const copiedBranch = (await command('git', [
    'symbolic-ref', '--short', 'HEAD'
  ], repo.referenceCheckout)).stdout.trim();
  await command('git', ['branch', copiedBranch, isolated.baseRevision], isolated.workspace);
  const preview = await cleanupWorkspace(config, ledger, job.id);
  assert.equal(preview.state, 'eligible', json(preview));
  const unpublished = (await command('git', [
    '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit-tree', `${isolated.baseRevision}^{tree}`, '-p', isolated.baseRevision,
    '-m', 'Private base-branch commit'
  ], isolated.workspace)).stdout.trim();
  await command('git', ['branch', '-f', copiedBranch, unpublished], isolated.workspace);
  const retained = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(retained.state, 'skipped');
  assert.match(retained.reason, /Inherited base branch/);
  assert.equal(existsSync(isolated.workspace), true);
});
test('workspace GC retains support for historical failed-validation delivery receipts', async t => {
  const { config, ledger, job, artifact } = await deliveredWorkspace(t, { historicalFailure: true });
  const result = await cleanupWorkspace(config, ledger, job.id, { execute: true });
  assert.equal(result.state, 'removed', json(result));
  assert.equal(existsSync(ledger.job(job.id).workspace), false);
  assert.equal(existsSync(artifact), true);
  assert.equal(ledger.all('workerResult')[0].outcome, 'draft-pr-validation-failed');
});
test('automatic delivery cleanup honors opt-out and retains failure metadata', async t => {
  for (const mode of ['disabled', 'absent-policy', 'failure', 'retention']) {
    await t.test(mode, async t => {
      const { config, ledger, job, repo, root } = await fixture(t, 'authenticated-source', 'defect-fix');
      config.activation.dispatch = true;
      config.limits.maxAiCreditsPerSession = 1;
      if (mode === 'validation-failed') config.limits.maxValidationRepairRounds = 0;
      config.workspaceCleanup = { enabled: mode !== 'disabled', retentionHours: mode === 'retention' ? 24 : 0 };
      if (mode === 'absent-policy') delete config.workspaceCleanup;
      await command('git', ['init', '--bare', '--quiet', repo.remote], root);
      const result = await dispatch(config, ledger, job.id, {
        runModel: async (c, l, current, assignment, investigation, toolkit) => {
          toolkit.write('src\\value.js', 'export const value = 2;\n');
          toolkit.finish({
            outcome: 'propose-change', findings: 'Synthetic change',
            title: 'Synthetic delivery', description: 'Fixture only'
          });
        },
        createDraft: async (c, l, current, r, revision) => ({
          url: 'https://example.invalid/draft/1', isDraft: true, headRevision: revision
        }),
        workspaceCleanup: mode === 'failure' ? {
          remove: () => {
            assert.equal(ledger.status().locks.some(lock => lock.name === 'dispatch'), true);
            assert.equal(ledger.job(job.id).state, 'completed');
            assert.equal(ledger.all('workerResult').length, 1);
            throw new PilotError('cleanup-failed', 'Synthetic file lock prevents deletion');
          }
        } : undefined
      });
      assert.equal(result.outcome, 'draft-pr-validated');
      assert.equal(ledger.job(job.id).state, 'completed');
      assert.equal(existsSync(ledger.job(job.id).workspace), true);
      if (mode === 'disabled' || mode === 'absent-policy') {
        assert.equal(result.workspaceCleanup, undefined);
        assert.equal(ledger.workspaceCleanup(job.id), null);
      } else {
        assert.equal(result.workspaceCleanup.state,
          mode === 'failure' ? 'failed' : mode === 'retention' ? 'skipped' : 'removed', json(result.workspaceCleanup));
        assert.equal(ledger.workspaceCleanup(job.id).state, result.workspaceCleanup.state);
      }
    });
  }
});
test('workspace cleanup is opt-in and rejects invalid retention configuration', () => {
  assert.deepEqual(workspaceCleanupPolicy({}), { enabled: false, retentionHours: 0 });
  assert.throws(() => workspaceCleanupPolicy({
    workspaceCleanup: { enabled: true, retentionHours: -1 }
  }), /Invalid workspaceCleanupPolicy/);
  assert.throws(() => workspaceCleanupPolicy({
    workspaceCleanup: { enabled: 'yes', retentionHours: 0 }
  }), /Invalid workspaceCleanupPolicy/);
});
test('test-only skill diff gate rejects production paths including rename sources', () => {
  assert.doesNotThrow(() => requireAllowedSkillChanges(
    ['test/behavior.behavior-card.md', 'test/behavior.test.js'], ['test'],
    ['test/behavior.behavior-card.md', 'test/behavior.test.js']));
  assert.doesNotThrow(() => requireAllowedSkillChanges(
    ['shared/registry.yaml'], ['test'], ['shared/registry.yaml'], ['shared/registry.yaml']));
  assert.throws(() => requireAllowedSkillChanges(
    ['test/behavior.test.js', 'src/app.js'], ['test']),
  /src\/app\.js/);
  assert.throws(() => requireAllowedSkillChanges(
    ['test/behavior.test.js'], ['test'],
    ['test/behavior-card.md', 'test/behavior.test.js']),
  /does not match the workspace diff/);
});
test('interrupted worker persists blocked result and cannot relaunch', async t => {
  const { config, ledger, job } = await fixture(t, 'authenticated-source');
  config.activation.dispatch = true; config.limits.maxAiCreditsPerSession = 1;
  await assert.rejects(dispatch(config, ledger, job.id, {
    runModel: async (currentConfig, currentLedger, current, assignment, investigation,
      toolkit) => {
      toolkit.read('src\\value.js');
      throw new PilotError('blocked-auth', 'Synthetic Copilot reauthentication required');
    }
  }), /reauthentication/);
  assert.equal(ledger.job(job.id).state, 'blocked');
  const result = ledger.all('workerResult')[0];
  assert.equal(result.outcome, 'blocked');
  assert.equal(existsSync(ledger.job(job.id).workspace), true);
  assert.equal(ledger.workspaceCleanup(job.id), null);
  assert.match(result.blocker.reason, /reauthentication/);
  assert.equal(result.toolUsage.used, 1);
  assert.deepEqual(result.toolUsage.rounds, [{
    round: 0, used: 1, cumulativeUsed: 1, status: 'failed'
  }]);
  assert.equal(result.skillExecution, null);
  await assert.rejects(dispatch(config, ledger, job.id), /never-dispatched/);
});
test('synthetic provenance cannot be dispatched through the live entrypoint', async t => {
  const { config, ledger, job } = await fixture(t);
  config.activation.dispatch = true; config.limits.maxAiCreditsPerSession = 1;
  await assert.rejects(dispatch(config, ledger, job.id), /Synthetic evidence/);
  assert.equal(ledger.job(job.id).state, 'prepared');
});
test('new unreviewed evidence prevents dispatch of an earlier prepared assignment', async t => {
  const { config, ledger, job } = await fixture(t, 'authenticated-source');
  config.activation.dispatch = true; config.limits.maxAiCreditsPerSession = 1;
  addEvidence(ledger, '1', '2', { newer: true }, 'authenticated-source');
  await assert.rejects(dispatch(config, ledger, job.id), /New source evidence/);
  assert.equal(ledger.job(job.id).state, 'prepared');
});

test('dry-run budgets are scoped and no-network preflight never touches production state', async t => {
  const { config, ledger } = setup(t);
  config.limits.maxItems = null; config.limits.maxCalls = null;
  const before = json(ledger.status());
  let calls = 0;
  const result = await dryRun(config, { adapters: { ado: async () => { calls++; } } });
  assert.equal(result.error.code, 'awaiting-auth-refresh');
  assert.equal(calls, 0);
  assert.equal(result.collectionLimits.maxItems, 2000);
  assert.equal(result.collectionLimits.maxCalls, 300);
  assert.equal(result.collectionLimits.recurringDefault, false);
  assert.equal(config.limits.maxItems, null);
  assert.equal(json(ledger.status()), before);
  assert.ok(result.stateDirectory.startsWith(join(config.stateDirectory, 'dry-runs')));
  assert.equal(JSON.parse(readFileSync(join(result.stateDirectory, 'summary.json'))).dryRunId, result.dryRunId);
  const unrefreshed = await dryRun(config, { collectRequested: true });
  assert.equal(unrefreshed.error.code, 'awaiting-auth-refresh');
});

test('dry-run executes only mocked source passes in isolated ledger and separates cohort counts', async t => {
  const { config, ledger } = setup(t);
  config.schedule.changedEvidencePolicy = 'tracked-open-and-area-changed';
  config.activation.dispatch = true; config.activation.review = true; config.schedule.enabled = true;
  config.sources.workiq.enabled = true;
  const calls = [];
  const adapters = {
    ado: async (c, window, emit, lane) => {
      assert.deepEqual(c.activation, { collect: true, review: false, dispatch: false });
      assert.equal(c.schedule.enabled, false);
      assert.equal(c.limits.maxItems, 2000); assert.equal(c.limits.maxCalls, 300);
      calls.push(`ado:${lane}`);
      const item = adoItem(lane === 'created' ? 1 : 2);
      if (lane === 'changed') item.fields['System.CreatedDate'] = '2026-09-01T00:00:00Z';
      const record = adoRecord(item, 'mocked dry run', now());
      record.source.provenance = 'synthetic';
      await emit(record, item);
      return { end: window.end };
    },
    workiq: async () => { calls.push('workiq:created'); return { coverage: 'synthetic-empty' }; }
  };
  const before = json(ledger.status());
  const result = await dryRun(config, { collectRequested: true, authRefreshed: true, adapters });
  assert.deepEqual(calls, ['ado:created', 'workiq:created', 'ado:changed']);
  assert.equal(result.report.summary.newCohortIds.length, 1);
  assert.equal(result.report.summary.changedOnlyIds.length, 1);
  assert.equal(result.report.summary.reviewedIds.length, 0);
  assert.equal(result.workerDispatches, 0); assert.equal(result.externalWrites, 0);
  assert.equal(json(ledger.status()), before);
  const isolated = new Ledger(result.stateDirectory);
  try {
    assert.equal(isolated.status().jobs.length, 0);
    assert.equal(isolated.qualification('manual-run'), null);
    assert.equal(isolated.db.prepare('SELECT COUNT(*) AS n FROM assignment_budgets').get().n, 0);
  } finally { isolated.close(); }
});

test('dry-run auth failure suppresses changed-lane retries in the same run', async t => {
  const { config } = setup(t);
  config.schedule.changedEvidencePolicy = 'tracked-open-and-area-changed';
  let calls = 0;
  const result = await dryRun(config, { collectRequested: true, authRefreshed: true,
    adapters: { ado: async () => { calls++; throw new PilotError('blocked-auth', 'Synthetic auth failure'); } } });
  assert.equal(calls, 1);
  assert.equal(result.collection.find(r => r.lane === 'created').state, 'blocked-auth');
  assert.equal(result.collection.find(r => r.lane === 'changed').state, 'blocked');
});

test('WorkIQ validates exact success envelope and rejects runtime identity mismatch before source reads', async t => {
  const { config } = setup(t); channelConfig(config);
  assert.deepEqual(unwrapWorkiq({ resultType: 'success',
    textResultForLlm: json({ results: [{ statusCode: 200, data: principal(config) }] }) }), principal(config));
  assert.throws(() => unwrapWorkiq({ resultType: 'success',
    textResultForLlm: json({ results: [{ statusCode: 403, data: {} }] }) }), e => e.code === 'blocked-auth');
  const reads = [];
  await assert.rejects(collectWorkiq(config, config.window, async () => assert.fail('No evidence expected'),
    async path => { reads.push(path); return { id: 'different', userPrincipalName: 'wrong' }; }), /principal/);
  assert.deepEqual(reads, [principalPath]);
});

test('WorkIQ exhausts root and reply pages, including new reply to old root', async t => {
  const { config } = setup(t), seed = channelConfig(config), root = channelRoot(seed), reads = [], captured = [];
  const cursor = await collectWorkiq(config, config.window, async record => captured.push(record), async path => {
    reads.push(path);
    if (path === principalPath) return principal(config);
    const url = new URL(path, 'https://scope.invalid');
    if (url.pathname === root && !url.searchParams.has('$skiptoken'))
      return { value: [message('old', '2026-10-07T00:00:00Z')], '@odata.nextLink': `${root}?$skiptoken=next` };
    if (url.pathname === `${root}/old/replies`) return { value: [message('reply')] };
    if (url.pathname === root) return { value: [message('new')] };
    if (url.pathname === `${root}/new/replies`) return { value: [] };
    assert.fail(`Unexpected synthetic path ${path}`);
  });
  assert.deepEqual(captured.map(r => r.source.recordId), ['reply', 'new']);
  assert.equal(captured[0].fields.parentContext.id, 'old');
  assert.equal(cursor.coverage[0].messagesExamined, 3);
  assert.equal(reads.length, 5);
});

test('WorkIQ titles normalize only empty or absent subjects and retain malformed values for validation', () => {
  for (const subject of ['', null, undefined, '  Subject  ', ' ', 0, false, [], {}]) {
    const record = evidenceEnvelope('workiq', 'workiq/test', 'test', null, 'https://example.invalid/message', 'test');
    record.title = workiqTitle(subject);
    assert.equal(record.title, subject === '' || subject == null ? null : subject);
    if (subject == null || typeof subject === 'string') validateRecord(record);
    else assert.throws(() => validateRecord(record), error => error.code === 'invalid-record');
  }
});

test('WorkIQ collection normalizes root and reply titles without changing captured subjects in either lane', async t => {
  const { config, ledger } = setup(t), seed = channelConfig(config), root = channelRoot(seed);
  const parent = { ...message('parent'), subject: '' };
  const replies = [
    { ...message('empty'), subject: '' }, { ...message('null'), subject: null },
    message('absent'), { ...message('named'), subject: '  Reply title  ' },
    { ...message('space'), subject: ' ' }
  ].map(reply => ({ ...reply, replyToId: parent.id }));
  const original = structuredClone({ parent, replies });
  for (const lane of ['created', 'changed']) {
    const captured = [];
    const cursor = await collectWorkiq(config, config.window, async (record, payload) => {
      captured.push(ledger.evidence(record, payload, `title-${lane}`));
    }, async path => {
      if (path === principalPath) return principal(config);
      const pathname = new URL(path, 'https://scope.invalid').pathname;
      if (pathname === root) return { value: [parent] };
      assert.equal(pathname, `${root}/parent/replies`);
      return { value: replies };
    }, lane);
    assert.deepEqual(captured.map(record => record.title), [null, null, null, null, '  Reply title  ', ' ']);
    assert.equal(cursor.coverage[0].messagesExamined, 6);
    for (const record of captured) {
      const raw = record.fields.message;
      const payload = { message: raw, parentContext: raw.id === parent.id ? null : parent };
      assert.equal(record.capture.sha256, hash(json(payload)));
      assert.deepEqual(raw, raw.id === parent.id ? original.parent : original.replies.find(reply => reply.id === raw.id));
    }
  }
  assert.deepEqual({ parent, replies }, original);
});

test('WorkIQ related reads normalize titles without changing source payloads', async t => {
  const { config, root } = setup(t), seed = channelConfig(config);
  config.runtime.cliPath = process.execPath;
  config.runtime.workiqPluginDirectory = root;
  const { session } = workiqLifecycle();
  let current, reads, disconnects = 0;
  session.disconnect = async () => { disconnects++; };
  session.rpc.tools.execute = async ({ name, arguments: args }) => {
    assert.equal(name, 'workiq-fetch');
    const path = args.entityUrls[0]; reads.push(path);
    const data = path === principalPath ? principal(config) : current;
    return { resultType: 'success', textResultForLlm: json({ results: [{ statusCode: 200, data }] }) };
  };
  t.mock.method(CopilotClient.prototype, 'start', async () => {});
  t.mock.method(CopilotClient.prototype, 'stop', async () => {});
  t.mock.method(CopilotClient.prototype, 'createSession', async () => session);
  const subjects = ['', null, undefined, '  Related title  ', ' '];
  for (const subject of subjects) {
    current = { ...message('related'), ...(subject === undefined ? {} : { subject }) };
    reads = [];
    const path = `${channelRoot(seed)}/parent/replies/related?$select=${messageSelect}`;
    const { record, payload } = await readRelatedWorkiq(config,
      { id: current.id, seed, parent: 'parent', path }, new Budget(config.limits));
    validateRecord(record);
    assert.equal(record.title, subject === '' || subject == null ? null : subject);
    assert.deepEqual(payload, { message: current });
    assert.deepEqual(record.fields.message, current);
    assert.deepEqual(reads, [principalPath, path]);
  }
  assert.equal(disconnects, subjects.length);
});

test('WorkIQ tracked revisits normalize titles while preserving source subjects and revision hashes', async t => {
  const { config, ledger } = setup(t), seed = channelConfig(config);
  config.schedule.changedEvidencePolicy = 'tracked-open-and-area-changed';
  const subjects = ['', null, undefined, '  Updated title  ', ' '];
  const updates = subjects.map((subject, index) => ({
    ...message(`tracked-${index}`), etag: '2', ...(subject === undefined ? {} : { subject })
  }));
  for (const update of updates) {
    const record = evidenceEnvelope('workiq', `workiq/${seed.teamId}/${seed.channelId}`,
      update.id, '1', seed.url, 'generic unit fixture');
    record.scopeId = `workiq:${seed.id}`; record.title = 'Previous title';
    const evidence = ledger.evidence(record, { message: { ...update, etag: '1', subject: record.title } }, 'initial');
    ledger.put(review(evidence));
  }
  const result = await revisitTracked(config, ledger, { workiq: async path => {
    if (path === principalPath) return principal(config);
    const id = new URL(path, 'https://scope.invalid').pathname.split('/').at(-1);
    return structuredClone(updates.find(update => update.id === id));
  } });
  assert.equal(result[0].state, 'complete');
  assert.equal(result[0].itemsRevisited, subjects.length);
  for (const record of ledger.latestEvidence()) {
    const update = updates.find(message => message.id === record.source.recordId);
    assert.equal(record.title, update.subject === '' || update.subject == null ? null : update.subject);
    assert.deepEqual(record.fields.message, update);
    assert.equal(record.capture.sha256, hash(json({ message: update })));
    assert.equal(ledger.trackedState(record).state, 'current');
  }
});

test('WorkIQ paging rejects scope escape and cycles; item exhaustion preserves partial evidence and cursor', async t => {
  const { config, ledger } = setup(t), seed = channelConfig(config), root = channelRoot(seed);
  config.sources.ado.enabled = false; config.limits.maxItems = 1;
  assert.throws(() => nextWorkiqPage(config, '/teams/other/channels/other/messages?$skiptoken=x', root), /escaped/);
  assert.throws(() => nextWorkiqPage(config, 'https://unapproved.invalid/page', root), /authority/);
  const reader = async path => path === principalPath ? principal(config) :
    new URL(path, 'https://scope.invalid').pathname === root ? { value: [message('one'), message('two')] } : { value: [] };
  const results = await collect(config, ledger, { adapters: {
    workiq: (c, w, emit) => collectWorkiq(c, w, emit, reader)
  } });
  assert.equal(results.find(r => r.source === 'workiq').state, 'partial');
  assert.equal(ledger.all('evidence').length, 1);
  assert.equal(ledger.cursor('workiq:created'), null);
  config.limits.maxItems = 100;
  await assert.rejects(collectWorkiq(config, config.window, async () => {}, async path =>
    path === principalPath ? principal(config) : { value: [], '@odata.nextLink': path }), /cycle/);
});

test('one-level follow-up deduplicates links, does not recurse and leaves excess work pending', async t => {
  const { config, ledger } = setup(t);
  config.followUp = { maxDepth: 1, maxItems: 1, maxToolCalls: 2 };
  const root = addEvidence(ledger, '1', '1');
  root.links = [2, 2, 3].map(id => ({ url: `https://dev.azure.com/office/OC/_workitems/edit/${id}` }));
  let calls = 0;
  const result = await followRelated(config, ledger, [root], config.window, { ado: async (c, id, budget) => {
    calls++; budget.call(); budget.call();
    const record = adoRecord(adoItem(Number(id)), 'mocked follow-up', now());
    record.source.provenance = 'synthetic';
    record.links = [{ url: 'https://dev.azure.com/office/OC/_workitems/edit/4', relation: 'related',
      evidenceId: null, access: 'not-followed-out-of-scope' }];
    return { record, payload: { synthetic: id } };
  } });
  assert.equal(calls, 1); assert.equal(result.state, 'partial');
  assert.equal(report(ledger).summary.newCohortIds.length, 1);
  assert.equal(report(ledger).relatedEvidenceIds.length, 1);
  assert.ok(ledger.status().discoveries.some(d => d.state === 'pending' && d.url.endsWith('/3')));
  assert.ok(!ledger.status().discoveries.some(d => d.url.endsWith('/4')));
});

test('tracked scope disappearance requires reconciliation without changing cohort counts', async t => {
  const { config, ledger } = setup(t);
  config.schedule.changedEvidencePolicy = 'tracked-open-and-area-changed';
  const evidence = addEvidence(ledger); ledger.put(review(evidence));
  const result = await revisitTracked(config, ledger, { ado: async () => {
    throw new PilotError('blocked-scope', 'Synthetic item absent from approved area');
  } });
  assert.equal(result[0].state, 'complete');
  assert.equal(ledger.trackedState(evidence).state, 'reconciliation-required');
  assert.equal(report(ledger).summary.newCohortIds.length, 1);
});

test('tracked fixed revision blocks a previously prepared assignment', async t => {
  const { config, ledger, job, evidence } = await fixture(t, 'authenticated-source');
  config.schedule.changedEvidencePolicy = 'tracked-open-and-area-changed';
  await revisitTracked(config, ledger, { ado: async () => {
    const item = adoItem(1, 2); item.fields['System.State'] = 'Resolved';
    return { record: adoRecord(item, 'mocked tracked revisit', now()), payload: item };
  } });
  assert.equal(ledger.trackedState(evidence).state, 'reconciliation-required');
  config.activation.dispatch = true; config.limits.maxAiCreditsPerSession = 1;
  await assert.rejects(dispatch(config, ledger, job.id), /reconciliation|New source evidence/);
});

test('Shanghai daily wake uses 01:00 UTC and previous complete UTC cohort', () => {
  const schedule = configAt('pilot.example.json').schedule;
  assert.equal(nextDailyWake(schedule, new Date('2026-10-09T00:59:00Z')).toISOString(), '2026-10-09T01:00:00.000Z');
  assert.equal(nextDailyWake(schedule, new Date('2026-10-09T01:00:00Z')).toISOString(), '2026-10-10T01:00:00.000Z');
  assert.deepEqual(previousUtcDay(new Date('2026-10-09T01:00:00Z')), {
    start: '2026-10-08T00:00:00.000Z', end: '2026-10-09T00:00:00.000Z'
  });
});

test('daily assignment cap persists across connection restart and ignores duplicate prepares', async t => {
  const { config, ledger, repo } = await fixture(t);
  const budget = { bucket: json(config.window), maxNew: 2 };
  const prepare = (store, id) => {
    const evidence = addEvidence(store, id);
    const investigation = review(evidence); investigation.repoIds = [repo.id]; store.put(investigation);
    return store.prepare(makeAssignment(config, investigation, repo.id, 'rca-only'), budget);
  };
  const second = prepare(ledger, '2');
  assert.equal(ledger.prepare(ledger.get('assignment', second.id), budget).id, second.id);
  prepare(ledger, '3');
  const reopened = new Ledger(config.stateDirectory);
  try { assert.throws(() => prepare(reopened, '4'), /Daily new-assignment budget/); }
  finally { reopened.close(); }
});

test('WorkIQ runtime diagnostics preserve known safe failure phase and RPC code', () => {
  const raw = Object.assign(new Error('Request session.mcp.startServer failed with message: MCP server "workiq" requires authentication'), { code: -32603 });
  const error = workiqRuntimeError(raw, 'mcp-start');
  assert.equal(error.code, 'blocked-auth');
  assert.match(error.message, /mcp-start failed; RPC code -32603/);
  assert.match(error.message, /configured WorkIQ server requires authentication/);
  assert.match(error.message, /Inspect the matching host authentication context/);
});

test('WorkIQ runtime diagnostics never echo unknown authentication error content', () => {
  const error = workiqRuntimeError(new Error('Authentication failed; secret=synthetic-never-echo'), 'fetch');
  assert.equal(error.code, 'blocked-auth');
  assert.match(error.message, /fetch failed/);
  assert.doesNotMatch(error.message, /synthetic-never-echo|secret=/);
  assert.equal(workiqRuntimeError(new Error('Failed at port 4030'), 'mcp-start').code, 'blocked-runtime');
  const known = new PilotError('blocked-scope', 'Approved boundary violation');
  assert.equal(workiqRuntimeError(known, 'fetch'), known);
});

test('WorkIQ connected server is not started again; tools/list readiness precedes initialization', async () => {
  const { session, calls } = workiqLifecycle();
  await prepareWorkiq(session);
  assert.deepEqual(calls, ['status', 'tools/list', 'initialize']);
});
test('WorkIQ pending active transport is not raced with another start', async () => {
  const { session, calls } = workiqLifecycle({ status: 'pending', running: true });
  await assert.rejects(prepareWorkiq(session), e => e.code === 'blocked-readiness');
  assert.deepEqual(calls, ['status', 'running']);
});
test('WorkIQ not-yet-running server starts at most once and verifies status and tools', async () => {
  const { session, calls } = workiqLifecycle({ status: 'pending' });
  await prepareWorkiq(session);
  assert.deepEqual(calls, ['status', 'running', 'start', 'status', 'tools/list', 'initialize']);
});
test('WorkIQ enabled effective registration with not_configured live state starts once by name', async () => {
  const { session, calls } = workiqLifecycle({ status: 'not_configured' });
  const diagnostics = {};
  await prepareWorkiq(session, diagnostics);
  assert.deepEqual(calls, ['status', 'running', 'start', 'status', 'tools/list', 'initialize']);
  assert.equal(diagnostics.phase, 'ready');
  assert.deepEqual(diagnostics.calls, {
    listConfigured: 2, isServerRunning: 1, startServer: 1, listTools: 1, initializeAndValidate: 1
  });
  assert.deepEqual(diagnostics.observations.map(o => [o.serverName, o.enabled, o.liveStatus]),
    [['workiq', true, 'not_configured'], ['workiq', true, 'connected']]);
});
test('WorkIQ still not_configured after one start stops without polling or discovery', async () => {
  const { session, calls } = workiqLifecycle({ status: 'not_configured', afterStart: 'not_configured' });
  const diagnostics = {};
  await assert.rejects(prepareWorkiq(session, diagnostics), e => e.code === 'blocked-readiness');
  assert.deepEqual(calls, ['status', 'running', 'start', 'status']);
  assert.equal(diagnostics.calls.startServer, 1);
  assert.equal(diagnostics.calls.listTools, 0);
});
test('WorkIQ not_configured with active transport cannot trigger another start', async () => {
  const { session, calls } = workiqLifecycle({ status: 'not_configured', running: true });
  await assert.rejects(prepareWorkiq(session), e => e.code === 'blocked-readiness');
  assert.deepEqual(calls, ['status', 'running']);
});
test('WorkIQ missing, disabled, or differently keyed registration never triggers activation', async () => {
  for (const servers of [[], [{ name: 'workiq', enabled: false, live: { status: 'not_configured' } }],
    [{ name: 'synthetic-other-key', enabled: true, live: { status: 'not_configured' } }]]) {
    const { session, calls } = workiqLifecycle();
    session.rpc.mcp.listConfigured = async () => { calls.push('status'); return { servers }; };
    const diagnostics = {};
    await assert.rejects(prepareWorkiq(session, diagnostics), e => e.code === 'blocked-runtime');
    assert.deepEqual(calls, ['status']);
    assert.doesNotMatch(JSON.stringify(diagnostics), /synthetic-other-key/);
  }
});
test('WorkIQ diagnostics project registration without raw plugin fields, errors or tool definitions', async () => {
  const { session } = workiqLifecycle();
  session.rpc.mcp.listConfigured = async () => ({ servers: [{
    name: 'workiq', enabled: true, source: 'plugin', sourcePlugin: 'workiq',
    sourcePluginVersion: 'synthetic-secret', displayName: 'synthetic-secret',
    live: { status: 'connected', error: 'synthetic-secret' }
  }] });
  session.rpc.mcp.listTools = async () => ({ tools: [{ name: 'fetch', description: 'synthetic-secret' }] });
  const diagnostics = {};
  await prepareWorkiq(session, diagnostics);
  assert.equal(diagnostics.observations[0].pluginSourceMatches, true);
  assert.doesNotMatch(JSON.stringify(diagnostics), /synthetic-secret/);
});
test('WorkIQ post-start pending state cannot reach tool execution', async () => {
  const { session, calls } = workiqLifecycle({ status: 'pending', afterStart: 'pending' });
  await assert.rejects(prepareWorkiq(session), e => e.code === 'blocked-readiness');
  assert.deepEqual(calls, ['status', 'running', 'start', 'status']);
});
test('WorkIQ needs-auth stops without start, discovery or retries', async () => {
  const { session, calls } = workiqLifecycle({ status: 'needs-auth' });
  await assert.rejects(prepareWorkiq(session), e => e.code === 'blocked-auth');
  assert.deepEqual(calls, ['status']);
});
test('WorkIQ connected status without fetch discovery is not principal readiness', async () => {
  const { session, calls } = workiqLifecycle({ tools: [] });
  await assert.rejects(prepareWorkiq(session), e => e.code === 'blocked-readiness');
  assert.deepEqual(calls, ['status', 'tools/list']);
});
test('WorkIQ start authentication failure never proceeds to tools/list or retries', async () => {
  const { session, calls } = workiqLifecycle({ status: 'pending',
    startError: Object.assign(new Error('MCP server "workiq" requires authentication'), { code: -32603 }) });
  await assert.rejects(prepareWorkiq(session), e => e.code === 'blocked-auth' && /mcp-start.*-32603/.test(e.message));
  assert.deepEqual(calls, ['status', 'running', 'start']);
});

test('WorkIQ tools/list 401 is an OAuth challenge, not an inferred scope or principal failure', async () => {
  const { session, calls } = workiqLifecycle();
  session.rpc.mcp.listTools = async () => {
    calls.push('tools/list');
    throw Object.assign(new Error('Request session.mcp.listTools failed with message: Error: MCP OAuth challenge required (HTTP 401)'), { code: -32603 });
  };
  await assert.rejects(prepareWorkiq(session), error => {
    assert.equal(error.code, 'blocked-auth');
    assert.match(error.message, /mcp-tools-list failed; RPC code -32603/);
    assert.match(error.message, /OAuth challenge \(HTTP 401\)/);
    assert.match(error.message, /\/mcp auth workiq/);
    assert.doesNotMatch(error.message, /missing scopes|expired token|consent denied|principal mismatch/);
    return true;
  });
  assert.deepEqual(calls, ['status', 'tools/list']);
});

test('WorkIQ standalone probe only discovers tools and closes its own runtime', async () => {
  const { session, calls } = workiqLifecycle();
  session.disconnect = async () => { calls.push('disconnect'); };
  const result = await probeWorkiq({
    start: async () => { calls.push('client-start'); },
    createSession: async options => {
      assert.equal(options.mcpOAuthTokenStorage, 'persistent');
      assert.equal(options.enableConfigDiscovery, false);
      assert.deepEqual(options.pluginDirectories, ['synthetic-plugin']);
      assert.deepEqual(options.onPermissionRequest({}), { kind: 'denied-by-rules' });
      return session;
    },
    stop: async () => { calls.push('stop'); return []; }
  }, ['synthetic-plugin']);
  assert.equal(result.status, 'discovery-ready');
  assert.equal(result.phase, 'discovery-complete');
  assert.match(result.discovery, /principal and collection still unverified/);
  assert.deepEqual(calls, ['client-start', 'status', 'tools/list', 'initialize', 'disconnect', 'stop']);
});

test('WorkIQ standalone probe preserves safe start failure without retry', async () => {
  const { session, calls } = workiqLifecycle({ status: 'pending',
    startError: Object.assign(new Error('MCP server "workiq" requires authentication'), { code: -32603 }) });
  session.disconnect = async () => { calls.push('disconnect'); };
  const result = await probeWorkiq({
    start: async () => {}, createSession: async () => session,
    stop: async () => { calls.push('stop'); return []; }
  }, ['synthetic-plugin']);
  assert.equal(result.status, 'blocked');
  assert.equal(result.error.code, 'blocked-auth');
  assert.match(result.error.message, /mcp-start failed; RPC code -32603/);
  assert.deepEqual(calls, ['status', 'running', 'start', 'disconnect', 'stop']);
});

test('WorkIQ standalone dormant registration reports subsequent auth failure at its actual phase', async () => {
  const { session, calls } = workiqLifecycle({ status: 'not_configured',
    startError: Object.assign(new Error('MCP server "workiq" requires authentication'), { code: -32603 }) });
  session.disconnect = async () => { calls.push('disconnect'); };
  const result = await probeWorkiq({
    start: async () => {}, createSession: async () => session,
    stop: async () => { calls.push('stop'); return []; }
  }, ['synthetic-plugin']);
  assert.equal(result.status, 'blocked');
  assert.equal(result.phase, 'mcp-start');
  assert.equal(result.error.code, 'blocked-auth');
  assert.equal(result.lifecycle.observations[0].liveStatus, 'not_configured');
  assert.equal(result.lifecycle.calls.startServer, 1);
  assert.equal(result.lifecycle.calls.listTools, 0);
  assert.match(result.error.message, /RPC code -32603/);
  assert.deepEqual(calls, ['status', 'running', 'start', 'disconnect', 'stop']);
});

test('WorkIQ standalone probe suppresses raw exception names and returned cleanup errors', async () => {
  const result = await probeWorkiq({
    start: async () => { throw Object.assign(new Error('synthetic-secret'), { name: 'synthetic-secret' }); },
    stop: async () => [new Error('synthetic-secret')]
  }, ['synthetic-plugin']);
  assert.equal(result.status, 'blocked');
  assert.equal(result.phase, 'client-start');
  assert.equal(result.stopError.code, 'blocked-runtime');
  assert.doesNotMatch(JSON.stringify(result), /synthetic-secret/);
});

test('WorkIQ standalone output isolation discards raw stdout and stderr', t => {
  const root = mkdtempSync(join(tmpdir(), 'workiq-repro-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const child = join(root, 'synthetic-child.mjs');
  writeFileSync(child, `console.log('synthetic-secret'); console.error('synthetic-secret'); process.send({status:'not-probed'});`);
  const moduleUrl = pathToFileURL(join(process.cwd(), 'scripts', 'Workiq-Auth-Repro.mjs')).href;
  const wrapper = join(root, 'wrapper.mjs');
  writeFileSync(wrapper, `import { isolatedReport } from ${JSON.stringify(moduleUrl)}; console.log(JSON.stringify(await isolatedReport([], ${JSON.stringify(child)})));`);
  const result = spawnSync(process.execPath, [wrapper], { encoding: 'utf8', timeout: 10000 });
  assert.equal(result.status, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { status: 'not-probed' });
  assert.equal(result.stderr, '');
  assert.doesNotMatch(result.stdout, /synthetic-secret/);
});
