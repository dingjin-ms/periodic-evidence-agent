import test from 'node:test';
import assert from 'node:assert/strict';
import {
  existsSync, mkdtempSync, mkdirSync, writeFileSync, rmSync
} from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  parseValidationAuthEvidence, parseValidationAuthPreflight,
  validationAuthAction, validationAuthFailure
} from '../src/validation-auth.js';

const contract = {
  provider: 'artifacts-npm-credprovider',
  providerVersion: '1.2.1',
  feeds: [
    { scope: null, registry: 'https://office.pkgs.visualstudio.com/_packaging/AugmentationLoop/npm/registry/' },
    { scope: 'office', registry: 'https://office.pkgs.visualstudio.com/_packaging/Office/npm/registry/' }
  ]
};
const yarnConfiguration = [
  `npmRegistryServer: "${contract.feeds[0].registry}"`,
  'npmScopes:',
  '  office:',
  `    npmRegistryServer: "${contract.feeds[1].registry}"`
].join('\n');
const repositoryBroker = {
  provider: '1js-node-azure-auth',
  providerVersion: '0.0.1',
  feeds: [{}]
};

test('validation authentication stage accepts both declared providers without token data', () => {
  const output = value => ({
    stdout: `PILOT_VALIDATION_AUTH:${JSON.stringify(value)}\n`
  });
  for (const declared of [contract, repositoryBroker]) {
    const evidence = {
      provider: declared.provider,
      providerVersion: declared.providerVersion,
      feedCount: declared.feeds.length,
      tokenRecorded: false
    };
    assert.deepEqual(parseValidationAuthEvidence(output(evidence), declared),
      evidence);
    assert.equal(parseValidationAuthEvidence(output({
      ...evidence, token: 'synthetic-secret'
    }), declared), null);
    assert.equal(parseValidationAuthEvidence(output({
      ...evidence, provider: 'unexpected-provider'
    }), declared), null);
  }
});

test('validation authentication evidence accepts only the safe schema', () => {
  const output = value => ({
    stdout: `PILOT_VALIDATION_AUTH_PREFLIGHT:${JSON.stringify(value)}\n`
  });
  const ready = {
    state: 'ready',
    provider: contract.provider,
    providerVersion: contract.providerVersion,
    feedCount: 2,
    tokenRecorded: false
  };
  assert.deepEqual(parseValidationAuthPreflight(output(ready), contract), ready);
  assert.equal(parseValidationAuthPreflight(output({
    ...ready, token: 'synthetic-secret'
  }), contract), null);
  assert.equal(parseValidationAuthPreflight(output({
    ...ready, providerVersion: '9.9.9'
  }), contract), null);
});

test('validation authentication action never requests a token', () => {
  const action = validationAuthAction(
    { id: 'gate' },
    { id: 'repo', referenceCheckout: 'C:\\fixture' },
    {
      state: 'action-required-auth',
      reason: 'provider-missing',
      installProvider: true,
      provider: contract.provider,
      providerVersion: contract.providerVersion,
      feedCount: 2,
      tokenRecorded: false
    },
    'C:\\controller');
  assert.equal(action.requiresInstallApproval, true);
  assert.equal(action.tokenRequested, false);
  assert.deepEqual(action.remediation.args, [
    'run', 'setup:validation-auth', '--',
    '-Workspace', 'C:\\fixture', '-InstallProvider'
  ]);
  assert.doesNotMatch(JSON.stringify(action), /secret|credentialValue|accessToken/i);
});

test('authentication failure diagnostics retain only typed reasons and numeric exit codes', () => {
  for (const [marker, reason] of [
    ['PILOT_AUTH_PROVIDER_MISSING', 'provider-missing'],
    ['PILOT_AUTH_PROVIDER_VERSION', 'provider-version-mismatch'],
    ['PILOT_AUTH_FEED_MISSING', 'feed-configuration-invalid'],
    ['PILOT_AUTH_VALIDATION_FAILED', 'credential-validation-failed'],
    ['PILOT_AUTH_INTERACTIVE_REQUIRED', 'interactive-sign-in-required']
  ]) {
    const failure = validationAuthFailure({
      code: 23, stderr: `${marker}: synthetic-secret`, stdout: 'synthetic-secret'
    }, 'authentication');
    assert.deepEqual(failure, {
      stage: 'authentication', reason, exitCode: 23, tokenRecorded: false
    });
    assert.doesNotMatch(JSON.stringify(failure), /synthetic-secret/);
  }
  assert.equal(validationAuthFailure({ killed: true }, 'authentication').reason,
    'authentication-timeout');
  assert.equal(validationAuthFailure({ code: 'synthetic-secret' }, 'dependencies').exitCode, null);
});

test('AL authentication remediation follows the pinned single-feed contract rather than repo name', () => {
  const declared = { ...contract, type: 'azure-artifacts-npm', feeds: [contract.feeds[0]] };
  const preflight = { provider: contract.provider, providerVersion: contract.providerVersion,
    feedCount: 1, reason: 'interactive-sign-in-required', installProvider: false };
  const action = validationAuthAction({ id: 'al-gate' },
    { id: 'any-repository-id', referenceCheckout: 'C:\\isolated-al-auth' },
    preflight, 'C:\\controller', declared);
  assert.deepEqual(action.remediation.args, ['run', 'setup:validation-auth', '--',
    '-Workspace', 'C:\\isolated-al-auth', '-RepositoryProfile', 'AugmentationLoop']);
  assert.equal(action.requiresInstallApproval, false);
  assert.equal(action.tokenRequested, false);
  const install = validationAuthAction({ id: 'al-gate' },
    { id: 'al', referenceCheckout: 'C:\\isolated-al-auth' },
    { ...preflight, installProvider: true, reason: 'provider-missing' }, 'C:\\controller', declared);
  assert.equal(install.requiresInstallApproval, true);
  assert.equal(install.remediation.args.at(-1), '-InstallProvider');
  assert.throws(() => validationAuthAction({ id: 'al-gate' },
    { id: 'augloop-workflows', referenceCheckout: 'C:\\isolated-al-auth' },
    preflight, 'C:\\controller', { ...declared,
      feeds: [{ scope: null, registry: 'https://example.invalid/npm/registry/' }] }),
  /No approved authentication remediation/);
  const oa = validationAuthAction({ id: 'oa-gate' }, { id: 'oa', referenceCheckout: 'C:\\oa' },
    { ...preflight, feedCount: 2 }, 'C:\\controller', { ...contract, type: 'azure-artifacts-npm' });
  assert.deepEqual(oa.remediation.args, ['run', 'setup:validation-auth', '--', '-Workspace', 'C:\\oa']);
});

test('native authentication setup explicitly accepts AL single-feed without weakening OA default', {
  skip: process.platform !== 'win32'
}, t => {
  const root = mkdtempSync(join(tmpdir(), 'al-auth-profile-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, '.yarnrc.yml'),
    `npmRegistryServer: "${contract.feeds[0].registry}"\n`);
  const script = join(process.cwd(), 'scripts', 'validation', 'prepare-office-agent-auth.ps1');
  const systemPath = join(process.env.SystemRoot, 'System32');
  const powershell = join(systemPath, 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const run = extra => spawnSync(powershell, ['-NoProfile', '-ExecutionPolicy', 'Bypass',
    '-File', script, '-Workspace', workspace, '-CheckOnly', ...extra], {
    encoding: 'utf8', env: { ...process.env, PATH: systemPath }
  });
  const oa = run([]);
  assert.notEqual(oa.status, 0);
  assert.match(oa.stderr, /missing expected registry/);
  const al = run(['-RepositoryProfile', 'AugmentationLoop']);
  assert.equal(al.status, 0, al.stderr);
  assert.match(al.stdout, /"feedCount":1/);
  assert.match(al.stdout, /"reason":"provider-missing"/);
  writeFileSync(join(workspace, '.yarnrc.yml'), yarnConfiguration);
  const extraFeed = run(['-RepositoryProfile', 'AugmentationLoop']);
  assert.notEqual(extraFeed.status, 0);
  assert.match(extraFeed.stderr, /exactly its one declared registry/);
  writeFileSync(join(workspace, '.yarnrc.yml'),
    'npmRegistryServer: "https://example.invalid/npm/registry/"\n');
  const wrongFeed = run(['-RepositoryProfile', 'AugmentationLoop']);
  assert.notEqual(wrongFeed.status, 0);
  assert.match(wrongFeed.stderr, /missing expected registry/);
});

test('preflight distinguishes provider mismatch and credential validation failure', () => {
  for (const [reason, installProvider] of [
    ['provider-version-mismatch', true], ['credential-validation-failed', false]
  ]) {
    const value = {
      state: 'action-required-auth', reason, installProvider,
      provider: contract.provider, providerVersion: contract.providerVersion,
      feedCount: 2, tokenRecorded: false
    };
    assert.deepEqual(parseValidationAuthPreflight({
      stdout: `PILOT_VALIDATION_AUTH_PREFLIGHT:${JSON.stringify(value)}`
    }, contract), value);
    assert.equal(validationAuthAction({ id: 'gate' },
      { id: 'repo', referenceCheckout: 'fixture' }, value, 'controller')
      .requiresInstallApproval, installProvider);
  }
});

test('1JS broker authentication is check-only with explicit user remediation', () => {
  const preflight = {
    state: 'action-required-auth',
    reason: 'interactive-sign-in-required',
    installProvider: false,
    provider: repositoryBroker.provider,
    providerVersion: repositoryBroker.providerVersion,
    feedCount: 1,
    tokenRecorded: false
  };
  assert.deepEqual(parseValidationAuthPreflight({
    stdout: `PILOT_VALIDATION_AUTH_PREFLIGHT:${JSON.stringify(preflight)}\n`
  }, repositoryBroker), preflight);
  const action = validationAuthAction(
    { id: 'sdx-excel-focused-integration' },
    { id: '1js', referenceCheckout: 'C:\\src\\1JS' },
    preflight,
    'C:\\controller');
  assert.equal(action.requiresInstallApproval, false);
  assert.equal(action.tokenRequested, false);
  assert.deepEqual(action.remediation, {
    cwd: 'C:\\src\\1JS\\midgard',
    command: 'yarn.cmd',
    args: ['auth']
  });
  assert.doesNotMatch(JSON.stringify(action),
    /--skip-auth|secret|credentialValue|accessToken/i);
});

test('PowerShell authentication check distinguishes provider and sign-in actions', {
  skip: process.platform !== 'win32'
}, t => {
  const root = mkdtempSync(join(tmpdir(), 'validation-auth-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  mkdirSync(workspace);
  writeFileSync(join(workspace, '.yarnrc.yml'), yarnConfiguration);
  const script = join(process.cwd(), 'scripts', 'validation',
    'prepare-office-agent-auth.ps1');
  const powershell = join(process.env.SystemRoot, 'System32',
    'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const run = (path, mode = '') => spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Workspace', workspace, '-CheckOnly'
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: path, PILOT_TEST_AUTH_MODE: mode }
  });
  const systemPath = join(process.env.SystemRoot, 'System32');
  const missing = run(systemPath);
  assert.equal(missing.status, 0, missing.stderr);
  assert.match(missing.stdout, /"reason":"provider-missing"/);

  const bin = join(root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'artifacts-npm-credprovider.cmd'), [
    '@echo off',
    'if "%PILOT_TEST_AUTH_MODE%"=="version" (echo synthetic-secret 1>&2& exit /b 7)',
    'if "%1"=="--version" (echo 1.2.1& exit /b 0)',
    'if "%PILOT_TEST_AUTH_MODE%"=="validation" (echo synthetic-secret 1>&2& exit /b 23)',
    'echo need refresh',
    'exit /b 0'
  ].join('\r\n'));
  const signIn = run(`${bin}${delimiter}${systemPath}`);
  assert.equal(signIn.status, 0, signIn.stderr);
  assert.match(signIn.stdout, /"reason":"interactive-sign-in-required"/);
  assert.doesNotMatch(signIn.stdout + signIn.stderr,
    /accessToken|credentialValue|password|synthetic-secret/i);
  for (const [mode, reason] of [
    ['version', 'provider-version-mismatch'], ['validation', 'credential-validation-failed']
  ]) {
    const failed = run(`${bin}${delimiter}${systemPath}`, mode);
    assert.equal(failed.status, 0, failed.stderr);
    assert.match(failed.stdout, new RegExp(`"reason":"${reason}"`));
    assert.doesNotMatch(failed.stdout + failed.stderr, /synthetic-secret/);
  }

  writeFileSync(join(bin, 'artifacts-npm-credprovider.cmd'), [
    '@echo off',
    'if "%1"=="--version" (echo 1.2.1& exit /b 0)',
    'if "%1"=="--validate-only" (',
    '  if exist "%~dp0authenticated" exit /b 0',
    '  echo need refresh',
    '  exit /b 0',
    ')',
    'type nul > "%~dp0authenticated"',
    'exit /b 0'
  ].join('\r\n'));
  const acquired = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', script,
    '-Workspace', workspace
  ], {
    encoding: 'utf8',
    env: { ...process.env, PATH: `${bin}${delimiter}${systemPath}` }
  });
  assert.equal(acquired.status, 0, acquired.stderr);
  assert.match(acquired.stdout, /authentication is ready/);
  assert.equal(existsSync(join(bin, 'authenticated')), true);
  assert.doesNotMatch(acquired.stdout + acquired.stderr, /need refresh/i);
});

for (const profileName of ['office-agent-onenote-bootstrap-progress.ps1',
  'office-agent-excel-entry-model.ps1']) {
test(`${profileName} authenticates only the declared Yarn configuration`, {
  skip: process.platform !== 'win32'
}, t => {
  const root = mkdtempSync(join(tmpdir(), 'validation-profile-auth-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const bin = join(root, 'bin');
  mkdirSync(workspace);
  mkdirSync(bin);
  writeFileSync(join(workspace, '.yarnrc.yml'), yarnConfiguration);
  writeFileSync(join(workspace, '.npmrc'),
    'registry=https://example.invalid/unrelated/npm/registry/\n');
  writeFileSync(join(bin, 'artifacts-npm-credprovider.cmd'), [
    '@echo off',
    'if "%1"=="--version" (echo 1.2.1& exit /b 0)',
    'if exist ".npmrc" echo need refresh',
    'exit /b 0'
  ].join('\r\n'));
  const profile = join(process.cwd(), 'scripts', 'validation',
    profileName);
  const powershell = join(process.env.SystemRoot, 'System32',
    'WindowsPowerShell', 'v1.0', 'powershell.exe');
  const result = spawnSync(powershell, [
    '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', profile
  ], {
    cwd: workspace,
    encoding: 'utf8',
    env: {
      ...process.env,
      PATH: `${bin}${delimiter}${process.env.PATH}`,
      PILOT_VALIDATION_STAGE: 'authentication-check'
    }
  });
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /"state":"ready"/);
  assert.doesNotMatch(result.stdout + result.stderr,
    /accessToken|credentialValue|password|synthetic-secret/i);
});

test(`${profileName} reports safe noninteractive failure reasons`, {
  skip: process.platform !== 'win32'
}, t => {
  const root = mkdtempSync(join(tmpdir(), 'validation-profile-failure-test-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'workspace');
  const bin = join(root, 'bin');
  mkdirSync(workspace);
  mkdirSync(bin);
  writeFileSync(join(workspace, '.yarnrc.yml'), yarnConfiguration);
  writeFileSync(join(bin, 'artifacts-npm-credprovider.cmd'), [
    '@echo off',
    'if "%PILOT_TEST_AUTH_MODE%"=="version" (echo synthetic-secret 1>&2& exit /b 7)',
    'if "%1"=="--version" (echo 1.2.1& exit /b 0)',
    'if not "%1"=="--validate-only" (type nul > "%~dp0acquired"& exit /b 0)',
    'echo synthetic-secret 1>&2',
    'if "%PILOT_TEST_AUTH_MODE%"=="validation" exit /b 23',
    'echo need refresh',
    'exit /b 0'
  ].join('\r\n'));
  const powershell = join(process.env.SystemRoot, 'System32',
    'WindowsPowerShell', 'v1.0', 'powershell.exe');
  for (const [mode, reason, marker] of [
    ['version', 'provider-version-mismatch', 'PILOT_AUTH_PROVIDER_VERSION'],
    ['validation', 'credential-validation-failed', 'PILOT_AUTH_VALIDATION_FAILED'],
    ['refresh', 'interactive-sign-in-required', 'PILOT_AUTH_INTERACTIVE_REQUIRED']
  ]) for (const stage of ['authentication-check', 'authentication']) {
    const result = spawnSync(powershell, [
      '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File',
      join(process.cwd(), 'scripts', 'validation', profileName)
    ], {
      cwd: workspace, encoding: 'utf8',
      env: { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`,
        PILOT_TEST_AUTH_MODE: mode, PILOT_VALIDATION_STAGE: stage }
    });
    assert.equal(result.status, stage === 'authentication-check' ? 0 : 1,
      `${mode}/${stage}: ${result.stdout}${result.stderr}`);
    assert.match(result.stdout + result.stderr, stage === 'authentication-check'
      ? new RegExp(`"reason":"${reason}"`) : new RegExp(marker));
    assert.doesNotMatch(result.stdout + result.stderr, /synthetic-secret/);
    assert.equal(existsSync(join(bin, 'acquired')), false);
  }
});
}
