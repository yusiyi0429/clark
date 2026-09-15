// 必须在 import 之前设置（同 store.a5-once.test.ts）：不设 TKOS_PERSIST=0，
// store.ts 模块求值期会读开发机上 .data/store.json 里的真实数据。
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

/**
 * 决断包批准之后本地怎么落账。
 *
 * 这一组钉的是「按下那一下之后，库里到底多了什么」—— 批准这一路一次要写五个地方
 * （正式决策、固化的决心、逐条命令、决策记忆里的指挥边界、议题状态），而**少写任何一处
 * 都不会报错**：屏幕上照样弹出「已批准」，只是三个月后翻账时那条命令没有出处、或者
 * 那条决策没有边界。所以这里对着五处各断一条，而不是只断函数返回值 ——
 * 返回值是这次调用自己说的话，库才是别人明天读到的东西。
 *
 * 报告直接摆进库（`__seedResearchedIssueForTest`）：决断包在产品里由深研收口那一次交出来，
 * 而写出一份决断包要真跑一轮 A4 —— 单测里一次模型调用都不许打。
 */
import { beforeAll, describe, expect, it } from "vitest";
import type {
  api as Api,
  __getDecisionMemoriesForTest as GetMemories,
} from "./store";
import { decisionOrderState } from "./types";
import type { CommandBrief, ResearchDoc } from "./types";

let api: typeof Api;
let getMemories: typeof GetMemories;
let HELD_MEMORY_PREFIX: string;
let COMMAND_BRIEF_NODE_ID: string;

beforeAll(async () => {
  const mod = await import("./store");
  api = mod.api;
  getMemories = mod.__getDecisionMemoriesForTest;
  HELD_MEMORY_PREFIX = mod.HELD_MEMORY_PREFIX;
  COMMAND_BRIEF_NODE_ID = mod.COMMAND_BRIEF_NODE_ID;
});

/** 这份决断包的形状照 `CommandBrief`。正文写什么不重要，重要的是每一栏都非空 —— 空栏测不出「有没有落进去」。 */
const BRIEF: CommandBrief = {
  situation: [{ text: "两家已投标客户的决策人换了", evidenceRefs: ["E1", "E2"] }],
  recommendation: {
    action: "把定价从按座位改成按用量，先在两家试点",
    intent: "让报价不再被席位数卡住",
    whyNow: "两家的续约窗口在这个月底",
    confidence: "当前更支持",
    evidenceRefs: ["E1"],
    evidenceEffect: "narrowed",
    evidenceEffectWhy: "只在这两家验到，别的行业还没查",
  },
  decisionsRequired: [
    {
      question: "试点范围是两家还是全线",
      recommendedChoice: "先两家",
      costOfDelay: "错过这个月底的续约窗口",
      recoveryIfWrong: "试点合同里留一条回退条款",
    },
  ],
  proposedOrders: [
    {
      role: "定价负责人",
      outcome: "出一版按用量的价目表",
      dueOn: "2026-09-15",
      acceptance: ["两档用量区间", "与现价的对照表"],
    },
    {
      role: "客户成功",
      outcome: "跟两家谈下试点意向",
      dueOn: "2026-09-20",
      acceptance: ["两份书面意向"],
      resources: ["法务两个工作日"],
    },
  ],
  controls: {
    mustNot: ["不许对存量客户涨价"],
    changeTriggers: ["第三家客户提出同样诉求"],
    abortConditions: ["试点两家里有一家中止"],
    reviewAt: "2026-10-01",
  },
  alternatives: [{ action: "维持按座位", whenBetter: "用量口径谈不拢时" }],
};

/**
 * 一件手上有决断包的议题。
 *
 * `extra` 往报告上再摆几栏（交付完整性那一套）。默认什么都不摆 —— 那正是这一版之前
 * 落库的那些报告的样子（完整性未知）。
 *
 * `stage: false` 时**不**替它走「进入行动整理」那一步，用来测那道闸本身。
 */
async function issueWithBrief(
  title: string,
  opts: { extra?: Partial<ResearchDoc>; stage?: boolean } = {},
): Promise<string> {
  const { __seedResearchedIssueForTest } = await import("./store");
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
    at: "2026-08-25T02:00:00.000Z",
    commandBrief: BRIEF,
    ...opts.extra,
  };
  __seedResearchedIssueForTest(issue.id, doc, {
    text: "定价改按用量吗",
    suggestedDri: "白田田",
    deadline: "48小时",
  });
  if (opts.stage !== false) await api.enterActionStaging(issue.id);
  return issue.id;
}

describe("批准并下达", () => {
  it("拟制命令逐条落库、决策记忆多一条、议题状态推到已拍板", async () => {
    const issueId = await issueWithBrief("要不要把定价从按座位改成按用量");
    const before = getMemories().length;

    const receipt = await api.approveCommandBrief(issueId);

    // 1. 逐条落库。**读库不读返回值** —— 返回值是这次调用自己说的话。
    const orders = await api.listDecisionOrders(issueId);
    expect(orders).toHaveLength(BRIEF.proposedOrders.length);
    expect(orders.map((o) => o.role)).toEqual(["定价负责人", "客户成功"]);
    expect(orders.map((o) => o.dueOn)).toEqual(["2026-09-15", "2026-09-20"]);
    expect(orders[0].acceptance).toEqual(["两档用量区间", "与现价的对照表"]);
    // 出处：这条命令是照哪一版决断包发的。
    expect(orders[0].briefAt).toBe("2026-08-25T02:00:00.000Z");
    // 没指定 DRI 就是**没有这个键**，不是空串 —— 那两句话在命令板上不一样。
    expect(orders[0].driId).toBeUndefined();
    // 落库即已发：三个时间戳里只有 issuedAt 有值。
    expect(orders.map(decisionOrderState)).toEqual(["issued", "issued"]);

    // 2. 正式决策走的是现成那条路（quickDecisions），编号因此进得了去重表。
    const quick = (await api.listQuickDecisions()).filter(
      (q) => q.issueId === issueId,
    );
    expect(quick).toHaveLength(1);
    expect(quick[0].decisionId).toBe(receipt.decisionId);
    expect(quick[0].nodeId).toBe(COMMAND_BRIEF_NODE_ID);
    expect(quick[0].nodeText).toBe(BRIEF.recommendation.action);

    // 3. 决策记忆恰好多一条，而且指挥边界三类都在它的重开条件里。
    const memories = getMemories();
    expect(memories.length).toBe(before + 1);
    const mem = memories.find((m) => m.id === receipt.memoryId);
    expect(mem).toBeDefined();
    expect(mem!.judgment).toBe(BRIEF.recommendation.action);
    /*
     * 三条各带前缀。断的是**具体那三行字**而不是 `toHaveLength(3)`：三类混在一栏里
     * 没有前缀时数量照样是 3，而「不许动价格」和「价格动了就回来」要求的行为正好相反。
     */
    expect(mem!.overturnConditions).toEqual([
      "不许：不许对存量客户涨价",
      "变了就回来：第三家客户提出同样诉求",
      "直接中止：试点两家里有一家中止",
    ]);

    // 4. 议题状态推进。
    const issue = await api.getIssue(issueId);
    expect(issue.state).toBe("Decided");
    expect(receipt.newState).toBe("Decided");
    expect(receipt.held).toBe(false);
  });
});

describe("修改后批准", () => {
  it("改过的期限、改过的建议落的是改过的值，而且固化回报告", async () => {
    const issueId = await issueWithBrief("要不要把交付节奏从月度改成双周");

    const receipt = await api.approveCommandBrief(issueId, {
      edits: {
        recommendation: { action: "先只在一家试点" },
        orders: [{ index: 1, dueOn: "2026-09-30", driId: "P-BTT" }],
      },
    });

    const orders = await api.listDecisionOrders(issueId);
    // 改过的那条是改过的值……
    expect(orders[1].dueOn).toBe("2026-09-30");
    expect(orders[1].driId).toBe("P-BTT");
    // ……没改的那条一个字没动（覆盖不许溢到别条上）。
    expect(orders[0].dueOn).toBe("2026-09-15");
    expect(orders[0].driId).toBeUndefined();

    // 固化：半年后重新打开这件议题，屏幕上摆的是他点头的那一版，不是参谋原来的建议。
    const doc = await api.getResearchDoc(issueId);
    expect(doc?.commandBrief?.recommendation.action).toBe("先只在一家试点");
    expect(doc?.commandBrief?.proposedOrders[1].dueOn).toBe("2026-09-30");
    // 只覆盖列出来的那几栏 —— 没列的保持参谋原文。
    expect(doc?.commandBrief?.recommendation.whyNow).toBe(
      BRIEF.recommendation.whyNow,
    );

    // 决策记忆记的也是改过的那句话，不是原建议。
    const mem = getMemories().find((m) => m.id === receipt.memoryId);
    expect(mem!.judgment).toBe("先只在一家试点");
  });
});

describe("暂缓", () => {
  it("一条命令都不发，只多一条 held 记忆，议题状态不动", async () => {
    const issueId = await issueWithBrief("要不要把渠道返点从季度改成年度");
    const stateBefore = (await api.getIssue(issueId)).state;
    const before = getMemories().length;
    const quickBefore = (await api.listQuickDecisions()).length;

    const receipt = await api.approveCommandBrief(issueId, {
      hold: { why: "等这个季度的续约数出来再定" },
    });

    expect(receipt.held).toBe(true);
    // 暂缓不是一个决定 —— 不发编号，也就不占那个「因哪个决定变的」的键。
    expect(receipt.decisionId).toBeNull();
    expect(await api.listDecisionOrders(issueId)).toEqual([]);
    expect((await api.listQuickDecisions()).length).toBe(quickBefore);

    const memories = getMemories();
    expect(memories.length).toBe(before + 1);
    const mem = memories.find((m) => m.id === receipt.memoryId)!;
    expect(mem.judgment.startsWith(HELD_MEMORY_PREFIX)).toBe(true);
    expect(mem.rationale).toBe("等这个季度的续约数出来再定");
    // 暂缓照样存边界：被暂缓的事只有这一条记忆盯着，没有命令盯着。
    expect(mem.overturnConditions).toContain("变了就回来：第三家客户提出同样诉求");

    // 这件事还压在他身上，屏幕上就得照旧压着。
    expect((await api.getIssue(issueId)).state).toBe(stateBefore);
    expect(receipt.newState).toBe(stateBefore);
  });
});

/*
 * -----------------------------------------------------------------------------
 * 下达那道闸
 * -----------------------------------------------------------------------------
 *
 * 这一组测的是**服务端**那一道，不是屏幕上那颗置灰的按钮。理由写在
 * `store.approveCommandBrief` 头上：`/api/data` 是直接 POST 就打得进来的口，把按钮藏
 * 起来只挡得住手，挡不住一条 curl。所以每一条都直接调 `api.approveCommandBrief` —— 这
 * 正是「绕过界面」那条路走的地方。
 *
 * 断的是**抛没抛**加**库里有没有多东西**。只断抛出的话，一个「先落了命令再抛」的实现
 * 照样绿，而那种实现坏得最难看：屏幕上说被拒了，命令板上多了三条。
 */
describe("服务端那道闸：不完整的研究不许下达", () => {
  it("没进过行动整理就批准 —— 拒，一条命令都不落", async () => {
    const issueId = await issueWithBrief("要不要把交付节奏改成双周", { stage: false });

    await expect(api.approveCommandBrief(issueId)).rejects.toThrow(/行动整理/);

    expect(await api.listDecisionOrders(issueId)).toEqual([]);
    // 议题状态也不许被推 —— 拒掉的那一下不该在别处留痕。
    expect((await api.getIssue(issueId)).state).not.toBe("Decided");
  });

  it("部分交付：拒，而且原因写的是「只交付了部分章节」", async () => {
    const issueId = await issueWithBrief("要不要提前首发", {
      extra: { completeness: "partial" },
    });

    await expect(api.approveCommandBrief(issueId)).rejects.toThrow(/部分章节/);
    expect(await api.listDecisionOrders(issueId)).toEqual([]);
  });

  it("交付失败：拒", async () => {
    const issueId = await issueWithBrief("要不要换渠道", {
      extra: { completeness: "failed" },
    });
    await expect(api.approveCommandBrief(issueId)).rejects.toThrow(/可读的正文/);
    expect(await api.listDecisionOrders(issueId)).toEqual([]);
  });

  it("标了「只够讨论」：拒 —— 交付完整不等于具备决策条件", async () => {
    const issueId = await issueWithBrief("要不要开第二条产线", {
      extra: { completeness: "complete", decisionReady: false },
    });
    await expect(api.approveCommandBrief(issueId)).rejects.toThrow(/可供讨论/);
    expect(await api.listDecisionOrders(issueId)).toEqual([]);
  });

  it("修改后批准走同一道闸 —— 带 edits 也拒", async () => {
    const issueId = await issueWithBrief("要不要改返点", {
      extra: { completeness: "partial" },
    });
    await expect(
      api.approveCommandBrief(issueId, { edits: { orders: [{ index: 0, dueOn: "2026-10-01" }] } }),
    ).rejects.toThrow(/部分章节/);
    expect(await api.listDecisionOrders(issueId)).toEqual([]);
    // 改动也不许被固化回报告：这一路整条都没发生。
    const doc = await api.getResearchDoc(issueId);
    expect(doc?.commandBrief?.proposedOrders[0].dueOn).toBe("2026-09-15");
  });

  it("暂缓不受完整性拦 —— 它一条命令都不发", async () => {
    const issueId = await issueWithBrief("要不要收缩试点", {
      extra: { completeness: "partial" },
    });
    const receipt = await api.approveCommandBrief(issueId, {
      hold: { why: "等两节写完再说" },
    });
    expect(receipt.held).toBe(true);
    expect(await api.listDecisionOrders(issueId)).toEqual([]);
  });

  it("暂缓照样要先进过行动整理", async () => {
    const issueId = await issueWithBrief("要不要暂停投放", { stage: false });
    await expect(
      api.approveCommandBrief(issueId, { hold: { why: "先看下季度数" } }),
    ).rejects.toThrow(/行动整理/);
  });

  it("旧报告没有这两栏：**照旧可批**，未知不当成不完整", async () => {
    /*
     * 这一条守的是「保留兼容」那条硬要求。这两栏是这一版才有的，而这一版之前落库的
     * 决断包一份都没有 —— 从严的话它们会在按下批准的那一下被一句「完整性不足」拒掉，
     * 而这个库从来没有量过它们的完整性。那是拿未知当罪证。
     *
     * 反过来也不许：不凭 `confidence` 猜成完整（屏幕上照实标「未知」，见
     * `DeliveryNotice`）。这里断的只是「闸放行」。
     */
    const issueId = await issueWithBrief("这是一份老报告");
    const receipt = await api.approveCommandBrief(issueId);
    expect(receipt.held).toBe(false);
    expect((await api.listDecisionOrders(issueId)).length).toBe(
      BRIEF.proposedOrders.length,
    );
  });

  it("标了完整、够决策：放行", async () => {
    const issueId = await issueWithBrief("这一轮写全了", {
      extra: { completeness: "complete", decisionReady: true },
    });
    const receipt = await api.approveCommandBrief(issueId);
    expect(receipt.decisionId).toBeTruthy();
  });
});

describe("进入行动整理", () => {
  it("幂等 —— 第二次进来还是第一次那个时刻", async () => {
    const issueId = await issueWithBrief("要不要合并两条线", { stage: false });
    const first = await api.enterActionStaging(issueId);
    const second = await api.enterActionStaging(issueId);
    expect(second.at).toBe(first.at);
  });

  it("这一轮没有行动建议就没得整理 —— 拒", async () => {
    const { __seedResearchedIssueForTest } = await import("./store");
    const issue = await api.addIssue("一道行业题，参谋没给行动建议");
    // 没有 commandBrief 的报告是**合法**的（行业题、老报告）。页面照常好用，只是这一步没有。
    __seedResearchedIssueForTest(
      issue.id,
      {
        issueId: issue.id,
        judgment: [{ text: "这个行业的瓶颈在换层", traces: [] }],
        keyEvidence: [],
        counters: [],
        unknowns: [],
        routeSuggestion: "继续观察",
        byAgentLabel: "CEO Agent",
        assembledFrom: [],
        at: "2026-08-25T02:00:00.000Z",
      },
      { text: "这个行业接下来往哪走", suggestedDri: "白田田", deadline: "一周" },
    );
    await expect(api.enterActionStaging(issue.id)).rejects.toThrow(/没有东西可整理/);
  });

  it("不判交付完整性 —— 缺论证的结果也能走进去看看", async () => {
    const issueId = await issueWithBrief("这一轮只写了一节", {
      extra: { completeness: "partial" },
      stage: false,
    });
    await expect(api.enterActionStaging(issueId)).resolves.toBeTruthy();
  });
});

describe("期限：相对时间不许塞进被日期解析器消费的那一栏", () => {
  it("「首访前」落进 dueNote，dueOn 留空", async () => {
    const issueId = await issueWithBrief("首访怎么谈", {
      extra: {
        commandBrief: {
          ...BRIEF,
          proposedOrders: [
            { role: "客户线", outcome: "拿到验收口径", dueOn: "首访前", acceptance: ["一份书面口径"] },
            { role: "产品线", outcome: "备一版演示", dueOn: "", acceptance: ["能跑通"] },
          ],
        },
      },
    });

    await api.approveCommandBrief(issueId);

    const orders = await api.listDecisionOrders(issueId);
    // 相对时间原话留着，但**不在** dueOn 上 —— 那一栏会被日期解析器消费。
    expect(orders[0].dueOn).toBe("");
    expect(orders[0].dueNote).toBe("首访前");
    // 什么都没写的那条两栏都空：屏幕上是「时间待定」，不是一个编出来的日子。
    expect(orders[1].dueOn).toBe("");
    expect(orders[1].dueNote).toBeUndefined();
  });

  it("真日期照旧进 dueOn，不生成 dueNote", async () => {
    const issueId = await issueWithBrief("要不要提前一周");
    await api.approveCommandBrief(issueId);
    const orders = await api.listDecisionOrders(issueId);
    expect(orders[0].dueOn).toBe("2026-09-15");
    expect(orders[0].dueNote).toBeUndefined();
  });
});

describe("命令状态由三个时间戳推出来", () => {
  /*
   * 四种组合各一条。这个函数是屏幕上那一栏唯一的真相 —— 库里没有 `status` 字段，
   * 所以它推错的表现是命令板整栏显示错，而不是某一条数据坏。
   */
  const base = {
    issuedAt: "2026-09-07T10:00:00+08:00",
    acknowledgedAt: "2026-09-07T11:00:00+08:00",
    closedAt: "2026-09-08T10:00:00+08:00",
  };

  it("三个都空 = 还没发", () => {
    expect(decisionOrderState({ issuedAt: "" })).toBe("draft");
  });

  it("只有下达时刻 = 已发", () => {
    expect(decisionOrderState({ issuedAt: base.issuedAt })).toBe("issued");
  });

  it("有回执、还没关 = 已回执", () => {
    expect(
      decisionOrderState({
        issuedAt: base.issuedAt,
        acknowledgedAt: base.acknowledgedAt,
      }),
    ).toBe("acknowledged");
  });

  it("关了就是已关闭 —— 哪怕根本没收到过回执", () => {
    expect(decisionOrderState(base)).toBe("closed");
    /*
     * 这一条是倒序判的意义所在：一条**没人回执就直接关掉**的命令（撤销、或者事情黄了）
     * 在库里就是 `issuedAt` 有、`acknowledgedAt` 空、`closedAt` 有。按正序判的话它会
     * 停在「已发」，而那正是它已经不再是的那一档。
     */
    expect(
      decisionOrderState({ issuedAt: base.issuedAt, closedAt: base.closedAt }),
    ).toBe("closed");
  });
});
