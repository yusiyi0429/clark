import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TMeetingWorkFeedItem } from "@warmap/contracts";
import { ConfirmAndHandOff, MeetingWorkFeedEntry, suggestedMeetingTarget } from "./MeetingWorkHandoffs";

const item: TMeetingWorkFeedItem = {
  kind: "meeting_handoff", id: "00000000-0000-4000-8000-000000000003", at: "2026-11-13T09:31:00Z",
  target: { kind: "topic", projectId: "00000000-0000-4000-8000-000000000001", id: "00000000-0000-4000-8000-000000000002", projectName: "品牌建设", name: "官网" },
  conclusion: { confirmationRef: "00000000-0000-4000-8000-000000000004", requestId: "nexus-1", itemId: "change-1", meetingId: "external-meeting",
    revision: 4, confirmedAt: "2026-11-13T09:30:00Z", confirmedBy: "owner", decision: "amended", question: "首页方向如何调整？",
    content: { classification: "fact", targetRef: "homepage", value: "本人改后的首页方向" },
    source: { id: "minutes-1", version: "v2", hash: "hash", minutesRef: "https://example.com/minutes",
      quote: null, readState: "reference_only", reference: null, turnId: null } },
  instruction: "延续原版", criteria: [{ kind: "task", id: "task1", revision: null, index: 1, text: "核对页面文案" }],
  authorizedAt: "2026-11-13T09:30:30Z", authorizedBy: "owner", superseded: false,
};

describe("会议变化在原工作中可读", () => {
  it("建议去向只使用本人可选的同一个本体 Task 标识", () => {
    const task = { ...item.target, kind: "task" as const };
    expect(suggestedMeetingTarget(task.id + "@5", [item.target, task])).toBe(task);
    expect(suggestedMeetingTarget(task.id, [item.target])).toBeNull();
    expect(suggestedMeetingTarget(task.name, [task])).toBeNull();
  });
  it("展示确认原文、本次交代、可打开的真实去向和来源读取状态", () => {
    const html = renderToStaticMarkup(<MeetingWorkFeedEntry item={item} />);
    for (const text of ["已递送", "本人改后的首页方向", "延续原版", "核对页面文案", "仅有出处", "external-meeting", "确认版本 4",
      "https://example.com/minutes", `/me/work/topics/${item.target.id}`]) expect(html).toContain(text);
    expect(html).not.toContain("已开工");
    expect(html).not.toContain("/meetings/external-meeting");
  });
  it("过期的版本保留历史标识，出处只显示 Nexus 提供的片段", () => {
    const updated = { ...item, superseded: true, conclusion: { ...item.conclusion, source: { ...item.conclusion.source, readState: "excerpt" as const, quote: "本次摘录" } } };
    const html = renderToStaticMarkup(<MeetingWorkFeedEntry item={updated} />);
    expect(html).toContain("此确认已被新版替代");
    expect(html).toContain("已收到摘录");
    expect(html).toContain("本次摘录");
  });
  it("待确认项先让本人选择去向", () => {
    const html = renderToStaticMarkup(<ConfirmAndHandOff requestId="request-row" onConfirmed={() => undefined} />);
    expect(html).toContain("选择去向并确认");
    expect(html).not.toContain("已递送");
  });
});
