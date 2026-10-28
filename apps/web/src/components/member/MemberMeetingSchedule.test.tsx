import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemberMeetingSchedule } from "./MemberMeetingSchedule";

describe("主持人会后通知", () => {
  it("只在待跟进的会议显示重新安排和上传入口", () => {
    const item = { meetingId: "m", title: "核对排期", startsAt: "2026-09-30T07:00:00Z", endsAt: "2026-09-30T08:00:00Z", hostName: "主持人", href: "/me/meetings/m" };
    const render = (followUp: boolean) => renderToStaticMarkup(<MemberMeetingSchedule meetings={[{ ...item, followUp }]} onNavigate={() => undefined} />);
    expect(render(true)).toContain("重新安排");
    expect(render(true)).toContain("待交记录");
    expect(render(true)).toContain(">上传<");
    expect(render(true)).toContain('accept=".md,');
    expect(render(false)).not.toContain(">上传<");
  });

  it("交了记录还在生成会议卡的会原地显示进度，没生成出来写明", () => {
    const item = { meetingId: "m", title: "核对排期", startsAt: "2026-09-30T07:00:00Z", endsAt: "2026-09-30T08:00:00Z", hostName: "主持人", href: "/me/meetings/m", followUp: false };
    const render = (failed: boolean) => renderToStaticMarkup(<MemberMeetingSchedule meetings={[{ ...item, processing: { since: "2026-09-30T08:00:00Z", failed } }]} onNavigate={() => undefined} />);
    expect(render(false)).toContain("生成会议卡");
    expect(render(false)).toContain('role="timer"');
    expect(render(false)).not.toContain(">上传<");
    expect(render(true)).toContain("会议卡没生成");
  });
});
