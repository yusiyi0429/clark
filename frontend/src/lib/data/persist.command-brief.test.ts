/**
 * **批准过的命令和固化过的决心，重启一次不许丢。**
 *
 * `store.decisionOrders` 是这一件新加的那张表，而 `ResearchDoc.commandBrief` 是批准时被
 * 就地改写的那一份。两样都只活在整库快照里（persist.ts 把 store 整个序列化），所以
 * 「它到底跟着快照走没走」这件事，只有跨一程真落盘才答得出 —— 在同一程里读回来永远是绿的，
 * 因为读的是同一个内存对象。
 *
 * 丢了的表现是最坏的那一种：一号位周一批了命令，周二回来命令板是空的，而账上什么都不缺
 * （议题状态还停在已拍板、决策记忆还在），于是这件事看起来像是「他记错了自己批过」。
 *
 * 单独一个文件，理由同 `persist.restart.test.ts`：`persist.ts` 在模块加载时就把
 * `TKOS_DATA_DIR` 读成常量，所以每一程都要先设环境变量再 `vi.resetModules()`；别的
 * store 测试文件设的 `TKOS_PERSIST=0` 会让这一整条失去意义。
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { CommandBrief, ResearchDoc } from "./types";

// 这台机器上可能导出着真 key。单测不许把钱花出去，也不许出网。
process.env.TKOS_MODEL_MOCK = "1";

let dir = "";

const BRIEF: CommandBrief = {
  situation: [{ text: "两家已投标客户的决策人换了", evidenceRefs: ["E1"] }],
  recommendation: {
    action: "把定价从按座位改成按用量，先在两家试点",
    intent: "让报价不再被席位数卡住",
    whyNow: "两家的续约窗口在这个月底",
    confidence: "当前更支持",
    evidenceRefs: ["E1"],
    evidenceEffect: "narrowed",
    evidenceEffectWhy: "只在这两家验到",
  },
  decisionsRequired: [
    {
      question: "试点范围是两家还是全线",
      recommendedChoice: "先两家",
      costOfDelay: "错过这个月底的续约窗口",
      recoveryIfWrong: "试点合同里留回退条款",
    },
  ],
  proposedOrders: [
    {
      role: "定价负责人",
      outcome: "出一版按用量的价目表",
      dueOn: "2026-09-15",
      acceptance: ["两档用量区间"],
    },
  ],
  controls: {
    mustNot: ["不许对存量客户涨价"],
    changeTriggers: ["第三家客户提出同样诉求"],
    abortConditions: ["试点两家里有一家中止"],
  },
};

/** 起一件议题、把决断包摆好、改一处期限之后批准。返回议题号与这次的决策编号。 */
async function approveSomething(
  title: string,
): Promise<{ issueId: string; decisionId: string }> {
  const { api, __seedResearchedIssueForTest } = await import("./store");
  const issue = await api.addIssue(title);
  const doc: ResearchDoc = {
    issueId: issue.id,
    judgment: [{ text: "决策权已经移到业务线", traces: [] }],
    keyEvidence: [],
    counters: [],
    unknowns: [],
    routeSuggestion: "建议上会",
    byAgentLabel: "CEO Agent",
    assembledFrom: [],
    at: "2026-08-25T02:00:00.000Z",
    commandBrief: BRIEF,
  };
  __seedResearchedIssueForTest(issue.id, doc, {
    text: "定价改按用量吗",
    suggestedDri: "白田田",
    deadline: "48小时",
  });
  // 批准之前必须先明确进入行动整理 —— 那道闸在服务端（`store.approveCommandBrief`）。
  await api.enterActionStaging(issue.id);
  const receipt = await api.approveCommandBrief(issue.id, {
    edits: { orders: [{ index: 0, dueOn: "2026-09-30", driId: "P-BTT" }] },
  });
  return { issueId: issue.id, decisionId: receipt.decisionId! };
}

describe("批准之后跨一次重启", () => {
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "tkos-brief-"));
    process.env.TKOS_DATA_DIR = dir;
    // 这个文件要的就是真落盘。
    delete process.env.TKOS_PERSIST;
    delete process.env.TKOS_SEED_FROZEN;
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    delete process.env.TKOS_DATA_DIR;
  });

  it("命令、改过的期限、固化过的决断包，都还在", async () => {
    // 第一程
    vi.resetModules();
    const { issueId, decisionId } = await approveSomething(
      "要不要把定价从按座位改成按用量",
    );
    (await import("./persist")).flushNow();

    // 第二程：同一个 TKOS_DATA_DIR，从刚落下的那份快照起来。
    vi.resetModules();
    const { api } = await import("./store");

    const orders = await api.listDecisionOrders(issueId);
    expect(orders).toHaveLength(1);
    expect(orders[0].id).toBe(`DO-${decisionId}-1`);
    // 改过的那个期限得是改过的值 —— 落盘的必须是他批的那一版，不是参谋原来那一版。
    expect(orders[0].dueOn).toBe("2026-09-30");
    expect(orders[0].driId).toBe("P-BTT");
    expect(orders[0].briefAt).toBe("2026-08-25T02:00:00.000Z");

    // 固化回报告的那一份也跟着快照走。
    const doc = await api.getResearchDoc(issueId);
    expect(doc?.commandBrief?.proposedOrders[0].dueOn).toBe("2026-09-30");
    /*
     * 「他进过行动整理」这件事也得跟着快照走。丢了的表现很难看：重启之后那一格消失，
     * 而这件议题明明已经批过命令了 —— 屏幕上于是像是有人偷偷把它退回了研究阶段。
     */
    expect(doc?.actionStagingAt).toBeTruthy();

    // 决策记忆和议题状态一并核一遍：丢了任何一样，命令都会变成一条没有出处的东西。
    const mem = (await import("./store"))
      .__getDecisionMemoriesForTest()
      .find((m) => m.id === `DM-${decisionId}`);
    expect(mem).toBeDefined();
    expect((await api.getIssue(issueId)).state).toBe("Decided");
  });
});
