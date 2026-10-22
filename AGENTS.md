# Devbox setup for coding agents

When asked to obtain and initialize this repository on a new machine:

1. Clone this repository into a dedicated task checkout.
2. Ensure Node.js 24+, npm and Git are available.
3. Run `npm run setup`.
4. If setup reports that a configured product repository is absent and the
   user requested a complete devbox environment, rerun
   `npm run setup -- --allow-clone`.
5. Never commit `pilot.local.json` or another `*.local.json` file.

`npm run setup` installs this repository's locked dependencies, initializes all
configured skill-backed product repositories, performs read-only skill
qualification, runs configuration diagnostics, executes the complete offline
check and runs the synthetic demo. It must not authenticate accounts, install
product-repository dependencies, enable write permissions or create a PR.

Use `npm run setup:repos -- --repo <id>` only when intentionally rerunning the
repository layer without reinstalling dependencies or repeating all checks.

## Validation authentication recovery

When a controller command returns `state: "action-required-auth"`:

1. Do not ask the user to paste a token or copy credentials into the repository.
2. Explain that the pinned Azure Artifacts credential provider needs either
   installation approval or an interactive Microsoft sign-in.
3. If `requiresInstallApproval` is true, obtain approval before running the
   exact `remediation` command from the result. Otherwise ask the user to
   complete the Microsoft sign-in/MFA opened by that command.
4. Run the remediation command only from its declared `cwd`. Do not capture or
   report provider diagnostics that may contain credential material.
5. After successful remediation, retry the original controller command once.
   The assignment remains `prepared`, so this resumes the same assignment
   without launching a duplicate worker.
6. If the user declines, remediation fails, or authentication is still required
   after the retry, stop and report the assignment as blocked. Do not loop.

Dependency-cache hits do not require authentication preflight. Never delete a
trusted dependency receipt merely to force authentication.

## Draft PR publication and merge authorization

Controller and worker deliveries remain Draft PRs. Creating, updating, testing,
reviewing or completing an assignment does not authorize publishing a draft,
enabling auto-complete or merging it.

A separate user instruction must explicitly identify the PR by repository and
number or URL and authorize the requested publication or merge. Do not interpret
"merge this PR", "merge first" or similar wording as authorization when multiple
PRs are in scope. Ask which PR the user means; if the user is unavailable, leave
all drafts unchanged. Authorization for a controller PR never extends to its
generated product-repository PRs, or vice versa.

Keep draft publication and merge outside the autonomous agentic loop. Passing
validation, a clean mergeability result, no blocking policies, and a prior merge
authorization for another PR are not permission to merge.
