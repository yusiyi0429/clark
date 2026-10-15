# 02 — 主私聊使用当前页面 Anchor，保留用户原话

Type: implementation
Status: resolved

**What to build:** 用户在首页或对象页发送消息时，Agent 获得与可见 Card 一致的有界 Anchor，可展开当前项；当前 Query、显式引用与附件分别处理，换页面后旧 Anchor 不累积。

**Blocked by:** None — can start immediately.

- [x] 前端选择与 API 契约连通；过期选择返回 409、越权返回 404，失败保留输入。
- [x] 页面和 Anchor 复用授权投影，先权限过滤再计数，目录分页不泄露隐藏对象。
- [x] 真实 Pi 首轮、工具后续请求、恢复及压缩使用本轮 Anchor，持久消息保留原话。
- [x] 本地页面值明确为页面/草稿/历史，不借高场景权重覆盖 World 事实。

**TDD seams:** Web 私聊输入公开交互、messages HTTP、ConversationRuntime.run、read_anchor 工具。复用已有真实 Pi 离线探针，不测 SDK 私有实现。

## Execution

Each ticket uses one implement subagent in an isolated worktree; red/green evidence and Standards/Spec review evidence must be recorded before resolution. User-approved public seams and fixed point are in ticket-breakdown.md.

## Implementation evidence

- Public seams approved by user: Web composer interactions, messages HTTP, Runtime.run/tool. Fixed review baseline: fed15706be1107b327fd670e8e21534fd9cdc5b6.
- Red/green: real Pi test initially received old persisted JSON instead of Anchor; ephemeral provider dispatch now passes first request, tool continuation and restored subsequent turn while entries retain raw words only.
- Red/green: HTTP focus initially undefined; same authorized home projection now supports selection, stale409 and missing404, bounded directory paging.
- Red/green: Web request initially omitted selection; sends selection separately, rejected409 returns false so existing composer retains input.
- Attachment extraction moved from query to Reference; full backend reader pages6KiB, rechecks ownership/content and per-run cursor. Ticket03 wires shared read_reference tool to this callback.
- Relevant API run:39/39 passed before extra pagination/attachment cases; expanded HTTP suite21/21 passed; Pi16/16 passed. Web conversation86/86; contracts75/75. API/Web full runs and typechecks recorded after review below.
- Migration060 replaces derived execution state on the first schema2 turn, restoring recent raw discussion and preserving original messages.

## Two-axis review

- Standards (fed15706be1107b327fd670e8e21534fd9cdc5b6...891de30): one P3 handwritten wire DTO. Fixed by deriving AnchorSelection from generated OpenAPI components; Web typecheck passed.
- Spec: two P2 findings: omitted member battlefield targets/radar/weeklySync; frozen viewing-material metadata. Both reproduced with failing HTTP/runtime tests before fixes. Member-visible workspace summaries now join the authorized index; material is re-read under current viewer and frozen snapshot comparison returns conflict when changed. Both targeted regressions pass; API typecheck passes.
- Web full suite completed814/814, contracts75/75. API full run stopped by parent instruction to reserve full integrated run for ticket07; no full API result claimed.
- No new dependency, general plugin framework, shell access, World write capability, or excluded-feature behavior was introduced. Shared projection exports replace duplicated route reads; page/attachment machine metadata stays out of model text. Budget adaptation retains raw query and existing tool pairs.


## Resolution

- Implementation commits891de30 + edfbbc9. Standards initially1 finding, fixed and rechecked clean; Spec initially2 findings, fixed with red/green tests and rechecked clean. Review baseline fed15706be1107b327fd670e8e21534fd9cdc5b6.
- Final focused API run:41passed/2default5s setup timeouts; reran only those2 tests, both passed (1.68s and1.01s), without changing timeouts or code. All43 focused behaviors passed across the run and targeted rerun. API/Web typechecks pass; Web814/814 and contracts75/75 completed.
- Remaining integration: ticket03 wires read_reference to run.readReference; later Company/Personal readers append typed References before ephemeral provider assembly. No real provider or remote World calls were used in this ticket. Root ticket07 owns the final integrated full-suite/PR review.
