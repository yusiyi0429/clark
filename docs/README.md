# 文档导航

当前需求与术语只有一个入口：[context.md](context.md)。实现说明与历史方案分开维护。文档中“已实现”不代表真实环境验收通过。

## 按任务阅读

| 任务 | 文档 |
| --- | --- |
| 了解产品、需求与术语 | [领域上下文](context.md) |
| 本地启动与测试 | [本地开发](guides/local-development.md) |
| 配置服务和凭据 | [环境配置](guides/environment.md) |
| 理解代码边界 | [当前架构](architecture/README.md) |
| 编写代码、观测或构建配置 | [工程规范](standards.md) |
| 验证记忆与追踪 | [本地验收](guides/local-memory-langsmith.md) |
| 连接个人 MCP | [OAuth 接入](guides/mcp-oauth.md) |
| 部署、备份或回滚 | [部署指南](guides/deployment.md) |
| 运行独立 M2 | [M2 试用](guides/m2-trial.md) |
| 查询架构取舍 | [ADR 索引](adr/README.md) |
| 查询原始需求与设计图 | [历史方案](architecture/history/README.md)、[图表](diagrams/README.md) |

## 契约

- [稳定人员目录](contracts/company-people.v1.md)
- [标准逐字稿](contracts/warmap-transcript.v1.md)
- [任务卡起草口径](contracts/mission-card-writing.v0.1.md)
- [任务卡本人准备与组合核对](contracts/mission-card-preparation-review.v0.1.md)

HTTP schema 位于 `packages/contracts`。这些文档补充业务语义，不另建一份手写 API 类型。

## 代理工作

授权和流程见根目录 [AGENTS.md](../AGENTS.md)。按任务读取：

- [领域文档维护](agents/domain.md)
- [本地事项](agents/issue-tracker.md)
- [分类标签](agents/triage-labels.md)

## 文档边界

`architecture/history` 保留原始需求、实施目标与历史风险豁免。旧文中的单 CEO、CompanyMemory MCP、禁止录音和旧前端迁移不能作为当前行为说明。

ADR 保留编号和替代关系。图表保留原始文件名与可编辑源，便于追溯。生成的重复视觉检查导出不作为当前验收基线。

`.scratch` 保存历史证据，不由本导航重复维护结果。M2 的 `skill/` 属于运行时技能，不按普通文档清理。
