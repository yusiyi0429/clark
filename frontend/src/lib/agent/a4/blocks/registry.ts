/**
 * 证据表：把台账折成报告里那一枚枚编号背后的东西。
 *
 * 模型在 `evidence_list` 里只写两样 —— 引哪个编号、这条动了哪一条判断。来源、档次、
 * 时点、地址、独立性组全部从台账映射过来（HP-2：事实归台账所有）。让模型重填一遍
 * 已经确定的事实等于给它一次改写事实的机会，而改写出来的那一份和真的那一份在屏幕上
 * 长得一模一样。
 *
 * ## 模型能把来源往下改，不能往上改
 *
 * 台账的 `authorityClass` 分不出「学术论文」和「行业机构」，也分不出「厂商宣传」和
 * 「媒体转述」—— 而读过那一页的只有模型。所以它的标注收，但只在**比台账那一档更弱**
 * 的时候收（`RANK`）。往上改一律按台账：一个媒体转述的页被标成「官方一手」在屏幕上
 * 是一枚高权重的芯片，而它凭的是模型的一句话。
 *
 * ## 台账里没有的编号
 *
 * 不是错误。模型自己的既有知识可以入列，但一律 `verified: false`、`origin: "model"`、
 * 自己一个独立性组。禁止的是**匿名混进正文**：一个没有编号的记忆里的数字，措辞精确、
 * 无从对账。
 *
 * 「内部DOC」是这一路里唯一保留原样的一档 —— 企业上下文本来就来自内部文档，它不该被
 * 改写成「模型既有知识」（`lint.ts` 要靠这一档抓「内部文档混进外部市场分析」）。
 *
 * ## 引了但没入列的编号不在这里补
 *
 * 正文写了 `[E9]`、清单里没有 E9 —— 这里不凭空造一条。造出来的那一条会渲染成一枚
 * 看着正常的芯片，而它背后什么都没有。这一种由 `lint.ts` 报「悬空引用」，屏幕上画成
 * 一枚点不开的未列芯片。
 */

import type { AuthorityClass, Evidence, SourceTier } from "@/lib/research/ledger";
import { disclosureOrigin } from "../disclosure";
import {
  normalizeRef,
  type Block,
  type BlockEvidence,
  type EvidenceListBlock,
  type Grade,
  type SourceType,
} from "./schema";

/* -------------------------------------------------------------------------- */
/* 台账 → 证据表                                                              */
/* -------------------------------------------------------------------------- */

const SOURCE_TYPE_OF: Record<AuthorityClass, SourceType> = {
  regulator: "官方一手",
  official_statistics: "官方一手",
  company_primary: "公司披露",
  industry_body: "行业机构",
  media: "媒体转述",
  other: "来路不明",
};

/**
 * 台账的 A/B/C/D → 报告里的 A/B/C。
 *
 * D 折进 C 而不是另开一档：「无人担责」这件事由 `sourceType` 的「来路不明」说，
 * 档次那一列只表达强弱。两处都留一个 D 的话，屏幕上会出现「C 级的来路不明」和
 * 「D 级的媒体转述」这种读不出差别的组合。
 */
const GRADE_OF: Record<SourceTier, Grade> = { A: "A", B: "B", C: "C", D: "C" };

/** 越靠前越强。模型的标注只在**不高于**台账那一档时被采纳。 */
const RANK: SourceType[] = [
  "官方一手",
  "公司披露",
  "学术论文",
  "行业机构",
  "媒体转述",
  "厂商宣传",
  "来路不明",
];

const rankOf = (t: SourceType): number => {
  const i = RANK.indexOf(t);
  // 不在这把梯子上的（内部DOC、模型既有知识）不参与比较。
  return i < 0 ? -1 : i;
};

type ListItem = EvidenceListBlock["items"][number];

/** 台账那一条的来源类型，外加模型允许的那一次降级。 */
function sourceTypeFor(entry: Evidence, said?: SourceType): SourceType {
  const fromLedger: SourceType =
    entry.sourceTier === "D" ? "来路不明" : SOURCE_TYPE_OF[entry.authorityClass] ?? "来路不明";
  if (!said) return fromLedger;
  const a = rankOf(said);
  const b = rankOf(fromLedger);
  // 内部DOC / 模型既有知识 不能贴到一条抓过原文的证据上：它有 URL，它不是内部文档。
  if (a < 0 || b < 0) return fromLedger;
  return a > b ? said : fromLedger;
}

function fromLedger(entry: Evidence, item?: ListItem): BlockEvidence {
  const one: BlockEvidence = {
    id: entry.id,
    // 同一条证据在两份报告里支撑的说法可以不同，所以清单里那句优先。
    claim: item?.claim || entry.claim,
    sourceName: item?.sourceName || entry.siteName || entry.sourceDomain,
    sourceType: sourceTypeFor(entry, item?.sourceType),
    verified: true,
    retrievedAt: entry.retrievedAt,
    url: entry.url,
    independenceGroup: entry.independenceGroup || `dom:${entry.sourceDomain}`,
    grade: GRADE_OF[entry.sourceTier],
    origin: "ledger",
  };
  if (item?.updateDirection) one.updateDirection = item.updateDirection;
  return one;
}

function fromModel(item: ListItem): BlockEvidence {
  // 内部DOC 是这一路里唯一保留原样的一档；别的一律改写成「模型既有知识」。
  const sourceType: SourceType = item.sourceType === "内部DOC" ? "内部DOC" : "模型既有知识";
  const one: BlockEvidence = {
    id: item.id,
    claim: item.claim,
    sourceName: item.sourceName || (sourceType === "内部DOC" ? "内部文档" : "模型既有知识"),
    sourceType,
    verified: false,
    retrievedAt: "",
    // 各自一组：它们不是「共源」，它们压根没有源。
    independenceGroup: `own:${item.id}`,
    grade: "C",
    origin: "model",
  };
  if (item.updateDirection) one.updateDirection = item.updateDirection;
  return one;
}

/**
 * 折出这份报告的证据表。
 *
 * 顺序：先按清单块里的顺序（那是模型排的，屏幕上照它显示），台账里有、清单里没列的
 * 接在后面 —— 那几条仍要入表，因为正文里的芯片要解析得开。**清单块显示的是模型列的
 * 那几条，证据表是全报告的解析表，两者不是一回事。**
 */
export function buildRegistry(entries: Evidence[], blocks: Block[]): BlockEvidence[] {
  const byId = new Map<string, Evidence>();
  for (const e of entries) byId.set(e.id, e);

  const out: BlockEvidence[] = [];
  const taken = new Set<string>();

  for (const block of blocks) {
    if (block.type !== "evidence_list") continue;
    for (const item of block.items) {
      const id = normalizeRef(item.id);
      if (!id || taken.has(id)) continue;
      taken.add(id);
      const entry = byId.get(id);
      out.push(entry ? fromLedger(entry, item) : fromModel({ ...item, id }));
    }
  }

  for (const entry of entries) {
    if (taken.has(entry.id)) continue;
    taken.add(entry.id);
    out.push(fromLedger(entry));
  }

  return out;
}


/* -------------------------------------------------------------------------- */
/* 核验分成四件事                                                              */
/* -------------------------------------------------------------------------- */

/**
 * `BlockEvidence.verified` 这一个布尔位**同时被读成了四句话**，而它只证得了第一句。
 *
 * ISS-239 的机检写着「31 条已核验」。逐条查过那份台账（`replay/iss239.snapshot.json`）之后，
 * 它实际证明的只有一件事：这 31 条的引句在抓回来的原文快照里逐字定位到了
 * （`Evidence.verificationStatus === "span_matched"`，台账入账第三道门）。而读的人从
 * 「已核验」读到的是另外三句：这个出处确实是它自称的那一家、这件事另有独立来源、
 * 这条撑得起报告下的那个判断。三句都没被证过。
 *
 * 所以这一层把它拆成四栏。**拆的是表述，不是数据** —— `verified` 那一位照旧在
 * `schema.ts` 上、照旧由 `buildRegistry` 填，这里只是把它说清楚：
 *
 *   · `quoteMatched`     原文片段匹配 —— 引句在抓回来的原文里定位到了。台账那道门。
 *   · `sourceIdentified` 来源身份确认 —— 抓到的这一页，担不担得起它自称的那个身份。
 *   · `crossChecked`     独立交叉验证 —— 另有一个独立来源说同一件事。
 *   · `supportsClaim`    支持当前判断 —— 它对报告里的判断是强化 / 削弱 / 限定。
 *
 * 前三栏是**核出来的**，最后一栏是**模型标的**，两类不能摆成同一种字。
 *
 * **这一层只做数据与文案，渲染在别人的文件里。**
 */
export type VerificationLevel = "yes" | "no" | "unchecked";

export interface EvidenceVerification {
  /** 引句在本轮抓回来的原文快照里逐字定位到了没有。 */
  quoteMatched: VerificationLevel;
  /** 抓到的这一页担不担得起它自称的身份。镜像转载的公司披露一律 `unchecked`。 */
  sourceIdentified: VerificationLevel;
  /** 另有一个**独立性组不同**的来源说同一件事没有。 */
  crossChecked: VerificationLevel;
  /** 它对报告里那条判断是什么关系。`unstated` = 模型没标。**这一栏不是核验结果。** */
  supportsClaim: "强化" | "削弱" | "限定" | "unstated";
  /** 屏幕上那一行字。四件事各一句，**不合成「已核验」三个字**。 */
  label: string;
}

const YES_NO: Record<VerificationLevel, string> = { yes: "是", no: "否", unchecked: "未核" };

/**
 * 「来源身份确认」这一栏的判据。
 *
 * 问的不是「这家可不可信」，是**「抓到的这一页，担不担得起它自称的那个身份」**：
 *
 *   · `origin === "model"`（台账里没有的编号，模型自己的既有知识）→ `no`。压根没有出处，
 *     没有出处就没有身份可核。「内部DOC」也在这一支：它是企业上下文里的文档，这一轮没有
 *     联网核过，所以是 `unchecked` 而不是 `no` —— 它有出处，只是没在这一轮被核。
 *   · 「来路不明」（台账 D 档：文库、个人发布）→ `no`。无人担责就是身份不成立。
 *   · 自称「公司披露」而地址不在一手披露站上 → `unchecked`。**这就是新浪镜像那一档**：
 *     内容确实是公司发的，但原站与这份转载没有逐字核过，不自动升格（`disclosureOrigin`）。
 *   · 其余从台账来的（媒体转述在媒体站上、行业机构在机构站上、一手披露在巨潮/交易所/
 *     官网上）→ `yes`。抓到的那一页就是这家站发的，身份对得上。
 */
function identityOf(e: BlockEvidence, disclosureDomains: readonly string[]): VerificationLevel {
  if (e.sourceType === "内部DOC") return "unchecked";
  if (e.origin === "model") return "no";
  if (e.sourceType === "来路不明") return "no";
  if (e.sourceType === "公司披露") {
    const origin = disclosureOrigin(
      { url: e.url ?? "", sourceDomain: "", authorityClass: "company_primary" },
      disclosureDomains
    );
    return origin === "primary" ? "yes" : "unchecked";
  }
  return "yes";
}

/** 比对用的归一化。判断两条说的是不是同一句话，只去掉编号、括注、空白和标点。 */
const normSaying = (v: string): string =>
  (v ?? "")
    .replace(/\[E\d+(?:\s*[,，]\s*E?\d+)*\]/g, "")
    .replace(/[（(][^)）]*[)）]/g, "")
    .replace(/[\s ]/g, "")
    .replace(/[。，,、；;：:！!？?「」“”"']/g, "")
    .toLowerCase();

/**
 * 一条证据的四栏核验状态。
 *
 * ## 「独立交叉验证」为什么几乎永远是 `unchecked`
 *
 * 判据是**同一句话由两个不同独立性组说出来**：两条的 `claim` 归一化后完全相同，而
 * `independenceGroup` 不同。要求逐字相同而不是相似 —— 相似度判出来的「交叉验证」比没有
 * 交叉验证更糟：它会把同一篇稿子的两处转载判成两个来源，而那正是共源折叠（`groupSizes`）
 * 存在的理由。
 *
 * 在 ISS-239 那份台账上这个判据一条都不命中（31 条 claim 各不相同），所以那一份的正确
 * 说法是「31 条原文片段匹配，0 条独立交叉验证」—— 而不是「31 条已核验」。这不是判据太严，
 * 是那一轮确实没做交叉验证。
 */
export function verificationOf(
  e: BlockEvidence,
  all: readonly BlockEvidence[] = [],
  opts: { disclosureDomains?: readonly string[] } = {}
): EvidenceVerification {
  const quoteMatched: VerificationLevel = e.origin === "ledger" ? "yes" : "no";
  const sourceIdentified = identityOf(e, opts.disclosureDomains ?? []);

  const saying = normSaying(e.claim);
  const crossChecked: VerificationLevel =
    saying &&
    all.some((o) => o.id !== e.id && o.independenceGroup !== e.independenceGroup && normSaying(o.claim) === saying)
      ? "yes"
      : "unchecked";

  const supportsClaim = e.updateDirection?.effect ?? "unstated";

  const label = [
    `原文片段匹配：${YES_NO[quoteMatched]}`,
    `来源身份确认：${YES_NO[sourceIdentified]}`,
    `独立交叉验证：${YES_NO[crossChecked]}`,
    supportsClaim === "unstated"
      ? "对当前判断的作用：未标注"
      : `对当前判断的作用：${supportsClaim}（模型标注，非核验结果）`,
  ].join("；");

  return { quoteMatched, sourceIdentified, crossChecked, supportsClaim, label };
}

export interface VerificationTally {
  total: number;
  /** 引句逐字定位到的条数。**「已核验 N 条」那句话原来说的就是这个数。** */
  quoteMatched: number;
  /** 出处身份对得上的条数。 */
  sourceIdentified: number;
  /** 身份没核过的条数（镜像转载、内部文档）。 */
  sourceUnchecked: number;
  /** 真有第二个独立来源说同一句话的条数。 */
  crossChecked: number;
  /** 一句话。**出口机检和屏幕上都用这一句代替「N 条已核验」。** */
  label: string;
}

/**
 * 整份报告的核验账。**四个数分开报，不合成一个。**
 *
 * ISS-239 用这一份台账算出来是：31 条里 31 条原文片段匹配、20 条来源身份确认、
 * 11 条身份未核（新浪那两台镜像上的公司披露）、0 条独立交叉验证。那三行摆在一起，
 * 读的人才知道「已核验」原来只保证第一行。
 */
export function verificationTally(
  list: readonly BlockEvidence[],
  opts: { disclosureDomains?: readonly string[] } = {}
): VerificationTally {
  let quoteMatched = 0;
  let sourceIdentified = 0;
  let sourceUnchecked = 0;
  let crossChecked = 0;
  for (const e of list) {
    const v = verificationOf(e, list, opts);
    if (v.quoteMatched === "yes") quoteMatched += 1;
    if (v.sourceIdentified === "yes") sourceIdentified += 1;
    if (v.sourceIdentified === "unchecked") sourceUnchecked += 1;
    if (v.crossChecked === "yes") crossChecked += 1;
  }
  return {
    total: list.length,
    quoteMatched,
    sourceIdentified,
    sourceUnchecked,
    crossChecked,
    label:
      `${list.length} 条证据：原文片段匹配 ${quoteMatched} 条，来源身份确认 ${sourceIdentified} 条` +
      `（${sourceUnchecked} 条未核原站），独立交叉验证 ${crossChecked} 条。` +
      "片段匹配只证明这句话在那一页上，不证明那件事成立，也不证明它撑得起报告里的建议。",
  };
}

/* -------------------------------------------------------------------------- */
/* 共源折叠                                                                    */
/* -------------------------------------------------------------------------- */

/**
 * 每个独立性组里有几条。屏幕上「共源×3」和校验器里那条「一份材料收三遍」用的是
 * 同一张表 —— 分两处各数一次的话，屏幕上写着三个来源、校验器说只有一个的情况迟早出现。
 */
export function groupSizes(list: BlockEvidence[]): Map<string, number> {
  const m = new Map<string, number>();
  for (const e of list) m.set(e.independenceGroup, (m.get(e.independenceGroup) ?? 0) + 1);
  return m;
}

/** 这几个编号落在几个互相独立的组里。「两组独立来源」那道门数的是这个，不是条数。 */
export function independentGroups(refs: string[], list: BlockEvidence[]): string[] {
  const byId = new Map(list.map((e) => [e.id, e] as const));
  const out: string[] = [];
  for (const ref of refs) {
    const g = byId.get(ref)?.independenceGroup;
    if (g && !out.includes(g)) out.push(g);
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 正文里引到的编号                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 行内引用。`[E3]`、`[E3, E7]`、`[E3][E7]` 都要认出来。
 *
 * 这一对正则是 `gate.ts` 那一对的副本，**故意抄的**：那个模块连着台账和复算器，
 * 而这里的东西渲染层也要用 —— 为了两条正则不重复，把台账和复算器一起拖进浏览器包
 * 是笔更贵的账。抄一份的代价是它们可能走岔，所以两处的形状写在同一句注释里。
 */
const INLINE_CITE = /\[E\d+(?:\s*[,，]\s*E?\d+)*\]/g;
const INLINE_ID = /E?(\d+)/g;

const inline = (text: string): string[] => {
  const out: string[] = [];
  for (const m of (text ?? "").matchAll(INLINE_CITE)) {
    for (const one of m[0].matchAll(INLINE_ID)) out.push(`E${one[1]}`);
  }
  return out;
};

/**
 * 这份报告一共引到哪些编号，按出现顺序。
 *
 * 两处来源：块上的 `evidenceRefs` 字段，和散文里行内那些 `[E1]`。只数字段的话，
 * 一整节引在正文里的证据会被算成「没有引用」；只扫正文的话，KPI 卡那种字段式引用
 * 全数不到。
 */
export function citedRefs(blocks: Block[]): string[] {
  const out: string[] = [];
  const push = (ids: string[]) => {
    for (const id of ids) if (id && !out.includes(id)) out.push(id);
  };

  for (const b of blocks) {
    switch (b.type) {
      case "prose":
        push(inline(b.md));
        break;
      case "kpi_cards":
        for (const c of b.cards) push(c.evidenceRefs);
        break;
      case "layered_table":
        push(b.evidenceRefs);
        for (const row of b.rows) for (const cell of row) push(inline(cell));
        break;
      case "judgment":
        push(b.evidenceRefs);
        push(inline(b.claim));
        push(inline(b.reasoningSummary));
        break;
      case "verdict_banner":
        push(inline(b.text));
        break;
      case "divergence_view":
        for (const p of b.positions) push(inline(p.keyBasis));
        break;
      case "funnel":
        for (const st of b.stages) push(inline(st.note ?? ""));
        break;
      case "bar_compare":
        for (const it of b.items) push(inline(it.note ?? ""));
        break;
      case "caliber_map":
        for (const r of b.rows) push(inline(r.handling));
        break;
      case "scenario_cards":
        for (const c of b.cards) for (const n of c.keyNumbers) push(inline(n));
        break;
      case "unverified_panel":
        for (const it of b.items) push(inline(it.statement));
        break;
      case "evidence_list":
        for (const it of b.items) push([normalizeRef(it.id)]);
        break;
      case "falsify_card":
        for (const c of b.conditions) push(inline(c));
        break;
      case "param_model":
        push(inline(b.disclaimer));
        break;
    }
  }
  return out;
}

/* -------------------------------------------------------------------------- */
/* 证据包编号                                                                  */
/* -------------------------------------------------------------------------- */

/**
 * 这一份消费的证据包的编号。三条链路各自取证，所以三份报告的包 id 本来就不同 ——
 * 它要答的是「这份报告是拿哪一批材料写的」，以及「重跑一遍拿到的是不是同一批」。
 *
 * 算的是内容：条目编号 + 那一页的内容哈希 + 引句区间。同一批材料算出同一个 id，
 * 换掉一页或者多抓一页都会变。没联网那一轮是 `pack-0-empty` —— 那是一个事实，
 * 不是一处缺失。
 */
export function packIdOf(entries: Evidence[]): string {
  if (!entries.length) return "pack-0-empty";
  const seed = entries
    .map((e) => `${e.id}|${e.contentHash}|${e.span[0]}-${e.span[1]}`)
    .sort()
    .join("\n");
  // FNV-1a：这里要的是「内容变了 id 就变」，不是抗碰撞 —— 不为它引一个哈希库。
  let h = 0x811c9dc5;
  for (let i = 0; i < seed.length; i += 1) {
    h ^= seed.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return `pack-${entries.length}-${h.toString(16).padStart(8, "0")}`;
}
