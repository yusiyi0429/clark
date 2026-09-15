/**
 * 议题研究页**默认落到哪一格**。
 *
 * 这一条是这一版最要紧的那句产品语义，而它坏了屏幕上不会报错：深研跑完之后一号位第一眼
 * 看到的东西会从「当前判断」变回一份等他签字的命令包，而那一屏本身画得好好的。
 *
 * 研究完成 ≠ 已形成决议 ≠ 应该立即派发命令。`SubjectCard.decision === true` 说的是这道题
 * 需要做选择，不是他现在授权派发 —— 所以「这一轮交了决断包」不许成为换默认页的理由。
 */
import { describe, expect, it } from "vitest";

import { shownTabOf } from "./advisor-view";

describe("默认页", () => {
  it("他没点过 → 当前判断。**有没有决断包都一样**", () => {
    expect(shownTabOf({ tab: null, hasBrief: false, staged: false })).toBe("probe");
    expect(shownTabOf({ tab: null, hasBrief: true, staged: false })).toBe("probe");
    // 连他之前已经走进过行动整理的那一轮，重新进这一页也还是先看判断。
    expect(shownTabOf({ tab: null, hasBrief: true, staged: true })).toBe("probe");
  });

  it("报告列表还没回来的那一瞬也是判断 —— 这一页不会当着他的面跳一次", () => {
    expect(shownTabOf({ tab: null, hasBrief: false, staged: false })).toBe("probe");
  });
});

describe("行动整理那一格", () => {
  it("他明确走进去之后才停得住", () => {
    expect(shownTabOf({ tab: "command", hasBrief: true, staged: true })).toBe("command");
  });

  it("没走进去过就落回判断 —— 这一格那时根本不长出来", () => {
    expect(shownTabOf({ tab: "command", hasBrief: true, staged: false })).toBe("probe");
  });

  it("决断包没了（退回参谋重拟）就落回判断，不留一屏空白", () => {
    expect(shownTabOf({ tab: "command", hasBrief: false, staged: true })).toBe("probe");
  });

  it("别的几格他点了就是他点的", () => {
    expect(shownTabOf({ tab: "intel", hasBrief: true, staged: true })).toBe("intel");
    expect(shownTabOf({ tab: "knowledge", hasBrief: false, staged: false })).toBe("knowledge");
  });
});
