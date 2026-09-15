/**
 * 研判这一步钉的是三件事，每一件都是「屏幕上看起来正常、其实错了」的来源：
 *
 *   · **综合分是算出来的，不是模型报的。** 五维加权那条算式在这一侧，所以过线阈值
 *     比的是一道算式，不是一次印象。
 *   · **对不上号的一律丢掉，不猜。** 编号越界、五维不全、分数越界、没给理由 ——
 *     四种都丢，而且丢的是那一条，不是那一批。
 *   · **一批挂了不拖垮别的批。** 三十条分三批，中间那批挂了，另外两批照收。
 */
import { describe, expect, it } from "vitest";

import { triage, weigh, WEIGHTS, type Candidate } from "./triage";

const cand = (n: number): Candidate => ({
  url: `https://example.com/${n}`,
  title: `第 ${n} 条`,
  snippet: "摘要",
  source: "example.com",
  kiq: "KIQ1.1",
});

const full = { 假设关联: 5, 影响幅度: 4, 时间窗: 3, 新颖度: 4, 可行动: 2 };

describe("五维加权", () => {
  it("按策略第四节那组权重算", () => {
    // 5×0.3 + 4×0.25 + 3×0.2 + 4×0.15 + 2×0.1 = 1.5+1+0.6+0.6+0.2 = 3.9
    expect(weigh(full)).toBe(3.9);
  });

  it("权重加起来是 1 —— 不然满分不是 5 分", () => {
    const sum = Object.values(WEIGHTS).reduce((a, b) => a + b, 0);
    expect(Math.round(sum * 1000) / 1000).toBe(1);
    expect(weigh({ 假设关联: 5, 影响幅度: 5, 时间窗: 5, 新颖度: 5, 可行动: 5 })).toBe(5);
  });

  it("缺一维就不算 —— 缺一维的加权平均不是这条算式", () => {
    const { 可行动, ...missing } = full;
    void 可行动;
    expect(weigh(missing)).toBeUndefined();
  });

  it("越界的分不夹紧，判为不可用", () => {
    // 夹成 5 分会把一次没读懂题的回答洗成一个看起来正常的高分。
    expect(weigh({ ...full, 影响幅度: 12 })).toBeUndefined();
    expect(weigh({ ...full, 影响幅度: 0 })).toBeUndefined();
  });
});

describe("一批研判", () => {
  it("过门槛的算分，够不上的只记一笔", async () => {
    const r = await triage({
      candidates: [cand(1), cand(2)],
      strategyBody: "（策略正文）",
      call: async () =>
        JSON.stringify({
          items: [
            { i: 1, dimensions: full, kiq: "KIQ2.2", why: "若为真，语音那条假设要重估", suggested_issue: "跟不跟" },
            { i: 2, reject: "纯营销通稿" },
          ],
        }),
    });

    expect(r.rejected).toBe(1);
    expect(r.errors).toEqual([]);
    expect(r.scored).toHaveLength(1);
    expect(r.scored[0].score).toBe(3.9);
    // 研判可以改判编号 —— 捞它上来的问法和它真正回答的问题不一定是同一个。
    expect(r.scored[0].kiq).toBe("KIQ2.2");
    expect(r.scored[0].url).toBe("https://example.com/1");
  });

  it("四种答不成形的都丢掉那一条，不丢那一批", async () => {
    const r = await triage({
      candidates: [cand(1), cand(2), cand(3), cand(4), cand(5)],
      strategyBody: "（策略正文）",
      call: async () =>
        JSON.stringify({
          items: [
            { i: 99, dimensions: full, why: "编号越界" },
            { i: 2, dimensions: { 假设关联: 5 }, why: "五维不全" },
            { i: 3, dimensions: { ...full, 时间窗: 9 }, why: "分数越界" },
            { i: 4, dimensions: full },
            { i: 5, dimensions: full, why: "这条是好的" },
          ],
        }),
    });

    expect(r.scored.map((s) => s.title)).toEqual(["第 5 条"]);
    // 编号越界那一条**不记 note**：它指不到这一批里的任何一条，连「第几条坏了」都说不出来。
    expect(r.errors).toHaveLength(3);
    expect(r.errors.join("")).toContain("第 2 条");
    expect(r.errors.join("")).toContain("第 4 条");
  });

  it("不按顺序对齐 —— 模型少回一条，后面的理由不会挂错对象", async () => {
    const r = await triage({
      candidates: [cand(1), cand(2), cand(3)],
      strategyBody: "（策略正文）",
      // 只回第 3 条。按顺序对齐的话它会被安到第 1 条头上。
      call: async () => JSON.stringify({ items: [{ i: 3, dimensions: full, why: "说的是第三条" }] }),
    });

    expect(r.scored).toHaveLength(1);
    expect(r.scored[0].title).toBe("第 3 条");
  });

  it("一批挂了，别的批照收", async () => {
    let n = 0;
    const r = await triage({
      // 25 条 = 三批（10 / 10 / 5）
      candidates: Array.from({ length: 25 }, (_, i) => cand(i + 1)),
      strategyBody: "（策略正文）",
      call: async () => {
        n += 1;
        if (n === 2) throw new Error("限流了");
        return JSON.stringify({ items: [{ i: 1, dimensions: full, why: "好的" }] });
      },
    });

    expect(n).toBe(3);
    expect(r.scored).toHaveLength(2);
    expect(r.errors).toHaveLength(1);
    expect(r.errors[0]).toContain("第 2 批");
    expect(r.errors[0]).toContain("限流了");
  });

  it("一条都没有时不调模型", async () => {
    let n = 0;
    const r = await triage({
      candidates: [],
      strategyBody: "（策略正文）",
      call: async () => {
        n += 1;
        return "{}";
      },
    });
    expect(n).toBe(0);
    expect(r.scored).toEqual([]);
  });
});
