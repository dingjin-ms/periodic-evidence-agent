import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { connect } from 'node:net';
import { configAt, hash, json, now } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import {
  acceptReviewedHandoff, prepareReviewedHandoff, validateReviewedHandoffReceipt
} from '../src/reviewed-handoff.js';
import {
  dispatch, dispatchReviewedHandoff, dispatchAdoTestRequest, command, provision, queueAdoDraftBuild, runValidation,
  createAdoDraft, pushDraftBranch, makePlannedImprovementAssignment, commitRepositoryChanges, requireCurrentAssignment
} from '../src/workers.js';
import { prepareLocalPreModelContinuation } from '../src/local-continuation.js';
import { prepareRuntimeContinuation, claimRuntimeWorkspace } from '../src/runtime-continuation.js';
import { dispatchRuntimeContinuation } from '../src/workers.js';
import { prepareAuthoringToolContinuation, claimAuthoringToolWorkspace } from '../src/authoring-tool-continuation.js';
import { dispatchAuthoringToolContinuation } from '../src/workers.js';
import {
  normalizeSkillInput, repositoryValidationContract, skillQualificationId
} from '../src/repository-skills.js';
import { captureWorkerRsiOutcome, inspectRsiArtifacts, readRsiArtifact, rsiWork } from '../src/rsi-flow.js';
import { pruneState } from '../src/state-retention.js';
import { beginApp, openApp, appWorker } from '../src/app-native.js';
import { remoteValidationContract } from '../src/agency-remote-validation.js';

import { collectTestRequest, prepareTestRequest, acceptTestRequest, readCurrentTestRequest,
  requireTestRequestPublication, verifyCurrentTestRequest } from '../src/ado-test-request.js';
import { runTestRequest } from '../src/test-request-flow.js';
import { recordCapabilityAssessment, publishCapabilityComment, capabilityComment, reconcileCapabilityComment, reconcileHarnessAssociation } from '../src/ado-harness-request.js';

const rsiPolicy = JSON.parse(readFileSync(new URL('../scaffold/rsi-flow.example.json', import.meta.url)));

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/reviewed-handoff/onenote-bootstrap-progress.reviewed-handoff.json', import.meta.url),
  'utf8'));
const repairDrill = JSON.parse(readFileSync(
  new URL('./fixtures/reviewed-handoff/validation-repair-drill.json', import.meta.url),
  'utf8'));
const oneJsFixture = JSON.parse(readFileSync(
  new URL('./fixtures/reviewed-handoff/1js-bizchat-excel.reviewed-handoff.json', import.meta.url),
  'utf8'));
const oneJsDualSuiteFixture = JSON.parse(readFileSync(
  new URL(
    './fixtures/reviewed-handoff/1js-cross-app-and-excel-agent.reviewed-handoff.json',
    import.meta.url
  ),
  'utf8'));
const dualSkillBundle = JSON.parse(readFileSync(
  new URL('./fixtures/reviewed-handoff/oa-and-1js.reviewed-handoff-bundle.json', import.meta.url),
  'utf8'));
const oneJsQualification = JSON.parse(readFileSync(
  new URL('./fixtures/reviewed-handoff/1js-fixture-qualification.mini-spec-batch.json', import.meta.url),
  'utf8'));
const oneJsRepairDrill = JSON.parse(readFileSync(
  new URL('./fixtures/reviewed-handoff/1js-validation-repair-drill.json', import.meta.url),
  'utf8'));
const oneJsRepairRunner = readFileSync(
  new URL('./fixtures/reviewed-handoff/1js-validation-repair-drill.runner.mjs.txt', import.meta.url),
  'utf8');

async function setup(t, { inputFormat = null, sourceCode = 'export const value = 1;\n', capabilitySources = false } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'reviewed-handoff-'));
  const reference = join(root, 'reference');
  const remote = join(root, 'remote.git');
  const state = join(root, 'state');
  const skillPath = '.github/skills/integration-test-authoring/SKILL.md';
  mkdirSync(join(reference, '.github', 'skills', 'integration-test-authoring'), { recursive: true });
  mkdirSync(join(reference, 'src'), { recursive: true });
  writeFileSync(join(reference, skillPath), '# Fixture integration-test skill\nAdd focused tests.\n');
  writeFileSync(join(reference, 'src', 'value.js'), sourceCode);
  if (capabilitySources) {
    mkdirSync(join(reference, 'ooui'));
    for (const name of ['schema', 'runner', 'ui-map'])
      writeFileSync(join(reference, 'ooui', `${name}.txt`), `Synthetic ${name} source\n`);
  }
  const git = args => command('git', ['-c', 'core.hooksPath=.git/no-hooks',
    '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], reference);
  await git(['init', '--quiet']);
  await git(['add', '.']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Fixture base']);
  const baseRevision = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const config = configAt('pilot.example.json');
  config.stateDirectory = state;
  config.statePolicy.accessApproved = true;
  config.limits = {
    ...config.limits,
    maxItems: 100,
    workerMaxToolCalls: 20,
    workerMinutes: 1
  };
  config.limits.maxItems = 10;
  config.limits.workerMaxToolCalls = 20;
  config.repositories = [{
    id: 'office-agent',
    projectId: 'fixture-project',
    owner: 'fixture-owner',
    routingApproved: true,
    routingRules: ['Reviewed handoff integration'],
    referenceCheckout: reference,
    baseRef: 'HEAD',
    remote,
    allowedWritePrefixes: ['test'],
    commitIdentity: { name: 'Fixture', email: 'fixture@example.invalid' },
    validationGates: [{
      id: 'fixture-test',
      approved: true,
      isolationVerified: true,
      executable: process.execPath,
      args: ['--test', 'test/behavior.test.js'],
      timeoutMs: 10000
    }],
    skillBindings: [{
      id: 'oa-integration-test-core',
      capability: 'integration-test-authoring',
      skillPath,
      ...(inputFormat ? { inputFormat } : {}),
      enabled: true,
      qualification: 'qualified',
      requestedOutcomes: ['add-or-update-tests'],
      allowedWritePrefixes: ['test'],
      requiresBehaviorCard: true,
      sideEffects: { commit: true, push: true, createDraftPR: true }
    }]
  }];
  const ledger = new Ledger(state);
  const additionalLedgers = [];
  const validationContract = repositoryValidationContract(config.repositories[0]);
  ledger.qualify(skillQualificationId('office-agent', 'oa-integration-test-core'), {
    state: 'qualified-read-only',
    repoId: 'office-agent',
    bindingId: 'oa-integration-test-core',
    capability: 'integration-test-authoring',
    referenceCheckout: reference,
    remote,
    baseRef: 'HEAD',
    baseRevision,
    skillPath,
    skillSha256: hash('# Fixture integration-test skill\nAdd focused tests.\n'),
    qualificationSource: 'local-reference',
    validationContractVersion: validationContract.version,
    validationContractSha256: validationContract.sha256,
    sideEffects: { commit: true, push: true, createDraftPR: true }
  });
  t.after(() => {
    for (const additional of additionalLedgers) additional.close();
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, remote, config, ledger, baseRevision, additionalLedgers };
}

const formulaSource = `export function removeDuplicates(rows) {
  const seen = new Set();
  return rows.filter(row => {
    const key = JSON.stringify([row.item, row.quantity, row.unitPrice]);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).map((row, index) => ({ ...row, formula: '=B' + (index + 2) + '*C' + (index + 2) }));
}
`;
const formulaTest = `import test from 'node:test';
import assert from 'node:assert/strict';
import { removeDuplicates } from '../src/value.js';
test('deduplication preserves formulas at surviving row positions', () => {
  const rows = [
    { item: 'Pen', quantity: 2, unitPrice: 3, formula: '=B2*C2' },
    { item: 'Pen', quantity: 2, unitPrice: 3, formula: '=B3*C3' },
    { item: 'Book', quantity: 1, unitPrice: 12, formula: '=B4*C4' }
  ];
  const before = structuredClone(rows);
  assert.deepEqual(removeDuplicates(rows), [
    { item: 'Pen', quantity: 2, unitPrice: 3, formula: '=B2*C2' },
    { item: 'Book', quantity: 1, unitPrice: 12, formula: '=B3*C3' }
  ]);
  assert.deepEqual(rows, before);
});
`;
async function requestFixture(t) {
  const ctx = await setup(t, { sourceCode: formulaSource });
  ctx.config.adoTestRequests = {
    ...JSON.parse(readFileSync(new URL('../scaffold/ado-test-request.policy.example.json', import.meta.url))),
    enabled: true, scopeApproved: true, approvalRef: 'synthetic-intake-experiment'
  };
  ctx.item = { id: 123, rev: 1, snapshotAt: '2026-10-01T00:00:00Z', fields: {
    'System.TeamProject': 'OC', 'System.AreaPath': ctx.config.adoTestRequests.areaPath,
    'System.WorkItemType': 'Bug', 'System.State': 'New', 'System.Tags': 'AgenticTestRequest',
    'System.Title': 'Synthetic formula preservation coverage', 'System.CreatedDate': '2026-10-01T00:00:00Z',
    'System.Description': readFileSync(new URL('../scaffold/ado-test-request.sample.md', import.meta.url), 'utf8')
  } };
  ctx.read = async () => ctx.item;
  ctx.intake = await collectTestRequest(ctx.config, ctx.ledger, 123, { read: ctx.read });
  ctx.handoff = {
    format: 'ado-test-request-handoff-v1', intakeId: ctx.intake.id, intakeSha256: hash(json(ctx.intake)),
    reviewedAt: now(), review: structuredClone(fixture.review), planning: structuredClone(fixture.planning)
  };
  Object.assign(ctx.handoff.review, {
    observedBehavior: 'The synthetic deduplication helper has no focused regression test.',
    expectedBehavior: 'Keep the first distinct rows, preserve formulas and leave input untouched.',
    hypotheses: ['The fixture helper supports this contract.'], counterEvidence: [],
    reviewer: 'synthetic-request-reviewer', rationale: 'Fixture inspection establishes the bounded coverage gap.',
    nextAction: 'Add the formula-preservation test and behavior card in the fixture test directory.'
  });
  ctx.handoff.planning.improvement.theme = 'Synthetic formula-preservation coverage';
  ctx.handoff.planning.testCoverage.sourceRevision = ctx.baseRevision;
  ctx.handoff.planning.testCoverage.coverageGaps = ['Duplicate removal lacks formula and input-preservation assertions.'];
  return ctx;
}

test('test request prepares shared planning with exact provenance and source revision', async t => {
  const ctx = await requestFixture(t);
  const first = prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff);
  const second = prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff);
  assert.equal(first.assignment.id, second.assignment.id);
  assert.equal(ctx.ledger.all('assignment').length, 1);
  assert.equal(ctx.ledger.get('evidence', ctx.intake.evidenceId).source.kind, 'ado-test-request');
  assert.equal(first.assignment.intent, 'improvement');
  assert.match(first.assignment.questions[0], /untrusted scenario data/);
  assert.match(first.assignment.questions[0], /preserving all formulas/);
  ctx.config.activation.dispatch = true;
  ctx.config.limits.maxAiCreditsPerSession = 1;
  await assert.rejects(dispatch(ctx.config, ctx.ledger, first.assignment.id), /dedicated source-rechecking/);
});

for (const condition of ['stale-source', 'policy-drift', 'wrong-revision', 'missing-field',
  'unknown-coverage', 'wrong-route', 'changed-review', 'missing-exclusion']) {
  test(`test request rejects ${condition} before dispatch`, async t => {
    const ctx = await requestFixture(t);
    if (condition === 'stale-source') {
      ctx.item.rev++;
      await collectTestRequest(ctx.config, ctx.ledger, 123, { read: ctx.read });
    }
    if (condition === 'policy-drift') ctx.config.adoTestRequests.tag = 'Changed';
    if (condition === 'wrong-revision') ctx.handoff.planning.testCoverage.sourceRevision = 'f'.repeat(40);
    if (condition === 'missing-field') {
      ctx.item.rev++;
      ctx.item.fields['System.Description'] = '';
      ctx.intake = await collectTestRequest(ctx.config, ctx.ledger, 123, { read: ctx.read });
      ctx.handoff.intakeId = ctx.intake.id;
      ctx.handoff.intakeSha256 = hash(json(ctx.intake));
    }
    if (condition === 'unknown-coverage') ctx.handoff.planning.testCoverage.unknowns = ['Not inspected'];
    if (condition === 'wrong-route') ctx.handoff.planning.testCoverage.repoId = '1js';
    if (condition === 'changed-review') {
      prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff);
      ctx.handoff.review.nextAction = 'Changed';
    }
    if (condition === 'missing-exclusion') ctx.handoff.review.exclusionsChecked.pop();
    assert.throws(() => prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff));
    assert.equal(ctx.ledger.status().jobs.length, condition === 'changed-review' ? 1 : 0);
  });
}

test('test request cannot execute without grants or after withdrawal', async t => {
  const ctx = await requestFixture(t);
  await assert.rejects(acceptTestRequest(ctx.config, ctx.ledger, ctx.handoff, { execute: true }), /authorization/);
  assert.equal(ctx.ledger.status().jobs.length, 0);
  ctx.item.fields['System.State'] = 'Closed';
  await assert.rejects(acceptTestRequest(ctx.config, ctx.ledger, ctx.handoff, {
    execute: true, authorizeCommit: true, authorizePush: true, authorizeDraftPR: true, read: ctx.read
  }), /approved test-request/);
  assert.equal(ctx.ledger.status().jobs[0].state, 'prepared');
});

test('sample request exercises intake through real validation and local push, with a negative oracle', async t => {
  const ctx = await requestFixture(t);
  ctx.config.activation.dispatch = true;
  ctx.config.limits.maxAiCreditsPerSession = 1;
  ctx.config.rsi = structuredClone(rsiPolicy);
  await command('git', ['init', '--bare', '--quiet', ctx.remote], ctx.root);
  let models = 0, drafts = 0;
  const options = {
    execute: true, authorizeCommit: true, authorizePush: true, authorizeDraftPR: true, read: ctx.read,
    dispatchDependencies: {
      runModel: async (_config, _ledger, _job, assignment, _investigation, toolkit) => {
        models++;
        assert.equal(assignment.intent, 'improvement');
        toolkit.write('test/behavior.test.js', formulaTest);
        toolkit.write('test/behavior-card.md', '# Synthetic formula preservation\nCheck surviving rows, row-relative formulas and immutable input.\n');
        toolkit.finish({
          outcome: 'propose-change', findings: 'Added the synthetic request regression and behavior card.',
          title: 'Preserve formulas during duplicate removal', description: 'Synthetic controller qualification only.',
          skillResult: { status: 'succeeded', classification: 'missing-test-coverage',
            changedFiles: ['test/behavior.test.js', 'test/behavior-card.md'],
            testsAddedOrUpdated: ['deduplication preserves formulas at surviving row positions'],
            behaviorCardsAddedOrUpdated: ['test/behavior-card.md'], unknowns: [], needsHumanDecision: false }
        });
      },
      createDraft: async (_config, _ledger, _job, _repo, revision) => {
        drafts++;
        return { url: 'https://example.invalid/synthetic-test-request/draft/1', isDraft: true, headRevision: revision };
      }
    }
  };
  const result = await acceptTestRequest(ctx.config, ctx.ledger, ctx.handoff, options);
  assert.equal(result.result.outcome, 'draft-pr-validated', json(result.result));
  assert.equal(result.result.validation[0].sourceRevision, result.result.sourceRevision);
  assert.equal(result.result.draftPR.headRevision, result.result.sourceRevision);
  assert.equal(result.rsi.state, 'delivered');
  await assert.rejects(acceptTestRequest(ctx.config, ctx.ledger, ctx.handoff, options), /never-dispatched/);
  assert.equal(models, 1);
  assert.equal(drafts, 1);
  const bad = join(ctx.root, 'negative-oracle');
  mkdirSync(join(bad, 'src'), { recursive: true });
  mkdirSync(join(bad, 'test'));
  writeFileSync(join(bad, 'src/value.js'), formulaSource.replace("formula: '=B' + (index + 2) + '*C' + (index + 2)",
    'formula: row.quantity * row.unitPrice'));
  writeFileSync(join(bad, 'test/behavior.test.js'), formulaTest);
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const failure = spawnSync(process.execPath, ['--test', 'test/behavior.test.js'], { cwd: bad, encoding: 'utf8', env });
  assert.notEqual(failure.status, 0);
  assert.match(failure.stdout, /deduplication preserves formulas/);
});

test('automated request FILTER hands its plan to the real worker and publication gates without an operator handoff', async t => {
  const ctx = await requestFixture(t);
  ctx.config.executionMode = 'standalone-sdk';
  ctx.config.activation.review = true; ctx.config.activation.dispatch = true;
  ctx.config.filterExecutor = 'local-sdk'; ctx.config.limits.maxAiCreditsPerSession = 30;
  ctx.config.localFilter = { enabled: true, acceptSoftCreditLimit: true, maxRequests: 1,
    maxToolCalls: 10, timeoutMs: 10000, maxSourceBytes: 12000, maxRequestBytes: 100000,
    sources: [{ repoId: 'office-agent', revision: ctx.baseRevision }] };
  ctx.config.adoTestRequests.automation = { enabled: true, scopeApproved: true, approvalRef: 'fixture-flow',
    model: 'fixture', maxRequests: 1, sourcePaths: ['src'] };
  // New policy is collected into a fresh ledger, not retrofitted onto old receipts.
  const ledger = new Ledger(join(ctx.root, 'flow-state'));
  ctx.additionalLedgers.push(ledger);
  ledger.qualify(skillQualificationId('office-agent', 'oa-integration-test-core'),
    ctx.ledger.qualification(skillQualificationId('office-agent', 'oa-integration-test-core')));
  await command('git', ['init', '--bare', '--quiet', ctx.remote], ctx.root);
  let filters = 0, proposers = 0, drafts = 0, comments = 0;
  ctx.config.adoTestRequests.feedback = { enabled: true, scopeApproved: true, approvalRef: 'fixture-feedback' };
  const dependencies = { read: ctx.read,
    feedback: { getToken: async () => 'fixture', fetchResponse: async (_url, options) => {
      comments++; assert.match(JSON.parse(options.body).text, /validated coverage Draft PR/);
      return Response.json({ id: 99, workItemId: 123 });
    } },
    connect: async (_config, _cwd, action) => action({ createSession: async options => {
      filters++; let event;
      return { sessionId: 'fixture-filter-session', on: callback => { event = callback; return () => {}; },
        rpc: { options: { update: async () => {} }, tools: { initializeAndValidate: async () => {} } },
        sendAndWait: async () => {
          event({ type: 'assistant.turn_start' });
          await options.tools.find(tool => tool.name === 'pilot_request_source').handler({ action: 'read', path: 'src/value.js' });
          const result = JSON.parse(await options.tools.find(tool => tool.name === 'pilot_request_finish').handler({
            decision: 'supported', missingCapabilities: [], sourcePaths: ['src/value.js'],
            rationale: 'Fixture implementation supports the invariant.', verificationEvidence: [],
            handoff: { review: ctx.handoff.review, planning: ctx.handoff.planning }
          }));
          assert.equal(result.error, undefined, json(result));
        }, disconnect: async () => {} };
    } }),
    dispatchDependencies: {
      runModel: async (_config, _ledger, _job, _assignment, _investigation, toolkit) => {
        proposers++; toolkit.write('test/behavior.test.js', formulaTest);
        toolkit.write('test/behavior-card.md', '# Formula preservation\nSynthetic contract.\n');
        toolkit.finish({ outcome: 'propose-change', findings: 'Added regression.', title: 'Formula preservation', description: 'Synthetic qualification.',
          skillResult: { status: 'succeeded', classification: 'missing-test-coverage', changedFiles: ['test/behavior.test.js', 'test/behavior-card.md'],
            testsAddedOrUpdated: ['formula preservation'], behaviorCardsAddedOrUpdated: ['test/behavior-card.md'], unknowns: [], needsHumanDecision: false } });
      },
      createDraft: async (_config, _ledger, _job, _repo, revision) => {
        drafts++; return { url: 'https://example.invalid/automated-request/draft/1', isDraft: true, headRevision: revision };
      }
    }
  };
  const options = { authorizeReview: true, execute: true, authorizeCommit: true, authorizePush: true, authorizeDraftPR: true, authorizeComment: true };
  ctx.config.activation.dispatch = false;
  ctx.config.adoTestRequests.feedback.enabled = false;
  const prepared = await runTestRequest(ctx.config, ledger, 123, { authorizeReview: true }, dependencies);
  assert.equal(filters, 1); assert.equal(proposers, 0);
  ctx.config.activation.dispatch = true;
  ctx.config.adoTestRequests.feedback.enabled = true;
  const result = await runTestRequest(ctx.config, ledger, 123, options, dependencies);
  assert.equal(result.state, 'draft-pr-validated', json(result));
  assert.equal(result.result.validation[0].sourceRevision, result.result.draftPR.headRevision);
  assert.equal((await runTestRequest(ctx.config, ledger, 123, options, dependencies)).replayed, true);
  assert.equal(result.feedback.state, 'commented');
  ctx.item.rev++;
  const revisionReplay = await runTestRequest(ctx.config, ledger, 123, options, dependencies);
  assert.equal(revisionReplay.priorOutcomeOnly, true);
  assert.deepEqual([filters, proposers, drafts, comments], [1, 1, 1, 1]);
});

async function supportedRequestAssessment(ctx) {
  const input = { format: 'ado-test-request-capability-v1', intakeId: ctx.intake.id,
    intakeSha256: hash(json(ctx.intake)), sourceRevision: ctx.baseRevision,
    reviewedAt: now(), reviewer: 'fixture-reviewer', decision: 'supported', missingCapabilities: [],
    sourcePaths: ['src/value.js'], rationale: 'Synthetic supported coverage contract.', verificationEvidence: [] };
  recordCapabilityAssessment(ctx.config, ctx.ledger, input);
  return input;
}

function withdrawRequest(ctx, revisionOnly = false) {
  ctx.item.rev++;
  if (!revisionOnly) ctx.item.fields['System.State'] = 'Closed';
}
function supersedeRequestReview(ctx, assignment) {
  const investigation = ctx.ledger.get('investigation', assignment.investigationId);
  ctx.ledger.put({ ...investigation, version: investigation.version + 1, state: 'blocked' });
}

for (const interruption of ['authoring-hold', 'source-withdrawal', 'push-hold', 'draft-lookup-hold', 'draft-auth-hold', 'draft-read-hold', 'authoring-withdrawal', 'authoring-revision', 'validation-withdrawal',
  'push-withdrawal', 'draft-lookup-withdrawal', 'draft-auth-withdrawal', 'draft-read-review'])
  test(`ADO coverage publication blocks ${interruption} and retains authored work`, async t => {
    const ctx = await requestFixture(t);
    const assessment = await supportedRequestAssessment(ctx);
    ctx.config.activation.dispatch = true;
    ctx.config.limits.maxAiCreditsPerSession = 1;
    let pushes = 0, drafts = 0;
    const hold = () => recordCapabilityAssessment(ctx.config, ctx.ledger, { ...assessment,
      decision: 'needs-harness', missingCapabilities: ['Newly reviewed formula evidence gap'], reviewedAt: now() });
    await assert.rejects(acceptTestRequest(ctx.config, ctx.ledger, ctx.handoff, {
      execute: true, authorizeCommit: true, authorizePush: true, authorizeDraftPR: true, read: ctx.read,
      dispatchDependencies: {
        runModel: async (_config, _ledger, _job, _assignment, _investigation, toolkit) => {
          toolkit.write('test/behavior.test.js', formulaTest);
          toolkit.write('test/behavior-card.md', '# Synthetic formula behavior\n');
          toolkit.finish({ outcome: 'propose-change', findings: 'Fixture test authored.', title: 'Fixture coverage',
            description: 'Synthetic test only.', skillResult: { status: 'succeeded', classification: 'missing-test-coverage',
              changedFiles: ['test/behavior.test.js', 'test/behavior-card.md'], testsAddedOrUpdated: ['formula preservation'],
              behaviorCardsAddedOrUpdated: ['test/behavior-card.md'], unknowns: [], needsHumanDecision: false } });
          if (interruption === 'authoring-hold') hold();
          if (interruption === 'source-withdrawal') { ctx.item.rev++; ctx.item.fields['System.State'] = 'Closed'; }
          if (interruption.startsWith('authoring-')) withdrawRequest(ctx, interruption === 'authoring-revision');
        },
        runValidation: async (...args) => {
          const result = await runValidation(...args);
          if (interruption === 'validation-withdrawal') withdrawRequest(ctx);
          return result;
        },
        pushBranch: async (_config, _workspace, _repo, _refspec, admission) => {
          assert.equal(admission.ledger, ctx.ledger);
          assert.ok(admission.assignmentId);
          assert.equal(admission.readTestRequest, ctx.read);
          pushes++;
          if (interruption === 'push-hold') hold();
          if (interruption === 'push-withdrawal') withdrawRequest(ctx);
        },
        createDraft: async (config, ledger, job, repo, revision, proposal, _request, _allow, admission) => {
          assert.equal(admission.readTestRequest, ctx.read);
          assert.ok(interruption.startsWith('draft-'), 'Draft must not be entered after withdrawal');
          const transportRepo = { ...repo, remote: 'https://dev.azure.com/fixture/project/_git/repo',
            pr: { provider: 'ado', organization: 'fixture', project: 'project', repositoryId: 'repo', targetRef: 'refs/heads/main' } };
          let tokens = 0;
          return createAdoDraft(config, ledger, job, transportRepo, revision, proposal, undefined, true, {
            getToken: async () => {
              if (++tokens === 2) {
                if (interruption === 'draft-auth-hold') hold();
                if (interruption === 'draft-auth-withdrawal') { ctx.item.rev++; ctx.item.fields['System.State'] = 'Closed'; }
              }
              return 'fixture-token';
            },
            readTestRequest: async () => {
              if (interruption === 'draft-read-hold') hold();
              if (interruption === 'draft-read-review') supersedeRequestReview(ctx, ledger.get('assignment', job.id));
              return ctx.item;
            },
            fetchResponse: async (_url, options) => {
              if (options.method === 'GET') {
                if (interruption === 'draft-lookup-hold') hold();
                if (interruption === 'draft-lookup-withdrawal') withdrawRequest(ctx);
                return Response.json({ value: [] });
              }
              drafts++;
              assert.fail('Draft POST must not be sent after changed admission');
            }
          });
        }
      }
    }), /Coverage is held|approved test-request|changed or was withdrawn|superseded/);
    assert.equal(pushes, interruption === 'push-hold' || interruption === 'push-withdrawal' || interruption.startsWith('draft-') ? 1 : 0);
    assert.equal(drafts, 0);
    const job = ctx.ledger.status().jobs[0];
    assert.equal(job.state, 'blocked');
    assert.ok(existsSync(join(job.workspace, 'test/behavior.test.js')));
    const result = ctx.ledger.all('workerResult').at(-1);
    assert.equal(result.outcome, 'blocked');
    assert.ok(result.sourceRevision);
    // Shared admission now observes an in-ledger hold before starting validation.
    if (interruption === 'authoring-hold') assert.deepEqual(result.validation, []);
    else assert.equal(result.validation[0].status, 'passed');
  });

for (const transport of ['push', 'build']) for (const interruption of ['auth', 'source-read', 'auth-withdrawal', 'source-read-review'])
  test(`${transport} transport rechecks admission after ${interruption}`, async t => {
    const ctx = await requestFixture(t);
    const assessment = await supportedRequestAssessment(ctx);
    const prepared = prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff);
    const repo = { ...ctx.config.repositories[0], remote: 'https://dev.azure.com/fixture/project/_git/repo',
      pr: { provider: 'ado', organization: 'fixture', project: 'project', repositoryId: 'repo', targetRef: 'refs/heads/main' },
      draftBuild: { enabled: true, provider: 'ado', id: 'fixture-build', definitionId: 2 } };
    // Use a later timestamp deterministically without timers around native Git.
    await new Promise(resolve => setTimeout(resolve, 5));
    const hold = () => recordCapabilityAssessment(ctx.config, ctx.ledger, { ...assessment,
      decision: 'needs-evidence', reviewedAt: now() });
    let mutations = 0;
    const dependencies = { ledger: ctx.ledger, assignmentId: prepared.assignment.id,
      getToken: async () => { if (interruption === 'auth') hold(); if (interruption === 'auth-withdrawal') withdrawRequest(ctx); return 'fixture-token'; },
      readTestRequest: async () => { if (interruption === 'source-read') hold(); if (interruption === 'source-read-review') supersedeRequestReview(ctx, prepared.assignment); return ctx.item; },
      execute: async () => { mutations++; assert.fail('Push after a hold'); },
      fetchResponse: async () => { mutations++; assert.fail('Build POST after a hold'); } };
    if (transport === 'push') await assert.rejects(pushDraftBranch(ctx.config, ctx.config.repositories[0].referenceCheckout,
      repo, 'HEAD:refs/heads/fixture', dependencies), /Coverage is held|approved test-request|superseded/);
    else await assert.rejects(queueAdoDraftBuild(ctx.config, ctx.ledger, prepared.job, repo,
      ctx.baseRevision, undefined, dependencies), /Coverage is held|approved test-request|superseded/);
    assert.equal(mutations, 0);
    assert.equal(ctx.ledger.status().operations.some(row => row.kind === 'draft-build'), false);
  });

for (const provider of ['agency-remote', 'agency-local'])
  test(`ADO coverage rejects ${provider} before authoring or seed publication`, async t => {
    const ctx = await requestFixture(t);
    const assessment = await supportedRequestAssessment(ctx);
    const prepared = prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff);
    ctx.config.authoringProviders = { external: { type: provider, executable: process.execPath,
      profile: 'fixture-provider', ...(provider === 'agency-remote' ? { pollSeconds: 1 } : {}) } };
    ctx.config.repositories[0].skillBindings[0].authoringProvider = 'external';
    const investigation = ctx.ledger.get('investigation', prepared.assignment.investigationId);
    const external = makePlannedImprovementAssignment(ctx.config, ctx.ledger, investigation,
      prepared.assignment.testCoveragePlanId, prepared.assignment.requestedOutcome);
    // Model an old persisted external assignment without granting it a new dispatch.
    ctx.ledger.put(external);
    const reviewId = `${ctx.intake.id}:review`;
    const review = JSON.parse(ctx.ledger.status().operations.find(row => row.id === reviewId).detail);
    ctx.ledger.finishOperation(reviewId, 'complete', { ...review, assignmentId: external.id });
    assert.throws(() => prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff), /final local executor/);
    await new Promise(resolve => setTimeout(resolve, 5));
    recordCapabilityAssessment(ctx.config, ctx.ledger, { ...assessment, decision: 'needs-harness',
      missingCapabilities: ['Newly reviewed capability gap'], reviewedAt: now() });
    let pushes = 0, launches = 0;
    await assert.rejects(dispatchAdoTestRequest(ctx.config, ctx.ledger, external.id, {
      readTestRequest: ctx.read,
      agencyRemote: { pushBranch: async () => { pushes++; }, executeRemoteJob: async () => { launches++; } },
      runAgencyLocal: async () => { launches++; }
    }), /final local executor/);
    assert.equal(pushes, 0);
    assert.equal(launches, 0);
    assert.equal(ctx.ledger.status().operations.some(row => row.kind === 'agency-remote-seed'), false);
  });

for (const provider of ['agency-remote', 'agency-local'])
  test(`new ADO coverage preparation cannot select ${provider}`, async t => {
    const ctx = await requestFixture(t);
    await supportedRequestAssessment(ctx);
    ctx.config.authoringProviders = { external: { type: provider, executable: process.execPath, profile: 'fixture-provider' } };
    ctx.config.repositories[0].skillBindings[0].authoringProvider = 'external';
    await assert.rejects(acceptTestRequest(ctx.config, ctx.ledger, ctx.handoff, {
      execute: true, authorizeCommit: true, authorizePush: true, authorizeDraftPR: true, read: ctx.read
    }), /final local executor/);
    assert.equal(ctx.ledger.all('assignment').length, 0);
    assert.equal(ctx.ledger.status().jobs.length, 0);
  });

test('shared admission enforces holds and app-native rejects unsupported ADO execution paths', async t => {
  const ctx = await requestFixture(t);
  ctx.config.activation.collect = true;
  ctx.config.activation.dispatch = true;
  ctx.config.limits.maxCalls = 10;
  const runId = 'ado-app-boundary';
  beginApp(ctx.config, { runId, executorSessionId: 'fixture-session', dryRun: false, provenance: 'app-tool' });
  const { ledger } = openApp(ctx.config, runId, false);
  ctx.additionalLedgers.push(ledger);
  for (const binding of ctx.config.repositories[0].skillBindings) {
    const key = skillQualificationId('office-agent', binding.id);
    ledger.qualify(key, ctx.ledger.qualification(key));
  }
  ctx.ledger = ledger;
  ctx.intake = await collectTestRequest(ctx.config, ledger, 123, { read: ctx.read });
  ctx.handoff.intakeId = ctx.intake.id;
  ctx.handoff.intakeSha256 = hash(json(ctx.intake));
  ctx.handoff.reviewedAt = now();
  const assessment = await supportedRequestAssessment(ctx);
  const prepared = prepareTestRequest(ctx.config, ledger, ctx.handoff);
  const assignment = prepared.assignment;
  const prepareInput = { investigationId: assignment.investigationId, repoId: assignment.repoId,
    intent: assignment.intent, testCoveragePlanId: assignment.testCoveragePlanId };
  assert.throws(() => appWorker(ctx.config, ledger, runId, 'prepare', prepareInput), /app-native execution is not supported/);
  recordCapabilityAssessment(ctx.config, ledger, { ...assessment, decision: 'needs-evidence', reviewedAt: now() });
  assert.throws(() => requireCurrentAssignment(ctx.config, ledger, ledger.get('investigation', assignment.investigationId), assignment), /Coverage is held/);
  assert.throws(() => appWorker(ctx.config, ledger, runId, 'prepare', prepareInput), /app-native execution is not supported/);
  // Simulate an app worker persisted by the previous version before this guard existed.
  ledger.db.prepare('INSERT INTO app_workers VALUES(?,?)').run(assignment.id, json({ id: assignment.id,
    runId, state: 'prepared', assignment, claimId: null, execution: 'external-app-native-session' }));
  const claim = { assignmentId: assignment.id, claimId: 'fixture-claim', coordinatorAgentId: ctx.config.agent.id };
  assert.throws(() => appWorker(ctx.config, ledger, runId, 'claim', claim), /app-native execution is not supported/);
  ledger.db.prepare('UPDATE app_workers SET body=? WHERE id=?').run(json({ id: assignment.id,
    runId, state: 'claimed', assignment, claimId: claim.claimId, execution: 'external-app-native-session' }), assignment.id);
  assert.throws(() => appWorker(ctx.config, ledger, runId, 'claim', claim), /app-native execution is not supported/);
  assert.throws(() => appWorker(ctx.config, ledger, runId, 'bind', claim), /app-native execution is not supported/);
  assert.throws(() => appWorker(ctx.config, ledger, runId, 'result', { ...claim, outcome: 'draft-reported' }), /app-native execution is not supported/);
});

async function harnessFixture(t) {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-10-01T00:00:00Z') });
  const ctx = await requestFixture(t);
  const repo = ctx.config.repositories[0];
  ctx.config.adoTestRequests.harnessSupport = {
    enabled: true, scopeApproved: true, approvalRef: 'synthetic-harness-approval',
    capability: 'e2e-harness-authoring', requestedOutcome: 'extend-e2e-harness'
  };
  ctx.config.adoTestRequests.feedback = { enabled: true, scopeApproved: true, approvalRef: 'synthetic-feedback' };
  repo.allowedWritePrefixes.push('harness');
  const binding = { ...structuredClone(repo.skillBindings[0]), id: 'fixture-harness',
    capability: 'e2e-harness-authoring', requestedOutcomes: ['extend-e2e-harness'],
    allowedWritePrefixes: ['harness'], requiresBehaviorCard: false };
  repo.skillBindings.push(binding);
  const qualification = ctx.ledger.qualification(skillQualificationId(repo.id, repo.skillBindings[0].id));
  ctx.ledger.qualify(skillQualificationId(repo.id, binding.id), {
    ...qualification, bindingId: binding.id, capability: binding.capability
  });
  ctx.item.rev++;
  ctx.item.fields['System.Tags'] += '; AgenticHarnessRequest';
  ctx.intake = await collectTestRequest(ctx.config, ctx.ledger, 123, { read: ctx.read });
  ctx.handoff.intakeId = ctx.intake.id;
  ctx.handoff.intakeSha256 = hash(json(ctx.intake));
  ctx.assessmentInput = { format: 'ado-test-request-capability-v1', intakeId: ctx.intake.id,
    intakeSha256: hash(json(ctx.intake)), sourceRevision: ctx.baseRevision,
    reviewedAt: '2026-10-02T00:00:00Z', reviewer: 'synthetic-source-review', decision: 'needs-harness',
    missingCapabilities: ['Formula metadata is not exposed by the workbook reader.'],
    sourcePaths: ['harness/reader.js'], rationale: 'Synthetic gap for routing qualification.', verificationEvidence: [] };
  t.mock.timers.setTime(new Date('2026-10-05T00:00:00Z').getTime());
  ctx.handoff.reviewedAt = now();
  ctx.assessment = recordCapabilityAssessment(ctx.config, ctx.ledger, ctx.assessmentInput);
  ctx.harnessHandoff = structuredClone(ctx.handoff);
  ctx.harnessHandoff.format = 'ado-harness-request-handoff-v1';
  ctx.harnessHandoff.planning.improvement.category = 'test-maintainability';
  ctx.harnessHandoff.planning.improvement.capabilities = ['e2e-harness-authoring'];
  ctx.harnessHandoff.planning.testCoverage.capability = 'e2e-harness-authoring';
  ctx.harnessHandoff.planning.requestedOutcome = 'extend-e2e-harness';
  ctx.harnessHandoff.review.nextAction = 'Extend only the reusable fixture reader and add contract tests; no product scenario.';
  return ctx;
}

test('harness gap holds coverage and prepares one separate bounded agent assignment', async t => {
  const ctx = await harnessFixture(t);
  assert.throws(() => prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff), /Coverage is held/);
  assert.deepEqual(recordCapabilityAssessment(ctx.config, ctx.ledger, ctx.assessmentInput), ctx.assessment);
  const first = prepareTestRequest(ctx.config, ctx.ledger, ctx.harnessHandoff);
  assert.equal(first.assignment.capability, 'e2e-harness-authoring');
  assert.deepEqual(first.assignment.allowedWritePrefixes, ['harness']);
  assert.equal(first.assignment.requestedOutcome, 'extend-e2e-harness');
  assert.equal(prepareTestRequest(ctx.config, ctx.ledger, ctx.harnessHandoff).assignment.id, first.assignment.id);
  assert.equal(ctx.ledger.all('assignment').length, 1);
  const equivalent = recordCapabilityAssessment(ctx.config, ctx.ledger, { ...ctx.assessmentInput, reviewedAt: now() });
  assert.equal(equivalent.id, ctx.assessment.id);
  assert.equal(prepareTestRequest(ctx.config, ctx.ledger, ctx.harnessHandoff).assignment.id, first.assignment.id);
  await verifyCurrentTestRequest(ctx.config, ctx.ledger, first.assignment.id, ctx.read);
  ctx.item.rev++;
  ctx.item.fields['System.Tags'] = 'AgenticTestRequest';
  await assert.rejects(verifyCurrentTestRequest(ctx.config, ctx.ledger, first.assignment.id, ctx.read), /changed or was withdrawn/);
  await collectTestRequest(ctx.config, ctx.ledger, 123, { read: ctx.read });
  assert.throws(() => prepareTestRequest(ctx.config, ctx.ledger, ctx.harnessHandoff), /superseded/);
});

for (const condition of ['no-tag', 'overlapping-bounds', 'normalized-overlap', 'unapproved', 'environment', 'no-assessment'])
  test(`harness route rejects ${condition}`, async t => {
    const ctx = await harnessFixture(t);
    if (condition === 'overlapping-bounds') ctx.config.repositories[0].skillBindings[1].allowedWritePrefixes = ['test'];
    if (condition === 'normalized-overlap') ctx.config.repositories[0].skillBindings[1].allowedWritePrefixes = ['./test/'];
    if (condition === 'unapproved') ctx.config.adoTestRequests.harnessSupport.scopeApproved = false;
    if (['no-tag', 'no-assessment'].includes(condition)) {
      ctx.item.rev++;
      if (condition === 'no-tag') ctx.item.fields['System.Tags'] = 'AgenticTestRequest; AgenticHarnessRequestOther';
      const intake = await collectTestRequest(ctx.config, ctx.ledger, 123, { read: ctx.read });
      ctx.harnessHandoff.intakeId = intake.id;
      ctx.harnessHandoff.intakeSha256 = hash(json(intake));
      if (condition === 'no-tag') recordCapabilityAssessment(ctx.config, ctx.ledger, { ...ctx.assessmentInput,
        intakeId: intake.id, intakeSha256: hash(json(intake)), reviewedAt: now() });
    }
    if (condition === 'environment') recordCapabilityAssessment(ctx.config, ctx.ledger, { ...ctx.assessmentInput,
      decision: 'blocked-environment', missingCapabilities: [], reviewedAt: '2026-10-03T00:00:00Z' });
    assert.throws(() => prepareTestRequest(ctx.config, ctx.ledger, ctx.harnessHandoff));
    assert.equal(ctx.ledger.all('assignment').length, 0);
  });

test('harness preparation rejects a selected hosted Agency executor before persisting work', async t => {
  const ctx = await harnessFixture(t);
  let assignment;
  const rollback = new Error('fixture inspection rollback');
  assert.throws(() => ctx.ledger.transaction(() => {
    assignment = prepareTestRequest(ctx.config, ctx.ledger, ctx.harnessHandoff).assignment;
    throw rollback;
  }), error => error === rollback);
  ctx.config.agency = { selections: [{ taskId: assignment.id, repoId: assignment.repoId, role: 'proposer',
    suiteId: 'fixture-suite', profileId: 'fixture-profile', qualificationId: 'fixture-qualification',
    qualificationSha256: 'a'.repeat(64), sourceRevision: ctx.baseRevision, targetRef: 'refs/heads/main',
    payloadSha256: 'b'.repeat(64), instructionsSha256: 'c'.repeat(64), resultKind: 'validation', allowPush: true,
    dispatchAllowed: true, maxExecutionSeconds: 60, allowedPaths: ['harness'], forbiddenPaths: ['src'],
    caseContract: { cases: [{ suite: 'harness', title: 'formula metadata', status: 'passed' }], scenarios: ['harness'],
      commands: [{ id: 'fixture-test', phase: 'test', command: 'node --test', cwd: '.' }] } }] };
  assert.throws(() => prepareTestRequest(ctx.config, ctx.ledger, ctx.harnessHandoff), /final local executor/);
  assert.equal(ctx.ledger.all('assignment').length, 0);
  assert.equal(ctx.ledger.status().jobs.length, 0);
});

test('a new request revision cannot duplicate an existing harness assignment', async t => {
  const ctx = await harnessFixture(t);
  prepareTestRequest(ctx.config, ctx.ledger, ctx.harnessHandoff);
  ctx.item.rev++;
  const intake = await collectTestRequest(ctx.config, ctx.ledger, 123, { read: ctx.read });
  recordCapabilityAssessment(ctx.config, ctx.ledger, { ...ctx.assessmentInput, intakeId: intake.id,
    intakeSha256: hash(json(intake)), reviewedAt: now() });
  const handoff = { ...ctx.harnessHandoff, intakeId: intake.id, intakeSha256: hash(json(intake)) };
  assert.throws(() => prepareTestRequest(ctx.config, ctx.ledger, handoff), /Prior harness assignment/);
  assert.equal(ctx.ledger.all('assignment').length, 1);
});

test('enabled harness routing requires a supported assessment even without a recorded gap', async t => {
  const ctx = await requestFixture(t);
  ctx.config.adoTestRequests.harnessSupport = { enabled: true };
  ctx.item.rev++;
  const intake = await collectTestRequest(ctx.config, ctx.ledger, 123, { read: ctx.read });
  ctx.handoff.intakeId = intake.id;
  ctx.handoff.intakeSha256 = hash(json(intake));
  ctx.handoff.reviewedAt = now();
  assert.throws(() => prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff), /Coverage is held/);
  assert.equal(ctx.ledger.all('assignment').length, 0);
});

test('coverage reassessment requires changed revision and qualification evidence, including through intermediate states', async t => {
  const ctx = await harnessFixture(t);
  const supported = { ...ctx.assessmentInput, decision: 'supported', missingCapabilities: [], reviewedAt: '2026-10-04T00:00:00Z' };
  assert.throws(() => recordCapabilityAssessment(ctx.config, ctx.ledger, supported), /new harness revision/);
  recordCapabilityAssessment(ctx.config, ctx.ledger, { ...supported, decision: 'needs-evidence', reviewedAt: '2026-10-03T00:00:00Z' });
  assert.throws(() => recordCapabilityAssessment(ctx.config, ctx.ledger, supported), /new harness revision/);
  const qualificationId = skillQualificationId('office-agent', 'oa-integration-test-core');
  ctx.ledger.qualify(qualificationId, { ...ctx.ledger.qualification(qualificationId), baseRevision: 'a'.repeat(40) });
  supported.sourceRevision = 'a'.repeat(40);
  assert.throws(() => recordCapabilityAssessment(ctx.config, ctx.ledger, supported), /verification evidence/);
  supported.verificationEvidence = ['Synthetic integrated harness contract test receipt'];
  recordCapabilityAssessment(ctx.config, ctx.ledger, supported);
  ctx.handoff.planning.testCoverage.sourceRevision = supported.sourceRevision;
  assert.equal(prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff).assignment.capability, 'integration-test-authoring');
});

test('equivalent holds retain latest review freshness without changing semantic identity', async t => {
  const ctx = await harnessFixture(t);
  const hold = { ...ctx.assessmentInput, decision: 'needs-evidence', missingCapabilities: [], reviewedAt: '2026-10-03T00:00:00Z' };
  const first = recordCapabilityAssessment(ctx.config, ctx.ledger, hold);
  assert.equal(recordCapabilityAssessment(ctx.config, ctx.ledger, { ...hold, reviewedAt: '2026-10-05T00:00:00Z' }).id, first.id);
  const qualificationId = skillQualificationId('office-agent', 'oa-integration-test-core');
  ctx.ledger.qualify(qualificationId, { ...ctx.ledger.qualification(qualificationId), baseRevision: 'a'.repeat(40) });
  assert.throws(() => recordCapabilityAssessment(ctx.config, ctx.ledger, { ...hold, decision: 'supported',
    sourceRevision: 'a'.repeat(40), reviewedAt: '2026-10-04T00:00:00Z', verificationEvidence: ['new revision test receipt'] }), /advance its timestamp/);
  assert.throws(() => prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff), /Coverage is held/);
});

for (const buildMode of ['disabled', 'harness', 'missing-contract', 'unapproved', 'selection-override']) test(`harness proposer publication with ${buildMode} build contract`, async t => {
  const ctx = await harnessFixture(t);
  if (buildMode !== 'disabled') {
    ctx.config.repositories[0].id = '1js';
    ctx.config.adoTestRequests.repoId = '1js';
    for (const handoff of [ctx.handoff, ctx.harnessHandoff]) {
      handoff.review.repoIds = ['1js'];
      handoff.planning.improvement.repoIds = ['1js'];
      handoff.planning.testCoverage.repoId = '1js';
    }
    for (const binding of ctx.config.repositories[0].skillBindings) ctx.ledger.qualify(skillQualificationId('1js', binding.id), {
      ...ctx.ledger.qualification(skillQualificationId('office-agent', binding.id)), repoId: '1js'
    });
    ctx.item.rev++;
    ctx.intake = await collectTestRequest(ctx.config, ctx.ledger, 123, { read: ctx.read });
    ctx.assessmentInput = { ...ctx.assessmentInput, intakeId: ctx.intake.id, intakeSha256: hash(json(ctx.intake)), reviewedAt: now() };
    ctx.assessment = recordCapabilityAssessment(ctx.config, ctx.ledger, ctx.assessmentInput);
    for (const handoff of [ctx.handoff, ctx.harnessHandoff]) {
      handoff.intakeId = ctx.intake.id;
      handoff.intakeSha256 = hash(json(ctx.intake));
    }
    ctx.config.repositories[0].pr = { provider: 'ado', organization: 'fixture', project: 'project',
      repositoryId: '1js', targetRef: 'refs/heads/main', sourceBranchPrefix: 'fixture' };
    ctx.config.repositories[0].draftBuild = { enabled: true, provider: 'ado', id: 'coverage', definitionId: 1,
      ...(buildMode !== 'missing-contract' ? { harness: { enabled: true, scopeApproved: buildMode !== 'unapproved', approvalRef: 'fixture-build-approval',
        provider: 'ado', id: 'harness-contracts', definitionId: 2, testPaths: ['harness/reader.test.js'],
        templateParameters: buildMode === 'selection-override' ? { harnessSelection: 'untrusted override' } : {} } } : {}) };
  }
  t.mock.timers.reset();
  ctx.config.activation.dispatch = true;
  ctx.config.limits.maxAiCreditsPerSession = 1;
  const repo = ctx.config.repositories[0];
  repo.validationGates[0].args = ['--test', 'harness/reader.test.js'];
  const contract = repositoryValidationContract(repo);
  const key = skillQualificationId(repo.id, 'fixture-harness');
  ctx.ledger.qualify(key, { ...ctx.ledger.qualification(key), validationContractVersion: contract.version,
    validationContractSha256: contract.sha256 });
  await command('git', ['init', '--bare', '--quiet', ctx.remote], ctx.root);
  let models = 0, drafts = 0;
  const options = { execute: true, authorizeCommit: true, authorizePush: true, authorizeDraftPR: true, read: ctx.read,
    dispatchDependencies: {
      runModel: async (_config, _ledger, _job, assignment, _investigation, toolkit) => {
        models++;
        assert.equal(assignment.capability, 'e2e-harness-authoring');
        assert.match(assignment.questions[0], /Formula metadata/);
        assert.throws(() => toolkit.write('test/new-product-case.js', 'bad'), /bounds|scope|allowed/);
        toolkit.write('harness/reader.js', 'export const formula = cell => cell.formula ?? null;\n');
        toolkit.write('harness/reader.test.js', "import assert from 'node:assert/strict';\nimport { formula } from './reader.js';\nassert.equal(formula({formula: '=B2*C2', value: 6}), '=B2*C2');\nassert.equal(formula({value: 6}), null);\n");
        toolkit.finish({ outcome: 'propose-change', findings: 'Synthetic formula-aware reader contract.',
          title: 'Extend harness formula evidence', description: 'Harness-only fixture; no product scenario.',
          skillResult: { status: 'succeeded', classification: 'test-maintainability',
            changedFiles: ['harness/reader.js', 'harness/reader.test.js'], testsAddedOrUpdated: ['formula evidence'],
            behaviorCardsAddedOrUpdated: [], unknowns: [], needsHumanDecision: false } });
      },
      queueDraftBuild: async (config, ledger, job, repo, revision) => queueAdoDraftBuild(config, ledger, job, repo, revision, async body => {
        assert.equal(body.definition.id, 2);
        assert.equal(body.templateParameters.newCaseSelection, undefined);
        const selection = JSON.parse(body.templateParameters.harnessSelection);
        assert.equal(selection.format, 'harness-contract-selection-v1');
        assert.equal(selection.sourceRevision, revision);
        assert.deepEqual(selection.testPaths, ['harness/reader.test.js']);
        return { id: 31 };
      }, { readTestRequest: ctx.read }),
      createDraft: async (_config, _ledger, _job, _repo, revision, proposal) => {
        drafts++;
        if (buildMode === 'harness') assert.match(proposal.description, /harness contract tests only/);
        return { url: 'https://example.invalid/harness/draft/1', isDraft: true, headRevision: revision };
      }
    } };
  if (['missing-contract', 'unapproved', 'selection-override'].includes(buildMode)) {
    await assert.rejects(acceptTestRequest(ctx.config, ctx.ledger, ctx.harnessHandoff, options), /separate approved harness Draft build|controller-owned selections/);
    assert.equal(drafts, 0);
    assert.equal(ctx.ledger.status().operations.some(row => row.kind === 'push'), false);
    return;
  }
  const result = await acceptTestRequest(ctx.config, ctx.ledger, ctx.harnessHandoff, options);
  assert.equal(result.result.outcome, 'draft-pr-validated', json(result.result));
  assert.equal(result.result.validation[0].status, 'passed');
  assert.equal(result.result.draftPR.headRevision, result.result.sourceRevision);
  const equivalent = recordCapabilityAssessment(ctx.config, ctx.ledger, { ...ctx.assessmentInput, reviewedAt: now() });
  assert.equal(equivalent.id, ctx.assessment.id);
  let comments = 0;
  const feedback = { authorizeComment: true, assignmentId: result.assignment.id, read: ctx.read,
    getToken: async () => 'fixture-token', fetchResponse: async (_url, options) => {
      comments++;
      assert.match(JSON.parse(options.body).text, /https:\/\/example.invalid\/harness\/draft\/1/);
      return Response.json({ id: 55, workItemId: 123 });
    } };
  await publishCapabilityComment(ctx.config, ctx.ledger, ctx.assessment.id, feedback);
  await publishCapabilityComment(ctx.config, ctx.ledger, ctx.assessment.id, feedback);
  assert.equal(comments, 1);
  assert.throws(() => prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff), /Coverage is held/);
  await assert.rejects(acceptTestRequest(ctx.config, ctx.ledger, ctx.harnessHandoff, options), /never-dispatched/);
  assert.equal(models, 1);
  assert.equal(drafts, 1);
  ctx.item.rev++;
  ctx.item.fields['System.Title'] += ' clarified';
  const intake = await collectTestRequest(ctx.config, ctx.ledger, 123, { read: ctx.read });
  const assessment = recordCapabilityAssessment(ctx.config, ctx.ledger, { ...ctx.assessmentInput,
    intakeId: intake.id, intakeSha256: hash(json(intake)), reviewedAt: now() });
  await assert.rejects(publishCapabilityComment(ctx.config, ctx.ledger, assessment.id, feedback), /association reconciliation/);
  const association = { assignmentId: result.assignment.id, assessmentId: assessment.id,
    reviewer: 'fixture-owner', reviewedAt: now(), evidenceRef: 'Title-only change inspected' };
  await assert.rejects(reconcileHarnessAssociation(ctx.config, ctx.ledger, association, { read: ctx.read }), /authorization/);
  ctx.item.rev++;
  await assert.rejects(reconcileHarnessAssociation(ctx.config, ctx.ledger, association, {
    authorizeReconciliation: true, read: ctx.read }), /changed before harness association/);
  ctx.item.rev--;
  await reconcileHarnessAssociation(ctx.config, ctx.ledger, association, { authorizeReconciliation: true, read: ctx.read });
  await publishCapabilityComment(ctx.config, ctx.ledger, assessment.id, feedback);
  assert.equal(comments, 2);
  assert.equal(ctx.ledger.all('assignment').length, 1);
  ctx.item.rev++;
  ctx.item.fields['System.Description'] += '\nChanged expected contract.';
  const changed = await collectTestRequest(ctx.config, ctx.ledger, 123, { read: ctx.read });
  const changedAssessment = recordCapabilityAssessment(ctx.config, ctx.ledger, { ...ctx.assessmentInput,
    intakeId: changed.id, intakeSha256: hash(json(changed)), reviewedAt: now() });
  await assert.rejects(reconcileHarnessAssociation(ctx.config, ctx.ledger, { ...association,
    assessmentId: changedAssessment.id, reviewedAt: now() }, { authorizeReconciliation: true, read: ctx.read }), /title-only/);
});

test('capability feedback is escaped, authorized, source checked and posted at most once', async t => {
  const ctx = await harnessFixture(t);
  assert.match(capabilityComment(ctx.assessment), /not yet supported by the test harness/);
  assert.doesNotMatch(capabilityComment({ ...ctx.assessment, missingCapabilities: ['<script>unsafe</script>'] }), /<script>/);
  let posts = 0;
  const options = { authorizeComment: true, read: ctx.read, getToken: async () => 'fixture-token',
    fetchResponse: async (url, options) => {
      posts++;
      assert.equal(options.redirect, 'error');
      assert.equal(options.method, 'POST');
      assert.match(url, /workItems\/123\/comments\?format=html&api-version=7.1-preview.4$/);
      assert.match(JSON.parse(options.body).text, /AgenticHarnessRequest/);
      return Response.json({ id: 44, workItemId: 123 });
    } };
  await assert.rejects(publishCapabilityComment(ctx.config, ctx.ledger, ctx.assessment.id, { ...options, authorizeComment: false }), /authorization/);
  assert.equal(posts, 0);
  const result = await publishCapabilityComment(ctx.config, ctx.ledger, ctx.assessment.id, options);
  assert.equal(result.commentId, 44);
  assert.deepEqual(await publishCapabilityComment(ctx.config, ctx.ledger, ctx.assessment.id, options), result);
  assert.equal(posts, 1);
  const repeated = recordCapabilityAssessment(ctx.config, ctx.ledger, { ...ctx.assessmentInput, reviewedAt: '2026-10-03T00:00:00Z' });
  await publishCapabilityComment(ctx.config, ctx.ledger, repeated.id, options);
  assert.equal(posts, 1);
});

test('feedback refuses unapproved local state before ledger or external access', async t => {
  const ctx = await harnessFixture(t);
  ctx.config.statePolicy.accessApproved = false;
  const ledger = new Proxy({}, { get() { assert.fail('Ledger accessed before state approval'); } });
  const forbidden = () => assert.fail('External boundary called before state approval');
  await assert.rejects(publishCapabilityComment(ctx.config, ledger, ctx.assessment.id, {
    authorizeComment: true, read: forbidden, getToken: forbidden, fetchResponse: forbidden
  }), /approved local state/);
  assert.throws(() => reconcileCapabilityComment(ctx.config, ledger, {}, { authorizeReconciliation: true }), /approved local state/);
});

for (const change of ['source', 'authorization']) test(`feedback admission rechecks ${change} after authentication`, async t => {
  const ctx = await harnessFixture(t);
  let posts = 0;
  await assert.rejects(publishCapabilityComment(ctx.config, ctx.ledger, ctx.assessment.id, { authorizeComment: true,
    getToken: async () => {
      if (change === 'source') { ctx.item.rev++; ctx.item.fields['System.Title'] += ' changed during auth'; }
      else ctx.config.adoTestRequests.feedback.enabled = false;
      return 'fixture-token';
    }, read: ctx.read, fetchResponse: async () => { posts++; assert.fail('Feedback POST after revoked admission'); }
  }), /changed before feedback|authorization/);
  assert.equal(posts, 0);
  assert.equal(ctx.ledger.status().operations.some(row => row.kind === 'ado-test-request-feedback'), false);
});

test('feedback activation does not invalidate unchanged intake or capability assessment', async t => {
  const ctx = await harnessFixture(t);
  ctx.config.adoTestRequests.feedback.enabled = false;
  assert.deepEqual(await collectTestRequest(ctx.config, ctx.ledger, 123, { read: ctx.read }), ctx.intake);
  assert.deepEqual(recordCapabilityAssessment(ctx.config, ctx.ledger, ctx.assessmentInput), ctx.assessment);
  await assert.rejects(publishCapabilityComment(ctx.config, ctx.ledger, ctx.assessment.id, { authorizeComment: true }), /authorization/);
  ctx.config.adoTestRequests.feedback = { enabled: true, scopeApproved: true, approvalRef: 'new-feedback-grant' };
  assert.deepEqual(await collectTestRequest(ctx.config, ctx.ledger, 123, { read: ctx.read }), ctx.intake);
  const result = await publishCapabilityComment(ctx.config, ctx.ledger, ctx.assessment.id, { authorizeComment: true,
    read: ctx.read, getToken: async () => 'fixture-token', fetchResponse: async () => Response.json({ id: 70, workItemId: 123 }) });
  assert.equal(result.commentId, 70);
});

for (const status of [401, 403]) test(`definitive ${status} feedback rejection permits only an authorized retry`, async t => {
  const ctx = await harnessFixture(t);
  let posts = 0;
  const options = { authorizeComment: true, read: ctx.read, getToken: async () => 'fixture-token',
    fetchResponse: async () => { posts++; return posts === 1 ? new Response('', { status }) : Response.json({ id: 71, workItemId: 123 }); } };
  await assert.rejects(publishCapabilityComment(ctx.config, ctx.ledger, ctx.assessment.id, options), error => error.code === 'blocked-auth');
  const rejected = ctx.ledger.status().operations.find(row => row.kind === 'ado-test-request-feedback');
  assert.equal(rejected.state, 'rejected');
  assert.equal(JSON.parse(rejected.detail).status, status);
  await assert.rejects(publishCapabilityComment(ctx.config, ctx.ledger, ctx.assessment.id, options), /retry-rejected/);
  assert.equal(posts, 1);
  const result = await publishCapabilityComment(ctx.config, ctx.ledger, ctx.assessment.id, { ...options, retryRejected: true });
  assert.equal(result.commentId, 71);
  assert.equal(result.attempts, 2);
  assert.equal(result.prior.detail.status, status);
  assert.equal(posts, 2);
});

for (const disposition of ['posted', 'not-posted']) test(`uncertain feedback blocks newer revisions until explicit ${disposition} reconciliation`, async t => {
  const ctx = await harnessFixture(t);
  let posts = 0;
  const options = { authorizeComment: true, read: ctx.read, getToken: async () => 'fixture-token',
    fetchResponse: async () => { posts++; throw new Error('response lost'); } };
  await assert.rejects(publishCapabilityComment(ctx.config, ctx.ledger, ctx.assessment.id, options), /uncertain/);
  const uncertain = ctx.ledger.status().operations.find(row => row.kind === 'ado-test-request-feedback');
  ctx.item.rev++;
  const intake = await collectTestRequest(ctx.config, ctx.ledger, 123, { read: ctx.read });
  const assessment = recordCapabilityAssessment(ctx.config, ctx.ledger, { ...ctx.assessmentInput, intakeId: intake.id,
    intakeSha256: hash(json(intake)), reviewedAt: now() });
  await assert.rejects(publishCapabilityComment(ctx.config, ctx.ledger, assessment.id, { ...options, retryRejected: true }), /uncertain/);
  assert.equal(posts, 1);
  const reconciliation = { operationId: uncertain.id, expectedOperationSha256: hash(json(uncertain)),
    disposition, commentId: disposition === 'posted' ? 73 : null, reviewer: 'human-fixture', reviewedAt: now(),
    evidenceRef: 'Synthetic bounded ADO comment history inspection' };
  assert.throws(() => reconcileCapabilityComment(ctx.config, ctx.ledger, reconciliation), /authorization/);
  assert.throws(() => reconcileCapabilityComment(ctx.config, ctx.ledger, { ...reconciliation, expectedOperationSha256: 'a'.repeat(64) },
    { authorizeReconciliation: true }), /operation changed/);
  reconcileCapabilityComment(ctx.config, ctx.ledger, reconciliation, { authorizeReconciliation: true });
  assert.equal(ctx.ledger.status().operations.find(row => row.id === uncertain.id).state, disposition === 'posted' ? 'complete' : 'not-posted');
  const result = await publishCapabilityComment(ctx.config, ctx.ledger, assessment.id, { ...options,
    fetchResponse: async () => { posts++; return Response.json({ id: 74, workItemId: 123 }); } });
  assert.equal(result.commentId, 74);
  assert.equal(posts, 2);
});

test('reconciled not-posted feedback retries the same revision only with explicit authorization', async t => {
  const ctx = await harnessFixture(t);
  let posts = 0;
  const options = { authorizeComment: true, read: ctx.read, getToken: async () => 'fixture-token',
    fetchResponse: async () => { posts++; throw new Error('uncertain response'); } };
  await assert.rejects(publishCapabilityComment(ctx.config, ctx.ledger, ctx.assessment.id, options), /uncertain/);
  const row = ctx.ledger.status().operations.find(row => row.kind === 'ado-test-request-feedback');
  reconcileCapabilityComment(ctx.config, ctx.ledger, { operationId: row.id, expectedOperationSha256: hash(json(row)),
    disposition: 'not-posted', commentId: null, reviewer: 'fixture-owner', reviewedAt: now(),
    evidenceRef: 'Synthetic inspected remote history and stopped original publisher' }, { authorizeReconciliation: true });
  await assert.rejects(publishCapabilityComment(ctx.config, ctx.ledger, ctx.assessment.id, options), /retry-rejected/);
  const result = await publishCapabilityComment(ctx.config, ctx.ledger, ctx.assessment.id, { ...options, retryRejected: true,
    fetchResponse: async () => { posts++; return Response.json({ id: 75, workItemId: 123 }); } });
  assert.equal(posts, 2);
  assert.equal(result.prior.detail.reconciliation.disposition, 'not-posted');
});

test('uncertain ADO writes never retry and changed requests never post', async t => {
  const ctx = await harnessFixture(t);
  let posts = 0;
  const options = { authorizeComment: true, read: ctx.read, getToken: async () => 'fixture-token',
    fetchResponse: async () => { posts++; throw new Error('network lost after write'); } };
  ctx.item.rev++;
  await assert.rejects(publishCapabilityComment(ctx.config, ctx.ledger, ctx.assessment.id, options), /changed before feedback/);
  assert.equal(posts, 0);
  ctx.item.rev--;
  await assert.rejects(publishCapabilityComment(ctx.config, ctx.ledger, ctx.assessment.id, options), /uncertain/);
  await assert.rejects(publishCapabilityComment(ctx.config, ctx.ledger, ctx.assessment.id, options), /uncertain/);
  assert.equal(posts, 1);
});

function finishRequestFixture(toolkit) {
  toolkit.write('test/behavior.test.js', formulaTest);
  toolkit.write('test/behavior-card.md', '# Synthetic formula behavior\n');
  toolkit.finish({ outcome: 'propose-change', findings: 'Fixture test authored.', title: 'Fixture coverage',
    description: 'Synthetic test only.', skillResult: { status: 'succeeded', classification: 'missing-test-coverage',
      changedFiles: ['test/behavior.test.js', 'test/behavior-card.md'], testsAddedOrUpdated: ['formula preservation'],
      behaviorCardsAddedOrUpdated: ['test/behavior-card.md'], unknowns: [], needsHumanDecision: false } });
}

for (const drift of ['none', 'source-refresh', 'push-auth'])
  test(`ADO supported publication pins the validated revision through ${drift}`, async t => {
    const ctx = await requestFixture(t);
    ctx.config.activation.dispatch = true;
    ctx.config.limits.maxAiCreditsPerSession = 1;
    const repo = ctx.config.repositories[0];
    repo.draftBuild = { enabled: true, provider: 'ado', id: 'fixture-build', definitionId: 2 };
    await command('git', ['init', '--bare', '--quiet', ctx.remote], ctx.root);
    const transportRepo = { ...repo, remote: 'https://dev.azure.com/fixture/project/_git/repo',
      pr: { provider: 'ado', organization: 'fixture', project: 'project', repositoryId: 'repo', targetRef: 'refs/heads/main' } };
    let validated, workspace, advanced, pushed, build, draft, posts = 0;
    const advance = async () => {
      if (advanced) return;
      writeFileSync(join(workspace, 'unvalidated.txt'), 'This content has not passed validation.\n');
      await command('git', ['add', '--', 'unvalidated.txt'], workspace);
      await command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
        'commit', '--quiet', '-m', 'Unvalidated checkout advance'], workspace);
      advanced = (await command('git', ['rev-parse', 'HEAD'], workspace)).stdout.trim();
      assert.notEqual(advanced, validated);
    };
    const read = async () => {
      if (validated && drift === 'source-refresh') await advance();
      return ctx.item;
    };
    const result = await acceptTestRequest(ctx.config, ctx.ledger, ctx.handoff, {
      execute: true, authorizeCommit: true, authorizePush: true, authorizeDraftPR: true, read,
      dispatchDependencies: {
        runModel: async (_c, _l, _j, _a, _i, toolkit) => finishRequestFixture(toolkit),
        runValidation: async (...args) => {
          const output = await runValidation(...args);
          validated = args[4]; workspace = args[2].workspace;
          return output;
        },
        pushBranch: async (config, path, _repo, refspec, admission) => {
          assert.equal(refspec.split(':')[0], validated);
          await pushDraftBranch(config, path, transportRepo, refspec, { ...admission,
            getToken: async () => { if (drift === 'push-auth') await advance(); return 'fixture-token'; },
            execute: async (cwd, args) => command('git', args, cwd) });
          pushed = (await command('git', ['--git-dir', ctx.remote, 'rev-parse', refspec.split(':').slice(1).join(':')], ctx.root)).stdout.trim();
        },
        queueDraftBuild: (config, ledger, job, _repo, revision, _request, admission) =>
          queueAdoDraftBuild(config, ledger, job, transportRepo, revision, undefined, { ...admission,
            getToken: async () => 'fixture-token', fetchResponse: async (_url, options) => {
              assert.equal(options.method, 'POST'); build = JSON.parse(options.body);
              return Response.json({ id: 5 });
            } }),
        createDraft: (config, ledger, job, _repo, revision, proposal, _request, allow, admission) =>
          createAdoDraft(config, ledger, job, transportRepo, revision, proposal, undefined, allow, { ...admission,
            getToken: async () => 'fixture-token', fetchResponse: async (_url, options) => {
              if (options.method === 'GET') return Response.json({ value: [] });
              posts++; draft = JSON.parse(options.body);
              return Response.json({ ...draft, pullRequestId: 9, status: 'active', lastMergeSourceCommit: { commitId: pushed } });
            } })
      }
    });
    assert.equal(result.result.outcome, 'draft-pr-validated');
    assert.equal(pushed, validated);
    assert.equal(build.sourceVersion, validated);
    assert.equal(result.result.draftPR.headRevision, validated);
    assert.equal(result.result.sourceRevision, validated);
    assert.equal(result.result.validation[0].sourceRevision, validated);
    assert.equal(posts, 1);
    const push = ctx.ledger.status().operations.find(row => row.id === `${result.assignment.id}:push`);
    assert.equal(JSON.parse(push.detail).revision, validated);
    assert.equal(draft.sourceRefName, build.sourceBranch);
    if (drift !== 'none') {
      assert.notEqual(pushed, advanced);
      assert.equal((await command('git', ['--git-dir', ctx.remote, 'ls-tree', pushed, '--', 'unvalidated.txt'], ctx.root)).stdout, '');
    }
  });

for (const change of ['withdrawal', 'revision'])
  test(`ADO final admission reads current details after WIQL during ${change}`, async t => {
    const ctx = await requestFixture(t);
    const prepared = prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff);
    const original = structuredClone(ctx.item);
    let calls = 0, mutations = 0;
    const read = (config, id) => readCurrentTestRequest(config, id, {
      getToken: async () => 'fixture-token', fetchResponse: async (_url, options) => {
        calls++;
        const body = JSON.parse(options.body);
        if (body.query) return Response.json({ asOf: original.snapshotAt, workItems: [{ id }] });
        withdrawRequest(ctx, change === 'revision');
        // A historical request would return the old, still-eligible revision.
        return Response.json({ value: [body.asOf ? original : ctx.item] });
      }
    });
    await assert.rejects(pushDraftBranch(ctx.config, ctx.root, ctx.config.repositories[0],
      `${ctx.baseRevision}:refs/heads/fixture`, { ledger: ctx.ledger, assignmentId: prepared.assignment.id,
        readTestRequest: read, execute: async () => { mutations++; } }), /approved test-request|changed or was withdrawn/);
    assert.equal(calls, 2);
    assert.equal(mutations, 0);
  });

for (const phase of ['new', 'prepared', 'validation'])
  test(`ADO rejects remote validation at ${phase} before any Agency request`, async t => {
    const ctx = await requestFixture(t);
    const prepared = phase === 'new' ? null : prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff);
    const contractPath = join(ctx.root, 'remote-contract.json');
    const profilePath = join(ctx.root, 'remote-profile.ps1');
    writeFileSync(profilePath, 'exit 0\n');
    const repo = ctx.config.repositories[0], gate = repo.validationGates[0];
    gate.profilePath = profilePath;
    gate.profileSha256 = hash(readFileSync(profilePath));
    const pipeline = { revision: 'b'.repeat(40), yamlSha256: hash('synthetic pipeline'), definitionId: 10,
      definitionRevision: 2, ref: 'refs/heads/fixture', yamlPath: '/pipeline.yml',
      organization: 'https://dev.azure.com/fixture', project: 'Fixture', repositoryId: 'fixture', artifactPrefix: 'Fixture-' };
    const contract = { schema: 'agency-oa-validation-contract-v1', repoId: repo.id, candidate: ctx.baseRevision,
      gateId: gate.id, profileSha256: gate.profileSha256, pipeline,
      requiredTasks: ['prepare', 'validate'], prepareTask: 'prepare', validationTask: 'validate',
      testPopulation: { suites: 1, tests: 1, path: 'test/behavior.test.js' }, sourceInputs: ['src/value.js'],
      executable: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
      profilePath: 'F:\\fixture\\profile.ps1', maximumRunnerMinutes: 10, maximumArtifactBytes: 1024,
      queueMinutes: 1, cancellationMinutes: 1, pollSeconds: 1,
      request: { prompt: 'Synthetic validation only.', compute: { $type: 'pipeline', pipelineId: 10, pipelineRefOverride: pipeline.ref },
        context: { repository: { $type: 'ado', organization: 'fixture', project: 'Fixture' } },
        additionalOptions: { pluginOptions: { includeDefaults: false } },
        metadata: { candidate: ctx.baseRevision, pipelineCommit: pipeline.revision,
          profileSha256: gate.profileSha256, pipelineYamlSha256: pipeline.yamlSha256, productPullRequests: 'forbidden' } } };
    writeFileSync(contractPath, json(contract));
    repo.remoteValidation = { type: 'agency-remote', contractPath, contractSha256: hash(json(contract)) };
    assert.deepEqual(remoteValidationContract(repo, ctx.baseRevision), contract);
    let effects = 0;
    if (phase === 'new') assert.throws(() => prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff), /remote validation/);
    else if (phase === 'prepared') await assert.rejects(dispatchAdoTestRequest(ctx.config, ctx.ledger, prepared.assignment.id,
      { readTestRequest: async () => { effects++; }, runModel: async () => { effects++; } }), /remote validation/);
    else await assert.rejects(runValidation(ctx.config, ctx.ledger, { ...prepared.job, workspace: ctx.root }, repo,
      ctx.baseRevision, async () => { effects++; }, undefined, null,
      { transport: async () => { effects++; } }), /remote validation/);
    assert.equal(effects, 0);
    assert.equal(ctx.ledger.status().operations.some(row => row.kind.startsWith('agency-')), false);
    if (phase === 'new') assert.equal(ctx.ledger.status().jobs.length, 0);
  });

for (const grant of ['commit', 'push', 'createDraftPR'])
  test(`ADO assignment reconstruction retains ${grant} and rejects prepared revocation`, async t => {
    const ctx = await requestFixture(t);
    const prepared = prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff);
    assert.equal(prepared.assignment.publicationGrants[grant], true);
    ctx.config.repositories[0].skillBindings[0].sideEffects[grant] = false;
    const investigation = ctx.ledger.get('investigation', prepared.assignment.investigationId);
    const rebuilt = makePlannedImprovementAssignment(ctx.config, ctx.ledger, investigation,
      prepared.assignment.testCoveragePlanId, prepared.assignment.requestedOutcome);
    assert.equal(rebuilt.publicationGrants[grant], false);
    assert.throws(() => requireCurrentAssignment(ctx.config, ctx.ledger, investigation, prepared.assignment), /changed after preparation/);
    ctx.config.activation.dispatch = true;
    ctx.config.limits.maxAiCreditsPerSession = 1;
    await assert.rejects(dispatchAdoTestRequest(ctx.config, ctx.ledger, prepared.assignment.id,
      { readTestRequest: ctx.read, runModel: async () => assert.fail('Revoked assignment must not author') }), /changed after preparation/);
  });

for (const action of ['commit', 'push', 'build', 'draft'])
  for (const interruption of action === 'commit' ? ['staging'] : ['authentication', 'source-read'])
  test(`ADO ${action} transport rejects grant revocation during ${interruption}`, async t => {
    const ctx = await requestFixture(t);
    const prepared = prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff);
    const grant = action === 'draft' ? 'createDraftPR' : action === 'build' ? 'push' : action;
    const revoke = () => { ctx.config.repositories[0].skillBindings[0].sideEffects[grant] = false; };
    const repo = { ...ctx.config.repositories[0], remote: 'https://dev.azure.com/fixture/project/_git/repo',
      pr: { provider: 'ado', organization: 'fixture', project: 'project', repositoryId: 'repo', targetRef: 'refs/heads/main' },
      draftBuild: { enabled: true, provider: 'ado', id: 'fixture-build', definitionId: 2 } };
    let mutations = 0;
    const admission = { ledger: ctx.ledger, assignmentId: prepared.assignment.id,
      readTestRequest: async () => { if (interruption === 'source-read') revoke(); return ctx.item; },
      getToken: async () => { if (interruption === 'authentication') revoke(); return 'fixture-token'; },
      execute: async () => { mutations++; }, fetchResponse: async (_url, options) => {
        if (options.method === 'GET') return Response.json({ value: [] });
        mutations++; return Response.json({});
      } };
    const failure = /changed after preparation|does not authorize/;
    if (action === 'commit') await assert.rejects(commitRepositoryChanges(ctx.config, ctx.root, repo, 'Fixture',
      async (_exe, args) => { assert.ok(args.includes('add')); revoke(); }, admission), failure);
    if (action === 'push') await assert.rejects(pushDraftBranch(ctx.config, ctx.root, repo,
      `${ctx.baseRevision}:refs/heads/fixture`, admission), failure);
    if (action === 'build') await assert.rejects(queueAdoDraftBuild(ctx.config, ctx.ledger, prepared.job, repo,
      ctx.baseRevision, undefined, admission), failure);
    if (action === 'draft') await assert.rejects(createAdoDraft(ctx.config, ctx.ledger, prepared.job, repo,
      ctx.baseRevision, { title: 'Fixture', description: 'Fixture' }, undefined, true, admission), failure);
    assert.equal(mutations, 0);
    assert.equal(ctx.ledger.status().operations.some(row => ['draft-pr', 'draft-build'].includes(row.kind)), false);
  });

for (const transport of ['native', 'override'])
  test(`ADO ${transport} build rechecks expiry after the final source refresh`, async t => {
    const ctx = await requestFixture(t);
    const prepared = prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff);
    const repo = { ...ctx.config.repositories[0], baseRef: ctx.baseRevision,
      pr: { provider: 'ado', organization: 'fixture', project: 'project', repositoryId: 'repo', targetRef: 'refs/heads/main' },
      draftBuild: { enabled: true, provider: 'ado', id: 'fixture-build', definitionId: 2 } };
    const started = Date.now(), authorityPath = join(ctx.root, 'authority.json');
    const authority = { format: 'al-recurring-authorization-v1', planSha256: 'c'.repeat(64),
      approvedAt: new Date(started - 1000).toISOString(), expiresAt: new Date(started + 1000).toISOString(),
      allowModels: true, allowPublication: true };
    writeFileSync(authorityPath, json(authority));
    ctx.config.runtime.executionAuthorization = { repoId: repo.id, baseRevision: repo.baseRef,
      planSha256: authority.planSha256, reference: { path: authorityPath, sha256: hash(json(authority)) } };
    let time = started, reads = 0, mutations = 0;
    t.mock.method(Date, 'now', () => time);
    await assert.rejects(queueAdoDraftBuild(ctx.config, ctx.ledger, prepared.job, repo, ctx.baseRevision,
      transport === 'override' ? async () => { mutations++; } : undefined, {
        getToken: async () => 'fixture-token',
        readTestRequest: async () => { reads++; time += 1001; return ctx.item; },
        fetchResponse: async () => { mutations++; }
      }), /authorization expired/);
    assert.equal(reads, 1);
    assert.equal(mutations, 0);
    assert.equal(ctx.ledger.status().operations.some(row => row.kind === 'draft-build'), false);
  });

test('ADO legacy assignment without captured publication grants cannot resume effects', async t => {
  const ctx = await requestFixture(t);
  const { assignment } = prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff);
  const legacy = structuredClone(assignment);
  delete legacy.publicationGrants;
  assert.throws(() => requireCurrentAssignment(ctx.config, ctx.ledger,
    ctx.ledger.get('investigation', assignment.investigationId), legacy), /changed after preparation/);
  assert.throws(() => requireTestRequestPublication(ctx.config, ctx.ledger, legacy, 'push'), /does not authorize/);
});

for (const action of ['commit', 'push', 'build', 'draft'])
  test(`ADO publication needs the action-specific ${action} grant even with a matching assignment`, async t => {
    const ctx = await requestFixture(t);
    const grant = action === 'draft' ? 'createDraftPR' : action === 'build' ? 'push' : action;
    ctx.config.repositories[0].skillBindings[0].sideEffects[grant] = false;
    const prepared = prepareTestRequest(ctx.config, ctx.ledger, ctx.handoff);
    assert.throws(() => requireTestRequestPublication(ctx.config, ctx.ledger, prepared.assignment, action), /does not authorize/);
  });

async function addOneJsRepository(ctx, {
  enableDraftBuild = false, validationScript = null
} = {}) {
  const reference = join(ctx.root, '1js-reference');
  const remote = join(ctx.root, '1js-remote.git');
  const skillPath = '.github/skills/author-declarative-e2e-test/SKILL.md';
  const scenarioPrefix = 'ooui/apps/cross-office-client-e2e/scenarios';
  const scenarioPath = `${scenarioPrefix}/bizchat-create-canary-excel${enableDraftBuild ? '/scenario' : ''}.yaml`;
  mkdirSync(join(reference, '.github', 'skills', 'author-declarative-e2e-test'), { recursive: true });
  mkdirSync(join(reference, scenarioPrefix), { recursive: true });
  mkdirSync(join(reference, 'scripts'), { recursive: true });
  const skill = '# Fixture declarative E2E skill\nAuthor the validated mini-spec batch.\n';
  writeFileSync(join(reference, skillPath), skill);
  writeFileSync(join(reference, scenarioPrefix, 'existing.yaml'), 'name: existing\n');
  writeFileSync(join(reference, 'scripts', 'validate-generated.mjs'),
    validationScript ?? ("import { readFileSync } from 'node:fs';\n" +
    `const text = readFileSync('${scenarioPath}', 'utf8');\n` +
    "if (!text.includes('Canary') || !text.includes('4x3')) process.exit(1);\n"));
  const git = args => command('git', ['-c', 'core.hooksPath=.git/no-hooks',
    '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], reference);
  await git(['init', '--quiet']);
  await git(['add', '.']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Fixture 1JS base']);
  const baseRevision = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const repo = {
    id: '1js',
    projectId: 'fixture-1js',
    owner: 'fixture-1js-owner',
    routingApproved: true,
    routingRules: ['Reviewed declarative E2E handoff'],
    referenceCheckout: reference,
    baseRef: 'HEAD',
    remote,
    allowedWritePrefixes: [scenarioPrefix],
    allowedWriteFiles: [],
    commitIdentity: { name: 'Fixture', email: 'fixture@example.invalid' },
    validationGates: [{
      id: 'fixture-1js-local-five',
      approved: true,
      isolationVerified: true,
      executable: process.execPath,
      args: ['scripts/validate-generated.mjs', scenarioPath],
      timeoutMs: 10000
    }],
    skillBindings: [{
      id: '1js-declarative-e2e-authoring',
      capability: 'declarative-e2e-authoring',
      skillPath,
      inputFormat: 'declarative-e2e-mini-spec-batch-v1',
      enabled: true,
      qualification: 'qualified',
      requestedOutcomes: ['add-declarative-e2e-tests'],
      allowedWritePrefixes: [scenarioPrefix],
      allowedWriteFiles: [],
      requiresBehaviorCard: false,
      sideEffects: { commit: true, push: true, createDraftPR: true }
    }],
    draftBuild: {
      enabled: enableDraftBuild,
      provider: 'ado',
      id: '1js-pipeline-36540',
      definitionId: 36540,
      templateParameters: { excelAgentExperience: 'omni' }
    },
    pr: {
      provider: 'ado',
      organization: 'office',
      project: 'Office',
      repositoryId: '1JS',
      sourceBranchPrefix: 'user/fixture/periodic-evidence-agent',
      targetRef: 'refs/heads/main'
    }
  };
  ctx.config.repositories.push(repo);
  const validationContract = repositoryValidationContract(repo);
  ctx.ledger.qualify(skillQualificationId(repo.id, repo.skillBindings[0].id), {
    state: 'qualified-read-only',
    repoId: repo.id,
    bindingId: repo.skillBindings[0].id,
    capability: repo.skillBindings[0].capability,
    referenceCheckout: reference,
    remote,
    baseRef: 'HEAD',
    baseRevision,
    skillPath,
    skillSha256: hash(skill),
    qualificationSource: 'local-reference',
    validationContractVersion: validationContract.version,
    validationContractSha256: validationContract.sha256,
    sideEffects: { commit: true, push: true, createDraftPR: true }
  });
  return { repo, reference, remote, baseRevision, scenarioPath };
}

async function blockedPreModelFixture(t, mutateResult = () => {},
  error = { code: 'blocked-repository-git', message: 'Repository skill Git show failed' }, options = {}) {
  const ctx = await setup(t, options);
  ctx.config.executionMode = 'standalone-sdk';
  ctx.config.limits.maxAiCreditsPerSession = 10;
  const prepared = prepareReviewedHandoff(ctx.config, ctx.ledger, fixture);
  const repo = ctx.config.repositories[0];
  await command('git', ['remote', 'add', 'origin', repo.remote], repo.referenceCheckout);
  const isolated = await provision(ctx.config, prepared.job, repo, prepared.assignment.skillQualification);
  ctx.ledger.moveJob(prepared.job.id, 'prepared', 'running', isolated);
  ctx.ledger.moveJob(prepared.job.id, 'running', 'blocked', { error });
  const limit = prepared.assignment.bounds.maxToolCalls;
  const result = {
    recordType: 'workerResult', schemaVersion: '1.0', id: 'pre-model-fixture',
    assignmentId: prepared.job.id, attemptId: prepared.job.session_id,
    reportedAt: now(), outcome: 'blocked', findings: 'Fixture pre-model Git failure',
    evidenceIds: prepared.assignment.evidenceIds, sourceRevision: null, draftPR: null,
    validation: [], validationAttempts: [], skillExecution: null,
    toolUsage: { limit, used: 0, remaining: limit,
      byTool: { pilot_list: 0, pilot_search: 0, pilot_read: 0, pilot_write: 0, pilot_finish: 0 }, rounds: [] },
    blocker: { owner: repo.owner, reason: error?.message ?? 'Fixture missing bounded edit tool',
      unblockCondition: 'Explicit user authorization after fix' },
    nextAction: 'Reconcile without replay'
  };
  mutateResult(result, ctx);
  ctx.ledger.put(result);
  const nextConfig = { ...structuredClone(ctx.config), stateDirectory: join(ctx.root, 'continuation') };
  const nextLedger = new Ledger(nextConfig.stateDirectory);
  ctx.additionalLedgers.push(nextLedger);
  const authorization = {
    approved: true, authorizedBy: 'user', authorizedAt: now(), maxModelAttempts: 1,
    previousAssignmentId: prepared.job.id, previousAttemptId: prepared.job.session_id,
    sourceRevision: ctx.baseRevision, nextConfigSha256: hash(json(nextConfig)),
    controllerRevision: (await command('git', ['rev-parse', 'HEAD'], process.cwd())).stdout.trim(),
    reason: 'Synthetic authorization for fixture only'
  };
  return { ...ctx, prepared, isolated, result, nextConfig, nextLedger, authorization };
}

async function runtimeFixture(t, mutateResult = () => {},
  failure = { code: 'blocked-runtime', message: 'Copilot executable not found on PATH' }, options = {}) {
  const ctx = await blockedPreModelFixture(t, (result, fixture) => {
    result.sourceRevision = fixture.baseRevision;
    result.remoteValidation = [];
    result.toolUsage.rounds = [{ round: 0, used: 0, cumulativeUsed: 0, status: 'failed' }];
    mutateResult(result, fixture);
  }, failure, options);
  ctx.config.runtime.cliPath = process.execPath;
  ctx.nextConfig.runtime.cliPath = process.execPath;
  const path = join(ctx.root, 'synthetic-runtime-smoke.json');
  const smoke = {
    checkedAt: now(), cliPath: process.execPath, cliSha256: hash(readFileSync(process.execPath)),
    customTool: 'executed',
    unavailableShell: 'rejected', modelInvoked: false, workplaceRead: false
  };
  writeFileSync(path, json(smoke));
  Object.assign(ctx.authorization, {
    kind: 'runtime-launch-path',
    nextConfigSha256: hash(json(ctx.nextConfig)),
    cliSha256: hash(readFileSync(process.execPath)),
    runtimeSmoke: { path, sha256: hash(readFileSync(path)) }
  });
  return ctx;
}

function toolBlockedResult(result, assignment) {
  result.toolUsage.used = 4;
  result.toolUsage.remaining = result.toolUsage.limit - 4;
  result.toolUsage.byTool = {
    pilot_list: 1, pilot_search: 1, pilot_read: 1,
    pilot_write: 0, pilot_replace_lines: 0, pilot_finish: 1
  };
  result.toolUsage.rounds = [{ round: 0, used: 4, cumulativeUsed: 4, status: 'completed' }];
  result.skillExecution = {
    bindingId: assignment.skillBindingId, capability: assignment.capability,
    skillPath: assignment.skillQualification.skillPath, skillRevision: result.sourceRevision,
    status: 'blocked', classification: 'bounded-edit-capability-unavailable',
    changedFiles: [], testsAddedOrUpdated: [], behaviorCardsAddedOrUpdated: [],
    unknowns: [], needsHumanDecision: false
  };
  return result;
}

async function toolFixture(t, options = {}) {
  const ctx = await runtimeFixture(t, (result, fixture) => {
    toolBlockedResult(result, fixture.ledger.get('assignment', result.assignmentId));
    if (options.capabilitySources) {
      result.skillExecution.classification = 'missing-mid-flow-protected-assertion-capability';
      result.skillExecution.unknowns = ['Synthetic missing intermediate assertion'];
      result.skillExecution.needsHumanDecision = true;
    }
    if (options.registrationRecovery) {
      Object.assign(result.skillExecution, {
        status: 'succeeded', classification: 'regression-coverage',
        changedFiles: ['test/authored.test.js'], testsAddedOrUpdated: ['test/authored.test.js']
      });
      result.toolUsage.byTool.pilot_read = 0;
      result.toolUsage.byTool.pilot_write = 1;
    }
  }, options.registrationRecovery ? { code: 'failed', message: 'Fixture registration setup failure' } : null,
  options);
  ctx.nextConfig.limits.workerMaxToolCalls = 180;
  ctx.nextConfig.limits.maxValidationRepairRounds = 2;
  Object.assign(ctx.authorization, {
    kind: 'bounded-authoring-tool', nextConfigSha256: hash(json(ctx.nextConfig)),
    executionBounds: {
      workerMaxToolCalls: { before: ctx.config.limits.workerMaxToolCalls, after: 180 },
      maxValidationRepairRounds: { before: ctx.config.limits.maxValidationRepairRounds, after: 2 }
    }
  });
  if (options.capabilitySources) {
    const path = join(ctx.root, 'synthetic-capability-review.json');
    writeFileSync(path, json({
      format: 'existing-declarative-capability-v1', sourceRevision: ctx.baseRevision,
      primitive: 'assert', property: 'visible', nativeLoaderVerified: true,
      explanation: 'Synthetic source-bound capability review; no product execution.',
      sourceFiles: ['schema', 'runner', 'ui-map'].map(name => ({
        path: `ooui/${name}.txt`, sha256: hash(`Synthetic ${name} source`)
      }))
    }));
    ctx.authorization.capabilityResolution = { path, sha256: hash(readFileSync(path)) };
  }
  if (options.registrationRecovery) {
    mkdirSync(join(ctx.isolated.workspace, 'test'));
    writeFileSync(join(ctx.isolated.workspace, 'test', 'authored.test.js'), '// Synthetic authored proposal\n');
    const path = join(ctx.root, 'synthetic-registration-recovery.json');
    writeFileSync(path, json({
      format: 'uncommitted-registration-recovery-v1', assignmentId: ctx.prepared.job.id,
      attemptId: ctx.prepared.job.session_id, workerResultSha256: hash(json(ctx.result)),
      sourceRevision: ctx.baseRevision, dependencySetup: 'passed', nativeLoader: 'passed',
      productInvocations: 0, unknownsResolved: true,
      fileSha256: { 'test/authored.test.js': hash('// Synthetic authored proposal\n') },
      explanation: 'Synthetic recovered setup. No product test or publication.'
    }));
    ctx.authorization.registrationRecovery = { path, sha256: hash(readFileSync(path)) };
    const operation = `${ctx.prepared.job.id}:declarative-registration:0`;
    ctx.ledger.operation(operation, ctx.prepared.job.id, 'declarative-registration', {});
    ctx.ledger.finishOperation(operation, 'blocked', { revision: ctx.baseRevision, round: 0 });
  }
  return ctx;
}

async function retainedRecoveryFixture(t, registeredAncestor) {
  const ctx = await toolFixture(t, { registrationRecovery: registeredAncestor }), id = ctx.prepared.job.id;
  const prepared = await prepareAuthoringToolContinuation(ctx.config, ctx.ledger, id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization);
  const isolated = await claimAuthoringToolWorkspace(ctx.nextConfig, ctx.nextLedger, id);
  ctx.nextLedger.moveJob(id, 'prepared', 'running', isolated);
  ctx.nextLedger.moveJob(id, 'running', 'blocked', {
    error: { code: 'failed', message: 'Synthetic registration failure' }
  });
  mkdirSync(join(isolated.workspace, 'test'), { recursive: true });
  writeFileSync(join(isolated.workspace, 'test', 'retained.js'), 'Synthetic retained source\n');
  const result = toolBlockedResult({
    ...structuredClone(ctx.result), id: 'retained-proposal-result',
    attemptId: prepared.job.session_id, reportedAt: now(),
    toolUsage: { ...ctx.result.toolUsage, limit: prepared.assignment.bounds.maxToolCalls }
  }, prepared.assignment);
  Object.assign(result.skillExecution, {
    status: 'succeeded', classification: 'regression-coverage',
    changedFiles: [...(registeredAncestor ? ['test/authored.test.js'] : []), 'test/retained.js'],
    testsAddedOrUpdated: ['test/retained.js'],
    needsHumanDecision: false
  });
  result.toolUsage.byTool.pilot_read = 0;
  result.toolUsage.byTool.pilot_write = 1;
  ctx.nextLedger.put(result);
  const operation = `${id}:declarative-registration:0`;
  ctx.nextLedger.operation(operation, id, 'declarative-registration', {});
  ctx.nextLedger.finishOperation(operation, 'blocked', { revision: ctx.baseRevision, round: 0 });
  const path = join(ctx.root, 'retained-recovery.json');
  writeFileSync(path, json({
    format: 'uncommitted-registration-recovery-v1', assignmentId: id,
    attemptId: prepared.job.session_id, workerResultSha256: hash(json(result)),
    sourceRevision: ctx.baseRevision, dependencySetup: 'passed', nativeLoader: 'passed',
    productInvocations: 0, unknownsResolved: true,
    fileSha256: {
      ...(registeredAncestor ? { 'test/authored.test.js': hash('// Synthetic authored proposal\n') } : {}),
      'test/retained.js': hash('Synthetic retained source\n')
    },
    explanation: 'Synthetic descendant-only source; no product invocation.'
  }));
  const next = { ...structuredClone(ctx.nextConfig), stateDirectory: join(ctx.root, 'registration') };
  const ledger = new Ledger(next.stateDirectory);
  ctx.additionalLedgers.push(ledger);
  const authorization = {
    ...ctx.authorization, scope: 'until-native-validation',
    priorAuthorizationSha256: hash(json(ctx.authorization)),
    previousAttemptId: prepared.job.session_id, nextConfigSha256: hash(json(next)),
    registrationRecovery: { path, sha256: hash(readFileSync(path)) }
  };
  await prepareAuthoringToolContinuation(ctx.nextConfig, ctx.nextLedger, id, next, ledger, authorization);
  assert.deepEqual(await claimAuthoringToolWorkspace(next, ledger, id), isolated);
  assert.equal(readFileSync(join(isolated.workspace, 'test', 'retained.js'), 'utf8'),
    'Synthetic retained source\n');
  assert.deepEqual(ctx.ledger.get('workerResult', ctx.result.id), ctx.result);
}
for (const registeredAncestor of [false, true])
  test(`reviewed uncommitted recovery preserves consumed ancestors (registration=${registeredAncestor})`,
    t => retainedRecoveryFixture(t, registeredAncestor));

for (const condition of ['valid', 'file-drift', 'result-drift', 'unexpected-file', 'validation-started']) {
  test(`uncommitted owner registration recovery ${condition}`, async t => {
    const ctx = await toolFixture(t, { registrationRecovery: true }), id = ctx.prepared.job.id;
    if (condition === 'file-drift')
      writeFileSync(join(ctx.isolated.workspace, 'test', 'authored.test.js'), '// Changed after review\n');
    if (condition === 'unexpected-file')
      writeFileSync(join(ctx.isolated.workspace, 'unexpected.txt'), 'Not skill-authored');
    if (condition === 'result-drift') {
      const reference = ctx.authorization.registrationRecovery;
      const review = JSON.parse(readFileSync(reference.path, 'utf8'));
      review.workerResultSha256 = 'f'.repeat(64);
      writeFileSync(reference.path, json(review));
      reference.sha256 = hash(readFileSync(reference.path));
    }
    if (condition === 'validation-started')
      ctx.ledger.operation('unexpected-validation', id, 'validation', {});
    if (condition === 'valid') {
      await prepareAuthoringToolContinuation(ctx.config, ctx.ledger, id,
        ctx.nextConfig, ctx.nextLedger, ctx.authorization);
      assert.deepEqual(await claimAuthoringToolWorkspace(ctx.nextConfig, ctx.nextLedger, id), ctx.isolated);
      assert.deepEqual(ctx.ledger.get('workerResult', ctx.result.id), ctx.result);
      assert.equal(ctx.ledger.job(id).state, 'blocked');
    } else {
      await assert.rejects(prepareAuthoringToolContinuation(ctx.config, ctx.ledger, id,
        ctx.nextConfig, ctx.nextLedger, ctx.authorization));
      assert.equal(ctx.nextLedger.status().jobs.length, 0);
    }
  });
}

test('existing capability reconciliation requires a reviewed source-bound proof and rechecks it at claim', async t => {
  const ctx = await toolFixture(t, { capabilitySources: true }), id = ctx.prepared.job.id;
  const proof = ctx.authorization.capabilityResolution;
  ctx.authorization.capabilityResolution = null;
  await assert.rejects(prepareAuthoringToolContinuation(ctx.config, ctx.ledger, id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization), /source-bound existing-capability/);
  ctx.authorization.capabilityResolution = proof;
  await prepareAuthoringToolContinuation(ctx.config, ctx.ledger, id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization);
  writeFileSync(proof.path, '{}');
  await assert.rejects(claimAuthoringToolWorkspace(ctx.nextConfig, ctx.nextLedger, id),
    /Capability review changed/);
  assert.equal(ctx.ledger.job(id).state, 'blocked');
});

for (const condition of ['valid', 'stale-source', 'different-primitive', 'changed-source']) {
  test(`existing mid-flow capability reconciliation ${condition}`, async t => {
    const ctx = await toolFixture(t, { capabilitySources: true }), id = ctx.prepared.job.id;
    const reference = ctx.authorization.capabilityResolution;
    const proof = JSON.parse(readFileSync(reference.path, 'utf8'));
    if (condition === 'stale-source') proof.sourceRevision = 'f'.repeat(40);
    if (condition === 'different-primitive') proof.primitive = 'assert-provider';
    if (condition === 'changed-source') proof.sourceFiles[0].sha256 = 'f'.repeat(64);
    writeFileSync(reference.path, json(proof));
    reference.sha256 = hash(readFileSync(reference.path));
    if (condition === 'valid') {
      await prepareAuthoringToolContinuation(ctx.config, ctx.ledger, id,
        ctx.nextConfig, ctx.nextLedger, ctx.authorization);
      assert.deepEqual(await claimAuthoringToolWorkspace(ctx.nextConfig, ctx.nextLedger, id), ctx.isolated);
    } else {
      await assert.rejects(prepareAuthoringToolContinuation(ctx.config, ctx.ledger, id,
        ctx.nextConfig, ctx.nextLedger, ctx.authorization),
      error => error.code === 'blocked-reconciliation');
      assert.equal(ctx.nextLedger.status().jobs.length, 0);
    }
  });
}

for (const condition of ['valid', 'unlinked-grant', 'missing-scope']) {
  test(`continued user validation grant ${condition} preserves the consumed authoring lineage`, async t => {
    const ctx = await toolFixture(t), id = ctx.prepared.job.id;
    const prepared = await prepareAuthoringToolContinuation(ctx.config, ctx.ledger, id,
      ctx.nextConfig, ctx.nextLedger, ctx.authorization);
    const isolated = await claimAuthoringToolWorkspace(ctx.nextConfig, ctx.nextLedger, id);
    ctx.nextLedger.moveJob(id, 'prepared', 'running', isolated);
    ctx.nextLedger.moveJob(id, 'running', 'blocked');
    ctx.nextLedger.put(toolBlockedResult({
      ...structuredClone(ctx.result), id: 'read-only-successor-result',
      attemptId: prepared.job.session_id, reportedAt: new Date(Date.now() + 30000).toISOString(),
      toolUsage: { ...ctx.result.toolUsage, limit: prepared.assignment.bounds.maxToolCalls }
    }, prepared.assignment));
    const next = { ...structuredClone(ctx.nextConfig), stateDirectory: join(ctx.root, 'successor') };
    const ledger = new Ledger(next.stateDirectory);
    ctx.additionalLedgers.push(ledger);
    const authorization = {
      ...ctx.authorization, scope: 'until-native-validation',
      priorAuthorizationSha256: hash(json(ctx.authorization)),
      previousAttemptId: prepared.job.session_id, nextConfigSha256: hash(json(next))
    };
    if (condition === 'unlinked-grant') authorization.priorAuthorizationSha256 = 'f'.repeat(64);
    if (condition === 'missing-scope') delete authorization.scope;
    if (condition === 'valid') {
      await prepareAuthoringToolContinuation(ctx.nextConfig, ctx.nextLedger, id, next, ledger, authorization);
      assert.deepEqual(await claimAuthoringToolWorkspace(next, ledger, id), isolated);
      assert.equal(ctx.ledger.job(id).state, 'blocked');
      assert.equal(ctx.nextLedger.job(id).state, 'blocked');
    } else await assert.rejects(prepareAuthoringToolContinuation(ctx.nextConfig, ctx.nextLedger, id,
      next, ledger, authorization), /must follow the blocked/);
  });
}

test('tool recovery preserves read-only terminal receipts and claims one unchanged checkout', async t => {
  const ctx = await toolFixture(t), id = ctx.prepared.job.id;
  const before = ctx.ledger.job(id);
  const prepared = await prepareAuthoringToolContinuation(ctx.config, ctx.ledger, id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization);
  assert.equal(prepared.assignment.bounds.maxToolCalls, 180);
  assert.equal(prepared.assignment.id, id);
  assert.deepEqual(await claimAuthoringToolWorkspace(ctx.nextConfig, ctx.nextLedger, id), ctx.isolated);
  assert.deepEqual(ctx.ledger.job(id), before);
  assert.deepEqual(ctx.ledger.get('workerResult', ctx.result.id), ctx.result);
  await assert.rejects(claimAuthoringToolWorkspace(ctx.nextConfig, ctx.nextLedger, id), /already consumed/);
  await assert.rejects(prepareAuthoringToolContinuation(ctx.config, ctx.ledger, id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization), /already reserved/);
});

test('tool recovery verifies the previously consumed runtime workspace lineage', async t => {
  const ctx = await runtimeFixture(t), id = ctx.prepared.job.id;
  const runtime = await prepareRuntimeContinuation(ctx.config, ctx.ledger, id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization);
  const isolated = await claimRuntimeWorkspace(ctx.nextConfig, ctx.nextLedger, id);
  ctx.nextLedger.moveJob(id, 'prepared', 'running', isolated);
  ctx.nextLedger.moveJob(id, 'running', 'blocked');
  ctx.nextLedger.put(toolBlockedResult({
    ...structuredClone(ctx.result), id: 'read-only-tool-result',
    attemptId: runtime.job.session_id, reportedAt: now()
  }, runtime.assignment));
  const destination = { ...structuredClone(ctx.nextConfig), stateDirectory: join(ctx.root, 'tools') };
  const ledger = new Ledger(destination.stateDirectory);
  ctx.additionalLedgers.push(ledger);
  const authorization = { ...ctx.authorization, kind: 'bounded-authoring-tool',
    authorizedAt: now(), previousAttemptId: runtime.job.session_id,
    nextConfigSha256: hash(json(destination)) };
  await prepareAuthoringToolContinuation(ctx.nextConfig, ctx.nextLedger, id,
    destination, ledger, authorization);
  assert.deepEqual(await claimAuthoringToolWorkspace(destination, ledger, id), isolated);
});

for (const condition of ['authorization', 'old-authorization', 'attempt', 'controller', 'bounds',
  'source-permission', 'workspace', 'publication', 'claim-drift']) {
  test(`tool recovery refuses ${condition}`, async t => {
    const ctx = await toolFixture(t), id = ctx.prepared.job.id;
    if (condition === 'authorization') ctx.authorization.approved = false;
    if (condition === 'old-authorization') ctx.authorization.authorizedAt = '2000-01-01T00:00:00Z';
    if (condition === 'attempt') ctx.authorization.previousAttemptId = 'unrelated-attempt';
    if (condition === 'controller') ctx.authorization.controllerRevision = 'f'.repeat(40);
    if (condition === 'bounds') delete ctx.authorization.executionBounds;
    if (condition === 'source-permission') ctx.nextConfig.repositories[0].routingApproved = false;
    if (condition === 'workspace') writeFileSync(join(ctx.isolated.workspace, 'src', 'value.js'), 'bad');
    if (condition === 'publication') ctx.ledger.operation('unexpected-push', id, 'push', {});
    if (condition === 'claim-drift') {
      await prepareAuthoringToolContinuation(ctx.config, ctx.ledger, id,
        ctx.nextConfig, ctx.nextLedger, ctx.authorization);
      ctx.ledger.put({ ...ctx.result, id: 'unexpected-second-result' });
      await assert.rejects(claimAuthoringToolWorkspace(ctx.nextConfig, ctx.nextLedger, id),
        error => error.code === 'blocked-reconciliation');
    } else {
      await assert.rejects(prepareAuthoringToolContinuation(ctx.config, ctx.ledger, id,
        ctx.nextConfig, ctx.nextLedger, ctx.authorization),
      error => ['blocked-authorization', 'blocked-reconciliation'].includes(error.code));
      assert.equal(ctx.nextLedger.status().jobs.length, 0);
    }
    assert.equal(ctx.ledger.job(id).state, 'blocked');
  });
}

test('tool recovery cannot use ordinary dispatch or bypass synthetic source guards', async t => {
  const ctx = await toolFixture(t), id = ctx.prepared.job.id;
  await prepareAuthoringToolContinuation(ctx.config, ctx.ledger, id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization);
  ctx.nextConfig.activation.dispatch = true;
  await assert.rejects(dispatch(ctx.nextConfig, ctx.nextLedger, id),
    /tool continuation requires its explicit/);
  await assert.rejects(dispatchAuthoringToolContinuation(ctx.nextConfig, ctx.nextLedger, id),
    /Synthetic evidence cannot launch/);
});

test('runtime continuation reuses the unchanged task checkout once and preserves terminal receipts', async t => {
  const ctx = await runtimeFixture(t);
  const before = ctx.ledger.job(ctx.prepared.job.id);
  const continued = await prepareRuntimeContinuation(ctx.config, ctx.ledger, before.id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization);
  assert.deepEqual(ctx.ledger.job(before.id), before);
  assert.deepEqual(ctx.ledger.get('workerResult', ctx.result.id), ctx.result);
  assert.notEqual(continued.job.session_id, before.session_id);
  assert.deepEqual(continued.assignment, ctx.prepared.assignment);
  assert.deepEqual(ctx.nextLedger.get('evidence', ctx.prepared.evidence.id), ctx.prepared.evidence);
  assert.equal(ctx.nextLedger.all('workerResult').length, 0);
  const reused = await claimRuntimeWorkspace(ctx.nextConfig, ctx.nextLedger, before.id);
  assert.deepEqual(reused, ctx.isolated);
  assert.equal(ctx.nextLedger.status().operations[0].state, 'claimed');
  assert.equal(ctx.ledger.status().operations[0].state, 'claimed');
  assert.deepEqual(ctx.ledger.job(before.id), before);
  await assert.rejects(claimRuntimeWorkspace(ctx.nextConfig, ctx.nextLedger, before.id),
    /absent or already consumed/);
  await assert.rejects(prepareRuntimeContinuation(ctx.config, ctx.ledger, before.id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization), /Prior operations/);
});

for (const condition of ['missing-authorization', 'old-authorization', 'wrong-attempt',
  'wrong-controller', 'config-drift', 'launcher-drift', 'smoke-drift', 'model-started',
  'validation-started', 'remote-validation', 'publication-started', 'dirty-workspace',
  'source-drift', 'superseded-evidence', 'other-runtime-error', 'smoke-used-model',
  'binary-not-smoked']) {
  test(`runtime continuation refuses ${condition}`, async t => {
    const ctx = await runtimeFixture(t, result => {
      if (condition === 'model-started') result.toolUsage.used = 1;
      if (condition === 'validation-started') result.validationAttempts.push({
        round: 0, sourceRevision: result.sourceRevision, validation: [{
          gateId: 'fixture-test', sourceRevision: result.sourceRevision,
          commandOrRunUrl: 'synthetic command', status: 'blocked', artifactRefs: [],
          owner: 'fixture-owner', nextCheckAt: null, attemptCount: 1,
          blockedReason: 'runner-unavailable'
        }]
      });
      if (condition === 'remote-validation') result.remoteValidation.push({
        id: 'synthetic-build', provider: 'ado', definitionId: 1, buildId: 1,
        url: 'https://example.invalid/build/1', status: 'queued',
        sourceRevision: result.sourceRevision, sourceRef: 'refs/heads/synthetic',
        queuedAt: now(), blocking: false
      });
    }, condition === 'other-runtime-error'
      ? { code: 'blocked-runtime', message: 'Unrelated runtime error' } : undefined);
    if (condition === 'missing-authorization') ctx.authorization.approved = false;
    if (condition === 'old-authorization') ctx.authorization.authorizedAt = '2000-01-01T00:00:00Z';
    if (condition === 'wrong-attempt') ctx.authorization.previousAttemptId = 'wrong-attempt';
    if (condition === 'wrong-controller') ctx.authorization.controllerRevision = 'f'.repeat(40);
    if (condition === 'config-drift') ctx.nextConfig.limits.workerMaxToolCalls++;
    if (condition === 'launcher-drift') ctx.authorization.cliSha256 = 'f'.repeat(64);
    if (condition === 'smoke-drift') writeFileSync(ctx.authorization.runtimeSmoke.path, '{}');
    if (['smoke-used-model', 'binary-not-smoked'].includes(condition)) {
      const proof = JSON.parse(readFileSync(ctx.authorization.runtimeSmoke.path));
      if (condition === 'smoke-used-model') proof.modelInvoked = true;
      else proof.cliSha256 = 'f'.repeat(64);
      writeFileSync(ctx.authorization.runtimeSmoke.path, json(proof));
      ctx.authorization.runtimeSmoke.sha256 = hash(readFileSync(ctx.authorization.runtimeSmoke.path));
    }
    if (condition === 'publication-started')
      ctx.ledger.operation('synthetic-push', ctx.prepared.job.id, 'push', {});
    if (condition === 'dirty-workspace')
      writeFileSync(join(ctx.isolated.workspace, 'src', 'value.js'), 'modified\n');
    if (condition === 'source-drift')
      await command('git', ['-c', 'core.hooksPath=', '-c', 'user.name=Fixture',
        '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty',
        '--quiet', '-m', 'Advance fixture source'], ctx.config.repositories[0].referenceCheckout);
    if (condition === 'superseded-evidence') {
      const evidence = structuredClone(ctx.prepared.evidence);
      evidence.source.revision = 'superseded-fixture';
      evidence.queriedAt = '2099-01-01T00:00:00Z';
      ctx.ledger.evidence(evidence, { changed: true }, 'changed-fixture');
    }
    await assert.rejects(prepareRuntimeContinuation(ctx.config, ctx.ledger, ctx.prepared.job.id,
      ctx.nextConfig, ctx.nextLedger, ctx.authorization),
    error => ['blocked-authorization', 'blocked-reconciliation', 'invalid-record'].includes(error.code));
    assert.equal(ctx.ledger.job(ctx.prepared.job.id).state, 'blocked');
    assert.equal(ctx.nextLedger.status().jobs.length, 0);
  });
}

for (const condition of ['config', 'smoke', 'workspace', 'predecessor-result', 'prior-operation']) {
  test(`runtime claim rechecks ${condition} after preparation`, async t => {
    const ctx = await runtimeFixture(t);
    await prepareRuntimeContinuation(ctx.config, ctx.ledger, ctx.prepared.job.id,
      ctx.nextConfig, ctx.nextLedger, ctx.authorization);
    if (condition === 'config') ctx.nextConfig.runtime.timeoutMs++;
    if (condition === 'smoke') writeFileSync(ctx.authorization.runtimeSmoke.path, '{}');
    if (condition === 'workspace')
      writeFileSync(join(ctx.isolated.workspace, 'src', 'value.js'), 'modified\n');
    if (condition === 'predecessor-result')
      ctx.ledger.put({ ...ctx.result, id: 'unexpected-second-result' });
    if (condition === 'prior-operation')
      ctx.ledger.operation('unexpected-push', ctx.prepared.job.id, 'push', {});
    await assert.rejects(claimRuntimeWorkspace(ctx.nextConfig, ctx.nextLedger, ctx.prepared.job.id),
      error => error.code === 'blocked-reconciliation');
    assert.equal(ctx.nextLedger.status().operations[0].state, 'prepared');
  });
}

test('runtime continuation cannot use ordinary dispatch or bypass synthetic-evidence protection', async t => {
  const ctx = await runtimeFixture(t);
  await prepareRuntimeContinuation(ctx.config, ctx.ledger, ctx.prepared.job.id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization);
  ctx.nextConfig.activation.dispatch = true;
  await assert.rejects(dispatch(ctx.nextConfig, ctx.nextLedger, ctx.prepared.job.id),
    /runtime continuation requires its explicit/);
  await assert.rejects(dispatchRuntimeContinuation(ctx.nextConfig, ctx.nextLedger, ctx.prepared.job.id),
    /Synthetic evidence cannot launch/);
  assert.equal(ctx.nextLedger.status().operations[0].state, 'prepared');
});

test('authorized pre-model continuation preserves the blocked attempt and reserves exactly one fresh preparation', async t => {
  const ctx = await blockedPreModelFixture(t);
  const priorJob = ctx.ledger.job(ctx.prepared.job.id);
  const priorResult = ctx.ledger.get('workerResult', ctx.result.id);
  const continued = await prepareLocalPreModelContinuation(ctx.config, ctx.ledger, priorJob.id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization);
  assert.equal(continued.job.state, 'prepared');
  assert.notEqual(continued.job.session_id, priorJob.session_id);
  assert.equal(continued.job.workspace, null);
  assert.deepEqual(ctx.ledger.job(priorJob.id), priorJob);
  assert.deepEqual(ctx.ledger.get('workerResult', ctx.result.id), priorResult);
  assert.deepEqual(continued.assignment, ctx.prepared.assignment);
  assert.deepEqual(ctx.nextLedger.get('evidence', ctx.prepared.evidence.id), ctx.prepared.evidence);
  assert.equal(ctx.nextLedger.all('workerResult').length, 0);
  assert.equal(ctx.ledger.status().operations[0].state, 'prepared');
  await assert.rejects(prepareLocalPreModelContinuation(ctx.config, ctx.ledger, priorJob.id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization), /Prior operations/);
});

test('pre-model continuation permits only an explicitly pinned runtime credit-ceiling correction', async t => {
  const ctx = await blockedPreModelFixture(t);
  ctx.nextConfig.limits.maxAiCreditsPerSession = 30;
  ctx.authorization.nextConfigSha256 = hash(json(ctx.nextConfig));
  await assert.rejects(prepareLocalPreModelContinuation(ctx.config, ctx.ledger, ctx.prepared.job.id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization), /credit-ceiling change requires explicit authorization/);
  assert.equal(ctx.ledger.status().operations.length, 0);
  ctx.authorization.runtimeBudgetChange = { previousCeiling: 10, newCeiling: 30 };
  const continued = await prepareLocalPreModelContinuation(ctx.config, ctx.ledger, ctx.prepared.job.id,
    ctx.nextConfig, ctx.nextLedger, ctx.authorization);
  assert.deepEqual(continued.audit.authorization.runtimeBudgetChange,
    { previousCeiling: 10, newCeiling: 30 });
  assert.equal(ctx.config.limits.maxAiCreditsPerSession, 10);
  assert.equal(continued.job.state, 'prepared');
});

for (const condition of ['missing-authorization', 'wrong-attempt', 'config-drift',
  'wrong-controller', 'model-started', 'validation-started', 'publication-started', 'dirty-workspace',
  'source-drift', 'superseded-evidence']) {
  test(`pre-model continuation refuses ${condition}`, async t => {
    const ctx = await blockedPreModelFixture(t, result => {
      if (condition === 'model-started')
        result.toolUsage.rounds.push({ round: 0, used: 0, cumulativeUsed: 0, status: 'failed' });
      if (condition === 'validation-started') result.sourceRevision = 'a'.repeat(40);
    });
    if (condition === 'missing-authorization') ctx.authorization.approved = false;
    if (condition === 'wrong-attempt') ctx.authorization.previousAttemptId = 'wrong-attempt';
    if (condition === 'wrong-controller') ctx.authorization.controllerRevision = 'd'.repeat(40);
    if (condition === 'config-drift') ctx.nextConfig.limits.workerMaxToolCalls++;
    if (condition === 'publication-started')
      ctx.ledger.operation('uncertain-push', ctx.prepared.job.id, 'push', {});
    if (condition === 'dirty-workspace')
      writeFileSync(join(ctx.isolated.workspace, 'src', 'value.js'), 'modified\n');
    if (condition === 'source-drift')
      await command('git', ['-c', 'core.hooksPath=.git/no-hooks', '-c', 'user.name=Fixture',
        '-c', 'user.email=fixture@example.invalid', 'commit', '--allow-empty',
        '--quiet', '-m', 'Advance fixture source'], ctx.config.repositories[0].referenceCheckout);
    if (condition === 'superseded-evidence') {
      const evidence = structuredClone(ctx.prepared.evidence);
      evidence.source.revision = 'new-fixture-version';
      evidence.queriedAt = '2099-01-01T00:00:00Z';
      ctx.ledger.evidence(evidence, { changed: true }, 'changed-fixture');
    }
    await assert.rejects(prepareLocalPreModelContinuation(ctx.config, ctx.ledger, ctx.prepared.job.id,
      ctx.nextConfig, ctx.nextLedger, ctx.authorization),
    error => ['blocked-authorization', 'blocked-reconciliation'].includes(error.code));
    assert.equal(ctx.ledger.job(ctx.prepared.job.id).state, 'blocked');
    assert.equal(ctx.nextLedger.status().jobs.length, 0);
  });
}

test('reviewed handoff fixture prepares real planning and assignment records', async t => {
  const { config, ledger, baseRevision } = await setup(t);
  const prepared = prepareReviewedHandoff(config, ledger, fixture);
  assert.equal(prepared.evidence.source.kind, 'fixture');
  assert.equal(prepared.evidence.source.provenance, 'synthetic');
  assert.equal(prepared.investigation.handoffEligibility, 'eligible');
  assert.equal(prepared.testCoveragePlan.sourceRevision, baseRevision);
  assert.equal(prepared.assignment.skillBindingId, 'oa-integration-test-core');
  assert.equal(prepared.assignment.authoringProvider, undefined);
  assert.equal(prepared.assignment.id, `assignment-${hash(JSON.stringify([
    prepared.investigation.id, prepared.investigation.version, 'office-agent', 'improvement',
    prepared.assignment.testCoveragePlanId, prepared.assignment.testCoveragePlanVersion,
    prepared.assignment.requestedOutcome, prepared.assignment.skillBindingId,
    prepared.assignment.skillInput,
    prepared.assignment.allowedWritePrefixes,
    prepared.assignment.allowedWriteFiles,
    prepared.assignment.skillQualification
  ]))}`);
  assert.match(prepared.assignment.questions[0],
    /contracts\/apps\/onenote\/omni-onenote-bootstrap-progress\.contract\.test\.ts/);
  assert.equal(prepared.job.state, 'prepared');
});

test('reviewed handoff preserves validated declarative E2E mini-spec input through assignment', async t => {
  validateReviewedHandoffReceipt(oneJsFixture);
  const { config, ledger } = await setup(t, {
    inputFormat: 'declarative-e2e-mini-spec-batch-v1'
  });
  const mapped = structuredClone(oneJsFixture);
  mapped.review.repoIds = ['office-agent'];
  mapped.planning.improvement.repoIds = ['office-agent'];
  mapped.planning.improvement.capabilities = ['integration-test-authoring'];
  mapped.planning.testCoverage.repoId = 'office-agent';
  mapped.planning.testCoverage.capability = 'integration-test-authoring';
  mapped.planning.requestedOutcome = 'add-or-update-tests';
  const prepared = prepareReviewedHandoff(config, ledger, mapped);
  assert.deepEqual(prepared.testCoveragePlan.skillInput, mapped.planning.skillInput);
  assert.deepEqual(prepared.assignment.skillInput, mapped.planning.skillInput);
  assert.notStrictEqual(prepared.assignment.skillInput, mapped.planning.skillInput);
});

test('reviewed handoff preserves a dual-suite declarative E2E batch', async t => {
  validateReviewedHandoffReceipt(oneJsDualSuiteFixture);
  const { config, ledger } = await setup(t, {
    inputFormat: 'declarative-e2e-mini-spec-batch-v1'
  });
  const mapped = structuredClone(oneJsDualSuiteFixture);
  mapped.review.repoIds = ['office-agent'];
  mapped.planning.improvement.repoIds = ['office-agent'];
  mapped.planning.improvement.capabilities = ['integration-test-authoring'];
  mapped.planning.testCoverage.repoId = 'office-agent';
  mapped.planning.testCoverage.capability = 'integration-test-authoring';
  mapped.planning.requestedOutcome = 'add-or-update-tests';
  const prepared = prepareReviewedHandoff(config, ledger, mapped);
  assert.equal(prepared.assignment.skillInput.items.length, 2);
  assert.deepEqual(
    prepared.assignment.skillInput.items.map(item => item.inputItemId),
    [
      'bizchat-create-canary-excel',
      'excel-agent-omni-write-four-by-three-grid'
    ]
  );
  assert.deepEqual(prepared.assignment.skillInput, mapped.planning.skillInput);
  assert.notStrictEqual(prepared.assignment.skillInput, mapped.planning.skillInput);
});

test('reviewed handoff production API is the only controller path', async t => {
  const { config, ledger } = await setup(t);
  assert.equal(typeof prepareReviewedHandoff, 'function');
  assert.equal(typeof acceptReviewedHandoff, 'function');
  const prepared = prepareReviewedHandoff(config, ledger, fixture);
  assert.equal(prepared.receipt.id, fixture.id);
});

test('submit-reviewed-handoff CLI uses the production controller path', async t => {
  const { root, config } = await setup(t);
  const configPath = join(root, 'pilot.json');
  const fixturePath = join(root, 'reviewed-handoff.json');
  writeFileSync(configPath, JSON.stringify(config));
  writeFileSync(fixturePath, JSON.stringify(fixture));
  const output = spawnSync(process.execPath, [
    'src\\cli.js', 'submit-reviewed-handoff',
    '--file', fixturePath, '--config', configPath, '--prepare'
  ], { encoding: 'utf8' });
  assert.equal(output.status, 0, output.stderr);
  const result = JSON.parse(output.stdout);
  assert.equal(result.receipt.id, fixture.id);
  assert.equal(result.job.state, 'prepared');
});

test('the same reviewed handoff receipt is idempotent', async t => {
  const { config, ledger } = await setup(t);
  const first = prepareReviewedHandoff(config, ledger, fixture);
  const second = prepareReviewedHandoff(config, ledger, fixture);
  assert.equal(second.evidence.id, first.evidence.id);
  assert.equal(second.investigation.id, first.investigation.id);
  assert.equal(second.assignment.id, first.assignment.id);
  assert.equal(second.job.id, first.job.id);
  assert.equal(ledger.all('evidence').length, 1);
  assert.equal(ledger.all('investigation').length, 1);
  assert.equal(ledger.all('assignment').length, 1);
});

test('stale or conflicting reviewed handoff versions fail closed', async t => {
  const { config, ledger } = await setup(t);
  prepareReviewedHandoff(config, ledger, fixture);
  const stale = structuredClone(fixture);
  stale.version--;
  stale.source.revision = String(stale.version);
  await assert.rejects(async () => prepareReviewedHandoff(config, ledger, stale),
    /advance exactly once|superseded/);
  const before = {
    counts: ledger.status().counts,
    jobs: ledger.status().jobs,
    operations: ledger.status().operations
  };
  const conflicting = structuredClone(fixture);
  conflicting.evidence.summary = 'Conflicting evidence payload';
  conflicting.review.nextAction = 'Conflicting replay';
  await assert.rejects(async () => prepareReviewedHandoff(config, ledger, conflicting),
    /conflicts with persisted content/);
  assert.deepEqual(ledger.status().counts, before.counts);
  assert.deepEqual(ledger.status().jobs, before.jobs);
  assert.deepEqual(ledger.status().operations, before.operations);
  assert.equal(ledger.all('evidence').length, 1);
});

test('reviewed handoff requires the complete exclusion checklist', () => {
  const invalid = structuredClone(fixture);
  invalid.review.exclusionsChecked.pop();
  assert.throws(() => validateReviewedHandoffReceipt(invalid), /reviewedHandoff|exclusion/);
});

test('invalid fixture provenance is rejected before ledger materialization', async t => {
  const { config, ledger } = await setup(t);
  const invalid = structuredClone(fixture);
  invalid.source.namespace = 'icm/incidents';
  await assert.rejects(async () => prepareReviewedHandoff(config, ledger, invalid),
    /reviewedHandoff|source reference/);
  assert.equal(ledger.latestEvidence().length, 0);
  assert.equal(ledger.all('investigation').length, 0);
});

test('ordinary dispatch still rejects reviewed synthetic fixture evidence', async t => {
  const { config, ledger } = await setup(t);
  const prepared = prepareReviewedHandoff(config, ledger, fixture);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  await assert.rejects(dispatch(config, ledger, prepared.assignment.id), /Synthetic evidence/);
  assert.equal(ledger.job(prepared.assignment.id).state, 'prepared');
});

test('execution authorization is required before reviewed fixture state is persisted', async t => {
  const { config, ledger } = await setup(t);
  const authorizations = {
    authorizeSynthetic: '--authorize-synthetic',
    authorizeCommit: '--authorize-commit',
    authorizePush: '--authorize-push',
    authorizeDraftPR: '--authorize-draft-pr'
  };
  for (const [missing, expected] of Object.entries(authorizations)) {
    const options = {
      execute: true,
      authorizeSynthetic: true,
      authorizeCommit: true,
      authorizePush: true,
      authorizeDraftPR: true,
      [missing]: false
    };
    await assert.rejects(acceptReviewedHandoff(config, ledger, fixture, options),
      new RegExp(expected));
    assert.equal(ledger.latestEvidence().length, 0);
  }
});

test('repository binding must authorize commit push and Draft PR independently', async t => {
  for (const sideEffect of ['commit', 'push', 'createDraftPR']) {
    const { config, ledger } = await setup(t);
    config.repositories[0].skillBindings[0].sideEffects[sideEffect] = false;
    await assert.rejects(acceptReviewedHandoff(config, ledger, fixture, {
      execute: true,
      authorizeSynthetic: true,
      authorizeCommit: true,
      authorizePush: true,
      authorizeDraftPR: true
    }), /not authorized for commit, push and Draft PR/);
    assert.equal(ledger.latestEvidence().length, 0);
  }
});

test('production reviewed-handoff controller is repository and scenario neutral', () => {
  const source = readFileSync(new URL('../src/reviewed-handoff.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /office-agent|oa-integration|onenote/i);
});

for (const automaticRsi of [false, true]) test(
  `authorized reviewed handoff reuses real dispatch with external boundaries injected${automaticRsi ? ' and automatic RSI' : ''}`, async t => {
  const { root, remote, config, ledger } = await setup(t);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  config.rsi = structuredClone(rsiPolicy);
  let rsiLaunches = 0;
  if (automaticRsi) {
    const reference = join(root, 'rsi-reference');
    mkdirSync(reference);
    writeFileSync(join(reference, 'README.txt'), 'Separate synthetic agent-system reference.\n');
    const git = args => command('git', ['-c', 'core.hooksPath=.git/no-hooks',
      '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
      '-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid', ...args], reference);
    await git(['init', '-b', 'main', '--quiet']);
    await git(['remote', 'add', 'origin', `https://github.com/${config.rsi.targetRepository}.git`]);
    await git(['add', '.']); await git(['commit', '--quiet', '-m', 'Synthetic RSI reference']);
    const driverPath = join(root, 'rsi-driver.mjs');
    const driver = "export function runFlow() { throw new Error('No-change must not evaluate'); }\n";
    writeFileSync(driverPath, driver);
    config.authoringProviders ??= {};
    config.authoringProviders['rsi-fixture'] = { type: 'agency-local', executable: process.execPath, profile: 'fixture' };
    config.rsi.automation = {
      authoringApproved: true, localCommitApproved: true, authoringProvider: 'rsi-fixture',
      referenceCheckout: reference, baselineRevision: (await git(['rev-parse', 'HEAD'])).stdout.trim(),
      targetBranch: 'main', gitAuthor: { name: 'Fixture', email: 'fixture@example.invalid' },
      timeoutMs: 60000, maxToolCalls: 4, maxFileBytes: 65536, maxWorkspaceBytes: 8388608, maxAiCredits: 30,
      evaluation: { driverPath, driverSha256: hash(driver), dependencies: [], timeoutMs: 2000,
        cases: ['recovery', 'healthy', 'guard'].map(population => ({
          id: population, population, assertions: ['intended-work']
        })) }
    };
  }
  await command('git', ['init', '--bare', '--quiet', remote], root);
  const executed = await acceptReviewedHandoff(config, ledger, fixture, {
    execute: true,
    authorizeSynthetic: true,
    authorizeCommit: true,
    authorizePush: true,
    authorizeDraftPR: true,
    dispatchDependencies: {
      rsi: automaticRsi ? {
        launch: async (_executable, _args, options) => {
          rsiLaunches++;
          assert.match(options.prompt, /draft-pr-validated/);
          const call = (tool, args) => new Promise((resolve, reject) => {
            const socket = connect(options.env.PILOT_MCP_ENDPOINT);
            let output = '';
            socket.setEncoding('utf8');
            socket.on('connect', () => socket.write(JSON.stringify({
              id: 'native-rsi-fixture', token: options.env.PILOT_MCP_TOKEN, tool, args
            }) + '\n'));
            socket.on('data', chunk => { output += chunk; });
            socket.on('error', reject);
            socket.on('close', () => {
              try {
                const result = JSON.parse(output);
                assert.equal(result.ok, true, output);
                resolve(result.result);
              } catch (error) { reject(error); }
            });
          });
          const trace = await call('pilot_read', { path: 'rsi-artifacts/0' });
          assert.equal(typeof trace, 'string');
          assert.equal(await call('pilot_read', { path: 'rsi-artifacts/0', startLine: 1, endLine: 1 }),
            trace.split(/\r?\n/)[0]);
          await call('pilot_finish', {
            outcome: 'not-actionable',
            findings: 'The captured native synthetic flow completed; no agent-system deficit is demonstrated.'
          });
          return { stdout: '', stderr: '' };
        }
      } : undefined,
      runModel: async (currentConfig, currentLedger, current, assignment, investigation, toolkit, skill) => {
        assert.equal(investigation.review.reviewer, 'synthetic-reviewed-handoff-fixture');
        assert.equal(assignment.skillBindingId, 'oa-integration-test-core');
        assert.match(skill.instructions, /Fixture integration-test skill/);
        toolkit.write('test\\behavior.test.js',
          "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fixture behavior', () => assert.equal(1, 1));\n");
        toolkit.write('test\\behavior-card.md', '# Fixture behavior\n');
        toolkit.finish({
          outcome: 'propose-change',
          findings: 'Added focused fixture coverage through the real reviewed-handoff controller.',
          title: 'Add fixture behavior coverage',
          description: 'Authorized synthetic reviewed-handoff draft.',
          skillResult: {
            status: 'succeeded',
            classification: 'missing-test-coverage',
            changedFiles: ['test/behavior-card.md', 'test/behavior.test.js'],
            testsAddedOrUpdated: ['fixture behavior'],
            behaviorCardsAddedOrUpdated: ['test/behavior-card.md'],
            unknowns: [],
            needsHumanDecision: false
          }
        });
      },
      createDraft: async (currentConfig, currentLedger, current, repo, revision) => ({
        url: 'https://example.invalid/reviewed-handoff/draft/1',
        isDraft: true,
        headRevision: revision
      })
    }
  });
  assert.equal(executed.result.outcome, 'draft-pr-validated');
  assert.equal(executed.result.skillExecution.bindingId, 'oa-integration-test-core');
  assert.equal(executed.result.validation[0].sourceRevision, executed.result.sourceRevision);
  assert.equal(executed.result.draftPR.headRevision, executed.result.sourceRevision);
  assert.equal(executed.result.toolUsage.used, 3);
  assert.equal(executed.result.toolUsage.byTool.pilot_write, 2);
  assert.equal(executed.result.toolUsage.byTool.pilot_finish, 1);
  assert.equal(executed.rsi.state, 'delivered', JSON.stringify(executed.rsi));
  const delivery = executed.rsi.handoffs[0];
  const inspected = rsiWork(config, ledger, 'inspect', { observationId: delivery.observationId });
  assert.deepEqual(inspected.observation.payload.data.workerResult, ledger.get('workerResult', executed.result.id));
  assert.equal(inspected.binding.upstream.kind, 'reviewed-handoff');
  assert.equal(inspected.observation.payload.data.artifacts.state, 'referenced');
  assert.ok(inspected.observation.payload.data.artifacts.files.length > 0);
  assert.ok(inspected.observation.payload.data.artifacts.files.every(entry => !Object.hasOwn(entry, 'contentBase64')));
  assert.equal(inspected.rawArtifacts.state, 'available');
  assert.equal(hash(readRsiArtifact(config, inspected.observation, 0)),
    inspected.observation.payload.data.artifacts.files[0].sha256);
  assert.equal(inspected.observation.payload.data.workerResult.validation[0].status, 'passed');
  assert.equal(inspected.observation.payload.data.evidence[0].source.provenance, 'synthetic');
  assert.deepEqual(captureWorkerRsiOutcome(config, ledger, executed.result.id), delivery);
  const claim = { observationId: delivery.observationId, claimId: 'native-outcome-review', executorId: 'fixture-host' };
  let finished;
  if (automaticRsi) {
    assert.equal(rsiLaunches, 1);
    assert.equal(executed.rsi.execution.state, 'finished', JSON.stringify(executed.rsi));
    assert.equal(delivery.nextRole, null);
    finished = ledger.latest('rsiWorkItem')[0];
  } else {
    rsiWork(config, ledger, 'claim', claim);
    finished = rsiWork(config, ledger, 'result', {
      ...claim, outcome: 'no-change', rationale: 'This synthetic flow completed; it does not demonstrate an agent-system defect.'
    });
  }
  assert.equal(finished.state, 'finished');
  assert.equal(ledger.all('rsiFlowObservation').length, 1);
  assert.equal(ledger.latest('rsiWorkItem').length, 1);
  const original = json(inspected.observation);
  const afterRetention = Date.parse(inspected.observation.payload.data.artifacts.expiresAt) + 1000;
  assert.equal(inspectRsiArtifacts(config, inspected.observation, afterRetention).state, 'expired');
  pruneState(config, { nowMs: afterRetention });
  assert.equal(rsiWork(config, ledger, 'inspect', { observationId: delivery.observationId }).rawArtifacts.state, 'unavailable');
  assert.throws(() => readRsiArtifact(config, inspected.observation, 0), /unavailable/);
  assert.deepEqual(captureWorkerRsiOutcome(config, ledger, executed.result.id), {
    ...delivery, state: 'finished', taskVersion: finished.version, nextRole: null
  });
  assert.equal(json(ledger.get('rsiFlowObservation', delivery.observationId)), original);
});

test('authorized 1JS handoff runs the controller end to end and links one non-blocking build', async t => {
  const ctx = await setup(t);
  const oneJs = await addOneJsRepository(ctx, { enableDraftBuild: true });
  ctx.config.activation.dispatch = true;
  ctx.config.limits.maxAiCreditsPerSession = 1;
  await command('git', ['init', '--bare', '--quiet', oneJs.remote], ctx.root);
  let buildQueueCalls = 0;
  let draftDescription = '';
  const executed = await acceptReviewedHandoff(ctx.config, ctx.ledger, oneJsFixture, {
    execute: true,
    authorizeSynthetic: true,
    authorizeCommit: true,
    authorizePush: true,
    authorizeDraftPR: true,
    dispatchDependencies: {
      runModel: async (currentConfig, currentLedger, current, assignment, investigation,
        toolkit, skill) => {
        assert.equal(assignment.repoId, '1js');
        assert.equal(assignment.skillBindingId, '1js-declarative-e2e-authoring');
        assert.equal(assignment.skillInput.items[0].inputItemId, 'bizchat-create-canary-excel');
        assert.match(skill.instructions, /Fixture declarative E2E skill/);
        toolkit.write(
          oneJs.scenarioPath.replaceAll('/', '\\'),
          'name: BizChat creates Canary workbook\ncontract: 4x3\nsheet: Canary\n'
        );
        toolkit.finish({
          outcome: 'propose-change',
          findings: 'Added the reviewed declarative E2E scenario.',
          title: 'Add BizChat Canary workbook E2E',
          description: 'Authorized synthetic 1JS Draft PR.',
          skillResult: {
            status: 'succeeded',
            classification: 'missing-test-coverage',
            changedFiles: [oneJs.scenarioPath],
            testsAddedOrUpdated: ['bizchat-create-canary-excel'],
            behaviorCardsAddedOrUpdated: [],
            unknowns: [],
            needsHumanDecision: false
          }
        });
      },
      queueDraftBuild: async (currentConfig, currentLedger, current, repo, revision) => {
        return queueAdoDraftBuild(currentConfig, currentLedger, current, repo, revision, async body => {
          buildQueueCalls++;
          assert.deepEqual(JSON.parse(body.templateParameters.newCaseSelection), {
            format: '1js-new-case-selection-v1',
            baseRevision: oneJs.baseRevision,
            sourceRevision: revision,
            scenarioPaths: [oneJs.scenarioPath]
          });
          assert.equal(body.templateParameters.newCaseGroups, 'crossOfficeCowork');
          return {
            id: 57329999,
            _links: { web: { href: 'https://office.visualstudio.com/Office/_build/results?buildId=57329999' } }
          };
        });
      },
      createDraft: async (currentConfig, currentLedger, current, repo, revision, proposal) => {
        draftDescription = proposal.description;
        return {
          url: 'https://example.invalid/1js/draft/1',
          isDraft: true,
          headRevision: revision
        };
      }
    }
  });
  assert.equal(buildQueueCalls, 1);
  assert.equal(executed.result.outcome, 'draft-pr-validated');
  assert.equal(executed.result.remoteValidation.length, 1);
  assert.equal(executed.result.remoteValidation[0].status, 'queued');
  assert.equal(executed.result.remoteValidation[0].blocking, false);
  assert.equal(executed.result.remoteValidation[0].sourceRevision, executed.result.sourceRevision);
  assert.deepEqual(executed.result.remoteValidation[0].caseSelection.scenarioPaths, [oneJs.scenarioPath]);
  assert.match(draftDescription, /Remote validation/);
  assert.match(draftDescription, /buildId=57329999/);
  assert.match(draftDescription, /does not wait for completion/);
  assert.match(draftDescription, /new cases only/);
  assert.ok(draftDescription.includes(oneJs.scenarioPath));
});

test('1JS publication blocks before push when the authored diff has no added cases', async t => {
  const ctx = await setup(t);
  const oneJs = await addOneJsRepository(ctx, { enableDraftBuild: true });
  ctx.config.activation.dispatch = true;
  ctx.config.limits.maxAiCreditsPerSession = 1;
  let pushed = false;
  let queued = false;
  let drafted = false;
  await assert.rejects(acceptReviewedHandoff(ctx.config, ctx.ledger, oneJsFixture, {
    execute: true,
    authorizeSynthetic: true,
    authorizeCommit: true,
    authorizePush: true,
    authorizeDraftPR: true,
    dispatchDependencies: {
      runModel: async (currentConfig, currentLedger, current, assignment, investigation, toolkit) => {
        const path = 'ooui/apps/cross-office-client-e2e/scenarios/existing.yaml';
        toolkit.write(path, 'name: Existing scenario updated\n');
        toolkit.finish({
          outcome: 'propose-change',
          findings: 'Updated existing coverage only.',
          title: 'Update existing coverage',
          description: 'No new scenario.',
          skillResult: {
            status: 'succeeded',
            classification: 'missing-test-coverage',
            changedFiles: [path],
            testsAddedOrUpdated: ['existing'],
            behaviorCardsAddedOrUpdated: [],
            unknowns: [],
            needsHumanDecision: false
          }
        });
      },
      runValidation: async (currentConfig, currentLedger, current, repo, revision) => [{
        gateId: 'fixture-1js-local-five',
        sourceRevision: revision,
        commandOrRunUrl: 'fixture-local-validation',
        status: 'passed',
        artifactRefs: ['fixture-validation.json'],
        owner: repo.owner,
        nextCheckAt: null,
        attemptCount: 1,
        blockedReason: null
      }],
      pushBranch: async () => { pushed = true; },
      queueDraftBuild: async () => { queued = true; },
      createDraft: async () => { drafted = true; }
    }
  }), /no full-suite fallback/);
  assert.equal(pushed, false);
  assert.equal(queued, false);
  assert.equal(drafted, false);
});

test('OA and 1JS bundle executes as two isolated assignments in one controller ledger', async t => {
  assert.equal(dualSkillBundle.format, 'reviewed-handoff-bundle-v1');
  const ctx = await setup(t);
  const oneJs = await addOneJsRepository(ctx);
  ctx.config.activation.dispatch = true;
  ctx.config.limits.maxAiCreditsPerSession = 1;
  await command('git', ['init', '--bare', '--quiet', ctx.remote], ctx.root);
  await command('git', ['init', '--bare', '--quiet', oneJs.remote], ctx.root);
  const fixtures = Object.fromEntries([
    ['onenote-bootstrap-progress.reviewed-handoff.json', fixture],
    ['1js-bizchat-excel.reviewed-handoff.json', oneJsFixture]
  ]);
  const results = [];
  for (const receiptFile of dualSkillBundle.receiptFiles) {
    const receipt = fixtures[receiptFile];
    assert.ok(receipt, `Unknown bundle receipt ${receiptFile}`);
    results.push(await acceptReviewedHandoff(ctx.config, ctx.ledger, receipt, {
      execute: true,
      authorizeSynthetic: true,
      authorizeCommit: true,
      authorizePush: true,
      authorizeDraftPR: true,
      dispatchDependencies: {
        runModel: async (currentConfig, currentLedger, current, assignment,
          investigation, toolkit) => {
          if (assignment.repoId === '1js') {
            toolkit.write(
              'ooui\\apps\\cross-office-client-e2e\\scenarios\\bizchat-create-canary-excel.yaml',
              'name: BizChat creates Canary workbook\ncontract: 4x3\nsheet: Canary\n'
            );
            toolkit.finish({
              outcome: 'propose-change',
              findings: 'Added isolated 1JS fixture coverage.',
              title: 'Add isolated 1JS coverage',
              description: '1JS bundle Draft.',
              skillResult: {
                status: 'succeeded',
                classification: 'missing-test-coverage',
                changedFiles: [
                  'ooui/apps/cross-office-client-e2e/scenarios/bizchat-create-canary-excel.yaml'
                ],
                testsAddedOrUpdated: ['bizchat-create-canary-excel'],
                behaviorCardsAddedOrUpdated: [],
                unknowns: [],
                needsHumanDecision: false
              }
            });
            return;
          }
          toolkit.write('test\\behavior.test.js',
            "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fixture behavior', () => assert.equal(1, 1));\n");
          toolkit.write('test\\behavior-card.md', '# Fixture behavior\n');
          toolkit.finish({
            outcome: 'propose-change',
            findings: 'Added isolated OA fixture coverage.',
            title: 'Add isolated OA coverage',
            description: 'OA bundle Draft.',
            skillResult: {
              status: 'succeeded',
              classification: 'missing-test-coverage',
              changedFiles: ['test/behavior-card.md', 'test/behavior.test.js'],
              testsAddedOrUpdated: ['fixture behavior'],
              behaviorCardsAddedOrUpdated: ['test/behavior-card.md'],
              unknowns: [],
              needsHumanDecision: false
            }
          });
        },
        createDraft: async (currentConfig, currentLedger, current, repo, revision) => ({
          url: `https://example.invalid/${repo.id}/draft/1`,
          isDraft: true,
          headRevision: revision
        })
      }
    }));
  }
  assert.deepEqual(results.map(item => item.result.skillExecution.bindingId).sort(), [
    '1js-declarative-e2e-authoring',
    'oa-integration-test-core'
  ]);
  assert.equal(new Set(results.map(item => item.result.assignmentId)).size, 2);
  assert.equal(new Set(ctx.ledger.status().jobs.map(job => job.workspace)).size, 2);
  assert.ok(results.every(item => item.result.outcome === 'draft-pr-validated'));
  assert.equal(ctx.ledger.all('workerResult').length, 2);
});

test('controller validation failures feed a bounded repository-skill repair loop', async t => {
  const { root, remote, config, ledger } = await setup(t);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  config.limits.maxValidationRepairRounds = 2;
  config.rsi = structuredClone(rsiPolicy);
  await command('git', ['init', '--bare', '--quiet', remote], root);
  let modelCalls = 0;
  const executed = await acceptReviewedHandoff(config, ledger, fixture, {
    execute: true,
    authorizeSynthetic: true,
    authorizeCommit: true,
    authorizePush: true,
    authorizeDraftPR: true,
    dispatchDependencies: {
      runModel: async (currentConfig, currentLedger, current, assignment, investigation,
        toolkit, skill, authoring) => {
        modelCalls++;
        assert.equal(authoring.round, modelCalls - 1);
        const round = repairDrill.rounds[authoring.round];
        assert.ok(round);
        if (round.expectedFeedbackStatus === null) assert.deepEqual(authoring.validationFeedback, []);
        else {
          assert.equal(authoring.validationFeedback[0].status, round.expectedFeedbackStatus);
          assert.equal(authoring.validationFeedback[0].exitCode, 1);
        }
        for (const [path, content] of Object.entries(round.writes))
          toolkit.write(path.replaceAll('/', '\\'), content);
        toolkit.finish({
          outcome: 'propose-change',
          findings: round.findings,
          title: round.title,
          description: 'Authorized synthetic reviewed-handoff draft.',
          skillResult: repairDrill.skillResult
        });
      },
      createDraft: async (currentConfig, currentLedger, current, repo, revision) => ({
        url: 'https://example.invalid/reviewed-handoff/draft/repair',
        isDraft: true,
        headRevision: revision
      })
    }
  });
  assert.equal(modelCalls, 2);
  assert.equal(executed.result.outcome, 'draft-pr-validated');
  assert.deepEqual(executed.result.validation.map(item => item.status), ['passed']);
  assert.deepEqual(executed.result.validationAttempts.map(attempt =>
    attempt.validation[0].status), repairDrill.expectedValidationStatuses);
  assert.notEqual(executed.result.validationAttempts[0].sourceRevision,
    executed.result.validationAttempts[1].sourceRevision);
  assert.equal(executed.result.sourceRevision,
    executed.result.validation[0].sourceRevision);
  assert.deepEqual(executed.result.toolUsage.rounds.map(round => round.used), [3, 2]);
  assert.equal(executed.result.toolUsage.used, 5);
  assert.equal(executed.rsi.state, 'delivered', JSON.stringify(executed.rsi));
  const inspected = rsiWork(config, ledger, 'inspect', {
    observationId: executed.rsi.handoffs[0].observationId
  });
  assert.deepEqual(inspected.observation.payload.data.workerResult.validationAttempts
    .map(attempt => attempt.validation[0].status), ['failed', 'passed']);
});

test('1JS qualification specs preserve separate fixture cohorts and cleanup contracts', () => {
  const normalized = normalizeSkillInput({
    id: '1js-declarative-e2e-authoring',
    inputFormat: 'declarative-e2e-mini-spec-batch-v1'
  }, oneJsQualification);
  assert.deepEqual(normalized.items.map(item => [item.inputItemId, item.account]), [
    ['excel-agent-omni-seeded-workbook', 'AAD'],
    ['excel-agent-omni-msa-conversation-isolation', 'MSA'],
    ['excel-agent-omni-restore-web-source', 'AAD'],
    ['excel-agent-arcadia-local-file-upload', 'AAD'],
    ['excel-agent-arcadia-custom-skill-cleanup', 'AAD'],
    ['excel-agent-dedicated-sensitivity', 'AAD']
  ]);
  for (const item of normalized.items) {
    assert.ok(item.cleanup.length > 0);
    assert.match(item.preconditions.join('\n'), /five consecutive.*final.*SHA/);
    assert.match(item.preconditions.join('\n'), /retries=0/);
    assert.match(item.cleanup.join('\n'), /only.*owned/);
  }
  assert.match(normalized.items[0].expectedUserVisibleAndDataOutcomes.join('\n'),
    /A1.*15/);
  assert.match(normalized.items[0].preconditions.join('\n'),
    /Select Omni.*actual visible experience/);
  assert.match(normalized.items[0].orderedTestSteps.join('\n'), /confirm Omni/);
  assert.doesNotMatch(normalized.items[0].orderedTestSteps.join('\n'), /Arcadia/);
  assert.match(normalized.items[0].expectedUserVisibleAndDataOutcomes.join('\n'),
    /B1.*FIXTURE-SEEDED-GUARD.*protected unchanged/);
  assert.match(normalized.items[1].expectedUserVisibleAndDataOutcomes.join('\n'),
    /must not contain/);
  assert.match(normalized.items[2].cleanup.join('\n'), /even.*fails/);
  assert.match(normalized.items[3].expectedUserVisibleAndDataOutcomes.join('\n'),
    /E1.*2600/);
  assert.match(normalized.items[4].preconditions.join('\n'),
    /EXCELAGENT_CUSTOM_SKILL_E2E_ENABLED.*blocked/);
  assert.match(normalized.items[4].cleanup.join('\n'),
    /only.*owned.*even.*fails/);
  assert.match(normalized.items[5].preconditions.join('\n'),
    /dedicated-enterprise.*not.*ordinary AAD/);
  assert.match(normalized.items[5].preconditions.join('\n'),
    /Select Omni.*actual visible experience/);
  assert.match(normalized.items[5].orderedTestSteps.join('\n'),
    /confirm Omni/);
  assert.doesNotMatch(normalized.items[5].orderedTestSteps.join('\n'),
    /Arcadia/);
  assert.match(normalized.items[5].expectedUserVisibleAndDataOutcomes.join('\n'),
    /not mutated/);
  normalized.items[0].title = 'Changed copy';
  assert.notEqual(normalized.items[0].title, oneJsQualification.items[0].title);
});

test('1JS qualification reference assets preserve their separate catalog and protected contracts', () => {
  const root = new URL('./fixtures/1js-qualification/', import.meta.url);
  const catalog = JSON.parse(readFileSync(new URL('catalog.json', root), 'utf8'));
  const matrix = JSON.parse(readFileSync(new URL('capability-matrix.json', root), 'utf8'));
  const files = new Map([
    ['excel-agent.aad.fixture-seeded-workbook', 'fixture-seeded-workbook.yaml'],
    ['excel-agent.msa.fixture-conversation-isolation', 'msa-fixture-conversation-isolation.yaml'],
    ['excel-agent.aad.fixture-web-source-restoration', 'fixture-web-source-restoration.yaml'],
    ['excel-agent.aad.fixture-local-file-upload', 'fixture-local-file-upload.yaml'],
    ['excel-agent.dedicated.fixture-sensitivity', 'fixture-dedicated-sensitivity.yaml']
  ]);
  assert.deepEqual(catalog.cases.map(item => item.semanticId), [...files.keys()]);
  assert.deepEqual(matrix.cases.map(item => item.semanticId), [...files.keys()]);
  for (const entry of catalog.cases) {
    const contract = matrix.cases.find(item => item.semanticId === entry.semanticId);
    const source = readFileSync(new URL(`scenarios/${files.get(entry.semanticId)}`, root), 'utf8')
      .replace(/\r\n/g, '\n');
    assert.equal(contract.title, entry.title);
    assert.ok(source.includes(`\nid: ${entry.semanticId}\n`));
    assert.ok(source.includes(`\nname: ${entry.title}\n`));
    assert.ok(source.includes(`\n  lane: ${contract.accountLane}\n`));
    assert.match(source, /protected: true/);
    if (entry.semanticId.endsWith('fixture-seeded-workbook') ||
        entry.semanticId.endsWith('fixture-sensitivity')) {
      assert.match(source, /^  experience: omni$/m);
    }
  }
  const seeded = matrix.cases.find(item =>
    item.semanticId === 'excel-agent.aad.fixture-seeded-workbook');
  assert.ok(seeded.assertions.some(item => item.provider === 'workbook' &&
    item.assertion === 'exact' && item.parameters.cell === 'A1' &&
    item.parameters.expected === '15'));
  assert.ok(seeded.assertions.some(item => item.provider === 'workbook' &&
    item.assertion === 'unchanged' && item.parameters.cell === 'B1'));
  const dedicated = matrix.cases.find(item =>
    item.semanticId === 'excel-agent.dedicated.fixture-sensitivity');
  assert.equal(dedicated.accountLane, 'dedicated-enterprise');
  assert.ok(dedicated.assertions.some(item =>
    item.provider === 'sensitivity' && item.assertion === 'visible'));
});

for (const repairBudget of [0, 1, 2])
test(`1JS edited-commit repair budget ${repairBudget} preserves failures and validation isolation`, async t => {
  const ctx = await setup(t);
  const oneJs = await addOneJsRepository(ctx, {
    enableDraftBuild: true, validationScript: oneJsRepairRunner
  });
  ctx.config.activation.dispatch = true;
  ctx.config.limits.maxAiCreditsPerSession = 1;
  ctx.config.limits.maxValidationRepairRounds = repairBudget;
  ctx.config.limits.maxValidationInfrastructureRetries = 0;
  await command('git', ['init', '--bare', '--quiet', oneJs.remote], ctx.root);
  const scenarioPath = oneJs.scenarioPath;
  const referenceSkill = readFileSync(join(oneJs.reference, oneJs.repo.skillBindings[0].skillPath));
  const publicationCalls = [];
  const reports = [];
  const revisions = [];
  let modelCalls = 0;

  function assertPriorValidationCleaned(currentLedger, jobId) {
    const operations = currentLedger.status().operations.filter(operation =>
      operation.job_id === jobId && operation.kind === 'validation');
    for (const operation of operations) {
      const artifact = JSON.parse(readFileSync(JSON.parse(operation.detail).artifact, 'utf8'));
      const report = JSON.parse(artifact.output.stdout);
      assert.equal(report.provenance, 'synthetic');
      assert.equal(report.sourceRevision, artifact.revision);
      assert.equal(report.retries, 0);
      assert.equal(report.requiredConsecutivePasses, 5);
      assert.equal(report.ownedResourcesRemoved, true);
      assert.equal(report.unownedResourcePreserved, true);
      assert.equal(existsSync(report.scratchRoot), false);
      assert.equal(existsSync(report.validationWorkspace), false);
    }
  }

  const executed = await acceptReviewedHandoff(ctx.config, ctx.ledger, oneJsFixture, {
    execute: true,
    authorizeSynthetic: true,
    authorizeCommit: true,
    authorizePush: true,
    authorizeDraftPR: true,
    dispatchDependencies: {
      runModel: async (_config, currentLedger, current, assignment, _investigation,
        toolkit, skill, authoring) => {
        assert.equal(assignment.repoId, '1js');
        assert.equal(authoring.round, modelCalls++);
        assert.match(skill.instructions, /Fixture declarative E2E skill/);
        assertPriorValidationCleaned(currentLedger, current.id);
        const round = oneJsRepairDrill.rounds[authoring.round];
        if (authoring.round === 0) {
          assert.deepEqual(authoring.validationFeedback, []);
        } else {
          const feedback = authoring.validationFeedback[0];
          assert.equal(feedback.status, 'failed');
          assert.equal(feedback.exitCode, 1);
          const report = JSON.parse(feedback.stdoutTail);
          assert.equal(report.failure, round.expectedFeedbackFailure);
          assert.equal(report.sourceRevision, feedback.sourceRevision);
          assert.equal(report.expectedValue, 15);
          assert.equal(report.consecutivePasses, 0);
          assert.deepEqual(report.runs.map(run => run.status), ['failed']);
        }
        toolkit.write(scenarioPath.replaceAll('/', '\\'), json(round.scenario));
        toolkit.finish({
          outcome: 'propose-change',
          findings: round.findings,
          title: round.title,
          description: 'Synthetic 1JS edited-commit qualification drill, not live product proof.',
          skillResult: {
            status: 'succeeded',
            classification: 'missing-test-coverage',
            changedFiles: [scenarioPath],
            testsAddedOrUpdated: ['bizchat-create-canary-excel'],
            behaviorCardsAddedOrUpdated: [],
            unknowns: [],
            needsHumanDecision: false
          }
        });
      },
      queueDraftBuild: async (currentConfig, currentLedger, current, repo, revision) => {
        assert.equal(repairBudget, 2);
        assertPriorValidationCleaned(currentLedger, current.id);
        assert.equal(revision, revisions.at(-1));
        return queueAdoDraftBuild(currentConfig, currentLedger, current, repo, revision, async body => {
          assert.deepEqual(JSON.parse(body.templateParameters.newCaseSelection), {
            format: '1js-new-case-selection-v1',
            baseRevision: oneJs.baseRevision,
            sourceRevision: revision,
            scenarioPaths: [scenarioPath]
          });
          assert.equal(body.templateParameters.newCaseGroups, 'crossOfficeCowork');
          publicationCalls.push({ kind: 'build', revision });
          return {
            id: 57329999,
            _links: { web: { href: 'https://office.visualstudio.com/Office/_build/results?buildId=57329999' } }
          };
        });
      },
      createDraft: async (_config, _ledger, _current, _repo, revision, proposal) => {
        assert.equal(repairBudget, 2);
        assert.equal(revision, revisions.at(-1));
        assert.match(proposal.description, /57329999/);
        publicationCalls.push({ kind: 'draft', revision });
        return {
          url: 'https://example.invalid/1js/draft/repair',
          isDraft: true, headRevision: revision
        };
      },
      runValidation: async (...args) => {
        const result = await runValidation(...args);
        const artifact = JSON.parse(readFileSync(result[0].artifactRefs[0], 'utf8'));
        assert.ok(artifact.output.stdout, json({ validation: result[0], output: artifact.output }));
        const report = JSON.parse(artifact.output.stdout);
        reports.push(report);
        revisions.push(args[4]);
        return result;
      }
    }
  });

  const attempts = executed.result.validationAttempts;
  assert.equal(modelCalls, repairBudget + 1);
  assert.deepEqual(attempts.map(attempt => attempt.validation[0].status),
    oneJsRepairDrill.expectedValidationStatuses.slice(0, repairBudget + 1));
  assert.equal(new Set(revisions).size, repairBudget + 1);
  assert.deepEqual(attempts.map(attempt => attempt.sourceRevision), revisions);
  assert.deepEqual(reports.map(report => report.sourceRevision), revisions);
  assert.deepEqual(reports.map(report => report.consecutivePasses),
    [0, 0, 5].slice(0, repairBudget + 1));
  const job = ctx.ledger.job(executed.result.assignmentId);
  assertPriorValidationCleaned(ctx.ledger, job.id);
  for (let index = 0; index < revisions.length; index++) {
    const parent = (await command('git', ['rev-parse', `${revisions[index]}^`], job.workspace))
      .stdout.trim();
    assert.equal(parent, index === 0 ? oneJs.baseRevision : revisions[index - 1]);
    const scenario = JSON.parse((await command('git',
      ['show', `${revisions[index]}:${scenarioPath}`], job.workspace)).stdout);
    assert.deepEqual(scenario, oneJsRepairDrill.rounds[index].scenario);
    const validator = (await command('git', ['show',
      `${revisions[index]}:scripts/validate-generated.mjs`], job.workspace)).stdout;
    assert.equal(validator, oneJsRepairRunner);
  }
  assert.deepEqual(readFileSync(join(oneJs.reference, oneJs.repo.skillBindings[0].skillPath)),
    referenceSkill);
  assert.equal((await command('git', ['rev-parse', 'HEAD'], oneJs.reference)).stdout.trim(),
    oneJs.baseRevision);
  assert.equal((await command('git', ['status', '--porcelain'], oneJs.reference)).stdout.trim(), '');
  assert.equal(executed.result.sourceRevision, revisions.at(-1));
  assert.ok(executed.result.validation.every(gate => gate.sourceRevision === revisions.at(-1)));
  const remoteRefs = (await command('git', ['--git-dir', oneJs.remote,
    'for-each-ref', '--format=%(objectname)'], ctx.root)).stdout.trim();
  if (repairBudget < 2) {
    assert.equal(executed.result.outcome, 'blocked');
    assert.equal(executed.result.draftPR, null);
    assert.deepEqual(publicationCalls, []);
    assert.equal(remoteRefs, '');
  } else {
    assert.equal(executed.result.outcome, 'draft-pr-validated');
    assert.equal(executed.result.draftPR.headRevision, revisions[2]);
    assert.deepEqual(publicationCalls, [
      { kind: 'build', revision: revisions[2] }, { kind: 'draft', revision: revisions[2] }
    ]);
    assert.equal(remoteRefs, revisions[2]);
    assert.deepEqual(reports[2].runs.map(run => run.status), Array(5).fill('passed'));
    assert.equal(executed.result.remoteValidation[0].sourceRevision, revisions[2]);
  }
});

test('Agency authoring provider uses the same local repair loop and exact session', async t => {
  const { root, remote, config, ledger } = await setup(t);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  config.limits.maxValidationRepairRounds = 2;
  config.authoringProviders = {
    'agency-oa': {
      type: 'agency-local',
      executable: process.execPath,
      profile: 'periodic-evidence-isolated'
    }
  };
  config.repositories[0].skillBindings[0].authoringProvider = 'agency-oa';
  await command('git', ['init', '--bare', '--quiet', remote], root);
  const sessions = [];
  const prompts = [];
  const executed = await acceptReviewedHandoff(config, ledger, fixture, {
    execute: true,
    authorizeSynthetic: true,
    authorizeCommit: true,
    authorizePush: true,
    authorizeDraftPR: true,
    dispatchDependencies: {
      runAgencyLocal: async (currentConfig, current, toolkit, prompt, provider, authoring) => {
        sessions.push(current.session_id);
        prompts.push(prompt);
        assert.equal(provider, config.authoringProviders['agency-oa']);
        const round = repairDrill.rounds[authoring.round];
        assert.ok(round);
        for (const [path, content] of Object.entries(round.writes))
          toolkit.write(path.replaceAll('/', '\\'), content);
        toolkit.finish({
          outcome: 'propose-change',
          findings: round.findings,
          title: round.title,
          description: 'Authorized synthetic reviewed-handoff draft.',
          skillResult: repairDrill.skillResult
        });
      },
      createDraft: async (currentConfig, currentLedger, current, repo, revision) => ({
        url: 'https://example.invalid/reviewed-handoff/draft/agency-repair',
        isDraft: true,
        headRevision: revision
      })
    }
  });
  assert.equal(executed.result.outcome, 'draft-pr-validated');
  assert.equal(new Set(sessions).size, 1);
  assert.equal(sessions.length, 2);
  assert.match(prompts[0], /"round":0/);
  assert.match(prompts[1], /"round":1/);
  assert.match(prompts[1], /"status":"failed"/);
  assert.deepEqual(executed.result.validationAttempts.map(attempt =>
    attempt.validation[0].status), repairDrill.expectedValidationStatuses);
  assert.deepEqual(executed.result.toolUsage.rounds.map(round => round.used), [3, 2]);
  assert.equal(executed.result.toolUsage.used, 5);
});

test('Agency remote authoring imports only the remote diff into the local repair loop', async t => {
  const { root, remote, config, ledger } = await setup(t);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  config.limits.maxValidationRepairRounds = 2;
  config.authoringProviders = {
    'agency-remote-oa': {
      type: 'agency-remote',
      executable: process.execPath,
      profile: 'qualified-remote',
      pollSeconds: 1
    }
  };
  config.repositories[0].pr = {
    provider: 'ado',
    organization: 'fixture',
    project: 'fixture',
    repositoryId: 'fixture',
    targetRef: 'refs/heads/main'
  };
  config.repositories[0].skillBindings[0].authoringProvider = 'agency-remote-oa';
  await command('git', ['init', '--bare', '--quiet', remote], root);
  const prompts = [];
  let validationPrepared = false;
  const executed = await acceptReviewedHandoff(config, ledger, fixture, {
    execute: true,
    authorizeSynthetic: true,
    authorizeCommit: true,
    authorizePush: true,
    authorizeDraftPR: true,
    dispatchDependencies: {
      prepareValidation: async () => {
        validationPrepared = true;
        return {};
      },
      agencyRemote: {
        getToken: async () => 'synthetic-token',
        pushBranch: async (currentConfig, workspace, repo, refspec, admission) => {
          assert.match(refspec, /^[a-f0-9]{40}:refs\/heads\/pilot-agency-base\//);
          assert.equal(admission.ledger, ledger);
          await pushDraftBranch(currentConfig, workspace, repo, refspec, admission);
        },
        executeRemoteJob: async (currentConfig, currentLedger, current, repo,
          provider, input) => {
          assert.equal(validationPrepared, true);
          prompts.push(input.prompt);
          const round = repairDrill.rounds[input.round];
          assert.ok(round);
          const workspace = join(root, `agency-round-${input.round}`);
          await command('git', ['-c', 'core.autocrlf=false',
            '-c', 'core.safecrlf=false', 'clone', '--quiet', remote, workspace], root);
          await command('git', ['-c', 'core.autocrlf=false',
            '-c', 'core.safecrlf=false', 'checkout', '--quiet', '-b',
            `agency-result-${input.round}`, `origin/${input.branch}`], workspace);
          for (const [path, content] of Object.entries(round.writes)) {
            mkdirSync(join(workspace, path, '..'), { recursive: true });
            writeFileSync(join(workspace, path), content);
          }
          const resultPath = join(workspace,
            '.periodic-evidence-agent', 'result.json');
          mkdirSync(join(resultPath, '..'), { recursive: true });
          writeFileSync(resultPath, JSON.stringify({
            schemaVersion: '1.0',
            assignmentId: current.id,
            round: input.round,
            baseRevision: input.baseRevision,
            proposal: {
              outcome: 'propose-change',
              findings: round.findings,
              title: round.title,
              description: 'Authorized synthetic Agency remote draft.',
              skillResult: repairDrill.skillResult
            }
          }));
          await command('git', ['-c', 'core.autocrlf=false',
            '-c', 'core.safecrlf=false', 'add', '--all'], workspace);
          await command('git', ['-c', 'core.autocrlf=false',
            '-c', 'core.safecrlf=false', '-c', 'user.name=Agency Fixture',
            '-c', 'user.email=agency@example.invalid', 'commit', '--quiet',
            '-m', `Agency fixture round ${input.round}`], workspace);
          const sourceBranch = `agency/result-${input.round}`;
          await command('git', ['push', '--quiet', 'origin',
            `HEAD:refs/heads/${sourceBranch}`], workspace);
          return { sourceBranch: `refs/heads/${sourceBranch}` };
        }
      },
      createDraft: async (currentConfig, currentLedger, current, repo,
        revision) => ({
        url: 'https://example.invalid/reviewed-handoff/draft/agency-remote-repair',
        isDraft: true,
        headRevision: revision
      })
    }
  });
  assert.equal(executed.result.outcome, 'draft-pr-validated');
  assert.equal(prompts.length, 2);
  assert.match(prompts[0], /Agency remote checkout/);
  assert.match(prompts[0], /\.periodic-evidence-agent\/result\.json/);
  assert.match(prompts[1], /"status":"failed"/);
  assert.deepEqual(executed.result.validationAttempts.map(attempt =>
    attempt.validation[0].status), repairDrill.expectedValidationStatuses);
  assert.deepEqual(executed.result.toolUsage.rounds.map(round => round.used),
    [3, 2]);
  assert.equal(executed.result.skillExecution.status, 'succeeded');
});

test('prepared Agency assignments reject provider configuration drift', async t => {
  const { config, ledger } = await setup(t);
  config.authoringProviders = {
    'agency-oa': {
      type: 'agency-local',
      executable: process.execPath,
      profile: 'periodic-evidence-isolated'
    }
  };
  config.repositories[0].skillBindings[0].authoringProvider = 'agency-oa';
  const prepared = prepareReviewedHandoff(config, ledger, fixture);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  config.authoringProviders['agency-oa'].profile = 'changed-after-preparation';
  await assert.rejects(dispatchReviewedHandoff(config, ledger, prepared.assignment.id),
    /changed after assignment preparation|Assignment inputs/);
  assert.equal(ledger.job(prepared.assignment.id).state, 'prepared');
});

for (const repairBudget of [0, 1])
test(`exhausted test-only repair budget ${repairBudget} blocks without push or Draft PR`, async t => {
  const { root, remote, config, ledger } = await setup(t);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  config.limits.maxValidationRepairRounds = repairBudget;
  config.rsi = structuredClone(rsiPolicy);
  await command('git', ['init', '--bare', '--quiet', remote], root);
  let modelCalls = 0;
  let draftCreated = false;
  const executed = await acceptReviewedHandoff(config, ledger, fixture, {
    execute: true,
    authorizeSynthetic: true,
    authorizeCommit: true,
    authorizePush: true,
    authorizeDraftPR: true,
    dispatchDependencies: {
      runModel: async (currentConfig, currentLedger, current, assignment, investigation,
        toolkit, skill, authoring) => {
        modelCalls++;
        assert.equal(authoring.round, modelCalls - 1);
        toolkit.write('test\\behavior.test.js',
          `import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fixture behavior', () => assert.equal(1, ${authoring.round + 2}));\n`);
        toolkit.write('test\\behavior-card.md', '# Fixture behavior\n');
        toolkit.finish({
          outcome: 'propose-change',
          findings: 'Added initial focused fixture coverage.',
          title: 'Add failing fixture behavior coverage',
          description: 'Authorized synthetic reviewed-handoff draft.',
          skillResult: {
            status: 'succeeded',
            classification: 'missing-test-coverage',
            changedFiles: ['test/behavior-card.md', 'test/behavior.test.js'],
            testsAddedOrUpdated: ['fixture behavior'],
            behaviorCardsAddedOrUpdated: ['test/behavior-card.md'],
            unknowns: [],
            needsHumanDecision: false
          }
        });
      },
      pushBranch: async () => assert.fail('failed validation must not push'),
      createDraft: async () => {
        draftCreated = true;
        throw new Error('Draft creation must not run for failed test-only validation');
      }
    }
  });
  assert.equal(modelCalls, repairBudget + 1);
  assert.equal(executed.result.outcome, 'blocked');
  assert.equal(executed.result.draftPR, null);
  assert.equal(draftCreated, false);
  assert.match(executed.result.blocker.reason, /production-code repair is prohibited/);
  assert.deepEqual(executed.result.validation.map(item => item.status), ['failed']);
  assert.equal(executed.result.validationAttempts.length, repairBudget + 1);
  assert.equal(executed.rsi.state, 'delivered', JSON.stringify(executed.rsi));
  assert.equal(ledger.all('rsiFlowObservation')[0].payload.outcome, 'blocked');
  assert.equal(ledger.all('rsiFlowObservation')[0].payload.data.workerResult.validation[0].status, 'failed');
  assert.equal((await command('git', ['--git-dir', remote, 'for-each-ref', '--format=%(refname)'], root))
    .stdout.trim(), '');
});

for (const invalidResult of ['blocked', 'missing', 'stale', 'duplicate', 'dirty', 'changed-head'])
test(`${invalidResult} validation prevents push and Draft PR creation`, async t => {
  const { config, ledger } = await setup(t);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  config.limits.maxValidationRepairRounds = 2;
  let modelCalls = 0;
  let pushed = false;
  let draftCreated = false;
  await assert.rejects(acceptReviewedHandoff(config, ledger, fixture, {
    execute: true,
    authorizeSynthetic: true,
    authorizeCommit: true,
    authorizePush: true,
    authorizeDraftPR: true,
    dispatchDependencies: {
      runModel: async (currentConfig, currentLedger, current, assignment, investigation,
        toolkit) => {
        modelCalls++;
        toolkit.write('test\\behavior.test.js',
          "import test from 'node:test';\ntest('fixture behavior', () => {});\n");
        toolkit.write('test\\behavior-card.md', '# Fixture behavior\n');
        toolkit.finish({
          outcome: 'propose-change',
          findings: 'Added focused fixture coverage.',
          title: 'Add fixture behavior coverage',
          description: 'Authorized synthetic reviewed-handoff draft.',
          skillResult: {
            status: 'succeeded',
            classification: 'missing-test-coverage',
            changedFiles: ['test/behavior-card.md', 'test/behavior.test.js'],
            testsAddedOrUpdated: ['fixture behavior'],
            behaviorCardsAddedOrUpdated: ['test/behavior-card.md'],
            unknowns: [],
            needsHumanDecision: false
          }
        });
      },
      runValidation: async (currentConfig, currentLedger, current, repo, revision) => {
        if (invalidResult === 'missing') return [];
        if (['dirty', 'changed-head'].includes(invalidResult)) {
          writeFileSync(join(current.workspace, 'test', 'behavior.test.js'), '// changed after validation\n');
          if (invalidResult === 'changed-head') {
            await command('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
              'add', '--all'], current.workspace);
            await command('git', ['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
              '-c', 'core.hooksPath=.git/no-hooks', 'commit', '--quiet', '-m', 'Post-validation change'], current.workspace);
          }
        }
        const result = {
          gateId: 'fixture-test',
          sourceRevision: invalidResult === 'stale' ? 'a'.repeat(40) : revision,
          commandOrRunUrl: 'fixture-blocked',
          status: invalidResult === 'blocked' ? 'blocked' : 'passed',
          artifactRefs: ['fixture-validation.json'],
          owner: repo.owner,
          nextCheckAt: null,
          attemptCount: 1,
          blockedReason: invalidResult === 'blocked' ? 'runner-unavailable' : null
        };
        return invalidResult === 'duplicate' ? [result, result] : [result];
      },
      pushBranch: async () => { pushed = true; },
      createDraft: async () => {
        draftCreated = true;
        return null;
      }
    }
  }), /no push permitted/);
  assert.equal(modelCalls, 1);
  assert.equal(pushed, false);
  assert.equal(draftCreated, false);
});
