# CEO WarMap 技术方案索引

## 输入

- 产品 Spec：`docs/specs/CEOwarmap_MVP_spec.md`
- 目标设计：`docs/CEOwarmap_目标设计_v0.3.md`
- 领域词表：`CONTEXT.md`
- 决策记录：`docs/adr/`

## 架构图

- `docs/diagrams/CEOwarmap_业务对象关系.html`
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
| 02 | `02-Pi与四层记忆.md` | Pi Runtime、Conversation、Search、compaction、Company / Personal（替代旧 MCP，ADR-0027） |
| 03 | `03-Radar与Issue预研.md` | Scheduler、Signal、自动 Issue、ResearchDoc、直接决定 |
| 04 | `04-Meeting与Outcome.md` | Preflight、Transcript、Outcome、逐项效果与撤回 |
| 05 | `05-MonthlyPlan与DRI集成.md` | 月度计划、普通待办、DRI import/export、战场投影 |
| 06 | `06-Web像素级重构.md` | 新 apps/web、Card renderer、稳定 URL、视觉迁移 |
| 07 | `07-测试观测与安全.md` | 测试 seam、LangSmith、health、安全、发布门槛 |
| 08 | `08-联调与部署.md` | 环境、Compose、真实 Provider、备份恢复、cutover |

## 实施方式

严格按 00 的纵向阶段推进。01 是所有模块前置；02 完成后再进入 Agent 业务链；06 在阶段 0 先冻结视觉证据，在后端 Card 稳定后完成接线；08 最后执行。

每个分片只实现自己的完成条件。不得借实现某一分片提前引入队列、多 Runtime、通用工作流、移动端、语音或任务系统。

## 公司与个人记忆运行配置

- `TKOS_WORLD_API_URL` / `TKOS_WORLD_AGENT_TOKEN`：World 只读服务连接。服务令牌本身不赋予成员可见范围。
- `COMPANY_WORLD_ACCESS_FILE`：API 容器内的只读授权文件路径，例如 `/repo/seed/company-world-access.json`；内容为 `{"稳定personId":["允许的World domain_id"]}`。生产使用真实授权范围，不提交凭据或人员授权文件。
- `COMPANY_SYSTEM_PERSON_ID`：雷达、预审等后台共同读取使用的明确 personId；仍须在上述文件有授权。缺失时后台不能读取公司事实。
- `MEMORY_STORAGE_DIR`：Company/Personal 持久目录的共同根。Compose 使用独立 memory 卷，由 storage-init 初始化为 uid 1000 可写、目录权限 0700；API 继续以非 root 运行。

缺少 World 或授权时主聊仍可工作，公司事实明确显示不可用，不读取旧 Markdown 或页面快照补齐。`healthz.dependencies.companyConfigured` 仅表示连接与授权路径已经配置，不执行网络连通性或授权文件有效性检查；它不影响基础 API 就绪状态。人员 seed 仍须合法。旧 `COMPANY_MEMORY_MCP_TOKEN` 和 `COMPANY_MEMORY_SEED_DIR` 已退出启动配置；`/mcp/company-memory` 返回 404，个人 `/mcp/me` 保留独立授权。
