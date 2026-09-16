# 13: 签发 MonthlyPlan 并刷新业务投影

Type: implementation
Status: resolved
Blocked by: 06 从真实来源生成可管理的 Signal; 12 生成并协商 MonthlyPlan

## What to build

让 CEO 签发协商完成的 MonthlyPlan，并在同一业务事务中刷新战场目标、普通 todo/feedback 投影和 Radar 基础 anchors。

## Acceptance criteria

- [x] 只有 CEO session 可以签发，服务身份和 DRI feedback 不能确认计划。
- [x] 签发前校验必核对项、owner Person、sourceRef、状态和 version；冲突返回最新 Card。
- [x] 同一 period 只允许一个 confirmed MonthlyPlan，重放相同 Action 不重复产生效果。
- [x] confirmed plan 成为当月公司与战场目标唯一来源，通知和详情不维护第二份草稿。
- [x] 战场正面展示确认目标，背面按 battlefieldId 投影普通 todo 和最新叙述性 feedback。
- [x] 签发刷新来源为 ontology 的 Radar 基础 anchors，并保留 originRef；不新增 monthly-plan anchor source。
- [x] 需要外发的普通 todo 生成真实 pending_export/delivered 状态，不在 WarMap 跟踪执行进度。
- [x] 签发不直接修改 CompanyMemory，也不创建 Mission、Todo 实体或完成百分比。

## Comments

实现摘要：

- 签发 Action：`monthly-plan.sign` 只通过 `/api/actions/execute` 的 CEO session 边界暴露，服务身份/DRI 无法执行；Card 仅在未 confirmed 且草案不在生成中时提供该 Action。签发走既有 `withPlanLock`（行锁 + action 指纹幂等 + version 冲突返回 `latestCard`）。
- 签发校验（`executeSignMonthlyPlan`）：必核对项覆盖 `company`、每个 `battlefield:<id>`、每个 `todo:<id>`；校验 company/战场/todo 内容非空、todo owner 在 `company-people.v1`、`sourceRef` 非空、计划未 confirmed、草案不在 running；battlefieldId 必须命中 BattlefieldConfig 注册表。
- 签发事务：同一事务内重建 Radar ontology anchors 并写 `exports` 快照，任一失败整体回滚（测试删 `radar_config` 行验证）。anchors 以 `source=ontology`、`originRef=monthly-plan:<period>` 重建（company + 每个战场），保留 manual/meeting-reopen anchors，不新增 `monthly-plan` source。
- 投影：`GET /api/cards/battlefields` 正面读当前公司月已 confirmed 计划的战场目标与 pending Issue，背面按 todo/feedback 自身 `battlefieldId` 投影普通待办与最新叙述性 feedback；空 `battlefieldId` 为公司级，不进入任何战场背面。通知与详情仍复用 `projectMonthlyPlanCard` 同一持久对象。
- BattlefieldConfig：migration `011_battlefield_config.sql` 新增确定性注册表（seed `growth`）与 `monthly_plans.exports`；`getRegisteredBattlefieldIds`/`findUnregisteredBattlefieldId` 是唯一校验来源，未建页面或配置编辑框架。
- DRI 出站：签发为每个待办生成 `pending_export`；`GET /api/dri/monthly-exports`、`POST .../delivered|failed|re-export` 记录真实外部回执。状态机：pending_export→delivered|failed，failed→pending_export 只能显式 re-export，delivered 终态（乱序 failed 返回 409，不清空回执），failed 不能直接跳 delivered。WarMap 不保存 todo 执行状态。
- 契约：`RadarAnchor` 增 optional `source`/`originRef`；新增 `MonthlyPlanExport`、签发与 DRI 导出请求/响应、`BattlefieldCardPayload`；OpenAPI 与 Web 生成 client 已重新生成。

验证：

- `pnpm test`：contracts 23 + API 181 全过（新增 `apps/api/test/monthlyPlanSign.test.ts` 10 条，覆盖全部 8 条 AC、签发原子性回滚、battlefieldId 注册表、导出状态迁移）。
- `pnpm -r typecheck`、`pnpm -r build`（contracts + api + web）、`git diff --check` 全过；`pnpm --filter @warmap/web gen:client` 无额外 diff。
- 未改 `map.md`。

内部 review：

- Herdr 启动 deepseek-flash 只读 reviewer，Standards/Spec 双轴三轮。
- 第一轮 1 BLOCKING + 4 NON-BLOCKING + 3 NIT，已修复：导出状态迁移守卫（delivered 终态 + 显式 re-export）、删除未用 `BattlefieldConfig` 契约、`fieldErrors.missingItemIds` 改名、抽 `findUnregisteredBattlefieldId`。
- 第二轮新增 NON-BLOCKING：failed→delivered 绕过 re-export、OpenAPI `/failed` 缺 409 声明，均已修复并有测试。
- 第三轮 `no blocking` 收口。

边界与延后：

- 战场 Card 的 Web renderer、月度页面路由属 Ticket 14；本票只交付 API 投影。
- 导出路由沿用既有 `/api/dri/*` 惯例（与 `/api/dri/monthly-feedback` 一致），非设计文字里的 `/api/integrations/dri/*`。
- Ticket 11 的 MeetingOutcome todo Handoff 与 Supplement 导出未纳入统一出站表；本票只覆盖 MonthlyPlan 普通待办。
