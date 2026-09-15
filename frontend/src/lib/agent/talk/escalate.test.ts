// 这两行在任何会摸到 store.ts 的 import 之前 —— 照 store.judgements.test.ts 的开头，
// 那个文件的注释写清了为什么静态 import 不行。
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

import { beforeAll, describe, expect, it } from "vitest";
import { checkEscalation, tellHim } from "./tools";
import type { api as Api } from "@/lib/data/store";
import type { allTasks as AllTasks } from "@/lib/agent/tasks";

let api: typeof Api;
let allTasks: typeof AllTasks;
/** 种一份报告 —— 「有报告时落得下去」那个正向对照要它。 */
let seedResearched: typeof import("@/lib/data/store").__seedResearchedIssueForTest;
beforeAll(async () => {
  const store = await import("@/lib/data/store");
  api = store.api;
  seedResearched = store.__seedResearchedIssueForTest;
  allTasks = (await import("@/lib/agent/tasks")).allTasks;
});

describe("escalate 的三个出口", () => {
  it("顶层只认 type 和 payload，多键整份拒", () => {
    const extra = checkEscalation({ type: "async_research", payload: { question: "q", issueId: "ISS-1" }, point_id: "x" });
    expect(extra.ok).toBe(false);
    expect(extra.ok === false && extra.why.join("").includes("point_id")).toBe(true);
  });

  it("只认这三种，别的拒", () => {
    expect(checkEscalation({ type: "meeting", payload: {} }).ok).toBe(false);
    expect(checkEscalation({ type: "async_research", payload: { question: "q", issueId: "ISS-1" } }).ok).toBe(true);
    expect(checkEscalation({ type: "evidence_action", payload: { question: "q", issueId: "ISS-1", owner: "王" } }).ok).toBe(true);
    expect(checkEscalation({ type: "deep_research_handoff", payload: { issueId: "ISS-1", why: "缺口扩到整个议题" } }).ok).toBe(true);
  });

  it("每一种的 payload 各自校验 —— 串了键的整份拒，不静默丢", () => {
    // 转异步那一种不认 why：带着它来说明模型把「回深研」和「转异步」搞混了
    const mixed = checkEscalation({ type: "async_research", payload: { question: "q", issueId: "ISS-1", why: "w" } });
    expect(mixed.ok).toBe(false);
    expect(mixed.ok === false && mixed.why.join("").includes("why")).toBe(true);
    // 回深研那一种缺 why 也拒 —— 没有理由的交接在深研那头没法排队
    expect(checkEscalation({ type: "deep_research_handoff", payload: { issueId: "ISS-1" } }).ok).toBe(false);
    // 回深研多带 owner 要被拒
    expect(checkEscalation({ type: "deep_research_handoff", payload: { issueId: "ISS-1", why: "w", owner: "王" } }).ok).toBe(false);
    // 空串按缺处理
    expect(checkEscalation({ type: "async_research", payload: { question: "  ", issueId: "ISS-1" } }).ok).toBe(false);
    // 可选栏在但不是非空字符串时整份拒
    expect(checkEscalation({ type: "evidence_action", payload: { question: "q", issueId: "ISS-1", owner: 123 } }).ok).toBe(false);
    expect(checkEscalation({ type: "evidence_action", payload: { question: "q", issueId: "ISS-1", owner: "  " } }).ok).toBe(false);
  });

  it("每一种都有一句告知他的话，且话里带得走那个缺口", () => {
    const s = tellHim({ type: "async_research", payload: { question: "2025Q2 同口径份额", issueId: "ISS-1" } });
    expect(s).toContain("2025Q2 同口径份额");
    // 规格 §4.1 的原话，逐字：升级阶梯第一句要许诺补上
    expect(s).toContain("查证结果稍后补上");
    // 内部字段名不许上屏（全局约束）
    expect(s).not.toContain("async_research");
    expect(s).not.toContain("ISS-1");
  });

  it("交接深研的告知里要说清是回到深研，不许含糊成「我再想想」", () => {
    const s = tellHim({ type: "deep_research_handoff", payload: { issueId: "ISS-1", why: "缺口扩到整个议题" } });
    expect(s).toContain("深研");
    expect(s).not.toContain("我再想想");
    expect(s).not.toContain("deep_research_handoff");
    // 已有报告时如实说清它不会替他作废现有报告。原来这里钉的是「打回重研」，
    // 而那颗键全仓不存在 —— 告知里指一个按不到的出口，比不告知更坏。
    const existing = tellHim({ type: "deep_research_handoff", payload: { issueId: "ISS-1", why: "w" } }, { reportAlreadyThere: true });
    expect(existing).toContain("不会替你把现有报告作废");
    expect(existing).not.toContain("打回重研");
    expect(existing).not.toContain("缺口扩到整个议题");
  });

  it("转异步那一种落到既有任务表上 —— 断言在库那一侧，不是断言我自己传进去的字符串", async () => {
    const issue = await api.addIssue("2025Q2 同口径份额这个数怎么算");
    const before = Object.keys(allTasks()).length;
    const r = await api.recordEscalation({
      type: "async_research",
      payload: { question: "2025Q2 同口径份额", issueId: issue.id },
    });
    expect(r.told).toContain("查证结果稍后补上");
    const keys = Object.keys(allTasks());
    expect(keys.length).toBeGreaterThan(before);
    expect(keys.some((k) => k.includes(issue.id))).toBe(true);
    expect(r.landed).toContain(issue.id);   // landed 说的是「挂到哪一条上去了」
    expect(r.landed).toContain("2025Q2 同口径份额");  // key 按问题去重，不是按议题
  });

  it("evidence_action 那一路只校验告知，landed 是空串", async () => {
    const issue = await api.addIssue("测试取证行动");
    const r = await api.recordEscalation({
      type: "evidence_action",
      payload: { question: "这个数有没有第三方验证", issueId: issue.id },
    });
    expect(r.landed).toBe("");
    expect(r.told).toContain("取证行动");
  });

  it("deep_research_handoff 真起一轮时 landed 带 issueId", async () => {
    const issue = await api.addIssue("测试交接深研");
    const r = await api.recordEscalation({
      type: "deep_research_handoff",
      payload: { issueId: issue.id, why: "缺口扩到整个议题" },
    });
    expect(r.landed).toBe(`deep:${issue.id}`);
    expect(r.told).toContain("深研");
  });

  it("校验不过时抛 ApiError，而且话里说得出被拒的是哪一条", async () => {
    /*
     * 断到文案，不是裸 `rejects.toThrow()`：那一版任何异常都绿 —— 包括「议题不存在」
     * 这种和本条无关的失败，那时候它证的就不是「校验不过要拒」了。同一个坑
     * `land.test.ts` 那一侧已经写进注释，这一处从前没跟上。
     */
    await expect(api.recordEscalation({ type: "meeting", payload: {} })).rejects.toThrow(
      "升级被拒：",
    );
    await expect(api.recordEscalation({ type: "meeting", payload: {} })).rejects.toThrow(
      "meeting",
    );
  });

  it("还没有报告的议题：这次查证结果没有落处，不许为它造一份空报告", async () => {
    const issue = await api.addIssue("还没有报告的议题");
    const one = {
      id: "E1",
      claim: "现查回来的一句",
      exactQuote: "现查回来的一句（原文）",
      siteName: "国家统计局",
      sourceTier: "A",
      sourceDomain: "stats.gov.cn",
      url: "https://example.invalid/x",
      retrievedAt: "2026-08-27",
      independenceGroup: "G1",
    } as unknown as import("@/lib/research/ledger").Evidence;

    expect(await api.landTalkEvidence(issue.id, [one])).toEqual([]);
    // 落不下去不等于凭空生出一份报告 —— 那份报告没跑过深研
    expect((await api.deepResearchStatus(issue.id)).status).not.toBe("done");

    /*
     * **同一句话在有报告的议题上必须落得下去。** 上面那条 `toEqual([])` 单独看是空洞的：
     * `landTalkEvidence` 无条件返回 `[]` 也绿，而那时候这条测试证的是「它什么都不干」，
     * 不是「没有报告就不落」。所以这里就地补一个正向对照。
     */
    const withReport = await api.addIssue("有报告的议题");
    seedResearched(
      withReport.id,
      {
        issueId: withReport.id,
        judgment: [{ text: "判断", traces: [] }],
        keyEvidence: [{ text: "证据", traces: [] }],
        counters: [{ text: "反证", traces: [] }],
        unknowns: [{ text: "不确定", traces: [] }],
        routeSuggestion: "建议上会",
        byAgentLabel: "CEO Agent",
        assembledFrom: [],
        sourceText: "## 核心判断",
        at: "2026-08-27T00:00:00.000Z",
      } as unknown as import("@/lib/data/types").ResearchDoc,
      { text: "测试题", suggestedDri: "测试人", deadline: "48小时" },
    );
    const landed = await api.landTalkEvidence(withReport.id, [one]);
    expect(landed).toHaveLength(1);
    expect(landed[0].claim).toBe("现查回来的一句");
  });
});
