import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAt, now, PilotError } from '../src/common.js';
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

test('scheduler admits the oldest waiting repository when only one slot is free', t => {
  const { config, ledger, prepare } = fixture(t);
  const firstA = prepare('investigation-a1', 'repo-a');
  const firstB = prepare('investigation-b1', 'repo-b');
  ledger.db.prepare('UPDATE jobs SET updated_at=? WHERE id=?')
    .run('2026-10-19T02:00:00.000Z', firstA.id);
  ledger.db.prepare('UPDATE jobs SET updated_at=? WHERE id=?')
    .run('2026-10-19T01:00:00.000Z', firstB.id);

  const result = selectPreparedAssignments(config, ledger, { limit: 1 });
  assert.deepEqual(result.selected.map(job => job.id), [firstB.id]);
  assert.deepEqual(result.deferred.map(job => job.id), [firstA.id]);
});

test('scheduler preserves authentication actions while other repositories complete', async t => {
  const { config, ledger, prepare } = fixture(t);
  const firstA = prepare('investigation-a1', 'repo-a');
  const firstB = prepare('investigation-b1', 'repo-b');
  const actions = [{
    state: 'action-required-auth',
    reason: 'interactive-sign-in-required',
    cwd: config.repositories[0].referenceCheckout,
    requiresInstallApproval: false,
    remediation: 'approved-auth-setup'
  }];
  const result = await schedulePreparedAssignments(config, ledger, {
    execute: true, authorizeCommit: true, authorizePush: true, authorizeDraftPR: true
  }, {
    dispatchAssignment: async (_config, currentLedger, id) => {
      if (id === firstA.id) return { state: 'action-required-auth', actions };
      currentLedger.moveJob(id, 'prepared', 'dispatching');
      currentLedger.moveJob(id, 'dispatching', 'completed');
      return { outcome: 'draft-pr-validated' };
    }
  });

  assert.equal(result.results[0].state, 'action-required-auth');
  assert.equal(result.state, 'partial');
  assert.deepEqual(result.results[0].actions, actions);
  assert.equal(ledger.job(firstA.id).state, 'prepared');
  assert.equal(result.results[1].assignmentId, firstB.id);
  assert.equal(result.results[1].state, 'completed');
  const operation = ledger.status().operations.find(item => item.id === result.operationId);
  assert.equal(operation.state, 'partial');
  assert.deepEqual(JSON.parse(operation.detail).results, result.results);
});

test('scheduler records a nonthrowing blocked worker as a partial batch', async t => {
  const { config, ledger, prepare } = fixture(t);
  prepare('investigation-a1', 'repo-a');
  const result = await schedulePreparedAssignments(config, ledger, {
    execute: true, authorizeCommit: true, authorizePush: true, authorizeDraftPR: true
  }, {
    dispatchAssignment: async (_config, currentLedger, id) => {
      currentLedger.moveJob(id, 'prepared', 'dispatching');
      currentLedger.moveJob(id, 'dispatching', 'blocked');
      return { outcome: 'blocked' };
    }
  });
  assert.equal(result.results[0].outcome, 'blocked');
  assert.equal(result.state, 'partial');
  assert.equal(ledger.status().operations.find(item =>
    item.id === result.operationId).state, 'partial');
});

test('scheduler preserves a typed authentication blocker without completing the batch', async t => {
  const { config, ledger, prepare } = fixture(t);
  const job = prepare('investigation-auth', 'repo-a');
  const result = await schedulePreparedAssignments(config, ledger, {
    execute: true, authorizeCommit: true, authorizePush: true, authorizeDraftPR: true
  }, {
    dispatchAssignment: async () => ({ state: 'blocked-auth' })
  });
  assert.equal(result.state, 'partial');
  assert.equal(result.results[0].state, 'blocked-auth');
  assert.equal(ledger.job(job.id).state, 'prepared');
  assert.equal(ledger.status().operations.find(item =>
    item.id === result.operationId).state, 'partial');
});

for (const outcome of ['draft-pr-validation-failed', 'diagnostic-failed']) {
  test(`scheduler records completed dispatch with ${outcome} as partial`, async t => {
    const { config, ledger, prepare } = fixture(t);
    prepare('investigation-failed-outcome', 'repo-a');
    const result = await schedulePreparedAssignments(config, ledger, {
      execute: true, authorizeCommit: true, authorizePush: true, authorizeDraftPR: true
    }, {
      dispatchAssignment: async (_config, currentLedger, id) => {
        currentLedger.moveJob(id, 'prepared', 'dispatching');
        currentLedger.moveJob(id, 'dispatching', 'completed');
        return { outcome };
      }
    });
    assert.equal(result.state, 'partial');
    assert.equal(result.results[0].state, 'completed');
    assert.equal(result.results[0].outcome, outcome);
    assert.equal(ledger.status().operations.find(item =>
      item.id === result.operationId).state, 'partial');
  });
}

test('one repository failure does not cancel or relaunch another repository', async t => {
  const { config, ledger, prepare } = fixture(t);
  const firstA = prepare('investigation-a1', 'repo-a');
  const firstB = prepare('investigation-b1', 'repo-b');
  const launched = [];
  const result = await schedulePreparedAssignments(config, ledger, {
    execute: true, authorizeCommit: true, authorizePush: true, authorizeDraftPR: true
  }, {
    dispatchAssignment: async (_config, currentLedger, id) => {
      launched.push(id);
      currentLedger.moveJob(id, 'prepared', 'dispatching');
      if (id === firstA.id) {
        currentLedger.moveJob(id, 'dispatching', 'blocked');
        throw new PilotError('blocked-reconciliation',
          'Recorded remote job requires reconciliation');
      }
      currentLedger.moveJob(id, 'dispatching', 'completed');
      return { outcome: 'draft-pr-validated' };
    }
  });
  assert.deepEqual(launched, [firstA.id, firstB.id]);
  assert.equal(result.results[0].error.code, 'blocked-reconciliation');
  assert.equal(result.results[1].state, 'completed');
  assert.equal(ledger.status().operations.find(item =>
    item.id === result.operationId).state, 'partial');
  assert.equal(selectPreparedAssignments(config, ledger).selected.length, 0);
});

test('scheduler exposes an uncertain accepted job as a partial result without relaunching', async t => {
  const { config, ledger, prepare } = fixture(t);
  const job = prepare('investigation-a1', 'repo-a');
  let launches = 0;
  const result = await schedulePreparedAssignments(config, ledger, {
    execute: true, authorizeCommit: true, authorizePush: true, authorizeDraftPR: true
  }, {
    dispatchAssignment: async (_config, currentLedger, id) => {
      launches++;
      currentLedger.moveJob(id, 'prepared', 'dispatching');
      currentLedger.moveJob(id, 'dispatching', 'uncertain');
      return { state: 'uncertain' };
    }
  });
  assert.equal(launches, 1);
  assert.equal(result.state, 'partial');
  assert.equal(result.results[0].state, 'uncertain');
  assert.equal(ledger.job(job.id).state, 'uncertain');
  assert.equal(selectPreparedAssignments(config, ledger).selected.length, 0);
  assert.equal(ledger.status().operations.find(item =>
    item.id === result.operationId).state, 'partial');
});
