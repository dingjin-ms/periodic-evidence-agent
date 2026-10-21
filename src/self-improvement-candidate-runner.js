import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const controllerRoot = fileURLToPath(new URL('..', import.meta.url));
const fixtures = join(controllerRoot, 'test', 'fixtures', 'self-improvement');
const mode = process.argv[2];
let sequence = 0;
let started = false;
const pending = new Map();

function send(message) {
  return new Promise((resolve, reject) => process.send(message, error => error ? reject(error) : resolve()));
}

function request(kind, payload = {}) {
  const id = ++sequence;
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject });
    process.send({ type: 'request', id, kind, payload }, error => {
      if (error) { pending.delete(id); reject(error); }
    });
  });
}

async function runNative(input) {
  const { run } = await import('node:test');
  // node:test finishes on event-loop quiescence; the command channel must not keep it alive.
  process.channel.unref();
  const events = run({ files: [join(input.root, 'test', 'case.test.mjs')], isolation: 'none' });
  let failed = false;
  for await (const event of events) {
    if (!['test:start', 'test:pass', 'test:fail'].includes(event.type)) continue;
    if (event.type === 'test:fail') failed = true;
    await send({ type: 'native-case', event: event.type, name: event.data.name,
      nesting: event.data.nesting, skip: Boolean(event.data.skip), todo: Boolean(event.data.todo),
      diagnostic: event.type === 'test:fail'
        ? String(event.data.details?.error?.message ?? 'Native assertion failed').slice(0, 1000) : null });
  }
  return { status: failed ? 'failed' : 'completed' };
}

async function runController(input) {
  const { configAt, hash, json, now, requireThat } = await import('./common.js');
  const { Ledger } = await import('./ledger.js');
  const { evidenceEnvelope } = await import('./sources.js');
  const { recordAreaToImprove, recordTestCoveragePlan } = await import('./improvements.js');
  const { qualifyRepositorySkill, skillQualificationId } = await import('./repository-skills.js');
  const { command, dispatch, dispatchLocalValidationContinuation,
    makePlannedImprovementAssignment } = await import('./workers.js');
  const { prepareLocalValidationContinuation } = await import('./local-continuation.js');
  const workload = JSON.parse(readFileSync(join(fixtures, 'workload.json'), 'utf8'));
  requireThat(workload.episodes.some(episode =>
    episode.id === input.episode.id && json(episode) === json(input.episode)),
  'Unregistered synthetic episode', 'blocked-scope');
  const root = input.root;
  const healthy = input.episode.scenario === 'healthy';
  const config = configAt(join(controllerRoot, 'pilot.example.json'));
  config.stateDirectory = join(root, 'prior');
  config.executionMode = 'standalone-sdk';
  config.activation = { collect: false, review: false, dispatch: true };
  config.workspaceCleanup = { enabled: false, retentionHours: 0 };
  Object.assign(config.limits, {
    maxAiCreditsPerSession: 1, maxItems: 100, workerMaxToolCalls: 20, maxWorkers: 1,
    maxValidationRepairRounds: 0, maxValidationInfrastructureRetries: 0
  });
  const reference = join(root, 'reference'), remote = join(root, 'remote.git');
  const lfsPath = 'fixtures/native.xlsx', testPath = 'test/case.test.mjs';
  const skillPath = '.github/skills/test/SKILL.md';
  const content = Buffer.from('synthetic native input\n');
  mkdirSync(join(reference, '.github', 'skills', 'test'), { recursive: true });
  mkdirSync(join(reference, 'fixtures'));
  writeFileSync(join(reference, skillPath), '# Synthetic native assertion skill\n');
  writeFileSync(join(reference, lfsPath),
    `version https://git-lfs.github.com/spec/v1\noid sha256:${hash(content)}\nsize ${content.length}\n`);
  const git = args => command('git', ['-c', 'core.hooksPath=.git/no-hooks',
    '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false', ...args], reference, 10000);
  await git(['init', '--quiet']);
  await git(['add', '.']);
  await git(['-c', 'user.name=Synthetic Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m',
    'Synthetic fixture base\n\nCo-authored-by: Copilot App <223556219+Copilot@users.noreply.github.com>']);
  await git(['remote', 'add', 'origin', remote]);
  const baseRevision = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const repo = {
    id: 'fixture', owner: 'fixture-owner', routingApproved: true, routingRules: ['fixture'],
    referenceCheckout: reference, baseRef: 'HEAD', remote, qualificationRefresh: 'local',
    provisionTimeoutMs: 10000, validationContractVersion: 'synthetic-native-v1',
    allowedWritePrefixes: ['test'], allowedWriteFiles: [],
    commitIdentity: { name: 'Synthetic Fixture', email: 'fixture@example.invalid' },
    validationGates: [{
      id: 'native', approved: true, isolationVerified: true,
      executable: process.execPath, args: ['--test', testPath], timeoutMs: 10000,
      ...(healthy ? { lfsPaths: [lfsPath] } : {})
    }],
    skillBindings: [{
      id: 'native-test', capability: 'integration-test-authoring', skillPath,
      enabled: true, qualification: 'qualified', requestedOutcomes: ['add-or-update-tests'],
      allowedWritePrefixes: ['test'], requiresBehaviorCard: false,
      sideEffects: { commit: true, push: true, createDraftPR: true }
    }]
  };
  config.repositories = [repo];
  writeFileSync(join(root, 'prior-config.json'), json(config));
  const ledger = new Ledger(config.stateDirectory);
  let nextLedger;
  const proposal = {
    outcome: 'propose-change', findings: 'Added the pinned synthetic assertions',
    title: 'Add synthetic native assertions',
    description: 'Synthetic qualification only; validation not yet claimed',
    skillResult: {
      status: 'succeeded', classification: 'missing-coverage', changedFiles: [testPath],
      testsAddedOrUpdated: workload.coverage.required.map(item => item.caseId),
      behaviorCardsAddedOrUpdated: [], unknowns: [], needsHumanDecision: false
    }
  };
  writeFileSync(join(root, 'proposal.json'), json(proposal));
  try {
    const envelope = evidenceEnvelope('ado', 'fixture/project', '1', '1',
      'https://dev.azure.com/fixture/project/_workitems/edit/1',
      'synthetic protocol fixture', '2026-10-09T01:00:00Z');
    // Simulate the provider protocol only inside the disposable fixture, never in the RSI store.
    envelope.source.provenance = 'authenticated-source';
    envelope.sourceStatus = 'Resolved';
    envelope.fields = { 'System.State': 'Resolved', 'Microsoft.VSTS.Common.ResolvedReason': 'Fixed' };
    const evidence = ledger.evidence(envelope, { syntheticProtocolFixture: true }, 'fixture-run');
    const investigation = {
      recordType: 'investigation', schemaVersion: '1.0', id: 'fixture-investigation', version: 1,
      evidenceIds: [evidence.id], state: 'triaged', observedBehavior: 'Missing assertion',
      expectedBehavior: 'Assert the pinned synthetic input', hypotheses: [], counterEvidence: [],
      classification: 'functional', defectConfirmation: 'unconfirmed', reportEligibility: 'included',
      handoffEligibility: 'eligible', exclusionReasons: [], rationale: 'Synthetic qualification',
      confidence: 0.8, review: { method: 'human-review', reviewer: 'fixture', reviewedAt: now() },
      repoIds: [repo.id], existingFixes: [], nextAction: 'Add synthetic assertion'
    };
    ledger.put(investigation);
    const improvement = recordAreaToImprove(ledger, {
      investigationIds: [investigation.id], category: 'missing-test-coverage',
      theme: 'Synthetic assertion coverage', observedBehavior: investigation.observedBehavior,
      expectedBehavior: investigation.expectedBehavior, rationale: 'Synthetic qualification',
      priority: 'medium', repoIds: [repo.id], capabilities: ['integration-test-authoring']
    });
    const plan = recordTestCoveragePlan(ledger, {
      improvementId: improvement.id, improvementVersion: improvement.version, repoId: repo.id,
      capability: 'integration-test-authoring', sourceRevision: baseRevision,
      searchStatus: 'complete', existingTests: [], coverageGaps: ['Pinned assertions'],
      unknowns: [], rationale: 'Synthetic qualification'
    });
    ledger.qualify(skillQualificationId(repo.id, 'native-test'),
      await qualifyRepositorySkill(config, repo.id, 'integration-test-authoring', 'native-test'));
    const assignment = makePlannedImprovementAssignment(config, ledger, investigation, plan.id);
    ledger.prepare(assignment);
    await request('checkpoint', { phase: 'prepared' });
    const validate = phase => async (_config, store, job, _repo, revision) => {
      const operationId = `fixture-validation-${phase}`;
      store.operation(operationId, job.id, 'validation', { revision });
      const response = await request('validation', { phase, revision });
      store.finishOperation(operationId, response.status, { revision });
      return [{
        gateId: 'native', sourceRevision: revision, status: response.status,
        artifactRefs: [response.artifactPath], commandOrRunUrl: 'synthetic-native',
        owner: repo.owner, nextCheckAt: null, attemptCount: 1, blockedReason: null
      }];
    };
    const publication = {
      pushBranch: async () => { await request('push'); },
      createDraft: async (_config, _store, _job, _repo, revision) => {
        await request('draft', { revision });
        return { url: 'https://example.invalid/synthetic-draft/1', isDraft: true, headRevision: revision };
      }
    };
    let initial;
    try {
      initial = await dispatch(config, ledger, assignment.id, {
        runModel: async (_config, _store, _job, _assignment, _investigation, toolkit) => {
          await request('deterministic-authoring');
          toolkit.write(testPath, readFileSync(join(fixtures, 'native-case.txt'), 'utf8'));
          toolkit.finish(structuredClone(proposal));
        },
        runValidation: validate(healthy ? 'healthy' : 'prior'), ...publication
      });
    } catch (error) {
      return { status: 'target-failed', code: error.code ?? 'failed' };
    }
    await request('checkpoint', { phase: 'initial-complete' });
    if (healthy) return { status: 'completed', workerOutcome: initial.outcome };
    const nextConfig = structuredClone(config);
    nextConfig.stateDirectory = join(root, 'next');
    nextConfig.repositories[0].validationGates[0].lfsPaths = [lfsPath];
    writeFileSync(join(root, 'next-config.json'), json(nextConfig));
    nextLedger = new Ledger(nextConfig.stateDirectory);
    const authorization = await request('unblock');
    if (input.episode.scenario === 'changed-proof')
      writeFileSync(authorization.provisioningProofPath, '{}');
    let continued;
    try {
      continued = await prepareLocalValidationContinuation(config, ledger, assignment.id,
        nextConfig, nextLedger, authorization, proposal);
    } catch (error) {
      if (input.episode.scenario === 'changed-proof') {
        await request('guard-refusal', { guard: 'changed-proof', code: error.code ?? 'failed' });
        return { status: 'completed' };
      }
      return { status: 'target-failed', code: error.code ?? 'failed' };
    }
    if (input.episode.scenario === 'changed-proof')
      return { status: 'target-failed', code: 'guard-admitted' };
    await request('checkpoint', { phase: 'continuation-prepared' });
    let result;
    try {
      result = await dispatchLocalValidationContinuation(nextConfig, nextLedger, continued.assignment.id, {
        runModel: async () => {
          await request('forbidden-model');
          throw new Error('A continuation must never invoke authoring');
        },
        runValidation: validate('recovery'), ...publication
      });
    } catch (error) { return { status: 'target-failed', code: error.code ?? 'failed' }; }
    await request('checkpoint', { phase: 'continued' });
    if (input.episode.scenario === 'duplicate-dispatch') {
      for (const guard of ['duplicate-prepare', 'duplicate-dispatch']) {
        await request('guard-start', { guard });
        try {
          if (guard === 'duplicate-prepare')
            await prepareLocalValidationContinuation(config, ledger, assignment.id,
              nextConfig, nextLedger, authorization, proposal);
          else
            await dispatchLocalValidationContinuation(nextConfig, nextLedger, continued.assignment.id, {
              runModel: async () => request('forbidden-model'),
              runValidation: validate('duplicate'), ...publication
            });
          return { status: 'target-failed', code: 'guard-admitted' };
        } catch (error) {
          await request('guard-refusal', { guard, code: error.code ?? 'failed' });
        }
      }
    }
    return { status: 'completed', workerOutcome: result.outcome };
  } finally {
    nextLedger?.close();
    ledger.close();
  }
}

async function runReadinessControl(input) {
  const source = readFileSync(join(fixtures, 'readiness-projection.txt'), 'utf8');
  const { classifyReadiness } = await import(`data:text/javascript,${encodeURIComponent(source)}`);
  return { status: 'completed', ...classifyReadiness(input.facts) };
}

process.on('message', async message => {
  if (message?.type === 'reply') {
    const item = pending.get(message.id);
    if (!item) { process.exitCode = 1; process.disconnect(); return; }
    pending.delete(message.id);
    if (message.error) item.reject(Object.assign(new Error('Synthetic boundary refused'), { code: message.error }));
    else item.resolve(message.value);
    return;
  }
  if (message?.type !== 'start' || started || !['controller', 'native', 'readiness-control'].includes(mode)) {
    process.exitCode = 1;
    process.disconnect();
    return;
  }
  started = true;
  try {
    const result = mode === 'native' ? await runNative(message.input) :
      mode === 'readiness-control' ? await runReadinessControl(message.input) : await runController(message.input);
    await send({ type: 'finished', protocol: 'self-improvement-child-v1', mode, result });
  } catch (error) {
    await send({ type: 'finished', protocol: 'self-improvement-child-v1', mode,
      result: { status: 'fixture-failed', code: typeof error.code === 'string' ? error.code : 'failed' } });
    process.exitCode = 1;
  } finally { process.disconnect(); }
});
