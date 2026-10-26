# 1JS real evidence-to-Draft-PR E2E: completed locally

Recorded on 2026-10-23. **The real 1JS local live E2E has been completed:
one new contiguous five-repeat batch passed, with zero retries, and a Draft PR
was created. Aurora was triggered but failed before its configuration snapshot;
cloud validation is not complete.** This is not a claim that every historical
attempt succeeded or that the original formal process exited successfully.

| Boundary | Recorded result |
| --- | --- |
| Evidence | Original authenticated ADO collection, preserved candidate and capture; no recollection for the successful continuation |
| Collection window | 2026-09-21T00:00:00Z to 2026-09-22T00:00:00Z, end exclusive; captured on 2026-10-16, not a reconstruction of historical boundary state |
| Candidate | ADO 12403919 revision 7, Resolved/Fixed; regression coverage, not a new product fix |
| Repository skill | `1js-declarative-e2e-authoring`, qualified at `1351fd3b7ce29582f0f859ffdcd266cdf90d1699` |
| Approved/published source | `158cd1d1a8dac2818abbd984d6067ce79268714c` |
| Case | `excel-agent.aad.chat-only-plan-approval-read` |
| New formal batch | `excel-agent-local-68e1a27d6ed6a98f`, repeats 0 through 4 passed, every retry 0 |
| Cleanup | Validation workspace removed; original owned page count restored 1 to 1; owned browser/processes exited |
| Draft PR | [1JS Draft PR 5895602](https://dev.azure.com/office/Office/_git/1JS/pullrequest/5895602), targeting `feature/agent_reliability`; not merged |
| Aurora | [Build 57965896](https://dev.azure.com/office/a4aa557b-7dca-453d-9d83-2fe9271852b9/_build/results?buildId=57965896), definition 36540: completed/failed |
| Cloud experience/platform | `omni`; remote platform not independently verified |
| Report | Original HTML retained privately; its latest render receipt has 117 passing checks, not 117 business tests |

## Proof structure and scope

This uses the same `e2e-evidence` home and sanitized JSON/hash convention as the
OfficeAgent proof. It has a distinct `1js-native-continuation-proof-v1` manifest:
the older `e2e-proof-check` command expects complete-record FILTER consolidation
and is **not** the checker for this retained, previously selected native
assignment. No new FILTER execution, candidate selection or model authoring is
claimed. The proof is generated from the terminal `draft-pr-validated` ledger
result, original collection/capture, native receipts and recorded publication
reconciliation, rather than a manually declared successful run.

| File | Purpose |
| --- | --- |
| `01-collection.json` | Original collection window/count, preserved candidate and capture hashes |
| `02-selection-handoff.json` | Hash-bound investigation, coverage plan and assignment lineage |
| `03-1js-authoring.json` | Qualified skill, authoring/registration files, exact source |
| `04-validation.json` | Five new repeats, step results and source-bound gate; preparation is separate |
| `05-publication.json` | Draft PR, exact head/target, existing build and recorded uniqueness |
| `06-recovery-and-follow-ups.json` | Original exit 1, bounded recovery, cloud failure and remaining work |
| `07-safety-and-performance.json` | Cleanup, unchanged boundaries and measured, not optimized, timings |
| `08-private-evidence-index.json` | Hashes and logical roles of retained private artifacts; no private paths or bodies |
| `run-manifest.json`, `SHA256SUMS` | Manifest and integrity of every committed proof file |
| `verify.mjs` | Read-only, offline public/private archive verification; no live execution |

From the repository root:

```powershell
node e2e-evidence\1js-chat-only-full-live-20261023\verify.mjs
node e2e-evidence\1js-chat-only-full-live-20261023\verify.mjs --private .state\e2e-evidence-private\1js-chat-only-full-live-20261023
```

The private directory is deliberately ignored and not portable through Git.
Its `private-index.json` maps hashes to copied artifacts and original locations.
It retains source records/captures, selection/assignment/terminal records,
native summary and per-repeat screenshots/diagnostics, validation/registration
receipts, preparation/history evidence, original blocked and new reconciliation
manifests, publication recovery, Aurora diagnosis, and the HTML with its images
and render screenshots. Do not delete that directory when cleaning a task
worktree without first moving and reverifying this named archive in approved
private storage. Raw evidence, images, identities, local paths, authentication
material and full runtime ledgers are not committed.

SHA-256 establishes byte integrity and linkage to the retained artifacts, not
independent authentication of an Azure DevOps server or a fresh remote status
check. Publication/build statuses are those of the recorded verification
receipts on 2026-10-23. Offline verification never requeues a build, repeats
business validation or creates another PR.

## What passed and what still needs work

The business case observes genuine plan approval without clicking Proceed,
discards that conversation, seeds a private canary, switches explicitly to
Chat only, verifies a real cell read and an attempted write remaining blocked,
and preserves the protected/unrelated cells and cleanup contract. Passes from
previous campaigns are not aggregated into the final five.

The formal process exited 1 **after** the five passes and real cleanup: Azure
DevOps had accepted build 57965896, but its project-GUID URL was rejected by the
controller. Controller commit `7cce97446c8c326476f4f0dffe1595151749d2ae`
fixed verified project-GUID URLs; 10 targeted tests passed. Read-only
reconciliation adopted the existing build and created the one Draft PR.
Recovery invoked no native test, model, push or build queue. Its attempt to
change an already sealed blocked manifest was rejected; that original manifest
was preserved, and a separate completed reconciliation manifest was created.
Both blocked and reconciled worker results are retained.

**Open follow-up:** synchronize the suite-owned
`ooui/packages/declarative-e2e-reliability/src/support/excel-agent-case-tags.json`
under a separately approved source. At the frozen source, reviewed/lifecycle
catalogs contain 32 cases, but the suite-owned catalog contains 31 and omits the
new case. Aurora's earliest failure was
`Validate Excel Agent lifecycle case tags before snapshot`; missing downstream
artifacts are consequential, not evidence of a failed cloud business assertion.
Close this follow-up only after catalog consistency, case-tag validation,
configuration snapshot creation and actual cloud business validation pass.
This archival task does not alter the approved source or trigger Aurora again.

Preparation/fingerprint/byte scans and cleanup remain performance follow-ups,
not completed optimizations. Independent preflight is not one of the five
business passes. The original HTML retains the historical failures,
investigations, bounded fixes and their limitations.
