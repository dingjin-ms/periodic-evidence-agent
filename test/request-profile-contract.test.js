import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { hash, json } from '../src/common.js';
import { requestProfileContract, requestGateMinimumMs, requestProfilePins } from '../src/request-profile-contract.js';
import { admitRequestPhase } from '../src/request-phases.js';
import { ownRequestPhase } from '../src/request-phase-cli.js';

const plan = { version: 2, stages: ['dependencies', 'compile', 'policy', 'test'], testOnlyPrefixes: ['test/'],
  lockfilePaths: ['lock'], buildConfigPaths: ['build'], dependencySnapshotPaths: ['node_modules'], preparedOutputPaths: ['lib'] };
for (const mode of ['staged', 'drift', 'invalid-order', 'profile-command']) test(`request profile contract ${mode}`, t => {
  const root = mkdtempSync(join(tmpdir(), 'profile-contract-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'profile.mjs');
  writeFileSync(path, mode === 'profile-command' ? '// fixed native profile\n' : '// PILOT_VALIDATION_PLAN: ' + json(mode === 'invalid-order' ? { ...plan, stages: ['test', 'compile'] } : plan));
  const gate = { id: 'required', profilePath: path, profileSha256: hash(readFileSync(path)), timeoutMs: 30000 };
  if (mode === 'drift') writeFileSync(path, '// changed');
  if (['drift', 'invalid-order'].includes(mode)) assert.throws(() => requestProfileContract(gate), /changed|Invalid staged/);
  else {
    assert.equal(requestProfileContract(gate).kind, mode === 'staged' ? 'staged' : 'profile-command');
    assert.equal(requestGateMinimumMs({ provisionTimeoutMs: 10000, requestExecution: {} }, gate), mode === 'staged' ? 300000 : 40000);
  }
});
test('canonical declarative gate remains the same hash-bound native runner', () => {
  const path = resolve('scripts/validation/1js-declarative-e2e.cjs');
  const gate = { profile: '1js-declarative-e2e-v1', profilePath: path, profileSha256: hash(readFileSync(path)), timeoutMs: 3600000 };
  const repo = { validationGates: [gate], requestExecution: { preflight: { timeoutMs: 1000 }, phases: {
    scopeApproved: true, approvalRef: 'fixture', expiresAt: new Date(Date.now() + 7200000).toISOString(), foregroundMs: 600000,
    maxTotalMs: 7200000, budgets: { prepare: 130000, author: 60000, commit: 120000, validate: 510000, publish: 240000 } } } };
  assert.equal(requestProfileContract(gate).kind, 'declarative');
  assert.equal(requestProfilePins(repo)[0].sha256, gate.profileSha256);
  assert.throws(() => admitRequestPhase({ limits: { workerMinutes: 1, maxValidationRepairRounds: 0, maxValidationInfrastructureRetries: 0 } }, repo, 'validate-undefined'), /native budgets/);
});

test('real CLI owner refuses stale profile before returning a completed receipt', async t => {
  const root = mkdtempSync(join(tmpdir(), 'profile-cli-')); t.after(() => rmSync(root, { recursive: true, force: true }));
  const profile = join(root, 'profile.mjs'); writeFileSync(profile, '// native');
  const config = JSON.parse(readFileSync('pilot.example.json', 'utf8'));
  config.stateDirectory = join(root, 'state'); config.localFilter = { timeoutMs: 1000 }; config.adoTestRequests = { repoId: 'fixture' };
  config.limits = { ...config.limits, workerMinutes: 1, maxValidationRepairRounds: 0, maxValidationInfrastructureRetries: 0 };
  config.repositories = [{ id: 'fixture', allowedWritePrefixes: ['test'], allowedWriteFiles: [], skillBindings: [], validationGates: [{ id: 'live', profilePath: 'profile.mjs', profileSha256: hash(readFileSync(profile)), timeoutMs: 1000 }],
    requestExecution: { preflight: { timeoutMs: 1000 }, phases: { scopeApproved: true, approvalRef: 'fixture', maxTotalMs: 1200000,
      budgets: { prepare: 130000, author: 60000, commit: 120000, validate: 240000, publish: 240000 },
      foregroundMs: 600000, expiresAt: new Date(Date.now() + 3600000).toISOString() } } }];
  const path = join(root, 'config.json'); writeFileSync(path, json(config)); writeFileSync(profile, '// drift');
  await assert.rejects(ownRequestPhase(['run-test-request', '--id', '123', '--authorize-review', '--config', path]), /profile (changed|hash mismatch)/);
});
