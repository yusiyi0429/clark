// 卡标题的规矩（和云端 apps/api/src/cardTitle.ts 同一套）：短的动宾短语，中文 12 字以内，不带括号冒号句号。
import { describe, expect, it } from "vitest";
import { cardTitleProblem } from "../src/cardTitle.js";

describe("卡标题", () => {
  it("短的动宾短语合格；中文按 2、英文按 1 算宽度，32 以内", () => {
    for (const ok of ["本机按岗位拉起会话", "派活单网页", "Add pairing retry button", "改登录页", "接 TokenHub 计费"]) expect(cardTitleProblem(ok), ok).toBeNull();
    expect(cardTitleProblem("一二三四五六七八九十一二三四五六")).toBeNull(); // 16 个字正好 32
  });
  it("太长、带括号冒号句号的退回重写，说清怎么改", () => {
    expect(cardTitleProblem("一二三四五六七八九十一二三四五六七")).toContain("太长");
    expect(cardTitleProblem("Rewrite the whole local runner pairing flow end to end")).toContain("太长");
    for (const bad of ["网页：派活单", "派活单（网页）", "改登录页。", "Fix login.", "接计费(TokenHub)", "派活单【网页】"]) {
      expect(cardTitleProblem(bad), bad).toContain("不要带括号、冒号、句号");
    }
  });
});
