import { describe, expect, it } from "vitest";
import { DIM_IDS } from "./dims";
import { ANSWER_SOURCES, DRAFT_SYSTEM, buildDraftUser, draftGaps, parseDraft } from "./draft";
import { PREMISE_FIELDS, ROUTE_MAX } from "./premise";

const line = (o: unknown): string => JSON.stringify(o);

const section = (dim: string) =>
  line({
    type: "draft_section",
    dim,
    thesis: `${dim} 这一维的论点：这一段已经从量增转入存量`,
    body: "机制写在这里：固定成本结构决定了降载就亏，所以宁可先把货做出来。",
    assertions: [
      { text: "出货量约 9.2 亿片", tag: "P", confidence: "中", timeSensitive: true, loadBearing: true, answerIn: "公开可查" },
      { text: "固定成本占比高，降载即亏", tag: "P", confidence: "高", timeSensitive: false, loadBearing: false, answerIn: "公开可查" },
    ],
  });

const full = [
  line({ type: "draft_meta", thesis: "这个行业的总量红利已经用完，往后决定单个厂商处境的是份额重排" }),
  ...DIM_IDS.map(section),
  line({ type: "draft_unknowns", items: ["Q2 出货", "最新价格", "扩产进度", "政策文件", "分应用增速"] }),
].join("\n");

describe("草稿解析", () => {
  it("一行一节，坏掉的那一行只丢它自己", () => {
    const r = parseDraft(`${full}\n{坏行`);
    expect(r.draft.sections).toHaveLength(8);
    expect(r.bad).toHaveLength(1);
    expect(r.bad[0].line).toBe(11);
  });

  it("认不出的维度编号不收", () => {
    const r = parseDraft([line({ type: "draft_section", dim: "D9", thesis: "x", body: "y" })].join("\n"));
    expect(r.draft.sections).toHaveLength(0);
    expect(r.bad[0].why).toContain("D9");
  });

  it("标签只认四种，写别的落成 P", () => {
    const r = parseDraft(
      line({
        type: "draft_section",
        dim: "D1",
        thesis: "t",
        body: "b",
        assertions: [{ text: "x", tag: "已验证", confidence: "高" }],
      })
    );
    expect(r.draft.sections[0].assertions[0].tag).toBe("P");
  });

  it("代码围栏和空行不当坏行", () => {
    const r = parseDraft(["```jsonl", full, "```", ""].join("\n"));
    expect(r.bad).toHaveLength(0);
  });
});

describe("草稿的缺口", () => {
  it("八维齐、总判断是判断句、清单够五条 —— 没有缺口", () => {
    expect(draftGaps(parseDraft(full).draft)).toEqual([]);
  });

  it("少一个维度要报出来", () => {
    const short = full.split("\n").filter((l) => !l.includes('"D5"')).join("\n");
    expect(draftGaps(parseDraft(short).draft).join("")).toContain("D5");
  });

  it("总判断骑墙要报出来", () => {
    const hedged = full.replace(/"thesis":"这个行业[^"]*"/, '"thesis":"这个行业的前景有待观察，喜忧参半"');
    expect(draftGaps(parseDraft(hedged).draft).join("")).toContain("骑墙");
  });

  it("总判断超过 150 字要报出来", () => {
    const long = full.replace(/"thesis":"这个行业[^"]*"/, `"thesis":"${"这个行业已经进入存量。".repeat(20)}"`);
    expect(draftGaps(parseDraft(long).draft).join("")).toContain("150");
  });

  // 下限 2026-09-07（ISS-240 减重）从 5 降到 4：会改变路线的那几条现在进「要问对方」那一桶。
  it("不知道清单不足四条要报出来；正好四条不报", () => {
    const thin = full.replace(/"items":\[[^\]]*\]/, '"items":["只有一条"]');
    expect(draftGaps(parseDraft(thin).draft).join("")).toContain("不足 4 条");
    const four = full.replace(/"items":\[[^\]]*\]/, '"items":["a","b","c","d"]');
    expect(draftGaps(parseDraft(four).draft).join("")).not.toContain("我知道我不知道的");
  });

  it("断言标注率不足九成要报出来", () => {
    const bare = full.replace(/"timeSensitive":true/g, '"timeSensitive":null');
    expect(draftGaps(parseDraft(bare).draft).join("")).toContain("标注");
  });

  it("某一维没有论点要报出来", () => {
    const noThesis = full.replace(/"thesis":"D4[^"]*"/, '"thesis":""');
    expect(draftGaps(parseDraft(noThesis).draft).join("")).toContain("D4");
  });
});

/* ---- 答案在谁手里：三桶（2026-09-07，ISS-240）----------------------------- */

const withAnswerIn = (...list: string[]) =>
  line({
    type: "draft_section",
    dim: "D1",
    thesis: "t",
    body: "b",
    assertions: list.map((answerIn, i) => ({
      text: `断言 ${i}`,
      tag: "P",
      confidence: "中",
      timeSensitive: true,
      loadBearing: true,
      answerIn,
    })),
  });

describe("答案在谁手里", () => {
  it("三桶各一例，原样收下", () => {
    const r = parseDraft(withAnswerIn("公开可查", "要问对方", "在我方手里"));
    expect(r.draft.sections[0].assertions.map((a) => a.answerIn)).toEqual([
      "公开可查",
      "要问对方",
      "在我方手里",
    ]);
    // 契约本身：三桶就这三个，顺序也是契约的一部分（别的两条线按下标接）
    expect(ANSWER_SOURCES).toEqual(["公开可查", "要问对方", "在我方手里"]);
  });

  /*
   * 不对称是这一栏的全部设计：落错到「公开可查」只白花一次检索，落错到另外两桶这条事实
   * 从此没有人去查。所以判不出来一律往回退到「公开可查」，而不是留空或者猜一个。
   */
  it("判不出来的一律落「公开可查」：没写、写了个认不出的词、写成别的类型", () => {
    const r = parseDraft(
      line({
        type: "draft_section",
        dim: "D1",
        thesis: "t",
        body: "b",
        assertions: [
          { text: "没写这一栏", tag: "P", confidence: "中", timeSensitive: true },
          { text: "写了个认不出的词", tag: "P", confidence: "中", timeSensitive: true, answerIn: "得去问问" },
          { text: "写成了别的类型", tag: "P", confidence: "中", timeSensitive: true, answerIn: 3 },
        ],
      })
    );
    expect(r.draft.sections[0].assertions.map((a) => a.answerIn)).toEqual([
      "公开可查",
      "公开可查",
      "公开可查",
    ]);
  });

  /*
   * 这一栏非进标注率不可：它的默认值恰恰是最贵的那个。不算进去，模型整份少填一栏一声不响，
   * 全部断言落进「公开可查」、全部排进检索计划 —— ISS-240 那一轮 24 条证据零引用的样子。
   */
  it("标注率把这一栏算进「完整标注」：别的三样齐了、只少这一栏，照样报缺口", () => {
    const bare = full.replace(/,"answerIn":"公开可查"/g, "");
    const gaps = draftGaps(parseDraft(bare).draft).join("");
    expect(gaps).toContain("完整标注");
    expect(gaps).toContain("答案在谁手里");
    // 四样齐的那一份不报
    expect(draftGaps(parseDraft(full).draft).join("")).not.toContain("完整标注");
  });

  it("决策骨架那种行的断言走同一道标注闸", () => {
    const pb = line({
      type: "draft_playbook",
      heading: "要先定的那件事",
      body: "b",
      assertions: [{ text: "对方走不走集团招标", tag: "P", confidence: "中", timeSensitive: true, loadBearing: true }],
    });
    const r = parseDraft([full, pb].join("\n"));
    expect(r.draft.playbook[0].assertions[0].answerIn).toBe("公开可查");
    // 16 条齐 + 1 条缺这一栏 = 16/17，还在九成以上，所以这里查的是它真的被计进了分母
    expect(r.draft.playbook[0].assertions).toHaveLength(1);
    const many = [full, pb, pb, pb].join("\n");
    expect(draftGaps(parseDraft(many).draft).join("")).toContain("19 条断言里只有 16 条");
  });
});

describe("提示词", () => {
  it("明写不检索、参数化知识放开、过期的数照写", () => {
    expect(DRAFT_SYSTEM).toContain("不检索");
    expect(DRAFT_SYSTEM).toContain("照写");
    expect(DRAFT_SYSTEM).not.toContain("证据编号");
  });

  it("三桶的判据、反例、和不对称的兜底都写在字面上（ISS-240）", () => {
    for (const bucket of ANSWER_SOURCES) expect(DRAFT_SYSTEM).toContain(bucket);
    // 判据是「谁知道这件事」，不是「重不重要」
    expect(DRAFT_SYSTEM).toContain("谁知道这件事");
    // 只有一桶进检索计划 —— 这是三桶存在的理由
    expect(DRAFT_SYSTEM).toContain("只有这一桶会进");
    // 反例：最容易被当成公开可查的那一条
    expect(DRAFT_SYSTEM).toContain("集团招标");
    expect(DRAFT_SYSTEM).toContain("资本开支");
    // 兜底方向和它的理由（代价不对称）
    expect(DRAFT_SYSTEM).toContain("判不出来的一律填「公开可查」");
    expect(DRAFT_SYSTEM).toContain("代价不对称");
    expect(DRAFT_SYSTEM).toContain("从此没有人去查");
    // 形状示例里这一栏在
    expect(DRAFT_SYSTEM).toContain('"answerIn":"公开可查|要问对方|在我方手里"');
    expect(DRAFT_SYSTEM).toContain("标全四样");
  });

  /*
   * 减重的那几个数（ISS-240：第一次调用撞 420 秒墙钟一个字没交，补正同一份契约 204 秒交完）。
   * 提示词和机检读的是同一批常量，所以这里查的是「提示词上写的数确实降下来了」，
   * 顺带钉住「下限只有一处定义」—— 提示词里的 ≥N 和 draftGaps 报的 N 必须是同一个。
   */
  it("减重：body 上限、每维断言条数、不知道清单下限都降了一档", () => {
    expect(DRAFT_SYSTEM).toContain("控制在 150 字以内");
    expect(DRAFT_SYSTEM).not.toContain("200 字以内");
    expect(DRAFT_SYSTEM).toContain("每一维写 4 到 6 条");
    expect(DRAFT_SYSTEM).not.toContain("5 到 7 条");
    expect(DRAFT_SYSTEM).toContain("≥4 条");
    const thin = full.replace(/"items":\[[^\]]*\]/, '"items":["一条"]');
    expect(draftGaps(parseDraft(thin).draft).join("")).toContain("不足 4 条");
    // 结构一个都没动：三种行、五栏前提、至多三条路线还在
    const user = buildDraftUser({ title: "t", card: { subject: "x", decision: true } as never });
    for (const row of ["draft_premise", "draft_route", "draft_playbook"]) expect(user).toContain(row);
    for (const f of PREMISE_FIELDS) expect(user).toContain(f);
    expect(user).toContain(`至多 ${ROUTE_MAX} 条`);
  });

  it("问自己家里的事时多一段：主体是我们自己、不写外部厂商与市场（2026-09-05）", () => {
    const inward = buildDraftUser({ title: "t", card: { subject: "本公司", industry: "x", inward: true } as never });
    expect(inward).toContain("这道题问的是我们自己");
    expect(inward).toContain("不要引入外部厂商");
    const outward = buildDraftUser({ title: "t", card: { subject: "维信诺", industry: "x", inward: false } as never });
    expect(outward).not.toContain("这道题问的是我们自己");
  });

  it("决策题（R-11）：draft_playbook 是合法的行，进 playbook；没 heading 的那一行留账", () => {
    const pb = line({
      type: "draft_playbook",
      heading: "首访只谈验收口径，不报价",
      body: "对方的采购在等一份能落地的验收标准；先报价会把谈判拉到成本上。",
      assertions: [{ text: "维信诺 8.6 代线 2026 年量产", tag: "P", confidence: "中", timeSensitive: true, loadBearing: true }],
    });
    const r = parseDraft(`${full}\n${pb}\n${line({ type: "draft_playbook", body: "没标题" })}`);
    expect(r.draft.sections).toHaveLength(8);
    expect(r.draft.playbook).toHaveLength(1);
    expect(r.draft.playbook[0].heading).toContain("不报价");
    expect(r.draft.playbook[0].assertions).toHaveLength(1);
    expect(r.bad).toHaveLength(1);
    expect(r.bad[0].why).toContain("heading");
  });

  it("决策题上骨架不足三段算缺口；分析题上一段都没有也不算", () => {
    const r = parseDraft(full);
    expect(draftGaps(r.draft)).toEqual([]);
    expect(draftGaps(r.draft, { decision: true }).join("")).toContain("只有 0 段");
  });

  it("决策题的 user 段多一段：要交 draft_playbook，八维退成背景", () => {
    const user = buildDraftUser({ title: "首访维信诺怎么开", card: { subject: "维信诺", industry: "x", inward: false, decision: true } as never });
    expect(user).toContain("draft_playbook");
    expect(user).toContain("要的是一个决策");
    const plain = buildDraftUser({ title: "t", card: { subject: "维信诺", industry: "x", inward: false, decision: false } as never });
    expect(plain).not.toContain("draft_playbook");
  });

  it("决策题的维度框架只列 D2 / D3 / D8，行业题照旧八维（批 V §3）", () => {
    const decision = buildDraftUser({
      title: "首访维信诺怎么开",
      card: { subject: "维信诺", industry: "x", inward: false, decision: true } as never,
    });
    for (const dim of ["D2", "D3", "D8"]) expect(decision).toContain(`${dim} `);
    // 列出来的就是要写的：这五维一个字都不该出现在维度框架里。
    const frame = decision.slice(decision.indexOf("## 维度框架"));
    for (const dim of ["D1", "D4", "D5", "D6", "D7"]) expect(frame).not.toContain(`${dim} `);
    expect(decision).toContain("也不要写别的维度");

    const industry = buildDraftUser({
      title: "t",
      card: { subject: "维信诺", industry: "x", inward: false, decision: false } as never,
    });
    for (const dim of DIM_IDS) expect(industry).toContain(`${dim} `);
    expect(industry).toContain("八个维度一个都不许省");
  });

  it("决策题只按三维报缺口：少写 D5 不算缺，少写 D3 算（批 V §3）", () => {
    const r = parseDraft(full);
    const three = { ...r.draft, sections: r.draft.sections.filter((x) => ["D2", "D3", "D8"].includes(x.dim)) };
    expect(draftGaps(three, { decision: true }).filter((g) => g.includes("这一维没有内容"))).toEqual([]);
    expect(draftGaps(three).join("")).toContain("D5");
    const missing = { ...three, sections: three.sections.filter((x) => x.dim !== "D3") };
    expect(draftGaps(missing, { decision: true }).join("")).toContain("D3 这一维没有内容");
  });

  /*
   * 2026-09-07（ISS-239 §3.A P0）：生产提示词里那个「首访只谈验收口径，不报价」的例子，和
   * 当轮真实测试题的结论高度相似 —— 换成不含商业主张的占位说明。上面那条 R-11 的回归用例
   * 里留着原话，那是**历史失败样本**，不许为了让这条过而删掉它。
   */
  it("决策题的提示词里不留同题结论式示例（只留字段规范）", () => {
    const user = buildDraftUser({
      title: "首访维信诺怎么开",
      card: { subject: "维信诺", industry: "x", inward: false, decision: true } as never,
    });
    expect(user).toContain("draft_playbook");
    expect(user).toContain("要定的一件事（一句判断，不是类目名）");
    for (const leak of ["不报价", "验收口径", "只谈"]) expect(user).not.toContain(leak);
  });

  it("决策题多两段契约：结构化前提五栏 + 至多三条候选路线", () => {
    const user = buildDraftUser({
      title: "首访维信诺怎么开",
      card: { subject: "维信诺", industry: "x", inward: false, decision: true } as never,
    });
    expect(user).toContain("draft_premise");
    expect(user).toContain("draft_route");
    for (const f of PREMISE_FIELDS) expect(user).toContain(f);
    expect(user).toContain(`至多 ${ROUTE_MAX} 条`);
    // 三条硬规矩里最要紧的两条要出现在字面上
    expect(user).toContain("规划中的能力不许写成当前已实现");
    expect(user).toContain("不知道就显式写一条「未知」");
    // 行业题上不出这两段：那五栏问的不是这道题
    const plain = buildDraftUser({ title: "t", card: { subject: "维信诺", decision: false } as never });
    expect(plain).not.toContain("draft_premise");
    expect(plain).not.toContain("draft_route");
  });

  /*
   * ISS-240：报告里出现了替我方许下的「私有化部署、数据不出厂、知识产权归客户」，而公司
   * 上下文里没有任何依据 —— 它是在 `fit` 和决策骨架里被第一次写出来的。所以关于我方的话
   * 在这两段只有一个合法来源：上面 `draft_premise` 里已经写下来的那几条。
   */
  it("决策题：能力匹配和承诺边界只许引前提，不许现编", () => {
    const user = buildDraftUser({
      title: "首访该怎么开",
      card: { subject: "维信诺", decision: true } as never,
    });
    // 五栏前提的答案在我方手里，所以整段不进检索计划
    expect(user).toContain("在我方手里");
    expect(user).toContain("一条都不进检索计划");
    // 候选路线的 fit：按 ID 引，不许第一次出现
    expect(user).toContain("只能引上面 `draft_premise` 里已经写下来的前提");
    expect(user).toContain("不许第一次出现");
    // 决策骨架的承诺口径：那条前提写「未知」就一个字都不许承诺
    expect(user).toContain("只能照抄上面「承诺边界」那条前提");
    expect(user).toContain("一个字都不许承诺");
    for (const kind of ["部署方式", "数据归属", "知识产权"]) expect(user).toContain(kind);
    // 骨架依赖的外部事实照样分桶，而对方的采购/审批不是检索题
    expect(user).toContain("审批门槛标「要问对方」");
  });

  it("公司上下文与一号位给的前提，这一步就要进 user 段（原来只在 N5 出现）", () => {
    const user = buildDraftUser({
      title: "首访维信诺怎么开",
      card: { subject: "维信诺", decision: true } as never,
      companyContext: "TKOS 是一套企业经营系统，连接战略、决策、执行与 Review。",
      userPremises: [{ text: "维信诺是 TKOS 的第一个客户", quote: "我们的TKOS的第一个客户是维信诺" }],
    });
    expect(user).toContain("企业经营系统");
    expect(user).toContain("维信诺是 TKOS 的第一个客户");
    expect(user).toContain("我们的TKOS的第一个客户是维信诺");
    // 来源身份保留：用户给的是研究前提，不是已核实的外部事实
    expect(user).toContain("用户提供");
    expect(user).toContain("不要把它们当成已经核过的外部事实");
  });

  it("没有公司上下文时不装作有：明说这一轮没有，我方的话一律写未知", () => {
    const user = buildDraftUser({ title: "t", card: { subject: "维信诺", decision: true } as never });
    expect(user).toContain("没有取到公司上下文");
    expect(user).not.toContain("一号位在提问里给定的前提");
  });

  it("把主体卡递进去", () => {
    const user = buildDraftUser({ title: "t", card: { subject: "维信诺", industry: "柔性 AMOLED" } as never });
    expect(user).toContain("维信诺");
    expect(user).toContain("柔性 AMOLED");
  });
});

/* ---- 前提与候选路线这两种行（2026-09-07，ISS-239）------------------------ */

const premiseLine = (o: Record<string, unknown>) => line({ type: "draft_premise", ...o });
const routeLine = (o: Record<string, unknown>) => line({ type: "draft_route", ...o });

const FIVE = PREMISE_FIELDS.map((f, i) =>
  premiseLine({
    id: `P${i + 1}`,
    field: f,
    statement: f === "我方已实现能力" ? "闭环已上线，有真实运行记录" : "未知",
    source: f === "我方已实现能力" ? "公司上下文 · 产品说明" : "",
    standing: f === "我方已实现能力" ? "材料记载" : "未知",
    ...(f === "我方已实现能力" ? { stage: "当前已实现" } : {}),
  })
);

const ROUTE_OK = {
  id: "R1",
  claim: "先做一次低成本的问题澄清",
  fit: "踩在已上线的经营闭环上",
  clientCondition: "对方肯让业务负责人到场",
  payoff: "拿到一句能复述的客户问题",
  dependsOn: ["P1"],
  switchWhen: "对方直接要报价就换一条",
};

describe("草稿里的前提与候选路线", () => {
  it("两种行都进各自那一栏；共用一个 id 命名空间，重号的整条拒并留账", () => {
    const r = parseDraft([full, ...FIVE, routeLine(ROUTE_OK), routeLine({ ...ROUTE_OK, id: "P1" })].join("\n"));
    expect(r.draft.premises).toHaveLength(5);
    expect(r.draft.routes).toHaveLength(1);
    expect(r.draft.premises?.[0].stage).toBe("当前已实现");
    expect(r.bad).toHaveLength(1);
    expect(r.bad[0].why).toContain("重");
  });

  it("规划中的能力一路传到 draft 上还是规划中", () => {
    const r = parseDraft(premiseLine({ id: "P1", field: "我方已实现能力", statement: "良率分析", stage: "规划中" }));
    expect(r.draft.premises?.[0].stage).toBe("规划中");
    // 没标阶段的能力落「未知」，不是「当前已实现」
    const bare = parseDraft(premiseLine({ id: "P2", field: "可演示场景", statement: "离线复现" }));
    expect(bare.draft.premises?.[0].stage).toBe("未知");
  });

  it("坏掉的那一条只丢它自己，理由进 bad —— 不静默", () => {
    const r = parseDraft([premiseLine({ id: "", field: "此次目标", statement: "x" }), routeLine({ id: "R2" })].join("\n"));
    expect(r.draft.premises).toHaveLength(0);
    expect(r.draft.routes).toHaveLength(0);
    expect(r.bad.map((b) => b.why).join("")).toContain("id");
    expect(r.bad.map((b) => b.why).join("")).toContain("主张");
  });

  it("决策题才查这两样：行业题上五栏全缺也不报", () => {
    const decisionGaps = draftGaps(parseDraft(full).draft, { decision: true }).join("");
    expect(decisionGaps).toContain("我方已实现能力");
    expect(decisionGaps).toContain("候选路线一条都没有");
    expect(draftGaps(parseDraft(full).draft).join("")).not.toContain("候选路线");
  });

  it("五栏齐、一条路线站得住 —— 这两样不再报缺口", () => {
    const r = parseDraft([full, ...FIVE, routeLine(ROUTE_OK)].join("\n"));
    const gaps = draftGaps(r.draft, { decision: true });
    expect(gaps.filter((g) => g.includes("前提") || g.includes("路线"))).toEqual([]);
    // 至多三条是上限不是指标：一条也不报「不足」
    expect(gaps.join("")).not.toContain(`超过 ${ROUTE_MAX}`);
  });

  it("给了这一轮的真实输入，才查「引的那句原话是不是编的」", () => {
    const faked = parseDraft(
      [
        ...FIVE.slice(1),
        premiseLine({
          id: "P1",
          field: "我方已实现能力",
          statement: "能做工艺缺陷分析",
          source: "一号位原话「我们做过良率优化」",
          standing: "用户提供",
          stage: "当前已实现",
        }),
        routeLine(ROUTE_OK),
      ].join("\n")
    ).draft;
    expect(draftGaps(faked, { decision: true, corpus: "首访该怎么开？" }).join("")).toContain("找不到");
    expect(draftGaps(faked, { decision: true }).join("")).not.toContain("找不到");
  });
});

const card = { subject: "维信诺" } as never;
const draftUser = (judgments: { id: string; statement: string; standing: string }[]) =>
  buildDraftUser({ title: "t", card, judgments: judgments as never });

describe("在版判断当前提", () => {
  it("一条都没有时不多出这一段", () => {
    expect(buildDraftUser({ title: "t", card })).not.toContain("公司已经有的判断");
    expect(draftUser([])).not.toContain("公司已经有的判断");
  });

  it("三种认知状态分三栏，各自说清怎么用", () => {
    const user = draftUser([
      { id: "01-J2", statement: "架构能力即壁垒", standing: "confirmed" },
      { id: "01-J3", statement: "统一算力池是灯塔项目的前提", standing: "shaking" },
      { id: "01-J4", statement: "客户会自己搭一套", standing: "unverified" },
      { id: "01-J5", statement: "自建机房", standing: "dropped" },
    ]);
    // 已确认的当前提：这一步不重新论证
    expect(user).toContain("01-J2");
    expect(user).toContain("不要在这一步再论证一遍");
    // 动摇与未验证的合成一栏，而且要落成断言 —— 这一栏是「让公司已知的事参与选题」的全部机制
    expect(user).toContain("01-J3（正在动摇）");
    expect(user).toContain("01-J4（未验证）");
    expect(user).toContain("loadBearing");
    // 放弃过的：别再推荐
    expect(user).toContain("01-J5");
    expect(user).toContain("不要在草稿里重新推荐");
  });

  it("认不出的状态归到「该查的」那一栏，不悄悄升成公司口径", () => {
    const user = draftUser([{ id: "01-J9", statement: "来路不明", standing: "某个新状态" }]);
    const doubt = user.indexOf("公司自己也没把握");
    expect(doubt).toBeGreaterThan(-1);
    expect(user.indexOf("01-J9")).toBeGreaterThan(doubt);
    // 没有已确认的那一条，那一栏就整栏不出现 —— 空栏会被读成「公司一条口径都没有」
    expect(user).not.toContain("已确认的口径");
  });

  it("每栏封顶五条，超出的说明还有几条", () => {
    const many = Array.from({ length: 8 }, (_, i) => ({
      id: `01-J${i}`,
      statement: `第 ${i} 条`,
      standing: "confirmed",
    }));
    const user = draftUser(many);
    expect(user).toContain("01-J4");
    expect(user).not.toContain("01-J5");
    expect(user).toContain("另有 3 条未列出");
  });

  it("过长的判断截断 —— N1 的输出额度是含思考的，输入不许无上限地长", () => {
    const long = "很".repeat(200);
    const user = draftUser([{ id: "01-J1", statement: long, standing: "confirmed" }]);
    expect(user).toContain("…");
    expect(user).not.toContain(long);
  });
});
