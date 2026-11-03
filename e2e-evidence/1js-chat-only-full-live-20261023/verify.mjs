import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const directory = dirname(fileURLToPath(import.meta.url));
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const read = path => JSON.parse(readFileSync(path, 'utf8'));
function child(root, name) {
  assert(typeof name === 'string' && name.length > 0);
  const path = resolve(root, name);
  const rel = relative(root, path);
  assert(rel && !rel.startsWith('..') && !isAbsolute(rel), 'Artifact escapes archive');
  return path;
}
const manifest = read(join(directory, 'run-manifest.json'));
assert.equal(manifest.format, '1js-native-continuation-proof-v1');
assert.equal(manifest.state, 'draft-pr-validated');
const names = manifest.artifacts.map(row => row.name);
assert.equal(new Set(names).size, names.length);
assert.deepEqual(readdirSync(directory).sort(), [...names, 'run-manifest.json', 'SHA256SUMS'].sort());
for (const row of manifest.artifacts)
  assert.equal(digest(readFileSync(child(directory, row.name))), row.sha256, row.name);
const checksumNames = [...names, 'run-manifest.json'].sort();
assert.equal(readFileSync(join(directory, 'SHA256SUMS'), 'utf8'),
  checksumNames.map(name => `${digest(readFileSync(child(directory, name)))}  ${name}\n`).join(''));
const validation = read(join(directory, '04-validation.json'));
assert.equal(validation.sourceRevision, manifest.sourceRevision);
assert.deepEqual(validation.cases.map(row => [row.repeat, row.status, row.retry]),
  [0, 1, 2, 3, 4].map(index => [index, 'passed', 0]));
const publication = read(join(directory, '05-publication.json'));
assert.equal(publication.draftPR.isDraft, true);
assert.equal(publication.draftPR.headRevision, manifest.sourceRevision);
assert.equal(publication.build.actualResult, 'failed');

const args = process.argv.slice(2);
assert(args.length === 0 || (args.length === 2 && args[0] === '--private'),
  'Usage: node verify.mjs [--private <archive-directory>]');
let privateArtifacts = 0;
if (args.length) {
  const root = resolve(args[1]);
  const indexBytes = readFileSync(join(root, 'private-index.json'));
  const inventory = read(join(directory, '08-private-evidence-index.json'));
  assert.equal(digest(indexBytes), inventory.privateIndexSha256);
  const index = JSON.parse(indexBytes);
  assert.equal(index.runId, manifest.runId);
  assert.deepEqual(index.artifacts.map(({ role, sha256, bytes }) => ({ role, sha256, bytes })),
    inventory.artifacts);
  for (const row of index.artifacts) {
    const bytes = readFileSync(child(root, row.archivePath));
    assert.equal(bytes.length, row.bytes, row.role);
    assert.equal(digest(bytes), row.sha256, row.role);
  }
  const get = role => {
    const rows = index.artifacts.filter(row => row.role === role);
    assert.equal(rows.length, 1, role);
    return read(child(root, rows[0].archivePath));
  };
  const result = get('reconciled-worker-result');
  assert.equal(result.outcome, manifest.state);
  assert.equal(result.sourceRevision, manifest.sourceRevision);
  assert.equal(result.id, manifest.reconciledResultId);
  assert.equal(result.draftPR.headRevision, manifest.sourceRevision);
  assert.equal(result.draftPR.url, publication.draftPR.url);
  assert.deepEqual(get('native-summary').cases.map(row =>
    [row.repeatEachIndex, row.status, row.retry, row.durationMs]),
  validation.cases.map(row => [row.repeat, row.status, row.retry, row.durationMs]));
  const artifact = get('validation-artifact');
  assert.equal(artifact.revision, manifest.sourceRevision);
  assert.equal(artifact.status, 'passed');
  const lineage = get('original-collection-snapshot');
  const collection = read(join(directory, '01-collection.json'));
  const evidence = lineage.records.evidence.find(row => row.id === collection.selected.evidenceId);
  assert(evidence, 'Selected evidence missing');
  assert.equal(evidence.capture.sha256, collection.selected.captureSha256);
  const capture = lineage.captures.find(row => row.sha256 === evidence.capture.sha256);
  assert(capture, 'Original capture missing');
  assert.equal(digest(Buffer.from(capture.bodyBase64, 'base64')), evidence.capture.sha256);
  privateArtifacts = index.artifacts.length;
}
console.log(JSON.stringify({ status: 'passed', publicArtifacts: names.length,
  privateArtifacts, sourceRevision: manifest.sourceRevision,
  liveInvocations: 0, remoteWrites: 0 }));
