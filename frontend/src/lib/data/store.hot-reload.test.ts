// 必须在 import 之前设（同 `store.research-door.test.ts`）：不设 `TKOS_PERSIST=0`，
// store.ts 模块求值期会读开发机上 .data/store.json 里的真实数据。
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";
// 这个文件测的就是那条只在开发期存在的路，所以显式打开（见 `lib/dev-pin.ts`）。
process.env.TKOS_DEV_PIN = "1";

/**
 * **改代码触发的热重载，不许把一轮跑完的深研弄丢，更不许当场再起一轮。**
 *
 * 2026-09-01 的 ISS-222：一轮深研 18 分钟走到最后一步，同一时刻屏幕上那一轮**从第一步
 * 重新开始了**，而写完的那份报告一个字都没留下。查出来是这么一串：
 *
 *   1. `next dev` 重编译换掉了 `store.ts` 那一份，任务表（`agent/tasks.ts`）留着；
 *   2. 上一份模块里那一轮照旧在跑（换掉的是模块，不是那个 `await`），它跑完，把报告
 *      写进**上一份** store —— 新的这一份看不见它；
 *   3. 任务表是留着的那一份，于是它翻成 `done`；
 *   4. `ensureDeepResearch` 当时只拦 `failed`，`done` 一路走到 `runTask`，而那条已经不是
 *      `running` 了 —— 于是又起一轮真花钱的深研。
 *
 * 所以这里钉两头，缺一头都测不出这件事：
 *
 *   1. 重新求值之后**上一程的产物还在**（钉住那一份对象，见 `lib/dev-pin.ts`）；
 *   2. 就算钉子被摘掉一半（库换了、任务表留着），也**不许自动再起一轮** —— 那是这条路上
 *      最后一道闩，而它守的是钱。
 *
 * A4 换成假货：真跑一轮要联网、要花钱，而这里要的只是「它成功收尾了」这一个入口条件。
 * 计数挂在 `globalThis` 上 —— `vi.resetModules()` 会把 mock 工厂重新跑一遍，计数在模块里
 * 的话每一程都从零开始，而这个文件问的恰好是「一共起过几轮」。
 */
import { describe, expect, it, vi } from "vitest";

import type { api as Api } from "./store";
import type { AgentRunRecord, ResearchDoc } from "./types";

type Counter = { __a4Calls?: number };
const calls = (): number => (globalThis as Counter).__a4Calls ?? 0;

/** 假 A4：记一笔，然后立刻成功收尾，交一份最小但形状完整的报告。 */
vi.mock("@/lib/agent/a4/run", () => ({
  runDeepResearch: async (input: { issueId: string; title: string }) => {
    const g = globalThis as Counter;
    g.__a4Calls = (g.__a4Calls ?? 0) + 1;
    const doc: ResearchDoc = {
      issueId: input.issueId,
      judgment: [{ text: "先说结论：这一件卡在口径上，不是选型。", traces: [] }],
      keyEvidence: [{ text: "两份材料里的说法各自独立。", traces: [] }],
      counters: [{ text: "也可能只是这一期排期紧。", traces: [] }],
      unknowns: [{ text: "外部同行怎么切，本轮没能核。", traces: [] }],
      routeSuggestion: "进议题研究",
      byAgentLabel: "您的 Agent",
      assembledFrom: [{ label: "假 A4（单测）" }],
      sourceText: "## 判断\n先说结论：这一件卡在口径上。",
      sourceLabel: "ChatGPT",
    };
    const run = {
      id: `run-a4-${input.issueId}`,
      agent: "A4",
      status: "ok",
      input: input.title,
      output: null,
      contextMode: "external_only",
      trace: [],
      checks: [],
      checkSummary: { passed: 0, total: 0, allPassed: true, failed: [] },
      usage: { inputTokens: 0, outputTokens: 0, calls: 0 },
      slot: "pro",
      modelAlias: "gpt-5.6",
      providerModelId: "gpt-5.6",
      depth: "",
      snapshotId: "",
      contextRecipe: "",
      contextAnchor: "",
      contextViewer: "",
      contextAsOf: "",
      graphknowledgeBaseUrl: "",
      warnings: [],
      createdAt: "2026-09-01T01:00:00.000Z",
      finishedAt: "2026-09-01T01:01:00.000Z",
      latencyMs: 60_000,
    } as unknown as AgentRunRecord;
    return {
      doc,
      violations: [],
      attempts: 1,
      degraded: false,
      challengeCount: 0,
      challenged: false,
      evidencing: {
        propositions: 0,
        queries: 0,
        fetched: 0,
        recorded: 0,
        rounds: 0,
        hitsByProvider: {},
        lanes: [],
        primary: "",
      },
      run,
    };
  },
}));

/** 等那一轮落定。轮询而不是定长 sleep：慢一点的机器上定长会假失败。 */
const settle = async (api: typeof Api, issueId: string) => {
  for (let i = 0; i < 200; i += 1) {
    if ((await api.deepResearchStatus(issueId)).status === "done") return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`${issueId} 那一轮深研没落定`);
};

describe("热重载换掉模块之后", () => {
  it("上一程跑完的报告还在，而且没有第二轮", async () => {
    const one = (await import("./store")).api;
    const issue = await one.addIssue("会前预审这条链路要不要自己带一版评分口径");
    const card = (await one.listPending()).find((c) => c.issueId === issue.id);
    if (!card) throw new Error("提请台上没找到刚立的那张卡");
    // 采信 —— 它自己会把深研起起来（见 `disposeCard`）。
    await one.disposeCard(card.id, "discuss");
    await settle(one, issue.id);
    expect(calls()).toBe(1);

    // 这一句就是「改了一个服务端文件」：模块整个重新求值一遍。
    vi.resetModules();
    const two = (await import("./store")).api;

    // 1. 那一轮真花过钱的产物还在。原来这里是 null —— 新的那一份库是从种子起来的。
    expect((await two.getResearchDoc(issue.id))?.sourceText).toContain(
      "卡在口径上",
    );
    // 2. 而且没有因此再起一轮。
    expect(calls()).toBe(1);
  });

  it("库那一份被换掉、任务表留着时，不自动再起一轮", async () => {
    /*
     * 上一条钉住的是「两样都留着」。这一条摆的是**只留一半**那种组合 —— 它是 ISS-222
     * 真正掉进去的那个坑，也是这条路上最后一道闩：那一轮的报告写在够不着的地方，这一份
     * 库唯一诚实的答案是「这一轮没成」，而不是当场再烧十几分钟。
     *
     * 摘钉子的写法就是 `lib/dev-pin.ts` 文件尾那段说的：那张表是明写出来的，为的就是
     * 让这种组合摆得出来。
     */
    const before = calls();
    const one = (await import("./store")).api;
    // 预载案例里的一条（`seed-cases.ts`），所以下一程的库里也有它。
    const id = "ISS-203";
    await one.getResearchDoc(id);
    await settle(one, id);
    expect(calls()).toBe(before + 1);

    const pins = (
      globalThis as { __tkosDevPins?: Map<string, unknown> }
    ).__tkosDevPins;
    if (!pins) throw new Error("钉子表不在 —— TKOS_DEV_PIN 没生效");
    pins.delete("store");
    vi.resetModules();
    const two = (await import("./store")).api;

    // 这一份库里确实没有那份报告（它写在被换掉的那一份上）。
    expect(await two.getResearchDoc(id)).toBeNull();
    // 屏幕上照实说这一轮没成，而不是转一个永远不会停的圈。
    expect((await two.deepResearchStatus(id)).status).toBe("failed");
    // 最要紧的那一句：**没有第二轮**。原来这里是 before + 2。
    await new Promise((r) => setTimeout(r, 60));
    expect(calls()).toBe(before + 1);
  });
});
