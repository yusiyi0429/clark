# 架构决策索引

ADR 保留决策依据，被替代的部分只作历史参考。当前产品术语见 [CONTEXT.md](../../CONTEXT.md)，任务卡权限以[本人准备与组合核对契约](../contracts/mission-card-preparation-review.v0.1.md)为准。

| 编号 | 主题 | 适用范围 |
| --- | --- | --- |
| [0001](0001-warmap-is-a-ceo-decision-cockpit.md) | 原始决策驾驶舱 | 单 CEO 与不承担执行事项的限制由 0020 推翻 |
| [0002](0002-use-typed-cards-not-a-layout-dsl.md) | 类型化 Card | 有效，不建设布局 DSL |
| [0003](0003-confirm-meeting-outcomes-item-by-item.md) | 会后逐项确认 | 有效 |
| [0004](0004-company-memory-is-read-only-to-warmap.md) | 只读 Company Memory | 由 0027 取代 |
| [0005](0005-radar-auto-promotes-qualified-signals.md) | 雷达自动升级 | 仅公司雷达 |
| [0006](0006-ceo-may-decide-without-completed-research.md) | 预研未完成时决定 | 有效，须明确确认 |
| [0007](0007-import-only-structured-transcripts.md) | 逐字稿输入 | 标准契约有效；“不做录音、ASR”已不是现状 |
| [0008](0008-allow-full-model-traces-in-hosted-services.md) | 完整业务观测授权 | 有效，凭据始终排除 |
| [0009](0009-single-server-postgres-deployment.md) | 单机 Compose 与 PostgreSQL | 有效；备份覆盖范围见[部署指南](../guides/deployment.md#备份与恢复) |
| [0010](0010-runtime-does-not-own-business-memory.md) | Runtime 不拥有业务记忆 | 有效 |
| [0011](0011-use-openai-agents-api-as-runtime.md) | OpenAI Agents API | 由 0012 替代 |
| [0012](0012-use-pi-sdk-as-agent-runtime.md) | Pi SDK | 主 API 的 Agent Runtime |
| [0013](0013-expose-company-memory-as-read-only-mcp.md) | CompanyMemory 只读 MCP | 由 0027 取代，`/mcp/company-memory` 已删除 |
| [0014](0014-use-fastify-typebox-and-generated-openapi-client.md) | Fastify、TypeBox 与生成客户端 | 有效 |
| [0015](0015-isolate-production-pi-runtime.md) | 生产 Runtime 隔离 | 有效 |
| [0016](0016-rebuild-web-without-legacy-migration.md) | 新建 `apps/web` | 历史迁移依据，旧 `frontend/` 已删除 |
| [0017](0017-store-meeting-materials-in-an-api-only-volume.md) | 文件卷与联合恢复 | 原则有效；当前卷与备份范围见部署指南 |
| [0018](0018-strategy-map-config-and-mission-values.md) | 长期配置与战略锚点 | Mission 实体口径由 0019 更新 |
| [0019](0019-promote-mission-to-core-entity.md) | Mission 升为核心实体 | 实体原则有效；挂卡写入以任务卡契约为准 |
| [0020](0020-members-sign-in-and-own-execution-items.md) | 成员登录与执行事项 | 有效；任务卡可见性有后续更新；「不做看板」由 0034 取代 |
| [0021](0021-personal-radar-serves-only-its-owner.md) | 个人雷达 | 有效，与公司雷达隔离 |
| [0022](0022-persist-monthly-mission-card-rounds.md) | 任务卡轮次 | 数据边界有效；起草方式由 0026 更新，制定流程以任务卡契约为准 |
| [0023](0023-correct-confirmed-mission-cards-field-by-field.md) | 确认后更正 | 直接采纳写回已被替代：实质修改由战场 DRI 定向退回本人 |
| [0024](0024-month-end-review-starts-the-monthly-plan.md) | 月末复盘与下月计划 | 有效 |
| [0025](0025-mission-card-owner-self-review.md) | 本人审核 | 准备阶段可见性与汇总方式由任务卡契约替代 |
| [0026](0026-draft-mission-cards-on-plan-sign.md) | 签发即起草 | 有效 |
| [0027](0027-company-facts-only-from-world.md) | 公司事实只认本体、人员目录独立 | 有效，取代 0004、0013 |
| [0028](0028-local-runner-single-binary-with-bun.md) | 本机程序用 TS + Bun 单文件，托盘用系统脚本宿主 | 有效 |
| [0029](0029-local-runner-keys-stay-on-device.md) | 模型钥匙和同步令牌只存本机 | 有效 |
| [0030](0030-local-runner-sessions-clean-by-default.md) | 本机会话默认不带个人配置 | 有效 |
| [0031](0031-local-runner-outside-paths-flagged-not-denied.md) | 本机会话越界的路径：标红交本人定，不自动拒绝 | 有效 |
| [0032](0032-local-runner-release-and-code-signing.md) | 本机程序的发布：内部试用先不签名，签名和公证列成选项由本人定 | 待本人定 |
| [0033](0033-task-agreements-in-tianshu-for-november.md) | 11 月约定存天枢、12 月改读本体；Task 读权限放宽到认可人 | 有效（0028–0032 是本机程序分支的编号） |
| [0034](0034-execution-board-cards-are-execution-items.md) | 执行看板：卡就是执行事项，看板只在 Task 下，跨 Task 只给 worker 列表 | 有效，修订 0020 第 4 条 |
| [0035](0035-agent-acceptance-and-growing-roles.md) | Agent 先验收、本人可推翻；验收里学到的提成岗位修改 | 有效 |
| [0036](0036-local-runner-cloud-side-receives-only.md) | 本机程序的云端一侧：设备令牌、只收上报、联网搜索走服务器 | 有效 |
| [0037](0037-local-runner-roles-via-cli-flags.md) | 岗位进本机会话：用 Claude Code 自带的参数，文件放本机程序的数据目录 | 有效 |
| [0038](0038-local-runner-card-worktrees.md) | 卡在自己的 git 工作树里做：分支是交付物，合回由本人点 | 有效 |

新增 ADR 沿用下一个编号，被替代时在原文开头写明替代关系，不删除原文。
