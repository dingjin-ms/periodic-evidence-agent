import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import { verifyAgencyRunnerSdxFixedCandidatePoc,
  verifyAgencyRunnerSdxValidation } from '../src/agency-runner-sdx-validation.js';

const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const baseRevision = 'a'.repeat(40), candidate = 'b'.repeat(40);
const stages = ['fingerprint', 'authentication-check', 'authentication', 'dependencies', 'compile', 'policy', 'test'];

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sdx-runner-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const agencyRoot = join(directory, 'agency'), session = join(agencyRoot, 'session_20261029_120000_1');
  const dropRoot = join(directory, 'drop'), root = join(dropRoot, 'sdx-poc'), jestRoot = join(root, 'jest-artifacts');
  mkdirSync(session, { recursive: true });
  mkdirSync(jestRoot, { recursive: true });
  const profile = 'Write-Output fixture\n', profileSha256 = hash(profile), prompt = 'fixed SDX prompt';
  writeFileSync(join(root, '1js-sdx-excel-integration.ps1'), profile);
  writeFileSync(join(root, 'git-status.txt'), '');
  writeFileSync(join(jestRoot, 'run.json'), JSON.stringify({ state: 'passed', baseRevision,
    revision: candidate, selectedSuiteCount: 1, resultPresent: true }));
  writeFileSync(join(jestRoot, 'jest-result.json'), JSON.stringify({ success: true, numTotalTests: 2,
    numPassedTests: 2, testResults: [{ assertionResults: [{ status: 'passed' }, { status: 'passed' }] }] }));
  writeFileSync(join(jestRoot, 'discovered-tests.json'), JSON.stringify(['fixture.test.ts']));
  writeFileSync(join(jestRoot, 'selection.json'), JSON.stringify({ expectedPaths: ['fixture.test.ts'] }));
  writeFileSync(join(root, 'result.json'), JSON.stringify({ baseRevision, candidate, profileSha256,
    head: candidate, stages: stages.map(stage => ({ stage, exitCode: 0 })) }));
  const inventoryPaths = [
    '1js-sdx-excel-integration.ps1', 'git-status.txt', 'jest-artifacts/discovered-tests.json',
    'jest-artifacts/jest-result.json', 'jest-artifacts/run.json', 'jest-artifacts/selection.json', 'result.json'
  ];
  const inventory = inventoryPaths.map(path => {
    const bytes = readFileSync(join(root, ...path.split('/')));
    return { path, bytes: bytes.length, sha256: hash(bytes) };
  });
  writeFileSync(join(root, 'inventory.json'), JSON.stringify(inventory));
  const command = `${candidate} ${profileSha256} ${stages.join(' ')}`;
  const events = [
    { type: 'session.start', data: { sessionId: '11111111-1111-4111-8111-111111111111' } },
    { type: 'user.message', data: { content: prompt } },
    { type: 'skill.invoked', data: { name: 'excel-agent-integration-tests',
      path: 'midgard/packages/officeaicopilot-agent-excel/.github/skills/excel-agent-integration-tests/SKILL.md' } },
    { type: 'tool.execution_start', data: { toolCallId: 'one', toolName: 'powershell', arguments: { command } } },
    { type: 'tool.execution_complete', data: { toolCallId: 'one', success: true, shellExecution: { exitCode: 0 } } },
    { type: 'session.task_complete', data: { success: true } }
  ];
  const eventPath = join(session, 'events.jsonl');
  writeFileSync(eventPath, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  const contract = { schema: 'agency-runner-sdx-validation-v1', jobId: 'job-one', baseRevision, candidate,
    profileSha256, promptSha256: hash(prompt), pipelineDefinitionId: 35960, maximumRunnerMinutes: 30 };
  const observation = { job: { jobId: 'job-one', state: 'Completed', result: 'Success', promptSha256: hash(prompt),
    pipelineRun: { runId: 100, definitionId: 35960 } }, build: { id: 100, definitionId: 35960,
    status: 'completed', result: 'succeeded', startTime: '2026-10-29T00:00:00Z',
    finishTime: '2026-10-29T00:10:00Z' } };
  return { agencyRoot, dropRoot, contract, observation, eventPath, events, root };
}

test('independently accepts source-bound SDX gates from native Agency artifacts', t => {
  const f = fixture(t);
  const result = verifyAgencyRunnerSdxValidation(f.contract, f.observation, f.agencyRoot, f.dropRoot);
  assert.equal(result.controllerAcceptance, true);
  assert.equal(result.testCount, 2);
});

test('accepts fixed-candidate PoC evidence without claiming native skill invocation', t => {
  const f = fixture(t);
  writeFileSync(f.eventPath, f.events.filter(event => event.type !== 'skill.invoked')
    .map(event => JSON.stringify(event)).join('\n') + '\n');
  const result = verifyAgencyRunnerSdxFixedCandidatePoc(f.contract, f.observation, f.agencyRoot, f.dropRoot);
  assert.equal(result.controllerAcceptance, true);
  assert.equal(result.scope, 'fixed-candidate-poc');
  assert.equal(result.nativeSkillInvocation, 'not-claimed');
});

test('rejects green jobs without native skill invocation or successful shell evidence', t => {
  const f = fixture(t);
  writeFileSync(f.eventPath, f.events.filter(event => event.type !== 'skill.invoked')
    .map(event => JSON.stringify(event)).join('\n') + '\n');
  assert.throws(() => verifyAgencyRunnerSdxValidation(f.contract, f.observation, f.agencyRoot, f.dropRoot),
    /skill was not invoked/);
  const events = f.events.map(event => event.type === 'tool.execution_complete'
    ? { ...event, data: { ...event.data, success: false, shellExecution: { exitCode: 1 } } } : event);
  writeFileSync(f.eventPath, events.map(event => JSON.stringify(event)).join('\n') + '\n');
  assert.throws(() => verifyAgencyRunnerSdxValidation(f.contract, f.observation, f.agencyRoot, f.dropRoot),
    /shell events/);
});

test('rejects substituted candidate and zero Jest population', t => {
  const f = fixture(t);
  const resultPath = join(f.root, 'result.json'), result = JSON.parse(readFileSync(resultPath));
  result.head = 'c'.repeat(40);
  writeFileSync(resultPath, JSON.stringify(result));
  assert.throws(() => verifyAgencyRunnerSdxValidation(f.contract, f.observation, f.agencyRoot, f.dropRoot),
    /fixed candidate/);
});
