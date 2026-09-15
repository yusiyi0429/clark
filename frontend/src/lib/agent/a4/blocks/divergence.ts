/**
 * 对账那一步：各条链路都出稿之后，对齐它们对同一命题的裁决，折出 `divergence_view`。
 *
 * 任务书 §4.3。这一步的产物是判断板的入口 —— 板上那几条从 `judgment` 和
 * `divergence_view` 两种块直接取，所以这里折出来的每一处分歧都会走到一号位眼前。
 *
 * ## 为什么不让单条链路自己写
 *
 * 它看不到别的几条。让它写「分歧」，它只能凭空说出别人的立场 —— 编出来的分歧和真的那种
 * 在屏幕上长得一样，而这一种恰好是最值钱的那类信息（每条各自取证，所以不一致有可能是
 * **有一条压根没看到另一条抓回来的那一页**）。所以 `a4ReportBlocksSystem` 那份块目录里
 * 只有十四种，这一种在这里折。
 *
 * ## 链路名在提示词里是代号
 *
 * 裁决这一次跑在 `pro` 槽位上，而那正是写了「DeepSeek」那一份的同一个模型。让它在一张
 * 写着自己名字的表上裁决，它偏向哪一栏这件事从此说不清。所以递进去的是甲乙丙，读回来时
 * 按代号和真名都认（模型时常忍不住写真名），映射由代码做 —— 认不出的那一方直接丢掉，
 * 而不是把一个没人知道是谁的名字摆到板上。
 *
 * ## 跨链路不带证据编号
 *
 * 编号是每条链路自己台账里的（各自取证，所以主源的 `E3` 和 Claude 那一条的 `E3` 是两页
 * 不同的东西）。把 Claude 写的 `[E3]` 原样带进主源那一份，屏幕上那枚芯片会指到主源的第三条
 * 证据上 —— 一句话配了一张别人的凭证。所以这里一律 `stripRefs`：跨链路的依据只能用话说清。
 * 顺带一个好处是主源那份报告的证据表不受影响（`citedRefs` 数不出新编号），插进去之后
 * A4-B06 那条「引了证据表里没有的编号」不会被这一步惹出来。
 */

import { parseBlocks } from "./parse";
import type { Block, DivergenceViewBlock, ReportBlocks } from "./schema";

/**
 * 提示词里的链路代号，按 `stancesOf` 收到的顺序发。
 *
 * 深研当前是四条链路（`run.ts` 的 `LANES`），这里五个代号 —— **多出来的「戊」是空着的
 * 余量**，本轮不会发出去，所以模型交回一条「戊」时 `laneOf` 认不出来、那一方被丢掉。
 * 再接第六条链路的话这一排必须跟着长：不长的表现是那一条的立场被 `stancesOf` 静默切掉，
 * 而屏幕上那一栏照旧摆着一份报告，只是它从来没参与过对账。超出的那几条 `stancesOf`
 * 直接切掉 —— 少带一条链路的立场比拿一个没有代号的名字去对账好，但这件事没有任何一处
 * 会报出来，所以加链路的人得自己读到这一句。
 */
const ALIASES = ["甲", "乙", "丙", "丁", "戊"] as const;

/**
 * 一次最多折出几处分歧。
 *
 * 判断板上一次读不完七处分歧 —— 读不完的那几处等于没折。超出的丢掉并记账（丢了哪几条
 * 写进 notes），不静默截断：静默截断的表现是「这一轮只有六处分歧」，而那是一句假话。
 */
const MAX_VIEWS = 6;

/** 行内证据编号，连着它前面那个空格一起去掉 —— 不然「结论 [E1]。」会剩下「结论 。」。 */
const REF = /[\s　]*\[E\d+(?:\s*[,，]\s*E?\d+)*\]/g;

/** 去掉行内证据编号。跨链路引不通，理由见文件头。 */
export const stripRefs = (text: string): string => (text ?? "").replace(REF, "").trim();

/** 一条链路摆出来的立场。`alias` 是提示词里的代号，`label` 是屏幕上那两三个字。 */
export interface LaneStance {
  label: string;
  alias: string;
  report: ReportBlocks;
}

/** 这一步收下的东西：折出来的几处分歧，加上一路上丢了什么、改了什么。 */
export interface DivergenceRead {
  views: DivergenceViewBlock[];
  /** 进 trace 的记账。**不写进块自己的 `note`** —— 那一栏是给一号位读的。 */
  notes: string[];
}

/** 按收到的顺序发代号。返回的顺序就是提示词里那几节的顺序。 */
export function stancesOf(lanes: { label: string; report: ReportBlocks }[]): LaneStance[] {
  return lanes
    .slice(0, ALIASES.length)
    .map((l, i) => ({ label: l.label, alias: ALIASES[i], report: l.report }));
}

const judgmentsOf = (r: ReportBlocks): Extract<Block, { type: "judgment" }>[] =>
  r.blocks.filter((b): b is Extract<Block, { type: "judgment" }> => b.type === "judgment");

/** `A×2　B×3` 这种。一条都没有时是空串 —— 那一份的「取回证据 0 条」已经把话说完了。 */
const gradeTally = (r: ReportBlocks): string => {
  const n: Record<string, number> = {};
  for (const e of r.evidence) n[e.grade] = (n[e.grade] ?? 0) + 1;
  const parts = Object.keys(n)
    .sort()
    .map((g) => `${g}×${n[g]}`);
  return parts.length ? `（${parts.join(" ")}）` : "";
};

/**
 * 各条链路的立场材料。**递进去的只有立场和依据，不递报告正文。**
 *
 * 递整份报告的后果是这一步变成又一次写作：它会顺着某一份的论证往下滑，然后交出一份
 * 「综合结论」，而这一步要的恰恰相反 —— 把几份摆开，指出它们在哪一句话上不一致。
 *
 * 「取回证据几条」这一栏不是凑数：一条链路一条证据都没有时，它和别人的分歧多半是
 * 「证据欠定」那一类，而不是「同一批材料的两种读法」—— 那正是三分法要分的东西。
 */
export function stanceMaterial(stances: LaneStance[]): string {
  return stances
    .map((s) => {
      const r = s.report;
      const banner = r.blocks.find((b) => b.type === "verdict_banner");
      const unverified = r.blocks
        .filter((b): b is Extract<Block, { type: "unverified_panel" }> => b.type === "unverified_panel")
        .flatMap((b) => b.items.map((i) => stripRefs(i.statement)))
        .filter(Boolean);

      const lines = [
        `### 链路${s.alias}`,
        `标题：${stripRefs(r.title) || "（这一份没交标题）"}`,
        `整份把握：${r.confidence}　材料截止：${r.dataCutoff || "没写"}　取回证据：${r.evidence.length} 条${gradeTally(r)}`,
        banner?.type === "verdict_banner"
          ? `核心判断：${stripRefs(banner.text)}（成立范围：${stripRefs(banner.boundary) || "没写"}）`
          : `核心判断：这一份没有横幅块`,
      ];
      judgmentsOf(r).forEach((j, i) => {
        lines.push(
          `判断 ${i + 1}：${stripRefs(j.claim)}`,
          `　把握 ${j.confidence}・方向 ${j.direction}・引了 ${j.evidenceRefs.length} 条证据`,
          `　凭什么：${stripRefs(j.reasoningSummary) || "没写"}`,
          `　什么会推翻它：${stripRefs(j.falsifyCondition) || "没写"}`
        );
        if (j.internalValidationHooks.length) {
          lines.push(`　什么内部数据能裁决它：${j.internalValidationHooks.map(stripRefs).join("；")}`);
        }
      });
      if (unverified.length) lines.push(`这一份自己没能核实：${unverified.join("；")}`);
      return lines.join("\n");
    })
    .join("\n\n");
}

/**
 * 三分法那一条硬规矩（任务书 §4.3）：证据欠定的出路只有两条 —— 要内部数据，或者承认
 * 这是一条先验判断。「欠定 + 事实核查」读起来像「再查一轮就有答案」，而它已经查过了。
 *
 * 这里就地改成「需内部数据」，**不为它发返修那一轮**：返修的对象是一个由三条链路的立场
 * 折出来的块，让模型重发它，回来的多半是连立场一起重写过的一份。改了哪一条记进 notes ——
 * 不改的话 `lint.ts` 的 A4-B09 会把它判成 p0，而这一支没有重写轮，那条 p0 会一直挂着。
 */
function adjudicate(
  adj: DivergenceViewBlock["adjudication"],
  topic: string,
  notes: string[]
): DivergenceViewBlock["adjudication"] {
  if (adj.status === "欠定" && (adj.method === "事实核查" || adj.method === "程序执行")) {
    notes.push(`「${topic}」记成「欠定」却配了「${adj.method}」—— 按三分法改成「需内部数据」`);
    return { ...adj, method: "需内部数据" };
  }
  return adj;
}

/**
 * 读模型交回来的那几行。
 *
 * 解析走的是同一个 `parseBlocks` —— 这一步不该有第二个 JSONL 解析器：两个解析器的容错
 * 迟早会分叉，而分叉的表现是「同一行 JSON 在报告里读得出来、在这一步读不出来」。
 */
export function readDivergences(text: string, stances: LaneStance[]): DivergenceRead {
  const notes: string[] = [];
  /*
   * 「各条对得上」是这一步的合法答案，而提示词让它这时候只写四个字。不先认一下的话，
   * 那四个字会被记成一行坏掉的 JSON —— 台账上「没有分歧」和「解析失败」读起来会一样。
   */
  if (!(text ?? "").includes("{")) {
    return { views: [], notes: ["报的是各条对得上，一处分歧都没有"] };
  }
  const parsed = parseBlocks(text, { complete: true });
  for (const b of parsed.bad) notes.push(`第 ${b.line} 行读不通：${b.why}`);

  /** 代号和真名都认 —— 提示词里要的是代号，但模型时常写真名。 */
  const byName = new Map<string, string>();
  for (const s of stances) {
    byName.set(s.alias, s.label);
    byName.set(`链路${s.alias}`, s.label);
    byName.set(s.label.toLowerCase(), s.label);
  }
  const laneOf = (raw: string): string | undefined =>
    byName.get(raw.trim()) ?? byName.get(raw.trim().toLowerCase());

  const views: DivergenceViewBlock[] = [];
  const seen = new Set<string>();
  for (const b of parsed.blocks) {
    if (b.type !== "divergence_view") {
      notes.push(`交了一个 ${b.type} 块 —— 这一步只收 divergence_view，丢掉`);
      continue;
    }
    const topic = stripRefs(b.topic);
    const positions: DivergenceViewBlock["positions"] = [];
    for (const p of b.positions) {
      const lane = laneOf(p.lane);
      if (!lane) {
        notes.push(`「${topic}」里有个认不出的链路名「${p.lane}」—— 丢掉这一方`);
        continue;
      }
      if (positions.some((x) => x.lane === lane)) {
        notes.push(`「${topic}」里 ${lane} 摆了两次 —— 留第一次`);
        continue;
      }
      positions.push({
        lane,
        verdict: stripRefs(p.verdict),
        keyBasis: stripRefs(p.keyBasis),
        confidence: p.confidence,
      });
    }
    // 一方没有分歧。到这一步才少于两方的，多半是那几方的名字没对上。
    if (!topic || positions.length < 2) {
      notes.push(`「${topic || "没写命题"}」只剩 ${positions.length} 方立场 —— 丢掉这一处`);
      continue;
    }
    const key = topic.replace(/\s/g, "");
    if (seen.has(key)) {
      notes.push(`「${topic}」这一处折了两遍 —— 留第一遍`);
      continue;
    }
    seen.add(key);
    views.push({
      ...(b.heading ? { heading: stripRefs(b.heading) } : {}),
      type: "divergence_view",
      topic,
      positions,
      adjudication: adjudicate(b.adjudication, topic, notes),
    });
  }

  if (views.length > MAX_VIEWS) {
    const dropped = views.splice(MAX_VIEWS).map((v) => v.topic);
    notes.push(`折出的分歧超过 ${MAX_VIEWS} 处，丢掉后面这几处：${dropped.join("、")}`);
  }
  return { views, notes };
}

/**
 * 把折出来的几处分歧插进主源那一份。
 *
 * 插在 `falsify_card` 之前 —— 那张卡收在最后（骨架第 7 条），分歧摆在它后面就成了
 * 推翻条件的附注。没有那张卡时插在证据清单之前；两种都没有就接在最后。
 *
 * 返回一份新的：`ReportBlocks` 这时候已经上过屏了（`DraftReport.blocks`），原地改的话
 * 屏幕上那一栏会在同一个 render 里换掉内容而没有任何一处说过它会换。
 */
export function insertDivergences(report: ReportBlocks, views: DivergenceViewBlock[]): ReportBlocks {
  if (!views.length) return report;
  const at = report.blocks.findIndex((b) => b.type === "falsify_card");
  const fallback = report.blocks.findIndex((b) => b.type === "evidence_list");
  const cut = at >= 0 ? at : fallback >= 0 ? fallback : report.blocks.length;
  return {
    ...report,
    blocks: [...report.blocks.slice(0, cut), ...views, ...report.blocks.slice(cut)],
  };
}
