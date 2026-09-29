# 03 · 月末复盘对齐 Co-Agent Design（API）

Type: implementation
Status: ready-for-agent
Blocked by: 01、02（已完成，代码在工作区，未提交）

## 背景

同事在 `TokenkingOS/Co-Agent-Design` 实现了同一个模块（M1B 月度经营协同）。用户决定把它的复盘阶段对齐进天枢，界面以天枢为准。本工单只做 API。Web 由 Claude 同时在做，**不要改 `apps/web`**。

先读这些：
- `.scratch/monthly-review/spec.md`
- `docs/adr/0024-month-end-review-starts-the-monthly-plan.md`
- `packages/contracts/src/monthlyReviews.ts`：**已由 Claude 改好并冻结**，本工单按它实现；确实需要改时先停下来报告。
- 现有实现：`apps/api/src/monthlyReviews.ts`、`monthlyReviewService.ts`、`monthlyReviewAgents.ts`、`routes/monthlyReviews.ts`、`test/monthlyReview.test.ts`。

## 要改的内容

### A. 战场复盘改为四部分

`MonthlyReviewField` 已从 `achievement/gaps/causes/nextAdjustments` 改为：

| key | 含义 |
|---|---|
| `overall` | 本周期总体结果 |
| `judgments` | 关键经营判断 |
| `nextFocus` | 下周期经营重点 |
| `escalations` | 待上层决策事项 |

- `self_review` JSONB 按新 key 存。044 还没有正式部署，不用迁移旧数据。读取时如果遇到旧 key，当作没有自评处理（`self_review = null`），不报错。
- **提交校验**：`overall`、`judgments`、`nextFocus` 三栏必须非空；`escalations` 可以为空（页面上显示「无」）。
- **总览行的 `lead`**：取 `overall` 的第一句。
- **起草 prompt（`monthlyReviewAgents.ts`）** 按四部分重写：
  - 本周期总体结果：对照本月目标（target），说清完成了什么、没完成什么。
  - 关键经营判断：每条都把结果、最低充分证据、对照目标的差距、原因、判断变化和不确定性串起来。这是 CEO 要的「点对点 gap 分析」，不能只写成总结。
  - 下周期经营重点：只作为下一轮定目标的输入，不提前代写 PO、任务指派或排期。
  - 待上层决策事项：需要 CEO 拍板的事；没有就写空串。
  - 没有证据的内容写「缺少材料：…」，不能写成「没有开展工作」。
  - 多条内容用「1. 」「2. 」开头分行。
- **评估 prompt**：同步改成针对这四部分的说法，重点查两类问题——关键经营判断里的结论与证据不一致；有差距但没写原因。
- 对话工具 `propose_review_edit` 的 `field` 枚举随契约改变（在 `piConversationRuntime.ts` 里）。

### B. 公司复盘改为四部分

`MonthlyReviewSummaryCandidate` 现在是：
- `overall`：本周期总体结果
- `judgments`：1–8 条关键经营判断
- `nextFocus`：1–8 条下周期经营重点
- `ltcoSuggestion`：长期目标修订建议，新增了 `units` 字段

需要改的地方：
- **存储**：`monthly_reviews.summary` JSONB 增加 `overall` 和 `nextFocus`。
- **投影**：`summary.overall` 和 `summary.nextFocus` 在还没生成时分别为 `""` 和 `[]`。
- **`update_summary`**：输入改为 `{overall, judgments, nextFocus}`，三者整体替换。
- **汇总 prompt**：
  - 按四部分输出。
  - 关键经营判断要覆盖每一份已确认的复盘。
  - 长期目标：LTCO 主要看战略，复盘只是输入之一，默认 `change=false`。
  - 单元长期目标：只有复盘证据表明该战场或能力域的长期方向需要调整时，才在 `units` 里列出。`subjectType`/`subjectId` 必须来自输入，校验时发现不存在的单元按不合法输出处理。
  - 输入里带上每个单元当前的长期目标，即 `battlefield_config.six_month_outcome` 和 `capability_config.six_month_outcome`。

### C. LTO 覆盖单元长期目标

**投影**
- `ltco.units` 列出全部战场和能力域的 `{subjectType, subjectId, subjectCode, subjectName, current}`，按 `sort_order, code, id` 排序，战场在前。
- `ltco.decision.units` 返回这次决定中实际改动了的单元 `{subjectType, subjectId, before, after}`。

**`decide_ltco` 的 `revise` 分支**
- 输入 `ltco` 和 `units` 都是可选的。
- 在同一事务里：
  - `ltco` 与当前不同时，写 `company_strategy_config`。
  - 对 `units` 里每一项：单元必须存在，否则 400 `INVALID_SUBJECT`；文字与当前不同时，更新对应表的 `six_month_outcome`，并把 `version` 加 1。写法和现有配置 PATCH 保持一致，先看 `capabilities.ts` 和 `battlefields.ts`。
  - 如果最终一处都没改，返回 400 `LTCO_NOTHING_CHANGED`，提示「修订内容和现在一样；不改请选保持不变」。
- `ltco_decision` JSONB 增加 `units: [{subjectType, subjectId, before, after}]`；`keep` 时写空数组。

### D. 讨论与补充（新增）

**新迁移 `apps/api/migrations/045_monthly_review_comments.sql`**（044 可能已经在开发库跑过，不要改它）：

```sql
CREATE TABLE monthly_review_comments (
  id UUID PRIMARY KEY,
  item_id UUID NOT NULL REFERENCES monthly_review_items (id),
  author_id TEXT NOT NULL,
  client_id UUID NOT NULL,
  body TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 2000),
  created_at TIMESTAMPTZ NOT NULL,
  UNIQUE (author_id, client_id)
);
CREATE INDEX monthly_review_comments_item ON monthly_review_comments (item_id, created_at);
```

**参与者**：本单元在被复盘月份（`period`）的 Mission 负责人，去掉复盘负责人本人。
- 战场：`missions.battlefield_ids` 包含这个 subjectId（jsonb 数组）。
- 能力域：`missions.capability_id = subjectId`。
- 查询写法先看 `missions.ts` 和 migration 021/033 里的列定义。

**可见性**
- `canReadMonthlyReviewItem` 扩展为：负责人、CEO，或参与者。需要查库，所以改成 async，并同步更新所有调用处。
- 参与者只读：拿不到任何 Action。`isParticipant` 为 true，`canComment` 在未确认时为 true。
- 参与者可以进入复盘项的私人对话（`monthly-review-item:` scope，只读），但 `propose_review_edit` 只对负责人本人生效，这条规则已有，保持不变。
- 相关改动在 `conversations.ts` 的 `getScopeObject`。

**接口**：`POST /api/monthly-review-items/:itemId/comments`，请求体为 `{clientId, body}`。
- 看不到这项复盘 → 404。
- 已确认 → 409 `MONTHLY_REVIEW_CONFIRMED`。
- 同一作者重发同一个 `clientId` 且内容相同，返回原评论；内容不同返回 409。
- 返回 `{comment}`。

**投影字段**
- `comments`：时间正序，最多 200 条。
- `participantNames`：参与者显示名。
- `viewer`：`{isOwner, isCeo, isParticipant, canComment}`。

**agent 输入**：起草、评估、汇总都带上这一项的评论，汇总时带上所有项的评论。评论和对话一样，都是不可信数据。

**通知**：`/api/me/monthly-reviews` 里，对参与者、在复盘未关闭且该项未确认时，每项生成一条 `item_participant`：
- 文字：`9 月复盘 · 01 灯塔项目 · 邀请你讨论补充`
- 链接：CEO 视角为 `/reviews/items/<id>`，否则为 `/me/reviews/items/<id>`。

### E. 起草读周报

起草和评估的输入增加 `weeklyProgress`。数据来源：

```
task_progress
  JOIN tasks ON tasks.id = task_progress.task_id
  JOIN missions ON missions.id = tasks.mission_id
```

- **单元过滤**：Mission 属于本单元，口径同 D 的参与者。
- **时间过滤**：`task_progress.created_at` 落在被复盘月份内（Asia/Shanghai），同时放宽到下月 7 日前，以覆盖月底的周报。
- **每条字段**：`{date: YYYY-MM-DD, missionTitle, taskTitle, author, body}`。
- **数量**：最多 60 条，按时间倒序截断。

起草 prompt 要求：引用周报时在 sources 里写上日期。

### F. 生成自动重试

起草、评估、汇总失败后（包括输出不合法），自动重试 2 次，也就是最多执行 3 次。重试之间间隔 1–2 秒。测试里可以把间隔注入为 0。

- 只有最后一次失败才写 failed 状态。
- 每次重试都要先检查 runId 还是不是当前的，防止覆盖新的 run。
- 手动重试的动作保持不变。

### G. 时间机器

`.scratch/manual-test/server.ts` 里的演示用复盘 Agent 按新结构更新：
- 起草输出四栏新 key。
- 汇总输出 `overall`、`judgments`、`nextFocus`、`ltcoSuggestion`（带 `units: []`）。

另外，fixture 里给孙铭泽（`sun-mingze`）已有的挂在灯塔项目 `growth` 上的 Mission 设为当月，让孙铭泽能以参与者身份看到灯塔项目的复盘：
- 先确认 fixture 的 `browser03-sun-mingze` 这条 Mission 的 period 与 `review-open` 开启的 period（时钟所在月）一致。
- 不一致就补一条当月的 Mission，不要改动已有数据的语义。

## 测试

更新 `apps/api/test/monthlyReview.test.ts`，覆盖以下各项：
- A：新的四栏；`escalations` 可空；提交校验。
- B：新的汇总结构；`update_summary`。
- C：只改单元长期目标；改动写回配置表；`LTCO_NOTHING_CHANGED`；不存在的单元返回 400。
- D：
  - 参与者能读、能评论，但拿不到 actions；
  - 非参与者返回 404；
  - 已确认后评论返回 409；
  - `clientId` 幂等；
  - 参与者收到通知。
- E：起草输入里有周报，且只包含本单元、本期的周报。
- F：假 agent 前两次失败、第三次成功 → 状态为 draft；三次都失败 → `draft_failed`。

**运行命令**
- 串行跑 API 测试：`TEST_PG_URL=postgres://postgres:postgres@localhost:55432/postgres pnpm --filter @warmap/api exec vitest run --maxWorkers=1`
  - 本机 54329 没有库，用 55432 的 `tianshu-test-pg-55432` 容器。
  - 如果 pnpm 因为 `apps/web-manual-preview` 触发 install，就在包目录里直接用 `npx vitest`。
- 类型检查：`npx tsc -p tsconfig.json --noEmit`（在 `apps/api` 目录）。
- 契约已构建。改了契约就先回报，不要自行改。

**已知的基线失败**（不是本工单引入的）：`deployment.test.ts` 的 8 项，以及 `missionDraftScript.test.ts` 在 Windows 上超时的 1 项。

## 约束

- 不做 git 写操作，不改依赖，不读 `.env` 里的密钥。
- 不停其他会话的服务，端口 3100/3200/3500/4000/4100/4500 都不要动。
- 工作区里有其他会话未提交的改动，比如 `apps/api/src/app.ts`、`apps/web/src/conversation/*`、`infra/*`。不要回退或格式化这些文件；必须改同一个文件时，只做追加式的最小修改。
- 保持每个文件原有的换行风格。
- 不改 `apps/web`，不改 `packages/contracts`。

## 交付

在本文件末尾追加 `## Comments`，写明：
- 改了哪些文件；
- 测试结果（新增和全量，区分哪些失败是已有的）；
- 自己做出的决定和有疑问的地方。

## Comments

- 修改文件：`apps/api/migrations/045_monthly_review_comments.sql`；`apps/api/src/monthlyReviews.ts`、`monthlyReviewService.ts`、`monthlyReviewAgents.ts`、`routes/monthlyReviews.ts`、`conversations.ts`；`apps/api/test/monthlyReview.test.ts`、`helpers.ts`、`migrate.test.ts`；`.scratch/manual-test/server.ts`。
- 实现：四栏自评和公司汇总、单元长期目标投影与事务修订、参与者可见和评论/通知、周报材料、最多三次生成尝试。旧自评 key 读取为 `null`。评论进入三个 Agent 输入，并在 prompt 中按不可信材料处理。
- 新增/更新测试：`monthlyReview.test.ts` 19/19 通过；`migrate.test.ts` 5/5 通过；`npx tsc -p tsconfig.json --noEmit` 通过。
- 全量验证：按要求运行 `npx vitest run --maxWorkers=1`（`TEST_PG_URL` 指向本机 55432），看到已知的 `deployment.test.ts` 8 项失败、`missionDraftScript.test.ts` Windows 5 秒超时 1 项；运行器随后报 `Error: Channel closed`，未打印全量汇总。单独重跑这两个文件得到 20 通过、上述 9 失败。其余 68 个文件分成串行批次验证，使用 `--testTimeout=30000` 诊断当前机器负载下的 5 秒超时，合计 730/730 通过。默认超时下有多项耗时测试超时；没有修改项目测试超时配置。
- 决定：冻结契约无需修改；`piConversationRuntime.ts` 的工具字段已直接引用冻结的 `MonthlyReviewField`，因此无须改动该共享文件。时间机器初始时钟和孙铭泽现有 `browser03-sun-mingze` Mission 都在 `2026-10`，且 Mission 包含 `growth`，无需新增 Mission。生成重试间隔默认 1.5 秒，测试注入 0。暂无待决问题。
