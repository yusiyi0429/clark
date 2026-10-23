import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TFeishuMinuteInboxItem, TMyMeetingCard } from "@warmap/contracts";
import { MeetingCardNoticeList, meetingCardNotices, minuteNotices, type MinuteActs } from "./MeetingCardNotices";

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

const item = (overrides: Partial<TFeishuMinuteInboxItem> = {}): TFeishuMinuteInboxItem => ({
  minuteToken: "obcn1", title: "产品周会", startsAt: "2026-10-23T06:00:00.000Z", endsAt: "2026-10-23T07:10:00.000Z",
  attendees: [{ personId: "p1", displayName: "孙铭泽" }], otherAttendees: 0, suggestion: null, ...overrides,
});
const now = new Date("2026-10-23T08:00:00.000Z");
const acts = (): MinuteActs => ({
  organize: vi.fn(async () => ({ ok: true as const })),
  attach: vi.fn(async () => ({ ok: true as const })),
  ignore: vi.fn(async () => ({ ok: true as const })),
});

describe("会议记录待整理：飞书里直接开的会", () => {
  it("待整理：标题、下一行和按钮", async () => {
    const act = acts();
    const minute = item();
    const [notice] = minuteNotices([minute], act, now);
    expect(notice).toMatchObject({ id: "feishu-minute:obcn1", title: "产品周会", detail: "飞书会议 · 今天 14:00–15:10 · 待整理", tone: "neutral" });
    expect(notice.onOpen).toBeUndefined();
    expect(notice.buttons.map((button) => [button.label, Boolean(button.emphasis)])).toEqual([["整理", true], ["忽略", false]]);
    await notice.buttons[0].run();
    expect(act.organize).toHaveBeenCalledWith(minute);
    await notice.buttons[1].run();
    expect(act.ignore).toHaveBeenCalledWith(minute);
  });

  it("属于天枢里约好的会", async () => {
    const act = acts();
    const minute = item({ suggestion: { meetingId: "m9", title: "Inception 设计会" }, startsAt: "2026-10-23T02:02:00.000Z", endsAt: "2026-10-23T03:15:00.000Z" });
    const [notice] = minuteNotices([minute], act, now);
    expect(notice.detail).toBe("飞书会议 · 今天 10:02–11:15");
    expect(notice.buttons.map((button) => [button.label, Boolean(button.emphasis)])).toEqual([["记到天枢里的「Inception 设计会」", true], ["不是这场，另建一场", false], ["忽略", false]]);
    await notice.buttons[1].run();
    expect(act.organize).toHaveBeenCalledWith(minute);
    expect(act.attach).not.toHaveBeenCalled();
    await notice.buttons[0].run();
    expect(act.attach).toHaveBeenCalledWith(minute);
  });

  it("不是今天写日期", () => {
    const [notice] = minuteNotices([item()], acts(), new Date("2026-10-24T08:00:00.000Z"));
    expect(notice.detail).toBe("飞书会议 · 10/23 14:00–15:10 · 待整理");
  });

  it("同一组里待整理在前，计数两样都算", () => {
    const html = renderToStaticMarkup(<MeetingCardNoticeList meetings={[meeting({})]} minutes={[item()]} meetingBase="/me/meetings" onNavigate={() => undefined} />);
    expect(html.indexOf("产品周会")).toBeGreaterThan(-1);
    expect(html.indexOf("产品周会")).toBeLessThan(html.indexOf("接口切换会"));
    expect(html).toContain('aria-label="2 项待处理"');
    const only = renderToStaticMarkup(<MeetingCardNoticeList meetings={[]} minutes={[item()]} meetingBase="/me/meetings" onNavigate={() => undefined} />);
    expect(only).toContain("产品周会");
    for (const mark of ["。", "！", "？"]) expect(only).not.toContain(mark);
  });
});
