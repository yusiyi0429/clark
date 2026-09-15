// src/lib/agent/a4/reconcile.test.ts
import { describe, expect, it } from "vitest";
import {
  RECONCILE_SYSTEM,
  buildReconcileUser,
  candidatesFromPlaybook,
  evidenceSwapGaps,
  parseMerged,
  premiseStates,
  reconcileGaps,
  reviewPlaybook,
  type Merged,
} from "./reconcile";
import { parseDraft, type Assertion, type PlaybookEntry } from "./draft";
import { DIM_IDS } from "./dims";

const draftText = [
  JSON.stringify({ type: "draft_meta", thesis: "总量红利已用完，往后看份额重排" }),
  ...DIM_IDS.map((dim) =>
    JSON.stringify({
      type: "draft_section",
      dim,
      thesis: `${dim} 的论点`,
      body: "机制",
      assertions: [{ text: `${dim} 断言一`, tag: "P", confidence: "中", timeSensitive: true, loadBearing: true }],
    })
  ),
  JSON.stringify({ type: "draft_unknowns", items: ["a", "b", "c", "d", "e"] }),
].join("\n");

const draft = parseDraft(draftText).draft;

const log = (dim: string, state: string) =>
  JSON.stringify({ type: "change", assertion: `${dim} 断言一`, from: "P", to: state === "未验证" ? "P!" : "E*", state, evidenceIds: ["E1"] });

const merged = (states: string[]) =>
  [
    JSON.stringify({ type: "merged_meta", thesis: "总量红利已用完，往后看份额重排" }),
    ...DIM_IDS.map((dim) =>
      JSON.stringify({ type: "merged_section", dim, thesis: `${dim} 的论点`, body: "机制", tags: ["E*"] })
    ),
    ...DIM_IDS.map((dim, i) => log(dim, states[i] ?? "证实")),
  ].join("\n");

describe("合并稿解析", () => {
  it("读得出变更日志的四态", () => {
    const r = parseMerged(merged(["证实", "修正", "矛盾", "未验证"]));
    expect(r.changes.map((c) => c.state).slice(0, 4)).toEqual(["证实", "修正", "矛盾", "未验证"]);
  });

  it("四态之外的状态不收，留坏行", () => {
    const r = parseMerged(JSON.stringify({ type: "change", assertion: "x", state: "大概对" }));
    expect(r.changes).toHaveLength(0);
    expect(r.bad).toHaveLength(1);
  });
});

describe("合并稿的缺口", () => {
  it("每条断言都在变更日志里 —— 没有缺口", () => {
    expect(reconcileGaps(draft, parseMerged(merged([])))).toEqual([]);
  });

  it("有断言没进变更日志要报出来", () => {
    const short = merged([]).split("\n").filter((l) => !l.includes("D6 断言一")).join("\n");
    expect(reconcileGaps(draft, parseMerged(short)).join("")).toContain("D6 断言一");
  });

  it("正文里留着已证伪的标签要报出来", () => {
    const withX = merged([]).replace('"tags":["E*"]', '"tags":["X"]');
    expect(reconcileGaps(draft, parseMerged(withX)).join("")).toContain("X");
  });

  it("矛盾态超过三成要报出来，并且说的是退回主体卡", () => {
    const many = merged(["矛盾", "矛盾", "矛盾", "矛盾", "证实", "证实", "证实", "证实"]);
    const gaps = reconcileGaps(draft, parseMerged(many));
    expect(gaps.join("")).toContain("三成");
    expect(gaps.join("")).toContain("主体卡");
  });
});

describe("提示词", () => {
  it("明写缺证据只降标签、不删内容", () => {
    expect(RECONCILE_SYSTEM).toContain("不构成删除理由");
    expect(RECONCILE_SYSTEM).toContain("P!");
  });

  it("矛盾态要求重写论点，不许加脚注了事", () => {
    expect(RECONCILE_SYSTEM).toContain("重写");
    expect(RECONCILE_SYSTEM).toContain("脚注");
  });

  it("候选路线那一段：五档齐、一条都不能漏、不到三成也要重判", () => {
    for (const kind of ["保留", "收窄", "改向", "待验证", "放弃"]) {
      expect(RECONCILE_SYSTEM).toContain(kind);
    }
    expect(RECONCILE_SYSTEM).toContain("strategy_update");
    expect(RECONCILE_SYSTEM).toContain("一条都不能漏");
    // §3.C：不许以「矛盾条数不足 30%」为由忽略一条关键反证。
    expect(RECONCILE_SYSTEM).toContain("矛盾条数不到三成");
    expect(RECONCILE_SYSTEM).toContain("条件化");
  });
});

/* -------------------------------------------------------------------------- */
/* N4 策略对账（§3.C）                                                          */
/* -------------------------------------------------------------------------- */

/**
 * 这一组按 ISS-239 的形状造：`RUN-A4-mtqpegne-4`（2026-09-07 11:27–11:51）里，N4 已经把
 * 「采购只为当期成本 KPI 买单」判成未获证实，最终报告的强命令一条没动。下面每一条断言对着
 * 那一轮的一处失灵。
 */
const KPI = "客户采购只为当期成本 KPI 买单";
const CASH = "客户现金紧张，本年不会有新增预算";

const assertion = (text: string, over: Partial<Assertion> = {}): Assertion => ({
  text,
  tag: "P",
  confidence: "中",
  timeSensitive: true,
  loadBearing: true,
  // 2026-09-07（ISS-240）加的一栏，跟这一段要测的东西无关，填兜底值即可（`draft.ts` 的 `ANSWER_SOURCES`）。
  answerIn: "公开可查",
  ...over,
});

const playbook: PlaybookEntry[] = [
  {
    heading: "首访只谈验收口径，不报价",
    body: "先报价会把谈判拉到成本上，四步顺序不能换。",
    assertions: [assertion(KPI)],
  },
  {
    heading: "只走产线负责人这一个入口",
    body: "经营层不掌握验收标准。",
    assertions: [assertion(CASH)],
  },
];

/** 一份最小合并稿：`changes` 给什么就是什么，`strategies` 由每条用例自己拼。 */
const mergedWith = (o: Partial<Merged>): Merged => ({
  thesis: "对完账之后的总判断",
  sections: [],
  changes: [],
  strategies: [],
  bad: [],
  ...o,
});

describe("候选路线：解析", () => {
  it("strategy_update 读得进来，五档之外的处置留坏行", () => {
    const ok = JSON.stringify({
      type: "strategy_update",
      strategyId: "S1",
      kind: "改向",
      factChange: "采购动机从「只为成本 KPI」降为未获证实",
      evidenceIds: ["E7"],
      why: "动机未证实，按成本口径谈会谈错对象",
      advice: "先向经营负责人确认采购动因，再定谈什么",
      conditions: "只在能约到经营负责人时成立",
    });
    const bad = JSON.stringify({ type: "strategy_update", strategyId: "S2", kind: "大概保留" });
    const noId = JSON.stringify({ type: "strategy_update", kind: "保留" });
    const r = parseMerged([ok, bad, noId].join("\n"));
    expect(r.strategies).toHaveLength(1);
    expect(r.strategies?.[0].kind).toBe("改向");
    expect(r.strategies?.[0].advice).toContain("经营负责人");
    expect(r.bad).toHaveLength(2);
  });

  it("候选路线和前提各拿一个同轮稳定的 ID", () => {
    const { strategies, premises } = candidatesFromPlaybook(playbook);
    expect(strategies.map((s) => s.id)).toEqual(["S1", "S2"]);
    expect(premises.map((p) => p.id)).toEqual(["S1-A1", "S2-A1"]);
    expect(strategies[0].premiseIds).toEqual(["S1-A1"]);
    expect(strategies[0].appliesWhen).toContain("四步顺序");
  });

  it("前提回挂到变更日志：原文全等不行就按互相包含找，两头都找不到叫「未对账」", () => {
    const { premises } = candidatesFromPlaybook(playbook);
    const states = premiseStates(
      premises,
      mergedWith({
        changes: [
          // N4 把断言改写过 —— 只按全等找的话这一条会被判成「没人看过」。
          { assertion: `${KPI}（本轮未获证实）`, from: "P", to: "P!", state: "未验证", evidenceIds: [] },
        ],
      })
    );
    expect(states.get("S1-A1")?.state).toBe("未验证");
    expect(states.get("S2-A1")?.state).toBe("未对账");
  });

  it("对账那一次的 user 段里带着候选路线和它的承重前提", () => {
    const { strategies, premises } = candidatesFromPlaybook(playbook);
    const user = buildReconcileUser({ draft: "草稿", evidencePack: "", strategies, premises });
    expect(user).toContain("S1 首访只谈验收口径，不报价");
    expect(user).toContain("（承重）");
    expect(user).toContain("strategy_update");
    // 行业题不带这一段。
    expect(buildReconcileUser({ draft: "草稿", evidencePack: "" })).not.toContain("候选路线");
  });
});

describe("候选路线：复核", () => {
  it("不是决策题就是「不适用」，一条缺口都不报", () => {
    const r = reviewPlaybook({ playbook: [], merged: mergedWith({}) });
    expect(r.status).toBe("不适用");
    expect(r.gaps).toEqual([]);
  });

  it("承重前提被证伪、N4 改向 → 有效建议是改后那一句，旧主张只进历史", () => {
    const r = reviewPlaybook({
      playbook: [playbook[0]],
      merged: mergedWith({
        changes: [{ assertion: KPI, from: "P", to: "X", state: "矛盾", evidenceIds: ["E7"] }],
        strategies: [
          {
            strategyId: "S1",
            kind: "改向",
            factChange: "采购动机未获证实，经营现金流已改善",
            evidenceIds: ["E7"],
            why: "按成本口径谈会谈错对象",
            advice: "先向经营负责人确认采购动因，首访不锁定验收口径",
            conditions: "只在能约到经营负责人时成立",
          },
        ],
      }),
    });
    expect(r.status).toBe("已复核");
    expect(r.effective).toHaveLength(1);
    expect(r.effective[0].advice).toContain("先向经营负责人确认采购动因");
    // **旧主张不能作为有效建议活下来** —— ISS-239 的病灶就是它活下来了。
    expect(r.effective[0].advice).not.toContain("只谈验收口径");
    expect(r.effective[0].falsified.map((p) => p.premise.text)).toEqual([KPI]);
  });

  it("承重前提被证伪、N4 却判「保留」→ 报缺口，而且不许拿旧主张顶上", () => {
    const r = reviewPlaybook({
      playbook: [playbook[0]],
      merged: mergedWith({
        changes: [{ assertion: KPI, from: "P", to: "X", state: "矛盾", evidenceIds: ["E7"] }],
        strategies: [
          {
            strategyId: "S1",
            kind: "保留",
            factChange: "",
            evidenceIds: [],
            why: "问题不大",
            advice: "",
            conditions: "",
          },
        ],
      }),
    });
    expect(r.gaps.join("\n")).toContain("被证伪的前提不能继续承重");
    // 「保留」+ 承重前提被推翻 → 不是可用建议：`effective` 空，旧主张只在历史里。
    expect(r.effective).toHaveLength(0);
    expect(r.historical.map((x) => x.claim)).toEqual(["首访只谈验收口径，不报价"]);
  });

  it("一条关键反证也要触发重判 —— 不按「矛盾条数不足 30%」放过", () => {
    /*
     * 十条断言里只有一条矛盾（10%），`reconcileGaps` 那道 30% 的闸不会响。而那一条正好是
     * S1 的承重前提 —— §3.C 明写这时候必须重判依赖它的每一条路线。
     */
    const changes = [
      { assertion: KPI, from: "P", to: "X" as const, state: "矛盾" as const, evidenceIds: ["E7"] },
      ...Array.from({ length: 9 }, (_, i) => ({
        assertion: `无关断言 ${i}`,
        from: "P",
        to: "E*" as const,
        state: "证实" as const,
        evidenceIds: ["E1"],
      })),
    ];
    const merged = mergedWith({
      changes,
      strategies: [
        { strategyId: "S1", kind: "保留" as const, factChange: "", evidenceIds: [], why: "", advice: "", conditions: "" },
      ],
    });
    // 对照：全局那道闸这一份上确实不响。
    expect(reconcileGaps(parseDraft("").draft, merged).join("")).not.toContain("三成");
    // 而策略复核这一头照样报。
    expect(reviewPlaybook({ playbook: [playbook[0]], merged }).gaps.join("\n")).toContain(
      "被证伪的前提不能继续承重"
    );
  });

  it("N4 一条策略更新都没给 → 未复核、旧建议不恢复、明说复核未完成", () => {
    const r = reviewPlaybook({ playbook, merged: mergedWith({}) });
    expect(r.status).toBe("未复核");
    expect(r.effective).toHaveLength(0);
    expect(r.historical).toHaveLength(2);
    expect(r.gaps.join("\n")).toContain("策略复核未完成");
    expect(r.gaps.join("\n")).toContain("不回退到原策略当结论");
  });

  it("只更新了一条 → 部分复核；没更新的那条不作有效建议", () => {
    const r = reviewPlaybook({
      playbook,
      merged: mergedWith({
        changes: [{ assertion: KPI, from: "P", to: "E*", state: "证实", evidenceIds: ["E1"] }],
        strategies: [
          { strategyId: "S1", kind: "保留", factChange: "证实", evidenceIds: ["E1"], why: "站得住", advice: "", conditions: "" },
        ],
      }),
    });
    expect(r.status).toBe("部分复核");
    // 「保留」+ 前提证实那一档，可以拿主张顶上：那本身就是 N4 给的更新。
    expect(r.effective.map((v) => v.advice)).toEqual(["首访只谈验收口径，不报价"]);
    expect(r.historical.map((x) => x.id)).toEqual(["S2"]);
  });

  it("前提未获验证、N4 没写条件 → 代拟一句条件，不放行无条件命令", () => {
    const r = reviewPlaybook({
      playbook: [playbook[0]],
      merged: mergedWith({
        changes: [{ assertion: KPI, from: "P", to: "P!", state: "未验证", evidenceIds: [] }],
        strategies: [
          {
            strategyId: "S1",
            kind: "待验证",
            factChange: "采购动机未获证实",
            evidenceIds: [],
            why: "可以低成本先问一句",
            advice: "首访先问清采购动因，再决定谈不谈口径",
            conditions: "",
          },
        ],
      }),
    });
    expect(r.effective).toHaveLength(1);
    expect(r.effective[0].conditions).toContain("没有得到证据支持");
    expect(r.effective[0].conditions).toContain(KPI);
    expect(r.gaps.join("\n")).toContain("不得把它写成无条件命令");
  });

  it("「放弃」不进有效建议，但要在历史里留一句 —— 不留就会被下一节当新点子捡回来", () => {
    const r = reviewPlaybook({
      playbook: [playbook[0]],
      merged: mergedWith({
        strategies: [
          {
            strategyId: "S1",
            kind: "放弃",
            factChange: "采购动机被推翻",
            evidenceIds: ["E7"],
            why: "客户现金流已改善，成本口径不成立",
            advice: "",
            conditions: "",
          },
        ],
      }),
    });
    expect(r.effective).toHaveLength(0);
    expect(r.historical[0].why).toContain("放弃");
    expect(r.historical[0].why).toContain("现金流已改善");
  });

  it("挂不回任何一条候选的更新要记一句 —— 那是白花的一次判断", () => {
    const r = reviewPlaybook({
      playbook: [playbook[0]],
      merged: mergedWith({
        strategies: [
          { strategyId: "S1", kind: "保留", factChange: "", evidenceIds: [], why: "", advice: "照旧", conditions: "" },
          { strategyId: "S9", kind: "放弃", factChange: "", evidenceIds: [], why: "", advice: "", conditions: "" },
        ],
      }),
    });
    expect(r.gaps.join("\n")).toContain("挂不回任何一条候选路线");
  });
});

describe("证据替换要闭环", () => {
  it("E11 说被 E12 替代，而 E12 在「没交代」那一列 —— 这种账本自相矛盾要报出来", () => {
    const gaps = evidenceSwapGaps({
      discarded: [{ id: "E11", reason: "用更晚的 E12 替代" }],
      used: ["E1", "E7"],
      uncovered: ["E12"],
    });
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("E11");
    expect(gaps[0]).toContain("E12");
    expect(gaps[0]).toContain("没交代");
  });

  it("替代它的那条真的进了有效依据就不报", () => {
    expect(
      evidenceSwapGaps({
        discarded: [{ id: "E11", reason: "用更晚的 E12 替代" }],
        used: ["E12"],
        uncovered: [],
      })
    ).toEqual([]);
  });

  it("点名的那条压根不在这一轮的证据里，也报", () => {
    const gaps = evidenceSwapGaps({
      discarded: [{ id: "E11", reason: "已被更高级来源 E30 覆盖" }],
      used: ["E1"],
      uncovered: [],
    });
    expect(gaps.join("")).toContain("没有出现在这一轮的有效依据里");
  });

  it("理由里只点自己的编号不算数（「E11 与 E11 共源」没有信息）", () => {
    expect(
      evidenceSwapGaps({ discarded: [{ id: "E11", reason: "E11 口径对不上" }], used: [], uncovered: [] })
    ).toEqual([]);
  });
});
