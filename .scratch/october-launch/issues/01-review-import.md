# 01 · 导入飞书 9 月复盘，CEO 从公司复盘开始

Type: implementation
Status: ready-for-agent
Blocked by: —（需在 10/7 部署前完成，或部署后作为 CLI 单独运行）

## 背景

9 月复盘已在飞书「业务域」知识库里由各人写完。用户 10/6–10/7 决定：导入成天枢里的复盘；战场复盘和飞书里没有域级复盘的能力域由 Co-Agent 按个人复盘汇总，**不走负责人提交和 CEO 逐项确认**；CEO 的第一步是公司复盘和 LTO 决定。决定记录：项目文档 `claude/决策记录_10月上线与协作批注_2026-10-06.md`。

数据已准备好（飞书原文，2026-10-07 导出）：

- `seed/imports/missions-2026-09.json`：新增 `05-4`（于斯一，能力域 05，战场 01），原来漏导。共 23 条。
- `seed/imports/reviews-2026-09.json`：
  - `personalReviews`：6 人的个人复盘四栏（白田田、陈溪南、孙铭泽、刘人豪、于斯一、王创峰），每栏 `sources` 是飞书链接。归栏规则见文件里的 `mappingRule`。
  - `draftFromMaterials`：秦梦怡、唐巨杰没有 Period Review，给的是他们的周复盘和 9 月任务卡原文，用来让 Co-Agent 起草。
  - `capabilityReviews`：能力域 03 / 05 / 08 的复盘直接取对应个人复盘的四栏（三人的 Period Review 本身就是域级复盘）。

## 要做什么

新增 CLI `reviews:import`（照 `scripts/import-missions.ts` 的写法：契约校验、整批一个事务、可重复运行、`--dry-run`），参数 `<reviews.json> --cycle-start <ISO 时间>`。前提：`missions:import` 已经跑过。

1. 建 9 月复盘：没有就调用现有 `createMonthlyReview` 的同一套逻辑；已存在则沿用（线上 9/28 之后调度器可能已经建过，见 personal-review spec 的「补建」）。`cycle_started_at` 写成 `--cycle-start`（开工时间，不是导入时间），72 小时倒计时从这里算。
2. 个人复盘：
   - `personalReviews` 里的 6 人：直接写成 `submitted`，`self_review` 用文件内容，`submitted_at` = 导入时间。`draft_source` 新增取值 `import`（改契约 `PersonalReviewDraftSource`，重新生成客户端）。页面上显示「从飞书导入」，四栏下的来源链接可点。
   - 秦梦怡、唐巨杰：把 `materials` 作为这份个人复盘的材料（沿用个人复盘现有的材料入口，Co-Agent 起草读的那一份），以系统身份触发 `draft_with_co_agent`，结果停在 `draft`，等本人提交。起草提示里注明「材料是周复盘与任务卡，不是本人写的月度复盘」。
   - 已经存在且非 `waiting` / `drafting` 的个人复盘不覆盖，打印跳过。
3. 能力域复盘项 03 / 05 / 08：四栏取对应个人复盘，状态记为已确认，但**确认来源记为导入**（新增字段，例如 `confirmation_source text CHECK IN ('ceo','import')`，`confirmed_by` 为空）。页面显示「飞书导入 · 未在天枢逐项确认」，不显示成 CEO 确认过。
4. 其余复盘项（战场 01/02/03，能力域 04/07/09）：沿用现有逻辑——看板齐了（个人复盘全部 submitted / skipped）时由起草 Agent 按个人复盘起草；**本次复盘带导入标记时**，起草成功后直接置为已确认、来源 `import`，不进入负责人提交和 CEO 确认。起草失败的项保持现状，CEO 可重试。导入标记存在 `monthly_reviews` 上（例如 `origin='import'`），只影响这一轮。
5. 之后照旧：`advanceMonthlyReviewIfReady` 进入 `summarizing` → 公司复盘 → CEO 确认 → LTO 决定。
6. **LTO 决定后的 10 月计划**：现在 `decide_ltco` 在下月计划已存在时什么都不做（`planExisted`）。改为：计划未签发、且 CEO 还没改过草案也没核对过任何项时，按复盘结果重新生成草案；CEO 已经动过时不覆盖，在计划页显示一行「草案生成于复盘之前」和「重新生成」按钮（沿用现有重新生成动作）。线上 10/1 的调度器很可能已经生成过一份没有复盘输入的 10 月草案，这一条就是为它。

## 不做

- 不导入周复盘本身，不导入 10 月 PDO（王创峰的 10 月卡见工单 02）。
- 不改复盘四栏的长度上限（导入内容都在 4000 字以内）。

## 完成定义

- 测试：导入幂等；6 人 submitted 且来源为 import；两人进入 draft；03/05/08 已确认且来源为 import；其余项在看板齐后起草并自动确认；`cycle_started_at` 等于参数；进入 summarizing；LTO 决定后，未动过的已存在计划被重新生成、动过的不覆盖。
- 在临时库上用真实文件跑 `missions:import` + `reviews:import --dry-run` 和正式运行各一次，输出报告贴进本工单 Comments。
- API 类型检查、相关测试通过。

## Comments

### 2026-10-08 · 实现（feat/october-launch-01，迁移 056）

**做了什么**

- 迁移 `056_review_import.sql`：`monthly_reviews.origin`（`'import'` / 空）；`monthly_review_items.confirmation_source`（`ceo` / `import`，已确认的旧项回填 `ceo`）；`personal_reviews.draft_source` 加 `import`；`personal_reviews.imported_materials`（`[{title, sourceRef, markdown}]`）。
- 契约：`PersonalReviewDraftSource` 加 `import`；复盘项详情与总览行加 `confirmationSource`；`MonthlyPlanGeneration` 加可选 `beforeReview: true`。已重新生成客户端。
- CLI `reviews:import <reviews.json> --cycle-start <ISO> [--dry-run]`（`scripts/import-reviews.ts`，逻辑在 `src/monthlyReviewImport.ts`）：整份文件用契约校验（四栏用 `MonthlyReviewSelfReview`），整批一个事务，有问题全部回滚；`--dry-run` 跑完整写入后回滚。前提检查：该月没有 Mission → 「先运行 missions:import」；名单里的人不在人员名单或没有该月 Mission、能力域编号不在注册表都报错不写。
  - 复盘：没有就走 `createMonthlyReview` 同一套逻辑（拆出事务内版本 `createMonthlyReviewInTransaction`），有就沿用；标 `origin='import'`，`cycle_started_at` 写成 `--cycle-start`。
  - 6 人：`submitted`、`draft_source=import`、`submitted_at`=导入时间。秦梦怡、唐巨杰：材料写进 `imported_materials`，状态置 `drafting`（系统触发，不写本人的动作指纹），起草由 API 服务接手，结果停在 `draft`。起草提示加了一句「importedMaterials……材料是周复盘与任务卡，不是本人写的月度复盘」。
  - 能力域 03/05/08：四栏取对应个人复盘（文件原文），`confirmed`、`confirmation_source=import`、没有确认人（不写确认记录）。战场 01/02/03 和有 9 月 Mission 的能力域（04/07/09）：清掉九月底旧版本起草的稿子回到 `waiting`，交齐后起草。没有 9 月 Mission 的旧能力域项不动、不参与这一轮。
- 起草由谁跑：CLI 只在事务里写状态。月末复盘调度器（API 进程内，每分钟）每次接手「收集中、状态为 drafting、本进程没在跑」的个人复盘与复盘项起草；按 runId / 版本去重，动作后立即启动的和调度器接手的不会跑两份。个人复盘交齐的衔接抽成 `startUnitReviewsIfComplete`，最后一份提交 / 跳过与导入共用（导入时已经交齐也能进入起草）。
- 导入的复盘：复盘项起草成功直接确认（`confirmation_source=import`），不走负责人提交和 CEO 确认，随后照旧 `advanceMonthlyReviewIfReady` → `summarizing` → 公司复盘。导入的复盘里，有当月 Mission 的能力域项也要确认完才汇总。起草失败保持 `draft_failed`，CEO 可重新起草。负责人不再收到这一轮的复盘项待办。
- 页面：个人复盘副标题「从飞书导入」，四栏「依据」里的链接可点（复盘项页同样）；导入确认的项状态写「飞书导入 · 未在天枢逐项确认」。
- LTO 决定后：下月计划未签发、CEO 没改过也没核对过（`negotiation.edits`、`checkedItemIds` 都为空）、生成已结束 → 走「重新生成草案」同一转换和执行入口，按复盘重新生成（`planExisted=false`）；否则不覆盖，标 `generation.beforeReview`，计划页显示「草案生成于复盘之前」和「重新生成」，重新生成后提示消失。

**验证**

- API：`TEST_PG_URL=… npx vitest run test/reviewImport.test.ts test/monthlyReview.test.ts test/personalReviews.test.ts test/migrate.test.ts test/monthlyPlan.test.ts test/monthlyPlanSign.test.ts test/promptGovernance.test.ts test/missionDraftHome.test.ts` → 最终代码 8 文件 76 个测试全部通过。新增 `test/reviewImport.test.ts`（5 个）：真实导出文件过契约；CLI 缺 Mission 整批不写、`--dry-run` 不写、正式导入、重复运行行不变；完整流程（导入 → 调度器接手按材料起草且只跑一次 → 提交后交齐 → 战场与能力域起草并自动确认、起草失败可重试 → summarizing → 公司复盘 → LTO 决定后按复盘重新生成已存在的 10 月草案）；本人改过 / CEO 已跳过不覆盖；交齐后才导入时复盘项交给服务端起草。`monthlyReview.test.ts` 原「已存在计划不重建」的用例按新规则改为「没动过的重新生成」，另加「动过的保留并提示、重新生成后提示消失」。
- Web：`npx vitest run src/components/monthlyReview/monthlyReview.test.tsx src/cards/monthlyWorkspace.test.tsx` → 25/25。
- 类型检查：`pnpm --filter @warmap/api typecheck`、`@warmap/web`、`@warmap/contracts` 通过；脚本另用临时 tsconfig 检查 `scripts/import-reviews.ts` 通过。
- 临时库（迁移到 056，注册表按线上编号：战场 01/02/03、能力域 03/04/05/07/08/09；人员 seed 为临时名单；最终代码在新库上重跑一遍，输出相同）：

```
reviews:import（missions:import 之前）→ exit 1
有 1 个问题，整批没有写入：
2026-09 还没有 Mission：先运行 missions:import

missions:import seed/imports/missions-2026-09.json → 完成：23 条导入，0 条已存在。

reviews:import … --cycle-start 2026-10-08T09:00:00+08:00 --dry-run → exit 0（之后三张表都是 0 行）
│ 月度复盘   │ 9 月          │ 新建，标为导入                │
│ 个人复盘   │ 白田田 / 陈溪南 / 孙铭泽 / 刘人豪 / 于斯一 / 王创峰 │ 导入为已提交 │
│ 个人复盘   │ 秦梦怡        │ 交给 Co-Agent 按 2 份材料起草 │
│ 个人复盘   │ 唐巨杰        │ 交给 Co-Agent 按 4 份材料起草 │
│ 战场复盘   │ 01 灯塔项目 / 02 Token Ops / 03 002 客户 │ 等个人复盘交齐后起草 │
│ 能力域复盘 │ 03 Method / 05 E&O / 08 TokenHub │ 导入并确认 │
│ 能力域复盘 │ 04 Agents / 07 组织与人才 / 09 财务运营 │ 等个人复盘交齐后起草 │
校验通过（--dry-run，没有写入）：6 份个人复盘导入为已提交，2 份交给 Co-Agent 起草，3 项复盘导入并确认；开工时间 2026-10-08T09:00:00+08:00。

reviews:import …（正式）→ exit 0，表同上
完成：6 份个人复盘导入为已提交，2 份交给 Co-Agent 起草，3 项复盘导入并确认；开工时间 2026-10-08T09:00:00+08:00。
起草由运行中的 API 服务接手（每分钟检查一次），结果停在草稿等本人提交。
→ monthly_reviews: 2026-09 collecting origin=import cycle_started_at=2026-10-08 09:00（上海）
→ 6 份 submitted/import；秦梦怡 drafting（2 份材料）、唐巨杰 drafting（4 份材料）
→ 能力域 03/05/08 confirmed/import、无确认记录；战场 01/02/03、能力域 04/07/09 waiting

reviews:import …（再跑一次）→ exit 0
│ 月度复盘 │ 9 月 │ 已导入过 │ … 6 人「已导入，跳过」；秦梦怡、唐巨杰「材料已导入，跳过」；03/05/08「已确认，跳过」；其余「等个人复盘交齐后起草」
完成：0 份个人复盘导入为已提交，0 份交给 Co-Agent 起草，0 项复盘导入并确认；…
→ 三张表逐行 md5 与第一次之后完全相同
```

- 同一临时库上用真实 `createMonthlyReviewService` + 假 Agent 跑两次 `runScheduled()`：秦梦怡（2 份材料）、唐巨杰（4 份材料）各起草一次，状态 `draft`、来源 `co_agent`。

**没验证的**

- 沙箱里没有真实模型：起草、汇总只用假 Agent 验证，真实模型下的起草质量、那句材料说明的效果没有验证。
- 没有起 API 服务、没跑 `next build` 和浏览器（按分工由合并后统一做）；跨进程接手只在测试里由「另一个事务写状态 + 服务调度器接手」和临时库脚本验证。
- 跑测试时 `monthlyReview.test.ts`「updates only the given fields…」在机器负载高时失败过一次，随后三次重跑（单独、两文件并行、四文件并行）都通过；这条断言提交后响应里评估是 `running`，与刚启动的假评估有竞态，不是这次改的代码。

**上线注意 / 后续**

- 和工单原文的出入：原文写「已存在且非 waiting / drafting 的个人复盘不覆盖」。9/30 之后新建的个人复盘会被 Co-Agent 自动起草到 `draft`，部署后调度器一分钟内就会建好并起草，照原文规则 6 人全部会被跳过。实现为：已提交、已跳过、本人动过（有动作指纹）的不覆盖；本人没碰过的自动草稿可以覆盖。
- 导入请在 API 服务运行时跑（或导入后 10 分钟内启动服务）；服务重启会把进行中的复盘项起草标为失败（原有恢复规则），需要 CEO 点「重新起草」。
- 部署后到导入之间，调度器会先给 8 人各跑一次 Co-Agent 自动起草（真实模型调用），导入后这些稿子被覆盖或作废。
- 复盘项「飞书导入 · 未在天枢逐项确认」用工单原文；决定记录 1c 对 Co-Agent 汇总的那几项写的是「导入 · 未在天枢逐项确认」，如要区分需要再改。
- Status 和 map 的结果摘要留给合并时统一更新。
