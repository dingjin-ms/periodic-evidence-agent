import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { requireThat } from './common.js';

const stages = ['fingerprint', 'authentication-check', 'authentication', 'dependencies', 'compile', 'policy', 'test'];
const digest = /^[a-f0-9]{64}$/;
const revision = /^[a-f0-9]{40}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

function files(root) {
  const output = [];
  function walk(directory) {
    requireThat(!lstatSync(directory).isSymbolicLink(), 'SDX evidence directories cannot be links', 'blocked-result');
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      requireThat(!stat.isSymbolicLink() && (!stat.isFile() || stat.nlink <= 1),
        'SDX evidence links are not accepted', 'blocked-result');
      if (stat.isDirectory()) walk(path);
      else output.push(path);
    }
  }
  walk(root);
  return output;
}

export function verifyAgencyRunnerSdxLiveE2e(contract, observation, agencyRoot, dropRoot) {
  requireThat(contract?.schema === 'agency-runner-sdx-live-e2e-v1' && revision.test(contract.baseRevision ?? '') &&
    digest.test(contract.profileSha256 ?? '') && digest.test(contract.promptSha256 ?? '') &&
    digest.test(contract.skillSha256 ?? '') && Number.isSafeInteger(contract.pipelineDefinitionId) &&
    contract.pipelineDefinitionId > 0 && contract.maximumRunnerMinutes === 60 &&
    typeof contract.testPath === 'string' && contract.testPath.endsWith('.integration.test.ts') &&
    typeof contract.cardPath === 'string' && contract.cardPath.startsWith(
      'midgard/packages/officeaicopilot-agent-excel/tests/integration/behavior-cards/'),
  'Invalid SDX live E2E contract', 'blocked-config');
  const { job, build } = observation;
  requireThat(job?.jobId === contract.jobId && job.state === 'Completed' && job.result === 'Success' &&
    job.promptSha256 === contract.promptSha256 && job.pipelineRun?.runId === build?.id &&
    job.pipelineRun?.definitionId === contract.pipelineDefinitionId &&
    build.definitionId === contract.pipelineDefinitionId && build.status === 'completed' && build.result === 'succeeded',
  'SDX live E2E job/build identity or result differs', 'blocked-result');
  const elapsed = Date.parse(build.finishTime) - Date.parse(build.startTime);
  requireThat(Number.isFinite(elapsed) && elapsed > 0 && elapsed <= contract.maximumRunnerMinutes * 60000,
    'SDX live E2E exceeded its runner budget', 'blocked-result');

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
    return ['powershell', 'bash', 'shell'].includes(start.toolName) && complete?.success === true &&
      complete.shellExecution?.exitCode === 0;
  }).map(start => start.arguments?.command ?? '').join('\n');
  requireThat(commands.includes(contract.baseRevision) && commands.includes(contract.profileSha256) &&
    commands.includes(contract.skillSha256) && commands.includes(contract.testPath) &&
    stages.every(stage => commands.includes(stage)),
  'Original Agency commands do not bind the source, native skill, authored test and gates', 'blocked-result');

  const root = join(dropRoot, 'sdx-live-e2e'), result = read(join(root, 'result.json'));
  requireThat(revision.test(result.candidate ?? '') && result.candidate !== contract.baseRevision &&
    result.baseRevision === contract.baseRevision && result.parent === contract.baseRevision &&
    result.profileSha256 === contract.profileSha256 && result.skillSha256 === contract.skillSha256 &&
    Array.isArray(result.stages) && result.stages.length === stages.length &&
    result.stages.every((stage, index) => stage.stage === stages[index] && stage.exitCode === 0) &&
    result.gitStatus === '' && result.repairCount >= 0 && result.repairCount <= 2,
  'SDX live E2E result does not prove an authored committed candidate and ordered gates', 'blocked-result');
  const changed = read(join(root, 'changed-files.json'));
  requireThat(Array.isArray(changed) && changed.includes(contract.testPath) && changed.includes(contract.cardPath) &&
    changed.some(path => /^midgard\/change\/change-[a-f0-9-]+\.json$/.test(path)) &&
    changed.every(path => path === contract.testPath || path === contract.cardPath ||
      /^midgard\/change\/change-[a-f0-9-]+\.json$/.test(path)),
  'SDX authored commit escaped its test/card/changefile scope', 'blocked-result');
  const review = read(join(root, 'review.json'));
  requireThat(review.schema === 'sdx-native-review-v1' && review.candidate === result.candidate &&
    review.verdict === 'approved' && Array.isArray(review.findings) && review.findings.length === 0 &&
    review.skillSha256 === contract.skillSha256 && review.testPath === contract.testPath &&
    review.cardPath === contract.cardPath,
  'Independent SDX review did not approve the exact candidate', 'blocked-result');
  const jest = read(join(root, 'jest-artifacts', 'jest-result.json'));
  requireThat(jest.success === true && jest.numTotalTests > 0 && jest.numPassedTests === jest.numTotalTests &&
    jest.numFailedTests === 0, 'SDX live E2E has no nonzero passing Jest population', 'blocked-result');
  const inventory = read(join(root, 'inventory.json'));
  const actual = files(root).filter(path => !path.endsWith(`${sep}inventory.json`)).map(path => {
    const bytes = readFileSync(path);
    return { path: relative(root, path).split(sep).join('/'), bytes: bytes.length, sha256: hash(bytes) };
  });
  requireThat(JSON.stringify(inventory) === JSON.stringify(actual),
    'SDX live E2E inventory differs from downloaded bytes', 'blocked-result');
  return { status: 'passed', controllerAcceptance: true, executionLocation: 'agency-remote',
    jobId: job.jobId, buildId: build.id, baseRevision: contract.baseRevision, candidate: result.candidate,
    suiteCount: jest.numTotalTestSuites, testCount: jest.numTotalTests, repairCount: result.repairCount,
    nativeSkill: 'pinned-custom-agent', review: 'approved', publicationPerformed: false };
}
