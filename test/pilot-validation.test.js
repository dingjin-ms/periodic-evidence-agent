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

test('native test-rebuilt outputs stay mutable while other generated outputs remain verified', async t => {
  const ctx = await stagedValidationFixture(t, { parallelOutputs: true });
  ctx.repo.validationGates[0].testRebuiltOutputPaths = ['.pilot/output-0'];
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  assert.equal(prepared.staged.error, undefined);
  assert.ok(!prepared.staged.outputs.paths.includes('.pilot/output-0'));
  assert.ok(prepared.staged.outputs.paths.includes('.pilot/output-1'));
  const execute = async (executable, args, cwd, timeout, env) => {
    if (env.PILOT_VALIDATION_STAGE === 'test') {
      rmSync(join(cwd, '.pilot/output-0'), { recursive: true });
      mkdirSync(join(cwd, '.pilot/output-0'));
      writeFileSync(join(cwd, '.pilot/output-0/compiled.js'), 'fresh candidate compilation\n');
    }
    return ctx.execute(executable, args, cwd, timeout, env);
  };
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  writeFileSync(join(prepared.staged.workspace, '.pilot/output-1/compiled.js'), 'tampered\n');
  const verification = await verifyPreparedOutputs(prepared.staged.receiptPath,
    prepared.staged.workspace, prepared.staged.outputs);
  assert.equal(verification.valid, false);
  ctx.repo.validationGates[0].testRebuiltOutputPaths = ['.pilot/dependencies'];
  const invalid = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  assert.equal(invalid.staged.error.code, 'blocked-config');
});
test('cold authenticated preparation runs broker once and cache hits skip it', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  assert.deepEqual(ctx.calls, [
    'fingerprint', 'authentication', 'dependencies', 'compile'
  ]);
  assert.equal(prepared.staged.timings.find(stage =>
    stage.id === 'authentication').cache, 'miss');
  const reloaded = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  assert.equal(reloaded.staged.receiptPath, prepared.staged.receiptPath);
  assert.equal(ctx.calls.filter(stage => stage === 'authentication').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
});
test('authentication preflight returns a safe action before a cold dispatch', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  ctx.behavior.authenticationPreflight = 'interactive-sign-in-required';
  writeFileSync(join(ctx.repo.referenceCheckout, '.yarnrc.yml'),
    'npmRegistryServer: "https://example.invalid/wrong-revision/"\n');
  const actions = await preflightValidationAuthentication(
    ctx.config, ctx.repo, ctx.isolated.baseRevision, ctx.execute);
  assert.equal(actions.length, 1);
  assert.equal(actions[0].state, 'action-required-auth');
  assert.equal(actions[0].reason, 'interactive-sign-in-required');
  assert.equal(actions[0].requiresInstallApproval, false);
  assert.equal(actions[0].tokenRequested, false);
  assert.deepEqual(actions[0].remediation.args.slice(0, 4), [
    'run', 'setup:validation-auth', '--', '-Workspace'
  ]);
  assert.match(actions[0].remediation.args[4],
    new RegExp(`pv[\\\\/]a[\\\\/].+[\\\\/]w$`));
  const exactConfig = readFileSync(
    join(actions[0].remediation.args[4], '.yarnrc.yml'), 'utf8');
  assert.match(exactConfig, /AugmentationLoop/);
  assert.doesNotMatch(exactConfig, /wrong-revision/);
  const remediationWorkspace = actions[0].remediation.args[4];
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  assert.notEqual(remediationWorkspace,
    join(dirname(prepared.staged.dependencyReceiptPath), 'w'));
  assert.deepEqual(ctx.calls, [
    'fingerprint', 'authentication-check',
    'fingerprint', 'authentication', 'dependencies', 'compile'
  ]);
});
test('trusted dependency cache hits skip authentication checks', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  ctx.calls.length = 0;
  ctx.behavior.authenticationPreflight = 'interactive-sign-in-required';
  const actions = await preflightValidationAuthentication(
    ctx.config, ctx.repo, ctx.isolated.baseRevision, ctx.execute);
  assert.deepEqual(actions, []);
  assert.deepEqual(ctx.calls, ['fingerprint']);
  rmSync(join(dirname(prepared.staged.dependencyReceiptPath), 'w'),
    { recursive: true, force: true });
  ctx.calls.length = 0;
  const compileOnlyActions = await preflightValidationAuthentication(
    ctx.config, ctx.repo, ctx.isolated.baseRevision, ctx.execute);
  assert.deepEqual(compileOnlyActions, []);
  assert.deepEqual(ctx.calls, ['fingerprint']);
  rmSync(prepared.staged.workspace, { recursive: true, force: true });
  ctx.calls.length = 0;
  const missingSnapshotActions = await preflightValidationAuthentication(
    ctx.config, ctx.repo, ctx.isolated.baseRevision, ctx.execute);
  assert.equal(missingSnapshotActions[0].state, 'action-required-auth');
  assert.deepEqual(ctx.calls, ['fingerprint', 'authentication-check']);
});
test('forced recovery preflight checks authentication without deleting trusted caches', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  assert.ok(prepared.staged.receiptPath);
  ctx.calls.length = 0;
  ctx.behavior.authenticationPreflight = 'credential-validation-failed';
  const actions = await preflightValidationAuthentication(
    ctx.config, ctx.repo, ctx.isolated.baseRevision, ctx.execute, { force: true });
  assert.equal(actions[0].reason, 'credential-validation-failed');
  assert.equal(actions[0].requiresInstallApproval, false);
  assert.ok(existsSync(prepared.staged.receiptPath));
  assert.ok(existsSync(prepared.staged.dependencyReceiptPath));
  assert.deepEqual(ctx.calls, ['fingerprint', 'authentication-check']);
});

test('authentication preflight preserves an in-progress dependency workspace', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  let checked = false;
  const execute = async (executable, args, cwd, timeout, env) => {
    const output = await ctx.execute(executable, args, cwd, timeout, env);
    if (env.PILOT_VALIDATION_STAGE === 'dependencies') {
      const manifest = join(cwd, 'package.json');
      const original = readFileSync(manifest, 'utf8');
      await preflightValidationAuthentication(
        ctx.config, ctx.repo, ctx.isolated.baseRevision, ctx.execute);
      assert.equal(readFileSync(manifest, 'utf8'), original);
      checked = true;
    }
    return output;
  };
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, execute);
  assert.equal(prepared.staged.error, undefined);
  assert.equal(checked, true);
});

test('local cache-miss authentication recovery stays prepared and never launches a model', async t => {
  const ctx = await stagedValidationFixture(t, {
    authentication: true, provenance: 'authenticated-source'
  });
  ctx.repo.flights = { proposerExecutor: 'local' };
  ctx.config.activation.dispatch = true;
  ctx.config.limits.maxAiCreditsPerSession = 1;
  const investigation = { ...ctx.investigation, id: `${ctx.investigation.id}-auth-dispatch` };
  ctx.ledger.put(investigation);
  ctx.job = ctx.ledger.prepare(makeAssignment(ctx.config, investigation, ctx.repo.id, 'defect-fix'));
  let checks = 0;
  const action = await dispatch(ctx.config, ctx.ledger, ctx.job.id, {
    preflightValidationAuthentication: async (config, repo, revision, execute, options) => {
      if (++checks === 1) return [];
      assert.deepEqual(options, { force: true });
      return [{ state: 'action-required-auth', reason: 'credential-validation-failed' }];
    },
    prepareValidation: async () => ({
      staged: { error: { code: 'blocked-auth', message: 'Synthetic late authentication failure' } }
    }),
    runModel: () => assert.fail('Late authentication recovery must not launch a model'),
    runValidation: () => assert.fail('Late authentication recovery must not run tests')
  });
  assert.equal(action.state, 'action-required-auth');
  assert.equal(checks, 2);
  assert.equal(ctx.ledger.job(ctx.job.id).state, 'prepared');
  assert.equal(ctx.ledger.all('workerResult').length, 0);
  assert.equal(ctx.ledger.status().operations.length, 0);
});

test('local late authentication recovery is bounded when no remediation action is available', async t => {
  const ctx = await stagedValidationFixture(t, {
    authentication: true, provenance: 'authenticated-source'
  });
  ctx.repo.flights = { proposerExecutor: 'local' };
  ctx.config.activation.dispatch = true;
  ctx.config.limits.maxAiCreditsPerSession = 1;
  const investigation = { ...ctx.investigation, id: `${ctx.investigation.id}-auth-dispatch` };
  ctx.ledger.put(investigation);
  ctx.job = ctx.ledger.prepare(makeAssignment(ctx.config, investigation, ctx.repo.id, 'defect-fix'));
  let checks = 0, preparations = 0;
  await assert.rejects(dispatch(ctx.config, ctx.ledger, ctx.job.id, {
    preflightValidationAuthentication: async () => { checks++; return []; },
    prepareValidation: async () => {
      preparations++;
      return { staged: { error: { code: 'blocked-auth', message: 'Synthetic auth failure' } } };
    },
    runModel: () => assert.fail('Must not launch a model')
  }), error => error.code === 'blocked-auth');
  assert.equal(checks, 2);
  assert.equal(preparations, 1);
  assert.equal(ctx.ledger.job(ctx.job.id).state, 'prepared');
});

for (const boundary of ['preparation', 'client-start', 'session-create', 'unexpired']) {
  test(`standalone AL dispatch enforces its allocation at ${boundary}`, async t => {
    const ctx = await stagedValidationFixture(t, {
      authentication: true, provenance: 'authenticated-source'
    });
    ctx.repo.baseRef = ctx.isolated.baseRevision;
    ctx.repo.flights = { proposerExecutor: 'local' };
    ctx.config.activation.dispatch = true;
    ctx.config.limits.maxAiCreditsPerSession = 30;
    ctx.config.runtime.cliPath = process.execPath;
    ctx.config.runtime.authoringModel = 'gpt-6-luna';
    const investigation = { ...ctx.investigation, id: `${ctx.investigation.id}-allocation` };
    ctx.ledger.put(investigation);
    const job = ctx.ledger.prepare(makeAssignment(ctx.config, investigation, ctx.repo.id, 'defect-fix'));
    const started = Date.now();
    let time = started, preparations = 0, creations = 0, submissions = 0, disconnects = 0;
    t.mock.method(Date, 'now', () => time);
    const allocation = join(ctx.root, 'allocation.json');
    writeFileSync(allocation, JSON.stringify({
      format: 'al-e2e-model-allocation-v1', approvedBy: 'parent', model: 'gpt-6-luna',
      repoId: ctx.repo.id, baseRevision: ctx.repo.baseRef, runDirectory: ctx.root,
      maxTotalSessions: 30, priorActualSessions: 0, maxAdditionalSessions: 1,
      purposes: ['proposer'], allowPublication: true,
      deadlineAt: new Date(started + 1000).toISOString()
    }));
    bindAlModelExecution(ctx.config, alReference(allocation), ctx.root, 1, 'proposer');
    t.mock.method(CopilotClient.prototype, 'start', async () => {
      if (boundary === 'client-start') time += 1001;
    });
    t.mock.method(CopilotClient.prototype, 'stop', async () => {});
    t.mock.method(CopilotClient.prototype, 'createSession', async options => {
      creations++;
      assert.equal(options.model, 'gpt-6-luna');
      if (boundary === 'session-create') time += 1001;
      return {
        sendAndWait: async (_message, timeout) => {
          submissions++;
          assert.equal(timeout, 1000);
          await options.tools.find(tool => tool.name === 'pilot_finish').handler({
            outcome: 'investigated', findings: 'Synthetic allocation-bound SDK callback'
          });
        },
        disconnect: async () => { disconnects++; }
      };
    });
    const execution = dispatch(ctx.config, ctx.ledger, job.id, {
      preflightValidationAuthentication: async () => [],
      prepareValidation: async () => {
        preparations++;
        if (boundary === 'preparation') time += 1001;
        return {};
      },
      runValidation: () => assert.fail('No changes or native validation are authorized by this fixture'),
      pushBranch: () => assert.fail('No publication in this fixture'),
      createDraft: () => assert.fail('No publication in this fixture')
    });
    if (boundary === 'unexpired') assert.equal((await execution).outcome, 'investigated');
    else {
      await assert.rejects(execution, error => error.code === 'blocked-authorization');
      assert.equal(ctx.ledger.job(job.id).state, 'blocked');
      assert.equal(ctx.ledger.all('workerResult').at(-1).outcome, 'blocked');
    }
    assert.equal(preparations, 1);
    assert.equal(creations, ['session-create', 'unexpired'].includes(boundary) ? 1 : 0);
    assert.equal(submissions, boundary === 'unexpired' ? 1 : 0);
    assert.equal(disconnects, creations);
    assert.equal(ctx.ledger.status().operations.filter(row =>
      ['commit', 'push', 'draft-pr'].includes(row.kind)).length, 0);
  });
}

test('authentication preflight is singleflight and malformed evidence blocks', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  ctx.behavior.authenticationPreflight = 'provider-missing';
  ctx.behavior.authenticationCheckDelayMs = 20;
  const [left, right] = await Promise.all([
    preflightValidationAuthentication(
      ctx.config, ctx.repo, ctx.isolated.baseRevision, ctx.execute),
    preflightValidationAuthentication(
      ctx.config, ctx.repo, ctx.isolated.baseRevision, ctx.execute)
  ]);
  assert.equal(left[0].requiresInstallApproval, true);
  assert.deepEqual(right, left);
  assert.equal(ctx.calls.filter(stage => stage === 'authentication-check').length, 1);
  ctx.behavior.authenticationPreflight = 'invalid';
  await assert.rejects(preflightValidationAuthentication(
    ctx.config, ctx.repo, ctx.isolated.baseRevision, ctx.execute), error =>
    error.code === 'blocked-auth');
});
test('authentication failure blocks before dependency restore without retrying', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  ctx.behavior.failAuthentication = true;
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, {});
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'blocked-auth');
  assert.equal(result[0].attemptCount, 1);
  assert.deepEqual(ctx.calls, ['fingerprint', 'authentication']);
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.equal(artifact.output.exitCode, 'blocked-auth');
  assert.match(artifact.output.stderr, /Azure Artifacts authentication/);
  assert.deepEqual(artifact.output.authenticationFailure, {
    stage: 'authentication', reason: 'authentication-execution-failed',
    exitCode: 1, tokenRecorded: false
  });
  assert.doesNotMatch(artifact.output.stderr, /anonymous user/i);
  assert.equal(artifact.telemetry.preparationTimings.at(-1).id, 'authentication');
});
test('dependency restore authentication errors are classified as blocked-auth', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  ctx.behavior.failDependencyAuthentication = true;
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, {});
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'blocked-auth');
  assert.deepEqual(ctx.calls, ['fingerprint', 'authentication', 'dependencies']);
  assert.equal(result[0].attemptCount, 1);
});
test('auth-like test output remains a test failure rather than an auth blocker', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  ctx.behavior.failTestWithAuthenticationText = true;
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'failed');
  assert.equal(result[0].blockedReason, null);
  assert.equal(result[0].attemptCount, 1);
});
test('staged validation profile errors block without retrying or entering source repair', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  ctx.behavior.failTestWithProfileError = true;
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'validation-profile-error');
  assert.equal(result[0].attemptCount, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'test').length, 1);
});
test('authentication cannot modify the exact-revision source workspace', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  ctx.behavior.mutateDuringAuthentication = true;
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, {});
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'blocked-auth');
  assert.deepEqual(ctx.calls, ['fingerprint', 'authentication']);
});
test('authentication must emit controller-auditable non-secret evidence', async t => {
  const ctx = await stagedValidationFixture(t, { authentication: true });
  ctx.behavior.invalidAuthenticationEvidence = true;
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, {});
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'blocked-auth');
  assert.deepEqual(ctx.calls, ['fingerprint', 'authentication']);
});
test('failed test-only revision repairs without repeating dependency or compile stages', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  ctx.behavior.failTest = true;
  const failedRevision = await ctx.commit('test/behavior.test.js', 'fail\n', 'Add failing test');
  const failed = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    failedRevision, ctx.execute, rmSync, prepared);
  assert.equal(failed[0].status, 'failed');
  ctx.behavior.failTest = false;
  const repairedRevision = await ctx.commit('test/behavior.test.js', 'pass\n', 'Repair test');
  const passed = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    repairedRevision, ctx.execute, rmSync, prepared);
  assert.equal(passed[0].status, 'passed');
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'policy').length, 2);
  assert.equal(ctx.calls.filter(stage => stage === 'test').length, 2);
});
test('production-to-test rename cannot reuse a test-only compile receipt', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  renameSync(join(ctx.current.workspace, 'src', 'unused.js'),
    join(ctx.current.workspace, 'test', 'unused.js'));
  const gitArgs = args => command('git', ['-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false', ...args], ctx.current.workspace);
  await gitArgs(['add', '--all']);
  await gitArgs(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Move production source into tests']);
  const revision = (await gitArgs(['rev-parse', 'HEAD'])).stdout.trim();
  assert.equal((await gitArgs(['diff', '--name-only',
    prepared.staged.inputs.sourceRevision, revision])).stdout.trim(), 'test/unused.js');
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
});
test('production changes reuse dependencies while lockfile changes invalidate them', async t => {
  for (const [path, content, dependencyRuns] of [
    ['src/value.js', 'export const value = 2;\n', 1],
    ['fixture.lock', 'changed\n', 2]
  ]) {
    await t.test(path, async t => {
      const ctx = await stagedValidationFixture(t);
      const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
        ctx.isolated.baseRevision, ctx.execute);
      const revision = await ctx.commit(path, content, `Change ${path}`);
      const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
        revision, ctx.execute, rmSync, prepared);
      const artifacts = result[0].artifactRefs.map(artifact =>
        JSON.parse(readFileSync(artifact, 'utf8')));
      assert.equal(result[0].status, 'passed', json({
        changedPath: path,
        preparationFailure: prepared.staged.error ? prepared.staged : null,
        validation: result[0], artifacts
      }));
      assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, dependencyRuns);
      assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
      assert.equal(artifacts[0].telemetry.dependencyCache,
        dependencyRuns === 1 ? 'hit' : 'miss');
    });
  }
});
test('profile and toolchain drift invalidate prepared validation', async t => {
  for (const drift of ['profile', 'toolchain']) {
    const ctx = await stagedValidationFixture(t);
    const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, ctx.execute);
    if (drift === 'profile') {
      writeFileSync(ctx.profilePath, `${readFileSync(ctx.profilePath, 'utf8')}\n`);
      ctx.repo.validationGates[0].profileSha256 = hash(readFileSync(ctx.profilePath));
    } else ctx.behavior.toolchain = '2';
    const revision = await ctx.commit('test/behavior.test.js', `${drift}\n`, `${drift} drift`);
    const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
      revision, ctx.execute, rmSync, prepared);
    assert.equal(result[0].status, 'passed');
    assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 2);
    assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
  }
});
test('corrupt prepared receipt fails closed to full preparation', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  const receiptPath = prepared.staged.receiptPath;
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  receipt.inputs.lockfileSha256 = '0'.repeat(64);
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const revision = await ctx.commit('test/behavior.test.js', 'repair\n', 'Repair after corruption');
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
});
