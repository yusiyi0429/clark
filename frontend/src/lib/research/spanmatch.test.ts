import { describe, expect, it } from "vitest";

import { excerpt, locate } from "./spanmatch";

/** 一段像真页面的正文：全角标点、中英混排、带数字。 */
const TEXT =
  "据国家某局消息，2025 年末全国算力总规模为 1590 EFLOPS，" +
  "其中智能算力占比约 32%。相关口径见《算力发展统计口径（2025）》。";

describe("引句定位", () => {
  it("逐字对得上时给出原文坐标", async () => {
    const span = locate("2025 年末全国算力总规模为 1590 EFLOPS", TEXT);
    expect(span).not.toBeNull();
    expect(TEXT.slice(span![0], span![1])).toBe("2025 年末全国算力总规模为 1590 EFLOPS");
  });

  it("宽容的只有排版：标点、空格、全半角、大小写", async () => {
    /*
     * 模型抄引句时最常见的漂移就是这几类。把它们判成两句话，会让一批本来正确的证据
     * 卡在入账闸上，而人会因此去关掉这道闸 —— 那比宽容排版糟得多。
     */
    expect(locate("2025年末全国算力总规模为1590EFLOPS", TEXT)).not.toBeNull();
    expect(locate("算力发展统计口径（2025）", TEXT)).not.toBeNull();
    expect(locate("1590 eflops", TEXT)).not.toBeNull();
  });

  it("数字一个都不折", async () => {
    // 这一条就是这一层存在的理由：报告里唯一会被人当场纠正的东西就是数字。
    expect(locate("1591 EFLOPS", TEXT)).toBeNull();
    expect(locate("2024 年末全国算力总规模", TEXT)).toBeNull();
    expect(locate("智能算力占比约 23%", TEXT)).toBeNull();
  });

  it("空引句一律定位不到", async () => {
    // 空串在归一化空间里是任何字符串的子串，会命中 [0,0)，于是空引句反而入账成功。
    expect(locate("", TEXT)).toBeNull();
    expect(locate("　，。", TEXT)).toBeNull();
  });

  it("整页里没有这句话就是没有", async () => {
    expect(locate("全国算力总规模同比下降", TEXT)).toBeNull();
  });

  it("摘出来的是原文那一段，不是模型抄的那一段", async () => {
    /*
     * 出口对账拿去比对的必须是原文。返回模型抄的版本，就等于让模型自己定义「原文写了
     * 什么」—— 它抄丢的那个全角括号会一路过关。
     */
    expect(excerpt("算力总规模为1590EFLOPS", TEXT)).toBe("算力总规模为 1590 EFLOPS");
    expect(excerpt("这句话页面里没有", TEXT)).toBe("");
  });

  it("两头的排版符号不算在区间里", async () => {
    /*
     * 区间是「第一个留下的字符」到「最后一个留下的字符」，所以引句两头的标点不会进
     * `excerpt`。钉住它是因为出口对账会拿这段原文去比对 —— 首尾差一个括号不该被读成
     * 两段不同的原文，而如果哪天区间算法改成包含首尾标点，这条会红。
     */
    expect(excerpt("（算力发展统计口径（2025））", TEXT)).toBe("算力发展统计口径（2025");
  });
});
