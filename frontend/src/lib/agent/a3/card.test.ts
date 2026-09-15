import { describe, expect, it } from "vitest";
import { assembleCard, CARD_BUDGET, checkCard, INCREMENT_BUDGET, INCREMENT_HEAD } from "./card";
import type { BlindspotRuling, CriticVerdict, DispositionSuggestion, EvidenceLite, ImpactProposal } from "./stages";

const prov = { issueId: "I-7", stage: "pre_research" as const };
const target = { kind: "judgment" as const, id: "J-2", text: "今年不会有新玩家" };
function ev(id: string, group: string): EvidenceLite {
  return { id, claim: "同类产品已发布", sourceRef: `https://a.com/${id}`, date: "2026-08-27T00:00:00.000Z", tier: "A", cosourceKey: group, provenance: prov };
}
const impact: ImpactProposal = {
  impactType: "weakens", proposalType: "adjustJudgment", targetRef: target,
  statement: "那条判断要收窄成只管同一档客户", basis: ["E1", "[P] 这家公司过去只做海外"],
};
const disposition: DispositionSuggestion = { action: "discuss", why: "有两组独立源撑着", trigger: null };
const blindspot: BlindspotRuling = { isBlindspot: true, proximity: "adjacent", hops: 1, credibility: "A", magnitude: "material", why: [] };
const critic: CriticVerdict = { pass: true, checks: [], why: ["没有跳步"], modelSlot: "alt" };
// 这里**没有** `searchless`：装配只认台账（`evidence` 空不空），
// 收第二个入参等于给同一件事开两个真源，两边口径迟早不一致。
const base = { impact, disposition, blindspot, evidence: [ev("E1", "dom:a"), ev("E2", "dom:b")], critic };

describe("assembleCard", () => {
  it("装出的卡不超预算，且每条依据都带着标签上卡", () => {
    const c = assembleCard({ ...base, kind: "full" });
    expect(c.kind).toBe("full");
    expect(c.chars).toBeLessThanOrEqual(CARD_BUDGET);
    expect(c.body).toContain("[E1]");
    expect(c.body).toContain("[P]");
    expect(c.basis).toEqual(["E1", "[P] 这家公司过去只做海外"]);
    expect(checkCard(c)).toEqual([]);
  });

  it("机检算出来的档位与组数上卡 —— 他要看得见这份判断有多少底", () => {
    const c = assembleCard({ ...base, kind: "full" });
    expect(c.body).toContain("A 档");
    expect(c.body).toContain("2 组独立源");
  });

  it("挂了靶点就把靶点编号写进抬头", () => {
    expect(assembleCard({ ...base, kind: "full" }).headline).toContain("J-2");
  });

  it("增量卡有自己的预算和固定开头", () => {
    const c = assembleCard({ ...base, kind: "increment" });
    expect(c.body.startsWith(INCREMENT_HEAD)).toBe(true);
    expect(c.chars).toBeLessThanOrEqual(INCREMENT_BUDGET);
    expect(checkCard(c)).toEqual([]);
  });

  it("没有外部证据时如实写「这一轮没有外部核验」，不写档位也不写组数", () => {
    const c = assembleCard({ ...base, evidence: [], kind: "full" });
    expect(c.body).toContain("这一轮没有外部核验");
    // 这两条断言只能这么写：`impact.statement` 里本来就有「档」字（「只管同一档客户」），
    // `disposition.why` 里本来就有「组独立源」（「有两组独立源撑着」），而这两段都是
    // 上卡的，所以 `not.toContain("档")` / `not.toContain("组独立源")` 必红 ——
    // 那是 fixture 的字，不是装配写的底子那一行。要拦的是装配写的两个格式：
    // 「A 档」和「2 组独立源」（阿拉伯数字 + 空格），和 `checkCard` 里 A3-16
    // 那个 `/[ABCD] 档/` 是同一个口径。
    expect(c.body).not.toMatch(/[ABCD] 档/);
    expect(c.body).not.toMatch(/\d 组独立源/);
    /*
     * 上面两条各有一个盖不住的角：把三元的空台账那一支拿掉之后，装配写出来的是
     * `底子：null 档，0 组独立源` —— `/\d 组独立源/` 抓得到那个 `0`，
     * `/[ABCD] 档/` 却抓不到 `null 档`。
     *
     * 所以再认一次装配自己写的那个前缀。夹具三段（判断/处置/批判）一个字都没有它，
     * 而底子那一行必带它 —— 一条顶前面两条，且不随档位取值变化。
     */
    expect(c.body).not.toContain("底子：");
  });

  it("批判没过时卡上要写着它没过 —— 不许把没过的批判藏起来", () => {
    const c = assembleCard({
      ...base, kind: "full",
      critic: { pass: false, checks: ["evidenceThin"], why: ["独立源不够"], modelSlot: null },
    });
    expect(c.body).toContain("机检没过");
    expect(c.body).toContain("独立源不够");
  });

  it("放不下的段落就不放，但放进去的话不许缺标签", () => {
    const c = assembleCard({
      ...base, kind: "increment",
      disposition: { ...disposition, why: "理".repeat(200) },
    });
    expect(c.chars).toBeLessThanOrEqual(INCREMENT_BUDGET);
    expect(checkCard(c)).toEqual([]);
  });
});

describe("checkCard", () => {
  it("连头一句都超预算就报 p0 —— 那是说法本身太长", () => {
    const c = assembleCard({
      ...base, kind: "full",
      impact: { ...impact, statement: "长".repeat(400) },
    });
    const v = checkCard(c);
    expect(v.some((x) => x.rule === "A3-14" && x.severity === "p0")).toBe(true);
  });

  it("依据在 basis 里但正文里找不到标签 —— 报 p0", () => {
    const v = checkCard({ kind: "full", headline: "h", body: "一句没有标签的话", basis: ["E1"], chars: 8 });
    expect(v.some((x) => x.rule === "A3-15" && x.severity === "p0")).toBe(true);
  });

  it("两条先验依据只上去一条 —— 掉的那条要被查出来", () => {
    const v = checkCard({
      kind: "full",
      headline: "h",
      body: "[P] 这家公司过去只做海外 —— A 档",
      basis: ["[P] 这家公司过去只做海外", "[P] 这个行业的渠道向来握在代理商手里"],
      chars: 22,
    });
    expect(v.filter((x) => x.rule === "A3-15")).toHaveLength(1);
  });

  it("正文里一个档位都没提 —— 报 p1（提醒而不是拦）", () => {
    const v = checkCard({ kind: "full", headline: "h", body: "[E1] 一句话", basis: ["E1"], chars: 9 });
    expect(v.some((x) => x.rule === "A3-16" && x.severity === "p1")).toBe(true);
  });

  it("增量卡开头不对 —— 报 p0", () => {
    const v = checkCard({ kind: "increment", headline: "h", body: "[E1] A 档，2 组独立源", basis: ["E1"], chars: 15 });
    expect(v.some((x) => x.rule === "A3-17" && x.severity === "p0")).toBe(true);
  });
});
