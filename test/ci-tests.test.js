import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { discoverCiGroups, orderCiFiles } from '../scripts/ci-tests.mjs';

const exec = promisify(execFile);
const runner = resolve('scripts', 'ci-tests.mjs');
function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'ci-partitions-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const write = (path, content) => {
    const target = join(root, ...path.split('/'));
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  };
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  delete env.GITHUB_OUTPUT;
  return { root, write, options: { cwd: root, env, windowsHide: true,
    timeout: 30000, maxBuffer: 1024 * 1024 } };
}

test('CI partitions preserve native discovery for nested, typed and newly added tests', async t => {
  const { root, write, options } = fixture(t);
  const paths = [
    'test/pilot.test.js', 'test/demo.test.js', 'test/helpers.cjs', 'nested/test/helper.mjs',
    'test/pilot-validation.test.js', 'test/pilot-preparation.test.js', 'test/pilot-lifecycle.test.js',
    'nested/pilot-validation.test.js', 'test/pilotish.test.js', 'scripts/test-fixtures/pilot.mjs',
    'nested/a.test.js', 'nested/a-test.mjs', 'nested/a_test.cjs',
    'nested/test-a.js', 'test.js', 'types/a.test.ts', 'types/a-test.mts',
    'types/a_test.cts', '.hidden/a.test.js',
    'node_modules/ignored.test.js', 'nested/node_modules/ignored.test.js',
    'nested/not-selected.js'
  ];
  for (const path of paths) write(path, `console.log(${JSON.stringify(`CI_SELECTED:${path}`)});\n`);
  const native = await exec(process.execPath,
    ['--test', '--test-concurrency=4', '--test-reporter=tap'], options);
  const selected = [...native.stdout.matchAll(/^# CI_SELECTED:(.+)\r?$/gm)]
    .map(match => match[1].split('/').join(sep)).sort();
  const catalogue = discoverCiGroups(root);
  assert.ok(selected.includes(join('types', 'a.test.ts')));
  assert.ok(!selected.some(path => path.includes('node_modules')));
  assert.deepEqual(catalogue.files, selected);
  assert.deepEqual(Object.values(catalogue.groups).flat().sort(), selected);
  assert.deepEqual(catalogue.groups.pilot, [
    'pilot.test.js', 'pilot-validation.test.js', 'pilot-preparation.test.js', 'pilot-lifecycle.test.js'
  ].map(name => join('test', name)).sort());
  assert.ok(catalogue.groups.remaining.includes(join('nested', 'pilot-validation.test.js')));
  assert.ok(catalogue.groups.remaining.includes(join('test', 'pilotish.test.js')));
  assert.ok(!catalogue.files.includes(join('scripts', 'test-fixtures', 'pilot.mjs')));
  assert.deepEqual(catalogue.groups.demo, [join('test', 'demo.test.js')]);
  write('new/nested.test.js', "console.log('new test');\n");
  write('test/pilot-new.test.js', "console.log('new pilot partition');\n");
  const updated = discoverCiGroups(root);
  assert.ok(updated.groups.remaining.includes(join('new', 'nested.test.js')));
  assert.ok(updated.groups.pilot.includes(join('test', 'pilot-new.test.js')));
  assert.notEqual(updated.sha256, catalogue.sha256);
});

test('remaining CI starts measured long-tail files first without changing coverage', () => {
  const files = [
    join('test', 'alpha.test.js'), join('test', 'resource-lifecycle.test.js'),
    join('test', 'rsi-execution.test.js'), join('test', 'self-improvement-evaluation.test.js'),
    join('test', 'omega.test.js')
  ];
  const ordered = orderCiFiles('remaining', files);
  assert.deepEqual(ordered.slice(0, 3), [
    join('test', 'resource-lifecycle.test.js'), join('test', 'self-improvement-evaluation.test.js'),
    join('test', 'rsi-execution.test.js')
  ]);
  assert.deepEqual([...ordered].sort(), [...files].sort());
  assert.deepEqual(orderCiFiles('pilot', files), files);
});

test('CI groups preserve failures and write complete reports for both outcomes', async t => {
  const { root, write, options } = fixture(t);
  write('test/pilot.test.js', "require('node:test')('passing fixture', () => {});\n");
  write('test/pilot-validation.test.js', "require('node:test')('passing pilot partition', () => {});\n");
  write('test/demo.test.js', "require('node:test')('isolated demo fixture', () => {});\n");
  write('test/remaining.test.js',
    "require('node:test')('failing fixture', () => { throw new Error('fixture assertion'); });\n");
  const pilotDirectory = join(root, 'pilot-report');
  const demoDirectory = join(root, 'demo-report');
  const remainingDirectory = join(root, 'remaining-report');
  await exec(process.execPath, [runner, 'pilot', pilotDirectory], options);
  await exec(process.execPath, [runner, 'demo', demoDirectory], options);
  await assert.rejects(exec(process.execPath, [runner, 'remaining', remainingDirectory], options),
    error => error.code === 1 && error.stdout.includes('fixture assertion'));
  const passed = JSON.parse(readFileSync(join(pilotDirectory, 'summary.json')));
  const demo = JSON.parse(readFileSync(join(demoDirectory, 'summary.json')));
  const failed = JSON.parse(readFileSync(join(remainingDirectory, 'summary.json')));
  assert.equal(passed.status, 'passed');
  assert.equal(passed.counts.pass, 2);
  assert.deepEqual(passed.selectedFiles,
    ['pilot-validation.test.js', 'pilot.test.js'].map(name => join('test', name)));
  assert.deepEqual(passed.executionFiles, passed.selectedFiles);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.counts.fail, 1);
  assert.equal(passed.catalogue.sha256, failed.catalogue.sha256);
  assert.equal(demo.catalogue.sha256, passed.catalogue.sha256);
  assert.equal(demo.status, 'passed');
  assert.equal(demo.counts.pass, 1);
  assert.deepEqual(demo.selectedFiles, [join('test', 'demo.test.js')]);
  write('test/pilot-validation.test.js',
    "require('node:test')('failing pilot partition', () => { throw new Error('pilot assertion'); });\n");
  const failedPilotDirectory = join(root, 'failed-pilot-report');
  await assert.rejects(exec(process.execPath, [runner, 'pilot', failedPilotDirectory], options),
    error => error.code === 1 && error.stdout.includes('pilot assertion'));
  const failedPilot = JSON.parse(readFileSync(join(failedPilotDirectory, 'summary.json')));
  assert.equal(failedPilot.status, 'failed');
  assert.equal(failedPilot.counts.pass, 1);
  assert.equal(failedPilot.counts.fail, 1);
  assert.deepEqual(failedPilot.selectedFiles, passed.selectedFiles);
  assert.equal(failedPilot.catalogue.sha256, passed.catalogue.sha256);
  for (const report of [passed, failed, demo, failedPilot]) {
    assert.ok(report.elapsedMs > 0);
    assert.ok(report.finishedAt);
    assert.ok(report.resourcesBefore.totalMemoryBytes > 0);
    assert.ok(report.resourcesAfter.systemCpuTimesMs.length > 0);
  }
  assert.match(readFileSync(join(remainingDirectory, 'tests.tap'), 'utf8'), /# fail 1/);
});

test('CI rejects missing isolated files and invalid groups instead of reporting empty success', async t => {
  const { root, write, options } = fixture(t);
  write('test/other.test.js', "console.log('must not execute');\n");
  assert.throws(() => discoverCiGroups(root), /cover every discovered file/);
  await assert.rejects(exec(process.execPath, [runner, 'remaining'], options),
    error => error.code === 1 && /cover every discovered file/.test(error.stderr));
  write('test/pilot.test.js', "console.log('must not execute without demo');\n");
  assert.throws(() => discoverCiGroups(root), /cover every discovered file/);
  await assert.rejects(exec(process.execPath, [runner, 'pilot'], options),
    error => error.code === 1 && /cover every discovered file/.test(error.stderr));
  rmSync(join(root, 'test', 'pilot.test.js'));
  write('test/demo.test.js', "console.log('must not execute without pilot entry');\n");
  write('test/pilot-validation.test.js', "console.log('orphaned pilot partition');\n");
  assert.throws(() => discoverCiGroups(root), /cover every discovered file/);
  await assert.rejects(exec(process.execPath, [runner, 'pilot'], options),
    error => error.code === 1 && /cover every discovered file/.test(error.stderr));
  await assert.rejects(exec(process.execPath, [runner, 'typo'], options),
    error => error.code === 1 && /group must be pilot, remaining or demo/.test(error.stderr));
});
