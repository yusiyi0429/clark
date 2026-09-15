// 必须在 import 之前设（同 `store.no-evidence.test.ts`）：不设 `TKOS_PERSIST=0`，
// store.ts 模块求值期会读开发机上 .data/store.json 里的真实数据。
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

/**
 * **一轮深研跑完，不许把一件还在提请台上的潜在议题推进战略议题栏。**
 *
 * 2026-08-30 撞出来的：`getResearchDoc` 不是纯读 —— 它会顺手起一轮深研（那是采信那一下
 * 该做的事，见 `disposeCard` 上那段注释）。而深研收尾那一句 `issue.state = "Exploring"`
 * 原来是无条件的。两件事叠在一起，一张还在提请台上的卡只要**有人开过它那一页**，报告一到
 * 就自己升成了战略议题 —— 一次「采信」都没按。
 *
 * 症状不是报错，是**同一件事同时在两处**：左上角那扇窗里还摆着它的卡（`listPending`），
 * 中间那一栏里又多出来一行。而首页那一屏的整个排布靠的正是「四种样子各占一个位置，同一件
 * 事不在两处出现」（见 `home-view` 的 `liveAll`）—— 这条一破，那一屏说的话就不再成立。
 *
 * 所以这个文件两头都钉，缺一头都测不出这件事：
 *   1. 报告**要落库**（那一轮真花了钱，产出不能丢），
 *   2. 而议题**还在 `Candidate`**、还在提请台上。
 *
 * 再加一条反向的：正常那条路（采信之后再跑完一轮）照旧要走到 `Exploring` —— 只拦不放的
 * 修法会把深研的收尾整个变成哑的，而那个坏法同样没有症状。
 *
 * A4 换成假货：真跑一轮要联网、要花钱，而这里要的只是「它成功收尾了」这一个入口条件。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";

import type { api as Api } from "./store";
import type { AgentRunRecord, ResearchDoc } from "./types";

/** 假 A4：立刻成功收尾，交一份最小但形状完整的报告。 */
vi.mock("@/lib/agent/a4/run", () => ({
  runDeepResearch: async (input: { issueId: string; title: string }) => {
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
      createdAt: "2026-08-30T10:00:00.000Z",
      finishedAt: "2026-08-30T10:01:00.000Z",
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
        provider: "none",
        providerLabel: "假 A4（单测）",
        hitsByProvider: {},
        propositions: 0,
        rounds: [],
        recorded: 0,
        rejected: 0,
        unresolved: [],
        calculations: [],
        citationsBound: 0,
        reportAttempts: 1,
        lanes: [],
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
  for (let i = 0; i < 200; i += 1) {
    if ((await api.deepResearchStatus(issueId)).status === "done") return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error(`${issueId} 那一轮深研没落定`);
};

describe("采信是那道门，而且是唯一那道", () => {
  it("开过潜在议题那一页、报告到了，它还在提请台上", async () => {
    // 预载案例里的一条潜在议题（`seed-cases.ts`）。它没有现成报告，所以这一读会真起一轮。
    // 原来用的是 ISS-201，那一件 2026-08-31 随 01 域一起去掉了。
    const id = "ISS-203";
    expect((await api.getIssue(id)).state).toBe("Candidate");

    // 这就是「他点进去看了一眼」。`getResearchDoc` 不是纯读 —— 它会起一轮。
    await api.getResearchDoc(id);
    await settle(id);

    // 1. 那一轮的产出留下了。它真花了钱，不能因为议题在哪一档就作废。
    const doc = await api.getResearchDoc(id);
    expect(doc?.sourceText).toContain("卡在口径上");

    // 2. 而这件事一步都没往前走：还是潜在议题，还摆在提请台上。
    const after = await api.getIssue(id);
    expect(after.state).toBe("Candidate");
    expect((await api.listPending()).map((c) => c.issueId)).toContain(id);

    /*
     * 3. 最要紧的那一条：它**不在**战略议题那一栏里。
     *
     * 这一句抄的是 `home-view` 的 `liveAll`（`isLiveIssue`）—— 那一栏的口径就是这一句，
     * 而这个 bug 唯一看得见的症状就是同一件事在这一栏和提请台上各出现一次。
     */
    const live = (await api.listIssues()).filter(
      (i) => i.state !== "Candidate" && !i.settled && !i.debrief,
    );
    expect(live.map((i) => i.id)).not.toContain(id);
  });

  it("采信过的那一件，报告到了照常走到 Exploring", async () => {
    /*
     * 反向那一条。没有它，「把收尾那一句整个拿掉」也能让上一条绿 —— 而那是把深研的收尾
     * 变成哑的：报告到了，首页那一栏上的这件事一动不动。
     */
    const issue = await api.addIssue("会前预审这条链路要不要自己带一版评分口径");
    const id = issue.id;
    expect(issue.state).toBe("Candidate");

    const card = (await api.listPending()).find((c) => c.issueId === id);
    if (!card) throw new Error("提请台上没找到刚立的那张卡");
    // 采信 —— 这一下就是那道门。它自己会把深研起起来（见 `disposeCard`）。
    await api.disposeCard(card.id, "discuss");
    await settle(id);

    const after = await api.getIssue(id);
    expect(after.state).toBe("Exploring");
    expect(after.nextActionForUser).toBe("深研报告已就绪");
  });
});
