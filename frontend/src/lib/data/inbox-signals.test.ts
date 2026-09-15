/**
 * 待挑信号的落库。
 *
 * 断言一律写成「我刚写的那条在不在、对不对」，**不断言集合里只有这几条** ——
 * store 是持久化的（`.data/store.json`），本机跑过一次 dev 之后里面就有真实的
 * 信号。写成 toEqual 的话，「在这台机器上跑过应用」本身会让测试变红。
 * （同 `agent-runs.test.ts` 里那段注释。）
 */
import { describe, expect, it } from "vitest";

import {
  api,
  inboxSignalDispose,
  inboxSignalGet,
  inboxSignalJudged,
  inboxSignalsPut,
} from "./store";
import type { CrawledSignalInput } from "./types";

const input = (key: string, over: Partial<CrawledSignalInput> = {}): CrawledSignalInput => ({
  kind: "crawled",
  dedupeKey: key,
  title: `标题 ${key}`,
  url: `https://a.com/${key}`,
  text: "正文",
  publishedAt: "2026-08-18T02:00:00Z",
  source: "36氪·AI",
  origin: "pinned",
  score: 4,
  dimensions: { materiality: 4 },
  kiq: "KIQ2.2",
  why: "原因",
  suggestedIssue: "方向",
  runId: "RUN-7",
  scannedAt: "2026-08-19T07:00:00Z",
  ...over,
});

describe("inboxSignalsPut", () => {
  it("同一个键第二次来只更新研判，不新增，也不动收件时间", () => {
    const first = inboxSignalsPut([input("k-1")]);
    expect(first).toEqual({ inserted: 1, updated: 0 });
    const at = inboxSignalGet("k-1")?.receivedAt;

    const again = inboxSignalsPut([input("k-1", { score: 4.8, why: "改了", runId: "RUN-8" })]);
    expect(again).toEqual({ inserted: 0, updated: 1 });

    const got = inboxSignalGet("k-1");
    expect(got?.kind).toBe("crawled");
    if (got?.kind === "crawled") {
      expect(got.score).toBe(4.8);
      expect(got.why).toBe("改了");
      expect(got.runId).toBe("RUN-8");
    }
    // 窗口是重叠的（time_window_hours=72，扫描每天一轮），这一条必须成立。
    expect(got?.receivedAt).toBe(at);
  });

  it("一号位挑过的东西不会因为下一轮扫描又冒回列表", () => {
    inboxSignalsPut([input("k-2")]);
    inboxSignalDispose("k-2", "dismiss");
    inboxSignalsPut([input("k-2", { score: 5 })]);

    const got = inboxSignalGet("k-2");
    expect(got?.kind).toBe("crawled");
    if (got?.kind === "crawled") {
      expect(got.score).toBe(5);
    }
    expect(got?.disposedAs).toBe("dismiss");
    expect(got?.disposedAt).toBeTruthy();
  });

  it("一批里自己重了也只算一条", () => {
    const got = inboxSignalsPut([input("k-3"), input("k-3", { score: 2 })]);
    expect(got).toEqual({ inserted: 1, updated: 1 });
    const sig = inboxSignalGet("k-3");
    expect(sig?.kind).toBe("crawled");
    if (sig?.kind === "crawled") {
      expect(sig.score).toBe(2);
    }
  });

  it("拿不到的键返回 null，不抛", () => {
    expect(inboxSignalGet("k-不存在")).toBeNull();
    expect(inboxSignalDispose("k-不存在", "watch")).toBeNull();
    expect(inboxSignalJudged("k-不存在", { runId: "R", status: "ok", at: "T" })).toBe(false);
  });
});

describe("listInboxSignals", () => {
  it("只出未处置的，分数高的在前，同分先来的在前", async () => {
    inboxSignalsPut([
      input("k-low", { score: 3.6 }),
      input("k-high", { score: 4.9 }),
      input("k-gone", { score: 5 }),
    ]);
    inboxSignalDispose("k-gone", "issue");

    const list = await api.listInboxSignals();
    const keys = list.map((s) => s.dedupeKey);
    expect(keys).not.toContain("k-gone");
    expect(keys.indexOf("k-high")).toBeLessThan(keys.indexOf("k-low"));
    expect(list.every((s) => !s.disposedAs)).toBe(true);
  });

  it("处置回来的就是那一条的新样子", async () => {
    inboxSignalsPut([input("k-4")]);
    const got = await api.disposeInboxSignal("k-4", "watch");
    expect(got.disposedAs).toBe("watch");
    await expect(api.disposeInboxSignal("k-没有", "watch")).rejects.toThrow(/找不到/);
  });

  it("A1a 的结论记在信号上，和处置分开 —— 跑挂了也不该让「他挑过」消失", () => {
    inboxSignalsPut([input("k-5")]);
    inboxSignalDispose("k-5", "issue");
    expect(
      inboxSignalJudged("k-5", {
        runId: "RUN-a1a-1",
        status: "failed",
        at: "2026-08-19T08:00:00.000Z",
      })
    ).toBe(true);

    const got = inboxSignalGet("k-5");
    expect(got?.disposedAs).toBe("issue");
    expect(got?.judged?.status).toBe("failed");
    expect(got?.judged?.runId).toBe("RUN-a1a-1");
  });
});

describe("两种来源共存", () => {
  it("抓取那条照旧打上 crawled", () => {
    inboxSignalsPut([input("k-kind")]);
    expect(inboxSignalGet("k-kind")?.kind).toBe("crawled");
  });

  it("人报的那条没有分数", async () => {
    const { reportSignal } = await import("./store");
    reportSignal({
      kind: "reported",
      by: "测试人",
      dedupeKey: "k-reported",
      title: "人报的标题",
      url: "",
      text: "人报的正文",
      publishedAt: "",
      source: "群里",
      why: "现在",
    });
    const list = await api.listInboxSignals();
    const got = list.find((s) => s.dedupeKey === "k-reported");
    expect(got?.kind).toBe("reported");
    if (got?.kind === "reported") {
      expect(got.by).toBe("测试人");
      expect("score" in got).toBe(false);
    }
  });
});
