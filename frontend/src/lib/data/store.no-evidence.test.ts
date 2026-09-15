// 必须在 import 之前设置（同 store.research-salvage.test.ts）：不设 TKOS_PERSIST=0，
// store.ts 模块求值期会读开发机上 .data/store.json 里的真实数据。
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

/**
 * 一轮**一条外部证据都没入账**的深研，屏幕上要照实说。
 *
 * 这一条钉的是 2026-08-26 那一轮：两家检索一家 403、一家免费额度用尽，二十条检索式条条
 * 报错，一份外部证据都没入账 —— 而这一轮的产出是一份格式漂亮的报告，运行记录写着 ok，
 * 事件标题写着「深度研究完成 · 报告已装配」，明细还是折起来的。「入账 0 条」这五个字确实
 * 写在里面，也确实要展开才看得见，于是唯一发现这件事的方式是翻到运营台去读 trace。
 *
 * 两头都要断言，缺一头这件事仍然是藏着的：
 *   1. 那句声明跟着报告落库（`getResearchDoc`）—— 报告页那一屏是他真正读这一份的地方。
 *   2. 时间线那条事件**标题就改口**、而且默认展开 —— 折起来的明细等于没写。
 *
 * A4 换成假货：真跑一轮要联网、要花钱，而「两家全挂、照样出一份报告」这个入口条件在真
 * 模型下根本约不出来。假货干的就是那一件事。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { api as Api } from "./store";
import type { AgentRunRecord, ResearchDoc } from "./types";

const { fixture } = vi.hoisted(() => {
  /** 那一轮的真实形状：20 条检索式 × 2 家 = 40 次尝试，40 条报错，0 条入账。 */
  const searchErrors = Array.from({ length: 40 }, (_, i) =>
    i % 2
      ? "「ERP 中台化 预算口径」· 豆包搜索：豆包搜索失败 code=10406: Free quota has been exhausted.；每月免费额度已用尽"
      : "「ERP 中台化 预算口径」· 博查：检索接口返回 HTTP 403：{\"code\":403,\"msg\":\"账户余额不足\"}"
  );
  const hitsByProvider = {
    bocha: { label: "博查", returned: 0, unique: 0 },
    doubao: { label: "豆包搜索", returned: 0, unique: 0 },
  };
  return {
    fixture: {
      searchErrors,
      hitsByProvider,
      /** 入账几条。用例里改它 —— 这一条口径的分界就在这个数上。 */
      recorded: 0,
    },
  };
});

vi.mock("@/lib/agent/a4/run", () => ({
  runDeepResearch: async (input: { issueId: string; title: string }) => {
    const { noExternalEvidence } = await import("@/lib/agent/a4/no-evidence");
    const rounds = [
      {
        no: 1,
        propositionIds: ["P1", "P2", "P3", "P4"],
        queries: 20,
        counterQueries: 6,
        hits: 0,
        hitsByProvider: fixture.hitsByProvider,
        fetched: 0,
        fetchFailed: 0,
        recorded: fixture.recorded,
        rejected: 0,
        searchErrors: fixture.recorded ? [] : fixture.searchErrors,
      },
    ];
    const noEv = noExternalEvidence({
      providerLabel: "博查 + 豆包搜索",
      propositions: 4,
      recorded: fixture.recorded,
      rounds,
    });
    const doc: ResearchDoc = {
      issueId: input.issueId,
      judgment: [{ text: "不是系统选型问题，卡在预算口径。", traces: [] }],
      keyEvidence: [{ text: "四个域的口径各自独立。", traces: [] }],
      counters: [{ text: "也可能只是这一期排期紧。", traces: [] }],
      unknowns: [{ text: "外部同行怎么切，本轮没能核。", traces: [] }],
      routeSuggestion: "进议题研究",
      byAgentLabel: "您的 Agent",
      assembledFrom: [{ label: "外部检索 · 博查 + 豆包搜索（1 轮，入账 0 条证据）" }],
      sourceText: "## 判断\n先说结论：不是系统选型问题。本轮未联网核验。",
      sourceLabel: "ChatGPT",
      ...(noEv ? { noExternalEvidence: noEv } : {}),
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
      ...(noEv ? { noExternalEvidence: noEv.headline } : {}),
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
      createdAt: "2026-08-26T04:23:00.000Z",
      finishedAt: "2026-08-26T04:41:00.000Z",
      latencyMs: 1_080_000,
    } as unknown as AgentRunRecord;
    return {
      doc,
      violations: [],
      attempts: 1,
      degraded: false,
      challengeCount: 0,
      challenged: false,
      evidencing: {
        provider: "bocha+doubao",
        providerLabel: "博查 + 豆包搜索",
        hitsByProvider: fixture.hitsByProvider,
        propositions: 4,
        rounds,
        recorded: fixture.recorded,
        rejected: 0,
        unresolved: fixture.recorded ? [] : ["P1", "P2", "P3", "P4"],
        calculations: [],
        citationsBound: 0,
        reportAttempts: 1,
        lanes: [
          {
            label: "ChatGPT",
            modelAlias: "gpt-5.6",
            primary: true,
            propositions: 4,
            rounds: 1,
            recorded: fixture.recorded,
            rejected: 0,
            unresolved: [],
            attempts: 1,
            blocked: 0,
            durationMs: 1_020_000,
          },
        ],
      },
      run,
    };
  },
}));

let api: typeof Api;

beforeAll(async () => {
  api = (await import("./store")).api;
});

/** 等那一轮落定。轮询而不是定长 sleep：慢一点的机器上定长会假失败。 */
const settle = async (issueId: string) => {
  for (let i = 0; i < 100; i += 1) {
    const st = await api.deepResearchStatus(issueId);
    if (st.status !== "running") return st;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("那一轮两秒还没落定 —— 假 A4 下不该发生");
};

const round = async (title: string): Promise<string> => {
  const issue = await api.addIssue(title);
  await api.startDeepResearch(issue.id);
  expect((await settle(issue.id)).status).toBe("done");
  return issue.id;
};

describe("一条外部证据都没入账的那一轮", () => {
  it("声明跟着报告落库 —— 报告页那一屏就说得出来", async () => {
    fixture.recorded = 0;
    const id = await round("AI 转型：ERP 中台化的根因在哪一层");

    const doc = await api.getResearchDoc(id);
    expect(doc?.noExternalEvidence?.headline).toContain("没有外部证据");
    // 空在哪一格、以及厂商原话 —— 「检索失败了」答不出该去充值、换 key 还是改问法。
    expect(doc?.noExternalEvidence?.why).toContain("每一条都失败");
    expect(doc?.noExternalEvidence?.why).toContain("10406");
    expect(doc?.noExternalEvidence?.why).toContain("403");
  });

  it("时间线那条事件标题就改口，而且默认展开", async () => {
    fixture.recorded = 0;
    const id = await round("AI 转型：预算口径要不要按域重切");

    const ev = (await api.getTimeline(id)).find((e) => e.id === `E-${id}-deep-done`);
    /*
     * 标题必须变。原来两种运行下这一行一模一样（「深度研究完成 · 报告已装配」），而
     * 时间线上他扫的就是这一行 —— 明细里那句「入账 0 条」要展开才看得见。
     */
    expect(ev?.headline).toContain("没有外部证据");
    expect(ev?.defaultOpen).toBe(true);
    expect(ev?.detail).toContain("每一条都失败");
    // 「几轮成文、质量门全过」这两句在这一种运行下也是真的，所以不许摆在声明前面。
    expect(ev?.detail?.indexOf("没有外部证据")).toBeLessThan(ev?.detail?.indexOf("质量门") ?? -1);
  });

  it("入账过证据的那一轮一个字都不变", async () => {
    // 这句声明贬值之后，真空手的那一轮就没人看了。
    fixture.recorded = 6;
    const id = await round("AI 转型：中台这件事的承接人是谁");

    expect((await api.getResearchDoc(id))?.noExternalEvidence).toBeUndefined();
    const ev = (await api.getTimeline(id)).find((e) => e.id === `E-${id}-deep-done`);
    expect(ev?.headline).toBe("深度研究完成 · 报告已装配");
    expect(ev?.defaultOpen).toBe(false);
    expect(ev?.detail).toContain("入账 6 条证据");
  });
});
