import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyAgencyRunnerAlLiveE2e } from '../src/agency-runner-al-live-e2e.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const here = dirname(fileURLToPath(import.meta.url));
const runnerPath = join(here, '..', 'scripts', 'validation', 'augloop-agency-runner.mjs');
const preloadPath = join(here, '..', 'scripts', 'validation', 'augloop-agency-node-preload.cjs');
const owners = [
  'excel-agent-in-container-proxy', 'session-protocol',
  'doclab-serialization', 'eval-vnext-config-resolver'
];

function command(executable, args, cwd) {
  return execFileSync(executable, args, { cwd, encoding: 'utf8' }).trim();
}

function runnerFixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'al-agency-runner-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const workspace = join(directory, 'workspace'), evidence = join(directory, 'evidence');
  mkdirSync(join(workspace, '.yarn', 'releases'), { recursive: true });
  mkdirSync(join(workspace, 'tools', 'node_modules', '@augloop-tools', 'cli', 'lib', 'src'), { recursive: true });
  mkdirSync(join(workspace, 'utils', 'excel-agent-in-container-proxy', 'tests'), { recursive: true });
  mkdirSync(join(workspace, 'utils', 'excel-agent-in-container-proxy', '.github', 'skills',
    'excel-agent-in-container-proxy-integration-tests'), { recursive: true });
  const fixtureScript = `const fs = require('node:fs'); const path = require('node:path'); const args = process.argv.slice(2);\n` +
    `if (args.includes('build') && args.includes('@augloop-utils/excel-agent-in-container-proxy')) { console.log('@augloop/tracelogger build success\\n@augloop/sf-native build success'); fs.mkdirSync(path.join(process.cwd(), 'server', 'tracelogger', 'build', 'Release'), { recursive: true }); fs.writeFileSync(path.join(process.cwd(), 'server', 'tracelogger', 'build', 'Release', 'ALTraceLogger.node'), 'native'); fs.writeFileSync(path.join(process.cwd(), 'server', 'tracelogger', 'build', 'Release', 'PerfCountersDll.dll'), 'native'); }\n` +
    `if (args.includes('test')) console.log(args.includes('@augloop/session-protocol') ? '  115 passing' : 'Tests:  2 passed, 2 total');\n` +
    `else console.log('fixture gate passed');\n`;
  writeFileSync(join(workspace, '.yarn', 'releases', 'yarn-3.2.1.cjs'), fixtureScript);
  writeFileSync(join(workspace, 'tools', 'node_modules', '@augloop-tools', 'cli', 'lib', 'src', 'cli.js'), fixtureScript);
  const skillPath = join(workspace, 'utils', 'excel-agent-in-container-proxy', '.github', 'skills',
    'excel-agent-in-container-proxy-integration-tests', 'SKILL.md');
  writeFileSync(skillPath, 'skill\n');
  command('git', ['init'], workspace);
  command('git', ['config', 'user.name', 'Fixture'], workspace);
  command('git', ['config', 'user.email', 'fixture@example.invalid'], workspace);
  command('git', ['config', 'core.autocrlf', 'false'], workspace);
  writeFileSync(join(workspace, 'README.md'), 'base\n');
  command('git', ['add', '.'], workspace); command('git', ['commit', '-m', 'base'], workspace);
  const baseRevision = command('git', ['rev-parse', 'HEAD'], workspace);
  writeFileSync(join(workspace, 'utils', 'excel-agent-in-container-proxy', 'tests', 'fixture.test.ts'), 'export {};\n');
  command('git', ['add', '.'], workspace); command('git', ['commit', '-m', 'author test'], workspace);
  const candidate = command('git', ['rev-parse', 'HEAD'], workspace);
  const inputPath = join(directory, 'input.json');
  writeFileSync(inputPath, JSON.stringify({ schema: 'pea-al-agency-runner-input-v1',
    workspaceRoot: workspace, evidenceDirectory: evidence, baseRevision, candidate,
    repairAttempt: 0, maximumJobMinutes: 90, maximumControllerMinutes: 180,
    controllerDeadlineAt: new Date(Date.now() + 180 * 60000).toISOString(),
    maxRepairAttempts: 2, expectedSkillSha256: hash(readFileSync(skillPath)),
    expectedRunnerSha256: hash(readFileSync(runnerPath)),
    expectedPreloadSha256: hash(readFileSync(preloadPath)) }));
  const runnerOutput = command(process.execPath, [runnerPath, inputPath], workspace);
  return { directory, workspace, evidence, baseRevision, candidate, runnerOutput };
}

test('prebuilt AL runner executes Excel first and all sixteen native gate commands', t => {
  const f = runnerFixture(t), receipt = JSON.parse(readFileSync(join(f.evidence, 'receipt.json')));
  assert.equal(receipt.status, 'passed');
  assert.match(f.runnerOutput, /\[al-controller\].* validation started/);
  assert.match(f.runnerOutput, /excel-agent-in-container-proxy-cli-build started/);
  assert.match(f.runnerOutput, /validation passed/);
  assert.equal(receipt.gateCount, 16);
  assert.deepEqual(receipt.gateOrder, owners);
  assert.equal(receipt.gates[0].gateId, 'excel-agent-in-container-proxy-cli-build');
  assert.equal(receipt.gates.find(gate => gate.owner === 'session-protocol' && gate.step === 'test').testPopulation, 115);
  assert.equal(receipt.gates.filter(gate => gate.step === 'test').every(gate => gate.testPopulation > 0), true);
  assert.equal(receipt.gates.filter(gate => gate.runner === 'jest' && gate.step === 'test')
    .every(gate => gate.args.includes('--cacheDirectory')), true);
  assert.equal(receipt.excelNativeProof.assets.alTraceLoggerNode.path,
    'server/tracelogger/build/Release/ALTraceLogger.node');
  const audits = readFileSync(join(f.evidence, 'node-preload-audit.ndjson'), 'utf8').trim().split(/\r?\n/).map(JSON.parse);
  assert.equal(audits.length >= 16, true);
  assert.equal(audits.every(audit => audit.lageGitIgnoredFilesPresent === false), true);
});

test('prebuilt AL runner retains porcelain prefixes and bounds Windows drain', () => {
  const source = readFileSync(runnerPath, 'utf8');
  assert.match(source, /return output\.stdout\.trimEnd\(\)/);
  assert.match(source, /setTimeout\(\(\) => \{\s*child\.kill\(\);\s*finish\(\);\s*\}, 20000\)/);
  assert.match(source, /await drain\(child\.pid\);\s*child\.kill\(\);\s*finish\(-1\)/);
  assert.match(source, /async function bypassInteractiveAzureLogin\(pid\)/);
  assert.match(source, /detectInteractiveLogin: step === 'cli-build'/);
  assert.match(source, /interactiveAzureLoginBypassed: result\.interactiveLoginBypassed/);
});

function acceptanceFixture(t) {
  const f = runnerFixture(t), agencyRoot = join(f.directory, 'agency'), session = join(agencyRoot, 'session');
  const dropRoot = join(f.directory, 'drop'), root = join(dropRoot, 'al-live-e2e');
  mkdirSync(session, { recursive: true }); mkdirSync(dropRoot, { recursive: true });
  command(process.execPath, ['-e', `require('node:fs').cpSync(${JSON.stringify(f.evidence)}, ${JSON.stringify(root)}, {recursive:true})`], f.directory);
  const runnerSha256 = hash(readFileSync(runnerPath)), preloadSha256 = hash(readFileSync(preloadPath));
  const prompt = 'synthetic AL live E2E', promptSha256 = hash(prompt), skillSha256 = hash('skill\n');
  const shellCommand = `${f.baseRevision} ${skillSha256} ${runnerSha256} ${preloadSha256} ${owners.join(' ')}`;
  const events = [
    { type: 'user.message', data: { content: prompt } },
    { type: 'skill.invoked', data: { name: 'excel-agent-in-container-proxy-integration-tests',
      path: 'acquired/skills/excel-agent-in-container-proxy-integration-tests/SKILL.md',
      content: 'skill\n', pluginName: 'excel-agent-in-container-proxy' } },
    { type: 'tool.execution_start', data: { toolCallId: 'one', toolName: 'powershell', arguments: { command: shellCommand } } },
    { type: 'tool.execution_complete', data: { toolCallId: 'one', success: true, shellExecution: { exitCode: 0 } } }
  ];
  writeFileSync(join(session, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
  const contract = { schema: 'agency-runner-al-live-e2e-v1', jobId: 'job-one',
    baseRevision: f.baseRevision, promptSha256, skillSha256, runnerSha256, preloadSha256,
    pipelineDefinitionId: 38919, model: 'gpt-6-luna', softCreditLimit: 30,
    maxModelSessions: 1, maxRepairAttempts: 2, maximumJobMinutes: 90,
    maximumControllerMinutes: 180 };
  const observation = { job: { jobId: 'job-one', state: 'Completed', result: 'Success', promptSha256,
    pipelineRun: { runId: 100, definitionId: 38919 } }, build: { id: 100, definitionId: 38919,
    status: 'completed', result: 'succeeded', startTime: '2026-11-03T00:00:00Z',
    finishTime: '2026-11-03T01:30:00Z' } };
  return { contract, observation, agencyRoot, dropRoot, root };
}

test('independent controller accepts complete source-bound AL evidence', t => {
  const f = acceptanceFixture(t);
  const result = verifyAgencyRunnerAlLiveE2e(f.contract, f.observation, f.agencyRoot, f.dropRoot);
  assert.equal(result.controllerAcceptance, true);
  assert.equal(result.gateCount, 16);
  assert.equal(result.runnerModifiedRemotely, false);
});

test('independent controller rejects zero population and unaudited runner replacement', t => {
  const f = acceptanceFixture(t), receiptPath = join(f.root, 'receipt.json');
  const receipt = JSON.parse(readFileSync(receiptPath));
  receipt.gates.find(gate => gate.step === 'test').testPopulation = 0;
  writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.throws(() => verifyAgencyRunnerAlLiveE2e(f.contract, f.observation, f.agencyRoot, f.dropRoot),
    /passing native population/);
  receipt.gates.find(gate => gate.step === 'test').testPopulation = 2;
  receipt.runner.modifiedRemotely = true;
  receipt.runner.repairReason = null;
  writeFileSync(receiptPath, JSON.stringify(receipt));
  assert.throws(() => verifyAgencyRunnerAlLiveE2e(f.contract, f.observation, f.agencyRoot, f.dropRoot),
    /repair provenance/);
});
