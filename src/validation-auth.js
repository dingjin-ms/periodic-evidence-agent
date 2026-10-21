import { json } from './common.js';

const prefix = 'PILOT_VALIDATION_AUTH_PREFLIGHT:';
const evidencePrefix = 'PILOT_VALIDATION_AUTH:';
const installReasons = new Set(['provider-missing', 'provider-version-mismatch']);
const reasons = new Set([...installReasons, 'interactive-sign-in-required',
  'credential-validation-failed']);
const failureReasons = new Map([
  ['PILOT_AUTH_PROVIDER_MISSING', 'provider-missing'],
  ['PILOT_AUTH_PROVIDER_VERSION', 'provider-version-mismatch'],
  ['PILOT_AUTH_FEED_MISSING', 'feed-configuration-invalid'],
  ['PILOT_AUTH_VALIDATION_FAILED', 'credential-validation-failed'],
  ['PILOT_AUTH_INTERACTIVE_REQUIRED', 'interactive-sign-in-required']
]);

export function validationAuthFailure(error, stage) {
  const text = [error?.message, error?.stdout, error?.stderr,
    error?.originalMessage].filter(value => typeof value === 'string').join('\n');
  const marker = [...failureReasons.keys()].find(key =>
    new RegExp(`\\b${key}:`).test(text));
  return {
    stage,
    reason: marker ? failureReasons.get(marker) : error?.killed
      ? 'authentication-timeout' : stage === 'dependencies'
        ? 'dependency-authentication-failed' : 'authentication-execution-failed',
    exitCode: Number.isInteger(error?.code) ? error.code : null,
    tokenRecorded: false
  };
}

export function parseValidationAuthPreflight(output, contract) {
  const line = String(output?.stdout ?? '').split(/\r?\n/)
    .find(value => value.startsWith(prefix));
  if (!line) return null;
  try {
    const value = JSON.parse(line.slice(prefix.length));
    const allowed = value?.state === 'ready'
      ? ['feedCount', 'provider', 'providerVersion', 'state', 'tokenRecorded']
      : ['feedCount', 'installProvider', 'provider', 'providerVersion', 'reason',
        'state', 'tokenRecorded'];
    if (!value || json(Object.keys(value).sort()) !== json(allowed.sort()) ||
      value.provider !== contract.provider ||
      value.providerVersion !== contract.providerVersion ||
      value.feedCount !== contract.feeds.length ||
      value.tokenRecorded !== false) return null;
    if (value.state === 'ready') return value;
    return value.state === 'action-required-auth' &&
      reasons.has(value.reason) &&
      value.installProvider === installReasons.has(value.reason) ? value : null;
  } catch {
    return null;
  }
}

export function parseValidationAuthEvidence(output, contract) {
  const line = String(output?.stdout ?? '').split(/\r?\n/)
    .find(value => value.startsWith(evidencePrefix));
  if (!line) return null;
  try {
    const value = JSON.parse(line.slice(evidencePrefix.length));
    const allowed = ['feedCount', 'provider', 'providerVersion', 'tokenRecorded'];
    return value && json(Object.keys(value).sort()) === json(allowed.sort()) &&
      value.provider === contract.provider &&
      value.providerVersion === contract.providerVersion &&
      value.feedCount === contract.feeds.length &&
      value.tokenRecorded === false ? value : null;
  } catch {
    return null;
  }
}

export function validationAuthAction(gate, repo, preflight, controllerRoot) {
  if (preflight.provider === '1js-node-azure-auth') {
    return {
      state: 'action-required-auth',
      code: 'validation-authentication-required',
      gateId: gate.id,
      repoId: repo.id,
      reason: preflight.reason,
      provider: preflight.provider,
      providerVersion: preflight.providerVersion,
      feedCount: preflight.feedCount,
      requiresUserInteraction: true,
      requiresInstallApproval: false,
      remediation: {
        cwd: `${repo.referenceCheckout}\\midgard`,
        command: 'yarn.cmd',
        args: ['auth']
      },
      retryPolicy: 'retry-original-command-once-after-successful-remediation',
      tokenRequested: false
    };
  }
  const args = [
    'run', 'setup:validation-auth', '--',
    '-Workspace', repo.referenceCheckout
  ];
  if (preflight.installProvider) args.push('-InstallProvider');
  return {
    state: 'action-required-auth',
    code: 'validation-authentication-required',
    gateId: gate.id,
    repoId: repo.id,
    reason: preflight.reason,
    provider: preflight.provider,
    providerVersion: preflight.providerVersion,
    feedCount: preflight.feedCount,
    requiresUserInteraction: true,
    requiresInstallApproval: preflight.installProvider,
    remediation: {
      cwd: controllerRoot,
      command: 'npm',
      args
    },
    retryPolicy: 'retry-original-command-once-after-successful-remediation',
    tokenRequested: false
  };
}
