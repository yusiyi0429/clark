// 这三行在任何会摸到 store.ts 的 import 之前 —— 理由同 store.judgements.test.ts 的开头。
process.env.TKOS_PERSIST = "0";
process.env.TKOS_MODEL_MOCK = "1";

import { beforeAll, describe, expect, it } from "vitest";

import { citedIds } from "@/lib/agent/talk/cite";
import type { Evidence } from "@/lib/research/ledger";
import type { ResearchDoc } from "./types";

/**
 * 「查一下」—— 他按下的那一次轻量核查（`api.quickCheck`）。
 *
 * 两件事在这里钉住，各自都能被破坏掉验证：
 *
 * 1. **共用台账，编号在整条链上不重号、不断号。** 这是这一档存在的理由 —— 这一次查到的
 *    东西后面那轮深研要能接着用，指不认的编号等于白花钱。
 * 2. **它一轮深研都不起。** 一次分钟级的核查顺手起一轮十几分钟、花真钱的深研，是这条路
 *    上最贵的一种错，而屏幕上只表现成「这次查得有点久」。
 */

let api: typeof import("./store").api;
let seedResearched: typeof import("./store").__seedResearchedIssueForTest;

beforeAll(async () => {
  const store = await import("./store");
  api = store.api;
  seedResearched = store.__seedResearchedIssueForTest;
});

/** 台账里本来就有的那几条。形状照 `escalate.demo.test.ts` 里那一份。 */
const seeded = (id: string, claim: string): Evidence =>
  ({
    id,
    claim,
    exactQuote: `${claim}（原文）`,
    siteName: "国家统计局",
    sourceTier: "A",
    sourceDomain: "stats.gov.cn",
    url: `https://example.invalid/${id}`,
    retrievedAt: "2026-08-28",
    independenceGroup: "G0",
  }) as unknown as Evidence;

/** 一件手上有报告、台账里已经有两条的议题。 */
const researched = async (title: string): Promise<string> => {
  const issue = await api.addIssue(title);
  const doc: ResearchDoc = {
    issueId: issue.id,
    judgment: [{ text: "判断", traces: [] }],
    keyEvidence: [{ text: "证据", traces: [] }],
    counters: [{ text: "反证", traces: [] }],
    unknowns: [{ text: "不确定", traces: [] }],
    routeSuggestion: "建议上会",
    byAgentLabel: "CEO Agent",
    assembledFrom: [],
    sourceText: "## 核心判断\n\n判断。",
    at: "2026-08-28T00:00:00.000Z",
    ledger: [seeded("E1", "上一轮记下的第一条"), seeded("E2", "上一轮记下的第二条")],
  };
  seedResearched(issue.id, doc, { text: "测试题", suggestedDri: "测试人", deadline: "48小时" });
  return issue.id;
};

describe("查一下：落进同一本台账", () => {
  it("编号接在现有最大号后面 —— 整条链上不重号、不断号", async () => {
    const issueId = await researched("面板 IT 与车载的面积口径");
    const r = await api.quickCheck(issueId, "2025Q2 同口径份额");
    expect(r.found).toBe(true);
    expect(r.evidenceIds.length).toBeGreaterThan(0);

    const doc = await api.getResearchDoc(issueId);
    const ids = (doc?.ledger ?? []).map((e) => e.id);

    /*
     * 轮内取证回来的条目**永远从 `E1` 起**（`Ledger` 的计数器是私有的，播不了种），
     * 所以这两条断言是这一整档的地基。
     *
     * 变异验证：把 `land.ts` 里 `landMicroEvidence` 的 `maxN` 恒置 0（也就是不扫现有
     * 台账、从 E1 起编）→ 台账变成 E1、E2、E1、E2，两条断言都红。
     */
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids).toEqual(ids.map((_, i) => `E${i + 1}`));

    // 原有那两条一个字没动，新来的接在后面
    expect(ids.slice(0, 2)).toEqual(["E1", "E2"]);
    expect(r.evidenceIds).toEqual(ids.slice(2));
    expect(r.evidenceIds[0]).toBe("E3");
  });

  it("回答里的编号指的是这一次刚落进去的那几条", async () => {
    const issueId = await researched("驱动芯片外供对扩产节奏的约束");
    const r = await api.quickCheck(issueId, "驱动芯片产能排期");
    expect(r.found).toBe(true);

    const cited = citedIds(r.reply);
    expect(cited.length).toBeGreaterThan(0);
    /*
     * 喂给作答那一次的必须是**落库之后**那几条 —— 编号是落库那一步重排过的。
     *
     * 变异验证：把 `quickCheck` 里 `answerFromCheck(h, q, landed)` 改成喂
     * `got.entries`（重排之前的那几条）→ 回答里引的是 E1／E2，而那两个号在台账里
     * 指的是上一轮的证据，这一条红。屏幕上看不出任何异常：那段话照样有编号可点。
     */
    for (const id of cited) expect(r.evidenceIds).toContain(id);
  });
});

describe("查一下：它一轮深研都不起", () => {
  it("这条议题还没有报告时，查完深研照旧是没起过", async () => {
    const issue = await api.addIssue("海外仓要不要自建");
    expect((await api.deepResearchStatus(issue.id)).status).toBe("idle");

    const r = await api.quickCheck(issue.id, "三方仓履约时效");

    /*
     * 没有报告就没有落处（`landTalkEvidence` 那时一条都不落），所以这一次照实说没查到
     * —— **不是一次失败**，也不为此造一份没跑过深研的报告。
     */
    expect(r.found).toBe(false);
    expect(r.evidenceIds).toEqual([]);
    expect(r.reply).toContain("这一轮没查到");

    /*
     * 这一条是这整个文件里最贵的一条。
     *
     * 变异验证：在 `quickCheck` 里加一句 `await api.getResearchDoc(issueId)`
     * （一个看起来完全正常的「读一下这条议题的报告」）→ 那个方法不是纯读，它会
     * `ensureDeepResearch`，于是这里不再是 `idle`（离线跑到的是 `failed`），这一条红。
     */
    expect((await api.deepResearchStatus(issue.id)).status).toBe("idle");
  });

  it("空问句直接拒，不开运行也不起轮", async () => {
    const issue = await api.addIssue("空问句");
    await expect(api.quickCheck(issue.id, "   ")).rejects.toThrow();
    expect((await api.deepResearchStatus(issue.id)).status).toBe("idle");
  });
});
