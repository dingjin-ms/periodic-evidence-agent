import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { alReference } from '../src/al-adapter.js';
import { pinnedInput, requireAlFilter, requireAlModelAllocation, requireRetainedAlResults, runAlWorkflow,
  alAuthoringSkillPath, alWorkflowNativeConfig } from '../src/al-workflow.js';
import { repositoryValidationContract } from '../src/repository-skills.js';
import { Ledger } from '../src/ledger.js';
import { configAt } from '../src/common.js';

test('AL workflow reads exact original inputs and rejects changed content', t => {
  const root = mkdtempSync(join(tmpdir(), 'al-workflow-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'input.json');
  writeFileSync(file, '{"synthetic":true}\n');
  const ref = alReference(file);
  assert.deepEqual(pinnedInput(ref), { synthetic: true });
  writeFileSync(file, '{"synthetic":"changed"}\n');
  assert.throws(() => pinnedInput(ref), /explicit content pin/);
  assert.throws(() => pinnedInput({ path: 'relative.json', sha256: 'a'.repeat(64) }), /content pin/);
});
test('AL retained batches require original completed native receipts, not supplied result metadata alone', t => {
  const root = mkdtempSync(join(tmpdir(), 'al-retained-filter-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const file = join(root, 'result.json');
  writeFileSync(file, '{"batchId":"synthetic-batch"}\n');
  const reference = alReference(file);
  const completed = { batchId: 'synthetic-batch', state: 'completed', analysisPassed: true,
    resultSha256: reference.sha256 };
  assert.equal(requireRetainedAlResults([reference], { batches: [completed] }).size, 1);
  for (const batch of [{ ...completed, state: 'blocked' }, { ...completed, analysisPassed: false },
    { ...completed, resultSha256: 'a'.repeat(64) }, { ...completed, batchId: 'different' }])
    assert.throws(() => requireRetainedAlResults([reference], { batches: [batch] }), /independently reconciled/);
  assert.throws(() => requireRetainedAlResults([reference, reference], { batches: [completed] }), /uniquely/);
});
test('AL FILTER cannot consume the external Proposer skill or narrow discovery scope', () => {
  const config = { filterExecutor: 'local-sdk', filterBatching: { mode: 'verified' },
    repositories: [{ skillBindings: [{ skillPath: '.github/skills/tests/SKILL.md' }] }] };
  const manifest = { request: { instructions: 'Only Config Resolver' } };
  assert.throws(() => requireAlFilter(config, manifest), /all four discovery scopes/);
  const external = structuredClone(config);
  external.repositories[0].skillBindings[0].externalBundle = { synthetic: true };
  assert.throws(() => requireAlFilter(external, manifest), /never an external skill namespace/);
  for (const path of ['unmerged/SKILL.md', alAuthoringSkillPath]) {
    const unknownGuidance = structuredClone(config);
    unknownGuidance.repositories[0].skillBindings[0].skillPath = path;
    assert.throws(() => requireAlFilter(unknownGuidance, manifest), /native-main testing guidance/);
  }
  assert.throws(() => requireAlFilter({ ...config, filterBatching: { mode: 'estimated' } }, manifest), /verified local execution/);
});
test('AL model allocations are explicit, expiring, purpose-bound and cannot exceed global remaining sessions', () => {
  const root = process.cwd();
  const approval = { format: 'al-e2e-model-allocation-v1', approvedBy: 'parent',
    repoId: 'augloop-workflows', baseRevision: 'a'.repeat(40), allowPublication: false,
    model: 'gpt-6-luna', runDirectory: root, maxTotalSessions: 30, priorActualSessions: 12,
    maxAdditionalSessions: 3, purposes: ['filter'], deadlineAt: new Date(Date.now() + 60000).toISOString() };
  assert.doesNotThrow(() => requireAlModelAllocation(approval, root, 3, 'filter'));
  for (const invalid of [
    { ...approval, approvedBy: 'self' }, { ...approval, model: 'other' },
    { ...approval, runDirectory: 'different-run' }, { ...approval, maxAdditionalSessions: 19 },
    { ...approval, maxAdditionalSessions: 2 }, { ...approval, priorActualSessions: 12.5 },
    { ...approval, priorActualSessions: '12' }, { ...approval, purposes: ['proposer'] },
    { ...approval, repoId: '' }, { ...approval, baseRevision: 'HEAD' },
    { ...approval, deadlineAt: '2000-01-01T00:00:00Z' }, { ...approval, maxTotalSessions: 31 }
  ]) assert.throws(() => requireAlModelAllocation(invalid, root, 3, 'filter'), /parent-coordinated/);
});
test('real AL template normalization accepts SDK and rejects other providers before allocation or dispatch', async t => {
  const root = mkdtempSync(join(tmpdir(), 'al-sdk-provider-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const original = JSON.parse(readFileSync('pilot.example.json', 'utf8'));
  const repo = JSON.parse(readFileSync('scaffold/augloop.repository.example.json', 'utf8'));
  repo.referenceCheckout = root;
  repo.baseRef = 'a'.repeat(40);
  repo.commitIdentity = { name: 'Synthetic', email: 'synthetic@example.invalid' };
  repo.validationGates = [{ executable: process.execPath }];
  original.repositories = [repo];
  original.stateDirectory = join(root, 'state');
  original.limits.maxAiCreditsPerSession = 30;
  original.authoringProviders = {
    'agency-local': { type: 'agency-local', executable: process.execPath, profile: 'synthetic' },
    'agency-remote': { type: 'agency-remote', executable: process.execPath }
  };
  const qualification = join(root, 'qualification.json');
  writeFileSync(qualification, '{}');
  for (const provider of ['copilot-sdk', 'agency-local', 'agency-remote', 'unknown']) {
    const raw = structuredClone(original);
    raw.repositories[0].skillBindings[0].authoringProvider = provider;
    const path = join(root, `${provider}.json`);
    writeFileSync(path, JSON.stringify(raw));
    if (provider === 'copilot-sdk') {
      const native = alWorkflowNativeConfig(configAt(path), join(root, 'sdk'));
      assert.equal(native.repositories[0].skillBindings[0].authoringProvider, 'copilot-sdk');
      continue;
    }
    const stage = join(root, `stage-${provider}`);
    await assert.rejects(runAlWorkflow('propose', {
      runDirectory: stage, templateConfig: alReference(path), qualification: alReference(qualification),
      authorizeCommit: true, authorizePush: true, authorizeDraftPR: true
    }), /copilot-sdk|local execution and a local authoring provider|unknown authoring provider/);
    assert.equal(existsSync(join(stage, 'model-reservation.json')), false);
    assert.equal(existsSync(join(stage, 'proposer-config.json')), false);
    assert.equal(existsSync(join(stage, 'state', 'ledger.sqlite')), false);
  }
});
test('AL workflow refuses unsupported operations and never overwrites prior stage receipts', async t => {
  const root = mkdtempSync(join(tmpdir(), 'al-workflow-receipts-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const old = join(root, 'result.json');
  writeFileSync(old, '{"original":true}\n');
  await assert.rejects(runAlWorkflow('unknown', { runDirectory: root }), /Unknown AL workflow stage/);
  await assert.rejects(runAlWorkflow('reconcile', { runDirectory: root }), /fresh absolute receipt directory/);
  assert.equal(readFileSync(old, 'utf8'), '{"original":true}\n');
  const next = join(root, 'new-stage');
  await assert.rejects(runAlWorkflow('collect', { runDirectory: next, liveCollectionApproved: false }),
    /explicit approval/);
  const failure = JSON.parse(readFileSync(join(next, 'failure.json'), 'utf8'));
  assert.equal(failure.error.code, 'blocked-authorization');
  assert.equal(failure.automaticRetry, false);
});
test('AL recurring preparation preserves one native contract and worker state across stage receipt directories', () => {
  const template = { runtime: {}, limits: {}, repositories: [{
    id: 'augloop-workflows', remote: 'https://dev.azure.com/office/ISS/_git/augloop-workflows',
    validationGates: [{ executable: process.execPath }], skillBindings: []
  }] };
  const shared = join(process.cwd(), 'synthetic-shared-workers');
  const prepare = alWorkflowNativeConfig(template, join(process.cwd(), 'synthetic-prepare'), shared);
  const propose = alWorkflowNativeConfig(template, join(process.cwd(), 'synthetic-propose'), shared);
  assert.equal(prepare.stateDirectory, shared);
  assert.equal(propose.stateDirectory, shared);
  assert.deepEqual(repositoryValidationContract(prepare.repositories[0]),
    repositoryValidationContract(propose.repositories[0]));
  assert.equal(prepare.repositories[0].validationGates[0].isolationVerified, false);
  assert.throws(() => alWorkflowNativeConfig(template, process.cwd(), 'relative-worker-state'), /absolute approved/);
});
test('AL recurring model allocation requires a live pre-execution ledger reservation and current authority', t => {
  const root = mkdtempSync(join(tmpdir(), 'al-recurring-budget-'));
  const ledger = new Ledger(root);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const file = join(root, 'authorization.json'), deadlineAt = new Date(Date.now() + 60000).toISOString();
  writeFileSync(file, JSON.stringify({ format: 'al-recurring-authorization-v1',
    allowModels: true, expiresAt: deadlineAt, maxTotalModelSessions: 2, maxTotalAiCredits: 60 }));
  const authorization = alReference(file);
  const approval = { format: 'al-recurring-model-allocation-v1', model: 'gpt-6-luna', authorization,
    ledgerPath: join(root, 'ledger.sqlite'), reservationId: 'synthetic-budget',
    runDirectory: root, deadlineAt, maxAdditionalSessions: 2, purposes: ['filter'] };
  assert.throws(() => requireAlModelAllocation(approval, root, 2, 'filter'), /live pre-execution/);
  const reservation = { authorizationSha256: authorization.sha256, runDirectory: root, purpose: 'filter',
    count: 2, credits: 60, totalReserved: 2, totalCreditsReserved: 60 };
  ledger.operation(`al-grant:${authorization.sha256}`, 'synthetic-grant', 'al-recurring-grant', {});
  ledger.finishOperation(`al-grant:${authorization.sha256}`, 'active', {});
  ledger.operation(approval.reservationId, 'synthetic-cycle', 'al-cycle-model-budget', reservation);
  ledger.finishOperation(approval.reservationId, 'reserved', reservation);
  assert.doesNotThrow(() => requireAlModelAllocation(approval, root, 2, 'filter'));
  ledger.finishOperation(`al-grant:${authorization.sha256}`, 'stopped', {});
  assert.throws(() => requireAlModelAllocation(approval, root, 2, 'filter'), /live pre-execution/);
  ledger.finishOperation(`al-grant:${authorization.sha256}`, 'active', {});
  assert.throws(() => requireAlModelAllocation(approval, root, 3, 'filter'), /finite authority/);
  ledger.finishOperation(approval.reservationId, 'consumed-or-held', reservation);
  assert.throws(() => requireAlModelAllocation(approval, root, 2, 'filter'), /live pre-execution/);
});
