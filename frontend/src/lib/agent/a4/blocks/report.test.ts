import { describe, expect, it } from "vitest";

import { FIXTURE_BLOCK_COUNT, FIXTURE_JSONL, FIXTURE_LEDGER, fixtureReport } from "./fixture";
import { lintAssembled } from "./lint";
import {
  assembleReport,
  blocksToText,
  disclosureCutoffOf,
  foldDuplicateKpis,
  foldSynonymousClaims,
  spliceRepair,
  type Assembled,
} from "./report";
import type { Block } from "./schema";

const LANE = { model: "gpt-5.6", short: "GPT-5.6", durationS: 214 } as const;

const asm = (text: string, complete = true): Assembled =>
  assembleReport({ text, entries: FIXTURE_LEDGER, lane: { ...LANE }, complete });

/** 一份长得像样的决断包。字段填齐，因为这一份要证明「字段齐全时解析器不丢东西」。 */
const BRIEF = {
  type: "command_brief",
  situation: [{ text: "样本机房上架率停在 62%", evidenceRefs: ["E2"] }],
  recommendation: {
    action: "先修上架节奏，本季不谈调度改造",
    intent: "季末交付到上架的间隔压回一个季度以内",
    whyNow: "变电扩容的窗口在本季，错过要等下一轮",
    confidence: "当前更支持",
    evidenceRefs: ["E2", "E5"],
    evidenceEffect: "narrowed",
    evidenceEffectWhy: "E2 把落差收在上架这一级，E5 说明调度那一段是需求侧的",
  },
  decisionsRequired: [
    {
      question: "本季的改造预算是全部投上架，还是留三成给调度",
      recommendedChoice: "全部投上架",
      costOfDelay: "错过本季变电窗口，上架率再压一个季度",
      recoveryIfWrong: "下季度把预算转回调度，已投的机柜不作废",
    },
  ],
  proposedOrders: [
    {
      role: "交付技术",
      outcome: "拿到三个机房交付到上架的实际间隔",
      dueOn: "2026-09-19",
      acceptance: ["三个机房各一张按批次的时间表", "口径和行业研究院样本一致"],
      resources: ["机房台账读取权限"],
    },
  ],
  controls: {
    mustNot: ["不许在这一季对外承诺调度可用率"],
    changeTriggers: ["下一期样本上架率跌破五成"],
    abortConditions: ["变电扩容验收推迟到下季"],
    reviewAt: "2026-10-08",
  },
  alternatives: [{ action: "上架与调度各投一半", whenBetter: "需求侧先起来、租金止跌时" }],
};

const withBrief = (brief: unknown = BRIEF): string => {
  const lines = FIXTURE_JSONL.trimEnd().split("\n");
  // 位置照收口交上来的样子：report_meta 之后、第一个块之前。
  return `${[lines[0], JSON.stringify(brief), ...lines.slice(1)].join("\n")}\n`;
};

describe("组装", () => {
  it("整段 JSONL 组装出落库形态", () => {
    const a = asm(FIXTURE_JSONL);
    expect(a.blocks).toHaveLength(FIXTURE_BLOCK_COUNT);
    expect(a.meta?.title).toContain("装机在涨");
    expect(a.report.confidence).toBe("较强支持");
    expect(a.report.lane.short).toBe("GPT-5.6");
    expect(a.report.evidencePackId).toMatch(/^pack-5-/);
    expect(a.report.bad).toBeUndefined();
    expect(a.pending).toBe("");
  });

  it("每个块都带得出它原样的那一行，和块同序", () => {
    const a = asm(FIXTURE_JSONL);
    expect(a.sources).toHaveLength(a.blocks.length);
    a.blocks.forEach((b, i) => {
      expect(JSON.parse(a.sources[i]).type).toBe(b.type);
    });
  });

  it("§6④ 截断的前缀照样组装得出来：前面的块在，最后半行进 pending", () => {
    const cut = `${FIXTURE_JSONL.split("\n").slice(0, 4).join("\n")}\n{"type":"fun`;
    const a = asm(cut, false);
    expect(a.blocks).toHaveLength(3);
    expect(a.pending).toBe(`{"type":"fun`);
    expect(a.report.bad).toBeUndefined();
    expect(a.report.title).toContain("装机在涨");
  });

  it("缺 report_meta 不抛异常 —— 那是一条违规，不是一次崩溃", () => {
    const a = asm(FIXTURE_JSONL.split("\n").slice(1).join("\n"));
    expect(a.meta).toBeUndefined();
    expect(a.report.title).toBe("");
    expect(a.report.confidence).toBe("初步提示");
    expect(a.blocks).toHaveLength(FIXTURE_BLOCK_COUNT);
    expect(lintAssembled(a).map((x) => x.message).join("")).toContain("少了 report_meta");
  });

  it("fixture 和真链路走的是同一个组装 —— fixtureReport() 就是这条路的产物", () => {
    expect(fixtureReport()).toEqual(asm(FIXTURE_JSONL).report);
  });
});

describe("决断包（ISS-238）", () => {
  it("解析出来挂在 report.commandBrief 上，八栏一栏不少", () => {
    const a = asm(withBrief());
    const cb = a.report.commandBrief;
    expect(cb?.recommendation.action).toContain("先修上架节奏");
    expect(cb?.recommendation.confidence).toBe("当前更支持");
    expect(cb?.recommendation.evidenceEffect).toBe("narrowed");
    expect(cb?.recommendation.evidenceRefs).toEqual(["E2", "E5"]);
    expect(cb?.situation).toHaveLength(1);
    expect(cb?.decisionsRequired[0].recoveryIfWrong).toContain("下季度");
    expect(cb?.proposedOrders[0].role).toBe("交付技术");
    expect(cb?.proposedOrders[0].acceptance).toHaveLength(2);
    expect(cb?.controls.changeTriggers).toHaveLength(1);
    expect(cb?.controls.abortConditions).toHaveLength(1);
    expect(cb?.controls.reviewAt).toBe("2026-10-08");
    expect(cb?.alternatives).toHaveLength(1);
    expect(cb?.defaulted).toBeUndefined();
  });

  it("**不进块序列**：块数一个不多，blocks 和 sources 照旧同序同长", () => {
    /*
     * 这一条是这套设计的全部代价所在。决断包一旦占一个块的位置，`lint.ts` 报的「第 N 个块」
     * 和 `spliceRepair` 按下标对齐的那一套就整体错一格 —— 而错一格的表现是返修改了另一个块。
     */
    const a = asm(withBrief());
    expect(a.blocks).toHaveLength(FIXTURE_BLOCK_COUNT);
    expect(a.report.blocks).toHaveLength(FIXTURE_BLOCK_COUNT);
    expect(a.sources).toHaveLength(a.blocks.length);
    expect(a.blocks.some((b) => (b as { type: string }).type === "command_brief")).toBe(false);
    expect(a.report.bad).toBeUndefined();
    // 别的一切和没有决断包那一份逐字相同。
    expect(a.sources).toEqual(asm(FIXTURE_JSONL).sources);
  });

  it("行业题（没交这一行）时那一栏就是没有，不是一个空壳", () => {
    expect(asm(FIXTURE_JSONL).report.commandBrief).toBeUndefined();
    expect(asm(FIXTURE_JSONL).commandBriefLine).toBe("");
  });

  it("缺栏落空，枚举给不出落默认值并记进 defaulted", () => {
    const a = asm(
      withBrief({
        type: "command_brief",
        recommendation: { action: "先修上架节奏" },
        proposedOrders: [{ role: "客户线", outcome: "拿到验收口径的书面确认" }],
      })
    );
    const cb = a.report.commandBrief;
    expect(cb?.situation).toEqual([]);
    expect(cb?.decisionsRequired).toEqual([]);
    expect(cb?.controls).toEqual({ mustNot: [], changeTriggers: [], abortConditions: [] });
    expect(cb?.alternatives).toBeUndefined();
    expect(cb?.recommendation.confidence).toBe("初步提示");
    // 默认值往「这一轮什么都没改变」那一边落，同 confidence 落最低那一挡。
    expect(cb?.recommendation.evidenceEffect).toBe("confirmed");
    expect(cb?.defaulted).toEqual(["recommendation.confidence", "recommendation.evidenceEffect"]);
  });

  it("整块站不住才拒：只有几条态势的那一份是空表单，进 bad 而不是进产物", () => {
    const a = asm(withBrief({ type: "command_brief", situation: [{ text: "上架率停在 62%" }] }));
    expect(a.report.commandBrief).toBeUndefined();
    expect(a.report.bad?.map((x) => x.why).join("")).toContain("空表单");
    // 拒掉它不牵连任何一个块。
    expect(a.blocks).toHaveLength(FIXTURE_BLOCK_COUNT);
  });

  it("交了两个时以第一个为准，第二个记一条 —— 哪一份是他要拍的板没人猜得出来", () => {
    const lines = withBrief().trimEnd().split("\n");
    const second = JSON.stringify({ ...BRIEF, recommendation: { ...BRIEF.recommendation, action: "改成先谈调度" } });
    const a = asm(`${[...lines, second].join("\n")}\n`);
    expect(a.report.commandBrief?.recommendation.action).toContain("先修上架节奏");
    expect(a.report.bad?.map((x) => x.why).join("")).toContain("第二个 command_brief");
  });

  it("**一次返修不会把它丢掉** —— 它不在 sources 里，得显式拼回去", () => {
    const prev = asm(withBrief());
    const at = prev.blocks.findIndex((b) => b.heading === "对我们的当前含义") + 1;
    const fixed = JSON.stringify({ type: "prose", heading: "对我们的当前含义", md: "改好的那一段 [E7]。" });
    const out = spliceRepair({
      previous: prev,
      rejected: [{ at, line: prev.sources[at - 1], why: "A4-B02 …" }],
      needsMeta: false,
      reply: fixed,
    });
    expect(out.notes).toEqual([]);
    const again = asm(out.text);
    expect(again.report.commandBrief?.recommendation.action).toContain("先修上架节奏");
    expect(again.sources[at - 1]).toBe(fixed);
    expect(again.blocks).toHaveLength(prev.blocks.length);
  });

  it("返修那一轮它自己多交了一行决断包：丢掉、留上一稿，而且不牵连块的对齐", () => {
    const prev = asm(withBrief());
    const at = prev.blocks.findIndex((b) => b.heading === "对我们的当前含义") + 1;
    const fixed = JSON.stringify({ type: "prose", heading: "对我们的当前含义", md: "改好的那一段 [E7]。" });
    const rewritten = JSON.stringify({ ...BRIEF, recommendation: { ...BRIEF.recommendation, action: "换了个主张" } });
    const out = spliceRepair({
      previous: prev,
      rejected: [{ at, line: prev.sources[at - 1], why: "…" }],
      needsMeta: false,
      reply: [rewritten, fixed].join("\n"),
    });
    expect(out.notes.join("")).toContain("多交了一行 command_brief");
    const again = asm(out.text);
    expect(again.report.commandBrief?.recommendation.action).toContain("先修上架节奏");
    // 混进 parsedLines 的话这一块会被那一行顶掉，块就错位了。
    expect(again.sources[at - 1]).toBe(fixed);
  });

  it("不进纯文本面 —— 那份是论证，决断包是论证之上要他拍的板", () => {
    const text = blocksToText(asm(withBrief()).report);
    expect(text).not.toContain("本季不谈调度改造");
    expect(text).not.toContain("不许在这一季对外承诺调度可用率");
    expect(text).toBe(blocksToText(asm(FIXTURE_JSONL).report));
  });
});

describe("材料截至哪一天：由台账定，不由模型写（ISS-238）", () => {
  const ev = (over: Partial<(typeof FIXTURE_LEDGER)[number]>) => ({ ...FIXTURE_LEDGER[0], ...over });
  const cut = (entries: (typeof FIXTURE_LEDGER)[number][], domains?: string[]) =>
    assembleReport({
      text: FIXTURE_JSONL,
      entries,
      lane: { model: "m", short: "M" },
      complete: true,
      ...(domains ? { disclosureDomains: domains } : {}),
    }).report.dataCutoff;

  it("取台账里最晚那份一手披露的报告期，不是模型写的那一行", () => {
    const out = cut([
      ev({ url: "https://static.cninfo.com.cn/a.pdf", sourceDomain: "static.cninfo.com.cn", period: "2024 年度" }),
      ev({ url: "https://static.cninfo.com.cn/b.pdf", sourceDomain: "static.cninfo.com.cn", period: "2025 年度" }),
    ]);
    expect(out).toBe("2025-12-31");
  });

  it("转载页上的日期不算：它是发稿那天，不是这份数是哪一期", () => {
    const out = cut([
      ev({ url: "https://www.sohu.com/a/1.html", sourceDomain: "sohu.com", period: "2026 年上半年" }),
      ev({ url: "https://static.cninfo.com.cn/a.pdf", sourceDomain: "static.cninfo.com.cn", period: "2024 年度" }),
    ]);
    expect(out).toBe("2024-12-31");
  });

  it("主体官网也算一手披露 —— 但要把域名递进来", () => {
    const entries = [
      ev({ url: "https://ir.visionox.com/n1.html", sourceDomain: "ir.visionox.com", period: "2026 年第一季度" }),
    ];
    expect(cut(entries, ["visionox.com"])).toBe("2026-03-31");
    // 不递就只认写死的那张表：这一条不算，落回模型写的那一行。
    expect(cut(entries)).not.toBe("2026-03-31");
  });

  /*
   * 2026-09-07（ISS-239）：这一条换了口径。
   *
   * 上一版拿不到披露时落回模型写的那一行，理由是「空格读起来像还没算」。ISS-239 证明那个
   * 理由站不住 —— 屏幕上出现的是一个看着像核过、其实是模型顺手写的日期。现在写「未确定」。
   */
  it("一条披露都没有时写「未确定」—— 不回落到模型编的日期", () => {
    const asmOne = assembleReport({
      text: FIXTURE_JSONL,
      entries: [ev({ url: "https://www.sohu.com/a/1.html", sourceDomain: "sohu.com", period: "2026 年度" })],
      lane: { model: "m", short: "M" },
      complete: true,
    });
    expect(asmOne.report.dataCutoff).toBe("未确定");
    // 模型原来写的那一行没有丢，它还在 meta 上 —— 要审计随时取得到。
    expect(asmOne.meta?.dataCutoff).toBe("2026-08-20");
  });

  it("历史事件不当材料截止：产线建成那年 vs 年报那一期（ISS-239）", () => {
    const 官网历史 = ev({
      id: "E1",
      url: "https://www.visionox.com/about/history",
      sourceDomain: "www.visionox.com",
      authorityClass: "company_primary",
      evidenceType: "event",
      usedAs: "historical_point",
      period: "2020-12",
    });
    const 镜像年报 = ev({
      id: "E25",
      url: "http://vip.stock.finance.sina.com.cn/corp/view/x.php",
      sourceDomain: "vip.stock.finance.sina.com.cn",
      authorityClass: "company_primary",
      evidenceType: "statistic",
      usedAs: "current_state",
      period: "2025年",
    });
    // 旧实现在这一组上输出 2020-12-31：E1 在官网上、期次也认得出，于是它成了整份的截止日。
    expect(cut([官网历史], ["visionox.com"])).toBe("未确定");
    expect(cut([官网历史, 镜像年报], ["visionox.com"])).toBe("2025-12-31（镜像转载的公司披露，原站未核对）");
  });

  it("判据的结构取得到：哪几条撑的、为什么", () => {
    const out = disclosureCutoffOf(
      [
        ev({
          id: "E25",
          url: "http://vip.stock.finance.sina.com.cn/corp/view/x.php",
          sourceDomain: "vip.stock.finance.sina.com.cn",
          authorityClass: "company_primary",
          period: "2025年",
        }),
      ],
      ["visionox.com"]
    );
    expect(out).toMatchObject({ status: "dated", date: "2025-12-31", origin: "mirrored", refs: ["E25"] });
    expect(out.why).toContain("原站与这份转载的身份没有逐字核过");
  });
});

describe("同一个数只印一遍（ISS-238 的四个数各出现两遍）", () => {
  const table: Block = {
    type: "layered_table",
    heading: "分层看",
    columns: ["机房类型", "上架率"],
    rows: [
      ["一线城市自建", "71%"],
      ["改造型机房", "62%"],
    ],
    evidenceRefs: ["E2"],
  };
  const card = (over: Partial<{ value: string; unit: string; label: string }> = {}) => ({
    value: "62",
    unit: "%",
    label: "改造型机房",
    caliberNote: "已上架机柜/已交付机柜",
    evidenceRefs: ["E2"],
    ...over,
  });

  it("数值和标签落在同一行时，表保留、卡折成一句引用", () => {
    const kpi: Block = { type: "kpi_cards", heading: "三个数", cards: [card()] };
    const out = foldDuplicateKpis([kpi, table]);
    // 块的个数不变 —— 少一个块会让 appendixFrom 和 sources 一起错位。
    expect(out.blocks).toHaveLength(2);
    expect(out.blocks[1]).toBe(table);
    const folded = out.blocks[0];
    expect(folded.type).toBe("prose");
    expect(folded.heading).toBe("三个数");
    expect(folded.type === "prose" && folded.md).toContain("只留一句引用");
    // 编号跟着句子一起过来，不然这一句在 A4-B02 那里是「带数字没绑证据」。
    expect(folded.type === "prose" && folded.md).toContain("[E2]");
    expect(out.notes.join("")).toContain("改造型机房");
  });

  it("同一块里还有别的数时只折掉重复那一张，剩下的照旧是卡", () => {
    const kpi: Block = {
      type: "kpi_cards",
      cards: [card(), card({ value: "0.42–0.68", unit: "元/kWh", label: "工业电价区间" })],
    };
    const out = foldDuplicateKpis([kpi, table]);
    const kept = out.blocks[0];
    expect(kept.type).toBe("kpi_cards");
    expect(kept.type === "kpi_cards" && kept.cards.map((c) => c.label)).toEqual(["工业电价区间"]);
    expect(out.notes).toHaveLength(1);
  });

  it("只有数值对得上、标签对不上：不折 —— 「上架率 62%」和「客户数 62」不是同一个数", () => {
    const kpi: Block = { type: "kpi_cards", cards: [card({ label: "本季新签客户数", unit: "" })] };
    const out = foldDuplicateKpis([kpi, table]);
    expect(out.blocks[0]).toBe(kpi);
    expect(out.notes).toEqual([]);
  });

  it("只有标签对得上、数值对不上：不折 —— 同一个指标的另一个口径正是报告要说的事", () => {
    const kpi: Block = { type: "kpi_cards", cards: [card({ value: "44" })] };
    expect(foldDuplicateKpis([kpi, table]).blocks[0]).toBe(kpi);
  });

  it("数值和标签各在一行上凑出来的不算 —— 要求落在同一行", () => {
    const kpi: Block = { type: "kpi_cards", cards: [card({ label: "一线城市自建", value: "62" })] };
    expect(foldDuplicateKpis([kpi, table]).blocks[0]).toBe(kpi);
  });

  it("带不带单位、带不带「约」和证据编号都对得上", () => {
    const t: Block = { ...table, rows: [["改造型机房", "约 62% [E2]"]] } as Block;
    const kpi: Block = { type: "kpi_cards", cards: [card()] };
    expect(foldDuplicateKpis([kpi, t]).notes).toHaveLength(1);
  });

  it("fixture 这一份一个都不该折 —— 它的卡和表说的不是同一个数", () => {
    const a = asm(FIXTURE_JSONL);
    expect(a.dedup).toEqual([]);
    expect(a.report.blocks).toEqual(a.blocks);
  });

  it("走 assembleReport 那条路时，证据表照旧从模型交的那一份折", () => {
    // 折掉的卡上的编号仍然是这一轮引过的；从证据表里一起消失会让它变成「取回来没用上」。
    const jsonl = [
      JSON.stringify({ type: "report_meta", title: "标题就是判断", confidence: "较强支持", dataCutoff: "2026-08-20" }),
      JSON.stringify({ type: "kpi_cards", heading: "一个数", cards: [card()] }),
      JSON.stringify(table),
    ].join("\n");
    const a = asm(`${jsonl}\n`);
    expect(a.blocks[0].type).toBe("kpi_cards");
    expect(a.report.blocks[0].type).toBe("prose");
    expect(a.report.blocks).toHaveLength(a.blocks.length);
    expect(a.report.evidence.some((e) => e.id === "E2")).toBe(true);
    expect(a.dedup).toHaveLength(1);
  });
});

describe("纯文本面", () => {
  const text = blocksToText(fixtureReport());

  it("第一行是标题，之后每节 ## 开头 —— 和旧格式同一个形状", () => {
    const lines = text.split("\n\n");
    expect(lines[0]).toContain("装机在涨");
    expect(lines[0].startsWith("#")).toBe(false);
    expect(text.split("\n\n").filter((x) => x.startsWith("## ")).length).toBeGreaterThan(5);
  });

  it("没有 markdown 记号：不加粗、不列表、不画竖线表格", () => {
    // `## ` 不在这一条里 —— 小标题是旧格式本来就有的写法，压成四节那一步认它。
    expect(text).not.toContain("**");
    expect(text).not.toMatch(/^[-*]\s/m);
    expect(text).not.toMatch(/^\d+\.\s/m);
    expect(text).not.toContain("|");
  });

  it("引用编号跟着句子一起过来", () => {
    expect(text).toContain("[E1]");
    expect(text).toContain("[E5]");
  });

  it("表格竖过来，一行一段，用全角竖线分栏", () => {
    expect(text).toContain("机房类型　｜　上架率");
    expect(text).toMatch(/一线城市自建　｜　71%/);
  });

  it("不可相加那件事在文字面上要说出来 —— 组件那层的保护在这里没有了", () => {
    expect(text).toContain("只可比较、不可相加");
  });

  it("「未能核实」那一节由代码补前缀，出口闸 A4-G04 才找得到它", () => {
    expect(text).toContain("## 未能核实的部分：这几条本轮没能核实");
  });

  it("判断块把推翻条件和升档条件都写进文字面", () => {
    expect(text).toContain("什么会推翻它：");
    expect(text).toContain("什么会让它升一档：");
  });

  it("没有标题的块接在上一节里，不硬造小标题", () => {
    const headings = text.split("\n\n").filter((x) => x.startsWith("## ")).length;
    expect(headings).toBeLessThan(FIXTURE_BLOCK_COUNT);
  });
});

describe("返修：把重发的几块贴回去", () => {
  const base = (): Assembled => asm(FIXTURE_JSONL);
  /** fixture 里第 12 个块（1 起数）是「对我们的当前含义」那一节。 */
  const at = base().blocks.findIndex((b) => b.heading === "对我们的当前含义") + 1;
  const fixed = JSON.stringify({
    type: "prose",
    heading: "对我们的当前含义",
    md: "我们自己的机房处在改造型这一档 [E7]。先修上架节奏、再谈调度 [E7]。",
  });

  it("换掉被拒的那一块，别的一个字不动", () => {
    const prev = base();
    const out = spliceRepair({
      previous: prev,
      rejected: [{ at, line: prev.sources[at - 1], why: "A4-B02 …" }],
      needsMeta: false,
      reply: fixed,
    });
    expect(out.notes).toEqual([]);
    const again = asm(out.text);
    expect(again.blocks).toHaveLength(prev.blocks.length);
    expect(again.sources[at - 1]).toBe(fixed);
    expect(again.sources.filter((_, i) => i !== at - 1)).toEqual(
      prev.sources.filter((_, i) => i !== at - 1)
    );
    expect(again.meta).toEqual(prev.meta);
  });

  it("少交一块：那一块保留上一稿，并且记一条", () => {
    const prev = base();
    const out = spliceRepair({
      previous: prev,
      rejected: [
        { at, line: prev.sources[at - 1], why: "…" },
        { at: at + 1, line: prev.sources[at], why: "…" },
      ],
      needsMeta: false,
      reply: fixed,
    });
    expect(out.notes.join("")).toContain("没有重发回来");
    expect(asm(out.text).sources[at]).toBe(prev.sources[at]);
  });

  it("重发回来的那一行读不通：保留上一稿，不拿一块空白换一条能指认的违规", () => {
    const prev = base();
    const out = spliceRepair({
      previous: prev,
      rejected: [{ at, line: prev.sources[at - 1], why: "…" }],
      needsMeta: false,
      reply: `{"type":"prose","md":"少了一个右括号`,
    });
    expect(out.notes.join("")).toContain("读不通");
    expect(asm(out.text).sources[at - 1]).toBe(prev.sources[at - 1]);
  });

  it("多交的行丢掉，并且记一条", () => {
    const prev = base();
    const out = spliceRepair({
      previous: prev,
      rejected: [{ at, line: prev.sources[at - 1], why: "…" }],
      needsMeta: false,
      reply: [fixed, fixed].join("\n"),
    });
    expect(out.notes.join("")).toContain("多交了 1 行");
    expect(asm(out.text).blocks).toHaveLength(prev.blocks.length);
  });

  it("围栏照旧容错", () => {
    const prev = base();
    const out = spliceRepair({
      previous: prev,
      rejected: [{ at, line: prev.sources[at - 1], why: "…" }],
      needsMeta: false,
      reply: ["```json", fixed, "```"].join("\n"),
    });
    expect(out.notes).toEqual([]);
    expect(asm(out.text).sources[at - 1]).toBe(fixed);
  });

  it("要求重交 report_meta：认它交回来的那一行", () => {
    const prev = asm(FIXTURE_JSONL.split("\n").slice(1).join("\n"));
    const meta = JSON.stringify({
      type: "report_meta",
      title: "补上的标题：瓶颈在上架与调度",
      confidence: "较强支持",
      dataCutoff: "2026-08-20",
    });
    const out = spliceRepair({ previous: prev, rejected: [], needsMeta: true, reply: meta });
    expect(out.notes).toEqual([]);
    const again = asm(out.text);
    expect(again.meta?.title).toContain("补上的标题");
    expect(again.blocks).toHaveLength(prev.blocks.length);
  });

  it("没要 report_meta 它却交了一行：丢掉并记一条 —— 上一稿的元数据是准的", () => {
    const prev = base();
    const out = spliceRepair({
      previous: prev,
      rejected: [{ at, line: prev.sources[at - 1], why: "…" }],
      needsMeta: false,
      reply: [JSON.stringify({ type: "report_meta", title: "换了个标题" }), fixed].join("\n"),
    });
    expect(out.notes.join("")).toContain("多交了一行 report_meta");
    expect(asm(out.text).meta?.title).toContain("装机在涨");
  });
});

/* ISS-239：判断板上「当前判断 1」和「当前判断 3」基本同义，一号位读到同一件事说了两遍。 */
describe("同一条判断只上板一次", () => {
  it("同义的合成一条，证据编号并过去", () => {
    const out = foldSynonymousClaims([
      { text: "首访应该先弄清客户要解决的问题，不谈报价。", evidenceRefs: ["E12"] },
      { text: "这一次拜访先弄清客户要解决的问题，不谈报价", evidenceRefs: ["E25"] },
    ]);
    expect(out.kept).toHaveLength(1);
    expect(out.kept[0].text).toBe("首访应该先弄清客户要解决的问题，不谈报价。");
    expect(out.kept[0].evidenceRefs).toEqual(["E12", "E25"]);
    expect(out.notes.join("")).toContain("同义");
  });

  it("同一个 claim ID = 收口与正文各印了一遍", () => {
    const out = foldSynonymousClaims([
      { text: "以经营负责人为切入口更稳妥。", claimId: "C-3", evidenceRefs: ["E1"] },
      { text: "综合看，先找经营负责人谈，风险最小。", claimId: "C-3", evidenceRefs: ["E2"] },
    ]);
    expect(out.kept).toHaveLength(1);
    expect(out.kept[0].evidenceRefs).toEqual(["E1", "E2"]);
    expect(out.notes.join("")).toContain("C-3");
  });

  it("不同边界不折 —— 那两条摆在一起才是报告要说的事", () => {
    const out = foldSynonymousClaims([
      { text: "ViP 技术已经量产出货。", boundary: "只对穿戴端成立" },
      { text: "ViP 技术已经量产出货。", boundary: "对手机与中尺寸同样成立" },
    ]);
    expect(out.kept).toHaveLength(2);
    expect(out.notes.join("")).toContain("成立边界写得不一样");
  });

  it("一空一有的边界按同一条处理，边界取写了的那个", () => {
    const out = foldSynonymousClaims([
      { text: "ViP 技术已经量产出货。" },
      { text: "ViP 技术已经量产出货。", boundary: "只对穿戴端成立" },
    ]);
    expect(out.kept).toHaveLength(1);
    expect(out.kept[0].boundary).toBe("只对穿戴端成立");
  });

  it("字面相近但一正一反 —— 冲突不是重复", () => {
    const out = foldSynonymousClaims([
      { text: "客户的采购动机已经得到验证。" },
      { text: "客户的采购动机尚未得到验证。" },
    ]);
    expect(out.kept).toHaveLength(2);
    expect(out.notes.join("")).toContain("一正一反");
  });

  it("讲两件事的两条判断一条都不动", () => {
    const out = foldSynonymousClaims([
      { text: "首访先弄清客户要解决的问题。" },
      { text: "8.6 代线的投产时间目前只有初步规划，没有确定排期。" },
    ]);
    expect(out.kept).toHaveLength(2);
    expect(out.notes).toEqual([]);
  });

  it("短语不吃掉整条 —— 含在里面也要够长才算同义", () => {
    const out = foldSynonymousClaims([
      { text: "这一点成立。" },
      { text: "这一点成立，但只在客户已经完成产线改造的前提下成立。" },
    ]);
    expect(out.kept).toHaveLength(2);
  });

  it("原样返回，这一层不改写文字", () => {
    const one = { text: "只有一条。", boundary: "b", claimId: "C-1", evidenceRefs: ["E9"] };
    expect(foldSynonymousClaims([one])).toEqual({ kept: [one], notes: [] });
  });
});
