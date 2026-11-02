import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { hash, json } from '../src/common.js';
import { verifyRetainedDependencyCopy, consumeRetainedDependencyCopy } from '../src/retained-dependency-copy.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'retained-copy-'));
  const owned = fileURLToPath(new URL(`../.state/copy-diagnostic-test-${randomUUID()}`, import.meta.url));
  const retained = join(owned, randomUUID()), source = join(root, 'source'), target = join(root, 'target');
  t.after(() => {
    rmSync(root, { recursive: true, force: true });
    rmSync(owned, { recursive: true, force: true });
  });
  const paths = ['ooui/.store', 'ooui/apps/example/lib'];
  for (const directory of [source, retained])
    for (const path of paths) {
      mkdirSync(join(directory, path), { recursive: true });
      writeFileSync(join(directory, path, 'output.txt'), 'exact source output');
    }
  mkdirSync(target);
  const progressPath = `${retained}.dependency-copy-test.jsonl`;
  const checkpoint = { status: 'passed', completedPaths: paths.length,
    activePaths: [], failedPath: null, timeout: false };
  const writeCheckpoint = () => writeFileSync(progressPath, `${json({
    format: 'dependency-copy-progress-v1', directoryOffset: 0, paths, checkpointInterval: 10
  })}\n${json(checkpoint)}\n`);
  writeCheckpoint();
  const revision = 'a'.repeat(40), helper = 'b'.repeat(64);
  const proof = {
    format: 'standalone-dependency-copy-diagnostic-v1',
    status: 'diagnostic-copy-completed-not-qualified', phase: 'post-source-check',
    directoryBatchCopyCompleted: true, expectedSource: revision, expectedHelper: helper,
    source, workspace: retained, currentPaths: paths, omittedNonDirectories: [],
    isFormalValidation: false, countsTowardBusinessFive: false, eligibleAsDependencySeed: false,
    nativeUnitStarted: false, businessStarted: false, completedAt: '2026-01-01T00:00:00Z',
    batches: [{ index: 0, paths, progressPath, status: 'passed', ownedProcessesExited: true }]
  };
  const reference = { path: join(root, 'diagnostic.json') };
  const pin = () => {
    writeFileSync(reference.path, json(proof));
    reference.sha256 = hash(json(proof));
  };
  pin();
  const verify = () => verifyRetainedDependencyCopy(reference, source, target, revision, paths, helper);
  return { source, target, retained, proof, reference, pin, verify, checkpoint, writeCheckpoint };
}

test('retained diagnostic directories move once without changing author output bytes', t => {
  const f = fixture(t), copy = f.verify();
  const marker = consumeRetainedDependencyCopy(copy, Date.now() + 10000);
  assert.equal(JSON.parse(readFileSync(marker)).manifest.sha256, f.reference.sha256);
  for (const path of f.proof.currentPaths) {
    assert(!existsSync(join(f.retained, path)));
    assert.equal(readFileSync(join(f.target, path, 'output.txt'), 'utf8'), 'exact source output');
    assert.equal(readFileSync(join(f.source, path, 'output.txt'), 'utf8'), 'exact source output');
  }
  assert.throws(f.verify, /unconsumed/);
});

test('retained copy rejects unsealed, mismatched, invoked or incompletely contained provenance', t => {
  for (const mutate of [
    f => { f.proof.status = 'running'; },
    f => { f.proof.directoryBatchCopyCompleted = false; },
    f => { f.proof.expectedSource = 'c'.repeat(40); },
    f => { f.proof.expectedHelper = 'c'.repeat(64); },
    f => { f.proof.nativeUnitStarted = true; },
    f => { f.proof.eligibleAsDependencySeed = true; },
    f => { f.proof.currentPaths = []; },
    f => { f.proof.omittedNonDirectories = ['missing-file']; },
    f => { f.proof.batches[0].ownedProcessesExited = false; },
    f => { f.proof.batches[0].paths = ['unrelated']; },
    f => { f.proof.batches[0].index = 50; }
  ]) {
    const f = fixture(t);
    mutate(f); f.pin();
    assert.throws(f.verify);
    assert(existsSync(join(f.retained, 'ooui', '.store', 'output.txt')));
    assert(!existsSync(join(f.target, 'ooui')));
  }
});

test('retained copy validates the current complete checkpoint and pinned manifest', t => {
  for (const mutate of [
    f => { f.checkpoint.status = 'copying'; f.writeCheckpoint(); },
    f => { f.checkpoint.completedPaths--; f.writeCheckpoint(); },
    f => { f.checkpoint.timeout = true; f.writeCheckpoint(); },
    f => { f.checkpoint.failedPath = 'ooui/.store'; f.writeCheckpoint(); },
    f => { f.reference.sha256 = 'c'.repeat(64); },
    f => { writeFileSync(join(f.retained, '.git'), 'unrelated worktree'); },
    f => { mkdirSync(join(f.target, 'ooui', '.store'), { recursive: true }); }
  ]) {
    const f = fixture(t);
    mutate(f);
    assert.throws(f.verify);
  }
});

test('a partially moved retained copy stays consumed and cannot be silently replayed', t => {
  const f = fixture(t), copy = f.verify();
  rmSync(join(f.retained, 'ooui', 'apps', 'example', 'lib'), { recursive: true });
  assert.throws(() => consumeRetainedDependencyCopy(copy, Date.now() + 10000));
  assert(existsSync(join(f.target, 'ooui', '.store', 'output.txt')));
  assert(existsSync(`${f.retained}.dependency-copy-consumed.json`));
  assert.throws(f.verify, /unconsumed/);
  assert(existsSync(join(f.source, 'ooui', 'apps', 'example', 'lib', 'output.txt')));
});
