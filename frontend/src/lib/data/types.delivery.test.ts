/**
 * 交付完整性、能不能下达、期限分栏 —— `types.ts` 里那几个两侧共用的纯函数。
 *
 * 这一组值钱的地方在于它测的是**判据本身**，而不是某一条路走通了没有：服务端拿
 * `dispatchBlockReason` 抛，屏幕拿同一句话把按钮置灰。它偏一格，两处一起偏，而且两处
 * 都不会报错 —— 屏幕上按得下去，服务端拒；或者反过来，屏幕拦着，而一条 curl 打得进去。
 */
import { describe, expect, it } from "vitest";

import { dispatchBlockReason, dueLabel, isDay, readReportDelivery, splitDue } from "./types";
import type { ReportDelivery, ResearchDoc } from "./types";

const doc = (extra: Partial<ResearchDoc> = {}): ResearchDoc => ({
  issueId: "ISS-1",
  judgment: [],
  keyEvidence: [],
  counters: [],
  unknowns: [],
  routeSuggestion: "",
  byAgentLabel: "CEO Agent",
  assembledFrom: [],
  ...extra,
});

/** 一份**只有交付元数据**的区块报告。别的栏这一组用不上，用交叉类型绕过去。 */
const blocksWith = (extra: Record<string, unknown>): ResearchDoc["blocks"] =>
  ({
    title: "t",
    confidence: "初步提示",
    dataCutoff: "",
    lane: { model: "m", short: "m" },
    evidencePackId: "p",
    blocks: [],
    evidence: [],
    ...extra,
  }) as unknown as ResearchDoc["blocks"];

describe("读交付元数据", () => {
  it("旧报告一栏都没有 → 未知，**不是完整**", () => {
    const d = readReportDelivery(doc());
    expect(d.completeness).toBe("unknown");
    expect(d.decisionReady).toBe("unknown");
    expect(d.staged).toBe(false);
  });

  it("不从 confidence 猜 —— 置信度再高，完整性照旧未知", () => {
    /*
     * 置信度说的是「这个判断有多站得住」，完整性说的是「该写的几节写完了没有」。
     * 一份三节只成了一节的报告照样可以对那一节很有把握。
     */
    const d = readReportDelivery(doc({ blocks: blocksWith({ confidence: "较强支持" }) }));
    expect(d.completeness).toBe("unknown");
  });

  it("落在文档层上读得到", () => {
    const d = readReportDelivery(doc({ completeness: "partial", decisionReady: false }));
    expect(d.completeness).toBe("partial");
    expect(d.decisionReady).toBe(false);
  });

  it("落在区块报告上也读得到 —— 产出侧那条线还没定它落哪一层", () => {
    const d = readReportDelivery(
      doc({ blocks: blocksWith({ completeness: "complete", decisionReady: true }) }),
    );
    expect(d.completeness).toBe("complete");
    expect(d.decisionReady).toBe(true);
  });

  it("两层都写了以文档层为准", () => {
    const d = readReportDelivery(
      doc({ completeness: "failed", blocks: blocksWith({ completeness: "complete" }) }),
    );
    expect(d.completeness).toBe("failed");
  });

  it("认不出来的值当未知，不当真", () => {
    const d = readReportDelivery(doc({ blocks: blocksWith({ completeness: "差不多吧", decisionReady: "是" }) }));
    expect(d.completeness).toBe("unknown");
    expect(d.decisionReady).toBe("unknown");
  });
});

describe("能不能下达", () => {
  const of = (x: Partial<ReportDelivery>): ReportDelivery => ({
    completeness: "unknown",
    decisionReady: "unknown",
    staged: true,
    ...x,
  });

  it("没进过行动整理 —— 拦", () => {
    expect(dispatchBlockReason(of({ staged: false }))).toMatch(/行动整理/);
  });

  it("部分交付 / 交付失败 —— 拦", () => {
    expect(dispatchBlockReason(of({ completeness: "partial" }))).toMatch(/部分章节/);
    expect(dispatchBlockReason(of({ completeness: "failed" }))).toMatch(/可读的正文/);
  });

  it("标了只够讨论 —— 拦，哪怕交付完整", () => {
    expect(dispatchBlockReason(of({ completeness: "complete", decisionReady: false }))).toMatch(
      /可供讨论/,
    );
  });

  it("未知**放行** —— 旧报告的批准能力保留兼容", () => {
    expect(dispatchBlockReason(of({}))).toBeNull();
  });

  it("完整且够决策 —— 放行", () => {
    expect(dispatchBlockReason(of({ completeness: "complete", decisionReady: true }))).toBeNull();
  });

  it("先说没进行动整理，再说完整性 —— 顺序是他接下来要做的事的顺序", () => {
    expect(dispatchBlockReason(of({ staged: false, completeness: "partial" }))).toMatch(/行动整理/);
  });
});

describe("期限分栏", () => {
  it("真日期进 dueOn", () => {
    expect(splitDue("2026-09-15")).toEqual({ dueOn: "2026-09-15" });
  });

  it("相对时间进 dueNote，dueOn 留空 —— 不换算成任何一个具体日子", () => {
    expect(splitDue("首访前")).toEqual({ dueOn: "", dueNote: "首访前" });
    expect(splitDue("客户排期定下来之后两周内")).toEqual({
      dueOn: "",
      dueNote: "客户排期定下来之后两周内",
    });
  });

  it("空的两栏都空", () => {
    expect(splitDue("")).toEqual({ dueOn: "" });
    expect(splitDue(undefined)).toEqual({ dueOn: "" });
    expect(splitDue("   ")).toEqual({ dueOn: "" });
  });

  it("显示：没日期没说明就是时间待定", () => {
    expect(dueLabel({ dueOn: "2026-09-15" })).toBe("2026-09-15");
    expect(dueLabel({ dueOn: "", dueNote: "首访前" })).toBe("首访前");
    expect(dueLabel({ dueOn: "" })).toBe("时间待定");
    expect(dueLabel({})).toBe("时间待定");
  });

  it("旧数据里 dueOn 存着一句相对时间时，显示那一侧照样认得出它不是日期", () => {
    // 分栏是这一版才有的，老命令里 `dueOn` 可能是「首访前」——那一栏不许进等宽数字那一档。
    expect(isDay("首访前")).toBe(false);
    expect(isDay("2026-09-15")).toBe(true);
    expect(isDay("")).toBe(false);
    expect(isDay(undefined)).toBe(false);
  });
});
