// 这两行必须在**任何会摸到 store.ts 的 import 之前**生效，而写在文件顶上不够：
// ESM 的 import 会被提到模块最前面求值，所以静态 import 一律排在这两行赋值之前，
// 真模块在 beforeAll 里 await import（照 `store.judgements.test.ts` 开头那一段）。
//
// TKOS_PERSIST=0：别读也别写 .data 里那份真快照。
process.env.TKOS_PERSIST = "0";
// TKOS_MODEL_MOCK=1：单测里一次模型都不许真调用（立案会当场起一轮预研），
// 而这台机器上可能导出着真 key。
process.env.TKOS_MODEL_MOCK = "1";

/**
 * 参谋判这条不值得开成议题，一号位不采纳，仍然开。
 *
 * 这条路上最容易坏、坏了又看不出来的是**时间线上那条分歧**：议题照样建出来了、卡照样
 * 在清单上，屏幕上一切正常，只有半年后回看时才发现账上写的是「A1a 判为值得」——
 * 而真实发生的是相反的那件事。所以这里对着那条事件的措辞钉死。
 *
 * 另外三条也在这儿钉住：没有那四块框架（编一份比没有更坏）、仍然算信号来的、
 * 处置那一格不许被重新盖一次时刻。
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { api as Api } from "./store";
import type {
  __getCardForTest as GetCard,
  inboxSignalDispose as Dispose,
  inboxSignalGet as Get,
  inboxSignalJudged as Judged,
  reportSignal as Report,
} from "./store";

let api: typeof Api;
let __getCardForTest: typeof GetCard;
let inboxSignalDispose: typeof Dispose;
let inboxSignalGet: typeof Get;
let inboxSignalJudged: typeof Judged;
let reportSignal: typeof Report;

beforeAll(async () => {
  const store = await import("./store");
  api = store.api;
  __getCardForTest = store.__getCardForTest;
  inboxSignalDispose = store.inboxSignalDispose;
  inboxSignalGet = store.inboxSignalGet;
  inboxSignalJudged = store.inboxSignalJudged;
  reportSignal = store.reportSignal;
});

/**
 * 摆一条「A1a 已经判为不值得」的待挑信号，回到他此刻在屏幕上看到的那个状态：
 * 处置已经记下（起 A1a 那条 route 在跑之前就标了），结论也已经落在这条信号上。
 */
const ignoredSignal = (runId: string, shakes?: string): string => {
  const dedupeKey = `dri-anyway-${Math.random().toString(16).slice(2)}`;
  reportSignal({
    kind: "reported",
    by: "张三",
    dedupeKey,
    title: "某家媒体给这篇稿子起的标题",
    url: "",
    text: "信号原文。",
    publishedAt: "",
    source: "内部",
    why: "他觉得现在要看",
    ...(shakes ? { shakes } : {}),
  });
  inboxSignalDispose(dedupeKey, "issue");
  inboxSignalJudged(dedupeKey, {
    runId,
    status: "ignored",
    route: "ignore",
    at: "2026-08-29T10:00:00+08:00",
  });
  return dedupeKey;
};

describe("参谋判不值得，一号位仍然要开", () => {
  it("时间线上明写这次分歧：参谋判了什么、他决定了什么，都在那条事件上", async () => {
    const key = ignoredSignal("RUN-ignored-01");
    const issue = await api.openIssueAnyway(key, "决策链换人之后，我们的投标策略还成立吗");

    const timeline = await api.getTimeline(issue.id);
    const raised = timeline.find((e) => e.id === `E-${issue.id}-raised`);
    expect(raised).toBeDefined();

    // 参谋那一侧：这条事件必须说出「参谋判的是不值得」，而不是照抄判为值得那一句。
    expect(raised?.headline).toContain("参谋判不值得");
    expect(raised?.detail).toContain("RUN-ignored-01");
    expect(raised?.detail).toContain("不值得开成议题");

    // 他那一侧：谁、决定了什么、标题是谁写的。
    expect(raised?.headline).toContain("一号位仍决定开");
    expect(raised?.actor).toBeTruthy();
    expect(raised?.detail).toContain("不采纳");
    expect(raised?.detail).toContain("决策链换人之后，我们的投标策略还成立吗");
  });

  it("没有那四块框架 —— 模型在这条路上没产出它们，卡上那一格就是空的", async () => {
    const key = ignoredSignal("RUN-ignored-02");
    const issue = await api.openIssueAnyway(key, "这一条到底是什么");

    const card = __getCardForTest(issue.id);
    expect(card).toBeDefined();
    expect(card?.framing).toBeUndefined();
  });

  it("仍然算信号来的：origin 是 signal，卡的来源照信号那一支走", async () => {
    const key = ignoredSignal("RUN-ignored-03");
    const issue = await api.openIssueAnyway(key, "标题由他自己写");

    expect(issue.origin).toBe("signal");
    expect(issue.state).toBe("Candidate");

    const card = __getCardForTest(issue.id);
    // 人报那一支：卡的来源是那个具体的人，不是「他自己想的」。
    expect(card?.source).toEqual({ kind: "dri", by: "张三" });
    // 卡面最响的一行就是这条议题本身。
    expect(card?.headline).toBe(issue.title);
  });

  it("处置那一格不动：起 A1a 那一下已经标过了，这里不许再盖一次时刻", async () => {
    const key = ignoredSignal("RUN-ignored-04");
    const before = inboxSignalGet(key);
    expect(before?.disposedAs).toBe("issue");

    const issue = await api.openIssueAnyway(key, "改不改处置时刻");

    const after = inboxSignalGet(key);
    expect(after?.disposedAs).toBe("issue");
    expect(after?.disposedAt).toBe(before?.disposedAt);
    // 开出来的编号记回这条信号 —— 它确实是这条信号开出来的。
    expect(after?.judged?.issueId).toBe(issue.id);
  });

  it("同一条信号不许立两次案", async () => {
    const key = ignoredSignal("RUN-ignored-05");
    const first = await api.openIssueAnyway(key, "第一次");
    await expect(api.openIssueAnyway(key, "第二次")).rejects.toThrow(first.id);
  });

  it("标题是空的就不许开 —— 这条路上没有可回落的东西", async () => {
    const key = ignoredSignal("RUN-ignored-06");
    await expect(api.openIssueAnyway(key, "   ")).rejects.toThrow();
    // 没建出任何东西，那条信号上也不该多出一个议题号。
    expect(inboxSignalGet(key)?.judged?.issueId).toBeUndefined();
  });

  it("人报那一支答过的「动摇哪条判断」照样接上", async () => {
    const key = ignoredSignal("RUN-ignored-07", "04-J1");
    const issue = await api.openIssueAnyway(key, "它动摇的是那条判断");
    expect(issue.judgmentRefs).toEqual(["04-J1"]);
  });
});
