import { describe, expect, it } from "vitest";
import { personalPayload } from "./personalMissionFixture";
import { roundStatusText } from "./roundStatusText";

describe("任务卡与成员战场共用本人确认状态", () => {
  it("起草中直接写 Co-Agent 正在起草", () => {
    expect(roundStatusText({ ...personalPayload.round, phase: "drafting" }, { feedbackCount: 0 })).toBe("Co-Agent 正在起草");
  });
  it("普通 Owner 的页头和战场状态使用同一句话", () => {
    const round = { ...personalPayload.round, approver: false };
    expect(roundStatusText(round, { cardId: "card", feedbackCount: 3 })).toBe("待本人确认");
    const completed = { ...round, cards: round.cards.map((row) => ({ ...row, ownerConfirmedAt: "2026-10-01T01:00:00Z" })) };
    expect(roundStatusText(completed, { cardId: "card", feedbackCount: 3 })).toBe("本人已确认");
    expect(roundStatusText({ ...completed, approver: true, counts: { ...completed.counts, unreviewed: 0 } }, { cardId: "card", feedbackCount: 3 })).toBe("本人已确认 1/1");
  });
  it("没有本人卡时按全战场表述，不把他人的卡称为这张卡", () => {
    const round = { ...personalPayload.round, approver: false, counts: { ...personalPayload.round.counts, feedback: 7 } };
    expect(roundStatusText(round, { feedbackCount: 0 })).toBe("本人已确认 0/1");
    expect(roundStatusText({ ...round, phase: "reviewing" }, { feedbackCount: 0 })).toBe("待战场 DRI 刘明华确认任务组合");
  });
  it("草稿、汇总中、拍板待办直接保持任务卡原句", () => {
    const round = personalPayload.round;
    expect(roundStatusText({ ...round, phase: "draft", approver: false }, { cardId: "card", feedbackCount: 0 })).toBe("任务卡尚未交给本人确认");
    expect(roundStatusText({ ...round, phase: "draft", approver: false, draftFailures: [{ ownerId: "owner", ownerName: "白田田", message: "超时" }] }, { cardId: "card", feedbackCount: 0 })).toBe("起草未完成 · 等刘明华重试");
    expect(roundStatusText({ ...round, phase: "closed" }, { feedbackCount: 0 })).toBe("仍有 1 人待本人确认");
    expect(roundStatusText({ ...round, phase: "closed", counts: { ...round.counts, unreviewed: 0 } }, { feedbackCount: 0 })).toBe("Co-Agent 正在统一核对");
    expect(roundStatusText({ ...round, phase: "reviewing", todo: "2 条待你处理" }, { feedbackCount: 0 })).toBe("2 条待你处理");
    expect(roundStatusText({ ...round, phase: "reviewing", approver: false }, { cardId: "card", feedbackCount: 0 })).toBe("待战场 DRI 刘明华确认任务组合");
    const waiting = { ...round, phase: "reviewing" as const, approver: false, cards: round.cards.map((row) => ({ ...row, line: "等拍板" })) };
    expect(roundStatusText(waiting, { cardId: "card", feedbackCount: 0 })).toBe("待战场 DRI 刘明华确认任务组合");
  });
  it("全员确认后展示真实 Co-Agent 核对状态，完成后由战场 DRI 确认任务组合", () => {
    const round = { ...personalPayload.round, phase: "reviewing" as const, todo: null };
    const report = { status: "completed" as const, summary: "目标与依赖已核对", findings: [], error: null, completedAt: "2026-10-01T01:00:00Z", retryAction: null };
    expect(roundStatusText({ ...round, coAgentReview: report }, { feedbackCount: 0 })).toBe("待战场 DRI 确认任务组合");
    for (const status of ["queued", "running"] as const) expect(roundStatusText({ ...round, coAgentReview: { ...report, status } }, { feedbackCount: 0 })).toBe("Co-Agent 正在统一核对");
    expect(roundStatusText({ ...round, coAgentReview: { ...report, status: "failed" } }, { feedbackCount: 0 })).toBe("Co-Agent 核对未完成");
  });
  it("已确定展示同一确认人和公司时间", () => {
    expect(roundStatusText({ ...personalPayload.round, phase: "confirmed" }, { feedbackCount: 0, confirmation: { byName: "刘明华", at: "2026-10-04T10:00:00.000Z" } })).toBe("已确定 · 刘明华 10/4 18:00");
  });
  it("已确定后接本卡已采纳的更正数；拍板人有待处理申请时写待办，月份已过不再催", () => {
    const confirmation = { byName: "刘明华", at: "2026-10-04T10:00:00.000Z" };
    const round = { ...personalPayload.round, phase: "confirmed" as const, counts: { ...personalPayload.round.counts, corrections: 2 } };
    expect(roundStatusText({ ...round, approver: false }, { feedbackCount: 0, confirmation, corrected: 3 })).toBe("已确定 · 刘明华 10/4 18:00 · 更正 3 处");
    expect(roundStatusText({ ...round, approver: true, todo: "2 条更正申请待你处理" }, { feedbackCount: 0, confirmation, corrected: 3 })).toBe("2 条更正申请待你处理");
    // 月份过后服务端 todo 为空，但仍在等的申请照样计数；不能退回「待你处理」。
    expect(roundStatusText({ ...round, approver: true, todo: null }, { feedbackCount: 0, confirmation, corrected: 1 })).toBe("已确定 · 刘明华 10/4 18:00 · 更正 1 处");
  });
});
