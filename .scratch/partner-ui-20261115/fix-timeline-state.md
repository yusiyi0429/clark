# F3 timeline block identity fix

## Pre-experiment expectation (before production edits)

- Confirmed root cause: `placeBlocks` sends time blocks after the last message whenever any message has no timestamp. `WorkTimeline.after` places those blocks inside keyed `ConversationTurns` fragments (`turn-0`, `turn-1`, ...). A stable block key is scoped to that changing parent, so an unrelated append remounts interactive meeting/handoff cards.
- An untimed-only trailing outlet would still remount blocks on the routine timed → optimistic untimed → timed-history transition. Detaching only fallback blocks also changes their ordering relative to sequence-anchored blocks in the same bucket. Root therefore expanded scope to `Transcript.tsx` and its relevant tests.
- Add an optional keyed insertion outlet to `ConversationTurns`. Put leading insertions, keyed message fragments, every bucket's insertions, and current trailing rows in one flat sibling array. Keep the existing per-message `after` callback for message-attached cards/plan/decision semantics. `WorkTimeline` will use the new outlet only for timed blocks.
- Expected result: each event keeps its actual React ancestor/key path across untimed append, no-history → first message, timed → untimed → timed refresh, and explicit numeric/null placement moves. Its chronological position can change without changing its parent. Existing timestamps, block keys, sorted order, afterSequence rules and streaming/footer/after ordering stay unchanged.
- Regression that must fail before the fix: render the actual `WorkTimeline` and expand actual `ConversationTurns`; compare a handoff block's full element/key ancestry before and after append. The old tree should differ at `turn-0` / `turn-1`. Also cover the routine timed/untimed transition, empty history and exact rendered order.
- No `react-test-renderer`, `react-reconciler`, `jsdom` or `happy-dom` is installed (`require.resolve` checked all four). No dependencies or browser automation will be added. The mechanical regression can establish actual React element identity eligibility; it cannot independently observe a browser mount, retained textarea text, reader visibility or DOM focus. A same-path assertion will not be described as observed lifecycle behavior.

## Results

- Added `ConversationTurns.insertions(index)`, returning keyed independent event elements. `-1` is the leading position. Each event has a stable `insertion:<original-key>` fragment namespace, preventing collisions with message `turn-N` and waiting-row keys. Leading events, keyed messages, all event buckets and current streaming/trailing rows render from one flat array.
- `WorkTimeline` now passes `blocksAt` through this outlet. It retains the existing `after` callback for message-specific plans, entry cards and decisions. `placeBlocks` was not modified: actual-instant sorting, original `TimedBlock` objects/timestamps/keys, explicit numeric/null afterSequence placement and sorted combined bucket order remain intact.
- State ownership is now independent of event position. The same React keyed ancestor chain persists when a block moves from leading to interleaved/trailing position, during repeated untimed appends, during timed → optimistic untimed → timed refresh, and when numeric/null sequence placement changes. No card state was lifted, serialized or reset; no hash-navigation effect was suppressed.

### Red → green evidence

1. Before production edits, `pnpm --filter @warmap/web exec vitest run src/components/work/workTimeline.identity.test.tsx` exited 1: **5/5 failed**. The first diff explicitly changed `array:turn-0` / `Fragment:turn-0` to `array:turn-1` / `Fragment:turn-1`. Empty history changed from the outer leading array to a per-turn fragment. Timed → pending untimed changed `turn-0` to `turn-2`. The anchor/order fixture's ordering assertions passed before its identity assertion failed.
2. Before production edits, `pnpm --filter @warmap/web exec vitest run src/conversation/conversationTimeline.test.tsx` exited 1: the existing streaming/card test passed; **2 new tests failed** because insertions were absent and the returned children retained separate nested message arrays. These tests cover an event deliberately named `turn-0` (key namespace collision) and exact leading/message/footer/after/event/partial/status/trailing order.
3. After implementation, the new identity test, conversation timeline test and existing work test passed **48/48**.
4. Final related run exited 0: **79/79 across 9 files**:
   `pnpm --filter @warmap/web exec vitest run src/components/work/workTimeline.identity.test.tsx src/components/work/work.test.tsx src/conversation/conversationTimeline.test.tsx src/conversation/localTurn.test.tsx src/conversation/feishuVia.test.tsx src/conversation/streamingSmooth.test.tsx src/conversation/deepTier.test.tsx src/conversation/chatUiPolish.test.tsx src/components/work/buddyQuestion.test.tsx`
5. `git diff --check` for the four owned source/test files exited 0. `pnpm --filter @warmap/web typecheck` exited 0 (`tsc --noEmit`). Root owns final full web-suite validation.

### Files

- `apps/web/src/conversation/Transcript.tsx`
- `apps/web/src/conversation/conversationTimeline.test.tsx`
- `apps/web/src/components/work/WorkTimeline.tsx`
- `apps/web/src/components/work/workTimeline.identity.test.tsx` (new)

### Verification limits

The identity regression executes actual `WorkTimeline` and actual `ConversationTurns`, with only memo computation made synchronous. Its walker records **every** array/element boundary, keyed fragment and component boundary; it does not flatten away the parent responsible for the defect. Controlled handoff-picker/reader leaves supply the event payload. This proves the production element identity contract and exact event/message order, including routine timestamp transitions. It does **not** execute a native React lifecycle or observe a user selecting a real handoff target, typing a draft, opening a meeting reader, or focusing/scanning in a browser. React's retention of state for the same type/key/parent is the reconciliation basis for the fix, not a fabricated browser observation. Actual DOM lifecycle/focus/layout remains unverified. No new dependency, browser automation or commit was used.
