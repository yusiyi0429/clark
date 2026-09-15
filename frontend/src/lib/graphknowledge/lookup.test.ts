import { describe, expect, it } from "vitest";

import {
  FLAT_MIN_SEEDS,
  FLAT_RATIO,
  MAX_CANDIDATES,
  PREFIX,
  TIE_RATIO,
  noMatchReason,
  poolOf,
} from "./lookup";

describe("阈值常量", () => {
  it("逐字对齐实验台 —— 这些是相对比例，换 embedding 模型仍然成立", () => {
    expect(MAX_CANDIDATES).toBe(8);
    expect(TIE_RATIO).toBe(0.95);
    expect(FLAT_RATIO).toBe(0.9);
    expect(FLAT_MIN_SEEDS).toBe(4);
  });

  // 整张表比一遍，不是逐条 expect：漏了新加的频道要在这里响，而不是等到真跑那条
  // 链路时才发现前缀取到了 undefined。
  it("每个频道只接受一种锚点：A1a 从信号出发，A3/A4/A10/A6/A5/A7 从议题出发", () => {
    expect(PREFIX).toEqual({
      "A1a": "CARD-",
      A3: "ISS-",
      A4: "ISS-",
      A10: "ISS-",
      A6: "ISS-",
      A5: "ISS-",
      // A7 是会后提炼。和 A6/A5 一样在表上但不开上下文（理由写在 PREFIX 那段上）。
      A7: "ISS-",
    });
  });
});

describe("poolOf", () => {
  it("空池不算平坦度 —— 除零得不出结论", () => {
    expect(poolOf([])).toEqual({ n: 0, topScore: 0, bottomScore: 0, topCode: "", flatness: null });
  });

  it("平坦度是最低分/最高分，留四位", () => {
    const p = poolOf([{ code: "A", score: 0.3 }, { code: "B", score: 0.2 }]);
    expect(p.topCode).toBe("A");
    expect(p.flatness).toBe(0.6667);
  });
});

describe("noMatchReason", () => {
  it("整池拉不开 → 没有对应议题（问「VPN 部署在哪」时是这种）", () => {
    const seeds = [
      { code: "ISS-1", score: 0.299 },
      { code: "DOC-1", score: 0.29 },
      { code: "CARD-1", score: 0.285 },
      { code: "PSN-1", score: 0.278 },
    ];
    const why = noMatchReason({ code: "ISS-1", score: 0.299 }, poolOf(seeds));
    expect(why).toContain("拉不开");
    expect(why).toContain("4 条种子");
  });

  it("池子太小不做平坦判定 —— 两三条种子的首末比天然就高", () => {
    const seeds = [{ code: "ISS-1", score: 0.3 }, { code: "DOC-1", score: 0.29 }];
    expect(noMatchReason({ code: "ISS-1", score: 0.3 }, poolOf(seeds))).toBe("");
  });

  it("池子拉得开但议题只是陪跑 → 也算没有对应议题", () => {
    const seeds = [
      { code: "DOC-1", score: 0.7 },
      { code: "ISS-1", score: 0.31 },
      { code: "PSN-1", score: 0.3 },
      { code: "CARD-1", score: 0.29 },
    ];
    const why = noMatchReason({ code: "ISS-1", score: 0.31 }, poolOf(seeds));
    expect(why).toContain("不在全体首名");
    expect(why).toContain("DOC-1");
  });

  it("议题本身就是全体首名 → 有对应议题", () => {
    const seeds = [
      { code: "ISS-1", score: 0.82 },
      { code: "DOC-1", score: 0.4 },
      { code: "PSN-1", score: 0.31 },
      { code: "CARD-1", score: 0.3 },
    ];
    expect(noMatchReason({ code: "ISS-1", score: 0.82 }, poolOf(seeds))).toBe("");
  });
});
