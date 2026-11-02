import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';
import { Ledger } from '../src/ledger.js';
import { hash } from '../src/common.js';
import { oneJsLiveRequest, runOneJsLiveController } from '../src/agency-1js-live.js';

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = (crc >>> 1) ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function zip(entries) {
  const local = [], central = [];
  let offset = 0;
  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = Buffer.from(name), data = Buffer.from(text), crc = crc32(data);
    const header = Buffer.alloc(30); header.writeUInt32LE(0x04034b50); header.writeUInt16LE(20, 4);
    header.writeUInt32LE(crc, 14); header.writeUInt32LE(data.length, 18); header.writeUInt32LE(data.length, 22);
    header.writeUInt16LE(nameBytes.length, 26); local.push(header, nameBytes, data);
    const record = Buffer.alloc(46); record.writeUInt32LE(0x02014b50); record.writeUInt16LE(20, 4);
    record.writeUInt16LE(20, 6); record.writeUInt32LE(crc, 16); record.writeUInt32LE(data.length, 20);
    record.writeUInt32LE(data.length, 24); record.writeUInt16LE(nameBytes.length, 28); record.writeUInt32LE(offset, 42);
    central.push(record, nameBytes); offset += header.length + nameBytes.length + data.length;
  }
  const centralBytes = Buffer.concat(central), end = Buffer.alloc(22); end.writeUInt32LE(0x06054b50);
  end.writeUInt16LE(Object.keys(entries).length, 8); end.writeUInt16LE(Object.keys(entries).length, 10);
  end.writeUInt32LE(centralBytes.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, centralBytes, end]);
}

test('1JS live controller submits once, resumes, and accepts only bound same-workspace evidence', async t => {
  const root = mkdtempSync(join(tmpdir(), 'pea-1js-live-'));
  t.after(() => {});
  const request = oneJsLiveRequest({ sourceRevision: 'a'.repeat(40), branch: 'user/dingjin/fixture' });
  const artifact = join(root, 'artifact', 'agency-artifacts', 'native-cross-office');
  mkdirSync(join(artifact, 'playwright-output', 'case'), { recursive: true });
  const repo = join(root, 'repo'); mkdirSync(repo);
  execFileSync('git', ['init'], { cwd: repo });
  execFileSync('git', ['config', 'user.name', 'Fixture'], { cwd: repo });
  execFileSync('git', ['config', 'user.email', 'fixture@example.invalid'], { cwd: repo });
  writeFileSync(join(repo, 'base'), 'base'); execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'base'], { cwd: repo });
  const base = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  request.sourceRevision = base;
  const scenarioPath = 'ooui/apps/cross-office-client-e2e/scenarios/bizchat-create-excel-five-by-four/scenario.yaml';
  const catalogPath = 'ooui/apps/cross-office-client-e2e/failure-lifecycle/case-lifecycle-catalog.json';
  mkdirSync(join(repo, 'ooui/apps/cross-office-client-e2e/scenarios/bizchat-create-excel-five-by-four'), { recursive: true });
  mkdirSync(join(repo, 'ooui/apps/cross-office-client-e2e/failure-lifecycle'), { recursive: true });
  writeFileSync(join(repo, scenarioPath), 'scenario'); writeFileSync(join(repo, catalogPath), 'catalog');
  execFileSync('git', ['add', '.'], { cwd: repo });
  execFileSync('git', ['commit', '-m', 'candidate'], { cwd: repo });
  const candidate = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: repo, encoding: 'utf8' }).trim();
  execFileSync('git', ['bundle', 'create', join(artifact, 'candidate.bundle'), 'HEAD', `^${base}`], { cwd: repo });
  const bundleSha256 = hash(readFileSync(join(artifact, 'candidate.bundle')));
  const receipt = { profile: request.profile, base, candidate, bundleSha256,
    skillSha256: '1'.repeat(64), scenarioPath, scenarioSha256: hash(readFileSync(join(repo, scenarioPath))),
    controllerRegistrationPath: catalogPath, controllerRegistrationSha256: hash(readFileSync(join(repo, catalogPath))),
    changedFiles: [catalogPath, scenarioPath] };
  writeFileSync(join(artifact, 'authoring-receipt.json'), JSON.stringify(receipt));
  const fixtureWorkbook = zip({
    'xl/workbook.xml': '<x:workbook xmlns:x="x" xmlns:r="r"><x:sheets><x:sheet name="AgencyLive" sheetId="1" r:id="rId1"/></x:sheets></x:workbook>',
    'xl/_rels/workbook.xml.rels': '<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>',
    'xl/worksheets/sheet1.xml': '<worksheet><tableParts><tablePart r:id="rId1"/></tableParts></worksheet>',
    'xl/worksheets/_rels/sheet1.xml.rels': '<Relationships><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/table" Target="../tables/table1.xml"/></Relationships>',
    'xl/tables/table1.xml': '<x:table xmlns:x="x" id="1" name="AgencyLiveTable" ref="A1:D5"/>'
  });
  writeFileSync(join(artifact, 'playwright-output', 'case', 'generated-workbook.xlsx'), fixtureWorkbook);
  const result = { status: 'passed', profile: request.profile, base, candidate, bundleSha256,
    skillSha256: receipt.skillSha256, scenarioSha256: receipt.scenarioSha256,
    junit: { tests: 1, failures: 0, errors: 0, skipped: 0 },
    workbook: { fileName: 'AgencyLive.xlsx', worksheet: 'AgencyLive', table: 'AgencyLiveTable',
      sha256: hash(fixtureWorkbook), byteLength: fixtureWorkbook.length, rows: 5, columns: 4, headerRows: 1, dataRows: 4 } };
  writeFileSync(join(artifact, 'same-workspace-result.json'), JSON.stringify(result));
  writeFileSync(join(root, 'artifact', 'm365-auth-status.json'), JSON.stringify({ ok: true, stage: 'DONE',
    code: 'OK', attempts: 1, jobId: 'office-fixture', storageStateBytes: 1234 }));
  const observation = { terminal: true, parent: { id: 10, result: 'succeeded' },
    child: { id: 11, result: 'succeeded' }, job: { jobId: 'office-fixture', state: 'Completed', result: 'Success',
      agent: { name: 'wxp-copilot-tester' } }, authentication: { mechanism: 'TRIPS FIC' } };
  const calls = [];
  const transport = async operation => { calls.push(operation); if (operation === 'submit') return { parentRunId: 10 };
    if (operation === 'inspect') return observation; return join(root, 'artifact'); };
  const ledger = new Ledger(join(root, 'ledger'));
  execFileSync('git', ['checkout', base], { cwd: repo });
  const config = { activation: { dispatch: true }, statePolicy: { accessApproved: true },
    stateDirectory: join(root, 'state'), oneJsLive: { productRepositoryPath: repo } };
  const accepted = await runOneJsLiveController(config, ledger, request, {}, { transport });
  assert.equal(accepted.status, 'passed'); assert.equal(accepted.candidate, candidate);
  assert.deepEqual(calls, ['submit', 'inspect', 'download']);
  await assert.rejects(runOneJsLiveController(config, ledger, request, {}, { transport }), /resume/);
  const operation = ledger.db.prepare("SELECT id,detail FROM operations WHERE kind='agency-1js-live'").get();
  const expired = JSON.parse(operation.detail); expired.reservedAt = '2000-01-01T00:00:00.000Z';
  ledger.db.prepare('UPDATE operations SET detail=? WHERE id=?').run(JSON.stringify(expired), operation.id);
  const resumed = await runOneJsLiveController(config, ledger, request, { resume: true }, { transport });
  assert.equal(resumed.status, 'passed');
  assert.equal(calls.filter(value => value === 'submit').length, 1);
  assert.equal(calls.filter(value => value === 'inspect').length, 1);
});

test('1JS live request rejects parallel or fixed-scenario dispatch before submission', async () => {
  const request = oneJsLiveRequest({ sourceRevision: 'a'.repeat(40), branch: 'user/dingjin/fixture' });
  request.payload.templateParameters.maxConcurrentJobs = 2;
  const calls = [];
  await assert.rejects(runOneJsLiveController({ activation: { dispatch: true }, statePolicy: { accessApproved: true } },
    {}, request, {}, { transport: async operation => calls.push(operation) }), /fixed single-job/);
  assert.deepEqual(calls, []);
});
