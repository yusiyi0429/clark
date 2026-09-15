// src/lib/agent/talk/system.test.ts
import { describe, expect, it } from "vitest";
import { buildTalkSystem, TALK_SYSTEM, templateSmells } from "./system";

describe("对谈 system prompt", () => {
  it("九条回应原则都在，改判纪律那条逐字在", () => {
    for (const must of [
      "被挑战必须表态", "改变判断前，必须能指出", "判断真变了才说变了",
      "未知只在决定性时才提", "我的先验，未验证", "evidence_lookup", "预判他的挑战",
      "答他这一句，不答别的", "他这一句不是问题的时候",
    ]) expect(TALK_SYSTEM).toContain(must);
  });

  /*
   * 第 8 条挡的是屏幕上真发生过的那一次：他只打了个招呼，回应就把报告的核心判断整段
   * 复述了一遍。第 3 条只管住「不复述当前判断」—— 报告正文不在它的射程里，所以这条
   * 单独钉：不主动总结、不顺手报别的、检索也只查他问的那个缺口。
   */
  it("不许主动总结报告，检索也只查他问的那一处", () => {
    expect(TALK_SYSTEM).toContain("不主动总结报告");
    expect(TALK_SYSTEM).toContain("只查他问的");
  });

  /*
   * 第 9 条。只有第 8 条的那一版当天就复发了：他打的是「你好」，那不是「问了别的一件
   * 事」，第 8 条整条够不着它。所以这一条单独钉 —— 谁哪天把两条合成一条，这里会红。
   */
  it("他打招呼那一轮：回一句招呼，不许拿它当开口的由头", () => {
    expect(TALK_SYSTEM).toContain("就回一句招呼");
    expect(TALK_SYSTEM).toContain("不要拿它当开口的由头");
  });

  it("不许出现固定回应模板的指令", () => {
    expect(TALK_SYSTEM).not.toMatch(/回应分三段|按以下格式|依次输出/);
  });

  /*
   * 上一版这条写的是「自己 `replaceAll` 一遍，再断言换完了没有占位符」—— 那句断言在
   * `replaceAll` 之后**恒真**，换名那个动作是测试自己做的，生产那两处一次都没碰过。
   * 现在换名只有 `buildTalkSystem` 一处，断言落在它身上：先钉住原文里真有占位符
   * （否则下面那条 `not.toContain` 又变成恒真），再钉住它出来那一份里没有。
   *
   * 生产上真发出去那一份换没换名，由 `src/app/api/chat/route.test.ts` 钉住。
   */
  it("换名只有一处：原文里有占位符，换完那一份里没有", () => {
    expect(TALK_SYSTEM).toContain("{user}");
    const system = buildTalkSystem("沈");
    expect(system).not.toContain("{user}");
    expect(system).toContain("你是 沈 的研究幕僚");
    /*
     * 正文里一共三处占位：开头那句、紧接着「{user} 的习惯是」那句、第 7 条。
     * 上面那条 `not.toContain` 本来就一网打尽，这两条挑的是首尾两处，读的人一眼看得出
     * 换的不止一处。数字要对得上正文 —— 数错的注释和别的假注释同一档。
     */
    expect(system).toContain("沈 的习惯是");
    expect(system).toContain("对 沈 的已知关注点");
  });

  it("模板句探测：那两句套话认得出来", () => {
    expect(templateSmells("更新后的判断是：仍然看多。")).toHaveLength(1);
    expect(templateSmells("这一点我改了，因为你刚才提到的口径问题。")).toHaveLength(0);
  });
});

describe("第二人称与程序复算（2026-09-05）", () => {
  it("system 明写直接对他说话，禁止「他问的是」这类向第三方汇报的句子", () => {
    expect(TALK_SYSTEM).toContain("永远直接对他说话");
    expect(TALK_SYSTEM).toContain("他问的是");
  });
  it("报告里的算式一律走 report_calculate，不心算、不换算成金额", () => {
    expect(TALK_SYSTEM).toContain("report_calculate");
    expect(TALK_SYSTEM).toContain("不心算");
    expect(TALK_SYSTEM).toContain("换算成金额");
  });
});
