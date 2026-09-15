import { describe, expect, it } from "vitest";

import { NO_COMPANY_CONTEXT } from "@/lib/agent/prompts";
import {
  CONTEXT_CHARS,
  PREMISE_FIELDS,
  ROUTE_MAX,
  answerSourceForField,
  companyContextLines,
  deliverableNow,
  premiseGaps,
  premiseLines,
  readPremise,
  readRoute,
  routeGaps,
  routeLines,
  userPremiseLines,
  type Premise,
  type RouteOption,
} from "./premise";

const premise = (o: Record<string, unknown>): Premise => {
  const r = readPremise(o);
  if (!r.ok) throw new Error(r.why);
  return r.value;
};
const route = (o: Record<string, unknown>): RouteOption => {
  const r = readRoute(o);
  if (!r.ok) throw new Error(r.why);
  return r.value;
};

const ABILITY = {
  type: "draft_premise",
  id: "P1",
  field: "我方已实现能力",
  statement: "线上跑通了从战略到执行的闭环，有真实运行记录",
  source: "公司上下文 · 产品说明",
  standing: "材料记载",
  stage: "当前已实现",
};

const FULL_FIELDS = [
  { id: "P1", field: "我方已实现能力", statement: "闭环已上线", source: "公司上下文 · 产品说明", standing: "材料记载", stage: "当前已实现" },
  { id: "P2", field: "可演示场景", statement: "未知", standing: "未知", stage: "未知" },
  { id: "P3", field: "承诺边界", statement: "私有化部署口径未知，不许承诺", standing: "未知" },
  { id: "P4", field: "客户关系与接触对象", statement: "只认识对方一位工艺负责人", standing: "用户提供", source: "一号位原话「我认识他们工艺负责人」" },
  { id: "P5", field: "此次目标", statement: "拿到一次可复述的客户问题", standing: "用户提供", source: "一号位原话「先摸清他们卡在哪」" },
].map(premise);

describe("前提解析", () => {
  it("五栏、来源身份、能力阶段都按原样收下", () => {
    const p = premise(ABILITY);
    expect(p).toEqual({
      id: "P1",
      field: "我方已实现能力",
      statement: "线上跑通了从战略到执行的闭环，有真实运行记录",
      source: "公司上下文 · 产品说明",
      standing: "材料记载",
      stage: "当前已实现",
    });
  });

  /*
   * 这一条是 ISS-239 的核心：规划中的能力被读成当前能力，后面就会写成对客户的承诺。
   * 三种写法各查一遍 —— 明写规划中、根本没写、写了个认不出的词。
   */
  it("规划中的能力不会被读成已实现；没写、写错的一律落「未知」", () => {
    expect(premise({ ...ABILITY, stage: "规划中" }).stage).toBe("规划中");
    expect(premise({ ...ABILITY, stage: undefined }).stage).toBe("未知");
    expect(premise({ ...ABILITY, stage: "即将上线" }).stage).toBe("未知");
    // 反过来也要成立：真写了「当前已实现」不许被降级
    expect(premise(ABILITY).stage).toBe("当前已实现");
  });

  it("不是能力的那三栏没有阶段这一说，stage 恒为 null", () => {
    for (const f of ["承诺边界", "客户关系与接触对象", "此次目标"]) {
      expect(premise({ ...ABILITY, field: f, stage: "当前已实现" }).stage).toBeNull();
    }
  });

  it("认不出的来源身份落「推测」——不落「用户提供」，也不落「未知」", () => {
    expect(premise({ ...ABILITY, standing: "已核实" }).standing).toBe("推测");
    expect(premise({ ...ABILITY, standing: undefined }).standing).toBe("推测");
    // 「未知」是一个有内容的答案（问过了，不知道），不是解析失败的兜底
    expect(premise({ ...ABILITY, standing: "未知" }).standing).toBe("未知");
    expect(premise({ ...ABILITY, standing: "用户提供" }).standing).toBe("用户提供");
  });

  it("站不住的三种：没 id、栏位不认识、没内容 —— 各交一句能上屏的理由", () => {
    const why = (o: Record<string, unknown>): string => {
      const r = readPremise(o);
      expect(r.ok).toBe(false);
      return r.ok ? "" : r.why;
    };
    expect(why({ ...ABILITY, id: "" })).toContain("没有 id");
    expect(why({ ...ABILITY, field: "我方心情" })).toContain("五栏");
    expect(why({ ...ABILITY, statement: "  " })).toContain("没有内容");
  });

  it("引不动的 id 整条拒：带空白、太长、和前面重号", () => {
    const why = (o: Record<string, unknown>, seen?: Set<string>): string => {
      const r = readPremise(o, seen);
      expect(r.ok).toBe(false);
      return r.ok ? "" : r.why;
    };
    expect(why({ ...ABILITY, id: "P 1" })).toContain("空白");
    expect(why({ ...ABILITY, id: "我方已经实现了从战略到决策到执行到复盘的一整套完整闭环能力" })).toContain("超过");
    const seen = new Set<string>();
    expect(readPremise(ABILITY, seen).ok).toBe(true);
    expect(why(ABILITY, seen)).toContain("重");
  });

  it("缺栏落空，不因为少一栏丢整条", () => {
    const p = premise({ id: "P9", field: "此次目标", statement: "拿到一次可复述的客户问题" });
    expect(p.source).toBe("");
    expect(p.standing).toBe("推测");
  });
});

describe("前提的缺口", () => {
  it("五栏齐了没有缺口；少一栏指名报出来", () => {
    expect(premiseGaps(FULL_FIELDS)).toEqual([]);
    const missing = FULL_FIELDS.filter((p) => p.field !== "承诺边界");
    expect(premiseGaps(missing).join("")).toContain("承诺边界");
    expect(premiseGaps(missing).join("")).toContain("未知");
  });

  it("标了「用户提供 / 材料记载」却没写来源，报出来", () => {
    const bare = premise({ id: "P7", field: "此次目标", statement: "拿下首单", standing: "用户提供" });
    expect(premiseGaps([bare]).join("")).toContain("P7");
  });

  /*
   * 「源引用只能引真实输入」唯一能机检的那一半：显式引号里的原话，在这一轮的真实输入里
   * 必须找得到。转述查不了，也不假装查过 —— 不给 corpus 就不报这一项。
   */
  it("引号里的原话在输入里找不到时报出来；找得到不报；不给输入就不查", () => {
    const made = premise({
      id: "P8",
      field: "客户关系与接触对象",
      statement: "对方 CTO 已经答应见面",
      source: "一号位原话「他们 CTO 已经答应下周见」",
      standing: "用户提供",
    });
    const corpus = "首访该怎么开？我认识他们工艺负责人。";
    expect(premiseGaps([made], { corpus }).join("")).toContain("找不到");
    expect(premiseGaps([made]).join("")).not.toContain("找不到");
    const real = premise({ ...made, source: "一号位原话「我认识他们工艺负责人」" });
    expect(premiseGaps([real], { corpus }).join("")).not.toContain("找不到");
  });
});

/* ---- 五栏 × 三桶（2026-09-07，ISS-240）------------------------------------ */

describe("哪一栏的答案在谁手里", () => {
  /*
   * 两个维度，不是一个：`field` 说这条前提讲的是哪一类事，桶说这个答案在谁手里。这里查的
   * 正是「多对一」—— 四栏落进同一个桶，所以桶不可能反过来推出 `field`，合并就是丢信息。
   */
  it("四栏钉死在「在我方手里」，多对一 —— 所以这两个维度不能合并", () => {
    const pinned = PREMISE_FIELDS.filter((f) => answerSourceForField(f) === "在我方手里");
    expect(pinned).toEqual(["我方已实现能力", "可演示场景", "承诺边界", "此次目标"]);
    expect(pinned.length).toBeGreaterThan(1);
  });

  /*
   * 「客户关系与接触对象」是一栏两半：我们认识谁在我方手里，对方内部谁拍板、走不走集团
   * 招标在对方手里（ISS-240 那几条搜 4 种问法零结果的关键问题就是后半截）。钉死任何一个
   * 都会把另一半判错，所以照实返回 null。
   */
  it("判不出的那一栏返回 null，不硬钉一个", () => {
    expect(answerSourceForField("客户关系与接触对象")).toBeNull();
  });

  it("答案在我方手里的那几栏标「推测」是矛盾组合，要报出来", () => {
    const guessed = premise({ id: "PG", field: "承诺边界", statement: "可以私有化部署、数据不出厂", standing: "推测" });
    const g = premiseGaps([guessed]).join("");
    expect(g).toContain("PG");
    expect(g).toContain("在我方手里");
    expect(g).toContain("不许猜");
    // 没标来源身份的也落「推测」，同一道闸罩住 —— 那也是一句来路不明的我方能力
    expect(premiseGaps([premise({ id: "PN", field: "我方已实现能力", statement: "能做良率优化" })]).join("")).toContain("PN");
  });

  it("照材料写、或者显式写「未知」，都不报；判不出桶的那一栏怎么标都不报", () => {
    for (const standing of ["材料记载", "用户提供", "未知"]) {
      const p = premise({ ...ABILITY, id: "PO", standing, source: "公司上下文 · 产品说明" });
      expect(premiseGaps([p]).join("")).not.toContain("不许猜");
    }
    const contact = premise({ id: "PC", field: "客户关系与接触对象", statement: "只认识一位工艺负责人", standing: "推测" });
    expect(premiseGaps([contact]).join("")).not.toContain("不许猜");
    // 五栏齐的那一份照旧零缺口（这道新闸不许误伤既有夹具）
    expect(premiseGaps(FULL_FIELDS)).toEqual([]);
  });
});

const ROUTE = {
  id: "R1",
  claim: "先做一次低成本的问题澄清，不带方案去",
  fit: "现有的经营复盘闭环就能承接",
  clientCondition: "对方愿意让一位业务负责人到场",
  payoff: "拿到一句能复述的客户问题",
  dependsOn: ["P1"],
  switchWhen: "对方直接要报价，就改走商务口径那条",
};

describe("候选路线解析", () => {
  it("一条：六栏原样收下", () => {
    expect(route(ROUTE)).toEqual({ ...ROUTE, dependsOn: ["P1"] });
    expect(routeGaps([route(ROUTE)], FULL_FIELDS)).toEqual([]);
  });

  it("三条：id 不许重，三条各自站得住", () => {
    const seen = new Set<string>();
    const three = ["R1", "R2", "R3"].map((id) => {
      const r = readRoute({ ...ROUTE, id, claim: `${id} 的主张` }, seen);
      expect(r.ok).toBe(true);
      return r.ok ? r.value : (null as never);
    });
    expect(three.map((r) => r.id)).toEqual(["R1", "R2", "R3"]);
    expect(routeGaps(three, FULL_FIELDS)).toEqual([]);
    const dup = readRoute({ ...ROUTE, id: "R2" }, seen);
    expect(dup.ok).toBe(false);
  });

  /*
   * 0 条是合法的解析结果（凑数编一条比只给两条差得多），但它要被看见 —— 一条不给等于
   * 这道选择题没被当成选择题。所以：解析不报错，机检报一条账。
   */
  it("零条：解析没有错，机检报一条账，而且不说「不足三条」", () => {
    const gaps = routeGaps([], FULL_FIELDS);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toContain("一条都没有");
    expect(gaps.join("")).not.toContain("不足");
  });

  it("两条不算缺口 —— 至多三条是上限不是指标；超过三条要报", () => {
    const seen = new Set<string>();
    const two = ["R1", "R2"].map((id) => {
      const r = readRoute({ ...ROUTE, id }, seen);
      return r.ok ? r.value : (null as never);
    });
    expect(routeGaps(two, FULL_FIELDS)).toEqual([]);
    const four = ["Ra", "Rb", "Rc", "Rd"].map((id) => route({ ...ROUTE, id }));
    expect(routeGaps(four, FULL_FIELDS).join("")).toContain(`超过 ${ROUTE_MAX}`);
  });

  it("缺栏落空、整条不丢；缺的那几栏逐条报账", () => {
    const thin = route({ id: "R9", claim: "只有主张" });
    expect(thin.dependsOn).toEqual([]);
    const gaps = routeGaps([thin], FULL_FIELDS).join("");
    for (const want of ["我方能力匹配", "客户条件", "收益", "改走别路的条件", "关键依赖"]) {
      expect(gaps).toContain(want);
    }
  });

  it("没有主张的那一条整条拒；没有 id 也拒", () => {
    const claimless = readRoute({ id: "R3" });
    expect(claimless.ok).toBe(false);
    expect(claimless.ok ? "" : claimless.why).toContain("主张");
    expect(readRoute({ claim: "有主张没编号" }).ok).toBe(false);
  });

  it("依赖引到不存在的前提要报；踩在规划中/未知的能力上要报成条件式", () => {
    expect(routeGaps([route({ ...ROUTE, dependsOn: ["P99"] })], FULL_FIELDS).join("")).toContain("P99");
    const planned = premise({ ...ABILITY, id: "PX", stage: "规划中" });
    const g = routeGaps([route({ ...ROUTE, dependsOn: ["PX"] })], [...FULL_FIELDS, planned]).join("");
    expect(g).toContain("条件式");
    expect(g).toContain("规划中");
    // 已实现的那条不报 —— 这道闸只拦「还没有的东西被当成现成的」
    expect(routeGaps([route(ROUTE)], FULL_FIELDS).join("")).not.toContain("条件式");
  });
});

describe("现在就能拿出去的能力", () => {
  it("只有「当前已实现」且来源不是推测/未知的那几条算数", () => {
    const list = [
      premise({ ...ABILITY, id: "A1", stage: "当前已实现", standing: "材料记载" }),
      premise({ ...ABILITY, id: "A2", stage: "规划中", standing: "材料记载" }),
      premise({ ...ABILITY, id: "A3", stage: "当前已实现", standing: "推测" }),
      premise({ ...ABILITY, id: "A4", stage: "未知", standing: "材料记载" }),
      premise({ id: "A5", field: "此次目标", statement: "拿到客户问题", standing: "用户提供", source: "「先摸清」" }),
    ];
    expect(deliverableNow(list).map((p) => p.id)).toEqual(["A1"]);
  });
});

describe("往下传的渲染", () => {
  it("前提每条带 id、栏位、身份、阶段和来源；没写来源明说未注明", () => {
    const [line] = premiseLines([premise(ABILITY)]);
    expect(line).toContain("P1");
    expect(line).toContain("我方已实现能力");
    expect(line).toContain("材料记载");
    expect(line).toContain("当前已实现");
    expect(premiseLines([premise({ id: "P0", field: "此次目标", statement: "x" })]).join("")).toContain("未注明");
  });

  it("路线把六栏都摊开，缺的那栏写「（未写）」而不是消失", () => {
    const text = routeLines([route(ROUTE)]).join("\n");
    expect(text).toContain("R1：");
    expect(text).toContain("改走别路的条件");
    expect(routeLines([route({ id: "R9", claim: "c" })]).join("\n")).toContain("（未写）");
  });
});

describe("我方材料这一段", () => {
  it("有上下文就原样带上，并说清「没说的是未知，不是没有」", () => {
    const text = companyContextLines("TKOS 是一套企业经营系统，连接战略、决策、执行与 Review。").join("\n");
    expect(text).toContain("企业经营系统");
    expect(text).toContain("未知");
    expect(text).toContain("不是「没有」");
  });

  it("没上下文时不整段消失 —— 明说这一轮没有，我方的话一律写未知", () => {
    for (const empty of ["", "   ", null, undefined, NO_COMPANY_CONTEXT]) {
      const text = companyContextLines(empty).join("\n");
      expect(text).toContain("没有取到公司上下文");
      // 那一段是给出稿几步的格式约束，在这一步是噪音
      expect(text).not.toContain("cited_member_ids");
    }
  });

  it("过长的上下文截断 —— N1 的输出额度是含思考的", () => {
    const long = "很".repeat(CONTEXT_CHARS + 500);
    const text = companyContextLines(long).join("\n");
    expect(text).toContain("此处截断");
    expect(text.length).toBeLessThan(long.length);
  });
});

describe("一号位给定的前提", () => {
  it("一条都没有时整段不出现", () => {
    expect(userPremiseLines([])).toEqual([]);
    expect(userPremiseLines([{ text: "  " }])).toEqual([]);
  });

  it("带原话，且明写它不是已核实的外部事实", () => {
    const text = userPremiseLines([
      { text: "维信诺是我们 TKOS 的第一个客户", quote: "我们的TKOS的第一个客户是维信诺" },
      { text: "他认识对方工艺负责人" },
    ]).join("\n");
    expect(text).toContain("第一个客户");
    expect(text).toContain("原话：「我们的TKOS的第一个客户是维信诺」");
    expect(text).toContain("用户提供");
    expect(text).toContain("不要把它们当成已经核过的外部事实");
  });
});
