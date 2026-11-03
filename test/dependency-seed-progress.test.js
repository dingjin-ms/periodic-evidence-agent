import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync,
  symlinkSync, unlinkSync, utimesSync, writeFileSync
} from 'node:fs';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, seedDeclarativeDependencies } from '../src/workers.js';

async function fixture(t, { extraDependencyRoots = 0 } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'dependency-seed-progress-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const source = join(root, 'source'), workspace = join(root, 'workspace');
  mkdirSync(source);
  writeFileSync(join(source, '.gitignore'),
    'ooui/.store/\nooui/node_modules/\nooui/lib/\nooui/dist/\n' +
    (extraDependencyRoots ? 'node_modules/\n' : ''));
  const git = async (cwd, args) => (await command('git', [
    '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=.git/no-hooks', ...args
  ], cwd)).stdout.trim();
  await git(source, ['init', '--quiet']);
  await git(source, ['add', '.']);
  await git(source, ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Synthetic source']);
  const revision = await git(source, ['rev-parse', 'HEAD']);
  await command('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
    'clone', '--quiet', '--no-hardlinks', '--', source, workspace], root);
  for (const path of ['ooui/.store/pkg', 'ooui/node_modules', 'ooui/lib'])
    mkdirSync(join(source, path), { recursive: true });
  writeFileSync(join(source, 'ooui/.store/pkg/file.js'), 'same');
  writeFileSync(join(source, 'ooui/lib/output.js'), 'built');
  symlinkSync(join(source, 'ooui/.store/pkg'), join(source, 'ooui/node_modules/alias'),
    process.platform === 'win32' ? 'junction' : 'dir');
  for (let index = 0; index < extraDependencyRoots; index++) {
    const path = join(source, 'ooui', 'packages', `pkg-${index}`, 'node_modules');
    mkdirSync(path, { recursive: true });
    writeFileSync(join(path, 'dependency.js'), 'dependency');
  }
  return { root, source, workspace, revision, git };
}

test('only the initial source scan expands its worker budget while all byte witnesses remain complete', async t => {
  const { root, source, workspace, revision } =
    await fixture(t, { extraDependencyRoots: 16 });
  const seed = await seedDeclarativeDependencies(source, workspace, revision, 30000);
  assert.deepEqual(await seedDeclarativeDependencies(source, workspace, revision, 30000,
    { expectedSeed: seed }), seed);
  const journals = readdirSync(root).filter(name => name.includes('.dependency-verification-'))
    .map(name => readFileSync(join(root, name), 'utf8').trim().split('\n').map(JSON.parse));
  assert.equal(journals.length, 2);
  for (const records of journals) {
    const scans = records.at(-1).scans;
    const initial = records[0].verificationMode === 'initial-byte-seed';
    assert.deepEqual(Object.keys(scans).sort(), initial
      ? ['copiedWorkspace', 'initialSource', 'retainedSource']
      : ['copiedWorkspace', 'retainedSource']);
    for (const [name, scan] of Object.entries(scans)) {
      assert.equal(scan.state, 'passed');
      assert.equal(scan.hashedFileCount, 18);
      assert.equal(scan.hashedBytes, 169);
      assert.equal(scan.completedTasks, scan.taskCount);
      assert.equal(scan.workerCount, availableParallelism() > 1
        ? Math.min(name === 'initialSource' ? 16 : 8, availableParallelism(), scan.taskCount)
        : 0);
      if (availableParallelism() > 1) assert.ok(scan.taskCount >= 16);
    }
  }
});

test('dependency scans persist exact byte work and reject ignored-byte drift with clean identical SHA', async t => {
  const { root, source, workspace, revision, git } = await fixture(t);
  const seed = await seedDeclarativeDependencies(source, workspace, revision, 30000);
  const journals = () => readdirSync(root).filter(name => name.includes('.dependency-verification-'))
    .map(name => readFileSync(join(root, name), 'utf8').trim().split('\n').map(JSON.parse));
  const initial = journals()[0];
  assert.equal(initial[0].format, 'dependency-verification-progress-v1');
  assert.equal(initial[0].percentage, null);
  assert.equal(initial[0].eta, null);
  for (const scan of Object.values(initial.at(-1).scans)) {
    assert.equal(scan.state, 'passed');
    assert.ok(scan.wallMs >= 0);
    assert.ok(scan.controllerProcessCpuMs >= 0);
    assert.equal(scan.hashedFileCount, 2);
    assert.equal(scan.hashedBytes, 9);
    assert.equal(scan.completedTasks, scan.taskCount);
  }
  assert.deepEqual(await seedDeclarativeDependencies(source, workspace, revision, 30000,
    { expectedSeed: seed }), seed);
  const reused = journals().find(records =>
    records[0].verificationMode === 'pinned-byte-digest-reverification').at(-1);
  assert.deepEqual(Object.keys(reused.scans).sort(), ['copiedWorkspace', 'retainedSource']);
  assert.equal(reused.timings.some(stage => stage.id === 'dependency-copy' ||
    stage.id === 'dependency-source-fingerprint'), false);
  for (const scan of Object.values(reused.scans)) {
    assert.equal(scan.state, 'passed');
    assert.equal(scan.hashedFileCount, 2);
    assert.equal(scan.hashedBytes, 9);
  }
  const tamper = path => {
    const previous = statSync(path);
    writeFileSync(path, 'evil');
    utimesSync(path, previous.atime, previous.mtime);
  };
  const targetFile = join(workspace, 'ooui/.store/pkg/file.js');
  tamper(targetFile);
  await assert.rejects(seedDeclarativeDependencies(source, workspace, revision, 30000,
    { expectedSeed: seed }), /copied output bytes/);
  assert.equal(readFileSync(targetFile, 'utf8'), 'evil', 'Rejected bytes are never overwritten');
  assert.ok(journals().some(records =>
    records.at(-1).timings.at(-1).status === 'blocked'));
  writeFileSync(targetFile, 'same');
  tamper(join(source, 'ooui/.store/pkg/file.js'));
  assert.equal(await git(source, ['status', '--porcelain']), '');
  assert.equal(await git(source, ['rev-parse', 'HEAD']), revision);
  await assert.rejects(seedDeclarativeDependencies(source, workspace, revision, 30000,
    { expectedSeed: seed }), /current exact source bytes/);
  writeFileSync(join(source, 'ooui/.store/pkg/file.js'), 'same');
  writeFileSync(join(source, 'ooui/lib/new.js'), 'new ignored build output');
  await assert.rejects(seedDeclarativeDependencies(source, workspace, revision, 30000,
    { expectedSeed: seed }), /current exact source bytes/);
});

test('prepared dependency proof rejects invalid receipts and inventory or link drift without copying', async t => {
  const { root, source, workspace, revision } = await fixture(t);
  const seed = await seedDeclarativeDependencies(source, workspace, revision, 30000);
  const verify = options => seedDeclarativeDependencies(source, workspace, revision, 30000,
    { expectedSeed: seed, ...options });
  for (const changed of [
    { format: 'untrusted' }, { sourceRevision: '0'.repeat(40) },
    { sha256: null }, { paths: [] }
  ]) {
    const timings = [];
    await assert.rejects(verify({ expectedSeed: { ...seed, ...changed }, timings }),
      /current exact source bytes/);
    assert.equal(timings.some(stage => stage.id === 'dependency-byte-verification'), false);
  }
  await assert.rejects(verify({ expectedSeed: { ...seed, sha256: '0'.repeat(64) } }),
    /current exact source bytes/);
  for (const base of [source, workspace]) {
    const tracked = join(base, '.gitignore');
    const original = readFileSync(tracked);
    writeFileSync(tracked, `${original}# unapproved tracked change\n`);
    await assert.rejects(verify(), /current exact source bytes|tracked files/);
    writeFileSync(tracked, original);
  }
  for (const base of [source, workspace]) {
    for (const path of ['ooui/.store/extra', 'ooui/dist']) {
      const extra = join(base, path);
      mkdirSync(extra, { recursive: true });
      writeFileSync(join(extra, 'unexpected.js'), 'unapproved ignored output');
      await assert.rejects(verify(), /current exact source bytes|bytes or inventory/);
      rmSync(extra, { recursive: true });
    }
    const late = join(base, 'ooui/.store/late');
    let changed = false;
    const timings = [];
    await assert.rejects(verify({ timings, persist: () => {
      if (!changed && timings.some(stage =>
        stage.id === 'dependency-byte-verification' && stage.status === 'running')) {
        changed = true;
        mkdirSync(late);
        writeFileSync(join(late, 'unexpected.js'), 'added after the scan plan');
      }
    } }), /bytes or inventory/);
    assert.equal(changed, true);
    rmSync(late, { recursive: true });
  }
  const outside = join(root, 'outside');
  mkdirSync(outside);
  writeFileSync(join(outside, 'sentinel'), 'untouched');
  const alias = join(workspace, 'ooui/node_modules/alias');
  unlinkSync(alias);
  symlinkSync(outside, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verify(), /copied output bytes/);
  assert.equal(readFileSync(join(outside, 'sentinel'), 'utf8'), 'untouched');
  unlinkSync(alias);
  symlinkSync(join(workspace, 'ooui/.store/pkg'), alias,
    process.platform === 'win32' ? 'junction' : 'dir');
  const store = join(workspace, 'ooui/.store');
  const saved = join(root, 'saved-store');
  renameSync(store, saved);
  symlinkSync(join(source, 'ooui/.store'), store,
    process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(verify(), /inventory link escapes/);
  unlinkSync(store);
  renameSync(saved, store);
  assert.deepEqual(await verify(), seed);
  rmSync(join(source, 'ooui'), { recursive: true });
  await assert.rejects(verify(), /current exact source bytes/);
});
