import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync, existsSync, mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, linkSync, renameSync
} from 'node:fs';
import { execFileSync, spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  authoringLoopMcpConfiguration, authoringLoopToolNames,
  createLoopTools, createNativeReviewTools, finalizeLoop, loadLoopManifest, loopDigest,
  nativeReviewArguments, nativeReviewEnvironment, nativeReviewerAgent, prepareLoop,
  requireAppendOnlyTestChange, requireCardChange, requireFitnessOutcome, requireNativeWorkflow,
  requirePassedTestPopulation, requireTypeOnlyChange,
  runLoopStage, validationEnvironment
} from '../scripts/validation/agency-workspace-loop.mjs';

const original = "import { run } from './harness';\nit.each([{ settings: { gate: true } }])('keeps every assertion', ({ settings }) => {\n  expect(run(settings)).toBe(true);\n});\n";
const repaired = original.replace('it.each(', 'it.each<{ settings: Record<string, boolean> }>(');
const sessionId = '11111111-1111-4111-8111-111111111111';
test('Agency-managed authoring binds default or explicit Copilot home with a shell-free bounded entry', t => {
  const root = mkdtempSync(join(tmpdir(), 'agency loop proxy '));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const directory = join(root, 'pilot-loop-100');
  mkdirSync(directory);
  const output = join(root, 'called.json');
  writeFileSync(join(directory, 'server.mjs'), `
import { writeFileSync } from 'node:fs';
export function serve() {
  writeFileSync(process.env.PILOT_PROBE_OUTPUT, JSON.stringify({
    integrationPresent: process.env.GITHUB_COPILOT_INTEGRATION_ID === 'synthetic-only',
    home: process.env.COPILOT_HOME,
    session: process.env.AGENCY_SESSION_ID
  }), { flag: 'wx' });
}
`);
  const legacy = authoringLoopMcpConfiguration();
  assert.equal(legacy.command, 'node.exe');
  assert.equal(legacy.args[0], '-e');
  const config = authoringLoopMcpConfiguration({ agencyManaged: true });
  assert.equal(config.type, 'local');
  assert.equal(config.command, 'agency.exe');
  assert.deepEqual(config.tools, [...authoringLoopToolNames]);
  assert.deepEqual(config.args.slice(0, 3), ['mcp', 'local', '--command']);
  assert.equal(config.args[4], '--env-var');
  const command = config.args[3];
  assert.ok(!/[|><&;`$"']/.test(command), 'The upstream must not select Agency shell parsing.');
  const [name, ...value] = config.args[5].split('=');
  assert.equal(name, 'PEA_LOOP_BOOTSTRAP');
  assert.ok(value.join('=').startsWith('data:text/javascript,'));
  const [executable, ...args] = command.split(' ');
  assert.equal(executable, 'node.exe');
  for (const home of [undefined, '   ', join(root, 'explicit home')]) {
    const environment = {
      ...process.env, AGENT_TEMPDIRECTORY: root, BUILD_BUILDID: '100',
      HOME: root, USERPROFILE: root, AGENCY_SESSION_ID: sessionId,
      PILOT_PROBE_OUTPUT: output, GITHUB_COPILOT_INTEGRATION_ID: 'synthetic-only',
      [name]: value.join('=')
    };
    delete environment.COPILOT_HOME;
    if (home !== undefined) environment.COPILOT_HOME = home;
    execFileSync(process.execPath, args, { env: environment });
    assert.deepEqual(JSON.parse(readFileSync(output)), {
      integrationPresent: true, home: home?.trim() || join(root, '.copilot'), session: sessionId
    });
    rmSync(output);
  }
  assert.throws(() => authoringLoopMcpConfiguration({ agencyManaged: 'yes' }), /explicit Agency/);
});

test('Agency-managed default-home bootstrap reads only the exact pinned initial request', t => {
  const f = fixture(t, () => assert.fail('Evidence delivery cannot execute product commands.'), { authoring: true });
  const bytes = readFileSync(f.m.authoring.evidencePath);
  rmSync(f.m.authoring.evidencePath);
  f.m.authoring.evidenceTransport = 'request-session-v1';
  writeFileSync(f.manifestPath, JSON.stringify(f.m));
  const home = join(f.root, '.copilot');
  const events = join(home, 'session-state', sessionId, 'events.jsonl');
  mkdirSync(dirname(events), { recursive: true });
  const prompt = `Approved request.\n<approved-evidence-base64>\n${bytes.toString('base64')}\n</approved-evidence-base64>\n`;
  const put = id => writeFileSync(events, [
    { type: 'session.start', data: { sessionId: id } },
    { type: 'user.message', id: 'initial-request-event', data: { content: prompt } }
  ].map(event => JSON.stringify(event)).join('\n') + '\n');
  const directory = join(f.root, `pilot-loop-${f.m.buildId}`);
  mkdirSync(directory);
  const runner = pathToFileURL(fileURLToPath(
    new URL('../scripts/validation/agency-workspace-loop.mjs', import.meta.url))).href;
  writeFileSync(join(directory, 'server.mjs'), `
import { createLoopTools, loadLoopManifest } from ${JSON.stringify(runner)};
export async function serve() {
  const tools = createLoopTools(loadLoopManifest(${JSON.stringify(f.manifestPath)}, { allowPendingEvidence: true }));
  console.log(JSON.stringify(await tools.call('loop_evidence')));
}
`);
  const config = authoringLoopMcpConfiguration({ agencyManaged: true });
  const [name, ...value] = config.args[5].split('=');
  const environment = { ...process.env, HOME: f.root, USERPROFILE: f.root,
    AGENT_TEMPDIRECTORY: f.root, BUILD_BUILDID: f.m.buildId, AGENCY_SESSION_ID: sessionId,
    [name]: value.join('=') };
  delete environment.COPILOT_HOME;
  const args = config.args[3].split(' ').slice(1);
  const invoke = () => execFileSync(process.execPath, args, {
    env: environment, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe']
  });
  put('22222222-2222-4222-8222-222222222222');
  assert.throws(invoke, /different session/);
  put(sessionId);
  assert.equal(JSON.parse(invoke()).sha256, f.m.authoring.evidenceSha256);
  assert.deepEqual(readFileSync(f.m.authoring.evidencePath), bytes);
});

function fixture(t, execute, {
  authoring = false, native = false, skillBody = 'Read the source-bound native workflow.\n'
} = {}) {
  const root = mkdtempSync(join(tmpdir(), 'agency-workspace-loop-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'source'), directory = join(root, 'private');
  mkdirSync(workspace);
  mkdirSync(directory);
  const git = args => execFileSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.hooksPath=NUL',
    '-c', 'commit.gpgsign=false', '-C', workspace, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  git(['init', '-q']);
  git(['config', 'user.name', 'Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  git(['config', 'core.autocrlf', 'false']);
  git(['commit', '--allow-empty', '-qm',
    `Fixture parent\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>\nCopilot-Session: ${sessionId}`]);
  const project = authoring ? 'excel-agent' : 'office-agent';
  const allowedPath = authoring ? 'agents/excel-agent/tests/integration/test.contract.test.ts' : 'test.contract.test.ts';
  mkdirSync(dirname(join(workspace, allowedPath)), { recursive: true });
  const requiredSkillPaths = ['router.md', 'workflow.md'];
  const scripts = join(workspace, 'docs', 'skills', 'Integration-test-core', 'scripts');
  mkdirSync(scripts, { recursive: true });
  writeFileSync(join(scripts, 'resolve-project.mjs'), `
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
assert.deepEqual(process.argv.slice(2), ['--name', '@officeagent-agent/${project}', '--json']);
assert.equal(existsSync(join(dirname(process.cwd()), 'private', 'inspection-project.json')), false);
console.log(JSON.stringify({ matchCount: 1, matches: [{ project: 'agents/${project}' }] }));
`);
  writeFileSync(join(scripts, 'validate-card-scores.mjs'),
    "console.log(JSON.stringify({ strict: false, scoreGateResult: 'passed' }));\n");
  for (const path of requiredSkillPaths) writeFileSync(join(workspace, path), skillBody);
  writeFileSync(join(workspace, allowedPath), original);
  const nativeWorkflow = native ? {
    cardPath: `agents/${project}/tests/integration/behavior-cards/seam.behavior-card.md`,
    fitness: ['mutation', 'refactor'].map(kind => ({
      kind, path: 'modules/runtime/src/policy.ts', find: 'const route = true;',
      replace: kind === 'mutation' ? 'const route = false;' : 'const route = Boolean(1);'
    })),
    reviewerAgentPath: 'plugins/native/agents/reviewer.md', reviewerAgentSha256: loopDigest(nativeReviewerAgent),
    reviewerModel: 'synthetic-fixture-only',
    coverageGoal: 'Append the approved caller regression case; preserve existing owner coverage.'
  } : undefined;
  if (nativeWorkflow) {
    mkdirSync(dirname(join(workspace, nativeWorkflow.cardPath)), { recursive: true });
    writeFileSync(join(workspace, nativeWorkflow.cardPath),
      '# Seam\n\n## Invariants\n\n- Preserve routing.\n\n## Test coverage score\n\nScore: 6\nBasis: Existing coverage.\n');
    mkdirSync(join(workspace, 'modules/runtime/src'), { recursive: true });
    writeFileSync(join(workspace, 'modules/runtime/src/policy.ts'), 'export const route = true;\n');
    writeFileSync(join(scripts, 'probe-fitness.mjs'), '// Offline native-probe fixture, not product evidence.\n');
  }
  git(['add', '.']);
  git(['commit', '-qm', `Fixture\n\nCo-authored-by: Copilot <223556219+Copilot@users.noreply.github.com>\nCopilot-Session: ${sessionId}`]);
  const profilePath = join(directory, 'profile.ps1');
  const nativeCommandPath = join(directory, 'native-command.ps1');
  writeFileSync(profilePath, 'exit 0\n');
  writeFileSync(nativeCommandPath, 'exit 0\n');
  const runnerPath = fileURLToPath(new URL('../scripts/validation/agency-workspace-loop.mjs', import.meta.url));
  const m = { schema: authoring ? 'agency-workspace-authoring-manifest-v1'
    : 'agency-workspace-loop-manifest-v1', workspace, directory,
    baseRevision: git(['rev-parse', 'HEAD']).trim(), allowedPath, requiredSkillPaths, sessionId,
    buildId: '100', pipelineRevision: 'b'.repeat(40), maximumRepairs: 2,
    executable: join(root, 'pwsh.exe'), nugetDirectory: join(root, 'pilot-nuget-100'),
    sourceInputs: [allowedPath, ...requiredSkillPaths],
    stageTimeoutMs: 60000, deadline: new Date(Date.now() + 600000).toISOString(),
    testPopulation: { suites: 1, tests: authoring ? 4 : 3,
      path: authoring ? 'tests/integration/test.contract.test.ts' : allowedPath },
    profilePath, profileSha256: loopDigest(readFileSync(profilePath)),
    nativeCommandPath, nativeCommandSha256: loopDigest(readFileSync(nativeCommandPath)),
    runnerPath, runnerSha256: loopDigest(readFileSync(runnerPath)) };
  if (authoring) {
    const evidencePath = join(directory, 'evidence.json');
    const body = JSON.stringify({ behavior: 'Fixture only: append a new integration assertion.' });
    writeFileSync(evidencePath, JSON.stringify({ schema: 'controller-authoring-evidence-v1',
      records: [{ reference: { sha256: loopDigest(body) }, bodyBase64: Buffer.from(body).toString('base64') }] }));
    m.authoring = { projectName: '@officeagent-agent/excel-agent', projectPath: 'agents/excel-agent',
      evidencePath, evidenceSha256: loopDigest(readFileSync(evidencePath)),
      baselineTests: 3,
      sourceApprovalSha256: loopDigest('Synthetic test approval, not real coverage qualification.') };
    if (nativeWorkflow) {
      m.authoring.nativeWorkflow = nativeWorkflow;
      m.reviewAgentSpec = `ado-git:fixture/Fixture/fixture:plugins/native/agents/reviewer@${m.pipelineRevision}`;
      writeFileSync(join(directory, 'reviewer.md'), nativeReviewerAgent);
      m.sourceInputs.push(nativeWorkflow.cardPath, nativeWorkflow.fitness[0].path,
        'docs/skills/Integration-test-core/scripts/probe-fitness.mjs');
    }
  }
  const manifestPath = join(directory, 'manifest.json');
  writeFileSync(manifestPath, JSON.stringify(m));
  const runStage = async (manifest, stage, round, candidate) => {
    const result = execute ? await execute(stage, round) : round === 0 ? 1 : 0;
    const exitCode = typeof result === 'number' ? result : result.exitCode;
    const log = `round-${round}-${stage}.log`;
    const text = typeof result === 'object' ? result.text
      : exitCode ? 'test.contract.test.ts: error TS2322: incompatible test settings.\n' : `Executed ${stage}.\n`;
    writeFileSync(join(directory, log), text);
    return { stage, candidate, exitCode, log, logSha256: loopDigest(text) };
  };
  const tools = createLoopTools(loadLoopManifest(manifestPath), { runStage, validationPollMs: 0 });
  const plan = async () => {
    for (const path of requiredSkillPaths) await tools.call('loop_read', { path });
    if (authoring) await tools.call('loop_evidence');
    await tools.call('loop_plan', { plan: 'Harness-only type repair. Preserve behavior cards, cases and all runtime assertions.' });
  };
  return { m, tools, git, root, workspace, directory, manifestPath, runStage, plan };
}

const newCases = "\nit('adds the approved behavior', () => { expect(run({ gate: false })).toBe(false); });\n";

test('native card writes preserve invariants, require exact scope and share the authoring plan guard', async t => {
  const f = fixture(t, () => 0, { authoring: true, native: true });
  const path = f.m.authoring.nativeWorkflow.cardPath;
  const before = readFileSync(join(f.workspace, path), 'utf8');
  const content = before.replace('Existing coverage.', 'Added source-bound routing cases; broader client matrices remain unverified.');
  await assert.rejects(f.tools.call('loop_write_card', { path, content }), /evidence-bound/);
  await f.plan();
  await assert.rejects(f.tools.call('loop_write_card', {
    path: path.replace('seam.', 'unapproved.'), content
  }), /evidence-bound/);
  await assert.rejects(f.tools.call('loop_write_card', {
    path, content: content.replace('Preserve routing.', 'Relax routing.')
  }), /preserve its intent/);
  await assert.rejects(f.tools.call('loop_write_card', {
    path, content: content.replace('Score: 6', 'Score: 11')
  }), /preserve its intent/);
  assert.equal((await f.tools.call('loop_write_card', { path, content })).written, path);
  assert.equal(readFileSync(join(f.workspace, path), 'utf8'), content);
  f.tools.assertSource();
  await f.tools.call('loop_write', { path: f.m.allowedPath, content: original + newCases });
  await assert.rejects(f.tools.call('loop_validate'), /population did not pass/);
  assert.deepEqual(f.git(['diff', '--name-only', f.m.baseRevision, 'HEAD']).trim().split(/\r?\n/).sort(),
    [path, f.m.allowedPath].sort());
});

test('native fitness rejects compilation, environment, incomplete population and restoration failures', () => {
  const population = { suites: 1, tests: 4, path: 'tests/integration/seam.test.ts' };
  const killed = `FAIL ${population.path}\nTest Suites: 1 failed, 1 total\nTests: 1 failed, 3 passed, 4 total\n`;
  const passed = `PASS ${population.path}\nTest Suites: 1 passed, 1 total\nTests: 4 passed, 4 total\n`;
  const make = kind => ({ kind, path: 'modules/runtime/src/policy.ts',
    sourceBeforeSha256: 'a'.repeat(64), sourceAfterSha256: 'a'.repeat(64),
    command: { exitCode: 0 },
    result: { ok: true, kind, file: 'modules/runtime/src/policy.ts', restoreFailed: false,
      baselineStatus: null, satisfied: true, exitCode: 0,
      verdict: kind === 'mutation' ? 'killed' : 'robust', mutatedStatus: kind === 'mutation' ? 1 : 0 },
    stages: [{ stage: 'compile', exitCode: 0 }, { stage: 'test', exitCode: kind === 'mutation' ? 1 : 0 }] });
  for (const kind of ['mutation', 'refactor']) {
    const record = make(kind);
    assert.doesNotThrow(() => requireFitnessOutcome(record, population,
      () => kind === 'mutation' ? killed : passed));
    for (const corrupt of [
      value => { value.stages[0].exitCode = 1; },
      value => { value.sourceAfterSha256 = 'b'.repeat(64); },
      value => { value.result.restoreFailed = true; },
      value => { value.result.mutatedStatus = 2; },
      value => { value.command.exitCode = 2; }
    ]) {
      const changed = structuredClone(record);
      corrupt(changed);
      assert.throws(() => requireFitnessOutcome(changed, population, () => killed), /Native fitness/);
    }
  }
  for (const text of [
    'Authentication failed.\n',
    killed.replace('1 failed, 3 passed, 4 total', '1 failed, 2 passed, 3 total'),
    killed.replace('1 failed, 3 passed, 4 total', '1 failed, 2 passed, 1 skipped, 4 total'),
    killed.replace(population.path, `${population.path}.other`),
    killed + 'Tests: 1 failed, 3 passed, 4 total\n'
  ]) assert.throws(() => requireFitnessOutcome(make('mutation'), population, () => text),
    /real scoped assertion/);
  assert.throws(() => requireFitnessOutcome(make('refactor'), population, () => killed),
    /population did not pass/);
});

test('native validation requires an updated card and legacy authoring cannot acquire card writes', async t => {
  const f = fixture(t, () => 0, { authoring: true, native: true });
  await f.plan();
  await f.tools.call('loop_write', { path: f.m.allowedPath, content: original + newCases });
  await assert.rejects(f.tools.call('loop_validate'), /Update the exact behavior-card/);
  const legacy = fixture(t, () => 0, { authoring: true });
  await legacy.plan();
  await assert.rejects(legacy.tools.call('loop_write_card', {
    path: 'agents/excel-agent/tests/integration/behavior-cards/seam.behavior-card.md', content: 'Score: 9'
  }), /evidence-bound/);
});

test('native workflow rejects traversal, unpinned probes and incomplete reviewer or card contracts', () => {
  const value = {
    cardPath: 'agents/office-agent/tests/integration/behavior-cards/seam.behavior-card.md',
    fitness: ['mutation', 'refactor'].map(kind => ({
      kind, path: 'modules/runtime/src/policy.ts', find: 'true', replace: 'false'
    })),
    reviewerAgentPath: 'plugins/native/agents/reviewer.md', reviewerAgentSha256: loopDigest(nativeReviewerAgent),
    reviewerModel: 'synthetic-fixture-only'
  };
  assert.doesNotThrow(() => requireNativeWorkflow(value, 'agents/office-agent'));
  for (const bad of [
    { ...value, cardPath: value.cardPath.replace('/seam.', '/../seam.') },
    { ...value, reviewerAgentSha256: null },
    { ...value, reviewerAuthentication: 'unapproved-provider' },
    { ...value, coverageGoal: ' ' },
    { ...value, coverageGoal: 'x'.repeat(8001) },
    { ...value, fitness: value.fitness.slice(0, 1) },
    { ...value, fitness: value.fitness.map(probe => ({ ...probe, path: 'modules/runtime/src/../../secret.ts' })) },
    { ...value, fitness: value.fitness.map(probe => ({ ...probe, replace: probe.find })) }
  ]) assert.throws(() => requireNativeWorkflow(bad, 'agents/office-agent'), /Native workflow requires/);
  assert.throws(() => requireCardChange('# No score section\n', 'Score: 9\nBasis: Invented.\n'), /preserve its intent/);
});

test('independent native review cannot write or submit without complete fresh source and evidence reads', async t => {
  const f = fixture(t, () => 0, { authoring: true, native: true });
  await f.plan();
  const parentState = readFileSync(join(f.directory, 'loop-state.json'));
  const request = { round: 0, candidate: f.m.baseRevision, sessionId: '22222222-2222-4222-8222-222222222222' };
  const review = createNativeReviewTools(f.m, request);
  const verdict = { verdict: 'approved', summary: 'Synthetic readonly review fixture, not product proof.',
    findings: [], residuals: [] };
  await assert.rejects(review.call('loop_write', { path: f.m.allowedPath, content: 'forbidden' }), /readonly native/);
  await assert.rejects(review.call('review_submit', verdict), /complete independent/);
  await assert.rejects(review.call('review_read', { path: '../private/evidence.json' }), /tracked source/);
  const context = await review.call('review_context');
  const evidence = await f.tools.call('loop_evidence');
  assert.deepEqual(context.scope, evidence.scope);
  assert.deepEqual(context.scope, {
    projectPath: f.m.authoring.projectPath,
    coverageGoal: f.m.authoring.nativeWorkflow.coverageGoal,
    allowedWritePaths: [f.m.allowedPath, f.m.authoring.nativeWorkflow.cardPath],
    originalTestsMustBePreserved: true,
    baselineTests: f.m.authoring.baselineTests,
    requiredTestPopulation: f.m.testPopulation,
    sourceApprovalSha256: f.m.authoring.sourceApprovalSha256,
    productSourceEditsAuthorized: false,
    historicalReportResolutionClaimed: false
  });
  assert.equal(context.evidence.records[0].body,
    JSON.parse(evidence.content).records[0].body);
  for (const path of [...f.m.requiredSkillPaths, f.m.allowedPath, f.m.authoring.nativeWorkflow.cardPath]) {
    await review.call('review_read', { path });
  }
  await assert.rejects(review.call('review_submit', { ...verdict,
    findings: [{ path: f.m.allowedPath, line: 1, reason: 'An unresolved real gap cannot be approved.' }] }),
  /complete independent/);
  assert.equal((await review.call('review_submit', verdict)).controllerAcceptance, false);
  assert.deepEqual(readFileSync(join(f.directory, 'loop-state.json')), parentState);
  assert.equal(readFileSync(join(f.workspace, f.m.allowedPath), 'utf8'), original);
  await assert.rejects(review.call('review_read', { path: f.m.allowedPath }), /review already ended/);
  const args = nativeReviewArguments(f.m, request.sessionId, join(f.root, 'private-provider-diagnostics'));
  assert.ok(args.includes('--profile-only'));
  assert.ok(args.includes('--no-default-mcps'));
  assert.ok(args.includes('--no-config-plugins'));
  assert.ok(args.includes('--available-tools') && args.includes('review/*'));
  assert.equal(args[args.indexOf('--agent') + 1], f.m.reviewAgentSpec);
  assert.equal(args[args.indexOf('--source') + 1], 'spec');
  assert.equal(args[args.indexOf('--allow-tool') + 1], 'review');
  assert.throws(() => nativeReviewArguments(f.m, f.m.sessionId, 'private'), /new session/);
});

for (const interrupted of [false, true]) {
  test(`native review ${interrupted ? 'interruption remains uncertain' : 'rejection is a known blocked result, not command uncertainty'}`, async t => {
    const passed = 'PASS tests/integration/test.contract.test.ts\nTest Suites: 1 passed, 1 total\nTests: 4 passed, 4 total\n';
    const killed = 'FAIL tests/integration/test.contract.test.ts\nTest Suites: 1 failed, 1 total\nTests: 1 failed, 3 passed, 4 total\n';
    const f = fixture(t, stage => ({ exitCode: 0, text: stage === 'test' ? passed : 'Synthetic compile/policy.\n' }),
      { authoring: true, native: true });
    await f.plan();
    await f.tools.call('loop_write', { path: f.m.allowedPath, content: original + newCases });
    const card = f.m.authoring.nativeWorkflow.cardPath;
    await f.tools.call('loop_write_card', { path: card,
      content: readFileSync(join(f.workspace, card), 'utf8').replace('Existing coverage.', 'Bounded caller coverage; owner gaps remain residuals.') });
    let reviews = 0;
    const dependencies = {
      runStage: f.runStage,
      async runFitness() {
        return ['mutation', 'refactor'].map(kind => {
          const log = `synthetic-fitness-${kind}.log`;
          writeFileSync(join(f.directory, log), kind === 'mutation' ? killed : passed);
          const path = f.m.authoring.nativeWorkflow.fitness[0].path;
          const digest = loopDigest(readFileSync(join(f.workspace, path)));
          return { kind, path, sourceBeforeSha256: digest, sourceAfterSha256: digest,
            command: { exitCode: 0 },
            result: { ok: true, kind, file: path, restoreFailed: false, baselineStatus: null,
              satisfied: true, exitCode: 0, verdict: kind === 'mutation' ? 'killed' : 'robust',
              mutatedStatus: kind === 'mutation' ? 1 : 0 },
            stages: [{ stage: 'compile', exitCode: 0 },
              { stage: 'test', exitCode: kind === 'mutation' ? 1 : 0, log }] };
        });
      },
      async runReview(manifest, round, candidate) {
        reviews++;
        if (interrupted) throw new Error('Reviewer connection lost before a verdict.');
        return { completed: true, candidate, verdict: 'changes-requested',
          summary: 'Synthetic review: a caller assertion is missing.',
          findings: [{ path: manifest.allowedPath, line: 1, reason: 'Missing consumer assertion.' }],
          residuals: [] };
      }
    };
    const tools = createLoopTools(f.m, dependencies);
    if (interrupted) {
      await assert.rejects(tools.call('loop_validate'), /Reviewer connection lost/);
      assert.equal(JSON.parse(readFileSync(join(f.directory, 'loop-state.json'))).phase, 'uncertain');
      assert.throws(() => createLoopTools(f.m, dependencies), /independent reconciliation/);
    } else {
      const result = await tools.call('loop_validate');
      assert.equal(result.passed, false);
      assert.equal(result.repairable, false);
      assert.equal(result.failureCategory, 'native-coverage-review-rejected');
      assert.match(result.diagnostics, /Missing consumer assertion/);
      assert.ok(result.finishedAt);
      assert.equal(JSON.parse(readFileSync(join(f.directory, 'loop-state.json'))).phase, 'ready');
      await assert.rejects(tools.call('loop_finish'), /actually validated/);
      await assert.rejects(tools.call('loop_write', {
        path: f.m.allowedPath, content: original + newCases + '\n'
      }), /remaining authoring\/repair budget/);
      const recovered = createLoopTools(f.m, dependencies);
      assert.ok((await recovered.call('loop_list')).paths.includes(f.m.allowedPath));
      await assert.rejects(recovered.call('loop_validate'), /Author and plan a new/);
    }
    assert.equal(reviews, 1);
  });
}

test('native review configures only the approved token-free Agency HMAC helper for the same build', () => {
  const executable = join(tmpdir(), 'managed agency', 'agency.exe');
  const m = { buildId: '100', authoring: { nativeWorkflow: {
    reviewerAuthentication: 'agency-pipeline-askpass-hmac-v1'
  } } };
  const environment = { BUILD_BUILDID: '100', AGENCY_CONTEXT: 'synthetic-job-context',
    GITHUB_COPILOT_INTEGRATION_ID: 'synthetic-integration',
    SYSTEM_OIDCREQUESTURI: 'https://example.invalid/synthetic-oidc',
    SYSTEM_ACCESSTOKEN: 'synthetic-existing-pipeline-credential' };
  const before = structuredClone(environment);
  const result = nativeReviewEnvironment(m, executable, environment);
  assert.equal(result.CAPI_HMAC_KEY, `askpass:"${executable}" auth github`);
  assert.equal(result.SYSTEM_ACCESSTOKEN, environment.SYSTEM_ACCESSTOKEN);
  assert.deepEqual(environment, before);
  assert.deepEqual(nativeReviewEnvironment(m, executable, result), result);
  const unquotedExecutable = process.platform === 'win32' ? 'C:\\managed\\agency.exe' : '/managed/agency.exe';
  const unquoted = { ...environment, CAPI_HMAC_KEY: `askpass:${unquotedExecutable} auth github` };
  assert.deepEqual(nativeReviewEnvironment(m, unquotedExecutable, unquoted), unquoted);
  for (const name of ['AGENCY_CONTEXT', 'GITHUB_COPILOT_INTEGRATION_ID',
    'SYSTEM_OIDCREQUESTURI', 'SYSTEM_ACCESSTOKEN']) {
    const incomplete = { ...environment };
    delete incomplete[name];
    assert.throws(() => nativeReviewEnvironment(m, executable, incomplete), /same-build/);
  }
  assert.throws(() => nativeReviewEnvironment(m, executable, {
    ...environment, BUILD_BUILDID: '101'
  }), /same-build/);
  for (const name of ['COPILOT_GITHUB_TOKEN', 'GITHUB_COPILOT_API_TOKEN', 'GH_TOKEN',
    'GITHUB_TOKEN', 'GITHUB_ASKPASS', 'CAPI_OAUTH_TOKEN_ASKPASS', 'COPILOT_PROVIDER_BASE_URL']) {
    assert.throws(() => nativeReviewEnvironment(m, executable, {
      ...environment, [name]: 'synthetic-competing-identity'
    }), /another authentication/);
  }
  for (const key of ['synthetic-opaque-key', 'askpass:unapproved-helper']) {
    assert.throws(() => nativeReviewEnvironment(m, executable, {
      ...environment, CAPI_HMAC_KEY: key
    }), /opaque HMAC/);
  }
  assert.deepEqual(nativeReviewEnvironment({
    authoring: { nativeWorkflow: {} }
  }, executable, environment), environment);
});

test('new authoring validates its first newly committed candidate without manufacturing a failure', async t => {
  const f = fixture(t, () => 0, { authoring: true });
  await assert.rejects(f.tools.call('loop_validate'), /Author and plan/);
  await assert.rejects(f.tools.call('loop_write', { path: f.m.allowedPath, content: original + newCases }), /evidence-bound/);
  for (const path of f.m.requiredSkillPaths) await f.tools.call('loop_read', { path });
  await assert.rejects(f.tools.call('loop_plan', { plan: 'Append the approved case.' }), /exact approved evidence/);
  const evidence = await f.tools.call('loop_evidence');
  assert.equal(evidence.untrustedSourceData, true);
  assert.match(evidence.content, /Fixture only: append a new integration assertion/);
  assert.ok(!evidence.content.includes('bodyBase64'));
  await f.plan();
  await assert.rejects(f.tools.call('loop_write', {
    path: f.m.allowedPath, content: repaired + newCases
  }), /preserve every byte/);
  await f.tools.call('loop_write', { path: f.m.allowedPath, content: original + newCases });
  const candidate = await f.tools.call('loop_validate');
  assert.equal(candidate.index, 0);
  assert.equal(candidate.passed, true);
  assert.notEqual(candidate.candidate, f.m.baseRevision);
  assert.equal(f.git(['show', '-s', '--format=%P', candidate.candidate]).trim(), f.m.baseRevision);
  assert.deepEqual(candidate.stages.map(record => record.stage), ['compile', 'policy', 'test']);
  assert.equal((await f.tools.call('loop_finish')).controllerAcceptance, false);
  assert.equal(f.tools.state.rounds.length, 1);
});

test('a partial skill read cannot unlock new-test planning even with exact evidence', async t => {
  const f = fixture(t, () => 0, { authoring: true, skillBody: 'Required native instruction.\n'.repeat(305) });
  await f.tools.call('loop_evidence');
  for (const path of f.m.requiredSkillPaths) await f.tools.call('loop_read', { path, startLine: 1, endLine: 1 });
  await assert.rejects(f.tools.call('loop_plan', { plan: 'Must not skip the rest of the skill.' }), /Read the pinned native/);
  for (const path of f.m.requiredSkillPaths) await f.tools.call('loop_read', { path, startLine: 2, endLine: 300 });
  await assert.rejects(f.tools.call('loop_plan', { plan: 'The final skill lines are still unread.' }), /Read the pinned native/);
  for (const path of f.m.requiredSkillPaths) await f.tools.call('loop_read', { path, startLine: 301, endLine: 400 });
  assert.equal((await f.tools.call('loop_plan', { plan: 'All pinned native instructions are now read.' })).recorded, true);
});

test('only a real scoped assertion failure permits repairing newly appended cases', async t => {
  const f = fixture(t, (stage, round) => stage === 'test' && round === 0
    ? { exitCode: 1, text: '\x1b[31mFAIL\x1b[0m tests/integration/test.contract.test.ts\nTests: 1 failed, 3 passed, 4 total\n' }
    : 0, { authoring: true });
  await f.plan();
  await f.tools.call('loop_write', { path: f.m.allowedPath, content: original + newCases });
  const failed = await f.tools.call('loop_validate');
  assert.equal(failed.failureCategory, 'candidate-test-assertions');
  assert.equal(failed.repairable, true);
  await f.tools.call('loop_write', { path: f.m.allowedPath,
    content: original + newCases.replace('toBe(false)', 'toEqual(false)') });
  const passed = await f.tools.call('loop_validate');
  assert.equal(passed.passed, true);
  assert.equal(f.git(['show', '-s', '--format=%P', passed.candidate]).trim(), failed.candidate);
  await f.tools.call('loop_finish');
});

test('policy and incomplete test execution cannot unlock an authoring repair', async t => {
  for (const failure of [
    { stage: 'policy', text: 'Policy rejected a test layout.\n' },
    { stage: 'test', text: 'FAIL tests/integration/test.contract.test.ts\nTest Suites: 1 failed, 1 total\nTests: 0 total\n' }
  ]) {
    const f = fixture(t, stage => stage === failure.stage ? { exitCode: 1, text: failure.text } : 0,
      { authoring: true });
    await f.plan();
    await f.tools.call('loop_write', { path: f.m.allowedPath, content: original + newCases });
    const failed = await f.tools.call('loop_validate');
    assert.equal(failed.repairable, false);
    await assert.rejects(f.tools.call('loop_write', {
      path: f.m.allowedPath, content: original + newCases + '\n'
    }), /remaining authoring\/repair budget/);
    await assert.rejects(f.tools.call('loop_validate'), /Author and plan/);
  }
});

test('authoring evidence pins and explicit protocol cannot be downgraded or changed after planning', async t => {
  const f = fixture(t, () => 0, { authoring: true });
  const manifest = JSON.parse(readFileSync(f.manifestPath));
  manifest.schema = 'agency-workspace-loop-manifest-v1';
  writeFileSync(f.manifestPath, JSON.stringify(manifest));
  assert.throws(() => loadLoopManifest(f.manifestPath), /Invalid bounded/);
  manifest.schema = 'agency-workspace-authoring-manifest-v1';
  writeFileSync(f.manifestPath, JSON.stringify(manifest));
  await f.plan();
  writeFileSync(f.m.authoring.evidencePath, '{"behavior":"substituted"}');
  await assert.rejects(f.tools.call('loop_write', {
    path: f.m.allowedPath, content: original + newCases
  }), /trusted runner file/);
  assert.throws(() => loadLoopManifest(f.manifestPath), /trusted runner file/);
});

test('request evidence materialization requires exact approved bytes and cannot replace existing evidence', async t => {
  const f = fixture(t, () => assert.fail('Evidence transport must not execute product gates.'), { authoring: true });
  const bytes = readFileSync(f.m.authoring.evidencePath);
  rmSync(f.m.authoring.evidencePath);
  f.m.authoring.evidenceTransport = 'request-tool-v1';
  writeFileSync(f.manifestPath, JSON.stringify(f.m));
  assert.throws(() => loadLoopManifest(f.manifestPath), /ENOENT|trusted runner file/);
  const m = loadLoopManifest(f.manifestPath, { allowPendingEvidence: true });
  const tools = createLoopTools(m);
  for (const path of m.requiredSkillPaths) await tools.call('loop_read', { path });
  await assert.rejects(tools.call('loop_plan', { plan: 'Do not author without the approved evidence.' }),
    /evidence/);
  await assert.rejects(tools.call('loop_evidence', {
    contentBase64: Buffer.from('substituted').toString('base64')
  }), /approved byte hash/);
  assert.throws(() => readFileSync(m.authoring.evidencePath), /ENOENT/);
  await assert.rejects(tools.call('loop_evidence', { contentBase64: 'a'.repeat(200000) }),
    /bounded request evidence/);
  const result = await tools.call('loop_evidence', { contentBase64: bytes.toString('base64') });
  assert.equal(result.sha256, m.authoring.evidenceSha256);
  assert.deepEqual(readFileSync(m.authoring.evidencePath), bytes);
  assert.equal(loadLoopManifest(f.manifestPath).authoring.evidenceSha256, result.sha256);
  assert.equal((await tools.call('loop_evidence', {
    contentBase64: bytes.toString('base64')
  })).sha256, result.sha256);
  writeFileSync(m.authoring.evidencePath, 'substituted');
  await assert.rejects(tools.call('loop_evidence', { contentBase64: bytes.toString('base64') }),
    /trusted runner file/);
  assert.equal(readFileSync(m.authoring.evidencePath, 'utf8'), 'substituted');
});

test('legacy evidence transport cannot opt into missing or request-supplied evidence', async t => {
  const f = fixture(t, () => 0, { authoring: true });
  const bytes = readFileSync(f.m.authoring.evidencePath);
  await assert.rejects(f.tools.call('loop_evidence', { contentBase64: bytes.toString('base64') }),
    /explicitly approved/);
  rmSync(f.m.authoring.evidencePath);
  assert.throws(() => loadLoopManifest(f.manifestPath, { allowPendingEvidence: true }), /ENOENT|trusted runner file/);
  f.m.authoring.evidenceTransport = 'unknown';
  writeFileSync(f.manifestPath, JSON.stringify(f.m));
  assert.throws(() => loadLoopManifest(f.manifestPath, { allowPendingEvidence: true }), /Authoring requires/);
});

test('managed request evidence reads exact initial-session bytes without a model payload or path', async t => {
  const f = fixture(t, () => assert.fail('Evidence delivery cannot execute product commands.'), { authoring: true });
  const bytes = readFileSync(f.m.authoring.evidencePath);
  rmSync(f.m.authoring.evidencePath);
  f.m.authoring.evidenceTransport = 'request-session-v1';
  writeFileSync(f.manifestPath, JSON.stringify(f.m));
  const home = join(f.root, 'managed-home'), events = join(home, 'session-state', sessionId, 'events.jsonl');
  mkdirSync(dirname(events), { recursive: true });
  const prompt = `Approved private request.\n<approved-evidence-base64>\n${bytes.toString('base64')}\n</approved-evidence-base64>\n`;
  const start = { type: 'session.start', data: { sessionId } };
  const message = { type: 'user.message', id: 'initial-request-event',
    data: { content: prompt, parentAgentTaskId: 'managed-custom-agent-task' } };
  const put = (first = start, request = message) =>
    writeFileSync(events, `${JSON.stringify(first)}\n${JSON.stringify(request)}\n{"type":`);
  const m = loadLoopManifest(f.manifestPath, { allowPendingEvidence: true });
  const environment = { COPILOT_HOME: home, AGENCY_SESSION_ID: sessionId };
  const tools = createLoopTools(m, { requestEnvironment: environment });
  put();
  await assert.rejects(tools.call('loop_evidence', { contentBase64: bytes.toString('base64') }), /no model-supplied/);
  await assert.rejects(tools.call('loop_evidence', { path: events }), /no model-supplied/);
  put({ ...start, data: { sessionId: '22222222-2222-4222-8222-222222222222' } });
  await assert.rejects(tools.call('loop_evidence'), /different session/);
  put(start, { ...message, data: { content: prompt.replace(bytes.toString('base64'), Buffer.from('tampered').toString('base64')) } });
  await assert.rejects(tools.call('loop_evidence'), /approved byte hash/);
  assert.throws(() => readFileSync(m.authoring.evidencePath), /ENOENT/);
  put(start, { ...message, data: { content: prompt + prompt } });
  await assert.rejects(tools.call('loop_evidence'), /one complete approved evidence block/);
  put(start, { ...message, data: { content: 'No evidence in the initial request.' } });
  writeFileSync(events, `${readFileSync(events, 'utf8').split('\n').slice(0, 2).join('\n')}\n${JSON.stringify(message)}\n`);
  await assert.rejects(tools.call('loop_evidence'), /one complete approved evidence block/);
  put();
  const result = await tools.call('loop_evidence');
  assert.equal(result.sha256, m.authoring.evidenceSha256);
  assert.deepEqual(readFileSync(m.authoring.evidencePath), bytes);
  assert.deepEqual(tools.state.evidenceRequest, {
    sessionId, eventId: message.id, promptSha256: loopDigest(prompt)
  });
  assert.equal((await tools.call('loop_evidence')).sha256, result.sha256);
  writeFileSync(m.authoring.evidencePath, 'never overwrite existing evidence');
  await assert.rejects(tools.call('loop_evidence'), /trusted runner file/);
  assert.equal(readFileSync(m.authoring.evidencePath, 'utf8'), 'never overwrite existing evidence');
});

test('managed request evidence fails closed for missing identity, linked files and bounded-input overflow', async t => {
  const f = fixture(t, () => 0, { authoring: true });
  rmSync(f.m.authoring.evidencePath);
  f.m.authoring.evidenceTransport = 'request-session-v1';
  writeFileSync(f.manifestPath, JSON.stringify(f.m));
  const m = loadLoopManifest(f.manifestPath, { allowPendingEvidence: true });
  await assert.rejects(createLoopTools(m, { requestEnvironment: {} }).call('loop_evidence'),
    /explicit Copilot home/);
  const home = join(f.root, 'managed-home'), events = join(home, 'session-state', sessionId, 'events.jsonl');
  mkdirSync(dirname(events), { recursive: true });
  const environment = { COPILOT_HOME: home, AGENCY_SESSION_ID: sessionId };
  const tools = createLoopTools(m, { requestEnvironment: environment });
  await assert.rejects(tools.call('loop_evidence'), /ENOENT/);
  writeFileSync(events, JSON.stringify({ type: 'session.start', data: { sessionId } }) + '\n' + 'x'.repeat(2 * 1024 * 1024));
  await assert.rejects(tools.call('loop_evidence'), /initial request.*byte limit/);
  linkSync(events, join(f.root, 'events-alias.jsonl'));
  await assert.rejects(tools.call('loop_evidence'), /ordinary private file/);
  assert.throws(() => readFileSync(m.authoring.evidencePath), /ENOENT/);
});

test('authoring has one initial candidate and exactly two further repair attempts', async t => {
  const f = fixture(t, () => 1, { authoring: true });
  await f.plan();
  for (let index = 0; index < 3; index++) {
    await f.tools.call('loop_write', { path: f.m.allowedPath,
      content: original + newCases + '\n'.repeat(index) });
    const failed = await f.tools.call('loop_validate');
    assert.equal(failed.repairable, true);
    assert.equal(failed.repairBudgetRemaining, 2 - index);
  }
  await assert.rejects(f.tools.call('loop_write', {
    path: f.m.allowedPath, content: original + newCases + '\n\n\n'
  }), /remaining authoring\/repair budget/);
  await assert.rejects(f.tools.call('loop_validate'), /No further validation/);
});

test('new cases cannot replace original assertions or a smaller, skipped or duplicate test population', () => {
  assert.doesNotThrow(() => requireAppendOnlyTestChange(original, original + newCases));
  assert.throws(() => requireAppendOnlyTestChange(original, repaired + newCases), /preserve every byte/);
  assert.throws(() => requireAppendOnlyTestChange(original, `${original}\n// @ts-ignore\n${newCases}`), /Suppressing/);
  const population = { suites: 1, tests: 4, path: 'tests/integration/new.test.ts' };
  const passed = `PASS ${population.path}\nTest Suites: 1 passed, 1 total\nTests: 4 passed, 4 total\n`;
  assert.doesNotThrow(() => requirePassedTestPopulation(passed, population));
  for (const invalid of [
    passed.replace('4 passed, 4 total', '3 passed, 3 total'),
    passed.replace('4 passed, 4 total', '3 passed, 1 skipped, 4 total'),
    passed + 'Tests: 4 passed, 4 total\n',
    passed.replace(population.path, `${population.path}.substituted`),
    passed.replace(population.path, 'tests/integration/another.test.ts')
  ]) assert.throws(() => requirePassedTestPopulation(invalid, population), /population did not pass/);
});

for (const evidenceTransport of [undefined, 'request-tool-v1'])
test(`Windows fixture authoring seals a first-pass candidate only after trusted post-agent commands (${evidenceTransport ?? 'pre-materialized'})`,
  { skip: process.platform !== 'win32' }, async t => {
    const f = fixture(t, undefined, { authoring: true });
    const evidence = readFileSync(f.m.authoring.evidencePath);
    if (evidenceTransport) {
      f.m.authoring.evidenceTransport = evidenceTransport;
      rmSync(f.m.authoring.evidencePath);
    }
    copyFileSync(fileURLToPath(new URL('../src/native-command.ps1', import.meta.url)), f.m.nativeCommandPath);
    f.m.executable = join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
    writeFileSync(f.m.profilePath, `
if ($env:PILOT_VALIDATION_STAGE -eq 'authentication-check') {
  Write-Output 'PILOT_VALIDATION_AUTH_PREFLIGHT:{"state":"ready"}'
}
if ($env:PILOT_VALIDATION_STAGE -eq 'test') {
  Write-Output 'PASS tests/integration/test.contract.test.ts'
  Write-Output 'Test Suites: 1 passed, 1 total'
  Write-Output 'Tests: 4 passed, 4 total'
}
exit 0
`);
    f.m.profileSha256 = loopDigest(readFileSync(f.m.profilePath));
    f.m.nativeCommandSha256 = loopDigest(readFileSync(f.m.nativeCommandPath));
    writeFileSync(f.manifestPath, JSON.stringify(f.m));
    await prepareLoop(f.manifestPath);
    const tools = createLoopTools(loadLoopManifest(f.manifestPath, { allowPendingEvidence: true }));
    for (const path of f.m.requiredSkillPaths) await tools.call('loop_read', { path });
    await tools.call('loop_evidence', evidenceTransport ? { contentBase64: evidence.toString('base64') } : {});
    await tools.call('loop_plan', { plan: 'Synthetic fixture: append a new case and run configured commands.' });
    for (const operation of ['project', 'baseline', 'cards']) await tools.call('loop_inspect', { operation });
    await tools.call('loop_write', { path: f.m.allowedPath, content: original + newCases });
    const round = await tools.call('loop_validate');
    await tools.call('loop_finish');
    await finalizeLoop(f.manifestPath);
    const result = JSON.parse(readFileSync(join(f.directory, 'loop-result.json')));
    assert.equal(result.schema, 'agency-workspace-authoring-result-v1');
    assert.equal(result.candidate, round.candidate);
    assert.equal(result.rounds.length, 1);
    assert.equal(result.controllerAcceptance, false);
    assert.equal(result.remoteWorkComplete, true);
    assert.equal(result.authoring.evidenceSha256, f.m.authoring.evidenceSha256);
    assert.deepEqual(result.stages.map(stage => [stage.stage, stage.exitCode, stage.candidate]),
      ['compile', 'policy', 'test'].map(stage => [stage, 0, round.candidate]));
    assert.equal(readFileSync(join(f.directory, 'candidate.test.ts'), 'utf8'), original + newCases);
    assert.ok(result.inventory.some(file => file.path === 'evidence.json'));
    assert.ok(result.inventory.some(file => file.path === 'candidate.bundle'));
  });

test('type-only repair accepts generics but rejects changed assertions, skipped tests and suppression', () => {
  assert.doesNotThrow(() => requireTypeOnlyChange(original, repaired));
  for (const bad of [
    repaired.replace('toBe(true)', 'toBe(false)'),
    repaired.replace('it.each', 'it.skip.each'),
    repaired.replace('expect(run(settings)).toBe(true);', ''),
    `// @ts-ignore\n${repaired}`,
    `// @ts-nocheck\n${original}`,
    repaired.replace("from './harness'", "from './other-harness'")
  ]) assert.throws(() => requireTypeOnlyChange(original, bad));
});

test('validation child environment does not inherit pipeline, package or model secrets', () => {
  assert.deepEqual(validationEnvironment({
    PATH: 'tools', NUGET_PACKAGES: 'packages', PILOT_VALIDATION_STAGE: 'compile',
    SYSTEM_ACCESSTOKEN: 'synthetic', YARN_NPM_AUTH_TOKEN: 'synthetic',
    VSS_NUGET_EXTERNAL_FEED_ENDPOINTS: 'synthetic', ENDPOINT_AUTH_A: 'synthetic',
    COPILOT_TOKEN: 'synthetic', AZURE_CLIENT_SECRET: 'synthetic'
  }), { PATH: 'tools', NUGET_PACKAGES: 'packages', PILOT_VALIDATION_STAGE: 'compile' });
});

test('native inspection uses only the pinned scoped resolver and reuses its same-job report', async t => {
  const f = fixture(t);
  const result = await f.tools.call('loop_inspect', { operation: 'project' });
  assert.equal(result.matchCount, 1);
  assert.equal(result.matches[0].project, 'agents/office-agent');
  assert.deepEqual(await f.tools.call('loop_inspect', { operation: 'project' }), result);
  await assert.rejects(f.tools.call('loop_inspect', { operation: 'shell', command: 'whoami' }), /Only the pinned/);
});

test('real native supervisor binds validator children to this build NuGet cache without session caching',
  { skip: process.platform !== 'win32' }, async t => {
    const f = fixture(t);
    copyFileSync(fileURLToPath(new URL('../src/native-command.ps1', import.meta.url)), f.m.nativeCommandPath);
    writeFileSync(f.m.profilePath, `
Write-Output "$env:DOTNET_CLI_HOME|$env:NUGET_PACKAGES|$env:NUGET_CREDENTIALPROVIDER_SESSIONTOKENCACHE_ENABLED|$env:NUGET_CREDENTIALPROVIDER_MSAL_FILECACHE_ENABLED"
exit 0
`);
    f.m.executable = join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
    const result = await runLoopStage(f.m, 'compile', 0, f.m.baseRevision);
    assert.equal(result.exitCode, 0);
    assert.equal(readFileSync(join(f.directory, result.log), 'utf8').trim(),
      `${f.m.nugetDirectory}|${join(f.m.nugetDirectory, 'packages')}|false|false`);
  });

for (const exitCode of [0, 23])
test(`real native supervisor drains remote stage descendants after exit ${exitCode}`,
  { skip: process.platform !== 'win32' }, async t => {
    let childPath, root;
    t.after(() => {
      if (!childPath || !existsSync(childPath)) return;
      const pid = JSON.parse(readFileSync(childPath, 'utf8'));
      try { process.kill(pid, 0); }
      catch (error) {
        if (error.code === 'ESRCH') return;
        throw error;
      }
      execFileSync('pwsh.exe', ['-NoProfile', '-NonInteractive', '-Command',
        `$p=Get-CimInstance Win32_Process -Filter "ProcessId = ${pid}";` +
        `if($p -and $p.CommandLine.Contains('${root.replaceAll("'", "''")}')){Stop-Process -Id ${pid} -Force}`],
      { windowsHide: true, timeout: 10000, stdio: 'pipe' });
    });
    const f = fixture(t);
    root = f.root;
    childPath = join(f.directory, 'descendant.json');
    const leaf = join(f.directory, 'descendant.mjs');
    writeFileSync(leaf, `import {writeFileSync} from 'node:fs';
writeFileSync(${JSON.stringify(childPath)},JSON.stringify(process.pid));
setInterval(()=>{},1000);`);
    copyFileSync(fileURLToPath(new URL('../src/native-command.ps1', import.meta.url)), f.m.nativeCommandPath);
    writeFileSync(f.m.profilePath, `
$child = Start-Process -FilePath '${process.execPath.replaceAll("'", "''")}' -ArgumentList @('${leaf.replaceAll("'", "''")}') -NoNewWindow -PassThru
while (!(Test-Path -LiteralPath '${childPath.replaceAll("'", "''")}')) {
    if ($child.HasExited) { throw 'Synthetic descendant exited before starting' }
    Start-Sleep -Milliseconds 10
}
exit ${exitCode}
`);
    f.m.executable = join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
    const result = await runLoopStage(f.m, 'test', 0, f.m.baseRevision);
    assert.equal(result.exitCode, exitCode, readFileSync(join(f.directory, result.log), 'utf8'));
    assert.equal(result.ownedProcessesExited, true);
    assert.throws(() => process.kill(JSON.parse(readFileSync(childPath, 'utf8')), 0),
      error => error.code === 'ESRCH');
  });

test('OA compile profile admits only its approved unchanged fitness source, never an ordinary gate or unrelated edit',
  { skip: process.platform !== 'win32' }, async t => {
    const f = fixture(t, undefined, { authoring: true, native: true });
    const source = f.m.authoring.nativeWorkflow.fitness[0].path;
    const compiler = join(f.directory, 'bin', 'corepack.cmd');
    mkdirSync(dirname(compiler));
    writeFileSync(compiler, '@echo off\r\nexit /b 0\r\n');
    copyFileSync(fileURLToPath(new URL('../src/native-command.ps1', import.meta.url)), f.m.nativeCommandPath);
    const profile = fileURLToPath(new URL('../scripts/validation/office-agent-excel-entry-model.ps1', import.meta.url));
    writeFileSync(f.m.profilePath, `
$ErrorActionPreference = 'Stop'
function New-Item {
  param([string]$ItemType, [string]$Path, [switch]$Force)
  if ($Path -ne 'C:\\.tools\\.yarn') { throw 'Unexpected fixture directory creation' }
}
$env:PATH = '${dirname(compiler).replaceAll("'", "''")};' + $env:PATH
& '${profile.replaceAll("'", "''")}'
exit $LASTEXITCODE
`);
    f.m.executable = join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
    const mutated = 'export const route = false;\n';
    writeFileSync(join(f.m.workspace, source), mutated);
    const ordinary = await runLoopStage(f.m, 'compile', 0, f.m.baseRevision);
    assert.notEqual(ordinary.exitCode, 0);
    assert.match(readFileSync(join(f.directory, ordinary.log), 'utf8'), /Scoped compile changed unexpected files/);
    assert.equal(ordinary.fitnessSourcePath, undefined);
    assert.throws(() => runLoopStage(f.m, 'compile', 0, f.m.baseRevision, undefined, source),
      /Only the approved native probe/);
    const approved = await runLoopStage(f.m, 'compile', 'fitness-0-mutation', f.m.baseRevision, undefined, source);
    assert.equal(approved.exitCode, 0, readFileSync(join(f.directory, approved.log), 'utf8'));
    assert.equal(approved.fitnessSourcePath, source);
    assert.equal(readFileSync(join(f.m.workspace, source), 'utf8'), mutated);
    const unrelated = join(f.m.workspace, 'router.md'), original = readFileSync(unrelated);
    writeFileSync(unrelated, 'Unrelated edit.\n');
    const rejected = await runLoopStage(f.m, 'compile', 'fitness-1-mutation', f.m.baseRevision, undefined, source);
    assert.notEqual(rejected.exitCode, 0);
    assert.match(readFileSync(join(f.directory, rejected.log), 'utf8'), /Scoped compile changed unexpected files: router.md/);
    writeFileSync(unrelated, original);
    writeFileSync(compiler, `@echo off\r\necho compiler-change>>"${join(f.m.workspace, source)}"\r\nexit /b 0\r\n`);
    const changed = await runLoopStage(f.m, 'compile', 'fitness-2-mutation', f.m.baseRevision, undefined, source);
    assert.notEqual(changed.exitCode, 0);
    assert.match(readFileSync(join(f.directory, changed.log), 'utf8'), /compile changed the approved native fitness source/);
  });

test('real-command seam drives failure, native skill plan, committed type fix and all original gates', async t => {
  const f = fixture(t);
  const failed = await f.tools.call('loop_validate');
  assert.equal(failed.candidate, f.m.baseRevision);
  assert.equal(failed.passed, false);
  assert.match(failed.diagnostics, /TS2322/);
  await f.plan();
  await f.tools.call('loop_write', { path: f.m.allowedPath, content: repaired });
  const passed = await f.tools.call('loop_validate');
  assert.equal(passed.passed, true);
  assert.notEqual(passed.candidate, f.m.baseRevision);
  assert.deepEqual(passed.stages.map(stage => stage.stage), ['compile', 'policy', 'test']);
  assert.equal(f.git(['status', '--porcelain']).trim(), '');
  const finished = await f.tools.call('loop_finish');
  assert.equal(finished.finished, true);
  assert.equal(finished.remoteWorkComplete, true);
  assert.equal(finished.controllerAcceptance, false);
  assert.equal(finished.controllerAcceptanceStatus, 'pending-external');
  assert.equal(finished.candidate, passed.candidate);
  await assert.rejects(f.tools.call('loop_validate'), /finished/);
});

test('cannot edit before observed failure or before native skill is read and a plan recorded', async t => {
  const f = fixture(t);
  await assert.rejects(f.tools.call('loop_write', { path: f.m.allowedPath, content: repaired }), /real failed/);
  await assert.rejects(f.tools.call('loop_plan', { plan: 'Guess a fix' }), /Read the pinned/);
  await f.tools.call('loop_validate');
  await assert.rejects(f.tools.call('loop_write', { path: f.m.allowedPath, content: repaired }), /round plan/);
  await f.plan();
  await assert.rejects(f.tools.call('loop_write', { path: 'router.md', content: repaired }), /real failed/);
  assert.equal(readFileSync(join(f.workspace, f.m.allowedPath), 'utf8'), original);
});

test('tracked source guards reject traversal, private state and hard links', async t => {
  const f = fixture(t);
  for (const path of ['../private/manifest.json', '.git/config', f.manifestPath]) {
    await assert.rejects(f.tools.call('loop_read', { path }), /exact tracked/);
  }
  await assert.rejects(f.tools.call('loop_search', { path: '..', query: 'x' }), /relative/);
  const path = join(f.workspace, 'router.md');
  linkSync(path, join(f.directory, 'linked.md'));
  await assert.rejects(f.tools.call('loop_read', { path: 'router.md' }), /ordinary source/);
  await assert.rejects(f.tools.call('bash', { command: 'anything' }), /Unknown loop tool/);
});

test('no duplicate validation, successful self-report, outside-source edits or runner mutation is accepted', async t => {
  const f = fixture(t);
  await assert.rejects(f.tools.call('loop_finish'), /actually validated/);
  await f.tools.call('loop_validate');
  await assert.rejects(f.tools.call('loop_validate'), /already validated/);
  writeFileSync(join(f.workspace, 'workflow.md'), 'Changed workflow.\n');
  await assert.rejects(f.tools.call('loop_validate'), /source scope/);
  writeFileSync(join(f.workspace, 'workflow.md'), 'Read the source-bound native workflow.\n');
  writeFileSync(f.m.profilePath, 'exit 42\n');
  await assert.rejects(f.tools.call('loop_validate'), /runner file/);
});

test('interrupted validation cannot be automatically repeated after a server restart', async t => {
  const f = fixture(t, () => { throw new Error('Connection lost after command started.'); });
  await assert.rejects(f.tools.call('loop_validate'), /Connection lost/);
  assert.equal(JSON.parse(readFileSync(join(f.directory, 'loop-state.json'))).phase, 'uncertain');
  await assert.rejects(f.tools.call('loop_list'), /independent reconciliation/);
  assert.throws(() => createLoopTools(f.m, { runStage: f.runStage }), /independent reconciliation/);
});

test('tool calls cannot race a running gate and runner deadline remains binding', async t => {
  let release;
  const f = fixture(t, () => new Promise(resolve => { release = resolve; }));
  const pending = f.tools.call('loop_validate');
  await assert.rejects(f.tools.call('loop_read', { path: 'router.md' }), /serialized/);
  release(1);
  await pending;
  const expired = createLoopTools({ ...f.m, deadline: new Date(Date.now() - 1000).toISOString() },
    { runStage: f.runStage });
  await assert.rejects(expired.call('loop_list'), /budget expired/);
});

test('validation tickets return before long gates finish, serialize writes and recover completed results', async t => {
  let release, executions = 0;
  const f = fixture(t, () => {
    executions++;
    return new Promise(resolve => { release = resolve; });
  });
  const [ticket, concurrent] = await Promise.all([f.tools.validation(), f.tools.validation()]);
  assert.equal(concurrent.validationId, ticket.validationId);
  assert.equal(ticket.status, 'running');
  assert.equal(ticket.candidate, f.m.baseRevision);
  assert.equal(JSON.parse(readFileSync(join(f.directory, 'loop-state.json'))).rounds[0].validationId,
    ticket.validationId);
  assert.equal((await f.tools.validation()).validationId, ticket.validationId);
  assert.equal((await f.tools.validation({ validationId: ticket.validationId })).status, 'running');
  await assert.rejects(f.tools.validation({ validationId: '0'.repeat(64) }), /does not belong/);
  await assert.rejects(f.tools.call('loop_write', { path: f.m.allowedPath, content: repaired }), /serialized/);
  release(1);
  await new Promise(resolve => setImmediate(resolve));
  const completed = await f.tools.validation({ validationId: ticket.validationId });
  assert.equal(completed.status, 'completed');
  assert.equal(completed.repairable, true);
  assert.match(completed.diagnostics, /TS2322/);
  const recovered = createLoopTools(f.m, { runStage: () => assert.fail('Do not rerun a completed ticket.') });
  assert.deepEqual(await recovered.validation({ validationId: ticket.validationId }), completed);
  await assert.rejects(recovered.validation(), /already validated/);
  assert.equal(executions, 1);
});

test('an uncertain ticket cannot restart its command or be resumed after a server restart', async t => {
  let fail, executions = 0;
  const f = fixture(t, () => {
    executions++;
    return new Promise((resolve, reject) => { fail = reject; });
  });
  const ticket = await f.tools.validation();
  fail(new Error('Synthetic lost command connection.'));
  await new Promise(resolve => setImmediate(resolve));
  await assert.rejects(f.tools.validation({ validationId: ticket.validationId }), /uncertain.*lost command/);
  await assert.rejects(f.tools.validation(), /independent reconciliation/);
  assert.throws(() => createLoopTools(f.m), /independent reconciliation/);
  assert.equal(executions, 1);
});

test('real MCP returns a ticket before a slow Windows command and polls the same actual exit',
  { skip: process.platform !== 'win32' }, async t => {
    const f = fixture(t), directory = join(f.root, 'pilot-loop-100');
    renameSync(f.directory, directory);
    f.m.directory = directory;
    f.m.profilePath = join(directory, 'profile.ps1');
    f.m.nativeCommandPath = join(directory, 'native-command.ps1');
    f.m.executable = join(process.env.ProgramFiles, 'PowerShell', '7', 'pwsh.exe');
    copyFileSync(fileURLToPath(new URL('../src/native-command.ps1', import.meta.url)), f.m.nativeCommandPath);
    writeFileSync(f.m.profilePath, "Start-Sleep -Seconds 6\nWrite-Output 'test.contract.test.ts: error TS2322: synthetic fixture'\nexit 1\n");
    f.m.profileSha256 = loopDigest(readFileSync(f.m.profilePath));
    f.m.nativeCommandSha256 = loopDigest(readFileSync(f.m.nativeCommandPath));
    writeFileSync(join(directory, 'manifest.json'), JSON.stringify(f.m));
    const child = spawn(process.execPath, ['--input-type=module', '-e',
      `import { serve } from ${JSON.stringify(pathToFileURL(f.m.runnerPath).href)}; serve();`], {
      cwd: f.workspace, windowsHide: true,
      env: { ...validationEnvironment(process.env), BUILD_BUILDID: '100', AGENT_TEMPDIRECTORY: f.root }
    });
    const input = createInterface({ input: child.stdout });
    child.stderr.resume();
    const pending = new Map();
    input.on('line', line => {
      const message = JSON.parse(line), request = pending.get(message.id);
      if (request) { clearTimeout(request.timer); pending.delete(message.id); request.resolve(message.result); }
    });
    let id = 0;
    const rpc = (method, params, timeout) => new Promise((resolve, reject) => {
      const key = ++id;
      const timer = setTimeout(() => { pending.delete(key); reject(new Error('Synthetic client request deadline exceeded.')); }, timeout);
      pending.set(key, { resolve, timer });
      child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id: key, method, params })}\n`);
    });
    try {
      await rpc('initialize', {}, 10000);
      const response = await rpc('tools/call', { name: 'loop_validate', arguments: {} }, 4000);
      assert.equal(response.isError, undefined);
      const ticket = JSON.parse(response.content[0].text);
      assert.equal(ticket.status, 'running');
      let completed;
      for (let poll = 0; poll < 4; poll++) {
        const status = await rpc('tools/call', {
          name: 'loop_validate', arguments: { validationId: ticket.validationId }
        }, 15000);
        assert.equal(status.isError, undefined);
        completed = JSON.parse(status.content[0].text);
        if (completed.status === 'completed') break;
      }
      assert.equal(completed.status, 'completed');
      assert.equal(completed.stages[0].exitCode, 1);
      assert.equal(completed.validationId, ticket.validationId);
      assert.match(completed.diagnostics, /synthetic fixture/);
      assert.equal(JSON.parse(readFileSync(join(directory, 'loop-state.json'))).rounds.length, 1);
    } finally {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `Stop-Process -Id ${child.pid}`]);
          reject(new Error('Synthetic MCP server did not exit after stdin closed.'));
        }, 10000);
        child.once('close', () => { clearTimeout(timer); resolve(); });
        child.stdin.end();
      });
      input.close();
    }
  });

test('only the initial attempt and two bounded repairs may follow the baseline failure', async t => {
  const f = fixture(t, () => 1);
  await f.tools.call('loop_validate');
  await f.plan();
  for (const name of ['First', 'Second', 'Third']) {
    const content = original.replace('it.each(', `it.each<{ settings: Record<string, boolean>; ${name}?: never }>(`);
    await f.tools.call('loop_write', { path: f.m.allowedPath, content });
    assert.equal((await f.tools.call('loop_validate')).passed, false);
  }
  await assert.rejects(f.tools.call('loop_write', { path: f.m.allowedPath, content: repaired }), /bounded repair/);
  await assert.rejects(f.tools.call('loop_validate'), /No further/);
  assert.equal(f.tools.state.rounds.length, 4);
});

test('manifest cannot put trusted state inside source or use changed materialized scripts', t => {
  const f = fixture(t);
  const save = value => writeFileSync(f.manifestPath, JSON.stringify(value));
  save({ ...f.m, directory: join(f.workspace, 'private') });
  assert.throws(() => loadLoopManifest(f.manifestPath), /outside the product/);
  save({ ...f.m, runnerSha256: '0'.repeat(64) });
  assert.throws(() => loadLoopManifest(f.manifestPath), /runner file/);
  assert.equal(dirname(f.manifestPath), f.directory);
});
