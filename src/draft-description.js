import { requireThat } from './common.js';
import { renderCoverageReview } from './repository-skills.js';

export const reviewContextSchema = {
  type: 'object', additionalProperties: false,
  required: ['coverageGap', 'testsAndAssertions', 'boundaries', 'reviewFocus'],
  properties: Object.fromEntries(
    ['coverageGap', 'testsAndAssertions', 'boundaries', 'reviewFocus'].map(field =>
      [field, { type: 'string', minLength: 1, maxLength: 1000 }]))
};

export const reviewContextInstructions =
  'For propose-change, include reviewContext with nonempty coverageGap, testsAndAssertions, ' +
  'boundaries, and reviewFocus strings (at most 1000 characters each). Explain the evidence-to-test ' +
  'gap, the observable assertions and real versus fake boundaries, what remains untested or unknown, ' +
  'and what the reviewer should assess. Keep these concise and author-reported; do not claim tests ' +
  'or CI passed. The controller adds source references, actual changed files and exact-head validation. ' +
  'The complete Draft body including controller metadata must fit 4000 characters. ' +
  'Do not copy raw source payloads, local artifact paths, credentials or notification mentions into the PR.';

export function requireReviewContext(context) {
  requireThat(context && typeof context === 'object' && !Array.isArray(context) &&
    Object.keys(context).every(key => Object.hasOwn(reviewContextSchema.properties, key)) &&
    reviewContextSchema.required.every(key =>
      typeof context[key] === 'string' && context[key].trim().length > 0 &&
      context[key].length <= 1000),
  'Draft publication requires coverageGap, testsAndAssertions, boundaries and reviewFocus ' +
    '(nonempty strings, at most 1000 characters each)', 'blocked-pr-description');
}

const text = value => String(value).replace(/[\\`*_[\]<>]/g, '\\$&').replace(/[\r\n]+/g, ' ');

export function requireDraftDescriptionLength(description, assignmentId) {
  requireThat(typeof description === 'string' && description.trim().length > 0 &&
    `${description}\n\nPilot assignment: ${assignmentId}`.length <= 4000,
  'Draft description exceeds the 4000-character provider limit; shorten authoring context ' +
    'without dropping evidence or validation. No content was truncated.', 'blocked-pr-description');
}

export function renderDraftDescription({ assignment, proposal, evidence, changedFiles, revision, validation }) {
  requireReviewContext(proposal.reviewContext);
  requireThat(typeof proposal.description === 'string' && proposal.description.trim().length > 0,
    'Draft description requires an author summary', 'blocked-pr-description');
  requireThat(Array.isArray(assignment.evidenceIds) && assignment.evidenceIds.length > 0 &&
    new Set(assignment.evidenceIds).size === assignment.evidenceIds.length &&
    Array.isArray(evidence) && evidence.length === assignment.evidenceIds.length &&
    evidence.every((item, index) => item?.id === assignment.evidenceIds[index] &&
      item.source?.kind && item.source.recordId && item.source.namespace &&
      (item.source.revision || item.capture?.sha256)),
  'Draft description requires every assigned source reference and its captured version',
  'blocked-pr-description');
  requireThat(Array.isArray(changedFiles) && changedFiles.length > 0 &&
    changedFiles.every(path => typeof path === 'string' && path.trim().length > 0),
  'Draft description requires the actual committed changed files', 'blocked-pr-description');
  requireThat(/^[a-f0-9]{40,64}$/.test(revision ?? '') &&
    Array.isArray(assignment.validationGates) && assignment.validationGates.length > 0 &&
    Array.isArray(validation) && validation.length === assignment.validationGates.length &&
    new Set(validation.map(gate => gate.gateId)).size === validation.length &&
    assignment.validationGates.every(id => validation.some(gate =>
      gate.gateId === id && gate.status === 'passed' && gate.sourceRevision === revision)),
  'Draft description requires all assigned gates to pass at the candidate revision',
  'blocked-pr-description');

  const sources = evidence.map(item => {
    let reference = 'Source URL unavailable; use the source identity below.';
    if (item.url != null) {
      let url;
      try { url = new URL(item.url); } catch {
        requireThat(false, 'Draft evidence has an invalid source URL', 'blocked-pr-description');
      }
      requireThat(url.protocol === 'https:' && !url.username && !url.password,
        'Draft evidence source URL must be HTTPS without credentials', 'blocked-pr-description');
      reference = `[Source](${url.href.replace(/[()<>]/g,
        character => `%${character.charCodeAt(0).toString(16).toUpperCase()}`)})`;
    }
    return `- ${reference} ${text(item.source.kind)} / ${text(item.source.namespace)} / ` +
      `${text(item.source.recordId)}; ${item.source.revision ? 'revision' : 'capture SHA-256'} ` +
      `${text(item.source.revision ?? item.capture.sha256)}; provenance: ${text(item.source.provenance)}` +
      (item.observedAt ? `; captured: ${text(item.observedAt)}` : '') +
      (item.sourceStatus ? `; captured status: ${text(item.sourceStatus)}` : '') + '.';
  });
  const context = proposal.reviewContext;
  const unknowns = proposal.skillExecution?.unknowns ?? [];
  const description = [
    proposal.description.trim(),
    '### Source evidence',
    sources.join('\n'),
    '### Coverage gap (author-reported)',
    text(context.coverageGap),
    '### Tests and assertions (author-reported)',
    text(context.testsAndAssertions),
    'Changed files (committed base-to-candidate diff):\n' +
      [...new Set(changedFiles)].sort().map(path => `- ${text(path)}`).join('\n'),
    '### Boundaries and limitations (author-reported)',
    text(context.boundaries) +
      (unknowns.length ? '\n\nReported unknowns:\n' + unknowns.map(value => `- ${text(value)}`).join('\n') : ''),
    '### Source-bound validation',
    `All required native gates passed at clean revision \`${revision}\`: ` +
      validation.map(gate => `\`${text(gate.gateId)}\``).join(', ') +
      '. This records gate outcomes, not an independent semantic coverage assessment or a remote-CI pass.',
    '### Review focus (author-reported)',
    text(context.reviewFocus),
    'Draft only; human review required. No automatic merge.'
  ].join('\n\n') + renderCoverageReview(proposal.skillExecution);
  requireDraftDescriptionLength(description, assignment.id);
  return description;
}
