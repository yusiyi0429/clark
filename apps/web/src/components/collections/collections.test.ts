import { describe, expect, it } from "vitest";
import type { TRequestListItem } from "@warmap/contracts";
import { requestNotices } from "../requests/RequestNotices";
import { deadlineText, fromPickerValue, toPickerValue } from "./collectionApi";

const item = (overrides: Partial<TRequestListItem>): TRequestListItem => ({
  id: "r1", kind: "collection", title: "灯塔项目每周开销（10/19 周）", status: "open", initiatorName: "陈思远", createdAt: "2026-10-19T02:00:00.000Z",
  sentAt: "2026-10-19T02:00:00.000Z", myStatus: "pending", recipientNames: ["王雨桐", "李嘉禾"], recipientsDone: 1, openQuestions: 0, unread: false, ...overrides,
});

describe("③ 信息收集", () => {
  it("通知栏：收到的写「已填 x/y」，确认过的写「已确认」；发出的写「x/n 已确认」", () => {
    expect(requestNotices([item({ fieldsFilled: { filled: 3, required: 4 } })], [])[0].detail).toBe("陈思远 · 10/19 10:00 · 已填 3/4");
    expect(requestNotices([item({ myStatus: "done", unread: true })], [])[0].detail).toBe("陈思远 · 10/19 10:00 · 已确认");
    expect(requestNotices([], [item({ myStatus: null, unread: true })])[0].detail).toBe("1/2 已确认");
  });

  it("截止时间按公司时区显示，选择器的值来回不变", () => {
    expect(deadlineText("2026-10-23T10:00:00.000Z")).toBe("10/23 周五 18:00");
    expect(toPickerValue("2026-10-23T10:00:00.000Z")).toBe("2026-10-23T18:00");
    expect(fromPickerValue("2026-10-23T18:00")).toBe("2026-10-23T10:00:00.000Z");
  });
});
