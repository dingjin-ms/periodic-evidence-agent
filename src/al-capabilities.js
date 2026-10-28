import { posix } from 'node:path';
import { execFileSync } from 'node:child_process';
import { hash, requireThat } from './common.js';
import { command } from './workers.js';
import { alOwners, alNativeConfig, requireAlPaths, requireAlQualification } from './al-adapter.js';

export function requireAlRepository(repo) {
  requireThat(repo && typeof repo.id === 'string' && repo.id.length > 0 &&
    repo.remote?.replace(/\/$/, '').toLowerCase() === 'https://dev.azure.com/office/iss/_git/augloop-workflows' &&
    /^[a-f0-9]{40}$/.test(repo.baseRef ?? ''),
  'AL routing requires its repository identity and an exact source revision', 'blocked-owner');
}

export function readAlGitBlobs(repo, paths) {
  requireAlRepository(repo);
  requireThat(paths.length > 0 && paths.length <= 16 && paths.every(path => !/[\r\n\0]/.test(path)),
    'AL manifest batch is not bounded', 'blocked-budget');
  const bytes = execFileSync('git', ['cat-file', '--batch'], { cwd: repo.referenceCheckout,
    input: `${paths.map(path => `${repo.baseRef}:${path}`).join('\n')}\n`,
    maxBuffer: 4 * 1024 * 1024, timeout: 120000, windowsHide: true });
  let offset = 0;
  const sources = paths.map(() => {
    const newline = bytes.indexOf(10, offset);
    const header = bytes.subarray(offset, newline).toString('ascii').match(/^[a-f0-9]{40} blob (\d+)$/);
    requireThat(newline >= offset && header, 'AL Git returned an incomplete manifest frame', 'blocked-reconciliation');
    const size = Number(header[1]), start = newline + 1, end = start + size;
    requireThat(Number.isSafeInteger(size) && end < bytes.length && bytes[end] === 10,
      'AL Git manifest frame is truncated', 'blocked-reconciliation');
    offset = end + 1;
    return bytes.subarray(start, end).toString('utf8');
  });
  requireThat(offset === bytes.length, 'AL Git returned unexpected extra manifest data', 'blocked-reconciliation');
  return sources;
}

export function classifyAlOwner(path, manifest, trackedPaths) {
  const owner = alOwners.find(value => value.path === path);
  const scripts = manifest.scripts ?? {};
  const integrationFiles = trackedPaths.filter(file => file.startsWith(`${path}/`) &&
    file.endsWith('.integration.test.ts'));
  const family = scripts.test === 'gulp test' ? 'gulp-mocha' :
    /(?:^|\s)jest(?:\s|$)/.test(scripts.test ?? '') ? 'jest' :
      Object.keys(scripts).some(key => /dotnet/i.test(key)) ? 'dotnet' :
        Object.keys(scripts).some(key => /rust/i.test(key)) ? 'rust' : 'other-or-no-owning-test';
  const supported = Boolean(owner && manifest.name === owner.package &&
    scripts.build === 'gulp build' && scripts.test === owner.testScript &&
    integrationFiles.some(file => file.startsWith(`${owner.path}/${owner.tests}/`)));
  return {
    path, package: manifest.name, family, scripts, integrationFiles,
    workspaceDependencies: Object.entries({ ...manifest.dependencies, ...manifest.devDependencies })
      .filter(([, version]) => typeof version === 'string' && version.startsWith('workspace:'))
      .map(([name]) => name).sort(),
    nativeContractSupported: supported, writeAuthorizedByCurrentScope: supported,
    qualified: false, candidateAccepted: false,
    supportedTestPrefix: supported ? `${owner.path}/${owner.tests}` : null,
    reason: supported ? 'Explicit owner-specific native contract; qualification is a separate requirement' :
      owner ? 'Declared owner native contract or integration test layout changed' :
        'Discovered only: no approved write scope, owner-specific backend or native qualification'
  };
}

export function requireAlCandidateOwner(candidate, repo) {
  requireAlRepository(repo);
  const definition = candidate?.definition;
  const path = definition?.harness?.match(/^([a-zA-Z0-9_.\/-]+)(?:\s|:|;|$)/)?.[1];
  const owner = path && !path.split('/').some(part => ['', '.', '..'].includes(part)) &&
    alOwners.find(owner => path.startsWith(`${owner.path}/${owner.tests}/`));
  requireThat(definition?.repository === repo.id && definition.sourceRevision === repo.baseRef &&
    definition.layer === 'integration' && owner,
  'AL candidate needs a source-bound harness path in a supported owner; no inferred owner routing', 'blocked-owner');
  return owner;
}

export async function discoverAlCapabilities(config, { execute = command, qualification = null, onProgress = () => {} } = {}) {
  requireThat(config.repositories.length === 1, 'AL discovery needs one repository', 'blocked-owner');
  const repo = config.repositories[0];
  requireAlRepository(repo);
  const git = args => execute('git', ['--no-pager', ...args], repo.referenceCheckout);
  requireThat((await git(['rev-parse', 'HEAD'])).stdout.trim() === repo.baseRef &&
    !(await git(['status', '--porcelain'])).stdout.trim(),
  'AL discovery requires a clean checkout at the pinned revision', 'blocked-reconciliation');
  const paths = (await git(['-c', 'core.quotepath=false', 'ls-files', '--',
    '*package.json', '*.integration.test.ts', '*.csproj', '*Cargo.toml'])).stdout.trim().split(/\r?\n/);
  const rootSource = (await git(['show', `${repo.baseRef}:package.json`])).stdout;
  const patterns = JSON.parse(rootSource).workspaces;
  requireThat(Array.isArray(patterns) && patterns.every(pattern =>
    typeof pattern === 'string' && !pattern.startsWith('!') && !pattern.includes('\\')),
  'Unsupported AL workspace discovery contract', 'blocked-config');
  const owners = [];
  const manifests = paths.filter(path => path.endsWith('/package.json') &&
    patterns.some(pattern => posix.matchesGlob(posix.dirname(path), pattern)));
  onProgress({ phase: 'manifest-reading', completed: 0, total: manifests.length });
  for (let offset = 0; offset < manifests.length; offset += 16) {
    const batch = manifests.slice(offset, offset + 16);
    const sources = execute === command ? readAlGitBlobs(repo, batch) : [];
    for (const [index, path] of batch.entries()) {
      const source = execute === command ? sources[index] : (await git(['show', `${repo.baseRef}:${path}`])).stdout;
      owners.push({ ...classifyAlOwner(posix.dirname(path), JSON.parse(source), paths),
        manifest: { path, sha256: hash(source) } });
    }
    onProgress({ phase: 'manifest-reading', completed: owners.length, total: manifests.length });
  }
  requireThat(alOwners.every(owner => owners.some(entry =>
    entry.path === owner.path && entry.nativeContractSupported)),
  'AL minimum proving owners are missing or changed; qualification cannot be inherited', 'blocked-config');
  if (qualification) {
    const expected = alNativeConfig(config, config.stateDirectory, 'candidate').repositories[0];
    requireAlQualification(qualification, expected);
    for (const owner of owners.filter(owner => owner.nativeContractSupported)) owner.qualified = true;
  }
  return {
    format: 'al-owner-capabilities-v1', repoId: repo.id, remote: repo.remote, revision: repo.baseRef,
    workspaceContract: { path: 'package.json', sha256: hash(rootSource), patterns },
    owners,
    otherNativeProjects: paths.filter(path => path.endsWith('.csproj') || path === 'Cargo.toml' || path.endsWith('/Cargo.toml'))
      .map(path => ({ path, nativeContractSupported: false, writeAuthorizedByCurrentScope: false,
        qualified: false, reason: 'Requires a separate native toolchain/profile and explicit authorization' })),
    executionEnabled: false,
    qualification: qualification ? { config: qualification.config, artifact: qualification.artifact } : null
  };
}

export function routeAlCandidate(matrix, repo, paths) {
  requireAlRepository(repo);
  requireThat(matrix.format === 'al-owner-capabilities-v1' && matrix.repoId === repo.id &&
    matrix.remote === repo.remote && matrix.revision === repo.baseRef,
  'AL capability matrix belongs to another repository or revision', 'blocked-owner');
  requireAlPaths(paths);
  return [...new Set(paths.map(path => {
    const owner = matrix.owners.find(owner => owner.supportedTestPrefix &&
      path.startsWith(`${owner.supportedTestPrefix}/`));
    requireThat(owner?.nativeContractSupported && owner.writeAuthorizedByCurrentScope && owner.qualified,
      `AL owner has no qualified authorized backend: ${path}`, 'blocked-qualification');
    return owner.path;
  }))];
}
