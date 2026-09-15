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
/**
 * 批判能报的几类。前三类是 v2 的；后两类 2026-09-05 加：
 * - `premiseDenied`：把一号位给定的前提当成无依据（ISS-224：本体没记录维信诺，就判首访议题不成立）。
 * - `contradiction`：定性结论和它自己的理由/结尾互相打架。
 */
export type CriticCheck = "evidenceThin" | "overclaim" | "targetMismatch" | "premiseDenied" | "contradiction";
/** `modelSlot: null` = 机检就定了，没叫模型。台账上不许把机检记成模型判的。 */
export type CriticVerdict = {
  pass: boolean;
  checks: CriticCheck[];
  why: string[];
  modelSlot: Slot | null;
  /** 批判那一次模型没跑成（调用失败 / 返回读不出）。`pass:false` 但**不是**打回，是没判。 */
  unavailable?: boolean;
};

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
  /**
   * 提请台上的排序分数（`cardPriority`）。只用于排序，不参与分流。
   *
   * 可选是为了让 Task 13 之前落下的那些 `stages` 照样读得回来 —— 分数是排序用的，
   * 缺了它只是排不动，不该让一份预研整份读不出来。
   */
  priority?: number;
};
