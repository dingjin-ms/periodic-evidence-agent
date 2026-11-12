# OA Local CLI / Agency Remote comparison

The frozen paired sample and one separately frozen Remote follow-up completed on
2026-10-30. Both used the same OfficeAgent base, approved evidence bytes, task,
write scope, native skill, gates, `gpt-5.6-sol`, `medium` reasoning, and
`default` context.

## Results

| Sample | Initial gates | Repairs | Final result |
| --- | --- | ---: | --- |
| Local Copilot CLI paired arm | Passed | 0 | Fitness, fresh review, final gates, and controller acceptance passed. Candidate `6eb7d5520e3950610217332c5dee10f53651162d`. |
| Agency Remote paired r3 | Compile/policy passed; integration 2/4 | 2 | Integration remained 2/4; later phases were not reached. Final candidate `45361a524a30731fa4336eef0a5eeaabc036c60f`. |
| Agency Remote follow-up r4 | Passed 4/4 | 0 | Fitness, fresh review, final gates, and controller acceptance passed. Candidate `2c9b70722bd01c895f8267ecf82e1cfe6058f417`. |

r3 observed `CustomSkillsPackageResponse` on the wrong harness surface. Its
follow-up diagnostic told r4 to independently inspect the request ticket returned
by `dispatchInboundMessage` and its `frames()` messages. r4 then passed naturally
on its first candidate; no failure or repair was manufactured.

## Conclusion

The original strict paired sample remains Local pass / Remote fail and does not
establish general superiority. The separately frozen, diagnosis-informed r4 proves
that Agency Remote can complete this exact native workflow end to end with zero
candidate repairs. It is not a blind replacement paired arm and must not be mixed
into the original paired speed or cost statistic.

## Controls and deviations

- r8 remains qualification-only and is excluded from comparison statistics.
- Historical synthetic, Local SDK, and remote-authoring/local-gates results remain excluded.
- r3 and r4 each submitted exactly one Remote job; no job was resubmitted.
- r4 used controller `72a2dfb59c5d3a2726bf09dca251d3a91dd53ff1` for its frozen pipeline and final acceptance.
- The first local acceptance attempt used Node 26 and failed before sealing because that runtime removed `stripTypeScriptTypes(..., { mode: 'transform' })`. The same job was resumed with SHA-256-verified Node `24.22.1`; no Remote work reran.
- PEA compatibility fix `74a4eedb84c09abf610545b0a9f07f9e685d262b` is separate from r4 evidence and is not required to accept r4.
- No product PR, merge, recurring task, SDX work, or AL work occurred.

See `paired-metrics.json`, `evidence-index.json`, and `recovery-state.json` for
timings, raw evidence, usage, limits, and terminal recovery state.

`original-machine-artifact://` entries identify the preserved private artifact
namespace on the execution machine; they are evidence locators, not download URLs.
