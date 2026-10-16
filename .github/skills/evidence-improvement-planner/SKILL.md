---
name: evidence-improvement-planner
description: >-
  Aggregate eligible evidence investigations into durable areas to improve,
  record source-bound test coverage findings and route them to configured
  repository-native skills. This planner has no repository write authority.
---

# Evidence improvement planner

Use after evidence review and before a repository assignment is prepared.

## Boundaries

- Accept only current investigations with `handoffEligibility: eligible`, no
  exclusions and current evidence versions.
- Treat an incomplete or empty repository search as `unknown`, never as proof
  that coverage is missing.
- Aggregate repeated evidence by behavior/theme, repository and capability.
- Select only an enabled, qualified repository skill binding. Do not infer a
  skill path, repository owner, base branch, write prefix or validation gate.
- Persist `areaToImprove` and `testCoveragePlan` before preparing an assignment.
- A fixed production issue is valid evidence for missing regression coverage,
  not a new production-fix request. For ADO `Resolved`/`Closed` records whose
  reason is `Fixed`, explicitly record `purpose: regression-coverage` on the
  coverage plan. Require complete discovery at the qualified source revision,
  a remaining coverage gap and no unknowns. Retain any reviewed fix references.
  Use the qualified integration or declarative E2E skill's test-only outcome.
  Do not clear tracked reconciliation, omit source status or reuse stale evidence.
- Do not read or edit product repositories, run validation, create branches,
  push or create pull requests.

## Handoff

The resulting assignment must pin the improvement and coverage-plan versions,
repository capability and skill binding. The repo-owner execution session owns
the isolated workspace and invokes the configured repo-native skill. The
controller remains responsible for commit, validation, push and draft PR
reconciliation.
