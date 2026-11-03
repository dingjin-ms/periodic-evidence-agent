## Preserve formulas while removing duplicate records

Synthetic sample request, not an observed product bug. Use the Automation area
and `AgenticTestRequest` tag from the template. This exercises a concrete oracle
without external files or private data.

| Field | What users fill in |
| --- | --- |
| Starting context | Standard starting state: an open workbook with a table containing headers Item, Quantity, Unit price, Total. |
| Input files / data | Agent may create synthetic inputs. Rows: Pen, 2, 3; Pen, 2, 3; Book, 1, 12. Total contains a row-relative Quantity * Unit price formula, not a constant. |
| Steps / prompts | 1. Ask: Remove duplicate records, keeping the first occurrence and preserving all formulas. 2. If asked to confirm, answer Yes. |
| Expected result | Exactly two data rows remain in original order: Pen, 2, 3, 6 and Book, 1, 12, 12. Each Total cell remains a formula referencing its own row. Formula spelling may vary; numeric constants are not acceptable replacements. |
| Constraints / special rules | Duplicate means equality of Item, Quantity and Unit price. Preserve headers, surviving row values, formulas and the original workbook. Do not create another workbook or modify unrelated cells. |

Candidate acceptance requires repository inspection showing this assertion is
missing and supported by the selected harness. A real product test must check
formula identity and evaluated values, not only model prose or row count. If
coverage already exists, report the link; if current product behavior is broken,
hold for product-fix ownership rather than weakening the test.
