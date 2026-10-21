import { readFileSync, lstatSync } from 'node:fs';
import { isAbsolute, relative } from 'node:path';
import { hash, json, requireThat, validateRecord } from './common.js';
import { readAppFlowPlan } from './rsi-app-flow.js';

export function pinRsiEvaluation(profile, candidateWorkspace = null) {
  requireThat(new Set(profile.cases.map(row => row.id)).size === profile.cases.length,
    'RSI evaluation cases must be unique', 'invalid-record');
  requireThat(['recovery', 'healthy', 'guard'].every(population =>
    profile.cases.some(row => row.population === population)),
  'RSI evaluation requires preregistered recovery, healthy and guard populations', 'blocked-validation');
  const files = profile.flowPlan ? [profile.flowPlan] :
    [{ path: profile.driverPath, sha256: profile.driverSha256 }, ...profile.dependencies];
  for (const file of files) {
    requireThat(isAbsolute(file.path), 'RSI evaluation inputs require absolute paths', 'blocked-validation');
    if (candidateWorkspace) {
      const path = relative(candidateWorkspace, file.path);
      requireThat(path === '..' || path.startsWith('..\\') || path.startsWith('../') || isAbsolute(path),
        'The independent evaluator cannot live in the candidate checkout', 'blocked-scope');
    }
    if (profile.flowPlan) readAppFlowPlan(profile);
    const info = lstatSync(file.path);
    requireThat(info.isFile() && !info.isSymbolicLink() && info.nlink === 1 && info.size <= 1048576 &&
      hash(readFileSync(file.path)) === file.sha256, 'RSI evaluation driver/dependency changed', 'blocked-reconciliation');
  }
  return hash(json(profile));
}

function grade(profile, observation, revision, observationSha256) {
  const bound = observation?.format === 'rsi-e2e-observation-v1' &&
    observation.revision === revision && observation.observationSha256 === observationSha256 &&
    observation.profileSha256 === hash(json(profile));
  let valid = bound;
  if (bound) {
    try { validateRecord(observation.result, 'rsiDriverResult'); }
    catch { valid = false; }
  }
  const rows = valid ? observation.result.cases : [];
  if (new Set(rows.map(row => row.id)).size !== rows.length ||
    rows.some(row => !profile.cases.some(expected => expected.id === row.id))) valid = false;
  const cases = profile.cases.map(expected => {
    const actual = valid ? rows.find(row => row.id === expected.id) : null;
    const wellFormed = actual &&
      new Set(actual.assertions.map(row => row.id)).size === actual.assertions.length &&
      actual.assertions.every(row => expected.assertions.includes(row.id)) &&
      (actual.started || actual.assertions.every(row => row.state === 'not-run'));
    const knownFailureBeforeWork = wellFormed && !actual.started && ['failed', 'blocked'].includes(actual.outcome);
    const assertions = expected.assertions.map(id => ({
      id, state: wellFormed ? actual.assertions.find(row => row.id === id)?.state ??
        (knownFailureBeforeWork ? 'not-run' : 'unknown') : 'unknown'
    }));
    const unknown = !wellFormed || actual.outcome === 'unknown' || assertions.some(row => row.state === 'unknown');
    return {
      id: expected.id, population: expected.population,
      started: Boolean(wellFormed && actual.started), unknown, assertions,
      passed: Boolean(!unknown && actual.started && actual.outcome === 'passed' &&
        assertions.every(row => row.state === 'passed')),
      outcome: wellFormed ? actual.outcome : 'unknown'
    };
  });
  const count = rows => ({
    verified: rows.filter(row => row.passed).length, selected: rows.length,
    unknown: rows.filter(row => row.unknown).length
  });
  const allAssertions = cases.flatMap(row => row.assertions);
  return {
    bindingValid: valid, cases, allSelected: cases.length,
    completion: count(cases.filter(row => row.population !== 'guard')),
    recovery: count(cases.filter(row => row.population === 'recovery')),
    healthy: count(cases.filter(row => row.population === 'healthy')),
    guards: count(cases.filter(row => row.population === 'guard')),
    execution: { verified: cases.filter(row => row.started).length, selected: cases.length,
      unknown: cases.filter(row => row.unknown).length },
    assertions: { verified: allAssertions.filter(row => ['passed', 'failed'].includes(row.state)).length,
      selected: allAssertions.length, unknown: allAssertions.filter(row => row.state === 'unknown').length },
    violations: valid ? observation.result.violations : ['unverified-source-or-result']
  };
}

export function compareRsiFlows(profile, baseline, candidate, bindings) {
  const before = grade(profile, baseline, bindings.baselineRevision, bindings.observationSha256);
  const after = grade(profile, candidate, bindings.candidateRevision, bindings.observationSha256);
  const lost = before.cases.filter(row => row.passed &&
    !after.cases.find(next => next.id === row.id).passed).map(row => row.id);
  const lostAssertions = before.cases.flatMap(row => row.assertions.filter(assertion =>
    ['passed', 'failed'].includes(assertion.state) &&
    !['passed', 'failed'].includes(after.cases.find(next => next.id === row.id)
      .assertions.find(next => next.id === assertion.id).state))
    .map(assertion => `${row.id}:${assertion.id}`));
  const valid = before.bindingValid && after.bindingValid &&
    !before.violations.length && !after.violations.length &&
    before.execution.unknown === 0 && after.execution.unknown === 0;
  const preserved = lost.length === 0 && lostAssertions.length === 0 &&
    after.guards.verified === after.guards.selected && after.healthy.verified === after.healthy.selected;
  const improved = after.recovery.verified > before.recovery.verified ||
    after.completion.verified > before.completion.verified;
  return {
    format: 'rsi-e2e-comparison-v1', scope: profile.flowPlan ?
      'existing-app-role-entrypoints-and-durable-ledger-assertions' : 'configured-pinned-e2e-driver',
    bindings: { ...bindings, profileSha256: hash(json(profile)) },
    baseline: before, candidate: after, lostCases: lost, lostAssertions,
    judgment: !valid ? 'inconclusive' : !preserved ? 'regression' :
      improved ? 'demonstrated-benefit' : 'no-demonstrated-benefit',
    qualified: valid && preserved && improved,
    limitations: [
      profile.flowPlan ? 'The pinned plan and independent read-only ledger predicates own assertions; host responses are inputs, not grades.' :
        'The approved driver owns intended-work assertions; this is not candidate self-report.',
      'Only the pinned common case inventory is measured; no universal or post-deployment benefit is inferred.',
      'Driver dependencies must be declared and reviewed; process isolation is not a hostile-code sandbox.',
      'Timing, tokens, credits and recurrence beyond this inventory are not measured.'
    ]
  };
}

export function renderRsiFlowComparison(comparison) {
  const count = value => `${value.verified}/${value.selected}` +
    (value.unknown ? ` (${value.unknown} unknown)` : '');
  return [
    '## Before/after loop comparison', '',
    `**${comparison.judgment}**; scope: ${comparison.scope}.`, '',
    `Baseline: \`${comparison.bindings.baselineRevision}\`; candidate: \`${comparison.bindings.candidateRevision}\`.`,
    `Evaluator profile: \`${comparison.bindings.profileSha256}\`.`,
    `Input observation: \`${comparison.bindings.observationSha256}\`.`, '',
    '| Metric | Baseline | Candidate |',
    '|---|---|---|',
    ...['recovery', 'completion', 'healthy', 'guards', 'execution', 'assertions'].map(metric =>
      `| ${metric} | ${count(comparison.baseline[metric])} | ${count(comparison.candidate[metric])} |`),
    '', `Lost cases: ${comparison.lostCases.length}; lost assertions: ${comparison.lostAssertions.length}.`,
    '', ...comparison.limitations.map(line => `- ${line}`)
  ].join('\n');
}
