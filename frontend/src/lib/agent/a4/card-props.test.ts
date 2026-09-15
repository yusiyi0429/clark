import { describe, expect, it } from "vitest";
import type { SubjectCard } from "./anchor";
import { cardPropositions } from "./card-props";

const card: SubjectCard = {
  subject: "维信诺",
  inward: false,
  decision: false,
  segments: [
    { name: "柔性 AMOLED 中小尺寸", weight: "收入九成", lifecycle: "成长" },
    { name: "车载与 IT 面板", weight: "起步", lifecycle: "投入期" },
    { name: "第三块", weight: "", lifecycle: "现金流" },
  ],
  projects: [
    { name: "合肥 6 代柔性线", investment: "", onlineAt: "已投产", techRoute: "LTPO", heavy: false },
    { name: "合肥 8.6 代 AMOLED 产线", investment: "550 亿元", onlineAt: "2026 年", techRoute: "ViP 无金属掩膜", heavy: true },
    { name: "第三个项目", investment: "", onlineAt: "", techRoute: "", heavy: false },
  ],
  customers: "荣耀、小米为主，正在争取苹果供应链认证",
  website: "visionox.com",
  industry: "柔性中小尺寸 AMOLED，正向 8.6 代中尺寸扩张",
  window: "当前时点 ± 未来 3 年",
};

/** 钉住年份的那一天。用本地构造，`getFullYear()` 读的就是它。 */
const TODAY = new Date(2026, 8, 7);

describe("主体卡事实 → 第一优先命题", () => {
  it("最新披露排最前，然后是项目、板块、客户 —— 共八条", () => {
    const ps = cardPropositions(card, TODAY);
    expect(ps).toHaveLength(8);
    expect(ps.map((p) => p.id)).toEqual([
      "D8-F1",
      "D8-F2",
      "D8-F3",
      "D2-C1",
      "D2-C2",
      "D8-C1",
      "D8-C2",
      "D8-C3",
    ]);
    // F 系列和 C 系列各编各的号，不撞。
    expect(new Set(ps.map((p) => p.id)).size).toBe(ps.length);
  });

  it("权重过线的项目排在另一个项目前面", () => {
    const ps = cardPropositions(card, TODAY).filter((p) => p.id.startsWith("D2-"));
    expect(ps[0].statement).toContain("8.6 代");
    expect(ps[0].statement).toContain("550 亿元");
    expect(ps[0].material).toBe(true);
    expect(ps[1].material).toBe(false);
  });

  it("每条都有正向和反向问法，问法里带主体名 —— 不靠模型编", () => {
    for (const p of cardPropositions(card, TODAY)) {
      expect(p.queries.length).toBeGreaterThanOrEqual(2);
      expect(p.counterQueries).toHaveLength(1);
      expect(p.queries.every((q) => q.includes("维信诺"))).toBe(true);
      expect(p.sourceKinds.length).toBeGreaterThanOrEqual(1);
    }
  });

  it("同一张卡两次生成一模一样 —— 命题来源里这一半不再随写手变", () => {
    expect(cardPropositions(card, TODAY)).toEqual(cardPropositions(card, TODAY));
  });

  it("问自己家里的事没有外部主体，一条都不生成；没识别出主体也不生成", () => {
    expect(cardPropositions({ ...card, inward: true }, TODAY)).toEqual([]);
    expect(cardPropositions({ ...card, subject: "" }, TODAY)).toEqual([]);
  });

  it("卡上只有主体名时只剩最新披露那两条，不编项目", () => {
    const ps = cardPropositions({ ...card, segments: [], projects: [], customers: "", website: "" }, TODAY);
    expect(ps.map((p) => p.id)).toEqual(["D8-F1", "D8-F2"]);
  });
});

describe("最新披露那一类（ISS-238：拿 2024 年报下的判断）", () => {
  it("年份从传进来的日期算，不从模型来 —— 2026 年跑就去搜 2025 年报和 2026 半年报", () => {
    const ps = cardPropositions(card, TODAY);
    expect(ps[0].queries[0]).toBe("维信诺 2025年年度报告 site:cninfo.com.cn");
    expect(ps[1].queries[0]).toBe("维信诺 2026年半年度报告 site:cninfo.com.cn");
    // 换一年就跟着换，不写死。
    const next = cardPropositions(card, new Date(2027, 0, 3));
    expect(next[0].queries[0]).toBe("维信诺 2026年年度报告 site:cninfo.com.cn");
    expect(next[1].queries[0]).toBe("维信诺 2027年半年度报告 site:cninfo.com.cn");
  });

  it("官网那条用主体卡的 website 拼 site:，模型不给官网就不生成", () => {
    const ps = cardPropositions(card, TODAY);
    expect(ps[2].id).toBe("D8-F3");
    expect(ps[2].queries[0]).toBe("维信诺 公告 site:visionox.com");
    const without = cardPropositions({ ...card, website: "" }, TODAY);
    expect(without.map((p) => p.id)).not.toContain("D8-F3");
    expect(without.filter((p) => p.id.startsWith("D8-F"))).toHaveLength(2);
  });

  it("要核回来的东西写全了六样，战略重点那一格在里面（238 漏的就是它）", () => {
    for (const p of cardPropositions(card, TODAY).filter((x) => x.id.startsWith("D8-F"))) {
      for (const one of ["报告期", "营业收入", "归属于母公司股东的净利润", "经营活动产生的现金流量净额", "收入构成", "战略重点"]) {
        expect(p.requiredEvidence).toContain(one);
      }
      expect(p.sourceKinds).toEqual(["公司披露"]);
      expect(p.material).toBe(true);
      expect(p.freshnessUrgent).toBe(true);
      expect(p.dimension).toBe("D8");
    }
  });

  it("不给 now 时按今天算 —— 默认参数不是摆设", () => {
    const y = new Date().getFullYear();
    expect(cardPropositions(card)[0].queries[0]).toBe(`维信诺 ${y - 1}年年度报告 site:cninfo.com.cn`);
  });
});
