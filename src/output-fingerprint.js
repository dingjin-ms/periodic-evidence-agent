import {
  closeSync, existsSync, lstatSync, openSync, readFileSync, readdirSync,
  readlinkSync, readSync, realpathSync
} from 'node:fs';
import { createHash } from 'node:crypto';
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { hash, json } from './common.js';

const FILE_HASH_BUFFER = Buffer.allocUnsafe(1024 * 1024);

function fileSha256(path, size) {
  if (size <= FILE_HASH_BUFFER.length) return hash(readFileSync(path));
  const digest = createHash('sha256');
  const handle = openSync(path, 'r');
  try {
    let bytesRead;
    while ((bytesRead = readSync(handle, FILE_HASH_BUFFER, 0,
      FILE_HASH_BUFFER.length, null)) > 0)
      digest.update(FILE_HASH_BUFFER.subarray(0, bytesRead));
  } finally {
    closeSync(handle);
  }
  return digest.digest('hex');
}

export function fileContentSha256(path) {
  return fileSha256(path, lstatSync(path).size);
}

function pathFingerprint(root, path) {
  const target = join(root, path);
  if (!existsSync(target)) return null;
  const info = lstatSync(target);
  if (info.isSymbolicLink()) {
    const rawTarget = readlinkSync(target);
    const resolvedTarget = resolve(dirname(target), rawTarget);
    const rootRelative = relative(root, resolvedTarget);
    return {
      path, type: 'link',
      target: !rootRelative.startsWith('..') && !isAbsolute(rootRelative)
        ? { rootRelative } : { external: rawTarget }
    };
  }
  if (info.isFile())
    return { path, type: 'file', sha256: fileSha256(target, info.size) };
  if (!info.isDirectory()) return null;
  const entries = [];
  for (const name of readdirSync(target).sort()) {
    const entry = pathFingerprint(root, join(path, name));
    if (!entry) return null;
    entries.push(entry);
  }
  return { path, type: 'directory', entries };
}

function dependencyNodeFingerprint(workspace, physicalWorkspace, entryPath, name) {
  const info = lstatSync(entryPath);
  if (info.isSymbolicLink()) {
    const resolvedTarget = resolve(dirname(entryPath), readlinkSync(entryPath));
    const rootRelative = relative(workspace, resolvedTarget);
    if (rootRelative.startsWith('..') || isAbsolute(rootRelative) ||
      !existsSync(resolvedTarget)) return null;
    let finalTarget;
    try { finalTarget = realpathSync.native(entryPath); }
    catch { return null; }
    const finalRootRelative = relative(physicalWorkspace, finalTarget);
    if (finalRootRelative.startsWith('..') || isAbsolute(finalRootRelative))
      return null;
    return {
      name, type: 'link',
      target: rootRelative.replaceAll('\\', '/'),
      resolvedTarget: finalRootRelative.replaceAll('\\', '/')
    };
  }
  if (info.isFile())
    return { name, type: 'file', size: info.size, sha256: fileSha256(entryPath, info.size) };
  if (!info.isDirectory()) return null;
  const entries = [];
  for (const entry of readdirSync(entryPath, { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const value = dependencyNodeFingerprint(workspace, physicalWorkspace,
      join(entryPath, entry.name), entry.name);
    if (!value) return null;
    entries.push(value);
  }
  return { name, type: 'directory', sha256: hash(json(entries)) };
}

export function dependencyEntryFingerprint(workspace, dependencyPath, entryPath) {
  const dependencyDirectory = resolve(workspace, dependencyPath);
  const target = resolve(dependencyDirectory, entryPath);
  const bounded = relative(dependencyDirectory, target);
  if (!bounded || bounded.startsWith('..') || isAbsolute(bounded) ||
    !existsSync(target)) return null;
  return dependencyNodeFingerprint(workspace, realpathSync.native(workspace),
    target, basename(target));
}

export function dependencyOutputFingerprint(path, entries) {
  const state = entries.find(entry => entry.name === '.yarn-state.yml' &&
    entry.type === 'file');
  return {
    path, type: 'dependency-directory', fingerprintVersion: 2,
    stateSha256: state?.sha256 ?? null,
    manifestSha256: hash(json(entries))
  };
}

function dependencyDirectoryFingerprint(workspace, directory, path) {
  const physicalWorkspace = realpathSync.native(workspace);
  const entries = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })
    .sort((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)) {
    const value = dependencyNodeFingerprint(workspace, physicalWorkspace,
      join(directory, entry.name), entry.name);
    if (!value) return null;
    entries.push(value);
  }
  return dependencyOutputFingerprint(path, entries);
}

export function outputPathFingerprint(workspace, path) {
  const target = join(workspace, path);
  if (!existsSync(target) || !lstatSync(target).isDirectory() ||
    !path.replaceAll('\\', '/').endsWith('node_modules'))
    return pathFingerprint(workspace, path);
  return dependencyDirectoryFingerprint(workspace, target, path);
}
