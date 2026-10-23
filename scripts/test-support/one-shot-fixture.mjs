import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { configAt, hash, json, now } from '../../src/common.js';
import { Ledger } from '../../src/ledger.js';
import { area } from '../../src/sources.js';
import { openApp } from '../../src/app-native.js';
import { loadFilterCorpus } from '../../src/filter.js';
import { prepareFilterBatches, checkFilterBatchResult } from '../../src/filter-batches.js';
import { recordAgencySubmission, recordAgencyAnalysisCheck, reconcileAgencyResult } from '../../src/agency-executor.js';
import { repositoryValidationContract, skillQualificationId } from '../../src/repository-skills.js';
import { beginOneShotCollection, advanceOneShotCollection, readOneShotCollectionReceipt } from '../../src/one-shot-collection.js';
import { advanceOneShotHandoff, prepareOneShotFilterBudget, reserveOneShotFilterRequest } from '../../src/one-shot-handoff.js';

const bytes = value => `${JSON.stringify(value, null, 2)}\n`;
const sha = value => hash(bytes(value));
export async function setup(t, { candidate = false, terminal = true, workiq = false, gitSource = false,
  filterLimits = {}, empty = false, local = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'one-shot-handoff-'));
  const config = configAt('pilot.example.json');
  config.stateDirectory = join(root, 'collector');
  config.statePolicy.accessApproved = true;
  config.sources.ado = { enabled: !workiq, scopeApproved: true };
  config.sources.workiq.enabled = workiq;
  config.sources.workiq.scopeApproved = true;
  config.runtime.workiqCli.enabled = true;
  config.dryRun.limits = { maxItems: 10, maxCalls: 10 };
  const collector = new Ledger(config.stateDirectory);
  const collectionInput = { format: 'one-shot-collection-v1', runId: 'fresh', owner: 'test',
    dryRun: true, passes: [workiq ? 'workiq:created' : 'ado:created'],
    authorization: { approvedBy: 'test', approvedAt: now(), approvalRef: 'synthetic-only',
      deadlineAt: new Date(Date.now() + 60000).toISOString(), maxItems: 10, maxCalls: 10 } };
  // Bootstrap synthetic collection without spending its authorization on host I/O delays.
  t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
  let collected;
  try {
    beginOneShotCollection(config, collector, collectionInput);
    collected = await advanceOneShotCollection(config, collector, 'fresh', {
      adoTransport: async () => async (endpoint, body) => endpoint === 'wiql'
        ? { asOf: '2026-10-09T00:00:00Z', workItems: empty || body.query.includes('[System.Id] = 0') ? [] : [{ id: 1 }] }
        : { value: [{ id: 1, rev: 1, fields: { 'System.WorkItemType': 'Bug', 'System.AreaPath': area,
          'System.Title': 'Synthetic functional behavior', 'System.State': 'Resolved',
          'Microsoft.VSTS.Common.ResolvedReason': 'Fixed',
          'System.CreatedDate': '2026-10-08T01:00:00Z', 'System.ChangedDate': '2026-10-08T02:00:00Z' } }] },
      workiqFactory: async () => ({ read: async path => ({ structuredContent: { results: [{ statusCode: 200,
        data: path.startsWith('/me?') ? { id: config.identity.objectId, userPrincipalName: config.identity.designatedUser }
          : { value: empty || path.includes('/replies') ? [] : [{ id: 'root', createdDateTime: '2026-10-08T01:00:00Z',
            lastModifiedDateTime: '2026-10-08T01:00:00Z', subject: 'Synthetic functional behavior',
            body: { contentType: 'text', content: 'Synthetic body' }, webUrl: 'https://example.invalid/root' }] } }] } }),
        close: async () => {} })
    });
  } finally { t.mock.timers.reset(); }
  assert.equal(collected.state, 'held-awaiting-filter', json(collected.blocker));
  const collectionReceipt = readOneShotCollectionReceipt(config, collector, 'fresh');
  const collectionConfig = structuredClone(config);
  const collection = { stateDirectory: config.stateDirectory, runId: 'fresh', receiptSha256: collected.receiptSha256 };
  config.stateDirectory = join(root, 'proposer');
  config.activation.dispatch = true;
  Object.assign(config.limits, { maxItems: 10, maxCalls: 10, workerMaxToolCalls: 20,
    maxWorkers: 2, workerMinutes: 1, maxAiCreditsPerSession: 1, maxValidationRepairRounds: 0 });
  const ledger = new Ledger(config.stateDirectory), execution = new Ledger(join(root, 'filter-execution'));
  t.after(() => { execution.close(); ledger.close(); collector.close(); rmSync(root, { recursive: true, force: true }); });
  let sourceRevision = 'a'.repeat(40);
  if (gitSource) {
    const git = args => execFileSync('git', ['-C', root, ...args], { encoding: 'utf8' }).trim();
    git(['init', '--quiet']);
    git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
      '-c', 'core.hooksPath=missing-hooks', 'commit', '--quiet', '--allow-empty', '-m', 'Synthetic only']);
    sourceRevision = git(['rev-parse', 'HEAD']);
  }
  const skillPath = '.github/skills/integration-test-authoring/SKILL.md';
  config.repositories = [{ id: 'target', projectId: 'fixture', owner: 'test', routingApproved: true,
    qualificationRefresh: 'local', validationContractVersion: '1.0',
    routingRules: ['Synthetic'], referenceCheckout: root, baseRef: 'HEAD', remote: 'https://example.invalid/test.git',
    allowedWritePrefixes: ['test'], allowedWriteFiles: [], commitIdentity: { name: 'Fixture', email: 'fixture@example.invalid' },
    validationGates: [{ id: 'synthetic-test', approved: true, isolationVerified: true, executable: process.execPath,
      args: ['--test'], timeoutMs: 10000 }],
    skillBindings: [{ id: 'integration', capability: 'integration-test-authoring', skillPath, enabled: true,
      allowedWritePrefixes: ['test'], requiresBehaviorCard: false, authoringProvider: 'copilot-sdk',
      qualification: 'qualified', requestedOutcomes: ['add-or-update-tests'],
      sideEffects: { commit: true, push: true, createDraftPR: true } }] }];
  const contract = repositoryValidationContract(config.repositories[0]);
  ledger.qualify(skillQualificationId('target', 'integration'), {
    state: 'qualified-read-only', repoId: 'target', bindingId: 'integration', capability: 'integration-test-authoring',
    referenceCheckout: root, remote: config.repositories[0].remote, baseRef: 'HEAD', baseRevision: sourceRevision,
    skillPath, skillSha256: hash('synthetic skill'), qualificationSource: 'local-reference',
    validationContractVersion: contract.version, validationContractSha256: contract.sha256,
    sideEffects: { commit: true, push: true, createDraftPR: true }
  });
  const verificationRef = join(root, 'token-approval.json');
  writeFileSync(verificationRef, '{"synthetic":true}');
  config.filterBatching = { approved: true, mode: 'verified', model: 'synthetic', profile: 'synthetic',
    tokenizer: 'synthetic', verifiedBy: 'test', verifiedAt: now(), verificationRef,
    verificationSha256: hash(readFileSync(verificationRef)), contextTokens: 1000, maxInputTokens: 500,
    maxPayloadBytes: 1000000, maxBatches: 1,
    reserves: { instructions: 10, sourceAnalysis: 20, output: 100, safety: 10, requestOverhead: 5 } };
  const corpus = loadFilterCorpus(config, { format: 'stage2-sources-v1', sources: collectionReceipt.snapshot.sources });
  const request = { format: 'filter-batch-request-v1', sources: collectionReceipt.snapshot.sources,
    instructions: 'Synthetic instructions only', groups: corpus.evidence.map((record, i) =>
      ({ id: `g${i}`, memberIds: [record.id], contextIds: [], reason: 'Synthetic independent report' })),
    groupingReview: { reviewer: 'test', reviewedAt: now(), rationale: 'Synthetic context' },
    sharing: { audience: 'synthetic-only', approvalRef: 'synthetic-only',
      materials: [...new Set([...corpus.evidence.map(sha), ...corpus.captures.map(c => c.sha256),
        ...corpus.contexts.map(c => c.sha256), hash('Synthetic instructions only'),
        sha(corpus.coverage.map(({ runId, coverage }) => ({ runId, coverage })))])]
        .map(sha256 => ({ sha256, eligibility: 'approved', restrictions: ['synthetic-only'] })) } };
  const manifestPath = join(root, 'manifest.json');
  await prepareFilterBatches(config, request, manifestPath, async (_config, input) =>
    ({ sha256: input.sha256, model: input.model, tokenizer: input.tokenizer, tokens: 5 }));
  const manifest = JSON.parse(readFileSync(manifestPath)), batch = manifest.batches[0];
  const resultPath = join(root, 'result.json');
  const input = { format: 'one-shot-handoff-v1', owner: 'test', collection,
    filter: { manifestPath, manifestSha256: hash(readFileSync(manifestPath)),
      executionLedgerPath: join(execution.directory, 'ledger.sqlite'), resultPaths: batch ? [resultPath] : [] },
    routing: { capability: 'integration-test-authoring' },
    authorization: { approvedBy: 'test', approvedAt: now(), approvalRef: 'synthetic-only',
      deadlineAt: new Date(Date.now() + 60000).toISOString(),
      maxFilterRequests: 1, maxFilterExecutionSeconds: 600, maxFilterReservedTokens: 1000,
      maxProposers: 1, maxProposerAiCredits: 1, authorizeCommit: true, authorizePush: true, authorizeDraftPR: true,
      ...filterLimits } };
  config.agency = { profiles: {}, selections: [], budgetId: 'one-shot-fixture',
    maxRequests: 1, maxConcurrent: 1, maxDraftPullRequests: 0, maxExecutionSeconds: 600,
    preflightMaxAgeSeconds: 300, monitorOwner: 'test', monitorCadenceSeconds: 60 };
  if (!batch) {
    prepareOneShotFilterBudget(config, execution, input);
    return { config, ledger, collector, collectionConfig, input, execution, manifest };
  }
  const payload = JSON.parse(JSON.parse(batch.payload).payload);
  const result = { format: 'filter-batch-result-v1', cohortId: manifest.cohortId, batchId: batch.id,
    payloadSha256: batch.analysisPayloadSha256, status: 'complete',
    titles: { format: 'filter-title-decisions-v1', indexSha256: batch.indexSha256, reviewer: 'test', reviewedAt: now(),
      decisions: payload.index.entries.map(e => ({ evidenceId: e.evidenceId, source: e.source,
        captureSha256: e.captureSha256, disposition: e.title ? 'needs-details' : 'no-title',
        exclusionType: null, reason: 'Synthetic review', titleQuote: null })) },
    details: payload.index.entries.map(e => ({ evidenceId: e.evidenceId, recordSha256: e.recordSha256,
      captureSha256: e.captureSha256, status: 'reviewed', reason: 'Synthetic reviewed' })),
    candidates: candidate ? [{ id: 'candidate', evidenceIds: corpus.evidence.map(e => e.id),
      repository: 'target', sourceRevision, layer: 'integration', missingAssertion: 'Synthetic invariant',
      existingCoverage: ['Synthetic inspected assertion'], harness: 'Synthetic harness', coverageStatus: 'gap',
      blockers: [], priority: 50, confidence: 0.8, rationale: 'Synthetic coverage gap' }] : [] };
  if (local) {
    config.filterExecutor = 'local-sdk'; config.activation.review = true;
    config.limits.maxAiCreditsPerSession = 30;
    config.localFilter = { enabled: true, acceptSoftCreditLimit: true, maxRequests: 1, maxToolCalls: 5,
      timeoutMs: 10000, maxSourceBytes: 10000, maxRequestBytes: 1000000, sources: [] };
    input.authorization.maxFilterAiCredits = 30;
    return { config, ledger, collector, collectionConfig, input, execution, manifest, result, resultPath };
  }
  writeFileSync(resultPath, bytes(result));
  const profile = { organization: 'synthetic', project: 'synthetic', repository: 'synthetic', initMode: 'lite' };
  const selection = { taskId: batch.id, repoId: 'target', role: 'filter', suiteId: 'analysis',
    profileId: 'synthetic', qualificationId: 'synthetic', qualificationSha256: '',
    sourceRevision, targetRef: 'refs/heads/main', payloadSha256: batch.payloadSha256,
    analysisPayloadSha256: batch.analysisPayloadSha256, instructionsSha256: hash(request.instructions),
    resultKind: 'analysis', allowPush: false, dispatchAllowed: true, maxExecutionSeconds: 600,
    allowedPaths: [], forbiddenPaths: [], caseContract: { cases: [], scenarios: [], commands: [] },
    analysisPolicy: { id: 'local-readonly-filter-v1', approvedBy: 'test', approvedAt: now(), approvalRef: 'synthetic-only' } };
  const q = { status: 'qualified', binding: {
    repoId: selection.repoId, role: selection.role, suiteId: selection.suiteId, profileId: selection.profileId,
    profileSha256: hash(json(profile)), sourceRevision, targetRef: selection.targetRef,
    instructionsSha256: selection.instructionsSha256, caseContractSha256: hash(json(selection.caseContract)),
    analysisPolicy: selection.analysisPolicy
  }, runtime: { modelId: 'synthetic', tokenizerId: 'synthetic', contextTokens: 1000, maxOutputTokens: 100 },
  expiresAt: new Date(Date.now() + 60000).toISOString(), evidenceRef: 'synthetic-only' };
  selection.qualificationSha256 = hash(json(q)); execution.qualify('synthetic', q);
  Object.assign(config.agency, { profiles: { synthetic: profile }, selections: [selection] });
  const wire = json({ organization: profile.organization, project: profile.project, repository: profile.repository,
    targetBranch: 'main', prompt: batch.payload, options: { allowPush: false,
      pullRequest: { create: false, publish: false }, branch: { createSourceBranch: false } }, metadata: { initMode: 'lite' } });
  const reservation = { request: wire, requestSha256: hash(wire),
    preflight: { repoId: 'target', targetRef: selection.targetRef, sourceRevision, observedAt: now(), requestSha256: hash(wire) },
    tokenBudget: { payloadSha256: batch.payloadSha256, modelId: 'synthetic', tokenizerId: 'synthetic', inputTokens: 5 } };
  const budget = prepareOneShotFilterBudget(config, execution, input);
  assert.equal(budget.state, 'reserved-not-submitted');
  assert.deepEqual(prepareOneShotFilterBudget(config, execution, input), budget);
  reserveOneShotFilterRequest(config, execution, input, batch.id, reservation);
  recordAgencySubmission(execution, batch.id, { operation: 'jobs-create', state: 'accepted', requestSha256: hash(wire),
    jobId: 'synthetic-job', httpStatus: 202, observedAt: now() });
  recordAgencyAnalysisCheck(execution, batch.id, bytes(result), value => {
    const checked = checkFilterBatchResult(config, manifest, JSON.parse(value));
    return Object.fromEntries(['state', 'payloadSha256', 'resultSha256', 'validator'].map(key => [key, checked[key]]));
  });
  const refs = [{ ref: 'job-local:synthetic-job:proof', sha256: hash('synthetic-proof') }];
  const terminalInput = { requestSha256: hash(wire), jobId: 'synthetic-job', observedAt: now(),
    provider: { state: 'Completed', result: 'Success' }, pipeline: { id: 'synthetic-build', state: 'completed', result: 'succeeded' },
    runtime: { profileId: 'synthetic', instructionsSha256: selection.instructionsSha256, modelId: 'synthetic', tokenizerId: 'synthetic' },
    source: { repoId: 'target', targetRef: selection.targetRef, baseRevision: sourceRevision, checkoutRevision: sourceRevision,
      outputRevision: null, testedRevision: null, commitParents: null, changedPaths: null,
      unchangedDuringValidation: null, evidenceRefs: refs }, inspection: { approved: true, evidenceRefs: refs },
    publication: null, validation: null, analysis: { payloadSha256: batch.analysisPayloadSha256,
      resultSha256: hash(bytes(result)), validator: 'filter-batch-result-v1', membershipValidated: true, evidenceRefs: refs } };
  if (terminal) assert.equal(reconcileAgencyResult(execution, batch.id, terminalInput).state, 'completed');
  return { config, ledger, collector, collectionConfig, input, execution, manifest, result, resultPath,
    terminalInput, reservation };
}
