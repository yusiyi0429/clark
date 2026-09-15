import { createHash } from "node:crypto";

import { describe, expect, it } from "vitest";

import type { Evidence } from "@/lib/research/ledger";

import {
  A4_DIVERGENCE_SYSTEM,
  a4ClosingSystem,
  a4OutlineSystem,
  a4ReportBlocksSystem,
  a4ReportSystem,
  a4SectionSystem,
  buildA4BlockRepair,
  buildA4ClosingUser,
  buildA4DivergenceUser,
  buildA4DigestUser,
  buildA4OutlineUser,
  buildA4ReportBlocksUser,
  buildA4ReportUser,
  buildA4SectionUser,
  buildA4SectionUserParts,
  buildEvidencePack,
  buildUnresolved,
  type A4Input,
  type A4OutlineSection,
} from "./prompt";
import type { Proposition, Verdict } from "./props";

const INPUT: A4Input = {
  issueId: "ISS-003",
  title: "要不要自建交付团队",
  scope: null,
  preTake: null,
  preOpenQuestions: [],
  judgments: [],
};

/** 报告那一层的 user 段现在多两个入参，测试里默认给空 —— 空串就是「本轮没有台账」。 */
const reportUser = (o: Partial<Parameters<typeof buildA4ReportUser>[0]> = {}) =>
  buildA4ReportUser({ ...INPUT, companyContext: "Y", cognitive: "", evidencePack: "", unresolved: "", ...o });

const ENTRY: Evidence = {
  id: "E1",
  propositionId: "P1",
  claim: "示例口径下算力规模为 1590 EFLOPS",
  exactQuote: "示例数值为 1590 EFLOPS",
  excerpt: "示例数值为 1590 EFLOPS",
  span: [10, 30],
  url: "https://example0.com/a",
  sourceDomain: "example0.com",
  supportRelation: "supports",
  evidenceType: "statistic",
  authorityClass: "official_statistics",
  sourceTier: "A",
  usedAs: "current_state",
  value: 1590,
  unit: "EFLOPS",
  period: "2025-12-31",
  geography: "中国",
  contentHash: "abc",
  retrievedAt: "2026-08-25T00:00:00.000Z",
  verificationStatus: "span_matched",
  independenceGroup: "src:华东数据研究院",
};

describe("A4 报告那一层的 user 段", () => {
  it("认知段在上下文之后、输出格式之前", async () => {
    /*
     * 顺序就是约束。技能 §6 的 Output Contract（那份可署名分发的正式报告）现在就是
     * 报告这一层要交的东西，所以它排在「## 输出」前面 —— 模型最后读到的是那份东西
     * 的具体形状（第一行标题、之后每节 `## `），不是别的。
     */
    const u = reportUser({ companyContext: "【公司经营状态】Y", cognitive: "S03 技能正文" });
    expect(u.indexOf("【公司经营状态】Y")).toBeLessThan(u.indexOf("S03 技能正文"));
    expect(u.indexOf("S03 技能正文")).toBeLessThan(u.indexOf("## 输出"));
  });

  it("认知段为空时整段不出现，不留占位", async () => {
    // 凭空多一句「标准尚未提供」只会让模型以为它可以自己定标准。
    // 装没装上看 Run 记录里的 cognitiveSource。
    const u = reportUser({ cognitive: "   " });
    expect(u).not.toContain("深度研究该怎么做");
  });

  it("没有台账时不出现证据包那一节", async () => {
    // 空着的「证据包」标题比没有标题更糟：模型会以为证据在别处，然后自己补几条。
    const u = reportUser();
    expect(u).not.toContain("本轮取回的证据包");
    expect(u).not.toContain("本轮没能核实的");
  });

  it("有台账时证据包排在认知段之前", async () => {
    const u = reportUser({ evidencePack: "E1　【支持　A 级　example0.com】", cognitive: "S03 技能正文" });
    expect(u.indexOf("E1　【支持")).toBeLessThan(u.indexOf("S03 技能正文"));
  });
});

describe("报告那一层的 system 段分两支", () => {
  it("有证据那一支要编号、不提未联网", async () => {
    const s = a4ReportSystem(true);
    expect(s).toContain("[E编号]");
    // 这一支真的抓过页、逐字核过引句，写「未联网」是自我否认（validate 的 A4-R07 两头都查）。
    expect(s).not.toContain("未联网");
  });

  it("没证据那一支要求照实写明未联网", async () => {
    const s = a4ReportSystem(false);
    expect(s).toContain("未联网核验");
    expect(s).not.toContain("[E编号]");
  });

  it("两支共用骨架和文体规矩", async () => {
    // 两份各自维护会走形：某一支改了「章节标题本身就是判断」，另一支不会有人记得改。
    for (const s of [a4ReportSystem(true), a4ReportSystem(false)]) {
      expect(s).toContain("章节标题本身就是一条判断");
      expect(s).toContain("长度由论证的完整度决定，不设上限");
    }
  });

  it("§0 长度不设上限 —— 一个字数区间都不许再出现", async () => {
    /*
     * 钉的是「不要回到那道上限」。写「1800 到 3500 字」的时候，把证据用完和别超上限直接
     * 冲突，而冲突里赢的总是那个能数出来的 —— 模型会丢材料去凑那个区间。
     * 判定条件写成正则而不是断言那一句原话不在：换个写法（「三千字左右」「不超过 4000 字」）
     * 是同一个错，而断言原话不在的话它一条都拦不住。
     */
    for (const s of [a4ReportSystem(true), a4ReportBlocksSystem(true)]) {
      expect(s).not.toMatch(/\d{3,5}\s*(到|-|~|至)\s*\d{3,5}\s*字/);
      expect(s).not.toMatch(/(不超过|不多于|上限)[^\n]{0,6}\d{3,5}\s*字/);
    }
  });
});

describe("区块那一支的 system 段", () => {
  it("先说清交付形态：一行一个 JSON，第一行是元数据", async () => {
    const s = a4ReportBlocksSystem(true);
    expect(s).toContain("report_meta");
    // 形态排在块目录之前：「一行一个 JSON」读晚了，前面读到的都会被当成一篇文章的写法记住。
    expect(s.indexOf("## 交付形态")).toBeLessThan(s.indexOf("## 有哪些块"));
    expect(s).toContain("不要写代码块围栏");
  });

  it("不许写 HTML/CSS/JS，也不许在字段里写 markdown 记号", async () => {
    const s = a4ReportBlocksSystem(true);
    expect(s).toContain("HTML");
    expect(s).toContain("一个记号都不要写");
  });

  it("不让单条链路写分歧视图 —— 它看不到另外两条的立场", async () => {
    // 分歧视图由三条都写完之后那一步合出来（`a4.divergence`）。
    expect(a4ReportBlocksSystem(true)).not.toContain("divergence_view");
  });

  it("和文本那一支共用文体规矩与骨架那句话", async () => {
    for (const s of [a4ReportBlocksSystem(true), a4ReportBlocksSystem(false)]) {
      expect(s).toContain("章节标题本身就是一条判断");
      expect(s).toContain("长度由论证的完整度决定，不设上限");
    }
  });

  it("有没有台账，分支和文本那一支一致", async () => {
    expect(a4ReportBlocksSystem(true)).toContain("[E编号]");
    expect(a4ReportBlocksSystem(false)).toContain("未联网核验");
    expect(a4ReportBlocksSystem(false)).not.toContain("[E编号]");
  });

  it("§6⑤ 文本那一支一个字都不知道 JSONL 这件事", async () => {
    // 开关关掉时旧格式完全不受影响，靠的就是这两支互不引用。
    for (const s of [a4ReportSystem(true), a4ReportSystem(false)]) {
      expect(s).not.toContain("JSONL");
      expect(s).not.toContain("report_meta");
    }
  });

  it("材料和文本那一支一字不差，只有最后那节输出不同", async () => {
    const material = { ...INPUT, companyContext: "Y", cognitive: "S03", evidencePack: "E1　…", unresolved: "" };
    const a = buildA4ReportUser(material);
    const b = buildA4ReportBlocksUser(material);
    const cut = (u: string) => u.slice(0, u.lastIndexOf("## 输出"));
    expect(cut(b)).toBe(cut(a));
    expect(b).toContain("只输出 JSONL");
  });
});

describe("分节出稿那三段（补遗 §1）", () => {
  const SECTION: A4OutlineSection = {
    id: "S2",
    title: "上架率是可修的，调度不是",
    question: "这两件事各差在哪",
    evidenceIds: ["E1", "E3"],
    expectedBlocks: ["kpi_cards", "prose"],
    minBlocks: 4,
  };
  const material = { ...INPUT, companyContext: "Y", cognitive: "S03", evidencePack: "E1　…", unresolved: "" };

  it("大纲那一次说清它不写报告，而且分配是唯一的硬账", async () => {
    const s = a4OutlineSystem(true);
    expect(s).toContain("规划报告结构，不是写报告");
    expect(s).toContain("两者之外不许有第三种去处");
    /*
     * 2026-08-31 翻过来的口径：原来写「禁止规划没有证据支撑的章节」，于是零证据的那几轮
     * 一节都排不出来、大纲折成一节、报告塌成一篇材料盘点。现在章节按论证的需要排，
     * 靠推理写的那一节照排 —— 钉住这句话，也钉住那句禁令没有回来。
     */
    expect(s).toContain("章节按论证的需要排，不按证据的多少排");
    expect(s).not.toContain("禁止规划没有证据支撑的章节");
  });

  it("收口那几种块不许排进小节 —— 排进去会出现两个核心判断横幅", async () => {
    const s = a4OutlineSystem(true);
    for (const t of ["verdict_banner", "falsify_card", "unverified_panel", "evidence_list", "evidence_usage"]) {
      expect(s).toContain(t);
    }
    expect(s).toContain("不要排进任何一节");
  });

  it("分节那一次的四条硬规则一条不少，而块数下限不在 system 段里", async () => {
    const s = a4SectionSystem({ hasEvidence: true });
    expect(s).toContain("检索到的数据行必须全部入表");
    expect(s).toContain("不得重复展开，只可引用");
    /*
     * 篇幅从「没有上限」改成了一个预算（2026-09-03，见 `hardRules` 上那段）。这里盯两样：
     * 预算真的进了 system 段，而**该保的三样仍旧明写着不许压** —— 只留一个字数会把这一步
     * 从「写得紧一点」变成「证据少就少写」，而那正是撤掉上一版字数闸时要躲开的事。
     */
    expect(s).toContain("最多不超过 2500 字"); // 2026-09-04 从 4500 压到 2500，见 SECTION_BUDGET
    expect(s).toContain("一个字都不许压");
    expect(s).toContain("证据少要写的仍然是推理");
    // 节尾那一行是本节的账；合成整份那一张由代码做（`blocks/stages.ts`）。
    expect(s).toContain("不要写别节的编号");
    // 块数下限逐节不同，写进 system 会毁掉缓存前缀 —— 见下一条。它在 user 段里。
    expect(s).not.toContain("本节至少输出 4 个区块");
    expect(buildA4SectionUser({ ...material, section: SECTION, thesisDraft: "x", written: "" }))
      .toContain(`最少块数：${SECTION.minBlocks}`);
  });

  /**
   * 缓存能不能命中就靠这一条。Anthropic 的缓存前缀**从 system 算起**，所以 system 段里只要
   * 掺进一个随节变的字（节号、这一节的块数下限），四节就是四份互不相同的前缀，后面无论怎么
   * 打断点都一次也命不中 —— 而那件事不报错，只体现在账单上。
   */
  it("写四节那几次的 system 段逐字节相同 —— 缓存前缀的前提", async () => {
    const two = [
      { ...SECTION, id: "S1", title: "第一节", minBlocks: 3 },
      { ...SECTION, id: "S4", title: "第四节", minBlocks: 7 },
    ];
    const [a, b] = two.map(() => a4SectionSystem({ hasEvidence: true }));
    expect(a).toBe(b);
    for (const sec of two) expect(a).not.toContain(sec.id);
  });

  /**
   * 断点打在 `stable` 末尾，所以 `stable` 里**一个随节变的字都不能有**。这一条把它钉住：
   * 两节的 `stable` 必须逐字节相同，而按节切片的证据包必须落在后半段。
   */
  it("分节 user 段拆出来的稳定前缀逐节相同，证据包在后半段", async () => {
    const mk = (id: string, pack: string) =>
      buildA4SectionUserParts({
        ...material,
        evidencePack: pack,
        section: { ...SECTION, id, title: `第 ${id} 节` },
        thesisDraft: "草稿那句话",
        written: id === "S1" ? "" : "S1 写过的要点",
      });
    const a = mk("S1", "E1 这一节分到的那条");
    const b = mk("S4", "E9 另一节分到的那条");
    expect(a.stable).toBe(b.stable);
    expect(a.stable).not.toContain("E1 这一节分到的那条");
    expect(a.rest).toContain("E1 这一节分到的那条");
    expect(b.rest).toContain("E9 另一节分到的那条");
    // 拼回去仍旧是从前那一份，逐字节。
    expect([a.stable, a.rest].join("\n\n")).toBe(
      buildA4SectionUser({
        ...material,
        evidencePack: "E1 这一节分到的那条",
        section: { ...SECTION, id: "S1", title: "第 S1 节" },
        thesisDraft: "草稿那句话",
        written: "",
      })
    );
  });

  it("硬规则第 2 条里那对引号是「」，不是 ASCII 的", async () => {
    /*
     * 补遗 §2.2 的原话里那一处是 ASCII 双引号。照抄下来的问题不是难看：同一份提示词
     * 下面写着「一个 ASCII 双引号都不要写进文字里」（每一行是一个 JSON，裸的 " 会把
     * 那一行弄坏，坏掉的那一块整块不出现在屏幕上），而模型照抄的是提示词自己的写法。
     * JSON 例子里的引号照旧是 ASCII 的 —— 那是 JSON 语法，不是中文行文。
     */
    const s = a4SectionSystem({ hasEvidence: true });
    expect(s).toContain("不允许「节选部分数据」");
    expect(s).not.toContain(`不允许"节选部分数据"`);
    expect(s).toContain("一个 ASCII 双引号都不要写进文字里");
  });

  it("分节的 user 段：这一节的规格排在材料之后、输出之前", async () => {
    const u = buildA4SectionUser({ ...material, section: SECTION, thesisDraft: "草稿那句话", written: "" });
    expect(u.indexOf("E1　…")).toBeLessThan(u.indexOf("要写的这一节"));
    expect(u.indexOf("要写的这一节")).toBeLessThan(u.indexOf("## 输出"));
    expect(u).toContain("S2");
    expect(u).toContain("上架率是可修的，调度不是");
    expect(u).toContain("E1、E3");
    expect(u).toContain("这是最先写的一节，前面没有内容");
    expect(u).toContain("不要 report_meta");
  });

  it("往下一节递的是要点，并且明说不要再展开一遍", async () => {
    // 递正文的话到第五节时前四节比证据还长，而模型会顺着前文写，不照自己那几条证据写。
    const u = buildA4SectionUser({
      ...material,
      section: SECTION,
      thesisDraft: "草稿",
      written: "S1　装机在涨\n　· 上架率 62%",
    });
    expect(u).toContain("上架率 62%");
    expect(u).toContain("不要再展开一遍");
  });

  it("收口那一次不许引入新证据，标题打架时改标题不改各节", async () => {
    const s = a4ClosingSystem(true);
    expect(s).toContain("不引入新证据");
    expect(s).toContain("改标题，不是改各节");
    // 置信取最高那一条的话，一份最弱一档撑着的报告会以「接近确证」上判断板。
    expect(s).toContain("不要取最高那一条");
  });

  it("收口不写分歧视图 —— 它只看得见自己这一条链路", async () => {
    // 补遗 §1 把它列在收口的产物里，这一处有意不照办；理由在 `a4ClosingSystem` 的注释上。
    expect(a4ClosingSystem(true)).not.toContain("divergence_view");
  });

  it("收口不写分歧视图（决策题那一支也一样）", async () => {
    expect(a4ClosingSystem(true, false, true)).not.toContain("divergence_view");
  });

  it("收口的 user 段递要点、判断和那张账，不递各节正文", async () => {
    const u = buildA4ClosingUser({
      ...material,
      thesisDraft: "草稿那句话",
      written: "S1　装机在涨",
      sectionJudgments: `{"type":"judgment","claim":"瓶颈在上架"}`,
      usage: "用上了：E1、E2",
    });
    expect(u).toContain("各节交上来的判断（原样）");
    expect(u).toContain("瓶颈在上架");
    expect(u).toContain("用上了：E1、E2");
    expect(u).toContain("第一行 report_meta");
  });

  it("公司既有判断那一段不会被本轮各节的判断顶掉", async () => {
    /*
     * 两个字段都叫 `judgments` 的时候，后写的那个会把 `a4ReportMaterialParts` 渲染的
     * 公司既有判断整段替掉 —— 而屏幕上什么都不显示。所以收口那一栏叫 `sectionJudgments`。
     */
    const withCompany = {
      ...material,
      judgments: [{ id: "J-1", statement: "我们赌的是交付侧", standing: "unverified" as const }],
    };
    const u = buildA4ClosingUser({
      ...withCompany,
      thesisDraft: "草稿",
      written: "S1",
      sectionJudgments: `{"type":"judgment","claim":"本轮这一条"}`,
      usage: "用上了：E1",
    });
    expect(u).toContain("我们赌的是交付侧");
    expect(u).toContain("本轮这一条");
  });

  it("三段的材料段和单次出稿那一支一字不差", async () => {
    // 三份各自维护会走形：改了公司经营状态那一段的渲染，另外三处不会有人记得改。
    const cut = (u: string) => u.slice(0, u.indexOf("## 输出"));
    const a = cut(buildA4ReportBlocksUser(material));
    expect(cut(buildA4OutlineUser(material))).toBe(a);
    expect(
      cut(buildA4SectionUser({ ...material, section: SECTION, thesisDraft: "草稿", written: "" })).startsWith(a)
    ).toBe(true);
  });
});

/**
 * 决断包（ISS-238）。代价全在**分叉**上：决策题多一块、预算多四百字、节数少两节，
 * 而行业题一个字都不该变。
 *
 * 2026-09-07 改了它的地位（不再是一级产物、可以不交），下面那几条硬约束一条没动 ——
 * 交上来的那一份该长什么样，和「要不要交」是两件事。
 */
describe("决断包：只有决策题的收口才交", () => {
  const decision = () => a4ClosingSystem(true, false, true);
  const industry = () => a4ClosingSystem(true, false, false);

  it("决策题的收口交第八块，行业题连提都不提", async () => {
    expect(decision()).toContain("第八块：决断包（command_brief）");
    expect(decision()).toContain("8. **command_brief**");
    expect(industry()).not.toContain("第八块");
    expect(industry()).not.toContain("8. **command_brief**");
  });

  it("硬约束一条不少：唯一主张、各 ≤3、改令与终止、态势只收会改变行动的事实", async () => {
    const s = decision();
    expect(s).toContain("**唯一主张。**");
    expect(s).toContain("各最多 3 条");
    expect(s).toContain("**必有改令触发与终止条件。**");
    expect(s).toContain("会改变行动");
  });

  it("参谋的推断标成判断，不许摆进态势冒充事实", async () => {
    expect(decision()).toContain("推断标成判断，不冒充事实");
    expect(decision()).toContain("`situation` 里只放绑得上编号");
  });

  it("关键事实没核实的转成一条现场核验命令，不是再写一节", async () => {
    // 他缺的不是又一段「这一条待核」的分析，是谁去核、什么时候回话、拿回什么算核完了。
    expect(decision()).toContain("转成一条现场核验命令，不要再写一节");
  });

  /**
   * 这一条是这一整块里最要紧的。本体现在没有人员名册（只有一千五百字的公司层叙述），
   * 让模型填 DRI 它一定会填一个像样的名字 —— 一个不存在的人，或者一个真名被派了一件他
   * 不知道的活。这类幻觉读起来完全正常，只有当事人自己看得出不对。
   */
  it("命令只写角色，一个人名都不许写，也没有填人的字段", async () => {
    const s = decision();
    expect(s).toContain("命令只写角色或领域");
    expect(s).toContain("一个人名都不要写，也没有填人的字段");
    expect(s).toContain("DRI 由一号位或秘书在批准时指定");
    // 形状里也不许有这一栏 —— 有了它，上面那句话就成了一条没人守的规矩。
    expect(s).not.toContain("driId");
  });

  it("块目录改了口径：十五种，最后那一种只在决策题的收口交", async () => {
    for (const s of [a4ReportBlocksSystem(true), a4SectionSystem({ hasEvidence: true }), decision()]) {
      expect(s).toContain("十五种，一种都不许自创");
      expect(s).toContain("command_brief 只在决策题的收口那一次交");
    }
  });

  it("分节和排结构那两次明说不要写它", async () => {
    expect(a4SectionSystem({ hasEvidence: true, decision: true })).toContain("一行都不要写");
    expect(a4OutlineSystem(true, false, true)).toContain("command_brief（决断包）");
    expect(a4OutlineSystem(true, false, true)).toContain("不要排进任何一节");
  });

  it("收口的预算按题型给：决策题多四百字装第八块，行业题一个字不加", async () => {
    // 给同一个数的结果只有一种：要么行业题白得四百字去复述各节，要么决策题在写决断包的
    // 半路上撞预算 —— 而撞了之后先被压掉的正是排在后面的「拍错了怎么退」「什么会改令」。
    expect(decision()).toContain("1200 字上下（八块加起来）");
    expect(decision()).toContain("最多不超过 1600 字");
    expect(industry()).toContain("800 字上下（七块加起来）");
    expect(industry()).toContain("最多不超过 1200 字");
  });
});

describe("决策题瘦身（ISS-238）", () => {
  it("分节预算：决策题 900/1500，行业题照旧 1500/2500", async () => {
    const d = a4SectionSystem({ hasEvidence: true, decision: true });
    expect(d).toContain("900 字上下，最多不超过 1500 字");
    expect(d).not.toContain("最多不超过 2500 字");
    expect(a4SectionSystem({ hasEvidence: true })).toContain("最多不超过 2500 字");
  });

  it("砍的是输出不是额度：预算旁边那三样仍旧一个字都不许压", async () => {
    // `SECTION_OUT_TOKENS` 那 12000 是给推理留的呼吸（6000 时 S1 一个字没写出来），
    // 和篇幅预算管的不是一件事。这里钉住「压篇幅没有顺手把该保的三样一起压掉」。
    const d = a4SectionSystem({ hasEvidence: true, decision: true });
    expect(d).toContain("一个字都不许压");
    expect(d).toContain("证据少要写的仍然是推理");
    expect(d).toContain("检索到的数据行必须全部入表");
  });

  it("大纲：决策题 2 到 3 节、一节至少 1 个块；行业题照旧 3 到 5 节、至少 2 个", async () => {
    const d = a4OutlineSystem(true, false, true);
    expect(d).toContain("**节数 2 到 3 节**");
    expect(d).toContain("一节至少 1 个块");
    expect(d).not.toContain("节数 3 到 5 节");
    const i = a4OutlineSystem(true, false, false);
    expect(i).toContain("节数 3 到 5 节");
    expect(i).toContain("一节至少 2 个块");
    expect(i).not.toContain("节数 2 到 3 节");
  });

  it("决策题的一级产物是当前判断，不是那一屏决断包（2026-09-07 推翻上一版）", async () => {
    for (const s of [a4OutlineSystem(true, false, true), a4SectionSystem({ hasEvidence: true, decision: true })]) {
      expect(s).toContain("一级产物是你现在的判断");
      // 上一版那两句：一屏决断包是一级产物、正文退成情报附件。两句都不许再出现。
      expect(s).not.toContain("一级产物是最后收口交的那一屏决断包");
      expect(s).not.toContain("正文这几节是他想追问某一条时才翻的");
      expect(s).not.toContain("下面这些节是他想追问某一条时才翻的");
    }
    /*
     * **`BLOCK_CATALOG` 里那一行还留着「一号位默认只看它……情报附件」，是有意的**：那份目录
     * 三次调用共用，改它会把行业题那三支也改掉，而这一轮它们要逐字节不动（下面那条哈希）。
     * 代价是决策题的收口同时读到两种口径，所以收口那一节明写「以这一节为准」—— 这里钉住
     * 那句话真的在（少了它，留在目录里的旧口径就成了唯一的口径）。
     */
    expect(a4ClosingSystem(true, false, true)).toContain("那是上一版的口径，**以这一节为准**");
    expect(a4OutlineSystem(true)).not.toContain("情报附件");
  });

  it("行业题这一整轮一个字都不该变", async () => {
    /*
     * 分叉最容易出的错不是决策题那一支写错，是**行业题被顺手改了**：那一支没有靶子，
     * 改坏了要等下一份行业报告出来才看得见。所以这三处逐字节对住。
     */
    expect(a4ClosingSystem(true, false, false)).toBe(a4ClosingSystem(true, false));
    expect(a4SectionSystem({ hasEvidence: true, decision: false })).toBe(a4SectionSystem({ hasEvidence: true }));
    expect(a4OutlineSystem(true, false, false)).toBe(a4OutlineSystem(true));
  });
});

/**
 * 2026-09-07：出稿形状从「决断包优先」改回「判断优先」。产品语义那一条是全部的要害 ——
 * **研究完成 ≠ 已经形成决议 ≠ 应该立即派发命令**（HANDOVER §1）。
 */
describe("判断优先（2026-09-07）", () => {
  const outline = () => a4OutlineSystem(true, false, true);
  const section = () => a4SectionSystem({ hasEvidence: true, decision: true });
  const closing = () => a4ClosingSystem(true, false, true);

  it("同题答案示例删干净了：三支提示词里不许再出现那句结论", async () => {
    /*
     * 「首访只谈验收口径，不报价」是真实测试题（ISS-239 维信诺首访）的结论，上一版把它写在
     * 章节标题的示例位上，而那一轮交回来的报告写的正是这句话（`质量评估.md` P0 第一条）。
     * 这里钉的是**生产提示词里没有它**；这句原话本身留在这条测试里当失败样本 ——
     * 为过测试删样本的话，下一个人加回去也没人拦得住。
     */
    const leak = "首访只谈验收口径，不报价";
    for (const s of [outline(), section(), closing(), a4ReportBlocksSystem(true), a4ReportSystem(true)]) {
      expect(s).not.toContain(leak);
      expect(s).not.toContain("不报价");
    }
  });

  it("决策题的形状是：当前判断 / 依据与成立条件 / 下一步要弄清的问题", async () => {
    for (const s of [outline(), section()]) {
      expect(s).toContain("第一节是当前判断");
      expect(s).toContain("末节是下一步要弄清的问题");
      expect(s).toContain("行动建议一律写成条件句");
      // 上一版的第一节是「要您定的事」，末节是「行动骨架」。
      expect(s).not.toContain("第一节是「要您定的事」");
    }
    expect(outline()).toContain("当前判断 / 依据与成立条件 / 下一步要弄清的问题");
  });

  it("研究完成不等于已经形成决议 —— 这句话要在提示词里", async () => {
    expect(outline()).toContain("研究做完不等于已经形成决议，更不等于现在就该派命令");
  });

  it("决断包退成可选：交不出就不交，缺它不是缺陷", async () => {
    const s = closing();
    expect(s).toContain("它不是这份报告的一级产物");
    expect(s).toContain("交不出有依据的行动，就整个不写这一块");
    expect(s).toContain("没有决断包的报告是合法的");
    expect(s).toContain("**这一块是可选的**");
    expect(s).not.toContain("这道题唯一的一级产物");
    expect(s).not.toContain("**它是一号位默认唯一会读的那一屏**");
  });

  it("排期三栏说清了：dueOn 只放确定日期，相对时间走 dueNote", async () => {
    const s = closing();
    expect(s).toContain("dueNote");
    expect(s).toContain("dueBasis");
    expect(s).toContain("说不出依据就把 `dueOn` 留空");
    expect(s).toContain("日期待定");
    expect(s).toContain("三栏都空着也是合法的");
  });

  it("刚性措辞、无依据承诺、Mission、前后一致 —— 四条都在决策题那三支里", async () => {
    for (const s of [outline(), section(), closing()]) {
      expect(s).toContain("输出的确定性不得超过已知信息");
      expect(s).toContain("不写比依据更强的话");
      expect(s).toContain("四步顺序不能换");
      expect(s).toContain("会前需核实");
      expect(s).toContain("检索不到某条 Mission，不等于公司没有它");
      expect(s).toContain("同一件事只有一个版本");
    }
  });

  /**
   * 行业题那三支这一轮**逐字节不动**。上面那条 `toBe` 只证明「decision 传不传都一样」，
   * 证明不了「和改之前一样」—— 两支一起改坏了它照样绿。所以这里钉的是改动前实测出来的哈希。
   *
   * 哪一天行业题那一支真的要改：跑一次这个测试，把它报出来的新哈希抄进来，并在提交信息里
   * 写清为什么。**不要因为它红了就把这条测试删掉** —— 它唯一的作用就是拦住顺手的那一改。
   */
  it("行业题那三支逐字节不动 —— 哈希钉住（2026-09-07 改动前实测）", async () => {
    const h = (s: string) => createHash("sha256").update(s, "utf8").digest("hex").slice(0, 16);
    expect(h(a4OutlineSystem(true, false, false))).toBe("550c3697679a2dea");
    expect(h(a4SectionSystem({ hasEvidence: true }))).toBe("89c90f0bdcc68142");
    expect(h(a4ClosingSystem(true, false, false))).toBe("9fc91f40aa3b6ba7");
    expect(h(a4ReportBlocksSystem(true))).toBe("0aba196997234b47");
    // 没有台账那一支和问自己家里事那一支也一起钉住。
    expect(h(a4OutlineSystem(false, false, false))).toBe("fd4ffe2a0b9f91cd");
    expect(h(a4SectionSystem({ hasEvidence: false }))).toBe("852915c29b1b9ed9");
    expect(h(a4ClosingSystem(false, false, false))).toBe("1cb73243940a7e7f");
    expect(h(a4ReportBlocksSystem(false))).toBe("a5ead758b432451c");
    expect(h(a4OutlineSystem(false, true, false))).toBe("d68154352f1a922a");
    expect(h(a4SectionSystem({ hasEvidence: false, inward: true }))).toBe("cf8c4397f3560e73");
    expect(h(a4ClosingSystem(false, true, false))).toBe("6f1f3ec30387e5ad");
  });
});

describe("区块返修那一轮", () => {
  const one = { at: 3, line: `{"type":"kpi_cards","cards":[]}`, why: "A4-B02 有卡没绑证据" };

  it("只列被拒的那几块，并且说明别的一个字不要动", async () => {
    const u = buildA4BlockRepair([one]);
    expect(u).toContain("第 1 块（这一份里的第 3 个块）");
    expect(u).toContain(one.line);
    expect(u).toContain("A4-B02");
    expect(u).toContain("已经过了");
    expect(u).toContain("一共 1 行");
    expect(u).toContain("不要 report_meta");
  });

  it("顺序这件事说两遍 —— 它是唯一的对齐方式", async () => {
    const u = buildA4BlockRepair([one, { ...one, at: 7 }]);
    expect(u.match(/顺序/g)?.length ?? 0).toBeGreaterThan(1);
    expect(u).toContain("一共 2 行");
  });

  it("报告级的那几条另起一节，并且不许为它新增一块", async () => {
    const u = buildA4BlockRepair([one], "A4-B06 引了证据表里没有的编号 E9");
    expect(u).toContain("整份报告的问题");
    expect(u).toContain("E9");
    expect(u).toContain("不要为它新增一块");
  });

  it("要重交元数据时行数加一，report_meta 从「不要写」变成「第一行」", async () => {
    const u = buildA4BlockRepair([one], undefined, true);
    expect(u).toContain("一共 2 行");
    expect(u).toContain("**第一行是 report_meta**");
    expect(u).not.toContain("不要 report_meta");
  });
});

describe("跨链路对账那一步", () => {
  it("说清它不综合、只找不一致", async () => {
    // 让它综合，出来的就是第四份报告；而屏幕上那块分歧视图要的是「哪一句对不上」。
    expect(A4_DIVERGENCE_SYSTEM).toContain("不是**综合出一份新结论");
    expect(A4_DIVERGENCE_SYSTEM).toContain("一处都没有是合法答案");
    expect(A4_DIVERGENCE_SYSTEM).toContain("编一处分歧比漏一处糟得多");
  });

  it("三分法四条出路一条不少，并且写明「欠定」不许配哪两种", async () => {
    for (const m of ["事实核查", "程序执行", "需内部数据", "先验判断"]) {
      expect(A4_DIVERGENCE_SYSTEM).toContain(`**${m}**`);
    }
    expect(A4_DIVERGENCE_SYSTEM).toContain("「欠定」不许配「事实核查」或「程序执行」");
  });

  it("链路只给代号，也不许写证据编号", async () => {
    /*
     * 这一次跑在 pro 上 —— 写了「DeepSeek」那一份的就是它，表上写着自己的名字时偏向
     * 哪一栏说不清；编号是每条链路自己台账里的，跨链路引过去会指到错的一页。
     */
    expect(A4_DIVERGENCE_SYSTEM).toContain("不要写模型的名字");
    expect(A4_DIVERGENCE_SYSTEM).toContain("不要写 `[E1]` 这种证据编号");
  });

  it("只许交这一种块，而且至少两方", async () => {
    expect(A4_DIVERGENCE_SYSTEM).toContain('"type":"divergence_view"');
    expect(A4_DIVERGENCE_SYSTEM).toContain("一方没有分歧");
    expect(A4_DIVERGENCE_SYSTEM).not.toContain("report_meta");
  });

  it("user 段最后读到的是「没有分歧」那条出路", async () => {
    const u = buildA4DivergenceUser({ issueId: "ISS-003", title: "要不要自建交付团队", stances: "### 链路甲\n…" });
    expect(u.indexOf("### 链路甲")).toBeLessThan(u.indexOf("## 输出"));
    expect(u).toContain("ISS-003");
    expect(u).toContain("「没有分歧」四个字");
  });
});

describe("证据包", () => {
  it("给引句和口径，不给原始网页", async () => {
    /*
     * 给了原始网页，写作那一层就会绕过引句去读上下文，然后写出引句撑不起的话 ——
     * 而出口对账只能核到引句这一层，那句话会一路过关。
     */
    const pack = buildEvidencePack([ENTRY]);
    expect(pack).toContain("E1");
    expect(pack).toContain("示例数值为 1590 EFLOPS");
    expect(pack).toContain("A 级");
    expect(pack).toContain("期间 2025-12-31");
    expect(pack).not.toContain("https://");
  });

  it("空台账返回空串", async () => {
    expect(buildEvidencePack([])).toBe("");
  });
});

describe("没能核实的那一段", () => {
  const p: Proposition = {
    id: "P2",
    statement: "另外两个行业同期也在降",
    requiredEvidence: "",
    queries: [],
    counterQueries: [],
    material: false,
    freshnessUrgent: false,
    extraRoundsCap: 1,
  };
  const tally = { propositionId: "P2", groups: 0, citableGroups: 0, ugcOnly: false };

  it("闭合了的不出现", async () => {
    const v: Verdict[] = [{ propositionId: "P2", ok: true, tally, unmet: [], terminal: "" }];
    expect(buildUnresolved([p], v)).toBe("");
  });

  it("没闭合的带上命题原话和差在哪", async () => {
    const v: Verdict[] = [
      { propositionId: "P2", ok: false, tally, unmet: ["一条来源都没找到"], terminal: "" },
    ];
    const out = buildUnresolved([p], v);
    // 不带命题编号：带了成稿会把它当证据编号引（ISS-208，A4-B06）
    expect(out).not.toContain("P2");
    expect(out).toContain("另外两个行业同期也在降");
    expect(out).toContain("一条来源都没找到");
  });

  it("落了终态的用终态那句话", async () => {
    const v: Verdict[] = [
      { propositionId: "P2", ok: false, tally, unmet: ["…"], terminal: "unknown_snapshot_gap" },
    ];
    expect(buildUnresolved([p], v)).toContain("本轮检索没有找到任何可用来源");
  });
});

describe("A4 压缩那一层的 user 段", () => {
  it("带的是报告正文和在版判断编号，不带任何原始材料", async () => {
    /*
     * 这一层的输入是**已经写成的报告**。把材料再塞一遍，等于给它一次绕过报告重新
     * 研究的机会 —— 而那正是两面结论对不上的来源。在版判断的编号清单要留着：traces
     * 里的短码得从它里面挑。
     */
    const u = buildA4DigestUser({
      issueId: "ISS-003",
      title: "要不要自建交付团队",
      report: "标题那句话\n\n## 核心判断\n\n当前更支持……",
      judgments: [{ id: "01-J2", statement: "交付先外包", standing: "unverified" }],
    });
    expect(u).toContain("## 核心判断");
    expect(u).toContain("01-J2");
    // 文档库那一栏整个不在了 —— 公司内部材料只从本体来（见 `A4Input` 上那段）。
    expect(u).not.toContain("可引用的内部文档");
    expect(u).not.toContain("/docs/");
  });
});
