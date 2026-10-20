import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { configAt, hash, json, now } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import { reconcile } from '../src/coordinator.js';
import {
  executeAgencyRemoteJob, reconcileAgencyRemoteJob
} from '../src/agency-remote-authoring.js';

const assignmentId = 'assignment-remote-recovery';
const jobId = 'remote-job-original';
const operationId = `${assignmentId}:agency-remote:0`;
const input = {
  round: 0, baseRevision: 'a'.repeat(40),
  branch: `pilot-agency-base/${assignmentId}/round-0`,
  resultBranch: `pilot-agency-result/${assignmentId}/round-0`,
  prompt: 'synthetic bounded prompt'
};
const success = {
  jobId, state: 'Completed', result: 'Success',
  outcome: { code: 'Succeeded' }, jobOutcomeType: 'Succeeded'
};

function fixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'agency-remote-recovery-'));
  const config = configAt('pilot.example.json');
  const provider = {
    type: 'agency-remote', executable: process.execPath,
    profile: 'synthetic-remote', pollSeconds: 1
  };
  config.stateDirectory = root;
  config.limits.workerMinutes = 1;
  config.authoringProviders = { remote: provider };
  const ledger = new Ledger(root);
  ledger.db.prepare('INSERT INTO records VALUES(?,?,?,?,?)').run(
    'assignment', assignmentId, 1,
    json({ id: assignmentId, authoringProvider: 'remote' }), now());
  ledger.db.prepare(`INSERT INTO jobs
    (id,investigation_id,version,repo,state,session_id,workspace,updated_at)
    VALUES(?,?,?,?,?,?,?,?)`).run(
    assignmentId, 'investigation-recovery', 1, 'synthetic', 'running',
    'synthetic-session', root, now());
  t.after(() => {
    ledger.close();
    rmSync(root, { recursive: true, force: true });
  });
  return {
    root, config, provider, ledger,
    repo: { pr: { provider: 'ado', organization: 'synthetic',
      project: 'synthetic', repositoryId: 'synthetic' } },
    current: { id: assignmentId, workspace: root }
  };
}
function operation(ledger) {
  const row = ledger.db.prepare('SELECT * FROM operations WHERE id=?').get(operationId);
  return row && { ...row, detail: JSON.parse(row.detail) };
}
function accepted(f, state = 'accepted') {
  const detail = {
    assignmentId, round: 0, jobId, submissionState: 'accepted',
    providerSha256: hash(json(f.provider)),
    timing: { totalMs: 123, pollCount: 1, stateTransitions: [{ state: 'Queued', observedAfterMs: 10 }] }
  };
  f.ledger.operation(operationId, assignmentId, 'agency-remote-authoring', detail);
  f.ledger.finishOperation(operationId, state, detail);
  return detail;
}

test('restart after durable acceptance queries the original job and never creates or redispatches', async t => {
  const f = fixture(t);
  const configPath = join(f.root, 'synthetic-config.json');
  writeFileSync(configPath, json(f.config));
  const script = `
    import { readFileSync } from 'node:fs';
    import { Ledger } from ${json(new URL('../src/ledger.js', import.meta.url).href)};
    import { executeAgencyRemoteJob } from ${json(new URL('../src/agency-remote-authoring.js', import.meta.url).href)};
    const config = JSON.parse(readFileSync(process.argv[1], 'utf8'));
    const ledger = new Ledger(config.stateDirectory);
    ledger.acquire(${json(`dispatch:${assignmentId}`)});
    await executeAgencyRemoteJob(config, ledger, ${json(f.current)}, ${json(f.repo)},
      config.authoringProviders.remote, ${json(input)}, {
        launch: async () => ({ stdout: JSON.stringify({ jobId: ${json(jobId)}, state: 'Queued' }) }),
        sleep: async () => {
          process.stdout.write('accepted\\n');
          await new Promise(() => setInterval(() => {}, 1000));
        }
      });
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', script, configPath], {
    stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true
  });
  t.after(() => { if (child.exitCode === null && child.signalCode === null) child.kill(); });
  const closed = once(child, 'exit');
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(() => reject(new Error('Synthetic child did not persist acceptance')), 15000);
    child.once('error', error => { clearTimeout(timeout); reject(error); });
    child.once('exit', () => { clearTimeout(timeout); reject(new Error('Synthetic child exited before acceptance')); });
    child.stdout.on('data', chunk => {
      if (chunk.toString().includes('accepted')) { clearTimeout(timeout); resolve(); }
    });
  });
  const before = operation(f.ledger);
  assert.equal(before.state, 'accepted');
  assert.equal(before.detail.jobId, jobId);
  child.kill();
  await closed;
  const reopened = new Ledger(f.root);
  try {
    const calls = [];
    const launch = async (_executable, args) => {
      calls.push(args);
      return { stdout: json(success) };
    };
    await assert.rejects(reconcileAgencyRemoteJob(
      f.config, reopened, assignmentId, 0, { launch }), error => error.code === 'overlap');
    assert.equal(calls.length, 0);
    const lock = reopened.status().locks.find(lock => lock.name === `dispatch:${assignmentId}`);
    assert.equal(lock.pid, child.pid);
    reopened.recoverLock(lock.name, lock.owner);
    const result = await reconcileAgencyRemoteJob(
      f.config, reopened, assignmentId, 0, { launch });
    assert.deepEqual(calls, [['--no-aec', 'remote', 'get', jobId]]);
    assert.equal(result.state, 'completed');
    assert.equal(result.recoveryOnly, true);
    assert.equal(reopened.job(assignmentId).state, 'running');
    assert.deepEqual(operation(reopened).detail.timing, before.detail.timing);
    assert.equal(operation(reopened).detail.reconciliationTiming.attemptCount, 1);
    await assert.rejects(executeAgencyRemoteJob(
      f.config, reopened, f.current, f.repo, f.provider, input, {
        launch: async () => assert.fail('A recorded operation must never create twice')
      }), /already started/);
  } finally { reopened.close(); }
});

test('reconcile surfaces accepted and uncertain Remote operations without changing other operation handling', t => {
  const f = fixture(t);
  accepted(f);
  assert.equal(reconcile(f.ledger).operations.find(row => row.id === operationId).state, 'accepted');
  f.ledger.finishOperation(operationId, 'uncertain', operation(f.ledger).detail);
  assert.equal(reconcile(f.ledger).operations.find(row => row.id === operationId).state, 'uncertain');
  f.ledger.operation('other-operation', assignmentId, 'push', {});
  f.ledger.finishOperation('other-operation', 'completed', {});
  assert.equal(reconcile(f.ledger).operations.some(row => row.id === 'other-operation'), false);
});

for (const failure of ['network', 'malformed', 'wrong-job']) {
  test(`recovery ${failure} failure retains identity, original timing and safe repeat-query state`, async t => {
    const f = fixture(t);
    const before = accepted(f, 'uncertain');
    let elapsed = 0;
    await assert.rejects(reconcileAgencyRemoteJob(f.config, f.ledger, assignmentId, 0, {
      monotonicNow: () => elapsed,
      launch: async (_executable, args) => {
        assert.deepEqual(args, ['--no-aec', 'remote', 'get', jobId]);
        elapsed += 25;
        if (failure === 'network') throw new Error('Authorization: Bearer synthetic-secret');
        return { stdout: failure === 'malformed' ? 'synthetic-secret-not-json' :
          json({ ...success, jobId: 'different-job-id' }) };
      }
    }), /remains uncertain/);
    const after = operation(f.ledger);
    assert.equal(after.state, 'uncertain');
    assert.equal(after.detail.jobId, jobId);
    assert.deepEqual(after.detail.timing, before.timing);
    assert.equal(after.detail.reconciliationTiming.inspectionMs, 25);
    assert.doesNotMatch(json(after), /synthetic-secret|Authorization/);
    const result = await reconcileAgencyRemoteJob(f.config, f.ledger, assignmentId, 0, {
      launch: async () => ({ stdout: json({ ...success, jobOutcomeType: 'Failed' }) })
    });
    assert.equal(result.state, 'failed');
    assert.equal(result.succeeded, false);
    assert.equal(operation(f.ledger).detail.reconciliationTiming.attemptCount, 2);
    assert.equal(f.ledger.job(assignmentId).state, 'running');
  });
}

test('unknown submission identity fails closed and does not treat a reserved operation as unsubmitted', async t => {
  const f = fixture(t);
  f.ledger.operation(operationId, assignmentId, 'agency-remote-authoring',
    { submissionState: 'reserved', timing: { totalMs: 0 } });
  await assert.rejects(reconcileAgencyRemoteJob(f.config, f.ledger, assignmentId, 0, {
    launch: async () => assert.fail('Unknown acceptance cannot authorize create or get')
  }), /not proof of non-submission/);
  assert.equal(operation(f.ledger).state, 'started');
});

for (const failingState of ['accepted', 'uncertain']) {
  test(`persistence failure at ${failingState} reports the known ID and forbids replacement submission`, async t => {
    const f = fixture(t);
    const finish = f.ledger.finishOperation.bind(f.ledger);
    f.ledger.finishOperation = (id, state, detail) => {
      if (state === failingState) throw new Error('storage synthetic-secret');
      return finish(id, state, detail);
    };
    let calls = 0;
    await assert.rejects(executeAgencyRemoteJob(
      f.config, f.ledger, f.current, f.repo, f.provider, input, {
        sleep: async () => {},
        launch: async () => {
          calls++;
          if (calls === 1) return { stdout: json({ jobId, state: 'Queued' }) };
          throw new Error('transport synthetic-secret');
        }
      }), error => {
        assert.equal(error.code, 'blocked-reconciliation');
        assert.match(error.message, /recovery\/timing evidence could not be persisted/);
        assert.match(error.message, new RegExp(jobId));
        assert.doesNotMatch(error.message, /synthetic-secret/);
        return true;
      });
    assert.equal(calls, failingState === 'accepted' ? 1 : 2);
    f.ledger.finishOperation = finish;
    const saved = operation(f.ledger);
    assert.equal(saved.state, failingState === 'accepted' ? 'started' : 'accepted');
    if (failingState === 'uncertain') assert.equal(saved.detail.jobId, jobId);
    await assert.rejects(executeAgencyRemoteJob(
      f.config, f.ledger, f.current, f.repo, f.provider, input, {
        launch: async () => assert.fail('Persistence failure must not authorize another create')
      }), /already started/);
  });
}

test('recovery storage failure leaves the existing receipt intact and reports failure instead of success', async t => {
  const f = fixture(t);
  const before = accepted(f, 'uncertain');
  f.ledger.finishOperation = () => { throw new Error('storage synthetic-secret'); };
  await assert.rejects(reconcileAgencyRemoteJob(f.config, f.ledger, assignmentId, 0, {
    launch: async () => ({ stdout: json(success) })
  }), error => {
    assert.match(error.message, new RegExp(jobId));
    assert.match(error.message, /could not be persisted/);
    assert.doesNotMatch(error.message, /synthetic-secret/);
    return true;
  });
  assert.deepEqual(operation(f.ledger).detail, before);
  assert.equal(f.ledger.status().locks.length, 0);
});

test('provider drift is rejected before querying and unknown diagnostic labels cannot leak into timing', async t => {
  const f = fixture(t);
  accepted(f);
  f.config.authoringProviders.remote = { ...f.provider, profile: 'different-profile' };
  await assert.rejects(reconcileAgencyRemoteJob(f.config, f.ledger, assignmentId, 0, {
    launch: async () => assert.fail('Provider drift must fail before launch')
  }), /original pinned provider/);
  f.config.authoringProviders.remote = f.provider;
  await reconcileAgencyRemoteJob(f.config, f.ledger, assignmentId, 0, {
    launch: async () => ({ stdout: json({ state: 'Authorization: Bearer synthetic-secret' }) })
  });
  assert.equal(operation(f.ledger).detail.lastState, 'Unrecognized');
  assert.doesNotMatch(json(operation(f.ledger)), /Authorization|synthetic-secret/);
});

test('normal authoring timing redacts unexpected state text without changing success criteria', async t => {
  const f = fixture(t);
  let calls = 0;
  const result = await executeAgencyRemoteJob(
    f.config, f.ledger, f.current, f.repo, f.provider, input, {
      sleep: async () => {},
      launch: async () => ({
        stdout: json(++calls === 1
          ? { jobId, state: 'Authorization: Bearer synthetic-secret' }
          : success)
      })
    });
  assert.equal(result.state, 'Completed');
  assert.equal(operation(f.ledger).detail.timing.stateTransitions[0].state, 'Unrecognized');
  assert.doesNotMatch(json(operation(f.ledger)), /Authorization|synthetic-secret/);
});

test('observation recovery cannot reopen or overwrite a terminal operation', async t => {
  const f = fixture(t);
  accepted(f, 'completed');
  const before = operation(f.ledger);
  await assert.rejects(reconcileAgencyRemoteJob(f.config, f.ledger, assignmentId, 0, {
    launch: async () => assert.fail('A terminal receipt must not be reopened')
  }), /already terminal/);
  assert.deepEqual(operation(f.ledger), before);
});

test('CLI recovery queries a persisted operation without requiring dispatch activation', t => {
  const f = fixture(t);
  accepted(f);
  const configPath = join(f.root, 'synthetic-cli.local.json');
  writeFileSync(configPath, json(f.config));
  // Node rejects Agency flags: exercise the CLI's failed inspection without any external transport.
  const result = spawnSync(process.execPath, [
    'src\\cli.js', 'reconcile-remote-authoring', '--assignment', assignmentId,
    '--round', '0', '--config', configPath
  ], { encoding: 'utf8', timeout: 30000, windowsHide: true });
  assert.equal(result.status, 1);
  assert.match(result.stderr, /remains uncertain/);
  assert.doesNotMatch(result.stderr, /bad option|--no-aec/);
  assert.equal(operation(f.ledger).state, 'uncertain');
  assert.equal(operation(f.ledger).detail.jobId, jobId);
  assert.equal(operation(f.ledger).detail.reconciliationTiming.attemptCount, 1);
});
