/**
 * 删掉一件议题（调试用的那个入口）。
 *
 * 这一刀是真删，所以要钉的不是「它删掉了」，是**它有没有删干净、以及该拦的时候拦不拦**：
 *
 *   · 删完那张卡也得走。留着的话，潜在议题那一屏上会剩一行点进去是 404 的东西 ——
 *     而屏幕上看不出那一行有问题。
 *   · 已经删掉的再删一次要照实说「没有这件议题」，不能默默算成功：调试的时候，
 *     一次静默成功等于让他以为删的是另一件。
 *   · **有任务在跑的时候必须拦住。** 预研/深研/A5/写回都是先返回、后台再写库的，
 *     删到一半那边写回来，`store.board[issueId]` 这类会凭空复活成挂在不存在议题下的
 *     孤儿，而结果页上一切正常。
 *
 * `judgment.shakenBy` 那一头不在这里验：`removeIssue` 用的是 `clearShakenBy`，那个
 * 函数的行为由确认与签发那两条路的测试钉着，这里再钉一遍是把同一件事写两处。
 */
import { beforeAll, describe, expect, it } from "vitest";
import type { api as Api } from "./store";
import { runTask } from "@/lib/agent/tasks";

let api: typeof Api;

beforeAll(async () => {
  // 别读也别写 .data 里那份真快照 —— 否则这几条断言跟着开发机上的现场数据飘，
  // 而这个文件里每一条都在**删东西**。
  process.env.TKOS_PERSIST = "0";
  // 这台机器上可能导出着真 key。单测不许把钱花出去，也不许出网。
  process.env.TKOS_MODEL_MOCK = "1";
  api = (await import("./store")).api;
});

/** 等这个任务跑到不再是 running。假模型下第一步就要出网，几十毫秒内必然 failed。 */
const settle = async (get: () => Promise<{ status: string }>) => {
  for (let i = 0; i < 100; i++) {
    const st = await get();
    if (st.status !== "running") return st;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error("任务两秒还没跑完 —— 假模型下不该发生");
};

describe("删掉一件议题", () => {
  it("议题、卡、时间线一起走，删完像它没来过", async () => {
    const issue = await api.addIssue("要不要把成都那条渠道的抽佣重算一遍");
    // `addIssue` 顺手起了一轮预研。等它落地再删 —— 正在跑的会被下面那条挡住。
    await settle(() => api.preResearchStatus(issue.id));

    expect((await api.listPending()).some((c) => c.issueId === issue.id)).toBe(true);

    const res = await api.removeIssue(issue.id);
    expect(res).toEqual({ issueId: issue.id, removed: true });

    expect((await api.listIssues()).some((i) => i.id === issue.id)).toBe(false);
    expect((await api.listPending()).some((c) => c.issueId === issue.id)).toBe(false);
    await expect(api.getIssue(issue.id)).rejects.toThrow();
  });

  it("已经删掉的再删一次照实说没有这件议题", async () => {
    await expect(api.removeIssue("ISS-不存在")).rejects.toThrow("没有 ISS-不存在 这件议题");
  });

  it("有任务在跑就不给删 —— 那一轮的结果会写回成孤儿", async () => {
    const issue = await api.addIssue("要不要现在就把交付口径收进一份文档");
    await settle(() => api.preResearchStatus(issue.id));

    // 一个永远不结束的深研。真实情况是他在那一到三分钟里按了删除。
    runTask("deep", issue.id, () => new Promise(() => {}));

    await expect(api.removeIssue(issue.id)).rejects.toThrow("跑完再删");
    // 拦住之后议题必须还是完整的 —— 拦一半比不拦更糟。
    expect((await api.listIssues()).some((i) => i.id === issue.id)).toBe(true);
    expect((await api.listPending()).some((c) => c.issueId === issue.id)).toBe(true);
  });
});
