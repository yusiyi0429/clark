/**
 * 只测 `wordingViolations` 这一组 —— 它是这个文件里**唯一两支深研都调**的东西
 * （`validateReport` 调，`pipeline.ts` 收口也调），所以它坏掉会同时打中两条链。
 *
 * 这个文件其余那二十来条只在 `TKOS_DR_V2=0` 那条对照链上跑，为什么、以及它们在默认那条链上
 * 各自被谁接了过去，写在 `validate.ts` 的文件头。那一批到今天一条测试都没有 —— 那是另一笔账，
 * 不在这里补：补了会让人以为「validate.ts 有测试」，而真正没人守的正是那一批。
 */
import { describe, expect, it } from "vitest";
import { validateReport, wordingViolations } from "./validate";

describe("wordingViolations", () => {
  it("回避式措辞、空词、member: 死链、感叹号、无依据的绝对化，各报各的", () => {
    const rules = wordingViolations(
      [
        "机会与挑战并存，这一套打法必然赢。",
        "溯源写的是 member:obj_7f3a 这种本体内部编号！",
      ].join("\n")
    ).map((v) => v.rule);

    expect(rules).toContain("G-08"); // 机会与挑战并存
    expect(rules).toContain("G-09"); // 打法
    expect(rules).toContain("A7-03"); // member:xxx
    expect(rules).toContain("G-10"); // ！
    expect(rules).toContain("G-05"); // 「必然」且这一句里没有任何数字或引用编号
  });

  it("一律 p1 —— 这一组是记账不是闸", () => {
    const v = wordingViolations("机会与挑战并存，这一套打法必然赢！member:obj_1");
    expect(v.length).toBeGreaterThan(0);
    expect(v.every((x) => x.severity === "p1")).toBe(true);
  });

  it("干净的正文一条都不报，空正文也不报", () => {
    expect(wordingViolations("评分权重的下降来自招标模板的一次改版，不是客户的决策权转移。")).toEqual([]);
    expect(wordingViolations("")).toEqual([]);
    expect(wordingViolations("   ")).toEqual([]);
  });

  it("绝对化那一句带了数字就不报 —— 有依据的断言本来就该硬", () => {
    const rules = wordingViolations("这一档在 3 家客户上必然成立。").map((v) => v.rule);
    expect(rules).not.toContain("G-05");
  });

  it("`validateReport` 仍旧带着这一组 —— 提出去是为了共用，不是把对照链那一侧摘掉", () => {
    const report = [
      "评分权重下降来自模板改版，不是决策权转移",
      "",
      "## 核心判断",
      "",
      "机会与挑战并存。",
      "",
      "## 最终判断　决定性证据　对我们的当前含义",
      "",
      "未联网。",
    ].join("\n");
    expect(validateReport(report).map((v) => v.rule)).toContain("G-08");
  });
});
