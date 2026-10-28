# AL Agentic Loop Setup and Operations Guide

> For colleagues setting up or rerunning the AugLoop (`augloop-workflows`) agentic loop.
> Platform: Windows. The controller requires Node.js 24 or later.
> Commands and contracts reviewed on 2026-10-28 against the AL adapter in this checkout.
> This is an operating guide, not a run handoff, execution authorization, or proof of success.

This guide follows the structure of the
[SDX operating guide at the requested revision](https://github.com/zhenhuangMSFT/periodic-evidence-agent/blob/99a2e1773b338cfb010245221c5121cf232e23e2/scaffold/SDX-AGENTIC-LOOP.md),
but uses AL's actual entrypoint and contracts. Do not substitute AL names into
SDX commands: the orchestration, skill binding, native runners and recovery
interfaces differ. The detailed AL contract is
[scripts/validation/AUGLOOP.md](../scripts/validation/AUGLOOP.md).

## 1. Define the intended outcome

A complete evidence-to-Draft-PR E2E run means:

```text
Approved collection of real evidence
  -> Complete cohort, exact batching and source-grounded FILTER
  -> Eligible candidate routed to an authorized AL integration-test owner
  -> Separately qualified authoring skill used in an isolated workspace
  -> Native policy and tests on the exact candidate commit
  -> Authorized commit, push and Draft PR creation
  -> Independent PR/head/file and required remote-validation follow-through
```

This is not a live Excel/BizChat deployment or browser UI E2E procedure. Product
integration tests can use mocks; disclose their actual boundaries. A coverage-gap
test PR does not establish a production fix. Do not automatically merge or
auto-complete the product PR.

### Choose the appropriate operation

| Requirement | Entry point | Boundary |
| --- | --- | --- |
| Inspect repository capabilities | `node scripts\augloop.mjs capabilities <request.json>` | Discovery does not qualify or authorize every discovered module. |
| Qualify the native backend | `node scripts\augloop.mjs qualify <request.json>` | Real native baseline execution, not evidence collection or model authoring. |
| Run fresh evidence through the stages | `collect`, `batch`, `filter`, `reconcile`, `prepare`, `propose` on the same script | Explicit stage requests, source receipts and permissions are required. |
| Repeat bounded windows with durable coordination | `node scripts\augloop.mjs cycle <request.json>` | One action per invocation; operator-owned triggering, not an installed scheduler. |
| Reuse an existing completed FILTER cohort | `reconcile`, then `prepare` | Requires original execution ledgers and receipts; prepare-only creates no model session or PR. |
| Recheck the original authored candidate | `replay` | Exact-head deterministic native replay, not a fresh candidate or new publication. |

For a first setup, complete sections 2-6 before invoking live stages in section 7.
Use section 8 for retained evidence or recovery. Keep existing run state separate
from a fresh attempt.

Do not use legacy `tick`, `scripts\Register-PilotTask.ps1`, or SDX's shared-loop
commands as substitutes for this AL path. This guide does not qualify AL through
the separate `local-e2e` or shared manual/scheduled loop adapters. Nor does it
claim evaluated RSI or autonomous improvement; those require their own contracts
and evidence.

## 2. Prerequisites

| Check | Requirement |
| --- | --- |
| Controller | An approved revision containing `scripts\augloop.mjs`, its AL modules, examples and native profile. Do not assume these changes are on the remote default branch. |
| Tools | Git, Node.js 24+, npm, PowerShell 7, and the Node/Yarn/AL CLI tools required by the pinned product checkout. |
| Product source | Authorized access to `augloop-workflows`, a clean trusted reference checkout, and an approved full 40-character base revision. |
| Skill | The merged repository-native authoring skill at the exact approved product base; see section 4. |
| Identity | The real designated collector identity, tenant and approved source scopes/window in private configuration. |
| Model | Authenticated access to the model required by the current AL allocation contract, with verified tokenizer/context settings. |
| Native authentication | The pinned Azure Artifacts credential provider and access to the declared AugmentationLoop package feed. |
| Publication | Separate authorization for product commit, push and Draft PR creation. Controller GitHub access is not product ADO authorization. |
| Storage | An approved private durable state root, sufficient native-cache space, and access/retention policy. |
| Limits | Explicit finite source, model/session/credit, tool, time, byte/token and publication limits. |

The current adapter explicitly requires `gpt-6-luna` for model allocations and
uses a 30-credit **soft** per-session allowance. These are implementation
constraints, not suggested values to copy from a past run. If that model is no
longer available, stop and update/requalify the contract; do not silently select
another model. The standalone E2E allocation additionally enforces a 30-session
total ceiling, including prior actual sessions. A recurring grant has its own
explicit finite cumulative limits.

Check GitHub, ADO, package-feed and model authentication separately. Use approved
interactive sign-in/MFA when needed; never put tokens, device codes or credential
files in configuration or documentation.

Keep Node 24+ for the controller. Select the pinned product toolchain through
the native execution environment without downgrading the controller. Do not
replace the checked-in Yarn release with an arbitrary global Yarn installation.

## 3. Create the controller checkout and private configuration

Use replaceable, nonpersonal paths. Never clone over an existing run:

```powershell
$Controller = 'C:\src\periodic-evidence-agent'
if (Test-Path $Controller) { throw 'Choose a new controller directory' }
git clone https://github.com/zhenhuangMSFT/periodic-evidence-agent.git $Controller
if ($LASTEXITCODE -ne 0) { throw 'Controller clone failed' }
Set-Location $Controller
git rev-parse HEAD

if (-not (Test-Path '.\scripts\augloop.mjs')) {
    throw 'Select the approved AL-enabled controller revision before continuing'
}
foreach ($name in @('collector.local.json', 'filter.local.json', 'al-native.local.json')) {
    if (Test-Path $name) { throw "Refusing to overwrite $name" }
    Copy-Item '.\pilot.example.json' $name
}
```

Record and confirm the approved controller revision, not just the presence of
the script. Select a different revision only in a new, unused checkout.
Complete sections 4-5 before running:

```powershell
npm run setup -- --config .\al-native.local.json --repo augloop-workflows
```

Setup installs locked controller dependencies, initializes/checks the reference
repository, performs read-only skill qualification and diagnostics, and runs
offline checks and a synthetic demo. It does not install product dependencies,
sign in, establish native isolation, enable publication, or create a product PR.
See [AGENTS.md](../AGENTS.md) for the setup and authentication rules.

Approve the exact remote and location before using `--allow-clone` for a missing
product checkout. The approved base must contain the merged skill and its
companion. Historical external-bundle runs additionally need their original
source Git objects and exact bundle bytes; copying files alone is insufficient
provenance.

Do not transplant `.git`, active SQLite files or another person's private runtime.
If a checkout borrows Git objects from another clone, retain that object store.
Reuse existing trusted dependencies rather than reinstalling on every invocation.

## 4. Configure AL and its two different skill roles

Replace the private native template's `repositories` array with the single
entry from [augloop.repository.example.json](augloop.repository.example.json).
It is a repository fragment, not a complete runtime configuration.

| Field or contract | Configuration for this run |
| --- | --- |
| Repository | `id: augloop-workflows`, exact remote, approved owner and routing. |
| Source | Absolute `referenceCheckout` and full approved `baseRef`; all FILTER/native bindings must agree. |
| Execution | Local execution, local Proposer flight and local qualification refresh. |
| Authoring skill | Binding `al-integration-test-authoring`, capability `integration-test-authoring`, with the merged repository-native path below and no default `externalBundle`. |
| Write scope | Only supported `*.integration.test.ts` paths and dedicated fixtures; no production edits, deletions, unit-only or fixture-only candidates. |
| Native gate | Actual executable, timeout, relative profile path and SHA; do not set `isolationVerified` merely because setup passed. |
| Publication | Approved identity, branch prefix and target, `draftOnly: true`; side effects remain disabled until authorized execution. |

The supported native owners are:

| Owner | Integration discovery/write scope | Native runner |
| --- | --- | --- |
| `server/session-protocol` | `server/session-protocol/test/integration-evolution` | Repository Gulp/Mocha/c8 with native JUnit output |
| `utils/doclab-serialization` | `utils/doclab-serialization/tests` | Owning Jest configuration |
| `utils/eval-vnext-config-resolver` | `utils/eval-vnext-config-resolver/tests` | Owning Jest configuration |
| `utils/excel-agent-in-container-proxy` | `utils/excel-agent-in-container-proxy/tests` | Owning Jest configuration |

The gate rebuilds and tests all four owning package targets. Dependency and
other generated outputs retain immutable-output checks. AL does not inherit
SDX's behavior-card/changefile requirements or write permissions.

For an explicit sparse checkout, include the exact revision's read-only build,
dependency, fixture and skill closure, not just these test write scopes. The
controller preserves that path set through native preparation and binds its
caches to it. Sparse installs follow the product's derived-lock contract; full
checkouts remain immutable. See
[Sparse native preparation](../scripts/validation/AUGLOOP.md#sparse-native-preparation).
Changing the native profile requires fresh qualification, not rebinding old
receipts to its new hash.

Finalize the source closure before qualification. A changed explicit path set
causes new dependency/compile preparation; this expected cache miss is not a
reason to edit receipts or delete old snapshots. Adding read-only source paths
does not expand the four allowed test write scopes.

`capabilities` inventories other workspace and .NET/Rust project families.
Those remain unsupported/unqualified/unapproved unless a real native contract,
qualification and write authorization are added. A similar script name is not
proof that another package can use these gates.

### FILTER is not the Proposer authoring skill

Keep separate configurations:

- **FILTER:** native-main `.github/skills/tests/SKILL.md`, no `externalBundle`,
  read-only evidence/source reasoning, all four discovery scopes.
- **Proposer:** repository-native
  `utils/excel-agent-in-container-proxy/.github/skills/excel-agent-in-container-proxy-integration-tests/SKILL.md`,
  named `excel-agent-in-container-proxy-integration-tests`. Explicitly invoke
  this name or repository-relative path in the task. The controller includes the
  configured path in every authoring/repair prompt; no root skill registration
  or automatic discovery is assumed. Read its `references/suites.md` companion
  relative to that skill directory using normal `pilot_read` in the isolated,
  pinned product workspace, not a `skill-bundle:` alias.

Select an approved exact product base containing both files and obtain new
read-only skill and native-backend qualification. The generic repository-native
qualification/load checks bind skill bytes to that base; missing paths or source/
hash drift block rather than fall back to FILTER or the old skill path. An old
baseline without the merged path does not qualify the new binding. FILTER source
pins, native qualification and Proposer must agree on the new base.

Explicitly pinned historical external bundles remain optional for original
runs/replay only. Preserve their original paths, source Git objects, manifest
hashes, read-only bundle roots and receipts. The generic external-bundle checks
still verify actual Git blobs. Do not rewrite old receipts or silently migrate
an old run to the new path; create new approved inputs and qualification.

AL Proposer requires local execution and **`authoringProvider: "copilot-sdk"`**.
Agency local, Agency remote and unknown providers are rejected before model
allocation or dispatch: their AL model-pin/deadline parity is not qualified.
Do not remove this guard. The merged skill adds no model, provider, remote
execution, write-scope or publication authority.

### Rebind the native profile correctly

`profilePath` is relative to the private input configuration, not the product
checkout or scaffold directory:

```powershell
$ConfigFile = (Resolve-Path '.\al-native.local.json').Path
$Profile = (Resolve-Path '.\scripts\validation\augloop-integration.ps1').Path
[IO.Path]::GetRelativePath((Split-Path $ConfigFile -Parent), $Profile)
(Get-FileHash -LiteralPath $Profile -Algorithm SHA256).Hash.ToLowerInvariant()
```

Use those values in the new input's gate. Keep input configuration on the
controller's volume so a relative path is possible. Do not write a normalized
absolute path from generated execution receipts back into the original input.
Refreshing a hash does not approve a profile change.

Use Windows paths in shell commands and repository-relative Git paths in
contracts. Do not mechanically interchange them.

## 5. Prepare collection, FILTER and finite authorization

| Private input | Required content |
| --- | --- |
| Collector config | `executionMode: app-native`, approved identity/sources/state policy, complete bounded window, finite per-pass limits, disabled scheduling. |
| FILTER config | One AL repository with native-main guidance, `filterExecutor: local-sdk`, verified batching/tokenizer settings, exact source pins and finite FILTER limits. |
| Native template | One AL repository-native authoring binding, native toolchain/profile and approved paths; initial execution/publication/isolation flags remain off. |
| Stage requests | Absolute new output directories and exact input `{path,sha256}` references; real grouping/sharing decisions and approvals. |
| Recurring plan, if used | [augloop.recurring.example.json](augloop.recurring.example.json), fixed durable state, pinned configs/qualification, finite limits and operator-owned cadence. |

Disable unapproved sources. For `cycle`, each enabled ADO/WorkIQ source must have
both created and changed passes; live IcM is not supported. Source scope and
product PR scope are separate: do not infer one ADO area/project from the other.
`dryRun: true` selects isolated collection storage, **not** synthetic evidence or
permission-free reads. Partial collection cannot be released as a complete cohort.

Configure FILTER requests, tool/time/source-byte/request-byte limits, exact
repository/revision sources, actual model context and verified tokenizer files.
Do not substitute character estimates, truncate records or drop large evidence
to fit a budget. If evidence paging is explicitly enabled, preserve per-record
UTF-8 byte coverage and the original execution receipts.

All four integration paths from section 4 must appear in the actual FILTER
instructions. Candidate `definition.harness` must start with a supported
repository-relative harness path; descriptive text may follow. Preserve complete
thread/source-version grouping and material-sharing approvals.

### Separate authorization from configuration

Standalone `filter`/`propose` require a content-pinned model allocation with the
actual prior count, exact `repoId`/`baseRevision`, permitted purpose, run directory
and future deadline. Set allocation `allowPublication` explicitly; `propose`
requires it to be true as well as request `authorizeCommit`, `authorizePush` and
`authorizeDraftPR`. The pinned standalone allocation remains attached to runtime
execution: recheck it after preparation, before SDK session creation/submission,
on tool calls and before commit/push/Draft mutation. The SDK wait is capped by its
remaining lifetime. Expiry is a blocker, not permission to finish publication.
Qualification, retained-result reconciliation, prepare-only handoff and original
candidate replay need no model allocation; native execution still needs approval.

Recurring execution instead requires a new `al-recurring-authorization-v1`
bound to the final plan SHA, with approver/time/expiry, `maxCycles`,
`maxTotalModelSessions`, `maxTotalAiCredits`, `maxTotalDrafts`,
`allowCollection`, `allowModels`, `allowPublication` and
`stopAfterFirstSuitableDraftPR`. See the complete example in
[the authorization contract](../scripts/validation/AUGLOOP.md#finite-authorization-and-actions).
Historical E2E permission is not a recurring grant.

Reserve all required FILTER sessions before dispatch; at most one Proposer per
cycle is allowed. Each session reserves its complete 30-credit soft allowance.
Source caps apply per selected pass, so account for their aggregate. Reservations
are not actual usage and are not automatically refunded after uncertain failures.
Keep the shared FILTER ledger's cumulative `maxRequests` ceiling consistent with
the approved allocation rather than resetting it between cycles.

Once the first suitable Draft stops a grant, unused allowance is not permission
to publish again. Restarting the CLI does not renew stopped, expired or exhausted
grants. New authorization must be explicit; never edit an admitted grant in place.

## 6. Check configuration and qualify the native backend

Run configuration diagnostics against completed private inputs:

```powershell
node src\cli.js doctor --config .\collector.local.json
node src\cli.js doctor --config .\filter.local.json
node src\cli.js doctor --config .\al-native.local.json
node src\cli.js filter-local-preflight --config .\filter.local.json
```

Resolve blockers rather than enabling flags until diagnostics stop complaining.
Read-only skill qualification, native backend qualification and publication
permission are distinct.

For native qualification, save a new private request with a **configuration
filename**, not a `{path,sha256}` reference:

```json
{
  "templateConfig": "C:\\al\\config\\al-native.local.json",
  "runDirectory": "C:\\al\\runs\\qualification-001",
  "nativeExecutionApproved": true,
  "authenticationRemediationApproved": false
}
```

The paths and approval are examples, not authorization. The configuration must
already be complete; the run directory must not exist. Once explicitly approved:

```powershell
node scripts\augloop.mjs qualify C:\al\requests\qualification-001.local.json
```

`qualification` succeeds only with all four raw owner results, exact
source/profile binding and preserved immutable-output cleanup. It disables
collection, model authoring and publication. Selected assertions must really
execute; Session Protocol additionally requires zero pending tests across the
package, including counts omitted from individual JUnit testcase elements.

Set `authenticationRemediationApproved:true` only after separately approving
the bounded credential-provider remediation. Follow the returned cwd and
installation/sign-in requirements in `AGENTS.md`; never capture credentials.

For capability discovery, use a new request with `templateConfig`, a fresh
`runDirectory`, and optionally the successful qualification content reference:

```powershell
node scripts\augloop.mjs capabilities C:\al\requests\capabilities-001.local.json
```

Keep the recurring plan disabled for its first `inspect`:

```json
{
  "action": "inspect",
  "plan": {
    "path": "C:\\al\\config\\recurring.local.json",
    "sha256": "SHA256_OF_FINAL_PLAN_BYTES"
  }
}
```

```powershell
node scripts\augloop.mjs cycle C:\al\requests\inspect.local.json
```

`configured-not-activated` means configuration inspection, not a running service
or a qualification result. No scheduler is installed.

## 7. Start manually, inspect progress and retain state

### Explicit stages for one evidence-to-PR attempt

Use the [stage request contracts](../scripts/validation/AUGLOOP.md#collection-filter-and-genuine-handoff).
The following shows order, not a script to run without reviewing each result:

```powershell
node scripts\augloop.mjs collect C:\al\requests\collect.local.json
node scripts\augloop.mjs batch C:\al\requests\batch.local.json
node scripts\augloop.mjs filter C:\al\requests\filter.local.json
node scripts\augloop.mjs reconcile C:\al\requests\reconcile.local.json
node scripts\augloop.mjs prepare C:\al\requests\prepare.local.json
# Only after candidate review and explicit publication authorization:
node scripts\augloop.mjs propose C:\al\requests\propose.local.json
```

Stop after any blocker or incomplete cohort. `reconcile` loads the original
FILTER ledger read-only; supplied JSON files alone cannot establish that FILTER
executed. `prepare` performs a genuine qualified handoff but starts no model.
Its preallocated session UUID is not an actual model session.

The selected candidate's `harness` starts with an explicit repository-relative
path under a supported owner. A following explanation may be separated by
whitespace, a colon or a semicolon. Repository, exact source revision and
integration-layer bindings still must match; prose-only routing or traversal is
not accepted.

The current AL `propose` entrypoint reserves one model session and forces zero
automatic validation-repair rounds. Increasing a template's repair limit does
not enable retries here. Preserve a failed attempt and use only a separately
authorized, supported successor/recovery contract; do not loop `propose`.

Workflow requests use `{path,sha256}` references for `templateConfig`,
qualification and other inputs; native `qualify`/`replay` use a template filename.
Each explicit workflow stage requires a fresh absolute `runDirectory`.
Do not blindly rerun an existing directory, overwrite a terminal, or change
pins to make old receipts load. A retained `complete-held` result does not by
itself authorize Proposer execution.

### Durable periodic coordination

For the `cycle` path, finalize a new enabled plan and its new finite grant after
inspection; do not alter an admitted plan. Start with an approved collection-only
rehearsal before authorizing model or publication stages.

Save a `begin` request with `plan` and `authorization` content references and an
approved complete `window` (`start`, `end`, UTC). If omitted, the window defaults
to the previous complete UTC day, not SDX's timezone-aware scheduled occurrence.
The first start must match `firstWindowStart`; later starts must match the durable
cursor end. Gaps need explicit bounded catch-up, not an arbitrary current date.

Invoke every action through:

```powershell
node scripts\augloop.mjs cycle C:\al\requests\cycle-action.local.json
```

After `begin`, use its returned `cycleId` and configuration/source references.
The normal progression is `collect`, then (for a new nonempty cohort) `batch`,
`filter`, `prepare`, `propose`, `finish`. Model-bearing actions require current
authority; `batch`/`filter`/handoff actions take their normal pinned `stageRequest`.
The coordinator owns each stage's directory. An empty or entirely reviewed
cohort finishes without inventing a candidate or opening a model session.

Keep `stateDirectory` stable: the root ledger owns cycles/cursors/grants, `sources`
owns collection history, `filter` owns FILTER execution, and `workers` owns native
jobs unless another absolute worker store was explicitly approved. Copying new
window configurations is not permission to create fresh authoritative ledgers.
Preserve original receipts and source objects for qualification/reconciliation.

`status`, `stop`, `grant-status` and `stop-grant` are explicit operator actions.
One controller owns the coordinator lock; do not steal a lock from a live process.
Inspect detailed stage logs and partial artifacts, not just process existence.
Source reads, model intent, publication results and uncertain effects have separate
records; a timeout does not prove no work occurred.

An operator scheduler may invoke this interface only after cadence, identity,
finite authorization and rehearsal are approved. This adapter does not synthesize
grouping/sharing approvals, tracked-open refresh, AI-comment decisions or CI queueing.
Those remain bounded operator responsibilities described in
[AUGLOOP.md](../scripts/validation/AUGLOOP.md#repository-wide-discovery-and-recurring-operation).
Do not call it a zero-configuration unattended service.

## 8. Retained evidence, replay and recovery

| Situation | Supported operation and restriction |
| --- | --- |
| Completed FILTER cohort | `reconcile` with original config/manifest/results/ledger; `prepare` adds qualified native template and skill. No new FILTER execution is implied. |
| Explicitly approved FILTER successor | `retainedResults` must match independently reconciled original batch receipts. Only new batches may reserve sessions; no silent retry. |
| Original model-authored candidate | `replay` with original genuine terminal, successful qualification and clean candidate checkout at its exact recorded head. No reauthoring, commit, push or PR. |
| Outer stage interrupted after native completion | `cycle` action `reconcile-stage` checks completed native receipts; it does not invent a missing terminal or rerun work. |
| Published cycle reaches authorization expiry before finish | `finish` may verify the original pinned receipts and perform bookkeeping only. It grants no source/model/PR reads or publication. |
| Historical completed cycle was incorrectly left `stopped` | Explicit `reconcile-stage`, `stage:"completion"` checks completed proofs, covering cursor and reviewed identities; restores only terminal state without moving cursor/dedup. |
| Genuine failed/uncertain model execution | Hold for the existing diagnostic/continuation contract; do not clear reservations or make it look completed. |

Legacy completion recovery is not an instruction to ignore all stopped cycles.
Stale `finish` must reject without changing state. After proof-checked completion
recovery, the next contiguous cycle still requires a valid finite grant.

The specialized `continue` stage supports only the source-bound
`native-jest-cache-isolation` continuation with zero model attempts. Its previous
and next configs, original proposal, assignment and authorization must agree;
execution additionally requires explicit commit/push/Draft permissions. It is
not a generic retry switch.

Never rewrite completed receipts, recompute their hashes to hide changes, copy
active ledgers, or reset state to recover budget. A source/profile/runner change
requires new qualification, not a relabeled old result.

## 9. Verify actual completion

| Observation | What it establishes |
| --- | --- |
| Setup/demo/offline regression success | Controller/tool setup, not real AL E2E. |
| Capability inventory | Discovery; only explicitly supported and qualified rows are executable. |
| `qualified-native-backend` | Passing native baseline for the pinned source/profile and all four owners. |
| `validated-original-candidate-replay` | New deterministic native results for the original candidate; no new evidence-driven authoring. |
| Prepared assignment or `complete-held` reconciliation | A handoff/held cohort, not publication permission or a Draft PR. |
| Empty/no-candidate/held cycle | A legitimate processing outcome, not evidence-to-PR success. |
| Recorded Draft publication | Requires independent PR/head/files and remote policy verification before reporting final acceptance. |

Retain the real evidence chain:

1. Complete source coverage, manifest/batch membership, original execution
   receipts, and semantic evidence for the candidate.
2. Exact candidate head, selected changed paths, sealed native artifact, all four
   raw runner results and preserved cleanup. Baseline passes in other owners do
   not make each owner a separate model-authored E2E.
3. Explicit publication authority and real commit/push/Draft results; independently
   confirm target/head/Draft state and that only authorized files changed.
4. Required remote validation results tied to the correct current PR merge/head
   context, plus review/comment follow-through. Local gates do not replace CI.
5. Actual session/tool/source usage, failures and retries, distinguished from
   reserved capacity; retained artifacts follow approved access and retention.

`cycle` action `observe-pr` needs `readOnlyApproved:true` and current authority.
It checks recorded Draft/head/target and required policy/build context, then
re-reads the head. It does not queue builds, resolve comments, approve or merge.
After expiry, use a separately authorized bounded observation interface rather
than using bookkeeping-only `finish` as remote-read permission.

Do not broaden evidence windows, weaken assertions or manufacture candidates
just to create a PR.

## 10. Common blockers and recovery

| Symptom | Investigation or action |
| --- | --- |
| `scripts\augloop.mjs` missing after clone | The selected revision lacks the AL adapter; use the approved revision, not an old branch plus private receipts. |
| Merged skill missing at the pinned base | Use new approved inputs and qualify an exact base containing the skill and companion; no fallback to an older skill or old qualification. Historical external runs still need their exact retained bytes and Git objects. |
| External bundle rejected by remote execution | Local-only is an explicit contract. Remote authoring needs a separately reviewed integration, not a bypass. |
| Native-main FILTER/Proposer skill mismatch | Keep separate FILTER and Proposer bindings; retain all four FILTER discovery paths. |
| `action-required-auth` | Follow declared cwd, provider installation approval and MFA; bounded remediation/recheck only. No credential copying or authentication loops. |
| Missing profile/hash mismatch | Rebind the relative path to the new input file; approve and requalify real changes instead of editing receipts. |
| Sparse install rejects a derived lock | Confirm the disposable checkout is actually sparse and uses the product's native plugin/filters. Sparse installs use `--no-immutable`; full checkout installs must stay immutable. Do not relax the gate globally. |
| Missing workspace API, fixture or postinstall script | Review the exact revision's read-only source closure and relink through native preparation. Expanding sparse paths alone does not relink an existing install; changed path sets require new preparation. Do not substitute selected tests for full owner tests. |
| Cargo status drift or remaining dirty files | The profile renormalizes only tracked root Cargo inputs through configured filters in sparse mode. Inspect both staged and unstaged diffs; real changes and untracked files remain blockers. Never reset source or install an ad-hoc filter to hide changes. |
| Changed sparse paths produce a cache miss | Expected: cache identity includes the effective explicit path set. Retain the old snapshot and let the new configuration prepare its own outputs; order-only/duplicate changes retain reuse. |
| Partial collection or failed batch | Preserve failure/coverage records; no partial-cohort dispatch or unreviewed cursor advancement. |
| Unsupported owner or harness | Check that `harness` starts with the supported source-bound path; a semicolon explanation is valid. Keep genuinely unsupported owners blocked until their own native contract and write authority are qualified. |
| Native gates pass but push/Draft publication fails | Preserve the exact head, validation proofs and original failure; reconcile remote effects before separately authorizing recovery. `continue` is not a generic publish-only resume operation. Do not rerun authoring just to retry publication. |
| Budget/expiry/first-Draft stop | Preserve cumulative reservations. New finite authority is required; spare old allowance is not renewal. |
| Slow preparation despite cache hit | Inspect copy, compile, fingerprint and immutable-output events. Do not remove integrity checks or claim a wall-clock gap was active compute time. |
| Process exit 0 but missing/empty results | Check raw Mocha/Jest counts, skipped aggregates and selected assertions. Exit code alone is insufficient. |
| Interrupted or old stopped cycle blocks `begin` | Diagnose original native receipts; use supported reconciliation, including verified completion recovery where applicable. Never skip incomplete cycles. |
| Previously covered invariant appears with different evidence roots | Existing invariant/assignment dedup may hold it. Reconcile the source/fix/PR state rather than publish a duplicate. |

Use `progress.json`, `native-subphase.json`, `native-progress.ndjson`,
`preparation.json`, validation artifacts and terminal `result.json`/`failure.json`
where that stage produces them. A preparation event is not final test success.
Do not delete caches or ledgers to make progress reporting look clean.

## 11. Repository publication checklist

Keep this English repository-facing guide at `scaffold\AL-AGENTIC-LOOP.md`.
Keep personal-language run summaries and real evidence outside committed docs.
Paths beginning with `src`, `scripts` or `scaffold` in prose are relative to the
controller root.

Controller code, tests, native scripts, disabled examples and general documentation
can be reviewed/landed separately from the AL authoring skill. New authoring uses
the merged in-repository binding; external material is only a prerequisite for
explicitly pinned historical runs. Code publication is not execution approval.

Do not commit:

- Private configs/grants/reviews, ledgers, captured evidence, logs, native caches,
  raw receipts, screenshots or credential material.
- Personal absolute paths, account/tenant IDs, private product PR links or run
  status snapshots.
- A local skill bundle or old execution pins copied into this general guide.
  Use each new run's exact source and qualification pins.

Create the controller PR as Draft and retain disabled defaults. Product PRs
remain separate. Do not merge either PR or enable a schedule without the
corresponding explicit approval.

### Reference documentation

| Document | Purpose |
| --- | --- |
| [AL native/operator contract](../scripts/validation/AUGLOOP.md) | Complete request schemas, qualification, replay, recurring actions and external operator boundaries |
| [AL repository example](augloop.repository.example.json) | Disabled four-owner repository/skill/native configuration fragment |
| [AL recurring example](augloop.recurring.example.json) | Inactive plan, pinned inputs and finite per-cycle limits |
| [ONE-SHOT.md](../ONE-SHOT.md) | Collection/handoff receipts, complete cohorts and host responsibilities |
| [APP-NATIVE.md](../APP-NATIVE.md) | Source adapters, local FILTER and receipt contracts |
| [AGENTS.md](../AGENTS.md) | Setup and authentication remediation rules |
| [README.md](../README.md) | Controller setup and surrounding execution interfaces |
