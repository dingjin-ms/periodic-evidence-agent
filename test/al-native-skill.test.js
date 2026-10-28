import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { configAt, hash } from '../src/common.js';
import { alTestPrefixes } from '../src/al-adapter.js';
import { alAuthoringSkillPath, alWorkflowNativeConfig, requireAlProposerSkills } from '../src/al-workflow.js';
import {
  loadRepositorySkill, pinSkillQualification, qualifyRepositorySkill, verifyRepositorySkillWorkspace
} from '../src/repository-skills.js';
import { authoringPrompt, makeAssignment, WorkerTools } from '../src/workers.js';

const companionPath = `${alAuthoringSkillPath.slice(0, -'SKILL.md'.length)}references/suites.md`;
const legacyPath = 'utils/testing/.github/skills/augloop-integration-test-authoring/SKILL.md';
const skillText = '# Synthetic integration skill\nRead [suites](references/suites.md).\n';
const companionText = '# Synthetic suites\nUse the approved owner tests only.\n';

function fixture(t) {
  const storage = join(process.cwd(), '.state', 'al-merged-skill-fixtures');
  mkdirSync(storage, { recursive: true });
  const root = mkdtempSync(join(storage, 'case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'product');
  mkdirSync(workspace);
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=.git/no-hooks',
    '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args],
  { cwd: workspace, encoding: 'utf8', stdio: 'pipe' }).trim();
  const write = (path, text) => {
    mkdirSync(dirname(join(workspace, path)), { recursive: true });
    writeFileSync(join(workspace, path), text);
  };
  const commit = message => {
    git(['add', '.']);
    git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
      'commit', '--quiet', '-m', message]);
    return git(['rev-parse', 'HEAD']);
  };
  git(['init', '--quiet']);
  write('.github/skills/tests/SKILL.md', '# Synthetic FILTER guidance, not authoring\n');
  const oldBase = commit('Synthetic baseline without authoring skill');
  write(legacyPath, '# Synthetic historical skill\n');
  const legacySource = commit('Synthetic historical authoring source');
  write(alAuthoringSkillPath, skillText);
  write(companionPath, companionText);
  const base = commit('Synthetic merged authoring path and companion');
  const raw = configAt('pilot.example.json');
  raw.limits.maxItems = 1;
  raw.limits.workerMaxToolCalls = 30;
  const repo = JSON.parse(readFileSync('scaffold/augloop.repository.example.json', 'utf8'));
  repo.owner = 'synthetic-owner';
  repo.referenceCheckout = workspace;
  repo.baseRef = base;
  repo.validationGates = [{ executable: process.execPath }];
  raw.repositories = [repo];
  const config = alWorkflowNativeConfig(raw, join(root, 'native'));
  const configured = config.repositories[0], binding = configured.skillBindings[0];
  git(['remote', 'add', 'origin', configured.remote]);
  const assignment = {
    repoId: configured.id, capability: binding.capability, skillBindingId: binding.id,
    allowedWritePrefixes: [...alTestPrefixes].sort(), allowedWriteFiles: [], evidenceIds: [],
    bounds: { maxToolCalls: 30 }, permissions: { editCode: true }
  };
  const qualify = async () => {
    const receipt = await qualifyRepositorySkill(config, configured.id, binding.capability);
    assignment.skillQualification = pinSkillQualification(receipt);
    configured.routingApproved = true;
    binding.enabled = true;
    binding.qualification = 'qualified';
    return receipt;
  };
  return { root, workspace, config, repo: configured, binding, assignment, git, write,
    base, oldBase, legacySource, qualify };
}

test('default AL scaffold qualifies the exact merged native path and reads companion with normal pilot_read', async t => {
  const f = fixture(t);
  assert.equal(f.binding.id, 'al-integration-test-authoring');
  assert.equal(f.binding.skillPath, alAuthoringSkillPath);
  assert.equal(f.binding.externalBundle, undefined);
  assert.equal(f.binding.enabled, false);
  assert.equal(f.binding.qualification, 'unqualified');
  assert.equal(f.binding.authoringProvider, 'copilot-sdk');
  assert.deepEqual(f.binding.sideEffects, { commit: false, push: false, createDraftPR: false });
  assert.deepEqual(f.binding.allowedWritePrefixes, alTestPrefixes);
  const receipt = await f.qualify();
  assert.equal(receipt.baseRevision, f.base);
  assert.equal(receipt.skillSha256, hash(skillText));
  assert.equal(receipt.externalBundle, undefined);
  const loaded = verifyRepositorySkillWorkspace(f.config, f.assignment, f.workspace, f.base, receipt);
  assert.equal(loaded.skillPath, alAuthoringSkillPath);
  assert.equal(loaded.skillRevision, f.base);
  assert.equal(loaded.instructions, skillText);
  const tools = new WorkerTools(f.config, f.assignment, f.workspace, loaded);
  const read = tools.tools().find(tool => tool.name === 'pilot_read');
  assert.equal(await read.handler({ path: companionPath, startLine: 2, endLine: 2 }),
    'Use the approved owner tests only.');
  assert.equal(tools.read(alAuthoringSkillPath), skillText);
  assert.throws(() => tools.read(`skill-bundle:${companionPath}`), /not available/);
  for (const path of [alAuthoringSkillPath, companionPath, 'utils/excel-agent-in-container-proxy/src/production.ts'])
    assert.throws(() => tools.write(path, 'bad'), /outside approved/);
  assert.equal(f.git(['status', '--porcelain']), '');
});

test('actual AL authoring and repair prompts explicitly invoke the configured path and exact checkout', async t => {
  const f = fixture(t);
  const receipt = await f.qualify();
  const investigation = {
    recordType: 'investigation', schemaVersion: '1.0', id: 'synthetic-investigation', version: 1,
    evidenceIds: ['synthetic-evidence'], state: 'triaged', observedBehavior: 'Synthetic coverage gap',
    expectedBehavior: 'Established behavior is covered', hypotheses: [], counterEvidence: [],
    classification: 'functional', defectConfirmation: 'unconfirmed', reportEligibility: 'included',
    handoffEligibility: 'eligible', exclusionReasons: [], rationale: 'Synthetic review', confidence: 0.8,
    review: { method: 'human-review', reviewer: 'synthetic-reviewer', reviewedAt: new Date().toISOString() },
    repoIds: [f.repo.id], existingFixes: [], nextAction: 'Add focused integration coverage'
  };
  const assignment = makeAssignment(f.config, investigation, f.repo.id, 'improvement', {
    recordType: 'testCoveragePlan', schemaVersion: '1.0', id: 'synthetic-plan', version: 1,
    improvementId: 'synthetic-improvement', improvementVersion: 1,
    repoId: f.repo.id, capability: f.binding.capability, sourceRevision: f.base,
    searchStatus: 'complete', disposition: 'coverage-gap', existingTests: [],
    coverageGaps: ['Synthetic missing assertion'], unknowns: [], rationale: 'Synthetic test plan',
    createdAt: new Date().toISOString(), skillBindingId: f.binding.id,
    skillQualification: pinSkillQualification(receipt), requestedOutcome: 'add-or-update-tests'
  });
  assert.deepEqual(assignment.allowedWritePrefixes, [...alTestPrefixes].sort());
  assert.equal(assignment.skillQualification.baseRevision, f.base);
  assert.equal(assignment.skillQualification.skillPath, alAuthoringSkillPath);
  assert.equal(assignment.authoringProvider, undefined);
  const loaded = loadRepositorySkill(f.config, assignment, f.workspace, f.base, receipt);
  for (const round of [0, 1]) {
    const prompt = authoringPrompt({ get: () => null }, assignment, investigation, loaded,
      { round, validationFeedback: round ? [{ diagnostic: 'Synthetic failure' }] : [] });
    assert.ok(prompt.includes(`Explicitly invoke the configured skill at ${alAuthoringSkillPath} for this authoring or repair task.`));
    assert.ok(prompt.includes(`checkout containing this repository-relative path at exactly ${f.base}`));
    assert.ok(prompt.includes(`resolve skill-relative links from ${dirname(alAuthoringSkillPath).replaceAll('\\', '/')}`));
    assert.match(prompt, /normal repository-relative pilot_read/);
    assert.match(prompt, /Missing guidance is a blocker/);
    assert.match(prompt, /Never modify production code/);
    for (const prefix of alTestPrefixes) assert.ok(prompt.includes(prefix));
    assert.ok(!prompt.includes('skill-bundle:'));
    assert.ok(!prompt.includes(legacyPath));
    assert.ok(!prompt.includes('.github/skills/tests/SKILL.md'));
    assert.ok(!prompt.includes(f.oldBase));
    if (round) assert.ok(prompt.includes('Synthetic failure'));
  }
});

test('AL native routing rejects FILTER, old and missing skill paths without an implicit fallback', async t => {
  const f = fixture(t);
  for (const path of ['.github/skills/tests/SKILL.md', legacyPath, 'unregistered/SKILL.md', undefined]) {
    f.binding.skillPath = path;
    assert.throws(() => alWorkflowNativeConfig(f.config, join(f.root, 'wrong')),
      /merged repository-native integration skill path/);
  }
  f.binding.skillPath = alAuthoringSkillPath;
  f.repo.baseRef = f.oldBase;
  await assert.rejects(f.qualify, /does not exist|exists on disk, but not in/);
  assert.equal(f.assignment.skillQualification, undefined);
  f.repo.baseRef = f.base;
  const receipt = await f.qualify();
  rmSync(join(f.workspace, alAuthoringSkillPath));
  assert.throws(() => loadRepositorySkill(f.config, f.assignment, f.workspace, f.base, receipt),
    /does not exist|ENOENT/);
});

test('AL native runtime blocks source, receipt hash, workspace and configured path drift', async t => {
  const f = fixture(t);
  const receipt = await f.qualify(), original = JSON.stringify(receipt);
  assert.throws(() => loadRepositorySkill(f.config, f.assignment, f.workspace, f.oldBase, receipt),
    /isolated source revision/);
  assert.throws(() => loadRepositorySkill(f.config, f.assignment, f.workspace, f.base,
    { ...receipt, skillSha256: 'a'.repeat(64) }), /qualification changed/);
  f.binding.skillPath = legacyPath;
  assert.throws(() => loadRepositorySkill(f.config, f.assignment, f.workspace, f.base, receipt),
    /isolated source revision/);
  f.binding.skillPath = alAuthoringSkillPath;
  f.write(alAuthoringSkillPath, '# Drifted instructions\n');
  assert.throws(() => loadRepositorySkill(f.config, f.assignment, f.workspace, f.base, receipt),
    /content changed/);
  f.git(['checkout', '--', alAuthoringSkillPath]);
  f.git(['checkout', '--quiet', '--detach', f.oldBase]);
  assert.throws(() => verifyRepositorySkillWorkspace(f.config, f.assignment, f.workspace, f.base, receipt),
    /HEAD differs/);
  assert.equal(JSON.stringify(receipt), original);
});

test('AL missing native companion blocks normal reads without a bundle alias or write permission', async t => {
  const f = fixture(t);
  const loaded = loadRepositorySkill(f.config, f.assignment, f.workspace, f.base, await f.qualify());
  const tools = new WorkerTools(f.config, f.assignment, f.workspace, loaded);
  rmSync(join(f.workspace, companionPath));
  assert.throws(() => tools.read(companionPath), /does not exist|ENOENT/);
  assert.throws(() => tools.read(`skill-bundle:${companionPath}`), /not available/);
});

test('explicit historical AL external binding retains separate source pins and cannot become native implicitly', async t => {
  const f = fixture(t);
  const bytes = f.git(['show', `${f.legacySource}:${legacyPath}`]) + '\n';
  const root = join(f.root, 'historical-bundle');
  mkdirSync(dirname(join(root, legacyPath)), { recursive: true });
  writeFileSync(join(root, legacyPath), bytes);
  f.repo.baseRef = f.oldBase;
  f.binding.skillPath = legacyPath;
  f.binding.externalBundle = { root,
    source: { remote: f.repo.remote, revision: f.legacySource, path: legacyPath },
    files: [{ path: legacyPath, sha256: hash(bytes) }] };
  assert.doesNotThrow(() => requireAlProposerSkills(f.config));
  f.git(['checkout', '--quiet', '--detach', f.oldBase]);
  const receipt = await f.qualify(), original = JSON.stringify(receipt);
  const loaded = verifyRepositorySkillWorkspace(f.config, f.assignment, f.workspace, f.oldBase, receipt);
  assert.equal(loaded.skillRevision, f.legacySource);
  assert.equal(receipt.baseRevision, f.oldBase);
  const tools = new WorkerTools(f.config, f.assignment, f.workspace, loaded);
  assert.equal(tools.read(`skill-bundle:${legacyPath}`), bytes);
  assert.match(authoringPrompt({ get: () => null }, f.assignment, {}, loaded), /NOT a file in the product checkout/);
  delete f.binding.externalBundle;
  assert.throws(() => requireAlProposerSkills(f.config), /merged repository-native/);
  assert.throws(() => loadRepositorySkill(f.config, f.assignment, f.workspace, f.oldBase, receipt),
    /External skill binding changed/);
  assert.equal(JSON.stringify(receipt), original);
});
