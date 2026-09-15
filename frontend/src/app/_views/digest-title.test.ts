import { describe, expect, it } from "vitest";
import { digestTitle } from "./digest-title";

/**
 * 潜在议题那一屏的标题现在要同时对两份数据负责：卡片和待挑的信号在同一屏上，
 * 一句「今天的信号您都处置过了」在底下还躺着五条待挑信号时就是假话。
 */
describe("digestTitle", () => {
  it("有未处置的卡：照旧", () => {
    expect(digestTitle({ openCards: 2, totalCards: 3, openSignals: 4 })).toBe(
      "值得注意的新议题",
    );
  });

  it("卡都处置完了、信号还有：说出信号", () => {
    expect(digestTitle({ openCards: 0, totalCards: 3, openSignals: 4 })).toBe(
      "潜在议题都处置过了，还有 4 条信号等您挑。",
    );
  });

  it("卡都处置完了、信号也没有：照旧", () => {
    expect(digestTitle({ openCards: 0, totalCards: 3, openSignals: 0 })).toBe(
      "今天的信号您都处置过了。",
    );
  });

  it("今天一张卡都没有、雷达过线了几条：不能说「还没有发现新情报」", () => {
    expect(digestTitle({ openCards: 0, totalCards: 0, openSignals: 5 })).toBe(
      "雷达过线了 5 条，还没有一件立案。",
    );
  });

  it("什么都没有：上线第一天那一句", () => {
    expect(digestTitle({ openCards: 0, totalCards: 0, openSignals: 0 })).toBe(
      "还没有发现新情报",
    );
  });
});
