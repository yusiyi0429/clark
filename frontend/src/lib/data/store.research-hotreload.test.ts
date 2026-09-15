// 必须在 import 之前设置（同 store.research-salvage.test.ts）：不设 TKOS_PERSIST=0，
// store.ts 模块求值期会读开发机上 .data/store.json 里的真实数据。
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

/**
 * **一次热重载不许换来一轮新的深研。**
 *
 * 2026-08-27 的 ISS-112：一轮跑了 47 分钟，快到出口对账时忽然从第一步重新开始，而且停不
 * 下来 —— 改一次代码就多一轮真花钱的深研。`store.research-restart.test.ts` 钉的是**整个
 * 进程换掉**那一种（那一路由恢复那一段兜）；这一条钉的是更难看的那一种：**库还是这一份，
 * 而跑那一轮的任务表被换掉了**。`next dev` 重编译可以只替掉一半模块图，那时候：
 *
 *   - 库里那条记录写着「在跑」，没有收场原话；
 *   - 这一份任务表里查不到它（那张表在进程里，跟着模块走）。
 *
 * 两句同时成立时，`ensureDeepResearch`（`getResearchDoc` 每次读都路过它）会读成「没人跑
 * 过」，于是又起一轮。所以 `deepRoundState` 要就地把它收场，并且**把那句话写进库** ——
 * 只在内存里翻一下的话，下一次轮询读到的还是「在跑」，而闩只认 `error`。
 *
 * 任务表用打桩换掉「查得到吗」这一句而不是真删（`clearTask` 拒绝删正在跑的那一条，那正是
 * 它该有的行为）—— 要模拟的本来也不是「谁把它删了」，是「问的不是同一张表」。
 */
import { beforeAll, describe, expect, it, vi } from "vitest";
import type { api as Api } from "./store";

const { fixture } = vi.hoisted(() => ({
  fixture: {
    /** A4 被真叫过几次。热重载之后这个数**必须不动**。 */
    calls: 0,
    /** 打开就等于「这一份任务表里查不到那一轮」。 */
    tableSwapped: false,
  },
}));

/** 假 A4：起来就挂着不收场 —— 进程还在跑，只是这一份表不认识它了。 */
vi.mock("@/lib/agent/a4/run", () => ({
  runDeepResearch: async (): Promise<never> => {
    fixture.calls += 1;
    await new Promise(() => {});
    throw new Error("到不了这里");
  },
}));

vi.mock("@/lib/agent/tasks", async () => {
  const actual = await vi.importActual<typeof import("@/lib/agent/tasks")>("@/lib/agent/tasks");
  return {
    ...actual,
    taskState: (kind: string, id: string) =>
      fixture.tableSwapped && kind === "deep" ? { status: "idle" as const } : actual.taskState(kind, id),
  };
});

let api: typeof Api;

beforeAll(async () => {
  api = (await import("./store")).api;
});

describe("热重载把任务表换掉：库还在，那一轮不许自己重开", () => {
  it("就地收场、原话写进库、而且读多少次都不再叫一次 A4", async () => {
    const issue = await api.addIssue("AI 转型：ERP 中台化的根因在哪一层");
    await api.startDeepResearch(issue.id);
    expect(fixture.calls).toBe(1);
    expect((await api.deepResearchStatus(issue.id)).status).toBe("running");

    // ── 重编译：库是同一份，任务表换了一张 ────────────────────────────────
    fixture.tableSwapped = true;

    const st = await api.deepResearchStatus(issue.id);
    expect(st.status).toBe("failed");
    // 那句原话说的是真事：换掉的是任务表，而这一份进程答不出它后来怎么样了。
    expect(st.error).toContain("任务表");
    // 原来这里钉的是「打回重研」—— 而屏幕上从来没有过这颗键，那句话是在指一个不存在的
    // 出口。删掉之后改钉活下来的那个事实：写完的原件没丢。
    expect(st.error).toContain("原件照旧能读");
    expect(st.error).not.toContain("打回重研");

    // 半份东西不许进 `researchDocs` —— 那一处是四个地方判「深研已就绪」的同一个开关。
    expect(await api.getResearchDoc(issue.id)).toBeNull();

    /*
     * 上面这几次读全都路过 `ensureDeepResearch`。再多读几次 ——ISS-112 的样子正是「每次
     * 轮询多一轮」，所以这里要的是**次数不动**，不是「第一次没重开」。
     */
    for (let i = 0; i < 5; i += 1) {
      await api.getResearchDoc(issue.id);
      await api.deepResearchStatus(issue.id);
      await api.listIssues();
    }
    expect(fixture.calls).toBe(1);

    // 收场那一下只发生一次：第二次读不许把断掉的时刻往后推（那个时刻是「跑了多久才断的」）。
    const again = await api.deepResearchStatus(issue.id);
    expect(again.finishedAt).toBe(st.finishedAt);
    expect(again.error).toBe(st.error);
  });

  it("库里没有那一轮时照旧起得来 —— 闩只拦「有记录但表里查不到」这一种", async () => {
    fixture.tableSwapped = false;
    const before = fixture.calls;
    const issue = await api.addIssue("AI 转型：预算口径要不要按域重切");
    await api.startDeepResearch(issue.id);
    expect(fixture.calls).toBe(before + 1);
    expect((await api.deepResearchStatus(issue.id)).status).toBe("running");
  });
});
