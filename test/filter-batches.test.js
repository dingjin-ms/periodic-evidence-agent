import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { configAt, hash, json, readJson, now } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import { reserveAgencyRequest, recordAgencySubmission, recordAgencyAnalysisCheck, recordAgencyCaptureCheck,
  reconcileAgencyResult, inspectAgencyCaptureLog, agencyFilterRunnerMetadata,
  inspectAgencySourceLog, recordAgencySourceCheck } from '../src/agency-executor.js';
import { captureVerificationProtocol, verifyFilterCaptureInput } from '../src/filter-capture-verifier.js';
import { beginApp, openApp } from '../src/app-native.js';
import { evidenceEnvelope } from '../src/sources.js';
import { loadFilterCorpus } from '../src/filter.js';
import { prepareFilterBatches, sizeFilterGroups, expandFilterSharing, expandFilterCoverage,
  validateFilterManifest, checkFilterBatchResult,
  consolidateFilterBatches, bindFilterConsolidation } from '../src/filter-batches.js';
import { prepareStage2, coverageSkillName } from '../src/stage2.js';
import { reconcileFilterExecutionCohort } from '../src/filter-execution.js';
import { executeLocalFilterBatch, inspectLocalFilterSourceReads, localFilterPreflight,
  describeLocalFilterAttempt } from '../src/local-filter.js';
import { acceptFilterProposerHandoff, prepareFilterProposerHandoff } from '../src/filter-handoff.js';
import { advanceLocalE2E } from '../src/local-e2e.js';
import { prepareLocalFilterRetry } from '../src/local-filter-retry.js';
import { captureWorkerRsiOutcome, rsiWork } from '../src/rsi-flow.js';
import { prepareValidation, resumePrecommitProposal, resumeCommittedValidation } from '../src/workers.js';
import { bindAlModelExecution } from '../src/al-workflow.js';
import { alReference } from '../src/al-adapter.js';
import {
  qualifyRepositorySkill, repositoryValidationContract, skillQualificationId
} from '../src/repository-skills.js';

const bytes = v => `${JSON.stringify(v, null, 2)}\n`;
const sha = v => hash(bytes(v));
const inputOf = b => JSON.parse(JSON.parse(b.payload).payload);
const declarativeSkillPath = '.github/skills/author-declarative-e2e-test/SKILL.md';
const declarativeInput = {
  format: 'declarative-e2e-mini-spec-batch-v1',
  items: [{
    inputItemId: 'synthetic-canary',
    title: 'Synthetic workbook contract',
    account: 'AAD',
    entryUrl: 'https://example.invalid/chat',
    preconditions: ['Use the approved dedicated test profile'],
    orderedTestSteps: ['Create a Canary worksheet with a four-row, three-column table'],
    expectedUserVisibleAndDataOutcomes: ['The workbook has the requested worksheet and table'],
    cleanup: ['Close only the test-owned tab']
  }]
};
function writeProposerSource(checkout) {
  mkdirSync(join(checkout, '.github', 'skills', 'author-declarative-e2e-test'), { recursive: true });
  mkdirSync(join(checkout, 'scenarios'));
  mkdirSync(join(checkout, 'test'));
  writeFileSync(join(checkout, declarativeSkillPath),
    '# Synthetic declarative skill\nPreserve the complete mini-spec in a scenario and register its ID.\n');
  writeFileSync(join(checkout, 'scenarios', 'baseline.json'), '{}\n');
  writeFileSync(join(checkout, 'resources.json'), '[]\n');
  writeFileSync(join(checkout, 'test', 'expected-input.json'), bytes(declarativeInput.items[0]));
  writeFileSync(join(checkout, 'test', 'scenario.test.cjs'), [
    "const test = require('node:test');",
    "const assert = require('node:assert/strict');",
    "const fs = require('node:fs');",
    "const read = path => JSON.parse(fs.readFileSync(path, 'utf8'));",
    "test('generated scenario preserves the reviewed mini-spec', () => {",
    "  const expected = read('test/expected-input.json');",
    "  assert.deepEqual(read('scenarios/canary.json'), expected);",
    "  assert.deepEqual(read('resources.json'), [expected.inputItemId]);",
    '});', ''
  ].join('\n'));
}
async function exerciseFilterProposer(s, ledger, checkout, git, manifest, reviewed, recover = false,
  orchestrated = false) {
  const committed = ['committed', 'transfer'].includes(recover);
  const sourceHash = hash(readFileSync(s.ledgerPath));
  let filterConfig = structuredClone(s.config);
  const receiptTable = filterConfig.filterExecutor === 'local-sdk' ? 'local_filter_receipts' : 'agency_receipts';
  const retainedReceipts = () => ledger.db.prepare(`SELECT kind,body FROM ${receiptTable} ORDER BY kind`).all();
  let receipts = orchestrated ? null : retainedReceipts();
  const remote = join(s.root, 'synthetic-remote.git');
  git(['init', '--bare', '--quiet', remote]);
  git(['remote', 'add', 'origin', remote]);
  const repo = {
    id: 'synthetic', projectId: 'synthetic-project', owner: 'synthetic-owner',
    routingApproved: true, routingRules: ['Synthetic FILTER flow'],
    referenceCheckout: checkout, remote, baseRef: 'HEAD',
    sparseCheckoutPaths: ['.github', 'scenarios', 'test'],
    allowedWritePrefixes: ['scenarios'], allowedWriteFiles: ['resources.json'],
    commitIdentity: { name: 'Synthetic test', email: 'synthetic@example.invalid' },
    validationGates: [{
      id: 'synthetic-scenario', approved: true, executable: process.execPath,
      args: ['--test', 'test/scenario.test.cjs'], timeoutMs: 30000
    }],
    skillBindings: [{
      id: 'synthetic-declarative', capability: 'declarative-e2e-authoring',
      skillPath: declarativeSkillPath, inputFormat: declarativeInput.format,
      enabled: true, qualification: 'qualified', requestedOutcomes: ['add-declarative-e2e-tests'],
      allowedWritePrefixes: ['scenarios'], allowedWriteFiles: ['resources.json'],
      requiresBehaviorCard: false,
      sideEffects: { commit: true, push: true, createDraftPR: true }
    }]
  };
  s.config.repositories = [repo];
  if (committed) {
    const profilePath = join(s.root, 'native-profile.js');
    writeFileSync(profilePath, '// Native validation fixture\n');
    Object.assign(repo.validationGates[0], {
      profilePath, profileSha256: hash(readFileSync(profilePath))
    });
  }
  if (recover) repo.changeFile = {
    kind: 'beachball', executable: 'yarn.cmd', cwd: '.',
    packageName: '@fixture/scenario', changeType: 'none', outputPrefix: 'scenarios'
  };
  s.config.stateDirectory = ledger.directory;
  s.config.rsi = JSON.parse(readFileSync(new URL('../scaffold/rsi-flow.example.json', import.meta.url)));
  Object.assign(s.config.limits, {
    maxItems: 10, workerMaxToolCalls: 20, maxAiCreditsPerSession: 1,
    maxValidationInfrastructureRetries: 0,
    maxValidationRepairRounds: recover === 'committed' ? 1 : 0
  });
  const qualification = await qualifyRepositorySkill(s.config, repo.id, 'declarative-e2e-authoring');
  assert.equal(qualification.baseRevision, reviewed.candidates[0].sourceRevision);
  ledger.qualify(skillQualificationId(repo.id, 'synthetic-declarative'), qualification);
  const resultPath = join(s.root, 'accepted-filter-result.json');
  writeFileSync(resultPath, bytes(reviewed));
  const input = {
    format: 'filter-proposer-handoff-v1',
    filter: { manifestPath: s.path, resultPaths: [resultPath] },
    routing: {
      capability: 'declarative-e2e-authoring', requestedOutcome: 'add-declarative-e2e-tests',
      skillInput: declarativeInput
    }
  };
  const options = { execute: true, authorizeCommit: true, authorizePush: true, authorizeDraftPR: true };
  let runInput, semanticReview;
  if (orchestrated) {
    s.config.executionMode = 'standalone-sdk';
    s.config.schedule.enabled = false;
    s.config.limits.maxAiCreditsPerSession = 30;
    s.config.limits.workerMinutes = 1;
    runInput = localE2EInput(s);
    runInput.authorization.maxProposerAiCredits = 30;
    runInput.routing = input.routing;
    const held = await advanceLocalE2E(s.config, ledger, runInput);
    assert.equal(held.state, 'held-awaiting-filter', json(held));
    assert.equal(ledger.all('assignment').length, 0);
    const filtered = await advanceLocalE2E(s.config, ledger, runInput, {
      filter: true, filterDependencies: {
        connect: syntheticLocalConnection(manifest.batches[0], reviewed, async tools => {
          await tools[0].handler({ repoId: 'synthetic', action: 'read', path: declarativeSkillPath });
          await tools[0].handler({ repoId: 'synthetic', action: 'read', path: 'test/scenario.test.cjs' });
          await tools[1].handler({ result: reviewed });
        })
      }
    });
    assert.equal(filtered.state, 'held-awaiting-review', json(filtered));
    assert.equal(ledger.all('assignment').length, 0);
    assert.equal(filtered.semanticAnalysisVerifiedByHelper, false);
    semanticReview = { ...filtered.reviewRequired, reviewedBy: 'synthetic-independent-reviewer',
      reviewedAt: now(), decision: 'approve',
      rationale: 'Synthetic source and evidence association independently checked.' };
    const rejected = await advanceLocalE2E(s.config, ledger, runInput, {
      review: { ...semanticReview, decision: 'reject' }
    });
    assert.equal(rejected.state, 'held-review-rejected');
    const stale = await advanceLocalE2E(s.config, ledger, runInput, {
      review: { ...semanticReview, bindingSha256: '0'.repeat(64) }
    });
    assert.equal(stale.blocker.code, 'blocked-review');
    assert.equal(ledger.all('assignment').length, 0);
    filterConfig = structuredClone(s.config);
    receipts = retainedReceipts();
  }
  for (const permission of ['authorizeCommit', 'authorizePush', 'authorizeDraftPR']) {
    await assert.rejects(acceptFilterProposerHandoff(s.config, ledger, input,
      { ...options, [permission]: false }), /Execution requires/);
    assert.equal(ledger.all('assignment').length, 0);
  }
  await assert.rejects(acceptFilterProposerHandoff(s.config, ledger,
    { ...input, filter: { ...input.filter, resultPaths: [] } }, options), /resultPaths/);
  const prepared = prepareFilterProposerHandoff(s.config, ledger, input);
  assert.equal(prepared.assignment.execution, 'local');
  assert.deepEqual(prepared.assignment.evidenceIds, reviewed.candidates[0].evidenceIds);
  assert.deepEqual(prepared.assignment.skillInput, declarativeInput);
  const repeated = prepareFilterProposerHandoff(s.config, ledger, input);
  assert.equal(repeated.assignment.id, prepared.assignment.id);
  let modelCalls = 0, draftCalls = 0;
  const put = ledger.put.bind(ledger);
  let interruptedDelivery = false;
  ledger.put = record => {
    if (!recover && record.recordType === 'rsiFlowObservation' && !interruptedDelivery) {
      interruptedDelivery = true;
      throw new Error('Synthetic interruption before RSI insert');
    }
    return put(record);
  };
  let preservedProposal;
  const executionOptions = {
    ...options,
    dispatchDependencies: {
      runModel: async (_config, _ledger, current, assignment, investigation, toolkit, skill) => {
        modelCalls++;
        assert.equal(current.base_revision, qualification.baseRevision);
        assert.equal(skill.skillRevision, qualification.baseRevision);
        assert.match(skill.instructions, /Synthetic declarative skill/);
        assert.equal(investigation.review.reviewer, 'FILTER:synthetic-filter');
        assert.deepEqual(assignment.skillInput, declarativeInput);
        assert.throws(() => toolkit.write('test/scenario.test.cjs', ''), /approved edit bounds/);
        toolkit.write('scenarios/canary.json', bytes(assignment.skillInput.items[0]));
        toolkit.write('resources.json', bytes([assignment.skillInput.items[0].inputItemId]));
        toolkit.finish({
          outcome: 'propose-change', findings: 'Synthetic authoring preserves reviewed input.',
          title: recover === 'committed' && modelCalls === 2
            ? 'Reworded proposal without code changes' : 'Add synthetic declarative scenario',
          description: 'Offline controller fixture only.',
          skillResult: {
            status: 'succeeded', classification: 'missing-test-coverage',
            changedFiles: ['resources.json', 'scenarios/canary.json'],
            testsAddedOrUpdated: ['synthetic-canary'], behaviorCardsAddedOrUpdated: [],
            unknowns: [], needsHumanDecision: false
          }
        });
        preservedProposal = structuredClone(toolkit.proposal);
      },
      createDraft: async (_config, _ledger, current, _repo, revision) => {
        draftCalls++;
        assert.equal(git(['--git-dir', remote, 'rev-parse', `refs/heads/pilot/${current.id}`]), revision);
        return { url: 'https://example.invalid/draft/1', isDraft: true, headRevision: revision };
      }
    }
  };
  if (orchestrated) {
    executionOptions.review = semanticReview;
    for (const permission of ['authorizeCommit', 'authorizePush', 'authorizeDraftPR']) {
      const denied = await advanceLocalE2E(s.config, ledger, runInput,
        { ...executionOptions, [permission]: false });
      assert.equal(denied.blocker.code, 'blocked-authorization');
      assert.equal(modelCalls, 0);
    }
    if (orchestrated === 'auth' || orchestrated === 'uncertain') {
      let attempts = 0;
      executionOptions.dispatchDependencies.preflightValidationAuthentication = async () => {
        attempts++;
        if (orchestrated === 'uncertain') throw new Error('Synthetic uncertain preflight');
        return [{ state: 'action-required-auth', reason: 'synthetic-only' }];
      };
      const first = await advanceLocalE2E(s.config, ledger, runInput, executionOptions);
      assert.equal(first.state, orchestrated === 'auth' ? 'action-required-auth' : 'blocked', json(first));
      const again = await advanceLocalE2E(s.config, ledger, runInput, executionOptions);
      assert.equal(again.assignment.id, first.assignment.id);
      assert.equal(attempts, 1);
      if (orchestrated === 'auth') {
        const retried = await advanceLocalE2E(s.config, ledger, runInput,
          { ...executionOptions, resumeAuth: true });
        assert.equal(retried.authRetryUsed, true, json(retried));
        assert.equal(attempts, 2);
        const exhausted = await advanceLocalE2E(s.config, ledger, runInput,
          { ...executionOptions, resumeAuth: true });
        assert.equal(exhausted.blocker.code, 'blocked-reconciliation');
        assert.equal(attempts, 2);
      }
      assert.equal(modelCalls, 0);
      assert.equal(draftCalls, 0);
      assert.equal(ledger.status().jobs.length, 1);
      return;
    }
  }
  if (recover === true) executionOptions.dispatchDependencies.prepareValidation = async () => ({
    'synthetic-scenario': { error: { code: 'blocked-validation', message: 'Synthetic interrupted install' } }
  });
  let executed;
  if (committed) {
    let validationArtifact, transferPrepared;
    Object.assign(executionOptions.dispatchDependencies, {
      prepareValidation: async (_config, current) => ({
        'synthetic-scenario': { workspace: current.workspace }
      }),
      createChangeFile: async workspace => {
        writeFileSync(join(workspace, 'scenarios/change.json'), json({
          type: 'none', dependentChangeType: 'none', packageName: '@fixture/scenario',
          comment: 'Add synthetic declarative scenario', email: 'synthetic@example.invalid'
        }));
        return 'scenarios/change.json';
      },
      runValidation: async (_config, _ledger, current, _repo, revision) => {
        const path = join(s.root, 'original-profile-failure.json');
        const artifact = {
          gateId: 'synthetic-scenario', revision, status: 'failed',
          profileSha256: repo.validationGates[0].profileSha256,
          output: { exitCode: 1, stderr: 'PILOT_VALIDATION_REVISION is missing or invalid\r\n' },
          telemetry: { validationTimings: [{ id: 'policy' }] }
        };
        if (recover === 'transfer') {
          const directory = join(s.root, 'synthetic-transfer-cache');
          mkdirSync(directory);
          git(['clone', '--quiet', '--no-hardlinks', checkout, join(directory, 'w')]);
          const body = { type: 'compile', inputs: { sourceRevision: current.base_revision,
            profileSha256: artifact.profileSha256 } };
          const receiptPath = join(directory, 'receipt.json');
          writeFileSync(receiptPath, json({ ...body, syntheticUnitFixture: true, integrity: hash(json(body)) }));
          transferPrepared = alReference(receiptPath);
          Object.assign(artifact, {
            status: 'blocked', blockedReason: 'validation-workspace-unavailable',
            observedAt: now(), nativeArtifacts: [],
            output: { stdout: '', stderr: '', inspectionError: 'Synthetic sanitized local Git transfer failure' },
            telemetry: { preparedReceipt: receiptPath, preparedSourceRevision: current.base_revision,
              validationRevision: revision, inputFingerprint: hash(json(body.inputs)),
              cache: 'hit', compileCache: 'hit', dependencyCache: 'hit',
              validationTimings: ['reuse-receipts', 'reuse-changed-paths', 'fingerprint', 'reuse-inputs',
                'reuse-prepared-outputs', 'dependencies', 'compile', 'cleanup']
                .map(id => ({ id, cache: id === 'cleanup' ? 'preserved' : 'hit' })) }
          });
        }
        writeFileSync(path, json(artifact));
        validationArtifact = { path, sha256: hash(readFileSync(path)) };
        return [{
          gateId: 'synthetic-scenario', sourceRevision: revision,
          status: artifact.status, blockedReason: artifact.blockedReason ?? null, artifactRefs: [path],
          owner: repo.owner, nextCheckAt: null, attemptCount: 1,
          commandOrRunUrl: 'synthetic native profile failure'
        }];
      }
    });
    await assert.rejects(acceptFilterProposerHandoff(s.config, ledger, input, executionOptions),
      recover === 'transfer' ? /Validation blocked/ : /No changes were proposed/);
    const prior = ledger.all('workerResult').at(-1);
    const job = ledger.job(prepared.assignment.id);
    assert.equal(job.state, 'blocked');
    assert.equal(draftCalls, 0);
    const recovery = {
      priorResultId: prior.id, proposal: preservedProposal,
      sourceRevision: prior.sourceRevision, validationArtifact,
      files: [...preservedProposal.skillExecution.changedFiles, 'scenarios/change.json']
        .sort().map(path => ({ path, sha256: hash(readFileSync(join(job.workspace, path))) }))
    };
    if (recover === 'transfer') {
      recovery.proposal = { ...preservedProposal, skillExecution: structuredClone(prior.skillExecution) };
      const put = (name, value) => {
        const path = join(s.root, name);
        writeFileSync(path, json(value));
        return alReference(path);
      };
      const args = ['fetch', '--dry-run', '--no-tags', `--negotiation-tip=${job.base_revision}`,
        '--', job.workspace, prior.sourceRevision];
      const cwd = join(s.root, 'synthetic-transfer-cache', 'w');
      const dryRun = spawnSync('git', ['-C', cwd, ...args], { encoding: 'utf8' });
      assert.equal(dryRun.status, 0, dryRun.stderr);
      const proof = { format: 'native-git-revision-transfer-proof-v1', assignmentId: job.id,
        priorResultId: prior.id, baseRevision: job.base_revision, sourceRevision: prior.sourceRevision,
        validationArtifact, preparedReceipt: transferPrepared, observedAt: now(),
        configurationSha256: hash(json(s.config)), profileSha256: repo.validationGates[0].profileSha256,
        dryRun: { executable: 'git', cwd, args, exitCode: dryRun.status,
          stdout: dryRun.stdout, stderr: dryRun.stderr } };
      const authority = { approved: true, authorizedBy: 'user', kind: 'native-git-revision-transfer',
        maxModelAttempts: 0, maxValidationAttempts: 1, allowSourceChanges: false, allowCommit: false,
        allowPush: true, allowDraftPR: true, allowMerge: false,
        approvedAt: now(), expiresAt: new Date(Date.now() + 60000).toISOString(),
        assignmentId: job.id, priorResultId: prior.id, baseRevision: job.base_revision,
        sourceRevision: prior.sourceRevision, configurationSha256: hash(json(s.config)),
        configuration: put('transfer-config.json', s.config),
        proposalSha256: hash(json(recovery.proposal)), filesSha256: hash(json(recovery.files)),
        validationArtifact, diagnostic: put('transfer-proof.json', proof),
        controllerSource: alReference(fileURLToPath(new URL('../src/workers.js', import.meta.url))) };
      Object.assign(recovery, { kind: authority.kind, authorization: put('transfer-authority.json', authority) });
      await assert.rejects(resumeCommittedValidation(s.config, ledger, job.id,
        { ...recovery, sourceRevision: '0'.repeat(40) }), /latest preserved model result/);
      for (const [field, value] of [['maxModelAttempts', 1], ['maxValidationAttempts', 2],
        ['allowSourceChanges', true], ['configurationSha256', '0'.repeat(64)],
        ['expiresAt', '2000-01-01T00:00:00Z']])
        await assert.rejects(resumeCommittedValidation(s.config, ledger, job.id, {
          ...recovery, authorization: put(`invalid-${field}.json`, { ...authority, [field]: value })
        }), /zero-model authority/);
      for (const field of ['controllerSource', 'configuration', 'diagnostic'])
        await assert.rejects(resumeCommittedValidation(s.config, ledger, job.id, {
          ...recovery, authorization: put(`changed-${field}.json`, {
            ...authority, [field]: { ...authority[field], sha256: '0'.repeat(64) }
          })
        }), /changed/);
      await assert.rejects(resumeCommittedValidation(s.config, ledger, job.id, {
        ...recovery, authorization: put('wrong-tip-authority.json', { ...authority,
          diagnostic: put('wrong-tip-proof.json', { ...proof, dryRun: { ...proof.dryRun,
            args: args.map(arg => arg.startsWith('--negotiation-tip=') ? `--negotiation-tip=${'0'.repeat(40)}` : arg) } }) })
      }), /dry-run proof/);
      const originalArtifact = readFileSync(validationArtifact.path);
      for (const stage of ['checkout', 'policy', 'test']) {
        const changed = JSON.parse(originalArtifact);
        changed.telemetry.validationTimings.splice(-1, 0, { id: stage });
        writeFileSync(validationArtifact.path, json(changed));
        const modified = alReference(validationArtifact.path);
        await assert.rejects(resumeCommittedValidation(s.config, ledger, job.id, {
          ...recovery, validationArtifact: modified,
          authorization: put(`executed-${stage}.json`, { ...authority, validationArtifact: modified })
        }), /pre-checkout transfer failure/);
      }
      writeFileSync(validationArtifact.path, originalArtifact);
      ledger.operation('synthetic-prior-push', job.id, 'push', {});
      await assert.rejects(resumeCommittedValidation(s.config, ledger, job.id, {
        ...recovery, authorization: put('prior-push-authority.json', authority)
      }), /unpublished original authored commit/);
      ledger.db.prepare('DELETE FROM operations WHERE id=?').run('synthetic-prior-push');
    }
    await assert.rejects(resumeCommittedValidation(s.config, ledger, job.id, {
      ...recovery, validationArtifact: { ...validationArtifact, sha256: '0'.repeat(64) }
    }), /validation evidence changed/);
    const changedFiles = recovery.files.map((file, index) =>
      index === 0 ? { ...file, sha256: '0'.repeat(64) } : file);
    let changedAuthority = recovery.authorization;
    if (recover === 'transfer') {
      const path = join(s.root, 'changed-files-authority.json');
      writeFileSync(path, json({ ...readJson(recovery.authorization.path), filesSha256: hash(json(changedFiles)) }));
      changedAuthority = alReference(path);
    }
    await assert.rejects(resumeCommittedValidation(s.config, ledger, job.id, {
      ...recovery, files: changedFiles, ...(changedAuthority ? { authorization: changedAuthority } : {})
    }), /file population or contents changed/);
    assert.equal(draftCalls, 0);
    assert.equal(modelCalls, recover === 'committed' ? 2 : 1);
    const resumed = await resumeCommittedValidation(s.config, ledger, job.id, recovery, {
      runModel: async () => assert.fail('Committed recovery must not invoke a model'),
      prepareValidation: async (config, current, repository, revision) => {
        assert.equal(revision, job.base_revision);
        assert.notEqual(revision, prior.sourceRevision);
        return prepareValidation(config, current, repository, revision);
      },
      commitChanges: async () => assert.fail('Committed recovery must not recommit'),
      createChangeFile: async () => assert.fail('Committed recovery must not regenerate a changefile'),
      createDraft: executionOptions.dispatchDependencies.createDraft
    });
    assert.equal(resumed.sourceRevision, prior.sourceRevision);
    assert.equal(hash(readFileSync(validationArtifact.path)), validationArtifact.sha256);
    assert.deepEqual(resumed.skillExecution.changedFiles, recovery.files.map(file => file.path));
    assert.equal(ledger.all('workerResult')[0].id, prior.id);
    assert.ok(ledger.status().operations.some(operation =>
      operation.kind === 'validation' && operation.id.includes(':recovery:')));
    await assert.rejects(resumeCommittedValidation(s.config, ledger, job.id, recovery),
      /Reconcile the recorded committed validation recovery/);
    executed = { state: resumed.outcome, assignment: prepared.assignment, result: resumed };
  } else if (recover) {
    await assert.rejects(acceptFilterProposerHandoff(s.config, ledger, input, executionOptions),
      /Synthetic interrupted install/);
    const prior = ledger.all('workerResult').at(-1);
    const job = ledger.job(prepared.assignment.id);
    assert.equal(job.state, 'blocked');
    assert.equal(draftCalls, 0);
    const recovery = {
      priorResultId: prior.id, proposal: preservedProposal,
      files: preservedProposal.skillExecution.changedFiles.map(path => ({
        path, sha256: hash(readFileSync(join(job.workspace, path)))
      }))
    };
    const resumed = await resumePrecommitProposal(s.config, ledger, job.id, recovery, {
      runModel: async () => assert.fail('Recovery must not repeat authoring'),
      prepareValidation: async () => ({ 'synthetic-scenario': { workspace: job.workspace } }),
      createChangeFile: async workspace => {
        writeFileSync(join(workspace, 'scenarios/change.json'), '{}\n');
        return 'scenarios/change.json';
      },
      createDraft: executionOptions.dispatchDependencies.createDraft
    });
    assert.equal(ledger.all('workerResult').length, 2);
    assert.equal(ledger.all('workerResult')[0].id, prior.id);
    assert.equal(resumed.toolUsage.used, prior.toolUsage.used);
    await assert.rejects(resumePrecommitProposal(s.config, ledger, job.id, recovery),
      /Reconcile the recorded precommit recovery/);
    executed = { state: resumed.outcome, assignment: prepared.assignment, result: resumed };
  } else if (orchestrated) {
    const status = await advanceLocalE2E(s.config, ledger, runInput, executionOptions);
    assert.equal(status.state, 'completed', json(status));
    const resumed = await advanceLocalE2E(s.config, ledger, runInput, executionOptions);
    assert.equal(resumed.state, 'completed', json(resumed));
    assert.deepEqual(resumed.result, status.result);
    executed = { state: status.result.outcome, assignment: prepared.assignment,
      result: ledger.get('workerResult', status.result.id), rsi: status.rsi };
  } else executed = await acceptFilterProposerHandoff(s.config, ledger, input, executionOptions).catch(error => {
    const validation = ledger.all('workerResult').flatMap(result => result.validation ?? [])
      .map(({ status, blockedReason, attemptCount }) => ({ status, blockedReason, attemptCount }));
    throw new Error(`Synthetic proposer failed: ${JSON.stringify(validation)}`, { cause: error });
  });
  assert.equal(modelCalls, recover === 'committed' ? 2 : 1); assert.equal(draftCalls, 1);
  ledger.put = put;
  if (!recover) {
  assert.equal(interruptedDelivery, true);
  assert.equal(executed.rsi.state, 'blocked');
  assert.deepEqual(executed.rsi.workerResultIds, [executed.result.id]);
  assert.equal(ledger.all('rsiFlowObservation').length, 0);
  const restarted = new Ledger(ledger.directory);
  try {
    const recoverable = rsiWork(s.config, restarted, 'status');
    assert.equal(recoverable.undelivered.length, 1);
    assert.equal(recoverable.undelivered[0].state, 'capture-pending');
    assert.equal(recoverable.undelivered[0].workerResultId, executed.result.id);
    const delivery = rsiWork(s.config, restarted, recoverable.undelivered[0].operation,
      recoverable.undelivered[0].request);
    assert.equal(rsiWork(s.config, restarted, 'status').undelivered.length, 0);
    const observation = restarted.get('rsiFlowObservation', delivery.observationId);
    const binding = restarted.get('rsiFlowBinding', observation.bindingId);
    assert.equal(binding.upstream.kind, orchestrated ? 'local-e2e' : 'filter-handoff');
    assert.deepEqual(orchestrated ? binding.upstream.filter.consolidation.selected.evidenceIds :
      binding.upstream.filter.retainedIds,
      prepared.filter.retainedIds);
    assert.equal(observation.payload.data.workerResult.sourceRevision, executed.result.sourceRevision);
    assert.equal(observation.payload.data.workerResult.validation[0].status, 'passed');
    const claim = { observationId: observation.id, claimId: 'synthetic-rsi-claim', executorId: 'synthetic-host' };
    rsiWork(s.config, restarted, 'claim', claim);
    const outcome = rsiWork(s.config, restarted, 'result', {
      ...claim, outcome: 'no-change',
      rationale: 'The connected synthetic collector/FILTER/proposer run does not establish an agent-system defect.'
    });
    assert.equal(outcome.state, 'finished');
    assert.equal(captureWorkerRsiOutcome(s.config, restarted, executed.result.id).nextRole, null);
  } finally { restarted.close(); }
  }
  assert.equal(modelCalls, recover === 'committed' ? 2 : 1); assert.equal(draftCalls, 1);
  assert.equal(executed.state, 'draft-pr-validated');
  assert.equal(executed.assignment.id, prepared.assignment.id);
  const output = executed.result, gate = output.validation[0];
  assert.equal(gate.sourceRevision, output.sourceRevision);
  assert.equal(output.draftPR.headRevision, output.sourceRevision);
  assert.notEqual(output.sourceRevision, qualification.baseRevision);
  assert.equal(gate.status, 'passed'); assert.equal(gate.attemptCount, 1);
  const artifact = readJson(gate.artifactRefs[0]);
  assert.equal(artifact.revision, output.sourceRevision);
  assert.match(artifact.output.stdout, /generated scenario preserves the reviewed mini-spec/);
  assert.equal(ledger.job(prepared.assignment.id).state, 'completed');
  const modelCallsBeforeReplay = modelCalls;
  if (orchestrated)
    assert.equal((await advanceLocalE2E(s.config, ledger, runInput)).state, 'completed');
  else await assert.rejects(acceptFilterProposerHandoff(s.config, ledger, input, options), /never-dispatched/);
  assert.equal(modelCalls, modelCallsBeforeReplay); assert.equal(draftCalls, 1);
  assert.equal(git(['rev-parse', 'HEAD']), qualification.baseRevision);
  assert.equal(git(['status', '--porcelain']), '');
  assert.equal(hash(readFileSync(s.ledgerPath)), sourceHash);
  assert.deepEqual(retainedReceipts(), receipts);
  assert.equal(reconcileFilterExecutionCohort(filterConfig, ledger, manifest, [bytes(reviewed)]).state,
    'complete-held');
}
const counter = async (_config, input) => ({ sha256: input.sha256, model: input.model,
  tokenizer: input.tokenizer, tokens: input.text.startsWith('{') ? JSON.parse(JSON.parse(input.text).payload).groups.length * 100 + 20 : 5 });
function setup(t, count = 3, related = false, titles = null, canonicalCapture = false,
  provenance = 'synthetic', description = null) {
  const root = mkdtempSync(join(tmpdir(), 'filter-batches-'));
  const cleanup = [];
  t.after(() => { for (const close of cleanup) close(); rmSync(root, { recursive: true, force: true }); });
  const config = configAt('pilot.example.json');
  config.stateDirectory = root; config.statePolicy.accessApproved = true;
  const sourceConfig = structuredClone(config);
  beginApp(config, { runId: 'source', dryRun: true, provenance: 'synthetic' });
  const { ledger } = openApp(config, 'source');
  const records = [];
  for (let i = 0; i < count; i++) {
    const e = evidenceEnvelope('ado', 'synthetic/issues', i + 1, '1',
      `https://example.invalid/issues/${i + 1}`, 'Synthetic query', '2026-10-09T01:00:00Z');
    e.source.provenance = provenance; e.title = titles ? titles[i] : i === 0 ? null : 'Functional issue';
    e.sourceStatus = 'Resolved';
    e.fields = { 'System.State': 'Resolved', 'Microsoft.VSTS.Common.ResolvedReason': 'Fixed',
      description: description ?? `Complete original body ${i}`, missing: null };
    if (related) e.fields.thread = { teamId: 'team', channelId: 'channel', rootId: 'root' };
    records.push(ledger.evidence(e, canonicalCapture
      ? { id: Number(e.source.recordId), rev: Number(e.source.revision), fields: e.fields, relations: e.links }
      : { completeBody: `Original capture ${i}` }, 'source:ado:created'));
  }
  const ledgerPath = join(ledger.directory, 'ledger.sqlite'); ledger.close();
  const sources = [{ ledgerPath, runId: 'source' }];
  const corpus = loadFilterCorpus(config, { format: 'stage2-sources-v1', sources });
  const verificationRef = join(root, 'verified.json');
  writeFileSync(verificationRef, '{"syntheticOnly":true}');
  config.filterBatching = { approved: true, mode: 'verified', model: 'synthetic', profile: 'synthetic', tokenizer: 'synthetic-v1',
    verifiedBy: 'test', verifiedAt: '2026-10-12T00:00:00Z', verificationRef,
    verificationSha256: hash(readFileSync(verificationRef)), contextTokens: 1000,
    maxInputTokens: 250, maxPayloadBytes: 1000000, maxBatches: 10,
    reserves: { instructions: 10, sourceAnalysis: 20, output: 100, safety: 10, requestOverhead: 5 } };
  const request = { format: 'filter-batch-request-v1', sources, instructions: 'Synthetic instructions',
    groups: records.map((r, i) => ({ id: `g${i}`, memberIds: [r.id], contextIds: [], reason: 'Independent report' })),
    groupingReview: { reviewer: 'test', reviewedAt: '2026-10-12T00:00:00Z', rationale: 'Synthetic independent reports' },
    sharing: { audience: 'synthetic', approvalRef: 'synthetic-test', materials: [] } };
  const approve = () => {
    const current = loadFilterCorpus(config, { format: 'stage2-sources-v1', sources });
    request.sharing.materials = [...new Set([...current.evidence.map(sha),
      ...current.captures.map(c => c.sha256), ...current.contexts.map(c => c.sha256),
      hash(request.instructions), sha(current.coverage.map(({ runId, coverage }) => ({ runId, coverage })))])]
      .map(sha256 => ({ sha256, eligibility: 'approved', restrictions: ['synthetic-only'] }));
  };
  approve();
  const path = join(root, 'manifest.json');
  return { config, sourceConfig, request, root, path, records, corpus, ledgerPath, approve, cleanup };
}
async function prepared(s) {
  await prepareFilterBatches(s.config, s.request, s.path, counter);
  return readJson(s.path);
}
function result(manifest, batch) {
  const payload = inputOf(batch);
  return { format: 'filter-batch-result-v1', cohortId: manifest.cohortId, batchId: batch.id,
    payloadSha256: batch.analysisPayloadSha256, status: 'complete',
    titles: { format: 'filter-title-decisions-v1', indexSha256: batch.indexSha256,
      reviewer: 'synthetic-filter', reviewedAt: '2026-10-12T00:00:00Z',
      decisions: payload.index.entries.map(e => ({ evidenceId: e.evidenceId, source: e.source,
        captureSha256: e.captureSha256, disposition: e.title ? 'needs-details' : 'no-title',
        exclusionType: null, reason: 'Full review required', titleQuote: null })) },
    details: payload.index.entries.map(e => ({ evidenceId: e.evidenceId, recordSha256: e.recordSha256,
      captureSha256: e.captureSha256, status: 'reviewed', reason: 'Synthetic complete read' })), candidates: [] };
}
function candidate(r, override = {}) {
  return { id: 'c1', evidenceIds: [r.details[0].evidenceId], repository: 'synthetic',
    sourceRevision: 'a'.repeat(40), layer: 'e2e', missingAssertion: 'Required behavior',
    existingCoverage: ['exact test assertion at source'], harness: 'qualified local harness',
    coverageStatus: 'gap', blockers: [], priority: 50, confidence: 0.8,
    rationale: 'Exact source assertion inventory supports a candidate, not confirmed defect', ...override };
}
function localFilterConfig(s) {
  s.config.filterExecutor = 'local-sdk';
  s.config.activation.review = true;
  s.config.limits.maxAiCreditsPerSession = 30;
  s.config.localFilter = { enabled: true, acceptSoftCreditLimit: true, maxRequests: 3, maxToolCalls: 5,
    timeoutMs: 10000, maxSourceBytes: 10000, maxRequestBytes: 1000000, sources: [] };
}
function localE2EInput(s) {
  return { format: 'local-e2e-v1', runId: 'synthetic-cohort',
    filter: { manifestPath: s.path, manifestSha256: hash(readFileSync(s.path)) },
    routing: { capability: 'declarative-e2e-authoring' },
    authorization: { approvedBy: 'synthetic', approvedAt: now(), approvalRef: 'synthetic-only',
      deadlineAt: new Date(Date.now() + 600000).toISOString(), maxFilterRequests: s.config.localFilter.maxRequests,
      maxProposers: 1, maxProposerAiCredits: 1,
      authorizeCommit: true, authorizePush: true, authorizeDraftPR: true } };
}
test('local SDK FILTER refuses an expired recurring authority before creating a model session', async t => {
  const s = setup(t); localFilterConfig(s);
  const manifest = await prepared(s), batch = manifest.batches[0];
  const path = join(s.root, 'expired-authority.json'), planSha256 = 'd'.repeat(64);
  writeFileSync(path, JSON.stringify({ format: 'al-recurring-authorization-v1', planSha256,
    approvedAt: '2000-01-01T00:00:00Z', expiresAt: '2001-01-01T00:00:00Z', allowModels: true }));
  const repo = s.config.repositories[0];
  s.config.runtime.executionAuthorization = { reference: { path, sha256: hash(readFileSync(path)) },
    repoId: repo.id, baseRevision: repo.baseRef, planSha256 };
  const ledger = new Ledger(s.root); s.cleanup.push(() => ledger.close());
  let sessions = 0;
  const outcome = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id, {
    connect: async (_config, _cwd, action) => action({
      createSession: async () => { sessions++; throw Error('Expired session must not be created'); }
    })
  });
  assert.equal(sessions, 0);
  assert.equal(outcome.state, 'blocked');
  assert.equal(outcome.terminal.error.code, 'blocked-authorization');
  assert.equal(outcome.terminal.sessionId, null);
});
function syntheticLocalConnection(batch, reviewed, behavior = async tools => {
  await tools.find(tool => tool.name === 'pilot_filter_finish').handler({ result: reviewed });
}) {
  return async (config, _cwd, action, existingLogin) => {
    assert.equal(existingLogin, config.localFilter.useExistingLogin === true);
    return action({
    createSession: async options => {
      let listener;
      assert.equal(options.onPermissionRequest().kind, 'denied-by-rules');
      assert.deepEqual(options.tools.map(tool => tool.name), ['pilot_filter_source',
        ...(config.localFilter.evidencePaging ? ['pilot_filter_evidence'] : []), 'pilot_filter_finish']);
      assert.equal(options.skipCustomInstructions, true);
      assert.equal(options.enableFileHooks, false);
      assert.equal(options.enableSkills, false);
      assert.equal(options.enableHostGitOperations, false);
      assert.equal(options.manageScheduleEnabled, false);
      assert.deepEqual(options.memory, { enabled: false });
      assert.equal(options.systemMessage.sections.environment_context.action, 'remove');
      assert.ok(options.systemMessage.content.includes(`at most ${config.localFilter.maxToolCalls} total tool calls`));
      assert.ok(options.systemMessage.content.includes('repoId is an exact configured ID, never a Git path'));
      assert.ok(options.systemMessage.content.includes('Offsets count bytes, not characters or lines'));
      if (config.localFilter.retry?.review)
        assert.ok(options.systemMessage.content.includes(config.localFilter.retry.review.reason));
      return {
        sessionId: `synthetic-${batch.id}${config.localFilter.retry ? `-retry-${sha(config.localFilter.retry)}` : ''}`,
        on: callback => { listener = callback; return () => {}; },
        rpc: { tools: { initializeAndValidate: async () => {} },
          options: { update: async value => {
            assert.deepEqual(value.installedPlugins, []);
            assert.deepEqual(value.includedBuiltinSkills, []);
          } } },
        sendAndWait: async input => {
          if (config.localFilter.evidencePaging) {
            const envelope = JSON.parse(input.prompt);
            assert.equal(envelope.format, 'paged-filter-batch-input-v1');
            assert.equal(envelope.originalPayloadSha256, batch.payloadSha256);
            assert.deepEqual(envelope.index, inputOf(batch).index);
          } else assert.equal(input.prompt, batch.payload);
          listener({ id: 'synthetic-event', type: 'assistant.turn_start' });
          await behavior(options.tools, input, options);
        },
        disconnect: async () => {}
      };
    }
    });
  };
}
for (const boundary of ['connect', 'session-create', 'unexpired']) {
  test(`standalone AL FILTER enforces its allocation at ${boundary}`, async t => {
    const s = setup(t); localFilterConfig(s);
    const repo = s.config.repositories[0];
    repo.baseRef = 'a'.repeat(40);
    const manifest = await prepared(s), batch = manifest.batches[0], reviewed = result(manifest, batch);
    const started = Date.now();
    let time = started, creations = 0, submissions = 0;
    t.mock.method(Date, 'now', () => time);
    const allocation = join(s.root, 'standalone-allocation.json');
    writeFileSync(allocation, JSON.stringify({
      format: 'al-e2e-model-allocation-v1', approvedBy: 'parent', model: 'gpt-6-luna',
      repoId: repo.id, baseRevision: repo.baseRef, runDirectory: s.root,
      maxTotalSessions: 30, priorActualSessions: 0, maxAdditionalSessions: 1,
      purposes: ['filter'], allowPublication: false,
      deadlineAt: new Date(started + 1000).toISOString()
    }));
    bindAlModelExecution(s.config, alReference(allocation), s.root, 1, 'filter');
    const ledger = new Ledger(s.root); s.cleanup.push(() => ledger.close());
    const native = syntheticLocalConnection(batch, reviewed);
    const outcome = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id, {
      connect: (config, cwd, action, login) => native(config, cwd, async client => {
        if (boundary === 'connect') time += 1001;
        const create = client.createSession;
        client.createSession = async options => {
          creations++;
          const session = await create(options), send = session.sendAndWait;
          if (boundary === 'session-create') time += 1001;
          session.sendAndWait = async (input, timeout) => {
            submissions++;
            assert.equal(timeout, 1000);
            return send(input);
          };
          return session;
        };
        return action(client);
      }, login)
    });
    assert.equal(outcome.state, boundary === 'unexpired' ? 'complete-held' : 'blocked');
    if (boundary !== 'unexpired') assert.equal(outcome.terminal.error.code, 'blocked-authorization');
    assert.equal(creations, boundary === 'connect' ? 0 : 1);
    assert.equal(submissions, boundary === 'unexpired' ? 1 : 0);
  });
}
async function reviewDeliveredEvidence(tools, prompt) {
  const envelope = JSON.parse(prompt);
  const read = tools.find(tool => tool.name === 'pilot_filter_evidence');
  const records = [];
  let deliveredBytes = 0, pages = 0;
  for (const [index, entry] of envelope.index.entries.entries()) {
    let offset = 0, content = '';
    do {
      const response = await read.handler({ index, offset });
      const page = JSON.parse(response);
      if (page.state === 'rejected') return { rejected: page, deliveredBytes, pages };
      deliveredBytes += Buffer.byteLength(response);
      pages++;
      assert.equal(page.revision, envelope.analysisPayloadSha256);
      content += page.content;
      offset = page.nextOffset;
    } while (offset !== null);
    const record = JSON.parse(content);
    assert.equal(record.evidence.id, entry.evidenceId);
    assert.equal(sha(record.evidence), entry.recordSha256);
    assert.ok(record.captures.length > 0);
    records.push(record);
  }
  return { deliveredBytes, pages, result: {
    format: 'filter-batch-result-v1', cohortId: envelope.cohortId, batchId: envelope.batchId,
    payloadSha256: envelope.analysisPayloadSha256, status: 'complete',
    titles: { format: 'filter-title-decisions-v1', indexSha256: envelope.indexSha256,
      reviewer: 'synthetic-paged-reader', reviewedAt: now(),
      decisions: envelope.index.entries.map(entry => ({
        evidenceId: entry.evidenceId, source: entry.source, captureSha256: entry.captureSha256,
        disposition: entry.title ? 'needs-details' : 'no-title', exclusionType: null,
        reason: 'Read the delivered original record', titleQuote: null
      })) },
    details: records.map((record, index) => ({
      evidenceId: record.evidence.id, recordSha256: sha(record.evidence),
      captureSha256: envelope.index.entries[index].captureSha256,
      status: 'reviewed', reason: 'Read the delivered original evidence and captures through EOF'
    })), candidates: []
  } };
}
test('local SDK FILTER budget preflight never raises the configured credit ceiling', async t => {
  const s = setup(t); localFilterConfig(s);
  s.config.limits.maxAiCreditsPerSession = 1;
  const preflight = localFilterPreflight(s.config);
  assert.equal(preflight.state, 'action-required-budget');
  assert.equal(preflight.runtimeMinimumCredits, 30);
  assert.equal(s.config.limits.maxAiCreditsPerSession, 1);
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  let called = false;
  const outcome = await executeLocalFilterBatch(s.config, ledger, null, 'unused',
    { connect: async () => { called = true; } });
  assert.equal(outcome.state, 'action-required-budget');
  assert.equal(called, false);
  assert.equal(ledger.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name='local_filter_receipts'").get().n, 0);
});
test('local SDK FILTER requires explicit soft-credit-limit acceptance before invocation', async t => {
  const s = setup(t); localFilterConfig(s);
  s.config.localFilter.acceptSoftCreditLimit = false;
  let called = false;
  const outcome = await executeLocalFilterBatch(s.config, {}, {}, 'unstarted',
    { connect: async () => { called = true; } });
  assert.equal(outcome.state, 'action-required-budget');
  assert.match(outcome.reason, /soft/);
  assert.equal(called, false);
  assert.equal(outcome.modelInvoked, false);
});
test('local SDK FILTER paginates large UTF-8 responses without hidden runtime spills', async t => {
  const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
  s.config.localFilter.maxToolCalls = 40;
  const revision = 'a'.repeat(40);
  s.config.repositories = [{ id: 'synthetic', referenceCheckout: s.root }];
  s.config.localFilter.sources = [{ repoId: 'synthetic', revision }];
  const text = 'line \u4e2d\u6587 "quoted" \n'.repeat(3000);
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  const connect = syntheticLocalConnection(batch, reviewed, async tools => {
    const invalidOffset = JSON.parse(await tools[0].handler({
      repoId: 'synthetic', action: 'read', path: 'large.ts', offset: 6
    }));
    assert.equal(invalidOffset.state, 'rejected');
    assert.equal(invalidOffset.error.code, 'invalid-record');
    assert.match(invalidOffset.error.message, /UTF-8 boundary/);
    let offset = 0, restored = '', pages = 0;
    do {
      const response = await tools[0].handler({ repoId: 'synthetic', action: 'read', path: 'large.ts', offset });
      assert.ok(Buffer.byteLength(response) <= 10000);
      const page = JSON.parse(response);
      if (page.hasMore) assert.ok(Buffer.byteLength(response) >= 9992,
        'A full UTF-8 page should use the available response budget rather than halve it');
      assert.equal(page.offset, offset);
      assert.equal(page.sourceSha256, hash(text));
      assert.equal(page.sha256, hash(page.content));
      assert.equal(page.totalBytes, Buffer.byteLength(text));
      assert.equal(page.hasMore, page.nextOffset !== null);
      restored += page.content; pages++;
      if (pages === 1) {
        const feedback = JSON.parse(await tools[1].handler({ result: reviewed }));
        assert.equal(feedback.state, 'rejected');
        assert.match(feedback.error.message, /Incomplete pinned source reads/);
        assert.match(feedback.error.message, new RegExp(`"offset":${page.nextOffset}`));
        assert.equal(ledger.db.prepare(
          "SELECT COUNT(*) n FROM local_filter_receipts WHERE kind='analysis'").get().n, 0);
      }
      if (page.nextOffset !== null) assert.ok(page.nextOffset > offset);
      offset = page.nextOffset;
    } while (offset !== null);
    assert.ok(pages > 1);
    assert.equal(restored, text);
    await tools[1].handler({ result: reviewed });
  });
  const executed = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id,
    { connect, execute: async (_exe, args) => ({ stdout: args.includes('rev-parse') ? revision : text }) });
  assert.equal(executed.state, 'complete-held', json(executed));
});
test('local SDK FILTER detects missing middle pages and refuses empty-candidate completion', async t => {
  const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
  s.config.localFilter.maxToolCalls = 20;
  const revision = 'a'.repeat(40), text = 'source line\n'.repeat(2500);
  s.config.repositories = [{ id: 'synthetic', referenceCheckout: s.root }];
  s.config.localFilter.sources = [{ repoId: 'synthetic', revision }];
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  assert.deepEqual(reviewed.candidates, []);
  const connect = syntheticLocalConnection(batch, reviewed, async tools => {
    const readPage = async (path, offset = 0) =>
      JSON.parse(await tools[0].handler({ repoId: 'synthetic', action: 'read', path, offset }));
    const first = await readPage('large.ts');
    const tail = await readPage('large.ts', Buffer.byteLength(text) - 2000);
    assert.equal(tail.hasMore, false);
    assert.equal((await readPage('small.ts')).hasMore, false);
    const rejected = JSON.parse(await tools[1].handler({ result: reviewed }));
    assert.equal(rejected.state, 'rejected');
    assert.match(rejected.error.message, /large\.ts/);
    assert.match(rejected.error.message, new RegExp(`"offset":${first.nextOffset}`));
    let offset = first.nextOffset;
    while (offset !== null && offset < tail.offset) offset = (await readPage('large.ts', offset)).nextOffset;
    assert.equal(JSON.parse(await tools[1].handler({ result: reviewed })).state, 'held');
  });
  const outcome = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id, {
    connect, execute: async (_exe, args) => ({
      stdout: args.includes('rev-parse') ? revision : args.at(-1).endsWith('small.ts') ? 'complete' : text
    })
  });
  assert.equal(outcome.state, 'complete-held', json(outcome));
  const reconciled = reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(reviewed)]);
  assert.equal(reconciled.state, 'complete-held');
  assert.equal(reconciled.batches[0].sourceReadPolicy, 'complete-opened-source-files-v1');
  assert.ok(reconciled.batches[0].sourceReads.every(file => file.complete));
});
test('local SDK FILTER reads 100 KB within eleven bounded source pages', async t => {
  const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
  s.config.localFilter.maxToolCalls = 12;
  const revision = 'a'.repeat(40), text = 'a'.repeat(100000);
  s.config.repositories = [{ id: 'synthetic', referenceCheckout: s.root }];
  s.config.localFilter.sources = [{ repoId: 'synthetic', revision }];
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  let pages = 0, restored = '';
  const connect = syntheticLocalConnection(batch, reviewed, async tools => {
    let offset = 0;
    do {
      const response = await tools[0].handler({ repoId: 'synthetic', action: 'read', path: 'large.ts', offset });
      const page = JSON.parse(response);
      assert.notEqual(page.state, 'rejected', response);
      assert.ok(Buffer.byteLength(response) <= 10000);
      restored += page.content; pages++; offset = page.nextOffset;
    } while (offset !== null);
    assert.equal(JSON.parse(await tools[1].handler({ result: reviewed })).state, 'held');
  });
  const outcome = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id, {
    connect, execute: async (_exe, args) => ({ stdout: args.includes('rev-parse') ? revision : text })
  });
  assert.equal(outcome.state, 'complete-held');
  assert.equal(restored, text);
  assert.ok(pages <= 11);
  assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(outcome.result)]).state, 'complete-held');
});
test('local SDK FILTER source coverage rejects unknown, inconsistent and gapped page receipts', () => {
  const page = (offset, endOffset) => ({
    action: 'read', repoId: 'synthetic', revision: 'a'.repeat(40), path: 'source.ts',
    sourceSha256: hash('abcdef'), sha256: hash('abcdef'.slice(offset, endOffset)),
    totalBytes: 6, offset, endOffset, hasMore: endOffset < 6,
    nextOffset: endOffset < 6 ? endOffset : null
  });
  const complete = inspectLocalFilterSourceReads([page(3, 6), page(0, 3), page(0, 3)]);
  assert.equal(complete[0].complete, true);
  assert.equal(complete[0].contiguousBytes, 6);
  for (const observations of [
    [page(0, 2), page(4, 6)],
    [page(6, 6)],
    [page(0, 3), { ...page(3, 6), sourceSha256: hash('other source') }],
    [{ ...page(0, 6), nextOffset: 6 }],
    [{ action: 'read', repoId: 'synthetic', revision: 'a'.repeat(40), path: 'source.ts', sha256: hash('abcdef') }]
  ]) assert.equal(inspectLocalFilterSourceReads(observations)[0].complete, false);
  assert.deepEqual(inspectLocalFilterSourceReads([{ ...page(0, 2), action: 'list' }]), []);
});
test('local SDK FILTER reconciliation independently rejects incomplete historical source receipts', async t => {
  const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  const executed = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id,
    { connect: syntheticLocalConnection(batch, reviewed) });
  assert.equal(executed.state, 'complete-held');
  const originalTerminal = ledger.db.prepare(
    "SELECT body FROM local_filter_receipts WHERE task_id=? AND kind='terminal'").get(batch.id).body;
  ledger.db.prepare('INSERT INTO local_filter_receipts VALUES(?,?,?)').run(batch.id,
    'source:historical-incomplete', json({
      repoId: 'synthetic', revision: 'a'.repeat(40), path: 'partial.ts', action: 'read',
      sourceSha256: hash('whole source'), sha256: hash('whole'), totalBytes: 12,
      offset: 0, endOffset: 5, hasMore: true, nextOffset: 5
    }));
  const checked = reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(reviewed)]);
  assert.equal(checked.structuralState, 'complete-held');
  assert.equal(checked.state, 'blocked');
  assert.equal(checked.batches[0].sourceReads[0].contiguousBytes, 5);
  assert.equal(checked.batches[0].sourceReads[0].complete, false);
  assert.equal(ledger.db.prepare(
    "SELECT body FROM local_filter_receipts WHERE task_id=? AND kind='terminal'").get(batch.id).body,
  originalTerminal);
});
test('local SDK FILTER counts returned pages and permanently blocks cumulative source-budget violations', async t => {
  const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
  s.config.localFilter.maxRequestBytes = 65536;
  s.config.localFilter.maxToolCalls = 20;
  const revision = 'a'.repeat(40), text = 'source line\n'.repeat(20000);
  s.config.repositories = [{ id: 'synthetic', referenceCheckout: s.root }];
  s.config.localFilter.sources = [{ repoId: 'synthetic', revision }];
  assert.ok(Buffer.byteLength(text) > s.config.localFilter.maxRequestBytes);
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  let pages = 0;
  const connect = syntheticLocalConnection(batch, reviewed, async tools => {
    const request = JSON.parse(ledger.db.prepare(
      "SELECT body FROM local_filter_receipts WHERE kind='request'").get().body);
    let deliveredBytes = request.requestBytes, offset = 0, rejected = false;
    for (let call = 0; call < 18; call++) {
      const response = await tools[0].handler({ repoId: 'synthetic', action: 'read', path: 'large.ts', offset });
      const page = JSON.parse(response);
      if (page.state === 'rejected') {
        assert.equal(page.error.code, 'blocked-budget');
        assert.match(page.error.message, /Cumulative FILTER source input/);
        rejected = true;
        break;
      }
      deliveredBytes += Buffer.byteLength(response);
      assert.ok(deliveredBytes <= s.config.localFilter.maxRequestBytes);
      assert.equal(page.hasMore, true);
      offset = page.nextOffset;
      pages++;
    }
    assert.ok(pages > 0, 'A large source must remain readable in budgeted pages');
    assert.equal(rejected, true);
    await tools[1].handler({ result: reviewed });
  });
  const executed = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id,
    { connect, execute: async (_exe, args) => ({ stdout: args.includes('rev-parse') ? revision : text }) });
  assert.equal(executed.state, 'blocked');
  assert.equal(executed.terminal.analysisPassed, false);
  assert.equal(executed.terminal.policyViolations.length, 1);
  assert.equal(executed.terminal.policyViolations[0].code, 'blocked-budget');
  assert.equal(ledger.db.prepare(
    "SELECT COUNT(*) n FROM local_filter_receipts WHERE kind LIKE 'source:%'").get().n, pages);
  assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(reviewed)]).state, 'blocked');
});
test('local SDK FILTER preserves nonpaged prompt accounting and original payload provenance', async t => {
  const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  const connect = syntheticLocalConnection(batch, reviewed, async (tools, { prompt }, options) => {
    const finish = tools.find(tool => tool.name === 'pilot_filter_finish');
    const request = JSON.parse(ledger.db.prepare(
      "SELECT body FROM local_filter_receipts WHERE kind='request'").get().body);
    assert.equal(prompt, batch.payload);
    assert.equal(request.requestBytes, Buffer.byteLength(batch.payload) +
      Buffer.byteLength(options.systemMessage.content) + Buffer.byteLength(json(finish.parameters)));
    assert.equal(request.payloadSha256, hash(prompt));
    assert.equal(JSON.parse(await finish.handler({ result: reviewed })).state, 'held');
  });
  const outcome = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id, { connect });
  assert.equal(outcome.state, 'complete-held', json(outcome));
});
test('local SDK FILTER returns bounded validation feedback and permits same-session correction', async t => {
  const s = setup(t, 1, false, ['Functional issue']), manifest = await prepared(s); localFilterConfig(s);
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  const connect = syntheticLocalConnection(batch, reviewed, async tools => {
    const invalid = structuredClone(reviewed);
    invalid.titles.decisions[0].exclusionType = 'telemetry_only';
    const feedback = await tools[1].handler({ result: invalid });
    assert.ok(Buffer.byteLength(feedback) < 3000);
    const rejected = JSON.parse(feedback);
    assert.equal(rejected.state, 'rejected');
    assert.match(rejected.error.message, /Retained decisions cannot assert title exclusions/);
    invalid.titles.decisions[0].disposition = 'screen-out';
    invalid.titles.decisions[0].titleQuote = 'Not present in the original title';
    const quoteFeedback = JSON.parse(await tools[1].handler({ result: invalid }));
    assert.match(quoteFeedback.error.message, /exact title quote/);
    assert.ok(quoteFeedback.error.message.includes(invalid.titles.decisions[0].evidenceId));
    assert.equal(JSON.parse(await tools[1].handler({ result: reviewed })).state, 'held');
  });
  const executed = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id, { connect });
  assert.equal(executed.state, 'complete-held', json(executed));
  assert.equal(ledger.db.prepare("SELECT COUNT(*) n FROM local_filter_receipts WHERE kind LIKE 'error:%'").get().n, 2);
  assert.equal(ledger.db.prepare("SELECT COUNT(*) n FROM local_filter_receipts WHERE kind='request'").get().n, 1);
});
test('local SDK FILTER rejects malformed source calls before access without poisoning corrected calls', async t => {
  const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
  s.config.localFilter.maxToolCalls = 10;
  const revision = 'a'.repeat(40);
  s.config.repositories = [{ id: 'synthetic', referenceCheckout: s.root }];
  s.config.localFilter.sources = [{ repoId: 'synthetic', revision }];
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  let reads = 0;
  const connect = syntheticLocalConnection(batch, reviewed, async tools => {
    for (const input of [null, { repoId: 'functions.pilot_filter_source', commentary: 'analysis' },
      { repoId: 'synthetic', action: 'execute', path: 'source.ts' },
      { repoId: 'synthetic', action: 'read', path: 'source.ts', offset: '0' }]) {
      const rejected = JSON.parse(await tools[0].handler(input));
      assert.equal(rejected.error.code, 'invalid-record');
      assert.equal(reads, 0);
    }
    const read = JSON.parse(await tools[0].handler({ repoId: 'synthetic', action: 'read', path: 'source.ts' }));
    assert.equal(read.content, 'source');
    assert.equal(JSON.parse(await tools[1].handler({ result: reviewed })).state, 'held');
  });
  const outcome = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id, {
    connect, execute: async (_exe, args) => {
      if (args.includes('rev-parse')) return { stdout: revision };
      reads++; return { stdout: 'source' };
    }
  });
  assert.equal(outcome.state, 'complete-held');
  assert.equal(reads, 1);
  assert.equal(ledger.db.prepare("SELECT COUNT(*) n FROM local_filter_receipts WHERE kind LIKE 'error:%'").get().n, 4);
  assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(reviewed)]).state, 'complete-held');
});
test('local SDK FILTER diagnoses wrong repo IDs and Git paths with immutable bounded safe request context', async t => {
  const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
  s.config.localFilter.maxToolCalls = 20;
  const revision = 'a'.repeat(40);
  s.config.repositories = [{ id: 'synthetic', referenceCheckout: s.root }];
  s.config.localFilter.sources = [{ repoId: 'synthetic', revision }];
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  let reads = 0;
  const connect = syntheticLocalConnection(batch, reviewed, async tools => {
    assert.deepEqual(tools[0].parameters.properties.repoId.enum, ['synthetic']);
    assert.match(tools[0].description, /Allowed repoId values: \["synthetic"\]/);
    assert.match(tools[0].description, /nextOffset=null \(EOF\)/);
    const wrongRepo = JSON.parse(await tools[0].handler({
      repoId: 'src/product.ts', action: 'read', path: 'src/product.ts', offset: 0
    }));
    assert.equal(wrongRepo.error.code, 'blocked-scope');
    assert.match(wrongRepo.error.message, /Expected one of \["synthetic"\]/);
    assert.deepEqual(wrongRepo.sourceRequest,
      { repoId: 'src/product.ts', action: 'read', path: 'src/product.ts', offset: 0 });
    for (const path of ['C:\\repo\\source.ts', '/src/source.ts', '../source.ts',
      '.', '.git/config', 'src//source.ts', 'src/\tsource.ts']) {
      const response = JSON.parse(await tools[0].handler({ repoId: 'synthetic', action: 'read', path }));
      assert.equal(response.error.code, 'blocked-scope');
      assert.match(response.error.message, /Expected a Git-relative path/);
    }
    const oversized = JSON.parse(await tools[0].handler({
      repoId: '\u0000\u001b\u0085\u202e' + 'r'.repeat(4000), action: 'a'.repeat(100),
      path: '\r\n\t' + 'p'.repeat(4000), offset: { secret: 'not-retained' },
      query: 'private literal not-retained', providerDiagnostics: 'not-retained'
    }));
    assert.equal(oversized.error.code, 'invalid-record');
    assert.deepEqual(Object.keys(oversized.sourceRequest).sort(), ['action', 'path', 'repoId']);
    assert.equal(oversized.sourceRequest.repoId.length, 256);
    assert.equal(oversized.sourceRequest.path.length, 512);
    assert.equal(oversized.sourceRequest.action.length, 32);
    assert.doesNotMatch(json(oversized.sourceRequest), /not-retained|private literal/);
    for (const value of Object.values(oversized.sourceRequest))
      assert.doesNotMatch(value, /[\p{Cc}\p{Cf}]/u);
    assert.ok(Buffer.byteLength(json(oversized)) < 3000);
    assert.equal(reads, 0);
    const corrected = JSON.parse(await tools[0].handler({
      repoId: 'synthetic', action: 'read', path: 'source.ts'
    }));
    assert.equal(corrected.content, 'source');
    await tools[1].handler({ result: reviewed });
  });
  const outcome = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id, {
    connect, execute: async (_exe, args) => {
      if (args.includes('rev-parse')) return { stdout: revision };
      reads++; return { stdout: 'source' };
    }
  });
  assert.equal(outcome.state, 'blocked', 'Corrected calls cannot erase permanent scope violations');
  assert.equal(reads, 1);
  assert.equal(outcome.terminal.policyViolations.length, 8);
  const errors = ledger.db.prepare(
    "SELECT body FROM local_filter_receipts WHERE kind LIKE 'error:%'").all().map(row => JSON.parse(row.body));
  assert.equal(errors.length, 10);
  assert.deepEqual(errors[0].sourceRequest,
    { repoId: 'src/product.ts', action: 'read', path: 'src/product.ts', offset: 0 });
  assert.doesNotMatch(json(errors), /not-retained|private literal/);
  assert.ok(errors.every(error => Buffer.byteLength(json(error)) < 3000));
  assert.throws(() => ledger.db.exec("UPDATE local_filter_receipts SET body='{}' WHERE kind LIKE 'error:%'"), /immutable/);
  assert.throws(() => ledger.db.exec("DELETE FROM local_filter_receipts WHERE kind LIKE 'error:%'"), /immutable/);
  await assert.rejects(executeLocalFilterBatch(s.config, ledger, manifest, batch.id), /Existing FILTER/);
});
test('local SDK FILTER bounds provider failures and recovers byte offsets and EOF without exposing diagnostics', async t => {
  const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
  s.config.localFilter.maxToolCalls = 12;
  const revision = 'a'.repeat(40), text = '中😀\n', totalBytes = Buffer.byteLength(text);
  s.config.repositories = [{ id: 'synthetic', referenceCheckout: s.root }];
  s.config.localFilter.sources = [{ repoId: 'synthetic', revision }];
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  const connect = syntheticLocalConnection(batch, reviewed, async tools => {
    const unavailable = JSON.parse(await tools[0].handler({
      repoId: 'synthetic', action: 'read', path: 'missing.ts'
    }));
    assert.equal(unavailable.error.code, 'unavailable');
    assert.match(unavailable.error.message, /pinned revision/);
    assert.deepEqual(unavailable.sourceRequest, { repoId: 'synthetic', action: 'read', path: 'missing.ts' });
    for (const offset of [1, 4, totalBytes + 1, -1, null]) {
      const invalid = JSON.parse(await tools[0].handler({
        repoId: 'synthetic', action: 'read', path: 'source.ts', offset
      }));
      assert.equal(invalid.error.code, 'invalid-record');
      assert.match(invalid.error.message, /UTF-8/);
      assert.match(invalid.error.message, /EOF/);
      assert.equal(invalid.sourceRequest.offset, offset);
      if (offset >= 0 && offset !== null) assert.match(invalid.error.message, /within 0\.\.8 bytes/);
    }
    const eof = JSON.parse(await tools[0].handler({
      repoId: 'synthetic', action: 'read', path: 'source.ts', offset: totalBytes
    }));
    assert.equal(eof.content, '');
    assert.equal(eof.hasMore, false);
    assert.equal(eof.nextOffset, null);
    assert.match(JSON.parse(await tools[1].handler({ result: reviewed })).error.message,
      /Incomplete pinned source reads/);
    const complete = JSON.parse(await tools[0].handler({
      repoId: 'synthetic', action: 'read', path: 'source.ts', offset: 0
    }));
    assert.equal(complete.content, text);
    assert.equal(complete.endOffset, totalBytes);
    assert.equal(complete.nextOffset, null);
    assert.equal(JSON.parse(await tools[1].handler({ result: reviewed })).state, 'held');
  });
  const outcome = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id, {
    connect, execute: async (_exe, args) => {
      if (args.includes('rev-parse')) return { stdout: revision };
      if (args.at(-1).endsWith(':missing.ts'))
        throw Object.assign(new Error('private-provider-diagnostics'.repeat(500)), {
          name: 'private-provider-name', stderr: 'credential-not-retained', stdout: 'private output'
        });
      return { stdout: text };
    }
  });
  assert.equal(outcome.state, 'complete-held', json(outcome));
  const errors = ledger.db.prepare("SELECT body FROM local_filter_receipts WHERE kind LIKE 'error:%'").all();
  assert.doesNotMatch(json(errors), /private-provider|credential-not-retained|private output/);
  assert.equal(outcome.terminal.toolCalls, 10);
});
test('local SDK FILTER describes absent, original and cohort-selected retry attempts without mutation', async t => {
  const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  const schemaBefore = ledger.db.prepare('SELECT name FROM sqlite_master ORDER BY name').all();
  assert.deepEqual(describeLocalFilterAttempt(s.config, ledger, batch.id),
    { attemptId: batch.id, request: null, terminal: null, result: null });
  assert.deepEqual(ledger.db.prepare('SELECT name FROM sqlite_master ORDER BY name').all(), schemaBefore);
  const first = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id,
    { connect: syntheticLocalConnection(batch, reviewed, async () => {}) });
  const original = describeLocalFilterAttempt(s.config, ledger, batch.id);
  assert.equal(original.attemptId, batch.id);
  assert.equal(original.result, null);
  assert.deepEqual(original.terminal, first.terminal);
  assert.equal(original.request.batchId, batch.id);
  const retry = { batchId: batch.id, previousAttemptId: batch.id,
    previousTerminalSha256: sha(first.terminal), authorizationRef: 'synthetic-status-retry',
    execution: { maxToolCalls: 6 } };
  s.config.localFilter.cohortRetries = [retry];
  assert.deepEqual(describeLocalFilterAttempt(s.config, ledger, batch.id),
    { attemptId: `${batch.id}-retry-${sha(retry)}`, request: null, terminal: null, result: null });
  const second = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id,
    { connect: syntheticLocalConnection(batch, reviewed) });
  assert.equal(second.state, 'complete-held', json(second));
  const rows = ledger.db.prepare('SELECT task_id,kind,body FROM local_filter_receipts ORDER BY task_id,kind').all();
  const described = describeLocalFilterAttempt(s.config, ledger, batch.id);
  assert.equal(described.attemptId, second.terminal.attemptId);
  assert.deepEqual(described.terminal, second.terminal);
  assert.deepEqual(described.result, second.result);
  assert.deepEqual(described.request.retry, retry);
  described.result.details[0].reason = 'Local copy only';
  assert.deepEqual(describeLocalFilterAttempt(s.config, ledger, batch.id).result, second.result);
  assert.deepEqual(ledger.db.prepare(
    'SELECT task_id,kind,body FROM local_filter_receipts ORDER BY task_id,kind').all(), rows);
  delete s.config.localFilter.cohortRetries;
  assert.deepEqual(describeLocalFilterAttempt(s.config, ledger, batch.id), original);
  s.config.localFilter.retry = retry;
  assert.equal(describeLocalFilterAttempt(s.config, ledger, batch.id).attemptId, second.terminal.attemptId);
  s.config.localFilter.retry.previousTerminalSha256 = 'invalid';
  assert.throws(() => describeLocalFilterAttempt(s.config, ledger, batch.id), /Explicit FILTER retry/);
});
test('local SDK FILTER reconciles actual callback receipts for the complete synthetic cohort', async t => {
  const s = setup(t), manifest = await prepared(s); localFilterConfig(s);
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const outputs = [];
  for (const batch of manifest.batches) {
    const reviewed = result(manifest, batch);
    const executed = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id,
      { connect: syntheticLocalConnection(batch, reviewed) });
    assert.equal(executed.state, 'complete-held', json(executed));
    outputs.push(bytes(executed.result));
  }
  const checked = reconcileFilterExecutionCohort(s.config, ledger, manifest, outputs);
  assert.equal(checked.state, 'complete-held');
  assert.equal(checked.executor, 'local-sdk');
  assert.equal(checked.dispatchAllowed, false);
  assert.equal(checked.semanticReadingProvenByHelper, false);
  assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, outputs.slice(1)).state, 'blocked');
  const changed = JSON.parse(outputs[0]); changed.details[0].reason = 'Different reasoning';
  assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest,
    [bytes(changed), ...outputs.slice(1)]).state, 'blocked');
  assert.throws(() => ledger.db.exec("UPDATE local_filter_receipts SET body='{}'"), /immutable/);
  await assert.rejects(executeLocalFilterBatch(s.config, ledger, manifest, manifest.batches[0].id), /Existing FILTER/);
});
test('local SDK FILTER persists missing completion and source-policy violations without retry', async t => {
  for (const violation of [false, true]) {
    const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
    const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
    const batch = manifest.batches[0], reviewed = result(manifest, batch);
    const connect = syntheticLocalConnection(batch, reviewed, async tools => {
      if (violation) {
        const rejection = JSON.parse(await tools[0].handler({ repoId: 'unapproved', action: 'read', path: '../secret' }));
        assert.equal(rejection.state, 'rejected');
        assert.match(rejection.error.message, /outside/);
        await tools[1].handler({ result: reviewed });
      }
    });
    const outcome = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id, { connect });
    assert.equal(outcome.state, 'blocked');
    assert.equal(outcome.terminal.analysisPassed, false);
    assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(reviewed)]).state, 'blocked');
    await assert.rejects(executeLocalFilterBatch(s.config, ledger, manifest, batch.id, { connect }), /Existing FILTER/);
  }
});
test('local SDK FILTER rejects uninspected source candidates and over-budget requests', async t => {
  const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  reviewed.candidates.push(candidate(reviewed));
  const outcome = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id,
    { connect: syntheticLocalConnection(batch, reviewed) });
  assert.equal(outcome.state, 'blocked');
  s.config.localFilter.maxRequestBytes = 1;
  await assert.rejects(executeLocalFilterBatch(s.config, ledger, manifest, batch.id), /byte ceiling/);
});
test('local SDK FILTER recovers missing files and journals concurrent pinned Git reads, not working source', async t => {
  const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
  const checkout = join(s.root, 'reference'); mkdirSync(checkout);
  const git = args => {
    const output = spawnSync('git', ['-c', 'core.hooksPath=.git/no-hooks',
      '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args],
    { cwd: checkout, encoding: 'utf8' });
    assert.equal(output.status, 0, output.stderr); return output.stdout.trim();
  };
  git(['init', '--quiet']);
  writeFileSync(join(checkout, 'source.txt'), 'committed source\n');
  git(['add', '.']);
  git(['-c', 'user.name=Synthetic', '-c', 'user.email=synthetic@example.invalid',
    'commit', '--quiet', '-m', 'Synthetic pinned source']);
  const revision = git(['rev-parse', 'HEAD']);
  writeFileSync(join(checkout, 'source.txt'), 'uncommitted source must not be used\n');
  s.config.repositories = [{ id: 'synthetic', referenceCheckout: checkout }];
  s.config.localFilter.sources = [{ repoId: 'synthetic', revision }];
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  reviewed.candidates.push(candidate(reviewed, { sourceRevision: revision }));
  const connect = syntheticLocalConnection(batch, reviewed, async tools => {
    const unavailable = JSON.parse(await tools[0].handler({
      repoId: 'synthetic', action: 'read', path: 'missing.txt'
    }));
    assert.equal(unavailable.state, 'rejected');
    assert.ok(unavailable.error.message.length > 0);
    const outputs = await Promise.all([1, 2].map(() =>
      tools[0].handler({ repoId: 'synthetic', action: 'read', path: 'source.txt' })));
    for (const bytes of outputs) {
      const output = JSON.parse(bytes);
      assert.equal(output.content, 'committed source\n');
      assert.equal(output.revision, revision);
    }
    assert.deepEqual(ledger.db.prepare(
      "SELECT kind FROM local_filter_receipts WHERE kind LIKE 'source:%' ORDER BY kind").all()
      .map(row => row.kind), ['source:2', 'source:3']);
    assert.equal(ledger.db.prepare(
      "SELECT COUNT(*) n FROM local_filter_receipts WHERE kind LIKE 'error:%'").get().n, 1);
    assert.throws(() => ledger.db.exec("DELETE FROM local_filter_receipts WHERE kind LIKE 'error:%'"), /immutable/);
    await tools[1].handler({ result: reviewed });
  });
  const outcome = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id, { connect });
  assert.equal(outcome.state, 'complete-held', json(outcome));
  assert.equal(readFileSync(join(checkout, 'source.txt'), 'utf8'), 'uncommitted source must not be used\n');
  assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(reviewed)]).state, 'complete-held');
  s.config.localFilter.sources[0].revision = 'b'.repeat(40);
  assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(reviewed)]).state, 'blocked');
});
const localE2EModes = ['orchestration', 'auth', 'uncertain'];
for (const scenario of [false, true, 'committed', 'transfer', ...localE2EModes])
test(localE2EModes.includes(scenario) ? `local E2E production pipeline preserves ${scenario} contract offline` :
  `local SDK FILTER feeds the production proposer and native validation with synthetic callbacks${['committed', 'transfer'].includes(scenario) ? ` after ${scenario} validation recovery` : scenario ? ' after precommit recovery' : ''}`, async t => {
  const orchestrated = localE2EModes.includes(scenario) ? scenario : false;
  const recover = orchestrated ? false : scenario;
  const s = setup(t, 1, false, null, true, 'app-tool-reported');
  localFilterConfig(s);
  s.config.localFilter.useExistingLogin = true;
  s.config.activation.dispatch = true;
  const manifest = await prepared(s), batch = manifest.batches[0];
  const checkout = join(s.root, 'synthetic-checkout'); mkdirSync(checkout);
  const git = args => {
    const child = spawnSync('git', ['-C', checkout, '-c', 'core.autocrlf=false',
      '-c', 'core.safecrlf=false', ...args], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); return child.stdout.trim();
  };
  git(['init', '--quiet']);
  writeProposerSource(checkout);
  git(['add', '.']);
  git(['-c', 'user.name=Synthetic test', '-c', 'user.email=synthetic@example.invalid',
    '-c', 'core.hooksPath=.git/no-hooks', 'commit', '--quiet', '-m', 'Synthetic local FILTER source']);
  const revision = git(['rev-parse', 'HEAD']);
  s.config.repositories = [{ id: 'synthetic', referenceCheckout: checkout }];
  s.config.localFilter.sources = [{ repoId: 'synthetic', revision }];
  const reviewed = result(manifest, batch);
  reviewed.candidates.push(candidate(reviewed, { sourceRevision: revision }));
  const ledger = new Ledger(join(s.root, 'local-executor')); s.cleanup.push(() => ledger.close());
  const connect = syntheticLocalConnection(batch, reviewed, async tools => {
    await Promise.all([declarativeSkillPath, 'test/scenario.test.cjs'].map(path =>
      tools[0].handler({ repoId: 'synthetic', action: 'read', path })));
    await tools[1].handler({ result: reviewed });
  });
  if (!orchestrated) {
    const executed = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id, { connect });
    assert.equal(executed.state, 'complete-held', json(executed));
    assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(reviewed)]).state,
      'complete-held');
  }
  assert.equal(ledger.db.prepare(
    "SELECT COUNT(*) n FROM sqlite_master WHERE name='agency_receipts'").get().n, 0);
  await exerciseFilterProposer(s, ledger, checkout, git, manifest, reviewed, recover, orchestrated);
});
test('local E2E resumes the whole cohort, preserves failures and counts retries against the original budget', async t => {
  const s = setup(t, 3), manifest = await prepared(s); localFilterConfig(s);
  s.config.executionMode = 'standalone-sdk';
  s.config.schedule.enabled = false;
  s.config.stateDirectory = join(s.root, 'execution');
  const ledger = new Ledger(s.config.stateDirectory); s.cleanup.push(() => ledger.close());
  const input = localE2EInput(s), [first, second] = manifest.batches;
  let calls = 0;
  const connect = (...args) => {
    const batch = manifest.batches[calls++];
    return syntheticLocalConnection(batch, result(manifest, batch),
      batch === second ? async () => {} : undefined)(...args);
  };
  const failed = await advanceLocalE2E(s.config, ledger, input, { filter: true, filterDependencies: { connect } });
  assert.equal(failed.state, 'blocked', json(failed));
  assert.equal(calls, 2);
  assert.equal(failed.results.length, 1);
  const original = ledger.db.prepare('SELECT kind,body FROM local_filter_receipts ORDER BY task_id,kind').all();
  rmSync(failed.results[0].path);
  const held = await advanceLocalE2E(s.config, ledger, input, { filter: true,
    filterDependencies: { connect: () => assert.fail('Must not replay a terminal or uncertain batch') } });
  assert.equal(held.state, 'blocked');
  assert.equal(existsSync(failed.results[0].path), true);
  const reviewRef = join(s.root, 'synthetic-review.json');
  writeFileSync(reviewRef, bytes({ observations: ['Synthetic prior session did not finish.'] }));
  const retryInput = { format: 'local-filter-retry-request-v1', batchId: second.id,
    authorizationRef: 'synthetic-approved-successor', reviewRef,
    reason: 'The previous synthetic session stopped before returning a complete result.' };
  const configPath = join(s.root, 'pilot.local.json'), nextPath = join(s.root, 'next.local.json');
  const retryPath = join(s.root, 'retry-request.local.json');
  writeFileSync(configPath, bytes(s.config)); writeFileSync(retryPath, bytes(retryInput));
  const retryArgs = ['src/cli.js', 'agent', 'filter', 'filter-local-retry-prepare',
    '--file', retryPath, '--config', configPath, '--output', nextPath];
  const child = spawnSync(process.execPath, retryArgs, {
    encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' }
  });
  assert.equal(child.status, 0, child.stderr);
  assert.equal(JSON.parse(child.stdout).result.state, 'prepared-not-executed');
  const nextHash = hash(readFileSync(nextPath));
  const duplicate = spawnSync(process.execPath, retryArgs, {
    encoding: 'utf8', env: { ...process.env, NODE_NO_WARNINGS: '1' }
  });
  assert.notEqual(duplicate.status, 0);
  assert.match(duplicate.stderr, /output already exists/);
  assert.equal(hash(readFileSync(nextPath)), nextHash);
  const preparedRetry = prepareLocalFilterRetry(s.config, ledger, retryInput);
  assert.equal(preparedRetry.state, 'prepared-not-executed');
  assert.equal(preparedRetry.retry.previousAttemptId, second.id);
  s.config = configAt(nextPath);
  const recovered = await advanceLocalE2E(s.config, ledger, input, {
    filter: true, filterDependencies: {
      connect: (...args) => {
        calls++;
        return syntheticLocalConnection(second, result(manifest, second))(...args);
      }
    }
  });
  assert.equal(recovered.state, 'held-no-candidate', json(recovered));
  assert.equal(recovered.dispatchStarted, false);
  assert.equal(recovered.results.length, 2);
  assert.equal(calls, 3);
  assert.equal(ledger.status().jobs.length, 0);
  for (const record of original) assert.ok(ledger.db.prepare(
    'SELECT 1 FROM local_filter_receipts WHERE kind=? AND body=?').get(record.kind, record.body));
  const reassessment = prepareLocalFilterRetry(s.config, ledger, {
    ...retryInput, reason: 'Independent synthetic review requires a completed-result reassessment.'
  });
  assert.equal(reassessment.retry.previousAttemptId, preparedRetry.attemptId);
  assert.equal(reassessment.retry.reassessment.resultSha256, sha(result(manifest, second)));
  s.config.localFilter = reassessment.localFilter;
  const exhausted = await advanceLocalE2E(s.config, ledger, input, {
    filter: true, filterDependencies: { connect: () => assert.fail('Exhausted budget cannot launch a model') }
  });
  assert.equal(exhausted.state, 'blocked');
  assert.match(exhausted.blocker.action, /budget exhausted/);
  assert.equal(ledger.db.prepare(
    "SELECT COUNT(*) n FROM local_filter_receipts WHERE kind='request'").get().n, 3);
});
test('local E2E rejects config, manifest and result drift without model execution', async t => {
  const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
  s.config.executionMode = 'standalone-sdk';
  s.config.schedule.enabled = false;
  s.config.stateDirectory = join(s.root, 'execution');
  const ledger = new Ledger(s.config.stateDirectory); s.cleanup.push(() => ledger.close());
  const input = localE2EInput(s), batch = manifest.batches[0];
  const accepted = await advanceLocalE2E(s.config, ledger, input, { filter: true,
    filterDependencies: { connect: syntheticLocalConnection(batch, result(manifest, batch)) } });
  assert.equal(accepted.state, 'held-no-candidate', json(accepted));
  const noModel = { filter: true, filterDependencies: { connect: () => assert.fail('No model on binding drift') } };
  const changed = structuredClone(s.config);
  changed.localFilter.maxToolCalls++;
  assert.match((await advanceLocalE2E(changed, ledger, input, noModel)).blocker.action, /config changed/);
  writeFileSync(s.path, `${bytes(manifest)} `);
  assert.match((await advanceLocalE2E(s.config, ledger, input, noModel)).blocker.action, /manifest changed/);
  writeFileSync(s.path, bytes(manifest));
  writeFileSync(accepted.results[0].path, bytes({ invalid: true }));
  assert.match((await advanceLocalE2E(s.config, ledger, input, noModel)).blocker.action, /artifact changed/);
  const expandedRetry = structuredClone(s.config);
  expandedRetry.localFilter.cohortRetries = [{ execution: { maxRequests: 4 } }];
  await assert.rejects(advanceLocalE2E(expandedRetry, ledger, input, noModel), /cannot enlarge/);
});
test('local E2E stops before later batches after a permanent scope violation or a closed deadline', async t => {
  for (const mode of ['scope', 'deadline']) {
    const s = setup(t, 3), manifest = await prepared(s); localFilterConfig(s);
    s.config.executionMode = 'standalone-sdk';
    s.config.schedule.enabled = false;
    s.config.stateDirectory = join(s.root, 'execution');
    const ledger = new Ledger(s.config.stateDirectory); s.cleanup.push(() => ledger.close());
    const input = localE2EInput(s), batch = manifest.batches[0], reviewed = result(manifest, batch);
    let calls = 0;
    const connect = (...args) => {
      calls++;
      return syntheticLocalConnection(batch, reviewed, async tools => {
        if (mode === 'scope') {
          const denied = JSON.parse(await tools[0].handler({
            repoId: 'outside-approved-scope', action: 'read', path: 'synthetic.ts'
          }));
          assert.equal(denied.state, 'rejected');
        }
        await tools[1].handler({ result: reviewed });
      })(...args);
    };
    if (mode === 'deadline') {
      assert.equal((await executeLocalFilterBatch(s.config, ledger, manifest, batch.id, { connect })).state,
        'complete-held');
      t.mock.timers.enable({ apis: ['Date'], now: Date.now() });
      t.mock.timers.tick(600001);
    }
    try {
      const outcome = await advanceLocalE2E(s.config, ledger, input, {
        filter: true, filterDependencies: { connect }
      });
      assert.equal(outcome.state, 'blocked', json(outcome));
      assert.equal(calls, 1);
      assert.equal(ledger.db.prepare(
        "SELECT COUNT(*) n FROM local_filter_receipts WHERE kind='request'").get().n, 1);
      if (mode === 'deadline') assert.equal(outcome.blocker.code, 'blocked-budget');
      assert.equal(ledger.status().jobs.length, 0);
    } finally { if (mode === 'deadline') t.mock.timers.reset(); }
  }
});
test('local E2E preserves explicit SDK budget refusal without inventing a request or candidate', async t => {
  const s = setup(t, 1); await prepared(s); localFilterConfig(s);
  s.config.executionMode = 'standalone-sdk';
  s.config.schedule.enabled = false;
  s.config.localFilter.acceptSoftCreditLimit = false;
  s.config.stateDirectory = join(s.root, 'execution');
  const ledger = new Ledger(s.config.stateDirectory); s.cleanup.push(() => ledger.close());
  const outcome = await advanceLocalE2E(s.config, ledger, localE2EInput(s), { filter: true,
    filterDependencies: { connect: () => assert.fail('Budget approval cannot be inferred') } });
  assert.equal(outcome.state, 'action-required-budget', json(outcome));
  assert.equal(outcome.filterOutcome.modelInvoked, false);
  assert.equal(outcome.accepted, null);
  assert.equal(ledger.status().jobs.length, 0);
});
test('local E2E cannot spend a request on a cohort larger than its configured cap', async t => {
  const s = setup(t, 3); await prepared(s); localFilterConfig(s);
  s.config.executionMode = 'standalone-sdk';
  s.config.schedule.enabled = false;
  s.config.localFilter.maxRequests = 1;
  s.config.stateDirectory = join(s.root, 'execution');
  const ledger = new Ledger(s.config.stateDirectory); s.cleanup.push(() => ledger.close());
  const input = localE2EInput(s);
  input.authorization.maxFilterRequests = 3;
  const outcome = await advanceLocalE2E(s.config, ledger, input, { filter: true,
    filterDependencies: { connect: () => assert.fail('Unfinishable cohort cannot start') } });
  assert.equal(outcome.state, 'blocked');
  assert.equal(outcome.blocker.code, 'blocked-budget');
  assert.equal(ledger.status().jobs.length, 0);
});
test('local SDK FILTER cannot replace an existing Agency attempt', async t => {
  const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  ledger.db.exec(`CREATE TABLE agency_requests(task_id TEXT PRIMARY KEY,body TEXT);
    CREATE TABLE agency_receipts(task_id TEXT,kind TEXT,body TEXT)`);
  ledger.db.prepare('INSERT INTO agency_requests VALUES(?,?)').run(manifest.batches[0].id, '{}');
  await assert.rejects(executeLocalFilterBatch(s.config, ledger, manifest, manifest.batches[0].id),
    /Agency attempt already owns/);
});
test('local SDK FILTER explicitly authorized retry preserves its predecessor and cannot fork or repeat', async t => {
  const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
  s.config.localFilter.maxRequests = 2;
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  const first = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id,
    { connect: syntheticLocalConnection(batch, reviewed, async () => {}) });
  assert.equal(first.state, 'blocked');
  const original = ledger.db.prepare(
    'SELECT kind,body FROM local_filter_receipts WHERE task_id=? ORDER BY kind').all(batch.id);
  s.config.localFilter.retry = { batchId: batch.id, previousAttemptId: batch.id,
    previousTerminalSha256: sha(first.terminal), authorizationRef: 'synthetic-explicit-retry-approval' };
  const retried = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id,
    { connect: syntheticLocalConnection(batch, reviewed) });
  assert.equal(retried.state, 'complete-held', json(retried));
  assert.notEqual(retried.terminal.attemptId, batch.id);
  assert.notEqual(retried.terminal.sessionId, first.terminal.sessionId);
  assert.equal(ledger.db.prepare(
    "SELECT COUNT(*) n FROM local_filter_receipts WHERE kind='request'").get().n, 2);
  assert.deepEqual(ledger.db.prepare(
    'SELECT kind,body FROM local_filter_receipts WHERE task_id=? ORDER BY kind').all(batch.id), original);
  assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(reviewed)]).state, 'complete-held');
  await assert.rejects(executeLocalFilterBatch(s.config, ledger, manifest, batch.id), /Existing FILTER/);
  s.config.localFilter.retry.authorizationRef = 'synthetic-changed-reference-cannot-fork';
  await assert.rejects(executeLocalFilterBatch(s.config, ledger, manifest, batch.id), /no retry forks/);
  delete s.config.localFilter.retry;
  assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(reviewed)]).state, 'blocked');
});
test('local SDK FILTER binds source follow-up diagnostics without rewriting a blocked predecessor', async t => {
  const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  const failed = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id,
    { connect: syntheticLocalConnection(batch, reviewed, async () => {}) });
  const review = { observation: 'Synthetic source-backed lead, not an accepted decision' };
  const reviewPath = join(s.root, 'review.json');
  writeFileSync(reviewPath, bytes(review));
  s.config.localFilter.retry = {
    batchId: batch.id, previousAttemptId: batch.id,
    previousTerminalSha256: sha(failed.terminal), authorizationRef: 'synthetic-new-authorization',
    review: { reviewRef: reviewPath, reviewSha256: '0'.repeat(64), reason: 'Verify the source lead independently' }
  };
  assert.throws(() => localFilterPreflight(s.config), /review hash changed/);
  s.config.localFilter.retry.review.reviewSha256 = sha(review);
  const outcome = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id,
    { connect: syntheticLocalConnection(batch, reviewed) });
  assert.equal(outcome.state, 'complete-held');
  assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(reviewed)]).state, 'complete-held');
  assert.equal(ledger.db.prepare("SELECT body FROM local_filter_receipts WHERE task_id=? AND kind='terminal'")
    .get(batch.id).body, json(failed.terminal));
  writeFileSync(reviewPath, bytes({ observation: 'Changed after execution' }));
  assert.throws(() => reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(reviewed)]), /review hash changed/);
});
test('local SDK FILTER rejects invalid retry lineage and exhausted attempt budgets before invocation', async t => {
  for (const scenario of ['missing', 'changed-hash', 'completed', 'exhausted-budget']) {
    const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
    const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
    const batch = manifest.batches[0], reviewed = result(manifest, batch);
    const first = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id,
      { connect: syntheticLocalConnection(batch, reviewed, async tools => {
        if (scenario === 'completed') await tools[1].handler({ result: reviewed });
      }) });
    s.config.localFilter.retry = { batchId: batch.id,
      previousAttemptId: scenario === 'missing' ? 'missing-attempt' : batch.id,
      previousTerminalSha256: scenario === 'changed-hash' ? '0'.repeat(64) : sha(first.terminal),
      authorizationRef: 'synthetic-explicit-retry-approval' };
    if (scenario === 'exhausted-budget') s.config.localFilter.maxRequests = 1;
    let invoked = false;
    await assert.rejects(executeLocalFilterBatch(s.config, ledger, manifest, batch.id,
      { connect: async () => { invoked = true; } }),
    scenario === 'exhausted-budget' ? /request budget exhausted/ : /existing blocked local attempt/);
    assert.equal(invoked, false);
    assert.equal(ledger.db.prepare(
      "SELECT COUNT(*) n FROM local_filter_receipts WHERE kind='request'").get().n, 1);
  }
});
test('local SDK FILTER reassessment binds a rejected completed result without rewriting or forking it', async t => {
  const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  const first = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id,
    { connect: syntheticLocalConnection(batch, reviewed) });
  assert.equal(first.state, 'complete-held');
  const original = ledger.db.prepare(
    'SELECT kind,body FROM local_filter_receipts WHERE task_id=? ORDER BY kind').all(batch.id);
  s.config.localFilter.retry = { batchId: batch.id, previousAttemptId: batch.id,
    previousTerminalSha256: sha(first.terminal), authorizationRef: 'synthetic-new-approval',
    reassessment: { resultSha256: '0'.repeat(64), reviewRef: 'synthetic-quality-audit',
      reason: 'The completed result used a different record rationale.' } };
  let invoked = false;
  await assert.rejects(executeLocalFilterBatch(s.config, ledger, manifest, batch.id,
    { connect: async () => { invoked = true; } }), /explicitly rejected completed result/);
  assert.equal(invoked, false);
  s.config.localFilter.retry.reassessment.resultSha256 = sha(reviewed);
  const second = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id,
    { connect: syntheticLocalConnection(batch, reviewed) });
  assert.equal(second.state, 'complete-held');
  assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(reviewed)]).state, 'complete-held');
  assert.deepEqual(ledger.db.prepare(
    'SELECT kind,body FROM local_filter_receipts WHERE task_id=? ORDER BY kind').all(batch.id), original);
  s.config.localFilter.retry.reassessment.reason = 'Another rejection cannot create a fork';
  await assert.rejects(executeLocalFilterBatch(s.config, ledger, manifest, batch.id), /no retry forks/);
  s.config.localFilter.retry.reassessment.reason = ' ';
  assert.throws(() => localFilterPreflight(s.config), /reassessment requires/);
});
test('local SDK FILTER model requalification preserves exact payload and predecessor lineage', async t => {
  const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  const first = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id,
    { connect: syntheticLocalConnection(batch, reviewed, async () => {}) });
  s.config.filterBatching.model = 'synthetic-replacement';
  const path = join(s.root, 'requalified.json');
  await prepareFilterBatches(s.config, s.request, path, counter);
  const replacement = readJson(path);
  assert.equal(replacement.batches[0].payload, batch.payload);
  s.config.localFilter.retry = { batchId: batch.id, previousAttemptId: batch.id,
    previousTerminalSha256: sha(first.terminal), authorizationRef: 'synthetic-model-change-approval' };
  await assert.rejects(executeLocalFilterBatch(s.config, ledger, replacement, batch.id), /model changes require/);
  s.config.localFilter.retry.requalification = { previousModel: manifest.budget.model,
    previousManifestSha256: '0'.repeat(64), reason: 'Original model retired; replacement budget verified.' };
  await assert.rejects(executeLocalFilterBatch(s.config, ledger, replacement, batch.id), /model changes require/);
  s.config.localFilter.retry.requalification.previousManifestSha256 = sha(manifest);
  const second = await executeLocalFilterBatch(s.config, ledger, replacement, batch.id,
    { connect: syntheticLocalConnection(batch, reviewed) });
  assert.equal(second.state, 'complete-held');
  assert.equal(reconcileFilterExecutionCohort(s.config, ledger, replacement, [bytes(reviewed)]).state, 'complete-held');
  assert.equal(ledger.db.prepare("SELECT body FROM local_filter_receipts WHERE task_id=? AND kind='terminal'")
    .get(batch.id).body, json(first.terminal));
});
test('local SDK FILTER literal search binds the revision and never substitutes for complete source reads', async t => {
  const s = setup(t, 1), manifest = await prepared(s); localFilterConfig(s);
  const revision = 'a'.repeat(40);
  s.config.repositories = [{ id: 'synthetic', referenceCheckout: s.root }];
  s.config.localFilter.sources = [{ repoId: 'synthetic', revision }];
  s.config.localFilter.maxToolCalls = 10;
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  reviewed.candidates = [candidate(reviewed)];
  const execute = async (_executable, args) => {
    if (args.includes('rev-parse')) return { stdout: revision };
    assert.deepEqual(args.slice(0, 7), ['--no-pager', 'grep', '-n', '-I', '-F', '--no-color', '-e']);
    assert.deepEqual(args.slice(-3), [revision, '--', 'src']);
    if (args[7] === 'missing') throw Object.assign(new Error('No matches'), { code: 1, stdout: '', stderr: '' });
    if (args[7] === 'failure') throw Object.assign(new Error('Git failed'), { code: 2, stdout: '', stderr: '' });
    assert.equal(args[7], '--literal');
    return { stdout: `${revision}:src/test.ts:1:const value = "--literal";\n` };
  };
  const connect = syntheticLocalConnection(batch, reviewed, async tools => {
    const search = query => tools[0].handler({ repoId: 'synthetic', action: 'search', path: 'src', query });
    assert.equal(JSON.parse(await search('x')).state, 'rejected');
    const matched = JSON.parse(await search('--literal'));
    assert.equal(matched.query, '--literal');
    assert.equal(matched.revision, revision);
    assert.match(matched.content, /const value/);
    assert.equal(JSON.parse(await search('missing')).content, '');
    assert.equal(JSON.parse(await search('failure')).state, 'rejected');
    assert.match(JSON.parse(await tools[1].handler({ result: reviewed })).error.message, /actually inspected/);
    reviewed.candidates = [];
    assert.equal(JSON.parse(await tools[1].handler({ result: reviewed })).state, 'held');
  });
  const outcome = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id, { connect, execute });
  assert.equal(outcome.state, 'complete-held');
  const checked = reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(reviewed)]);
  assert.equal(checked.state, 'complete-held');
  assert.deepEqual(checked.batches[0].sourceReads, []);
});
test('local SDK FILTER assembles immutable partial decisions and independently reconciles every input', async t => {
    const s = setup(t, 2), manifest = await prepared(s); localFilterConfig(s);
    s.config.localFilter.maxToolCalls = 8;
    const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
    const batch = manifest.batches[0], reviewed = result(manifest, batch);
    assert.equal(reviewed.details.length, 2);
    const chunk = index => ({ ...structuredClone(reviewed), status: 'partial',
      titles: { ...structuredClone(reviewed.titles), decisions: [structuredClone(reviewed.titles.decisions[index])] },
      details: [structuredClone(reviewed.details[index])] });
    const empty = { ...structuredClone(reviewed),
      titles: { ...structuredClone(reviewed.titles), decisions: [] }, details: [], candidates: [] };
    const connect = syntheticLocalConnection(batch, reviewed, async tools => {
      const submit = async result => JSON.parse(await tools[1].handler({ result }));
      assert.equal((await submit(chunk(0))).state, 'partial');
      assert.equal((await submit(chunk(0))).remainingCount, 1);
      const conflict = chunk(0); conflict.details[0].reason = 'Changed accepted reasoning';
      assert.match((await submit(conflict)).error.message, /immutable/);
      assert.equal((await submit(empty)).state, 'rejected');
      assert.equal((await submit(chunk(1))).remainingCount, 0);
      assert.equal((await submit(empty)).state, 'held');
    });
    const outcome = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id, { connect });
    assert.equal(outcome.state, 'complete-held');
    assert.deepEqual(outcome.result, reviewed);
    assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(reviewed)]).state, 'complete-held');
    const terminal = ledger.db.prepare("SELECT body FROM local_filter_receipts WHERE task_id=? AND kind='terminal'")
      .get(batch.id).body;
    ledger.db.prepare('INSERT INTO local_filter_receipts VALUES(?,?,?)').run(batch.id,
      'analysis-input:99', json({ input: chunk(0), inputSha256: '0'.repeat(64) }));
    const checked = reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(reviewed)]);
    assert.equal(checked.state, 'blocked');
    assert.match(checked.batches[0].analysisError.message, /chunk hash mismatch/);
    assert.equal(ledger.db.prepare("SELECT body FROM local_filter_receipts WHERE task_id=? AND kind='terminal'")
      .get(batch.id).body, terminal);
});
test('local SDK FILTER retries one batch without blocking other unstarted cohort members', async t => {
  const s = setup(t, 3), manifest = await prepared(s); localFilterConfig(s);
  assert.equal(manifest.batches.length, 2);
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const firstBatch = manifest.batches[0], firstResult = result(manifest, firstBatch);
  const failed = await executeLocalFilterBatch(s.config, ledger, manifest, firstBatch.id,
    { connect: syntheticLocalConnection(firstBatch, firstResult, async () => {}) });
  s.config.localFilter.retry = { batchId: firstBatch.id, previousAttemptId: firstBatch.id,
    previousTerminalSha256: sha(failed.terminal), authorizationRef: 'synthetic-cohort-retry-approval' };
  const results = [];
  for (const batch of manifest.batches) {
    const reviewed = result(manifest, batch);
    const outcome = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id,
      { connect: syntheticLocalConnection(batch, reviewed) });
    assert.equal(outcome.state, 'complete-held');
    results.push(bytes(outcome.result));
  }
  assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, results).state, 'complete-held');
});
test('local SDK FILTER compact decisions bind metadata but preserve every model semantic field', async t => {
  const s = setup(t, 2), manifest = await prepared(s); localFilterConfig(s);
  Object.assign(s.config.localFilter, { compactDecisions: true, maxToolCalls: 12 });
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  const entries = inputOf(batch).index.entries;
  const decision = index => ({
    index, recordId: entries[index].source.recordId,
    disposition: reviewed.titles.decisions[index].disposition, exclusionType: null, titleQuote: null,
    titleReason: `Exact model title reasoning ${index}`,
    detailStatus: 'reviewed', detailReason: `Exact model detail reasoning ${index}`
  });
  const chunk = index => ({ status: 'partial', decisions: [decision(index)], candidates: [] });
  const connect = syntheticLocalConnection(batch, reviewed, async tools => {
    const submit = async input => JSON.parse(await tools[1].handler(input));
    const progress = await submit({ status: 'progress', decisions: [], candidates: [] });
    assert.equal(progress.remainingCount, 2);
    assert.equal(progress.nextRemainingRecords[0].recordId, decision(0).recordId);
    assert.equal((await submit({ ...chunk(0), decisions: [{ ...decision(0), recordId: 'wrong' }] })).state, 'rejected');
    assert.equal((await submit({ ...chunk(0), decisions: [{ ...decision(0), recordSha256: 'invented' }] })).state, 'rejected');
    assert.equal((await submit(chunk(0))).remainingCount, 1);
    assert.equal((await submit(chunk(0))).remainingCount, 1);
    assert.equal((await submit({ status: 'complete', decisions: [], candidates: [] })).state, 'rejected');
    assert.equal((await submit(chunk(1))).remainingCount, 0);
    assert.equal((await submit({ status: 'complete', decisions: [], candidates: [] })).state, 'held');
  });
  const outcome = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id, { connect });
  assert.equal(outcome.state, 'complete-held', json(outcome));
  for (let index = 0; index < entries.length; index++) {
    assert.equal(outcome.result.titles.decisions[index].reason, decision(index).titleReason);
    assert.equal(outcome.result.details[index].reason, decision(index).detailReason);
    assert.equal(outcome.result.details[index].recordSha256, entries[index].recordSha256);
    assert.deepEqual(outcome.result.titles.decisions[index].source, entries[index].source);
  }
  const checked = reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(outcome.result)]);
  assert.equal(checked.state, 'complete-held');
  assert.equal(checked.batches[0].analysisPolicy, 'compact-incremental-complete-cohort-v1');
  const receipt = JSON.parse(ledger.db.prepare(
    "SELECT body FROM local_filter_receipts WHERE task_id=? AND kind='analysis-input:4'").get(batch.id).body);
  assert.deepEqual(receipt.submission, chunk(0));
  receipt.submission.decisions[0].detailReason = 'Changed model reasoning';
  receipt.submissionSha256 = sha(receipt.submission);
  ledger.db.prepare('INSERT INTO local_filter_receipts VALUES(?,?,?)').run(batch.id, 'analysis-input:99', json(receipt));
  const tampered = reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(outcome.result)]);
  assert.equal(tampered.state, 'blocked');
  assert.match(tampered.batches[0].analysisError.message, /original model submission/);
});
test('local SDK FILTER paged evidence blocks unread decisions and reconciles original page bytes', async t => {
  const s = setup(t, 2), manifest = await prepared(s); localFilterConfig(s);
  Object.assign(s.config.localFilter, { evidencePaging: true, maxToolCalls: 12 });
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0], reviewed = result(manifest, batch);
  const connect = syntheticLocalConnection(batch, reviewed, async tools => {
    const submit = async input => JSON.parse(await tools.find(tool => tool.name === 'pilot_filter_finish').handler(input));
    assert.equal((await submit({ result: reviewed })).state, 'rejected');
    const read = tools.find(tool => tool.name === 'pilot_filter_evidence');
    for (let index = 0; index < reviewed.details.length; index++) {
      let offset = 0;
      do {
        const response = JSON.parse(await read.handler({ index, offset }));
        assert(response.content.includes('evidence') || offset > 0);
        offset = response.nextOffset;
      } while (offset !== null);
    }
    assert.equal((await submit({ result: reviewed })).state, 'held');
  });
  const outcome = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id, { connect });
  assert.equal(outcome.state, 'complete-held', json(outcome));
  assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(outcome.result)]).state, 'complete-held');
  const receipt = JSON.parse(ledger.db.prepare(
    "SELECT body FROM local_filter_receipts WHERE task_id=? AND kind LIKE 'evidence:%' LIMIT 1").get(batch.id).body);
  receipt.observation.sha256 = 'a'.repeat(64);
  ledger.db.prepare('INSERT INTO local_filter_receipts VALUES(?,?,?)').run(batch.id, 'evidence:99', json(receipt));
  const tampered = reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(outcome.result)]);
  assert.equal(tampered.state, 'blocked');
  assert.match(tampered.batches[0].analysisError.message, /original batch bytes/);
});
test('local SDK FILTER noncompact paging derives result pins only from delivered prompt and tools', async t => {
  const s = setup(t, 2), manifest = await prepared(s); localFilterConfig(s);
  Object.assign(s.config.localFilter, { evidencePaging: true, compactDecisions: false, maxToolCalls: 12 });
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const batch = manifest.batches[0];
  const connect = syntheticLocalConnection(batch, null, async (tools, { prompt }) => {
    const envelope = JSON.parse(prompt);
    assert.match(envelope.indexSha256, /^[a-f0-9]{64}$/);
    assert.match(envelope.analysisPayloadSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(envelope.originalPayloadSha256, envelope.analysisPayloadSha256);
    const reviewed = await reviewDeliveredEvidence(tools, prompt);
    const submit = async result => JSON.parse(await tools.find(tool =>
      tool.name === 'pilot_filter_finish').handler({ result }));
    assert.equal((await submit({ ...reviewed.result,
      payloadSha256: envelope.originalPayloadSha256 })).state, 'rejected');
    assert.equal((await submit({ ...reviewed.result, titles: { ...reviewed.result.titles,
      indexSha256: envelope.originalPayloadSha256 } })).state, 'rejected');
    assert.equal((await submit(reviewed.result)).state, 'held');
  });
  const outcome = await executeLocalFilterBatch(s.config, ledger, manifest, batch.id, { connect });
  assert.equal(outcome.state, 'complete-held', json(outcome));
  assert.equal(outcome.result.payloadSha256, batch.analysisPayloadSha256);
  assert.equal(outcome.result.titles.indexSha256, batch.indexSha256);
  assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, [bytes(outcome.result)]).state,
    'complete-held');
});
test('local SDK FILTER budgets actual paged prompt and each delivered page once without relaxing ceilings', async t => {
  const s = setup(t, 1, false, ['Functional issue'], true, 'synthetic',
    'Original 中文 😀 evidence\n'.repeat(3000));
  const manifest = await prepared(s); localFilterConfig(s);
  Object.assign(s.config.localFilter, { evidencePaging: true, compactDecisions: false, maxToolCalls: 40 });
  const batch = manifest.batches[0];
  let attempts = 0;
  const run = async (ceiling, expectPageRejection = false) => {
    const config = structuredClone(s.config);
    config.localFilter.maxRequestBytes = ceiling;
    const ledger = new Ledger(join(s.root, `execution-${++attempts}`));
    s.cleanup.push(() => ledger.close());
    let measured, callbackFailure;
    const behavior = async (tools, { prompt }, options) => {
      const finish = tools.find(tool => tool.name === 'pilot_filter_finish');
      const overheadBytes = Buffer.byteLength(options.systemMessage.content) +
        Buffer.byteLength(json(finish.parameters));
      const initialBytes = Buffer.byteLength(prompt) + overheadBytes;
      const request = JSON.parse(ledger.db.prepare(
        "SELECT body FROM local_filter_receipts WHERE kind='request'").get().body);
      assert.equal(request.requestBytes, initialBytes);
      assert.equal(request.payloadSha256, batch.payloadSha256);
      const reviewed = await reviewDeliveredEvidence(tools, prompt);
      measured = { initialBytes, totalBytes: initialBytes + reviewed.deliveredBytes,
        oldTotalBytes: Buffer.byteLength(batch.payload) + overheadBytes + reviewed.deliveredBytes,
        pages: reviewed.pages };
      assert.ok(measured.totalBytes <= ceiling);
      const submitted = JSON.parse(await finish.handler({ result: reviewed.result ?? {} }));
      if (expectPageRejection) {
        assert.equal(reviewed.rejected.error.code, 'blocked-budget');
        assert.match(reviewed.rejected.error.message, /Cumulative FILTER input exceeds the byte ceiling/);
        assert.equal(submitted.state, 'rejected');
        assert.match(submitted.error.message, /permanent scope or budget violation/);
      } else {
        assert.equal(reviewed.rejected, undefined);
        assert.equal(submitted.state, 'held');
      }
    };
    const connect = syntheticLocalConnection(batch, null, async (...args) => {
      try { await behavior(...args); }
      catch (error) { callbackFailure = error; throw error; }
    });
    const outcome = await executeLocalFilterBatch(config, ledger, manifest, batch.id, { connect });
    assert.ifError(callbackFailure);
    assert.equal(outcome.state, expectPageRejection ? 'blocked' : 'complete-held', json(outcome));
    assert.equal(ledger.db.prepare(
      "SELECT COUNT(*) n FROM local_filter_receipts WHERE kind LIKE 'evidence:%'").get().n, measured.pages);
    if (expectPageRejection) {
      assert.equal(outcome.terminal.analysisPassed, false);
      assert.equal(outcome.terminal.policyViolations.length, 1);
      assert.equal(outcome.terminal.policyViolations[0].code, 'blocked-budget');
    } else assert.equal(reconcileFilterExecutionCohort(config, ledger, manifest, [bytes(outcome.result)]).state,
      'complete-held');
    return measured;
  };
  const probe = await run(s.config.localFilter.maxRequestBytes);
  assert.ok(probe.pages > 1);
  const threshold = Math.floor((probe.totalBytes + probe.oldTotalBytes) / 2);
  assert.ok(probe.totalBytes < threshold && threshold < probe.oldTotalBytes);
  t.diagnostic(json({ ...probe, successfulCeiling: threshold, rejectedPageCeiling: probe.totalBytes - 1,
    rejectedInitialCeiling: probe.initialBytes - 1 }));
  const bounded = await run(threshold);
  assert.deepEqual(bounded, probe);
  const overrun = await run(probe.totalBytes - 1, true);
  assert.ok(overrun.pages > 0 && overrun.pages < probe.pages);
  const ledger = new Ledger(join(s.root, 'initial-overrun')); s.cleanup.push(() => ledger.close());
  s.config.localFilter.maxRequestBytes = probe.initialBytes - 1;
  await assert.rejects(executeLocalFilterBatch(s.config, ledger, manifest, batch.id,
    { connect: () => assert.fail('An oversized actual prompt must not open a session') }),
  error => error.code === 'blocked-budget' && /byte ceiling/.test(error.message));
});
test('local SDK FILTER adds a cohort retry without changing a completed batch execution binding', async t => {
  const s = setup(t, 3), manifest = await prepared(s); localFilterConfig(s);
  s.config.localFilter.maxRequests = 4;
  const ledger = new Ledger(join(s.root, 'execution')); s.cleanup.push(() => ledger.close());
  const [first, second] = manifest.batches;
  const firstResult = result(manifest, first), secondResult = result(manifest, second);
  const firstFailure = await executeLocalFilterBatch(s.config, ledger, manifest, first.id,
    { connect: syntheticLocalConnection(first, firstResult, async () => {}) });
  s.config.localFilter.retry = { batchId: first.id, previousAttemptId: first.id,
    previousTerminalSha256: sha(firstFailure.terminal), authorizationRef: 'synthetic-first-batch-approval' };
  const completed = await executeLocalFilterBatch(s.config, ledger, manifest, first.id,
    { connect: syntheticLocalConnection(first, firstResult) });
  const failed = await executeLocalFilterBatch(s.config, ledger, manifest, second.id,
    { connect: syntheticLocalConnection(second, secondResult, async () => {}) });
  const original = ledger.db.prepare(
    'SELECT kind,body FROM local_filter_receipts WHERE task_id=? ORDER BY kind').all(completed.terminal.attemptId);
  s.config.localFilter.cohortRetries = [{ batchId: second.id, previousAttemptId: second.id,
    previousTerminalSha256: sha(failed.terminal), authorizationRef: 'synthetic-second-batch-approval',
    execution: { maxRequests: 5, maxToolCalls: 7, timeoutMs: 20000 } }];
  const retried = await executeLocalFilterBatch(s.config, ledger, manifest, second.id,
    { connect: syntheticLocalConnection(second, secondResult) });
  assert.equal(completed.state, 'complete-held');
  assert.equal(retried.state, 'complete-held');
  const results = [bytes(firstResult), bytes(secondResult)];
  assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, results).state, 'complete-held');
  assert.deepEqual(ledger.db.prepare(
    'SELECT kind,body FROM local_filter_receipts WHERE task_id=? ORDER BY kind').all(completed.terminal.attemptId), original);
  s.config.localFilter.maxToolCalls++;
  assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, results).state, 'blocked');
  s.config.localFilter.maxToolCalls--;
  const retry = s.config.localFilter.cohortRetries[0];
  s.config.localFilter.cohortRetries = [retry, retry];
  assert.throws(() => localFilterPreflight(s.config), /unique per batch/);
  s.config.localFilter.cohortRetries = null;
  assert.throws(() => localFilterPreflight(s.config), /must be an array/);
  s.config.localFilter.cohortRetries = [{ ...retry, execution: { sources: [] } }];
  assert.throws(() => localFilterPreflight(s.config), /execution overrides/);
  s.config.localFilter.cohortRetries = [{ ...retry, execution: { maxToolCalls: 0 } }];
  assert.throws(() => localFilterPreflight(s.config), /Invalid FILTER retry execution maxToolCalls/);
  s.config.localFilter.cohortRetries = [{ ...retry, batchId: 'unknown' }];
  assert.throws(() => reconcileFilterExecutionCohort(s.config, ledger, manifest, results), /unknown batch/);
  delete s.config.localFilter.cohortRetries;
  assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, results).state, 'blocked');
});
test('exact token boundary packs complete records, reserves capacity and preserves source bytes', async t => {
  const s = setup(t), before = hash(readFileSync(s.ledgerPath)), manifest = await prepared(s);
  assert.deepEqual(manifest.batches.map(b => b.groupIds.length), [2, 1]);
  assert.equal(manifest.batches[0].tokenReceipt.tokens + 5, manifest.budget.payloadLimit);
  assert.equal(manifest.inventory.length, 3);
  assert.equal(hash(readFileSync(s.ledgerPath)), before);
  const bodies = manifest.batches.flatMap(b => inputOf(b).evidence);
  assert.deepEqual(bodies.map(e => e.id).sort(), s.records.map(e => e.id).sort());
  assert.ok(bodies.every(e => e.fields.description.startsWith('Complete original body')));
  assert.equal(validateFilterManifest(s.config, manifest).evidence.length, 3);
  const again = await prepareFilterBatches(s.config, s.request, s.path, counter);
  assert.equal(again.sha256, hash(readFileSync(s.path)));
  s.config.filterBatching.maxInputTokens--;
  const next = join(s.root, 'smaller.json');
  await prepareFilterBatches(s.config, s.request, next, counter);
  assert.deepEqual(readJson(next).batches.map(b => b.groupIds.length), [1, 1, 1]);
});
test('oversized indivisible group, unknown capacity/counts and job limits block without truncation', async t => {
  const s = setup(t);
  s.config.filterBatching.maxInputTokens = 100;
  await assert.rejects(prepareFilterBatches(s.config, s.request, s.path, counter), /exceeds verified budget/);
  assert.equal(existsSync(s.path), false);
  s.config.filterBatching.maxInputTokens = null;
  await assert.rejects(prepareFilterBatches(s.config, s.request, s.path, counter), /Unknown\/invalid/);
  s.config.filterBatching.maxInputTokens = 250; s.config.filterBatching.maxBatches = 1;
  await assert.rejects(prepareFilterBatches(s.config, s.request, s.path, counter), /job budget/);
  s.config.filterBatching.maxBatches = 10;
  await assert.rejects(prepareFilterBatches(s.config, s.request, s.path,
    async (c, i) => ({ ...await counter(c, i), sha256: '0'.repeat(64) })), /receipt does not match/);
});
test('explicit estimated mode preserves unknown provider limits and exact declared estimator bounds', async t => {
  const s = setup(t);
  Object.assign(s.config.filterBatching, { mode: 'estimated', tokenizer: null,
    contextTokens: null, maxInputTokens: null, estimation: {
      methodId: 'synthetic-estimator-v1', version: '1', description: 'Synthetic deterministic estimate',
      planningContextTokens: 1000, inputTokenCap: 250,
      approval: { decision: 'Approved estimated bounded test', authority: 'synthetic-user',
        receivedAt: '2026-10-12T00:00:00Z', scope: 'bounded-replay', maxConcurrency: 2,
        accuracy: 'estimate-not-provider-token-accuracy' }
    } });
  const manifest = await prepared(s);
  assert.equal(manifest.budget.tokenizer, null);
  assert.equal(manifest.budget.contextTokens, null);
  assert.equal(manifest.budget.maxInputTokens, null);
  assert.match(manifest.budget.uncertainty, /unknown/);
  assert.deepEqual(manifest.batches.map(b => b.groupIds.length), [2, 1]);
  assert.equal(validateFilterManifest(s.config, manifest).evidence.length, 3);
  s.config.filterBatching.estimation.approval.maxConcurrency = 3;
  await assert.rejects(prepareFilterBatches(s.config, s.request, join(s.root, 'bad.json'), counter), /bounded user approval/);
});
test('budget-free group sizing is explicit bytes only and matches exact packed payload size', async t => {
  const s = setup(t, 1);
  const measured = sizeFilterGroups(s.config, s.request);
  assert.equal(measured.providerTokensVerified, false);
  assert.equal(measured.sharingEligibilityChecked, false);
  const manifest = await prepared(s);
  assert.equal(measured.largestAtomicPayloadBytes, Buffer.byteLength(manifest.batches[0].payload));
  assert.equal(measured.groups[0].payloadSha256, manifest.batches[0].payloadSha256);
});
test('only byte-proven duplicate captures use lossless field recipes; unmatched archives stay inline', async t => {
  const s = setup(t, 1, false, null, true), manifest = await prepared(s);
  const content = inputOf(manifest.batches[0]), capture = content.captures[0], record = content.evidence[0];
  assert.equal(capture.representation, 'reconstructed-from-full-evidence');
  assert.equal(capture.contentBase64, undefined); assert.equal(capture.recipe, 'ado-fields-relations-v1');
  const rebuilt = json({ id: Number(record.source.recordId), rev: Number(record.source.revision),
    fields: record.fields, relations: record.links });
  assert.equal(hash(rebuilt), capture.sha256);
  assert.equal(Buffer.byteLength(rebuilt), capture.originalByteLength);
  assert.equal(validateFilterManifest(s.config, manifest).evidence.length, 1);
  const unmatched = setup(t, 1), other = await prepared(unmatched);
  const inline = inputOf(other.batches[0]).captures[0];
  assert.equal(inline.representation, 'inline-base64');
  assert.equal(hash(Buffer.from(inline.contentBase64, 'base64')), inline.sha256);
});
test('within-batch sharing and coverage factoring round-trips every distinct policy and source field', async t => {
  const s = setup(t, 2), { ledger } = openApp(s.sourceConfig, 'source');
  const repeated = { missingScope: 'x'.repeat(600), known: false };
  for (const pass of ['synthetic:a', 'synthetic:b'])
    ledger.db.prepare('INSERT INTO app_passes VALUES(?,?,?)').run('source', pass,
      json({ pass, state: 'partial', limitations: repeated, specific: pass }));
  ledger.close(); s.approve();
  s.request.sharing.materials[0].restrictions = ['Distinct additional restriction; original label unknown'];
  const manifest = await prepared(s), input = inputOf(manifest.batches[0]);
  assert.equal(input.sharing.policies.length, 2);
  const expanded = expandFilterSharing(input.sharing);
  assert.deepEqual(expanded.materials, s.request.sharing.materials);
  assert.deepEqual(expandFilterCoverage(input.sourceCoverage), loadFilterCorpus(s.config,
    { format: 'stage2-sources-v1', sources: s.request.sources }).coverage.map(({ runId, coverage }) => ({ runId, coverage })));
  const changed = structuredClone(input.sharing); changed.policies[0].restrictions = ['lost restriction'];
  assert.throws(() => expandFilterSharing(changed), /round-trip/);
  const coverage = structuredClone(input.sourceCoverage); coverage.shared[0].value.known = true;
  assert.throws(() => expandFilterCoverage(coverage), /round-trip/);
});
test('related thread members cannot split and complete thread context is preserved', async t => {
  const s = setup(t, 2, true), { ledger } = openApp(s.sourceConfig, 'source');
  const context = { teamId: 'team', channelId: 'channel', rootId: 'root',
    message: { body: 'Complete older related thread message' } };
  ledger.db.prepare('INSERT INTO app_thread_context VALUES(?,?,?,?)').run('source', 'workiq:created', 'ctx', json(context));
  ledger.close(); s.approve();
  await assert.rejects(prepareFilterBatches(s.config, s.request, s.path, counter), /cannot be split/);
  s.request.groups = [{ id: 'thread', memberIds: s.records.map(e => e.id), contextIds: [], reason: 'Same thread' }];
  const manifest = await prepared(s);
  assert.deepEqual(inputOf(manifest.batches[0]).threadContexts[0].content, context);
});
test('context copies are explicit, counted in exact payload and never extra review members', async t => {
  const s = setup(t); s.config.filterBatching.maxInputTokens = 249;
  s.request.groups[0].contextIds = [s.records[2].id];
  const manifest = await prepared(s), batch = manifest.batches[0], content = inputOf(batch);
  assert.deepEqual(batch.contextIds, [s.records[2].id]);
  assert.equal(content.evidence.length, 2); assert.equal(content.index.entries.length, 1);
  const r = result(manifest, batch);
  r.candidates = [candidate(r, { evidenceIds: [s.records[2].id] })];
  assert.throws(() => checkFilterBatchResult(s.config, manifest, r), /retained reviewed batch members/);
});
test('missing duplicate foreign groups and unknown sharing eligibility fail closed', async t => {
  for (const change of [
    s => s.request.groups.pop(),
    s => s.request.groups[1].memberIds.push(s.records[0].id),
    s => s.request.groups[0].memberIds.push('foreign'),
    s => { s.request.sharing.materials[0].eligibility = 'unknown'; }
  ]) {
    const s = setup(t); change(s);
    await assert.rejects(prepareFilterBatches(s.config, s.request, s.path, counter));
    assert.equal(existsSync(s.path), false);
  }
});
test('strict batch result membership rejects missing duplicate foreign and stale evidence', async t => {
  const s = setup(t), manifest = await prepared(s), valid = result(manifest, manifest.batches[0]);
  for (const change of [
    r => r.titles.decisions.pop(),
    r => r.titles.decisions.push(r.titles.decisions[0]),
    r => { r.titles.decisions[0].source.revision = 'stale'; },
    r => { r.batchId = 'foreign'; },
    r => { r.payloadSha256 = '0'.repeat(64); },
    r => r.details.pop(),
    r => r.details.push(r.details[0]),
    r => { r.details[0].recordSha256 = '0'.repeat(64); }
  ]) {
    const changed = structuredClone(valid); change(changed);
    assert.throws(() => checkFilterBatchResult(s.config, manifest, changed));
  }
  assert.equal(checkFilterBatchResult(s.config, manifest, valid).state, 'checked-not-qualified');
  const { ledger } = openApp(s.sourceConfig, 'source');
  const changed = structuredClone(s.records[0]); changed.source.revision = '2';
  ledger.evidence(changed, { revised: true }, 'source:ado:created'); ledger.close();
  assert.throws(() => checkFilterBatchResult(s.config, manifest, valid), /source snapshot changed|sharing eligibility/);
});
test('missing failed partial and conflicting batches prevent candidate selection deterministically', async t => {
  const s = setup(t), manifest = await prepared(s), all = manifest.batches.map(b => result(manifest, b));
  all[0].candidates.push(candidate(all[0]));
  assert.equal(consolidateFilterBatches(s.config, manifest, all.slice(0, 1)).selected, null);
  const partial = structuredClone(all);
  partial[1].status = 'failed'; partial[1].titles.decisions = []; partial[1].details = [];
  const failed = consolidateFilterBatches(s.config, manifest, partial);
  assert.equal(failed.state, 'partial'); assert.equal(failed.selected, null);
  assert.equal(failed.accounting[1].members[0].status, 'failed');
  partial[1].status = 'partial';
  assert.equal(consolidateFilterBatches(s.config, manifest, partial).state, 'partial');
  const conflicting = structuredClone(all[0]); conflicting.details[0].reason = 'Conflicting receipt';
  const left = consolidateFilterBatches(s.config, manifest, [...all, conflicting]);
  const right = consolidateFilterBatches(s.config, manifest, [conflicting, ...all].reverse());
  assert.deepEqual(left, right); assert.equal(left.selected, null); assert.equal(left.conflicts.length, 1);
});
test('dedup, audit ranking, E2E selection and immutable consolidation preserve one-candidate bound', async t => {
  const s = setup(t), manifest = await prepared(s), all = manifest.batches.map(b => result(manifest, b));
  for (const r of all) r.candidates.push(candidate(r));
  all[0].candidates.push(candidate(all[0], { id: 'lower', missingAssertion: 'Another invariant', priority: 20 }));
  const path = join(s.root, 'consolidated.json');
  const consolidated = consolidateFilterBatches(s.config, manifest, [...all, all[0]], path);
  assert.equal(consolidated.state, 'complete-held');
  assert.equal(consolidated.ranking.length, 2); assert.equal(consolidated.duplicates.length, 1);
  assert.equal(consolidated.selected.definition.layer, 'e2e');
  assert.equal(consolidated.selected.evidenceIds.length, 2);
  assert.equal(consolidated.dispatchAllowed, false);
  assert.deepEqual(consolidateFilterBatches(s.config, manifest, [...all, all[0]], path), consolidated);
  assert.throws(() => consolidateFilterBatches(s.config, manifest, [], path), /output conflict/);
  const changed = structuredClone(all); changed[1].candidates[0].rationale = 'Conflicting claim';
  assert.equal(consolidateFilterBatches(s.config, manifest, changed).selected, null);
});
test('integration-first deferral preserves E2E findings without selecting or excluding them', async t => {
  const s = setup(t), manifest = await prepared(s), all = manifest.batches.map(b => result(manifest, b));
  const blocker = 'Deferred: E2E capability setup is outside the integration-first milestone';
  for (const r of all) r.candidates.push(candidate(r, { priority: 100, blockers: [blocker] }));
  const before = JSON.stringify(all), deferred = consolidateFilterBatches(s.config, manifest, all);
  assert.equal(deferred.state, 'complete-held');
  assert.equal(deferred.selected, null);
  assert.equal(deferred.ranking.length, 1);
  assert.equal(deferred.ranking[0].definition.layer, 'e2e');
  assert.equal(deferred.ranking[0].definition.coverageStatus, 'gap');
  assert.deepEqual(deferred.ranking[0].definition.blockers, [blocker]);
  assert.equal(deferred.ranking[0].evidenceIds.length, 2);
  assert.equal(JSON.stringify(all), before);
  all[0].candidates.push(candidate(all[0], { id: 'integration', layer: 'integration',
    harness: 'existing supported integration suite', priority: 20 }));
  const combined = consolidateFilterBatches(s.config, manifest, all);
  assert.equal(combined.selected.definition.layer, 'integration');
  assert.equal(combined.ranking.length, 2);
  assert.deepEqual(combined.ranking[0], deferred.ranking[0]);
  assert.equal(combined.dispatchAllowed, false);
  assert.ok(all.every(r => r.titles.decisions.every(d => d.disposition !== 'screen-out')));
});
test('empty/all-excluded/no-candidate populations consolidate without inventing a candidate', async t => {
  for (const count of [0, 1]) {
    const s = setup(t, count), manifest = await prepared(s);
    const results = manifest.batches.map(b => result(manifest, b));
    assert.equal(consolidateFilterBatches(s.config, manifest, results).selected, null);
    if (count) {
      // The fixture has an absent title, which may not be excluded.
      results[0].titles.decisions[0].disposition = 'screen-out';
      assert.throws(() => checkFilterBatchResult(s.config, manifest, results[0]), /no-title/);
    }
  }
  const s = setup(t, 2), manifest = await prepared(s), r = result(manifest, manifest.batches[0]);
  r.titles.decisions.find(d => d.disposition === 'needs-details').disposition = 'screen-out';
  const excluded = r.titles.decisions.find(d => d.disposition === 'screen-out');
  Object.assign(excluded, { exclusionType: 'confirmed_non_bug', reason: 'Synthetic reviewed title audit', titleQuote: 'Functional' });
  r.details.find(d => d.evidenceId === excluded.evidenceId).status = 'excluded-title';
  assert.equal(consolidateFilterBatches(s.config, manifest, [r]).selected, null);
  const excludedOnly = setup(t, 1, false, ['Copy-only punctuation']);
  const m = await prepared(excludedOnly), allExcluded = result(m, m.batches[0]);
  Object.assign(allExcluded.titles.decisions[0], { disposition: 'screen-out', exclusionType: 'copy_text_only',
    reason: 'Explicit copy-only title', titleQuote: 'Copy-only punctuation' });
  allExcluded.details[0].status = 'excluded-title';
  const consolidated = consolidateFilterBatches(excludedOnly.config, m, [allExcluded]);
  assert.equal(consolidated.state, 'complete-held'); assert.equal(consolidated.selected, null);
  assert.equal(consolidated.accounting[0].members[0].status, 'excluded-title');
});
test('Stage2 binds consolidated selected IDs and rejects unresolved batches', async t => {
  const s = setup(t), manifest = await prepared(s), all = manifest.batches.map(b => result(manifest, b));
  all[0].candidates.push(candidate(all[0]));
  const resultPaths = all.map((r, i) => {
    const path = join(s.root, `result-${i}.json`); writeFileSync(path, bytes(r)); return path;
  });
  const binding = { manifestPath: s.path, resultPaths };
  assert.equal(bindFilterConsolidation(s.config, binding).retainedIds.length, 1);
  assert.throws(() => bindFilterConsolidation(s.config, { ...binding, resultPaths: [] }), /unresolved/);
  s.config.stage2 = { skillDirectory: join(s.root, coverageSkillName) };
  mkdirSync(join(s.config.stage2.skillDirectory, 'references'), { recursive: true });
  writeFileSync(join(s.config.stage2.skillDirectory, 'SKILL.md'),
    `name: ${coverageSkillName}\nreferences/coverage-map.md`);
  writeFileSync(join(s.config.stage2.skillDirectory, 'references', 'coverage-map.md'), 'Synthetic only');
  const output = join(s.root, 'stage2.json');
  prepareStage2(s.config, { format: 'stage2-sources-v1', sources: s.request.sources, batchReview: binding }, output);
  assert.equal(readJson(output).sources[0].evidenceRefs.length, 1);
});
test('selected FILTER evidence prepares the real proposer assignment without a fixture adapter', async t => {
  const s = setup(t, 1, false, ['Authenticated functional issue'], false, 'authenticated-source');
  const manifest = await prepared(s), reviewed = result(manifest, manifest.batches[0]);
  const sourceRevision = 'b'.repeat(40);
  reviewed.candidates.push(candidate(reviewed, {
    repository: 'target-repo', sourceRevision, layer: 'integration',
    harness: 'target integration harness'
  }));
  const resultPath = join(s.root, 'filter-result.json');
  writeFileSync(resultPath, bytes(reviewed));
  const skillPath = '.github/skills/integration-test-authoring/SKILL.md';
  s.config.stateDirectory = join(s.root, 'target-state');
  s.config.limits.maxItems = 10;
  s.config.limits.workerMaxToolCalls = 20;
  s.config.repositories = [{
    id: 'target-repo',
    projectId: 'fixture-project',
    owner: 'fixture-owner',
    routingApproved: true,
    routingRules: ['FILTER proposer handoff'],
    referenceCheckout: s.root,
    baseRef: 'HEAD',
    remote: 'https://example.invalid/target.git',
    allowedWritePrefixes: ['test'],
    commitIdentity: { name: 'Fixture', email: 'fixture@example.invalid' },
    validationGates: [{
      id: 'fixture-test',
      approved: true,
      isolationVerified: true,
      executable: process.execPath,
      args: ['--test'],
      timeoutMs: 10000
    }],
    skillBindings: [{
      id: 'target-integration',
      capability: 'integration-test-authoring',
      skillPath,
      inputFormat: 'declarative-e2e-mini-spec-batch-v1',
      enabled: true,
      qualification: 'qualified',
      requestedOutcomes: ['add-or-update-tests'],
      allowedWritePrefixes: ['test'],
      requiresBehaviorCard: true,
      sideEffects: { commit: true, push: true, createDraftPR: true }
    }]
  }];
  const ledger = new Ledger(s.config.stateDirectory);
  const validationContract = repositoryValidationContract(s.config.repositories[0]);
  ledger.qualify(skillQualificationId('target-repo', 'target-integration'), {
    state: 'qualified-read-only',
    repoId: 'target-repo',
    bindingId: 'target-integration',
    capability: 'integration-test-authoring',
    referenceCheckout: s.root,
    remote: 'https://example.invalid/target.git',
    baseRef: 'HEAD',
    baseRevision: sourceRevision,
    skillPath,
    skillSha256: hash('fixture skill'),
    qualificationSource: 'local-reference',
    validationContractVersion: validationContract.version,
    validationContractSha256: validationContract.sha256,
    sideEffects: { commit: true, push: true, createDraftPR: true }
  });
  s.cleanup.push(() => ledger.close());
  const input = {
    format: 'filter-proposer-handoff-v1',
    filter: { manifestPath: s.path, resultPaths: [resultPath] },
    routing: {
      capability: 'integration-test-authoring',
      skillInput: {
        format: 'declarative-e2e-mini-spec-batch-v1',
        items: [{
          inputItemId: 'filter-authored-canary',
          title: 'Author a reviewed FILTER canary',
          account: 'AAD',
          entryUrl: 'https://example.invalid/chat',
          preconditions: ['Use the qualified signed-in profile'],
          orderedTestSteps: ['Open the entry URL', 'Perform the reviewed workflow'],
          expectedUserVisibleAndDataOutcomes: ['The reviewed outcome is visible'],
          cleanup: ['Close only the test-owned tab']
        }]
      }
    }
  };
  const preparedHandoff = prepareFilterProposerHandoff(s.config, ledger, input);
  assert.equal(preparedHandoff.candidate.definition.repository, 'target-repo');
  assert.equal(preparedHandoff.evidence[0].source.provenance, 'authenticated-source');
  assert.equal(preparedHandoff.investigation.review.reviewer, 'FILTER:synthetic-filter');
  assert.equal(preparedHandoff.testCoveragePlan.sourceRevision, sourceRevision);
  assert.deepEqual(preparedHandoff.testCoveragePlan.skillInput, input.routing.skillInput);
  assert.deepEqual(preparedHandoff.assignment.skillInput, input.routing.skillInput);
  assert.equal(preparedHandoff.assignment.skillBindingId, 'target-integration');
  assert.equal(preparedHandoff.job.state, 'prepared');
  const replay = prepareFilterProposerHandoff(s.config, ledger, input);
  assert.equal(replay.assignment.id, preparedHandoff.assignment.id);
  assert.equal(ledger.all('evidence').length, 1);
  assert.equal(ledger.all('investigation').length, 1);
  const configPath = join(s.root, 'target-config.json');
  const inputPath = join(s.root, 'filter-handoff.json');
  writeFileSync(configPath, bytes(s.config));
  writeFileSync(inputPath, bytes(input));
  const cli = spawnSync(process.execPath, [
    'src\\cli.js', 'submit-filter-handoff',
    '--file', inputPath, '--config', configPath, '--prepare'
  ], { encoding: 'utf8' });
  assert.equal(cli.status, 0, cli.stderr);
  assert.equal(JSON.parse(cli.stdout).assignment.id, preparedHandoff.assignment.id);
  assert.throws(() => prepareFilterProposerHandoff(
    s.config, ledger, input, { intent: 'defect-fix' }),
  /test-only and cannot become a defect-fix/);
  const productFixes = ['https://example.invalid/product/pull/43', 'https://example.invalid/product/pull/42'];
  reviewed.candidates[0].existingFixes = productFixes;
  writeFileSync(resultPath, bytes(reviewed));
  assert.throws(() => prepareFilterProposerHandoff(s.config, ledger, input), /Existing fix requires/);
  input.routing.existingFixesReview = {
    investigationId: preparedHandoff.investigation.id,
    investigationVersion: preparedHandoff.investigation.version + 1,
    evidenceIds: preparedHandoff.investigation.evidenceIds,
    planId: preparedHandoff.testCoveragePlan.id, planVersion: preparedHandoff.testCoveragePlan.version + 1,
    sourceRevision,
    review: { method: s.config.reviewMethod, reviewer: 'synthetic-coverage-agent', reviewedAt: now() },
    fixes: productFixes.map(url => ({ url, disposition: 'product-fix-with-remaining-coverage-gap',
      rationale: 'The retained product fix does not include this source-bound regression assertion.' }))
  };
  assert.throws(() => prepareFilterProposerHandoff(s.config, ledger, input), /Prior assignment exists/);
  const reviewedLedger = new Ledger(join(s.root, 'reconciled-target'));
  s.cleanup.push(() => reviewedLedger.close());
  reviewedLedger.qualify(skillQualificationId('target-repo', 'target-integration'),
    ledger.qualification(skillQualificationId('target-repo', 'target-integration')));
  input.routing.existingFixesReview.investigationVersion = 1;
  input.routing.existingFixesReview.planVersion = 1;
  const reconciled = prepareFilterProposerHandoff(s.config, reviewedLedger, input);
  assert.deepEqual(reconciled.investigation.existingFixes, [...productFixes].sort());
  assert.deepEqual(reconciled.testCoveragePlan.existingFixesReview, input.routing.existingFixesReview);
  assert.equal(prepareFilterProposerHandoff(s.config, reviewedLedger, input).assignment.id, reconciled.assignment.id);
  delete reviewed.candidates[0].existingFixes;
  writeFileSync(resultPath, bytes(reviewed));
  const withoutReview = structuredClone(input); delete withoutReview.routing.existingFixesReview;
  assert.throws(() => prepareFilterProposerHandoff(s.config, reviewedLedger, withoutReview), /Existing fix requires/);
  assert.deepEqual(reviewedLedger.get('investigation', reconciled.investigation.id).existingFixes, [...productFixes].sort());
  ledger.qualify(skillQualificationId('target-repo', 'target-integration'), {
    ...ledger.qualification(skillQualificationId('target-repo', 'target-integration')),
    baseRevision: 'c'.repeat(40)
  });
  assert.throws(() => prepareFilterProposerHandoff(s.config, ledger, input),
    /different source revisions/);
});
test('offline CLI uses pinned tokenizer command and does not create a main writable ledger', async t => {
  const s = setup(t, 1), tokenizer = join(s.root, 'counter.cjs');
  writeFileSync(tokenizer, "let s='';process.stdin.on('data',d=>s+=d);process.stdin.on('end',()=>{let i=JSON.parse(s);console.log(JSON.stringify({sha256:i.sha256,model:i.model,tokenizer:i.tokenizer,tokens:i.text.length}));});");
  Object.assign(s.config.filterBatching, { contextTokens: 1000000, maxInputTokens: 100000,
    counter: { approved: true, executable: process.execPath, executableSha256: hash(readFileSync(process.execPath)),
      args: [tokenizer], files: [{ path: tokenizer, sha256: hash(readFileSync(tokenizer)) }], timeoutMs: 10000 } });
  s.config.filterBatching.reserves.instructions = 100;
  s.config.stateDirectory = join(s.root, 'must-not-create');
  const configPath = join(s.root, 'pilot.local.json'), inputPath = join(s.root, 'request.json');
  writeFileSync(configPath, bytes(s.config)); writeFileSync(inputPath, bytes(s.request));
  const run = spawnSync(process.execPath, ['src/cli.js', 'filter-batches', '--file', inputPath,
    '--output', s.path, '--config', configPath], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr); assert.equal(existsSync(s.config.stateDirectory), false);
  const manifest = readJson(s.path), resultPath = join(s.root, 'result.json'), paths = join(s.root, 'paths.json');
  writeFileSync(resultPath, bytes(result(manifest, manifest.batches[0]))); writeFileSync(paths, bytes([resultPath]));
  for (const args of [
    ['filter-batch-check', '--file', resultPath, '--manifest', s.path],
    ['filter-consolidate', '--file', paths, '--manifest', s.path, '--output', join(s.root, 'out.json')]
  ]) {
    const child = spawnSync(process.execPath, ['src/cli.js', ...args, '--config', configPath], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
  }
  assert.equal(existsSync(s.config.stateDirectory), false);
});
for (const mode of ['local-policy', 'missing', 'valid', 'partial-cohort', 'delivered-module', 'changed-module',
  'digest-valid', 'digest-publication-unknown', 'digest-wrong-hash',
  'digest-wrong-byte-length', 'digest-wrong-stdout-hash', 'digest-unqualified',
  'digest-source-missing', 'digest-source-dirty', 'digest-source-revision',
  'digest-source-build', 'digest-source-preflight', 'digest-source-failed',
  'wrong-job', 'wrong-input', 'wrong-verifier', 'failed',
  'wrong-step', 'wrong-definition', 'wrong-build', 'model-prose', 'wrong-serialization',
  'wrong-pipeline-source', 'wrong-bootstrap', 'invalid-execution-id',
  'wrong-source', 'wrong-length', 'missing-capture', 'all-excluded'])
test(`integrated FILTER worker capture execution gate: ${mode}`, async t => {
  const count = mode === 'partial-cohort' ? 3 : 1;
  // Authenticated-shaped fixtures exercise the production handoff without live sources.
  const s = setup(t, count, false, Array(count).fill('Telemetry only'), true,
    mode === 'local-policy' ? 'authenticated-source' : 'synthetic');
  const manifest = await prepared(s), batch = manifest.batches[0];
  let verifierPath = resolve('src/filter-capture-verifier.js');
  const verifierSha256 = hash(readFileSync(verifierPath));
  if (['delivered-module', 'changed-module'].includes(mode)) {
    const content = readFileSync(verifierPath);
    verifierPath = join(s.root, 'filter-capture-verifier.mjs');
    writeFileSync(verifierPath, mode === 'changed-module' ? Buffer.concat([content, Buffer.from('\n')]) : content);
  }
  const checkout = join(s.root, 'synthetic-checkout'); mkdirSync(checkout);
  const git = args => {
    const child = spawnSync('git', ['-C', checkout, '-c', 'core.autocrlf=false',
      '-c', 'core.safecrlf=false', ...args], { encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr); return child.stdout.trim();
  };
  git(['init', '--quiet']);
  if (mode === 'local-policy') {
    writeProposerSource(checkout);
    git(['add', '.']);
  }
  git(['-c', 'user.name=Synthetic test', '-c', 'user.email=synthetic@example.invalid',
    '-c', 'core.hooksPath=missing-hooks', 'commit', '--quiet', '--allow-empty', '-m', 'Synthetic verifier source']);
  const sourceRevision = git(['rev-parse', 'HEAD']);
  const r = result(manifest, batch);
  if (['local-policy', 'valid', 'digest-valid'].includes(mode))
    r.candidates.push(candidate(r, { sourceRevision }));
  if (mode === 'all-excluded') {
    Object.assign(r.titles.decisions[0], { disposition: 'screen-out', exclusionType: 'telemetry_only',
      titleQuote: 'Telemetry', reason: 'Explicit telemetry-only title' });
    r.details[0].status = 'excluded-title';
  }
  const resultBytes = bytes(r);
  const ledger = new Ledger(join(s.root, 'isolated-executor'));
  s.cleanup.push(() => ledger.close());
  s.config.activation.dispatch = true; s.config.limits.maxWorkers = 2;
  const profile = { organization: 'synthetic', project: 'synthetic', repository: 'synthetic', initMode: 'lite' };
  const caseContract = { cases: [], scenarios: [], commands: [] };
  const selection = { taskId: batch.id, repoId: 'synthetic', role: 'filter', suiteId: 'source-analysis',
    profileId: 'synthetic', qualificationId: 'synthetic-qualification', qualificationSha256: '',
    sourceRevision, targetRef: 'refs/heads/main', payloadSha256: batch.payloadSha256,
    analysisPayloadSha256: batch.analysisPayloadSha256, instructionsSha256: hash(s.request.instructions),
    resultKind: 'analysis', allowPush: false, dispatchAllowed: true, maxExecutionSeconds: 600,
    allowedPaths: [], forbiddenPaths: [], caseContract };
  const q = { status: 'qualified', binding: {
    repoId: selection.repoId, role: selection.role, suiteId: selection.suiteId, profileId: selection.profileId,
    profileSha256: hash(json(profile)), sourceRevision, targetRef: selection.targetRef,
    instructionsSha256: selection.instructionsSha256, caseContractSha256: hash(json(caseContract))
  }, runtime: { modelId: s.config.filterBatching.model, tokenizerId: s.config.filterBatching.tokenizer,
    contextTokens: 1000000, maxOutputTokens: 10000 },
  expiresAt: new Date(Date.now() + 3600000).toISOString(), evidenceRef: 'synthetic:offline-only' };
  selection.captureVerification = { protocol: captureVerificationProtocol, verifierSha256,
    pipelineDefinitionId: 'synthetic-definition', stepName: 'SyntheticCaptureGate',
    pipelineSourceRevision: sourceRevision, bootstrapSha256: hash('synthetic bootstrap') };
  if (mode.startsWith('digest-') && mode !== 'digest-unqualified') {
    selection.captureVerification.inputEvidenceKind = 'source-bound-stdin-digest-v1';
    selection.captureVerification.agentProfileSha256 = hash('synthetic reader profile');
    selection.captureVerification.sourceAttestationStepName = 'AgencyFilterSourceAttestation';
  }
  q.binding.captureVerification = selection.captureVerification;
  const localPolicy = { id: 'local-readonly-filter-v1', approvedBy: 'synthetic-user',
    approvedAt: now(), approvalRef: 'synthetic:explicit-policy-approval' };
  if (mode === 'local-policy') {
    delete selection.captureVerification;
    delete q.binding.captureVerification;
    selection.analysisPolicy = localPolicy;
    q.binding.analysisPolicy = localPolicy;
  }
  selection.qualificationSha256 = hash(json(q)); ledger.qualify(selection.qualificationId, q);
  s.config.agency = { profiles: { synthetic: profile }, selections: [selection], budgetId: 'synthetic-filter-run',
    maxRequests: 1, maxConcurrent: 2, maxDraftPullRequests: 0, maxExecutionSeconds: 600,
    preflightMaxAgeSeconds: 300, monitorOwner: 'synthetic-owner', monitorCadenceSeconds: 60 };
  const wire = { organization: profile.organization, project: profile.project, repository: profile.repository,
    targetBranch: 'main', prompt: batch.payload,
    options: { allowPush: false, pullRequest: { create: false, publish: false } }, metadata: { initMode: 'lite' } };
  if (mode === 'local-policy') wire.options.branch = { createSourceBranch: false };
  if (selection.captureVerification?.inputEvidenceKind) {
    Object.assign(wire, { sourceBranch: 'refs/heads/main', targetBranch: 'refs/heads/main',
      agent: { name: 'filter-evidence-reader', type: 'Repo' }, metadata: agencyFilterRunnerMetadata(selection) });
    wire.options.branch = { createSourceBranch: false };
  }
  const request = json(wire);
  const reservation = { request, requestSha256: hash(request),
    preflight: { repoId: selection.repoId, targetRef: selection.targetRef, sourceRevision,
      observedAt: now(), requestSha256: hash(request) },
    tokenBudget: { payloadSha256: batch.payloadSha256, modelId: q.runtime.modelId,
      tokenizerId: q.runtime.tokenizerId, inputTokens: batch.tokenReceipt.tokens } };
  if (mode === 'local-policy') {
    const missingSelection = structuredClone(s.config); missingSelection.agency.selections = [];
    assert.throws(() => reserveAgencyRequest(missingSelection, ledger, batch.id, reservation, manifest),
      /no explicit Agency selection/);
    for (const value of [undefined, true]) {
      const altered = JSON.parse(request);
      if (value === undefined) delete altered.options.branch;
      else altered.options.branch.createSourceBranch = value;
      const invalid = { ...reservation, request: json(altered), requestSha256: hash(json(altered)) };
      assert.throws(() => reserveAgencyRequest(s.config, ledger, batch.id, invalid, manifest),
        /shape|disable source branch/);
    }
    assert.throws(() => reserveAgencyRequest(s.config, ledger, batch.id, reservation), /Invalid batch manifest/);
    const changed = structuredClone(manifest); changed.batches[0].payload += ' ';
    assert.throws(() => reserveAgencyRequest(s.config, ledger, batch.id, reservation, changed), /payload/);
  }
  reserveAgencyRequest(s.config, ledger, batch.id, reservation, manifest);
  recordAgencySubmission(ledger, batch.id, { operation: 'jobs-create', state: 'accepted',
    requestSha256: hash(request), jobId: 'synthetic-job', httpStatus: 202, observedAt: now() });
  const validate = data => {
    const checked = checkFilterBatchResult(s.config, manifest, JSON.parse(data));
    return Object.fromEntries(['state', 'payloadSha256', 'resultSha256', 'validator'].map(k => [k, checked[k]]));
  };
  const partial = structuredClone(r); partial.status = 'partial';
  assert.throws(() => recordAgencyAnalysisCheck(ledger, batch.id, bytes(partial), validate), /complete result/);
  if (['local-policy', 'valid', 'digest-valid'].includes(mode)) {
    for (const changed of [{ sourceRevision: 'b'.repeat(40) }, { repository: 'uninspected-repository' }]) {
      const invalid = structuredClone(r); Object.assign(invalid.candidates[0], changed);
      assert.equal(checkFilterBatchResult(s.config, manifest, invalid).state, 'checked-not-qualified');
      assert.throws(() => recordAgencyAnalysisCheck(ledger, batch.id, bytes(invalid), validate),
        /execution repository and source revision/);
      assert.equal(ledger.db.prepare(
        "SELECT body FROM agency_receipts WHERE task_id=? AND kind='analysis-check'").get(batch.id), undefined);
    }
  }
  const check = recordAgencyAnalysisCheck(ledger, batch.id, resultBytes, validate);
  assert.equal(check.payloadSha256, batch.analysisPayloadSha256);
  const refs = [{ ref: 'job-local:synthetic-job:derived-receipt', sha256: hash('synthetic proof') }];
  if (!['missing', 'all-excluded', 'local-policy'].includes(mode)) {
    const inspect = ({ input }) => {
      if (mode === 'valid') {
        const noncanonical = spawnSync(globalThis.process.execPath, [verifierPath, checkout], {
          input: bytes(input), encoding: 'utf8', maxBuffer: 1024 * 1024
        });
        assert.equal(noncanonical.status, 1);
        assert.equal(noncanonical.stdout, '');
        assert.match(noncanonical.stderr, /exact json-stringify-v1 serialization/);
      }
      const process = spawnSync(globalThis.process.execPath, [verifierPath, checkout], {
        input: json(input), encoding: 'utf8', maxBuffer: 1024 * 1024
      });
      if (mode === 'changed-module') {
        assert.equal(process.status, 1);
        assert.equal(process.stdout, '');
        assert.match(process.stderr, /Executed verifier bytes differ/);
        throw new Error('Observed standalone helper failed its pinned executable hash check');
      }
      assert.equal(process.status, 0, process.stderr);
      const actual = JSON.parse(process.stdout);
      assert.deepEqual(actual, verifyFilterCaptureInput(input, actual.source));
      const execution = { executionKind: 'pipeline-step', jobId: 'synthetic-job',
        executionId: '11111111-2222-4333-8444-555555555555',
        pipeline: { buildId: 'synthetic-build', definitionId: 'synthetic-definition', stepName: 'SyntheticCaptureGate',
          sourceRevision, bootstrapSha256: hash('synthetic bootstrap'),
          state: 'completed', result: 'succeeded', log: { id: 'synthetic-log', sha256: hash(process.stdout) } },
        verifierSha256, inputSerialization: 'json-stringify-v1', stdin: json(input),
        inputSha256: hash(json(input)), exitCode: process.status, stdout: process.stdout, evidenceRefs: refs };
      if (mode === 'wrong-job') execution.jobId = 'other-job';
      if (mode === 'invalid-execution-id') execution.executionId = 'model-tool-call-id';
      if (mode === 'wrong-input') execution.inputSha256 = '0'.repeat(64);
      if (mode === 'wrong-verifier') execution.verifierSha256 = '0'.repeat(64);
      if (mode === 'failed') execution.exitCode = 1;
      if (mode === 'wrong-step') execution.pipeline.stepName = 'OtherStep';
      if (mode === 'wrong-definition') execution.pipeline.definitionId = 'other-definition';
      if (mode === 'wrong-pipeline-source') execution.pipeline.sourceRevision = 'b'.repeat(40);
      if (mode === 'wrong-bootstrap') execution.pipeline.bootstrapSha256 = '0'.repeat(64);
      if (mode === 'wrong-build') execution.pipeline.buildId = 'other-build';
      if (mode === 'model-prose') execution.executionKind = 'model-final-response';
      if (mode === 'wrong-serialization') {
        execution.stdin = bytes(input); execution.inputSha256 = hash(execution.stdin);
      }
      if (mode === 'wrong-source') actual.source.finalRevision = 'b'.repeat(40);
      if (mode === 'wrong-length') actual.captures[0].byteLength++;
      if (mode === 'missing-capture') actual.captures = [];
      if (['wrong-source', 'wrong-length', 'missing-capture'].includes(mode)) execution.stdout = bytes(actual);
      if (mode.startsWith('digest-')) {
        const envelope = { format: 'agency-filter-capture-execution-v1', jobId: execution.jobId,
          executionKind: execution.executionKind, executionId: execution.executionId,
          pipeline: { buildId: execution.pipeline.buildId, definitionId: execution.pipeline.definitionId,
            sourceRevision, bootstrapSha256: execution.pipeline.bootstrapSha256, stepName: execution.pipeline.stepName },
          verifierSha256, inputSerialization: execution.inputSerialization, inputSha256: execution.inputSha256,
          inputEvidenceKind: 'source-bound-stdin-digest-v1',
          stdinByteLength: Buffer.byteLength(json(input), 'utf8'), exitCode: execution.exitCode, stdout: execution.stdout };
        if (mode === 'digest-wrong-hash') envelope.inputSha256 = '0'.repeat(64);
        if (mode === 'digest-wrong-byte-length') envelope.stdinByteLength++;
        if (mode === 'digest-wrong-stdout-hash') {
          actual.inputSha256 = '0'.repeat(64); envelope.stdout = bytes(actual);
        }
        return inspectAgencyCaptureLog({
          jobId: execution.jobId,
          pipeline: { buildId: execution.pipeline.buildId, definitionId: execution.pipeline.definitionId, sourceRevision },
          step: { executionId: execution.executionId, stepName: execution.pipeline.stepName,
            state: 'completed', result: 'succeeded', logId: 'synthetic-log' },
          logText: `AGENCY_FILTER_CAPTURE_RECEIPT_V1 ${json(envelope)}\n`, evidenceRefs: refs
        });
      }
      return execution;
    };
    if (['valid', 'partial-cohort', 'delivered-module', 'digest-valid', 'digest-publication-unknown', 'wrong-build'].includes(mode) ||
      mode.startsWith('digest-source-')) {
      const captureCheck = recordAgencyCaptureCheck(ledger, batch.id, inspect);
      assert.equal(captureCheck.captures.length, batch.memberIds.length);
      assert.equal(captureCheck.semanticReadingProven, false);
      if (mode === 'digest-valid') {
        assert.equal(captureCheck.inputEvidenceKind, 'source-bound-stdin-digest-v1');
        assert.equal(Object.hasOwn(captureCheck, 'stdin'), false);
      }
      assert.deepEqual(recordAgencyCaptureCheck(ledger, batch.id, inspect), captureCheck);
    } else assert.throws(() => recordAgencyCaptureCheck(ledger, batch.id, inspect),
      mode === 'changed-module' ? /Observed standalone helper failed its pinned executable hash check/ : undefined);
  }
  if (selection.captureVerification?.inputEvidenceKind && mode !== 'digest-source-missing') {
    const sourceEnvelope = { format: 'agency-filter-source-execution-v1', jobId: 'synthetic-job',
      executionKind: 'pipeline-step', executionId: '11111111-2222-4333-8444-666666666666',
      pipeline: { buildId: mode === 'digest-source-build' ? 'other-build' : 'synthetic-build',
        definitionId: 'synthetic-definition', sourceRevision, bootstrapSha256: hash('synthetic bootstrap'),
        stepName: mode === 'digest-source-preflight' ? 'SyntheticCaptureGate' : 'AgencyFilterSourceAttestation' },
      source: { repoId: selection.repoId, targetRef: selection.targetRef, revision: sourceRevision, status: '' } };
    if (mode === 'digest-source-dirty') sourceEnvelope.source.status = '?? unexpected.txt\n';
    if (mode === 'digest-source-revision') sourceEnvelope.source.revision = 'b'.repeat(40);
    const observed = { jobId: sourceEnvelope.jobId,
      pipeline: { buildId: sourceEnvelope.pipeline.buildId, definitionId: 'synthetic-definition', sourceRevision },
      step: { executionId: sourceEnvelope.executionId, stepName: sourceEnvelope.pipeline.stepName,
        state: 'completed', result: mode === 'digest-source-failed' ? 'failed' : 'succeeded', logId: 'source-log' },
      logText: `AGENCY_FILTER_SOURCE_RECEIPT_V1 ${json(sourceEnvelope)}\n`, evidenceRefs: refs };
    const inspect = () => inspectAgencySourceLog(observed);
    if (['digest-source-dirty', 'digest-source-revision', 'digest-source-preflight', 'digest-source-failed'].includes(mode))
      assert.throws(() => recordAgencySourceCheck(ledger, batch.id, inspect), /Post-analysis source|Observed worker pipeline|does not match/);
    else {
      const sourceCheck = recordAgencySourceCheck(ledger, batch.id, inspect);
      assert.deepEqual(recordAgencySourceCheck(ledger, batch.id, inspect), sourceCheck);
    }
  }
  const terminalInput = { requestSha256: hash(request),
    jobId: 'synthetic-job', observedAt: now(), provider: { state: 'Completed', result: 'Success' },
    pipeline: { id: 'synthetic-build', state: 'completed', result: 'succeeded' },
    runtime: { profileId: selection.profileId, instructionsSha256: selection.instructionsSha256,
      modelId: q.runtime.modelId, tokenizerId: q.runtime.tokenizerId },
    source: { repoId: selection.repoId, targetRef: selection.targetRef, baseRevision: sourceRevision,
      checkoutRevision: sourceRevision, outputRevision: sourceRevision, testedRevision: null,
      commitParents: [], changedPaths: [], unchangedDuringValidation: null, evidenceRefs: refs },
    inspection: { approved: true, evidenceRefs: refs },
    publication: ['digest-publication-unknown', 'local-policy'].includes(mode)
      ? { pushPerformed: null, createdPullRequests: null, otherPullRequestsModified: null, merged: null, pullRequest: null }
      : { pushPerformed: false, createdPullRequests: 0, otherPullRequestsModified: false, merged: false, pullRequest: null },
    validation: null,
    analysis: { payloadSha256: batch.analysisPayloadSha256, resultSha256: hash(resultBytes),
      validator: check.validator, membershipValidated: true, evidenceRefs: refs } };
  if (mode === 'local-policy') {
    terminalInput.source.outputRevision = null;
    terminalInput.source.changedPaths = null;
    terminalInput.source.commitParents = null;
  }
  const verdict = reconcileAgencyResult(ledger, batch.id, terminalInput);
  const success = ['local-policy', 'valid', 'partial-cohort', 'delivered-module', 'digest-valid', 'all-excluded'].includes(mode);
  assert.equal(verdict.state, success ? 'completed' : 'blocked');
  assert.equal(verdict.analysisPassed, success || mode === 'digest-publication-unknown' || mode.startsWith('digest-source-'));
  if (mode === 'digest-publication-unknown') {
    assert.equal(verdict.publicationPassed, false);
    assert.ok(verdict.reasons.some(r => r.includes('publication effects are unknown')));
  } else if (mode.startsWith('digest-source-'))
    assert.ok(verdict.reasons.some(r => r.includes('inspected post-analysis source proof')));
  else if (!success) assert.ok(verdict.reasons.some(r => r.includes('inspected worker capture-verifier execution')));
  assert.equal(verdict.validationQualified, false);
  if (['missing', 'local-policy'].includes(mode)) {
    const { evaluateFilterExecution, recordFilterExecutionEvaluation } = await import('../src/filter-execution.js');
    const original = ledger.db.prepare("SELECT body FROM agency_receipts WHERE task_id=? AND kind='terminal'").get(batch.id).body;
    const prospectiveInput = structuredClone(terminalInput);
    prospectiveInput.publication = null;
    const evaluation = recordFilterExecutionEvaluation(s.config, ledger, manifest, batch.id,
      resultBytes, prospectiveInput, localPolicy);
    assert.equal(evaluation.verdict.state, 'completed');
    assert.equal(evaluation.verdict.publicationPassed, null);
    assert.equal(evaluation.verdict.publicationPolicyPassed, true);
    assert.equal(evaluation.historicalCompliance, false);
    assert.ok(evaluation.verdict.assuranceLimitations.length);
    assert.deepEqual(recordFilterExecutionEvaluation(s.config, ledger, manifest, batch.id,
      resultBytes, prospectiveInput, localPolicy), evaluation);
    assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, [resultBytes], localPolicy).state,
      'complete-held');
    assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, [], localPolicy).state, 'blocked');
    for (const changed of [{ sourceRevision: 'b'.repeat(40) }, { repository: 'uninspected-repository' }]) {
      const invalid = structuredClone(r); Object.assign(invalid.candidates[0] ??= candidate(r), changed);
      assert.throws(() => evaluateFilterExecution(s.config, ledger, manifest, batch.id,
        bytes(invalid), prospectiveInput, localPolicy), /Candidate repository or source revision/);
    }
    for (const mutate of [
      i => { i.provider.result = 'Failure'; },
      i => { i.pipeline.result = 'failed'; },
      i => { i.source.checkoutRevision = 'b'.repeat(40); },
      i => { i.source.outputRevision = 'b'.repeat(40); },
      i => { i.source.changedPaths = ['test/changed.js']; },
      i => { i.analysis = null; },
      i => { i.analysis.resultSha256 = 'b'.repeat(64); },
      i => { i.publication = { pushPerformed: true, pullRequest: null,
        createdPullRequests: null, otherPullRequestsModified: null, merged: null }; },
      i => { i.publication = { pushPerformed: null, pullRequest: null,
        createdPullRequests: null, otherPullRequestsModified: null, merged: null, sourceBranchCreated: true }; }
    ]) {
      const invalid = structuredClone(prospectiveInput); mutate(invalid);
      assert.equal(evaluateFilterExecution(s.config, ledger, manifest, batch.id,
        resultBytes, invalid, localPolicy).verdict.state, 'blocked');
    }
    for (const mutate of [
      i => { i.jobId = 'other-job'; },
      i => { i.requestSha256 = 'b'.repeat(64); },
      i => { i.source.evidenceRefs = []; }
    ]) {
      const invalid = structuredClone(prospectiveInput); mutate(invalid);
      assert.throws(() => evaluateFilterExecution(s.config, ledger, manifest, batch.id,
        resultBytes, invalid, localPolicy));
    }
    const missing = structuredClone(r); missing.details = [];
    assert.throws(() => evaluateFilterExecution(s.config, ledger, manifest, batch.id,
      bytes(missing), prospectiveInput, localPolicy));
    const wrong = structuredClone(r); wrong.payloadSha256 = 'b'.repeat(64);
    assert.throws(() => evaluateFilterExecution(s.config, ledger, manifest, batch.id,
      bytes(wrong), prospectiveInput, localPolicy));
    assert.throws(() => evaluateFilterExecution(s.config, ledger, manifest, batch.id,
      json(r), prospectiveInput, localPolicy), /exact original/);
    assert.equal(ledger.db.prepare("SELECT body FROM agency_receipts WHERE task_id=? AND kind='terminal'").get(batch.id).body,
      original);
  }
  assert.equal(consolidateFilterBatches(s.config, manifest, [r]).state,
    mode === 'partial-cohort' ? 'partial' : 'complete-held');
  ledger.db.exec('PRAGMA query_only=ON');
  try {
    const cohort = reconcileFilterExecutionCohort(s.config, ledger, manifest, [resultBytes]);
    const complete = success && mode !== 'partial-cohort';
    assert.equal(cohort.state, complete ? 'complete-held' : 'blocked');
    assert.equal(cohort.dispatchAllowed, false);
    assert.equal(cohort.sourceCoverageComplete, null);
    if (complete) assert.equal(cohort.consolidation.format, 'filter-consolidation-v1');
    else assert.equal(cohort.consolidation, null);
    if (mode === 'valid') {
      assert.equal(reconcileFilterExecutionCohort(s.config, ledger, manifest, []).state, 'blocked');
      const changedConfig = structuredClone(s.config);
      changedConfig.agency.selections[0].sourceRevision = 'b'.repeat(40);
      assert.equal(reconcileFilterExecutionCohort(changedConfig, ledger, manifest, [resultBytes]).state, 'blocked');
      assert.throws(() => reconcileFilterExecutionCohort(s.config, ledger, manifest, [json(r)]),
        /canonical membership check/);
    }
  } finally {
    ledger.db.exec('PRAGMA query_only=OFF');
  }
  if (mode === 'local-policy')
    await t.test('accepted FILTER analysis reaches source-bound declarative proposer execution offline',
      () => exerciseFilterProposer(s, ledger, checkout, git, manifest, r));
  if (mode === 'valid') {
    for (const [name, changed] of [
      ['source', { sourceRevision: 'b'.repeat(40) }],
      ['repository', { repository: 'uninspected-repository' }]
    ]) {
      const invalid = structuredClone(r); Object.assign(invalid.candidates[0], changed);
      const invalidBytes = bytes(invalid), invalidHash = hash(invalidBytes);
      const historical = new Ledger(join(s.root, `historical-${name}`));
      s.cleanup.push(() => historical.close());
      historical.qualify(selection.qualificationId, q);
      reserveAgencyRequest(s.config, historical, batch.id, reservation, manifest);
      for (const row of ledger.db.prepare('SELECT kind,body FROM agency_receipts WHERE task_id=?').all(batch.id)) {
        const receipt = JSON.parse(row.body);
        if (['analysis-check', 'capture-requirements'].includes(row.kind)) receipt.resultSha256 = invalidHash;
        if (row.kind === 'terminal') receipt.receipt.analysis.resultSha256 = invalidHash;
        historical.db.prepare('INSERT INTO agency_receipts VALUES(?,?,?)').run(batch.id, row.kind, json(receipt));
      }
      historical.db.exec('PRAGMA query_only=ON');
      const before = historical.db.prepare('SELECT kind,body FROM agency_receipts ORDER BY kind').all();
      const blocked = reconcileFilterExecutionCohort(s.config, historical, manifest, [invalidBytes]);
      assert.equal(blocked.state, 'blocked');
      assert.equal(blocked.consolidation, null);
      assert.match(blocked.batches[0].reasons[0], /Candidate repository or source revision/);
      assert.deepEqual(historical.db.prepare('SELECT kind,body FROM agency_receipts ORDER BY kind').all(), before);
    }
    const config = structuredClone(s.config);
    config.stateDirectory = join(s.root, 'must-not-initialize');
    const configPath = join(s.root, 'cli-config.json'), resultPath = join(s.root, 'cli-result.json');
    const pathsPath = join(s.root, 'cli-results.json');
    writeFileSync(configPath, bytes(config));
    writeFileSync(resultPath, resultBytes);
    writeFileSync(pathsPath, bytes([resultPath]));
    const ledgerPath = join(ledger.directory, 'ledger.sqlite');
    const before = ledger.db.prepare('SELECT kind,body FROM agency_receipts ORDER BY kind').all();
    const check = path => spawnSync(globalThis.process.execPath, ['src/cli.js', 'filter-execution-check',
      '--config', configPath, '--file', pathsPath, '--manifest', s.path, '--ledger', path], { encoding: 'utf8' });
    const complete = check(ledgerPath);
    assert.equal(complete.status, 0, complete.stderr);
    assert.equal(JSON.parse(complete.stdout).state, 'complete-held');
    writeFileSync(pathsPath, '[]');
    const incomplete = check(ledgerPath);
    assert.equal(incomplete.status, 2);
    assert.equal(JSON.parse(incomplete.stdout).state, 'blocked');
    const missingLedger = join(s.root, 'missing-ledger.sqlite');
    assert.equal(check(missingLedger).status, 1);
    assert.equal(existsSync(missingLedger), false);
    assert.equal(existsSync(config.stateDirectory), false);
    assert.deepEqual(ledger.db.prepare('SELECT kind,body FROM agency_receipts ORDER BY kind').all(), before);
  }
  assert.throws(() => reserveAgencyRequest(s.config, ledger, batch.id, reservation, manifest), /already reserved/);
});

test('source-bound cohort inspection does not initialize Agency tables in an unstarted ledger', async t => {
  const s = setup(t), manifest = await prepared(s), ledger = new Ledger(join(s.root, 'empty-executor'));
  s.cleanup.push(() => ledger.close());
  ledger.db.exec('PRAGMA query_only=ON');
  const before = ledger.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'agency_%'").get().n;
  const cohort = reconcileFilterExecutionCohort(s.config, ledger, manifest, []);
  assert.equal(cohort.state, 'blocked');
  assert.equal(cohort.consolidation, null);
  assert.equal(ledger.db.prepare("SELECT COUNT(*) n FROM sqlite_master WHERE name LIKE 'agency_%'").get().n, before);
});
