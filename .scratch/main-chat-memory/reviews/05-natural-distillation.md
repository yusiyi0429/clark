# Ticket 05 review

Fixed point: `1c633a1d785fc061400c437b6c41facd510fdee0`.
Initial reviewed HEAD: `8020d46`; corrective checkpoint: `5580549`.
The two independent agents reviewed the Ticket 05 commits; `ccaf842` and `c33f738` are already-reviewed Ticket 04 dependencies.

## Standards

0 findings; worst severity: none. No documented hard violations or actionable baseline smells were found. The worker reuses the structured candidate runtime and keeps durable memory outside Pi; no further abstraction is justified at this size.

## Spec

2 findings, both P1, corrected in `5580549`:

1. A newer explicit cross-scope correction queued at the same epoch was superseded by an earlier explicit correction. The worker now records the last explicit job responsible for an epoch change and re-evaluates a newer explicit intent against the current document using that intent's own raw current message. Manual edits/forget clear this authorization barrier; natural jobs retain their captured epoch. A public worker regression covers two explicit jobs plus manual-forget cancellation.
2. The intent fast path missed deletion and other common correction phrases when the main answer failed. The detector now includes deletion, no-longer preference and do-not-save forms. HTTP regression uses deletion wording and proves the preference is gone despite main-model failure. Every main-private input is now atomically queued for a bounded explicit-intent classifier with the raw user message; the detector controls only synchronous execution. The public arbitrary-wording test proves a failed main answer and worker restart still honor an instruction outside the detector vocabulary.

Root additionally identified and corrected required interactions in the same checkpoint: reuse an existing pool connection all the way through explicit processing; redact private candidate input/output/errors from AgentRun and LangSmith; use the supported ModelRuntime dispatcher for a two-call budget.

Initial totals: Standards 0 (none); Spec 2 (P1). Both concrete Spec findings have regression coverage. No reviewer follow-up was spawned; final PR review will independently inspect corrective hunks.

Final corrective checks: 33/33 focused tests and API TypeScript check passed. Natural-stage removal also creates the same epoch/exclusion barrier, with a red→green delayed-job resurrection regression. The extra explicit classifier is bounded and runs in the background for ordinary messages; its live semantic quality was not evaluated with a production model.
