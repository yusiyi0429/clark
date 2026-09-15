// src/lib/agent/talk/lookup.test.ts
import { describe, expect, it } from "vitest";
import type { Evidence } from "@/lib/research/ledger";
import type { BlockEvidence } from "@/lib/agent/a4/blocks/schema";
import { lookupEvidence, mergeEntries } from "./lookup";

const ev = (id: string, claim: string, extra: Record<string, unknown> = {}) =>
  ({ id, claim, exactQuote: `${claim}（原文）`, excerpt: `……${claim}……`, siteName: "国家统计局",
     sourceTier: "A", sourceDomain: "stats.gov.cn", url: "https://x", ...extra } as unknown as Evidence);

const slim = (id: string, claim: string) =>
  ({ id, claim, sourceName: "国家统计局", sourceType: "statistic", verified: true,
     retrievedAt: "2026-08-26", independenceGroup: "g1", grade: "A", origin: "retrieved" } as unknown as BlockEvidence);

describe("evidence_lookup", () => {
  it("按编号取，取到的是原文引句不是模型的转述", () => {
    const [f] = lookupEvidence([ev("E1", "出货 1200 万片")], { id: "E1" });
    expect(f.quote).toContain("（原文）");
  });

  it("只有速查那一份时不编引句 —— 缺就缺", () => {
    const [f] = lookupEvidence([slim("E1", "出货 1200 万片")], { id: "E1" });
    expect(f.quote).toBeUndefined();
    expect(f.claim).toBe("出货 1200 万片");
    expect(f.site).toBe("国家统计局");
    expect(f.tier).toBe("A");
  });

  it("口径四件套有就一起给 —— 他挑的正是口径", () => {
    const [f] = lookupEvidence(
      [ev("E1", "份额 48%", { value: 48, unit: "%", precision: "整数", period: "2025Q2", geography: "中国大陆" })],
      { id: "E1" },
    );
    expect(f.measure).toContain("2025Q2");
    expect(f.measure).toContain("中国大陆");
  });

  it("口径一样都没有就整栏不给，不要一串「未知」", () => {
    expect(lookupEvidence([ev("E1", "x")], { id: "E1" })[0].measure).toBeUndefined();
  });

  it("查不到就是空数组，不抛 —— 查不到是合法结果", () => {
    expect(lookupEvidence([ev("E1", "x")], { id: "E9" })).toEqual([]);
  });

  it("语义查按 claim 命中，多条都回，不只回一条", () => {
    const r = lookupEvidence([ev("E1", "份额 48%"), ev("E2", "份额 51%"), ev("E3", "产能 3 万片")], { text: "份额" });
    expect(r.map((x) => x.id)).toEqual(["E1", "E2"]);
  });
});

describe("台账那份和速查那份并起来", () => {
  it("同一个编号只剩台账那条 —— 回两条就说不清引的是哪一条", () => {
    const r = lookupEvidence(mergeEntries([ev("E1", "出货 1200 万片")], [slim("E1", "出货 1200 万片")]), { id: "E1" });
    expect(r).toHaveLength(1);
    expect(r[0].quote).toContain("（原文）");
  });

  it("只有速查那一份时原样回 —— 老报告没有台账那栏", () => {
    expect(mergeEntries(undefined, [slim("E1", "第一条"), slim("E2", "第二条")]).map((e) => e.id)).toEqual(["E1", "E2"]);
  });

  it("对谈里现查到追加的那一条查得到 —— 这是接上这个读口的全部理由", () => {
    const entries = mergeEntries(
      [ev("E1", "出货 1200 万片"), ev("E8", "2025Q2 同口径份额 48%")],
      [slim("E1", "出货 1200 万片")],
    );
    const [f] = lookupEvidence(entries, { id: "E8" });
    expect(f.claim).toBe("2025Q2 同口径份额 48%");
  });

  it("两份都没有就是空数组，不抛", () => {
    expect(mergeEntries(undefined, undefined)).toEqual([]);
  });
});
