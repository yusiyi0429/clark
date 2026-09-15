/**
 * 一份区块报告的**组装**与它的**纯文本面**。
 *
 * 组装那一半（`assembleReport`）是 JSONL → 落库形态的那一条路：解析、按台账折证据表、
 * 算证据包编号。三处走的是这同一个函数 —— 真链路收尾、真链路跑到一半（半份也要上屏）、
 * 以及 fixture。分开写的下场是 fixture 证明不了真链路：任务书 §6① 要的是「手工构造的
 * fixture 渲染通过全部组件」，而那句话只有在 fixture 和真链路共用组装逻辑时才成立。
 *
 * ## 为什么还要一个纯文本面
 *
 * 区块 JSON 是正规形态（任务书 §0②），但库里和屏幕上有四个地方只认文本：报告页签那一面
 * 「原文」（他要复制、要签发、要和老数据摆在一排）、压成四节那一步的输入、出口闸
 * `gate.ts`（裸地址、反证有没有被应答、复算），还有老库里那几百份没有块的报告。
 *
 * 这一面是**写完那一刻冻下来的一份快照**，不是每次渲染再拼一遍。差别要紧：`ResearchDoc.blocks`
 * 那条注释里写着「拼回来的那份不是他签的那份」—— 说的是渲染时转写，改一次排版规则，
 * 库里所有报告的正文就跟着变样。写入时转写一次、存起来，那份字就再也不动了。
 *
 * 转写是**有损**的：表格拉成竖排的句子，卡片拉成一行一句。所以它只是一面，不是原件 ——
 * 原件是块。
 *
 * **决断包不在这一面上。** 它不是报告的一节（`schema.ts` 的 `CommandBrief`），也就不该被
 * 转写进那份可署名分发的正文里 —— 那份正文是论证，决断包是论证之上要他拍的板。屏幕按
 * `ReportBlocks.commandBrief` 单独渲染它。
 */

import type { RejectedBlock } from "@/lib/agent/a4/prompt";
import type { Evidence } from "@/lib/research/ledger";

import { materialCutoff, type MaterialCutoff } from "../disclosure";

import { parseBlocks } from "./parse";
import { buildRegistry, packIdOf } from "./registry";
import {
  isCommandBriefLine,
  isMetaLine,
  readBlock,
  readMeta,
  type Block,
  type KpiCardsBlock,
  type LayeredTableBlock,
  type ReportBlocks,
  type ReportMeta,
} from "./schema";

/* -------------------------------------------------------------------------- */
/* 组装                                                                        */
/* -------------------------------------------------------------------------- */

export interface AssembleInput {
  /** 模型交上来的 JSONL，累积的全文。 */
  text: string;
  /** 这一条链路自己的台账。**别人的台账绑不了这一份的编号** —— E3 在三条链路里各指一页。 */
  entries: Evidence[];
  lane: ReportBlocks["lane"];
  /**
   * 主体自己的官网域名。除交易所与巨潮之外还算一手披露的那几家，`disclosureCutoff` 用。
   * 不给就只认写死的那张表 —— 少认一家，不影响其余。
   */
  disclosureDomains?: readonly string[];
  /** 收尾那一次给 true：这时最后一行必须站得住，站不住就是真坏了（见 `parse.ts`）。 */
  complete?: boolean;
}

/* -------------------------------------------------------------------------- */
/* 同一个数只印一遍                                                            */
/* -------------------------------------------------------------------------- */

/**
 * 比对用的归一化：去空白、去证据编号、去括注、去「约」「近」这类前缀、去句末标点。
 *
 * **不动百分号、不动小数点、不动区间的连字符** —— 那几样是数本身，抹掉它们
 * 「62」和「62%」就成了同一个数，而那正是这道去重最不该判错的地方。
 */
const normCell = (v: string): string =>
  (v ?? "")
    .replace(/\[E\d+(?:\s*[,，]\s*E?\d+)*\]/g, "")
    .replace(/[（(][^)）]*[)）]/g, "")
    .replace(/[\s ]/g, "")
    .replace(/^[约近超过大于小于不足≈~≥≤<>＜＞]+/, "")
    .replace(/[。，,、；;：:]+$/, "")
    .toLowerCase();

/** 标签对得上吗。两边都要有两个字以上 —— 一个字的「率」「量」谁都包得住。 */
const labelHits = (label: string, cell: string): boolean => {
  const a = normCell(label);
  const b = normCell(cell);
  if (a.length < 2 || b.length < 2) return false;
  return a.includes(b) || b.includes(a);
};

/**
 * **同一个数在表里出现过，就不再单开一张卡。**（ISS-238：那一份里四个数各出现两遍，
 * 一次在 kpi_cards、一次在 layered_table 的整行里，一号位读到的是同一件事说了两遍。）
 *
 * ## 判据：数值 + 标签，必须落在同一行
 *
 * 一张卡算重复，要同时满足两条：
 *
 *   1. 某张分层表的**某一行**里，有一格等于这张卡的 `value`（或 `value + unit`）；
 *   2. **同一行的另一格、或者这张表的表头**里，有一格和卡的 `label` 对得上。
 *
 * 缺任何一条都不算。只按数值判会把「上架率 62%」和「客户数 62」判成同一个数；只按标签判
 * 会把一张写着同一个指标**另一个口径**的卡也吃掉，而那两个数摆在一起正是报告要说的事。
 * 要求落在同一行，是因为「这一行讲的就是这张卡」这件事只有同一行才证得出来 —— 表头里有
 * 「上架率」、另一行里有「62%」，说的可能是别的机房。
 *
 * **宁可漏判不要错判**：漏判的代价是一个数印了两遍（读起来啰嗦），错判的代价是一个数
 * 消失了（读起来是另一份报告）。所以这里没有模糊匹配数值、没有单位换算、没有跨表凑。
 *
 * ## 折完之后块的个数不变
 *
 * 整块卡都被折掉时，**换成一个 `prose`，而不是把这个块删掉**。删块要动的不只是这里：
 * `Assembled.sources` 和它同序同长（返修按下标对齐）、`appendixFrom` 是一个按块数算出来的
 * 下标（`stage-write.ts` 在重排那一步算的，用的是折之前那一份）。少一个块，那两处一起错位，
 * 而错位的表现是附录边界挪了一格 —— 屏幕上看不出是 bug。
 *
 * 换成的那一句就是任务书说的「卡降成一句引用」：数留一遍在表里，卡这一侧只剩一句指路。
 */
export function foldDuplicateKpis(blocks: Block[]): { blocks: Block[]; notes: string[] } {
  const tables = blocks.filter((b): b is LayeredTableBlock => b.type === "layered_table");
  if (!tables.length || !blocks.some((b) => b.type === "kpi_cards")) return { blocks, notes: [] };

  const notes: string[] = [];
  const inTable = (card: KpiCardsBlock["cards"][number]): boolean => {
    const wanted = [normCell(card.value), normCell(`${card.value}${card.unit ?? ""}`)].filter(
      // 数值里没有数字的（「持平」「未披露」）不参与：那不是「同一个数」，是一句话。
      (x) => x && /\d/.test(x)
    );
    if (!wanted.length) return false;
    return tables.some((t) =>
      t.rows.some((row) => {
        if (!row.some((cell) => wanted.includes(normCell(cell)))) return false;
        return row.some((cell) => labelHits(card.label, cell)) || t.columns.some((c) => labelHits(card.label, c));
      })
    );
  };

  const out = blocks.map((b, i) => {
    if (b.type !== "kpi_cards") return b;
    const kept = b.cards.filter((c) => !inTable(c));
    const folded = b.cards.filter((c) => inTable(c));
    if (!folded.length) return b;
    for (const c of folded) {
      notes.push(`第 ${i + 1} 个块的「${c.label} ${c.value}${c.unit ?? ""}」在分层表里已经有整行，卡这一侧折成一句引用`);
    }
    if (kept.length) return { ...b, cards: kept };
    /*
     * 整块都被折掉：换成一句引用。编号跟着句子一起过来，不然这一句在 `lint.ts` 的 A4-B02
     * 那里是「带数字没绑证据」—— 而它绑的就是卡原来绑的那几条。
     */
    const md = folded
      .map((c) => {
        const head = `${c.label} ${c.value}${c.unit ? ` ${c.unit}` : ""}${cites(c.evidenceRefs)}这个数在这一份的分层表里已经列过，这里只留一句引用。`;
        return c.caliberNote ? `${head}口径：${c.caliberNote}${cites(c.evidenceRefs)}` : head;
      })
      .join("\n\n");
    return { ...(b.heading ? { heading: b.heading } : {}), type: "prose" as const, md };
  });

  return { blocks: out, notes };
}

/* -------------------------------------------------------------------------- */
/* 同一条判断只上板一次                                                        */
/* -------------------------------------------------------------------------- */

/**
 * 要折的那一条判断。**这一层不认识块**：`pipeline.ts` 的 `foldSections` 从
 * `verdict_banner` 和 `judgment` 块里取出这几栏递进来，折完的再拼回 `Statement`。
 *
 * 分开的理由是这道去重要能被单测钉死，而 `foldSections` 那一侧连着台账、`Ledger`、
 * `ResearchDoc` 三个类型 —— 把判据写在那里等于永远只能靠跑一遍整条链路来验它。
 */
export interface FoldableClaim {
  /** 上板那一句。**折完原样返回，这一层不改写文字。** */
  text: string;
  /**
   * 这条判断在什么范围内成立（`verdict_banner.boundary`）。
   *
   * **空不等于「无边界」，只等于「这一条没写」。** 所以一空一有时按「可能是同一条」处理，
   * 两边都写了而且不一样时**一律不折** —— 那正是任务书要护住的东西：同义可以合，
   * 不同边界不能合。
   */
  boundary?: string;
  /**
   * 结构化 claim ID。收口那一屏和正文引的是同一条时，两处的 ID 相同。
   *
   * 有它就不必猜同义：ID 相同 = 同一条判断被印了两遍。**但边界不同时仍然不折** ——
   * 「同一个 ID 下写着两个不同的成立范围」是一处矛盾，折掉等于把矛盾藏起来（ISS-239
   * 的「摘要为 AND、正文变 OR」就是这一类），所以那一种只记一条 note，两条都留。
   */
  claimId?: string;
  /** 绑的证据编号。折的时候两边并起来 —— 留下的那一条要带走被折那条的出处。 */
  evidenceRefs?: readonly string[];
}

export interface FoldedClaims {
  /** 留下来的，按原顺序。被折掉的那条的证据编号已经并进它们了。 */
  kept: FoldableClaim[];
  /** 折了什么、以及哪几对像同义但因为边界或极性不同而**没有**折。**不静默。** */
  notes: string[];
}

/** 比对用的归一化。去证据编号、去括注、去空白、去标点。`normCell` 的判断句版本。 */
const normClaim = (v: string): string =>
  (v ?? "")
    .replace(/\[E\d+(?:\s*[,，]\s*E?\d+)*\]/g, "")
    .replace(/[（(][^)）]*[)）]/g, "")
    .replace(/[\s ]/g, "")
    .replace(/[。，,、；;：:！!？?「」“”"'）)（(]/g, "")
    .toLowerCase();

/**
 * 这句话是不是带否定。**只是一道护栏，不是分类器。**
 *
 * 「这条路线走得通」和「这条路线走不通」在字面上差一个字，任何按字符重合度算的相似度
 * 都会把它们判成同一条。所以两句的否定与否不同时一律不折 —— 代价是屏幕上多印一句，
 * 而错判的代价是一条判断和它的反面只剩一条上板。
 */
const negated = (norm: string): boolean => /不|未|没|无|非|难以|尚待|尚需/.test(norm);

/** 字符二元组。长度不足 2 的退成单字，否则两个字的短句永远算 0 分。 */
const bigrams = (s: string): string[] => {
  if (s.length < 2) return s ? [s] : [];
  const out: string[] = [];
  for (let i = 0; i + 1 < s.length; i += 1) out.push(s.slice(i, i + 2));
  return out;
};

/** Dice 系数。1 = 一模一样，0 = 一个二元组都不共。 */
const dice = (a: string, b: string): number => {
  const A = bigrams(a);
  const B = bigrams(b);
  if (!A.length || !B.length) return 0;
  const pool = new Map<string, number>();
  for (const g of A) pool.set(g, (pool.get(g) ?? 0) + 1);
  let hit = 0;
  for (const g of B) {
    const n = pool.get(g) ?? 0;
    if (n > 0) {
      hit += 1;
      pool.set(g, n - 1);
    }
  }
  return (2 * hit) / (A.length + B.length);
};

/**
 * 同义判断只留一条。**去同义，不抹掉不同边界，也不抹掉冲突。**
 *
 * ISS-239 的账：判断板上「当前判断 1」和「当前判断 3」基本同义，一号位读到的是同一件事
 * 说了两遍；而同一份报告里，决断包说验收标准是唯一成功判据、正文要求五项齐全，摘要的
 * 停止条件是三项任一、决断包是三项同时 —— 那几对**长得也很像**，但它们是矛盾，不是重复。
 * 所以这道去重要能分开「同一句说了两遍」和「两句话不一样」。
 *
 * ## 折与不折
 *
 * 两条判断只在**三条同时成立**时才折成一条：
 *
 *   1. **边界兼容** —— 两边的边界归一化后相同，或者其中一边没写。两边都写了而且不同 =
 *      不同边界，留着。
 *   2. **极性一致** —— 一句带否定一句不带，一律不折（`negated`）。
 *   3. **文面同义** —— 满足其一：claim ID 相同；归一化后完全相同；短的那句整个含在长的
 *      那句里（且短句归一化后不少于 8 个字，防止「这一点成立」这种短语吃掉一整条）；
 *      或者字符二元组 Dice ≥ `similarity`（默认 0.72）。
 *
 * ## 0.72 这个数，以及为什么光靠它不行
 *
 * 2026-09-07 拿这套语料实测过（`report.test.ts` 里那几对就是量的样本）：
 *
 *   · 真同义的一对 —— 「首访应该先弄清客户要解决的问题，不谈报价」对
 *     「这一次拜访先弄清客户要解决的问题，不谈报价」—— **0.757**；
 *   · 一正一反的一对 —— 「采购动机已经得到验证」对「采购动机尚未得到验证」——
 *     **0.750**。
 *
 * 两个数只差 0.007。**任何阈值都分不开它们**：卡在 0.75 以上会连真同义那对一起漏掉，
 * 卡在 0.75 以下会把一条判断和它的反面合成一条。所以真正分开这两种的是第 2 条那道
 * 极性护栏，不是阈值；阈值只负责把「压根在说两件事」的挡在外面（实测那几对是 0.00 与
 * 0.31，离 0.72 很远）。
 *
 * 这也是为什么 `similarity` 是个参数而不是常数：要更狠地合，调它；**但不要动上面那三条**，
 * 那三条才是「不抹掉冲突」的保证。少合一条的代价是读起来啰嗦，多合一条的代价是屏幕上
 * 少了一条判断 —— 而少的那条没有任何一处会报出来。
 *
 * **不新增模型调用**：这里没有任何一处需要问模型。语义上真正同义而字面不像的那几对
 * （实测 0.31 那一对就是），这道函数合不掉 —— 那是它的已知边界，写在这里而不是留给
 * 下一个人去发现。有结构化 claim ID 的那一路不受这个限制。
 */
export function foldSynonymousClaims(
  claims: readonly FoldableClaim[],
  opts: { similarity?: number } = {}
): FoldedClaims {
  const threshold = opts.similarity ?? 0.72;
  const notes: string[] = [];
  const kept: { one: FoldableClaim; norm: string; boundary: string; refs: string[] }[] = [];

  claims.forEach((one, i) => {
    const norm = normClaim(one.text);
    const boundary = normClaim(one.boundary ?? "");
    const refs = [...(one.evidenceRefs ?? [])];

    /*
     * `folded` 这个旗子不能省。**留下和折掉之外还有第三种结局**：像同义、但因为边界不同
     * 或者一正一反而**两条都留**。那一种要记一条 note 之后照样 `kept.push` —— 早期版本
     * 在那一支直接 return，结果是「发现了一处冲突」把这条判断从屏幕上抹掉了，而它抹掉的
     * 正好是这道函数最该护住的那一条。
     */
    let folded = false;
    if (norm) {
      for (const prev of kept) {
        const sameId = Boolean(one.claimId && prev.one.claimId && one.claimId === prev.one.claimId);
        const shorter = norm.length <= prev.norm.length ? norm : prev.norm;
        const longer = norm.length <= prev.norm.length ? prev.norm : norm;
        const alike =
          sameId ||
          norm === prev.norm ||
          (shorter.length >= 8 && longer.includes(shorter)) ||
          dice(norm, prev.norm) >= threshold;
        if (!alike) continue;

        if (boundary && prev.boundary && boundary !== prev.boundary) {
          notes.push(
            `第 ${i + 1} 条判断和前面那条说的是同一件事，但成立边界写得不一样` +
              `（「${one.boundary}」对「${prev.one.boundary}」）—— 两条都留着，这是一处待裁的分歧，不是重复。`
          );
          break;
        }
        if (negated(norm) !== negated(prev.norm)) {
          notes.push(`第 ${i + 1} 条判断和前面那条字面相近但一正一反 —— 两条都留着，这是冲突，不是重复。`);
          break;
        }

        // 折：留前面那条，把这一条的证据编号并过去，边界取写了的那一个。
        for (const r of refs) if (r && !prev.refs.includes(r)) prev.refs.push(r);
        if (!prev.one.boundary && one.boundary) prev.one = { ...prev.one, boundary: one.boundary };
        if (!prev.one.claimId && one.claimId) prev.one = { ...prev.one, claimId: one.claimId };
        notes.push(
          `第 ${i + 1} 条判断「${one.text}」和前面那条同义${sameId ? `（同一个 claim ID ${one.claimId}）` : ""}，` +
            "只留一条，证据编号并过去。"
        );
        folded = true;
        break;
      }
    }

    if (!folded) kept.push({ one, norm, boundary, refs });
  });

  return {
    kept: kept.map((k) => ({
      ...k.one,
      ...(k.refs.length ? { evidenceRefs: k.refs } : {}),
    })),
    notes,
  };
}

export interface Assembled {
  report: ReportBlocks;
  /**
   * 元数据那一行读出来了没有。**`report` 里那三栏答不出这一问** —— 它们在缺元数据时
   * 落的是默认值，而校验器要判的正是「这一行到底有没有」。
   */
  meta?: ReportMeta;
  /** 还没写完的那一行。`complete` 时永远是空串 —— 那一截不进任何一份产物。 */
  pending: string;
  /**
   * 解析出来的块，**原样**给校验器和返修用。
   *
   * ## 2026-09-07：它不再和 `report.blocks` 是同一个数组
   *
   * 落库那一份走过一道去重（`foldDuplicateKpis`），这一份没有。分开是有意的，两个理由：
   *
   *   · **返修贴回去的必须是它自己写的那一行**（`sources` 和这一份同序同长）。折过之后的
   *     块在 `sources` 里没有对应的原文行 —— 拿折完的下标去 `sources` 里取，取到的是另一
   *     个块的原文。
   *   · **校验器该看模型真交的东西。** 它报的是「第 3 个块里有卡没绑证据」，而第 3 个块
   *     是模型写的那一个。对着一份代码改过的稿子报违规，返修那一轮改的就是一个它没写过的块。
   *
   * 两份的**长度和顺序永远一样**（去重只换块的内容，不删块，见 `foldDuplicateKpis`），
   * 所以任何一处按下标互相索引的地方仍然成立。
   */
  blocks: Block[];
  /** 每个块原样的那一行，和 `blocks` 同序。返修那一轮要把原文贴回去。 */
  sources: string[];
  /**
   * 决断包原样的那一行。返修那一轮要把它原封不动放回去，不然一次返修就把它丢了
   * （见 `parse.ts` 的 `commandBriefLine`）。没有决断包时是空串。
   */
  commandBriefLine: string;
  /** 去重折掉了什么。**不静默** —— 一个数从屏幕上消失，得有一处说得出是谁折的。 */
  dedup: string[];
}

/**
 * JSONL → 落库形态。
 *
 * 元数据缺失时**不抛异常**：`title` 落空串、`confidence` 落最低那一挡。缺 report_meta
 * 是一条 p0 违规（`lint.ts` 的 A4-B01），由校验器去报 —— 在这里抛的话，一份只差一行
 * 元数据的报告会整份消失，而屏幕上那一栏变成「这一条没跑成」。那句话是假的：它跑成了，
 * 只是少了一行。
 */
/**
 * 「材料截至哪一天」**由台账定，不由模型写。** 判据整个搬去了 `../disclosure` 的
 * `materialCutoff` —— 出口机检 A4-N09 和这一格必须是同一份代码（见那个文件的头注）。
 *
 * ## 2026-09-07（ISS-239）：这个函数换了两件事
 *
 * 1. **只认经营数据报告期。** 上一版只问「域名是不是一手披露」「报告期认不认得出」，于是
 *    维信诺官网发展历程上那条「2020 年 12 月产线点亮」（E1）成了整份材料的截止日 ——
 *    屏幕上写着「材料截至 2020-12-31」，而同一份台账里躺着 2025 年报。现在事件时间、
 *    检索时间、报告期分成三种（`periodKind`），只有报告期能落进这一格。
 * 2. **不再回落到模型写的那一行。** 上一版拿不到披露时 `|| parsed.meta.dataCutoff`，理由
 *    是「空格读起来像还没算」。那个理由站不住：回落之后屏幕上是一个**看着像核过、其实
 *    是模型顺手写的**日期，比空格贵得多。现在拿不到就是「未确定」三个字。
 *
 * 返回的是**要印在屏幕上那一格里的字**（`MaterialCutoff.label`），不是裸日期：镜像转载的
 * 公司披露撑起来的那一天要带着「原站未核对」一起上屏，不能和一手披露长得一样。要判据的
 * 结构（哪几条撑的、为什么未确定）用 `disclosureCutoffOf`。
 */
export function disclosureCutoff(
  entries: readonly Evidence[],
  disclosureDomains: readonly string[] = []
): string {
  return materialCutoff(entries, disclosureDomains).label;
}

/** 同上，但给出整份判据 —— trace、缺陷清单和机检文案要说得出「为什么是这一天」。 */
export function disclosureCutoffOf(
  entries: readonly Evidence[],
  disclosureDomains: readonly string[] = []
): MaterialCutoff {
  return materialCutoff(entries, disclosureDomains);
}

export function assembleReport(input: AssembleInput): Assembled {
  const parsed = parseBlocks(input.text, input.complete === true ? { complete: true } : undefined);
  /*
   * 去重只作用在**落库那一份**上。证据表照旧从模型交的那一份折（`parsed.blocks`）：
   * 折掉的卡上的编号仍然是这一轮引过的，从证据表里一起消失会让那几条变成「取回来没用上」。
   */
  const folded = foldDuplicateKpis(parsed.blocks);
  const report: ReportBlocks = {
    title: parsed.meta?.title ?? "",
    confidence: parsed.meta?.confidence ?? "初步提示",
    /*
     * **没有 `|| parsed.meta.dataCutoff` 这条尾巴。** 模型写的那个日期从来没有一步核过 ——
     * ISS-238 的「材料截至 2026-08-20」（手上最新是 2024 年报）和 ISS-239 的
     * 「材料截至 2020-12-31」是同一类事故的两头。拿不到就写「未确定」（`materialCutoff`）。
     * 模型原来写的那一行没有丢：它照旧在 `Assembled.meta.dataCutoff` 上，要审计随时取得到。
     */
    dataCutoff: disclosureCutoff(input.entries, input.disclosureDomains),
    lane: input.lane,
    evidencePackId: packIdOf(input.entries),
    blocks: folded.blocks,
    // 决断包挂在报告之上，不进块序列（`schema.ts` 的 `CommandBrief`）。行业题这一栏就是空的。
    ...(parsed.commandBrief ? { commandBrief: parsed.commandBrief } : {}),
    evidence: buildRegistry(input.entries, parsed.blocks),
    ...(parsed.bad.length ? { bad: parsed.bad } : {}),
  };
  return {
    report,
    ...(parsed.meta ? { meta: parsed.meta } : {}),
    pending: parsed.pending,
    blocks: parsed.blocks,
    sources: parsed.sources,
    commandBriefLine: parsed.commandBriefLine,
    dedup: folded.notes,
  };
}

/* -------------------------------------------------------------------------- */
/* 返修那一轮：把重发的几块贴回去                                              */
/* -------------------------------------------------------------------------- */

export interface SpliceInput {
  /** 上一稿。块、每块的原文行、元数据都从这里取。 */
  previous: Assembled;
  /** 这一轮要求重发的那几块，**顺序就是对齐方式**（和提示词里列的顺序一致）。 */
  rejected: RejectedBlock[];
  /** 这一轮是否同时要求它重交 report_meta。 */
  needsMeta: boolean;
  /** 模型这一轮交回来的原文。 */
  reply: string;
}

export interface Spliced {
  /** 拼好的整份 JSONL。交给 `assembleReport` 再走一遍，然后重新校验。 */
  text: string;
  /** 对不上的地方。**不静默** —— 少交一块和改好一块在屏幕上长得一样。 */
  notes: string[];
}

const FENCE = /^```[a-zA-Z]*$/;

/**
 * 把重发回来的几行贴回上一稿，拼出完整的 JSONL。
 *
 * 对齐靠顺序，别无他法：模型交回来的行里没有「我是第几块」这个字段，加一个的话它就成了
 * 块结构的一部分（而块要落库、要渲染，多一个只在返修那一轮有意义的字段）。所以这里的
 * 每一条不匹配都要记账：
 *
 *   · 少交了几行 → 那几块**保留上一稿**，下一轮校验会重新报出来
 *   · 多交了几行 → 多出来的丢掉（它对不上任何一个被拒的块）
 *   · 有一行读不通 → 那一块保留上一稿。把一个「内容不合规但读得出」的块换成一行
 *     读不出的东西，是把一条能指认的违规换成一块空白
 */
export function spliceRepair(input: SpliceInput): Spliced {
  const notes: string[] = [];
  const lines = input.reply
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter((x) => x && !FENCE.test(x));

  // 元数据那一行：要它的时候从回复里挑出来，不要它的时候挑出来丢掉。
  let metaLine = "";
  const parsedLines: { raw: string; value: unknown }[] = [];
  for (const raw of lines) {
    let value: unknown;
    try {
      value = JSON.parse(raw);
    } catch {
      parsedLines.push({ raw, value: undefined });
      continue;
    }
    if (isMetaLine(value)) {
      if (input.needsMeta && !metaLine && readMeta(value).ok) metaLine = raw;
      else notes.push("返修那一轮多交了一行 report_meta，已忽略。");
      continue;
    }
    /*
     * 决断包这一行**不进 `parsedLines`**：那个数组是按顺序去对被拒的块的，混一行进去
     * 会让后面每一块都错位一格。返修从来不点名要它（没有一条校验规则指得到它），所以
     * 交回来的只可能是模型顺手重写了一遍 —— 留上一稿，记一条。
     */
    if (isCommandBriefLine(value)) {
      notes.push("返修那一轮多交了一行 command_brief，已忽略，决断包留上一稿。");
      continue;
    }
    parsedLines.push({ raw, value });
  }
  if (input.needsMeta && !metaLine) notes.push("要求重交 report_meta，但这一轮没有一行合法的 report_meta。");

  /*
   * 上一稿的元数据。重新序列化的只有这三个字段，没有排版可失真的地方。
   *
   * **`dataCutoff` 取 `previous.meta`，不取 `previous.report`。** 这两个不是同一个东西：
   * `meta` 是模型交的那一行，`report.dataCutoff` 是代码从台账算出来的那一天
   * （`disclosureCutoff`）。往回写 JSONL 时必须写模型那一行 —— 写算出来的那个，下一次
   * `assembleReport` 会把它当成模型交的原文再解析一遍，于是「未确定」三个字被当成模型
   * 写的日期存进 `meta`，返修一轮就把这一份的原始元数据洗掉了。算出来的那一天在下一次
   * 组装时照旧会重新算，不需要也不应该从这里带过去。
   */
  if (!metaLine && input.previous.report.title) {
    metaLine = JSON.stringify({
      type: "report_meta",
      title: input.previous.report.title,
      confidence: input.previous.report.confidence,
      dataCutoff: input.previous.meta?.dataCutoff ?? "",
    });
  }

  const out = [...input.previous.sources];
  input.rejected.forEach((r, k) => {
    const i = r.at - 1;
    if (i < 0 || i >= out.length) {
      notes.push(`第 ${r.at} 个块不在上一稿里，跳过。`);
      return;
    }
    const got = parsedLines[k];
    if (!got) {
      notes.push(`第 ${r.at} 个块没有重发回来，保留上一稿。`);
      return;
    }
    if (got.value === undefined || !readBlock(got.value).ok) {
      notes.push(`第 ${r.at} 个块重发回来的那一行读不通，保留上一稿。`);
      return;
    }
    out[i] = got.raw;
  });
  if (parsedLines.length > input.rejected.length) {
    notes.push(`返修那一轮多交了 ${parsedLines.length - input.rejected.length} 行，对不上任何一个被拒的块，已丢掉。`);
  }

  return {
    // 决断包排在元数据之后、块之前，位置和收口交上来时一样。**必须原样带回去** ——
    // 它不在 `sources` 里，这里不拼它，一次返修就把一号位那一屏丢了。
    text: `${[metaLine, input.previous.commandBriefLine, ...out].filter(Boolean).join("\n")}\n`,
    notes,
  };
}

/* -------------------------------------------------------------------------- */
/* 纯文本面                                                                    */
/* -------------------------------------------------------------------------- */

/** 一组编号排成 `[E2][E5]`。跟在句子后面，和散文里那些行内编号是同一种写法。 */
const cites = (refs: string[]): string => refs.map((r) => `[${r}]`).join("");

/** 一句话后面接编号。编号为空时不留空格 —— 行尾一个孤零零的空格会在 diff 里被人当成改动。 */
const withCites = (text: string, refs: string[]): string =>
  refs.length ? `${text} ${cites(refs)}` : text;

/**
 * 表格的一行。用全角竖线分栏，**不用 markdown 的 `|`**：屏幕按纯文本渲染这一面，
 * 一张 markdown 表在那里是一堆竖线和横线；而 `rules.ts` 的 `MARKDOWN` 会为它报违规。
 */
const row = (cells: string[]): string => cells.join("　｜　");

/**
 * 一个块的文字面。返回若干段，段与段之间由调用方接空行。
 *
 * 有几种块在这一面上是**竖过来的**：表格一行一段、卡片一张一段。横过来排在纯文本里
 * 只有一种结果 —— 窄面板上折行折到看不出哪个数属于哪一栏。
 */
function bodyOf(b: Block): string[] {
  switch (b.type) {
    case "verdict_banner":
      return [b.text, b.boundary ? `适用边界：${b.boundary}` : ""].filter(Boolean);

    case "kpi_cards":
      return b.cards.map((c) => {
        const head = `${c.label}：${c.value}${c.unit ? ` ${c.unit}` : ""}${c.delta ? `（${c.delta}）` : ""}`;
        return withCites(c.caliberNote ? `${head}。口径：${c.caliberNote}` : head, c.evidenceRefs);
      });

    case "caliber_map":
      return b.rows.map(
        (r) => `${r.metric}：答得出「${r.answersWhat}」，答不出「${r.cannotAnswer}」。这份报告的处理是${r.handling}`
      );

    case "layered_table": {
      /*
       * **2026-09-04：不再逐行印「E 档」。** 那是台账的档次字母（A/B/C 是来源档，E 是估算），
       * 逐行印出来读者看到的是每行尾巴挂着一个不知所云的「E 档」（ISS-227 的六张表全是）。
       * 只有「估算」这一档对读者有意义 —— 它说的是这一行不是取回来的数。所以只标它：行首
       * 加「估」，表尾一句说明；A/B/C 那几档由证据编号自己说话，不另印。
       */
      const grades = b.rowGrade ?? [];
      const estimated = b.rows.map((_, i) => grades[i] === "E");
      const lines = [
        row(b.columns),
        ...b.rows.map((r, i) => (estimated[i] ? `估　${row(r)}` : row(r))),
      ];
      if (estimated.some(Boolean)) lines.push("带「估」的行是估算，不是取回来的数。");
      // 表头那一行也当一段：拼成一段的话，纯文本渲染会把整张表折成一坨。
      return b.evidenceRefs.length ? [...lines, `这张表的依据：${cites(b.evidenceRefs)}`] : lines;
    }

    case "funnel":
      return b.stages.map((s) => `${s.label} ${s.value}${s.note ? `（${s.note}）` : ""}`);

    case "bar_compare": {
      const items = b.items.map((x) => `${x.label} ${x.value}${x.note ? `（${x.note}）` : ""}`);
      // 这一条不是排版，是口径：不可相加的几项在纯文本里失去了「不画总量」那层保护，
      // 所以要用一句话说出来 —— 不然读到这一段的人会自己去加。
      return b.nonAdditive ? [...items, "这几项只可比较、不可相加，也不能据此算占比。"] : items;
    }

    case "scenario_cards":
      return b.cards.map((c) =>
        [
          `${c.name}。`,
          c.assumptions.length ? `假设：${c.assumptions.join("；")}。` : "",
          c.keyNumbers.length ? `关键数：${c.keyNumbers.join("；")}。` : "",
          c.triggerIndicators.length ? `先动的指标：${c.triggerIndicators.join("；")}。` : "",
        ]
          .filter(Boolean)
          .join("")
      );

    case "prose":
      return b.md.split(/\r?\n\s*\r?\n/).map((p) => p.trim()).filter(Boolean);

    case "judgment":
      return [
        withCites(`${b.claim}（${b.confidence}・${b.direction}）`, b.evidenceRefs),
        b.reasoningSummary ? `凭什么这么判：${b.reasoningSummary}` : "",
        b.falsifyCondition ? `什么会推翻它：${b.falsifyCondition}` : "",
        b.upgradeCondition ? `什么会让它升一档：${b.upgradeCondition}` : "",
        b.internalValidationHooks.length ? `什么内部数据能裁决它：${b.internalValidationHooks.join("；")}` : "",
      ].filter(Boolean);

    case "unverified_panel":
      return b.items.map((x) =>
        [
          `${x.statement}`,
          x.whyMatters ? `缺它的影响：${x.whyMatters}` : "",
          x.whatWouldSettle ? `什么能定它：${x.whatWouldSettle}` : "",
          x.impactIfTrue || x.impactIfFalse
            ? `是真的话：${x.impactIfTrue || "未写"}；是假的话：${x.impactIfFalse || "未写"}`
            : "",
        ]
          .filter(Boolean)
          .join("　")
      );

    case "evidence_list":
      return b.items.map((x) => {
        const who = [x.sourceName, x.sourceType].filter(Boolean).join("・");
        const dir = x.updateDirection ? `${x.updateDirection.effect}了「${x.updateDirection.target}」` : "";
        return [`${x.id}　${x.claim}`, who ? `（${who}）` : "", dir ? `　—— ${dir}` : ""].join("");
      });

    /*
     * 这一块的编号**不加方括号**。`gate.ts` 的 `CITE` 认的是 `[E3]`，加了括号这一段就成了
     * 「引用」—— 于是一份把十八条证据全列进对账、正文一条都没引的报告，在出口闸那里看起来
     * 引得最全。这一段是账，不是引用。
     */
    case "evidence_usage":
      return [
        b.used.length ? `用上了 ${b.used.length} 条：${b.used.join("、")}` : "这一份没有用上任何一条证据。",
        ...b.discarded.map((x) => `弃用 ${x.id}：${x.reason || "没有写理由"}`),
      ].filter(Boolean);

    case "divergence_view":
      return [
        `分歧：${b.topic}`,
        ...b.positions.map((p) => `${p.lane}：${p.verdict}（${p.confidence}）。依据：${p.keyBasis}`),
        `裁决：${b.adjudication.status}・${b.adjudication.method}${b.adjudication.note ? `。${b.adjudication.note}` : ""}`,
      ];

    case "falsify_card":
      return [
        ...b.conditions,
        b.monitoringIndicators.length ? `监控指标：${b.monitoringIndicators.join("、")}` : "",
      ].filter(Boolean);

    case "param_model":
      return [
        ...b.outputs.map((o) => `${o.label} ＝ ${o.expr}${o.unit ? `（${o.unit}）` : ""}`),
        `参数：${b.params.map((p) => `${p.label} ${p.default}${p.unit ?? ""}（${p.min}–${p.max}）`).join("；")}`,
        b.layer ? `这套算式属于${b.layer}。` : "",
        b.disclaimer,
      ].filter(Boolean);
  }
}

/**
 * 一个块的小标题。
 *
 * 「未能核实」那一节的标题**由代码补一个前缀**：出口闸 `gate.ts` 的 A4-G04 查的是
 * 「本轮有命题没闭合时，正文里有没有这一节」，它认的是「未能核实 / 没能核实」这几个词。
 * 而块那一侧要求 heading 本身是一句判断（「这三条卡在同一份材料上」），两条要求都对，
 * 只是一个查得出、一个读得好。补前缀两头都满足，代价是这一面上那个标题比块上长一截。
 */
function headingOf(b: Block): string {
  if (b.type === "unverified_panel") {
    return b.heading ? `未能核实的部分：${b.heading}` : "未能核实的部分";
  }
  return b.heading ?? "";
}

/**
 * 区块报告 → 那份可署名分发的纯文本。**写入时转写一次，之后不再动。**
 *
 * 形状和旧格式一样：第一行标题，之后每节 `## ` 开头，段落之间空一行 —— 压成四节那一步、
 * 出口闸、报告页签的「原文」那一面读的都是这个形状，换一种形状等于把那三处一起改掉。
 *
 * 没有 heading 的块接在上一节里，不硬造一个标题：一份 14 个块的报告会因此有 14 个
 * 「（一句判断）」，而章节导航是从 heading 数出来的，凑数的标题在那里是 14 行噪音。
 */
export function blocksToText(report: Pick<ReportBlocks, "title" | "blocks">): string {
  const out: string[] = [];
  if (report.title) out.push(report.title);
  for (const b of report.blocks) {
    const heading = headingOf(b);
    if (heading) out.push(`## ${heading}`);
    out.push(...bodyOf(b).map((x) => x.trim()).filter(Boolean));
  }
  return out.join("\n\n");
}
