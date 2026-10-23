# Evidence-to-Draft-PR E2E proofs

This directory contains sanitized, machine-checkable proof bundles for completed
real evidence-to-Draft-PR runs.

## Recorded live runs

| Repository | Proof bundle | Result boundary |
| --- | --- | --- |
| OfficeAgent | [ado-window-discovery-20261012](ado-window-discovery-20261012/README.md) | Original evidence-to-Draft-PR proof |
| 1JS | [1js-chat-only-full-live-20261023](1js-chat-only-full-live-20261023/README.md) | Real local live E2E completed: new contiguous 5/5, retry 0, cleanup and Draft PR 5895602; Aurora 57965896 triggered but failed before configuration snapshot, cloud follow-up open |

The 1JS native-continuation bundle includes its own offline `verify.mjs`;
it preserves the original selected assignment and is not a new complete-record
FILTER-consolidation run. Its README distinguishes the completed local
evidence-to-Draft-PR chain from unfinished cloud validation and describes the
ignored private archive of raw receipts, captures, screenshots and HTML.

## Evidence policy

Each run directory is immutable and declares its proof format and scope.
Complete-record FILTER bundles contain aggregate collection coverage and complete
FILTER accounting; retained native continuations explicitly record their
existing selection lineage without claiming a new FILTER run. Both retain the
selected coverage-gap binding, repository-skill execution, exact-revision
validation, the Draft PR receipt and safety limits.
`SHA256SUMS` binds the committed files.

Raw source bodies, captures, identities, local paths, private execution packets,
SQLite ledgers and logs must remain in approved ignored storage. A committed
bundle contains hashes that an authorized operator can revalidate against those
private artifacts with the checker declared by that bundle (`e2e-proof-check`
for the original FILTER format); it is not a replacement for them.

Do not manually mark a run successful. Generate the bundle only from a terminal
`draft-pr-validated` controller result and retain the private request or artifact
index required by its checker.
