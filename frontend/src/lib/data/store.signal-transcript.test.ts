// 这两行在任何会摸到 store.ts 的 import 之前 —— 理由同 store.judgements.test.ts 的开头。
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

import { beforeAll, describe, expect, it } from "vitest";

/**
 * 分诊那一栏的对谈记录（`openSignalTurn` / `recordSignalReply` / `getSignalTranscript`）。
 *
 * 这一条路 2026-08-31 之前只有读没有写：屏幕上他再点进同一张卡，上一次问过什么、参谋答过
 * 什么全是空白。加写的时候有一条**必须同时守住**的旧约束 —— 分诊那几轮不许被当成
 * 「这件事讨论过了」的证据往判断上推，因为他当时只是在决定要不要开始。
 *
 * 守法是 key 分家：判断演进萃取和那几处统计读的是裸 `issueId` 那一支，这一栏写的是
 * `${issueId}:signal`。所以下面两件事一起钉，缺一件这条路就白改：
 *
 *   1. **存下来了** —— 再读回来是同样那几轮。
 *   2. **没漏进隔壁那一支** —— 议题研究那一栏读回来仍然是空的。
 *
 * 只钉第 1 条的话，哪天有人把 key 写成裸 `issueId`（那是两行代码的事，而且看起来更"对"），
 * 测试照样全绿，代价要等到判断板上冒出一条从分诊闲聊里萃出来的判断才看得见。
 */

let api: typeof import("./store").api;

beforeAll(async () => {
  api = (await import("./store")).api;
});

/** 拿一件真实存在的议题。分诊这条路不 `findIssue`，但测试还是照真 id 走。 */
const anIssue = async (): Promise<string> => {
  const list = await api.listIssues();
  expect(list.length).toBeGreaterThan(0);
  return list[0]!.id;
};

describe("分诊对谈记录", () => {
  it("问一句、答一句，读回来还在 —— 他再点进这张卡看到的是上次聊到哪", async () => {
    const id = await anIssue();
    const before = await api.getSignalTranscript(id);

    await api.openSignalTurn(id, "你好");
    await api.recordSignalReply(id, "你好。想从哪儿开始？", 1200);

    const after = await api.getSignalTranscript(id);
    expect(after).toHaveLength(before.length + 2);
    expect(after.at(-2)).toMatchObject({ role: "user", text: "你好" });
    expect(after.at(-1)).toMatchObject({ role: "agent", text: "你好。想从哪儿开始？", elapsedMs: 1200 });
  });

  it("写的是 `:signal` 那一支：议题研究那一栏读不到它", async () => {
    const id = await anIssue();
    const advisorBefore = await api.listAdvisorMessages(id);

    await api.openSignalTurn(id, "这条跟灯塔项目有关系吗");
    await api.recordSignalReply(id, "有，但不是你担心的那一层。");

    // 分诊那一支多了两轮
    const signal = await api.getSignalTranscript(id);
    expect(signal.map((m) => m.text)).toContain("这条跟灯塔项目有关系吗");

    // 而议题研究那一支一个字都没多 —— 萃取读的正是这一支
    const advisorAfter = await api.listAdvisorMessages(id);
    expect(advisorAfter).toHaveLength(advisorBefore.length);
    expect(advisorAfter.map((m) => m.text)).not.toContain("这条跟灯塔项目有关系吗");
  });

  it("空话不许记 —— 两头都拦", async () => {
    const id = await anIssue();
    await expect(api.openSignalTurn(id, "   ")).rejects.toThrow();
    await expect(api.recordSignalReply(id, "")).rejects.toThrow();
  });
});
