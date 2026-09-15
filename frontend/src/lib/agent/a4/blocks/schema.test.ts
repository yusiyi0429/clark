/**
 * 决断包读那一层（`readCommandBrief`）里唯一一处会改内容的地方：**排期那三栏**。
 *
 * 2026-09-07 加。这一层平时只落默认值、不动模型交的字，破例的理由在 `schema.ts` 那段注释上 ——
 * `dueOn` 下游会被当成日期消费（`store.ts` 渲染成「X 前」、批准那一步据它排期），「首访前」
 * 留在那一栏里不会显示成一句相对时间，会变成一个谁也没约过的到期日（ISS-239 那三个九月的
 * 日子）。所以这几条钉的是：**什么算日期、不算的挪去哪儿、挪了看不看得出来、旧报告还读不读得动。**
 */
import { describe, expect, it } from "vitest";

import { isDueDay, readCommandBrief } from "./schema";

/** 一份最小可读的决断包：有主张就收得下，别的栏在这几条里不是重点。 */
const raw = (orders: unknown[]) => ({
  type: "command_brief",
  recommendation: { action: "先把验收口径问回来", evidenceEffect: "narrowed", evidenceEffectWhy: "E2 收窄了范围" },
  proposedOrders: orders,
});

const readOrders = (orders: unknown[]) => {
  const r = readCommandBrief(raw(orders));
  if (!r.ok) throw new Error(r.why);
  return r.value;
};

describe("isDueDay：只认 2026-09-19 这一种写法", () => {
  it("认 ISO 日期，不认月份、中文日期和相对时间", () => {
    expect(isDueDay("2026-09-19")).toBe(true);
    expect(isDueDay(" 2026-09-19 ")).toBe(true);
    for (const x of ["2026-09", "2026/09/19", "2026 年 9 月 19 日", "首访前", "日期待定", ""]) {
      expect(isDueDay(x), x).toBe(false);
    }
  });
});

describe("readCommandBrief 的排期三栏", () => {
  const order = { role: "行业组", outcome: "拿回验收口径", acceptance: ["书面确认"] };

  it("确定日期原样留在 dueOn，依据留在 dueBasis", () => {
    const v = readOrders([{ ...order, dueOn: "2026-09-19", dueBasis: "对方 9 月 20 日董事会前" }]);
    expect(v.proposedOrders[0].dueOn).toBe("2026-09-19");
    expect(v.proposedOrders[0].dueBasis).toBe("对方 9 月 20 日董事会前");
    expect(v.proposedOrders[0].dueNote).toBeUndefined();
    expect(v.defaulted ?? []).not.toContain("proposedOrders[0].dueOn");
  });

  it("dueOn 里写的不是日期 —— 挪去 dueNote，并且记进 defaulted", () => {
    for (const rel of ["首访前", "日期待定", "2026 年 9 月 19 日", "2026-09", "立项后两周内"]) {
      const v = readOrders([{ ...order, dueOn: rel }]);
      expect(v.proposedOrders[0].dueOn, rel).toBe("");
      expect(v.proposedOrders[0].dueNote, rel).toBe(rel);
      // 挪过位置这件事必须看得见 —— 静悄悄地改内容和编一个日期一样坏。
      expect(v.defaulted ?? [], rel).toContain("proposedOrders[0].dueOn");
    }
  });

  it("模型自己就写对了两栏 —— 一栏都不动", () => {
    const v = readOrders([{ ...order, dueOn: "", dueNote: "首访前" }]);
    expect(v.proposedOrders[0].dueOn).toBe("");
    expect(v.proposedOrders[0].dueNote).toBe("首访前");
    expect(v.defaulted ?? []).not.toContain("proposedOrders[0].dueOn");
  });

  it("两栏都写了 —— dueNote 是它自己的，不被 dueOn 顶掉", () => {
    const v = readOrders([{ ...order, dueOn: "2026-09-19", dueBasis: "开工前", dueNote: "首访之后" }]);
    expect(v.proposedOrders[0].dueOn).toBe("2026-09-19");
    expect(v.proposedOrders[0].dueNote).toBe("首访之后");
  });

  it("三栏都没有 —— 收得下，不补一个日期", () => {
    const v = readOrders([order]);
    expect(v.proposedOrders[0].dueOn).toBe("");
    expect(v.proposedOrders[0].dueNote).toBeUndefined();
    expect(v.proposedOrders[0].dueBasis).toBeUndefined();
  });

  /**
   * 旧报告只有 `dueOn` 一栏，两个新栏是可选的 —— 这一条钉住它们还读得动，而且**不会因为
   * 少了新栏就被判成有缺陷**。已经确认过的决议不重写、不撤销（HANDOVER §3.D）。
   */
  it("旧报告（只有 dueOn，没有新字段）照旧可读", () => {
    const v = readOrders([{ role: "客户线", outcome: "首访拿到口径", dueOn: "2026-09-14", acceptance: ["签字确认"] }]);
    expect(v.proposedOrders).toEqual([
      { role: "客户线", outcome: "首访拿到口径", dueOn: "2026-09-14", acceptance: ["签字确认"] },
    ]);
    expect(v.defaulted ?? []).not.toContain("proposedOrders[0].dueOn");
  });

  it("多条命令各记各的下标 —— 挪的是第二条就写第二条", () => {
    const v = readOrders([{ ...order, dueOn: "2026-09-19", dueBasis: "开工前" }, { ...order, dueOn: "首访前" }]);
    expect(v.defaulted).toContain("proposedOrders[1].dueOn");
    expect(v.defaulted ?? []).not.toContain("proposedOrders[0].dueOn");
  });
});
