import test from 'node:test';
import assert from 'node:assert/strict';
import {
  mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync,
  symlinkSync, utimesSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { command, seedDeclarativeDependencies } from '../src/workers.js';

test('dependency scans persist exact byte work and reject ignored-byte drift with clean identical SHA', async t => {
  const root = mkdtempSync(join(tmpdir(), 'dependency-seed-progress-'));
  t.after(() => rmSync(root, { recursive: true, force: true, maxRetries: 5 }));
  const source = join(root, 'source'), workspace = join(root, 'workspace');
  mkdirSync(source);
  writeFileSync(join(source, '.gitignore'), 'ooui/.store/\nooui/node_modules/\nooui/lib/\n');
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
