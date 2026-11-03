import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { createConnection } from 'node:net';
import Ajv2020 from 'ajv/dist/2020.js';
import addFormats from 'ajv-formats';
import { configAt, hash, validateRecord } from '../src/common.js';
import {
  loadRepositorySkill, normalizeSkillResult, pinSkillQualification,
  qualifyRepositorySkill, readExternalSkill, resolveSkillBinding, verifyRepositorySkillWorkspace
} from '../src/repository-skills.js';
import { authoringPrompt, WorkerTools } from '../src/workers.js';
import { workerToolDefinitions } from '../src/worker-tool-contract.js';
import { startWorkerRpcServer } from '../src/agency-local-authoring.js';

function fixture(t) {
  const storage = join(process.cwd(), '.state', 'external-skill-tests');
  mkdirSync(storage, { recursive: true });
  const root = mkdtempSync(join(storage, 'case-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'reference');
  const bundleRoot = join(root, 'bundle');
  mkdirSync(workspace);
  mkdirSync(bundleRoot);
  const git = args => execFileSync('git', ['-c', 'core.hooksPath=.git/no-hooks',
    '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args],
  { cwd: workspace, encoding: 'utf8', stdio: 'pipe' }).trim();
  git(['init', '--quiet']);
  writeFileSync(join(workspace, 'README.md'), 'Synthetic product baseline\n');
  git(['add', '.']);
  const commit = message => git(['-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', message]);
  commit('Baseline without the skill');
  const base = git(['rev-parse', 'HEAD']);
  const remote = 'https://example.invalid/project/_git/product';
  git(['remote', 'add', 'origin', remote]);
  const skillPath = 'docs/skills/test-authoring/SKILL.md';
  const referencePath = 'docs/skills/test-authoring/references/testing.md';
  const content = new Map([
    [skillPath, '# Synthetic skill\nRead [testing](references/testing.md). Test product code in test/.\n'],
    [referencePath, '# Testing reference\r\nUse existing test conventions.\r\n']
  ]);
  for (const [path, text] of content) {
    for (const target of [join(workspace, path), join(bundleRoot, path)]) {
      mkdirSync(dirname(target), { recursive: true });
      writeFileSync(target, text);
    }
  }
  git(['add', '.']);
  commit('Unmerged skill and companion');
  const source = git(['rev-parse', 'HEAD']);
  git(['checkout', '--quiet', '--detach', base]);
  const config = configAt('pilot.example.json');
  config.limits.maxFileBytes = 262144;
  const binding = {
    id: 'external-tests', capability: 'integration-test-authoring',
    skillPath, enabled: true, qualification: 'qualified',
    requestedOutcomes: ['add-or-update-tests'], allowedWritePrefixes: ['test'],
    requiresBehaviorCard: false,
    sideEffects: { commit: false, push: false, createDraftPR: false },
    externalBundle: {
      root: bundleRoot, source: { remote, revision: source, path: skillPath },
      files: [...content].map(([path, bytes]) => ({ path, sha256: hash(bytes) }))
    }
  };
  const repo = {
    id: 'synthetic', owner: 'owner', routingApproved: true, execution: 'local',
    referenceCheckout: workspace, remote, baseRef: base,
    allowedWritePrefixes: ['test'], validationGates: [], skillBindings: [binding]
  };
  config.repositories = [repo];
  const assignment = {
    repoId: repo.id, capability: binding.capability, skillBindingId: binding.id,
    allowedWritePrefixes: ['test'], allowedWriteFiles: [], evidenceIds: [],
    bounds: { maxToolCalls: 20 }, permissions: { editCode: true }
  };
  const qualify = async () => {
    const receipt = await qualifyRepositorySkill(config, repo.id, binding.capability);
    assignment.skillQualification = pinSkillQualification(receipt);
    return receipt;
  };
  const load = receipt => loadRepositorySkill(config, assignment, workspace, base, receipt);
  return { root, config, repo, binding, workspace, bundleRoot, skillPath, referencePath,
    base, source, content, assignment, qualify, load, git };
}

test('external qualification pins actual source bytes and companions without changing the product baseline', async t => {
  const f = fixture(t);
  const receipt = await f.qualify();
  assert.equal(receipt.baseRevision, f.base);
  assert.equal(receipt.externalBundle.source.revision, f.source);
  assert.equal(receipt.skillSha256, hash(f.content.get(f.skillPath)));
  assert.deepEqual(f.assignment.skillQualification.externalBundle, receipt.externalBundle);
  assert.equal(existsSync(join(f.workspace, f.skillPath)), false);
  assert.equal(f.git(['status', '--porcelain']), '');
  const loaded = verifyRepositorySkillWorkspace(f.config, f.assignment, f.workspace, f.base, receipt);
  assert.equal(loaded.skillRevision, f.source);
  assert.equal(loaded.instructions, f.content.get(f.skillPath));
  assert.equal(readExternalSkill(loaded, `skill-bundle:${f.referencePath}`), f.content.get(f.referencePath));
  assert.deepEqual(loaded.allowedWritePrefixes, ['test']);
  validateRecord(receipt.externalBundle, 'externalSkillBundle');
  const schema = JSON.parse(readFileSync('scaffold/contracts.schema.json', 'utf8'));
  const ajv = new Ajv2020({ strict: false });
  addFormats(ajv);
  ajv.addSchema(schema, 'contracts');
  const validate = ajv.compile({ $ref: 'contracts#/$defs/assignment/properties/skillQualification' });
  assert.equal(validate(f.assignment.skillQualification), true, JSON.stringify(validate.errors));
  const normalized = normalizeSkillResult(loaded, {
    status: 'succeeded', classification: 'existing-coverage', changedFiles: [],
    testsAddedOrUpdated: [], behaviorCardsAddedOrUpdated: [], unknowns: [], needsHumanDecision: false
  });
  assert.deepEqual(normalized.externalBundle, receipt.externalBundle);
  const resultSchema = ajv.compile({ $ref: 'contracts#/$defs/workerResult/properties/skillExecution' });
  assert.equal(resultSchema(normalized), true, JSON.stringify(resultSchema.errors));
});

test('bounded worker read and SDK/local prompt expose only manifest references, without granting writes', async t => {
  const f = fixture(t);
  const loaded = f.load(await f.qualify());
  const tools = new WorkerTools(f.config, f.assignment, f.workspace, loaded);
  assert.equal(tools.read(`skill-bundle:${f.referencePath}`, 2, 2), 'Use existing test conventions.');
  assert.match(tools.read('README.md'), /product baseline/);
  assert.throws(() => tools.read('skill-bundle:README.md'), /exact manifest/);
  assert.throws(() => tools.read(`skill-bundle:../${f.skillPath}`), /exact manifest/);
  assert.throws(() => tools.write(`skill-bundle:${f.referencePath}`, 'bad'), /relative path/);
  assert.throws(() => tools.write(f.skillPath, 'bad'), /outside approved/);
  assert.equal(workerToolDefinitions.find(tool => tool.name === 'pilot_read').inputSchema.properties.path.type, 'string');
  assert.ok(tools.tools().some(tool => tool.name === 'pilot_read'));
  const server = await startWorkerRpcServer(tools);
  try {
    const response = await new Promise((resolve, reject) => {
      const socket = createConnection(server.endpoint);
      let output = '';
      socket.setEncoding('utf8');
      socket.once('error', reject);
      socket.once('connect', () => socket.end(JSON.stringify({
        id: 'reference-read', token: server.token, tool: 'pilot_read',
        args: { path: `skill-bundle:${f.referencePath}`, startLine: 2, endLine: 2 }
      }) + '\n'));
      socket.on('data', chunk => { output += chunk; });
      socket.once('end', () => resolve(JSON.parse(output)));
    });
    assert.equal(response.ok, true);
    assert.equal(response.result, 'Use existing test conventions.');
  } finally { await server.close(); }
  const prompt = authoringPrompt({ get: () => null }, f.assignment, {}, loaded);
  assert.match(prompt, /NOT a file in the product checkout/);
  assert.ok(prompt.includes(`skill-bundle:${f.referencePath}`));
  assert.ok(prompt.includes(f.base));
  assert.ok(prompt.includes(f.source));
  assert.match(prompt, /isolated PRODUCT workspace/);
  writeFileSync(join(f.bundleRoot, f.referencePath), 'changed companion');
  assert.throws(() => tools.read(`skill-bundle:${f.skillPath}`), /content changed/);
  assert.throws(() => authoringPrompt({ get: () => null }, f.assignment, {}, loaded), /content changed/);
  assert.throws(() => normalizeSkillResult(loaded, {}), /content changed/);
});

test('missing files, actual-byte hash drift, and false original provenance fail qualification', async t => {
  const f = fixture(t);
  writeFileSync(join(f.bundleRoot, f.referencePath), 'changed companion');
  await assert.rejects(f.qualify, /content changed/);
  f.binding.externalBundle.files.find(file => file.path === f.referencePath).sha256 = hash('changed companion');
  await assert.rejects(f.qualify, /source provenance/);
  rmSync(join(f.bundleRoot, f.referencePath));
  await assert.rejects(f.qualify, /does not exist/);
});

test('missing source revision and source file fail closed without falling back to baseline', async t => {
  const f = fixture(t);
  f.binding.externalBundle.source.revision = 'a'.repeat(40);
  await assert.rejects(f.qualify, /external-provenance/);
  f.binding.externalBundle.source.revision = f.base;
  await assert.rejects(f.qualify, /regular Git blobs/);
});

test('runtime rejects changed files, missing companions, and changed root/provenance/manifest', async t => {
  const f = fixture(t);
  const receipt = await f.qualify();
  const original = structuredClone(f.binding.externalBundle);
  const changedReceipt = structuredClone(receipt);
  changedReceipt.externalBundle.source.revision = f.base;
  assert.throws(() => f.load(changedReceipt), /qualification changed/);
  assert.throws(() => loadRepositorySkill(f.config, f.assignment, f.workspace, f.source, receipt),
    /isolated source revision/);
  for (const mutate of [
    bundle => { bundle.root = join(f.root, 'other'); },
    bundle => { bundle.source.revision = f.base; },
    bundle => { bundle.source.remote = 'https://example.invalid/different'; },
    bundle => { bundle.source.path = 'other.md'; },
    bundle => { bundle.files.pop(); }
  ]) {
    f.binding.externalBundle = structuredClone(original);
    mutate(f.binding.externalBundle);
    assert.throws(() => f.load(receipt), /binding changed|remote must match|source path|unique files/);
  }
  f.binding.externalBundle = structuredClone(original);
  const loaded = f.load(receipt);
  f.binding.externalBundle.source.revision = f.base;
  assert.throws(() => readExternalSkill(loaded, `skill-bundle:${f.skillPath}`), /binding changed/);
  f.binding.externalBundle = structuredClone(original);
  writeFileSync(join(f.bundleRoot, f.skillPath), 'different instructions');
  assert.throws(() => f.load(receipt), /content changed/);
  writeFileSync(join(f.bundleRoot, f.skillPath), f.content.get(f.skillPath));
  rmSync(join(f.bundleRoot, f.referencePath));
  assert.throws(() => f.load(receipt), /does not exist/);
});

test('external manifests reject traversal, ambiguous paths, duplicates, credentials, and symlink roots', async t => {
  const f = fixture(t);
  const original = structuredClone(f.binding.externalBundle);
  for (const path of ['../outside.md', 'docs/../outside.md', 'docs\\file.md',
    'C:/outside.md', '/outside.md', 'docs//file.md', 'docs/file.md ', 'docs/*.md']) {
    f.binding.externalBundle = structuredClone(original);
    f.binding.externalBundle.files[1].path = path;
    await assert.rejects(f.qualify);
  }
  f.binding.externalBundle = structuredClone(original);
  f.binding.externalBundle.files.push({ ...original.files[0], path: original.files[0].path.toUpperCase() });
  await assert.rejects(f.qualify, /unique files/);
  f.binding.externalBundle = structuredClone(original);
  f.binding.externalBundle.source.remote = 'https://user:secret@example.invalid/repo';
  await assert.rejects(f.qualify, /credential-free/);
  f.binding.externalBundle = structuredClone(original);
  const linked = join(f.root, 'linked');
  symlinkSync(f.bundleRoot, linked, process.platform === 'win32' ? 'junction' : 'dir');
  f.binding.externalBundle.root = linked;
  await assert.rejects(f.qualify, /Symlink|reparse/);
  f.binding.externalBundle = structuredClone(original);
  const docs = join(f.bundleRoot, 'docs');
  rmSync(docs, { recursive: true });
  symlinkSync(f.workspace, docs, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(f.qualify, /Symlink|reparse/);
});

test('external config is opt-in, config-relative, bounded, and local-only', async t => {
  const f = fixture(t);
  const configPath = join(f.root, 'pilot.local.json');
  f.binding.externalBundle.root = relative(f.root, f.bundleRoot);
  writeFileSync(configPath, JSON.stringify(f.config));
  const config = configAt(configPath);
  assert.equal(config.repositories[0].skillBindings[0].externalBundle.root, f.bundleRoot);
  const binding = config.repositories[0].skillBindings[0];
  binding.authoringProvider = 'remote';
  config.authoringProviders.remote = { type: 'agency-remote' };
  assert.throws(() => resolveSkillBinding(config, f.repo.id, binding.capability), /local authoring/);
  delete binding.authoringProvider;
  config.repositories[0].execution = 'hosted';
  assert.throws(() => resolveSkillBinding(config, f.repo.id, binding.capability), /local execution/);
  config.repositories[0].execution = 'local';
  config.limits.maxFileBytes = 10;
  await assert.rejects(() => qualifyRepositorySkill(config, f.repo.id, binding.capability), /read limit/);
});

test('native repository skills retain commit-bound loading with no external binding or read surface', async t => {
  const f = fixture(t);
  delete f.binding.externalBundle;
  f.repo.baseRef = f.source;
  f.git(['checkout', '--quiet', '--detach', f.source]);
  const receipt = await f.qualify();
  assert.equal(receipt.externalBundle, undefined);
  assert.equal(f.assignment.skillQualification.externalBundle, undefined);
  const loaded = loadRepositorySkill(f.config, f.assignment, f.workspace, f.source, receipt);
  assert.equal(loaded.skillRevision, f.source);
  assert.equal(loaded.externalBundle, undefined);
  assert.equal(loaded.instructions, f.content.get(f.skillPath));
  assert.throws(() => readExternalSkill(loaded, `skill-bundle:${f.referencePath}`), /not available/);
});
