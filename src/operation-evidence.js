import { DatabaseSync } from 'node:sqlite';
import { isAbsolute, join } from 'node:path';
import { hash, json, requireThat } from './common.js';

export const OPERATION_REFS_V1 = 'ledger-operation-detail-refs-v1';

export function operationRows(operations, format) {
  if (format === undefined) {
    requireThat(operations.every(row => row.detail === undefined || typeof row.detail === 'string'),
      'Operation references require an explicit evidence format', 'blocked-reconciliation');
    return operations;
  }
  requireThat(format === OPERATION_REFS_V1,
    'Unknown operation evidence format', 'blocked-reconciliation');
  return operations.map(({ detail, ...row }) => {
    const reference = typeof detail === 'string'
      ? { format, sha256: hash(detail) } : detail;
    requireThat(reference?.format === format &&
      json(Object.keys(reference).sort()) === json(['format', 'sha256']) &&
      /^[a-f0-9]{64}$/.test(reference.sha256 ?? ''),
    'Operation evidence requires the complete detail digest', 'blocked-reconciliation');
    return { ...row, detail: reference };
  });
}

export function operationRowsHash(operations, format) {
  return hash(json(operationRows(operations, format)));
}

export function ledgerSnapshotHash(snapshot, format) {
  return hash(json({ ...snapshot, operations: operationRows(snapshot.operations, format) }));
}

export function verifyOperationReferences(operations, directory) {
  requireThat(isAbsolute(directory ?? ''),
    'Operation evidence requires its exact predecessor ledger', 'blocked-reconciliation');
  const database = new DatabaseSync(join(directory, 'ledger.sqlite'), { readOnly: true });
  try {
    const select = database.prepare('SELECT * FROM operations WHERE id=?');
    for (const operation of operations) {
      const stored = select.get(operation.id);
      requireThat(stored &&
        json(operationRows([stored], OPERATION_REFS_V1)[0]) === json(operation),
      'Predecessor operation evidence changed', 'blocked-reconciliation');
    }
  } finally { database.close(); }
}

export function operationDetail(operation, directory) {
  requireThat(operation, 'Missing predecessor operation evidence', 'blocked-reconciliation');
  if (typeof operation?.detail === 'string') return JSON.parse(operation.detail);
  verifyOperationReferences([operation], directory);
  const database = new DatabaseSync(join(directory, 'ledger.sqlite'), { readOnly: true });
  try {
    const stored = database.prepare('SELECT detail FROM operations WHERE id=?').get(operation.id);
    requireThat(hash(stored.detail) === operation.detail.sha256,
      'Predecessor operation detail changed', 'blocked-reconciliation');
    return JSON.parse(stored.detail);
  } finally { database.close(); }
}
