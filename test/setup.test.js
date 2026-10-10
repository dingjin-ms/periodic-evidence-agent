import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { repositoriesForSetup, setupLocalEnvironment } from '../src/setup.js';

function config() {
  return {
    version: 1,
    repositories: [
      {
        id: 'office-agent',
        skillBindings: [
          { id: 'oa-tests', capability: 'integration-test-authoring' }
        ]
      },
      {
        id: 'omr',
        skillBindings: [
          { id: 'omr-tests', capability: 'test-authoring' },
          { id: 'omr-investigation', capability: 'failure-investigation' }
        ]
      },
      { id: 'reference-only', skillBindings: [] }
    ]
  };
}

test('setup selects every skill-backed repository without product-specific code', () => {
  assert.deepEqual(repositoriesForSetup(config()), ['office-agent', 'omr']);
  assert.deepEqual(repositoriesForSetup(config(), ['reference-only', 'omr']),
    ['reference-only', 'omr']);
});

test('setup bootstraps selected repositories and qualifies every declared binding', async t => {
  const root = mkdtempSync(join(tmpdir(), 'multi-repo-setup-'));
  const templatePath = join(root, 'pilot.example.json');
  const settingsPath = join(root, 'pilot.local.json');
  const configured = config();
  writeFileSync(templatePath, `${JSON.stringify(configured, null, 2)}\n`);
  const bootstrapped = [];
  const qualified = [];
  t.after(() => rmSync(root, { recursive: true, force: true }));

  const result = await setupLocalEnvironment({
    settingsPath, templatePath, allowClone: true
  }, {
    bootstrapLocalRepository: async options => {
      bootstrapped.push(options);
      if (!bootstrapped.slice(0, -1).length)
        writeFileSync(settingsPath, `${JSON.stringify(configured, null, 2)}\n`);
      return {
        repoId: options.repoId, referenceCheckout: join(root, options.repoId),
        baseRef: 'main', source: 'discovered', cloned: false
      };
    },
    configAt: () => configured,
    qualifyRepositorySkill: async (_config, repoId, capability, bindingId) => {
      qualified.push({ repoId, capability, bindingId });
      return { repoId, capability, bindingId, state: 'qualified-read-only' };
    }
  });

  assert.equal(result.state, 'ready');
  assert.equal(result.settingsPath, resolve(settingsPath));
  assert.deepEqual(bootstrapped.map(call => call.repoId), ['office-agent', 'omr']);
  assert.equal(bootstrapped.every(call => call.allowClone === true), true);
  assert.deepEqual(qualified, [
    { repoId: 'office-agent', capability: 'integration-test-authoring', bindingId: 'oa-tests' },
    { repoId: 'omr', capability: 'test-authoring', bindingId: 'omr-tests' },
    { repoId: 'omr', capability: 'failure-investigation', bindingId: 'omr-investigation' }
  ]);
  assert.equal(result.qualifications.length, 3);
});

test('setup rejects an unknown explicitly requested repository', async t => {
  const root = mkdtempSync(join(tmpdir(), 'multi-repo-setup-'));
  const templatePath = join(root, 'pilot.example.json');
  writeFileSync(templatePath, `${JSON.stringify(config(), null, 2)}\n`);
  t.after(() => rmSync(root, { recursive: true, force: true }));

  await assert.rejects(setupLocalEnvironment({
    settingsPath: join(root, 'pilot.local.json'),
    templatePath,
    repoIds: ['missing']
  }), /Unknown repository missing/);
});
