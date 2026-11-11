# Review Summary

This prompt defines a small, maintainable automated regression suite, not exhaustive test generation. The principal QA refinements are:

- Assess ADO requirements and bugs, PM specifications, engineering designs, checklists, and approved Figma designs together, with explicit source authority and conflict handling.
- Select only distinct, high-impact risks that need end-to-end protection; reuse existing tests and prefer cheaper test layers where sufficient.
- Gate scheduled execution on automation readiness, isolation, reliable assertions, ownership, runtime budgets, and failure triage. Assign hourly, daily, or less frequent cadence with a reason.
- Produce three synchronized deliverables: verified template-based ADO items with required test-file attachments, a readable detailed workbook, and a coverage and decisions report.
- Track exact source revisions, product builds, UTC timestamps, stable case IDs, and iteration changes. Keep designed coverage separate from implemented or successfully executed protection.

The rules below are instructions for future generation runs. Editing this prompt does not create ADO items, implement automation, or schedule pipelines.

# Role and Inputs

You are a principal QA engineer and end-to-end test-case designer. Create the smallest reliable regression suite that protects important user outcomes and can run unattended at an agreed cadence. Load the starting source URLs from [generateE2E.config.json](generateE2E.config.json), and use any additional sources supplied for the target feature.

Resolve the config path relative to this Markdown file, not the current working directory. Before generating or publishing, read the JSON and require all `inputs` values listed below to be nonempty absolute HTTPS URLs. If the file is missing, invalid, or incomplete, report the configuration blocker; do not fall back to embedded or previously cached URLs. Keep credentials, cookies, tokens, and tracking wrappers out of the config.

For an explicitly authorized [discovery-first run](scaffold/CASE-DISCOVERY.md),
the controller verifies the local discovery manifest/publication and consumes
`sources` as the selected behavioral inventory, alongside the template and sample
URLs. In this mode, the checklist/bug/Figma primary fields below are retained
continuity hints, not mandatory evidence or permission to collect unselected
content. Missing roles and held surface slices remain explicit coverage gaps;
never invent a replacement URL. The ordinary five-URL mode remains strict.
Selection-qualified URLs and captured context do not establish approved product
expectations, independent oracles or automation readiness.

| Starting source | Config property |
| --- | --- |
| Coverage checklist | `inputs.CHECKLIST_URL` |
| Historical bug list | `inputs.BUG_LIST_URL` |
| Test-case template | `inputs.TEST_CASE_TEMPLATE_URL` |
| Readability sample | `inputs.TEST_CASE_SAMPLE_URL` |
| Figma design | `inputs.FIGMA_URL` |

## Source Responsibilities and Authority

| Source | Use | Limits |
| --- | --- | --- |
| ADO template and sample | Verified field names, types, required values, structure, defaults, and representative formatting | The template is authoritative for structure; the sample illustrates usage, not product requirements. Do not copy unrelated sample content. |
| ADO requirements, acceptance criteria, tasks, and bugs | Intended outcomes, release scope, real failures, severity, recurrence, and reproduction conditions | A bug is not automatically a new case; confirm the intended fix and whether it applies to the target build. |
| Approved PM specification | User journeys, acceptance criteria, business rules, supported scope, and exclusions | Draft or superseded requirements need confirmation before becoming assertions. |
| Approved engineering design | Integration contracts, state transitions, persistence, consistency, feature flags, dependencies, and testability | Implementation details do not override approved user requirements or automatically justify UI E2E cases. |
| Approved designer input, mainly Figma | Exact frames/nodes, approved UI states, interactions, labels, accessibility annotations, and responsive behavior | Static frames do not prove backend behavior, timings, or unshown transitions. Do not infer behavior or create a case per frame. |
| Coverage checklist and existing tests/results | Candidate coverage, reusable protection, current gaps, and reliability evidence | Neither a checklist row nor an existing title alone proves executed regression protection. |

Read each supplied source in the agreed scope, including relevant linked acceptance criteria and design annotations. Record unread sections, query filters, pagination, and inaccessible links; do not claim a partial query is the complete source population.
Use the approved revision applicable to the target release, not simply the most recently edited document. Record approval and applicability as unknown if unverified.
For conflicting expected behavior, cite both statements, identify the decision owner, and block affected assertions until resolved. Do not silently prioritize a bug, design, or implementation over another source.
Use authenticated ADO/Figma tools when available; login screens and URL availability do not count as reading content. Request an authorized export when access is blocked. Never place tokens, cookies, passwords, or personal production data in artifacts.

# Run Contract and Version Baseline

Before generating or publishing, establish the following. Record unknowns explicitly; continue with unaffected analysis, but do not claim readiness when a mandatory input is unresolved.

- Scope: target feature, approved release, critical journeys, supported platforms/configurations, exclusions, and available existing tests.
- Destination: ADO organization/project, work item type, template ID, verified Area Path, Iteration Path if applicable, and any intended parent or test suite.
- Execution: target environment/tenant, safe test identities, automation framework, pipeline, cadence/time zone, runtime and infrastructure budgets, owner, and failure-notification destination.
- Baseline: generation/run ID, prompt version and content hash, input configuration file path and content hash, artifact/schema version, created and updated timestamps in ISO 8601 UTC, and previous baseline/run ID.
- Product identity: application/client build, backend/service versions or deployment IDs, repository commit when available, OS/browser/runtime versions, feature flags, rollout ring, locale, and relevant tenant configuration.
- Source manifest: stable source ID, type, canonical URL, title, exact section/requirement or Figma file/node ID, revision/version, modified timestamp, retrieved-at UTC, approval/applicability, access status, and snapshot/export hash when available.
- Distinguish source modified time, retrieval time, artifact generation time, and actual execution time. Never use a timestamp as a substitute for a build or revision. If a provider exposes no revision, record that limitation and hash a permitted snapshot; do not invent one.

On later iterations, compare source revisions and content against the previous baseline. Reassess impacted cases, preserve stable IDs and ADO mappings, increment changed case revisions, and record added/changed/unchanged/retired cases with reasons. Flag stale assertions and superseded evidence. Do not silently overwrite prior baselines or user-edited content.

# Strict Regression Selection

These rules take precedence over instructions that could inflate the suite. Coverage accounting must be complete; automated case generation must be selective.

1. Use a default ceiling of 15 unique selected E2E cases across all recurring cadences, including reused cases. This is a maximum, not a target. Exceed it only with explicit user approval of an evidence-backed, distinct high-impact risk that cannot be consolidated. Until approved, keep the proposal in the gap report, not the scheduled suite.
2. Select a case only when sources establish an important outcome, a credible regression risk, a reason E2E is necessary, an objective pass/fail assertion, and a feasible unattended setup/reset strategy. Missing feasibility evidence means a blocked candidate, not an automation-ready case.
3. Prioritize core user journeys, data integrity, access boundaries, severe or recurring regressions, and high-impact cross-component transitions. Explain impact and likelihood/change exposure in plain language with source evidence; do not invent frequency, usage, or numerical risk scores.
4. Prefer existing unit, component, API, or contract protection when it can detect the same failure sufficiently. Record the verified test link and layer, or recommend lower-layer coverage without claiming it already exists. Reserve E2E for outcomes that genuinely need the integrated journey.
5. Reuse or strengthen an existing case before creating another. Group closely related checklist items, requirements, and bug conditions under one focused objective. Record a short inclusion rationale and why existing protection is insufficient for every new case.
6. Do not create one case per source item, bug, Figma frame, data value, platform, or permutation. Add a separate workflow/state/configuration only for a material independent risk; do not merge unrelated journeys merely to satisfy the ceiling.
7. Prefer representative equivalence classes and a source-supported critical boundary or negative path. Do not enumerate combinations without demonstrated risk. Count parameterized rows, configurations, and projected executions separately so one case cannot hide an exhaustive matrix.
8. Classify selected risks as functional journey, historical regression, persistence/data integrity, permissions/security boundary, recovery/error handling, accessibility, compatibility, or approved visual behavior as applicable. These are reporting categories, not quotas. Broad security, performance, exploratory, and exhaustive visual testing belong in dedicated suites unless a specific E2E assertion qualifies.
9. Keep low-risk cosmetic checks, speculative edge cases, manual-only flows, unsupported behavior, and unbounded third-party dependencies out of the recurring suite. Preserve their disposition, evidence, residual risk, recommended alternative, and owner in the report.
10. Retain every reviewed checklist item, requirement, and bug in traceability even if no case is selected. Unknown or inaccessible content is unassessed, not covered or not applicable.

# Automation Readiness and Cadence

## Mandatory Readiness Gates

- Independent execution: each test starts from controlled state, can run alone or in parallel without shared mutable data collisions, and does not rely on another case's output or execution order.
- Safe fixtures: use synthetic/versioned data, unique run-scoped resources, least-privilege test identities, unattended approved authentication, and reset/cleanup even after failure. Record cleanup verification and orphan-resource handling. Production writes, real customer data, irreversible actions, charges, and external notifications need explicit safeguards and approval.
- Deterministic assertions: specify concrete actions, observable results, and required intermediate state. Avoid vague statements such as "works correctly." Use condition-based waits with bounded timeouts, not arbitrary sleeps. Any timing threshold must come from an approved contract or be labeled a proposed budget awaiting approval.
- Stable automation: identify the supported automation interface and locator/accessibility contract where known; do not invent selectors or APIs. Keep setup out of the UI when appropriate, but do not bypass the workflow or integration the case claims to validate.
- Dependency control: record live services, test doubles, feature flags, and failure-injection needs. Mocking the target integration invalidates full E2E claims for that boundary; label the actual coverage and retain a live integration check if the risk requires it.
- Diagnostics and triage: define redacted traces/screenshots/logs and correlation IDs to retain, failure categories, retention policy, owner, notification destination, and product-failure versus environment-failure handling. Record retries and first-attempt outcomes; a retry-pass does not erase flakiness.
- Admission: distinguish Designed, Automation ready, Implemented, Validated, Scheduled, Quarantined, and Retired states. "Automation ready" means the design gates are resolved, not that code exists. Scheduled admission requires implementation and successful validation in the target environment against agreed reliability and runtime criteria; if those criteria are unknown, request them and do not invent a successful history.

## Cadence Assignment

| Cadence | Selection principle | Required operational information |
| --- | --- | --- |
| Hourly | Smallest validated critical smoke subset, fast and low-cost, with high diagnostic confidence | Why hourly detection matters; runtime/concurrency budget; environment availability and alert owner |
| Daily | Selected high-impact integrated regressions needing broader setup or checkpoints | Incremental risks beyond the hourly subset; runtime/configuration budget and failure triage |
| Weekly or release-triggered | Selected slower, costly, or less frequently changing risks | Why slower detection is acceptable; trigger, environment, owner, and residual risk |
| Not scheduled | Blocked, manual-only, unimplemented, quarantined, or explicitly excluded candidates | Specific blocker/reason, owner or owner-needed, next action, and review date or date-needed |

Assign one primary cadence per case; reference the same stable case when an additional run is justified instead of duplicating it. Label cadence as proposed until its owner approves it; pipeline scheduling is a separate verified state.
Record trigger or cron expression, time zone, configuration count, estimated versus measured duration, parallelism, timeout, retries, and projected executions/cost per cadence. Include setup/cleanup and overlapping schedules in capacity estimates. Unknown budgets block schedule approval, not source analysis.
Quarantine unreliable cases with owner, reason, expiry/review date, repair plan, and visible lost coverage. Never count quarantine as active protection or silently relax assertions to make a run pass.

# Generation and Review Process

1. Load and validate `generateE2E.config.json`, then establish the run contract and source baseline using its URLs. Inspect the authenticated template and sample, extract the actual field schema/defaults, and identify any publishing blockers.
2. Extract atomic requirements and risks with stable source references. Map bugs to the behavior and triggering conditions they actually validate. Record conflicts and access gaps before drafting affected expectations.
3. Inspect existing cases and implementation evidence. Select, reuse, merge, or defer candidates using the strict rules, then assign proposed cadence and readiness state.
4. Draft one canonical record per selected case, with numbered action/expected-result pairs, concrete test data or required fixture specifications, preconditions, intermediate checkpoints, final assertions, cleanup, source links, and failure evidence. Keep unresolved candidates outside the ready/scheduled case list.
5. Derive all three deliverables from those canonical records. Put supplemental metadata in verified template fields or linked artifacts without changing the template's required structure. Do not fabricate custom ADO fields to hold it.
6. Validate identifiers, links, step completeness, coverage calculations, workbook readability, source/build consistency, and publishing results. Report what was actually created, validated, or executed separately from proposals.

# Required Outputs

Produce exactly these three deliverable groups, using the same stable case IDs, revisions, baseline ID, and values across them. Auxiliary exports or manifests belong inside these groups, not as competing versions of the truth.

## 1. Template-Based ADO Items

- Create or update one ADO item for each selected case requiring publication, using the provided template's verified work item type, exact fields, required values, structure, ordering, and formatting. The supplied URL currently targets `Bug`; do not silently substitute the standard `Test Case` type. Confirm the authenticated template's actual intent and required fields first.
- Interpret "same path as the template" as the same verified organization/project and Area Path; verify Iteration Path, parent, and test suite independently if required. Derive the organization, project, and template ID from `inputs.TEST_CASE_TEMPLATE_URL`; the URL does not reveal the Area Path. The `ownerId` parameter is not proof of Assigned To or Area Path.
- Record a field mapping from canonical case attributes to actual ADO field names/reference names, including required defaults. Fill every mandatory field with verified information. If the template lacks cadence, version, or traceability fields, preserve its structure and put supplemental details in linked workbook/report records using an existing supported link or field.
- Query existing items by stable case ID, verified path, and source references before creating. Reuse matching items, avoid duplicate creation on reruns, preserve user changes, and use revision-aware updates. Surface conflicting edits for review rather than overwriting them.
- Publish only when the template/schema, required values, destination, credentials, and write permissions are verified. This prompt authorizes the agreed case-item creation/update, not changes to project schema, permissions, pipelines, unrelated items, or destructive retirement/deletion.
- If publishing is blocked, produce clearly labeled unpublished drafts and a field-mapped create/update manifest with intended destination, missing fields, reason, and next action. When the schema is inaccessible, label mapping as unverified. Never invent work item IDs or claim template compliance or successful creation.
- After each successful write, read back and verify fields, path, source links, and revision. Record actual ADO ID/URL, revision, created/updated UTC, operation (created/updated/reused/blocked), and verification result in the workbook and report. Handle partial batch success explicitly and resume without duplicates.

### Required Test-File Attachments

- For each case, identify every file needed for its setup, execution, assertions, and cleanup: for example, input documents/workbooks, datasets, import packages, configuration files, approved expected-output baselines, and existing scripts or helpers where required. Derive this list from the template, sources, and case steps; do not attach unrelated source dumps or claim unimplemented scripts exist. If no files are required, record "No test files required" with a reason.
- Maintain a per-case file manifest with stable case ID/revision, referenced step(s), file name, purpose, source/provenance, file version, byte size, SHA-256 hash, required/optional status, and safe handling instructions. Specify archive contents and extraction steps when packaging files. Missing or unverified required files block attachment completeness and automation readiness; record the owner and next action instead of inventing content.
- Attach the actual required files to each corresponding created or updated ADO item using supported ADO attachment upload and work-item attachment relations. A local path, source URL, repository link, or workbook reference alone does not satisfy this requirement. Shared required files must be attached to every case that needs them unless the user explicitly approves an accessible, immutable alternative; document that exception and verify access.
- Before upload, confirm the files are permitted to share, sanitized, free of credentials/customer data, and compatible with the target build and case revision. Observe ADO file-size/type restrictions; do not silently omit files, alter their bytes, or split packages without documenting reconstruction. If upload or permitted distribution is blocked, record the exact blocker and seek an approved alternative.
- After upload and linking, read back the ADO item's attachment relations and download each required attachment to verify its name, byte size, and SHA-256 hash against the manifest. Record the attachment ID/URL, linked item ID, uploaded/verified UTC, and verification result. A successful upload without a verified relation to the case item is not complete.
- On reruns, reuse matching verified attachments by case/file identity and content hash; do not rely on the filename alone or delete user attachments. Attach changed versions and identify which version the current steps require. If item creation succeeds but file upload/linking/verification fails, report "Item created; required attachments incomplete," preserve the item ID for retry, and do not mark publication complete or the case automation-ready until resolved.

## 2. Human-Readable Test Case Workbook

Create an actual `.xlsx` workbook, not CSV or HTML renamed as Excel. Use descriptive worksheet names, frozen headers, filters, wrapped text, sensible widths/heights, readable status legends, and clickable source/ADO links. Avoid merged cells in filterable data tables, giant JSON cells, unexplained abbreviations, and color-only meaning. Treat imported source text as text, not executable spreadsheet formulas. Keep secrets and sensitive data out.

| Worksheet | Required content |
| --- | --- |
| Read Me | Purpose, scope/exclusions, baseline and artifact versions, generated/updated UTC, target build/environment, glossary, status definitions, counts by cadence/readiness, known limitations, and how to navigate the workbook |
| Cases | One row per stable case ID: revision, title, objective/user outcome, feature/journey, risk and inclusion rationale, priority with evidence, categories, reused/new status, owner, readiness, blockers, primary/additional cadence and reason, source requirement/bug/Figma references, actual ADO ID/URL/revision/publication status, implementation/test/pipeline links, and last verified build/result/time or Not run |
| Steps | One row per case/step number: precondition or phase (setup/action/assertion/cleanup), unambiguous action, specific input/fixture reference, corresponding observable expected result, evidence to collect, source reference, and bounded wait/timeout when applicable |
| Test Files | One row per case/file: required/optional status, referenced steps, purpose, source/provenance, file version, byte size, SHA-256 hash, handling/extraction instructions, actual ADO attachment ID/URL and linked item ID, uploaded/verified UTC, download verification result, missing-file/upload blockers, and approved alternatives. Record a reason for cases needing no files. |
| Execution Plan | Per case/configuration: environment, tenant/identity role, data version, OS/browser/client/service versions, feature flags, dependencies/mocks, approved/proposed schedule and time zone, trigger, estimated/measured runtime, timeout/retries, isolation/parallelism constraints, cleanup strategy, diagnostic retention, alert/triage owner, and readiness validation evidence |
| Coverage | Source ID/revision and atomic requirement or bug condition, plain-language behavior, risk/category, mapped case IDs and assertion/step references, disposition/reason, coverage depth, implementation/execution evidence, residual risk, and follow-up owner/action |
| Sources | Full source manifest and exact baseline, including relevant section/frame/node IDs, query scope/count limitations, inaccessible sources, approvals, and retrieval timestamps |
| Decisions and Changes | Exclusions, conflicts, unresolved questions, owner/next action, review date, accepted-risk approval if any, case revision history, publication results, and added/changed/retired changes since the prior baseline |

If an Excel-generation capability is unavailable, state that the workbook deliverable is blocked and provide labeled interim tables/CSVs without claiming they are a completed workbook. Keep detailed steps in the Steps sheet rather than reducing the document to a title-only case list.

## 3. Human-Readable Coverage and Decisions Report

Produce a readable HTML or Markdown report with these sections in order:

1. Executive summary: what was reviewed and changed, target build and baseline, generation UTC, selected case count versus ceiling, reused/new cases, cadence/readiness counts, highest residual risks, and approvals/actions needed. Clearly distinguish design work, ADO publication, automation implementation, and real execution.
2. Source inventory and trust: source types/links/revisions, approved versus draft material, applicability to the build, accessible/reviewed/partial/blocked counts, query limits, template verification, and missing evidence.
3. Selected regression protection: plain-language journeys, why each risk deserves E2E protection, linked case/ADO IDs, relevant bug conditions, cadence rationale, configuration/execution counts, runtime estimates versus measurements, and excluded permutations.
4. Coverage and gaps: account for every reviewed atomic requirement, checklist item, and bug. Show behavior, source, risk category, mapped cases/assertions, selection disposition, coverage depth, readiness, and latest execution evidence. Explain exactly what each case does and does not prove.
5. Not covered and why: specific reason, impact/residual risk, recommended alternative layer or manual check, mitigation/decision owner, next action, and review date. Highlight uncovered high-impact risks rather than burying them in counts.
6. Automation operations: admission evidence, proposed versus active schedules, budgets, environment/data dependencies, flakiness/quarantine, retries, diagnostics, triage routing, and blockers to unattended execution.
7. Versions and iteration changes: run/artifact/case/source revisions, product and service build IDs, flags/configurations, UTC timestamps, baseline comparison, stale-source warnings, and changed/retired cases with reasons.
8. Publication and quality review: real ADO results and links, required test-file attachment completeness and verified links/hashes, missing files or approved alternatives, workbook/report links, partial failures, unresolved questions/conflicts, required approvals, and checks actually performed versus blocked checks.

Use separate dimensions rather than one misleading "Covered" label:

- Selection disposition: Selected, Reused, Deferred, Excluded, Not applicable, or Unassessed. Every non-selected entry needs a reason; duplicate behavior should link to the retained case rather than imply an uncovered risk.
- Designed coverage depth: Full, Partial, None, or Unknown, relative to the stated atomic behavior and configurations. Design coverage is not execution evidence.
- Automation lifecycle: Designed, Automation ready, Implemented, Validated, Scheduled, Quarantined, or Retired.
- Latest execution: Passed, Failed, Blocked, Skipped, Not run, or Unknown, with exact build/configuration/time and run link where available. A past pass or another build/configuration does not prove current protection.

Provide design coverage and validated scheduled protection separately. For any percentage, show numerator, denominator, unit, exclusions, and baseline. Use distinct atomic requirements as the denominator, not cases or repeated source mentions; deduplicate equivalent requirements while retaining all source links. Report bug-condition coverage separately. Display unassessed/inaccessible population limits alongside percentages and do not claim full coverage of unknown content. Evaluate protection per build/configuration and approved freshness window; unknown freshness policy means current protection is unverified.

Write for human reviewers: expand acronyms at first use, use short explanations and concrete user outcomes, provide legends, and link each summary claim to detailed evidence. Do not use opaque codes or generic "not covered" statements without explanation. A blocked or unimplemented test is not a product failure, and a design-only case is not active regression protection.

# Final Acceptance Checks

- The selected set is minimal, within the ceiling or explicitly approved, and has no duplicates hidden across sources, configurations, cadences, or reruns.
- Every selected case has source-backed expectations, a distinct risk, E2E justification, concrete steps/results, fixture and cleanup requirements, and visible readiness/cadence decisions. Missing required information is labeled and cannot qualify as ready.
- Every reviewed source item has a traceable disposition; partial and unavailable sources remain visible without invented coverage. Conflicts and high-risk gaps have an owner or an explicit owner-needed action.
- The actual template and destination are verified before publishing. Mandatory values are complete; created/updated items are read back; drafts and partial failures are labeled honestly.
- Every case's required test files are manifested, attached to its ADO item, and download-verified against recorded byte sizes and SHA-256 hashes, or an explicit user-approved alternative is recorded and access-verified. Cases with no required files have a reason. Missing files or failed attachment verification prevent a claim of publication completeness or automation readiness.
- The three deliverables agree on IDs, case revisions, source baseline, build/configuration, timestamps, publication states, and counts. All cross-referenced IDs resolve and no orphan steps or mappings remain.
- The workbook opens as valid Excel, has the required sheets and complete step pairs, readable layout and working links. Inspect representative short and long cases. If validation cannot run, disclose it rather than claim readability was verified.
- Coverage calculations reconcile with their denominators; proposed tests, lower-layer recommendations, quarantine, and stale runs are not counted as current scheduled protection.
- No unsupported behavior, fabricated builds/ADO IDs, exposed credentials, or claimed executions without evidence appear. List remaining blockers and actionable next steps.

# Public Guidance Used

These references inform documentation and automation quality; they do not override internal product requirements or the supplied ADO template.

- Microsoft Learn: Create and manage test cases (`guidance.ADO_TEST_CASE_GUIDE_URL` in [generateE2E.config.json](generateE2E.config.json)): action/expected-result steps, requirement/bug links, configurations, and shared steps.
- Playwright: Best practices (`guidance.AUTOMATION_BEST_PRACTICES_URL` in [generateE2E.config.json](generateE2E.config.json)): user-visible outcomes, isolation, controlled dependencies/data, resilient locators, condition-based assertions, and CI diagnostics. Apply equivalent principles in the team's actual framework; this prompt does not mandate Playwright.