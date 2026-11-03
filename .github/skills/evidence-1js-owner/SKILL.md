---
name: evidence-1js-owner
description: >-
  Investigate or implement a claimed periodic-evidence-agent assignment routed
  to repoId 1js. Use for evidence-backed RCA, authorized fixes and source-bound
  validation in an isolated 1JS workspace; not for unrelated 1JS development.
---

# 1JS repo-owner agent

Logical identity: `repo-owner:1js`. A native project session is only the current
execution handle. Read the shared [repo-owner procedure](../repo-owner-procedure.md)
and follow it in full.

## Binding

- Accept only a durable assignment with `repoId: 1js`, routed through approved
  ownership and claimed by the coordinator.
- Resolve project ID, remote, base, allowed edit prefixes, permissions and
  validation gates from the selected configuration/assignment. Do not embed a
  colleague's local checkout or project UUID into this skill.
- Reject Office src assignments and cross-repository edits. Report cross-repo
  evidence to the coordinator rather than creating another worker yourself.
- Read instructions in the actual isolated 1JS checkout before implementation.
  Use its existing package/test tooling. Do not assume a validation command,
  account, ring or pipeline from the repository name.

The pilot's ownership/write/validation configuration is not automatically
resolved by this skill. If no valid claimed assignment and isolated workspace
are supplied, return the missing inputs without modifying or running product code.

## Recorded live E2E proof

The [2026-10-23 1JS proof](../../../e2e-evidence/1js-chat-only-full-live-20261023/README.md)
records real evidence-to-Draft-PR completion: a new contiguous five-repeat batch
passed with retry 0, cleanup passed, and Draft PR 5895602 was created. Aurora
57965896 was triggered but failed case-tag validation before configuration
snapshot creation; cloud validation remains an open follow-up. This historical
proof is not authorization for new collection, authoring, validation or writes.

## Setup and validation troubleshooting

After the required handoff is verified, read the controller's
[1JS local setup and validation notes](../../../README.md#1js-local-setup-and-validation)
alongside the active product checkout's own instructions and application README.
The notes distinguish Azure CLI, package-feed and browser authentication;
installation from compilation; and local checks from real product E2E.

Inspect the actual tasks before replacement of dependency/generated directories,
and obtain the exact cleanup approval required by that checkout. Do not borrow
another worktree's tools or outputs, clear shared caches, bypass build checks or
treat an earlier checkout's success as validation of this assignment.
These troubleshooting notes grant no additional execution or publication authority.
