# Whole-branch final review — partner workspace

Reviewed baseline `a1f365a1` against the current `codex/partner-ui-20261115` implementation, design/plan/progress, both iteration notes, task reports, earlier reviews and re-review, submitted final diff, actual affected source/callers and the untracked production CSS and three test files. This was read-only production review; no code changes, commits, subagents, browser automation or duplicate test suites. The final handoff textarea token correction was inspected after it landed.

## Verdict

- **SPEC: NEEDS FIX.** The major feed, disclosure, historical routing, queue and status requirements are present, and all four earlier P2 findings are addressed. One cross-module state-preservation regression remains (F3).
- **QUALITY: NEEDS FIX.** Stable block keys do not preserve component identity across different message parents. The new placement can silently discard an in-progress handoff instruction and repeat deep-link focus during an unrelated conversation update.

## F3 — P2: appending untimed history remounts the newly integrated meeting and handoff cards

**Changed integration:** `apps/web/src/components/home/Conversations.tsx:168`. Supporting placement/rendering: `apps/web/src/components/work/WorkTimeline.tsx:29–41,75–95` and `apps/web/src/conversation/Transcript.tsx:356–367`.

**Concrete reproduction:** Load a buddy conversation containing at least one message without `createdAt`, plus a confirmed handoff. Open “添加工作去向” or “选择工作去向”, select a destination and type an instruction. Let another conversation message arrive (for example, the queued partner turn completes and history refreshes). The handoff block moves from the previous last message's `after` slot to the new last message's slot. Its ancestor changes from keyed Fragment `turn-0` to `turn-1` in the one-to-two-message case. The identical `meeting-handoff:<ref>` key is local to each parent; it does not move the mounted component across those parents. `ChangeRow` and its `TargetPicker` remount, resetting `choosing`, selected destinations and instruction text. An open `MeetingRow` record reader likewise closes. With an unchanged `#meeting-work-<ref>` hash, the mount effect reveals and focuses the handoff again.

**Why this is a supported scenario:** `placeBlocks` explicitly sends time-based blocks to `messages.length - 1` whenever any message is untimed. Existing `work.test.tsx:337–345` covers that fallback, including a single newly sent untimed message among timed history. `pendingUserMessage` omits `createdAt` (`useConversation.ts:109–114`), and API history deliberately omits it when neither the source message nor run has a time (`apps/api/src/chatService.ts:129–130`). Handoff selection/instruction state is component-local (`MeetingWorkHandoffs.tsx:73–80,139`). Before this branch the meetings and handoffs were standalone siblings after WorkTimeline; appending chat messages did not change their parent.

**Evidence limit:** This is a deterministic source/reconciliation finding, not an observed browser session. The bucket and keyed-parent transitions follow directly from the production code. The existing mocked BuddyView SSR composition test checks one render and cannot detect a remount or lost interactive state. No live Feishu or browser interaction is claimed.

**Minimal remedy:** Preserve a stable React parent for interactive blocks as message buckets change. A stable trailing outlet can address the untimed-history fallback while retaining its current order; a flat sequence of keyed message/event siblings can address arbitrary bucket transitions. Do not fix this by fabricating event times or suppressing explicit hash navigation. Add a focused lifecycle/identity regression that opens a handoff picker, enters instructions, appends an untimed history row, and verifies the same card/picker state remains and hash focus is not repeated. Preserve existing `afterSequence` and numeric-time ordering behavior.

## Earlier findings verified as addressed

- Reply deep-link data updates now skip an already resolved anchor using `locatedReply`; explicit hash navigation resets the guard and unresolved late targets remain retryable. The unrelated-B regression is present in the new behavior file.
- The schedule list is bounded by `.later > .rows`, with scrolling on the body and the summary outside it. This resolves the source-level unbounded-header finding; actual narrow/short-viewport geometry remains unobserved.
- WorkTimeline sorts valid timestamps by parsed instant, preserving original objects and stable equal-time order. Sequence placement branches are unchanged.
- The prominent action for a real `needsAction` meeting precedes record reading and routes to the original meeting. Join/unmatched precedence and no-action record access remain intact.

## Cross-module checks

- One WorkTimeline receives team, work, occurred-meeting and confirmed-handoff blocks. Scheduled meetings stay outside occurred blocks. Each feed hook is mounted once in BuddyView; compatibility wrappers are not also mounted there. Meeting data still comes from the shared provider. No additional duplicate fetch/event subscription was found from the hook extraction.
- Original durable submission logic, viewer checks, stable request/attachment receipts, retry payloads and API endpoints are unchanged. The queue serializes its UI mutations and retains retry/priority/cancel eligibility. Project queues also move to the same measured InputBar dock and remain absent for nonlive/read-only input.
- Queue dock is inside the InputBar root observed by ResizeObserver. ChatColumn reserves the measured composer height; the queue body itself is bounded and scrollable. This is correctly connected at source level.
- Delivered historical handoff links derive from the receipt target even when current options are missing; no historic object is reinserted as a new delivery choice. Failed/pending retries keep original target, instruction, revision and explicit continuation authorization.
- Team recipient status/error and actionable reply/clarification/retry remain outside collapsed histories. Source/attachment/forward paths remain reachable. Existing API limitation for an unloaded reply-only hash is documented and not a new regression.
- Running, rework and real waiting are counted separately. Existing acceptance-rework wording is retained. Receipt statuses and record-read failures are not relabeled as completed work or running work.
- Native disclosures, programmatic focus targets, focus styles, wrapping and principal 44px controls are present. The final handoff textarea now uses `--field-*` color, border, font, padding, radius, caret and focus-ring tokens, `resize:none`, and no longer inherits the generic two-pixel control outline. No additional concrete semantic/CSS blocker was established.

## Verification boundary

Root reports selected tests passing (team 19, meetings 13, handoff 11, work 40, status/draft/queue 14, integration 1) and final semantic typecheck exit 0. The first full web run was 2551/2553, with two field-style policy failures; their CSS-only fix is now present and root reports the targeted CSS group passing 24 tests. The post-fix full-suite rerun remains root-owned and pending at this review's write time. No already-reported suites were repeated here.

These source, SSR and controlled callback checks do not certify actual screenshots, phone/320px geometry, browser focus/scroll behavior, screen-reader experience, theme contrast, live Feishu, real authorization/navigation, or human preference and task success. Top-quality visual/user acceptance remains unverified, independently of F3.
