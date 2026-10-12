import { spawn } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';
import { hash, json, readJson, requireThat, utc, validateRecord } from './common.js';
import { loadFilterCorpus, validateTitleDecisions } from './filter.js';
import { reconstructFilterCapture } from './filter-capture-verifier.js';

const digest = value => typeof value === 'string' && /^[a-f0-9]{64}$/.test(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const bytes = value => `${JSON.stringify(value, null, 2)}\n`;
const sha = value => hash(bytes(value));
const prompt = input => bytes({ payloadSha256: sha(input), payload: bytes(input) });
const thread = value => value && json([value.teamId, value.channelId, value.rootId]);
const corpusFor = (config, request) => loadFilterCorpus(config,
  { format: 'stage2-sources-v1', sources: request.sources });
function exactKeys(value, keys, label) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).every(k => keys.includes(k)) && keys.every(k => Object.hasOwn(value, k)),
  `Invalid ${label} fields`, 'invalid-record');
}
function immutable(path, value) {
  const content = bytes(value);
  if (existsSync(path)) requireThat(readFileSync(path, 'utf8') === content,
    'Filter batch output conflict; never overwrite a recorded attempt', 'blocked-reconciliation');
  else writeFileSync(path, content, { flag: 'wx', mode: 0o600 });
  return { path: resolve(path), sha256: hash(content) };
}
function budgetFor(config) {
  const b = config.filterBatching;
  requireThat(b?.approved === true && ['verified', 'estimated'].includes(b.mode) &&
    text(b.model) && Object.hasOwn(b, 'profile') && (b.profile === null || text(b.profile)) &&
    text(b.verifiedBy) && text(b.verificationRef) && digest(b.verificationSha256),
  'Explicit model/profile/accounting mode and budget receipt required', 'blocked-config');
  utc(b.verifiedAt);
  requireThat(isAbsolute(b.verificationRef) && hash(readFileSync(b.verificationRef)) === b.verificationSha256,
    'Token budget verification receipt changed', 'blocked-reconciliation');
  for (const key of ['maxPayloadBytes', 'maxBatches'])
    requireThat(Number.isSafeInteger(b[key]) && b[key] > 0, `Unknown/invalid batch ${key}`, 'blocked-config');
  exactKeys(b.reserves, ['instructions', 'sourceAnalysis', 'output', 'safety', 'requestOverhead'], 'token reserves');
  let contextTokens = b.contextTokens, maxInputTokens = b.maxInputTokens, accountingMethod = b.tokenizer;
  if (b.mode === 'estimated') {
    const e = b.estimation;
    requireThat(b.contextTokens === null && b.maxInputTokens === null && b.tokenizer === null &&
      text(e?.methodId) && text(e.version) && text(e.description) &&
      text(e.approval?.decision) && text(e.approval.authority) && e.approval.scope === 'bounded-replay' &&
      e.approval.maxConcurrency === 2 && e.approval.accuracy === 'estimate-not-provider-token-accuracy',
    'Estimated mode requires explicit bounded user approval and unknown provider limits/tokenizer',
    'blocked-config');
    utc(e.approval.receivedAt);
    contextTokens = e.planningContextTokens; maxInputTokens = e.inputTokenCap;
    accountingMethod = e.methodId;
  }
  requireThat(text(accountingMethod), 'Token accounting method missing', 'blocked-config');
  for (const [key, value] of Object.entries({ contextTokens, maxInputTokens }))
    requireThat(Number.isSafeInteger(value) && value > 0, `Unknown/invalid batch ${key}`, 'blocked-config');
  for (const key of ['instructions', 'sourceAnalysis', 'output', 'safety', 'requestOverhead'])
    requireThat(Number.isSafeInteger(b.reserves?.[key]) && b.reserves[key] >= 0,
      `Unknown/invalid ${key} token reserve`, 'blocked-config');
  requireThat(b.reserves.instructions > 0 && b.reserves.sourceAnalysis > 0 && b.reserves.output > 0,
    'Instructions, source analysis and output capacity must be reserved', 'blocked-config');
  const inputLimit = Math.min(maxInputTokens,
    contextTokens - b.reserves.output - b.reserves.safety);
  const payloadLimit = b.mode === 'estimated'
    ? Math.min(maxInputTokens, contextTokens - Object.values(b.reserves).reduce((sum, n) => sum + n, 0))
    : inputLimit - b.reserves.sourceAnalysis - b.reserves.requestOverhead;
  requireThat(payloadLimit > 0 && (b.mode === 'estimated' || payloadLimit > b.reserves.instructions),
    'No evidence capacity remains', 'blocked-budget');
  return { mode: b.mode, model: b.model, profile: b.profile, tokenizer: b.tokenizer, accountingMethod,
    estimation: b.mode === 'estimated' ? b.estimation : null,
    uncertainty: b.mode === 'estimated' ? 'Actual provider input limit and tokenizer unknown; declared estimates only' : null,
    contextTokens: b.contextTokens, maxInputTokens: b.maxInputTokens,
    maxPayloadBytes: b.maxPayloadBytes, maxBatches: b.maxBatches, reserves: b.reserves,
    verifiedBy: b.verifiedBy, verifiedAt: b.verifiedAt,
    verificationSha256: b.verificationSha256, payloadLimit };
}

// The approved local adapter counts exact text. It is not a model or provider launcher.
export async function countFilterTokens(config, input) {
  const command = config.filterBatching?.counter;
  requireThat(command?.approved === true && isAbsolute(command.executable ?? '') &&
    digest(command.executableSha256) && hash(readFileSync(command.executable)) === command.executableSha256 &&
    Array.isArray(command.args) && command.args.every(text) && Array.isArray(command.files) &&
    command.files.length > 0 && Number.isSafeInteger(command.timeoutMs) && command.timeoutMs > 0,
  'Approved pinned local tokenizer command required', 'blocked-config');
  for (const file of command.files)
    requireThat(isAbsolute(file.path ?? '') && digest(file.sha256) &&
      hash(readFileSync(file.path)) === file.sha256, 'Tokenizer file pin changed', 'blocked-reconciliation');
  return new Promise((accept, reject) => {
    const child = spawn(command.executable, command.args, {
      windowsHide: true, shell: false, stdio: ['pipe', 'pipe', 'pipe'],
      env: Object.fromEntries(['PATH', 'Path', 'SystemRoot', 'WINDIR', 'TEMP', 'TMP', 'COMSPEC']
        .filter(k => process.env[k]).map(k => [k, process.env[k]]))
    });
    let output = '', overflow = false, timedOut = false, inputFailed = false;
    const timer = setTimeout(() => { timedOut = true; child.kill(); }, command.timeoutMs);
    child.stdout.on('data', chunk => {
      output += chunk.toString();
      if (Buffer.byteLength(output) > 65536) { overflow = true; child.kill(); }
    });
    child.stderr.resume();
    child.stdin.on('error', () => { inputFailed = true; });
    child.on('error', error => { clearTimeout(timer); reject(error); });
    child.on('close', code => {
      clearTimeout(timer);
      try {
        requireThat(code === 0 && !overflow && !timedOut && !inputFailed,
          'Local tokenizer failed, timed out or exceeded response bounds', 'blocked-tokenizer');
        accept(JSON.parse(output));
      } catch (error) { reject(error); }
    });
    child.stdin.end(JSON.stringify(input));
  });
}
async function counted(config, budget, content, counter) {
  const input = { text: content, sha256: hash(content), model: budget.model, tokenizer: budget.accountingMethod };
  const receipt = await counter(config, input);
  exactKeys(receipt, ['sha256', 'model', 'tokenizer', 'tokens'], 'token count receipt');
  requireThat(receipt.sha256 === input.sha256 && receipt.model === input.model &&
    receipt.tokenizer === input.tokenizer && Number.isSafeInteger(receipt.tokens) && receipt.tokens >= 0,
  'Token count receipt does not match exact payload/model/tokenizer', 'blocked-tokenizer');
  return receipt;
}
function grouped(corpus, request) {
  const records = new Map(corpus.evidence.map(e => [e.id, e]));
  const assigned = new Map(), groupIds = new Set();
  for (const g of request.groups) {
    requireThat(!groupIds.has(g.id) && text(g.reason), 'Duplicate group or missing grouping rationale', 'invalid-record');
    groupIds.add(g.id);
    requireThat(g.memberIds.length > 0, 'Empty context group', 'invalid-record');
    for (const id of g.memberIds) {
      requireThat(records.has(id) && !assigned.has(id), 'Unknown or duplicate group member', 'invalid-record');
      assigned.set(id, g.id);
    }
    requireThat(g.contextIds.every(id => records.has(id) && !g.memberIds.includes(id)),
      'Unknown context copy or context/member overlap', 'invalid-record');
  }
  requireThat(assigned.size === records.size, 'Missing group members; full corpus required', 'invalid-record');
  const together = new Map();
  const byUrl = new Map();
  for (const e of corpus.evidence) {
    const versions = byUrl.get(e.url) ?? [];
    versions.push(e.id); byUrl.set(e.url, versions);
  }
  for (const e of corpus.evidence) {
    const keys = [`source:${json([e.source.kind, e.source.namespace, e.source.recordId])}`];
    if (e.fields?.thread) keys.push(`thread:${thread(e.fields.thread)}`);
    for (const key of keys) {
      requireThat(!together.has(key) || together.get(key) === assigned.get(e.id),
        'Related source versions or thread members cannot be split', 'blocked-context');
      together.set(key, assigned.get(e.id));
    }
    for (const link of e.links ?? []) for (const id of byUrl.get(link.url) ?? [])
      requireThat(assigned.get(e.id) === assigned.get(id),
        'Explicitly related cohort reports cannot be split', 'blocked-context');
  }
  return request.groups.map(g => ({ ...g, memberIds: [...g.memberIds].sort(),
    contextIds: [...g.contextIds].sort() })).sort((a, b) => a.id.localeCompare(b.id));
}
function verifySharing(corpus, request) {
  const approved = new Map();
  for (const entry of request.sharing.materials) {
    requireThat(!approved.has(entry.sha256), 'Duplicate sharing material', 'invalid-record');
    approved.set(entry.sha256, entry);
  }
  const materials = [...corpus.evidence.map(sha), ...corpus.captures.map(c => c.sha256),
    ...corpus.contexts.map(c => c.sha256), hash(request.instructions),
    sha(corpus.coverage.map(({ runId, coverage }) => ({ runId, coverage })))];
  requireThat(text(request.sharing.audience) && text(request.sharing.approvalRef) &&
    materials.every(h => approved.get(h)?.eligibility === 'approved'),
  'Missing/unknown/denied hosted sharing eligibility for complete material', 'blocked-sharing');
}
function member(corpus, id) {
  const record = corpus.evidence.find(e => e.id === id), entry = corpus.index.entries.find(e => e.evidenceId === id);
  return { ...entry, recordSha256: sha(record) };
}
function captureFor(capture, evidence) {
  for (const record of evidence.filter(e => e.capture.sha256 === capture.sha256)) {
    let recipe;
    if (record.source.kind === 'ado') {
      recipe = 'ado-fields-relations-v1';
    } else if (record.source.kind === 'workiq') {
      recipe = 'workiq-message-parent-v1';
    } else continue;
    const content = reconstructFilterCapture(record, recipe);
    if (hash(content) === capture.sha256 &&
      Buffer.from(capture.contentBase64, 'base64').equals(Buffer.from(content)))
      return { sha256: capture.sha256, artifactRef: capture.artifactRef,
        representation: 'reconstructed-from-full-evidence', evidenceId: record.id, recipe,
        originalByteLength: Buffer.byteLength(content) };
  }
  return { ...capture, representation: 'inline-base64' };
}
export function expandFilterSharing(value) {
  if (value.representation !== 'shared-material-policies-v1') return value;
  const policies = new Map(value.policies.map(p => [p.id, p]));
  const expanded = { audience: value.audience, approvalRef: value.approvalRef,
    materials: value.materials.map(m => {
      const policy = policies.get(m.policyId);
      requireThat(policy, 'Unknown shared material policy', 'invalid-record');
      return { sha256: m.sha256, eligibility: policy.eligibility, restrictions: policy.restrictions };
    }) };
  requireThat(sha(expanded) === value.expandedSha256, 'Shared material policy round-trip failed', 'invalid-record');
  return expanded;
}
function factorSharing(value) {
  const policies = [], keys = new Map();
  const materials = value.materials.map(m => {
    const key = json([m.eligibility, m.restrictions]);
    if (!keys.has(key)) {
      const id = `p${policies.length}`; keys.set(key, id);
      policies.push({ id, eligibility: m.eligibility, restrictions: m.restrictions });
    }
    return { sha256: m.sha256, policyId: keys.get(key) };
  });
  const factored = { representation: 'shared-material-policies-v1', expandedSha256: sha(value),
    audience: value.audience, approvalRef: value.approvalRef, policies, materials };
  requireThat(json(expandFilterSharing(factored)) === json(value), 'Sharing factoring changed content', 'invalid-record');
  return factored;
}
export function expandFilterCoverage(value) {
  if (Array.isArray(value)) return value;
  requireThat(value?.representation === 'shared-pass-values-v1', 'Invalid factored coverage', 'invalid-record');
  const shared = new Map(value.shared.map(s => [s.id, s.value]));
  const sources = value.sources.map(s => ({ ...s, coverage: s.coverage.map(p =>
    Object.fromEntries(Object.entries(p).map(([key, v]) => {
      if (v && typeof v === 'object' && !Array.isArray(v) && Object.hasOwn(v, '$coverageValue')) {
        requireThat(Object.keys(v).length === 1 && shared.has(v.$coverageValue),
          'Unknown shared coverage value', 'invalid-record');
        return [key, shared.get(v.$coverageValue)];
      }
      return [key, v];
    }))) }));
  requireThat(sha(sources) === value.expandedSha256, 'Coverage round-trip failed', 'invalid-record');
  return sources;
}
function factorCoverage(sources) {
  const counts = new Map();
  for (const source of sources) for (const pass of source.coverage) for (const v of Object.values(pass)) {
    if (v && typeof v === 'object' && Object.hasOwn(v, '$coverageValue')) return sources;
    const key = json(v);
    if (Buffer.byteLength(key) >= 128) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const shared = [...counts].filter(([, n]) => n > 1).map(([key], i) => ({ id: `v${i}`, value: JSON.parse(key) }));
  if (!shared.length) return sources;
  const ids = new Map(shared.map(s => [json(s.value), s.id]));
  const factored = { representation: 'shared-pass-values-v1', expandedSha256: sha(sources), shared,
    sources: sources.map(s => ({ ...s, coverage: s.coverage.map(p =>
      Object.fromEntries(Object.entries(p).map(([key, v]) =>
        [key, ids.has(json(v)) ? { $coverageValue: ids.get(json(v)) } : v]))) })) };
  requireThat(json(expandFilterCoverage(factored)) === json(sources), 'Coverage factoring changed content', 'invalid-record');
  return Buffer.byteLength(bytes(factored)) < Buffer.byteLength(bytes(sources)) ? factored : sources;
}
function contentFor(corpus, cohortId, groups, instructions, sharing) {
  const memberIds = [...new Set(groups.flatMap(g => g.memberIds))].sort();
  const contextIds = [...new Set(groups.flatMap(g => g.contextIds))].filter(id => !memberIds.includes(id)).sort();
  const ids = new Set([...memberIds, ...contextIds]);
  const evidence = corpus.evidence.filter(e => ids.has(e.id));
  const threads = new Set(evidence.filter(e => e.fields?.thread).map(e => thread(e.fields.thread)));
  const captures = new Set(evidence.map(e => e.capture.sha256));
  const threadContexts = corpus.contexts.filter(c => threads.has(thread(c.content)));
  const sourceCoverage = corpus.coverage.map(({ runId, coverage }) => ({ runId, coverage }));
  const materialHashes = new Set([...evidence.map(sha), ...captures,
    ...threadContexts.map(c => c.sha256), hash(instructions), sha(sourceCoverage)]);
  const index = { format: 'filter-batch-index-v1', cohortId,
    entries: memberIds.map(id => member(corpus, id)),
    policy: corpus.index.policy };
  const batchId = `batch-${hash(json([cohortId, groups, hash(instructions), sha(sharing)]))}`;
  return { format: 'filter-batch-input-v1', stage: 'filter', dispatchAllowed: false,
    cohortId, batchId, instructions, sharing: factorSharing({ ...sharing,
      materials: sharing.materials.filter(m => materialHashes.has(m.sha256)) }),
    groups, index, indexSha256: sha(index),
    contextCopies: contextIds.map(id => member(corpus, id)), evidence,
    captures: corpus.captures.filter(c => captures.has(c.sha256)).map(c => captureFor(c, evidence)),
    threadContexts, sourceCoverage: factorCoverage(sourceCoverage) };
}
export function sizeFilterGroups(config, request, outputPath = null) {
  validateRecord(request, 'filterBatchRequest');
  const corpus = corpusFor(config, request), groups = grouped(corpus, request), corpusSha256 = sha(corpus);
  const cohortId = `cohort-${corpusSha256}`;
  const sizes = groups.map(group => {
    const payload = prompt(contentFor(corpus, cohortId, [group], request.instructions, request.sharing));
    return { groupId: group.id, memberCount: group.memberIds.length, contextCopyCount: group.contextIds.length,
      payloadBytes: Buffer.byteLength(payload), payloadSha256: hash(payload) };
  });
  const result = { format: 'filter-group-sizes-v1', state: 'measured-not-authorized', dispatchAllowed: false,
    cohortId, requestSha256: sha(request), corpusSha256, recordCount: corpus.evidence.length,
    groupCount: groups.length, groups: sizes,
    largestAtomicPayloadBytes: Math.max(0, ...sizes.map(s => s.payloadBytes)),
    allGroupsPayloadBytes: Buffer.byteLength(prompt(contentFor(corpus, cohortId, groups,
      request.instructions, request.sharing))),
    providerTokensVerified: false, sharingEligibilityChecked: false };
  return outputPath ? { ...result, artifact: immutable(outputPath, result) } : result;
}
export async function prepareFilterBatches(config, request, outputPath, counter = countFilterTokens) {
  validateRecord(request, 'filterBatchRequest');
  const budget = budgetFor(config);
  requireThat(text(request.instructions) && text(request.groupingReview.reviewer) &&
    text(request.groupingReview.rationale), 'Instructions and grouping review required', 'invalid-record');
  utc(request.groupingReview.reviewedAt);
  const corpus = corpusFor(config, request), groups = grouped(corpus, request);
  verifySharing(corpus, request);
  const corpusSha256 = sha(corpus), cohortId = `cohort-${corpusSha256}`;
  const instructionReceipt = await counted(config, budget, request.instructions, counter);
  requireThat(budget.mode === 'estimated' || instructionReceipt.tokens <= budget.reserves.instructions,
    'Instructions exceed reserved capacity', 'blocked-budget');
  const batches = [];
  const measure = async groupSet => {
    const content = contentFor(corpus, cohortId, groupSet, request.instructions, request.sharing), payload = prompt(content);
    const tokenReceipt = await counted(config, budget, payload, counter);
    const fits = tokenReceipt.tokens + (budget.mode === 'estimated' ? 0 :
      Math.max(0, budget.reserves.instructions - instructionReceipt.tokens))
      <= budget.payloadLimit && Buffer.byteLength(payload) <= budget.maxPayloadBytes;
    return { id: content.batchId,
      groupIds: groupSet.map(g => g.id), memberIds: content.index.entries.map(e => e.evidenceId),
      contextIds: content.contextCopies.map(e => e.evidenceId), indexSha256: content.indexSha256,
      analysisPayloadSha256: sha(content),
      payloadSha256: hash(payload), payload, tokenReceipt, fits };
  };
  let pending = [], measured;
  for (const group of groups) {
    const next = await measure([...pending, group]);
    if (next.fits) { pending.push(group); measured = next; continue; }
    if (pending.length) { batches.push(measured); pending = []; }
    const single = await measure([group]);
    requireThat(single.fits, `Complete context group ${group.id} exceeds verified budget; no truncation`,
      'blocked-budget');
    pending = [group]; measured = single;
  }
  if (pending.length) batches.push(measured);
  requireThat(batches.length <= budget.maxBatches, 'Batch count exceeds authorized job budget', 'blocked-budget');
  const manifest = { format: 'filter-batch-manifest-v1', stage: 'filter', dispatchAllowed: false,
    request, requestSha256: sha(request), cohortId, corpusSha256, budget, instructionReceipt,
    inventory: corpus.index.entries.map(e => member(corpus, e.evidenceId)),
    batches: batches.map(({ fits, ...batch }) => batch) };
  return { state: 'prepared-not-submitted', ...immutable(outputPath, manifest),
    cohortId, batchCount: batches.length, recordCount: corpus.evidence.length };
}
export function validateFilterManifest(config, manifest) {
  requireThat(manifest?.format === 'filter-batch-manifest-v1' && manifest.dispatchAllowed === false &&
    manifest.stage === 'filter' && Array.isArray(manifest.batches) && Array.isArray(manifest.inventory) &&
    manifest.instructionReceipt && typeof manifest.instructionReceipt === 'object',
  'Invalid batch manifest', 'invalid-record');
  validateRecord(manifest.request, 'filterBatchRequest');
  const budget = budgetFor(config), corpus = corpusFor(config, manifest.request);
  requireThat(sha(manifest.request) === manifest.requestSha256 && sha(corpus) === manifest.corpusSha256 &&
    manifest.cohortId === `cohort-${sha(corpus)}` && json(budget) === json(manifest.budget) &&
    json(manifest.inventory) === json(corpus.index.entries.map(e => member(corpus, e.evidenceId))),
  'Batch request, budget or source snapshot changed', 'blocked-reconciliation');
  verifySharing(corpus, manifest.request);
  const groups = grouped(corpus, manifest.request), seen = new Set();
  requireThat(manifest.batches.length <= budget.maxBatches, 'Batch budget exceeded', 'blocked-budget');
  for (const batch of manifest.batches) {
    requireThat(batch && Array.isArray(batch.groupIds) && text(batch.payload) && batch.tokenReceipt,
      'Invalid batch payload/receipt', 'invalid-record');
    const selected = batch.groupIds.map(id => {
      requireThat(!seen.has(id), 'Duplicate batch group', 'invalid-record'); seen.add(id);
      const group = groups.find(g => g.id === id);
      requireThat(group, 'Unknown batch group', 'invalid-record'); return group;
    });
    requireThat(selected.length > 0, 'Empty batch', 'invalid-record');
    const content = contentFor(corpus, manifest.cohortId, selected, manifest.request.instructions, manifest.request.sharing);
    requireThat(batch.payload === prompt(content) && batch.payloadSha256 === hash(batch.payload) &&
      batch.analysisPayloadSha256 === sha(content) &&
      batch.id === content.batchId &&
      batch.indexSha256 === content.indexSha256 &&
      json(batch.memberIds) === json(content.index.entries.map(e => e.evidenceId)) &&
      json(batch.contextIds) === json(content.contextCopies.map(e => e.evidenceId)),
    'Batch payload/membership identity mismatch', 'blocked-reconciliation');
    const r = batch.tokenReceipt, i = manifest.instructionReceipt;
    requireThat(i.sha256 === hash(manifest.request.instructions) && i.model === budget.model &&
      i.tokenizer === budget.accountingMethod && Number.isSafeInteger(i.tokens) && i.tokens >= 0 &&
      (budget.mode === 'estimated' || i.tokens <= budget.reserves.instructions) &&
      r.sha256 === batch.payloadSha256 && r.model === budget.model && r.tokenizer === budget.accountingMethod &&
      Number.isSafeInteger(r.tokens) && r.tokens >= 0 &&
      r.tokens + (budget.mode === 'estimated' ? 0 : budget.reserves.instructions - i.tokens) <= budget.payloadLimit &&
      Buffer.byteLength(batch.payload) <= budget.maxPayloadBytes,
    'Batch count receipt or token/byte bounds invalid', 'blocked-budget');
  }
  requireThat(seen.size === groups.length, 'Missing batch groups', 'invalid-record');
  return corpus;
}
function checkedResult(manifest, result) {
  validateRecord(result, 'filterBatchResult');
  const batch = manifest.batches.find(b => b.id === result.batchId);
  requireThat(batch && result.cohortId === manifest.cohortId &&
    result.payloadSha256 === batch.analysisPayloadSha256, 'Foreign/stale batch result', 'blocked-reconciliation');
  const content = JSON.parse(JSON.parse(batch.payload).payload);
  const titleIds = new Set(result.titles.decisions.map(d => d.evidenceId));
  validateTitleDecisions(result.status === 'complete' ? content.index :
    { entries: content.index.entries.filter(e => titleIds.has(e.evidenceId)) }, result.titles, batch.indexSha256);
  const seen = new Set(), decisions = new Map(result.titles.decisions.map(d => [d.evidenceId, d]));
  for (const d of result.details) {
    const m = content.index.entries.find(e => e.evidenceId === d.evidenceId);
    requireThat(m && !seen.has(d.evidenceId) && m.recordSha256 === d.recordSha256 &&
      m.captureSha256 === d.captureSha256, 'Duplicate/foreign/stale detail membership', 'invalid-record');
    seen.add(d.evidenceId);
    requireThat(decisions.has(d.evidenceId), 'Detail review has no title decision', 'invalid-record');
    const excluded = decisions.get(d.evidenceId).disposition === 'screen-out';
    requireThat(excluded ? d.status === 'excluded-title' :
      ['reviewed', 'pending', 'blocked'].includes(d.status),
    'Retained record needs explicit detail review', 'invalid-record');
    requireThat(text(d.reason), 'Detail accounting requires rationale', 'invalid-record');
  }
  if (result.status === 'complete')
    requireThat(seen.size === batch.memberIds.length, 'Missing detail accounting', 'invalid-record');
  const candidateIds = new Set();
  for (const candidate of result.candidates) {
    requireThat(!candidateIds.has(candidate.id), 'Duplicate candidate ID', 'invalid-record');
    candidateIds.add(candidate.id);
    requireThat(candidate.evidenceIds.length > 0 && candidate.evidenceIds.every(id =>
      decisions.has(id) && decisions.get(id).disposition !== 'screen-out' &&
      result.details.some(d => d.evidenceId === id && d.status === 'reviewed')),
    'Candidate requires retained reviewed batch members', 'invalid-record');
    requireThat(text(candidate.rationale) && text(candidate.missingAssertion) &&
      text(candidate.harness) && candidate.existingCoverage.every(text),
    'Candidate needs source-bound coverage and ranking rationale', 'invalid-record');
  }
  const unresolved = batch.memberIds.filter(id =>
    !result.details.some(d => d.evidenceId === id && ['reviewed', 'excluded-title'].includes(d.status)));
  requireThat(result.status !== 'complete' || unresolved.length === 0,
    'Complete batch has unresolved detail review', 'invalid-record');
  return { batch, result, unresolved };
}
export function checkFilterBatchResult(config, manifest, result) {
  validateFilterManifest(config, manifest);
  const checked = checkedResult(manifest, result);
  return { state: result.status === 'complete' ? 'checked-not-qualified' : 'partial',
    batchId: checked.batch.id, payloadSha256: checked.batch.analysisPayloadSha256,
    requestPromptSha256: checked.batch.payloadSha256,
    resultSha256: sha(result), validator: 'filter-batch-result-v1',
    unresolvedIds: checked.unresolved,
    semanticAnalysisVerifiedByHelper: false, dispatchAllowed: false };
}
export function consolidateFilterBatches(config, manifest, results, outputPath = null) {
  validateFilterManifest(config, manifest);
  requireThat(Array.isArray(results), 'Results must be an array', 'invalid-record');
  const byBatch = new Map(), duplicates = [], conflicts = [];
  for (const result of [...results].sort((a, b) => json([a.batchId, sha(a)]).localeCompare(json([b.batchId, sha(b)])))) {
    const checked = checkedResult(manifest, result), prior = byBatch.get(result.batchId);
    if (prior) {
      if (sha(prior.result) === sha(result)) duplicates.push({ batchId: result.batchId, resultSha256: sha(result) });
      else conflicts.push({ batchId: result.batchId,
        resultHashes: [sha(prior.result), sha(result)].sort() });
    } else byBatch.set(result.batchId, checked);
  }
  const accounting = manifest.batches.map(batch => {
    const value = byBatch.get(batch.id), conflict = conflicts.some(c => c.batchId === batch.id);
    return { batchId: batch.id, state: conflict ? 'conflict' : value?.result.status ?? 'missing',
      resultSha256: value ? sha(value.result) : null,
      members: batch.memberIds.map(evidenceId => ({ evidenceId,
        status: conflict ? 'conflict' : !value ? 'pending' :
          value.result.status !== 'complete' ? value.result.status :
            value.result.details.find(d => d.evidenceId === evidenceId).status })) };
  });
  const ranked = new Map();
  for (const { result } of byBatch.values()) for (const c of result.candidates) {
    const key = json([c.repository, c.sourceRevision, c.layer, c.missingAssertion]);
    const previous = ranked.get(key);
    const normalized = { ...c }; delete normalized.id; delete normalized.evidenceIds;
    if (previous) {
      if (json(previous.definition) !== json(normalized))
        conflicts.push({ candidateKey: key, batchIds: [...previous.batchIds, result.batchId].sort() });
      previous.evidenceIds = [...new Set([...previous.evidenceIds, ...c.evidenceIds])].sort();
      previous.batchIds = [...new Set([...previous.batchIds, result.batchId])].sort();
      previous.candidateIds = [...new Set([...previous.candidateIds, c.id])].sort();
    } else ranked.set(key, { key, definition: normalized, evidenceIds: [...c.evidenceIds].sort(),
      batchIds: [result.batchId], candidateIds: [c.id] });
  }
  const ranking = [...ranked.values()].sort((a, b) =>
    b.definition.priority - a.definition.priority ||
    b.definition.confidence - a.definition.confidence || a.key.localeCompare(b.key));
  const complete = accounting.every(a => a.state === 'complete') && conflicts.length === 0;
  const selectable = ranking.filter(c => c.definition.coverageStatus === 'gap' &&
    c.definition.blockers.length === 0);
  const result = { format: 'filter-consolidation-v1', state: complete ? 'complete-held' : 'partial',
    dispatchAllowed: false, cohortId: manifest.cohortId, manifestSha256: sha(manifest),
    accounting, duplicates, conflicts, ranking,
    rankingPolicy: 'priority descending, confidence descending, exact repository/source/layer/invariant key ascending',
    selected: complete && selectable.length ? selectable[0] : null,
    semanticAnalysisVerifiedByHelper: false,
    nextGate: 'Exact-source coverage/skill/ownership and executor qualification before any proposer execution' };
  if (outputPath) return { ...result, artifact: immutable(outputPath, result) };
  return result;
}
export function checkFilterBatchFiles(config, manifestPath, resultPath) {
  return checkFilterBatchResult(config, readJson(manifestPath), readJson(resultPath));
}
export function bindFilterConsolidation(config, binding) {
  requireThat(binding && text(binding.manifestPath) && Array.isArray(binding.resultPaths) &&
    binding.resultPaths.every(text), 'Invalid FILTER consolidation binding', 'invalid-record');
  const manifest = readJson(binding.manifestPath);
  const resultFiles = [...new Set(binding.resultPaths.map(p => resolve(p)))].sort();
  const result = consolidateFilterBatches(config, manifest, resultFiles.map(readJson));
  requireThat(result.state === 'complete-held', 'FILTER batches remain unresolved', 'blocked-reconciliation');
  return { manifestPath: resolve(binding.manifestPath), manifestSha256: hash(readFileSync(binding.manifestPath)),
    resultPaths: resultFiles, resultHashes: resultFiles.map(p => hash(readFileSync(p))),
    selected: result.selected, retainedIds: result.selected?.evidenceIds ?? [],
    sources: manifest.request.sources, cohortId: manifest.cohortId };
}
