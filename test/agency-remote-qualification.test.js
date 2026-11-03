import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { remoteAgencyQualification } from '../src/agency-remote-qualification.js';

function fixture(overrides = {}) {
  return {
    authoringProviders: { remote: { type: 'agency-remote' } },
    repositories: [{
      id: 'office-agent',
      pr: { provider: 'ado', organization: 'office', project: 'ISS', repositoryId: 'OfficeAgent' },
      skillBindings: [{ authoringProvider: 'remote' }],
      ...overrides
    }]
  };
}
const mode = (report, name) => report.repositories[0].modes.find(item => item.mode === name);

test('remote authoring cannot inherit OA validation-only proof', () => {
  const report = remoteAgencyQualification(fixture());
  const authoring = mode(report, 'remote-authoring-local-validation');
  assert.equal(authoring.configured, true);
  assert.equal(authoring.status, 'not-verified');
  assert.equal(authoring.evidence, null);
  assert.match(authoring.warning, /not yet been E2E verified/);
  const validation = mode(report, 'remote-validation');
  assert.equal(validation.status, 'historical-scoped-proof');
  assert.equal(validation.configurationVerified, false);
  assert.ok(validation.evidence.limitations.some(text => text.includes('did not author or repair')));
  assert.equal(report.acceptanceAuthority, false);
});

test('even configured OA remote validation retains an explicit current-configuration warning', () => {
  const config = fixture({ remoteValidation: { type: 'agency-remote' } });
  const report = remoteAgencyQualification(config);
  const validation = mode(report, 'remote-validation');
  assert.equal(validation.configured, true);
  assert.equal(validation.configurationVerified, false);
  assert.match(validation.warning, /historical scoped proof only/);
  assert.match(validation.warning, /original private evidence/);
  assert.equal(report.warnings.length, 2);
  assert.equal(mode(report, 'remote-authoring-local-validation').configured, false);
  const composition = mode(report, 'remote-authoring-remote-validation');
  assert.equal(composition.configured, true);
  assert.equal(composition.status, 'not-verified');
  const loop = mode(report, 'same-workspace-loop');
  assert.equal(loop.status, 'historical-scoped-proof');
  assert.equal(loop.configured, false);
  assert.equal(loop.configurationVerified, false);
  assert.ok(loop.evidence.limitations.some(text => text.includes('not general test authoring')));
  assert.ok(loop.evidence.limitations.some(text => text.includes('production native-assignment')));
  assert.equal(mode(report, 'hosted-executor').status, 'not-verified');
});

test('matching repository names alone never transfer historical proof', () => {
  for (const patch of [
    { provider: 'github' }, { organization: 'other' }, { project: 'other' }, { repositoryId: 'other' }
  ]) {
    const config = fixture();
    Object.assign(config.repositories[0].pr, patch);
    const report = remoteAgencyQualification(config);
    assert.equal(report.repositories[0].modes.every(item => item.evidence === null), true);
    assert.equal(report.repositories[0].modes.every(item => item.status === 'not-verified'), true);
  }
  const config = fixture();
  config.repositories[0].pr.organization = 'https://dev.azure.com/office/';
  config.repositories[0].pr.repositoryId = '61458d25-9f75-41c3-be29-e63727145257';
  assert.equal(mode(remoteAgencyQualification(config), 'remote-validation').status, 'historical-scoped-proof');
});

test('real-evidence qualification has its own proof and cannot enable production or composed dispatch', () => {
  const report = remoteAgencyQualification(fixture({ remoteValidation: { type: 'agency-remote' } }));
  assert.equal(mode(report, 'same-workspace-loop').status, 'historical-scoped-proof');
  const business = mode(report, 'live-business-e2e');
  assert.equal(business.status, 'historical-scoped-proof');
  assert.notEqual(business.evidence.jobId, mode(report, 'same-workspace-loop').evidence.jobId);
  assert.ok(business.evidence.limitations.some(text => text.includes('not fresh source collection')));
  assert.ok(business.evidence.limitations.some(text => text.includes('First candidate passed')));
  assert.equal(mode(report, 'remote-authoring-remote-validation').status, 'not-verified');
  assert.equal(business.configured, false);
  assert.equal(business.configurationVerified, false);
  assert.equal(business.attempt.result, 'blocked-before-dispatch');
  assert.equal(business.attempt.code, 'blocked-skill');
  assert.equal(business.attempt.controllerAcceptance, false);
  assert.equal(business.attempt.remoteJobsSubmitted, 0);
  assert.equal(business.attempt.validationExecuted, false);
  assert.equal(business.attempt.businessLoopImplemented, false);
  assert.equal(report.acceptanceAuthority, false);
});

test('business preflight observations stay bound to their repository rather than transferring with proofs', () => {
  for (const patch of [
    { id: '1js' },
    { pr: { provider: 'ado', organization: 'other', project: 'ISS', repositoryId: 'OfficeAgent' } }
  ]) {
    const business = mode(remoteAgencyQualification(fixture(patch)), 'live-business-e2e');
    assert.equal(business.attempt, null);
    assert.equal(business.status, 'not-verified');
    assert.equal(business.evidence, null);
  }
});

test('1JS SDX live business proof stays historical, scoped and publication-free', () => {
  const report = remoteAgencyQualification(fixture({
    id: '1js',
    pr: { provider: 'ado', organization: 'office', project: 'Office', repositoryId: '1JS' }
  }));
  const business = mode(report, 'live-business-e2e');
  assert.equal(business.status, 'historical-scoped-proof');
  assert.equal(business.evidence.buildId, 58531234);
  assert.equal(business.evidence.candidate, '97795c027ca58e74e91311fb5b289a47d35b4e45');
  assert.ok(business.evidence.limitations.some(text => text.includes('no product test/card repair')));
  assert.ok(business.evidence.limitations.some(text => text.includes('No product push')));
  assert.equal(business.configured, false);
  assert.equal(business.configurationVerified, false);
  assert.equal(report.acceptanceAuthority, false);
});

test('unknown and Office repositories default to unverified rather than unsupported', () => {
  for (const id of ['another-repository', 'office-src']) {
    const report = remoteAgencyQualification(fixture({ id, remoteValidation: { type: 'agency-remote' } }));
    assert.equal(report.repositories[0].modes.every(item => item.status === 'not-verified'), true);
    assert.equal(report.warnings.length, 2);
  }
});

test('1JS native product validation requires explicit opt-in and exposes scoped proof', () => {
  const config = fixture({
    id: '1js',
    pr: {
      provider: 'ado', organization: 'office', project: 'Office',
      repositoryId: '49b0c9f4-555f-4624-8157-a57e6df513b3'
    },
    nativeProductValidation: { type: 'agency-1js-native' }
  });
  const native = mode(remoteAgencyQualification(config), 'native-product-validation');
  assert.equal(native.configured, true);
  assert.equal(native.status, 'historical-scoped-proof');
  assert.equal(native.configurationVerified, false);
  assert.equal(native.evidence.candidate, '79e1131e6ddacf5dcfafc8c1bbb13ed0b1f16723');
  delete config.repositories[0].nativeProductValidation;
  assert.equal(mode(remoteAgencyQualification(config), 'native-product-validation').configured, false);
});

test('default SDK and Local Agency remain warning-free and config is not mutated', () => {
  for (const type of ['copilot-sdk', 'agency-local']) {
    const config = fixture();
    config.authoringProviders.remote.type = type;
    const before = structuredClone(config);
    assert.deepEqual(remoteAgencyQualification(config).warnings, []);
    assert.deepEqual(config, before);
  }
});

test('hosted flights and legacy selections disclose their own unverified path', () => {
  const config = fixture({ skillBindings: [], flights: { proposerExecutor: 'agency' } });
  assert.match(mode(remoteAgencyQualification(config), 'hosted-executor').warning, /not yet been E2E verified/);
  delete config.repositories[0].flights;
  config.agency = { selections: [{ repoId: 'office-agent', taskId: 'task-one' }] };
  assert.equal(mode(remoteAgencyQualification(config), 'hosted-executor').configured, true);
  config.repositories[0].flights = { proposerExecutor: 'local' };
  assert.deepEqual(remoteAgencyQualification(config).warnings, []);
});

test('doctor exposes remote qualification warnings as JSON without enabling execution', t => {
  const directory = mkdtempSync(join(tmpdir(), 'remote-qualification-doctor-'));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const config = JSON.parse(readFileSync(new URL('../pilot.example.json', import.meta.url)));
  config.stateDirectory = join(directory, 'state');
  config.authoringProviders = { remote: { type: 'agency-remote', executable: process.execPath } };
  const repo = config.repositories.find(item => item.id === 'office-agent');
  repo.pr.organization = 'office';
  repo.pr.project = 'ISS';
  repo.pr.repositoryId = 'OfficeAgent';
  repo.skillBindings[0].authoringProvider = 'remote';
  const configPath = join(directory, 'pilot.local.json');
  writeFileSync(configPath, JSON.stringify(config));
  const child = spawnSync(process.execPath, [
    '--no-warnings', fileURLToPath(new URL('../src/cli.js', import.meta.url)),
    'doctor', '--config', configPath
  ], { cwd: directory, encoding: 'utf8', timeout: 30000 });
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.match(result.remoteAgencyQualification.warnings.join('\n'), /remote-authoring-local-validation.*not yet been E2E verified/);
  const business = result.remoteAgencyQualification.repositories
    .find(item => item.repoId === 'office-agent').modes.find(item => item.mode === 'live-business-e2e');
  assert.equal(business.status, 'historical-scoped-proof');
  assert.equal(business.configurationVerified, false);
  assert.equal(business.attempt.code, 'blocked-skill');
  assert.equal(business.attempt.remoteJobsSubmitted, 0);
  assert.deepEqual(result.activation, { collect: false, review: false, dispatch: false });
  assert.equal(result.liveAccessVerified, false);
});
