/**
 * `settle.ts` 的测试：让步日志的机械规矩。
 *
 * **不造回放夹具。** 三套压力脚本 + `replay` 是下一个任务（Task 12）的产出，
 * 它会跑完整链。这个文件只钉住 `settle.ts` 自己那几条机械规矩。
 */

// 测试装置的硬规矩 1：env 必须在 import store 之前设好
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

import { beforeAll, describe, expect, it } from "vitest";

import type { AgentRunRecord } from "@/lib/data/types";
import type { Evidence } from "@/lib/research/ledger";

/**
 * 台账夹具。**`independenceGroup` 是字符串** —— 真值长 `dom:<站点>` / `src:<署名出处>`
 * 这样（`independence.assign`）。这里只填断言用得到的两栏，其余的靠 cast 省掉：
 * 这几条测试要的只是「有几组不同的源」。
 */
const ev = (id: string, group: string): Evidence =>
  ({ id, independenceGroup: group }) as unknown as Evidence;

/** 两组独立源 —— 够过 `reviewCandidate` 那道「强判断 ≥2 独立源」的机检。 */
const twoGroups: Evidence[] = [ev("E1", "dom:stats.gov.cn"), ev("E2", "dom:mof.gov.cn")];
/** 一组 —— 过不了那道机检。 */
const oneGroup: Evidence[] = [ev("E1", "dom:stats.gov.cn")];

/**
 * 这一次结算的 trace 上有没有某一条 note。
 *
 * 这是离线唯一能分辨「复核到底跑了没有」的观测面：`h.finish()` 把 trace 抄进那条运营
 * 台账记录里，而假模型的 `usage` 恒为空、`Harness.trace` 本身是私有的。
 */
const hasNote = (rec: AgentRunRecord | null, label: string): boolean =>
  (rec?.trace ?? []).some((n) => n.label === label);

/** 某一条 note 上记的东西（复核结论那条记的是 `pass` / `modelSlot` / `why`）。 */
const noteDetail = (rec: AgentRunRecord | null, label: string): Record<string, unknown> =>
  (rec?.trace ?? []).find((x) => x.label === label)?.detail ?? {};

describe("轮外结算：让步日志的机械规矩", () => {
  let api: typeof import("@/lib/data/store").api;
  let Harness: typeof import("@/lib/agent/harness").Harness;
  let settleTalkTurn: typeof import("./settle").settleTalkTurn;
  let __seedResearchedIssueForTest: typeof import("@/lib/data/store").__seedResearchedIssueForTest;
  /** 结算那一格「记下进这一轮之前判断是什么样子」的写者。生产上是同一个函数。 */
  let markTalkSettled: typeof import("@/lib/data/store").markTalkSettled;

  // 测试装置的硬规矩 1：store 相关的东西要在 beforeAll 里用 await import() 拿
  beforeAll(async () => {
    const storeModule = await import("@/lib/data/store");
    api = storeModule.api;
    markTalkSettled = storeModule.markTalkSettled;
    __seedResearchedIssueForTest = storeModule.__seedResearchedIssueForTest;

    const harnessModule = await import("@/lib/agent/harness");
    Harness = harnessModule.Harness;

    const settleModule = await import("./settle");
    settleTalkTurn = settleModule.settleTalkTurn;
  });

  /** 辅助函数：创建一条已经有报告的议题 */
  const researchedIssue = async (title: string): Promise<string> => {
    const issue = await api.addIssue(title);
    const doc = {
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
    };
    __seedResearchedIssueForTest(issue.id, doc, {
      text: "测试题",
      suggestedDri: "测试人",
      deadline: "48小时",
    });
    return issue.id;
  };

  it("判断动了那一轮：落一条 concede，trigger 里含本轮回应真引到的编号", async () => {
    // 准备：一条已经有报告的议题
    const issueId = await researchedIssue("测试议题1");

    // G6：设置 thesis 作为 before 的来源（因为日志为空时 before 取自 thesis）
    await api.proposeTalkPoint(issueId, { thesis: "初始判断" });

    // 更新判断（模拟轮内链已经做的事）
    await api.proposeTalkPoint(issueId, {
      candidate: { statement: "新判断", basis: "[E1] 和 [E2]" },
    });

    // 模拟一轮对话，回应里引用了 E1、E2
    const agentText = "根据 [E1] 和 [E2] 的证据，我认为应该调整为新判断。详细分析如下...";
    const ceoText = "我想知道这个判断的依据是什么？";

    // 执行结算
    const h = new Harness({ agent: "A5", slot: "pro" });
    await settleTalkTurn(h, issueId, {
      api: {
        getTalkPoint: (id: string) => api.getTalkPoint(id),
        recordDeliberationEntry: (id: string, e: unknown) => api.recordDeliberationEntry(id, e),
        listDeliberationLog: (id: string) => api.listDeliberationLog(id),
        markTalkSettled: (id: string, judgement: string) => markTalkSettled(id, judgement),
      },
      ledger: [],
      nowTurn: 1,
      agentText,
      ceoText,
    });

    // 断言：日志里有一条 concede
    const log = await api.listDeliberationLog(issueId);
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe("concede");
    expect(log[0].before).toBe("初始判断");
    expect(log[0].after).toBe("新判断");
    /*
     * trigger 断的是**派生出来的那个形状**，不是 `toContain("E1")`。
     *
     * `agentText` 本身就是「根据 [E1] 和 [E2] 的证据…」，所以只要 trigger 里带上回应
     * 的任意一段，`toContain("E1")` 就成立 —— 上一版实测：把 `settle.ts` 拼 trigger
     * 那一句换成 `trigger = context.slice(0, TRIGGER_MAX_CHARS)`（编号前缀整个丢掉），
     * settle + sycophancy + e2e 共 25 条全绿。
     *
     * `[E1]、[E2] — ` 这个前缀是 `citeText(citedIds(agentText))` 拼出来的，只有真抠到
     * 编号才有；后面那一段是原文截断。
     */
    expect(log[0].trigger.startsWith("[E1]、[E2] — ")).toBe(true);
    expect(log[0].trigger).toContain("的证据");   // 后面接的是回应原文，不是空的
  });

  it("判断没动那一轮：落一条 hold，before === after，trigger 里含他这一轮真说过的话", async () => {
    const issueId = await researchedIssue("测试议题2");

    // G6：设置 thesis 作为 before 的来源
    await api.proposeTalkPoint(issueId, { thesis: "坚持的判断" });
    // 再设置 candidate（与 thesis 一致，所以 after 也是"坚持的判断"）
    await api.proposeTalkPoint(issueId, {
      candidate: { statement: "坚持的判断", basis: "依据" },
    });

    // 模拟一轮对话，判断没动
    const agentText = "基于现有证据，我认为这个判断仍然成立。";
    const ceoText = "我不同意这个判断，你应该重新考虑。";

    // 执行结算（判断没变）
    const h = new Harness({ agent: "A5", slot: "pro" });
    await settleTalkTurn(h, issueId, {
      api: {
        getTalkPoint: (id: string) => api.getTalkPoint(id),
        recordDeliberationEntry: (id: string, e: unknown) => api.recordDeliberationEntry(id, e),
        listDeliberationLog: (id: string) => api.listDeliberationLog(id),
        markTalkSettled: (id: string, judgement: string) => markTalkSettled(id, judgement),
      },
      ledger: [],
      nowTurn: 1,
      agentText,
      ceoText,
    });

    // 断言：日志里有一条 hold
    const log = await api.listDeliberationLog(issueId);
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe("hold");
    expect(log[0].before).toBe(log[0].after); // before === after
    expect(log[0].before).toBe("坚持的判断");
    // trigger 里应该含他这一轮真说过的话（断言含子串）
    expect(log[0].trigger).toContain("我不同意");
  });

  it("kind 由 before === after 定，不由任何模型输出定", async () => {
    const issueId = await researchedIssue("测试议题3");

    // G6：设置 thesis
    await api.proposeTalkPoint(issueId, { thesis: "判断A" });
    await api.proposeTalkPoint(issueId, {
      candidate: { statement: "判断A", basis: "依据" },
    });

    const h = new Harness({ agent: "A5", slot: "pro" });
    await settleTalkTurn(h, issueId, {
      api: {
        getTalkPoint: (id: string) => api.getTalkPoint(id),
        recordDeliberationEntry: (id: string, e: unknown) => api.recordDeliberationEntry(id, e),
        listDeliberationLog: (id: string) => api.listDeliberationLog(id),
        markTalkSettled: (id: string, judgement: string) => markTalkSettled(id, judgement),
      },
      ledger: [],
      nowTurn: 1,
      agentText: "我坚持判断A。",
      ceoText: "你确定吗？",
    });

    const log = await api.listDeliberationLog(issueId);
    // kind 是 hold 因为 before === after，不管模型说了什么
    expect(log[0].kind).toBe("hold");
  });

  it("改判但回应里指不出编号 → settle 自己不落这一条（G2）", async () => {
    const issueId = await researchedIssue("测试议题4");

    // G6：设置 thesis
    await api.proposeTalkPoint(issueId, { thesis: "初始判断" });

    // 更新判断但回应里没有 [E{n}]
    await api.proposeTalkPoint(issueId, {
      candidate: { statement: "新判断", basis: "新依据" },
    });

    const h = new Harness({ agent: "A5", slot: "pro" });
    await settleTalkTurn(h, issueId, {
      api: {
        getTalkPoint: (id: string) => api.getTalkPoint(id),
        recordDeliberationEntry: (id: string, e: unknown) => api.recordDeliberationEntry(id, e),
        listDeliberationLog: (id: string) => api.listDeliberationLog(id),
        markTalkSettled: (id: string, judgement: string) => markTalkSettled(id, judgement),
      },
      ledger: [],
      nowTurn: 1,
      agentText: "我改变了想法，现在认为是新判断。", // 没有 [E{n}]
      ceoText: "为什么？",
    });

    // 断言：日志是空的（settle 自己决定不落，而不是被 checkEntry 拒）
    const log = await api.listDeliberationLog(issueId);
    expect(log).toHaveLength(0);

    // 留痕与「强制进复核」由下面那条「改判但指不出编号 → …→ 进台账」断言，
    // 它从记账端口拿到的记录上读 trace。这一条只管「日志不落」这一件事。
  });

  it("判断动了、回应里引到编号、但 ledger 是空的 → 照样落一条 concede（G6 新增）", async () => {
    const issueId = await researchedIssue("测试议题5");

    // G6：设置 thesis
    await api.proposeTalkPoint(issueId, { thesis: "初始判断" });

    // 更新判断
    await api.proposeTalkPoint(issueId, {
      candidate: { statement: "新判断", basis: "[E1] 和 [E2]" },
    });

    const h = new Harness({ agent: "A5", slot: "pro" });
    await settleTalkTurn(h, issueId, {
      api: {
        getTalkPoint: (id: string) => api.getTalkPoint(id),
        recordDeliberationEntry: (id: string, e: unknown) => api.recordDeliberationEntry(id, e),
        listDeliberationLog: (id: string) => api.listDeliberationLog(id),
        markTalkSettled: (id: string, judgement: string) => markTalkSettled(id, judgement),
      },
      ledger: [], // 空的 ledger
      nowTurn: 1,
      agentText: "根据 [E1] 和 [E2]，我改了判断。",
      ceoText: "为什么？",
    });

    // 断言：照样落一条 concede（撤回裁定三之后，独立源不足只影响复核结论，不再动判断状态）
    const log = await api.listDeliberationLog(issueId);
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe("concede");
    expect(log[0].before).toBe("初始判断");
    expect(log[0].after).toBe("新判断");
  });

  it("模块级 Map：同议题同轮并发两次 → 只跑一次", async () => {
    const issueId = await researchedIssue("测试议题6");

    // G6：设置 thesis
    await api.proposeTalkPoint(issueId, { thesis: "判断" });
    await api.proposeTalkPoint(issueId, {
      candidate: { statement: "判断", basis: "依据" },
    });

    const h = new Harness({ agent: "A5", slot: "pro" });
    const opts = {
      api: {
        getTalkPoint: (id: string) => api.getTalkPoint(id),
        recordDeliberationEntry: (id: string, e: unknown) => api.recordDeliberationEntry(id, e),
        listDeliberationLog: (id: string) => api.listDeliberationLog(id),
        markTalkSettled: (id: string, judgement: string) => markTalkSettled(id, judgement),
      },
      ledger: [],
      nowTurn: 1,
      agentText: "回应",
      ceoText: "问题",
    };

    // 并发调用两次
    await Promise.all([
      settleTalkTurn(h, issueId, opts),
      settleTalkTurn(h, issueId, opts),
    ]);

    // 断言：只落了一条日志
    const log = await api.listDeliberationLog(issueId);
    expect(log).toHaveLength(1);
  });

  it("跑完之后同轮再来一次 → 不重复落库（F9：成功的留下）", async () => {
    const issueId = await researchedIssue("测试议题7");

    // G6：设置 thesis
    await api.proposeTalkPoint(issueId, { thesis: "判断" });
    await api.proposeTalkPoint(issueId, {
      candidate: { statement: "判断", basis: "依据" },
    });

    const h = new Harness({ agent: "A5", slot: "pro" });
    const opts = {
      api: {
        getTalkPoint: (id: string) => api.getTalkPoint(id),
        recordDeliberationEntry: (id: string, e: unknown) => api.recordDeliberationEntry(id, e),
        listDeliberationLog: (id: string) => api.listDeliberationLog(id),
        markTalkSettled: (id: string, judgement: string) => markTalkSettled(id, judgement),
      },
      ledger: [],
      nowTurn: 1,
      agentText: "回应",
      ceoText: "问题",
    };

    // 第一次
    await settleTalkTurn(h, issueId, opts);
    const logAfterFirst = await api.listDeliberationLog(issueId);
    expect(logAfterFirst).toHaveLength(1);

    // 第二次（同轮）
    await settleTalkTurn(h, issueId, opts);
    const logAfterSecond = await api.listDeliberationLog(issueId);
    // 断言：仍然只有一条（不重复落库）
    expect(logAfterSecond).toHaveLength(1);
  });

  it("两边判断都是空串的第一轮 → 不落日志", async () => {
    const issueId = await researchedIssue("测试议题8");

    // 不设置任何判断，thesis 和 candidate 都是空的
    const h = new Harness({ agent: "A5", slot: "pro" });
    await settleTalkTurn(h, issueId, {
      api: {
        getTalkPoint: (id: string) => api.getTalkPoint(id),
        recordDeliberationEntry: (id: string, e: unknown) => api.recordDeliberationEntry(id, e),
        listDeliberationLog: (id: string) => api.listDeliberationLog(id),
        markTalkSettled: (id: string, judgement: string) => markTalkSettled(id, judgement),
      },
      ledger: [],
      nowTurn: 1,
      agentText: "还没有判断",
      ceoText: "我们来讨论一下",
    });

    // 断言：日志是空的
    const log = await api.listDeliberationLog(issueId);
    expect(log).toHaveLength(0);
  });

  /*
   * H4 补充。**断言看的是「复核到底跑了没有」，不是「记了几条账」**（J6）：
   * 记账每一轮都记一条（那是对的），所以 `accountingCalls` 在触发与不触发时完全一样 ——
   * 上一版三轮都断言 `toBe(1)`，测试名声称的那件事一条都没证明。
   * 分得开的观测面是 trace 上那两条 note：跑了复核记「候选判断复核」，没跑记「本轮未触发收敛检查」。
   */
  it("连着 3 轮 hold → 触发复核；连着 2 轮 → 不触发", async () => {
    const issueId = await researchedIssue("测试议题9");

    // 设置 thesis
    await api.proposeTalkPoint(issueId, { thesis: "判断不变" });
    await api.proposeTalkPoint(issueId, {
      candidate: { statement: "判断不变", basis: "依据" },
    });

    /** 跑一轮 hold，把那一轮落定的台账记录交回来。 */
    const holdTurn = async (nowTurn: number, ceoText: string): Promise<AgentRunRecord | null> => {
      let rec: AgentRunRecord | null = null;
      const h = new Harness({ agent: "A5", slot: "pro" });
      await settleTalkTurn(h, issueId, {
        api: {
          getTalkPoint: (id: string) => api.getTalkPoint(id),
          recordDeliberationEntry: (id: string, e: unknown) => api.recordDeliberationEntry(id, e),
          listDeliberationLog: (id: string) => api.listDeliberationLog(id),
          markTalkSettled: (id: string, judgement: string) => markTalkSettled(id, judgement),
        },
        ledger: twoGroups,
        nowTurn,
        agentText: "判断不变。",
        ceoText,
        accounting: { open: () => `run-${nowTurn}`, settle: (_id, r) => { rec = r; } },
      });
      return rec;
    };

    // 第 1、2 轮：连着 1 条、2 条 hold —— 不触发
    const rec1 = await holdTurn(1, "确定吗？");
    expect(hasNote(rec1, "本轮未触发收敛检查")).toBe(true);
    expect(hasNote(rec1, "候选判断复核")).toBe(false);

    const rec2 = await holdTurn(2, "真的确定？");
    expect(hasNote(rec2, "本轮未触发收敛检查")).toBe(true);
    expect(hasNote(rec2, "候选判断复核")).toBe(false);

    // 第 3 轮：恰好连着 3 条 hold —— 触发
    const rec3 = await holdTurn(3, "再想想？");
    expect(hasNote(rec3, "候选判断复核")).toBe(true);
    expect(hasNote(rec3, "本轮未触发收敛检查")).toBe(false);

    // 三轮都落了库，而且都是 hold
    const log = await api.listDeliberationLog(issueId);
    expect(log).toHaveLength(3);
    expect(log.every((e) => e.kind === "hold")).toBe(true);
  });

  // H4 补充：trigger 里的连续轮数对得上
  it("hold 的 trigger 里「连着第 N 轮」的 N 与日志实际的连续 hold 条数对得上", async () => {
    const issueId = await researchedIssue("测试议题10");

    await api.proposeTalkPoint(issueId, { thesis: "不动的判断" });
    await api.proposeTalkPoint(issueId, {
      candidate: { statement: "不动的判断", basis: "依据" },
    });

    // 第 1 轮 hold
    const h1 = new Harness({ agent: "A5", slot: "pro" });
    await settleTalkTurn(h1, issueId, {
      api: {
        getTalkPoint: (id: string) => api.getTalkPoint(id),
        recordDeliberationEntry: (id: string, e: unknown) => api.recordDeliberationEntry(id, e),
        listDeliberationLog: (id: string) => api.listDeliberationLog(id),
        markTalkSettled: (id: string, judgement: string) => markTalkSettled(id, judgement),
      },
      ledger: [],
      nowTurn: 1,
      agentText: "判断没变。",
      ceoText: "为什么？",
    });

    const log1 = await api.listDeliberationLog(issueId);
    expect(log1[0].trigger).toContain("连着第 1 轮");

    // 第 2 轮 hold
    const h2 = new Harness({ agent: "A5", slot: "pro" });
    await settleTalkTurn(h2, issueId, {
      api: {
        getTalkPoint: (id: string) => api.getTalkPoint(id),
        recordDeliberationEntry: (id: string, e: unknown) => api.recordDeliberationEntry(id, e),
        listDeliberationLog: (id: string) => api.listDeliberationLog(id),
        markTalkSettled: (id: string, judgement: string) => markTalkSettled(id, judgement),
      },
      ledger: [],
      nowTurn: 2,
      agentText: "判断还是没变。",
      ceoText: "再问一次。",
    });

    const log2 = await api.listDeliberationLog(issueId);
    expect(log2[1].trigger).toContain("连着第 2 轮");
  });

  // H4 补充：H1 强制进复核的路 - 改判但指不出编号
  it("改判但指不出编号 → settle 构造 desync 强制进复核 → 机检打回 → 进台账", async () => {
    const issueId = await researchedIssue("测试议题11");

    await api.proposeTalkPoint(issueId, { thesis: "初始判断" });
    await api.proposeTalkPoint(issueId, {
      candidate: { statement: "新判断", basis: "无依据" },
    });

    const settled: AgentRunRecord[] = [];

    const h = new Harness({ agent: "A5", slot: "pro" });
    await settleTalkTurn(h, issueId, {
      api: {
        getTalkPoint: (id: string) => api.getTalkPoint(id),
        recordDeliberationEntry: (id: string, e: unknown) => api.recordDeliberationEntry(id, e),
        listDeliberationLog: (id: string) => api.listDeliberationLog(id),
        markTalkSettled: (id: string, judgement: string) => markTalkSettled(id, judgement),
      },
      ledger: oneGroup,
      nowTurn: 1,
      agentText: "我改变主意了，新判断更对。",  // 没有 [E{n}]
      ceoText: "为什么？",
      accounting: { open: () => "run-forced-1", settle: (_runId, rec) => { settled.push(rec); } },
    });

    // 断言：日志是空的（因为指不出编号）
    const log = await api.listDeliberationLog(issueId);
    expect(log).toHaveLength(0);

    // 断言：这一次真的记了账，而且落定了（`settle` 只在 `open` 给过 runId 时才调）
    expect(settled).toHaveLength(1);
    const rec = settled[0] ?? null;
    expect(rec?.status).toBe("ok");

    // 断言：复核真的跑了，而且是机检打回（`modelSlot` 为 null = 这一下没花模型调用）
    expect(hasNote(rec, "候选判断复核")).toBe(true);
    const d = noteDetail(rec, "候选判断复核");
    expect(d.pass).toBe(false);
    expect(d.modelSlot).toBeNull();
    expect((d.why as string[]).join("")).toContain("指不出任何证据编号");
  });

  // H4 补充：H1 强制进复核的路 - checkEntry 拒了
  it("checkEntry 拒了 → settle 构造 desync 强制进复核 → 机检打回 → 进台账", async () => {
    const issueId = await researchedIssue("测试议题12");

    await api.proposeTalkPoint(issueId, { thesis: "初始判断" });
    await api.proposeTalkPoint(issueId, {
      candidate: { statement: "新判断", basis: "[E1]" },
    });

    const settled: AgentRunRecord[] = [];

    const h = new Harness({ agent: "A5", slot: "pro" });
    await settleTalkTurn(h, issueId, {
      api: {
        getTalkPoint: (id: string) => api.getTalkPoint(id),
        // 模拟 checkEntry 拒绝
        recordDeliberationEntry: async () => {
          throw new Error("trigger 命中黑名单");
        },
        listDeliberationLog: (id: string) => api.listDeliberationLog(id),
        markTalkSettled: (id: string, judgement: string) => markTalkSettled(id, judgement),
      },
      ledger: oneGroup,
      nowTurn: 1,
      agentText: "根据 [E1]，新判断更对。",
      ceoText: "为什么？",
      accounting: { open: () => "run-forced-2", settle: (_runId, rec) => { settled.push(rec); } },
    });

    // 断言：日志是空的（因为被拒了）
    const log = await api.listDeliberationLog(issueId);
    expect(log).toHaveLength(0);

    expect(settled).toHaveLength(1);
    const rec = settled[0] ?? null;
    expect(rec?.status).toBe("ok");

    // 断言：复核真的跑了，是机检打回，而且被拒的理由带进了 why
    expect(hasNote(rec, "候选判断复核")).toBe(true);
    const d = noteDetail(rec, "候选判断复核");
    expect(d.pass).toBe(false);
    expect(d.modelSlot).toBeNull();
    expect((d.why as string[]).join("")).toContain("trigger 命中黑名单");
  });

  /*
   * J4：`forcedDesync` 与 `findDesync` 不是互斥的两个来源。
   *
   * 这一条钉的是「一轮既日志被卡住、又历史上有编造的编号」时，判据 1 不许被丢掉。
   * 写成 `forcedDesync ? [forcedDesync] : findDesync(...)` 的话，下面那句 E9 的断言转红。
   */
  it("这一轮日志没落成 + 历史上引过台账里没有的编号 → 两条都进复核的理由，判据 1 不被丢掉", async () => {
    const issueId = await researchedIssue("测试议题13");

    await api.proposeTalkPoint(issueId, { thesis: "初始判断" });

    const port = {
      getTalkPoint: (id: string) => api.getTalkPoint(id),
      recordDeliberationEntry: (id: string, e: unknown) => api.recordDeliberationEntry(id, e),
      listDeliberationLog: (id: string) => api.listDeliberationLog(id),
      markTalkSettled: (id: string, judgement: string) => markTalkSettled(id, judgement),
    };

    // 第 1 轮：改判，回应里引的是 [E9] —— 而台账里只有 E1，编号是编的
    await api.proposeTalkPoint(issueId, { candidate: { statement: "第二个判断", basis: "[E9]" } });
    await settleTalkTurn(new Harness({ agent: "A5", slot: "pro" }), issueId, {
      api: port,
      ledger: oneGroup,
      nowTurn: 1,
      agentText: "根据 [E9] 的口径差异，我把判断改了。",
      ceoText: "凭什么改？",
    });
    expect((await api.listDeliberationLog(issueId))[0].trigger).toContain("E9");

    // 第 2 轮：又改判，但这一次回应里一个编号都指不出 → settle 构造 forcedDesync
    const settled: AgentRunRecord[] = [];
    await api.proposeTalkPoint(issueId, { candidate: { statement: "第三个判断", basis: "说不清" } });
    await settleTalkTurn(new Harness({ agent: "A5", slot: "pro" }), issueId, {
      api: port,
      ledger: oneGroup,
      nowTurn: 2,
      agentText: "我又想了想，现在觉得是第三个判断。",
      ceoText: "到底哪个对？",
      accounting: { open: () => "run-both", settle: (_id, r) => { settled.push(r); } },
    });

    const why = (noteDetail(settled[0] ?? null, "候选判断复核").why as string[]).join("｜");
    // 这一轮那条（forcedDesync）在最前 —— rollbackTo 取的是它的 before
    expect(why).toContain("指不出任何证据编号");
    // 判据 1 那条也在：第 1 轮引的 E9 台账里没有
    expect(why).toContain("E9");
  });

  /*
   * C1：报告正文里的引用是 `[E1, E2]` 这种形状（出处见 `a4/blocks/registry.ts:196` 那句
   * 注释），而报告正文原样进对谈前缀 —— 模型照着上下文里的样子写多编号是最自然的行为。
   *
   * 抠编号从前只认单编号，于是**一次诚实的、真的指得出两条证据的改判**被判成「回应里指
   * 不出任何证据编号」：那一轮的让步日志整条缺席，还多一次机检打回。
   * 把 `cite.ts` 的正则改回只认单编号 → 这一条红。
   */
  it("改判那一轮一次引两个编号（`[E1, E2]`）→ 照样落一条 concede，两个编号都进 trigger", async () => {
    const issueId = await researchedIssue("测试议题14");

    await api.proposeTalkPoint(issueId, { thesis: "初始判断" });
    await api.proposeTalkPoint(issueId, {
      candidate: { statement: "新判断", basis: "[E1, E2]" },
    });

    const settled: AgentRunRecord[] = [];
    await settleTalkTurn(new Harness({ agent: "A5", slot: "pro" }), issueId, {
      api: {
        getTalkPoint: (id: string) => api.getTalkPoint(id),
        recordDeliberationEntry: (id: string, e: unknown) => api.recordDeliberationEntry(id, e),
        listDeliberationLog: (id: string) => api.listDeliberationLog(id),
        markTalkSettled: (id: string, judgement: string) => markTalkSettled(id, judgement),
      },
      ledger: twoGroups,
      nowTurn: 1,
      agentText: "按 [E1, E2] 这两条的口径，我把判断改了。",
      ceoText: "凭什么改？",
      accounting: { open: () => "run-multi-cite", settle: (_id, r) => { settled.push(r); } },
    });

    const log = await api.listDeliberationLog(issueId);
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe("concede");
    /*
     * 断派生出来的形状，不是 `toContain("E1")` —— `agentText` 本身就带这两个编号
     * （理由同这个文件上面那条 concede 用例）。`[E1]、[E2] — ` 这个前缀是
     * `citeText(citedIds(agentText))` 拼出来的，只有真把 `[E1, E2]` 这种写法拆开
     * 抠到两个编号才有；抠不出来那一路根本不落日志。
     */
    expect(log[0].trigger.startsWith("[E1]、[E2] — ")).toBe(true);
    expect(log[0].rationale).toBe("根据 [E1]、[E2] 调整判断");

    // 而且没走 `forcedDesync` 那条路 —— 这一轮是指得出编号的
    const rec = settled[0] ?? null;
    expect(hasNote(rec, "判断变了但回应里指不出证据编号，不落日志但强制进复核")).toBe(false);
    // 复核跑了（判断动了就触发），而且不是因为「指不出编号」被打回
    expect(hasNote(rec, "候选判断复核")).toBe(true);
    expect((noteDetail(rec, "候选判断复核").why as string[]).join("｜")).not.toContain("指不出任何证据编号");
  });

  /*
   * C2：**这一轮的改判没落成日志，下一轮不许把它安在别人头上。**
   *
   * 复审那个探针搬过来的：第 7 轮判断动了但回应里指不出编号（那一轮只留痕、不落日志），
   * 第 8 轮随口补一句 `[E1]`。没有 `settledJudgement` 那一栏时，第 8 轮的 `before` 仍然
   * 是第 7 轮之前那一句，于是落出一条 `{ turn: 8, before: 旧判断, after: 新判断,
   * kind: "concede", trigger: "[E1] — …" }` —— 一条穿得过全部机检的伪造记录。
   *
   * 把 `settle.ts` 里那一栏的**读**（`point.settledJudgement ??`）或**写**
   * （`api.markTalkSettled` 那一行，含 `store.ts` 里那个函数体）删掉 → 这一条红。
   */
  it("第 7 轮改判没落成日志、第 8 轮补一个真编号 → 那次改判不会被记成第 8 轮的让步", async () => {
    const issueId = await researchedIssue("测试议题15");

    const port = {
      getTalkPoint: (id: string) => api.getTalkPoint(id),
      recordDeliberationEntry: (id: string, e: unknown) => api.recordDeliberationEntry(id, e),
      listDeliberationLog: (id: string) => api.listDeliberationLog(id),
      markTalkSettled: (id: string, judgement: string) => markTalkSettled(id, judgement),
    };

    // 第 6 轮：判断没动，落一条 hold —— 日志最后一条的 after 因此是「旧判断」
    await api.proposeTalkPoint(issueId, { thesis: "旧判断" });
    await api.proposeTalkPoint(issueId, { candidate: { statement: "旧判断", basis: "依据" } });
    await settleTalkTurn(new Harness({ agent: "A5", slot: "pro" }), issueId, {
      api: port, ledger: twoGroups, nowTurn: 6,
      agentText: "这一轮我还是这个判断。", ceoText: "真的确定？",
    });
    expect(await api.listDeliberationLog(issueId)).toHaveLength(1);

    // 第 7 轮：判断动了，回应里一个编号都指不出 → 这一轮不落日志（既有行为，不改）
    await api.proposeTalkPoint(issueId, { candidate: { statement: "新判断", basis: "说不清" } });
    await settleTalkTurn(new Harness({ agent: "A5", slot: "pro" }), issueId, {
      api: port, ledger: twoGroups, nowTurn: 7,
      agentText: "我改了，因为你说的口径问题。", ceoText: "我不同意。",
    });
    expect(await api.listDeliberationLog(issueId)).toHaveLength(1);
    // 这一轮虽然没落成日志，但「进下一轮之前判断是什么样子」已经记住了 —— 接头在这里
    expect((await api.getTalkPoint(issueId)).settledJudgement).toBe("新判断");

    // 第 8 轮：判断没再动，回应里随口补一句真编号
    await settleTalkTurn(new Harness({ agent: "A5", slot: "pro" }), issueId, {
      api: port, ledger: twoGroups, nowTurn: 8,
      agentText: "补一句：[E1] 也支持这个。", ceoText: "那就这样。",
    });

    const log = await api.listDeliberationLog(issueId);
    // 第 8 轮那条不许是一次「旧判断 → 新判断」的让步
    expect(log.filter((e) => e.before === "旧判断" && e.after === "新判断")).toEqual([]);
    const eighth = log.find((e) => e.turn === 8);
    expect(eighth).toBeDefined();
    expect(eighth!.kind).toBe("hold");
    expect(eighth!.before).toBe("新判断");
    expect(eighth!.after).toBe("新判断");

    /*
     * 第 7 轮那次缺席没有被洗掉，它以「前后接不上」的样子留在账上：第 6 轮那条的 after
     * 是「旧判断」，第 8 轮这条的 before 是「新判断」。`findDesync` 判据 2 每一次复核都
     * 会把它报出来 —— 这正是要的结果（说不清的那次改判一直挂在账上）。
     */
    expect(log.find((e) => e.turn === 6)!.after).toBe("旧判断");
  });
  /*
   * I6：套话探测（规格 §9）真的接在轮外结算上了。
   *
   * `templateSmells` 从前只有端到端回归一个消费方，而 `system.ts` 上的注释点名说它
   * 「在 `settleTurn` 里用」—— 一条描述了不存在机制的注释。现在它真的在这里跑：命中
   * 就在这一轮结算的运营台账记录上留一条痕。
   *
   * **摘掉 `doSettle` 开头那个 `if (smells.length > 0)` 整块 → 下面第一条红。**
   */
  it("回应里说套话：这一轮结算的台账记录上留一条痕，记的是命中了哪几句", async () => {
    const issueId = await researchedIssue("测试议题15");
    await api.proposeTalkPoint(issueId, { thesis: "坚持的判断" });
    await api.proposeTalkPoint(issueId, { candidate: { statement: "坚持的判断", basis: "依据" } });

    const settled: AgentRunRecord[] = [];
    await settleTalkTurn(new Harness({ agent: "A5", slot: "pro" }), issueId, {
      api: {
        getTalkPoint: (id: string) => api.getTalkPoint(id),
        recordDeliberationEntry: (id: string, e: unknown) => api.recordDeliberationEntry(id, e),
        listDeliberationLog: (id: string) => api.listDeliberationLog(id),
        markTalkSettled: (id: string, judgement: string) => markTalkSettled(id, judgement),
      },
      ledger: twoGroups,
      nowTurn: 1,
      agentText: "更新后的判断是：仍然按原口径走。",
      ceoText: "再想想。",
      accounting: { open: () => "run-smells", settle: (_id, r) => { settled.push(r); } },
    });

    const rec = settled[0] ?? null;
    expect(hasNote(rec, "这一轮回应里有套话")).toBe(true);
    // 记的是命中了哪一句，不是一个光秃秃的布尔 —— 回头翻账的人要看得出是哪句话
    expect(noteDetail(rec, "这一轮回应里有套话").hit).toEqual(["更新后的判断是"]);

    /*
     * **套话不动这本账。** 它是自然感的问题，不是反谄媚那本账的问题：这一轮判断没动，
     * 照旧落一条 hold，候选也一个字没被摘掉。两件事混在一个出口上，下一次就会有人拿
     * 「它说了套话」当打回候选的理由。
     */
    const log = await api.listDeliberationLog(issueId);
    expect(log).toHaveLength(1);
    expect(log[0].kind).toBe("hold");
    expect((await api.getTalkPoint(issueId)).candidate?.statement).toBe("坚持的判断");
  });

  it("回应里没有套话：一条痕都不留，台账不被每轮一条的噪声刷满", async () => {
    const issueId = await researchedIssue("测试议题16");
    await api.proposeTalkPoint(issueId, { thesis: "坚持的判断" });
    await api.proposeTalkPoint(issueId, { candidate: { statement: "坚持的判断", basis: "依据" } });

    const settled: AgentRunRecord[] = [];
    await settleTalkTurn(new Harness({ agent: "A5", slot: "pro" }), issueId, {
      api: {
        getTalkPoint: (id: string) => api.getTalkPoint(id),
        recordDeliberationEntry: (id: string, e: unknown) => api.recordDeliberationEntry(id, e),
        listDeliberationLog: (id: string) => api.listDeliberationLog(id),
        markTalkSettled: (id: string, judgement: string) => markTalkSettled(id, judgement),
      },
      ledger: twoGroups,
      nowTurn: 1,
      agentText: "这一点我改了，因为你刚才提到的口径问题。",
      ceoText: "再想想。",
      accounting: { open: () => "run-no-smells", settle: (_id, r) => { settled.push(r); } },
    });

    expect(hasNote(settled[0] ?? null, "这一轮回应里有套话")).toBe(false);
  });
});
