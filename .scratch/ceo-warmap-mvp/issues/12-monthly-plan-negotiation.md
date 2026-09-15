# 12: 生成并协商 MonthlyPlan

Type: implementation
Status: ready-for-agent
Blocked by: 03 提供只读 CompanyMemory MCP 与稳定人员目录; 05 补齐 Search、compaction 与 Runtime 恢复; 08 完成 Issue 预研与直接决定闭环

## What to build

按 Company Day 自动产生唯一 MonthlyPlan draft，让 CEO 编辑公司与战场目标、普通 todo，并让 DRI 反馈追加到同一计划完成协商。

## Acceptance criteria

- [ ] 每月 1 日按 Asia/Shanghai 为当前 period 最多创建一个 MonthlyPlan，重复触发和启动补跑不产生副本。
- [ ] Draft Agent 使用已确认方向、上月复盘、DRI 反馈和相关 CompanyMemory，输出严格校验的 Candidate Material。
- [ ] 生成失败可见且只能显式重试，不自动升档或静默生成空计划。
- [ ] CEO 可通过 versioned Action 编辑公司结果、战场结果和普通 todo；todo 包含 owner、可选 dueAt 与 sourceRef。
- [ ] todo 可带 battlefieldId，空值表示公司级；不能通过 owner 反推战场。
- [ ] DRI 鉴权接口把 externalId 去重的叙述性 feedback 追加到同一 MonthlyPlan。
- [ ] todo feedback 只包含文本、证据和 observedAt，不修改 open/done 等不存在的执行状态。
- [ ] MonthlyPlan Card、月度页面、通知与独立 Conversation 读取同一个持久对象。

## Comments
