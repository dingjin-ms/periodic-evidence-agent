# 1JS qualification fixture prerequisites

These five reference scenarios are Periodic Evidence Agent test inputs, not
default 1JS product cases or evidence of successful qualification. See
[the execution guide](../../../EXECUTION-GUIDE.md#1js-fixture-qualification-and-edited-commit-repair)
for ownership, staging and qualification requirements.

| Scenario | Account lane | Experience | Required local setup |
|---|---|---|---|
| `excel-agent.aad.fixture-seeded-workbook` | Ordinary enterprise AAD (`aad-enterprise`) | Omni | Approved signed-in enterprise browser through `EXCELAGENT_CDP_ENDPOINT`; new test-owned workbook |
| `excel-agent.aad.fixture-web-source-restoration` | Ordinary enterprise AAD (`aad-enterprise`) | Omni | Approved enterprise CDP session; permission to change and restore the Web source setting |
| `excel-agent.aad.fixture-local-file-upload` | Ordinary enterprise AAD (`aad-enterprise`) | Arcadia | Approved enterprise CDP session; registered CSV resource and new test-owned workbook |
| `excel-agent.msa.fixture-conversation-isolation` | Consumer MSA (`consumer-msa`) | Omni | MSA credential pair in `excelendtoendkv`, explicit vault selection and isolated credential login |
| `excel-agent.dedicated.fixture-sensitivity` | Dedicated enterprise AAD (`dedicated-enterprise`) | Omni | Original dedicated credential provider and `clp-labeled` workbook; `ENTERPRISE_E2E_ENABLED=1` |

## Required vault for the local MSA fixture

For `excel-agent.msa.fixture-conversation-isolation`, use the approved
`excelendtoendkv` vault with both secrets:

- `EXCELAGENT-MSA-USER`: the approved consumer MSA test account.
- `EXCELAGENT-MSA-PASSWORD`: that account's password.

The Azure identity used by the existing local credential provider needs secret
read access to this vault. Use a shell without `EXCELAGENT_MSA_USER` or
`EXCELAGENT_MSA_PASSWORD` environment credentials: explicit vault selection
rejects either variable rather than mixing sources. The consumer MSA pair is
not the dedicated enterprise pair, even though both are hosted in the same
vault.

From the qualified 1JS checkout's OOUI root, after configuring
`EXCEL_AGENT_DECLARATION_ROOT` to a complete staged declaration bundle:

```powershell
yarn workspace @1js/excel-agent-declarative-e2e declarative:local --case excel-agent.msa.fixture-conversation-isolation --lane consumer-msa --auth credentials --msa-vault excelendtoendkv --experience omni --repeat 1 --max-failures 1
```

This fixture directory alone is not a complete runtime declaration bundle.
Include the matching 1JS resources, UI map, composites, signals and
selection/catalog dependencies when staging it; do not register qualification
cases in the default product inventory.

**Do not omit `--msa-vault excelendtoendkv`.** Credential login without this
option retains the provider's environment-first behavior and CloudTest default
`ct-onejs-user-prod`; that is not the credential source provisioned for this
local fixture. Do not read that vault or request access to it as a workaround.
The explicit local selector already exists; do not change the cloud pipeline's
default to run this fixture.

The launcher records the selected vault in `selection.json` as
`msaVault: "excelendtoendkv"` and clears inherited CDP authentication for
credential runs. Check that selection before interpreting the result. A vault
failure must not silently select another vault or account. Successful credential
resolution is only a prerequisite, not a passing conversation or workbook
assertion.

Keep credentials, account identifiers, private workbook URLs, screenshots,
traces and execution logs out of source control. Cluster selection is separate
from credential selection; a temporary PUS1 experiment must not become a
permanent fixture or pipeline default.

## Temporary FF startup alternative: PUS1 and Debug Info

The 2026-10-22 local qualification used requested PUS1 routing when the normal
FF/FUS1 entry path was failing. The canonical recipe is in the qualified 1JS
checkout's `ooui\apps\excel-agent-declarative-e2e\declarative\README.md`,
under **Temporary PUS1 and visible-mode diagnostics**.

The baseline does not enable PUS1 simply by setting an environment variable.
That recipe requires three isolated, local-only source edits, rejects CI and
non-production declarations, and leaves the default cluster order unchanged.
Use a complete staged production declaration bundle and a new evidence root;
do not change the canonical fixtures' business contracts to reach another
cluster. Do not commit or push those temporary source edits.

The experiment enables
`Microsoft.Office.Excel.FA000000124.TestGate.AuroraDebugInfo` only in the
explicit PUS1 launcher path. This exposes the real visible Omni/Arcadia
indicator when Settings does not show mode radio controls. It does not force
a successful observation: mode detection and runtime guards must still pass
unchanged. A URL containing `wdwaccluster=PUS1` proves requested routing only;
record separately whether the serving cluster label was actually observable.

After the run, restore only the experiment's source hunks and environment
settings, preserving other work. An experimental pass does not establish
FF/FUS1 health, multi-round reliability or a fix for a previous startup error.

## Local verification and reusable investigation lessons

Run the five account/experience cohorts serially with one worker and retries
zero. Retain each attempt's source commit, declaration hash, selection,
summary, protected-contract result and cleanup result. Confirm the selected
vault and actual visible experience before interpreting business results.
Keep workbook identities fixed for dedicated fixtures; do not replace an
account or workbook to work around a failure.

Use the failing phase to select the next investigation:

| Phase | Evidence and interpretation |
|---|---|
| Credential selection | Check the approved vault in `selection.json`; do not infer a need for access to a different vault. |
| Login or Hub navigation | Capture sanitized document errors and navigation timing. A loading logo or successful credential read is not proof of login or fixture success. |
| Experience detection | Use the real visible mode indicator; Debug Info aids observation, not assertion bypass. |
| Business contract | Preserve exact cell values, conversation assertions and observation windows. An app-opening probe cannot qualify them. |
| Cleanup | Confirm Web source restoration, conversation cleanup, resource-lock release and owned-page/context cleanup as applicable. Never close a shared browser or unrelated tabs. |

The MSA diagnostic observed an HTTP/2 error in an intermediate login redirect,
but did not reproduce the original native Hub failure; the subsequent native
fixture passed without a permanent startup change. Preserve that distinction
instead of declaring a proven root-cause fix or adding blind retries.
Native workbook setup can still fail after a schema-valid controller input or
a successful startup probe.
Test discovery and imports may precede the first `START` line by several
minutes; inspect the existing process and logs rather than launching a
duplicate run because startup is quiet.

For a new regression round, run the 1JS README's workspace build, full
declarative unit suite, strict catalog parity, focused Cross-App contract suite,
lint and changed-content formatting checks with experiments removed. From
this repository's root, use Node.js 24+ and `npm run check` for the complete
offline controller checks. Use Yarn in 1JS, not npm. Reuse compatible trusted
dependencies without replacing current-worktree source; only restore
dependencies after a missing-dependency failure. Record blocked bootstrap or
dependency failures separately from test failures.
Keep independent jobs' output directories separate. Check worktree status
after offline tests too: synthetic checkpoint PNGs can be written outside
the normal results directory. Preserve them as local artifacts and clean up
only files whose ownership and replacement copy have been verified.

These checks supplement the five real fixture runs. Neither an offline check
nor a later successful attempt erases an earlier failure or establishes
complete cloud/no-regression coverage.

## Windows offline CI diagnostics

The offline workflow runs `pilot`, `remaining` and `demo` on separate hosted
VMs. Launching all three concurrently on one shared development machine is
not the same resource topology. Run local groups serially when investigating
contention, but preserve `scripts\ci-tests.mjs` file concurrency of four for
a standard group result. A single-case or concurrency-one diagnostic is not
a replacement for a complete passing group.

Two inherited Windows settings affected the 2026-10-22 local run:

| Symptom | Controlled diagnostic |
|---|---|
| SQLite `ExperimentalWarning` contaminates a CLI stderr JSON assertion | Append `--disable-warning=ExperimentalWarning` to the test process's `NODE_OPTIONS`; do not suppress other errors. |
| Synthetic Git fixture staging rejects LF under inherited strict CRLF settings | Append a process-only `core.safecrlf=false` Git configuration entry; do not change global configuration or use this override for real source commits. |

Use these overrides only after identifying the corresponding failures.
From a **fresh PowerShell process** at this repository's root, the following
preserves existing options and Git entries and writes a new evidence directory:

```powershell
$env:NODE_OPTIONS = ($env:NODE_OPTIONS + ' --disable-warning=ExperimentalWarning').Trim()
$count = 0
if ($env:GIT_CONFIG_COUNT) { $count = [int]$env:GIT_CONFIG_COUNT }
[Environment]::SetEnvironmentVariable("GIT_CONFIG_KEY_$count", 'core.safecrlf')
[Environment]::SetEnvironmentVariable("GIT_CONFIG_VALUE_$count", 'false')
$env:GIT_CONFIG_COUNT = [string]($count + 1)
$revision = git rev-parse HEAD
if ($LASTEXITCODE -ne 0) { throw 'Cannot bind offline evidence to the source revision' }
$env:GITHUB_SHA = $revision.Trim()
$output = Join-Path $env:TEMP ('pea-ci-remaining-' + [guid]::NewGuid().ToString('N'))
Write-Host "Evidence: $output"
node scripts\ci-tests.mjs remaining $output
if ($LASTEXITCODE -ne 0) { throw "Offline CI failed; retain evidence at $output" }
```

Close that shell afterward; environment overrides are process-scoped, not
PowerShell block-scoped. Record the overrides with the result. Such a run is
not an unmodified hosted-environment pass, and these settings do not resolve
every failure: the controlled run still had native descendant, preparation
evidence and RSI budget failures.

Preserve `tests.tap`, `summary.json`, source revision, Node version, selected
file catalogue, concurrency, resource snapshots and all failed attempts.
Check exit status, complete TAP counts, failures and cancellations together;
do not combine successful cases from different failed rounds into a green
matrix. Nested tests may not execute after an early parent failure, so a
fixed total test count alone does not establish complete coverage.

For an RSI budget failure, compare the exact master and candidate with
matching physical dependency layouts and unchanged deadlines/assertions.
Retain diagnostic RSI state locally; inspect existing SQLite ledgers read-only
and compare the actual loaded controller/skill/lock identity, synthetic Git
trees and trusted flow-plan bytes. Identify the precise arm, episode and
phase deadline. An unchanged test file alone is insufficient attribution;
identical executable inputs still do not prove an external timing cause or
turn a timeout/unknown guard result into a pass. Do not increase production
budgets, weaken guards or blindly rerun complete suites to obtain green.

For native PUS1 evidence, preserve both the original reference hash and the
temporary input hash. The recorded production deployment selector changes
the YAML bytes: verify the native selection hash and that the only parsed
change is `environment.deployment: production`, rather than claiming the
temporary input is byte-identical to the committed default.
