import {
  existsSync, lstatSync, readFileSync, readdirSync, readlinkSync
} from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { hash } from './common.js';

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
    return { path, type: 'file', sha256: hash(readFileSync(target)) };
  if (!info.isDirectory()) return null;
  const entries = [];
  for (const name of readdirSync(target).sort()) {
    const entry = pathFingerprint(root, join(path, name));
    if (!entry) return null;
    entries.push(entry);
  }
  return { path, type: 'directory', entries };
}

export function outputPathFingerprint(workspace, path) {
  const target = join(workspace, path);
  if (!existsSync(target) || !lstatSync(target).isDirectory() ||
    !path.replaceAll('\\', '/').endsWith('node_modules'))
    return pathFingerprint(workspace, path);
  const links = [];
  const visit = (directory, relativePath) => {
    for (const entry of readdirSync(directory, { withFileTypes: true })
      .sort((left, right) => left.name.localeCompare(right.name))) {
      const entryPath = join(directory, entry.name);
      const entryRelative = join(relativePath, entry.name);
      if (entry.isSymbolicLink()) {
        const resolvedTarget = resolve(dirname(entryPath), readlinkSync(entryPath));
        const rootRelative = relative(workspace, resolvedTarget);
        if (rootRelative.startsWith('..') || isAbsolute(rootRelative) ||
          !existsSync(resolvedTarget)) return false;
        links.push({
          path: entryRelative.replaceAll('\\', '/'),
          target: rootRelative.replaceAll('\\', '/')
        });
      } else if (entry.isDirectory() && visit(entryPath, entryRelative) === false) return false;
    }
    return true;
  };
  if (visit(target, path) === false) return null;
  const statePath = join(target, '.yarn-state.yml');
  return {
    path, type: 'dependency-directory',
    stateSha256: existsSync(statePath) ? hash(readFileSync(statePath)) : null,
    links
  };
}
