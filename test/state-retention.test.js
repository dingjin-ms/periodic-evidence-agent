import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync
} from 'node:fs';
import { execFileSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAt } from '../src/common.js';
import {
  assertStateDirectoryIgnored, completeRunEvidence, persistRunArtifact, pruneState
} from '../src/state-retention.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'state-retention-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  return {
    root,
    config: {
      stateDirectory: join(root, '.state'),
      statePolicy: { accessApproved: true, retention: 'bounded-local', rawEvidenceDays: 7 }
    }
  };
}

function ageManifest(config, runId, completedAt) {
  const path = join(config.stateDirectory, 'runs', runId, 'manifest.json');
  const manifest = JSON.parse(readFileSync(path, 'utf8'));
  manifest.completedAt = completedAt;
  writeFileSync(path, JSON.stringify(manifest));
}

test('configuration enforces bounded local evidence retention of at most seven days', t => {
  const { root } = fixture(t);
  const source = JSON.parse(readFileSync('pilot.example.json', 'utf8'));
  const path = join(root, 'pilot.json');
  source.statePolicy.rawEvidenceDays = 8;
  writeFileSync(path, JSON.stringify(source));
  assert.throws(() => configAt(path), /rawEvidenceDays from 1 through 7/);
  source.statePolicy = { accessApproved: false, retention: 'manual-no-auto-delete' };
  writeFileSync(path, JSON.stringify(source));
  assert.throws(() => configAt(path), /bounded-local/);
});

test('prune removes only completed expired run artifacts and supports dry-run', t => {
  const { config } = fixture(t);
  const artifact = persistRunArtifact(config, 'run-1', 'validation/result.json', '{"passed":true}');
  completeRunEvidence(config, 'run-1');
  ageManifest(config, 'run-1', '2026-10-01T00:00:00.000Z');

  const preview = pruneState(config, { dryRun: true, nowMs: Date.parse('2026-10-14T00:00:00.000Z') });
  assert.deepEqual(preview.deletedRunIds, ['run-1']);
  assert.equal(preview.files, 2);
  assert.ok(preview.bytes > 0);
  assert.equal(existsSync(artifact.path), true);

  const result = pruneState(config, { nowMs: Date.parse('2026-10-14T00:00:00.000Z') });
  assert.deepEqual(result.deletedRunIds, ['run-1']);
  assert.equal(existsSync(join(config.stateDirectory, 'runs', 'run-1')), false);
});

test('CLI dry-run never invokes automatic destructive pruning', t => {
  const { root, config } = fixture(t);
  const artifact = persistRunArtifact(config, 'run-1', 'validation/result.json', '{"passed":true}');
  completeRunEvidence(config, 'run-1');
  ageManifest(config, 'run-1', '2000-01-01T00:00:00.000Z');
  const settings = JSON.parse(readFileSync('pilot.example.json', 'utf8'));
  settings.stateDirectory = config.stateDirectory;
  const settingsPath = join(root, 'pilot.json');
  writeFileSync(settingsPath, JSON.stringify(settings));

  const output = execFileSync(process.execPath,
    ['src/cli.js', 'state-prune', '--dry-run', '--config', settingsPath],
    { cwd: process.cwd(), encoding: 'utf8' });
  const result = JSON.parse(output);
  assert.equal(result.dryRun, true);
  assert.deepEqual(result.deletedRunIds, ['run-1']);
  assert.equal(existsSync(artifact.path), true);
});

test('prune retains active and recent runs', t => {
  const { config } = fixture(t);
  persistRunArtifact(config, 'active-run', 'trace.zip', 'active');
  persistRunArtifact(config, 'recent-run', 'report.json', 'recent');
  completeRunEvidence(config, 'recent-run', 'blocked');
  ageManifest(config, 'recent-run', '2026-10-13T00:00:00.000Z');

  const result = pruneState(config, { nowMs: Date.parse('2026-10-14T00:00:00.000Z') });
  assert.deepEqual(result.deletedRunIds, []);
  assert.deepEqual(result.retained, [
    { runId: 'active-run', reason: 'active-lease' },
    { runId: 'recent-run', reason: 'within-retention-window' }
  ]);
});

test('artifact paths cannot escape the canonical run directory', t => {
  const { root, config } = fixture(t);
  assert.throws(() => persistRunArtifact(config, 'run-1', '..\\outside.txt', 'unsafe'),
    /safe relative path/);
  assert.throws(() => persistRunArtifact(config, '..', 'outside.txt', 'unsafe'),
    /Invalid local evidence run ID/);
  assert.throws(() => persistRunArtifact(config, 'run-1', 'manifest.json', 'unsafe'),
    /cannot replace its manifest/);

  const artifact = persistRunArtifact(config, 'run-1', 'result.json', 'original');
  assert.throws(() => persistRunArtifact(config, 'run-1', 'result.json', 'changed'),
    /identity conflict/);
  assert.equal(readFileSync(artifact.path, 'utf8'), 'original');

  const outside = join(root, 'outside');
  const linkedRun = join(config.stateDirectory, 'runs', 'linked-run');
  mkdirSync(outside);
  try {
    symlinkSync(outside, linkedRun, 'junction');
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('Junction creation is unavailable on this Windows host');
    throw error;
  }
  assert.throws(() => persistRunArtifact(config, 'linked-run', 'outside.txt', 'unsafe'),
    /linked or non-directory state path/);
  assert.equal(existsSync(join(outside, 'outside.txt')), false);
});

test('prune refuses linked content instead of following it', t => {
  const { root, config } = fixture(t);
  persistRunArtifact(config, 'run-1', 'result.json', 'safe');
  completeRunEvidence(config, 'run-1');
  ageManifest(config, 'run-1', '2026-10-01T00:00:00.000Z');
  const outside = join(root, 'outside.txt');
  const link = join(config.stateDirectory, 'runs', 'run-1', 'outside-link.txt');
  writeFileSync(outside, 'outside');
  try {
    symlinkSync(outside, link, 'file');
  } catch (error) {
    if (error.code === 'EPERM') return t.skip('Symlink creation is unavailable on this Windows host');
    throw error;
  }
  assert.throws(() => pruneState(config, { nowMs: Date.parse('2026-10-14T00:00:00.000Z') }),
    /Refusing to follow linked state path/);
  assert.equal(readFileSync(outside, 'utf8'), 'outside');
});

test('gitignore preflight accepts ignored state and rejects tracked-scope state', t => {
  const { root, config } = fixture(t);
  execFileSync('git', ['init', '--quiet'], { cwd: root });
  writeFileSync(join(root, '.gitignore'), '.state/\n');
  assert.deepEqual(assertStateDirectoryIgnored(config, root), {
    checked: true, ignored: true, path: config.stateDirectory
  });

  const unignored = { ...config, stateDirectory: join(root, 'evidence-state') };
  mkdirSync(unignored.stateDirectory);
  assert.throws(() => assertStateDirectoryIgnored(unignored, root),
    /must be gitignored before evidence is stored/);
});
