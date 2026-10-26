import test from 'node:test';
import assert from 'node:assert/strict';
import { cliError } from '../scripts/test-support/cli-error.mjs';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { configAt, hash, json, now } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import { area } from '../src/sources.js';
import { openApp } from '../src/app-native.js';
import { loadFilterCorpus } from '../src/filter.js';
import { prepareFilterBatches, checkFilterBatchResult } from '../src/filter-batches.js';
import { recordAgencySubmission, recordAgencyAnalysisCheck, reconcileAgencyResult } from '../src/agency-executor.js';
import { repositoryValidationContract, skillQualificationId } from '../src/repository-skills.js';
import { beginOneShotCollection, advanceOneShotCollection, readOneShotCollectionReceipt } from '../src/one-shot-collection.js';
import { advanceOneShotHandoff, prepareOneShotFilterBudget, reserveOneShotFilterRequest } from '../src/one-shot-handoff.js';

const bytes = value => `${JSON.stringify(value, null, 2)}\n`;
const sha = value => hash(bytes(value));
import { setup } from '../scripts/test-support/one-shot-fixture.mjs';

test('accepted complete no-candidate cohort ends without any proposer, including real-shaped dry-run WorkIQ', async t => {
  for (const workiq of [false, true]) {
    const s = await setup(t, { workiq });
    const status = await advanceOneShotHandoff(s.config, s.ledger, s.input, { execute: true });
    assert.equal(status.state, 'complete-no-candidate', json(status.blocker));
    assert.equal(status.accepted.sourceCoverageComplete, true);
    assert.equal(status.accepted.semanticAnalysisVerifiedByHelper, false);
    assert.equal(status.assignment, null);
    assert.equal(s.ledger.status().jobs.length, 0);
    assert.deepEqual(await advanceOneShotHandoff(s.config, s.ledger, s.input), status);
  }
});

test('a truly empty completed enumeration needs no invented FILTER job or proposer', async t => {
  const s = await setup(t, { empty: true, workiq: true });
  const result = await advanceOneShotHandoff(s.config, s.ledger, s.input);
  assert.equal(result.state, 'complete-no-candidate', json(result.blocker));
  assert.equal(result.accepted.reserved.filterRequests, 0);
  assert.equal(result.accepted.reserved.filterReservedTokens, 0);
  assert.equal(s.ledger.status().jobs.length, 0);
});

test('selected candidate remains held until separately authorized and never starts a worker on a check', async t => {
  const s = await setup(t, { candidate: true, workiq: true });
  const status = await advanceOneShotHandoff(s.config, s.ledger, s.input);
  assert.equal(status.state, 'complete-held', json(status.blocker));
  assert.equal(status.dispatchStarted, false);
  assert.equal(s.ledger.status().jobs.length, 0);
  assert.equal(status.accepted.cohort.consolidation.selected.definition.repository, 'target');
});

test('structural results without accepted execution stay blocked and resume only the original execution', async t => {
  const s = await setup(t, { terminal: false });
  const blocked = await advanceOneShotHandoff(s.config, s.ledger, s.input);
  assert.equal(blocked.state, 'blocked');
  assert.match(blocked.blocker.action, /execution cohort/);
  assert.equal(blocked.accepted, null);
  reconcileAgencyResult(s.execution, s.manifest.batches[0].id, s.terminalInput);
  assert.equal((await advanceOneShotHandoff(s.config, s.ledger, s.input)).state, 'complete-no-candidate');
});

test('missing, partial and modified result files cannot be accepted as no candidate', async t => {
  for (const mode of ['missing', 'partial', 'modified']) {
    const s = await setup(t);
    if (mode === 'missing') rmSync(s.resultPath);
    else {
      const value = structuredClone(s.result);
      if (mode === 'partial') value.status = 'partial';
      else value.details[0].reason = 'Changed result';
      writeFileSync(s.resultPath, bytes(value));
    }
    const status = await advanceOneShotHandoff(s.config, s.ledger, s.input, { execute: true });
    assert.equal(status.state, 'blocked');
    assert.equal(status.accepted, null);
    assert.equal(s.ledger.status().jobs.length, 0);
  }
});

test('collection coverage drift blocks even an otherwise accepted empty-candidate execution', async t => {
  const s = await setup(t);
  const { ledger: source } = openApp(s.collectionConfig, 'fresh');
  const result = JSON.parse(source.db.prepare('SELECT body FROM app_passes').get().body);
  result.state = 'partial';
  source.db.prepare('UPDATE app_passes SET body=?').run(json(result)); source.close();
  const status = await advanceOneShotHandoff(s.config, s.ledger, s.input);
  assert.equal(status.state, 'blocked');
  assert.match(status.blocker.action, /unchanged/);
});

test('aggregate FILTER budgets and non-retroactive authorization are mandatory', async t => {
  for (const change of [
    input => { input.authorization.maxFilterExecutionSeconds = 599; },
    input => { input.authorization.maxFilterReservedTokens = 104; },
    input => { input.authorization.approvedAt = new Date(Date.now() + 60000).toISOString(); }
  ]) {
    const s = await setup(t);
    change(s.input);
    if (Date.parse(s.input.authorization.approvedAt) > Date.now())
      await assert.rejects(advanceOneShotHandoff(s.config, s.ledger, s.input), /authorization interval/);
    else assert.equal((await advanceOneShotHandoff(s.config, s.ledger, s.input)).blocker.code, 'blocked-reconciliation');
    assert.equal(s.ledger.status().jobs.length, 0);
  }
});

test('proposer permissions and aggregate credit cap are checked before assignment creation', async t => {
  for (const credits of [false, true]) {
    const s = await setup(t, { candidate: true, filterLimits: credits
      ? { maxProposerAiCredits: 0.5 } : { authorizeDraftPR: false } });
    const status = await advanceOneShotHandoff(s.config, s.ledger, s.input, { execute: true });
    assert.equal(status.state, 'blocked', json(status));
    assert.equal(status.blocker.code, credits ? 'blocked-budget' : 'blocked-authorization');
    assert.equal(s.ledger.status().jobs.length, 0);
  }
});

test('whole-cohort budgets are reserved before any FILTER task, never granted retroactively', async t => {
  for (const filterLimits of [{ maxFilterReservedTokens: 104 }, { maxFilterExecutionSeconds: 599 }])
    await assert.rejects(setup(t, { filterLimits }), /preauthorized aggregate reservation/);
  const s = await setup(t);
  assert.throws(() => reserveOneShotFilterRequest(s.config, s.execution, s.input,
    s.manifest.batches[0].id, s.reservation), /already reserved/);
  s.execution.db.prepare("DELETE FROM operations WHERE kind='one-shot-filter-budget'").run();
  assert.throws(() => prepareOneShotFilterBudget(s.config, s.execution, s.input), /another one-shot cohort/);
  const result = await advanceOneShotHandoff(s.config, s.ledger, s.input);
  assert.equal(result.state, 'blocked');
  assert.match(result.blocker.action, /Missing pre-execution aggregate/);
});

test('CLI FILTER reservation and proposer check preserve exact core results and role authority', async t => {
  const s = await setup(t);
  const configPath = join(s.ledger.directory, 'pilot.local.json'), inputPath = join(s.ledger.directory, 'input.json');
  writeFileSync(configPath, json(s.config)); writeFileSync(inputPath, json(s.input));
  const invoke = (role, action, flags = []) => spawnSync(process.execPath, [join('src', 'cli.js'), 'agent', role,
    action, '--config', configPath, '--file', inputPath, ...flags], { encoding: 'utf8', timeout: 30000 });
  const budget = invoke('filter', 'one-shot-filter-prepare');
  assert.equal(budget.status, 0, budget.stderr);
  assert.equal(JSON.parse(budget.stdout).result.state, 'reserved-not-submitted');
  const checked = invoke('proposer', 'one-shot-handoff', ['--check']);
  assert.equal(checked.status, 0, checked.stderr);
  assert.equal(JSON.parse(checked.stdout).result.state, 'complete-no-candidate');
  assert.equal(JSON.parse(checked.stdout).acceptance, 'not-inferred');
  const notAllowed = invoke('filter', 'one-shot-handoff', ['--execute']);
  assert.equal(notAllowed.status, 1);
  assert.equal(cliError(notAllowed.stderr).code, 'blocked-agent');
  const missingAuthorization = invoke('proposer', 'one-shot-handoff', ['--execute']);
  assert.equal(missingAuthorization.status, 1);
  assert.equal(cliError(missingAuthorization.stderr).error.code, 'blocked-authorization');
  assert.equal(s.ledger.status().jobs.length, 0);
  writeFileSync(s.resultPath, bytes({ ...s.result, status: 'partial' }));
  const blocked = invoke('proposer', 'one-shot-handoff', ['--check']);
  assert.equal(blocked.status, 2, blocked.stderr);
  assert.equal(JSON.parse(blocked.stdout).result.state, 'blocked');
});

test('auth retry rejects newly discovered execution intent even if job state still says prepared', async t => {
  const s = await setup(t, { candidate: true, gitSource: true });
  let attempts = 0;
  const dispatchDependencies = { preflightValidationAuthentication: async () => {
    attempts++;
    return [{ state: 'action-required-auth', reason: 'synthetic-only' }];
  } };
  const first = await advanceOneShotHandoff(s.config, s.ledger, s.input, { execute: true, dispatchDependencies });
  assert.equal(first.blocker.code, 'action-required-auth');
  s.ledger.operation('synthetic-unknown-effect', first.assignment.id, 'push', { revision: 'unknown' });
  const result = await advanceOneShotHandoff(s.config, s.ledger, s.input, {
    execute: true, resumeAuth: true, dispatchDependencies
  });
  assert.equal(result.state, 'blocked');
  assert.match(result.blocker.action, /positively unstarted/);
  assert.equal(attempts, 1);
});

test('dispatch intent survives preflight failure and forbids silent retry or replacement assignment', async t => {
  const s = await setup(t, { candidate: true });
  const first = await advanceOneShotHandoff(s.config, s.ledger, s.input, { execute: true });
  assert.equal(first.state, 'blocked');
  assert.equal(first.dispatchStarted, true, json(first.blocker));
  assert.equal(s.ledger.status().jobs.length, 1);
  const next = await advanceOneShotHandoff(s.config, s.ledger, s.input, { execute: true,
    dispatchDependencies: { preflightValidationAuthentication: () => assert.fail('must not redispatch') } });
  assert.equal(next.state, 'blocked');
  assert.equal(next.assignment.id, first.assignment.id);
  assert.match(next.blocker.action, /Never redispatch/);
  assert.equal(s.ledger.status().jobs.length, 1);
  const changed = structuredClone(s.input); changed.authorization.maxProposerAiCredits = 2;
  const conflict = await advanceOneShotHandoff(s.config, s.ledger, changed, { execute: true });
  assert.match(conflict.blocker.action, /request\/configuration changed/);
});

test('known pre-dispatch authentication block permits only one explicit retry and no automatic loop', async t => {
  const s = await setup(t, { candidate: true, workiq: true, gitSource: true });
  let attempts = 0;
  const dispatchDependencies = { preflightValidationAuthentication: async () => {
    attempts++;
    return [{ state: 'action-required-auth', reason: 'synthetic-only', tokenRequested: false }];
  } };
  const first = await advanceOneShotHandoff(s.config, s.ledger, s.input, { execute: true, dispatchDependencies });
  assert.equal(first.blocker.code, 'action-required-auth', json(first.blocker));
  assert.equal(first.authRequired, true);
  assert.equal(s.ledger.job(first.assignment.id).state, 'prepared');
  assert.equal(s.ledger.all('evidence')[0].source.provenance, 'workiq-cli-verified');
  const held = await advanceOneShotHandoff(s.config, s.ledger, s.input, { execute: true, dispatchDependencies });
  assert.equal(held.blocker.code, 'action-required-auth');
  assert.equal(attempts, 1);
  const retried = await advanceOneShotHandoff(s.config, s.ledger, s.input, {
    execute: true, resumeAuth: true, dispatchDependencies
  });
  assert.equal(retried.authRetryUsed, true);
  assert.equal(retried.blocker.code, 'action-required-auth');
  assert.equal(attempts, 2);
  const blocked = await advanceOneShotHandoff(s.config, s.ledger, s.input, {
    execute: true, resumeAuth: true, dispatchDependencies
  });
  assert.equal(blocked.blocker.code, 'blocked-reconciliation');
  assert.equal(attempts, 2);
  assert.equal(s.ledger.status().jobs.length, 1);
});

test('resume only recognizes a persisted draft with the original attempt and every exact-head passing gate', async t => {
  for (const mode of ['passed', 'wrong-head', 'wrong-gate', 'wrong-attempt', 'extra-gate']) {
    const s = await setup(t, { candidate: true });
    const started = await advanceOneShotHandoff(s.config, s.ledger, s.input, { execute: true });
    assert.equal(started.dispatchStarted, true);
    const assignment = s.ledger.get('assignment', started.assignment.id);
    const revision = 'b'.repeat(40);
    const validation = [{ gateId: mode === 'wrong-gate' ? 'another-gate' : assignment.validationGates[0],
      sourceRevision: mode === 'wrong-head' ? 'c'.repeat(40) : revision,
      status: 'passed', commandOrRunUrl: 'synthetic-only', artifactRefs: ['synthetic:pass'],
      owner: 'test', nextCheckAt: null, attemptCount: 1, blockedReason: null }];
    if (mode === 'extra-gate') validation.push({ ...validation[0], gateId: 'extra-gate' });
    s.ledger.put({
      recordType: 'workerResult', schemaVersion: '1.0', id: 'synthetic-result',
      assignmentId: assignment.id, attemptId: started.assignment.attemptId, reportedAt: now(),
      outcome: 'draft-pr-validated', findings: 'Synthetic terminal receipt only', evidenceIds: assignment.evidenceIds,
      sourceRevision: revision, draftPR: { url: 'https://example.invalid/draft', isDraft: true, headRevision: revision },
      validation, validationAttempts: [{ round: 0, sourceRevision: revision, validation }],
      toolUsage: { limit: 20, used: 0, remaining: 20,
        byTool: { pilot_list: 0, pilot_search: 0, pilot_read: 0, pilot_write: 0, pilot_finish: 0 }, rounds: [] },
      skillExecution: null, blocker: null, nextAction: 'Synthetic test only'
    });
    s.ledger.moveJob(assignment.id, 'prepared', 'completed');
    if (mode === 'wrong-attempt')
      s.ledger.db.prepare('UPDATE jobs SET session_id=? WHERE id=?').run('replacement', assignment.id);
    const status = await advanceOneShotHandoff(s.config, s.ledger, s.input, {
      execute: true, dispatchDependencies: { preflightValidationAuthentication: () => assert.fail('terminal must not dispatch') }
    });
    assert.equal(status.state, mode === 'passed' ? 'completed' : 'blocked', json(status.blocker));
    assert.equal(s.ledger.status().jobs.length, 1);
    if (mode === 'passed') {
      assert.equal(status.result.sourceRevision, revision);
      assert.deepEqual(await advanceOneShotHandoff(s.config, s.ledger, s.input), status);
    }
  }
});
