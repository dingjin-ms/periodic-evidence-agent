import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { resolve } from 'node:path';
import { configAt, now } from '../src/common.js';
import { advanceLocalE2E } from '../src/local-e2e.js';

const request = () => ({
  format: 'local-e2e-v1', runId: 'synthetic',
  filter: { manifestPath: resolve('synthetic-manifest.json'), manifestSha256: '0'.repeat(64) },
  routing: { capability: 'integration-test-authoring' },
  authorization: { approvedBy: 'synthetic', approvedAt: now(), approvalRef: 'synthetic-only',
    deadlineAt: new Date(Date.now() + 60000).toISOString(),
    maxFilterRequests: 3, maxProposers: 1, maxProposerAiCredits: 30,
    authorizeCommit: true, authorizePush: true, authorizeDraftPR: true }
});
test('local E2E validates explicit mode, scheduling, bounds and secret-free input before state or model access', async () => {
  const config = configAt('pilot.example.json');
  Object.assign(config, { executionMode: 'standalone-sdk', filterExecutor: 'local-sdk',
    localFilter: { maxRequests: 3, maxToolCalls: 5, timeoutMs: 10000 } });
  config.statePolicy.accessApproved = true;
  config.schedule.enabled = false;
  const changes = [
    [(c, input) => { input.runId = '..\\outside'; }, /safe run ID/],
    [c => { c.executionMode = 'app-native'; }, /standalone-sdk/],
    [c => { c.schedule.enabled = true; }, /scheduling disabled/],
    [c => { c.statePolicy.accessApproved = false; }, /approved standalone-sdk state/],
    [c => { c.localFilter.maxRequests = 4; }, /ledger-wide FILTER/],
    [(c, input) => { input.authorization.maxProposers = 2; }, /single-proposer/],
    [(c, input) => { input.authorization.approvedAt = new Date(Date.now() + 120000).toISOString(); },
      /authorization interval/],
    [(c, input) => { input.authorization.approvalRef = 'Bearer synthetic-secret'; }, /Credential-shaped/]
  ];
  for (const [mutate, expected] of changes) {
    const c = structuredClone(config), input = request();
    mutate(c, input);
    await assert.rejects(advanceLocalE2E(c, {}, input, { filter: true,
      filterDependencies: { connect: () => assert.fail('Invalid input cannot reach a model') } }), expected);
  }
});
test('local E2E CLI rejects missing, conflicting and unknown authorization controls before opening state', () => {
  const cases = [
    ['local-e2e', '--filter'],
    ['local-e2e', '--file', 'missing', '--config', 'missing'],
    ['local-e2e', '--filter', '--check', '--file', 'missing', '--config', 'missing'],
    ['local-e2e', '--execute', '--file', 'missing', '--config', 'missing'],
    ['local-e2e', '--check', '--resume-auth', '--file', 'missing', '--config', 'missing'],
    ['local-e2e', '--filter', '--unknown', '--file', 'missing', '--config', 'missing'],
    ['local-e2e', '--check', '--config', 'missing', '--config', 'other', '--file', 'missing'],
    ['agent', 'filter', 'local-e2e', '--execute'],
    ['agent', 'collector', 'local-e2e', '--filter'],
    ['filter-local-retry-prepare', '--file', 'missing']
  ];
  for (const args of cases) {
    const child = spawnSync(process.execPath, ['src/cli.js', ...args], {
      encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' }
    });
    assert.notEqual(child.status, 0, args.join(' '));
    assert.doesNotMatch(child.stderr, /ENOENT|SQLITE/);
    assert.match(child.stderr, /blocked-authorization|blocked-agent/);
  }
});
