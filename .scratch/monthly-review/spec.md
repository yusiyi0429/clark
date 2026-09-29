# 月末复盘与 LTCO 决定 · Spec

- 来源：2026-09-28「M1B 模拟演练」会议共识（飞书妙记 `obcna7spi9pmwkx5249koooy`，逐字稿）。
- 范围：会议共识中的 A（月末复盘）与 B（LTCO 决定）。C（月末周期连成一条的进度入口）与 D（PCO 与 Mission 同屏、卡片级锁定、纪要三页签、co-agent 主动介入）等月底试用反馈后再定。
- 命名：会议里的 LTO = 代码中的 LTCO；PO = PCO。

## 1. 为什么

CEO 的原话是上个月的复盘“一晃而过”。月度计划（LTCO → PCO）和 Mission 轮次都已经有了，但缺少月末的复盘与检视，经营判断因此没有起点，经验也沉淀不下来。会议定下的标准管理节点是：每个月末**先复盘（自下而上），再拆解（自上而下）**，两者在体验上连续。

本期交付这个节点的前半段，以及它和现有月度计划之间的衔接：

复盘项（战场 / 能力域）→ CEO 逐项确认 → 公司复盘 → LTCO 决定 → 生成下月计划草案（沿用现有流程）

## 2. 会议共识映射

| 会议共识 | 本期做法 |
|---|---|
| 月末时间窗口自动触发，co-agent 通知 DRI 做自评 | 每月倒数第 3 天（Asia/Shanghai）自动创建复盘并生成复盘项，DRI 在通知中看到待办 |
| DRI 的 agent 先起草，DRI 与它沟通后确认提交 | 复盘起草 Agent 生成四栏自评；DRI 与自己的 agent 对话或直接编辑后提交 |
| co-agent 评估自评与公司视角的偏差 | 提交后运行偏差评估 Agent |
| CEO 逐项反馈，同意即确认，不同意再改 | CEO 逐项确认或打回（必须写原因）；打回后 DRI 修改并重新提交 |
| CEO 只看到战场 / 能力域一层，不看个人 | 复盘项只按战场 / 能力域建，每项一名负责人 |
| 复盘确认后形成公司当前最新状态 | 公司复盘：5 条关键经营判断，CEO 确认 |
| 复盘与“LTO 要不要改”拆成两个界面；LTO 主要看战略，复盘只是输入之一 | 独立的 LTCO 决定页，Agent 给出建议（可以建议不改），CEO 选择保持不变或采用修订 |
| 复盘完成后进入拆解 | LTCO 决定后立即生成下月计划草案，复盘作为输入；1 日作为兜底 |
| 第一版只到战场 / 能力域（用户决定） | 不做 Mission 层复盘；Mission 的复盘沉淀只作为起草材料 |
| 能力域要有负责人（用户决定） | 能力域配置增加 ownerId |
| 数据先在系统外跑通 | 负责人在复盘项对话里上传手写的复盘（PDF / Word / Markdown，复用对话附件），agent 按材料给各栏改写建议 |

## 3. 领域对象

### 3.1 月度复盘 MonthlyReview

- 按月唯一，`period` 为被复盘的月份（`YYYY-MM`，例如 `2026-09`）。
- 状态：
  - `collecting`：复盘项未全部确认
  - `summarizing`：全部确认，公司复盘待 CEO 确认
  - `ltco_pending`：公司复盘已确认，LTCO 待决定
  - `closed`：LTCO 已决定
- 公司复盘字段 `companySummary`：
  - `judgments`：5 条关键经营判断，`{title, body}[]`
  - `generation`：生成状态，同 MonthlyPlan
  - `confirmedAt` / `confirmedBy`
- LTCO 决定字段 `ltcoDecision`：
  - `suggestion`：`{ change: boolean, proposedLtco: string, rationale: string }`，由 Agent 生成
  - `decision`：`keep | revise`
  - `ltcoBefore` / `ltcoAfter`
  - `decidedAt` / `decidedBy`
  - `planId`：触发生成的下月计划 id

### 3.2 复盘项 MonthlyReviewItem

- 由 `(reviewId, subjectType: battlefield | capability, subjectId)` 唯一确定，负责人为 `ownerId`。
- 创建时的负责人取自注册表；注册表中负责人为空时挂到 CEO 名下，页面显示“待指派 · CEO 代复盘”。
- `target`：本月目标快照，即被复盘月份已签发 MonthlyPlan 中该战场 / 能力域的 PCO 原文。没有签发计划或没有这一项时为 `null`，页面显示“本月没有签发的目标”。
- 自评 `selfReview` 分四栏，均为文本：
  - `achievement`：达成情况
  - `gaps`：差距
  - `causes`：原因
  - `nextAdjustments`：下月调整
- 每栏可以带 `sources: string[]`，指向起草时引用的材料或原文。
- 状态：
  - `drafting`：起草 Agent 运行中
  - `draft_failed`：可见错误，DRI 或 CEO 可以重试
  - `draft`：DRI 修改中
  - `submitted`：已提交，等待 CEO
  - `returned`：被打回，带 `returnReason`，DRI 修改中
  - `confirmed`：已确认，只读
- 偏差评估 `assessment`：
  - 内容：`{ deviations: {point, evidence}[], questions: string[], overall: string }`
  - 生成状态：`pending | running | ready | failed`
  - 每次提交重新生成
  - 评估失败不阻塞 CEO 确认，页面显示“评估失败 · 重试”
- `version`：每次写入加 1，Action 按版本校验，重放幂等。
- 历史：每次提交、打回、确认都追加一条记录 `{at, by, action, reason?, selfReviewSnapshot}`，保存在 `history` JSONB 中。

### 3.3 能力域负责人

- `capability_config` 表增加 `owner_id TEXT NOT NULL DEFAULT ''`，和战场的做法一致。
- 能力域配置页可以选择负责人。
- 复盘入口按负责人投影，其他权限不变。

## 4. 流程与 Action

所有写操作都走 `POST /api/actions/execute`，按现有 Action 模式执行：带 version，支持幂等，并校验权限。

| Action | 执行人 | 前置状态 | 效果 |
|---|---|---|---|
| （调度器）创建复盘 | 系统 | 当月没有复盘，且 Company Day ≥ 月末倒数第 3 天 | 创建 MonthlyReview 和全部复盘项（`drafting`），异步起草 |
| `monthly-review.open` | CEO | 当月没有复盘 | 手动提前开启，效果同上；上线当月和演示时用 |
| `monthly-review-item.retry_draft` | 负责人 / CEO | `draft_failed` | 重新起草 |
| `monthly-review-item.update` | 负责人 | `draft` / `returned` | 保存四栏，可以只改部分栏 |
| `monthly-review-item.submit` | 负责人 | `draft` / `returned`，且四栏非空 | → `submitted`，触发偏差评估 |
| `monthly-review-item.retry_assessment` | CEO | 评估 `failed` | 重跑评估 |
| `monthly-review-item.return` | CEO | `submitted` | → `returned`，必须写原因（1–500 字） |
| `monthly-review-item.confirm` | CEO | `submitted` | → `confirmed`；全部确认后复盘进入 `summarizing` 并触发公司复盘汇总 |
| `monthly-review.update_summary` | CEO | `summarizing` 且汇总已生成 | 编辑关键经营判断 |
| `monthly-review.retry_summary` | CEO | 汇总 `failed` | 重新生成 |
| `monthly-review.confirm_summary` | CEO | `summarizing` 且汇总已生成 | → `ltco_pending` |
| `monthly-review.decide_ltco` | CEO | `ltco_pending` | `keep`：LTCO 不变；`revise`：在同一事务里写入 Company Strategy Config。然后 → `closed`，并为下月立即创建计划草案 |

- CEO 如果同时是某一项的负责人（包括“待指派”项），可以自己提交、自己确认，不另设例外。
- 下月计划草案的衔接：
  - `decide_ltco` 为下一个 period 调用现有的月度计划创建与生成流程（把 `runScheduled` 抽成可以指定 period 的函数）。
  - 下月计划已存在时不重复创建：未签发的草案保持原样，页面提示“已有草案，可在计划页重新生成”。
  - 1 日的定时生成不变，作为兜底。
- 下月计划草案的输入增加 `previousReview`：
  - 包含已确认的公司复盘（关键经营判断）和各复盘项的四栏自评。
  - 找不到已关闭的复盘时为 `null`，Agent 照常生成。
  - 这项输入替代现在“上月复盘”只有上月计划原文的情况，上月计划仍然保留作为输入。
- 进程重启恢复：`drafting` 或 `running` 状态中断的项标为 failed，等待手动重试，和 MonthlyPlan 的处理一致。

## 5. Agent

三个 Agent 都走现有的 Pi 运行框架，使用 heavy 模型档位，输出经 TypeBox 严格校验，校验失败按生成失败处理。

1. **复盘起草 Agent**
   - 输入：
     - 本项的 target（PCO）
     - 战场 / 能力域的六个月目标
     - 被复盘月份计划中与本项相关的待办和 DRI 反馈
     - 同一 period、挂在本战场或本能力域上的 Mission 的“复盘沉淀”
     - 相关的 CompanyMemory 段落
   - 输出：四栏自评和各栏的 sources。
   - 规则：
     - 没有材料时如实写“缺少材料”，不编造达成情况。
     - 负责人在对话里上传手写的复盘后，对话 agent 按材料给各栏改写建议，不会自动覆盖已有内容。
2. **偏差评估 Agent（co-agent）**
   - 输入：
     - 提交的自评
     - 公司视角材料：target、计划反馈、CompanyMemory、同期其他项的自评
   - 输出：偏差点和证据、CEO 可以追问的问题、一句话总评。
   - 只评估，不改自评。
3. **公司复盘汇总 Agent**
   - 输入：
     - 全部已确认的复盘项
     - 当前 LTCO
     - 战场 / 能力域的六个月目标
     - 已确认的方向（Issue 决定）
   - 输出：
     - 5 条关键经营判断
     - LTCO 修订建议 `{change, proposedLtco, rationale}`。按会议共识，LTCO 主要看战略有没有变，复盘只是输入之一，所以 Agent 默认倾向不改，只有证据足够时才建议修订。

**对象对话**

- 新增会话 scope `monthly-review-item:<id>`，只有本人能看到。
- 负责人在右侧与自己的 agent 讨论。agent 可以给出对某一栏的改写建议，负责人点“采用”后才写入（执行 `update` Action）。agent 不直接写入。
- CEO 在复盘项页有自己的对话（同一 scope，按本人隔离），用来追问和理解。

## 6. 页面（apps/web）

沿用现有的页面框架、DetailPanel、ConversationDock（含附件上传）和 token，不引入新的视觉体系。手持（≤959）和工作台（≥960）两种布局都要可用。

1. **复盘项页**
   - 路径：成员 `/me/reviews/items/[itemId]`，CEO `/reviews/items/[itemId]`，两者共用阅读组件。
   - 左栏：
     - 顶部：战场 / 能力域名称和本月目标（target）
     - 四栏自评：负责人在可编辑状态下直接编辑，保存走 `update`
     - 来源标注
     - 状态行：草稿 / 已提交 / 被打回（显示原因）/ 已确认
     - 提交后显示偏差评估，负责人也能看到
   - 右栏：本人的 agent 对话。
   - 操作按钮：
     - 负责人：提交
     - CEO：确认 / 打回（打回时弹窗写原因）
2. **CEO 复盘总览**：`/reviews/[period]`
   - 顶部进度，例如“9 月复盘 · 7 项中 5 项已提交，3 项已确认”。
   - 按战场、能力域分组列出每一项：负责人、状态、自评摘要（achievement 的首句）、评估总评，以及确认 / 打回。点开进复盘项页。
   - 全部确认后显示公司复盘：5 条关键经营判断（可编辑）和“确认公司复盘”按钮。
3. **LTCO 决定页**：`/reviews/[period]/ltco`
   - 显示当前 LTCO 原文，以及 Agent 的建议和理由。
   - 两个选项：“保持不变”，或“采用修订”（修订文本可编辑，预填 Agent 的建议）。
   - 确认后跳转到 `/plans/[下月]`。
4. **入口（通知投影，跟 Mission Card 通知一样，只读投影、不入 notifications 表）**
   - 负责人：“9 月复盘待你完成”（`draft` / `returned` / `draft_failed`），点击进入复盘项页。
   - CEO：
     - “9 月复盘：N 项待你处理”（有 `submitted` 项）
     - “待确认公司复盘”
     - “待决定 LTCO”
     - 以上都指向总览页或 LTCO 页
   - CEO 在当月还没有复盘时，可以在总览页点“开始 9 月复盘”（`monthly-review.open`）。

## 7. 权限

- 复盘项：负责人和 CEO 可读。其他成员不可读（会议共识是“同一战场内透明”，但复盘项只有负责人一人，本期不开放给其他成员）。
- 对话按本人隔离。
- 复盘总览、公司复盘和 LTCO 决定页只有 CEO 可访问。

## 8. 契约与数据

- `packages/contracts/src/monthlyReviews.ts`：定义对象投影、Action 请求和页面响应的 schema；`ConversationScope` 的正则加入 `monthly-review-item`。
- 迁移 `044_monthly_reviews.sql`：
  - 新建 `monthly_reviews`、`monthly_review_items`
  - `capability_config` 增加 `owner_id`
- Web 客户端从 OpenAPI 重新生成，不手改生成文件。
- CONTEXT.md 增加 Monthly Review 和 Monthly Review Item 术语；ADR-0024 记录“月末复盘是月度计划的起点，LTCO 决定后才生成下月草案，1 日兜底”。

## 9. 验收

1. 调度器在 9 月倒数第 3 天（或 CEO 手动开启时）创建复盘，每个战场和能力域各一项，负责人正确；负责人为空的项挂到 CEO 名下。
2. 起草 Agent 输出四栏自评并标注来源；失败时状态可见且可以重试；进程重启不会让运行中的项永远卡住。
3. 负责人能在对话中请 agent 改写，采用后才写入；直接编辑可以保存；四栏都有内容才能提交。
4. 提交后生成偏差评估，DRI 和 CEO 都能看到。
5. CEO 打回必须写原因，DRI 能看到原因，修改后重新提交会重新评估；确认后只读。
6. 全部确认后生成 5 条关键经营判断，可以编辑，确认后进入 LTCO 决定。
7. 选“保持不变”时 LTCO 不变；选“采用修订”时 Company Strategy Config 被更新。两种情况都会立即创建并生成下月计划草案，草案 Agent 的输入包含复盘；1 日兜底不重复创建。
8. 非负责人成员不能读或写复盘项，成员不能访问 CEO 页面；所有 Action 重放都幂等，旧版本会被拒绝。
9. 负责人和 CEO 都能在通知中看到正确的待办，点击进入正确页面。
10. 在浏览器中按 1440、834、375 三种宽度走完全程：开启 → 起草 → 对话改写 → 提交 → 打回 → 重交 → 确认 → 公司复盘 → LTCO → 下月草案。

## 10. 不做

- Mission 层复盘（mission owner 和 DRI 之间）
- 复盘周期进度条或统一入口（C）
- PCO 和 Mission 同屏、卡片级确认锁定、纪要三页签、co-agent 主动介入、按角色切视图（D）
- 页面内的体验反馈按钮
- 复盘结果写回 CompanyMemory
- 通知推送到飞书
