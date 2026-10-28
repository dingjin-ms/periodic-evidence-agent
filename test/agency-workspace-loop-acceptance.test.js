import test from 'node:test';
import assert from 'node:assert/strict';
import { copyFileSync, cpSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configAt, hash, json, now } from '../src/common.js';
import { verifyWorkspaceLoop, workspaceLoopContract, runAgencyWorkspaceLoop,
  verifyWorkspaceAuthoring, workspaceAuthoringContract } from '../src/agency-workspace-loop.js';
import { requireWorkspaceAuthoringSource, runAgencyWorkspaceAuthoring } from '../src/agency-workspace-authoring.js';
import { dispatch, makePlannedImprovementAssignment } from '../src/workers.js';
import { evidenceEnvelope } from '../src/sources.js';
import { recordAreaToImprove, recordTestCoveragePlan } from '../src/improvements.js';
import { repositoryValidationContract, skillQualificationId } from '../src/repository-skills.js';
import { coverageSkillName, prepareStage2 } from '../src/stage2.js';
import { Ledger } from '../src/ledger.js';
import { authoringLoopCompletionInstructions, authoringLoopToolNames,
  fitnessTargetCommand, loopCompletionInstructions, loopInventory, loopToolNames,
  nativeReviewArguments, nativeReviewerAgent } from '../scripts/validation/agency-workspace-loop.mjs';

const original = "it.each([{ enabled: true }])('preserves assertions', value => {\n  expect(value.enabled).toBe(true);\n});\n";
const repaired = original.replace('it.each(', 'it.each<{ enabled: boolean }>(');
const sessionId = '11111111-1111-4111-8111-111111111111';
async function fixture(t, withLedger = false, {
  authoring = false, assertionRepair = false, nativeWorkflow = false
} = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'workspace-loop-acceptance-'));
  const ledger = withLedger ? new Ledger(join(directory, 'ledger')) : null;
  t.after(() => {
    ledger?.close();
    rmSync(directory, { recursive: true, force: true });
  });
  const remote = join(directory, 'remote'), workspace = join(directory, 'local');
  const root = join(directory, 'job-artifact', 'workspace-loop');
  const privateDirectory = join(directory, 'pilot-loop-100');
  mkdirSync(join(remote, 'tests'), { recursive: true });
  mkdirSync(root, { recursive: true });
  const git = (cwd, args) => execFileSync('git', ['-c', 'core.autocrlf=false',
    '-c', 'core.hooksPath=NUL', '-c', 'commit.gpgsign=false', '-C', cwd, ...args],
  { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trimEnd();
  git(remote, ['init', '-q']);
  git(remote, ['config', 'user.name', 'Fixture']);
  git(remote, ['config', 'user.email', 'fixture@example.invalid']);
  git(remote, ['config', 'core.autocrlf', 'false']);
  const allowedPath = authoring ? 'agents/excel-agent/tests/integration/fixture.test.ts' : 'tests/fixture.test.ts';
  const requiredSkillPaths = ['router.md', 'workflow.md'];
  const nativeOptions = nativeWorkflow ? {
    cardPath: 'agents/excel-agent/tests/integration/behavior-cards/seam.behavior-card.md',
    fitness: ['mutation', 'refactor'].map(kind => ({ kind, path: 'modules/runtime/src/policy.ts',
      find: 'const route = true;', replace: kind === 'mutation' ? 'const route = false;' : 'const route = Boolean(1);' })),
    reviewerAgentPath: 'plugins/native/agents/reviewer.md',
    reviewerAgentSha256: hash(nativeReviewerAgent), reviewerModel: 'synthetic-fixture-only'
  } : undefined;
  mkdirSync(dirname(join(remote, allowedPath)), { recursive: true });
  writeFileSync(join(remote, allowedPath), original);
  for (const path of requiredSkillPaths) writeFileSync(join(remote, path), 'Fixture native skill.\n');
  if (nativeOptions) {
    for (const [path, content] of [
      [nativeOptions.cardPath, '# Seam\n\n## Invariants\n\n- Keep routing.\n\n## Test coverage score\n\nScore: 6\nBasis: Existing.\n'],
      [nativeOptions.fitness[0].path, 'export const route = true;\n'],
      ['docs/skills/Integration-test-core/scripts/probe-fitness.mjs', '// Synthetic probe fixture only.\n']
    ]) {
      mkdirSync(dirname(join(remote, path)), { recursive: true });
      writeFileSync(join(remote, path), content);
    }
  }
  git(remote, ['add', '.']);
  const commit = message => git(remote, ['commit', '-qm',
    `${message}\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>\nCopilot-Session: ${sessionId}`]);
  commit('Fixture baseline');
  const baseRevision = git(remote, ['rev-parse', 'HEAD']);
  git(directory, ['clone', '--no-hardlinks', remote, workspace]);
  git(workspace, ['config', 'core.autocrlf', 'false']);
  const appended = "\nit('adds a synthetic case', () => { expect(true).toBe(true); });\n";
  const authored = original + appended;
  let failedCandidate;
  if (assertionRepair) {
    writeFileSync(join(remote, allowedPath), original + appended.replace('toBe(true)', 'toBe(false)'));
    git(remote, ['add', '.']);
    commit('Fixture new assertion fails');
    failedCandidate = git(remote, ['rev-parse', 'HEAD']);
  }
  writeFileSync(join(remote, allowedPath), authoring ? authored : repaired);
  if (nativeOptions) writeFileSync(join(remote, nativeOptions.cardPath),
    readFileSync(join(remote, nativeOptions.cardPath), 'utf8').replace('Basis: Existing.', 'Basis: Added source-bound caller assertions.'));
  git(remote, ['add', '.']);
  commit('Fixture type repair');
  const candidate = git(remote, ['rev-parse', 'HEAD']);
  git(remote, ['bundle', 'create', join(root, 'candidate.bundle'), 'HEAD', `^${baseRevision}`]);
  writeFileSync(join(root, 'candidate.test.ts'), authoring ? authored : repaired);
  const runner = fileURLToPath(new URL('../scripts/validation/agency-workspace-loop.mjs', import.meta.url));
  const native = fileURLToPath(new URL('../src/native-command.ps1', import.meta.url));
  copyFileSync(runner, join(root, 'server.mjs'));
  copyFileSync(native, join(root, 'native-command.ps1'));
  writeFileSync(join(root, 'profile.ps1'), 'exit 0\n');
  const sourceInputs = [allowedPath, ...requiredSkillPaths];
  if (nativeOptions) sourceInputs.push(nativeOptions.cardPath, nativeOptions.fitness[0].path,
    'docs/skills/Integration-test-core/scripts/probe-fitness.mjs');
  const manifest = { schema: 'agency-workspace-loop-manifest-v1',
    baseRevision, workspace: remote, directory: privateDirectory, buildId: '100',
    pipelineRevision: 'b'.repeat(40), allowedPath, maximumRepairs: 2, requiredSkillPaths, sessionId,
    executable: 'C:\\Program Files\\PowerShell\\7\\pwsh.exe',
    nugetDirectory: join(directory, 'pilot-nuget-100'),
    profilePath: join(privateDirectory, 'profile.ps1'), profileSha256: hash('exit 0\n'),
    runnerPath: join(privateDirectory, 'server.mjs'), runnerSha256: hash(readFileSync(runner)),
    nativeCommandPath: join(privateDirectory, 'native-command.ps1'),
    nativeCommandSha256: hash(readFileSync(native)), sourceInputs,
    testPopulation: { suites: 1, tests: authoring ? 4 : 3,
      path: authoring ? 'tests/integration/fixture.test.ts' : allowedPath } };
  const contract = { schema: 'agency-oa-workspace-loop-contract-v1', repoId: 'fixture',
    candidate: baseRevision, gateId: 'integration', profileSha256: manifest.profileSha256,
    executable: manifest.executable, sourceInputs, testPopulation: manifest.testPopulation,
    maximumRunnerMinutes: 60, maximumArtifactBytes: 1024 ** 3,
    queueMinutes: 15, cancellationMinutes: 5, pollSeconds: 1,
    pipeline: { revision: manifest.pipelineRevision, yamlSha256: hash('fixture pipeline\n'),
      definitionId: 10, definitionRevision: 2, ref: 'refs/heads/fixture-loop',
      yamlPath: '/pipeline.yml', organization: 'https://dev.azure.com/example',
      project: 'Fixture', repositoryId: 'fixture', artifactPrefix: 'Fixture-' },
    requiredTasks: ['prepare', 'validate'], prepareTask: 'prepare', validationTask: 'validate',
    loop: { runnerSha256: manifest.runnerSha256, nativeCommandSha256: manifest.nativeCommandSha256,
      maximumRepairs: 2, maximumNewJobs: 1, typeOnly: true, productPublication: false,
      productionAssignment: false, allowedPath, requiredSkillPaths, toolNames: loopToolNames,
      agentPath: '.github/agents/fixture.md', agentSha256: 'c'.repeat(64),
      pluginManifestPath: '.github/plugin.json', pluginManifestSha256: 'd'.repeat(64) } };
  const sourceApprovalPath = join(directory, 'source-approval.json');
  if (authoring) {
    writeFileSync(sourceApprovalPath, JSON.stringify({ schema: 'synthetic-test-approval' }));
    writeFileSync(join(root, 'evidence.json'), JSON.stringify({ schema: 'synthetic-test-evidence' }));
    contract.schema = 'agency-oa-workspace-authoring-contract-v1';
    contract.loop.typeOnly = false;
    contract.loop.appendOnly = true;
    contract.loop.toolNames = authoringLoopToolNames;
    contract.loop.authoring = { projectName: '@officeagent-agent/excel-agent', projectPath: 'agents/excel-agent',
      baselineTests: 3, evidenceSha256: hash(readFileSync(join(root, 'evidence.json'))),
      sourceApprovalSha256: hash(readFileSync(sourceApprovalPath)) };
    manifest.authoring = { ...contract.loop.authoring, evidencePath: join(privateDirectory, 'evidence.json') };
    manifest.schema = 'agency-workspace-authoring-manifest-v1';
    if (nativeOptions) {
      contract.loop.authoring.nativeWorkflow = nativeOptions;
      manifest.authoring.nativeWorkflow = nativeOptions;
      manifest.reviewAgentSpec =
        `ado-git:example/Fixture/fixture:plugins/native/agents/reviewer@${manifest.pipelineRevision}`;
      writeFileSync(join(root, 'reviewer.md'), nativeReviewerAgent);
      writeFileSync(join(root, 'candidate.card.md'), readFileSync(join(remote, nativeOptions.cardPath)));
    }
  }
  const completion = authoring ? authoringLoopCompletionInstructions : loopCompletionInstructions;
  contract.request = { compute: { $type: 'pipeline', pipelineId: 10,
    pipelineRefOverride: contract.pipeline.ref }, prompt: `Fixture restricted loop.\n${completion}`,
    context: { repository: { $type: 'ado', organization: 'example', project: 'Fixture' } },
    customAgent: { type: 'Spec', name: `ado-git:example/Fixture/fixture:${contract.loop.agentPath.slice(0, -3)}@${manifest.pipelineRevision}` },
    plugins: [], additionalOptions: { pluginOptions: { includeDefaults: false } },
    metadata: { candidate: baseRevision, pipelineCommit: manifest.pipelineRevision,
      completionPolicySha256: hash(completion),
      profileSha256: manifest.profileSha256, pipelineYamlSha256: contract.pipeline.yamlSha256,
      productPullRequests: 'forbidden' } };
  if (nativeOptions) contract.request.modelConfiguration = { model: nativeOptions.reviewerModel };
  const started = Date.now(), date = seconds => new Date(started + seconds * 1000).toISOString();
  let second = 0;
  const record = (stage, round, revision, exitCode = 0) => {
    const log = `round-${round}-${stage}.log`;
    const output = exitCode ? `${allowedPath}: error TS2322: Fixture type failure.\n`
      : stage === 'test' ? `PASS ${manifest.testPopulation.path}\nTest Suites: 1 passed, 1 total\nTests: ${manifest.testPopulation.tests} passed, ${manifest.testPopulation.tests} total\n`
        : `Fixture executed ${stage}.\n`;
    writeFileSync(join(root, log), output);
    return { stage, candidate: revision, buildId: '100', cwd: remote,
      executable: manifest.executable,
      arguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', manifest.profilePath],
      supervisorArguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', manifest.nativeCommandPath],
      startedAt: date(second++), finishedAt: date(second++),
      exitCode, log, logSha256: hash(output) };
  };
  const prepared = { schema: 'agency-workspace-loop-prepared-v1', buildId: '100',
    baseRevision, pipelineRevision: manifest.pipelineRevision, workspace: remote,
    profileSha256: manifest.profileSha256,
    inputs: Object.fromEntries(sourceInputs.map(path => [path, hash(git(remote, ['show', `${baseRevision}:${path}`]))])),
    sourceBlobs: Object.fromEntries(sourceInputs.map(path => [path, git(remote, ['rev-parse', `${baseRevision}:${path}`])])),
    stages: ['fingerprint', 'authentication-check', 'authentication', 'dependencies']
      .map(stage => record(stage, 'prepare', baseRevision)) };
  const round = (index, revision, passed) => ({ index, candidate: revision,
    profileSha256: manifest.profileSha256, workspace: remote, buildId: '100', passed,
    repairable: !passed, stages: (passed ? ['compile', 'policy', 'test'] : ['compile'])
      .map(stage => record(stage, index, revision, passed ? 0 : 1)) });
  const state = { schema: 'agency-workspace-loop-state-v1', buildId: '100', baseRevision,
    phase: 'ready', finished: true, rounds: [round(0, baseRevision, false), round(1, candidate, true)],
    plans: [{ plan: 'Fixture type repair; preserve every assertion.' }], skillReads: requiredSkillPaths };
  const result = { schema: 'agency-workspace-loop-result-v1', buildId: '100',
    baseRevision, candidate, pipelineRevision: manifest.pipelineRevision, workspace: remote,
    profileSha256: manifest.profileSha256, remoteWorkComplete: true, controllerAcceptance: false,
    controllerAcceptanceStatus: 'pending-external', localReceiptsImported: false,
    sourceCleanAfter: true, gatesPassed: true, testPopulation: manifest.testPopulation,
    rounds: state.rounds, stages: ['compile', 'policy', 'test'].map(stage => record(stage, 'final', candidate)) };
  if (authoring) {
    prepared.schema = 'agency-workspace-authoring-prepared-v1';
    prepared.authoring = manifest.authoring;
    state.schema = 'agency-workspace-authoring-state-v1';
    state.evidenceReadSha256 = manifest.authoring.evidenceSha256;
    state.skillReadRanges = Object.fromEntries(requiredSkillPaths.map(path => [path, [[1, 2]]]));
    if (assertionRepair) {
      const failed = round(0, failedCandidate, true);
      failed.passed = false;
      failed.repairable = true;
      const stage = failed.stages.at(-1);
      const text = `\x1b[31mFAIL\x1b[0m ${manifest.testPopulation.path}\nTests: 1 failed, 3 passed, 4 total\n`;
      writeFileSync(join(root, stage.log), text);
      stage.exitCode = 1;
      stage.logSha256 = hash(text);
      state.rounds = [failed, round(1, candidate, true)];
    } else state.rounds = [round(0, candidate, true)];
    result.schema = 'agency-workspace-authoring-result-v1';
    result.authoring = manifest.authoring;
    result.rounds = state.rounds;
  }
  const put = (name, value) => writeFileSync(join(root, name), JSON.stringify(value));
  if (nativeOptions) {
    const current = state.rounds.at(-1);
    current.nativeFitness = nativeOptions.fitness.map(probe => {
      const startedAt = date(second++);
      const stages = ['compile', 'test'].map(stage =>
        ({ ...record(stage, `fitness-${current.index}-${probe.kind}`, candidate),
          fitnessSourcePath: probe.path }));
      if (probe.kind === 'mutation') {
        const stage = stages[1];
        const text = `FAIL ${manifest.testPopulation.path}\nTest Suites: 1 failed, 1 total\nTests: 1 failed, 3 passed, 4 total\n`;
        writeFileSync(join(root, stage.log), text);
        stage.exitCode = 1;
        stage.logSha256 = hash(text);
      }
      put(`fitness-${current.index}-${probe.kind}-stages.json`, stages);
      const node = 'C:\\Program Files\\nodejs\\node.exe';
      const target = fitnessTargetCommand(manifest, current.index, probe.kind, node);
      const outcome = { ok: true, kind: probe.kind, file: probe.path, baselineStatus: null,
        mutatedStatus: stages[1].exitCode, restoreFailed: false, satisfied: true,
        verdict: probe.kind === 'mutation' ? 'killed' : 'robust', exitCode: 0, command: target.join(' ') };
      const command = { stage: `fitness-${probe.kind}`, candidate, buildId: '100', cwd: remote,
        executable: node, arguments: [join(remote, 'docs/skills/Integration-test-core/scripts/probe-fitness.mjs'),
          '--file', probe.path, '--kind', probe.kind, '--find', probe.find, '--replace', probe.replace,
          '--no-baseline', '--json', '--', ...target],
        supervisorArguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', manifest.nativeCommandPath],
        startedAt, finishedAt: date(second++), exitCode: 0,
        log: `round-${current.index}-fitness-${probe.kind}.log` };
      put(command.log, outcome);
      command.logSha256 = hash(readFileSync(join(root, command.log)));
      return { kind: probe.kind, path: probe.path, command, result: outcome, stages,
        sourceBeforeSha256: hash(readFileSync(join(remote, probe.path))),
        sourceAfterSha256: hash(readFileSync(join(remote, probe.path))) };
    });
    const reviewSession = '22222222-2222-4222-8222-222222222222';
    const report = { schema: 'agency-native-coverage-review-v1', candidate, buildId: '100',
      sessionId: reviewSession, round: current.index, completed: true, verdict: 'approved',
      evidenceReadSha256: manifest.authoring.evidenceSha256, findings: [], residuals: [],
      calls: [{ name: 'review_submit' }],
      reads: Object.fromEntries([...requiredSkillPaths, allowedPath, nativeOptions.cardPath].map(path =>
        [path, { sha256: hash(readFileSync(join(remote, path))),
          ranges: [[1, readFileSync(join(remote, path), 'utf8').split('\n').length]] }])) };
    put(`review-${current.index}.json`, report);
    put(`review-request-${current.index}.json`, { round: current.index, candidate, sessionId: reviewSession });
    const log = `round-${current.index}-native-review.log`;
    const profile = `[profiles.controller-native-review-${reviewSession}]\n`;
    writeFileSync(join(root, `review-profile-${current.index}.toml`), profile);
    writeFileSync(join(root, log), '');
    const command = { stage: 'native-review', candidate, buildId: '100',
      executable: 'C:\\tools\\agency\\agency.exe',
      cwd: join(directory, `pilot-native-review-private-${reviewSession}`, 'workspace'),
      arguments: nativeReviewArguments(manifest, reviewSession,
        join(directory, `pilot-native-review-private-${reviewSession}`, 'logs')),
      supervisorArguments: ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', manifest.nativeCommandPath],
      exitCode: 0, providerDiagnosticsRetained: false,
      startedAt: date(second++), finishedAt: date(second++), log, logSha256: hash('') };
    current.nativeReview = { ...report, command,
      executableSha256: 'a'.repeat(64), profileSha256: hash(profile),
      reportSha256: hash(readFileSync(join(root, `review-${current.index}.json`))) };
    result.stages = ['compile', 'policy', 'test'].map(stage => record(stage, 'final', candidate));
  }
  put('inspection-project.json', { matchCount: 1,
    matches: [{ project: authoring ? 'agents/excel-agent' : 'agents/office-agent' }] });
  put('inspection-baseline.json', { baseRevision, changedFiles: [allowedPath] });
  put('inspection-cards.json', { strict: false, scoreGateResult: 'passed' });
  const observation = { job: { jobId: 'fixture-job', state: 'Completed', result: 'Success',
    pipelineRun: { runId: 100, definitionId: 10 } },
    build: { id: 100, status: 'completed', result: 'succeeded', definitionId: 10,
      definitionRevision: 2, sourceVersion: manifest.pipelineRevision, sourceBranch: contract.pipeline.ref,
      startTime: date(0), finishTime: date(60), queueTime: date(0) },
    pipelineYaml: 'fixture pipeline\n', artifacts: [{ name: 'Fixture-100' }],
    timeline: ['prepare', 'validate'].map((name, i) => ({ id: name, name, type: 'Task',
      state: 'completed', result: 'succeeded', logId: i + 1 })) };
  async function seal() {
    put('manifest.json', manifest);
    prepared.manifestSha256 = hash(readFileSync(join(root, 'manifest.json')));
    put('loop-prepared.json', prepared);
    put('loop-state.json', state);
    result.manifestSha256 = prepared.manifestSha256;
    result.preparedSha256 = hash(readFileSync(join(root, 'loop-prepared.json')));
    result.stateSha256 = hash(readFileSync(join(root, 'loop-state.json')));
    result.inventory = await loopInventory(root);
    put('loop-result.json', result);
    observation.logs = [
      { taskId: 'prepare', logId: 1, lines: [`LOOP_PREPARED base=${baseRevision} build=100 preparedSha256=${result.preparedSha256}`] },
      { taskId: 'validate', logId: 2, lines: [`LOOP_RESULT base=${baseRevision} candidate=${candidate} build=100 resultSha256=${hash(readFileSync(join(root, 'loop-result.json')))}`] }
    ];
  }
  await seal();
  const verify = () => (authoring ? verifyWorkspaceAuthoring : verifyWorkspaceLoop)(
    contract, directory, observation, 'fixture-job', workspace, date(0));
  const profilePath = join(root, 'profile.ps1'), contractPath = join(directory, 'contract.json');
  const repo = { id: 'fixture', allowedWritePrefixes: [authoring ? 'agents/excel-agent/tests/integration' : 'tests'],
    validationGates: [{ id: 'integration', approved: true, profilePath, profileSha256: manifest.profileSha256 }] };
  const request = () => {
    writeFileSync(contractPath, JSON.stringify(contract));
    return { schema: authoring ? 'controller-workspace-authoring-request-v1' : 'controller-workspace-loop-request-v1',
      id: 'fixture', repoId: 'fixture',
      ...(authoring ? { evidencePath: join(root, 'evidence.json'), sourceApprovalPath,
        assignmentId: 'synthetic-source-assignment' } : {}),
      workspace, baseRevision, contractPath, contractSha256: hash(readFileSync(contractPath)) };
  };
  return { directory, root, workspace, git, manifest, prepared, state, result, observation, ledger,
    contract, repo, request, seal, verify, put };
}

test('controller accepts a complete synthetic native workflow with source-bound fitness and isolated review evidence', async t => {
  const f = await fixture(t, false, { authoring: true, nativeWorkflow: true });
  assert.doesNotThrow(() => workspaceAuthoringContract(f.repo, f.request()));
  const accepted = await f.verify();
  assert.equal(accepted.controllerAcceptance, true);
  assert.equal(accepted.sourceRevision, f.result.candidate);
  assert.equal(accepted.authoring.nativeWorkflow.reviewerModel, 'synthetic-fixture-only');
});

test('independent authoring acceptance imports a long-path bundle without changing the original bytes', async t => {
  const f = await fixture(t, false, { authoring: true, nativeWorkflow: true });
  const destination = join(f.directory, 'nested-private-state-'.repeat(10), 'operation');
  mkdirSync(destination, { recursive: true });
  renameSync(join(f.directory, 'job-artifact'), join(destination, 'job-artifact'));
  const bundle = join(destination, 'job-artifact', 'workspace-loop', 'candidate.bundle');
  assert.ok(bundle.length >= 260);
  const before = hash(readFileSync(bundle));
  const accepted = await verifyWorkspaceAuthoring(f.contract, destination, f.observation,
    'fixture-job', f.workspace, f.observation.build.startTime);
  assert.equal(accepted.controllerAcceptance, true);
  assert.equal(accepted.sourceRevision, f.result.candidate);
  assert.equal(hash(readFileSync(bundle)), before);
  assert.equal(accepted.inventory.find(item => item.path === 'workspace-loop/candidate.bundle').sha256, before);
  assert.equal(f.git(f.workspace, ['rev-parse', 'HEAD']), f.manifest.baseRevision);
  assert.equal(f.git(f.workspace, ['status', '--porcelain']), '');
});

test('controller binds request evidence delivery to the approved bytes and final authoring manifest', async t => {
  const f = await fixture(t, false, { authoring: true });
  const authoring = f.contract.loop.authoring;
  authoring.evidenceTransport = 'request-tool-v1';
  assert.throws(() => workspaceAuthoringContract(f.repo, f.request()), /complete approved evidence in the private request/);
  const payload = readFileSync(join(f.root, 'evidence.json')).toString('base64');
  f.contract.request.prompt = `\n<approved-evidence-base64>\n${payload}\n</approved-evidence-base64>\n` +
    f.contract.request.prompt;
  assert.doesNotThrow(() => workspaceAuthoringContract(f.repo, f.request()));
  await assert.rejects(f.verify(), /not bound to the approved source payload/);
  for (const value of [f.manifest, f.prepared, f.result]) value.authoring.evidenceTransport = 'request-tool-v1';
  await f.seal();
  assert.equal((await f.verify()).controllerAcceptance, true);
});

test('controller independently binds managed evidence to downloaded original session events', async t => {
  const f = await fixture(t, false, { authoring: true });
  for (const value of [f.contract.loop, f.manifest, f.prepared, f.result]) {
    value.authoring.evidenceTransport = 'request-session-v1';
  }
  const payload = readFileSync(join(f.root, 'evidence.json')).toString('base64');
  f.contract.request.prompt = `\n<approved-evidence-base64>\n${payload}\n</approved-evidence-base64>\n` +
    f.contract.request.prompt;
  assert.doesNotThrow(() => workspaceAuthoringContract(f.repo, f.request()));
  await f.seal();
  await assert.rejects(f.verify(), /exact approved request/);
  const binding = { sessionId, eventId: 'request-event', promptSha256: hash(f.contract.request.prompt) };
  f.state.evidenceRequest = binding;
  await f.seal();
  await assert.rejects(f.verify(), /session is missing or ambiguous/);
  const session = join(f.directory, 'job-artifact', 'session_20261027_101000_1234');
  mkdirSync(session);
  const writeEvents = (prompt = f.contract.request.prompt, id = binding.eventId) => writeFileSync(
    join(session, 'events.jsonl'), [
      { type: 'session.start', data: { sessionId } },
      { type: 'user.message', id, data: { content: prompt } }
    ].map(event => JSON.stringify(event)).join('\n') + '\n');
  writeEvents();
  assert.equal((await f.verify()).controllerAcceptance, true);
  writeEvents(f.contract.request.prompt, 'substituted-event');
  await assert.rejects(f.verify(), /original downloaded session events/);
  writeEvents(f.contract.request.prompt + 'Unexpected request suffix.');
  await assert.rejects(f.verify(), /original downloaded session events/);
  writeEvents();
  const duplicate = join(f.directory, 'job-artifact', 'session_20261027_101001_1235');
  mkdirSync(duplicate);
  copyFileSync(join(session, 'events.jsonl'), join(duplicate, 'events.jsonl'));
  await assert.rejects(f.verify(), /session is missing or ambiguous/);
});

test('controller rejects resealed native compilation, restoration, model/tool and fresh-review source substitutions', async t => {
  const f = await fixture(t, false, { authoring: true, nativeWorkflow: true });
  const round = f.state.rounds.at(-1), saved = structuredClone(round);
  const finalStages = structuredClone(f.result.stages);
  for (const corrupt of [
    value => { value.nativeFitness[0].stages[0].exitCode = 1; },
    value => { value.nativeFitness[0].stages[0].fitnessSourcePath = 'modules/other/src/policy.ts'; },
    value => { value.nativeFitness[0].sourceAfterSha256 = '0'.repeat(64); },
    value => { value.nativeReview.completed = false; },
    value => { value.nativeReview.sessionId = f.manifest.sessionId; },
    value => { value.nativeReview.command.arguments.push('--allow-all-tools'); },
    value => { value.nativeReview.reads[f.manifest.allowedPath].sha256 = '0'.repeat(64); },
    value => { f.result.stages[0].startedAt = value.nativeReview.command.startedAt; }
  ]) {
    Object.assign(round, structuredClone(saved));
    f.result.stages = structuredClone(finalStages);
    corrupt(round);
    f.put('fitness-0-mutation-stages.json', round.nativeFitness[0].stages);
    const { command, executableSha256, reportSha256, profileSha256, ...report } = round.nativeReview;
    f.put('review-0.json', report);
    round.nativeReview.reportSha256 = hash(readFileSync(join(f.root, 'review-0.json')));
    await f.seal();
    await assert.rejects(f.verify(), /native|Native|fitness|Fitness|review|Review|stage/);
  }
  Object.assign(round, structuredClone(saved));
  f.result.stages = finalStages;
  const substituted = structuredClone(round.nativeFitness[0].stages);
  substituted[0].exitCode = 1;
  f.put('fitness-0-mutation-stages.json', substituted);
  await f.seal();
  await assert.rejects(f.verify(), /Native fitness stages/);
});

async function authorizeFixture(f, { excludeCard = false } = {}) {
  const config = configAt('pilot.example.json');
  config.stateDirectory = join(f.directory, 'state');
  config.activation.dispatch = true;
  config.statePolicy.accessApproved = true;
  config.limits.maxRemoteValidationJobs = 1;
  config.limits.maxItems = 100;
  config.limits.workerMaxToolCalls = 20;
  config.stage2 = { skillDirectory: join(f.directory, 'synthetic-skill', coverageSkillName) };
  mkdirSync(join(config.stage2.skillDirectory, 'references'), { recursive: true });
  writeFileSync(join(config.stage2.skillDirectory, 'SKILL.md'),
    `---\nname: ${coverageSkillName}\n---\nSynthetic fixture: read references/coverage-map.md.`);
  writeFileSync(join(config.stage2.skillDirectory, 'references', 'coverage-map.md'), 'Synthetic fixture only.');
  const { ledger, repo } = f;
  Object.assign(repo, { projectId: 'fixture-project', owner: 'fixture-owner', routingApproved: true,
    routingRules: ['Synthetic coverage'], referenceCheckout: f.workspace, baseRef: 'main',
    remote: 'https://dev.azure.com/example/Fixture/_git/fixture',
    ...(excludeCard ? { allowedWriteFiles: [f.manifest.allowedPath] } : {}),
    commitIdentity: { name: 'Fixture', email: 'fixture@example.invalid' },
    skillBindings: [{ id: 'fixture-native', capability: 'integration-test-authoring', skillPath: 'workflow.md',
      enabled: true, qualification: 'qualified', requestedOutcomes: ['add-or-update-tests'],
      allowedWritePrefixes: excludeCard
        ? [`${f.manifest.authoring.projectPath}/tests/integration/scenarios`] : [...repo.allowedWritePrefixes],
      ...(excludeCard ? { allowedWriteFiles: [f.manifest.allowedPath] } : {}),
      requiresBehaviorCard: true,
      sideEffects: { commit: false, push: false, createDraftPR: false } }] });
  config.repositories = [repo];
  const evidence = evidenceEnvelope('ado', 'fixture/coverage', '42', '1',
    'https://example.invalid/42', 'fixture', now());
  evidence.source.provenance = 'authenticated-source';
  evidence.sourceStatus = 'Resolved';
  evidence.fields = { 'System.State': 'Resolved', 'Microsoft.VSTS.Common.ResolvedReason': 'Fixed' };
  const captured = ledger.evidence(evidence, { description: 'Synthetic assertion gap, not a real report.' },
    'fixture-source:ado:created');
  ledger.db.exec('CREATE TABLE app_runs (id TEXT PRIMARY KEY, body TEXT NOT NULL); ' +
    'CREATE TABLE app_passes (run_id TEXT, pass TEXT, body TEXT);');
  ledger.db.prepare('INSERT INTO app_runs VALUES(?,?)').run('fixture-source', json({ window: config.window }));
  ledger.db.prepare('INSERT INTO app_passes VALUES(?,?,?)').run('fixture-source', 'ado:created',
    json({ state: 'complete', source: 'synthetic fixture' }));
  const handoffPath = join(f.directory, 'held-handoff.json');
  prepareStage2(config, { format: 'stage2-sources-v1',
    sources: [{ ledgerPath: join(ledger.directory, 'ledger.sqlite'), runId: 'fixture-source' }] }, handoffPath);
  const handoff = JSON.parse(readFileSync(handoffPath));
  const candidate = { id: 'fixture-candidate', classification: 'extend existing test', dispatchAllowed: false,
    evidenceRefs: handoff.sources[0].evidenceRefs, behavior: { runtimeReproduced: false },
    existingCoverage: ['Synthetic existing case'], missingAssertion: 'Synthetic additional behavior',
    harnessReuse: ['Synthetic native integration harness'], ownership: { owner: repo.owner }, confidence: 0.9,
    blockers: [], proposedValidation: ['Synthetic compile/policy/test'], target: {
      repository: repo.id, inspectedRef: f.manifest.baseRevision, approvedTarget: {
        repository: repo.id, baseRef: 'main', layer: 'integration',
        inspectedBaseline: f.manifest.baseRevision, implementationCommit: null, freshTargetReconciliationRequired: true
      }, approvalProvenance: { decision: 'Synthetic direction only', authority: 'synthetic test',
        relayedBySession: sessionId, receivedAt: now(), contract: ['Synthetic invariant'],
        target: 'Synthetic native integration suite',
        excludedAuthorization: ['product edits', 'test edits', 'fixes', 'CI', 'PRs', 'dispatch'] }
    } };
  const proposalPath = join(f.directory, 'held-proposal.json');
  writeFileSync(proposalPath, json({ schemaVersion: 1, proposalId: 'fixture-proposal',
    status: 'held-not-dispatched', dispatchAllowed: false, skill: handoff.skill,
    examinedScope: ['Synthetic fixture'], replay: {
      cohort: { window: { start: config.window.start, endExclusive: config.window.end } },
      verifiedIndexRef: 'synthetic-index', baselines: [{
        repository: repo.id, ref: f.manifest.baseRevision, approval: 'inspected-not-approved'
      }]
    }, candidates: [candidate] }));
  const investigation = {
    recordType: 'investigation', schemaVersion: '1.0', id: 'investigation-fixture-coverage', version: 1,
    evidenceIds: [captured.id], state: 'triaged', observedBehavior: 'Synthetic missing coverage.',
    expectedBehavior: 'Synthetic established behavior stays covered.', hypotheses: [], counterEvidence: [],
    classification: 'functional', defectConfirmation: 'unconfirmed', reportEligibility: 'included',
    handoffEligibility: 'eligible', exclusionReasons: [], rationale: 'Synthetic test-only coverage improvement.',
    confidence: 0.9, review: { method: config.reviewMethod, reviewer: 'synthetic-test', reviewedAt: now() },
    repoIds: [repo.id], existingFixes: [], nextAction: 'Append the synthetic regression assertion.'
  };
  ledger.put(investigation);
  const improvement = recordAreaToImprove(ledger, { investigationIds: [investigation.id],
    category: 'missing-test-coverage', theme: 'Synthetic integration coverage',
    observedBehavior: investigation.observedBehavior, expectedBehavior: investigation.expectedBehavior,
    rationale: investigation.rationale, priority: 'medium', repoIds: [repo.id],
    capabilities: ['integration-test-authoring'] });
  const plan = recordTestCoveragePlan(ledger, {
    improvementId: improvement.id, improvementVersion: improvement.version, repoId: repo.id,
    capability: 'integration-test-authoring', sourceRevision: f.manifest.baseRevision,
    searchStatus: 'complete', existingTests: [], coverageGaps: [candidate.missingAssertion],
    unknowns: [], rationale: 'Synthetic exact-source plan'
  });
  const binding = repo.skillBindings[0], validation = repositoryValidationContract(repo);
  ledger.qualify(skillQualificationId(repo.id, binding.id), {
    state: 'qualified-read-only', repoId: repo.id, bindingId: binding.id, capability: binding.capability,
    remote: repo.remote, baseRef: repo.baseRef, baseRevision: plan.sourceRevision,
    skillPath: binding.skillPath, skillSha256: hash('Fixture native skill.\n'), qualificationSource: 'local-reference',
    validationContractVersion: validation.version, validationContractSha256: validation.sha256, sideEffects: binding.sideEffects
  });
  const assignment = makePlannedImprovementAssignment(config, ledger, investigation, plan.id);
  ledger.prepare(assignment);
  const evidencePath = join(f.root, 'evidence.json');
  const body = ledger.db.prepare('SELECT body FROM captures WHERE hash=?').get(captured.capture.sha256).body;
  writeFileSync(evidencePath, json({ schema: 'controller-authoring-evidence-v1',
    records: [{ reference: candidate.evidenceRefs[0], bodyBase64: Buffer.from(body).toString('base64') }] }));
  const approval = { schema: 'controller-authoring-source-approval-v1', repoId: repo.id,
    assignmentId: assignment.id, baseRevision: plan.sourceRevision, allowedPath: f.manifest.allowedPath,
    evidenceSha256: hash(readFileSync(evidencePath)), coverageCandidateId: candidate.id, targetRepository: repo.id,
    coverageProposal: { path: proposalPath, sha256: hash(readFileSync(proposalPath)) },
    coverageHandoff: { path: handoffPath, sha256: hash(readFileSync(handoffPath)) },
    executionAuthorized: true, productPublication: false, maximumNewJobs: 1, maximumRepairs: 2,
    authority: 'Synthetic test only; never live execution authority', receivedAt: now() };
  if (f.contract.loop.authoring.nativeWorkflow)
    approval.nativeWorkflowSha256 = hash(json(f.contract.loop.authoring.nativeWorkflow));
  const request = f.request();
  writeFileSync(request.sourceApprovalPath, json(approval));
  Object.assign(f.contract.loop.authoring, { evidenceSha256: approval.evidenceSha256,
    sourceApprovalSha256: hash(readFileSync(request.sourceApprovalPath)) });
  Object.assign(f.manifest.authoring, f.contract.loop.authoring);
  f.state.evidenceReadSha256 = approval.evidenceSha256;
  await f.seal();
  return { config, assignment, approval,
    request: () => ({ ...f.request(), assignmentId: assignment.id }) };
}

async function useReviewedAssignmentApproval(f, s) {
  const base = structuredClone(s.approval);
  for (const key of ['coverageCandidateId', 'targetRepository', 'coverageProposal', 'coverageHandoff'])
    delete base[key];
  const pin = record => ({ id: record.id, version: record.version, sha256: hash(json(record)) });
  s.approval = { ...base, schema: 'controller-authoring-assignment-approval-v1', review: {
    assignmentSha256: hash(json(s.assignment)),
    investigation: pin(f.ledger.get('investigation', s.assignment.investigationId)),
    improvement: pin(f.ledger.get('areaToImprove', s.assignment.improvementId)),
    coveragePlan: pin(f.ledger.get('testCoveragePlan', s.assignment.testCoveragePlanId))
  } };
  s.config.stage2.skillDirectory = join(f.directory, 'absent-coverage-analyzer');
  writeFileSync(s.request().sourceApprovalPath, json(s.approval));
  f.contract.loop.authoring.sourceApprovalSha256 = hash(readFileSync(s.request().sourceApprovalPath));
  Object.assign(f.manifest.authoring, f.contract.loop.authoring);
  await f.seal();
}

test('native authoring requires exact fitness and reviewer approval plus independent card write authority', async t => {
  const f = await fixture(t, true, { authoring: true, nativeWorkflow: true });
  const s = await authorizeFixture(f);
  await useReviewedAssignmentApproval(f, s);
  const check = () => requireWorkspaceAuthoringSource(s.config, f.ledger, f.repo, s.request(), f.contract);
  assert.equal((await check()).assignmentId, s.assignment.id);
  for (const value of [undefined, '0'.repeat(64)]) {
    s.approval.nativeWorkflowSha256 = value;
    writeFileSync(s.request().sourceApprovalPath, json(s.approval));
    f.contract.loop.authoring.sourceApprovalSha256 = hash(readFileSync(s.request().sourceApprovalPath));
    await assert.rejects(check(), /own exact source authorization/);
  }
  const restricted = await fixture(t, true, { authoring: true, nativeWorkflow: true });
  const authorization = await authorizeFixture(restricted, { excludeCard: true });
  await useReviewedAssignmentApproval(restricted, authorization);
  await assert.rejects(requireWorkspaceAuthoringSource(authorization.config, restricted.ledger,
    restricted.repo, authorization.request(), restricted.contract), /card is outside/);
  assert.equal(f.ledger.status().operations.length, 0);
  assert.equal(restricted.ledger.status().operations.length, 0);
});

for (const reviewed of [false, true])
test(`source-qualified ${reviewed ? 'reviewed-assignment' : 'held-stage2'} fixture dispatch independently accepts and resumes without another remote job`, async t => {
  const f = await fixture(t, true, { authoring: true });
  const s = await authorizeFixture(f), calls = [];
  if (reviewed) await useReviewedAssignmentApproval(f, s);
  assert.equal((await requireWorkspaceAuthoringSource(s.config, f.ledger, f.repo, s.request(), f.contract))
    .assignmentId, s.assignment.id);
  const transport = async (operation, _input, directory) => {
    calls.push(operation);
    if (operation === 'preflight') return { preflightPassed: true };
    if (operation === 'submit') return { jobId: 'fixture-job' };
    if (operation === 'inspect') return f.observation;
    assert.equal(operation, 'download');
    cpSync(join(f.directory, 'job-artifact'), join(directory, 'job-artifact'),
      { recursive: true, force: false, errorOnExist: true });
    return f.observation;
  };
  const execute = (options = {}) => runAgencyWorkspaceAuthoring(s.config, f.ledger,
    f.repo, s.request(), options, { transport });
  const accepted = await execute();
  assert.equal(accepted[0].status, 'passed');
  const receipt = JSON.parse(readFileSync(accepted[0].artifactRefs[0]));
  assert.equal(receipt.controllerAcceptance, true);
  assert.equal(receipt.publicationPerformed, false);
  assert.equal(receipt.sourceAuthorization.assignmentId, s.assignment.id);
  assert.equal(receipt.sourceAuthorization.mode, reviewed ? 'reviewed-assignment' : 'held-stage2');
  assert.deepEqual(await execute({ resume: true }), accepted);
  assert.deepEqual(calls, ['preflight', 'submit', 'inspect', 'download']);
  await assert.rejects(dispatch(s.config, f.ledger, s.assignment.id), /ordinary dispatch cannot duplicate/);
});

for (const reviewed of [false, true])
test(`qualified ${reviewed ? 'reviewed-assignment' : 'held-stage2'} authoring rejects a truncated capture and superseded plan`, async t => {
  const f = await fixture(t, true, { authoring: true });
  const s = await authorizeFixture(f);
  if (reviewed) await useReviewedAssignmentApproval(f, s);
  const check = () => requireWorkspaceAuthoringSource(s.config, f.ledger, f.repo, s.request(), f.contract);
  const skillDirectory = s.config.stage2.skillDirectory;
  s.config.stage2.skillDirectory = join(f.directory, 'absent-skill');
  if (reviewed) await check();
  else await assert.rejects(check(), error => error.code === 'blocked-skill');
  s.config.stage2.skillDirectory = skillDirectory;
  const path = s.request().evidencePath, evidence = JSON.parse(readFileSync(path));
  const bytes = readFileSync(path);
  evidence.records[0].bodyBase64 = Buffer.from('truncated').toString('base64');
  writeFileSync(path, json(evidence));
  s.approval.evidenceSha256 = hash(readFileSync(path));
  writeFileSync(s.request().sourceApprovalPath, json(s.approval));
  Object.assign(f.contract.loop.authoring, {
    evidenceSha256: s.approval.evidenceSha256,
    sourceApprovalSha256: hash(readFileSync(s.request().sourceApprovalPath))
  });
  await assert.rejects(check(), /complete authenticated source capture/);
  writeFileSync(path, bytes);
  s.approval.evidenceSha256 = hash(bytes);
  writeFileSync(s.request().sourceApprovalPath, json(s.approval));
  Object.assign(f.contract.loop.authoring, {
    evidenceSha256: s.approval.evidenceSha256,
    sourceApprovalSha256: hash(readFileSync(s.request().sourceApprovalPath))
  });
  const plan = f.ledger.get('testCoveragePlan', s.assignment.testCoveragePlanId);
  f.ledger.put({ ...plan, version: plan.version + 1, rationale: 'Superseded synthetic analysis.' });
  await assert.rejects(check(), /plan or improvement was superseded/);
  assert.equal(f.ledger.status().operations.length, 0);
});

test('reviewed-assignment approval cannot omit native record pins or waive held Stage2 inputs', async t => {
  const f = await fixture(t, true, { authoring: true }), s = await authorizeFixture(f);
  await useReviewedAssignmentApproval(f, s);
  const check = async change => {
    const approval = structuredClone(s.approval);
    change(approval);
    writeFileSync(s.request().sourceApprovalPath, json(approval));
    f.contract.loop.authoring.sourceApprovalSha256 = hash(readFileSync(s.request().sourceApprovalPath));
    await assert.rejects(requireWorkspaceAuthoringSource(s.config, f.ledger, f.repo, s.request(), f.contract),
      error => error.code === 'blocked-authorization');
  };
  await check(approval => { delete approval.review; });
  await check(approval => { approval.review.assignmentSha256 = '0'.repeat(64); });
  await check(approval => { approval.review.coveragePlan.sha256 = '0'.repeat(64); });
  await check(approval => { approval.review.improvement.sha256 = '0'.repeat(64); });
  await check(approval => { approval.review.investigation.version++; });
  await check(approval => { approval.coverageHandoff = { path: 'held-handoff.json', sha256: '0'.repeat(64) }; });
  for (const key of ['coverageCandidateId', 'targetRepository', 'coverageProposal', 'coverageHandoff'])
    await check(approval => { approval[key] = null; });
  await check(approval => { approval.schema = 'unknown-approval'; });
  assert.equal(f.ledger.status().operations.length, 0);
});

test('independent authoring acceptance permits a first-pass candidate but not the old protocol', async t => {
  const f = await fixture(t, false, { authoring: true });
  assert.deepEqual(workspaceAuthoringContract(f.repo, f.request()), f.contract);
  f.contract.loop.authoring.baselineTests = 4;
  assert.throws(() => workspaceAuthoringContract(f.repo, f.request()), /larger exact population/);
  f.contract.loop.authoring.baselineTests = 3;
  f.contract.loop.authoring.projectName = '@officeagent-agent/office-agent';
  assert.throws(() => workspaceAuthoringContract(f.repo, f.request()), /own project/);
  f.contract.loop.authoring.projectName = '@officeagent-agent/excel-agent';
  assert.throws(() => workspaceLoopContract(f.repo, f.request()), /isolated workspace/);
  await assert.rejects(verifyWorkspaceLoop(f.contract, f.directory, f.observation,
    'fixture-job', f.workspace, f.observation.build.startTime), /type-only verifier/);
  const accepted = await f.verify();
  assert.equal(accepted.sourceRevision, f.result.candidate);
  assert.equal(accepted.rounds.length, 1);
  assert.equal(accepted.controllerAcceptance, true);
  assert.equal(accepted.authoring.evidenceSha256, f.manifest.authoring.evidenceSha256);
  assert.equal(f.git(f.workspace, ['rev-parse', 'HEAD']), f.manifest.baseRevision);
  assert.equal(f.git(f.workspace, ['status', '--porcelain']), '');
});

test('authoring acceptance independently checks assertion failure and its committed repair', async t => {
  const f = await fixture(t, false, { authoring: true, assertionRepair: true });
  assert.equal((await f.verify()).rounds.length, 2);
  const failed = f.state.rounds[0];
  const stage = failed.stages.at(-1);
  const text = `FAIL ${f.manifest.testPopulation.path}\nTests: 0 total\n`;
  writeFileSync(join(f.root, stage.log), text);
  stage.logSha256 = hash(text);
  await f.seal();
  await assert.rejects(f.verify(), /real scoped test-type or authorized assertion/);
});

test('authoring acceptance rejects even resealed substituted evidence and missing source reads', async t => {
  const f = await fixture(t, false, { authoring: true });
  f.state.evidenceReadSha256 = '0'.repeat(64);
  await f.seal();
  await assert.rejects(f.verify(), /approved source payload/);
  f.state.evidenceReadSha256 = f.manifest.authoring.evidenceSha256;
  f.state.skillReadRanges['workflow.md'] = [[1, 1]];
  await f.seal();
  await assert.rejects(f.verify(), /complete pinned native skill documents/);
  f.state.skillReadRanges['workflow.md'] = [[1, 2]];
  writeFileSync(join(f.root, 'evidence.json'), '{"schema":"substituted"}');
  await f.seal();
  await assert.rejects(f.verify(), /approved source payload/);
});

test('authoring acceptance preserves the original assertions and exact enlarged population', async t => {
  const f = await fixture(t, false, { authoring: true });
  const source = readFileSync(join(f.root, 'candidate.test.ts'), 'utf8');
  writeFileSync(join(f.root, 'candidate.test.ts'), source.replace('value.enabled).toBe(true)', 'value.enabled).toBe(false)'));
  await f.seal();
  await assert.rejects(f.verify(), /preserve every byte/);
  writeFileSync(join(f.root, 'candidate.test.ts'), source);
  const final = f.result.stages.at(-1);
  const text = `PASS ${f.manifest.testPopulation.path}\nTest Suites: 1 passed, 1 total\nTests: 3 passed, 3 total\n`;
  writeFileSync(join(f.root, final.log), text);
  final.logSha256 = hash(text);
  await f.seal();
  await assert.rejects(f.verify(), /exact configured integration population/);
});

test('unlimited authoring still cannot dispatch with a synthetic approval or a held proposal', async t => {
  const f = await fixture(t, true, { authoring: true });
  const calls = [];
  const config = { limits: {},
    activation: { dispatch: true }, statePolicy: { accessApproved: true } };
  await assert.rejects(runAgencyWorkspaceAuthoring(config, f.ledger, f.repo, f.request(), {}, {
    transport: async operation => { calls.push(operation); throw new Error('Unexpected transport'); }
  }), /held coverage proposal is not explicit/);
  assert.deepEqual(calls, []);
  assert.equal(f.ledger.status().operations.length, 0);
});

test('a reserved authoring qualification consumes the shared job budget and prevents ordinary duplicate dispatch', async t => {
  const f = await fixture(t, true);
  const config = { activation: { dispatch: true }, statePolicy: { accessApproved: true },
    limits: { maxRemoteValidationJobs: 1 }, stateDirectory: join(f.directory, 'state') };
  f.ledger.operation('prior-authoring', 'source-assignment', 'agency-workspace-authoring', {});
  await assert.rejects(dispatch(config, f.ledger, 'source-assignment'), /ordinary dispatch cannot duplicate/);
  const calls = [];
  await assert.rejects(runAgencyWorkspaceLoop(config, f.ledger, f.repo, f.request(), {}, {
    transport: async operation => { calls.push(operation); return { preflightPassed: true }; }
  }), /budget exhausted/);
  assert.deepEqual(calls, ['preflight']);
});

test('independent controller accepts a source-bound fixture loop and imports only candidate objects', async t => {
  const f = await fixture(t);
  assert.deepEqual(workspaceLoopContract(f.repo, f.request()), f.contract);
  const head = f.git(f.workspace, ['rev-parse', 'HEAD']);
  const accepted = await f.verify();
  assert.equal(accepted.controllerAcceptance, true);
  assert.equal(accepted.qualificationOnly, true);
  assert.equal(accepted.productionAssignment, false);
  assert.equal(accepted.publicationPerformed, false);
  assert.equal(accepted.sourceRevision, f.result.candidate);
  assert.deepEqual(accepted.caseCounts, f.manifest.testPopulation);
  assert.equal(f.git(f.workspace, ['rev-parse', 'HEAD']), head);
  assert.equal(f.git(f.workspace, ['status', '--porcelain']), '');
  assert.equal(f.git(f.workspace, ['show', `${accepted.sourceRevision}:${f.contract.loop.allowedPath}`]),
    repaired.trimEnd());
});

test('loop contract rejects sibling write scopes and malformed private contracts', async t => {
  const f = await fixture(t);
  assert.doesNotThrow(() => workspaceLoopContract(f.repo, f.request()));
  assert.throws(() => workspaceLoopContract(undefined, f.request()), /isolated workspace/);
  f.contract.loop.toolNames = 'loop/*';
  assert.throws(() => workspaceLoopContract(f.repo, f.request()), /trusted runner/);
  f.contract.loop.toolNames = loopToolNames;
  f.contract.loop.pluginManifestPath = '.github/other/plugin.json';
  assert.throws(() => workspaceLoopContract(f.repo, f.request()), /trusted runner/);
  f.contract.loop.pluginManifestPath = '.github/plugin.json';
  const agentName = f.contract.request.customAgent.name;
  f.contract.request.customAgent.name = agentName.replace('@', '.md@');
  assert.throws(() => workspaceLoopContract(f.repo, f.request()), /trusted runner/);
  f.contract.request.customAgent.name = agentName;
  f.repo.allowedWritePrefixes = ['test'];
  assert.throws(() => workspaceLoopContract(f.repo, f.request()), /trusted runner/);
  assert.throws(() => workspaceLoopContract(f.repo, null), /isolated workspace/);
  const request = f.request();
  writeFileSync(request.contractPath, 'null');
  request.contractSha256 = hash('null');
  assert.throws(() => workspaceLoopContract(f.repo, request), /explicit bounded OA workspace-loop contract/);
});

test('remote completion is not controller acceptance and cannot override a failed job or actual gate', async t => {
  const f = await fixture(t);
  const prompt = f.contract.request.prompt;
  f.contract.request.prompt = 'Require local controller acceptance before remote success.';
  assert.throws(() => workspaceLoopContract(f.repo, f.request()), /remote completion separately/);
  f.contract.request.prompt = prompt;
  f.contract.request.metadata.completionPolicySha256 = '0'.repeat(64);
  assert.throws(() => workspaceLoopContract(f.repo, f.request()), /remote completion separately/);
  f.contract.request.metadata.completionPolicySha256 = hash(loopCompletionInstructions);
  assert.doesNotThrow(() => workspaceLoopContract(f.repo, f.request()));
  f.observation.job.result = 'Failure';
  await assert.rejects(f.verify(), /identity is not independently qualified/);
  f.observation.job.result = 'Success';
  f.result.controllerAcceptance = true;
  await f.seal();
  await assert.rejects(f.verify(), /trusted loop manifest/);
  f.result.controllerAcceptance = false;
  f.result.stages[0].exitCode = 1;
  await f.seal();
  await assert.rejects(f.verify(), /green job cannot substitute/);
  f.result.stages[0].exitCode = 0;
  await f.seal();
  assert.equal((await f.verify()).controllerAcceptance, true);
});

test('independent acceptance rejects altered producer identity, full logs and native preparation', async t => {
  const f = await fixture(t);
  const originalLog = f.observation.logs[1].lines[0];
  f.observation.logs[1].lines[0] = 'Model says everything passed.';
  await assert.rejects(f.verify(), /producer seal/);
  f.observation.logs[1].lines[0] = originalLog;
  const path = join(f.root, 'round-final-compile.log'), bytes = readFileSync(path);
  writeFileSync(path, 'Substituted output.\n');
  await assert.rejects(f.verify(), /full artifact/);
  writeFileSync(path, bytes);
  f.prepared.sourceBlobs['router.md'] = '0'.repeat(40);
  await f.seal();
  await assert.rejects(f.verify(), /base tree/);
});

test('even resealed fixture results cannot substitute assertions, cases or another build cache', async t => {
  const f = await fixture(t);
  f.manifest.nugetDirectory = join(f.directory, 'pilot-nuget-99');
  await f.seal();
  await assert.rejects(f.verify(), /manifest/);
  f.manifest.nugetDirectory = join(f.directory, 'pilot-nuget-100');
  f.result.testPopulation = { ...f.result.testPopulation, tests: 2 };
  await f.seal();
  await assert.rejects(f.verify(), /manifest/);
  f.result.testPopulation = f.manifest.testPopulation;
  writeFileSync(join(f.root, 'candidate.test.ts'), repaired.replace('toBe(true)', 'toBe(false)'));
  await f.seal();
  await assert.rejects(f.verify(), /executable test/);
});

test('synthetic loop dispatch persists final candidate acceptance and resumes without resubmission', async t => {
  const f = await fixture(t, true);
  const config = { activation: { dispatch: true }, statePolicy: { accessApproved: true },
    limits: { maxRemoteValidationJobs: 1 }, stateDirectory: join(f.directory, 'state') };
  const request = f.request(), calls = [];
  const transport = async (operation, input, directory) => {
    calls.push(operation);
    assert.equal(input.contract.schema, 'agency-oa-workspace-loop-contract-v1');
    if (operation === 'preflight') return { preflightPassed: true };
    if (operation === 'submit') return { jobId: f.observation.job.jobId };
    if (operation === 'inspect') return f.observation;
    assert.equal(operation, 'download');
    cpSync(join(f.directory, 'job-artifact'), join(directory, 'job-artifact'),
      { recursive: true, force: false, errorOnExist: true });
    return f.observation;
  };
  const execute = (input = request, options = {}) => runAgencyWorkspaceLoop(
    config, f.ledger, f.repo, input, options, { transport });
  const accepted = await execute();
  assert.equal(accepted[0].status, 'passed');
  assert.equal(accepted[0].sourceRevision, f.result.candidate);
  assert.match(accepted[0].commandOrRunUrl, /^agency-workspace-loop:fixture-job\/build\/100$/);
  const receipt = JSON.parse(readFileSync(accepted[0].artifactRefs[0], 'utf8'));
  assert.equal(receipt.controllerAcceptance, true);
  assert.equal(receipt.baseRevision, request.baseRevision);
  assert.equal(receipt.sourceRevision, f.result.candidate);
  assert.equal(receipt.productionAssignment, false);
  assert.deepEqual(await execute(request, { resume: true }), accepted);
  assert.deepEqual(calls, ['preflight', 'submit', 'inspect', 'download']);
  await assert.rejects(execute({ ...request, id: 'another-loop' }), /budget exhausted/);
  assert.equal(calls.filter(operation => operation === 'submit').length, 1);
  assert.equal(f.ledger.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE kind='agency-workspace-loop'").get().n, 1);
  assert.equal(f.git(f.workspace, ['rev-parse', 'HEAD']), request.baseRevision);
  assert.equal(f.git(f.workspace, ['status', '--porcelain']), '');
});

test('synthetic loop dispatch shares the single-job budget with prior fixed validation', async t => {
  const f = await fixture(t, true);
  const config = { activation: { dispatch: true }, statePolicy: { accessApproved: true },
    limits: { maxRemoteValidationJobs: 1 }, stateDirectory: join(f.directory, 'state') };
  f.ledger.operation('prior-fixed-validation', 'fixture', 'agency-remote-validation', {});
  const calls = [];
  await assert.rejects(runAgencyWorkspaceLoop(config, f.ledger, f.repo, f.request(), {}, {
    transport: async operation => { calls.push(operation); return { preflightPassed: true }; }
  }), /budget exhausted/);
  assert.deepEqual(calls, ['preflight']);
  assert.equal(f.ledger.db.prepare("SELECT COUNT(*) AS n FROM operations WHERE kind='agency-workspace-loop'").get().n, 0);
});

test('loop qualification reaches preflight without an aggregate job ceiling', async t => {
  const f = await fixture(t, true);
  const config = { activation: { dispatch: true }, statePolicy: { accessApproved: true },
    limits: {}, stateDirectory: join(f.directory, 'state') };
  for (let index = 0; index < 11; index++)
    f.ledger.operation(`prior-${index}`, 'prior-assignment', 'agency-remote-validation', {});
  const calls = [];
  await assert.rejects(runAgencyWorkspaceLoop(config, f.ledger, f.repo, f.request(), {}, {
    transport: async operation => { calls.push(operation); return { preflightPassed: false }; }
  }), /no job reserved/);
  assert.deepEqual(calls, ['preflight']);
  assert.equal(f.ledger.status().operations.length, 11);
});
