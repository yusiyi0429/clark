import type { ResearchDoc, Statement } from "@/lib/data/types";
import type { JudgmentBlock, ReportBlocks } from "./schema";

// 数值的小数点、负号、百分号及单位不可删除；否则 1.5 与 15 会被合并。
const key = (text: string) => text.trim().replace(/\s+/g, " ").replace(/[。.!！?？]+$/, "");

/** 只合并同文复述，不把措辞相近但条件不同的判断当成同一条。 */
export function uniqueText<T>(items: T[], text: (item: T) => string): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const k = key(text(item));
    if (!k || seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** 保留首条判断；其后优先展示带证据的判断。同档保留作者顺序，不用置信度冒充重要性。 */
export function readingJudgments(report: ReportBlocks) {
  const items = uniqueText(
    report.blocks.flatMap((block, index) => block.type === "judgment" ? [{ block, index }] : []),
    (item) => item.block.claim,
  );
  const evidence = new Set(report.evidence.map((e) => e.id));
  const hasEvidence = (block: JudgmentBlock) => block.evidenceRefs.some((id) => evidence.has(id));
  const [first, ...rest] = items;
  return first ? [first, ...rest.sort((a, b) => Number(hasEvidence(b.block)) - Number(hasEvidence(a.block)))] : [];
}

export function appendixStart(report: ReportBlocks): number {
  const n = report.appendixFrom;
  return n !== undefined && Number.isInteger(n) && n >= 0 && n <= report.blocks.length
    ? n : report.blocks.length;
}

/** 阅读摘要是原报告的选读面；原文、完整证据及未核清单仍留在报告中。 */
export function readingDigest(report: ReportBlocks, ledger: { id: string; claim: string }[] = []): Pick<ResearchDoc, "judgment" | "keyEvidence" | "counters" | "unknowns" | "routeSuggestion"> {
  const selected = readingJudgments(report).slice(0, 3).map((x) => x.block);
  const byId = new Map(report.evidence.map((e) => [e.id, e]));
  const statement = (text: string, refs: string[] = []): Statement => ({
    text,
    traces: [...new Set(refs)].flatMap((id) => {
      const e = byId.get(id);
      return e ? [{ kind: e.verified ? "ext" as const : "agent" as const, source: `${e.id} · ${e.sourceName}${e.verified ? "" : " · 未核验"}`, ...(e.url && /^https?:\/\//i.test(e.url) ? { href: e.url } : {}) }] : [];
    }),
  });
  const evidenceIds = [...new Set([...selected.flatMap((b) => b.evidenceRefs), ...report.evidence.map((e) => e.id)])];
  const banner = report.blocks.find((b) => b.type === "verdict_banner");
  const counters = uniqueText([
    ...selected.map((b) => b.falsifyCondition),
    ...report.blocks.flatMap((b) => b.type === "falsify_card" ? b.conditions : []),
  ], (x) => x).slice(0, 3);
  // 采用作者明确写出的影响程度排序；不把行业背景的数组顺位当成经营重要性。
  const impact = (why: string) => /(?:折损|影响|风险)(?:很|较|最)?高|关键缺口|直接损害/.test(why) ? 2 : /中等|较低/.test(why) ? 0 : 1;
  const unknowns = uniqueText(report.blocks.flatMap((b) => b.type === "unverified_panel" ? b.items : []), (x) => x.statement)
    .sort((a, b) => impact(b.whyMatters) - impact(a.whyMatters)).slice(0, 3);
  return {
    judgment: selected.length ? selected.map((b) => statement(b.claim, b.evidenceRefs)) : banner ? [statement(banner.text)] : [],
    keyEvidence: evidenceIds.flatMap((id) => { const e = byId.get(id); return e ? [statement(ledger.find((entry) => entry.id === id)?.claim || e.claim, [id])] : []; }).slice(0, 4),
    counters: counters.map((x) => statement(x)),
    unknowns: unknowns.map((x) => statement(`${x.statement}${x.whatWouldSettle ? `——${x.whatWouldSettle}` : ""}`)),
    routeSuggestion: "先检验这些判断的依据与成立条件，再形成初步倾向或带入会议讨论的问题。完整论证与未核事项见报告和附录。",
  };
}
