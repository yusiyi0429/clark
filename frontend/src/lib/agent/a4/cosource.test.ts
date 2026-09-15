// src/lib/agent/a4/cosource.test.ts
import { describe, expect, it } from "vitest";
import {
  REWRITE_SYSTEM,
  REWRITE_ZERO_SYSTEM,
  buildRewriteUser,
  needsRewrite,
  readRewrite,
  rewriteSystemFor,
  waveDecision,
  waveShare,
} from "./cosource";

const e = (group: string, id: string) => ({ id, independenceGroup: group }) as never;

describe("波内共源率", () => {
  it("五条里三条同组 —— 共源率六成", () => {
    const r = waveShare([e("g1", "E1"), e("g1", "E2"), e("g1", "E3"), e("g2", "E4"), e("g3", "E5")]);
    expect(r.total).toBe(5);
    expect(r.distinct).toBe(3);
    expect(r.share).toBeCloseTo(0.4);
  });

  it("一条都没有时共源率是 0，不是 NaN", () => {
    expect(waveShare([]).share).toBe(0);
  });

  it("超过一半是同一批来源就要改写问法", () => {
    expect(needsRewrite(0.6)).toBe(true);
    expect(needsRewrite(0.5)).toBe(false);
  });
});

describe("一波之后做什么（2026-09-05：零入账也给一次）", () => {
  it("入账了、来源分散 —— 收口", () => {
    expect(waveDecision({ total: 5, share: 0.2, zeroYieldRetried: false }).kind).toBe("stop");
  });
  it("入账了、共源过半 —— 换方向，但一条链只换一次（ISS-232：三波 75% → 67% → 74%）", () => {
    expect(waveDecision({ total: 5, share: 0.6, zeroYieldRetried: false }).kind).toBe("coSourced");
    expect(waveDecision({ total: 5, share: 0.6, zeroYieldRetried: false, coSourceRetried: true }).kind).toBe("stop");
  });
  it("一条都没入账 —— 换问法再发一次；补过一次还是零就收口，不追第三次", () => {
    expect(waveDecision({ total: 0, share: 0, zeroYieldRetried: false }).kind).toBe("zeroYield");
    expect(waveDecision({ total: 0, share: 0, zeroYieldRetried: true }).kind).toBe("stop");
  });
  it("链里有入账、但某一维零入账 —— 只为那一维改写再发（ISS-232：D3 六条、D5 零）", () => {
    const r = waveDecision({ total: 6, share: 0.5, zeroYieldRetried: false, zeroDims: ["D5"] });
    expect(r.kind).toBe("zeroYield");
    expect(r.dims).toEqual(["D5"]);
    // 补过一次之后不再为它追；共源过半的判断照旧只看一次。
    expect(waveDecision({ total: 6, share: 0.5, zeroYieldRetried: true, zeroDims: ["D5"] }).kind).toBe("stop");
  });
  it("零入账用自己那份提示词：递命题原文、不递「撞上的来源」、不许放宽成行业概况", () => {
    expect(rewriteSystemFor("zeroYield")).toBe(REWRITE_ZERO_SYSTEM);
    expect(rewriteSystemFor("coSourced")).toBe(REWRITE_SYSTEM);
    expect(REWRITE_ZERO_SYSTEM).toContain("行业概况");
    const user = buildRewriteUser({
      dimension: "D2 供给端",
      tried: ["8.6 代线 扩产"],
      coSourced: [],
      reason: "zeroYield",
      statements: ["合肥 8.6 代 AMOLED 产线 2026 年投产"],
    });
    expect(user).toContain("要核的命题（原文）");
    expect(user).toContain("合肥 8.6 代");
    expect(user).toContain("一条证据都没换回来");
    expect(user).not.toContain("撞上的那批来源");
  });
});

describe("改写问法", () => {
  it("把试过的问法和撞上的那批来源都递进去", () => {
    const user = buildRewriteUser({
      dimension: "D2 供给端",
      tried: ["8.6 代线 扩产"],
      coSourced: ["CINNO 2026Q1 出货量统计"],
    });
    expect(user).toContain("8.6 代线 扩产");
    expect(user).toContain("CINNO");
  });

  it("禁止原问法微调，明写换机构、换来源类型、换语言、换限定词", () => {
    expect(REWRITE_SYSTEM).toContain("微调");
    expect(REWRITE_SYSTEM).toContain("英文");
  });

  it("读得出改写后的问法，空的和重复的去掉", () => {
    expect(readRewrite('{"queries":["a"," ","a","b"]}')).toEqual(["a", "b"]);
  });

  it("读不出来时返回空数组，不抛异常", () => {
    expect(readRewrite("不是 JSON")).toEqual([]);
  });
});
