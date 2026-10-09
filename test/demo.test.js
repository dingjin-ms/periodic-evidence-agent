import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

test('account-free demo persists synthetic restart/dedupe results only in disposable state', t => {
  const root = mkdtempSync(join(tmpdir(), 'pilot-demo-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const result = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/demo.mjs', import.meta.url))],
    { cwd: root, encoding: 'utf8', timeout: 30000,
      env: { SystemRoot: process.env.SystemRoot ?? '', PATH: '', TEMP: root, TMP: root,
        HOME: root, USERPROFILE: root, COPILOT_HOME: root, AZURE_CONFIG_DIR: root } });
  assert.equal(result.status, 0, result.stderr);
  const output = JSON.parse(result.stdout);
  assert.equal(output.result, 'synthetic-demo-passed');
  assert.equal(output.provenance, 'synthetic');
  assert.equal(output.uniqueEvidence, 3);
  assert.equal(output.overallCollectionState, 'partial-or-blocked');
  assert.equal(output.workers, 0);
  assert.equal(output.scheduleEnabled, false);
  assert.deepEqual(readdirSync(root), ['.state']);
  assert.equal(readdirSync(join(root, '.state')).length, 1);
  assert.ok(output.stateDirectory.startsWith(join(root, '.state', 'demo-')));
  assert.equal(JSON.parse(readFileSync(output.summaryPath, 'utf8')).provenance, 'synthetic');
});
