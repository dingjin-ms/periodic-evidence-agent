import { hash, json, now, requireThat, utc } from './common.js';

const kind = '1js-e2e-live-v1';
const requiredSuites = ['cross-app', 'excel-agent'];
const shaPattern = /^[a-f0-9]{40,64}$/;
const digestPattern = /^[a-f0-9]{64}$/;

function exactKeys(value, expected, label) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) &&
    json(Object.keys(value).sort()) === json([...expected].sort()),
  `${label} has an invalid shape`, 'invalid-record');
}

function orderedRuns(runs, label, sourceRevision, ci) {
  requireThat(Array.isArray(runs) && runs.length >= 5,
    `${label} requires at least five consecutive passing runs`, 'blocked-qualification');
  const ids = new Set();
  const evidence = new Set();
  let prior = 0;
  return runs.map((run, index) => {
    const keys = ci
      ? ['sequence', 'buildId', 'testRunId', 'status', 'retriesDisabled', 'completedAt',
        'sourceRevision', 'evidenceSha256']
      : ['sequence', 'runId', 'status', 'retriesDisabled', 'completedAt', 'sourceRevision',
        'evidenceSha256'];
    exactKeys(run, keys, `${label} run`);
    requireThat(run.sequence === index + 1 && run.status === 'passed' &&
      run.retriesDisabled === true && run.sourceRevision === sourceRevision &&
      digestPattern.test(run.evidenceSha256),
    `${label} contains a non-passing, retried or source-mismatched run`, 'blocked-qualification');
    utc(run.completedAt);
    const completed = Date.parse(run.completedAt);
    requireThat(completed > prior, `${label} runs must be in strictly increasing completion order`,
      'blocked-qualification');
    prior = completed;
    const id = ci ? `${run.buildId}:${run.testRunId}` : run.runId;
    requireThat((ci ? Number.isInteger(run.buildId) && run.buildId > 0 &&
      Number.isInteger(run.testRunId) && run.testRunId > 0 :
      typeof run.runId === 'string' && run.runId.length > 0) && !ids.has(id),
    `${label} run identities must be valid and distinct`, 'blocked-qualification');
    requireThat(!evidence.has(run.evidenceSha256),
      `${label} evidence digests must identify distinct executions`, 'blocked-qualification');
    ids.add(id);
    evidence.add(run.evidenceSha256);
    return run;
  });
}

export function qualify1jsE2eEvidence(binding, skillQualification, input) {
  requireThat(binding.executionQualification === kind,
    `Repository skill binding ${binding.id} does not require ${kind}`, 'blocked-config');
  requireThat(skillQualification?.state === 'qualified-read-only' &&
    skillQualification.bindingId === binding.id &&
    shaPattern.test(skillQualification.baseRevision ?? ''),
  'Read-only repository skill qualification is required before E2E qualification',
  'blocked-qualification');
  exactKeys(input, ['format', 'repoId', 'bindingId', 'sourceRevision',
    'pipelineDefinitionId', 'suites'], '1JS E2E qualification');
  requireThat(input.format === kind && input.repoId === skillQualification.repoId &&
    input.bindingId === binding.id && input.sourceRevision === skillQualification.baseRevision &&
    input.pipelineDefinitionId === 36540,
  '1JS E2E qualification does not match the exact repository skill source',
  'blocked-qualification');
  requireThat(Array.isArray(input.suites) && input.suites.length === requiredSuites.length,
    '1JS E2E qualification must cover Cross-App and Excel Agent', 'blocked-qualification');
  const suites = input.suites.map(suite => {
    exactKeys(suite, ['id', 'localRuns', 'ciRuns'], '1JS E2E suite qualification');
    requireThat(requiredSuites.includes(suite.id),
      `Unknown 1JS E2E suite ${suite.id}`, 'blocked-qualification');
    return {
      id: suite.id,
      localRuns: orderedRuns(suite.localRuns, `${suite.id} local qualification`,
        input.sourceRevision, false),
      ciRuns: orderedRuns(suite.ciRuns, `${suite.id} Pipeline 36540 qualification`,
        input.sourceRevision, true)
    };
  }).sort((a, b) => a.id.localeCompare(b.id));
  requireThat(json(suites.map(suite => suite.id)) === json([...requiredSuites].sort()),
    '1JS E2E qualification contains duplicate or missing suites', 'blocked-qualification');
  const evidence = {
    kind,
    state: 'qualified',
    sourceRevision: input.sourceRevision,
    pipelineDefinitionId: 36540,
    suites
  };
  return {
    ...skillQualification,
    executionQualification: {
      ...evidence,
      evidenceSha256: hash(json(input)),
      qualifiedAt: now()
    }
  };
}

export function requireExecutionQualification(binding, skillQualification) {
  if (binding.executionQualification === undefined) return null;
  requireThat(binding.executionQualification === kind,
    `Unsupported execution qualification ${binding.executionQualification}`, 'blocked-config');
  const qualification = skillQualification?.executionQualification;
  requireThat(qualification?.kind === kind && qualification.state === 'qualified' &&
    qualification.sourceRevision === skillQualification.baseRevision &&
    qualification.pipelineDefinitionId === 36540 &&
    Array.isArray(qualification.suites) &&
    json(qualification.suites.map(suite => suite.id).sort()) === json([...requiredSuites].sort()) &&
    digestPattern.test(qualification.evidenceSha256 ?? ''),
  `Repository skill binding ${binding.id} lacks current Cross-App and Excel Agent live qualification`,
  'blocked-qualification');
  return hash(json(qualification));
}
