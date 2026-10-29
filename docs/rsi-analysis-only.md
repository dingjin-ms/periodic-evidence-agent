# Analysis-only RSI

`runAnalysisOnly` in `src/rsi-analysis-only.js` accepts an immutable manifest,
an evidence-ID-to-bytes object, and an explicitly supplied tool-free reasoner.
It snapshots bytes, checks digests and producer bindings, constructs the prompt,
records the exact supplied/read projections, and validates citations and at most
three proposals. `createAnalysisInput` exposes only ID-based reads of bound bytes.
It has no filesystem paths, SQL, network, ledger, authoring or workspace APIs.

Evidence is copied into owned bytes, including ArrayBuffer inputs. Existing
Buffer conversion semantics apply to other inputs (including typed-array views).
SharedArrayBuffer and its views are rejected: concurrent writes cannot guarantee
a coherent snapshot. Malformed UTF-8 fails before invoking the reasoner. Valid
UTF-8, including a leading BOM and non-ASCII text, retains exact bytes and text.

The manifest separates broad app status from selected source coverage. Components
declare available, missing or skipped status; evidence separately declares
availability and whether supplied. Missing/skipped components require reasons.
Source artifact digests are provenance assertions by the caller; the pure
resolver validates supplied projection bytes, not inaccessible raw sources.
The host must verify source provenance and sanitize inputs before calling.
Hashes attest supplied bytes, not model comprehension or truth of findings.

`createAnalysisResponsesReasoner` is a separate adapter for an explicitly selected
existing Responses host. It sends `tools: []`, `tool_choice: none`, `store: false`,
accepts no source-fetch or authoring tools, and performs no retries. The host
must supply an awaited `persist(record)` callback that durably writes private
records in a separate analysis output directory. The exact HTTP body is recorded
before parsing, HTTP/status checks or output validation; decoded text and available
status/model/response ID/usage are recorded before model JSON parsing. Network or
body-read failure records explicitly unknown response/usage. No headers, auth
configuration or transport diagnostics are recorded. Persistence failure stops
acceptance. Raw records must not be attached to public reports.
If transport/body reading and persistence both fail, the fatal error retains
in-memory `analysisResponse` context with requested model, timestamps, any known
HTTP status, unknown body/usage and `persistence: 'failed'`. This is not a durable
receipt. Diagnostic text from these failures is not reflected in that error.

The request uses Responses `text.format` strict `json_schema`; unsupported hosts
fail without retry or provider fallback. Prompt wording is not a guarantee.
Fences, malformed JSON, refusals and tool output fail without text repair. The
existing independent result/provenance/citation validator remains authoritative.
`error.analysisResponse` preserves returned payload and metadata on parse and
result validation failures; `error.analysisContext` preserves the prompt and
actual projection read trace. Hosts must persist final success/failure receipts
too. Counts alone support only aggregate coverage analysis: skipped Proposer,
absent detailed reasoning and unknown historical usage are not a full cycle.

This API does not invoke `runRsiPending` or update controller historical state.
It does not prepare candidates, create branches, author improvements, publish
or adopt anything. A proposal is an analysis result only. No CLI integration or
autonomous adoption loop is installed.

Focused validation: `node --test --test-reporter=tap test/rsi-analysis-only.test.js`.
