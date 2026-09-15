import { describe, expect, it } from "vitest";
import { noticeOrder, noticeTransparency, readNoticeReceipts } from "./notifications";

describe("prototype notice business rules", () => {
  it("starts in the screenshot order; lower transparency is earlier", () => {
    expect(noticeOrder({})).toEqual(["confirmation", "agenda", "inquiry", "monthly"]);
    expect(noticeTransparency("confirmation", {})).toBeLessThan(noticeTransparency("inquiry", {}));
  });
  it("moves handled notices behind unresolved notices and preserves deterministic ties", () => {
    const receipts = { confirmation: { label: "已确认" }, inquiry: { label: "已回复" } };
    expect(noticeOrder(receipts)).toEqual(["agenda", "monthly", "confirmation", "inquiry"]);
    expect(noticeTransparency("confirmation", receipts)).toBeGreaterThan(noticeTransparency("monthly", receipts));
    expect(noticeOrder({ inquiry: receipts.inquiry })).toEqual(["confirmation", "agenda", "monthly", "inquiry"]);
  });
  it("does not treat a reply or an issue promotion as a decision", () => {
    expect(noticeTransparency("inquiry", { inquiry: { label: "已保存回复" } })).toBe(noticeTransparency("inquiry", {}));
    expect(noticeTransparency("inquiry", { inquiry: { label: "已升级为议题" } })).toBe(noticeTransparency("inquiry", {}));
  });
  it("ignores malformed browser state without turning it into a confirmation", () => {
    expect(readNoticeReceipts("broken")).toEqual({});
    expect(readNoticeReceipts('{"confirmation":true,"inquiry":{"label":12},"monthly":{"detail":"草稿"}}')).toEqual({});
    expect(readNoticeReceipts('{"confirmation":{"label":"已确认","detail":"保留灯塔优先"},"unknown":{"label":"x"}}')).toEqual({ confirmation: { label: "已确认", detail: "保留灯塔优先" } });
  });
});
