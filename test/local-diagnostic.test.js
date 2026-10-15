import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { hash, json } from '../src/common.js';
import { Ledger } from '../src/ledger.js';
import { instrumentDiagnosticSource, diagnosticProfile, prepareLocalValidationDiagnostic,
  dispatchLocalValidationDiagnostic, reconcileInterruptedLocalDiagnostic } from '../src/local-diagnostic.js';
import { command, materializeDiagnosticSnapshot, prepareValidation, minimalEnvironment } from '../src/workers.js';
import { nativeCommand } from '../src/native-command.js';

test('diagnostic instrumentation preserves await order and emits timestamps without changing behavior', async t => {
  const root = mkdtempSync(join(tmpdir(), 'diagnostic-markers-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const path = join(root, 'fixture.cjs'), trace = join(root, 'trace.jsonl');
  const source = "async function run() {\nawait Promise.resolve();\nconsole.log('unchanged');\n}\nrun();\n";
  const points = [
    { label: 'before-await', position: 'before', needle: 'await Promise.resolve();' },
    { label: 'after-await', position: 'after', needle: 'await Promise.resolve();' }
  ];
  const instrumented = instrumentDiagnosticSource(source, points);
  assert.equal(instrumented.replace(/^require\('node:fs'\).*;\n/gm, ''), source);
  writeFileSync(path, instrumented);
  const output = await command(process.execPath, [path], root, 10000,
    { ...process.env, PILOT_DIAGNOSTIC_TRACE: trace });
  assert.equal(output.stdout.trim(), 'unchanged');
  const events = readFileSync(trace, 'utf8').trim().split('\n').map(JSON.parse);
  assert.deepEqual(events.map(event => event.point), ['before-await', 'after-await']);
  assert.ok(BigInt(events[1].hrtime) >= BigInt(events[0].hrtime));
});

for (const [label, source, points] of [
  ['ambiguous anchor', 'x();x();', [{ needle: 'x();', label: 'x', position: 'before' }]],
  ['missing anchor', 'x();', [{ needle: 'y();', label: 'x', position: 'before' }]],
  ['code in label', 'x();', [{ needle: 'x();', label: "';run()", position: 'before' }]],
  ['repeat instrumentation', 'PILOT_DIAGNOSTIC_TRACE', [{ needle: 'PILOT', label: 'x', position: 'before' }]],
  ['invalid position', 'x();', [{ needle: 'x();', label: 'x', position: 'replace' }]]
]) test(`diagnostic rejects ${label}`, () => {
  assert.throws(() => instrumentDiagnosticSource(source, points));
});

test('diagnostic profile selects one file with a fresh cache and never alters acceptance flags', () => {
  const profile = diagnosticProfile({ path: 'agents/excel-agent/tests/integration/direct/case.test.ts',
    name: 'required case', packageName: '@officeagent-agent/excel-agent' },
  join(tmpdir(), 'case-results.json'), join(tmpdir(), 'fresh-cache'));
  assert.equal((profile.match(/& \$corepack/g) ?? []).length, 1);
  assert.match(profile, /test:integration --runTestsByPath 'tests\/integration\/direct\/case.test.ts'/);
  assert.match(profile, /--cacheDirectory=/);
  assert.doesNotMatch(profile, /testTimeout|passWithNoTests|check:integration|retry|push|publish/);
  assert.throws(() => diagnosticProfile({ path: '../outside.test.ts', name: 'x', packageName: 'x' },
    join(tmpdir(), 'r'), join(tmpdir(), 'c')));
});

test('diagnostic profile delivers auth-hook suppression to the actual command child after filtering',
  { skip: process.platform !== 'win32' }, async t => {
    const root = mkdtempSync(join(tmpdir(), 'diagnostic-child-env-'));
    t.after(() => rmSync(root, { recursive: true, force: true }));
    const child = join(root, 'capture.cjs'), output = join(root, 'child.json');
    writeFileSync(child, `require('node:fs').writeFileSync(${JSON.stringify(output)},JSON.stringify({` +
      `marker:process.env.OAGENT_ADO_ARTIFACTS_AUTHENTICATED,` +
      `token:process.env.PILOT_OA_PACKAGE_TOKEN??null,args:process.argv.slice(2)}));`);
    writeFileSync(join(root, 'corepack.cmd'), `@"${process.execPath}" "${child}" %*\r\n`);
    const profile = join(root, 'diagnostic.ps1');
    writeFileSync(profile, diagnosticProfile({
      packageName: '@fixture/excel-agent', path: 'agents/excel-agent/tests/integration/test.test.ts',
      name: 'synthetic'
    }, join(root, 'results.json'), join(root, 'cache')));
    const env = minimalEnvironment();
    const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
    env[pathKey] = `${root};${env[pathKey] ?? process.env.PATH}`;
    delete env.OAGENT_ADO_ARTIFACTS_AUTHENTICATED;
    await nativeCommand('pwsh', ['-NoProfile', '-NonInteractive', '-File', profile], root, 30000, env);
    const captured = JSON.parse(readFileSync(output));
    assert.equal(captured.marker, '1');
    assert.equal(captured.token, null);
    assert.deepEqual(captured.args.slice(0, 4),
      ['yarn', 'workspace', '@fixture/excel-agent', 'test:integration']);
  });

test('pre-case reconciliation refuses a live owner and preserves its operation', t => {
  const root = mkdtempSync(join(tmpdir(), 'diagnostic-live-owner-'));
  const ledger = new Ledger(root);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const detail = { phase: 'materialization', pid: process.pid,
    tracePath: join(root, 'trace'), resultPath: join(root, 'results') };
  ledger.operation('fixture', 'prior', 'local-validation-diagnostic', detail);
  ledger.finishOperation('fixture', 'running', detail);
  assert.throws(() => reconcileInterruptedLocalDiagnostic(ledger, 'fixture',
    'Synthetic stopped-before-case safety inspection'), /still alive/);
  assert.equal(ledger.status().operations[0].state, 'running');
});

test('pre-case reconciliation seals a dead owner without resetting or retrying it', async t => {
  const root = mkdtempSync(join(tmpdir(), 'diagnostic-dead-owner-'));
  const ledger = new Ledger(root);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  const child = await command(process.execPath, ['-e', 'console.log(process.pid)'], root);
  const detail = { phase: 'materialization', pid: Number(child.stdout.trim()),
    tracePath: join(root, 'trace'), resultPath: join(root, 'results') };
  ledger.operation('fixture', 'prior', 'local-validation-diagnostic', detail);
  ledger.finishOperation('fixture', 'running', detail);
  const before = ledger.status().operations[0];
  const receipt = reconcileInterruptedLocalDiagnostic(ledger, 'fixture',
    'Synthetic pre-case safety interruption; no invocation');
  assert.deepEqual(receipt.originalOperation, before);
  assert.equal(receipt.caseCommandInvocations, 0);
  assert.equal(ledger.status().operations[0].state, 'interrupted');
  await assert.rejects(dispatchLocalValidationDiagnostic({ stateDirectory: root }, ledger, 'fixture'),
    /never-executed/);
  assert.throws(() => reconcileInterruptedLocalDiagnostic(ledger, 'fixture',
    'Synthetic repeat interruption must not reset state'));
});

test('diagnostics cannot use an existing ledger or replay a terminal operation', async t => {
  const root = mkdtempSync(join(tmpdir(), 'diagnostic-guards-'));
  const ledger = new Ledger(root);
  t.after(() => { ledger.close(); rmSync(root, { recursive: true, force: true }); });
  ledger.operation('diagnostic-fixture', 'sealed-predecessor', 'local-validation-diagnostic', {});
  ledger.finishOperation('diagnostic-fixture', 'completed', { acceptanceEvidence: false });
  await assert.rejects(prepareLocalValidationDiagnostic({ stateDirectory: root }, ledger, {}),
    /fresh empty ledger/);
  await assert.rejects(dispatchLocalValidationDiagnostic({ stateDirectory: root }, ledger, 'diagnostic-fixture'),
    /never-executed/);
  assert.equal(ledger.all('workerResult').length, 0);
  assert.equal(ledger.status().jobs.length, 0);
  assert.equal(existsSync(join(root, 'w')), false);
});

async function snapshotFixture(t) {
  const root = mkdtempSync(join(tmpdir(), 'diagnostic-snapshot-'));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const workspace = join(root, 'source');
  mkdirSync(workspace);
  writeFileSync(join(workspace, '.gitignore'), 'deps.txt\nbuilt.txt\n');
  writeFileSync(join(workspace, 'package.json'), '{"name":"fixture"}\n');
  const git = args => command('git', ['-c', 'core.autocrlf=false',
    '-c', 'core.hooksPath=.git/no-hooks', ...args], workspace);
  await git(['init', '--quiet']);
  await git(['add', '.']);
  await git(['-c', 'user.name=Fixture', '-c', 'user.email=fixture@example.invalid',
    'commit', '--quiet', '-m', 'Synthetic snapshot fixture']);
  const revision = (await git(['rev-parse', 'HEAD'])).stdout.trim();
  const profilePath = join(root, 'profile.mjs');
  const plan = { version: 2, stages: ['dependencies', 'compile', 'policy', 'test'],
    testOnlyPrefixes: ['test/'], lockfilePaths: ['package.json'], buildConfigPaths: ['package.json'],
    dependencySnapshotPaths: ['deps.txt'], preparedOutputPaths: ['built.txt'] };
  writeFileSync(profilePath, `// PILOT_VALIDATION_PLAN: ${json(plan)}\n` +
    `import{writeFileSync}from'node:fs';const s=process.env.PILOT_VALIDATION_STAGE;\n` +
    `if(s==='fingerprint')console.log('PILOT_VALIDATION_FINGERPRINT:'+JSON.stringify({node:process.version,corepack:'fixture',yarn:'fixture',platform:process.platform,architecture:process.arch}));\n` +
    `else if(s==='dependencies')writeFileSync('deps.txt','dependency');\n` +
    `else if(s==='compile')writeFileSync('built.txt','compiled');\n` +
    `else throw Error('No case may execute during snapshot provisioning');\n`);
  const gate = { id: 'fixture-native', executable: process.execPath, args: ['{profile}'],
    timeoutMs: 30000, profilePath, profileSha256: hash(readFileSync(profilePath)) };
  const repo = { id: 'fixture', owner: 'fixture', routingApproved: true, baseRef: revision,
    remote: workspace, referenceCheckout: workspace, validationGates: [gate], allowedWritePrefixes: ['test'] };
  const config = { stateDirectory: join(root, 'preparation'), repositories: [repo] };
  const job = { id: 'fixture-job', repo: repo.id, workspace };
  const receipt = (await prepareValidation(config, job, repo, revision))[gate.id];
  assert.equal(receipt.error, undefined);
  return { root, config, job, repo, gate, revision, receipt };
}

test('diagnostic materializes verified native outputs in a fresh copy without changing its source cache', async t => {
  const ctx = await snapshotFixture(t);
  const before = hash(readFileSync(ctx.receipt.receiptPath));
  const workspace = join(ctx.root, 'diagnostic', 'w');
  const result = await materializeDiagnosticSnapshot(ctx.config, ctx.job, ctx.repo, ctx.gate,
    ctx.revision, ctx.receipt.receiptPath, workspace);
  assert.equal(readFileSync(join(workspace, 'built.txt'), 'utf8'), 'compiled');
  assert.equal(result.sourceRevision, ctx.revision);
  assert.equal(hash(readFileSync(ctx.receipt.receiptPath)), before);
  assert.equal(existsSync(join(ctx.job.workspace, 'validation-profiles')), false);
  await assert.rejects(materializeDiagnosticSnapshot(ctx.config, ctx.job, ctx.repo, ctx.gate,
    ctx.revision, ctx.receipt.receiptPath, workspace), /fresh isolated/);
});

test('diagnostic refuses corrupt native outputs without compile/install fallback', async t => {
  const ctx = await snapshotFixture(t);
  writeFileSync(join(ctx.receipt.workspace, 'built.txt'), 'corrupted');
  const workspace = join(ctx.root, 'diagnostic', 'w');
  await assert.rejects(materializeDiagnosticSnapshot(ctx.config, ctx.job, ctx.repo, ctx.gate,
    ctx.revision, ctx.receipt.receiptPath, workspace), /no fallback/);
  assert.equal(existsSync(join(workspace, 'built.txt')), false);
  assert.equal(readFileSync(join(ctx.receipt.workspace, 'built.txt'), 'utf8'), 'corrupted');
});
