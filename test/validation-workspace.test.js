import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, existsSync, rmSync,
  appendFileSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createRequire } from 'node:module';
import { runInNewContext } from 'node:vm';
import { command } from '../src/workers.js';
import { prepareValidationWorkspace, removeValidationWorktree,
  preparationStage, preparationFailure, readDependencyCopyProgress } from '../src/validation-workspace.js';
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

test('validation cleanup unlinks junction graphs without visiting external targets', {
  skip: process.platform !== 'win32'
}, async t => {
  const ctx = await fixture(t);
  await prepareValidationWorkspace({ ...ctx, timeoutMs: 30000 });
  const external = join(ctx.root, 'external'), canary = join(external, 'canary.txt');
  const a = join(ctx.workspace, 'a'), b = join(ctx.workspace, 'b');
  for (const path of [external, a, b]) mkdirSync(path);
  writeFileSync(canary, 'must survive cleanup');
  symlinkSync(b, join(a, 'to-b'), 'junction');
  symlinkSync(a, join(b, 'to-a'), 'junction');
  symlinkSync(join(ctx.workspace, 'absent'), join(a, 'dangling'), 'junction');
  symlinkSync(external, join(b, 'external'), 'junction');
  const result = await removeValidationWorktree(ctx.source, ctx.workspace, 30000);
  assert.equal(result.unlinkedLinks, 4);
  assert.equal(result.rootRemoved, true);
  assert.deepEqual(result.timings.map(stage => stage.id), [
    'cleanup-ownership-check', 'cleanup-link-scan', 'cleanup-git-remove', 'cleanup-root-check'
  ]);
  assert(result.timings.every(stage => stage.status === 'passed' && stage.durationMs >= 0));
  assert.equal(existsSync(ctx.workspace), false);
  assert.equal(readFileSync(canary, 'utf8'), 'must survive cleanup');
  assert.equal(await ctx.git(['status', '--porcelain']), '');
});

test('validation cleanup rejects source and unregistered paths before changing links', async t => {
  const ctx = await fixture(t);
  await assert.rejects(removeValidationWorktree(ctx.source, ctx.source, 30000), error => {
    assert.match(error.message, /secondary worktree/);
    assert.equal(error.cleanupTimings.length, 1);
    assert.equal(error.cleanupTimings[0].id, 'cleanup-ownership-check');
    assert.equal(error.cleanupTimings[0].status, 'blocked');
    return true;
  });
  assert.equal(readFileSync(join(ctx.source, 'required', 'input.txt'), 'utf8'), 'required');
  mkdirSync(ctx.workspace);
  writeFileSync(join(ctx.workspace, 'canary.txt'), 'unregistered');
  await assert.rejects(removeValidationWorktree(ctx.source, ctx.workspace, 30000), /unregistered/);
  assert.equal(readFileSync(join(ctx.workspace, 'canary.txt'), 'utf8'), 'unregistered');
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

async function directoryCopy(t, { paths, fail = false, deadline = Date.now() + 30000 }) {
  const root = mkdtempSync(join(tmpdir(), 'directory-copy-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const snapshot = join(root, 'source'), workspace = join(root, 'target');
  mkdirSync(snapshot);
  mkdirSync(workspace);
  for (const path of paths) mkdirSync(join(snapshot, path), { recursive: true });
  const progressPath = `${workspace}.dependency-copy-test.jsonl`;
  writeFileSync(progressPath, `${JSON.stringify({
    format: 'dependency-copy-progress-v1', directoryOffset: 50, paths, checkpointInterval: 10
  })}\n`);
  const state = { calls: [], observedAtSpawn: [], logs: [], exitCode: 0 };
  const require = createRequire(import.meta.url);
  const processMock = {
    platform: process.platform, exitCode: 0,
    env: { PILOT_DEPENDENCY_COPY: JSON.stringify({
      snapshot, workspace, paths, deadline, progressPath
    }), SYNTHETIC_SECRET: 'never-retain-private-output' }
  };
  const spawnSync = (_command, args, options) => {
    state.calls.push({ args, timeout: options.timeout });
    state.observedAtSpawn.push(readDependencyCopyProgress(progressPath, paths, 50));
    return { status: fail && state.calls.length === 2 ? 8 : 7,
      stdout: 'never-retain-private-output', stderr: 'never-retain-private-output' };
  };
  await runInNewContext(readFileSync(new URL('../src/dependency-snapshot-copy.cjs', import.meta.url), 'utf8'), {
    require: name => name === 'node:child_process' ? { spawnSync } : require(name),
    process: processMock,
    console: { log: text => state.logs.push(text), error: text => state.logs.push(text) }
  });
  state.exitCode = processMock.exitCode;
  return { ...state, progressPath, progress: readDependencyCopyProgress(progressPath, paths, 50) };
}

test('directory copy checkpoints completed groups and preserves each directory timing', async t => {
  const result = await directoryCopy(t, {
    paths: ['ooui/.store', ...Array.from({ length: 20 }, (_, index) => `ooui/package-${index}/lib`)]
  });
  assert.equal(result.exitCode, 0);
  assert(result.calls.every(call => call.args.includes('/MT:32')));
  assert.deepEqual([...new Set(result.observedAtSpawn.map(entry => entry.completedPaths))], [0, 10, 20]);
  assert.deepEqual(result.observedAtSpawn[0].activePaths, ['ooui/.store']);
  assert.equal(result.observedAtSpawn[20].activePaths[0], 'ooui/package-19/lib');
  assert.equal(result.progress.completedPaths, 21);
  assert.equal(result.progress.status, 'passed');
  assert.equal(result.logs[0], 'PILOT_DEPENDENCY_COPY:{"completedPaths":21}');
  const events = readFileSync(result.progressPath, 'utf8').trim().split('\n').slice(1).map(JSON.parse);
  assert.equal(events.length, 4);
  assert.equal(events.flatMap(event => event.copyTimings).length, 21);
  assert(!readFileSync(result.progressPath, 'utf8').includes('never-retain-private-output'));
});

test('directory copy retains its failed path and completed count without native private output', async t => {
  const result = await directoryCopy(t, {
    paths: Array.from({ length: 6 }, (_, index) => `ooui/package-${index}/lib`), fail: true
  });
  assert.equal(result.exitCode, 1);
  assert.equal(result.calls.length, 2);
  assert.equal(result.progress.completedPaths, 1);
  assert.equal(result.progress.nativeExitCode, 8);
  assert.equal(result.progress.failedPath, 'ooui/package-1/lib');
  assert.equal(result.progress.timeout, false);
  assert.equal(result.progress.status, 'failed');
  assert(!result.logs.join('\n').includes('never-retain-private-output'));
});

test('directory copy records the pending root when its shared deadline expires before launch', async t => {
  const expired = await directoryCopy(t, { paths: ['ooui/lib'], deadline: Date.now() - 1 });
  assert.equal(expired.exitCode, 1);
  assert.equal(expired.calls.length, 0);
  assert.equal(expired.progress.timeout, true);
  assert.equal(expired.progress.failedPath, 'ooui/lib');
});

test('copy progress survives an interrupted final record without replacing the primary timeout', async t => {
  const result = await directoryCopy(t, { paths: ['ooui/lib'] });
  appendFileSync(result.progressPath, '{"status":"unfinished');
  const progress = readDependencyCopyProgress(result.progressPath, ['ooui/lib'], 50);
  assert.equal(progress.completedPaths, 1);
  assert.equal(progress.trailingRecordIncomplete, true);
  const failure = preparationFailure(Object.assign(new Error('timeout'), {
    killed: true, ownedProcessesExited: true, dependencyCopy: progress
  }));
  assert.equal(failure.reason, 'command-timeout');
  assert.deepEqual(failure.dependencyCopy, progress);
  assert.equal(readDependencyCopyProgress(result.progressPath, ['ooui/other'], 50).status, 'unavailable');
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
