# Scoped re-review — Tasks 2 and 3

Compared current meeting TSX/CSS/tests directly with `versions/v1/src`, and compared current `WorkTimeline.tsx` / `work.test.tsx` with the Git baseline. Inspected the updated Task 3 report and new regressions. No production changes, commits, browser control or repeat test suites were performed.

## Verdict

**F1: ADDRESSED. F2: ADDRESSED. No fix-induced blocker found.** The original code-review requests are resolved at source/behavior-test scope. Browser and visual acceptance remain unverified.

## F1 — ADDRESSED: mixed-offset chronology

- Current `apps/web/src/components/work/WorkTimeline.tsx:32–39` parses each timestamp and orders finite instants numerically, so the original reproduction now orders the meeting at `2026-11-13T08:00:00+08:00` (`00:00Z`) before the handoff at `2026-11-13T01:00:00Z` in the same gap.
- Equal valid instants compare as zero and retain input order under stable array sorting. Invalid timestamp ordering is deterministic in the comparator (valid first, invalid lexically); existing bucketing behavior is unchanged. Contract-provided meeting/handoff timestamps are valid date-time strings.
- The sort carries original block objects. It does not rewrite `at`, keys, nodes or `afterSequence`. The existing message-gap/sequence placement branches are unchanged.
- The two added `work.test.tsx` cases cover untimed historical messages and a real shared message gap, including equal instants written with different offsets. Root reports both cases failed before the fix and all 40 tests passed after it. No concrete reason to repeat the suite arose in this re-review.

## F2 — ADDRESSED: prominent action for required meeting work

- The sole TSX difference from the v1 snapshot is the new `item.meetingId && item.needsAction` branch at `apps/web/src/components/home/PartnerMeetings.tsx:194`, before transcript reading.
- Ready meetings with pending confirmations and attention/failure meetings with readable records now prominently render `处理会议事项`, linking to the original `item.href` through the existing navigation handler.
- Join and unmatched-organization branches still precede this condition. Readable records with no required action still promote `查看记录`. All source/record controls remain in the unchanged secondary disclosure; status text, record retry, deep-link effects and feed keys/timestamps are unchanged.
- Inspected the new ready/action+record, attention/action+record and ready/no-action cases, as well as the updated prior failure assertion. The report records 3 failing cases before the fix and 13/13 passing after it. No concrete reason to repeat the suite arose.

## Schedule containment and fix-induced regressions

The only CSS difference from v1 is `.later > .rows { max-height: min(30dvh, 240px); overflow-y: auto; overscroll-behavior: contain; }`. `MeetingRows` renders the immediate `ul.rows` under the native details, so this selector bounds the schedule body while leaving the 44px summary outside the scrolling region. It also applies to the existing later-appointments disclosure, whose children have the same shape. The fix introduces no fixed card width, action removal, timestamp/key change or new data fetch. No fix-induced breakage was found by source/diff inspection.

Actual small-screen geometry, native scroll/focus behavior, touch operation, dark rendering, screen-reader behavior and human comprehension remain unobserved. Reported passing tests and this independent source review do not establish those outcomes.
