import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Ledger } from '../src/ledger.js';
import { hash, json } from '../src/common.js';
import { OPERATION_REFS_V1, ledgerSnapshotHash, operationRows, operationRowsHash,
  operationDetail, verifyOperationReferences } from '../src/operation-evidence.js';
import { verifyContinuationPredecessor } from '../src/workers.js';

test('bounds nested history without omitting any operation detail or metadata from its digest', () => {
  let operations = [{ id: 'previous', state: 'prepared', detail: json({ path: String.raw`C:\a\b` }) }];
  for (let i = 0; i < 15; i++) {
    const rows = operationRows(operations, OPERATION_REFS_V1);
    assert(json(rows).length < 300);
    assert.notEqual(operationRowsHash(operations, OPERATION_REFS_V1),
      operationRowsHash([{ ...operations[0], detail: `${operations[0].detail} ` }], OPERATION_REFS_V1));
    assert.notEqual(operationRowsHash(operations, OPERATION_REFS_V1),
      operationRowsHash([{ ...operations[0], state: 'completed' }], OPERATION_REFS_V1));
    operations = [{ ...operations[0], detail: json({ operations: rows }) }];
  }
  const snapshot = { job: { id: 'job' }, result: { id: 'result' }, assignment: {}, operations };
  assert.equal(ledgerSnapshotHash(snapshot), hash(json(snapshot)));
  assert.equal(ledgerSnapshotHash(snapshot, OPERATION_REFS_V1),
    ledgerSnapshotHash({ ...snapshot, operations: operationRows(operations, OPERATION_REFS_V1) },
      OPERATION_REFS_V1));
});

test('resolves exact read-only predecessor details and rejects body, metadata and missing-row drift', t => {
  const directory = mkdtempSync(join(tmpdir(), 'operation-evidence-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = new Ledger(directory);
  try {
    const original = { authorization: { approved: true }, operations: [{ detail: '\\'.repeat(4096) }] };
    ledger.operation('previous', 'assignment', 'continued-from-validation-failure', original);
    ledger.finishOperation('previous', 'prepared', original);
    const rows = operationRows(ledger.status().operations, OPERATION_REFS_V1);
    assert.doesNotThrow(() => verifyOperationReferences(rows, directory));
    assert.deepEqual(operationDetail(rows[0], directory), original);
    assert.deepEqual(operationDetail({ detail: json(original) }, directory), original);
    assert.throws(() => verifyOperationReferences([{ ...rows[0], state: 'completed' }], directory),
      /operation evidence changed/);
    assert.throws(() => verifyOperationReferences([{ ...rows[0], id: 'missing' }], directory),
      /operation evidence changed/);
    ledger.finishOperation('previous', 'prepared', { ...original, authorization: { approved: false } });
    assert.throws(() => operationDetail(rows[0], directory), /operation evidence changed/);
  } finally { ledger.close(); }
});

test('rejects unknown formats and malformed references rather than treating them as legacy evidence', () => {
  const rows = [{ id: 'operation', detail: '{}' }];
  assert.throws(() => ledgerSnapshotHash({ operations: rows }, 'unknown'), /Unknown operation/);
  const references = operationRows(rows, OPERATION_REFS_V1);
  assert.throws(() => ledgerSnapshotHash({ operations: references }), /explicit evidence format/);
  assert.throws(() => operationDetail(undefined), /Missing predecessor operation evidence/);
  for (const detail of [{ format: OPERATION_REFS_V1, sha256: 'invalid' },
    { format: 'unknown', sha256: 'a'.repeat(64) },
    { format: OPERATION_REFS_V1, sha256: 'a'.repeat(64), omitted: true }])
    assert.throws(() => operationRows([{ id: 'operation', detail }], OPERATION_REFS_V1),
      /complete detail digest/);
});

test('compact continuation reservations still reject predecessor changes and wrong attempt identifiers', t => {
  const directory = mkdtempSync(join(tmpdir(), 'operation-reservation-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const ledger = new Ledger(directory);
  try {
    const stamp = new Date().toISOString(), result = { id: 'result' };
    ledger.db.prepare(`INSERT INTO jobs
      (id,investigation_id,version,repo,state,session_id,updated_at) VALUES(?,?,?,?,?,?,?)`)
      .run('assignment', 'investigation', 1, 'repo', 'blocked', 'old-attempt', stamp);
    ledger.db.prepare('INSERT INTO records(kind,id,body,created_at) VALUES(?,?,?,?)')
      .run('workerResult', result.id, json(result), stamp);
    ledger.operation('prior', 'assignment', 'continued-from-validation-failure', { approved: true });
    ledger.finishOperation('prior', 'prepared', { approved: true });
    const continuation = { priorStateDirectory: directory, priorJob: ledger.job('assignment'),
      priorResult: result, priorResultSha256: hash(json(result)), operationsFormat: OPERATION_REFS_V1,
      priorOperationsSha256: operationRowsHash(ledger.status().operations, OPERATION_REFS_V1) };
    ledger.operation('next', 'assignment', 'validation-continuation', {});
    ledger.finishOperation('next', 'prepared', { nextAttemptId: 'new-attempt' });
    assert.doesNotThrow(() => verifyContinuationPredecessor(continuation, 'next', 'new-attempt'));
    assert.throws(() => verifyContinuationPredecessor(continuation, 'next', 'wrong-attempt'),
      /Prior authoring state/);
    ledger.finishOperation('prior', 'prepared', { approved: false });
    assert.throws(() => verifyContinuationPredecessor(continuation, 'next', 'new-attempt'),
      /Prior authoring state/);
  } finally { ledger.close(); }
});
