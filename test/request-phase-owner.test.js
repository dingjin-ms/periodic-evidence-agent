import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { runPhase, admitPhase } from '../src/request-phase-owner.js';
import { hash } from '../src/common.js';

test('durable owner drains output and refuses a consumed attempt', { skip: process.platform !== 'win32' }, async t => {
  const root = mkdtempSync(join(tmpdir(), 'request-owner-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const script = join(root, 'child.mjs');
  writeFileSync(script, "console.log('started');console.error('diagnostic');setTimeout(()=>console.log('finished'),250);");
  const plan = { executable: process.execPath, args: [script], cwd: root, output: join(root, 'attempt'),
    nativeDeadlineMs: 10000, cleanupMs: 60000, foregroundMs: 120000,
    sourcePins: [{ path: script, sha256: hash(readFileSync(script)) }], effects: 'synthetic local child' };
  assert.throws(() => admitPhase({ ...plan, nativeDeadlineMs: 600000 }), /foreground/);
  const receipt = await runPhase(plan);
  assert.equal(receipt.status, 'passed'); assert.equal(receipt.cleanup.nativeChildRecorded, true);
  assert.match(readFileSync(join(plan.output, 'stdout.log'), 'utf8'), /started[\s\S]*finished/);
  assert.match(readFileSync(join(plan.output, 'stderr.log'), 'utf8'), /diagnostic/);
  await assert.rejects(runPhase(plan), /Attempt exists/);
});
