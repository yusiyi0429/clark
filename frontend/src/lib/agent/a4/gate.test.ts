import { describe, expect, it } from "vitest";

import type { ResearchDoc } from "@/lib/data/types";
import type { Snapshot } from "@/lib/research/fetch";
import { Ledger, type EvidenceDraft, type SupportRelation } from "@/lib/research/ledger";

import type { ScopeQuestionTrace } from "./dims";
import { bindCitations, citedIds, evidenceManifest, gateReport, gateScope } from "./gate";
import type { Verdict } from "./props";

const URL_A = "https://stats.example.gov.cn/a";
const URL_B = "https://industry.example.org/b";
const BODY_A = "据国家某局，本季度该项指标回落约两成，回落主要出现在两个行业。";
const BODY_B = "据某行业协会，另外两个行业同期没有出现同样的回落。";

const snap = (url: string, text: string): Snapshot => ({
  url,
  title: url.includes("stats") ? "某局季度公报" : "某协会季度观察",
  text,
  contentHash: `h-${url}`,
  retrievedAt: "2026-08-25T00:00:00.000Z",
  truncated: false,
});

const draft = (over: Partial<EvidenceDraft>): EvidenceDraft => ({
  propositionId: "P1",
  claim: "本季度该项指标回落约两成",
  exactQuote: "本季度该项指标回落约两成",
  url: URL_A,
  supportRelation: "supports",
  evidenceType: "statement",
  authorityClass: "official_statistics",
  ...over,
});

/** 台账：两页都挂上，按需入账几条。 */
const ledgerWith = (drafts: Partial<EvidenceDraft>[]): Ledger => {
  const l = new Ledger();
  l.archive([snap(URL_A, BODY_A), snap(URL_B, BODY_B)]);
  for (const d of drafts) {
    const e = l.record(draft(d));
    // 台账建不起来的话下面每一条断言都在测别的东西，所以这里直接炸。
    if (!e) throw new Error(`夹具没入账：${l.rejections.at(-1)?.why}`);
  }
  return l;
};

const relation = (r: SupportRelation): Partial<EvidenceDraft> => ({ supportRelation: r });

const rules = (report: string, l: Ledger, v: Verdict[] = []) =>
  gateReport(report, l, v).violations.map((x) => `${x.rule}/${x.severity}`);

const OK_REPORT = "标题那句话\n\n## 核心判断\n\n指标确实在回落[E1]。";

describe("读得出正文里引了哪几条", () => {
  it("三种写法都认，去重且按出现顺序", async () => {
    expect(citedIds("先看 [E3]，再看 [E7, E1]，又提了 [E3][E9]。")).toEqual(["E3", "E7", "E1", "E9"]);
  });

  it("没引就是空", async () => {
    expect(citedIds("这一段没有任何编号。")).toEqual([]);
  });
});

describe("A4-G01 地址由系统绑，模型只写编号", () => {
  it("正文里手写 URL 是 p0", async () => {
    /*
     * 手写的 URL 有两种结局：编的（点开 404）、记忆里的旧地址（点开是另一篇）。两种都
     * 比没有链接糟 —— 没有链接的时候人会去查，有一个假链接的时候人不会。
     */
    const l = ledgerWith([{}]);
    expect(rules("标题\n\n## 核心判断\n\n见 https://example.com/x 那一页[E1]。", l)).toContain("A4-G01/p0");
  });

  it("留着 [reference:4] 这类占位符是 p0", async () => {
    const l = ledgerWith([{}]);
    expect(rules("标题\n\n## 核心判断\n\n据统计[reference:4]。[E1]", l)).toContain("A4-G01/p0");
  });

  it("这两条在没有台账时也照样查", async () => {
    // 未联网那一支同样不许手写地址：没有台账不代表可以自己编一个链接。
    expect(rules("标题\n\n## 核心判断\n\n见 https://example.com/x。", new Ledger())).toContain("A4-G01/p0");
  });
});

describe("A4-G02 编号必须解析得到", () => {
  it("引了台账里没有的编号是 p0", async () => {
    const l = ledgerWith([{}]);
    const out = gateReport("标题\n\n## 核心判断\n\n据统计[E9]。[E1]", l, []);
    expect(out.violations.some((v) => v.rule === "A4-G02" && v.message.includes("E9"))).toBe(true);
  });

  it("台账里有证据、正文一条都没引，也是 p0", async () => {
    // 「取回了 5 条证据然后一条都没用」在报告上看不出来 —— 它读起来和凭记忆写的一样。
    const l = ledgerWith([{}]);
    expect(rules("标题\n\n## 核心判断\n\n指标确实在回落。", l)).toContain("A4-G02/p0");
  });

  it("引对了就不报", async () => {
    expect(rules(OK_REPORT, ledgerWith([{}]))).toEqual([]);
  });
});

describe("A4-G03 反向证据不许被沉默掉", () => {
  it("台账里的 refutes 没出现在正文里是 p0", async () => {
    /*
     * 这是整条链的反谄媚保证（CH-4）。取回一条推翻自己的证据然后不提它，比压根没取到
     * 更糟：报告读起来像是压力测试过的。
     */
    const l = ledgerWith([{}, { url: URL_B, propositionId: "P1", exactQuote: "另外两个行业同期没有出现同样的回落", ...relation("refutes") }]);
    const out = gateReport(OK_REPORT, l, []);
    expect(out.violations.some((v) => v.rule === "A4-G03" && v.message.includes("E2"))).toBe(true);
  });

  it("引到了就不报", async () => {
    const l = ledgerWith([{}, { url: URL_B, exactQuote: "另外两个行业同期没有出现同样的回落", ...relation("refutes") }]);
    expect(rules("标题\n\n## 核心判断\n\n回落存在[E1]，但另外两个行业没有[E2]。", l)).toEqual([]);
  });
});

describe("A4-G04 没核实的要写出来", () => {
  it("有终态命题却没有「未能核实」那一节是 p0", async () => {
    const l = ledgerWith([{}]);
    const v: Verdict[] = [
      {
        propositionId: "P2",
        ok: false,
        tally: { propositionId: "P2", groups: 0, citableGroups: 0, ugcOnly: false },
        unmet: ["没找到任何来源"],
        terminal: "unknown_snapshot_gap",
      },
    ];
    expect(rules(OK_REPORT, l, v)).toContain("A4-G04/p0");
  });

  it("写了就不报，几种说法都认", async () => {
    // 查不到是合法结果（HP-5），但必须写出来。标题词卡太死会让一份写了的报告被打回。
    const l = ledgerWith([{}]);
    const v: Verdict[] = [
      {
        propositionId: "P2",
        ok: false,
        tally: { propositionId: "P2", groups: 0, citableGroups: 0, ugcOnly: false },
        unmet: [],
        terminal: "unavailable",
      },
    ];
    for (const head of ["未能核实的部分", "没能核实的部分", "查不到的部分"]) {
      expect(rules(`${OK_REPORT}\n\n## ${head}\n\n另外两个行业的口径本轮没取到。`, l, v)).toEqual([]);
    }
  });

  it("命题没闭合但还能再补搜时不报 —— 那不是终态", async () => {
    const l = ledgerWith([{}]);
    const v: Verdict[] = [
      {
        propositionId: "P2",
        ok: false,
        tally: { propositionId: "P2", groups: 1, citableGroups: 1, ugcOnly: false },
        unmet: ["只有一个独立来源"],
        terminal: "",
      },
    ];
    expect(rules(OK_REPORT, l, v)).toEqual([]);
  });
});

describe("A4-G05 算术站不住", () => {
  it("复算不通过是 p0 —— 要么改数，要么说明两个数不可比", async () => {
    const l = ledgerWith([{}]);
    const report = "标题\n\n## 核心判断\n\n规模从 1000 亿增长至 2000 亿，同比增长 20%[E1]。";
    const out = gateReport(report, l, []);
    expect(out.violations.some((v) => v.rule === "A4-G05")).toBe(true);
    // `calculations` 要原样带出去：屏幕上那句「复算了什么」读的是它。
    expect(out.calculations).toHaveLength(1);
  });
});

describe("A4-G06 引了「限定」当「支持」只记不挡", () => {
  it("是 p1", async () => {
    /*
     * 判准这一条要读上下文（这条限定是被当成限定用的，还是被当成依据用的），确定性代码
     * 只能给提示。判成 p0 会让报告为了过闸去删掉正确的限定条件。
     */
    const l = ledgerWith([{}, { url: URL_B, exactQuote: "另外两个行业同期没有出现同样的回落", ...relation("qualifies") }]);
    expect(rules("标题\n\n## 核心判断\n\n回落存在[E1]，范围有限[E2]。", l)).toEqual(["A4-G06/p1"]);
  });
});

describe("没有台账时不硬判", () => {
  it("未联网那一支只查地址和占位符", async () => {
    // 其余几条在没有台账时无从判定。硬判会让每次未联网的运行都挂着一堆假违规，
    // 而挂着的违规等于没有违规。
    expect(rules("标题\n\n## 核心判断\n\n本轮未联网核验。", new Ledger())).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* 引用绑定                                                                    */
/* -------------------------------------------------------------------------- */

const doc = (text: string): ResearchDoc =>
  ({
    judgment: [{ text, traces: [] }],
    keyEvidence: [],
    counters: [],
    unknowns: [],
    routeSuggestion: "",
  }) as unknown as ResearchDoc;

describe("四节里的编号换成可点开的溯源", () => {
  it("编号从正文里摘掉，链接挂到 traces 上", async () => {
    /*
     * 屏幕上留着 `[E1]` 对读的人没有意义 —— 他要的是能点开的那一下。编号只在报告原文里
     * 留着，那份是可署名分发的原件，编号在那里是引用体系的一部分。
     */
    const l = ledgerWith([{}]);
    const d = doc("指标确实在回落[E1]。");
    expect(bindCitations(d, l)).toBe(1);
    expect(d.judgment[0].text).toBe("指标确实在回落。");
    expect(d.judgment[0].traces?.[0]).toMatchObject({ kind: "ext", href: URL_A });
    // 档次写进标签：「A 级」和「D 级」的分量不一样。
    expect(d.judgment[0].traces?.[0]?.source).toContain("A 级");
  });

  it("台账里没有的编号只摘不绑", async () => {
    const l = ledgerWith([{}]);
    const d = doc("指标确实在回落[E9]。");
    expect(bindCitations(d, l)).toBe(0);
    expect(d.judgment[0].text).toBe("指标确实在回落。");
  });

  it("同一个地址已经挂过就不重复挂", async () => {
    const l = ledgerWith([{}]);
    const d = doc("指标确实在回落[E1][E1]。");
    expect(bindCitations(d, l)).toBe(1);
    expect(d.judgment[0].traces).toHaveLength(1);
  });

  it("没有编号的条目原样不动", async () => {
    const l = ledgerWith([{}]);
    const d = doc("这一条来自内部台账。");
    expect(bindCitations(d, l)).toBe(0);
    expect(d.judgment[0].text).toBe("这一条来自内部台账。");
  });
});

describe("溯源清单", () => {
  it("每一条都带得点开的地址", async () => {
    // 一句「带了 4 项 Context」如果点不开，读者只能选择相信或不相信，那就不是证明。
    const items = evidenceManifest(ledgerWith([{}]));
    expect(items).toHaveLength(1);
    expect(items[0].href).toBe(URL_A);
    expect(items[0].label).toContain("E1");
    expect(items[0].kind).toBe("ext");
  });
});

/**
 * 任务范围那一层的出口检查。
 *
 * 最要紧的一条：**不能把「没搜」写成「外界不存在」**。它是 ISS-239 那一轮唯一一条重写救得
 * 回来的错（措辞），所以它是 p0；「这条问题没搜过」本身重写救不回来，所以只记不挡。
 */
describe("A4-G07/G08/G09 任务范围", () => {
  const t = (over: Partial<ScopeQuestionTrace> = {}): ScopeQuestionTrace => ({
    id: "Q1-1",
    question: "对方的验收口径由谁定",
    dimension: "D2",
    routeIds: ["R1"],
    dependsOn: [],
    changesChoice: true,
    status: "未搜",
    evidenceIds: [],
    tried: [],
    why: "这一轮的检索计划里没有它 —— 没搜过，不是外面没有",
    ...over,
  });

  it("有未搜的问题、正文却写「没有任何公开材料」—— p0，重写改得掉", () => {
    const v = gateScope("## 核心判断\n\n这方面没有任何公开材料。", [t()]);
    expect(v.filter((x) => x.rule === "A4-G07")).toHaveLength(1);
    expect(v.find((x) => x.rule === "A4-G07")?.severity).toBe("p0");
    expect(v.find((x) => x.rule === "A4-G07")?.message).toContain("Q1-1");
  });

  it("同样一句话，问题是「已搜未得」时不判 —— 那句话它有资格说", () => {
    const v = gateScope("## 核心判断\n\n这方面没有任何公开材料。", [
      t({ status: "已搜未得", tried: ["a", "b", "c", "d"], why: "试过 4 条问法" }),
    ]);
    expect(v.some((x) => x.rule === "A4-G07")).toBe(false);
  });

  it("正文说的是「本轮没有检索到」时不判 —— 那句已经说对了", () => {
    expect(gateScope("## 核心判断\n\n本轮没有检索到相关材料。", [t()]).some((x) => x.rule === "A4-G07")).toBe(
      false
    );
  });

  it("会改变路线又没搜过的，只记不挡：p1，而且要带上关联路线", () => {
    const v = gateScope("正文", [t(), t({ id: "Q2-1", changesChoice: false })]);
    const g08 = v.filter((x) => x.rule === "A4-G08");
    expect(g08).toHaveLength(1);
    expect(g08[0].severity).toBe("p1");
    expect(g08[0].message).toContain("R1");
  });

  it("答案在内部的那条记成「需要内部材料或客户确认」，不是再派一轮检索", () => {
    const v = gateScope("正文", [t({ status: "不适用", why: "需要内部材料或客户确认" })]);
    const g09 = v.filter((x) => x.rule === "A4-G09");
    expect(g09).toHaveLength(1);
    expect(g09[0].message).toContain("不要再派检索去补");
  });

  it("行业题没有关键问题，这一层一条都不报", () => {
    expect(gateScope("这方面没有任何公开材料。", [])).toEqual([]);
  });
});
