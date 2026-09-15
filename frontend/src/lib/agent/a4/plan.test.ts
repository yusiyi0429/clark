import { describe, expect, it } from "vitest";
import { DIM_IDS, INDUSTRY_SCOPE, decisionScope, type ScopeQuestion } from "./dims";
import type { Draft } from "./draft";
import {
  PLAN_SYSTEM,
  PLAN_SYSTEM_DECISION,
  buildPlanUser,
  compilePlan,
  fillQuestionGaps,
  maxPerDimFor,
  planGaps,
  planSystemFor,
  taskScopeFor,
} from "./plan";

const prop = (dim: string, i: number, extra: Record<string, unknown> = {}) => ({
  dimension: dim,
  statement: `${dim}-${i} 这一条命题足够长可以被检索`,
  requiredEvidence: "带统计期间的机构数据",
  queries: [`${dim} 出货量 2026`, `${dim} shipment 2026`],
  counterQueries: [`${dim} 下滑`],
  sourceKinds: ["行业机构", "公司披露"],
  materialityWeight: 0.8,
  freshnessUrgency: 0.8,
  ...extra,
});

const raw = { propositions: DIM_IDS.flatMap((d) => [prop(d, 1), prop(d, 2)]) };

describe("检索计划编译", () => {
  it("命题编号带维度，跨维度不撞号", () => {
    const list = compilePlan(raw, 3);
    expect(list).toHaveLength(16);
    expect(new Set(list.map((p) => p.id)).size).toBe(16);
    expect(list[0].id).toContain("D1");
  });

  it("每维度各自封顶，不是全局封顶", () => {
    const many = { propositions: DIM_IDS.flatMap((d) => [1, 2, 3, 4].map((i) => prop(d, i))) };
    const list = compilePlan(many, 2);
    expect(list).toHaveLength(16);
    expect(list.filter((p) => p.dimension === "D1")).toHaveLength(2);
  });

  it("维度编号不认识的那条丢掉", () => {
    expect(compilePlan({ propositions: [prop("D9", 1)] }, 3)).toHaveLength(0);
  });

  it("来源类型只认表上那几种", () => {
    const list = compilePlan({ propositions: [prop("D1", 1, { sourceKinds: ["行业机构", "小道消息"] })] }, 3);
    expect(list[0].sourceKinds).toEqual(["行业机构"]);
  });

  it("承重与时效照 props.ts 的阈值判，不在这里另立一套", () => {
    const list = compilePlan({ propositions: [prop("D1", 1, { materialityWeight: 0.3 })] }, 3);
    expect(list[0].material).toBe(false);
  });

  it("陈述太短被 props.compile 丢掉时，来源类型不会串到下一条身上", () => {
    // `compile` 先滤掉 <6 字的陈述再截断（props.ts:76），所以按下标回配一定错位。
    const list = compilePlan(
      {
        propositions: [
          prop("D1", 1, { statement: "太短", sourceKinds: ["媒体线索"] }),
          prop("D1", 2, { sourceKinds: ["行业机构", "公司披露", "监管与政策"] }),
        ],
      },
      3
    );
    expect(list).toHaveLength(1);
    expect(list[0].sourceKinds).toEqual(["行业机构", "公司披露", "监管与政策"]);
  });
});

describe("检索计划的缺口", () => {
  it("八维各两条、每条两类来源、有反向问法 —— 没有缺口", () => {
    expect(planGaps(compilePlan(raw, 3))).toEqual([]);
  });

  it("某一维不足两条命题要报出来", () => {
    const thin = { propositions: raw.propositions.filter((p) => !(p.dimension === "D3" && p.statement.includes("-2"))) };
    expect(planGaps(compilePlan(thin, 3)).join("")).toContain("D3");
  });

  it("来源类型只覆盖一类要报出来", () => {
    const one = { propositions: [prop("D1", 1, { sourceKinds: ["行业机构"] }), ...raw.propositions] };
    expect(planGaps(compilePlan(one, 3)).join("")).toContain("来源类型");
  });

  it("某一维吃掉三成以上检索预算要报出来", () => {
    // `compile` 把 queries 封 3 条、counterQueries 封 2 条（props.ts:86-87），所以偏斜要靠
    // **别的维度问得少**来造，不能靠给一个维度堆二十条问法 —— 那些会被截掉。
    const fat = {
      propositions: raw.propositions.map((p) =>
        p.dimension === "D1"
          ? { ...p, queries: ["D1 出货", "D1 shipment", "D1 产能"], counterQueries: ["D1 下滑", "D1 decline"] }
          : { ...p, queries: [`${p.dimension} 单问`], counterQueries: [] }
      ),
    };
    const gaps = planGaps(compilePlan(fat, 3));
    expect(gaps.join("")).toContain("三成");
    expect(gaps.join("")).toContain("D1");
  });

  it("一条反向问法都没有要报出来", () => {
    const noCounter = { propositions: raw.propositions.map((p) => ({ ...p, counterQueries: [] })) };
    expect(planGaps(compilePlan(noCounter, 3)).join("")).toContain("反向");
  });
});

describe("提示词", () => {
  it("说清命题来自草稿、不是来自搜索结果", () => {
    expect(PLAN_SYSTEM).toContain("草稿");
    expect(PLAN_SYSTEM).toContain("反向");
    expect(PLAN_SYSTEM).toContain("三成");
  });

  /**
   * 上限要**递给模型**，不能只在代码里截。
   *
   * `compilePlan` 一直是 `.slice(0, maxPerDim)`，而提示词里原来只有「每个维度至少 2 条」这个
   * 下限 —— 于是模型每维写五到八条，代码留下两条，其余的字白写。白写的不是钱是**时间**：
   * 这一步实测 152 到 368 秒，而整轮只有 30 分钟，它慢一分钟后面就少一波取证。
   *
   * 这一条盯的是「两个数是同一个数」：`buildPlanUser` 说出来的那个上限，必须就是
   * `compilePlan` 真的截的那个。分开写的话，改了一头不会报错，只会让模型照着一个过期的
   * 数字写 —— 而那正是这次要修的毛病本身。
   */
  it("每维上限递给了模型，而且和代码真截的那个数是同一个", () => {
    const draft = {
      thesis: "总判断",
      sections: DIM_IDS.map((dim) => ({ dim, thesis: `${dim} 论点`, body: "机制", assertions: [] })),
      unknowns: ["缺最新出货量"],
      playbook: [],
    };
    const withPlaybook = {
      ...draft,
      playbook: [
        {
          heading: "首访只谈验收口径",
          body: "b",
          // `answerIn` 是 2026-09-07（ISS-240）加的一栏，跟这一段要测的东西无关，填兜底值。
          assertions: [{ text: "维信诺 8.6 代线 2026 年量产", tag: "P" as const, confidence: "中" as const, timeSensitive: true, loadBearing: true, answerIn: "公开可查" as const }],
        },
      ],
    };
    expect(buildPlanUser(withPlaybook, 3)).toContain("决策骨架依赖的外部事实");
    expect(buildPlanUser(withPlaybook, 3)).toContain("「首访只谈验收口径」依赖：维信诺 8.6 代线");
    expect(buildPlanUser(draft, 3)).not.toContain("决策骨架");
    for (const maxPerDim of [2, 3, 5]) {
      expect(buildPlanUser(draft, maxPerDim)).toContain(`最多 ${maxPerDim} 条命题`);
      // 说出去的那个数就是截的那个数：给每维喂两条，上限 1 时只应留下一条。
      expect(compilePlan(raw, maxPerDim).filter((p) => p.dimension === "D1")).toHaveLength(
        Math.min(2, maxPerDim)
      );
    }
  });

  it("上限是硬的：提示词要说清超出去的那几条一条都不会被检索", () => {
    expect(PLAN_SYSTEM).toContain("一条都不会被检索");
    expect(PLAN_SYSTEM).toContain("写满上限就停");
  });
});

/* -------------------------------------------------------------------------- */
/* 任务范围                                                                     */
/* -------------------------------------------------------------------------- */

/**
 * 决策题的范围只有三维、三条关键问题。
 *
 * 这一组盯的是 ISS-239 那一轮的病灶：草稿只写 D2/D3/D8（`draft.ts` 的 `DECISION_DIMS`），
 * 而计划这一侧照旧按八维各要 2 条命题校验，于是每轮挂五条永远补不上的缺口、触发补正、
 * 再扩查一圈没有下游会读的维度。**四处（生成 / 编译 / 缺口 / 覆盖）必须读同一个对象** ——
 * 分开写的话改了一头不会报错，只会让其中一处照着一份过期的范围干活，而那正是要修的毛病。
 */
const decisionQuestions: ScopeQuestion[] = [
  {
    id: "Q1-1",
    question: "对方 8.6 代线的验收口径由谁定",
    dimension: "D2",
    routeIds: ["R1"],
    dependsOn: ["A1"],
    changesChoice: true,
    needsInternal: false,
  },
  {
    id: "Q1-2",
    question: "对方这一季度的资本开支节奏",
    dimension: "D2",
    routeIds: ["R1", "R2"],
    dependsOn: [],
    changesChoice: false,
    needsInternal: false,
  },
  {
    id: "Q2-1",
    question: "我方现在能演示到哪一步",
    dimension: "D8",
    routeIds: ["R2"],
    dependsOn: [],
    changesChoice: true,
    // 答案在内部材料里 —— 它不该变成一条网络查询。
    needsInternal: true,
  },
];

const dprop = (dim: string, i: number, extra: Record<string, unknown> = {}) =>
  prop(dim, i, { questionId: "Q1-1", ...extra });

describe("决策题的任务范围", () => {
  const scope = decisionScope({ dims: ["D2", "D3", "D8"], questions: decisionQuestions });

  it("编译时范围外的维度直接丢，不是留着占一行", () => {
    const list = compilePlan(
      { propositions: [dprop("D2", 1), dprop("D6", 1), prop("D1", 1)] },
      3,
      scope
    );
    expect(list.map((p) => p.dimension)).toEqual(["D2"]);
  });

  it("questionId 认得出、认不出的落空 —— 编出来的号绑不到任何一条问题上", () => {
    const list = compilePlan(
      { propositions: [dprop("D2", 1), dprop("D3", 1, { questionId: "Q9-9" })] },
      3,
      scope
    );
    expect(list.find((p) => p.dimension === "D2")?.questionId).toBe("Q1-1");
    expect(list.find((p) => p.dimension === "D3")?.questionId).toBeUndefined();
  });

  it("不补满八维：只有 D2 有命题时，缺的是关键问题不是那五个无关维度", () => {
    const list = compilePlan({ propositions: [dprop("D2", 1), dprop("D2", 2)] }, 3, scope);
    const gaps = planGaps(list, scope);
    // 无关维度一个字都不提 —— 「无关命题不足不触发补正」。
    for (const d of ["D1", "D4", "D5", "D6", "D7"]) expect(gaps.join("")).not.toContain(d);
    // 范围里但一条命题都没有的两维照旧报（那是计划漏了它们，不是它们不重要）。
    expect(gaps.join("")).toContain("D3");
    expect(gaps.join("")).toContain("D8");
  });

  it("会改变选择的关键问题没有命题接着 = 缺口；背景问题没有则不是", () => {
    const withKey = compilePlan({ propositions: [dprop("D2", 1)] }, 3, scope);
    expect(planGaps(withKey, scope).join("")).not.toContain("Q1-1");

    const noKey = compilePlan({ propositions: [prop("D2", 1)] }, 3, scope);
    expect(planGaps(noKey, scope).join("")).toContain("Q1-1");
    // 背景问题（changesChoice 为假）不进缺口，`needsInternal` 的那条也不进。
    expect(planGaps(noKey, scope).join("")).not.toContain("Q1-2");
    expect(planGaps(noKey, scope).join("")).not.toContain("Q2-1");
  });

  it("三成上限在决策题上不查 —— 三维平摊每维就是 33%，它必然误报", () => {
    const list = compilePlan({ propositions: [dprop("D2", 1), dprop("D2", 2), dprop("D3", 1)] }, 3, scope);
    expect(planGaps(list, scope).join("")).not.toContain("三成");
  });

  it("放宽的只有八维那一件：来源类型和反向问法照旧查", () => {
    const thin = compilePlan(
      {
        propositions: [
          dprop("D2", 1, { sourceKinds: ["行业机构"], counterQueries: [] }),
          dprop("D3", 1, { counterQueries: [] }),
          dprop("D8", 1, { counterQueries: [] }),
        ],
      },
      3,
      scope
    );
    const gaps = planGaps(thin, scope).join("");
    expect(gaps).toContain("来源类型");
    expect(gaps).toContain("反向");
  });

  it("提示词里说清了范围、questionId 和「不要为了填维度编命题」", () => {
    expect(planSystemFor(scope)).toBe(PLAN_SYSTEM_DECISION);
    expect(planSystemFor(INDUSTRY_SCOPE)).toBe(PLAN_SYSTEM);
    expect(PLAN_SYSTEM_DECISION).toContain("questionId");
    expect(PLAN_SYSTEM_DECISION).toContain("不要为了填满维度编命题");
    // 八维那两条纪律在这一份里没有 —— 留着的话模型照旧会去凑。
    expect(PLAN_SYSTEM_DECISION).not.toContain("每个维度至少 2 条");
    expect(PLAN_SYSTEM_DECISION).not.toContain("不得超过总量的三成");
  });

  it("user 里列出适用维度、关键问题编号，以及不许检索的那几条", () => {
    const draft: Draft = {
      thesis: "总判断",
      sections: [{ dim: "D2", thesis: "论点", body: "机制", assertions: [] }],
      unknowns: ["缺最新出货量"],
      playbook: [],
    };
    const user = buildPlanUser(draft, 4, scope);
    expect(user).toContain("这一轮适用的维度");
    expect(user).toContain("D2 供给端");
    expect(user).toContain("Q1-1");
    expect(user).toContain("关联路线 R1");
    // 内部那条进「不要检索」，不进关键问题清单。
    expect(user).toContain("这几条不要检索");
    expect(user.slice(user.indexOf("这几条不要检索"))).toContain("Q2-1");
    expect(user.slice(0, user.indexOf("这几条不要检索"))).not.toContain("Q2-1");
  });
});

describe("任务范围怎么长出来", () => {
  const draft: Draft = {
    thesis: "总判断",
    sections: [
      { dim: "D2", thesis: "供给", body: "机制", assertions: [] },
      { dim: "D3", thesis: "技术", body: "机制", assertions: [] },
    ],
    unknowns: ["缺最新出货量"],
    playbook: [
      {
        heading: "首访只谈验收口径",
        body: "b",
        assertions: [
          // `answerIn` 是 2026-09-07（ISS-240）加的一栏。这里顺带把它的语义摆出来：产线量产
          // 在公告里查得到，换没换采购负责人只有对方内部知道 —— 后者不该进检索计划。
          { text: "对方 8.6 代线 2026 年量产", tag: "P", confidence: "中", timeSensitive: true, loadBearing: true, answerIn: "公开可查" },
          { text: "对方今年换过一次采购负责人", tag: "P", confidence: "低", timeSensitive: true, loadBearing: false, answerIn: "要问对方" },
        ],
      },
    ],
  };

  it("行业题拿的就是那一份固定的八维范围，一个字不动", () => {
    expect(taskScopeFor({ draft })).toBe(INDUSTRY_SCOPE);
    expect(INDUSTRY_SCOPE.dims).toEqual(DIM_IDS);
    expect(INDUSTRY_SCOPE.minPropsPerDim).toBe(2);
    expect(INDUSTRY_SCOPE.dimShareCap).toBe(0.3);
  });

  it("决策题的维度从草稿真的写了什么推出来，主体卡那几维并进去", () => {
    const scope = taskScopeFor({ decision: true, draft, extraDims: ["D8"] });
    expect(scope.dims).toEqual(["D2", "D3", "D8"]);
    // 按 DIM_IDS 排序，不跟着书写顺序走 —— 覆盖表和 trace 都按这个顺序读。
    expect(taskScopeFor({ decision: true, draft, extraDims: ["D8", "D2"] }).dims).toEqual([
      "D2",
      "D3",
      "D8",
    ]);
  });

  it("决策骨架的承重断言 = 会改变选择的关键问题，非承重的是背景", () => {
    const scope = taskScopeFor({ decision: true, draft });
    expect(scope.questions.map((q) => q.id)).toEqual(["Q1-1", "Q1-2"]);
    expect(scope.questions[0].changesChoice).toBe(true);
    expect(scope.questions[1].changesChoice).toBe(false);
    // 一段骨架就是一条候选路线。
    expect(scope.questions[0].routeIds).toEqual(["R1"]);
  });

  it("有了关键问题清单就不再重复写一遍决策骨架 —— 同一条依赖排两条命题会各占一个名额", () => {
    const scope = taskScopeFor({ decision: true, draft });
    const user = buildPlanUser(draft, 4, scope);
    expect(user).toContain("这一轮要弄清的关键问题");
    expect(user).not.toContain("决策骨架依赖的外部事实");
  });

  it("每维上限按范围里的维度数摊，不是按 8 摊", () => {
    const scope = taskScopeFor({ decision: true, draft });
    expect(scope.dims).toHaveLength(2);
    expect(maxPerDimFor(scope, 16)).toBe(8);
    expect(maxPerDimFor(INDUSTRY_SCOPE, 16)).toBe(2);
    // 下限是范围自己的那个数，摊不满时按它给。
    expect(maxPerDimFor(INDUSTRY_SCOPE, 4)).toBe(2);
    expect(maxPerDimFor(scope, 1)).toBe(1);
  });
});

describe("关键问题确定性补齐（ISS-240）", () => {
  const q = (over: Partial<ScopeQuestion> = {}): ScopeQuestion => ({
    id: "Q2-2",
    question: "维信诺近一年内高管及数字化负责人是否变动",
    dimension: "D8",
    routeIds: ["R2"],
    dependsOn: [],
    changesChoice: true,
    needsInternal: false,
    ...over,
  });

  it("会改变选择又没有命题接着的，补一条 —— 提示词写到位了它仍然会漏", () => {
    const scope = decisionScope({ dims: ["D8"], questions: [q()] });
    const out = fillQuestionGaps(scope, [], "维信诺");
    expect(out).toHaveLength(1);
    expect(out[0].questionId).toBe("Q2-2");
    expect(out[0].dimension).toBe("D8");
    // 只用问题原文，不推理、不扩写。
    expect(out[0].statement).toBe("维信诺近一年内高管及数字化负责人是否变动");
    expect(out[0].queries[0]).toContain("维信诺");
    expect(out[0].counterQueries).toHaveLength(1);
    expect(out[0].material).toBe(true);
  });

  it("已经有命题接着的不补 —— 补出来的那条不如模型想的那几条", () => {
    const scope = decisionScope({ dims: ["D8"], questions: [q()] });
    const have = [
      {
        id: "D8-P1",
        dimension: "D8" as const,
        questionId: "Q2-2",
        statement: "x",
        requiredEvidence: "y",
        queries: ["a"],
        counterQueries: ["b"],
        sourceKinds: [],
        material: true,
        freshnessUrgent: false,
        extraRoundsCap: 1,
      },
    ];
    expect(fillQuestionGaps(scope, have, "维信诺")).toEqual([]);
  });

  it("答案在内部的不补，背景问题也不补 —— 补了只换来一轮空手", () => {
    const internal = decisionScope({ dims: ["D8"], questions: [q({ needsInternal: true })] });
    expect(fillQuestionGaps(internal, [], "维信诺")).toEqual([]);
    const background = decisionScope({ dims: ["D8"], questions: [q({ changesChoice: false })] });
    expect(fillQuestionGaps(background, [], "维信诺")).toEqual([]);
  });

  it("行业题没有关键问题，这一层整段不跑", () => {
    expect(fillQuestionGaps(INDUSTRY_SCOPE, [], "维信诺")).toEqual([]);
  });

  it("主体名为空时不拼一个前导空格进检索式", () => {
    const scope = decisionScope({ dims: ["D8"], questions: [q()] });
    const out = fillQuestionGaps(scope, [], "  ");
    expect(out[0].queries[0]).toBe("维信诺近一年内高管及数字化负责人是否变动");
  });
});

describe("三桶落成检索计划的闸（ISS-240）", () => {
  const withAssertion = (answerIn: "公开可查" | "要问对方" | "在我方手里") => ({
    thesis: "总判断",
    sections: [{ dim: "D8" as const, thesis: "t", body: "b", assertions: [] }],
    unknowns: [],
    playbook: [
      {
        heading: "接触对象定在集团经营口",
        body: "b",
        assertions: [
          {
            text: "对方 IT 采购要不要走集团招标",
            tag: "P" as const,
            confidence: "中" as const,
            timeSensitive: false,
            loadBearing: true,
            answerIn,
          },
        ],
      },
    ],
  });

  it("「要问对方」和「在我方手里」不进检索计划 —— 它们的答案在首访的会议室里", () => {
    for (const bucket of ["要问对方", "在我方手里"] as const) {
      const scope = taskScopeFor({ decision: true, draft: withAssertion(bucket) as never });
      expect(scope.questions).toHaveLength(1);
      expect(scope.questions[0].needsInternal).toBe(true);
      // 不进检索计划、不进补搜队列、不进覆盖门。
      const user = buildPlanUser(withAssertion(bucket) as never, 3, scope);
      expect(user).toContain("这几条不要检索");
      expect(user).toContain("对方 IT 采购要不要走集团招标");
    }
  });

  it("「公开可查」照旧进 —— 判不出来的断言也落在这一桶，默认方向是搜一下", () => {
    const scope = taskScopeFor({ decision: true, draft: withAssertion("公开可查") as never });
    expect(scope.questions[0].needsInternal).toBe(false);
    const user = buildPlanUser(withAssertion("公开可查") as never, 3, scope);
    expect(user).toContain("这一轮要弄清的关键问题");
    expect(user).not.toContain("这几条不要检索");
  });
});
