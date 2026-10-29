import { lstatSync, mkdirSync, readdirSync, readFileSync, writeFileSync,
  renameSync, unlinkSync, rmdirSync, realpathSync, openSync, closeSync, fsyncSync } from 'node:fs';
import { dirname, join, relative, resolve, isAbsolute, sep } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { setTimeout as delay } from 'node:timers/promises';
import { hash, json, now, requireThat, safeError, uuid } from './common.js';
import { preparationGit, unregisterValidationWorktree } from './validation-workspace.js';

const format = 'owned-resource-v1';
const queues = new Map();
const present = path => {
  try { lstatSync(path); return true; }
  catch (error) { if (error.code === 'ENOENT') return false; throw error; }
};
const within = (root, path) => {
  const rel = relative(root, path);
  return rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel);
};
function check(condition, message) {
  requireThat(condition, message, 'blocked-resource-cleanup');
}
function identity(path) {
  const stat = lstatSync(path, { bigint: true });
  check(stat.isDirectory() && !stat.isSymbolicLink(), 'Resource directory is a link or not a directory');
  return { dev: String(stat.dev), ino: String(stat.ino), birth: String(stat.birthtimeNs) };
}
function same(path, expected) {
  check(json(identity(path)) === json(expected), 'Resource directory identity changed');
}
function unlinked(path) {
  for (let current = resolve(path); ; current = dirname(current)) {
    if (present(current)) identity(current);
    if (dirname(current) === current) break;
  }
}
function atomic(path, value) {
  const temp = `${path}.${uuid()}.tmp`;
  const fd = openSync(temp, 'wx', 0o600);
  try { writeFileSync(fd, `${json(value)}\n`); fsyncSync(fd); }
  finally { closeSync(fd); }
  renameSync(temp, path);
}
function preserveEvidence(record) {
  const root = join(record.archive, 'evidence');
  unlinked(root);
  mkdirSync(root, { recursive: true });
  record.archivedEvidence = record.evidence.map((ref, index) => {
    const path = join(root, `${index}.bin`);
    if (!present(path)) {
      const fd = openSync(path, 'wx', 0o600);
      try { writeFileSync(fd, readFileSync(ref.path)); fsyncSync(fd); }
      finally { closeSync(fd); }
    }
    check(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() &&
      hash(readFileSync(path)) === ref.sha256, 'Archived evidence conflicts with its source');
    return { ...ref, originalPath: ref.path, path };
  });
}
function processAlive(pid) {
  check(Number.isSafeInteger(pid) && pid > 0, 'Invalid resource lease process');
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
}
export function resourceLeaseActive(record) {
  return record.leasePid !== process.pid && processAlive(record.leasePid);
}
function directory(stateDirectory) {
  const root = join(resolve(stateDirectory), 'resource-lifecycle');
  unlinked(root);
  mkdirSync(root, { recursive: true });
  return root;
}
function journalPath(stateDirectory, id) {
  check(/^[a-f0-9-]{36}$/.test(id), 'Invalid resource ID');
  return join(directory(stateDirectory), `${id}.json`);
}
export function resourceRecord(stateDirectory, id) {
  const path = journalPath(stateDirectory, id);
  check(lstatSync(path).isFile() && !lstatSync(path).isSymbolicLink() &&
    lstatSync(path).size < 4 * 1024 * 1024, 'Invalid resource journal');
  const record = JSON.parse(readFileSync(path, 'utf8'));
  check(record.format === format && record.id === id, 'Invalid resource ownership');
  return record;
}
function save(stateDirectory, record, stage, detail = {}) {
  record.stage = stage;
  record.updatedAt = now();
  record.events.push({ stage, at: record.updatedAt, ...detail });
  check(record.events.length < 10000, 'Resource journal event limit exceeded');
  atomic(journalPath(stateDirectory, record.id), record);
  return record;
}
function leaseDatabase(stateDirectory) {
  const path = join(directory(stateDirectory), 'lease.sqlite');
  for (const suffix of ['', '-journal', '-wal', '-shm']) {
    if (present(path + suffix))
      check(lstatSync(path + suffix).isFile() && !lstatSync(path + suffix).isSymbolicLink(),
        'Invalid resource lease database');
  }
  return new DatabaseSync(path);
}
async function lease(stateDirectory, action) {
  const db = leaseDatabase(stateDirectory);
  let locked = false;
  try {
    const deadline = Date.now() + 120000;
    while (!locked) {
      try { db.exec('BEGIN IMMEDIATE'); locked = true; }
      catch (error) {
        if (error.errcode !== 5 && error.errcode !== 6) throw error;
        check(Date.now() < deadline, 'Another resource lifecycle operation is still active');
        await delay(50);
      }
    }
    return await action();
  } finally {
    if (locked) db.exec('ROLLBACK');
    db.close();
  }
}
export function withResourceRetentionLock(stateDirectory, action) {
  if (!present(join(resolve(stateDirectory), 'resource-lifecycle'))) return action();
  const db = leaseDatabase(stateDirectory);
  let locked = false;
  try {
    try { db.exec('BEGIN IMMEDIATE'); locked = true; }
    catch (error) {
      if (error.errcode !== 5 && error.errcode !== 6) throw error;
      check(false, 'Cannot prune evidence while a resource ownership transition is active');
    }
    return action();
  } finally {
    if (locked) db.exec('ROLLBACK');
    db.close();
  }
}
async function exclusive(stateDirectory, action) {
  const key = resolve(stateDirectory);
  const run = () => lease(key, action);
  const prior = queues.get(key) ?? Promise.resolve();
  const current = prior.then(run, run);
  queues.set(key, current);
  try { return await current; }
  finally { if (queues.get(key) === current) queues.delete(key); }
}
function namespace(stateDirectory, kind) {
  check(['validation', 'preflight', 'task'].includes(kind), 'Unknown owned resource kind');
  return join(resolve(stateDirectory), `${kind}-workspaces`);
}
function paths(stateDirectory, record) {
  const root = namespace(stateDirectory, record.kind);
  check(resolve(record.namespace) === root && dirname(record.workspace) === root &&
    within(root, record.workspace), 'Resource is outside its declared owned namespace');
  unlinked(root);
  same(root, record.namespaceIdentity);
  check(record.archive === join(resolve(stateDirectory), 'resource-archives', record.id),
    'Resource archive path changed');
  unlinked(record.archive);
  if (record.archiveIdentity) same(record.archive, record.archiveIdentity);
  return { root, snapshot: join(record.archive, 'snapshot') };
}
async function owner(record, timeoutMs) {
  unlinked(record.source);
  same(record.source, record.sourceIdentity);
  const common = realpathSync(await preparationGit(record.source,
    ['rev-parse', '--path-format=absolute', '--git-common-dir'], timeoutMs));
  check(common === record.commonDirectory, 'Resource Git common owner changed');
  same(common, record.commonIdentity);
}
async function inspectGit(record, timeoutMs, checkClean = true) {
  await owner(record, timeoutMs);
  const pointer = join(record.workspace, '.git');
  if (present(pointer)) {
    check(lstatSync(pointer).isFile() && !lstatSync(pointer).isSymbolicLink(),
      'Resource is not a secondary Git worktree');
    const pointerHash = hash(readFileSync(pointer));
    if (record.gitPointerSha256)
      check(pointerHash === record.gitPointerSha256, 'Resource Git pointer changed');
    else record.gitPointerSha256 = pointerHash;
    if (record.adminDirectory && !present(record.adminDirectory)) {
      check(record.kind !== 'task', 'Coding task lost registration before clean-source verification');
      return;
    }
    const common = realpathSync(await preparationGit(record.workspace,
      ['rev-parse', '--path-format=absolute', '--git-common-dir'], timeoutMs));
    check(common === record.commonDirectory, 'Resource belongs to a different Git owner');
    const admin = realpathSync(await preparationGit(record.workspace,
      ['rev-parse', '--absolute-git-dir'], timeoutMs));
    check(dirname(admin) === join(common, 'worktrees'), 'Unexpected resource Git administration path');
    if (record.adminDirectory) {
      check(admin === record.adminDirectory, 'Resource Git registration changed');
      same(admin, record.adminIdentity);
    }
    else {
      record.adminDirectory = admin;
      record.adminIdentity = identity(admin);
    }
    if (record.kind === 'task' && checkClean) {
      check(await preparationGit(record.workspace, ['rev-parse', 'HEAD'], timeoutMs) ===
        record.close?.revision &&
        !await preparationGit(record.workspace, ['status', '--porcelain', '--untracked-files=all'], timeoutMs),
      'Coding task worktree is dirty or its delivered revision changed');
    }
  } else {
    check(record.kind !== 'task', 'Coding task lost Git metadata before clean-source verification');
  }
}
function evidence(record) {
  check(record.evidence.length > 0, 'Resource has no externally preserved evidence');
  for (const ref of record.evidence) {
    check(isAbsolute(ref.path) && !within(record.workspace, ref.path) &&
      ref.path !== record.workspace, 'Resource evidence must be outside its workspace');
    unlinked(dirname(ref.path));
    const stat = lstatSync(ref.path);
    check(stat.isFile() && !stat.isSymbolicLink() &&
      hash(readFileSync(ref.path)) === ref.sha256, 'Preserved resource evidence changed or is missing');
  }
}

// Ownership is established before Git or a runner can populate the directory.
export async function createOwnedResource(stateDirectory, {
  kind, workspace, source, revision, assignmentId, attemptId, references = [], cachePaths = []
}, timeoutMs = 120000) {
  return exclusive(stateDirectory, async () => {
    const root = namespace(stateDirectory, kind);
    workspace = resolve(workspace);
    unlinked(source);
    source = realpathSync(source);
    check(dirname(workspace) === root && !present(workspace) &&
      !within(workspace, source) && !within(source, workspace) && workspace !== source,
    'New resources require a fresh direct child of their owned namespace, disjoint from source');
    check(typeof assignmentId === 'string' && assignmentId &&
      typeof attemptId === 'string' && attemptId &&
      /^[a-f0-9]{40,64}$/.test(revision) &&
      references.every(ref => typeof ref === 'string' && ref), 'Incomplete resource assignment');
    unlinked(root); unlinked(source);
    mkdirSync(root, { recursive: true });
    const commonDirectory = realpathSync(await preparationGit(source,
      ['rev-parse', '--path-format=absolute', '--git-common-dir'], timeoutMs));
    const id = uuid();
    const record = {
      format, id, kind, workspace, namespace: root, namespaceIdentity: identity(root),
      source, sourceIdentity: identity(source), commonDirectory,
      commonIdentity: identity(commonDirectory), revision, assignmentId, attemptId,
      archive: join(resolve(stateDirectory), 'resource-archives', id),
      references, cachePaths: cacheDeclarations(cachePaths), leasePid: process.pid, processesExited: false,
      releaseRequested: false, evidence: [], events: [], createdAt: now()
    };
    save(stateDirectory, record, 'allocating');
    mkdirSync(workspace);
    record.identity = identity(workspace);
    return save(stateDirectory, record, 'active');
  });
}

export async function updateResource(stateDirectory, id, update) {
  return exclusive(stateDirectory, async () => {
    const record = resourceRecord(stateDirectory, id);
    paths(stateDirectory, record);
    check(!['archive-created', 'evidence-preserved', 'archived', 'moving', 'unregistering', 'cache-removal', 'complete'].includes(record.stage),
      'Cannot reacquire a retiring resource');
    check(!resourceLeaseActive(record),
      'Resource is in use by another process');
    check(Object.keys(update).every(key => ['references', 'processesExited', 'releaseRequested',
      'evidence', 'close', 'primaryError', 'runnerEvidence', 'monitorError', 'cachePaths'].includes(key)), 'Invalid resource lifecycle update');
    if (update.cachePaths) update.cachePaths = cacheDeclarations(update.cachePaths);
    Object.assign(record, update, { leasePid: process.pid });
    return save(stateDirectory, record, 'active');
  });
}

export async function bindResourceGit(stateDirectory, id, timeoutMs = 120000) {
  return exclusive(stateDirectory, async () => {
    const record = resourceRecord(stateDirectory, id);
    paths(stateDirectory, record);
    same(record.workspace, record.identity);
    await inspectGit(record, timeoutMs, false);
    return save(stateDirectory, record, 'active');
  });
}

export async function claimPreflight(stateDirectory, id, workspace, revision, reference) {
  return exclusive(stateDirectory, async () => {
    const record = resourceRecord(stateDirectory, id);
    paths(stateDirectory, record);
    check(record.kind === 'preflight' && record.workspace === resolve(workspace) &&
      record.revision === revision && record.references.length === 1 &&
      record.references[0] === 'validation-handoff' && !record.releaseRequested &&
      record.processesExited && (record.leasePid === process.pid || !processAlive(record.leasePid)),
    'Preflight handoff is not available for this consumer');
    same(record.workspace, record.identity);
    Object.assign(record, { leasePid: process.pid, references: [reference], processesExited: false });
    return save(stateDirectory, record, 'active');
  });
}

export async function abandonPreflight(stateDirectory, id) {
  await exclusive(stateDirectory, async () => {
    const record = resourceRecord(stateDirectory, id);
    paths(stateDirectory, record);
    if (record.kind === 'preflight' && record.processesExited === true &&
      record.references.length === 0 && record.releaseRequested) return;
    check(record.kind === 'preflight' && record.processesExited === true &&
      (record.leasePid === process.pid || !processAlive(record.leasePid)) &&
      record.references.length === 1 && record.references[0] === 'validation-handoff',
    'Only an unconsumed, drained preflight handoff may be explicitly abandoned');
    Object.assign(record, { references: [], releaseRequested: true, leasePid: process.pid });
    save(stateDirectory, record, 'active');
  });
  return retireResource(stateDirectory, id);
}

function cacheDeclarations(paths) {
  check(Array.isArray(paths) && paths.length <= 2048 && paths.every(path =>
    typeof path === 'string' && path.length <= 1024 && path &&
    !/[:\\\0\r\n]/.test(path) && !isAbsolute(path) &&
    path.split('/').every(part => part && !['.', '..', '.git'].includes(part.toLowerCase()))),
  'Invalid regenerable dependency-cache declaration');
  return [...new Set(paths)].sort().filter((path, _index, all) =>
    !all.some(parent => path !== parent && path.startsWith(`${parent}/`)));
}
async function verifyCaches(record, timeoutMs) {
  const paths = cacheDeclarations(record.cachePaths)
    .filter(path => present(join(record.workspace, path)));
  record.verifiedCaches = paths.map(path => {
    const absolute = join(record.workspace, path);
    unlinked(absolute);
    return { path, identity: identity(absolute) };
  });
  for (let offset = 0; offset < paths.length; offset += 32) {
    const batch = paths.slice(offset, offset + 32);
    check(!await preparationGit(record.workspace,
      ['--literal-pathspecs', 'ls-files', '-z', '--', ...batch], timeoutMs),
    'Declared cache contains tracked source; it must be preserved');
    const ignored = (await preparationGit(record.workspace,
      ['--literal-pathspecs', 'ls-files', '--others', '--ignored', '--exclude-standard',
        '--directory', '-z', '--', ...batch], timeoutMs))
      .split('\0').filter(Boolean).map(path => path.replace(/\/$/, ''));
    check(batch.every(path => ignored.includes(path)),
      'Declared cache is not an independently ignored dependency directory');
  }
}
// Cache ownership comes from the preparation/task contract, not directory names.
function cacheInventory(snapshot, declarations, timeoutMs) {
  const caches = declarations;
  for (const cache of caches) {
    unlinked(join(snapshot, cache.path));
    same(join(snapshot, cache.path), cache.identity);
  }
  const pending = caches.map(cache => join(snapshot, cache.path));
  const deadline = Date.now() + timeoutMs;
  const rootIdentity = identity(snapshot);
  while (pending.length) {
    const directory = pending.pop();
    same(snapshot, rootIdentity);
    unlinked(directory);
    const original = identity(directory);
    check(original.dev === rootIdentity.dev, 'Cache inventory crossed a filesystem boundary');
    for (const name of readdirSync(directory)) {
      check(Date.now() < deadline, 'Resource cache inventory deadline exceeded');
      same(directory, original);
      const path = join(directory, name), stat = lstatSync(path);
      check(name.toLowerCase() !== '.git', 'Unknown nested Git metadata blocks cache cleanup');
      if (!stat.isDirectory() || stat.isSymbolicLink()) continue;
      pending.push(path);
    }
  }
  return caches;
}
function removeCache(root, expected, deadline) {
  same(root, expected);
  const visit = directory => {
    unlinked(directory);
    const original = identity(directory);
    check(original.dev === expected.dev, 'Cache cleanup crossed a filesystem boundary');
    for (const name of readdirSync(directory)) {
      check(Date.now() < deadline, 'Resource cache cleanup deadline exceeded');
      same(directory, original);
      const path = join(directory, name), stat = lstatSync(path);
      check(name !== '.git', 'Unknown nested Git metadata blocks cache cleanup');
      if (stat.isSymbolicLink()) unlinkSync(path);
      else if (stat.isDirectory()) visit(path);
      else { check(stat.isFile(), 'Unsupported resource leaf type'); unlinkSync(path); }
    }
    same(directory, original);
    rmdirSync(directory);
  };
  visit(root);
}

export async function retireResource(stateDirectory, id, {
  timeoutMs = 120000, checkpoint = () => {}, verifyTask = null
} = {}) {
  return exclusive(stateDirectory, async () => {
    const record = resourceRecord(stateDirectory, id);
    try {
      const { snapshot } = paths(stateDirectory, record);
      if (record.stage === 'moving' && !present(record.workspace) && present(snapshot)) {
        same(snapshot, record.identity);
        record.moved = true;
        save(stateDirectory, record, 'archived');
      }
      // Even a completed receipt may not authorize touching a replacement path.
      if (record.stage === 'complete') {
        check(!present(record.workspace), 'Retired resource path was recreated');
        same(snapshot, record.identity);
        return record;
      }
      check(record.releaseRequested && record.references.length === 0,
        'Resource still has a handoff, seed, approval, proof or downstream reference');
      for (const file of readdirSync(directory(stateDirectory))
        .filter(file => /^[a-f0-9-]{36}\.json$/.test(file))) {
        const other = resourceRecord(stateDirectory, file.slice(0, -5));
        if (other.id === record.id || other.stage === 'complete') continue;
        check(relative(record.workspace, other.source) !== '' && !within(record.workspace, other.source) &&
          !other.evidence.some(ref => ref.path === record.workspace || within(record.workspace, ref.path)),
        'Another owned resource still references this source or its unique evidence');
      }
      check(record.processesExited === true &&
        (record.leasePid === process.pid || !processAlive(record.leasePid)),
      'Owned process exit is not confirmed');
      evidence(record);
      await owner(record, timeoutMs);
      if (!record.archiveIdentity) {
        check(!present(record.archive), 'Unowned resource archive destination already exists');
        mkdirSync(dirname(record.archive), { recursive: true });
        unlinked(dirname(record.archive));
        mkdirSync(record.archive);
        record.archiveIdentity = identity(record.archive);
        save(stateDirectory, record, 'archive-created');
      }
      if (!record.archivedEvidence) {
        preserveEvidence(record);
        save(stateDirectory, record, 'evidence-preserved');
      }
      if (!record.moved) {
        check(!present(snapshot), 'Resource archive destination is already occupied');
        same(record.workspace, record.identity);
        await inspectGit(record, timeoutMs);
        await verifyCaches(record, timeoutMs);
        if (record.kind === 'task') {
          check(verifyTask && await verifyTask(record), 'Coding task is not merged, validated and handed over');
          mkdirSync(record.archive, { recursive: true });
          const bundle = join(record.archive, 'history.bundle');
          if (!present(bundle))
            await preparationGit(record.workspace, ['bundle', 'create', bundle, 'HEAD'], timeoutMs);
          await preparationGit(record.workspace, ['bundle', 'verify', bundle], timeoutMs);
          record.bundle = { path: bundle, sha256: hash(readFileSync(bundle)) };
        }
        mkdirSync(record.archive, { recursive: true });
        // Persist the rename intent and identity before the atomic operation.
        save(stateDirectory, record, 'moving');
        checkpoint('moving', record);
        same(record.workspace, record.identity);
        renameSync(record.workspace, snapshot);
        checkpoint('renamed', record);
        same(snapshot, record.identity);
        record.moved = true;
        save(stateDirectory, record, 'archived');
      }
      same(snapshot, record.identity);
      check(!present(record.workspace), 'Original path was replaced during retirement');
      if (!record.unregistered) {
        save(stateDirectory, record, 'unregistering');
        checkpoint('unregistering', record);
        const pointer = join(snapshot, '.git');
        if (present(pointer)) {
          check(lstatSync(pointer).isFile() && !lstatSync(pointer).isSymbolicLink(),
            'Archived Git pointer changed');
          check(hash(readFileSync(pointer)) === record.gitPointerSha256,
            'Archived Git pointer no longer matches its owned registration');
          const backup = join(record.archive, 'git-pointer.txt');
          if (!present(backup)) writeFileSync(backup, readFileSync(pointer), { flag: 'wx', mode: 0o600 });
          check(readFileSync(backup).equals(readFileSync(pointer)), 'Archived Git pointer backup differs');
          unlinkSync(pointer);
        }
        await unregisterValidationWorktree(record.source, record.workspace, timeoutMs, record);
        checkpoint('unregistered', record);
        record.unregistered = true;
        save(stateDirectory, record, 'archived');
      }
      if (!record.caches) {
        record.caches = cacheInventory(snapshot, record.verifiedCaches, timeoutMs);
        save(stateDirectory, record, 'cache-removal');
      }
      for (const cache of record.caches) {
        paths(stateDirectory, record);
        same(snapshot, record.identity);
        check(within(snapshot, resolve(snapshot, cache.path)), 'Cache path escapes archive');
        const path = join(snapshot, cache.path);
        if (present(path)) {
          unlinked(dirname(path));
          same(path, cache.identity);
          checkpoint('cache-removal', record);
          removeCache(path, cache.identity, Date.now() + timeoutMs);
        }
      }
      check(!present(record.workspace), 'Resource path was recreated');
      record.cleanupError = null;
      atomic(join(record.archive, 'manifest.json'), {
        ...record, stage: 'complete', completedAt: now(),
        recovery: record.kind === 'task'
          ? 'Clone history.bundle into a NEW checkout, then restore required private files from snapshot. Never overlay another task checkout.'
          : 'Snapshot preserves non-cache files; source Git common owner and exact revision are recorded. Recreate dependencies in a NEW owned workspace.'
      });
      return save(stateDirectory, record, 'complete');
    } catch (error) {
      record.cleanupError = safeError(error);
      save(stateDirectory, record, record.stage, { error: record.cleanupError });
      return { ...record, status: 'blocked' };
    }

  });
}

export function resourceRetentionPaths(stateDirectory) {
  const root = join(resolve(stateDirectory), 'resource-lifecycle');
  if (!present(root)) return [];
  unlinked(root);
  return readdirSync(root).filter(name => /^[a-f0-9-]{36}\.json$/.test(name)).flatMap(name => {
    const record = resourceRecord(stateDirectory, name.slice(0, -5));
    return record.stage === 'complete' ? [] :
      [record.workspace, record.source, ...record.evidence.map(ref => ref.path)];
  });
}

export async function reconcileResources(stateDirectory, options = {}) {
  if (!present(join(resolve(stateDirectory), 'resource-lifecycle'))) return [];
  const root = directory(stateDirectory), results = [], known = new Set();
  for (const name of readdirSync(root).filter(name => /^[a-f0-9-]{36}\.json$/.test(name))) {
    const record = resourceRecord(stateDirectory, name.slice(0, -5));
    known.add(record.workspace);
    if (resourceLeaseActive(record) ||
      (record.leasePid === process.pid && !record.releaseRequested)) continue;
    if (record.releaseRequested && record.references.length === 0)
      results.push(await retireResource(stateDirectory, record.id, options));
    else if (!record.processesExited)
      results.push({ id: record.id, workspace: record.workspace, status: 'blocked',
        reason: 'Interrupted resource retained: process exit or handoff disposition is unconfirmed' });
  }
  for (const kind of ['validation', 'preflight', 'task']) {
    const path = namespace(stateDirectory, kind);
    unlinked(path);
    if (!present(path)) continue;
    for (const name of readdirSync(path)) {
      const workspace = join(path, name);
      if (!known.has(workspace))
        results.push({ workspace, status: 'blocked', reason: 'Unknown ownership in declared resource namespace' });
    }
  }
  atomic(join(root, 'reconciliation.json'), { checkedAt: now(), results });
  return results;
}
