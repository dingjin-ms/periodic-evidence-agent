import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync,
  rmSync, symlinkSync, writeFileSync
} from 'node:fs';
import { tmpdir, availableParallelism } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { command, seedDeclarativeDependencies } from '../src/workers.js';

const args = process.argv.slice(2);
assert.equal(args.length, 2, 'Use --output ABSOLUTE_PATH');
assert.equal(args[0], '--output');
assert.ok(isAbsolute(args[1]));
const output = resolve(args[1]);
assert.ok(!existsSync(output), 'Refuse to overwrite an existing result');
assert.ok(!/(?:^|[\\/])e2e-evidence(?:[\\/]|$)/i.test(output));
mkdirSync(dirname(output), { recursive: true });
assert.ok(!/(?:^|[\\/])e2e-evidence(?:[\\/]|$)/i.test(realpathSync(dirname(output))));
const repository = fileURLToPath(new URL('..', import.meta.url));
const git = async (cwd, parameters) => (await command('git', [
  '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=.git/no-hooks', ...parameters
], cwd)).stdout.trim();
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const report = {
  format: 'synthetic-dependency-seed-benchmark-v1', startedAt: new Date().toISOString(),
  node: process.version, platform: process.platform, availableParallelism: availableParallelism(),
  controllerRevision: await git(repository, ['rev-parse', 'HEAD']),
  controllerDirty: Boolean(await git(repository, ['status', '--porcelain'])),
  implementation: Object.fromEntries(['workers.js', 'output-fingerprint.js',
    'output-fingerprint-worker.js', 'dependency-snapshot-copy.cjs'].map(name =>
    [name, sha256(readFileSync(join(repository, 'src', name)))])),
  scope: {
    initialPreparation: 'source fingerprint + copy/rebase + source and target full byte verification + Git checks',
    preparedReverification: 'source fingerprint + source and target full byte verification + Git checks',
    files: 8192, logicalFileBytes: 8192 * (1024 + 1024 + 1024 + 65536) / 4,
    samples: 3, fixture: '4 store packages, mixed 1KiB/64KiB files, internal dependency junction',
    cache: 'OS cache uncontrolled; freshly written synthetic data, not a cold disk measurement',
    notMeasured: 'native load/typecheck, business cases, three unchanged windows, full live preflight, disk throughput',
    cpu: 'controller process includes fingerprint worker threads, excludes child Git/copy processes; do not add overlapping intervals'
  },
  samples: [], status: 'running'
};
const persist = () => writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600, flag: 'wx' });
let root;
try {
  root = mkdtempSync(join(tmpdir(), 'f3-dependency-benchmark-'));
  const source = join(root, 'source');
  mkdirSync(source);
  writeFileSync(join(source, '.gitignore'), 'ooui/.store/\nooui/node_modules/\n');
  writeFileSync(join(source, 'source.txt'), 'synthetic tracked source\n');
  await git(source, ['init', '--quiet']);
  await git(source, ['add', '.']);
  await git(source, ['-c', 'user.name=Synthetic fixture', '-c',
    'user.email=fixture@example.invalid', 'commit', '--quiet', '-m', 'Synthetic source']);
  const revision = await git(source, ['rev-parse', 'HEAD']);
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
  let expectedSha256;
  for (let index = 0; index < report.scope.samples; index++) {
    const workspace = join(root, `workspace-${index}`);
    await command('git', ['-c', 'core.autocrlf=false', '-c', 'core.safecrlf=false',
      'clone', '--quiet', '--no-hardlinks', '--', source, workspace], root);
    const sample = { index, phases: {} };
    report.samples.push(sample);
    for (const phase of ['initialPreparation', 'preparedReverification']) {
      sample.phases[phase] = { state: 'running', startedAt: new Date().toISOString(), timings: [] };
      persist();
      const measured = sample.phases[phase], started = performance.now(), cpu = process.cpuUsage();
      const seed = await seedDeclarativeDependencies(source, workspace, revision, 300000, {
        ...(phase === 'preparedReverification' ? { expectedSeed: sample.seed } : {}),
        timings: measured.timings, persist
      });
      const used = process.cpuUsage(cpu);
      Object.assign(measured, { state: 'passed', wallMs: performance.now() - started,
        controllerProcessCpuMs: (used.user + used.system) / 1000 });
      expectedSha256 ??= seed.sha256;
      assert.equal(seed.sha256, expectedSha256, 'All phases must prove identical complete bytes');
      sample.seed = seed;
      persist();
    }
  }
  report.journals = readdirSync(root).filter(name =>
    name.includes('.dependency-verification-')).map(name =>
    readFileSync(join(root, name), 'utf8').trim().split('\n').map(JSON.parse));
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = { message: error.message, code: error.code };
  throw error;
} finally {
  persist();
  try {
    if (root) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    report.cleanup = 'removed-only-own-generated-fixture';
  } catch (error) {
    report.status = 'failed';
    report.cleanup = { code: error.code };
    throw error;
  } finally {
    report.completedAt = new Date().toISOString();
    persist();
  }
}
console.log(JSON.stringify({ status: report.status, output,
  samples: report.samples.map(sample => Object.fromEntries(Object.entries(sample.phases)
    .map(([name, phase]) => [name, phase.wallMs]))) }));
