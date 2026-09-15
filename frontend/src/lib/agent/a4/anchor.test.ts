import { describe, expect, it } from "vitest";
import { ANCHOR_SYSTEM, buildAnchorUser, cardGaps, compileCard } from "./anchor";

const raw = {
  subject: "维信诺",
  segments: [{ name: "柔性 AMOLED 手机面板", weight: "收入主体", lifecycle: "现金流" }],
  projects: [
    { name: "V5 第 8.6 代线", investment: "550 亿元", onlineAt: "2027", techRoute: "ViP 无掩膜光刻", heavy: true },
    { name: "车载模组扩产", investment: "8 亿元", onlineAt: "2026", techRoute: "现有", heavy: false },
  ],
  customers: "国产安卓品牌为主",
  industry: "柔性中小尺寸 AMOLED，正向 V5 第 8.6 代中尺寸扩张",
  window: "当前时点 ± 未来 3 年",
};

describe("主体卡编译", () => {
  it("照抄模型给的形状，缺的栏位落成空字符串而不是 undefined", () => {
    const card = compileCard({ subject: "某公司" });
    expect(card.subject).toBe("某公司");
    expect(card.industry).toBe("");
    expect(card.segments).toEqual([]);
    expect(card.projects).toEqual([]);
  });

  it("生命周期只认三档，写别的一律落到投入期", () => {
    const card = compileCard({ segments: [{ name: "x", weight: "y", lifecycle: "巅峰期" }] });
    expect(card.segments[0].lifecycle).toBe("投入期");
  });

  it("默认分析时间窗写死在代码里，模型不给就用它", () => {
    expect(compileCard({}).window).toContain("3 年");
  });

  it("问的是自己家里的事那一栏只认 true，缺省为假（2026-09-05，ISS-208）", () => {
    expect(compileCard({}).inward).toBe(false);
    expect(compileCard({ inward: "true" }).inward).toBe(false);
    expect(compileCard({ inward: true }).inward).toBe(true);
  });

  it("要一个决策那一栏只认 true，且与 inward 互斥（2026-09-05，R-11）", () => {
    expect(compileCard({}).decision).toBe(false);
    expect(compileCard({ decision: "true" }).decision).toBe(false);
    expect(compileCard({ decision: true }).decision).toBe(true);
    expect(compileCard({ decision: true, inward: true }).decision).toBe(false);
    expect(ANCHOR_SYSTEM).toContain('"decision":false');
  });

  it("官网规整成域名：去协议、去路径、去末尾斜杠、去 www.（2026-09-07，ISS-238）", () => {
    expect(compileCard({ website: "https://www.visionox.com/" }).website).toBe("visionox.com");
    expect(compileCard({ website: "http://visionox.com/investor/notice?x=1" }).website).toBe("visionox.com");
    expect(compileCard({ website: "  WWW.Visionox.COM  " }).website).toBe("visionox.com");
    expect(compileCard({ website: "ir.visionox.com.cn" }).website).toBe("ir.visionox.com.cn");
  });

  it("认不出域名形状的落空串 —— 拼出来的 site: 检索式不会报错，只会白发一次", () => {
    expect(compileCard({}).website).toBe("");
    expect(compileCard({ website: "维信诺官网" }).website).toBe("");
    expect(compileCard({ website: "无" }).website).toBe("");
    expect(compileCard({ website: 123 }).website).toBe("");
    expect(ANCHOR_SYSTEM).toContain('"website"');
  });

  it("点名了外部主体的题一律不是自己家里的事（ISS-233：同题被判 inward，零证据）", () => {
    const c = compileCard({ subject: "本公司", inward: true, decision: true, externalSubject: "维信诺" });
    expect(c.inward).toBe(false);
    expect(c.decision).toBe(true);
    expect(c.subject).toBe("维信诺");
    expect(compileCard({ inward: true, externalSubject: "" }).inward).toBe(true);
    expect(ANCHOR_SYSTEM).toContain("externalSubject");
  });
});

describe("主体卡的缺口", () => {
  it("填满了就没有缺口", () => {
    expect(cardGaps(compileCard(raw))).toEqual([]);
  });

  it("问自己家里的事时业务构成为空不算缺口", () => {
    const boundary = "验证看板要记哪几样才算证明了组织运行变了";
    expect(cardGaps(compileCard({ subject: "本公司", inward: true, industry: boundary }))).toEqual([]);
    expect(cardGaps(compileCard({ subject: "某公司", industry: boundary })).join("")).toContain("业务构成是空的");
  });

  it("重项目没进行业定义要报出来", () => {
    const bad = { ...raw, industry: "柔性中小尺寸 AMOLED" };
    const gaps = cardGaps(compileCard(bad));
    expect(gaps.join("")).toContain("V5 第 8.6 代线");
  });

  it("非重项目不进行业定义不算缺口", () => {
    const gaps = cardGaps(compileCard(raw));
    expect(gaps.join("")).not.toContain("车载模组");
  });

  it("行业定义写成泛类目要报出来", () => {
    const gaps = cardGaps(compileCard({ ...raw, industry: "显示面板行业", projects: [] }));
    expect(gaps.join("")).toContain("泛类目");
  });

  it("一个业务板块都没有要报出来", () => {
    expect(cardGaps(compileCard({ ...raw, segments: [] })).join("")).toContain("业务构成");
  });
});

describe("提示词", () => {
  it("说明白这一步只许检索主体的一手材料", () => {
    expect(ANCHOR_SYSTEM).toContain("一手");
    expect(ANCHOR_SYSTEM).toContain("不做行业面检索");
  });

  it("把议题原话和预研结论递进去", () => {
    const user = buildAnchorUser({ title: "维信诺所处的行业", scope: "只看面板主业", preTake: "预研说产能周期是关键" });
    expect(user).toContain("维信诺所处的行业");
    expect(user).toContain("只看面板主业");
    expect(user).toContain("预研说产能周期是关键");
  });

  it("预研没跑过时不留空标题", () => {
    expect(buildAnchorUser({ title: "t", scope: null, preTake: null })).not.toContain("预研");
  });
});
