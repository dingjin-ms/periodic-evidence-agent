# Source-driven case generation

This opt-in lane creates a **proposed** canonical E2E case batch upstream of
[ADO request execution](ADO-TEST-REQUESTS.md). It does not replace FILTER,
native qualification, source-revision admission, worker recovery or Draft gates.
The generation request authorizes its scoped reads and local synthetic-file
generation, not ADO writes, product execution, schedules or PR publication.

## Skill entrypoint

Use the [generate-test-cases skill](../.github/skills/generate-test-cases/SKILL.md)
from a skills-capable host:

> Please generate ADO test cases with content from the JSON config.

In Chinese:

> 请根据项目 JSON 配置中的链接内容，生成 ADO 测试用例。

Keep the real URLs in the already checked-in
[`generateE2E.config.json`](../generateE2E.config.json). The agent reads the
existing [`generateE2E.md`](../generateE2E.md) itself. No manual downloads,
per-run configuration files, source manifests or prebuilt test files are user
prerequisites. Existing deployment identity and approved private storage in
`pilot.local.json` are one-time environment prerequisites. Authentication/MFA,
real access failures and independent QA cannot be silently bypassed.

### Agent-driven normal path

The following are **agent/controller operations**, not a checklist the user
must type or maintain. The skill prepares all internal JSON itself.

```powershell
node src\cli.js case-start --authorize-collection --authorize-generation
node src\cli.js case-context --run RUN_ID
```

`case-start` reads the root guidance/configuration, creates an isolated ledger
under the approved state directory, and captures the ADO template, sample and
saved-query results. The actual template supplies its Area Path and work-item
type. Flat, tree and one-hop saved queries hydrate at most 100 unique items at
the returned `asOf`, preserving returned relations; over-cap results remain
partial. Native source reads are GET-only,
reject redirects and share a 40-call/3 MiB bound. Figma REST first verifies the token's current-user email against the designated
account, then reads only the configured node when an existing
`FIGMA_ACCESS_TOKEN` is available; otherwise
Figma and Teams/SharePoint/Loop become scoped host-connector tasks.

The agent verifies its actual executing WorkIQ `/me` identity before content
reads, reserves each host source, uses an available authenticated native tool
against the exact configured URL, and captures the actual sanitized response:

```powershell
node src\cli.js case-source-begin --run RUN_ID --source SOURCE_ID --authorize-collection
node src\cli.js case-source-result --run RUN_ID --file AGENT_RECEIPT --authorize-collection
```

Search/retrieval is partial, not complete source content. Host captures remain
`app-host-tool-reported`, with document-level inventory and explicit limits.
No connector, denied access, empty/error content and interrupted calls remain
visible blockers; the agent must not invent exports or blindly repeat reads.
The skill documents the receipt format and bounded host procedure.
Native Figma captures must include the actual `whoami` response with the
designated email. When the configured node is a canvas, read its metadata and
only provider-returned descendant frames within the same five-call content
budget; unvisited frames and missing visual context remain explicit limits.

After an explicitly authorized connector/parser repair, the agent can recover
only the blocked configured source without restarting successful sources:

```powershell
node src\cli.js case-source-recover --run RUN_ID --source SOURCE_ID --authorize-collection --authorize-recovery
```

Recovery appends a receipt and retains every original failure. Native HTTP
responses are journaled before parsing and replayed offline; only a previously
unrequested hydration can perform a new authorized read. Interrupted requests
remain uncertain and are never automatically repeated. Each source allows at
most two explicit recovery reservations and four distinct recovery/native
requests. Host recovery returns a fresh exact-source reservation; submit its
actual response with `case-source-result`. Authentication/access denial still
requires supported sign-in or permission remediation before another host read;
this command does not grant access or authorize an automatic retry loop.

When `case-context` returns `ready-for-design`, the agent reads the complete
captured context and canonical `caseGenerationDraft` contract. It designs cases
first and determines their required files, then writes a private submission
with `generator`, `draft` and exactly the required `fixtureRequests`. Safe
declarative builders produce real synthetic TXT, JSON, CSV and XLSX files;
originals that cannot be accessed stay explicitly missing. Scripts, formulas,
macros and arbitrary downloads are not recipe execution features.

```powershell
node src\cli.js case-submit --run RUN_ID --file AGENT_DESIGN --authorize-generation
```

The controller materializes and hashes the files, automatically creates its
source manifest/configuration, records the canonical batch and renders the
workbook/report/manifest. It stops at `review-held`. Unknown source approval
and applicability are not manufactured by generation. The default repository
pin is design-only controller provenance, not product-code inspection.

The agent presents the exact batch hash and artifacts for independent QA.
Actual source-applicability/case/file-sharing review and separate publication
authorization are recorded without a user-written approval JSON:

```powershell
node src\cli.js case-publish-reviewed --run RUN_ID --batch-sha256 HASH --reviewer ACTUAL_REVIEWER --approval-ref ACTUAL_REVIEW_REFERENCE --authorize-approval --authorize-source-review --authorize-publication
```

This creates an immutable reviewed baseline using the unchanged case design and
the exact reviewed source/fixture pins. It does not rewrite the original batch,
self-approve a generator, or permit product execution. The existing verified,
revision-aware publisher remains the only ADO write path. Report actual
published IDs and verified attachments, or the precise partial/blocked result.

Repeated starts reuse the recorded run and do not recollect. Changed guidance,
identity, recipes or file bytes cannot silently reinterpret an existing run.
`--refresh` is for an explicitly authorized new source pass, never automatic
auth recovery. Missing permissions cannot be fixed by changing the daily
deployment identity or enabling unrelated collectors.

The URL-first frontend uses the current app host; it does not require the
standalone SDK/model policy described in the advanced path below. Reload/reopen
the project if the host has not refreshed its skill list. File presence and
offline tests do not establish host discovery or live provider qualification.

## Advanced compatibility path: configuration and approved captures

Use a task-owned controller configuration and ignored state directory. Add the
contents of `case-generation.policy.example.json` under `caseGeneration`.
Approve the exact input root and its sanitized exports before enabling it.
Do not change a daily deployment or its ledger. Source imports and generated
request execution must use the **same** ledger. `pilot.local.json` and all
`*.local.json` files remain private.

This lower-level compatibility path accepts **explicit approved exports**; normal
users use the agent-driven connectors above instead. Neither path is an
unrestricted SharePoint/Figma crawler. A URL or Azure login is not proof of access.
Place the approved guidance Markdown and its `generateE2E.config.json` beside
each other under `inputRoot`. The JSON is resolved relative to the Markdown,
not the process directory. All five configured starting URLs are mandatory.
No cached URL fallback is permitted.

The `caseGenerationAdmission` and `caseGenerationDraft` definitions in
`contracts.schema.json` specify the exact versioned inputs. An admission includes:

- A new baseline ID, previous canonical batch ID or null, scope, product/build
  and environment descriptions (explicitly unknown where appropriate).
- Target repository and exact available commit. Existing-test references require
  a captured repository source at that same revision.
- Destination organization/project/type/tag and actual verified Area Path, plus
  template/team IDs and an approved template export with exact default fields.
  The template URL must match; its owner ID is not an Area Path.
- A manifest of scoped text exports with source identity, actual revision or
  null, UTC retrieval/modified timestamps, approval/applicability, access state,
  population limitations and SHA-256. `itemIds` enumerates captured atomic source
  items; each must receive a disposition. It is an admitted inventory, not
  automated proof that an external source population was exhaustively read.
- Fixture identities, provenance, immutable byte hashes/sizes, safe sharing
  approvals and handling instructions. Missing files use null path/hash/size
  and explicit blockers. They cannot qualify as automation ready.

Exports, fixtures and guidance must be ordinary files within the approved root;
traversal, protected paths and symlink/reparse paths are rejected. Only the
declared files are imported; no links are followed. Do not import credentials,
customer data or unapproved production content. The importer verifies declared
hashes; it cannot independently establish a document's approval or sanitization.
Those are independent review responsibilities.

```powershell
node src\cli.js case-sources --config cases.local.json --file sources.local.json --authorize-import
```

This records a content-addressed bundle and reserves its baseline. Reusing the
baseline with different source, guidance, configuration or policy pins fails.
Source snapshots are immutable; updates need a new baseline. A change to current
guidance, URL configuration or case policy invalidates downstream admission.
Read-only status and rendering can still project the recorded historical baseline;
they do not retrieve sources or attest that its admission remains current.
The controller records its Git HEAD, not a claim that the checkout is clean.

## Generate, inspect and approve

```powershell
node src\cli.js case-generate --config cases.local.json --bundle BUNDLE_ID --authorize-generation
```

Generation requires standalone SDK mode and a separately enabled model policy
with explicit model, timeout, finite controller credit limit and acceptance of
the soft credit limit. The complete bounded source bundle is supplied as input.
Only a structured finish tool is exposed: no browser, shell, external retrieval,
publication, installed skills or workers. The captured Markdown governs design,
not tool authority. Interrupted model attempts remain uncertain and are not
automatically retried.

Alternatively, import a captured structured generation result with
`case-import-draft --config cases.local.json --file draft.local.json --authorize-import`.
The input has exactly `bundleId`, `generator` (actual provenance, not a fabricated
session) and `draft`. Import still stops at the independent QA hold.

The default ceiling is 15 selected unique cases, including reused tests.
Parameterized/configuration rows and projected executions remain separate.
Larger ceilings require `caseLimitApproval` with `approvalRef` and evidence-backed
`reason`, plus the exact batch review. A new baseline preserves existing IDs,
increments changed case revisions exactly once, and explicitly retires omissions.
Semantic equivalence, source truth, risk selection and faithful assertions still
require QA judgment; schema checks do not prove them.

```powershell
node src\cli.js case-status --config cases.local.json --batch BATCH_ID
node src\cli.js case-approve --config cases.local.json --file approval.local.json --authorize-approval
```

The approval input has exactly `batchId`, `batchSha256` (from status), `reviewer`
and `approvalRef`. The reviewer must differ from the recorded generator.
An explicit operator approval is required; a model cannot approve itself.
Approval binds the entire canonical batch and its admitted source/destination/
fixture pins. This is not permission to publish or execute.

## Three synchronized deliverable groups

```powershell
node src\cli.js case-render --config cases.local.json --batch BATCH_ID
node src\cli.js case-publish --config cases.local.json --batch BATCH_ID --authorize-publication
node src\cli.js case-render --config cases.local.json --batch BATCH_ID
```

Rendering can run before approval/publication. It writes registered artifacts
under the existing bounded local evidence-retention system:

1. A field-mapped publication manifest containing actual receipts or clearly
   unpublished drafts. The publisher separately creates/updates ADO items.
2. `cases.xlsx`, a real eight-sheet workbook with frozen headers, filters, wrapped
   text, explicit statuses, clickable source/ADO links and detailed step pairs.
3. `coverage.html`, with the eight ordered coverage/decisions sections, detailed
   steps and fixture accounting.

All projections share canonical IDs, revisions and counts. Text is not emitted
as spreadsheet formulas or executable HTML. Rendering does not launch a model
or worker, and replay checks registered file hashes. New recorded publication/
delivery facts produce a new artifact revision, not edits to approved cases.
Content is reproducible from receipts; ZIP-container timestamps are not promised
byte-identical across independent initial workbook renders. Automated XLSX
round-trip checks are not desktop Excel visual inspection.

Publication requires the independent enabled/approved bounded publication policy,
the explicit flag and exact QA approval. It re-reads the live template and
work-item schema before any item writes. It preserves the verified work-item type,
including Bug; no project schema or permission changes are made. Canonical
content maps into the existing five-field description; stable origin and source
references use that existing description, not invented custom fields.

Lookup/readback and a task-owned ledger mapping protect reruns. Updates use an
ADO revision test; user edits, moved items and changed published revisions are
holds. Each required file is uploaded, linked and downloaded to verify its name,
size and SHA-256. A successful upload alone is not completeness. Partial item IDs
and mutation receipts remain recorded. Uncertain creates reconcile only when a
matching remote effect can be read back; no match means held, never blind POST.
Uncertain unlinked uploads remain held for explicit reconciliation. Existing
user attachments are never deleted.

The HTTP adapter pins destination and attachment hosts/paths, rejects redirects,
caps calls/bytes and rechecks policy/batch admission after authentication.
Actual provider access, schema defaults, permissions and attachment restrictions
still need separately authorized live qualification. Synthetic adapter tests
are not evidence that an organization's live ADO schema accepts the mapping.

## Guarded Workflow 2 handoff

```powershell
node src\cli.js case-run-request --config cases.local.json --batch BATCH_ID --case CASE_ID --authorize-review
```

Execution additionally requires `--execute --authorize-commit --authorize-push
--authorize-draft-pr`, normal repository grants and qualified local SDK/native
validation. No remote Agency path is introduced.

For repositories with maintained request phases, pass `--phase prepare`,
`author`, `validate-<gate>`, `commit` or `publish` with those execution grants.
The existing request backend still enforces the configured phase order, gates
and cumulative budgets; the case adapter does not replace them.

Generated markers are not authority. Shared intake, preparation, assignment and
publication checks require the trusted local batch approval, publication mapping,
exact item revision and unchanged fields. Ordinary request/dispatch commands
cannot bypass them. Human-authored unmarked requests retain existing behavior.
An approved E2E route and independent support-matrix review are required; the
existing OfficeAgent integration-test route is not silently treated as E2E.

**Current implementation limit:** fixture-dependent execution stays held with
`blocked-fixture-access`. ADO attachments are verified for publication, but this
change does not grant workers arbitrary downloading, binary reads or filesystem
access. A repository-specific qualified native fixture-input adapter is still
needed before those cases can execute. No business assertion or fixture is
removed to make a case eligible. Unsupported native actions/verifiers use the
existing independent harness-request process, not automatic harness development.

Source collection adapters, native fixture support, live product gates and
desktop workbook visual review are not qualified by the offline tests.
No schedule is installed, no current scheduled protection is inferred, and no
Draft PR is published, merged or auto-completed by these commands.
