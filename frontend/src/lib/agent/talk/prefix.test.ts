import { describe, expect, it } from "vitest";
import type { BlockEvidence, ReportBlocks } from "@/lib/agent/a4/blocks/schema";
import type { Evidence } from "@/lib/research/ledger";
import {
  assemblePrefix,
  buildBoard,
  buildLedgerIndex,
  buildReportBody,
  indexEntries,
  renderDecisionMemories,
} from "./prefix";
import type { DecisionMemory, UserCard } from "./memory";

const blocks = (): ReportBlocks => ({
  blocks: [
    { type: "verdict_banner", text: "当前更支持 A", confidence: "当前更支持", boundary: "" },
    { type: "prose", md: "机制：口径换算之后份额是 48%" },
    { type: "evidence_list", items: [{ claim: "E1 ……", id: "E1", sourceName: "x", sourceType: "媒体转述", verified: true, origin: "ledger" }] },
    { type: "evidence_list", items: [{ claim: "48% = 12/25", id: "E2", sourceName: "x", sourceType: "媒体转述", verified: true, origin: "ledger" }] },
  ],
  appendixFrom: 2,
} as unknown as ReportBlocks);

describe("静态前缀只带正文层", () => {
  it("附录不进前缀", () => {
    const text = buildReportBody(blocks());
    expect(text).toContain("当前更支持 A");
    expect(text).toContain("口径换算");
    expect(text).not.toContain("48% = 12/25");
    expect(text).not.toContain("E1 ……");
  });

  it("appendixFrom 缺失时按块类型退回 partition，不静默把附录塞进正文", () => {
    const b = blocks();
    delete (b as { appendixFrom?: number }).appendixFrom;
    expect(buildReportBody(b)).toContain("当前更支持 A");
    expect(buildReportBody(b)).not.toContain("48% = 12/25");
  });

  it("台账索引给 ID+一句话+机构+等级，一条一行", () => {
    const line = buildLedgerIndex([
      {
        id: "E1", claim: "2025 年出货 1200 万片", sourceName: "国家统计局", sourceType: "statistic",
        verified: true, retrievedAt: "2026-08-26", independenceGroup: "g1", grade: "A", origin: "retrieved",
      } as unknown as BlockEvidence,
    ]);
    expect(line).toBe("E1｜2025 年出货 1200 万片｜国家统计局｜A 档");
  });

  it("两条证据进去出来是两行", () => {
    const lines = buildLedgerIndex([
      {
        id: "E1", claim: "第一条", sourceName: "来源 A", sourceType: "statistic",
        verified: true, retrievedAt: "2026-08-26", independenceGroup: "g1", grade: "A", origin: "retrieved",
      } as unknown as BlockEvidence,
      {
        id: "E2", claim: "第二条", sourceName: "来源 B", sourceType: "statement",
        verified: true, retrievedAt: "2026-08-26", independenceGroup: "g2", grade: "B", origin: "retrieved",
      } as unknown as BlockEvidence,
    ]);
    expect(lines.split("\n")).toHaveLength(2);
  });
});

const slim = (id: string, claim: string) =>
  ({ id, claim, sourceName: "国家统计局", sourceType: "官方一手", verified: true,
     retrievedAt: "2026-08-26", independenceGroup: "g1", grade: "A", origin: "ledger" } as unknown as BlockEvidence);

const ledgerEntry = (id: string, claim: string) =>
  ({ id, claim, exactQuote: `${claim}（原文）`, excerpt: `……${claim}……`, siteName: "国家统计局",
     sourceDomain: "stats.gov.cn", sourceTier: "A", authorityClass: "official_statistics",
     retrievedAt: "2026-08-27", independenceGroup: "g9", url: "https://x" } as unknown as Evidence);

describe("索引带上对谈里追加的那几条", () => {
  it("台账里多出来的那一条接在后面，且进得了索引", () => {
    const idx = indexEntries([slim("E1", "第一条")], [ledgerEntry("E1", "第一条"), ledgerEntry("E8", "2025Q2 同口径份额 48%")]);
    expect(idx.map((e) => e.id)).toEqual(["E1", "E8"]);
    expect(buildLedgerIndex(idx)).toContain("E8｜2025Q2 同口径份额 48%");
  });

  it("速查那份已有的编号不重复接一遍", () => {
    const idx = indexEntries([slim("E1", "第一条")], [ledgerEntry("E1", "第一条")]);
    expect(idx).toHaveLength(1);
    expect(idx[0].claim).toBe("第一条");
  });

  it("没有台账那栏时原样回 —— 老报告只有速查那一份", () => {
    expect(indexEntries([slim("E1", "第一条")], undefined).map((e) => e.id)).toEqual(["E1"]);
  });
});

describe("决策记忆那一段两边共用同一个渲染", () => {
  const memory: DecisionMemory = {
    id: "DM-1",
    judgment: "面板这一轮不扩产",
    rationale: "口径换算之后份额还在 52%",
    overturnConditions: ["行业统计改用片数口径", "前三家合计份额跌破 50%"],
    issueTags: ["BIZ-TK"],
    sessionId: "ISS-D1",
    confirmedAt: "2026-08-27T00:00:00.000Z",
    status: "active",
  };

  it("三行齐全，措辞与判断板那块的重开条件对齐", () => {
    expect(renderDecisionMemories([memory])).toEqual([
      "相关决策记忆 —— 1 条：",
      "  面板这一轮不扩产",
      "  凭什么：口径换算之后份额还在 52%",
      "  什么新证据会把它重新打开：行业统计改用片数口径；前三家合计份额跌破 50%",
    ]);
  });

  it("一条都没有时是空数组，不是一行空表头", () => {
    expect(renderDecisionMemories([])).toEqual([]);
  });

  it("assemblePrefix 装的就是这一份 —— 生产那一侧（buildAdvisorContext）调的也是它", () => {
    const r = assemblePrefix({
      system: "S", blocks: blocks(), ledger: [], board: [], card: null,
      memories: [memory], history: "H",
    });
    /*
     * 断的是**具体那几行字**，不是 `toContain(renderDecisionMemories([memory]).join("\n"))`
     * —— 那个期望值是被测的那条路自己算出来的：渲染回空数组时它退化成 `toContain("")`，
     * 恒真。
     */
    expect(r.text).toContain("相关决策记忆 —— 1 条：");
    expect(r.text).toContain("\n  凭什么：口径换算之后份额还在 52%");
    expect(r.text).toContain("\n  什么新证据会把它重新打开：行业统计改用片数口径；前三家合计份额跌破 50%");

    const chars = r.manifest.find((x) => x.block === "decisionMemory")?.chars;
    expect(chars).toBeGreaterThan(0);
    expect(chars).toBe(renderDecisionMemories([memory]).join("\n").length);
  });
});

describe("红线对照：用户卡不改动报告正文、判断板、台账索引", () => {
  it("带立场的用户卡不改动报告正文、判断板、台账索引那三块", () => {
    const board = [
      { ref: "①", id: "J1", statement: "面板这一轮不扩产", confirmed: true },
      { ref: "②", id: "J2", statement: "份额按出货面积算", confirmed: false },
    ];
    const ledger = [
      { id: "E1", claim: "2025 年出货 1200 万片", sourceName: "国家统计局", sourceType: "statistic",
        verified: true, retrievedAt: "2026-08-26", independenceGroup: "g1", grade: "A", origin: "retrieved" },
    ] as unknown as BlockEvidence[];
    const stance: UserCard = {
      challengeDimensions: [{ dimension: "统计口径混用", count: 9, sessions: ["S1"] }],
      longTermViews: [{ view: "看空面板", firstSeen: "2026-01-01", recentChange: "无" }],
      preferences: { granularity: "要机制不要罗列" },
    };
    const base = { system: "S", blocks: blocks(), ledger, board, memories: [], history: "H" };
    const withCard = assemblePrefix({ ...base, card: stance });
    const without = assemblePrefix({ ...base, card: null });

    /*
     * 三块逐字相同：装配层没有把卡里的立场揉进去。
     *
     * **先钉住这一块真的在 manifest 上、而且不是 0 字**，再比两边。上一版直接
     * `expect(a?.chars).toBe(b?.chars)` —— 两边都取不到时是 `undefined === undefined`，
     * 恒真。实测：把 `assemblePrefix` 里 `manifest.push({ block: "reportBody", … })` 与
     * `{ block: "ledgerIndex", … }` 两行删掉，这个文件照旧全绿。
     */
    for (const block of ["reportBody", "board", "ledgerIndex"] as const) {
      const a = withCard.manifest.find((x) => x.block === block);
      const b = without.manifest.find((x) => x.block === block);
      expect(a, `manifest 上没有 ${block} 这一块`).toBeDefined();
      expect(a!.chars).toBeGreaterThan(0);
      expect(b).toBeDefined();
      expect(a!.chars).toBe(b!.chars);
    }

    /*
     * 判断板那一块真的进了前缀。断的是**具体那几行字**，不是
     * `toContain(buildBoard(board))` —— 那个期望值是被测函数自己算的，`buildBoard`
     * 回空串时退化成 `toContain("")`，恒真。
     *
     * 挑的两行里**必须有一条 `confirmed === false` 的**：上一版只断了 `board[0]`
     * （那一条是已确认的），于是把 `prefix.ts` 里「待确认」那半块整个删掉，
     * 这个文件 11/11 全绿 —— 而屏幕上少掉的正是「还没定的那几条」。
     */
    for (const text of [withCard.text, without.text]) {
      expect(text).toContain("待确认（还只是候选，不是公司口径）—— 1 条：");
      expect(text).toContain("②｜份额按出货面积算");
      expect(text).toContain("已确认（已经是公司口径）—— 1 条：");
      expect(text).toContain("①｜面板这一轮不扩产");
    }

    // 卡确实带进去了（否则上面那圈相同是因为两边都没带卡）
    expect(withCard.text).toContain("看空面板");
    expect(withCard.manifest.find((x) => x.block === "userCard")?.chars).toBeGreaterThan(0);
    expect(without.manifest.some((x) => x.block === "userCard")).toBe(false);

    // 没确认的那一条不许被写成已确认：单独渲染它时，「已确认」那半块整块不出现
    const draftOnly = buildBoard([board[1]]);
    expect(draftOnly).toContain("待确认（还只是候选，不是公司口径）—— 1 条：");
    expect(draftOnly).toContain("份额按出货面积算");
    expect(draftOnly).not.toContain("已确认");
  });
});
