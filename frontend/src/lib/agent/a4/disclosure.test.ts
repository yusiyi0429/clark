import { describe, expect, it } from "vitest";

import {
  type AuditEvidence,
  disclosureFreshness,
  disclosureOrigin,
  materialCutoff,
  periodKind,
} from "./disclosure";

const TODAY = new Date("2026-09-07T00:00:00Z");
/** 主体卡上的官网域名。真链路由 `pipeline.ts` 递进来。 */
const OWN = ["visionox.com"];

const ev = (over: Partial<AuditEvidence> & { id: string }): AuditEvidence => ({
  url: "https://news.example/a",
  sourceDomain: "news.example",
  sourceTier: "C",
  retrievedAt: "2026-09-07T03:27:00.000Z",
  ...over,
});

/*
 * ISS-239 台账里的四条真条目（`replay/iss239.snapshot.json`）。字段照抄，只删了正文。
 * 屏幕上那句「材料截至 2020-12-31」就是 E1 一条撑出来的。
 */
const E1 = ev({
  id: "E1",
  url: "https://www.visionox.com/about/history",
  sourceDomain: "www.visionox.com",
  sourceTier: "A",
  authorityClass: "company_primary",
  evidenceType: "event",
  usedAs: "historical_point",
  period: "2020-12",
});
const E12 = ev({
  id: "E12",
  url: "http://vip.stock.finance.sina.com.cn/corp/view/vCB_AllBulletinDetail.php?id=12365264",
  sourceDomain: "vip.stock.finance.sina.com.cn",
  sourceTier: "A",
  authorityClass: "company_primary",
  evidenceType: "statement",
  usedAs: "current_state",
  period: "2026-05-29",
});
const E25 = ev({
  id: "E25",
  url: "http://vip.stock.finance.sina.com.cn/corp/view/vCB_AllBulletinDetail.php?id=12336577",
  sourceDomain: "vip.stock.finance.sina.com.cn",
  sourceTier: "A",
  authorityClass: "company_primary",
  evidenceType: "statistic",
  usedAs: "current_state",
  period: "2025年",
});
const E28 = ev({ ...E25, id: "E28" });
const E22 = ev({
  id: "E22",
  url: "https://cj.sina.cn/article/norm_detail?url=x",
  sourceDomain: "cj.sina.cn",
  authorityClass: "media",
  evidenceType: "statistic",
  usedAs: "current_state",
  period: "2026 Q1",
});

describe("三种时间分得开（ISS-239）", () => {
  it("产线哪年建成是事件时间，年报那一期才是报告期", () => {
    expect(periodKind(E1)).toBe("event");
    expect(periodKind(E25)).toBe("reporting");
    // 「2026-05-29」是那场投资者交流开会那天 —— 一天不是一期。旧代码把它读成 2026-12-31。
    expect(periodKind(E12)).toBe("event");
    expect(periodKind(E22)).toBe("reporting");
  });

  it("按期次的字面形状也判得出来 —— evidenceType 缺省时的退路", () => {
    const only = (period: string) => periodKind({ period });
    expect(only("2025 年度")).toBe("reporting");
    expect(only("2026年第一季度")).toBe("reporting");
    expect(only("2025H1")).toBe("reporting");
    expect(only("2025年")).toBe("reporting");
    expect(only("2024-05-29")).toBe("event");
    expect(only("2024年5月29日")).toBe("event");
    expect(only("2020-2022")).toBe("event");
    // 没有报告期词的月份戳往 event 落：判错成 reporting 的代价是屏幕上一个假的截止日。
    expect(only("2020-12")).toBe("event");
    expect(only("")).toBe("none");
    expect(only("最近一期")).toBe("none");
  });

  it("historical_point 的数不描述当期", () => {
    expect(periodKind({ period: "2024年", usedAs: "historical_point" })).toBe("event");
    expect(periodKind({ period: "2024年", usedAs: "current_state" })).toBe("reporting");
  });
});

describe("来源身份分三档", () => {
  it("官网与交易所是一手，新浪镜像是镜像，媒体是第三方", () => {
    expect(disclosureOrigin(E1, OWN)).toBe("primary");
    expect(disclosureOrigin(E25, OWN)).toBe("mirrored");
    expect(disclosureOrigin(E22, OWN)).toBe("thirdparty");
    expect(
      disclosureOrigin({ url: "https://static.cninfo.com.cn/a.pdf", sourceDomain: "static.cninfo.com.cn" })
    ).toBe("primary");
  });

  it("`finance.sina.com.cn` 上是新浪自己的稿子，不是镜像 —— 差一段主机名是两件事", () => {
    expect(
      disclosureOrigin({ url: "https://finance.sina.com.cn/x", sourceDomain: "finance.sina.com.cn", authorityClass: "media" })
    ).toBe("thirdparty");
    expect(
      disclosureOrigin({ url: "https://money.finance.sina.com.cn/f10", sourceDomain: "money.finance.sina.com.cn", authorityClass: "media" })
    ).toBe("mirrored");
  });

  it("镜像不自动升格成一手 —— 原站与这份转载的身份没核过", () => {
    expect(disclosureOrigin(E25, OWN)).not.toBe("primary");
  });
});

describe("材料截至哪一天", () => {
  it("历史事件 + 近期经营材料：不把建成年份当材料截止", () => {
    const out = materialCutoff([E1, E12, E25, E28, E22], OWN);
    // 旧实现在这一组上输出 2020-12-31（E1 是唯一一条既在披露域名上、期次又认得出的）。
    expect(out.date).not.toBe("2020-12-31");
    expect(out.status).toBe("dated");
    expect(out.date).toBe("2025-12-31");
    expect(out.refs).toEqual(["E25", "E28"]);
    expect(out.origin).toBe("mirrored");
    expect(out.label).toBe("2025-12-31（镜像转载的公司披露，原站未核对）");
    expect(out.why).toContain("镜像转载站");
  });

  it("一手撑起来的那一天不带「未核对」", () => {
    const primary = ev({
      id: "E90",
      url: "https://static.cninfo.com.cn/2025-annual.pdf",
      sourceDomain: "static.cninfo.com.cn",
      sourceTier: "A",
      authorityClass: "company_primary",
      evidenceType: "statistic",
      usedAs: "current_state",
      period: "2025 年度",
    });
    const out = materialCutoff([E1, primary, E25], OWN);
    expect(out.origin).toBe("primary");
    expect(out.label).toBe("2025-12-31");
  });

  it("没有可信期次就明说未确定 —— 不编日期，也不落回模型写的那一行", () => {
    const out = materialCutoff([E1, E12, E22], OWN);
    expect(out.status).toBe("undetermined");
    expect(out.date).toBe("");
    expect(out.label).toBe("未确定");
    expect(out.why).toContain("没有一条带得出经营数据报告期");
    // 一条证据都没有的那一轮同样是「未确定」，不是空格。
    expect(materialCutoff([]).label).toBe("未确定");
  });

  it("媒体转载页上的日期不算 —— 那是它发稿那天", () => {
    const repost = ev({
      id: "E91",
      url: "https://www.sohu.com/a/1.html",
      sourceDomain: "sohu.com",
      authorityClass: "media",
      evidenceType: "statistic",
      usedAs: "current_state",
      period: "2026 年上半年",
    });
    expect(materialCutoff([repost, E25], OWN).date).toBe("2025-12-31");
  });
});

describe("新鲜度：一手和镜像分开数（A4-N09 的判据）", () => {
  it("ISS-239 那一轮：没从一手站拿到，但近期公司材料是有的", () => {
    const f = disclosureFreshness([E1, E12, E22, E25, E28], TODAY, { disclosureDomains: OWN });
    expect(f.primaryFresh).toBe(false);
    expect(f.companyFresh).toBe(true);
    expect(f.mirroredRefs).toEqual(["E25", "E28"]);
    expect(f.latestPeriod).toBe("2025年");
  });

  it("一条近期公司材料都没有时两栏都落假", () => {
    const f = disclosureFreshness([E1, E22], TODAY, { disclosureDomains: OWN });
    expect(f.primaryFresh).toBe(false);
    expect(f.companyFresh).toBe(false);
    expect(f.latestPeriod).toBe("");
  });

  it("产线建成年份再新也不是一期经营数据", () => {
    const fresh听起来像新的 = ev({
      id: "E92",
      url: "https://www.visionox.com/news/2026",
      sourceDomain: "www.visionox.com",
      sourceTier: "A",
      authorityClass: "company_primary",
      evidenceType: "event",
      usedAs: "current_state",
      period: "2026-04-15",
    });
    const f = disclosureFreshness([fresh听起来像新的], TODAY, { disclosureDomains: OWN });
    expect(f.companyFresh).toBe(false);
  });
});
