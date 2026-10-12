# Contributing to the internal pilot

All workstreams below are **unassigned**. Logical agent IDs and skills are not
people/maintainer assignments. Claim a bounded workstream with the team before
making concurrent changes. No production feature or publication authorization
is implied by this document.

| Workstream | Main surface | Acceptance criteria |
|---|---|---|
| Collector / source coverage | `sources.js`, `app-native.js`, collector skill | Exact identity/scope and UTC windows; pagination including old-thread replies; immutable receipts; true partial/auth/unavailable outcomes; no live retries in tests |
| Coordinator / state | `ledger.js`, `coordinator.js`, coordinator skill | All 14 exclusions for both intents; explicit routing; atomic claims; restart/replay and dedupe; no duplicate dispatch after uncertainty |
| 1JS owner integration | 1JS skill, repo configuration | Approved owner/base/write bounds; isolated workspace; evidence-backed RCA; exact-source validation; drafts only; unresolved prerequisites stay blocked |
| Office owner integration | Office skill, repo configuration | Same owner contract; Office-specific base/validation must be supplied, never guessed from repo name |
| Qualification / packaging | Tests, demo, CI, docs | Account-free clean checkout passes; inert example; no private payloads; synthetic/live status separated; approved private publication gate |

## Development contract

Use Node 24 and Git. `npm ci --ignore-scripts`, `npm test`, `npm run demo` and
`npm run check:package` are the offline entrypoints. Tests may create local
temporary Git repos and execute synthetic validation programs, but must not
acquire credentials, call services or launch product workers. Add focused
regressions for behavioral changes and run the complete offline suite before
handoff. CI uses a read-only token and no live secrets or account login.

The reviewed-handoff downstream E2E is not a source connector test. Keep its
fixture source-neutral (`kind: fixture`, `provenance: synthetic`) and keep the
runner thin: it must call the normal planning, assignment and dispatch modules,
not reimplement them. Ordinary dispatch must continue rejecting synthetic
evidence. Real worker, push and Draft PR effects require the dedicated command
plus both explicit authorization flags; offline tests may inject only external
model and PR-provider boundaries.

For ledger/schema changes, cover immutable versions, transaction rollback,
idempotency, cursor retention, provenance and uncertain ownership. Do not
silently migrate or edit a colleague's live config/ledger. Stable agent/run/
assignment IDs are independent of sessions. Exact JSON handoffs are documented
in [APP-NATIVE.md](APP-NATIVE.md); shared owner policy lives in
[repo-owner-procedure.md](.github/skills/repo-owner-procedure.md).

Use synthetic identities/content in fixtures. Keep real captures, authentication
diagnostics and personal configuration in ignored protected local storage.
Do not paste source payloads or tokens into issues, PRs, test failures or CI
artifacts. Sanitized aggregate validation summaries may describe gaps, not imply
unobserved success. Report sensitive-history findings privately; do not rewrite
history or publish it as a recovery shortcut.

## Review boundaries

Preserve draft-only/no-merge/no-source-write policy and all source/worker limits.
No test or contributor may turn a partial run into complete by hiding an
unavailable source. A new connector, expanded scope, auth flow, validation
runner, scheduler or permission grant requires explicit owner approval and its
own qualification. A working offline demo does not authorize any of these.

Reviewed handoff submission is a deterministic controller interface, not a new
AI agent or a second implementation of review policy. The upstream receipt owns
the review/exclusion/classification decision; shared production helpers enforce
its consistency and eligibility. The repository-native skill guides authoring,
while the controller alone owns ledger materialization, commit, validation,
push and Draft PR operations.

Validation repair rounds never rerun an immutable gate operation on the same
revision. Each repair produces a new committed revision, preserves the failed
attempt and artifact, and receives a final independent controller validation.
Keep the configured repair-round limit small and explicit; exhaustion must
remain failed or blocked rather than becoming success-shaped.

Before merge, review the final diff and publish a machine-readable receipt bound
to the exact PR head and base commit SHAs. Start from
`scaffold/pr-review-receipt.example.json`, replace both SHAs and all review
details, then run:

```powershell
npm run pilot -- pr-review-publish --repo OWNER/REPO --pr NUMBER --file .\review-receipt.local.json
npm run pilot -- pr-review-verify --repo OWNER/REPO --pr NUMBER
```

Publishing automatically comments only on a PR owned by the signed-in GitHub
user. Commenting on another author's PR requires explicit approval and
`--approve-other-author`. Any new push, base update or conflict resolution makes
the prior receipt stale and requires another final-diff review. A receipt with
blocking findings, failed validation or validation that was not run cannot pass
verification. The `*.local.json` name keeps the local receipt out of Git.
Passing CI is necessary but does not replace code review.

Publication is an independent decision: see
[the validation and sharing gate](README.md#validation-and-sharing-gate).
No open-source license is supplied; confirm company requirements before
publishing anywhere, including an internal private repository.
