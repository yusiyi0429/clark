# Task 1 — Team delivery progressive disclosure

## Before experiment

Expected change: preserve the original delivery body/source and each recipient's status on the first level; move only historical replies and original attachment lists behind explicitly labelled native disclosures. Keep replies, requests for clarification, failed-recipient retries, and share forwarding reachable. Native reply deep links must open all disclosure ancestors before focus and scroll.

Criteria: default disclosures have no `open` attribute; all recipient names/status and own actionable controls remain outside history; retry/clientId/auth/file/forward semantics remain intact; mount/hashchange/new reply arrival locate only a matching reply in this card; malformed or unrelated hashes do nothing. Controls introduced/restyled inside cards are at least 44px; narrow sizing uses min-width:0, wrapping, and theme variables. Component behavior/SSR checks are mechanical evidence, not browser or visual acceptance.

Scope: PartnerTeamCard.tsx, partnerTeam.module.css, partnerTeam*.test.tsx. Upstream #team-request fetching is owned by root. Reply hashes can locate a reply when its delivery is loaded; no reply-to-delivery API is introduced.

## Execution

- Read apps/web/AGENTS.md and installed Next server/client-component guide before editing. Browser APIs will stay in a client effect.
- No registered OpenViking search/read pair was available; no memory call or substitute transport used.
- Tests/results and remaining limits will be appended after verification.

## Result

- Production changes: per-recipient status/error and current reply/clarification/retry controls remain visible, before each collapsed history. Original attachments use their own labelled collapsed disclosure. Existing reply/source forwarding, download/access handling, APIs, exports and stable ReplyForm clientId lifecycle remain unchanged.
- Deep links: a card client effect safely decodes the current hash, checks ownership, opens every ancestor `details`, then focuses (`tabIndex=-1`) and scrolls the reply on the next animation frame. Handles mount, hashchange and newly arrived reply identities; unchanged poll data does not refocus. Cleans listener/frame. Original request anchors retain their names.
- RED observed: initial new behavior run had 3 expected failures (no collapsed history / no deep-link ref) and 1 passing original clientId retry check. After implementation and added regression coverage: `pnpm --filter @warmap/web test -- src/components/home/partnerTeam.test.tsx src/components/home/partnerTeam.behavior.test.tsx src/components/home/partnerTeamCard.behavior.test.tsx` => 3 files, 18/18 tests pass (2026-11-15, final run).
- Coverage: multi-member first-level content/source/status, default disclosure markup, recipient reply/clarification actions, sender clarification and per-recipient failed retry, reply clientId preserved after failure, original reply/source forwarding, deep-link ancestor expansion + focus/scroll + hash changes + malformed/unowned hash, delayed reply arrival and no repeated focus for unchanged identities.
- `git diff --check` for the owned tracked files passed (Git printed only LF/CRLF notices).
- `pnpm --filter @warmap/web typecheck` ran; it failed on concurrent unfinished Task 2/3 hook exports/types and Conversations imports only. No diagnostics in Task 1 files. Root must run the integrated final check after those tasks settle.

## Mechanical layout review and limits

Card controls/links and new disclosure summaries specify a minimum 44px height; primary/secondary/link buttons use at least 44px width. Card controls wrap and use max-width:100%; card fields use border-box sizing. Existing min-width:0, anywhere wrapping and wrapping rows are retained; long Chinese fixture is SSR-covered. New colors are semantic `--ink`, `--ink-muted`, `--hairline`; no new animation or fixed wide card dimension. Shared dialog controls are not restyled by the new card selectors.

These are code/SSR/hook-runner checks with DOM boundary stubs, not measured 320px overflow, browser focus visibility, keyboard/screen reader operation, screenshots, theme contrast, mobile touch or human comprehension evidence. No browser-control tool was available and no browser automation was installed. Reply-id hashes cannot fetch unloaded historical delivery data because the existing API resolves only delivery IDs; loaded/newly loaded replies are handled. Root owns upstream historical request loading and final independent review.

## Review R1 — preregistered correction

Before changing production code: reviewer reproduced a valid focus regression that the prior unchanged-identities test did not cover. With #team-reply-A already resolved, appending unrelated B changes replyIds and unconditionally reopens/refocuses A. Expected correction: remember successful resolution for the unchanged navigation; data updates retry only unresolved targets. Explicit hashchange resets the successful-resolution guard and can locate again, including leaving/returning to the same reply. Preserve delayed target arrival and effect cleanup. A concrete new test will first assert one focus/scroll and closed history after unrelated reply arrival, then explicit navigation remains reachable. Scope remains Task 1; no all-web rerun or commit.

### R1 verification result

- RED: `pnpm --filter @warmap/web test -- src/components/home/partnerTeamCard.behavior.test.tsx` => 1 failed / 6 passed. The new unrelated-B case failed at `expect(history.open).toBe(false)` with actual `true`, reproducing the review finding before production edits.
- Fix: added persistent `locatedReply` ref. Successful focus/scroll records the resolved anchor; subsequent data-effect runs skip that anchor. A dedicated hashchange handler clears the guard and retries. A missing target is never recorded, so late target arrival still works. Guard is recorded in the animation callback, so a cancelled pending locate is still retryable.
- GREEN: scoped team test command below completed with 19/19 passing across 3 files. New test verifies no history reopening or extra focus/scroll after unrelated B, then leaving/returning to A explicitly locates it again. Existing late-arrival, same-identity, malformed hash, unowned target, listener cleanup, actions, retry/clientId and forwarding tests remain green.
- Command: `pnpm --filter @warmap/web test -- src/components/home/partnerTeam.test.tsx src/components/home/partnerTeam.behavior.test.tsx src/components/home/partnerTeamCard.behavior.test.tsx`.
- `git diff --check` on the correction files passed (only CRLF notice). No all-web run, browser automation, commits or pushes. This correction still uses the reported hook/DOM boundary stubs and does not add live browser evidence.
