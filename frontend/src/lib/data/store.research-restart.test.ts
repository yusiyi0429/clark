/**
 * **改一个服务端文件不许把正在跑的那一轮深研吃掉。**
 *
 * 2026-08-26 的 ISS-110：四条链路都跑完了，Claude 那一份一万六千字符、带可拖的参数块。
 * 然后 `next dev` 重编译一次（改了一个服务端文件），任务表随之清空 —— 那几份原件只活在
 * 那张表上，于是全没了；更贵的是下一次轮询看到「任务表里什么都没有」，当成「没人跑过」，
 * 又起了一轮真花钱的深研。屏幕上没有任何地方说得出上一轮去哪了。
 *
 * 所以这一条跨**一次真实重启**钉三头：
 *   1. 链路写完一份就落一份 —— 第二程从快照起来还读得到那两份原件（`listReports`）。
 *   2. 那一轮算**没跑成**，而且原话说的是「重启把它掐断了」，不是编一个模型报错。
 *   3. **不许自动重开**：第二程里读议题（`getResearchDoc` 会叫 `ensureDeepResearch`）
 *      一次也不许再叫 A4 —— 那道闩原来只在进程里的任务表上，所以重启等于把它打开了。
 *
 * 单独一个文件、真落盘，理由同 `persist.restart.test.ts`：`persist.ts` 在模块加载时就把
 * `TKOS_DATA_DIR` 读成常量，每一程都要先设环境变量再 `vi.resetModules()`。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { DraftReport } from "./types";

// 这台机器上可能导出着真 key。单测不许把钱花出去，也不许出网。
process.env.TKOS_MODEL_MOCK = "1";

// 夹具要跟着 vi.mock 一起提到 import 之前 —— 工厂函数是被 hoist 的。而它挂在测试文件的
// 作用域上，`vi.resetModules()` 不动它，所以那个调用计数跨两程还是同一个。
const { fixture } = vi.hoisted(() => ({
  fixture: {
    /** A4 被真叫过几次。第二程里这个数**必须不动**。 */
    calls: 0,
    drafts: [
      {
        key: "agent",
        label: "ChatGPT",
        modelAlias: "gpt-5.6",
        byAgentLabel: "您的 Agent",
        kind: "writer",
        text: "## 判断\n先说结论：不是系统选型问题。",
        durationMs: 510_000,
      },
      {
        key: "agent:alt1",
        label: "Claude",
        modelAlias: "claude-opus-5",
        byAgentLabel: "您的 Agent",
        kind: "writer",
        text: "## 判断\n瓶颈正在换层：从能不能做，到能不能把它组织起来。",
        durationMs: 980_000,
      },
    ] as DraftReport[],
  },
}));

/**
 * 假 A4：把两份写完的原件上报到任务表上，然后**永远不收场**。
 *
 * 这就是进程被掐断那一刻的样子 —— 不是抛异常（那条路 `store.research-salvage.test.ts`
 * 已经钉过了），而是这一轮既没成功也没失败，而承载它的进程没了。
 */
vi.mock("@/lib/agent/a4/run", () => ({
  runDeepResearch: async (input: { issueId: string }): Promise<never> => {
    fixture.calls += 1;
    const { taskReports } = await import("@/lib/agent/tasks");
    taskReports("deep", input.issueId, fixture.drafts);
    await new Promise(() => {});
    throw new Error("到不了这里");
  },
}));

let dir = "";

describe("跨一次重启：正在跑的那一轮深研", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tkos-a4-restart-"));
    process.env.TKOS_DATA_DIR = dir;
    // 这个文件要的就是真落盘 —— 别的测试文件设的 TKOS_PERSIST=0 会让这一整条失去意义。
    delete process.env.TKOS_PERSIST;
    delete process.env.TKOS_SEED_FROZEN;
    fixture.calls = 0;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TKOS_DATA_DIR;
  });

  it("写完的原件还在、这一轮算没跑成、而且不许自己重开一轮", async () => {
    // ── 第一程：起一轮，两份原件上报，进程在这儿没了 ──────────────────────
    vi.resetModules();
    const first = await import("./store");
    const issue = await first.api.addIssue("AI 转型：ERP 中台化的根因在哪一层");
    await first.api.startDeepResearch(issue.id);

    /*
     * 等那两份原件真的上报了。轮询而不是定长 sleep：慢一点的机器上定长会假失败。
     *
     * 上报到了就等于落库到了 —— 抄进库那一下（`keepFinishedReport`）和上报是同一个调用栈，
     * 不隔异步。所以这里看得见两栏正文，快照里就已经有那两份。
     */
    for (let i = 0; i < 100; i += 1) {
      const live = await first.api.listReports(issue.id);
      if (live.filter((r) => r.source?.text).length === 2) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    expect(fixture.calls).toBe(1);
    expect((await first.api.deepResearchStatus(issue.id)).status).toBe("running");
    (await import("./persist")).flushNow();

    // ── 第二程：同一个 TKOS_DATA_DIR，从刚落下的那份快照起来 ────────────────
    vi.resetModules();
    const { api } = await import("./store");

    // 1. 那两份原件读得到 —— 花过的钱还在。
    const list = await api.listReports(issue.id);
    expect(list.map((r) => r.key)).toEqual(["agent", "agent:alt1"]);
    expect(list[1].source?.text).toContain("瓶颈正在换层");
    expect(list[1].source?.durationMs).toBe(980_000);

    // 2. 这一轮算没跑成，而那句原话说的是真事：是重启把它掐断的。
    const st = await api.deepResearchStatus(issue.id);
    expect(st.status).toBe("failed");
    expect(st.error).toContain("服务重启");
    expect(list[0].source?.unfinished?.error).toContain("服务重启");
    // 半份东西不许进 `researchDocs` —— 那一处是四个地方判「深研已就绪」的同一个开关。
    expect(await api.getResearchDoc(issue.id)).toBeNull();
    expect((await api.getBoard(issue.id)).reportsKept).toBe(2);

    /*
     * 3. 上面那几次读全都路过 `ensureDeepResearch`（`getResearchDoc` 直接叫它）。
     * 一次也没有再叫 A4 —— ISS-110 就是在这一步被自动重开的。
     */
    expect(fixture.calls).toBe(1);
  });
});
