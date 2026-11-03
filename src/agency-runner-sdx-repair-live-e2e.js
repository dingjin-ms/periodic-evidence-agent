import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { requireThat } from './common.js';

const stages = ['fingerprint', 'authentication-check', 'authentication', 'dependencies', 'compile', 'policy', 'test'];
const digest = /^[a-f0-9]{64}$/;
const revision = /^[a-f0-9]{40}$/;
const changefile = /^midgard\/change\/change-[a-f0-9-]+\.json$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

function files(root) {
  const output = [];
  function walk(directory) {
    requireThat(!lstatSync(directory).isSymbolicLink(), 'SDX repair evidence directories cannot be links', 'blocked-result');
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      requireThat(!stat.isSymbolicLink() && (!stat.isFile() || stat.nlink <= 1),
        'SDX repair evidence links are not accepted', 'blocked-result');
      if (stat.isDirectory()) walk(path);
      else output.push(path);
    }
  }
  walk(root);
  return output;
}

function orderedStages(value) {
  return Array.isArray(value) && value.length === stages.length &&
    value.every((entry, index) => entry.stage === stages[index] && Number.isSafeInteger(entry.exitCode));
}

export function verifyAgencyRunnerSdxRepairLiveE2e(contract, observation, agencyRoot, dropRoot) {
  requireThat(contract?.schema === 'agency-runner-sdx-repair-live-e2e-v1' && revision.test(contract.baseRevision ?? '') &&
    digest.test(contract.profileSha256 ?? '') && digest.test(contract.promptSha256 ?? '') &&
    digest.test(contract.skillSha256 ?? '') && Number.isSafeInteger(contract.pipelineDefinitionId) &&
    contract.pipelineDefinitionId > 0 && contract.maximumRunnerMinutes === 60 && contract.maximumRepairs === 2 &&
    typeof contract.testPath === 'string' && contract.testPath.endsWith('.integration.test.ts') &&
    typeof contract.cardPath === 'string' && contract.cardPath.startsWith(
      'midgard/packages/officeaicopilot-agent-excel/tests/integration/behavior-cards/'),
  'Invalid SDX bounded-repair live E2E contract', 'blocked-config');
  const { job, build } = observation;
  requireThat(job?.jobId === contract.jobId && job.state === 'Completed' && job.result === 'Success' &&
    job.promptSha256 === contract.promptSha256 && job.pipelineRun?.runId === build?.id &&
    job.pipelineRun?.definitionId === contract.pipelineDefinitionId && build.definitionId === contract.pipelineDefinitionId &&
    build.status === 'completed' && build.result === 'succeeded',
  'SDX bounded-repair job/build identity or result differs', 'blocked-result');
  const elapsed = Date.parse(build.finishTime) - Date.parse(build.startTime);
  requireThat(Number.isFinite(elapsed) && elapsed > 0 && elapsed <= contract.maximumRunnerMinutes * 60000,
    'SDX bounded-repair live E2E exceeded its runner budget', 'blocked-result');

  const eventPaths = files(agencyRoot).filter(path => path.endsWith(`${sep}events.jsonl`) &&
    !path.includes(`${sep}classification${sep}`));
  requireThat(eventPaths.length === 1, 'Exactly one original Agency event stream is required', 'blocked-result');
  const events = readFileSync(eventPaths[0], 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
  const starts = new Map(events.filter(event => event.type === 'tool.execution_start')
    .map(event => [event.data?.toolCallId, event.data]));
  const completes = new Map(events.filter(event => event.type === 'tool.execution_complete')
    .map(event => [event.data?.toolCallId, event.data]));
  const commands = [...starts.values()].filter(start => {
    const complete = completes.get(start.toolCallId);
    return ['powershell', 'bash', 'shell'].includes(start.toolName) && complete?.shellExecution &&
      Number.isSafeInteger(complete.shellExecution.exitCode);
  }).map(start => start.arguments?.command ?? '').join('\n');
  requireThat(commands.includes(contract.baseRevision) && commands.includes(contract.profileSha256) &&
    commands.includes(contract.skillSha256) && commands.includes(contract.testPath) &&
    stages.every(stage => commands.includes(stage)) && commands.includes('commit --amend'),
  'Original Agency commands do not bind source, skill, authored test, gates and amend repair', 'blocked-result');

  const root = join(dropRoot, 'sdx-repair-live-e2e');
  const result = read(join(root, 'result.json'));
  requireThat(revision.test(result.candidate ?? '') && result.candidate !== contract.baseRevision &&
    result.baseRevision === contract.baseRevision && result.parent === contract.baseRevision &&
    result.profileSha256 === contract.profileSha256 && result.skillSha256 === contract.skillSha256 &&
    result.repairCount >= 1 && result.repairCount <= contract.maximumRepairs && result.gitStatus === '' &&
    result.publicationPerformed === false && orderedStages(result.preReviewStages) &&
    result.preReviewStages.every(entry => entry.exitCode === 0) && orderedStages(result.finalStages) &&
    result.finalStages.every(entry => entry.exitCode === 0),
  'SDX repair result does not prove a clean repaired candidate and two complete passing gate sets', 'blocked-result');
  const changed = read(join(root, 'changed-files.json'));
  requireThat(Array.isArray(changed) && changed.includes(contract.testPath) && changed.includes(contract.cardPath) &&
    changed.some(path => changefile.test(path)) && changed.every(path =>
      path === contract.testPath || path === contract.cardPath || changefile.test(path)),
  'SDX repaired candidate escaped its test/card/changefile scope', 'blocked-result');

  const rounds = read(join(root, 'rounds.json'));
  requireThat(rounds.schema === 'sdx-repair-rounds-v1' && Array.isArray(rounds.rounds) &&
    rounds.rounds.length === result.repairCount + 1, 'SDX repair rounds do not match repairCount', 'blocked-result');
  rounds.rounds.forEach((round, index) => {
    requireThat(round.round === index && revision.test(round.candidate ?? '') &&
      round.parent === contract.baseRevision && orderedStages(round.stages) &&
      typeof round.artifactPath === 'string' && digest.test(round.artifactSha256 ?? '') &&
      hash(readFileSync(join(root, ...round.artifactPath.split('/')))) === round.artifactSha256,
    'SDX repair round is not bound to its candidate, parent, gates and artifact', 'blocked-result');
  });
  const failedRounds = rounds.rounds.slice(0, -1);
  requireThat(failedRounds.length >= 1 && failedRounds.every(round =>
    round.stages.slice(0, -1).every(entry => entry.exitCode === 0) && round.stages.at(-1).exitCode !== 0) &&
    rounds.rounds.at(-1).candidate === result.candidate && rounds.rounds.at(-1).stages.every(entry => entry.exitCode === 0),
  'SDX repair rounds do not prove a real test-stage failure followed by complete success', 'blocked-result');

  const repair = read(join(root, 'repair.json'));
  requireThat(repair.schema === 'sdx-bounded-repair-v1' && Array.isArray(repair.repairs) &&
    repair.repairs.length === result.repairCount, 'SDX repair chain does not match repairCount', 'blocked-result');
  repair.repairs.forEach((entry, index) => {
    const failed = rounds.rounds[index], repaired = rounds.rounds[index + 1];
    const diagnosticBytes = readFileSync(join(root, ...entry.diagnosticPath.split('/')));
    requireThat(entry.attempt === index + 1 && entry.failedCandidate === failed.candidate &&
      entry.repairedCandidate === repaired.candidate && entry.failureStage === 'test' &&
      digest.test(entry.diagnosticSha256 ?? '') && hash(diagnosticBytes) === entry.diagnosticSha256 &&
      Array.isArray(entry.changedPaths) && entry.changedPaths.length > 0 &&
      entry.changedPaths.every(path => path === contract.testPath || path === contract.cardPath || changefile.test(path)),
    'SDX repair is not bound to the failed test diagnostic and allowed repair scope', 'blocked-result');
  });

  const fault = read(join(root, 'fault-injection.json'));
  const finalSource = readFileSync(join(root, ...fault.finalTestSourcePath.split('/')), 'utf8');
  requireThat(fault.schema === 'sdx-controlled-fault-injection-v1' && fault.controlled === true &&
    fault.scope === 'test-only' && fault.injectedBeforeInitialGate === true && fault.removedByBoundedRepair === true &&
    fault.testPath === contract.testPath && fault.injectedCandidate === rounds.rounds[0].candidate &&
    fault.finalCandidate === result.candidate && typeof fault.marker === 'string' && fault.marker.length >= 12 &&
    !finalSource.includes(fault.marker) && digest.test(fault.finalTestSourceSha256 ?? '') &&
    hash(finalSource) === fault.finalTestSourceSha256,
  'Controlled SDX fault injection is not transparent or is present in the final candidate', 'blocked-result');
  const review = read(join(root, 'review.json'));
  requireThat(review.schema === 'sdx-native-review-v1' && review.candidate === result.candidate &&
    review.verdict === 'approved' && Array.isArray(review.findings) && review.findings.length === 0 &&
    review.skillSha256 === contract.skillSha256 && review.testPath === contract.testPath &&
    review.cardPath === contract.cardPath && review.afterRepair === true &&
    typeof review.authorSessionId === 'string' && typeof review.reviewerSessionId === 'string' &&
    review.authorSessionId !== review.reviewerSessionId,
  'Fresh independent SDX review did not approve the exact repaired candidate', 'blocked-result');
  const jestRoot = join(root, 'jest-artifacts');
  const jestResults = files(jestRoot).filter(path => path.endsWith(`${sep}jest-result.json`));
  requireThat(jestResults.length === 1, 'SDX bounded-repair E2E requires exactly one final Jest result', 'blocked-result');
  const jestDirectory = join(jestResults[0], '..');
  requireThat(['discovered-tests.json', 'selection.json', 'run.json'].every(name =>
    files(jestDirectory).includes(join(jestDirectory, name))),
  'SDX bounded-repair E2E final Jest evidence is incomplete', 'blocked-result');
  const jest = read(jestResults[0]);
  requireThat(jest.success === true && jest.numTotalTests > 0 && jest.numPassedTests === jest.numTotalTests &&
    jest.numFailedTests === 0, 'SDX bounded-repair E2E has no nonzero passing final Jest population', 'blocked-result');

  const inventory = read(join(root, 'inventory.json'));
  requireThat(Array.isArray(inventory) && inventory.every(entry => typeof entry?.path === 'string') &&
    new Set(inventory.map(entry => entry.path)).size === inventory.length,
  'SDX bounded-repair inventory paths must be unique', 'blocked-result');
  const actual = files(root).filter(path => !path.endsWith(`${sep}inventory.json`)).map(path => {
    const bytes = readFileSync(path);
    return { path: relative(root, path).split(sep).join('/'), bytes: bytes.length, sha256: hash(bytes) };
  });
  const byPath = (left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0;
  requireThat(JSON.stringify([...inventory].sort(byPath)) === JSON.stringify([...actual].sort(byPath)),
    'SDX bounded-repair inventory differs from downloaded bytes', 'blocked-result');
  return { status: 'passed', controllerAcceptance: true, proofKind: 'controlled-repair-path',
    executionLocation: 'agency-remote', jobId: job.jobId, buildId: build.id,
    baseRevision: contract.baseRevision, candidate: result.candidate, suiteCount: jest.numTotalTestSuites,
    testCount: jest.numTotalTests, repairCount: result.repairCount, nativeSkill: 'pinned-custom-agent',
    review: 'approved', publicationPerformed: false };
}
