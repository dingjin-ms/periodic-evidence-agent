# End-to-end execution guide

To include post-flow agent-system improvement, follow the
[RSI operator runbook](scaffold/RSI-RUNBOOK.md) alongside this product execution
guide. RSI opt-in, app-host continuations, independent comparison and draft
publication are separate from product authoring/validation permissions.

This guide covers the gated path from devbox setup to a source-bound draft PR:

```text
Setup and authentication
    -> scoped collection
    -> complete-record FILTER analysis
    -> complete-cohort consolidation and held coverage review
    -> one authorized repository proposer
    -> native validation
    -> draft PR
```

**This reconciled public version is offline-validated, not live-qualified.** Setup
and the offline demo do not establish package-feed access, hosted execution,
product-test success or complete source coverage. Live OA execution must remain
blocked until the selected authentication path and native execution prerequisites
are verified. Browser E2E is a separate workstream, not a prerequisite for OA
in-process integration tests.

## Verified real execution reference

On October 13, 2026, this procedure completed a real ADO-to-OfficeAgent run
for the half-open UTC window `2026-10-12T00:00:00Z` through
`2026-10-13T00:00:00Z`:

```text
73 unique ADO records
  -> 73 complete FILTER results
  -> one reviewed coverage candidate
  -> one source-bound OfficeAgent assignment
  -> bounded repository-skill authoring and repair
  -> both required native source-head validation legs passed
  -> one Draft PR
```

Both final case executions passed once with 26 assertions each. Emitted runtime
import/mocks order was verified before push; explicit raw output-file results
supplied acceptance because the wrapper's default summary was unavailable. No
actual CI builds were observed in that complete publication window. The
sanitized aggregate proof is stored under
`e2e-evidence/ado-window-discovery-20261012`; private evidence and product PR
identity remain excluded.

This run proves the declared ADO collection passes, complete FILTER cohort,
selected candidate lineage, bounded author/repair loop, native validation and
Draft PR publication. It does **not** prove WorkIQ or IcM coverage, incident
RCA, unattended first-attempt reliability, hosted Agency, browser E2E or
target-merge/latest-vendor behavior.

Run commands step by step and stop on a nonzero exit or unresolved gate. The
examples do not authorize source reads, authentication setup, model jobs,
repository mutations or scheduling. Use only an approved distribution of this
repository and keep private evidence out of Git.

The thin role facade exposes discovery through
`npm run pilot -- agents` and `npm run pilot -- agent ROLE help`, where `ROLE`
is `collector`, `filter` or `proposer`. Role commands delegate to the existing
helpers and their permission gates; they do not automatically advance stages.
An operation-result envelope is not proof of role completion, complete-cohort
acceptance or native validation. See [README.md](./README.md) for the interface.

For the stricter fresh-cohort path, use the
[bounded one-shot controls](ONE-SHOT.md). They coordinate the existing local
collectors, reserve whole-cohort FILTER budgets before task reservation and
gate one proposer on complete source plus accepted execution evidence. The
existing Copilot session/host remains the orchestrator; external FILTER
submission/observation, approvals and runtime qualification remain its
responsibility. Legacy selected-case replay below keeps its original scope.

## 1. Clone and initialize the devbox

Prerequisites are **Node.js 24+, npm and Git**. Windows native validation and
diagnostics also require **PowerShell 7.3+ (`pwsh`)** for Job Object containment.
Live OA validation
also needs the selected profile's native toolchain, including Corepack and the
repository-pinned Yarn version.

```powershell
# Replace with the approved published branch or tag containing these interfaces.
$ControllerRef = 'REPLACE_WITH_APPROVED_PUBLIC_REF'
git clone --branch $ControllerRef --single-branch `
  https://github.com/zhenhuangMSFT/periodic-evidence-agent.git `
  periodic-evidence-agent

Set-Location .\periodic-evidence-agent
git rev-parse HEAD
node --version

# Select OA for the integration-first setup.
npm run setup -- --repo office-agent
```

Record the actual controller revision. Do not assume that local development
commits or configuration options are available from the remote branch.

If setup reports that the selected product repository is absent, and cloning
is approved, rerun:

```powershell
npm run setup -- --repo office-agent --allow-clone
```

Setup installs the controller's locked dependencies, initializes the selected
product checkout, performs read-only skill qualification, runs diagnostics,
executes the offline checks and runs the synthetic demo. Omit the `--repo`
selection only when setup of every configured skill-backed repository is intended.

**Setup does not authenticate product feeds, install product dependencies,
enable production dispatch or create PRs.** `synthetic-demo-passed` means fixture
assertions passed, not a live integration-test pass. The demo now includes real
FILTER validation/consolidation and isolated local proposer fixture execution,
with real Node test gates and failed-validation/stale-head/duplicate-dispatch
checks. Model authoring and push/draft publication are deterministic mocks.
The original partial synthetic collection is never promoted; proposer execution
uses the existing explicitly authorized synthetic reviewed-handoff interface.
See the [demo stage assertions](README.md#offline-demo-coverage) for the exact
scope and output artifacts.

Use `npm run setup:repos -- --repo office-agent` only when intentionally
rerunning the repository layer without repeating dependency installation and
all controller checks.

## 2. Resolve the private configuration

Setup uses the ignored `pilot.local.json`. Preserve an existing file; otherwise
start from the inert example:

```powershell
if (-not (Test-Path .\pilot.local.json)) {
    Copy-Item .\pilot.example.json .\pilot.local.json
}

npm run pilot -- doctor --config .\pilot.local.json
```

Resolve these fields with the responsible owner before live execution:

| Area | Required decisions |
| --- | --- |
| Collection | Executing user's identity, approved resources, explicit UTC window, source scopes and read/item budgets |
| Storage | Protected local state directory, access approval and retention |
| Repository routing | Owner/project binding, reference checkout, approved source/base ref and PR target |
| Authoring | Enabled native skill binding, permitted write paths and bounded worker/repair budgets |
| Validation | Approved executable, arguments, timeout, isolation and content-bound profile |
| Publication | Commit identity and separately approved commit, push and draft-PR permissions |

The example contains synthetic identities and unresolved limits. It is not a
ready-to-run production configuration. `doctor` reports configuration; it does
not prove authentication or runtime readiness.

Keep collection, review, dispatch and schedules disabled until their respective
authorization is established. Do not copy another user's credentials,
qualification receipts or execution budget. Do not use network-shared SQLite.
Protect `*.local.json`, `.state`, captures and raw validation artifacts, and
never commit them.

An existing run's configuration is immutable. Inspect or resume it with its
original configuration; use a separately configured new run for changed scope.

## 3. Establish authentication before live validation

These are independent access requirements:

| Access | What it enables |
| --- | --- |
| Git/ADO repository access | Fetch product source; push and create drafts only when separately authorized |
| Azure Artifacts authentication | Read every required default and scoped package feed |
| Copilot worker authentication | Run the selected local model-backed proposer |
| WorkIQ/ADO collection authentication | Read approved evidence as the configured executing user |

An Azure CLI account or token-expiry result does not prove package-feed read
permission. Verify both the default registry and any scoped registry used by
the selected OA source. A successful ordinary-checkout install also does not
prove that credentials reach an isolated controller validation process.
Compare source, lockfile, Yarn version, configuration and cache conditions;
a warm cache can hide missing authentication.

The intended local boundary is:

```text
Separately approved credential provisioning
    -> supported same-user authentication
    -> explicit, restricted credential handoff
    -> isolated controller validation
```

The checked-in OneNote version 3 profile uses the controller-owned authentication
broker. A cold dispatch checks the pinned `artifacts-npm-credprovider` 1.2.1
against an exact-source `.yarnrc.yml` snapshot before creating a worker. On
`action-required-auth`, keep the assignment `prepared` and follow its returned
`remediation` command from its declared `cwd`. If `requiresInstallApproval` is
true, obtain approval before installation; otherwise complete the Microsoft
sign-in/MFA. Do not request, display or persist provider credentials/diagnostics.
After successful remediation, retry the original command once. Declined/failed
remediation or a second auth-required result remains blocked, not a retry loop.

Trusted dependency-cache hits skip authentication preflight. Never delete a
receipt to force sign-in. The final dependency stage validates authentication
non-interactively; it must not refresh credentials or change pinned source.
The validation environment does not inherit arbitrary package-token or custom
package-manager configuration variables. The separate value-free
`packageAuth: {kind: "yarn-token", tokenEnvironmentVariable: "PILOT_OA_PACKAGE_TOKEN"}`
contract is available only for explicitly approved legacy runners and a supported
same-user setup launcher; it is not an automatic fallback from the broker.

Do not run OA's `ado-artifacts-auth.js` helper as a harmless diagnostic. It can
write Yarn configuration or trigger a global credential-provider installation.
Likewise, the product repository's full setup is not equivalent to this
controller's bounded `npm run setup`. Account consent and authentication setup
must be explicit, outside validation, and must not alter pinned tracked
configuration or place credentials in arguments, source, logs or receipts.

**Stop before live OA execution if this gate is unresolved.** Do not run a
blind install retry, broaden environment inheritance or switch executors to
work around missing authentication.

## 4. Qualify the selected source and native skill

After configuration points to the intended product source:

```powershell
npm run pilot -- qualify-skill `
  --repo office-agent `
  --capability integration-test-authoring `
  --binding oa-integration-test-core `
  --config .\pilot.local.json
```

The source revision, native skill and validation profile must agree. The
checked-in OneNote profile targets a particular contract; it is not a general
runner for arbitrary candidates. Do not assume the product's default branch
contains the required contract.

Skill qualification is read-only preparation, not proof that dependency
restoration, compilation or tests work. Profile or validation-contract changes,
including authentication-contract changes, require requalification before
preparing new assignments. Do not change an in-progress assignment's contract.

### Reusable Windows launcher/profile requirements

The private successful case profile, product test/card and receipts are not
distributed. A new approved profile must select its own source-bound cases and
required legs. It must not refer to another operator's runtime paths. Preserve
these reusable corrections when authoring that profile:

- Use a short private non-dot state root when the native test matcher rejects
  hidden-directory ancestors. Clones persist `core.longpaths=true` locally.
  Required LFS files belong in the gate's exact `lfsPaths` list, never broad smudging.
- Native processes run under the controller's Windows kill-on-close Job Object.
  Do not replace this with an uncontained shell or increase timeouts to mask
  leftover descendants. Model launchers use `localProposerEnvironment()`; native
  runners use their narrow environment and separate approved package auth.
- Preserve the host's `PATHEXT` including `.EXE`. Missing, empty or unusable
  values fail before native launch with `blocked-native-environment`; the runner
  does not synthesize defaults. The supervisor resolves an application and
  requires its process exit code, without requiring output from silent commands.
  Restore the host environment and follow the existing explicit reconciliation
  or continuation procedure; do not reset an attempted validation or retry it
  just because the environment was corrected.
- When invoking the native wrapper through a PowerShell function, pass the
  separator as the literal string `'--'`. Launch the wrapper with the pinned
  root Yarn tool environment, not plain `node`, so child root tools resolve:

```powershell
# Template only: replace package/path selection with the qualified native contract.
$corepack = (Get-Command corepack.cmd -ErrorAction Stop).Source
Invoke-Checked $corepack yarn node `
    'docs\skills\Integration-test-core\scripts\run-integration-tests.mjs' '--' `
    $corepack yarn workspace 'SYNTHETIC_PACKAGE' check:integration `
    --runTestsByPath 'tests/integration/synthetic-case.test.ts' --runInBand
```

`Invoke-Checked` must forward `[Parameter(ValueFromRemainingArguments = $true)]
[string[]]$Arguments` with `& $Executable @Arguments` and fail on nonzero exit.
The checked-in OneNote profile illustrates that helper but selects its own
different contract; it is not the private successful two-leg profile.

Fresh native TEMP/cache placement must stay at most 180 characters on Windows.
The historical successor APIs provide `nativeTemporaryDirectory()` automatically
for their source-bound test stage. Ordinary profiles do not implicitly become
historical successors. A new profile requiring a fresh cache can allocate its
own unique, protected profile-local test TEMP before either required leg:

```powershell
$nativeTemp = Join-Path $PSScriptRoot ('nt-' + [Guid]::NewGuid().ToString('N'))
if ($nativeTemp.Length -gt 180 -or (Test-Path -LiteralPath $nativeTemp)) {
    throw 'Use a shorter private state root and a fresh native TEMP directory.'
}
New-Item -ItemType Directory -Path $nativeTemp -ErrorAction Stop | Out-Null
$env:TEMP = $nativeTemp
$env:TMP = $nativeTemp
$env:TMPDIR = $nativeTemp
```

Run this only in the test stage of the content-bound profile, never during
fingerprinting. Preserve raw results and any required emitted-code proof before
explicit cleanup. A successful wrapper exit or unavailable default summary is
not case acceptance: parse the explicit raw output files, require each selected
case exactly once with its expected assertions, and reject missing/extra cases.
The generic offline argv/environment tests do not qualify any live product profile.

## 5. Collect evidence and run FILTER

For an explicitly selected already-collected and reviewed source, use
`agent collector replay-evidence` and `agent filter replay-review` under the
[recorded-source contract](APP-NATIVE.md#recorded-source-role-handoff) instead of
collecting/reviewing again. Those commands import exact pinned original records
into a held audit ledger. They are not a new full-cohort execution and do not
authorize an automatic transition to Proposer. The steps below describe the
separate fresh-collection and complete-cohort route.

### Collect within an approved scope

Open the controller checkout in a skills-capable Copilot host. A suitable
instruction is:

> Use evidence-collector with my approved pilot.local.json. Inspect existing
> runs first. Collect only the approved sources, UTC window and budgets.
> Persist original receipts, source versions and coverage. Stop on
> authentication failure; do not review or dispatch workers.

The collector uses the [begin and receipt contracts](APP-NATIVE.md#entry-points)
to create or resume the appropriate run. Inspect its persisted state:

```powershell
npm run pilot -- app-runs --config .\pilot.local.json

# Set $RunId to the existing run ID returned by the collector.
npm run pilot -- app-status --run $RunId --config .\pilot.local.json
```

For a production run, use its original configuration and add `--production`
to status inspection. A dry run cannot be promoted by adding that flag.
Missing bodies, incomplete paging and unavailable sources remain explicit;
unknown coverage is not zero.

### Prepare, execute and reconcile complete-record batches

#### Explicit local SDK execution

The opt-in local route does not impersonate a hosted Agency job. Select
`filterExecutor: "local-sdk"` in a separate private configuration, enable
`activation.review`, and configure `localFilter` explicitly:

```json
{
  "enabled": false,
  "maxRequests": 1,
  "maxToolCalls": 24,
  "timeoutMs": 600000,
  "maxSourceBytes": 65536,
  "maxRequestBytes": 524288,
  "useExistingLogin": false,
  "acceptSoftCreditLimit": false,
  "sources": [{ "repoId": "1js", "revision": "<exact-40-character-commit>" }]
}
```

Enable it only for the approved run. Source pins must refer to configured
reference checkouts. The existing full-cohort manifest, sharing and model/token
budget checks still apply. The installed CLI requires at least 30 AI credits
per session; `filter-local-preflight` returns `action-required-budget` for a
smaller ceiling without launching or automatically increasing it.

**Credit limits are soft, not hard spending guarantees.** In-flight calls can
exceed the configured limit. Preflight therefore also requires explicit
`localFilter.acceptSoftCreditLimit: true` after informed
approval of that behavior; approval of a hard ceiling alone is insufficient.
Do not automatically retry a failed attempt or repurpose conditional Proposer
authorization for another FILTER run.

A separately authorized retry stays in the same ledger and uses the original
manifest and batch. In a new private configuration, set `localFilter.retry` to
`{ "batchId": "<batch>", "previousAttemptId": "<failed-attempt>",
"previousTerminalSha256": "<canonical-terminal-sha256>",
"authorizationRef": "<new-explicit-approval-receipt>" }`. The terminal hash is
SHA-256 of the predecessor terminal serialized with two-space JSON indentation
and a trailing newline. Approve the total `maxRequests` separately and retain
the original configuration unchanged. By default, only an immutable blocked predecessor
with matching manifest, payload, model and source pins can have a successor.
The successor has its own receipt identity; repeated submission, retry forks,
active predecessors and exhausted request budgets are rejected.
Reconcile using that retry configuration and a new result-export path.

Reassessing an already completed result requires an explicit
`retry.reassessment` with `resultSha256`, `reviewRef` and `reason`. This binds the
rejected result and quality review; it does not silently promote or overwrite
the prior decisions. A model or context-tier change requires a newly prepared
verified manifest and `retry.requalification` with `previousManifestSha256`,
`previousModel` and `reason`. Evidence payload and source pins must remain exact.
Set `localFilter.contextTier: "long_context"` only when that tier is available
and its distinct input limits and prices have been qualified.

A retry applies only to its named batch. Other unstarted batches can use the
same configuration. When another batch subsequently needs a retry, preserve
the base configuration and append its explicit retry object to
`localFilter.cohortRetries`. Each batch selects its own retry without changing
already completed batches' configuration binding. Reconcile with the full
selection; duplicate selections, unknown batches, mismatched predecessor
hashes and forks still reject. This is not permission for automatic retry:
each successor must remain within the user's explicit iteration authorization.
An explicit retry can also carry `execution` overrides limited to `maxRequests`,
`maxToolCalls`, `timeoutMs` and `compactDecisions`. They apply only to that retry's batch and
remain part of its request/configuration hash. Request ceilings count the
entire ledger, including historical attempts; an increased ceiling must still
fit the user's total authorized session budget.

A retry may carry an optional `review` containing `reviewRef`, `reviewSha256`
and a bounded `reason`. The referenced JSON is checked using the canonical
two-space-indented JSON plus newline hash before execution and reconciliation.
This preserves source follow-up observations when retrying a blocked predecessor;
it does not permit `reassessment` against an incomplete result, create semantic
decisions, or allow a fork. Review text is explicitly untrusted, independently
verifiable context. Configurations without this field keep their prior instruction
bytes. Invalid title-exclusion feedback identifies the affected source/evidence
record; it never corrects the model's quote or exclusion automatically.

The default isolated SDK home does not inherit keychain-backed login. For an
explicitly approved single-user run, `localFilter.useExistingLogin: true` uses
the existing CLI login/home without copying credentials. FILTER still sets a
custom-tool allowlist and denies permission requests, disables custom
instructions, skills, file hooks, host Git operations, memory, scheduling and
session-store indexing, and removes installed plugins before sending evidence.
The runtime can retain session artifacts under the user's existing private
Copilot home; controller receipts remain in the configured state directory.
Do not describe this opt-in as empty-home isolation or an OS sandbox. The
default remains isolated, and authentication failure never selects this mode
automatically.

```powershell
node src\cli.js agent filter filter-local-preflight --config local-filter.local.json
node src\cli.js agent filter filter-local-run --config local-filter.local.json `
  --manifest private-batches.json --batch <batch-id> --output private-result.json `
  --execution-mode standalone-sdk
```

Only bounded Git reads at the pinned commits and a structured finish callback
are exposed. Read/list/literal-search responses are UTF-8 byte pages, each at most 12 KiB
including metadata, to avoid the runtime's inaccessible large-output files.
Page sizing searches for the largest fitting UTF-8 boundary rather than
halving a response that narrowly exceeds the limit. This reduces source tool
calls without increasing the response ceiling or relaxing complete-file reads.
Follow `nextOffset` while `hasMore` is true. Each receipt binds both the complete
source hash and exact page bytes; a first page is not a complete file review.
The `complete-opened-source-files-v1` policy rejects finish until every opened
file has contiguous delivery from byte zero through EOF, including when the
result has zero candidates. Feedback identifies a pending file and its first
missing offset, so the same session can finish reading and resubmit. Reading
the last page or another complete file cannot hide a missing middle page.
Partial directory listings remain discovery only, not proof of exhaustive
coverage. The `search` action uses a bounded literal query at the pinned commit;
its matching lines locate files but do not count as complete reads.
Malformed source argument shapes reject before source access and can be
corrected in the same session. Actual out-of-pin/path requests and exhausted
budgets remain permanent violations. Reconciliation independently checks the same immutable page receipts;
older receipts without this policy are historical evidence, not newly qualified
results. Complete delivery still does not independently prove semantic reading
or that reasoning belongs to the correct evidence record.
Working-tree edits are not read; no shell, write or publication
tool is exposed. Complete per-record output and actually inspected source for
candidates are required. This is SDK permission enforcement, not an OS sandbox
or independent verification of semantic reasoning.

Policy `incremental-complete-cohort-v1` accepts nonempty `status: "partial"`
decision chunks. Each chunk includes finished title/detail decisions for its
records; no manually synthesized reasoning is added. Accepted inputs and their
hashes are immutable, exact repeats are idempotent, and conflicting duplicates
reject. A final `status: "complete"` can have empty decision/detail arrays and
refer to previously reviewed records in its candidates. Completion still
requires every cohort member and every opened source file. Reconciliation
rebuilds the result from all accepted inputs and hashes, rather than comparing
only the final callback arguments with the assembled result.

For large batches, opt into `localFilter.compactDecisions: true` (or the
retry-scoped execution override). The finish tool then accepts `status`,
`decisions` and `candidates` directly. A `progress` request with empty arrays
returns up to 20 unresolved indexes, record IDs and titles without accepting
any decisions. Each compact decision must identify both its index and exact
record ID and supply all title/detail dispositions, exclusions, quotes and
reasons. Only immutable metadata (source identity, hashes, batch identifiers)
is populated from the verified manifest. Reviewer/session identity and receipt
time are controller metadata, not model reasoning.

Policy `compact-incremental-complete-cohort-v1` retains both the original
compact submission and expanded canonical input with their hashes. Independent
reconciliation repeats expansion from the exact manifest and receipt metadata
and verifies semantic fields byte-for-byte. It cannot invent reasoning, repair
conflicting decisions or promote an unknown/blocked candidate to an eligible
gap. Legacy full-result requests keep their original schema and policy binding.

The local ledger retains immutable request, session, event, source-inspection,
analysis and terminal receipts. A failed or interrupted attempt cannot be
automatically retried or switched to Agency. Run `filter-execution-check` below
with the **same local configuration** and its execution ledger; it explicitly
grades local receipts rather than requiring or inventing Agency job IDs.
Structural consolidation alone remains insufficient. CLI result export does
not overwrite existing files; the canonical result also remains in the ledger.

#### Shared batch preparation and hosted execution

Use `evidence-coordinator` to prepare the private source-ledger manifest,
complete context groups, sharing approvals and approved token budget under the
[batch contract](APP-NATIVE.md#complete-record-filter-batches). The input files
below are operator-produced private artifacts, not files supplied by setup.

```powershell
npm run pilot -- filter-batches `
  --file .\filter-batch-request.local.json `
  --output .\filter-batches.local.json `
  --config .\pilot.local.json
```

FILTER inspects titles and identity first, but each batch retains full captured
records and required context. Titles alone establish neither a defect nor a
missing test. Do not truncate an oversized context group.

**Hosted submission is a separate private integration.** The public repository
does not ship authenticated Agency submit/observe CLI commands. An approved
execution owner must provide the transport, exact task/source/profile selection,
request budget and monitoring. Batch preparation does not authorize a job.
Use the [Agency request and grading contract](AGENCY-EXECUTOR.md); the stronger
capture-verification policy is optional, not a prerequisite for the explicitly
approved local read-only FILTER policy.

After real results arrive, run this check for **each** result file:

```powershell
npm run pilot -- filter-batch-check `
  --file .\filter-result-1.local.json `
  --manifest .\filter-batches.local.json `
  --config .\pilot.local.json
```

Create `filter-results.local.json` as a JSON array of the exact result-file
paths for the complete original cohort. Replace the example ledger path below
with the approved original execution ledger:

```powershell
npm run pilot -- filter-execution-check `
  --file .\filter-results.local.json `
  --manifest .\filter-batches.local.json `
  --ledger C:\private\pilot\execution.sqlite `
  --config .\pilot.local.json

npm run pilot -- filter-consolidate `
  --file .\filter-results.local.json `
  --manifest .\filter-batches.local.json `
  --output .\filter-consolidation.local.json `
  --config .\pilot.local.json
```

Require both accepted execution and complete-cohort consolidation. One accepted
batch is not completion of the original cohort. Structural consolidation alone
does not regrade Agency execution. Cohort completeness also does not erase
limitations in the underlying collection.

## 6. Review coverage and prepare one repository handoff

Keep the output held while reviewing exclusions, ownership, existing tests,
coverage gaps and source compatibility. Follow the
[held Stage2 procedure](APP-NATIVE.md#held-stage2-coverage-handoff), including
the installed coverage-analysis skill and pinned reference. Missing skill or
reference inputs remain blocked; do not reconstruct a review from summaries.

Select one unblocked candidate bound to the intended repository and source.
Do not relabel a candidate from another repository, or present existing runtime
controls as newly discovered coverage.

Prepare `filter-handoff.local.json`:

```json
{
  "format": "filter-proposer-handoff-v1",
  "filter": {
    "manifestPath": "C:\\private\\pilot\\filter-batches.local.json",
    "resultPaths": [
      "C:\\private\\pilot\\filter-result-1.local.json"
    ]
  },
  "routing": {
    "capability": "integration-test-authoring",
    "requestedOutcome": "add-or-update-tests"
  }
}
```

Replace the illustrative paths with the actual manifest and **all** results in
the original cohort. The selected candidate's repository revision must match
the current skill qualification.

```powershell
npm run submit:filter-handoff -- `
  --file .\filter-handoff.local.json `
  --config .\pilot.local.json `
  --prepare
```

`--prepare` persists controller records and an assignment. It does not launch
the product worker and is not execution authorization.

FILTER proposer handoffs are test-only. The qualified skill binding pins a
narrower write allowlist inside the repository bounds; for OfficeAgent this
contains the integration tests, test harness and behavior cards, not production
source. The same bounds apply during validation repair. If the resolved fix is
not present on the pinned base and validation remains failed, the controller
records a blocked result without changing production code, pushing a branch or
creating a Draft PR.

## 7. Execute the authorized proposer

Only after authentication, routing, source/profile qualification and mutation
permissions are ready:

```powershell
npm run submit:filter-handoff -- `
  --file .\filter-handoff.local.json `
  --config .\pilot.local.json `
  --execute `
  --execution-mode standalone-sdk `
  --authorize-commit `
  --authorize-push `
  --authorize-draft-pr
```

This command can author code, commit, run native validation, push and create a
draft PR. It is **not a diagnostic command**. The flags acknowledge authorized
effects; they do not override unresolved configuration or qualification gates.

The controller owns execution and evidence:

```text
Isolated authoring
    -> committed revision
    -> locked dependency restoration
    -> scoped compile
    -> layout/card policy checks
    -> selected native tests
    -> explicitly bounded repair rounds, if authorized
    -> final source-bound validation
    -> push and draft PR
```

The bounded model worker has file tools, not general shell, browser, Git or
publication authority. Native validation and publication remain controller or
separately authorized executor responsibilities. A failed revision remains
immutable evidence; a repair is a new revision, not an erased failure.

Push and draft creation require every mandatory gate to pass at the exact clean
current HEAD. Missing, stale or duplicate gate results, post-validation source
changes and exhausted unsuccessful repair rounds must block publication.

A pre-model failure is not permission to reset a job or blindly dispatch it
again. A supported continuation preserves the blocked attempt and binds explicit
authorization to its successor configuration and controller revision. Check the
selected runtime's accepted budget limits before launch; do not silently raise a
ceiling to meet a runtime minimum.

For an interrupted installation, the programmatic `prepareValidation` option
`resumeDependencyWorkspaces` maps gate IDs to their exact unfinished dependency
workspaces. It rejects source/remote drift and unrelated cache paths, preserves
partial dependencies, and reruns the native installer before issuing any receipt.
Partial files are not a successful cache. Keep explicit recovery authorization
and stage diagnostics; do not modify the original assignment's validation contract.

For receipt-only reconciliation, `requireExistingDependencySnapshots: true`
rejects a missing or unverifiable dependency cache before quarantine or
reinstallation. This preserves the candidate receipt and workspace as evidence;
it does not promote an unverified receipt to a successful cache.
`requireExistingCompileSnapshots: true` also forbids rebuilding an unqualified
compile snapshot and implies existing-only dependencies. These cache failures
use the recorded validation reason `prepared-cache-corrupt`.

Prepared-output capture establishes partitioned observation before hashing.
When observation remains healthy, one complete content scan establishes the
baseline; events during that scan are settled against the captured contents.
Anonymous change notifications require complete-root content revalidation;
unknown rename events, changed contents and watcher errors invalidate reuse.
Platforms without recursive observation retain the full comparison fallback.
Existing receipt formats and content fingerprints remain compatible.

On Windows, a controller-owned PowerShell/.NET observer excludes last-access
notifications: reading dependencies must not flood the notification queue.
Content writes, names, sizes, attributes, security and creation changes remain
observed, including replacement of a watched root through its parent directory.
The observer must acknowledge setup before hashing starts. Lost notifications,
observer errors or unexpected process exit still invalidate reuse; they are not
treated as harmless access events.

Keep preparation, validation and test-only repairs in the same controller
process when possible. The observation guards are process-local: a disk cache
hit after restarting the process still requires a complete content scan.
Calling `prepareValidation` and then `resumePrecommitProposal` in one process
retains those guards without skipping the normal source, profile, toolchain,
change-scope or native validation checks. A successful synthetic benchmark is
not a measured product-E2E latency claim.

If the model already submitted a successful skill result but preparation failed
before any commit, `resumePrecommitProposal` can resume that preserved proposal.
It requires the blocked result ID, the original proposal and per-file hashes,
checks the original base revision and file bounds, and records a one-shot recovery
operation. It retains the failed result and original model tool usage; it does not
repeat initial authoring. Native changefile generation, hooks, validation, push
and Draft gates still run normally. Any subsequent model repair needs its own
authorized reservation. A committed, validated or published attempt is not
eligible for this entrypoint.

For an already committed proposal stopped before tests by a missing native
revision input, `resumeCommittedValidation` binds the latest blocked model result,
the exact failed validation artifact and every committed file hash. It requires
a clean, unpublished single commit on the original base. Preparation uses that
base; normal test-only compatibility checks qualify reuse for the candidate.
The generated changefile is checked against the actual commit title, not wording
from a later no-change proposal. Recovery neither authors nor recommits, preserves
model accounting, and namespaces new validation artifacts without replacing the
original failure. Native gates and exact-head Draft publication remain required.

For a proven native module-resolution failure, `prepareNativeTestProfileContinuation`
can qualify a separate ledger with only the final test-runner block corrected.
Its authorization binds the original failure, source, configurations and controller,
and permits zero model attempts. Authentication, preparation, policy and the
validation plan must remain identical. `rebindPreparedTestProfile` verifies the
original compiled outputs and writes a separate integrity-bound receipt; it never
rewrites the old receipt or treats a disk receipt as current observation.
Dispatch through `dispatchLocalValidationContinuation` retains the authored commit,
historical model usage and ordinary native/publication gates. This narrow recovery
does not make derived snapshots automatically discoverable by future cache lookup.

The SDX profile runs the selected integration tests through the repository's native
source resolver and SWC transformer, retaining ts-jest for test-file mock ordering.
This avoids requiring built exports from every workspace dependency. It inherits
the package integration configuration and requires actual nonzero passing Jest
results for every selected absolute path; a zero-test exit code is not acceptance.

The existing proposer role also exposes
`continue-local-validation`, `diagnose-local-validation` and
`continue-local-authoring`, each with explicit `--prepare` or `--execute` and
source/config/controller-bound input. Their narrow historical failure contracts
consume caller-supplied original receipts, preserve immutable predecessors and
reserve at most the specifically authorized successor. Missing historical
evidence fails closed. Do not manufacture receipts, broaden these guards into
a generic retry mechanism, or make new runs depend on a private predecessor.
Diagnostics never satisfy acceptance. This role facade is not an unattended
full-cohort scheduler.

### Optional synthetic reviewed-handoff smoke path

To exercise the downstream controller without claiming real collected evidence,
use the reviewed-handoff fixture after the same configuration and qualification
prerequisites:

```powershell
npm run submit:reviewed-handoff -- `
  --file .\test\fixtures\reviewed-handoff\onenote-bootstrap-progress.reviewed-handoff.json `
  --config .\pilot.local.json `
  --prepare
```

Its separately authorized execution form is:

```powershell
npm run submit:reviewed-handoff -- `
  --file .\test\fixtures\reviewed-handoff\onenote-bootstrap-progress.reviewed-handoff.json `
  --config .\pilot.local.json `
  --execute `
  --authorize-synthetic `
  --authorize-commit `
  --authorize-push `
  --authorize-draft-pr
```

Synthetic input remains synthetic even when real repository operations execute.
This path does not prove source collection, complete FILTER execution or a new
coverage gap. The native skill must still inspect the selected source rather
than assume the fixture's historical gap remains open.

### 1JS fixture qualification and edited-commit repair

The existing Cross-App creation/verification case and Omni AAD blank-workbook
case remain the two baseline shapes; they are not missing fixtures.
`test/fixtures/reviewed-handoff/1js-fixture-qualification.mini-spec-batch.json`
adds six authoring inputs for other execution mechanisms:

| Input | Mechanism to qualify |
|---|---|
| `excel-agent-omni-seeded-workbook` | AAD Omni, deterministic input setup and protected workbook readback |
| `excel-agent-omni-msa-conversation-isolation` | Consumer MSA Omni, exact conversation canary and unchanged workbook |
| `excel-agent-omni-restore-web-source` | Mutable account state, persisted change and original-value restoration |
| `excel-agent-arcadia-local-file-upload` | Registered local CSV fixture, workbook input and exact combined result |
| `excel-agent-arcadia-custom-skill-cleanup` | Authorized, uniquely owned persistent skill resource with paired removal |
| `excel-agent-dedicated-sensitivity` | Dedicated AAD login, Omni, named labeled workbook and read-only assertion |

These are mini-specs, not generated product scenarios, reviewed evidence,
authorization or passed validation receipts. Use them as the qualified
repository skill's input only after the normal routing, registration, account
and side-effect prerequisites are satisfied. Keep incompatible account,
experience and shared-state cohorts serial and independently attributable.
An existing helper or a schema-valid input is not live fixture qualification.
The skill-resource and dedicated-workbook inputs retain their existing
authorization gates. A missing approved profile, principal or resource blocks
that input independently; it must not disappear from the reported inventory.

**Ownership boundary, clarified on 2026-10-20:** controller E2E input JSON and
qualification assets live in this Periodic repository. The five native
qualification reference scenarios and their catalog/capability contracts are
under `test/fixtures/1js-qualification/`. Seeded workbook and dedicated
sensitivity both declare Omni. These references are test source assets, not
runtime evidence or proof that the controller authored or passed a case.

Before a local replay, read the
[fixture account and credential prerequisites](test/fixtures/1js-qualification/README.md).
The consumer MSA conversation fixture requires the approved MSA pair in
`excelendtoendkv` and explicit `--msa-vault excelendtoendkv` selection. Do not
omit that argument, read the CloudTest default vault or request access to it as
a workaround for this fixture. The fixture README lists each account lane,
Omni/Arcadia experience, secret names and the full local MSA command.
It also describes the temporary PUS1/Debug Info experiment and its canonical
1JS recipe, startup-triage evidence, cleanup boundaries and local regression
commands. These are diagnostic options, not permanent fixture or pipeline
defaults, assertion bypasses or substitutes for native business validation.

Do not merge controller-test Draft PRs into 1JS or enable auto-completion.
Generated cases are disposable controller-test outputs. Reusable 1JS runner,
authentication, upload, recovery and evidence-emission fixes are a separate
mergeable 1JS change, without the five qualification cases or their default
catalog, lifecycle and package-command registrations. Controller tests must
still exercise their normal authoring and publication flow rather than copy
these reference scenarios and claim successful model authoring.

The historical native results below were captured before this separation.
Keep their exact revisions and evidence; moving assets does not create new
passes or qualify the final implementation. Future native replays must stage
the reference declarations in an isolated test workspace or a complete external
declaration bundle, including its matching selection/catalog dependencies,
instead of re-registering them in the mergeable 1JS checkout.

Real screenshots, traces, profiles and execution-result JSON belong in local
or CI artifact storage, outside Git tracking. An ignored `test-results`
directory inside a checkout is artifact storage, not repository source.
Retain useful failure evidence for investigation; temporary does not mean
delete it immediately. Only sanitized authored inputs and expected contracts
belong in `test/fixtures`.

The explicit local MSA vault option is not a pipeline credential-source change.
Without that option, retain environment-pair precedence, the original
`ct-onejs-user-prod` fallback, missing-secret behavior and default cache
semantics. Explicit local selection has a separate cache and is rejected under
`CI`, `TF_BUILD` or `BUILD_BUILDID`. Keep the product pipeline definitions,
named-secret declarations, central selection policy and default case inventory
unchanged. Offline credential regressions do not substitute for an actual
feature-branch pipeline run.

**Separation validation (2026-10-20):** the 1JS build, package lint,
85 targeted credential/launcher/interruption regressions and strict product
catalog parity passed. Both focused Periodic qualification tests passed.
All five moved reference scenarios also loaded through the native 1JS
declaration loader and passed capability-matrix validation. The default
product registries and `testConfigurability` match the pre-qualification
baseline; pipeline definitions and central execution policy were not changed.
These are offline checks, not new live fixture or controller qualification
results; no feature-branch pipeline was queued.

**MSA / Omni status as of 2026-10-20: initial account setup verified; fixture
deferred until the Copilot entry is restored.**

This applies to input `excel-agent-omni-msa-conversation-isolation` and generated
1JS scenario `excel-agent.msa.fixture-conversation-isolation`. The real local
setup replay established the following:

- The approved MSA pair from `excelendtoendkv` worked with the existing
  credential provider and login helper. A new isolated browser context had
  zero cookies before login; no enterprise AAD session was reused.
- Authentication through `login.live.com` succeeded. The actual signed-in
  identity shown in the account menu exactly matched the configured MSA user
  in an in-memory comparison. The account-management link pointed to
  `account.microsoft.com`. No account or credential values were recorded;
  avatar initials or photos alone are not evidence of account type.
- A new workbook loaded and FUS1 routing was confirmed. With Omni requested,
  the original 120-second entry probe still returned
  `COPILOT_ENTRY_UNAVAILABLE`. Conversation-isolation and protected workbook
  assertions did not run. A common root cause with pipeline failures,
  including any licensing cause, has not been established.

No account-selection fix is currently required. By agreement, postpone this
fixture until the entry becomes available; retain its Periodic-owned reference
declaration, catalog entry and original business assertions. Then resume normal
live qualification, including five
consecutive retry-disabled passes. This setup replay is not a fixture pass,
a qualified controller binding or proof of the full live evidence-to-delivery
path. The deferral does not add a skip to the generated scenario.

Local evidence is not checked into this repository. Under
`%USERPROFILE%\.copilot\session-state\90092c27-6dea-41b2-a3c4-b4ddccb19208\files`,
see `msa-consumer-replay-20261020-result.json` and
`msa-consumer-replay-20261020-retained.png`. The screenshot shows the loaded
workbook and missing entry, not an expanded account-menu identity proof.

**Dedicated sensitivity / Omni status as of 2026-10-20: migrated and replayed;
blocked before the protected sensitivity assertion.**

Input `excel-agent-dedicated-sensitivity` and generated 1JS scenario
`excel-agent.dedicated.fixture-sensitivity` now select Omni. Dedicated identifies
the `dedicated-enterprise` account lane, not a separate Copilot experience.
The scenario, reviewed catalogs, capability matrix, mini-spec and associated
regression checks agree on Omni. The approved external-service login, original
`clp-labeled` resource, `ENTERPRISE_E2E_ENABLED` authorization gate, 180-second
scenario timeout and protected `sensitivity.visible` contract remain unchanged.

| Check | Actual result |
|---|---|
| Standard native execution | One attempt, workers=1, retries=0; failed after 126818 ms with `COPILOT_ENTRY_UNAVAILABLE` from the original 90-second entry probe |
| Approved identity | A separate retained Chromium replay started with zero cookies; an authenticated SharePoint current-user read returned HTTP 200 and exactly matched the approved dedicated principal in memory |
| Original workbook and deployment | The existing `clp-labeled` workbook opened; the original cluster helper reported actual FUS1 |
| Active flights | The WAC runtime feature dictionary reported `DefaultExcelAgentOmni=true` and `EnableSharedAgentShell=true`, not merely requested URL flags |
| Entry diagnosis | No Copilot-affordance DOM matches were present in the inspected frames; selecting the Home tab did not restore the entry |
| Actual pane experience and protected assertion | Not verified/executed because no Copilot pane opened; active flights alone do not prove a visible Omni experience or a sensitivity pass |
| Five-pass qualification | Not started; no fixture pass, qualified controller binding or full live controller result is claimed |

Build, package lint, configuration formatting, two focused 1JS foundation tests,
strict catalog parity and the focused Periodic mini-spec regression passed.
No credential, fixture URL, workbook content or sensitivity label was changed.
No assertion was weakened, timeout increased or product skip introduced.
The migration does not fix the remaining host-entry problem.

The retained WAC log also contains HTTP 500 for `RoamingServiceHandler.ashx`
and HTTP 404 for `people.ashx`. Neither is established as the cause of the
missing entry. Licensing, tenant policy and a common cause with MSA/pipeline
failures remain unproven. Earlier Edge retention diagnostics ended during
sign-in and are not identity or qualification evidence; the successful
retained identity proof uses the same Playwright Chromium engine as native.
Keep this fixture blocked, rather than treating the MSA deferral agreement as
authorization to defer it or counting this diagnostic as a passing test.

Local evidence remains outside this repository. Under the same session
`files` directory noted above, see `dedicated-omni-final-status-20261020.json`,
`dedicated-omni-retained-chromium-20261020-result.json`,
`dedicated-omni-retained-chromium-20261020.png` and
`dedicated-omni-inspection-20261020.json`. The standard native evidence is in
the 1JS task worktree at
`ooui/apps/excel-agent-declarative-e2e/test-results/excel-agent-local-83e4dce639421f2e`.
The owned Chromium target is retained on local CDP port 9226; the separate
MSA browser on port 9225 is not reused or closed. Resume the original protected
scenario once the entry can be opened for this same account/resource, then
require five consecutive retry-disabled passes on the final implementation.

The local controller regression uses
`1js-validation-repair-drill.json` and its adjacent `.runner.mjs.txt` fixture.
The runner text is copied into a disposable synthetic repository, outside the
model's write allowlist; it is not a product runner or a new supported provider.
The first commit has an incorrect workbook seed and missing state restoration.
The first repair fixes only the seed, so a second commit still fails cleanup.
The second repair restores state, and its new SHA starts a fresh five-pass,
retry-disabled qualification. The protected expected result remains 15 in all
rounds. Each earlier failed commit and its diagnostics remain recorded.

The regression runs real local Git commits, isolated validation processes and
scratch-resource cleanup, but injects model, build and Draft PR boundaries.
Budgets of zero or one repair must leave the remote empty and create neither
build nor Draft PR. Two repairs must publish only the final passing SHA, queue
one non-blocking synthetic build and link it to one synthetic Draft PR.
Owned scratch resources and validation clones must be removed before the next
round, while an unrelated-session sentinel remains unchanged during execution.
This proves controller isolation, not real browser cleanup or product behavior.

For a live edited-commit qualification, diagnose each genuine failure before
editing only the allowed declarations. Do not deliberately corrupt a shared
account or weaken an assertion to manufacture a pass. Preserve the initial and
intermediate failures, derive each repair from its actual native feedback,
and reset per-case consecutive counters whenever implementation changes.
Require five consecutive real passes with workers=1 and retries=0 on the final
implementation SHA, including actual owned-browser cleanup and original-state
restoration. No failed or earlier-revision evidence may authorize publication.

## 8. Reconcile terminal evidence

Require the exact final source/profile identity, actual command exits, expected
case population and terminal results. For the existing two-case OneNote runtime
control, both cases must actually execute. Do not apply that fixed count to a
different suite.

A green pipeline, idle agent, draft PR or successful `--prepare` is insufficient.
Missing cases are not-run or unknown, not passed. Preserve first-attempt and
repair outcomes separately. Keep raw native outputs private; return only the
approved derived evidence with artifact hashes and source provenance.

Assign one monitoring owner and a bounded cadence to each external run. Persist
the request hash, returned handle/build, source/profile/case pins and submission
outcome. An uncertain submission must be reconciled, not blindly resent.
At terminal status, seal the evidence and stop the finite monitor. An unresolved
gate remains blocked; do not merge, enable schedules or create another run
without the required authorization.

### Export and verify the sanitized success proof

After, and only after, the terminal outcome is `draft-pr-validated`, create a
private `e2e-proof-request-v2` that binds the original collection sources,
complete FILTER manifest/results, terminal controller result and the production
app-native run summary. The matching app worker result must use
`sha256:<controller-result-sha256>` as its `evidenceRef`; this keeps the
app-native ledger/summary as the canonical private run record while the tracked
bundle remains the only sanitized public output. Version 1 requests remain
supported only for checking historical proof bundles. Export into a new
immutable tracked directory:

```powershell
npm run pilot -- e2e-proof-export `
  --file .\e2e-proof-request.local.json `
  --output .\e2e-evidence\<run-id> `
  --config .\pilot.local.json

npm run pilot -- e2e-proof-check `
  --file .\e2e-proof-request.local.json `
  --bundle .\e2e-evidence\<run-id> `
  --config .\pilot.local.json
```

Commit only the sanitized bundle. Keep the request, ledgers, raw evidence,
captures, validation logs, local paths and identities private. The checker
requires one revision identity across the worker result, passing validation and
Draft PR head, verifies all hashes, and rejects changed private bindings.

## Executor selection and further references

`repositories[].flights.proposerExecutor` selects `"local"` or `"agency"` for
new work. Follow the [Agency executor contract](AGENCY-EXECUTOR.md)
and qualify the selected runtime before dispatch.

A flight supplies neither credentials nor runtime qualification. Missing Agency
selection blocks instead of silently falling back. Existing or uncertain
assignments retain their original binding; switching backends is not a retry
mechanism. Qualified OA integration execution does not qualify browser E2E.

- [README](README.md): setup behavior, repository skills and validation profiles.
- [App-native contracts](APP-NATIVE.md): collection receipts, batching and held review.
- [Agency contracts](AGENCY-EXECUTOR.md): private execution, budgets and grading.
- [Record schemas](scaffold/contracts.schema.json): exact accepted input shapes.
