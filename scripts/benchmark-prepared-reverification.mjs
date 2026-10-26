import assert from 'node:assert/strict';
import {
  mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync,
  symlinkSync, unlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir, availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { command, seedDeclarativeDependencies } from '../src/workers.js';
import { benchmarkOptions, sampleSummary } from './benchmark-fingerprint.mjs';

const args = process.argv.slice(2);
assert.equal(args.length, 4, 'Use --baseline FULL_SHA --output ABSOLUTE_PATH');
assert.equal(args.filter(value => value === '--baseline').length, 1);
const offset = args.indexOf('--baseline');
assert(offset === 0 || offset === 2);
const baseline = args[offset + 1];
assert.match(baseline, /^[a-f0-9]{40}$/);
const outputArgs = args.filter((_, index) => index !== offset && index !== offset + 1);
const { output } = benchmarkOptions(outputArgs);
mkdirSync(dirname(output), { recursive: true });
benchmarkOptions(outputArgs);
const repository = fileURLToPath(new URL('..', import.meta.url));
const git = async (cwd, parameters) => (await command('git', [
  '-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
  '-c', 'core.hooksPath=.git/no-hooks', ...parameters
], cwd)).stdout.trim();
const files = ['workers.js', 'output-fingerprint.js',
  'output-fingerprint-worker.js', 'dependency-snapshot-copy.cjs'];
const implementation = root => Object.fromEntries(files.map(name =>
  [name, createHash('sha256').update(readFileSync(join(root, 'src', name))).digest('hex')]));
const report = {
  format: 'paired-prepared-dependency-reverification-v1',
  startedAt: new Date().toISOString(), status: 'running',
  baselineCommit: baseline, candidateCommit: await git(repository, ['rev-parse', 'HEAD']),
  candidateDirty: Boolean(await git(repository, ['status', '--porcelain'])),
  candidateImplementation: implementation(repository),
  node: process.version, platform: process.platform, availableParallelism: availableParallelism(),
  scope: {
    files: 8192, logicalFileBytes: 140509184,
    fixture: 'Same source and prepared workspace, 4 store packages, mixed 1KiB/64KiB files, internal junction',
    timed: 'Complete seedDeclarativeDependencies expectedSeed call including Git, inventories, full byte witnesses and durable journals',
    order: ['baseline', 'candidate', 'candidate', 'baseline',
      'baseline', 'candidate', 'candidate', 'baseline'],
    warmup: 'One complete untimed reverification per implementation',
    cpu: 'Controller process including worker threads, excluding Git/copy children',
    limitations: 'No cold-cache control, physical disk attribution, full real preflight or business invocation'
  },
  samples: []
};
assert.equal(report.candidateDirty, false, 'Benchmark requires a committed clean candidate');
writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
const persist = () => writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
let root, baselineRoot;
try {
  root = mkdtempSync(join(tmpdir(), 'f3-prepared-reverification-'));
  baselineRoot = join(root, 'baseline-controller');
  await git(repository, ['worktree', 'add', '--detach', '--', baselineRoot, baseline]);
  symlinkSync(join(repository, 'node_modules'), join(baselineRoot, 'node_modules'),
    process.platform === 'win32' ? 'junction' : 'dir');
  report.baselineImplementation = implementation(baselineRoot);
  for (const name of files.slice(1))
    assert.equal(report.baselineImplementation[name], report.candidateImplementation[name],
      'This comparison isolates the preparation lifecycle, not a different hash implementation');
  const { seedDeclarativeDependencies: baselineSeed } =
    await import(pathToFileURL(join(baselineRoot, 'src', 'workers.js')).href);
  const source = join(root, 'source'), workspace = join(root, 'workspace');
  mkdirSync(source);
  writeFileSync(join(source, '.gitignore'), 'ooui/.store/\nooui/node_modules/\n');
  await git(source, ['init', '--quiet']);
  await git(source, ['add', '.']);
  await git(source, ['-c', 'user.name=Synthetic fixture',
    '-c', 'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Synthetic source']);
  const revision = await git(source, ['rev-parse', 'HEAD']);
  await git(root, ['clone', '--quiet', '--no-hardlinks', '--', source, workspace]);
  for (let pkg = 0; pkg < 4; pkg++) {
    const directory = join(source, 'ooui', '.store', `pkg-${pkg}`);
    mkdirSync(directory, { recursive: true });
    for (let index = 0; index < 2048; index++)
      writeFileSync(join(directory, `${index}.js`),
        Buffer.alloc(index % 4 === 0 ? 65536 : 1024, index % 251));
  }
  mkdirSync(join(source, 'ooui', 'node_modules'));
  symlinkSync(join(source, 'ooui', '.store', 'pkg-0'),
    join(source, 'ooui', 'node_modules', 'alias'),
    process.platform === 'win32' ? 'junction' : 'dir');
  const seed = await seedDeclarativeDependencies(source, workspace, revision, 300000);
  report.seed = seed;
  const implementations = { baseline: baselineSeed, candidate: seedDeclarativeDependencies };
  for (const execute of Object.values(implementations))
    assert.deepEqual(await execute(source, workspace, revision, 300000, { expectedSeed: seed }), seed);
  for (const name of report.scope.order) {
    const sample = { implementation: name, state: 'running', timings: [] };
    report.samples.push(sample);
    persist();
    const started = performance.now(), cpu = process.cpuUsage();
    const result = await implementations[name](source, workspace, revision, 300000,
      { expectedSeed: seed, timings: sample.timings });
    const used = process.cpuUsage(cpu);
    Object.assign(sample, {
      wallMs: performance.now() - started,
      controllerProcessCpuMs: (used.user + used.system) / 1000
    });
    assert.deepEqual(result, seed);
    sample.state = 'passed';
    persist();
  }
  report.journals = readdirSync(root).filter(name =>
    name.includes('.dependency-verification-')).map(name =>
    readFileSync(join(root, name), 'utf8').trim().split('\n').map(JSON.parse));
  assert.equal(report.journals.length, 11);
  assert.equal(report.journals.filter(records =>
    records[0].verificationMode === 'pinned-byte-digest-reverification').length, 5);
  for (const records of report.journals) {
    const expected = records[0].verificationMode === 'pinned-byte-digest-reverification'
      ? ['copiedWorkspace', 'retainedSource']
      : ['copiedWorkspace', 'initialSource', 'retainedSource'];
    assert.deepEqual(Object.keys(records.at(-1).scans).sort(), expected);
    for (const scan of Object.values(records.at(-1).scans)) {
      assert.equal(scan.state, 'passed');
      assert.equal(scan.hashedFileCount, report.scope.files);
      assert.equal(scan.hashedBytes, report.scope.logicalFileBytes);
    }
  }
  for (const name of Object.keys(implementations))
    report[name] = sampleSummary(report.samples.filter(sample =>
      sample.implementation === name).map(sample => sample.wallMs));
  assert.deepEqual(implementation(repository), report.candidateImplementation);
  assert.deepEqual(implementation(baselineRoot), report.baselineImplementation);
  assert.equal(await git(repository, ['rev-parse', 'HEAD']), report.candidateCommit);
  assert.equal(await git(repository, ['status', '--porcelain']), '');
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = { message: error.message, code: error.code };
  throw error;
} finally {
  persist();
  try {
    if (report.status === 'passed') {
      unlinkSync(join(baselineRoot, 'node_modules'));
      await git(repository, ['worktree', 'remove', '--', baselineRoot]);
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      report.cleanup = 'removed-only-own-benchmark-worktree-and-fixture';
    } else if (root) {
      report.retainedRoot = root;
      report.cleanup = 'retained-failed-benchmark-and-checkout';
    }
  } catch (error) {
    report.status = 'failed';
    report.cleanup = { code: error.code };
    throw error;
  } finally {
    report.completedAt = new Date().toISOString();
    persist();
  }
}
console.log(JSON.stringify({
  status: report.status, output, baseline: report.baseline, candidate: report.candidate
}));
