# 本体上下文取用

伙伴（对象页对话、CEO 对话）和后台作业怎么从本体（tkos.world）取上下文，2026-11-06「答案带出处」这次改了什么，还差什么。方向和切片设计见主对接会话的《本体上下文取用_提案_2026-11-06》；这里只写天枢代码里的现状。

## 现在的链路

天枢里有三条路读本体，首页对话不走其中任何一条：

| 谁在问 | 走哪条 | 代码 |
|-|-|-|
| 首页对话（`CHAT_SERVICE_URL` 开着时） | Chat 服务自己拿本体凭据直连本体：`list_world_objects`（按类型、周期、责任单元列）、`read_world_object`（R 句柄 → 对象正文和进展）。天枢的 `/internal/*` 回调里没有本体公司事实 | Chat_Service `src/reference.ts` |
| 对象页对话（Mission、Task、任务卡等） | `query_company` 工具和每轮开头的预取：按本人授权的域读本体公司事实 | `piConversationRuntime.ts` → `company.ts` → `companyWorld.ts` |
| CEO 对话 | 另有 `read_ontology`：进程内缓存 5 分钟的目标快照 | `worldReader.ts`（`loadWorldSnapshot`、`ontologyToolResult`） |
| 后台作业（雷达、会前预审、预研、月度起草与复盘、任务卡起草） | `readCompanyContext`：按 `COMPANY_SYSTEM_PERSON_ID` 的授权读公司事实 | `companyContext.ts` → `company.ts` |

`/internal/*` 里只有 `/internal/mission-plans` 读本体（本人本月 Mission 的计划块），返回里已经带 `plan.objectRef`（`id@version`），Chat 现在没有调用它。

全部只读：只发 GET，不用 `POST /context`（它每次落一条读取记录），不调用任何写动作。

### 改之前的问题

- **公司事实整片全读**：每次把授权域里的对象全列出来、逐个 GET（CEO 授权 8 个域时一次 54 个对象、3–4 秒），再按中文二元组在全文里打分，取前 8 条、7000 字节一页。
- **不带对象编号**：交给模型的只有标题和正文，答案没法标到具体对象。
- **当前进展从没进过上下文**：0.3 起 `records.latest_state` 是一份 StateSnapshot（正文在 `blocks` 里），投影只认 `text` / `summary` 字段，所以一直是空的。
- **CEO 目标快照只到周期目标**；而且在真实 scope（a92430fd）里，责任单元没挂 `tianshu / battlefield:<id>` 外部引用，`units` 是空的，实际只有 Company 和 Strategy 两份。

## 这次改了什么

### 1. 每条事实带对象编号和版本

`CompanyEntry` 多了 `ref`（`<object_id>@<version>`，和 `worldRef` 同一写法）和 `type`（对象类型）。`query_company` 的工具结果、对话预取、后台作业的 `companyProse` 都原样带出去：

```json
{ "ref": "7885a696-…@5", "type": "Mission", "title": "企业经营 Context 建模与数据供给", "text": "## …\n\n状态：已成立\n\n负责人：于斯一\n\n### 当前进展\n\n快照 4b5e763f-…@1 · 2026-11-05 · 于斯一的 Claude Code · 未确认\n\n当前状态：…" }
```

- 正文里的上级挂接写成「服务目标：<标题>（<ref>）」，只展开到本人授权范围里的对象，读不到的目标仍不透露。
- 当前进展、已确认复盘从 StateSnapshot 的块里取：一行快照 ref、日期、谁记的、是否未确认，再取各块正文（每条 ≤400 字、≤12 条），放在定义前面，问「怎么样了」时第一页就能读到。
- 修订号、哈希等协议元数据仍不进正文。
- `query_company` 的工具说明加了一句：正文里不写 ref，出处标记和本人追问出处时照抄它。
- CEO 对话的出处规则（`sourceCitations.ts`）加了一种：本体公司事实写 `[名称](cite:world:<ref>)`，照抄 `query_company`、`read_ontology` 给的 ref。前端认不出 `world:` 这类引用，按「只有名称」显示（和 `cite:source` 一样），所以界面不变；存下来的回答里带上了对象编号，以后加「本体对象」引用卡时直接能用。成员（DRI）对话的提示词里没有出处规则，这次没加。

### 2. 伙伴对话先定位再读

`company.read` 多了 `locate` 开关，只有伙伴对话（`query_company` 工具和预取）打开：

1. 按本人授权的域列对象头（域就是本人范围，一次列表 ~50 ms）。
2. 从问话认类型和周期（`locateHints`）：「战略」→ Strategy，「本月目标 / 10 月目标」→ PeriodGoal，「Mission / 任务卡」→ Mission，「Task」→ Task，「长期目标 / 六个月目标」→ LongTermGoal；「本月 / 上个月 / 10 月 / 2026 年 1 月」→ 周期。
3. 问到周期时让本体按 `period` 再筛一遍；**筛空就不按周期**（11 月的对象还没建，问「本月目标」会退回全部周期里找）。
4. 按标题打分挑对象（`locateHeads`）：检索词同 `query_company`；有类型提示且这类里有命中的只在这类里挑；只留分数不低于最高分一半的，最多 6 个。一个都没命中、但有类型提示且这类对象不超过 6 个时全读（如「战略是什么」只有一个 Strategy）。
5. 只 GET 挑出来的对象，逐个核对版本和列表一致。
6. **退路**：一个都定位不到（如「最近有什么需要我拍板的风险」），或读的时候对象变了，就走原来的全量读、按正文排序，结果和改前一样。

后台作业不开 `locate`：它们的检索词常是「战场名 + 人名」，人名只在正文（负责人）里，只看标题会漏。

### 3. CEO 目标快照到 Mission、Task 这一层

`loadWorldSnapshot` 多列两类对象头：Mission、Task，先按当前公司月筛，筛空就不按周期；撤销、取消的不列。只列头（标题、ref、状态、所属单元），不逐个读对象，每 5 分钟刷新多 2–4 次列表请求。`read_ontology` 多一个 `part=missions`，不带 `part` 时也给，每类最多 40 个；要某个 Mission 或 Task 的正文和进展，让模型用 `query_company` 按名称查（走上面的定位）。

Mission 挂哪个周期目标、Task 挂哪个 Mission 要读对象正文的 `relations` 才知道，这次没读，见「还差什么」。

## 评测

脚本 `apps/api/scripts/company-context-eval.ts`，用本机的 world 只读凭据读真实 scope（a92430fd），只发 GET，碰到 POST、`/context`、`/v1/actions` 直接退出；不打印凭据。授权文件临时生成：ceo 读全部 8 个域，member 只读 company + agents 两个域。

```bash
pnpm --filter @warmap/api exec tsx --env-file=<含 TKOS_WORLD_* 的 env 文件> scripts/company-context-eval.ts --out result.json
```

加 `--before` 不开定位（等同改前的全量读路径，但已带 ref 和进展）。下表「改前」是在旧提交 e22519f0 上跑的，「改后」是本分支（11/06 凌晨，两次结果一致）。每格：耗时 · 列表请求 · 读对象请求 · 给模型的 JSON 字节 · 带 ref 的条数。

| 问题 | 谁 | 改前 | 改后 | 改前读到 | 改后读到 |
|-|-|-|-|-|-|
| 灯塔这件事到底怎么样了 | CEO | 4.0 s · 18 · 54 · 6725 B · 0/4 | 0.6 s · 9 · 2 · 4079 B · 1/1 | E&O 单元、Finance 10 月目标（灯塔成本核算）、灯塔成本核算 Mission | Finance 10 月目标；灯塔成本核算 Mission 在下一页 |
| 企业经营 Context 建模与数据供给这个 Mission 进展如何 | CEO | 3.4 s · 18 · 54 · 4360 B · 0/2 | 0.4 s · 9 · 1 · 5384 B · 2/2 | 该 Mission（无进展）、E&O 单元 | 该 Mission，含 11/05 快照（未确认） |
| 我们公司的战略是什么 | CEO | 3.0 s · 18 · 54 · 5010 B · 0/2 | 0.3 s · 9 · 1 · 5128 B · 2/2 | 总体战略 | 总体战略 |
| TokenHub 本月目标是什么 | CEO | 3.1 s · 18 · 54 · 5339 B · 0/4 | 0.5 s · 17 · 1 · 3154 B · 1/1 | TokenHub 六个月目标、两个 Agents 的 Mission、TokenHub 10 月目标 | TokenHub 10 月目标（11 月没有周期目标，周期筛空后退回） |
| 会议内容写进本体这个 Task 现在怎么样 | 成员 | 1.4 s · 6 · 23 · 6307 B · 0/4 | 0.2 s · 3 · 1 · 617 B · 1/1 | 三个 Mission、该 Task | 该 Task |
| CEO / DRI Agent 从能用到在用 进展到哪了 | 成员 | 1.7 s · 6 · 23 · 4803 B · 0/4 | 0.2 s · 3 · 1 · 3767 B · 1/1 | 该 Mission、另一个 Mission、Agents 长期目标和 10 月目标 | 该 Mission |
| 最近有什么需要我拍板的风险 | CEO | 3.0 s · 18 · 54 · 3492 B · 0/1 | 2.7 s · 18 · 54 · 5358 B · 2/2 | 一个 Talent Mission | 走退路（全量读）：Talent 单元、公司长期目标 |

CEO 目标快照（不含健康检查和版本号）：改前 0.23 s、列表 5 次、读 2 个、`read_ontology` 结果 4.6 KB；改后 0.31 s、列表 9 次、读 2 个、9.7 KB（多了 Mission、Task 清单）。

读法：

- 定位到的问题从 3–4 秒、读 54 个对象降到 0.2–0.6 秒、读 1–2 个，噪声对象没有了，每条都带 ref。
- 定位不到的那条和改前同样慢、同样泛，这是退路；要它变好得靠下面的语义检索或事件读取。
- 每页上限还是 7000 字节、每个对象按 4000 字节切块，一页通常只放得下 1–2 个对象；「灯塔」那条第二个对象要翻页。

单元测试：`test/sourceCitations.test.ts`（出处规则里有 `cite:world:<ref>`）、`test/company.test.ts`（带 ref、定位只读命中的对象、按周期筛和筛空退回、定位不到走全量读、后台不定位、进展快照的格式和位置、对话工具确实打开定位）、`test/worldReader.test.ts`（快照里的 Mission/Task 清单、请求顺序、`part=missions`）。

## 还差什么

**要斯一给的读接口**（提案第三节）：

1. 按对象 id 批量取「定义 + 正式状态」，带负责人和往上的挂接链。现在一个对象一次 GET，正文 30 KB 上下，挂接要另外读。
2. 按对象和时间窗取事件（会议事件、日进展、决定），带事件 id、时间、作者、原文片段。`GET /v1/world/objects/{id}/events?since=` 已经能用（一个 Mission 近两周 37 条、66 KB），但没有作者和原文片段的精简形状，也不能按类别筛，所以这次没接进对话；「最近怎么样、为什么」还答不好。
3. 按人取他负责的对象。现在对象头里没有负责人，问「某某负责的 Mission」只能走全量读。
4. 在授权域里按关键词或语义找对象，替代标题打分和全量读的退路。
5. 读不落记录，或者给读取记录另定口径；在这之前继续不用 `POST /context`。

**天枢这边还没做的**：

- 前端引用卡：`parseSourceRef`（`apps/web/src/cards/meetingSources.ts`）还不认 `world:`，点开只看到名称；「本体事件」那类也还没有。要加两种 kind 和对应的打开方式（提案第二节）。
- 真实 scope 的责任单元没挂 `battlefield:` 外部引用，CEO 目标快照的 `units`（长期目标、本期目标）是空的；`read_ontology` 只在实例配置 `reads: true`（tk、demo、formal）时注册，主实例 `mvp` 默认不开。这两件要确认生产到底用哪个实例、单元按什么对上（战场还是能力域）。
- Mission → 周期目标、Task → Mission 的挂接只在读了对象正文后才有；快照里的清单是平的。

## 搬进晨星新服务时怎么搬

取用逻辑现在分在两处：天枢 `company.ts`（定位、投影、分页）和 Chat 服务 `reference.ts`（R 句柄、列表、读对象）。提案倾向放进晨星的新服务做成共用工具（做法 A）。搬的时候：

- **可以原样搬的**：`locateHints`、`locateHeads`（纯函数，只依赖对象头）；`recordLines` 和 `project` 的投影规则（StateSnapshot → 一行快照来源 + 块正文、关系只展开到授权范围）；ref 的写法 `id@version`。
- **留在天枢的**：按人授权的域（`COMPANY_WORLD_ACCESS_FILE`）是天枢的访问控制，新服务要么拿到同一份授权，要么由天枢出内部接口按人返回可读域。天枢自己的业务数据（交付、约定、执行事项）照提案由天枢出内部接口。
- **等斯一的接口到了再换的**：批量定义 + 状态替代逐个 GET；事件接口接上「近期动态」切片；语义检索替代标题打分和全量读退路。
- **对外的形状**先按这里定：每条事实 `{ ref, type, title, text }`，进展带快照 ref、日期、作者、是否未确认。Chat 那边要跟着改的见下一节。

## Chat 服务要跟着改的

已核对 `Chat_Service-lab`（feat/buddy-persona，与 origin/main 的取用部分相同）：

- **兼容性**：Chat 调天枢 `/internal/*` 用的 `JsonHttp` 只做 JSON 解析，不做 TypeBox 校验；各处用 `record()` 宽松取字段，多出来的字段不会整轮拒收。这次没有改任何 `/internal/*` 的返回，Chat 不用动也不会坏。
- **要答案带出处，Chat 自己要改**：
  1. 出处写法：`TIANSHU_SOURCE_RULE` 现在要求内部依据写 `[资料名称](cite:source)`、「不写内部编号或句柄」，所以本体对象的 id 不会出现在答案或引用里。要标到具体对象，改成和天枢 CEO 对话同一种写法 `cite:world:<object_id>@<version>`（天枢前端现在按「只有名称」显示，不会坏）；事件建议 `cite:world-event:<event_id>`，和天枢前端一起定。
  2. `read_world_object` 已经读到 `object_id` 和版本（R 句柄背后），交给模型的材料里显式带上 `ref` 字段，模型才能照抄；现在给模型的是 R 句柄。
  3. 进展：Chat 的 `evidence-content.ts` 已经按 StateSnapshot 取 `latest_state`（带快照版本、事实截至、记录者、未确认说明），这一块天枢是这次才补上的，Chat 不用改。
  4. 先筛再读：`list_world_objects` 已支持类型、周期、责任单元，Chat 的模型自己会定位；不用照搬天枢的标题打分，等晨星的共用工具定下来再统一。
