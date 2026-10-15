# 02 — 主私聊使用当前页面 Anchor，保留用户原话

Type: implementation
Status: ready-for-agent

**What to build:** 用户在首页或对象页发送消息时，Agent 获得与可见 Card 一致的有界 Anchor，可展开当前项；当前 Query、显式引用与附件分别处理，换页面后旧 Anchor 不累积。

**Blocked by:** None — can start immediately.

- [ ] 前端选择与 API 契约连通；过期选择返回 409、越权返回 404，失败保留输入。
- [ ] 页面和 Anchor 复用授权投影，先权限过滤再计数，目录分页不泄露隐藏对象。
- [ ] 真实 Pi 首轮、工具后续请求、恢复及压缩使用本轮 Anchor，持久消息保留原话。
- [ ] 本地页面值明确为页面/草稿/历史，不借高场景权重覆盖 World 事实。

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
