# 文档导航

文档写的是当前事实；“已实现”不等于真实环境验收通过。项目规则见根目录 [CLAUDE.md](../CLAUDE.md)，领域术语只有一个入口：[CONTEXT.md](../CONTEXT.md)。

## 按任务阅读

| 任务 | 文档 |
| --- | --- |
| 了解产品与术语 | [CONTEXT.md](../CONTEXT.md)、[原始需求](../需求文档.md) |
| 本地启动与测试 | [本地开发](guides/local-development.md) |
| 配置服务和凭据 | [环境配置](guides/environment.md) |
| 理解代码边界 | [当前架构](architecture/README.md) |
| 伙伴怎么从本体取上下文、出处怎么带 | [本体上下文取用](technical/ontology-context.md) |
| 编写代码、观测或构建配置 | [工程规范](standards.md) |
| 验证对话、记忆与追踪 | [本地验收](guides/local-memory-langsmith.md) |
| 连接个人 MCP | [OAuth 接入](guides/mcp-oauth.md) |
| 部署、备份或回滚 | [部署指南](guides/deployment.md)，细节在 [`infra/staging`](../infra/staging/release.md) |
| 本地准生产环境 | [`infra/local`](../infra/local/README.md) |
| 运行独立 M2 | [M2 试用](guides/m2-trial.md) |
| 天枢本机程序：设计、安装与排错 | [RFC](technical/local-runner/RFC.md)、[安装卸载排错](guides/local-runner.md)、[`apps/local`](../apps/local/README.md) |
| 查询架构取舍 | [ADR 索引](adr/README.md) |

## 契约

- [稳定人员目录](contracts/company-people.v1.md)
- [标准逐字稿](contracts/warmap-transcript.v1.md)
- [任务卡起草口径](contracts/mission-card-writing.v0.1.md)
- [任务卡本人准备与组合核对](contracts/mission-card-preparation-review.v0.1.md)

HTTP schema 在 `packages/contracts`；这些文档补充业务语义，不另建手写 API 类型。

## 代理工作

- [领域文档维护](agents/domain.md)
- [本地事项](agents/issue-tracker.md)
- [分类标签](agents/triage-labels.md)

## 历史材料

以下保留最初的需求、设计与实施依据，不作为当前行为说明。单 CEO、禁止录音、旧前端迁移等描述已被后续实现替代。

- [MVP 规格](specs/CEOwarmap_MVP_spec.md)
- [目标设计 v0.3](CEOwarmap_目标设计_v0.3.md)
- [技术方案分片 00–08](technical/ceo-warmap/README.md)
- [设计图](diagrams/)：Archify 原始 HTML 与可编辑 JSON；`*.visual-check.*` 是当时的自动截图证据。

`.scratch/` 保存功能工单与历史证据，不由本导航重复维护。
