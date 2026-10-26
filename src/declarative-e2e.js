import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { boundedPath, hash, json, requireThat } from './common.js';

const require = createRequire(import.meta.url);
const native = require('../scripts/validation/1js-declarative-e2e.cjs');
export const declarativeProfile = native.FORMAT;
export const declarativeRegistrationFiles = native.REGISTRATION_FILES;
const builtinProfile = fileURLToPath(new URL('../scripts/validation/1js-declarative-e2e.cjs', import.meta.url));

export function configureDeclarativeGate(gate, configFile) {
  if (gate.profile === undefined) return;
  requireThat(gate.profile === declarativeProfile,
    `Unknown built-in validation profile: ${gate.profile}`);
  requireThat((gate.profilePath === undefined ||
    resolve(dirname(resolve(configFile)), gate.profilePath) === builtinProfile) &&
    (gate.profileSha256 === undefined || gate.profileSha256 === hash(readFileSync(builtinProfile))) &&
    (gate.args === undefined || json(gate.args) === json(['{profile}'])),
  'Built-in declarative validation owns its profile binding and argument list');
  const options = gate.declarativeE2E;
  requireThat(options && Object.keys(options).every(key =>
    ['cdpEndpoint', 'yarnEntryPoint', 'maxCases', 'installDependencies', 'registration',
      'commandTimeoutMs'].includes(key)),
  'The declarative profile requires explicit repository-level execution settings');
  requireThat(Number.isInteger(options.maxCases) && options.maxCases >= 1 &&
    options.maxCases <= 10 && typeof options.installDependencies === 'boolean' &&
    typeof options.registration?.approved === 'boolean' &&
    ['P0', 'P1', 'P2'].includes(options.registration.priority) &&
    Object.keys(options.registration).every(key => ['approved', 'priority'].includes(key)),
  'Invalid bounded declarative registration/execution policy');
  if (options.commandTimeoutMs !== undefined)
    requireThat(Number.isInteger(options.commandTimeoutMs) && options.commandTimeoutMs > 0,
      'Declarative commandTimeoutMs must be positive');
  if (gate.approved === true) {
    requireThat(isAbsolute(gate.executable ?? '') && isAbsolute(options.yarnEntryPoint ?? '') &&
      existsSync(gate.executable) && statSync(gate.executable).isFile() &&
      existsSync(options.yarnEntryPoint) && statSync(options.yarnEntryPoint).isFile(),
    'Approve the installed Node and Yarn/Corepack entry points before enabling declarative execution');
    native.validateRequest({
      format: declarativeProfile, assignmentId: 'configuration-check',
      baseRevision: 'a'.repeat(40), sourceRevision: 'a'.repeat(40),
      evidenceIds: ['configuration-check'], inputItemIds: ['configuration-check'],
      changedFiles: ['configuration-check'], options
    });
  }
  gate.args = ['{profile}'];
  gate.profilePath = relative(dirname(resolve(configFile)), builtinProfile);
  gate.profileSha256 = hash(readFileSync(builtinProfile));
}

export function declarativeGate(repo) {
  const gates = (repo.validationGates ?? []).filter(gate => gate.profile === declarativeProfile);
  requireThat(gates.length <= 1, 'Only one bounded declarative batch gate is permitted');
  if (!gates.length) return null;
  const gate = gates[0];
  requireThat(gate.approved === true && gate.profilePath &&
    hash(readFileSync(gate.profilePath)) === gate.profileSha256,
  'The declarative profile must be approved and content-bound', 'blocked-validation');
  return gate;
}

export function declarativeRequest(gate, assignment, job, revision, skillExecution, outputRoot) {
  requireThat(assignment?.capability === 'declarative-e2e-authoring' &&
    assignment.skillInput?.format === 'declarative-e2e-mini-spec-batch-v1' &&
    skillExecution?.capability === assignment.capability &&
    assignment.skillQualification?.baseRevision === job.base_revision,
  'The declarative runner requires a qualified, source-bound authoring assignment', 'blocked-validation');
  const request = {
    format: declarativeProfile, assignmentId: assignment.id,
    evidenceIds: assignment.evidenceIds,
    inputItemIds: assignment.skillInput.items.map(item => item.inputItemId),
    baseRevision: job.base_revision, sourceRevision: revision,
    changedFiles: skillExecution.changedFiles,
    testsAddedOrUpdated: skillExecution.testsAddedOrUpdated,
    options: structuredClone(gate.declarativeE2E),
    ...(outputRoot ? { outputRoot } : {})
  };
  try { native.validateRequest(request); }
  catch (error) { requireThat(false, error.message, 'blocked-validation'); }
  return request;
}

export function skillChangePopulation(skillExecution) {
  return [...new Set([
    ...skillExecution.changedFiles, ...(skillExecution.registration?.changedFiles ?? [])
  ])].sort();
}

export function verifyDeclarativeRegistration(config, repo, assignment, workspace, skillExecution) {
  const receipt = skillExecution?.registration;
  if (!receipt) return [];
  const gate = declarativeGate(repo);
  requireThat(gate && gate.declarativeE2E.registration.approved === true &&
    receipt.format === '1js-declarative-registration-v1' &&
    receipt.assignmentId === assignment.id &&
    receipt.baseRevision === assignment.skillQualification?.baseRevision &&
    receipt.profileSha256 === gate.profileSha256 &&
    receipt.gateId === gate.id &&
    Array.isArray(receipt.changedFiles) &&
    new Set(receipt.changedFiles).size === receipt.changedFiles.length &&
    receipt.changedFiles.every(file => declarativeRegistrationFiles.includes(file)) &&
    Array.isArray(receipt.caseIds) && receipt.caseIds.length > 0 &&
    json(Object.keys(receipt.fileSha256).sort()) === json([...receipt.changedFiles].sort()),
  'Controller registration receipt no longer matches the qualified repository contract',
  'blocked-reconciliation');
  const artifact = relative(config.stateDirectory, receipt.artifactRef);
  requireThat(artifact && !isAbsolute(artifact) && !artifact.startsWith('..'),
    'Registration receipt must be persisted inside the Controller state directory',
    'blocked-reconciliation');
  const { artifactRef, ...body } = receipt;
  requireThat(existsSync(artifactRef) &&
    json(JSON.parse(readFileSync(artifactRef, 'utf8'))) === json(body),
  'Controller registration receipt is missing or changed', 'blocked-reconciliation');
  for (const file of receipt.changedFiles) {
    requireThat(hash(readFileSync(boundedPath(workspace, file))) === receipt.fileSha256[file],
      `Controller-owned registration changed after finalization: ${file}`,
      'blocked-reconciliation');
  }
  return receipt.changedFiles;
}

export function parseDeclarativeOutput(output, prefix) {
  const lines = String(output.stdout ?? '').split(/\r?\n/).filter(line => line.startsWith(prefix));
  requireThat(lines.length === 1, 'Missing or ambiguous native declarative receipt', 'blocked-validation');
  try { return JSON.parse(lines[0].slice(prefix.length)); }
  catch { requireThat(false, 'Malformed native declarative receipt', 'blocked-validation'); }
}
