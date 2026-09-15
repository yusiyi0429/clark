/**
 * 拟检索式这一步钉两件事：
 *
 *   · **编号对不上策略的一律丢掉。** 屏幕上那个 KIQ 编号是「为什么值得看」的锚，
 *     一个指不回策略任何一行的编号比没有编号更糟。
 *   · **模型挂了要退化，不要整轮完。** 退化的产出差一档，但它是真的题；
 *     一挂就整轮失败的代价是一号位按下那个键之后什么都没有。
 */
import { describe, expect, it } from "vitest";

import { buildQueries } from "./queries";
import type { ScanStrategy } from "./strategy";

const strategy: ScanStrategy = {
  origin: "（测试）",
  body: "（策略正文）",
  hypotheses: [],
  limits: [],
  domains: [
    {
      code: "D1",
      title: "竞争与替代",
      kiqs: ["KIQ1.1 Palantir 类平台有无面向中国市场的新动作？", "KIQ1.2 有没有新的对手？"],
    },
    { code: "D2", title: "模型与供给", kiqs: ["KIQ2.1 主力依赖模型有无价格调整？"] },
  ],
};

describe("拟检索式", () => {
  it("收下编号对得上的，丢掉编号编出来的", async () => {
    const plan = await buildQueries({
      strategy,
      call: async () =>
        JSON.stringify({
          queries: [
            { q: "Palantir 中国 企业本体 发布", kiq: "KIQ1.1" },
            { q: "编出来的一条", kiq: "KIQ7.9" },
            { q: "豆包 模型 降价", kiq: "KIQ2.1" },
          ],
        }),
    });

    expect(plan.degraded).toBe("");
    expect(plan.queries).toEqual([
      { q: "Palantir 中国 企业本体 发布", kiq: "KIQ1.1" },
      { q: "豆包 模型 降价", kiq: "KIQ2.1" },
    ]);
  });

  it("同一个编号只留一条", async () => {
    const plan = await buildQueries({
      strategy,
      call: async () =>
        JSON.stringify({
          queries: [
            { q: "第一条", kiq: "KIQ1.1" },
            { q: "第二条", kiq: "KIQ1.1" },
          ],
        }),
    });
    expect(plan.queries).toHaveLength(1);
    expect(plan.queries[0].q).toBe("第一条");
  });

  it("模型挂了：退成 KIQ 原文，掐掉编号和问号", async () => {
    const plan = await buildQueries({
      strategy,
      call: async () => {
        throw new Error("超时了");
      },
    });

    expect(plan.degraded).toContain("超时了");
    expect(plan.queries).toEqual([
      { q: "Palantir 类平台有无面向中国市场的新动作", kiq: "KIQ1.1" },
      { q: "有没有新的对手", kiq: "KIQ1.2" },
      { q: "主力依赖模型有无价格调整", kiq: "KIQ2.1" },
    ]);
  });

  it("模型回了一份一条都用不了的：同样退化，而且说出来", async () => {
    const plan = await buildQueries({
      strategy,
      call: async () => JSON.stringify({ queries: [{ q: "有编号但对不上", kiq: "KIQ9.9" }] }),
    });
    expect(plan.degraded).toBeTruthy();
    expect(plan.queries).toHaveLength(3);
  });

  it("策略里一条 KIQ 都认不出来：这一步就该失败", async () => {
    // 没有题库，拟出来的问法就没有一条挂得上编号 —— 而那是这一整条链路的锚。
    // 这不是可以退化的事，是策略正文的格式变了，得先修解析。
    await expect(
      buildQueries({ strategy: { ...strategy, domains: [] }, call: async () => "{}" }),
    ).rejects.toThrow(/一条 KIQ 都没认出来/);
  });
});
