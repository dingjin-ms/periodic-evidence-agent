export const reviewContext = Object.freeze({
  coverageGap: 'The synthetic fixture lacks a regression check for the reported behavior.',
  testsAndAssertions: 'Exercise the fixture behavior and assert its expected result.',
  boundaries: 'Synthetic inputs and external-provider doubles; no live service validation.',
  reviewFocus: 'Check the fixture assertion and the bounded change against the reported behavior.'
});
