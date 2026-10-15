import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAt, json, now } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import {
  cleanupAgencyTransport,
  cleanupAgencyTransports
} from '../src/agency-transport-gc.js';

function fixture(t, id = 'assignment-transport') {
  const root = mkdtempSync(join(tmpdir(), 'agency-transport-gc-'));
  const checkout = join(root, 'reference');
  mkdirSync(checkout);
  const config = configAt('pilot.example.json');
  config.stateDirectory = root;
  config.workspaceCleanup = { enabled: true, retentionHours: 0 };
  config.repositories = [{
    id: 'fixture',
    remote: 'https://example.invalid/fixture.git',
    referenceCheckout: checkout
  }];
  const ledger = new Ledger(root);
  const sessionId = 'transport-session';
  const sourceRevision = 'f'.repeat(40);
  const baseRevision = 'a'.repeat(40);
  const resultRevision = 'b'.repeat(40);
  const artifact = join(root, 'artifacts', 'validation.json');
  mkdirSync(join(root, 'artifacts'));
  writeFileSync(artifact, '{}');
  ledger.db.prepare(`INSERT INTO jobs
    (id,investigation_id,version,repo,state,session_id,updated_at)
    VALUES(?,?,?,?,?,?,?)`).run(
    id, 'investigation-transport', 1, 'fixture', 'completed', sessionId, now());
  const workerResult = {
    assignmentId: id,
    attemptId: sessionId,
    outcome: 'draft-pr-validated',
    blocker: null,
    sourceRevision,
    reportedAt: '2026-01-01T00:00:00.000Z',
    validation: [{ artifactRefs: [artifact] }],
    validationAttempts: [],
    draftPR: {
      isDraft: true,
      headRevision: sourceRevision,
      url: 'https://example.invalid/draft/1'
    }
  };
  ledger.db.prepare('INSERT INTO records VALUES(?,?,?,?,?)').run(
    'workerResult', `worker-result-${id}`, 1, json(workerResult), now());
  const inputRef = `refs/heads/pilot-agency-base/${id}/round-0`;
  const resultRef = `refs/heads/pilot-agency-result/${id}/round-0`;
  const detail = {
    round: 0,
    baseRevision,
    resultRevision,
    inputRef,
    resultRef
  };
  ledger.operation(`${id}:agency-remote-result:0`, id,
    'agency-remote-result', detail);
  ledger.finishOperation(`${id}:agency-remote-result:0`, 'completed', detail);
  const heads = new Map([
    [inputRef, baseRevision],
    [resultRef, resultRevision],
    [`refs/heads/pilot/${id}`, sourceRevision]
  ]);
  const deleted = [];
  const dependencies = {
    verifyCheckout: async () => true,
    remoteHead: async (_config, _repo, ref) => heads.get(ref) ?? null,
    deleteRemoteRefs: async (_config, _repo, refs) => {
      deleted.push(...refs);
      for (const ref of refs) heads.delete(ref);
    }
  };
  t.after(() => {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    config, ledger, id, inputRef, resultRef, heads, deleted, dependencies
  };
}

test('transport cleanup previews, removes exact round refs and is idempotent', async t => {
  const f = fixture(t);
  const preview = await cleanupAgencyTransport(
    f.config, f.ledger, f.id, {}, f.dependencies);
  assert.equal(preview.state, 'eligible');
  assert.deepEqual(preview.refs.map(item => item.ref),
    [f.inputRef, f.resultRef]);
  assert.deepEqual(f.deleted, []);

  const removed = await cleanupAgencyTransport(
    f.config, f.ledger, f.id, { execute: true }, f.dependencies);
  assert.equal(removed.state, 'removed');
  assert.deepEqual(f.deleted, [f.inputRef, f.resultRef]);
  assert.equal(f.heads.has(`refs/heads/pilot/${f.id}`), true);
  assert.equal(f.ledger.transportCleanup(f.id).state, 'removed');

  const repeated = await cleanupAgencyTransport(
    f.config, f.ledger, f.id, { execute: true }, f.dependencies);
  assert.equal(repeated.state, 'removed');
  assert.deepEqual(f.deleted, [f.inputRef, f.resultRef]);
  const all = await cleanupAgencyTransports(
    f.config, f.ledger, { execute: true }, f.dependencies);
  assert.equal(all[0].state, 'removed');
});

test('transport cleanup retains mismatched refs without deleting anything', async t => {
  const f = fixture(t, 'assignment-mismatch');
  f.heads.set(f.resultRef, 'c'.repeat(40));
  const result = await cleanupAgencyTransport(
    f.config, f.ledger, f.id, { execute: true }, f.dependencies);
  assert.equal(result.state, 'skipped');
  assert.match(result.reason, /differs from its retained receipt/);
  assert.deepEqual(f.deleted, []);
  assert.equal(f.ledger.transportCleanup(f.id).state, 'skipped');
});

test('transport cleanup reconciles refs deleted before the final receipt', async t => {
  const f = fixture(t, 'assignment-interrupted');
  const deleting = {
    assignmentId: f.id,
    state: 'deleting',
    reason: 'Controller stopped after remote deletion',
    refs: [
      { ref: f.inputRef, revision: 'a'.repeat(40) },
      { ref: f.resultRef, revision: 'b'.repeat(40) }
    ]
  };
  f.ledger.operation(`${f.id}:transport-cleanup:interrupted`, f.id,
    'agency-transport-cleanup', deleting);
  f.ledger.recordTransportCleanup(f.id, deleting);
  f.heads.delete(f.inputRef);
  f.heads.delete(f.resultRef);

  const result = await cleanupAgencyTransport(
    f.config, f.ledger, f.id, { execute: true }, f.dependencies);
  assert.equal(result.state, 'removed');
  assert.match(result.reason, /reconciled/);
  assert.deepEqual(f.deleted, []);
});

test('transport cleanup preserves a partial deletion as failed reconciliation', async t => {
  const f = fixture(t, 'assignment-partial');
  const partialDependencies = {
    ...f.dependencies,
    deleteRemoteRefs: async (_config, _repo, refs) => {
      f.heads.delete(refs[0]);
      throw new Error('synthetic partial remote deletion');
    }
  };
  const failed = await cleanupAgencyTransport(
    f.config, f.ledger, f.id, { execute: true }, partialDependencies);
  assert.equal(failed.state, 'failed');
  assert.equal(f.ledger.transportCleanup(f.id).state, 'failed');

  const retained = await cleanupAgencyTransport(
    f.config, f.ledger, f.id, { execute: true }, f.dependencies);
  assert.equal(retained.state, 'failed');
  assert.match(retained.reason, /missing or differs/);
  assert.deepEqual(f.deleted, []);

  f.heads.delete(f.resultRef);
  const reconciled = await cleanupAgencyTransport(
    f.config, f.ledger, f.id, { execute: true }, f.dependencies);
  assert.equal(reconciled.state, 'removed');
  assert.match(reconciled.reason, /reconciled/);
});
