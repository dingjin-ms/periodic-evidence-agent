import { readFileSync } from 'node:fs';
import { isAbsolute } from 'node:path';
import { hash, json, requireThat } from './common.js';

export function validationPlan(profile) {
  if (!profile) return null;
  const text = profile.bytes.toString('utf8');
  const match = text.match(/^[^\S\r\n]*[#/;]+\s*PILOT_VALIDATION_PLAN:\s*(\{[^\r\n]+\})\s*$/m);
  if (!match) return null;
  let plan;
  try { plan = JSON.parse(match[1]); } catch { return null; }
  const paths = value => Array.isArray(value) && value.length > 0 &&
    value.every(path => typeof path === 'string' && path && !isAbsolute(path) &&
      !path.includes('..') && !path.includes(':'));
  const authentication = plan?.authentication;
  const officeAuthentication = authentication?.type === 'azure-artifacts-npm' &&
    authentication.provider === 'artifacts-npm-credprovider';
  const repositoryBrokerAuthentication = authentication?.type === 'repository-broker' &&
    authentication.provider === '1js-node-azure-auth';
  const validAuthentication = plan?.version === 2 && authentication === undefined ||
    plan?.version === 3 && (officeAuthentication || repositoryBrokerAuthentication) &&
      /^\d+\.\d+\.\d+$/.test(authentication.providerVersion ?? '') &&
      Array.isArray(authentication.feeds) && authentication.feeds.length > 0 &&
      authentication.feeds.every(feed =>
        /^https:\/\/[^/]+(?:\/[^/]+){0,2}\/_packaging\/[^/]+\/npm\/registry\/$/.test(feed?.registry ?? '') &&
        (feed.scope === null || /^[a-z0-9][a-z0-9-]*$/.test(feed.scope ?? '')));
  if (![2, 3].includes(plan?.version) || !validAuthentication ||
    json(plan.stages) !== json(['dependencies', 'compile', 'policy', 'test']) ||
    !paths(plan.testOnlyPrefixes) || !paths(plan.lockfilePaths) ||
    !paths(plan.buildConfigPaths) || !paths(plan.dependencySnapshotPaths) ||
    !paths(plan.preparedOutputPaths)) return null;
  return plan;
}

// Profile bytes determine the existing runner route; a staged marker must never
// fall through to a cheaper fixed-command interpretation because parsing failed.
export function requestProfileContract(gate) {
  if (!gate.profilePath) {
    requireThat(!gate.profile, 'Named profile is missing its canonical binding', 'blocked-config');
    return { kind: 'command', invocations: 1 };
  }
  requireThat(isAbsolute(gate.profilePath) && /^[a-f0-9]{64}$/.test(gate.profileSha256 ?? ''),
    'Request gate needs an absolute hash-bound profile', 'blocked-config');
  const bytes = readFileSync(gate.profilePath);
  requireThat(hash(bytes) === gate.profileSha256, 'Request validation profile changed', 'blocked-reconciliation');
  const plan = validationPlan({ bytes });
  requireThat(plan || !bytes.toString('utf8').includes('PILOT_VALIDATION_PLAN:'),
    'Invalid staged profile cannot become a fixed command', 'blocked-config');
  requireThat(!gate.profile || gate.profile === '1js-declarative-e2e-v1', 'Unknown request profile', 'blocked-config');
  return { kind: plan ? 'staged' : gate.profile ? 'declarative' : 'profile-command',
    profileSha256: gate.profileSha256,
    stages: plan?.stages ?? null,
    // Cold preparation includes fingerprint/dependencies/compile; reuse can
    // fingerprint again, then policy/test. Authentication has its own call.
    invocations: plan ? (plan.authentication ? 7 : 6) : 1 };
}

export function requestGateMinimumMs(repo, gate) {
  const contract = requestProfileContract(gate);
  if (contract.kind === 'staged') {
    // Reserve native stages, both source checkouts, copying and final restoration.
    // The outer owner still bounds non-command hashing/IO; no native budget changes.
    return (contract.invocations + 4) * gate.timeoutMs;
  }
  return gate.timeoutMs + (repo.provisionTimeoutMs ?? 120000) + (repo.requestExecution.tools?.timeoutMs ?? 0);
}

export function requestProfilePins(repo) {
  return repo.validationGates.flatMap(gate => {
    requestProfileContract(gate);
    return gate.profilePath ? [{ path: gate.profilePath, sha256: gate.profileSha256 }] : [];
  });
}
