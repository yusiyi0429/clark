/**
 * 抓取位保留（ISS-238）。这里钉的四件事都属于「坏了没有症状」那一类：
 * 年报排到第十几位、没有披露命中时顺序被无端打乱、主体材料被转载页挤光、同类内部乱序。
 */
import { describe, expect, it } from "vitest";

import { reserveSlots } from "./slots";
import type { SearchHit } from "./search";

const hit = (url: string, title = "", snippet = ""): SearchHit => ({ url, title, snippet, sourceDomain: "" });

/** 八个转载页：标题里都写着主体名，`rankHits` 给它们的分比一份 PDF 年报还高。 */
const reposts = Array.from({ length: 14 }, (_, i) =>
  hit(`https://repost${i}.example.com/a/${i}`, `维信诺 8.6 代线最新进展（转载 ${i}）`)
);

describe("一手披露的抓取位", () => {
  it("年报排在第 15 位也进得了前 8（ISS-238：2025 年报在巨潮上，一次都没轮上）", () => {
    const annual = hit("https://static.cninfo.com.cn/finalpage/2026-04-20/1223.PDF", "维信诺 2025 年年度报告");
    const semi = hit("https://www.cninfo.com.cn/new/disclosure/1224", "维信诺 2026 年半年度报告");
    const input = [...reposts, annual, semi];
    // 第 15 位：前面十四条转载页的分都比它高（转载页 +3，PDF 年报 +2−1）。
    expect(input.indexOf(annual)).toBe(14);

    const out = reserveSlots(input, { subject: "维信诺", total: 8 });
    expect(out.slice(0, 2).map((x) => x.url)).toEqual([annual.url, semi.url]);
    expect(out.slice(0, 8)).toContain(annual);
    // 一条都不丢，只是重排。
    expect(out).toHaveLength(input.length);
    expect([...out].sort((a, b) => a.url.localeCompare(b.url))).toEqual(
      [...input].sort((a, b) => a.url.localeCompare(b.url))
    );
  });

  it("主体官网并进来之后也算一手披露 —— 重大公告挂在自己站上", () => {
    const ir = hit("https://www.visionox.com/investor/notice/9.html", "关于对外投资的公告");
    const out = reserveSlots([...reposts, ir], { subject: "维信诺", disclosureDomains: ["visionox.com"], total: 8 });
    expect(out[0]).toBe(ir);
  });

  it("官网域名是空串时不许把每一页都算成披露 —— 模型不给官网时那一栏就是空串", () => {
    const plain = [hit("https://a.example.com/1"), hit("https://b.example.com/2")];
    expect(reserveSlots(plain, { disclosureDomains: [""], total: 8 }).map((x) => x.url)).toEqual(
      plain.map((x) => x.url)
    );
  });

  it("域名按主机名后缀比，不按 url 子串 —— 别人的查询串里写着 cninfo 不算", () => {
    const fake = hit("https://news.example.com/s?q=cninfo.com.cn", "维信诺年报解读");
    const real = hit("https://static.cninfo.com.cn/x.PDF", "维信诺 2025 年年度报告");
    const out = reserveSlots([fake, real], { subject: "维信诺", total: 8 });
    expect(out[0]).toBe(real);
  });
});

describe("没有披露命中时不动前 8 位", () => {
  it("传进来什么顺序就还是什么顺序（输入已经是 rankHits 排完的）", () => {
    const input = [...reposts];
    const out = reserveSlots(input, { subject: "维信诺", total: 8 });
    expect(out.map((x) => x.url)).toEqual(input.map((x) => x.url));
  });

  it("主体名一次都没出现时同样原样返回", () => {
    const input = Array.from({ length: 10 }, (_, i) => hit(`https://x${i}.example.com/${i}`, `无关页 ${i}`));
    expect(reserveSlots(input, { subject: "维信诺", total: 8 }).map((x) => x.url)).toEqual(input.map((x) => x.url));
  });
});

describe("主体材料的保留位", () => {
  it("提到主体的页最多保 2 位，排在披露位后面", () => {
    const noise = Array.from({ length: 10 }, (_, i) => hit(`https://n${i}.example.com/${i}`, `行业综述 ${i}`));
    const mine = [
      hit("https://m1.example.com/a", "维信诺三季度业绩"),
      hit("https://m2.example.com/b", "", "维信诺与荣耀签约"),
      hit("https://m3.example.com/c", "维信诺 车载模组"),
    ];
    const filing = hit("https://www.szse.cn/disclosure/1", "维信诺 关于对外投资的公告");
    const out = reserveSlots([...noise, ...mine, filing], { subject: "维信诺", total: 8 });
    expect(out.slice(0, 3).map((x) => x.url)).toEqual([filing.url, mine[0].url, mine[1].url]);
    // 第三条主体材料没进保留位，但仍在原来那一段里排着，一条都不丢。
    expect(out).toContain(mine[2]);
    expect(out).toHaveLength(14);
  });

  it("不给主体名就只有披露那一类保留位", () => {
    const mine = hit("https://m1.example.com/a", "维信诺三季度业绩");
    const out = reserveSlots([...reposts, mine], { total: 8 });
    expect(out.map((x) => x.url)).toEqual([...reposts, mine].map((x) => x.url));
  });
});

describe("稳定与边界", () => {
  it("同类内部保持传入顺序", () => {
    const a = hit("https://www.cninfo.com.cn/a", "维信诺 A");
    const b = hit("https://www.sse.com.cn/b", "维信诺 B");
    const c = hit("https://www.szse.cn/c", "维信诺 C");
    expect(reserveSlots([a, b, c], { subject: "维信诺", total: 8 }).map((x) => x.url)).toEqual([a.url, b.url, c.url]);
    expect(reserveSlots([c, b, a], { subject: "维信诺", total: 8 }).map((x) => x.url)).toEqual([c.url, b.url, a.url]);
  });

  it("同一份输入跑两遍结果一样", () => {
    const input = [...reposts, hit("https://static.cninfo.com.cn/x.PDF", "维信诺 2025 年年度报告")];
    expect(reserveSlots(input, { subject: "维信诺", total: 8 })).toEqual(
      reserveSlots(input, { subject: "维信诺", total: 8 })
    );
  });

  it("空表、零位子、位子比保留位还少都不炸", () => {
    expect(reserveSlots([], { subject: "维信诺" })).toEqual([]);
    const input = [...reposts, hit("https://static.cninfo.com.cn/x.PDF", "维信诺 2025 年年度报告")];
    expect(reserveSlots(input, { subject: "维信诺", total: 0 })).toHaveLength(input.length);
    const one = reserveSlots(input, { subject: "维信诺", total: 1 });
    expect(one).toHaveLength(input.length);
    expect(one[0].url).toContain("cninfo");
  });

  it("默认 total 是 8", () => {
    const input = [...reposts, hit("https://static.cninfo.com.cn/x.PDF", "维信诺 2025 年年度报告")];
    expect(reserveSlots(input, { subject: "维信诺" })).toEqual(reserveSlots(input, { subject: "维信诺", total: 8 }));
  });
});
