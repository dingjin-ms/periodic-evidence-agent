import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { requireThat, utc } from './common.js';

const exec = promisify(execFile);
const markerPrefix = '<!-- periodic-evidence-agent:pr-review-receipt:';
const markerPattern = /<!-- periodic-evidence-agent:pr-review-receipt:([A-Za-z0-9_-]+) -->/;
const shaPattern = /^[a-f0-9]{40,64}$/;
const outcomes = new Set(['no-blocking-findings', 'blocking-findings']);
const severities = new Set(['blocking', 'non-blocking']);
const validationStates = new Set(['passed', 'failed', 'not-run']);

function text(value, name, max = 500) {
  requireThat(typeof value === 'string' && value.trim() && value.length <= max,
    `${name} must be a nonempty string of at most ${max} characters`, 'invalid-review-receipt');
  return value.trim();
}

function list(value, name, normalize) {
  requireThat(Array.isArray(value), `${name} must be an array`, 'invalid-review-receipt');
  return value.map((item, index) => normalize(item, `${name}[${index}]`));
}

export function normalizeReviewReceipt(value) {
  requireThat(value && typeof value === 'object' && !Array.isArray(value),
    'Review receipt must be an object', 'invalid-review-receipt');
  requireThat(value.schemaVersion === 1, 'Review receipt schemaVersion must be 1', 'invalid-review-receipt');
  const reviewedHead = text(value.reviewedHead, 'reviewedHead', 64).toLowerCase();
  const reviewedBase = text(value.reviewedBase, 'reviewedBase', 64).toLowerCase();
  requireThat(shaPattern.test(reviewedHead) && shaPattern.test(reviewedBase),
    'reviewedHead and reviewedBase must be full Git commit SHAs', 'invalid-review-receipt');
  const outcome = text(value.outcome, 'outcome', 40);
  requireThat(outcomes.has(outcome), 'Unsupported review outcome', 'invalid-review-receipt');
  const findings = list(value.findings, 'findings', (finding, name) => {
    requireThat(finding && typeof finding === 'object', `${name} must be an object`, 'invalid-review-receipt');
    const severity = text(finding.severity, `${name}.severity`, 20);
    requireThat(severities.has(severity), `${name}.severity is unsupported`, 'invalid-review-receipt');
    return { severity, summary: text(finding.summary, `${name}.summary`, 1000) };
  });
  const validation = list(value.validation, 'validation', (item, name) => {
    requireThat(item && typeof item === 'object', `${name} must be an object`, 'invalid-review-receipt');
    const state = text(item.state, `${name}.state`, 20);
    requireThat(validationStates.has(state), `${name}.state is unsupported`, 'invalid-review-receipt');
    return {
      name: text(item.name, `${name}.name`, 200),
      state,
      ...(item.details == null ? {} : { details: text(item.details, `${name}.details`, 1000) })
    };
  });
  requireThat(validation.length > 0, 'Review receipt must record at least one validation result',
    'invalid-review-receipt');
  const residualRisks = list(value.residualRisks, 'residualRisks',
    (risk, name) => text(risk, name, 1000));
  const blocking = findings.some(finding => finding.severity === 'blocking');
  requireThat(blocking === (outcome === 'blocking-findings'),
    'Review outcome must agree with blocking findings', 'invalid-review-receipt');
  return {
    schemaVersion: 1,
    reviewedHead,
    reviewedBase,
    reviewedAt: utc(value.reviewedAt),
    reviewer: text(value.reviewer, 'reviewer', 200),
    outcome,
    findings,
    validation,
    residualRisks
  };
}

function encodedMarker(receipt) {
  return `${markerPrefix}${Buffer.from(JSON.stringify(receipt)).toString('base64url')} -->`;
}

export function renderReviewReceipt(receipt, { repository, number, url }) {
  const normalized = normalizeReviewReceipt(receipt);
  const findings = normalized.findings.length
    ? normalized.findings.map(item => `- **${item.severity}:** ${item.summary}`).join('\n')
    : '- No findings recorded.';
  const validation = normalized.validation
    .map(item => `- **${item.state}:** ${item.name}${item.details ? ` — ${item.details}` : ''}`).join('\n');
  const risks = normalized.residualRisks.length
    ? normalized.residualRisks.map(risk => `- ${risk}`).join('\n')
    : '- None recorded.';
  return `${encodedMarker(normalized)}
## Head-bound code review receipt

- **PR:** ${repository}#${number}${url ? ` (${url})` : ''}
- **Reviewed head:** \`${normalized.reviewedHead}\`
- **Reviewed base:** \`${normalized.reviewedBase}\`
- **Reviewer:** ${normalized.reviewer}
- **Reviewed at:** ${normalized.reviewedAt}
- **Outcome:** **${normalized.outcome}**

### Findings
${findings}

### Validation
${validation}

### Residual risks
${risks}

This receipt applies only to the exact head and base SHAs above. Any push, base update, or conflict resolution requires a new review.`;
}

export function extractReviewReceipt(body) {
  if (typeof body !== 'string') return null;
  const match = markerPattern.exec(body);
  if (!match) return null;
  try {
    return normalizeReviewReceipt(JSON.parse(Buffer.from(match[1], 'base64url').toString('utf8')));
  } catch {
    return null;
  }
}

function normalizePr(value) {
  requireThat(value && Number.isInteger(value.number) && value.number > 0 &&
    shaPattern.test(value.headRefOid ?? '') && shaPattern.test(value.baseRefOid ?? '') &&
    typeof value.author?.login === 'string',
  'GitHub returned incomplete PR identity or revision data', 'blocked-review-receipt');
  return value;
}

async function ghJson(args) {
  const { stdout } = await exec('gh', args, {
    windowsHide: true, encoding: 'utf8', timeout: 30000, maxBuffer: 4 * 1024 * 1024
  });
  return JSON.parse(stdout);
}

async function loadPr(runGh, repository, number, includeComments = false) {
  return normalizePr(await runGh(['pr', 'view', String(number), '--repo', repository, '--json',
    `number,url,state,isDraft,author,headRefOid,baseRefOid${includeComments ? ',comments' : ''}`]));
}

function assertCurrent(receipt, pr) {
  requireThat(receipt.reviewedHead === pr.headRefOid.toLowerCase(),
    `Review receipt head ${receipt.reviewedHead} does not match current PR head ${pr.headRefOid}`,
    'stale-review-receipt');
  requireThat(receipt.reviewedBase === pr.baseRefOid.toLowerCase(),
    `Review receipt base ${receipt.reviewedBase} does not match current PR base ${pr.baseRefOid}`,
    'stale-review-receipt');
}

export async function publishReviewReceipt({
  repository, number, receipt, approveOtherAuthor = false, runGh = ghJson
}) {
  requireThat(/^[^/\s]+\/[^/\s]+$/.test(repository ?? ''), 'Expected --repo OWNER/REPO',
    'blocked-review-receipt');
  requireThat(Number.isInteger(number) && number > 0, 'Expected --pr to be a positive integer',
    'blocked-review-receipt');
  const pr = await loadPr(runGh, repository, number);
  requireThat(pr.state === 'OPEN', 'Review receipts can only be published to an open PR',
    'blocked-review-receipt');
  const viewer = await runGh(['api', 'user']);
  requireThat(typeof viewer?.login === 'string', 'GitHub viewer identity is unavailable',
    'blocked-review-receipt');
  requireThat(pr.author.login.toLowerCase() === viewer.login.toLowerCase() || approveOtherAuthor,
    `PR is owned by ${pr.author.login}; pass --approve-other-author only after explicit approval`,
    'approval-required');
  const normalized = normalizeReviewReceipt(receipt);
  assertCurrent(normalized, pr);
  const body = renderReviewReceipt(normalized, { repository, number: pr.number, url: pr.url });
  await runGh(['api', `repos/${repository}/issues/${number}/comments`, '--method', 'POST',
    '--raw-field', `body=${body}`]);
  const after = await loadPr(runGh, repository, number);
  assertCurrent(normalized, after);
  return {
    state: normalized.outcome === 'no-blocking-findings' ? 'published' : 'published-blocking',
    repository,
    number: pr.number,
    reviewedHead: normalized.reviewedHead,
    reviewedBase: normalized.reviewedBase,
    author: pr.author.login,
    publisher: viewer.login
  };
}

export async function verifyReviewReceipt({ repository, number, runGh = ghJson }) {
  requireThat(/^[^/\s]+\/[^/\s]+$/.test(repository ?? ''), 'Expected --repo OWNER/REPO',
    'blocked-review-receipt');
  requireThat(Number.isInteger(number) && number > 0, 'Expected --pr to be a positive integer',
    'blocked-review-receipt');
  const pr = await loadPr(runGh, repository, number, true);
  const receipts = (pr.comments ?? []).map(comment => ({
    receipt: extractReviewReceipt(comment.body),
    createdAt: comment.createdAt,
    author: comment.author?.login
  })).filter(item => item.receipt);
  const current = receipts.reverse().find(item =>
    item.receipt.reviewedHead === pr.headRefOid.toLowerCase() &&
    item.receipt.reviewedBase === pr.baseRefOid.toLowerCase());
  requireThat(current, 'No review receipt matches the current PR head and base',
    'stale-review-receipt');
  requireThat(current.receipt.outcome === 'no-blocking-findings',
    'The current review receipt contains blocking findings', 'blocking-review-findings');
  requireThat(current.receipt.validation.every(item => item.state === 'passed'),
    'The current review receipt contains failed or not-run validation', 'blocking-review-validation');
  return {
    state: 'review-receipt-verified',
    repository,
    number: pr.number,
    reviewedHead: current.receipt.reviewedHead,
    reviewedBase: current.receipt.reviewedBase,
    reviewer: current.receipt.reviewer,
    commentAuthor: current.author,
    commentCreatedAt: current.createdAt,
    residualRisks: current.receipt.residualRisks
  };
}
