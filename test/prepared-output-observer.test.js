import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtempSync, mkdirSync, writeFileSync, renameSync, rmSync, statSync, utimesSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { setTimeout as delay } from 'node:timers/promises';
import { createPreparedOutputObserver } from '../src/prepared-output-observer.js';
import { capturePreparedOutputs, verifyPreparedOutputs } from '../src/workers.js';

const exec = promisify(execFile);
const windows = { skip: process.platform !== 'win32', timeout: 60000 };

async function fixture(t) {
  const workspace = mkdtempSync(join(tmpdir(), 'content-observer-'));
  const root = join(workspace, 'outputs');
  mkdirSync(root);
  const file = join(root, 'value.js');
  writeFileSync(file, 'original\n');
  t.after(() => rmSync(workspace, { recursive: true, force: true }));
  const observer = await createPreparedOutputObserver();
  t.after(() => observer.close());
  return { workspace, root, file, observer };
}

async function until(condition) {
  for (let attempt = 0; attempt < 100 && !condition(); attempt++) await delay(20);
  assert.ok(condition(), 'Expected a native filesystem notification');
}

test('Windows content observation ignores only last-access updates', windows, async t => {
  const ctx = await fixture(t);
  const events = [], errors = [];
  const watcher = ctx.observer.watch(ctx.root, { recursive: true },
    (kind, name) => events.push({ kind, name }));
  watcher.on('error', error => errors.push(error));
  await ctx.observer.ready();
  await exec('pwsh.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    '[IO.File]::SetLastAccessTimeUtc($env:OBSERVER_PROBE_FILE,[DateTime]::UtcNow.AddDays(-2))'],
  { env: { ...process.env, OBSERVER_PROBE_FILE: ctx.file }, timeout: 15000 });
  await delay(300);
  assert.deepEqual(events, []);
  assert.deepEqual(errors, []);
  const before = statSync(ctx.file);
  writeFileSync(ctx.file, 'tampered\n');
  utimesSync(ctx.file, before.atime, before.mtime);
  await until(() => events.some(event => event.kind === 'change' && event.name === 'value.js'));
  assert.deepEqual(errors, []);
  events.length = 0;
  renameSync(ctx.root, join(ctx.workspace, 'renamed'));
  await until(() => events.some(event => event.kind === 'rename' && event.name === null));
});

test('Windows native content observation retains content and structure integrity', windows, async t => {
  const ctx = await fixture(t);
  const receipt = join(ctx.workspace, 'receipt.json');
  const factory = async () => ctx.observer;
  const captured = await capturePreparedOutputs(
    receipt, ctx.workspace, ['outputs'], null, null, factory);
  const outputs = { paths: ['outputs'], sha256: captured.sha256 };
  assert.equal((await verifyPreparedOutputs(receipt, ctx.workspace, outputs)).valid, true);
  const before = statSync(ctx.file);
  writeFileSync(ctx.file, 'tampered\n');
  utimesSync(ctx.file, before.atime, before.mtime);
  const result = await verifyPreparedOutputs(receipt, ctx.workspace, outputs);
  assert.equal(result.valid, false);
  assert.match(result.reason, /content-changed/);
});

test('Windows observer failure cannot qualify a cache', windows, async t => {
  const ctx = await fixture(t);
  const errors = [];
  ctx.observer.watch(join(ctx.root, 'missing'), { recursive: true }, () => {})
    .on('error', error => errors.push(error));
  await assert.rejects(ctx.observer.ready(), /observation failed|observer exited/i);
  assert.equal(errors.length, 1);
});

test('idle Windows observation does not keep its controller process alive', windows, async t => {
  const ctx = await fixture(t);
  const module = new URL('../src/prepared-output-observer.js', import.meta.url).href;
  const source = `
    import { createPreparedOutputObserver } from ${JSON.stringify(module)};
    const observer = await createPreparedOutputObserver();
    observer.watch(process.argv[1], { recursive: true }, () => {})
      .on('error', error => { throw error; });
    await observer.ready();
    console.log('ready');
  `;
  const result = await exec(process.execPath,
    ['--input-type=module', '-e', source, ctx.root], { timeout: 15000 });
  assert.equal(result.stdout.trim(), 'ready');
});
