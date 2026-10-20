import { existsSync, mkdirSync, realpathSync, lstatSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, sep } from 'node:path';
import { nativeCommand } from './native-command.js';
import { requireThat, now, safeError } from './common.js';

export async function preparationGit(cwd, args, timeoutMs, env = process.env) {
  return (await nativeCommand('git', ['-c', 'core.longpaths=true',
    '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
    ...args], cwd, timeoutMs, env)).stdout.trim();
}

export function preparationFailure(error) {
  return {
    code: typeof error.code === 'number' || /^[A-Z_]+$/.test(error.code ?? '')
      ? error.code : null,
    nativeExitCode: Number.isInteger(error.nativeExitCode) ? error.nativeExitCode : null,
    timeout: error.killed === true,
    ownedProcessesExited: error.ownedProcessesExited === true,
    containmentFailure: error.containmentFailure === true,
    error: safeError(error),
    // Never retain arbitrary command text, stdout, stderr or inherited environment.
    reason: error.containmentFailure ? 'process-tree-exit-unconfirmed' :
      error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output-limit' :
      error.killed ? 'command-timeout' :
        error.code === 'ENOSPC' ? 'disk-full' :
          error.code === 'EACCES' || error.code === 'EPERM' ? 'access-denied' :
            'command-or-invariant-failed'
  };
}

export async function preparationStage(timings, id, operation, persist = () => {}) {
  const stage = { id, startedAt: now(), status: 'running' };
  timings.push(stage);
  persist();
  const started = Date.now();
  try {
    const result = await operation();
    stage.status = 'passed';
    return result;
  } catch (error) {
    stage.status = 'blocked';
    stage.failure = preparationFailure(error);
    error.preparationStage ??= id;
    throw error;
  } finally {
    stage.completedAt = now();
    stage.durationMs = Date.now() - started;
    persist();
  }
}

export async function requireCleanRevision(workspace, revision, timeoutMs) {
  requireThat(await preparationGit(workspace, ['rev-parse', 'HEAD'], timeoutMs) === revision &&
    !await preparationGit(workspace, ['status', '--porcelain'], timeoutMs),
  'Preparation requires clean source at the exact revision', 'blocked-validation');
}

export async function prepareValidationWorkspace({
  source, workspace, revision, timeoutMs, sparseCheckoutPaths = [], timings = [],
  persist = () => {}, seed, hydrate = async () => {}
}) {
  source = realpathSync(source);
  workspace = resolve(workspace);
  const rel = relative(source, workspace);
  requireThat(rel && (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)),
    'Validation workspace must be outside its source', 'blocked-validation');
  requireThat(/^[a-f0-9]{40,64}$/.test(revision) && !existsSync(workspace),
    'Preparation needs a fresh workspace and exact SHA', 'blocked-validation');
  for (let path = dirname(workspace); ; path = dirname(path)) {
    if (existsSync(path))
      requireThat(!lstatSync(path).isSymbolicLink(),
        'Validation workspace parent cannot be a link', 'blocked-validation');
    if (dirname(path) === path) break;
  }
  requireThat(sparseCheckoutPaths.every(path => typeof path === 'string' &&
    path && !/[:\\\0\r\n]/.test(path) && !isAbsolute(path) &&
    path.split('/').every(part => part && part !== '.' && part !== '..')),
  'Invalid preparation sparse paths', 'blocked-validation');
  const stage = (id, operation) => preparationStage(timings, id, operation, persist);
  await stage('source-check', () => requireCleanRevision(source, revision, timeoutMs));
  mkdirSync(dirname(workspace), { recursive: true });
  await stage('worktree-create', () => preparationGit(source,
    ['worktree', 'add', '--detach', '--no-checkout', '--', workspace, revision], timeoutMs));
  if (sparseCheckoutPaths.length) {
    // Sparse checkout upgrades only config storage; reject legacy global settings
    // that would otherwise change the source worktree during that upgrade.
    await stage('sparse-checkout', async () => {
      const config = await preparationGit(source, ['config', '--local', '--list'], timeoutMs);
      requireThat(!/^(core\.(sparsecheckout|bare|worktree))=/im.test(config.replace(/^core\.bare=false\r?\n?/im, '')),
        'Sparse worktree needs an unambiguous source Git configuration', 'blocked-validation');
      await preparationGit(workspace, ['sparse-checkout', 'set', '--cone',
        '--', ...sparseCheckoutPaths], timeoutMs,
      { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' });
    });
  }
  await stage('checkout', () => preparationGit(workspace,
    ['checkout', '--detach', revision], timeoutMs,
    { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' }));
  await stage('head-clean-check', () => requireCleanRevision(workspace, revision, timeoutMs));
  await stage('lfs', hydrate);
  const dependencySeed = seed ? await stage('dependencies', () => seed(source, workspace)) : null;
  await stage('final-source-check', async () => {
    await requireCleanRevision(source, revision, timeoutMs);
    await requireCleanRevision(workspace, revision, timeoutMs);
  });
  return { strategy: 'detached-worktree', workspace, sourceRevision: revision,
    sparseCheckoutPaths, dependencySeed, timings };
}

export async function removeValidationWorktree(source, workspace, timeoutMs) {
  const listed = await preparationGit(source, ['worktree', 'list', '--porcelain', '-z'], timeoutMs);
  const actual = resolve(workspace);
  requireThat(listed.split('\0').some(entry =>
    entry.startsWith('worktree ') && resolve(entry.slice(9)) === actual),
  'Refusing cleanup of an unregistered validation worktree', 'blocked-validation');
  await preparationGit(source, ['worktree', 'remove', '--force', '--', actual], timeoutMs);
}
