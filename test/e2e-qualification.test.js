import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  qualify1jsE2eEvidence, requireExecutionQualification
} from '../src/e2e-qualification.js';
import { pinSkillQualification } from '../src/repository-skills.js';

const revision = 'a'.repeat(40);
const binding = {
  id: '1js-declarative-e2e-authoring',
  executionQualification: '1js-e2e-live-v1'
};
const skillQualification = {
  state: 'qualified-read-only',
  repoId: '1js',
  bindingId: binding.id,
  capability: 'declarative-e2e-authoring',
  baseRevision: revision,
  skillSha256: 'c'.repeat(64),
  skillPath: '.github/skills/author-declarative-e2e-test/SKILL.md',
  remote: 'https://dev.azure.com/office/Office/_git/1JS',
  qualificationSource: 'trusted-remote',
  validationContractVersion: '1',
  validationContractSha256: 'd'.repeat(64)
};

function runs(suite, ci) {
  return Array.from({ length: 5 }, (_, index) => ({
    sequence: index + 1,
    ...(ci
      ? { buildId: 1000 + index, testRunId: 2000 + index }
      : { runId: `${suite}-local-${index + 1}` }),
    status: 'passed',
    retriesDisabled: true,
    completedAt: `2026-10-${String(index + 1).padStart(2, '0')}T00:00:00.000Z`,
    sourceRevision: revision,
    evidenceSha256: (ci ? (index + 6).toString(16) : (index + 1).toString(16)).repeat(64)
  }));
}

function manifest() {
  return {
    format: '1js-e2e-live-v1',
    repoId: '1js',
    bindingId: binding.id,
    sourceRevision: revision,
    pipelineDefinitionId: 36540,
    suites: ['cross-app', 'excel-agent'].map(id => ({
      id,
      localRuns: runs(id, false),
      ciRuns: runs(id, true)
    }))
  };
}

test('1JS E2E qualification binds both suites and hashes proof into assignments', () => {
  const qualified = qualify1jsE2eEvidence(binding, skillQualification, manifest());
  assert.equal(qualified.executionQualification.state, 'qualified');
  assert.deepEqual(qualified.executionQualification.suites.map(suite => suite.id),
    ['cross-app', 'excel-agent']);
  assert.match(requireExecutionQualification(binding, qualified), /^[a-f0-9]{64}$/);
  assert.match(pinSkillQualification(qualified, binding).executionQualificationSha256,
    /^[a-f0-9]{64}$/);
});

test('1JS E2E qualification rejects missing suites and fewer than five runs', () => {
  const missing = manifest();
  missing.suites.pop();
  assert.throws(() => qualify1jsE2eEvidence(binding, skillQualification, missing),
    /must cover Cross-App and Excel Agent/);
  const short = manifest();
  short.suites[0].localRuns.pop();
  assert.throws(() => qualify1jsE2eEvidence(binding, skillQualification, short),
    /at least five consecutive passing runs/);
});

test('1JS E2E qualification rejects retries, duplicate CI identities and source drift', () => {
  const retried = manifest();
  retried.suites[0].localRuns[2].retriesDisabled = false;
  assert.throws(() => qualify1jsE2eEvidence(binding, skillQualification, retried),
    /non-passing, retried or source-mismatched/);
  const duplicate = manifest();
  duplicate.suites[1].ciRuns[1].buildId = duplicate.suites[1].ciRuns[0].buildId;
  duplicate.suites[1].ciRuns[1].testRunId = duplicate.suites[1].ciRuns[0].testRunId;
  assert.throws(() => qualify1jsE2eEvidence(binding, skillQualification, duplicate),
    /identities must be valid and distinct/);
  const drifted = manifest();
  drifted.sourceRevision = 'e'.repeat(40);
  assert.throws(() => qualify1jsE2eEvidence(binding, skillQualification, drifted),
    /does not match the exact repository skill source/);
});

test('1JS binding remains fail-closed until live qualification is present', () => {
  assert.throws(() => pinSkillQualification(skillQualification, binding),
    /lacks current Cross-App and Excel Agent live qualification/);
  const example = JSON.parse(readFileSync('pilot.example.json', 'utf8'));
  const configured = example.repositories.find(repo => repo.id === '1js').skillBindings[0];
  assert.equal(configured.executionQualification, '1js-e2e-live-v1');
  assert.equal(configured.enabled, false);
  assert.equal(configured.qualification, 'unqualified');
});
