# CEO WarMap 技术方案索引

## 输入

- 产品 Spec：`docs/specs/CEOwarmap_MVP_spec.md`
- 目标设计：`docs/CEOwarmap_目标设计_v0.3.md`
- 领域词表：`CONTEXT.md`
- 决策记录：`docs/adr/`

## 架构图

- `docs/diagrams/CEOwarmap_技术架构.html`
- `docs/diagrams/CEOwarmap_六实体生命周期.html`
- `docs/diagrams/CEOwarmap_雷达自动升级时序.html`
- `docs/diagrams/CEOwarmap_预研到决定时序.html`
- `docs/diagrams/CEOwarmap_会议准备与抽取时序.html`
- `docs/diagrams/CEOwarmap_会后逐项确认时序.html`

## 分片方案

| 顺序 | 文档 | 内容 |
|---|---|---|
| 00 | `00-技术实现路线.md` | 模块依赖、纵向切片、阶段门槛 |
| 01 | `01-基础设施与契约.md` | Monorepo、TypeBox/OpenAPI、PostgreSQL、鉴权、Card/Action |
| 02 | `02-Pi与四层记忆.md` | Pi Runtime、Conversation、Search、compaction、CompanyMemory MCP |
| 03 | `03-Radar与Issue预研.md` | Scheduler、Signal、自动 Issue、ResearchDoc、直接决定 |
| 04 | `04-Meeting与Outcome.md` | Preflight、Transcript、Outcome、逐项效果与撤回 |
| 05 | `05-MonthlyPlan与DRI集成.md` | 月度计划、普通待办、DRI import/export、战场投影 |
| 06 | `06-Web像素级重构.md` | 新 apps/web、Card renderer、稳定 URL、视觉迁移 |
| 07 | `07-测试观测与安全.md` | 测试 seam、LangSmith、health、安全、发布门槛 |
| 08 | `08-联调与部署.md` | 环境、Compose、真实 Provider、备份恢复、cutover |

## 实施方式

严格按 00 的纵向阶段推进。01 是所有模块前置；02 完成后再进入 Agent 业务链；06 在阶段 0 先冻结视觉证据，在后端 Card 稳定后完成接线；08 最后执行。

每个分片只实现自己的完成条件。不得借实现某一分片提前引入队列、多 Runtime、通用工作流、移动端、语音或任务系统。
