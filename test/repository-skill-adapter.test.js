import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAt, hash } from '../src/common.js';
import {
  loadRepositorySkill, normalizeSkillResult, pinSkillQualification, qualifyRepositorySkill, resolveSkillBinding
} from '../src/repository-skills.js';

function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'repository-skill-'));
  const workspace = join(root, 'workspace');
  const skillDirectory = join(workspace, 'docs', 'skills', 'Integration-test-core');
  mkdirSync(skillDirectory, { recursive: true });
  writeFileSync(join(skillDirectory, 'SKILL.md'), '# Synthetic OA integration skill\n');
  const config = configAt('pilot.example.json');
  config.limits.maxFileBytes = 262144;
  config.repositories = [{
    id: 'office-src', owner: 'oa-owner', routingApproved: true,
    referenceCheckout: workspace, baseRef: 'main',
    remote: 'https://office.visualstudio.com/ISS/_git/OfficeAgent',
    skillBindings: [{
      id: 'oa-integration-test-core', capability: 'integration-test-authoring',
      skillPath: 'docs/skills/Integration-test-core/SKILL.md', enabled: true, qualification: 'qualified',
      requestedOutcomes: ['add-or-update-tests'],
      sideEffects: { commit: false, push: false, createDraftPR: false }
    }]
  }];
  const assignment = {
    repoId: 'office-src', capability: 'integration-test-authoring',
    skillBindingId: 'oa-integration-test-core'
  };
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, workspace, config, assignment };
}
function qualification(config, assignment, revision, instructions = '# Synthetic OA integration skill\n') {
  const binding = config.repositories[0].skillBindings[0];
  const receipt = {
    state: 'qualified-read-only', repoId: assignment.repoId, bindingId: assignment.skillBindingId,
    capability: assignment.capability, remote: config.repositories[0].remote,
    baseRef: config.repositories[0].baseRef, baseRevision: revision,
    skillPath: binding.skillPath.replaceAll('\\', '/'), skillSha256: hash(instructions),
    sideEffects: binding.sideEffects
  };
  assignment.skillQualification = pinSkillQualification(receipt);
  return receipt;
}

test('adapter loads exactly the configured repository skill at the bound source revision', t => {
  const { workspace, config, assignment } = setup(t);
  const revision = 'a'.repeat(40);
  const receipt = qualification(config, assignment, revision);
  const loaded = loadRepositorySkill(config, assignment, workspace, revision, receipt);
  assert.match(loaded.instructions, /Synthetic OA integration skill/);
  assert.equal(loaded.skillPath, 'docs/skills/Integration-test-core/SKILL.md');
  assert.equal(loaded.skillRevision, 'a'.repeat(40));
});

test('skill binding is fail-closed when disabled, unqualified or ambiguous', t => {
  const { config } = setup(t);
  config.repositories[0].skillBindings[0].enabled = false;
  assert.throws(() => resolveSkillBinding(config, 'office-src', 'integration-test-authoring'), /disabled/);
  config.repositories[0].skillBindings[0].enabled = true;
  config.repositories[0].skillBindings[0].qualification = 'unqualified';
  assert.throws(() => resolveSkillBinding(config, 'office-src', 'integration-test-authoring'), /unqualified/);
  config.repositories[0].skillBindings[0].qualification = 'qualified';
  config.repositories[0].skillBindings.push({
    ...structuredClone(config.repositories[0].skillBindings[0]), id: 'duplicate'
  });
  assert.throws(() => resolveSkillBinding(config, 'office-src', 'integration-test-authoring'), /unambiguous/);
});

test('read-only qualification verifies an exact repository revision before routing is enabled', async t => {
  const { config } = setup(t);
  const repo = config.repositories[0];
  repo.owner = null;
  repo.routingApproved = false;
  repo.skillBindings[0].enabled = false;
  repo.skillBindings[0].qualification = 'unqualified';
  const revision = 'd'.repeat(40);
  const calls = [];
  const result = await qualifyRepositorySkill(config, 'office-src', 'integration-test-authoring',
    'oa-integration-test-core', async (executable, args, cwd) => {
      calls.push({ executable, args, cwd });
      const operation = args[2];
      if (operation === 'rev-parse') return { stdout: `${revision}\n` };
      if (operation === 'remote') return { stdout: `${repo.remote}\n` };
      if (operation === 'cat-file') return { stdout: '' };
      if (operation === 'show') return { stdout: '# Synthetic OA integration skill\n' };
      throw new Error(`Unexpected operation ${operation}`);
    });
  assert.equal(result.baseRevision, revision);
  assert.equal(result.state, 'qualified-read-only');
  assert.equal(result.skillPath, 'docs/skills/Integration-test-core/SKILL.md');
  assert.match(result.skillSha256, /^[a-f0-9]{64}$/);
  assert.deepEqual(calls.map(call => call.args[2]), ['rev-parse', 'remote', 'cat-file', 'show']);
});

test('adapter rejects path traversal and reparse-point skill paths', t => {
  const { root, workspace, config, assignment } = setup(t);
  config.repositories[0].skillBindings[0].skillPath = '..\\outside.md';
  const revision = 'b'.repeat(40);
  let receipt = qualification(config, assignment, revision);
  assert.throws(() => loadRepositorySkill(config, assignment, workspace, revision, receipt), /escapes workspace/);
  const external = join(root, 'external');
  mkdirSync(external);
  writeFileSync(join(external, 'SKILL.md'), '# external\n');
  const linked = join(workspace, 'docs', 'linked');
  symlinkSync(external, linked, process.platform === 'win32' ? 'junction' : 'dir');
  config.repositories[0].skillBindings[0].skillPath = 'docs/linked/SKILL.md';
  receipt = qualification(config, assignment, revision, '# external\n');
  assert.throws(() => loadRepositorySkill(config, assignment, workspace, revision, receipt), /Symlink|reparse/);
});

test('skill result normalization is deterministic and rejects success-shaped empty output', t => {
  const { workspace, config, assignment } = setup(t);
  const revision = 'c'.repeat(40);
  const receipt = qualification(config, assignment, revision);
  const loaded = loadRepositorySkill(config, assignment, workspace, revision, receipt);
  const result = normalizeSkillResult(loaded, {
    status: 'succeeded', classification: 'missing-coverage',
    changedFiles: ['test/new.test.js', 'test/new.test.js'],
    testsAddedOrUpdated: ['new test'], behaviorCardsAddedOrUpdated: [],
    unknowns: [], needsHumanDecision: false
  });
  assert.deepEqual(result.changedFiles, ['test/new.test.js']);
  assert.equal(result.bindingId, 'oa-integration-test-core');
  assert.throws(() => normalizeSkillResult(loaded, {
    status: 'succeeded', classification: 'missing-coverage',
    changedFiles: [], testsAddedOrUpdated: [], behaviorCardsAddedOrUpdated: [],
    unknowns: [], needsHumanDecision: false
  }), /existing coverage/);
});

test('adapter rejects missing, changed or source-mismatched qualification receipts', t => {
  const { workspace, config, assignment } = setup(t);
  const revision = 'e'.repeat(40);
  assert.throws(() => loadRepositorySkill(config, assignment, workspace, revision, null), /receipt is missing/);
  const receipt = qualification(config, assignment, revision);
  writeFileSync(join(workspace, 'docs', 'skills', 'Integration-test-core', 'SKILL.md'), '# changed\n');
  assert.throws(() => loadRepositorySkill(config, assignment, workspace, revision, receipt), /content changed/);
  writeFileSync(join(workspace, 'docs', 'skills', 'Integration-test-core', 'SKILL.md'),
    '# Synthetic OA integration skill\n');
  assert.throws(() => loadRepositorySkill(config, assignment, workspace, 'f'.repeat(40), receipt),
    /source revision/);
});
