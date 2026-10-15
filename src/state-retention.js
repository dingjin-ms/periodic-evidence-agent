import {
  existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { hash, now, requireThat } from './common.js';

const manifestName = 'manifest.json';
const runIdPattern = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;

function stateRoot(config) {
  return resolve(config.stateDirectory);
}

function within(parent, child) {
  const path = relative(parent, child);
  return path === '' || (!path.startsWith('..') && !isAbsolute(path));
}

function canonicalPath(path) {
  const suffix = [];
  let current = resolve(path);
  while (!existsSync(current)) {
    const parent = dirname(current);
    requireThat(parent !== current, `Cannot resolve local evidence path: ${path}`, 'blocked-scope');
    suffix.unshift(current.slice(parent.length).replace(/^[\\/]+/, ''));
    current = parent;
  }
  return resolve(realpathSync.native(current), ...suffix);
}

function safeRunDirectory(config, runId) {
  requireThat(runIdPattern.test(runId), 'Invalid local evidence run ID', 'blocked-scope');
  const runs = join(stateRoot(config), 'runs');
  const directory = resolve(runs, runId);
  requireThat(dirname(directory) === runs && within(stateRoot(config), directory),
    'Local evidence path escaped the configured state root', 'blocked-scope');
  return directory;
}

function manifestPath(config, runId) {
  return join(safeRunDirectory(config, runId), manifestName);
}

function assertSafeDirectory(path) {
  const metadata = lstatSync(path);
  requireThat(metadata.isDirectory() && !metadata.isSymbolicLink(),
    `Refusing linked or non-directory state path: ${path}`, 'blocked-scope');
}

function ensureSafeDirectory(config, directory) {
  const root = stateRoot(config);
  requireThat(within(root, directory), 'Local evidence directory escaped the configured state root', 'blocked-scope');
  if (!existsSync(root)) mkdirSync(root, { mode: 0o700 });
  assertSafeDirectory(root);
  const parts = relative(root, directory).split(/[\\/]/).filter(Boolean);
  let current = root;
  for (const part of parts) {
    current = join(current, part);
    if (!existsSync(current)) mkdirSync(current, { mode: 0o700 });
    assertSafeDirectory(current);
  }
}

function assertSafeFile(path) {
  const metadata = lstatSync(path);
  requireThat(metadata.isFile() && !metadata.isSymbolicLink() && metadata.nlink === 1,
    `Refusing linked or non-file state path: ${path}`, 'blocked-scope');
}

function readManifest(config, runId) {
  const path = manifestPath(config, runId);
  if (!existsSync(path)) return null;
  ensureSafeDirectory(config, dirname(path));
  assertSafeFile(path);
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  requireThat(manifest.schemaVersion === 1 && manifest.runId === runId &&
    ['active', 'completed', 'blocked'].includes(manifest.state) &&
    typeof manifest.createdAt === 'string' && Array.isArray(manifest.artifacts),
  `Invalid local evidence manifest for ${runId}`, 'invalid-record');
  return manifest;
}

function writeManifest(config, manifest) {
  const path = manifestPath(config, manifest.runId);
  ensureSafeDirectory(config, dirname(path));
  if (existsSync(path)) assertSafeFile(path);
  writeFileSync(path, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
}

function safeArtifactPath(config, runId, relativePath) {
  requireThat(typeof relativePath === 'string' && relativePath.length > 0 &&
    !isAbsolute(relativePath) && !relativePath.includes('\0') &&
    !relativePath.split(/[\\/]/).includes('..'),
  'Local evidence artifact path must be a safe relative path', 'blocked-scope');
  const directory = safeRunDirectory(config, runId);
  const path = resolve(directory, relativePath);
  requireThat(within(directory, path) && path !== directory,
    'Local evidence artifact escaped its run directory', 'blocked-scope');
  requireThat(path !== manifestPath(config, runId),
    'Local evidence artifact cannot replace its manifest', 'blocked-scope');
  return path;
}

export function persistRunArtifact(config, runId, relativePath, content) {
  const path = safeArtifactPath(config, runId, relativePath);
  const body = Buffer.isBuffer(content) ? content : Buffer.from(String(content));
  const manifest = readManifest(config, runId) ?? {
    schemaVersion: 1, runId, state: 'active', createdAt: now(), completedAt: null, artifacts: []
  };
  requireThat(manifest.state === 'active', 'Completed local evidence runs are immutable', 'blocked-reconciliation');
  const entry = {
    path: relative(safeRunDirectory(config, runId), path).replaceAll('\\', '/'),
    bytes: body.byteLength,
    sha256: hash(body),
    createdAt: now()
  };
  const existing = manifest.artifacts.findIndex(artifact => artifact.path === entry.path);
  if (existing >= 0) {
    requireThat(manifest.artifacts[existing].sha256 === entry.sha256 &&
      manifest.artifacts[existing].bytes === entry.bytes,
      'Local evidence artifact identity conflict', 'blocked-reconciliation');
    assertSafeFile(path);
    requireThat(hash(readFileSync(path)) === entry.sha256,
      'Local evidence artifact bytes changed after registration', 'blocked-reconciliation');
  } else {
    ensureSafeDirectory(config, dirname(path));
    requireThat(!existsSync(path), 'Unregistered local evidence artifact already exists', 'blocked-reconciliation');
    writeFileSync(path, body, { mode: 0o600, flag: 'wx' });
    manifest.artifacts.push(entry);
    writeManifest(config, manifest);
  }
  return { ...entry, path };
}

export function completeRunEvidence(config, runId, state = 'completed') {
  requireThat(['completed', 'blocked'].includes(state), 'Invalid local evidence terminal state');
  const manifest = readManifest(config, runId);
  if (!manifest) return null;
  if (manifest.state !== 'active') {
    requireThat(manifest.state === state, 'Local evidence terminal state changed', 'blocked-reconciliation');
    return manifest;
  }
  manifest.state = state;
  manifest.completedAt = now();
  writeManifest(config, manifest);
  return manifest;
}

function inspectTree(path, totals) {
  const metadata = lstatSync(path);
  requireThat(!metadata.isSymbolicLink(), `Refusing to follow linked state path: ${path}`, 'blocked-scope');
  requireThat(metadata.isDirectory() || metadata.nlink === 1,
    `Refusing to prune hard-linked state file: ${path}`, 'blocked-scope');
  if (metadata.isDirectory()) {
    for (const entry of readdirSync(path)) inspectTree(join(path, entry), totals);
  } else {
    totals.files++;
    totals.bytes += metadata.size;
  }
}

export function assertStateDirectoryIgnored(config, cwd = process.cwd()) {
  const root = stateRoot(config);
  let repository;
  try {
    repository = execFileSync('git', ['rev-parse', '--show-toplevel'],
      { cwd, encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  } catch {
    return { checked: false, reason: 'outside-git-repository' };
  }
  if (!within(canonicalPath(repository), canonicalPath(root)))
    return { checked: false, reason: 'outside-git-repository' };
  const candidate = relative(canonicalPath(repository), canonicalPath(root)).replaceAll('\\', '/');
  requireThat(candidate && !candidate.startsWith('..'), 'State root cannot be the repository root', 'blocked-scope');
  try {
    execFileSync('git', ['check-ignore', '--quiet', '--no-index', '--', `${candidate}/`],
      { cwd: repository, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    requireThat(false, `State directory must be gitignored before evidence is stored: ${root}`, 'blocked-scope');
  }
  return { checked: true, ignored: true, path: root };
}

export function pruneState(config, { dryRun = false, nowMs = Date.now() } = {}) {
  const retentionDays = config.statePolicy.rawEvidenceDays;
  requireThat(Number.isInteger(retentionDays) && retentionDays >= 1 && retentionDays <= 7,
    'statePolicy.rawEvidenceDays must be an integer from 1 through 7');
  const root = stateRoot(config);
  const runs = join(root, 'runs');
  const result = {
    stateRoot: root,
    retentionDays,
    dryRun,
    deletedRunIds: [],
    retained: [],
    files: 0,
    bytes: 0
  };
  if (!existsSync(runs)) return result;
  requireThat(!lstatSync(root).isSymbolicLink() && !lstatSync(runs).isSymbolicLink(),
    'State root and runs directory must not be links', 'blocked-scope');
  const cutoff = nowMs - retentionDays * 24 * 60 * 60 * 1000;
  for (const entry of readdirSync(runs, { withFileTypes: true })) {
    requireThat(entry.isDirectory() && !entry.isSymbolicLink(),
      `Unexpected non-directory state entry: ${entry.name}`, 'blocked-scope');
    const runId = entry.name;
    const directory = safeRunDirectory(config, runId);
    const manifest = readManifest(config, runId);
    requireThat(manifest, `Missing local evidence manifest for ${runId}`, 'invalid-record');
    if (manifest.state === 'active') {
      result.retained.push({ runId, reason: 'active-lease' });
      continue;
    }
    const completedAt = Date.parse(manifest.completedAt);
    requireThat(Number.isFinite(completedAt), `Invalid completion time for ${runId}`, 'invalid-record');
    if (completedAt > cutoff) {
      result.retained.push({ runId, reason: 'within-retention-window' });
      continue;
    }
    const totals = { files: 0, bytes: 0 };
    inspectTree(directory, totals);
    result.files += totals.files;
    result.bytes += totals.bytes;
    result.deletedRunIds.push(runId);
    if (!dryRun) rmSync(directory, { recursive: true, force: false, maxRetries: 10, retryDelay: 250 });
  }
  return result;
}
