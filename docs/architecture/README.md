# 当前架构

天枢使用 pnpm Monorepo。主应用由 Web、API 和 PostgreSQL 组成。M2 是独立试用服务，通过主应用校验登录身份。

产品术语见[领域上下文](../context.md)。接口字段以 `packages/contracts` 为准。历史方案见[历史设计索引](history/README.md)，不得据此恢复已退出的实现。

## 服务与数据归属

| 模块 | 输入 | 责任与输出 |
| --- | --- | --- |
| Web | Card、API 响应、SSE | 展示、交互、导航与请求。不访问数据库或模型 |
| contracts | TypeBox schema | OpenAPI 与共享契约。Web 类型由生成器产出 |
| API | 已认证请求、调度事件、外部返回 | 业务规则、对象版本、Card 投影、Action、模型调用与持久化 |
| PostgreSQL | API 写入 | 业务对象、对话原文、Runtime entries、作业与追踪关联 |
| 文件存储 | API 上传、解析与记忆投影 | 材料、附件、录音及 Company/Personal 文件 |
| World | 人员授权下的读取或明确产品写入 | 公司事实权威；阅读投影不能反向覆盖权威事实 |
| M2 | 主应用会话与私有 bootstrap | 独立拆解、协作和文件状态，不覆盖主应用计划 |

生产请求依次经过宿主机 Nginx、Caddy 和对应服务。本地 Web 使用开发代理。Compose 的数据库与业务服务只在内部网络暴露。

## Card、Action 与权限

API 将业务对象投影为固定 Card 类型。Card 包含展示数据、对象导航、对话范围及当前允许动作。Web 不解释通用布局 DSL，不自行计算业务状态迁移。

客户端提交动作后，服务端重新检查身份、对象关系、阶段和版本。展示过按钮不等于仍有写权限。CEO、成员、当前战场 DRI、服务令牌和个人 MCP 各有独立边界。

主入口见 `apps/api/src/app.ts`。启动及依赖装配见 `apps/api/src/server.ts`。契约变化先修改 `packages/contracts`，再运行 `pnpm --filter @warmap/web gen:client`。

## 业务链路

### 雷达与议题

公司雷达按公司日调度，也接受手动扫描。博查提供 Web Search，公众号通过账号级 MCP 读取。缺少配置或拉取失败时如实显示。

信号经过确定性门槛后自动升级为议题。预研生成候选材料。CEO 可以直接决定，或把议题带入会议。预研未完成时的直接决定需要明确确认，并记录真实预研状态。

个人雷达与公司雷达隔离。个人信号只服务本人，不升级为公司议题。

实现入口包括 `radarScheduler.ts`、`radar.ts`、`researchAgent.ts` 与 `personalRadar.ts`。具体文件以 `apps/api/src` 为根。

### 会议输入

会议材料、逐字稿和会后结果是不同数据。会议材料供会前预审使用。会后抽取使用确认的逐字稿。两者不得混作同一事实源。

- 标准逐字稿使用 [warmap-transcript.v1](../contracts/warmap-transcript.v1.md)。任一发言段不合规时整份拒绝。
- 妙记 Markdown 按固定结构转换。人员歧义由 CEO 映射，候选经明确确认后才写入逐字稿。
- 录音转写使用 TOS 与火山 ASR。本人声纹依赖腾讯服务和 `ffmpeg`。配置缺失时对应能力不可用。
- 会议候选与逐项确认分开。Agent 不自行确认会后结果。

普通会议材料的解析限制由 `materialParser.ts` 与解析 worker 执行：

| 项 | 限制 |
| --- | --- |
| 文件类型 | 有文字层 PDF、DOCX、UTF-8 Markdown；受控 HTML 入口另有 allowlist |
| 文件与批次 | 单文件 20 MiB；每批 10 份、100 MiB |
| PDF | 最多 500 页；无有效文字层不能作为可读材料 |
| DOCX | 1,000 ZIP entries；总解压 250 MiB；单 entry 50 MiB；压缩比 200:1 |
| 时间 | 单文件 15 秒；整批 90 秒 |
| 文本 | 每份 100,000 字符；预审输入总计 300,000 字符 |
| HTML | 受控入口最多 2,000,000 字符，经服务端清理 |

解析在受限 Node 子进程执行，不是独立 worker 服务。材料替换必须遵守会议阶段与版本检查。整批失败不得部分替换。历史参数背景见[会议原始方案](history/meeting-outcome.md)。

### 月度目标与任务卡

月末复盘为下月计划提供输入。CEO 确定 LTCO 后生成下月草案。每月 1 日的生成任务保留为兜底。

月度目标签发后，系统为战场参与者起草任务卡。本人准备阶段只向本人开放正文。上级查看进度，不能提前读取未确认内容。

全员本人确认后，服务端冻结组合快照，后台 Co-Agent 审阅。当前战场 DRI 最终确认组合。需要改文时，DRI 定向退回受影响卡；本人修改再确认。

实现以 `missionRounds.ts`、任务卡相关路由及[当前契约](../contracts/mission-card-preparation-review.v0.1.md)为准。旧公开讨论和截止快照流程只保留历史审计，不扩张当前权限。

### 执行事项与个人 MCP

执行事项与个人任务分开。执行事项保存推进人、协作者、完成标准、材料和进展。外部工具可以提交验收，不能替本人确认完成。

个人 `/mcp/me` 使用 OAuth 或个人令牌。对外能力不等于 CEO 业务权限。授权流程见 [MCP 指南](../guides/mcp-oauth.md)。

## 对话与 Runtime

主 API 使用 Pi SDK。生产 Runtime 显式装配模型、工具和场景规则，不加载开发者个人配置。独立场景模块维护 Prompt；部分 Prompt 仍内嵌在模块中。

数据库保留对话原文。Pi session 只保存执行和压缩状态。恢复 Runtime 不得改写历史用户消息。

当轮 Query、Anchor 和 Reference 分开处理。服务端根据权限重新读取 Card。临时场景与参考信息不写入用户原话。对象 scope 与人员身份共同决定可见历史。

实现入口为 `piConversationRuntime.ts`、`candidateAgentRuntime.ts`、`turnContext.ts` 和相邻对话模块。主私聊的只读工具边界不能机械套用到任务卡本人改文场景。

## 公司记忆与个人记忆

Company 从授权 World 整理阅读投影。`worldReader.ts` 读取业务对象；列表中的 `StateSnapshot` 不作为独立业务对象解析，业务记录仍携带最新状态和确认复盘。

访问范围由稳定人员标识与允许的 domain 决定。后台任务使用明确的系统人员。服务令牌本身不授予全公司读取权。

Personal 保存本人偏好与协作约束。主私聊将当前轮证据交给后台蒸馏。候选校验通过后才写入记忆；工具提交成功不代表写入成功。

`/mcp/company-memory` 已停用。不得用本地旧 Markdown 补作公司事实。完整边界见 [ADR-0027](../adr/0027-company-world-and-personal-memory.md)。

## 观测与故障

主私聊和共享候选 Runtime 使用 LangSmith SDK。Thread、Turn、attempt 和真实模型／工具节点按 [ADR-0028](../adr/0028-langsmith-thread-turn-spans.md)关联。

获准的业务正文完整记录。凭据继续过滤。上传失败不改变业务结果。用量与首 token 事件缺失时保留缺口，不估算。

API 启动先执行迁移，再启动依赖与监听。数据库迁移只向前。基础 health 不证明全部外部服务、人员授权或备份恢复可用。

## M2 边界

M2 在每次请求中向主 API 校验 Cookie，再用私有映射绑定稳定人员。浏览器自报的成员编号不能改变身份。

M2 使用独立 `m2_state` 卷与单进程写锁。技能随代码部署，新轮保存技能快照。产品 World 只读凭据缺失时禁用新轮生成，已有计划仍可协作。

M2 不迁移、覆盖主应用计划，也不自动继承 CEO 或工作台视角的确认权限。启动与发布见 [M2 指南](../guides/m2-trial.md)。

## 验证边界

源码说明实现边界，测试说明被覆盖的行为。二者都不能代替真实 Provider、生产发布与数据恢复验收。当前限制集中记录在[领域上下文](../context.md#已知限制与待验证项)。
