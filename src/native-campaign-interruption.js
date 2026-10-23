import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { hash, json, requireThat } from './common.js';
import { operationDetail } from './operation-evidence.js';
import { verifyNativeFailureEnvelope } from './native-business-revalidation.js';

export function verifyInterruptedNativeBatch(detail, failure, summary, profileSha256, evidence) {
  verifyNativeFailureEnvelope(detail.priorJob, detail.priorResult, detail.operations,
    failure, profileSha256);
  const auth = detail.authorization;
  requireThat(summary?.status === 'running' && Array.isArray(summary.cases) &&
    summary.cases.length > 0 && summary.cases.length < 5 &&
    summary.cases.every((item, index) => item.repeatEachIndex === index &&
      item.retry === 0 && item.expectedStatus === 'passed' && item.status === 'passed') &&
    evidence.resultId === detail.priorResult.id &&
    evidence.attemptId === detail.priorJob.session_id &&
    evidence.sourceRevision === detail.priorResult.sourceRevision &&
    evidence.outcome === 'blocked' && evidence.summaryStatus === 'running' &&
    evidence.fifthCaseFinalized === false &&
    json(evidence.cases) === json(summary.cases.map(item => ({
      repeat: item.repeatEachIndex, status: item.status, expectedStatus: item.expectedStatus,
      retry: item.retry, durationMs: item.durationMs
    }))) &&
    evidence.artifact?.path === auth.failure.path &&
    json(evidence.artifact.output) === json({
      exitCode: failure.output.exitCode, timeout: failure.output.timeout,
      stderr: failure.output.stderr, cleanupDetails: failure.output.cleanupDetails,
      cleanupFailures: failure.output.cleanupFailures ?? [], residualPaths: failure.output.residualPaths ?? []
    }) &&
    evidence.evidence?.[auth.failure.path]?.sha256 === auth.failure.sha256 &&
    evidence.evidence?.[auth.nativeSummary.path]?.sha256 === auth.nativeSummary.sha256 &&
    Object.entries(evidence.evidence).every(([path, source]) =>
      hash(readFileSync(path)) === source.sha256),
  'Interrupted admission requires the exact original incomplete batch and sealed evidence',
  'blocked-reconciliation');
  const jobPaths = Object.keys(evidence.evidence).filter(path => /[\\/]job\.json$/.test(path));
  requireThat(jobPaths.length === 1,
    'Interrupted admission requires one original Windows Job receipt', 'blocked-reconciliation');
  const receipt = name => {
    const path = join(dirname(jobPaths[0]), `${name}.json`);
    requireThat(evidence.evidence[path],
      'Interrupted admission is missing an original termination receipt', 'blocked-reconciliation');
    return JSON.parse(readFileSync(path));
  };
  const job = receipt('job');
  requireThat(['startedAt', 'completedAt', 'exitCode', 'timeout', 'ownedProcessesExited',
    'containmentFailure'].every(key => job[key] === evidence.job[key]) &&
    json(receipt('owned-browser-closed')) === json(evidence.closed) &&
    json(receipt('owned-browser-cleanup')) === json(evidence.outerPages) &&
    json(receipt('driver-failure')) === json(evidence.driverFailure),
  'Interrupted admission termination facts differ from the original receipts',
  'blocked-reconciliation');
  const pagesPath = join(dirname(dirname(auth.nativeSummary.path)), 'browser-cleanup.json');
  requireThat(evidence.evidence[pagesPath],
    'Interrupted admission requires the original native page receipt', 'blocked-reconciliation');
  const pages = JSON.parse(readFileSync(pagesPath));
  requireThat(pages.before?.length === evidence.nativePageCounts.before &&
    pages.after?.length === evidence.nativePageCounts.after,
  'Interrupted admission page counts differ from the original receipt', 'blocked-reconciliation');
  requireThat(evidence.job?.exitCode === 1 && evidence.job.timeout === false &&
    evidence.job.ownedProcessesExited === true && evidence.job.containmentFailure === false &&
    evidence.closed?.ownedBrowserClosed === true &&
    evidence.closed.originalBrowserContacted === false &&
    evidence.outerPages?.existingOwnedPagesPreserved === false &&
    evidence.outerPages.originalBrowserContacted === false &&
    evidence.nativePageCounts?.before === 1 && evidence.nativePageCounts.after === 2 &&
    evidence.driverFailure?.automaticReplayAllowed === false &&
    evidence.workspaceAbsent === true &&
    failure.output.cleanupDetails?.length === 1 &&
    failure.output.cleanupDetails[0].rootRemoved === true &&
    (failure.output.cleanupFailures === undefined ||
      Array.isArray(failure.output.cleanupFailures) && failure.output.cleanupFailures.length === 0) &&
    (failure.output.residualPaths === undefined ||
      Array.isArray(failure.output.residualPaths) && failure.output.residualPaths.length === 0),
  'Interrupted admission requires exited owned processes and actual workspace cleanup, not a live batch',
  'blocked-reconciliation');
  const predecessor = operationDetail(detail.operations.find(row =>
    row.kind === 'continued-from-validation-failure'), detail.priorStateDirectory);
  const ref = predecessor.authorization.preflight;
  requireThat(hash(readFileSync(ref.path)) === ref.sha256 &&
    !existsSync(JSON.parse(readFileSync(ref.path)).workspace),
  'The interrupted predecessor workspace must actually be absent', 'blocked-reconciliation');
}

export function verifyCampaignCommandBudget(config, detail, pin) {
  const adjustment = detail.authorization.commandBudgetAdjustment;
  if (!adjustment) return config;
  const original = pin(adjustment.originalConfig);
  const expected = structuredClone(original);
  expected.stateDirectory = config.stateDirectory;
  const repo = expected.repositories.find(row => row.id === detail.priorAssignment.repoId);
  const gate = repo?.validationGates?.[0];
  requireThat(adjustment.kind === 'native-command-budget-adjustment-v1' &&
    adjustment.sourceRevision === detail.authorization.sourceRevision &&
    adjustment.previousCommandTimeoutMs === 1800000 &&
    adjustment.commandTimeoutMs === 3000000 &&
    repo?.validationGates.length === 1 && gate?.timeoutMs === 3600000 &&
    gate.declarativeE2E?.commandTimeoutMs === undefined,
  'Only a bounded 30-to-50-minute Controller command budget adjustment is permitted',
  'blocked-authorization');
  requireThat(json(expected) === json(config) &&
    json({ ...original, stateDirectory: null }) ===
      json({ ...detail.previousConfig, stateDirectory: null }),
  'Command budget adjustment must not change the profile, gate budget, flights or business settings',
  'blocked-authorization');
  return original;
}
