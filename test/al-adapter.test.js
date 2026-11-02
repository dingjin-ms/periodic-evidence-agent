import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { channel } from 'node:diagnostics_channel';
import { alOwners, alTestPrefixes, alReference, alNativeConfig, requireAlPaths, inspectAlSource, inspectAlNativeProof,
  requireAlQualification, withAlPreparationProgress } from '../src/al-adapter.js';

function directory(t) {
  const root = mkdtempSync(join(tmpdir(), 'al-adapter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return root;
}
function put(path, value) {
  mkdirSync(resolve(path, '..'), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}
test('AL records existing native preparation subphases and unsubscribes even on failure', async t => {
  const root = directory(t), progress = channel('periodic-evidence-agent.validation-preparation');
  const first = { phase: 'copy', state: 'finished', elapsedMs: 10, workspace: root };
  const second = { event: 'output-fingerprint-tasks', completed: 2, total: 3, workspace: root };
  await assert.rejects(withAlPreparationProgress(root, async () => {
    progress.publish(first);
    progress.publish(second);
    throw new Error('Synthetic native failure');
  }), /Synthetic native failure/);
  const file = join(root, 'native-progress.ndjson');
  const before = readFileSync(file, 'utf8');
  const records = before.trim().split('\n').map(JSON.parse);
  assert.equal(records.length, 2);
  assert.deepEqual(records.map(({ observedAt, ...event }) => event), [first, second]);
  assert.deepEqual(JSON.parse(readFileSync(join(root, 'native-subphase.json'), 'utf8')), records[1]);
  progress.publish({ event: 'outside-completed-operation' });
  assert.equal(readFileSync(file, 'utf8'), before);
});
test('fresh AL configuration cannot inherit historical repair feedback or early execution qualification', () => {
  const feedback = { path: 'synthetic-old-repair.json', sha256: 'a'.repeat(64) };
  const template = {
    runtime: { authoringFeedback: feedback, executionAuthorization: { historical: true } },
    limits: {}, activation: { collect: true, review: true, dispatch: true },
    repositories: [{ id: 'augloop-workflows', remote: 'https://dev.azure.com/office/ISS/_git/augloop-workflows',
      validationGates: [{ executable: process.execPath }],
      skillBindings: [{ enabled: true, qualification: 'qualified', sideEffects: { commit: true } }] }]
  };
  const config = alNativeConfig(template, process.cwd(), 'candidate');
  assert.equal(config.runtime.authoringFeedback, undefined);
  assert.equal(config.runtime.executionAuthorization, undefined);
  assert.deepEqual(template.runtime.authoringFeedback, feedback);
  assert.deepEqual(config.activation, { collect: false, review: false, dispatch: false });
  assert.equal(config.repositories[0].validationGates[0].isolationVerified, false);
  assert.equal(config.repositories[0].skillBindings[0].enabled, false);
  assert.deepEqual(config.repositories[0].skillBindings[0].sideEffects, { commit: false, push: false, createDraftPR: false });
  assert.deepEqual(config.repositories[0].allowedWritePrefixes, alTestPrefixes);
});
test('AL routes all four integration owners and dedicated fixtures, never other code', () => {
  for (const prefix of alTestPrefixes)
    assert.doesNotThrow(() => requireAlPaths([`${prefix}/new.integration.test.ts`, `${prefix}/fixtures/input.json`]));
  for (const paths of [[], ['utils/unknown/tests/new.integration.test.ts'],
    ['utils/doclab-serialization/src/new.integration.test.ts'],
    ['utils/doclab-serialization/tests/unit.test.ts'],
    ['utils/doclab-serialization/tests/fixtures/input.json'],
    ['utils/doclab-serialization/tests/../src/new.integration.test.ts'],
    ['utils/doclab-serialization/tests/fixtures/..\\..\\src/file.integration.test.ts']])
    assert.throws(() => requireAlPaths(paths), /AL|Unsupported/);
});
test('AL inspection binds actual native scripts and reports owner dependency differences', async () => {
  const revision = 'a'.repeat(40);
  const manifests = new Map(alOwners.map(owner => [`${owner.path}/package.json`,
    { name: owner.package, scripts: { build: 'gulp build', test: owner.testScript },
      dependencies: { '@fixture/dependency': 'workspace:^', external: '1.0.0' } }]));
  const execute = async (_exe, args) => {
    if (args.includes('rev-parse')) return { stdout: revision };
    if (args.includes('status')) return { stdout: '' };
    const path = args.at(-1).split(':').slice(1).join(':');
    return { stdout: JSON.stringify(manifests.get(path) ?? { source: path }) };
  };
  const repo = { referenceCheckout: process.cwd(), baseRef: revision };
  const source = await inspectAlSource(repo, execute);
  assert.equal(source.revision, revision);
  assert.equal(source.files.filter(file => file.owner).length, 4);
  assert.deepEqual(source.files[0].workspaceDependencies, ['@fixture/dependency']);
  manifests.get('server/session-protocol/package.json').scripts.test = 'run -T jest';
  await assert.rejects(inspectAlSource(repo, execute), /Unsupported native AL contract/);
});
test('AL native qualification requires four distinct nonempty original owner results and intact raw artifacts', t => {
  const root = directory(t), revision = 'a'.repeat(40), profileSha256 = 'c'.repeat(64);
  const proofs = alOwners.map((owner, index) => {
    const resultPath = join(root, `raw-${index}.json`);
    put(resultPath, { synthetic: true, passed: 1 });
    return { mode: 'qualification', owner: owner.path, package: owner.package, runner: owner.runner,
      sourceRevision: revision, suiteCount: 1, testCount: 1,
      selectedTests: [`${owner.path}/${owner.tests}/original.integration.test.ts`],
      resultPath, resultSha256: alReference(resultPath).sha256 };
  });
  const artifactPath = join(root, 'validation.json');
  const artifact = values => put(artifactPath, { status: 'passed', revision, profileSha256,
    output: { stdout: values.map(proof => `PILOT_VALIDATION_TEST_RESULT:${JSON.stringify(proof)}`).join('\n') } });
  const results = [{ status: 'passed', sourceRevision: revision, artifactRefs: [artifactPath] }];
  artifact(proofs);
  assert.equal(inspectAlNativeProof(results, revision, 'qualification', profileSha256).owners.length, 4);
  assert.throws(() => inspectAlNativeProof(results, revision, 'qualification', 'd'.repeat(64)), /exact head/);
  const gate = { id: 'synthetic-native', approved: true, executable: process.execPath, profileSha256,
    testRebuiltOutputPaths: alOwners.map(owner => `${owner.path}/dist`) };
  const repo = { id: 'synthetic', remote: 'synthetic://repository', baseRef: revision, validationGates: [gate] };
  const configPath = join(root, 'config.json');
  const cacheDirectory = join(root, 'cache');
  put(configPath, { repositories: [repo], runtime: { validationCacheDirectory: cacheDirectory } });
  const qualified = { state: 'qualified-native-backend', baseRevision: revision, revision,
    profile: { sha256: profileSha256 }, cacheDirectory,
    config: alReference(configPath), validation: results,
    ...inspectAlNativeProof(results, revision, 'qualification', profileSha256) };
  assert.equal(requireAlQualification(qualified, repo).owners.length, 4);
  assert.throws(() => requireAlQualification({ ...qualified, cacheDirectory: join(root, 'other-cache') }, repo),
    /cache binding/);
  assert.throws(() => requireAlQualification({ ...qualified, owners: [] }, repo), /sealed owner/);
  const changedProofs = proofs.map((proof, index) => index ? proof : { ...proof, testCount: 2 });
  artifact(changedProofs);
  assert.throws(() => requireAlQualification(qualified, repo), /sealed artifact/);
  assert.throws(() => requireAlQualification({ ...qualified, artifact: alReference(artifactPath) }, repo),
    /sealed owner/);
  artifact(proofs);
  const sealedQualification = JSON.stringify(qualified);
  put(proofs[0].resultPath, { synthetic: true, coordinatedReplacement: true });
  const replacedRawProofs = proofs.map((proof, index) => index ? proof : {
    ...proof, resultSha256: alReference(proof.resultPath).sha256
  });
  artifact(replacedRawProofs);
  assert.equal(inspectAlNativeProof(results, revision, 'qualification', profileSha256).owners.length, 4);
  assert.throws(() => requireAlQualification(qualified, repo), /sealed artifact/);
  assert.equal(JSON.stringify(qualified), sealedQualification);
  put(proofs[0].resultPath, { synthetic: true, passed: 1 });
  artifact(proofs);
  const redirectedArtifact = join(root, 'redirected-validation.json');
  put(redirectedArtifact, JSON.parse(readFileSync(artifactPath, 'utf8')));
  assert.throws(() => requireAlQualification({ ...qualified,
    validation: [{ ...results[0], artifactRefs: [redirectedArtifact] }] }, repo), /sealed artifact/);
  assert.throws(() => requireAlQualification(qualified,
    { ...repo, validationGates: [{ ...gate, executable: 'different-runner' }] }), /native runner/);
  assert.throws(() => requireAlQualification(qualified,
    { ...repo, validationGates: [{ ...gate, testRebuiltOutputPaths: [] }] }), /immutable-output contract/);
  assert.throws(() => requireAlQualification(qualified, { ...repo, remote: 'different://repository' }), /different repository/);
  for (const changed of [
    proofs.slice(0, 3),
    [proofs[0], proofs[0], proofs[2], proofs[3]],
    proofs.map((proof, index) => index ? proof : { ...proof, testCount: 0 }),
    proofs.map((proof, index) => index ? proof : { ...proof, selectedTests: [] }),
    proofs.map((proof, index) => index ? proof : { ...proof, sourceRevision: 'b'.repeat(40) }),
    proofs.map((proof, index) => index ? proof : { ...proof, mode: 'candidate' }),
    proofs.map((proof, index) => index ? proof : { ...proof, runner: 'jest' })
  ]) {
    artifact(changed);
    assert.throws(() => inspectAlNativeProof(results, revision, 'qualification', profileSha256), /AL|Incomplete/);
  }
  artifact(proofs);
  put(proofs[0].resultPath, { synthetic: true, changed: true });
  assert.throws(() => inspectAlNativeProof(results, revision, 'qualification', profileSha256), /Incomplete/);
  assert.throws(() => inspectAlNativeProof([{ ...results[0], status: 'blocked' }], revision, 'qualification', profileSha256),
    /cleanup must pass/);
});
test('native AL policy distinguishes baseline qualification, real candidate changes and unsupported owners',
  { skip: process.platform !== 'win32' }, t => {
    const root = directory(t), workspace = join(root, 'workspace'), artifacts = join(root, 'artifacts');
    mkdirSync(workspace);
    const git = args => execFileSync('git', ['-c', 'core.hooksPath=.git/no-hooks', ...args],
      { cwd: workspace, encoding: 'utf8', stdio: 'pipe' }).trim();
    git(['init', '--quiet']);
    git(['config', 'core.autocrlf', 'false']);
    git(['config', 'user.email', 'synthetic@example.invalid']);
    git(['config', 'user.name', 'Synthetic AL profile test']);
    put(join(workspace, '.node-version'), process.versions.node);
    put(join(workspace, '.yarn/releases/yarn-3.2.1.cjs'), 'process.exit(0);\n');
    for (const owner of alOwners) {
      put(join(workspace, owner.path, 'package.json'), {
        name: owner.package, scripts: { build: 'gulp build', test: owner.testScript }
      });
      put(join(workspace, owner.path, owner.tests, 'original.integration.test.ts'), '// Synthetic policy fixture\n');
    }
    git(['add', '.']); git(['commit', '--quiet', '-m', 'Synthetic baseline']);
    const base = git(['rev-parse', 'HEAD']);
    const profile = resolve('scripts/validation/augloop-integration.ps1');
    const invoke = (mode, head = base) => execFileSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', profile, '-Mode', mode, '-ArtifactDirectory', artifacts],
      { cwd: workspace, encoding: 'utf8', stdio: 'pipe', env: { ...process.env,
        PILOT_VALIDATION_STAGE: 'policy', PILOT_VALIDATION_BASE_REVISION: base, PILOT_VALIDATION_REVISION: head } });
    assert.doesNotThrow(() => invoke('qualification'));
    assert.throws(() => invoke('candidate'), /nonempty candidate diff/);
    put(join(workspace, alTestPrefixes[0], 'new.integration.test.ts'), '// Synthetic changed test\n');
    git(['add', '.']); git(['commit', '--quiet', '-m', 'Synthetic candidate']);
    const candidate = git(['rev-parse', 'HEAD']);
    assert.doesNotThrow(() => invoke('candidate', candidate));
    assert.throws(() => invoke('qualification', candidate), /unchanged baseline/);
    assert.throws(() => invoke('candidate', base), /HEAD mismatch/);
    put(join(workspace, 'utils/unknown/tests/new.integration.test.ts'), '// Unsupported owner\n');
    git(['add', '.']); git(['commit', '--quiet', '-m', 'Synthetic unsupported owner']);
    assert.throws(() => invoke('candidate', git(['rev-parse', 'HEAD'])), /Unsupported owner/);
    assert.equal(readFileSync(join(workspace, '.node-version'), 'utf8'), process.versions.node);
  });
test('native AL authentication uses the same neutral provider cwd as established OA remediation',
  { skip: process.platform !== 'win32' }, t => {
    const root = directory(t), workspace = join(root, 'workspace'), neutral = join(root, 'neutral');
    const bin = join(root, 'bin');
    mkdirSync(workspace); mkdirSync(neutral); mkdirSync(bin);
    put(join(workspace, '.yarnrc.yml'),
      'npmRegistryServer: https://office.pkgs.visualstudio.com/_packaging/AugmentationLoop/npm/registry/\n');
    put(join(bin, 'node_modules/@microsoft/artifacts-npm-credprovider/package.json'), { version: '1.2.1' });
    put(join(bin, 'provider.cjs'),
      "console.log(process.cwd().endsWith('workspace') ? 'need refresh' : 'credentials valid');\n");
    put(join(bin, 'artifacts-npm-credprovider.cmd'),
      `@echo off\r\n"${process.execPath}" "%~dp0provider.cjs" %*\r\n`);
    const output = execFileSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', resolve('scripts/validation/augloop-integration.ps1'),
        '-Mode', 'qualification', '-ArtifactDirectory', join(root, 'artifacts')],
      { cwd: workspace, encoding: 'utf8', stdio: 'pipe',
        env: { ...process.env, PATH: `${bin};${process.env.PATH}`, TEMP: neutral, TMP: neutral,
          PILOT_VALIDATION_STAGE: 'authentication-check' } });
    const proof = JSON.parse(output.split(/\r?\n/).find(line => line.startsWith('PILOT_VALIDATION_AUTH_PREFLIGHT:'))
      .slice('PILOT_VALIDATION_AUTH_PREFLIGHT:'.length));
    assert.equal(proof.state, 'ready');
    assert.equal(proof.feedCount, 1);
    assert.equal(proof.tokenRecorded, false);
  });
test('native AL sparse installs preserve filtered locks and still reject real source and untracked changes',
  { skip: process.platform !== 'win32' }, t => {
    const root = directory(t), workspace = join(root, 'workspace'), bin = join(root, 'bin');
    mkdirSync(workspace); mkdirSync(bin);
    const git = args => execFileSync('git', ['-c', 'core.hooksPath=.git/no-hooks', ...args],
      { cwd: workspace, encoding: 'utf8', stdio: 'pipe' }).trim();
    git(['init', '--quiet']); git(['config', 'core.autocrlf', 'false']);
    git(['config', 'user.email', 'synthetic@example.invalid']);
    git(['config', 'user.name', 'Synthetic AL dependency test']);
    put(join(workspace, '.node-version'), process.versions.node);
    put(join(workspace, '.yarnrc.yml'),
      'npmRegistryServer: https://office.pkgs.visualstudio.com/_packaging/AugmentationLoop/npm/registry/\n');
    put(join(workspace, 'package.json'), '{}\n');
    put(join(workspace, 'yarn.lock'), 'committed lock\n');
    put(join(workspace, 'Cargo.toml'), 'committed cargo\n');
    put(join(workspace, 'Cargo.lock'), 'committed cargo lock\n');
    put(join(workspace, '.yarn/releases/yarn-3.2.1.cjs'), `
      const fs = require('node:fs'), { execFileSync } = require('node:child_process');
      if (process.argv[2] === 'install') {
        const args = process.argv.slice(2);
        fs.writeFileSync(process.env.AL_SYNTHETIC_CAPTURE, JSON.stringify(args));
        const sparse = execFileSync('git', ['config', '--bool', '--default=false', '--get', 'core.sparseCheckout'],
          { encoding: 'utf8' }).trim() === 'true';
        if (sparse) {
          if (!args.includes('--no-immutable')) throw new Error('Sparse lock regeneration was forbidden');
          fs.writeFileSync('yarn.lock', 'derived sparse lock\\n');
          execFileSync('git', ['add', '--renormalize', 'yarn.lock']);
          fs.writeFileSync('Cargo.toml', 'derived sparse cargo\\n');
          fs.writeFileSync('Cargo.lock', 'derived sparse cargo lock\\n');
        } else if (!args.includes('--immutable')) throw new Error('Full checkout must retain immutable install');
        if (process.env.AL_SYNTHETIC_MUTATION === 'true') fs.writeFileSync('package.json', '{"changed":true}\\n');
      }
    `);
    for (const owner of alOwners) put(join(workspace, owner.path, 'package.json'),
      { name: owner.package, scripts: { build: 'gulp build', test: owner.testScript } });
    put(join(bin, 'node_modules/@microsoft/artifacts-npm-credprovider/package.json'), { version: '1.2.1' });
    put(join(bin, 'artifacts-npm-credprovider.cmd'), '@echo off\r\nexit /b 0\r\n');
    put(join(bin, 'augloop.cmd'), '@echo off\r\nexit /b 0\r\n');
    git(['add', '.']); git(['commit', '--quiet', '-m', 'Synthetic dependency fixture']);
    const capture = join(root, 'install-args.json');
    const invoke = (stage = 'dependencies', mutation = false) => execFileSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', resolve('scripts/validation/augloop-integration.ps1'),
        '-Mode', 'qualification', '-ArtifactDirectory', join(root, 'artifacts')],
      { cwd: workspace, encoding: 'utf8', stdio: 'pipe', env: { ...process.env,
        PATH: `${bin};${process.env.PATH}`, PILOT_VALIDATION_STAGE: stage, AL_SYNTHETIC_CAPTURE: capture,
        AL_SYNTHETIC_MUTATION: mutation ? 'true' : 'false' } });
    invoke();
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), ['install', '--immutable']);
    git(['config', 'core.sparseCheckout', 'false']);
    invoke();
    assert.equal(readFileSync(join(workspace, 'yarn.lock'), 'utf8'), 'committed lock\n');
    git(['config', 'core.sparseCheckout', 'true']);
    git(['config', 'filter.synthetic-lock.clean', 'git show HEAD:%f']);
    put(join(workspace, '.git/info/attributes'),
      'yarn.lock filter=synthetic-lock\nCargo.toml filter=synthetic-lock\nCargo.lock filter=synthetic-lock\n');
    put(join(workspace, 'Cargo.toml'), 'materialized derived sparse cargo\n');
    assert.doesNotThrow(() => invoke());
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), ['install', '--no-immutable']);
    assert.equal(readFileSync(join(workspace, 'yarn.lock'), 'utf8'), 'derived sparse lock\n');
    for (const [path, original] of [['yarn.lock', 'committed lock'], ['Cargo.toml', 'committed cargo'],
      ['Cargo.lock', 'committed cargo lock']]) assert.equal(git(['show', `HEAD:${path}`]), original);
    assert.equal(git(['status', '--porcelain']), '');
    put(join(workspace, 'Cargo.lock'), 'rematerialized sparse cargo lock\n');
    assert.doesNotThrow(() => invoke('compile'));
    assert.equal(git(['status', '--porcelain']), '');
    assert.throws(() => invoke('dependencies', true), /AL validation workspace is not clean/);
    put(join(workspace, 'package.json'), '{}\n');
    put(join(workspace, 'unexpected.txt'), 'untracked source\n');
    assert.throws(() => invoke('compile'), /AL validation workspace is not clean/);
    rmSync(join(workspace, 'unexpected.txt'));
    put(join(workspace, '.git/info/attributes'), 'yarn.lock filter=synthetic-lock\n');
    put(join(workspace, 'Cargo.toml'), 'real unfiltered cargo change\n');
    assert.throws(() => invoke('compile'), /AL validation workspace is not clean/);
    assert.ok(git(['diff', '--cached', '--name-only']).split(/\r?\n/).includes('Cargo.toml'));
    assert.equal(readFileSync(join(workspace, 'Cargo.toml'), 'utf8'), 'real unfiltered cargo change\n');
  });
test('native AL closure build delivers four separate package arguments to the native CLI',
  { skip: process.platform !== 'win32' }, t => {
    const root = directory(t), workspace = join(root, 'workspace'), bin = join(root, 'bin');
    mkdirSync(workspace); mkdirSync(bin);
    const git = args => execFileSync('git', ['-c', 'core.hooksPath=.git/no-hooks', ...args],
      { cwd: workspace, encoding: 'utf8', stdio: 'pipe' });
    git(['init', '--quiet']); git(['config', 'core.autocrlf', 'false']);
    git(['config', 'user.email', 'synthetic@example.invalid']); git(['config', 'user.name', 'Synthetic AL build test']);
    put(join(workspace, '.node-version'), process.versions.node);
    put(join(workspace, '.yarn/releases/yarn-3.2.1.cjs'), 'process.exit(0);\n');
    for (const owner of alOwners) put(join(workspace, owner.path, 'package.json'),
      { name: owner.package, scripts: { build: 'gulp build', test: owner.testScript } });
    git(['add', '.']); git(['commit', '--quiet', '-m', 'Synthetic build fixture']);
    const capture = join(root, 'args.json');
    put(join(bin, 'augloop.cjs'),
      "require('fs').writeFileSync(process.env.AL_SYNTHETIC_CAPTURE, JSON.stringify(process.argv.slice(2)));\n");
    put(join(bin, 'augloop.cmd'), `@echo off\r\n"${process.execPath}" "%~dp0augloop.cjs" %*\r\n`);
    execFileSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', resolve('scripts/validation/augloop-integration.ps1'),
        '-Mode', 'qualification', '-ArtifactDirectory', join(root, 'artifacts')],
      { cwd: workspace, encoding: 'utf8', stdio: 'pipe', env: { ...process.env,
        PATH: `${bin};${process.env.PATH}`, PILOT_VALIDATION_STAGE: 'compile', AL_SYNTHETIC_CAPTURE: capture } });
    assert.deepEqual(JSON.parse(readFileSync(capture, 'utf8')), ['build', ...alOwners.map(owner => owner.package)]);
  });
test('native AL fingerprint has byte-stable ordered keys across fresh PowerShell processes',
  { skip: process.platform !== 'win32' }, t => {
    const root = directory(t), workspace = join(root, 'workspace');
    mkdirSync(workspace);
    put(join(workspace, '.node-version'), process.versions.node);
    put(join(workspace, '.yarn/releases/yarn-3.2.1.cjs'), "console.log('3.2.1');\n");
    for (const owner of alOwners) put(join(workspace, owner.path, 'package.json'),
      { name: owner.package, scripts: { build: 'gulp build', test: owner.testScript } });
    const outputs = [];
    for (let attempt = 0; attempt < 3; attempt++) {
      const output = execFileSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', resolve('scripts/validation/augloop-integration.ps1'),
          '-Mode', 'qualification', '-ArtifactDirectory', join(root, 'artifacts')],
        { cwd: workspace, encoding: 'utf8', stdio: 'pipe',
          env: { ...process.env, PILOT_VALIDATION_STAGE: 'fingerprint' } });
      const line = output.split(/\r?\n/).find(value => value.startsWith('PILOT_VALIDATION_FINGERPRINT:'));
      assert.ok(line);
      const value = JSON.parse(line.slice('PILOT_VALIDATION_FINGERPRINT:'.length));
      assert.deepEqual(Object.keys(value), ['node', 'yarn', 'corepack', 'platform', 'architecture']);
      outputs.push(line);
    }
    assert.equal(new Set(outputs).size, 1);
  });
test('native AL test profile decodes Mocha then three Jest owners without leaking XML variable typing',
  { skip: process.platform !== 'win32' }, t => {
    const root = directory(t), workspace = join(root, 'workspace'), artifacts = join(root, 'artifacts');
    mkdirSync(workspace);
    const git = args => execFileSync('git', ['-c', 'core.hooksPath=.git/no-hooks', ...args],
      { cwd: workspace, encoding: 'utf8', stdio: 'pipe' }).trim();
    git(['init', '--quiet']); git(['config', 'core.autocrlf', 'false']);
    git(['config', 'user.email', 'synthetic@example.invalid']); git(['config', 'user.name', 'Synthetic mixed runner']);
    put(join(workspace, '.node-version'), process.versions.node);
    put(join(workspace, '.gitignore'), 'dist/\nlogs/\n');
    for (const owner of alOwners) {
      put(join(workspace, owner.path, 'package.json'),
        { name: owner.package, scripts: { build: 'gulp build', test: owner.testScript } });
      put(join(workspace, owner.path, owner.tests, 'original.integration.test.ts'), '// Synthetic decoder fixture\n');
    }
    put(join(workspace, '.yarn/releases/yarn-3.2.1.cjs'), `
const fs = require('node:fs'), path = require('node:path');
const owners = ${JSON.stringify(alOwners)};
const args = process.argv.slice(2), owner = owners.find(value => value.package === args[1]);
if (args[2] === 'test') {
  const compiled = path.resolve(owner.path, 'dist', owner.tests, 'original.integration.test.js');
  if (owner.runner === 'mocha') {
    const output = path.resolve(owner.path, 'logs/test-results.xml');
    fs.mkdirSync(path.dirname(output), { recursive: true });
    fs.writeFileSync(output, '<testsuites' + (process.env.AL_SYNTHETIC_PENDING ? ' skipped="1"' : '') +
      '><testsuite file="' + compiled +
      '"><testcase name="synthetic passing assertion"/></testsuite></testsuites>');
  } else {
    fs.writeFileSync(args[args.indexOf('--outputFile') + 1], JSON.stringify({
      success: true, numPassedTests: 1, numPassedTestSuites: 1, numFailedTests: 0, numFailedTestSuites: 0,
      testResults: [{ name: compiled, assertionResults: [{ status: 'passed' }] }]
    }));
  }
}
`);
    git(['add', '.']); git(['commit', '--quiet', '-m', 'Synthetic native decoder fixture']);
    const revision = git(['rev-parse', 'HEAD']);
    const output = execFileSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', resolve('scripts/validation/augloop-integration.ps1'),
        '-Mode', 'qualification', '-ArtifactDirectory', artifacts],
      { cwd: workspace, encoding: 'utf8', stdio: 'pipe', env: { ...process.env,
        PILOT_VALIDATION_STAGE: 'test', PILOT_VALIDATION_BASE_REVISION: revision, PILOT_VALIDATION_REVISION: revision } });
    const proofs = output.split(/\r?\n/).filter(line => line.startsWith('PILOT_VALIDATION_TEST_RESULT:'))
      .map(line => JSON.parse(line.slice('PILOT_VALIDATION_TEST_RESULT:'.length)));
    assert.deepEqual(proofs.map(proof => proof.runner), ['mocha', 'jest', 'jest', 'jest']);
    assert.deepEqual(proofs.map(proof => proof.owner), alOwners.map(owner => owner.path));
    assert.ok(proofs.every(proof => proof.suiteCount === 1 && proof.testCount === 1 && proof.selectedTests.length === 1));
    assert.throws(() => execFileSync('C:\\Program Files\\PowerShell\\7\\pwsh.exe',
      ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', resolve('scripts/validation/augloop-integration.ps1'),
        '-Mode', 'qualification', '-ArtifactDirectory', artifacts],
      { cwd: workspace, encoding: 'utf8', stdio: 'pipe', env: { ...process.env, AL_SYNTHETIC_PENDING: '1',
        PILOT_VALIDATION_STAGE: 'test', PILOT_VALIDATION_BASE_REVISION: revision,
        PILOT_VALIDATION_REVISION: revision } }), /Native Mocha reported pending assertions/);
  });
