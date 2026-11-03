import { readFileSync } from 'node:fs';
import { hash, readJson, requireThat, proposerExecutorFlight } from './common.js';

const root = new URL('../e2e-evidence/agency-remote/', import.meta.url);
const modes = ['remote-authoring-local-validation', 'remote-validation',
  'remote-authoring-remote-validation', 'same-workspace-loop', 'live-business-e2e',
  'native-product-validation', 'same-workspace-live-e2e', 'hosted-executor'];

function matchesRepository(repo, record) {
  const actual = repo.pr, expected = record.repository;
  return repo.id === record.repoId && actual?.provider === expected.provider &&
    actual.organization?.replace(/^https:\/\/dev\.azure\.com\//i, '').replace(/\/$/, '')
      .toLowerCase() === expected.organization.toLowerCase() &&
    actual.project?.toLowerCase() === expected.project.toLowerCase() &&
    expected.repositoryIds.some(id => id.toLowerCase() === actual.repositoryId?.toLowerCase());
}

function indexedSummary(entry) {
  requireThat(/^[a-z0-9-]+\.json$/.test(entry.file) && /^[a-f0-9]{64}$/.test(entry.sha256),
    'Remote Agency qualification proof reference is invalid');
  const bytes = readFileSync(new URL(entry.file, root));
  requireThat(hash(bytes) === entry.sha256, 'Remote Agency qualification summary hash mismatch');
  return JSON.parse(bytes);
}

function evidenceFor(record, mode) {
  const entry = record?.qualifications.find(item => item.mode === mode);
  if (!entry) return null;
  const proof = indexedSummary(entry);
  requireThat(proof.schema === 'agency-remote-qualification-proof-v1' &&
    proof.mode === mode && proof.repoId === record.repoId && proof.result === 'passed-scoped' &&
    proof.controllerAcceptance === true && proof.repository.provider === record.repository.provider &&
    proof.repository.organization === record.repository.organization &&
    proof.repository.project === record.repository.project &&
    record.repository.repositoryIds.includes(proof.repository.repositoryId),
  'Remote Agency qualification summary does not match its indexed scope');
  return {
    id: proof.id, summary: `e2e-evidence/agency-remote/${entry.file}`, sha256: entry.sha256,
    candidate: proof.candidate, gateId: proof.gateId, profileSha256: proof.profileSha256,
    controllerCommit: proof.controllerCommit, jobId: proof.jobId, buildId: proof.actualBuildId,
    limitations: proof.limitations
  };
}

function attemptFor(record, mode) {
  const entry = record?.preflights?.find(item => item.mode === mode);
  if (!entry) return null;
  const attempt = indexedSummary(entry);
  requireThat(attempt.schema === 'agency-remote-preflight-attempt-v1' &&
    attempt.mode === mode && attempt.repoId === record.repoId &&
    attempt.repository.provider === record.repository.provider &&
    attempt.repository.organization === record.repository.organization &&
    attempt.repository.project === record.repository.project &&
    record.repository.repositoryIds.includes(attempt.repository.repositoryId) &&
    attempt.result === 'blocked-before-dispatch' &&
    attempt.controllerAcceptance === false && attempt.remoteJobsReserved === 0 &&
    attempt.remoteJobsSubmitted === 0 && attempt.validationExecuted === false &&
    attempt.candidate === null,
  'Remote Agency preflight observation does not match its non-qualifying scope');
  return { ...attempt, summary: `e2e-evidence/agency-remote/${entry.file}`, sha256: entry.sha256 };
}

export function remoteAgencyQualification(config) {
  const registry = readJson(new URL('registry.json', root));
  requireThat(registry.schema === 'agency-remote-qualification-registry-v1' &&
    Array.isArray(registry.repositories),
  'Remote Agency qualification registry is invalid');
  const repositories = config.repositories.map(repo => {
    const record = registry.repositories.find(item => matchesRepository(repo, item));
    const remoteAuthoring = repo.skillBindings?.some(binding =>
      config.authoringProviders?.[binding.authoringProvider]?.type === 'agency-remote') ?? false;
    const remoteValidation = repo.remoteValidation?.type === 'agency-remote';
    const flight = proposerExecutorFlight(repo);
    const hosted = flight === 'agency' || flight === null &&
      (config.agency?.selections ?? []).some(selection => selection.repoId === repo.id);
    return {
      repoId: repo.id,
      modes: modes.map(mode => {
        const configured = mode === 'remote-authoring-local-validation' ? remoteAuthoring && !remoteValidation :
          mode === 'remote-validation' ? remoteValidation :
            mode === 'remote-authoring-remote-validation' ? remoteAuthoring && remoteValidation :
            mode === 'native-product-validation' ? repo.nativeProductValidation?.type === 'agency-1js-native' :
            mode === 'hosted-executor' ? hosted : false;
        const evidence = evidenceFor(record, mode);
        return {
          mode, configured, status: evidence ? 'historical-scoped-proof' : 'not-verified',
          configurationVerified: false, evidence, attempt: attemptFor(record, mode),
          warning: !configured ? null : evidence
            ? `${repo.id}: ${mode} has historical scoped proof only. This repository/configuration has not been reverified by doctor; review the exact source, gates and original private evidence before enablement.`
            : `${repo.id}: ${mode} has not yet been E2E verified in this register. Disclose this before enablement; an authorized bounded qualification probe is not general qualification.`
        };
      })
    };
  });
  return {
    schema: 'agency-remote-qualification-report-v1',
    registry: 'e2e-evidence/agency-remote/registry.json',
    acceptanceAuthority: false,
    repositories,
    warnings: repositories.flatMap(repo => repo.modes.flatMap(mode => mode.warning ? [mode.warning] : []))
  };
}
