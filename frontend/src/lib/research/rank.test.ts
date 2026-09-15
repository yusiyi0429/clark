import { describe, expect, it } from "vitest";
import { DISCLOSURE_HOSTS, hostOf, isDisclosureUrl, mentionsSubject, rankHits, scoreHit } from "./rank";
import type { SearchHit } from "./search";

const hit = (url: string, title = "", snippet = ""): SearchHit => ({ url, title, snippet, sourceDomain: "" });

describe("检索命中排序（2026-09-04）", () => {
  it("提到主体的页排前面，论坛与图表站排后面，种子只抬一分", () => {
    const seeds = new Set(["https://www.jiepei.com/design/7019.html"]);
    const ranked = rankHits(
      [
        hit("https://www.jiepei.com/design/7019.html", "设计趋势"),
        hit("https://bbs.csdn.net/x", "维信诺 讨论"),
        hit("https://finance.sina.com.cn/a.shtml", "2024 年全球 OLED 手机面板出货前三", "维信诺 11%"),
        hit("https://www.hangyan.co/charts/1", "AMOLED 渗透率图表"),
        hit("https://static.cninfo.com.cn/report.pdf", "维信诺 2024 年年度报告"),
      ],
      "维信诺",
      seeds
    );
    expect(ranked.map((x) => x.url)).toEqual([
      "https://finance.sina.com.cn/a.shtml",
      "https://static.cninfo.com.cn/report.pdf",
      "https://bbs.csdn.net/x",
      "https://www.jiepei.com/design/7019.html",
      "https://www.hangyan.co/charts/1",
    ]);
  });

  it("同分保持原顺序 —— 检索家的返回顺序是最后的裁决", () => {
    const a = hit("https://a.example.com/1", "x");
    const b = hit("https://b.example.com/2", "y");
    expect(rankHits([a, b], "维信诺", new Set()).map((x) => x.url)).toEqual([a.url, b.url]);
    expect(scoreHit(a, "", false)).toBe(0);
  });

  it("抓不动的站抵掉披露站的加分，排到普通页后面（2026-09-04：合肥政府站 403 了 14 次）", () => {
    const gov = hit("https://hfxz.hefei.gov.cn/tzxz/zsdt/18936727.html", "维信诺 合肥 8.6 代线");
    const eet = hit("https://www.eet-china.com/mp/a370859.html", "维信诺 ViP");
    const plain = hit("https://a.example.com/1", "维信诺");
    expect(scoreHit(gov, "维信诺", false)).toBe(2);
    expect(scoreHit(eet, "维信诺", false)).toBe(2);
    expect(rankHits([gov, eet, plain], "维信诺", new Set()).map((x) => x.url)).toEqual([plain.url, gov.url, eet.url]);
  });

  it("主体名带括号与长名时按片段认", () => {
    const h = hit("https://a.example.com/1", "维信诺科技股份有限公司公告");
    expect(scoreHit(h, "维信诺（002387）", false)).toBe(3);
    expect(mentionsSubject(h, "维信诺（002387）")).toBe(true);
    expect(mentionsSubject(h, "")).toBe(false);
  });
});

/**
 * 这张表管的不是排序，是抓取位保留（`slots.ts`）和抓取放宽（`fetch.ts`）。ISS-238 里
 * 排序本身是对的 —— 位子不够、超时不够。
 */
describe("一手披露的域名表（2026-09-07，ISS-238）", () => {
  it("交易所、巨潮、港交所、新三板都在表上", () => {
    for (const one of ["cninfo.com.cn", "static.cninfo.com.cn", "sse.com.cn", "szse.cn", "hkexnews.hk", "neeq.com.cn"]) {
      expect(DISCLOSURE_HOSTS as readonly string[]).toContain(one);
    }
  });

  it("按主机名后缀比，不按 url 子串", () => {
    expect(isDisclosureUrl("https://static.cninfo.com.cn/finalpage/2026-04-20/1.PDF")).toBe(true);
    expect(isDisclosureUrl("http://www.szse.cn/disclosure/x")).toBe(true);
    // 别人站上的查询串里写着交易所域名，不算一手披露。
    expect(isDisclosureUrl("https://news.example.com/s?q=cninfo.com.cn")).toBe(false);
    // 后缀要卡在点上：`fake-szse.cn` 不是 `szse.cn`。
    expect(isDisclosureUrl("https://fake-szse.cn/x")).toBe(false);
    expect(isDisclosureUrl("not a url")).toBe(false);
  });

  it("额外域名（主体官网）并得进来，空串一律跳过", () => {
    expect(isDisclosureUrl("https://www.visionox.com/notice/1", ["visionox.com"])).toBe(true);
    expect(isDisclosureUrl("https://a.example.com/1", [""])).toBe(false);
    expect(isDisclosureUrl("https://a.example.com/1", ["  "])).toBe(false);
  });

  it("hostOf 取不出来时返回空串", () => {
    expect(hostOf("https://WWW.Cninfo.com.CN/a")).toBe("www.cninfo.com.cn");
    expect(hostOf("/relative/path")).toBe("");
  });
});
