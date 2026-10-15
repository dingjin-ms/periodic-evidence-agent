import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAt, now } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import { makeAssignment } from '../src/workers.js';
import {
  schedulePreparedAssignments,
  selectPreparedAssignments
} from '../src/assignment-scheduler.js';

function investigation(id, repoId) {
  return {
    recordType: 'investigation',
    schemaVersion: '1.0',
    id,
    version: 1,
    evidenceIds: [`evidence-${id}`],
    state: 'triaged',
    observedBehavior: 'Synthetic scheduler behavior',
    expectedBehavior: 'Assignments are admitted within bounded capacity',
    hypotheses: [],
    counterEvidence: [],
    classification: 'functional',
    defectConfirmation: 'confirmed',
    reportEligibility: 'included',
    handoffEligibility: 'eligible',
    exclusionReasons: [],
    rationale: 'Offline scheduler fixture',
    confidence: 1,
    review: {
      method: 'human-review',
      reviewer: 'fixture-owner',
      reviewedAt: now()
    },
    repoIds: [repoId],
    existingFixes: [],
    nextAction: 'Author the bounded synthetic change'
  };
}

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'assignment-scheduler-'));
  const config = configAt('pilot.example.json');
  config.stateDirectory = root;
  config.statePolicy.accessApproved = true;
  config.activation.dispatch = true;
  config.limits.maxWorkers = 3;
  config.limits.maxWorkersPerRepository = 1;
  config.limits.maxItems = 20;
  config.limits.maxCalls = 20;
  config.limits.workerMinutes = 5;
  config.limits.workerMaxToolCalls = 20;
  const template = config.repositories[0];
  config.repositories = ['repo-a', 'repo-b'].map(id => ({
    ...structuredClone(template),
    id,
    owner: `${id}-owner`,
    routingApproved: true,
    referenceCheckout: join(root, id),
    remote: `https://example.invalid/${id}.git`,
    baseRef: 'main',
    allowedWritePrefixes: ['src', 'test'],
    validationGates: [{ id: 'integration' }]
  }));
  const ledger = new Ledger(root);
  t.after(() => {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  });
  const prepare = (id, repoId) => {
    const record = investigation(id, repoId);
    ledger.put(record);
    const assignment = makeAssignment(config, record, repoId, 'defect-fix');
    ledger.prepare(assignment);
    return assignment;
  };
  return { config, ledger, prepare };
}

test('scheduler fairly selects prepared assignments within global and repository limits', t => {
  const { config, ledger, prepare } = fixture(t);
  const firstA = prepare('investigation-a1', 'repo-a');
  const secondA = prepare('investigation-a2', 'repo-a');
  const firstB = prepare('investigation-b1', 'repo-b');

  const selected = selectPreparedAssignments(config, ledger);
  assert.deepEqual(selected.selected.map(job => job.id),
    [firstA.id, firstB.id]);
  assert.deepEqual(selected.deferred.map(job => job.id), [secondA.id]);

  ledger.moveJob(firstA.id, 'prepared', 'dispatching');
  const withActiveRepository = selectPreparedAssignments(config, ledger);
  assert.deepEqual(withActiveRepository.selected.map(job => job.id), [firstB.id]);
  assert.deepEqual(withActiveRepository.deferred.map(job => job.id), [secondA.id]);
});

test('scheduler launches different repositories concurrently and retains deferred work', async t => {
  const { config, ledger, prepare } = fixture(t);
  const firstA = prepare('investigation-a1', 'repo-a');
  const secondA = prepare('investigation-a2', 'repo-a');
  const firstB = prepare('investigation-b1', 'repo-b');
  let launched = 0;
  let release;
  const overlap = new Promise(resolve => { release = resolve; });
  const activeRepositories = new Set();
  const launch = async (_config, currentLedger, id) => {
    const job = currentLedger.job(id);
    currentLedger.moveJob(id, 'prepared', 'dispatching');
    assert.equal(activeRepositories.has(job.repo), false);
    activeRepositories.add(job.repo);
    launched++;
    if (launched === 2) release();
    await overlap;
    activeRepositories.delete(job.repo);
    currentLedger.moveJob(id, 'dispatching', 'completed');
    return { outcome: 'draft-pr-validated' };
  };

  await assert.rejects(schedulePreparedAssignments(config, ledger, {
    execute: true
  }, { dispatchAssignment: launch }), /explicit commit, push and Draft PR/);

  const result = await schedulePreparedAssignments(config, ledger, {
    execute: true,
    authorizeCommit: true,
    authorizePush: true,
    authorizeDraftPR: true
  }, { dispatchAssignment: launch });

  assert.equal(launched, 2);
  assert.deepEqual(result.results.map(item => item.assignmentId),
    [firstA.id, firstB.id]);
  assert.ok(result.results.every(item => item.state === 'completed'));
  assert.equal(ledger.job(secondA.id).state, 'prepared');
  const operation = ledger.status().operations.find(item =>
    item.id === result.operationId);
  assert.equal(operation.state, 'completed');
});
