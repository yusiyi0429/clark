# 当前架构

天枢是 pnpm Monorepo。主应用由 Web、API 和 PostgreSQL 组成；M2 是独立试用服务，向主应用校验登录身份。产品术语见 [CONTEXT.md](../../CONTEXT.md)，接口字段以 `packages/contracts` 为准，最初的设计与分片方案见 [`docs/technical/ceo-warmap`](../technical/ceo-warmap/README.md)（历史材料，不代表现状）。

## 服务与数据归属

| 模块 | 输入 | 责任与输出 |
| --- | --- | --- |
| Web（`apps/web`） | Card、API 响应、SSE | 展示、交互、导航与请求；不访问数据库，不调用模型 |
| contracts | TypeBox schema | OpenAPI 与共享契约；Web 类型由 `gen:client` 生成 |
| API（`apps/api`） | 已认证请求、调度与后台任务、外部回调和事件 | 业务规则、对象版本、Card 投影、Action、模型调用、MCP、外部集成与持久化 |
| PostgreSQL | API 写入 | 业务对象、对话原文与 Runtime 条目、个人记忆、后台任务、追踪关联 |
| 文件卷 | API 上传与解析 | 会前材料、对话附件、会议录音 |
| 本体（tkos.world） | 按人授权的读取，以及明确的产品写入 | 公司事实的权威来源；API 侧只做可重建的只读投影 |
| 飞书 | 企业自建应用 | 免登与用户令牌、长连接事件、消息通知、妙记、多维表格 |
| M2（`apps/m2`） | 主应用会话、私有 bootstrap | 独立拆解与协作，文件状态在 `m2_state` 卷，不覆盖主应用计划 |
| 本机采集器（`tools/collector`） | 成员本机 | 心跳与本机清单上报（本人同意后），API 后台整理 |

生产请求经过宿主机 Nginx、Caddy，再到 Web、API 或 M2；本地 Web 用开发代理。数据库与业务服务只在 Compose 内网暴露。

## 启动与后台任务

`apps/api/src/server.ts` 读取环境变量、应用迁移（`apps/api/migrations`，目前编号到 099，只向前），装配各服务后监听。它同时启动：

- 进程内调度：公司与个人雷达、月度计划、月末复盘、任务卡轮次、采集器健康、周复盘（每周五 15:00 起草）、采集记录整理。
- 公共后台任务 `jobs.ts`：每 5 秒按 `FOR UPDATE SKIP LOCKED` 领一批，失败按退避重试，第 5 次仍失败标为 dead。会后链路、文档变更、信息收集、飞书令牌刷新、飞书事件与通知都注册在这里。
- 飞书长连接（配置了飞书时）：收到事件只落库并排进后台任务。
- 启动补偿：崩溃中断的雷达扫描、预研、会前预审、月度草案、复盘、会后提取和录音处理标为可见的失败，不自动重跑。

## Card、Action 与权限

API 把业务对象投影为固定类型的 Card，带展示数据、导航、对话范围和当前允许的动作；Web 不解释布局 DSL，不自己计算状态迁移。客户端提交动作后，服务端按身份、对象关系、阶段和版本重新校验。CEO、成员、当前战场 DRI、服务令牌、个人 MCP 和管理员视图（`TIANSHU_ADMIN_PERSON_IDS`）各有独立边界。

路由在 `apps/api/src/routes/`，装配入口为 `apps/api/src/app.ts`。

## 业务链路

### 雷达与议题

公司雷达按公司日调度，也接受手动扫描；博查是唯一 Web Search，公众号经 sidecar 的账号级 MCP 读取，另有发布方 feed；个人雷达还读 GitHub Trending。满足确定性门槛的信号自动升级为议题并启动预研；CEO 可以直接决定，或带入会议。个人雷达只服务本人，不升级为公司议题。入口：`radarScheduler.ts`、`radar.ts`、`researchAgent.ts`、`personalRadar.ts`。

### 会议

会议材料、逐字稿和会后结果分开保存。

- 会前材料由 `materialParser.ts` 在受限子进程里解析，供会前预审使用；材料替换受会议阶段与版本约束。
- 逐字稿可来自标准 [`warmap-transcript.v1`](../contracts/warmap-transcript.v1.md)、妙记 Markdown 转换（人员歧义由 CEO 映射、确认后才写入），或会议录音转写（TOS + 火山 ASR，本人声纹用腾讯云与 ffmpeg）。
- 会后整理生成一张会议卡草稿，主持人或创建人整卡确认。会后链路（`meetingFollowThrough.ts`）还负责飞书妙记轮询、会议卡待确认提醒和整卡确认后写本体；会后只有会议卡一个入口，不逐条确认、不代判。

### 目标、任务卡与复盘

月末复盘为下月计划提供输入，CEO 决定 LTCO 后生成下月草案，每月 1 日的生成保留为兜底。月度目标签发后，系统为战场参与者起草任务卡并交给本人准备；全员本人确认后冻结组合快照，后台 Co-Agent 审阅，当前战场 DRI 最终确认。流程以[任务卡契约](../contracts/mission-card-preparation-review.v0.1.md)为准，实现见 `missionRounds.ts` 与任务卡路由。

个人复盘与周复盘由 Agent 起草、逐行核对出处，本人修改后提交；周复盘可写入本体。

### 执行事项、送达与协作

- 执行事项与个人任务（Mission）分开：执行事项有推进人、协作者、完成标准、材料和进展；外部工具可以提交验收，不能替本人确认完成。
- 送达通道（`delivery/`）：请求只对发起人和接收人可见，卡上可问答。
- 信息收集（`collections.ts`）：Agent 起草收集请求，大家共填一张飞书多维表格（`FEISHU_BITABLE_MODE=live` 才写真实表格），后台双向同步与提醒。
- 文档变更（`docChanges.ts`）：在机器人所在的群里 @机器人 贴飞书文档链接即发布，Agent 找出可能被修订或取代的旧文档，确认后向依据旧版的人推送影响卡。

### 个人 MCP 与采集器

`/mcp/me` 使用 OAuth 或个人令牌，能力受本人权限约束，授权流程见 [MCP 指南](../guides/mcp-oauth.md)。采集器用 `collector` 类个人令牌上报心跳，本人同意后才上传本机清单，原文由后台整理、14 天后清空。

### 飞书

飞书接入由 `FEISHU_APP_ID`、`FEISHU_APP_SECRET`、`FEISHU_TOKEN_KEY` 共同开启（`apps/api/src/feishu/`）：免登与用户令牌（AES-256-GCM 加密、按人绑定、后台刷新）、长连接事件、消息通知、妙记读取、多维表格。三项都不配时路由返回 404、不起长连接；只配一部分时 API 启动失败。

## 对话 Runtime

主 API 使用 Pi SDK。生产 Runtime 显式装配模型、工具和场景规则，不加载开发者个人配置。数据库保存对话原文，Pi session 只保存执行与压缩状态；恢复 Runtime 不改写历史用户消息。对象 scope 与人员身份共同决定可见历史。主答模型按档位选择（`conversationModel.ts`），分诊用 `TRIAGE_MODEL` 或轻模型。入口为 `piConversationRuntime.ts`、`routes/conversations.ts` 及相邻的 `conversation*.ts`。

## 公司事实与个人记忆

- **人员目录**：`company-people.v1`，由 `peopleDirectory.ts` 加载；登录、会话角色、本人隔离、人名解析只看它，不从本体推导登录权限（ADR-0027）。
- **本体公司事实**：`query_company` 工具按本人在 `COMPANY_WORLD_ACCESS_FILE` 中被授权的域读取本体正文（`company.ts`、`companyWorld.ts`），投影写在 `MEMORY_STORAGE_DIR/company`，可重建。后台服务（雷达、会前预审、预研、月度起草与复盘、任务卡起草）经 `companyContext.ts` 按 `COMPANY_SYSTEM_PERSON_ID` 的授权读取。读不到时如实说没读到，不用本地资料兜底；`empty` 才表示本体里确实没有。服务令牌不扩大任何人的可见范围（ADR-0027）。
- **个人记忆**：存数据库，只有本人可见。后台从本人的对话中提炼（新增、替代、遗忘），每轮用 `MEMORY_RECALL_MODEL` 从本人记忆目录里挑相关条目；回答里用到时带记忆标记。本人可在记忆页查看、修改、删除、恢复，也可导入资料并逐条确认（`personalMemory*.ts`、`personalDistillation.ts`、`memoryImport*.ts`）。

## 观测

主 API 用 LangSmith SDK（`tracing.ts`）：Thread、Turn、attempt 与真实的 Agent、模型、工具、检索节点，规则见[工程规范](../standards.md#langsmith-观测)。业务与记忆正文照常记录，凭据过滤；只有 `LANGSMITH_TRACING=true` 且有 key 才上报，上报失败不影响业务。基础健康检查不证明外部服务、人员授权或备份恢复可用。

## M2 边界

M2 每次请求向主 API 校验 Cookie，再用私有映射绑定稳定人员；浏览器自报的成员编号不能改变身份。它使用独立 `m2_state` 卷与单进程写锁，不迁移、不覆盖主应用计划，也不继承主应用的确认权限。启动与发布见 [M2 试用](../guides/m2-trial.md)。

## 验证边界

源码说明实现边界，测试说明被覆盖的行为，二者都不能代替真实 Provider、生产发布与数据恢复验收。
