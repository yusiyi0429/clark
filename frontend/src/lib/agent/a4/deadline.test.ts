/**
 * 时间预算那三件事：**默认 30 分钟、环境变量改得动、留位算得对**。
 *
 * 「留位算得对」不是算术题：`WRITE_RESERVE_MS` 是 N3 决定还发不发一波时看的那个数，它要是
 * 比出稿那一整段小，收口那一次就会在时间用完之后才发 —— 而收口那一次拿着核心判断横幅。
 */
import { afterEach, describe, expect, it } from "vitest";

import {
  CALL_FLOOR_MS,
  CLOSING_RESERVE_MS,
  COST,
  canDispatch,
  callBudget,
  deadlineMs,
  readDelivery,
  room,
  shedNote,
  UNKNOWN_DELIVERY,
  WRITE_PASS_MS,
  WRITE_RESERVE_MS,
  type Delivery,
} from "./deadline";

afterEach(() => {
  delete process.env.TKOS_A4_DEADLINE_MS;
});

describe("deadlineMs", () => {
  it("默认 30 分钟 —— 一号位定的口径，成本表去凑它", () => {
    delete process.env.TKOS_A4_DEADLINE_MS;
    expect(deadlineMs()).toBe(30 * 60_000);
  });

  it("环境变量改得动，而且是读的时候才算", () => {
    process.env.TKOS_A4_DEADLINE_MS = "90000";
    expect(deadlineMs()).toBe(90_000);
    process.env.TKOS_A4_DEADLINE_MS = "1000";
    expect(deadlineMs()).toBe(1000);
  });

  it("写坏了回落到默认值，不回落到 0", () => {
    for (const bad of ["", "  ", "abc", "0", "-1"]) {
      process.env.TKOS_A4_DEADLINE_MS = bad;
      expect(deadlineMs()).toBe(30 * 60_000);
    }
  });
});

describe("room", () => {
  it("要的加上留的都装得下才算够", () => {
    expect(room(100, 60, 40)).toBe(true);
    expect(room(100, 60, 41)).toBe(false);
    expect(room(100, 100)).toBe(true);
    expect(room(99, 100)).toBe(false);
  });

  it("不给上限时（Infinity）恒为真 —— 单测里那些不带 deadline 的 harness 一行都不用改", () => {
    expect(room(Number.POSITIVE_INFINITY, WRITE_RESERVE_MS, WRITE_RESERVE_MS)).toBe(true);
  });
});

describe("留位", () => {
  it("出稿那一整段 = 对账 + 一整遍 N5", () => {
    expect(WRITE_RESERVE_MS).toBe(COST.reconcile + WRITE_PASS_MS);
    // 一整遍 N5 至少装得下排结构 + 一节 + 收口，否则收口那一次会发不出去。
    expect(WRITE_PASS_MS).toBeGreaterThan(COST.outline + COST.section + COST.closing);
  });

  it("出一稿按新形状算：暖缓存一次 + 各节一波（一节的墙上时间）", () => {
    // 分节那一项是 1×，不是 2×，更不是 `节数 ×` —— 几节是同时发出去的（`stage-write.ts`）。
    // 这一条钉的是那个形状：改回「先串行跑一节暖缓存」的话，它会先红。
    expect(WRITE_PASS_MS).toBe(
      COST.outline + COST.warm + COST.section + COST.closing + 2 * COST.anchorGate
    );
  });

  it("每一段都比「一次调用值得发」的下限大 —— 否则那一步等于永远不发", () => {
    for (const [name, ms] of Object.entries(COST)) {
      expect(ms, name).toBeGreaterThanOrEqual(CALL_FLOOR_MS);
    }
  });

  /*
   * **一遍顺利的运行要装得进默认上限。** 这一条是这张表存在的理由本身：20 分钟那个数
   * 两次「装不下」都是先在真运行里表现成「总在收口那里被砍」，回头一加才发现从一开始就
   * 不可能达到（见 `DEFAULT_DEADLINE_MS` 那三段）。加法在这里做一遍，下一次谁调高哪一项，
   * 这一条当场告诉他这个上限还够不够 —— 而不是等下一轮真跑花掉几十块钱才知道。
   */
  it("一遍顺利的运行（一波取证）装得进默认上限", () => {
    const smooth =
      COST.anchor + COST.draft + COST.plan + COST.wave + COST.reconcile + WRITE_PASS_MS;
    expect(smooth).toBeLessThanOrEqual(deadlineMs());
    /*
     * 余量也钉一下。2026-09-04 之前这里钉的是「不到一成」——那时一遍顺利的运行余 165 秒，
     * 取证被挤到 0 秒（ISS-223/226）。分节预算压到 1500 字、收口换 gpt-5.6 之后，section 与
     * closing 两项合计少了 295 秒，余量的用途明确：**至少装得下第二波取证**。所以下限钉在
     * 一波的成本上；上限钉在三分之一 —— 忽然宽出这么多同样是表被人动过而没人重算的信号。
     */
    const margin = deadlineMs() - smooth;
    expect(margin).toBeGreaterThanOrEqual(COST.wave);
    expect(margin).toBeLessThan(deadlineMs() / 3);
  });
});

/* -------------------------------------------------------------------------- */
/* 每次调用的墙上预算（§3.E）                                                    */
/* -------------------------------------------------------------------------- */

describe("callBudget", () => {
  it("跑晚了的时候给下限：结构那一步缩不动，收口缩得动（ISS-240）", () => {
    // ISS-240 实测：轮到排结构只剩 456 秒，keep 吃掉 410，它拿到 46 秒 —— 网关等到 45 秒
    // 超时，大纲没交出章节，24 条证据一条都没用上。
    expect(callBudget(456_000, 410_000)).toBe(46_000);
    expect(callBudget(456_000, 410_000, undefined, 145_000)).toBe(145_000);
    // 下限不制造时间：真的只剩一点点时照样按剩下的给。
    expect(callBudget(30_000, 410_000, undefined, 145_000)).toBe(30_000);
    // 宽裕的时候下限不起作用，仍按「剩余 − 保留」。
    expect(callBudget(1_200_000, 410_000, undefined, 145_000)).toBe(790_000);
    // `want` 仍然封得住顶。
    expect(callBudget(1_200_000, 410_000, 200_000, 145_000)).toBe(200_000);
  });

  it("收口保留就是收口那一次加两次锚点检查", () => {
    expect(CLOSING_RESERVE_MS).toBe(COST.closing + 2 * COST.anchorGate);
  });

  /*
   * 这一条钉的是 §3.E 那句「每次调用预算不得超过剩余总时长减去收口保留」。
   * 破了它的表现不是报错，是收口那一次发不出去 —— 报告没有核心判断横幅和最终判断，
   * 而屏幕上它看着写完了。ISS-239 那一轮 S1/S2 各等满 420 秒就是这个形状。
   */
  it("剩余时间减去后面要留的位置", () => {
    expect(callBudget(1_000_000, CLOSING_RESERVE_MS)).toBe(1_000_000 - CLOSING_RESERVE_MS);
    expect(callBudget(1_000_000, CLOSING_RESERVE_MS)).toBeLessThan(1_000_000);
  });

  it("留的位置比剩余还多时是 0，不是负数 —— 负数递下去会被当成「不限」", () => {
    expect(callBudget(10_000, CLOSING_RESERVE_MS)).toBe(0);
  });

  it("这一步自己的估值可以再封一次顶（暖缓存那一次要它）", () => {
    expect(callBudget(1_000_000, CLOSING_RESERVE_MS, COST.warm)).toBe(COST.warm);
  });

  it("不限时的那一轮返回 Infinity —— 调用方据此整个不带这个键", () => {
    expect(callBudget(Number.POSITIVE_INFINITY, CLOSING_RESERVE_MS)).toBe(Number.POSITIVE_INFINITY);
    expect(callBudget(Number.POSITIVE_INFINITY, CLOSING_RESERVE_MS, COST.warm)).toBe(COST.warm);
  });
});

/* -------------------------------------------------------------------------- */
/* 交付完整性三态（§3.E）                                                        */
/* -------------------------------------------------------------------------- */

describe("交付完整性", () => {
  const full: Delivery = {
    callsFinished: true,
    completeness: "完整",
    readiness: "具备决策条件",
    coreSections: { written: 3, planned: 3 },
    closing: true,
    why: [],
  };

  it("旧报告没有这一栏 → 一律未知", () => {
    for (const legacy of [null, undefined, {}, { delivery: null }, { delivery: "完整" }]) {
      expect(readDelivery(legacy)).toEqual(UNKNOWN_DELIVERY);
    }
  });

  /*
   * §3.E：「不许凭 confidence 猜成完整」。置信度说的是判断有多硬，不是报告写完了没有 ——
   * 猜出来的「完整」比「未知」坏得多：它会让服务端的下达入口放行一份没人验过的东西。
   */
  it("旧报告哪怕写着高置信、status=ok，也还是未知", () => {
    const legacy = { confidence: "较为确信", status: "ok", degraded: false };
    expect(readDelivery(legacy).completeness).toBe("未知");
    expect(readDelivery(legacy).readiness).toBe("未知");
    expect(canDispatch(readDelivery(legacy))).toBe(false);
  });

  it("记了的那一栏原样读回来", () => {
    expect(readDelivery({ delivery: full })).toEqual(full);
  });

  it("认不出来的档位退回未知，不退回「完整」", () => {
    const r = readDelivery({ delivery: { completeness: "差不多", readiness: "应该能用" } });
    expect(r.completeness).toBe("未知");
    expect(r.readiness).toBe("未知");
  });

  /*
   * ISS-239：三节只成一节，收口补了摘要。**补摘要不等于补齐核心论证** —— 这两件事在
   * `coreSections` 和 `closing` 两栏上分得开，读的人不用自己去数节数。
   */
  it("「收口交了」和「核心论证写全了」是两栏，不能互相顶", () => {
    const iss239: Delivery = {
      callsFinished: true,
      completeness: "部分",
      readiness: "可供讨论",
      coreSections: { written: 1, planned: 3 },
      closing: true,
      why: ["核心论证 3 节只写成 1 节；收口补了摘要，那不等于缺的那几节的论证被补上了"],
    };
    const back = readDelivery({ delivery: iss239 });
    expect(back.closing).toBe(true);
    expect(back.coreSections).toEqual({ written: 1, planned: 3 });
    expect(canDispatch(back)).toBe(false);
  });

  it("只有「具备决策条件」那一档能下达", () => {
    expect(canDispatch(full)).toBe(true);
    for (const r of ["可供讨论", "不足以讨论", "未知"] as const) {
      expect(canDispatch({ ...full, readiness: r })).toBe(false);
    }
  });
});

describe("shedNote", () => {
  it("说清三件事：少做了什么、上限多少、还剩多少", () => {
    process.env.TKOS_A4_DEADLINE_MS = String(20 * 60_000);
    const line = shedNote("「格局」这条链停在第 1 波", 45_000);
    expect(line).toContain("「格局」这条链停在第 1 波");
    expect(line).toContain("20 分钟");
    expect(line).toContain("45 秒");
    expect(line).toContain("按现状收口");
  });

  it("剩负数按 0 说 —— 「只剩 -3 秒」读起来像 bug", () => {
    expect(shedNote("收口", -3000)).toContain("只剩 0 秒");
  });

  it("不足一分钟的上限按秒说 —— 「上限是 0 分钟」同理", () => {
    process.env.TKOS_A4_DEADLINE_MS = "25000";
    expect(shedNote("收口", 24_000)).toContain("上限是 25 秒");
  });
});
