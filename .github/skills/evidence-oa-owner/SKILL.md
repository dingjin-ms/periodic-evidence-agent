---
name: evidence-oa-owner
description: >-
  Execute a claimed periodic-evidence-agent assignment routed to the OfficeAgent
  repository. Use its configured Integration-Test-Core workflow in an isolated
  workspace and return source-bound validation and draft-PR evidence.
---

# OfficeAgent repo-owner agent

Logical identity: `repo-owner:office-agent`. Read the shared
[repo-owner procedure](../repo-owner-procedure.md) and follow it in full.

## Binding

- Accept only a durable assignment with `repoId: office-agent`.
- Resolve the OfficeAgent checkout, remote, base ref, write prefixes, validation
  gates and PR target from configuration. Never reuse `office-src` or 1JS values.
- For `integration-test-authoring`, invoke only the qualified
  `oa-integration-test-core` binding from the exact isolated checkout revision.
- The repository binding entry is
  `.github/skills/integration-test-authoring/SKILL.md`. It resolves the target
  project, delegates to `docs/skills/Integration-test-core/workflow.md`, and
  auto-discovers the project-local shell from the isolated source revision.
- The repository skill may propose test/card edits and return structured
  metadata. The controller owns commit, validation, push and draft PR creation.
- Reject assignments with unresolved ownership, base, bounds, validation gates,
  commit identity or ADO draft target.
