import { describe, expect, it } from "vitest";
import { nativeSignalScore, projectSignalCard, signalScoreStatus } from "../src/signals.js";

const row = (score: unknown, sourceRef: unknown) => ({
  id: "33333333-3333-4333-8333-333333333333",
  version: 1,
  source_type: "web" as const,
  source_fingerprint: "d".repeat(64),
  source_title: "标题",
  source_url: "https://example.com/a",
  published_at: new Date("2026-10-08T02:00:00.000Z"),
  excerpt: "原文",
  source_ref: sourceRef,
  anchor_id: "anchor-1",
  location: { type: "company" },
  summary: "摘要",
  strategic_impact: "影响",
  evidence_quote: "原文",
  unknowns: [],
  score,
  read_at: null,
  saved_at: null,
  dismissed_at: null,
  collected_at: new Date("2026-10-09T06:00:00.000Z"),
  source_images: [],
});
const assessmentOf = (score: unknown, sourceRef: unknown) =>
  (projectSignalCard(row(score, sourceRef)).payload as { assessment: { score: unknown; scoreStatus: string; scoreBasis: unknown } }).assessment;

describe("Signal 评分状态投影", () => {
  it("实时扫描信号保留 Radar Assess Agent 的原生分值（含真实 0 分）", () => {
    expect(assessmentOf({ relevance: 4, impact: 3, urgency: 5 }, { type: "web", provider: "bocha" })).toEqual({
      anchorId: "anchor-1", location: { type: "company" }, summary: "摘要", strategicImpact: "影响", evidenceQuote: "原文", unknowns: [],
      score: { relevance: 4, impact: 3, urgency: 5 }, scoreStatus: "assessed", scoreBasis: null,
    });
    expect(assessmentOf({ relevance: 0, impact: 0, urgency: 0 }, { type: "outlet", outletId: "cnbc", outletName: "CNBC" })).toMatchObject({
      score: { relevance: 0, impact: 0, urgency: 0 }, scoreStatus: "assessed",
    });
  });

  it("旧版导入写的 0/0/0 占位与新版导入的 null 都投影为未评估，不把 0 分交给列表或对话", () => {
    expect(assessmentOf({ relevance: 0, impact: 0, urgency: 0 }, { type: "web", sourceRef: "客户资料", imported: true })).toMatchObject({ score: null, scoreStatus: "unassessed", scoreBasis: null });
    expect(assessmentOf(null, { type: "web", sourceRef: "客户资料", imported: true, scoreStatus: "unassessed" })).toMatchObject({ score: null, scoreStatus: "unassessed" });
  });

  it("导入包附带研判时投影原生分值和研判出处", () => {
    const basis = { rationale: "原文写明交期延后两周，影响本月交付承诺", assessedBy: "预载整理 Agent · 方法团队核对", assessedAt: "2026-10-09T03:00:00.000Z", sourceRef: "客户资料/信号表#3" };
    expect(assessmentOf({ relevance: 4, impact: 4, urgency: 3 }, { type: "web", sourceRef: "客户资料", imported: true, scoreStatus: "assessed", assessment: basis })).toMatchObject({
      score: { relevance: 4, impact: 4, urgency: 3 }, scoreStatus: "assessed", scoreBasis: basis,
    });
  });

  it("越界、缺维度或非整数的分值一律视为没有评分", () => {
    for (const score of [null, {}, { relevance: 1, impact: 6, urgency: 1 }, { relevance: 1, impact: 2 }, { relevance: 1, impact: 2.5, urgency: 1 }, "5"]) {
      expect(nativeSignalScore(score)).toBeNull();
      expect(signalScoreStatus(score, { type: "web" })).toBe("unassessed");
    }
    // 投影只带三个原生维度，不透传额外字段。
    expect(nativeSignalScore({ relevance: 1, impact: 2, urgency: 3, extra: "x" })).toEqual({ relevance: 1, impact: 2, urgency: 3 });
  });
});
