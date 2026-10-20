import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { command } from '../src/workers.js';
import { prepareValidationWorkspace, removeValidationWorktree,
  preparationStage, preparationFailure } from '../src/validation-workspace.js';
import { nativeCommand } from '../src/native-command.js';

async function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'validation-preflight-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const source = join(root, 'source'), workspace = join(root, 'isolated');
  mkdirSync(source);
  const git = async args => (await command('git', args, source)).stdout.trim();
  await git(['init', '-q']);
  await git(['config', 'user.name', 'Synthetic']);
  await git(['config', 'user.email', 'synthetic@example.test']);
  for (const directory of ['required', 'unrelated']) {
    mkdirSync(join(source, directory));
    writeFileSync(join(source, directory, 'input.txt'), directory);
  }
  await git(['add', '.']);
  await git(['commit', '-qm', 'synthetic baseline']);
  return { root, source, workspace, git, revision: await git(['rev-parse', 'HEAD']) };
}

test('detached sparse preparation preserves source and uses shared objects with a separate index', async t => {
  const ctx = await fixture(t), timings = [];
  const result = await prepareValidationWorkspace({
    ...ctx, timeoutMs: 30000, sparseCheckoutPaths: ['required'], timings,
    seed: async (source, target) => {
      assert.equal(source, ctx.source);
      assert.equal(target, ctx.workspace);
      assert(existsSync(join(target, 'required', 'input.txt')));
      assert(!existsSync(join(target, 'unrelated', 'input.txt')));
      return { sourceRevision: ctx.revision, sha256: 'synthetic' };
    }
  });
  assert.equal(result.strategy, 'detached-worktree');
  assert.equal(await ctx.git(['status', '--porcelain']), '');
  assert.match(await ctx.git(['symbolic-ref', '--short', 'HEAD']), /^(master|main)$/);
  const targetGit = async args => (await command('git', args, ctx.workspace)).stdout.trim();
  assert.equal(await targetGit(['rev-parse', 'HEAD']), ctx.revision);
  await assert.rejects(targetGit(['symbolic-ref', 'HEAD']));
  assert.equal(await targetGit(['status', '--porcelain']), '');
  assert.notEqual(await targetGit(['rev-parse', '--git-path', 'index']),
    await ctx.git(['rev-parse', '--git-path', 'index']));
  assert(timings.every(stage => stage.status === 'passed' && stage.durationMs >= 0));
  assert(existsSync(join(ctx.source, 'unrelated', 'input.txt')));
  await removeValidationWorktree(ctx.source, ctx.workspace, 30000);
  assert(!existsSync(ctx.workspace));
  assert.equal((await ctx.git(['worktree', 'list', '--porcelain'])).split('worktree ').length, 2);
});

test('preparation rejects dirty, reused and source-nested workspaces', async t => {
  const ctx = await fixture(t);
  writeFileSync(join(ctx.source, 'required', 'input.txt'), 'dirty');
  await assert.rejects(prepareValidationWorkspace({ ...ctx, timeoutMs: 30000 }), /clean source/);
  assert(!existsSync(ctx.workspace));
  await assert.rejects(prepareValidationWorkspace({
    ...ctx, workspace: join(ctx.source, 'nested'), timeoutMs: 30000
  }), /outside/);
  mkdirSync(ctx.workspace);
  await assert.rejects(prepareValidationWorkspace({ ...ctx, timeoutMs: 30000 }), /fresh/);
});

test('persistent phase telemetry retains timeout as primary cause without credential output', async () => {
  const timings = [], snapshots = [];
  const error = Object.assign(new Error('Authorization: secret'), {
    killed: true, code: null, stderr: 'secret', ownedProcessesExited: true
  });
  await assert.rejects(preparationStage(timings, 'checkout', async () => { throw error; },
    () => snapshots.push(JSON.stringify(timings))), /secret/);
  assert.equal(error.preparationStage, 'checkout');
  assert.equal(timings[0].failure.reason, 'command-timeout');
  assert.equal(timings[0].failure.ownedProcessesExited, true);
  assert(!JSON.stringify(timings).includes('secret'));
  assert.equal(snapshots.length, 2);
  assert.equal(preparationFailure({ containmentFailure: true }).reason, 'process-tree-exit-unconfirmed');
});

test('nested preparation stages preserve the deepest failure location', async () => {
  const timings = [], error = Object.assign(new Error('private native output'),
    { nativeExitCode: 8, ownedProcessesExited: true });
  await assert.rejects(preparationStage(timings, 'dependencies', () =>
    preparationStage(timings, 'dependency-copy', async () => { throw error; })));
  assert.equal(error.preparationStage, 'dependency-copy');
  assert.equal(timings[1].failure.nativeExitCode, 8);
  assert(timings.every(stage => stage.status === 'blocked'));
  assert(!JSON.stringify(timings).includes('private native output'));
});

test('Windows Git launcher timeout drains its owned command and descendant before returning',
  { skip: process.platform !== 'win32' }, async t => {
    const ctx = await fixture(t), script = join(ctx.root, 'git-child.cjs');
    const pids = join(ctx.root, 'pids.json');
    writeFileSync(script, `const{spawn}=require('node:child_process');
      const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
      require('node:fs').writeFileSync(${JSON.stringify(pids)},JSON.stringify([process.pid,child.pid]));
      console.log('owned-git-child-started');setInterval(()=>{},1000);`);
    let failure;
    try {
      await nativeCommand('git', ['-c',
        `alias.pilot-timeout=!"${process.execPath.replaceAll('\\', '/')}" "${script.replaceAll('\\', '/')}"`,
        'pilot-timeout'], ctx.source, 8000, process.env);
    } catch (error) { failure = error; }
    assert(failure?.killed);
    assert.equal(failure.ownedProcessesExited, true);
    assert.match(failure.stdout, /owned-git-child-started/);
    for (const pid of JSON.parse(readFileSync(pids)))
      assert.throws(() => process.kill(pid, 0), error => error.code === 'ESRCH');
  });
