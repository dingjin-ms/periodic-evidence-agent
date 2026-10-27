import { existsSync, mkdirSync, realpathSync, lstatSync, readFileSync,
  readdirSync, unlinkSync } from 'node:fs';
import { dirname, resolve, relative, isAbsolute, sep, join } from 'node:path';
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
    ...(error.dependencyCopy ? { dependencyCopy: error.dependencyCopy } : {}),
    // Never retain arbitrary command text, stdout, stderr or inherited environment.
    reason: error.containmentFailure ? 'process-tree-exit-unconfirmed' :
      error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' ? 'output-limit' :
      error.killed ? 'command-timeout' :
        error.code === 'ENOSPC' ? 'disk-full' :
          error.code === 'EACCES' || error.code === 'EPERM' ? 'access-denied' :
            'command-or-invariant-failed'
  };
}

export function readDependencyCopyProgress(path, paths, directoryOffset) {
  const result = { journalPath: path, directoryOffset, batchSize: paths.length };
  try {
    requireThat(lstatSync(path).isFile() && lstatSync(path).size <= 1024 * 1024,
      'Invalid dependency copy progress journal');
    const lines = readFileSync(path, 'utf8').split('\n');
    const trailingRecordIncomplete = lines.pop() !== '';
    const header = JSON.parse(lines.shift());
    const checkpointInterval = header.checkpointInterval ?? 1;
    requireThat(header.format === 'dependency-copy-progress-v1' &&
      header.directoryOffset === directoryOffset &&
      Number.isInteger(checkpointInterval) && checkpointInterval > 0 && checkpointInterval <= 50 &&
      JSON.stringify(header.paths) === JSON.stringify(paths),
    'Dependency copy progress does not match its batch');
    let last = { status: 'starting', completedPaths: 0, activePaths: [], failedPath: null };
    for (const line of lines) {
      const entry = JSON.parse(line);
      requireThat(['copying', 'passed', 'failed'].includes(entry.status) &&
        Number.isInteger(entry.completedPaths) && entry.completedPaths >= last.completedPaths &&
        entry.completedPaths <= paths.length &&
        Array.isArray(entry.activePaths) && entry.activePaths.length <= 1 &&
        entry.activePaths.every(path => paths.includes(path)) &&
        (entry.failedPath === null || paths.includes(entry.failedPath)) &&
        (entry.status !== 'passed' || (entry.completedPaths === paths.length &&
          entry.activePaths.length === 0 && entry.failedPath === null)),
      'Invalid dependency copy progress record');
      last = entry;
    }
    return { ...result, checkpointInterval,
      status: last.status, completedPaths: last.completedPaths,
      activePaths: last.activePaths, failedPath: last.failedPath,
      timeout: last.timeout === true,
      nativeExitCode: Number.isInteger(last.nativeExitCode) ? last.nativeExitCode : null,
      trailingRecordIncomplete };
  } catch (error) {
    return { ...result, status: 'unavailable',
      diagnosticError: /^[A-Z_]+$/.test(error.code ?? '') ? error.code : 'invalid-progress-record' };
  }
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
  persist = () => {}, seed, hydrate = async () => {}, lifecycle = null
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
  let resource = null;
  if (lifecycle) {
    const { createOwnedResource } = await import('./resource-lifecycle.js');
    resource = await createOwnedResource(lifecycle.stateDirectory, {
      ...lifecycle, source, workspace, revision
    }, timeoutMs);
    lifecycle.created(resource);
  }
  await stage('worktree-create', () => preparationGit(source,
    ['worktree', 'add', '--detach', '--no-checkout', '--', workspace, revision], timeoutMs));
  if (resource) {
    const { bindResourceGit } = await import('./resource-lifecycle.js');
    await bindResourceGit(lifecycle.stateDirectory, resource.id, timeoutMs);
  }
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
  if (resource && dependencySeed?.paths) {
    const { updateResource } = await import('./resource-lifecycle.js');
    await updateResource(lifecycle.stateDirectory, resource.id, {
      cachePaths: dependencySeed.paths.filter(path => /(^|\/)(node_modules|\.store)$/.test(path))
    });
  }
  await stage('final-source-check', async () => {
    await requireCleanRevision(source, revision, timeoutMs);
    await requireCleanRevision(workspace, revision, timeoutMs);
  });
  return { strategy: 'detached-worktree', workspace, sourceRevision: revision,
    sparseCheckoutPaths, dependencySeed, timings,
    ...(resource ? { resourceId: resource.id } : {}) };
}

export async function unregisterValidationWorktree(source, workspace, timeoutMs, ownership) {
  requireThat(!existsSync(workspace),
    'Git unregister requires an already archived workspace', 'blocked-resource-cleanup');
  const common = realpathSync(await preparationGit(source,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'], timeoutMs));
  requireThat(common === ownership.commonDirectory,
    'Cannot unregister using another Git common owner', 'blocked-resource-cleanup');
  const listed = await preparationGit(source, ['worktree', 'list', '--porcelain', '-z'], timeoutMs);
  if (!listed.split('\0').some(entry =>
    entry.startsWith('worktree ') && resolve(entry.slice(9)) === resolve(workspace))) return;
  const admin = ownership.adminDirectory;
  if (admin) {
    for (let path = dirname(admin); ; path = dirname(path)) {
      requireThat(lstatSync(path).isDirectory() && !lstatSync(path).isSymbolicLink(),
        'Git unregister administration parent cannot be a link', 'blocked-resource-cleanup');
      if (dirname(path) === path) break;
    }
  }
  const metadata = admin ? lstatSync(admin, { bigint: true }) : null;
  requireThat(admin && dirname(admin) === join(common, 'worktrees') &&
    metadata.isDirectory() && !metadata.isSymbolicLink() &&
    String(metadata.ino) === ownership.adminIdentity.ino &&
    String(metadata.dev) === ownership.adminIdentity.dev &&
    String(metadata.birthtimeNs) === ownership.adminIdentity.birth &&
    resolve(readFileSync(join(admin, 'gitdir'), 'utf8').trim()) === join(resolve(workspace), '.git'),
  'Git registration identity does not match the archived resource', 'blocked-resource-cleanup');
  await preparationGit(source, ['worktree', 'remove', '--force', '--', resolve(workspace)], timeoutMs);
  const remaining = await preparationGit(source, ['worktree', 'list', '--porcelain', '-z'], timeoutMs);
  requireThat(!remaining.split('\0').some(entry =>
    entry.startsWith('worktree ') && resolve(entry.slice(9)) === resolve(workspace)),
  'Exact Git registration remains after cleanup', 'blocked-resource-cleanup');
}

export async function removeValidationWorktree(source, workspace, timeoutMs) {
  const timings = [];
  const stage = (id, operation) => preparationStage(timings, id, operation);
  try {
    const actual = resolve(workspace);
    await stage('cleanup-ownership-check', async () => {
      const listed = await preparationGit(source, ['worktree', 'list', '--porcelain', '-z'], timeoutMs);
      requireThat(listed.split('\0').some(entry =>
        entry.startsWith('worktree ') && resolve(entry.slice(9)) === actual),
      'Refusing cleanup of an unregistered validation worktree', 'blocked-validation');
      requireThat(actual !== realpathSync(source) && realpathSync(actual) === actual &&
        lstatSync(actual).isDirectory() && !lstatSync(actual).isSymbolicLink() &&
        lstatSync(join(actual, '.git')).isFile() && !lstatSync(join(actual, '.git')).isSymbolicLink(),
      'Validation cleanup requires an unlinked registered secondary worktree', 'blocked-validation');
    });
    let unlinkedLinks = 0;
    await stage('cleanup-link-scan', async () => {
      if (process.platform !== 'win32') return;
      const deadline = Date.now() + timeoutMs;
      const pending = [actual];
      while (pending.length) {
        requireThat(Date.now() < deadline, 'Validation link cleanup deadline exceeded', 'blocked-validation');
        const directory = pending.pop();
        requireThat(lstatSync(directory).isDirectory() && !lstatSync(directory).isSymbolicLink(),
          'Validation cleanup directory changed into a link', 'blocked-validation');
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isSymbolicLink()) {
            requireThat(lstatSync(path).isSymbolicLink(),
              'Validation cleanup link changed', 'blocked-validation');
            // Git for Windows can leave junctions behind, even after reporting success.
            unlinkSync(path);
            unlinkedLinks++;
          } else if (entry.isDirectory()) pending.push(path);
        }
      }
    });
    await stage('cleanup-git-remove', () =>
      preparationGit(source, ['worktree', 'remove', '--force', '--', actual], timeoutMs));
    await stage('cleanup-root-check', async () => {
      requireThat(!existsSync(actual),
        'Git reported cleanup success but the validation workspace remains', 'blocked-validation');
    });
    return { unlinkedLinks, rootRemoved: true, timings };
  } catch (error) {
    error.cleanupTimings = timings;
    throw error;
  }
}
