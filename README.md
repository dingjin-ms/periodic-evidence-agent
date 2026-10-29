# Local evidence-to-draft-PR pilot

**Experimental controller; live execution requires separate authorization.** A local
durable ledger and deterministic helpers for independent logical agents.
The primary pilot is manually driven by authenticated Copilot app tools; no
standalone SDK authentication, listener, account or conversation is needed for
the offline demo. Live collection, review, dispatch and scheduling default off.
An explicitly configured official local WorkIQ CLI transport is also available
for authorized collection-only runs. It is not a fallback from failed app auth;
see [the CLI contract](APP-NATIVE.md#explicit-local-workiq-cli-collection).
Token-renewal and unattended qualification remain deferred.
For a finite operator-driven Collector -> FILTER -> Proposer -> RSI attempt,
see [Running the agentic loop with RSI enabled](scaffold/RSI-RUNBOOK.md).
It separates capture-only opt-in, app-hosted continuations, paired evaluation
and optional draft publication; it does not promise a one-command live loop.
Budget-stopped channel scans can prepare a distinct, explicitly authorized
continuation run without refetching captured pages or losing buffered rows.
Root/reply context and an opt-in modified-time lane are documented in
[the continuation contract](APP-NATIVE.md#budget-stopped-continuation). Neither
feature authorizes additional live reads, automatic schedules or a delta feed.
IcM connector receipts can be replayed **offline** into a separate audit store.
An explicitly approved [incident-created cohort](APP-NATIVE.md#explicit-incident-created-icm-receipts)
can ingest captured identity/search receipts through `app-append`; helpers do
not launch its live connector. Default saved-query scope remains fail-closed.
[Held Stage2 handoffs](APP-NATIVE.md#held-stage2-coverage-handoff) require
the installed coverage-analysis skill and pinned reference, read source ledgers
read-only, and cannot authorize product dispatch.

[Bounded one-shot controls](ONE-SHOT.md) add coordinator-callable aggregate
collection/FILTER reservations, offline recovery and complete accepted-cohort
release to the existing helpers. They preserve authenticated WorkIQ provenance
in collection-only storage and keep saved replay distinct. The coordinating host
still supplies the authorized external FILTER executor; this is not a standalone
service or qualified unattended end-to-end run.

[Reusable local SDK orchestration](LOCAL-E2E.md) executes a complete approved
FILTER manifest, exports/reconciles immutable results, requires independently
bound semantic review and releases one normal local Proposer through Draft PR.
Explicit retry-config preparation and durable resume replace per-run private
scripts; collection, qualification and authentication gates remain separate.

## Account-free quick start

Prerequisites: **Node.js 24 LTS**, npm and Git on PATH. Windows PowerShell is
the primary supported shell. From a clean checkout of the selected public branch:

```powershell
Set-Location .\periodic-evidence-agent
npm ci --ignore-scripts
npm test
npm run demo
```

Use a normal clone of this repository, select the intended published revision,
and record `git rev-parse HEAD`. Public `master` is not evidence that a feature
branch has landed. Never copy a development `.git` directory or private runtime.
See the [execution guide](EXECUTION-GUIDE.md) for the separately gated live path.

No Copilot CLI, Azure CLI, WorkIQ sign-in, product checkout or credentials are
needed for these commands. Dependency download needs access to the configured
npm registry. Tests and the demo themselves make no live source/model calls.
Tests use synthetic evidence and disposable temporary Git/SQLite workspaces.
Node may print an experimental SQLite warning.
The lockfile uses canonical npm registry URLs and pinned integrity hashes. On
networks that block the public registry, configure your organization's approved
npm mirror (for example with `npm_config_registry`) before `npm ci`; do not
disable TLS verification or copy another user's npm credentials.

The explicitly invoked `npm run benchmark:fingerprint -- --output <absolute-new-file>`
measures local synthetic controller/fingerprint workloads, including event-heavy
warm verification and independent full-fresh equivalence. It is not part of
setup, the periodic agent or default CI, and is not real OfficeAgent E2E proof.
See the [measurements, limits and guardian decision](scripts/validation/FINGERPRINT-PERFORMANCE.md)
and the `local-fingerprint-benchmark` skill before running it.

### Local CI when hosted Actions is budget-blocked

If GitHub Actions cannot start jobs because the account has exhausted its
Actions budget, reached its spending limit or has a payment restriction, use
**complete local CI as the validation fallback**. Confirm the job annotation
and whether any steps executed; do not keep retrying an unchanged account
restriction or stop the code task solely because hosted runners are unavailable.
An actual test failure is not a budget fallback: investigate and fix it.

Run from the task's own clean worktree at the committed revision being validated;
never reset another task's checkout. Use Windows with PowerShell 7 (`pwsh.exe`),
Node.js 24, npm and Git on PATH, and the locked dependencies.
On a fresh checkout, restore them with `npm ci --ignore-scripts`;
reuse an existing valid installation rather than reinstalling unnecessarily.
The workflow reference is [offline.yml](.github/workflows/offline.yml).

Run the matrix groups **sequentially on the local machine**, not simultaneously
as separate jobs sharing that machine. Keep the runner's file concurrency,
timeouts and assertions unchanged. The commands below run the complete discovered
test catalogue and keep reports outside the checkout:

```powershell
$ErrorActionPreference = 'Stop'
$env:GITHUB_SHA = (git rev-parse HEAD).Trim()
if ($LASTEXITCODE -ne 0) { throw 'Cannot identify the validation revision' }
$reports = Join-Path ([IO.Path]::GetTempPath()) "periodic-evidence-ci-$([guid]::NewGuid().ToString('N'))"
New-Item -ItemType Directory -Path $reports | Out-Null
Write-Output "Local CI reports: $reports"

node --check src\cli.js
if ($LASTEXITCODE -ne 0) { throw 'CLI syntax check failed' }
npm run check:package
if ($LASTEXITCODE -ne 0) { throw 'Package check failed' }

foreach ($group in @('pilot', 'remaining', 'demo')) {
    $directory = Join-Path $reports $group
    node scripts\ci-tests.mjs $group $directory
    $exitCode = $LASTEXITCODE
    Get-Process | Select-Object Id, ProcessName, CPU, WorkingSet64 |
        ConvertTo-Json -Depth 3 |
        Set-Content -LiteralPath (Join-Path $directory 'processes.json') -Encoding utf8
    if ($exitCode -ne 0) { throw "Local CI group failed: $group; preserve $directory" }
}

npm run demo
if ($LASTEXITCODE -ne 0) { throw 'Standalone synthetic demo failed' }
```

The pilot group includes `test/pilot.test.js` and the adjacent
`test/pilot-*.test.js` files. They run in separate test-file processes under the
same four-file concurrency limit; cases within each file remain sequential.
The shared module at `scripts/test-fixtures/pilot.mjs` defines fixture factories,
not shared workspaces: every case retains its own setup, teardown and budgets.

Keep each group's `summary.json`, `tests.tap` and process snapshot, including
failed attempts. A successful subset or focused rerun is not complete local CI:
all three complete groups must pass, with no failed or cancelled tests. Check
that their source revision and catalogue hashes agree and their selected files
cover the discovered catalogue exactly once. Explain existing conditional skips;
do not add skips, extend budgets or weaken checks to obtain a green result.
Investigate any failure, fix its cause and rerun the affected complete group.
After a source fix, complete the full local CI at the updated revision before
final acceptance; do not combine passing reports from different source revisions.

Record the validated commit, Node version, per-group counts and exit status,
standalone demo, syntax and package results in the PR or handover. Keep raw
runtime reports local; publish only sanitized aggregate evidence. Report
**local CI passed; hosted CI blocked by account budget** when applicable, not
"GitHub Actions passed." This fallback does not override required branch
checks or authorize Draft publication, auto-complete or merge. Retry hosted CI
when runner eligibility is restored, not in an unbounded billing-error loop.

## Offline self-improvement qualification

The opt-in `self-improvement` command qualifies one recovery harness and renders
a source-bound before/after scorecard. It is **not autonomous self-modification**:
both arms execute the same reviewed current controller, retaining its existing
recovery capabilities. Equal correct results mean `harness-qualified` and
`no-demonstrated-benefit`, not an improvement in live recovery or agent behavior.

The fixed `validation-continuation-v1` fixture exercises the existing
`prepareLocalValidationContinuation` and `dispatchLocalValidationContinuation`
helpers against disposable local Git repositories and controller stores. The
independent parent observes two real native assertion cases and simulated
publication boundaries. No model, provider, credentials, product repository,
installed skill, real push or PR is involved.

Start from the inert [policy example](scaffold/self-improvement.example.json).
It requires explicit finite execution/output/storage limits, a retained state
owner, and a named child of this checkout's ignored `.state/rsi`. Execution
approval is false by default. See the [command and ownership contract](APP-NATIVE.md#offline-self-improvement-qualification)
and the [comparison review requirements](CONTRIBUTING.md#self-improvement-review-evidence).
This checkout must retain authoritative state through review and follow-up;
there is no automatic cleanup, archive transfer, candidate promotion or rollout.

## Devbox repository setup

An isolated validation-preparation preflight can inspect an already authored,
sealed blocked declarative assignment without collection, authoring, browser
execution, publication or ledger mutation:

```powershell
node scripts\validation\preflight.mjs --config pilot.local.json --assignment <existing-id> --output <fresh-receipt.json> --workspace <fresh-absolute-path>
```

The receipt persists each preparation phase, exact source/profile/controller
hashes, dependency byte verification and native loading, typecheck and case
selection. Optional repeated `--sparse-path <directory>` arguments evaluate a
bounded checkout closure; they do not change the formal live configuration.
New preflights require a fresh direct child of
`<stateDirectory>\preflight-workspaces`. A passed preflight retains its exact
detached worktree through a persistent validation-handoff reference; passing is
not permission to release it. It cannot count toward the five native product
passes or authorize publication. Git objects
are shared, while the validation worktree has its own HEAD/index and independently
copied, link-rebased dependency outputs. Windows preparation commands use the
owned Job Object boundary and confirm process-tree exit before cleanup; failures
retain the primary preparation phase separately from cleanup failures.
To reverify a completed preflight without recopying outputs, supply its receipt
with `--prepared-receipt <previous-receipt.json>`, the same `--workspace` and a
fresh `--output`. This rereads source and isolated dependency bytes, checks the
unchanged sealed assignment, and reruns native preparation checks; no previous
pass or byte hash is trusted without revalidation.

### Owned resource lifecycle

New detached declarative validation worktrees and preflights carry durable
assignment/attempt ownership, namespace/directory/Git-owner identities, references
and a phase journal under `<stateDirectory>\resource-lifecycle`. Validation
claims the exact preflight once and releases it only after the complete native
batch, runner-tree exit and external execution evidence. Failed preflights release
only their own unconsumed handoff. To explicitly abandon a successful unused
handoff, use `resource-abandon-preflight --resource <receipt-resource-id> --config
pilot.local.json`. Legacy receipts without lifecycle ownership remain usable but
their workspaces are retained, never automatically adopted.

CLI startup and each coordinator tick reconcile the declared namespaces, including
owned residual directories without `.git` or Git registration. Unknown ownership,
live references, unconfirmed process exit, replacement directories, linked parents
and wrong Git owners remain blocked with a separate reconciliation/cleanup record.
Interrupted moves, exact Git deregistration and cache deletion resume by directory
identity; no global Git prune or recursive workspace-root deletion is used.
The primary execution error is retained separately from cleanup failures.

Retirement first preserves hashed evidence outside the workspace, moves the
directory into a private same-volume `resource-archives\<resource-id>\snapshot`,
and unregisters only the original secondary worktree. Only explicitly declared,
ignored, untracked regenerable cache directories are removed without following
links. Validation declarations come from the verified dependency seed; other
files, including undeclared cache-shaped directories, remain in the snapshot.
The archive has an independent recovery manifest; coding tasks additionally
retain a verified `history.bundle`. Nonterminal lifecycle references protect
ordinary run evidence from retention pruning. Existing sealed/native receipts
are not rewritten or adopted.

The repository previously had no callback for arbitrary host CLI task completion:
worker `finally` and the author-clone `workspace-gc` are not such callbacks.
For **Controller-owned coding tasks**, `task-run --file task.local.json --config
pilot.local.json` creates a fresh task worktree and runs the requested coding
command under native process containment. The request provides absolute `source`
and `executable`, exact `revision`, new `branch`, `args`, `timeoutMs`, and optionally
explicit relative `cachePaths`. Choose a state directory outside that source
checkout. The runner receives `PILOT_TASK_RESOURCE_ID` and an external
`PILOT_TASK_CLOSE_REQUEST` path. A handoff written there is consumed automatically
after process-tree exit; a later host close can instead call
`task-close --file task-close.local.json --config pilot.local.json`.

Task close binds `resourceId`, GitHub `repository`, PR `number`, delivered
`revision`, and external `{ path, sha256 }` validation/handover receipts. These
receipts respectively use formats `coding-task-validation-v1` (`status: passed`)
and `coding-task-handover-v1` (`status: complete`), with matching repository,
number and revision. Close retains a merge reference while the PR remains open
or Draft. Startup/tick monitors perform **read-only** `gh pr view`; only a merged,
same-head PR with successful checks, completed handoff, confirmed runner exit and
clean exact-revision task worktree can be archived/unregistered automatically.
No command publishes, merges or enables auto-complete. Unregistered host CLI
sessions, pre-existing task worktrees, product test Draft PRs, shared seeds and
other tasks remain outside this lifecycle's authority.

This optional full product-development setup is not a prerequisite for the
local controller's existing-Agency FILTER path. Account-free pilot checks above
need no product checkout. Configure product repositories only for authorized
repository work; E2E setup is separate from the integration-first milestone.

From a new clone, install locked dependencies, initialize machine-local product
checkouts, qualify repository skills, run configuration diagnostics, execute the
complete offline check and run the synthetic demo with one command:

```powershell
npm run setup
```

The top-level command runs `npm ci --ignore-scripts`, then delegates repository
initialization to `npm run setup:repos`, runs `doctor`, `npm run check` and
`npm run demo`. The repository layer uses `pilot.local.json`, which is ignored
by Git. By default it selects every configured repository that declares at
least one `skillBinding`; no OfficeAgent-specific setup code exists. Add another
repository and its skill bindings to the configuration and the same command
includes it automatically. Use repeated `--repo` values to select a subset:

```powershell
npm run setup -- --repo office-agent --repo another-repo
```

Setup reuses a valid configured checkout or discovers one from explicit and
common local roots. It does not clone implicitly. On a new devbox where a
selected repository is absent, explicitly allow cloning:

```powershell
npm run setup -- --allow-clone --clone-root D:\repos
```

For diagnostics or development, rerun only the repository layer without
reinstalling dependencies or running the full offline suite:

```powershell
npm run setup:repos -- --repo office-agent
```

The command verifies Node.js 24+, checkout origins, remote default branches,
exact base revisions, repository skill paths and skill content fingerprints.
It does not install product-repository dependencies, authenticate accounts,
enable routing/write permissions or create PRs.

### Azure CLI sign-in recovery

`blocked-auth` during ADO repository qualification or collection requires a
usable local Azure CLI session for the configured tenant and designated user.
Windows sign-in, login on another machine, or working package-feed access does
not establish that session. Setup does not log in automatically or change the
configured identity.

Outside a managed Codespaces authentication environment, first check
`Get-Command az` and `az version`. If an existing Azure CLI installation is
absent from this process PATH, open a new shell or add its verified directory
to this shell's PATH only. Do not reinstall it or change machine-wide settings
solely because command lookup failed. In Codespaces, follow the repository's
broker recovery instructions rather than replacing its shim or running login.

For Windows WAM login that waits indefinitely or reaches unrelated subscription
selection, use an Azure CLI whose `az login --help` lists
`--skip-subscription-discovery`. In a new PowerShell session, run the following
manually from this controller checkout and complete any sign-in/MFA:

```powershell
$config = Get-Content .\pilot.local.json -Raw | ConvertFrom-Json
$tenant = $config.identity.tenantId
if (!$tenant) { throw 'An approved configured tenant is required' }
$env:AZURE_CORE_ENABLE_BROKER_ON_WINDOWS = 'true'
$env:AZURE_CORE_LOGIN_EXPERIENCE_V2 = 'off'
az login --tenant $tenant --scope https://graph.microsoft.com/.default `
  --skip-subscription-discovery --output none
if ($LASTEXITCODE -ne 0) { throw 'Interactive sign-in did not succeed' }
az account show --output none
if ($LASTEXITCODE -ne 0) { throw 'Azure CLI account is unavailable' }
az ad signed-in-user show --output none
if ($LASTEXITCODE -ne 0) { throw 'Signed-in Graph user is unavailable' }
```

These settings affect only this shell and its children. On Linux/macOS, use the
supported browser or device-code flow with the same tenant/scope/discovery
arguments, omitting the Windows WAM setting. Skipping subscription discovery
does not skip sign-in, MFA, conditional access, ADO authorization, or the
controller's tenant/user checks. A successful Graph check alone is not an ADO
access receipt. Never change the configured identity to accept the wrong
account, print tokens, copy credential caches, or clear shared caches.

After manual sign-in, retry the selected setup once. If this controller's
locked dependencies are already installed:

```powershell
npm run setup -- --repo 1js --skip-install
```

`--skip-install` skips only controller dependency installation, not repository
qualification, diagnostics, offline checks or the synthetic demo. If access
still fails, preserve the safe failure and stop rather than cycling through
login modes. This sequence recovered a Windows session; it does not establish
the cause of an earlier timeout.

If qualification instead reports `The empty string is not a valid path` after
fetch, inspect the Git invocation: Windows Git can reject
`-c core.hooksPath=`. Preserve and report that compatibility failure rather than
reauthenticating or changing global Git configuration. This documentation-only
change does not modify the controller's Git wrapper.

### 1JS local setup and validation

These notes apply only after an authorized assignment has supplied the exact
isolated product checkout, base revision and validation bounds. They do not
activate the optional 1JS authoring binding or authorize product execution.
Keep local paths, identities and credentials in ignored machine-local
configuration, not in this repository's documentation or PRs.

Read the active checkout's root/OOUI instructions, workspace-configuration skill
and selected application's README first. Use the active branch's paths rather
than copying paths from another revision. The controller requires Node 24;
the product checkout's own runtime requirements remain independent.

Run product package-management commands with its repository Yarn, not this
controller's npm. Before installation or building, inspect the active tasks
and obtain confirmation for exact existing dependency/generated directories
they will replace. Build dependencies can regenerate tracked sources in
addition to cleaning compiled outputs. Approval in another worktree does not
cover this checkout or newly discovered cleanup paths.

When the selected checkout supports these standard commands, run from its
OOUI root, with the package name validated against its manifest:

```powershell
$package = "<approved-package-name>"
yarn fast "$package" --skip-prestart
yarn build --to "$package"
```

Omit `--skip-prestart` when the next step needs development-server prestart.
Use the selected application's actual scripts for typecheck, static validation
and local unit tests; do not invent script names or replace the standard build.

- **Separate authentication chains.** Azure CLI/ADO qualification, Yarn
  package-feed access and the product browser account are independent checks.
  On an actual package-feed `E401`, including one from a build dependency's npm
  subprocess, run the repository's `yarn auth` in the same checkout/profile and
  retry the failed command once. Do not use another npm login, copy credentials
  from another machine or repeatedly reinstall for a later-stage failure.
  `yarn auth --skip-check` can reuse a cached token; it does not guarantee a
  new token or sufficient lifetime for a long installation. Timed experiments
  retain their own declared validity checks; do not weaken them or omit auth time.
- **Missing build outputs.** Missing workspace `lib` entrypoints or type
  definitions can mean installation succeeded but compilation is incomplete.
  Build the normal dependency closure, not hand-made links, source aliases or
  another checkout's outputs. If root repository tooling itself cannot resolve
  a required configuration package, diagnose root tooling separately. A root
  restore can replace dependencies and change scope/project references; do not
  run it without inspecting its effects and obtaining required approval.
- **Windows generated-file staging.** For `CRLF would be replaced by LF`,
  inspect the affected paths' Git attributes and effective line-ending
  settings. Only after verifying that every affected normalized Git blob equals
  HEAD, use a narrowly process-local `core.safecrlf=warn` override if needed
  for the standard staging step. Preserve existing process Git configuration
  entries. Do not alter global/repository settings, bypass hooks, set CI to
  skip checks or ignore actual generated-source differences.
- **Missing local test browser.** Local Playwright DOM fixtures can need
  Chromium headless shell without being product E2E. Only after an actual
  missing-executable failure, use the selected package's installed Playwright
  and the same profile/browser-cache environment as the test. When that
  application's tooling supports it, run the following from OOUI, then retry
  its documented unit command:

```powershell
$env:PLAYWRIGHT_SKIP_BROWSER_GC = "1"
yarn workspace "$package" playwright install chromium --only-shell
```

The browser setting affects this shell and prevents install-time garbage
collection of other browser versions. Do not clear shared caches or pin a
revision copied from another checkout. A headless-shell install does not set
up the full product browser or CDP session.

Record the exact checkout revision, command, exit status and pending/failed
stages. Installation, build, typecheck, static validation, unit tests and test
discovery are not proof of a real product E2E pass or installation-performance
target. Product E2E still needs its approved deployment, accounts, secrets,
flights and browser/CDP prerequisites. Neither another checkout's results nor
an offline controller demo qualifies this checkout or a new native experiment.

### Offline demo coverage

The demo prints JSON with these stable collection fields (excerpt; paths,
timestamps and generated fixture commits vary):

```json
{
  "result": "synthetic-demo-passed",
  "provenance": "synthetic",
  "passes": [
    { "pass": "ado:created", "state": "complete", "evidenceCount": 1 },
    { "pass": "ado:changed", "state": "complete", "evidenceCount": 1 },
    { "pass": "workiq:created", "state": "complete", "evidenceCount": 2 },
    { "pass": "icm:created", "state": "unavailable", "evidenceCount": null }
  ],
  "uniqueEvidence": 3,
  "overallCollectionState": "partial-or-blocked",
  "collectionWorkers": 0,
  "scheduleEnabled": false
}
```

`synthetic-demo-passed` means fixture assertions passed, **not** a successful live
dry run. IcM deliberately stays unavailable; unknown coverage is not zero.
The demo imports a root and an in-window reply to an older root, replays a batch
without duplicates, then closes/reopens the ledger. It checks synthetic provenance,
cursor completeness and absence of dispatch **from that incomplete collection**.
It then exercises FILTER and a separately authorized synthetic proposer fixture:

| Stage | Required assertions before the demo can pass |
|---|---|
| FILTER | Pack all three records into two complete-context batches; reject missing sharing approval and insufficient batch budget; validate exact payload and detail membership; consolidate duplicate candidates across batches and select the higher-ranked gap. |
| FILTER negative cases | Missing, partial or conflicting results cannot select a candidate; stale payloads and omitted details are rejected; complete no-candidate results remain unselected. No provider execution or semantic-analysis qualification is claimed. |
| Synthetic handoff | Direct production handoff of synthetic collection evidence is rejected. A new, explicitly synthetic `reviewed-handoff-v1` fixture pins the selected candidate and original manifest/result hashes without changing the collection ledger. Missing synthetic/commit/push/draft authorization is rejected before preparing a job. |
| Local proposer | Load a qualified skill from a disposable Git repository, enforce edit bounds, deterministically author a test of the fixture's real selection function, commit locally and execute real behavior and syntax gates in isolated validation checkouts. |
| Publication guards and recovery | An intentionally failing assertion and a separately injected stale-head result must both block before publication. Only the passing exact-head case reaches mocked push/draft callbacks. Reopening each ledger must still reject duplicate dispatch. |

`workflow.filter` reports the held structural result, not a qualified fresh
execution cohort: the original source coverage remains incomplete.
`workflow.proposer` reports three isolated fixture attempts (failed validation,
stale head, success), their real gate artifacts and simulated publication counts.
The successful controller outcome is `draft-pr-validated`, but its draft URL is
`example.invalid`: **no model, source service, product repository, real push or
real PR is used**. Deterministic FILTER analysis/token counting and model authoring
are fixtures; existing controller, ledger, skill, Git and validation APIs run.
This is not unattended live E2E qualification or a bypass of the fresh-cohort guard.

Each invocation writes only its own disposable `.state\demo-*\` directory inside
the checkout, including the original collection summary, FILTER artifacts,
fixture checkouts and `workflow-summary.json`. The example and saved collection
config remain inert; synthetic dispatch is enabled only in an in-memory fixture
configuration. Node.js 24+, Git and (on Windows) PowerShell 7.3+ are required.
Windows must retain `PATHEXT` including `.EXE`; the demo rejects its absence and
also requires actual behavior-test output, not merely a zero process exit.
The production Windows native runner likewise fails closed on missing/empty or
unusable `PATHEXT`, requires application resolution and a process exit code,
and preserves legitimate silent successful commands. It does not invent
environment defaults or treat nonempty output as proof of success.
To clean up, remove only the specific demo directory printed by that invocation,
never the whole `.state` tree.

## Explicit Teams notifications

Use the **`send-teams-notification`** project skill for an explicitly authorized
channel message from any task or agent, not only an evidence workflow. It wraps
the sender below, accepts approved text/links and an optional user mention, and
uses stable shared receipt paths to prevent blind repeat sends. For example:
"Use send-teams-notification to post this task's result to the configured
channel and mention me." See
[the skill](.github/skills/send-teams-notification/SKILL.md) for inputs,
reconciliation and use from another project. Skill availability does not grant
the caller Azure permissions or enable automatic notifications.

`scaffold/teams-notification.workflow.json` defines a dedicated Consumption
Logic App that posts Adaptive Cards as Flow bot to one configured standard
channel. Deploy it separately with an approved Teams API connection, explicit
`teamId`/`channelId` parameters, narrow Entra OAuth trigger policies and SAS
authentication disabled. Do not replace an existing Sherlock workflow or its
notification routes. The caller needs an authorized Azure CLI identity and
permission to read the workflow and its callback URL.

Keep deployment identifiers in a gitignored `teams.local.json`:

```json
{
  "enabled": true,
  "workflowResourceId": "/subscriptions/SUBSCRIPTION/resourceGroups/GROUP/providers/Microsoft.Logic/workflows/WORKFLOW",
  "identity": { "tenantId": "TENANT_GUID", "objectId": "USER_GUID" },
  "teamId": "TEAM_GUID",
  "channelId": "19:CHANNEL@thread.tacv2"
}
```

This is repository-local configuration, not a Copilot session artifact. The
repository command defaults to `teams.local.json` next to `package.json`, even
when its script is invoked from another working directory. Receipts default to
`.state\teams-notifications\<notification-id>.receipt.json` relative to that
configuration. If multiple worktrees share one live deployment, explicitly set
`stateDirectory` in each private configuration to the same approved absolute
directory so all callers consult the same receipts. Never reset that directory
when starting a new agent session or preparing a new task checkout.

An explicitly authorized notification is a JSON file with a stable `id`,
`text`, optional `test: true`, and optional `mention: { "id": "USER_GUID",
"name": "Display name" }`. Send it once with:

```powershell
npm run notify:teams -- --message .state\notification.json
```

Use `--config <approved-path>.local.json` to select another deployment.
The lower-level `--receipt` override remains available for an existing recorded
integration, but ordinary skill callers must use the canonical shared default;
changing paths does not make an uncertain send safe to repeat.

The sender checks the designated identity and deployed destination, authenticates
with an ARM bearer token and never writes tokens or callback URLs to receipts.
Connector retries are disabled. A receipt is reserved before the single
outbound POST; an existing receipt blocks another attempt. Missing message IDs,
timeouts and failed responses are **unconfirmed**, not successful delivery.
Reconcile the workflow run and channel before considering another send, and
reuse each notification ID with the same receipt path. This command does not
enable scheduling or automatically publish evidence, PR or validation events.
The skill, command and generic workflow template are versioned together in this
repository. A fresh checkout discovers the skill from `.github\skills` after
loading this project; no path to a previous Copilot session is needed.

## Independent agents and contracts

The four top-level entrypoints are `evidence-collector`, `evidence-filter`,
`evidence-proposer` and `evidence-rsi`. FILTER delegates to the coordinator/planner procedures;
Proposer selects the configured repository-owner procedure. RSI inspects flow
artifacts and proposes changes to the agent system itself. These packages do
not create additional agents, daemons, permissions or execution budgets.

```powershell
npm run pilot -- agents
npm run pilot -- agent collector help
npm run pilot -- agent filter help
npm run pilot -- agent proposer help
npm run pilot -- agent rsi help
npm run pilot -- agent collector app-status --run RUN_ID --config pilot.local.json
```

`agent ROLE EXISTING_COMMAND` is a thin operation adapter: it dispatches the
existing helper with unchanged arguments, input schemas, defaults and guards.
Discovery returns versioned definitions with skill/procedure hashes, input and
output expectations, supported operations and resumption policy. Unknown roles
or cross-role operations fail before configuration/state access.
All four roles can inspect the same app-native run with `app-runs` and
`app-status --run RUN_ID`; the legacy `reconcile` helper inspects the standalone
SDK ledger, not an app-native run.

Accepted invocations return an `agent-operation-result-v1` envelope containing
`role`, `operation`, `kind` and the original `result` or safe `error`. The result
marker `acceptance: not-inferred` is intentional: helper completion does not
establish complete collection/cohort acceptance, a qualified assignment, passed
validation or publication. Consumers must inspect the original durable contract.
Existing commands without `agent ROLE` retain their output and exit behavior.

The facade does not implement a new scheduler or automatically advance between
roles. App-native hosts still execute the skills and drive existing durable
operations; the controlled proposer uses the same worker and pass-only,
exact-clean-HEAD publication guard. A blocked/uncertain attempt is preserved,
never reset or blindly redispatched. Source/provider transports, held review,
dispatch permissions and continuation authorization remain separate gates.

With an explicitly enabled `rsi` policy, proposer controllers capture immutable
success/failure outcomes and return a post-flow `evidence-rsi` handoff.
App-native flow owners use `app-end`, including partial and no-candidate runs.
An approved host invokes the skill; opt-in `rsi.automation` uses either the
existing restricted native host or providerless continuations in the current
Copilot App (`executionMode: app-hosted`), commits an isolated candidate and
independently compares baseline/candidate executions. A pinned app-role plan
composes the existing role commands and durable assertions; it does not need a
separate whole-flow executor. Actual app-host continuation remains unqualified
until exercised operationally; offline simulated responses are not a live run.
See [app-hosted RSI](APP-NATIVE.md#app-hosted-rsi-continuations). Without that policy,
the handoff remains capture-only. RSI has durable claim/proposal/result and draft-reservation operations,
with no duplicate PR creation authorized after an uncertain response. See the
[end-of-flow RSI contract](APP-NATIVE.md#end-of-flow-rsi-skill).
The existing offline current/current evaluator is a separate qualification
building block, not evidence that a proposed change improves the complete flow.
Large app transport receipts use hash-bound references to the original producer
events when an inline observation would exceed its bound. Receipts are available
through bounded, expiring pages without copying or truncating the original data.
The observation cap remains 1 MiB; metadata that exceeds it still blocks handoff.
This repairs the oversized-event handoff mechanism, not historical runs or live
qualification. Local ingestion gains do not establish full-loop productivity.

For an already-authored candidate, the roles can consume genuine saved evidence
and decisions before a separately authorized validation-only continuation:
`agent collector replay-evidence`, `agent filter replay-review`, then
`agent proposer continue-local-validation --prepare|--execute`.
The first two operations are explicitly import/replay, not new collection or
review. Their held, content-bound receipt is required by continuation preparation;
help/status output cannot substitute. See
[recorded-source role handoff](APP-NATIVE.md#recorded-source-role-handoff).

| Procedure / project skill | Responsibility | Durable handoff |
|---|---|---|
| `evidence-collector` | Scoped reads, receipt imports, coverage and auth failures | Evidence versions, captures, runs, cursors |
| `evidence-rsi` | Inspect flow outcomes and propose agent-system fixes/improvements | Pinned observations, claims, proposals and draft receipts |
| `evidence-coordinator` | All exclusions, review, explicit repo ownership and atomic claims | Investigations and assignments |
| `evidence-improvement-planner` | Aggregate eligible evidence, discover/link coverage and select a qualified repository skill | Versioned areas-to-improve and test-coverage plans |
| `evidence-1js-owner` | Claimed 1JS RCA, authorized fixes and source-bound validation | Assignment-linked results and draft PR evidence |
| `evidence-office-owner` | Claimed Office RCA, authorized fixes and source-bound validation | Assignment-linked results and draft PR evidence |
| `evidence-oa-owner` | Claimed OfficeAgent test authoring through the repo-native integration-test workflow | Skill execution, source-bound validation and draft PR evidence |

The collector/reviewer currently share configured identity
`excel-evidence-coordinator`; owners use `repo-owner:<repoId>`. These are logical
roles, not four installed daemons. Skills are procedures, **not permission or
process boundaries**. Configuration and the local ledger survive conversations.
App-native sessions are temporary isolated execution contexts, never agent IDs
or the sole state store. Same-session automation is not the target architecture.
The current upstream milestone uses a local controller/ledger with explicitly
selected existing Agency FILTER execution and the
[essential local read-only analysis policy](AGENCY-EXECUTOR.md#essential-local-read-only-filter-policy).
It does not require shared 1JS runner changes. Missing Agency task selection
blocks this route rather than invoking a local-model fallback. The endpoint is
accepted complete-cohort consolidation and the colleague's existing held
handoff, not proposer execution or a product integration-test pass.

Downstream proposers can independently select local or Agency execution using
each repository's `flights.proposerExecutor` (`"local"` or `"agency"`).
The example defaults to local; OA can opt into Agency without rerouting 1JS E2E
or FILTER. Flights neither activate dispatch nor qualify a runtime, and never
fail over or migrate an existing assignment. See the
[executor flight contract](AGENCY-EXECUTOR.md#per-repository-executor-flight)
for qualification, legacy configuration and private transport requirements.

**Historical FILTER scope:** one 15-member canary was accepted against exact
request/result/source-bound execution: 7 reviewed records, 8 title exclusions
and 5 candidate analyses (2 deferred E2E, 3 integration, including 1 unblocked
gap). The user reduced execution to that one batch; the remaining 6 batches
were not run, not failures. There is no complete 94-member cohort handoff,
product integration-test pass, periodic-readiness or collection-completeness
claim. Partial workplace-message coverage and unavailable incident coverage
remain limitations. Unknown publication effects and final checkout observations
remain unknown, not verified zero effects or a sandbox guarantee. Only this
sanitized aggregate is published; no private execution artifacts are included.

**Demonstrated bounded local flow:** at a prior private controller revision, one
selected regression-coverage case completed genuine saved-input Collector/FILTER
CLI replay, native-skill model authoring, both required source-head native test
legs, and automatic push plus one draft PR. Both final case executions passed
once with 26 assertions each; emitted runtime import/mocks order was checked
before push. The native wrapper's default summary was unavailable, so acceptance
used explicit raw output-file results. No actual CI builds were observed in the
complete push-through-PR window; draft policy rows were not builds.

That result is not incident RCA, fresh collection/review, full-cohort acceptance,
unattended first-attempt reliability, hosted Agency qualification, browser E2E,
or target-merge/latest-vendor validation. Failed predecessors remain failures.
This reconciled public version is offline-validated only, not a new live replay
of that private revision. Product PR identities, source heads and raw evidence
are deliberately excluded.

See [APP-NATIVE.md](APP-NATIVE.md) for exact command/receipt/claim/result contracts,
[the schema](scaffold/contracts.schema.json) for portable records, and
[CONTRIBUTING.md](CONTRIBUTING.md) for unassigned workstreams and acceptance criteria.
New conversations discover existing runs with `app-runs` and inspect them with
`app-status`; they do not repeat collection or relaunch uncertain assignments.
Do not use network-shared SQLite. Each colleague owns a protected local ledger.

## Configuring an authorized manual pilot

`pilot.example.json` is portable, inert and uses synthetic identity/channel
values. It does not authorize source access. Preserve an existing personal file;
otherwise copy it once:

```powershell
if (-not (Test-Path .\pilot.local.json)) {
  Copy-Item .\pilot.example.json .\pilot.local.json
}
# Resolve and approve the local configuration before these ledger operations:
npm run pilot -- app-runs --config .\pilot.local.json
npm run pilot -- app-status --run RUN_ID --config .\pilot.local.json
```

Resolve the designated delegated user/tenant/object ID, exact WorkIQ resources,
explicit UTC window, read/item budgets, protected storage approval/retention,
and enabled source scopes. Never copy another person's identity or credentials.
Local raw validation evidence must use `statePolicy.retention: "bounded-local"`
with `rawEvidenceDays` from 1 through 7. New controller-owned artifacts are
written beneath `.state\runs\<run-id>` with a manifest and SHA-256 metadata.
Completed or blocked runs are pruned at CLI startup and exit; active runs are
never deleted. Preview or apply cleanup explicitly with:

```powershell
npm run pilot -- state-prune --dry-run --config .\pilot.local.json
npm run pilot -- state-prune --config .\pilot.local.json
```

The state directory must be gitignored when it is inside the repository.
Pruning refuses malformed manifests, path escapes, symlinks, junctions and
hard-linked files instead of following or deleting them. Durable ledger records,
remote PR/build/test-run identifiers, hashes and verdicts remain outside the
pruned run directory.
Source reads require separate authorization; importing a local file is not
proof of independent local authentication. Run configuration hashes are strict:
do not change an existing run's config. Use its original config to inspect it.

**Intentional product-specific selectors:** the current ADO adapter is fixed to
`office/OC`, Bugs with state **Resolved or Closed** and
`Microsoft.VSTS.Common.ResolvedReason` **Fixed or Duplicate**, under
`OC\Excel\Intelligence\Copilot\Excel Agent`, including descendants. Both created
and changed lanes retain their half-open UTC windows, snapshots and budgets.
Missing or other resolutions are ineligible; `System.Reason` is not a fallback.
This is regression-coverage input, not a request to fix unresolved product bugs.
Duplicate records keep their exact identities and canonical links even when the
linked bug is outside the area; no extra source reads or canonical merging are
implied. Genuine scanner exclusions remain independent of resolution.
IcM export
validation is fixed to query `599514`; saved-query timestamp equivalence remains
unverified even when connector identity and team/severity mappings are qualified.
The opt-in incident-created receipt path uses its separately approved team,
S1/S2/S2.5 (API 1/2/25, excluding S0) and UTC window. It is not that saved query,
does not require its timestamp equivalence and never changes an old run's scope.
These selectors, the 1JS/Office repo URLs and the field names in
`scaffold` are integration constraints, not anonymous generic examples or access
grants. A different deployment needs a reviewed adapter/config change, not a
silent query substitution. The example's Teams IDs are fictitious.

Before code work, resolve repo owner/project binding, routing, base/target
revisions, permitted write prefixes or exact files, commit identity and approved validation
commands. Primary checkouts are references only; execution must use isolated
task workspaces. A worktree/clone is **not an OS sandbox**.

Each devbox keeps machine-specific checkout paths in an ignored `*.local.json`
file. The lower-level command can bootstrap one repository without hard-coding
a shared path:

```powershell
npm run pilot -- bootstrap-repo --repo office-agent `
  --config .\pilot.local.json
```

If `pilot.local.json` already contains a valid checkout with the configured
origin, it is reused. Otherwise the command searches explicit `--search-root`
values followed by common per-user checkout roots. If no matching checkout is
found, it clones into `--clone-root` or the user's `Repos` directory. The
command records the verified top-level path and the remote default branch in
the local file; it never enables routing, writes, validation or PR permissions.
Only filenames ending in `.local.json` are accepted, and the repository
`.gitignore` excludes those files.

Improvement work adds two durable planning records before assignment:
`areaToImprove` clusters eligible investigations into a stable, versioned theme;
`testCoveragePlan` records complete/partial/not-run coverage discovery and
distinguishes linked coverage, a confirmed coverage gap and an unresolved
search. A planned assignment pins both record versions, capability, requested
outcome and one qualified repository skill binding. Repository skills execute
from the exact isolated source revision and cannot grant themselves shell,
network, commit, push or PR authority. Each binding also declares a narrower
write-prefix allowlist inside the repository bounds. The controller pins that
allowlist into the assignment, applies it to every authoring and repair tool
call, and verifies the complete base-to-candidate diff before commit and push.

A resolved production bug can still justify missing regression coverage.
`testCoveragePlan.purpose: "regression-coverage"` explicitly records that intent
for the integration/declarative test-only path. It does not replace the
current cohort or existing-fix review requirements below. The same source
eligibility rules apply to initial dispatch and explicitly authorized local
continuations; neither a plan nor a continuation clears tracked reconciliation.

Resolved/Closed ADO sources may execute only as otherwise eligible,
source-bound test-coverage improvements in the Fixed/Duplicate cohort.
They require a current complete coverage plan with a remaining gap and no
unknowns, a qualified test-authoring binding and its pinned test-only write
bounds. Generic RCA/product-fix assignments retain terminal-source protection.
Unchanged terminal-cohort revisits do not themselves invalidate a review;
changed source captures, superseded plans/qualifications and existing
reconciliation blockers still block execution across standalone, native and
continuation paths.

Known product fixes remain in `investigation.existingFixes` and original source
links. They are not permission to dispatch, nor must they be deleted to propose
regression coverage. `testCoveragePlan.existingFixesReview` optionally records
the existing review policy's source-bound reconciliation:

| Field | Required binding |
|---|---|
| `investigationId`, `investigationVersion`, `evidenceIds` | Exact current investigation/version and complete evidence set |
| `planId`, `planVersion`, `sourceRevision` | Exact coverage-plan version and inspected repository revision |
| `review` | Existing review method, nonblank reviewer and UTC review time at/after the investigation review |
| `fixes` | Every original fix URL exactly once, each with `url`, `disposition`, `rationale` |

Only all-`product-fix-with-remaining-coverage-gap` entries can pass the qualified
test-only gate. `coverage-already-satisfied`, `coverage-in-flight` and
`unresolved` remain durable blocking outcomes. Missing, duplicate, stale or
mismatched bindings fail closed. This is an agent-evidence review under the
existing policy, not a new per-finding human approval gate.

Use the existing `plan-improvement` / `app-plan-improvement` input's
`testCoverage.existingFixesReview` to persist the record. When adding it to an
existing plan, bind its next version; unchanged replay remains idempotent.
Changing the plan/source or investigation requires a new bound review. FILTER
candidates may carry `existingFixes`; handoffs preserve these and previously
recorded fix URLs and accept the review as `routing.existingFixesReview`.
Neither fix reconciliation nor retained duplicate relations authorize extra
source reads or prove canonical duplicate-work merging.

For OfficeAgent, the qualified router entry is
`.github/skills/integration-test-authoring/SKILL.md`; it resolves an exact
project root, delegates to `docs/skills/Integration-test-core/workflow.md` and
auto-discovers the project shell. A read-only qualification can verify the
configured checkout, origin, base revision and skill content fingerprint before
routing or writes are enabled. Repositories configured with
`qualificationRefresh: "fetch"` fetch the trusted remote ref first instead of
assuming the local branch is current. The receipt binds that exact revision,
the skill SHA-256 and the repository validation contract version/hash:

```powershell
npm run pilot -- qualify-skill --repo office-agent `
  --capability integration-test-authoring `
  --binding oa-integration-test-core `
  --config .\pilot.local.json
```

Qualification does not approve ownership, write prefixes, validation gates,
commit identity, push or draft PR creation. Ambiguous project names remain
blocked; assignments must pin the repo-relative owner project. A changed skill
or validation profile requires a new qualification and is used only by new
assignments; an in-progress repair loop never changes contracts mid-run.

### Opt-in local external skill bundles

An unmerged skill can be used without putting its files in the product baseline.
Add `externalBundle` to an existing `skillBindings[]` entry in **local,
uncommitted configuration only**. Omit it to retain the existing native,
exact-product-commit behavior. Store the files under the controller's already
ignored `private-runtime/` directory, mirroring their original repository paths:

```json
{
  "skillPath": "docs/skills/test-authoring/SKILL.md",
  "externalBundle": {
    "root": "private-runtime/test-authoring",
    "source": {
      "remote": "https://example.invalid/project/_git/product",
      "revision": "<full source commit SHA>",
      "path": "docs/skills/test-authoring/SKILL.md"
    },
    "files": [
      {
        "path": "docs/skills/test-authoring/SKILL.md",
        "sha256": "<SHA-256 of the exact local file bytes>"
      },
      {
        "path": "docs/skills/test-authoring/references/testing.md",
        "sha256": "<SHA-256 of the exact local companion bytes>"
      }
    ]
  }
}
```

This is a binding fragment, not a complete configuration; replace the placeholders
with real hashes. The root is relative to the configuration file (or absolute).
Paths inside the bundle must be canonical, slash-separated repository paths,
with no traversal, aliases or duplicates. Include the entrypoint and every
companion needed by the skill. Hash actual bytes, not normalized text: line
ending changes are drift. Each file and the entire bundle must fit within
`limits.maxFileBytes`; at most 128 explicitly listed files are accepted.
Symlinks/reparse paths, linked roots/ancestors and hard-linked files are rejected.

Run the ordinary `qualify-skill` command. Qualification first binds the product
base as before, then independently verifies **every** manifest file against
regular Git blobs at `externalBundle.source.revision` in the reference
checkout's object database. That commit must already be available locally; the
controller does not fetch the skill revision, merge it or change the product
checkout. The provenance remote must be the same credential-free HTTPS remote
as the product repository. A local commit's presence is not proof it was
published or approved: obtain the exact source revision through your normal
trusted process. `qualificationRefresh` still controls only the product base.

Qualification receipts and assignment pins contain the root, original
remote/revision/path, and complete file/hash manifest. Runtime rejects changed
bindings, missing files and byte drift; it rechecks before prompts, bundled
reads, accepting results and publication. Worker results retain the external
binding and original skill revision separately from the product source revision.
Changing a bundle requires requalification and a new assignment.

Only local execution with SDK or bounded local authoring is supported; hosted
execution and remote authoring fail closed. The AL workflow is narrower:
its Proposer permits only `copilot-sdk`, with the pinned model and expiring
allocation enforced at execution boundaries. The existing `pilot_read` tool
accepts `skill-bundle:<exact manifest path>` (including line ranges); it cannot
read arbitrary controller files. The prompt lists these paths and distinguishes
skill-relative companion links from repository-relative guidance, which still
targets the isolated **product** workspace. Search/list and write tools remain
product-only. No bundle file is copied into the workspace, no write allowlist
is expanded, and all existing test-only, validation and publication gates remain.
Unlisted/missing guidance is a blocker, not permission to substitute another file.
Keep private contents, provenance and generated receipts out of public fixtures.

Local wrappers that spawn the proposer CLI must use
`localProposerEnvironment()` from `src/workers.js`, not the native runner's
`minimalEnvironment()`. The former preserves only the documented
`COPILOT_GITHUB_TOKEN`, `GH_TOKEN` and `GITHUB_TOKEN` model-authentication variables
in addition to the minimal OS environment. The SDK inherits that environment;
`useLoggedInUser: true` cannot restore credentials omitted by the launcher.
Do not log values, copy credential caches or infer authentication from variable
presence. Native validation still uses the credential-free minimal environment,
with package authentication added separately only through its approved contract.
A launcher correction never authorizes replay of an exhausted assignment.
The existing `continue-local-authoring --prepare` request may instead include
`credentialAdmissionPredecessor: { configPath, assignmentId, terminalReport,
authDiagnosis }`, with absolute paths and `{ path, sha256 }` artifact references.
This narrowly permits one separately reserved successor of the first diagnosed
authoring attempt only when its sealed SDK events show the exact missing-token
query rejection, routine shutdown and zero reported usage, with no tools,
source edits, native cases or publication. It rechecks the original role and
diagnostic lineage, requires the corrected launcher and an unchanged scope/config
apart from private placement, and preserves both consumed reservations. An
invalid credential, unknown usage, additional event or another failed successor
is not eligible. Execute still accepts only `{ assignmentId }`; neither the
diagnosis nor variable presence counts as live authentication or validation.

A separately authorized `continue-local-validation` request with authorization
kind `native-wrapper-separator` handles only a later, sealed native
`missing_command` refusal after this author's exact first leg passed all 26
assertions. It retains the model-authored revision and both required native legs,
requires actual child-argv/native-parser evidence, and permits only quoting the
single PowerShell `--` separator in a new content-bound profile. The original
profile and exhausted attempts are not edited. This path invokes no model or
commit and still requires a fresh native cache, executed runtime-import proof
and all gates passed at the preserved revision before publication. Other native
failures and repeated continuations remain blocked.

Windows native validation and diagnostics require PowerShell 7.3+ and run inside a private
Windows Job Object established before the native command starts. The supervisor
owns the job's only handle, so normal exit, the existing stage timeout, or output
overflow also terminates its descendants; killing only the immediate shell is
not sufficient. Containment failure blocks launch without an uncontained
fallback. Arguments, output, the filtered environment and stage limits remain
unchanged. No global process, account, policy or configuration changes are made.

The existing diagnostic CLI also accepts a separately hash-bound
`native-launcher-timeout-diagnostic` after a sealed, fully drained zero-model
native-wrapper timeout. It preserves the failed reservation and changed source,
materializes verified native outputs in a new private workspace, and runs only
the unchanged first-leg prefix for at most 60 seconds. A preload records
bounded module/dispatch/filesystem-error progress without an inspector and is removed from descendant
environments. Source, case assertions and the case timeout do not change.
The ledger records the method before launch. Its receipt never grants validation
acceptance or publication and cannot replay the diagnostic.

Fresh native `TEMP`/`TMP`/`TMPDIR` use the short private `nt/<24-hex-key>`
layout and are capped at 180 characters on Windows. Node 24.19.0 can stall in
`module.enableCompileCache()` at some intermediate long TEMP lengths before
Corepack loads its library. Short placement preserves the normal compile cache,
fresh Jest cache and unchanged assertions rather than disabling caching or
extending a timeout. Oversized state placement fails explicitly before launch.
The unchanged validation-continuation CLI permits one separately bound
`native-launcher-cache-path` successor only after the drained wrapper timeout,
sealed layer diagnostic and isolated Node threshold proof. It retains the
original proposal, role/source lineage and exact profile, starts no model and
requires both native legs plus emitted-import/fresh-cache proof before the
existing pass-only publisher.

The OA skill owns validation intent and failure interpretation: it selects the
project runner, targeted tests, behavior-card checks and repair procedure. The
OfficeAgent integration-test binding is test-only: successful changes must
report both focused tests and behavior-card updates. A failed test may enter
the bounded repair loop, but the write boundary never expands to production
code. Validation that remains failed is recorded as blocked without a push or
Draft PR. The controller owns execution and evidence. A validation gate may bind a versioned
pipeline script using `profilePath`, `profileSha256` and the `{profile}`
argument placeholder. The controller verifies the profile hash before every
run, executes it outside the model tool surface, records the hash in the
operation artifact and returns bounded diagnostics to the next skill round.
Prestarted dependency or compile failures are terminal for that attempt, not a
cache miss. The controller preserves the original sanitized output, exit code,
timings and preparation revision without implicitly repeating preparation for
the authored revision. A separately recorded continuation is required; a blocked
runner is not evidence that source content drifted.

Checkouts skip broad Git LFS smudging. If native validation requires LFS files,
the approved gate must list them in `lfsPaths` as exact repository-relative paths
(no globs). This list is part of skill qualification and the compile-cache
contract. The controller uses installed Git LFS to fetch only those paths at the
exact revision from the configured repository, with clone-local object storage
and memory-only same-user ADO authentication. It verifies each source pointer's
SHA-256 and size and clean tracked source before native compilation or testing.
Unrelated LFS files remain pointers. No global LFS setup, filter bypass, implicit
retry, or credential-bearing configuration is performed. Missing Git LFS,
unavailable objects, authentication failure or object mismatch blocks validation
with the original sanitized native failure, never a successful preparation receipt.

### Built-in 1JS declarative execution

The `1js-declarative-e2e-v1` profile is a repository-level execution adapter,
not a script to write for each incident. Its packaged implementation is
`scripts/validation/1js-declarative-e2e.cjs`. The example 1JS gate selects this
profile by name; configuration resolves its fixed arguments and content hash
automatically. Its execution settings and registration policy participate in
read-only repository-skill qualification. Changing them requires requalification.
Example routing, authoring, registration, execution and publication remain off.

Configure the installed product-compatible Node executable, the installed Yarn
or Corepack JavaScript entry point, and the signed-in loopback HTTP CDP endpoint
once in private deployment settings. Do not put case IDs or evidence-specific
commands in that configuration. The Controller derives the batch from the
qualified assignment's reviewed mini-spec items, skill-reported scenario IDs,
and changed L3 files. This version supports the Excel Agent ordinary AAD lane,
one explicitly changed scenario per input item, with a configurable bound of
one to ten cases. Shared-only changes, other applications and identity lanes
require an owner capability handoff, not an implicit fallback or whole-suite run.
The example does not narrow the checkout to app sources: native execution also
needs the pinned Yarn, scoped installer, build tools and transitive package
sources. An app-only sparse checkout is not a prepared execution lane.
Shared YAML changes are restricted to new UI-map keys and appended composites:
existing entries and resource contracts must remain semantically identical to
the qualified base. Changes affecting existing consumers require an explicit
consumer-closure handoff, not an unapproved expansion of the selected live batch.

After the bounded skill returns, a separately approved Controller registration
step updates only the selected entries in the reviewed catalog, lifecycle
catalog, capability matrix and canonical package script. These four owner files
are never added to the model's write allowlist. New cases use observing
enforcement and the explicitly configured registration priority. Existing
disabled cases, titles, tags, assertions and cleanup contracts cannot be removed,
renamed, retagged or weakened by registration. Execution-selection policy is not
changed. Registration emits an assignment-bound, profile-hashed receipt with
exact owner file hashes; later source edits invalidate it.
Repair rounds regenerate metadata against the qualified base, preserving its
contracts without treating an earlier unsuccessful round's additions as history.
Explicit validation continuations verify the prior immutable receipt and source
before recording a new assignment-bound receipt; they do not rerun registration.

The Controller commits the authored declarations and owner metadata together,
respecting Git hooks. Optional repository `commitTrailers` contain single-line
Git trailers, such as the invoking session's provenance; do not hard-code a
session into the reusable profile. Validation uses a clean isolated checkout of
that final SHA. The native profile runs typecheck, declarative unit tests,
strict repair/catalog/lifecycle validation, then one native local batch with
five repetitions, one worker, zero retries and fail-fast behavior. Controller
infrastructure retries cannot silently rerun this live batch.

Successful exit alone is insufficient: validation checks the exact native
selection and declaration hashes, five distinct expected passes per scenario,
protected business-contract events, every declared cleanup step and CDP tab
preservation. It never closes user tabs or automatically deletes leaked tabs.
Native output and the source-bound receipt remain under the private Controller
state directory after the validation checkout is removed. Only an independently
authorized dispatch with every required gate passing can reach push, Draft PR
or the separately configured non-blocking build.

Product dependencies and authenticated browser/feed setup are deployment
prerequisites, not model-authored glue. The profile never accepts credentials in
the assignment. `installDependencies` is off by default; when separately
approved, a missing native dependency triggers the repository's scoped Yarn
installer and native build once, rather than using another checkout's binaries.
The scoped installer runs with its native `--skip-auth` option; unavailable feed
access blocks execution rather than starting interactive sign-in inside a gate.
Neither enabling the profile nor qualification grants publication permissions.

The checked-in OneNote profile is
`scripts/validation/office-agent-onenote-bootstrap-progress.ps1`.
Its version 3 plan retains the controller-owned Azure Artifacts authentication
broker and explicit interactive recovery described under
[staged validation receipts](#staged-validation-receipts). A missing provider or
sign-in requirement returns `action-required-auth` before worker launch; follow
the exact returned remediation command and retry the original command once.
It restores the locked dependency graph using already configured feed credentials
and suppresses the repository's automatic credential refresh/provider installation.
Missing or expired feed access remains a setup blocker; validation does not sign in
or change authentication state.
Git access or an Azure CLI account alone does not configure Yarn registry access.
By default the validation runner does not inherit package-token or custom
Yarn/npm configuration environment variables. Its native auth helper can rewrite
project Yarn configuration and install a global credential provider, so invoking
that helper is a separately approved setup action, not an automatic validation
retry. Approved feed provisioning must work in isolated checkouts without changing
pinned tracked configuration or copying credential-bearing files into source or
validation receipts. An executor flight does not supply those credentials.

For a separately approved legacy local Yarn runner, a gate can explicitly opt into a single
broker-provided token from the controller's environment:

```json
"packageAuth": {
  "kind": "yarn-token",
  "tokenEnvironmentVariable": "PILOT_OA_PACKAGE_TOKEN"
}
```

The variable name must match `PILOT_*_TOKEN`; put only its name in configuration,
never its value. Complete supported same-user provisioning **before** launching
the controller. An explicitly installed, trusted setup launcher can acquire a
token through Microsoft's credential provider, assign the named environment
variable in memory and launch the controller in that process tree, without
rewriting `.yarnrc.yml`. Its documented standalone JSON interface must have stdout
captured in memory, **not** displayed or redirected to a file; stderr carries any
sign-in instructions. Check the installed tool's interface before relying on it:
the npm provider's v1.2.1 ESM `getToken` export fails to import under Node 24 with
`Dynamic require of "path" is not supported`, before any authentication occurs.
Do not patch the package or treat that tooling failure as missing feed permission.
Do not print the token, save it to a script/receipt, pass it on a command line,
or run interactive setup inside a validation gate. Provider installation,
sign-in and account consent are separate, explicit setup operations. The
controller's `npm run setup` does not perform them.

Authentication preflight uses a unique authentication-only workspace containing
the exact-revision Yarn configuration. It never reuses or deletes a dependency
snapshot workspace, including an incomplete preparation or a forced recovery.

Local SDK authoring may pin a verified model identifier with
`runtime.authoringModel`; omission preserves the SDK default. The configured
per-session AI credit ceiling remains a soft runtime limit.
Sequential, separately ledgered attempts may explicitly share an absolute
`runtime.validationCacheDirectory`. Native input hashes, source cleanliness and
output verification still apply. Do not run concurrent preparations or workers
against that directory.
An explicitly authorized successor can also bind prior diagnostic data with
`runtime.authoringFeedback: { path, sha256 }`. The absolute-path JSON is
hash-verified before model creation and included as untrusted predecessor
evidence; it grants no tools, writes, or publication permissions.
For native runners that rebuild their owning compiled tests on every test-stage
invocation, a gate may declare `testRebuiltOutputPaths` as exact roots already
listed in its profile's `preparedOutputPaths`. Those generated roots are not
immutable cache artifacts. The qualification and compile-cache key bind this
declaration; tracked source, dependency roots and overlapping snapshot roots
cannot be excluded. The qualified test stage must freshly compile the exact
candidate before normal discovery; all other cached outputs remain verified.
A separately authorized `native-jest-cache-isolation` validation continuation
handles the narrow case where the full native suite passed but cleanup rejected
`rename:node_modules/.cache/jest`. It preserves the clean model-authored commit
and original captured evidence, requalifies the profile, and permits only an
explicit Jest `--cacheDirectory` plus durable private result location. Its
zero-model dispatch verifies the terminal predecessor, configuration, profile
and controller-source hashes, prepares or verifies the original native
snapshots, and records a test-only profile rebind before rerunning every gate.
The predecessor's passing output is diagnostic evidence, never publication
acceptance; fresh exact-head validation and cache cleanup must both pass.
Authentication remediation is selected from the qualified feed contract.
The existing pinned-provider setup supports the AL single AugmentationLoop feed
through `-RepositoryProfile AugmentationLoop`; its default still requires both
OfficeAgent feeds. SDX continues to use its repository `yarn auth` broker.
An unknown feed combination fails closed instead of receiving unrelated setup
instructions. Baseline test success alone is not isolation qualification.

For example, in a dedicated PowerShell process after approved private provider
installation, capture the documented standalone response without displaying it:

```powershell
$provider = Read-Host 'Path to the privately installed CredentialProvider.Microsoft.exe'
$registry = Read-Host 'Approved Azure Artifacts registry URL from the pinned source'
# Replace doctor with the explicitly authorized flow command; doctor itself runs no validation.
$controllerArgs = @('doctor', '--config', '.\pilot.local.json')
try {
    $tokenJson = & $provider -U $registry -I true -C true -N false -V minimal -F json
    if ($LASTEXITCODE -ne 0) { throw 'Credential setup failed; resolve sign-in before continuing.' }
    try { $credential = ($tokenJson -join "`n") | ConvertFrom-Json -ErrorAction Stop }
    catch { throw 'Invalid provider response; do not log credential-bearing stdout.' }
    if ([string]::IsNullOrWhiteSpace($credential.Password)) { throw 'Provider returned no credential.' }
    $env:PILOT_OA_PACKAGE_TOKEN = $credential.Password
    & node .\src\cli.js @controllerArgs
    if ($LASTEXITCODE -ne 0) { throw 'Controller command failed; inspect its secret-safe evidence.' }
}
finally {
    Remove-Item Env:PILOT_OA_PACKAGE_TOKEN -ErrorAction SilentlyContinue
    $credential = $null
    $tokenJson = $null
}
```

This is setup, not a validation profile. Do not print `$credential`, enable shell
tracing, or redirect the provider response to a log. Verify that the acquired
identity is the designated user and that **both** the default registry and scoped
registry permit reads. An account listing or token acquisition alone is not that
proof. A metadata probe must request the package endpoint and inspect its locked
version, not append a version to the endpoint; Azure Artifacts can return 404 for
that unsupported route even with a valid token. Keep probes and restore bound to
the same source, lockfile and registry configuration, with a cold private cache.

Only the selected gate receives `YARN_NPM_AUTH_TOKEN`. Staged profiles receive it
only during dependency restore and compile, not fingerprinting, policy checks or
tests. Non-staged runners receive it for their whole command. No custom npm/Yarn
configuration or unrelated environment values are forwarded. The selected
native runner and pinned registries must be trusted to consume the credential;
this is not a sandbox for untrusted scripts. Successful and failed command
diagnostics redact the token and its base64/URI representations before telemetry
or artifact capture. Missing/empty tokens block without automatic retries; token
presence is not proof of feed authorization. Real locked restore must establish
that. The value-free auth option is part of skill qualification and preparation
cache identity, so changing it requires requalification. Token rotation alone
does not invalidate reusable dependencies. The OneNote profile keeps its Yarn
cache beside the controller's private profile, not in a shared machine path.
On Windows, the controller sets `core.longpaths=true` in each newly provisioned
authoring clone's **local** Git configuration before skill attestation and checkout.
It also sets this in validation clones, including reused prepared clones, before
native validation commands run: skill attestation and native build tools spawn Git
without the controller's per-command `-c` settings. Validation does not change the
authoring clone's configuration. Reference checkouts and global or system Git
configuration are not changed; the fingerprint-only stage stays read-only.
Native Git attestation failures are reported as `blocked-repository-git`, with the
operation, exit status and a safe diagnostic category, rather than being treated
as proof that skill content changed.

`prepareLocalPreModelContinuation` in `src/local-continuation.js` is an explicit
operator API, not an automatic retry. It accepts only a reconciled blocked local
skill-attestation attempt with zero model rounds/tools, no validation or
publication operations, and a clean unchanged workspace. A one-attempt user
authorization must pin the prior attempt, source revision, controller revision
and fresh configuration hash. The configuration may change only its state
directory, except that a runtime credit-ceiling correction requires separate
explicit authorization of both the old and new finite ceiling, bound to that
configuration hash. The controller never silently raises a ceiling to satisfy a
CLI minimum. Other budgets, permissions and source pins must remain unchanged.
The API requalifies the skill, reserves a one-shot audit operation,
imports the original evidence/review/plan into a separate empty ledger and
prepares a new session for the same logical assignment. It never launches the
model, resets the old job, edits its receipts, retries validation or republishes.
An interrupted reservation or a second continuation requires reconciliation.

For the exact `blocked-runtime` / `Copilot executable not found on PATH`
rejection, use `agent proposer continue-runtime-launch --prepare|--execute`.
Preparation takes `previousConfigPath`, `previousAssignmentId` and `authorization`;
execution takes only the prepared `assignmentId`. The configurations must match
except for separate state directories. Correct the private launcher's absolute
path in both configurations first; no source, permission or budget change is
allowed. Authorization must have kind `runtime-launch-path`, approve one model
attempt after the failure, pin the previous assignment/attempt, source and
controller revisions, next configuration hash, launcher `cliSha256` and a
`runtimeSmoke: { path, sha256 }` receipt. The offline smoke must retain the same
`cliPath` and `cliSha256`, prove custom-tool execution, rejection of unavailable
shell tools, and no model or workplace read.
Preparation requalifies the skill and verifies exactly zero authoring tool calls,
native invocations and publication operations. Execution rechecks immutable
predecessor receipts, source eligibility, launcher bytes and the clean qualified
checkout before claiming the original task workspace once. The blocked job/result
remain unchanged; a fresh attempt and bilateral reservation record the reuse.
Ordinary dispatch, changed evidence/configuration, consumed reservations and
subsequent model/native failures cannot use this narrow recovery path.
Its recorded one-attempt authorization permits only that continuation even when
general dispatch stays disabled; it never enables the scheduler or other jobs.

For an authoring result classified `bounded-edit-capability-unavailable`, use
`agent proposer continue-authoring-tools --prepare|--execute` after fixing the
bounded tool contract. This separate path requires one terminal read-only
authoring round, zero writes, native validation and publication, and a clean
owned checkout at the qualified base. It also supports the attested workspace
previously reused by the runtime-launch continuation, checking both original
ledgers and immutable receipts. A fresh user authorization with kind
`bounded-authoring-tool` pins the predecessor, source, controller and next
configuration, with `maxModelAttempts: 1`. Only separate state placement and
explicit `executionBounds` changes to `workerMaxToolCalls` (at most 240) and
`maxValidationRepairRounds` (at most 10) may differ; each change contains
`before` and `after`. Source, native gates, publication scope and other limits
remain unchanged. Preparation reserves once; execution rechecks and claims the
same workspace without resetting old attempts or enabling general dispatch.

The same entrypoint can reconcile a read-only
`missing-mid-flow-protected-assertion-capability` result only with an owner-reviewed
`capabilityResolution: { path, sha256 }` artifact. Its
`existing-declarative-capability-v1` report pins the qualified source, existing
`assert`/`visible` primitive, native-loader proof and at least three Git source
file digests. Both preparation and claim recheck the artifact and source bytes;
the model receives the reviewed explanation, not permission to change the harness.
Consumed authoring and runtime ancestry is checked recursively with a depth bound
of three. Reservations are attempt-specific and every previous result is retained.
An explicit user grant covering work until native validation may use
`scope: "until-native-validation"` and the immediate predecessor authorization's
`priorAuthorizationSha256`, retaining its original `authorizedAt`. This does not
invent a later user approval or authorize a second claim of any attempt; other
authorizations must still postdate their blocked predecessor.

A successful authored proposal that failed its first owner registration before
commit may also continue through this entrypoint with a content-bound
`registrationRecovery` review (`uncommitted-registration-recovery-v1`).
The review binds the prior assignment, attempt, result and every authored file
digest, and records repaired dependencies/native loader with zero product
invocations. Preparation and claim require the exact declared uncommitted diff,
no commit, native validation or publication, and the single blocked round-zero
registration. No Controller metadata changes are admitted. Every ancestor is
still verified; only the reviewed descendant diff may explain a formerly clean
ancestor's shared checkout. The retained proposal and owner feedback are given
to a fresh bounded authoring round, rather than resetting the failed job or
silently rerunning registration. This is not evidence of a passing product test.
An optional `registrationRecovery.ownerReviewDirectory` holds an external
pre-commit owner/security review rendezvous. Each round writes a fresh request
with exact changed-file digests, waits at most thirty minutes for a matching
`repository-owner-review-v1` approval, and rechecks source bytes before commit.
Approval is outside the restricted worker workspace; missing, stale, rejected
or changed-source reviews block before commit. The host performs the repository's
required security review and applicable pre-commit checks against that snapshot.
The request includes proposal-time publication text. The owner may return a
`publicationDescription` using the applicable repository PR template, limited to
3000 characters to reserve room for the Controller's final source/build receipts.
This changes publisher-owned text only, not the reviewed files or publication scope.

A first round-zero owner-review timeout after successful registration can use
`ownerReviewRecovery` instead of `registrationRecovery`. Its immutable
`owner-review-timeout-recovery-v1` proof binds the unchanged seven-file snapshot,
prior result, original request and registration artifact, and successful
build/unit/format/lint receipts with hashed logs. Preparation and claim reject
any commit, validation, publication, extra files or operations, stale approval,
changed metadata, or changed gates. The new attempt rebinds registration and
reuses the qualified proposal with **zero new initial model calls**, then requests
a fresh owner approval before committing. Native repair rounds remain bounded
by the unchanged configuration. The original timed-out job and request stay
terminal; never add a late approval or reset them. Consumed ancestors retain
their original snapshot proofs while the independently reviewed leaf snapshot
explains subsequent edits in the same owned checkout.

Declarative validation still runs in a separate clean final-SHA clone. When the
authored checkout already contains restored dependencies and compiled outputs,
the Controller copies only Git-ignored `ooui/.store`, `node_modules`, and
`lib`/`dist`/`out` entries using its existing snapshot materializer. It rebases
internal links into the validation clone and requires matching content
fingerprints before/after copying, unchanged clean revisions, and no overlap
with existing clone files. Copying has a thirty-minute deadline. Missing,
escaping or changed snapshot content blocks validation; it never counts as a
passing native test. The five-pass runner/profile and retry policy are unchanged.

The pinned native custom-skill unit fixture writes four known PNG diagnostics to
its working directory. The Controller archives only those exact, initially
absent and untracked filenames outside the validation clone, checks the PNG
signature and size/count bounds, and records every captured file's hash. All
other files remain subject to the unchanged clean-source checks; no ignore
patterns, hooks, test assertions or repository source are changed. Capture errors
block validation, and a failed test remains failed after its diagnostics are saved.

`agent proposer continue-native-preparation --prepare|--execute` admits only the
measured dependency-fingerprint timeout before the first native runner invocation,
or one sealed pre-stage dispatch failure caused by the recorded workspace-base
field mismatch. That correction preserves both predecessor ledgers and reservations,
requires zero model/native/publication activity, and cannot nest another correction.
Both paths require a single approved candidate commit. They preserve the original bounded
until-validation grant and all old results, claims the same clean task checkout,
and reuses the exact approved commit without initial authoring or another commit.
It cannot admit a failed/started native case or any publication activity. The
fresh ledger keeps infrastructure retries at zero, and the unchanged native
profile still requires five retry-disabled passes at one final clean SHA. Any
later test-only repair uses the existing bounds and a fresh external owner review.
Large ordinary dependency trees are partitioned into bounded fingerprint tasks
while reconstructing the identical canonical content digest; no hash checks or
per-task timeout are removed.

The same entrypoint also accepts `kind: "native-preparation-verified"` after
standalone real preparation acceptance. This is stage-based admission, not a
new error-message-specific exception: the sealed immediate predecessor must
have no model, native output or publication activity. The pinned preflight
must cover that exact assignment/result/ledger, approved source and profile,
current Controller bytes, clean detached workspace, dependency byte equality,
typed native loading, exact case selection and typecheck. Authorization retains
the original grant and pins the new Controller/configuration. Both ledgers
reserve an attempt-specific claim and recursively retain earlier reservations.
Only state placement may change. Dispatch rechecks the accepted workspace and
both dependency byte fingerprints before using the unchanged five-pass runner;
it disables missing-dependency installation for this verified seed. The accepted
workspace is never an authoring checkout. Native failure cannot use this
preparation-only admission. Windows dependency copying batches at most fifty
roots per contained command without extending the thirty-minute deadline.

For a completed model proposal blocked by native-build LFS provisioning,
`prepareLocalValidationContinuation` accepts the previous config/ledger/assignment,
a separate empty next config/ledger, the preserved model proposal and an explicit
source/config/controller/proposal-bound future-local authorization. It requires a
successful source-bound materialization proof, an unchanged single authored commit,
the original completed native-skill result, no publication or uncertain operations,
failure before native tests executed, and zero repairs/infrastructure retries.
Only state-directory and explicitly pinned
`lfsPaths` additions may change; source, profile, assertions and permissions cannot.
It reserves one linked audit operation without resetting the previous job/result.

Execute only through `dispatchLocalValidationContinuation`, never ordinary
`dispatch` for a continuation assignment. This explicit entrypoint rechecks the
prior immutable result, job and operation snapshot, restores the same authored
revision in a new isolated checkout, and delegates to canonical native validation
and pass-only publication. It does not call the model, edit product files or create
a replacement commit. Its result reports zero new model tools/rounds and retains
the original skill result; the linked audit preserves the actual authoring lineage.
A second execution or changed prior state fails closed.

A failed zero-model continuation whose native command executed but found no test
bodies may receive one separately recorded `discovery-placement` correction.
This narrow authorization requires the exact native discovery failure, a pinned
read-only matcher diagnosis and a clean source-bound non-dot placement proof.
Only the separate state location may change; the proposal, source, native
profile, assertions, permissions and zero-retry limits remain unchanged. The
old test invocation remains failed, not relabeled as a preparation failure.
Both predecessor snapshots and original model authoring are rechecked before
dispatch. General post-test failures and repeated placement corrections remain
ineligible. Keep private execution artifacts beneath ignored `private-runtime/`
when a Windows dot-directory ancestor prevents native test discovery.

Separately authorized timeout diagnostics use
`agent proposer diagnose-local-validation` (see `APP-NATIVE.md`). These retain
failed acceptance records and use a fresh transform cache with logging-only
disposable test/harness instrumentation; they never create worker results or
publication eligibility. The diagnostic profile forwards the non-secret
`OAGENT_ADO_ARTIFACTS_AUTHENTICATED=1` auth-hook suppression marker to Yarn.
This marker prevents implicit setup; it is not authentication or feed-access
proof. A stopped owner may be reconciled with
`reconcileInterruptedLocalDiagnostic` only before its recorded case phase and
with no case artifacts. A fresh request can bind that immutable interruption
using `authorization.previousDiagnostic`; it cannot reset or resume it.

A completed cold-load diagnostic can separately authorize
`agent proposer continue-local-authoring`. This creates one fresh model-backed
assignment from the preserved proposal revision using the original captured
evidence, recorded role lineage, native skill and validation contract. It does
not reopen the failed worker or grant another validation-only attempt. The
current correction permits only a module-level real ExcelAgent import after
mock registration and an optional existing-card update. The complete behavioral
suite must remain unchanged; the controller checks this before committing.
One diagnostic may reserve only one successor, with zero in-attempt repairs.
Diagnostic receipts remain ineligible for acceptance or publication; the normal
dispatcher must validate the new revision before publishing its draft.
The successor's native test process uses a new private temporary directory for
its default Jest cache, with no change to the approved profile or test timeout.
Before publication, the controller also checks the actual emitted native test
code for an executable SUT import after mock registration and before the suite.

### 1JS declarative E2E authoring

The optional `1js-declarative-e2e-authoring` binding targets
`.github/skills/author-declarative-e2e-test/SKILL.md`. It is disabled and
unqualified in `pilot.example.json`; configuring a checkout or qualifying the
skill does not enable routing, writes, validation, push or Draft PR creation.
The binding accepts only `declarative-e2e-mini-spec-batch-v1`. Reviewed and
FILTER handoffs must provide every batch item before assignment:

```json
{
  "format": "declarative-e2e-mini-spec-batch-v1",
  "items": [{
    "inputItemId": "bizchat-create-canary-excel",
    "title": "Create a Canary Excel workbook from BizChat",
    "account": "AAD",
    "entryUrl": "https://copilot.cloud.microsoft/chat",
    "preconditions": ["Use the qualified signed-in AAD profile."],
    "orderedTestSteps": ["Open BizChat.", "Create and open the workbook."],
    "expectedUserVisibleAndDataOutcomes": ["A real .xlsx workbook opens and satisfies the declared table contract."],
    "cleanup": ["Restore changed flight values and close only the test-owned tab."]
  }]
}
```

Missing, malformed, differently versioned or duplicate-ID input blocks before
the worker starts. The validated object is content-bound into the coverage plan
and assignment and is shown to the repository skill as
`repositorySkillInput`; the skill may inspect the exact source revision but may
not invent omitted authoring requirements.

1JS authoring uses directory prefixes only for scenario directories and exact
`allowedWriteFiles` for shared declarative composites, UI maps and resource
registries. This intentionally excludes runner, loader and verifier code.
Harness repairs such as workbook-identity resolution require a separate,
explicitly authorized change/PR rather than broadening an authoring assignment.

The bounded model worker has file tools, not browser or process execution.
Native pre-authoring exploration and validation therefore require a separately
authorized executor and source-bound evidence. File edits alone are unvalidated
proposals, not completed native-skill execution; this boundary does not block OA
in-process integration validation.

Static validation and scenario discovery are necessary but do not prove the
signed-in product flow. The controller's blocking authoring gate is a qualified
local profile that runs the authored batch five consecutive times with retries
disabled on its final implementation SHA. After those source-bound gates pass,
an enabled `draftBuild` queues exactly one Pipeline 36540 build for the pushed
Draft branch and exact revision, records the returned build URL in the Draft PR
description, and returns immediately without polling the build.

For 1JS, that build validates **new cases only**, not the existing catalog.
The controller derives newly added, discoverable scenario paths from the exact
assignment-base-to-authored-commit diff and supplies `newCaseSelection` and
`newCaseGroups` to the qualified pipeline revision. These parameters are
controller-owned; do not put them in `draftBuild.templateParameters`. Empty
selections block before push rather than falling back to the full suite.
The build receipt and Draft description preserve the paths and both revisions.
The 1JS pipeline must support this contract: it verifies the Git additions,
narrows its snapshot execution policy and manifest, applies an exact-title
filter, and skips unaffected suites. Its ordinary scheduled full regression
remains unchanged. An older pipeline that rejects these parameters must be
updated, not retried without the scope.

This mirrors the OfficeAgent authoring contract: deterministic local validation
blocks publication; longer remote validation is transparent asynchronous review
evidence. A queued build does not make the Draft remotely qualified, and a later
failure must remain visible to reviewers, but it does not erase the successful
local authoring proof or require five costly controller-queued builds. Any
stricter repository-owner delivery policy remains a separate human merge gate.
### Staged validation receipts

A content-bound profile may opt into controller-managed staged validation with
one `PILOT_VALIDATION_PLAN` JSON comment. The fixed stage contract is
`dependencies`, `compile`, `policy`, then `test`; the controller selects the
stage through `PILOT_VALIDATION_STAGE`, not through worker input. Before worker
authoring it can prepare the pinned base revision in a controller-only
workspace. Preparation has two independently auditable receipts. The
dependency receipt is keyed by the lockfile inputs, profile hash and
Node/Corepack/Yarn/platform fingerprint, not by source revision. A compile
receipt binds an exact source revision and build configuration to that
dependency receipt. Validation artifacts record dependency and compile cache
hit/miss state plus checkout, dependency materialization, preparation, policy,
test and cleanup timings. Cache-hit artifacts also separate receipt loading,
changed-path checks, input fingerprinting and prepared-output verification;
cleanup separates source restore, prepared-output verification and source
cleanliness. Yarn resolution/fetch/link subphase timings are included when
available.

Version 3 staged plans may bind an `azure-artifacts-npm` or approved
`repository-broker` authentication
contract. Before a local or Remote Agency author launches, a controller-owned
preflight checks authentication only when the matching dependency receipt is
absent. Version-3 authentication profiles also finish exact-base preparation
before authoring, so a subsequently rejected cache cannot strand a new authored
commit behind an undiscovered authentication requirement. If the
pinned provider is missing or the current user must sign in, dispatch returns
`action-required-auth` while the assignment remains `prepared`; no workspace,
worker session or tool budget is created. The result contains a non-secret,
structured remediation command bound to a controller-owned `.yarnrc.yml`
snapshot extracted from the exact base revision. After the user approves any
required pinned provider installation and completes Microsoft sign-in/MFA, the
agent retries the original controller command once and resumes the same
assignment. If preparation reports `blocked-auth` after a receipt-only preflight
skipped the check, both providers run one forced non-interactive preflight and
return the same remediation action. This check neither deletes a trusted receipt
nor automatically retries preparation.

The exact-revision dependency preparation still performs a final non-interactive
authentication validation before the locked restore. It never emits a token or
passes arbitrary shell secrets to the worker, compile, policy or test stages.
Unexpected provider drift, anonymous requests, expired credentials or feed
denials after preflight become `blocked-auth` and are not treated as
infrastructure retries. Dependency and compile cache hits do not run either the
authentication check or the authentication stage.
Failure artifacts retain only the stage, a typed safe reason, a numeric process
exit code when available and `tokenRecorded: false`; raw credential-provider
diagnostics are not retained. Missing providers, version mismatch, invalid feed
configuration, explicit refresh requests and credential-validation failures are
distinct. A validation failure alone does not establish that a login expired.

On a new Windows machine, the agent may prepare the approved provider and
current user's feed authentication explicitly:

```powershell
npm run setup:validation-auth -- -Workspace C:\path\to\OfficeAgent

# Only when the pinned provider is absent or has the wrong version, after
# approving installation of @microsoft/artifacts-npm-credprovider@1.2.1:
npm run setup:validation-auth -- -Workspace C:\path\to\OfficeAgent -InstallProvider
```

The general `npm run setup` command intentionally remains offline with respect
to product-repository authentication. Agents must never ask users to paste
tokens; the approved setup command delegates credential acquisition to the
pinned provider and the Microsoft sign-in flow.

The 1JS SDX profile uses the repository's documented
`@1js/node-azure-auth` broker. Its preflight runs only `yarn auth --skip-auth`
from an attested exact-revision checkout and suppresses broker diagnostics; it
does not acquire or persist credentials. If the check fails, the controller
returns an explicit `action-required-auth` remediation to run `yarn.cmd auth`
from the checkout's `midgard` directory. That interactive command is never run
automatically, and no token or credential value is included in controller
evidence.

For real 1JS publication, configure `commitIdentity` with the authorized
corporate author and `pr.sourceBranchPrefix` with a repository-approved user
namespace, for example `user/<alias>/periodic-evidence-agent`.
The controller appends the assignment ID and uses the same ref for provisioning,
push, Draft PR discovery/creation, and cleanup verification. Omitted prefixes
retain `refs/heads/pilot/` for compatibility; that namespace and a bot author
email may be rejected by repository policy even when local validation passes.

Receipt reuse is deterministic and fail closed. Each compile preparation starts
from a fresh exact-revision source clone and receives a controller-made copy of
the verified dependency snapshot. The controller records every ignored
`node_modules` root produced by the locked install, uses native multithreaded
copying on Windows, and rewrites every internal junction or symbolic link to the
corresponding fresh-checkout path. Dependency fingerprints bind that complete
root inventory, Yarn install state, normalized internal links, empty
directories and every ordinary dependency file's size and content hash.
Test-only classification disables Git rename collapsing so both the removed and
added sides of a rename must independently remain within approved test paths.
Production
or build input changes rerun compile but reuse dependencies. A later test-only
revision may reuse both receipts. Lockfile/profile/toolchain drift, missing or
corrupt snapshots and receipts, or ambiguous paths rerun dependency preparation
and compile. A recoverable retry of the same revision reuses completed
preparation but reruns policy and test. Snapshot and prepared workspaces are
serialized per receipt. Creation and process-local loading verify the complete
content/link fingerprint, then controller-owned recursive output-root watchers
fail closed on changes between and during runs. File `change` events are accepted
only when a fresh content hash still matches the verified process-local baseline;
additions, removals, renames and actual content changes invalidate the cache.
Directory `change` events require recursive content verification, including when
only an ancestor event is delivered. Overlapping paths coalesce into bounded
worker tasks without dropping descendant coverage. Incremental dependency-subtree
checks use the same recursive partitioner
as complete snapshots, with at most 2,048 filesystem entries per leaf task and
the existing five-minute task deadline; parent directory manifests are rebuilt
from every child result. Settlements serialize per
guard and wait for queued events after hashing. A `change` notification without a
filename requires complete-root content/link and membership revalidation against
the baseline; it never means that changes are ignored. This handles Windows
access-time notifications caused by reading unchanged files. Unknown `rename`
notifications and watcher errors still invalidate trust, including during initial
verification. Repeated events must settle within four passes or trust is rejected.
Artifacts record changed-path, rehashed-entry, incremental worker-task,
full-root revalidation and settlement-pass counts alongside wall time.
Preparation failures preserve the exact verification reason and event details.
Large output sets calculate independent output roots
through a bounded controller-owned worker pool. Test-only reuse validates the
active compile workspace and stable dependency inputs; regeneration of an
equivalent dependency receipt does not discard an intact content-verified
compile snapshot. Damage to an unused dependency source workspace is rebuilt
before any later compile. Workers and repository skills cannot access, write or
approve cache metadata.

### 1JS declarative E2E authoring

The optional `1js-declarative-e2e-authoring` binding targets
`.github/skills/author-declarative-e2e-test/SKILL.md`. It is disabled and
unqualified in `pilot.example.json`; configuring a checkout or qualifying the
skill does not enable routing, writes, validation, push or Draft PR creation.
The binding accepts only `declarative-e2e-mini-spec-batch-v1`. Reviewed and
FILTER handoffs must provide every batch item before assignment:

```json
{
  "format": "declarative-e2e-mini-spec-batch-v1",
  "items": [{
    "inputItemId": "bizchat-create-canary-excel",
    "title": "Create a Canary Excel workbook from BizChat",
    "account": "AAD",
    "entryUrl": "https://copilot.cloud.microsoft/chat",
    "preconditions": ["Use the qualified signed-in AAD profile."],
    "orderedTestSteps": ["Open BizChat.", "Create and open the workbook."],
    "expectedUserVisibleAndDataOutcomes": ["A real .xlsx workbook opens and satisfies the declared table contract."],
    "cleanup": ["Restore changed flight values and close only the test-owned tab."]
  }]
}
```

Missing, malformed, differently versioned or duplicate-ID input blocks before
the worker starts. The validated object is content-bound into the coverage plan
and assignment and is shown to the repository skill as
`repositorySkillInput`; the skill may inspect the exact source revision but may
not invent omitted authoring requirements.

1JS authoring uses directory prefixes only for scenario directories and exact
`allowedWriteFiles` for shared declarative composites, UI maps and resource
registries. This intentionally excludes runner, loader and verifier code.
Harness repairs such as workbook-identity resolution require a separate,
explicitly authorized change/PR rather than broadening an authoring assignment.

Static validation and scenario discovery are necessary but do not prove the
signed-in product flow. The controller requires the qualified local profile to
run the authored batch five consecutive times with retries disabled on the
final implementation SHA. It then queues one non-blocking Pipeline 36540 build
for that exact SHA, writes the build link into the Draft PR and does not wait
for completion. The Draft is locally validated but remains remotely pending;
later remote failure is retained as review evidence. Repository-owner policies
that require additional CI proof remain human merge gates rather than
controller publication loops.

## Safety invariants

Agent 2 FILTER owns loose, high-recall title screening. The
[offline batching flow](APP-NATIVE.md#complete-record-filter-batches)
uses complete-record batches under explicit verified or user-approved bounded
estimate budgets, preserving related
context and consolidating all source-version results locally before proposer
handoff. Ambiguous and absent titles retain details; only obvious policy
exclusions may screen out, with typed reasons and title quotes. Titles establish
neither missing coverage nor executor feasibility. Existing
[title-first helpers](APP-NATIVE.md#title-first-filter-screening) remain optional
audit/selective-export tools, not a lazy-input prerequisite. Batch preparation,
membership checks and consolidation do not launch hosted jobs. Main flow/state remain
local. E2E execution/setup is deferred independently; relevant E2E findings and
coverage facts remain in the audit/handoff rather than being excluded.

- All 14 exclusions in the schema apply to **both defect and improvement**
  handoffs. Excluded evidence is audit-only. Functional classification is not
  confirmation of a code defect. Unknown ownership stays blocked.
- Preserve source ID/revision, query/asOf/review times and provenance. Imported
  app receipts are `app-tool-reported`; directly verified adapter reads are
  `authenticated-source`; directly identity-verified local CLI reads are
  `workiq-cli-verified`; fixtures are `synthetic`; owner exports are
  `owner-provided`. Never promote fixtures or imports to authenticated access.
- Scope and budgets are enforced before reads. Created and changed ADO lanes
  stay separate. Enumerate channel roots and replies, including older threads.
  Partial/auth-failed passes retain earlier evidence and the prior committed
  cursor. Only complete passes advance it. Missing data never becomes clean zero.
  WorkIQ modified-time scans are separately selected; budget continuations need
  a new run and explicit additional-budget approval. Complete enumeration is
  not a consistent historical snapshot.
- Stop on authentication failure; no retries until supported host refresh and
  a separately authorized attempt. No Graph fallback, token transfer, credential
  cache inspection, alternate identity or new grant. App and SDK auth are distinct.
- Claim assignments atomically before launch; persist handles promptly and
  reconcile uncertain outcomes. No duplicate workers or validation launches.
  Code changes require source-bound execution evidence for every approved gate;
  queued builds or policy checks alone are not validation.
- Draft PRs only. No merges, auto-completion, incident/ticket/source writes,
  unauthorized validation retry/cancel/requeue or implicit scheduling.
  Follow-up is separately bounded to at most one level, not a paging-budget escape.

Draft publication and merge are outside the autonomous loop. A separate user
instruction must explicitly identify the repository and PR number or URL and
authorize the requested action. An ambiguous "merge this PR" is not authorization
when multiple PRs are in scope: clarify the exact PR, or leave drafts unchanged
if the user is unavailable. Approval for a controller PR does not authorize
publishing or merging generated product PRs. Passing validation, assignment
completion and server mergeability do not change this boundary.

Null limits are unresolved, not unlimited. Instructions alone are not runtime
enforcement; app permissions and native validation boundaries must also be
qualified. The app helpers track external worker outcomes but do not assert
that a reported draft has passed product validation.

## Validation and sharing gate

| Evidence | Demonstrated | Not established |
|---|---|---|
| Offline tests/demo | Synthetic ledger, scope/identity guards, exclusions, cursor retention, dedupe, claims and fixture execution | Live identity, permissions or product correctness |
| Historical local ADO run | Created 47 / changed 59 (39 changed-only), both passes complete at their recorded snapshots | Another user's access or ongoing coverage |
| Historical app WorkIQ run | Identity and 20-root metadata page succeeded, then detail read returned `AuthenticationRequired` (500) | Full-day roots/replies/body coverage or auth recovery |
| Local CLI WorkIQ continuation | Fresh identity, one bounded continuation; cumulative 4,000 examined / 4,003 returned, eight cohort records, three buffered | Exhausted channel enumeration, historical snapshot, renewal or app-HTTP recovery |
| IcM | Connector context/team mapping and bounded diagnostics on the pilot host; offline receipt replay/owner-export guards | Saved-query Source Created Time equivalence, live adapter activation or complete incident coverage |
| Bounded local saved-source proposer | One selected regression-coverage case, real native-skill authoring, two passing native legs, automatic push and one draft PR at a prior private revision | This reconciled revision live, browser E2E, hosted execution, full-cohort or recurring qualification |

The historical collection-only run remains **partial-or-blocked** and launched
no workers, PRs or schedules. The separately demonstrated bounded proposer above
does not complete that collection scope. Raw receipts, identities and runtime
state are not part of this package. Offline CI cannot promote either result
into broader live qualification.

Before calling this a successfully validated live collection pilot, obtain
complete authorized source coverage within the approved caps, durable receipts
and restart/replay evidence, and confirm zero unapproved effects. The blocked
app-HTTP WorkIQ binding needs supported app-host refresh before further reads.
Separately authorized local CLI execution does not unblock that connection.
IcM must be
qualified or explicitly excluded from a separately approved reduced release
scope; do not silently waive it. Collection-only success still does not qualify
code-fix/PR automation. Sharing preparation does not itself satisfy this gate.

### Head-bound PR review receipt

The pilot includes an auditable merge-preparation receipt for GitHub PRs. The
receipt records the exact reviewed head and base SHAs, reviewer/session,
findings, validation and residual risks. It contains no source evidence and is
posted as a structured PR comment through the already authenticated GitHub CLI.

```powershell
Copy-Item .\scaffold\pr-review-receipt.example.json .\review-receipt.local.json
# Fill in the exact PR head/base SHAs and the completed review results.
npm run pilot -- pr-review-publish --repo OWNER/REPO --pr NUMBER --file .\review-receipt.local.json
npm run pilot -- pr-review-verify --repo OWNER/REPO --pr NUMBER
```

Automatic publication is limited to the signed-in user's own PR. Another
author's PR requires explicit approval plus `--approve-other-author`.
Verification fails closed when the PR head/base changed, no matching receipt
exists, blocking findings remain, or any recorded validation failed or was not
run. The ignored `*.local.json` name prevents the local receipt from entering
the package. The command complements required CI and branch protection; it does
not merge or alter the PR.

### Authorized reviewed-handoff submission

The versioned `ReviewedHandoff` receipt is an upstream review decision, not a
second review implementation. It carries explicit source-neutral fixture
provenance, reviewer/exclusion/classification decisions and the requested
repository capability. `src/reviewed-handoff.js` is the production controller
boundary: it validates the receipt, materializes linked ledger records
idempotently, invokes normal planning/routing/assignment and dispatch, and owns
all repository side effects. `submit-reviewed-handoff` is the production-named
thin CLI boundary; it does not add orchestration or model permissions. Tests
invoke this same controller API and CLI rather than a separate E2E adapter.

Prepare the handoff without launching a worker or creating repository effects:

```powershell
npm run submit:reviewed-handoff -- --file .\test\fixtures\reviewed-handoff\onenote-bootstrap-progress.reviewed-handoff.json --config .\pilot.local.json --prepare
```

An authorized operator may run the real reviewed-handoff repository path only after
setup/qualification and separate acknowledgement of synthetic input, commit,
push and Draft PR effects:

```powershell
npm run submit:reviewed-handoff -- --file .\test\fixtures\reviewed-handoff\onenote-bootstrap-progress.reviewed-handoff.json --config .\pilot.local.json --execute --authorize-synthetic --authorize-commit --authorize-push --authorize-draft-pr
```

#### Authoring provider modes

The default remains `copilot-sdk`. A repository skill binding may explicitly
select `agency-local` or `agency-remote`; there is no repository-wide switch and
no automatic fallback between providers.

| Mode | Authoring compute | Source transport | Validation, final push and Draft PR |
| --- | --- | --- | --- |
| `copilot-sdk` | Local Controller process | Controller-owned workspace | Controller-owned |
| `agency-local` | Local Agency process with the five authenticated `pilot_*` tools | Controller-owned workspace | Controller-owned |
| `agency-remote` | Agency remote job on a qualified exact-base branch | One bounded result commit on a separate `pilot-agency-result/...` branch | Controller fetches, audits and imports allowed files, then owns all remaining steps |

`agency-remote` requires an Azure DevOps repository and an explicit provider:

```json
{
  "authoringProviders": {
    "agency-oa": {
      "type": "agency-remote",
      "executable": "C:\\absolute\\path\\to\\agency.exe",
      "profile": "periodic-evidence-isolated",
      "model": "gpt-5.6-sol",
      "pollSeconds": 30
    }
  }
}
```

The remote worker may commit and push only the deterministic result ref. It may
not create the final PR or merge. The Controller requires terminal Agency
success, exact-base ancestry, a bounded commit range, approved regular-file
paths, file-size limits and a matching
`.periodic-evidence-agent/result.json` envelope before importing anything.
Remote logs are diagnostic only; source state is the transport authority.
See [Authoring providers](AGENCY-LOCAL-AUTHORING.md) for the complete comparison
and operational limitations.

#### Bounded multi-repository scheduling

`limits.maxWorkers` is the shared Controller-wide admission cap.
`limits.maxWorkersPerRepository` defaults to `1` and must not exceed the global
cap. Different repositories can therefore author and validate concurrently
while a repository uses one heavy validation lane by default. Admission is
committed in the SQLite ledger before authoring starts; each assignment owns an
independent `dispatch:<assignment-id>` lock, so a long remote job does not hold a
global dispatch lock.

Prepared assignments can be previewed and then launched concurrently:

```powershell
npm run pilot -- dispatch-ready --config .\pilot.local.json
npm run pilot -- dispatch-ready --config .\pilot.local.json --execute `
  --authorize-commit --authorize-push --authorize-draft-pr
```

The scheduler selects jobs deterministically, visits repositories in order of
their oldest waiting job, respects active hosted and local workers, and launches only jobs
that are still `prepared`. Each selected assignment is atomically admitted
again by normal `dispatch`; an overlapping scheduler can therefore observe an
`overlap` result but cannot submit a duplicate remote job. Scheduler batches
and per-assignment outcomes are durable ledger operations. This supports
concurrent repositories on one Controller machine; the SQLite ledger is not a
multi-machine lease service.

Authentication actions are retained in each scheduler result while the affected
job remains `prepared`; other selected repositories may continue. A batch with
authentication actions, blocked/uncertain jobs or failed outcomes is recorded as
`partial`, not successful delivery. Follow the returned authentication recovery
procedure rather than resubmitting the batch blindly.

The ordinary live `dispatch` entrypoint continues to reject synthetic evidence.
Only the controller's non-forgeable reviewed-handoff dispatch path accepts the
explicitly authorized synthetic receipt. A repository worker may follow a
repository-native skill to author changes, but neither the worker nor skill
receives shell, Git, network or PR permissions. Synthetic controller fixtures
verify the test-only write and diff gates without depending on a real incident
remaining unresolved.

After each authored revision, the controller commits it and runs the fixed
approved validation gates at the exact commit. Profiles without a valid staged
plan retain the original fresh temporary checkout for every attempt. Staged
profiles use separate controller-owned dependency snapshots and exact-revision
compile workspaces with immutable receipts and exclusive access. A dependency
snapshot can serve fresh source checkouts that share its lockfile, profile and
toolchain fingerprints; only deterministic test-only revisions reuse compile
outputs. The implementation retains `clone --no-hardlinks` for source
preparation: detached worktrees or shared-object clones make a durable cache
depend on another worktree's lifetime. Detached worktrees remain suitable for
ephemeral checkout optimization, but not as the durable receipt workspace.
Fingerprint workers share the SHA-256 helper without loading the controller's
schema validator; parallel output verification and cache mutation checks remain
enabled.
A runner cannot validate changes it made during
execution: changed source or HEAD is blocked, and changed declared snapshot or
prepared output invalidates the cache.
Explicitly classified infrastructure blockers may receive at most
`limits.maxValidationInfrastructureRetries` attempts; trust, profile-hash and
policy failures are never auto-approved. A failed revision remains immutable validation
evidence; when `limits.maxValidationRepairRounds` permits, the controller gives
bounded diagnostic tails to a new repository-skill repair round, commits the
repair as a new revision and validates again. This is not a retry of the same
validation operation. The repair budget defaults to 10 rounds and cannot exceed
10. Controller-owned validation profiles must emit
`PILOT_VALIDATION_PROFILE_ERROR:` for invalid test selection or other profile
configuration failures; those failures block publication and never consume a
repository-skill repair round. The final committed revision is independently validated
before push and Draft PR creation. Exhausted failed rounds remain blocked
locally; they cannot create a failed Draft PR. Merge is always
prohibited. Offline CI injects external model/PR boundaries and performs no
network access or live PR creation. Git push checks use temporary local bare
repositories only.

### Authoring workspace lifecycle

Local tasks use independent clones under
`<stateDirectory>/workspaces/<session_id>`, not shared Git worktrees. Automatic
cleanup is disabled by default, including when the configuration omits
`workspaceCleanup`. When explicitly enabled, after a Draft PR delivery receipt
is persisted, the task completes and releases its dispatch lock, the controller
attempts to remove its authoring clone. GC also understands historical
failed-validation draft delivery receipts; new dispatch is pass-only.
Blocked tasks and tasks without a complete delivery receipt retain their clones.
Hosted execution does not create a local clone to clean.

The optional configuration controls automatic cleanup:

```json
"workspaceCleanup": { "enabled": false, "retentionHours": 0 }
```

Complete a controlled live smoke test in the approved environment before setting
`enabled` to `true`: preview an explicitly disposable, completed delivery, verify
the intended directory and remote commit, execute cleanup with only that
candidate eligible, and confirm that the PR, evidence, primary checkout and
caches remain intact. Never enable live cleanup using unresolved example settings.

A positive `retentionHours` retains the clone until that interval has passed
since delivery; there is no background cleanup scheduler. Manual GC remains
available even when automatic cleanup is disabled. Run it for controlled
validation, delayed cleanup, historical clones or retryable deletion failures.
Preview is the default:

```powershell
npm run pilot -- workspace-gc --config .\pilot.local.json
npm run pilot -- workspace-gc --config .\pilot.local.json --execute
```

GC checks only ledger-registered task directories. It takes controller locks,
requires a completed task with no unfinished operations, checks preserved
validation artifacts, and verifies that the remote task branch still points to
the delivered commit. Missing or changed remote branches, authentication
failures, detached HEAD, modified/untracked/ignored files, stashes, additional local branches
or linked Git worktrees prevent deletion. Historical clones may retain a copied
base branch only if its commits are included in the delivered revision.
Linked directories, primary checkouts and paths outside the exact registered
task directory are never removed.

Cleanup results are recorded separately in the ledger and exposed by `status`.
A cleanup failure does not change a successful PR delivery into a failed task;
manual GC reports failures separately. An interrupted or partially deleted clone
is retained if safety checks cannot be satisfied. Remote PRs and branches,
evidence, delivery receipts, the ledger, primary checkouts and prepared
dependency/compile caches are preserved. This repository does not restore
delivered workspaces, review PRs or merge them.

Remote Agency input and result branches have a separate fail-closed cleanup:

```powershell
npm run pilot -- transport-gc --config .\pilot.local.json
npm run pilot -- transport-gc --config .\pilot.local.json --execute
```

Preview is the default. Cleanup requires a completed Draft PR delivery after
the configured retention interval, no unfinished task operation, a retained
per-round result receipt, exact remote tips for every deterministic
`pilot-agency-base/...` and `pilot-agency-result/...` ref, and a final
`pilot/<assignment-id>` branch that still matches the delivered revision. Only
the exact transport refs are deleted. The final branch, Draft PR, validation
artifacts, delivery records and repository checkout are never deleted. Missing
or mismatched refs are retained for reconciliation, and successful cleanup is
idempotently recorded in the ledger.

### FILTER-to-proposer handoff

`submit-filter-handoff` is the production bridge from the complete-record
`filter-consolidation-v1` flow to the same planning, repository-skill,
validation, push and Draft PR controller exercised by the reviewed-handoff E2E.
It accepts only a complete held consolidation with one unblocked selected
candidate, reloads the exact manifest and result receipts, imports the original
authenticated evidence and capture bytes, and requires the selected repository
revision to match the current repository-skill qualification. It never converts
the result into synthetic fixture evidence and does not accept a caller-supplied
review, repository or source revision.

Before submission, run the read-only
[`filter-execution-check`](AGENCY-EXECUTOR.md#source-bound-cohort-and-colleague-handoff)
against the original execution ledger and exact manifest/results. This remains
an operator prerequisite: the proposer adapter checks structural consolidation
and source/skill pins, but does not itself load or regrade Agency execution
receipts. Its acceptance is not proof of accepted FILTER execution, and downstream
authorization flags do not replace that check.

For AL setup and day-to-day operation, start with the
[AL Agentic Loop Setup and Operations Guide](scaffold/AL-AGENTIC-LOOP.md).
It covers the separate FILTER/authoring skills, four-owner native scope,
finite recurring actions and operator-owned deployment boundaries.

The AL-specific [`scripts\augloop.mjs`](scripts/validation/AUGLOOP.md) entrypoint
enforces that original-ledger reconciliation before its `prepare`/`propose`
operations. It composes the same collection, exact batching, local FILTER,
skill-qualified handoff and source-preserving continuation APIs. Its native profile
supports all four AL discovery owners, retaining Session Protocol's Gulp/Mocha
runner and the other owners' Jest configurations. Use `qualify` for real isolated
backend/baseline qualification and `replay` for an original model-authored candidate;
neither is a fresh evidence/model E2E. The
[`augloop.repository.example.json`](scaffold/augloop.repository.example.json)
is disabled until private paths, identity, source/skill pins and actual qualification
are supplied. New AL authoring uses the merged repository-native skill
`utils/excel-agent-in-container-proxy/.github/skills/excel-agent-in-container-proxy-integration-tests/SKILL.md`
(`excel-agent-in-container-proxy-integration-tests`). Explicitly invoke that path
or name in the task; controller authoring and repair prompts name the configured
path. Its `references/suites.md` companion is read from the pinned product
workspace using normal `pilot_read`. Use a newly qualified exact product base
containing the skill; old baseline qualifications do not transfer. FILTER still
uses native-main `.github/skills/tests/SKILL.md`. Explicitly pinned historical
external bundles remain supported for old runs/replay, without implicit fallback
or changes to original receipts. This migration grants no new provider, model,
remote-execution or publication capability.

For explicit sparse AL checkouts, configure the exact revision's read-only
build/dependency/fixture/skill closure, not just the test write scopes. Native
preparation preserves those paths and binds cache reuse to their effective set.
Sparse installs use the product's derived-lock contract; full checkouts remain
immutable. A changed native profile needs fresh qualification, not updated hashes
on old receipts. See [sparse native preparation](scripts/validation/AUGLOOP.md#sparse-native-preparation)
and the operating guide's blocker/recovery table.

For reusable AL operation, `capabilities` inventories the pinned repository's
actual workspace contracts, distinguishing supported/qualified owners from
discovered but unsupported families. The opt-in `cycle` command composes existing
one-shot collection, complete-cohort FILTER and native handoff with durable
windows, overlap locks, evidence deduplication and finite per-cycle authorization.
[`augloop.recurring.example.json`](scaffold/augloop.recurring.example.json) is
inactive: operators must configure cadence and new expiring source/model/Draft
budgets. No scheduler is installed, and a completed one-run authorization is
never a recurring grant. See the [operator contract](scripts/validation/AUGLOOP.md).

For large local-SDK cohorts, opt-in `localFilter.evidencePaging: true` sends
the exact index/policy and exposes original records through
`pilot_filter_evidence(index, offset)` instead of duplicating all bodies in the
initial prompt. Each retained detail decision requires byte-zero-through-EOF
delivery of that record and its lossless capture representation. Reconciliation
reconstructs every page from the original manifest and rejects altered or missing
pages. Title-only exclusions retain the original title policy. Contextual batches
are not supported by this option and fail closed. Enabling it after a failed
session requires a new explicitly authorized successor; prior receipts and
configuration remain immutable.

The input contains the immutable FILTER binding and the repository capability
used for routing, plus optional structured skill input and a source-bound
`routing.existingFixesReview` when known product fixes require reconciliation:

```json
{
  "format": "filter-proposer-handoff-v1",
  "filter": {
    "manifestPath": "C:\\private\\filter-batches.json",
    "resultPaths": [
      "C:\\private\\filter-result-1.json",
      "C:\\private\\filter-result-2.json"
    ]
  },
  "routing": {
    "capability": "integration-test-authoring",
    "requestedOutcome": "add-or-update-tests"
  }
}
```

Prepare without repository effects:

```powershell
npm run submit:filter-handoff -- --file .\filter-handoff.local.json --config .\pilot.local.json --prepare
```

Execution remains a separate operator decision:

```powershell
npm run submit:filter-handoff -- --file .\filter-handoff.local.json --config .\pilot.local.json --execute --authorize-commit --authorize-push --authorize-draft-pr
```

The connected regression in `test/filter-batches.test.js` follows an accepted
source-bound FILTER result through declarative mini-spec planning, pinned skill
loading, bounded authoring, exact-revision validation and a local-bare Git push.
Source/provider receipts, the repository skill, model output and draft receipt
are synthetic; the validation command checks the generated fixture contract,
not a browser. This proves controller wiring, not native skill qualification,
product coverage or live E2E success. Real E2E still requires an approved identity,
reachable dedicated browser endpoint and successful repository-native execution.

Worker calls to `pilot_list`, literal `pilot_search`, ranged/full `pilot_read`,
`pilot_write`, expected-text-checked `pilot_replace_lines` and `pilot_finish`
share one `workerMaxToolCalls` budget across
the initial authoring and every repair round. Search and ranged reads are
repository-local, read-only and bounded; they do not grant shell or network
access. `pilot_replace_lines` preserves the file's line endings and permits at most
500 existing lines per call, under exactly the same edit bounds as `pilot_write`.
`pilot_list` accepts an optional repository-relative directory and requires a
narrower scope when the root file inventory exceeds the file-size
limit. Each worker result records the limit, total/remaining calls, per-tool
counts and per-round usage so operators can replace bootstrap limits with an
observed percentile plus explicit headroom.

`test/fixtures/reviewed-handoff/validation-repair-drill.json` is the deterministic
failed-to-passed fixture. Its first revision intentionally fails the repository
gate; the next skill round consumes controller diagnostics, changes only the
failing test, and is committed and validated as a distinct passing revision.
Before push or draft creation, every required gate must pass at the exact clean
current revision. Exhausted repair rounds, missing or stale gate results, and
post-validation source changes remain blocked locally; failed drafts are not
published.

Repository-skill bindings use the existing Copilot SDK authoring transport by
default. A binding may explicitly select the opt-in
[Local Agency authoring provider](AGENCY-LOCAL-AUTHORING.md), which exposes the
same five controller-owned tools through an authenticated stdio MCP bridge and
resumes the exact Agency session for repair rounds. The assignment remains
local: provisioning, commits, exact-revision validation, push, Draft PR
creation, reconciliation and the no-merge invariant are unchanged. This is
separate from the hosted [Agency executor](AGENCY-EXECUTOR.md).

| Authoring option | Selection | Additional runtime | Recommended use |
|---|---|---|---|
| Copilot SDK | Default | Existing SDK session | Lowest-complexity production baseline |
| Local Agency | Explicit binding opt-in | Agency CLI, private profile and authenticated MCP bridge | Qualifying Agency orchestration without transferring controller authority |

These are two transports for the same controller workflow, not two different
permission models. Both receive the same bounded tools and repository skill;
neither can commit, validate, push, create a Draft PR or merge independently.
See the provider document for the
[full comparison](AGENCY-LOCAL-AUTHORING.md#copilot-sdk-comparison).

### Sanitized E2E proof bundles

After a real FILTER-to-proposer run reaches a terminal
`draft-pr-validated` worker result, export a sanitized proof bundle into the
tracked `e2e-evidence` directory. The private request binds the original source
ledger manifest, FILTER manifest/results and complete controller output:

```powershell
npm run pilot -- e2e-proof-export --file .\e2e-proof-request.local.json --output .\e2e-evidence\RUN_ID --config .\pilot.local.json
npm run pilot -- e2e-proof-check --file .\e2e-proof-request.local.json --bundle .\e2e-evidence\RUN_ID --config .\pilot.local.json
```

The exporter reopens the source ledgers read-only, reconstructs the full FILTER
cohort, verifies the selected candidate against the terminal worker result and
requires every validation gate to pass at the Draft PR head revision. Committed
files contain aggregate counts, source/result hashes, skill execution, safe
validation commands, Draft PR metadata and explicit limitations. Raw source
bodies, identities, captures, local paths, private packets and logs remain in
ignored approved storage.

## Public package boundary

This public repository contains reusable controller code, a lockfile, synthetic
tests/demo, role skills, contracts and offline CI. Publication does not establish
live qualification or grant access to product repositories or workplace data.
Private evidence, product source/tests/cards, runtime configuration, identities,
credentials and execution artifacts must remain outside the published history.
No license grant is implied beyond the repository's explicit licensing terms.

Before adding a remote or pushing:

1. Confirm approved destination, access membership, content/retention rules and
   whether experimental code sharing is authorized before live qualification.
2. Run `npm test`, `npm run demo` and `npm run check:package`. Review
   `git diff --cached`, `git ls-files` and **all history**, not just `.gitignore`.
   The package check is a targeted hygiene guard, not a general secret scanner.
3. Verify personal config, `.state`, SQLite/WAL/SHM files, captures/receipts,
   `.env*`, logs, credentials, session folders and `node_modules` are absent from
   the tracked set/history. Do not upload raw evidence or auth support artifacts.
4. Review author metadata as published content. Select an appropriate Git
   identity, such as the account's GitHub noreply address, and retain required
   coauthor attribution; do not accidentally publish a configured workplace
   email. Removing a file from HEAD does not remove it from history; do not
   publish unsuitable history or rewrite it without explicit authorization.

No live publication remote is created and nothing is pushed to a live remote by
installation, tests, demo or CI. The demo uses disposable local Git checkouts and
mocked publication; some controller tests push only to temporary local bare repos.
Do not send the entire working directory as a zip. After review, use Git's
committed tree/export so ignored personal files cannot be included accidentally.
Colleagues must configure their own approved identity/scopes/authentication.

When integrating private development, start from the freshly fetched public
baseline and reconcile only approved reusable changes. Do not merge or
cherry-pick private history wholesale, even when its final tree looks clean.
After committing, audit every outgoing commit and reachable new blob against
that baseline, including commit messages and metadata, then push only the
reviewed branch with an explicit refspec. Never use `--all` or `--mirror`.
`check:package` inspects the staged tree and HEAD ancestry, not every local ref;
it does not certify unrelated checkpoint refs or private branches. Keep those
local and preserve their original owners.

## Optional legacy SDK mode

Standalone SDK source/review/worker code and offline lifecycle regressions are
retained, but **not required** for the app-receipt path or demo. App-native config
rejects legacy network/model/worker/scheduler commands unless explicitly passed
`--execution-mode standalone-sdk`; that flag does not waive source/activation
guards. `node .\src\cli.js help` lists commands; use an explicitly approved
`--config .\pilot.local.json`.

The prior headless WorkIQ OAuth investigation is stopped. Do not use the retained
`scripts\Workiq-Auth-Repro.mjs --probe` to repair app auth or as a setup step.
It requires separate authorization. No token refresh, SDK bridging or listener
is part of this package. `scripts\Register-PilotTask.ps1` is legacy opt-in only;
do not run it during onboarding. All schedules remain disabled.

## Code map

`src\app-native.js` owns receipt imports and native assignment tracking;
`ledger.js` owns immutable state and atomic ownership; `sources.js` owns scoped
collection; `coordinator.js` owns review/routing; `followup.js` and `revisit.js`
own related/tracked evidence; `improvements.js` owns durable improvement and
coverage planning; `repository-skills.js` owns qualified repo-native skill
resolution and result normalization; `workers.js` owns legacy isolated execution,
validation and ADO draft-only publication; `runtime.js` owns optional SDK
bindings. `scaffold` contains portable policy/schema inputs, not a second
runtime configuration format. No app tools are assumed callable by scripts.
