import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { configAt, readJson, requireThat } from './common.js';
import { bootstrapLocalRepository } from './local-settings.js';
import { qualifyRepositorySkill } from './repository-skills.js';

export function repositoriesForSetup(config, requestedRepoIds = []) {
  const requested = [...new Set(requestedRepoIds)];
  const selected = requested.length > 0
    ? requested
    : config.repositories
      .filter(repo => (repo.skillBindings ?? []).length > 0)
      .map(repo => repo.id);
  requireThat(selected.length > 0,
    'No repositories with skill bindings are configured; pass one or more --repo values');
  for (const repoId of selected)
    requireThat(config.repositories.some(repo => repo.id === repoId),
      `Unknown repository ${repoId}`, 'blocked-owner');
  return selected;
}

export async function setupLocalEnvironment({
  settingsPath = 'pilot.local.json',
  templatePath = 'pilot.example.json',
  repoIds = [],
  searchRoots = [],
  cloneRoot = null,
  allowClone = false
}, dependencies = {}) {
  requireThat(Number(process.versions.node.split('.')[0]) >= 24, 'Setup requires Node.js 24 or newer');
  const target = resolve(settingsPath);
  const template = resolve(templatePath);
  const initial = readJson(existsSync(target) ? target : template);
  const selectedRepoIds = repositoriesForSetup(initial, repoIds);
  const bootstrap = dependencies.bootstrapLocalRepository ?? bootstrapLocalRepository;
  const loadConfig = dependencies.configAt ?? configAt;
  const qualify = dependencies.qualifyRepositorySkill ?? qualifyRepositorySkill;
  const repositories = [];

  for (const repoId of selectedRepoIds)
    repositories.push(await bootstrap({
      settingsPath: target, templatePath: template, repoId,
      searchRoots, cloneRoot, allowClone
    }));

  const config = loadConfig(target);
  const qualifications = [];
  for (const repoId of selectedRepoIds) {
    const repo = config.repositories.find(candidate => candidate.id === repoId);
    for (const binding of repo.skillBindings ?? [])
      qualifications.push(await qualify(config, repoId, binding.capability, binding.id));
  }

  return {
    state: 'ready',
    node: process.version,
    settingsPath: target,
    repositories,
    qualifications
  };
}
