# Task 3 — preregistered expectations

Before implementation, expect the new meeting feed contract tests to fail because `usePartnerMeetingFeed` does not yet exist. Non-scheduled items must produce `partner-meeting:<item.id>` blocks at the exact original `item.at`; scheduled items must appear only in native `会议安排` details, including future external calendar items. Existing provider, home grouping and original join/record/organize permissions remain the source of truth.

Behavior checks will catch a missing minute anchor, an ancestor details panel left closed on `#minute-<token>`, focus occurring before expansion, future appointments entering the timeline, or an attention/record read error being relabelled as processing. Tests use the existing Node/Vitest setup: SSR for real rendered output and a narrow hook runner for effects and click/state transitions, with fetch mocked only at the network boundary.

Ruling: all `scheduled` items, including overdue items that remain scheduled in the source, stay in the schedule disclosure. No synthetic event time or state transition is introduced. Cost if wrong: an overdue appointment remains in arrangements until the service updates its actual stage.

Installed Next client-component and `use client` guides were read before editing. No dependency or API change is planned. Browser, actual 320px layout, dark rendering and human comprehension remain unverified without browser observation; CSS and SSR checks will be reported as mechanical checks only.

## Results

- RED: the 5 new cases failed against the original implementation with `usePartnerMeetingFeed is not a function`; all 5 original cases passed. This confirmed the missing public feed contract before implementation.
- GREEN: `pnpm --filter @warmap/web test src/components/home/partnerMeetings.test.tsx` passed 10/10. New cases verify literal stable keys, unmodified timestamp strings (including a non-UTC offset), future calendar/meeting exclusion from blocks, a collapsed native schedule, unmatched and scheduled minute identity anchors, ancestor expansion before focus/scroll, true attention status, secondary source disclosure, and a record 403 followed by successful retry.
- Regression: `pnpm --filter @warmap/web test src/components/home/partnerMeetings.test.tsx src/lib/home/meeting.test.ts src/components/meeting/meetingBooking.behavior.test.tsx src/components/meeting/meetingRecordCard.behavior.test.tsx src/components/meetingFollowThrough.test.tsx` passed 5 files / 101 tests.
- `pnpm --filter @warmap/web typecheck` exited 0.
- `git diff --check` on the 3 owned source/test files exited 0.

The hook shares the original provider. The compatibility wrapper reuses it. Home grouping, booking, minute attachment, record authorization/error mapping, original object routes and network APIs are unchanged. Cards now make join, organize, read, or open-meeting the single prominent action; native `来源与详情` preserves all source/record/preflight entries. The true `statusText` remains visible, with attention styled through semantic danger tokens. Primary controls and native disclosure summaries have a minimum 44px height at all widths, while existing mobile controls retain their larger targets.

## Limits and integration ownership

No browser or UI-control tool was used or installed. SSR and a synchronous hook runner validate markup and effect ordering, not actual browser layout, native details/focus behavior, screen-reader announcements, touch hit testing, dark contrast, or human comprehension. Those remain unobserved. CSS uses semantic tokens already defined for light/dark themes, wraps long titles/status/errors and adds no motion or fixed card width; existing CSS checks remain mechanical evidence only.

The scheduled minute fixture deliberately keeps the `feishu-minute:` identity while the stage is `scheduled`: it guards the anchor and ancestor-expansion contract if a source state update moves an object into the header arrangements. It does not claim the current backend emits that combination.

Only the three assigned source/test files and this report were edited by this task. Full workspace test-suite validation belongs to root integration after the parallel module edits settle; the scoped results above do not claim a complete workspace suite pass. No commits or pushes were made.

## Review follow-up — preregistration

R2/F2 were read against the current source and API mapping. The prominent transcript shortcut currently precedes `meetingId && needsAction`, although the inline reader cannot confirm cards or retry failed meeting organization. Expect new ready/pending-confirmation and attention/failure fixtures with readable records to fail: their first action must route to the original meeting as `处理会议事项`. A ready record with no required action must keep `查看记录`. Join and unmatched-organization precedence, status text and secondary record access must remain intact.

The schedule now lives in a nonshrinking header. Apply a body-only bound to `.later > .rows` (`max-height: min(30dvh, 240px)`, vertical scrolling, scroll containment); the native summary stays outside that region. This is a reviewed source-level containment fix, not a browser geometry pass. Only scoped tests/diff validation will be run here; root owns the in-progress full suite.

### Review follow-up — results

- RED: `partnerMeetings.test.tsx` reported 3 failures / 10 passes: both new action+record cases rendered the transcript button instead of the required meeting link, and the prior failure case retained the old generic action. The ready/no-action reading case already passed, characterizing the behavior that must remain.
- Implemented priority: join → unmatched organization → real meeting requiring action (`处理会议事项`, original `item.href`) → transcript reading → ordinary meeting/calendar route. Source details still expose the record reader, and `statusText` is unchanged.
- Added the body-only `.later > .rows` maximum height, vertical overflow scrolling and overscroll containment; direct summary retains its own 44px control outside the scrolling body. Source inspection confirms the selector targets the rendered immediate `ul`, rather than the whole disclosure.
- GREEN: `pnpm --filter @warmap/web test src/components/home/partnerMeetings.test.tsx` passed 13/13 after the two fixes. The new cases cover ready/pending confirmation plus record, attention/failure plus record, and ready/no-action retaining reading as the prominent action. Existing schedule exclusion, deep links, record retry, join truth and home cases still pass.
- `git diff --check` on the three owned files exited 0. No full-suite/typecheck rerun in this follow-up, per root instruction while integration validation is running.

The schedule fix remains source-level evidence: actual 320px geometry, native scrolling/focus and touch behavior are still unobserved. No browser workaround, dependency, API change, commit or push was introduced.
