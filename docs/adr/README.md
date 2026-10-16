# 架构决策索引

ADR 保留决策依据。被替代内容只作历史参考。当前产品边界见[领域上下文](../context.md)，任务卡权限以[当前契约](../contracts/mission-card-preparation-review.v0.1.md)为准。

| 编号 | 主题 | 适用范围 |
| --- | --- | --- |
| [0001](0001-warmap-is-a-ceo-decision-cockpit.md) | 原始决策驾驶舱 | 单 CEO 与无执行事项限制由 0020 替代 |
| [0002](0002-use-typed-cards-not-a-layout-dsl.md) | 类型化 Card | 有效，不建设布局 DSL |
| [0003](0003-confirm-meeting-outcomes-item-by-item.md) | 会后逐项确认 | 有效 |
| [0004](0004-company-memory-is-read-only-to-warmap.md) | 旧公司记忆 | 由 0027 替代 |
| [0005](0005-radar-auto-promotes-qualified-signals.md) | 雷达自动升级 | 仅公司雷达 |
| [0006](0006-ceo-may-decide-without-completed-research.md) | 预研未完成时决定 | 有效，必须明确确认 |
| [0007](0007-import-only-structured-transcripts.md) | 逐字稿输入 | 标准契约有效；录音限制属于历史 |
| [0008](0008-allow-full-model-traces-in-hosted-services.md) | 完整业务观测授权 | 包括记忆正文，排除凭据 |
| [0009](0009-single-server-postgres-deployment.md) | 单机 Compose | 主应用有效；备份目标不等于已验收 |
| [0010](0010-runtime-does-not-own-business-memory.md) | Runtime 不拥有事实 | 有效 |
| [0011](0011-use-openai-agents-api-as-runtime.md) | OpenAI Agents API | 由 0012 替代 |
| [0012](0012-use-pi-sdk-as-agent-runtime.md) | Pi SDK | 主 API Runtime；历史探针不代表当前全量验收 |
| [0013](0013-expose-company-memory-as-read-only-mcp.md) | 旧 CompanyMemory MCP | 由 0027 替代 |
| [0014](0014-use-fastify-typebox-and-generated-openapi-client.md) | Fastify 与生成契约 | 有效 |
| [0015](0015-isolate-production-pi-runtime.md) | 生产 Runtime 隔离 | 隔离有效；读取方式见 0027 |
| [0016](0016-rebuild-web-without-legacy-migration.md) | 替换旧前端 | 历史迁移依据，旧目录已移除 |
| [0017](0017-store-meeting-materials-in-an-api-only-volume.md) | 文件卷与恢复 | 原则有效，当前覆盖范围见部署指南 |
| [0018](0018-strategy-map-config-and-mission-values.md) | 长期配置与战略锚点 | Mission 实体口径由 0019 更新 |
| [0019](0019-promote-mission-to-core-entity.md) | 独立 Mission | 实体原则有效，挂卡写入以当前契约为准 |
| [0020](0020-members-sign-in-and-own-execution-items.md) | 成员与执行事项 | 身份原则有效；任务卡与部署说明有后续更新 |
| [0021](0021-personal-radar-serves-only-its-owner.md) | 个人雷达 | 有效，与公司雷达隔离 |
| [0022](0022-persist-monthly-mission-card-rounds.md) | 任务卡轮次 | 数据边界有效；旧公开讨论流程由当前契约替代 |
| [0023](0023-correct-confirmed-mission-cards-field-by-field.md) | 确认后更正 | 当前采用定向退回，不直接改文 |
| [0024](0024-month-end-review-starts-the-monthly-plan.md) | 月末复盘与下月计划 | 主应用链路 |
| [0025](0025-mission-card-owner-self-review.md) | 本人审核 | 旧提前汇总与可见性由当前契约替代 |
| [0026](0026-draft-mission-cards-on-plan-sign.md) | 签发后自动起草 | 有效，保留明确失败与补起限制 |
| [0027](0027-company-world-and-personal-memory.md) | World 与个人记忆 | 当前记忆边界 |
| [0028](0028-langsmith-thread-turn-spans.md) | Thread、Turn 与真实节点 | 当前主 API 追踪协议，不代表 M2 全覆盖 |
