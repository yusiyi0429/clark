// 必须在 import 之前设置（同 store.a5-once.test.ts）：不设 TKOS_PERSIST=0，
// store.ts 模块求值期会读开发机上 .data/store.json 里的真实数据。
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

/**
 * 一轮深研挂在后半段时，**已经写出来的报告原件要留住**。
 *
 * 这一条钉的是一次真花钱的损失。2026-08-26 的 ISS-111：四条链路的报告全跑出来了（十八
 * 分钟真钱），整轮挂在最后那一步「压成四节」上。那一版的后果是四份报告一起消失 ——
 * 原件只活在任务表里（`Harness.reports`），而任务翻成 `failed` 时那张表连着进度稿一起
 * 重建（见 `runTask`），进程一重启更是什么都不剩。屏幕上于是说「没有报告可读」，而那
 * 四份报告是真写出来了的。
 *
 * 三头都要断言，缺一头都还是坏的：
 *   1. 原件在库里、能读（`listReports`），而且带着 `unfinished` —— 少了那个标记，一份
 *      没有四节压缩、没有溯源的原文会被当成一份正常报告读。
 *   2. 这一轮仍然算**没跑成**：`deepResearchStatus` 还是 `failed`（不自动重试）、
 *      `getResearchDoc` 还是 null（半份文档进 `researchDocs` 会让四处都说深研就绪了）。
 *   3. 判断板知道留下了几份（`reportsKept`）—— 那句「没有报告可读」按它改口。
 *
 * A4 换成假货：真跑一轮要联网、要十几分钟、要花钱，而「先把几条链路跑完、再挂在后半段」
 * 这个入口条件在真模型下是不定的。假货干的就是那件事 —— 上报几份写完的原件，然后抛。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { api as Api } from "./store";
import type { DraftReport } from "./types";

// 夹具要跟着 vi.mock 一起提到 import 之前 —— 工厂函数是被 hoist 的。
const { fixture } = vi.hoisted(() => ({
  fixture: {
    boom: "模型输出被 max_tokens(6000) 截断。",
    /** 拦一轮在「上报原件」之前 —— 最后那个用例要在这一轮还没写出任何东西时看一眼库。 */
    gate: null as Promise<void> | null,
    // 两份写完的 + 一份自己挂了的。挂掉那一条不该被留下来（没有正文可读）。
    drafts: [
      {
        key: "agent:alt0",
        label: "DeepSeek",
        modelAlias: "deepseek-v4-pro",
        byAgentLabel: "您的 Agent",
        kind: "writer",
        text: "## 判断\nERP 中台化的根因在预算口径。",
        durationMs: 420_000,
      },
      {
        key: "agent:alt1",
        label: "Claude",
        modelAlias: "claude-opus-5",
        byAgentLabel: "您的 Agent",
        kind: "writer",
        note: "这一条没跑成",
        error: "上游 429",
        startedAt: "2026-08-26T03:06:30.000Z",
      },
      {
        key: "agent",
        label: "ChatGPT",
        modelAlias: "gpt-5.6",
        byAgentLabel: "您的 Agent",
        kind: "writer",
        text: "## 判断\n先说结论：不是系统选型问题。",
        durationMs: 510_000,
      },
    ] as DraftReport[],
  },
}));

vi.mock("@/lib/agent/a4/run", () => ({
  runDeepResearch: async (input: { issueId: string }): Promise<never> => {
    const { taskReports } = await import("@/lib/agent/tasks");
    if (fixture.gate) await fixture.gate;
    // 链路跑完的样子：几份原件已经上报到任务表上（页签行就是从这里读的）。
    taskReports("deep", input.issueId, fixture.drafts);
    // 然后死在后半段 —— 抛的是 `Error` 而不是 `AgentRunFailed`，和 ISS-111 那次一样。
    throw new Error(fixture.boom);
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

/** 起一轮必然挂在后半段的深研，返回议题号。 */
const failedRound = async (title: string): Promise<string> => {
  const issue = await api.addIssue(title);
  await api.startDeepResearch(issue.id);
  expect((await settle(issue.id)).status).toBe("failed");
  return issue.id;
};

describe("深研挂在后半段：跑成了的报告原件留下来", () => {
  it("原件能读，而且标着「这一轮没跑完」", async () => {
    const id = await failedRound("AI 转型：ERP 中台化的根因在哪一层");

    const list = await api.listReports(id);
    /*
     * 只有写完的那两份。挂掉的那一条不留 —— 它没有正文，留着等于在页签行上摆一栏
     * 永远打不开的东西，而这一轮已经不会再有人去跑它了。
     */
    expect(list.map((r) => r.key)).toEqual(["agent:alt0", "agent"]);
    expect(list[1].source?.text).toContain("不是系统选型问题");
    expect(list[1].source?.durationMs).toBe(510_000);
    // 那个标记，以及挂掉那句原话（屏幕上照实带出去，和运营台那条记录上是同一句）。
    expect(list[0].source?.unfinished?.error).toBe(fixture.boom);
    expect(list[0].source?.unfinished?.at).toBeTruthy();
    expect(list[1].source?.unfinished?.error).toBe(fixture.boom);
  });

  it("这一轮仍然算没跑成 —— 不许因为留了原件就说深研就绪", async () => {
    const id = await failedRound("AI 转型：预算口径要不要按域重切");

    // 报告页那一栏、首页那一栏、判断板起不起，全按这两个判据走。
    expect(await api.getResearchDoc(id)).toBeNull();
    const st = await api.deepResearchStatus(id);
    expect(st.status).toBe("failed");
    expect(st.error).toBe(fixture.boom);
    // 议题那一行也不许还在呼吸：没有任何人在跑。
    const mine = (await api.listIssues()).find((i) => i.id === id);
    expect(mine?.research).toEqual({ state: "idle" });
  });

  it("判断板知道留下了几份 —— 那句「没有报告可读」按这个数改口", async () => {
    const id = await failedRound("AI 转型：中台这件事的承接人是谁");

    const board = await api.getBoard(id);
    expect(board.reportsKept).toBe(2);
    // 板上一条判断都没有，而且仍旧是「在等报告」那一档（`pending === null`）——
    // 参谋没有东西可读，这一点没变。
    expect(board.draft).toEqual([]);
    expect(board.confirmed).toEqual([]);
    expect(board.pending).toBeNull();
  });

  it("他再开一轮，上一轮那几份就作废 —— 报告页不许摆着两轮的东西", async () => {
    const id = await failedRound("AI 转型：要不要先停掉一半在建的接口");
    expect((await api.getBoard(id)).reportsKept).toBe(2);

    /*
     * 再开一轮，并且把这一轮拦在「上报原件」之前 —— 这正是最难看的那一刻：新的一轮
     * 在跑，而库里还留着上一轮的原件和上一轮那句失败原话，屏幕上没有任何地方说得清
     * 摆出来的是哪一轮的东西。所以那几份必须在开跑那一下就清掉。
     */
    let open!: () => void;
    fixture.gate = new Promise<void>((r) => (open = r));
    await api.startDeepResearch(id);

    const board = await api.getBoard(id);
    expect(board.reportsKept).toBeUndefined();
    expect((await api.listReports(id)).some((r) => r.key.startsWith("agent"))).toBe(false);

    // 放这一轮走完，它自己那两份照样留下来。
    open();
    fixture.gate = null;
    expect((await settle(id)).status).toBe("failed");
    expect((await api.getBoard(id)).reportsKept).toBe(2);
  });
});
