import { describe, expect, it } from "vitest";

import {
  agentRunPut,
  api,
  contextSnapshotPut,
  MAX_AGENT_RUNS,
  markCardAgentVerdict,
} from "./store";
import type { AgentRunRecord } from "./types";

const rec = (id: string, agent: AgentRunRecord["agent"] = "A1a"): AgentRunRecord => ({
  id,
  agent,
  status: "ok",
  input: "X",
  output: {},
  contextMode: "anchored",
  trace: [],
  checks: [],
  checkSummary: { passed: 0, total: 0, allPassed: true, failed: [] },
  usage: { inputTokens: 1, outputTokens: 2, cachedInputTokens: 0, reasoningTokens: 0 },
  slot: "pro",
  modelAlias: "deepseek-pro",
  providerModelId: "ep-x",
  depth: "high",
  snapshotId: "ctx-x",
  contextRecipe: "S01",
  contextAnchor: "CARD-01",
  contextViewer: "PSN-01",
  contextAsOf: "2026-08-18",
  graphknowledgeBaseUrl: "https://example/graph",
  warnings: [],
  createdAt: "2026-08-18T00:00:00.000Z",
  finishedAt: "2026-08-18T00:00:01.000Z",
  latencyMs: 1000,
});

describe("agentRuns", () => {
  it("最新的排在最前，按 agent 过滤", async () => {
    agentRunPut(rec("RUN-a", "A3"));
    agentRunPut(rec("RUN-b", "A1a"));
    const all = await api.listAgentRuns();
    expect(all[0].id).toBe("RUN-b");
    /*
     * 断言「过滤出来的都是 A3，且我刚写的那条在里面」，**不断言只有这一条** ——
     * store 是持久化的（`.data/store.json`），本地跑过一次 dev 之后里面就有真实的
     * A3 记录。写成 `toEqual(["RUN-a"])` 的话，「在这台机器上跑过应用」本身会让
     * 测试变红，而那跟这条测试要证的事（按 agent 过滤）毫无关系。
     */
    const a3 = await api.listAgentRuns("A3");
    expect(a3.map((r) => r.id)).toContain("RUN-a");
    expect(a3.every((r) => r.agent === "A3")).toBe(true);
    expect((await api.getAgentRun("RUN-a"))?.agent).toBe("A3");
    expect(await api.getAgentRun("RUN-nope")).toBeNull();
  });

  it("超过上限就丢最老的 —— store.json 是整份重写的，不设上限它会一直长", async () => {
    for (let i = 0; i < MAX_AGENT_RUNS + 5; i += 1) agentRunPut(rec(`RUN-${i}`));
    const all = await api.listAgentRuns();
    expect(all.length).toBe(MAX_AGENT_RUNS);
    expect(all.some((r) => r.id === "RUN-0")).toBe(false);
  });

  /*
   * 快照上限（64）比 Run 上限（200）小，所以窗口里较老的锚定记录必然有一批取不回
   * 快照。这三种状态在屏幕上必须分得开：没有过 / 还在 / 曾经有但没了。少了第三种，
   * 「点进去报错」会被读成「坏了」。
   */
  it("取不回来的快照标出来，不和「从来没有过」混成一样", async () => {
    contextSnapshotPut("ctx-still-here", { renderedMarkdown: "x" });
    agentRunPut({ ...rec("RUN-live"), snapshotId: "ctx-still-here" });
    agentRunPut({ ...rec("RUN-gone"), snapshotId: "ctx-挤掉了" });
    // 纯外部路：空串，从来没有过快照 —— 这不是「取不回来」。
    agentRunPut({ ...rec("RUN-ext"), snapshotId: "", contextMode: "external_only" });

    expect((await api.getAgentRun("RUN-live"))?.snapshotEvicted).toBeUndefined();
    expect((await api.getAgentRun("RUN-gone"))?.snapshotEvicted).toBe(true);
    expect((await api.getAgentRun("RUN-ext"))?.snapshotEvicted).toBeUndefined();
    const listed = await api.listAgentRuns();
    expect(listed.find((r) => r.id === "RUN-gone")?.snapshotEvicted).toBe(true);
  });

  it("标注一条信号：卡照旧留在列表里，只是多了个标注", async () => {
    // 自己先提一件 —— 上线第一天提请台是空的（`store.candidate.test.ts`），
    // 这里要的只是一张真卡，来路哪一条都行。
    await api.addIssue("标注用的一条信号");
    const pending = await api.listPending();
    const card = pending[0];
    expect(
      markCardAgentVerdict(card.id, {
        route: "ignore",
        verdict: "此信号应被忽略，不改动也不新增议题",
        reason: "只有一个来源",
        reasonToRevisit: "出现第二个独立来源",
        runId: "RUN-b",
        at: "2026-08-18T00:00:01.000Z",
      })
    ).toBe(true);
    const after = (await api.listPending()).find((x) => x.id === card.id);
    expect(after?.agentVerdict?.route).toBe("ignore");
    // 关键：**没有**被处置掉。CEO 递上来的信号哪怕判为无价值也不能自动消失，
    // 删除或归档是他自己的动作。
    expect(after?.disposedAs).toBeUndefined();
  });

  it("卡不存在时返回 false，不抛", () => {
    expect(
      markCardAgentVerdict("CARD-不存在", {
        route: "ignore",
        verdict: "x",
        reason: "x",
        reasonToRevisit: "x",
        runId: "RUN-b",
        at: "2026-08-18T00:00:01.000Z",
      })
    ).toBe(false);
  });
});
