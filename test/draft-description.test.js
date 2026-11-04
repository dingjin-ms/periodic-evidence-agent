import test from 'node:test';
import assert from 'node:assert/strict';
import {
  renderDraftDescription, requireReviewContext, requireDraftDescriptionLength
} from '../src/draft-description.js';
import { reviewContext } from '../scripts/test-fixtures/draft-context.mjs';

function fixture() {
  return {
    assignment: { id: 'synthetic-assignment', evidenceIds: ['bug', 'incident', 'thread'],
      validationGates: ['integration'] },
    proposal: { description: 'Add a focused test.', reviewContext: { ...reviewContext },
      skillExecution: { unknowns: ['Live service behavior is outside this test.'] } },
    evidence: ['ado', 'icm', 'workiq'].map((kind, index) => ({
      id: ['bug', 'incident', 'thread'][index],
      source: { kind, namespace: 'synthetic', recordId: String(index + 1),
        revision: index < 2 ? '3' : null, provenance: 'synthetic' },
      url: `https://example.invalid/${kind}/${index + 1}`,
      observedAt: '2026-01-01T00:00:00Z', sourceStatus: 'Resolved',
      capture: { sha256: 'b'.repeat(64), artifactRef: 'private/raw-source.json' },
      fields: { secret: 'RAW_SOURCE_MUST_NOT_BE_PUBLISHED' },
      queryText: 'PRIVATE_QUERY_MUST_NOT_BE_PUBLISHED'
    })),
    changedFiles: ['test/behavior.test.js'],
    revision: 'a'.repeat(40),
    validation: [{ gateId: 'integration', status: 'passed', sourceRevision: 'a'.repeat(40),
      artifactRefs: ['private/native-results.json'] }]
  };
}

test('draft description binds all source kinds, authored context, actual files and gate revision', () => {
  const input = fixture();
  const description = renderDraftDescription(input);
  for (const source of input.evidence) assert.ok(description.includes(source.url));
  for (const value of Object.values(reviewContext)) assert.ok(description.includes(value));
  assert.match(description, /capture SHA-256 b{64}/);
  assert.match(description, /revision 3/);
  assert.match(description, /provenance: synthetic/);
  assert.match(description, /captured: 2026-01-01T00:00:00Z; captured status: Resolved/);
  assert.match(description, /test\/behavior\.test\.js/);
  assert.ok(description.includes(input.revision));
  assert.match(description, /Reported unknowns/);
  assert.doesNotMatch(description, /RAW_SOURCE|PRIVATE_QUERY|private\/|reviewers|@mention/);
  assert.match(description, /not an independent semantic coverage assessment or a remote-CI pass/);
});

test('existing seam inventory remains author-reported alongside required context', () => {
  const input = fixture();
  input.proposal.skillExecution.coverageReview = [{
    seam: 'Handler to executor', evidenceBasis: 'Synthetic incident',
    unitEvidence: [], integrationEvidence: ['Baseline happy-path case'],
    testFiles: ['test/behavior.test.js'], defectDetected: 'Missing timeout propagation',
    residuals: ['Gate-disabled path requires separate coverage']
  }];
  const description = renderDraftDescription(input);
  assert.match(description, /### Test coverage review \(author-reported\)/);
  assert.match(description, /Missing timeout propagation/);
  assert.match(description, /Gate-disabled path requires separate coverage/);
  assert.match(description, /not an independent semantic quality grade/);
});

test('missing or whitespace-only review fields block publication instead of creating placeholders', () => {
  for (const field of Object.keys(reviewContext)) {
    const input = fixture();
    delete input.proposal.reviewContext[field];
    assert.throws(() => renderDraftDescription(input), { code: 'blocked-pr-description' });
    input.proposal.reviewContext[field] = ' \n ';
    assert.throws(() => renderDraftDescription(input), { code: 'blocked-pr-description' });
  }
  assert.throws(() => requireReviewContext(undefined), { code: 'blocked-pr-description' });
});

test('missing, misbound and unversioned evidence blocks publication', () => {
  for (const change of [
    input => input.evidence.pop(),
    input => { input.evidence[0] = null; },
    input => { input.evidence[0].id = 'unassigned'; },
    input => { input.evidence[2].capture.sha256 = null; }
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => renderDraftDescription(input), { code: 'blocked-pr-description' });
  }
});

test('unavailable source URLs are explicit and unsafe source URLs are rejected', () => {
  const input = fixture();
  input.evidence[0].url = null;
  assert.match(renderDraftDescription(input), /Source URL unavailable/);
  for (const url of ['not-a-url', 'javascript:alert(1)', 'https://user:password@example.invalid/']) {
    input.evidence[0].url = url;
    assert.throws(() => renderDraftDescription(input), { code: 'blocked-pr-description' });
  }
});

test('stale, failed, missing and duplicate gate results cannot produce a validation-success claim', () => {
  for (const change of [
    input => { input.validation[0].sourceRevision = 'c'.repeat(40); },
    input => { input.validation[0].status = 'failed'; },
    input => { input.validation = []; },
    input => { input.validation[0].gateId = 'other'; },
    input => { input.assignment.validationGates.push('other'); input.validation.push(input.validation[0]); }
  ]) {
    const input = fixture();
    change(input);
    assert.throws(() => renderDraftDescription(input), { code: 'blocked-pr-description' });
  }
});

test('description size is checked including assignment footer without truncation', () => {
  const input = fixture();
  input.proposal.description = 'x'.repeat(4000);
  assert.throws(() => renderDraftDescription(input), /4000-character/);
  const suffix = '\n\nPilot assignment: fixture';
  requireDraftDescriptionLength('x'.repeat(4000 - suffix.length), 'fixture');
  assert.throws(() => requireDraftDescriptionLength('x'.repeat(4001 - suffix.length), 'fixture'),
    /No content was truncated/);
});

test('author fields and source link delimiters cannot inject Markdown links or mentions', () => {
  const input = fixture();
  input.proposal.reviewContext.reviewFocus = '[fake](https://other.invalid) @<reviewer>';
  input.evidence[0].url = 'https://example.invalid/item(1)';
  const description = renderDraftDescription(input);
  assert.ok(description.includes('\\[fake\\](https://other.invalid) @\\<reviewer\\>'));
  assert.ok(description.includes('https://example.invalid/item%281%29'));
});
