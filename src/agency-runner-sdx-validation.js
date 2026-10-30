import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { requireThat } from './common.js';

const stages = ['fingerprint', 'authentication-check', 'authentication', 'dependencies', 'compile', 'policy', 'test'];
const digest = /^[a-f0-9]{64}$/;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

function files(root) {
  const output = [];
  function walk(directory) {
    requireThat(!lstatSync(directory).isSymbolicLink(), 'Agency artifact directories cannot be links', 'blocked-result');
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      requireThat(!stat.isSymbolicLink() && (!stat.isFile() || stat.nlink <= 1),
        'Agency artifact links are not accepted', 'blocked-result');
      if (stat.isDirectory()) walk(path);
      else output.push(path);
    }
  }
  walk(root);
  return output;
}

function managedEvents(root) {
  const paths = files(root).filter(path => path.endsWith(`${sep}events.jsonl`) &&
    !path.includes(`${sep}classification${sep}`));
  requireThat(paths.length === 1, 'Exactly one original Agency session event stream is required', 'blocked-result');
  return readFileSync(paths[0], 'utf8').split(/\r?\n/).filter(Boolean).map(line => JSON.parse(line));
}

function verifyFixedCandidateEvidence(contract, observation, agencyRoot, dropRoot) {
  requireThat(contract?.schema === 'agency-runner-sdx-validation-v1' &&
    /^[a-f0-9]{40}$/.test(contract.baseRevision ?? '') && /^[a-f0-9]{40}$/.test(contract.candidate ?? '') &&
    digest.test(contract.profileSha256 ?? '') && digest.test(contract.promptSha256 ?? '') &&
    Number.isSafeInteger(contract.pipelineDefinitionId) && contract.pipelineDefinitionId > 0 &&
    contract.maximumRunnerMinutes === 30,
  'Invalid SDX Agency runner contract', 'blocked-config');
  const { job, build } = observation;
  requireThat(job?.jobId === contract.jobId && job.state === 'Completed' && job.result === 'Success' &&
    job.promptSha256 === contract.promptSha256 &&
    job.pipelineRun?.runId === build?.id && job.pipelineRun?.definitionId === contract.pipelineDefinitionId &&
    build.definitionId === contract.pipelineDefinitionId && build.status === 'completed' && build.result === 'succeeded',
  'Agency job and actual build identity/result differ', 'blocked-result');
  const elapsed = Date.parse(build.finishTime) - Date.parse(build.startTime);
  requireThat(Number.isFinite(elapsed) && elapsed > 0 && elapsed <= contract.maximumRunnerMinutes * 60000,
    'Actual Agency runner duration exceeds the authorized budget', 'blocked-result');

  const events = managedEvents(agencyRoot);
  const starts = new Map(events.filter(event => event.type === 'tool.execution_start')
    .map(event => [event.data?.toolCallId, event.data]));
  const completes = new Map(events.filter(event => event.type === 'tool.execution_complete')
    .map(event => [event.data?.toolCallId, event.data]));
  const successfulShell = [...starts.values()].filter(start => {
    const complete = completes.get(start.toolCallId);
    return ['powershell', 'bash', 'shell'].includes(start.toolName) && complete?.success === true &&
      complete.shellExecution?.exitCode === 0;
  });
  const commands = successfulShell.map(start => start.arguments?.command ?? '').join('\n');
  requireThat(successfulShell.length > 0 && commands.includes(contract.candidate) &&
    commands.includes(contract.profileSha256) && stages.every(stage => commands.includes(stage)),
  'Original Agency shell events do not bind the candidate, profile and every stage', 'blocked-result');

  const root = join(dropRoot, 'sdx-poc'), profilePath = join(root, '1js-sdx-excel-integration.ps1');
  requireThat(hash(readFileSync(profilePath)) === contract.profileSha256,
    'Downloaded SDX profile bytes differ', 'blocked-result');
  const result = read(join(root, 'result.json'));
  requireThat(result.baseRevision === contract.baseRevision && result.candidate === contract.candidate &&
    result.profileSha256 === contract.profileSha256 && result.head === contract.candidate &&
    Array.isArray(result.stages) && result.stages.length === stages.length &&
    result.stages.every((stage, index) => stage.stage === stages[index] && stage.exitCode === 0),
  'SDX result does not prove every ordered gate passed on the fixed candidate', 'blocked-result');
  requireThat(readFileSync(join(root, 'git-status.txt'), 'utf8').trim() === '',
    'Product workspace was not clean after validation', 'blocked-result');

  const jestRoot = join(root, 'jest-artifacts');
  const run = read(join(jestRoot, 'run.json')), jest = read(join(jestRoot, 'jest-result.json'));
  const discovery = read(join(jestRoot, 'discovered-tests.json'));
  const selection = read(join(jestRoot, 'selection.json'));
  requireThat(run.state === 'passed' && run.baseRevision === contract.baseRevision &&
    run.revision === contract.candidate && run.selectedSuiteCount > 0 && run.resultPresent === true &&
    jest.success === true && jest.numTotalTests > 0 && jest.numPassedTests === jest.numTotalTests &&
    Array.isArray(jest.testResults) && jest.testResults.length === run.selectedSuiteCount &&
    jest.testResults.every(suite => Array.isArray(suite.assertionResults) && suite.assertionResults.length > 0 &&
      suite.assertionResults.every(assertion => assertion.status === 'passed')) &&
    Array.isArray(discovery) && discovery.length > 0 && Array.isArray(selection.expectedPaths) &&
    selection.expectedPaths.length === run.selectedSuiteCount,
  'Raw native Jest artifacts do not prove a nonzero passing population', 'blocked-result');

  const inventory = read(join(root, 'inventory.json'));
  const actual = files(root).filter(path => !path.endsWith(`${sep}inventory.json`)).map(path => {
    const bytes = readFileSync(path);
    return { path: relative(root, path).split(sep).join('/'), bytes: bytes.length, sha256: hash(bytes) };
  });
  requireThat(JSON.stringify(inventory) === JSON.stringify(actual),
    'SDX artifact inventory differs from downloaded bytes', 'blocked-result');
  return { status: 'passed', controllerAcceptance: true, executionLocation: 'agency-remote',
    jobId: job.jobId, buildId: build.id, sourceRevision: contract.candidate,
    profileSha256: contract.profileSha256, suiteCount: run.selectedSuiteCount,
    testCount: jest.numTotalTests, passedCount: jest.numPassedTests };
}

export function verifyAgencyRunnerSdxFixedCandidatePoc(contract, observation, agencyRoot, dropRoot) {
  return { ...verifyFixedCandidateEvidence(contract, observation, agencyRoot, dropRoot),
    scope: 'fixed-candidate-poc', nativeSkillInvocation: 'not-claimed' };
}

export function verifyAgencyRunnerSdxValidation(contract, observation, agencyRoot, dropRoot) {
  const result = verifyFixedCandidateEvidence(contract, observation, agencyRoot, dropRoot);
  const events = managedEvents(agencyRoot);
  requireThat(events.some(event => event.type === 'skill.invoked' &&
    event.data?.name === 'excel-agent-integration-tests' &&
    String(event.data?.path ?? '').replaceAll('\\', '/').endsWith(
      'midgard/packages/officeaicopilot-agent-excel/.github/skills/excel-agent-integration-tests/SKILL.md')),
  'The repository-native SDX skill was not invoked', 'blocked-result');
  return result;
}
