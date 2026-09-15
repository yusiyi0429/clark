// src/lib/agent/talk/history.test.ts
import { describe, expect, it } from "vitest";
import { asHistory, packHistory } from "./history";
import type { AdvisorMessage } from "@/lib/data/types";

/*
 * 造数据的两条讲究，都是为了让断言真的咬得住：
 * 1. 每一轮的正文各不相同（带自己的序号），所以断言能指名道姓地说「第 1 轮那一段没了、
 *    第 40 轮那一段还在」。全用一样的填充字符的话，`not.toContain` 只能在**所有轮**都被
 *    压过时才成立 —— 那会逼实现去压最近那一半，而这正是这一版不该做的事。
 * 2. 正文里**不带**「第 N 轮我问：」这种标签。轮次编号是打包这一步自己贴的，测试数据里
 *    先贴一遍，实现就会看见双份前缀，然后去写一条剥前缀的正则来对付测试数据。
 */
const turns = (n: number): AdvisorMessage[] =>
  Array.from({ length: n }, (_, i) => [
    { id: `u${i}`, role: "user", text: `我的第 ${i + 1} 个问题。${"问".repeat(200)}`, at: "" },
    { id: `a${i}`, role: "agent", text: `我的第 ${i + 1} 个回答。${"答".repeat(200)}`, at: "" },
  ]).flat() as AdvisorMessage[];

describe("对话历史策略", () => {
  it("不到阈值：一句不压，原文全带 —— 两边都是原文，不许截断", () => {
    const p = packHistory(turns(5), { windowChars: 1_000_000, prefixChars: 0 });
    expect(p.compressedTurns).toBe(0);
    expect(p.keptTurns).toBe(5);
    // 整段原文都在，不是只有开头那一句
    expect(p.text).toContain(`我的第 1 个问题。${"问".repeat(200)}`);
    expect(p.text).toContain(`我的第 5 个回答。${"答".repeat(200)}`);
  });

  it("过了阈值：压最老一半，最近一半两边都留原文", () => {
    const p = packHistory(turns(40), { windowChars: 20_000, prefixChars: 4_000 });
    expect(p.compressedTurns).toBe(20);
    expect(p.keptTurns).toBe(20);
    // 老的那一半：编号与首句留着，原文没了
    expect(p.text).toContain("第 1 轮");
    expect(p.text).toContain("我的第 1 个问题。");
    expect(p.text).not.toContain(`我的第 1 个问题。${"问".repeat(200)}`);
    // 最近那一半：**问和答都是原文**，一边留一边压是错的
    expect(p.text).toContain(`我的第 40 个问题。${"问".repeat(200)}`);
    expect(p.text).toContain(`我的第 40 个回答。${"答".repeat(200)}`);
  });

  it("压过之后仍然答得出第 1 轮说了什么 —— 编号与主张两样都留", () => {
    const p = packHistory(turns(40), { windowChars: 20_000, prefixChars: 4_000 });
    expect(/第 1 轮[^\n]*我的第 1 个问题。/.test(p.text)).toBe(true);
  });
});

describe("请求体里那串消息转成历史", () => {
  it("他刚说的那一句不进历史 —— 它由 ask 单独带，进来就等于同一句问两遍", () => {
    const got = asHistory([
      { role: "user", content: "第一问" },
      { role: "assistant", content: "第一答" },
      { role: "user", content: "刚说的这一句" },
    ]);
    expect(got.map((m) => m.text)).toEqual(["第一问", "第一答"]);
  });

  it("assistant 换成 agent，user 还是 user", () => {
    const got = asHistory([
      { role: "assistant", content: "我答的" },
      { role: "user", content: "他问的" },
      { role: "user", content: "刚说的这一句" },
    ]);
    expect(got.map((m) => m.role)).toEqual(["agent", "user"]);
  });

  it("只有一句时历史是空的 —— 那一句就是他刚说的", () => {
    expect(asHistory([{ role: "user", content: "第一次开口" }])).toEqual([]);
  });
});
