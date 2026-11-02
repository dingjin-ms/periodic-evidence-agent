import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { verifyAgencyRunnerSdxRepairLiveE2e } from '../src/agency-runner-sdx-repair-live-e2e.js';

const hash = value => createHash('sha256').update(value).digest('hex');
const baseRevision = 'a'.repeat(40), failedCandidate = 'b'.repeat(40), candidate = 'c'.repeat(40);
const stages = ['fingerprint', 'authentication-check', 'authentication', 'dependencies', 'compile', 'policy', 'test'];
const passingStages = () => stages.map(stage => ({ stage, exitCode: 0 }));

function fixture(t) {
  const directory = mkdtempSync(join(tmpdir(), 'sdx-repair-live-e2e-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const agencyRoot = join(directory, 'agency'), session = join(agencyRoot, 'session');
  const dropRoot = join(directory, 'drop'), root = join(dropRoot, 'sdx-repair-live-e2e');
  mkdirSync(session, { recursive: true });
  mkdirSync(join(root, 'jest-artifacts'), { recursive: true });
  mkdirSync(join(root, 'round-artifacts'), { recursive: true });
  mkdirSync(join(root, 'repair-diagnostics'), { recursive: true });
  mkdirSync(join(root, 'source'), { recursive: true });
  const profile = 'Write-Output fixture\n', profileSha256 = hash(profile), skillSha256 = hash('skill\n');
  const testPath = 'midgard/packages/officeaicopilot-agent-excel/tests/integration/contracts/example.integration.test.ts';
  const cardPath = 'midgard/packages/officeaicopilot-agent-excel/tests/integration/behavior-cards/example.md';
  const marker = 'SDX_CONTROLLED_FAULT_20261102', finalSource = 'expect(actual).toEqual(expected);\n';
  const failedArtifact = 'controlled assertion failed\n', passedArtifact = 'all gates passed\n';
  const diagnostic = 'test stage failed because controlled assertion expected the wrong value\n';
  writeFileSync(join(root, 'profile.ps1'), profile);
  writeFileSync(join(root, 'round-artifacts', 'round-0.txt'), failedArtifact);
  writeFileSync(join(root, 'round-artifacts', 'round-1.txt'), passedArtifact);
  writeFileSync(join(root, 'repair-diagnostics', 'round-0.txt'), diagnostic);
  writeFileSync(join(root, 'source', 'final-test.ts'), finalSource);
  writeFileSync(join(root, 'jest-artifacts', 'jest-result.json'), JSON.stringify({ success: true,
    numTotalTestSuites: 1, numTotalTests: 11, numPassedTests: 11, numFailedTests: 0 }));
  for (const name of ['discovered-tests.json', 'selection.json', 'run.json']) {
    writeFileSync(join(root, 'jest-artifacts', name), '{}');
  }
  writeFileSync(join(root, 'changed-files.json'), JSON.stringify([testPath, cardPath,
    'midgard/change/change-11111111-1111-4111-8111-111111111111.json']));
  const failedStages = passingStages();
  failedStages.at(-1).exitCode = 1;
  writeFileSync(join(root, 'rounds.json'), JSON.stringify({ schema: 'sdx-repair-rounds-v1', rounds: [
    { round: 0, candidate: failedCandidate, parent: baseRevision, stages: failedStages,
      artifactPath: 'round-artifacts/round-0.txt', artifactSha256: hash(failedArtifact) },
    { round: 1, candidate, parent: baseRevision, stages: passingStages(),
      artifactPath: 'round-artifacts/round-1.txt', artifactSha256: hash(passedArtifact) }
  ] }));
  writeFileSync(join(root, 'repair.json'), JSON.stringify({ schema: 'sdx-bounded-repair-v1', repairs: [{
    attempt: 1, failedCandidate, failureStage: 'test', diagnosticPath: 'repair-diagnostics/round-0.txt',
    diagnosticSha256: hash(diagnostic), repairedCandidate: candidate, changedPaths: [testPath, cardPath]
  }] }));
  writeFileSync(join(root, 'fault-injection.json'), JSON.stringify({
    schema: 'sdx-controlled-fault-injection-v1', controlled: true, scope: 'test-only',
    injectedBeforeInitialGate: true, removedByBoundedRepair: true, testPath, injectedCandidate: failedCandidate,
    finalCandidate: candidate, marker, finalTestSourcePath: 'source/final-test.ts', finalTestSourceSha256: hash(finalSource)
  }));
  writeFileSync(join(root, 'review.json'), JSON.stringify({ schema: 'sdx-native-review-v1', candidate,
    verdict: 'approved', findings: [], skillSha256, testPath, cardPath, afterRepair: true,
    authorSessionId: 'author-one', reviewerSessionId: 'reviewer-two' }));
  writeFileSync(join(root, 'result.json'), JSON.stringify({ baseRevision, candidate, parent: baseRevision,
    profileSha256, skillSha256, preReviewStages: passingStages(), finalStages: passingStages(), gitStatus: '',
    repairCount: 1, publicationPerformed: false }));
  const inventoryPaths = ['changed-files.json', 'fault-injection.json', 'jest-artifacts/discovered-tests.json',
    'jest-artifacts/jest-result.json', 'jest-artifacts/run.json', 'jest-artifacts/selection.json',
    'profile.ps1', 'repair-diagnostics/round-0.txt', 'repair.json', 'result.json', 'review.json',
    'round-artifacts/round-0.txt', 'round-artifacts/round-1.txt', 'rounds.json', 'source/final-test.ts'];
  writeFileSync(join(root, 'inventory.json'), JSON.stringify(inventoryPaths.map(path => {
    const bytes = readFileSync(join(root, ...path.split('/')));
    return { path, bytes: bytes.length, sha256: hash(bytes) };
  })));
  const command = `${baseRevision} ${profileSha256} ${skillSha256} ${testPath} ${stages.join(' ')} git commit --amend`;
  const events = [
    { type: 'tool.execution_start', data: { toolCallId: 'one', toolName: 'bash', arguments: { command } } },
    { type: 'tool.execution_complete', data: { toolCallId: 'one', success: true, shellExecution: { exitCode: 0 } } }
  ];
  writeFileSync(join(session, 'events.jsonl'), events.map(event => JSON.stringify(event)).join('\n') + '\n');
  const contract = { schema: 'agency-runner-sdx-repair-live-e2e-v1', jobId: 'job-one', baseRevision,
    profileSha256, promptSha256: hash('prompt'), skillSha256, pipelineDefinitionId: 35960,
    maximumRunnerMinutes: 60, maximumRepairs: 2, testPath, cardPath };
  const observation = { job: { jobId: 'job-one', state: 'Completed', result: 'Success',
    promptSha256: contract.promptSha256, pipelineRun: { runId: 100, definitionId: 35960 } },
  build: { id: 100, definitionId: 35960, status: 'completed', result: 'succeeded',
    startTime: '2026-11-02T00:00:00Z', finishTime: '2026-11-02T00:30:00Z' } };
  return { contract, observation, agencyRoot, dropRoot, root };
}

function verify(value) {
  return verifyAgencyRunnerSdxRepairLiveE2e(value.contract, value.observation, value.agencyRoot, value.dropRoot);
}

test('accepts a controlled test failure repaired and fully revalidated in one SDX workspace', t => {
  const value = fixture(t), result = verify(value);
  assert.equal(result.controllerAcceptance, true);
  assert.equal(result.proofKind, 'controlled-repair-path');
  assert.equal(result.repairCount, 1);
  assert.equal(result.publicationPerformed, false);
});

test('accepts one complete final Jest evidence set in a nested stage directory', t => {
  const value = fixture(t), source = join(value.root, 'jest-artifacts', 'jest-result.json');
  const nested = join(value.root, 'jest-artifacts', 'test');
  mkdirSync(nested, { recursive: true });
  for (const name of ['discovered-tests.json', 'selection.json', 'run.json']) {
    writeFileSync(join(nested, name), '{}');
  }
  writeFileSync(join(nested, 'jest-result.json'), readFileSync(source));
  rmSync(source);
  const inventoryPaths = JSON.parse(readFileSync(join(value.root, 'inventory.json'))).map(entry => entry.path)
    .filter(path => path !== 'jest-artifacts/jest-result.json')
    .concat(['jest-artifacts/test/discovered-tests.json', 'jest-artifacts/test/jest-result.json',
      'jest-artifacts/test/run.json', 'jest-artifacts/test/selection.json']).sort();
  writeFileSync(join(value.root, 'inventory.json'), JSON.stringify(inventoryPaths.map(path => {
    const bytes = readFileSync(join(value.root, ...path.split('/')));
    return { path, bytes: bytes.length, sha256: hash(bytes) };
  })));
  assert.equal(verify(value).testCount, 11);
});

test('rejects ambiguous final Jest evidence sets', t => {
  const value = fixture(t), nested = join(value.root, 'jest-artifacts', 'test');
  mkdirSync(nested, { recursive: true });
  writeFileSync(join(nested, 'jest-result.json'), readFileSync(join(value.root, 'jest-artifacts', 'jest-result.json')));
  assert.throws(() => verify(value), /exactly one final Jest result/);
});

test('rejects a run without a real failed test-stage round', t => {
  const value = fixture(t), path = join(value.root, 'rounds.json'), rounds = JSON.parse(readFileSync(path));
  rounds.rounds[0].stages.at(-1).exitCode = 0;
  writeFileSync(path, JSON.stringify(rounds));
  assert.throws(() => verify(value), /real test-stage failure/);
});

test('rejects repair outside test card and generated changefile scope', t => {
  const value = fixture(t), path = join(value.root, 'repair.json'), repair = JSON.parse(readFileSync(path));
  repair.repairs[0].changedPaths.push('midgard/packages/officeaicopilot-agent-excel/src/product.ts');
  writeFileSync(path, JSON.stringify(repair));
  assert.throws(() => verify(value), /allowed repair scope/);
});

test('rejects a controlled fault marker left in the final test source', t => {
  const value = fixture(t), path = join(value.root, 'source', 'final-test.ts');
  writeFileSync(path, 'SDX_CONTROLLED_FAULT_20261102\n');
  assert.throws(() => verify(value), /fault injection/);
});

test('rejects review performed by the author session', t => {
  const value = fixture(t), path = join(value.root, 'review.json'), review = JSON.parse(readFileSync(path));
  review.reviewerSessionId = review.authorSessionId;
  writeFileSync(path, JSON.stringify(review));
  assert.throws(() => verify(value), /Fresh independent SDX review/);
});
