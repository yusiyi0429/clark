# 07: 自动升级 Issue 并接收 DRI Issue

Type: implementation
Status: resolved
Blocked by: 03 提供只读 CompanyMemory MCP 与稳定人员目录; 04 跑通 global 与对象 Conversation; 05 补齐 Search、compaction 与 Runtime 恢复; 06 从真实来源生成可管理的 Signal

## What to build

让合格 Signal 自动产生立即可见的 pending Issue，并让鉴权 DRI 服务接口进入同一 Issue 模型，不增加 CEO 手动“形成议题”步骤。

## Acceptance criteria

- [x] Radar 升级校验 CEO 决策类型、至少两个不同选择、连续引文、合法 location、代码分数和 promotion fingerprint。
- [x] 外部 Red Issue 具有来源支持的 decisionByEvidence 连续引文和可解析时间窗口。
- [x] promotion fingerprint 使用版本化 decision kind、规范化问题与规范化 location；dismissed 等价问题不重复升级。
- [x] 升级事务同时保存 Signal promotion 关系和 pending Issue，重复执行只得到一个 Issue。
- [x] DRI 服务接口校验 stable Person、title、whyNow、sourceRef、location；red 额外要求 decisionBy 和 reason。
- [x] Issue 只拥有 company、单 battlefield 或 capability 中一个主 location；Strategic Issue 不复制到多个战场。
- [x] Issue 创建后立即返回可查询 Card，并初始化 pending research；Agent 未启动不阻止 Issue 展示。
- [x] 创建后、预研启动前的超时 pending research 在恢复时变为 `failed:trigger_not_started`，等待显式重试。

## Comments

- 实现：`issues` 表（migration 006）+ `signals.promoted_issue_id/promotion_fingerprint`；`apps/api/src/issues.ts` 提供 promotion 门槛、fingerprint、DRI 导入、Issue Card 投影与 `recoverInterruptedResearch`；Radar 落库改为「Signal + pending Issue + promotion 关系」单事务。契约侧新增 `IssueLocation`、`DriIssueImportRequest`、`RadarPromotionCandidate`，并注册 `/api/dri/issues` 到 OpenAPI（Web client 已重新生成）。
- 门槛全部在代码侧：CEO decision kind、去重后 ≥2 选择、quote 与 red decisionByEvidence 连续存在于来源 excerpt、red 引文可解析出明确年月日（`failed:trigger_not_started` 之外的日历越界回读校验）、location 领域规则（company 仅 1 个战场被拒）、分值（每维 ≥3 且总分 ≥12）、fingerprint 去重。
- 启动恢复：`server.ts` 在 listen 前把超时 `pending` research 标为 `failed:trigger_not_started`，不自动重试。
- 验证：contracts 12 + API 85 测试、`pnpm typecheck`、`pnpm build` 通过。内部 Herdr 只读 Pi reviewer 三轮 Standards/Spec 双轴复核，最终无 blocking；其有效发现（dismissed 防重测试未真正命中 promotion fingerprint、red 引文缺可解析窗口、DRI/Radar location 规则不一致、日期进位与 UTC 回退年、鉴权先于输入校验、计数在回滚前自增、测试池 57P01 处理）均由主 agent red→green 修复。
- 未包含：ResearchDoc 生成/决定/重试（Ticket 08）、dismiss API、首页红色待判断通知投影、DRI UI；未新增 ResearchJob/Action/ScanRun 实体或任何依赖。
