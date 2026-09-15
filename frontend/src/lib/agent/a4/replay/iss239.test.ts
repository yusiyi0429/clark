/**
 * 冻结证据本身的体检。**这几条不是在测代码，是在钉住"基线是什么"** ——
 * 后面每一条改动都要拿这份证据回放，而回放的前提是这份证据没被谁顺手改过。
 */
import { describe, expect, it } from "vitest";

import { BASELINE, COMPANY_CONTEXT, LEDGER, QUERY } from "./iss239";

describe("ISS-239 冻结证据", () => {
  it("31 条台账来自 13 个 URL —— 条数不是来源数", () => {
    expect(LEDGER).toHaveLength(31);
    expect(new Set(LEDGER.map((e) => e.url)).size).toBe(13);
    expect(BASELINE.urls).toHaveLength(13);
  });

  it("E1 是一条历史事件：官网上「2020 年 12 月建成」那句话", () => {
    const e1 = LEDGER.find((e) => e.id === "E1");
    expect(e1?.sourceDomain).toBe("www.visionox.com");
    expect(e1?.period).toBe("2020-12");
    expect(e1?.usedAs).toBe("historical_point");
    expect(e1?.evidenceType).toBe("event");
  });

  it("那一轮的材料截止日被它钉在了 2020 年 —— 这就是要修的那个病灶", () => {
    expect(BASELINE.dataCutoff).toBe("2020-12-31");
  });

  it("同一份台账里其实有近期材料：新浪镜像的公司披露", () => {
    const recent = LEDGER.filter((e) => (e.period ?? "") >= "2025");
    expect(recent.length).toBeGreaterThan(0);
    expect(LEDGER.some((e) => e.sourceDomain.includes("sina"))).toBe(true);
  });

  it("这道题的原话原样留着 —— 盲测要换的是整道题，不是把公司名替换掉", () => {
    expect(QUERY).toContain("维信诺");
    expect(QUERY).toContain("首次拜访");
  });

  it("公司上下文只讲经营系统，没有一个字证明它能做工艺或良率", () => {
    expect(COMPANY_CONTEXT).toContain("TKOS");
    for (const word of ["良率", "工艺缺陷", "缺陷分析"]) {
      expect(COMPANY_CONTEXT).not.toContain(word);
    }
  });

  it("基线读数：24 分 14 秒，出口有六条违规", () => {
    expect(BASELINE.durationMs).toBe(1453870);
    expect(BASELINE.violations).toHaveLength(6);
    expect(BASELINE.violations.join("")).toContain("A4-N09");
  });
});
