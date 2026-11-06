import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import ExcelJS from 'exceljs';
import { boundedPath, hash, json, requireThat } from './common.js';
import { completedOperation, operationRow } from './case-generation.js';

const cell = value => value === null || ['string', 'boolean'].includes(typeof value) ||
  typeof value === 'number' && Number.isFinite(value);
export async function materializeCaseFixtures(config, ledger, runId, requests, draft) {
  requireThat(Array.isArray(requests) && requests.length <= 30 &&
    requests.every(item => item && typeof item === 'object'),
  'At most 30 designed fixture requests are allowed');
  const wanted = [...new Set(draft.cases.flatMap(item => item.fixtureIds))].sort();
  requireThat(new Set(requests.map(item => item.id)).size === requests.length &&
    json(requests.map(item => item.id).sort()) === json(wanted),
  'Fixture requests must exactly match the designed cases; no missing or unused files', 'invalid-record');
  const results = [];
  for (const spec of requests) {
    requireThat(spec && /^[A-Za-z0-9][A-Za-z0-9_-]{0,79}$/.test(spec.id) &&
      typeof spec.name === 'string' && /^[A-Za-z0-9][A-Za-z0-9._ -]{0,149}$/.test(spec.name) &&
      !/[. ]$/.test(spec.name) && !/^(?:con|prn|aux|nul|com[0-9]|lpt[0-9])(?:\.|$)/i.test(spec.name) &&
      ['purpose', 'handling'].every(key => typeof spec[key] === 'string' && spec[key].trim()) &&
      ['text', 'json', 'csv', 'xlsx', 'missing'].includes(spec.kind) &&
      Buffer.byteLength(json(spec)) <= 262144,
    'Fixture needs a bounded safe declarative recipe, purpose and handling instructions', 'invalid-record');
    const caseIds = draft.cases.filter(item => item.fixtureIds.includes(spec.id)).map(item => item.id);
    const provenance = `Designed for ${caseIds.join(', ')}; recipe SHA-256 ${hash(json(spec))}`;
    if (spec.kind === 'missing') {
      requireThat(typeof spec.reason === 'string' && spec.reason.trim(), 'Missing original fixture needs an actionable reason');
      results.push({ id: spec.id, name: spec.name, purpose: spec.purpose, handling: spec.handling,
        provenance, version: '1', availability: 'missing', path: null, sha256: null, size: null,
        shareApprovalRef: null, blocker: spec.reason });
      continue;
    }
    requireThat(spec.synthetic === true, 'Generated files must be declared synthetic; never invent an original/customer file', 'blocked-authorization');
    const suffix = { text: '.txt', json: '.json', csv: '.csv', xlsx: '.xlsx' }[spec.kind];
    requireThat(spec.name.toLowerCase().endsWith(suffix), 'Fixture extension must match its declarative builder', 'invalid-record');
    const id = `${runId}:fixture:${spec.id}`, specSha256 = hash(json({ spec, caseIds }));
    if (operationRow(ledger, id)) {
      const receipt = completedOperation(ledger, id, 'case-designed-fixture');
      requireThat(receipt.specSha256 === specSha256 &&
        hash(readFileSync(boundedPath(config.caseGeneration.inputRoot, receipt.fixture.path))) === receipt.fixture.sha256,
      'Generated fixture recipe or bytes changed; preserve the original run', 'blocked-reconciliation');
      results.push(receipt.fixture); continue;
    }
    let bytes;
    if (spec.kind === 'text') {
      requireThat(typeof spec.content === 'string', 'Text fixture requires literal content');
      bytes = Buffer.from(spec.content, 'utf8');
    } else if (spec.kind === 'json') {
      requireThat(spec.content !== undefined, 'JSON fixture requires content');
      bytes = Buffer.from(JSON.stringify(spec.content, null, 2) + '\n');
    } else if (spec.kind === 'csv') {
      requireThat(Array.isArray(spec.rows) && spec.rows.length <= 10000 &&
        spec.rows.every(row => Array.isArray(row) && row.length <= 100 && row.every(value =>
          cell(value) && !(typeof value === 'string' && /^(?:[\u0000-\u001f]|\s*[=+@-])/.test(value)))),
      'CSV fixture needs bounded literal cells without executable spreadsheet prefixes');
      bytes = Buffer.from(spec.rows.map(row => row.map(value => `"${String(value ?? '').replaceAll('"', '""')}"`).join(',')).join('\r\n') + '\r\n');
    } else {
      requireThat(Array.isArray(spec.sheets) && spec.sheets.length > 0 && spec.sheets.length <= 10,
        'Workbook fixture requires one through ten sheets');
      const workbook = new ExcelJS.Workbook();
      workbook.created = workbook.modified = new Date('2000-01-01T00:00:00Z');
      for (const sheet of spec.sheets) {
        requireThat(typeof sheet.name === 'string' && /^[A-Za-z0-9 _-]{1,31}$/.test(sheet.name) &&
          Array.isArray(sheet.rows) && sheet.rows.length <= 10000 &&
          sheet.rows.every(row => Array.isArray(row) && row.length <= 100 && row.every(cell)),
        'Workbook fixture supports bounded literal cells, not formulas, macros or scripts');
        workbook.addWorksheet(sheet.name).addRows(sheet.rows);
      }
      bytes = Buffer.from(await workbook.xlsx.writeBuffer());
      const check = new ExcelJS.Workbook(); await check.xlsx.load(bytes);
      requireThat(check.worksheets.length === spec.sheets.length, 'Generated workbook failed round-trip validation');
    }
    requireThat(bytes.length <= config.caseGeneration.maxFixtureBytes, 'Generated fixture exceeds its byte limit', 'blocked-budget');
    mkdirSync(boundedPath(config.caseGeneration.inputRoot, 'fixtures', { write: true }), { recursive: true });
    const path = `fixtures\\${spec.id}-${specSha256.slice(0, 16)}${suffix}`;
    const target = boundedPath(config.caseGeneration.inputRoot, path, { write: true });
    requireThat(!existsSync(target), 'Unreceipted fixture already exists; reconcile instead of overwriting', 'blocked-reconciliation');
    ledger.operation(id, runId, 'case-designed-fixture', { specSha256 });
    writeFileSync(target, bytes, { flag: 'wx' });
    const fixture = { id: spec.id, name: spec.name, purpose: spec.purpose, handling: spec.handling,
      provenance, version: '1', availability: 'available', path, sha256: hash(bytes), size: bytes.length,
      shareApprovalRef: `${runId}:authorization`, blocker: null };
    ledger.finishOperation(id, 'complete', { specSha256, fixture });
    results.push(fixture);
  }
  return results;
}
