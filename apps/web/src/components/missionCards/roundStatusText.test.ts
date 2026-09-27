import { describe, expect, it } from "vitest";
import { personalPayload } from "./personalMissionFixture";
import { roundStatusText } from "./roundStatusText";

describe("个人卡与成员战场共用本轮状态句", () => {
  it("普通 Owner 的页头和战场状态使用同一句话", () => {
    const round = { ...personalPayload.round, approver: false };
    expect(roundStatusText(round, { cardId: "card", feedbackCount: 3 })).toBe("讨论中 · 这张卡 3 条意见");
  });
  it("没有本人卡时按全战场表述，不把他人的卡称为这张卡", () => {
    const round = { ...personalPayload.round, approver: false, counts: { ...personalPayload.round.counts, feedback: 7 } };
    expect(roundStatusText(round, { feedbackCount: 0 })).toBe("讨论中 · 全战场 7 条意见");
    expect(roundStatusText({ ...round, phase: "reviewing" }, { feedbackCount: 0 })).toBe("等刘明华拍板");
  });
  it("草稿、汇总中、拍板待办直接保持个人卡原句", () => {
    const round = personalPayload.round;
    expect(roundStatusText({ ...round, phase: "draft", approver: false }, { cardId: "card", feedbackCount: 0 })).toBe("草稿已整理 · 等刘明华统一开放讨论");
    expect(roundStatusText({ ...round, phase: "closed" }, { feedbackCount: 0 })).toBe("已截止 · 汇总中");
    expect(roundStatusText({ ...round, phase: "reviewing", todo: "2 条待你处理" }, { feedbackCount: 0 })).toBe("2 条待你处理");
    expect(roundStatusText({ ...round, phase: "reviewing", approver: false }, { cardId: "card", feedbackCount: 0 })).toBe("等刘明华拍板 · 无意见");
    const waiting = { ...round, phase: "reviewing" as const, approver: false, cards: round.cards.map((row) => ({ ...row, line: "等拍板" })) };
    expect(roundStatusText(waiting, { cardId: "card", feedbackCount: 0 })).toBe("等刘明华拍板");
  });
  it("已确定展示同一确认人和公司时间", () => {
    expect(roundStatusText({ ...personalPayload.round, phase: "confirmed" }, { feedbackCount: 0, confirmation: { byName: "刘明华", at: "2026-10-04T10:00:00.000Z" } })).toBe("已确定 · 刘明华 10/4 18:00");
  });
});
