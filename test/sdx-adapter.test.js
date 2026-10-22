import test from 'node:test';
import assert from 'node:assert/strict';
import {
  copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve } from 'node:path';
import { configAt, hash, json, repositorySourceRef } from '../src/common.js';
import {
  command, commitRepositoryChanges, createAdoDraft, createRepositoryChangeFile,
  draftSourceRef, preparedChangeFileWorkspace, prepareValidation, provision, repositoryCloneTimeout
} from '../src/workers.js';
import { Ledger } from '../src/ledger.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'sdx-adapter-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 3 }));
  const reference = join(root, 'reference');
  mkdirSync(reference);
  const git = async args => (await command('git', [
    '-c', 'core.hooksPath=.git/no-hooks', '-c', 'core.autocrlf=false',
    '-c', 'core.safecrlf=false', ...args
  ], reference)).stdout.trim();
  await git(['init', '--quiet']);
  const write = (path, content) => {
    const target = join(reference, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  write('.gitignore', '**/node_modules/\n');
  write('mono/package.json', json({ name: 'root', devDependencies: { '@fixture/tool': '*' } }));
  for (const [name, dependencies] of [
    ['target', { '@fixture/dependency': '*' }], ['dependency', {}], ['tool', {}], ['unrelated', {}]
  ]) {
    write(`mono/packages/${name}/package.json`, json({ name: `@fixture/${name}`, dependencies }));
    write(`mono/packages/${name}/src.js`, `export const name = '${name}';\n`);
  }
  write('.githooks/pre-commit', '#!/bin/sh\nprintf "hook-ran" > .git/sdx-hook-evidence\n');
  await git(['add', '--all']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Synthetic SDX source']);
  const config = {
    stateDirectory: join(root, 'state'),
    runtime: { timeoutMs: 120000 }
  };
  const repo = {
    referenceCheckout: reference, baseRef: await git(['rev-parse', 'HEAD']),
    remote: reference, validationGates: [{ timeoutMs: 300000 }],
    commitIdentity: { name: 'Fixture', email: 'fixture@example.invalid' },
    pr: { sourceBranchPrefix: 'user/fixture/sdx' },
    changeFile: {
      kind: 'beachball', executable: 'yarn.cmd', cwd: 'mono',
      packageName: '@fixture/target', changeType: 'none', outputPrefix: 'mono/change'
    }
  };
  return { root, reference, git, write, config, repo };
}

test('SDX example binds a real profile and explicit test-only skill policy while staying disabled', t => {
  const root = mkdtempSync(join(tmpdir(), 'sdx-config-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync('pilot.example.json', 'utf8'));
  const repo = JSON.parse(readFileSync('scaffold/1js-sdx.repository.example.json', 'utf8'));
  const profile = resolve('scripts/validation/1js-sdx-excel-integration.ps1');
  assert.equal(hash(readFileSync(profile)), repo.validationGates[0].profileSha256);
  const fixtureProfile = join(root, 'sdx-validation.ps1');
  copyFileSync(profile, fixtureProfile);
  repo.validationGates[0].profilePath = relative(root, fixtureProfile);
  config.repositories = [repo];
  const path = join(root, 'pilot.local.json');
  writeFileSync(path, json(config));
  const loaded = configAt(path);
  assert.deepEqual(loaded.activation, { collect: false, review: false, dispatch: false });
  assert.equal(loaded.repositories[0].skillBindings[0].requiresBehaviorCard, true);
  assert.deepEqual(loaded.repositories[0].skillBindings[0].allowedWritePrefixes,
    loaded.repositories[0].allowedWritePrefixes);
  assert.equal(loaded.repositories[0].skillBindings[0].sideEffects.push, false);
});

test('SDX authentication rejects missing sparse bootstrap before requesting sign-in', async t => {
  if (process.platform !== 'win32') return t.skip('Windows native validation profile');
  const { reference, repo, write } = await fixture(t);
  const profile = resolve('scripts/validation/1js-sdx-excel-integration.ps1');
  for (const stage of ['authentication-check', 'authentication']) {
    await assert.rejects(command('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', profile
    ], reference, 30000, {
      ...process.env, PILOT_VALIDATION_STAGE: stage, PILOT_VALIDATION_REVISION: repo.baseRef
    }), error => {
      assert.match(error.stderr, /PILOT_AUTH_BOOTSTRAP_MISSING/);
      assert.match(error.stderr, /midgard\/package.json/);
      assert.doesNotMatch(error.stdout, /PILOT_VALIDATION_AUTH_PREFLIGHT/);
      return true;
    });
  }
  for (const path of ['midgard/package.json', 'packages/node-azure-auth/package.json',
    'packages/node-azure-auth/bin/index.cjs', 'packages/node-azure-auth/dist/main.cjs', '.npmrc'])
    write(path, path.endsWith('.json') ? '{}\n' : '');
  await assert.rejects(command('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', profile
  ], reference, 30000, {
    ...process.env, PILOT_VALIDATION_STAGE: 'authentication-check',
    PILOT_VALIDATION_REVISION: repo.baseRef
  }), error => {
    assert.match(error.stderr, /PILOT_AUTH_BOOTSTRAP_MISSING/);
    assert.match(error.stderr, /fast-script-runner/);
    assert.doesNotMatch(error.stdout, /PILOT_VALIDATION_AUTH_PREFLIGHT/);
    return true;
  });
});

test('SDX source-runtime gate requires actual passing results for every selected path', async t => {
  if (process.platform !== 'win32') return t.skip('Windows native validation profile');
  const { reference, repo, write, git } = await fixture(t);
  const packageRoot = 'midgard/packages/officeaicopilot-agent-excel';
  const testPath = `${packageRoot}/tests/integration/scenarios/native.integration.test.ts`;
  write(testPath, '// Synthetic native gate contract fixture\n');
  write(`${packageRoot}/node_modules/jest/package.json`, '{"name":"jest","version":"1.0.0"}\n');
  write(`${packageRoot}/node_modules/jest/bin/jest.js`, `
const assert = require('node:assert/strict'), fs = require('node:fs');
const args = process.argv.slice(2), value = flag => args[args.indexOf(flag) + 1];
assert.ok(args.includes('--passWithNoTests=false'));
const configuration = fs.readFileSync(value('--config'), 'utf8');
assert.ok(configuration.includes('@1js/jest-config/source-resolver'));
assert.ok(configuration.includes('@1js/jest-config/swc-transform'));
assert.ok(configuration.includes('...original'));
const mode = process.env.PILOT_FIXTURE_RESULT;
const count = mode === 'empty' ? 0 : 1;
fs.writeFileSync(value('--outputFile'), JSON.stringify({
  success: true, numTotalTests: count, numPassedTests: count,
  testResults: [{ name: value('--runTestsByPath') + (mode === 'wrong-file' ? '.other' : ''),
    assertionResults: mode === 'empty-suite' ? [] : [{ status: 'passed' }] }]
}));
`);
  await git(['add', testPath]);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Add native test selection']);
  const revision = await git(['rev-parse', 'HEAD']);
  const profile = resolve('scripts/validation/1js-sdx-excel-integration.ps1');
  for (const mode of ['passed', 'empty', 'wrong-file', 'empty-suite']) {
    const execute = () => command('powershell.exe', [
      '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', profile
    ], reference, 30000, {
      ...process.env, PILOT_VALIDATION_STAGE: 'test', PILOT_FIXTURE_RESULT: mode,
      PILOT_VALIDATION_BASE_REVISION: repo.baseRef, PILOT_VALIDATION_REVISION: revision
    });
    if (mode === 'passed') {
      const result = await execute();
      assert.match(result.stdout, /PILOT_VALIDATION_TEST_RESULT:.*"testCount":1/);
    } else await assert.rejects(execute(), error => {
      assert.match(error.stderr, /native Jest results do not prove all selected tests passed/);
      return true;
    });
  }
});

test('one source-ref resolver supports upstream and legacy SDX configuration without disagreement', () => {
  const branch = 'user/fixture/sdx';
  const ref = `refs/heads/${branch}/assignment-1`;
  for (const pr of [
    { sourceBranchPrefix: branch },
    { sourceRefPrefix: `refs/heads/${branch}/` },
    { sourceBranchPrefix: branch, sourceRefPrefix: `refs/heads/${branch}/` }
  ]) {
    assert.equal(repositorySourceRef({ pr }, 'assignment-1'), ref);
    assert.equal(draftSourceRef({ pr }, 'assignment-1'), ref);
  }
  assert.throws(() => repositorySourceRef({ pr: {
    sourceBranchPrefix: branch, sourceRefPrefix: 'refs/heads/other/'
  } }, 'id'), /disagree/);
  for (const prefix of ['refs/tags/a/', 'refs/heads/', 'refs/heads/a//',
    'refs/heads/../', 'refs/heads/.hidden/', 'refs/heads/a.lock/', 'refs/heads/a./'])
    assert.throws(() => repositorySourceRef({ pr: { sourceRefPrefix: prefix } }, 'id'));
  assert.throws(() => repositorySourceRef({}, '../id'));
});

test('SDX provisioning retains package manifests, expands dependencies and stages native changefiles', async t => {
  const { repo, config, git } = await fixture(t);
  repo.sparseCheckout = {
    mode: 'workspace-closure', workspacePackages: 'mono/packages',
    targetWorkspaces: ['@fixture/target'],
    bootstrapPaths: ['mono/package.json', '.githooks'],
    additionalWorkspacePaths: []
  };
  const job = { id: 'assignment-1', session_id: 'session-1' };
  const { workspace } = await provision(config, job, repo);
  for (const name of ['target', 'dependency', 'tool'])
    assert.equal(existsSync(join(workspace, 'mono', 'packages', name, 'src.js')), true);
  assert.equal(existsSync(join(workspace, 'mono/packages/unrelated/package.json')), true);
  assert.equal(existsSync(join(workspace, 'mono/packages/unrelated/src.js')), false);
  assert.equal((await command('git', ['symbolic-ref', 'HEAD'], workspace)).stdout.trim(),
    repositorySourceRef(repo, job.id));
  mkdirSync(join(workspace, 'mono/change'), { recursive: true });
  writeFileSync(join(workspace, 'mono/change/native.json'), '{}\n');
  await command('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
    'add', '--all'], workspace);
  assert.match((await command('git', ['diff', '--cached', '--name-only'], workspace)).stdout,
    /mono\/change\/native.json/);
  assert.equal(await git(['status', '--porcelain']), '');
});

test('SDX partial-clone provisioning preserves unpublished blobs without object-store sharing', async t => {
  const { root, repo, config, reference, git } = await fixture(t);
  await git(['config', 'uploadpack.allowFilter', 'true']);
  const partial = join(root, 'partial');
  await command('git', ['clone', '--depth=1', '--no-local', '--filter=blob:none', '--no-checkout',
    '--', reference, partial], root);
  await command('git', ['config', 'uploadpack.packObjectsHook', 'false'], partial);
  const missing = (await command('git', ['rev-list', '--objects', '--missing=print', 'HEAD'], partial)).stdout;
  assert.match(missing, /^\?[a-f0-9]+$/m);
  repo.referenceCheckout = partial;
  const first = await provision(config, { id: 'first', session_id: 'first' }, repo);
  assert.equal((await command('git', ['rev-parse', '--is-shallow-repository'], first.workspace)).stdout.trim(), 'true');
  const localOnlyPath = 'mono/packages/target/local-only.js';
  writeFileSync(join(first.workspace, localOnlyPath), 'export const unpublished = true;\n');
  await command('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
    'add', '--', localOnlyPath], first.workspace);
  await command('git', ['-c', 'core.hooksPath=.git/no-hooks', '-c', 'user.name=Fixture',
    '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Unpublished fixture'],
  first.workspace);
  const localRevision = (await command('git', ['rev-parse', 'HEAD'], first.workspace)).stdout.trim();
  const second = await provision(config, { id: 'second', session_id: 'second' },
    { ...repo, referenceCheckout: first.workspace, baseRef: localRevision });
  assert.equal(readFileSync(join(second.workspace, localOnlyPath), 'utf8').replaceAll('\r\n', '\n'),
    'export const unpublished = true;\n');
  assert.equal(existsSync(join(second.workspace, '.git/objects/info/alternates')), false);
  assert.equal((await command('git', ['remote', 'get-url', 'origin'], second.workspace)).stdout.trim(),
    reference);
  assert.equal((await command('git', ['status', '--porcelain'], second.workspace)).stdout.trim(), '');
  assert.equal(await git(['status', '--porcelain']), '');
});

test('SDX changefile runs through native Windows containment and transfers only its output', async t => {
  if (process.platform !== 'win32') return t.skip('Windows native .cmd invocation');
  const { repo, config, reference, write, git } = await fixture(t);
  const { workspace } = await provision(config, { id: 'assignment-1', session_id: 'session-1' }, repo);
  writeFileSync(join(workspace, 'mono/packages/target/src.js'), 'authored content\n');
  write('mono/node_modules/.bin/yarn.cmd', `@"${process.execPath}" "%~dp0generate.cjs" %*\r\n`);
  write('mono/node_modules/.bin/generate.cjs', [
    "const fs = require('node:fs');",
    "const args = process.argv.slice(2);",
    "const value = key => args[args.indexOf(key) + 1];",
    "if (!args.includes('--no-fetch') || !value('--branch').startsWith('refs/')) process.exit(2);",
    "fs.mkdirSync('change', { recursive: true });",
    "fs.writeFileSync('change/native.json', JSON.stringify({",
    "type: value('--type'), dependentChangeType: value('--dependent-change-type'),",
    "packageName: value('-p'), comment: value('--message'), email: 'fixture@example.invalid' }));"
  ].join('\n'));
  const created = await createRepositoryChangeFile(
    workspace, repo, 'Add native integration coverage', command, reference);
  assert.equal(created, 'mono/change/native.json');
  assert.equal(JSON.parse(readFileSync(join(workspace, created))).comment,
    'Add native integration coverage');
  assert.equal(existsSync(join(reference, created)), false);
  assert.equal(readFileSync(join(workspace, 'mono/packages/target/src.js'), 'utf8'),
    'authored content\n');
  assert.equal(await git(['status', '--porcelain']), '');
});

for (const resume of [false, true])
test(`SDX dependency and compile clones preserve sparse closure and generated tools${resume ? ' after interrupted installation' : ''}`, async t => {
  const { repo, config, git, write } = await fixture(t);
  write('.gitignore', '**/node_modules/\nmono/generated/\nmono/compiled/\n');
  write('mono/packages/unrelated/.fluent-v8-migrated', '');
  await git(['add', '--all']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Declare synthetic preparation outputs']);
  repo.baseRef = await git(['rev-parse', 'HEAD']);
  repo.sparseCheckout = {
    mode: 'workspace-closure', workspacePackages: 'mono/packages',
    targetWorkspaces: ['@fixture/target'],
    bootstrapPaths: ['mono/package.json', '.githooks'],
    additionalWorkspacePaths: []
  };
  const job = { id: 'assignment-preparation', session_id: 'session-preparation' };
  const isolated = await provision(config, job, repo);
  const profilePath = join(config.stateDirectory, 'profile.mjs');
  const plan = {
    version: 2, stages: ['dependencies', 'compile', 'policy', 'test'],
    testOnlyPrefixes: ['mono/packages/target/test/'],
    lockfilePaths: ['mono/package.json'], buildConfigPaths: ['mono/package.json'],
    dependencySnapshotPaths: ['mono/node_modules'],
    preparedOutputPaths: ['mono/compiled']
  };
  writeFileSync(profilePath, `// PILOT_VALIDATION_PLAN: ${json(plan)}\n`);
  repo.validationGates = [{ id: 'sdx-fixture', approved: true, isolationVerified: true,
    executable: process.execPath, args: ['{profile}'], profilePath,
    profileSha256: hash(readFileSync(profilePath)), timeoutMs: 30000 }];
  const stages = [];
  let interruptedWorkspace = null;
  const execute = async (_executable, _args, cwd, _timeout, env) => {
    const stage = env.PILOT_VALIDATION_STAGE;
    if (stage === 'fingerprint') return {
      stdout: `PILOT_VALIDATION_FINGERPRINT:${json({
        node: 'fixture', corepack: 'fixture', yarn: 'fixture',
        platform: process.platform, architecture: process.arch
      })}\n`, stderr: ''
    };
    stages.push(stage);
    for (const name of ['target', 'dependency', 'tool'])
      assert.equal(existsSync(join(cwd, `mono/packages/${name}/src.js`)), true);
    assert.equal(existsSync(join(cwd, 'mono/packages/unrelated/package.json')), true);
    assert.equal(existsSync(join(cwd, 'mono/packages/unrelated/src.js')), false);
    assert.equal(existsSync(join(cwd, 'mono/packages/unrelated/.fluent-v8-migrated')), true);
    if (stage === 'dependencies') {
      if (interruptedWorkspace)
        assert.equal(readFileSync(join(cwd, 'mono/node_modules/fixture.js'), 'utf8'),
          'synthetic generated tool\n');
      for (const path of ['mono/node_modules/fixture.js', 'mono/generated/compiler.js']) {
        mkdirSync(dirname(join(cwd, path)), { recursive: true });
        writeFileSync(join(cwd, path), 'synthetic generated tool\n');
      }
      if (resume && !interruptedWorkspace) {
        interruptedWorkspace = cwd;
        const error = new Error('synthetic native timeout');
        error.killed = true;
        throw error;
      }
    } else if (stage === 'compile') {
      assert.equal(readFileSync(join(cwd, 'mono/generated/compiler.js'), 'utf8'),
        'synthetic generated tool\n');
      mkdirSync(join(cwd, 'mono/compiled'));
      writeFileSync(join(cwd, 'mono/compiled/output.js'), 'synthetic compilation\n');
    } else assert.fail(`Unexpected preparation stage ${stage}`);
    return { stdout: `${stage} passed\n`, stderr: '' };
  };
  const currentJob = { ...job, workspace: isolated.workspace };
  if (resume) {
    const failed = await prepareValidation(config, currentJob, repo, isolated.baseRevision, execute);
    assert.match(failed['sdx-fixture'].error.message, /Native dependencies exceeded.*30000/);
    assert.equal(existsSync(join(dirname(interruptedWorkspace), 'r.json')), false);
    const rejected = await prepareValidation(config, currentJob, repo, isolated.baseRevision, execute,
      { resumeDependencyWorkspaces: { 'sdx-fixture': isolated.workspace } });
    assert.equal(rejected['sdx-fixture'].error.code, 'blocked-reconciliation');
    const source = join(interruptedWorkspace, 'mono/packages/target/src.js');
    const original = readFileSync(source);
    writeFileSync(source, 'unexpected source mutation\n');
    const dirty = await prepareValidation(config, currentJob, repo, isolated.baseRevision, execute,
      { resumeDependencyWorkspaces: { 'sdx-fixture': interruptedWorkspace } });
    assert.equal(dirty['sdx-fixture'].error.code, 'blocked-reconciliation');
    writeFileSync(source, original);
  }
  const prepared = await prepareValidation(config, currentJob,
    repo, isolated.baseRevision, execute, {
      resumeDependencyWorkspaces: resume ? { 'sdx-fixture': interruptedWorkspace } : {}
    });
  assert.equal(prepared['sdx-fixture'].error, undefined, json(prepared));
  assert.deepEqual(stages, resume ? ['dependencies', 'dependencies', 'compile'] : ['dependencies', 'compile']);
  const receipt = prepared['sdx-fixture'];
  assert.equal(existsSync(join(receipt.workspace, 'mono/generated/compiler.js')), true);
  assert.equal(existsSync(join(receipt.workspace, 'mono/packages/unrelated/src.js')), false);
  const dependency = JSON.parse(readFileSync(receipt.dependencyReceipt.path, 'utf8'));
  const materialization = receipt.timings.find(stage => stage.id === 'dependency-materialization');
  assert.equal(materialization.details.roots, dependency.outputs.paths.length);
  for (const value of [materialization.details.copyDurationMs,
    materialization.details.linkRebaseDurationMs,
    materialization.details.fingerprint.durationMs,
    materialization.details.fingerprint.processCpuMs])
    assert.ok(Number.isFinite(value) && value >= 0, JSON.stringify(materialization));
  assert.ok(materialization.durationMs >= materialization.details.fingerprint.durationMs - 1);
  assert.equal(dependency.inputs.dependencySnapshotVersion, 2);
  assert.ok(dependency.outputs.paths.includes('mono/node_modules'));
  assert.ok(dependency.outputs.paths.includes('mono/generated'));
});

test('SDX commit actually runs native hooks and carries the configured session trailer', async t => {
  const { repo, config, reference, write, git } = await fixture(t);
  config.runtime.copilotSessionId = '00000000-0000-4000-8000-000000000001';
  write('mono/packages/target/src.js', 'updated content\n');
  await commitRepositoryChanges(config, reference, repo, 'Add integration coverage');
  assert.equal(readFileSync(join(reference, '.git/sdx-hook-evidence'), 'utf8'), 'hook-ran');
  assert.match(await git(['log', '-1', '--format=%B']),
    /Copilot-Session: 00000000-0000-4000-8000-000000000001/);
  assert.equal(await git(['status', '--porcelain']), '');
});

test('SDX changefile preparation preserves the real blocker and commit budget', () => {
  assert.throws(() => preparedChangeFileWorkspace({ gate: {
    error: { code: 'blocked-validation', message: 'Native installation timed out' }
  } }), /Native installation timed out/);
  assert.throws(() => preparedChangeFileWorkspace({}), /Prepared changefile tooling is unavailable/);
  assert.equal(repositoryCloneTimeout({ runtime: { timeoutMs: 120000 } },
    { validationGates: [{ timeoutMs: 7200000 }] }), 7200000);
});

test('SDX Draft discovery and creation retain the exact configured source and head', async t => {
  const { root, config, repo } = await fixture(t);
  const ledger = new Ledger(join(root, 'ledger'));
  try {
    repo.remote = 'https://dev.azure.com/fixture/project/_git/fixture';
    Object.assign(repo.pr, {
      provider: 'ado', organization: 'fixture', project: 'project',
      repositoryId: 'fixture', targetRef: 'refs/heads/main'
    });
    const job = { id: 'assignment-1' };
    const source = draftSourceRef(repo, job.id);
    const revision = 'a'.repeat(40);
    const draft = await createAdoDraft(config, ledger, job, repo, revision,
      { title: 'Synthetic SDX validation', description: 'Offline fixture only' },
      async (method, suffix, body) => {
        if (method === 'GET') {
          assert.ok(suffix.includes(encodeURIComponent(source)));
          return { value: [] };
        }
        assert.equal(body.sourceRefName, source);
        assert.equal(body.isDraft, true);
        return { pullRequestId: 1, status: 'active', isDraft: true,
          sourceRefName: source, targetRefName: repo.pr.targetRef,
          lastMergeSourceCommit: { commitId: revision } };
      });
    assert.equal(draft.headRevision, revision);
  } finally {
    ledger.close();
  }
});
