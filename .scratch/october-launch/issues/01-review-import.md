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
