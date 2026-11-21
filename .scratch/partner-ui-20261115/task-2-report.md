# Task 2: Meeting handoff cards

## Pre-experiment expectation

- Removing the dependency between historical navigation and the current target picker should restore completed-object links without widening delivery authorization or restoring the object to choices.
- Each conclusion should become one timeline block keyed by confirmationRef and dated by confirmedAt. The compatibility wrapper should consume that same hook once.
- Confirmed content, three delivery counts, and a next action should remain visible. Delivered receipts and source provenance should be disclosed on demand; pending and failed destinations should expose their actions immediately.
- Direct and later hash navigation to #meeting-work-<confirmationRef> should expand the target card’s disclosures and scroll/focus it.
- Mechanical checks can establish markup, state transitions, routing, and CSS constraints. They cannot establish actual 320px layout, dark-mode perception, or user comprehension without a browser observation tool.

## Baseline evidence

- Read apps/web/AGENTS.md and installed Next docs: use-client.md and 05-server-and-client-components.md. Retain the client boundary and browser APIs inside effects/event handlers.
- Existing delivered receipt rendering requires a matching currently selectable destination, so a completed destination disappears from navigation.
- Existing wrapper has its own fetch/state and scroll-only initial hash handling; extraction must preserve refresh and retry semantics while adding focus and hashchange support.
- OpenViking search/read tools are not registered in this worker runtime. No Experience was retrieved here.

## Results

- Extracted `useMeetingWorkHandoffFeed(): {blocks: TimedBlock[]; notice: ReactNode}`. Every API conclusion maps to `meeting-handoff:<confirmationRef>` at its original `confirmedAt`. The compatibility `MeetingWorkHandoffs` wrapper consumes this hook once; `MeetingWorkFeedEntry` and confirmation/authorization flows remain available.
- The card foregrounds confirmed content, delivered/pending/failed counts, and next action. All-delivered receipts and provenance are secondary native disclosures. Pending and failed receipts open with per-destination action and failure reason visible. Existing reply instructions, revision and `authorization: continue` payloads are preserved.
- Historical delivered links are now always built from `receipt.target`, including when selectable targets are empty or fail to load. The receipt is still excluded from new choices and is never inserted into options.
- Card-local initial/hashchange handling opens disclosures, scrolls and focuses `#meeting-work-<confirmationRef>`. The target retains `tabIndex=-1` for programmatic focus.
- Root review identified mixed timezone display. Replaced custom UTC formatting with existing `monthDayTime` and explicit 北京时间. Cross-day test asserts `2026-11-13T17:30:00Z` displays `11/14 01:30 北京时间`; both original ISO `dateTime` and `TimedBlock.at` stay unchanged.
- CSS uses theme tokens, wrapping/min-width constraints, and a narrow-screen rule. Buttons/links/summary controls have at least 44px targets, choice labels 44px height, and textareas 88px minimum. No motion was introduced. These are mechanical CSS observations, not visual acceptance.

### Checks and observed outcomes

- Before implementation, the four original tests passed and all five new feed tests failed because the required hook did not yet exist.
- `pnpm --filter @warmap/web exec vitest run src/components/meeting/meetingWorkHandoffs.test.tsx src/components/meeting/issueDecisionBlock.behavior.test.tsx`: 17/17 passed after behavior implementation (10 handoff + 7 confirmation block tests).
- Following timezone review, `pnpm --filter @warmap/web exec vitest run src/components/meeting/meetingWorkHandoffs.test.tsx`: 11/11 passed, including the additional cross-day case.
- `pnpm --filter @warmap/web typecheck`: exited 0 after final source/test changes.
- `git diff --check -- <three owned files>`: exited 0. Git reports only expected LF/CRLF conversion notices.
- Tests cover stable key/time and refresh, historical navigation without restored selection, separate state counts, successful retry receipt merge, rejected retry retention, initial/later deep link disclosure and focus, selectable-target read failure, and original destination-side feed rendering.

## Limits

No browser automation fallback is authorized or used. Tests exercise production callbacks with a controlled hook runner and server-render actual card markup; they do not exercise browser layout or real backend authorization. Actual app screenshots, clicking, 320px layout, dark-mode perception and human comprehension remain unverified. Independent cross-module review is coordinated by root.

## Iteration 3: Shared field policy regression

### Preregistered expectation

Root's complete web run passed 2551/2553 tests; the two failures identify new CSS violations in this component. Reading `src/styles/field-style.test.ts` confirms existing user instructions require non-resizable textareas and input focus through field border tokens rather than a thick outline. Moving `.note textarea` to the established `--field-*` tokens, setting `resize: none`, and separating its focus rule should resolve both failures. Keep two-pixel focus outlines for buttons, links, card focus and disclosure summaries. The change is CSS only; the targeted field-policy and handoff tests should pass without changing test expectations or delivery behavior.

### Results

- Changed `.note textarea` to shared field text/background/border/radius/padding/font/line/caret/placeholder tokens. This also retains the shared 16px touch font behavior.
- Set `resize: none`; separated textarea focus into `border-color: var(--field-border-focus)`, `outline: none`, `box-shadow: var(--field-focus-ring)`. Button/link/card/summary outline rules remain unchanged.
- `pnpm --filter @warmap/web test src/styles/field-style.test.ts src/components/meeting/meetingWorkHandoffs.test.tsx`: exited 0; 24/24 tests passed (13 shared-field policy + 11 handoff behavior). Tests were not changed or weakened.
- No full-web run or typecheck was performed for this CSS-only iteration. Browser observation limits remain unchanged.
