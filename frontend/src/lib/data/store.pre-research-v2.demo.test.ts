/*
 * **这个文件是 demo 档。** 三个开关必须是文件里最早的可执行语句：`store.ts` 在模块
 * 顶层就读它们，`TKOS_MODE` 尤其如此 —— 一个进程里定不出两档，所以 live 档那些用例
 * 在另一个文件（`store.pre-research-v2.test.ts`）。下面只留 `import type` 与 vitest
 * 的 import，真模块一律在 `beforeAll` 里 `await import()`：任何一个会摸到 store 的
 * 真 import 早于这三行，读到的就是没设过的值。
 *
 * 为什么要 demo 档：下面这几条要的是**种子里既有的**议题与卡（卡上有原文、
 * `judgmentRefs` 上挂着判断）。live 档下这两张表是空的，现造一条就得把这些都补齐，
 * 等于在测试里重写一遍种子。
 *
 * **不要往 `src/lib/data/store.triggers.demo.test.ts` 里加** —— 那个文件测的是
 * 「demo 档两个自动触发点都不起模型」，跟 `store.triggers` 这张新表没关系，名字撞了而已。
 */
process.env.TKOS_MODE = "demo";
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

import { beforeAll, describe, expect, it } from "vitest";
import type { TriggerProposal } from "@/lib/agent/a3/stages";
import type { api as Api } from "./store";
import type { AgentRunRecord, Card, InboxSignal, Issue } from "./types";

let api: typeof Api;

beforeAll(async () => {
  api = (await import("./store")).api;
});

/** 和 live 档那个文件里的同名夹具一样一份 —— 两个文件不共享模块状态，各自摆自己的。 */
function proposal(over: Partial<TriggerProposal> = {}): TriggerProposal {
  return {
    id: "TG-ISS-901-1",
    condition: "那家公司公布了国内客户名单",
    targetRef: { kind: "judgment", id: "J-2", text: "今年不会有新玩家" },
    source: "watch",
    onFire: "proposeDiscuss",
    expiresAt: "2099-01-01T00:00:00.000Z",
    status: "proposed",
    provenance: { issueId: "ISS-901", stage: "pre_research" },
    ...over,
  };
}

describe("待定这一下由人按", () => {
  it("他按下待定，本议题的提案才转 active", async () => {
    const { __nthDemoCardForTest, __seedTriggerForTest } = await import("./store");
    const { issue, card } = __nthDemoCardForTest(0);
    __seedTriggerForTest(proposal({ id: "TG-W-1", provenance: { issueId: issue.id, stage: "pre_research" } }));

    await api.disposeCard(card.id, "watch");

    expect((await api.listTriggers()).find((t) => t.id === "TG-W-1")!.status).toBe("active");
  });

  it("他按下议一议 —— 提案作废，不是转 active（这一条要去研究，不是去盯着）", async () => {
    const { __nthDemoCardForTest, __seedTriggerForTest } = await import("./store");
    const { issue, card } = __nthDemoCardForTest(1);
    __seedTriggerForTest(proposal({ id: "TG-D-1", provenance: { issueId: issue.id, stage: "pre_research" } }));

    await api.disposeCard(card.id, "discuss");

    expect((await api.listTriggers()).find((t) => t.id === "TG-D-1")!.status).toBe("expired");
  });

  it("他按下不看了 —— 提案作废", async () => {
    const { __nthDemoCardForTest, __seedTriggerForTest } = await import("./store");
    const { issue, card } = __nthDemoCardForTest(2);
    __seedTriggerForTest(proposal({ id: "TG-X-3", provenance: { issueId: issue.id, stage: "pre_research" } }));

    await api.disposeCard(card.id, "dismiss", "不相干");

    expect((await api.listTriggers()).find((t) => t.id === "TG-X-3")!.status).toBe("expired");
  });

  it("按待定这一下一条重开条件都不布控 —— armed 只由确认那一下写", async () => {
    const { __nthDemoCardForTest, __seedTriggerForTest, __countArmedReopenTriggersForTest } =
      await import("./store");
    const before = __countArmedReopenTriggersForTest();
    const { issue, card } = __nthDemoCardForTest(3);
    __seedTriggerForTest(proposal({ id: "TG-W-2", provenance: { issueId: issue.id, stage: "pre_research" } }));

    await api.disposeCard(card.id, "watch");

    const after = __countArmedReopenTriggersForTest();
    expect(after).toBe(before);
  });

  it("别的议题的提案不受影响", async () => {
    const { __nthDemoCardForTest, __seedTriggerForTest } = await import("./store");
    /*
     * 复用第 0 张卡：种子里只有四张卡（九条议题里带卡的就前四条），上面四条用例已经
     * 各占一张。复用不影响这一条要断言的东西 —— 第 0 张那一次处置已经把本议题的提案
     * 全部转掉了，这一下本议题名下一条 `proposed` 都不剩，剩下的只有「别的议题那条
     * 没被顺手改掉」这一件事。
     */
    const { card } = __nthDemoCardForTest(0);
    __seedTriggerForTest(proposal({ id: "TG-OTHER", provenance: { issueId: "别的议题", stage: "pre_research" } }));

    await api.disposeCard(card.id, "watch");

    expect((await api.listTriggers()).find((t) => t.id === "TG-OTHER")!.status).toBe("proposed");
  });
});

/**
 * 造一条只给下面这两组用的议题与卡。塞进去就完事，**不返回任何引用**。
 *
 * **为什么不把 store（或那张卡）交回给调用方**：`store.ts` 的约定是所有写都经过 `api`
 * （角色门、`touch`、`pushEvent`、`persistSoon` 都挂在那一层），导出可变引用等于给每个
 * 模块开一道「改了库不留痕」的门。所以下面每条用例都是**动作跑完之后重新读一次**
 * （`__getCardForTest` / `api.getIssue` / `api.getTimeline`），断言读回来的那份上有没有那个变化。
 *
 * **这不是将就，是更严的测法。** 握着活引用只能证明「那个对象被原地改了」：要是哪天
 * 实现改成**替换**卡对象而不是原地改它（`store.cards[i] = { ...card, what }`），活引用
 * 指向的还是那个旧对象，断言要么假绿要么红得莫名其妙 —— 两种都不是在测产品行为。
 * 重新读一次测的是**可观察状态**，而可观察状态才是屏幕和下游真正依赖的东西。
 *
 * 为什么不用上面那几条用的 `__nthDemoCardForTest`：那个按下标取种子里既有的卡，而这两组
 * 要的是「卡上的原文逐字可比」，且每条得有一条**只属于自己的**议题 —— 种子那几张卡同文件
 * 已经被上面五条各占了，再复用会互相踩。
 *
 * **写成 `const x: Issue` / `const x: Card`，不用 `as`**：这两个类型上有十来个必填格，
 * 戴上 `as` 就等于把它们的契约挡在编译之外。字段的取法照 `issueFromSignal` 建卡那一段来。
 */
const seedIssue = async (id: string, title: string, what: string[]) => {
  const at = "2026-08-27T00:00:00.000Z";
  const issue: Issue = {
    id,
    title,
    state: "Candidate",
    origin: "signal",
    judgmentRefs: [],
    nextActionForUser: null,
    raisedAt: at,
    updatedAt: at,
  };
  const card: Card = {
    id: id.replace("ISS-", "CARD-"),
    issueId: id,
    headline: title,
    source: { kind: "radar" },
    what: what.map((text) => ({ text, traces: [] })),
    why: "系统还没查过。",
    strategyRef: { id: "", statement: "这一条还不知道动摇哪条判断 —— 图谱里没有它的锚点。" },
    suggestion: { text: "先只决定一件事：值不值得占您的时间。", traces: [] },
    refs: [],
    domainIds: [],
    createdAt: at,
  };
  const { __seedIssueWithCardForTest } = await import("./store");
  __seedIssueWithCardForTest(issue, card);
};

describe("同一件事再来一条", () => {
  it("有增量就挂到老卡上，不新建卡", async () => {
    await seedIssue("ISS-T15A", "甲发布了 agent 编排产品", ["甲发布了 agent 编排产品。"]);
    const { __countCardsForTest, __getCardForTest, attachSignalToCard } = await import("./store");
    const before = __countCardsForTest();

    attachSignalToCard("ISS-T15A", { delta: ["首批签了三家银行。"], signalId: "SIG-9" });

    // 动作之后**重新读一次** —— 断言的是库里读得出来什么，不是某个对象被原地改没改
    expect(__countCardsForTest()).toBe(before);
    expect(__getCardForTest("ISS-T15A")!.what.map((w) => w.text)).toContain("首批签了三家银行。");
  });

  it("挂完之后上一份产物留在 preResearchPrev 里，下一轮才出得了增量卡", async () => {
    await seedIssue("ISS-T15B", "乙拿了新一轮融资", ["乙拿了新一轮融资。"]);
    const { __seedPreResearchDocForTest, __getPreResearchRoundForTest, attachSignalToCard } =
      await import("./store");
    // 这一份是手写的：生产上没人调 `attachSignalToCard`（见它自己那段注释），
    // 所以「上一轮有产物」这个前提只能在测试里自己摆出来。
    __seedPreResearchDocForTest("ISS-T15B", {
      issueId: "ISS-T15B", status: "valid", statusReason: "r", question: "q", take: "t",
      finding: [], openQuestion: [], soWhat: "s", byAgentLabel: "您的 Agent", assembledFrom: [],
      at: "2026-08-27T00:00:00.000Z",
      stages: {
        entities: [], hits: [],
        blindspot: { isBlindspot: false, proximity: "far", hops: null, credibility: null, magnitude: "unknown", why: [] },
        // `evidence` 空、`searchless` 为真 —— 这两格是同一件事的两面。
        evidence: [], searchless: true,
        impact: { impactType: "outOfScope", proposalType: "noAction", targetRef: null, statement: "x", basis: [] },
        disposition: { action: "dismiss", why: "w", trigger: null },
        critic: { pass: true, checks: [], why: [], modelSlot: null },
        card: { kind: "full", headline: "h", body: "b", basis: [], chars: 1 },
      },
    });

    attachSignalToCard("ISS-T15B", { delta: ["又多了一句。"], signalId: "SIG-10" });

    // 「这一轮搬到上一轮」是**一个**动作，两格一起读才断得出它成没成
    const round = __getPreResearchRoundForTest("ISS-T15B");
    expect(round.prev).toBeDefined();
    expect(round.cur).toBeUndefined();
  });

  it("零增量（纯转载）什么都不动", async () => {
    await seedIssue("ISS-T15C", "丙出了新规", ["丙出了新规。"]);
    const { __getCardForTest, attachSignalToCard } = await import("./store");
    const whatBefore = __getCardForTest("ISS-T15C")!.what.length;

    attachSignalToCard("ISS-T15C", { delta: [], signalId: "SIG-11" });

    expect(__getCardForTest("ISS-T15C")!.what.length).toBe(whatBefore);
  });
});

describe("入库时标注「可能是同一件事」", () => {
  it("标在新那张卡上，而旧议题一个字段都没动", async () => {
    await seedIssue("ISS-T15D", "丁开始给银行做模型日志留存", ["丁开始给银行做模型日志留存。"]);
    await seedIssue("ISS-T15E", "另起一条", []);
    const { __getCardForTest, noteMaybeSameIssue } = await import("./store");
    const oldUpdatedAt = (await api.getIssue("ISS-T15D")).updatedAt;
    const oldWhat = __getCardForTest("ISS-T15D")!.what.length;
    /*
     * 去向记录挂在 `store.timelines[issueId]` 这张表上，**不在 `issue` 上**（`Issue` 没有
     * `timeline` 这一格 —— `pushEvent` 写的是 `store.timelines[issueId] ??= []`）。
     * 这一格产品侧有现成的真读路 `api.getTimeline`，所以不为它开钩子。
     * 它倒序返回，而这里只数条数、只 `some`，跟顺序无关。
     */
    const oldEvents = (await api.getTimeline("ISS-T15D")).length;

    /*
     * incoming 里**逐字包含** ISS-T15D 自己的标题与原文，所以它跟那一条的二元组重叠
     * 是全表最高的（跟自己比不可能被别人超过）—— 这条断言不靠种子里恰好没有更像的议题。
     */
    const r = noteMaybeSameIssue(
      "ISS-T15E",
      "丁开始给银行做模型日志留存。首批三家银行已经上线。",
    );

    expect(r?.issueId).toBe("ISS-T15D");
    expect(r?.delta).toEqual(["首批三家银行已经上线。"]);
    // 新那张卡上有这一格（动作之后重新读一次）
    expect(__getCardForTest("ISS-T15E")!.maybeSameIssue?.issueId).toBe("ISS-T15D");
    // **旧那条一个字段都没动**：没多原文、没多事件、`updatedAt` 没被推
    expect(__getCardForTest("ISS-T15D")!.what.length).toBe(oldWhat);
    expect((await api.getTimeline("ISS-T15D")).length).toBe(oldEvents);
    expect((await api.getIssue("ISS-T15D")).updatedAt).toBe(oldUpdatedAt);
    // 那一条留痕落在**新**议题上（这件事是新那条的属性）
    expect((await api.getTimeline("ISS-T15E")).some((e) => e.headline.includes("可能是同一件事"))).toBe(true);
  });

  it("没有像的就不写这一格，也不编一条", async () => {
    await seedIssue("ISS-T15F", "又另起一条", []);
    const { __getCardForTest, noteMaybeSameIssue } = await import("./store");
    expect(noteMaybeSameIssue("ISS-T15F", "戊在南极架了一台望远镜。")).toBeNull();
    expect(__getCardForTest("ISS-T15F")!.maybeSameIssue).toBeUndefined();
  });
});

/*
 * 这一条守的是**入库那一处真的调了标注**这件事，其余四条守的是标注本身的行为。
 * 分开是必要的：上面那两组直接叫 `noteMaybeSameIssue`，把 `apply.ts` 里那一行连同
 * 返回里那一格整个删掉，它们照样全绿 —— 那条接头就成了没人守的一段。
 *
 * 它放在这个文件而不是 `a1a/apply.test.ts`：要比的是「库里已经有一条说同一件事的
 * 议题」，而那份起点是这个文件里的 `seedIssue` 摆出来的。
 */
describe("入库那一处接上了这一下", () => {
  it("applyA1aInbox 照旧建新议题、照旧返回 issueId，只多带出那一格", async () => {
    await seedIssue("ISS-T15G", "己上线了跨境结算的对账机器人", ["己上线了跨境结算的对账机器人。"]);
    const { applyA1aInbox } = await import("@/lib/agent/a1a/apply");
    const { __getCardForTest } = await import("./store");

    /** 判为值得、带议题正文的那一次运行。字段照 `a1a/apply.test.ts` 里那份夹具取。 */
    const run: AgentRunRecord = {
      id: "RUN-A1a-t15",
      agent: "A1a",
      status: "ok",
      input: "信号原文：己上线了跨境结算的对账机器人。",
      output: { issue_statement: "跨境结算这条线上的对账，还轮得到我们做吗？" },
      route: "new_issue",
      contextMode: "anchored",
      trace: [],
      checks: [],
      checkSummary: { passed: 0, total: 0, allPassed: true, failed: [] },
      usage: { inputTokens: 0, outputTokens: 0, cachedInputTokens: 0, reasoningTokens: 0 },
      slot: "pro",
      modelAlias: "deepseek-pro",
      providerModelId: "ep-x",
      depth: "high",
      snapshotId: "ctx-x",
      contextRecipe: "S01",
      contextAnchor: "CARD-01",
      contextViewer: "PSN-01",
      contextAsOf: "2026-08-27",
      graphknowledgeBaseUrl: "https://example/graph",
      warnings: [],
      createdAt: "2026-08-27T00:00:00.000Z",
      finishedAt: "2026-08-27T00:00:01.000Z",
      latencyMs: 1,
    };
    const sig: InboxSignal = {
      kind: "crawled",
      origin: "pinned",
      dedupeKey: "https://example.com/t15",
      title: "己上线了跨境结算的对账机器人",
      url: "https://example.com/t15",
      text: "己上线了跨境结算的对账机器人。已接入两家清算行。",
      publishedAt: "2026-08-27T00:00:00.000Z",
      source: "第一财经",
      why: "清算行名单三个月内定",
      score: 4.2,
      dimensions: {},
      kiq: "KIQ2.2",
      suggestedIssue: "对账这一层还轮不轮得到我们",
      runId: "RUN-scan-t15",
      scannedAt: "2026-08-27T00:00:00.000Z",
      receivedAt: "2026-08-27T01:00:00.000Z",
    };

    const r = applyA1aInbox(run, sig);

    // 既有的两格照旧 —— 这一步只多一格，不改返回语义
    expect(r.applied).toContain("已开成议题");
    expect(r.issueId).toBeTruthy();
    // 多出来的那一格，以及它真的落到了**新**那张卡上
    expect(r.maybeSameIssue?.issueId).toBe("ISS-T15G");
    expect(r.maybeSameIssue?.delta).toEqual(["已接入两家清算行。"]);
    expect(__getCardForTest(r.issueId!)!.maybeSameIssue?.issueId).toBe("ISS-T15G");
    // **旧那条没有被合掉、也没被撤掉**：它还在，卡上一句原文都没多
    expect((await api.getIssue("ISS-T15G")).id).toBe("ISS-T15G");
    expect(__getCardForTest("ISS-T15G")!.what.length).toBe(1);
  });
});

describe("Discuss 接缝", () => {
  /** 造一份带 v2 各段产物的预研文档，挂到指定议题上。塞进去就完事，不返回引用（同 `seedIssue`）。 */
  const withStages = async (issueId: string) => {
    await seedIssue(issueId, "这家新公司要不要盯", ["某公司发布了同类产品。"]);
    const { __seedPreResearchDocForTest } = await import("./store");
    __seedPreResearchDocForTest(issueId, {
      issueId, status: "valid", statusReason: "r",
      question: "这家新公司要不要盯", take: "值得盯一阵", finding: [], openQuestion: [],
      soWhat: "先待定，命中了再看", byAgentLabel: "您的 Agent", assembledFrom: [],
      at: "2026-08-27T00:00:00.000Z",
      stages: {
        entities: [{ name: "某公司", kind: "company" }],
        hits: [{ target: { kind: "judgment", id: "J-2", text: "今年不会有新玩家" }, match: "challenges", why: "正是新玩家", hops: 1 }],
        blindspot: { isBlindspot: true, proximity: "adjacent", hops: 1, credibility: "A", magnitude: "material", why: ["不在监控清单上"] },
        evidence: [{ id: "E1", claim: "同类产品已发布", sourceRef: "https://a.gov.cn/x", sourceName: "国家统计局", date: "2026-08-27T00:00:00.000Z", tier: "A", cosourceKey: "dom:a.gov.cn", provenance: { issueId, stage: "pre_research" } }],
        searchless: false,
        impact: { impactType: "weakens", proposalType: "adjustJudgment", targetRef: { kind: "judgment", id: "J-2", text: "今年不会有新玩家" }, statement: "那条判断要收窄", basis: ["E1"] },
        disposition: { action: "watch", why: "先盯着", trigger: null },
        critic: { pass: true, checks: [], why: [], modelSlot: "alt" },
        card: { kind: "full", headline: "J-2｜今年不会有新玩家", body: "那条判断要收窄\n\n依据：[E1] 同类产品已发布", basis: ["E1"], chars: 24 },
      },
    });
  };

  it("只有预研时，对话上下文里带着台账、靶点与那一句落点", async () => {
    await withStages("ISS-T16A");
    // `api.advisorContext` 的返回类型就是 `Promise<string>`，不用兜别的形状
    const text = await api.advisorContext("ISS-T16A");
    expect(text).toContain("E1｜同类产品已发布｜国家统计局｜A 档");
    expect(text).toContain("J-2");
    expect(text).toContain("这家新公司要不要盯");
  });

  it("证据编号跟卡上印的是同一个 —— 进对话不重编号、不重取", async () => {
    await withStages("ISS-T16B");
    const { __getPreResearchRoundForTest } = await import("./store");
    const text = await api.advisorContext("ISS-T16B");
    // 从库里读回来那份上印的编号，不是从测试自己手上那份字面量上读
    const onCard = __getPreResearchRoundForTest("ISS-T16B").cur!.stages!.card.basis[0];
    expect(onCard).toBe("E1");
    expect(text).toContain(onCard);
  });

  it("新加的几段排在「这一页他只做一个决定」之前 —— 那句收尾指令仍然是这一段的最后一句", async () => {
    await withStages("ISS-T16C");
    const text = await api.advisorContext("ISS-T16C");
    /*
     * 为什么这条要单独立一条：那句话是给模型的**收尾指令**，是上面所有材料的框。
     * 材料排到框后面，读起来就成了「先给你规矩、再塞一堆料」，而模型对最后一段最听话。
     * 这一条是拆那次 `lines.push` 的全部理由，拆歪了它必红。
     */
    for (const marker of ["## 证据台账", "## 这条撞上的既有判断", "## 参谋这一轮的提案"]) {
      expect(text.indexOf(marker)).toBeGreaterThan(-1);
      expect(text.indexOf("这一页他只做一个决定")).toBeGreaterThan(text.indexOf(marker));
    }
  });

  it("v1 那份预研（没有 stages）一个字都没变，那句话照旧在末尾", async () => {
    await seedIssue("ISS-T16D", "旧的一条", []);
    const { __seedPreResearchDocForTest } = await import("./store");
    // 没有 `stages` 的一份 —— 库里躺着的旧预研就是这个形状
    __seedPreResearchDocForTest("ISS-T16D", {
      issueId: "ISS-T16D", status: "valid", statusReason: "r", question: "旧的问题",
      take: "t", finding: [], openQuestion: [], soWhat: "旧的落点",
      byAgentLabel: "您的 Agent", assembledFrom: [], at: "2026-08-27T00:00:00.000Z",
    });
    const text = await api.advisorContext("ISS-T16D");
    expect(text).toContain("你的落点：旧的落点");
    expect(text).not.toContain("## 证据台账");
    // 拆 `lines.push` 之后这两句仍然紧挨着（中间只隔一个空行）—— 数组内容一字不差
    expect(text).toContain("你的落点：旧的落点\n\n这一页他只做一个决定");
  });
});

/*
 * **这一组是补上来的，不在计划里。** 计划那两条（「证据编号跟卡上印的是同一个」与
 * 「只有预研时带着台账」）实测拦不住两个真会犯的错：
 *
 * 1. 台账那一层按下标现编一套编号 —— 上面那条只摆了一条 `E1`，重编号之后还是 `E1`，
 *    照样绿。所以这里摆两条**不连续**的编号，且卡上 `basis` 指的是后一条。
 * 2. 装配上下文时顺手把证据再抓一次 —— 上面那两条读不出这件事。这里在装配前后各读
 *    一次库里那份台账逐字比：同一条证据再抓一次拿到的可能是改过的页面，那时同一个
 *    编号在卡上和在对话里指的就不是同一份原文了。
 */
describe("Discuss 接缝的两条要害", () => {
  /** 编号故意不连续、也不从 1 起：`E7` 与 `E12`，卡上那一句依据的是 `E12`。 */
  const withOddIds = async (issueId: string) => {
    await seedIssue(issueId, "编号要原样带过去", ["某公司发布了同类产品。"]);
    const { __seedPreResearchDocForTest } = await import("./store");
    __seedPreResearchDocForTest(issueId, {
      issueId, status: "valid", statusReason: "r",
      question: "编号要原样带过去", take: "t", finding: [], openQuestion: [],
      soWhat: "先待定", byAgentLabel: "您的 Agent", assembledFrom: [],
      at: "2026-08-27T00:00:00.000Z",
      stages: {
        entities: [],
        hits: [],
        blindspot: { isBlindspot: false, proximity: "far", hops: null, credibility: null, magnitude: "unknown", why: [] },
        evidence: [
          { id: "E7", claim: "同类产品已发布", sourceRef: "https://a.gov.cn/x", sourceName: "国家统计局", date: "2026-08-27T00:00:00.000Z", tier: "A", cosourceKey: "dom:a.gov.cn", provenance: { issueId, stage: "pre_research" } },
          { id: "E12", claim: "首批签了三家银行", sourceRef: "https://b.example.com/y", sourceName: "某财经媒体", date: "2026-08-27T00:00:00.000Z", tier: "C", cosourceKey: "dom:b.example.com", provenance: { issueId, stage: "pre_research" } },
        ],
        searchless: false,
        impact: { impactType: "weakens", proposalType: "adjustJudgment", targetRef: null, statement: "那条判断要收窄", basis: ["E12"] },
        disposition: { action: "watch", why: "先盯着", trigger: null },
        critic: { pass: true, checks: [], why: [], modelSlot: "alt" },
        card: { kind: "full", headline: "h", body: "那条判断要收窄\n\n依据：[E12] 首批签了三家银行", basis: ["E12"], chars: 24 },
      },
    });
  };

  it("卡上写的是 E12，对话里读到的就还是 E12 —— 不按下标重编一套", async () => {
    await withOddIds("ISS-T16E");
    const { __getPreResearchRoundForTest } = await import("./store");
    const text = await api.advisorContext("ISS-T16E");
    const onCard = __getPreResearchRoundForTest("ISS-T16E").cur!.stages!.card.basis[0];

    expect(onCard).toBe("E12");
    expect(text).toContain("E12｜首批签了三家银行｜某财经媒体｜C 档");
    expect(text).toContain("E7｜同类产品已发布｜国家统计局｜A 档");
    // 重编号的实现会把这两条印成 E1/E2 —— 这两句是拦它的那一道
    expect(text).not.toContain("E1｜");
    expect(text).not.toContain("E2｜");
  });

  it("装配上下文只读不取 —— 前后两次读库里那份台账逐字相同，两次装配也逐字相同", async () => {
    await withOddIds("ISS-T16F");
    const { __getPreResearchRoundForTest } = await import("./store");
    const before = __getPreResearchRoundForTest("ISS-T16F").cur!.stages!.evidence;

    const first = await api.advisorContext("ISS-T16F");
    const second = await api.advisorContext("ISS-T16F");

    // 再抓一次会换掉 URL、抓取时刻或说法里的至少一样东西；一样都不许换
    expect(__getPreResearchRoundForTest("ISS-T16F").cur!.stages!.evidence).toEqual(before);
    expect(second).toBe(first);
  });

  it("台账那一段自带一个空行 —— 不跟「你的落点：…」黏成同一段", async () => {
    /*
     * 也是补的：原来那个空行被收尾指令那一次 `push` 带走了，新加的这块得自己带一个。
     * 计划正文点名了这件事，但它给的四条用例一条都拦不住 —— 去掉那个 `""` 全绿。
     * 黏在一起之后，落点那一句和台账第一行会被读成同一段话。
     */
    await withOddIds("ISS-T16G");
    const text = await api.advisorContext("ISS-T16G");
    expect(text).toContain("你的落点：先待定\n\n## 证据台账");
  });
});
