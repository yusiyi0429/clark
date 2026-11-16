import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PartnerMeeting } from "@/lib/home/partnerMeetingFeed";
import type { HomeMeeting } from "./MeetingControl";

const feed = vi.hoisted(() => ({ items: [] as PartnerMeeting[], error: null as string | null, loaded: true, reload: () => undefined }));
vi.mock("@/lib/home/partnerMeetingFeed", () => ({ usePartnerMeetings: () => feed, PartnerMeetingsProvider: () => null }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ navigate: vi.fn() }) }));
vi.mock("./MeetingControl", () => ({ MeetingControl: () => <button type="button">现在开会</button> }));

import { MeetingsPage, meetingSections, nextMeetingTrail } from "./MeetingsPage";

// 此刻：北京时间 11 月 16 日 周一 11:46（设计稿第 11 节的真实数据）。
const NOW = Date.parse("2026-11-16T03:46:00Z");
const meet = (id: string, extra: Partial<PartnerMeeting>): PartnerMeeting => ({
  id: "meeting:" + id, meetingId: id, title: id, at: "2026-11-16T03:44:00Z", stage: "scheduled", statusText: "已预约",
  href: "/me/work/meetings/" + id, joinUrl: null, needsAction: false, source: "tianshu", ...extra,
} as PartnerMeeting);
const m44 = meet("m44", { title: "11月16日 11:44 的会", at: "2026-11-16T03:44:00Z", endsAt: "2026-11-16T04:44:00Z", statusText: "已到预约时间" });
const acceptance = meet("ys1", { title: "验收开会（主会话）", at: "2026-11-18T03:47:00Z", endsAt: "2026-11-18T04:47:00Z" });
const m41 = meet("m41", { title: "11月16日 11:41 的会", at: "2026-11-16T03:41:00Z", endsAt: "2026-11-16T03:41:30Z", stage: "attention", needsAction: true, statusText: "录音转写失败，打开会议查看原因" });
const acceptance2 = meet("ys2", { title: "验收开会 2（主会话）", at: "2026-11-12T16:59:00Z", endsAt: "2026-11-12T17:00:00Z", stage: "attention", needsAction: true, statusText: "缺少飞书授权，会议记录尚未取回" });
const far = meet("far", { title: "下周的会", at: "2026-11-24T02:00:00Z" });
const model = { account: { personId: "sun", displayName: "孙铭泽", role: "member" }, start: vi.fn() } as unknown as HomeMeeting;
const render = () => renderToStaticMarkup(<MeetingsPage meeting={model} go={() => undefined} />);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); feed.items = []; feed.error = null; feed.loaded = true; });
afterEach(() => { vi.useRealTimers(); });

describe("meetingSections：接下来、7 天后、已开完", () => {
  it("接下来按天分组；7 天以后的另放；开完的最近的在上", () => {
    const sections = meetingSections([far, acceptance2, m41, acceptance, m44], NOW);
    expect(sections.upcoming.map((day) => [day.label, day.items.map((item) => item.meetingId)])).toEqual([
      ["今天", ["m44"]],
      ["11月18日 周三", ["ys1"]],
    ]);
    expect(sections.later.map((item) => item.meetingId)).toEqual(["far"]);
    expect(sections.done.map((item) => item.meetingId)).toEqual(["m41", "ys2"]);
  });

  it("预约的过了结束时间就算开完", () => {
    const over = meet("over", { at: "2026-11-16T01:00:00Z", endsAt: "2026-11-16T02:00:00Z" });
    expect(meetingSections([over], NOW).done.map((item) => item.meetingId)).toEqual(["over"]);
  });
});

describe("nextMeetingTrail：左栏「会议」行行尾", () => {
  const later = meet("later", { at: "2026-11-16T06:30:00Z", endsAt: "2026-11-16T07:30:00Z" });
  const tomorrow = meet("tmr", { at: "2026-11-17T01:30:00Z", endsAt: "2026-11-17T02:30:00Z" });
  it("今天写钟点，明天写「明天 09:30」，更远写日期", () => {
    expect(nextMeetingTrail(meetingSections([later, tomorrow, acceptance], NOW), new Set(), NOW)).toBe("14:30");
    expect(nextMeetingTrail(meetingSections([tomorrow, acceptance], NOW), new Set(), NOW)).toBe("明天 09:30");
    expect(nextMeetingTrail(meetingSections([acceptance], NOW), new Set(), NOW)).toBe("11/18");
    expect(nextMeetingTrail(meetingSections([], NOW), new Set(), NOW)).toBeNull();
  });

  it("已经在「等你」里的那场跳过，写再下一场", () => {
    expect(nextMeetingTrail(meetingSections([m44, acceptance], NOW), new Set([m44.id]), NOW)).toBe("11/18");
  });
});

describe("会议页", () => {
  it("接下来是钟点加竖线，已开完是状态点；一场会只出现一次，没有「来源与详情」", () => {
    feed.items = [far, acceptance2, m41, acceptance, m44];
    const html = render();
    expect(text(html)).toContain("接下来 2");
    expect(text(html)).toContain("已开完 2");
    // 7 天内两场，7 天后那场收在「7 天后 1」里，也是接下来的行。
    expect((html.match(/data-row="upcoming"/g) ?? []).length).toBe(3);
    expect(html).toMatch(/<summary>7 天后 <span>1<\/span><\/summary><ul[^>]*><li[^>]*data-row="upcoming"/);
    expect((html.match(/data-row="done"/g) ?? []).length).toBe(2);
    expect(html).toMatch(/data-row="upcoming"[^]*?>11:44</);
    expect(text(html)).toContain("11/13 00:59 · 缺少飞书授权，会议记录尚未取回");
    expect(text(html)).toContain("今天 11:41 · 录音转写失败，打开会议查看原因");
    expect(text(html)).toContain("7 天后 1");
    expect(html).not.toContain("来源与详情");
    for (const title of ["11月16日 11:44 的会", "验收开会（主会话）", "11月16日 11:41 的会", "验收开会 2（主会话）"]) {
      expect(html.split(title).length - 1).toBe(1);
    }
  });

  it("页头有「现在开会」和「预约会议」", () => {
    const html = render();
    expect(html).toContain("现在开会");
    expect(html).toMatch(/<button[^>]*>预约会议<\/button>/);
  });

  it("到点的会行尾「加入会议」；只在飞书日历里的日程行尾开飞书", () => {
    feed.items = [
      { ...m44, joinUrl: "https://vc.feishu.cn/j/1" },
      meet("cal", { meetingId: null, title: "飞书日程", at: "2026-11-17T02:00:00Z", source: "feishu", href: "https://feishu.cn/calendar/1", sourceUrl: "https://feishu.cn/calendar/1" }),
    ];
    const html = render();
    expect(html).toMatch(/<button[^>]*>加入会议<\/button>/);
    expect(html).toMatch(/<a[^>]*href="https:\/\/feishu.cn\/calendar\/1"[^>]*target="_blank"[^>]*aria-label="在飞书打开"/);
  });

  it("空的时候各写一行", () => {
    const html = render();
    expect(text(html)).toContain("没有要开的会");
    expect(text(html)).toContain("近 7 天没有开过会");
  });

  it("没读到：「没有读到会议」加重试", () => {
    feed.error = "没有读到会议";
    const html = render();
    expect(text(html)).toContain("没有读到会议");
    expect(html).toMatch(/<button[^>]*>重试<\/button>/);
  });
});
