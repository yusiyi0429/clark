# 12: 生成并协商 MonthlyPlan

Type: implementation
Status: resolved
Blocked by: 03 提供只读 CompanyMemory MCP 与稳定人员目录; 05 补齐 Search、compaction 与 Runtime 恢复; 08 完成 Issue 预研与直接决定闭环

## What to build

按 Company Day 自动产生唯一 MonthlyPlan draft，让 CEO 编辑公司与战场目标、普通 todo，并让 DRI 反馈追加到同一计划完成协商。

## Acceptance criteria

- [x] 每月 1 日按 Asia/Shanghai 为当前 period 最多创建一个 MonthlyPlan，重复触发和启动补跑不产生副本。
- [x] Draft Agent 使用已确认方向、上月复盘、DRI 反馈和相关 CompanyMemory，输出严格校验的 Candidate Material。
- [x] 生成失败可见且只能显式重试，不自动升档或静默生成空计划。
- [x] CEO 可通过 versioned Action 编辑公司结果、战场结果和普通 todo；todo 包含 owner、可选 dueAt 与 sourceRef。
- [x] todo 可带 battlefieldId，空值表示公司级；不能通过 owner 反推战场。
- [x] DRI 鉴权接口把 externalId 去重的叙述性 feedback 追加到同一 MonthlyPlan。
- [x] todo feedback 只包含文本、证据和 observedAt，不修改 open/done 等不存在的执行状态。
- [x] MonthlyPlan Card、月度页面、通知与独立 Conversation 读取同一个持久对象。

## Comments

实现摘要：

- `packages/contracts/src/monthlyPlans.ts` 定义 MonthlyPlan 状态/period/todo/battlefield/negotiation/generation、严格 `MonthlyDraftCandidate`、`UpdateMonthlyPlanDraftRequest` 与两个 DRI feedback 请求；`openapi.ts` 新增 `/api/cards/monthly-plans`、`/api/cards/monthly-plans/{id}`、`/api/dri/monthly-feedback`、`/api/dri/todo-feedback` 与对应 schema。
- `apps/api/migrations/009_monthly_plans.sql`：`period` 唯一索引；无 Mission/Todo 实体、无执行状态列。
- `apps/api/src/monthlyPlans.ts`：单一 projector（Card/通知/详情/Conversation 同源）；versioned `monthly-plan.update_draft` 走行锁 + action 指纹幂等 + version 冲突返回 `latestCard`；owner 必须是 company-people.v1 稳定 personId；`battlefieldId` 省略即公司级且不由 owner 反推；被编辑字段组的核对项自动失效；`monthly-plan.retry_draft` 仅失败时可用；DRI feedback 以 `(period, externalId)` 幂等追加，只含文本/证据/observedAt，不改 todo 状态；confirmed 拒绝新 feedback。
- `apps/api/src/monthlyDraft.ts` + `monthlyDraftAgent.ts` + `monthlyPlanScheduler.ts`：Asia/Shanghai 唯一 period（advisory lock + `ON CONFLICT DO NOTHING`）、启动补跑；Draft Agent 输入为已确认 Receipt、上月计划与 feedback、相关 CompanyMemory；严格 candidate + 代码 owner 校验；失败只写可见 error，不自动重试、不生成空计划；启动恢复把单进程下任何未完成 generation 标为 failed。
- 接线：`apps/api/src/app.ts`（Card 列表/详情、通知投影、DRI 接口、两个 Action）、`apps/api/src/conversations.ts`（`monthly-plan:<id>` scope 与引用快照）、`apps/api/src/server.ts`（service + scheduler + 启动恢复）。

验证：

- `cd apps/api && npx vitest run --poolOptions.forks.maxForks=2` → 12 files / 146 tests passed（新增 `test/monthlyPlan.test.ts` 12 条，覆盖全部 8 条 AC）。
- `pnpm --filter @warmap/contracts test` → 19 tests passed（新增 4 条 monthly plan 契约测试）。
- `pnpm -r typecheck`、`pnpm -r build`（contracts + api + web）通过；`pnpm --filter @warmap/web gen:client` 已重新生成 OpenAPI client。
- 说明：本机默认并行 `pnpm test` 会因测试库连接争用超时（既有环境限制，非本票引入），故测试用 fork 上限 2 运行。

内部 review：

- Herdr 启动 deepseek-flash 只读 reviewer，Standards/Spec 双轴两轮，无 blocking。
- 已按有效发现修复：调度触发错误不再静默、编辑字段组取消对应核对、移除未用 timezone 参数与未用 export/index、生成中拒绝编辑（`MONTHLY_PLAN_DRAFT_RUNNING`）、启动恢复单进程无阈值、明确 `(period, externalId)` 幂等键、confirmed 拒绝新 DRI feedback。

边界与延后：

- 本票只做 draft/negotiating；签发、战场目标与 Radar 基础 anchors 刷新、pending_export/delivered 属 Ticket 13。
- `battlefieldId` 注册表校验依赖尚不存在的 BattlefieldConfig，本票只做形状与长度校验，注册表校验随 Ticket 13 落地。
- 月度页面 Web 路由属 Ticket 14；本票只交付同一持久对象的 API 读模型（Card/通知/详情/Conversation）。
- `agent_runs.object_ref` 暂不传 monthly-plan id，与既有 preflightAgent 批次 Agent 做法一致。
