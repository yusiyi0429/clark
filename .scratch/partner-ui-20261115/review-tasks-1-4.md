# Independent review: Tasks 1 and 4

Review date: 2026-11-15. Read-only production review of the current `codex/partner-ui-20261115` implementation and `review-tasks-1-4.diff`. Reviewed design/plan, both implementation reports, actual integration/callers, the three new test files, and `work-intake.module.css`. No production edits or commits. Existing evidenced suites were not rerun.

## Verdicts

- **SPEC: NEEDS FIX.** Core timeline/disclosure/queue/status requirements are implemented. The newly promoted schedule disclosure has an unbounded body in a nonshrinking header, leaving a concrete narrow/long-content acceptance gap (R2).
- **QUALITY: NEEDS FIX.** Fix the repeat focus on unrelated reply updates (R1), plus the schedule header containment (R2). These are specific interaction/layout counterexamples; no visual quality score is assigned.

## Findings

### R1 — P2: An unrelated new reply reopens and refocuses an already visited reply deep link

**Location:** `apps/web/src/components/home/PartnerTeamCard.tsx:137–162`, particularly unconditional `locateReply()` and the whole-list `replyIds` dependency.

**Reproduction:** Open a loaded card through `#team-reply-A`, allowing the initial expansion/focus. Close its history and move to another textarea or another part of the conversation. When the next poll adds reply B to any recipient of that delivery, keep the same hash. The effect reruns because the joined IDs changed, finds the still-present A, reopens its ancestors, and calls focus/scroll again. This can interrupt the user's current typing/navigation even though their requested reply was already located.

**Evidence:** Executed an isolated reproduction against the actual `PartnerTeamCard.tsx` transpiled with the installed TypeScript compiler, using DOM/hook boundary stubs only. Initial A: `{focuses:1, scrolls:1, historyOpen:true}`. After setting `history.open=false` and appending unrelated B with hash unchanged: `{focuses:2, scrolls:2, historyOpen:true}`. This is mechanical callback evidence, not a browser focus/geometry observation. The existing delayed-arrival test covers unchanged reply identities; it does not cover an additional unrelated reply after successful location.

**Minimal remedy:** Remember that the current hash/target has been successfully located. Data updates should retry unresolved targets only. Reset that guard on an explicit hash navigation so selecting another reply, leaving and returning to the same reply, and late target arrival still work. Add the single missing update case to the existing behavior coverage.

### R2 — P2: Expanded future schedule can consume the entire fixed conversation pane

**Location:** `apps/web/src/components/home/Conversations.tsx:164`; supporting source `apps/web/src/styles/v2-chat.module.css:16–42` and `apps/web/src/components/home/partner-meetings.module.css` (`.later`, `.rows`).

**Reproduction to perform in a browser:** On the 320px layout, provide at least ten future scheduled meetings with long Chinese titles, then expand “会议安排”. Also expand “来源与详情” on a row. Try scrolling the schedule to its later rows and returning to the conversation without closing the disclosure.

**Source-established cause:** The integration now puts the entire schedule disclosure in `ChatColumn.head`. That header is `flex:none`, while only `.log` is the scrolling/flexible region. The schedule list/disclosure body has neither a height bound nor overflow scrolling. Therefore its minimum content height can exceed the fixed pane; the log can shrink to zero, and the absolute composer remains anchored at the pane bottom over that content. ResizeObserver measures the composer, not this growing header. This placement is new in Task 4; the old schedule was within the log.

**Evidence limit:** The layout rules and absence of containment were inspected; no browser was available, so exact viewport thresholds, pixels hidden, pointer reachability, and device keyboard effects were not measured. This is a deterministic unbounded-content layout issue inferred from source, not a claimed visual acceptance test.

**Minimal remedy:** Keep the summary in the header and give its expanded body a bounded scrolling region, following the existing SubSessionSummary/queue approach. Alternatively put the separate future-schedule disclosure inside the scrolling log while keeping it out of occurred-event TimedBlocks. Verify a narrow viewport with long titles and multiple appointments after the fix.

## Checks that support the implementation

- BuddyView uses one WorkTimeline for team/work/occurred-meeting/handoff blocks; future schedules stay outside those occurred blocks. Hooks are each called once.
- Recipient identity/status/error and reply/clarification/retry controls remain outside collapsed history. Reply/source forwarding and attachment handling retain their original call paths. Native disclosure and focus targets are present.
- **Queue measurement is connected correctly.** `ChatInput` passes the queue through `InputBar.dock` (`Conversations.tsx:103`); `InputBar.tsx:54–60,146–147` observes the root containing dock, composer and footer. ChatColumn writes the measured height to `--pane-composer`; `.log` reserves that height plus 44px. The queue is therefore not an unmeasured overlay. Its list has `max-height:min(28dvh,220px)` and scrolling; full text wraps; retry/priority/cancel eligibility is unchanged; busy operations disable queue buttons.
- Running count includes only `state === "running"`. Rework and real waiting are counted separately. Keeping “重做中” follows `subStage`'s established acceptance-rework meaning, rather than inventing a runtime-failure meaning.
- Reviewed new tests are appropriately described as SSR/component/mechanical coverage, with heavy integration/DOM mocks. They do not demonstrate live browser disclosure state, user focus continuity, ResizeObserver geometry, touch, screen readers, theme contrast, or actual narrow-viewport overflow.

## Remaining unverified evidence

The implementer report states 18/18 Task 1 tests passed; root reported 14 status/draft/queue tests passed. Those results were accepted as supplied evidence and not repeated. Integrated semantic typecheck/final suite status remains root-owned. Real screenshots, click-through, 320px/keyboard geometry, dark-theme contrast, reduced-motion operation, and human comprehension remain unverified. A reply-only hash still cannot fetch an unloaded historical delivery because the current API resolves delivery IDs only; that pre-existing API boundary is explicitly disclosed rather than treated as a new regression.
