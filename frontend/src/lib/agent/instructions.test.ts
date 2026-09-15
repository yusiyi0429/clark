/*
 * 旧路那份说话规矩（`SYSTEM_INSTRUCTIONS`）。
 *
 * 这一份从前一条测试都没有 —— 而它并不是「留着对照的老代码」：有没有深研报告决定这一栏
 * 走哪一份提示词（`api/chat/route.ts` 的 `talkGate`），**分诊那一整页永远走这一份**，
 * 因为潜在议题手上还没有深研报告。2026-08-31 他在分诊里只打了「你好」，回来一整屏预研
 * 结论 —— 那一次走的就是这一份。
 *
 * 所以这里钉的不是「字面别改」，是这一份里**两句会互相打架的话**：下面第二条注释写了
 * 是哪两句。剩下几条钉的是产品上不许丢的硬约束（不编数字、不造新词、不代他确认）。
 */

import { describe, expect, it } from "vitest";

import { SYSTEM_INSTRUCTIONS } from "./instructions";

describe("参谋在议题研究那一栏说话的规矩", () => {
  it("打招呼那一档写明了：回一句招呼，不许借它把材料报一遍", () => {
    expect(SYSTEM_INSTRUCTIONS).toContain("就回一句招呼");
    expect(SYSTEM_INSTRUCTIONS).toContain("不要主动做总结");
  });

  /*
   * 这条是那次事故的真正原因，单独钉。
   *
   * 「每一轮都要给出你自己的判断」和「答他这一句，不答别的」摆在同一份提示词里，
   * 他打招呼那一轮两句直接冲突 —— 前者是无条件的「每一轮」，后者管的是「他问了别的
   * 一件事」，够不着「他根本没问」。模型选了前者，于是一句「你好」换来一整屏。
   *
   * 修法不是删掉那句（他问了实质问题时不许绕开，仍然是这个产品的立身之本），
   * 是给它加前提。谁哪天把前提去掉，这里会红。
   */
  it("「每一轮都要给出判断」带着前提，不是无条件的", () => {
    expect(SYSTEM_INSTRUCTIONS).toContain("他问了实质问题的每一轮，都要给出你自己的判断");
    expect(SYSTEM_INSTRUCTIONS).not.toMatch(/(^|\n)每一轮都要给出你自己的判断/);
  });

  it("四条硬约束一条都不许丢", () => {
    for (const must of [
      "只用上下文里给出的事实和数字", // 不编数字
      "不要造新词",
      "不许代他确认",
      "不要写 markdown",
    ]) expect(SYSTEM_INSTRUCTIONS).toContain(must);
  });

  /*
   * 公司名、人名、判断编号一个都不许写死在这一份里 —— 那些由 `buildAdvisorContext`
   * 从当下的 store 现算出来递进去。硬编码一个公司名，等于给模型开了一条不看上下文
   * 也能作答的路（理由整段写在 `instructions.ts` 头上）。
   */
  it("提示词里不写死公司名和人名", () => {
    for (const forbidden of ["词元云集", "TokenKing", "王总", "刘总"]) {
      expect(SYSTEM_INSTRUCTIONS).not.toContain(forbidden);
    }
  });
});
