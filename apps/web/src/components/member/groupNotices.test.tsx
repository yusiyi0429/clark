import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemberMeetingSchedule } from "./MemberMeetingSchedule";
import { memberNoticeGroups, quietNoticeCount } from "./memberNotices";

describe("群聊与会议通知", () => {
  it("邀请通知打开对应议题；已读通知不再出现", () => {
    const openGroup = vi.fn();
    const handlers = { markSeen: vi.fn().mockResolvedValue({ ok: true }), returnTask: vi.fn().mockResolvedValue({ ok: true }), openGroup };
    const notice = { id: "n1", kind: "thread_member_added" as const, text: "测试甲 拉你进议题「渠道投入」", objectType: "issue" as const,
      objectId: "issue-1", createdAt: "2026-09-27T00:00:00Z", readAt: null };
    const groups = memberNoticeGroups([notice], handlers);
    expect(groups.assigned).toHaveLength(1);
    groups.assigned[0].onOpen?.(null);
    expect(openGroup).toHaveBeenCalledWith("issue", "issue-1", null);
    expect(handlers.markSeen).toHaveBeenCalledWith(["n1"]);
    expect(memberNoticeGroups([{ ...notice, readAt: "2026-09-27T01:00:00Z" }], handlers).assigned).toEqual([]);
  });

  it("会议安排是整行可打开的深灰卡，含时段与主持人", () => {
    const html = renderToStaticMarkup(<MemberMeetingSchedule meetings={[{ meetingId: "m1", title: "渠道会", startsAt: "2026-09-30T02:00:00Z",
      endsAt: "2026-09-30T03:00:00Z", hostName: "测试乙", href: "/me/meetings/m1" }]} onNavigate={vi.fn()} />);
    expect(html).toContain('aria-label="会议安排"');
    expect(html).toContain("渠道会");
    expect(html).toContain("测试乙 主持");
    expect(html).toContain("10:00");
    expect(html).toContain("11:00");
    expect(html.match(/<button/g)).toHaveLength(1);
  });

  it("会议记录待确认的提醒在自己的一组里：不算进通知栏空状态，主持过会、确认完了的成员仍看到「暂时没有新通知」", () => {
    const pending = { id: "n2", kind: "meeting_card_pending" as const, text: "接口切换会 · 会议记录待确认", objectType: "meeting" as const,
      objectId: "m1", createdAt: "2026-10-20T00:00:00Z", readAt: null };
    expect(quietNoticeCount([pending])).toBe(0);
    expect(quietNoticeCount([{ ...pending, readAt: "2026-10-20T01:00:00Z" }])).toBe(0);
    const handlers = { markSeen: vi.fn(), returnTask: vi.fn() };
    const groups = memberNoticeGroups([pending], handlers);
    expect([...groups.assigned, ...groups.results]).toEqual([]);
    expect(quietNoticeCount([pending, { ...pending, id: "n3", kind: "task_returned" as const, objectType: "task" as const }])).toBe(1);
  });
});
