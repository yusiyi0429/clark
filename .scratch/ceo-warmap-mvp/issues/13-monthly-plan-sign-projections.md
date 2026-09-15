# 13: 签发 MonthlyPlan 并刷新业务投影

Type: implementation
Status: ready-for-agent
Blocked by: 06 从真实来源生成可管理的 Signal; 12 生成并协商 MonthlyPlan

## What to build

让 CEO 签发协商完成的 MonthlyPlan，并在同一业务事务中刷新战场目标、普通 todo/feedback 投影和 Radar 基础 anchors。

## Acceptance criteria

- [ ] 只有 CEO session 可以签发，服务身份和 DRI feedback 不能确认计划。
- [ ] 签发前校验必核对项、owner Person、sourceRef、状态和 version；冲突返回最新 Card。
- [ ] 同一 period 只允许一个 confirmed MonthlyPlan，重放相同 Action 不重复产生效果。
- [ ] confirmed plan 成为当月公司与战场目标唯一来源，通知和详情不维护第二份草稿。
- [ ] 战场正面展示确认目标，背面按 battlefieldId 投影普通 todo 和最新叙述性 feedback。
- [ ] 签发刷新来源为 ontology 的 Radar 基础 anchors，并保留 originRef；不新增 monthly-plan anchor source。
- [ ] 需要外发的普通 todo 生成真实 pending_export/delivered 状态，不在 WarMap 跟踪执行进度。
- [ ] 签发不直接修改 CompanyMemory，也不创建 Mission、Todo 实体或完成百分比。

## Comments
