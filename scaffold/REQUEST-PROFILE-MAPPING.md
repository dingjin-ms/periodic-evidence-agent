## Required validation profile mapping

Keep the approved repository `validationGates` list and order. The phased command
uses `validate-GATE_ID` for each entry, then publication verifies every required
result at the clean current revision. Do not flatten a profile into a build-only
command or drop the last test/live gate.

| Existing contract | Phased mapping | Preserved evidence |
| --- | --- | --- |
| Explicit build/contracts/format/lint commands | One normal per-gate invocation | Original executable/args, source revision, result artifact and cleanup |
| Hash-bound native profile without staged marker | Same profile bytes through normal command runner | Profile SHA, original arguments, native result/source checks |
| Valid `PILOT_VALIDATION_PLAN` v2/v3 | Existing staged runner inside that gate's owned phase | Fingerprint, optional authentication, dependencies, compile, policy, test; prepared receipts/output hashes and cleanup |
| `1js-declarative-e2e-v1` | Existing built-in registration and validation route | Case/source/profile binding, native typecheck/unit/repair, selected five-pass batch, assertions, same-source receipt and browser cleanup |

The built-in declarative profile targets
`ooui/apps/excel-agent-declarative-e2e`, not the cross-app package. It cannot be
substituted for a cross-app original-workbook scenario simply because both use
YAML. Its unchanged native timeout can exceed the available foreground lifetime;
such a configuration is rejected before review. Preserve its five repetitions
and cleanup rather than shortening them to obtain a passing admission.

The previously used cross-app engineering contract had four explicit offline
commands: build, deterministic contracts, formatting and lint. That contract can
be represented directly, but it does **not** prove a live product result. A live
cross-app requirement needs its own approved existing native profile/command with
actual observer evidence. Source/skill/preflight declarations do not manufacture
that evidence. The phase implementation now routes such profile gates instead of
blanket-rejecting them, provided their full bounds fit the owner.

The CLI reservation pins every profile, including later gates, before FILTER.
Continuation revalidates those files; a stale profile cannot reuse a prior
success or silently change the required stage population. An active/interrupted
phase must be reconciled without retry. Failed policy/test or cleanup blocks
publication. Existing cache receipts are reusable only through the native
runner's source/profile/input/output checks, not by copying a reported pass.

Qualification in controller tests uses real local Git/filesystem/native Node
profile processes with deterministic SDK and PR transports. The profile's
`test` failure fixture stands in for an unavailable live boundary; it does not
open a browser or qualify a workbook observer. No new architecture, model
allocation, runtime authorization or desktop-policy exception is implied.
