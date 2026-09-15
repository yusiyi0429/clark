# 07: 自动升级 Issue 并接收 DRI Issue

Type: implementation
Status: ready-for-agent
Blocked by: 03 提供只读 CompanyMemory MCP 与稳定人员目录; 04 跑通 global 与对象 Conversation; 05 补齐 Search、compaction 与 Runtime 恢复; 06 从真实来源生成可管理的 Signal

## What to build

让合格 Signal 自动产生立即可见的 pending Issue，并让鉴权 DRI 服务接口进入同一 Issue 模型，不增加 CEO 手动“形成议题”步骤。

## Acceptance criteria

- [ ] Radar 升级校验 CEO 决策类型、至少两个不同选择、连续引文、合法 location、代码分数和 promotion fingerprint。
- [ ] 外部 Red Issue 具有来源支持的 decisionByEvidence 连续引文和可解析时间窗口。
- [ ] promotion fingerprint 使用版本化 decision kind、规范化问题与规范化 location；dismissed 等价问题不重复升级。
- [ ] 升级事务同时保存 Signal promotion 关系和 pending Issue，重复执行只得到一个 Issue。
- [ ] DRI 服务接口校验 stable Person、title、whyNow、sourceRef、location；red 额外要求 decisionBy 和 reason。
- [ ] Issue 只拥有 company、单 battlefield 或 capability 中一个主 location；Strategic Issue 不复制到多个战场。
- [ ] Issue 创建后立即返回可查询 Card，并初始化 pending research；Agent 未启动不阻止 Issue 展示。
- [ ] 创建后、预研启动前的超时 pending research 在恢复时变为 `failed:trigger_not_started`，等待显式重试。

## Comments
