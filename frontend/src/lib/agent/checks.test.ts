import { describe, expect, it } from "vitest";

import {
  a1aExternal,
  a1aIgnore,
  a1aIsIgnore,
  a1aNew,
  a1aTriage,
  a1aUpdate,
  anchorChecks,
  IGNORE_VERDICT,
  NO_ISSUE_VERDICT,
  summarize,
} from "./checks";

const failed = (cs: { name: string; ok: boolean }[]) => cs.filter((c) => !c.ok).map((c) => c.name);

describe("summarize", () => {
  it("数出过了几条、哪几条没过", () => {
    const s = summarize([
      { name: "甲", ok: true, detail: "" },
      { name: "乙", ok: false, detail: "" },
    ]);
    expect(s).toEqual({ passed: 1, total: 2, allPassed: false, failed: ["乙"] });
  });
});

describe("a1aIsIgnore", () => {
  it("decision、判词、旧的 relevant 三种都认", () => {
    expect(a1aIsIgnore({ decision: "ignore" })).toBe(true);
    expect(a1aIsIgnore({ verdict: IGNORE_VERDICT })).toBe(true);
    expect(a1aIsIgnore({ verdict: NO_ISSUE_VERDICT })).toBe(true);
    expect(a1aIsIgnore({ relevant: false })).toBe(true);
    expect(a1aIsIgnore({ decision: "new_issue" })).toBe(false);
  });
});

describe("a1aTriage", () => {
  it("路由被归一化过要标出来", () => {
    const cs = a1aTriage(
      { decision: "update_issue", signal_reading: "甲", rationale: "一二三四五六七八九十" },
      new Set(["ISS-01"]),
      "修改"
    );
    expect(failed(cs)).toContain("路由取值原样合法");
    // 归一化过仍然往下走 —— 认得出对应关系就不该拦，只是要在结果页上留痕。
    expect(cs.find((c) => c.name === "路由取值原样合法")?.detail).toContain("修改");
  });

  it("update_issue 指的议题不在上下文里就是编的", () => {
    const cs = a1aTriage(
      {
        decision: "update_issue",
        signal_reading: "甲",
        rationale: "一二三四五六七八九十",
        target_issue_code: "ISS-99",
      },
      new Set(["ISS-01"]),
      "update_issue"
    );
    expect(failed(cs)).toEqual(["要取代的议题在上下文里存在"]);
  });

  it("new_issue 不查议题编号", () => {
    const cs = a1aTriage(
      { decision: "new_issue", signal_reading: "甲", rationale: "一二三四五六七八九十" },
      new Set(),
      "new_issue"
    );
    expect(failed(cs)).toEqual([]);
    expect(cs.map((c) => c.name)).not.toContain("指名了要取代的既有议题");
  });
});

describe("a1aIgnore", () => {
  it("说不出什么情况下会重新值得处理的，是搁置不是判断", () => {
    const cs = a1aIgnore({ verdict: IGNORE_VERDICT, reason: "只有一个来源", what_would_change_it: "无" });
    expect(failed(cs)).toEqual(["说得出什么情况下它会重新值得处理"]);
  });

  it("判词改写过就不算原样给出", () => {
    const cs = a1aIgnore({
      verdict: "此信号应被忽略。",
      reason: "只有一个来源",
      what_would_change_it: "出现第二个独立来源",
    });
    expect(failed(cs)).toEqual(["判词原样给出"]);
  });
});

describe("a1aUpdate", () => {
  /** 一份各项都过的取代。每个用例只动它要测的那一处。 */
  const goodUpdate = {
    target_issue_code: "ISS-01",
    replaces: { code: "ISS-01", statement_before: "旧的说法在这里。" },
    sharp_title: "这件事只发生在一个行业还是三个？",
    issue_statement: "新的说法把范围收窄到一个行业。",
    what_happened: "新一批招标文件里，只有一个行业的技术评分权重在降。",
    evidence_boundary: "三个行业里只拿到一个行业的招标文件，时间窗只有一个季度。",
    business_consequence: "如果只是一个行业，覆盖面那条假设仍然成立，改打法的代价白付。",
    real_question: "另外两个行业的技术评分权重有没有同步下降？",
    source_line: "一个行业的公开招标文件。",
    what_changed: "范围从三个行业收到一个",
    why_replace_not_new: "说的是同一件事",
    cited_member_ids: ["ISS-01"],
  };

  it("新说法等于旧说法（只差标点）不是取代", () => {
    const cs = a1aUpdate(
      {
        ...goodUpdate,
        replaces: { code: "ISS-01", statement_before: "我们赌模型能力带动交付。" },
        issue_statement: "我们赌模型能力带动交付",
      },
      new Set(["ISS-01"])
    );
    expect(failed(cs)).toEqual(["新议题不是旧议题的原地重复"]);
  });

  it("编造的引用 ID 要点名报出来", () => {
    const cs = a1aUpdate({ ...goodUpdate, cited_member_ids: ["ISS-01", "JDG-编"] }, new Set(["ISS-01"]));
    expect(failed(cs)).toEqual(["引用 ID 真实"]);
    expect(cs.find((c) => c.name === "引用 ID 真实")?.detail).toContain("JDG-编");
  });

  /*
   * 「变的是哪一处」对着旧说法说，「发生了什么」对着世界说。写成同一句话的，通常是
   * 把 what_happened 当成 what_changed 的复述交了 —— 于是这一轮里「世界发生了什么」
   * 整个没答，而两格都是满的。
   */
  it("「变的是哪一处」和「发生了什么」填了同一句话，要被抓出来", () => {
    const cs = a1aUpdate({ ...goodUpdate, what_happened: goodUpdate.what_changed }, new Set(["ISS-01"]));
    expect(failed(cs)).toEqual(["「变的是哪一处」与「发生了什么」不是同一句"]);
  });

  it("都对就通过", () => {
    expect(failed(a1aUpdate(goodUpdate, new Set(["ISS-01"])))).toEqual([]);
  });
});

describe("a1aNew", () => {
  /** S01 那四块都填对了的一份。每个用例只动它要测的那一处。 */
  const goodNew = {
    sharp_title: "我们靠模型能力建立的差异还剩多少？",
    issue_statement: "定价从 v1.5 的 3.5% 抽成改成按席位算，我们的毛利假设还成立吗？",
    what_happened: "对方把抽成改成按席位收费。",
    evidence_boundary: "只有对方官网的定价页，没有实际成交价，样本是一家。",
    business_consequence: "如果按席位算，我们那条按流水抽成的毛利假设要重算。",
    real_question: "改成按席位之后，我们的毛利率落在哪一档？",
    source_line: "对方官网定价页，未独立核实。",
    shakes_assumption: "一二三四五六七八",
    suggested_handling: "丁",
  };

  it("那四块缺哪几格要点名", () => {
    const cs = a1aNew(
      { issue_statement: "我们靠模型能力建立的差异还剩多少？", business_consequence: "招标季在三个月内" },
      new Set()
    );
    const detail = cs.find((c) => c.name === "那四块的每一格都填了")?.detail;
    expect(detail).toContain("what_happened");
    expect(detail).toContain("evidence_boundary");
    expect(detail).toContain("real_question");
    expect(cs.find((c) => c.name === "动摇的假设与建议都给了")?.detail).toContain("suggested_handling");
  });

  it("证据边界写成「资料有限」等于没写边界", () => {
    const cs = a1aNew({ ...goodNew, evidence_boundary: "资料有限" }, new Set());
    expect(failed(cs)).toEqual(["证据边界说到了具体是哪一种不足"]);
    // 真实的边界句里常含着这四个字，后面接着说清了是哪一种有限 —— 那种要算通过，
    // 否则这条检查会把写得最细的那些判成红的。
    expect(
      failed(a1aNew({ ...goodNew, evidence_boundary: "资料有限：只有对方官网的定价页，没有成交价。" }, new Set()))
    ).toEqual([]);
  });

  /*
   * 实测最常见的失败不是缺格，是把同一句话填进两格 —— 七格全满，看着无懈可击，
   * 而其中一格其实没答。人眼在长文里很难看出来，机器一比就出来。
   */
  it("把同一句话填进两格要被抓出来", () => {
    const cs = a1aNew(
      { ...goodNew, real_question: goodNew.business_consequence },
      new Set()
    );
    expect(failed(cs)).toEqual(["一段一件事，没有把同一句话填进两格"]);
    expect(cs.find((c) => c.name === "一段一件事，没有把同一句话填进两格")?.detail).toContain(
      "真正要回答的问题"
    );
  });

  it("标题不是问句、或者长得不像标题，都要记下来", () => {
    expect(failed(a1aNew({ ...goodNew, sharp_title: "论入口迁移" }, new Set()))).toEqual([
      "标题是一个短问句",
    ]);
    expect(
      failed(a1aNew({ ...goodNew, sharp_title: `${"入口迁移之后我们还剩什么".repeat(4)}？` }, new Set()))
    ).toEqual(["标题是一个短问句"]);
  });

  /*
   * 数字里的小数点不是句末。这条检查错判的代价是把**对的**产出在台账上标红，而台账
   * 是给人评分用的唯一凭据 —— 错误的红比没有这条检查更坏。
   */
  it("v1.5 / 3.5% 里的点不算句末，正常句点照样算", () => {
    const withDecimals = a1aNew(goodNew, new Set());
    const sent = (cs: { name: string; detail: string }[]) =>
      cs.find((c) => c.name === "议题正文不超过三句")?.detail;
    expect(sent(withDecimals)).toBe("1 句");
    expect(failed(withDecimals)).toEqual([]);

    const fourSentences = a1aNew(
      { ...goodNew, issue_statement: "One thing. Two thing. Three thing. Four thing." },
      new Set()
    );
    expect(sent(fourSentences)).toBe("4 句");
    expect(failed(fourSentences)).toContain("议题正文不超过三句");
  });
});

describe("a1aExternal", () => {
  const good = {
    decision: "new_issue",
    sharp_title: "交付侧入口换人了吗？",
    issue_statement: "这条变化一旦成立，谁必须重新考虑自己在做什么？",
    what_happened: "三家大厂在同一个季度把销售与交付合并成行业线。",
    evidence_boundary: "三条都是企业自披露的公告，没有第三方核实的中标数据，也没有一例失败与成本。",
    business_consequence: "靠单点能力定位的公司，其获客链依赖技术评估这条前提可能不再成立。",
    real_question: "采购决策权是真的换了人，还是只是汇报线换了？",
    source_line: "三家大厂的组织公告，二手汇编，未独立核实。",
    why_it_qualifies: "它指向的是交付侧入口的转移，一旦成立，靠模型能力定位的公司都要重新算账。",
    cited_member_ids: [],
  };

  it("纯外部路上编造公司上下文要被抓出来", () => {
    const cs = a1aExternal(
      {
        ...good,
        why_it_qualifies:
          "公司现有战略假设是靠模型能力带动交付，这条正好压在它上面，二十字以上。",
      },
      "new_issue"
    );
    expect(failed(cs)).toEqual(["没有编造公司上下文"]);
  });

  /*
   * 编造公司上下文要在整份产出里查。这一版新增的 business_consequence 恰恰是最容易
   * 写出「公司现有战略假设是……」的那一格 —— 它要说「哪一个当前重要判断需要重新审视」，
   * 而这条路上没有任何内部材料能告诉它那是哪一条。只查旧的那两格，等于这条检查在
   * 最需要它的地方不生效。
   */
  it("新增的那几格里编造公司上下文，一样要被抓出来", () => {
    const cs = a1aExternal(
      { ...good, business_consequence: "公司此前认为模型能力足以带动交付，这条正好压在它上面。" },
      "new_issue"
    );
    expect(failed(cs)).toEqual(["没有编造公司上下文"]);
  });

  it("纯外部路上引用非空一定是编的", () => {
    const cs = a1aExternal({ ...good, cited_member_ids: ["ISS-01"] }, "new_issue");
    expect(failed(cs)).toEqual(["引用为空"]);
  });

  /*
   * 纯外部路上 `run.ts` 会把任何看不懂的 decision 改写成 new_issue。改写不留痕的话，
   * 模型违反模板硬约束（这条路上 update_issue 不成立）时，产出照样是一条格式完整的
   * new_issue，台账上一点痕迹都没有 —— 而这是实测最常走的那条路。
   */
  it("模型给了 update_issue：改写照做，但判不通过并说出原值", () => {
    const cs = a1aExternal(good, "update_issue");
    expect(failed(cs)).toEqual(["路由取值原样合法"]);
    const hit = cs.find((c) => c.name === "路由取值原样合法");
    expect(hit?.detail).toContain("update_issue");
    expect(hit?.detail).toContain("不成立");
  });

  it("decision 空着也判不通过 —— 这条路上没有就地失败那一步替它兜底", () => {
    expect(failed(a1aExternal(good, ""))).toEqual(["路由取值原样合法"]);
    // 判噪音那条路同样要判：a1aIsIgnore 认 relevant:false，decision 可以整个缺席。
    const ig = a1aExternal(
      {
        relevant: false,
        verdict: NO_ISSUE_VERDICT,
        reason: "只有一个来源",
        what_would_change_it: "出现第二个独立来源",
      },
      ""
    );
    expect(failed(ig)).toEqual(["路由取值原样合法"]);
  });

  it("原样给对了就通过", () => {
    expect(failed(a1aExternal(good, "new_issue"))).toEqual([]);
  });
});

describe("anchorChecks", () => {
  it("叙述那一支判**通过**，但必须写明这一轮只有公司层、以及该评的是挂靠而不是引用", () => {
    const cs = anchorChecks({
      mode: "narrative",
      bundle: null,
      anchor: null,
      anchorOrigin: null,
      noAnchorReason: "本体叙述接口不产生锚点：它沿主导航路径装配一段脉络，没有可引编号",
      staticContext: "",
      snapshotId: "ctx-x",
      trace: [],
      warnings: [],
    });
    expect(cs[0].ok).toBe(true);
    // 少了这几句，评分的人会拿有既有判断那一档的标准去评一份根本拿不到既有判断的产出。
    expect(cs[0].detail).toContain("引用应为空");
    expect(cs[0].detail).toContain("工作记忆");
    // 正面那一条：该评的是它有没有把议题挂到某条 Mission 上，这比「有没有引用」有意义。
    expect(cs[0].detail).toContain("Mission");
  });

  it("图谱里没锚点判**通过** —— 那是分支，不是故障", () => {
    const cs = anchorChecks({
      mode: "external_only",
      bundle: null,
      anchor: null,
      anchorOrigin: null,
      noAnchorReason: "这一池分不出高低",
      staticContext: "",
      snapshotId: null,
      trace: [],
      warnings: [],
    });
    expect(cs[0].ok).toBe(true);
    expect(cs[0].detail).toContain("纯外部");
  });

  it("首名次名咬得紧要标红，但只提示不拦截", () => {
    const cs = anchorChecks({
      mode: "anchored",
      bundle: null,
      anchor: {
        origin: "auto",
        anchorCode: "ISS-01",
        score: 0.81,
        label: "交付侧入口",
        state: "open",
        channel: "A3",
        prefix: "ISS-",
        rank: 1,
        rankOverall: 1,
        k: 8,
        ambiguous: true,
        pool: { n: 6, topScore: 0.81, bottomScore: 0.6, topCode: "ISS-01", flatness: 0.74 },
        querySent: "交付侧入口",
        runnersUp: [{ code: "ISS-02", score: 0.79, label: "模型能力对比" }],
        warnings: [],
      },
      anchorOrigin: "auto",
      noAnchorReason: null,
      staticContext: "",
      snapshotId: "ctx-x",
      trace: [],
      warnings: [],
    });
    expect(cs[0].ok).toBe(false);
    expect(cs[0].detail).toContain("ISS-02");
  });
});
