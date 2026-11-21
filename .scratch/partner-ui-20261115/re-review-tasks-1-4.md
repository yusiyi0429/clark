# Scoped re-review: Tasks 1 and 4

Review date: 2026-11-15. Re-reviewed only R1 and R2 from `review-tasks-1-4.md`, against current production source, the v1 source snapshot under `.scratch/partner-ui-20261115/versions/v1/src/`, changed behavior coverage, and the Task 1/3 follow-up evidence. No production edits, commits, repeated suites, or additional open-ended audit.

**SPEC: PASS for the two reviewed corrections. QUALITY: PASS for the two reviewed corrections.** Both prior findings are addressed at the evidence level described below. These verdicts do not convert mechanical/source checks into browser or visual acceptance.

## R1 — ADDRESSED

Compared `.scratch/partner-ui-20261115/versions/v1/src/apps/web/src/components/home/PartnerTeamCard.tsx` with current `apps/web/src/components/home/PartnerTeamCard.tsx:135–167`.

- V1 unconditionally retried the active reply hash whenever any reply identity changed. Current source persists `locatedReply` across effect reruns and returns before expansion/focus when that anchor was already located (`:136,147`). Therefore appending unrelated B after locating A no longer reopens A's disclosure or repeats its focus/scroll.
- Only successful location records the anchor, inside the animation callback (`:154–156`). Missing or unowned targets do not set the guard; a late-arriving target still gets another attempt when reply IDs change. A cancelled pending animation also leaves the target retryable.
- Explicit `hashchange` now calls `navigate`, which clears the successful-location guard before trying the new hash (`:159–165`). Leaving and returning to A can focus it again, and malformed/unowned targets retain the prior early returns and cleanup.
- The added test at `partnerTeamCard.behavior.test.tsx:169` covers initial A, manually closed history, unrelated B arrival with unchanged hash, then leaving and returning to A. Existing delayed-arrival coverage is still present immediately above it.

Evidence accepted without rerunning: Task 1 follow-up reports RED 1 failed / 6 passed at the new `history.open === false` assertion before the fix, then GREEN 19/19 across the three scoped team files after the fix. The current source and assertions match that report. No live browser focus/typing observation was performed.

## R2 — ADDRESSED at source level

Current `apps/web/src/components/home/partner-meetings.module.css:40` adds:

```css
.later > .rows { max-height: min(30dvh, 240px); overflow-y: auto; overscroll-behavior: contain; }
```

`usePartnerMeetingFeed().scheduled` renders `MeetingRows` as the immediate `ul.rows` child of `details.later`, so the selector reaches the expanded appointment body. It bounds long/many appointment content and permits vertical scrolling while leaving the summary visible outside that scrolling body. This directly removes the unbounded header-growth cause identified in R2 without moving future appointments into occurred-event blocks.

Task 3's follow-up report confirms the containment change and scoped 13/13 meeting tests plus diff validation. Those tests primarily verify meeting behavior; the containment conclusion here comes from source inspection, not a measured layout test.

## Remaining evidence limits

No browser or browser workaround was used. Actual 320px geometry, combinations of expanded schedule/sub-session summary/queue, keyboard viewport changes, native disclosure and scroll behavior, pointer hit testing, screen-reader behavior, dark contrast, reduced motion, screenshots and human comprehension remain unobserved. Root owns final integrated suite/typecheck results. No unresolved defect remains from this scoped re-review; the original reports' browser/visual acceptance boundary remains in force.
