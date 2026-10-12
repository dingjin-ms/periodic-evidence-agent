import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAt, hash } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import {
  prepareReviewedHandoffE2E, runReviewedHandoffE2E, validateReviewedHandoff
} from '../src/downstream-e2e.js';
import {
  acceptReviewedHandoff, prepareReviewedHandoff
} from '../src/reviewed-handoff.js';
import { dispatch, command } from '../src/workers.js';
import { skillQualificationId } from '../src/repository-skills.js';

const fixture = JSON.parse(readFileSync(
  new URL('./fixtures/downstream-e2e/onenote-bootstrap-progress.reviewed-handoff.json', import.meta.url),
  'utf8'));

async function setup(t) {
  const root = mkdtempSync(join(tmpdir(), 'downstream-e2e-'));
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
    routingRules: ['Reviewed downstream E2E'],
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
      enabled: true,
      qualification: 'qualified',
      requestedOutcomes: ['add-or-update-tests'],
      sideEffects: { commit: true, push: true, createDraftPR: true }
    }]
  }];
  const ledger = new Ledger(state);
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
  const prepared = prepareReviewedHandoffE2E(config, ledger, fixture);
  assert.equal(prepared.evidence.source.kind, 'fixture');
  assert.equal(prepared.evidence.source.provenance, 'synthetic');
  assert.equal(prepared.investigation.handoffEligibility, 'eligible');
  assert.equal(prepared.testCoveragePlan.sourceRevision, baseRevision);
  assert.equal(prepared.assignment.skillBindingId, 'oa-integration-test-core');
  assert.match(prepared.assignment.questions[0],
    /contracts\/apps\/onenote\/omni-onenote-bootstrap-progress\.contract\.test\.ts/);
  assert.equal(prepared.job.state, 'prepared');
});

test('downstream adapter delegates to the production reviewed-handoff controller', async t => {
  const { config, ledger } = await setup(t);
  assert.equal(typeof prepareReviewedHandoff, 'function');
  assert.equal(typeof acceptReviewedHandoff, 'function');
  const source = readFileSync(new URL('../src/downstream-e2e.js', import.meta.url), 'utf8');
  assert.match(source, /from '.\/reviewed-handoff\.js'/);
  assert.doesNotMatch(source, /ledger\.|recordType|planImprovement|exclusionsChecked/);
  const prepared = prepareReviewedHandoffE2E(config, ledger, fixture);
  assert.equal(prepared.receipt.id, fixture.id);
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
  const conflicting = structuredClone(fixture);
  conflicting.review.nextAction = 'Conflicting replay';
  await assert.rejects(async () => prepareReviewedHandoff(config, ledger, conflicting),
    /conflicts with persisted content/);
});

test('reviewed handoff requires the complete exclusion checklist', () => {
  const invalid = structuredClone(fixture);
  invalid.review.exclusionsChecked.pop();
  assert.throws(() => validateReviewedHandoff(invalid), /reviewedHandoff|exclusion/);
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
  const prepared = prepareReviewedHandoffE2E(config, ledger, fixture);
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
    await assert.rejects(runReviewedHandoffE2E(config, ledger, fixture, options),
      new RegExp(expected));
    assert.equal(ledger.latestEvidence().length, 0);
  }
});

test('repository binding must authorize commit push and Draft PR independently', async t => {
  for (const sideEffect of ['commit', 'push', 'createDraftPR']) {
    const { config, ledger } = await setup(t);
    config.repositories[0].skillBindings[0].sideEffects[sideEffect] = false;
    await assert.rejects(runReviewedHandoffE2E(config, ledger, fixture, {
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
  for (const path of ['../src/reviewed-handoff.js', '../src/downstream-e2e.js']) {
    const source = readFileSync(new URL(path, import.meta.url), 'utf8');
    assert.doesNotMatch(source, /office-agent|oa-integration|onenote/i);
  }
});

test('authorized downstream E2E reuses real dispatch with external boundaries injected', async t => {
  const { root, remote, config, ledger } = await setup(t);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  await command('git', ['init', '--bare', '--quiet', remote], root);
  const executed = await runReviewedHandoffE2E(config, ledger, fixture, {
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
          findings: 'Added focused fixture coverage through the real downstream controller.',
          title: 'Add fixture behavior coverage',
          description: 'Authorized synthetic downstream E2E draft.',
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
        url: 'https://example.invalid/downstream-e2e/draft/1',
        isDraft: true,
        headRevision: revision
      })
    }
  });
  assert.equal(executed.result.outcome, 'draft-pr-validated');
  assert.equal(executed.result.skillExecution.bindingId, 'oa-integration-test-core');
  assert.equal(executed.result.validation[0].sourceRevision, executed.result.sourceRevision);
  assert.equal(executed.result.draftPR.headRevision, executed.result.sourceRevision);
});

test('controller validation failures feed a bounded repository-skill repair loop', async t => {
  const { root, remote, config, ledger } = await setup(t);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  config.limits.maxValidationRepairRounds = 2;
  await command('git', ['init', '--bare', '--quiet', remote], root);
  let modelCalls = 0;
  const executed = await runReviewedHandoffE2E(config, ledger, fixture, {
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
        if (authoring.round === 0) {
          assert.deepEqual(authoring.validationFeedback, []);
          toolkit.write('test\\behavior.test.js',
            "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fixture behavior', () => assert.equal(1, 2));\n");
        } else {
          assert.equal(authoring.validationFeedback[0].status, 'failed');
          assert.equal(authoring.validationFeedback[0].exitCode, 1);
          toolkit.write('test\\behavior.test.js',
            "import test from 'node:test';\nimport assert from 'node:assert/strict';\ntest('fixture behavior', () => assert.equal(1, 1));\n");
        }
        toolkit.finish({
          outcome: 'propose-change',
          findings: authoring.round === 0
            ? 'Added initial focused fixture coverage.'
            : 'Repaired the controller-reported validation failure.',
          title: authoring.round === 0 ? 'Add fixture behavior coverage' : 'Repair fixture behavior coverage',
          description: 'Authorized synthetic downstream E2E draft.',
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
        url: 'https://example.invalid/downstream-e2e/draft/repair',
        isDraft: true,
        headRevision: revision
      })
    }
  });
  assert.equal(modelCalls, 2);
  assert.equal(executed.result.outcome, 'draft-pr-validated');
  assert.deepEqual(executed.result.validation.map(item => item.status), ['passed']);
  assert.deepEqual(executed.result.validationAttempts.map(attempt =>
    attempt.validation[0].status), ['failed', 'passed']);
  assert.notEqual(executed.result.validationAttempts[0].sourceRevision,
    executed.result.validationAttempts[1].sourceRevision);
  assert.equal(executed.result.sourceRevision,
    executed.result.validation[0].sourceRevision);
});

test('zero repair budget preserves an explicit failed Draft PR outcome', async t => {
  const { root, remote, config, ledger } = await setup(t);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  config.limits.maxValidationRepairRounds = 0;
  await command('git', ['init', '--bare', '--quiet', remote], root);
  let modelCalls = 0;
  const executed = await runReviewedHandoffE2E(config, ledger, fixture, {
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
          description: 'Authorized synthetic downstream E2E draft.',
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
        url: 'https://example.invalid/downstream-e2e/draft/failed',
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
  await assert.rejects(runReviewedHandoffE2E(config, ledger, fixture, {
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
          description: 'Authorized synthetic downstream E2E draft.',
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
        nextCheckAt: null
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
