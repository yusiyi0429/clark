# Scoped final re-review — F3 identity correction

Compared the actual current Git diff against `a1f365a1` for `WorkTimeline.tsx`, `Transcript.tsx`, and `conversationTimeline.test.tsx`; read the new `workTimeline.identity.test.tsx` in full. Rechecked the landed handoff textarea CSS policy correction. No production edits, commits, subagents, browser automation or duplicate test suites. This is one scoped review of the final correction wave.

## Verdict

**F3: ADDRESSED. No fix-induced material blocker found.**

- **SPEC: PASS at source/represented-behavior scope.** The original four fixes and F3 are now addressed. Full final regression/typecheck results are root-owned and pending at this report's write time; visual/device/human acceptance remains incomplete.
- **QUALITY: PASS for the reviewed implementation, within that evidence boundary.** The fix preserves stable component ancestry instead of masking focus effects or manufacturing timestamps. It does not certify top-quality visual preference or task outcomes.

This re-review supersedes the open-F3 verdict in `review-final.md`; that file retains the original finding and reproduction as the iteration record.

## Identity and ordering

`ConversationTurns` now owns one flat `rows` array. Leading insertions (`-1`), message Fragments, interleaved insertions, the optional waiting row and the active streaming Fragment are pushed directly into that same array. There is no per-index insertion array retained as a React parent. Every independent block has a `Fragment` outlet keyed `insertion:<original-key>`; its existing keyed block `div` and actual card component remain underneath that stable outlet. The namespace cannot collide with the existing `turn-N` or `waiting` keys.

`WorkTimeline` passes `blocksAt` through the new optional `insertions` API and no longer emits independent blocks inside message-specific `after` Fragments or a separate leading array. `placeBlocks` still decides placement and numeric instant order, retaining literal timestamps and explicit/null `afterSequence` rules. Only the rendered parent structure changes. Consequently a block's index can change without changing its React key ancestry or component type.

The five new identity regressions inspect actual production element builders and retain array/element boundaries in their comparison. They cover:

- Untimed history growing from one message to two and three.
- Empty history receiving its first untimed message.
- Timed history → optimistic untimed message → timed history.
- Numeric/null anchors sharing and changing buckets, with mixed-offset instant ordering retained.
- Current streaming output appearing and then becoming a settled message.

These assertions would expose the original `turn-N` ancestry change; the implementer reports they failed before the production correction and pass afterward. The fixture leaf is a small component, rather than a mounted production picker. The tests therefore establish the key/type/parent contract, not an observed native form draft or browser focus lifecycle. From that stable React identity, preserving the card's local state and avoiding a mount-triggered focus replay is the expected reconciliation consequence.

## Legacy rendering remains supported

The new API is optional. Existing message markup, model boundaries, carried dividers, report filtering, thought/step props, `footer`, `after`, waiting text and current partial/status/trailing rendering keep their predicates and relative order. Message-specific cards and plans remain inside their `turn-N` Fragment. Streaming output retains `turn-<messages.length>` so the settled turn has the corresponding key.

The existing proposal/stream-settlement regression is retained. The two new transcript cases check collision-safe insertion keys before/after a message and the sequence leading event → message → footer → after → insertion → current reply → status → trailing. Source inspection found no new fetches, event subscriptions, auth changes or submit/retry changes in this correction.

## Theme policy and verification

The final handoff textarea uses the shared `--field-*` font, line, color, background, border, radius, padding, caret, placeholder, hover and focus tokens; `resize:none` is restored. Its focus ring is separated from the generic two-pixel control outline. Principal control sizing remains intact. Root reports the targeted field-style group passing 24 tests.

The fix owner reports 48 targeted tests passing: five identity regressions, three transcript cases and 40 existing work cases. The reviewer did not rerun these or the root-owned broader/final suites. A scoped `git diff --check` on the three tracked correction files exited 0. Final full-web/typecheck status should be taken from root's completed run, not inferred from this report.

No installed browser or DOM reconciler was used, and none was installed or bypassed. This report does not claim observed browser focus/scroll, actual textarea preservation during a native mount cycle, phone/320px geometry, touch, screen-reader behavior, dark-theme contrast, live Feishu or backend authorization/navigation, or human comprehension/preferences. Those remain separate acceptance checks.
