/*
 * 这个文件前两段测纯函数（不碰库），后面几段走真 store。
 *
 * **整个文件跑 demo 那一档** —— `beforeAll` 里设的（理由写在那里）。仓库的成例是把档写在
 * 文件名上（`store.triggers.demo.test.ts`），这个文件没有拆：前两段是纯函数、与档无关，
 * 拆出去要动它们的归属，不值。代价是往这个文件里加一条要 live 档的用例会被静默切到
 * demo —— 所以这句话写在这儿。
 *
 * store 那几段照 `store.judgements.test.ts` 头部那套：环境变量必须在任何碰到 store.ts
 * 的 import 之前设好，所以用 `beforeAll` + `await import()`。**上面所有静态 import 都是
 * `import type` 或者本身不碰 store**，这条纪律是那一套成立的前提（`revision.ts` 一个
 * import 都没有，它只是那个只往上走的号本身）。
 */
import { beforeAll, describe, expect, it } from "vitest";
import { revision } from "@/lib/data/revision";
import type { Evidence } from "@/lib/research/ledger";
import type { ResearchDoc } from "@/lib/data/types";
import { armsOf, landMicroEvidence, planLanding } from "./land";

const ev = (id: string, claim: string) =>
  ({ id, claim, exactQuote: `${claim}（原文）`, siteName: "国家统计局", sourceTier: "A",
     sourceDomain: "stats.gov.cn", url: "https://x", retrievedAt: "2026-08-26", independenceGroup: "G1" } as unknown as Evidence);

const docWith = (ledger?: Evidence[], slimIds: string[] = []) =>
  ({ ledger, blocks: slimIds.length ? { evidence: slimIds.map((id) => ({ id })) } : undefined } as unknown as ResearchDoc);

describe("追加台账", () => {
  it("接着现有最大号往下编 —— 不许和报告里那几条撞号", () => {
    const r = landMicroEvidence(docWith([ev("E1", "旧"), ev("E7", "旧")]), [ev("E1", "新")]);
    expect(r.added).toEqual(["E8"]);
    // 断言落在结果台账上：旧的两条一个都没被顶掉，新的那条挂在新号下。
    expect(r.doc.ledger!.map((e) => e.id)).toEqual(["E1", "E7", "E8"]);
    expect(r.doc.ledger!.find((e) => e.id === "E8")!.claim).toBe("新");
  });

  it("取数值最大而不是字典序最大 —— E3 与 E12 并存时新号是 E13", () => {
    const r = landMicroEvidence(docWith([ev("E3", "旧"), ev("E12", "旧")]), [ev("E1", "新")]);
    expect(r.added).toEqual(["E13"]);
    expect(r.doc.ledger!.map((e) => e.id)).toEqual(["E3", "E12", "E13"]);
  });

  it("不像 E{数字} 的 id 跳过、不抛、不影响编号", () => {
    const r1 = landMicroEvidence(docWith([ev("E1", "旧"), ev("X1", "跳过"), ev("E", "跳过")]), [ev("E1", "新")]);
    expect(r1.added).toEqual(["E2"]);
    const r2 = landMicroEvidence(docWith([ev("Eabc", "跳过")]), [ev("E1", "新")]);
    expect(r2.added).toEqual(["E1"]);
  });

  it("老报告只有速查那一份时也不撞号 —— 两份用的是同一套编号", () => {
    const r = landMicroEvidence(docWith(undefined, ["E1", "E2", "E3"]), [ev("E1", "新")]);
    expect(r.added).toEqual(["E4"]);
  });

  it("台账原来是空的就从 E1 起", () => {
    expect(landMicroEvidence(docWith(), [ev("E1", "新")]).added).toEqual(["E1"]);
  });

  it("不原地改入参 —— 调用方要拿新的那一份写回去", () => {
    const before = docWith([ev("E1", "旧")]);
    const r = landMicroEvidence(before, [ev("E1", "新")]);
    expect(before.ledger).toHaveLength(1);
    expect(r.doc).not.toBe(before);
  });

  it("一条都没有就原样回，不留空编号", () => {
    const before = docWith([ev("E1", "旧")]);
    const r = landMicroEvidence(before, []);
    expect(r.added).toEqual([]);
    expect(r.doc.ledger!.map((e) => e.id)).toEqual(["E1"]);
  });
});

const CANDIDATE = {
  statement: "面板这一轮不扩产：口径换算之后前三家份额还在 52%，不是市场传的 48%",
  basis: "[E1] 按出货面积算的份额；[E2] 片数口径与面积口径的换算",
  boundary: "只说这一轮不扩产，不主张长期不扩",
  reopenIf: "前三家合计份额跌破 50%",
};

describe("摆盘（纯函数）", () => {
  it("arms 是 reopenIf 在前、外来那几条在后，空串和重复项摘掉", () => {
    expect(armsOf(CANDIDATE, ["行业统计改用片数口径", "", "前三家合计份额跌破 50%"]))
      .toEqual(["前三家合计份额跌破 50%", "行业统计改用片数口径"]);
    expect(armsOf({ reopenIf: undefined }, ["新线量产周期短于 12 个月"]))
      .toEqual(["新线量产周期短于 12 个月"]);
    expect(armsOf({ reopenIf: "  " }, [])).toEqual([]);
  });

  it("板上那一条来源是 dialogue，四栏原样抬过去，且没有 confirmed", () => {
    const p = planLanding({
      issueId: "ISS-1", candidate: CANDIDATE, revisesJudgmentId: "J-1",
      round: 3, at: "2026-08-27T00:00:00.000Z",
    });
    expect(p.board.origin).toBe("dialogue");
    expect(p.board.statement).toBe(CANDIDATE.statement);
    expect(p.board.basis).toBe(CANDIDATE.basis);
    expect(p.board.boundary).toBe(CANDIDATE.boundary);
    expect(p.board.reopenIf).toBe(CANDIDATE.reopenIf);
    expect(p.board.at).toBe("2026-08-27T00:00:00.000Z");
    expect(p.board.confirmed).toBeUndefined();
    expect(Object.keys(p.board)).not.toContain("id");     // 编号由板给
    /*
     * 溯源那一栏：板上每一条都要说得出打哪来的，而写错在屏幕上没有症状 —— 徽章照样
     * 有一枚，只是说的是假话。所以这里断言的是两栏的值，不是「有没有」。
     */
    expect(p.board.notes).toEqual([{ kind: "agent", source: "议事对话" }]);
  });

  it("图上那一条是 direction / ontology，锚在这一轮对谈上，arms 排好队", () => {
    const p = planLanding({
      issueId: "ISS-1", candidate: CANDIDATE, revisesJudgmentId: "J-1",
      extraArms: ["行业统计改用片数口径"], round: 3, at: "2026-08-27T00:00:00.000Z",
    });
    const n = p.node!;
    expect(n.standing).toBe("direction");
    expect(n.route).toBe("ontology");
    expect(n.by).toBe("agent");
    // 图上那一条也要说得出打哪来的，同板上那一条
    expect(n.knowledge).toEqual([{ kind: "agent", source: "议事对话" }]);
    // 摘出来单独读也读得懂的那一句、以及「凭什么算这件议题的事」
    expect(n.text).toBe(CANDIDATE.statement);
    expect(n.whyOnTopic).toBe("这一条是在这件议题的对谈里收敛出来的");
    expect(n.anchor).toEqual({ kind: "talk", round: 3 });
    expect(n.revisesJudgmentId).toBe("J-1");
    expect(n.nextStatement).toBe(CANDIDATE.statement);
    expect(n.boundaryNote).toBe(CANDIDATE.boundary);
    expect(n.arms).toEqual(["前三家合计份额跌破 50%", "行业统计改用片数口径"]);
    expect(n.revealAfterRound).toBe(0);                   // 落了就该看得见
    expect(n.confirmedAt).toBeUndefined();
    expect(n.decisionId).toBeUndefined();
  });

  it("没有在版判断可翻 → 只上板，不落图（落了就是个按下去既不布控也不翻任何判断的按钮）", () => {
    const p = planLanding({
      issueId: "ISS-1", candidate: CANDIDATE, revisesJudgmentId: null,
      round: 1, at: "2026-08-27T00:00:00.000Z",
    });
    expect(p.board.statement).toBe(CANDIDATE.statement);
    expect(p.node).toBeNull();
  });
});

/**
 * 台账夹具，两组独立源 —— 够过 `reviewCandidate` 那道「强判断 ≥2 独立源」的机检。
 *
 * 形状照 `settle.test.ts` 那一份：`independenceGroup` 真值长 `dom:<站点>` 这样，
 * 这里只填断言与机检用得到的两栏，其余靠 cast 省掉。
 */
const evGroup = (id: string, group: string) =>
  ({ id, independenceGroup: group }) as unknown as Evidence;
const TWO_GROUPS: Evidence[] = [
  evGroup("E1", "dom:stats.gov.cn"),
  evGroup("E2", "dom:mof.gov.cn"),
];

/**
 * 一次**机检能过、复核回 `pass: true`** 的对话。三件事都是机检的硬要求：
 * 判断这一轮真动了（`changed`）、回应里指得出台账上真有的编号（`findDesync` 判据 1）、
 * 台账上有两组独立源。罐头 `talk.verify` 回的是 `pass: true`。
 */
const PASSING_AGENT_TEXT = "按 [E1] 与 [E2] 的口径换算，我把判断收成这一句。";
const PASSING_CEO_TEXT = "你把依据摊开说。";

/** 前 30 个非空白字符与 `COLLIDE_V1` 完全相同、只差句尾那个数字的第二版候选。 */
const COLLIDE_V1 = {
  statement: "面板这一轮不扩产：口径换算之后前三家合计份额还在 52%，不是市场上传的 48%",
  basis: "[E1] 按出货面积算的份额",
  boundary: "只说这一轮",
  reopenIf: "前三家合计份额跌破 50%",
};
const COLLIDE_V2 = { ...COLLIDE_V1, statement: COLLIDE_V1.statement.replace("48%", "45%") };

/** 候选没写重开条件的那一档（`why` 的第三句、`queuedArms` 空数组）。 */
const NO_REOPEN = {
  statement: "面板设备折旧年限按 7 年而不是 5 年摊，现金流那张表要重算一遍",
  basis: "[E1] 同行三家的折旧政策",
  boundary: "只说折旧年限这一项",
};

describe("落库到他手上那一步为止", () => {
  let api: typeof import("@/lib/data/store").api;
  let settleTalkTurn: typeof import("./settle").settleTalkTurn;
  let talkHarness: typeof import("./fixtures/pressure").talkHarness;
  let seedResearched: typeof import("@/lib/data/store").__seedResearchedIssueForTest;
  /** 结算那一格「记下进这一轮之前判断是什么样子」的写者。生产上是同一个函数。 */
  let markTalkSettled: typeof import("@/lib/data/store").markTalkSettled;

  beforeAll(async () => {
    /*
     * `TKOS_MODE=demo`：live 那一档 `store.issues` 是空的（上线第一天那一屏，见
     * `store.candidate.test.ts`），而下面每一条都要一件**在动摇某条在版判断**的议题 ——
     * 那样的议题只有内容包里有。demo 档还顺带关掉了读板时那一轮 A5（`ensureJudgements`
     * 挡了 demo），于是「板上多了几条」只可能是本任务落上去的。
     */
    process.env.TKOS_MODE = "demo";
    process.env.TKOS_PERSIST = "0";
    process.env.TKOS_MODEL_MOCK = "1";
    ({ api, markTalkSettled, __seedResearchedIssueForTest: seedResearched } = await import("@/lib/data/store"));
    ({ settleTalkTurn } = await import("./settle"));
    ({ talkHarness } = await import("./fixtures/pressure"));
  });

  /**
   * 第 n 件真在动摇某条在版判断的议题 —— 另一条分支由 `settledIssue` 取。
   *
   * **按下确认的那两条各占一个下标**：确认会把那件议题的在版判断改写成候选那句、
   * triggers 永久布控、图上那条变成 confirmed。共用一件的话，后面几条跑在一件判断已经
   * 被改写确认过的议题上 —— 绿的理由就不是它们各自要证的那件事了。
   *
   * 种子里这样的议题只有八件，所以后面几条**复用**了下标 3 与 4：那两件上前一条测试
   * 一个字都没落成（一条候选为空就抛了、一条复核没过），而复用的那两条各带一句和
   * `CANDIDATE` 不同的候选，落的是各自那一句。
   */
  const shakingIssue = async (n = 0) => {
    let seen = 0;
    for (const s of await api.listIssues()) {
      const issue = await api.getIssue(s.id);
      if (issue.judgmentRefs.length === 0) continue;
      if (seen === n) return issue;
      seen++;
    }
    throw new Error(`种子里没有第 ${n + 1} 件在动摇在版判断的议题 —— 这条测试的前提变了`);
  };

  /** 一件**没有**在版判断可翻的议题（`judgmentRefs` 是空的）—— 只上板不落图那一档。 */
  const settledIssue = async () => {
    for (const s of await api.listIssues()) {
      const issue = await api.getIssue(s.id);
      if (issue.judgmentRefs.length === 0) return issue;
    }
    throw new Error("种子里没有一件不在动摇在版判断的议题 —— 这条测试的前提变了");
  };

  const propose = async (issueId: string, candidate: unknown = CANDIDATE) => {
    await api.proposeTalkPoint(issueId, {
      thesis: "面板这一轮不扩产",
      statements: ["口径换算之后份额还在 52%"],
      openQuestions: ["片数口径的换算系数是不是全行业一致"],
      candidate,
    });
  };

  it("落板 + 落图 + arms 排队，一路到他手上那一步为止", async () => {
    const issue = await shakingIssue(0);
    await propose(issue.id);

    /*
     * 「最近动静」那一栏（`touch`）要断言到「真的换了个时刻」，得先隔开一毫秒：
     * 单测里 `sleep()` 是个 `Promise.resolve()`（`TKOS_FAKE_LATENCY` 默认关），
     * 同一毫秒内 `nowIso()` 会回同一个串，那时候「没改」和「改了」长得一样。
     */
    const updatedBefore = issue.updatedAt;
    await new Promise((done) => setTimeout(done, 5));
    /*
     * 「库改过了」那一声（`persistSoon`）唯一能离线观测的面：号本单调递增。
     * 这个文件跑在 `TKOS_PERSIST=0`，写盘那一半本来就不发生，所以只能问号本 ——
     * 而 `touch` 与 `pushEvent` 都不动它，涨了就只可能是那一声。
     */
    const revBefore = revision();
    const r = await api.landTalkCandidate(issue.id, ["行业统计改用片数口径"]);
    expect(revision()).toBeGreaterThan(revBefore);
    expect((await api.getIssue(issue.id)).updatedAt).not.toBe(updatedBefore);

    const board = await api.getBoard(issue.id);
    const one = [...board.draft, ...board.confirmed].find((x) => x.id === r.boardId);
    expect(one).toBeDefined();
    expect(one!.origin).toBe("dialogue");
    expect(one!.statement).toBe(CANDIDATE.statement);
    expect(one!.basis).toBe(CANDIDATE.basis);
    expect(one!.reopenIf).toBe(CANDIDATE.reopenIf);
    expect(board.draft.some((x) => x.id === r.boardId)).toBe(true);      // 在上半层
    expect(one!.confirmed).toBeUndefined();
    expect(r.ref).toMatch(/^D\d+$/);                                    // 编号出自 refCodeOf

    const map = await api.listProbe(issue.id);
    const node = map.nodes.find((n) => n.id === r.nodeId);
    expect(node).toBeDefined();
    expect(node!.standing).toBe("direction");
    expect(node!.route).toBe("ontology");
    expect(node!.revisesJudgmentId).toBe(issue.judgmentRefs[0]);
    expect(node!.nextStatement).toBe(CANDIDATE.statement);
    expect(node!.arms).toEqual(["前三家合计份额跌破 50%", "行业统计改用片数口径"]);
    expect(r.queuedArms).toEqual(node!.arms);
    // 图上那一条也要说得出打哪来的、摘出来单独读也读得懂 —— 写错在屏幕上没有症状
    expect(node!.knowledge).toEqual([{ kind: "agent", source: "议事对话" }]);
    expect(node!.text).toBe(CANDIDATE.statement);
    expect(node!.whyOnTopic).toBe("这一条是在这件议题的对谈里收敛出来的");
    expect(one!.notes).toEqual([{ kind: "agent", source: "议事对话" }]);

    /*
     * 回执那句话整句对。**今天它落在哪：** 轮外结算收下它、记进这一轮的运营台账
     * （`settle.ts` 里那条「候选落地回执」）—— 屏幕上还没有入口，这条链上没有第二个
     * 消费方。所以「少一半」的后果今天是台账上一条说不清的记录，不是屏幕上的病。
     */
    expect(r.why).toBe(
      `已落到判断板（${r.ref}）与研究链路上，等你确认后布控 ${r.queuedArms.length} 条重开条件`,
    );

    /*
     * 时间线上那一条。断言 id 是因为它同时是去重键（`pushEvent` 按 id 整条替换）：
     * 同一句落两次不该在时间线上留两条。
     */
    const evt = (await api.getTimeline(issue.id)).find(
      (x) => x.id === `E-${issue.id}-talk-land-${r.boardId}`,
    );
    expect(evt).toBeDefined();
    expect(evt!.kind).toBe("judgment");
    expect(evt!.headline).toContain(r.ref);
    expect(evt!.detail).toContain(CANDIDATE.statement);
  });

  it("落完之后一条 trigger 都没布控；他按下确认，这时才布控", async () => {
    const issue = await shakingIssue(1);
    await propose(issue.id);
    const r = await api.landTalkCandidate(issue.id, ["行业统计改用片数口径"]);
    const jid = issue.judgmentRefs[0];

    /*
     * **先把守卫钉成非空。** 下面两处断言都藏在 `for (const text of r.queuedArms)` 里，
     * 而 `queuedArms` 为空时整块循环一次都不执行 —— 那时候 `:322` 那条
     * `after.length === before.length + r.queuedArms.length` 也退化成 `x === x`，
     * 整条测试变成一句「什么都没发生」的恒真。（实测：`armsOf` 开头加一句
     * `return out;` 让它永远回空数组，单跑这一条是绿的。）
     */
    expect(r.queuedArms).toEqual(["前三家合计份额跌破 50%", "行业统计改用片数口径"]);

    const before = (await api.getJudgment(jid)).judgment.reopenTriggers;
    for (const text of r.queuedArms) {
      expect(before.some((t) => t.text === text)).toBe(false);   // 还没有他的批准，一条都没上
    }

    // 这一下就是「他按下确认」。测试代码在这里扮的是那个人 —— 被测代码永远走不到这里。
    const { ir } = await api.confirmCandidate(issue.id, r.nodeId!);
    expect(ir.standing).toBe("confirmed");

    const after = (await api.getJudgment(jid)).judgment.reopenTriggers;
    expect(after.length).toBe(before.length + r.queuedArms.length);
    for (const text of r.queuedArms) {
      const hit = after.find((t) => t.text === text);
      expect(hit).toBeDefined();
      expect(hit!.armed).toBe(true);
      expect(hit!.id).toContain(`RT-${jid}-`);
    }
    expect((await api.getJudgment(jid)).judgment.statement).toBe(CANDIDATE.statement);
  });

  it("同一句落两次：板上还是一条，图上还是一条", async () => {
    const issue = await shakingIssue(2);
    await propose(issue.id);
    const first = await api.landTalkCandidate(issue.id, ["行业统计改用片数口径"]);
    /*
     * 第二次故意换一组重开条件。回执里那几条读的是**图上既有那一条**排着的，不是这一次
     * 的方案 —— 去重命中那一次方案里的东西一条都没落进去，照方案报等于告诉他「等你确认
     * 后布控新线量产周期那一条」，而按下确认真会布控的是第一次排上去的那两条。
     */
    const second = await api.landTalkCandidate(issue.id, ["新线量产周期短于 12 个月"]);
    expect(second.boardId).toBe(first.boardId);
    expect(second.nodeId).toBe(first.nodeId);
    expect(second.queuedArms).toEqual(["前三家合计份额跌破 50%", "行业统计改用片数口径"]);
    const board = await api.getBoard(issue.id);
    const same = [...board.draft, ...board.confirmed].filter(
      (x) => x.statement === CANDIDATE.statement,
    );
    expect(same).toHaveLength(1);
    const map = await api.listProbe(issue.id);
    expect(map.nodes.filter((n) => n.nextStatement === CANDIDATE.statement)).toHaveLength(1);
  });

  it("候选为空时抛，不静默落一条空判断上板", async () => {
    const issue = await shakingIssue(3);
    await api.proposeTalkPoint(issue.id, {
      thesis: "面板这一轮不扩产", statements: ["口径换算之后份额还在 52%"],
      openQuestions: ["换算系数是不是全行业一致"], candidate: null,
    });
    /*
     * 断言到文案：裸 `rejects.toThrow()` 对 `findIssue` 抛的「议题不存在」也绿 ——
     * 那时候这条测试证的是「议题号打错了」，不是「候选为空不落空判断」。
     */
    await expect(api.landTalkCandidate(issue.id)).rejects.toThrow(
      "现在没有待落的候选判断 —— 先在对谈里把它聊到收敛。",
    );
  });

  it("复核没过就一条都不落 —— 板上不收集参谋的猜测", async () => {
    const issue = await shakingIssue(4);
    await propose(issue.id);
    const before = await api.getBoard(issue.id);

    /*
     * 走 `settle.ts` 自己那条 `forcedDesync` 路：候选在库里、`agentText` 里一个
     * `[E{n}]` 都指不出来 —— 于是 settle 自己构造一条 desync 强制进复核，机检第一道
     * 必打回（一次模型都不叫）。这是生产路径，不是把库摆成一个手工的坏状态。
     *
     * **`landTalkCandidate` 这一格真的接上了**：不接的话下面那两条断言恒真。
     */
    await settleTalkTurn(talkHarness(), issue.id, {
      api: {
        getTalkPoint: (id) => api.getTalkPoint(id),
        recordDeliberationEntry: (id, e) => api.recordDeliberationEntry(id, e),
        listDeliberationLog: (id) => api.listDeliberationLog(id),
        markTalkSettled: (id, judgement) => markTalkSettled(id, judgement),
        landTalkCandidate: (id) => api.landTalkCandidate(id),
      },
      ledger: [],
      nowTurn: 1,
      agentText: "我改主意了 —— 这一轮先不扩产。",
      ceoText: "你再想想。",
    });

    const after = await api.getBoard(issue.id);
    expect(after.draft.length).toBe(before.draft.length);
    // 更贴题的那一条：那句候选本身一个字都没进板。
    expect(
      [...after.draft, ...after.confirmed].some((x) => x.statement === CANDIDATE.statement),
    ).toBe(false);
    // 图上也没有待确认项 —— 复核没过就不该出现一个能按的按钮。
    expect(
      (await api.listProbe(issue.id)).nodes.some((n) => n.nextStatement === CANDIDATE.statement),
    ).toBe(false);
  });

  /*
   * 下面两条钉的是**两个各自独立的接头**，一条测一个，不合并：
   *
   * 1. `settle.ts` 里 `if (point.candidate && api.landTalkCandidate) await …` 那一句 ——
   *    复核过了之后真的去落地。
   * 2. `store.ts` 的 `settleTurn` 里 `landTalkCandidate: (id) => …` 那一格注入 ——
   *    生产上那个门面上真的有这一格。
   *
   * 上面那条「复核没过就一条都不落」只证得了门面接上了、`doSettle` 真跑到了那里；
   * 把分支和调用一起摘掉它照样绿。正向那一步只有下面两条看得见。
   */

  it("复核过了：settle 那条路真的把候选落到板上与图上", async () => {
    const issue = await shakingIssue(5);
    await propose(issue.id);

    /*
     * 一次机检能过的结算：判断这一轮真动了（thesis → 候选那句）、回应里指得出台账上
     * 真有的两个编号、台账上是两组独立源。三道都过了才轮到罐头复核回 `pass: true`。
     */
    await settleTalkTurn(talkHarness(), issue.id, {
      api: {
        getTalkPoint: (id) => api.getTalkPoint(id),
        recordDeliberationEntry: (id, e) => api.recordDeliberationEntry(id, e),
        listDeliberationLog: (id) => api.listDeliberationLog(id),
        markTalkSettled: (id, judgement) => markTalkSettled(id, judgement),
        landTalkCandidate: (id) => api.landTalkCandidate(id),
      },
      ledger: TWO_GROUPS,
      nowTurn: 1,
      agentText: PASSING_AGENT_TEXT,
      ceoText: PASSING_CEO_TEXT,
    });

    const board = await api.getBoard(issue.id);
    const one = board.draft.find((x) => x.statement === CANDIDATE.statement);
    expect(one).toBeDefined();                      // 落地那一句被摘掉时红在这里
    expect(one!.origin).toBe("dialogue");
    expect(one!.confirmed).toBeUndefined();         // 落在上半层，等他确认

    const node = (await api.listProbe(issue.id)).nodes.find(
      (n) => n.nextStatement === CANDIDATE.statement,
    );
    expect(node).toBeDefined();
    expect(node!.standing).toBe("direction");
    expect(node!.arms).toEqual([CANDIDATE.reopenIf]);

    // 落完这一步一条重开条件都没布控 —— 布控只发生在他按下确认那一下
    const triggers = (await api.getJudgment(issue.judgmentRefs[0])).judgment.reopenTriggers;
    expect(triggers.some((t) => t.text === CANDIDATE.reopenIf)).toBe(false);
  });

  it("生产那条结算路（他说一句、参谋答一句）也真的落到板上与图上", async () => {
    const issue = await shakingIssue(6);
    /*
     * 生产那条路上台账是从库里那份报告取的（`settleTurn` 自己去 `researchDocs` 拿），
     * 递不进来 —— 所以两组独立源得种在报告上。
     */
    seedResearched(
      issue.id,
      {
        issueId: issue.id,
        judgment: [{ text: "判断", traces: [] }],
        keyEvidence: [{ text: "证据", traces: [] }],
        counters: [{ text: "反证", traces: [] }],
        unknowns: [{ text: "不确定", traces: [] }],
        routeSuggestion: "建议上会",
        byAgentLabel: "CEO Agent",
        assembledFrom: [],
        sourceText: "## 核心判断\n\n判断。",
        at: "2026-08-27T00:00:00.000Z",
        ledger: TWO_GROUPS,
      },
      { text: "面板这一轮要不要扩产", suggestedDri: "测试人", deadline: "48小时" },
    );
    await propose(issue.id);

    await api.openAdvisorTurn(issue.id, PASSING_CEO_TEXT);
    const thread = await api.recordAdvisorReply(issue.id, PASSING_AGENT_TEXT);
    const nowTurn = thread.filter((m) => m.role === "agent").length;

    /*
     * 汇合点。`recordAdvisorReply` 里那一下**故意不 await**，但 `settleTalkTurn` 是同步
     * 登记那个键的，所以上面这个 await 回来时那一次结算已经在飞。同一个键再进一次，
     * 等到的是同一个 Promise —— 它跑完，落地那一步也就跑完了。
     *
     * **这个门面上故意没有 `landTalkCandidate`**：这一路上落地只可能来自 `store.ts` 里
     * 注入的那一格。`mine` 钉住了「等到的确实是生产那一次」—— 万一判重没命中，下面
     * 这次调用会自己跑一遍结算，那时 `mine` 是 true，而下面几条断言就不再是在说生产路。
     */
    let mine = false;
    await settleTalkTurn(talkHarness(), issue.id, {
      api: {
        getTalkPoint: (id) => {
          mine = true;
          return api.getTalkPoint(id);
        },
        recordDeliberationEntry: (id, e) => api.recordDeliberationEntry(id, e),
        listDeliberationLog: (id) => api.listDeliberationLog(id),
        markTalkSettled: (id, judgement) => markTalkSettled(id, judgement),
      },
      ledger: TWO_GROUPS,
      nowTurn,
      agentText: PASSING_AGENT_TEXT,
      ceoText: PASSING_CEO_TEXT,
    });
    expect(mine).toBe(false);

    /*
     * 只断言「那一句在板上、图上有那一条」，不数条数：A6 萃取跑在同一条路上、同一时刻，
     * 板上多几条少几条不由这一条测试说了算。
     */
    const board = await api.getBoard(issue.id);
    expect(board.draft.some((x) => x.statement === CANDIDATE.statement)).toBe(true);
    const node = (await api.listProbe(issue.id)).nodes.find(
      (n) => n.nextStatement === CANDIDATE.statement,
    );
    expect(node).toBeDefined();
    expect(node!.standing).toBe("direction");
  });

  it("他确认过之后再落一次：不当待确认项报，也不说「等你确认」", async () => {
    const issue = await shakingIssue(7);
    await propose(issue.id);
    const first = await api.landTalkCandidate(issue.id, ["行业统计改用片数口径"]);

    // 这一下是「他按下确认」。测试代码在这里扮的是那个人 —— 被测代码永远走不到这里。
    await api.confirmCandidate(issue.id, first.nodeId!);

    /*
     * `confirmCandidate` 不清空候选、也不动板上那一条，所以复核下一轮再过一次就会重落
     * 同一句。那一路上回执不许说「等你确认后布控 N 条」——那几条早在他确认那一下布控完了。
     */
    const again = await api.landTalkCandidate(issue.id, ["行业统计改用片数口径"]);
    expect(again.boardId).toBe(first.boardId);
    expect(again.nodeId).toBeNull();
    expect(again.queuedArms).toEqual([]);
    expect(again.why).toBe(`这一条你已经确认过了，判断板上那条（${first.ref}）还在原处`);
    expect(again.why).not.toContain("等你确认");

    // 图上还是他确认过的那一条，没有新起一个按不动的按钮
    const nodes = (await api.listProbe(issue.id)).nodes.filter(
      (n) => n.nextStatement === CANDIDATE.statement,
    );
    expect(nodes).toHaveLength(1);
    expect(nodes[0].standing).toBe("confirmed");

    // 重开条件也没被布控第二遍
    const triggers = (await api.getJudgment(issue.judgmentRefs[0])).judgment.reopenTriggers;
    expect(triggers.filter((t) => t.text === CANDIDATE.reopenIf)).toHaveLength(1);
  });

  it("第二版候选只改了句尾：交一份说清楚的回执，不抛，也不把板上那句旧的静默报成落成了", async () => {
    const issue = await shakingIssue(3);
    /*
     * 前提机械地验一遍，不写在注释里当承诺：板按正文前 30 个非空白字符去重，
     * 图按整句去重 —— 这两句正好落在两条判据的中间。
     */
    const boardKey = (t: string) => t.replace(/\s/g, "").slice(0, 30);
    expect(boardKey(COLLIDE_V2.statement)).toBe(boardKey(COLLIDE_V1.statement));
    expect(COLLIDE_V2.statement).not.toBe(COLLIDE_V1.statement);

    await propose(issue.id, COLLIDE_V1);
    const first = await api.landTalkCandidate(issue.id);

    await propose(issue.id, COLLIDE_V2);
    /*
     * **不抛。** 这条路的调用方是轮外结算，抛出去就落成运营台账上一条「这一轮结算失败」
     * —— 而撞车不是故障（见下面那条 A6 的用例：一次正常的并发就能撞上）。
     */
    const second = await api.landTalkCandidate(issue.id);

    // 回执指的是板上真有的那一条（前一句），而不是这一次要落的那一句
    expect(second.boardId).toBe(first.boardId);
    expect(second.ref).toBe(first.ref);
    // 没落图、没有东西排队等着布控
    expect(second.nodeId).toBeNull();
    expect(second.queuedArms).toEqual([]);
    /*
     * 这句话不许说「已落到判断板」，得说清这一次这一句没落上去。**今天它落在哪：**
     * 轮外结算收下它、记进这一轮的运营台账（`settle.ts` 里那条「候选落地回执」）——
     * 屏幕上还没有入口。写错的后果是回头翻账的人读到一句假话，不是屏幕上的病。
     */
    expect(second.why).toContain(`开头相同的判断（${first.ref}）`);
    expect(second.why).toContain("这一句这次没落上去");
    expect(second.why).not.toContain("已落到判断板");
    expect(second.why).not.toContain("等你确认");

    // 板上仍然只有前一句，后一句一个字都没进去
    const all = await api.getBoard(issue.id).then((b) => [...b.draft, ...b.confirmed]);
    expect(all.filter((x) => boardKey(x.statement) === boardKey(COLLIDE_V1.statement)))
      .toHaveLength(1);
    expect(all.some((x) => x.statement === COLLIDE_V2.statement)).toBe(false);
    // 图上也没有挂后一句的待确认项 —— 他确认后写进在版判断的不能是一句板上没有的话
    expect(
      (await api.listProbe(issue.id)).nodes.some((n) => n.nextStatement === COLLIDE_V2.statement),
    ).toBe(false);
    /*
     * 时间线上也不许多一条。那条痕迹说的是「对谈里聊定一条待确认判断 · D2」，而这一次
     * 板上图上一个字都没写成 —— 落一条等于账上说刚才又有一条在等他。
     */
    const marks = (await api.getTimeline(issue.id)).filter(
      (x) => x.id === `E-${issue.id}-talk-land-${first.boardId}`,
    );
    expect(marks).toHaveLength(1);
  });

  /*
   * **撞车经过生产那条结算路时，运营台账上要留下一条说得对的痕。**
   *
   * 这一条接着上面那条跑（同一件议题：板上留着 `COLLIDE_V1`，判断状态上挂着 `COLLIDE_V2`）。
   *
   * 它钉的是 I3 修完之后剩下的那半个洞：`landTalkCandidate` 照实交回一份说得清的回执，
   * 而轮外结算从前把返回值整个丢掉 —— 于是撞车那一路库里干干净净、不抛、台账记 `ok`，
   * **全链路没有任何一个地方说得出「刚才那一句没落上去」**。那比原来那个 `throw` 更糟：
   * 抛异常至少让人知道出过事（只是把性质记错成「结算失败」），丢掉回执之后连出过事都
   * 看不出来。
   *
   * 验收标准：把 `settle.ts` 里那条 `h.note("候选落地回执", …)` 删掉 → 这一条红。
   */
  it("撞车经过结算路：这一轮不记成失败，但台账上留得下「这一句没落上去」", async () => {
    const issue = await shakingIssue(3);
    // 前提：上一条已经把 COLLIDE_V1 落到板上、把 COLLIDE_V2 摆成当前候选
    const board = await api.getBoard(issue.id).then((b) => [...b.draft, ...b.confirmed]);
    expect(board.some((x) => x.statement === COLLIDE_V1.statement)).toBe(true);
    expect((await api.getTalkPoint(issue.id)).candidate?.statement).toBe(COLLIDE_V2.statement);

    const settled: import("@/lib/data/types").AgentRunRecord[] = [];
    await settleTalkTurn(talkHarness(), issue.id, {
      api: {
        getTalkPoint: (id) => api.getTalkPoint(id),
        recordDeliberationEntry: (id, e) => api.recordDeliberationEntry(id, e),
        listDeliberationLog: (id) => api.listDeliberationLog(id),
        markTalkSettled: (id, judgement) => markTalkSettled(id, judgement),
        landTalkCandidate: (id) => api.landTalkCandidate(id),
      },
      ledger: TWO_GROUPS,
      nowTurn: 1,
      agentText: PASSING_AGENT_TEXT,
      ceoText: PASSING_CEO_TEXT,
      accounting: { open: () => "run-collide", settle: (_id, r) => { settled.push(r); } },
    });

    // 这一轮不记成失败 —— 撞车是一次正常的并发，不是故障
    const rec = settled[0];
    expect(rec).toBeDefined();
    expect(rec.status).toBe("ok");

    // 而且台账上留得下「这一句没落上去」：回执被收下了，不是被丢掉
    const receipt = (rec.trace ?? []).find((n) => n.label === "候选落地回执");
    expect(receipt, "结算把落地回执整个丢掉了 —— 撞车成了一件无声的事").toBeDefined();
    expect(receipt!.detail.collided).toBe(true);
    expect(receipt!.detail.nodeId).toBeNull();
    expect(String(receipt!.detail.why)).toContain("这一句这次没落上去");

    // 库那一侧照旧一个字没写坏：板上仍是前一句，图上没有挂后一句的待确认项
    const after = await api.getBoard(issue.id).then((b) => [...b.draft, ...b.confirmed]);
    expect(after.some((x) => x.statement === COLLIDE_V2.statement)).toBe(false);
    expect(
      (await api.listProbe(issue.id)).nodes.some((n) => n.nextStatement === COLLIDE_V2.statement),
    ).toBe(false);
  });

  it("候选没写重开条件：照旧落图，但回执不说「布控 0 条」", async () => {
    const issue = await shakingIssue(4);
    await propose(issue.id, NO_REOPEN);
    const r = await api.landTalkCandidate(issue.id);
    expect(r.nodeId).not.toBeNull();
    expect(r.queuedArms).toEqual([]);
    expect(r.why).toBe(`已落到判断板（${r.ref}）与研究链路上，等你确认后翻版在版判断`);
    expect(r.why).not.toContain("0 条");
  });

  it("没有在版判断可翻：只上板，回执照实说链路上没有待确认项", async () => {
    const issue = await settledIssue();
    await propose(issue.id, NO_REOPEN);
    const r = await api.landTalkCandidate(issue.id);
    expect(r.nodeId).toBeNull();
    expect(r.queuedArms).toEqual([]);
    expect(r.why).toBe(
      `已落到判断板（${r.ref}）。这件议题现在没有在版判断可翻，所以链路上没有待确认项`,
    );
    expect(
      (await api.listProbe(issue.id)).nodes.some((n) => n.nextStatement === NO_REOPEN.statement),
    ).toBe(false);
  });
});
