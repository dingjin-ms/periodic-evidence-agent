# 1JS Agency same-workspace live E2E performance

## Scope

This report measures the successful 2026-11-02 1JS same-workspace live E2E
recorded in [the sanitized proof](1js-same-workspace-live-e2e-20261102.json):
orchestrator run `58677587`, runner run `58679076`, Agency job
`office-3f9070d3-4164-4890-837b-a81d1068f712`, source base
`22000241f771c99955eef8519e2dc27e1489c9ee` and candidate
`5ca4963b32cbc1939099d5aa543cbf9e7d8f4db1`.

The performance objective is remote Agency live E2E latency. PEA local CI,
including the `remaining` group, is a merge gate and is not included in that
latency. Later controller repair and re-acceptance are also excluded from the
remote product execution measurement.

Measurements below come from the retained private runner event stream, Agency
telemetry, native JUnit result and controller receipt. Only aggregate timing and
size data are recorded here; private logs, prompts, authentication state and
browser data remain outside the repository.

## Process categories

1. Controller submission and polling.
2. Orchestrator queueing and fan-out to the selected runner.
3. Runner provisioning: checkout, toolchain, dependencies and browser.
4. TRIPS FIC authentication.
5. Agency authoring: native skill inspection, scenario changes and candidate.
6. Native product validation: real BizChat-to-Excel execution and workbook
   assertion.
7. Additional ADO manual browser test case.
8. Artifact, trace and branch publication.
9. Controller independent acceptance.
10. PEA merge CI, measured separately from live E2E.

## Measurements

| Measurement | Observed duration | Interpretation |
|---|---:|---|
| TRIPS FIC mint through recorded use | about 59 s | Required authentication overhead; not the main bottleneck. |
| Agency CLI invocation through job completion | 39 min 28 s | Best top-level remote execution measure. |
| Copilot session start through task completion | 38 min 24 s | The model-driven portion of the remote job. |
| Tool-call wall-clock union | 21 min 15 s | Overlapping calls counted once; 55% of the Copilot session. |
| Time outside tool calls | 17 min 8 s | Model inference, turn construction and orchestration gaps; 45% of the session. |
| Model API duration | 14 min 32 s | Overlaps tool/session measurements and must not be added to them. |
| Native JUnit test case | 67.218 s | The actual real-product assertion is not the dominant cost. |
| Native JUnit suite | 69.321 s | Confirms product test runtime is about one minute. |
| Final report-to-job completion tail | about 63 s | Progress reporting, artifact finalization and runner shutdown. |

The session made 111 model turns and 118 tool calls. Tool time was dominated by
52 shell calls (893.8 cumulative seconds before overlap removal), including two
300-second waits and a 131-second follow-up wait. Browser automation used 19
unsafe run-code calls (134.6 cumulative seconds), in addition to navigation,
storage-state, screenshots and waits.

Agency used `claude-opus-4.8`, high reasoning and long context. Telemetry
recorded 15 premium requests, 14,005,977 cache-read tokens, 299,719 cache-write
tokens, 58,593 output tokens and only 222 uncached input tokens at shutdown.
The very large reused context and 14.5 minutes of API time make model/context
cost a first-order latency source even though most input was cached.

The retained Playwright trace was 40.83 MiB. Other individual runner artifacts
were below 1.5 MiB. Artifact finalization was not the largest single delay, but
continuous trace/log handling adds avoidable I/O throughout the session.

## Approximate timeline

These phase boundaries are reconstructed from event milestones. They are useful
for optimization, but they are not mutually instrumented pipeline stages.

| UTC window | Approximate duration | Work |
|---|---:|---|
| 09:26:41-09:27:40 | 0 min 59 s | TRIPS FIC mint, use and receipt. |
| 09:27:41-09:31:33 | 3 min 52 s | Agency startup, skill/repository inspection and authoring. |
| 09:31:37-09:50:51 | 19 min 14 s | Native helper attempts, dependency-chain build, browser install and readiness retries. |
| 09:51:37-10:01:17 | 9 min 40 s | Auth state, real product/browser work, native helper rerun and successful product result. |
| 10:01:25-10:04:36 | 3 min 11 s | Additional traced ADO manual browser flow. |
| 10:04:43-10:06:20 | 1 min 37 s | Evidence checks, branch publication and final report. |
| 10:06:20-10:07:09 | 0 min 49 s | Agency/runner finalization to completed job. |

The 19-minute preparation segment is a proven lower-level hotspot, but the
available telemetry does not cleanly separate cold dependency installation,
compilation and helper polling. A subsequent run must emit explicit stage
start/end events before assigning precise savings to each substep.

## Bottlenecks

1. **Model-driven session and context.** The 38.4-minute session, 14.5-minute
   API duration, 111 turns and large long-context cache traffic dominate the
   overall route. The model was asked to discover and operate more than the
   minimum native contract.
2. **Cold preparation and retry-shaped waits.** Build, browser installation and
   helper readiness consumed an approximately 19-minute window. Two 300-second
   shell calls and a 131-second read show coarse polling or long foreground
   commands hiding actionable stage progress.
3. **Duplicate browser validation.** After the native product flow, the agent
   executed a separate traced ADO Sanity Test WXP manual flow. This adds model
   turns and browser operations but is not required to prove the same native
   assertion when the approved contract accepts the native helper result.
4. **Success-path evidence volume.** A 40.83 MiB trace and periodic full log/chat
   publication increase I/O. This is secondary to model and preparation time.
5. **Fixed authentication and shutdown tails.** FIC and finalization together
   cost about two minutes. They are measurable but low-priority.

The 67-second real-product test is not the bottleneck. Weakening its assertion,
using a fixture, or replacing it with a synthetic page would reduce proof
quality without addressing the dominant costs.

## Improvements

### Priority 0: add stage telemetry

- Emit structured timestamps for checkout, dependency restore, compile, browser
  readiness, FIC, authoring, native validation, optional manual validation,
  artifact upload and shutdown.
- Record cache hit/miss receipts and installation/build durations without
  credential-bearing paths or values.
- Set a latency budget per stage and fail with a classified timeout instead of
  using opaque five-minute waits.

### Priority 1: remove redundant work

- Make the native same-workspace helper the single validation entry point. The
  model should author the two approved files, invoke one bounded command and
  interpret its structured result.
- Do not run the additional ADO Sanity Test WXP manual browser case when it
  asserts no independently required contract. Keep it as an explicit opt-in
  diagnostic profile if another acceptance owner requires it.
- Pass the exact native skill, scenario profile, expected files and command in
  the assignment instead of asking the model to rediscover the route.

### Priority 2: make preparation warm and deterministic

- Pre-provision the runner image with the pinned product toolchain and
  Playwright browser.
- Restore content-bound dependency and build caches keyed by source/toolchain
  inputs. Preserve receipts and all required gates; never treat an unverified
  cache as a pass.
- Replace long blocking helper calls with bounded process execution and
  event-based readiness so failures surface immediately.

### Priority 3: reduce model latency safely

- Use a focused prompt and bounded context containing only the native skill,
  selected profile, changed-file allowlist and structured command contract.
- After the focused route is stable, qualify a smaller context tier and lower
  reasoning setting against the same real assertion. Do not change model,
  reasoning and workflow simultaneously, and do not claim a saving without a
  comparable live run.
- Collapse routine command/result exchanges into one deterministic helper call;
  reserve model turns for authoring, classified repair and final interpretation.

### Priority 4: tune evidence transport

- On success, retain the receipt, JUnit, required screenshots, network/console
  summary and hashes. Retain the full trace on failure or when explicitly
  required by the audit contract.
- Upload logs incrementally or less frequently instead of repeatedly publishing
  complete growing files.
- Preserve controller-side independent acceptance. Event-driven completion can
  reduce polling latency but will not shorten the remote product work itself.

## Target

A defensible next target is **15-25 minutes for Agency CLI invocation through
job completion**, while retaining the same authenticated real-product assertion
and evidence contract. This is a hypothesis, not a measured result:

- remove the approximately 3-minute duplicate manual browser flow;
- save several minutes through a warm browser/dependency/build path;
- reduce the 14.5-minute model API component with a focused context and fewer
  turns; and
- keep the approximately one-minute native product assertion unchanged.

The earlier 30-50 minute estimate for final local validation does not answer
this performance goal. Local `remaining` is required for repository merge
confidence, but it belongs to CI throughput optimization, not Agency live E2E
latency.

## Next benchmark

Run one comparable live E2E only after the stage telemetry and deterministic
entry point are present. Bind it to the same profile and acceptance strength,
then compare wall-clock stage durations, model/API usage, tool-call count,
cache receipts and artifact bytes. A first-pass success may demonstrate latency
improvement; it still does not exercise the product repair path.
