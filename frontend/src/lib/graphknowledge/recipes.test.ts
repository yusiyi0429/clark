import { describe, expect, it } from "vitest";

import { MAX_CONTEXT_CHARS, finish } from "./recipes";

describe("上下文总预算", () => {
  it("上限逐字对齐实验台", () => {
    expect(MAX_CONTEXT_CHARS).toBe(16_000);
  });

  it("没超预算就原样拼，段间空一行", () => {
    expect(finish(["甲", "乙"])).toBe("甲\n\n乙");
  });

  it("超了就截断，并且**说出来** —— 悄悄少一段会被读成「图里就这么点东西」", () => {
    const out = finish(["头", "尾".repeat(MAX_CONTEXT_CHARS)]);
    expect(out.length).toBeLessThanOrEqual(MAX_CONTEXT_CHARS);
    expect(out.endsWith("（上下文超过总预算，末段已截断）")).toBe(true);
  });

  it("截断处的尾随空白去掉 —— 否则后缀前面会挂一串空格", () => {
    const filler = "丙".repeat(MAX_CONTEXT_CHARS - 40) + " ".repeat(30);
    const out = finish([filler, "丁".repeat(100)]);
    expect(out).not.toMatch(/\s\n\n（上下文超过总预算/);
  });
});
