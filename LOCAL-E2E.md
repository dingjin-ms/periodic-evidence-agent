# Reusable local SDK cohort-to-Draft-PR orchestration

`local-e2e` replaces per-run batch loops, result-export scripts and handoff
watchers with one durable controller entry point. It consumes an **already
approved FILTER manifest**, executes missing batches sequentially, reconciles
the entire cohort, holds for independent semantic review, then releases one
ordinary local Proposer. It does not replace collection, grouping/sharing
review, tokenizer qualification, native authentication or product validation.
It never merges or auto-completes a PR.

This is separate from the **external Agency** contract in [ONE-SHOT.md](ONE-SHOT.md).
Neither contract is silently converted into the other. The coordinating host
still owns authorization, semantic review and handling explicit blocked states.
There is no background watcher, schedule, automatic retry or permission upgrade.

## Prepare the inputs once per run

Use the existing Collector `one-shot-begin` / `one-shot-collect --collect` or
approved app collection commands to capture evidence. Keep collection-only
storage separate from the Proposer/execution store. Follow the existing
`filter-batch-size` / `filter-batches` workflow to produce the reviewed grouping,
sharing inventory and verified-tokenizer manifest. The new runner preserves
that exact manifest; it cannot expand the evidence window or invent candidates.
It validates the manifest's captured corpus, not a new fresh-collection
attestation. Source coverage/freshness must be checked at the collection gate.

Create an ignored `pilot.local.json` using the normal repository configuration.
Before starting FILTER, finalize **all** Proposer/native/RSI settings in it:

- `executionMode: "standalone-sdk"`, `filterExecutor: "local-sdk"`,
  approved state storage and `schedule.enabled: false`.
- Explicit local FILTER source revisions, request/tool/time limits, sharing
  approval and `acceptSoftCreditLimit`. FILTER and Proposer use the same frozen
  configuration and state ledger; no pending-file handoff race.
- Finite worker minutes, tool calls, assignments/workers, model credits and
  validation repair rounds. The Proposer authorization must cover
  `maxAiCreditsPerSession * (1 + maxValidationRepairRounds)`.
- The existing qualified product skill, write bounds, authentication and native
  gates. Use `qualify-skill` normally; this runner does not auto-requalify
  tokenizer/model/executable drift or relax qualification.

The installed SDK may reject a credit ceiling below its runtime minimum.
`action-required-budget` is preserved, not treated as an empty candidate list.
Credits are the existing **soft** SDK limit, not a hard billing ceiling.
Approve the correct limits before creating the run; the runner never raises them.

Copy [the inert run example](scaffold/local-e2e.example.json) to `run.local.json`.
Replace its expired dates, approval references, routing, absolute manifest path
and raw file SHA-256. Enable each publication permission only when authorized.
For example, obtain the manifest hash with:

```powershell
(Get-FileHash C:\approved-run\filter-manifest.json -Algorithm SHA256).Hash.ToLowerInvariant()
```

`maxFilterRequests` bounds the existing **ledger-wide** request count, including
failed requests and explicit retries. It must cover `localFilter.maxRequests`;
retry overrides cannot enlarge this run's original request/tool/time caps.
Reusing previously captured immutable FILTER attempts is allowed and does not
claim that they were newly executed. Do not reset or replace the ledger to
recover an exhausted authorization.

## Run, review and release

These are top-level coordinator commands, not extra authority for the FILTER
role. `--check` only reconciles local state; `--filter` authorizes only missing
FILTER executions. Neither creates a Proposer assignment or warms native
dependencies. Exactly one of `--check`, `--filter`, `--execute` is required.

```powershell
node src\cli.js local-e2e --check --file run.local.json --config pilot.local.json
node src\cli.js local-e2e --filter --file run.local.json --config pilot.local.json
```

Every batch must have a complete accepted execution, not merely schema-valid
JSON. Canonical result files are materialized from immutable receipts under
`stateDirectory\local-e2e\RUN_ID`. Missing exports can be reconstructed; changed
existing exports are blocked and preserved. Active/uncertain requests and
terminal failures are never blindly redispatched.

`held-no-candidate` is **not a completed E2E**. Inspect the full cohort and decide
whether a separately approved reassessment or different evidence is warranted.
With an eligible candidate, `held-awaiting-review` returns `reviewRequired`:
save that object to `review.local.json`, independently inspect the evidence IDs,
source revisions, real public/private API boundaries and existing assertions,
then set the reviewer/time, decision and actionable rationale. The review binds
the complete current result set, configuration, routing and selected candidate;
changing an attempt invalidates the approval. `reject` remains held.

Structural/helper success never proves semantic correctness. Review references
alone cannot establish that a candidate describes the attached evidence.

```powershell
node src\cli.js local-e2e --execute --review review.local.json --file run.local.json --config pilot.local.json --authorize-commit --authorize-push --authorize-draft-pr
```

Execution requires the run authorization, CLI flags, activation and skill
permissions independently. Native preparation starts only through the normal
worker after this gate, under the same accepted configuration. A durable
dispatch intent is saved before calling the worker. Only the existing worker's
exact-head passing validation gates and verified Draft PR result can produce
`state: "completed"`. A zero CLI exit code for a held/check state is **not**
evidence-to-Draft-PR completion.

Rerun the same command or `--check` after an interruption. A completed attempt
is reconciled without reauthoring, pushing or creating another PR. An uncertain
dispatch stays blocked even if its job still appears prepared. Preserve its
operations and use the existing explicit validation/authoring recovery commands
where appropriate; do not create a replacement run to bypass the block.

For positive `action-required-auth`, follow [AGENTS.md](AGENTS.md) outside the
runner. Then add `--resume-auth` to the original authorized execute command
**once**. Recovery must prove that the exact assignment has no worker/provider
operations, workspace, base revision or terminal result. A second auth failure
stops; there is no sign-in or installation loop.

## Prepare a FILTER successor without a custom script

Create a private review JSON and a request such as:

```json
{
  "format": "local-filter-retry-request-v1",
  "batchId": "COPY_THE_EXACT_BATCH_ID",
  "authorizationRef": "EXPLICIT_SUCCESSOR_APPROVAL",
  "reviewRef": "C:\\approved-run\\independent-review.local.json",
  "reason": "State the precise evidence/source mismatch and required correction here."
}
```

`reason` is the actionable model feedback (at most 4000 characters). The review
artifact is independently hashed, but its contents are **not injected** into the
model. Do not rely on a path/hash instead of describing the correction.

```powershell
node src\cli.js filter-local-retry-prepare --file retry-request.local.json --config pilot.local.json --output next.local.json
node src\cli.js local-e2e --filter --file run.local.json --config next.local.json
```

The output must be a new ignored `.local.json` beside the original config, so
relative paths keep their meaning. Preparation binds the currently selected
actual predecessor and terminal hash, adds a completed-result reassessment when
necessary, and retains other batches' retry selections and original caps.
It never opens a model session or reserves a request. Execution still verifies
lineage, source/model/payload pins, the review hash, request budget and no-fork
rules. Do not edit immutable receipts, manually clear blockers or fork successors.

After reassessment, generate a new review for the new whole-cohort binding.
Only predecessor-bound FILTER retry selections may change inside the run;
source, manifest, model, permissions and all other configuration remain frozen.
Changing any accepted FILTER attempt after Proposer release is blocked.

## Source tool diagnostics

The prompt names the allowed literal `repoId` values. `repoId` is an exact
configured identifier, not a Git path; `path` is a repository-relative Git path.
Read offsets and `nextOffset` are **UTF-8 byte offsets**, not line numbers. Read
from zero through exact returned offsets until EOF, including empty files.

Rejected source calls retain bounded allowlisted request context and actionable
errors. Unknown fields, credentials and unsafe provider diagnostics are not
copied into receipts. A later valid call cannot undo a prior permanent
scope/budget violation: finish the blocked attempt and authorize a successor
instead. This makes failures diagnosable without relaxing the execution policy.
