import { describe, expect, it } from "vitest";

import { buildA3User, type A3Input } from "./prompt";

const INPUT: A3Input = {
  issueId: "ISS-003",
  title: "要不要自建交付团队",
  scope: null,
  material: null,
  judgments: [],
};

describe("A3 预研的 user 段", () => {
  it("认知段在上下文之后、输出格式之前", async () => {
    // 顺序就是约束：技能文档里的 Output Contract 是文本块（`Sharp Title：` 那种），
    // 和这里要的 JSON 冲突。它排在「## 输出」前面，模型最后读到的才是真正要交的形状。
    const u = buildA3User({ ...INPUT, companyContext: "【公司经营状态】Y", cognitive: "S02 技能正文" });
    expect(u.indexOf("【公司经营状态】Y")).toBeLessThan(u.indexOf("S02 技能正文"));
    expect(u.indexOf("S02 技能正文")).toBeLessThan(u.indexOf("## 输出"));
  });

  it("认知段为空时整段不出现，不留占位", async () => {
    // 凭空多一句「标准尚未提供」只会让模型以为它可以自己定标准。
    // 装没装上看 Run 记录里的 cognitiveSource。
    const u = buildA3User({ ...INPUT, companyContext: "Y", cognitive: "   " });
    expect(u).not.toContain("预研该怎么做");
  });

  it("递上来的原文排在公司上下文之前，而且明说不许为它编编号", async () => {
    /*
     * 顺序：它是这一轮唯一确定跟这条议题有关的材料，内部文档那一批是按域粗筛的。
     *
     * 后半句钉的是一个会自己长出来的坏法：A3-13（每条 Evidence 要有溯源）是 p0，
     * 而这段材料没有编号 —— prompt 里不写死用哪个标签，模型就会编一个 DOC- 出来过门，
     * 屏幕上渲染成一枚点不开的短码。
     */
    const u = buildA3User({
      ...INPUT,
      material: "成都的二手房抽佣从 2.5% 降到 2%。",
      companyContext: "【公司经营状态】Y",
      cognitive: "",
    });
    expect(u.indexOf("递上来的原文")).toBeLessThan(u.indexOf("【公司经营状态】Y"));
    expect(u).toContain("成都的二手房抽佣从 2.5% 降到 2%。");
    expect(u).toContain("不要为它编一个文档号或 href");
    expect(u).toContain("递上来的原文");
  });

  it("没有原文时整段不出现；截过的时候说清没读完", async () => {
    // 留一句「（无材料）」的后果和认知段那一条一样：模型会以为自己该去找材料，
    // 而它手上什么都没有，于是编。
    const bare = buildA3User({ ...INPUT, companyContext: "Y", cognitive: "" });
    expect(bare).not.toContain("递上来的原文");

    const cut = buildA3User({
      ...INPUT,
      material: "很长的一篇。",
      materialTruncated: true,
      companyContext: "Y",
      cognitive: "",
    });
    expect(cut).toContain("预研只读了这一段");
  });
});
