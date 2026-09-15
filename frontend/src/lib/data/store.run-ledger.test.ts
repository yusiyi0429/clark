// 必须在 import 之前设置（同 store.research-salvage.test.ts）：不设 TKOS_PERSIST=0，
// store.ts 模块求值期会读开发机上 .data/store.json 里的真实数据，而下面这几条会往里写。
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

/**
 * 运营台上那条运行记录**从开跑那一刻就有**，不是跑完才有。
 *
 * 这一条钉的是一次查不出来的损失。2026-08-25 那天的 Bedrock 账单上有一笔 57 万输入
 * token 的深研，而运营台上一条记录都没有：那一轮跑到中途进程就没了（改代码触发热重载），
 * 而 `agentRunPut` 只在链路**跑完**之后叫一次。于是钱花掉了、屏幕上那件议题一直写着
 * 「深度研究进行中」、而「今天跑了几轮、哪几轮白烧了」这个问题只能靠翻云上的账单反推。
 *
 * 抛的是 `Error` 而不是 `AgentRunFailed` —— 后半段挂掉那一类（ISS-111 那次就是）在原来
 * 那一版里同样什么记录都不留：`if (e instanceof AgentRunFailed)` 一句挡掉了它。
 *
 * A4 换成假货，理由同 `store.research-salvage.test.ts`：真跑一轮要联网、十几分钟、花钱。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { api as Api, markInterruptedRuns as MarkInterruptedRuns } from "./store";

// 夹具要跟着 vi.mock 一起提到 import 之前 —— 工厂函数是被 hoist 的。
const { fixture } = vi.hoisted(() => ({
  fixture: {
    boom: "模型输出被 max_tokens(6000) 截断。",
    /** 拦一轮在中途 —— 前两个用例要在这一轮还没落定时看一眼台账。 */
    gate: null as Promise<void> | null,
  },
}));

vi.mock("@/lib/agent/a4/run", () => ({
  runDeepResearch: async (): Promise<never> => {
    if (fixture.gate) await fixture.gate;
    // 真跑一轮是十几分钟。这里只要**花掉一点时间**，好让「跑了多久」是个正数 ——
    // 立刻就抛的话那个数会落在同一毫秒里，而记录上写 0 毫秒看不出是没记还是真的快。
    await new Promise((r) => setTimeout(r, 5));
    throw new Error(fixture.boom);
  },
}));

let api: typeof Api;
let markInterruptedRuns: typeof MarkInterruptedRuns;

beforeAll(async () => {
  const m = await import("./store");
  api = m.api;
  markInterruptedRuns = m.markInterruptedRuns;
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

/** 台账上属于这件议题的那几条。按 `input` 认 —— A4 落的 `input` 就是议题标题。 */
const ledger = async (title: string) =>
  (await api.listAgentRuns("A4")).filter((r) => r.input === title);

/** 起一轮并拦在中途，返回议题号和放行的那个开关。 */
const gatedRound = async (title: string) => {
  let open!: () => void;
  fixture.gate = new Promise<void>((r) => (open = r));
  const issue = await api.addIssue(title);
  await api.startDeepResearch(issue.id);
  return {
    id: issue.id,
    release: async () => {
      open();
      fixture.gate = null;
      await settle(issue.id);
    },
  };
};

describe("运行台账：开跑就记一条", () => {
  it("这一轮还在跑，台账上已经有它了", async () => {
    const title = "AI 转型：算力中心的核心差异化在哪一层";
    const round = await gatedRound(title);

    const mine = await ledger(title);
    expect(mine.length).toBe(1);
    expect(mine[0].status).toBe("running");
    expect(mine[0].createdAt).toBeTruthy();
    // 还没跑完，所以收尾那两个字段必须是空的 —— 填一个假时刻等于台账上写着它跑完了。
    expect(mine[0].finishedAt).toBe("");
    expect(mine[0].latencyMs).toBe(0);

    await round.release();
  });

  it("跑完把开跑那条换掉，不留两条", async () => {
    const title = "AI 转型：预算口径要不要按域重切";
    const issue = await api.addIssue(title);
    await api.startDeepResearch(issue.id);
    expect((await settle(issue.id)).status).toBe("failed");

    const mine = await ledger(title);
    expect(mine.length).toBe(1);
    // 挂在后半段、抛的是普通 `Error` —— 这一类原来在台账上一条都不留。
    expect(mine[0].status).toBe("failed");
    expect(mine[0].error).toBe(fixture.boom);
    expect(mine[0].finishedAt).toBeTruthy();
    expect(mine[0].latencyMs).toBeGreaterThan(0);
  });

  it("进程被掐断：还停在「在跑」的那几条标成中断，再扫一遍不重复标", async () => {
    const title = "AI 转型：中台这件事的承接人是谁";
    const round = await gatedRound(title);

    /*
     * 进程没了的那一刻 —— 下一个进程起来时扫这一遍。
     *
     * 数的是**这一轮那条**，不是全表：建议题那一下顺带起了一轮预研（`ensurePreResearch`），
     * 它此刻也在跑，而这条用例要证的事跟那一轮无关。
     */
    expect(markInterruptedRuns()).toBeGreaterThanOrEqual(1);
    const mine = await ledger(title);
    expect(mine.length).toBe(1);
    expect(mine[0].status).toBe("interrupted");
    expect(mine[0].error).toContain("重启");
    expect(mine[0].finishedAt).toBeTruthy();

    // 第二遍不许再动它：动了的话每次启动都把同一条的收尾时刻往后推一次，而那个时刻
    // 是用来算「这一轮跑了多久才断」的。
    markInterruptedRuns();
    expect((await ledger(title))[0].finishedAt).toBe(mine[0].finishedAt);

    await round.release();
  });
});
