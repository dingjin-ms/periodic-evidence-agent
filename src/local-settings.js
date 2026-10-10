import {
  copyFileSync, existsSync, mkdirSync, readdirSync, renameSync, rmSync, statSync, writeFileSync
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { readJson, requireThat } from './common.js';

const exec = promisify(execFile);

async function execute(executable, args, cwd = process.cwd()) {
  return exec(executable, args, {
    cwd, windowsHide: true, timeout: 120000, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8'
  });
}

function normalizedRemote(remote) {
  return remote.trim().replace(/\\/g, '/').replace(/\/$/, '').replace(/\.git$/i, '').toLowerCase();
}

function localSettingsPath(path) {
  const target = resolve(path);
  requireThat(basename(target).toLowerCase().endsWith('.local.json'),
    'Local settings must use a *.local.json filename', 'blocked-scope');
  return target;
}

function defaultSearchRoots() {
  const home = homedir();
  return [
    join(home, 'Repos'),
    join(home, 'src'),
    join(home, 'source', 'repos'),
    ...(process.platform === 'win32' ? ['C:\\src'] : [])
  ];
}

function repositoryCandidates(roots) {
  const candidates = [];
  const seen = new Set();
  for (const root of roots.map(value => resolve(value))) {
    if (!existsSync(root) || !statSync(root).isDirectory()) continue;
    for (const path of [root, ...readdirSync(root, { withFileTypes: true })
      .filter(entry => entry.isDirectory())
      .map(entry => join(root, entry.name))]) {
      const key = path.toLowerCase();
      if (!seen.has(key)) {
        seen.add(key);
        candidates.push(path);
      }
    }
  }
  return candidates;
}

async function inspectCheckout(path, expectedRemote, runCommand) {
  if (!existsSync(path)) return null;
  try {
    const topLevel = (await runCommand('git', ['-C', path, 'rev-parse', '--show-toplevel'])).stdout.trim();
    const remote = (await runCommand('git', ['-C', topLevel, 'remote', 'get-url', 'origin'])).stdout.trim();
    if (normalizedRemote(remote) !== normalizedRemote(expectedRemote)) return null;
    let baseRef = null;
    try {
      const symbolic = (await runCommand('git',
        ['-C', topLevel, 'symbolic-ref', '--short', 'refs/remotes/origin/HEAD'])).stdout.trim();
      baseRef = symbolic.replace(/^origin\//, '') || null;
    } catch {
      // A missing origin/HEAD is reported to the caller instead of guessed from a feature branch.
    }
    const gitMarker = join(topLevel, '.git');
    return {
      path: resolve(topLevel), remote, baseRef,
      linkedWorktree: existsSync(gitMarker) && statSync(gitMarker).isFile()
    };
  } catch {
    return null;
  }
}

function writeJsonAtomic(path, value) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function cloneName(remote, repoId) {
  const match = remote.replace(/\\/g, '/').replace(/\/$/, '').match(/\/([^/]+?)(?:\.git)?$/);
  return match?.[1] || repoId;
}

export async function bootstrapLocalRepository({
  settingsPath,
  templatePath = 'pilot.example.json',
  repoId,
  searchRoots = [],
  cloneRoot = null,
  runCommand = execute
}) {
  requireThat(repoId, 'bootstrap-repo requires a repository ID');
  const target = localSettingsPath(settingsPath);
  const createdSettings = !existsSync(target);
  if (createdSettings) {
    const template = resolve(templatePath);
    requireThat(existsSync(template), `Local settings template does not exist: ${template}`);
    mkdirSync(dirname(target), { recursive: true });
    copyFileSync(template, target, 0);
  }

  try {
    const config = readJson(target);
    const repo = config.repositories?.find(candidate => candidate.id === repoId);
    requireThat(repo, `Unknown repository ${repoId}`, 'blocked-owner');
    requireThat(typeof repo.remote === 'string' && repo.remote.length > 0,
      `Repository ${repoId} needs a configured remote`);

    if (repo.referenceCheckout) {
      const configured = await inspectCheckout(repo.referenceCheckout, repo.remote, runCommand);
      requireThat(configured,
        `Configured checkout for ${repoId} is missing, is not Git, or has a different origin`, 'blocked-scope');
      if (!repo.baseRef && configured.baseRef) {
        repo.baseRef = configured.baseRef;
        writeJsonAtomic(target, config);
      }
      return {
        repoId, settingsPath: target, referenceCheckout: configured.path,
        baseRef: repo.baseRef ?? configured.baseRef, source: 'configured', cloned: false
      };
    }

    const roots = [...searchRoots, ...defaultSearchRoots()];
    const discoveries = [];
    for (const candidate of repositoryCandidates(roots)) {
      const discovered = await inspectCheckout(candidate, repo.remote, runCommand);
      if (discovered) discoveries.push(discovered);
    }
    discoveries.sort((left, right) => {
      const expectedName = cloneName(repo.remote, repo.id).toLowerCase();
      const leftName = basename(left.path).toLowerCase() === expectedName ? 0 : 1;
      const rightName = basename(right.path).toLowerCase() === expectedName ? 0 : 1;
      return leftName - rightName ||
        Number(left.linkedWorktree) - Number(right.linkedWorktree) ||
        left.path.localeCompare(right.path);
    });
    if (discoveries.length > 0) {
      const discovered = discoveries[0];
      repo.referenceCheckout = discovered.path;
      if (!repo.baseRef && discovered.baseRef) repo.baseRef = discovered.baseRef;
      writeJsonAtomic(target, config);
      return {
        repoId, settingsPath: target, referenceCheckout: discovered.path,
        baseRef: repo.baseRef, source: 'discovered', cloned: false
      };
    }

    const destinationRoot = resolve(cloneRoot ?? join(homedir(), 'Repos'));
    const destination = join(destinationRoot, cloneName(repo.remote, repo.id));
    requireThat(!existsSync(destination),
      `Clone destination already exists but does not match ${repo.remote}: ${destination}`, 'blocked-scope');
    mkdirSync(destinationRoot, { recursive: true });
    await runCommand('git', ['clone', '--origin', 'origin', '--', repo.remote, destination], destinationRoot);
    const cloned = await inspectCheckout(destination, repo.remote, runCommand);
    requireThat(cloned, `Cloned repository ${repoId} could not be verified`, 'blocked-scope');
    repo.referenceCheckout = cloned.path;
    if (!repo.baseRef && cloned.baseRef) repo.baseRef = cloned.baseRef;
    writeJsonAtomic(target, config);
    return {
      repoId, settingsPath: target, referenceCheckout: cloned.path,
      baseRef: repo.baseRef, source: 'cloned', cloned: true
    };
  } catch (error) {
    if (createdSettings) rmSync(target, { force: true });
    throw error;
  }
}
