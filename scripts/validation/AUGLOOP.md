# AugLoop native adapter

Use `node scripts\augloop.mjs <stage> <private-request.json>` from the controller
root. This is one entrypoint composing the existing controller APIs, **not** the
certified global one-shot wrapper. It does not merge, auto-complete, queue CI, or
silently restart failed stages.

## Authorization and evidence levels

Configuration is not authorization to start another product run. Respect the
current authorization's one-product-worker limit and
`stopAfterFirstSuitableDraftPR` condition. Once a suitable Draft exists, remaining
model-session allowance is a ceiling, not permission to consume it or create
another PR. Generalization proof can use `qualify`, `replay`, `reconcile`,
`prepare`, and fully retained `filter` reconciliation without model execution.
Do not invoke `propose`, execute a publishing continuation, or start new model
sessions under that stop condition. Report any concrete need for a model call to
the authorization owner before launching it; a model allocation alone does not
override the publication stop.

| Evidence level | What establishes it | What it does not establish |
| --- | --- | --- |
| Configured capability | Four explicit owner contracts, routing/write bounds, pinned source/skill/profile and disabled scaffold | Native qualification, candidate acceptance or publication permission |
| Qualified capability | Passing isolated `prepareValidation` / `runValidation`, all four raw owner results, exact source/profile binding and preserved cleanup | A new evidence-driven candidate for each owner |
| Successful candidate acceptance | The genuine model-authored candidate's exact head passes the qualified native gate and selected assertions | New authoring/publication when the operation was only deterministic replay |

Running unchanged tests for the other three owners during a proxy candidate replay
does not make those owners successful candidate E2Es. Likewise, a prepared job's
preallocated `session_id` is not proof that an SDK/model session started.

## Native ownership

The supported discovery and write scopes remain:

| Owner | Integration scope | Native test target |
| --- | --- | --- |
| `@augloop/session-protocol` | `server/session-protocol/test/integration-evolution` | `gulp test`: repository Gulp/Mocha/c8 and `server/test-config.json` JUnit reporter |
| `@augloop-utils/doclab-serialization` | `utils/doclab-serialization/tests` | `run -T jest`, owning `jest.config.js` |
| `@augloop-utils/eval-vnext-config-resolver` | `utils/eval-vnext-config-resolver/tests` | `run -T jest`, owning coverage exclusions |
| `@augloop-utils/excel-agent-in-container-proxy` | `utils/excel-agent-in-container-proxy/tests` | `run -T jest`, owning module mappings |

Only `*.integration.test.ts` and dedicated `fixtures/` paths are writable.
Unknown owners, production files, unit-only edits, deletions, and fixture-only
candidates are rejected. Discovery is not narrowed to the owner of an existing
candidate.

`augloop-integration.ps1` builds the union of these four explicit native targets
with `augloop build <packages...>`, never `--all` or `--no-dependencies`.
It then forces each owning `build`. Every validation run freshly rebuilds and
executes all four full package targets. This deliberately favors one auditable
shared preparation contract over separately claiming interchangeable owner caches.
All four mutable `dist` roots are actually rebuilt/tested; dependency roots and
other generated outputs remain under the existing immutable-output checks.
Toolchain fingerprint keys use the same ordered PowerShell hashtable convention
as OA/SDX: existing cache keys hash serialized bytes, not an unordered map.

Jest results and caches live outside the validation workspace. Mocha retains its
native reporter/configuration; the refreshed JUnit file is copied into durable
private artifacts. Every selected integration test must appear with nonzero
passing assertions. Native coverage/exit failures are not converted into success.
The native Mocha reporter omits individual pending cases unless configured
otherwise, but retains the aggregate pending count. The profile therefore rejects
any nonzero/malformed `skipped` aggregate, even when the remaining emitted cases
pass. Qualification reuse verifies the sealed validation artifact, owner results,
raw result hashes and original cache/configuration binding.

The Mocha policy is deliberately **whole-package zero pending** for Session
Protocol in both qualification and candidate validation, not only a selected-file
check. The pinned baseline satisfies that stronger contract. Historical pending
assertions on another revision would block qualification rather than be silently
grandfathered in; supporting them requires a separately reviewed owner contract.
Selected candidate files additionally require emitted nonempty passing assertions.
The installed reporter's omitted-pending XML is exercised directly against the
production aggregate guard, with an all-passing reporter output as a positive
control. Qualification reuse never treats newly recomputed hashes from a mutable
artifact as authority: its path/hash and exact owner proofs must match the sealed
qualification, including when raw results and their embedded hashes change together.

## Repository-wide discovery and recurring operation

`capabilities` inventories manifests matching the pinned root `package.json`
workspace patterns, plus tracked .NET/Rust project files. It reads exact Git blobs
in bounded batches, retaining manifest hashes and progress. It does not classify
every package with a similar script as supported. The four explicit native
contracts above are the minimum proving set; other Jest, Gulp/Mocha, .NET, Rust
and custom families are **discovered but unsupported/unqualified/unapproved**.
Adding a family requires actual owning runner/fixture/dependency/cleanup evidence,
an implemented native contract and separate write authorization. Changing a path
or copying a qualification bit is insufficient.

```json
{
  "templateConfig": "C:\\private\\al-native.local.json",
  "runDirectory": "C:\\private\\al-capabilities-001"
}
```

```powershell
node scripts\augloop.mjs capabilities C:\private\capabilities-request.json
```

An optional `qualification` content reference marks the supported rows qualified
only after the full sealed native proof passes. `candidateAccepted` is not inferred
from discovery or baseline qualification. Proposer routing also requires the
selected candidate's `definition.harness` to start with a repository-relative
test-harness path in a supported owner, followed optionally by descriptive text.
Include this requirement in new FILTER instructions. The gate accepts arbitrary
authorized integration-test changes in those owners, not just the original case.

### Inactive recurring configuration

Copy `scaffold/augloop.recurring.example.json` into private storage, fill its
content references and approved finite limits, and leave it disabled during
inspection. Collection must explicitly use `app-native`, and all three input
configurations must have scheduling disabled; an enabled legacy schedule is
rejected, not silently accepted as recurring authority.
The collector and FILTER configurations are separate from the
repository-native authoring/native template. Each cycle derives new isolated source/FILTER
configurations, including its exact window; historical configurations are never
modified. New cycles discard historical FILTER retry/cohort-retry instructions
and old authoring feedback; recovery reuses the original cycle instead.
`maxItems` / `maxCalls` apply to each selected source pass, so aggregate
source reservation is those limits multiplied by the number of passes. Each
enabled ADO/WorkIQ source requires both created and changed passes. Native recurring
IcM collection is unsupported and fails closed. Existing source adapters retain their actual configured
cohort boundaries; repository-wide code discovery does not authorize broader
ADO areas, WorkIQ locations or unsupported IcM execution.

The durable `stateDirectory` must remain the same across cycles. Its `sources`
ledger owns every one-shot collection intent/receipt, its `filter` ledger owns
native FILTER attempts, and its root ledger owns cycle cursors, evidence identity
and grant reservations. A new cycle copies its window-bound configuration, **not**
a fresh authoritative ledger. One-shot's required per-run isolated captured-source
storage is retained; it is not a replacement for shared control/history state.
Native `localFilter.maxRequests` continues to count the shared FILTER ledger;
configure its approved cumulative ceiling explicitly, never reset storage or
silently reinterpret it as a per-cycle allowance.

Worker
assignments use its `workers` subdirectory unless an explicitly approved absolute
`workerStateDirectory` is supplied. Use that interface to retain an existing native
worker ledger when onboarding earlier Drafts; do not discard its job/history
records or copy an active SQLite file without its consistent state. Existing
`Ledger.prepare` identity and prior-investigation guards prevent another job/PR
for the same work. Artifact roots remain stable across `prepare` and `propose`, so
receipt-directory changes do not silently change the qualified assignment contract.

Cadence is operator-owned and unset in the scaffold. The `cycle` command performs
one action per invocation using existing one-shot collection/FILTER/handoff APIs
and `Ledger` locks, operations, cursors and jobs. It installs no timer or scheduling
daemon. Do not point the legacy `tick` path at AL: that path has a different
review flow and a previously approved fixed schedule. An existing operator
scheduler may invoke this entrypoint only after cadence, identity, limits,
rehearsal and finite authorization are explicitly approved.
`scripts/Register-PilotTask.ps1` is the legacy `tick` registration helper, not
an AL app-native recurring launcher. Do not use it to claim this pipeline is
scheduled or to bypass the one-shot requirement that scheduling stays disabled.

Source-pin rotation is also explicit: after fetching the operator-approved
repository revision, create new configuration copies and native qualification,
then a newly pinned plan/grant. Never edit a live cycle's base or manufacture a
qualification for the latest branch. Keep the durable cursor and worker history.
The existing `prepareFilterBatches` contract still requires actual approved
grouping and material-sharing inputs; the operator/coordinator supplies those
stage requests. This adapter does not synthesize approvals or claim an unattended,
zero-configuration planner.

### Finite authorization and actions

A new recurring authorization is a separate file, for example:

```json
{
  "format": "al-recurring-authorization-v1",
  "planSha256": "SHA256_OF_FINAL_PRIVATE_RECURRING_PLAN",
  "approvedBy": "OPERATOR_AFTER_EXPLICIT_APPROVAL",
  "approvedAt": "EXPLICIT_APPROVAL_UTC_TIME",
  "expiresAt": "EXPLICIT_FUTURE_EXPIRY_UTC_TIME",
  "maxCycles": 2,
  "maxTotalModelSessions": 0,
  "maxTotalAiCredits": 0,
  "maxTotalDrafts": 0,
  "allowCollection": false,
  "allowModels": false,
  "allowPublication": false,
  "stopAfterFirstSuitableDraftPR": true
}
```

This example grants nothing. A past E2E authorization is rejected by format and
binding, and spare historical budget does not renew it. For future approved model
execution, the controller reserves the complete FILTER batch count and at most
one Proposer per cycle in the shared ledger before dispatch. Reservations are
conservative capacity holds, not claimed actual model starts, and are not
automatically refunded after an uncertain failure. Native session receipts remain
the source of actual usage. Model calls/tool use, commit, push and Draft creation
recheck the pinned expiry; SDK wait limits are bounded by remaining authorization
time. The 30-credit per-session limit remains soft, not a hard billing guarantee.

`maxTotalAiCredits` is a separate mandatory finite grant ceiling. Every reserved
model session holds its full 30-credit soft allowance against this cumulative
ceiling, independently of `maxTotalModelSessions`, per-cycle counts and Draft
limits. There is no inferred credit allowance for an older file that omits it.
The root ledger records the grant's counters and `active`, `stopped`, `expired`
or `exhausted` state. A first suitable Draft, explicit operator stop, or exhausted
reservation budget cannot be reset by restarting the CLI. No refund is inferred
from a failed or uncertain operation. Completed-cycle finalization and completed
native-stage reconciliation can perform zero-side-effect bookkeeping after expiry;
they cannot start source reads, models or publication.
`finish` retains the original pinned authorization and independently rechecks the
completed collection, original stage intents, batch/FILTER execution receipts,
sealed qualification and exact-head native publisher records. It does not renew
execution rights or rerun native validation. A published nonempty cycle can
therefore close after expiry; its next contiguous cycle requires a separately
valid finite grant. Missing or changed completed receipts remain blocked.
This exception does not extend to `observe-pr`: remote observation still needs
current authorization and explicit read approval. Use a separately approved
bounded read-only operator interface after execution expiry, never `finish`
as a remote-read or publication permission.

Each `cycle` request contains `plan` and, for execution, `authorization` content
references, plus `action`. Non-`begin` actions specify the returned `cycleId`.

| Action | Behavior |
| --- | --- |
| `inspect` | Checks configured repository bindings without source/model/publication calls; no activation |
| `begin` | Requires an enabled plan and current finite grant; reserves a new contiguous complete `window`, or defaults to the previous complete UTC day |
| `collect` | Calls original one-shot collection/resume and verifies the full immutable source receipt; an empty or entirely previously reviewed cohort completes without FILTER/models |
| `batch` | Takes a `stageRequest` reference using the normal batch fields and this cycle's complete source set / derived FILTER config |
| `filter` | Takes a normal FILTER `stageRequest`; reserves the full batch count before any request and requires complete native reconciliation |
| `prepare` / `propose` | Take normal handoff `stageRequest` references, the plan's qualified template and all cycle FILTER results; only `propose` can request existing native publication |
| `finish` | Advances the cursor only after complete review; a selected but unpublished candidate stays held rather than silently disappearing |
| `status` / `stop` | Inspect durable state or stop further actions; `collect` with `resume:true` may resume a stopped native collection under the same still-valid grant |
| `grant-status` / `stop-grant` | With the original authorization reference, inspect durable cumulative counters/remaining capacity or permanently stop further execution under that grant; these do not activate a schedule |
| `reconcile-stage` | Takes `stage`; recovers an already completed native terminal after an outer bookkeeping interruption, independently checking native FILTER/assignment/publisher evidence, with zero source/model/publication calls |
| `observe-pr` | Requires `readOnlyApproved:true`; observes the recorded Draft and required policies/builds using existing delegated ADO authentication; never queues, approves, pushes or merges |

Every stage's `runDirectory` is its cycle root plus the stage name. Use the returned
`collectorConfig`, `filterConfig`, `collection.snapshot.sources` and prior stage
result references; do not substitute another cycle's cohort or change its window.
New evidence is never pre-dropped from a mixed cohort: if any evidence is new, all
members still pass through complete-cohort FILTER. Deduplication keys preserve
native evidence identity and source revision. Cursors cannot jump over a missing
window; an explicit bounded catch-up window is required.
Finalization compares and swaps the expected cursor inside the same transaction
as evidence marks and cycle completion. A stale cycle cannot rewind or overwrite
newer progress, and a failed comparison leaves all three unchanged. Stopping a
terminal cycle is a no-op; `resume:true` cannot reopen it.
For a legacy record already changed from completed to `stopped` by an older
controller, stale `finish` still rejects. Explicit `reconcile-stage` with
`stage:"completion"` can restore only its completed bookkeeping state: it
independently verifies the original complete receipts, requires the existing
cursor to cover the old window and every evidence identity to be already reviewed,
and checks unchanged cycle/cursor state inside the transaction. It never writes
the cursor or dedup records, starts work, or renews the original expired grant.
After that recovery, a separately valid finite grant can admit the next contiguous
cycle. Missing coverage, missing receipts or unreviewed evidence remain blocked.

Before another prepare/Proposer reservation, AL also checks earlier cycles using
the **existing native FILTER key**: exact repository, source revision, layer and
missing assertion. A match is held with references to the earlier FILTER and
handoff, even when the new cohort has different evidence roots. This is not
universal semantic deduplication and does not silently classify a changed
assertion or revision as already fixed. Existing native investigation/assignment
uniqueness remains authoritative for the same issue. Duplicate holds require
current source/fix/PR reconciliation rather than another PR or an automatic
cursor advance. A separately reviewed `existingFixesReview` content reference
can be supplied to normal `prepare`/`propose`; it is passed unchanged to the
existing handoff/coverage-review contract, which rejects covered, in-flight or
unresolved fixes. Such a review does not override the recurring duplicate hold.

Only one cycle owns the existing coordinator lock. A stale lock is not stolen:
use the existing owner/PID-aware recovery procedure after proving its process is
gone. A failed source-only cycle can have an explicit `begin` successor using the
same window, `predecessor`, `recoveryApproved:true` and a concrete `reason`, within
the current grant's remaining cycle allowance. Both attempts remain recorded.
This is refused if any model/publication reservation exists. Such work requires
the existing native reconciliation/diagnostic/continuation interfaces and a
separately authorized recovery; never reset the operation or silently relaunch it.
`reconcile-stage` can run after expiry because it only verifies already completed
work. It cannot reconstruct a missing terminal or turn a failed native result into
success. A genuinely failed or uncertain model stage remains held for its native
diagnostic/continuation procedure; the recurring wrapper is not an automatic
authoring-retry engine.

Tracked-open refresh is an explicitly external **existing-controller interface**,
not a new AL source implementation: invoke
`src/revisit.js#revisitTracked(config, workerLedger)` using the same approved
identity/source scopes, `schedule.changedEvidencePolicy:
"tracked-open-and-area-changed"` and separately approved finite
`limits.maxItems` / `limits.maxCalls`. Hold the recurring state's `coordinator`
lock while refreshing its configured worker ledger. The native helper records
`runs`, `observations` and `tracked_state`; partial/blocked results require an
operator hold, and `reconciliation-required` is never cleared by writing a
success-shaped receipt. Include this refresh in the operator's cycle procedure
even when the newly collected cohort is empty. The AL `cycle` command itself
collects created/area-changed evidence; it does not silently perform or budget
these additional tracked-open reads. No tracked-refresh cadence or authority is
enabled by this scaffold.

The PR observer checks current Draft/head/target identity, required policy
evaluations and their exact `refs/pull/<id>/merge` builds, then re-reads the head.
A changed head, partial policy response or unknown build context is not green.
AI/human comment adjudication and policy queueing remain an explicitly external
operator interface: supply the observer's exact PR/head/merge context to the
existing ADO policy/review tools and obtain a fresh observation after changes.
No observation grants merge permission. No live CI polling or publishing schedule
is activated by this adapter.

### Dry-run-first deployment

First run `capabilities`, real native `qualify`, and `cycle` with `action:"inspect"`.
Next, under a new short-lived **collection-only** grant, enable the private plan
and manually exercise `begin`, `collect`, `status` and a second contiguous cycle.
Native `dryRun:true` isolates collection storage; it still performs authenticated
source reads and is **not** a no-network simulation. Keep model/publication flags
false for that rehearsal. A held nonempty cohort is expected, not automatic
permission to start FILTER. Any later model/publishing grant and operator cadence
must be explicit, finite and source-bound; never edit the old authorization file
or reset durable state to simulate a clean cycle.

## Preparation and backend qualification

Prerequisites:

- A clean AL reference checkout at an explicit commit, with its native Node version
  and checked-in Yarn release available. Prefix the matching Node directory in
  `PATH` for **each** shell; do not rely on another shell's activation.
- An ordinary private controller configuration with one AL repository, its exact
  remote/base, and the merged repository-native integration skill. The exact base
  must contain the skill and companion; Git blob and SHA-256 verification applies.
  `scaffold/augloop.repository.example.json` supplies the disabled repository
  entry; fill its private path/identity placeholders without enabling publication.
- PowerShell 7 as the configured gate executable; native AL CLI and the pinned
  `artifacts-npm-credprovider` prerequisite. The profile checks the exact single
  AugmentationLoop registry, not OfficeAgent's additional Office feed.
- A fresh absolute run directory and a private `TEMP`/`TMP` directory. Do not use
  or remove another run's cache. Shared old Git object stores must remain intact.

## Creating and rebinding private configuration

This is a reproducible **configured** entrypoint, not a zero-configuration
fresh-clone promise. Keep private configuration, identity, authorizations, source
captures and runtime receipts out of tracked files. The repository scaffold is a
fragment, not a complete runtime configuration.

1. Copy the root `pilot.example.json` to a new ignored private configuration.
   It is the version-1 runtime example; `scaffold/configuration.template.json` is
   a different planning contract and is not a substitute. Replace the complete
   `repositories` array with one entry from
   `scaffold/augloop.repository.example.json`. Do not carry over another
   repository's sparse checkout, changefile, environment or authentication setup.
2. Set the private delegated identity, approved state storage/retention, approved
   numeric limits, `workerIntent: "improvement"`, checkout, exact base commit and
   owner. Keep one worker and one worker per repository. Keep collect/review/
   dispatch, routing, skill execution, publication and isolation disabled in the
   input template; the authorized stages construct their own bounded configs.
   Native approval and later qualification must not be inferred from copied flags.
3. Rebind `validationGates[0].profilePath` **relative to the new configuration
   file's directory**, not relative to the repository fragment. Keep that input
   config on the controller's volume so the path can remain relative. Compute
   `profileSha256` from the actual profile bytes and set the installed PowerShell 7
   executable. Do not retain a stale example hash after changing the profile.
4. Retain the default repository-native `skillPath`:
   `utils/excel-agent-in-container-proxy/.github/skills/excel-agent-in-container-proxy-integration-tests/SKILL.md`
   (name `excel-agent-in-container-proxy-integration-tests`). Explicitly invoke
   that name or path in the task; controller authoring and repair prompts name
   the configured path. Its companion is `references/suites.md` under the same
   directory, read with normal repository-relative `pilot_read` in the pinned
   product workspace. No root registration or `skill-bundle:` alias is needed.
   Qualify a new exact product base containing both files; an old baseline
   without this path cannot qualify it. Do not infer qualification from the merge.
   Historical runs/replay may retain their explicitly pinned `externalBundle`,
   original source Git objects and exact manifest bytes outside the product.
   Do not rewrite their receipts or implicitly fall back to old paths/bundles.
5. Bind `runtime.cliPath`, the native Node/Yarn/AL CLI prerequisites and private
   `TEMP`/`TMP`. Do not copy tokens into JSON. For model-bearing workflows,
   `runtime.authoringModel` is explicitly `gpt-6-luna` and the approved per-session
   ceiling is 30 credits, still soft. These settings do not override the stop rule.
6. Build a separate FILTER configuration for any separately authorized new cohort:
   `filterExecutor: "local-sdk"`, verified `filterBatching`, exact tokenizer/counter
   executable and file hashes, model-catalog/verification references, and
   `localFilter.sources` pinned to the same AL repository/base. Its binding uses
   native-main `.github/skills/tests/SKILL.md`, has no `externalBundle`, and cannot
   authorize authoring. Keep all four paths in the actual decision instructions.
   For historical reconciliation, use the original completed FILTER config instead.
   `prepare` and `propose` bind only that hash-pinned, completely reconciled
   FILTER configuration's `filterBatching` budget into the native handoff; the
   native template need not duplicate it. An explicitly approved template budget
   must validate against the same original manifest or the stage fails closed.
   This does not copy FILTER execution, source collection or skill permissions,
   authorize a new cohort, or weaken source, manifest, evidence, budget receipt,
   complete-cohort, native qualification or publication-authorization checks.

For example, calculate the two profile fields from the controller root without
modifying any completed configuration:

```powershell
$configFile = 'C:\private\al-native.local.json'
$profile = (Resolve-Path .\scripts\validation\augloop-integration.ps1).Path
[IO.Path]::GetRelativePath((Split-Path $configFile -Parent), $profile)
(Get-FileHash -LiteralPath $profile -Algorithm SHA256).Hash.ToLowerInvariant()
```

Generated `config.json` / `proposer-config.json` are resolved execution receipts,
not portable template files: their resolved absolute profile paths must not be
fed blindly back into `configAt`, which requires a relative profile path in an
input config. Create/rebind a new private input copy; never patch a completed
receipt to make it load.

### Required private inputs and references

| Purpose | Required material and binding |
| --- | --- |
| Native qualification | Complete private native template, approved fresh run request, exact AL checkout/base containing the merged skill and companion, installed native tools |
| Original FILTER reconciliation | Original FILTER config and its execution ledger; original manifest and every completed result; all captured source ledgers/run IDs referenced by the manifest |
| Exact batching for a separately authorized new cohort | Collector config/request/result and source ledger; batch request with all-four instructions, grouping/sharing approvals; verified tokenizer executable/files, verification receipt and model-catalog evidence |
| Qualified handoff | Original FILTER references plus the native template and successful qualification result, each with exact file SHA-256 and matching source base; the configured skill is requalified under the new gate |
| Original-candidate replay | Successful qualification result, original genuine E2E/model-result receipt and clean original-candidate checkout at the recorded authored head |
| Native continuation | Original/next private configs, original proposal, assignment ID and explicit source-bound zero-model continuation authorization; no additional publication permission is implied |

Use the exact `request.json` and content references retained by a completed stage
as an inventory, not as a license to overwrite its run directory. Native
`qualify`/`replay` take a template filename; workflow `prepare`/`propose` take a
`{path,sha256}` template reference. After creating a **new** input copy, hash its
final bytes and bind that reference in the new request. A content reference can be
formed with an absolute `(Resolve-Path ...)` result and lowercase `Get-FileHash`.

Preserve original FILTER config/ledger paths for historical execution
reconciliation. Moving a completed bundle by search-and-replacing paths, adjusting
hashes, or relabeling receipts is not supported migration. Retain its original
locations or use a separately audited migration; otherwise fail closed. Native
qualification also references its config, cache and raw results, so keep those
available for replay. A source/profile/runner change needs new qualification, not
an edited success receipt.

## Executing backend qualification

The native request uses a **configuration filename**:

```json
{
  "templateConfig": "C:\\private\\pilot.local.json",
  "runDirectory": "C:\\private\\al-qualification-001",
  "nativeExecutionApproved": true,
  "authenticationRemediationApproved": true
}
```

```powershell
$env:PATH = 'C:\approved-node-directory;' + $env:PATH
$env:TEMP = 'C:\private\controller-temp'
$env:TMP = $env:TEMP
node scripts\augloop.mjs qualify C:\private\qualification-request.json
```

Qualification disables collection, dispatch, skill execution and publication.
Fresh configurations discard historical per-attempt authoring feedback from the
template; an old repair instruction is not authority for a new candidate.
Native execution approval is distinct from `isolationVerified`, which remains
false in the qualification config. Only a passing `prepareValidation` /
`runValidation` artifact, intact raw results for **all four owners**, and passing
immutable-output cleanup produce `qualified-native-backend`.

This exercises real isolated preparation and existing baseline tests. It is
**not** fresh evidence, model authoring, a candidate E2E, or another Draft PR.
The qualification's source/profile pins must match before a later candidate
configuration can enable isolation.

Authentication uses the existing `preflightValidationAuthentication` and
`validationAuthAction` single-feed remediation. The returned native setup command
runs through `nativeCommand` on Windows, not raw `execFile('npm')`.
Provider validation uses the same neutral working-directory mechanism as OA setup;
checking the same config from inside a full repository can otherwise disagree with
the authentication-only checkout. The provider evaluates both npmrc and Yarn clients;
an explicit config overrides only the matching filename, so repository cwd can
activate additional ambient `.npmrc` registries. Credentials are neither requested from the model
nor written into receipts. Remediation is bounded to one attempt followed by recheck.

Each native command retains its gate timeout. Preparation/hash stages are not
included in `workerMinutes`; that is a model-runtime limit, not a whole-run SLA.
Inspect `progress.json`, `preparation.json`, `validation.json`, `result.json` or
`failure.json`. A failed run is not restarted by reusing its directory.
The existing controller diagnostics channel is also retained as append-only
`native-progress.ndjson` and a latest `native-subphase.json`: copy, link rebase,
fingerprint task counts and observer failures are distinct from the outer stage.

## Original-candidate replay

`replay` takes the native request fields above plus:

```json
{
  "qualification": {
    "path": "C:\\private\\al-qualification-001\\result.json",
    "sha256": "SHA256_OF_QUALIFICATION_RESULT"
  },
  "originalCandidate": {
    "path": "C:\\private\\original-e2e-terminal.json",
    "sha256": "SHA256_OF_ORIGINAL_GENUINE_TERMINAL"
  },
  "candidateCheckout": "C:\\private\\clean-original-candidate-checkout"
}
```

Use a new `runDirectory`. The candidate checkout must already be clean at the
original model-authored head. Its base, changed paths, evidence references and
successful skill result must match the original receipt, including any explicitly
pinned historical external bundle. The runner uses
the existing verified preparation/cache flow and fresh exact-head native checks;
it neither reconstructs tests nor commits, pushes or creates a PR.

The native artifact/raw results are new **deterministic replay** evidence.
The original FILTER, model, PR and historical failures remain original evidence.

### Sparse native preparation

When using explicit `sparseCheckoutPaths`, choose a read-only source closure for
the exact approved product revision, not just the four test write prefixes.
Include the native build tooling, source workspace dependencies, postinstall
scripts, test fixtures/configuration and the merged authoring skill with its
companion. Missing source dependencies or legacy test resources remain blockers;
do not replace full owner tests with selected tests to avoid them.

The controller propagates the explicit paths to dependency and compile clones.
Dependency/compile cache reuse is bound to the effective explicit path set;
changing that set requires new preparation rather than reusing a full or
differently pruned install. Reordering or repeating the same paths does not
invalidate the cache. Existing declarative `sparseCheckout` handling takes
precedence when configured.

Finalize the source closure before qualification. If an install already exists,
adding sparse directories is not proof that its dependencies have been relinked;
use native preparation for the new path set. Treat a resulting cache miss as
expected, retaining the old snapshots and original receipts. A larger read-only
source closure grants no additional test or production write permission.

The native sparse plugin derives local lockfiles, so sparse dependency installs
use `--no-immutable`; full checkouts retain `--immutable`. At every cleanliness
boundary, tracked root `Cargo.toml` and `Cargo.lock` are renormalized through
their configured Git filters in sparse mode before checking the entire index,
worktree and untracked files. This is not a reset or permission to edit manifests:
unfiltered Cargo edits, other source edits and untracked files still block.
Committed input blobs must remain unchanged.

An unset or false `core.sparseCheckout` selects the full-checkout immutable
contract. The profile does not install arbitrary clean filters: use the product's
native plugin/filter setup. For remaining dirty files, inspect
`git diff --name-only`, `git diff --cached --name-only`,
`git status --porcelain --untracked-files=all` and
`git check-attr filter -- yarn.lock Cargo.toml Cargo.lock` in the disposable
workspace. Do not reset source, add exclusions or invent filters to hide changes.

Changing this native profile requires a newly computed private `profileSha256`
and fresh exact-base native qualification. Preserve old qualifications and run
receipts; do not rewrite their pins or reuse them as proof for the new profile.

## Collection, FILTER and genuine handoff

Workflow stages use content references for input files:

```json
{ "path": "C:\\private\\input.json", "sha256": "SHA256_OF_EXACT_FILE_BYTES" }
```

All stages require a new absolute `runDirectory`. Their complete request and
terminal output are preserved there. The following are stage-specific fields:

| Stage | Required inputs and behavior |
| --- | --- |
| `collect` | `collectorConfig`, `collectionRequest`, `liveCollectionApproved:true`. Calls existing `beginOneShotCollection` / `advanceOneShotCollection` with their real approved source limits, identity and deadline. |
| `batch` | `filterConfig`, `batchRequest`. Calls existing `prepareFilterBatches`, including exact configured tokenizer, material-sharing approvals, grouping review, complete records and cohort accounting. |
| `filter` | `filterConfig`, `manifest`, `modelAllocation`. Runs all manifest batches with real `executeLocalFilterBatch`; incomplete/blocked batches stop selection. No automatic retries. |
| `reconcile` | `filterConfig`, `manifest`, `results` (array of references). Reopens the **original** FILTER ledger read-only and calls `reconcileFilterExecutionCohort`. No model session. |
| `prepare` | Reconciliation inputs plus `templateConfig` and `qualification` references. Reconciles original FILTER, requalifies the configured skill against the pinned base and native contract and calls genuine `acceptFilterProposerHandoff` in prepare-only mode. |
| `propose` | Prepare inputs plus `modelAllocation` and explicit `authorizeCommit`, `authorizePush`, `authorizeDraftPR`, all true. Uses the existing worker and exact-clean-head native publisher; no custom publisher callback. |
| `continue` | `previousConfig`, `nextConfig`, `authorization`, `originalProposal` references and `assignmentId`. Uses the existing source-bound `native-jest-cache-isolation` continuation only, with `maxModelAttempts:0`. `execute:true` additionally requires all three side-effect authorizations. |

For the selected candidate, `definition.harness` must start with an explicit
repository-relative path under one of the four supported owners' test directories.
Whitespace, `:` or `;` may separate that path from a human-readable explanation.
The accompanying `repository`, exact `sourceRevision` and `layer:"integration"`
must still match the qualified repository; unsupported owners and traversal
remain blocked. An explanation is not a fallback owner selector.

Before Proposer dispatch, authentication is checked again rather than assuming a
prior backend qualification means credentials are still valid. Set
`authenticationRemediationApproved:true` explicitly to permit the same bounded
single-feed remediation used by qualification; otherwise a required refresh
blocks before authoring. The pinned model allocation remains bound to the runtime
after this preflight: native preparation/workspace setup cannot outlive its deadline
and then start a model. Creation and submission recheck authority, SDK wait time is
capped by its remaining lifetime, and tool/commit/push/Draft boundaries recheck it.
Native continuation does not acquire new authentication authority.
This uses the existing forced-preflight option: a dependency-cache hit must not
silently substitute for the requested credential check.

The original FILTER configuration remains separate from the Proposer configuration.
FILTER reads native-main `.github/skills/tests/SKILL.md`, not `skill-bundle:`.
Its actual decision instructions must retain all four discovery paths. Proposer
uses the separately qualified merged repository-native authoring path through
**`copilot-sdk` only**. Historical external bindings remain explicit opt-ins, not
the default or a fallback. A missing/wrong native path or source/hash drift blocks.
The binding migration grants no new model, remote or publication capability.
Agency local, Agency remote and unknown authoring providers are rejected before AL
allocation/dispatch; no model-pin or deadline equivalence is claimed for them.
Do not transplant completed config
files or rewrite their receipts to make reconciliation pass.

For an explicitly configured bounded successor, `filter` accepts `retainedResults`
(content references). Each must independently match a completed original native
batch receipt before it can be reused. Only the remaining batches reserve/open new
sessions; their retry lineage still passes through the existing local FILTER
contract. If all batches are retained, the operation is read-only reconciliation,
needs no model allocation, and is explicitly labeled as such.

Collection and batching requests are the existing controller contracts, not
synthetic source records. Their grouping/sharing decisions still need actual
review/authorization. The entrypoint does not invent a coverage gap when a complete
cohort has no candidate. A prepared assignment is not a model execution or a PR.

### Zero-model recovery of a committed native Git transfer failure

Reusable native validation fetches a test-only candidate with the verified
prepared base as `--negotiation-tip`, after checking that base is its ancestor.
This bounds local partial/promisor negotiation to the candidate change instead
of requiring unrelated promised history. It does not weaken checkout, native
policy/tests, source cleanliness, profile pins or prepared-output verification.

If an original authored commit is already blocked **before checkout**, do not
rerun `propose`, change the test or relabel the failure as Jest-cache isolation.
An audited private caller can use the existing `resumeCommittedValidation`
export from `src/workers.js` with the same ledger and assignment:

```js
await resumeCommittedValidation(config, ledger, assignmentId, {
  kind: 'native-git-revision-transfer',
  priorResultId, sourceRevision, proposal, files, validationArtifact, authorization
});
```

`proposal` must preserve the latest worker result's findings and finalized
`skillExecution`. `files` is the exact committed changed-file population as
`{path, sha256}` entries, including any already-created controller changefile.
`validationArtifact` and `authorization` are absolute path/exact-byte SHA-256
references. Keep the original failed artifact and worker result unchanged.

The referenced authorization requires all of the following:

- `approved:true`, `authorizedBy:"user"`, `kind:"native-git-revision-transfer"`,
  `approvedAt` and a future `expiresAt`;
- exact `assignmentId`, `priorResultId`, `baseRevision`, `sourceRevision`;
- `maxModelAttempts:0`, `maxValidationAttempts:1`, `allowSourceChanges:false`,
  `allowCommit:false`, `allowPush:true`, `allowDraftPR:true`, `allowMerge:false`;
- `configuration` (a pinned resolved config JSON), `configurationSha256`,
  `proposalSha256`, `filesSha256`, and the exact `validationArtifact` reference;
- `controllerSource` (a pin to the executing controller's `src/workers.js`) and
  `diagnostic` (a pin to the observed proof below).

Object digests use `hash(json(value))` from `src/common.js`; file pins hash exact
bytes. Both `maxValidationRepairRounds` and
`maxValidationInfrastructureRetries` must remain zero. This authority does not
replace ordinary source eligibility, skill qualification, execution authority,
authentication or push/Draft permission checks. It never authorizes a model,
another commit, source edits, publication of a Draft, or merge.

The pinned diagnostic has `format:"native-git-revision-transfer-proof-v1"`,
`assignmentId`, `priorResultId`, `baseRevision`, `sourceRevision`,
`configurationSha256`, `profileSha256`, `validationArtifact`, `observedAt`, and
`preparedReceipt` (an exact-byte pin to the original compile receipt).
Its `dryRun` records the actual `executable:"git"`, `cwd` (the receipt's sibling
`w` directory), `exitCode:0`, `stdout`, `stderr`, and this exact argument array:

```js
['fetch', '--dry-run', '--no-tags', `--negotiation-tip=${baseRevision}`,
 '--', originalWorkerWorkspace, sourceRevision]
```

Retain genuine diagnostic observations; never manufacture a successful proof.
Git fetch `--dry-run` can still populate objects, so it is not a promise of
filesystem immutability. Recovery verifies the pinned observation rather than
silently rerunning that diagnostic.

Admission accepts only one original completed model round/result and one clean,
unpublished, single-parent authored commit. The original failure must be
`blocked` / `validation-workspace-unavailable`, with only sanitized inspection
error output, no native artifacts, the complete reuse timing prefix, no
checkout/policy/test timing, and preserved-cache cleanup. Changed inputs,
executed native tests, prior push/Draft operations or a second recovery result
fail closed. Recovery uses a separate validation-attempt namespace, preserves
the original artifact, and runs the full configured native gates at the exact
original commit before any existing Draft publication path can proceed. The
source, pins and unexpired recovery authority are rechecked after validation,
before push.

This pre-checkout transfer recovery is not a publish-only resume operation.
If native validation passed but push/Draft creation failed, retain the exact
commit, passing proofs and original failure, and reconcile remote branch/PR
effects before any separately authorized recovery. Do not rerun authoring or
mislabel the failure as Jest-cache isolation to retry publication.

## Model accounting

No model allocation is needed for native qualification, reconciliation, prepare-only
handoff or original-candidate replay.

The current AL `propose` entrypoint reserves one session and forces
`maxValidationRepairRounds:0` in its generated configuration. Raising that limit
in the input template or reserving spare sessions does not enable automatic
authoring repair. A failed attempt remains preserved; any successor needs its
own supported contract and explicit, finite authority.

Before using `filter` or `propose`, coordinate the proposed count/purpose with
the parent and provide a content-pinned allocation:

```json
{
  "format": "al-e2e-model-allocation-v1",
  "approvedBy": "parent",
  "model": "gpt-6-luna",
  "repoId": "augloop-workflows",
  "baseRevision": "REPLACE_WITH_APPROVED_FULL_40_CHARACTER_SOURCE_SHA",
  "runDirectory": "C:\\private\\exact-new-model-stage",
  "maxTotalSessions": 30,
  "priorActualSessions": 12,
  "maxAdditionalSessions": 1,
  "purposes": ["proposer"],
  "allowPublication": true,
  "deadlineAt": "EXPLICIT_FUTURE_UTC_DEADLINE"
}
```

This example is **not** approval. The actual prior count and remaining allocation
must come from the parent, including any children. The entrypoint reserves before
calls, rechecks the deadline before each FILTER batch, records launch intent, and
retains native session/terminal receipts. The runtime re-reads the hash-pinned
allocation at execution boundaries, binding repository, source, stage directory,
purpose, model and finite deadline. FILTER authority cannot publish; Proposer
publication additionally requires `allowPublication:true` and all three explicit
request side-effect flags. Older standalone allocations lacking these explicit
fields must be newly approved and pinned, not silently upgraded.
A reservation or failed preflight is not
an actual model session. Interruption requires reconciliation, not a hidden retry.
The 30-credit per-session setting remains a **soft** ceiling; do not claim hard
enforcement or erase earlier overshoots.

## Source basis and regression checks

- OA `scripts/validation/office-agent-excel-entry-model.ps1` and
  `prepare-office-agent-auth.ps1`: staged native contract, provider setup, neutral
  credential-provider cwd and check-vs-remediate separation.
- SDX `scripts/validation/1js-sdx-excel-integration.ps1` and
  `scaffold/1js-sdx.repository.example.json`: explicit owning runner, selected-test
  discovery, disabled-by-default configuration, sparse/native preparation rather
  than bypassing the controller.
- `src/workers.js`: `prepareValidation`, `runValidation`, immutable output guards
  and qualified `testRebuiltOutputPaths`; `src/local-continuation.js`: predecessor
  and source-preserving continuation.
- AL's pinned root `AGENTS.md`, owning package scripts/configurations, and
  `@augloop-tooling/gulp-tasks/src/mocha-test-utils/test.js`: authoritative native
  build, full-package test and Mocha/JUnit behavior. `source-contracts.json` records
  the actual revision and material hashes used by a run.

```powershell
node --test test\al-adapter.test.js test\al-native-skill.test.js test\al-recurring.test.js test\al-workflow.test.js test\validation-auth.test.js test\sdx-adapter.test.js
node --test test\filter-batches.test.js test\local-filter-evidence-pages.test.js test\local-jest-cache-continuation.test.js
node --test --test-name-pattern="staged native preparation preserves explicit sparse|explicit sparse path changes invalidate" test\pilot.test.js
```

These controller regressions do not replace actual native qualification/replay.
For complete controller CI, including the hosted account-budget fallback, follow
the [full local CI procedure](../../README.md#local-ci-when-hosted-actions-is-budget-blocked);
focused selectors are not a complete-CI claim.
Only a run's authoritative passing terminal and raw owner results establish its
outcome. Remote CI/review remains separate and must be reported from remote receipts.
