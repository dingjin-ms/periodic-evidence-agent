import test from 'node:test';
import assert from 'node:assert/strict';
import { hash, json } from '../src/common.js';
import { compareRsiFlows, renderRsiFlowComparison } from '../src/rsi-evaluation.js';

const profile = { cases: [
  { id: 'recover', population: 'recovery', assertions: ['intended-work'] },
  { id: 'healthy', population: 'healthy', assertions: ['intended-work'] },
  { id: 'guard', population: 'guard', assertions: ['refusal'] }
] };
const bindings = { baselineRevision: 'a'.repeat(40), candidateRevision: 'b'.repeat(40),
  observationSha256: 'c'.repeat(64) };
function observation(revision) {
  return { format: 'rsi-e2e-observation-v1', revision,
    observationSha256: bindings.observationSha256, profileSha256: hash(json(profile)),
    result: { violations: [], cases: profile.cases.map(row => ({
      id: row.id, started: true, outcome: 'passed',
      assertions: row.assertions.map(id => ({ id, state: 'passed' }))
    })) } };
}

test('paired E2E scoring retains pre-test failures and requires preserved controls', () => {
  const before = observation(bindings.baselineRevision), after = observation(bindings.candidateRevision);
  before.result.cases[0] = { id: 'recover', started: false, outcome: 'failed', assertions: [] };
  const report = compareRsiFlows(profile, before, after, bindings);
  assert.equal(report.qualified, true);
  assert.equal(report.judgment, 'demonstrated-benefit');
  assert.deepEqual(report.baseline.recovery, { verified: 0, selected: 1, unknown: 0 });
  assert.deepEqual(report.candidate.recovery, { verified: 1, selected: 1, unknown: 0 });
  assert.deepEqual(report.baseline.completion, { verified: 1, selected: 2, unknown: 0 });
  assert.deepEqual(report.baseline.assertions, { verified: 2, selected: 3, unknown: 0 });
  assert.match(renderRsiFlowComparison(report), /\| recovery \| 0\/1 \| 1\/1 \|/);
  after.result.cases[2].outcome = 'failed';
  assert.equal(compareRsiFlows(profile, before, after, bindings).judgment, 'regression');
});

test('equal E2E outcomes establish no demonstrated benefit', () => {
  const report = compareRsiFlows(profile, observation(bindings.baselineRevision),
    observation(bindings.candidateRevision), bindings);
  assert.equal(report.qualified, false);
  assert.equal(report.judgment, 'no-demonstrated-benefit');
});

test('wrong and missing source/input/profile bindings never verify coverage', () => {
  for (const key of ['revision', 'observationSha256', 'profileSha256']) {
    for (const value of [undefined, 'f'.repeat(64)]) {
      const before = observation(bindings.baselineRevision), after = observation(bindings.candidateRevision);
      after[key] = value;
      const report = compareRsiFlows(profile, before, after, bindings);
      assert.equal(report.qualified, false);
      assert.deepEqual(report.candidate.execution, { verified: 0, selected: 3, unknown: 3 });
      assert.deepEqual(report.candidate.assertions, { verified: 0, selected: 3, unknown: 3 });
      assert.match(renderRsiFlowComparison(report), /\| assertions \| 3\/3 \| 0\/3 \(3 unknown\) \|/);
    }
  }
});

test('missing, duplicated and invented cases cannot inflate paired coverage', () => {
  for (const mutate of [
    rows => rows.slice(1), rows => [...rows, rows[0]],
    rows => [...rows, { ...rows[0], id: 'invented' }],
    rows => rows.map(row => ({ ...row, assertions: [] }))
  ]) {
    const after = observation(bindings.candidateRevision);
    after.result.cases = mutate(after.result.cases);
    const report = compareRsiFlows(profile, observation(bindings.baselineRevision), after, bindings);
    assert.equal(report.qualified, false);
    assert.equal(report.candidate.allSelected, 3);
    assert.ok(report.candidate.execution.unknown > 0);
  }
});
