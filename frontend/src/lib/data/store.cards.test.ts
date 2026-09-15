/**
 * 卡片和会后草案上那两个「算出来的量」。
 *
 * 两处原来都在替真实状态说话：
 *
 *   · 潜在议题卡上那一格只有两句话 —— 报告在就是「预研已完成」，报告不在就是
 *     「预研进行中…」。于是**跑挂的那一轮在屏幕上等同于还在跑**，他会一直等一个
 *     不会来的东西；而参谋判「这条不值得继续投入」也被写成一句中性的「已完成」。
 *   · 会后草案上那个「会后几分钟」原来写死成 0。没上会那条路（读完研究就定）根本
 *     没有「散会」这一刻，一个 0 在屏幕上是「刚散会、赶紧确认」—— 而那一栏唯一的
 *     用处正是这条规矩，读反方向比不说更糟。
 *
 * 所以这里钉的是「这两个量取不到的时候，屏幕上拿到的是空还是一个假数字」。
 *
 * **「参谋判这条不成立 / 说法要先改」那两句在这一层验不到**，所以这里没有那条断言：
 * 这一档的 store 里一份预研报告都没有（本体那几个议题的报告不进种子），而真跑出一份
 * `invalid` 要一次模型调用 —— 单测不出网也不花钱。这一格是把报告自己的 `status` 原样
 * 带上来，不在这一侧另立一套判定；那个 `status` 的口径由预研那一层管。
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { Meeting } from "./types";
import type {
  api as Api,
  minutesSinceMeetingAt as MinutesSinceMeetingAt,
  pastMedianLabelOf as PastMedianLabelOf,
} from "./store";

let api: typeof Api;
let minutesSinceMeetingAt: typeof MinutesSinceMeetingAt;
let pastMedianLabelOf: typeof PastMedianLabelOf;

beforeAll(async () => {
  // 别读也别写 .data 里那份真快照 —— 否则这几条断言跟着开发机上的现场数据飘。
  process.env.TKOS_PERSIST = "0";
  // 这台机器上可能导出着真 key。单测不许把钱花出去，也不许出网。
  process.env.TKOS_MODEL_MOCK = "1";
  const mod = await import("./store");
  api = mod.api;
  minutesSinceMeetingAt = mod.minutesSinceMeetingAt;
  pastMedianLabelOf = mod.pastMedianLabelOf;
});

const meeting = (fields: Partial<Meeting>): Meeting => ({
  id: "MTG-T1",
  seq: 1,
  domainId: "D-01",
  scheduledLabel: "本周四下午",
  state: "closed",
  ...fields,
});

describe("会后几分钟", () => {
  it("没上会 —— 没有这个量", () => {
    expect(minutesSinceMeetingAt(undefined, "2026-08-20T10:00:00+08:00")).toBeNull();
  });

  it("那场会还没散 —— 也没有这个量，不是 0", () => {
    expect(
      minutesSinceMeetingAt(meeting({ startedAt: "2026-08-20T09:00:00+08:00" }), "2026-08-20T10:00:00+08:00")
    ).toBeNull();
  });

  it("真有一场散了的会 —— 算出来的分钟数", () => {
    expect(
      minutesSinceMeetingAt(meeting({ endedAt: "2026-08-20T09:34:00+08:00" }), "2026-08-20T10:00:00+08:00")
    ).toBe(26);
  });

  it("散会时刻在未来（两台机器的钟差）夹到 0 —— 屏幕上不出现「会后 -3 分钟」", () => {
    expect(
      minutesSinceMeetingAt(meeting({ endedAt: "2026-08-20T10:03:00+08:00" }), "2026-08-20T10:00:00+08:00")
    ).toBe(0);
  });
});

describe("这类问题过去中位", () => {
  it("同类里一件都还没定过 —— 没有这个量，回执上整半句不说", () => {
    expect(pastMedianLabelOf([])).toBeNull();
  });

  it("写的是耗时，不是件数", () => {
    // 撞到过的就是这一下：返回的是「3 次同类决定的中位耗时」，而调用处那句话已经写了
    // 「这类问题过去中位」—— 件数印在了耗时的位置上，一号位读到的是一个错的量。
    expect(pastMedianLabelOf([48, 24, 72])).toBe("2 天（3 件）");
  });

  it("一件的时候把件数写出来 —— 不让它看起来背后有一批样本", () => {
    expect(pastMedianLabelOf([26 / 60])).toBe("26 分钟（1 件）");
  });

  it("偶数件取中间两件的平均，不是随手拿一件", () => {
    // 排序后 [2, 4, 10, 200]，中间两件 4 和 10 → 7 小时。
    // 取均值的话会被那件 200 小时拖到 54 小时 —— 那才是这里用中位的理由。
    expect(pastMedianLabelOf([200, 4, 2, 10])).toBe("7 小时（4 件）");
  });
});

/** 等这个任务跑到不再是 running。每一步都是进程内的假模型，正常几十毫秒就到。 */
const settle = async (get: () => Promise<{ status: string }>) => {
  for (let i = 0; i < 100; i++) {
    const st = await get();
    if (st.status !== "running") return st;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("任务两秒还没跑完 —— 假模型下不该发生");
};

describe("卡上那一格说的是点进去有什么", () => {
  it("预研跑挂了 —— 卡上标出来，不写成「进行中」", async () => {
    const issue = await api.addIssue("要不要把交付这件事的口径收到一份文档里");
    // 假模型下第一步就要 GraphKnowledge，出不了网，这一轮必然失败 —— 正是要钉的那一档。
    expect((await settle(() => api.preResearchStatus(issue.id))).status).toBe("failed");

    const card = (await api.listPending()).find((c) => c.issueId === issue.id);
    expect(card).toBeDefined();
    // 报告不在（没有 at），而且照实说是挂了。
    expect(card!.preResearchAt).toBeUndefined();
    expect(card!.preResearchFailed).toBe(true);
  });

});
