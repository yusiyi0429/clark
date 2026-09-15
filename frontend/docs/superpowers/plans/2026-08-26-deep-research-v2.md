# 深研 v2（知识先行 + 覆盖门控）实施计划

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把 A4 深研从「检索先行 + 四模型各跑全流程」倒置成「主体锚定 → 先验草稿 → 命题抽取 → 分维度取证 → 四态对账 → 分层成稿 → 出口机检」，让维度覆盖由结构强制而不靠模型自觉。

**Architecture:** 新链路是 `a4/` 下七个各管一节点的小文件 + 一个编排文件 `pipeline.ts`，走 `TKOS_DR_V2=1` 开关，与现有 `run.ts` 的四链路并存到最后一个任务才翻默认。检索、抓取、台账、独立性折叠、覆盖判定、区块形状、出口对账这六层**一层都不重写**（`src/lib/research/*`、`a4/blocks/*`、`a4/gate.ts` 原样复用）；v2 改的只有「谁在什么时候调它们」以及三样新东西：维度框架（`dims.ts`）、四态标签（`draft.ts`）、七项出口机检（`audit.ts`）。

**Tech Stack:** TypeScript / Next.js（本仓库那一版，破坏性改动见 `AGENTS.md`）、vitest、`Harness`（`src/lib/agent/harness.ts`）、博查 + 豆包搜索（`src/lib/research/search.ts`，本计划不改它）。

## Global Constraints

- **参数化知识完全放开。** N1 禁止出现「无 E 编号即不能写」这类要求；缺证据只降标签（`[P]` → `[P!]`），永不删内容。这是本次改造最贵的那个修复点，任何任务不得把它改回去。
- **每个有产出的任务收口时同时改两处**：`src/lib/changelog.ts` 数组最前面加一条，`package.json` 的 `version` 跟它一致（当前 `0.47.0`；行为变了走 minor，修对上一版走 patch）。`changelog.test.ts` 盯着这一致性。
- **不造新词。** 文档、提示词、屏幕文案一律用产品已有词汇（命题、取证、台账、共源、出口对账、判断板）。新概念用描述性短语，不起名。
- **对模型的字段名一律 camelCase**，块的 `type` 值保持下划线（`draft_section`、`verdict_banner`）—— 沿用 `blocks/schema.ts` 头部那条约定。
- **检索源固定为博查 + 豆包**（`TKOS_SEARCH_PROVIDER=bocha,doubao`）。`src/lib/research/search.ts` 一个字不改。
- **长中文正文不许塞进 JSON 字符串字段**：模型交的每一份长文都走 JSONL（一行一个对象），理由在 `blocks/schema.ts` 头部「为什么是 JSONL」。
- **查不到是合法结果（HP-5）**：没配 key、搜不到、抓不回来都不许让整轮深研失败，一律落记录往下走。
- 注释照现有文件的密度和口吻写：说清**为什么**这么定，而不是复述代码在干什么。
- **既有类型一个都不改。** 这一版只加一栏 `ReportBlocks.appendixFrom`（可选）。特别是：
  `A4Input`（`prompt.ts:43`）只有 `issueId / title / scope / preTake / preOpenQuestions / docs /
  judgments` 七栏，**没有 `question`**；`Slot` 是 `pro | flash | alt | synth | seed`；整轮用时在
  `AgentRunRecord.latencyMs`；`ResearchDoc.sourceText` 和 `.blocks` 都是可选。写代码前对着这四条
  核一遍，别按印象编字段名。
- 跑测试：`pnpm vitest run <文件路径>`。全量：`pnpm vitest run`。

---

## 文件结构

| 文件 | 责任 | 新建/改 |
|---|---|---|
| `src/lib/agent/a4/dims.ts` | 八维度框架、单维度检索预算上限、覆盖门控判定 | 新建 |
| `src/lib/agent/a4/anchor.ts` | N0 主体卡：类型、提示词、编译、「重项目必须进行业定义」机检 | 新建 |
| `src/lib/agent/a4/draft.ts` | N1 先验草稿：四态标签、JSONL 解析、五项机检 | 新建 |
| `src/lib/agent/a4/plan.ts` | N2 命题抽取与检索规划：提示词、编译成带维度的命题、四项机检 | 新建 |
| `src/lib/agent/a4/cosource.ts` | 波内共源率与改写触发判定（纯函数）+ 改写提示词 | 新建 |
| `src/lib/agent/a4/sweep.ts` | N3 分维度取证编排：分链、波内改写、覆盖门控收口 | 新建 |
| `src/lib/agent/a4/reconcile.ts` | N4 四态对账：提示词、变更日志、三项机检 | 新建 |
| `src/lib/agent/a4/layer.ts` | N5 分层成稿：正文/附录切分、四项正文禁令机检 | 新建 |
| `src/lib/agent/a4/anchor-gate.ts` | §2.4 内部锚点相关性检查（用在 N6） | 新建 |
| `src/lib/agent/a4/audit.ts` | N6 七项出口对账 + 打回节点映射 | 新建 |
| `src/lib/agent/a4/pipeline.ts` | N0→N6 编排、进度上报、`A4Result` 兼容 | 新建 |
| `src/lib/agent/a4/blocks/schema.ts` | `ReportBlocks` 加 `appendixFrom` | 改 |
| `src/lib/agent/a4/run.ts` | 末任务：`TKOS_DR_V2` 默认打开，四链路那一支退居开关后 | 改 |

七个节点各一个文件而不是一个大文件：`run.ts` 已经 1668 行，出口对账那一段每次要读完整份才敢改。节点边界正好是**可以单独重跑**的边界（N6 打回哪个节点，就只重跑那一个）。

---

### Task 1: 维度框架与覆盖门控（dims.ts）

**Files:**
- Create: `src/lib/agent/a4/dims.ts`
- Test: `src/lib/agent/a4/dims.test.ts`

**Interfaces:**
- Consumes: 无（这是最底下那一层）
- Produces: `DimId`、`DIMENSIONS`、`DIM_IDS`、`isDimId(v): v is DimId`、`DIM_SHARE_CAP`、`overBudget(byDim, cap?)`、`DimCoverage`、`MIN_TRIED_FOR_NOT_FOUND`、`gateOpen(rows, strongDims)`

- [ ] **Step 1: 写会失败的测试**

```ts
// src/lib/agent/a4/dims.test.ts
import { describe, expect, it } from "vitest";
import { DIM_IDS, DIMENSIONS, gateOpen, isDimId, overBudget } from "./dims";

describe("维度框架", () => {
  it("八个维度，编号不重复，每个都有一句说明", () => {
    expect(DIMENSIONS).toHaveLength(8);
    expect(new Set(DIM_IDS).size).toBe(8);
    for (const d of DIMENSIONS) expect(d.brief.length).toBeGreaterThan(4);
  });

  it("认得出维度编号", () => {
    expect(isDimId("D3")).toBe(true);
    expect(isDimId("D9")).toBe(false);
    expect(isDimId(3)).toBe(false);
  });
});

describe("单维度检索预算", () => {
  it("占比超过三成的维度报出来，按占比从大到小", () => {
    const over = overBudget({ D1: 10, D2: 1, D3: 1, D4: 8 });
    expect(over.map((x) => x.dim)).toEqual(["D1", "D4"]);
    expect(over[0].share).toBeCloseTo(0.5);
  });

  it("平均分配时一个都不报", () => {
    expect(overBudget({ D1: 2, D2: 2, D3: 2, D4: 2 })).toEqual([]);
  });

  it("一条检索式都没有时不报（那是别的门要拦的事）", () => {
    expect(overBudget({})).toEqual([]);
  });
});

describe("覆盖门控", () => {
  const full = DIM_IDS.map((dim) => ({ dim, independentGroups: 1 }));

  it("每个维度都有一组独立来源就开门", () => {
    expect(gateOpen(full, []).ok).toBe(true);
  });

  it("强判断所在维度要两组，一组不够", () => {
    const r = gateOpen(full, ["D4"]);
    expect(r.ok).toBe(false);
    expect(r.missing.join("")).toContain("D4");
    expect(r.missing.join("")).toContain("2 组");
  });

  it("已搜未得也算过门，但试过的问法要够四条", () => {
    const rows = full.map((r) =>
      r.dim === "D6" ? { dim: r.dim, independentGroups: 0, notFound: { tried: ["a", "b", "c", "d"] } } : r
    );
    expect(gateOpen(rows, []).ok).toBe(true);

    const thin = full.map((r) =>
      r.dim === "D6" ? { dim: r.dim, independentGroups: 0, notFound: { tried: ["a", "b"] } } : r
    );
    expect(gateOpen(thin, []).ok).toBe(false);
    expect(gateOpen(thin, []).missing.join("")).toContain("4 条");
  });

  it("整个维度没上表和有表但空着，报的是两句不同的话", () => {
    const absent = gateOpen(full.filter((r) => r.dim !== "D7"), []);
    const empty = gateOpen(full.map((r) => (r.dim === "D7" ? { ...r, independentGroups: 0 } : r)), []);
    expect(absent.missing.join("")).not.toBe(empty.missing.join(""));
  });
});
```

- [ ] **Step 2: 跑一遍确认它失败**

Run: `pnpm vitest run src/lib/agent/a4/dims.test.ts`
Expected: FAIL — `Failed to resolve import "./dims"`

- [ ] **Step 3: 写实现**

```ts
// src/lib/agent/a4/dims.ts
/**
 * 八维度框架，以及「这一轮的检索预算有没有偏到一个维度上」「合成前每个维度够不够」
 * 这两道确定性的门。
 *
 * ## 为什么维度要写死在代码里
 *
 * 上一版的维度是模型自己想的，于是它想到哪算哪 —— 一次深研只覆盖了智能手机面板一个
 * 维度，而供给端扩产周期、技术路线之争、上游国产化压根没进过检索。缺失的维度不会
 * 报错，它静默消失：屏幕上那份报告看起来完整，只是「行业」被悄悄换成了「行业的一个
 * 角落」。写死之后，缺哪一维要么有独立来源，要么留一条「已搜未得」，两者必居其一。
 *
 * 行业宏观题固定用这八维；别的题型由 N1 自己生成维度（≥6 个），那时这张表只提供
 * 判定用的形状（`DimCoverage`），不提供内容。
 */

export type DimId = "D1" | "D2" | "D3" | "D4" | "D5" | "D6" | "D7" | "D8";

export type Dimension = { id: DimId; name: string; brief: string };

/** 行业宏观题的固定维度。顺序就是草稿里分节的顺序。 */
export const DIMENSIONS: readonly Dimension[] = [
  { id: "D1", name: "需求端", brief: "分应用、分场景，各自处在渗透期/成熟期/衰退期的哪一段" },
  { id: "D2", name: "供给端", brief: "产能周期、在建项目、扩产节奏、供需平衡预期" },
  { id: "D3", name: "技术路线", brief: "现有路线、挑战者路线、切换的经济学逻辑" },
  { id: "D4", name: "竞争格局", brief: "梯队划分、份额趋势、区域格局迁移" },
  { id: "D5", name: "上游与产业链", brief: "关键环节、瓶颈、国产化与垂直整合动向" },
  { id: "D6", name: "政策与外部环境", brief: "监管、产业政策、外部约束" },
  { id: "D7", name: "风险与周期位置", brief: "当前处在周期的哪一段、最大的下行风险是什么" },
  { id: "D8", name: "对主体的含义", brief: "主体的关键变量、未来两三年该盯的三到五个指标" },
] as const;

export const DIM_IDS: readonly DimId[] = DIMENSIONS.map((d) => d.id);

export const isDimId = (v: unknown): v is DimId =>
  typeof v === "string" && (DIM_IDS as readonly string[]).includes(v);

export const dimName = (id: DimId): string => DIMENSIONS.find((d) => d.id === id)?.name ?? id;

/**
 * 一个维度最多占这一轮检索式的几成。
 *
 * 这道门拦的是上一版真正的死法：早期查询撞上一个数据群，后续命题全围着它展开，越挖
 * 越深再也没跳出去 —— 26 条证据弃用 15 条，全是同几份统计的转载。**深度不是问题，
 * 预算被一个维度吃掉才是。**
 */
export const DIM_SHARE_CAP = 0.3;

/** 超预算的维度，按占比从大到小。总数为 0 时不报 —— 那是覆盖门控要拦的事，不是预算。 */
export function overBudget(
  byDim: Record<string, number>,
  cap = DIM_SHARE_CAP
): { dim: string; share: number }[] {
  const total = Object.values(byDim).reduce((n, x) => n + x, 0);
  if (total <= 0) return [];
  return Object.entries(byDim)
    .map(([dim, n]) => ({ dim, share: n / total }))
    .filter((x) => x.share > cap)
    .sort((a, b) => b.share - a.share);
}

/**
 * 一个维度这一轮的覆盖情况。
 *
 * `notFound` 有值 = 这个维度**搜过但没得到**，它将以 `[P]`/`[P!]` 标签成稿。这一栏不是
 * 免责声明，是账：不留它的话，「这一维搜了四轮一无所获」和「这一维压根没进过检索」
 * 在产出上长得一模一样。
 */
export type DimCoverage = {
  dim: DimId;
  /** 折叠后可计入印证的独立来源组数（`coverage.tally` 的 `citableGroups`）。 */
  independentGroups: number;
  notFound?: { tried: string[] };
};

/** 「已搜未得」至少要试过这么多条问法才算数。三条以内多半是同一个问法的微调。 */
export const MIN_TRIED_FOR_NOT_FOUND = 4;

/**
 * 合成前那道门。**每个维度要么有独立来源，要么有一条已搜未得的记录。**
 *
 * `strongDims` 是这一轮打算下「当前更支持」及以上判断的维度，它们要两组（§2.2）。
 * 门没开时不抛异常 —— 由调用方决定是再补一波还是按现状收口并记缺口。
 */
export function gateOpen(
  rows: readonly DimCoverage[],
  strongDims: Iterable<DimId>
): { ok: boolean; missing: string[] } {
  const strong = new Set(strongDims);
  const byDim = new Map(rows.map((r) => [r.dim, r] as const));
  const missing: string[] = [];
  for (const dim of DIM_IDS) {
    const row = byDim.get(dim);
    if (!row) {
      // 和「有表但空着」分两句：没上表说明这一维压根没进过检索计划，该退回 N2；
      // 空着说明搜过没搜着，该再改一次问法或落已搜未得。
      missing.push(`${dim} ${dimName(dim)}：整个维度没进过覆盖表 —— 检索计划里没有它`);
      continue;
    }
    const need = strong.has(dim) ? 2 : 1;
    if (row.independentGroups >= need) continue;
    const tried = row.notFound?.tried ?? [];
    if (tried.length >= MIN_TRIED_FOR_NOT_FOUND) continue;
    missing.push(
      row.notFound
        ? `${dim} ${dimName(dim)}：独立来源 ${row.independentGroups} 组（要 ${need} 组），已搜未得只记了 ${tried.length} 条问法，不足 ${MIN_TRIED_FOR_NOT_FOUND} 条`
        : `${dim} ${dimName(dim)}：独立来源 ${row.independentGroups} 组，要 ${need} 组；也没有已搜未得的记录`
    );
  }
  return { ok: missing.length === 0, missing };
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/agent/a4/dims.test.ts`
Expected: PASS（12 个断言块全绿）

- [ ] **Step 5: 记账并提交**

`src/lib/changelog.ts` 最前面加一条，`package.json` 版本改成 `0.48.0`：

```ts
  {
    version: "0.48.0",
    date: "2026-08-26",
    changes: [
      "深研这条链路开始按维度分工：八个维度写进了代码，哪一维没搜到东西不再静默消失 —— 要么有独立来源，要么留一条「已搜未得」的记录",
    ],
  },
```

```bash
git add src/lib/agent/a4/dims.ts src/lib/agent/a4/dims.test.ts src/lib/changelog.ts package.json && git commit -m "深研按维度分工：八维度框架，缺哪一维要留下记录"
```

---

### Task 2: N0 主体锚定（anchor.ts）

**Files:**
- Create: `src/lib/agent/a4/anchor.ts`
- Test: `src/lib/agent/a4/anchor.test.ts`

**Interfaces:**
- Consumes: `A4Input`（`./prompt`）
- Produces: `SubjectCard`、`ANCHOR_SYSTEM`、`buildAnchorUser(input)`、`compileCard(raw): SubjectCard`、`cardGaps(card): string[]`

- [ ] **Step 1: 写会失败的测试**

```ts
// src/lib/agent/a4/anchor.test.ts
import { describe, expect, it } from "vitest";
import { ANCHOR_SYSTEM, buildAnchorUser, cardGaps, compileCard } from "./anchor";

const raw = {
  subject: "维信诺",
  segments: [{ name: "柔性 AMOLED 手机面板", weight: "收入主体", lifecycle: "现金流" }],
  projects: [
    { name: "V5 第 8.6 代线", investment: "550 亿元", onlineAt: "2027", techRoute: "ViP 无掩膜光刻", heavy: true },
    { name: "车载模组扩产", investment: "8 亿元", onlineAt: "2026", techRoute: "现有", heavy: false },
  ],
  customers: "国产安卓品牌为主",
  industry: "柔性中小尺寸 AMOLED，正向 V5 第 8.6 代中尺寸扩张",
  window: "当前时点 ± 未来 3 年",
};

describe("主体卡编译", () => {
  it("照抄模型给的形状，缺的栏位落成空字符串而不是 undefined", () => {
    const card = compileCard({ subject: "某公司" });
    expect(card.subject).toBe("某公司");
    expect(card.industry).toBe("");
    expect(card.segments).toEqual([]);
    expect(card.projects).toEqual([]);
  });

  it("生命周期只认三档，写别的一律落到投入期", () => {
    const card = compileCard({ segments: [{ name: "x", weight: "y", lifecycle: "巅峰期" }] });
    expect(card.segments[0].lifecycle).toBe("投入期");
  });

  it("默认分析时间窗写死在代码里，模型不给就用它", () => {
    expect(compileCard({}).window).toContain("3 年");
  });
});

describe("主体卡的缺口", () => {
  it("填满了就没有缺口", () => {
    expect(cardGaps(compileCard(raw))).toEqual([]);
  });

  it("重项目没进行业定义要报出来", () => {
    const bad = { ...raw, industry: "柔性中小尺寸 AMOLED" };
    const gaps = cardGaps(compileCard(bad));
    expect(gaps.join("")).toContain("V5 第 8.6 代线");
  });

  it("非重项目不进行业定义不算缺口", () => {
    const gaps = cardGaps(compileCard(raw));
    expect(gaps.join("")).not.toContain("车载模组");
  });

  it("行业定义写成泛类目要报出来", () => {
    const gaps = cardGaps(compileCard({ ...raw, industry: "显示面板行业", projects: [] }));
    expect(gaps.join("")).toContain("泛类目");
  });

  it("一个业务板块都没有要报出来", () => {
    expect(cardGaps(compileCard({ ...raw, segments: [] })).join("")).toContain("业务构成");
  });
});

describe("提示词", () => {
  it("说明白这一步只许检索主体的一手材料", () => {
    expect(ANCHOR_SYSTEM).toContain("一手");
    expect(ANCHOR_SYSTEM).toContain("不做行业面检索");
  });

  it("把议题原话和预研结论递进去", () => {
    const user = buildAnchorUser({ title: "维信诺所处的行业", scope: "只看面板主业", preTake: "预研说产能周期是关键" });
    expect(user).toContain("维信诺所处的行业");
    expect(user).toContain("只看面板主业");
    expect(user).toContain("预研说产能周期是关键");
  });

  it("预研没跑过时不留空标题", () => {
    expect(buildAnchorUser({ title: "t", scope: null, preTake: null })).not.toContain("预研");
  });
});
```

- [ ] **Step 2: 跑一遍确认它失败**

Run: `pnpm vitest run src/lib/agent/a4/anchor.test.ts`
Expected: FAIL — `Failed to resolve import "./anchor"`

- [ ] **Step 3: 写实现**

```ts
// src/lib/agent/a4/anchor.ts
/**
 * N0 主体锚定。**这一步定的是「这次研究的行业边界在哪」，而且必须由主体自己的一手材料定。**
 *
 * 上一版没有这一步，后果是行业定义被检索结果反向定义了：搜到的碰巧是智能手机面板份额
 * 数据，于是「维信诺所处的行业」就变成了「AMOLED 智能手机面板」，而这家公司 550 亿的
 * 战略下注（第 8.6 代线、ViP 光刻）整篇一个字没出现 —— 落回主体那一节因此只能说出
 * 「份额 9.4%、同比 +8.9%」，答不出「这家公司未来靠什么」。
 *
 * 所以这里有一条硬账：**投资额权重过线的在建项目必须出现在行业定义里**（`cardGaps`）。
 * 它不是文风要求，是「N0 到 N5 这条链有没有断」唯一机检得出来的地方。
 *
 * ## 这是草稿前唯一允许的检索
 *
 * 只搜主体的年报、半年报、投资者关系材料、官网业务介绍、最近四个季度的重大公告。
 * 行业面的东西一条都不许在这里搜 —— 那些进来之后，命题就又被首波检索种下了。
 */

import type { A4Input } from "./prompt";

export const LIFECYCLES = ["现金流", "成长", "投入期"] as const;
export type Lifecycle = (typeof LIFECYCLES)[number];

export type SubjectCard = {
  subject: string;
  segments: { name: string; weight: string; lifecycle: Lifecycle }[];
  /** `heavy` = 投资额占市值或净资产两成以上。由模型读年报判断，代码只负责让它进行业定义。 */
  projects: { name: string; investment: string; onlineAt: string; techRoute: string; heavy: boolean }[];
  customers: string;
  /** 一句话，必须覆盖全部有战略权重的板块。 */
  industry: string;
  window: string;
};

/** 模型不给时用它。写死在代码里，不写在提示词里 —— 提示词里的默认值会被模型改。 */
const DEFAULT_WINDOW = "当前时点 ± 未来 3 年";

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const objs = (v: unknown): Record<string, unknown>[] =>
  (Array.isArray(v) ? v : []).filter((x): x is Record<string, unknown> => !!x && typeof x === "object");

const lifecycle = (v: unknown): Lifecycle =>
  (LIFECYCLES as readonly string[]).includes(s(v)) ? (s(v) as Lifecycle) : "投入期";

/** 模型交的那份 → 主体卡。缺的栏位落空字符串，**不落 undefined**：下游拼提示词要它。 */
export function compileCard(raw: unknown): SubjectCard {
  const o = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    subject: s(o.subject),
    segments: objs(o.segments)
      .map((x) => ({ name: s(x.name), weight: s(x.weight), lifecycle: lifecycle(x.lifecycle) }))
      .filter((x) => x.name),
    projects: objs(o.projects)
      .map((x) => ({
        name: s(x.name),
        investment: s(x.investment),
        onlineAt: s(x.onlineAt),
        techRoute: s(x.techRoute),
        heavy: x.heavy === true,
      }))
      .filter((x) => x.name),
    customers: s(o.customers),
    industry: s(o.industry),
    window: s(o.window) || DEFAULT_WINDOW,
  };
}

/**
 * 泛类目的下限。
 *
 * 由 footprint 导出的定义一定带方向（「正向高世代中尺寸扩张」），而「显示面板行业」
 * 这种五六个字的类目名不可能带。按长度判是粗的，但它拦得住那一类，而且**不会今天成立
 * 明天不成立** —— 换成关键词表的话，表上没有的泛类目照样过。
 */
const GENERIC_MAX = 11;

/** 名字和行业定义有没有共同的两字片段。中文没有词边界，两字够指认「V5」「8.6 代」这类。 */
const shares = (name: string, industry: string): boolean => {
  for (let i = 0; i + 2 <= name.length; i += 1) {
    if (industry.includes(name.slice(i, i + 2))) return true;
  }
  return false;
};

/** 主体卡的缺口。空数组 = 这张卡能往下走。一条一句人话，直接进 trace 和打回理由。 */
export function cardGaps(card: SubjectCard): string[] {
  const gaps: string[] = [];
  if (!card.industry) gaps.push("没有行业定义 —— 这一轮的分析边界没定下来");
  else if (card.industry.length <= GENERIC_MAX) {
    gaps.push(
      `行业定义「${card.industry}」像一个泛类目：它要由主体 footprint 导出，既写现有主业也写战略投入方向`
    );
  }
  if (!card.segments.length) gaps.push("业务构成是空的 —— 行业定义没有可导出的依据");
  for (const p of card.projects) {
    if (p.heavy && card.industry && !shares(p.name, card.industry)) {
      gaps.push(`在建项目「${p.name}」投资额过线却没进行业定义，这一轮的行业边界会漏掉它`);
    }
  }
  return gaps;
}

export const ANCHOR_SYSTEM = `你在给一次行业研究定边界。这一步的产物是一张主体卡。

## 这一步允许检索什么

只许检索**研究主体自己的一手材料**：最新年报与半年报、投资者关系材料、官网业务介绍、
最近四个季度的重大公告。**不做行业面检索** —— 行业里在发生什么由后面的节点去查，这一步
一旦搜进行业数据，行业边界就会被那几页碰巧讲的东西定死。

纯议题类研究（没有具体主体）不检索，直接给议题边界。

## 交什么

一行 JSON：

{"subject":"","segments":[{"name":"","weight":"收入或战略权重","lifecycle":"现金流|成长|投入期"}],
 "projects":[{"name":"","investment":"","onlineAt":"","techRoute":"","heavy":true}],
 "customers":"","industry":"","window":""}

## 两条硬要求

1. \`industry\` 是一句话，必须**同时**写出现有主业和战略投入方向。禁止写泛类目 ——
   「显示面板行业」这种等于没定边界，要写成「柔性中小尺寸 AMOLED，正向高世代中尺寸扩张」
   这种。
2. \`heavy\` 标的是「这个在建项目的投资额占公司市值或净资产两成以上」。标了 true 的项目，
   它的名字必须能在 \`industry\` 里找到 —— 一笔押上两成身家的下注不在行业定义里，这次研究
   就会绕开它。`;

/**
 * `A4Input`（`prompt.ts:43`）**没有 `question` 这一栏**：议题的补充说明在 `scope`，预研的
 * 结论在 `preTake`，两者都可能是 null。深研不许从头再来一遍（`preTake` 的注释），所以预研
 * 有结论时要递进去 —— 但**不许因此跳过一手材料检索**：预研那一轮不读年报。
 */
export function buildAnchorUser(input: Pick<A4Input, "title" | "scope" | "preTake">): string {
  return [
    "## 研究问题",
    input.title,
    input.scope?.trim() ? `\n范围：${input.scope.trim()}` : "",
    input.preTake?.trim() ? `\n预研已有的结论（接着往下，不重来）：${input.preTake.trim()}` : "",
    "\n先识别研究主体，再按上面的形状交那一行 JSON。",
  ]
    .filter(Boolean)
    .join("\n");
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/agent/a4/anchor.test.ts`
Expected: PASS

- [ ] **Step 5: 记账并提交**

changelog 加一条（版本 `0.48.1`）：`"深研第一步先看主体自己的一手材料：押上两成身家的在建项目必须写进行业定义，这一轮的研究边界不再由搜到的数据反过来定"`

```bash
git add src/lib/agent/a4/anchor.ts src/lib/agent/a4/anchor.test.ts src/lib/changelog.ts package.json && git commit -m "深研先锚主体：行业边界由年报导出，重项目必须进定义"
```

---

### Task 3: N1 先验草稿（draft.ts）

**Files:**
- Create: `src/lib/agent/a4/draft.ts`
- Test: `src/lib/agent/a4/draft.test.ts`

**Interfaces:**
- Consumes: `DimId`、`DIMENSIONS`、`isDimId`（`./dims`）；`SubjectCard`（`./anchor`）
- Produces: `Tag`、`Assertion`、`DraftSection`、`Draft`、`DRAFT_SYSTEM`、`buildDraftUser({card, title})`、`parseDraft(text): {draft: Draft; bad: {line: number; why: string}[]}`、`draftGaps(draft): string[]`

- [ ] **Step 1: 写会失败的测试**

```ts
// src/lib/agent/a4/draft.test.ts
import { describe, expect, it } from "vitest";
import { DIM_IDS } from "./dims";
import { DRAFT_SYSTEM, buildDraftUser, draftGaps, parseDraft } from "./draft";

const line = (o: unknown): string => JSON.stringify(o);

const section = (dim: string) =>
  line({
    type: "draft_section",
    dim,
    thesis: `${dim} 这一维的论点：这一段已经从量增转入存量`,
    body: "机制写在这里：固定成本结构决定了降载就亏，所以宁可先把货做出来。",
    assertions: [
      { text: "出货量约 9.2 亿片", tag: "P", confidence: "中", timeSensitive: true, loadBearing: true },
      { text: "固定成本占比高，降载即亏", tag: "P", confidence: "高", timeSensitive: false, loadBearing: false },
    ],
  });

const full = [
  line({ type: "draft_meta", thesis: "这个行业的总量红利已经用完，往后决定单个厂商处境的是份额重排" }),
  ...DIM_IDS.map(section),
  line({ type: "draft_unknowns", items: ["Q2 出货", "最新价格", "扩产进度", "政策文件", "分应用增速"] }),
].join("\n");

describe("草稿解析", () => {
  it("一行一节，坏掉的那一行只丢它自己", () => {
    const r = parseDraft(`${full}\n{坏行`);
    expect(r.draft.sections).toHaveLength(8);
    expect(r.bad).toHaveLength(1);
    expect(r.bad[0].line).toBe(11);
  });

  it("认不出的维度编号不收", () => {
    const r = parseDraft([line({ type: "draft_section", dim: "D9", thesis: "x", body: "y" })].join("\n"));
    expect(r.draft.sections).toHaveLength(0);
    expect(r.bad[0].why).toContain("D9");
  });

  it("标签只认四种，写别的落成 P", () => {
    const r = parseDraft(
      line({
        type: "draft_section",
        dim: "D1",
        thesis: "t",
        body: "b",
        assertions: [{ text: "x", tag: "已验证", confidence: "高" }],
      })
    );
    expect(r.draft.sections[0].assertions[0].tag).toBe("P");
  });

  it("代码围栏和空行不当坏行", () => {
    const r = parseDraft(["```jsonl", full, "```", ""].join("\n"));
    expect(r.bad).toHaveLength(0);
  });
});

describe("草稿的缺口", () => {
  it("八维齐、总判断是判断句、清单够五条 —— 没有缺口", () => {
    expect(draftGaps(parseDraft(full).draft)).toEqual([]);
  });

  it("少一个维度要报出来", () => {
    const short = full.split("\n").filter((l) => !l.includes('"D5"')).join("\n");
    expect(draftGaps(parseDraft(short).draft).join("")).toContain("D5");
  });

  it("总判断骑墙要报出来", () => {
    const hedged = full.replace(/"thesis":"这个行业[^"]*"/, '"thesis":"这个行业的前景有待观察，喜忧参半"');
    expect(draftGaps(parseDraft(hedged).draft).join("")).toContain("骑墙");
  });

  it("总判断超过 150 字要报出来", () => {
    const long = full.replace(/"thesis":"这个行业[^"]*"/, `"thesis":"${"这个行业已经进入存量。".repeat(20)}"`);
    expect(draftGaps(parseDraft(long).draft).join("")).toContain("150");
  });

  it("不知道清单不足五条要报出来", () => {
    const thin = full.replace(/"items":\[[^\]]*\]/, '"items":["只有一条"]');
    expect(draftGaps(parseDraft(thin).draft).join("")).toContain("5 条");
  });

  it("断言标注率不足九成要报出来", () => {
    const bare = full.replace(/"timeSensitive":true/g, '"timeSensitive":null');
    expect(draftGaps(parseDraft(bare).draft).join("")).toContain("标注");
  });

  it("某一维没有论点要报出来", () => {
    const noThesis = full.replace(/"thesis":"D4[^"]*"/, '"thesis":""');
    expect(draftGaps(parseDraft(noThesis).draft).join("")).toContain("D4");
  });
});

describe("提示词", () => {
  it("明写不检索、参数化知识放开、过期的数照写", () => {
    expect(DRAFT_SYSTEM).toContain("不检索");
    expect(DRAFT_SYSTEM).toContain("照写");
    expect(DRAFT_SYSTEM).not.toContain("证据编号");
  });

  it("把主体卡递进去", () => {
    const user = buildDraftUser({ title: "t", card: { subject: "维信诺", industry: "柔性 AMOLED" } as never });
    expect(user).toContain("维信诺");
    expect(user).toContain("柔性 AMOLED");
  });
});
```

- [ ] **Step 2: 跑一遍确认它失败**

Run: `pnpm vitest run src/lib/agent/a4/draft.test.ts`
Expected: FAIL — `Failed to resolve import "./draft"`

- [ ] **Step 3: 写实现**

```ts
// src/lib/agent/a4/draft.ts
/**
 * N1 先验草稿。**这一节点是整条链路的内容主体，而且它不检索。**
 *
 * 上一版最贵的那个错误在这里被撤销：那一版要求每句话绑一个证据编号，等于把模型九成的
 * 价值扔掉，只留一个检索转述器 —— 于是 2 条证据撑不起结论时，它「正确地」输出了
 * 「不足以判断」。行业分析的骨架（固定成本结构、良率经营杠杆、世代线切割经济性、产能
 * 迁移史）**全部来自模型先验**，检索只是往骨架上补新数。
 *
 * 所以这里的规矩反过来了：先凭知识写完整、写出立场、全断言标 `[P]`；后面的证据只能
 * **更新**或**证伪**它，缺证据不构成删除理由，只构成标签降级理由（`[P]` → `[P!]`）。
 *
 * ## 为什么一行一节
 *
 * 一整份草稿塞进一个 JSON 字符串字段，两千多字中文转义一次，任何一处裸引号让整份 parse
 * 不出来（同 `blocks/schema.ts` 头部那一段）。一行一节之后坏掉的是**那一维**，别的七维
 * 照样读得出来，而缺的那一维会被 `draftGaps` 指名报出来。
 */

import { DIM_IDS, isDimId, type DimId } from "./dims";
import type { SubjectCard } from "./anchor";

/**
 * 四态标签。
 *
 *  · `E*` 已验证：有独立外部证据支持。
 *  · `P`  先验：来自模型知识，未验证，非承重。行业常识、机制原理不强制验证。
 *  · `P!` 先验承重：未验证但结论依赖它。正文可用，但必须显式标出并进待核清单。
 *  · `X`  已证伪：证据与先验矛盾。它承重的论点必须重写，正文不许留它。
 */
export const TAGS = ["E*", "P", "P!", "X"] as const;
export type Tag = (typeof TAGS)[number];

export const CONFIDENCES = ["高", "中", "低"] as const;
export type DraftConfidence = (typeof CONFIDENCES)[number];

export type Assertion = {
  text: string;
  tag: Tag;
  confidence: DraftConfidence;
  /** 这个数在知识截止后可能已经变了（出货量、价格、份额、投产进度、政策）。 */
  timeSensitive: boolean;
  /** 承重：它被推翻时有论点跟着倒。N2 的优先级排序读它。 */
  loadBearing: boolean;
};

export type DraftSection = { dim: DimId; thesis: string; body: string; assertions: Assertion[] };

export type Draft = { thesis: string; sections: DraftSection[]; unknowns: string[] };

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");
const strs = (v: unknown): string[] => (Array.isArray(v) ? v : []).map(s).filter(Boolean);
const FENCE = /^```[a-zA-Z]*$/;

const tag = (v: unknown): Tag => ((TAGS as readonly string[]).includes(s(v)) ? (s(v) as Tag) : "P");
const conf = (v: unknown): DraftConfidence =>
  (CONFIDENCES as readonly string[]).includes(s(v)) ? (s(v) as DraftConfidence) : "中";

/** 这条断言的三元标注模型是不是真填了。**填没填要分得出**：默认值和「写了中档」长得一样。 */
const annotated = (o: Record<string, unknown>): boolean =>
  (TAGS as readonly string[]).includes(s(o.tag)) &&
  (CONFIDENCES as readonly string[]).includes(s(o.confidence)) &&
  typeof o.timeSensitive === "boolean";

function readAssertions(v: unknown): { list: Assertion[]; annotated: number } {
  const raw = (Array.isArray(v) ? v : []).filter(
    (x): x is Record<string, unknown> => !!x && typeof x === "object"
  );
  const list = raw
    .map((o) => ({
      text: s(o.text),
      tag: tag(o.tag),
      confidence: conf(o.confidence),
      timeSensitive: o.timeSensitive === true,
      loadBearing: o.loadBearing === true,
    }))
    .filter((a) => a.text);
  return { list, annotated: raw.filter(annotated).length };
}

/** 解析出来的同时记一笔标注率 —— 机检要它，而它算完就没地方存了。 */
const rates = new WeakMap<Draft, { assertions: number; annotated: number }>();

/**
 * 读一份草稿。三种行：`draft_meta`（总判断）、`draft_section`（一维一行）、
 * `draft_unknowns`（我知道我不知道的）。围栏和空行跳过，别的坏行留账。
 */
export function parseDraft(text: string): { draft: Draft; bad: { line: number; why: string }[] } {
  const draft: Draft = { thesis: "", sections: [], unknowns: [] };
  const bad: { line: number; why: string }[] = [];
  let total = 0;
  let ann = 0;

  text.split("\n").forEach((raw, i) => {
    const line = raw.trim();
    if (!line || FENCE.test(line)) return;
    let o: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(line);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("不是一个对象");
      o = parsed as Record<string, unknown>;
    } catch (e) {
      bad.push({ line: i + 1, why: e instanceof Error ? e.message : "读不出来" });
      return;
    }
    switch (s(o.type)) {
      case "draft_meta":
        draft.thesis = s(o.thesis);
        return;
      case "draft_unknowns":
        draft.unknowns = strs(o.items);
        return;
      case "draft_section": {
        const dim = s(o.dim);
        if (!isDimId(dim)) {
          bad.push({ line: i + 1, why: `不认识的维度编号「${dim.slice(0, 8)}」` });
          return;
        }
        const a = readAssertions(o.assertions);
        total += a.list.length;
        ann += a.annotated;
        draft.sections.push({ dim, thesis: s(o.thesis), body: s(o.body), assertions: a.list });
        return;
      }
      default:
        bad.push({ line: i + 1, why: `不认识的行类型「${s(o.type).slice(0, 20)}」` });
    }
  });

  rates.set(draft, { assertions: total, annotated: ann });
  return { draft, bad };
}

/** 总判断的字数上限（§N1 验收）。 */
const THESIS_MAX = 150;
/** 骑墙话。有它就是没给立场 —— 而这一步的产物如果没有立场，后面的节点没有可验证的东西。 */
const HEDGES = ["有待观察", "喜忧参半", "尚难判断", "还需进一步", "各有利弊"];
/** 断言标注率下限。 */
const ANNOTATION_FLOOR = 0.9;
/** 「我知道我不知道的」下限。 */
const UNKNOWNS_FLOOR = 5;

/** 草稿的缺口。空数组 = 可以进 N2。 */
export function draftGaps(draft: Draft): string[] {
  const gaps: string[] = [];

  if (!draft.thesis) gaps.push("开头没有总判断");
  else {
    if (draft.thesis.replace(/\s/g, "").length > THESIS_MAX) {
      gaps.push(`总判断 ${draft.thesis.replace(/\s/g, "").length} 字，超过 ${THESIS_MAX} 字`);
    }
    const hedge = HEDGES.find((h) => draft.thesis.includes(h));
    if (hedge) gaps.push(`总判断在骑墙（「${hedge}」）—— 它要是一句能被证据推翻的判断句`);
  }

  const have = new Set(draft.sections.map((x) => x.dim));
  for (const dim of DIM_IDS) if (!have.has(dim)) gaps.push(`${dim} 这一维没有内容`);
  for (const sec of draft.sections) {
    if (!sec.thesis) gaps.push(`${sec.dim} 没有论点 —— 每一维要落到一句能被推翻的话上`);
    if (!sec.body) gaps.push(`${sec.dim} 只有论点没有机制`);
  }

  if (draft.unknowns.length < UNKNOWNS_FLOOR) {
    gaps.push(`「我知道我不知道的」只有 ${draft.unknowns.length} 条，不足 ${UNKNOWNS_FLOOR} 条`);
  }

  const r = rates.get(draft);
  if (r && r.assertions && r.annotated / r.assertions < ANNOTATION_FLOOR) {
    gaps.push(
      `${r.assertions} 条断言里只有 ${r.annotated} 条带完整标注（标签+置信度+时效），不足九成`
    );
  }
  return gaps;
}

export const DRAFT_SYSTEM = `你是行业研究员。现在**不检索**，只凭你已有的知识和递给你的主体卡，
写一份完整的行业宏观分析草稿。

## 你的知识就是这份分析的骨架

不留白。你的知识截止之后可能过期的数字**照写**，标上「时效敏感」就行；后面会有专门的节点
拿外部材料来更新或推翻它们。写「资料不足无法判断」是这一步唯一不可接受的答法 —— 那句话
把该由你回答的问题推给了检索。

## 一行一节，交 JSONL

第一行总判断：
{"type":"draft_meta","thesis":"≤150 字，一句能被证据推翻的判断句"}

然后每个维度一行：
{"type":"draft_section","dim":"D1","thesis":"这一维的论点，一句话，可被证据推翻",
 "body":"机制：为什么会这样，因果链写透。这一栏是正文的主体",
 "assertions":[{"text":"事实断言原文","tag":"P","confidence":"高|中|低",
   "timeSensitive":true,"loadBearing":true}]}

最后一行：
{"type":"draft_unknowns","items":["你的知识覆盖不到、但会改变结论的数据点，≥5 条"]}

## 四条硬要求

1. 总判断和每一维的论点都必须是判断句。「有待观察」「喜忧参半」这类骑墙表述一律不算。
2. 每条事实断言都要标全三样：\`tag\`（这一步一律 \`P\`）、\`confidence\`、\`timeSensitive\`。
   \`timeSensitive\` 为真 = 这个数在你的知识截止后可能已经变了（出货量、价格、份额、投产
   进度、政策）；为假 = 机制与结构性事实（成本结构、经营杠杆、切割经济性这类）。
3. \`loadBearing\` 标的是「它被推翻时有论点跟着倒」。标得准，后面的检索预算才花在该花的地方。
4. 最后那份「我知道我不知道的」要具体到数据点，不是「缺最新数据」这种笼统话。`;

export function buildDraftUser(o: { title: string; card: SubjectCard }): string {
  const c = o.card;
  return [
    "## 研究问题",
    o.title,
    "\n## 主体卡",
    `主体：${c.subject}`,
    `行业定义：${c.industry}`,
    `业务构成：${c.segments.map((x) => `${x.name}（${x.weight}，${x.lifecycle}）`).join("；") || "（未给）"}`,
    `在建与战略项目：${
      c.projects
        .map((p) => `${p.name}（${p.investment}，${p.onlineAt} 投产，${p.techRoute}${p.heavy ? "，权重过线" : ""}）`)
        .join("；") || "（未给）"
    }`,
    `客户结构：${c.customers || "（未给）"}`,
    `分析时间窗：${c.window}`,
    "\n## 维度框架",
    ...DIM_IDS.map((id, i) => `${id} ${["需求端", "供给端", "技术路线", "竞争格局", "上游与产业链", "政策与外部环境", "风险与周期位置", "对主体的含义"][i]}`),
    "\n八个维度一个都不许省。按上面的形状交 JSONL。",
  ].join("\n");
}
```

> `buildDraftUser` 里那份维度名单从 `DIMENSIONS` 取更好，但要避免和 `dims.ts` 的 `brief` 重复递进去（提示词里维度说明由 `DRAFT_SYSTEM` 承担）。实现时改成 `DIMENSIONS.map((d) => \`${d.id} ${d.name}：${d.brief}\`)` 并删掉这个内联数组 —— 内联数组会和 `dims.ts` 各说各话。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/agent/a4/draft.test.ts`
Expected: PASS

- [ ] **Step 5: 记账并提交**

changelog 加一条（`0.49.0`）：`"深研先凭自己的知识写出一份有立场的完整草稿，再拿外面的材料去核 —— 上一版要求每句话都绑证据编号，结果材料少的那几轮它只能回答「不足以判断」"`

```bash
git add src/lib/agent/a4/draft.ts src/lib/agent/a4/draft.test.ts src/lib/changelog.ts package.json && git commit -m "深研知识先行：先写有立场的先验草稿，检索只做更新与证伪"
```

---

### Task 4: N2 命题抽取与检索规划（plan.ts）

**Files:**
- Create: `src/lib/agent/a4/plan.ts`
- Test: `src/lib/agent/a4/plan.test.ts`

**Interfaces:**
- Consumes: `Draft`（`./draft`）；`DimId`、`isDimId`、`overBudget`（`./dims`）；`compile`、`Proposition`（`./props`）
- Produces: `SOURCE_KINDS`、`SourceKind`、`PlannedProposition`（= `Proposition & {dimension: DimId; sourceKinds: SourceKind[]; reverse: boolean}`）、`PLAN_SYSTEM`、`buildPlanUser(draft)`、`compilePlan(raw, maxPerDim): PlannedProposition[]`、`planGaps(props): string[]`

- [ ] **Step 1: 写会失败的测试**

```ts
// src/lib/agent/a4/plan.test.ts
import { describe, expect, it } from "vitest";
import { DIM_IDS } from "./dims";
import { PLAN_SYSTEM, compilePlan, planGaps } from "./plan";

const prop = (dim: string, i: number, extra: Record<string, unknown> = {}) => ({
  dimension: dim,
  statement: `${dim}-${i} 这一条命题足够长可以被检索`,
  requiredEvidence: "带统计期间的机构数据",
  queries: [`${dim} 出货量 2026`, `${dim} shipment 2026`],
  counterQueries: [`${dim} 下滑`],
  sourceKinds: ["行业机构", "公司披露"],
  materialityWeight: 0.8,
  freshnessUrgency: 0.8,
  ...extra,
});

const raw = { propositions: DIM_IDS.flatMap((d) => [prop(d, 1), prop(d, 2)]) };

describe("检索计划编译", () => {
  it("命题编号带维度，跨维度不撞号", () => {
    const list = compilePlan(raw, 3);
    expect(list).toHaveLength(16);
    expect(new Set(list.map((p) => p.id)).size).toBe(16);
    expect(list[0].id).toContain("D1");
  });

  it("每维度各自封顶，不是全局封顶", () => {
    const many = { propositions: DIM_IDS.flatMap((d) => [1, 2, 3, 4].map((i) => prop(d, i))) };
    const list = compilePlan(many, 2);
    expect(list).toHaveLength(16);
    expect(list.filter((p) => p.dimension === "D1")).toHaveLength(2);
  });

  it("维度编号不认识的那条丢掉", () => {
    expect(compilePlan({ propositions: [prop("D9", 1)] }, 3)).toHaveLength(0);
  });

  it("来源类型只认表上那几种", () => {
    const list = compilePlan({ propositions: [prop("D1", 1, { sourceKinds: ["行业机构", "小道消息"] })] }, 3);
    expect(list[0].sourceKinds).toEqual(["行业机构"]);
  });

  it("承重与时效照 props.ts 的阈值判，不在这里另立一套", () => {
    const list = compilePlan({ propositions: [prop("D1", 1, { materialityWeight: 0.3 })] }, 3);
    expect(list[0].material).toBe(false);
  });

  it("陈述太短被 props.compile 丢掉时，来源类型不会串到下一条身上", () => {
    // `compile` 先滤掉 <6 字的陈述再截断（props.ts:76），所以按下标回配一定错位。
    const list = compilePlan(
      {
        propositions: [
          prop("D1", 1, { statement: "太短", sourceKinds: ["媒体线索"] }),
          prop("D1", 2, { sourceKinds: ["行业机构", "公司披露", "监管与政策"] }),
        ],
      },
      3
    );
    expect(list).toHaveLength(1);
    expect(list[0].sourceKinds).toEqual(["行业机构", "公司披露", "监管与政策"]);
  });
});

describe("检索计划的缺口", () => {
  it("八维各两条、每条两类来源、有反向问法 —— 没有缺口", () => {
    expect(planGaps(compilePlan(raw, 3))).toEqual([]);
  });

  it("某一维不足两条命题要报出来", () => {
    const thin = { propositions: raw.propositions.filter((p) => !(p.dimension === "D3" && p.statement.includes("-2"))) };
    expect(planGaps(compilePlan(thin, 3)).join("")).toContain("D3");
  });

  it("来源类型只覆盖一类要报出来", () => {
    const one = { propositions: [prop("D1", 1, { sourceKinds: ["行业机构"] }), ...raw.propositions] };
    expect(planGaps(compilePlan(one, 3)).join("")).toContain("来源类型");
  });

  it("某一维吃掉三成以上检索预算要报出来", () => {
    // `compile` 把 queries 封 3 条、counterQueries 封 2 条（props.ts:86-87），所以偏斜要靠
    // **别的维度问得少**来造，不能靠给一个维度堆二十条问法 —— 那些会被截掉。
    const fat = {
      propositions: raw.propositions.map((p) =>
        p.dimension === "D1"
          ? { ...p, queries: ["D1 出货", "D1 shipment", "D1 产能"], counterQueries: ["D1 下滑", "D1 decline"] }
          : { ...p, queries: [`${p.dimension} 单问`], counterQueries: [] }
      ),
    };
    const gaps = planGaps(compilePlan(fat, 3));
    expect(gaps.join("")).toContain("三成");
    expect(gaps.join("")).toContain("D1");
  });

  it("一条反向问法都没有要报出来", () => {
    const noCounter = { propositions: raw.propositions.map((p) => ({ ...p, counterQueries: [] })) };
    expect(planGaps(compilePlan(noCounter, 3)).join("")).toContain("反向");
  });
});

describe("提示词", () => {
  it("说清命题来自草稿、不是来自搜索结果", () => {
    expect(PLAN_SYSTEM).toContain("草稿");
    expect(PLAN_SYSTEM).toContain("反向");
    expect(PLAN_SYSTEM).toContain("三成");
  });
});
```

- [ ] **Step 2: 跑一遍确认它失败**

Run: `pnpm vitest run src/lib/agent/a4/plan.test.ts`
Expected: FAIL — `Failed to resolve import "./plan"`

- [ ] **Step 3: 写实现**

```ts
// src/lib/agent/a4/plan.ts
/**
 * N2 命题抽取与检索规划。**命题从草稿里抽，不从首波检索结果里长出来。**
 *
 * 这一步和 N1 的先后顺序是上一版的死因所在：那一版先检索再定题，于是早期查询撞上一个
 * 数据群之后，后续命题全围着它展开，越挖越深，再也没跳出去。倒过来之后，检索计划由
 * **草稿的结构**驱动 —— 八个维度各自领自己的命题，谁也不许吃掉别人的预算。
 *
 * 验证工作量导向「承重 × 时效敏感 × 低置信」那一批：优先级不由模型自己排，由这三样
 * 相乘（承重与时效的阈值判定复用 `props.ts`，不在这里另立一套）。
 */

import { isDimId, overBudget, DIM_IDS, dimName, type DimId } from "./dims";
import type { Draft } from "./draft";
import { compile, type Proposition } from "./props";

/**
 * 来源类型。一条命题的查询要覆盖 ≥2 类 —— 全砸在媒体转载上的话，取回来的十几条会是同
 * 一份统计的十几个转发，而共源折叠之后只剩一条。
 */
export const SOURCE_KINDS = ["行业机构", "公司披露", "监管与政策", "媒体线索"] as const;
export type SourceKind = (typeof SOURCE_KINDS)[number];

export type PlannedProposition = Proposition & {
  dimension: DimId;
  sourceKinds: SourceKind[];
};

const s = (v: unknown): string => (typeof v === "string" ? v.trim() : "");

const kinds = (v: unknown): SourceKind[] => {
  const out: SourceKind[] = [];
  for (const one of (Array.isArray(v) ? v : []).map(s)) {
    if ((SOURCE_KINDS as readonly string[]).includes(one) && !out.includes(one as SourceKind)) {
      out.push(one as SourceKind);
    }
  }
  return out;
};

/**
 * 模型交的清单 → 带维度的命题。**按维度分组各自封顶**，不是全局取前 N 条。
 *
 * 全局封顶等于让排在前面的维度把配额吃光 —— 而模型交上来的顺序通常就是它自己关注度的
 * 顺序，那正是要拦的偏斜。承重/时效的阈值判定转交 `props.compile`：两处各写一套的话，
 * 同一个 0.7 会在某次只改了一头之后变成两个数。
 */
export function compilePlan(raw: { propositions?: unknown }, maxPerDim: number): PlannedProposition[] {
  const list = ((Array.isArray(raw.propositions) ? raw.propositions : []) as Record<string, unknown>[])
    // 认不出的维度编号直接丢 —— 让它悄悄落到 D1 上，等于把一条无主命题记在别人账上。
    .filter((p) => isDimId(s(p.dimension)));
  const out: PlannedProposition[] = [];
  for (const dim of DIM_IDS) {
    const mine = list.filter((p) => s(p.dimension) === dim);
    if (!mine.length) continue;
    /*
     * `compile` 会先滤掉 <6 字的陈述再截断（props.ts:76），所以它交回来的第 i 条不一定是
     * `mine[i]`。**按陈述文本回配**，不按下标 —— 按下标的话，一条陈述太短被丢掉之后，
     * 它后面每一条的来源类型都串到了上一条身上，而产出看不出任何异常。
     */
    const byStatement = new Map(mine.map((p) => [s(p.statement), p] as const));
    compile({ propositions: mine }, maxPerDim).forEach((p, i) => {
      out.push({
        ...p,
        // 编号带维度：跨维度不撞号，而且台账上一眼看得出这条证据是替哪一维取的。
        id: `${dim}-P${i + 1}`,
        dimension: dim,
        sourceKinds: kinds(byStatement.get(p.statement)?.sourceKinds),
      });
    });
  }
  return out;
}

/** 每个维度至少几条命题。 */
const MIN_PROPS_PER_DIM = 2;
/** 一条命题的查询至少覆盖几类来源。 */
const MIN_SOURCE_KINDS = 2;

/** 检索计划的缺口。空数组 = 可以进 N3。 */
export function planGaps(props: readonly PlannedProposition[]): string[] {
  const gaps: string[] = [];

  for (const dim of DIM_IDS) {
    const mine = props.filter((p) => p.dimension === dim);
    if (mine.length < MIN_PROPS_PER_DIM) {
      gaps.push(`${dim} ${dimName(dim)} 只有 ${mine.length} 条命题，不足 ${MIN_PROPS_PER_DIM} 条`);
    }
  }

  for (const p of props) {
    if (p.sourceKinds.length < MIN_SOURCE_KINDS) {
      gaps.push(`${p.id} 的查询只覆盖 ${p.sourceKinds.length} 类来源类型，不足 ${MIN_SOURCE_KINDS} 类`);
    }
  }

  const byDim: Record<string, number> = {};
  for (const p of props) {
    byDim[p.dimension] = (byDim[p.dimension] ?? 0) + p.queries.length + p.counterQueries.length;
  }
  for (const over of overBudget(byDim)) {
    gaps.push(
      `${over.dim} ${dimName(over.dim as DimId)} 吃掉了 ${Math.round(over.share * 100)}% 的检索式，超过三成上限`
    );
  }

  if (props.length && !props.some((p) => p.counterQueries.length)) {
    gaps.push("一条反向问法都没有 —— 这一轮不会去找推翻结论的东西");
  }
  return gaps;
}

export const PLAN_SYSTEM = `你在给一份**已经写好的**行业分析草稿排检索计划。

草稿是凭知识写的，里面每条事实断言都标了 \`P\`（先验、未验证）。你的活是挑出该拿外部材料
去核的那些，转成可检索的命题。**命题只从草稿里抽** —— 不要另起题目，不要等搜索结果回来
再决定研究什么。

## 挑哪些

优先级 = 承重度（它被推翻时有几个论点跟着倒）× 时效敏感度 × (1 / 置信度)。机制类、结构类
的断言（成本结构、经营杠杆、切割经济性）不必验证；出货量、价格、份额、投产进度、政策这类
时效敏感的承重断言必须验证。

## 三件事一起做

1. **验证命题**：每条给 2-3 条查询，覆盖 ≥2 类来源（行业机构原始数据 / 公司披露 /
   监管与政策原文 / 媒体线索）。媒体只作线索，不作终点。
2. **盲区查询**：对每个维度，针对草稿最后那份「我知道我不知道的」和该维度的时效敏感断言，
   生成带年份或季度限定词的「最新数据」型查询。
3. **反向命题**：对总判断和每一维的论点，各给 ≥1 条「若为假会是什么样」的查询 —— 去找
   反例，不是去找确认。

## 交什么

{"propositions":[{"dimension":"D1","statement":"一句可证伪的陈述","requiredEvidence":"什么样的证据才算回答了它",
 "queries":["正向问法"],"counterQueries":["反向问法"],"sourceKinds":["行业机构","公司披露"],
 "materialityWeight":0.8,"freshnessUrgency":0.9}]}

## 预算纪律

每个维度至少 2 条命题。**任何一个维度的检索式不得超过总量的三成** —— 上一轮就是一个维度
把预算吃光，最后交出一份只覆盖一个角落的行业分析。`;

export function buildPlanUser(draft: Draft): string {
  return [
    "## 草稿的总判断",
    draft.thesis,
    "\n## 各维度的论点与待核断言",
    ...draft.sections.map((sec) =>
      [
        `### ${sec.dim} ${dimName(sec.dim)}`,
        `论点：${sec.thesis}`,
        ...sec.assertions.map(
          (a) =>
            `- ${a.text}｜置信度 ${a.confidence}｜${a.timeSensitive ? "时效敏感" : "时效不敏感"}｜${
              a.loadBearing ? "承重" : "非承重"
            }`
        ),
      ].join("\n")
    ),
    "\n## 我知道我不知道的",
    ...draft.unknowns.map((x) => `- ${x}`),
  ].join("\n");
}
```

> `compile` 的两处封顶要记住，它们会咬到测试构造：`queries` 封 3 条、`counterQueries` 封 2 条
> （props.ts:86-87）。所以「某一维超预算」这件事只能靠**别的维度问得少**来造。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/agent/a4/plan.test.ts`
Expected: PASS

- [ ] **Step 5: 记账并提交**

changelog 加一条（`0.49.1`）：`"待查命题现在从那份先验草稿里抽，不再由第一波搜索结果种下；单个维度最多占三成检索预算"`

```bash
git add src/lib/agent/a4/plan.ts src/lib/agent/a4/plan.test.ts src/lib/changelog.ts package.json && git commit -m "命题前置：从草稿抽命题，单维度检索预算封三成"
```

---

### Task 5: 波内共源率与改写触发（cosource.ts）

**Files:**
- Create: `src/lib/agent/a4/cosource.ts`
- Test: `src/lib/agent/a4/cosource.test.ts`

**Interfaces:**
- Consumes: `Evidence`（`@/lib/research/ledger`）
- Produces: `waveShare({entries, wave}): {total: number; distinct: number; share: number}`、`REWRITE_TRIGGER`、`needsRewrite(share)`、`REWRITE_SYSTEM`、`buildRewriteUser({dimension, tried, coSourced})`、`readRewrite(text): string[]`

- [ ] **Step 1: 写会失败的测试**

```ts
// src/lib/agent/a4/cosource.test.ts
import { describe, expect, it } from "vitest";
import { REWRITE_SYSTEM, buildRewriteUser, needsRewrite, readRewrite, waveShare } from "./cosource";

const e = (group: string, id: string) => ({ id, independenceGroup: group }) as never;

describe("波内共源率", () => {
  it("五条里三条同组 —— 共源率六成", () => {
    const r = waveShare([e("g1", "E1"), e("g1", "E2"), e("g1", "E3"), e("g2", "E4"), e("g3", "E5")]);
    expect(r.total).toBe(5);
    expect(r.distinct).toBe(3);
    expect(r.share).toBeCloseTo(0.4);
  });

  it("一条都没有时共源率是 0，不是 NaN", () => {
    expect(waveShare([]).share).toBe(0);
  });

  it("超过一半是同一批来源就要改写问法", () => {
    expect(needsRewrite(0.6)).toBe(true);
    expect(needsRewrite(0.5)).toBe(false);
  });
});

describe("改写问法", () => {
  it("把试过的问法和撞上的那批来源都递进去", () => {
    const user = buildRewriteUser({
      dimension: "D2 供给端",
      tried: ["8.6 代线 扩产"],
      coSourced: ["CINNO 2026Q1 出货量统计"],
    });
    expect(user).toContain("8.6 代线 扩产");
    expect(user).toContain("CINNO");
  });

  it("禁止原问法微调，明写换机构、换来源类型、换语言、换限定词", () => {
    expect(REWRITE_SYSTEM).toContain("微调");
    expect(REWRITE_SYSTEM).toContain("英文");
  });

  it("读得出改写后的问法，空的和重复的去掉", () => {
    expect(readRewrite('{"queries":["a"," ","a","b"]}')).toEqual(["a", "b"]);
  });

  it("读不出来时返回空数组，不抛异常", () => {
    expect(readRewrite("不是 JSON")).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑一遍确认它失败**

Run: `pnpm vitest run src/lib/agent/a4/cosource.test.ts`
Expected: FAIL — `Failed to resolve import "./cosource"`

- [ ] **Step 3: 写实现**

```ts
// src/lib/agent/a4/cosource.ts
/**
 * 共源率与改写触发。**共源判定放在检索循环里，不留到合成阶段。**
 *
 * 上一版是在合成时才去重的：26 条证据弃用 15 条 —— 检索预算已经花掉了，弃用清单只是
 * 事后记账。放进循环之后，一波回来共源率过半就当场改写问法：那一波已经说明这个问法只
 * 通向同一批稿子的转载，再发一遍原问法（或它的微调）只会再取回同一批。
 *
 * 独立性折叠本身不在这里 —— `research/independence.ts` 干那件事，`Ledger.fold` 把组号
 * 写回每条证据。这个文件只回答「这一波的组号分布该不该触发改写」以及「改写问什么」。
 */

import type { Evidence } from "@/lib/research/ledger";

/** 这一波的共源情况。`share` = 1 - 独立组数/条数：零表示条条独立，越高表示越挤在一起。 */
export function waveShare(entries: readonly Pick<Evidence, "independenceGroup">[]): {
  total: number;
  distinct: number;
  share: number;
} {
  const total = entries.length;
  const distinct = new Set(entries.map((e) => e.independenceGroup || "?")).size;
  return { total, distinct, share: total ? 1 - distinct / total : 0 };
}

/** 过了这条线就改写。一半是分界：半数以上来自同几组，说明这个问法通向的是转载群。 */
export const REWRITE_TRIGGER = 0.5;

export const needsRewrite = (share: number): boolean => share > REWRITE_TRIGGER;

export const REWRITE_SYSTEM = `刚发出去的一波检索里，过半的结果来自同一批来源（同机构、同口径、
同数值的转载）。再发一次原问法只会取回同一批。

给一组**换过方向**的问法。四条路，至少走两条：

· 换机构 —— 点名另一家会发布这类数据的机构
· 换来源类型 —— 从行业机构转向公司披露、监管与政策原文、行业协会
· 换语言 —— 同一件事的英文问法（境外机构的原始发布往往只有英文那一份）
· 换限定词 —— 换统计期间、换应用细分、换环节

**禁止原问法微调**：改个语序、加个「最新」、把年份从 2025 换成 2026 都不算换方向。

交：{"queries":["改写后的问法"]}`;

export function buildRewriteUser(o: {
  dimension: string;
  tried: readonly string[];
  coSourced: readonly string[];
}): string {
  return [
    `## 这一维在查什么`,
    o.dimension,
    "\n## 已经试过的问法",
    ...o.tried.map((q) => `- ${q}`),
    "\n## 撞上的那批来源",
    ...o.coSourced.map((x) => `- ${x}`),
    "\n按上面四条路换方向，交那一行 JSON。",
  ].join("\n");
}

/** 读改写后的问法。读不出来返回空数组 —— 改写失败不该让这一维的取证整段中断。 */
export function readRewrite(text: string): string[] {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^```[a-zA-Z]*\n?|```$/g, "").trim());
  } catch {
    return [];
  }
  const list = (raw && typeof raw === "object" ? (raw as { queries?: unknown }).queries : null) ?? [];
  const out: string[] = [];
  for (const q of (Array.isArray(list) ? list : []).map((x) => (typeof x === "string" ? x.trim() : ""))) {
    if (q && !out.includes(q)) out.push(q);
  }
  return out;
}
```

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/agent/a4/cosource.test.ts`
Expected: PASS

- [ ] **Step 5: 记账并提交**

changelog 加一条（`0.49.2`）：`"一波检索回来过半是同一批来源的转载时，当场换问法再发 —— 不再等到写报告那一步才把重复的十几条扔掉"`

```bash
git add src/lib/agent/a4/cosource.ts src/lib/agent/a4/cosource.test.ts src/lib/changelog.ts package.json && git commit -m "共源判定进检索循环：过半共源当场改写问法"
```

---

### Task 6: N3 分维度取证编排（sweep.ts）

**Files:**
- Create: `src/lib/agent/a4/sweep.ts`
- Test: `src/lib/agent/a4/sweep.test.ts`

**Interfaces:**
- Consumes: `gatherEvidence`、`Round`（`./evidence`）；`PlannedProposition`（`./plan`）；`DimCoverage`、`gateOpen`、`DIM_IDS`（`./dims`）；`waveShare`、`needsRewrite`、`buildRewriteUser`、`readRewrite`、`REWRITE_SYSTEM`（`./cosource`）；`Harness`、`SearchProvider`、`Ledger`
- Produces: `CHAINS`、`SweepResult`、`sweep(h, search, props, opts): Promise<SweepResult>`

`SweepResult = { ledger: Ledger; rounds: Round[]; verdicts: Verdict[]; coverage: DimCoverage[]; gate: {ok: boolean; missing: string[]}; rewrites: {dimension: string; from: string[]; to: string[]}[]; capped: string[] }`（`dimension` 存的是**链名**不是维度号 —— 一条链领着两三个维度，改写是整条链一起换问法）

- [ ] **Step 1: 写会失败的测试**

`sweep` 要调模型和检索，所以测试里两样都换成假的：检索用 `providers()` 在 `TKOS_MODEL_MOCK=1` 下返回的 `MockSearch`，模型调用走 `Harness` 的 mock 档（`src/lib/models/mock.ts`）。这一条已经被 `harness.test.ts` 走通过，照它的写法搭。

```ts
// src/lib/agent/a4/sweep.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { Harness } from "@/lib/agent/harness";
import { providers } from "@/lib/research/search";
import { DIM_IDS } from "./dims";
import { CHAINS, sweep } from "./sweep";
import type { PlannedProposition } from "./plan";

const prop = (dim: string, i: number): PlannedProposition =>
  ({
    id: `${dim}-P${i}`,
    dimension: dim,
    statement: `${dim} 第 ${i} 条命题`,
    requiredEvidence: "机构数据",
    queries: [`${dim} q${i}`],
    counterQueries: [`${dim} 反 ${i}`],
    sourceKinds: ["行业机构", "公司披露"],
    material: true,
    freshnessUrgent: true,
    extraRoundsCap: 1,
  }) as PlannedProposition;

describe("分链", () => {
  it("八个维度分完，一维只属于一条链", () => {
    const all = CHAINS.flatMap((c) => c.dims);
    expect(new Set(all).size).toBe(8);
    expect(all).toHaveLength(8);
  });

  it("链数在三到四条之间 —— 按维度分工，不按模型分工", () => {
    expect(CHAINS.length).toBeGreaterThanOrEqual(3);
    expect(CHAINS.length).toBeLessThanOrEqual(4);
  });
});

describe("覆盖门控", () => {
  beforeEach(() => {
    process.env.TKOS_MODEL_MOCK = "1";
  });

  it("每个维度都上覆盖表，一个不缺", async () => {
    const h = new Harness({ agent: "A4", slot: "pro" });
    const r = await sweep(h, providers().list, DIM_IDS.flatMap((d) => [prop(d, 1), prop(d, 2)]), {
      slot: "pro",
      strongDims: [],
      substep: () => {},
    });
    expect(r.coverage.map((x) => x.dim).sort()).toEqual([...DIM_IDS].sort());
  });

  it("一条命题都没有的维度也上表，标成已搜未得", async () => {
    const h = new Harness({ agent: "A4", slot: "pro" });
    const r = await sweep(h, providers().list, [prop("D1", 1), prop("D1", 2)], {
      slot: "pro",
      strongDims: [],
      substep: () => {},
    });
    const d5 = r.coverage.find((x) => x.dim === "D5");
    expect(d5?.independentGroups).toBe(0);
    expect(d5?.notFound).toBeDefined();
  });

  it("门没开时不抛异常，缺口写在 gate.missing 里", async () => {
    const h = new Harness({ agent: "A4", slot: "pro" });
    const r = await sweep(h, providers().list, [prop("D1", 1)], { slot: "pro", strongDims: [], substep: () => {} });
    expect(r.gate.ok).toBe(false);
    expect(r.gate.missing.length).toBeGreaterThan(0);
  });

  it("每一轮只替自己那条链的维度搜 —— 链之间不串命题", async () => {
    const h = new Harness({ agent: "A4", slot: "pro" });
    const r = await sweep(h, providers().list, DIM_IDS.flatMap((d) => [prop(d, 1), prop(d, 2)]), {
      slot: "pro",
      strongDims: [],
      substep: () => {},
    });
    expect(r.rounds.length).toBeGreaterThan(0);
    for (const round of r.rounds) {
      const dims = new Set(round.propositionIds.map((id) => id.split("-")[0]));
      const chain = CHAINS.find((c) => [...dims].every((d) => (c.dims as readonly string[]).includes(d)));
      expect(chain, `这一轮跨了链：${round.propositionIds.join("、")}`).toBeDefined();
    }
  });

  it("假检索给的是三个不同域名，共源率不过线 —— 不该触发改写", async () => {
    const h = new Harness({ agent: "A4", slot: "pro" });
    const r = await sweep(h, providers().list, [prop("D1", 1), prop("D1", 2)], {
      slot: "pro",
      strongDims: [],
      substep: () => {},
    });
    expect(r.rewrites).toEqual([]);
    expect(r.capped).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑一遍确认它失败**

Run: `pnpm vitest run src/lib/agent/a4/sweep.test.ts`
Expected: FAIL — `Failed to resolve import "./sweep"`

- [ ] **Step 3: 写实现**

```ts
// src/lib/agent/a4/sweep.ts
/**
 * N3 分维度取证。**链按维度切，不按模型切。**
 *
 * 上一版是四个模型各跑一整套研究。两次实验都证明它买到的不是信息多样性而是共源冗余：
 * 四条链撞上同一批稿子，然后各自把它们读一遍。信息多样性来自**查询分解**，不来自模型
 * 数量 —— 所以这一版把并行的轴换成维度，模型只是链的执行引擎，可以互换。
 *
 * 每条链自己领几个维度的全部命题，自己跑 `gatherEvidence`（检索→抓取→抽取→入账→折叠
 * →判定那六段一个字不改），跑完一波看共源率：过半就改写问法再发一波。
 *
 * ## 收口只有两种合法形态
 *
 * 每个维度要么有独立来源，要么有一条「已搜未得」的记录（列出试过的全部问法，并声明这一维
 * 将以 `[P]`/`[P!]` 成稿）。**缺维度不许静默消失** —— 上一版的「未能核实」只覆盖已生成的
 * 命题，压根没生成过的命题不在任何清单上。
 */

import type { Harness } from "@/lib/agent/harness";
import type { Slot } from "@/lib/models/slots";
import { Ledger } from "@/lib/research/ledger";
import type { SearchProvider } from "@/lib/research/search";
import { tally } from "@/lib/research/coverage";

import { DIM_IDS, gateOpen, dimName, type DimCoverage, type DimId } from "./dims";
import { REWRITE_SYSTEM, buildRewriteUser, needsRewrite, readRewrite, waveShare } from "./cosource";
import { gatherEvidence, type Round } from "./evidence";
import type { PlannedProposition } from "./plan";
import type { Verdict } from "./props";

/**
 * 几条链各领哪几维。
 *
 * 分组按「会撞上同一批来源」聚：需求端和供给端问的是同一批出货与产能统计，技术路线和
 * 上游问的是同一批供应链材料。同一条链里的两维共享一份台账，共源折叠因此看得见它们的
 * 重叠 —— 分到两条链上就看不见了。
 */
export const CHAINS: readonly { label: string; dims: readonly DimId[] }[] = [
  { label: "需求与供给", dims: ["D1", "D2"] },
  { label: "技术与上游", dims: ["D3", "D5"] },
  { label: "格局", dims: ["D4"] },
  { label: "政策、风险与主体", dims: ["D6", "D7", "D8"] },
] as const;

/** 一条链最多攒几条证据。超了按现状收口并记缺口 —— 无上限的补搜会一直搜到超时。 */
const MAX_EVIDENCE_PER_CHAIN = 24;
/** 一条链最多几波。 */
const MAX_WAVES = 3;

export type SweepResult = {
  ledger: Ledger;
  rounds: Round[];
  verdicts: Verdict[];
  coverage: DimCoverage[];
  gate: { ok: boolean; missing: string[] };
  rewrites: { dimension: string; from: string[]; to: string[] }[];
  /** 超了预算按现状收口的那几条链，一条一句原话。 */
  capped: string[];
};

export async function sweep(
  h: Harness,
  search: SearchProvider[],
  props: readonly PlannedProposition[],
  opts: {
    slot: Slot;
    /** 打算下「当前更支持」及以上判断的维度，它们要两组独立来源。 */
    strongDims: readonly DimId[];
    substep: (suffix: string) => void;
  }
): Promise<SweepResult> {
  const merged = new Ledger();
  const rounds: Round[] = [];
  const verdicts: Verdict[] = [];
  const rewrites: SweepResult["rewrites"] = [];
  const capped: string[] = [];
  /** 每个维度试过的全部问法。已搜未得那一栏要它。 */
  const tried = new Map<DimId, string[]>();

  for (const [ci, chain] of CHAINS.entries()) {
    const mine = props.filter((p) => (chain.dims as readonly string[]).includes(p.dimension));
    for (const d of chain.dims) {
      tried.set(d, [...(tried.get(d) ?? []), ...mine.filter((p) => p.dimension === d).flatMap((p) => [...p.queries, ...p.counterQueries])]);
    }
    if (!mine.length) continue;

    let wave = 0;
    let todo = [...mine];
    while (todo.length && wave < MAX_WAVES) {
      wave += 1;
      opts.substep(`第 ${ci + 1}/${CHAINS.length} 条链「${chain.label}」· 第 ${wave} 波`);
      const ev = await gatherEvidence(h, search, todo, { ...h.budget, maxRounds: 1 }, {
        slot: opts.slot,
        label: chain.label,
        substep: opts.substep,
      });
      for (const e of ev.ledger.entries) merged.entries.push(e);
      rounds.push(...ev.rounds);
      verdicts.push(...ev.verdicts.filter((v) => !verdicts.some((x) => x.propositionId === v.propositionId)));

      const share = waveShare(ev.ledger.entries);
      h.note(
        `${chain.label} · 第 ${wave} 波共源`,
        { 入账: share.total, 独立组: share.distinct, 共源率: `${Math.round(share.share * 100)}%` },
        "local"
      );
      if (ev.ledger.entries.length >= MAX_EVIDENCE_PER_CHAIN) {
        capped.push(`${chain.label} 攒到 ${ev.ledger.entries.length} 条，到了单链上限，按现状收口`);
        break;
      }
      if (!needsRewrite(share.share)) break;

      // 过半共源：换方向再发一波。改写失败（读不出问法）就收口，不重发原问法。
      const raw = await h
        .callMessages(
          `模型调用 · a4.rewrite（${chain.label}）`,
          [
            { role: "system", content: REWRITE_SYSTEM },
            {
              role: "user",
              content: buildRewriteUser({
                dimension: chain.dims.map((d) => `${d} ${dimName(d)}`).join("、"),
                tried: todo.flatMap((p) => p.queries),
                // `siteName` 是「新浪财经」这种中文台名（可能缺），`sourceDomain` 一律有。
                // 两个都给：改写要认的是「这批稿子出自谁」，而域名和台名各说得清一半。
                coSourced: ev.ledger.entries.map((e) => `${e.siteName || e.sourceDomain}｜${e.claim}`),
              }),
            },
          ],
          { slot: opts.slot, maxTokens: 2000 },
          { promptKey: "a4.rewrite", lane: chain.label },
          "a4.rewrite"
        )
        .then((r) => r.text)
        .catch(() => "");
      const next = readRewrite(raw);
      if (!next.length) break;
      rewrites.push({ dimension: chain.label, from: todo.flatMap((p) => p.queries), to: next });
      for (const d of chain.dims) tried.set(d, [...(tried.get(d) ?? []), ...next]);
      // 改写后的问法挂回还没闭合的那几条命题上：命题本身不变，只换问法。
      todo = todo
        .filter((p) => !verdicts.find((v) => v.propositionId === p.id)?.ok)
        .map((p) => ({ ...p, queries: next }));
    }
  }

  // ---- 覆盖表 -------------------------------------------------------------
  // 折叠之后按维度清点。**每个维度都上表**，包括压根没有命题的那几个 —— 那正是上一版
  // 静默消失的那一类。
  const byProp = new Map(
    tally(
      merged.entries.map((e) => ({
        propositionId: e.propositionId,
        group: e.independenceGroup,
        sourceDomain: e.sourceDomain,
      }))
    ).map((t) => [t.propositionId, t])
  );
  const coverage: DimCoverage[] = DIM_IDS.map((dim) => {
    const groups = new Set<string>();
    for (const p of props.filter((x) => x.dimension === dim)) {
      const t = byProp.get(p.id);
      if (t?.citableGroups) for (const e of merged.entries.filter((x) => x.propositionId === p.id)) groups.add(e.independenceGroup);
    }
    const row: DimCoverage = { dim, independentGroups: groups.size };
    if (!groups.size) row.notFound = { tried: [...new Set(tried.get(dim) ?? [])] };
    return row;
  });

  const gate = gateOpen(coverage, opts.strongDims);
  h.note(
    "覆盖表",
    {
      各维: coverage.map(
        (r) => `${r.dim} ${dimName(r.dim)}：${r.independentGroups} 组${r.notFound ? `（已搜未得，试过 ${r.notFound.tried.length} 条问法）` : ""}`
      ),
      门: gate.ok ? "开" : gate.missing,
      改写: rewrites.map((r) => `${r.dimension}：${r.from.length} 条 → ${r.to.length} 条`),
      收口: capped,
    },
    "local"
  );

  return { ledger: merged, rounds, verdicts, coverage, gate, rewrites, capped };
}
```

> 已核过的三处签名（`gatherEvidence` 的第 4、5 个参数就是 `{searchK, maxRounds}` 和
> `LaneRef {slot, label, substep}`；`Evidencing = {ledger, rounds, verdicts, tallies, pages}`；
> `Ledger.entries` 是 `readonly entries: Evidence[] = []` —— 属性只读、数组可变，所以
> `merged.entries.push(e)` 编得过）。**别给 `Ledger` 加新方法**：合并这件事只有这一处要，
> 加个 `absorb()` 就多一个入口绕过 `record()` 的入账校验。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/agent/a4/sweep.test.ts`
Expected: PASS

- [ ] **Step 5: 记账并提交**

changelog 加一条（`0.50.0`）：`"深研的并行从「四个模型各跑一遍」换成「按维度分头去查」：八个维度分四条链，合成前每一维要么有独立来源要么留一条已搜未得的记录"`

```bash
git add src/lib/agent/a4/sweep.ts src/lib/agent/a4/sweep.test.ts src/lib/changelog.ts package.json && git commit -m "取证按维度分链：覆盖门控收口，缺维度不再静默消失"
```

---

### Task 7: N4 校验合并（reconcile.ts）

**Files:**
- Create: `src/lib/agent/a4/reconcile.ts`
- Test: `src/lib/agent/a4/reconcile.test.ts`

**Interfaces:**
- Consumes: `Draft`、`Tag`（`./draft`）；`Evidence`（`@/lib/research/ledger`）
- Produces: `ChangeState`（`"证实"|"修正"|"矛盾"|"未验证"`）、`ChangeLogEntry`、`Merged`、`RECONCILE_SYSTEM`、`buildReconcileUser({draft, evidencePack})`、`parseMerged(text)`、`reconcileGaps(draft, merged): string[]`、`CONTRADICTION_ABORT`

- [ ] **Step 1: 写会失败的测试**

```ts
// src/lib/agent/a4/reconcile.test.ts
import { describe, expect, it } from "vitest";
import { RECONCILE_SYSTEM, parseMerged, reconcileGaps } from "./reconcile";
import { parseDraft } from "./draft";
import { DIM_IDS } from "./dims";

const draftText = [
  JSON.stringify({ type: "draft_meta", thesis: "总量红利已用完，往后看份额重排" }),
  ...DIM_IDS.map((dim) =>
    JSON.stringify({
      type: "draft_section",
      dim,
      thesis: `${dim} 的论点`,
      body: "机制",
      assertions: [{ text: `${dim} 断言一`, tag: "P", confidence: "中", timeSensitive: true, loadBearing: true }],
    })
  ),
  JSON.stringify({ type: "draft_unknowns", items: ["a", "b", "c", "d", "e"] }),
].join("\n");

const draft = parseDraft(draftText).draft;

const log = (dim: string, state: string) =>
  JSON.stringify({ type: "change", assertion: `${dim} 断言一`, from: "P", to: state === "未验证" ? "P!" : "E*", state, evidenceIds: ["E1"] });

const merged = (states: string[]) =>
  [
    JSON.stringify({ type: "merged_meta", thesis: "总量红利已用完，往后看份额重排" }),
    ...DIM_IDS.map((dim, i) =>
      JSON.stringify({ type: "merged_section", dim, thesis: `${dim} 的论点`, body: "机制", tags: ["E*"] })
    ),
    ...DIM_IDS.map((dim, i) => log(dim, states[i] ?? "证实")),
  ].join("\n");

describe("合并稿解析", () => {
  it("读得出变更日志的四态", () => {
    const r = parseMerged(merged(["证实", "修正", "矛盾", "未验证"]));
    expect(r.changes.map((c) => c.state).slice(0, 4)).toEqual(["证实", "修正", "矛盾", "未验证"]);
  });

  it("四态之外的状态不收，留坏行", () => {
    const r = parseMerged(JSON.stringify({ type: "change", assertion: "x", state: "大概对" }));
    expect(r.changes).toHaveLength(0);
    expect(r.bad).toHaveLength(1);
  });
});

describe("合并稿的缺口", () => {
  it("每条断言都在变更日志里 —— 没有缺口", () => {
    expect(reconcileGaps(draft, parseMerged(merged([])))).toEqual([]);
  });

  it("有断言没进变更日志要报出来", () => {
    const short = merged([]).split("\n").filter((l) => !l.includes("D6 断言一")).join("\n");
    expect(reconcileGaps(draft, parseMerged(short)).join("")).toContain("D6 断言一");
  });

  it("正文里留着已证伪的标签要报出来", () => {
    const withX = merged([]).replace('"tags":["E*"]', '"tags":["X"]');
    expect(reconcileGaps(draft, parseMerged(withX)).join("")).toContain("X");
  });

  it("矛盾态超过三成要报出来，并且说的是退回主体卡", () => {
    const many = merged(["矛盾", "矛盾", "矛盾", "矛盾", "证实", "证实", "证实", "证实"]);
    const gaps = reconcileGaps(draft, parseMerged(many));
    expect(gaps.join("")).toContain("三成");
    expect(gaps.join("")).toContain("主体卡");
  });
});

describe("提示词", () => {
  it("明写缺证据只降标签、不删内容", () => {
    expect(RECONCILE_SYSTEM).toContain("不构成删除理由");
    expect(RECONCILE_SYSTEM).toContain("P!");
  });

  it("矛盾态要求重写论点，不许加脚注了事", () => {
    expect(RECONCILE_SYSTEM).toContain("重写");
    expect(RECONCILE_SYSTEM).toContain("脚注");
  });
});
```

- [ ] **Step 2: 跑一遍确认它失败**

Run: `pnpm vitest run src/lib/agent/a4/reconcile.test.ts`
Expected: FAIL — `Failed to resolve import "./reconcile"`

- [ ] **Step 3: 写实现**

要点（照测试写）：

```ts
// src/lib/agent/a4/reconcile.ts
/**
 * N4 校验合并。**证据修改草稿，缺证据只改标签。**
 *
 * 这一条是 v2 与上一版分野最深的地方：上一版「没有证据支持」的处置是把那段话删掉或改写成
 * 「不足以判断」，于是一次只取回两条证据的运行输出了一份证据审计报告。这一版的处置是把
 * 标签从 `P` 降到 `P!` 并把它写进待核清单 —— 内容留着，读的人知道它未核。
 *
 * 四态：证实（升 `E*`，数字以证据为准）、修正（换数、留论证结构）、矛盾（标 `X`，它承重的
 * 论点必须重写，重写后与总判断冲突则总判断一并改）、未验证（留 `P`，承重的升 `P!`）。
 *
 * 矛盾态过三成就中止合并 —— 那说明先验大面积失效，问题不在这一步，在主体卡或维度框架。
 */
export const CHANGE_STATES = ["证实", "修正", "矛盾", "未验证"] as const;
export type ChangeState = (typeof CHANGE_STATES)[number];

export type ChangeLogEntry = {
  assertion: string;
  from: string;
  to: Tag;
  state: ChangeState;
  evidenceIds: string[];
};

export type Merged = {
  thesis: string;
  sections: { dim: DimId; thesis: string; body: string; tags: Tag[] }[];
  changes: ChangeLogEntry[];
  bad: { line: number; why: string }[];
};

/** 矛盾态占比过了它就中止合并，退回 N0。 */
export const CONTRADICTION_ABORT = 0.3;
```

`parseMerged` 照 `parseDraft` 的三种行写（`merged_meta` / `merged_section` / `change`），四态之外的 `state` 留坏行。`reconcileGaps` 三条：
1. 草稿里每条断言的 `text` 必须在 `changes` 里出现过（对账覆盖率 100%）；
2. 任何 `section.tags` 含 `X` → 报出来（正文不许留已证伪的断言）；
3. `changes` 里 `state === "矛盾"` 的占比 > `CONTRADICTION_ABORT` → 报一句「矛盾态 X%，超过三成：先验大面积失效，退回主体卡与维度框架」。

`RECONCILE_SYSTEM` 照 spec §N4 的 prompt 全文写，四态逐条、附加规则三条（共源只引最高级一条、口径检查、矛盾过三成中止），并明写「缺证据不构成删除理由」和「不许保留原论点加脚注了事」。`buildReconcileUser` 递草稿（`buildDraftUser` 那份的复用）+ `buildEvidencePack(entries)`（复用 `prompt.ts:932`）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/agent/a4/reconcile.test.ts`
Expected: PASS

- [ ] **Step 5: 记账并提交**

changelog 加一条（`0.50.1`）：`"证据回来之后逐条对账：证实的换成实测数、方向相反的把论点重写、查不到的降一档标成待核 —— 查不到不再等于把那段话删掉"`

```bash
git add src/lib/agent/a4/reconcile.ts src/lib/agent/a4/reconcile.test.ts src/lib/changelog.ts package.json && git commit -m "四态对账：证据只更新或证伪先验，缺证据只降标签"
```

---

### Task 8: N5 分层成稿（layer.ts + schema 加一栏）

**Files:**
- Modify: `src/lib/agent/a4/blocks/schema.ts`（`ReportBlocks` 加 `appendixFrom?: number`）
- Create: `src/lib/agent/a4/layer.ts`
- Test: `src/lib/agent/a4/layer.test.ts`

**Interfaces:**
- Consumes: `Block`、`BlockType`、`ReportBlocks`（`./blocks/schema`）
- Produces: `APPENDIX_TYPES`、`partition(blocks): {body: Block[]; appendix: Block[]}`、`bodyShare(report): number`、`layerGaps(report): string[]`、`LAYER_SYSTEM`

- [ ] **Step 1: 写会失败的测试**

```ts
// src/lib/agent/a4/layer.test.ts
import { describe, expect, it } from "vitest";
import { APPENDIX_TYPES, bodyShare, layerGaps, partition } from "./layer";
import type { Block, ReportBlocks } from "./blocks/schema";

const prose = (md: string): Block => ({ type: "prose", md });
const judgment = (): Block => ({
  type: "judgment",
  claim: "c",
  confidence: "当前更支持",
  direction: "支持",
  reasoningSummary: "r",
  upgradeCondition: "u",
  falsifyCondition: "f",
  evidenceRefs: ["E1"],
  internalValidationHooks: [],
});

const report = (blocks: Block[]): ReportBlocks =>
  ({ title: "t", confidence: "当前更支持", dataCutoff: "2026-08-26", lane: { model: "m", short: "s" }, evidencePackId: "p", blocks, evidence: [] }) as ReportBlocks;

describe("正文与附录切分", () => {
  it("校验机械那几类块进附录", () => {
    const r = partition([prose("正文"), judgment()]);
    expect(r.body.map((b) => b.type)).toEqual(["prose"]);
    expect(r.appendix.map((b) => b.type)).toEqual(["judgment"]);
  });

  it("附录那张表里有判断、证伪条件、证据台账、弃用清单、待核清单、口径", () => {
    for (const t of ["judgment", "falsify_card", "evidence_list", "evidence_usage", "unverified_panel", "caliber_map"]) {
      expect(APPENDIX_TYPES).toContain(t);
    }
  });

  it("论点、机制、关键数留在正文", () => {
    for (const t of ["verdict_banner", "prose", "kpi_cards", "layered_table", "bar_compare", "scenario_cards"]) {
      expect(APPENDIX_TYPES).not.toContain(t);
    }
  });
});

describe("正文占比", () => {
  it("正文比附录短时占比小于一半", () => {
    expect(bodyShare(report([prose("短"), judgment(), judgment()]))).toBeLessThan(0.5);
  });
});

describe("正文禁令", () => {
  it("正文里出现「答得出/答不出」要报出来", () => {
    expect(layerGaps(report([prose("这组数答得出份额，答不出价格")])).join("")).toContain("答得出");
  });

  it("口径说明在正文里出现两次以上要报出来", () => {
    const text = "口径上有两条限制。……另外口径上还要说明一句。";
    expect(layerGaps(report([prose(text)])).join("")).toContain("口径");
  });

  it("正文超过全文六成要报出来", () => {
    const long = prose("正".repeat(500));
    expect(layerGaps(report([long, judgment()])).join("")).toContain("60%");
  });

  it("拿「证据不足以判断」当维度论点要报出来", () => {
    expect(layerGaps(report([prose("论点：证据不足以判断这一维")])).join("")).toContain("证据不足");
  });
});
```

- [ ] **Step 2: 跑一遍确认它失败**

Run: `pnpm vitest run src/lib/agent/a4/layer.test.ts`
Expected: FAIL — `Failed to resolve import "./layer"`

- [ ] **Step 3: 写实现**

`schema.ts` 在 `ReportBlocks` 上加一栏（可选，所以已落库的报告照旧读得出来）：

```ts
  /**
   * 附录从第几个块开始。**正文和附录物理分离**，但仍是同一个 `blocks` 数组 ——
   * 拆成两个字段的话，判断板、章节导航、返修那三处都要各写一次「读哪一份」。
   *
   * 缺这一栏 = 这一份是分层之前写的，整份都当正文（旧报告照旧渲染）。
   */
  appendixFrom?: number;
```

`layer.ts`：

```ts
/**
 * N5 分层成稿。**正文给读者，校验机械给审计。**
 *
 * 上一版把「凭什么这么判 / 什么会推翻 / 什么会升档 / 什么内部数据能裁决」这四件事铺满
 * 正文，同一段口径限定重复三四遍 —— 内容密度不低，但同等篇幅里增量信息远少于一份普通
 * 行业分析。那套机械本身是这个产品最值钱的资产，问题只在位置。
 *
 * 所以这一步不删任何东西，只把它们收到附录：正文每节只留论点、机制、关键数，加 ≤3 行
 * 的「反证与先行指标」。
 */
export const APPENDIX_TYPES: readonly BlockType[] = [
  "evidence_list",      // 附录 A 证据台账
  "evidence_usage",     // 附录 B 弃用清单
  "unverified_panel",   // 附录 C 待核清单
  "judgment",           // 附录 D 判断强度与证伪条件总表
  "falsify_card",
  "caliber_map",        // 口径答得出/答不出那张表，正文里只留一段口径总注
  "divergence_view",
];
```

`partition` 按类型分两组，保序。`bodyShare` = 正文块的可见字数 / 全份可见字数（字数取每个块的文本栏位拼起来后去空白，`prose.md` + `heading` + 表格单元格 + 卡片文案；写一个 `textOf(block)` 私有函数，一处定死）。

`layerGaps` 四条：
1. 正文里出现 `答得出` 或 `答不出` → 报（该内容属于附录 D）；
2. 正文里 `口径` 出现在 2 个以上不同块 → 报（口径限定全文只许集中一段）；
3. `bodyShare > 0.6` → 报 `正文占全文 X%，超过 60%`；
4. 正文里出现 `证据不足` / `不足以判断` → 报（不足时论点基于 `P!` 给出并标注「此论点主要依赖先验，待核」）。

`LAYER_SYSTEM` 照 spec §N5 的 prompt 全文写，含【正文】三段结构、【附录】A–D、以及四条正文禁令。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/agent/a4/layer.test.ts src/lib/agent/a4/blocks/lint.test.ts`
Expected: PASS（两份都要绿 —— `lint.test.ts` 保证 `ReportBlocks` 加栏没打翻既有校验）

- [ ] **Step 5: 记账并提交**

changelog 加一条（`0.51.0`）：`"深研报告分两层：正文只留论点、机制、关键数和三行反证条件，凭什么这么判/什么会推翻/什么内部数据能裁决那几栏收进附录 —— 一样不少，只是不再铺满正文"`

```bash
git add src/lib/agent/a4/layer.ts src/lib/agent/a4/layer.test.ts src/lib/agent/a4/blocks/schema.ts src/lib/changelog.ts package.json && git commit -m "分层成稿：正文留论点机制关键数，校验机械收进附录"
```

---

### Task 9: §2.4 内部锚点相关性检查（anchor-gate.ts）

**Files:**
- Create: `src/lib/agent/a4/anchor-gate.ts`
- Test: `src/lib/agent/a4/anchor-gate.test.ts`

**Interfaces:**
- Consumes: `Block`（`./blocks/schema`）
- Produces: `ANCHOR_GATE_SYSTEM`、`buildAnchorGateUser({industry, anchor, propositions})`、`readAnchorVerdict(text): {pass: boolean; propositionId: string}`、`hooksOf(blocks): string[]`、`stripHooks(blocks, keep): {blocks: Block[]; removed: string[]}`

- [ ] **Step 1: 写会失败的测试**

```ts
// src/lib/agent/a4/anchor-gate.test.ts
import { describe, expect, it } from "vitest";
import { ANCHOR_GATE_SYSTEM, buildAnchorGateUser, hooksOf, readAnchorVerdict, stripHooks } from "./anchor-gate";
import type { Block } from "./blocks/schema";

const j = (hooks: string[]): Block => ({
  type: "judgment",
  claim: "c",
  confidence: "当前更支持",
  direction: "支持",
  reasoningSummary: "r",
  upgradeCondition: "u",
  falsifyCondition: "f",
  evidenceRefs: ["E1"],
  internalValidationHooks: hooks,
});

describe("锚点相关性检查", () => {
  it("只答两种话，答「能」要带命题号", () => {
    expect(readAnchorVerdict("能 + D2-P1")).toEqual({ pass: true, propositionId: "D2-P1" });
    expect(readAnchorVerdict("不能")).toEqual({ pass: false, propositionId: "" });
  });

  it("答「能」但指不出命题号，当不通过 —— 指不出来就是没有对应物", () => {
    expect(readAnchorVerdict("能")).toEqual({ pass: false, propositionId: "" });
  });

  it("提示词只问一句，明写只答两种", () => {
    expect(ANCHOR_GATE_SYSTEM).toContain("只答");
    expect(buildAnchorGateUser({ industry: "柔性 AMOLED", anchor: "AIDC 域算力资产观察", propositions: ["D2-P1 x"] })).toContain("AIDC");
  });
});

describe("摘掉没过检查的锚点", () => {
  it("留下过了检查的，摘掉别的，并说出摘了什么", () => {
    const r = stripHooks([j(["AIDC 域算力资产观察", "董办投喂通道的行业监控卡片"])], ["董办投喂通道的行业监控卡片"]);
    expect((r.blocks[0] as { internalValidationHooks: string[] }).internalValidationHooks).toEqual(["董办投喂通道的行业监控卡片"]);
    expect(r.removed).toEqual(["AIDC 域算力资产观察"]);
  });

  it("数得出这一份里全部待检的锚点，去重", () => {
    expect(hooksOf([j(["a", "b"]), j(["b"])])).toEqual(["a", "b"]);
  });

  it("不是 judgment 的块原样不动", () => {
    const blocks: Block[] = [{ type: "prose", md: "x" }];
    expect(stripHooks(blocks, []).blocks).toEqual(blocks);
  });
});
```

- [ ] **Step 2: 跑一遍确认它失败**

Run: `pnpm vitest run src/lib/agent/a4/anchor-gate.test.ts`
Expected: FAIL — `Failed to resolve import "./anchor-gate"`

- [ ] **Step 3: 写实现**

```ts
// src/lib/agent/a4/anchor-gate.ts
/**
 * 内部锚点的相关性检查（§2.4）。
 *
 * 上一版的一份面板行业报告里出现了「AIDC 域在算力与基础设施资产经营中形成的上游元器件
 * 价格观察，可用于判断这一轮物料涨价是否仍在延续」—— 那是上下文污染：内部判断链里的一条
 * 锚点被塞进了一个跟它没有交集的行业结论下面。它读起来像一条可执行的裁决路径，而顺着它
 * 去调的材料回答不了这个问题。
 *
 * 检查放在报告写完之后、出口对账里，而不是放在装上下文的时候：能不能裁决，取决于**这份
 * 报告最后落到哪几条命题上**，那件事在装上下文时还不知道。没过检查的锚点由 `stripHooks`
 * 摘掉并记在案 —— 摘掉不留痕的话，「这条判断没有内部裁决路径」和「有一条但被摘了」
 * 长得一样。
 */

export const ANCHOR_GATE_SYSTEM = `判断一条内部锚点和这次研究有没有直接交集。

**只答两种话**：
· 能 + 命题编号（例：能 + D2-P1）
· 不能

指不出具体命题编号的一律答「不能」。差一点点、间接相关、也许有帮助 —— 这几种都是「不能」。`;

export function buildAnchorGateUser(o: {
  industry: string;
  anchor: string;
  propositions: readonly string[];
}): string {
  return [
    `研究主体所处行业：${o.industry}`,
    `候选内部锚点：${o.anchor}`,
    "本研究的命题：",
    ...o.propositions.map((p) => `- ${p}`),
    "",
    "问：该锚点产生的数据能否直接裁决本研究中的某个具体命题？",
  ].join("\n");
}

/** 读那句回答。答「能」但指不出命题号的当不通过 —— 指不出来就是没有对应物。 */
export function readAnchorVerdict(text: string): { pass: boolean; propositionId: string } {
  const flat = text.replace(/\s/g, "");
  if (!flat.startsWith("能")) return { pass: false, propositionId: "" };
  const m = /(D[1-8]-P\d+)/.exec(flat);
  return m ? { pass: true, propositionId: m[1] } : { pass: false, propositionId: "" };
}
```

`hooksOf` 扫 `judgment` 块的 `internalValidationHooks` 去重；`stripHooks(blocks, keep)` 只重建 `judgment` 块的那一栏，别的块**原样返回同一个引用**（测试里 `toEqual` 也能过，但保持引用能让上游少一次无谓的重渲染）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/agent/a4/anchor-gate.test.ts`
Expected: PASS

- [ ] **Step 5: 记账并提交**

changelog 加一条（`0.51.1`）：`"内部裁决路径要先过一道相关性检查：指不出它能裁决哪一条命题的，从报告里摘掉并记在案 —— 上一版有一份面板行业报告挂上了算力资产那条锚点"`

```bash
git add src/lib/agent/a4/anchor-gate.ts src/lib/agent/a4/anchor-gate.test.ts src/lib/changelog.ts package.json && git commit -m "内部锚点先过相关性检查：指不出命题的摘掉并留痕"
```

---

### Task 10: N6 出口对账（audit.ts）

**Files:**
- Create: `src/lib/agent/a4/audit.ts`
- Test: `src/lib/agent/a4/audit.test.ts`

**Interfaces:**
- Consumes: `Violation`（`@/lib/agent/rules`）；`ReportBlocks`（`./blocks/schema`）；`SubjectCard`（`./anchor`）；`DimCoverage`、`gateOpen`（`./dims`）；`layerGaps`、`partition`（`./layer`）；`hooksOf`（`./anchor-gate`）
- Produces: `AuditInput`、`NODE_OF_RULE`、`auditExit(input): Violation[]`、`backTo(violations): string[]`、`MAX_AUDIT_ROUNDS`

七项检查对应七条规则号：`A4-N01` 立场存在性 → 打回 N5；`A4-N02` 维度覆盖 → N3；`A4-N03` 源独立性 → N4；`A4-N04` 口径纪律 → N4；`A4-N05` 落回主体 → N0/N5；`A4-N06` 锚点污染 → N4；`A4-N07` 正文自足 → N5。

- [ ] **Step 1: 写会失败的测试**

```ts
// src/lib/agent/a4/audit.test.ts
import { describe, expect, it } from "vitest";
import { DIM_IDS } from "./dims";
import { MAX_AUDIT_ROUNDS, auditExit, backTo } from "./audit";
import type { AuditInput } from "./audit";
import type { Block, ReportBlocks } from "./blocks/schema";

const banner = (text: string): Block => ({ type: "verdict_banner", text, confidence: "当前更支持", boundary: "b" });
const judgment = (hooks: string[] = []): Block => ({
  type: "judgment", claim: "c", confidence: "当前更支持", direction: "支持",
  reasoningSummary: "r", upgradeCondition: "u", falsifyCondition: "f",
  evidenceRefs: ["E1"], internalValidationHooks: hooks,
});

const ok = (): AuditInput => ({
  report: {
    title: "总量红利已用完", confidence: "当前更支持", dataCutoff: "2026-08-26",
    lane: { model: "m", short: "s" }, evidencePackId: "p",
    blocks: [banner("总量红利已用完，往后决定处境的是份额重排"), { type: "prose", md: "机制写透" }, judgment()],
    appendixFrom: 2, evidence: [],
  } as ReportBlocks,
  card: {
    subject: "维信诺", segments: [{ name: "手机面板", weight: "主体", lifecycle: "现金流" }],
    projects: [{ name: "V5 第 8.6 代线", investment: "550 亿", onlineAt: "2027", techRoute: "ViP", heavy: true }],
    customers: "国产安卓", industry: "柔性中小尺寸 AMOLED，正向 V5 第 8.6 代扩张", window: "±3 年",
  },
  coverage: DIM_IDS.map((dim) => ({ dim, independentGroups: 2 })),
  strongDims: [],
  gatedHooks: [],
  subjectVariables: ["V5 第 8.6 代线量产时点", "ViP 良率爬坡"],
});

describe("七项出口对账", () => {
  it("都过了就一条违规都没有", () => {
    expect(auditExit(ok())).toEqual([]);
  });

  it("总判断骑墙 —— A4-N01，打回 N5", () => {
    const input = ok();
    input.report.blocks[0] = banner("这一维证据不足以判断");
    const v = auditExit(input);
    expect(v[0].rule).toBe("A4-N01");
    expect(backTo(v)).toContain("N5");
  });

  it("缺一个维度 —— A4-N02，打回 N3", () => {
    const input = ok();
    input.coverage = input.coverage.filter((r) => r.dim !== "D3");
    expect(auditExit(input).some((x) => x.rule === "A4-N02")).toBe(true);
    expect(backTo(auditExit(input))).toContain("N3");
  });

  it("强判断只有一组独立来源 —— A4-N03，打回 N4", () => {
    const input = ok();
    input.coverage = input.coverage.map((r) => (r.dim === "D4" ? { ...r, independentGroups: 1 } : r));
    input.strongDims = ["D4"];
    expect(auditExit(input).some((x) => x.rule === "A4-N03")).toBe(true);
  });

  it("落回主体那一节的变量和主体卡的重项目没有交集 —— A4-N05", () => {
    const input = ok();
    input.subjectVariables = ["份额", "价格"];
    expect(auditExit(input).some((x) => x.rule === "A4-N05")).toBe(true);
  });

  it("留着没过相关性检查的内部锚点 —— A4-N06", () => {
    const input = ok();
    input.report.blocks[2] = judgment(["AIDC 域算力资产观察"]);
    expect(auditExit(input).some((x) => x.rule === "A4-N06")).toBe(true);
  });

  it("正文里铺着校验机械 —— A4-N07", () => {
    const input = ok();
    input.report.appendixFrom = 3;
    expect(auditExit(input).some((x) => x.rule === "A4-N07")).toBe(true);
  });

  it("最多打回两轮", () => {
    expect(MAX_AUDIT_ROUNDS).toBe(2);
  });
});
```

- [ ] **Step 2: 跑一遍确认它失败**

Run: `pnpm vitest run src/lib/agent/a4/audit.test.ts`
Expected: FAIL — `Failed to resolve import "./audit"`

- [ ] **Step 3: 写实现**

```ts
// src/lib/agent/a4/audit.ts
/**
 * N6 出口对账。**七项确定性检查，不问模型。**
 *
 * 每条违规带一个打回的节点号：改了正文的问题让 N5 重写，覆盖不够让 N3 再跑一波，口径与
 * 锚点的问题回 N4。**最多打回两轮**，第二轮仍不过就带缺陷清单出稿并在文首声明 —— 无上限
 * 的重修会一直修到超时，而超时的报告和缺陷报告在屏幕上都是一片空白。
 *
 * 这一层和 `gate.ts`（引用绑不绑得上、算术复不复算得通）、`blocks/lint.ts`（每个块的结构
 * 纪律）**三层并存，各管一段**：那两层问的是「这一份写得合不合规」，这一层问的是「这一轮
 * 的研究链有没有断」。混成一层的话，A4-N02 这种「某一维压根没进过检索」会被写成一条报告
 * 级违规，然后被送去让模型重写报告 —— 而它重写不出没检索过的东西。
 */
export const MAX_AUDIT_ROUNDS = 2;

/** 每条规则打回哪个节点。屏幕上和 trace 上说的是同一句。 */
export const NODE_OF_RULE: Record<string, string> = {
  "A4-N01": "N5",
  "A4-N02": "N3",
  "A4-N03": "N4",
  "A4-N04": "N4",
  "A4-N05": "N0/N5",
  "A4-N06": "N4",
  "A4-N07": "N5",
};
```

`AuditInput = { report: ReportBlocks; card: SubjectCard; coverage: DimCoverage[]; strongDims: DimId[]; gatedHooks: string[]; subjectVariables: string[] }`。

七条实现：
1. **A4-N01 立场存在性** —— `verdict_banner.text` 含 `HEDGES`（从 `draft.ts` 导出复用，别抄第二份）或含 `证据不足` / `不足以判断` → p0。
2. **A4-N02 维度覆盖** —— `gateOpen(coverage, [])` 的 `missing` 逐条转 p0。
3. **A4-N03 源独立性** —— `gateOpen(coverage, strongDims)` 比第 2 条多出来的那几条转 p0（差集，避免同一件事报两遍）。
4. **A4-N04 口径纪律** —— 复用 `research/calc.ts` 的复算结果（由 `pipeline.ts` 递进来的 `calculations`，非空即 p0），外加正文扫描：同一句里出现两个带不同统计期间标记的数（`2025 年`/`2026年第一季度` 同时出现且句中有 `+`、`-`、`占`、`倍`、`增速`）→ p1。
5. **A4-N05 落回主体** —— `card.projects.filter(p => p.heavy)` 里每个项目名与 `subjectVariables` 拼起来的字符串做 `shares()`（从 `anchor.ts` 导出复用）判交集，一个都没有 → p0。
6. **A4-N06 锚点污染** —— `hooksOf(report.blocks)` 里有不在 `gatedHooks` 的 → p0。
7. **A4-N07 正文自足** —— `layerGaps(report)` 转 p0/p1（占比与禁令那几条按 spec 都是硬的，取 p0；口径重复取 p1）。

`backTo(violations)` = 违规里出现过的节点号去重，按 `["N0/N5","N3","N4","N5"]` 排序（先重跑靠前的节点）。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/agent/a4/audit.test.ts`
Expected: PASS

- [ ] **Step 5: 记账并提交**

changelog 加一条（`0.52.0`）：`"深研出口多了七道机检：总判断有没有立场、八个维度有没有都覆盖到、强判断有没有两个独立来源、有没有跨口径算数、落回主体那一节有没有接上战略项目 —— 不过的打回对应那一步，最多两轮"`

```bash
git add src/lib/agent/a4/audit.ts src/lib/agent/a4/audit.test.ts src/lib/changelog.ts package.json && git commit -m "出口对账七项机检：不过打回对应节点，最多两轮"
```

---

### Task 11: 编排（pipeline.ts）

**Files:**
- Create: `src/lib/agent/a4/pipeline.ts`
- Test: `src/lib/agent/a4/pipeline.test.ts`

**Interfaces:**
- Consumes: 前十个任务的全部导出；`Harness`（`agent/harness.ts`）、`providers`（`research/search.ts`）、`buildEvidencePack`（`a4/prompt.ts:932`）、`gateReport` / `bindCitations` / `evidenceManifest`（`a4/gate.ts:59,160,188`）、`assembleReport` / `blocksToText`（`a4/blocks/report.ts:74,358`）、`parseBlocks`（`a4/blocks/parse.ts:56`）、`lintAssembled`（`a4/blocks/lint.ts:486`）、`readOutline` / `assembleStaged`（`a4/blocks/stages.ts:70,355`）
- Produces: `v2On(): boolean`、`runDeepResearchV2(input, opts): Promise<A4Result>`（与 `run.ts` 的 `runDeepResearch` **同签名同返回**）

**模型档位按 §4 定**（`slot` 见 `src/lib/models/slots.ts`）：N0 `pro`、N1 `alt`（最强，内容主体在这里）、N2 `pro`、N3 抽取 `seed`（便宜跑量）、N4 `alt`、N5 `alt`、N6 的两次模型调用（锚点相关性检查）`synth` —— 评审者换一个模型系。

- [ ] **Step 1: 写会失败的测试**

```ts
// src/lib/agent/a4/pipeline.test.ts
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runDeepResearchV2, v2On } from "./pipeline";

describe("开关", () => {
  afterEach(() => {
    delete process.env.TKOS_DR_V2;
  });

  it("默认不开 —— 这一版先和四链路那一支并存", () => {
    expect(v2On()).toBe(false);
  });

  it("置 1 才开", () => {
    process.env.TKOS_DR_V2 = "1";
    expect(v2On()).toBe(true);
  });
});

/** `A4Input`（`prompt.ts:43`）的真实形状：七栏都要给，`scope`/`preTake` 是可空不是可选。 */
const input = (title = "维信诺所处的行业"): A4Input => ({
  issueId: "ISS-TEST",
  title,
  scope: null,
  preTake: null,
  preOpenQuestions: [],
  docs: [],
  judgments: [],
});

describe("离线跑一整条", () => {
  beforeEach(() => {
    process.env.TKOS_MODEL_MOCK = "1";
    process.env.TKOS_DR_V2 = "1";
  });

  it("七个节点都跑到，产出的 A4Result 形状和上一版一致", async () => {
    const r = await runDeepResearchV2(input());
    expect((r.doc.sourceText ?? "").length).toBeGreaterThan(0);
    expect(r.evidencing.rounds.length).toBeGreaterThanOrEqual(1);
    expect(r.run.status).toBe("ok");
  });

  it("覆盖表进了 trace，八维一条不少", async () => {
    const r = await runDeepResearchV2(input("x"));
    const note = r.run.trace.find((n) => n.label === "覆盖表");
    expect(note).toBeDefined();
    expect(JSON.stringify(note?.detail)).toContain("D8");
  });
});
```

- [ ] **Step 2: 跑一遍确认它失败**

Run: `pnpm vitest run src/lib/agent/a4/pipeline.test.ts`
Expected: FAIL — `Failed to resolve import "./pipeline"`

- [ ] **Step 3: 写实现**

编排顺序与进度分母（七步，屏幕上那行小字照 `STEPS` 那套写法，一处定死）：

```ts
const STEPS = {
  anchor: "锚定主体",
  draft: "先写先验草稿",
  plan: "抽命题、排检索计划",
  sweep: "分维度取证",
  reconcile: "证据与草稿对账",
  layer: "分层成稿",
  audit: "出口对账",
} as const;
const STEP_TOTAL = 7;
```

每一步的处置：

| 步 | 调用 | 不过时怎么办 |
|---|---|---|
| N0 | `ANCHOR_SYSTEM` + `buildAnchorUser`，`slot: "pro"`，`maxTokens: 8000` | `cardGaps` 非空 → 重发一次带缺口清单的补正；仍不过则带缺口往下走并记 trace（HP-5） |
| N1 | `DRAFT_SYSTEM` + `buildDraftUser`，`slot: "alt"`，`maxTokens: 16000`，`json: false`，`jsonlContinue: 1` | `draftGaps` 非空 → 重发一次；仍不过带缺口往下（缺的维度会在覆盖表上以已搜未得出现） |
| N2 | `PLAN_SYSTEM` + `buildPlanUser`，`slot: "pro"`，`maxTokens: 8000` | `planGaps` 非空 → 重发一次 |
| N3 | `sweep(...)`，抽取 `slot: "seed"` | `gate.ok === false` → 不重跑，缺口进 `A4Evidencing` 和 N6 的 A4-N02 |
| N4 | `RECONCILE_SYSTEM`，`slot: "alt"`，`maxTokens: 16000`，`jsonlContinue: 1` | 矛盾态过三成 → 退回 N0 重跑一次（只一次），仍过三成则带诊断出稿 |
| N5 | `LAYER_SYSTEM`，`slot: "alt"`；分节出稿照 `run.ts:835-990` 那个循环重写一遍（**没有可复用的 `writeStaged` 函数**，能复用的只有 `blocks/stages.ts` 的 `readOutline` 和 `assembleStaged`）：大纲一次 `OUTLINE_MAX_TOKENS` → 每节各一次 `SECTION_MAX_TOKENS` → 收口一次；出块之后 `partition` 排序并写 `appendixFrom` | `layerGaps` 交给 N6 |
| N6 | `auditExit`；`hooksOf` 里每条锚点各发一次 `ANCHOR_GATE_SYSTEM`（`slot: "synth"`，`maxTokens: 500`）；没过的 `stripHooks` 摘掉 | p0 非空 → 按 `backTo` 打回，最多 `MAX_AUDIT_ROUNDS` 轮；第二轮仍不过带缺陷清单出稿，缺陷写进 `doc.sourceText` 文首 |

产出装配沿用现成的三处，一个字不改：`assembleReport` → `blocksToText` → `gateReport` → `bindCitations` → `evidenceManifest`。`A4Result` 的 `evidencing.lanes` 这一版填的是**四条维度链**（`LaneAccount.label` 写链名），`primary` 恒为第一条 —— 判断板和四节仍从这一份唯一的报告压出来，不再有主源顺位那件事。这一点要在 `pipeline.ts` 头部写清，因为 `A4Evidencing` 的注释目前说的是「除 hitsByProvider 和 lanes，其余每个数说的都是主源那一条链路」。

- [ ] **Step 4: 跑测试确认通过**

Run: `pnpm vitest run src/lib/agent/a4/pipeline.test.ts`
Expected: PASS

- [ ] **Step 5: 记账并提交**

changelog 加一条（`0.53.0`）：`"深研换成一条七步的链：锚主体 → 凭知识写草稿 → 抽命题 → 分维度取证 → 逐条对账 → 分层成稿 → 出口机检。先跟旧的四链路并存，环境变量开着才走新的"`

```bash
git add src/lib/agent/a4/pipeline.ts src/lib/agent/a4/pipeline.test.ts src/lib/changelog.ts package.json && git commit -m "深研 v2 编排：七个节点串成一条链，开关后并存"
```

---

### Task 12: 回归验收与翻默认

**Files:**
- Create: `src/lib/agent/a4/pipeline.regression.test.ts`
- Create: `docs/superpowers/plans/2026-08-26-deep-research-v2-验收记录.md`
- Modify: `src/lib/agent/a4/run.ts`（`runDeepResearch` 开头按 `v2On()` 转发到 `pipeline.ts`）
- Modify: 调用 `runDeepResearch` 的那一处（`grep -rn "runDeepResearch" src/` 定位）

**Interfaces:**
- Consumes: `runDeepResearchV2`、`v2On`
- Produces: 无新导出；`run.ts` 的 `runDeepResearch` 行为在 `TKOS_DR_V2 !== "0"` 时转发

- [ ] **Step 1: 写会失败的测试（§5.2 通用验收，可机检的那几条）**

```ts
// src/lib/agent/a4/pipeline.regression.test.ts
import { beforeEach, describe, expect, it } from "vitest";
import { DIM_IDS } from "./dims";
import { partition } from "./layer";
import { runDeepResearchV2 } from "./pipeline";
import type { A4Input } from "./prompt";

const input = (title = "维信诺所处的行业"): A4Input => ({
  issueId: "ISS-R",
  title,
  scope: null,
  preTake: null,
  preOpenQuestions: [],
  docs: [],
  judgments: [],
});

describe("§5.2 通用验收", () => {
  beforeEach(() => {
    process.env.TKOS_MODEL_MOCK = "1";
    process.env.TKOS_DR_V2 = "1";
  });

  it("八维覆盖表全绿或有记录的缺口，没有第三种状态", async () => {
    const r = await runDeepResearchV2(input());
    const table = JSON.stringify(r.run.trace.find((n) => n.label === "覆盖表")?.detail ?? {});
    for (const dim of DIM_IDS) expect(table).toContain(dim);
  });

  it("正文与附录物理分开，附录不是空的", async () => {
    const r = await runDeepResearchV2(input("x"));
    const blocks = r.doc.blocks?.blocks ?? [];
    const at = r.doc.blocks?.appendixFrom ?? blocks.length;
    expect(at).toBeLessThanOrEqual(blocks.length);
    expect(partition(blocks).appendix.length).toBeGreaterThan(0);
  });

  it("出口对账跑过，剩下的违规都带规则号", async () => {
    const r = await runDeepResearchV2(input("x"));
    for (const v of r.violations) expect(v.rule).toMatch(/^A4-/);
  });

  it("用时与证据条数进了产出 —— 跨版本要能比", async () => {
    const r = await runDeepResearchV2(input("x"));
    expect(r.evidencing.recorded).toBeGreaterThanOrEqual(0);
    // 整轮用时在 `AgentRunRecord.latencyMs`（`ResearchDoc.durationMs` 抄的就是它，
    // 见 types.ts:1152）—— `run` 上没有 `durationMs` 这一栏。
    expect(r.run.latencyMs).toBeGreaterThan(0);
  });
});
```

- [ ] **Step 2: 跑一遍确认它失败**

Run: `pnpm vitest run src/lib/agent/a4/pipeline.regression.test.ts`
Expected: FAIL — 断言上不去（`doc.blocks.appendixFrom` 还没被 `pipeline.ts` 填、或 `violations` 里还混着 `A4-B*`/`A4-G*` 的规则号）

- [ ] **Step 3: 补齐并翻默认**

1. `pipeline.ts` 里把 `appendixFrom` 真的写进 `doc.blocks`；`violations` 合并三层（`lint` + `gate` + `audit`）时保留各自规则号。
2. `run.ts` 的 `runDeepResearch` 开头加转发：

```ts
  // 深研 v2（知识先行 + 覆盖门控）。默认走它 —— 四链路那一支留在 `TKOS_DR_V2=0` 后面，
  // 是为了拿同一个议题两边各跑一遍做对比，不是为了保留一条随时会被选中的旧路。
  if (v2On()) return runDeepResearchV2(input, opts);
```

3. `v2On()` 改成默认开：`process.env.TKOS_DR_V2 !== "0"`。同步改 `pipeline.test.ts` 里那两条开关测试的预期，并在 `.env.example` / `.env.docker.example` 加一行注释说明这个开关。

- [ ] **Step 4: 跑全量测试**

Run: `pnpm vitest run`
Expected: PASS。`run.ts` 相关的既有测试若因转发而失败，改测试里的 `TKOS_DR_V2=0`，**不要**改转发逻辑。

- [ ] **Step 5: 记账、写验收记录、提交**

`docs/superpowers/plans/2026-08-26-deep-research-v2-验收记录.md` 写成一张空表，等真模型那一轮填：§5.1 的九个必出现内容点各一行（内容点 / 出现了没有 / 缺失时定位到哪个节点），加一行用时与证据条数（基线：GPT 链 4m31s/2 条有效；Claude 链 11m21s/12 条有效但单维度；v2 目标 ≤10min、≥6 维度有独立源）。

changelog 加一条（`0.54.0`）：`"深研默认走新的那条七步链；旧的四模型各跑一遍留在开关后面，只用来跟新链路对比同一个议题"`

```bash
git add -A && git commit -m "深研 v2 转正：默认走七步链，四链路退居开关后"
```

真模型那一轮由他自己发起（要 `.env.local` 里的检索 key），跑完把 §5.1 那张表填上 —— 缺哪个内容点就定位到哪个节点，别在这一轮里顺手改。

---

## 自查

**规格覆盖**：§0 六条原则 → Task 3（知识先行）、Task 4（命题前置）、Task 6（覆盖门控）、Task 5（源独立性）、Task 8（分层）、Task 3+8（立场强制）；§1 七节点 → Task 2–11；§2.1 标签体系 → Task 3；§2.2 源独立性 → Task 5+10（A4-N03）；§2.3 判断强度阶梯 → Task 8（机械收附录）；§2.4 锚点注入 → Task 9；§2.5 口径运算 → Task 10（A4-N04）；§3 各节点验收标准 → 各 Task 的 `*Gaps` 函数；§4 模型配置 → Task 11 那张表；§5.1 基准题 → Task 12 的验收记录（真模型跑，不进单测）；§5.2 通用验收 → Task 12 的机检；§5.3 模型鲁棒性 → **没有对应任务**，它要两次真模型运行才做得了，留给 Task 12 之后单独一轮；§6 接口契约 → Task 11（`A4Result` 同签名）+ Task 8（判断板从附录 D 取数，字段不变）；§7 变更摘要 → 各 Task 的文件头注释。

**留在计划外的两件事**（不是遗漏，是不该塞进这条链）：
- §5.3 模型鲁棒性测试要同一题分别用 Claude / GPT 作 N1+N4+N5 引擎各跑一遍再比对，那是两次真钱运行加一次人工比对，不该写成 vitest。
- 四链路那一支的**删除**不在这十二个任务里。Task 12 只翻默认。删代码等他拿新链路跑过几轮真议题、确认不用回头之后再单独做 —— 那时候一起清掉 `LANES`、`PRIMARY_SLOT`、`blocks/divergence.ts` 和 `sourceTabOrder` 那套页签编号。

**对着代码核过的签名**（写这份计划时逐条 grep 过，不是凭印象）：`gatherEvidence(h, search,
props, {searchK, maxRounds}, LaneRef{slot,label,substep})` → `Evidencing{ledger, rounds,
verdicts, tallies, pages}`（`a4/evidence.ts:172`）；`Ledger.entries` 是 `readonly` 属性 + 可变数组
（`research/ledger.ts:126`）；`Evidence` 上是 `siteName` 而**不是** `sourceName`（`ledger.ts:66`）；
`A4Result{doc, violations, attempts, degraded, challengeCount, challenged, evidencing, run}`
（`run.ts:429`）；十五个块类型名（`schema.ts:153-315`）与 Task 8 那张表逐一对得上；分节出稿在
`run.ts` 里是内联循环，可复用的只有 `readOutline` / `assembleStaged`。

**类型一致性**：`DimId` 在 dims/draft/plan/sweep/audit 五处是同一个导入；`Tag` 只在 `draft.ts` 定义，reconcile 和 layer 从那里引；`HEDGES` 只在 `draft.ts` 定义，`audit.ts` 的 A4-N01 引它；`shares()` 只在 `anchor.ts` 定义，`audit.ts` 的 A4-N05 引它；`Proposition` 的承重/时效阈值只在 `props.ts`，`plan.ts` 通过 `compile` 复用。`PlannedProposition.id` 的形状（`D2-P1`）同时被 `sweep.ts`、`readAnchorVerdict` 的正则、`audit.ts` 依赖 —— 改它要同时改这三处。
