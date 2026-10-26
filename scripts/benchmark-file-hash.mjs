import assert from 'node:assert/strict';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { channel } from 'node:diagnostics_channel';
import { command } from '../src/workers.js';
import { pathFingerprint } from '../src/output-fingerprint.js';
import { hash } from '../src/hash.js';

const args = process.argv.slice(2);
assert.ok(args.length === 4 && args[0] === '--baseline' && args[2] === '--output',
  'Use --baseline FULL_COMMIT_SHA --output ABSOLUTE_PATH');
assert.match(args[1], /^[a-f0-9]{40}$/);
assert.ok(isAbsolute(args[3]));
const output = resolve(args[3]);
assert.ok(!existsSync(output), 'Refuse to overwrite existing evidence');
assert.ok(!/(?:^|[\\/])e2e-evidence(?:[\\/]|$)/i.test(output));
mkdirSync(dirname(output), { recursive: true });
assert.ok(!/(?:^|[\\/])e2e-evidence(?:[\\/]|$)/i.test(realpathSync(dirname(output))));
const repository = fileURLToPath(new URL('..', import.meta.url));
const git = async parameters => (await command('git', parameters, repository)).stdout;
const baselineSource = await git(['show', `${args[1]}:src/output-fingerprint.js`]);
const baselineHash = await git(['show', `${args[1]}:src/hash.js`]);
assert.equal(baselineHash.replaceAll('\r\n', '\n'),
  readFileSync(new URL('../src/hash.js', import.meta.url), 'utf8').replaceAll('\r\n', '\n'),
  'Shared hash helper must be identical apart from checkout newlines');
const report = {
  format: 'paired-file-hash-benchmark-v1', startedAt: new Date().toISOString(),
  baselineRevision: args[1], controllerRevision: (await git(['rev-parse', 'HEAD'])).trim(),
  controllerDirty: Boolean((await git(['status', '--porcelain'])).trim()),
  baselineSourceSha256: hash(baselineSource),
  optimizedSourceSha256: hash(readFileSync(new URL('../src/output-fingerprint.js', import.meta.url))),
  node: process.version, platform: process.platform,
  scope: 'Same synthetic directory, serial pathFingerprint, 8192 files and 140509184 bytes per scan; one warm-up per implementation',
  exclusions: 'No Git, copying, worker startup or lifecycle checks inside timed scans; not cold-disk or full-preflight performance',
  order: ['baseline', 'optimized', 'optimized', 'baseline',
    'baseline', 'optimized', 'optimized', 'baseline'],
  samples: [], status: 'running'
};
writeFileSync(output, JSON.stringify(report, null, 2), { flag: 'wx', mode: 0o600 });
const persist = () => writeFileSync(output, JSON.stringify(report, null, 2), { mode: 0o600 });
const root = mkdtempSync(join(tmpdir(), 'f3-paired-hash-'));
try {
  writeFileSync(join(root, 'package.json'), '{"type":"module"}\n');
  writeFileSync(join(root, 'output-fingerprint.js'), baselineSource);
  writeFileSync(join(root, 'hash.js'), baselineHash);
  const baseline = await import(pathToFileURL(join(root, 'output-fingerprint.js')).href);
  mkdirSync(join(root, 'files'));
  for (let index = 0; index < 8192; index++)
    writeFileSync(join(root, 'files', `${index}.js`),
      Buffer.alloc(index % 4 === 0 ? 65536 : 1024, index % 251));
  const implementations = { baseline: baseline.pathFingerprint, optimized: pathFingerprint };
  const scan = name => hash(JSON.stringify(implementations[name](root, 'files')));
  const expected = scan('baseline');
  assert.equal(scan('optimized'), expected);
  report.treeSha256 = expected;
  const reads = channel('periodic-evidence-agent.fingerprint-file-read');
  for (const implementation of report.order) {
    const work = { files: 0, logicalBytes: 0 };
    const observe = ({ bytes }) => { work.files++; work.logicalBytes += bytes; };
    reads.subscribe(observe);
    let actual, wallMs, used;
    try {
      const cpu = process.cpuUsage(), started = performance.now();
      actual = scan(implementation);
      wallMs = performance.now() - started;
      used = process.cpuUsage(cpu);
    } finally {
      reads.unsubscribe(observe);
    }
    assert.equal(actual, expected);
    assert.equal(work.files, 8192);
    assert.equal(work.logicalBytes, 140509184);
    report.samples.push({ implementation, wallMs,
      controllerProcessCpuMs: (used.user + used.system) / 1000, ...work });
    persist();
  }
  report.status = 'passed';
} catch (error) {
  report.status = 'failed';
  report.failure = { message: error.message, code: error.code };
  report.retainedFixture = root;
  throw error;
} finally {
  persist();
  if (report.status === 'passed') {
    try {
      rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
      report.cleanup = 'removed-only-own-generated-fixture';
    } catch (error) {
      report.status = 'failed';
      report.failure = { message: error.message, code: error.code };
      report.retainedFixture = root;
      persist();
      throw error;
    }
  }
  report.completedAt = new Date().toISOString();
  persist();
}
console.log(JSON.stringify({ status: report.status, samples: report.samples }));
