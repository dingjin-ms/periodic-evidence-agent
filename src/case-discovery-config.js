import { closeSync, existsSync, fsyncSync, openSync, readFileSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { boundedPath, hash, json, requireThat, uuid, validateRecord } from './common.js';
import { completedOperation, operationRow } from './case-generation.js';
import { loadDiscoveryRun } from './case-discovery.js';
import { caseSourceInventory, urlWithinScope } from './case-source-inventory.js';
import { Ledger } from './ledger.js';

function selectionFor(ledger, run) {
  const selected = completedOperation(ledger, `${run.id}:selection`, 'case-discovery-selection');
  const manifest = selected.manifest;
  requireThat(['selection-qualified', 'partial'].includes(selected.state) &&
    manifest?.format === 'case-discovery-manifest-v1' && manifest.runId === run.id &&
    selected.manifestSha256 === hash(json(manifest)),
  'Discovery selection is blocked or its manifest integrity changed', 'blocked-reconciliation');
  requireThat(manifest.scope === run.request.scope,
    'Discovery manifest does not match the approved scope', 'blocked-reconciliation');
  validateRecord(manifest.selection, 'caseDiscoverySelection');
  validateRecord(manifest.sources, 'caseDiscoverySources');
  requireThat(typeof manifest.assurance === 'string' && manifest.assurance.trim(),
    'Discovery manifest requires an assurance statement', 'invalid-record');
  for (const source of manifest.sources) requireThat(
    urlWithinScope(source.url, run.request.allowedUrlPrefixes) &&
    source.surfaces.every(surface => run.request.surfaces.includes(surface)),
  'Selected discovery source is outside the approved scope', 'blocked-scope');
  return selected;
}

function projection(run, selected) {
  const configuration = JSON.parse(run.configuration);
  requireThat(configuration && typeof configuration === 'object' && !Array.isArray(configuration),
    'Discovery configuration must be an object', 'invalid-record');
  const discovery = { format: 'case-discovery-config-v1', runId: run.id,
    manifestSha256: selected.manifestSha256 };
  validateRecord(discovery, 'caseDiscoveryConfig');
  const projected = { ...configuration, discovery, sources: structuredClone(selected.manifest.sources) };
  caseSourceInventory(projected);
  return `${JSON.stringify(projected, null, 2)}\n`;
}

function checkReceipt(receipt, run, selected, target, newSha256) {
  requireThat(receipt.state === 'configuration-applied' && receipt.target === target &&
    receipt.runId === run.id && receipt.manifestSha256 === selected.manifestSha256 &&
    receipt.oldSha256 === run.configurationSha256 && receipt.configurationSha256 === newSha256,
  'Discovery publication receipt does not match the selected configuration', 'blocked-reconciliation');
}

function finishPublication(ledger, run, selected, target, newSha256) {
  const receipt = { state: 'configuration-applied', target, runId: run.id,
    manifestSha256: selected.manifestSha256, configurationSha256: newSha256,
    oldSha256: run.configurationSha256 };
  ledger.transaction(() => {
    ledger.operation(`${run.id}:config`, run.id, 'case-discovery-config-publication', receipt);
    ledger.finishOperation(`${run.id}:config`, 'complete', receipt);
  });
  return receipt;
}

// The lock serializes cooperating publishers, not arbitrary editors. SQLite and the
// filesystem cannot commit together; the private intent reconciles an interrupted
// rename, but cannot eliminate a noncooperating editor's check/rename race or
// guarantee directory-entry durability after power loss.
export async function applyDiscoveryConfig(base, ledger, runId,
  { authorizeConfigUpdate = false } = {}, dependencies = {}) {
  requireThat(base.statePolicy?.accessApproved === true,
    'Discovery publication requires approved private storage', 'blocked-authorization');
  const run = loadDiscoveryRun(base, ledger, runId);
  const target = boundedPath(run.projectRoot, 'generateE2E.config.json', { write: true });
  const lock = `case-discovery-config:${hash(target)}`, owner = ledger.acquire(lock);
  let temporary;
  try {
    const selected = selectionFor(ledger, run), projected = projection(run, selected);
    const newSha256 = hash(projected);
    const publication = operationRow(ledger, `${run.id}:config`);
    if (publication) {
      const receipt = completedOperation(ledger, `${run.id}:config`, 'case-discovery-config-publication');
      checkReceipt(receipt, run, selected, target, newSha256);
      requireThat(hash(readFileSync(target)) === receipt.configurationSha256,
        'Published discovery configuration changed externally', 'blocked-reconciliation');
      return receipt;
    }
    const intentId = `${run.id}:config-intent`;
    const row = operationRow(ledger, intentId);
    if (row) {
      requireThat(row.kind === 'case-discovery-config-publication-intent' && row.state === 'started',
        'Invalid discovery configuration publication intent', 'blocked-reconciliation');
      const intent = JSON.parse(row.detail);
      requireThat(intent.target === target && intent.runId === run.id &&
        intent.manifestSha256 === selected.manifestSha256 &&
        intent.oldSha256 === run.configurationSha256 && intent.newSha256 === newSha256 &&
        intent.originalBytes === Buffer.from(run.configuration).toString('base64') &&
        intent.newBytes === Buffer.from(projected).toString('base64') &&
        hash(Buffer.from(intent.originalBytes, 'base64')) === intent.oldSha256 &&
        hash(Buffer.from(intent.newBytes, 'base64')) === intent.newSha256,
      'Saved discovery publication projection changed', 'blocked-reconciliation');
      const currentSha256 = hash(readFileSync(target));
      if (currentSha256 === newSha256)
        return finishPublication(ledger, run, selected, target, newSha256);
      requireThat(currentSha256 === run.configurationSha256,
        'Discovery publication conflicts with an external configuration edit', 'blocked-reconciliation');
    }
    requireThat(authorizeConfigUpdate === true,
      'Discovery configuration update requires explicit authorization', 'blocked-authorization');
    requireThat(hash(Buffer.from(run.configuration)) === run.configurationSha256 &&
      hash(readFileSync(target)) === run.configurationSha256,
    'Discovery configuration changed since its approved baseline', 'blocked-reconciliation');
    if (!row) ledger.operation(intentId, run.id, 'case-discovery-config-publication-intent', {
      target, runId: run.id, manifestSha256: selected.manifestSha256,
      oldSha256: run.configurationSha256, newSha256,
      originalBytes: Buffer.from(run.configuration).toString('base64'),
      newBytes: Buffer.from(projected).toString('base64')
    });
    const candidate = `${target}.${uuid()}.discovery`;
    const descriptor = openSync(candidate, 'wx', 0o600);
    temporary = candidate;
    try {
      writeFileSync(descriptor, projected);
      fsyncSync(descriptor);
    } finally { closeSync(descriptor); }
    await dependencies.beforeReplace?.({ target, temporary });
    requireThat(boundedPath(run.projectRoot, 'generateE2E.config.json', { write: true }) === target &&
      hash(readFileSync(target)) === run.configurationSha256 &&
      hash(readFileSync(temporary)) === newSha256,
    'Discovery configuration or candidate changed before replacement', 'blocked-reconciliation');
    renameSync(temporary, target);
    temporary = undefined;
    await dependencies.afterReplace?.({ target });
    requireThat(hash(readFileSync(target)) === newSha256,
      'Discovery configuration replacement failed readback', 'blocked-reconciliation');
    return finishPublication(ledger, run, selected, target, newSha256);
  } finally {
    try { if (temporary && existsSync(temporary)) unlinkSync(temporary); }
    finally { ledger.release(lock, owner); }
  }
}

export function verifyDiscoveryHandoff(base, configuration, configurationSha256) {
  requireThat(base.statePolicy?.accessApproved === true,
    'Discovery verification requires approved private storage', 'blocked-authorization');
  validateRecord(configuration.discovery, 'caseDiscoveryConfig');
  validateRecord(configuration.sources, 'caseDiscoverySources');
  const ledger = new Ledger(join(base.stateDirectory, 'discovery'), { readOnly: true });
  try {
    const run = loadDiscoveryRun(base, ledger, configuration.discovery.runId);
    const selected = selectionFor(ledger, run), projected = projection(run, selected);
    const receipt = completedOperation(ledger, `${run.id}:config`, 'case-discovery-config-publication');
    const target = boundedPath(run.projectRoot, 'generateE2E.config.json');
    checkReceipt(receipt, run, selected, target, hash(projected));
    requireThat(configurationSha256 === receipt.configurationSha256 &&
      hash(readFileSync(target)) === receipt.configurationSha256 &&
      configuration.discovery.manifestSha256 === selected.manifestSha256 &&
      json(configuration) === json(JSON.parse(projected)) &&
      json(configuration.sources) === json(selected.manifest.sources),
    'Discovery handoff configuration, catalog or manifest hash changed', 'blocked-reconciliation');
    caseSourceInventory(configuration);
    const selectedIds = new Set(selected.manifest.sources.map(source => source.id));
    const qualifications = selected.manifest.candidates.filter(candidate => selectedIds.has(candidate.id))
      .map(({ id, provider, exactLocation, sourceVersion, authority, authorityBasis, applicability, limitations }) =>
        ({ id, provider, exactLocation, sourceVersion, authority, authorityBasis: authorityBasis ?? null,
          applicability, limitations }));
    return { runId: run.id, manifestSha256: selected.manifestSha256,
      coverage: selected.manifest.selection.coverage, gaps: selected.manifest.selection.gaps,
      assurance: selected.manifest.assurance, qualifications };
  } finally { ledger.close(); }
}
