import { describe, expect, it } from "vitest";

import { fixtureReport } from "@/lib/agent/a4/blocks/fixture";
import type { ResearchDoc } from "@/lib/data/types";

import { buildA5User, type A5Input } from "./prompt";

const doc: ResearchDoc = {
  issueId: "ISS-D4",
  judgment: [
    {
      text: "企业 AI 的下一阶段不只是提高智能水平，而是企业愿意交出多少真实工作。",
      traces: [{ kind: "int", source: "《Oasis 管理层研究版》", href: "/docs/DOC-D4" }],
    },
  ],
  keyEvidence: [{ text: "78% 的组织还没有 AI 身份的创建与注销政策。", traces: [{ kind: "ext", source: "CSA / Oasis 2026" }] }],
  counters: [{ text: "通用身份与安全能力正在快速成熟，这条判断可能只在窗口期成立。", traces: [] }],
  unknowns: [{ text: "客户到底卡在授权还是卡在效果，需要一个真实场景才能回答。", traces: [] }],
  routeSuggestion: "建议取证再议，因为关键事实要在一个真实客户场景里才拿得到。",
  byAgentLabel: "您的 Agent",
  assembledFrom: [],
};

const INPUT: A5Input = {
  issueId: "ISS-D4",
  title: "企业是否敢把真实工作交给 AI",
  doc,
  judgments: [],
  existing: [],
};

describe("A5 判断生成的 user 段", () => {
  it("报告四节都递过去，每条带上它自己的溯源短码", () => {
    // 不带溯源的话，模型没法写「依据是 DOC-D4」—— 它在报告里看不见 DOC-D4 挂在哪条上。
    const u = buildA5User(INPUT);
    for (const s of ["深研给出的当前判断", "关键 Evidence", "反证与风险", "不确定性", "建议分流"]) {
      expect(u, s).toContain(s);
    }
    expect(u).toContain("（来源：《Oasis 管理层研究版》）");
  });

  it("板上已有的判断原样列出，并要求不重复", () => {
    /*
     * 不列的话模型会换个措辞再写一遍：板上的去重按正文前 30 字判，换了措辞就躲过去，
     * 于是板上出现两条读起来一样的判断；躲不过的会被静默丢掉，表现成「只生成了两条」。
     */
    const u = buildA5User({ ...INPUT, existing: ["现阶段不新增独立安全产品线。"] });
    expect(u).toContain("现阶段不新增独立安全产品线。");
    expect(u).toContain("这几条不要重复");
  });

  it("在版判断为空时整段不出现，不留占位", () => {
    expect(buildA5User(INPUT)).not.toContain("正在动摇的在版判断");
  });

  it("输出形状是最后读到的东西", () => {
    // 顺序就是约束：材料在前、形状在后，模型最后读到的才是真正要交的东西。
    const u = buildA5User({ ...INPUT, existing: ["已有的一条"] });
    expect(u.indexOf("判断板上已经有的")).toBeLessThan(u.indexOf("## 输出"));
    expect(u.indexOf("## 输出")).toBeLessThan(u.indexOf("judgements"));
  });
});

describe("区块那一支多读的两节", () => {
  const withBlocks = { ...INPUT, doc: { ...doc, blocks: fixtureReport() } };

  it("旧报告没有 blocks 时整段不出现，不留占位", () => {
    // 凭空多一句「本轮没有区块」只会让它以为该自己补几个出来。
    const u = buildA5User(INPUT);
    expect(u).not.toContain("判断的原件");
    expect(u).not.toContain("对不上的地方");
  });

  it("判断原件带上四节里折没了的那两栏", () => {
    /*
     * 边界和重开条件就是从这两栏长出来的：`falsifyCondition` 在四节里被折进「反证与风险」
     * 的某一句，`upgradeCondition` 压根没有对应的一节。只读四节等于读摘要的摘要。
     */
    const u = buildA5User(withBlocks);
    expect(u).toContain("## 报告里那几条判断的原件");
    expect(u).toContain("这一轮算力中心的瓶颈在上架与调度，不在卡的供给");
    expect(u).toContain("什么会推翻它：出现一组样本显示上架率与有效产出同步高于八成");
    expect(u).toContain("什么会让它升一档：");
    expect(u).toContain("把握：较强支持");
    expect(u).toContain("什么内部数据能裁决它：");
  });

  it("说清两面对不上时以原件为准", () => {
    // 四节是这些块压出来的一面。不说清的话，同一条判断有两个版本而看不出听哪一份。
    expect(buildA5User(withBlocks)).toContain("以这里为准");
  });

  it("分歧那几处摊出来，并且明令不许写成判断", () => {
    /*
     * 几条链路对不上的地方是「我们还不知道」。写成一条判断就是把研究里的空白包装成公司口径 ——
     * 而屏幕上它和真判断长得一模一样。
     */
    const u = buildA5User(withBlocks);
    expect(u).toContain("## 各条链路对不上的地方");
    expect(u).toContain("可调度到有效产出之间的掉量");
    expect(u).toContain("DeepSeek：需求侧不足是主因");
    expect(u).toContain("**这几处一处都不要写成判断。**");
    expect(u).toContain("当前边界");
    expect(u).toContain("重开条件");
  });

  it("摆在四节之后、输出形状之前", () => {
    // 先读压缩面再读原件，读到差别才知道该以哪一面为准；形状仍旧是最后读到的东西。
    const u = buildA5User(withBlocks);
    expect(u.indexOf("反证与风险")).toBeLessThan(u.indexOf("判断的原件"));
    expect(u.indexOf("判断的原件")).toBeLessThan(u.indexOf("对不上的地方"));
    expect(u.indexOf("对不上的地方")).toBeLessThan(u.indexOf("## 输出"));
  });

  it("一个判断块和分歧块都没有的那一份，整段也不出现", () => {
    const bare = { ...fixtureReport(), blocks: [] };
    expect(buildA5User({ ...INPUT, doc: { ...doc, blocks: bare } })).not.toContain("判断的原件");
  });
});
