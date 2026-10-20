import { describe, expect, it } from "vitest";
import type { TRequestListItem } from "@warmap/contracts";
import { impactNotices, requestNotices } from "./RequestNotices";

describe("会后影响：单独一组，不混进请求", () => {
  const item = (overrides: Partial<TRequestListItem>): TRequestListItem => ({
    id: "r1", kind: "relay", title: "填备案表", status: "open", initiatorName: "林晓", createdAt: "2026-10-18T14:00:00.000Z", sentAt: "2026-10-18T14:00:00.000Z",
    myStatus: "pending", recipientNames: ["陈一凡"], recipientsDone: 0, openQuestions: 0, unread: false, ...overrides,
  });
  it("影响卡只进「会后影响」；处理过且已读的不再列", () => {
    const inbox = [item({}), item({ id: "r2", kind: "impact", title: "会议页改接新纪要接口", unread: true }), item({ id: "r3", kind: "impact", myStatus: "done" })];
    expect(impactNotices(inbox).map((notice) => [notice.id, notice.tone])).toEqual([["r2", "amber"]]);
    expect(requestNotices(inbox, []).map((notice) => notice.id)).toEqual(["r1"]);
  });
});
