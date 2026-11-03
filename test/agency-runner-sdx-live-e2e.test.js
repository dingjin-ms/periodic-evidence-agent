import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyAgencyRunnerSdxLiveE2e } from '../src/agency-runner-sdx-live-e2e.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const baseRevision = 'a'.repeat(40), candidate = 'b'.repeat(40);
const stages = ['fingerprint', 'authentication-check', 'authentication', 'dependencies', 'compile', 'policy', 'test'];

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sdx-live-e2e-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const agencyRoot = join(directory, 'agency'), session = join(agencyRoot, 'session');
  const dropRoot = join(directory, 'drop'), root = join(dropRoot, 'sdx-live-e2e');
  const jestRoot = join(root, 'jest-artifacts');
  mkdirSync(session, { recursive: true });
  mkdirSync(jestRoot, { recursive: true });
  const profile = 'Write-Output fixture\n', profileSha256 = hash(profile), skillSha256 = hash('skill\n');
  const testPath = 'midgard/packages/officeaicopilot-agent-excel/tests/integration/contracts/example.integration.test.ts';
  const cardPath = 'midgard/packages/officeaicopilot-agent-excel/tests/integration/behavior-cards/example.md';
  writeFileSync(join(root, 'profile.ps1'), profile);
  writeFileSync(join(jestRoot, 'jest-result.json'), JSON.stringify({ success: true, numTotalTestSuites: 1,
    numTotalTests: 11, numPassedTests: 11, numFailedTests: 0 }));
  writeFileSync(join(root, 'changed-files.json'), JSON.stringify([testPath, cardPath,
    'midgard/change/change-11111111-1111-4111-8111-111111111111.json']));
  writeFileSync(join(root, 'review.json'), JSON.stringify({ schema: 'sdx-native-review-v1', candidate,
    verdict: 'approved', findings: [], skillSha256, testPath, cardPath }));
  writeFileSync(join(root, 'result.json'), JSON.stringify({ baseRevision, candidate, parent: baseRevision,
    profileSha256, skillSha256, stages: stages.map(stage => ({ stage, exitCode: 0 })), gitStatus: '', repairCount: 0 }));
  const inventoryPaths = ['changed-files.json', 'jest-artifacts/jest-result.json', 'profile.ps1', 'result.json', 'review.json'];
  writeFileSync(join(root, 'inventory.json'), JSON.stringify(inventoryPaths.map(path => {
    const bytes = readFileSync(join(root, ...path.split('/')));
    return { path, bytes: bytes.length, sha256: hash(bytes) };
  })));
  const command = `${baseRevision} ${profileSha256} ${skillSha256} ${testPath} ${stages.join(' ')}`;
  const events = [
    { type: 'tool.execution_start', data: { toolCallId: 'one', toolName: 'bash', arguments: { command } } },
    { type: 'tool.execution_complete', data: { toolCallId: 'one', success: true, shellExecution: { exitCode: 0 } } }
  ];
  writeFileSync(join(session, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
  const contract = { schema: 'agency-runner-sdx-live-e2e-v1', jobId: 'job-one', baseRevision,
    profileSha256, promptSha256: hash('prompt'), skillSha256, pipelineDefinitionId: 35960,
    maximumRunnerMinutes: 60, testPath, cardPath };
  const observation = { job: { jobId: 'job-one', state: 'Completed', result: 'Success',
    promptSha256: contract.promptSha256, pipelineRun: { runId: 100, definitionId: 35960 } },
  build: { id: 100, definitionId: 35960, status: 'completed', result: 'succeeded',
    startTime: '2026-10-30T00:00:00Z', finishTime: '2026-10-30T00:30:00Z' } };
  return { contract, observation, agencyRoot, dropRoot, root };
}

test('accepts a source-bound SDX authored candidate with review and final gates', t => {
  const fixtureValue = fixture(t);
  const result = verifyAgencyRunnerSdxLiveE2e(fixtureValue.contract, fixtureValue.observation,
    fixtureValue.agencyRoot, fixtureValue.dropRoot);
  assert.equal(result.controllerAcceptance, true);
  assert.equal(result.candidate, candidate);
  assert.equal(result.nativeSkill, 'pinned-custom-agent');
});

test('rejects base reuse and non-independent review', t => {
  const fixtureValue = fixture(t);
  const resultPath = join(fixtureValue.root, 'result.json');
  const result = JSON.parse(readFileSync(resultPath));
  result.candidate = baseRevision;
  writeFileSync(resultPath, JSON.stringify(result));
  assert.throws(() => verifyAgencyRunnerSdxLiveE2e(fixtureValue.contract, fixtureValue.observation,
    fixtureValue.agencyRoot, fixtureValue.dropRoot), /authored committed candidate/);
});
