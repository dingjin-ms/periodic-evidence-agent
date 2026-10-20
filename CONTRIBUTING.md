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

The reviewed-handoff integration flow is not a source connector test. Keep its
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

## Self-improvement review evidence

The first RSI deliverable is recovery-harness qualification and a source-bound
scorecard, not a claimed improvement. Run the bounded focused regressions with:

```powershell
node --test --test-concurrency=1 test\self-improvement.test.js test\self-improvement-evaluation.test.js
```

On Windows, a short-name temporary-root alias can abort Node's file watcher with
`!_wcsnicmp(filename, dir, dirlen)` in `src\win\fs-event.c`. Check whether
`tmpdir()` differs from `realpathSync.native(tmpdir())`; use canonical,
process-local `TEMP`/`TMP` for validation rather than weakening watcher/root
guards or counting crashed test files as passed:

```powershell
$canonicalTemp = node -p "require('node:fs').realpathSync.native(require('node:os').tmpdir())"
if ($LASTEXITCODE -ne 0) { throw 'Cannot resolve the validation temporary root' }
$env:TEMP = $canonicalTemp
$env:TMP = $canonicalTemp
npm run check -- --test-concurrency=4
```

To retain the ordinary qualification test's authoritative store for review,
set `RSI_RETAIN_QUALIFICATION=1` before running that test and remove the
environment variable afterward. The test prints the store/experiment identity
and saves its exact policy in the ignored store. This is not permission for a
standalone operational trial. The owning checkout must retain that store;
tests clean only their separately allocated disposable fixture repositories.

Every proposed RSI improvement PR needs a **Before/after loop comparison**
section generated from verified sealed observations. `self-improvement report`
returns that Markdown; it does not publish or edit a PR. Report the exact
controller and loaded working-tree source identities, dependency/evaluator/
driver/workload/policy/toolchain pins, raw counts and denominators, per-episode
outcomes, missing data and the limits of the conclusion. A new source identity
requires fresh evaluation or an explicit stale label. Current/current equality
must say `no-demonstrated-benefit`; never weaken the old arm to manufacture a bug.

Keep preregistered recovery, healthy and guard populations distinct:

- Recovery uses every selected recovery episode; completion uses recovery plus
  healthy episodes. Valid pre-test target failures remain unsuccessful in both
  applicable denominators, not invalid harness executions.
- Expected guard refusals belong only to guard correctness, not recovered work
  or task completion. Invalid harness execution, unknown and not-run are
  separate categories; all selected episodes remain accounted for.
- Recurrence uses the complete fixed follow-up inventory. Zero opportunities
  means not applicable, never 100%. Missing observations remain unresolved.
- Execution coverage and verified assertion coverage use the original common
  case/assertion inventory, with explicit gain/loss, skipped and unknown items.
  Pinned nonempty bodies and real case events are required; green wrappers or
  worker results alone are insufficient. Skip/todo starts are not execution.
  This is not line/branch coverage.
- Authority violations, rejected duplicate effects and unsupported success
  claims are hard failures. A broker refusal and its rejected effect count as
  one violation; duplicate requests and unsupported actions are separate counts.
  Available duration/tool counts are diagnostic.
  Tokens/credits remain not measured, not zero or a configured budget ceiling.

The comparison JSON and Markdown must use the same grading functions and sealed
inputs. Test false green, missing/skipped/failed/duplicate cases, source drift,
pre-test failure accounting, finite bounds, immutable versions, root ownership,
crash boundaries, read-only status and adopt/abandon behavior. Public material
contains only generic fixture labels and safe aggregates, never raw local paths,
workplace evidence or credential diagnostics. Metric additions and real
failure-pattern fixes require separately reviewed evidence, not reward by
instrumentation volume. No model, live recovery, promotion or publication grant
is implied by passing these offline tests.

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

Infrastructure recovery is distinct from source repair. The controller may
repeat only an explicitly classified transient validation attempt in a fresh
checkout of the same revision and within the configured retry limit. It must
preserve every attempt artifact. Profile/hash, ownership, permission or policy
changes require reconciliation or approval and may not be cleared by a model.

Repository-skill qualification must bind the exact source revision, skill
content hash and validation contract version/hash. If trusted-remote refresh is
configured, fetch before qualification. Do not silently update the skill or
validation contract for an assignment that has already entered authoring or
repair.

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
