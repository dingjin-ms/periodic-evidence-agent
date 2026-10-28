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

test('corrupt dependency snapshot receipt reruns install and compile', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  const receiptPath = prepared.staged.dependencyReceiptPath;
  const receipt = JSON.parse(readFileSync(receiptPath, 'utf8'));
  receipt.inputs.lockfileSha256 = '0'.repeat(64);
  writeFileSync(receiptPath, JSON.stringify(receipt));
  const revision = await ctx.commit('test/behavior.test.js', 'repair\n',
    'Repair after dependency corruption');
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed',
    readFileSync(result[0].artifactRefs[0], 'utf8'));
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 2);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
});
test('test-only repair reuses an intact compile snapshot when the dependency workspace is damaged',
  async t => {
    const ctx = await stagedValidationFixture(t);
    const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, ctx.execute);
    rmSync(join(dirname(prepared.staged.dependencyReceiptPath), 'w', '.git'),
      { recursive: true, force: true });
    const revision = await ctx.commit('test/behavior.test.js', 'repair\n',
      'Repair test after dependency workspace damage');
    const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
      revision, ctx.execute, rmSync, prepared);
    assert.equal(result[0].status, 'passed');
    assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
    assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
  });
test('cache loading reuses an intact compile snapshot without reading a damaged dependency workspace',
  async t => {
    const ctx = await stagedValidationFixture(t);
    const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, ctx.execute);
    rmSync(join(dirname(prepared.staged.dependencyReceiptPath), 'w', '.git'),
      { recursive: true, force: true });
    const reloaded = await prepareValidation(ctx.config, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, ctx.execute);
    assert.equal(reloaded.staged.receiptPath, prepared.staged.receiptPath);
    assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
    assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
  });
test('damaged dependency workspace reruns install and compile when production changes', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  rmSync(join(dirname(prepared.staged.dependencyReceiptPath), 'w', '.git'),
    { recursive: true, force: true });
  const revision = await ctx.commit('src/value.js', 'export const value = 2;\n',
    'Change production after dependency workspace damage');
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed',
    readFileSync(result[0].artifactRefs[0], 'utf8'));
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 2);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
});
test('parallel prepared-output fingerprint detects cache mutation', async t => {
  const ctx = await stagedValidationFixture(t, { parallelOutputs: true });
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  writeFileSync(join(prepared.staged.workspace, '.pilot', 'output-3', 'compiled.js'),
    'mutated\n');
  const revision = await ctx.commit('test/behavior.test.js', 'repair\n',
    'Repair after compiled output mutation');
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, ctx.execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
});
test('existing-only compile recovery preserves invalid outputs without rebuilding', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  const warm = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, { requireExistingCompileSnapshots: true });
  assert.equal(warm.staged.cache, 'hit');
  const receiptPath = prepared.staged.receiptPath;
  const receipt = readFileSync(receiptPath, 'utf8');
  const file = join(prepared.staged.workspace, 'extra', 'node_modules', 'fixture', 'package.json');
  writeFileSync(file, '{"version":"unverified"}\n');
  const recovered = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, { requireExistingCompileSnapshots: true });
  assert.equal(recovered.staged.error.code, 'prepared-cache-corrupt');
  const validation = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute, rmSync, recovered);
  assert.equal(validation[0].status, 'blocked');
  assert.equal(validation[0].blockedReason, 'prepared-cache-corrupt');
  assert.match(recovered.staged.error.message, /existing compile snapshot did not qualify/);
  assert.equal(readFileSync(file, 'utf8'), '{"version":"unverified"}\n');
  assert.equal(readFileSync(receiptPath, 'utf8'), receipt);
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
});
test('test-only profile continuation rejects content drift in either profile', t => {
  const root = mkdtempSync(join(tmpdir(), 'profile-binding-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = readFileSync('scripts/validation/1js-sdx-excel-integration.ps1', 'utf8');
  const preparationChange = original.replace(
    "Invoke-Checked $yarn workspace '@1js/jest-config' build",
    "Invoke-Checked $yarn workspace '@1js/jest-config' different-build");
  assert.notEqual(preparationChange, original);
  const corrected = preparationChange.replace(
    '--runInBand --passWithNoTests=false',
    '--runInBand --passWithNoTests=false --no-cache');
  assert.notEqual(corrected, preparationChange);
  const previous = { profilePath: join(root, 'previous.ps1'), profileSha256: hash(original) };
  const next = { profilePath: join(root, 'next.ps1'), profileSha256: hash(corrected) };
  writeFileSync(previous.profilePath, original);
  writeFileSync(next.profilePath, corrected);
  assert.throws(() => verifyTestOnlyProfileChange(previous, next), /only the final test runner/);
  writeFileSync(previous.profilePath, preparationChange);
  assert.throws(() => verifyTestOnlyProfileChange(previous, next), /unchanged content-bound profiles/);
  previous.profileSha256 = hash(preparationChange);
  writeFileSync(next.profilePath, `${corrected}\n`);
  assert.throws(() => verifyTestOnlyProfileChange(previous, next), /unchanged content-bound profiles/);
});
test('test-only profile continuation verifies outputs and preserves the original receipt', async t => {
  const ctx = await stagedValidationFixture(t);
  const oldGate = ctx.repo.validationGates[0];
  const original = readFileSync(oldGate.profilePath, 'utf8') +
    "    if ($stage -in @('all', 'test')) {\n        old runner\n    }\n}\nfinally {\n    Pop-Location\n}\n";
  writeFileSync(oldGate.profilePath, original);
  oldGate.profileSha256 = hash(readFileSync(oldGate.profilePath));
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  const oldReceipt = readFileSync(prepared.staged.receiptPath, 'utf8');
  const profilePath = join(ctx.config.stateDirectory, 'corrected-profile.mjs');
  writeFileSync(profilePath, original.replace('old runner', 'new runner'));
  const nextGate = { ...oldGate, profilePath, profileSha256: hash(readFileSync(profilePath)) };
  const receiptPath = join(ctx.config.stateDirectory, 'profile-continuation', 'r.json');
  for (const [label, gate] of [['previous', oldGate], ['next', nextGate]]) {
    const before = readFileSync(gate.profilePath);
    const rejectedPath = join(ctx.config.stateDirectory, `profile-drift-${label}.json`);
    const rebinding = rebindPreparedTestProfile(prepared.staged, oldGate, nextGate, rejectedPath);
    writeFileSync(gate.profilePath, `${before}\n`);
    try {
      await assert.rejects(rebinding, /profiles changed during output verification/);
      assert.equal(existsSync(rejectedPath), false);
      assert.equal(readFileSync(prepared.staged.receiptPath, 'utf8'), oldReceipt);
    } finally {
      writeFileSync(gate.profilePath, before);
    }
  }
  const rebound = await rebindPreparedTestProfile(prepared.staged, oldGate, nextGate, receiptPath);
  assert.equal(readFileSync(prepared.staged.receiptPath, 'utf8'), oldReceipt);
  assert.equal(rebound.outputs.sha256, prepared.staged.outputs.sha256);
  assert.equal(rebound.inputs.profileSha256, nextGate.profileSha256);
  const revision = await ctx.commit('test/behavior.test.js', 'pass\nrepaired\n', 'Test-only candidate');
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current,
    { ...ctx.repo, validationGates: [nextGate] }, revision, ctx.execute, rmSync, { staged: rebound });
  assert.equal(result[0].status, 'passed');
  assert.equal(ctx.calls.filter(value => value === 'dependencies').length, 1);
  assert.equal(ctx.calls.filter(value => value === 'compile').length, 1);
  await assert.rejects(rebindPreparedTestProfile(prepared.staged, oldGate, nextGate, receiptPath),
    /fresh audit path/);
  writeFileSync(profilePath, `changed preparation\n${original.replace('old runner', 'new runner')}`);
  assert.throws(() => verifyTestOnlyProfileChange(oldGate,
    { ...nextGate, profileSha256: hash(readFileSync(profilePath)) }), /only the final test runner/);
  writeFileSync(profilePath, original.replace('old runner', 'new runner'));
  writeFileSync(join(prepared.staged.workspace, 'extra', 'node_modules', 'fixture', 'package.json'),
    '{"changed":true}\n');
  await assert.rejects(rebindPreparedTestProfile(prepared.staged, oldGate, nextGate,
    join(ctx.config.stateDirectory, 'invalid-rebind.json')), /source or outputs changed/);
});
test('existing-only recovery preserves an unverified dependency cache without reinstalling', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  const receiptPath = prepared.staged.dependencyReceiptPath;
  const receipt = readFileSync(receiptPath, 'utf8');
  const file = join(dirname(receiptPath), 'w', 'extra', 'node_modules', 'fixture', 'package.json');
  writeFileSync(file, '{"version":"unverified"}\n');
  const revision = await ctx.commit('src/value.js', 'export const value = 2;\n',
    'Require a new compile snapshot');
  const recovered = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    revision, ctx.execute, { requireExistingDependencySnapshots: true });
  assert.equal(recovered.staged.error.code, 'prepared-cache-corrupt');
  assert.equal(readFileSync(file, 'utf8'), '{"version":"unverified"}\n');
  assert.equal(readFileSync(receiptPath, 'utf8'), receipt);
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 1);
});
test('concurrent prepared-output settlements cannot race past cache mutation',
  async t => {
    const ctx = await stagedValidationFixture(t);
    const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, ctx.execute);
    writeFileSync(join(prepared.staged.workspace, 'extra', 'node_modules',
      'fixture', 'package.json'), '{"version":"concurrently-corrupt"}\n');
    await new Promise(resolve => setTimeout(resolve, 100));
    const results = await Promise.all([
      verifyPreparedOutputs(prepared.staged.receiptPath,
        prepared.staged.workspace, prepared.staged.outputs),
      verifyPreparedOutputs(prepared.staged.receiptPath,
        prepared.staged.workspace, prepared.staged.outputs)
    ]);
    assert.deepEqual(results.map(result => result.valid), [false, false]);
  });
test('dependency file mutations invalidate a warm compile receipt', async t => {
  for (const mutation of ['modify', 'delete', 'add']) {
    const ctx = await stagedValidationFixture(t);
    const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, ctx.execute);
    const packagePath = join(prepared.staged.workspace, 'extra', 'node_modules',
      'fixture', 'package.json');
    if (mutation === 'modify') writeFileSync(packagePath, '{"version":"corrupt"}\n');
    else if (mutation === 'delete') rmSync(packagePath);
    else writeFileSync(join(dirname(packagePath), 'injected.js'), 'injected\n');
    const revision = await ctx.commit('test/behavior.test.js', `${mutation}\n`,
      `${mutation} dependency file before test-only validation`);
    const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
      revision, ctx.execute, rmSync, prepared);
    assert.equal(result[0].status, 'passed');
    assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 1);
    assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
  }
});
test('changed dependency contents cannot reuse an older compile receipt', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  rmSync(dirname(prepared.staged.dependencyReceiptPath),
    { recursive: true, force: true });
  ctx.behavior.dependencyVersion = '3.0.0';
  const regenerated = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  assert.notEqual(regenerated.staged.inputs.dependencyOutputsSha256,
    prepared.staged.inputs.dependencyOutputsSha256);
  assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 2);
  assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 2);
});
test('test-only repair rejects an older compile receipt after dependency regeneration',
  async t => {
    const ctx = await stagedValidationFixture(t);
    const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, ctx.execute);
    rmSync(dirname(prepared.staged.dependencyReceiptPath),
      { recursive: true, force: true });
    ctx.behavior.dependencyVersion = '3.0.0';
    const regenerated = await prepareValidation(ctx.config, ctx.current, ctx.repo,
      ctx.isolated.baseRevision, ctx.execute);
    assert.notEqual(regenerated.staged.inputs.dependencyOutputsSha256,
      prepared.staged.inputs.dependencyOutputsSha256);
    const revision = await ctx.commit('test/behavior.test.js', 'repair\n',
      'Repair test after dependency regeneration');
    const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
      revision, ctx.execute, rmSync, prepared);
    assert.equal(result[0].status, 'passed');
    assert.equal(ctx.calls.filter(stage => stage === 'dependencies').length, 2);
    assert.equal(ctx.calls.filter(stage => stage === 'compile').length, 3);
  });
test('runner dependency file mutation invalidates the prepared cache', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  const revision = await ctx.commit('test/behavior.test.js', 'repair\n',
    'Exercise dependency mutation detection');
  const execute = async (...args) => {
    const result = await ctx.execute(...args);
    const [, , cwd, , env] = args;
    if (env.PILOT_VALIDATION_STAGE === 'test')
      writeFileSync(join(cwd, 'extra', 'node_modules', 'fixture', 'package.json'),
        '{"version":"mutated-by-runner"}\n');
    return result;
  };
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, execute, rmSync, prepared);
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'prepared-cache-corrupt');
  assert.equal(existsSync(dirname(prepared.staged.workspace)), false);
});
test('native artifacts survive a failed test and cleanup preserves the primary failure', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  const execute = async (...args) => {
    const [, , cwd, , env] = args;
    if (env.PILOT_VALIDATION_STAGE !== 'test') return ctx.execute(...args);
    writeFileSync(join(env.PILOT_VALIDATION_ARTIFACT_DIRECTORY, 'jest-result.json'),
      '{"success":false,"numFailedTests":1}\n');
    writeFileSync(join(cwd, 'extra', 'node_modules', 'fixture', 'package.json'),
      '{"version":"mutated-by-failing-runner"}\n');
    ctx.behavior.failTest = true;
    return ctx.execute(...args);
  };
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, execute, rmSync, prepared);
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'prepared-cache-corrupt');
  assert.equal(result[0].attemptCount, 1);
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.deepEqual(artifact.output.primaryFailure, {
    stage: 'test', status: 'failed', blockedReason: null, exitCode: 1, timeout: false
  });
  assert.equal(artifact.output.cleanupFailure.blockedReason, 'prepared-cache-corrupt');
  assert.match(artifact.output.stderr, /fixture failure/);
  assert.equal(existsSync(dirname(prepared.staged.workspace)), false);
  assert.equal(artifact.nativeArtifacts.length, 1);
  const retained = artifact.nativeArtifacts[0];
  assert.equal(retained.stage, 'test');
  assert.equal(hash(readFileSync(retained.path)), retained.sha256);
  assert.equal(readFileSync(retained.path).length, retained.bytes);
  const manifest = JSON.parse(readFileSync(join(ctx.config.stateDirectory, 'runs', ctx.current.id, 'manifest.json')));
  assert.equal(manifest.artifacts.length, 1);
  assert.equal(manifest.artifacts[0].sha256, retained.sha256);
});

test('unsafe native artifact links block acceptance without retrying', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  const execute = async (...args) => {
    const result = await ctx.execute(...args);
    const [, , , , env] = args;
    if (env.PILOT_VALIDATION_STAGE === 'test')
      symlinkSync(ctx.current.workspace,
        join(env.PILOT_VALIDATION_ARTIFACT_DIRECTORY, 'jest-result.json'),
        process.platform === 'win32' ? 'junction' : 'dir');
    return result;
  };
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, execute, rmSync, prepared);
  assert.equal(result[0].status, 'blocked');
  assert.equal(result[0].blockedReason, 'validation-artifact-unavailable');
  assert.equal(result[0].attemptCount, 1);
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.match(artifact.output.artifactFailure, /bounded ordinary file/);
  assert.deepEqual(artifact.nativeArtifacts, []);
});
test('metadata-only native module changes preserve an identical prepared cache', async t => {
  const ctx = await stagedValidationFixture(t);
  const prepared = await prepareValidation(ctx.config, ctx.current, ctx.repo,
    ctx.isolated.baseRevision, ctx.execute);
  const revision = await ctx.commit('test/behavior.test.js', 'repair\n',
    'Exercise native module metadata tolerance');
  const execute = async (...args) => {
    const result = await ctx.execute(...args);
    const [, , cwd, , env] = args;
    if (env.PILOT_VALIDATION_STAGE === 'test') {
      const nativeModule = join(cwd, 'extra', 'node_modules', 'fixture',
        'resolver.node');
      writeFileSync(nativeModule, readFileSync(nativeModule));
    }
    return result;
  };
  const result = await runValidation(ctx.config, ctx.ledger, ctx.current, ctx.repo,
    revision, execute, rmSync, prepared);
  assert.equal(result[0].status, 'passed');
  assert.equal(existsSync(prepared.staged.workspace), true);
  const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0]));
  assert.equal(artifact.telemetry.validationTimings.find(stage =>
    stage.id === 'cleanup').cache, 'preserved');
});
