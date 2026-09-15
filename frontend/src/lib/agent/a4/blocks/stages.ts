/**
 * 分节生成的**确定性那一半**（补遗 §1）。不调模型。
 *
 * 出稿这一步现在是三段：大纲一次、每节各一次、收口一次。三段之间要传的东西全在这里 ——
 * 大纲怎么读、每节的要点清单怎么折、几节之间有没有把同一个数说两遍、最后那张证据利用率
 * 的账怎么合，以及各节和收口交上来的那些行怎么拼成一份完整的 JSONL。
 *
 * ## 为什么这些不写在 run.ts 里
 *
 * `run.ts` 那一层管的是「调用谁、跑多久、失败了怎么办」。这里管的是「模型交上来的东西
 * 对不对得上」，而那件事一条都不该靠人读日志发现：大纲漏派了两条证据、某一节把上一节的
 * 数字又展开了一遍、收口交的 evidence_usage 少了三条 —— 这三种在屏幕上都长得像一份正常
 * 的报告。所以每一条都要么被改正、要么进 `notes`。
 *
 * ## 账归代码，理由归模型
 *
 * `evidence_usage` 那一块最后由这里合成，不用模型交的那一份（合的时候会把各节和收口交的
 * 都摘掉）。分工的理由在 `schema.ts` 的 `EvidenceUsageBlock` 上：`used` 是事实 ——
 * 「正文到底引了哪几条」代码数得比模型准；`discarded` 里那句**弃用理由**只有模型说得出，
 * 代码一个字都不替它补。所以这里只做两件事：把 used 数出来，把各处声明过的理由收拢。
 *
 * 一条证据既没被引、也没人给理由，这里**不补一句「未使用」** —— 补了 A4-B11 就永远过得去，
 * 而它要拦的正是那一种。这里只记一条 note，闸由校验器落。
 */

import type { A4Outline, A4OutlineSection } from "@/lib/agent/a4/prompt";

import { parseBlocks } from "./parse";
import { citedRefs } from "./registry";
import { blocksToText } from "./report";
import { normalizeRef, type Block, type EvidenceUsageBlock } from "./schema";

/* -------------------------------------------------------------------------- */
/* 大纲                                                                        */
/* -------------------------------------------------------------------------- */

const str = (x: unknown): string => (typeof x === "string" ? x.trim() : "");
const arr = (x: unknown): unknown[] => (Array.isArray(x) ? x : []);
const obj = (x: unknown): Record<string, unknown> =>
  x && typeof x === "object" && !Array.isArray(x) ? (x as Record<string, unknown>) : {};

/**
 * 一节最少几个块。模型给的数当建议看，但不接受 0 —— 那等于「这一节可以不写」。
 *
 * `floor` 默认 2。**决策题传 1**（2026-09-07，ISS-238）：那道题的一级产物是收口交的决断包，
 * 正文这两三节退成情报附件，一节一个块（一段机制、或者一条判断）就答完了它那一问。这个数
 * 硬卡在 2 的话，提示词里那句「一节至少 1 个块」永远不生效 —— 而这种「指令改了、闸没改」
 * 正是 ISS-227 那一轮六节各写 1 万 token 的成因。
 */
const clampMin = (raw: unknown, evidenceCount: number, floor = 2): number => {
  const n = typeof raw === "number" && Number.isFinite(raw) ? Math.round(raw) : 0;
  // 给不出数时按证据条数折：大致每两三条一个块，至少 floor 个。
  const fallback = Math.max(floor, Math.ceil(evidenceCount / 3));
  return Math.min(12, Math.max(floor, n > 0 ? n : fallback));
};

/**
 * 这一份章节是谁排的。
 *
 * `model` = 排结构那一次真交出来了；`playbook` = 它没成，按 N1 的决策骨架分的节；
 * `single` = 连骨架都没有，折成一节涵盖全部证据。
 *
 * **`notes` 里那句话不够**（2026-09-07，ISS-240）：出口对账和下一轮打回要按「这一份是不是
 * 模型排的结构」分开处理，而从一串中文缺陷里认这件事，等于让每一个读它的人各写一遍正则。
 */
export type OutlineSource = "model" | "playbook" | "single";

export interface ReadOutlineResult {
  outline: A4Outline;
  /** 改正过的和答不上的那几处。**不静默** —— 漏派两条证据在屏幕上看不出来。 */
  notes: string[];
  /** 见 `OutlineSource`。 */
  from: OutlineSource;
}

/**
 * 排结构那一次交不出可用章节时，拿来顶上的**毛坯大纲**（2026-09-07，ISS-240）。
 *
 * ## 为什么要有它，而不是继续折成一节
 *
 * `RUN-A4-mtqtenit-2` 那一轮 24 分 20 秒：轮到排结构时只剩 456 秒，一节 + 收口 + 两次锚点
 * 检查的位置留出去之后，这一次只分到 46 秒，网宿网关等到 45 秒超时。于是没有大纲 → 折成
 * 一节 → 那一节也没时间写 → **正文 1 块、附录 5 块、0/1 节，取回来的 24 条证据用上 0 条、
 * 弃用 0 条、没交代 24 条**。
 *
 * 预算下限已经在 `deadline.ts` 那边修过（结构这一步现在有下限），但那**只是让饿死的概率
 * 变小**。这里要修的是兜底本身：失败代价严重不对等 —— 收口被压短只是话少一点，结构没出来
 * 就是一份没有正文的报告。**兜底也该按这个不对等来设计**：手上本来就有一份 N1 交的决策
 * 骨架（`draft.playbook`），排结构这一步本质上是在精修它，**精修失败就用毛坯**。
 *
 * 这一份由调用方备好（`stage-write.ts` 的 `playbookOutline`）：那边才认得候选路线和 N4 的
 * 复核结果，这里只负责「什么时候用它、用完之后那几条证据的账怎么落」。骨架也是空的（行业
 * 题，或者 N1 那一次也砸了）时这一栏不传，下面那条「折成一节」的老路一个字不变。
 */
export interface OutlineFallback {
  /** 骨架折出来的那几节。**空数组等于没有骨架** —— 走「折成一节」。 */
  sections: readonly A4OutlineSection[];
  /** 缺陷清单上那一句。读的人有权知道这一份的结构不是模型排的。 */
  note: string;
}

/**
 * 模型交的大纲 JSON → `A4Outline`。
 *
 * 三处会被改正，各自记一条 note：
 *
 *   · **一条证据都没分到的节留着。** 2026-08-31 之前是丢掉的，理由是「那一次分节调用
 *     手上什么都没有，只能凭既有知识写」。一号位把这条口径翻过来了：凭既有知识和推理写
 *     出来的那一节，正是他要的东西 —— 没有看法和判断的调研没有价值。所以现在只记一条
 *     note（提醒它靠推理撑），不再拿掉内容。真正要拦的东西移到了提示词那一侧：那一节
 *     必须交出推理链和证伪条件，交不出来是 lint 的事，不是这里的事。
 *   · **两边都没提到的证据补进最后一节。** 补给它一个被用上的机会，而不是替它写一条
 *     弃用理由：理由归模型（见文件头）。
 *   · **一节都没有**（模型答歪了、或者证据包是空的）：手上有决策骨架（`opts.fallback`）就
 *     按骨架分节，没有才**折成一节**，涵盖全部编号。这一支不是「退回旧的单次出稿」：单次
 *     出稿那条路在开关另一侧，两条路并存的下场是分节这条永远有一个没人跑过的兜底分支。
 */
export function readOutline(
  raw: unknown,
  packIds: string[],
  opts?: {
    /** 一节最少几个块的下限。决策题给 1，别的不传（默认 2）—— 见 `clampMin`。 */
    minBlocksFloor?: number;
    /** 排结构没成时顶上的毛坯大纲。不传 = 折成一节（见 `OutlineFallback`）。 */
    fallback?: OutlineFallback;
  }
): ReadOutlineResult {
  const floor = opts?.minBlocksFloor ?? 2;
  /**
   * 补漏派证据那一步用的下限。走毛坯大纲那一支时降到 1（见下面那段）——
   * **这一栏不跟着调用方走**：那一支的「一节一个块」是它自己的性质，不该因为上游忘了递
   * `minBlocksFloor` 就变成给写手多加一个凑块数的理由。
   */
  let leftoverFloor = floor;
  /** 这一份章节最后是谁排的。见 `OutlineSource`。 */
  let from: OutlineSource = "model";
  const notes: string[] = [];
  const o = obj(raw);
  const known = new Set(packIds);

  const seen = new Set<string>();
  const sections: A4OutlineSection[] = [];
  arr(o.sections ?? o.Sections).forEach((x, i) => {
    const s = obj(x);
    const title = str(s.title);
    const ids = arr(s.evidence_ids ?? s.evidenceIds)
      .map((v) => normalizeRef(v))
      .filter((id) => id && known.has(id) && !seen.has(`${i}:${id}`));
    // 同一节里重复的编号折掉；跨节重复是允许的（同一个数在两节答不同的问）。
    const dedup = [...new Set(ids)];
    if (!title) {
      notes.push(`大纲里第 ${i + 1} 节没有小标题，已丢掉这一节。`);
      return;
    }
    if (packIds.length && !dedup.length) {
      // 留着，只提醒。**这一句会跟着进缺口清单**，所以读报告的人知道这一节是推出来的。
      notes.push(`大纲里「${title}」这一节一条证据都没分到 —— 这一节靠推理撑，写的时候要把推理链和证伪条件交足。`);
    }
    sections.push({
      id: str(s.id) || `S${sections.length + 1}`,
      title,
      question: str(s.question) || title,
      evidenceIds: dedup,
      expectedBlocks: arr(s.expected_blocks ?? s.expectedBlocks).map(str).filter(Boolean),
      minBlocks: clampMin(s.min_blocks ?? s.minBlocks, dedup.length, floor),
    });
  });

  const unassigned = arr(o.unassigned)
    .map((x) => {
      const u = obj(x);
      return { id: normalizeRef(u.id), reason: str(u.reason) };
    })
    .filter((u) => u.id && known.has(u.id));

  const fallback = opts?.fallback;
  if (!sections.length && fallback?.sections.length) {
    /*
     * ---- 毛坯大纲那一支（2026-09-07，ISS-240）----
     *
     * 理由全在 `OutlineFallback` 上。这里只落两件事：
     *
     * 1. **说出来。** 那一句先进 `notes`，所以它一定在缺陷清单的最前面 —— 「按骨架分的节」
     *    和「模型排的结构」不是一回事，读的人有权知道自己手上是哪一份。
     * 2. **台账里没有的编号一律不认。** 骨架那几节的证据是从 N4 的策略更新上摘的，那一栏
     *    是模型写的，可能有本轮台账里根本没有的编号 —— 和上面读模型大纲那一段同一个口径
     *    （`known`），不能因为走的是兜底就松一档。
     *
     * 分完之后**不在这里补漏派的证据**：下面那段 `leftover` 对所有分支一视同仁，会把两边
     * 都没提到的补进最后一节并记一账。走这条路和走模型大纲那条路，证据的归属都由同一段代码
     * 保证 —— 「按骨架分节之后有证据静默消失」这种事没有第二个地方可以发生。
     */
    notes.push(fallback.note);
    from = "playbook";
    leftoverFloor = 1;
    sections.push(
      ...fallback.sections.map((s) => ({
        ...s,
        evidenceIds: [...new Set(s.evidenceIds.filter((id) => known.has(id)))],
        /*
         * 下限按 1 走，不按 `floor`：一条建议一节，一个块（一段机制，或者一条判断）就答完了
         * 它那一问。硬卡在 2 的后果是这一支专门给写手加一个凑块数的理由 —— 而这一支出现的
         * 时候，这一轮已经在跟时间赛跑了。
         */
        minBlocks: clampMin(s.minBlocks, s.evidenceIds.length, 1),
      }))
    );
  }

  if (!sections.length) {
    from = "single";
    notes.push(
      packIds.length
        ? "大纲那一次没有交出可用的章节，已折成一节，涵盖全部证据。"
        : "这一轮没有证据包，大纲折成一节 —— 这一节要靠推理把答案写出来。"
    );
    /*
     * 兜底那一节的问法**决定了这一份报告是什么**。
     *
     * 上一版问的是「递给你的这些材料合起来回答了这个议题的哪一部分」，标题是「这一轮的
     * 材料说得出什么」。`RUN-A4-mth5jkf0-6`（ISS-118）撞上这一支之后交回来的正是这句话
     * 要来的东西：一节材料盘点、三段复述内部文档、结尾一句「尚不能判断」。**那不是模型
     * 偷懒，是这里问错了问题** —— 问「材料说得出什么」，答案当然是关于材料的。
     *
     * 所以现在问的是议题本身。手上有多少材料是写作时的约束，不是要回答的那一问。
     */
    sections.push({
      id: "S1",
      title: "这个问题的答案",
      question:
        "这个议题的答案是什么 —— 先把结论说出来，再说清它靠什么推出来、它的机制是什么、什么会推翻它。" +
        "材料不足时用你的既有认识和推理补上，把把握写在分档里，不要写成不表态。",
      evidenceIds: [...packIds],
      expectedBlocks: ["prose", "judgment"],
      minBlocks: clampMin(0, packIds.length, floor),
    });
  }

  const placed = new Set([...sections.flatMap((s) => s.evidenceIds), ...unassigned.map((u) => u.id)]);
  const leftover = packIds.filter((id) => !placed.has(id));
  if (leftover.length) {
    const last = sections[sections.length - 1];
    last.evidenceIds = [...last.evidenceIds, ...leftover];
    last.minBlocks = clampMin(last.minBlocks, last.evidenceIds.length, leftoverFloor);
    notes.push(
      `大纲把 ${leftover.length} 条证据（${leftover.slice(0, 8).join("、")}）既没派给任何一节、也没写进 unassigned，` +
        `已补进最后一节「${last.title}」。`
    );
  }

  const thesisDraft = str(o.thesis_draft ?? o.thesisDraft);
  if (!thesisDraft) notes.push("大纲没有交出标题句草稿，收口那一次要自己定标题。");

  return { outline: { thesisDraft, sections, unassigned }, notes, from };
}

/* -------------------------------------------------------------------------- */
/* 要点清单                                                                    */
/* -------------------------------------------------------------------------- */

const clip = (s: string, n = 60): string => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n)}…` : t;
};

/**
 * 一节的**要点**，一行一条。
 *
 * 往下一节递的是这个，不是那一节的正文（补遗 §3 的上下文预算：全文级别的回灌一节比一节
 * 贵，到第五节时前四节的正文比证据还长，而模型会开始顺着前文写而不是照自己那几条证据写）。
 * 要点清单只要够它认出「这个数已经说过了」就行 —— 第 3 条硬规则要的正是这件事。
 */
export function keyPointsOf(section: Pick<A4OutlineSection, "id" | "title">, blocks: Block[]): string {
  const points: string[] = [];
  for (const b of blocks) {
    switch (b.type) {
      case "kpi_cards":
        points.push(...b.cards.map((c) => `${c.label} ${c.value}${c.unit ?? ""}`));
        break;
      case "judgment":
        points.push(`判断：${clip(b.claim)}（${b.confidence}）`);
        break;
      case "funnel":
        points.push(`漏斗：${b.stages.map((s) => `${s.label} ${s.value}`).join(" → ")}`);
        break;
      case "bar_compare":
        points.push(`比较：${b.items.map((x) => `${x.label} ${x.value}`).join("、")}`);
        break;
      case "layered_table":
        points.push(`分层表：${b.columns.join("／")}，${b.rows.length} 行`);
        break;
      case "caliber_map":
        points.push(`口径：${b.rows.map((r) => r.metric).join("、")}`);
        break;
      case "scenario_cards":
        points.push(`情景：${b.cards.map((c) => c.name).join("、")}`);
        break;
      case "param_model":
        points.push(`算式：${b.outputs.map((x) => `${x.label}＝${x.expr}`).join("；")}`);
        break;
      case "prose":
        points.push(clip(b.md.split(/[。！？\n]/)[0] ?? "", 70));
        break;
      default:
        break;
    }
  }
  const lines = points.filter(Boolean).map((x) => `　· ${x}`);
  return [`${section.id}　${section.title}`, ...lines].join("\n");
}

/* -------------------------------------------------------------------------- */
/* 几节之间说重了没有                                                          */
/* -------------------------------------------------------------------------- */

/** 一个「数字性事实」：数带上紧跟着的单位。年份、证据编号、第 N 节不算。 */
const NUMBERS = /(?<![A-Za-z\d.])(\d[\d,]*(?:\.\d+)?)\s*(%|pt|万|亿|元|台|张|个|条|kW|kWh|EFLOPS)?/g;

const factsIn = (text: string): Set<string> => {
  const out = new Set<string>();
  const cleaned = text
    .replace(/\[E\d+(?:\s*[,，]\s*E?\d+)*\]/g, "")
    .replace(/(?:19|20)\d{2}\s*(?:年|-|\/)?/g, "")
    .replace(/第\s*\d+\s*[节章条项段步轮]/g, "");
  for (const m of cleaned.matchAll(NUMBERS)) {
    const n = m[1].replace(/,/g, "");
    // 一位数的裸数字（「三条里有两条」）满篇都是，当成重复线索只会全是假阳。
    if (!m[2] && n.length < 3) continue;
    out.add(`${n}${m[2] ?? ""}`);
  }
  return out;
};

/**
 * 同一个数在几节里各展开了一遍 —— 交上来的是**线索，不是判决**（补遗 §5③）。
 *
 * 并发跑各节时它们互相看不见，所以重复只能事后查；顺序跑时要点清单已经拦了一层，这里
 * 兜的是「拦了还是写了」。为什么不做成 p0：同一个数在两节出现有时是对的（一节给口径、
 * 一节用它算账），而「引用」和「重复展开」的区别读一遍才判得准。所以它进 `notes`，
 * 落在运营台那一栏上，由人决定要不要退回。
 */
export function crossSectionRepeats(sections: { id: string; title: string; blocks: Block[] }[]): string[] {
  const seen = new Map<string, string[]>();
  for (const s of sections) {
    for (const fact of factsIn(blocksToText({ title: "", blocks: s.blocks }))) {
      seen.set(fact, [...(seen.get(fact) ?? []), s.id]);
    }
  }
  return [...seen]
    .filter(([, ids]) => ids.length > 1)
    .slice(0, 12)
    .map(([fact, ids]) => `「${fact}」在 ${ids.join("、")} 里各出现了一次 —— 后面那几节只该引用它，不该重新展开。`);
}

/* -------------------------------------------------------------------------- */
/* 证据利用率对账                                                              */
/* -------------------------------------------------------------------------- */

/** 列进 `evidence_list` 不算「用上了」—— 那一节的作用是把取回来的都摆出来。 */
const usedIn = (blocks: Block[]): Set<string> =>
  new Set(citedRefs(blocks.filter((b) => b.type !== "evidence_list")));

export interface UsageAccount {
  block: EvidenceUsageBlock;
  /** 两边都没交代的那几条。**这里不替它们补理由** —— A4-B11 会拒，然后返修那一轮去问模型。 */
  uncovered: string[];
}

/**
 * 合出整份那一块 `evidence_usage`。
 *
 * `declared` 收的是各节节尾那几行和大纲 `unassigned` 里的声明。同一条在两处都被声明时
 * 留第一条理由 —— 两条理由拼起来会写成「与E2共源／与本议题无关」，读的人不知道到底哪个。
 */
export function mergeUsage(o: {
  packIds: string[];
  /** 正文那些块（各节 + 收口，`evidence_usage` 本身不算）。 */
  blocks: Block[];
  declared: { id: string; reason: string }[];
  heading?: string;
}): UsageAccount {
  const used = usedIn(o.blocks);
  const inPack = new Set(o.packIds);

  const reasons = new Map<string, string>();
  for (const d of o.declared) {
    const id = normalizeRef(d.id);
    if (!id || !inPack.has(id) || used.has(id) || reasons.has(id)) continue;
    reasons.set(id, d.reason);
  }

  const usedList = o.packIds.filter((id) => used.has(id));
  const discarded = [...reasons].map(([id, reason]) => ({ id, reason }));
  const uncovered = o.packIds.filter((id) => !used.has(id) && !reasons.has(id));

  return {
    block: {
      type: "evidence_usage",
      used: usedList,
      discarded,
      ...(o.heading ? { heading: o.heading } : {}),
    },
    uncovered,
  };
}

/**
 * 那张账的人话面。收口那一次读它 —— 它自己看不到各节引了什么。
 *
 * ## 前两行是给它看的，不是给它抄的
 *
 * 「用上了」和「弃用」这两栏收口**读**：它要靠这份账写 evidence_list、判断哪几条真的改变了
 * 结论。但它**抄回来的那两栏一个字都不会被采用** —— `used` 由 `usedIn` 从正文里算
 * （代码算的那份才是真的），`discarded` 里各节已经声明过的那几条在 `mergeUsage` 里被
 * 「留第一条理由」挡掉。
 *
 * 这件事 2026-09-03 之前没人说给模型听，于是它每一轮把整张表誊一遍。那一轮收口写了 10016
 * 个 token、花了 240 秒，而这条链上 50 tok/s 的吞吐意味着誊写的每一千字都是二十秒 —— 花在
 * 一段注定被丢掉的输出上。所以最后那一行的措辞改成「只写这几条」，收口那一次的提示词跟着改。
 *
 * **`uncovered` 仍旧不在代码里替它补理由**（见 `mergeUsage`）：那几条要么真的漏了，要么各节
 * 没交代，两种都该被 A4-B11 拒一次，然后返修那一轮去问模型。代码补一句「未交代」等于用一句
 * 废话把这道闸关上。
 */
export function usageMaterial(a: UsageAccount): string {
  return [
    a.block.used.length ? `用上了：${a.block.used.join("、")}` : "各节一条证据都没引上。",
    ...a.block.discarded.map((d) => `弃用 ${d.id}：${d.reason || "（没有写理由）"}`),
    `上面这两栏**只供你判断哪几条证据真的改变了结论**（写 evidence_list 要用）。` +
      `它们系统已经算好了，抄回来的那一份不会被采用 —— 你的 evidence_usage 只写下面这一行里的编号。`,
    a.uncovered.length
      ? `还没有交代的：${a.uncovered.join("、")} —— 这几条既没被引、也没有弃用理由。` +
        `**你的 evidence_usage 只写这几条**（\`used\` 交空数组）。你手上没有它们的内容，所以` +
        `**不要替它们编一条理由**：照实写进 discarded 并注明「各节未交代弃用理由」。`
      : `还没有交代的：一条都没有 —— **这一次不要写 evidence_usage 这一块**。`,
  ]
    .filter(Boolean)
    .join("\n");
}

/* -------------------------------------------------------------------------- */
/* 拼成一份                                                                    */
/* -------------------------------------------------------------------------- */

/** 一次调用交上来的那一段，解析之后的样子。 */
interface Part {
  blocks: Block[];
  sources: string[];
  metaLine: string;
  /**
   * 决断包原样的那一行（ISS-238）。**它不是块**，所以不在 `blocks`/`sources` 里 ——
   * 下面拼整份 JSONL 那一步是按 `sources` 挑行的，不单独把它拿出来，决策题收口交的
   * 那一屏就在拼装这一步没了，而后面没有任何一处看得出少了它。
   */
  commandBriefLine: string;
  bad: number;
}

const FENCE = /^```[a-zA-Z]*$/;

const readPart = (text: string): Part => {
  const p = parseBlocks(text, { complete: true });
  const metaLine =
    (text ?? "")
      .split(/\r?\n/)
      .map((x) => x.trim())
      .filter((x) => x && !FENCE.test(x))
      .find((x) => x.includes(`"report_meta"`)) ?? "";
  return { blocks: p.blocks, sources: p.sources, metaLine, commandBriefLine: p.commandBriefLine, bad: p.bad.length };
};

const pick = (p: Part, keep: (b: Block) => boolean): string[] =>
  p.sources.filter((_, i) => p.blocks[i] && keep(p.blocks[i]));

/**
 * 像不像一枚编号：`E1`、`K1`、`S3-K1`、`E-INT`、`M1-3`、`ISS-227` 都是；带空格、标点或汉字的不是。
 * 编号本身对不对（台账里有没有）由 A4-B06 判，这里只管形状。
 */
const ID_SHAPE = /^[A-Za-z][A-Za-z0-9_-]*$/;

/** 把对象树里每个 `evidenceRefs` 中不像编号的项剔掉。返回有没有改过。 */
const pruneRefs = (v: unknown): boolean => {
  if (Array.isArray(v)) return v.map(pruneRefs).some(Boolean);
  if (!v || typeof v !== "object") return false;
  const o = v as Record<string, unknown>;
  let changed = false;
  if (Array.isArray(o.evidenceRefs)) {
    const kept = o.evidenceRefs.filter((x) => typeof x === "string" && ID_SHAPE.test(x.trim())).map((x) => (x as string).trim());
    if (kept.length !== o.evidenceRefs.length) {
      o.evidenceRefs = kept;
      changed = true;
    }
  }
  for (const k of Object.keys(o)) if (k !== "evidenceRefs" && pruneRefs(o[k])) changed = true;
  return changed;
};

/**
 * 装配前对一行源文做两件确定性的事（2026-09-05）：
 *
 * 1. **各节交上来的横幅降成段落。** 一份报告只许一个横幅，那是收口的（A4-B01）。Claude 写手九轮里
 *    四轮在某一节的第一块交了 `verdict_banner`，提示词里「不要在这一节里给整份报告下结论」拦不住它。
 *    降级不丢内容：正文进 `md`，边界那句跟在后面，标题照旧。
 * 2. **`evidenceRefs` 里不像编号的项剔掉。** 无证据那一轮写手被告知不写编号之后，把「本节推理，待内部
 *    记录核」「公司经营原则：Outcome 先于任务」这类话写进了这一栏，A4-B06 按点不开的引用退回。这一栏
 *    是给编号用的，不是给话用的。只剔形状不对的：`K1` 这类模型既有知识的编号照留，对不对由 B06 判；
 *    一张卡的编号剔光了，A4-B02（数字要有出处）照报 —— 那是对的，没出处的数本来就该被退。
 *
 * 改的是源文那一行，后面 `assembleReport` 重新解析。解析不开的行原样放回。
 */
function normalizeLine(source: string, o: { demoteBanner: boolean }): string {
  let obj: Record<string, unknown>;
  try {
    const parsed: unknown = JSON.parse(source);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return source;
    obj = parsed as Record<string, unknown>;
  } catch {
    return source;
  }
  let changed = false;
  if (o.demoteBanner && obj.type === "verdict_banner") {
    const text = typeof obj.text === "string" ? obj.text : "";
    const boundary = typeof obj.boundary === "string" && obj.boundary.trim() ? `\n\n适用边界：${obj.boundary.trim()}` : "";
    const heading = typeof obj.heading === "string" && obj.heading.trim() ? { heading: obj.heading.trim() } : {};
    obj = { type: "prose", ...heading, md: `${text}${boundary}` };
    changed = true;
  }
  if (pruneRefs(obj)) changed = true;
  return changed ? JSON.stringify(obj) : source;
}

export interface AssembleStagedResult {
  /** 拼好的整份 JSONL，交给 `assembleReport` 走一遍。 */
  text: string;
  notes: string[];
  /** 合出来的那张账。运营台那一栏要报「取回几条、用上几条」。 */
  usage: UsageAccount;
}

/**
 * 各节 + 收口 → 一份完整的 JSONL。
 *
 * 顺序是他读下来的顺序，所以不按调用顺序拼：**收口的横幅在最前、推翻条件卡在最后**，
 * 各节按大纲的顺序夹在中间。
 *
 *   report_meta → verdict_banner → 各节 → 收口剩下的几块 → evidence_usage → falsify_card
 *
 * 各节和收口交的 `evidence_usage` 都摘掉，换成代码合出来的那一张：模型交的那几份各自
 * 只看得见自己那一段，拼在一起会出现三块内容互相矛盾的对账。
 */
export function assembleStaged(o: {
  outline: A4Outline;
  /** 按大纲顺序，每节交上来的原文。 */
  sections: { id: string; text: string }[];
  /** 收口交上来的原文。空串表示收口这一次没跑成。 */
  closing: string;
  packIds: string[];
}): AssembleStagedResult {
  const notes: string[] = [];
  const parts = o.sections.map((s) => ({ id: s.id, part: readPart(s.text) }));
  const closing = readPart(o.closing);

  for (const { id, part } of parts) {
    if (part.bad) notes.push(`${id} 那一节有 ${part.bad} 行没解析出来。`);
    if (!part.blocks.length) notes.push(`${id} 那一节一个块都没交出来。`);
  }
  if (closing.bad) notes.push(`收口那一次有 ${closing.bad} 行没解析出来。`);

  const isUsage = (b: Block): boolean => b.type === "evidence_usage";
  const bodyBlocks = [
    ...parts.flatMap(({ part }) => part.blocks),
    ...closing.blocks.filter((b) => !isUsage(b)),
  ].filter((b) => !isUsage(b));

  const declared = [
    ...parts.flatMap(({ part }) =>
      part.blocks.flatMap((b) => (b.type === "evidence_usage" ? b.discarded : []))
    ),
    ...closing.blocks.flatMap((b) => (b.type === "evidence_usage" ? b.discarded : [])),
    ...o.outline.unassigned,
  ];

  const usage = mergeUsage({
    packIds: o.packIds,
    blocks: bodyBlocks,
    declared,
    heading: "取回来的证据都去哪儿了",
  });
  if (usage.uncovered.length) {
    notes.push(
      `有 ${usage.uncovered.length} 条证据（${usage.uncovered.slice(0, 8).join("、")}）既没被引上、` +
        `也没有一处给出弃用理由 —— 出口校验器 A4-B11 会拒，返修那一轮去问。`
    );
  }

  const norm = (demoteBanner: boolean) => (src: string) => normalizeLine(src, { demoteBanner });
  // 横幅只归收口，且只留第一个；各节交的、收口多交的，都降成段落。
  const [firstBanner, ...extraBanners] = pick(closing, (b) => b.type === "verdict_banner");
  const sectionBanners = parts.reduce((n, { part }) => n + part.blocks.filter((b) => b.type === "verdict_banner").length, 0);
  if (sectionBanners + extraBanners.length) {
    notes.push(`交上来 ${sectionBanners + extraBanners.length} 个多出来的横幅，已降成段落 —— 横幅只归收口，一份报告只有一个。`);
  }

  /*
   * 决断包只归收口（`prompt.ts` 的块目录里写着「只在决策题的收口那一次交」）。某一节顺手
   * 交了一个的话丢掉并记一账 —— 那一份是它凭自己那一节写的，而这一屏要的是全份看完之后的判断。
   */
  const strayBriefs = parts.filter(({ part }) => part.commandBriefLine).map(({ id }) => id);
  if (strayBriefs.length) {
    notes.push(`${strayBriefs.join("、")} 这几节各交了一个决断包，已丢掉 —— 决断包只归收口，它才看得见全份。`);
  }

  const lines = [
    closing.metaLine,
    // 位置跟 report_meta 一样在最前面：它是报告之上的一层，不占正文的位置。
    closing.commandBriefLine,
    ...(firstBanner ? [norm(false)(firstBanner)] : []),
    ...parts.flatMap(({ part }) => pick(part, (b) => !isUsage(b)).map(norm(true))),
    ...extraBanners.map(norm(true)),
    ...pick(closing, (b) => b.type !== "verdict_banner" && b.type !== "falsify_card" && !isUsage(b)).map(norm(false)),
    JSON.stringify(usage.block),
    ...pick(closing, (b) => b.type === "falsify_card").map(norm(false)),
  ].filter(Boolean);

  if (!closing.metaLine) notes.push("收口那一次没有交出 report_meta 那一行。");

  return { text: `${lines.join("\n")}\n`, notes, usage };
}
