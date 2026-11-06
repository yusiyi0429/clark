# RFC：执行看板、Agent 验收、调研专题、岗位和本机程序的云端一侧（apps/api）

v0.1 · 2026-11-06 · 分支 `claude/v2-board-api`。设计以 `.scratch/next-phase/设计_执行看板与本机执行_V2_2026-11-06.md` 为准（第 18 节评审结论优先，第 19 节岗位，第 20 节 worker 列表）。决策见 ADR [0034](../../adr/0034-execution-board-cards-are-execution-items.md)（看板）、[0035](../../adr/0035-agent-acceptance-and-growing-roles.md)（Agent 验收和岗位）、[0036](../../adr/0036-local-runner-cloud-side-receives-only.md)（本机程序的云端一侧）。本机程序那一侧见 [local-runner/RFC.md](../local-runner/RFC.md)；交接事项见 [交接.md](交接.md)。

## 0. 一句话

本人在一个 Task 下让伙伴拆卡、把卡交给本机的 Claude Code 去做；本机只把结果单向报上来，云端的 Agent 按三样口径先验收，本人可推翻；验收通过的卡和本人点的专题版本进「准备中」，本人点「出下一版」出交付物。跨 Task 只给 worker 列表。

## 1. 范围

| 做了 | 没做 |
|-|-|
| 契约（`packages/contracts`）、迁移 226–233、看板与卡、拆卡、Agent 验收与推翻、准备中与出下一版、调研专题、岗位与岗位修改、worker 列表、设备令牌与同步接收端、`web_search` 作业、Task 页带进对话（`page` 兜底） | 网页（apps/web，另一会话）；本机程序（apps/local，另一会话）；共享文件那一步（见交接第 2 节）；`/internal` 的拆卡入口（等新 Chat API 接上再开） |

## 2. 代码在哪

每样功能分「作业」（提示词、输入、输出格式和校验）和「接口、数据」（队列、读写库、改卡）。换执行方式时只换作业那一层。

| 功能 | 作业 | 接口、数据 | 路由 | 契约 |
|-|-|-|-|-|
| 看板与卡 | — | `taskCards.ts` | `routes/taskCards.ts` | `taskCards.ts`、`taskCardView.ts` |
| 拆卡 | `cardPlanAgent.ts` | `cardPlanner.ts` | 同上 | 同上 |
| Agent 验收 | `cardAcceptanceAgent.ts` | `cardAcceptance.ts` | 同上 | 同上 |
| 准备中、出下一版 | — | `cardDeliverables.ts` | 同上 | 同上 |
| 岗位 | — | `roles.ts`、预设 `roles/presets/<family>/<key>.md` | `routes/roles.ts` | `roles.ts` |
| 岗位修改 | `roleProposalAgent.ts` | `roleProposals.ts` | `routes/roles.ts` | `roles.ts` |
| 调研专题 | — | `researchTopics.ts` | `routes/topics.ts` | `topics.ts` |
| worker 列表 | — | `workers.ts` | `routes/workers.ts` | `workers.ts` |
| 设备与同步 | — | `localDevices.ts`、`localSync.ts`、`personalTokens.ts`（`local` 令牌） | `routes/local.ts` | `localDevices.ts`；同步载荷是本机程序的 `localRunner.ts` |
| 联网搜索 | — | `mcpWebSearch.ts` | 挂进 `/mcp/me` 见交接第 2 节 | 输入沿用 `agentRuntime.ts` 的 `WebSearchInput` |
| Task 页带进对话 | — | `pageGuides.ts`（`pageFor`）、`taskCards.ts`（`taskPageFacts`） | `chatService.ts` 转发时带 `page` | — |

OpenAPI 路径在 `packages/contracts/src/boardOpenapi.ts` 手列；改契约后 `pnpm --filter @warmap/web gen:client`。

## 3. 数据（迁移）

| 迁移 | 内容 |
|-|-|
| 226 | `tasks` 加 `executor`、`model`、`brief`、`criterion_index`、`criterion_text`；`card_plans`（同一个 Task 只有一个进行中的，部分唯一索引）、`card_drafts` |
| 227 | `research_topics`、`topic_versions`（号从 1 起、`(topic_id, number)` 唯一、`client_id` 去重） |
| 228 | `personal_tokens.client` 加 `local`；`local_devices`、`local_runs`、`local_outputs`、`local_sync_items` |
| 229 | `card_handbacks`；`deliverable_pending_items`（交回或专题版本二选一，进了某一版写 `version_id`） |
| 230 | `roles`、`role_revisions`、`role_proposals`；`tasks.role_id/role_version`、`card_drafts.role_id/suggest_preset_key`、`research_topics.role_id`；`topic_versions.kind` 加 `review` |
| 231 | `local_runs.state` 加 `queued` |
| 232 | `web_search_calls` |
| 233 | `local_devices.slots`、`local_runs.plan_progress`、`topic_versions.local_number` |

V1（约定）用 225，不冲突。

## 4. 看板与卡

- `GET /api/plan-tasks/:taskId/cards`：Task 负责人才给。四列、标记、本机最近两次执行、最近一次交回、进交付物到哪了都是读时算（`stageAndWait`、`cardsOf`）。
- 列：未开始 → 待开始；完成 → 已完成；最近一次交回在排队或在验 → 验收中；其余进行中。进行中的标记按先后：受阻（连续两次没过，或最近两次执行都异常退出）、验收未过（没过、退回的话还没送到本机）、等批准（本机 `waiting_permission`）、等回复（`idle`）、暂停（`exited`）。
- `PATCH /api/me/cards/:id` 改执行方、岗位、模型、交代、对哪条标准（带版本，不对 409）；换岗位时清掉开工时记的岗位版本。
- `GET /api/me/cards/:id/brief`：开工交代（Markdown + 岗位 + Mission + Task + 对哪条标准 + 上次退回的话）。V1 合进来后补约定（证明方式、不做的事）。

## 5. 拆卡

`POST /api/plan-tasks/:taskId/card-plans` 排进队列，伙伴拿到 Task、标准、Mission、已有的卡、本人的岗位、本人没加的预设和本人的想法，出草稿；每张草稿要么配本人的岗位，要么建议一个预设（`suggestPresetKey`）。编号越界、和已有卡重名的算这次没拆完，可以再拆。本人 `card-drafts/accept` 才建执行事项（`clientId` = 草稿 id，重复点不重复建），`dismiss` 去掉。

## 6. Agent 验收

见 ADR-0035。交回的产出是本机点名的那几份（`handback.outputKeys`）。队列：认领带 `run_token`，10 分钟没动重新排，单次 5 分钟超时，每 60 秒和启动时 `recover()`。推翻、重试、标记退回已送达：`POST /api/me/cards/:id/handbacks/:handbackId/{overrule,retry,returned}`。

## 7. 准备中与出下一版

- 验收通过的卡自动进准备中；专题的一版要本人点（`POST /api/plan-tasks/:taskId/deliverable/pending`），可以拿出来。
- `POST …/deliverable/versions/from-pending`：沿用上一版全部材料，加上准备中的各样（产出当文件，`.txt/.markdown` 补 `.md`；链接证据去重；专题版本存成 `标题 · 名字.md`）。超过 10 份文件或 5 个链接回 400 `DELIVERABLE_LIMIT`，什么都不写。会话级咨询锁防同一个 Task 并发出版。

## 8. 调研专题

- `GET/POST /api/me/topics`、`GET/PATCH /api/me/topics/:id`、`GET /api/me/topics/:id/versions/:number`、`GET /api/me/topics/:id/brief?critics=a,b`。
- 只有本人看得到；只归档不删；可以不挂 Task。版本由本机经 `topic_version` 报上来（见第 9 节）。
- 交代带 Mission、Task、标准、岗位、已经存到第几版（`latestVersion`，本机从下一号往下编），以及评审会的挑刺岗位：本人点的（最多 3 个，必须是本人没归档的 critic），没点就是本人的前 3 个。

## 9. 本机程序的云端一侧

- 配对：`POST /api/me/local-devices` 发 `local` 令牌（同一台电脑再配对吊销旧的）；`GET` 列、`DELETE` 吊销。
- 同步：`POST /api/local-runner/sync`（`bodyLimit` 13MB），令牌对应的设备要和 `deviceId` 一致（不一致 403）。每批写设备的 `last_sync_at`、`app_version`、`slots`。条目处理见 ADR-0036：

| 条目 | 云端做什么 |
|-|-|
| `status` | 按序号只往前；记开工时间、结束时间、里程碑 |
| `plan` | 按序号只往前；条目整份替换，`progress` 存 `plan_progress` |
| `evidence` | 记一行 `local_outputs` |
| `artifact` | 扩展名白名单、大小和 sha256 核对，存材料卷，抽文字（PDF、Word 走材料解析进程） |
| `handback` | 只有卡；产出取 `outputKeys` 点名的（拒收过的、不是这张卡的不算）；排 Agent 验收 |
| `topic_version` | 只有专题；号用本机的，撞号排到最后（`local_number` 留本机号）；没名字按种类起名 |
| `topic_version_feishu` | 只有专题；先认本会话的本机号，再按号认；都没有拒收 `VERSION_NOT_FOUND` |
| `cost` | 累计 token 和估价 |

- 第一次报某张卡时记下岗位版本，卡变进行中；只报了等空位（`queued`）的还没开工，卡留在待开始。
- 产出读取：`GET /api/me/local-outputs/:id`（HTML 用材料预览的 CSP，其余 `sandbox`）。

## 10. worker 列表

- `GET /api/me/workers`；伙伴用 `GET /internal/me/workers`（服务令牌 + `X-Owner-Id`，人不存在 404）。
- 只算带岗位的卡和专题。分组：进行中（等你的在前，再按开工时间）、已排队（等开工 `not_dispatched`、等空位 `slot`、等本机上线 `device_offline`）、已完成（今天，上海时间）。验收中的卡在进行中，干活的是云端的验收员。
- `step` 取本机报的 `progress`（n = `step`，label = `current`）；`queuePosition` 是这台电脑上等空位的会话按开工先后排第几，和本机程序的 `queuePosition` 同义。
- 资源：设备 10 分钟内同步过算在线；`running`、`cap` 是在线设备最近一批 `slots` 的 `running`、`max` 相加（没有在线设备报过时 `cap` 为 null）；花费按开工日算今天、本月，只算本机报的。

## 11. 联网搜索（`web_search`）

`runWebSearch`：校验 `WebSearchInput` → 没配博查回 `WEB_SEARCH_NOT_CONFIGURED` → 先占额度（每人每分钟 10 次、每天 200 次，上海时间；一条 SQL 插入，并发时可能多出一两次）→ 调服务器上同一个博查实例（和雷达、对话共用请求间隔和 429 重试）→ 去重、最多 8 条、摘要截到 500 字 → 记成没成和条数。provider 的错误只进日志。挂进 `/mcp/me` 见交接第 2 节。

## 12. 测试

`apps/api/test/`：`taskCards`、`cardPlanner`、`cardAcceptance`、`cardDeliverables`、`roles`、`topics`、`workers`、`localSync`、`mcpWebSearch`，公用 `boardFixture.ts`（本人一个本月 Mission、几个 Task、配对一台电脑并按真实同步载荷报条目）。拆卡、验收、提岗位修改和博查一律打桩。跑法见交接第 1 节。
