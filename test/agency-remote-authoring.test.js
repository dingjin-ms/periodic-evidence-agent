import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  executeAgencyRemoteJob, inspectRemoteJob, parseAgencyJson,
  remoteJobArguments
} from '../src/agency-remote-authoring.js';

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agency-remote-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const operations = new Map();
  return {
    root,
    config: { limits: { workerMinutes: 1 } },
    current: { id: 'assignment-remote', workspace: root },
    repo: {
      pr: {
        provider: 'ado',
        organization: 'office',
        project: 'ISS',
        repositoryId: 'OfficeAgent'
      }
    },
    provider: {
      type: 'agency-remote',
      executable: process.execPath,
      profile: 'qualified-remote',
      model: 'gpt-5.6-sol',
      pollSeconds: 1
    },
    ledger: {
      operation(id, jobId, kind, detail) {
        if (operations.has(id)) throw new Error('Operation already started');
        operations.set(id, { jobId, kind, state: 'started', detail });
      },
      finishOperation(id, state, detail) {
        assert.equal(operations.has(id), true);
        operations.set(id, { ...operations.get(id), state, detail });
      }
    },
    operations
  };
}

test('Agency remote arguments are explicit and do not enable default plugins', () => {
  const provider = {
    profile: 'qualified-remote',
    model: 'gpt-5.6-sol',
    modelReasoningEffort: 'high',
    modelContext: 'long_context',
    plugin: 'qualified-plugin@organization'
  };
  const repo = {
    pr: {
      provider: 'ado',
      organization: 'office',
      project: 'ISS',
      repositoryId: 'OfficeAgent'
    }
  };
  const args = remoteJobArguments(provider, repo,
    'pilot/assignment/agency-base-0', 'bounded prompt');
  assert.deepEqual(args.slice(0, 4), ['--no-aec', 'remote', 'create', 'job']);
  assert.equal(args[args.indexOf('--repo-type') + 1], 'ado');
  assert.equal(args[args.indexOf('--organization') + 1], 'office');
  assert.equal(args[args.indexOf('--branch') + 1],
    'pilot/assignment/agency-base-0');
  assert.equal(args[args.indexOf('--profile') + 1], 'qualified-remote');
  assert.equal(args[args.indexOf('--plugin') + 1],
    'qualified-plugin@organization');
  assert.equal(args.includes('--include-default-plugins'), false);
  assert.equal(args.includes('--adc-snapshot'), false);
});

test('Agency JSON parsing accepts a bounded diagnostic prefix', () => {
  assert.deepEqual(parseAgencyJson('diagnostic\n{"jobId":"remote-job-1"}\n'),
    { jobId: 'remote-job-1' });
  assert.throws(() => parseAgencyJson('diagnostic only'), /malformed JSON/);
});

test('Agency remote inspection requires independent positive terminal classifiers', () => {
  const inspected = inspectRemoteJob({
    state: 'Completed',
    result: 'Success',
    outcome: { code: 'Succeeded' },
    jobOutcomeType: 'Succeeded',
    pullRequest: { sourceRefName: 'refs/heads/agency/result' }
  });
  assert.equal(inspected.terminal, true);
  assert.equal(inspected.sourceBranch, 'refs/heads/agency/result');
});

test('Agency remote inspection accepts the Azure DevOps v2 source branch shape', () => {
  const inspected = inspectRemoteJob({
    state: 'Completed',
    result: 'Success',
    outcome: { code: 'Succeeded' },
    jobOutcomeType: 'Succeeded',
    azDoContext: {
      sourceBranchName: 'refs/heads/pilot-agency-base/assignment/round-0'
    }
  });
  assert.equal(inspected.sourceBranch,
    'refs/heads/pilot-agency-base/assignment/round-0');
});

test('Agency remote job persists one submission and polls the accepted job ID', async t => {
  const f = fixture(t);
  const calls = [];
  const outputs = [
    {
      jobId: 'remote-job-123',
      state: 'Queued'
    },
    {
      state: 'InProgress'
    },
    {
      state: 'Completed',
      result: 'Success',
      outcome: { code: 'Succeeded' },
      jobOutcomeType: 'Succeeded',
      sourceBranch: 'refs/heads/agency/result'
    }
  ];
  const result = await executeAgencyRemoteJob(
    f.config, f.ledger, f.current, f.repo, f.provider,
    {
      round: 0,
      baseRevision: 'a'.repeat(40),
      branch: 'pilot/assignment-remote/agency-base-0',
      resultBranch: 'pilot-agency-result/assignment-remote/round-0',
      prompt: 'bounded prompt'
    },
    {
      sleep: async () => {},
      launch: async (executable, args) => {
        calls.push({ executable, args });
        return { stdout: JSON.stringify(outputs.shift()), stderr: '' };
      }
    });
  assert.equal(result.jobId, 'remote-job-123');
  assert.equal(result.sourceBranch,
    'pilot-agency-result/assignment-remote/round-0');
  assert.equal(result.contextSourceBranch, 'refs/heads/agency/result');
  assert.equal(calls.length, 3);
  assert.deepEqual(calls.slice(1).map(call => call.args),
    [
      ['--no-aec', 'remote', 'get', 'remote-job-123'],
      ['--no-aec', 'remote', 'get', 'remote-job-123']
    ]);
  const operation = f.operations.get(
    'assignment-remote:agency-remote:0');
  assert.equal(operation.state, 'completed');
  assert.equal(operation.detail.jobId, 'remote-job-123');
});

test('ambiguous Agency create remains started and cannot be submitted again', async t => {
  const f = fixture(t);
  const input = {
    round: 0,
    baseRevision: 'a'.repeat(40),
    branch: 'pilot/assignment-remote/agency-base-0',
    resultBranch: 'pilot-agency-result/assignment-remote/round-0',
    prompt: 'bounded prompt'
  };
  await assert.rejects(executeAgencyRemoteJob(
    f.config, f.ledger, f.current, f.repo, f.provider, input, {
      launch: async () => { throw new Error('timeout'); }
    }), /submission is uncertain/);
  assert.equal(f.operations.get(
    'assignment-remote:agency-remote:0').state, 'started');
  await assert.rejects(executeAgencyRemoteJob(
    f.config, f.ledger, f.current, f.repo, f.provider, input, {
      launch: async () => ({ stdout: '{}', stderr: '' })
    }), /already/);
});

test('Agency remote rejects an oversized prompt before reserving submission', async t => {
  const f = fixture(t);
  await assert.rejects(executeAgencyRemoteJob(
    f.config, f.ledger, f.current, f.repo, f.provider,
    {
      round: 0,
      baseRevision: 'a'.repeat(40),
      branch: 'pilot/assignment-remote/agency-base-0',
      resultBranch: 'pilot-agency-result/assignment-remote/round-0',
      prompt: 'x'.repeat(24001)
    }), error => {
    assert.equal(error.code, 'blocked-budget');
    return true;
  });
  assert.equal(f.operations.size, 0);
});

test('accepted Agency job with an unreadable state becomes uncertain without retry', async t => {
  const f = fixture(t);
  let calls = 0;
  await assert.rejects(executeAgencyRemoteJob(
    f.config, f.ledger, f.current, f.repo, f.provider,
    {
      round: 1,
      baseRevision: 'b'.repeat(40),
      branch: 'pilot/assignment-remote/agency-base-1',
      resultBranch: 'pilot-agency-result/assignment-remote/round-1',
      prompt: 'bounded repair prompt'
    },
    {
      sleep: async () => {},
      launch: async () => {
        calls++;
        if (calls === 1)
          return {
            stdout: JSON.stringify({
              jobId: 'remote-job-456',
              state: 'Queued'
            }),
            stderr: ''
          };
        throw new Error('network');
      }
    }), /state is uncertain/);
  assert.equal(calls, 2);
  const operation = f.operations.get(
    'assignment-remote:agency-remote:1');
  assert.equal(operation.state, 'uncertain');
  assert.equal(operation.detail.jobId, 'remote-job-456');
});
