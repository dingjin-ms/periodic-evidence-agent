import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bootstrapLocalRepository } from '../src/local-settings.js';

function git(args, cwd) {
  return execFileSync('git', [
    '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args
  ], { cwd, encoding: 'utf8', windowsHide: true });
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'local-settings-'));
  const seed = join(root, 'seed');
  const remote = join(root, 'OfficeAgent.git');
  mkdirSync(seed);
  git(['init', '--initial-branch=main'], seed);
  writeFileSync(join(seed, 'README.md'), '# fixture\n');
  git(['add', 'README.md'], seed);
  git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '-m', 'Initial'], seed);
  git(['init', '--bare', remote], root);
  git(['remote', 'add', 'origin', remote], seed);
  git(['push', '-u', 'origin', 'main'], seed);
  git(['--git-dir', remote, 'symbolic-ref', 'HEAD', 'refs/heads/main'], root);
  const template = join(root, 'pilot.example.json');
  writeFileSync(template, `${JSON.stringify({
    version: 1,
    repositories: [{
      id: 'office-agent', referenceCheckout: null, baseRef: null, remote
    }]
  }, null, 2)}\n`);
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return { root, seed, remote, template };
}

test('bootstrap reuses an existing configured checkout without cloning', async t => {
  const { root, seed, remote } = fixture(t);
  const settingsPath = join(root, 'pilot.local.json');
  writeFileSync(settingsPath, `${JSON.stringify({
    version: 1,
    repositories: [{ id: 'office-agent', referenceCheckout: seed, baseRef: 'main', remote }]
  }, null, 2)}\n`);

  const result = await bootstrapLocalRepository({ settingsPath, repoId: 'office-agent' });

  assert.equal(result.source, 'configured');
  assert.equal(realpathSync.native(result.referenceCheckout), realpathSync.native(seed));
  assert.equal(result.cloned, false);
});

test('bootstrap discovers a matching checkout and persists only local settings', async t => {
  const { root, remote, template } = fixture(t);
  const searchRoot = join(root, 'checkouts');
  const checkout = join(searchRoot, 'OfficeAgent');
  mkdirSync(searchRoot);
  git(['clone', remote, checkout], root);
  const settingsPath = join(root, 'pilot.local.json');

  const result = await bootstrapLocalRepository({
    settingsPath, templatePath: template, repoId: 'office-agent', searchRoots: [searchRoot]
  });
  const saved = JSON.parse(readFileSync(settingsPath, 'utf8'));

  assert.equal(result.source, 'discovered');
  assert.equal(realpathSync.native(saved.repositories[0].referenceCheckout), realpathSync.native(checkout));
  assert.equal(saved.repositories[0].baseRef, 'main');
});

test('bootstrap clones when no matching checkout exists', async t => {
  const { root, template } = fixture(t);
  const settingsPath = join(root, 'pilot.local.json');
  const cloneRoot = join(root, 'new-checkouts');

  const result = await bootstrapLocalRepository({
    settingsPath, templatePath: template, repoId: 'office-agent',
    searchRoots: [join(root, 'empty')], cloneRoot
  });

  assert.equal(result.source, 'cloned');
  assert.equal(result.cloned, true);
  assert.equal(existsSync(join(result.referenceCheckout, '.git')), true);
  assert.equal(JSON.parse(readFileSync(settingsPath, 'utf8'))
    .repositories[0].referenceCheckout, result.referenceCheckout);
});

test('bootstrap blocks an implicit clone when discovery finds no checkout', async t => {
  const { root, template } = fixture(t);
  await assert.rejects(bootstrapLocalRepository({
    settingsPath: join(root, 'pilot.local.json'),
    templatePath: template,
    repoId: 'office-agent',
    searchRoots: [join(root, 'empty')],
    cloneRoot: join(root, 'new-checkouts'),
    allowClone: false
  }), /rerun setup with --allow-clone/);
  assert.equal(existsSync(join(root, 'pilot.local.json')), false);
});

test('bootstrap refuses a settings filename that could be committed', async t => {
  const { root, template } = fixture(t);
  await assert.rejects(bootstrapLocalRepository({
    settingsPath: join(root, 'pilot.json'), templatePath: template, repoId: 'office-agent'
  }), /must use a \*\.local\.json filename/);
});
