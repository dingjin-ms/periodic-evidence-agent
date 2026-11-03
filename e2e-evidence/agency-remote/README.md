# Remote Agency E2E qualification

**Require real, repository-specific E2E evidence before claiming a remote path
is verified.** If proof is absent, inaccessible, or does not cover the requested
source/configuration, tell the user: **"This remote Agency path has not yet been
verified for this repository/configuration."** An explicitly authorized bounded
qualification probe may establish that proof; provider selection alone cannot.

## Current register

| Repository | Execution path | Recorded evidence |
|---|---|---|
| OA (`office-agent`) | Remote authoring -> audited import -> local validation | Implementation exists; no matching E2E proof registered here. |
| OA (`office-agent`) | Fixed candidate -> real remote validation -> local controller acceptance | **Passed within the recorded scope**, 2026-10-22, build `57844822`; [sanitized evidence](oa-validation-20261022.json). |
| OA (`office-agent`) | Remote authoring + remote validation (composed transports) | Requires composition E2E proof; not implied by the individual capabilities. |
| OA (`office-agent`) | Native skills -> validate -> bounded type repair -> revalidate in one remote job/workspace | **Passed within the recorded scope**, 2026-10-23, build `57969048`; [sanitized evidence](oa-workspace-loop-20261023.json). Real TS2322 failure, one repair, original gates and trusted final gates passed; independently accepted by the local controller. |
| OA (`office-agent`) | Real evidence -> new authoring -> validation / repair -> controller acceptance (`live-business-e2e`) | **Passed within the bounded qualification scope**, 2026-10-29 r8, build `58391519`; [sanitized evidence](oa-native-business-20261029-r8.json). Master-integrated controller, full local CI, new native authoring, real gates, fitness, fresh independent review, final remote gates and controller acceptance completed. First-pass success, not an observed candidate repair or product PR. The [r7 proof](oa-native-business-20261028.json) remains unchanged. |
| OA (`office-agent`) | Hosted Agency executor (separate task/result contract) | Requires its own proof; not qualified by the validation-only run. |
| 1JS (`1JS`) | Official Agency runner + TRIPS FIC + native BizChat-to-Excel declarative product validation | **Passed within the recorded scope**, 2026-11-02, orchestrator `58660325`, runner `58660451`; [sanitized evidence](1js-native-product-validation-20261102.json). Real authenticated BizChat created `Test_Table.xlsx`; native XLSX evidence verified worksheet `Test`, table 6×5, one header and five data rows. This does not enable production routing or qualify author/repair workflows. |
| 1JS (`1JS`) | Native skill -> new scenario authoring -> candidate commit/bundle -> TRIPS FIC -> real BizChat-to-Excel validation in one Agency workspace -> local controller acceptance | **Passed within the bounded recorded scope**, 2026-11-02, orchestrator `58677587`, runner `58679076`; [sanitized evidence](1js-same-workspace-live-e2e-20261102.json). The exact PEA implementation `c0da8ac0e72f08456813745cbd5659967eaa187b` passed the complete source-bound local CI. The real workbook `AgencyLive.xlsx` independently verified worksheet `AgencyLive`, table `AgencyLiveTable`, and range `A1:D5`. Product execution passed first time, so the product repair path was not exercised. No product PR, periodic task, or local-browser fallback occurred. |
| Office src / other repositories | Any remote path | No E2E proof registered here; do not infer support or qualification from OA or 1JS. |

The first row is the existing remote-authoring architecture, **not** the
fixed-candidate validation experiment. A diagram, implementation, another
session's unreviewed result, or combining two individually tested capabilities
does not establish an E2E run of their composition. A genuinely verified run
can be added when its authoritative evidence is available.

## Master-integrated replay: 2026-10-29 r8

Controller `1d115db378bc442007274bfb7646085ac2938348` includes master
`28e4542719228c2784036563cc6b46146a82e89d`. Integration retained the current
native supervisor's named-job/drain protocol, deferred unused Azure SDK loading,
and public-ledger dispatch guards. Complete local CI at that clean revision
covered all 91 discovered files exactly once: 1,811 passing tests, one conditional
skip, zero failures or cancellations; syntax, package and standalone demo passed.
The `remaining` group took about 51m48s. This is local fallback CI, not proof that
the hosted Actions 45-minute job limit or required branch checks have passed.

The one new Agency job `office-335b524d-43c2-4fcc-a7a2-c73a4b51008c`, ADO build
`58391519`, used pipeline `814573cc35d5376f7c584d1a6f336ed16017f07d`, the same
saved evidence, OA base, model, gates and budgets as r7. Native authoring committed
candidate `206c0291e75c983c2af8941bfc9586f6816342e3` remotely. Its first candidate
passed real compile/policy/integration gates, mutation/refactor fitness, a fresh
independent reviewer and trusted final remote gates. The exact suite passed all
four cases, preserving the original two and adding two. No candidate repair was
needed. Initial inspection rejected the build identity; read-only lookup and
standard resume continued the original job, without a replacement or new budget.

At `2026-10-29T02:58:58.157Z`, the standard local controller independently accepted
the candidate bundle, actual job/build/source/commands, reviewer and 3,517 files
covering 5,099,807,078 bytes. It ran no local product gates and imported no old
receipt. The original remote result remains `pending-external`; the separate
controller receipt is acceptance authority. The new JSON is sanitized audit
metadata, not a receipt or enablement grant. The controller source is frozen
before this audit-only commit; no product PR, default activation or merge was
performed. Existing A/B conditions remain frozen for a separate follow-up.

The accepted same-workspace qualification used controller commit
`0ee3fa9cb7956446905d7a4122dec290a73e423f`, base `9dcc7b441f8883edf96bc2357ecd289948f660ff`
and remotely repaired candidate `b5e6049c9bf9d190e188481e67a085a2f6dc1988`.
The model read five native skill documents and added explicit table-case types;
the executable test, assertions and original 1-suite/3-test population stayed
unchanged. Compile, policy and integration gates passed both in the model's
validation round and in trusted post-agent validation. Local acceptance checked
the actual job/build, source ancestry/diff, command exits, logs and all 3,493
artifact files (5,109,061,745 bytes). This is a real product-gate repair loop,
not general production authoring, desktop/UI E2E, or proof for another profile.
It does not qualify either composed transports or hosted execution.

Selecting both a remote authoring provider and `remoteValidation` is reported
as a composed path, not as authoring with local validation and not as proof of
one shared job/workspace.

## Completed business E2E versus remote qualification

The OA business evidence-to-Draft-PR path has already completed within its
recorded scope. The [2026-10-13 proof manifest](../ado-window-discovery-20261012/run-manifest.json)
records `draft-pr-validated`, with authenticated source collection, coverage
handoff, authoring, a failed validation followed by a passing repair, and
OfficeAgent ADO Draft PR `5843757` at
`056b2116f1cf73f0a8d91edc8df9e8f1bc8f01b9`.
See its [authoring record](../ado-window-discovery-20261012/04-oa-authoring.json),
[validation attempts](../ado-window-discovery-20261012/05-validation.json) and
[PR receipt](../ado-window-discovery-20261012/06-draft-pr.json).

That bundle does not establish that the complete workflow ran in Agency:
`skillExecution` is null, and the gate record does not identify its execution
provider or machine. A Windows command path alone cannot establish execution
location. The PR receipt describes the historical result, not a fresh query of
the PR's current state. Reading or hash-checking committed summaries is not a
rerun of the private proof checker or the product gates.

Keep these three claims separate:

| Claim | Evidence and limit |
|---|---|
| Real OA evidence -> validated Draft PR | Completed in the historical business bundle above; not proof of a fully remote native workflow. |
| Real OA gates and bounded type repair in Agency | Passed in the 2026-10-22 and 2026-10-23 qualifications above; no new business-test authoring was established. |
| Real evidence -> new native authoring -> remote gates, fitness and independent review -> controller acceptance | Passed in the single bounded 2026-10-28 r7 run below, using saved approved evidence. Not general production dispatch, fresh collection or PR publication. |

When reporting a blocker, name the specific run and missing capability rather
than saying that no real business E2E or Draft PR has ever completed. Likewise,
record an Agency API job ID and its ADO build ID as separate identities; do not
relabel that task as an Aurora validation job without service-specific evidence.

The OA validation record proves real compile, policy and the named OneNote
integration suite (1 suite / 3 tests), not desktop/UI E2E, all OA tests, native
skill authoring, arbitrary authored-candidate publication, or same-workspace
repair. Initial observation required reconciliation and resume of the same job;
it does not prove uninterrupted fresh submission. The controller version is an
isolated feature commit, not a claim that it has landed on the default branch.
Its complete offline suite also was not green; see the record's limitations.

The [2026-10-26 fixed-candidate attempt](oa-validation-attempt-20261026.json)
used controller `397d034`, a fresh ledger and no aggregate job ceiling.
Submission returned no confirmed job ID and remains **uncertain**, not passed
or proven rejected. The unchanged request later passed service validation-only
(HTTP 200); a bounded authenticated job listing and exact-pipeline ADO query
found no match. Neither observation proves real gates ran or permits another
submission. The original reservation is preserved without a replacement; this
attempt is not added to the qualification registry. Phase diagnostics added
afterward cannot retrospectively resolve its outcome.

The later [submission-path diagnostic](oa-submission-path-diagnostic-20261026.json)
replayed the same request through the original transport's service-validation
phase: HTTP 200, reaching the creation boundary, with creation intercepted before
network dispatch. The current transport also GET-verified the historical
successful job and exact build `57844822`. The original `TypeError` did not recur
in the exercised validation phase; its original cause and failure phase remain
unknown. These observations neither establish new creation/gate execution nor
reconcile the uncertain submission. The historical passes remain historical
passes, not evidence of a suddenly failing product test or a fresh business E2E.

## Live native authoring attempt: 2026-10-27 r3

This is a failed, non-qualifying attempt, not a new registry pass. It used
controller `f753b755280889289cdf70c12f90512e1fe29ed2`, exact OA base
`46299221b14698dbe21ac87167b21083612279cc` and pipeline
`0bb7da3ae8b4dae227eaed0aa4165a63c01cad4b`. Agency job
`office-766b62ec-cd76-4451-a9a1-b371c476aaa9` corresponds to ADO build
`58189383`; the authored candidate is
`4f9da4885eda09d9dc29f519d4e5eb26ab09729a`.

| Step | Actual observation in this run |
|---|---|
| Approved saved evidence and native authoring | Managed-request evidence delivery and source-bound new-test authoring completed in the remote workspace `F:\1\s`. No fresh source collection was performed. |
| Real product gates | Compile and policy exited 0; the exact Excel custom-skill ingress integration suite passed 4/4 cases (2 original and 2 new). |
| Native fitness | The approved mutation compiled but failed the tests (`killed`); the equivalent refactor compiled and passed (`robust`). Both restored the original source SHA. These probes are not candidate repairs. |
| Independent review | The isolated reviewer failed before a completed report. Recovered Copilot process diagnostics record `No authentication information found.` at `2026-10-27T04:34:01.289Z`. The Agency launcher successfully resolved and downloaded the reviewer definition; ADO agent lookup was not the failure. The failed command record was not saved, so its exact process exit code is still unknown. |
| Final gates and acceptance | Not completed. Loop state was `uncertain`, `finished: false`; Agency and ADO finished failed. No full controller validation receipt, qualification promotion or product PR was produced. |

The private collection `native-excel-qualification-20261027-r3` retains the
original job artifact's `workspace-loop` directory, `loop-state.json`,
`manifest.json`, the compile/policy/test logs, both fitness stage records and
their compile/test logs, and the original managed-session events. The profile,
runner and all nine recorded stage-log hashes matched an independent download
check; that partial check is not full controller acceptance.

The local downloader separately crashed with `read ENOTCONN`. The original,
identity-bound downloader subsequently recovered this same build's artifacts;
no new job or validation was submitted for recovery. The remote integration
command used an explicit PowerShell argument array to preserve the native
runner's `--` separator, fixing the separately reproduced r2 launch defect.

The recovered private managed-session directory contains
`process-1793075636905-7836.log` (SHA-256
`d27ae2a69ff7fc969afbfacfc51c25c0833949e84500c44b9f3af594a0942b46`,
line 30) and `agency_copilot_20261027_043354_9940.log` (SHA-256
`619251c88a87f13bbb3cef5d68ac07af04d96978c4b6257ab5a31b3041f08bcf`).
The main pipeline configured askpass-HMAC model authentication. Both the
author and nested reviewer selected Copilot CLI 1.0.103. These observations
establish unavailable reviewer authentication, not the exact environment
variable lost at the handoff; version drift and failed agent lookup are not
supported causes. Authentication-provider diagnostics were not inspected.

The proposed opt-in repair configures the official token-free
`agency auth github` askpass helper for the existing same-build HMAC/OIDC
context; it must not copy a token, select a different identity, replace another
provider or bypass credential isolation. It remains unverified remotely.
The controller also grants the CLI permission name `review` (not the agent
frontmatter pattern `review/*`) and saves failed reviewer command metadata
without retaining provider output. Fresh-session, readonly-tool and independent
acceptance checks remain required. Loading the reviewer from a local file was
not retained as a proposed authentication fix.
Subprocess I/O handling likewise
makes transport errors explicit and contained, not evidence that the underlying
Windows pipe fault is eliminated. A new attempt requires its own frozen
controller/request/pipeline identity; never restart the uncertain r3 reviewer.
The separate A/B session should retain its original baseline.

## Live native startup failure: 2026-10-27 r4

Agency job `office-8f702001-eec2-4b64-ab42-918e65c896f3`, ADO build
`58233336`, used controller `6dbdd414e6735e99c29c87d964204e5453800a83`
and pipeline `1a5958e431514db31c9f43ce15a5cb1e7cb542b3`. It failed before
authoring or any product gates. The loop's credential-free startup record,
`review-authentication-config-3552.json` (SHA-256
`6f80cd31a0929b680c7f72cfcaf98c770428f06acb7157614f55853731c4103f`),
shows Agency context, OIDC request URI and the same-build system access-token
configuration present, but integration ID and inherited HMAC helper absent.
The startup guard correctly rejected this incomplete configuration.
`process-1793118166855-8088.log` (SHA-256
`9f00f18b81536504eb83c6042794f48477ac853018cdc478542846dd8476cb15`,
line 52) binds the failure to MCP initialization. No reviewer ran and no new
candidate exists. This is not a product test failure or a qualifying pass.

The standard downloader recovered this original build on 2026-10-28 without
creating another job. The earlier download error's underlying cause remains
unresolved; successful recovery does not prove that transport fault fixed.
Authentication-provider diagnostics were not inspected.

A local, zero-inference probe with Copilot CLI 1.0.103 reproduced loss of
integration/helper configuration in an ordinary local MCP child. Explicit
environment-variable references did not restore their values. Pinned Agency
source `68cd9681de64452fad5264d797d9820697b7a0d4` identifies a supported
alternative: the builtin `mcp local` proxy merges the launch environment into
its upstream configuration (`client/agency/src/mcp_config.rs`, lines 624-679
and 794-804). Its stdio implementation terminates the upstream on proxy drop
(`client/agency_mcps/src/proxy/server_transport/stream/stdio.rs`, lines 320-330).

`authoringLoopMcpConfiguration({ agencyManaged: true })` opts the experimental
author into this first-party proxy. The trusted, fixed Node entry uses a data
module so Windows command parsing does not require a shell or quoted inline
script. Tool permissions and source, candidate, budget and acceptance guards
are unchanged. This moves the trusted tool host, not arbitrary model commands,
into Agency's environment handoff. No token is copied, credential renamed,
provider changed or intentional WIF isolation disabled.

The exact generated proxy entry completed a local synthetic MCP handshake,
received synthetic integration/helper configuration, and terminated its child
on EOF. Focused proxy/authentication/acceptance tests passed. These checks are
not remote authentication or product validation: a new, independently bound
attempt must still complete fresh review, final gates and controller acceptance.
The separate A/B session must not switch its frozen baseline mid-run.

## Live managed-proxy attempt: 2026-10-28 r5

Agency job `office-d84a5e36-8513-4737-82f2-838741f0e0ca`, ADO build
`58286662`, used controller `142db85b5da3d98bf405fb023617e06d19f8a279`
and pipeline `cd57ad603ed4fd551d9d7d56fa6e8b4bb318cf8f`. This attempt
failed before evidence delivery, authoring or product validation. Environment
and dependency preparation succeeded; the Agency task returned without
completing the loop, and trusted finalization rejected it. The pipeline's
`Run Agency` success is not a qualifying validation result.

The Agency-owned upstream's `review-authentication-config-7208.json` shows
integration ID, inherited HMAC helper and same-build context present. Two
additional engine-owned upstreams (`3948` and `5940`) lacked those settings.
Do not conflate their diagnostics: the managed authentication handoff worked
at the configuration level, but actual nested model authentication remains
unverified. The initial `loop_evidence` calls failed with
`Managed request transport requires an explicit Copilot home and Agency session identity.`
No new candidate, product gate result or reviewer report was produced.

The exact launcher log records `AGENCY_SESSION_ID` in the forwarded variable
names but not `COPILOT_HOME`, and identifies the actual engine events path as
`%USERPROFILE%\.copilot\session-state\a850d223-b694-40e0-8c9b-a3a44ed6e3b5\events.jsonl`.
Pinned first-party source explains this difference: `client/agency/src/copilot.rs`,
lines 3023-3032, sets the resolved home directly on the engine command, while
lines 3517-3520 pass the separate environment map to MCP preparation.
`client/agency/src/session_manager/providers/copilot.rs`, lines 147-166,
resolves a nonempty trimmed `COPILOT_HOME`, otherwise the user's `.copilot`.
Its source SHA-256 is
`845673a781c81f326acd2205267f047efd58bf4cca3179ecff3af2b6710d9c0a`
at Agency revision `68cd9681de64452fad5264d797d9820697b7a0d4`.

The managed bootstrap now uses that same home resolution rule, without
searching for sessions or accepting a model-supplied path. Exact session,
initial-message, evidence-byte-hash and filesystem guards remain unchanged.
Tests exercise the real evidence tool through this bootstrap with no explicit
home, preserve an explicit home and reject another session; all 37 related
loop/acceptance tests passed. An actual local Agency proxy also completed the
synthetic home/session/evidence handshake and child cleanup with zero inference
requests. These are offline/local checks, not a remote E2E pass. The original
build's artifacts were recovered with the standard downloader, without a new submission; the
first download failure's underlying cause remains unresolved.

## Live native review rejection: 2026-10-28 r6

Agency job `office-2e28dda7-9770-4a4b-90c9-2fa3b617ea6e`, ADO build
`58288250`, used controller `064b8d7d89facbb4918390331b5cb05f5dd15557`
and pipeline `62afe820dab3f0d972ae2b7868139a0f4e7beb4b`. It finished
failed at `2026-10-28T03:58:29Z`. Exact initial evidence delivery, native
skill reading, new authoring and two real assertion-failure repair rounds
ran in the same Agency workspace, `F:\1\s`. The final candidate
`3e478137f69425723516705a6615c3f911b5b51e` passed compile, policy and the
exact integration suite, 4/4. The approved mutation was killed and the
behavior-preserving refactor survived; both restored the original source hash.

The fresh independent reviewer session
`4b80ea14-7203-455c-82c0-36c8d50507fc` actually ran with exit code 0
and completed a source-bound `changes-requested` report. The authentication
handoff is therefore proven beyond configuration presence. This is not a
review approval or a complete E2E pass. Reviewer findings concern the
plugin-only/mixed provenance matrix, the standalone `runTurn` caller and an
overstated behavior-card score. They remain reviewer findings, not independently
confirmed product defects. Final revalidation, sealing and controller acceptance
did not complete.

The original build artifacts were recovered using the standard downloader,
without resubmission or validation reexecution. Evidence SHA-256 values:

- `loop-state.json`:
  `07a703efe06ccb17dd1c5dbdc18b8a49dd6687a7a5621c33b9d50f3f09203f29`.
- `review-2.json`:
  `cf9ac9d23ed65ac378a2e1b31377c05f2061e685f9b689a37b63b1e3d33721bd`.
- `review-command-2.json`:
  `d57f187806d19671d226f9ac473f8602590f28419dd5991e0dbe6be907bf4393`.

The reviewer received the complete historical defect report but not the
controller-approved two-case caller coverage goal or write boundaries. That
handoff omission does not invalidate its findings or justify approval.
The experimental native workflow now optionally pins `coverageGoal` under the
existing native-workflow/source-approval hashes. Both author and reviewer receive
the same controller-derived scope, including preserved originals, exact test
population and the prohibition on production-source edits. Full source evidence
remains available. Independent review must still reject in-scope gaps,
unsupported residuals and inflated card scores; any approval applies only to
the bounded assignment, not resolution of the original report.

A completed review rejection is now a known, nonrepairable
`native-coverage-review-rejected` outcome, rather than an uncertain command.
It cannot unlock another authoring attempt or finish successfully. Missing or
interrupted reviewer results still fail closed as uncertain. A fresh qualification
must validate these changes; r6 is not registered as a qualifying pass and the
other A/B session retains its frozen baseline.

## Accepted native business qualification: 2026-10-28 r7

The [source-bound summary](oa-native-business-20261028.json) records Agency job
`office-95bd35d1-8a6b-49e7-8eb9-bd61f61eb3a9`, ADO build `58299935`,
candidate `58006dd2380ebc87bc05c3b472dc417445261ec0` and exact OA base
`46299221b14698dbe21ac87167b21083612279cc`. Remote producer controller
`fb3c5d7b96cc938bd74ac9c04a6abc4cf02e49e6` and pipeline
`4cfef64dbd4df604ebc3b3b4137fa935002e7ece` stayed frozen.

| Step | Actual result and location |
|---|---|
| Approved source and scope | Original saved real evidence, source approval and two-case caller goal were independently bound; no new source collection. The full historical report remained available to both author and reviewer. |
| Native authoring | Qualified OA native skill read the pinned source and authored two new integration cases plus a behavior-card update in Agency `F:\1\s`. Both original slot-redirect cases were preserved. |
| Real gates | Scoped OA compile, integration layout/card policy and the exact Excel caller suite passed in Agency: 1 suite, 4/4 tests. This was the first candidate; no repair occurred in r7. |
| Fitness | The approved mutation was killed and equivalent refactor survived. Source restoration was hash-checked; these probes are not candidate repairs. |
| Independent review | Fresh reviewer session `1095c8e0-10fa-4fe2-aa43-9da8d34d0ad5`, exit 0, completed and approved with no findings, retaining source-located residuals. |
| Trusted final gates | The same candidate passed compile, policy and 4/4 integration tests again in Agency, outside the author's self-report. Build finished succeeded at `2026-10-28T07:13:48.3791102Z`. |
| Local controller acceptance | Standard `--resume` independently checked the original job/build, pipeline, evidence, candidate bundle/ancestry/diff, native reads, fitness, review, commands, logs and 3,517 files / 5,099,752,366 bytes. Receipt and ledger status `passed` persisted at `2026-10-28T07:46:37.981Z`. No local product gates ran. |
| Publication | None. Qualification-only, `productionAssignment: false`; no product PR was created. |

Two local postprocessing failures were independently reproduced and repaired,
without restarting the remote job. The artifact operation's 260-character cwd
made Windows reject the downloader launch (`spawn pwsh.exe ENOENT`). Commit
`de0e2d3cede76c5dfe425c742259d85da839bd2e` launches that downloader from its
short trusted script directory, preserving absolute request/destination paths.
Git's bundle reader then could not open the 305-character original bundle path;
`core.longpaths=true` did not fix that reader. Acceptance controller
`3eea8b61ffffadb944a889e0053e52942eef12ce` stages only the original bundle
bytes in a unique short temporary directory, verifies their SHA-256 against the
original complete inventory, performs the unchanged ref/bundle/fetch checks,
rechecks the original hash and removes the temporary copy. No receipt is copied,
no original artifact is rewritten, and no global environment or Git setting is
changed. Standard recovery produced `controller-acceptance-1793173597983.json`
(SHA-256 `8b20507e1c0322a4d31557d069c7c467e436b1c7ab28246fe7d0ac0db0034173`).
The remote `loop-result.json` correctly remains unchanged with
`controllerAcceptance: false` / `pending-external`; local acceptance is a
separate authority.

Approval concerns only the nonempty and empty public-package OA caller cases.
Plugin-only provenance (`materialize.ts:201`), mixed staged-user/plugin inputs
and standalone `runTurn` (`agent-runtime.ts:6964`) remain residuals; this is not
resolution of the full historical defect or desktop/UI E2E. r6's two real
assertion repairs remain separate rejected-run evidence, not part of this pass.
No qualification transfers to 1JS, Office src, composed transports, hosted
execution or another profile.

**A/B handoff:** keep the existing experiment's frozen baseline. This isolated
controller branch was not pushed or substituted into that experiment. After
that round, freeze a separate comparison of remote authoring/local validation
versus same-workspace remote authoring/validation/review, explicitly pinning
remote producer `fb3c5d7b` and local acceptance `3eea8b61`. No aggregate PEA
job/monetary ceiling was configured; per-job timeouts and repair bounds remained.
No tokens or monetary cost were measured. Package hygiene still fails on the
pre-existing personal-home path in commit `064b8d7`; current text is sanitized
and history was not rewritten. This qualification does not make the older
complete offline suite or historical failed attempts green.

## Storage and trust

`registry.json` is the machine-readable index. Each qualification names an exact
repository identity and execution mode and references an immutable sanitized
summary with its SHA-256. `doctor` reports this historical evidence separately
from current configuration readiness. It warns for every configured remote path
because reading the register does not revalidate its private evidence or the
current environment. Default SDK/local configurations receive no remote warning.

These files are **audit metadata**, not remotely executable configuration,
credentials, a local/remote validation receipt, a write grant, or input accepted
by the controller verifier. Do not use them to skip gates, reuse caches/receipts,
enable dispatch or promote a draft. No new automatic dispatch block or fallback
is introduced by this register; existing activation, qualification, any
explicitly configured job caps and acceptance checks remain authoritative.

`preflights` is a separate non-qualifying index, never part of `qualifications`.
`doctor` exposes its hash-checked summary as `attempt`, independently of any
later passing qualification. The original blocked preflight remains a historical
blocked attempt; r7 separately supplies the `live-business-e2e` historical scoped
proof. `configured: false` and `configurationVerified: false` remain unchanged.
A locally blocked preflight is not an Agency failure, and an accepted type-only
repair cannot promote the business mode. The register does not implement or
enable a business-loop execution entry.

Retain raw requests, logs, complete artifact inventories, product diffs/bundles,
ADO observations and fresh controller acceptance in approved private storage.
The summary records the private collection's non-personal name, artifact
basenames, hashes and job/build identity so an authorized operator can locate
and independently recheck them. If those artifacts are no longer accessible,
disclose the evidence-access gap and requalify; the committed hash is not proof
that an unavailable artifact still exists.

## Adding or updating a qualification

1. Fix repository identity, skill/workflow revision, candidate/base, allowed
   writes, validation profile and real commands, execution topology, per-task
   timeouts and stop conditions before the authorized run. Record an aggregate
   job or monetary ceiling only if the operator explicitly requests one; a
   finite project-wide budget is not a prerequisite. Do not modify another
   session's A/B experiment or use a fixture as product proof.
2. Preserve the actual job/request/build IDs, runner/workspace identity, exact
   candidate/configuration, commands and exit codes, complete logs/artifacts and
   independent controller acceptance. Verify source ancestry and allowed diffs.
   A repair claim requires an observed real failure followed by repair and
   passing gates in that same job/workspace; first-pass success proves no repair.
3. Add a new immutable sanitized summary, never raw logs, tokens, user paths,
   personal identity, private configuration or product source. Record the proved
   scope and unproved parts, failures/recovery, evidence locators/hashes and
   controller version. A blocked/failed attempt is useful evidence, not a pass.
4. Add or update the relevant mode in `registry.json` with the summary SHA-256.
   Passing qualifications go under `qualifications`; blocked local preflights
   may be indexed separately under `preflights` and cannot establish a pass.
   Do not widen an existing proof or overwrite an older run to claim success.
   A repository move, skill/toolchain/profile/gate/candidate or execution-policy
   change requires impact review and, where outside the proved scope, a new run.
5. Run the qualification tests, `doctor` with the selected private configuration,
   and package hygiene checks. Review the original private evidence before
   recommending enablement; `doctor` is disclosure, not that review.

Run from the selected controller checkout:

```powershell
node src\cli.js doctor --config pilot.local.json
node --test test\agency-remote-qualification.test.js
npm run check:package
```

Reading native instructions is not full workflow completion. If the configured
native workflow requires mutation/refactor fitness, independent coverage review
or behavior-card updates, retain those requirements explicitly. The experimental
native contract below implements them separately; passing only compile, policy
and integration gates does not establish completion of that workflow.

`doctor.remoteAgencyQualification` keeps `configurationVerified: false` even
when `status` is `historical-scoped-proof`. Unknown repositories and execution
modes default to `not-verified`, never "unsupported" or "passed".

## Real-evidence business E2E preflight

The separate [2026-10-26 pagination follow-up](oa-validation-reconciliation-20261026.json)
uses query parameters verified against the first-party OpenAPI contract:
`pageSize` and `continuationToken`, not the earlier unsupported `requesterId`
and `$top`. All three caller-visible pages were read (32 records, all with
metadata); none matched the uncertain reservation. Exhausting that visible list
does not prove that creation did not commit. The reservation remains fenced;
no job was resubmitted, no product gate ran, and no qualification was added.
This is a new non-qualifying observation, not a rewrite of the earlier attempt.

The separate [recovery-readiness observation](oa-recovery-readiness-20261026.json)
records the subsequent first-party source inspection, three-page company
catalog lookup, and HTTP 403 from one read-only customer-telemetry schema query.
Source inspection confirms that generic creation and caller-scoped listing
share a job store, but does not establish the deployed revision or reconcile
this submission. The catalog did not establish the required analyzer source.
No plugin was installed, permission changed, support page triggered or job
resubmitted. Recovery and the new business E2E remain blocked, not qualified.

### Recovering an externally identified validation job

`reconcile-remote-validation --file recovery.local.json --config pilot.local.json`
is a separate operator recovery entry, not validation execution. Its input uses
`schema: controller-remote-validation-reconciliation-v1`, the original `repoId`,
`revision`, exact `operationId` and `requestSha256`, and the service-identified
`jobId`. It supports only an existing unresolved fixed-candidate
`agency-remote-validation` reservation; workspace-loop and authoring operations
are not accepted by this entry.

The controller independently GETs the named job with the configured identity
and verifies all reserved metadata, candidate/contract/request pins, creation
time and any reported pipeline definition. Operator input and a support reply
alone cannot establish identity. The entry does not require dispatch activation,
create or cancel jobs, read builds, download artifacts, reset deadlines, write a
creation response, or mark gates passed. Failed lookup or mismatched evidence
leaves the reservation unresolved. Successful identity binding persists a
separate immutable `reconciled.json` with a ledger hash, then returns
`identity-verified` and `nextAction: resume-original-validation`.

Use the original `validate-revision` request with `--resume` afterwards.
That path retains its dispatch permissions, original deadlines/cancellation
policy and independent product-gate/artifact verification. Interrupted
reconciliation persistence can retry only the read-only identity entry; it does
not authorize a submission retry or infer non-creation. This implementation has
offline regression coverage, not a new live qualification. No service-confirmed
identity has yet been obtained for the uncertain 2026-10-26 attempt.

### Preserved business-input preflight

The 2026-10-24 isolated ADO refresh used six authenticated reads for the
unchanged, approved 2026-10-12 to 2026-10-13 UTC window: 14 unique records,
14 title decisions, four clear exclusions, and ten complete retained bodies
with independently rechecked capture hashes. It enumerated current source
state for that historical window, not today's cohort. No sources were recollected
when unrelated, unstarted passes left the overall collection summary partial.

For the held Stage2 route, `stage2-handoff` was rechecked on 2026-10-26 and returned
`blocked-skill` / exit 1 with no handoff artifact. The genuine installed
`analyze-excel-agent-test-coverage` skill and bundled
`references\coverage-map.md` are missing. Use an approved installation and bind
`stage2.skillDirectory` through a new private configuration; do not edit the
existing collection configuration, copy a synthetic skill, or waive this check.

This is a blocker of the held Stage2 route, not a prerequisite for every native
assignment or an Agency capability limitation. For the pending business run, no coverage
gap or exact target/profile has been qualified, and no real-source assignment
or new candidate exists. The separate experimental contract below allows
freshly authored SHAs and first-pass success without weakening
`qualify-remote-loop`'s original type-only and real-failure requirements.
Execution permissions, source sharing and model/context capacity still need
to match the request before submission. The earlier preflight also treated
bounded monetary authorization as unresolved; on 2026-10-26 the PEA owner
explicitly clarified that there is no aggregate Agency Remote budget limit.
That old allowance is not a reason to request new financial approval or block
new work. Historical preflight observations are retained unchanged. The
sanitized observation pins the private preflight output, status and
source-review hashes; it is not a product validation receipt.

No new remote job, product publication, schedule activation or A/B change
occurred. The accepted bounded qualification below remains valid only within
its original scope.

### Later offline implementation and source handoff

The [separate readiness record](oa-native-offline-readiness-20261026.json) pins
implementation commits `4c7d45b` and `e9cf2d6`, 50 passing offline runtime/acceptance
tests and a passing package check. Its Windows compile-profile test uses a
synthetic compiler: it is not a new real product compile. It also records an
actual `agent collector replay-evidence` import of one saved authenticated source
into a separate held audit ledger. The controller verified unchanged record and
capture bytes and a durable import receipt, with no fresh source calls, reviews,
assignments or remote jobs.

These later observations do not overwrite the original preflight, appear in
`qualifications`, or change enablement. The held Stage2 route still needs its
approved analyzer and reference. The ordinary native-assignment alternative
still needs a genuine complete source-bound coverage plan and qualified skill;
importing evidence does not satisfy those prerequisites.

### Experimental new-test qualification entry

```powershell
node src\cli.js qualify-remote-authoring --file authoring.local.json --config pilot.local.json --execute
# Reconcile and observe that same reserved job, never submit a replacement:
node src\cli.js qualify-remote-authoring --file authoring.local.json --config pilot.local.json --resume
```

This is a **publication-free qualification**, not automatic enablement of the
normal worker or a replacement for its PR/result lifecycle. The existing
`qualify-remote-loop` remains type-only. The new entry requires all of:

- A `controller-workspace-authoring-request-v1` with absolute isolated workspace,
  exact base, repository and prepared test-coverage assignment IDs, hash-pinned
  `contractPath`, and private `evidencePath` / `sourceApprovalPath`.
- An `agency-oa-workspace-authoring-contract-v1` pinned to the real profile,
  pipeline/YAML, restricted agent/plugin, runner, commands and original gates.
  `loop.typeOnly` is false, `appendOnly` true, publication and production dispatch
  false, maximum repairs two and maximum new jobs one. Its tool set includes
  `loop_evidence`; the prompt pins `authoringLoopCompletionInstructions`.
- `loop.authoring` binds the native project (`agents/office-agent` or
  `agents/excel-agent`), its exact package name, positive `baselineTests`, evidence
  SHA-256 and source-approval SHA-256. The exact test population must exceed the
  baseline, remain one suite, and name the selected project's integration file.
- Complete `controller-authoring-evidence-v1` records, each with an exact
  source `reference` and canonical `bodyBase64` of the original captured bytes.
  The controller compares every byte with authenticated ADO captures in the
  assignment ledger. The runner decodes full bodies as untrusted source data for
  the model; the pinned digest still binds the original envelope. Oversized
  inputs block rather than truncate.
- An explicit private authorization, pinned separately from the source records.
  For the held Stage2 route, use `controller-authoring-source-approval-v1`,
  pinned separately from the held proposal. It records `assignmentId`, `repoId`, `baseRevision`,
  `allowedPath`, `targetRepository`, `coverageCandidateId`, `evidenceSha256`,
  exact `{path, sha256}` references in `coverageProposal` / `coverageHandoff`,
  `authority`, `receivedAt`, `executionAuthorized: true`,
  `productPublication: false`, `maximumNewJobs: 1`, and `maximumRepairs: 2`.
  This is trusted controller-side authorization, not a document the remote
  model may issue. Do not put it in the product workspace or treat hashes as
  proof of semantic analysis.

For the held Stage2 route, the helper rechecks the installed analysis
skill/reference, original source snapshot and approved direction. A missing
analyzer blocks that route, not every ordinary repository-native workflow.

A separately reviewed native test-coverage assignment may instead use
`controller-authoring-assignment-approval-v1`. It retains the same exact
assignment/repository/base/test/evidence and explicit bounded execution fields,
but replaces the held-proposal fields with `review`:
`assignmentSha256` and `investigation`, `improvement`, `coveragePlan` references,
each `{id, version, sha256}`. Record hashes use the controller's JSON serialization
without whitespace or a trailing newline (`json(record)`, namely `JSON.stringify(record)`). These pins must match
the current durable ledger records; the ordinary assignment eligibility,
exclusions, ownership, complete gap, existing-fix reconciliation and native
qualification guards still run. Held Stage2 fields are rejected in this
separate approval schema. Do not cast a failed or held proposal into an approved
native review: perform and persist that review and plan through the ordinary
workflow first.

Both routes recheck the exact base, complete source captures, current
investigation/plan/assignment and qualified native skill before submission and
before acceptance. A held proposal alone cannot authorize execution. Model/context
capacity and source-sharing permissions must still cover the pinned request
before an operator creates execution authorization. The owner's no-aggregate-limit
instruction applies to this PEA work; exhausting an old probe allowance does not
require a fresh financial grant. This entry supplies no new account or
source-sharing permission.

In the remote workspace, read evidence and native skill documents, record a plan,
then append new cases while retaining **every byte** of the original test.
First-pass success is allowed. Only an actual scoped test-type or test-assertion
failure unlocks a repair; policy/environment failures do not. The initial
candidate plus at most two repairs share the same workspace/job and commit chain.
Trusted post-agent gates run again at the final candidate. Independent local
acceptance checks the actual terminal job/build, producer seals, full artifact
inventory, ancestry, allowed diff, evidence/approval binding, commands/exits and
the exact enlarged passed population. No local receipt is imported.

The source assignment stays held/prepared: the qualification records its own
durable operation and acceptance, not an ordinary published worker result.
After a reservation, ordinary dispatch refuses to launch that same assignment;
resume the qualification or reconcile it explicitly. Fixed validation, type
repair and new-test qualification have no default cumulative job ceiling.
`limits.maxRemoteValidationJobs` is an optional positive safe-integer cap;
omitting it or setting it to `null` leaves aggregate job count unlimited.
Existing explicit limits remain opt-in, and historical experiment records are
not rewritten. A contract's `maximumNewJobs: 1` means one job per attempt, not
one job for the project or ledger. Execution permission, finite deadlines,
uncertain-submit, cancellation and no-duplicate rules remain in force. Exhausting
an old probe allowance is not a new project-wide financial-approval gate.

For the full experimental native workflow, `loop.authoring.nativeWorkflow`
additionally pins the exact behavior card, one mutation and one
behavior-preserving refactor, plus the fresh read-only reviewer agent and model.
Execution authorization must bind its `nativeWorkflowSha256`, and both
repository and assignment write policies must permit the exact card update.
Only its coverage score and evidence basis may change.

Fitness compilation admits only the exact approved production source during
the matching fitness stage; ordinary gates retain their dirty-source rejection.
Compilation must pass before a scoped assertion failure counts as killing the
mutant. The refactor must pass the entire target population, and each probe must
restore the original source bytes. The independent reviewer uses a fresh context
and read-only tools. These results, the enlarged test population and trusted
post-agent gates are independently checked by the local controller.

At most two scoped compile/assertion repairs are supported. Fitness or reviewer
failure stops for reconciliation; an automatic quality-failure repair loop is
not established. The full native workflow has offline test evidence only:
reviewer runner/auth compatibility and real product fitness remain unverified.

The new runtime/controller tests use synthetic sources and pipeline observations,
including Windows fixture commands. They validate protocol behavior only.
**No new live OA job or business E2E proof is implied.** Do not promote
`live-business-e2e` in the register until the real source-to-acceptance run exists.
Keep the other session's A/B baseline frozen.

Failed attempts are retained as separate non-qualifying summaries:
[attempt 1](oa-workspace-loop-attempt-20261023.json),
[attempt 2](oa-workspace-loop-attempt-20261023-02.json),
[attempt 3](oa-workspace-loop-attempt-20261023-03.json) and
[attempt 4](oa-workspace-loop-attempt-20261023-04.json),
not inserted into the passed-only registry. The 2026-10-23 attempt used its
single reserved job before model startup: Windows could not materialize a
123,143-character inline task input. The actual build is failed; the Agency
service's observed `ComputeInvoked/Pending` status remained unreconciled even
after one cancellation request. That acknowledgement is not terminal-cancellation
proof. Do not repeat the job or call the loop verified based on offline fixtures.

An independently authorized second attempt proved the pinned file loader and
four real preparation stages on the remote runner. The model read the native
skill and started unchanged-base validation, but the MCP request timed out after
180 seconds without a complete product-gate exit record. No repair occurred;
the build and Agency job failed and the controller rejected the result. This
is a protocol failure, not evidence of a failing product assertion or a passing
repair loop. Preserve both failed attempts; do not restart uncertain commands.

The third attempt was rejected before a qualified build because its private
generator interpreted PowerShell text as JavaScript replacement metacharacters
and injected YAML tail lines. The generator now uses literal callbacks, checks
line-count preservation and round-trips each inline script. This is not remote
proof of the ticket protocol. A separate `yamlOverride` preview-only request was
denied for missing `EditBuild`; no permission or shared definition was changed.
Request/Spec validation alone did not catch this YAML error. Distinguish
configuration/permission checks, offline fixtures and real passing gates.

The fourth attempt previewed the exact committed ref without `yamlOverride`;
ADO returned HTTP 200 without granting `EditBuild`. It ran the original failing
compile, native-skill-guided type repair, passing compile/policy/integration
gates, and passing trusted post-agent gates. However, the outer result judged
`controllerAcceptance: false` as failure even though the agent's task completed
successfully. The local verifier correctly rejected `Completed/Failure`; these
artifacts must not be relabeled or inserted into the passed-only register.

The fifth, independently authorized run separated successful remote work from
pending external acceptance. Agency returned `Completed/Success`; trusted final
gates and the actual build succeeded, then the local controller independently
accepted the sealed candidate. The initial provisional build identity required
reconciliation and `--resume` of the same reserved job, not another submission.
Queue-to-acceptance time was about 27.5 minutes; this is a single capability
probe, not a comparative A/B result or a monetary-cost measurement.

## Bounded OA same-workspace qualification

`qualify-remote-loop --file loop.local.json --config pilot.local.json --execute`
is a separate qualification entry, not production dispatch. Use `--resume` only
to reconcile the same reserved job. Its private hash-pinned contract permits one
job, an unchanged failing base, one test-file type repair plus at most two further
repairs, and the original compile/policy/integration gates. It cannot create a
finding, production assignment or product PR, publish product changes, or
silently fall back to local gates.

A pinned remote agent exposes only bounded MCP source/skill inspection, planning,
type-only editing and real validation tools. Type erasure must preserve the whole
executable test; suppressing diagnostics, changing assertions or skipping cases
is rejected. A Spec agent must belong to a valid plugin; pin and independently
fetch both its agent Markdown and containing `plugin.json` at the exact commit.
Do not assume a standalone agent file qualifies as a plugin.
The Spec reference names the agent without `.md`/`.agent.md`; the pinned
source path and preflight fetch still include the actual file extension.
Keep inline Windows PowerShell inputs small. The loop preflight caps generated
`pwsh:` shorthand lines at 32,766 characters; do not embed a large base64 runner
in a task input. Generated double-quoted JSON-style inline inputs must also
parse as complete single-line strings; this is not a general YAML/template
validator. Materialize a script file from an exact approved repository
commit, verify its bytes/hash before execution, and keep credentials out of it.
This tool allowlist is not an operating-system sandbox. Trusted
preparation removes temporary feed credentials before the model starts and
binds the same build's native NuGet cache explicitly to validator children.

Preparation runs on the base revision. Only the unchanged dependency/configuration
inputs are reused in that same job/workspace; no local receipt is imported.
Every repair is committed and validated against its actual SHA. A trusted
post-agent step reruns the final gates and exports the Git bundle, original
1-suite/3-test population, commands/exits and complete hashed artifact inventory.
The local controller independently checks producer/build/source bindings,
candidate ancestry and allowed diffs before accepting it. Interrupted or
uncertain commands are not automatically repeated.

Long gates use a short start request and a persisted `validationId` bound to the
build, candidate SHA and round. Poll that same ID for status; each poll waits at
most ten seconds and never starts another command. `running` is neither failure
nor permission to edit. Only completed, actual gate results can unlock a repair
or finish. Completed tickets can be read after a server restart; interrupted
running/uncertain state still requires independent reconciliation, not a retry.
This protocol does not increase gate/runner deadlines or weaken acceptance.

Remote completion and local acceptance are separate, ordered phases. After
actual gates pass, `loop_finish` returns `remoteWorkComplete: true` with
`controllerAcceptance: false` / `controllerAcceptanceStatus: pending-external`.
That is successful remote work, not a failed attempt to obtain local acceptance.
The remote task must return so trusted post-agent gates and artifact sealing can
run. Only then can the local controller independently accept or reject the
terminal job and its source-bound artifacts. Loop requests must end with the
canonical `loopCompletionInstructions` and pin its SHA-256 in
`request.metadata.completionPolicySha256`. Do not require local acceptance as a
remote terminal success condition, fabricate it, or accept an Agency failure
merely because its build or a model report is green.

The [accepted bounded run](oa-workspace-loop-20261023.json) is now indexed under
`same-workspace-loop`; offline fixtures alone remain insufficient evidence.
This bounded type-repair qualification does not establish general
test authoring, the complete production native-assignment workflow, UI/desktop
validation, another repository, or a different validation profile.
It does not automatically enable this qualification entry for production
dispatch: `doctor` still reports `configured: false` and
`configurationVerified: false` for this mode. Keep the separate A/B session on
its frozen baseline; any comparison of remote authoring/local validation with
a same-workspace remote loop belongs to a subsequent, independently fixed run.
