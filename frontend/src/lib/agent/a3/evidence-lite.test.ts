import { describe, expect, it } from "vitest";
import type { Evidence } from "@/lib/research/ledger";
import { buildLiteIndex, independentGroupCount, toEvidenceLite } from "./evidence-lite";
import { makeProvenance } from "./provenance";

/*
 * 这份 fixture **不许戴 `as Evidence`**。
 *
 * 戴上它，这条测试自称「投影出规格 §2.1 那七格」就成了对一个假 `Evidence` 的投影 ——
 * 真契约哪天改了字段名，它照样绿。不戴，少一格、错一个字面量就编译不过，
 * 那才是这条测试的价值所在。字段名与字面量一律照 `src/lib/research/ledger.ts` 的
 * `EvidenceDraft` + `Evidence`：引句是 `exactQuote`（不是 `quote`），支持关系是
 * `supportRelation`（不是 `support`），没有 `publishedAt` 这一格（时点在 `period`，
 * 抓取时刻在 `retrievedAt`），`authorityClass` 里没有 `"official"`，
 * `usedAs` 只有 `"current_state" | "historical_point"`（没有 `"primary"`）。
 */
function full(over: Partial<Evidence> = {}): Evidence {
  return {
    id: "E1",
    propositionId: "P1",
    claim: "某公司 2026Q2 营收同比降 12%",
    url: "https://example.gov.cn/report/1",
    exactQuote: "同比下降 12%",
    supportRelation: "supports",
    evidenceType: "statistic",
    authorityClass: "official_statistics",
    usedAs: "current_state",
    period: "2026Q2",
    sourceDomain: "example.gov.cn",
    contentHash: "deadbeef",
    retrievedAt: "2026-08-27T02:00:00.000Z",
    sourceTier: "A",
    span: [10, 22],
    excerpt: "……同比下降 12%……",
    verificationStatus: "span_matched",
    independenceGroup: "dom:example.gov.cn",
    ...over,
  };
}

describe("toEvidenceLite", () => {
  it("投影出规格 §2.1 那几格，一格不多一格不少", () => {
    const lite = toEvidenceLite(full(), makeProvenance("I-7"));
    expect(lite).toEqual({
      id: "E1",
      claim: "某公司 2026Q2 营收同比降 12%",
      sourceRef: "https://example.gov.cn/report/1",
      date: "2026-08-27T02:00:00.000Z",
      tier: "A",
      cosourceKey: "dom:example.gov.cn",
      provenance: { issueId: "I-7", stage: "pre_research" },
    });
  });

  it("站点名有就带上，没有就不带（不拿域名冒充）", () => {
    const prov = makeProvenance("I-7");
    expect(toEvidenceLite(full({ siteName: "国家统计局" }), prov).sourceName).toBe("国家统计局");
    // `full()` 没有 `siteName` —— 这一格就不该出现，上一条 `toEqual` 也是这么钉的
    expect(toEvidenceLite(full(), prov).sourceName).toBeUndefined();
  });

  it("共源键直接用台账折出来的组号 —— 同源两条拿到同一个键", () => {
    const prov = makeProvenance("I-7");
    const a = toEvidenceLite(full({ id: "E1" }), prov);
    const b = toEvidenceLite(full({ id: "E2", url: "https://example.gov.cn/report/2" }), prov);
    expect(a.cosourceKey).toBe(b.cosourceKey);
    expect(independentGroupCount([a, b])).toBe(1);
  });

  it("不同源算两组", () => {
    const prov = makeProvenance("I-7");
    const a = toEvidenceLite(full({ id: "E1" }), prov);
    const b = toEvidenceLite(full({ id: "E2", independenceGroup: "dom:other.com" }), prov);
    expect(independentGroupCount([a, b])).toBe(2);
  });

  it("没过台账折叠的（组号是空串）不许投影出来", () => {
    expect(() => toEvidenceLite(full({ independenceGroup: "" }), makeProvenance("I-7"))).toThrow(/折叠/);
  });
});

describe("buildLiteIndex", () => {
  it("四列逐列对齐深研那一侧的台账索引：编号、说法、站点名、档位", () => {
    const prov = makeProvenance("I-7");
    const a = toEvidenceLite(full({ id: "E1", siteName: "国家统计局" }), prov);
    const b = toEvidenceLite(
      full({ id: "E2", url: "https://news.example.com/x", siteName: "某财经媒体", sourceTier: "C" }),
      prov,
    );
    expect(buildLiteIndex([a, b])).toBe(
      "E1｜某公司 2026Q2 营收同比降 12%｜国家统计局｜A 档\n" +
        "E2｜某公司 2026Q2 营收同比降 12%｜某财经媒体｜C 档",
    );
  });

  it("站点名取不到才退成域名 —— 第三列不许是空的", () => {
    // `full()` 没有 `siteName`（抓不到站点名的页不少），这时印域名
    const line = buildLiteIndex([toEvidenceLite(full({ id: "E3" }), makeProvenance("I-7"))]);
    expect(line).toBe("E3｜某公司 2026Q2 营收同比降 12%｜example.gov.cn｜A 档");
  });

  it("空台账给空串 —— 那句话由调用方写", () => {
    // 和深研那一侧一样（`buildLedgerIndex` 对空数组也回空串，store 里用 `if (ledgerIndex)`
    // 兜）。索引这一层不该替调用方决定「没有证据」这件事在屏幕上怎么说：
    // 同一个空表在对话上下文里要说一句话，在别处可能就是整段不出现。
    expect(buildLiteIndex([])).toBe("");
  });
});

/*
 * **这一组是补上来的，不在计划里。** 计划给的验收变异（把 `${e.id}` 换成按下标现编的
 * `E${i + 1}`）实测只有上面那条「退成域名」偶然红了 —— 它恰好用了 `E3` 当唯一一条。
 * 上面那条四列对齐用的是顺序排的 `E1`/`E2`，重编号之后一字不差，照样绿。
 * 「编号不变」这件事因此需要一条**编号本身不连续**的用例来钉：报告正文里写着 `[E12]`，
 * 他在对谈里追问那一句时读到的 `E12` 必须还是同一条；重编号会让屏幕上的引用悄悄
 * 指向别的东西，而那时屏幕上看起来一切正常。
 */
describe("buildLiteIndex 的编号", () => {
  it("编号原样取自证据自己那一格 —— 不连续、不从 1 起的也照印", () => {
    const prov = makeProvenance("I-7");
    const text = buildLiteIndex([
      toEvidenceLite(full({ id: "E7", siteName: "国家统计局" }), prov),
      toEvidenceLite(full({ id: "E12", url: "https://news.example.com/x", siteName: "某财经媒体" }), prov),
    ]);
    expect(text.split("\n").map((l) => l.split("｜")[0])).toEqual(["E7", "E12"]);
    // 按下标现编一套的实现会印出 E1/E2 —— 这两条断言就是拦它的
    expect(text).not.toContain("E1｜");
    expect(text).not.toContain("E2｜");
  });
});
