import { createHash } from 'node:crypto';
import { lstatSync, readFileSync, readdirSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { requireThat } from './common.js';

const digest = /^[a-f0-9]{64}$/;
const revision = /^[a-f0-9]{40}$/;
const expectedOwners = [
  'excel-agent-in-container-proxy',
  'session-protocol',
  'doclab-serialization',
  'eval-vnext-config-resolver'
];
const expectedSteps = ['cli-build', 'workspace-build', 'eslint', 'test'];
const allowedPrefixes = [
  'server/session-protocol/test/integration-evolution/',
  'utils/doclab-serialization/tests/',
  'utils/eval-vnext-config-resolver/tests/',
  'utils/excel-agent-in-container-proxy/tests/'
];
const hash = value => createHash('sha256').update(value).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8').replace(/^\uFEFF/, ''));

function files(root) {
  const output = [];
  function walk(directory) {
    requireThat(!lstatSync(directory).isSymbolicLink(), 'AL evidence directories cannot be links', 'blocked-result');
    for (const name of readdirSync(directory).sort()) {
      const path = join(directory, name), stat = lstatSync(path);
      requireThat(!stat.isSymbolicLink() && (!stat.isFile() || stat.nlink <= 1),
        'AL evidence links are not accepted', 'blocked-result');
      if (stat.isDirectory()) walk(path);
      else output.push(path);
    }
  }
  walk(root);
  return output;
}

function managedEvents(agencyRoot) {
  const paths = files(agencyRoot).filter(path => path.endsWith(`${sep}events.jsonl`) &&
    !path.includes(`${sep}classification${sep}`));
  requireThat(paths.length === 1, 'Exactly one original Agency event stream is required', 'blocked-result');
  return readFileSync(paths[0], 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse);
}

export function verifyAgencyRunnerAlLiveE2e(contract, observation, agencyRoot, dropRoot) {
  requireThat(contract?.schema === 'agency-runner-al-live-e2e-v1' &&
    revision.test(contract.baseRevision ?? '') && digest.test(contract.promptSha256 ?? '') &&
    digest.test(contract.skillSha256 ?? '') && digest.test(contract.runnerSha256 ?? '') &&
    digest.test(contract.preloadSha256 ?? '') && Number.isSafeInteger(contract.pipelineDefinitionId) &&
    contract.pipelineDefinitionId > 0 && contract.model === 'gpt-6-luna' &&
    contract.softCreditLimit === 30 && contract.maxModelSessions === 1 &&
    contract.maxRepairAttempts === 2 && contract.maximumJobMinutes === 90 &&
    contract.maximumControllerMinutes === 180,
  'Invalid AL live E2E contract', 'blocked-config');
  const { job, build } = observation;
  requireThat(job?.jobId === contract.jobId && job.state === 'Completed' && job.result === 'Success' &&
    job.promptSha256 === contract.promptSha256 && job.pipelineRun?.runId === build?.id &&
    job.pipelineRun?.definitionId === contract.pipelineDefinitionId &&
    build?.definitionId === contract.pipelineDefinitionId && build.status === 'completed' &&
    build.result === 'succeeded',
  'AL live E2E job/build identity or result differs', 'blocked-result');
  const elapsed = Date.parse(build.finishTime) - Date.parse(build.startTime);
  requireThat(Number.isFinite(elapsed) && elapsed > 0 && elapsed <= contract.maximumControllerMinutes * 60000,
    'AL live E2E exceeded its controller deadline', 'blocked-result');

  const events = managedEvents(agencyRoot);
  requireThat(events.some(event => event.type === 'skill.invoked' &&
    String(event.data?.path ?? '').replaceAll('\\', '/').endsWith(
      'utils/excel-agent-in-container-proxy/.github/skills/excel-agent-in-container-proxy-integration-tests/SKILL.md')),
  'The repository-native AL authoring skill was not invoked', 'blocked-result');
  const starts = new Map(events.filter(event => event.type === 'tool.execution_start')
    .map(event => [event.data?.toolCallId, event.data]));
  const completes = new Map(events.filter(event => event.type === 'tool.execution_complete')
    .map(event => [event.data?.toolCallId, event.data]));
  const commands = [...starts.values()].filter(start => {
    const complete = completes.get(start.toolCallId);
    return ['powershell', 'bash', 'shell'].includes(start.toolName) && complete?.success === true &&
      complete.shellExecution?.exitCode === 0;
  }).map(start => start.arguments?.command ?? '').join('\n');
  requireThat(commands.includes(contract.baseRevision) && commands.includes(contract.skillSha256) &&
    commands.includes(contract.runnerSha256) && commands.includes(contract.preloadSha256) &&
    expectedOwners.every(owner => commands.includes(owner)),
  'Original Agency commands do not bind the source and prebuilt AL controller', 'blocked-result');

  const root = join(dropRoot, 'al-live-e2e'), receipt = read(join(root, 'receipt.json'));
  requireThat(receipt.schema === 'pea-al-agency-runner-receipt-v1' &&
    receipt.baseRevision === contract.baseRevision && revision.test(receipt.candidate ?? '') &&
    receipt.candidate !== contract.baseRevision && receipt.model === contract.model &&
    receipt.softCreditLimit === contract.softCreditLimit &&
    receipt.maximumJobMinutes === contract.maximumJobMinutes &&
    receipt.maximumControllerMinutes === contract.maximumControllerMinutes &&
    receipt.maxRepairAttempts === contract.maxRepairAttempts &&
    Number.isSafeInteger(receipt.repairAttempt) && receipt.repairAttempt >= 0 &&
    receipt.repairAttempt <= contract.maxRepairAttempts && receipt.status === 'passed' &&
    receipt.controllerAcceptanceClaimed === false && receipt.gateCount === 16 &&
    receipt.excelNativeProof?.traceLoggerBuild === true &&
    receipt.excelNativeProof?.sfNativeBuild === true &&
    receipt.excelNativeProof?.alTraceLoggerNode === true &&
    receipt.excelNativeProof?.perfCounters === true &&
    JSON.stringify(receipt.gateOrder) === JSON.stringify(expectedOwners) &&
    receipt.skill?.sha256 === contract.skillSha256 &&
    Array.isArray(receipt.changedFiles) && receipt.changedFiles.length > 0 &&
    receipt.changedFiles.every(path => allowedPrefixes.some(prefix => path.startsWith(prefix))),
  'AL receipt does not prove a bounded authored candidate and full gate contract', 'blocked-result');
  requireThat(receipt.runner?.originalSha256 === contract.runnerSha256 &&
    digest.test(receipt.runner?.sha256 ?? '') && receipt.preload?.sha256 === contract.preloadSha256 &&
    (!receipt.runner.modifiedRemotely ||
      typeof receipt.runner.repairReason === 'string' && receipt.runner.repairReason.length > 0 &&
      digest.test(receipt.runner.repairPatchSha256 ?? '') &&
      receipt.runner.repairPatchPath === 'assets/augloop-agency-runner.patch'),
  'AL controller bytes or remote repair provenance are incomplete', 'blocked-result');
  const runnerPath = join(root, ...receipt.runner.path.split('/'));
  const preloadPath = join(root, ...receipt.preload.path.split('/'));
  requireThat(hash(readFileSync(runnerPath)) === receipt.runner.sha256 &&
    hash(readFileSync(preloadPath)) === receipt.preload.sha256,
  'Downloaded AL controller bytes differ from the receipt', 'blocked-result');
  if (receipt.runner.modifiedRemotely) {
    const patchPath = join(root, ...receipt.runner.repairPatchPath.split('/'));
    requireThat(hash(readFileSync(patchPath)) === receipt.runner.repairPatchSha256,
      'Downloaded AL controller repair patch differs from the receipt', 'blocked-result');
  }

  const gateIds = new Set();
  for (const owner of expectedOwners) {
    for (const step of expectedSteps) {
      const gate = receipt.gates?.find(value => value.owner === owner && value.step === step);
      requireThat(gate && !gateIds.has(gate.gateId) && gate.exitCode === 0 && gate.timedOut === false &&
        (!step.includes('test') || Number.isSafeInteger(gate.testPopulation) && gate.testPopulation > 0),
      `AL gate ${owner}/${step} did not prove a passing native population`, 'blocked-result');
      gateIds.add(gate.gateId);
      for (const stream of [gate.stdout, gate.stderr]) {
        const path = join(root, ...stream.path.split('/'));
        requireThat(digest.test(stream.sha256 ?? '') && hash(readFileSync(path)) === stream.sha256,
          `AL gate ${gate.gateId} log bytes differ`, 'blocked-result');
      }
    }
  }
  requireThat(gateIds.size === 16 && receipt.gates.length === 16,
    'AL receipt contains missing or additional gates', 'blocked-result');
  const inventory = files(root).map(path => ({
    path: relative(root, path).split(sep).join('/'),
    bytes: readFileSync(path).length,
    sha256: hash(readFileSync(path))
  }));
  return { status: 'passed', controllerAcceptance: true, executionLocation: 'agency-remote',
    jobId: job.jobId, buildId: build.id, candidate: receipt.candidate,
    repairCount: receipt.repairAttempt, runnerModifiedRemotely: receipt.runner.modifiedRemotely,
    gateCount: gateIds.size, artifactCount: inventory.length };
}
