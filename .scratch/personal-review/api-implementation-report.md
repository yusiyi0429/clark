# 02-api 实现报告

本次按开工时读取的 A–K 实现。执行期间工单和 spec 被追加了 L（自动起草个人复盘、只保留战场复盘、取消参与者通知），已向用户发出范围澄清；L 尚未纳入当前实现。

## 文件

| 文件（相对 apps/api） | 改动 |
| --- | --- |
| migrations/047_personal_reviews.sql | 新对象、等待状态、周期起点、讨论约束和 LTO 窗口 |
| src/personalReviews.ts | 幂等补建、投影、权限、四个 Action、材料与本人进展、超时恢复 |
| src/personalReviewAgent.ts | heavy 档 Pi 候选 Agent、统一四部分写作要求 |
| src/routes/personalReviews.ts | 三条个人复盘路径及 GET /api/monthly-cycle |
| src/monthlyCycle.ts | 月份运算、六个月窗口、72 小时总周期投影 |
| src/monthlyReviews.ts | 创建等待项、交齐衔接、通知、公司汇总门槛、LTO 投影与决定落库 |
| src/monthlyReviewService.ts | 调度补建、个人异步起草、单元材料、保留正文的建议生成、恢复与运行跟踪 |
| src/routes/monthlyReviews.ts | 注册个人复盘路由，复用现有应用入口 |
| src/monthlyReviewAgents.ts | LTO/PO 提示词、六个月滑动窗口、仅建议战场 LTO |
| src/monthlyDraftAgent.ts | 公司与战场 LTO、六个月窗口及 PO 拆分提示词 |
| src/conversations.ts、src/routes/conversations.ts | 个人复盘 scope 的本人权限、读取未发送附件的服务端 sidecar |
| src/mcpMe.ts | get_my_review、save_review_draft、个人待办及 instructions、写工具限流 |
| src/memberWork.ts | 首页展示月份回落；战场详情和 onboarding 复用此结果 |
| src/missionRounds.ts | 上月独立 Mission 起草对象与 previousReview；无自动截止及手动 close |
| src/missionCardDraftAgent.ts | previousCard 独立 Mission 回退、previousReview 类型和提示词 |
| src/routes/missionCards.ts | mission-round.close Action 分发 |
| src/personalMissionCards.ts | 空截止时间下的讨论、留言归属和重开文案 |
| src/onboarding.ts | 无截止时间的开放讨论文案 |
| test/personalReviews.test.ts | 新增 9 项集成场景，覆盖创建、权限、材料、状态、并发、MCP、周期与跨月起草 |
| test/monthlyReview.test.ts | 等待衔接、仅战场 LTO、窗口和能力域禁止修订 |
| test/missionRounds.test.ts、test/missionRoundReview.test.ts、test/missionRoundRoutes.test.ts、test/missionDraftHome.test.ts | 手动结束、幂等、并发、重开与快照 |
| test/missionCardMigrations.test.ts | 开放讨论允许空截止时间，截止不得早于开放 |
| test/missionCardNotices.test.ts | 通知和 onboarding 改为手动截止，跨月保留上月 Mission 与目标 |
| test/personalMissionCards.test.ts | 写入权限表、候选引用与私有讨论的快照测试改为手动截止；保留已写截止时间的边界态覆盖 |
| test/memberHome.test.ts | 新月份无工作时回落上月 |
| test/personalMcp.test.ts、test/ceoMcp.test.ts | 新工具列表和身份边界 |
| test/migrate.test.ts | 追加 personal_reviews 和 047，迁移总数 47；原 world-02 断言保留 |

未修改 Web、契约或依赖，没有执行 git 写操作。校验了开工时文件哈希：world*.ts、046、world-instance.json、app.ts、server.ts、outcome.ts、routes/system.ts、health.ts 保持一致；helpers.ts 和 observabilitySecurity.test.ts 也保持一致。

## Migration

- `personal_reviews` 按 `(monthly_review_id, person_id)` 唯一，保存版本、状态、草稿来源/错误、四部分正文、提交与跳过留痕、幂等指纹和时间；状态、来源、月份有 CHECK。
- `monthly_review_items.status` 增加 `waiting`。
- `monthly_reviews.cycle_started_at` 只在首次新增个人复盘时写入，以后补建不改起点。
- 删除讨论的 48 小时约束；允许 opened_at 有值而 closes_at 为空。迁移将尚为 open 的旧轮次 closes_at 清空，已汇总/已确认轮次历史保留。
- `company_strategy_config` 与 `battlefield_config` 增加 `lto_window_start`；keep/revise 都记录下月起点，能力域配置保持原样。

## 规则与衔接

看板取最新 collecting 复盘。非 submitted/skipped 在前，同组按中文姓名排序，再按 personId 稳定排序。计数分别给 total/submitted/skipped，全部已提交或跳过才 complete。成员只有自己的 href，其他成员正文读取为 404；CEO 每行可进入详情，且仅对 waiting/draft/draft_failed 提供 skip。成员路径 `/me/reviews/personal/<id>`，CEO 路径 `/reviews/personal/<id>`。

创建个人复盘只取该月 Mission 的在册 owner；已有记录不动，非 collecting 不再补建。创建与调度均调用，月初也会补建仍 collecting 的上月复盘。

最后一次 submit/skip 在事务内先锁月度复盘，再锁个人行，校验身份、重放、版本及状态。交齐时所有 waiting 项转 drafting；已有 draft/returned 只异步生成每栏 suggestions，采用后才改正文。并发交齐与重放不重复触发。单元材料带该单元 Mission owner 的已提交四部分，跳过者仅注明“未提交”。公司汇总须个人交齐且单元全确认；部署前已确认单元的情况也能衔接。

## Co-Agent 与 MCP

个人 Co-Agent 使用同一 Pi Candidate Runtime、heavy 档和 `MonthlyReviewDraftCandidate` 严格校验；失败可见，超过 10 分钟的 drafting 恢复为 draft_failed，旧版本 run 不覆盖恢复后的记录。

材料从“本人 + personal-review:<id>”未删除会话读取：枚举会话附件目录，复用 `loadConversationAttachments` 读取服务端 sidecar 中 extractedText，因此上传尚未发送也算；再取 role=user 的消息原文，排除 assistant。materialCount 为附件数与本人消息数之和。Mission 带完整承诺字段；执行进展按事项 owner 过滤，包含独立事项，沿用单元复盘的被复盘月到次月首周补记范围。

| MCP 工具 | 输入 | 输出 |
| --- | --- | --- |
| get_my_review | `{}` | 本人当前 id/status/version/selfReview/period/personId、Mission 全文、weeklyProgress、writingRequirements；无复盘时 `{review:null,message}` |
| save_review_draft | `{version, fields:[{field,text,sources?}]}` | 最新 id/status/version/selfReview、提示“请到天枢确认后提交”、PUBLIC_ORIGIN 绝对页面链接 |

MCP 保存只允许 waiting/draft/draft_failed，记 source=agent_tool；不接受 submit 等额外参数，没有提交工具。list_pending 对各身份增加本人未完成个人复盘；CEO 的公司只读待办仍保留。省略 sources 时保留原来源，重复相同请求幂等，过期版本冲突。

## 月份、任务卡与窗口

当月既没有本人 confirmed 卡、也没有本人 Mission，且上月有本人 Mission 时，首页 period/missions/战场本月目标都回落上月；当月进行中的卡仍保留并带自己的 period。战场详情和 onboarding 读取相同结果。

10 月起草对象包含 9 月挂本战场的独立 Mission 在册 owner；有上月卡时 previousCard 取卡，没有时取本战场上月独立 Mission。previousReview 只取本人上月 submitted 的四部分，否则 null。

总周期 deadlineAt 固定为首次补建时间 +72h；阶段依现状从个人复盘、单元复盘、公司汇总、LTO 决定、计划签发、任务卡流转到 done。下月每个战场都已有 confirmed round 才完成，completedAt 取最晚 confirmed_at；缺 round 不算完成。完成七天后不再返回。open/reopen 不改总起点，不设讨论截止；close 由现有 approver（CEO 或战场 DRI）立即汇总。

LTO 审视只投影公司和战场，窗口为下月到下月 +5 个月。Agent 的能力域修订建议会被拒绝，CEO 也不能通过决定 Action 改能力域目标。公司和战场共用滑动窗口，PO 是窗口第一个月的拆分。

## 待协调

1. 执行期间新增的 L 节尚待范围答复。当前 A–K 行为仍是个人先 waiting、按材料手动触发 Co-Agent，并保留能力域复盘与 item_participant 通知；Web 已按 L 自动起草语义展示 waiting 并隐藏起草入口，需统一后再验收端到端流程。
2. Web 复用了单元复盘的 `OPTIONAL_FIELDS=["escalations"]`，提示可以留空；个人 Action 按工单“四栏非空”拒绝空值，无事项时填写“无”。未擅自修改 Web 或契约。
3. OpenAPI Web 客户端没有重新生成：用户明确禁止修改 apps/web，契约和生成产物由 Claude 管理。

## 验证

已覆盖全部 **76 个测试文件、799 个测试**。按默认测试时限、用修改后的相关测试结果替换旧结果后汇总：**789 通过、10 失败、0 跳过**。剩余 10 条失败中，9 条是下表的部署脚本问题，1 条是导入 CLI 的默认 5 秒超时；没有尚未解决的本工单业务断言失败。

- API 类型检查：`node node_modules/typescript/bin/tsc --noEmit -p .` 退出 0；`git diff --check -- apps/api` 通过。
- 新功能与最初相关测试：53 通过、0 失败。全量另发现 10 条仍依赖自动截止的旧断言，已按 I/G 节改为手动 close 和跨月回落；两个文件复验 **25 通过、0 失败**，原通知、权限、快照和候选内容断言保留。
- 所有测试使用 `TEST_PG_URL=postgres://postgres:postgres@localhost:55432/postgres`、直接 node 调用 Vitest、`--maxWorkers=1`。普通全量进程出现 IPC channel closed 或 Windows 访问冲突（退出码 -1073741819），因此改为各文件独立进程串行运行；其中 6 个进程崩溃的文件再以 forks 池运行，均取得完整报告。这不是一次单进程全量绿灯。
- `missionDraftScript.test.ts` 的唯一测试（usage + 幂等导入）在默认 5 秒下超时，重复执行也超时；仅命令行放宽为 `--testTimeout=15000` 后 **1 通过、0 失败**。未修改该测试、导入脚本或全局超时。这是本机运行耗时问题；该诊断结果未替换上面的默认时限统计。若计入放宽时限后的结果，则为 **790 通过、9 失败**。
- 原始全量与重跑结果：`api-full-final.json`；最终计数与失败列表：`api-validation-summary.json`；截止规则复验：`cutoff-verification.json`；超时复现与诊断：`import-verification.log`、`import-timeout-diagnostic.json`。均在本报告同目录，原始失败记录保留。

`deployment.test.ts` 已完整执行：21 通过、9 失败。下面每项均与本工单无关；测试调用的是未改动的 backup/restore shell 脚本及其命令桩，没有调用本次修改的复盘模块。未修改这些测试或部署脚本。当前证据能确定失败断言和发生位置；没有为无关问题继续做跨平台根因修复。

| 失败场景 | 实际失败 | 与本工单关系 |
| --- | --- | --- |
| backup 默认 compose 容器内 pg_dump | 命令桩日志为空，缺少预期 pg_dump 调用 | 无关 |
| backup 暂停运行中的 API 并通过 trap 恢复 | 日志中查不到预期调用顺序，索引为 -1 | 无关 |
| backup target=local 与 compose override | 命令桩日志为空，缺少 override 参数 | 无关 |
| restore 默认 dry-run 拒绝非空数据库 | 提前报归档 checksum 不匹配，未到“拒绝覆盖”断言 | 无关 |
| restore 空数据库与显式 --execute | 预期退出 0，实际退出 1 | 无关 |
| restore 拒绝非空目标卷 | 提前报归档 checksum 不匹配，未到目标卷检查 | 无关 |
| restore 拒绝存储文件 SHA 与数据库不符 | 提前报归档 checksum 不匹配，未到存储校验 | 无关 |
| restore 显式空卷并逐个验证 storageKey/SHA | 提前报归档 checksum 不匹配，未到存储校验 | 无关 |
| restore 仅数据库并声明不恢复卷 | 预期退出 0，实际退出 1 | 无关 |

Agent 行为用成功、非法输出/失败及迟到结果等测试桩验证；未调用真实生产模型或发布服务。

已检查新增模块与分支的必要性：月份运算用于周期、窗口和跨月回落；附件枚举用于“上传即材料”；事务桥接用于并发交齐。没有引入新依赖、通用框架或工单之外的业务行为。

## L 节（2026-09-30）

- 新建复盘只建战场项；重复开启与调度器补建均不建能力域项。已有能力域项保留在 CEO 总览和原有读写接口中，但不参与全部确认判定、个人复盘交齐后的战场起草，也不出现在通知里。删除 `item_participant` 通知；讨论与补充接口保留。
- 新个人复盘在事务中直接置 `drafting`，提交后异步用本人 Mission、执行进展及已有附件/消息起草；无上传材料也起草。成功为 `draft`（`co_agent`），失败为 `draft_failed`；调度器补建同样启动。战场项仍在个人复盘交齐后起草，并把该战场负责人的个人复盘作为材料。手动 Co-Agent 动作为「按材料重新起草」，要求上传或粘贴材料并覆盖原草稿。`waiting` 保留在契约与兼容路径，不作为新建后的停留状态。
- 个人提交只要求总体结果、关键判断和下周期重点非空；待上层决策事项可空，错误提示和 Agent 写作要求同步调整。Web 现有占位提示已写“没有可以不写”，并复用 `OPTIONAL_FIELDS=["escalations"]`；按本轮禁止修改 `apps/web` 的要求，无须改 Web 或契约。
- 更新旧断言并补测自动起草成功/失败、调度器补建、仅建战场项、已有能力域项不阻塞/不通知、无 `item_participant` 通知、按材料覆盖草稿和空 escalations 提交。相关测试 **29 通过、0 失败**；API 类型检查通过，`git diff --check -- apps/api` 通过。
- 全量覆盖 **76 个文件、800 条测试**。单进程在完成 38 个文件后出现 `ERR_IPC_CHANNEL_CLOSED`；剩余 38 个文件逐个独立进程补跑均通过。观测性测试在单进程中有 1 条波动失败，单文件复跑 **9/9 通过**。按默认 5 秒时限和复跑结果合并，**790 通过、10 失败**：部署脚本 9 条、导入 CLI 超时 1 条，均与 L 节无关。原始与补跑日志保存在同目录的 `l-full-test.log`、`l-batch-*.log`、`l-observability-recheck.log`。
- 未改 `apps/web`、`packages/contracts`、world-02 文件或依赖；未做 git 写操作。未调用真实模型或发布服务。没有待协调事项。
