import { describe, expect, it } from "vitest";

import type { Evidence } from "@/lib/research/ledger";

import { FIXTURE_LEDGER, fixtureReport } from "./fixture";
import { buildRegistry, citedRefs, groupSizes, independentGroups, packIdOf, verificationOf, verificationTally } from "./registry";
import { readBlock, type Block, type BlockEvidence, type EvidenceListBlock, type SourceType } from "./schema";

const listOf = (items: EvidenceListBlock["items"]): Block[] => {
  const r = readBlock({ type: "evidence_list", items });
  if (!r.ok) throw new Error(r.why);
  return [r.value];
};

const one = (id: string, items: EvidenceListBlock["items"], entries: Evidence[] = FIXTURE_LEDGER) => {
  const got = buildRegistry(entries, listOf(items)).find((e) => e.id === id);
  if (!got) throw new Error(`证据表里没有 ${id}`);
  return got;
};

describe("buildRegistry", () => {
  it("台账里那一条的元数据全部来自台账", () => {
    const e = one("E1", [{ id: "E1", claim: "装机规模的增长有官方口径" }]);
    expect(e.origin).toBe("ledger");
    expect(e.verified).toBe(true);
    expect(e.sourceType).toBe("官方一手");
    expect(e.grade).toBe("A");
    expect(e.sourceName).toBe("国家统计口径公报");
    expect(e.url).toBe("https://www.gov.example/stat/2026-q2");
    expect(e.retrievedAt).toBe("2026-08-25T09:00:00.000Z");
    expect(e.independenceGroup).toBe("g1");
  });

  it("支撑的说法以清单里那句为准 —— 同一条证据在两份报告里撑的可以不同", () => {
    const e = one("E2", [{ id: "E2", claim: "这一份自己的说法" }]);
    expect(e.claim).toBe("这一份自己的说法");
  });

  it("模型能把来源往下改", () => {
    // 台账只知道它是「行业机构」，读过那一页的是模型：它说这是厂商宣传，收。
    const e = one("E2", [{ id: "E2", claim: "x", sourceType: "厂商宣传" }]);
    expect(e.sourceType).toBe("厂商宣传");
  });

  it("往上改一律按台账", () => {
    const e = one("E4", [{ id: "E4", claim: "x", sourceType: "官方一手" }]);
    expect(e.sourceType).toBe("媒体转述");
  });

  it("内部DOC / 模型既有知识 贴不到一条抓过原文的证据上", () => {
    for (const said of ["内部DOC", "模型既有知识"] as SourceType[]) {
      expect(one("E2", [{ id: "E2", claim: "x", sourceType: said }]).sourceType).toBe("行业机构");
    }
  });

  it("台账里没有的编号入列，但一律未核验、自己一组", () => {
    const e = one("E9", [{ id: "E9", claim: "记忆里的一个数" }]);
    expect(e.origin).toBe("model");
    expect(e.verified).toBe(false);
    expect(e.sourceType).toBe("模型既有知识");
    expect(e.independenceGroup).toBe("own:E9");
    expect(e.url).toBeUndefined();
    expect(e.retrievedAt).toBe("");
  });

  it("内部DOC 是这一路里唯一保留原样的一档", () => {
    const e = one("E7", [{ id: "E7", claim: "我们三个机房都是改造型", sourceType: "内部DOC" }]);
    expect(e.sourceType).toBe("内部DOC");
    expect(e.verified).toBe(false);
    expect(e.origin).toBe("model");
  });

  it("台账里有、清单里没列的照旧入表 —— 正文里的芯片要解析得开", () => {
    const list = buildRegistry(FIXTURE_LEDGER, listOf([{ id: "E1", claim: "只列了这一条" }]));
    expect(list.map((e) => e.id)).toEqual(["E1", "E2", "E3", "E4", "E5"]);
    expect(list[0].claim).toBe("只列了这一条");
  });

  it("先按清单的顺序", () => {
    const list = buildRegistry(FIXTURE_LEDGER, listOf([{ id: "E3", claim: "a" }, { id: "E1", claim: "b" }]));
    expect(list.slice(0, 2).map((e) => e.id)).toEqual(["E3", "E1"]);
  });
});

describe("共源折叠", () => {
  it("同一篇稿子的两处转载算一组", () => {
    const { evidence } = fixtureReport();
    expect(groupSizes(evidence).get("g1")).toBe(2);
    expect(independentGroups(["E1", "E4"], evidence)).toEqual(["g1"]);
    expect(independentGroups(["E1", "E2"], evidence)).toEqual(["g1", "g2"]);
  });

  it("模型自己那几条各自一组：它们不是共源，它们压根没有源", () => {
    const { evidence } = fixtureReport();
    expect(independentGroups(["E6", "E7"], evidence)).toEqual(["own:E6", "own:E7"]);
  });
});

describe("citedRefs", () => {
  it("字段式引用和行内 [E1] 都数得到", () => {
    const refs = citedRefs(fixtureReport().blocks);
    for (const id of ["E1", "E2", "E3", "E4", "E5", "E6", "E7"]) expect(refs).toContain(id);
  });

  it("一段里的 [E3, E7] 拆得开", () => {
    const r = readBlock({ type: "prose", md: "这一句同时引两条 [E3, E7]。" });
    expect(r.ok && citedRefs([r.value])).toEqual(["E3", "E7"]);
  });
});

describe("packIdOf", () => {
  it("同一批材料算出同一个 id", () => {
    expect(packIdOf(FIXTURE_LEDGER)).toBe(packIdOf([...FIXTURE_LEDGER].reverse()));
    expect(packIdOf(FIXTURE_LEDGER)).toMatch(/^pack-5-[0-9a-f]{8}$/);
  });

  it("换掉一页就变", () => {
    const moved = FIXTURE_LEDGER.map((e, i) => (i === 0 ? { ...e, contentHash: "hash-other" } : e));
    expect(packIdOf(moved)).not.toBe(packIdOf(FIXTURE_LEDGER));
  });

  it("没联网那一轮是一个说得出口的 id，不是一处缺失", () => {
    expect(packIdOf([])).toBe("pack-0-empty");
  });
});

/*
 * ISS-239：机检写着「31 条已核验」，而它证明的只有「引句在那一页上」。
 * 四件事分开表述之后，同一份台账的正确说法是「31 条原文片段匹配、0 条独立交叉验证」。
 */
describe("核验分成四件事", () => {
  const ev = (over: Partial<BlockEvidence> & { id: string }): BlockEvidence => ({
    claim: `${over.id} 的说法`,
    sourceName: "某站",
    sourceType: "媒体转述",
    verified: true,
    retrievedAt: "2026-09-07T03:00:00.000Z",
    independenceGroup: `g-${over.id}`,
    grade: "C",
    origin: "ledger",
    ...over,
  });

  it("原文片段匹配 ≠ 已核验：台账里的条目只保证第一栏", () => {
    const e = ev({ id: "E30", url: "https://news.example/a" });
    const v = verificationOf(e, [e]);
    expect(v.quoteMatched).toBe("yes");
    expect(v.crossChecked).toBe("unchecked");
    expect(v.supportsClaim).toBe("unstated");
    expect(v.label).toContain("原文片段匹配：是");
    expect(v.label).toContain("独立交叉验证：未核");
    // 一整句里不许出现「已核验」三个字 —— 它正是这一轮要拆掉的那句话。
    expect(v.label).not.toContain("已核验");
  });

  it("镜像转载的公司披露：来源身份未核，不因为是 A 级就算确认", () => {
    const mirror = ev({
      id: "E25",
      sourceType: "公司披露",
      grade: "A",
      url: "http://vip.stock.finance.sina.com.cn/corp/view/x.php",
    });
    const primary = ev({
      id: "E26",
      sourceType: "公司披露",
      grade: "A",
      url: "https://static.cninfo.com.cn/2025.pdf",
    });
    expect(verificationOf(mirror, [mirror]).sourceIdentified).toBe("unchecked");
    expect(verificationOf(primary, [primary]).sourceIdentified).toBe("yes");
    // 主体官网要由调用方把域名递进来，同 `disclosureOrigin`。
    const own = ev({ id: "E1", sourceType: "公司披露", grade: "A", url: "https://www.visionox.com/ir/x" });
    expect(verificationOf(own, [own]).sourceIdentified).toBe("unchecked");
    expect(verificationOf(own, [own], { disclosureDomains: ["visionox.com"] }).sourceIdentified).toBe("yes");
  });

  it("模型既有知识没有出处可核；来路不明的身份不成立；内部文档是未核不是没有", () => {
    const own = ev({ id: "E40", origin: "model", verified: false, sourceType: "模型既有知识" });
    expect(verificationOf(own, [own])).toMatchObject({ quoteMatched: "no", sourceIdentified: "no" });
    const junk = ev({ id: "E41", sourceType: "来路不明", url: "https://wenku.example/x" });
    expect(verificationOf(junk, [junk]).sourceIdentified).toBe("no");
    const doc = ev({ id: "E42", origin: "model", verified: false, sourceType: "内部DOC" });
    expect(verificationOf(doc, [doc]).sourceIdentified).toBe("unchecked");
  });

  it("独立交叉验证：同一句话由两个不同独立性组说出来才算", () => {
    const a = ev({ id: "E1", claim: "8.6 代线已实现主厂房封顶", independenceGroup: "g1" });
    const b = ev({ id: "E2", claim: "8.6 代线已实现主厂房封顶。", independenceGroup: "g2" });
    const sameSource = ev({ id: "E3", claim: "8.6 代线已实现主厂房封顶", independenceGroup: "g1" });
    expect(verificationOf(a, [a, b]).crossChecked).toBe("yes");
    // 同一篇稿子的两处转载不是两个来源 —— 那正是共源折叠存在的理由。
    expect(verificationOf(a, [a, sameSource]).crossChecked).toBe("unchecked");
  });

  it("「对当前判断的作用」是模型标的，标签里要说明这一点", () => {
    const e = ev({ id: "E12", updateDirection: { target: "首访路线", effect: "削弱" } });
    const v = verificationOf(e, [e]);
    expect(v.supportsClaim).toBe("削弱");
    expect(v.label).toContain("模型标注，非核验结果");
  });

  it("整份的账：三个数分开报，不合成一个「已核验 N 条」", () => {
    const list = [
      ev({ id: "E25", sourceType: "公司披露", grade: "A", url: "http://vip.stock.finance.sina.com.cn/a" }),
      ev({ id: "E26", sourceType: "公司披露", grade: "A", url: "http://vip.stock.finance.sina.com.cn/b" }),
      ev({ id: "E22", url: "https://cj.sina.cn/x" }),
    ];
    const t = verificationTally(list);
    expect(t).toMatchObject({ total: 3, quoteMatched: 3, sourceIdentified: 1, sourceUnchecked: 2, crossChecked: 0 });
    expect(t.label).toContain("原文片段匹配 3 条");
    expect(t.label).toContain("独立交叉验证 0 条");
    expect(t.label).toContain("不证明它撑得起报告里的建议");
    expect(t.label).not.toContain("已核验");
  });
});
