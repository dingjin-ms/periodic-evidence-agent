import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { Ledger } from '../src/ledger.js';
import { launcherDiagnosticMethod, launcherDiagnosticProfile, verifyLauncherTimeout,
  prepareLauncherDiagnostic, dispatchLauncherDiagnostic } from '../src/local-launcher-diagnostic.js';

const sealed = () => ({
  report: { workerResult: { outcome: 'blocked', draftPR: null, sourceRevision: 'synthetic',
    toolUsage: { used: 0, rounds: [] }, validationAttempts: [{}],
    validation: [{ status: 'blocked', blockedReason: 'runner-timeout', attemptCount: 1 }] },
  nativeTransform: null, publication: { remoteBranchPresent: false, matchingPRsAcrossAllStatuses: 0 },
  processTermination: { activePreTerminalProcesses: [] }, operations: [] },
  artifact: { attempt: 0, status: 'blocked', blockedReason: 'runner-timeout', revision: 'synthetic',
    output: { timeout: true, exitCode: null } }
});

test('launcher diagnostic retains the exact first-leg prefix and excludes the second leg', () => {
  const prefix = "$env:OAGENT_ADO_ARTIFACTS_AUTHENTICATED = '1'\nif ($stage -eq 'test') {\n" +
    "test:integration `\nWrite-Output 'PILOT_CHANGED_CASE:'\n";
  const profile = prefix + "    $scopedPath = Join-Path $PSScriptRoot 'synthetic-native-results.json'\nsecond-leg\n}\n";
  assert.equal(launcherDiagnosticProfile(profile), prefix + '}\n');
  assert.equal(launcherDiagnosticProfile(profile.replaceAll('\n', '\r\n')),
    prefix.replaceAll('\n', '\r\n') + '}\n');
  assert.throws(() => launcherDiagnosticProfile(profile + profile), /boundary/);
  assert.throws(() => launcherDiagnosticProfile(profile.replace('OAGENT_ADO_ARTIFACTS_AUTHENTICATED', 'wrong')), /boundary/);
  assert.equal(launcherDiagnosticMethod.acceptanceEvidence, false);
  assert.equal(launcherDiagnosticMethod.publicationEligible, false);
  assert.equal(launcherDiagnosticMethod.maxModelAttempts, 0);
  assert.equal(launcherDiagnosticMethod.maxCaseInvocations, 1);
  assert.equal(launcherDiagnosticMethod.timeoutMs, 60000);
});

test('only the sealed drained native-only timeout qualifies for launcher diagnosis', () => {
  const { report, artifact } = sealed();
  verifyLauncherTimeout(report, artifact);
  for (const mutate of [
    r => { r.workerResult.toolUsage.used = 1; },
    r => { r.workerResult.toolUsage.rounds = [{}]; },
    r => { r.workerResult.validation[0].status = 'passed'; },
    r => { r.workerResult.validation[0].attemptCount = 2; },
    r => { r.nativeTransform = {}; },
    r => { r.publication.matchingPRsAcrossAllStatuses = 1; },
    r => { r.processTermination.activePreTerminalProcesses = [123]; },
    r => { r.operations = [{ kind: 'commit' }]; }
  ]) {
    const copy = structuredClone(report); mutate(copy);
    assert.throws(() => verifyLauncherTimeout(copy, artifact), /sealed drained/);
  }
  assert.throws(() => verifyLauncherTimeout(report, { ...artifact, revision: 'different' }), /sealed drained/);
});

test('real launcher core refuses unprepared execution and consumed ledgers without invoking native tools', async t => {
  const root = mkdtempSync(join(tmpdir(), 'launcher-guard-')), ledger = new Ledger(root);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const config = { stateDirectory: root };
  await assert.rejects(dispatchLauncherDiagnostic(config, ledger, 'absent'), /never-executed/);
  await assert.rejects(prepareLauncherDiagnostic(config, ledger, {}), /Exact launcher diagnostic input/);
  ledger.operation('prior', 'synthetic', 'local-launcher-diagnostic', {});
  ledger.finishOperation('prior', 'completed', {});
  await assert.rejects(prepareLauncherDiagnostic(config, ledger, {}), /fresh empty ledger/);
  await assert.rejects(dispatchLauncherDiagnostic(config, ledger, 'prior'), /never-executed/);
});
