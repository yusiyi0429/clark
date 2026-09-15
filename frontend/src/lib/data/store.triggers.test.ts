/**
 * 两个自动触发点：**研究要在他做完决定的那一刻开始，不是在他点开某一页的时候。**
 *
 * 这两处原来都晚了一步，而且都晚在屏幕看不出来的地方：
 *
 *   · 预研原来是潜在议题详情页里的一个 `useEffect` 起的 —— 于是那一到两分钟整段落在
 *     他眼前，而他这一刻要的恰恰是读完它再按三键。
 *   · 深研原来是他点进「议题研究」那一页才真起的。采信那一下只登记了一个屏幕标记，
 *     而卡上已经写着「深度研究进行中 · 报告就绪后提醒您」—— 在他不点进去的情况下，
 *     那句话是假的：没有任何东西在跑，也不会有人提醒他。
 *
 * 所以这里钉的是「**起没起**」，不是「跑出来的东西好不好」。后者要真调模型才验得到，
 * 不在这一层。
 *
 * 预研那几轮会就地失败：第一步 `openContext("S02")` 要 GraphKnowledge，单测出不了网，
 * 而 A3 故意不把 `GraphKnowledgeUnavailable` 咽下去（图服务挂了要是被当成「图谱里没有
 * 这条议题」，每一次预研都会悄悄降级成纯外部）—— 那正好让「失败之后不自动重开」这一条
 * 也验得到。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { runTask } from "@/lib/agent/tasks";
import type { api as Api } from "./store";

let api: typeof Api;

beforeAll(async () => {
  // 别读也别写 .data 里那份真快照 —— 否则这几条断言跟着开发机上的现场数据飘。
  process.env.TKOS_PERSIST = "0";
  // 这台机器上可能导出着真 key。单测不许把钱花出去，也不许出网。
  process.env.TKOS_MODEL_MOCK = "1";
  api = (await import("./store")).api;
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

describe("议题一建出来就起预研", () => {
  it("addIssue 之后预研已经在跑，不用等他点开那张卡", async () => {
    const issue = await api.addIssue("要不要把交付这件事从项目制改成产品制");
    // idle 才是坏的那一档：那意味着这一轮要等他点进详情页才开始。
    expect((await api.preResearchStatus(issue.id)).status).not.toBe("idle");
  });

  it("跑挂了就不再自动重开 —— 这个入口是被每五秒轮一次的", async () => {
    const issue = await api.addIssue("客户续约的口径要不要统一到一个人手上");
    const settled = await settle(() => api.preResearchStatus(issue.id));
    // 假模型下没有罐头，这一轮必然失败。真跑时这里可能是 done —— 断言只针对失败那一档。
    expect(settled.status).toBe("failed");

    // 视图的轮询打的就是这个入口。它不许把 failed 翻回 running：翻一次就是每五秒
    // 一轮真实的模型调用，而屏幕上什么都不显示。
    expect((await api.startPreResearch(issue.id)).status).toBe("failed");
    expect((await api.preResearchStatus(issue.id)).status).toBe("failed");
  });
});

describe("采信那一下就起深研", () => {
  it("disposeCard(discuss) 之后深研已经在跑，卡上那句「进行中」是真的", async () => {
    const issue = await api.addIssue("要不要把本体的对外接口收到一个网关后面");
    const pending = await api.listPending();
    const card = pending.find((c) => c.issueId === issue.id);
    expect(card).toBeDefined();

    const after = await api.disposeCard(card!.id, "discuss");
    expect(after.state).toBe("Exploring");
    // 这句话此刻必须是真的 —— 它就是那个「有东西在跑」的承诺。
    expect(after.monitoringNote).toBe("深度研究进行中");
    // 同上：没有通知机制就不许在这句话里许诺通知。
    expect(after.monitoringNote).not.toContain("提醒");
    expect((await api.deepResearchStatus(issue.id)).status).not.toBe("idle");
  });
});

describe("打回重研真的起一轮", () => {
  /**
   * 原来这一步只写字：屏幕上出现「第二轮深度研究进行中」，而没有任何东西在跑。
   * 这条钉的是「起没起」，以及**两道失败闩都得解开** —— 只解 `deep` 不解 `judge`，
   * 第二份报告一样读不成判断（2026-08-19 实跑撞到过这个组合）。
   */
  it("深研失败之后，requestRework 真的再起一轮，卡上那句话按真实状态写", async () => {
    const issue = await api.addIssue("要不要把交付方法这件事做成能单独卖的东西");
    const pending = await api.listPending();
    const card = pending.find((c) => c.issueId === issue.id);
    expect(card).toBeDefined();
    await api.disposeCard(card!.id, "discuss");

    // 单测里出不了网（连图服务的地址都没配），所以这一轮必然失败 —— 正好是需要
    // 「打回重研」的那一档。
    expect((await settle(() => api.deepResearchStatus(issue.id))).status).toBe("failed");
    // 失败不自动重开：这个入口是被轮询打的。
    expect((await api.deepResearchStatus(issue.id)).status).toBe("failed");

    const after = await api.requestRework(issue.id, "第一轮没答到定价这一段");
    // 这句话此刻必须是真的，而且必须是从任务状态里读出来的，不是写死的。
    expect(after.monitoringNote).toBe("已打回 · 第二轮深度研究进行中");
    expect((await api.deepResearchStatus(issue.id)).status).toBe("running");
  });

  it("打回重研连判断那道失败闩一起解开 —— 否则报告在库里躺着，判断永远生不出来", async () => {
    const issue = await api.addIssue("要不要把研究这件事按域拆给各自的承接人");

    // 实跑撞到的那个组合：报告落库了，A5 那一轮就地失败（当时是被 max_tokens 截断）。
    // 单测里出不了网、造不出成功的 A4，所以这里直接把那个状态摆出来。
    runTask("judge", issue.id, () => Promise.reject(new Error("模型输出被 max_tokens 截断")));
    expect((await settle(() => api.judgementsStatus(issue.id))).status).toBe("failed");

    await api.startDeepResearch(issue.id);
    // 只解 deep 不解 judge 的话，这里还是 failed，而下一份报告一样读不成判断。
    expect((await api.judgementsStatus(issue.id)).status).not.toBe("failed");
  });
});
