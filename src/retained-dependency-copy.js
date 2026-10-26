import { closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { boundedPath, hash, json, now, requireThat } from './common.js';
import { readDependencyCopyProgress } from './validation-workspace.js';

function outside(root, path) {
  const name = relative(root, path);
  return name === '..' || name.startsWith(`..${sep}`) || isAbsolute(name);
}

export function verifyRetainedDependencyCopy(reference, source, workspace, revision, paths,
  helperSha256) {
  requireThat(isAbsolute(reference?.path ?? '') &&
    /^[a-f0-9]{64}$/.test(reference.sha256 ?? '') &&
    lstatSync(reference.path).isFile() && !lstatSync(reference.path).isSymbolicLink() &&
    lstatSync(reference.path).size <= 1024 * 1024,
  'Retained dependency copy needs a bounded pinned manifest', 'blocked-validation');
  const bytes = readFileSync(reference.path);
  requireThat(hash(bytes) === reference.sha256,
    'Retained dependency copy manifest changed', 'blocked-validation');
  const proof = JSON.parse(bytes);
  requireThat(proof.format === 'standalone-dependency-copy-diagnostic-v1' &&
    proof.status === 'diagnostic-copy-completed-not-qualified' &&
    proof.directoryBatchCopyCompleted === true && proof.phase === 'post-source-check' &&
    proof.expectedSource === revision && proof.expectedHelper === helperSha256 &&
    realpathSync(proof.source) === realpathSync(source) &&
    proof.isFormalValidation === false && proof.countsTowardBusinessFive === false &&
    proof.eligibleAsDependencySeed === false && proof.nativeUnitStarted === false &&
    proof.businessStarted === false && Array.isArray(proof.omittedNonDirectories) &&
    proof.omittedNonDirectories.length === 0 && json(proof.currentPaths) === json(paths) &&
    typeof proof.completedAt === 'string' && Number.isFinite(Date.parse(proof.completedAt)) &&
    isAbsolute(proof.workspace ?? ''),
  'Only a complete source-bound diagnostic copy can be qualified', 'blocked-validation');
  const retained = realpathSync(proof.workspace), target = realpathSync(workspace);
  const stateRoot = realpathSync(fileURLToPath(new URL('../.state', import.meta.url)));
  requireThat(retained === resolve(proof.workspace) &&
    dirname(dirname(retained)) === stateRoot &&
    basename(dirname(retained)).startsWith('copy-diagnostic-') &&
    /^[a-f0-9-]{36}$/.test(basename(retained)) &&
    !lstatSync(retained).isSymbolicLink() && !existsSync(resolve(retained, '.git')) &&
    outside(realpathSync(source), retained) && outside(retained, realpathSync(source)) &&
    outside(retained, target) && outside(target, retained) &&
    lstatSync(retained).dev === lstatSync(target).dev &&
    !existsSync(`${retained}.dependency-copy-consumed.json`),
  'Retained dependency copy must be isolated, unconsumed and on the target volume',
  'blocked-validation');
  requireThat(Array.isArray(proof.batches) && proof.batches.length === Math.ceil(paths.length / 50),
    'Retained dependency copy has incomplete batches', 'blocked-validation');
  for (let offset = 0; offset < paths.length; offset += 50) {
    const batch = proof.batches[offset / 50], batchPaths = paths.slice(offset, offset + 50);
    requireThat(batch.index === offset && json(batch.paths) === json(batchPaths) &&
      batch.status === 'passed' && batch.ownedProcessesExited === true &&
      isAbsolute(batch.progressPath ?? '') &&
      realpathSync(dirname(batch.progressPath)) === dirname(retained) &&
      basename(batch.progressPath).startsWith(`${basename(retained)}.dependency-copy-`) &&
      basename(batch.progressPath).endsWith('.jsonl'),
    'Retained dependency copy batch provenance is incomplete', 'blocked-validation');
    const progress = readDependencyCopyProgress(batch.progressPath, batchPaths, offset);
    requireThat(progress.status === 'passed' && progress.completedPaths === batchPaths.length &&
      progress.activePaths.length === 0 && progress.failedPath === null &&
      progress.timeout === false && !progress.trailingRecordIncomplete,
    'Retained dependency copy lacks a complete durable checkpoint', 'blocked-validation');
  }
  for (const path of paths) {
    requireThat(lstatSync(boundedPath(retained, path)).isDirectory() &&
      !existsSync(boundedPath(target, path, { write: true })),
    'Retained dependency roots must be ordinary directories with fresh destinations',
    'blocked-validation');
  }
  return { reference, retained, target, revision, paths };
}

export function consumeRetainedDependencyCopy(copy, deadline) {
  const marker = `${copy.retained}.dependency-copy-consumed.json`;
  const descriptor = openSync(marker, 'wx', 0o600);
  try {
    writeFileSync(descriptor, `${json({
      format: 'retained-dependency-copy-consumption-v1', manifest: copy.reference,
      workspace: copy.target, sourceRevision: copy.revision, startedAt: now()
    })}\n`);
    fsyncSync(descriptor);
  } finally { closeSync(descriptor); }
  // A partial move remains consumed; it must never be silently replayed.
  for (const path of copy.paths) {
    requireThat(Date.now() < deadline, 'Retained dependency move exceeded its bounded deadline',
      'blocked-validation');
    const source = boundedPath(copy.retained, path);
    const target = boundedPath(copy.target, path, { write: true });
    requireThat(lstatSync(source).isDirectory() && !existsSync(target),
      'Retained dependency roots changed before their move', 'blocked-validation');
    mkdirSync(dirname(target), { recursive: true });
    renameSync(source, target);
  }
  return marker;
}
