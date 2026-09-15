// 必须在 import 之前设置（同 store.judgements.test.ts）：不设 TKOS_PERSIST=0，
// store.ts 模块求值期会读开发机上 .data/store.json 里的真实数据。
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

/**
 * 一份深研报告只读一遍。**读完之后一条都没落住，也算读过了。**
 *
 * 这一条钉的是一次真花钱的坏法。判断板是被轮询的，而「库改过了」那条线（`revision.ts`）
 * 会让每一次落库都再催一轮读板 —— 于是 `ensureJudgements` 判「要不要起 A5」的那个判据
 * 是被每秒钟问一遍的东西。原来那个判据是「板上有没有 research 来源的条目」，也就是
 * **A5 有没有落住东西**；而 A5 跑成功、一条都没上板是一个真实存在的结果（模型一条都
 * 没交，或者交的几条全被板上的去重挡下）。两件事混成一件的后果：那一轮跑完 → 板上还是
 * 空的 → 下一次读板又起一轮 → 落库又催一轮读板，同一份报告被反复读，一轮一笔真实的
 * 模型账。2026-08-20 实跑时它在日志里刷了三十来遍。
 *
 * 所以这里把 A5 那一轮换成「跑得通、但一条都不交」的假货：这正是那个死循环的入口条件，
 * 而真模型给不给东西是不定的，拿真模型测不到这个入口。
 *
 * 两头都要断言，缺一头都还是坏的：
 *   1. 读几次板，A5 只起一轮 —— 不再烧钱。
 *   2. 那之后板上的 `pending` 是 `read-nothing`，不是 "running" —— 光修第 1 条的话，
 *      屏幕上那个圈会一直转，而它等的那一轮永远不会再起（`judgementsPending`）。
 *      也不许是 null：那一档屏幕上说的是「深研报告还没到」，而报告就在库里。
 *
 * 报告直接摆进库（`__seedResearchedIssueForTest`）：这一层测的是「有报告之后」的分支，
 * 而写出一份报告要真跑一轮 A4 —— 单测里一次模型调用都不许打。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { api as Api, __seedResearchedIssueForTest as SeedResearched } from "./store";
import type { AgentRunRecord, ResearchDoc } from "./types";

// 计数器要跟着 vi.mock 一起提到 import 之前 —— 工厂函数是被 hoist 的。
const { a5Calls } = vi.hoisted(() => ({ a5Calls: { n: 0 } }));

vi.mock("@/lib/agent/a5/run", () => ({
  runJudgements: async () => {
    a5Calls.n += 1;
    return {
      // 一条都不交。整形后为空、全被去重挡下，在调用方那一侧是同一个样子。
      judgements: [],
      violations: [],
      attempts: 1,
      degraded: false,
      run: {
        id: `RUN-a5-once-${a5Calls.n}`,
        agent: "A5",
        status: "ok",
        usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
        createdAt: "2026-08-20T00:00:00.000Z",
        finishedAt: "2026-08-20T00:00:01.000Z",
        latencyMs: 1,
      } as AgentRunRecord,
    };
  },
}));

let api: typeof Api;
let seedResearched: typeof SeedResearched;

beforeAll(async () => {
  const mod = await import("./store");
  api = mod.api;
  seedResearched = mod.__seedResearchedIssueForTest;
});

/** 等那一轮 A5 落地。轮询而不是定长 sleep：慢一点的机器上定长会假失败。 */
const settle = async (issueId: string): Promise<void> => {
  for (let i = 0; i < 100; i += 1) {
    if ((await api.judgementsStatus(issueId)).status !== "running") return;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("A5 那一轮 2 秒都没落地");
};

/** 一件手上有深研报告的议题。报告写什么无关 —— 上面那个假 A5 根本不读它。 */
const researchedIssue = async (title: string): Promise<string> => {
  // addIssue 会顺手起一轮预研，那一轮在假模型下就地失败，与这几条断言无关。
  const issue = await api.addIssue(title);
  const doc: ResearchDoc = {
    issueId: issue.id,
    judgment: [{ text: "决策权已经移到业务线", traces: [] }],
    keyEvidence: [{ text: "两个已投标客户的决策人换了", traces: [] }],
    counters: [{ text: "样本只有两个客户", traces: [] }],
    unknowns: [{ text: "另外两个行业还没查", traces: [] }],
    routeSuggestion: "建议上会",
    byAgentLabel: "CEO Agent",
    assembledFrom: [],
    sourceText: "## 核心判断\n\n决策权已经移到业务线。",
    at: "2026-08-25T02:00:00.000Z",
  };
  seedResearched(issue.id, doc, {
    text: "定价改按用量吗",
    suggestedDri: "白田田",
    deadline: "48小时",
  });
  return issue.id;
};

describe("一份深研报告只读一遍", () => {
  it("A5 跑完一条都没上板：再读几次板不会再起一轮，板也不说自己正在读", async () => {
    const issueId = await researchedIssue("要不要把定价从按座位改成按用量");
    // 报告摆进库之后第一次读板起第一轮（产品里那一轮由深研落库时叫起，
    // 进程重启后也靠读板自愈 —— 同一个 `ensureJudgements`）。
    await api.getBoard(issueId);
    await settle(issueId);

    expect(a5Calls.n).toBe(1);
    // 前提条件成立：那一轮是成功的，板上确实一条都没有。
    expect((await api.judgementsStatus(issueId)).status).toBe("done");
    const first = await api.getBoard(issueId);
    expect(first.draft.filter((x) => x.origin === "research")).toEqual([]);

    // 轮询/推送催出来的重复读板。坏的时候这里每一次都是一轮真实的模型调用。
    await api.getBoard(issueId);
    await api.getBoard(issueId);
    await settle(issueId);
    expect(a5Calls.n).toBe(1);

    /*
     * "running" 是许下一个不会到来的承诺 —— 不会再有下一轮了；null 那一档屏幕上说的
     * 是「深研报告还没到」，而报告就在库里躺着。这一档是它自己一档。
     */
    expect((await api.getBoard(issueId)).pending).toBe("read-nothing");
  });
});
