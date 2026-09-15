# 08: 完成 Issue 预研与直接决定闭环

Type: implementation
Status: resolved
Blocked by: 07 自动升级 Issue 并接收 DRI Issue

## What to build

从 pending Issue 跑通唯一深度的 ResearchDoc、CEO 直接决定、Research Override、Dismissed Issue 和精确撤回，使正式 Organization Fact 只来自确定性 Action。

## Acceptance criteria

- [x] research 状态可观察为 pending、running、ready、failed，失败原因在 Issue Card 原位展示。
- [x] ResearchDoc 包含摘要、选择、后果、证据、未知和来源，并由严格 candidate schema 校验后整份保存。
- [x] 只有 pending Issue 可显式重跑预研；重跑整份替换当前 doc，旧 run 保留，Conversation 不能局部改写。
- [x] ready research 下 CEO 可选择建议并编辑最终决定文本；Receipt 保存最终文本与当时 research 状态。
- [x] pending 或 failed research 只能经二次确认执行 Research Override，Receipt 明确记录 override。
- [x] CEO 可将误升级 Issue 变为 dismissed，保留 originRef 与 promotion fingerprint且不物理删除。
- [x] 重放相同 Action 只产生一个 Receipt/effect；旧 version 的新 fingerprint 返回冲突和最新 Card。
- [x] 所有撤回进入统一 effect revoker，并恢复准确 Issue 状态；外部不可逆效果不得声称已全部恢复。
- [x] Issue 页面、Card、通知投影和独立 Conversation 使用同一持久业务对象。

## Comments

- 实现：`research.ts`（pending/failed/ready→running 唯一转换、严格 ResearchDoc 整份写入、旧 run 不覆盖新 run、`idle()` 收口）+ `researchAgent.ts`（heavy 槽位、严格 submit_candidate Tool、注入相关 CompanyMemory 段落）+ `effects.ts`（统一 `revokeEffect`：issue decision Receipt 可完整恢复，`meeting:`/未知 effectRef 返回失败不虚称恢复）+ issues.ts 的五个公开 Action（`issue.retry_research`/`issue.decide`/`issue.decide_override`/`issue.dismiss`/`issue.revoke_receipt`，fingerprint 幂等优先于 version，旧 version 新 fingerprint → 409+latestCard）+ migration 007（receipts/dismiss 内嵌结构，无新实体）+ 首页通知投影复用同一 `projectIssueCard`（pending+red）。启动恢复扩展 `research_interrupted`；`HEAVY_MODEL` 为必填三槽位之一（含 Compose 守卫）。
- Override 的二次确认由 `confirmOverride: Type.Literal(true)` 在契约层强制；override 输入无 optionId（预研未完成时没有建议可选）。Receipt 保存 CEO 最终文本、optionId、researchStatusAtDecision、researchRunId、override。
- 验证：contracts 12 + API 106 测试（新增 21 个：四态观察、严格 schema 拒绝、失败可见不自动 retry、整份重跑/旧 run 保留/running 拒重跑、Conversation 不改 doc、decide 幂等与冲突、override 二次确认、dismiss 保全指纹并阻断再升级、统一 revoker 精确撤回、通知投影同源、research_interrupted 补偿、heavy AgentRun 落库）、`pnpm typecheck`/`build`、`docker compose config` HEAVY_MODEL 守卫均通过。
- 内部 review：Herdr deepseek-flash 只读 reviewer 三轮 Standards/Spec 双轴（九条验收逐条对照），11+1+0 条 findings 全部 red→green 修复并逐条确认，最终无 blocking；遗留一条非阻塞（`revokeEffect` meeting 分支暂以内部单测覆盖）明确移交 Ticket 11 随真实 MeetingOutcome 路径重写。
- 未包含：Web 端 decide/override/revoke 交互界面（Ticket 14，blocked by 本票）；meeting-item Receipt 撤回（Ticket 11）；预研 agent 的实时 web_search tool（Provider 由 Ticket 16 装载，当前注入来源+CompanyMemory 段落）；server/app 双份 loadCompanyMemory 的依赖注入整理（Ticket 16）。
