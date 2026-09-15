# Deep Research Harness 差距审计

对照基准：`deep-research-harness-spec.md` v1.0（2026-08-25）。
审计日期：2026-08-25。审计对象：`clark-main`（正式版产品）与同级仓库 `tkos-lab`（实验台）。

---

## 0. 先说结论

spec 假设被审计的是**一套**系统。实际是两套，而且**用户按下升级战略议题时跑的那一套，几乎不满足 spec 的任何一条 P0**。

| | 正式版深研（`clark-main`） | 实验台 A4 v5（`tkos-lab`） |
|---|---|---|
| 入口 | 议题升级为战略议题 → `ensureDeepResearch` 自动起 | 只能在实验台里手动起 run，**产品触发器到不了这里** |
| 检索 | 无。prompt 里写明「这一次没有联网」，外部事实来自模型已有知识 | 有：search → fetch → 快照 → 账本，三段分开 |
| 证据层 | 无 | 有：账本 7 项必填 + 引句定位 + 独立性折叠 |
| 计算 | 无 | 无 |
| 出口闸 | 有（确定性规则 + ≤2 轮重修），但闸的是**文体与结构**，不是事实 | 有（引文对账 + 终态如实 + L2 审计） |
| 交付 | 四节纯文本 + 溯源码 | 报告 JSON + 审计块 |

也就是说：spec 里的可信度地基，实验台已经建了大半，正式版一条都没接上。**当前最大的一笔账不是"缺功能"，是"缺接线"**——`clark-main` 目前只为信号扫描（`catching` 频道）调实验台，深研这条没调。

两条独立结论：

1. 正式版的深研**是诚实的**：它把"未联网核验"写进强制校验（`validate.ts` 的 A4-R07），不假装有证据。所以它不是 spec §9.2 里的报告B，它是"没有证据环节的写作链"。风险不是编数，是**结论只有模型记忆撑着**。
2. 实验台有几处比 spec 更细，补 spec 时别覆盖掉：`coverage_requirement` 的质量义务集（档次/时效/反证行为，全部可确定性计算）、担责域名表（判"有没有人为这句话署名"而不是判来源档次）、`export_mode` 的出境收敛。

---

## 1. 差距表（按 spec §11 优先级排序）

状态取值同 spec §0。两栏分别是正式版与实验台；`[代码强制]` 的需求只写在 prompt 里一律记 `partial`。

### P0 — 可信度地基

| req_id | 正式版 | 实验台 | location | risk | action |
|---|---|---|---|---|---|
| HP-1 Search≠Evidence | missing（无检索也无证据） | **present** | `evidence/search.py:332` 只回候选；`archive.py:70` 抓全文；`ledger.py:34` 拒绝没抓过的 URL | 正式版结论无来源可查 | 接线（见 §2.1） |
| HP-2 Ledger 拥有事实 | **divergent** | present | `clark-main/src/lib/agent/a4/prompt.ts` 头部；`checks/machine.py:743` 的 `quote_l1` | GOLD-06 类：正文数字来自模型旧记忆且无从对账 | 接线 |
| HP-3 计算走沙箱 | missing | missing | — | GOLD-03/04：加总超界、数量级矛盾无人能拦 | 新建（两边都零） |
| HP-4 Writer≠Verifier | partial | partial | `a4/run.ts:246`（反证复核用同一档模型、代码注释已声明不是交叉验证）；`pipeline.py:767` 审计是独立调用但同一家模型 | 同模型相关性错误互相看不见 | 接第二家 provider |
| HP-5 查不到是合法结果 | **present** | **present** | `a4/validate.ts` A4-R07/A4-13；`requirement.py:37` 终态词表 + `s8_prescreen` 的 `unverified_disclosure` | — | 保留 |
| HP-6 校验者不改文 | present | present | `a4/run.ts:210` 重修由代码驱动；`pipeline.py:791` 审计只出违规清单 | — | 保留 |
| HP-7 供应商不泄漏 | n/a | present | `evidence/search.py:284` REGISTRY | — | 保留 |
| DM-3 Evidence Object | missing | **partial** | `evidence/ledger.py:26` | 缺 `precision/period/geography/used_as` 即口径检查没有物质基础（GOLD-01 的直接原因） | 改造：补字段 |
| DM-3a Source Tier | missing | **divergent** | `a4_deep/coverage.py:128`、`requirement.py:31` | 用担责域名表 + `authority_class`，没有 A/B/C/D 与"A 与 C 冲突取 A 且须解释"的规则 | 加映射层，不推翻域名表 |
| ST-4a Source Snapshot | missing | **present** | `evidence/archive.py:70`（sha256 + `fetched_at` + blob 重放） | — | 接线时把快照路径带到产品侧 |
| ST-5a 入库蕴含门 | missing | **partial** | `pipeline.py:565` 蕴含预筛在覆盖判定之后；`ledger.py:34` 入账只做引句定位 | 抽取错误带着高权威标签污染下游一整段 | 门前移 + A 级双抽取 |
| ST-5b 独立性折叠 | missing | **present** | `evidence/independence.py:60`（出处归因 > simhash64 汉明≤6 > 域名兜底） | — | 保留 |

### P1 — 核心循环

| req_id | 正式版 | 实验台 | location | risk | action |
|---|---|---|---|---|---|
| ST-6 Coverage | missing | **present** | `requirement.py:163` `judge()` 全确定性 | — | 保留 |
| ST-6 Freshness | missing | partial | `requirement.py:118` 有时效义务窗口 | 没有 `used_as` 区分现状/历史点 → GOLD-02 只能抓到一半 | 随 DM-3 一起 |
| ST-6 Authority | missing | partial | `coverage.py:128`、`requirement.py:144` | 没有"核心结论只有 C/D 级支撑"这一判定 | 随 DM-3a |
| ST-6 Definition | missing | **missing** | — | GOLD-01 口径混用无人检出 | 新建 |
| ST-6 Consistency | missing | **missing** | — | 独立源数值冲突只数组数、不比值 | 新建 |
| ST-6 Arithmetic-Scale | missing | **missing** | — | GOLD-03/04 | 依赖沙箱 |
| DM-4 结构化 issue | missing | partial | `requirement.py:219` 只有 `gap` 字符串 + 一轮有界重试 | 缺口无法带着 `required_evidence/followup_queries` 回到检索 | 新建 schema |
| XC-1 预算与停止 | partial | partial | `agent/harness.ts` DEPTH 表（A4 用不到 `searchK`）；`pipeline.py` `MAX_STEPS=120`、`extra_rounds_cap`、`stop_reason` | 缺 `max_queries/max_sources/max_pdf_pages/max_modeling_runs` 全局项 | 补齐全局预算 |
| VF-A Citation Entailment | missing | **present** | `pipeline.py:565` + `machine.py:743` `quote_l1` | — | 保留 |
| VF-B Numeric | missing | **missing** | — | Writer 私算无人复算 | 依赖沙箱 |
| VF-C Definition | missing | **missing** | — | 全文口径中途漂移 | 新建 |
| VF-D Coverage | partial | **present** | `a4/validate.ts`（未溯源证据 p0）；`machine.py:545` | — | 保留 |
| VF-E Live Recheck | missing | **missing** | — | 分不清"写错了"与"世界变了"（快照已有，只差比对） | 新建，成本低 |
| 处置协议（§5 尾） | partial | partial | `a4/run.ts:210`；`pipeline.py:847` | 只有一档 repair，没有 minor/major/critical 三路 | 改造 |
| EV-MUT 变异测试 | missing | **missing** | — | Critic 检出率无从量化 | 新建（不依赖管道，最先做） |
| GOLD-01…06 回归 | missing | **missing** | — | 验收里程碑无从判定 | 新建 |
| EV 指标 | missing | partial | `checks/machine.py` 记分卡 + 人工评分 | 没有 Known Error Recall / Unsupported Claim Rate 两个北极星 | 改造 |
| EV-GUARD Goodhart | missing | missing | — | 迭代压力会把系统推成防御性文档 | 写入评测章程 |

### P2 — 判断质量

| req_id | 正式版 | 实验台 | location | risk | action |
|---|---|---|---|---|---|
| ST-1 Framing 四件套 | missing | partial | `pipeline.py:115` 命题编译（可证伪要求写在 `prompts/cognitive/a4.propositions.md`） | 缺术语口径表与每条假设的证伪条件（`[代码强制]`意义上只有 prompt） | 改造 |
| ST-2 evidence_requirements | missing | **present** | `a4_deep/requirement.py:85` | Source Plan（谁最有资格回答）仍缺 | 补 Source Plan |
| ST-3 Discovery | missing | partial | `evidence/search.py` 单 provider、无 reranker | 单源召回偏差；无一手源加分 | 改造 |
| ST-4 Acquisition | missing | partial | `archive.py:70` 只有静态 HTML | 政府 PDF、动态页取不到；无页码/位置 | 新建 |
| ST-7 Analysis 三层 | partial | partial | `a4/run.ts` 只有写作；`pipeline.py:686` | 定量层完全缺席，敏感性结论产不出来 | 依赖沙箱 |
| CH-1 fresh context | present | **present** | `a4/run.ts:246`；`pipeline.py:610`（红队走独立检索命名空间） | — | 保留 |
| CH-2 攻击清单 | partial | partial | `a4/prompt.ts` `A4_CHALLENGE_SYSTEM`；`_RT_WORDS` | 八项攻击面只覆盖到"局限/失败案例"一类 | 改造 prompt |
| CH-3 异构模型 | **divergent**（同一 `pro` 档） | divergent | `a4/run.ts:246` | 同模型盲区一致 | 接第二家 |
| CH-4 未解决的挑战必须出现 | partial | **present** | `machine.py:743` `contradicts` 闸 | 正式版只追加反证条目，不检查是否被应答 | 接线 |

### P3 — 产品与工程

| req_id | 正式版 | 实验台 | location | risk | action |
|---|---|---|---|---|---|
| ST-1a Brief 可见 | missing | missing | — | 用户看不到"在研究什么"，无法调框架 | 新建（前端） |
| XC-2 Progress UX | partial | partial | `agent/harness.ts` 步/子步 + 耗时 | 缺四段 checkpoint 文案模板 | 改造 |
| XC-3 延迟预算 | n/a | **divergent** | `pipeline.py:187` S4b 是模型驱动的串行工具循环 | 按源并行取不到；但串行换来了工具调用可审计 | 保留现状，接线后再测总时长 |
| XC-4 爬取合规 | n/a | **present** | `archive.py:70` 白名单即合规名单 | — | 保留 |
| XC-5 出境边界 | n/a | **present** | `requirement.py:40` `export_mode` 收敛 | — | 保留（比 spec 更细） |
| ST-8 Report AST | partial | partial | `a4/run.ts:192` 压成四节文本；`pipeline.py:686` 章节 JSON | 无 `claim_type` F/D/I/E、无 `calc_id` 反查 | 改造 |
| ST-10 Renderer | missing | missing | — | 无 HTML/PDF/DOCX 交付物 | 新建 |
| DM-7 事件与成本遥测 | partial | partial | `agent/harness.ts` 每次调用记 usage；`agents/base.py:191` `cost_usd` | 没有按 job/stage 的事件表与十类事件，降本决策无数据 | 改造（便宜，早做） |

---

## 2. 缺口与工作量

单位：人日（一名工程师 + Claude Code）。不含产品评审与文案。

### 2.1 接线：把实验台的 A4 v5 接到产品的深研触发器 —— **5–8 人日**

这是唯一一件能把 P0 从"几乎全无"变成"大半有"的事，也是投入产出比最高的一笔。

- 实验台侧开一个深研频道的 run 接口（`catching` 的 `createRun/advance` 模式可照抄）：1–2
- `clark-main` 侧 `ensureDeepResearch` 改道，推进循环复用 `src/lib/scan/run.ts` 那套（含 20 分钟上限与重放）：2–3
- 进度事件映射到现有四步进度条（实验台是 11 步，要折）：1
- 报告投影：账本条目 → 现有溯源码体系；`unverified` 一节上屏：1–2

### 2.2 可信度地基补齐 —— **15–25 人日**

| 项 | 人日 | 说明 |
|---|---|---|
| DM-3 字段补全 + 账本迁移 + 抽取 prompt 与检查跟着用上 | 3–5 | 字段本身半天，用起来才是成本 |
| DM-3a A/B/C/D 档 + 冲突取 A 且须解释 | 1.5–2.5 | 在担责域名表之上加一层，不推翻 |
| ST-5a 门前移 + A 级关键数字双抽取 | 1–1.5 | 蕴含检查已有，改位置 + 加一次抽取 |
| HP-3 / DM-5 Python 沙箱 + calculation 记录 + 衍生数字绑 `calc_id` | 5–8 | 隔离 runner 2、模型输出模型定义 JSON 的协议 2、Writer 绑定与出口闸 2 |
| EV-MUT 合成账本 + 六类变异算子 | 3–4 | **不依赖管道，第一天就能跑**，spec §9.1 说得对 |
| DM-7 events 表 + 十类事件 + 成本三字段 | 2–3 | 晚加要重构，趁接线一起挂 |

### 2.3 核心循环与五检查器 —— **20–28 人日**

| 项 | 人日 |
|---|---|
| ST-6 Definition 检查（口径漂移） | 2–3 |
| ST-6 Consistency（独立源数值冲突） | 2 |
| ST-6 Arithmetic-Scale（依赖沙箱） | 1–2 |
| DM-4 结构化 issue + followup 回到检索 | 3–4 |
| VF-B 数字复算（依赖沙箱） | 2 |
| VF-C 口径一致性 | 2 |
| VF-E 快照 vs 实时归因 | 2–3 |
| 处置协议 severity 三路路由 | 2 |
| GOLD-01…06 端到端回归 + 验收（自主检出 ≥5） | 3–5 |
| 指标口径（Known Error Recall / Unsupported Claim Rate）+ EV-GUARD 章程 | 2–3 |

### 2.4 检索与解析补齐 —— **10–15 人日**

| 项 | 人日 |
|---|---|
| 第二家搜索 provider + reranker + 一手源加分 | 3–4 |
| Playwright 动态页（需大陆机器） | 3–4 |
| PDF：TextIn 主 / MinerU 兜底，保留页码与位置 | 4–6 |
| 异构模型（第二家 provider）+ 角色路由，服务 HP-4/CH-3 | 2–3（与上表并行） |

### 2.5 产品与交付 —— **12–18 人日**

| 项 | 人日 |
|---|---|
| ST-1 Framing 四件套（含证伪条件落到代码） | 3–4 |
| ST-1a Research Brief 可见 + 「按此研究 / 调整框架」 | 2–3 |
| XC-2 四段 checkpoint 文案 + 事件驱动 | 1–2 |
| DM-6 Report AST（含 F/D/I/E 与 calc_id 反查） | 3–4 |
| ST-10 渲染 HTML（Jinja + ECharts），PDF/DOCX 次之 | 3–5 |
| ST-7 场景与敏感性矩阵 | 3–4 |

### 合计

- 全 spec V1：**约 65–95 人日**（3–4.5 人月）。
- 最小可信版（2.1 + 2.2）：**约 20–33 人日**。跑完这一档，正式版的深研就从"未联网写作"变成"有账本、有引文对账、有出口闸、有变异测试守着"。

---

## 3. 建议顺序

spec §10 的 BO 顺序基本可照用，但要按现状改三处：

1. **BO-2 提前到第一位**（合成账本 + 变异测试）。它不依赖管道，而且是唯一能量化"Critic 到底检出多少"的东西。现在两边都零。
2. **接线（§2.1）插在 BO-5 的位置上**。BO-5 说的最小垂直切片，实验台已经有了，不必重写——要做的是让产品触发器能到达它。
3. **BO-1（DM-3 字段）与接线并行**。字段不补，后面的 Definition/Freshness/Arithmetic 三项检查全都缺物质基础。

沙箱（HP-3）是唯一一个"两边都零、且下游四条需求全等它"的节点（ST-6 Arithmetic、ST-7 定量层、VF-B、DM-5）。它不在最小可信版里，但排第二档时应排在该档首位。
