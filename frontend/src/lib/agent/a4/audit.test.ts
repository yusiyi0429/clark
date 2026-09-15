// src/lib/agent/a4/audit.test.ts
import { describe, expect, it } from "vitest";
import { DIM_IDS } from "./dims";
import { MAX_AUDIT_ROUNDS, auditExit, backTo, isDisclosureEvidence, periodWithin } from "./audit";
import type { AuditEvidence, AuditInput } from "./audit";
import type { CommandBrief } from "./blocks/schema";
import type { Block, BlockEvidence, ReportBlocks } from "./blocks/schema";

const banner = (text: string): Block => ({ type: "verdict_banner", text, confidence: "当前更支持", boundary: "b" });
const judgment = (hooks: string[] = []): Block => ({
  type: "judgment", claim: "c", confidence: "当前更支持", direction: "支持",
  reasoningSummary: "r", upgradeCondition: "u", falsifyCondition: "f",
  evidenceRefs: ["E1"], internalValidationHooks: hooks,
});

const ok = (): AuditInput => ({
  report: {
    title: "总量红利已用完", confidence: "当前更支持", dataCutoff: "2026-08-26",
    lane: { model: "m", short: "s" }, evidencePackId: "p",
    blocks: [
      banner("总量红利已用完，往后决定处境的是份额重排"),
      { type: "prose", md: "机制写透" },
      judgment(),
      { type: "evidence_list", items: Array(10).fill(0).map((_, i) => ({
        id: `E${i}`, claim: "证据内容足够长才能让附录占比提上去，这样正文占比就会降下来", sourceName: "来源", retrievedAt: "2026-08-26"
      })) },
    ],
    appendixFrom: 2, evidence: [],
  } as ReportBlocks,
  card: {
    subject: "维信诺", segments: [{ name: "手机面板", weight: "主体", lifecycle: "现金流" }],
    projects: [{ name: "V5 第 8.6 代线", investment: "550 亿", onlineAt: "2027", techRoute: "ViP", heavy: true }],
    customers: "国产安卓", website: "visionox.com", industry: "柔性中小尺寸 AMOLED，正向 V5 第 8.6 代扩张", window: "±3 年", inward: false, decision: false,
  },
  coverage: DIM_IDS.map((dim) => ({ dim, independentGroups: 2 })),
  strongDims: [],
  gatedHooks: [],
  anchorGateRan: true,
  retrievalRan: true,
  subjectVariables: ["V5 第 8.6 代线量产时点", "ViP 良率爬坡"],
});

describe("七项出口对账", () => {
  it("都过了就一条违规都没有", () => {
    expect(auditExit(ok())).toEqual([]);
  });

  it("问自己家里的事：取证有意不跑，覆盖那两条不报（2026-09-05，ISS-208）", () => {
    const input = ok();
    input.retrievalRan = false;
    input.coverage = DIM_IDS.map((dim) => ({ dim, independentGroups: 0, notFound: { tried: [] } }));
    expect(auditExit(input).some((v) => v.rule === "A4-N02")).toBe(true);
    input.inward = true;
    expect(auditExit(input).some((v) => v.rule === "A4-N02" || v.rule === "A4-N03")).toBe(false);
  });

  it("总判断骑墙 —— A4-N01，打回 N5", () => {
    const input = ok();
    input.report.blocks[0] = banner("这一维证据不足以判断");
    const v = auditExit(input);
    expect(v[0].rule).toBe("A4-N01");
    expect(backTo(v)).toContain("N5");
  });

  it("总判断弃权的几种写法都要拦住 —— ISS-118 那一句就是从这里漏过去的", () => {
    /*
     * `RUN-A4-mth5jkf0-6` 的总判断是「尚不能判断自顶向下与执行层切入哪一条更容易产出
     * 成功案例」。当时 HEDGES 里没有这个说法，这道闸一声没响，那份报告就这样发了出去。
     */
    for (const text of [
      "尚不能判断哪一条路更容易产出成功案例",
      "以现有材料暂时无法判断这两条路的优劣",
      "这一问有待进一步研究",
      "两条路各有利弊，难以判断",
      "证据不足，无法给出方向",
    ]) {
      const input = ok();
      input.report.blocks[0] = banner(text);
      expect(auditExit(input).some((x) => x.rule === "A4-N01"), text).toBe(true);
    }
  });

  it("给了立场的判断照旧放行 —— 降强度不是骑墙", () => {
    const input = ok();
    input.report.blocks[0] = banner(
      "按目前的材料我判断关键变量是任务可验收性，不是切入层次 —— 当前更支持，依据只有一条"
    );
    expect(auditExit(input).some((x) => x.rule === "A4-N01")).toBe(false);
  });

  it("缺一个维度 —— A4-N02 记 p1，不打回（2026-09-04：打回去的节点没有一处会再搜）", () => {
    const input = ok();
    input.coverage = input.coverage.filter((r) => r.dim !== "D3");
    const v = auditExit(input);
    expect(v.some((x) => x.rule === "A4-N02" && x.severity === "p1")).toBe(true);
    // 打回只看 p0（`pipeline.ts` 传的是 `blocking(audit)`），p1 不进重写。
    expect(v.filter((x) => x.severity === "p0")).toEqual([]);
  });

  it("取证整段没跑：覆盖表不逐维报 p0，只报一条 p1 —— 重写救不了没搜过的东西", () => {
    const input = ok();
    input.retrievalRan = false;
    // 整段没跑那一轮，覆盖表就是全零 —— 逐维判的话这里会出八条。
    input.coverage = DIM_IDS.map((dim) => ({ dim, independentGroups: 0, notFound: { tried: [] } }));
    input.strongDims = ["D1", "D4"];
    const v = auditExit(input);
    const coverage = v.filter((x) => x.rule === "A4-N02" || x.rule === "A4-N03");
    expect(coverage).toHaveLength(1);
    expect(coverage[0].severity).toBe("p1");
    // p1 不参与打回 —— 那一轮重写的预算要留给真能被重写改掉的东西。
    expect(v.filter((x) => x.severity === "p0")).toEqual([]);
  });

  it("跑过一波、某几维空手：逐维记，但都是 p1 —— ISS-230 为一条 N03 白重写了一整遍", () => {
    const input = ok();
    input.retrievalRan = true;
    input.coverage = DIM_IDS.map((dim) => ({ dim, independentGroups: 0, notFound: { tried: [] } }));
    const v = auditExit(input).filter((x) => x.rule === "A4-N02");
    expect(v.length).toBe(DIM_IDS.length);
    expect(v.every((x) => x.severity === "p1")).toBe(true);
  });

  it("强判断只有一组独立来源 —— A4-N03 记 p1，不再打回 N4", () => {
    const input = ok();
    input.coverage = input.coverage.map((r) => (r.dim === "D4" ? { ...r, independentGroups: 1 } : r));
    input.strongDims = ["D4"];
    const v = auditExit(input);
    expect(v.some((x) => x.rule === "A4-N03" && x.severity === "p1")).toBe(true);
    expect(v.filter((x) => x.severity === "p0")).toEqual([]);
  });

  it("落回主体那一节的变量和主体卡的重项目没有交集 —— A4-N05", () => {
    const input = ok();
    input.subjectVariables = ["份额", "价格"];
    expect(auditExit(input).some((x) => x.rule === "A4-N05")).toBe(true);
  });

  it("留着没过相关性检查的内部锚点 —— A4-N06", () => {
    const input = ok();
    input.report.blocks[2] = judgment(["AIDC 域算力资产观察"]);
    expect(auditExit(input).some((x) => x.rule === "A4-N06")).toBe(true);
  });

  /*
   * 上面那一条差集在**正常跑法下永远是空的**：摘锚点那一步把没过检的锚点从块里删掉再写回
   * `report.blocks`，所以留在报告里的锚点全在 `gatedHooks` 里。于是回调一旦丢了，这道闸原来
   * 会安静地过 —— 报告照样带着一条谁都没判过的内部锚点，而 A4-N06 一条都不报。
   */
  it("锚点相关性检查压根没跑 —— A4-N06 要报出来，不许安静地过", () => {
    const input = ok();
    input.report.blocks[2] = judgment(["AIDC 域算力资产观察"]);
    // 摘那一步之后的真实形状：报告里剩下的锚点全在 `gatedHooks` 里。
    input.gatedHooks = ["AIDC 域算力资产观察"];
    input.anchorGateRan = false;
    const v = auditExit(input);
    const n06 = v.filter((x) => x.rule === "A4-N06");
    expect(n06.some((x) => x.message.includes("压根没跑"))).toBe(true);
    // 差集那条保险带在这种形状下一条都报不出来 —— 这一条测的正是它拦不住的那一种。
    expect(n06).toHaveLength(1);
    expect(backTo(v)).toContain("N4");
  });

  it("检查跑过、报告里剩下的锚点都过了检 —— 一条 A4-N06 都不许报", () => {
    const input = ok();
    input.report.blocks[2] = judgment(["AIDC 域算力资产观察"]);
    input.gatedHooks = ["AIDC 域算力资产观察"];
    expect(auditExit(input).some((x) => x.rule === "A4-N06")).toBe(false);
  });

  it("正文里铺着校验机械 —— A4-N07", () => {
    const input = ok();
    input.report.appendixFrom = 3;
    expect(auditExit(input).some((x) => x.rule === "A4-N07")).toBe(true);
  });

  it("出口对账只跑一轮，不再整段打回重写（2026-09-04：四轮里只兑现过一次，499 秒换回一条）", () => {
    expect(MAX_AUDIT_ROUNDS).toBe(1);
  });
});

/* -------------------------------------------------------------------------- */
/* A4-N08 决断包成形                                                           */
/* -------------------------------------------------------------------------- */

const ev = (id: string, grade: "A" | "B" | "C"): BlockEvidence => ({
  id,
  claim: "证据内容",
  sourceName: "巨潮",
  sourceType: "公司披露",
  verified: true,
  retrievedAt: "2026-09-07",
  independenceGroup: "dom:cninfo.com.cn",
  grade,
  origin: "ledger",
});

const fullBrief = (): CommandBrief => ({
  situation: [{ text: "总量红利已用完", evidenceRefs: ["E1"] }],
  recommendation: {
    action: "首访只谈验收口径，不报价",
    intent: "把这一轮谈成可验收的一件小事",
    whyNow: "V5 产线 2027 上线，口径要在开工前定",
    confidence: "当前更支持",
    evidenceRefs: ["E2"],
    evidenceEffect: "narrowed",
    evidenceEffectWhy: "2025 年报的现金流把「资金紧」这条收窄到了「资本开支节奏紧」",
  },
  decisionsRequired: [
    { question: "首访谈不谈价", recommendedChoice: "不谈", costOfDelay: "错过开工前窗口", recoveryIfWrong: "二访补报价" },
  ],
  proposedOrders: [
    {
      role: "行业组",
      outcome: "一页验收口径草案",
      // 2026-09-07：确定日期要带依据，`dueBasis` 是这一版新加的栏（`schema.ts`）。
      dueOn: "2026-09-14",
      dueBasis: "对方 9 月 20 日董事会前要拿到",
      acceptance: ["对方签字确认三条口径"],
    },
  ],
  controls: {
    mustNot: ["不承诺交期"],
    changeTriggers: ["对方先提价格"],
    abortConditions: ["对接人换成采购口"],
  },
  alternatives: [{ action: "先发一版书面口径", whenBetter: "对方不肯安排面谈" }],
});

/** 决策题 + 一份形状完整的决断包。`over` 覆盖其中某一段来验单条判据。 */
const briefed = (over: Partial<CommandBrief> = {}): AuditInput => {
  const input = ok();
  input.card = { ...input.card, decision: true };
  input.report = { ...input.report, evidence: [ev("E1", "A"), ev("E2", "B"), ev("E3", "C")] };
  (input.report as unknown as { commandBrief?: CommandBrief }).commandBrief = { ...fullBrief(), ...over };
  return input;
};

const n08 = (input: AuditInput) => auditExit(input).filter((v) => v.rule === "A4-N08");

describe("A4-N08 决断包成形", () => {
  it("决策题 + 形状完整的决断包 —— 一条都不报", () => {
    expect(n08(briefed())).toEqual([]);
  });

  /*
   * **2026-09-07：没交决断包不再是缺陷。**
   *
   * `SubjectCard.decision === true` 只表示「这道题需要做一个选择」，不表示一号位此刻授权
   * 派发命令（HANDOVER §1）。新的出稿形状是判断优先，决断包退成可选的一屏 —— 这两条钉住
   * 「新 UI 已经不要它了、旧闸还在逼它交」这件事不会发生。
   */
  it("决策题没交决断包 —— 零违规，要没要过都一样", () => {
    const input = ok();
    input.card = { ...input.card, decision: true };
    expect(auditExit(input)).toEqual([]);

    // 收口那一次真要过、模型也没交，照旧零违规：没有命令包的报告是合法的。
    input.commandBriefAsked = true;
    expect(auditExit(input)).toEqual([]);
    expect(backTo(auditExit(input))).toEqual([]);
  });

  it("交了就照旧按形状判 —— 松绑的是「要不要交」，不是「交上来的长什么样」", () => {
    const bad = briefed({ controls: { mustNot: [], changeTriggers: [], abortConditions: [] } });
    bad.commandBriefAsked = true;
    const v = n08(bad);
    expect(v.filter((x) => x.severity === "p0").length).toBeGreaterThan(0);
    expect(backTo(auditExit(bad))).toContain("N5");
  });

  it("行业题带着一份烂决断包也一条不判 —— 那一类不交这个", () => {
    const input = briefed({
      recommendation: { ...fullBrief().recommendation, action: "" },
      decisionsRequired: [],
      controls: { mustNot: [], changeTriggers: [], abortConditions: [] },
    });
    input.card = { ...input.card, decision: false };
    input.commandBriefAsked = true;
    expect(n08(input)).toEqual([]);
  });

  it("唯一主张：action 空、备选超过两条 —— 各报一条 p0", () => {
    expect(
      n08(briefed({ recommendation: { ...fullBrief().recommendation, action: "  " } })).some(
        (v) => v.severity === "p0" && v.message.includes("action")
      )
    ).toBe(true);
    expect(
      n08(
        briefed({
          alternatives: [
            { action: "a", whenBetter: "x" },
            { action: "b", whenBetter: "y" },
            { action: "c", whenBetter: "z" },
          ],
        })
      ).some((v) => v.message.includes("备选"))
    ).toBe(true);
    // 正好两条是上限，不报。
    expect(
      n08(
        briefed({
          alternatives: [
            { action: "a", whenBetter: "x" },
            { action: "b", whenBetter: "y" },
          ],
        })
      )
    ).toEqual([]);
  });

  it("要一号位定的事：超过三条、或者四栏缺一栏 —— p0", () => {
    const one = fullBrief().decisionsRequired[0];
    expect(n08(briefed({ decisionsRequired: [one, one, one, one] })).some((v) => v.message.includes("上限 3 条"))).toBe(
      true
    );
    expect(n08(briefed({ decisionsRequired: [one, one, one] }))).toEqual([]);
    for (const key of ["question", "recommendedChoice", "costOfDelay", "recoveryIfWrong"] as const) {
      const v = n08(briefed({ decisionsRequired: [{ ...one, [key]: "" }] }));
      expect(v.some((x) => x.severity === "p0" && x.message.includes(key)), key).toBe(true);
    }
  });

  it("派下去的活：超过三条、或者缺 role/outcome/acceptance —— p0", () => {
    const one = fullBrief().proposedOrders[0];
    expect(n08(briefed({ proposedOrders: [one, one, one, one] })).some((v) => v.message.includes("上限 3 条"))).toBe(true);
    for (const key of ["role", "outcome"] as const) {
      const v = n08(briefed({ proposedOrders: [{ ...one, [key]: "" }] }));
      expect(v.some((x) => x.severity === "p0" && x.message.includes(key)), key).toBe(true);
    }
    // 空数组和一串空白都算没有验收标准。
    expect(n08(briefed({ proposedOrders: [{ ...one, acceptance: [] }] })).some((v) => v.message.includes("acceptance"))).toBe(
      true
    );
    expect(
      n08(briefed({ proposedOrders: [{ ...one, acceptance: ["  "] }] })).some((v) => v.message.includes("acceptance"))
    ).toBe(true);
  });

  it("变更触发与中止条件各要至少一条 —— 少哪一条报哪一条", () => {
    const c = fullBrief().controls;
    expect(n08(briefed({ controls: { ...c, changeTriggers: [] } })).some((v) => v.message.includes("changeTriggers"))).toBe(
      true
    );
    expect(
      n08(briefed({ controls: { ...c, abortConditions: ["  "] } })).some((v) => v.message.includes("abortConditions"))
    ).toBe(true);
    // `mustNot` 不强制：不是每件事都有禁区，硬要一条的结果是模型编一条。
    expect(n08(briefed({ controls: { ...c, mustNot: [] } }))).toEqual([]);
  });

  it("证据把判断怎么了：四个值之外的写法、以及缺一句为什么 —— p0", () => {
    const r = fullBrief().recommendation;
    expect(
      n08(briefed({ recommendation: { ...r, evidenceEffect: "strengthened" as never } })).some((v) =>
        v.message.includes("evidenceEffect")
      )
    ).toBe(true);
    for (const effect of ["confirmed", "narrowed", "changed", "reversed"] as const) {
      expect(n08(briefed({ recommendation: { ...r, evidenceEffect: effect } })), effect).toEqual([]);
    }
    expect(
      n08(briefed({ recommendation: { ...r, evidenceEffectWhy: " " } })).some((v) =>
        v.message.includes("evidenceEffectWhy")
      )
    ).toBe(true);
  });

  it("引的编号在证据表里不存在 —— p0，situation 和 recommendation 两处都查", () => {
    expect(
      n08(briefed({ situation: [{ text: "x", evidenceRefs: ["E9"] }] })).some(
        (v) => v.severity === "p0" && v.message.includes("E9")
      )
    ).toBe(true);
    expect(
      n08(briefed({ recommendation: { ...fullBrief().recommendation, evidenceRefs: ["E7"] } })).some(
        (v) => v.severity === "p0" && v.message.includes("E7")
      )
    ).toBe(true);
    // 编号归一：`e1`、`[E1]` 和 `E1` 是同一条，不许因为写法不同报成不存在。
    expect(n08(briefed({ situation: [{ text: "x", evidenceRefs: ["e1"] }] }))).toEqual([]);
    expect(n08(briefed({ situation: [{ text: "x", evidenceRefs: ["[E1]"] }] }))).toEqual([]);
  });

  /*
   * 承重事实门。ISS-238 那一份有 7 条 A 级证据仍然漏了最要紧的年报 —— 总数达标和「这一屏上
   * 的话站在什么上面」是两件事。
   */
  it("承重在 C 级证据上 —— p1，不是 p0（要补的是证据，重发这一块补不出来）", () => {
    const v = n08(briefed({ situation: [{ text: "x", evidenceRefs: ["E3"] }] }));
    expect(v.some((x) => x.severity === "p1" && x.message.includes("C 级"))).toBe(true);
    expect(v.filter((x) => x.severity === "p0")).toEqual([]);
  });

  it("一条证据都没引 —— 同样是 p1，situation 和 recommendation 各报一条", () => {
    const v = n08(
      briefed({
        situation: [{ text: "x", evidenceRefs: [] }],
        recommendation: { ...fullBrief().recommendation, evidenceRefs: [] },
      })
    );
    expect(v.filter((x) => x.severity === "p1" && x.message.includes("一条证据都没引"))).toHaveLength(2);
    expect(v.filter((x) => x.severity === "p0")).toEqual([]);
  });

  it("A 级和 B 级都放行 —— 承重门只拦 C 级和没引", () => {
    expect(n08(briefed({ situation: [{ text: "x", evidenceRefs: ["E1", "E2"] }] }))).toEqual([]);
  });
});

/*
 * 排期那三栏（2026-09-07）。上一版把 `dueOn` 非空列进必填，逼出了 ISS-239 那三个说不出依据
 * 的九月日期。现在：没有排期是合法的，有确定日期就要有依据，相对时间走自己那一栏。
 */
describe("A4-N08 排期：dueOn / dueNote / dueBasis", () => {
  const one = fullBrief().proposedOrders[0];

  it("三栏全空 —— 合法。没有排期好过替一号位约一个他没约过的时间", () => {
    expect(n08(briefed({ proposedOrders: [{ role: "行业组", outcome: "拿回验收口径", acceptance: ["书面确认"], dueOn: "" }] }))).toEqual(
      []
    );
  });

  it("「首访前」「日期待定」走 dueNote —— 合法，而且没进 dueOn", () => {
    for (const rel of ["首访前", "日期待定", "立项后两周内"]) {
      expect(
        n08(briefed({ proposedOrders: [{ ...one, dueOn: "", dueBasis: undefined, dueNote: rel }] })),
        rel
      ).toEqual([]);
    }
  });

  it("相对时间塞进 dueOn —— p0（下游会把它当日期去算天数）", () => {
    const v = n08(briefed({ proposedOrders: [{ ...one, dueOn: "首访前" }] }));
    expect(v.some((x) => x.severity === "p0" && x.message.includes("不是一个日期"))).toBe(true);
    // 只认 `2026-09-19` 这一种写法：中文日期和只到月份的都算相对时间。
    for (const bad of ["2026 年 9 月 19 日", "2026-09", "9 月中"]) {
      expect(n08(briefed({ proposedOrders: [{ ...one, dueOn: bad }] })).some((x) => x.message.includes("不是一个日期")), bad).toBe(
        true
      );
    }
  });

  it("确定日期没有依据 —— p1（错的不是日期，是它凭空）", () => {
    const v = n08(briefed({ proposedOrders: [{ ...one, dueBasis: "  " }] }));
    expect(v.some((x) => x.severity === "p1" && x.message.includes("dueBasis"))).toBe(true);
    expect(v.filter((x) => x.severity === "p0")).toEqual([]);
    // 有依据就放行。
    expect(n08(briefed({ proposedOrders: [one] }))).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* A4-N10 / N11 / N12：输出的确定性不得超过已知信息                            */
/* -------------------------------------------------------------------------- */

/** 往报告正文里塞一段话，看这三条拦不拦得住。`brief` 为真时挂一份完整决断包（N12 只在那时判）。 */
const said = (md: string, brief = false): AuditInput => {
  const input = brief ? briefed() : ok();
  input.report = { ...input.report, blocks: [...input.report.blocks, { type: "prose", md }] };
  return input;
};
const ruled = (input: AuditInput, rule: string) => auditExit(input).filter((v) => v.rule === rule);

describe("A4-N10 检索不到 Mission ≠ 公司没有该 Mission", () => {
  it("把「没检索到」写成「公司没有」 —— p1", () => {
    const v = ruled(said("本轮的目标挂不上去，公司没有对应的 Mission。"), "A4-N10");
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("p1");
    expect(v[0].message).toContain("把「没检索到」写成了「公司没有」");
  });

  it("同一句里写清是「本轮未检索到、归属待确认」 —— 放行", () => {
    expect(ruled(said("本轮未检索到对应的 Mission，归属待确认。"), "A4-N10")).toEqual([]);
  });

  it("提新增 Mission 而不交代承接不了的理由与 OM 影响 —— p1", () => {
    const v = ruled(said("这件事的目标和既有 Mission 不同，建议单独设定一条 Mission。"), "A4-N10");
    expect(v.some((x) => x.message.includes("新增一条 Mission"))).toBe(true);
  });

  it("两样都交代了 —— 放行（例外建议本身是允许的）", () => {
    expect(
      ruled(
        said(
          "已知的三条 Mission 都无法承接这件事：它们的验收都落在交付侧。" +
            "若要新增一条 Mission，会占用本期已经排给灯塔项目的资源，对原有承诺的影响要一并评估。"
        ),
        "A4-N10"
      )
    ).toEqual([]);
  });
});

describe("A4-N11 能力与商务边界未知时写「会前需核实」", () => {
  it("主动承诺私有化部署 / 数据不出厂 / 知识产权归属 —— 各报一条 p1", () => {
    for (const s of [
      "会上明确告知对方，系统可以内网私有化部署。",
      "我方能保证数据不出厂。",
      "向对方说明训练形成的知识资产归客户所有。",
    ]) {
      const v = ruled(said(s), "A4-N11");
      expect(v.length, s).toBe(1);
      expect(v[0].severity).toBe("p1");
    }
  });

  it("写成会前需核实、或者本来就是一句「不要承诺」 —— 放行", () => {
    for (const s of [
      "私有化部署能不能做，会前需核实，核不到就不在会上提。",
      "不承诺私有化部署，也不谈知识产权归属。",
      "知识产权归属待确认，本轮没有依据。",
    ]) {
      expect(ruled(said(s), "A4-N11"), s).toEqual([]);
    }
  });
});

describe("A4-N12 同一件事只有一个版本", () => {
  it("停止条件一处写「任一」、一处写「同时」 —— p1", () => {
    const v = ruled(
      said("三项里任一被拒就停止推进。\n\n决断包那一屏写的是三项同时被拒才停止。", true),
      "A4-N12"
    );
    expect(v.some((x) => x.severity === "p1" && x.message.includes("放弃/停止条件"))).toBe(true);
  });

  it("议程标着两小时，几段加起来 110 分钟 —— p1，把差额报出来", () => {
    const v = ruled(said("两小时的议程：现状 40 分钟，能力演示 30 分钟，边界 25 分钟，下一步 15 分钟。", true), "A4-N12");
    expect(v).toHaveLength(1);
    expect(v[0].message).toContain("110 分钟");
    expect(v[0].message).toContain("差 10 分钟");
  });

  it("加得上、或者差额已经交代过 —— 放行", () => {
    expect(ruled(said("两小时的议程：现状 40 分钟，演示 40 分钟，边界 25 分钟，下一步 15 分钟。", true), "A4-N12")).toEqual([]);
    expect(
      ruled(said("两小时的议程：现状 40 分钟，演示 30 分钟，边界 25 分钟，下一步 15 分钟，其余留作机动。", true), "A4-N12")
    ).toEqual([]);
  });

  /*
   * 这一条只在有决断包的时候判：这一类不一致的成因就是「那一屏和正文各写了一遍」。
   * 拿同一套词面去扫行业题只会收获误报 —— 那一支没有摘要屏。
   */
  it("没有决断包的报告不判这一条", () => {
    expect(ruled(said("三项里任一被拒就停止推进。\n\n也有一处写成三项同时被拒才停止。"), "A4-N12")).toEqual([]);
    expect(ruled(said("两小时的议程：40 分钟、30 分钟、25 分钟、15 分钟。"), "A4-N12")).toEqual([]);
  });
});

/* -------------------------------------------------------------------------- */
/* A4-N09 新鲜度门                                                             */
/* -------------------------------------------------------------------------- */

const entry = (over: Partial<AuditEvidence> = {}): AuditEvidence => ({
  id: "L1",
  url: "https://static.cninfo.com.cn/finalpage/2026-04-20/report.PDF",
  sourceDomain: "static.cninfo.com.cn",
  sourceTier: "A",
  period: "2025 年度",
  retrievedAt: "2026-09-07",
  ...over,
});

const TODAY = new Date("2026-09-07T00:00:00Z");

describe("A4-N09 判据的两个纯函数", () => {
  it("一手披露域名认后缀段，不用 includes", () => {
    expect(
      isDisclosureEvidence({ url: "https://static.cninfo.com.cn/a.pdf", sourceDomain: "static.cninfo.com.cn" })
    ).toBe(true);
    expect(isDisclosureEvidence({ url: "https://www.sse.com.cn/x", sourceDomain: "www.sse.com.cn" })).toBe(true);
    expect(isDisclosureEvidence({ url: "https://www1.hkexnews.hk/x", sourceDomain: "www1.hkexnews.hk" })).toBe(true);
    // 别人的查询串里出现巨潮的域名不算。
    expect(
      isDisclosureEvidence({ url: "https://news.example.com/s?q=cninfo.com.cn", sourceDomain: "news.example.com" })
    ).toBe(false);
    expect(isDisclosureEvidence({ url: "https://finance.sina.com.cn/x", sourceDomain: "finance.sina.com.cn" })).toBe(
      false
    );
  });

  it("主体官网并进来才算，且空串不能把整张表变成「全都算」", () => {
    const e = { url: "https://ir.visionox.com/2026/announcement", sourceDomain: "ir.visionox.com" };
    expect(isDisclosureEvidence(e)).toBe(false);
    expect(isDisclosureEvidence(e, ["visionox.com"])).toBe(true);
    // 官网域名是模型给的，空串是它最常见的产物 —— 它不能让任意一条证据都变成一手披露。
    expect(isDisclosureEvidence({ url: "https://weibo.com/x", sourceDomain: "weibo.com" }, ["", "  "])).toBe(false);
  });

  it("url 取不出主机名时退到 sourceDomain —— 折过来的那几条 url 可能是脏串", () => {
    expect(isDisclosureEvidence({ url: "/finalpage/report.PDF", sourceDomain: "cninfo.com.cn" })).toBe(true);
    expect(isDisclosureEvidence({ url: "", sourceDomain: "" })).toBe(false);
  });

  it("报告期按这一期结束的那一天算 —— 年度落年末，半年落 6 月末，季度落季末", () => {
    // 「2025 年度」在 2026 年 4 月才发得出来：拿年初去比窗口会把一份刚发的年报判成旧数。
    expect(periodWithin("2025 年度", TODAY)).toBe(true);
    expect(periodWithin("2024 年年度报告", TODAY)).toBe(false);
    // 窗口是 15 个月：2026-09-07 往回是 2025-06-07，2025 半年报（6 月末）踩在里面。
    expect(periodWithin("2025年半年度", TODAY)).toBe(true);
    expect(periodWithin("2025H1", TODAY)).toBe(true);
    expect(periodWithin("2025 年第一季度", TODAY)).toBe(false);
    expect(periodWithin("2025Q2", TODAY)).toBe(true);
    expect(periodWithin("2026年第一季度", TODAY)).toBe(true);
    expect(periodWithin("2025年5月", TODAY)).toBe(false);
    expect(periodWithin("2025年6月", TODAY)).toBe(true);
  });

  it("认不出报告期一律算不在窗口内 —— 这一头故意从严", () => {
    expect(periodWithin(undefined, TODAY)).toBe(false);
    expect(periodWithin("", TODAY)).toBe(false);
    expect(periodWithin("最近一期", TODAY)).toBe(false);
    expect(periodWithin("1998 年度", TODAY)).toBe(false);
  });
});

describe("A4-N09 新鲜度门", () => {
  const n09 = (input: AuditInput) => auditExit(input).filter((v) => v.rule === "A4-N09");

  it("台账里有一份最近一期的一手披露 —— 不报", () => {
    const input = ok();
    input.entries = [entry()];
    input.now = TODAY;
    expect(n09(input)).toEqual([]);
  });

  it("只有 2024 年报 —— p1，说的是「一条近期公司材料都没有」（ISS-238）", () => {
    const input = ok();
    input.entries = [entry({ period: "2024 年度" })];
    input.now = TODAY;
    const v = n09(input);
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("p1");
    expect(v[0].message).toContain("没有一条近期公司材料");
    expect(v[0].message).toContain("建立在旧数上");
    expect(backTo(auditExit(input))).toContain("N3");
  });

  /*
   * 2026-09-07（ISS-239）：这一条是上面那条的**另一半**。
   *
   * 那一轮报的是「没拿到最近一期披露」，而那句话是假的 —— 2025 年年报和 2026 年 5 月的
   * 投资者关系记录都在台账上，只是挂在新浪的镜像页。「什么都没查到」和「查到了但来源要核」
   * 是两件事，后面那件要做的不是重查，是去原站核一次身份。
   */
  it("近期材料只有镜像转载 —— 仍是 p1，但说的是原站身份未核对，不是「没拿到」", () => {
    const input = ok();
    input.entries = [
      entry({
        id: "E25",
        url: "https://vip.stock.finance.sina.com.cn/corp/view/vCB_AllBulletinDetail.php?id=12336577",
        sourceDomain: "vip.stock.finance.sina.com.cn",
        sourceTier: "A",
        period: "2025 年度",
        authorityClass: "company_primary",
      }),
    ];
    input.now = TODAY;
    const v = n09(input);
    expect(v).toHaveLength(1);
    expect(v[0].severity).toBe("p1");
    expect(v[0].message).toContain("镜像转载站");
    expect(v[0].message).toContain("E25");
    // 这句话在这一支上是假的，一个字都不许出现。
    expect(v[0].message).not.toContain("没有一条近期公司材料");
  });

  it("新是新的，但不是一手披露 —— 照报（转载页顶不了年报）", () => {
    const input = ok();
    input.entries = [
      entry({
        id: "L2",
        url: "https://finance.sina.com.cn/x",
        sourceDomain: "finance.sina.com.cn",
        sourceTier: "C",
        period: "2026 年第一季度",
      }),
    ];
    input.now = TODAY;
    expect(n09(input)).toHaveLength(1);
  });

  it("主体官网的公告算一手 —— 由 disclosureDomains 并进来", () => {
    const input = ok();
    input.entries = [
      entry({ url: "https://ir.visionox.com/2026/announcement", sourceDomain: "ir.visionox.com", period: "2026 年第一季度" }),
    ];
    input.now = TODAY;
    expect(n09(input)).toHaveLength(1);
    input.disclosureDomains = ["visionox.com"];
    expect(n09(input)).toEqual([]);
  });

  it("缺 entries 或缺 now —— 安静跳过（主会话接线之前的状态）", () => {
    const stale = [entry({ period: "2024 年度" })];
    const a = ok();
    a.entries = stale;
    expect(auditExit(a)).toEqual([]);
    const b = ok();
    b.now = TODAY;
    expect(auditExit(b)).toEqual([]);
  });

  it("自己家里的事、以及取证整段没跑 —— 都不报（同一根手指不指两次）", () => {
    const input = ok();
    input.entries = [];
    input.now = TODAY;
    expect(n09(input)).toHaveLength(1);

    input.inward = true;
    expect(n09(input)).toEqual([]);

    input.inward = false;
    input.card = { ...input.card, inward: true };
    expect(n09(input)).toEqual([]);

    input.card = { ...input.card, inward: false };
    input.retrievalRan = false;
    expect(n09(input)).toEqual([]);
  });

  it("主体卡没有主体 —— 没有可查披露的对象，不报", () => {
    const input = ok();
    input.entries = [];
    input.now = TODAY;
    input.card = { ...input.card, subject: "  " };
    expect(n09(input)).toEqual([]);
  });
});
