import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { promisify } from 'node:util';
import { discoverCiGroups } from '../scripts/ci-tests.mjs';

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
  assert.deepEqual(catalogue.groups.pilot, [join('test', 'pilot.test.js')]);
  assert.deepEqual(catalogue.groups.demo, [join('test', 'demo.test.js')]);
  write('new/nested.test.js', "console.log('new test');\n");
  const updated = discoverCiGroups(root);
  assert.ok(updated.groups.remaining.includes(join('new', 'nested.test.js')));
  assert.notEqual(updated.sha256, catalogue.sha256);
});

test('CI groups preserve failures and write complete reports for both outcomes', async t => {
  const { root, write, options } = fixture(t);
  write('test/pilot.test.js', "require('node:test')('passing fixture', () => {});\n");
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
  assert.equal(passed.counts.pass, 1);
  assert.equal(failed.status, 'failed');
  assert.equal(failed.exitCode, 1);
  assert.equal(failed.counts.fail, 1);
  assert.equal(passed.catalogue.sha256, failed.catalogue.sha256);
  assert.equal(demo.catalogue.sha256, passed.catalogue.sha256);
  assert.equal(demo.status, 'passed');
  assert.equal(demo.counts.pass, 1);
  assert.deepEqual(demo.selectedFiles, [join('test', 'demo.test.js')]);
  for (const report of [passed, failed, demo]) {
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
  await assert.rejects(exec(process.execPath, [runner, 'typo'], options),
    error => error.code === 1 && /group must be pilot, remaining or demo/.test(error.stderr));
});
