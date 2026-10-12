import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { configAt, hash } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import {
  acceptReviewedHandoff, prepareReviewedHandoff, validateReviewedHandoffReceipt
} from '../src/reviewed-handoff.js';
import { dispatch, command } from '../src/workers.js';
import { repositoryValidationContract, skillQualificationId } from '../src/repository-skills.js';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/reviewed-handoff/onenote-bootstrap-progress.reviewed-handoff.json', import.meta.url),
  'utf8'));
const repairDrill = JSON.parse(readFileSync(
  new URL('./fixtures/reviewed-handoff/validation-repair-drill.json', import.meta.url),
  'utf8'));
const oneJsFixture = JSON.parse(readFileSync(
  new URL('./fixtures/reviewed-handoff/1js-bizchat-excel.reviewed-handoff.json', import.meta.url),
  'utf8'));

async function setup(t, { inputFormat = null } = {}) {
  const root = mkdtempSync(join(tmpdir(), 'reviewed-handoff-'));
  const reference = join(root, 'reference');
  const remote = join(root, 'remote.git');
  const state = join(root, 'state');
  const skillPath = '.github/skills/integration-test-authoring/SKILL.md';
  mkdirSync(join(reference, '.github', 'skills', 'integration-test-authoring'), { recursive: true });
  mkdirSync(join(reference, 'src'), { recursive: true });
  writeFileSync(join(reference, skillPath), '# Fixture integration-test skill\nAdd focused tests.\n');
  writeFileSync(join(reference, 'src', 'value.js'), 'export const value = 1;\n');
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
    workerMaxToolCalls: 20
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
      sideEffects: { commit: true, push: true, createDraftPR: true }
    }]
  }];
  const ledger = new Ledger(state);
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
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  });
  return { root, remote, config, ledger, baseRevision };
}

test('reviewed handoff fixture prepares real planning and assignment records', async t => {
  const { config, ledger, baseRevision } = await setup(t);
  const prepared = prepareReviewedHandoff(config, ledger, fixture);
  assert.equal(prepared.evidence.source.kind, 'fixture');
  assert.equal(prepared.evidence.source.provenance, 'synthetic');
  assert.equal(prepared.investigation.handoffEligibility, 'eligible');
  assert.equal(prepared.testCoveragePlan.sourceRevision, baseRevision);
  assert.equal(prepared.assignment.skillBindingId, 'oa-integration-test-core');
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

test('authorized reviewed handoff reuses real dispatch with external boundaries injected', async t => {
  const { root, remote, config, ledger } = await setup(t);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  await command('git', ['init', '--bare', '--quiet', remote], root);
  const executed = await acceptReviewedHandoff(config, ledger, fixture, {
    execute: true,
    authorizeSynthetic: true,
    authorizeCommit: true,
    authorizePush: true,
    authorizeDraftPR: true,
    dispatchDependencies: {
      runModel: async (currentConfig, currentLedger, current, assignment, investigation, toolkit, skill) => {
        assert.equal(investigation.review.reviewer, 'synthetic-reviewed-handoff-fixture');
        assert.equal(assignment.skillBindingId, 'oa-integration-test-core');
        assert.match(skill.instructions, /Fixture integration-test skill/);
        toolkit.write('test\\behavior.test.js',
          "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fixture behavior', () => assert.equal(1, 1));\n");
        toolkit.finish({
          outcome: 'propose-change',
          findings: 'Added focused fixture coverage through the real reviewed-handoff controller.',
          title: 'Add fixture behavior coverage',
          description: 'Authorized synthetic reviewed-handoff draft.',
          skillResult: {
            status: 'succeeded',
            classification: 'missing-test-coverage',
            changedFiles: ['test/behavior.test.js'],
            testsAddedOrUpdated: ['fixture behavior'],
            behaviorCardsAddedOrUpdated: [],
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
  assert.equal(executed.result.toolUsage.used, 2);
  assert.equal(executed.result.toolUsage.byTool.pilot_write, 1);
  assert.equal(executed.result.toolUsage.byTool.pilot_finish, 1);
});

test('controller validation failures feed a bounded repository-skill repair loop', async t => {
  const { root, remote, config, ledger } = await setup(t);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  config.limits.maxValidationRepairRounds = 2;
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
});

test('zero repair budget preserves an explicit failed Draft PR outcome', async t => {
  const { root, remote, config, ledger } = await setup(t);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  config.limits.maxValidationRepairRounds = 0;
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
        assert.equal(authoring.round, 0);
        toolkit.write('test\\behavior.test.js',
          "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fixture behavior', () => assert.equal(1, 2));\n");
        toolkit.finish({
          outcome: 'propose-change',
          findings: 'Added initial focused fixture coverage.',
          title: 'Add failing fixture behavior coverage',
          description: 'Authorized synthetic reviewed-handoff draft.',
          skillResult: {
            status: 'succeeded',
            classification: 'missing-test-coverage',
            changedFiles: ['test/behavior.test.js'],
            testsAddedOrUpdated: ['fixture behavior'],
            behaviorCardsAddedOrUpdated: [],
            unknowns: [],
            needsHumanDecision: false
          }
        });
      },
      createDraft: async (currentConfig, currentLedger, current, repo, revision) => ({
        url: 'https://example.invalid/reviewed-handoff/draft/failed',
        isDraft: true,
        headRevision: revision
      })
    }
  });
  assert.equal(modelCalls, 1);
  assert.equal(executed.result.outcome, 'draft-pr-validation-failed');
  assert.deepEqual(executed.result.validation.map(item => item.status), ['failed']);
  assert.equal(executed.result.validationAttempts.length, 1);
});

test('blocked validation prevents repair push and Draft PR creation', async t => {
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
        toolkit.finish({
          outcome: 'propose-change',
          findings: 'Added focused fixture coverage.',
          title: 'Add fixture behavior coverage',
          description: 'Authorized synthetic reviewed-handoff draft.',
          skillResult: {
            status: 'succeeded',
            classification: 'missing-test-coverage',
            changedFiles: ['test/behavior.test.js'],
            testsAddedOrUpdated: ['fixture behavior'],
            behaviorCardsAddedOrUpdated: [],
            unknowns: [],
            needsHumanDecision: false
          }
        });
      },
      runValidation: async (currentConfig, currentLedger, current, repo, revision) => [{
        gateId: 'fixture-test',
        sourceRevision: revision,
        commandOrRunUrl: 'fixture-blocked',
        status: 'blocked',
        artifactRefs: [],
        owner: repo.owner,
        nextCheckAt: null,
        attemptCount: 1,
        blockedReason: 'runner-unavailable'
      }],
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
