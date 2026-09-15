# 预研层 v2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把预研从「一次模型写作」长成 P0–P7 七段流水，让每张提请卡都带上归一后的实体、命中的靶点、盲区裁定、外部核验过的证据、影响提案、处置建议与一次轻量批判，且全部挂在既有的 A3 链上。

**Architecture:** 预研层已经存在 —— 它就是 A3 链（`ensurePreResearch` → `runPreResearch` → `validatePreResearch`）。v2 不新开链路：P1–P7 变成 A3 链里的若干段（`Harness` 的 `step`/`substep`），每段一个纯函数文件；P0（同议题聚合）落在信号入库那一处（A1a）。所有新对象词汇集中在一个纯声明叶子 `src/lib/agent/a3/stages.ts`，`PreResearchDoc` 只加一个可选字段 `stages`。证据语义完全复用 `src/lib/research/ledger.ts` 的 `Evidence`，evidence-lite 是它的**投影**，不是第二个证据类型。

**Tech Stack:** Next.js 16.3.0 / React 19.2.8 / TypeScript 5.9.2 / vitest 4.1.10（`pnpm test` = `vitest run`）/ pnpm workspace。模型走 `src/lib/models/slots.ts` 的槽位（`pro`/`flash`/`alt`/`synth`/`seed`），离线一律 `TKOS_MODEL_MOCK=1` + `src/lib/models/mock.ts` 的罐头。

## Global Constraints

- **只维护一套 deep research harness/pipeline。** 新建文件可以，新建并行链路不行。本计划每个新东西都写明挂在哪个既有接头上：`runPreResearch`（A3 链）/ `buildAdvisorContext`（Discuss 接缝）/ `applyA1aInbox`（入库）/ `gatherEvidence`（既有取证编排）。
- **确认只能由人按下。** 这个产品里唯一一次权力转移就是他按确认那一下。任何自动确认、自动布控、自动写 `confirmed`、自动写 `armed: true` 都是硬违规。`armed: true` 的写入方是 **`api.confirmCandidate`、`api.confirmClosure`、`api.signClosure` 三处**（`store.ts` 里按符号名 grep 得到，2026-08-27 复核过 —— 本文先前写的「只有两处」漏了 `signClosure`），三处都挂在他显式点按的动作下。**本计划一处都不加。**
- **参数化知识完全放开。** 不许在任何提示词里写「不许使用你自己的知识」「只能依据给定材料」这类禁令。模型的先验要用，只是**要标出来**：先验说法打 `[P]`，证据支撑的打 `[E{n}]`。
- **检索源固定博查 + 豆包，`src/lib/research/search.ts` 一字不改。** 真 key 在隔壁仓库的 `.env`，本仓库要自己的 `.env.local`，值由用户自己粘。**本计划不出现任何真实 key，任何任务都不许读、不许打印、不许回显 key**。`providers()` 三条路（mock 档回 `[MockSearch]`、没有想要的源回 `[NoSearch]`、全被跳过回 `[NoSearch]`）**返回的表都是非空的、都不抛**；缺 key 那一档在表里的是 `NoSearch`，它一条都取不到。所以本层判「这一轮没有外部核验」一律**按入账条数**（`searchless === entries.length === 0`），不按源表空不空 —— 见 `stages.ts` 里 `searchless` 的注释。
- **既有类型只加不改**（`src/lib/data/types.ts`）：本计划对该文件只做三处增量 —— 一个 type-only import、一个可选字段 `PreResearchDoc.stages?: PreResearchStages`（Task 11）、一个可选字段 `Card.maybeSameIssue?: { issueId: string; delta: string[] }`（Task 15）。三处都是新增，**既有字段一个都不改、一个都不删**。
- **对模型的字段名一律 camelCase。** 规格正文用的 snake_case（`evidence_id` / `source_ref` / `target_ref` / `trigger_id` / `on_fire` / `expires_at` / `impact_type` / `issue_id`）在实现里全部改成 camelCase。长中文散文不塞进 JSON 字符串字段。
- **`src/lib/data/store.ts` 里的位置一律按符号名 grep，不给行号。** 行号会静默过期，过期的行号比没有更坏。
- **这四个文件此刻有并行的线在改**：`src/lib/data/store.ts`、`src/lib/agent/talk/settle.ts`、`src/lib/data/scope.ts`、`src/lib/data/client.ts`。**凡本计划要碰它们的地方，一律以议事对话层 v2 全部落库后的状态为准**，不要照本计划里印的中间态写死。
- **每个有产出的任务都要同时更新 `src/lib/changelog.ts` 与 `package.json` 的版本号**，两处必须一致（`changelog.test.ts` 会拦）。**版本号以仓库当时的现值为准，不以本文印的字面值为准** —— 这个目录上有并行的线在改同一个文件，起始版本号以议事对话层 v2 落库后的实际值为准，控制方每次派活时给出该用的号。
- **离线测试凡碰 store 的，必须在任何 import 之前设好环境变量**：`process.env.TKOS_PERSIST = "0"` 与 `process.env.TKOS_MODEL_MOCK = "1"` 作为文件里最早的可执行语句，随后只留 `import type` 与 vitest 的 import，真正的模块在 `beforeAll` 里 `await import()`。照 `src/lib/data/store.judgements.test.ts` 开头那一段的姿态。
- **不造新词。** 文档与文案用产品已有词汇（提请卡、待定区、深研、议事、靶点、盲区、布控、台账），新概念用描述性短语，不起名。
- 注释写**为什么**，不复述代码。运营台账要诚实：机检定的事不许记成模型定的。

---

## 规格字段名 ↔ 实现字段名对照

规格正文用 snake_case，本仓库的硬约束是「对模型的字段名一律 camelCase」。**规格原文不动**（那是产品文档，不是代码规约），实现里全部改名。下表是两边的对照，**下一个人拿规格对代码时照这张表看**；这不是分歧，是两种载体各守各的规约。

| 规格里的名字（§2.1–§2.4） | 实现里的名字 | 落在哪 |
| --- | --- | --- |
| `evidence_id` | `id` | `EvidenceLite.id`（Task 1/2）。沿用 `Evidence.id`，还是 `E1`/`E2`，上屏就是 `[E1]` 里那个编号 |
| `source_ref` | `sourceRef` | `EvidenceLite.sourceRef`（Task 1/2），值是 `Evidence.url` |
| `target_ref` | `targetRef` | `TargetHit.target` / `ImpactProposal.targetRef` / `TriggerProposal.targetRef`（Task 1/4/7/3） |
| `trigger_id` | `id` | `TriggerProposal.id`，`TG-` 前缀（Task 3） |
| `on_fire` | `onFire` | `TriggerProposal.onFire`（Task 3），三个值 `proposeDiscuss`/`proposeReopen`/`notify` |
| `expires_at` | `expiresAt` | `TriggerProposal.expiresAt`（Task 3），必填 |
| `impact_type` | `impactType` | `ImpactProposal.impactType`（Task 1/7） |
| `issue_id` | `issueId` | `Provenance.issueId`（Task 1）、`Card.maybeSameIssue.issueId`（Task 15） |

**规格里有、实现里没有的三个名字**（不是改名，是有意不做，见末节欠账）：`confidence`（换成机器算得出的 `tier` + `cosourceKey` 折出来的独立源组数）、向量近似分（换成 `bigramOverlap` 预筛 + 一次模型判断）、`hops` 的真值（本体图算不出时是 `null`，不填 0 冒充「很近」）。

---

## File Structure

**新建（纯函数 + 类型，全部在 `src/lib/agent/a3/` 下，跟着已有的 `run.ts` / `prompt.ts` / `validate.ts` 走）：**

| 文件 | 责任 |
| --- | --- |
| `stages.ts` | v2 全部对象词汇。**纯声明叶子**：只许 `import type`，不许有运行时导出。 |
| `provenance.ts` | `makeProvenance` 一个函数。所有产物挂来源就靠它。 |
| `evidence-lite.ts` | `Evidence` → `EvidenceLite` 的投影。 |
| `trigger.ts` | 触发器提案的构造与到期判定。 |
| `targets.ts` | P1 实体归一 + P2 靶点匹配。 |
| `blindspot.ts` | P2 盲区三判据裁定。 |
| `verify.ts` | P3 外部核验：把 `gatherEvidence` 接进预研的预算档。 |
| `impact.ts` | P4 影响提案。 |
| `dispose.ts` | P5 三动作处置建议 + Watch 触发器提案。 |
| `critic.ts` | P6 轻量批判（机检在前，异系模型在后）。 |
| `card.ts` | P7 卡片装配 + 字数/标签机检。 |
| `../a1a/delta.ts` | P0：与「可能是同一件事」那条既有议题相比，这条信号新增了什么。 |
| `../overlap.ts` | **不在 `a3/` 下**（和 `agent/rules.ts` 同一档）。只装 `bigramOverlap` 一个函数，**零 import**。A3（收窄靶点候选）与 A1a（比是不是同一件事）都从这里取 —— 放进 `a3/targets.ts` 会让 A1a 拖进整条 A3 依赖。 |

**改（每处都标了接头）：**

| 文件 | 改什么 |
| --- | --- |
| `a3/run.ts` | `A3Input` 加三个可选入参；`STEPS` 从两段长到七段；串起 P1–P7。**有 `targets` 才走 v2**，没有则保持 v1 两段行为。 |
| `a3/prompt.ts` | 加 P2/P4/P6/P7 四段的提示词与 user 拼装函数。 |
| `a3/validate.ts` | **一行不改。** 列在这里是为了说清楚：卡片那四条新机检写在 `card.ts` 的 `checkCard` 里，由 `run.ts` 把它的 `Violation[]` 并进 `validatePreResearch` 的结果，不往 `validate.ts` 里塞。 |
| `data/types.ts` | 一个 type-only import + `PreResearchDoc.stages?` + `Card.maybeSameIssue?`（Task 15）。 |
| `data/store.ts` | `ensurePreResearch` 传靶点库入参；新增 `store.triggers` 与 `store.preResearchPrev`；到期清扫；`disposeCard` 的 watch 分支把触发器提案转 `active`；`buildAdvisorContext` 的预研分支补证据索引；`noteMaybeSameIssue` 与 `attachSignalToCard`。**以议事对话层落库后的状态为准。** |
| `data/scope.ts` / `data/client.ts` | 新增只读方法 `listTriggers`。**以议事对话层落库后的状态为准。** |
| `a1a/apply.ts` | 建完议题之后多算一次「可能和哪条既有议题是同一件事」，返回里多一格可选字段（Task 15）。**已有的返回语义、路由分路、`issueFromSignal` 那一段一个字不改**，`a1a/run.ts` 也不改 —— 立案那一段的模型调用与提示词一字不动。 |
| `models/mock.ts` | 新增罐头键 `a3.targets`（Task 4）/ `a3.impact`（Task 7）/ `a3.critic`（Task 9）。**只有这三个** —— 卡片装配（P7）、盲区裁定（P2）、处置建议（P5）、「可能是同一件事」的标注（P0）全是确定性函数，一次模型都不叫，所以没有对应的罐头键。 |

**store 侧的新测试只进这两个文件，一条都不许进别处：**

| 文件 | 档 | 装什么 | 谁建的 |
| --- | --- | --- | --- |
| `src/lib/data/store.pre-research-v2.test.ts` | **live**（不设 `TKOS_MODE`，`runMode()` 默认就是 live） | Task 12 那 3 条 + 生产接头那条真测试（靶点库真喂进去、触发器提案真进表且 `status === "proposed"`）。live 档 `store.issues` / `store.cards` 都是空的，所以这些用例自己造议题 | Task 12 |
| `src/lib/data/store.pre-research-v2.demo.test.ts` | **demo**（`TKOS_MODE = "demo"`，必须在 `store.ts` 被 import 之前定下来） | Task 13 / 15 / 16 那 10 条 —— 它们要的是**种子里既有的**议题与卡（判断挂在 `issue.judgmentRefs` 上、卡上有原文），现造一条等于在测试里重写一遍种子 | Task 13，Task 15 / 16 往后追加 |

两个文件分开**不是风格问题**：`TKOS_MODE` 一个进程里定不出两档。

**别往 `src/lib/data/store.triggers.demo.test.ts` 里加。** 仓库里已经有那个文件，但它测的是「demo 档两个自动触发点都不起模型」，**不是** `store.triggers` 这张新表 —— 名字撞了，后来的人会开错文件。

---

### Task 1: 对象词汇表与 provenance

规格 §2.3 要求每个产物都能答「这是哪个议题、哪一段、哪一次会话产出的」。这一段先把 v2 的全部对象名钉死 —— 后面每个任务都从这里 import 类型，名字对不上就编译不过。

**Files:**
- Create: `src/lib/agent/a3/stages.ts`
- Create: `src/lib/agent/a3/provenance.ts`
- Test: `src/lib/agent/a3/provenance.test.ts`

**Interfaces:**
- Consumes: `SourceTier` from `@/lib/research/ledger`（`"A" | "B" | "C" | "D"`）；`Slot` from `@/lib/models/slots`（`"pro" | "flash" | "alt" | "synth" | "seed"`）。
- Produces: `stages.ts` 导出的全部类型（下面 Step 3 的代码就是完整清单）；`makeProvenance(issueId: string, sessionId?: string): Provenance`。

- [ ] **Step 1: 写失败的测试**

`src/lib/agent/a3/provenance.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { makeProvenance } from "./provenance";

describe("makeProvenance", () => {
  it("每份产物都答得出是哪个议题、哪一段", () => {
    const p = makeProvenance("I-7");
    expect(p).toEqual({ issueId: "I-7", stage: "pre_research" });
  });

  it("给了会话号就带上，没给就不留空键", () => {
    expect(makeProvenance("I-7", "S-3").sessionId).toBe("S-3");
    expect("sessionId" in makeProvenance("I-7")).toBe(false);
  });

  it("议题号是空串直接抛 —— 挂不上来源的产物不许生出来", () => {
    expect(() => makeProvenance("")).toThrow(/议题/);
  });
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm vitest run src/lib/agent/a3/provenance.test.ts`
Expected: FAIL，`Failed to resolve import "./provenance"`。

- [ ] **Step 3: 写 `stages.ts`**

```ts
/**
 * 预研层 v2 的对象词汇表。
 *
 * **这个文件是纯声明叶子** —— 只许 `import type`，不许有任何运行时导出。
 *
 * 不成环的真正原因是 `import type` 会被完全擦除，跟对面有没有运行时值无关：
 * `data/types.ts` 已经这样 type-only import 了 `a4/blocks/schema.ts`，而那个文件
 * 并**不是**纯声明叶子 —— 它导出 `CONFIDENCES`、`DIRECTIONS`、`SOURCE_TYPES`、
 * `GRADES`、`normalizeRef`、`readMeta` 一堆运行时值。所以「对面是不是叶子」从来
 * 不是那条边成不成环的理由。
 * 这里仍然额外守住「不许有运行时导出」，理由只有一条：`store.ts` import
 * `types.ts`，只要有人把这里的 `import type` 手滑写成值 import，那条边当场变成
 * 真的依赖，而擦除给的那层保护就没了 —— 没有运行时值可导，这个手滑就写不出来。
 *
 * 字段名一律 camelCase。规格正文写的是 snake_case，那是给人读的规格，
 * 不是给模型和 TypeScript 读的契约。
 */

import type { SourceTier } from "@/lib/research/ledger";
import type { Slot } from "@/lib/models/slots";

/** 每个产物都挂这一份：哪个议题、哪一段、（若有）哪次会话。 */
export type Provenance = { issueId: string; stage: "pre_research"; sessionId?: string };

/**
 * 证据的轻量档。**它是 `Evidence` 的投影，不是第二个证据类型** ——
 * 每一条都来自一条已经过了台账三道准入的 `Evidence`（七字段齐、URL 在本轮快照里、
 * 原句能在快照正文里定位）。所以这里没有「更弱的准入」，只有「更少的字段」。
 *
 * 没有 `confidence`：模型自评的置信度不可核验。可核验的那两件事是
 * `tier`（由 `tierOf` 机械算出）与 `cosourceKey`（由 `assign` 机械折叠）。
 */
export type EvidenceLite = {
  /** 沿用 `Evidence.id`（`E1`、`E2`…），上屏时就是 `[E1]` 里那个编号。 */
  id: string;
  claim: string;
  /** `Evidence.url`。 */
  sourceRef: string;
  /**
   * `Evidence.siteName` —— 站点名（「国家统计局」）。
   *
   * 它在 `Evidence` 上就是可选的（抓不到站点名的页不少），所以这里照样可选，
   * **不拿域名去补一个假的站点名**：上屏那一行取不到时退成域名，退在
   * `buildLiteIndex` 里（Task 16），不在这一格里。
   *
   * 为什么要这一格：深研那边的台账索引第三列印的是 `sourceName`
   * （`talk/prefix.ts` 的 `buildLedgerIndex`）。少了它，同一个人在两条链路上
   * 读到的第三列一个是机构名、一个是域名 —— 说是「同一套台账」就成了假话。
   */
  sourceName?: string;
  /** `Evidence.retrievedAt`。 */
  date: string;
  tier: SourceTier;
  /** `Evidence.independenceGroup` —— 同源的两条拿到同一个键。 */
  cosourceKey: string;
  provenance: Provenance;
};

export type TargetKind = "judgment" | "strategy" | "hypothesis" | "commitment";
/** 靶点：这条信号可能撞上的既有判断/战略/假设/承诺。 */
export type TargetRef = { kind: TargetKind; id: string; text: string; href?: string };

export type MatchKind = "supports" | "challenges" | "extends" | "none";
/** `hops` 是本体图上的跳数；今天算不出时是 `null`，不许填 0 冒充「很近」。 */
export type TargetHit = { target: TargetRef; match: MatchKind; why: string; hops: number | null };

export type EntityKind = "company" | "product" | "person" | "org" | "topic";
/** 归一后的实体。`aliasOf` 有值表示这个名字被并到那个规范名下。 */
export type EntityRef = { name: string; kind: EntityKind; aliasOf?: string };

export type Proximity = "in_watchlist" | "adjacent" | "far";
export type Magnitude = "material" | "immaterial" | "unknown";
/** 盲区三判据的裁定。`why` 每条一句能上屏的话。 */
export type BlindspotRuling = {
  isBlindspot: boolean;
  proximity: Proximity;
  hops: number | null;
  credibility: SourceTier | null;
  magnitude: Magnitude;
  why: string[];
};

export type TriggerSource = "watch" | "overturnCondition" | "reopenTrigger";
/**
 * 命中之后干什么。三个值全是 `propose*` / `notify` ——
 * **没有一个是「自动升级」或「自动重议」**。命中只产出一条待他处置的提案。
 */
export type TriggerOnFire = "proposeDiscuss" | "proposeReopen" | "notify";
/**
 * `proposed` 是 v2 新加的那一档，也是这一层的全部分量所在：
 * 预研只写得到 `proposed`。转 `active` 只发生在人真的按下待定那一下
 * （`api.disposeCard(cardId, "watch")`）。
 */
export type TriggerStatus = "proposed" | "active" | "fired" | "expired";
export type TriggerProposal = {
  id: string;
  condition: string;
  targetRef: TargetRef;
  source: TriggerSource;
  onFire: TriggerOnFire;
  /** 必填。没有到期日的监控会一直挂在那里，那是负债不是资产。 */
  expiresAt: string;
  status: TriggerStatus;
  provenance: Provenance;
  firedAt?: string;
};

export type ImpactType = "confirms" | "weakens" | "overturns" | "outOfScope";
export type ProposalType = "adjustJudgment" | "reopenDecision" | "newIssue" | "noAction";
/** P4 的产物。`basis` 每项是 `E{n}` 或 `[P]` 开头的先验标签。 */
export type ImpactProposal = {
  impactType: ImpactType;
  proposalType: ProposalType;
  targetRef: TargetRef | null;
  statement: string;
  basis: string[];
};

export type DispositionAction = "discuss" | "watch" | "dismiss";
/** P5 的产物。`trigger` 只在建议待定时非空，且一定是 `status: "proposed"`。 */
export type DispositionSuggestion = {
  action: DispositionAction;
  why: string;
  trigger: TriggerProposal | null;
};

/**
 * 机检报得出来的那几类。**没有「证据太旧」这一档** —— `EvidenceLite.date` 是抓取时刻，
 * 按它算天数那道检查永远不开火；证据说的是哪个时点在 `Evidence.period` 上，而它是可选的。
 * 这条记在末节的欠账里，不要往这个联合类型上加回来。
 *
 * `"overclaim"` 在 `agent/rules.ts` 里是 p1：它进这张表只为留痕，**不进返修**（见 Task 9）。
 */
export type CriticCheck = "evidenceThin" | "overclaim" | "targetMismatch";
/** `modelSlot: null` = 机检就定了，没叫模型。台账上不许把机检记成模型判的。 */
export type CriticVerdict = { pass: boolean; checks: CriticCheck[]; why: string[]; modelSlot: Slot | null };

export type CardKind = "full" | "increment";
export type CardDraft = { kind: CardKind; headline: string; body: string; basis: string[]; chars: number };

/** P0 的裁定：这条信号并进既有议题，还是自成一条。 */
export type AggregateVerdict = "merged" | "separate";

/**
 * 一次 v2 预研的全部中间产物。挂在 `PreResearchDoc.stages` 上；
 * 这个字段在不在，就是「这一份跑的是 v2 还是 v1」的答案
 * （照 `ResearchDoc.blocks` 的先例）。
 */
export type PreResearchStages = {
  entities: EntityRef[];
  hits: TargetHit[];
  blindspot: BlindspotRuling;
  evidence: EvidenceLite[];
  /**
   * 这一轮一条外部证据都没入账。为真时 `evidence` 必为空 —— 反过来也成立，
   * 这一格就是它的投影。
   *
   * 别把它读成「一个检索源都没有」：`providers()` 三条路（mock 档、无源、全跳过）
   * 返回的表都是非空的，缺 key 那一档回的是 `NoSearch`，它在表里但取不到东西。
   * 屏幕上那句「这一轮没有外部核验」为真的条件是没有证据入账，不是源表空。
   */
  searchless: boolean;
  impact: ImpactProposal;
  disposition: DispositionSuggestion;
  critic: CriticVerdict;
  card: CardDraft;
};
```

- [ ] **Step 4: 写 `provenance.ts`**

```ts
import type { Provenance } from "./stages";

/**
 * 给产物挂来源。空议题号直接抛：一份挂不上来源的产物流到下游，
 * 就再也查不出它是哪一次跑出来的了 —— 那比这一次跑失败更贵。
 */
export function makeProvenance(issueId: string, sessionId?: string): Provenance {
  if (!issueId) throw new Error("makeProvenance：议题号不能为空");
  return { issueId, stage: "pre_research", ...(sessionId ? { sessionId } : {}) };
}
```

- [ ] **Step 5: 跑测试，确认通过**

Run: `pnpm vitest run src/lib/agent/a3/provenance.test.ts`
Expected: PASS（3 个）。

- [ ] **Step 6: 记账并提交**

`src/lib/changelog.ts` 最前面加一条（版本号用控制方给的那个）：`预研层 v2 的对象词汇表落地，每份产物都挂得上来源`；`package.json` 的 `version` 改成同一个号。

```bash
git add src/lib/agent/a3/stages.ts src/lib/agent/a3/provenance.ts src/lib/agent/a3/provenance.test.ts src/lib/changelog.ts package.json
git commit -m "feat(a3): 预研层 v2 对象词汇表与 provenance"
```

---

### Task 2: evidence-lite 是 Evidence 的投影

规格 §2.1 说 evidence-lite ⊂ 完整契约。这一段把「⊂」写成一个函数：输入必须是已经过台账三道准入的 `Evidence`，输出只是它的一个投影。**不新建第二个证据类型，不新算共源哈希** —— 共源键直接用台账折叠出来的 `independenceGroup`。

**Files:**
- Create: `src/lib/agent/a3/evidence-lite.ts`
- Test: `src/lib/agent/a3/evidence-lite.test.ts`

**Interfaces:**
- Consumes: `makeProvenance` from `./provenance`；`EvidenceLite`, `Provenance` from `./stages`；`Evidence`, `Ledger` from `@/lib/research/ledger`。
- Produces:
  - `toEvidenceLite(e: Evidence, prov: Provenance): EvidenceLite`
  - `liteFromLedger(ledger: Ledger, prov: Provenance): EvidenceLite[]`
  - `independentGroupCount(list: readonly EvidenceLite[]): number`
  - **（测试侧，跨任务）** Step 1 里那个 `full(over: Partial<Evidence> = {}): Evidence` fixture ——
    **Task 16 照抄同一份**（不戴 `as Evidence`、字段名照真契约）。两处必须一字一样，
    真契约改了要一起改。

- [ ] **Step 1: 写失败的测试**

`src/lib/agent/a3/evidence-lite.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Evidence } from "@/lib/research/ledger";
import { independentGroupCount, toEvidenceLite } from "./evidence-lite";
import { makeProvenance } from "./provenance";

/*
 * 这份 fixture **不许戴 `as Evidence`**。
 *
 * 戴上它，这条测试自称「投影出规格 §2.1 那七格」就成了对一个假 `Evidence` 的投影 ——
 * 真契约哪天改了字段名，它照样绿。不戴，少一格、错一个字面量就编译不过，
 * 那才是这条测试的价值所在。字段名与字面量一律照 `src/lib/research/ledger.ts` 的
 * `EvidenceDraft` + `Evidence`：引句是 `exactQuote`（不是 `quote`），支持关系是
 * `supportRelation`（不是 `support`），没有 `publishedAt` 这一格（时点在 `period`，
 * 抓取时刻在 `retrievedAt`），`authorityClass` 里没有 `"official"`，
 * `usedAs` 只有 `"current_state" | "historical_point"`（没有 `"primary"`）。
 */
function full(over: Partial<Evidence> = {}): Evidence {
  return {
    id: "E1",
    propositionId: "P1",
    claim: "某公司 2026Q2 营收同比降 12%",
    url: "https://example.gov.cn/report/1",
    exactQuote: "同比下降 12%",
    supportRelation: "supports",
    evidenceType: "statistic",
    authorityClass: "official_statistics",
    usedAs: "current_state",
    period: "2026Q2",
    sourceDomain: "example.gov.cn",
    contentHash: "deadbeef",
    retrievedAt: "2026-08-27T02:00:00.000Z",
    sourceTier: "A",
    span: [10, 22],
    excerpt: "……同比下降 12%……",
    verificationStatus: "span_matched",
    independenceGroup: "dom:example.gov.cn",
    ...over,
  };
}

describe("toEvidenceLite", () => {
  it("投影出规格 §2.1 那几格，一格不多一格不少", () => {
    const lite = toEvidenceLite(full(), makeProvenance("I-7"));
    expect(lite).toEqual({
      id: "E1",
      claim: "某公司 2026Q2 营收同比降 12%",
      sourceRef: "https://example.gov.cn/report/1",
      date: "2026-08-27T02:00:00.000Z",
      tier: "A",
      cosourceKey: "dom:example.gov.cn",
      provenance: { issueId: "I-7", stage: "pre_research" },
    });
  });

  it("站点名有就带上，没有就不带（不拿域名冒充）", () => {
    const prov = makeProvenance("I-7");
    expect(toEvidenceLite(full({ siteName: "国家统计局" }), prov).sourceName).toBe("国家统计局");
    // `full()` 没有 `siteName` —— 这一格就不该出现，上一条 `toEqual` 也是这么钉的
    expect(toEvidenceLite(full(), prov).sourceName).toBeUndefined();
  });

  it("共源键直接用台账折出来的组号 —— 同源两条拿到同一个键", () => {
    const prov = makeProvenance("I-7");
    const a = toEvidenceLite(full({ id: "E1" }), prov);
    const b = toEvidenceLite(full({ id: "E2", url: "https://example.gov.cn/report/2" }), prov);
    expect(a.cosourceKey).toBe(b.cosourceKey);
    expect(independentGroupCount([a, b])).toBe(1);
  });

  it("不同源算两组", () => {
    const prov = makeProvenance("I-7");
    const a = toEvidenceLite(full({ id: "E1" }), prov);
    const b = toEvidenceLite(full({ id: "E2", independenceGroup: "dom:other.com" }), prov);
    expect(independentGroupCount([a, b])).toBe(2);
  });

  it("没过台账折叠的（组号是空串）不许投影出来", () => {
    expect(() => toEvidenceLite(full({ independenceGroup: "" }), makeProvenance("I-7"))).toThrow(/折叠/);
  });
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm vitest run src/lib/agent/a3/evidence-lite.test.ts`
Expected: FAIL，`Failed to resolve import "./evidence-lite"`。

- [ ] **Step 3: 写实现**

```ts
import type { Evidence, Ledger } from "@/lib/research/ledger";
import type { EvidenceLite, Provenance } from "./stages";

/**
 * `Evidence` → `EvidenceLite`。
 *
 * 入参只接**已经进了台账**的 `Evidence`（`Ledger.record` 返回非 null 的那些）——
 * 三道准入在那里已经跑过了，这里不再复查，只投影。唯一的一道自查是共源键：
 * `fold` 没跑过的条目 `independenceGroup` 是空串，那样投出去的 lite 会让
 * 「几组独立源」这个数变成谎话。
 */
export function toEvidenceLite(e: Evidence, prov: Provenance): EvidenceLite {
  if (!e.independenceGroup) {
    throw new Error(`toEvidenceLite：${e.id} 还没做过独立性折叠，共源键是空的`);
  }
  return {
    id: e.id,
    claim: e.claim,
    sourceRef: e.url,
    /*
     * 抓不到站点名就不放这一格（`Evidence.siteName` 本身可选）—— 不在这里用域名
     * 冒充站点名。上屏那一行的退法在 `buildLiteIndex` 里，一处退、一处口径。
     */
    ...(e.siteName ? { sourceName: e.siteName } : {}),
    date: e.retrievedAt,
    tier: e.sourceTier,
    cosourceKey: e.independenceGroup,
    provenance: prov,
  };
}

/** 整本台账的投影。被台账拒掉的（`ledger.rejections`）本来就不在 `entries` 里。 */
export function liteFromLedger(ledger: Ledger, prov: Provenance): EvidenceLite[] {
  return ledger.entries.map((e) => toEvidenceLite(e, prov));
}

/** 有几组独立源。判「证据够不够」的那个数就是它，不是条数。 */
export function independentGroupCount(list: readonly EvidenceLite[]): number {
  return new Set(list.map((e) => e.cosourceKey)).size;
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `pnpm vitest run src/lib/agent/a3/evidence-lite.test.ts`
Expected: PASS（5 个）。

- [ ] **Step 5: 记账并提交**

changelog 加一条：`预研的证据轻量档改成台账证据的投影，共源键复用独立性折叠`；`package.json` 同步。

```bash
git add src/lib/agent/a3/evidence-lite.ts src/lib/agent/a3/evidence-lite.test.ts src/lib/changelog.ts package.json
git commit -m "feat(a3): evidence-lite 作为台账证据的投影"
```

---

### Task 3: 触发器提案对象与到期

规格 §2.2 要的是一张统一触发器表。**规格原文写的是「自动进本表 → 自动开始监控 → 命中即触发重议」，本计划不实现那条自动路**：预研只写得到 `status: "proposed"`，`onFire` 三个值都只产出提案。转 `active` 归 Task 13（人按下待定那一下），布控（`armed: true`）仍然只归 `api.confirmCandidate`。

**Files:**
- Create: `src/lib/agent/a3/trigger.ts`
- Test: `src/lib/agent/a3/trigger.test.ts`

**Interfaces:**
- Consumes: `Provenance`, `TargetRef`, `TriggerOnFire`, `TriggerProposal`, `TriggerSource` from `./stages`。
- Produces:
  - `TRIGGER_TTL_DAYS = 90`
  - `TRIGGER_CONDITION_MAX = 80`
  - `proposeTrigger(o: { seq: number; condition: string; targetRef: TargetRef; source: TriggerSource; onFire: TriggerOnFire; nowIso: string; ttlDays?: number; provenance: Provenance }): TriggerProposal`
  - `expireTriggers(list: readonly TriggerProposal[], nowIso: string): { next: TriggerProposal[]; expired: string[] }`

- [ ] **Step 1: 写失败的测试**

`src/lib/agent/a3/trigger.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { makeProvenance } from "./provenance";
import { expireTriggers, proposeTrigger, TRIGGER_TTL_DAYS } from "./trigger";
import type { TargetRef } from "./stages";

const target: TargetRef = { kind: "judgment", id: "J-2", text: "这个市场今年不会有新玩家", href: "/judgments/J-2" };
const prov = makeProvenance("I-7");

describe("proposeTrigger", () => {
  it("预研只写得到 proposed —— 一条都不布控", () => {
    const t = proposeTrigger({
      seq: 1, condition: "该公司公开发布同类产品", targetRef: target,
      source: "watch", onFire: "proposeDiscuss", nowIso: "2026-08-27T00:00:00.000Z", provenance: prov,
    });
    expect(t.status).toBe("proposed");
    expect(t.id).toBe("TG-I-7-1");
    expect(t.onFire).toBe("proposeDiscuss");
  });

  it("到期日必填，默认 90 天", () => {
    const t = proposeTrigger({
      seq: 1, condition: "该公司公开发布同类产品", targetRef: target,
      source: "watch", onFire: "notify", nowIso: "2026-08-27T00:00:00.000Z", provenance: prov,
    });
    expect(TRIGGER_TTL_DAYS).toBe(90);
    expect(t.expiresAt).toBe("2026-11-25T00:00:00.000Z");
  });

  it("条件是空串或超长直接抛 —— 核不了的监控条件等于没有", () => {
    const base = { seq: 1, targetRef: target, source: "watch", onFire: "notify", nowIso: "2026-08-27T00:00:00.000Z", provenance: prov } as const;
    expect(() => proposeTrigger({ ...base, condition: "  " })).toThrow(/条件/);
    expect(() => proposeTrigger({ ...base, condition: "长".repeat(81) })).toThrow(/条件/);
  });
});

describe("expireTriggers", () => {
  const t = proposeTrigger({
    seq: 1, condition: "该公司公开发布同类产品", targetRef: target,
    source: "watch", onFire: "proposeDiscuss", nowIso: "2026-08-27T00:00:00.000Z", provenance: prov,
  });

  it("过了到期日的转 expired，并报出是哪几条", () => {
    const r = expireTriggers([{ ...t, status: "active" }], "2026-12-01T00:00:00.000Z");
    expect(r.next[0].status).toBe("expired");
    expect(r.expired).toEqual(["TG-I-7-1"]);
  });

  it("没到期的原样留着", () => {
    const r = expireTriggers([{ ...t, status: "active" }], "2026-09-01T00:00:00.000Z");
    expect(r.next[0].status).toBe("active");
    expect(r.expired).toEqual([]);
  });

  it("已经开过火的不再改 —— fired 是终态", () => {
    const r = expireTriggers([{ ...t, status: "fired", firedAt: "2026-09-01T00:00:00.000Z" }], "2026-12-01T00:00:00.000Z");
    expect(r.next[0].status).toBe("fired");
    expect(r.expired).toEqual([]);
  });
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm vitest run src/lib/agent/a3/trigger.test.ts`
Expected: FAIL，`Failed to resolve import "./trigger"`。

- [ ] **Step 3: 写实现**

```ts
import type { Provenance, TargetRef, TriggerOnFire, TriggerProposal, TriggerSource } from "./stages";

/**
 * 监控条件的默认存活期。90 天不是拍的：一条 90 天都没命中的监控条件，
 * 要么当初的判断已经不成立，要么这个条件核不出来 —— 两种都该让他重新看一眼，
 * 而不是让它无声地挂在表上。
 */
export const TRIGGER_TTL_DAYS = 90;

/** 条件要上屏，也要能被人一眼核对「这句话算不算命中」。80 字约两行。 */
export const TRIGGER_CONDITION_MAX = 80;

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * 造一条触发器**提案**。
 *
 * 名字里那个「提案」是全部要点：这个函数的返回值 `status` 恒为 `proposed`，
 * 没有参数能改它。转 `active` 只发生在人按下待定那一下（`api.disposeCard` 的
 * watch 分支），布控（`ReopenTrigger.armed`）仍然只发生在他按确认那一下。
 */
export function proposeTrigger(o: {
  seq: number;
  condition: string;
  targetRef: TargetRef;
  source: TriggerSource;
  onFire: TriggerOnFire;
  nowIso: string;
  ttlDays?: number;
  provenance: Provenance;
}): TriggerProposal {
  const condition = o.condition.trim();
  if (!condition || condition.length > TRIGGER_CONDITION_MAX) {
    throw new Error(`proposeTrigger：监控条件要 1–${TRIGGER_CONDITION_MAX} 字，当前 ${condition.length} 字`);
  }
  const expiresAt = new Date(new Date(o.nowIso).getTime() + (o.ttlDays ?? TRIGGER_TTL_DAYS) * DAY_MS).toISOString();
  return {
    id: `TG-${o.provenance.issueId}-${o.seq}`,
    condition,
    targetRef: o.targetRef,
    source: o.source,
    onFire: o.onFire,
    expiresAt,
    status: "proposed",
    provenance: o.provenance,
  };
}

/**
 * 到期清扫。`fired` 是终态不动它 —— 已经开过火的那条是账，不是待办。
 * `expired` 里回的是被清掉的编号，调用方要拿它上屏（清扫也要记账）。
 */
export function expireTriggers(
  list: readonly TriggerProposal[],
  nowIso: string,
): { next: TriggerProposal[]; expired: string[] } {
  const now = new Date(nowIso).getTime();
  const expired: string[] = [];
  const next = list.map((t) => {
    if (t.status === "fired" || t.status === "expired") return t;
    if (new Date(t.expiresAt).getTime() > now) return t;
    expired.push(t.id);
    return { ...t, status: "expired" as const };
  });
  return { next, expired };
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `pnpm vitest run src/lib/agent/a3/trigger.test.ts`
Expected: PASS（6 个）。

- [ ] **Step 5: 记账并提交**

changelog 加一条：`预研的监控条件改成提案：只写得到待他处置那一档，到期会自己清`；`package.json` 同步。

```bash
git add src/lib/agent/a3/trigger.ts src/lib/agent/a3/trigger.test.ts src/lib/changelog.ts package.json
git commit -m "feat(a3): 触发器提案对象与到期清扫"
```

---

### Task 4: P1 实体归一 + P2 靶点匹配

规格 P1 要把信号里的名字归一，P2 要把它对到既有判断/战略/假设/承诺上。规格建议用向量检索做召回；**本仓库没有 embedding 客户端，`search.ts` 也一字不改**，所以召回退成确定性的字符二元组重叠预筛，再由模型在收窄后的候选里判匹配方向。这一段用**一次**模型调用同时产出实体、命中与量级估计 —— 三件事看的是同一段材料，分三次调用是白花钱。

**Files:**
- Create: `src/lib/agent/overlap.ts` —— **只装 `bigramOverlap` 一个函数，零 import。**
- Create: `src/lib/agent/a3/targets.ts`
- Modify: `src/lib/agent/a3/prompt.ts`
- Modify: `src/lib/models/mock.ts`
- Test: `src/lib/agent/a3/targets.test.ts`

**为什么 `bigramOverlap` 不住在 `targets.ts` 里**：Task 15 的 `a1a/delta.ts` 也要用它（同一件事不重写第二份）。而 `a3/targets.ts` 顶上挂着 `Harness` 与 `a3/prompt.ts`，A1a 从那里 import 会让 A1a 的模块图上多出**整条 A3 依赖**。所以这个函数从一开始就住在 `src/lib/agent/overlap.ts` —— 和 `agent/rules.ts` 同一档的位置，零 import 的叶子，两边都从那里取。新建叶子文件是允许的（硬约束只禁新开并行链路）。

**Interfaces:**
- Consumes: `Harness` from `@/lib/agent/harness`（用到 `callMessages`、`note`、`substep`）；`parseJson` from `@/lib/agent/json`；`bigramOverlap` from `@/lib/agent/overlap`；`EntityRef`, `Magnitude`, `MatchKind`, `TargetHit`, `TargetRef` from `./stages`。
- Produces:
  - `overlap.ts` 导出 `bigramOverlap(a: string, b: string): number` —— **跨任务**：Task 5（`blindspot.ts`）与 Task 15（`a1a/delta.ts`）都从 `@/lib/agent/overlap` 取它，不从 `a3/targets` 取。
  - `NARROW_K = 12`、`ALIAS_MIN = 0.72`
  - `normalizeEntities(raw: readonly EntityRef[]): EntityRef[]`
  - `narrowTargets(entities: readonly EntityRef[], all: readonly TargetRef[], k?: number): TargetRef[]`
  - `matchTargets(h: Harness, o: { signalText: string; entities: readonly string[]; targets: readonly TargetRef[]; hopsOf?: (t: TargetRef) => number | null }): Promise<{ entities: EntityRef[]; hits: TargetHit[]; magnitude: Magnitude }>`
  - `prompt.ts` 新增 `A3_TARGETS_SYSTEM: string` 与 `buildA3TargetsUser(o: { signalText: string; entities: readonly string[]; targets: readonly TargetRef[] }): string`
  - `mock.ts` 新增罐头键 `a3.targets`

- [ ] **Step 1: 写失败的测试**

`src/lib/agent/a3/targets.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Harness } from "@/lib/agent/harness";
import { bigramOverlap } from "@/lib/agent/overlap";
import type { EntityRef, TargetRef } from "./stages";
import { matchTargets, narrowTargets, normalizeEntities } from "./targets";

const targets: TargetRef[] = [
  { kind: "judgment", id: "J-2", text: "国内做 agent 编排的公司今年不会有新玩家" },
  { kind: "strategy", id: "S-1", text: "把渠道压在一线城市的代理商上" },
  { kind: "hypothesis", id: "H-4", text: "客户愿意为可核验的证据链多付钱" },
];

/** 只用到 callMessages / note / substep 三格，其余不碰 —— 这一段是纯装配。 */
function stubHarness(reply: unknown): Harness {
  return {
    async callMessages() { return { text: JSON.stringify(reply) }; },
    note() {},
    substep() {},
  } as unknown as Harness;
}

// `bigramOverlap` 住在 `@/lib/agent/overlap`，但它这一轮的两个消费方
// （`normalizeEntities` / `narrowTargets`）都在这个文件里，所以覆盖也放这里 ——
// 单开一个只有两条断言的测试文件，读的人得开两个文件才看得完这一件事。
describe("bigramOverlap", () => {
  it("同一个名字是 1，毫不相干是 0", () => {
    expect(bigramOverlap("智谱 AI", "智谱 AI")).toBe(1);
    expect(bigramOverlap("智谱", "渠道")).toBe(0);
  });

  it("一个字的名字也不炸（没有二元组时退化成整串比对）", () => {
    expect(bigramOverlap("A", "A")).toBe(1);
    expect(bigramOverlap("A", "B")).toBe(0);
  });
});

describe("normalizeEntities", () => {
  it("重名的并成一条", () => {
    const raw: EntityRef[] = [
      { name: "智谱 AI", kind: "company" },
      { name: "智谱 AI", kind: "company" },
    ];
    expect(normalizeEntities(raw)).toEqual([{ name: "智谱 AI", kind: "company" }]);
  });

  it("写法接近的并到先出现的那个名字下，并留下 aliasOf", () => {
    const raw: EntityRef[] = [
      { name: "智谱 AI", kind: "company" },
      { name: "智谱AI", kind: "company" },
    ];
    const out = normalizeEntities(raw);
    expect(out).toEqual([
      { name: "智谱 AI", kind: "company" },
      { name: "智谱AI", kind: "company", aliasOf: "智谱 AI" },
    ]);
  });

  it("不同类的不并 —— 同名的产品和公司是两件事", () => {
    const out = normalizeEntities([
      { name: "谛听", kind: "company" },
      { name: "谛听", kind: "product" },
    ]);
    expect(out).toHaveLength(2);
    expect(out[1].aliasOf).toBeUndefined();
  });
});

describe("narrowTargets", () => {
  it("按重叠度排序，重叠为 0 的不进候选", () => {
    const out = narrowTargets([{ name: "agent 编排", kind: "topic" }], targets);
    expect(out.map((t) => t.id)).toEqual(["J-2"]);
  });

  it("k 是硬上限", () => {
    const many: TargetRef[] = Array.from({ length: 20 }, (_, i) => ({
      kind: "judgment" as const, id: `J-${i}`, text: "agent 编排这件事",
    }));
    expect(narrowTargets([{ name: "agent 编排", kind: "topic" }], many, 5)).toHaveLength(5);
  });
});

describe("matchTargets", () => {
  it("把模型判的方向对回靶点，量级也带回来", async () => {
    const h = stubHarness({
      entities: [{ name: "智谱 AI", kind: "company" }],
      hits: [{ targetId: "J-2", match: "challenges", why: "这条信号里那家公司正是新玩家" }],
      magnitude: "material",
    });
    const r = await matchTargets(h, { signalText: "某公司发布了 agent 编排产品", entities: ["智谱 AI"], targets });
    expect(r.entities).toEqual([{ name: "智谱 AI", kind: "company" }]);
    expect(r.hits).toEqual([
      { target: targets[0], match: "challenges", why: "这条信号里那家公司正是新玩家", hops: null },
    ]);
    expect(r.magnitude).toBe("material");
  });

  it("模型报了个不存在的靶点编号就丢掉，不许凭空造靶点", async () => {
    const h = stubHarness({
      entities: [], hits: [{ targetId: "J-999", match: "supports", why: "编的" }], magnitude: "unknown",
    });
    const r = await matchTargets(h, { signalText: "x", entities: [], targets });
    expect(r.hits).toEqual([]);
  });

  it("match 不在四个合法值里就当没命中", async () => {
    const h = stubHarness({
      entities: [], hits: [{ targetId: "J-2", match: "maybe", why: "说不清" }], magnitude: "unknown",
    });
    const r = await matchTargets(h, { signalText: "x", entities: [], targets });
    expect(r.hits).toEqual([]);
  });

  it("模型回的不是合法 JSON —— 空手回来，不抛", async () => {
    const h = { async callMessages() { return { text: "不是 JSON" }; }, note() {}, substep() {} } as unknown as Harness;
    const r = await matchTargets(h, { signalText: "x", entities: [], targets });
    expect(r).toEqual({ entities: [], hits: [], magnitude: "unknown" });
  });

  it("跳数由调用方给 —— 给得出就带上", async () => {
    const h = stubHarness({
      entities: [], hits: [{ targetId: "J-2", match: "extends", why: "同一条线往下走" }], magnitude: "immaterial",
    });
    const r = await matchTargets(h, { signalText: "x", entities: [], targets, hopsOf: () => 1 });
    expect(r.hits[0].hops).toBe(1);
  });
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm vitest run src/lib/agent/a3/targets.test.ts`
Expected: FAIL，`Failed to resolve import "./targets"`。

- [ ] **Step 3: 写 `src/lib/agent/overlap.ts`**

```ts
/**
 * 字符二元组重叠。**这个文件零 import，是有意的。**
 *
 * 两条链路要用同一个算法：A3 拿它收窄靶点候选（`a3/targets.ts`），
 * A1a 拿它比「这条新信号和那条既有议题说的是不是同一件事」（`a1a/delta.ts`）。
 * 住在 `a3/targets.ts` 里的话，A1a 会顺着它把 `Harness` 与 `a3/prompt.ts`
 * 整条 A3 依赖拖进自己的模块图 —— 那不是共用一个算法该付的代价。
 */

function bigrams(s: string): Set<string> {
  const t = s.replace(/\s+/g, "").toLowerCase();
  const out = new Set<string>();
  for (let i = 0; i + 1 < t.length; i++) out.add(t.slice(i, i + 2));
  return out;
}

/**
 * 字符二元组的 Jaccard 重叠。中文没有词边界，二元组是不引入分词器的最省办法。
 * 一个字的名字取不出二元组，退化成整串相等 —— 否则「A」和「B」会算成 1。
 */
export function bigramOverlap(a: string, b: string): number {
  const x = bigrams(a);
  const y = bigrams(b);
  if (x.size === 0 || y.size === 0) return a.replace(/\s+/g, "").toLowerCase() === b.replace(/\s+/g, "").toLowerCase() ? 1 : 0;
  let inter = 0;
  for (const g of x) if (y.has(g)) inter++;
  return inter / (x.size + y.size - inter);
}
```

- [ ] **Step 4: 写 `targets.ts`**

```ts
import type { Harness } from "@/lib/agent/harness";
import { parseJson } from "@/lib/agent/json";
import { bigramOverlap } from "@/lib/agent/overlap";
import { A3_TARGETS_SYSTEM, buildA3TargetsUser } from "./prompt";
import type { EntityRef, Magnitude, MatchKind, TargetHit, TargetRef } from "./stages";

/**
 * 送进模型的靶点候选上限。规格建议用向量检索做召回，本仓库没有 embedding 客户端，
 * 也不动 `search.ts`，所以召回退成字符二元组重叠预筛 —— 它会漏掉换了说法的同义靶点，
 * 这是明账上的退让，不是当它不存在。12 条大约是模型一次能认真读完的量。
 */
export const NARROW_K = 12;

/** 两个名字重叠到这个程度就当同一个实体的不同写法。 */
export const ALIAS_MIN = 0.72;

const MATCHES: readonly MatchKind[] = ["supports", "challenges", "extends", "none"];
const MAGNITUDES: readonly Magnitude[] = ["material", "immaterial", "unknown"];

/**
 * 实体归一。**先出现的那个名字当规范名** —— 不挑「更正式」的那个，因为挑不出
 * 客观标准，而顺序是确定的。归并只在同 `kind` 内做：同名的公司和产品是两件事。
 * 被并掉的那条不删，留着并标 `aliasOf`：他要看得见系统把哪两个名字当成了一个。
 */
export function normalizeEntities(raw: readonly EntityRef[]): EntityRef[] {
  const out: EntityRef[] = [];
  for (const e of raw) {
    const name = e.name.trim();
    if (!name) continue;
    if (out.some((o) => o.name === name && o.kind === e.kind)) continue;
    const canon = out.find((o) => o.kind === e.kind && !o.aliasOf && bigramOverlap(o.name, name) >= ALIAS_MIN);
    out.push({ name, kind: e.kind, ...(canon ? { aliasOf: canon.name } : {}) });
  }
  return out;
}

/** 按与实体名的最大重叠度收窄靶点候选。重叠为 0 的不进候选。 */
export function narrowTargets(
  entities: readonly EntityRef[],
  all: readonly TargetRef[],
  k: number = NARROW_K,
): TargetRef[] {
  return all
    .map((t) => ({ t, score: Math.max(0, ...entities.map((e) => bigramOverlap(e.name, t.text))) }))
    .filter((x) => x.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((x) => x.t);
}

/**
 * P1 + P2 一次调用：归一实体、判匹配方向、估量级。
 *
 * 三件事看的是同一段材料，分三次调用是白花钱。形状读不懂就空手回来（不抛）——
 * 预研是自动跑的，一次形状异常不该让整张提请卡消失；下游的盲区裁定看到空命中
 * 会如实记成「这一轮对不上任何靶点」。
 */
export async function matchTargets(
  h: Harness,
  o: {
    signalText: string;
    entities: readonly string[];
    targets: readonly TargetRef[];
    hopsOf?: (t: TargetRef) => number | null;
  },
): Promise<{ entities: EntityRef[]; hits: TargetHit[]; magnitude: Magnitude }> {
  const r = await h.callMessages(
    "模型调用 · a3.targets",
    [
      { role: "system", content: A3_TARGETS_SYSTEM },
      { role: "user", content: buildA3TargetsUser(o) },
    ],
    { slot: "flash", maxTokens: 2000 },
    { promptKey: "a3.targets", targetCount: o.targets.length },
    "a3.targets",
  );

  let parsed: unknown;
  try {
    parsed = parseJson<unknown>(r.text);
  } catch {
    h.note("靶点匹配返回读不懂", { note: "不是合法 JSON，这一轮当作对不上任何靶点" });
    return { entities: [], hits: [], magnitude: "unknown" };
  }
  if (typeof parsed !== "object" || parsed === null) {
    h.note("靶点匹配返回读不懂", { got: typeof parsed });
    return { entities: [], hits: [], magnitude: "unknown" };
  }
  const obj = parsed as Record<string, unknown>;

  const rawEntities = Array.isArray(obj.entities) ? obj.entities : [];
  const entities = normalizeEntities(
    rawEntities.flatMap((x) => {
      if (typeof x !== "object" || x === null) return [];
      const e = x as Record<string, unknown>;
      if (typeof e.name !== "string") return [];
      const kind = e.kind;
      const ok = kind === "company" || kind === "product" || kind === "person" || kind === "org" || kind === "topic";
      return [{ name: e.name, kind: ok ? kind : ("topic" as const) }];
    }),
  );

  const byId = new Map(o.targets.map((t) => [t.id, t]));
  const hops = o.hopsOf ?? (() => null);
  const hits: TargetHit[] = [];
  const rawHits = Array.isArray(obj.hits) ? obj.hits : [];
  for (const x of rawHits) {
    if (typeof x !== "object" || x === null) continue;
    const hit = x as Record<string, unknown>;
    const target = typeof hit.targetId === "string" ? byId.get(hit.targetId) : undefined;
    if (!target) {
      h.note("靶点匹配报了不存在的编号", { targetId: String(hit.targetId), note: "丢掉 —— 不许凭空造靶点" });
      continue;
    }
    const match = hit.match;
    if (typeof match !== "string" || !MATCHES.includes(match as MatchKind) || match === "none") continue;
    hits.push({
      target,
      match: match as MatchKind,
      why: typeof hit.why === "string" ? hit.why : "",
      hops: hops(target),
    });
  }

  const magnitude = MAGNITUDES.includes(obj.magnitude as Magnitude) ? (obj.magnitude as Magnitude) : "unknown";
  return { entities, hits, magnitude };
}
```

- [ ] **Step 5: 在 `prompt.ts` 末尾加提示词**

```ts
/**
 * P1 + P2 的提示词。
 *
 * **你的先验知识要用**：认得出这家公司是谁、这个产品属于哪一类，就直接用 ——
 * 这是模型最值钱的那部分能力。要求只有一条：先验得出的说法在 `why` 里以「[P]」开头，
 * 好让下游分得清「这是模型知道的」和「这是材料里写的」。
 */
export const A3_TARGETS_SYSTEM = `你在给一条新信号找它撞上了公司里的哪些既有判断。

做三件事：
1. 列出这条信号里出现的实体（公司/产品/人/机构/话题），同一个东西的不同写法各列一条。
2. 在给定的靶点清单里，找出这条信号真的撞上的那几条，并说清方向：
   - supports：这条信号让那个判断更站得住
   - challenges：这条信号动摇那个判断
   - extends：不推翻，但把那个判断的适用范围往外推了一截
   清单上没有的编号一个都不许写。对不上就交空数组，交空数组不是失败。
3. 估这条信号的量级：material（够大，值得他花时间）/ immaterial（不值得）/ unknown（材料不足以判断）。

你自己的知识可以用，而且应该用。凡是靠你自己的知识（不是材料里写的）得出的话，
在 why 里以「[P]」开头。

## 输出格式

只输出一个 JSON 对象：
- \`entities\`：数组，每项 \`{ "name": 字符串, "kind": "company"|"product"|"person"|"org"|"topic" }\`
- \`hits\`：数组，每项 \`{ "targetId": 字符串, "match": "supports"|"challenges"|"extends", "why": 一句能上屏的话 }\`
- \`magnitude\`：\`"material"\`|\`"immaterial"\`|\`"unknown"\``;

/** 靶点清单以编号 + 正文的形式给出 —— 模型只回编号，回正文的话对不回来。 */
export function buildA3TargetsUser(o: {
  signalText: string;
  entities: readonly string[];
  targets: readonly { kind: string; id: string; text: string }[];
}): string {
  const kindLabel: Record<string, string> = {
    judgment: "判断", strategy: "战略", hypothesis: "假设", commitment: "承诺",
  };
  return `## 这条信号
${o.signalText}

## 已经抠出来的名字（可能不全，你可以补）
${o.entities.length ? o.entities.map((e) => `- ${e}`).join("\n") : "（一个都没抠出来）"}

## 靶点清单
${o.targets.length
  ? o.targets.map((t) => `- ${t.id}｜${kindLabel[t.kind] ?? t.kind}｜${t.text}`).join("\n")
  : "（清单是空的 —— 那就交空的 hits）"}`;
}
```

- [ ] **Step 6: 在 `mock.ts` 的 `CANNED` 里加罐头**

```ts
  "a3.targets": {
    entities: [{ name: "智谱 AI", kind: "company" }],
    hits: [{ targetId: "J-2", match: "challenges", why: "[P] 这家公司做的正是那条判断里说不会出现的新玩家" }],
    magnitude: "material",
  },
```

- [ ] **Step 7: 跑测试，确认通过**

Run: `pnpm vitest run src/lib/agent/a3/targets.test.ts`
Expected: PASS（12 个）。

- [ ] **Step 8: 记账并提交**

changelog 加一条：`预研会先把信号里的名字归一，再对到既有判断、战略、假设、承诺上`；`package.json` 同步。

```bash
git add src/lib/agent/overlap.ts src/lib/agent/a3/targets.ts src/lib/agent/a3/targets.test.ts src/lib/agent/a3/prompt.ts src/lib/models/mock.ts src/lib/changelog.ts package.json
git commit -m "feat(a3): P1 实体归一与 P2 靶点匹配"
```

---

### Task 5: P2 盲区三判据

规格 P2 要按接近度、可信度、量级三条判「这是不是盲区」。这三条**全部机械可判**，所以这一段一次模型都不调 —— 判据由机器定，理由由机器写出来给他读。

**Files:**
- Create: `src/lib/agent/a3/blindspot.ts`
- Test: `src/lib/agent/a3/blindspot.test.ts`

**Interfaces:**
- Consumes: `SourceTier` from `@/lib/research/ledger`；`bigramOverlap` from `@/lib/agent/overlap`（**不是** `./targets`，见 Task 4）；`ALIAS_MIN` from `./targets`；`BlindspotRuling`, `EntityRef`, `EvidenceLite`, `Magnitude`, `Proximity`, `TargetHit` from `./stages`。
- Produces:
  - `TIER_FLOOR: SourceTier = "B"`、`PROXIMITY_MAX_HOPS = 2`
  - `tierAtLeast(t: SourceTier | null, floor: SourceTier): boolean`
  - `bestTier(list: readonly EvidenceLite[]): SourceTier | null` —— **跨任务**：Task 10 的 `assembleCard` 取最高档一律用这个，不许自己再写一份 `reduce`。
  - `ruleBlindspot(o: { entities: readonly EntityRef[]; hits: readonly TargetHit[]; evidence: readonly EvidenceLite[]; watched: readonly string[]; magnitude: Magnitude }): BlindspotRuling`

- [ ] **Step 1: 写失败的测试**

`src/lib/agent/a3/blindspot.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { EntityRef, EvidenceLite, TargetHit } from "./stages";
import { bestTier, ruleBlindspot, tierAtLeast } from "./blindspot";

const entities: EntityRef[] = [{ name: "智谱 AI", kind: "company" }];
const hit: TargetHit = {
  target: { kind: "judgment", id: "J-2", text: "今年不会有新玩家" },
  match: "challenges", why: "正是新玩家", hops: 1,
};
function ev(tier: EvidenceLite["tier"], id = "E1"): EvidenceLite {
  return {
    id, claim: "c", sourceRef: "https://a.gov.cn/x", date: "2026-08-27T00:00:00.000Z",
    tier, cosourceKey: `dom:${id}`, provenance: { issueId: "I-7", stage: "pre_research" },
  };
}

describe("tierAtLeast / bestTier", () => {
  it("A 比 B 高，D 垫底", () => {
    expect(tierAtLeast("A", "B")).toBe(true);
    expect(tierAtLeast("B", "B")).toBe(true);
    expect(tierAtLeast("C", "B")).toBe(false);
    expect(tierAtLeast(null, "B")).toBe(false);
  });

  it("取台账里最高的那一档；空台账是 null，不是 D", () => {
    expect(bestTier([ev("C"), ev("A", "E2")])).toBe("A");
    expect(bestTier([])).toBeNull();
  });
});

describe("ruleBlindspot", () => {
  it("已经在看的东西不是盲区 —— 它是已知", () => {
    const r = ruleBlindspot({ entities, hits: [hit], evidence: [ev("A")], watched: ["智谱 AI"], magnitude: "material" });
    expect(r.proximity).toBe("in_watchlist");
    expect(r.isBlindspot).toBe(false);
    expect(r.why.join("")).toContain("已经在看");
  });

  it("挨着我们在看的东西、可信、量级够 —— 这才是盲区", () => {
    const r = ruleBlindspot({ entities, hits: [hit], evidence: [ev("A")], watched: ["渠道代理商"], magnitude: "material" });
    expect(r).toEqual({
      isBlindspot: true, proximity: "adjacent", hops: 1, credibility: "A", magnitude: "material",
      why: [
        "撞上了 J-2（challenges），本体图上 1 跳",
        "台账里最高一档是 A 档，到得了 B 档这条线",
        "量级够大，值得他花时间",
      ],
    });
  });

  it("一条靶点都对不上就是太远 —— 不判盲区", () => {
    const r = ruleBlindspot({ entities, hits: [], evidence: [ev("A")], watched: [], magnitude: "material" });
    expect(r.proximity).toBe("far");
    expect(r.isBlindspot).toBe(false);
    expect(r.hops).toBeNull();
  });

  it("源不到 B 档不判盲区，而且要说清是差在哪", () => {
    const r = ruleBlindspot({ entities, hits: [hit], evidence: [ev("C")], watched: [], magnitude: "material" });
    expect(r.isBlindspot).toBe(false);
    expect(r.credibility).toBe("C");
    expect(r.why.join("")).toContain("C 档");
  });

  it("一条外部证据都没有时如实写「这一轮没有外部证据」，不冒充可信", () => {
    const r = ruleBlindspot({ entities, hits: [hit], evidence: [], watched: [], magnitude: "material" });
    expect(r.credibility).toBeNull();
    expect(r.isBlindspot).toBe(false);
    expect(r.why.join("")).toContain("没有外部证据");
  });

  it("量级不明不判盲区", () => {
    const r = ruleBlindspot({ entities, hits: [hit], evidence: [ev("A")], watched: [], magnitude: "unknown" });
    expect(r.isBlindspot).toBe(false);
    expect(r.magnitude).toBe("unknown");
  });

  it("跳数算不出来（null）也能判 —— 只是理由里说清算不出", () => {
    const r = ruleBlindspot({
      entities, hits: [{ ...hit, hops: null }], evidence: [ev("B")], watched: [], magnitude: "material",
    });
    expect(r.isBlindspot).toBe(true);
    expect(r.hops).toBeNull();
    expect(r.why[0]).toBe("撞上了 J-2（challenges），本体图上的跳数这一轮算不出来");
  });
});
```

**这里原来还有一条 `it("门槛是 B 档", () => expect(TIER_FLOOR).toBe("B"))`，已经删掉，不许加回来。**
常量对自己断言验不到任何行为 —— 把 `TIER_FLOOR` 改成 `"C"` 再把断言同步改成 `"C"` 就绿了。
`TIER_FLOOR` 的行为在上面那 9 条里已经有覆盖（「源不到 B 档不判盲区」那条走的就是它）。
同理 Task 7 的 `expect(MIN_INDEPENDENT_SOURCES).toBe(2)` 也删了。

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm vitest run src/lib/agent/a3/blindspot.test.ts`
Expected: FAIL，`Failed to resolve import "./blindspot"`。

- [ ] **Step 3: 写实现**

```ts
import type { SourceTier } from "@/lib/research/ledger";
import { bigramOverlap } from "@/lib/agent/overlap";
import { ALIAS_MIN } from "./targets";
import type { BlindspotRuling, EntityRef, EvidenceLite, Magnitude, Proximity, TargetHit } from "./stages";

/**
 * 盲区要过的最低源档。B 档以下（C 是二手转述、D 是溯不到源）撑不起
 * 「这件事他没在看但该看」这句话 —— 那句话一旦说出口就要花掉他的注意力。
 */
export const TIER_FLOOR: SourceTier = "B";

/**
 * 「挨着」的最大跳数。本体图上的跳数今天算不出来（GraphKnowledge 只答得出
 * 成员归属，答不出跳数），所以 `hops` 常常是 `null` —— 那时接近度退回靶点命中
 * 这一条判据。这个常量留着，等图那边给得出跳数时它就是那道门槛。
 */
export const PROXIMITY_MAX_HOPS = 2;

const ORDER: Record<SourceTier, number> = { A: 3, B: 2, C: 1, D: 0 };

export function tierAtLeast(t: SourceTier | null, floor: SourceTier): boolean {
  return t !== null && ORDER[t] >= ORDER[floor];
}

/** 台账里最高的那一档。**空台账回 `null` 而不是 `"D"`** —— 没有和最差是两件事。 */
export function bestTier(list: readonly EvidenceLite[]): SourceTier | null {
  let best: SourceTier | null = null;
  for (const e of list) if (!best || ORDER[e.tier] > ORDER[best]) best = e.tier;
  return best;
}

/**
 * 盲区三判据。三条全部机械可判，所以这一段一次模型都不调。
 *
 * 「已经在看」不是盲区，这一点容易写反：盲区的定义是**近、可信、够大，而他没在看**。
 * 已经在监控清单上的东西命中了，那是监控正常工作，不是发现盲区。
 */
export function ruleBlindspot(o: {
  entities: readonly EntityRef[];
  hits: readonly TargetHit[];
  evidence: readonly EvidenceLite[];
  /** 他此刻在看的东西（`sensorTargets()` 的文本 + 监控焦点）。 */
  watched: readonly string[];
  magnitude: Magnitude;
}): BlindspotRuling {
  const why: string[] = [];

  const watchedHit = o.entities.find((e) =>
    o.watched.some((w) => bigramOverlap(e.name, w) >= ALIAS_MIN),
  );
  const nearest = o.hits.find((x) => x.hops !== null) ?? o.hits[0];

  let proximity: Proximity;
  if (watchedHit) {
    proximity = "in_watchlist";
    why.push(`「${watchedHit.name}」已经在看了 —— 这是监控命中，不是盲区`);
  } else if (nearest) {
    proximity = "adjacent";
    why.push(
      nearest.hops === null
        ? `撞上了 ${nearest.target.id}（${nearest.match}），本体图上的跳数这一轮算不出来`
        : `撞上了 ${nearest.target.id}（${nearest.match}），本体图上 ${nearest.hops} 跳`,
    );
  } else {
    proximity = "far";
    why.push("一条既有判断都对不上 —— 离他现在关心的事太远");
  }

  const credibility = bestTier(o.evidence);
  if (credibility === null) why.push("这一轮没有外部证据可依");
  else if (tierAtLeast(credibility, TIER_FLOOR)) why.push(`台账里最高一档是 ${credibility} 档，到得了 ${TIER_FLOOR} 档这条线`);
  else why.push(`台账里最高一档只有 ${credibility} 档，撑不起一句「他该看这个」`);

  if (o.magnitude === "material") why.push("量级够大，值得他花时间");
  else if (o.magnitude === "immaterial") why.push("量级不够，不值得占他的时间");
  else why.push("材料不足以判断量级");

  return {
    isBlindspot: proximity === "adjacent" && tierAtLeast(credibility, TIER_FLOOR) && o.magnitude === "material",
    proximity,
    hops: nearest?.hops ?? null,
    credibility,
    magnitude: o.magnitude,
    why,
  };
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `pnpm vitest run src/lib/agent/a3/blindspot.test.ts`
Expected: PASS（9 个）。

- [ ] **Step 5: 记账并提交**

changelog 加一条：`预研按接近度、可信度、量级三条机械判盲区，判不出就如实说判不出`；`package.json` 同步。

```bash
git add src/lib/agent/a3/blindspot.ts src/lib/agent/a3/blindspot.test.ts src/lib/changelog.ts package.json
git commit -m "feat(a3): P2 盲区三判据"
```

---

### Task 6: P3 外部核验接进既有取证编排

规格 P3 要外部核验。**这一段不写新的检索/抓取/入账代码** —— 它把已有的那一套（`providers()` → `searchAll` → `fetchPages` → `Ledger` → `assign` 折叠）按预研的预算档调一次，编排函数就是深研在用的 `gatherEvidence`。`search.ts` 一字不改。

**`searchless` 是入账条数的投影，不是源表空不空的投影。** `providers()` 三条路（mock 档回 `[MockSearch]`、没有想要的源回 `[NoSearch]`、全被跳过回 `[NoSearch]`）**返回的表都非空**，`search.ts` 自己的注释就写着「`list.length` 永远 ≥1」—— 所以这一层没有「一个检索源都没有」这条分支可走，写一个也是死代码。缺 key 那一档在表里的是 `NoSearch`，它一条都取不到，最终 `evidence` 仍是空；而离线档（`MockSearch` → `mockPage` → `CANNED["a4.extract"]`）这条链是通的，**真的会有证据入账**。屏幕上那句「这一轮没有外部核验」为真的条件只有一个：这一轮一条外部证据都没入账。

**Files:**
- Create: `src/lib/agent/a3/verify.ts`
- Test: `src/lib/agent/a3/verify.test.ts`

**Interfaces:**
- Consumes: `Harness` from `@/lib/agent/harness`；`providers` from `@/lib/research/search`；`gatherEvidence` from `@/lib/agent/a4/evidence`；`compile` from `@/lib/agent/a4/props`；`liteFromLedger`, `independentGroupCount` from `./evidence-lite`；`BlindspotRuling`, `EntityRef`, `EvidenceLite`, `Provenance`, `TargetHit` from `./stages`。
- Produces:
  - `BUDGET_HIT = { searchK: 6, maxRounds: 2, maxProps: 3 }`、`BUDGET_MISS = { searchK: 2, maxRounds: 1, maxProps: 1 }`
  - `pickBudget(o: { hits: readonly TargetHit[]; blindspot: BlindspotRuling }): typeof BUDGET_HIT | typeof BUDGET_MISS`
  - `buildPropositions(o: { question: string; entities: readonly EntityRef[]; hits: readonly TargetHit[] }): { propositions: unknown[] }`
  - `verifyExternally(h: Harness, o: { question: string; entities: readonly EntityRef[]; hits: readonly TargetHit[]; blindspot: BlindspotRuling; provenance: Provenance }): Promise<{ evidence: EvidenceLite[]; searchless: boolean; groups: number }>`
  - **跨任务口径**：`searchless === (evidence.length === 0)`，恒成立。Task 1 的字段注释、Task 10 的卡片措辞、Task 11 与 Task 17 的断言全按这一条 —— 谁要那一档，就在**那个测试文件里**打 `@/lib/research/search` 的桩，不打桩的离线跑一定有证据入账。

- [ ] **Step 1: 写失败的测试**

`src/lib/agent/a3/verify.test.ts`：

```ts
/*
 * 这一段不碰 store，但要碰模型与检索：`TKOS_MODEL_MOCK=1` 让抓取返回签过名的
 * 假页面、让模型走罐头。测试里既不读也不打印任何 key。
 *
 * **「一条外部证据都没入账」这一档必须打桩造出来，靠离线跑是造不出来的。**
 * 离线档下 `providers()` 回的是 `[MockSearch]`，而 `MockSearch` → `mockPage` →
 * `CANNED["a4.extract"]` 这条链是通的 —— 不打桩地跑，台账里一定有条目，
 * 这条测试断言的就成了它的反面。所以这里桩掉**测试侧**的 `providers()`：
 * `src/lib/research/search.ts` 一字未动（硬约束），改的只是这个文件看到的它。
 *
 * 桩里那支检索家就是缺 key 那一档在表里的东西：`name: "none"`、搜什么都回空数组。
 * 现搭一个而不是 `new NoSearch()`，因为 `NoSearch` 那个类在 `search.ts` 里
 * **没有导出**（导出它就是「改那个文件」）。
 */
process.env.TKOS_MODEL_MOCK = "1";

import { describe, expect, it, vi } from "vitest";
import type { Harness } from "@/lib/agent/harness";
import type { SearchProvider } from "@/lib/research/search";
import type { BlindspotRuling, TargetHit } from "./stages";
import { BUDGET_HIT, BUDGET_MISS, buildPropositions, pickBudget, verifyExternally } from "./verify";
import { makeProvenance } from "./provenance";

vi.mock("@/lib/research/search", async () => {
  const actual = await vi.importActual<typeof import("@/lib/research/search")>("@/lib/research/search");
  const none: SearchProvider = {
    name: "none",
    label: "未启用",
    windowed: false,
    reason: "测试桩：这一档表里有源，但一条都取不到",
    async search() {
      return [];
    },
  };
  return { ...actual, providers: () => ({ list: [none], skipped: [] }) };
});

const hit: TargetHit = {
  target: { kind: "judgment", id: "J-2", text: "今年不会有新玩家" },
  match: "challenges", why: "正是新玩家", hops: 1,
};
const notBlind: BlindspotRuling = {
  isBlindspot: false, proximity: "far", hops: null, credibility: null, magnitude: "unknown", why: [],
};

describe("pickBudget", () => {
  it("撞上靶点就给足预算", () => {
    expect(pickBudget({ hits: [hit], blindspot: notBlind })).toBe(BUDGET_HIT);
  });

  it("判成盲区也给足预算", () => {
    expect(pickBudget({ hits: [], blindspot: { ...notBlind, isBlindspot: true } })).toBe(BUDGET_HIT);
  });

  it("既没撞上也不是盲区就给最省的那一档", () => {
    expect(pickBudget({ hits: [], blindspot: notBlind })).toBe(BUDGET_MISS);
  });
});

describe("buildPropositions", () => {
  it("从问题与命中机械造命题 —— 不为了造命题再调一次模型", () => {
    const raw = buildPropositions({
      question: "这家公司做的是不是同类产品？",
      entities: [{ name: "智谱 AI", kind: "company" }],
      hits: [hit],
    });
    const props = raw.propositions as Record<string, unknown>[];
    expect(props[0].statement).toBe("今年不会有新玩家");
    expect(props[0].queries).toContain("智谱 AI 今年不会有新玩家");
    expect(props[props.length - 1].statement).toBe("这家公司做的是不是同类产品？");
    expect(props.every((p) => Array.isArray(p.counterQueries) && (p.counterQueries as string[]).length > 0)).toBe(true);
  });

  it("一条命中都没有时也至少有一条命题（就是那个问题本身）", () => {
    const raw = buildPropositions({ question: "值不值得看？", entities: [], hits: [] });
    expect((raw.propositions as unknown[]).length).toBe(1);
  });
});

describe("verifyExternally", () => {
  it("一条外部证据都没入账时如实回 searchless，一条证据都不编", async () => {
    const notes: string[] = [];
    const h = {
      note(label: string) { notes.push(label); },
      substep() {},
      async callMessages() { return { text: "{}" }; },
    } as unknown as Harness;

    const r = await verifyExternally(h, {
      question: "值不值得看？", entities: [], hits: [], blindspot: notBlind, provenance: makeProvenance("I-7"),
    });
    expect(r).toEqual({ evidence: [], searchless: true, groups: 0 });
    expect(notes.some((n) => n.includes("没有一条外部证据入账"))).toBe(true);
  });
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm vitest run src/lib/agent/a3/verify.test.ts`
Expected: FAIL，`Failed to resolve import "./verify"`。

- [ ] **Step 3: 写实现**

```ts
import type { Harness } from "@/lib/agent/harness";
import { providers } from "@/lib/research/search";
import { gatherEvidence } from "@/lib/agent/a4/evidence";
import { compile } from "@/lib/agent/a4/props";
import { independentGroupCount, liteFromLedger } from "./evidence-lite";
import type { BlindspotRuling, EntityRef, EvidenceLite, Provenance, TargetHit } from "./stages";

/**
 * 两档预算。预研是自动跑的、一天可能跑几十次，所以它的默认档必须很省；
 * 只有「撞上了既有判断」或「判成盲区」这两种情形值得多花 ——
 * 那两种情形下这条信号已经在跟他的判断打架了。
 */
export const BUDGET_HIT = { searchK: 6, maxRounds: 2, maxProps: 3 } as const;
export const BUDGET_MISS = { searchK: 2, maxRounds: 1, maxProps: 1 } as const;

export function pickBudget(o: {
  hits: readonly TargetHit[];
  blindspot: BlindspotRuling;
}): typeof BUDGET_HIT | typeof BUDGET_MISS {
  return o.hits.length > 0 || o.blindspot.isBlindspot ? BUDGET_HIT : BUDGET_MISS;
}

/**
 * 机械地造检索命题。
 *
 * 深研那条链是让模型写命题的（`a4.propose`）；预研这一档不再付那一次调用 ——
 * 要核的东西已经在手上了：每条命中的靶点原文各是一条命题，加上这一轮预研要回答的
 * 那个问题。命题的形状交给 `compile` 收口，字段名与深研共用一套。
 *
 * **字段名必须是 `compile` 真认的那两个：`materialityWeight` 与 `freshnessUrgency`，
 * 而且值是分数不是布尔。** `compile` 读的是 `RawProp`（模型交上来的形状），阈值判定
 * 在它里面：`materialityWeight >= 0.7` 才算实质命题，`freshnessUrgency >= 0.7` 才算
 * 时效紧。`material` / `freshnessUrgent` 是它**产出**上的名字，写进入参会被静默丢弃 ——
 * 不报错、不红任何断言，只是这里的意图一个字都传不进去。`extraRoundsCap` 同理：
 * 那一格由 `compile` 自己按 `material` 算（实质给两轮、其余一轮），传了也不认。
 */
export function buildPropositions(o: {
  question: string;
  entities: readonly EntityRef[];
  hits: readonly TargetHit[];
}): { propositions: unknown[] } {
  const names = o.entities.filter((e) => !e.aliasOf).map((e) => e.name);
  const q = (text: string) => (names.length ? names.map((n) => `${n} ${text}`) : [text]);
  const propositions = [
    ...o.hits.map((x) => ({
      statement: x.target.text,
      requiredEvidence: "能核到出处的公开报道或官方披露",
      queries: q(x.target.text),
      counterQueries: q(`${x.target.text} 反例`),
      // 撞上既有判断的那几条本来就是重大且时效紧的 —— 1 稳过 compile 的 0.7 两道线。
      materialityWeight: 1,
      freshnessUrgency: 1,
    })),
    {
      statement: o.question,
      requiredEvidence: "能核到出处的公开报道或官方披露",
      queries: q(o.question),
      counterQueries: q(`${o.question} 反例`),
      materialityWeight: 1,
      freshnessUrgency: 1,
    },
  ];
  return { propositions };
}

/**
 * P3 外部核验。
 *
 * **这里没有一行新的检索/抓取/入账代码** —— 编排整个借深研那条链在用的
 * `gatherEvidence`：它自己做「URL 白名单只认本轮检索返回的」「截断在前哈希在后」
 * 「原句要能在快照里定位」「全量重折叠独立性」。预研与深研在证据这件事上
 * 因此**不可能出现两套标准**。
 *
 * `searchless` 在收尾时按入账条数算，**不看源表空不空**：`providers()` 三条路回的表
 * 都非空（`search.ts` 自己写着「`list.length` 永远 ≥1」），所以「一个源都没有」
 * 这条分支在生产上不存在，写一个就是死代码加一段假注释。缺 key 那一档在表里的是
 * `NoSearch`，它取不到东西，最终一样是零入账。上屏时他看到「这一份没有外部核验」，
 * 而这句话为真的条件正是零入账。
 */
export async function verifyExternally(
  h: Harness,
  o: {
    question: string;
    entities: readonly EntityRef[];
    hits: readonly TargetHit[];
    blindspot: BlindspotRuling;
    provenance: Provenance;
  },
): Promise<{ evidence: EvidenceLite[]; searchless: boolean; groups: number }> {
  const { list, skipped } = providers();
  const budget = pickBudget(o);
  const props = compile(buildPropositions(o), budget.maxProps);
  const got = await gatherEvidence(
    h,
    list,
    props,
    { searchK: budget.searchK, maxRounds: budget.maxRounds },
    { slot: "flash", label: "预研核验", substep: (suffix) => h.substep(`预研核验 · ${suffix}`) },
  );

  const evidence = liteFromLedger(got.ledger, o.provenance);
  const searchless = evidence.length === 0;
  if (searchless) {
    // 零入账有两种来路，台账上要分得出来：一条都没搜到，和抽了几条全被拒。
    // 只记「没有外部核验」的话，这两种在记录里长得一模一样，而它们说明的事完全不同
    // （前者是这题搜不到，后者是抽取在编）。
    h.note("这一轮没有一条外部证据入账", {
      被拒条数: got.ledger.rejections.length,
      跳过的检索源: skipped.join("、"),
    });
  }
  return { evidence, searchless, groups: independentGroupCount(evidence) };
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `pnpm vitest run src/lib/agent/a3/verify.test.ts`
Expected: PASS（6 个）。

- [ ] **Step 5: 记账并提交**

changelog 加一条：`预研的外部核验直接借深研那套取证编排，一条证据都没入账就如实说这一轮没核验`；`package.json` 同步。（**措辞按 `searchless` 的真口径写**：是「没入账」，不是「没有检索源」—— 源表在生产上从来不空。）

```bash
git add src/lib/agent/a3/verify.ts src/lib/agent/a3/verify.test.ts src/lib/changelog.ts package.json
git commit -m "feat(a3): P3 外部核验接进既有取证编排"
```

---

### Task 7: P4 影响提案

规格 P4 要回答「这件事对我们意味着什么」，并且**只提提案不改状态**（§2.4 禁写不禁言）。这一段调一次中高档模型，返回的形状与依据都要机检：依据里引的编号必须在这一轮的证据里真在，说到「推翻」必须有两组以上独立源，否则机械降档 —— 降档这件事要写进理由，不许悄悄降。

**Files:**
- Create: `src/lib/agent/a3/impact.ts`
- Modify: `src/lib/agent/a3/prompt.ts`
- Modify: `src/lib/models/mock.ts`
- Test: `src/lib/agent/a3/impact.test.ts`

**Interfaces:**
- Consumes: `Harness` from `@/lib/agent/harness`；`parseJson` from `@/lib/agent/json`；`independentGroupCount` from `./evidence-lite`；`EvidenceLite`, `ImpactProposal`, `ImpactType`, `ProposalType`, `TargetHit` from `./stages`。
- Produces:
  - `MIN_INDEPENDENT_SOURCES = 2`
  - `proposeImpact(h: Harness, o: { question: string; material: string; hits: readonly TargetHit[]; evidence: readonly EvidenceLite[]; searchless: boolean }): Promise<{ impact: ImpactProposal; downgraded: boolean }>`
  - `prompt.ts` 新增 `A3_IMPACT_SYSTEM: string` 与 `buildA3ImpactUser(o: { question: string; material: string; hits: readonly TargetHit[]; evidence: readonly EvidenceLite[]; searchless: boolean }): string`
  - `mock.ts` 新增罐头键 `a3.impact`

- [ ] **Step 1: 写失败的测试**

`src/lib/agent/a3/impact.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Harness } from "@/lib/agent/harness";
import type { EvidenceLite, TargetHit } from "./stages";
import { proposeImpact } from "./impact";

const hit: TargetHit = {
  target: { kind: "judgment", id: "J-2", text: "今年不会有新玩家" },
  match: "challenges", why: "正是新玩家", hops: 1,
};
function ev(id: string, group: string): EvidenceLite {
  return {
    id, claim: `${id} 的说法`, sourceRef: `https://a.com/${id}`, date: "2026-08-27T00:00:00.000Z",
    tier: "A", cosourceKey: group, provenance: { issueId: "I-7", stage: "pre_research" },
  };
}
function stub(reply: unknown, notes: string[] = []): Harness {
  return {
    async callMessages() { return { text: JSON.stringify(reply) }; },
    note(label: string) { notes.push(label); },
    substep() {},
  } as unknown as Harness;
}
const base = { question: "值不值得看？", material: "某公司发布了同类产品", hits: [hit], searchless: false };

describe("proposeImpact", () => {
  it("两组独立源撑得起「推翻」，靶点对回既有那一条", async () => {
    const h = stub({
      impactType: "overturns", proposalType: "reopenDecision", targetId: "J-2",
      statement: "那条判断的前提已经不成立", basis: ["E1", "E2"],
    });
    const r = await proposeImpact(h, { ...base, evidence: [ev("E1", "dom:a"), ev("E2", "dom:b")] });
    expect(r.downgraded).toBe(false);
    expect(r.impact).toEqual({
      impactType: "overturns", proposalType: "reopenDecision", targetRef: hit.target,
      statement: "那条判断的前提已经不成立", basis: ["E1", "E2"],
    });
  });

  it("只有一组独立源时机械把「推翻」降成「削弱」，并把降档写进理由", async () => {
    const notes: string[] = [];
    const h = stub({
      impactType: "overturns", proposalType: "reopenDecision", targetId: "J-2",
      statement: "那条判断的前提已经不成立", basis: ["E1", "E2"],
    }, notes);
    const r = await proposeImpact(h, { ...base, evidence: [ev("E1", "dom:a"), ev("E2", "dom:a")] });
    expect(r.downgraded).toBe(true);
    expect(r.impact.impactType).toBe("weakens");
    expect(r.impact.proposalType).toBe("adjustJudgment");
    expect(notes.some((n) => n.includes("降档"))).toBe(true);
  });

  it("引了台账里没有的编号就摘掉那一条依据", async () => {
    const h = stub({
      impactType: "weakens", proposalType: "adjustJudgment", targetId: "J-2",
      statement: "那条判断要收窄适用范围", basis: ["E1", "E9", "[P] 这类产品通常先做海外"],
    });
    const r = await proposeImpact(h, { ...base, evidence: [ev("E1", "dom:a")] });
    expect(r.impact.basis).toEqual(["E1", "[P] 这类产品通常先做海外"]);
  });

  it("先验依据（[P] 打头）留着 —— 模型自己的知识是要用的，只是要标出来", async () => {
    const h = stub({
      impactType: "confirms", proposalType: "noAction", targetId: null,
      statement: "跟原判断一致", basis: ["[P] 这家公司三年没进过这个市场"],
    });
    const r = await proposeImpact(h, { ...base, evidence: [], searchless: true });
    expect(r.impact.basis).toEqual(["[P] 这家公司三年没进过这个市场"]);
  });

  it("一条依据都不剩时提案退成不动作，不许留一句没依据的重议提案", async () => {
    const h = stub({
      impactType: "overturns", proposalType: "reopenDecision", targetId: "J-2",
      statement: "推翻它", basis: ["E9"],
    });
    const r = await proposeImpact(h, { ...base, evidence: [] });
    expect(r.impact.proposalType).toBe("noAction");
    expect(r.impact.impactType).toBe("outOfScope");
    expect(r.impact.basis).toEqual([]);
  });

  it("枚举外的值一律退成不动作", async () => {
    const h = stub({ impactType: "kaboom", proposalType: "doItNow", targetId: "J-2", statement: "x", basis: [] });
    const r = await proposeImpact(h, { ...base, evidence: [ev("E1", "dom:a")] });
    expect(r.impact.impactType).toBe("outOfScope");
    expect(r.impact.proposalType).toBe("noAction");
  });

  it("返回不是合法 JSON 时空手回来，不抛", async () => {
    const h = { async callMessages() { return { text: "呃" }; }, note() {}, substep() {} } as unknown as Harness;
    const r = await proposeImpact(h, { ...base, evidence: [] });
    expect(r.impact.proposalType).toBe("noAction");
    expect(r.impact.statement).toContain("读不懂");
  });
});
```

**这里原来还有一条 `it("独立源门槛沿用 Part1 §2.2 的两组", () => expect(MIN_INDEPENDENT_SOURCES).toBe(2))`，已经删掉，不许加回来。**
理由同 Task 5 删掉的那条：常量对自己断言，把常量改成 3 再把断言同步改成 3 就绿，验不到任何行为。
`MIN_INDEPENDENT_SOURCES` 的行为在上面那两条「两组撑得起推翻」/「一组就降档」里已经有覆盖。

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm vitest run src/lib/agent/a3/impact.test.ts`
Expected: FAIL，`Failed to resolve import "./impact"`。

- [ ] **Step 3: 写 `impact.ts`**

```ts
import type { Harness } from "@/lib/agent/harness";
import { parseJson } from "@/lib/agent/json";
import { independentGroupCount } from "./evidence-lite";
import { A3_IMPACT_SYSTEM, buildA3ImpactUser } from "./prompt";
import type { EvidenceLite, ImpactProposal, ImpactType, ProposalType, TargetHit } from "./stages";

/**
 * 说得出「推翻」要几组独立源。
 *
 * 两组 —— **沿用 Part1 §2.2「强判断 ≥2 独立源」这条已经在跑的线**
 * （`talk/verifier.ts` 的机检第二道就是这个数），不在预研这一层自己加严：
 * 同一件事在产品里有两个门槛，比门槛低更糟。
 */
export const MIN_INDEPENDENT_SOURCES = 2;

const IMPACTS: readonly ImpactType[] = ["confirms", "weakens", "overturns", "outOfScope"];
const PROPOSALS: readonly ProposalType[] = ["adjustJudgment", "reopenDecision", "newIssue", "noAction"];

/** 读不懂或撑不起时退到这一档：如实说不动作。 */
function noAction(statement: string): ImpactProposal {
  return { impactType: "outOfScope", proposalType: "noAction", targetRef: null, statement, basis: [] };
}

/**
 * P4 影响提案。**只提提案，不改任何状态** —— 这个函数不写库，返回值交给上层装进卡片。
 *
 * 两道机检：依据里引的证据编号必须在这一轮台账里真在（`[P]` 打头的先验依据不查，
 * 因为它本来就不指向证据）；说到「推翻」必须有两组以上独立源，不够就机械降成「削弱」
 * 并留痕 —— 降档不许悄悄发生，他要看得见「系统把模型的话降了一档」。
 */
export async function proposeImpact(
  h: Harness,
  o: {
    question: string;
    material: string;
    hits: readonly TargetHit[];
    evidence: readonly EvidenceLite[];
    searchless: boolean;
  },
): Promise<{ impact: ImpactProposal; downgraded: boolean }> {
  const r = await h.callMessages(
    "模型调用 · a3.impact",
    [
      { role: "system", content: A3_IMPACT_SYSTEM },
      { role: "user", content: buildA3ImpactUser(o) },
    ],
    { slot: "pro", maxTokens: 2000 },
    { promptKey: "a3.impact", evidenceCount: o.evidence.length, searchless: o.searchless },
    "a3.impact",
  );

  let parsed: unknown;
  try {
    parsed = parseJson<unknown>(r.text);
  } catch {
    h.note("影响提案返回读不懂", { note: "不是合法 JSON" });
    return { impact: noAction("这一轮的影响提案读不懂，按不动作处理"), downgraded: false };
  }
  if (typeof parsed !== "object" || parsed === null) {
    return { impact: noAction("这一轮的影响提案读不懂，按不动作处理"), downgraded: false };
  }
  const obj = parsed as Record<string, unknown>;

  const statement = typeof obj.statement === "string" ? obj.statement : "";
  const ids = new Set(o.evidence.map((e) => e.id));
  const rawBasis = Array.isArray(obj.basis) ? obj.basis.filter((x): x is string => typeof x === "string") : [];
  const basis = rawBasis.filter((b) => b.startsWith("[P]") || ids.has(b));
  if (basis.length < rawBasis.length) {
    h.note("影响提案引了台账里没有的编号", {
      dropped: rawBasis.filter((b) => !basis.includes(b)),
      note: "摘掉那几条依据 —— 编号是编的，说法就不算有依据",
    });
  }

  let impactType = IMPACTS.includes(obj.impactType as ImpactType) ? (obj.impactType as ImpactType) : null;
  let proposalType = PROPOSALS.includes(obj.proposalType as ProposalType) ? (obj.proposalType as ProposalType) : null;
  if (!impactType || !proposalType || basis.length === 0 || !statement) {
    return { impact: noAction(statement || "这一轮拿不出有依据的影响提案，按不动作处理"), downgraded: false };
  }

  let downgraded = false;
  if (impactType === "overturns" && independentGroupCount(o.evidence) < MIN_INDEPENDENT_SOURCES) {
    h.note("影响提案降档", {
      from: "overturns",
      to: "weakens",
      groups: independentGroupCount(o.evidence),
      note: `说到推翻要 ${MIN_INDEPENDENT_SOURCES} 组独立源，这一轮不够`,
    });
    impactType = "weakens";
    proposalType = "adjustJudgment";
    downgraded = true;
  }

  const targetRef =
    typeof obj.targetId === "string" ? (o.hits.find((x) => x.target.id === obj.targetId)?.target ?? null) : null;

  return { impact: { impactType, proposalType, targetRef, statement, basis }, downgraded };
}
```

- [ ] **Step 4: 在 `prompt.ts` 末尾加提示词**

```ts
/**
 * P4 的提示词。
 *
 * 两句话是这段提示词的全部分量：**只提提案，不宣布结果**（这一层写不了任何状态，
 * 写了也不生效，说得像已经生效只会骗到读它的人）；**你自己的判断力要用**，
 * 靠先验得出的依据以「[P]」开头写进 basis。
 */
export const A3_IMPACT_SYSTEM = `你在判断一条新信号对公司既有判断意味着什么。

先定影响的性质（impactType）：
- confirms：证实了既有判断
- weakens：削弱了既有判断，但没到推翻
- overturns：既有判断的前提已经不成立
- outOfScope：跟既有判断没关系

再定要提的提案（proposalType）：
- adjustJudgment：那条判断要改口径或收窄适用范围
- reopenDecision：那条已经做完的决定要重新议
- newIssue：这是一件新的事，该单独立一条议题
- noAction：不值得动作

两条硬规矩：
1. 你提的是**提案**，不是结果。不许写「已确认」「已调整」「公司据此」这类话 ——
   这一层改不了任何状态，唯一能改的人是一号位，而他还没看到这条。
2. 每条依据都要指得出来：引证据就写它的编号（E1、E2…，只能引下面台账里真有的）；
   靠你自己的知识得出的，那一条以「[P]」开头写清是什么知识。
   你自己的知识可以用，而且应该用 —— 只是要标出来，好让他分得清哪句话有出处。

说到 overturns 之前先数一遍：台账里有几组互相独立的来源？不到两组就别说推翻，说削弱。

## 输出格式

只输出一个 JSON 对象：
- \`impactType\`：上面四个值之一
- \`proposalType\`：上面四个值之一
- \`targetId\`：撞上的那条靶点编号，或 null
- \`statement\`：一句能上屏的话，说清这件事意味着什么
- \`basis\`：字符串数组，每项是证据编号或「[P] …」`;

export function buildA3ImpactUser(o: {
  question: string;
  material: string;
  hits: readonly { target: { id: string; text: string }; match: string; why: string }[];
  evidence: readonly { id: string; claim: string; tier: string; cosourceKey: string }[];
  searchless: boolean;
}): string {
  return `## 这一轮预研要回答的
${o.question}

## 信号材料
${o.material}

## 撞上的靶点
${o.hits.length ? o.hits.map((x) => `- ${x.target.id}｜${x.match}｜${x.target.text}（${x.why}）`).join("\n") : "（一条都没撞上）"}

## 证据台账
${o.searchless
  // `searchless` 恒等于「台账是空的」（见 Task 6），所以这里只有两档，
  // 不需要第三档去接「不 searchless 但台账空」—— 那种情形不存在。
  ? "（这一轮一条外部证据都没入账 —— 那就只用你自己的知识，并把每一条都标成 [P]）"
  : o.evidence.map((e) => `- ${e.id}｜${e.claim}｜${e.tier} 档｜同源键 ${e.cosourceKey}`).join("\n")}`;
}
```

- [ ] **Step 5: 在 `mock.ts` 的 `CANNED` 里加罐头**

```ts
  "a3.impact": {
    impactType: "weakens",
    proposalType: "adjustJudgment",
    targetId: "J-2",
    statement: "那条判断要把「不会有新玩家」收窄成「不会有做同一档客户的新玩家」",
    basis: ["E1", "[P] 这家公司过去两年只做海外市场"],
  },
```

- [ ] **Step 6: 跑测试，确认通过**

Run: `pnpm vitest run src/lib/agent/a3/impact.test.ts`
Expected: PASS（7 个）。

- [ ] **Step 7: 记账并提交**

changelog 加一条：`预研会说清这条信号对既有判断意味着什么，说到推翻但独立源不够就降档留痕`；`package.json` 同步。

```bash
git add src/lib/agent/a3/impact.ts src/lib/agent/a3/impact.test.ts src/lib/agent/a3/prompt.ts src/lib/models/mock.ts src/lib/changelog.ts package.json
git commit -m "feat(a3): P4 影响提案"
```

---

### Task 8: P5 三动作处置建议与待定的触发器提案

规格 P5 + §7 要给出三键处置建议（议一议 / 待定 / 不看了），建议待定时要带上监控条件。这一段**一次模型都不调**：三动作的分流由前面几段的机械结论决定，且**只是建议** —— 三键真正按下去的地方是 `api.disposeCard`，那是他的手。

**Files:**
- Create: `src/lib/agent/a3/dispose.ts`
- Test: `src/lib/agent/a3/dispose.test.ts`

**Interfaces:**
- Consumes: `proposeTrigger`, `TRIGGER_CONDITION_MAX` from `./trigger`；`independentGroupCount` from `./evidence-lite`；`MIN_INDEPENDENT_SOURCES` from `./impact`；`BlindspotRuling`, `DispositionSuggestion`, `EvidenceLite`, `ImpactProposal`, `Provenance` from `./stages`。
- Produces: `suggestDisposition(o: { impact: ImpactProposal; blindspot: BlindspotRuling; evidence: readonly EvidenceLite[]; nowIso: string; provenance: Provenance }): DispositionSuggestion`

- [ ] **Step 1: 写失败的测试**

`src/lib/agent/a3/dispose.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { makeProvenance } from "./provenance";
import { suggestDisposition } from "./dispose";
import type { BlindspotRuling, EvidenceLite, ImpactProposal } from "./stages";

const prov = makeProvenance("I-7");
const now = "2026-08-27T00:00:00.000Z";
const target = { kind: "judgment" as const, id: "J-2", text: "今年不会有新玩家" };
const blind: BlindspotRuling = {
  isBlindspot: true, proximity: "adjacent", hops: 1, credibility: "A", magnitude: "material", why: [],
};
function ev(id: string, group: string): EvidenceLite {
  return {
    id, claim: "c", sourceRef: `https://a.com/${id}`, date: now,
    tier: "A", cosourceKey: group, provenance: prov,
  };
}
const impact: ImpactProposal = {
  impactType: "weakens", proposalType: "adjustJudgment", targetRef: target,
  statement: "那条判断要收窄适用范围", basis: ["E1"],
};

describe("suggestDisposition", () => {
  it("要改判断、又有两组独立源 —— 建议议一议，不挂监控条件", () => {
    const r = suggestDisposition({
      impact, blindspot: blind, evidence: [ev("E1", "dom:a"), ev("E2", "dom:b")], nowIso: now, provenance: prov,
    });
    expect(r.action).toBe("discuss");
    expect(r.trigger).toBeNull();
    // 「2 组」不是「两组」：`why` 是 `有 ${groups} 组独立源` 拼出来的，`groups` 是数字。
    // **这条断言红了不许把模板串改成中文数字** —— 一到十以上就没法渲染，
    // 而这个数是台账里真实的组数，不是文案。要改的一律是断言这一侧。
    expect(r.why).toContain("2 组");
  });

  it("要改判断但只有一组独立源 —— 建议待定，并给出监控条件", () => {
    const r = suggestDisposition({
      impact, blindspot: blind, evidence: [ev("E1", "dom:a")], nowIso: now, provenance: prov,
    });
    expect(r.action).toBe("watch");
    expect(r.trigger).not.toBeNull();
    expect(r.trigger!.status).toBe("proposed");
    expect(r.trigger!.source).toBe("watch");
    expect(r.trigger!.onFire).toBe("proposeDiscuss");
    expect(r.trigger!.targetRef).toEqual(target);
    expect(r.trigger!.expiresAt).toBe("2026-11-25T00:00:00.000Z");
  });

  it("不相干或量级不够 —— 建议不看了，也不挂监控条件", () => {
    const r = suggestDisposition({
      impact: { ...impact, impactType: "outOfScope", proposalType: "noAction" },
      blindspot: { ...blind, isBlindspot: false, magnitude: "immaterial" },
      evidence: [], nowIso: now, provenance: prov,
    });
    expect(r.action).toBe("dismiss");
    expect(r.trigger).toBeNull();
  });

  it("要重议决定的按议一议那一档办（够两组源时）", () => {
    const r = suggestDisposition({
      impact: { ...impact, impactType: "overturns", proposalType: "reopenDecision" },
      blindspot: blind, evidence: [ev("E1", "dom:a"), ev("E2", "dom:b")], nowIso: now, provenance: prov,
    });
    expect(r.action).toBe("discuss");
  });

  it("判成盲区但提案是不动作 —— 建议待定：盯着，别现在占他时间", () => {
    const r = suggestDisposition({
      impact: { ...impact, impactType: "confirms", proposalType: "noAction", targetRef: target },
      blindspot: blind, evidence: [ev("E1", "dom:a"), ev("E2", "dom:b")], nowIso: now, provenance: prov,
    });
    expect(r.action).toBe("watch");
    expect(r.trigger!.onFire).toBe("proposeDiscuss");
  });

  it("监控条件超长时截到上限再造 —— 不因为一句话太长就丢掉整条监控", () => {
    const r = suggestDisposition({
      impact: { ...impact, statement: "长".repeat(200) },
      blindspot: blind, evidence: [ev("E1", "dom:a")], nowIso: now, provenance: prov,
    });
    expect(r.trigger!.condition.length).toBeLessThanOrEqual(80);
  });

  it("没有靶点可挂时不造监控条件 —— 挂不到东西上的监控没法核", () => {
    const r = suggestDisposition({
      impact: { ...impact, targetRef: null },
      blindspot: blind, evidence: [ev("E1", "dom:a")], nowIso: now, provenance: prov,
    });
    expect(r.action).toBe("watch");
    expect(r.trigger).toBeNull();
    expect(r.why).toContain("挂不到");
  });
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm vitest run src/lib/agent/a3/dispose.test.ts`
Expected: FAIL，`Failed to resolve import "./dispose"`。

- [ ] **Step 3: 写实现**

```ts
import { independentGroupCount } from "./evidence-lite";
import { MIN_INDEPENDENT_SOURCES } from "./impact";
import { proposeTrigger, TRIGGER_CONDITION_MAX } from "./trigger";
import type { BlindspotRuling, DispositionSuggestion, EvidenceLite, ImpactProposal, Provenance } from "./stages";

/**
 * 三键处置**建议**。
 *
 * 名字里那个「建议」是全部要点：三键真正按下去的地方是 `api.disposeCard`，
 * 那是他的手。这里算出来的只是屏幕上默认高亮哪一个键、以及待定那一档会带上
 * 什么监控条件。一次模型都不调 —— 分流的依据（要不要改判断、有几组独立源、
 * 是不是盲区、量级够不够）全部已经是机械结论了，再问一次模型只会引入一次不确定。
 */
export function suggestDisposition(o: {
  impact: ImpactProposal;
  blindspot: BlindspotRuling;
  evidence: readonly EvidenceLite[];
  nowIso: string;
  provenance: Provenance;
}): DispositionSuggestion {
  const groups = independentGroupCount(o.evidence);
  const wantsChange = o.impact.proposalType === "adjustJudgment" || o.impact.proposalType === "reopenDecision";
  const worthless = o.impact.impactType === "outOfScope" || o.blindspot.magnitude === "immaterial";

  if (worthless && !wantsChange) {
    return {
      action: "dismiss",
      why:
        o.impact.impactType === "outOfScope"
          ? "跟他现在的任何判断都不相干"
          : "量级不够，占不上他的时间",
      trigger: null,
    };
  }

  if (wantsChange && groups >= MIN_INDEPENDENT_SOURCES) {
    return {
      action: "discuss",
      why: `要动既有判断，而且有 ${groups} 组独立源撑着 —— 这一条值得他现在看`,
      trigger: null,
    };
  }

  // 剩下的一律建议待定：有东西，但还不够让他现在停下来。
  const why = wantsChange
    ? `要动既有判断，但只有 ${groups} 组独立源 —— 先盯着，命中了再请他看`
    : "这件事挨着他在管的事，但这一轮还提不出要动什么";

  if (!o.impact.targetRef) {
    return { action: "watch", why: `${why}（挂不到具体靶点上，这一轮不设监控条件）`, trigger: null };
  }

  return {
    action: "watch",
    why,
    trigger: proposeTrigger({
      seq: 1,
      condition: o.impact.statement.slice(0, TRIGGER_CONDITION_MAX),
      targetRef: o.impact.targetRef,
      source: "watch",
      onFire: "proposeDiscuss",
      nowIso: o.nowIso,
      provenance: o.provenance,
    }),
  };
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `pnpm vitest run src/lib/agent/a3/dispose.test.ts`
Expected: PASS（7 个）。

- [ ] **Step 5: 记账并提交**

changelog 加一条：`预研给出三键处置建议，建议待定时连监控条件一起备好（仍等他按）`；`package.json` 同步。

```bash
git add src/lib/agent/a3/dispose.ts src/lib/agent/a3/dispose.test.ts src/lib/changelog.ts package.json
git commit -m "feat(a3): P5 三动作处置建议"
```

---

### Task 9: P6 轻量批判

规格 P6 要一次中档异系的批判。**机检在前**（照 `talk/verifier.ts` 已经在跑的姿态）：能机械判的三件事先判 —— 证据太薄、说得太满、靶点对不上。其中**只有 p0 的那两条短路模型**（`modelSlot` 记 `null`，台账上不许把机检定的事记成模型判的）；「说得太满」在 `agent/rules.ts` 里是 p1，按本仓库「p0 进返修、p1 只留痕」的口径**只留痕、照常跑批判**。形状校验直接复用 `checkVerdict`，不写第二套。

「证据本身多旧」这一道**这一轮没有**（`EvidenceLite.date` 是抓取时刻，不是证据说的时点），记在末节欠账里 —— 见 Step 3 那段注释。

**Files:**
- Create: `src/lib/agent/a3/critic.ts`
- Modify: `src/lib/agent/a3/prompt.ts`
- Modify: `src/lib/models/mock.ts`
- Test: `src/lib/agent/a3/critic.test.ts`

**Interfaces:**
- Consumes: `Harness` from `@/lib/agent/harness`；`parseJson` from `@/lib/agent/json`；`checkVerdict` from `@/lib/agent/talk/verifier`；`overclaim` from `@/lib/agent/rules`；`resolveModel`, `areIndependent` from `@/lib/models/slots`；`independentGroupCount` from `./evidence-lite`；`MIN_INDEPENDENT_SOURCES` from `./impact`；`CriticCheck`, `CriticVerdict`, `EvidenceLite`, `ImpactProposal`, `TargetHit` from `./stages`。
- Produces:
  - `machineChecks(o: { impact: ImpactProposal; hits: readonly TargetHit[]; evidence: readonly EvidenceLite[] }): { checks: CriticCheck[]; why: string[] }`（不收时钟 —— 这一层没有按日期算新旧的检查，见下面 Step 3 的注释）
  - `criticize(h: Harness, o: { question: string; impact: ImpactProposal; hits: readonly TargetHit[]; evidence: readonly EvidenceLite[] }): Promise<CriticVerdict>`
  - `prompt.ts` 新增 `A3_CRITIC_SYSTEM: string`
  - `mock.ts` 新增罐头键 `a3.critic`

- [ ] **Step 1: 写失败的测试**

`src/lib/agent/a3/critic.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import type { Harness } from "@/lib/agent/harness";
import { criticize, machineChecks } from "./critic";
import type { EvidenceLite, ImpactProposal, TargetHit } from "./stages";

const now = "2026-08-27T00:00:00.000Z";
const target = { kind: "judgment" as const, id: "J-2", text: "今年不会有新玩家" };
const hit: TargetHit = { target, match: "challenges", why: "正是新玩家", hops: 1 };
function ev(id: string, group: string): EvidenceLite {
  return { id, claim: "c", sourceRef: `https://a.com/${id}`, date: now, tier: "A", cosourceKey: group, provenance: { issueId: "I-7", stage: "pre_research" } };
}
const ok: ImpactProposal = {
  impactType: "weakens", proposalType: "adjustJudgment", targetRef: target,
  statement: "那条判断要收窄适用范围", basis: ["E1"],
};
function stub(reply: unknown, slot: "pro" | "alt" = "pro"): Harness {
  return {
    slot,
    async callMessages() { return { text: JSON.stringify(reply) }; },
    note() {}, substep() {},
  } as unknown as Harness;
}

describe("machineChecks", () => {
  it("干净的提案一条都不报", () => {
    const r = machineChecks({ impact: ok, hits: [hit], evidence: [ev("E1", "dom:a"), ev("E2", "dom:b")] });
    expect(r.checks).toEqual([]);
  });

  it("要改判断却只有一组独立源 —— 报证据太薄", () => {
    const r = machineChecks({ impact: ok, hits: [hit], evidence: [ev("E1", "dom:a")] });
    expect(r.checks).toContain("evidenceThin");
    expect(r.why.join("")).toContain(String(1));
  });

  it("说得太满又没有数字或编号支撑 —— 报过度断言", () => {
    const r = machineChecks({
      impact: { ...ok, statement: "这条判断必然不成立" },
      hits: [hit], evidence: [ev("E1", "dom:a"), ev("E2", "dom:b")],
    });
    expect(r.checks).toContain("overclaim");
  });

  it("提案挂的靶点不在这一轮的命中里 —— 报靶点对不上", () => {
    const r = machineChecks({
      impact: { ...ok, targetRef: { kind: "judgment", id: "J-9", text: "别的判断" } },
      hits: [hit], evidence: [ev("E1", "dom:a"), ev("E2", "dom:b")],
    });
    expect(r.checks).toContain("targetMismatch");
  });
});

describe("criticize", () => {
  it("机检报了要返修的那一类就直接打回，一次模型都不叫（modelSlot 记 null）", async () => {
    let called = 0;
    const h = {
      slot: "pro",
      async callMessages() { called++; return { text: "{}" }; },
      note() {}, substep() {},
    } as unknown as Harness;
    const v = await criticize(h, { question: "q", impact: ok, hits: [hit], evidence: [ev("E1", "dom:a")] });
    expect(v.pass).toBe(false);
    expect(v.modelSlot).toBeNull();
    expect(called).toBe(0);
  });

  it("只有「说得太满」这一条时不打回、也不短路 —— 照常叫模型，它只留痕", async () => {
    let called = 0;
    const h = {
      slot: "pro",
      async callMessages() { called++; return { text: JSON.stringify({ pass: true, why: ["提案与台账对得上"] }) }; },
      note() {}, substep() {},
    } as unknown as Harness;
    const v = await criticize(h, {
      question: "q", impact: { ...ok, statement: "这条判断必然不成立" },
      hits: [hit], evidence: [ev("E1", "dom:a"), ev("E2", "dom:b")],
    });
    expect(called).toBe(1);
    expect(v.modelSlot).toBe("alt");
    expect(v.pass).toBe(true);
    expect(v.checks).toContain("overclaim");
  });

  it("机检过了才叫模型，而且叫的是异系那一格", async () => {
    const v = await criticize(stub({ pass: true, why: ["提案与台账对得上"] }), {
      question: "q", impact: ok, hits: [hit], evidence: [ev("E1", "dom:a"), ev("E2", "dom:b")],
    });
    expect(v.pass).toBe(true);
    expect(v.modelSlot).toBe("alt");
    expect(v.checks).toEqual([]);
  });

  it("主链跑在 alt 上时批判换回 pro —— 永远不跟主链同一格", async () => {
    // 桩里的槽位必须真的是 `alt`：`criticize` 里那一行是 `h.slot === "pro" ? "alt" : "pro"`，
    // 传 `flash` 走的是 else 支，标题说的场景根本没被测到（那样把条件写反了也照样绿）。
    const v = await criticize(stub({ pass: true, why: ["行"] }, "alt"), {
      question: "q", impact: ok, hits: [hit], evidence: [ev("E1", "dom:a"), ev("E2", "dom:b")],
    });
    expect(v.modelSlot).toBe("pro");
  });

  it("模型返回形状读不懂时判成打回并留痕，不许 fallback 成通过", async () => {
    const v = await criticize(stub({ pass: "yes", why: [] }), {
      question: "q", impact: ok, hits: [hit], evidence: [ev("E1", "dom:a"), ev("E2", "dom:b")],
    });
    expect(v.pass).toBe(false);
    expect(v.modelSlot).toBe("alt");
    expect(v.why.join("")).toContain("pass");
  });

  it("返回不是合法 JSON 也是打回", async () => {
    const h = { slot: "pro", async callMessages() { return { text: "呃" }; }, note() {}, substep() {} } as unknown as Harness;
    const v = await criticize(h, {
      question: "q", impact: ok, hits: [hit], evidence: [ev("E1", "dom:a"), ev("E2", "dom:b")],
    });
    expect(v.pass).toBe(false);
    expect(v.modelSlot).toBe("alt");
  });
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm vitest run src/lib/agent/a3/critic.test.ts`
Expected: FAIL，`Failed to resolve import "./critic"`。

- [ ] **Step 3: 写 `critic.ts`**

```ts
import type { Harness } from "@/lib/agent/harness";
import { parseJson } from "@/lib/agent/json";
import { checkVerdict } from "@/lib/agent/talk/verifier";
import { overclaim } from "@/lib/agent/rules";
import { areIndependent, resolveModel, type Slot } from "@/lib/models/slots";
import { independentGroupCount } from "./evidence-lite";
import { MIN_INDEPENDENT_SOURCES } from "./impact";
import { A3_CRITIC_SYSTEM } from "./prompt";
import type { CriticCheck, CriticVerdict, EvidenceLite, ImpactProposal, TargetHit } from "./stages";

/**
 * 机械可判的那三件事。**机检在前不只是省钱**：它让「这几类问题一定被拦住」
 * 成为一条机械保证，而不是对模型的期望 —— 这是 `talk/verifier.ts` 已经在跑的姿态。
 *
 * 这里**没有**「证据本身多旧」这一道。`EvidenceLite.date` 是 `Evidence.retrievedAt`，
 * 也就是这一轮的抓取时刻，生产上永远约等于此刻 —— 拿它算天数，那道检查永不开火。
 * 证据说的是哪个时点在 `Evidence.period` 上，而它是可选的，补上去也只有一半时候查得动。
 * 这条是记在末节的欠账，**不要在这里补一个按 `date` 算的过期检查**。
 */
export function machineChecks(o: {
  impact: ImpactProposal;
  hits: readonly TargetHit[];
  evidence: readonly EvidenceLite[];
}): { checks: CriticCheck[]; why: string[] } {
  const checks: CriticCheck[] = [];
  const why: string[] = [];

  const wantsChange = o.impact.proposalType === "adjustJudgment" || o.impact.proposalType === "reopenDecision";
  const groups = independentGroupCount(o.evidence);
  if (wantsChange && groups < MIN_INDEPENDENT_SOURCES) {
    checks.push("evidenceThin");
    why.push(`要动既有判断，但只有 ${groups} 组独立源（要 ${MIN_INDEPENDENT_SOURCES} 组）`);
  }

  const over = overclaim(o.impact.statement, "影响提案");
  if (over.length > 0) {
    checks.push("overclaim");
    why.push(...over.map((v) => v.message));
  }

  if (o.impact.targetRef && !o.hits.some((x) => x.target.id === o.impact.targetRef!.id)) {
    checks.push("targetMismatch");
    why.push(`提案挂在 ${o.impact.targetRef.id} 上，但这一轮的命中里没有这条靶点`);
  }

  return { checks, why };
}

/**
 * P6 轻量批判。
 *
 * 机检报了**要返修的那一类**就直接打回，一次模型都不叫，`modelSlot` 记 `null` ——
 * 台账上不许把机检定的事记成模型判的。机检过了才叫模型，而且叫的是**异系那一格**
 * （跟主链不同槽位），因为要它挑的正是主链自己看不出来的毛病。
 *
 * 形状校验复用 `talk/verifier.ts` 的 `checkVerdict` —— 那里已经把「不许 fallback 成通过」
 * 这件事写死了，再写一遍只会多一处会走偏的地方。
 */
export async function criticize(
  h: Harness,
  o: {
    question: string;
    impact: ImpactProposal;
    hits: readonly TargetHit[];
    evidence: readonly EvidenceLite[];
  },
): Promise<CriticVerdict> {
  const machine = machineChecks(o);
  // 「说得太满」在 `agent/rules.ts` 里是 p1，而这个仓库的口径是 p0 进返修、p1 只留痕
  // （交界表里也是这么写的）。所以它不打回、也不短路掉批判：照常叫模型，
  // 只把这一条带在 `checks` 里上台账。**不许把它并进下面那道提前返回**，
  // 那等于在预研这一层把 p1 悄悄升成硬拦，同一条规则在两个链路上就有了两种轻重。
  const blocking = machine.checks.filter((c) => c !== "overclaim");
  if (blocking.length > 0) {
    return { pass: false, checks: machine.checks, why: machine.why, modelSlot: null };
  }

  if (machine.checks.includes("overclaim")) {
    h.note("提案说得太满（p1，只留痕不返修）", { why: machine.why });
  }

  const criticSlot: Slot = h.slot === "pro" ? "alt" : "pro";
  const mainConfig = resolveModel(h.slot);
  const criticConfig = resolveModel(criticSlot);
  if (mainConfig && criticConfig && !areIndependent(mainConfig, criticConfig)) {
    h.note("异系批判变同系", {
      mainSlot: h.slot, mainFamily: mainConfig.family,
      criticSlot, criticFamily: criticConfig.family,
      note: "两边解出的是同一个 family —— 这一次批判其实不异系",
    });
  }

  const userMsg = `## 这一轮预研要回答的
${o.question}

## 影响提案
性质：${o.impact.impactType}
提案：${o.impact.proposalType}
挂在：${o.impact.targetRef ? `${o.impact.targetRef.id}｜${o.impact.targetRef.text}` : "（没挂靶点）"}
说法：${o.impact.statement}
依据：${o.impact.basis.join("、") || "（没有）"}

## 证据台账
${o.evidence.length ? o.evidence.map((e) => `- ${e.id}｜${e.claim}｜${e.tier} 档｜同源键 ${e.cosourceKey}`).join("\n") : "（空）"}`;

  const r = await h.callMessages(
    "模型调用 · a3.critic",
    [
      { role: "system", content: A3_CRITIC_SYSTEM },
      { role: "user", content: userMsg },
    ],
    { slot: criticSlot, maxTokens: 1500 },
    { promptKey: "a3.critic", criticSlot, mainSlot: h.slot },
    "a3.critic",
  );

  let parsed: unknown;
  try {
    parsed = parseJson<unknown>(r.text);
  } catch {
    return { pass: false, checks: machine.checks, why: [...machine.why, "批判返回的不是合法 JSON"], modelSlot: criticSlot };
  }
  const checked = checkVerdict(parsed, criticSlot);
  if (!checked.ok) {
    return { pass: false, checks: machine.checks, why: [...machine.why, ...checked.review.why], modelSlot: criticSlot };
  }
  // 机检那几条（这里只可能是 p1 的「说得太满」）要跟着结论一起交出去，
  // 不然它就只活在 trace 里，卡上看不到。
  return { pass: checked.value.pass, checks: machine.checks, why: [...machine.why, ...checked.value.why], modelSlot: criticSlot };
}
```

- [ ] **Step 4: 在 `prompt.ts` 末尾加提示词**

```ts
/**
 * P6 的提示词。给一个没参与前面几段的模型挑毛病。
 *
 * 它要挑的是**机器挑不出来的那三类**：说法与依据之间的跳步、把相关当因果、
 * 靶点看起来对上了其实答的是另一个问题。独立源够不够、说得满不满这两件事机检已经查过
 * （前者不够就直接返修，后者只留痕），不必再让它数一遍。
 *
 * 提示词里**不提证据新旧** —— 这一层根本没有那道检查，台账上那个日期是抓取时刻，
 * 让它照着那个字段判新旧只会得到「全都是今天的」。
 */
export const A3_CRITIC_SYSTEM = `你没有参与前面的分析，独立评审下面这份影响提案。

只挑这三类问题：
1. 从依据到说法之间有没有跳步 —— 依据成立，说法是否就跟着成立？
2. 有没有把相关当因果 —— 两件事同时发生，是否被当成了一件事导致另一件？
3. 靶点对上了吗 —— 这份提案说的，是不是那条既有判断真正在赌的那件事？

独立源够不够、说得满不满，前面已经机械查过了，不用再数。

你自己的知识可以用：你知道这个行业里某件事通常怎么发生，就直接说。

## 输出格式

只输出一个 JSON 对象，包含两个字段：
- \`pass\`（布尔值）：true 表示这份提案站得住，false 表示打回
- \`why\`（字符串数组）：每项一句能上屏的理由。通过时说明它为什么站得住，打回时指明是哪一步跳了`;
```

- [ ] **Step 5: 在 `mock.ts` 的 `CANNED` 里加罐头**

```ts
  "a3.critic": {
    pass: true,
    why: ["提案说的是适用范围要收窄，这一步跟依据对得上，没有从一家公司跳到整个市场"],
  },
```

- [ ] **Step 6: 跑测试，确认通过**

Run: `pnpm vitest run src/lib/agent/a3/critic.test.ts`
Expected: PASS（10 个）。

- [ ] **Step 7: 记账并提交**

changelog 加一条：`预研的影响提案要过一道异系批判，机检能定的先机检定并如实记成机检`；`package.json` 同步。

```bash
git add src/lib/agent/a3/critic.ts src/lib/agent/a3/critic.test.ts src/lib/agent/a3/prompt.ts src/lib/models/mock.ts src/lib/changelog.ts package.json
git commit -m "feat(a3): P6 轻量批判"
```

---

### Task 10: P7 卡片装配与字数机检

规格 P7 要一张 ≤300 字的提请卡，同一议题第二次预研出的是增量卡。这一段**机械装配**（不调模型）：段落按优先级往里放，放不下就不放 —— 但**已经放进去的话必须带全标签**，因为标签是他分「哪句有出处、哪句是先验」的唯一凭据。四条新规则以 `Violation[]` 返回，由 `run.ts` 并进既有的 `validatePreResearch` 结果里，共用一套 p0/p1 语义。

**Files:**
- Create: `src/lib/agent/a3/card.ts`
- Test: `src/lib/agent/a3/card.test.ts`

**Interfaces:**
- Consumes: `chars` from `@/lib/agent/rules`；`Violation` from `@/lib/agent/rules`；`BlindspotRuling`, `CardDraft`, `CardKind`, `CriticVerdict`, `DispositionSuggestion`, `EvidenceLite`, `ImpactProposal` from `./stages`；`independentGroupCount` from `./evidence-lite`；**`bestTier` from `./blindspot`**（Task 5 的导出 —— 取最高档只有这一份实现）。
- Produces:
  - `CARD_BUDGET = 300`、`INCREMENT_BUDGET = 150`、`INCREMENT_HEAD = "比上次多了："`
  - `assembleCard(o: { kind: CardKind; impact: ImpactProposal; disposition: DispositionSuggestion; blindspot: BlindspotRuling; evidence: readonly EvidenceLite[]; critic: CriticVerdict }): CardDraft` —— **不收 `searchless`**（2026-08-27 更正）：它是 `evidence` 为空的投影，收进来就等于给同一件事开两个真源，而两个方向的口径会不一致。「这一轮没有外部核验」的判据只认台账。
  - `checkCard(card: CardDraft): Violation[]`

- [ ] **Step 1: 写失败的测试**

`src/lib/agent/a3/card.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { assembleCard, CARD_BUDGET, checkCard, INCREMENT_BUDGET, INCREMENT_HEAD } from "./card";
import type { BlindspotRuling, CriticVerdict, DispositionSuggestion, EvidenceLite, ImpactProposal } from "./stages";

const prov = { issueId: "I-7", stage: "pre_research" as const };
const target = { kind: "judgment" as const, id: "J-2", text: "今年不会有新玩家" };
function ev(id: string, group: string): EvidenceLite {
  return { id, claim: "同类产品已发布", sourceRef: `https://a.com/${id}`, date: "2026-08-27T00:00:00.000Z", tier: "A", cosourceKey: group, provenance: prov };
}
const impact: ImpactProposal = {
  impactType: "weakens", proposalType: "adjustJudgment", targetRef: target,
  statement: "那条判断要收窄成只管同一档客户", basis: ["E1", "[P] 这家公司过去只做海外"],
};
const disposition: DispositionSuggestion = { action: "discuss", why: "有两组独立源撑着", trigger: null };
const blindspot: BlindspotRuling = { isBlindspot: true, proximity: "adjacent", hops: 1, credibility: "A", magnitude: "material", why: [] };
const critic: CriticVerdict = { pass: true, checks: [], why: ["没有跳步"], modelSlot: "alt" };
const base = { impact, disposition, blindspot, evidence: [ev("E1", "dom:a"), ev("E2", "dom:b")], critic, searchless: false };

describe("assembleCard", () => {
  it("装出的卡不超预算，且每条依据都带着标签上卡", () => {
    const c = assembleCard({ ...base, kind: "full" });
    expect(c.kind).toBe("full");
    expect(c.chars).toBeLessThanOrEqual(CARD_BUDGET);
    expect(c.body).toContain("[E1]");
    expect(c.body).toContain("[P]");
    expect(c.basis).toEqual(["E1", "[P] 这家公司过去只做海外"]);
    expect(checkCard(c)).toEqual([]);
  });

  it("机检算出来的档位与组数上卡 —— 他要看得见这份判断有多少底", () => {
    const c = assembleCard({ ...base, kind: "full" });
    expect(c.body).toContain("A 档");
    expect(c.body).toContain("2 组独立源");
  });

  it("挂了靶点就把靶点编号写进抬头", () => {
    expect(assembleCard({ ...base, kind: "full" }).headline).toContain("J-2");
  });

  it("增量卡有自己的预算和固定开头", () => {
    const c = assembleCard({ ...base, kind: "increment" });
    expect(c.body.startsWith(INCREMENT_HEAD)).toBe(true);
    expect(c.chars).toBeLessThanOrEqual(INCREMENT_BUDGET);
    expect(checkCard(c)).toEqual([]);
  });

  it("没有外部证据时如实写「这一轮没有外部核验」，不写档位也不写组数", () => {
    const c = assembleCard({ ...base, evidence: [], kind: "full" });
    expect(c.body).toContain("这一轮没有外部核验");
    // 这两条断言只能这么写：`impact.statement` 里本来就有「档」字（「只管同一档客户」），
    // 而说法是第一段无条件上卡的，所以 `not.toContain("档")` 必红 —— 那是 fixture 的字，
    // 不是装配写的档位。要拦的是「A 档」这个格式和「组独立源」这句话，
    // 和 `checkCard` 里 A3-16 那个 `/[ABCD] 档/` 是同一个口径。
    expect(c.body).not.toMatch(/[ABCD] 档/);
    expect(c.body).not.toContain("组独立源");
  });

  it("批判没过时卡上要写着它没过 —— 不许把没过的批判藏起来", () => {
    const c = assembleCard({
      ...base, kind: "full",
      critic: { pass: false, checks: ["evidenceThin"], why: ["独立源不够"], modelSlot: null },
    });
    expect(c.body).toContain("机检没过");
    expect(c.body).toContain("独立源不够");
  });

  it("放不下的段落就不放，但放进去的话不许缺标签", () => {
    const c = assembleCard({
      ...base, kind: "increment",
      disposition: { ...disposition, why: "理".repeat(200) },
    });
    expect(c.chars).toBeLessThanOrEqual(INCREMENT_BUDGET);
    expect(checkCard(c)).toEqual([]);
  });
});

describe("checkCard", () => {
  it("连头一句都超预算就报 p0 —— 那是说法本身太长", () => {
    const c = assembleCard({
      ...base, kind: "full",
      impact: { ...impact, statement: "长".repeat(400) },
    });
    const v = checkCard(c);
    expect(v.some((x) => x.rule === "A3-14" && x.severity === "p0")).toBe(true);
  });

  it("依据在 basis 里但正文里找不到标签 —— 报 p0", () => {
    const v = checkCard({ kind: "full", headline: "h", body: "一句没有标签的话", basis: ["E1"], chars: 8 });
    expect(v.some((x) => x.rule === "A3-15" && x.severity === "p0")).toBe(true);
  });

  it("两条先验依据只上去一条 —— 掉的那条要被查出来", () => {
    const v = checkCard({
      kind: "full",
      headline: "h",
      body: "[P] 这家公司过去只做海外 —— A 档",
      basis: ["[P] 这家公司过去只做海外", "[P] 这个行业的渠道向来握在代理商手里"],
      chars: 22,
    });
    expect(v.filter((x) => x.rule === "A3-15")).toHaveLength(1);
  });

  it("正文里一个档位都没提 —— 报 p1（提醒而不是拦）", () => {
    const v = checkCard({ kind: "full", headline: "h", body: "[E1] 一句话", basis: ["E1"], chars: 9 });
    expect(v.some((x) => x.rule === "A3-16" && x.severity === "p1")).toBe(true);
  });

  it("增量卡开头不对 —— 报 p0", () => {
    const v = checkCard({ kind: "increment", headline: "h", body: "[E1] A 档，2 组独立源", basis: ["E1"], chars: 15 });
    expect(v.some((x) => x.rule === "A3-17" && x.severity === "p0")).toBe(true);
  });
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm vitest run src/lib/agent/a3/card.test.ts`
Expected: FAIL，`Failed to resolve import "./card"`。

- [ ] **Step 3: 写实现**

```ts
import { chars, type Violation } from "@/lib/agent/rules";
import { bestTier } from "./blindspot";
import { independentGroupCount } from "./evidence-lite";
import type {
  BlindspotRuling, CardDraft, CardKind, CriticVerdict, DispositionSuggestion, EvidenceLite, ImpactProposal,
} from "./stages";

/**
 * 一张提请卡的字数预算。300 字是「他站着能读完」的量 ——
 * 提请卡的职责是让他决定要不要花时间，不是替他把事想完。
 */
export const CARD_BUDGET = 300;

/** 同一议题第二次预研出的增量卡：只说这一次多了什么，所以预算减半。 */
export const INCREMENT_BUDGET = 150;

/** 增量卡的固定开头。固定是有意的：他一眼就知道「这不是新的一张，是上次那张的续」。 */
export const INCREMENT_HEAD = "比上次多了：";

const ACTION_LABEL: Record<DispositionSuggestion["action"], string> = {
  discuss: "建议议一议",
  watch: "建议先待定",
  dismiss: "建议不看了",
};

/**
 * 机械装配提请卡。**不调模型** —— 要说的话在前面几段已经全部产出了，
 * 这一段只决定放哪几句、按什么顺序、放不下先砍谁。
 *
 * 段落按优先级排：说法 → 依据（带标签）→ 底子有多厚 → 处置建议 → 批判结论。
 * 装不下的那一段**跳过，继续试后面的** —— 不是遇到第一段装不下就收工。
 * 后面那几段一句比一句短，前面挤不进去的时候后面往往还放得下，
 * 而「批判没过」这种最短的话恰恰最不该被前面一段长文案挤掉。
 *
 * **不许把一段截断**：截一半的依据会让标签跟正文对不上，
 * 而标签是他分「哪句有出处、哪句是模型的先验」的唯一凭据。
 */
export function assembleCard(o: {
  kind: CardKind;
  impact: ImpactProposal;
  disposition: DispositionSuggestion;
  blindspot: BlindspotRuling;
  evidence: readonly EvidenceLite[];
  critic: CriticVerdict;
  searchless: boolean;
}): CardDraft {
  const budget = o.kind === "increment" ? INCREMENT_BUDGET : CARD_BUDGET;
  const groups = independentGroupCount(o.evidence);
  // 取最高档一律用 Task 5 的 `bestTier`，**不在这里再写一份 `reduce`**。
  // 原来那份靠 `a.tier <= b.tier` 的字典序，A–D 恰好字典序等于档次序，所以两处结果一样 ——
  // 那是巧合。档位以后多一档、或者改成 `A+` 这类写法，字典序就不再等于档次序，
  // 而两处里只有 `bestTier` 有测试。
  const best = bestTier(o.evidence);

  const basisLine = o.impact.basis
    .map((b) => (b.startsWith("[P]") ? b : `[${b}] ${o.evidence.find((e) => e.id === b)?.claim ?? ""}`.trim()))
    .join("；");

  // `searchless` 就是「一条外部证据都没入账」，两个条件本来同真同假（见 `stages.ts` 的注释）；
  // 这里两个都判是为了万一调用方传进来不一致时也不会印出「底子：null 档」。
  const backing = o.searchless || o.evidence.length === 0
    ? "这一轮没有外部核验（一条外部证据都没入账）"
    : `底子：${best} 档，${groups} 组独立源`;

  const criticLine = o.critic.pass
    ? null
    : `${o.critic.modelSlot === null ? "机检没过" : "批判没过"}：${o.critic.why.join("；")}`;

  const paras = [
    o.kind === "increment" ? `${INCREMENT_HEAD}${o.impact.statement}` : o.impact.statement,
    basisLine ? `依据：${basisLine}` : null,
    backing,
    `${ACTION_LABEL[o.disposition.action]} —— ${o.disposition.why}`,
    criticLine,
  ].filter((x): x is string => Boolean(x));

  const body: string[] = [];
  for (const p of paras) {
    const next = [...body, p].join("\n\n");
    // 第一段无论多长都要放：放不下也得让他看见说法本身，超预算由 A3-14 报出来。
    // 后面的段落装不下就 `continue`（**不是 `break`**）—— 跳过这一段，继续试更短的下一段。
    if (body.length > 0 && chars(next) > budget) continue;
    body.push(p);
  }

  const text = body.join("\n\n");
  const headline = o.impact.targetRef
    ? `${o.impact.targetRef.id}｜${o.impact.targetRef.text}`
    : o.blindspot.isBlindspot
      ? "这件事挨着你在管的事，但没在你的监控清单上"
      : "这一轮没撞上任何既有判断";

  return { kind: o.kind, headline, body: text, basis: [...o.impact.basis], chars: chars(text) };
}

/**
 * 卡片的机检。四条新规则，p0/p1 的语义与 `validate.ts` 那一批完全一致 ——
 * `run.ts` 会把这里的结果并进 `validatePreResearch` 的返回里，p0 参与返修判定。
 */
export function checkCard(card: CardDraft): Violation[] {
  const v: Violation[] = [];
  const budget = card.kind === "increment" ? INCREMENT_BUDGET : CARD_BUDGET;

  if (card.chars > budget) {
    v.push({
      rule: "A3-14",
      severity: "p0",
      message: `提请卡 ${card.chars} 字，超了 ${budget} 字的预算 —— 装配已经砍到只剩说法本身，说明说法自己就太长`,
    });
  }

  for (const b of card.basis) {
    // 先验依据要**逐条**查，查的是这一条的整句原文，不是「[P] 出现过就算」。
    // 只认标签的话，两条先验只上去一条也一样绿 —— 而这条规则的全部意义
    // 就是「掉了的那条要被查出来」。装配那边 `[P]` 项是原样上卡的，所以整句能对得上。
    const needle = b.startsWith("[P]") ? b : `[${b}]`;
    if (!card.body.includes(needle)) {
      v.push({
        rule: "A3-15",
        severity: "p0",
        message: `依据 ${b} 没能带着标签上卡 —— 卡上分不出哪句有出处、哪句是先验`,
      });
    }
  }

  if (!/[ABCD] 档/.test(card.body) && !card.body.includes("没有外部核验")) {
    v.push({
      rule: "A3-16",
      severity: "p1",
      message: "卡上既没写档位也没说这一轮没有外部核验 —— 他看不出这份判断有多少底",
    });
  }

  if (card.kind === "increment" && !card.body.startsWith(INCREMENT_HEAD)) {
    v.push({
      rule: "A3-17",
      severity: "p0",
      message: `增量卡的第一句要以「${INCREMENT_HEAD}」开头 —— 否则他会以为这是一张新的卡`,
    });
  }

  return v;
}
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `pnpm vitest run src/lib/agent/a3/card.test.ts`
Expected: PASS（12 个）。

- [ ] **Step 5: 记账并提交**

changelog 加一条：`提请卡机械装配并守住字数预算，每条依据都带着标签上卡`；`package.json` 同步。

```bash
git add src/lib/agent/a3/card.ts src/lib/agent/a3/card.test.ts src/lib/changelog.ts package.json
git commit -m "feat(a3): P7 卡片装配与字数机检"
```

---

### Task 11: 把 P1–P7 串进 A3 链

这一段是整份计划的接头：前面九个任务全是纯函数，这里把它们挂到**既有的那一条 A3 链**上（`runPreResearch` → `Harness`）。**不新建链路**：没有新的 `HarnessAgent`、没有新的任务表键、没有第二个 `runPreResearch`。

**有 `input.targets` 才走 v2**：不给靶点库时 `STEPS` 仍是两段、产物仍是 v1 的 `PreResearchDoc`，所以既有的 A3 测试与既有的调用方一行都不用改。

**Files:**
- Modify: `src/lib/agent/a3/prompt.ts`（`A3Input` 加三个可选字段）
- Modify: `src/lib/agent/a3/run.ts`（符号：`STEPS`、`STEP_TOTAL`、`runPreResearch`、`A3Result`）
- Modify: `src/lib/data/types.ts`（符号：`PreResearchDoc`）
- Test: `src/lib/agent/a3/run.v2.test.ts`

**Interfaces:**
- Consumes: 前面九个任务的全部导出 —— `makeProvenance`、`matchTargets`、`narrowTargets`、`ruleBlindspot`、`verifyExternally`、`proposeImpact`、`suggestDisposition`、`criticize`、`assembleCard`、`checkCard`。
- Produces:
  - `A3Input` 新增 `targets?: { kind: TargetKind; id: string; text: string; href?: string }[]`、`watched?: string[]`、`prevStages?: PreResearchStages`
  - `A3Result` 新增 `stages?: PreResearchStages`
  - `PreResearchDoc` 新增 `stages?: PreResearchStages`
  - `runPreResearch` 行为不变的那一半：不给 `targets` 时仍返回 v1 产物、`stages` 为 `undefined`

- [ ] **Step 1: 写失败的测试**

`src/lib/agent/a3/run.v2.test.ts`：

```ts
/*
 * 这一段跑真的 `runPreResearch`，所以要罐头模型。`TKOS_PERSIST=0` 是防御性的：
 * 这个文件不碰 store，但 harness 的依赖链上任何一处将来碰了，快照都不该被测试写脏。
 * 两个赋值必须排在所有 import 之前，模块在 beforeAll 里 await import。
 *
 * **两处桩少一个这个文件就跑不起来**，下面各写清为什么。
 */
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { SearchProvider } from "@/lib/research/search";
import type { A3Input } from "./prompt";
import type { runPreResearch as RunPreResearch } from "./run";

/*
 * 桩一：图谱。`runPreResearch` 无条件 `h.openContext(...)`，而 `Harness` 有意把那里的异常
 * 原样重抛（那段注释明写不许降级成空上下文）；`vitest.config.ts` 不读 env，
 * 所以离线跑到第一个 await 就会死在图谱上，一条断言都轮不到。
 *
 * 姿态照 `src/lib/agent/harness.external.test.ts` 来：`vi.importActual` 展开 + 覆盖
 * `openContext`，**先静态 import 消费方、再动态 import 被 mock 的模块** ——
 * 顺序反了 `vi.importActual` 会把真模块塞进模块缓存。
 *
 * 回的是「开过上下文但转纯外部」那一档（`mode: "external_only"`、`bundle: null`、
 * `anchor: null`）。这**不是将就**：正式包的议题在图谱向量索引里检索不到，
 * 两次真模型整跑走的也正是这一支。
 */
vi.mock("@/lib/graphknowledge", async () => {
  const actual = await vi.importActual<typeof import("@/lib/graphknowledge")>("@/lib/graphknowledge");
  return { ...actual, openContext: vi.fn() };
});

/*
 * 桩二：检索。**离线不打桩的话是有证据入账的**（`providers()` 在 mock 档回 `[MockSearch]`，
 * 它取得到东西），于是下面「这一轮没有外部核验」那两条断言会红。
 * 要那一档就得让源表里那个源一条都取不到 —— 这是测试侧打桩，
 * `src/lib/research/search.ts` 一字未动。
 *
 * 不能直接桩成 `NoSearch`：那个 class 在 `search.ts` 里**没有导出**，
 * 而为了测试去导出它就是改那个文件（硬约束禁止）。所以这里自己拿一个同形状的源顶上，
 * 它在表里、也不抛，就是一条都取不到 —— 这正是缺 key 那一档在生产上的行为。
 */
vi.mock("@/lib/research/search", async () => {
  const actual = await vi.importActual<typeof import("@/lib/research/search")>("@/lib/research/search");
  const none: SearchProvider = {
    name: "none",
    label: "未启用",
    windowed: false,
    reason: "测试桩：这一档表里有源，但一条都取不到",
    async search() {
      return [];
    },
  };
  return { ...actual, providers: () => ({ list: [none], skipped: [] }) };
});

const { openContext } = await import("@/lib/graphknowledge");
const mocked = vi.mocked(openContext);

type Opened = Awaited<ReturnType<typeof openContext>>;

const external = {
  mode: "external_only",
  bundle: null,
  anchor: null,
  noAnchorReason: "离线：这一池分不出高低",
  staticContext: "",
  snapshotId: null,
  trace: [{ at: "2026-08-27T00:00:00.000Z", label: "P3 候选池", kind: "graph", detail: {} }],
  warnings: [],
} as unknown as Opened;

let runPreResearch: typeof RunPreResearch;

beforeAll(async () => {
  mocked.mockResolvedValue(external);
  runPreResearch = (await import("./run")).runPreResearch;
});

const V1: A3Input = {
  issueId: "ISS-901",
  title: "要不要盯住这家新公司",
  scope: null,
  material: "某公司发布了 agent 编排产品，面向国内中大型客户。",
  docs: [],
  judgments: [{ id: "J-2", statement: "今年不会有新玩家", standing: "在版" }],
};

describe("A3 v2", () => {
  it("不给靶点库就还是 v1：模型调用不超过两次、没有 stages", async () => {
    const r = await runPreResearch(V1);
    expect(r.doc.stages).toBeUndefined();
    // `AgentRunRecord` 上**没有** `steps` 这一格 —— 原来那句 `r.run.steps?.length ?? 0`
    // 恒为 0，它对着任何实现都绿。模型调用次数只能从 trace 数：`harness.ts` 里
    // 每次 `callMessages` 都往 trace 里 push 一条 `kind: "model"`。
    // 数出来的是**发起过几次调用**（超时那一支什么都没发出去，也算一次），
    // 拿它当上界正合适 —— v1 这一路一次都不许多叫。
    const modelCalls = r.run.trace.filter((n) => n.kind === "model").length;
    expect(modelCalls).toBeLessThanOrEqual(2);
  });

  it("给了靶点库就走七段，产物上挂得住每一段", async () => {
    const r = await runPreResearch({
      ...V1,
      targets: [{ kind: "judgment", id: "J-2", text: "国内做 agent 编排的公司今年不会有新玩家" }],
      watched: ["渠道代理商"],
    });
    const s = r.doc.stages!;
    expect(s.entities.length).toBeGreaterThan(0);
    expect(s.hits[0].target.id).toBe("J-2");
    expect(s.blindspot.proximity).toBe("adjacent");
    // 这两条成立**全靠文件顶上那个 `search.ts` 的桩**：源表里有一个源，但它一条都取不到，
    // 所以一条证据都没入账。桩去掉的话罐头检索源是取得到东西的，这两条就该红 ——
    // 红了要改的是这里的前提（补桩），不是 `search.ts`，也不是往 `verify.ts` 里加开关。
    expect(s.searchless).toBe(true);
    expect(s.evidence).toEqual([]);
    expect(s.impact.proposalType).toBeDefined();
    expect(["discuss", "watch", "dismiss"]).toContain(s.disposition.action);
    expect(s.card.chars).toBeGreaterThan(0);
  });

  it("每一段的产物都挂得上来源", async () => {
    const r = await runPreResearch({
      ...V1,
      targets: [{ kind: "judgment", id: "J-2", text: "国内做 agent 编排的公司今年不会有新玩家" }],
    });
    const t = r.doc.stages!.disposition.trigger;
    if (t) {
      expect(t.provenance).toEqual({ issueId: "ISS-901", stage: "pre_research" });
      expect(t.status).toBe("proposed");
    }
  });

  it("v2 也不许自动布控 —— 产物里一条 active 都不许有", async () => {
    const r = await runPreResearch({
      ...V1,
      targets: [{ kind: "judgment", id: "J-2", text: "国内做 agent 编排的公司今年不会有新玩家" }],
    });
    const t = r.doc.stages!.disposition.trigger;
    expect(t === null || t.status === "proposed").toBe(true);
  });

  it("同议题第二次预研出的是增量卡", async () => {
    const first = await runPreResearch({
      ...V1,
      targets: [{ kind: "judgment", id: "J-2", text: "国内做 agent 编排的公司今年不会有新玩家" }],
    });
    const second = await runPreResearch({
      ...V1,
      targets: [{ kind: "judgment", id: "J-2", text: "国内做 agent 编排的公司今年不会有新玩家" }],
      prevStages: first.doc.stages,
    });
    expect(second.doc.stages!.card.kind).toBe("increment");
  });

});

/*
 * 原来这里断言的是 `r.violations.every((x) => typeof x === "string")` —— `violations`
 * 是 `Violation[]`（对象），那个 `typeof` 恒假，`every` 只在空数组上偶然为真，
 * 于是 Step 3 那句 `violations = [...violations, ...cardViolations]` 删掉也照样绿。
 * 这个接头是这一段唯一把卡片机检接上去的地方，得有一条真断言绑住它。
 *
 * 卡的第一段就是模型给的说法本身（装配那边第一段无条件放），**说法多长只有模型说得出来**，
 * 靶点文本、材料都改不动它。所以这一条把 `a3.impact` 那份罐头的 `statement` 换长，
 * 让 A3-14（p0）真的报出来。
 *
 * 打的是**假模型**（`models/mock.ts`），不是 `card.ts` 也不是 `run.ts`：生产模块一个没换，
 * 换的只是「模型这一轮说了什么」。姿态照 `a4/pipeline.test.ts` 里那条「罐头全读不出」来 ——
 * 用 `doMock` + `resetModules` 而不是文件顶上的 `vi.mock`，因为上面那几条用例要的是原来的罐头；
 * 重来一遍模块图之后 `@/lib/graphknowledge` 也是新的一份，那一桩要重配一次。
 * （文件顶上 `search.ts` 那一桩是 `vi.mock` 注册的，`resetModules` 之后仍然生效。）
 *
 * **验收标准：把 Step 3 里那句 `violations = [...violations, ...cardViolations];` 删掉，
 * 这一条必须红。它不红，说明卡片机检没接进那份违规清单，Task 11 就没做完。**
 */
describe("卡片机检并进了那一份违规清单", () => {
  afterEach(() => {
    vi.doUnmock("@/lib/models/mock");
    vi.resetModules();
  });

  it("卡真的超了预算时，A3-14 出现在 r.violations 里", async () => {
    vi.doMock("@/lib/models/mock", async () => {
      const actual = await vi.importActual<typeof import("@/lib/models/mock")>("@/lib/models/mock");
      return {
        ...actual,
        mockText: (hint?: string, messages: Parameters<typeof actual.mockText>[1] = []) => {
          const text = actual.mockText(hint, messages);
          if (hint !== "a3.impact") return text;
          // 只把这一格改长，其余照罐头 —— 形状仍然是 `proposeImpact` 读得懂的那一份。
          return JSON.stringify({ ...(JSON.parse(text) as Record<string, unknown>), statement: "那条判断要收窄".repeat(60) });
        },
      };
    });
    vi.resetModules();
    const gk = await import("@/lib/graphknowledge");
    vi.mocked(gk.openContext).mockResolvedValue(external);
    const { runPreResearch: run } = await import("./run");

    const r = await run({
      ...V1,
      targets: [{ kind: "judgment", id: "J-2", text: "国内做 agent 编排的公司今年不会有新玩家" }],
    });
    expect(r.violations.some((v) => v.rule === "A3-14")).toBe(true);
  });
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm vitest run src/lib/agent/a3/run.v2.test.ts`
Expected: FAIL —— 第一条就过不了（`r.doc.stages` 这个属性在 `PreResearchDoc` 上还不存在，`tsc` 与断言双双报错）。

- [ ] **Step 3: 给 `A3Input` 加三个可选字段（`prompt.ts`，在 `judgments` 那一行之后）**

```ts
  /**
   * 靶点库：这条信号可能撞上的既有判断/战略/假设/承诺。
   *
   * **这个字段在不在，就是走 v2 还是走 v1 的开关**。不给就是老的两段行为 ——
   * 既有调用方一行都不用改，也不会因为少传一个字段就静默降级成空靶点。
   */
  targets?: { kind: "judgment" | "strategy" | "hypothesis" | "commitment"; id: string; text: string; href?: string }[];
  /** 他此刻在看的东西（`sensorTargets()` 的文本 + 监控焦点）。判「已经在看」用。 */
  watched?: string[];
  /** 同一议题上一轮预研的各段产物。给了就出增量卡。 */
  prevStages?: PreResearchStages;
```

同时在 `prompt.ts` 顶部加 `import type { PreResearchStages } from "./stages";`。

- [ ] **Step 4: 给 `PreResearchDoc` 加字段（`types.ts`）**

在文件顶部那一组 type-only import 后面加一行（那里已经有 `ReportBlocks` 与 `Evidence` 两个先例，注释也已经解释过反向 import 为什么可以）：

```ts
import type { PreResearchStages } from "@/lib/agent/a3/stages";
```

在 `PreResearchDoc` 的末尾加一个可选字段：

```ts
  /**
   * v2 七段流水的各段产物。**这个字段在不在，就是「这一份跑的是 v2 还是 v1」的答案**
   * —— 照 `ResearchDoc.blocks` 的先例，不加版本号字段。
   */
  stages?: PreResearchStages;
```

- [ ] **Step 5: 改 `run.ts`**

把 `STEPS` / `STEP_TOTAL` 那一对（符号 `STEPS`、`STEP_TOTAL`）换成：

```ts
const STEPS = {
  context: "装配上下文",
  match: "对靶点",
  verify: "外部核验",
  write: "写这一轮预研",
  impact: "算影响",
  critic: "过一道批判",
  card: "装提请卡",
} as const;
/** v1 是两段（装上下文 + 写）。v2 七段 —— 进度条的分母跟着入参走。 */
const STEP_TOTAL_V1 = 2;
const STEP_TOTAL_V2 = 7;
```

`new Harness({...})` 那一处的 `total` 换成 `input.targets ? STEP_TOTAL_V2 : STEP_TOTAL_V1`。

在 `h.step(STEPS.write)` **之前**插入 P1–P3（靶点与核验要先跑完，才能把结论喂给写作那一段）：

```ts
  /*
   * v2 的前三段。
   *
   * **这一轮它们的产物不进写作提示词** —— `buildA3User` 手上仍然只有原来那几段材料，
   * `matched` / `verified` 一个字都没拼进去。放在写作之前只有一个作用：
   * 让 P1–P3 的留痕排在写作前面，回放的时候时序对得上。
   *
   * 别把这段注释读成「写作建立在核验之上」。要真做到那一步，得把靶点命中与证据台账
   * 拼进写作那一次模型调用的输入 —— 那是一次真实的行为改动，会动产出质量，
   * 而这份计划没为它设计过评估。**这条记在末节欠账里，不许在这里顺手加。**
   *
   * 不给 targets 时这一整块跳过，产物与 v1 逐字节相同。
   */
  const prov = makeProvenance(input.issueId);
  let stages: PreResearchStages | undefined;
  const signalText = [input.title, input.material ?? ""].filter(Boolean).join("\n\n");

  let matched: Awaited<ReturnType<typeof matchTargets>> = { entities: [], hits: [], magnitude: "unknown" };
  let verified: Awaited<ReturnType<typeof verifyExternally>> = { evidence: [], searchless: true, groups: 0 };
  let blind = ruleBlindspot({ entities: [], hits: [], evidence: [], watched: [], magnitude: "unknown" });

  if (input.targets) {
    h.step(STEPS.match);
    matched = await matchTargets(h, {
      signalText,
      entities: [],
      targets: narrowTargets(
        [{ name: input.title, kind: "topic" }],
        input.targets.map((t) => ({ ...t })),
      ),
    });
    blind = ruleBlindspot({
      entities: matched.entities,
      hits: matched.hits,
      evidence: [],
      watched: input.watched ?? [],
      magnitude: matched.magnitude,
    });

    h.step(STEPS.verify);
    verified = await verifyExternally(h, {
      question: input.title,
      entities: matched.entities,
      hits: matched.hits,
      blindspot: blind,
      provenance: prov,
    });
    // 拿到证据后重判一次盲区 —— 可信度这一条判据要等外部核验回来才有值可填
    blind = ruleBlindspot({
      entities: matched.entities,
      hits: matched.hits,
      evidence: verified.evidence,
      watched: input.watched ?? [],
      magnitude: matched.magnitude,
    });
  }
```

在既有的返修 `while` 循环**之后**、`h.finish` **之前**插入 P4–P7：

```ts
  const cardViolations: Violation[] = [];
  if (input.targets) {
    h.step(STEPS.impact);
    const { impact } = await proposeImpact(h, {
      question: doc.question,
      material: input.material ?? "",
      hits: matched.hits,
      evidence: verified.evidence,
      searchless: verified.searchless,
    });

    const nowIso = new Date().toISOString();
    const disposition = suggestDisposition({
      impact, blindspot: blind, evidence: verified.evidence, nowIso, provenance: prov,
    });

    h.step(STEPS.critic);
    const critic = await criticize(h, {
      question: doc.question, impact, hits: matched.hits, evidence: verified.evidence,
    });

    h.step(STEPS.card);
    const card = assembleCard({
      kind: input.prevStages ? "increment" : "full",
      impact, disposition, blindspot: blind, evidence: verified.evidence, critic,
    });
    cardViolations.push(...checkCard(card));

    stages = {
      entities: matched.entities,
      hits: matched.hits,
      blindspot: blind,
      evidence: verified.evidence,
      searchless: verified.searchless,
      impact,
      disposition,
      critic,
      card,
    };
    doc.stages = stages;
  }
  // 这一句就是卡片机检唯一的接头。`run.v2.test.ts` 里那条 A3-14 的断言绑的是它 ——
  // 删掉这一句那条测试必须红。
  violations = [...violations, ...cardViolations];
```

`h.finish({...})` 那一处的 `degraded` 已经算过一次，改成把卡片机检的 p0 也算进去：

```ts
  const degraded = blocking(violations).length > 0;
```

（`violations` 原本是 `let`；若当前实现里是 `const`，改成 `let` —— 这是这一处唯一的形状改动。）

`A3Result` 加一格：

```ts
  /** v2 七段的产物。走 v1 时是 `undefined`。 */
  stages?: PreResearchStages;
```

并在 `return` 里带上 `...(stages ? { stages } : {})`。

文件顶部补 import：

```ts
import { assembleCard, checkCard } from "./card";
import { criticize } from "./critic";
import { suggestDisposition } from "./dispose";
import { proposeImpact } from "./impact";
import { makeProvenance } from "./provenance";
import { ruleBlindspot } from "./blindspot";
import type { PreResearchStages } from "./stages";
import { matchTargets, narrowTargets } from "./targets";
import { verifyExternally } from "./verify";
```

- [ ] **Step 6: 跑测试，确认通过**

Run: `pnpm vitest run src/lib/agent/a3/run.v2.test.ts src/lib/agent/a3`
Expected: PASS —— 新文件 6 个全过，而且 `src/lib/agent/a3` 下既有的测试一个都没红（v1 路径逐字节没动）。

- [ ] **Step 7: 记账并提交**

changelog 加一条：`预研长成七段：对靶点、外部核验、写、算影响、批判、装卡，全挂在原来那条链上`；`package.json` 同步。

```bash
git add src/lib/agent/a3/run.ts src/lib/agent/a3/prompt.ts src/lib/agent/a3/run.v2.test.ts src/lib/data/types.ts src/lib/changelog.ts package.json
git commit -m "feat(a3): 把 P1–P7 串进既有 A3 链"
```

---

### Task 12: store 侧的靶点库入参、触发器表与到期清扫

> **这个任务要改 `src/lib/data/store.ts`、`src/lib/data/scope.ts`、`src/lib/data/client.ts` —— 三个文件此刻都有议事对话层 v2 的并行改动在飞。一律以议事对话层 v2 全部落库后的状态为准**：下面给的是要加什么、加在哪个符号附近，不是要照抄的上下文。改之前先 grep 符号名确认当前形状。

规格 §2.2 要一张统一触发器表。这一段把表加进 store（**新键，不进 `SEED_FINGERPRINT`**，因为它是运行时产物不是种子），把靶点库喂给 `ensurePreResearch`，并在读表时顺手清扫过期项。

**Files:**
- Modify: `src/lib/data/store.ts`（符号：store 对象字面量、`ensurePreResearch`、`sensorTargets`、`Api`）
- Modify: `src/lib/data/scope.ts`（符号：`METHOD_SCOPE`）
- Modify: `src/lib/data/client.ts`（符号：`api`）
- Test: `src/lib/data/store.pre-research-v2.test.ts`

**Interfaces:**
- Consumes: `expireTriggers` from `@/lib/agent/a3/trigger`；`PreResearchStages`, `TargetRef`, `TriggerProposal` from `@/lib/agent/a3/stages`；既有的 `sensorTargets()`、`persistSoon()`、`pushEvent()`。
- Produces:
  - `store.triggers: TriggerProposal[]`
  - `store.preResearchPrev: Record<string, PreResearchStages>` —— **跨任务**：这一格在这里声明（下一步那个 `prevStages` 入参读它），往里写的是 Task 15 的 `attachSignalToCard`
  - `buildTargetIndex(): TargetRef[]`（store 内部函数，不出模块）
  - 三个单测专用的窄口钩子（见 Step 1）：`__seedJudgmentForTest(judgment): void`、
    `__seedTriggerForTest(trigger): void`、`__advancePreResearchRoundForTest(issueId): PreResearchStages | undefined`
    —— 都不导出可变引用，各自只开需要的那一格，姿态照 `__seedResearchedIssueForTest` /
    `__seedClosureDraftForTest` 两个先例（**不带运行期闸门** —— 这两个先例本来就没有，见 Step 1 末尾的更正）
  - `api.listTriggers(): Promise<TriggerProposal[]>` —— 只读，读之前先清扫过期
  - `METHOD_SCOPE.listTriggers = "ceo"`、`client.ts` 里 `listTriggers: forward("listTriggers")`

- [ ] **Step 1: 写失败的测试**

`src/lib/data/store.pre-research-v2.test.ts`：

```ts
/*
 * 这两个赋值必须是文件里最早的可执行语句：`store.ts` 在模块顶层就读它们
 * （持久化开关、模型开关），任何一个 import 早于它们，读到的就是没设过的值。
 * 所以下面只留 `import type` 与 vitest 的 import，真正的模块在 beforeAll 里 await import。
 *
 * **这个文件是 live 档**（不设 `TKOS_MODE`，`runMode()` 默认就是 live）。
 * live 档下 `store.issues` / `store.cards` 是空数组（`issues: (DEMO ? clone(dm.issues) : [])`），
 * 所以这里的用例一律**自己造前置状态**，一条种子都不指望。
 *
 * 要种子里那些既有议题与卡的用例（Task 13 / 15 / 16）在另一个文件：
 * `store.pre-research-v2.demo.test.ts`。两个文件分开是因为 `TKOS_MODE` 必须在
 * `store.ts` 被 import 之前定下来，一个进程里定不出两档。
 *
 * **也不要往 `src/lib/data/store.triggers.demo.test.ts` 里加** —— 那个文件测的是
 * 「demo 档两个自动触发点都不起模型」，跟 `store.triggers` 这张表没关系，名字撞了而已。
 */
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { PreResearchStages, TriggerProposal } from "@/lib/agent/a3/stages";
import type { SearchProvider } from "@/lib/research/search";
import type { api as Api } from "./store";
import type { Judgment } from "./types";

/*
 * 下面那条「预研的产物真进了库」要跑一轮真的预研，而 `runPreResearch` 无条件
 * `openContext` 且 `Harness` 有意原样重抛 —— 离线不打这个桩，第一个 await 就死。
 * 姿态照 `src/lib/agent/harness.external.test.ts`：`vi.importActual` 展开 + 覆盖
 * `openContext`，先静态 import 消费方、再动态 import 被 mock 的模块。
 */
vi.mock("@/lib/graphknowledge", async () => {
  const actual = await vi.importActual<typeof import("@/lib/graphknowledge")>("@/lib/graphknowledge");
  return { ...actual, openContext: vi.fn() };
});

/*
 * 检索也要打桩，理由不是「离线跑不起来」（`providers()` 在 mock 档回的是罐头源，
 * 取得到东西），而是**那一档下这条测试要断言的东西不确定**：有证据入账就可能凑够
 * 两组独立源，于是处置建议从「待定」变成「探讨」，而只有待定那一档才产出触发器提案。
 * 让源表里那个源一条都取不到，独立源组数恒为 0，处置恒是待定 —— 那正是缺 key 时
 * 生产上的行为。这是测试侧打桩，`src/lib/research/search.ts` 一字未动；
 * `NoSearch` 那个 class 没有导出，为测试去导出它就是改那个文件（硬约束禁止），
 * 所以这里自己拿一个同形状的源顶上。
 */
vi.mock("@/lib/research/search", async () => {
  const actual = await vi.importActual<typeof import("@/lib/research/search")>("@/lib/research/search");
  const none: SearchProvider = {
    name: "none",
    label: "未启用",
    windowed: false,
    reason: "测试桩：这一档表里有源，但一条都取不到",
    async search() {
      return [];
    },
  };
  return { ...actual, providers: () => ({ list: [none], skipped: [] }) };
});

const { openContext } = await import("@/lib/graphknowledge");

const external = {
  mode: "external_only",
  bundle: null,
  anchor: null,
  noAnchorReason: "离线：这一池分不出高低",
  staticContext: "",
  snapshotId: null,
  trace: [{ at: "2026-08-27T00:00:00.000Z", label: "P3 候选池", kind: "graph", detail: {} }],
  warnings: [],
} as unknown as Awaited<ReturnType<typeof openContext>>;

let api: typeof Api;

beforeAll(async () => {
  vi.mocked(openContext).mockResolvedValue(external);
  api = (await import("./store")).api;
});

function proposal(over: Partial<TriggerProposal> = {}): TriggerProposal {
  return {
    id: "TG-ISS-901-1",
    condition: "那家公司公布了国内客户名单",
    targetRef: { kind: "judgment", id: "J-2", text: "今年不会有新玩家" },
    source: "watch",
    onFire: "proposeDiscuss",
    expiresAt: "2099-01-01T00:00:00.000Z",
    status: "proposed",
    provenance: { issueId: "ISS-901", stage: "pre_research" },
    ...over,
  };
}

/**
 * 靶点库是从 `store.judgments` map 出来的，而 live 档下那张表也是空的。
 * 这条判断的正文要和下面那个议题标题有字面重叠 —— `narrowTargets` 按二元组重叠预筛，
 * 重叠为 0 的靶点根本进不了送给模型的候选清单。编号必须是 `J-2`：罐头
 * （`mock.ts` 的 `a3.targets`）回的命中就是这个编号，清单上没有的编号会被丢掉。
 */
function judgment(): Judgment {
  return {
    id: "J-2",
    domainId: "01",
    kind: "hypothesis",
    statement: "国内做 agent 编排的公司今年不会有新玩家",
    version: 1,
    standing: "unverified",
    confirmedBy: "",
    confirmedAt: "2026-01-01T00:00:00.000Z",
    freshUntil: "2099-01-01T00:00:00.000Z",
    basis: [],
    revisions: [],
    reopenTriggers: [],
    shakenBy: [],
    verifiedByTasks: 0,
  };
}

/** 等这一轮预研跑到不再是 running。全程进程内的假模型，正常几十毫秒就到。 */
const settle = async (issueId: string) => {
  for (let i = 0; i < 200; i++) {
    const st = await api.preResearchStatus(issueId);
    if (st.status !== "running") return st;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("预研四秒还没跑完 —— 假模型下不该发生");
};

describe("触发器表", () => {
  it("空表读得出来，不是 undefined", async () => {
    expect(Array.isArray(await api.listTriggers())).toBe(true);
  });

  it("读表时顺手把过期的清成 expired", async () => {
    (await import("./store")).__seedTriggerForTest(
      proposal({ id: "TG-X-1", status: "active", expiresAt: "2020-01-01T00:00:00.000Z" })
    );
    const list = await api.listTriggers();
    expect(list.find((t) => t.id === "TG-X-1")!.status).toBe("expired");
  });

  it("已经开过火的那条不会被清扫改掉", async () => {
    (await import("./store")).__seedTriggerForTest(proposal({
      id: "TG-X-2", status: "fired", firedAt: "2021-01-01T00:00:00.000Z", expiresAt: "2020-01-01T00:00:00.000Z",
    }));
    const list = await api.listTriggers();
    expect(list.find((t) => t.id === "TG-X-2")!.status).toBe("fired");
  });
});

/*
 * 这一段测的是 Step 4 那个生产接头本身：靶点库真喂进了那一轮，那一轮的触发器提案
 * 真进了表，上一轮的 stages 真从 `preResearchPrev` 喂了回去。
 *
 * 为什么非要有它：这三件事此前全计划一条断言都没有 —— Step 4 整段删掉，
 * 其余每一条测试照样绿。而这几行正是预研跟库之间唯一的接头。
 *
 * 两轮写在同一条用例里，因为第二轮的前置状态就是第一轮的产物：分成两条用例
 * 就得靠执行顺序传状态，那种耦合下一个人一改就断。
 */
describe("预研跑完之后：靶点喂进去、提案进表", () => {
  it("跑一轮真的预研 —— 靶点库进了那一轮，触发器提案落进表且是 proposed；第二轮出增量卡", async () => {
    const { __seedJudgmentForTest, __advancePreResearchRoundForTest } = await import("./store");

    /*
     * 判断要在 `addIssue` **之前**塞进去：那个方法落卡之后当场就叫
     * `ensurePreResearch`，而靶点库是在那一刻 map 出来的，晚一步就赶不上这一轮。
     */
    __seedJudgmentForTest(judgment());

    const issue = await api.addIssue("智谱 AI 公布了国内客户名单，今年还会不会有新玩家");
    const first = await settle(issue.id);
    expect(first.status).toBe("done");

    /*
     * 靶点这一格：命中里有 `J-2`，就说明 `targets: buildTargetIndex()` 真的传下去了 ——
     * 不传的话 `runPreResearch` 走的是 v1 那一路，`stages` 整格都是 `undefined`。
     *
     * `__advancePreResearchRoundForTest` 顺手把这份 `stages` 搬到 `preResearchPrev`、
     * 删掉 `preResearch[issueId]`（就是 Task 15 `attachSignalToCard` 的那两步手动动作），
     * 断言完这一段就已经站在第二轮该在的起点上了。
     */
    const stages = __advancePreResearchRoundForTest(issue.id);
    expect(stages).toBeDefined();
    expect(stages!.hits.map((h) => h.target.id)).toContain("J-2");

    /*
     * 提案这一格：进了表，而且是 `proposed`。**`active` 一条都不许有** ——
     * 转 active 只发生在他按下待定那一下（Task 13）。走 `listTriggers()` 这个只读
     * 生产入口断言，不直接摸 `store.triggers`。
     */
    const mine = (await api.listTriggers()).filter((t) => t.provenance.issueId === issue.id);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.id.startsWith("TG-")).toBe(true);
    expect(mine[0]!.status).toBe("proposed");
    /*
     * 只查这一轮自己产出的那几条，不查整张表：上面那几条用例往表里塞过一条
     * `status: "active"` 的假数据（测清扫用的），对整张表断言「没有 active」
     * 会绿在别的用例的执行顺序上，而不是绿在这一条要证明的事情上。
     */
    expect(mine.some((t) => t.status === "active")).toBe(false);

    /*
     * 第二轮：从同一个公开入口再跑一轮。出的是增量卡，就说明 `prevStages`
     * 那一格真的读的是 `preResearchPrev`（上一步 `__advancePreResearchRoundForTest`
     * 已经把它摆到位）。
     */
    await api.startPreResearch(issue.id);
    const second = await settle(issue.id);
    expect(second.status).toBe("done");
    const afterStages = __advancePreResearchRoundForTest(issue.id);
    expect(afterStages!.card.kind).toBe("increment");
  });
});
```

**验收标准（这一条不满足，Task 12 就没做完）**：把 Step 4 新加的那两处 —— `targets`/`watched`/`prevStages` 那三行入参，和收提案进表那一段 —— **整段删掉，这条测试必须红**。它不红，说明这个接头仍然是零覆盖的，删了没人知道。

**这三个单测专用的窄口钩子要一起加上**（`store.ts` 上今天还没有它们）。`store.ts` 已经有 `__seedResearchedIssueForTest` / `__seedClosureDraftForTest` 两个先例，注释里写着为什么不 `export { store }`：所有写都该经过 `api`（角色门、`touch`、`pushEvent`、`persistSoon` 都挂在那一层），导出可变引用等于给每个模块开一道「改了库不留痕」的门。**这两个先例都没有运行期闸门** —— 挡的办法只是名字自带警告、和只开需要的那一格，没有 `TKOS_PERSIST` 判断那一层。下面这三个照同一个姿态办，**不额外加运行期闸门**（上一版这里给 `__storeForTest()` 加的那道 `TKOS_PERSIST` 闸门是误加，`plan-rulings-2.md` P1-9 已经更正）：

```ts
/**
 * **单测专用。** 塞一条判断进 `store.judgments`，供 `buildTargetIndex()` 命中。
 *
 * 为什么需要它：判断在产品里只有真实的立案与研判流程能产出，而这条测试要在
 * `addIssue` **之前**把靶点摆好 —— `addIssue` 落卡之后当场就叫 `ensurePreResearch`，
 * 靶点库是那一刻 map 出来的，晚一步就赶不上这一轮。这里只开 `judgments` 这一格。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __seedJudgmentForTest(judgment: Judgment): void {
  store.judgments.push(clone(judgment));
}

/**
 * **单测专用。** 塞一条触发器提案进 `store.triggers`，可以带任意 `status` / `expiresAt`。
 *
 * 为什么需要它：测到期清扫（`listTriggers` 读表时把过期项判成 `expired`）与测
 * `disposeCard` 的转正 / 作废分支（Task 13），都要从一条「已经在表里、状态和到期
 * 时间摆好」的提案起步。产品里没有能摆出任意状态的写入口 —— 提案只从预研那一轮
 * 自然产出，起手必是 `proposed`，`expiresAt` 也不是任由调用方定的 —— 只能从这里进。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __seedTriggerForTest(trigger: TriggerProposal): void {
  store.triggers.push(clone(trigger));
}

/**
 * **单测专用。** 把一个议题这一轮的 `stages` 搬到 `preResearchPrev`、删掉
 * `preResearch[issueId]`，也就是 Task 15 `attachSignalToCard` 的那两步手动动作，
 * 并把搬走前的 `stages` 原样返回给调用方断言。
 *
 * 为什么需要它：这两步在生产上只有 `attachSignalToCard` 会做，而它今天在生产上
 * 没有任何调用方（末节欠账第一条）。要测「第二轮读 `prevStages` 出增量卡」，
 * 得先有个入口把第一轮的产物摆到第二轮该在的起点上 —— 不这样做就只测得到
 * 「有没有传参」，测不到 `prevStages` 这条线真的通。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __advancePreResearchRoundForTest(issueId: string): PreResearchStages | undefined {
  const stages = store.preResearch[issueId]?.stages;
  if (stages) {
    store.preResearchPrev[issueId] = clone(stages);
    delete store.preResearch[issueId];
  }
  return stages;
}
```

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm vitest run src/lib/data/store.pre-research-v2.test.ts`
Expected: FAIL，`api.listTriggers is not a function`。

- [ ] **Step 3: 加 store 键与靶点库**

在 store 对象字面量里、紧挨 `preResearch` 那一行之后加：

```ts
  /**
   * 统一触发器表（规格 §2.2）。**运行时产物，不进 `SEED_FINGERPRINT`** ——
   * 它不是种子的一部分，指纹里多一个键会让每次预研都判成「种子变了」。
   *
   * 旧快照里没有这个键，而 `Object.assign(store, restored)` 只覆盖存在的键，
   * 所以加它对已有快照是安全的。
   */
  triggers: [] as TriggerProposal[],
  /**
   * 上一轮预研的各段产物，按议题号存。**这一格在这里就要加上**，因为下一步
   * 那个 `prevStages` 入参读的就是它。
   *
   * 为什么不读 `preResearch[issueId]?.stages`：`ensurePreResearch` 第一句就是
   * `if (store.preResearch[issueId]) return { status: "done" }` —— 走到下面那行
   * `runPreResearch(...)` 时，`store.preResearch[issueId]` 必然不在，所以按它取
   * 恒为 `undefined`，那个入参永远喂不进去。
   *
   * 谁往这一格里写：Task 15 的 `attachSignalToCard` —— 同一件事又来一条信号时，
   * 它把上一份 `stages` 搬到这里、再 `delete store.preResearch[issueId]`，
   * 于是下一轮跑得起来，而且手上有上一轮可比。
   *
   * **但生产上今天没有一处调那个函数，所以这一格实际一直是空的，增量卡在生产上
   * 出不来。** 入库那一处只做「可能是同一件事」的标注，真的合卡要他按一下，
   * 而那个入口还没有（计划末节欠账第一条）。这里照旧读它、不写死成 `undefined`，
   * 是因为那个入口做出来时改的应该只有一处调用，不是这一路的取值。
   *
   * 同样是运行时产物，不进 `SEED_FINGERPRINT`。
   */
  preResearchPrev: {} as Record<string, PreResearchStages>,
```

`store.ts` 今天只从 A3 那边取一个值（`import { runPreResearch } from "@/lib/agent/a3/run"`），所以 `TriggerProposal` / `TargetRef` / `PreResearchStages` 三个名字要新加一条 `import type { ... } from "@/lib/agent/a3/stages"`，另加 `import { expireTriggers } from "@/lib/agent/a3/trigger"`（这个是值）。

在 `sensorTargets` 附近加靶点库构造（同样是内部函数，不出模块）：

```ts
/**
 * 靶点库：这一轮预研可能撞上的既有判断。
 *
 * **只装在版判断**。`TargetKind` 里另外留着战略/假设/承诺三类，但 store 里今天
 * 只有判断这一类既有 `id` 又有可比的正文；把承诺按标题塞进去会让靶点匹配
 * 在没有正文可比的东西上瞎猜。等那几类有正文可读时再往这里加。
 */
function buildTargetIndex(): TargetRef[] {
  return store.judgments.map((j) => ({
    kind: "judgment" as const,
    id: j.id,
    text: j.statement,
    href: `/judgments/${j.id}`,
  }));
}
```

- [ ] **Step 4: 把靶点库喂给 `ensurePreResearch`**

在 `ensurePreResearch` 里那一处 `runPreResearch({...})` 的入参上加三格（其余入参一个不动）：

```ts
      targets: buildTargetIndex(),
      watched: sensorTargets().map((t) => t.text),
      // 读的是搬开的那一份，不是 `store.preResearch[issueId]?.stages` —— 后者在这一行
      // 恒为 `undefined`（函数第一句已经把「这一份在」的那一档 return 掉了），
      // 写成那样等于留一个永不成立的三元。理由与谁来填这一格见上一步的字段注释。
      ...(store.preResearchPrev[issueId] ? { prevStages: store.preResearchPrev[issueId] } : {}),
```

紧随其后、`store.preResearch[issueId] = {...}` 那一处之后，把这一轮产出的触发器**提案**收进表里：

```ts
    /*
     * 收进表的是**提案**（`status: "proposed"`）。这里一条都不布控：
     * 转 active 只发生在他按下待定那一下（`disposeCard` 的 watch 分支），
     * 而 `ReopenTrigger.armed` 仍然只由 `confirmCandidate` / `confirmClosure` 写。
     */
    const proposed = r.doc.stages?.disposition.trigger;
    if (proposed && !store.triggers.some((t) => t.id === proposed.id)) {
      store.triggers.push(proposed);
    }
```

- [ ] **Step 5: 加只读的 `listTriggers`**

在 `api` 对象里（挨着 `listSensorTargets` 放，它们是同一类读口）：

```ts
  /**
   * 读触发器表。**读之前顺手清扫过期项** —— 没有定时器，清扫挂在读上：
   * 表只在有人看它的时候才需要是干净的，而这样就不必引入一个后台循环。
   *
   * 返回的是一个新数组，不是表本体 —— 姿态和旁边的 `sensorTargets()` 一致。
   * 交出本体等于任何拿到它的调用方都能 `push`/`splice` 库里的表，而那条路上
   * 没有 `touch`、没有 `pushEvent`、没有 `persistSoon`：改了库、屏幕上没痕迹。
   */
  async listTriggers() {
    const { next, expired } = expireTriggers(store.triggers, nowIso());
    if (expired.length > 0) {
      store.triggers = next;
      console.warn(`[tkos:pre] 清掉 ${expired.length} 条到期的监控条件：`, expired.join("、"));
      persistSoon();
    }
    return [...store.triggers];
  },
```

`scope.ts` 的 `METHOD_SCOPE` 里加 `listTriggers: "ceo",`（挨着 `listSensorTargets`）。`client.ts` 的 `api` 里加 `listTriggers: forward("listTriggers"),`。这两处不加就编译不过（`Record<RpcMethod, Scope>` 与 `const api: Api` 各自会报 key 缺失）—— 那是这两张表存在的全部价值。

- [ ] **Step 6: 跑测试，确认通过**

Run: `pnpm vitest run src/lib/data/store.pre-research-v2.test.ts`
Expected: PASS（4 个）。

- [ ] **Step 7: 记账并提交**

changelog 加一条：`监控条件进了一张统一的表，读表时把到期的清掉并说清清了哪几条`；`package.json` 同步。

```bash
git add src/lib/data/store.ts src/lib/data/scope.ts src/lib/data/client.ts src/lib/data/store.pre-research-v2.test.ts src/lib/changelog.ts package.json
git commit -m "feat(store): 统一触发器表与靶点库入参"
```

---

### Task 13: 待定这一下由人按，按了才开始监控

> **这个任务要改 `src/lib/data/store.ts`，以议事对话层 v2 全部落库后的状态为准。**

这是整份计划里最要紧的一处。规格 §2.2 写的是「自动进本表 → 预研自动开始监控」。**本计划不实现那条自动路**：预研只写得到 `proposed`；提案变成真的在监控，发生在他按下「待定」那一下 —— `api.disposeCard(cardId, "watch")`。那是一次真实的人按下，不是新开一道确认门。

`ReopenTrigger.armed` 这一层完全不碰：布控仍然只由 `api.confirmCandidate` / `api.confirmClosure` 写。

**Files:**
- Modify: `src/lib/data/store.ts`（符号：`api.disposeCard`）
- Create: `src/lib/data/store.pre-research-v2.demo.test.ts` —— **demo 档，本任务新建这个文件**（Task 15 / 16 之后往里追加）

**Interfaces:**
- Consumes: `store.triggers`（Task 12）、既有的 `pushEvent`、`nowIso`、`persistSoon`、`viewer()`。
- Produces: `api.disposeCard` 的行为增量 —— watch 分支把本议题下 `status === "proposed"` 的触发器转 `active`；discuss / dismiss 两支各自的处理（见下）。

- [ ] **Step 1: 写失败的测试（新文件，demo 档）**

下面这五条用的是**种子里既有的议题与卡**（`store.issues[0..4]`，卡上有原文、`judgmentRefs` 上挂着判断），而 live 档下 `store.issues` / `store.cards` 是空数组（`issues: (DEMO ? clone(dm.issues) : [])`）—— 所以它们不能放进 Task 12 那个文件，得有一个 demo 档的：

`src/lib/data/store.pre-research-v2.demo.test.ts`：

```ts
/*
 * **这个文件是 demo 档。** 三个开关必须是文件里最早的可执行语句：`store.ts` 在模块
 * 顶层就读它们，`TKOS_MODE` 尤其如此 —— 一个进程里定不出两档，所以 live 档那些用例
 * 在另一个文件（`store.pre-research-v2.test.ts`）。姿态照 `store.triggers.demo.test.ts`。
 *
 * 为什么要 demo 档：下面这几条要的是**种子里既有的**议题与卡（卡上有原文、
 * `judgmentRefs` 上挂着判断）。live 档下这两张表是空的，现造一条就得把这些都补齐，
 * 等于在测试里重写一遍种子。
 *
 * **不要往 `src/lib/data/store.triggers.demo.test.ts` 里加** —— 那个文件测的是
 * 「demo 档两个自动触发点都不起模型」，跟 `store.triggers` 这张新表没关系，名字撞了而已。
 */
process.env.TKOS_MODE = "demo";
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

import { beforeAll, describe, expect, it } from "vitest";
import type { TriggerProposal } from "@/lib/agent/a3/stages";
import type { api as Api } from "./store";

let api: typeof Api;

beforeAll(async () => {
  api = (await import("./store")).api;
});

/** 和 live 档那个文件里的同名夹具一样一份 —— 两个文件不共享模块状态，各自摆自己的。 */
function proposal(over: Partial<TriggerProposal> = {}): TriggerProposal {
  return {
    id: "TG-ISS-901-1",
    condition: "那家公司公布了国内客户名单",
    targetRef: { kind: "judgment", id: "J-2", text: "今年不会有新玩家" },
    source: "watch",
    onFire: "proposeDiscuss",
    expiresAt: "2099-01-01T00:00:00.000Z",
    status: "proposed",
    provenance: { issueId: "ISS-901", stage: "pre_research" },
    ...over,
  };
}

describe("待定这一下由人按", () => {
  it("他按下待定，本议题的提案才转 active", async () => {
    const { __nthDemoCardForTest, __seedTriggerForTest } = await import("./store");
    const { issue, card } = __nthDemoCardForTest(0);
    __seedTriggerForTest(proposal({ id: "TG-W-1", provenance: { issueId: issue.id, stage: "pre_research" } }));

    await api.disposeCard(card.id, "watch");

    expect((await api.listTriggers()).find((t) => t.id === "TG-W-1")!.status).toBe("active");
  });

  it("他按下议一议 —— 提案作废，不是转 active（这一条要去研究，不是去盯着）", async () => {
    const { __nthDemoCardForTest, __seedTriggerForTest } = await import("./store");
    const { issue, card } = __nthDemoCardForTest(1);
    __seedTriggerForTest(proposal({ id: "TG-D-1", provenance: { issueId: issue.id, stage: "pre_research" } }));

    await api.disposeCard(card.id, "discuss");

    expect((await api.listTriggers()).find((t) => t.id === "TG-D-1")!.status).toBe("expired");
  });

  it("他按下不看了 —— 提案作废", async () => {
    const { __nthDemoCardForTest, __seedTriggerForTest } = await import("./store");
    const { issue, card } = __nthDemoCardForTest(2);
    __seedTriggerForTest(proposal({ id: "TG-X-3", provenance: { issueId: issue.id, stage: "pre_research" } }));

    await api.disposeCard(card.id, "dismiss", "不相干");

    expect((await api.listTriggers()).find((t) => t.id === "TG-X-3")!.status).toBe("expired");
  });

  it("按待定这一下一条重开条件都不布控 —— armed 只由确认那一下写", async () => {
    const { __nthDemoCardForTest, __seedTriggerForTest, __countArmedReopenTriggersForTest } =
      await import("./store");
    const before = __countArmedReopenTriggersForTest();
    const { issue, card } = __nthDemoCardForTest(3);
    __seedTriggerForTest(proposal({ id: "TG-W-2", provenance: { issueId: issue.id, stage: "pre_research" } }));

    await api.disposeCard(card.id, "watch");

    const after = __countArmedReopenTriggersForTest();
    expect(after).toBe(before);
  });

  it("别的议题的提案不受影响", async () => {
    const { __nthDemoCardForTest, __seedTriggerForTest } = await import("./store");
    const { card } = __nthDemoCardForTest(4);
    __seedTriggerForTest(proposal({ id: "TG-OTHER", provenance: { issueId: "别的议题", stage: "pre_research" } }));

    await api.disposeCard(card.id, "watch");

    expect((await api.listTriggers()).find((t) => t.id === "TG-OTHER")!.status).toBe("proposed");
  });
});
```

**这两个单测专用的窄口钩子跟着这一步一起加**（`store.ts` 上今天还没有它们；`__seedTriggerForTest` 复用 Task 12 已经加的那个）。姿态照 `__seedResearchedIssueForTest` / `__seedClosureDraftForTest` 两个先例，**不加运行期闸门**（理由见 Task 12 那一段）：

```ts
/**
 * **单测专用。** 取种子里第 n 条议题与它的卡（demo 档种子按下标稳定，五条用例
 * 各取不同的一条，互不干扰）。
 *
 * 为什么需要它：这五条用例要的是**种子里既有的**议题与卡（卡上有原文、
 * `judgmentRefs` 上挂着判断），不是现造一条 —— 现造一条得把这些字段都补齐，
 * 等于在测试里重写一遍种子。只读，不改任何一格。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __nthDemoCardForTest(n: number): { issue: Issue; card: Card } {
  const issue = store.issues[n]!;
  const card = store.cards.find((c) => c.issueId === issue.id)!;
  return { issue: clone(issue), card: clone(card) };
}

/**
 * **单测专用。** 数一下眼下所有判断上 `armed: true` 的重开条件一共有几条。
 *
 * 为什么需要它：这一条要证明的是「按待定这一下**不**布控」——`ReopenTrigger.armed`
 * 只由 `confirmCandidate` / `confirmClosure` 写，`disposeCard` 不许碰这一格。
 * 断言只要一个数，不需要谁能拿到 `judgments` 整张表去改它，所以只交出这一个
 * 派生出来的数。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __countArmedReopenTriggersForTest(): number {
  return store.judgments.flatMap((j) => j.reopenTriggers.filter((t) => t.armed)).length;
}
```

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm vitest run src/lib/data/store.pre-research-v2.demo.test.ts`
Expected: FAIL —— 第一条就红（`status` 仍是 `"proposed"`，`disposeCard` 还没碰这张表）。

- [ ] **Step 3: 改 `api.disposeCard`**

**锚点先说清**（改之前 grep 一遍确认形状）：`disposeCard` 的尾巴是 `touch(issue, at)` → `pushEvent(...)` → `return hydrateIssue(issue)`，**没有 `persistSoon()` 这一句**。三个动作分支都不 `return`，都汇到 `touch(issue, at)` 这一行，所以「共用收尾」这个位置本身是成立的 —— 新加的这一段放在 **`touch(issue, at)` 之前**：

```ts
    /*
     * 预研备好的监控条件在这里定生死。**这是它唯一的转正路径**：
     * `proposed → active` 只发生在他按下「待定」那一下 —— 这一下是真实的人按下，
     * 所以不需要（也不许）另开一道确认门。
     *
     * 按了议一议或不看了，那些提案就作废（`expired`）：议一议的这一条要去做研究，
     * 不是挂着盯；不看了的更不该在表上留一条会自己冒出来的监控。
     *
     * 这一段一条 `ReopenTrigger.armed` 都不写 —— 布控仍然只由
     * `confirmCandidate` / `confirmClosure` 写，那是他按确认那一下。
     */
    const mine = store.triggers.filter(
      (t) => t.provenance.issueId === issue.id && t.status === "proposed",
    );
    for (const t of mine) {
      t.status = action === "watch" ? "active" : "expired";
    }
    if (mine.length > 0) {
      pushEvent(issue.id, {
        // 复用函数开头那个 `at`（`const at = nowIso()`，在 `findIssue` 下面那一行），
        // **不要再取一次时间**：同一次处置写出两个时间戳，台账排序上就栽过一次。
        id: `E-${issue.id}-tg-${at}`,
        kind: "deep",
        at,
        headline:
          action === "watch"
            ? `开始监控 ${mine.length} 条条件`
            : `作废 ${mine.length} 条备好的监控条件`,
        // 和同一个函数里那条既有事件一致：这一下是他按的，署他的名。
        actor: viewer().name,
        detail: mine.map((t) => `${t.condition}（挂在 ${t.targetRef.id}）`).join("\n"),
        /*
         * `TimelineEvent.defaultOpen` 是**必填**的（`actor`/`detail` 才是可选的），
         * 漏了编译不过。按那个字段自己的口径：组织动作与状态迁移导向判断（展开）、
         * 过程性内容不导向判断（折叠）—— 这一条是状态迁移，而且是他自己按出来的，
         * 所以展开。
         */
        defaultOpen: true,
      });
      /*
       * 真翻了东西才落盘、才报版本。理由不是口径，是 `persistSoon` 自己的文档写的：
       * 「哪里算是真的写了东西」在这个文件里只有一个答案 —— 叫过它的那四十来处，
       * 新加的写操作照旧叫一次，推送就自动带上了。触发器从 `proposed` 翻到 `active`
       * 是一次真实的库变更；不叫它，他按下的那一下可能既不落盘也不上屏。
       *
       * **只管新加的这一格。** `disposeCard` 既有那些写操作（议题状态、卡上的处置、
       * 归域）今天也没有落盘这一下 —— 那是本任务范围之外的既有状况，不在这里顺手补：
       * 补它是改既有行为。
       */
      persistSoon();
    }
```

- [ ] **Step 4: 跑测试，确认通过**

Run: `pnpm vitest run src/lib/data/store.pre-research-v2.demo.test.ts src/lib/data/store.judgements.test.ts`
Expected: PASS —— 新的 5 条全过，判断那一组既有测试一条都没红（`armed` 的写入方没变）。

- [ ] **Step 5: 记账并提交**

changelog 加一条：`预研备好的监控条件要等他按下待定才开始生效，按议一议或不看了就作废`；`package.json` 同步。

```bash
git add src/lib/data/store.ts src/lib/data/store.pre-research-v2.demo.test.ts src/lib/changelog.ts package.json
git commit -m "feat(store): 待定这一下由人按，按了才开始监控"
```

---

### Task 14: 反确认 —— 方向相反的信号加权，且不许因为方向相反被扔掉

规格 §0.3 与 §5 场景 3：与既有判断方向相反的信号要**加权**，不是降权；而且不许有任何一条因为「跟我们的假设不符」被判成不看了。这一段给出一个可排序的分数，并在处置建议里加一道硬拦。

**Files:**
- Modify: `src/lib/agent/a3/stages.ts`（符号：`PreResearchStages`）
- Modify: `src/lib/agent/a3/dispose.ts`（符号：`suggestDisposition`，新增 `cardPriority`）
- Modify: `src/lib/agent/a3/run.ts`（符号：`runPreResearch` 里那个 `stages` 对象字面量）
- Test: `src/lib/agent/a3/dispose.test.ts`（追加一组）

**Interfaces:**
- Consumes: `TargetHit` from `./stages`（`suggestDisposition` 的入参多一格）。
- Produces:
  - `PreResearchStages` 新增 `priority?: number`
  - `CONTRA_WEIGHT = 2`
  - `cardPriority(o: { hits: readonly TargetHit[]; blindspot: BlindspotRuling; evidence: readonly EvidenceLite[] }): number`
  - `suggestDisposition` 入参新增可选 `hits?: readonly TargetHit[]`（不给按空数组，所以既有调用与既有测试一行都不用改）

- [ ] **Step 1: 追加失败的测试**

在 `src/lib/agent/a3/dispose.test.ts` 末尾追加：

```ts
import { cardPriority, CONTRA_WEIGHT } from "./dispose";
import type { TargetHit } from "./stages";

const supportHit: TargetHit = { target, match: "supports", why: "跟原判断一致", hops: 1 };
const contraHit: TargetHit = { target, match: "challenges", why: "跟原判断相反", hops: 1 };

describe("反确认", () => {
  it("同等强度下，方向相反的排在支持方向前面", () => {
    const evidence = [ev("E1", "dom:a"), ev("E2", "dom:b")];
    const contra = cardPriority({ hits: [contraHit], blindspot: blind, evidence });
    const support = cardPriority({ hits: [supportHit], blindspot: blind, evidence });
    expect(contra).toBeGreaterThan(support);
    expect(contra / support).toBeCloseTo(CONTRA_WEIGHT, 5);
  });

  it("强度更高的支持方向信号，不会被弱的相反方向信号盖住", () => {
    const strong = cardPriority({ hits: [supportHit], blindspot: blind, evidence: [ev("E1", "dom:a"), ev("E2", "dom:b"), ev("E3", "dom:c"), ev("E4", "dom:d")] });
    const weakContra = cardPriority({ hits: [contraHit], blindspot: blind, evidence: [ev("E1", "dom:a")] });
    expect(strong).toBeGreaterThan(weakContra);
  });

  it("盲区也加权 —— 他没在看的东西不该排在末尾", () => {
    const evidence = [ev("E1", "dom:a")];
    expect(cardPriority({ hits: [], blindspot: blind, evidence }))
      .toBeGreaterThan(cardPriority({ hits: [], blindspot: { ...blind, isBlindspot: false }, evidence }));
  });

  it("方向相反的一律不判「不看了」 —— 哪怕量级判成不够", () => {
    const r = suggestDisposition({
      impact: { ...impact, impactType: "outOfScope", proposalType: "noAction" },
      blindspot: { ...blind, isBlindspot: false, magnitude: "immaterial" },
      evidence: [], nowIso: now, provenance: prov, hits: [contraHit],
    });
    expect(r.action).toBe("watch");
    expect(r.why).toContain("方向相反");
  });

  it("方向一致又不相干的，照旧判「不看了」", () => {
    const r = suggestDisposition({
      impact: { ...impact, impactType: "outOfScope", proposalType: "noAction" },
      blindspot: { ...blind, isBlindspot: false, magnitude: "immaterial" },
      evidence: [], nowIso: now, provenance: prov, hits: [supportHit],
    });
    expect(r.action).toBe("dismiss");
  });
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm vitest run src/lib/agent/a3/dispose.test.ts`
Expected: FAIL，`cardPriority is not exported`（以及最后两条断言在 `suggestDisposition` 上还没有 `hits` 这一格）。

- [ ] **Step 3: 在 `dispose.ts` 里加分数与硬拦**

在文件顶部的 import 里补 `TargetHit`（与既有的类型 import 合并）：

```ts
import type {
  BlindspotRuling, DispositionSuggestion, EvidenceLite, ImpactProposal, Provenance, TargetHit,
} from "./stages";
```

加常量与打分函数：

```ts
/**
 * 方向相反的信号的加权倍数。
 *
 * 加权而不是降权 —— 这是这一层最容易做反的地方：一条跟既有判断相反的信号，
 * 在任何按「与现有认知的一致度」排序的系统里都会自然沉底，而它恰恰是最该被看到的那条。
 * 系统的职责包括把反证推到他面前。
 */
export const CONTRA_WEIGHT = 2;

/** 盲区的加权倍数。他没在看的东西不该排在末尾。 */
export const BLINDSPOT_WEIGHT = 1.5;

/**
 * 提请卡的排序分数。**只用于排序，不参与任何分流判定** ——
 * 分流由 `suggestDisposition` 的机械规则定，两件事混在一个数里就都说不清了。
 *
 * 基数取独立源组数（这是「强度」唯一可核的度量），再乘方向与盲区两个权。
 */
export function cardPriority(o: {
  hits: readonly TargetHit[];
  blindspot: BlindspotRuling;
  evidence: readonly EvidenceLite[];
}): number {
  const strength = Math.max(1, independentGroupCount(o.evidence));
  const contra = o.hits.some((x) => x.match === "challenges") ? CONTRA_WEIGHT : 1;
  const blind = o.blindspot.isBlindspot ? BLINDSPOT_WEIGHT : 1;
  return strength * contra * blind;
}
```

在 `suggestDisposition` 的入参里加一格（放在 `provenance` 之后）：

```ts
  /** 这一轮的靶点命中。不给按空数组 —— 只用于那道「方向相反不许扔」的硬拦。 */
  hits?: readonly TargetHit[];
```

并在函数体最前面（`worthless` 那一段**之前**）加：

```ts
  /*
   * 硬拦：方向相反的信号不许判成「不看了」。
   *
   * 这条拦的是确认偏误最贵的那一种表现 —— 一条动摇既有判断的信号被判成不相干，
   * 从此他再也看不到它。量级判得不够就先待定（盯着），不是扔掉。
   */
  const contra = (o.hits ?? []).some((x) => x.match === "challenges");
```

把 `worthless && !wantsChange` 那一支的条件改成 `worthless && !wantsChange && !contra`，并在函数末尾那条 `watch` 的 `why` 上补一句（`contra` 为真时）：

```ts
  const why = wantsChange
    ? `要动既有判断，但只有 ${groups} 组独立源 —— 先盯着，命中了再请他看`
    : contra
      ? "这条信号跟既有判断方向相反，量级还看不清 —— 方向相反的不扔，先盯着"
      : "这件事挨着他在管的事，但这一轮还提不出要动什么";
```

- [ ] **Step 4: 在 `stages.ts` 的 `PreResearchStages` 末尾加一格**

```ts
  /** 提请台上的排序分数（`cardPriority`）。只用于排序，不参与分流。 */
  priority?: number;
```

- [ ] **Step 5: 在 `run.ts` 里把两处接上**

`suggestDisposition({...})` 的入参加 `hits: matched.hits,`；`stages = {...}` 那个字面量加：

```ts
      priority: cardPriority({ hits: matched.hits, blindspot: blind, evidence: verified.evidence }),
```

并把 `import { suggestDisposition } from "./dispose";` 改成 `import { cardPriority, suggestDisposition } from "./dispose";`。

- [ ] **Step 6: 跑测试，确认通过**

Run: `pnpm vitest run src/lib/agent/a3/dispose.test.ts src/lib/agent/a3/run.v2.test.ts`
Expected: PASS —— 新的 5 条全过，Task 8 与 Task 11 的既有断言一条都没红（`hits` 是可选的）。

- [ ] **Step 7: 记账并提交**

changelog 加一条：`跟既有判断相反的信号加权靠前，而且一律不许因为方向相反被判成不看了`；`package.json` 同步。

```bash
git add src/lib/agent/a3/dispose.ts src/lib/agent/a3/stages.ts src/lib/agent/a3/run.ts src/lib/agent/a3/dispose.test.ts src/lib/changelog.ts package.json
git commit -m "feat(a3): 反确认加权与「方向相反不许扔」"
```

---

### Task 15: P0 的这一半 —— 入库时标注「可能是同一件事」

规格 P0 + §5 场景 1：同一事件连着来五天，只许出 ≤1 张新卡加增量卡，纯转载零产出。**这一段落在入库那一处（A1a），不在 A3 链里** —— 因为卡是 `issueFromSignal` 在信号入库时就建的，等 A3 跑起来早就晚了。

A1a 已经在路由 `update_issue` / `new_issue` / `ignore` 三条路；这一段是在 `update_issue` 那条路上补上「并到哪条、这次多了什么」，不新开路由。

**这一段做的是标注，不是合卡。** 先把这条线划清，因为整段代码都跟着它：

- **不合卡、不撤卡、不改那条旧议题的任何字段、不动 `applyA1aInbox` 已有的返回语义。** 照旧建那条新议题、照旧返回 `{ applied, issueId }`，只多一格可选的返回字段。
- 为什么不做真的合卡：`apply.ts` 自己的注释写着 `update_issue` 的产出是**一条取代旧议题的新议题**，而「取代成不成立是一号位采信那一下的事」—— 所以这一路今天不改旧议题的任何字段，**而且是有意不改的**。真要合，等于替他判定「这两件事是同一件」，那得由他按一下：那是另一个入口、另一次确认，不在这份计划里。
- 所以规格 P0 想要的「同议题聚合」这一轮只做到**标注 + 差异**。这条记进末节的欠账，不许在任何注释里写得像已经合了。

**Files:**
- Create: `src/lib/agent/a1a/delta.ts`
- Modify: `src/lib/agent/a1a/apply.ts`（符号：`applyA1aInbox`）
- Modify: `src/lib/data/types.ts`（符号：`Card`，加一格可选字段）
- Modify: `src/lib/data/store.ts`（`ensurePreResearch` 上方新增 `attachSignalToCard` 与 `noteMaybeSameIssue`）
- Test: `src/lib/agent/a1a/delta.test.ts`
- Test: `src/lib/data/store.pre-research-v2.demo.test.ts`（Task 13 建的那个文件，追加一组）

**Interfaces:**
- Consumes: `bigramOverlap` from `@/lib/agent/overlap`（**不是** `a3/targets`，见 Task 4）；`sentences` from `@/lib/agent/rules`；`AggregateVerdict` from `@/lib/agent/a3/stages`；既有的 `issueFromSignal`、`issueExists`、`pushEvent`、`nowIso`、`persistSoon`。
- Produces:
  - `SAME_MIN = 0.9`、`SEPARATE_MAX = 0.3`
  - `declareDelta(o: { incoming: string; existing: string }): { verdict: AggregateVerdict; delta: string[]; overlap: number }`
  - `Card` 新增 `maybeSameIssue?: { issueId: string; delta: string[] }`（`types.ts`，只加不改）
  - `applyA1aInbox` 的返回类型新增同名同形的一格可选字段：`maybeSameIssue?: { issueId: string; delta: string[] }`
  - `noteMaybeSameIssue(newIssueId: string, incoming: string): { issueId: string; delta: string[] } | null`（`store.ts` 的导出内部函数）
  - `attachSignalToCard(issueId: string, o: { delta: string[]; signalId: string }): void`（`store.ts` 的导出内部函数，不上 `api`、不进 `METHOD_SCOPE` —— 跟 `issueFromSignal` 同类）
  - 五个单测专用的窄口钩子（见 Step 6，Task 16 那一组也用它们）：`__seedIssueWithCardForTest(issue, card): void`、
    `__getCardForTest(issueId): Card | undefined`、`__countCardsForTest(): number`、
    `__seedPreResearchDocForTest(issueId, doc): void`、
    `__getPreResearchRoundForTest(issueId): { cur: PreResearchDoc | undefined; prev: PreResearchStages | undefined }`
    —— 都不导出可变引用，读的那三个交出克隆，各自只开需要的那一格，姿态照 `__seedResearchedIssueForTest` /
    `__seedClosureDraftForTest` 两个先例（**不带运行期闸门** —— 这两个先例本来就没有，见 Task 12 Step 1 末尾那段）
  - **`store.preResearchPrev` 不在这里声明** —— 那一格由 Task 12 加（它那一步就要读它），这一步只往里写

- [ ] **Step 1: 写失败的测试**

`src/lib/agent/a1a/delta.test.ts`：

```ts
import { describe, expect, it } from "vitest";
import { declareDelta, SAME_MIN, SEPARATE_MAX } from "./delta";

describe("declareDelta", () => {
  it("纯转载 —— 判成同一条，且一个字的增量都没有", () => {
    const text = "某公司发布了 agent 编排产品，面向国内中大型客户。";
    const r = declareDelta({ incoming: text, existing: text });
    expect(r.verdict).toBe("merged");
    expect(r.delta).toEqual([]);
    expect(r.overlap).toBeGreaterThanOrEqual(SAME_MIN);
  });

  it("同一件事但多了一句新的 —— 并进去，并说清多了哪一句", () => {
    const r = declareDelta({
      existing: "某公司发布了 agent 编排产品，面向国内中大型客户。",
      incoming: "某公司发布了 agent 编排产品，面向国内中大型客户。首批签了三家银行。",
    });
    expect(r.verdict).toBe("merged");
    expect(r.delta).toEqual(["首批签了三家银行。"]);
  });

  it("完全是另一件事 —— 自成一条", () => {
    const r = declareDelta({
      existing: "某公司发布了 agent 编排产品，面向国内中大型客户。",
      incoming: "监管出了新规，要求金融机构的模型调用留全量日志。",
    });
    expect(r.verdict).toBe("separate");
    expect(r.overlap).toBeLessThan(SEPARATE_MAX);
  });

  it("既有那一份是空的 —— 自成一条（没有可并的东西）", () => {
    expect(declareDelta({ existing: "", incoming: "任何一句话。" }).verdict).toBe("separate");
  });

  it("增量里不含既有那份已经说过的句子", () => {
    const r = declareDelta({
      existing: "甲发布了产品。乙签了银行。",
      incoming: "乙签了银行。甲发布了产品。丙拿了新一轮融资。",
    });
    expect(r.delta).toEqual(["丙拿了新一轮融资。"]);
  });
});
```

- [ ] **Step 2: 跑它，确认失败**

Run: `pnpm vitest run src/lib/agent/a1a/delta.test.ts`
Expected: FAIL，`Failed to resolve import "./delta"`。

- [ ] **Step 3: 写 `delta.ts`**

```ts
import { sentences } from "@/lib/agent/rules";
// `bigramOverlap` 从 `@/lib/agent/overlap` 取，**不从 `a3/targets` 取**：那个文件顶上挂着
// `Harness` 与 `a3/prompt.ts`，从那里 import 会让 A1a 的模块图上多出整条 A3 依赖（见 Task 4）。
import { bigramOverlap } from "@/lib/agent/overlap";
import type { AggregateVerdict } from "@/lib/agent/a3/stages";

/** 重叠到这个程度就当同一条 —— 纯转载落在这一档，它该零产出。 */
export const SAME_MIN = 0.9;

/** 低到这个程度就当另一件事。中间那一段判成同一条但带增量。 */
export const SEPARATE_MAX = 0.3;

/**
 * 这条新信号是并进既有那条议题，还是自成一条；并的话多了哪几句。
 *
 * 机械判，不调模型：A1a 已经为「这是不是那条老议题」付过一次模型调用了
 * （`update_issue` 这条路由就是它的结论），这里要答的是更机械的一问 ——
 * **文本上多了什么**。同一个问题问两次模型，只会多一次说法不一致。
 *
 * 增量按句子取，而不是按整段：五天里同一事件的报道往往前半段一字不差、
 * 末尾多一句新进展，按段比会把整段判成新的。
 */
export function declareDelta(o: {
  incoming: string;
  existing: string;
}): { verdict: AggregateVerdict; delta: string[]; overlap: number } {
  const existing = o.existing.trim();
  if (!existing) return { verdict: "separate", delta: [], overlap: 0 };

  const overlap = bigramOverlap(o.incoming, existing);
  if (overlap < SEPARATE_MAX) return { verdict: "separate", delta: [], overlap };

  const old = sentences(existing);
  const delta = sentences(o.incoming).filter((s) => !old.some((t) => bigramOverlap(s, t) >= SAME_MIN));
  return { verdict: "merged", delta, overlap };
}
```

- [ ] **Step 4: 在 store 里加 `attachSignalToCard` 与上一轮产物**

`store.preResearchPrev` 这一格**已经由 Task 12 声明过了**（它那一步的 `prevStages` 入参就读它），这里不要再加一遍 —— 这一步只加往里写的那个函数。

加内部函数（放在 `ensurePreResearch` 上方）：

```ts
/**
 * 把一条确认为同一件事的信号挂到既有那张卡上，并让下一轮预研出增量卡。
 *
 * **不新建议题、不新建卡** —— 这正是防卡片疲劳那一条：同一事件五天的信号流
 * 只该留下一张卡加若干次增量。挪走 `preResearch[issueId]` 是为了让
 * `ensurePreResearch` 能再跑一轮；挪之前把 `stages` 存到 `preResearchPrev`，
 * 那一份是增量卡要拿来比的东西。
 *
 * **这一轮生产上没有任何地方调它。** 入库那一处只做标注（`noteMaybeSameIssue`），
 * 因为「这两条是同一件事」这个判定要他按一下才成立；按下去的那个入口还没有，
 * 记在计划末节的欠账第一条。放在这里是为了把库这一侧的形状先钉住：
 * 挂哪几句、上一轮的产物挪到哪一格、时间线上留什么，都由下面这几条测试锁着，
 * 等那个入口做出来时不用重新想一遍。**不要因为它暂时没有调用方就把它删掉，
 * 也不要为了给它凑一个调用方而在入库处自动合卡。**
 */
export function attachSignalToCard(issueId: string, o: { delta: string[]; signalId: string }): void {
  const card = store.cards.find((c) => c.issueId === issueId);
  if (!card || o.delta.length === 0) return;

  const at = nowIso();
  for (const text of o.delta) {
    card.what.push({ text, traces: [{ kind: "ext", source: o.signalId }] });
  }

  const prev = store.preResearch[issueId];
  if (prev?.stages) store.preResearchPrev[issueId] = prev.stages;
  delete store.preResearch[issueId];

  pushEvent(issueId, {
    id: `E-${issueId}-attach-${at}`,
    kind: "deep",
    at,
    headline: `同一件事又来了一条，多了 ${o.delta.length} 句`,
    actor: "您的 Agent",
    detail: o.delta.join("\n"),
    /*
     * `defaultOpen` 是**必填**的（漏了编译不过）。按那个字段自己的口径：这一条是
     * 过程性内容 —— 材料多了几句，没有任何决定发生 —— 所以折叠。
     */
    defaultOpen: false,
  });
  persistSoon();
}
```

`ensurePreResearch` 里那个 `prevStages` 入参**一行都不用改** —— Task 12 从一开始写的就是读 `store.preResearchPrev[issueId]`。三处读法（Task 11 的测试、Task 12 的入参、这里的写入）是同一格、同一个形状：`Record<string, PreResearchStages>` 直接装 `stages`，**不是**装一个还要再 `.stages` 一次的文档对象。

**这一格在生产上仍然是空的，Task 15 落了也一样。** 因为上面那句：没人调 `attachSignalToCard`。所以**增量卡这一轮在生产上出不来** —— 测试里出得来（Task 12 那条第二轮的用例自己往这一格里塞），生产上要等合卡那个入口。这句话不许写软，也不许在任何注释里把增量卡说成已经能跑。

**`attachSignalToCard` 不做成注入回调。** `apply.ts` 第一行 import 就是 `from "@/lib/data/store"`（`issueExists` / `issueFromSignal` / `markCardAgentVerdict`）—— 方向本来就是 apply → store，没有环可避，多一层可选回调只是多一层。改之前 grep 一遍那行 import 确认。

- [ ] **Step 5: 入库那一处加「可能是同一件事」的标注（不合卡）**

先说清这一步**不做什么**，因为原来这里写的五处前提在真代码上一处都不成立（都核过了）：`applyA1aInbox` 的返回类型是 `{ applied: string; issueId?: string }`（没有 `attachedTo`/`delta` 这种形状）；函数体里**没有** `decision` 这个变量（它按 `run.route` 分路）；`materialOf` / `existingMaterialOf` 这两个函数**不存在**；`sig` 上**没有 `id`**（幂等键叫 `dedupeKey`）；而最要紧的一处 —— `sig.judged?.issueId && issueExists(...)` 这个条件和函数开头那句 `if (already && issueExists(already))` **逐字重合**，所以那样写的分支永远走不到。

还有一处：`judged.issueId` 的语义是「**这条信号自己开出来的**那条议题」，不是「它可能撞上的那条既有议题」。拿它当「并到哪条」用，方向是反的。所以「可能是同一件事的那条既有议题」**得自己算**。

**5a. `types.ts` 给 `Card` 加一格（只加不改）**

先在 `Card` 上找过一遍：没有现成能装这件事的字段（`materialNote` 是抓取/截断的备注，`agentVerdict` 是「调研后判为噪音」那一档），`InboxSignalMeta.judged.issueId` 更不是（语义如上）。所以加一格：

```ts
  /**
   * 入库时算出来的：这条信号可能和哪条既有议题说的是同一件事，以及相对那一条多了哪几句。
   *
   * **它是「可能」，不是「已并入」。** 这一层没有合卡：卡照旧新建一张，那条旧议题
   * 一个字段都没动。`update_issue` 的取代成不成立，是一号位采信那一下的事
   * （见 `a1a/apply.ts` 那段注释）—— 所以这里只把算出来的关系摆上来给他看。
   * 屏幕上的措辞照这个口径写：「这条和 ISS-xxx 说的可能是同一件事」。
   *
   * 算不出来（一条都不过阈值）就没有这个字段 —— 不编一个。
   */
  maybeSameIssue?: { issueId: string; delta: string[] };
```

**5b. `store.ts` 加 `noteMaybeSameIssue`**（放在 `attachSignalToCard` 旁边）

```ts
/**
 * 这条刚入库的信号，可能和哪条既有议题说的是同一件事。
 *
 * 为什么算在 store 这一侧：要比的是 `store.issues` 的标题和卡上的原文，而那是库里的东西。
 * 为什么不让模型自填一个议题号：那要改 A1a 的提示词，而 A1a 的写回本身还挂着
 * `NotWiredYet` —— 提示词定稿是他的事，不在这份计划里。
 *
 * 机械判，不调模型：二元组重叠取最高分，**过阈值才算**。一条都不过就返回 null，
 * 那时候卡上那一格不写 —— 编一个「可能是同一件事」比不写更贵，他会去点开看，
 * 然后发现两件事没关系。
 *
 * 阈值不在这里定：取到最高分那一条之后交给 `declareDelta`，判成 `"separate"` 就是没有。
 * 这样阈值只有 `delta.ts` 里那一个数（`SEPARATE_MAX`），不会出现两处口径各调一次。
 *
 * **它不合卡、不撤卡、不改那条既有议题的任何字段**，只在新建的那张卡上标一格、
 * 在时间线上留一条。真正的合卡要他按一下，那是另一个入口（末节欠账里记着）。
 */
export function noteMaybeSameIssue(
  newIssueId: string,
  incoming: string,
): { issueId: string; delta: string[] } | null {
  const text = incoming.trim();
  if (!text) return null;

  let best: { issueId: string; existing: string; overlap: number } | null = null;
  for (const issue of store.issues) {
    if (issue.id === newIssueId) continue;
    const card = store.cards.find((c) => c.issueId === issue.id);
    // 比的是「标题 + 卡上原文」——单比标题会把同一事件的两条报道判成两件事
    // （标题各写各的），单比原文会漏掉卡上还没有原文的那些议题。
    const existing = [issue.title, ...(card?.what ?? []).map((w) => w.text)].join("\n");
    const overlap = bigramOverlap(text, existing);
    if (!best || overlap > best.overlap) best = { issueId: issue.id, existing, overlap };
  }
  if (!best) return null;

  const d = declareDelta({ incoming: text, existing: best.existing });
  if (d.verdict === "separate") return null;

  const card = store.cards.find((c) => c.issueId === newIssueId);
  if (!card) return null;
  const out = { issueId: best.issueId, delta: d.delta };
  card.maybeSameIssue = out;

  const at = nowIso();
  pushEvent(newIssueId, {
    id: `E-${newIssueId}-same-${at}`,
    kind: "deep",
    at,
    // 措辞就是屏幕上那一句：**「可能是同一件事」，不是「已并入」**。
    headline: `这条和 ${best.issueId} 说的可能是同一件事`,
    actor: "您的 Agent",
    detail:
      d.delta.length > 0
        ? `相对那一条，这次多了：\n${d.delta.join("\n")}`
        : "相对那一条，这次一句新的都没有（纯转载）。",
    // 过程性内容，没有决定发生 —— 折叠（同 `attachSignalToCard` 那条）。
    defaultOpen: false,
  });
  persistSoon();
  return out;
}
```

`declareDelta` 与 `bigramOverlap` 分别从 `@/lib/agent/a1a/delta` 和 `@/lib/agent/overlap` 取（`store.ts` 已经 import 了 a1a 的东西，这条边是现成的方向；`overlap.ts` 是零依赖的叶子）。

**5c. `apply.ts` 的尾巴多带一格**

`update_issue` / `new_issue` 那一段的建法**一个字都不改**（照旧 `issueFromSignal`），只在返回前加一次标注：

```ts
  const issue = issueFromSignal(sig, run.output ?? {}, run.id);
  if (!issue) {
    return { applied: "A1a 的产出里没有议题正文，未建议题。" };
  }
  /*
   * 规格 P0 的那一半：**算出来、标上去，不合卡。**
   *
   * 这一步之后旧议题上一个字段都没动，新议题照旧建了 —— 变的只是新那张卡上多一格
   * 「可能和 ISS-xxx 说的是同一件事」。`update_issue` 与 `new_issue` 两条路都做这一下：
   * 「是不是同一件事」是文本上的问题，跟模型把它路由成哪一条无关。
   */
  const sameAs = noteMaybeSameIssue(issue.id, [sig.title, sig.text].filter(Boolean).join("\n\n"));
  return {
    applied: `已开成议题 ${issue.id}：${issue.title}`,
    issueId: issue.id,
    ...(sameAs ? { maybeSameIssue: sameAs } : {}),
  };
```

返回类型跟着加一格：`{ applied: string; issueId?: string; maybeSameIssue?: { issueId: string; delta: string[] } }`。**函数体里那四处提前返回（已开过议题、运行失败、判为噪音、没有议题正文）一个字都不改**，新那一格是可选的，所以现有调用方全都编译得过。核过：这四处加最后这一处，就是 `applyA1aInbox` 的全部返回点。

`noteMaybeSameIssue` 从 `@/lib/data/store` 取，加进第一行那条既有的 import 里。

- [ ] **Step 6: 追加 store 侧的测试**

往 **Task 13 建的那个 demo 档文件** `src/lib/data/store.pre-research-v2.demo.test.ts` 末尾追加。**不要新开文件、也不要往 live 档那个文件里加**：这四条都要卡上有原文可比，而 live 档 `store.cards` 是空的。

这几条自己造议题和卡，不按下标去取种子里的第几条（`store.issues[5]` 这种写法一旦种子顺序变了就换成了另一条议题，而且这个文件里的四组测试会互相踩）：

**这五个单测专用的窄口钩子跟着这一步一起加**（`store.ts` 上今天还没有它们；Task 16 那一组也用它们）。姿态照 `__seedResearchedIssueForTest` / `__seedClosureDraftForTest` 两个先例，**不加运行期闸门**（理由见 Task 12 那一段）。读的那三个**交出克隆，不交活引用** —— 这一点下面 `seedIssue` 的注释里写清了为什么它比握活引用更严：

```ts
/**
 * **单测专用。** 塞一条议题和它的卡，供这一组用例从「库里已经有这一条」这个起点出发。
 *
 * 为什么需要它：这几条要的是「卡上的原文逐字可比」，而且每条得有一条**只属于自己的**
 * 议题（按下标取种子里第几条，种子顺序一变就换成了另一条，同文件几组用例还会互相踩）。
 * 走 `api.addIssue` 那条真入口不行：它落卡之后当场就叫 `ensurePreResearch`，会往
 * `store.preResearch[issueId]` 写一份，正好压掉下面几条自己摆的那一份；卡上的字段也是
 * A1a 那一路写的，跟这里要比的原文对不上。这里只开 `issues` / `cards` 这两格，不交出任何引用。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __seedIssueWithCardForTest(issue: Issue, card: Card): void {
  store.issues.push(clone(issue));
  store.cards.push(clone(card));
}

/**
 * **单测专用。** 按议题号取那张卡，**返回克隆**。
 *
 * **为什么返回克隆而不是那张卡本身**：交出活引用，调用方就只能断言「那个对象被原地改了」——
 * 哪天实现改成**替换**卡对象（`store.cards[i] = { ...card, what }`），活引用指向的还是旧那个，
 * 断言要么假绿要么红得莫名其妙。交克隆逼着调用方在动作之后**重新读一次**，断的是可观察状态，
 * 那才是屏幕和下游真正依赖的东西。这不是窄口的退让，是更严的测法。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __getCardForTest(issueId: string): Card | undefined {
  const card = store.cards.find((c) => c.issueId === issueId);
  return card ? clone(card) : undefined;
}

/**
 * **单测专用。** 数一下眼下 `store.cards` 里一共几张卡。
 *
 * 为什么需要它：「有增量就挂到老卡上，**不新建卡**」这条断言只要一个数 —— 不需要
 * 谁能拿到 `cards` 整张表，所以只交出这一个派生出来的数。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __countCardsForTest(): number {
  return store.cards.length;
}

/**
 * **单测专用。** 往 `store.preResearch` 里填一份预研文档（`PreResearchDoc`，就是那张表的类型）。
 *
 * 为什么需要它：这份文档在产品里只有真模型写得出来（A3 预研那一轮），而单测里一次模型
 * 调用都不许打（`vitest.config.ts` 文件头）。测「挂完信号之后上一轮产物搬进
 * `preResearchPrev`」和「Discuss 接缝把台账/靶点带进上下文」，都得从「这一轮的产物已经
 * 在库里」这个起点出发。姿态与 `__seedClosureDraftForTest` 一模一样：只填这一格。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __seedPreResearchDocForTest(issueId: string, doc: PreResearchDoc): void {
  store.preResearch[issueId] = clone(doc);
}

/**
 * **单测专用。** 读一个议题的「这一轮」与「上一轮」两格，**都是克隆**。
 *
 * 为什么需要它、为什么是这两格一起：`attachSignalToCard` 干的就是**把这一轮搬到上一轮**
 * 这一个动作，断言它成没成必须同时看两格（`cur` 空了、`prev` 有了）——分成两个钩子反而
 * 让调用方拼出这层意思。`preResearchPrev` 这一格在产品侧**没有任何读出口**（它只被
 * `ensurePreResearch` 当入参读一次，不上 `api`），所以这一格只能从这里读；Task 16 那一组
 * 读 `cur` 也走它，不必再为同一件事开第二个口。
 *
 * 为什么不 `export { store }`：见上面 `__seedResearchedIssueForTest` 那一段注释。
 */
export function __getPreResearchRoundForTest(
  issueId: string
): { cur: PreResearchDoc | undefined; prev: PreResearchStages | undefined } {
  const cur = store.preResearch[issueId];
  const prev = store.preResearchPrev[issueId];
  return { cur: cur ? clone(cur) : undefined, prev: prev ? clone(prev) : undefined };
}
```

```ts
/**
 * 造一条只给这几条用的议题与卡。塞进去就完事，**不返回任何引用**。
 *
 * **为什么不把 store（或那张卡）交回给调用方**：`store.ts` 的约定是所有写都经过 `api`
 * （角色门、`touch`、`pushEvent`、`persistSoon` 都挂在那一层），导出可变引用等于给每个
 * 模块开一道「改了库不留痕」的门。所以下面每条用例都是**动作跑完之后重新读一次**
 * （`__getCardForTest` / `api.getIssue` / `api.getTimeline`），断言读回来的那份上有没有那个变化。
 *
 * **这不是将就，是更严的测法。** 握着活引用只能证明「那个对象被原地改了」：要是哪天
 * 实现改成**替换**卡对象而不是原地改它（`store.cards[i] = { ...card, what }`），活引用
 * 指向的还是那个旧对象，断言要么假绿要么红得莫名其妙 —— 两种都不是在测产品行为。
 * 重新读一次测的是**可观察状态**，而可观察状态才是屏幕和下游真正依赖的东西。
 *
 * **写成 `const x: Issue` / `const x: Card`，不用 `as`**：这两个类型上有十来个必填格
 * （`Card` 要 `headline`/`source`/`why`/`strategyRef`/`suggestion`/`refs`/`domainIds`），
 * 戴上 `as` 就等于把它们的契约挡在编译之外，那正是这一轮在别处拆掉的东西。
 * 字段的取法照 `issueFromSignal` 建卡那一段来（同一套口径，包括「不知道动摇哪条判断」那句）。
 */
const seedIssue = async (id: string, title: string, what: string[]) => {
  const at = "2026-08-27T00:00:00.000Z";
  const issue: Issue = {
    id,
    title,
    state: "Candidate",
    origin: "signal",
    judgmentRefs: [],
    nextActionForUser: null,
    raisedAt: at,
    updatedAt: at,
  };
  const card: Card = {
    id: id.replace("ISS-", "CARD-"),
    issueId: id,
    headline: title,
    source: { kind: "radar" },
    what: what.map((text) => ({ text, traces: [] })),
    why: "系统还没查过。",
    strategyRef: { id: "", statement: "这一条还不知道动摇哪条判断 —— 图谱里没有它的锚点。" },
    suggestion: { text: "先只决定一件事：值不值得占您的时间。", traces: [] },
    refs: [],
    domainIds: [],
    createdAt: at,
  };
  const { __seedIssueWithCardForTest } = await import("./store");
  __seedIssueWithCardForTest(issue, card);
};

describe("同一件事再来一条", () => {
  it("有增量就挂到老卡上，不新建卡", async () => {
    await seedIssue("ISS-T15A", "甲发布了 agent 编排产品", ["甲发布了 agent 编排产品。"]);
    const { __countCardsForTest, __getCardForTest, attachSignalToCard } = await import("./store");
    const before = __countCardsForTest();

    attachSignalToCard("ISS-T15A", { delta: ["首批签了三家银行。"], signalId: "SIG-9" });

    // 动作之后**重新读一次** —— 断言的是库里读得出来什么，不是某个对象被原地改没改
    expect(__countCardsForTest()).toBe(before);
    expect(__getCardForTest("ISS-T15A")!.what.map((w) => w.text)).toContain("首批签了三家银行。");
  });

  it("挂完之后上一份产物留在 preResearchPrev 里，下一轮才出得了增量卡", async () => {
    await seedIssue("ISS-T15B", "乙拿了新一轮融资", ["乙拿了新一轮融资。"]);
    const { __seedPreResearchDocForTest, __getPreResearchRoundForTest, attachSignalToCard } =
      await import("./store");
    // 这一份是手写的：生产上没人调 `attachSignalToCard`（见 Step 4 那段注释），
    // 所以「上一轮有产物」这个前提只能在测试里自己摆出来。
    __seedPreResearchDocForTest("ISS-T15B", {
      issueId: "ISS-T15B", status: "valid", statusReason: "r", question: "q", take: "t",
      finding: [], openQuestion: [], soWhat: "s", byAgentLabel: "您的 Agent", assembledFrom: [],
      at: "2026-08-27T00:00:00.000Z",
      stages: {
        entities: [], hits: [],
        blindspot: { isBlindspot: false, proximity: "far", hops: null, credibility: null, magnitude: "unknown", why: [] },
        // `evidence` 空、`searchless` 为真 —— 这两格是同一件事的两面（见 Task 1 那格的注释）。
        evidence: [], searchless: true,
        impact: { impactType: "outOfScope", proposalType: "noAction", targetRef: null, statement: "x", basis: [] },
        disposition: { action: "dismiss", why: "w", trigger: null },
        critic: { pass: true, checks: [], why: [], modelSlot: null },
        card: { kind: "full", headline: "h", body: "b", basis: [], chars: 1 },
      },
    });

    attachSignalToCard("ISS-T15B", { delta: ["又多了一句。"], signalId: "SIG-10" });

    // 「这一轮搬到上一轮」是**一个**动作，两格一起读才断得出它成没成
    const round = __getPreResearchRoundForTest("ISS-T15B");
    expect(round.prev).toBeDefined();
    expect(round.cur).toBeUndefined();
  });

  it("零增量（纯转载）什么都不动", async () => {
    await seedIssue("ISS-T15C", "丙出了新规", ["丙出了新规。"]);
    const { __getCardForTest, attachSignalToCard } = await import("./store");
    const whatBefore = __getCardForTest("ISS-T15C")!.what.length;

    attachSignalToCard("ISS-T15C", { delta: [], signalId: "SIG-11" });

    expect(__getCardForTest("ISS-T15C")!.what.length).toBe(whatBefore);
  });
});

describe("入库时标注「可能是同一件事」", () => {
  it("标在新那张卡上，而旧议题一个字段都没动", async () => {
    await seedIssue("ISS-T15D", "丁开始给银行做模型日志留存", ["丁开始给银行做模型日志留存。"]);
    await seedIssue("ISS-T15E", "另起一条", []);
    const { __getCardForTest, noteMaybeSameIssue } = await import("./store");
    const oldUpdatedAt = (await api.getIssue("ISS-T15D")).updatedAt;
    const oldWhat = __getCardForTest("ISS-T15D")!.what.length;
    /*
     * 去向记录挂在 `store.timelines[issueId]` 这张表上，**不在 `issue` 上**（`Issue` 没有
     * `timeline` 这一格 —— `pushEvent` 写的是 `store.timelines[issueId] ??= []`）。
     * 这一格产品侧有现成的真读路 `api.getTimeline`（`METHOD_SCOPE` 上是 `"ceo"`，跟这个
     * 文件已经在用的 `api.disposeCard` / `api.advisorContext` 同一档），所以不为它开钩子。
     * 它倒序返回，而这里只数条数、只 `some`，跟顺序无关。
     */
    const oldEvents = (await api.getTimeline("ISS-T15D")).length;

    /*
     * incoming 里**逐字包含** ISS-T15D 自己的标题与原文，所以它跟那一条的二元组重叠
     * 是全表最高的（跟自己比不可能被别人超过）—— 这条断言不靠种子里恰好没有更像的议题。
     */
    const r = noteMaybeSameIssue(
      "ISS-T15E",
      "丁开始给银行做模型日志留存。首批三家银行已经上线。",
    );

    expect(r?.issueId).toBe("ISS-T15D");
    expect(r?.delta).toEqual(["首批三家银行已经上线。"]);
    // 新那张卡上有这一格（动作之后重新读一次）
    expect(__getCardForTest("ISS-T15E")!.maybeSameIssue?.issueId).toBe("ISS-T15D");
    // **旧那条一个字段都没动**：没多原文、没多事件、`updatedAt` 没被推
    expect(__getCardForTest("ISS-T15D")!.what.length).toBe(oldWhat);
    expect((await api.getTimeline("ISS-T15D")).length).toBe(oldEvents);
    expect((await api.getIssue("ISS-T15D")).updatedAt).toBe(oldUpdatedAt);
    // 那一条留痕落在**新**议题上（这件事是新那条的属性）
    expect((await api.getTimeline("ISS-T15E")).some((e) => e.headline.includes("可能是同一件事"))).toBe(true);
  });

  it("没有像的就不写这一格，也不编一条", async () => {
    await seedIssue("ISS-T15F", "又另起一条", []);
    const { __getCardForTest, noteMaybeSameIssue } = await import("./store");
    expect(noteMaybeSameIssue("ISS-T15F", "戊在南极架了一台望远镜。")).toBeNull();
    expect(__getCardForTest("ISS-T15F")!.maybeSameIssue).toBeUndefined();
  });
});
```

文件头那条 import 跟着加：`import type { Card, Issue } from "./types";`（Task 13 建这个文件时只 import 了 `TriggerProposal`）。

**验收标准（这两条不满足，Task 15 就没做完）**：

- 把 5c 里 `noteMaybeSameIssue(...)` 那一行连同返回里那一格删掉 → 「标在新那张卡上」这条必须红。
- 把 5b 里 `if (d.verdict === "separate") return null;` 改成无条件往下写 → 「没有像的就不写这一格」这条必须红。

`attachSignalToCard` 与 `noteMaybeSameIssue` 都写成 `export function`，从 `store.ts` 直接导出 —— **不新建 `store.testing.ts` 那种一层**。理由是这个文件已经这么办了：`issueFromSignal`、`inboxSignalDispose`、`reportSignal` 都是导出的内部函数，不上 `api`、不进 `METHOD_SCOPE`，因此也不过角色门。这两格跟它们同类，没必要为它们另起一个文件。

- [ ] **Step 7: 跑测试，确认通过**

Run: `pnpm vitest run src/lib/agent/a1a src/lib/data/store.pre-research-v2.demo.test.ts`
Expected: PASS —— `delta.test.ts` 5 条、demo 档那个文件里 Task 13 的 3 条加这一步新增的 5 条，a1a 既有的测试一条都没红。

- [ ] **Step 8: 记账并提交**

changelog 加一条：`一条信号进来时会说清它和哪条既有议题可能是同一件事、这次多了哪几句`；`package.json` 同步。**这句话里不许出现「合并」「聚合」** —— 这一轮没有合卡，changelog 是给他看的，写成合了就是假账。

```bash
git add src/lib/agent/a1a/delta.ts src/lib/agent/a1a/delta.test.ts src/lib/agent/a1a/apply.ts src/lib/data/types.ts src/lib/data/store.ts src/lib/data/store.pre-research-v2.demo.test.ts src/lib/changelog.ts package.json
git commit -m "feat(a1a): 入库时标注可能是同一件事，并说清多了哪几句"
```

---

### Task 16: P7.4 Discuss 接缝 —— 证据编号不变、零重取

规格 P7.4：点 Discuss 开轻量会话，静态前缀里「报告正文」那个槽位换成「卡片四段 + evidence-lite 台账 + 命中的靶点对象」，其余（system prompt、工具、判断机制、记忆注入）原样复用。§5 场景 5 要的是**证据对象 ID 全程不变、零重取**。

这个接缝**已经在了** —— `buildAdvisorContext` 里那一支 `pre && !store.researchDocs[issueId]` 就是「只有预研、还没有深研」的那一档。这一段是给它补上台账与靶点，不是新开一条上下文装配路径。

**Files:**
- Modify: `src/lib/agent/a3/evidence-lite.ts`（新增 `buildLiteIndex`）
- Modify: `src/lib/data/store.ts`（符号：`buildAdvisorContext`）
- Test: `src/lib/agent/a3/evidence-lite.test.ts`（追加一组，**复用 Task 2 那个 `full()`** —— 同一个文件里，不再造第二份 `Evidence` 夹具）
- Test: `src/lib/data/store.pre-research-v2.demo.test.ts`（Task 13 建、Task 15 追加过的那个文件，再追加一组；`seedIssue` 与 `__seedPreResearchDocForTest` / `__getPreResearchRoundForTest` 两个窄口钩子都复用 Task 15 加的那套，**不再加新钩子**）

**Interfaces:**
- Consumes: `EvidenceLite`, `PreResearchStages` from `@/lib/agent/a3/stages`；既有的 `buildAdvisorContext` 里那一支预研分支。
- Produces: `buildLiteIndex(list: readonly EvidenceLite[]): string` —— 每行 `E{n}｜{claim}｜{站点名，取不到退域名}｜{tier} 档`，**四列的口径逐列对齐深研那一侧的 `buildLedgerIndex`**（`talk/prefix.ts:94`，核过：`${e.id}｜${e.claim}｜${e.sourceName}｜${e.grade} 档`）。空表返回**空串**，那句话由调用方写 —— 同 store 里 `if (ledgerIndex)` 那道现成的兜法。

- [ ] **Step 1: 追加失败的测试（两处）**

在 `src/lib/agent/a3/evidence-lite.test.ts` 末尾追加：

```ts
import { buildLiteIndex } from "./evidence-lite";

describe("buildLiteIndex", () => {
  it("四列逐列对齐深研那一侧的台账索引：编号、说法、站点名、档位", () => {
    const prov = makeProvenance("I-7");
    const a = toEvidenceLite(full({ id: "E1", siteName: "国家统计局" }), prov);
    const b = toEvidenceLite(
      full({ id: "E2", url: "https://news.example.com/x", siteName: "某财经媒体", sourceTier: "C" }),
      prov,
    );
    expect(buildLiteIndex([a, b])).toBe(
      "E1｜某公司 2026Q2 营收同比降 12%｜国家统计局｜A 档\n" +
        "E2｜某公司 2026Q2 营收同比降 12%｜某财经媒体｜C 档",
    );
  });

  it("站点名取不到才退成域名 —— 第三列不许是空的", () => {
    // `full()` 没有 `siteName`（抓不到站点名的页不少），这时印域名
    const line = buildLiteIndex([toEvidenceLite(full({ id: "E3" }), makeProvenance("I-7"))]);
    expect(line).toBe("E3｜某公司 2026Q2 营收同比降 12%｜example.gov.cn｜A 档");
  });

  it("空台账给空串 —— 那句话由调用方写", () => {
    // 和深研那一侧一样（`buildLedgerIndex` 对空数组也回空串，store 里用 `if (ledgerIndex)`
    // 兜）。索引这一层不该替调用方决定「没有证据」这件事在屏幕上怎么说：
    // 同一个空表在对话上下文里要说一句话，在别处可能就是整段不出现。
    expect(buildLiteIndex([])).toBe("");
  });
});
```

在 `src/lib/data/store.pre-research-v2.demo.test.ts` 末尾追加（`seedIssue` 是 Task 15 加在这个文件里的那个）：

```ts
describe("Discuss 接缝", () => {
  /** 造一份带 v2 各段产物的预研文档，挂到指定议题上。塞进去就完事，不返回引用（同 `seedIssue`）。 */
  const withStages = async (issueId: string) => {
    await seedIssue(issueId, "这家新公司要不要盯", ["某公司发布了同类产品。"]);
    const { __seedPreResearchDocForTest } = await import("./store");
    __seedPreResearchDocForTest(issueId, {
      issueId, status: "valid", statusReason: "r",
      question: "这家新公司要不要盯", take: "值得盯一阵", finding: [], openQuestion: [],
      soWhat: "先待定，命中了再看", byAgentLabel: "您的 Agent", assembledFrom: [],
      at: "2026-08-27T00:00:00.000Z",
      stages: {
        entities: [{ name: "某公司", kind: "company" }],
        hits: [{ target: { kind: "judgment", id: "J-2", text: "今年不会有新玩家" }, match: "challenges", why: "正是新玩家", hops: 1 }],
        blindspot: { isBlindspot: true, proximity: "adjacent", hops: 1, credibility: "A", magnitude: "material", why: ["不在监控清单上"] },
        evidence: [{ id: "E1", claim: "同类产品已发布", sourceRef: "https://a.gov.cn/x", sourceName: "国家统计局", date: "2026-08-27T00:00:00.000Z", tier: "A", cosourceKey: "dom:a.gov.cn", provenance: { issueId, stage: "pre_research" } }],
        searchless: false,
        impact: { impactType: "weakens", proposalType: "adjustJudgment", targetRef: { kind: "judgment", id: "J-2", text: "今年不会有新玩家" }, statement: "那条判断要收窄", basis: ["E1"] },
        disposition: { action: "watch", why: "先盯着", trigger: null },
        critic: { pass: true, checks: [], why: [], modelSlot: "alt" },
        card: { kind: "full", headline: "J-2｜今年不会有新玩家", body: "那条判断要收窄\n\n依据：[E1] 同类产品已发布", basis: ["E1"], chars: 24 },
      },
    });
  };

  it("只有预研时，对话上下文里带着台账、靶点与那一句落点", async () => {
    await withStages("ISS-T16A");
    // `api.advisorContext` 的返回类型就是 `Promise<string>`（store.ts:5719），不用兜别的形状
    const text = await api.advisorContext("ISS-T16A");
    expect(text).toContain("E1｜同类产品已发布｜国家统计局｜A 档");
    expect(text).toContain("J-2");
    expect(text).toContain("这家新公司要不要盯");
  });

  it("证据编号跟卡上印的是同一个 —— 进对话不重编号、不重取", async () => {
    await withStages("ISS-T16B");
    const { __getPreResearchRoundForTest } = await import("./store");
    const text = await api.advisorContext("ISS-T16B");
    // 从库里读回来那份上印的编号，不是从测试自己手上那份字面量上读
    const onCard = __getPreResearchRoundForTest("ISS-T16B").cur!.stages!.card.basis[0];
    expect(onCard).toBe("E1");
    expect(text).toContain(onCard);
  });

  it("新加的几段排在「这一页他只做一个决定」之前 —— 那句收尾指令仍然是这一段的最后一句", async () => {
    await withStages("ISS-T16C");
    const text = await api.advisorContext("ISS-T16C");
    /*
     * 为什么这条要单独立一条：那句话是给模型的**收尾指令**，是上面所有材料的框。
     * 材料排到框后面，读起来就成了「先给你规矩、再塞一堆料」，而模型对最后一段最听话。
     * 这一条是 P1-17 拆那次 `lines.push` 的全部理由，拆歪了它必红。
     */
    for (const marker of ["## 证据台账", "## 这条撞上的既有判断", "## 参谋这一轮的提案"]) {
      expect(text.indexOf(marker)).toBeGreaterThan(-1);
      expect(text.indexOf("这一页他只做一个决定")).toBeGreaterThan(text.indexOf(marker));
    }
  });

  it("v1 那份预研（没有 stages）一个字都没变，那句话照旧在末尾", async () => {
    await seedIssue("ISS-T16D", "旧的一条", []);
    const { __seedPreResearchDocForTest } = await import("./store");
    // 没有 `stages` 的一份 —— 库里躺着的旧预研就是这个形状
    __seedPreResearchDocForTest("ISS-T16D", {
      issueId: "ISS-T16D", status: "valid", statusReason: "r", question: "旧的问题",
      take: "t", finding: [], openQuestion: [], soWhat: "旧的落点",
      byAgentLabel: "您的 Agent", assembledFrom: [], at: "2026-08-27T00:00:00.000Z",
    });
    const text = await api.advisorContext("ISS-T16D");
    expect(text).toContain("你的落点：旧的落点");
    expect(text).not.toContain("## 证据台账");
    // 拆 `lines.push` 之后这两句仍然紧挨着（中间只隔一个空行）—— 数组内容一字不差
    expect(text).toContain("你的落点：旧的落点\n\n这一页他只做一个决定");
  });
});
```

- [ ] **Step 2: 跑它们，确认失败**

Run: `pnpm vitest run src/lib/agent/a3/evidence-lite.test.ts src/lib/data/store.pre-research-v2.demo.test.ts`
Expected: FAIL —— `buildLiteIndex is not exported`，以及上下文里找不到 `E1｜…` 那一行。

- [ ] **Step 3: 在 `evidence-lite.ts` 末尾加索引**

```ts
/**
 * 证据台账的上屏索引。
 *
 * 行格式与深研那一侧的 `buildLedgerIndex`（`talk/prefix.ts`）**逐列对齐**：
 * 编号｜说法｜站点名｜档位。同一个人在两条链路上读到的台账长得一样、编号是同一套，
 * 所以从卡进对话不必重编号、也不必重取。第三列一度写成域名 —— 那时两条链路上
 * 同一条证据一边印「国家统计局」一边印 `stats.gov.cn`，「同一套台账」就成了假话。
 *
 * 站点名取不到时退成域名：域名总是有的（证据的 `url` 是必填），而第三列空着
 * 等于这一行答不出「谁说的」。**退在这里，不在 `toEvidenceLite` 里** ——
 * 那一层不该把域名写进一个叫「站点名」的格子。
 *
 * 空表回**空串**，不回一句话：同深研那一侧（`if (ledgerIndex)`）。「这一轮没有证据」
 * 在屏幕上怎么说是调用方的事 —— 有的地方要说一句，有的地方是整段不出现。
 */
export function buildLiteIndex(list: readonly EvidenceLite[]): string {
  return list
    .map((e) => {
      let host = e.sourceRef;
      try {
        host = new URL(e.sourceRef).hostname;
      } catch {
        // 不是合法 URL 就原样印出来 —— 印错的出处也比印不出出处好查
      }
      return `${e.id}｜${e.claim}｜${e.sourceName || host}｜${e.tier} 档`;
    })
    .join("\n");
}
```

- [ ] **Step 4: 补 `buildAdvisorContext` 的预研分支**

**先说清这里没有可插的缝**：那一支（`const pre = store.preResearch[issueId]; if (pre && !store.researchDocs[issueId]) { … }`）从头到尾是**一次** `lines.push(...)` 的多参调用，「这一页他只做一个决定……」就是它的**最后一个实参**（核过：`store.ts` 里那一段，`lines.push(` 到 `);` 之间没有第二条语句）。所以插不进去，得先把那一次调用拆成两次。

**这一步明确允许拆那一次 `lines.push(...)`。** 把 `push(a, b, c)` 拆成 `push(a, b)` + `push(c)`，进数组的元素与顺序一字不差，**没有任何可观察的行为改变** —— 这不算改既有行为（通则一说的是别顺手改既有逻辑，不是别动语句边界）。实现者不用在这里犹豫。

拆前（原样，不许改这几句的字）：

```ts
    lines.push(
      "",
      `这条还在潜在议题这一档，你手上只有一份**预研**（…）预研要回答的那一句：${pre.question}`,
      "预研查到的：",
      ...pre.finding.map((f) => `  ${f.text}（出处：${f.traces.map((t) => t.source).join("、")}）`),
      "这一轮还答不上来的（也就是升级深研会去查什么）：",
      ...pre.openQuestion.map((q) => `  ${q.text}`),
      `你的落点：${pre.soWhat}`,
      "",
      "这一页他只做一个决定：**这值不值得升级成战略议题**。所以你说的每一句都要对着那个决定说 —— 不要在这里替他把议题研究做掉。他问深了，就告诉他那要升级之后才查得动，以及升级之后你会先查什么。"
    );
```

拆后：

```ts
    lines.push(
      "",
      `这条还在潜在议题这一档，你手上只有一份**预研**（…）预研要回答的那一句：${pre.question}`,
      "预研查到的：",
      ...pre.finding.map((f) => `  ${f.text}（出处：${f.traces.map((t) => t.source).join("、")}）`),
      "这一轮还答不上来的（也就是升级深研会去查什么）：",
      ...pre.openQuestion.map((q) => `  ${q.text}`),
      `你的落点：${pre.soWhat}`
    );

    /*
     * v2 的那几段（P7.4 的「报告正文」槽位）。`stages` 不在就是 v1 的一份预研 ——
     * 那时这一整块跳过，进数组的东西与拆之前逐字相同。
     */
    const st = pre.stages;
    if (st) {
      const idx = buildLiteIndex(st.evidence);
      /*
       * 空表时那句话由这里写（`buildLiteIndex` 回空串）——
       * **照 `searchless` 的口径说，不说成「查了但没查到」**：这一轮一条外部证据都没入账。
       */
      lines.push("", `## 证据台账\n${idx || "这一轮一条外部证据都没入账。"}`);
      if (st.hits.length > 0) {
        lines.push(
          `## 这条撞上的既有判断\n${st.hits
            .map((x) => `- ${x.target.id}｜${x.match}｜${x.target.text}（${x.why}）`)
            .join("\n")}`
        );
      }
      lines.push(`## 参谋这一轮的提案\n${st.impact.statement}（依据：${st.impact.basis.join("、") || "没有"}）`);
      if (st.blindspot.isBlindspot) {
        lines.push(`这件事挨着他在管的事，但不在他的监控清单上：${st.blindspot.why.join("；")}`);
      }
      if (!st.critic.pass) {
        lines.push(`**这份提案没过批判**：${st.critic.why.join("；")} —— 在对话里别把它当已经站住的结论。`);
      }
    }

    /*
     * 这一段必须留在最后：它是给模型的**收尾指令**，是上面所有材料的框。
     * 材料排到框后面，读起来就是「先给你规矩、再塞一堆料」，而模型对最后一段最听话。
     * 上面那个空字符串跟着这句话走（拆之前它就在这句的前一个位置）—— 所以
     * `stages` 不在时，进数组的元素与拆之前一字不差。
     */
    lines.push(
      "",
      "这一页他只做一个决定：**这值不值得升级成战略议题**。所以你说的每一句都要对着那个决定说 —— 不要在这里替他把议题研究做掉。他问深了，就告诉他那要升级之后才查得动，以及升级之后你会先查什么。"
    );
```

**新加的那一块自己带一个 `""` 开头**（`lines.push("", "## 证据台账…")`），因为原来那个空行被收尾指令那一次带走了；不补这一下，台账那一行会跟「你的落点：…」黏在同一段里。

`store.ts` 顶部补 `import { buildLiteIndex } from "@/lib/agent/a3/evidence-lite";`。

- [ ] **Step 5: 跑测试，确认通过**

Run: `pnpm vitest run src/lib/agent/a3/evidence-lite.test.ts src/lib/data/store.pre-research-v2.demo.test.ts src/lib/agent/talk`
Expected: PASS —— 新增 7 条全过（索引 3 条、Discuss 接缝 4 条），前面几个任务加的断言一条都没红。**`src/lib/agent/talk` 也要跑**：拆的那次 `lines.push` 就在对谈上下文的装配路径上，那一侧的既有测试是这次拆动唯一的外部见证。

- [ ] **Step 6: 记账并提交**

changelog 加一条：`点开议一议时，预研的台账、撞上的判断与那份提案一起进对话，编号不变`；`package.json` 同步。

```bash
git add src/lib/agent/a3/evidence-lite.ts src/lib/agent/a3/evidence-lite.test.ts src/lib/data/store.ts src/lib/data/store.pre-research-v2.demo.test.ts src/lib/changelog.ts package.json
git commit -m "feat(store): Discuss 接缝带上预研台账与靶点"
```

---

### Task 17: 端到端离线验收（规格 §5 七个场景）

规格 §5 是一张七行的验收表。这一段把它逐行钉成断言。其中场景 6（≤10 分钟）不是离线测得出来的墙钟时间，所以断言的是**它的结构性上界**：这条链一轮最多几次模型调用、最多几轮检索 —— 那才是可断言的那一半，也是时延真正的来源。

**Files:**
- Test: `src/lib/agent/a3/acceptance.test.ts`

**Interfaces:**
- Consumes: 前十六个任务的全部导出。这一段不新增任何生产代码 —— 如果某一条断言过不了，改的是被它照出来的那个文件，不是这份测试。

- [ ] **Step 1: 写七个场景的测试**

`src/lib/agent/a3/acceptance.test.ts`：

```ts
/* 规格 §5 的七行验收表，逐行钉成断言。两个开关必须排在所有 import 之前。 */
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

import { beforeAll, describe, expect, it, vi } from "vitest";
import type { A3Input } from "./prompt";
import type { runPreResearch as RunPreResearch } from "./run";
import type { SearchProvider } from "@/lib/research/search";
import { declareDelta } from "@/lib/agent/a1a/delta";
import { cardPriority } from "./dispose";
import { CARD_BUDGET, checkCard } from "./card";
import { BUDGET_HIT, BUDGET_MISS, pickBudget } from "./verify";
import { proposeTrigger } from "./trigger";
import { makeProvenance } from "./provenance";
import type { BlindspotRuling, EvidenceLite, TargetHit } from "./stages";

/*
 * 桩一：图谱。**这两段桩跟 Task 11 那个文件里的逐字相同**，理由也一样：
 * `runPreResearch` 无条件 `h.openContext(...)`，而 `Harness` 有意把那里的异常原样重抛
 * （那段注释明写不许降级成空上下文），`vitest.config.ts` 也不读 env —— 不打桩，离线跑
 * 到第一个 await 就死在图谱上，七个场景一条断言都轮不到。
 *
 * 姿态照 `src/lib/agent/harness.external.test.ts` 来：`vi.importActual` 展开 + 覆盖
 * `openContext`，**先静态 import 消费方、再动态 import 被 mock 的模块** ——
 * 顺序反了 `vi.importActual` 会把真模块塞进模块缓存。
 *
 * 回的是「开过上下文但转纯外部」那一档。这**不是将就**：正式包的议题在图谱向量索引里
 * 检索不到，两次真模型整跑走的也正是这一支。
 */
vi.mock("@/lib/graphknowledge", async () => {
  const actual = await vi.importActual<typeof import("@/lib/graphknowledge")>("@/lib/graphknowledge");
  return { ...actual, openContext: vi.fn() };
});

/*
 * 桩二：检索。场景 2 那条「没有可用检索源时如实留痕」要的是**零证据入账**那一档，
 * 而**离线不打桩是有证据入账的**（mock 档 `providers()` 回 `[MockSearch]`，它取得到东西），
 * 那条断言不打桩必红。测试侧打桩，`src/lib/research/search.ts` 一字未动。
 *
 * 不能直接桩成 `NoSearch`：那个 class 在 `search.ts` 里**没有导出**，为了测试去导出它
 * 就是改那个文件（硬约束禁止）。所以自己拿一个同形状的源顶上：它在表里、不抛、
 * 一条都取不到 —— 这正是缺 key 那一档在生产上的行为。
 */
vi.mock("@/lib/research/search", async () => {
  const actual = await vi.importActual<typeof import("@/lib/research/search")>("@/lib/research/search");
  const none: SearchProvider = {
    name: "none",
    label: "未启用",
    windowed: false,
    reason: "测试桩：这一档表里有源，但一条都取不到",
    async search() {
      return [];
    },
  };
  return { ...actual, providers: () => ({ list: [none], skipped: [] }) };
});

const { openContext } = await import("@/lib/graphknowledge");
type Opened = Awaited<ReturnType<typeof openContext>>;
const external = {
  mode: "external_only",
  bundle: null,
  anchor: null,
  noAnchorReason: "离线：这一池分不出高低",
  staticContext: "",
  snapshotId: null,
  trace: [{ at: "2026-08-27T00:00:00.000Z", label: "P3 候选池", kind: "graph", detail: {} }],
  warnings: [],
} as unknown as Opened;

let runPreResearch: typeof RunPreResearch;
beforeAll(async () => {
  vi.mocked(openContext).mockResolvedValue(external);
  runPreResearch = (await import("./run")).runPreResearch;
});

const TARGETS = [{ kind: "judgment" as const, id: "J-2", text: "国内做 agent 编排的公司今年不会有新玩家" }];
const INPUT: A3Input = {
  issueId: "ISS-950",
  title: "要不要盯住这家新公司",
  scope: null,
  material: "某公司发布了 agent 编排产品，面向国内中大型客户。",
  docs: [],
  judgments: [{ id: "J-2", statement: "今年不会有新玩家", standing: "在版" }],
  targets: TARGETS,
  watched: ["渠道代理商"],
};
const blind: BlindspotRuling = {
  isBlindspot: true, proximity: "adjacent", hops: 1, credibility: "A", magnitude: "material", why: [],
};
function ev(id: string, group: string): EvidenceLite {
  return { id, claim: "c", sourceRef: `https://a.com/${id}`, date: "2026-08-27T00:00:00.000Z", tier: "A", cosourceKey: group, provenance: makeProvenance("ISS-950") };
}

describe("§5 场景 1 · 卡片疲劳", () => {
  it("同一事件连着五天来，纯转载零产出，只有真多出来的那句算增量", () => {
    const day1 = "某公司发布了 agent 编排产品，面向国内中大型客户。";
    const stream = [day1, day1, day1, `${day1}首批签了三家银行。`, day1];
    const deltas = stream.slice(1).map((s) => declareDelta({ existing: day1, incoming: s }));
    expect(deltas.every((d) => d.verdict === "merged")).toBe(true);
    expect(deltas.filter((d) => d.delta.length > 0)).toHaveLength(1);
  });

  it("第二次预研出的是增量卡，不是第二张新卡", async () => {
    const first = await runPreResearch(INPUT);
    const second = await runPreResearch({ ...INPUT, prevStages: first.doc.stages });
    expect(second.doc.stages!.card.kind).toBe("increment");
  });
});

describe("§5 场景 2 · 盲区", () => {
  it("三判据都满足 → 进机器评审那一道（批判真的跑了）", async () => {
    const r = await runPreResearch(INPUT);
    // 批判这一段一定跑过：要么机检定了（modelSlot 为 null），要么异系模型判了
    expect(r.doc.stages!.critic).toBeDefined();
    expect(r.doc.stages!.critic.modelSlot === null || r.doc.stages!.critic.modelSlot === "alt").toBe(true);
  });

  it("判据不满足 → 走最省的核验档，而且这一轮的账全程留痕", () => {
    expect(pickBudget({ hits: [], blindspot: { ...blind, isBlindspot: false } })).toBe(BUDGET_MISS);
    expect(pickBudget({ hits: [], blindspot: blind })).toBe(BUDGET_HIT);
  });

  it("一条外部证据都没入账时如实留痕，不冒充核验过", async () => {
    const r = await runPreResearch(INPUT);
    /*
     * 这两条成立**全靠文件顶上那个 `search.ts` 的桩**：源表里有一个源，但它一条都取不到。
     * 桩去掉的话罐头检索源是取得到东西的，这两条就该红 —— 那时候红的是这里的前提，
     * 要补的是桩，**不是** `search.ts`，也不是往 `verify.ts` 里加一个只为让它变绿的开关。
     *
     * 另外：`searchless` 的口径是「这一轮一条外部证据都没入账」，**不是「一个检索源都没有」** ——
     * `providers()` 三条路都返回非空表，「源表为空」这一档在生产上根本不存在。
     */
    expect(r.doc.stages!.evidence).toEqual([]);
    expect(r.doc.stages!.searchless).toBe(true);
    expect(r.doc.stages!.card.body).toContain("这一轮没有外部核验");
  });
});

describe("§5 场景 3 · 反确认", () => {
  const target = TARGETS[0];
  const contra: TargetHit = { target, match: "challenges", why: "正是新玩家", hops: 1 };
  const support: TargetHit = { target, match: "supports", why: "跟原判断一致", hops: 1 };

  it("同等强度下矛盾方向排在支持方向前面", () => {
    const evidence = [ev("E1", "dom:a"), ev("E2", "dom:b")];
    expect(cardPriority({ hits: [contra], blindspot: blind, evidence }))
      .toBeGreaterThan(cardPriority({ hits: [support], blindspot: blind, evidence }));
  });

  it("没有一条因为跟既有判断不符而被判成不看了", async () => {
    const { suggestDisposition } = await import("./dispose");
    const r = suggestDisposition({
      impact: { impactType: "outOfScope", proposalType: "noAction", targetRef: null, statement: "x", basis: ["E1"] },
      blindspot: { ...blind, isBlindspot: false, magnitude: "immaterial" },
      evidence: [], nowIso: "2026-08-27T00:00:00.000Z", provenance: makeProvenance("ISS-950"), hits: [contra],
    });
    expect(r.action).not.toBe("dismiss");
  });
});

describe("§5 场景 4 · 触发器闭环", () => {
  it("深研沉淀的推翻条件进表时也只到 proposed —— 命中只提示重议，不自动重议", () => {
    const t = proposeTrigger({
      seq: 1,
      condition: "那家公司公布了国内客户名单",
      targetRef: { kind: "judgment", id: "J-2", text: "今年不会有新玩家" },
      source: "overturnCondition",
      onFire: "proposeReopen",
      nowIso: "2026-08-27T00:00:00.000Z",
      provenance: makeProvenance("ISS-950"),
    });
    expect(t.status).toBe("proposed");
    expect(t.onFire).toBe("proposeReopen");
    // onFire 的三个值全是提案或通知 —— 没有一个会自己改状态
    expect(["proposeDiscuss", "proposeReopen", "notify"]).toContain(t.onFire);
  });
});

describe("§5 场景 5 · 升级连续性", () => {
  /*
   * 这一条要的恰好是**有证据入账**那一档，而文件顶上那个 `search.ts` 的桩让全文件零入账 ——
   * 那样下面那个循环是空跑，「编号是同一套」就成了一条对任何实现都绿的断言。
   * 所以这一条自己把那一桩撤掉一次：`vi.resetModules()` + `vi.doMock` 换回真模块，
   * 让罐头检索源真的取到东西。姿态照 `src/lib/agent/a4/pipeline.test.ts` 里那一组来 ——
   * 重来一遍模块图之后 `@/lib/graphknowledge` 也是新的一份，那一桩要重配一次。
   *
   * 这一下不影响后面两个场景：它们用的是 `beforeAll` 里那一份已经加载好的模块实例，
   * 那一份自己的 `search.ts` 仍然是桩（`resetModules` 清的是缓存，不是已经拿到手的实例）。
   */
  it("卡上印的每个编号在台账里都找得到那条证据", async () => {
    vi.resetModules();
    vi.doMock("@/lib/research/search", async () => await vi.importActual("@/lib/research/search"));
    const gk = await import("@/lib/graphknowledge");
    vi.mocked(gk.openContext).mockResolvedValue(external);
    const run = (await import("./run")).runPreResearch;

    const r = await run(INPUT);
    const s = r.doc.stages!;
    /*
     * **前提先钉住**：这一轮真的有证据入账。它红了说明罐头那条路上一条证据都没进台账 ——
     * 那时候要做的是照 Step 2 的第二档停下来在报告里写清，**不是**把下面这个循环留成空跑。
     */
    expect(s.searchless).toBe(false);
    expect(s.evidence.length).toBeGreaterThan(0);
    for (const b of s.card.basis) {
      if (b.startsWith("[P]")) continue;
      /*
       * 后半句原来是 `|| s.impact.basis.includes(b)` —— 而 `b` 就是从 `card.basis` 里取的、
       * 卡的依据又是从 `impact.basis` 抄来的，那一句恒真，整条断言等于没断言。
       * 要钉的就是这一件事：**卡上印的每个编号都在台账里找得到那条证据**。
       */
      expect(s.evidence.some((e) => e.id === b)).toBe(true);
    }
  });
});

describe("§5 场景 6 · 时效", () => {
  it("一轮的模型调用与检索轮数都有硬上界（时延的来源就这两处）", async () => {
    const r = await runPreResearch(INPUT);
    /*
     * **不用 `r.attempts`**：那个数是**写作那一步的返修轮次**，不是这一轮叫了几次模型。
     * 拿它当「模型调用次数」来断言，等于把四五次调用的链算成一次，上界永远不会被顶破。
     *
     * 模型调用次数从 trace 数：`harness.ts` 里每次 `callMessages` 都往 trace 里 push 一条
     * `kind: "model"`（三处 push 都在）。数出来的是**发起过几次调用**（超时那一支什么都
     * 没发出去也算一次），拿它当上界正合适 —— 时延要的就是「最多叫这么多次」。
     *
     * 六是这么来的：靶点 1 + 写作 1（返修最多再 1 次）+ 影响 1 + 批判 1 + 抽取 1
     * （零入账那一档抽取也可能一次都不叫）。这一档下调不了就是链变胖了，该有人知道。
     */
    const modelCalls = r.run.trace.filter((n) => n.kind === "model").length;
    expect(modelCalls).toBeLessThanOrEqual(6);
    expect(BUDGET_HIT.maxRounds).toBeLessThanOrEqual(2);
    expect(BUDGET_MISS.maxRounds).toBe(1);
  });
});

describe("§5 场景 7 · 30 秒卡", () => {
  it("卡不超预算，而且「发生了什么 + 建议什么」两件事都在卡上", async () => {
    const r = await runPreResearch(INPUT);
    const card = r.doc.stages!.card;
    expect(card.chars).toBeLessThanOrEqual(CARD_BUDGET);
    expect(checkCard(card).filter((v) => v.severity === "p0")).toEqual([]);
    expect(/建议(议一议|先待定|不看了)/.test(card.body)).toBe(true);
  });
});
```

- [ ] **Step 2: 跑它，把红的那几条逐条看清**

Run: `pnpm vitest run src/lib/agent/a3/acceptance.test.ts`
Expected: 前十六个任务都做对时全绿。

**有红先分两档 —— 这两档的处理完全不同：**

1. **断言指着的行为确实错了** → 改被它照出来的那个生产文件。这七行是规格的验收表，不是可以商量的期望值，**不许改断言把它抹平**。
2. **断言自己的前提就不成立**（例如：假定离线这一轮没有证据入账、假定某个分支到得了、假定某个字段上有那一格）→ **停下来在报告里写清那个前提为什么不成立**，把它当一条发现交上去。这一档下**不许改 `src/lib/research/search.ts`**（硬约束：那个文件一字不改），**也不许在生产代码里加一个只为让测试变绿的开关**（例如往 `verify.ts` 里塞一个 searchless 的旁路）。要那个分支就在测试这一侧打桩；打不出来就说打不出来。

分档的判据只有一句：**红的那一条，如果生产上真按它说的走一遍，他屏幕上会不会看到一件不真的事**。会 → 第一档；不会 → 第二档。

- [ ] **Step 3: 跑全量，确认三条链路都还活着**

Run: `pnpm test`
Expected: 全绿。特别确认这三组一条都没红：`src/lib/agent/a4/**`（深研）、`src/lib/agent/talk/**`（议事对话层）、`src/lib/data/store*.test.ts`。

- [ ] **Step 4: 记账并提交**

changelog 加一条：`预研层七个验收场景钉成离线用例，卡片疲劳、反确认、编号连续性都有机检守着`；`package.json` 同步。

```bash
git add src/lib/agent/a3/acceptance.test.ts src/lib/changelog.ts package.json
git commit -m "test(a3): 预研层 v2 端到端验收七场景"
```

---

## 与另两条 pipeline 的交界

三条链路（深研 v2 / 议事对话层 v2 / 预研层 v2）共用同一套 harness、同一套证据语义、同一个 store。下表逐处列出**预研层这一份要碰、而另两条也碰**的地方。

**第一条通则**：本计划**一个既有符号的行为都不改**，只做三类动作 —— 加新文件、加可选字段/可选入参、在既有分支里加 `if (stages)` 包住的新段落。任何一处若必须改既有行为才做得下去，那就是这份计划错了，停下来问，不要硬改。

**第二条通则**：下表凡涉及 `store.ts` / `scope.ts` / `client.ts` / `talk/settle.ts` 的，**一律以议事对话层 v2 全部落库后的状态为准**。

| 文件 | 符号 | 另两条怎么用它 | 预研层怎么碰 | 为什么不打架 |
| --- | --- | --- | --- | --- |
| `src/lib/agent/harness.ts` | `Harness` / `HarnessAgent` | 深研跑 `A4`，议事跑 `A5`/`A6`，A3 早就在枚举里 | **只用，不改。** 不新增 `HarnessAgent` 成员 | P1–P7 是同一次 A3 run 里的 `step`/`substep`，不是新 agent。台账上仍是一条 A3 记录 |
| `src/lib/research/ledger.ts` | `Evidence` / `Ledger` / `SourceTier` / `tierOf` / `fold` | 深研的三道准入与共源折叠 | **只用，不改。** `EvidenceLite` 是 `Evidence` 的投影（Task 2），`cosourceKey` 直接取 `independenceGroup` | 没有第二个证据类型、没有第二套共源哈希。预研的证据是深研那套准入放行过的同一批对象，编号也是同一套 `E{n}` —— §5 场景 5 的「零重取」就是这么成立的 |
| `src/lib/research/search.ts` | `providers` / `searchAll` / `fetchPages` | 深研唯一的检索入口 | **一字不改**，只在 `verify.ts` 里调（Task 6） | 检索源固定博查 + 豆包。**`providers()` 三条路（mock 档回 `[MockSearch]`、没有想要的源回 `[NoSearch]`、全被跳过回 `[NoSearch]`）返回的表都是非空的、都不抛** —— 缺 key 那一档在表里的是 `NoSearch`，它一条都取不到。所以预研判 `searchless` 一律**按入账条数**（`evidence.length === 0`），不按源表空不空；「一个检索源都没有」这条分支在生产上不存在，本计划一处都不写它（Task 6）。要那一档的测试就在**那个测试文件里**打 `@/lib/research/search` 的桩（Task 6 第 6 条、Task 11、Task 17 场景 2），生产文件仍然一字不改 |
| `src/lib/agent/a4/evidence.ts` | `gatherEvidence(h, search, props, budget, lane)` | 深研四链路的取证编排 | **只用，不改。** 预研传自己的 `lane`（`{slot: "flash", label: "预研核验"}`）与更小的预算档（Task 6） | `lane` 与预算本来就是入参 —— 这个函数的设计就允许第二个调用方。不复制取证循环 |
| `src/lib/agent/a4/props.ts` | `compile` / `Proposition` | 深研的命题编译 | **只用，不改。** `buildPropositions`（Task 6）把预研的实体与靶点拼成 `raw`，再交给 `compile` | 命题上限用预算里的 `maxProps`（1 或 3），比深研小一个量级，不抢配额 |
| `src/lib/agent/talk/verifier.ts` | `checkVerdict(raw, reviewSlot)` | 议事对话层复核模型返回的形状校验 | **只用，不改。** P6 批判（Task 9）复用它，并照搬「机检定了就 `modelSlot: null`」与异系槽位表达式 `h.slot === "pro" ? "alt" : "pro"` | 只有一套评审形状校验、一套异系选槽规则。规格 §6 的「影子评审」机器那一半就是它，不新开评审机制 |
| `src/lib/agent/rules.ts` | `Violation` / `Severity` / `overclaim` / `chars` / `sentences` / `blocking` | 深研与议事共用的确定性机检 | **只用，不改。** 新增四条规则号 `A3-14`…`A3-17`（Task 10），走同一个 `Violation` 形状与同一个 `blocking()` | 规则号前缀独立（`A3-`），不与 `G-0x` / 深研那批冲突；p0 进返修、p1 只留痕这一档语义原样沿用 |
| `src/lib/agent/a3/run.ts` | `runPreResearch` / `STEPS` / `MAX_REPAIR` | 深研与议事都不碰它，但 store 的 `ensurePreResearch` 调它 | 扩成七段（Task 11）。`A3Input` 三个新入参**全可选**，`STEP_TOTAL_V1 = 2` 保留 | 没传 `targets` 的调用方（包括所有既有测试与既有 UI 进度条）拿到的还是两段行为、`stages === undefined` |
| `src/lib/data/types.ts` | `PreResearchDoc` / `Card` | 深研有 `ResearchDoc.blocks?: ReportBlocks`，同样的姿态；`Card` 三条链路都读 | 加一个 type-only import + `PreResearchDoc.stages?: PreResearchStages`（Task 11）+ `Card.maybeSameIssue?: { issueId: string; delta: string[] }`（Task 15） | 三处都是**只加不改**；照 `ReportBlocks` 那个既有先例，不引入运行时循环。`maybeSameIssue` 是可选的，不读它的地方（深研、议事）行为一字不变；它装的是「可能是同一件事」的标注，**不是合卡结果** —— 那条既有议题上一个字段都没动 |
| `src/lib/data/store.ts` | `ensurePreResearch` | 预研唯一的生产入口 | 传入 `targets`/`watched`/`prevStages`（Task 12） | 三个都是新可选入参；`ensurePreResearch` 自身的判重与状态机不动 |
| `src/lib/data/store.ts` | `disposeCard` | 待定区三个按钮的落点，议事那边不碰 | watch 分支把本议题 `proposed` 触发器转 `active`；discuss/dismiss 转 `expired`（Task 13）。新段落插在 **`touch(issue, at)` 之前**（三支都不 `return`，都汇到这一行），真翻了东西才 `pushEvent` + `persistSoon()` | 这一下是**人按的**。触发器从 `proposed` 到 `active` 只有这一条路，没有第二个自动布控口；`armed: true` 一处都不加，仍只有 `confirmCandidate` / `confirmClosure` 写它。`disposeCard` 尾巴上**本来没有 `persistSoon()`** —— 新加的那一格照 `persistSoon` 自己文档的口径叫一次（「新加的写操作只要照旧叫它，推送就自动带上了」），**既有那些写操作不顺手补**，补它是改既有行为 |
| `src/lib/data/store.ts` | `buildAdvisorContext` | 议事对话层的静态前缀装配（深研那一支已在） | 只在 `pre && !store.researchDocs[issueId]` 那一支里加 `if (stages)` 包住的几段（Task 16） | 深研那一支（有 `researchDocs`）一行不碰；v1 的预研（无 `stages`）上下文与今天完全一样。规格 §7.4 说的「换掉报告正文那个槽位，其余原样复用」正是这个改法 |
| `src/lib/data/store.ts` | store 对象字面量 / `SEED_FINGERPRINT` / `persistSoon` | 议事加了自己的几格 | 新增两格：`triggers: TriggerProposal[]`、`preResearchPrev: Record<string, PreResearchStages>`（Task 12、15），**都不进 `SEED_FINGERPRINT`**；另加一共十个不带闸门的窄口单测钩子：`__seedJudgmentForTest` / `__seedTriggerForTest` / `__advancePreResearchRoundForTest`（Task 12）、`__nthDemoCardForTest` / `__countArmedReopenTriggersForTest`（Task 13）、`__seedIssueWithCardForTest` / `__getCardForTest` / `__countCardsForTest` / `__seedPreResearchDocForTest` / `__getPreResearchRoundForTest`（Task 15，Task 16 复用后两个），照 `__seedResearchedIssueForTest` 的先例——不导出可变的 store 本体，读的几个一律 `clone` | `Object.assign(store, restored)` 只覆盖快照里有的键 —— 老快照恢复时新键保持初值，不会 `undefined`。指纹只管 issues/judgments/cards，新键不影响重置判定；与议事那几格是不同的键名，合并时是两处相邻新增，不是同一行 |
| `src/lib/data/store.ts` | `settleTurn` / `landTalkCandidate` | 议事对话层的轮外结算 | **一行不碰** | 预研层没有轮外结算，也不写候选判断 |
| `src/lib/data/scope.ts` | `METHOD_SCOPE` | 议事这一轮往里加了几个键 | 加一行 `listTriggers: "ceo"`（Task 12） | 表是 `Record<RpcMethod, Scope>`，漏了会编译不过 —— 这正是它的价值。冲突只会是同一处相邻新增，`git` 层面的事，语义上不打架 |
| `src/lib/data/client.ts` | `const api: Api` | 同上 | 加一行 `listTriggers: forward("listTriggers")` | 同上：`Api` 的键覆盖由类型保证 |
| `src/lib/agent/a1a/apply.ts` | `applyA1aInbox` | 深研与议事都不碰 | 建完议题之后多叫一次 `noteMaybeSameIssue`，返回里多一格**可选**字段 `maybeSameIssue?: { issueId: string; delta: string[] }`（Task 15）。**没有注入回调** | `apply.ts` 第一行 import 就是 `from "@/lib/data/store"`（`issueExists` / `issueFromSignal` / `markCardAgentVerdict`）—— 方向本来就是 apply → store，没有环可避，多一层可选回调只是多一层。既有的路由分路、`issueFromSignal` 那一段、已有的两处返回**一个字都不改**，所以现有调用方全都编译得过。这一路**不合卡、不撤卡、不改那条旧议题的任何字段** —— `update_issue` 的取代成不成立明写着是他采信那一下的事（`apply.ts` 自己的注释），所以这里只做标注 |
| `src/lib/models/slots.ts` | `Slot` / `resolveModel` / `areIndependent` | 三条链路共用 | **只用，不改。** P1/P2/P3 抽取用 `flash`，P4 与写作用 `pro`，P6 批判用异系的那个 | 不新增槽位、不新增模型配置。规格 §4 的模型分层就落在这三个既有槽位上 |
| `src/lib/models/mock.ts` | `CANNED` | 深研与议事各有自己的罐头键 | 新增三个键：`a3.targets` / `a3.impact` / `a3.critic` | 键按 hint 命名空间分开；未知 hint 本来就返回可解析的兜底且不抛，所以先落哪个任务都不会把别人的测试打红 |
| `src/lib/changelog.ts` + `package.json` | 版本号与首条 | 三条线都要写 | 每个任务一条 | **这是唯一必然的文本冲突点**：最前面那条与版本号一定撞。提交是安全的，合并时把两条都保留、版本号取更大的那个往上加。别在 `main` 的工作目录里合 |

**三处需要特别点明的语义边界：**

1. **证据编号的唯一性。** 预研与深研在同一个议题上先后跑时，各自开自己的 `Ledger`，编号都从 `E1` 起。这不是 bug —— 预研的台账存在 `preResearch[issueId].stages.evidence`，深研的存在 `researchDocs[issueId]`，`buildAdvisorContext` 的两支互斥（有深研就不读预研那一支），所以同一个屏幕上永远不会同时出现两套 `E1`。**升级到深研时把预研台账当已有证据带过去**是规格 §5 场景 5 的更强读法，那需要 `startDeepResearch` 接一个初始台账入参 —— **不在本计划范围，作为已知欠账记在这里**，本计划保证的是「卡 → Discuss 这一段编号不变、零重取」（Task 16 的两条断言）。
2. **触发器与议事那边的重开条件。** 议事在 `landTalkCandidate` 那一步「一条重开条件都不布控」，布控只发生在 `confirmCandidate`。预研的 `store.triggers` 是**另一张表、另一套 id 前缀（`TG-`）**，装的是尚未被人看过的提案，`status` 起手就是 `proposed`。两张表不共享写入方，也不互相读。深研沉淀的推翻条件要进这张表时同样只能进 `proposed`（Task 17 场景 4 钉住这一条）。
3. **`A3` 这一格在任务表里只有一份。** 预研的进度条走既有的 `startPreResearch`/`preResearchStatus`，`STEP_TOTAL` 从 2 变 7 是同一格里的段数变化，不是第二格。深研的 `startDeepResearch`/`deepResearchStatus` 与议事的对话轮次都不受影响。

---

## 已知欠账（十四条）

**这十四条一条都没有实现，一条都不许在代码、注释、变更日志或验收报告里写成「已实现」或「无影响」。** 它们各有理由：有的是规格要的机制在这个仓库里没有物质基础，有的是要他本人按一下才成立的产品判断。**规避的办法不是把它们做一半再说成做完了，而是留在这里让下一个人看得见。**

### 1. 真正的合卡没有 —— 规格 P0 的「同议题聚合」这一轮只做到标注与差异

`noteMaybeSameIssue`（Task 15）把「可能和哪条既有议题说的是同一件事」和「相对那一条多了哪几句」算出来，标在**新建的那张卡**上（`Card.maybeSameIssue`），并在时间线上留一条。**那条既有议题一个字段都没动，卡照旧新建，`applyA1aInbox` 已有的返回语义一字未改。**

**缺的是什么**：把两条真的合成一条。为什么不做：`a1a/apply.ts` 自己的注释写着 `update_issue` 的产出是一条**取代**旧议题的新议题，而「取代成不成立是一号位采信那一下的事」—— 真要合，等于替他判定「这两件事是同一件」，那得由他按一下：那是另一个入口、另一次确认，不在这份计划里。

**连带的实情**：`attachSignalToCard`（Task 15）与 `store.preResearchPrev` 这一格**生产上今天没有任何调用方**，所以**增量卡在生产上出不来**，只在测试里跑得通。这不是漏接，是上面那个入口还没有 —— 形状先钉住，等入口做出来时改的只有一处调用。**不要因为它没有调用方就删掉它，也不要为了给它凑一个调用方而在入库处自动合卡。**

### 2. 靶点与核验结果不进写作提示词

Task 11 把 P1–P6 排在写作之前，但 `matched` / `verified` 的产物**一个字都没拼进 `buildA3User`** —— 写作那一次模型调用手上仍然只有原来那几段材料。P1–P6 放在前面只有一个作用：留痕的时序对得上，回放时看得出先后。

**缺的是什么**：把靶点与核验过的证据喂给写作。为什么不做：那是改写作那一次模型调用的输入，会动产出质量，而这份计划**没为它设计过评估**。要做，得先想清楚怎么衡量它对产出的影响。

### 3. 「证据本身多旧」这道检查没有

P6 的机检（Task 9）里**没有** `staleDate` 这一档，`CriticCheck` 联合类型上也没有。原因是 `EvidenceLite.date` 就是 `Evidence.retrievedAt` —— 这一轮的抓取时刻，生产上永远约等于此刻，按它算天数那道检查**永远不开火**。

**缺的是什么**：判「这条证据说的那个时点是不是已经太旧」。为什么不做：证据说的时点在 `Evidence.period` 上，而 `period` 在口径四件套里是**可选的**（`EvidenceDraft` 上就是 `period?`），补一格 `EvidenceLite.period` 之后这道检查照样有一半时候开不了火 —— 换来的是同一个假象换个位置。要做，得先让 `period` 成为可依赖的一格。

### 4. `store.triggers` 与 `judgment.reopenTriggers` 长期两张表并存，不合流

预研的 `store.triggers`（`TG-` 前缀，装尚未被人看过的提案）和判断上的 `reopenTriggers`（布控中的重开条件，`armed` 由 `confirmCandidate` / `confirmClosure` 写）是**两张表**，不共享写入方、不互相读。触发器走到 `active` 就是终点。

**缺的是什么**：他确认之后，那条从 `store.triggers` 进 `judgment.reopenTriggers` 的路没有。为什么不做：这是要他本人定的产品问题（进不进、什么时候进、进去之后 `armed` 算谁写的），不归实现猜。

### 5. evidence-lite 没有「先记着、以后补抓」那一档

规格 §2.1 设想 lite 不需要抓到快照就可入账。本计划把 `EvidenceLite` 做成 `Evidence` 的**投影**（Task 2），每一条都来自一条已经过了台账三道准入的 `Evidence`（七字段齐、URL 在本轮快照里、原句能在快照正文里定位）——**没有更弱的准入，只有更少的字段**。零命中那一档记的是检索命中数与 `Ledger.rejections`，不是一条没有原文的「证据」。

**缺的是什么**：规格设想的那一档「先记着、以后补抓」。为什么不做：新定义一个更弱的证据类型，等于这个产品里从此有两种「证据」，而其中一种指不回原文 —— 台账的全部意义就是每一条都指得回去。

### 6. `hops` 算得出来的时候很少，算不出来时是 `null`

规格 §3 P2 的「接近度」要本体图上的跳数。今天这个仓库只算得出 bundle 归属（成员在不在同一个包里），答不出跳数，所以 `TargetHit.hops` / `BlindspotRuling.hops` 常常是 `null`，接近度退回靠靶点命中判定。

**缺的是什么**：真的跳数。为什么这么做：`null` 是实话，编一个 hop 数是假话。**一处都不许填 0 冒充「很近」**，上屏那句话在 `hops === null` 时也照实说「本体图上的跳数这一轮算不出来」。

### 7. 没有 embedding —— 近似判断是字符二元组重叠 + 一次模型判断

规格 P0/§4 依赖向量近似做召回。这个仓库里没有 embedding 客户端，`search.ts` 又一字不改，所以召回退成确定性的 `bigramOverlap` 预筛（`overlap.ts`），再由模型在收窄后的候选里判匹配方向（Task 4）。

**缺的是什么**：向量召回。为什么这么做：引一个 embedding 客户端就是新开一条并行链路（违反「只维护一套」），还要新的 key、新的失败模式、新的离线夹具。**这不是等价实现**，代码注释里如实这么写；换来的好处是把近似判断交给模型自己的知识，模型说不准时它会说，向量分数不会。

### 8. 升级到深研时不把预研台账带过去

预研与深研在同一个议题上先后跑时各自开自己的 `Ledger`，编号都从 `E1` 起。本计划保证的是「卡 → Discuss 这一段编号不变、零重取」（Task 16 的两条断言钉住它）。

**缺的是什么**：规格 §5 场景 5 的更强读法 —— 升级到深研时把预研台账当已有证据带过去。为什么不做：那要给 `startDeepResearch` 接一个初始台账入参，越过「既有符号行为不改」这条线。

---

### 9. 影子评审的人工那一半留空

规格 §6 三处提到影子评审，而它自己就写着「待定的是人工环节由谁承担、SLA 多少」。本计划做了机器那一半（Task 9 复用 `talk/verifier.ts` 的 `checkVerdict` 与异系选槽，不新开评审机制），人工那一半**一个字都不写**。

**缺的是什么**：谁承担、SLA 多少。为什么不做：这归产品定，不归实现猜 —— 同第 4 条，是要他本人按一下才成立的那一类。**不许写一个没人调用的人工评审入口充数。**


### 10. 盲区判不了预算档 —— 它要的东西在定预算那一刻还没有

外部核验有两档预算：撞上了既有判断就多查两轮，没撞上就省着查。规格的意思是「判成盲区」
也该多花，但**这一档今天接不上**：盲区裁定要看证据够不够硬（可信度那一格），
而预算必须在**取证之前**定下来 —— 那一刻台账还是空的，可信度到不了门槛，旗子恒为假。

**缺的是什么**：让「这可能是个盲区」参与预算。为什么不做：要让它参与，得先有一份
**不依赖证据**的盲区判据，那是另一件事。

**这一段原来写着「已经拆掉……今天预算只按撞没撞上靶点选」—— 那句话是假的**
（2026-08-29 端到端验收时逐行核出来的）。真实情况是：`pickBudget` 仍然收 `blindspot`
入参、仍然有 `|| o.blindspot.isBlindspot` 这个或分支；`run.ts` 定预算那一刻台账是空的，
可信度那一格是 `null`，所以**这个分支在生产上恒假，是一条死分支，但它还在**。

要划清一处边界，免得下一个人读成「盲区这个概念是死的」：**只有定预算那一刻的裁定是死的**。
取证回来之后 `run.ts` 会重判一次，实跑得到 `isBlindspot: true`、可信度 `A` ——
盲区本身是活的，卡上那一段也是真的。

拆不拆这个死分支没定：拆了签名更诚实，留着是给「将来有了不依赖证据的判据」留的接口。
**没人拍板之前不许再把它写成已经拆了。**

### 11. 一条监控条件过期之后，没有重新备一条的入口

他按下「观察」之后那条监控条件开始生效，九十天从按下那刻起算。到期清扫会把过期的清掉，
并在议题记录上留一条回执。**但回执里给不出下一步** —— 这一版没有重新备一条的办法。

**缺的是什么**：重新跑一轮预研、或者手动补一条监控条件的入口。为什么不做：
`ensurePreResearch` 第一句就 `return done`；再按「聊聊」起的是深研，**不产出监控条件**。

（这一段原来写着「全仓没有任何生产路径 `delete store.preResearch[issueId]`」——
**那句绝对话是假的**，删议题那条路上就有一处，2026-08-29 端到端验收时核出来的。
本条的结论不变：那条路把整条议题一起删了，不是一个重跑入口。**但绝对话不许再写。**）
**回执里如实写着「这一版还没有重新备一条监控条件的入口」——
给一条走不通的路比说「没有」更坏**，所以宁可让他读完知道无路可走。

### 12. 这一层做出来的东西，大半今天还没上屏

**他今天在屏幕上真看得到的只有两处**：待定区那行小字从「共 2 步」变成「共 7 步」，
以及他按下「观察」之后那条监控条件真的开始生效（连同议题记录里那一行）。

**看不到的**：预研装出来的那张提请卡（`src/app` 下 `.tsx` grep `stages` **零命中**，
`[E1]` 那个编号从来没上过屏）、增量卡（`attachSignalToCard` 生产上零调用方）、
触发器表（`api.listTriggers` 挂上了 RPC，没有一页在调）、
以及「这次多了哪几句」（`IssueLogEntry` 不带 `detail`，那一页只摊标题）。

**缺的是什么**：这一层的产物到屏幕之间的那一段。为什么不做：那是界面那一轮的事，
本计划只做到数据层。**记在这里是因为它最容易被读成「做完了」** ——
十七个任务全绿、验收场景全过，而他打开产品看到的变化其实只有上面那两处。
`fired` 这一档也一样：全仓没有任何一处写它，「一条生效的条件命中、进而提请重议」那条路还没接。

---

**下面两条是 2026-08-29 端到端验收（Task 17）时长出来的，不在原来那十二条里。**

### 13. 「卡上的证据编号必须真在台账里」只有一道守卫，而且不在机检那一侧

今天挡住模型编造编号的，只有 `impact.ts` 里那一句 `ids.has(b)` 过滤。`card.ts` 的 `checkCard`
查的是「标签有没有上卡」，**不查这个编号在不在台账里** —— 那一句过滤一去掉，一个凭空编出来的
`E999` 能一路印上卡，而机检一声不响。

验收那一段现在有断言守着（桩掉罐头让模型编一个 `E999`，断言它上不了卡），
**但机检侧确实没有第二道**。为什么记成欠账而不是顺手补：`checkCard` 现在的入参里没有台账，
补这一道要给它加一格 —— 那是接口变更，不是加一条规则。

### 14. 「一轮预研最多多久」今天没有一个可断言的口径

原计划把模型调用次数的上界写成 6，理由是「靶点 1 + 写作 1（+返修 1）+ 影响 1 + 批判 1 + 抽取 1」。
**那个 6 是错的**：抽取不是一次 —— `gatherEvidence` **每抓一页叫一次**。实测同一份输入，
桩着检索（零入账）一轮叫 3 次，换回真检索源一轮叫 **7 次**，顶破 6。

原断言之所以一直绿，是因为它只跑在零入账那一档 —— 而时延不住在那一档。

现在改成按真结构分开钉：固定那几次仍守 6（多接三次调用即红），抽取那几次守预算档折出来的上界。
**但那个上界（`BUDGET_HIT` 折出来是 12，实测 3）松到基本不会红** —— 也就是说
「一轮最多多久」这件事今天仍然没有人在守。**这条上界该定几，是产品口径，要他判。**

---

## 一处范围移位与一条注记

**范围移位（规格画在哪 / 实现落在哪）**：规格把 **P0（同议题聚合）画在预研层里**，本计划把它落在**信号入库那一处**（`a1a/apply.ts` 的 `update_issue` / `new_issue` 两路 + store 的 `noteMaybeSameIssue`，Task 15）。理由是核过的事实：`store.ts` 的 `issueFromSignal` 里就有 `store.cards.push(card)`，而 `a1a/apply.ts` 在入库那一路调的就是 `issueFromSignal` —— **卡在预研开跑之前就已经建好了**。聚合要是放在预研层，它面对的是一堆各自建好卡的议题，那时候再聚等于要去撤卡。**下一个人拿规格对代码时按这条看，别以为是实现走偏了。**

**注记一（`cardPriority` 的分母）**：Task 14 的 `cardPriority` 里 `Math.max(1, independentGroupCount(evidence))` 让「零证据」与「一组证据」同分。这是已知的一处口径微调空间，**这一轮不改** —— 改分母会动 Task 5 / Task 14 已经逐条手算过的断言，换来的收益不值这个风险。记在这里，不当遗漏。

**注记二（demo 档那条深研）**：store 侧的测试按 demo / live 拆成两个文件之后（Task 12 建 live 档那个、Task 13 建 demo 档那个），「Discuss 那条用例会在后台起一轮真的深研」这个担心自动消失 —— `ensureDeepResearch` 自己就挡 demo 档。不用单独处理，记在这里免得下一个人再查一遍。

---

## Self-Review

**1. 规格覆盖**

| 规格 | 落在哪 |
| --- | --- |
| §1 目标与非目标 | 全局：预研只提请不裁决，处置三动作（Task 8）、卡片 ≤300 字（Task 10） |
| §2.1 evidence-lite | Task 2（投影）、Task 6（真取证）、Task 16（上屏索引） |
| §2.2 触发器表 | Task 3（构造与到期）、Task 12（store 落格与清扫）、Task 13（人按下才转 active） |
| §2.3 provenance | Task 1（`makeProvenance`），此后每个产物都带 |
| §3 P0 | Task 15（`declareDelta` + `noteMaybeSameIssue` + `attachSignalToCard`）。**这一轮只做到「标注 + 差异」，没有真的合卡** —— 见末节欠账第 1 条。另：规格把 P0 画在预研层，实现落在入库层（A1a），见末节「一处范围移位」 |
| §3 P1 | Task 4（实体归一 + 候选靶点收窄） |
| §3 P2 | Task 4（靶点匹配）+ Task 5（盲区三判据） |
| §3 P3 | Task 6（预算档 + `gatherEvidence` + searchless） |
| §3 P4 | Task 7（影响提案 + 独立源不足时机器降档） |
| §3 P5 | Task 8（三动作 + Watch 触发器） |
| §3 P6 | Task 9（机检在前，异系模型在后） |
| §3 P7 | Task 10（四段卡 + 增量卡 + 四条机检）、Task 16（P7.4 Discuss 接缝） |
| §4 模型分层 | Task 4/6（`flash`）、Task 7 与写作（`pro`）、Task 9（异系）；不新增槽位 |
| §5 七个验收场景 | Task 17 逐行钉成断言；场景 3 另有 Task 14 的生产代码 |
| §6 影子评审 | 机器那一半 = Task 9；**人工那一半规格未定**（谁承担、SLA 多少），见下 |
| §7 与三条链路的接口 | 末节「与另两条 pipeline 的交界」；§7.4 = Task 16 |
| §8 Part 4 保留项 | 不实现，其中「升级到深研时带上预研台账」记在末节欠账里 |

**未覆盖的部分一条不落地列在末节「已知欠账（九条）」里**，九条都是范围决定或产品未定，不是占位。这里不再重复，只点名两条最容易被读成「已实现」的：影子评审的人工环节（规格自己写着「待定的是人工环节由谁承担、SLA 多少」—— 这归产品定，不归实现猜，**本计划一个没人调用的人工评审入口都不写**）；升级到深研时的台账传递（需要改 `startDeepResearch` 签名，超出「既有符号行为不改」这条线）。

**2. 占位扫描**

通读一遍，无 `TBD`、无「实现细节略」、无「加上适当的错误处理」、无「照 Task N 的写法」、无「为上面这些写测试」。每个 code step 都有可直接粘贴的代码块；每个 run step 都有具体命令与 FAIL/PASS 期望；重复的构造函数在需要的任务里重写了一遍，没有跨任务的「同上」。

**3. 类型一致性**

跨任务用到的名字逐一对过：`Provenance`/`makeProvenance`、`EvidenceLite`/`toEvidenceLite`/`liteFromLedger`/`independentGroupCount`/`buildLiteIndex`、`TargetRef`/`TargetHit`/`MatchKind`（**`supports`/`challenges`/`extends`/`none`** —— 这四个值是唯一一套；Task 1 的定义、Task 4 的 `MATCHES` 白名单与提示词、Task 14 的 `cardPriority`、Task 16 的 fixture 全按它，没有第二套三值或四值的写法）、`EntityRef`/`normalizeEntities`/`narrowTargets`/`matchTargets`、`BlindspotRuling`/`ruleBlindspot`/`tierAtLeast`/`bestTier`、`pickBudget`/`BUDGET_HIT`/`BUDGET_MISS`/`verifyExternally`、`ImpactProposal`/`proposeImpact`/`MIN_INDEPENDENT_SOURCES`、`DispositionSuggestion`/`suggestDisposition`/`cardPriority`、`CriticVerdict`/`criticize`/`machineChecks`、`CardDraft`/`assembleCard`/`checkCard`/`CARD_BUDGET`、`TriggerProposal`/`proposeTrigger`/`expireTriggers`/`TRIGGER_TTL_DAYS`、`PreResearchStages`、`declareDelta`。全部只在 `stages.ts` 与各自的实现文件里定义一次，后续任务的 import 路径与之一致。

`bigramOverlap` **住在 `src/lib/agent/overlap.ts`**（Task 4 新建的零 import 叶子，和 `agent/rules.ts` 同一档），**不在 `a3/targets.ts` 里**。三个消费方 —— Task 4 的 `a3/targets.ts`、Task 5 的 `a3/blindspot.ts`、Task 15 的 `a1a/delta.ts` 与 store 的 `noteMaybeSameIssue` —— 一律从 `@/lib/agent/overlap` 取，**不重写第二份**。放在 `targets.ts` 里会让 A1a 的模块图上多出整条 A3 依赖（`targets.ts` 顶上挂着 `Harness` 与 `a3/prompt.ts`），所以它从一开始就不住那儿。

`searchless` 全计划只有一个定义：**这一轮一条外部证据都没入账**（`evidence.length === 0`）。Task 1 的字段注释、Task 6 的实现与测试、Task 7 的提示词分档、Task 10 的卡片措辞、Task 11 与 Task 17 的断言、末节交界表全按这一条。「一个检索源都没有」在本计划里只以**否定式**出现（几处注释明写「别把它读成源表空」），**没有一处代码或断言按那个意思写** —— 那条分支在生产上不可达，写出来就是死代码。

`Card.maybeSameIssue?: { issueId: string; delta: string[] }`（Task 15 在 `types.ts` 上新加的那一格）与 `applyA1aInbox` 返回里的同名字段**同名同形**，两处必须一字一样 —— 它装的是「可能是同一件事」的标注，不是合卡结果。

---

## 本轮修订逐条对照（两份裁定 → 落点）

两份裁定：`.superpowers/sdd/2026-08-27-pre-research-layer-v2/plan-rulings.md`（八条，规格与硬约束的冲突）与 `plan-rulings-2.md`（三十条逐条处置）。**两份都以裁定文件为准**，压过本计划原文，也压过预检报告 `preflight.md`。

「上一轮已落地」= 前一次修订就改完了，**本轮逐条复核过末态**（不是靠顺序推断）；「本轮补的」= 本轮新改或改完整的。

### 第一轮裁定（八条）

| 编号 | 处置 | 落点 | 本轮状态 |
| --- | --- | --- | --- |
| 裁定 1 | 自动布控 → 提案，不许放开 | Global Constraints「确认只能由人按下」；Task 3（`TriggerStatus` 注释 + `status: "proposed"`）；Task 8（`DispositionSuggestion.trigger`）；Task 12 Step 4（收提案进表那一段）；Task 13 全任务；Task 17 场景 4 | 上一轮已落地（我复核过） |
| 裁定 2 | snake_case → camelCase，规格原文不动，计划里要有对照表 | **新增一节「规格字段名 ↔ 实现字段名对照」**（八行 + 三个「规格有、实现没有」的名字） | **本轮补的** —— 原来只在 Global Constraints 里列了名字，没有对照表 |
| 裁定 3 | evidence-lite 做成 `Evidence` 的投影，不放行更弱的证据 | Task 1 `EvidenceLite` 的类型注释；Task 2 全任务；Task 6 零入账那一档记 `rejections` | 正文上一轮已落地（我复核过）；**欠账第 5 条本轮补的** |
| 裁定 4 | 没有 embedding → 二元组重叠 + 一次模型判断，取舍写进注释 | Task 4 开头那段 + `NARROW_K` 的注释；Task 11 / 17 的图谱桩注释（「这不是将就」） | 正文上一轮已落地（我复核过）；**欠账第 7 条本轮补的** |
| 裁定 5 | `hops` 可能是 `null`，不许假装 | Task 1 `TargetHit` / `BlindspotRuling` 注释；Task 4 Step 3 `hopsOf`；Task 5 Step 3 接近度那一段 + 两条测试 | 正文上一轮已落地（我复核过）；**欠账第 6 条本轮补的** |
| 裁定 6 | 影子评审的人工那一半留空，不许硬造 | 交界表 `talk/verifier.ts` 行；Self-Review 规格覆盖表 §6 行 | 正文上一轮已落地（我复核过）；**末节那条「要他本人定的」本轮补的** |
| 裁定 7 | 丢 `confidence`、复用四档、`MIN_INDEPENDENT_SOURCES = 2` | Task 1 `EvidenceLite` 注释（为什么没有 `confidence`）；Task 5（`SourceTier` 四档）；Task 7（阈值 2 + 沿用 Part1 §2.2 的注释） | 上一轮已落地（我复核过） |
| 裁定 8 | P0 挪到信号入库那一处，末节要写清这处移位 | Architecture 段；Task 15 开头 | 正文上一轮已落地（我复核过）；**末节「一处范围移位」本轮补的** |

### 第二轮裁定 · P0（八条）

| 编号 | 落点 | 本轮状态 |
| --- | --- | --- |
| P0-1 | Task 11 Step 1、Task 12 Step 1、Task 17 Step 1 各一段 `vi.mock("@/lib/graphknowledge", …)`（`vi.importActual` 展开 + 覆盖 `openContext`，桩死 `mode: "external_only"` / `bundle: null` / `anchor: null`） | 上一轮已落地（我复核过） |
| P0-2（1）删 `list.length === 0` 提前返回及其注释 | Task 6 Step 3 `verifyExternally`（收尾按 `evidence.length === 0` 算） | 上一轮已落地（我复核过） |
| P0-2（2）`PreResearchStages.searchless` 文档注释改成事实 | Task 1 Step 3 | 上一轮已落地（我复核过） |
| **P0-2（3）交界表那句「缺 key 时 `providers().list` 为空且不抛」** | **交界表 `src/lib/research/search.ts` 行整格重写** | **本轮补的**（连带把 Task 6 Step 5 的 changelog 措辞也改成「没入账」） |
| P0-2（4）Task 6 第 6 条测试改成打 `providers()` 的桩 | Task 6 Step 1 | 上一轮已落地（我复核过） |
| P0-2（5）Task 11 与 Task 17 场景 2 同理打桩 | Task 11 Step 1、Task 17 Step 1 | 上一轮已落地（我复核过） |
| P0-2（6）Task 17 Step 2 那句「有红一律改生产文件」拆成两档 | Task 17 Step 2 | 上一轮已落地（我复核过） |
| P0-3 | 拆成 `store.pre-research-v2.test.ts`（live，Task 12）与 `store.pre-research-v2.demo.test.ts`（demo，Task 13 建、15/16 追加） | 上一轮已落地（我复核过）；**File Structure 里那张两个文件的对照表是本轮补的** |
| P0-4 | Task 2 Step 1 的 `full(over: Partial<Evidence> = {}): Evidence`（不戴 `as Evidence`、字段名照真契约）；Task 16 Step 1 复用同一个 `full()` | 上一轮已落地（我复核过；另去 `ledger.ts` 逐字核了 `exactQuote` / `supportRelation` / 无 `publishedAt` / `AuthorityClass` 无 `"official"` / `UsedAs` 两值） |
| P0-5 | Task 15 整段重写：只标注不合卡、`noteMaybeSameIssue` 自己算既有议题、`Card.maybeSameIssue?` 那一格、删掉 `attach?` 回调 | Task 正文上一轮已落地（我复核过）；**Global Constraints 的 `types.ts` 那条、交界表 `a1a/apply.ts` 与 `data/types.ts` 两行、Self-Review 规格覆盖表 §3 P0 行、欠账第 1 条、Task 15 Step 5c 那句「既有两处返回」（真代码是四处提前返回）都是本轮补的** |
| P0-6 | Task 8 Step 1 断言 `toContain("2 组")`，旁边写着「不许把模板串改成中文数字」 | 上一轮已落地（我复核过） |
| P0-7 | Task 10 Step 1 两条断言改成 `not.toMatch(/[ABCD] 档/)` 与 `not.toContain("组独立源")` | 上一轮已落地（我复核过） |
| P0-8 | Task 13 Step 3 `defaultOpen: true` + `actor: viewer().name`；Task 15 两处 `defaultOpen: false` + `actor: "您的 Agent"` | 上一轮已落地（我复核过；另去 `types.ts` 核了 `defaultOpen: boolean` 必填、去 `store.ts` 核了 `disposeCard` 里既有那条事件也是 `viewer().name` + `defaultOpen: true`） |

### 第二轮裁定 · P1（十条）

| 编号 | 落点 | 本轮状态 |
| --- | --- | --- |
| P1-9 | Task 12 Step 1 那条真测试（`__seedJudgmentForTest` 塞判断 → 走 `api.addIssue` 真入口 → `__advancePreResearchRoundForTest` 断言 `stages` 并摆好第二轮起点 → 断言 `TG-` 提案在表里且 `status === "proposed"`、`prevStages`/`targets` 真喂进去）+ Step 4 的验收标准「整段删掉这条必须红」 | **本轮更正**：上一轮把这条测试写成靠一个泛用的 `__storeForTest()` 直接塞议题和卡，与 `store.ts` 「所有写都经过 `api`，不导出可变引用」的约定冲突；改成三个窄口钩子（`__seedJudgmentForTest`/`__seedTriggerForTest`/`__advancePreResearchRoundForTest`），且议题本身仍从 `api.addIssue` 这个真入口造，不是塞出来的——上一轮的描述本来就不准确。**第三轮补完**：上一轮留到「下一轮」的 Task 15 Step 6 / Task 16 Step 1 那两组（`seedIssue` 及其调用方）也窄口化了，`__storeForTest()` 从计划正文里彻底消失——Task 15 加五个窄口钩子（`__seedIssueWithCardForTest` / `__getCardForTest` / `__countCardsForTest` / `__seedPreResearchDocForTest` / `__getPreResearchRoundForTest`，读的三个交克隆），Task 16 全部复用；议题与时间线两处读走 `api.getIssue` / `api.getTimeline` 这两条现成的真读路，不为它们开钩子 |
| P1-10 | Task 11 Step 1 改成造超预算的卡、断言 `r.violations.some((v) => v.rule === "A3-14")` + 验收标准 | 上一轮已落地（我复核过） |
| P1-11 | Task 13 Step 3：锚点在 `touch(issue, at)` 之前；`mine.length > 0` 那一档叫 `persistSoon()`；注释写清只管新加的那一格 | Task 正文上一轮已落地（我复核过；另去 `store.ts` 核了 `disposeCard` 尾巴确实没有 `persistSoon()`）；**交界表 `disposeCard` 行本轮补的** |
| P1-12 | Task 12 从一开始就读 `store.preResearchPrev[issueId]`；Task 11 / 12 / 15 三处读法一致 | 上一轮已落地（我复核过） |
| P1-13 | Task 6 Step 3 `buildPropositions` 用 `materialityWeight` / `freshnessUrgency`，不自己算 `extraRoundsCap` | 上一轮已落地（我复核过；**按裁定要求自己打开 `src/lib/agent/a4/props.ts` 核过这两个字段名**，并确认 `extraRoundsCap` 是 `compile` 自己算的，不从 raw 读） |
| P1-14 | Task 11 Step 3 注释改成事实（P1–P6 这一轮不进写作提示词），行为不改 | 正文上一轮已落地（我复核过）；**欠账第 2 条本轮补的** |
| P1-15 | 整条 `staleDate` 删掉：Task 1 `CriticCheck` 只剩三值 + 注释、Task 9 Step 3 那段注释 | 正文上一轮已落地（我复核过）；**欠账第 3 条本轮补的** |
| P1-16（1）trace 数模型调用 | Task 11 Step 1 | 上一轮已落地（我复核过；另去 `harness.ts` 核了三处 `kind: "model"` 的 push） |
| P1-16（2）Task 17 场景 6 同理 | Task 17 Step 1 | 上一轮已落地（我复核过） |
| P1-16（3）场景 5 恒真的后半句删掉 | Task 17 Step 1 | 上一轮已落地（我复核过） |
| P1-16（4）两条常量自断言**删掉** | Task 5 Step 1（`TIER_FLOOR`）、Task 7 Step 1（`MIN_INDEPENDENT_SOURCES`），两处都留了「不许加回来」的话 | 上一轮已落地（我复核过） |
| P1-16（5）Task 2 那条归 P0-4 | 见 P0-4 | 上一轮已落地（我复核过） |
| P1-17 | Task 16 Step 3/4：明确允许把那一次 `lines.push(...)` 拆成两次、给出拆前拆后形状、新段落落在「这一页他只做一个决定」之前，并有两条测试钉住那句仍是最后一段 | 上一轮已落地（我复核过） |
| P1-18 | `MatchKind` 四值 `supports` / `challenges` / `extends` / `none`：Task 1 定义、Task 4 `MATCHES` 与提示词、Task 14、Task 16 fixture | Task 正文上一轮已落地（我复核过）；**Self-Review「类型一致性」那一行里仍写着旧的 `refines` / `unrelated`，本轮补的** |

### 第二轮裁定 · P2（十二条）

| 编号 | 落点 | 本轮状态 |
| --- | --- | --- |
| P2-19 | Task 1 `CriticCheck` 注释 + Task 9 Step 3：`overclaim` 只留痕、不短路批判模型 | 上一轮已落地（我复核过） |
| P2-20 | Task 5 导出 `bestTier`，Task 10 Step 3 用它、不再写第二份 `reduce` | 上一轮已落地（我复核过） |
| P2-21 | Task 4 Step 4「PASS（12 个）」 | 上一轮已落地（我复核过） |
| P2-22 | Task 12 Step 5 `listTriggers` 返回新数组而不是表本体 + 注释说明为什么 | 上一轮已落地（我复核过） |
| P2-23 | 按 P0-3 拆成 demo 档之后自动消失，不单独处理 | **末节「注记二」本轮补的**（裁定要求记进台账，别当遗漏） |
| P2-24 | Task 9 Step 1 把桩里的 `slot` 改成 `"alt"`，标题不动 | 上一轮已落地（我复核过） |
| P2-25 | `bigramOverlap` 从一开始就住 `src/lib/agent/overlap.ts`（零 import 叶子）：File Structure 新增一行、Task 4 新建它并说明理由、Task 5 与 Task 15 都从那里 import | Task 正文与 File Structure 上一轮已落地（我复核过）；**Self-Review 最后一段仍写着「`bigramOverlap` 在 `targets.ts` 定义」，本轮补的**（连带补了 `searchless` 与 `Card.maybeSameIssue` 两条跨任务口径） |
| P2-26 | Task 1 Step 3 注释改成「不成环的真正原因是 `import type` 会被完全擦除」，约束本身留着 | 上一轮已落地（我复核过） |
| P2-27 | Task 10 Step 3 注释改成 `continue`（跳过这一段继续试后面的），不是「停」 | 上一轮已落地（我复核过） |
| P2-28 | Task 13 Step 3 复用函数顶部那个 `at`、`actor` 用 `viewer().name` | 上一轮已落地（我复核过） |
| P2-29 | Task 10 Step 3 `checkCard` 的 A3-15 逐条查整句原文，不用一个标签兜所有 | 上一轮已落地（我复核过） |
| P2-30 | Task 16 `buildLiteIndex` 第三列站点名、取不到退域名；空表回空串、那句话由调用方写 | 上一轮已落地（我复核过；另去 `talk/prefix.ts` 核了 `buildLedgerIndex` 的四列与空表行为） |

### 预检那五条「规格意见」

| 编号 | 处置 | 落点 | 本轮状态 |
| --- | --- | --- | --- |
| 意见 1 | 采纳，并入 P1-16（2） | Task 17 Step 1 | 上一轮已落地（我复核过） |
| 意见 2 | **不改**，记成注记 | 末节「注记一（`cardPriority` 的分母）」 | **本轮补的** |
| 意见 3 | **不改**，记成欠账 | 末节欠账第 4 条（两张表不合流） | **本轮补的** |
| 意见 4 | **采纳，直接解决**：窄口钩子不带运行期闸门（照 `__seedResearchedIssueForTest` / `__seedClosureDraftForTest` 两个先例的真实姿态），意见 4 说的「`TKOS_PERSIST !== "0"` 这个等号」不再存在，`persist.restart.test.ts` 拿不到出口这个顾虑也一并消失 | Task 12（新钩子定义那一段） | **本轮更正**：上一轮先是把这条意见记成「不改」的注记（末节原注记二），后来发现原注记本身站不住——两个先例根本没有运行期闸门，`__storeForTest()` 加的那道闸门不是「照先例的姿态」，是误加；改法是撤掉闸门而不是记下来不管，原注记二整段删掉，「两条注记」改成「一条注记」 |
| 意见 5 | 已按 (a) 裁 | 见 P0-2 | —— |
| 顺带一条（新测试别进 `store.triggers.demo.test.ts`） | 采纳，写进文件清单旁边 | Task 12 Step 1 与 Task 13 Step 1 的文件头注释 | Task 正文上一轮已落地（我复核过）；**File Structure 旁那张表与那句警告是本轮补的** |

### 本轮另外补的两处（不属于任何一条编号，但跟着这一轮的改动必须一起对齐）

| 落点 | 为什么 |
| --- | --- |
| **末节「已知欠账（八条）」整节** | 计划里原来**根本没有这一节**，而正文有六处写着「记在末节欠账里」「计划末节欠账第一条」—— 指向一个不存在的地方。八条按裁定要求逐条写清「缺的是什么」，一条都没写成「已实现」或「无影响」 |
| **十七个任务的 Produces / Consumes 块** | 逐个对过：Task 4（`overlap.ts` 的导出）、Task 5 与 Task 15（`bigramOverlap` from `@/lib/agent/overlap`）、Task 6（`searchless` 的跨任务口径）、Task 10（`bestTier` from `./blindspot`）、Task 12（`store.preResearchPrev` 归谁声明、归谁写）、Task 15（`Card.maybeSameIssue?` 与 `applyA1aInbox` 同名同形、`noteMaybeSameIssue` 与 `attachSignalToCard`）、Task 16（`buildLiteIndex` 的四列口径）**上一轮就已经对齐了**，本轮复核无改动；跨任务口径改补在 Self-Review 的「类型一致性」段里 |
