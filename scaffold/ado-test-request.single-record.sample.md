## SuperApp creates a single-record Excel table

A synthetic test-onboarding request, not an observed product defect. This is a
better first authoring candidate than the separate formula-preservation sample:
the existing cross-app verifier supports these structural assertions. Live
FILTER accepted the corresponding request; that does not establish a live pass.

| Field | What users fill in |
| --- | --- |
| Starting context | Standard starting state: a new AAD conversation in SuperApp / M365 Copilot BizChat. No workbook is open or attached. |
| Input files / data | Agent may create synthetic inputs. No attachment or private data is required. |
| Steps / prompts | Ask: Create an Excel workbook with sheet 'Intake' and that contains a 2x3 table (contains header). After completion, the test driver opens the generated file and checks the preview; do not ask Copilot to perform that UI action. |
| Expected result | Task completion, an xlsx artifact, and an interactive Excel preview. Saved workbook: worksheet Intake with one matching 2-by-3 Excel Table, headerRowCount=1, one data row, totalsRowCount=0, and nonempty text headers. Header wording and data values may vary. Response prose is not proof. |
| Constraints / special rules | The minimum nonempty-table boundary is exactly one data row, not the existing five-row samples. Do not modify existing files. No formulas, exact values, upload, or existing-workbook editing is requested. |

Use a distinct L3 case with the current BizChat composites and reversible
settings cleanup. Keep the prior formula-preservation request separate; this is
not a weakened assertion set for that request. Native discovery, external
lifecycle registration where required, and real local execution remain delivery
gates. Do not count standalone JSON-schema validation as native E2E validation.
