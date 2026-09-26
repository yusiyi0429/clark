# 工单 04 · 本月 Mission Card · 实施设计（04a–04d）

- 日期：2026-09-27
- 来源：Claude 调研 Agent 的只读调研（依据 MVP 的 `CLAUDE.md`、`CONTEXT.md`、`spec.md` §6/§7/§9、`inventory.md` §2；SSOT v0.3；概念代码 `clark-main/src/components/mission-cards/*`、`dri/mission-card-*`；MVP 代码）。经 Claude 审阅，并定下 §0 的四点。
- 路径默认相对各自仓库根目录；冒号后是行号。行号以 2026-09-27 读取时为准，实现时先重新核对。

## 0. 结论与已定事项

**关键决定**
1. **M-01 由已有的月度计划签发承担**（只有 CEO 能签，`apps/api/src/monthlyPlans.ts:546-614`）。只有当 `monthly_plans(period).status='confirmed'`，并且计划里有这个战场的本月结果时，才能整理草稿、开放讨论。
2. **个人任务就是 `missions` 表的一行。**
   - `missions` 补 4 个字段，再加 `placeholder` 标记。
   - 个人卡用新表 `personal_mission_cards`，id 是稳定的 UUID；Mission 通过新列 `missions.personal_mission_card_id` 挂到卡上。
   - 一轮制定用新表 `mission_rounds`，`(battlefield_id, period)` 唯一。
3. **草稿阶段就把 Mission 写进库**：版本 v1，`placeholder=true`。挂在卡上的 Mission，`mission.edit` 一律返回 409。确认时把采纳的修改写回 Mission，版本 +1。
4. **意见单独存进新表 `mission_card_feedback`，不进 `thread_messages`。** 左侧的意见卡和右列的「事项群组」都读这张表。分隔线和 Co-Agent 开场由服务端按记录算出，不存库。
5. **拍板人的动作沿用现有 Action 模式**：签名 actionId + version + fingerprint 幂等。
   - 走新端点 `POST /api/mission-rounds/actions/execute`（登录即可调用），在动作内部复查「CEO 或该战场 DRI」。
   - 现有的 `/api/actions/execute` 只放行 CEO，不动它。
6. **截止时刻以库里为准**：`closes_at = opened_at + 48h`，写成 CHECK 约束。
   - 截止快照由 60 秒一次的定时任务和写入路径上的 `closeIfDue` 触发。
   - 前端只有一个分钟时钟，对齐到 `closesAt` 的秒位，用 `serverNow` 校正本机时钟偏差。
   - 演示窗口、演示控制台、演示拨钟一律不做。
7. **集中 Review 是确定性的规则汇总**：快照、同字段冲突、依赖条数。不是 AI 语义 Review，界面写明。

**Claude 定下的四点**（2026-09-27，依据产品论证 `why.md` 和 SSOT）

- **A. 10 月不出「原件」页签。**
  - 10 月没有 10 月的原件；ADR-0019 §6 规定飞书正文不进仓库，也不进 Card。
  - 这一轮直接显示个人任务（即 DRI-03 的"缺原件"分支），版本行给出 9 月飞书来源链接。
  - AC-17 在 10 月不适用。
- **B. 10 月 Mission 编号用 SSOT 个人任务 id 的规则**，如 `renhao-202610-a`；code 和 id 用同一个值，全表唯一的约束不动。这样全是 ASCII、跨月不重复，也避开了中文 id 的编码问题。
- **C. 先签发 10 月目标，再有个人卡草稿**（M-01 → M-02）。但不依赖运维手动跑脚本：
  - 新增拍板人动作 **`mission-round.draft`**，按钮文字「整理个人卡草稿」。
  - 可用条件：当月计划已签发且含本战场结果；服务端能在 `MISSION_CARD_DRAFTS_DIR`（默认 `seed/placeholders`，部署时随 `seed/` 只读挂载）里找到这个战场、这个月的草稿文件；这一轮还不存在。
  - 按下即在一个事务里建轮次、卡和 Mission，和导入脚本调用同一个函数。
  - 入口：CEO 通知栏「战略决策更新」里的「{M} 月 Mission Card · {战场} · 可以整理个人卡草稿」，确认弹窗写明「草稿是占位：Agent 起草未接入，沿用 9 月个人卡」。
  - 导入脚本保留，给运维或测试用。
- **D. 10 月讨论候选只挂战场 01**：12 项个人任务在 SSOT 里都只属于 01，跨战场卡（GAP-01）还没定规则。文件里逐条注明。

## 1. 对象映射与数据变更

### 1.1 概念版与 MVP 的对照

| 概念（`mission-cards/model.ts`） | MVP | 备注 |
|---|---|---|
| Batch `${battlefieldId}:${period}`（:29、:38） | `mission_rounds` | `UNIQUE(battlefield_id, period)` |
| `goals{ltco,pco,approved}`（:29、:50-55） | 月度计划签发 + `round.goal_snapshot` | 六个月目标取 `battlefield_config.six_month_outcome`，本月目标取 `monthly_plans.battlefields[].outcome`；开放时冻结（M-01：开放后不得覆盖依据） |
| Card `{id,ownerId,period,tasks,members}`（:10） | `personal_mission_cards` + 挂在下面的 Mission | `members` 建卡时按规则算出后保存（D-03：群组成员按对象保存） |
| Task（13 字段） | `missions` 行 | 见 1.2 |
| Feedback（:25） | `mission_card_feedback` | kind 改名：group → `comment`，highlight → `quote`，proposal → `suggestion` |
| Review + pastReviews（:26、:29） | `mission_round_reviews` + `mission_review_decisions` | 候选版本不存库，读的时候现算 |
| Reopen（:28） | `mission_rounds.reopens` jsonb | `{by, at, closedAt}` |
| privateMessages（:32-34） | conversations 表，新 scope `mission-card:<cardId>` | 私聊，永远不进 Review |
| drafts、demoClockOffsetMs、已读（localStorage） | 草稿只留在浏览器；演示时钟删除；已读存 `mission_card_reads` | |
| cardArtifacts（原件） | 本期不落库 | 见 0.A |

### 1.2 13 字段到 Mission 的映射

| # | 字段 | Mission 列 | 现状 | 占位时怎么转 |
|---|---|---|---|---|
| 1 | 名称 | `title` | 已有 | 原样 |
| 2 | Why／背景 | `why` | 已有 | 原样 |
| 3 | 预期结果 | `outcome` | 已有 | 原样 |
| 4 | 成功证据 | `success_evidence` string[] | 已有 | 取 `e.text`；status 不落库（MVP 不跟踪执行） |
| 5 | 唯一责任人 | `owner_id` | 已有 | 卡的 Owner，**不接受修改建议** |
| 6 | 边界 | `boundaries` TEXT | 已有 | 写成 `包含：a；b\n不包含：c；d` |
| 7 | 关键路径 | `key_path` | **新增** | 原样 |
| 8 | 里程碑 | `milestones` string[] | 已有 | `待定 · {去掉开头日期段的 label}` |
| 9 | 资源与权限 | `resources` | **新增** | 原样 |
| 10 | 依赖 | `dependencies` TEXT | 已有 | 数组用 `\n` 连起来 |
| 11 | 人-Agent 分工 | `human_agent_split` | **新增** | 原样 |
| 12 | 风险与升级 | `risk` | 已有 | 原样 |
| 13 | 复盘沉淀 | `retrospect` | **新增** | 原样 |

- **可以提修改建议的字段**（`MissionCardField`）：title、why、outcome、successEvidence、boundaries、keyPath、milestones、resources、dependencies、humanAgentSplit、risk、retrospect。
- 列表字段（successEvidence、milestones）的建议文本按行拆开：去掉空行，最多 30 行，每行不超过 500 字，和 `packages/contracts/src/missions.ts:15` 的 MissionLines 一致。
- MVP 放开列表字段的修改建议（概念版只放 7 个正文字段，见 `card-document.tsx:32`），是因为 10 月的里程碑全是「待定」，讨论时必须能改日期。

### 1.3 迁移（04a 一次建好）

- 编号：030、031 预留给工单 01（`person_onboarding`）和工单 02（个人雷达）；本期从 032 开始。
- 写之前核对编号是否已被占用；如果 02 还没做、031 空着，照样从 032 开始，不挪用 031。

**`032_mission_card_fields.sql`**：`missions` 增加 `key_path`、`resources`、`human_agent_split`、`retrospect`（都是 TEXT NOT NULL DEFAULT ''），以及 `placeholder` BOOLEAN NOT NULL DEFAULT false。

**`033_mission_rounds.sql`**

- `mission_rounds` 的列：
  - `id` uuid PK；`version` int >0；`battlefield_id` → `battlefield_config`；`period`（CHECK 同 009）；`monthly_plan_id` → `monthly_plans`
  - `status` CHECK in (draft, open, reviewing, confirmed)
  - `draft_origin` CHECK in (placeholder, agent)；`draft_source` jsonb（文件名、sha256、schema、importedAt）
  - `goal_snapshot` jsonb，可空
  - `window_seq` int ≥0；`first_opened_at`、`opened_at`、`closes_at`；`reopens` jsonb 默认 `[]`
  - `confirmed_by`、`confirmed_at`；`action_fingerprints` jsonb 默认 `[]`；`created_at`、`updated_at`
- `mission_rounds` 的约束：
  - `UNIQUE (battlefield_id, period)`
  - `CHECK ((opened_at IS NULL) = (closes_at IS NULL))`
  - `CHECK (closes_at IS NULL OR closes_at = opened_at + interval '48 hours')`
  - `CHECK ((status = 'draft') = (opened_at IS NULL))`
  - `CHECK ((status = 'confirmed') = (confirmed_at IS NOT NULL))`
- `personal_mission_cards`：
  - 列：`id` uuid PK；`round_id` → `mission_rounds`；`owner_id`；`sort_order` int；`role_label` TEXT 可空（如「01-3 战役 DRI」「参与 DRI」）；`member_ids` jsonb array；`created_at`
  - `UNIQUE(round_id, owner_id)`
- `missions` 增加 `personal_mission_card_id` uuid，可空，引用 `personal_mission_cards`，并加索引。

**`034_mission_card_discussion.sql`**

- `mission_card_feedback` 的列：
  - `id` uuid；`seq` BIGSERIAL UNIQUE；`round_id`；`card_id`；`mission_id` → `missions`（可空，空表示针对整张卡）
  - `field`：可空；有值时必须是 `MissionCardField` 的 12 个值之一
  - `kind` in (comment, quote, suggestion)；`author_id`；`client_id` uuid
  - `body` 1–4000 字；`quote` ≤2000；`proposed` ≤4000；`original` TEXT（服务端抄下的原文）；`source_version` int
  - `basis` in (draft, candidate)；`window_seq` int >0；`late` bool
  - `created_at` timestamptz NOT NULL，由应用时钟写入
- `mission_card_feedback` 的约束：
  - `UNIQUE (author_id, client_id)`
  - `CHECK (field IS NULL OR mission_id IS NOT NULL)`
  - suggestion 必须带 `mission_id`、`field`、`proposed`、`original`、`source_version`，且不能是截止后留言：`CHECK (kind <> 'suggestion' OR (mission_id IS NOT NULL AND field IS NOT NULL AND proposed IS NOT NULL AND original IS NOT NULL AND source_version IS NOT NULL AND NOT late))`
  - quote 必须带 `field`、`quote`、`source_version`：`CHECK (kind <> 'quote' OR (field IS NOT NULL AND quote IS NOT NULL AND source_version IS NOT NULL))`
  - comment 不带 `quote`、`proposed`：`CHECK (kind <> 'comment' OR (quote IS NULL AND proposed IS NULL))`
- `mission_card_feedback` 的索引：`(card_id, seq)`、`(round_id, created_at)`。
- `mission_round_reviews`：
  - 列：`id`；`round_id`；`window_seq`；`snapshot_at`（等于这一轮窗口的 `closes_at`）；`taken_at`；`feedback_ids` jsonb；`mission_versions` jsonb（`{missionId: version}`）；`note` TEXT 可空；`applied_versions` jsonb 可空；`superseded_at` 可空
  - `UNIQUE(round_id, window_seq)`
- `mission_review_decisions`：
  - 列：`review_id`、`feedback_id`、`decision` in (accept, decline)、`decided_by`、`decided_at`、`carried` bool
  - PK `(review_id, feedback_id)`
- `mission_card_reads`：
  - 列：`card_id`、`person_id`、`last_read_seq` bigint、`updated_at`
  - PK `(card_id, person_id)`

所有时间（开放、截止、意见写入）都用应用时钟 `ctx.now()`，不用数据库的 `now()`。这样测试能拨时钟，窗口判断也只有一个时间来源。

### 1.4 稳定 ID 与版本

- **轮次**：UUID。`version` 在每次开放、截止快照、逐条处理、重开、确认时 +1。意见写入**不**改它，否则多人同时讨论会互相打回。`window_seq` 就是「第几轮」。
- **个人卡**：UUID。从草稿到已确定、跨重开都不变（C-02：同一对象 ID、同一群组）。卡本身没有版本，内容就是它下面的 Mission。
- **Mission**：只在两处升版本：`mission.edit`（只对没挂卡的 Mission 有效），以及确认时写回采纳的修改。一次确认里，每个改动过的 Mission 只升 1 次。每条修改建议都抄下 `original` 和 `source_version`，升版后仍能追溯。
- **意见**：UUID 加递增的 `seq`。写入后不可改、不可删（M-03：已有公开意见一条不删）。
- **Review**：每次截止写一行；重开时，旧的那行写上 `superseded_at`（对应概念的 pastReviews）。

### 1.5 与现有规则的交点

- **`mission.edit`**（`apps/api/src/missions.ts:197-274`）
  - 在第 219 行的版本检查之后加一条：`personal_mission_card_id IS NOT NULL` → 409 `MISSION_IN_MISSION_CARD`。
  - `projectMissionCard`（:69-111）对挂卡的 Mission 不再下发 `mission.edit`。
  - 配置页（`MissionManagementScreen.tsx:153`）拿不到这个动作时要写明原因："讨论中请在个人卡上提修改建议；已确定之后的修改规则待定（GAP-04）"。
- **删战场**（`apps/api/src/battlefields.ts:86`）：这个战场下有轮次时，直接返回 409 `BATTLEFIELD_HAS_MISSION_ROUNDS`，不要等外键报错。
- **ADR**：新写 ADR-0022；改 ADR-0020 §3（原来「成员看不到 Mission」→ 成员能看到自己所在卡的 Mission，拍板人能看到本战场全部卡）；改 ADR-0019 §4（Mission Card 的草稿由「整理个人卡草稿」动作或导入脚本在一个事务里建出；确认写回走 `mission-round.confirm`，不走 `mission.edit`）。
- **CONTEXT.md**：修改 Mission 词条（:95-97），写明挂在未确认轮次里的是草稿，确认后才是生效的 Organization Fact；新增「本月 Mission Card」「Mission Card 轮次」「公开意见」「集中 Review」「占位草稿」。
- **命名**：MVP 代码里「Mission Card」已经指「Mission 实体的 Card 投影」（`apps/api/src/routes/cards.ts:91`、`listMissionCards`）。新代码一律写 `PersonalMissionCard` 或 `mission-round`，不要单写 `MissionCard`。

## 2. 轮次状态机

### 2.1 状态与转换

库里存 `draft → open → reviewing → confirmed` 四个状态。另有派生状态 `closed`：`status='open'` 且 `now ≥ closes_at`、快照还没做；最多持续约 60 秒，界面写「已截止 · 汇总中」。

| 转换 | 谁 | 实现 | 前置条件 | 效果 |
|---|---|---|---|---|
| 整理草稿（∅→draft） | 拍板人（按钮），或运维脚本 | `mission-round.draft` / `importMissionCardDrafts()` | 当月计划已签发且含本战场结果；草稿文件存在；战场按 code 存在；Owner 和能力域都命中注册表；每条 Mission 只属于这个战场；这个战场这个月还没有轮次（同一文件 sha256 重跑不做任何事） | 同一事务里建轮次（draft）、卡（含 `member_ids`）、Mission（v1、`placeholder`、挂卡） |
| 开放（draft→open） | 拍板人 | `mission-round.open` | 状态是 draft；计划已签发且含本战场结果；每张卡至少 1 条 Mission | `opened_at=now`、`closes_at=now+48h`、`first_opened_at`、`window_seq=1`；冻结 `goal_snapshot`；版本 +1 |
| 截止（open→reviewing） | 系统 | 定时任务 + `closeIfDue` | 状态 open 且 `now ≥ closes_at` | 写一行 Review 快照（§4.1），结转上一轮的结论，状态改为 reviewing，版本 +1 |
| 逐条处理 | 拍板人 | `mission-round.decide`（itemId = 意见 id） | 状态 reviewing；意见在当前快照里；采纳建议时，同一个（mission, field）上没有别的已采纳 | 写入或覆盖结论（可以改判），版本 +1 |
| 重开（reviewing→open） | 拍板人 | `mission-round.reopen` | 已截止（先跑 `closeIfDue`）；未确认 | 当前 Review 写 `superseded_at`；`reopens` 追加 `{by, at, closedAt: 原 closes_at}`；重新开 48 小时；`window_seq` +1；版本 +1；目标依据不变 |
| 确认（reviewing→confirmed） | 拍板人 | `mission-round.confirm {note}` | 状态 reviewing；快照内的意见全部有结论；note 非空；各 Mission 版本等于快照记录的版本；同一字段不能有两条都被采纳 | 采纳的修改写回 Mission（版本 +1）；Review 写 `note`、`applied_versions`；轮次写 `confirmed_*`；版本 +1 |
| 发意见 | 卡成员或拍板人 | `POST /api/mission-cards/:id/feedback` | 见 §3.2 | 插入一条意见，按 `client_id` 幂等 |

- **拍板人**：`canApprove(person, round) = person.role === 'ceo' || battlefield_config.owner_id === person.personId`，每次按当前数据现算（对应概念 `model.ts:37`）。
- **卡成员**：`member_ids = 去重([owner, battlefield.owner_id（非空时）, CEO])`，同一人兼任只算一次（对应概念 `model.ts:60`）。
- **其他人**：卡和轮次一律返回 404，不暴露对象是否存在（与 `routes/threads.ts:6` 同一口径）。
- **明确拒绝**：
  - 截止前重开：409 `ROUND_NOT_CLOSED`，提示「讨论还没截止，倒计时不会重置」
  - 确认后重开：409 `ROUND_CONFIRMED`（GAP-04）
  - 截止前确认：409
  - 重复开放：409 `ROUND_ALREADY_OPEN`，提示「本轮已经开放，倒计时不会重置」
  - 重开不设次数上限（GAP-09）

### 2.2 Action 层

- 签名范围沿用 `apps/api/src/actionToken.ts:3-9`：`{actionType, objectType:'mission-round', objectId: roundId, objectVersion: round.version, itemId?}`。动作有：`mission-round.draft`、`.open`、`.decide`（itemId = 意见 id）、`.reopen`、`.confirm`。
  - 例外：`draft` 执行时轮次还不存在。它的签名对象用 `{objectType:'mission-round-slot', objectId: '<battlefieldId>:<period>', objectVersion: 1}`，下发在 CEO 首页的入口 Card 上。
- 执行事务照抄 `withPlanLock`（`monthlyPlans.ts:185-225`）：
  1. `SELECT … FOR UPDATE`
  2. fingerprint 已经存在 → 直接返回当前 Card（重放）
  3. 版本不符 → 409 `VERSION_CONFLICT`，带 `latestCard`（沿用 `routes/shared.ts:176-186` 的 `respond`）
  4. 权限复查
  5. 业务前置检查
  6. 写入
  7. `appendFingerprint`（最多保留 100 条，同 `monthlyPlans.ts:176-179`）
- **新端点 `POST /api/mission-rounds/actions/execute`**
  - 闸门：`requirePerson`（含同源检查，`shared.ts:130-137`）。
  - 请求体：`{actionId, input, viewCardId?}`。fingerprint 只对 actionId 和 input 计算。
  - 响应：带了 `viewCardId` 就返回那张卡的 Card，否则返回 `mission-round` Card。
- **前端**：`useCardAction` 现在把端点写死在 `apps/web/src/lib/useCardAction.tsx:28-31`，给它加一个可选参数 `endpoint`。

### 2.3 截止、快照与并发

- **定时任务** `createMissionRoundScheduler`：照抄 `monthlyPlanScheduler.ts:4-24`，60 秒一次调用 `closeDueRounds(pool, now())`；出错只记日志，不抛出。在 `server.ts` 里挨着 `monthlyScheduler`（:112 创建、:142 关闭、:145 启动）接线。
- **读接口不写库**：到点但还没快照时，读接口返回 `phase:'closed'`。
- **写入路径**（发意见和所有 Action）拿到锁之后，先调 `closeIfDue`。
- **锁的顺序**：
  - 发意见：对轮次行取 `FOR SHARE`，拿到锁之后再取 `now` 作为 `created_at` 并判断窗口。
  - 截止快照和各 Action：取 `FOR UPDATE`。
  - 这样截止前一刻正在提交的意见，要么被快照收进来，要么在快照之后被判成截止后留言，不会丢。
- **快照口径**：`created_at < closes_at`，与快照实际执行的时刻无关。API 在截止那一刻宕机也不影响结果。

### 2.4 倒计时与共享分钟时钟

- **真相**：库里的 `closes_at`。窗口判断只信服务端的 `ctx.now()`。
- **校正**：每个投影都带 `serverNow`，前端算出 `offset = serverNow − Date.now()` 来校正本机时钟。
- **前端时钟**：`apps/web/src/components/missionCards/roundClock.ts`，模块级小存储（参照 `useColumnMode.ts` 的做法）。
  - 同一个 `closesAt` 只开一个定时器，下一次触发对齐到 `closesAt` 的秒位再加 20ms（对应概念 `store.ts:47-63`）。
  - 窗口重新获得焦点、页面回到前台、拿到新投影时，立刻对表。
  - 通知分组标题和个人卡页头都用 `useRoundNow(closesAt)`，同一帧换数字（C-05、AC-07）。
  - 越过 `closesAt` 时发一个事件，两处各自重新拉取。
  - 可参考 `RailClock`（`NotificationRail.tsx:118-139`），它已经按分钟边界跳。
- 显示用公司时区（`apps/web/src/lib/companyTime.ts`）。
- 未开放时不出数字，只写「未开放」，不加「演示」小标。

## 3. 讨论模型

### 3.1 一条意见

- **锚点**：卡 → Mission → 字段。
  - `card_id` 必有。
  - `mission_id`、`field` 可以为空；两者都空时，意见列在卡尾「整张卡上的意见」（对应 `card-document.tsx:187`）。
- **记录内容**：作者、时间、kind、正文、`quote`、`proposed`、`original`、`source_version`（当时的 Mission 版本）、`basis`（对照的是草稿还是候选版本）、`window_seq`、`late`、`client_id`（幂等）。
- **三种 kind**：
  - `comment`：群组里的一句话，不锚到字段。
  - `quote`：引用评论，来自划词或「引用并评论」整段。
  - `suggestion`：修改建议，写在字段内的编辑框里；正文默认「建议修改「{字段名}」」。

### 3.2 写入规则

服务端在锁内判断；失败时前端保留输入（C-04）。

| 阶段 | comment / quote | suggestion |
|---|---|---|
| draft | 409 `ROUND_NOT_OPEN`：「讨论还没开放」 | 同左 |
| open（`now < closes_at`） | 接受；quote 的原文必须能在**草稿**里找到 | 接受；服务端抄下 `original`、`source_version` |
| closed / reviewing | 接受，记为截止后留言：`late=true`，`basis='candidate'`；quote 对照**候选版本**的文本（对应 `model.ts:149`） | 409：「截止后不能再提修改建议；需要改动，请由拍板人重新开启讨论」 |
| confirmed | 409：「本月 Mission Card 已确定，不再收留言」 | 同左 |

- 非成员且非拍板人：404。
- `source_version` 和当前版本不符：409「页面版本已变化，请刷新后重新提交」。
- 引用的原文对不上：409「引用内容已经变化，请重新划选」。比较前把连续空白压成一个；列表字段按 `\n` 连起来再比。
- 同一个 `client_id`：内容相同，返回 200 和原记录；内容不同，返回 409（照抄 `monthlyPlans.ts:435-442`）。

### 3.3 两个私有频道与事项群组

- **「我的 Agent」**（频道名随产品现行叫法）
  - 私聊用 conversations 表，新 scope `mission-card:<cardId>`，按"人 × scope"私有（参照 `conversations.ts:236-238`）。
  - 模型只读：不改卡，不在群里发言，不进 Review。
  - 给模型的资料：这张卡的 13 字段、卡上的公开意见、本轮状态；没有原件（对应概念 `agent-context.ts:30-59`）。
  - 要改的代码：
    - `ConversationScope` 的正则（`packages/contracts/src/conversations.ts:3-6`）加上这个 scope。
    - `getScopeObject`（`apps/api/src/conversations.ts:68-157`）加一个分支。
    - `routes/conversations.ts:30-34` 现在只放成员访问 global，要改成：卡成员或拍板人可以访问 `mission-card:` 开头的 scope。
  - 「转为公开意见」延后。
  - 时间紧时，这是第一个可以砍的部分。
- **事项群组** = 这张卡在 `mission_card_feedback` 里的全部公开意见，加上分隔线和开场。
  - 可读：卡成员和拍板人。
  - 未读按 `seq` 计，不算自己发的，也不算开场。

### 3.4 为什么不直接用线程后端

1. 对象类型写死在 CHECK 里：`024_conversation_owner_and_threads.sql:10/22/34`、`contracts/src/threads.ts:4-9`。
2. `thread_messages` 是通用聊天，引用只有 `{text}`；锚点、建议、版本、`late`、`window_seq` 都放不下，快照和逐条处理也引用不到。
3. 线程对非成员（含 CEO）一律返回 404；而拍板人必须能读能写。
4. 线程成员可以自己退出；个人卡群组的成员由对象决定，不能退出。
5. `thread_reads` 依赖 `thread_messages.id`。

复用的部分：`ThreadMember` 的数据形状；按 `after` 增量拉取、每 3 秒轮询；"读到哪条只增不减、不超过最后一条、不算自己发的"这套语义；前端 `ConversationColumn`、`ChannelSwitch` 里已有的群组频道样式。

### 3.5 名单、分隔线与 Co-Agent 开场（服务端现算）

- **名单**：`member_ids` 的人，外加一个「Co-Agent」标签。页头人数、名单、底部「成员可见：…」读同一份（AC-24）。
- **分隔线**（对应概念 `opening.ts:70-84`，去掉「本机记录」字样）：
  - `first_opened_at` 处：「{时间} · 全战场统一开放 48 小时讨论」
  - 每次重开两条：`closedAt` 处写「讨论截止」；`at` 处写「{名字}重新开启 48 小时讨论（第 N 轮）」
  - 当前已截止：「{时间} · 讨论截止 · 之后的留言不进这一轮」
  - 已确认：「{名字}确认了本月 Mission Card」
- **开场**（对应 `opening.ts:43-54`）：
  - 时刻取 `first_opened_at`，排在开放分隔线之后。同一时刻的顺序：分隔线 < 开场 < 意见。
  - 正文：「这个群讨论{Owner}的 {M} 月 Mission Card（N 项个人任务），开放到 {首轮截止}：可以在字段上评论、划词引用、提修改建议。截止后 Co-Agent 汇总大家的意见，交{拍板人}拍板。」
  - 占位的轮次再加一句：「本月草稿是占位（Co-Agent 起草未接入，沿用 9 月个人卡）。」
  - 开放前没有开场；重开不再出；确认后仍留在历史里；不算未读；有开场就不显示「暂无消息」；不进 Review，也不带给 Agent。

## 4. 集中 Review（规则汇总）

### 4.1 快照（对应概念 `model.ts:82-91`）

截止时写一行 Review：
- `feedback_ids`：本轮所有 `created_at < closes_at` 的公开意见，按 `seq` 排序。更早窗口的意见和截止后留言，时间也早于新的截止时刻，所以一并收进来。
- `mission_versions`：本轮全部 Mission 当时的版本。
- 私聊不收。
- **结转**：上一次被取代的 Review 里，凡是这次仍在快照内的意见，把结论带过来（`carried=true`），只有新意见需要处理（对应 `model.ts:88-89`）。
- 协作核对结论**不结转**。

### 4.2 字段冲突

- 快照内的修改建议按 `(mission_id, field)` 分组，一组 ≥2 条就算一处冲突（对应 `round.ts:95-104`）。
- 采纳时，同一个 key 已经有一条被采纳：返回 409 `CONFLICTING_SUGGESTION`「同一字段已采纳另一条」。前端把「采纳修改」停用，写出同样的原因（对应 `workspace.tsx:209-215`）。
- 确认时再查一次。

### 4.3 逐条处理

- 按钮：
  - 修改建议：「采纳修改」「不采纳」
  - 评论、引用：「已纳入核对」「不采纳」
- 可以改判。每处理一条，轮次版本 +1，响应返回新的 Card 和新的令牌。
- 处理结果由服务端生成，所有人看到的是同一句（移植 `card-document.tsx:35-52`，去掉"本机"字样）：
  - 讨论中
  - 待拍板人处理
  - 已采纳 · 拍板前可能变化；确认后写「已采纳」
  - 已纳入核对
  - 未采纳
  - 截止后留言 · 不在这一轮
  - 截止后留言 · 已并入这一轮
  - 上一轮已采纳／已纳入核对／未采纳 · 下次截止沿用
- 只有拍板人有处理按钮（M-05）。

### 4.4 候选版本

- 候选版本 = 草稿 + 当前 Review 里已采纳的修改建议，读的时候现算，不存库（对应 `model.ts:93-100`）。
- 截止后，左侧所有人看到的都是候选版本。
- 版本行：「候选版本 · 相比草稿 N 处改动 · 等{拍板人}拍板」（对应 `workspace.tsx:243-247`）。

### 4.5 协作核对与确认写回

- 全部意见都有结论之后，「本轮」那一行出现「确认前核对」。
- 拍板人填写「跨人员依赖、冲突与协作的核对结论」（1–2000 字），作为 confirm 的输入。
- 确认事务：
  1. 逐条核对 Mission 版本仍等于 `mission_versions`，否则返回 409 `MISSION_CHANGED`。
  2. 每个 Mission 被采纳的字段合并成一次 UPDATE，版本 +1；列表字段按行拆开写入。
  3. Review 写 `note`、`applied_versions`。
  4. 轮次写 `confirmed_by`、`confirmed_at`，状态改为 confirmed。
- 同一个 fingerprint 重放，不重复写入。
- 截止后留言不要求处理，也不阻止确认。
- 重开时协作结论作废：它只在确认时写入，所以新的 Review 行 `note` 为空；前端也清掉还没提交的草稿。

### 4.6 不是 AI 语义 Review

- 快照、冲突分组、依赖条数（各卡「依赖」原文的行数）、待处理条数，全是确定性规则。
- 界面：
  - 脚注写「规则汇总 · 未做语义判断」。
  - 「本轮」展开后写三步：「收下 N 张卡、M 条公开意见（私聊不收）」「同一字段 X 处冲突」「按依赖原文列出 Y 条」（对应 `round.ts:110-136`）。
  - 不用「理解」「判断」这类词（GAP-05）。
  - 不要演示用的逐步亮起，直接显示结果。

## 5. 接口与契约

### 5.1 端点

| 方法 | 路径 | 闸门 | 用途 | 工单 |
|---|---|---|---|---|
| GET | `/api/mission-rounds/:roundId` | requirePerson + 可见 | `mission-round` Card（摘要 + 动作） | 04a |
| POST | `/api/mission-rounds/actions/execute` | requirePerson + canApprove | draft/open/reopen（04a），decide/confirm（04c） | 04a/04c |
| GET | `/api/mission-cards/:cardId` | requirePerson + 可见 | `personal-mission-card` Card（整页数据） | 04b |
| POST | `/api/mission-cards/:cardId/feedback` | requirePerson | 评论／引用／修改建议／截止后留言 | 04b |
| GET | `/api/mission-cards/:cardId/group?after=` | requirePerson | 事项群组视图 + 未读 | 04b |
| POST | `/api/mission-cards/:cardId/group/read` | requirePerson | 记下读到哪条 | 04b |
| GET/POST | `/api/conversations/mission-card:<id>/messages` | requirePerson | 我的 Agent（私聊） | 04b |
| GET | `/api/me/mission-cards` | requirePerson | 通知分组：我能看到的、未确认的轮次 | 04d |
| GET | `/api/cards/home` 增加 `mission-round` Card 和「可以整理草稿」入口 | requireCEO | CEO 通知入口（`routes/cards.ts:23-40`） | 04a（入口）/04d |

- 新路由写在 `apps/api/src/routes/missionCards.ts`，在 `app.ts` 注册。
- 全部登记到 `packages/contracts/src/openapi.ts`，然后运行 `pnpm --filter @warmap/web gen:client`；生成的文件不手改。

### 5.2 契约草图（新文件 `packages/contracts/src/missionCards.ts`）

```ts
export const MissionCardField = Type.Union(["title","why","outcome","successEvidence","boundaries","keyPath",
  "milestones","resources","dependencies","humanAgentSplit","risk","retrospect"].map(v => Type.Literal(v)));
export const MissionRoundPhase = Type.Union(["draft","open","closed","reviewing","confirmed"].map(v => Type.Literal(v)));
export const MissionCardRow = Type.Object({ cardId, ownerId, ownerName, roleLabel: Nullable(String), missionCount: Integer,
  line: String, pending: Integer, mine: Boolean });
export const MissionRoundSummary = Type.Object({ roundId, period, battlefieldId, battlefieldName, version: Integer,
  phase: MissionRoundPhase, round: Integer({minimum:1}), openedAt: Nullable(DateTime), closesAt: Nullable(DateTime),
  reviewAt: Nullable(DateTime), serverNow: DateTime, approver: Boolean, deciderName: String, todo: Nullable(String),
  placeholder: Boolean, goals: Nullable(Object({ sixMonthOutcome, monthOutcome, signedAt })),
  counts: Object({ feedback, pending, conflicts, dependencies, late }), cards: Array(MissionCardRow) });
export const MissionCardFeedbackView = Type.Object({ id, seq, missionId: Nullable, field: Nullable(MissionCardField),
  kind: Union(comment|quote|suggestion), authorId, authorName, body, quote: Nullable, proposed: Nullable, original: Nullable,
  sourceVersion: Nullable(Integer), late: Boolean, round: Integer, createdAt,
  verdict: Object({ text: String, tone: Union(open|accept|decline|late|wait) }),
  decision: Nullable(Union(accept|decline)), actions: Array(ActionDescriptor) });
export const PersonalMissionCardPayload = Type.Object({ round: MissionRoundSummary,
  card: Object({ cardId, ownerId, ownerName, roleLabel, members: Array(ThreadMember), status: String,
    shown: Union(draft|candidate|confirmed), missions: Array(/* 13 字段 + changedFields */) }),
  feedback: Array(MissionCardFeedbackView), confirmation: Nullable(Object({ by, byName, at, note })) });
export const CreateMissionCardFeedbackRequest = Type.Object({ clientId: String({format:"uuid"}), kind, round: Integer,
  missionId: Optional, field: Optional(MissionCardField), quote: Optional(maxLength 2000),
  proposed: Optional(maxLength 4000), body: String({minLength:1,maxLength:4000}), sourceVersion: Optional(Integer) });
export const MissionCardGroupView = Type.Object({ members: Array(ThreadMember), lastReadSeq: Integer, unread: Integer,
  entries: Array(Union([ {type:"message", feedback}, {type:"divider", at, text}, {type:"opening", at, text} ])) });
export const ExecuteMissionRoundActionRequest = Type.Object({ actionId: String, input: Optional(Unknown), viewCardId: Optional(String) });
export const MissionRoundDecideInput = Type.Object({ decision: Union(accept|decline) });
export const MissionRoundConfirmInput = Type.Object({ note: String({minLength:1,maxLength:2000}) });
export const MyMissionRoundsResponse = Type.Object({ rounds: Array(MissionRoundSummary) });
```

现有 Mission 契约（`packages/contracts/src/missions.ts:27-95`）的增量：
- `MissionCardPayload` 加 `keyPath`、`resources`、`humanAgentSplit`、`retrospect`、`placeholder`，以及 `personalCard: Nullable({cardId, roundId, status})`。
- `CreateMissionRequest` 和 `MissionEditInput` 加 4 个可选文本字段。
- `MISSION_COLUMNS`（`missions.ts:44-52`）LEFT JOIN 卡表和轮次表。

### 5.3 Card 投影

原则：左侧的事实与看的人无关，只有动作因人而异（C-02）。

- **`personal-mission-card`**
  - `version` 等于轮次的 version；`conversation.scope` 为 `mission-card:<cardId>`。
  - `actions` 只给拍板人：draft 时有 open；reviewing 时有 reopen；reviewing 且全部处理完时有 confirm。逐条处理的动作放在每条意见视图里。
- **`mission-round`**：payload 是摘要；导航到第一张卡（拍板人）或自己那张卡。
- **哪些句子由服务端拼**：必须对所有人逐字一致的句子，包括处理结果、版本行状态、通知行右边那几个字（`line`）、`todo`、开场、分隔线。「本轮」那一行因为拍板人和参与者说法不同，由前端根据摘要里的事实拼（移植 `round-panel.tsx:58-162`）。
- **通知行右边的字**（服务端生成，来源 `dri/mission-card-notice.ts:91-108`）：
  - 拍板人：未开放／无意见／N 条意见／汇总中／待处理 N／已处理
  - 其他人：未开放／无意见／N 条意见／汇总中／已处理 x/y／等拍板
- **`todo`**（只给拍板人）：
  - 可以整理草稿时：「让 Co-Agent 整理个人卡草稿（占位）」
  - draft：「个人卡草稿已就绪，可以统一开放讨论」
  - reviewing 且全部处理完：「意见已全部处理，待你确认」

## 6. 页面

### 6.1 路由与可见范围

| 入口 | 路由 | 守卫 | 可见 |
|---|---|---|---|
| 成员 | `/me/mission-cards/[cardId]` | requireMember | 自己的卡；若是非 CEO 的战场 DRI，本战场全部卡 |
| CEO | `/mission-cards/[cardId]` | requireCeo | 全部 |

- API 一律按"卡成员或拍板人"复查，否则返回 404。
- 两个入口共用一个 `MissionCardScreen`：
  - CEO 侧挂在 `(ceo)` 布局下，在 CeoWorkspace 展开区里打开，保留背景、来源，关闭后焦点还原（C-01）。
  - 成员侧需要一个带详情区的外壳，这是 **04b 的前置**：新建 `apps/web/src/app/(member)/me/layout.tsx`，照 `(ceo)/layout.tsx` 和 CeoWorkspace 的结构来：左侧成员通知栏 + 展开区 + ConversationHost（`agentTitle="DRI Agent"`），并提供 `WorkspaceContext`（`shell/WorkspaceContext.tsx:7-49`）。工单 03 的成员战场详情页复用这个外壳。
- 卡与卡之间切换属于同一个视图家族（参照 `CeoWorkspace.tsx:26-33` 的 `family()`），不重播来源卡片的过渡动画。
- 不带 cardId 的深链（"先看自己那张"）延后。

### 6.2 个人卡页

版式整体移植 `clark-main/src/components/mission-cards/workspace.tsx`，数据改由接口提供。

**页头**
- 用 `DetailFrame`（`shell/DetailFrame.tsx:19-59`，C-08）：返回、眉题（战场名）、标题「{Owner} · {M} 月 Mission Card」。
- 右端状态段是 `RoundClock`（移植 `countdown.tsx:59-101`，`paper` 色调）：
  - 开放中：电量条 + 「31 小时 24 分」，重开后带「第 N 轮」
  - 未开放：「未开放」
  - 截止后：「已截止」
  - 确认后：「已确定」

**左栏**
1. **「本轮」那一行**（移植 `round-panel.tsx:290-347`）：
   - 一句话写走到哪一步、在等谁。
   - 右边放拍板人此刻该按的一颗钮：
     - draft：「统一开放 48 小时讨论」
     - reviewing 且有待处理：「从第一条开始」（纯前端跳到第一条待处理，必要时切到有待处理的那张卡）
     - 全部处理完：「确认前核对」
   - 展开后有五步：月度计划已签发及时间 → 草稿（N 张 · 占位）→ 讨论 → 规则汇总 → 拍板。另外有：全战场每张卡的入口（拍板人）、「查看目标」只读弹窗（冻结的两段目标）、「重新开启 48 小时」弹窗、核对结论表单、确认记录。
   - 弹窗文案移植 `workspace.tsx:322-341`，把「仅本机」改成「不会另外通知同事」。
   - **每月制定的规则就在这里讲**，引导里不讲（spec §2.2）。第一次打开时，这一行自动展开一次，写清五步和各自的意思。
2. **版本行**（移植 `card-document.tsx:191-200`）：Owner、服务端给的状态句、「占位 · 沿用 9 月个人卡 · 飞书 r{rev} · 打开来源」。不出「下载原件」。
3. **页签**：「原件 | 个人任务 · N」只在有原件时出现；10 月没有，直接显示个人任务列表。
4. **每条个人任务**（移植 `card-document.tsx:118-183`）：
   - 标题，加「编号 · 能力域 · 占位」小标。
   - 正文字段，各带「引用并评论」「建议修改」（截止后变成「引用到群组」）按钮。
   - 行内修改建议编辑框（移植 `workspace.tsx:219-231`）。
   - 挂在字段下的意见卡：作者、类型、时间、处理结果、原文与建议对照；拍板人有处理按钮。
   - 然后是成功证据、边界、里程碑、依赖与协作、唯一责任人。
   - 划词沿用 mouseup/keyup 取选区（`workspace.tsx:164-168`）。
5. **「整张卡上的意见」**。

**右栏**（C-02：只有一个右列）
- 扩展 `ConversationHost`：`DetailInfo` 和 `ConversationTarget` 加可选的 `group` 描述，包括端点、成员、输入条是否可写、占位字、脚注。
- `RailConversation`（`ConversationHost.tsx:108-172`）有 `group` 时出两个频道，默认打开群组。
- 群组那条线：分隔线、开场、意见（带「截止后留言」标签、引用块、建议文本）。
- 输入条：群组频道用暖色（变量在 `conversation-column.module.css`、`composer-pill.module.css`）。占位字和可用状态按阶段：
  - 开放中：「输入你的想法…」
  - 截止后：「截止后留言 · 不进这一轮集中 Review」
  - 未开放：「讨论还没开放」，停用
  - 已确定：「本月 Mission Card 已确定」，停用
- 带引用时，输入条上方有引用小条，可以取消。发送失败时放回输入（同 `ColumnComposer.tsx:89-96`）。
- 脚注：群组写「成员可见：…」；我的 Agent 写「仅你可见 · 只读：不改这张卡、不进集中 Review」。
- 未读显示在频道开关的非当前段上（`seen.ts`）。群组打开时每 3 秒按 `after` 拉增量，有新意见就重拉整页。

**美学**：页头、按钮、状态、材质和反馈，与锁屏、引导、DRI 首页是同一套语言（spec §3）。正文阅读区接近不透明；阅读宽度 760–880px；截止时刻、负责人、来源不藏进小灰字。

### 6.3 DRI 通知分组「{M} 月 Mission Card」（04d）

- 移植 `dri/mission-card-group.tsx:31-82` 和它的 CSS，数据来自 `/api/me/mission-cards`。
- 放在成员通知栏（`MemberWorkspace.tsx:81-85`）**最上面**，在「新的执行事项」「回复与结果」之前，所有人的顺序都一样。
- 每个未确认的轮次一张卡：
  - 标题行：「10 月 Mission Card」、张数，以及一次「草稿」。
  - 标题下一行是倒计时（`glass` 色调）：
    - 开放中：「X 小时 Y 分 · 10/3 18:00 截止」；重开后前面加「第 N 轮」；剩余不到 6 小时写「最后 6 小时」
    - 截止后：「已截止 · 汇总中」，汇总完写「等你拍板」或「等刘明华拍板」
    - 未开放：「本轮未开放」
  - 拍板人有 `todo` 时，卡片最上面多一行提示。
- 卡片里的行：
  - 拍板人：每张卡一行，按 `sort_order` 排（白田田、刘人豪、孙铭泽、陈溪南，于斯一最后）。
  - 其他人：只有自己那一行，名字后标「你」。
  - 每行写名字、「01-3 战役 · 2 项」，右边是服务端给的几个字；有待处理时，右边那几个字用天枢蓝加粗。
  - 行里的字不截断，不重复轮次和倒计时。
  - 点一行，就是同页换到那张卡。
- 截止只让倒计时归零，这张卡不退；确认后整张卡退出（AC-16）。
- 这张卡按状态现算，**不写 `notifications` 表**。

### 6.4 CEO 入口（04a 起就有整理草稿入口，其余在 04d）

- 放在「战略决策更新」组（`NotificationRail.tsx:59-68、109-113`），每个战场、每个月一条。
- 标题「10 月 Mission Card · 灯塔项目」；说明按阶段写：
  - 「可以整理个人卡草稿」
  - 「草稿 · 可以统一开放讨论」
  - 「讨论中 · 31 小时 24 分」
  - 「已截止 · 汇总中」
  - 「5 条待你处理」
  - 「意见已全部处理，待你确认」
- 倒计时用同一个共享分钟时钟。
- 点击：
  - 还没有轮次时：弹确认框，执行 `mission-round.draft`，成功后打开第一张卡。
  - 已有轮次时：打开 `/mission-cards/<第一张卡>`。

### 6.5 成员战场详情页的状态块（04d，依赖工单 03）

- 没有轮次时：计划未签发写「本月目标还在协商」；已签发写「个人卡草稿还没整理」。
- 有轮次时：写阶段、倒计时，以及「我的卡：2 项 · 3 条意见」和「打开」；拍板人看到「5 张卡 · 待处理 N」。
- 已确定时：写「已确定 · 刘明华 10/4 18:00」，仍然能打开卡。
- Mission 总览、详情页，以及工单 03 的「我在这里的 Mission」上，都加「草稿／占位／已确定」小标。Mission 详情页加「所属个人 Mission Card」的链接。

### 6.6 移植清单

| clark 源文件 | MVP 目标 |
|---|---|
| `card-document.tsx` | `components/missionCards/CardDocument.tsx`；原件分支保留，但不启用 |
| `round-panel.tsx` + css | `RoundLine.tsx`；演示用的扫光和节拍删掉 |
| `countdown.tsx` + css | `RoundClock.tsx` |
| `workspace.tsx` + css | `MissionCardScreen.tsx`；去掉 WorkspaceShell 和演示控制台 |
| `dri/mission-card-group.tsx` + css | `components/member/MissionCardNoticeGroup.tsx` |
| `opening.ts`、`round.ts`（规则部分）、`mission-card-notice.ts`（文案部分） | 搬到 API：`apps/api/src/missionRounds.ts`、`missionCardDiscussion.ts` |
| `store.ts` | 由接口取代；时钟换成 `roundClock.ts` |
| `model.ts` | 由接口取代 |
| `agent-context.ts` | 由 scope 快照取代 |

## 7. 10 月讨论候选（占位草稿）

### 7.1 文件：`seed/placeholders/2026-10-mission-cards.battlefield-01.json`

- 由 Claude 用 `.scratch/onboarding/tools/gen-2026-10-candidates.mjs` 生成，可以复现。
- 格式 `mission-card-drafts.v1`：

```json
{ "schema": "mission-card-drafts.v1", "period": "2026-10", "battlefieldCode": "01", "origin": "placeholder",
  "placeholderNote": "占位（Agent 未接入，沿用 9 月个人卡，待讨论修改）",
  "source": { "file": "clark-main/docs/product/tianshu-ssot.data.json", "version": "2026-09-24.1",
              "sha256": "…", "period": "2026-09" },
  "cards": [ { "ownerId": "bai-tiantian", "sortOrder": 0, "roleLabel": "01-1 战役 DRI",
      "sourceCardId": "personal-card:bai-tiantian:2026-09",
      "missions": [ { "code": "bai-202610-1", "carriedFrom": { "ssotTaskId": "bai-202609-1" },
          "capabilityCode": "03", "title": "…", "why": "…", "outcome": "…", "successEvidence": ["…"],
          "boundaries": "包含：…\n不包含：…", "keyPath": "…", "milestones": ["待定 · …"], "resources": "…",
          "dependencies": "…\n…", "humanAgentSplit": "…", "risk": "…", "retrospect": "…",
          "source": { "url": "https://tokenking.feishu.cn/docx/…", "documentId": "…", "revision": 9 } } ] } ] }
```

- 内容只来自 SSOT 的 `personalCards`：5 张卡、12 项个人任务。不复制 `cardArtifacts.content`（ADR-0019 §6），不编造新的业务事实。

### 7.2 转换规则

- 字段按 1.2 转换。
- 里程碑：去掉 label 开头的日期段（正则 `^\d{1,2}\/\d{1,2}(\s*[–-]\s*\d{1,2}\/\d{1,2})?\s*`），前面加「待定 · 」。正文里其他的 9 月日期原样保留，由「占位」标记说明。
- 能力域：沿用 9 月 Mission 的能力域，写成 `capabilityCode`：
  - Agents（04）：renhao-a、sun-1、sun-2、xinan-1、xinan-2
  - E&O（05）：renhao-b、renhao-c、siyi-1
  - Method（03）：bai-1～bai-4
  - 找不到对应 code 时，导入或整理草稿立即失败，并写明是哪一条。
- 战场：code「01」，导入时按 code 找到 id。
- 排序与身份：白田田（01-1 战役 DRI）、刘人豪（01-2）、孙铭泽（01-3）、陈溪南（01-4），于斯一写「参与 DRI」，放最后。
- 来源文档 id 取 SSOT 各任务 `source.url` 的最后一段，revision 取 `source.revision`。

### 7.3 加载

- **函数**：`importMissionCardDrafts(pool, people, file, now)`，同一个函数给两处用：「整理个人卡草稿」动作和导入脚本。
- **脚本**：`apps/api/scripts/import-mission-card-drafts.ts`，并在 `apps/api/package.json` 加 `"mission-cards:import"`。写法照 `apps/api/scripts/issue-access.ts`。
- **校验与失败**：
  - 校验 schema。
  - 当月计划未签发：失败，提示「10 月月度计划还没签发：先签发再整理草稿」。
  - 战场 code、能力域 code、Owner 必须都命中。
  - 已有轮次：文件 sha256 相同则什么都不做；不同则失败，不覆盖。
- **写入**（一个事务）：
  - 轮次：draft，`draft_origin=placeholder`，带 `monthly_plan_id`。
  - 各张卡：算出 `member_ids`。
  - 各条 Mission：`id = code`，`version=1`，`placeholder=true`，`source_title = placeholderNote`，`battlefield_ids=[id]`，挂到卡上。
- 脚本最后用 `console.table` 打印每人各几项。

### 7.4 「占位」怎么标

- **数据**：`missions.placeholder`、`source_title`、`mission_rounds.draft_origin`、`draft_source`。
- **界面**：
  - 版本行：「占位 · 沿用 9 月个人卡」
  - 每条个人任务上的「占位」小标
  - 「本轮」第 2 步：「草稿 · 占位（Co-Agent 起草未接入）」
  - 开场里的那一句
  - Mission 总览和详情的来源行
- 确认之后状态变成「已确定」，来源上的「占位」保留。

## 8. 删减、延后与风险

**延后**：
- 演示控制台和演示拨钟；Review 的逐步亮起；胶囊的扫光节拍
- 原件页签
- 「转为公开意见」；群组页头的头像和名单弹层（先只做人数和脚注）
- 不带 cardId 的深链；从 CEO 战场详情跳到个人卡
- 「审视并拍板目标」弹窗（由月度计划签发代替）
- 达成路径权重
- 截止后的提醒和超期处理（GAP-09）
- 确认后的再修订（GAP-04）
- 飞书提醒

时间紧时，第一个砍「我的 Agent」私聊频道。

**必须保留**：
- 服务端持久化
- 同一战场统一、固定的 48 小时；重开
- 截止后留言：标记，且不进当轮
- 快照规则；同字段冲突；逐条处理；候选版本；协作核对
- 确认时带版本写回
- DRI 通知分组和倒计时；CEO 入口；共享分钟时钟
- 服务端权限复查；幂等

**最大风险**：
1. 草稿 Mission 进了当月集合，语义会变松。首页 Mission 数、DRI 首页都会读到草稿，需要靠 `personalCard.status` 和小标区分，并在 ADR-0022 和 CONTEXT 里写清楚。
2. 成员侧外壳和群组频道都是第一次做，是前端工作量最大的一块。
3. 截止边界的并发：锁的先后，以及 `created_at` 在拿到锁之后才取，这两点都要有并发测试。
4. 两处倒计时要同一刻换数字；本机时钟有偏差。
5. 每处理一条，轮次版本就变，旧令牌全部失效，前端必须用响应里的新 Card 替换；两位拍板人同时处理时会有 409。
6. 列表字段的建议按行写回：在提建议时就校验行数和行长，不要等到确认时才失败。
7. `mission.edit` 被锁住后，确认过的 Mission 在产品里没法再改（GAP-04），需要一句清楚的说明，并单开 ADR。
8. 要修改 ADR-0019 §6 和 ADR-0020 §3 的口径。
9. 占位只挂在 01 上，和 MVP 里 9 月 Mission 挂 01+03 不一致（已定：只挂 01）。
10. 时间线：计划签发晚了，后面每一步都跟着晚。

## 9. 四张工单、测试与验收

测试沿用 `apps/api/test/helpers.ts` 的 `createTestDb` 和 `buildApp({now})`；API 测试加 `--maxWorkers=1`；三处都跑类型检查；web 用 vitest。

### 04a · 数据、状态机、占位导入（后端和契约，另加 CEO 的整理草稿入口）

**范围**：
- 迁移 032–034；契约（Mission 增量，以及 `missionCards.ts` 的轮次部分）
- `missionRounds.ts`：导入 / draft、开放、`closeIfDue`、`closeDueRounds`、重开、`mission-round` 投影、`canApprove`
- 定时任务；`GET /api/mission-rounds/:id`；动作端点（draft、open、reopen）
- `mission.edit` 锁；删战场拦截
- 导入脚本；占位 JSON（Claude 已生成）
- CEO 首页的整理草稿入口（最小 UI：确认弹窗 + 执行动作；打开卡的页面在 04b 做，04a 成功后可以先回首页）
- ADR-0022 和 CONTEXT 词条

**测试**：
- 迁移：CHECK（48 小时；draft 与 opened 的对应；意见的 kind）和唯一约束
- 导入 / draft：
  - 计划未签发时拒绝；未知的 Owner、能力域、战场 code 拒绝；一条 Mission 挂多个战场拒绝
  - 成功时建出 1 个轮次、5 张卡、12 条 Mission；`placeholder`、`source_title`、「待定 · 」都正确；成员去重
  - 同一文件重跑无变化；文件改动后拒绝；非拍板人拒绝
- 开放：只有 CEO 或战场 DRI 能开；目标缺失时拒绝；`closes_at` 正好是 +48h；重复开放返回 409；重放不会重开；旧版本返回 409 并带 latestCard
- 截止：
  - 截止前 1ms 什么都不做；到点只收 `created_at < closes_at` 的意见
  - 重复执行不重复建快照；两个战场互不影响（AC-07）
- 重开：截止前、非拍板人、确认后都拒绝；`reopens` 和 `window_seq` 正确；意见保留；下一次截止时结转结论、并入截止后留言（AC-20）
- `mission.edit` 遇到挂卡的 Mission 返回 409，没挂卡的照常；有轮次时删战场返回 409

### 04b · 个人卡页与讨论

**范围**：
- 接口：卡页、意见、群组（分隔线、开场）、已读；`mission-card:` scope
- 前端：成员外壳 `(member)/me/layout.tsx`；`MissionCardScreen`、`CardDocument`、`RoundClock`；「本轮」那一行在草稿和讨论中两个阶段的部分；ConversationHost 的群组频道；两个路由

**测试**：
- API：
  - 可见性（成员、拍板人、其他人 404）；动作只下发给拍板人
  - §3.2 表格的每一格
  - 引用分别对照草稿和候选版本；建议保存 `original` 和 `source_version`；`client_id` 幂等
  - 开场只在开放后出现，重开不重复；确认分隔线
  - 未读不算自己和开场；已读只增不减
  - 私聊 scope 的可见性；私聊不进快照（AC-08、AC-09、AC-24）
- web：
  - 字段顺序与「占位」标记
  - 各阶段按钮的出现与消失
  - 群组线的渲染；「截止后留言」标签
  - 输入条的停用和占位字
  - `RoundClock` 的各种写法
- 浏览器：成员和 CEO 两个入口，在 1440 和 390 宽都不横向溢出

### 04c · 集中 Review 与确认

**范围**：
- decide、confirm 两个动作
- 处理结果句、候选版本、冲突
- 「本轮」那一行截止后的部分：三步、逐条处理入口、重开弹窗、核对表单、确认记录
- 确认后的只读状态；Mission 页上的状态标记

**测试**：
- 处理：只有拍板人能处理；同一字段采纳第二条返回 409；先不采纳、再采纳另一条可以；可以改判；版本 +1
- 确认：
  - 有未处理的意见、核对为空、旧版本，都拒绝
  - 重放不重复写入；Mission 版本已变返回 409
  - 写回：只写被采纳的字段；每个 Mission 只升 1 次；列表字段按行拆；`applied_versions` 正确
- 确认后：发意见返回 409；重开返回 409
- 重开后，结转的已采纳仍在候选版本里；截止后留言不阻止确认；计数正确（AC-10、AC-11、AC-12）
- web：
  - 处理结果句
  - 只有拍板人看到按钮
  - 有冲突时「采纳修改」停用，并写明原因
  - 核对为空时不能确认

### 04d · 通知、入口与引导中的状态

**范围**：
- `/api/me/mission-cards`；CEO 首页的 `mission-round` Card
- `MissionCardNoticeGroup` 进成员通知栏；CEO 入口的各个阶段
- 共享分钟时钟接入两处
- 成员战场详情状态块（依赖 03）
- 引导：「你这个月的工作」里我的本月卡；「下一件事」里的轮次文案（依赖 01）
- Mission 页上的草稿、占位、已确定小标

**测试**：
- 收件人：Owner 只有自己一行；拍板人看到全部行，按顺序排；其他人看不到这张卡
- 各阶段的文字和 `todo`；截止后这张卡还在；确认后消失；CEO 首页有这一条，确认后消失（AC-16）
- 共享时钟：用假计时器验证两个订阅者在同一个 tick 换数字；越过截止时触发重新拉取（AC-07）

### staging 整体验收

1. CEO 签发 10 月计划，在通知栏按「整理个人卡草稿」。用 SQL 核对：1 个轮次、5 张卡、12 条 Mission，`placeholder=true`，版本都是 1。
2. CEO 在「战略决策更新」里打开，按「统一开放 48 小时讨论」。
3. 孙铭泽登录：
   - 通知栏最上面是「10 月 Mission Card」，只有他自己那一行；倒计时和页头同一刻换数字。
   - 他发一条评论、一条划词引用、一条修改建议。
   - 刘人豪打开孙铭泽的卡，返回 404。
4. 在 staging 用 SQL 把 `opened_at` 和 `closes_at` 一起往前挪 47 小时 58 分（这是运维手段，不是产品功能）：
   - 倒计时从 2 分走到 0，60 秒内变成等拍板。
   - 之后提修改建议被拒；发评论被标成截止后留言。
5. CEO 逐条处理：同一字段冲突时按钮停用。然后重开：进入第 2 轮，已处理的结论被结转。
6. 再次截止后，填写核对结论并确认：
   - Mission 版本 +1，采纳的字段已写入。
   - 通知分组消失；Mission 总览写「已确定 · 占位」。
   - `mission.edit` 被拒，并写明原因。
   - 卡页仍然能打开，历史完整。

**核实情况**：
- MVP 与概念版的代码、迁移、契约、行号都读代码核实过。
- 以下是推断，未连库核实：真实库里战场 code「01」和能力域 03、04、05 是否存在；三个战场的负责人都没设。
