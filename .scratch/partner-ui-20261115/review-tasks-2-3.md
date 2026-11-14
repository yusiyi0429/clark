# Independent review — Tasks 2 and 3

Reviewed the current source on `codex/partner-ui-20261115`, the design/plan, both task reports, submitted diff, CSS and behavior tests. Read-only review: no production edits, commits, browser control or visual acceptance. The final Task 2 source uses `monthDayTime(change.confirmedAt)` with 北京时间; the earlier UTC formatter is no longer present.

## Verdict at review

- **SPEC: changes requested.** Feed contracts, schedule separation, disclosure, historical receipt routing and deep-link handling match the design. The newly unified timeline still sorts valid mixed-offset timestamps lexically (F1), and a meeting needing confirmation promotes transcript reading instead of its required next step (F2).
- **QUALITY: changes requested.** Both findings have narrow remedies. No additional high-severity issue was found in the scoped hooks, delivery authorization payloads, retry/record error behavior or CSS. Mechanical evidence does not establish visual acceptance.

## Findings

### F1 — P2: mixed-offset events can appear in reversed chronological order

- **Location:** `apps/web/src/components/work/WorkTimeline.tsx:32`; newly exercised by `PartnerMeetings.tsx:104–112` preserving the original `item.at` as required.
- **Reproduction:** let adjacent messages be `2026-11-12T23:00:00Z` and `2026-11-13T02:00:00Z`. Insert meeting `at=2026-11-13T08:00:00+08:00` (actual `00:00Z`) and handoff `at=2026-11-13T01:00:00Z`. Both belong after message index 0. The current `localeCompare` sorts handoff then meeting, so the later event appears first. This also occurs with no messages or untimed historical messages, where all blocks share one bucket.
- **Evidence:** a read-only Node reproduction using the production comparator and timestamp-bucketing rules returned `[handoff(01:00Z), meeting(00:00Z)]`; parsed instant order is `[meeting, handoff]`. Task 3 explicitly tests preservation of an offset timestamp, so UTC-only sorting cannot be assumed by this feed contract. The helper predates this task, but is material to the new unified feed acceptance.
- **Minimal remedy:** sort valid `TimedBlock.at` values by parsed instant while preserving original timestamp strings and stable keys. Add a meaningful pure `placeBlocks` regression with both offsets within the same message gap. Root owns this shared file.

### F2 — P2: a meeting requiring confirmation promotes an action that cannot perform it

- **Location:** `apps/web/src/components/home/PartnerMeetings.tsx:192–196`, specifically `firstRecord` before the meeting route; actual source scenario in `apps/api/src/partnerMeetings.ts:79–82,157–178`.
- **Reproduction:** provide a real meeting with `stage="ready"`, `needsAction=true`, `statusText="记录已到 · 3 条待你确认"`, a valid meeting route and `recordHref`. This is the API's normal result when real meeting text exists and the current person has pending meeting-card confirmations. The prominent action becomes 查看记录. It only opens `RecordText`, an inline transcript reader without the confirmation controls. The action needed to address the visible status remains reachable only through the title link. The API's 会后整理失败 case with real text has the same priority mismatch.
- **Impact:** the new card's highlighted next action does not lead to the work it says needs the person. This conflicts with Task 3's current-next-step goal despite preserving the route somewhere in the card.
- **Minimal remedy:** before `firstRecord`, prefer the real meeting route when `item.meetingId && item.needsAction`, with a truthful generic label such as 打开会议处理. Keep all transcript controls in 来源与详情 and preserve join/unmatched organization precedence. Add a ready + needsAction + readable-record regression, since the existing attention test has no record and misses this case.

## Confirmed behavior and boundaries

- `usePartnerMeetingFeed` obtains the existing provider once, uses `partner-meeting:<id>` / literal `item.at`, and excludes every `scheduled` item from blocks. Both future external calendar and internal appointments live in collapsed 会议安排. Overdue source objects still marked scheduled intentionally remain arrangements, as documented.
- `useMeetingWorkHandoffFeed` uses `meeting-handoff:<confirmationRef>` / literal `confirmedAt`. BuddyView calls each feed once and merges their blocks into one WorkTimeline; compatibility wrappers consume the same respective hook, without also being mounted in BuddyView.
- Confirmed content, three independent receipt counts and next-action text remain visible. Pending/failed receipt details initially open, all-delivered details and provenance initially collapse. Failed retries submit the same target, instruction, confirmation revision and explicit `authorization: continue`; rejected retries retain failed receipts and expose the reason.
- Delivered history links derive from `receipt.target`, independent of current selectable target options. Missing/completed targets are not reinserted into choices. Route helpers encode IDs and choose the original project/task-info/card/topic route. End-to-end authorization/navigation for a real historic object remains unobserved.
- Record errors are displayed as read errors with retry and do not relabel the meeting as running. Provider reload/authorization behavior is preserved. Network integration and server permission changes are covered only by mocks/source inspection in this review.
- Minute deep links preserve encoded identity, expand ancestor native details before focus/scroll, support hashchange and keep the target focusable with `tabIndex=-1`. Handoff deep links reveal source/receipts and focus the corresponding article on initial mount/hashchange. SSR and custom hook-runner tests cannot prove actual browser focus behavior.
- CSS uses semantic tokens, wrapping/min-width constraints and 44px principal/disclosure/mobile controls. No fixed card width or animation was introduced. Actual 320px rendering, dark contrast, touch hit testing, native details behavior, screen-reader announcements, screenshots, clicking and human comprehension remain unverified.

## Verification performed

No repeat of the already reported passing suites/typecheck was needed for this read-only review. Inspected actual tests and reports: Task 2 reports 17 related tests, followed by 11 handoff tests after timezone correction and typecheck 0; Task 3 reports 101 related tests and typecheck 0. These are implementer-reported results, not independent browser evidence. The independent Node comparator reproduction above was the only additional execution.

No OpenViking search/read tools are registered in this worker runtime, so no Experience retrieval was available.
