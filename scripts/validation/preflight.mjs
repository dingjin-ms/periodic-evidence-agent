import { existsSync, mkdirSync, readFileSync, writeFileSync, renameSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { configAt, hash, json, now, requireThat, uuid } from '../../src/common.js';
import { Ledger } from '../../src/ledger.js';
import { declarativeGate, declarativeRequest, verifyDeclarativeRegistration } from '../../src/declarative-e2e.js';
import { seedDeclarativeDependencies, hydrateValidationLfs, minimalEnvironment } from '../../src/workers.js';
import { nativeCommand, nativeTemporaryDirectory } from '../../src/native-command.js';
import { prepareValidationWorkspace, preparationStage, preparationFailure,
  requireCleanRevision } from '../../src/validation-workspace.js';

const args = process.argv.slice(2);
const allowed = ['--config', '--assignment', '--output', '--workspace', '--sparse-path',
  '--prepared-receipt', '--retained-copy'];
const values = name => args.flatMap((value, i) => value === name ? [args[i + 1]] : []);
requireThat(args.length % 2 === 0 && args.every((value, i) =>
  i % 2 ? typeof value === 'string' && !value.startsWith('--') : allowed.includes(value)),
'Use --config, --assignment, --output, --workspace and optional repeated --sparse-path');
for (const name of ['--config', '--assignment', '--output', '--workspace'])
  requireThat(values(name).length === 1, `Exactly one ${name} is required`);
requireThat(values('--prepared-receipt').length <= 1, 'At most one prepared receipt is permitted');
requireThat(values('--retained-copy').length <= 1 &&
  !(values('--prepared-receipt').length && values('--retained-copy').length),
  'Use at most one retained copy or one previously prepared receipt');
const config = configAt(resolve(values('--config')[0]));
const output = resolve(values('--output')[0]);
const workspace = resolve(values('--workspace')[0]);
const priorBytes = values('--prepared-receipt').length
  ? readFileSync(resolve(values('--prepared-receipt')[0])) : null;
const prior = priorBytes ? JSON.parse(priorBytes) : null;
const retainedCopy = values('--retained-copy').length ? {
  path: resolve(values('--retained-copy')[0]),
  sha256: hash(readFileSync(resolve(values('--retained-copy')[0])))
} : null;
requireThat(!existsSync(output) && (prior || !existsSync(workspace)),
  'Preflight refuses an existing receipt or workspace', 'blocked-reconciliation');
const ledger = new Ledger(config.stateDirectory, { readOnly: true });
const assignmentId = values('--assignment')[0];
const job = ledger.job(assignmentId), assignment = ledger.get('assignment', assignmentId);
const results = ledger.all('workerResult').filter(result =>
  result.assignmentId === assignmentId && result.attemptId === job?.session_id);
requireThat(job?.state === 'blocked' && results.length === 1,
  'Preflight requires an existing sealed blocked assignment');
const result = results[0], revision = result.sourceRevision;
const repo = config.repositories.find(repo => repo.id === job.repo);
const gate = declarativeGate(repo);
verifyDeclarativeRegistration(config, repo, assignment, job.workspace, result.skillExecution);
const originalLedger = hash(json({ job, result, assignment, operations: ledger.status().operations }));
if (prior)
  requireThat(prior.format === 'validation-preflight-v1' &&
    ['passed', 'blocked'].includes(prior.status) && prior.completedAt &&
    prior.assignmentId === assignmentId && prior.sourceRevision === revision &&
    prior.priorAttemptId === job.session_id && prior.priorResultId === result.id &&
    prior.originalLedgerSha256 === originalLedger &&
    prior.profileSha256 === gate.profileSha256 &&
    prior.workspace === workspace && prior.preparation?.workspace === workspace &&
    prior.preparation?.sourceRevision === revision && prior.preparation?.dependencySeed &&
    !values('--sparse-path').length,
  'Prepared receipt must bind this sealed assignment, workspace, profile and verified dependencies');
const request = declarativeRequest(gate, assignment, job, revision, result.skillExecution);
request.options.installDependencies = false;
const root = fileURLToPath(new URL('../..', import.meta.url));
const files = ['src/workers.js', 'src/validation-workspace.js', 'src/native-command.js',
  'src/native-command.ps1', 'src/dependency-snapshot-copy.cjs',
  'src/output-fingerprint.js', 'src/output-fingerprint-worker.js', 'src/retained-dependency-copy.js',
  'scripts/validation/preflight.mjs', 'scripts/validation/native-preflight.cjs',
  'src/native-preparation-continuation.js', 'src/native-source-continuation.js'];
const receipt = {
  format: 'validation-preflight-v1', id: uuid(), status: 'running', startedAt: now(),
  assignmentId, priorAttemptId: job.session_id, priorResultId: result.id,
  sourceRevision: revision, baseRevision: job.base_revision, workspace,
  controllerFiles: Object.fromEntries(files.map(file => [file, hash(readFileSync(join(root, file)))])),
  profileSha256: gate.profileSha256, originalLedgerSha256: originalLedger,
  ...(retainedCopy ? { retainedCopy } : {}),
  ...(prior ? { preparedReceipt: {
    path: resolve(values('--prepared-receipt')[0]), sha256: hash(priorBytes)
  } } : {}),
  timings: [], nativeCaseInvocations: 0, modelInvocations: 0,
  publicationInvocations: 0, acceptanceEvidence: false, publicationEligible: false
};
mkdirSync(dirname(output), { recursive: true });
writeFileSync(output, `${json(receipt)}\n`, { mode: 0o600, flag: 'wx' });
const persist = () => {
  const temporary = `${output}.${receipt.id}.tmp`;
  writeFileSync(temporary, `${json(receipt)}\n`, { mode: 0o600, flag: 'wx' });
  renameSync(temporary, output);
};
try {
  receipt.preparation = prior ? {
    ...prior.preparation,
    dependencySeed: await preparationStage(receipt.timings, 'verify-prepared-dependencies',
      () => seedDeclarativeDependencies(job.workspace, workspace, revision,
        gate.timeoutMs, { expectedSeed: prior.preparation.dependencySeed,
          timings: receipt.timings, persist }), persist)
  } : await prepareValidationWorkspace({
    source: job.workspace, workspace, revision,
    timeoutMs: repo.provisionTimeoutMs ?? 120000,
    sparseCheckoutPaths: values('--sparse-path').length
      ? values('--sparse-path') : repo.sparseCheckoutPaths ?? [],
    timings: receipt.timings, persist,
    hydrate: () => hydrateValidationLfs(config, repo, gate, workspace, revision),
    seed: (source, target) => seedDeclarativeDependencies(source, target, revision,
      gate.timeoutMs, { retainedCopy, timings: receipt.timings, persist })
  });
  requireThat(receipt.preparation.dependencySeed,
    'Real preflight requires existing byte-verified dependencies, never restore/fullbuild');
  const temporaryDirectory = nativeTemporaryDirectory(dirname(output), receipt.id);
  mkdirSync(temporaryDirectory, { recursive: true });
  const native = await preparationStage(receipt.timings, 'native-load-typecheck-selection',
    () => nativeCommand(gate.executable,
      [join(root, 'scripts', 'validation', 'native-preflight.cjs')], workspace,
      gate.timeoutMs, {
        ...minimalEnvironment(), TEMP: temporaryDirectory, TMP: temporaryDirectory,
        PILOT_DECLARATIVE_REQUEST: json(request)
      }), persist);
  const line = native.stdout.split(/\r?\n/).filter(line => line.startsWith('PILOT_PREFLIGHT_SELECTION:'));
  requireThat(line.length === 1 && native.stdout.includes('PILOT_PREFLIGHT_NATIVE:passed'),
    'Native preparation proof is missing');
  receipt.native = JSON.parse(line[0].slice('PILOT_PREFLIGHT_SELECTION:'.length));
  await preparationStage(receipt.timings, 'post-native-clean', async () => {
    await requireCleanRevision(workspace, revision, repo.provisionTimeoutMs ?? 120000);
    await requireCleanRevision(job.workspace, revision, repo.provisionTimeoutMs ?? 120000);
  }, persist);
  requireThat(hash(json({ job: ledger.job(assignmentId),
    result: ledger.get('workerResult', result.id), assignment: ledger.get('assignment', assignmentId),
    operations: ledger.status().operations })) === originalLedger,
  'Original ledger changed during preflight', 'blocked-reconciliation');
  requireThat(files.every(file =>
    hash(readFileSync(join(root, file))) === receipt.controllerFiles[file]),
  'Controller code changed during preflight; reverify the retained preparation',
  'blocked-reconciliation');
  receipt.status = 'passed';
} catch (error) {
  receipt.status = 'blocked';
  receipt.failure = { stage: error.preparationStage ?? 'preflight',
    ...preparationFailure(error) };
  const diagnostic = String(error.stdout ?? '').split(/\r?\n/)
    .filter(line => line.startsWith('PILOT_PREFLIGHT_FAILURE:'));
  if (diagnostic.length === 1)
    receipt.nativeFailure = JSON.parse(diagnostic[0].slice('PILOT_PREFLIGHT_FAILURE:'.length));
  process.exitCode = 1;
} finally {
  receipt.completedAt = now();
  persist();
  ledger.close();
}
console.log(json({ status: receipt.status, receipt: output,
  stage: receipt.failure?.stage, nativeCaseInvocations: 0, publicationEligible: false }));
