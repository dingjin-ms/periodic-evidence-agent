import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, readdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { tmpdir } from 'node:os';
import { command } from '../src/workers.js';
import { captureUnitDiagnostics, unitDiagnosticFiles } from '../src/validation-diagnostics.js';
import { hash } from '../src/common.js';

const png = Buffer.from('89504e470d0a1a0a00000000', 'hex');

for (const condition of ['valid', 'timer-capture', 'unexpected-file', 'invalid-png',
  'pre-existing', 'tracked', 'inside-workspace', 'artifact-drift', 'oversized', 'count-limit']) {
  test(`native unit diagnostic archival ${condition}`, async t => {
    const root = mkdtempSync(join(tmpdir(), 'unit-diagnostics-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const workspace = join(root, 'workspace'), directory = join(root, 'artifacts');
    mkdirSync(workspace);
    await command('git', ['init', '--quiet'], workspace);
    const source = join(workspace, unitDiagnosticFiles[0]);
    mkdirSync(dirname(source), { recursive: true });
    if (condition === 'tracked') {
      writeFileSync(source, png);
      await command('git', ['add', '.'], workspace);
      rmSync(source);
    }
    if (condition === 'pre-existing') writeFileSync(source, png);
    if (['tracked', 'pre-existing', 'inside-workspace'].includes(condition)) {
      assert.throws(() => captureUnitDiagnostics(workspace,
        condition === 'inside-workspace' ? join(workspace, 'artifacts') : directory, 'a'.repeat(40)));
      return;
    }
    if (condition === 'count-limit') t.mock.timers.enable({ apis: ['setInterval'] });
    const collector = captureUnitDiagnostics(workspace, directory, 'a'.repeat(40));
    let finalized = false;
    const finish = () => { finalized = true; return collector.finish(); };
    t.after(() => { if (!finalized) collector.finish(); });
    writeFileSync(source, condition === 'invalid-png' ? 'Not a PNG' :
      condition === 'oversized' ? Buffer.alloc(20 * 1024 * 1024 + 1) : png);
    if (condition === 'unexpected-file')
      writeFileSync(join(workspace, 'unexpected.png'), png);
    if (['timer-capture', 'artifact-drift'].includes(condition)) {
      for (let count = 0; existsSync(source) && count < 40; count++)
        await new Promise(resolve => setTimeout(resolve, 100));
      assert.equal(existsSync(source), false);
    }
    if (condition === 'artifact-drift')
      writeFileSync(join(directory, `000-${unitDiagnosticFiles[0].split('/').at(-1)}`), 'Changed');
    if (condition === 'count-limit') {
      for (let count = 0; count < 66; count++) {
        writeFileSync(source, png);
        t.mock.timers.tick(500);
      }
      assert.equal(readdirSync(directory).length, 64);
    }
    if (['invalid-png', 'artifact-drift', 'oversized', 'count-limit'].includes(condition)) {
      assert.throws(finish);
      return;
    }
    const receipt = finish();
    assert.equal(receipt.captures.length, 1);
    assert.equal(receipt.captures[0].sha256, hash(png));
    assert.deepEqual(readFileSync(receipt.captures[0].path), png);
    assert.equal(existsSync(source), false);
    assert.equal(JSON.parse(readFileSync(receipt.artifactRef)).sourceRevision, 'a'.repeat(40));
    assert.equal(existsSync(join(workspace, 'unexpected.png')), condition === 'unexpected-file');
    const status = await command('git', ['status', '--porcelain'], workspace);
    assert.equal(Boolean(status.stdout.trim()), condition === 'unexpected-file');
    assert.throws(() => collector.finish(), /already finalized/);
  });
}
