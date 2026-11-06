import { readFileSync, realpathSync, statSync, readdirSync, existsSync } from 'node:fs';
import { isAbsolute, join, relative, dirname } from 'node:path';
import { createRequire } from 'node:module';
import { hash, requireThat } from './common.js';

// Capture only explicitly approved local inputs. This is a manifest builder, not a
// qualification issuer: its caller must supply source/runtime/lock evidence.
export function captureLocalToolFiles(entries, allowedRoots, { maxFiles = 100000, maxBytes = 536870912, timeoutMs = 120000 } = {}) {
  const roots = allowedRoots.map(path => realpathSync(path));
  const files = [], links = [], directories = new Map();
  let bytes = 0;
  const deadline = Date.now() + timeoutMs;
  const visit = (source, path, packageRoot = false) => {
    requireThat(Date.now() < deadline && files.length < maxFiles, 'Local tool capture budget exhausted', 'blocked-budget');
    const actual = realpathSync(source);
    requireThat(roots.some(root => { const rel = relative(root, actual); return rel === '' || !rel.startsWith('..') && !isAbsolute(rel); }),
      'Local tool input escapes approved cache/source roots', 'blocked-scope');
    const stat = statSync(actual);
    if (stat.isDirectory()) {
      if (directories.has(actual)) { links.push({ path, target: directories.get(actual), directory: true }); return; }
      directories.set(actual, path);
      const children = readdirSync(actual).sort();
      for (const name of children) visit(join(actual, name), path + '/' + name);
      if (packageRoot && children.includes('package.json')) {
        const pkg = JSON.parse(readFileSync(join(actual, 'package.json')));
        const require = createRequire(join(actual, 'package.json'));
        for (const name of Object.keys(pkg.dependencies ?? {})) {
          if (existsSync(join(actual, 'node_modules', name))) continue;
          let owner;
          try { owner = dirname(require.resolve(name + '/package.json')); }
          catch {
            owner = dirname(require.resolve(name));
            while (!existsSync(join(owner, 'package.json')) && dirname(owner) !== owner) owner = dirname(owner);
          }
          requireThat(JSON.parse(readFileSync(join(owner, 'package.json'))).name === name,
            'Dependency resolution did not identify its package owner', 'blocked-config');
          visit(owner, path + '/node_modules/' + name, true);
        }
      }
    } else {
      requireThat(stat.isFile(), 'Local tool input is not a regular file', 'blocked-scope');
      const data = readFileSync(actual); bytes += data.length;
      requireThat(bytes <= maxBytes, 'Local tool capture byte budget exhausted', 'blocked-budget');
      files.push({ path, source: actual, sha256: hash(data), mode: (stat.mode & 0o111) ? 0o755 : 0o644 });
    }
  };
  for (const entry of entries) visit(entry.source, entry.path, entry.packageRoot === true);
  return { files, links, bytes };
}
