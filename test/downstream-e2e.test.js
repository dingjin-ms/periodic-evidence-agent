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

test('reviewed handoff requires the complete exclusion checklist', () => {
  const invalid = structuredClone(fixture);
  invalid.review.exclusionsChecked.pop();
  assert.throws(() => validateReviewedHandoff(invalid), /reviewedHandoff|exclusion/);
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
  await assert.rejects(runReviewedHandoffE2E(config, ledger, fixture, {
    execute: true,
    authorizeSynthetic: true
  }), /--authorize-draft-pr/);
  assert.equal(ledger.latestEvidence().length, 0);
  await assert.rejects(runReviewedHandoffE2E(config, ledger, fixture, {
    execute: true,
    authorizeDraftPR: true
  }), /--authorize-synthetic/);
  assert.equal(ledger.latestEvidence().length, 0);
});

test('authorized downstream E2E reuses real dispatch with external boundaries injected', async t => {
  const { root, remote, config, ledger } = await setup(t);
  config.activation.dispatch = true;
  config.limits.maxAiCreditsPerSession = 1;
  await command('git', ['init', '--bare', '--quiet', remote], root);
  const executed = await runReviewedHandoffE2E(config, ledger, fixture, {
    execute: true,
    authorizeSynthetic: true,
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
