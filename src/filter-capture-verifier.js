import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const captureVerificationProtocol = 'filter-capture-verification-v1';
const hash = value => createHash('sha256').update(value).digest('hex');
const pretty = value => `${JSON.stringify(value, null, 2)}\n`;
function requireThat(condition, message) {
  if (!condition) throw Object.assign(new Error(message), { code: 'blocked-capture-verification' });
}
function unique(values, key, label) {
  requireThat(Array.isArray(values), `Missing ${label}`);
  const map = new Map(values.map(v => [v[key], v]));
  requireThat(map.size === values.length, `Duplicate ${label}`);
  return map;
}

// Property order and compact serialization are the original archival capture contract.
export function reconstructFilterCapture(record, recipe) {
  if (recipe === 'ado-fields-relations-v1') {
    requireThat(record.source.kind === 'ado', 'ADO capture recipe/source mismatch');
    return Buffer.from(JSON.stringify({ id: Number(record.source.recordId), rev: Number(record.source.revision),
      fields: record.fields, relations: record.links }));
  }
  requireThat(recipe === 'workiq-message-parent-v1' && record.source.kind === 'workiq',
    'Unknown capture recipe or source mismatch');
  return Buffer.from(JSON.stringify({ message: record.fields.message, parentContext: record.fields.parentContext }));
}

function parsePrompt(prompt) {
  const envelope = JSON.parse(prompt);
  requireThat(envelope && Object.keys(envelope).length === 2 &&
    typeof envelope.payload === 'string' && hash(envelope.payload) === envelope.payloadSha256,
    'Inner payload binding mismatch');
  const payload = JSON.parse(envelope.payload);
  requireThat(payload.format === 'filter-batch-input-v1' && hash(pretty(payload.index)) === payload.indexSha256,
    'Invalid FILTER input/index binding');
  return payload;
}

export function requiredFilterCaptureIds(prompt, resultBytes) {
  const payload = parsePrompt(prompt), result = JSON.parse(resultBytes);
  requireThat(payload.format === 'filter-batch-input-v1' && result.format === 'filter-batch-result-v1' &&
    result.status === 'complete' && result.batchId === payload.batchId && result.cohortId === payload.cohortId &&
    result.payloadSha256 === JSON.parse(prompt).payloadSha256 &&
    result.titles?.indexSha256 === payload.indexSha256, 'Result/index membership binding mismatch');
  const entries = unique(payload.index.entries, 'evidenceId', 'index entries');
  const decisions = unique(result.titles.decisions, 'evidenceId', 'title decisions');
  const details = unique(result.details, 'evidenceId', 'detail rows');
  requireThat(entries.size === decisions.size && entries.size === details.size,
    'Capture verification requires complete exact membership');
  const retained = new Set(), exempt = [];
  for (const [id, entry] of entries) {
    const decision = decisions.get(id), detail = details.get(id);
    requireThat(decision && detail && decision.captureSha256 === entry.captureSha256 &&
      detail.captureSha256 === entry.captureSha256 && detail.recordSha256 === entry.recordSha256,
    'Capture verifier member/hash mismatch');
    if (decision.disposition === 'screen-out') {
      requireThat(detail.status === 'excluded-title', 'Excluded title must not attest a full capture read');
      exempt.push(id);
    } else {
      requireThat(['likely-relevant', 'needs-details', 'no-title'].includes(decision.disposition) &&
        detail.status === 'reviewed', 'Retained member lacks complete review');
      retained.add(id);
    }
  }
  const required = new Set(retained);
  for (const group of payload.groups) if (group.memberIds.some(id => retained.has(id)))
    for (const id of group.contextIds) required.add(id);
  return { requiredIds: [...required].sort(), titleExcludedIds: exempt.sort() };
}

export function verifyFilterCaptureInput(input, source) {
  requireThat(input?.format === captureVerificationProtocol && Object.keys(input).length === 3 &&
    typeof input.prompt === 'string',
    'Invalid capture verifier input');
  const binding = input.binding;
  const keys = ['repoId', 'targetRef', 'sourceRevision', 'verifierSha256', 'payloadSha256', 'analysisPayloadSha256'];
  requireThat(binding && Object.keys(binding).length === keys.length && keys.every(k => Object.hasOwn(binding, k)) &&
    typeof binding.repoId === 'string' && binding.repoId.length > 0 &&
    typeof binding.targetRef === 'string' && binding.targetRef.startsWith('refs/heads/') &&
    /^[a-f0-9]{40,64}$/.test(binding.sourceRevision) &&
    /^[a-f0-9]{64}$/.test(binding.verifierSha256) &&
    hash(input.prompt) === binding.payloadSha256, 'Capture verifier payload/source binding mismatch');
  requireThat(source && Object.keys(source).length === 4 &&
    source.initialRevision === binding.sourceRevision && source.finalRevision === binding.sourceRevision &&
    source.initialStatus === '' && source.finalStatus === '', 'Capture verifier requires the unchanged clean bound source');
  requireThat(JSON.parse(input.prompt).payloadSha256 === binding.analysisPayloadSha256, 'Inner hash binding mismatch');
  const payload = parsePrompt(input.prompt);
  const entries = unique(payload.index.entries, 'evidenceId', 'index entries');
  const contextEntries = unique(payload.contextCopies, 'evidenceId', 'context copies');
  const evidence = unique(payload.evidence, 'id', 'evidence records');
  const captures = unique(payload.captures, 'sha256', 'captures');
  const required = new Set([...entries.keys(), ...contextEntries.keys()]);
  requireThat(evidence.size === required.size, 'Unexpected or missing delivered evidence');
  const verified = [];
  for (const id of [...required].sort()) {
    const record = evidence.get(id), entry = entries.get(id) ?? contextEntries.get(id);
    requireThat(record && entry && hash(pretty(record)) === entry.recordSha256 &&
      record.capture.sha256 === entry.captureSha256, 'Required full evidence is missing or changed');
    const capture = captures.get(entry.captureSha256);
    requireThat(capture, 'Required capture missing');
    let content;
    if (capture.representation === 'reconstructed-from-full-evidence') {
      const reconstructionRecord = evidence.get(capture.evidenceId);
      requireThat(reconstructionRecord?.capture.sha256 === capture.sha256, 'Reconstruction evidence binding mismatch');
      content = reconstructFilterCapture(reconstructionRecord, capture.recipe);
      requireThat(Number.isSafeInteger(capture.originalByteLength) && content.length === capture.originalByteLength,
        'Reconstructed capture byte length mismatch');
    } else {
      requireThat((capture.representation === 'inline-base64' || capture.representation === undefined) &&
        typeof capture.contentBase64 === 'string', 'Unknown capture representation');
      content = Buffer.from(capture.contentBase64, 'base64');
      requireThat(content.toString('base64') === capture.contentBase64, 'Invalid capture base64');
    }
    const computedSha256 = hash(content);
    requireThat(computedSha256 === capture.sha256, 'Reconstructed/inline capture SHA256 mismatch');
    verified.push({ evidenceId: id, captureSha256: computedSha256, byteLength: content.length });
  }
  return { format: captureVerificationProtocol, ...binding, cohortId: payload.cohortId, batchId: payload.batchId,
    inputSerialization: 'json-stringify-v1', inputSha256: hash(JSON.stringify(input)),
    source, captures: verified, semanticReadingProven: false };
}

export function runFilterCaptureVerifier(input, checkout) {
  const actualVerifierSha256 = hash(readFileSync(new URL(import.meta.url)));
  requireThat(actualVerifierSha256 === input?.binding?.verifierSha256, 'Executed verifier bytes differ from the pinned verifier');
  const git = args => execFileSync('git', args, { cwd: checkout, encoding: 'utf8',
    timeout: 30000, maxBuffer: 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_OPTIONAL_LOCKS: '0', GIT_TERMINAL_PROMPT: '0' } });
  const initialRevision = git(['rev-parse', 'HEAD']).trim();
  const initialStatus = git(['status', '--porcelain=v1', '--untracked-files=all']);
  const source = { initialRevision, finalRevision: initialRevision, initialStatus, finalStatus: initialStatus };
  const verified = verifyFilterCaptureInput(input, source);
  source.finalRevision = git(['rev-parse', 'HEAD']).trim();
  source.finalStatus = git(['status', '--porcelain=v1', '--untracked-files=all']);
  requireThat(source.finalRevision === initialRevision && source.finalStatus === '',
    'Source changed during capture verification');
  return verified;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    requireThat(process.argv.length === 3, 'Usage: node filter-capture-verifier.js CHECKOUT < input.json');
    const stdin = readFileSync(0, 'utf8'), input = JSON.parse(stdin);
    requireThat(stdin === JSON.stringify(input), 'Verifier stdin must use exact json-stringify-v1 serialization');
    process.stdout.write(pretty(runFilterCaptureVerifier(input, process.argv[2])));
  } catch (error) {
    process.stderr.write(`${JSON.stringify({ state: 'blocked', code: error.code ?? 'blocked-capture-verification',
      message: error.message })}\n`);
    process.exitCode = 1;
  }
}
