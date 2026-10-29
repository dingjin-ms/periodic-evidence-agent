import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { once } from 'node:events';
import { globSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { availableParallelism, cpus, freemem, totalmem } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export function discoverCiGroups(cwd = process.cwd()) {
  const extensions = process.features.typescript
    ? 'js,mjs,cjs,ts,mts,cts' : 'js,mjs,cjs';
  // Match node --test discovery, including helpers under test/ and typed tests.
  const files = globSync(`**/{test,test/**/*,test-*,*[._-]test}.{${extensions}}`, {
    cwd, exclude: path => basename(path) === 'node_modules'
  }).sort();
  const pilot = files.filter(path =>
    dirname(path) === 'test' && /^pilot(?:-.+)?\.test\.js$/.test(basename(path)));
  const demo = files.filter(path => path === join('test', 'demo.test.js'));
  const remaining = files.filter(path => !pilot.includes(path) && !demo.includes(path));
  if (!pilot.includes(join('test', 'pilot.test.js')) || demo.length !== 1 || remaining.length === 0 ||
      new Set([...pilot, ...remaining, ...demo]).size !== files.length)
    throw new Error('CI partitions must cover every discovered file exactly once, with nonempty pilot, remaining and demo groups');
  return { files, groups: { pilot, remaining, demo },
    sha256: createHash('sha256').update(JSON.stringify(files)).digest('hex') };
}

function resources() {
  return {
    availableParallelism: availableParallelism(),
    freeMemoryBytes: freemem(), totalMemoryBytes: totalmem(),
    systemCpuTimesMs: cpus().map(cpu => cpu.times),
    runnerProcessUsage: process.resourceUsage()
  };
}

function readCounts(path) {
  const tap = readFileSync(path, 'utf8');
  const counts = Object.fromEntries(
    ['tests', 'pass', 'fail', 'cancelled', 'skipped'].map(name => [
      name, Number([...tap.matchAll(new RegExp(`^# ${name} (\\d+)\\r?$`, 'gm'))].at(-1)?.[1])
    ]));
  if (Object.values(counts).some(count => !Number.isSafeInteger(count)) || counts.tests < 1)
    throw new Error('CI test output is missing a complete, nonempty TAP summary');
  return counts;
}

export async function runCiTests(group, directory = join('.state', `ci-tests-${group}`)) {
  if (!['pilot', 'remaining', 'demo'].includes(group))
    throw new Error('CI test group must be pilot, remaining or demo');
  const catalogue = discoverCiGroups();
  const output = resolve(directory);
  mkdirSync(output, { recursive: true });
  const summaryPath = join(output, 'summary.json');
  const tapPath = join(output, 'tests.tap');
  const started = performance.now();
  const summary = {
    group, sourceRevision: process.env.GITHUB_SHA ?? null,
    nodeVersion: process.version, fileConcurrency: 4, catalogue,
    selectedFiles: catalogue.groups[group],
    startedAt: new Date().toISOString(), status: 'running',
    exitCode: null, signal: null, counts: null, resourcesBefore: resources()
  };
  const save = () => writeFileSync(summaryPath, `${JSON.stringify(summary, null, 2)}\n`);
  save();
  console.log(JSON.stringify({ group, catalogueSha256: catalogue.sha256,
    discoveredFiles: catalogue.files.length, selectedFiles: summary.selectedFiles.length }));
  try {
    const child = spawn(process.execPath, [
      '--test', '--test-concurrency=4',
      '--test-reporter=tap', '--test-reporter-destination=stdout',
      '--test-reporter=tap', `--test-reporter-destination=${tapPath}`,
      ...summary.selectedFiles
    ], { stdio: 'inherit', windowsHide: true });
    summary.childPid = child.pid;
    save();
    const [code, signal] = await once(child, 'close');
    summary.exitCode = code ?? 1;
    summary.signal = signal;
    summary.counts = readCounts(tapPath);
    if (summary.exitCode === 0 &&
        (summary.counts.fail > 0 || summary.counts.cancelled > 0))
      throw new Error('CI child exited successfully with failed or cancelled tests');
    summary.status = summary.exitCode === 0 ? 'passed' : 'failed';
    return summary.exitCode;
  } catch (error) {
    summary.status = 'failed';
    summary.error = { message: error.message, code: error.code ?? null };
    throw error;
  } finally {
    summary.finishedAt = new Date().toISOString();
    summary.elapsedMs = performance.now() - started;
    summary.resourcesAfter = resources();
    save();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    if (process.argv.length > 4) throw new Error('Usage: node ci-tests.mjs <pilot|remaining|demo> [report-directory]');
    process.exitCode = await runCiTests(...process.argv.slice(2));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  }
}
