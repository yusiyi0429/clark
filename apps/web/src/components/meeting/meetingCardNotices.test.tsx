import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TMyMeetingCard } from "@warmap/contracts";
import { MeetingCardNoticeList, meetingCardNotices } from "./MeetingCardNotices";

const meeting = (overrides: Partial<TMyMeetingCard>): TMyMeetingCard => ({
  meetingId: "m1", title: "接口切换会", endedAt: "2026-10-20T06:00:00.000Z", status: "pending", ...overrides,
});

describe("会议记录待确认：一场会一条", () => {
  it("两场会待确认是两条，各有会名和「待确认」；没有逐条确认、Co-Agent 和 CEO 分流的字样", () => {
    const meetings = [meeting({}), meeting({ meetingId: "m2", title: "渠道预算会" })];
    const html = renderToStaticMarkup(<MeetingCardNoticeList meetings={meetings} meetingBase="/me/meetings" onNavigate={() => undefined} />);
    expect(html).toContain("接口切换会");
    expect(html).toContain("渠道预算会");
    expect(html.match(/待确认/g)?.length).toBeGreaterThanOrEqual(2);
    for (const word of ["Co-Agent", "CEO 已确认", "Agent 代判", "其实没定", "不同意"]) expect(html).not.toContain(word);
    const notices = meetingCardNotices(meetings, "/me/meetings", vi.fn());
    expect(notices.map((notice) => [notice.title, notice.detail])).toEqual([["接口切换会", "待确认"], ["渠道预算会", "待确认"]]);
    expect(notices.every((notice) => notice.buttons.length === 0 && !notice.reason)).toBe(true);
  });

  it("状态标签：修改待确认、写入失败；点了去会议页", () => {
    const navigate = vi.fn();
    const notices = meetingCardNotices([meeting({ status: "edit_pending" }), meeting({ meetingId: "m2", title: "渠道预算会", status: "failed" })], "/meetings", navigate);
    expect(notices.map((notice) => notice.detail)).toEqual(["修改待确认", "写入失败"]);
    notices[1].onOpen?.(null);
    expect(navigate).toHaveBeenCalledWith("/meetings/m2", null);
  });

  it("没有待确认的会时不显示", () => {
    expect(renderToStaticMarkup(<MeetingCardNoticeList meetings={[]} meetingBase="/meetings" onNavigate={() => undefined} />)).toBe("");
  });
});
