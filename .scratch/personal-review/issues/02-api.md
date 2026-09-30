# 02 · 个人复盘 API、MCP 工具与交齐后的衔接

Type: implementation
Status: ready-for-agent
Blocked by: 01（契约，已完成：`packages/contracts/src/personalReviews.ts`，以及 `monthlyReviews.ts` 新增的 item 状态 `waiting`、通知 kind `personal_todo`，`conversations.ts` 新增 scope `personal-review:<id>`）

先读 `.scratch/personal-review/spec.md`（设计与已确认决定）和上面的契约文件；契约是对外约定，不要改字段（确实需要改先停下来在汇报里说明原因）。现有月末复盘实现在 `apps/api/src/monthlyReviews.ts`、`monthlyReviewService.ts`、`monthlyReviewAgents.ts`、`monthlyReviewScheduler.ts`、`routes/monthlyReviews.ts`，照它的写法做（Action 签名、行锁、版本号、幂等、投影、现算通知）。

## 要做什么

### A. 数据

- 新 migration（编号接在现有最大编号之后）：`personal_reviews`
  - `id, version, monthly_review_id, period, person_id, status, draft_source, draft_error jsonb, self_review jsonb, submitted_at, skipped_by, skipped_at, action_fingerprints, created_at, updated_at`；`UNIQUE(monthly_review_id, person_id)`；status / draft_source 用 CHECK 约束成契约里的取值。
  - `monthly_review_items.status` 的 CHECK 加上 `waiting`。

### B. 创建（幂等）

- `ensurePersonalReviews(reviewId)`：为被复盘月份 `missions` 表里有 Mission 的每个 owner（且在人员名单里）建一份 `waiting`；已存在的不动；复盘已不是 `collecting` 时不建。
- 调用点：`createMonthlyReview`（调度器与 `monthly-review.open` 两个入口）之后；另外调度器每次 tick 对当前 `collecting` 的复盘调用一次（生产上 9 月复盘可能在部署前已开启，需要补建）。
- 复盘项（战场 / 能力域）的起草时机改为：
  - 新建复盘项时，若该单元在被复盘月份有 Mission 负责人（即有对应个人复盘），状态为 `waiting`，不起草；没有的照旧直接起草。
  - 看板 `complete`（每份个人复盘都是 `submitted` 或 `skipped`）的那一刻：所有 `waiting` 的复盘项转 `drafting` 并起草；已是 `draft` / `returned` 的复盘项不覆盖正文，而是用起草 Agent 的结果为每栏写一条改写建议（沿用 `suggestions` 机制，负责人「采用」才写入）。
  - 起草材料（`monthlyReviewService.ts` 的 materials）加上：该单元上 Mission 负责人的个人复盘四部分（已提交的；跳过的注明「未提交」）。
- 通知 `listMonthlyReviewNotices`：`waiting` 的复盘项对负责人显示「9 月复盘 · 等大家交个人复盘」这类文字，仍指向复盘项页。

### C. 个人复盘 Action（`POST /api/personal-reviews/actions/execute`）

| Action | 执行人 | 前置状态 | 效果 |
|-|-|-|-|
| `personal-review.update` | 本人 | waiting / draft / draft_failed | 写入改动的栏（`PersonalReviewUpdateInput`）→ `draft`；首次写入且 draft_source 为空时记 `manual` |
| `personal-review.submit` | 本人 | draft，且四栏都非空 | → `submitted`；若看板因此 complete，触发 B 的衔接 |
| `personal-review.draft_with_co_agent` | 本人 | waiting / draft / draft_failed，且 `materialCount > 0` | → `drafting`，异步起草；成功 → `draft`（source `co_agent`），失败 → `draft_failed`（带 draftError） |
| `personal-review.skip` | CEO | waiting / draft / draft_failed | → `skipped`（记 skipped_by / at）；若看板因此 complete，触发 B 的衔接 |

- 版本校验、幂等重放、锁内权限校验与现有复盘项一致；响应 `{ review, board }`。
- 进程重启：`drafting` 超过 10 分钟的标 `draft_failed`（同复盘项的恢复逻辑）。

### D. Co-Agent 代起草

- 新 Agent（放 `monthlyReviewAgents.ts` 旁，走同一个 Pi 运行框架、heavy 档，输出用 `MonthlyReviewDraftCandidate` 严格校验）。
- 输入：本人被复盘月份的 Mission 全文（outcome、why、success_evidence、milestones、boundaries）、天枢里该月本人名下执行事项的进展（复用 `monthlyReviewService.ts` 读 weeklyProgress 的查询，按人过滤）、本复盘对话 `personal-review:<id>` 里已上传附件的提取文本。
- Prompt 要点（按飞书《DRI Period Review 使用说明》）：对照承诺写真正发生的结果而不是活动；证据最低充分；区分事实、证据与本人判断；判断不清时写明不确定在哪；「下周期经营重点」只写 Formation Input，不替本人写下月 Mission / 排期；材料里没有的写「缺少材料」，不编造。四部分用 `overall / judgments / nextFocus / escalations`。
- 「材料」= 该 scope 下本人上传的附件（上传即算，不要求已随消息发出；Web 的 `useConversation.uploadFiles` 先上传、发消息时才绑定）的提取文本 + 本人在该对话里发过的消息原文（粘贴的草稿）。`materialCount` 按这两类合计。
- 附件怎么取：看 `conversations.ts` / `routes/conversations.ts` / `materialParser*.ts` 里对话附件的存储与文本提取方式并复用；scope 校验要允许 `personal-review:<id>`，且只有本人能在这个 scope 下对话 / 上传（CEO 只读个人复盘，不在该 scope 发言）。

### E. 读接口

- `GET /api/personal-reviews/board`：成员与 CEO 都可读；当前 `collecting` 的月末复盘（没有则 null）。rows 未交的在前（waiting / drafting / draft_failed / draft），其次按姓名；`href` 只给本人那行（成员 `/me/reviews/personal/<id>`）和 CEO（每行 `/reviews/personal/<id>`）；CEO 对未交的行带 `personal-review.skip`。
- `GET /api/personal-reviews/:id`：本人或 CEO 可读，其他人 404。`toolConnected` = 本人有未撤销、未过期的个人令牌（`personalTokens.ts`）；`materialCount` = 该 scope 已上传附件数；`missions` = 本人被复盘月份 Mission 的 id/code/title/outcome。
- 通知：`listMonthlyReviewNotices` 对本人加 `personal_todo`（未提交且非 skipped 时），文字按状态：waiting「9 月复盘 · 写你的个人复盘」、drafting「9 月复盘 · Co-Agent 起草中」、draft_failed「9 月复盘 · 起草失败，重试」、draft「9 月复盘 · 草稿待你确认提交」；href 指向个人复盘页。

### F. MCP（`apps/api/src/mcpMe.ts`）

- 新工具 `get_my_review`（只读）：返回本人当前个人复盘的 id、status、version、本人 Mission 全文、本月执行事项进展，以及一段写作要求（同 D 的 prompt 要点，说明四部分各写什么）；没有进行中的个人复盘时明确说没有。
- 新工具 `save_review_draft`：入参 `{ version, fields: [{field, text, sources?}] }`，只允许 waiting / draft / draft_failed，写入后 → `draft`，draft_source 记 `agent_tool`；**不能提交**，返回里提示「请到天枢确认后提交」并给出页面链接（用 `PUBLIC_ORIGIN`）。
- `list_pending` 的返回加上待写的个人复盘。
- 更新 MCP server 的 instructions，说明月末会有个人复盘待起草、用这两个工具起草。

### G. 首页展示月份与 10 月任务卡起草

- `readMemberWork`（`memberWork.ts`）：本人在当月没有 `confirmed` 的任务卡、也没有当月 Mission 时，若上月有本人的 Mission，则 `period` / `missions` / `battlefields`（含本月目标）都用上月；`missionCards` 仍包含当月进行中的卡（每张卡自带 period）。`readMemberBattlefield` 跟随同一个 period。onboarding 也调用 `readMemberWork`，确认它在两处都合理（首次引导显示上月也可以）。
- `missionRounds.ts` 的 `draftOwners`：加入「上月 `missions` 表里挂在本战场、owner 在名单里」的人（9 月的 21 条 Mission 是独立导入的，没挂任务卡）。
- 起草输入：`previousCard` 在没有上月任务卡时取本人上月挂在本战场的独立 Mission；新增 `previousReview`：本人上月已提交的个人复盘四部分（没有时 null）。`MissionCardDraftInput` 类型与 prompt 同步说明这两项是起草依据。

## 完成定义

- API 测试（`pnpm --filter @warmap/api exec vitest run --maxWorkers=1`，若 pnpm 因依赖检查报错，直接用 `node node_modules/vitest/vitest.mjs run --maxWorkers=1` 在 apps/api 下跑）：
  - 创建幂等与补建；看板排序、计数、可见性（成员看不到别人的 href 与内容，读别人个人复盘 404）
  - 四个 Action 的前置状态、版本冲突、幂等重放、权限（非本人不能 update / submit，非 CEO 不能 skip）
  - `draft_with_co_agent` 无材料时拒绝；Agent 桩成功 / 失败两条路径
  - 交齐触发：`waiting` 复盘项转起草；`draft` 复盘项只生成建议不覆盖正文
  - MCP 两个新工具（`save_review_draft` 不能提交、状态校验）
  - `readMemberWork` 月份回落；`draftOwners` 包含上月独立 Mission 的人；起草输入带 `previousReview`
- 全量 API 测试与 API 类型检查通过（已有的、与本工单无关的失败如实列出，不修）。
- 更新 web 客户端：在仓库根按惯例重新生成 OpenAPI 客户端（`apps/web/src/lib/api/openapi.json`、`schema.d.ts`，不手改）。

## 追加（2026-09-30，用户第二轮修改）

### H. 72 小时总倒计时（契约 `MonthlyCycle`、`GET /api/monthly-cycle`）

- `monthly_reviews` 加 `cycle_started_at TIMESTAMPTZ NULL`：`ensurePersonalReviews` **第一次**为该复盘建出个人复盘时写入当时时间（之后不再改）；9/28 已开启的 9 月复盘在上线补建时才落起点。
- `GET /api/monthly-cycle`（成员与 CEO 都可读）：取最近一个 `cycle_started_at` 非空的复盘；`deadlineAt = startedAt + 72h`；`nextPeriod` = 下月；`completedAt` = 下月每个战场的 mission round 都 `confirmed` 时最后一个 confirmed 的时间（没有 round 或有未确认的就是 null）；完成后 7 天内仍返回（给「已完成，用时 X」），更久返回 null。
- `stage` 由现状推出：个人复盘未交齐 → `personal_reviews`；复盘 `collecting` → `unit_reviews`；`summarizing` → `company_summary`；`ltco_pending` → `lto_decision`；复盘 closed 但下月计划未签发 → `period_plan`；计划已签发、round 未全部确认 → `mission_cards`；全部确认 → `done`。
- 倒计时只有这一个：任何阶段都不另起计时，也不因进入任务卡讨论而重置。

### I. 任务卡讨论不再自动截止（CEO 手动收）

- `mission_rounds`：去掉 `mission_rounds_window_48_hours` 约束与 `window_pair` 约束里对 `closes_at` 的要求；`mission-round.open` / `reopen` 只写 `opened_at`，`closes_at` 留 NULL（讨论一直开着）。
- 新 Action `mission-round.close`（执行人与 open 相同，前置 `open`）：写 `closes_at = now`，随即走现有「截止后汇总」逻辑（与原先定时到点后的处理相同，立即执行，不等调度器）。按钮文案「结束讨论，开始汇总」，在 round 投影里 phase=open 时给 approver。
- `roundPhase`、`missionCardLine`、调度器、`clock` 相关代码对 `closes_at IS NULL` 的 open 状态正确处理（不会被当成已截止）；`reopen` 的文案改为「重新开放讨论」。
- 相关测试里依赖 48 小时的断言按新规则改（保留断言的意图：开放后不自动截止、手动 close 后进入汇总）。

### J. 改名：LTCO → LTO，PCO → PO（只改人看得到的文字和 Agent 提示词）

- LTO = Long Term Outcome（六个月），PO = Period Outcome（本月）。代码标识符、字段、Action 名、表名都不改。
- 范围：API 里返回给用户的文案（通知、错误信息、动作 label）和各 Agent prompt（`monthlyReviewAgents.ts`、`monthlyDraftAgent.ts`、`missionCardDraftAgent.ts` 等）里出现的「LTCO」「PCO」。Web 端由 Claude 改。

### K. LTO 的定义与滑动窗口（2026-09-30 用户澄清，覆盖 J 中对 LTCO 的理解）

- LTO 有两层：**公司 LTO**（原 LTCO 那一行）与**战场 LTO**（`battlefield_config.six_month_outcome`）。先公司 LTO，后战场 LTO。PO = LTO 在本月的拆分（月度计划里的公司本月目标与各战场本月目标）。
- 审视页（原 LTCO 决定页，`MonthlyReviewPayload.ltco`）：公司 LTO + **只列战场** LTO（`units` 过滤掉能力域；Agent 的 `units` 建议也只给战场）。能力域六个月目标不在这里审，保持原样。
- 每月由汇总 Agent 审视公司 LTO 与各战场 LTO 要不要改（默认倾向保持，证据足够才建议改），CEO 一起审、一起决定。
- 滑动窗口：`ltco.window = { start: 下月, end: 下月 + 5 个月 }`（契约已加）。公司 LTO 与战场 LTO 共用。`decide_ltco` 无论 keep 还是 revise，都把窗口记下来：`company strategy config` 与 `battlefield_config` 各加 `lto_window_start TEXT`（YYYY-MM），决定时写成新窗口起点。汇总 Agent 与月度计划起草 Agent 的 prompt 说明：LTO 覆盖这 6 个月，每月往后滑一个月，新滑入的第 6 个月要被 LTO 覆盖；PO 是窗口第一个月的拆分。

### L. 用户第三轮修改（2026-09-30，覆盖前文冲突之处）

- **复盘是对自己 Mission Card 的复盘，不按能力域推。** 复盘项（MonthlyReviewItem）只按**战场**建，由战场 DRI 审核后交 CEO；不再建能力域复盘项（`createMonthlyReview` 与补建都不建 capability 项；已存在的 capability 项不删，但不再参与「全部确认」判定与通知）。
- 去掉 `item_participant` 通知（不再向单元内 Mission 负责人推「邀请你讨论补充」）；复盘项的讨论与补充接口保留但不再主动通知。
- 战场复盘项的起草：个人复盘交齐后，Co-Agent 按战场把该战场上 Mission 负责人的个人复盘汇成战场复盘草稿，战场 DRI 审核、提交给 CEO。
- **个人复盘由 Co-Agent 先自动起草**：`ensurePersonalReviews` 建出个人复盘时即 `drafting` 并异步起草（材料：本人 Mission 全文 + 天枢执行事项进展；没有上传材料也起草，缺材料处如实写「缺少材料」），成功 → `draft`（source `co_agent`），失败 → `draft_failed`。
- `personal-review.draft_with_co_agent` 改为「按上传材料重新起草」：仍要求 `materialCount > 0`，结果覆盖草稿（Web 会先确认）。MCP `save_review_draft` 与手写照旧可以改写 `draft`。
- 契约 `PersonalReviewStatus` 里的 `waiting` 保留（起草前的瞬间状态），语义不变。
