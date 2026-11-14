import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { PartnerMeeting } from "@/lib/home/partnerMeetingFeed";
import type { WaitingItem } from "@/lib/home/types";
import type { HomeMeeting } from "./MeetingControl";
import { PartnerHomeMeetings, PartnerMeetingInbox, homeMeetingGroups, meetingWaitingItems } from "./PartnerMeetings";

const feed = vi.hoisted(() => ({ items: [] as PartnerMeeting[], error: null as string | null, reload: vi.fn() }));
vi.mock("@/lib/home/partnerMeetingFeed", () => ({ usePartnerMeetings: () => feed, PartnerMeetingsProvider: () => null }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ navigate: vi.fn() }) }));
vi.mock("./MeetingControl", () => ({ MeetingControl: () => <button>现在开会</button> }));

const now = Date.parse("2026-11-13T05:30:00Z");
const meeting = (id: string, overrides: Partial<PartnerMeeting> = {}): PartnerMeeting => ({
  id: "meeting:" + id, meetingId: id, title: id, at: new Date(now).toISOString(), stage: "scheduled",
  statusText: "已预约", needsAction: false, source: "tianshu", href: "/me/work/meetings/" + id, joinUrl: null, ...overrides,
});
const model = { account: { personId: "owner", displayName: "主持人", role: "member" } } as HomeMeeting;
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); feed.items = []; feed.error = null; });
afterEach(() => vi.useRealTimers());

describe("首页会议和伙伴收件使用同一条记录", () => {
  it("按公司日历展示近期、过去未处理以及更远的天枢预约；同标题的不同场次独立", () => {
    const historic = "2026-11-01T02:00:00Z", future = "2026-11-22T02:00:00Z";
    const old = meeting("old", { at: historic, stage: "ready" });
    const pending = meeting("pending", { at: historic, stage: "processing", statusText: "等飞书生成妙记" });
    const action = meeting("action", { at: historic, needsAction: true, stage: "attention" });
    const same = meeting("same", { title: pending.title });
    const last = meeting("last", { at: "2026-11-20T15:59:59.000Z" });
    const later = meeting("later", { at: future });
    const calendar = meeting("external", { meetingId: null, at: future, source: "feishu" });
    feed.items = [later, last, same, action, old, pending, calendar];
    const groups = homeMeetingGroups(feed.items, now);
    expect(groups.current.map(item => item.meetingId)).toEqual(["action", "pending", "same", "last"]);
    expect(groups.later).toEqual([later]);
    const html = renderToStaticMarkup(<PartnerHomeMeetings meeting={model} />);
    expect(html).toContain('aria-label="会议"');
    expect(html).toContain("现在开会");
    expect(html).toContain("预约会议");
    expect(html).toMatch(/<details[^>]*><summary>后续预约/);
    expect(html).not.toContain('href="/me/work/meetings/old"');
    expect(html).not.toContain("external");
    expect(renderToStaticMarkup(<PartnerMeetingInbox />)).toContain('href="/me/work/meetings/old"');
  });
  it("只在真实可加入的阶段展示入会地址，外部全天日程保留原链接", () => {
    const joinUrl = "https://vc.example.org/j/123", sourceUrl = "https://calendar.example.org/event/7";
    feed.items = [
      meeting("working", { stage: "live", joinUrl, statusText: "会议中" }),
      meeting("over", { stage: "ready", joinUrl, recordHref: "/api/me/partner-meetings/over/record" }),
      meeting("late", { endsAt: "2026-11-13T05:29:58Z", joinUrl }),
      meeting("without", { statusText: "尚无入会地址", joinUrl: null }),
      meeting("calendar", { meetingId: null, href: sourceUrl, sourceUrl, source: "feishu", allDay: true }),
    ];
    const html = renderToStaticMarkup(<PartnerMeetingInbox />);
    expect(html.match(/>加入会议</g)).toHaveLength(1);
    expect(html).toContain('href="' + joinUrl + '"');
    expect(html).toContain('href="' + sourceUrl + '" target="_blank"');
    expect(html).toContain("今天 全天");
    expect(html).toContain("查看记录");
    expect(html).toContain("尚无入会地址");
  });
  it("需本人处理只计一次；待归属妙记有可定位的独立来源和动作", () => {
    const known = meeting("known", { needsAction: true, stage: "attention" });
    const minute = meeting("minute", { id: "feishu-minute:token", meetingId: null, source: "feishu", stage: "unmatched",
      statusText: "待确认归属", href: "/me/work/buddy#minute-token", sourceUrl: "https://source.example.org/minutes/token",
      recordHref: "/api/me/partner-meetings/minutes/token", needsAction: true });
    const readOnly = meeting("reader", { preflightText: "预审失败" });
    feed.items = [known, minute, readOnly];
    const waiting = [{ open: { kind: "meeting", id: "known" } }] as WaitingItem[];
    expect(meetingWaitingItems(feed.items, waiting)).toEqual([minute]);
    const html = renderToStaticMarkup(<PartnerMeetingInbox />);
    expect(html).toContain('id="minute-token"');
    expect(html).toContain("整理妙记");
    expect(html).toContain("预审失败");
    expect(html).not.toContain("重试预审");
  });
  it("窄屏保留可换行长标题、44px 操作区域和键盘可访问的来源阅读入口", () => {
    const title = "关于客户演示的附件与记录".repeat(10);
    feed.items = [meeting("多份来源", { title, stage: "ready", sources: [
      { label: "现场录音", recordHref: "/api/me/partner-meetings/m/record?source=recording", sourceUrl: null },
      { label: "飞书妙记", recordHref: "/api/me/partner-meetings/m/record?source=feishu", sourceUrl: null },
    ] })];
    const html = renderToStaticMarkup(<PartnerMeetingInbox />);
    expect(html).toContain(title);
    for (const label of ["现场录音", "飞书妙记"]) {
      expect(html).toMatch(new RegExp('<button type="button"[^>]+aria-expanded="false"[^>]*>' + label + '</button>'));
    }
    const css = readFileSync(new URL("./partner-meetings.module.css", import.meta.url), "utf8");
    expect(css).toMatch(/\.title\s*\{[^}]*overflow-wrap:\s*anywhere/);
    expect(css).toMatch(/\.rowBody\s*\{[^}]*flex-wrap:\s*wrap/);
    const mobile = css.slice(css.indexOf("@media (max-width: 959px), (pointer: coarse)"));
    expect(mobile).toMatch(/\.row \.link,[^{]*\.heading button,[^{]*\{[^}]*min-height:\s*44px/);
    expect(css).toMatch(/:focus-visible[^{]*\{[^}]*outline:/);
  });
  it("空首页只保留入口，收件为空不占位，读取失败给重试", () => {
    expect(renderToStaticMarkup(<PartnerMeetingInbox />)).toBe("");
    const html = renderToStaticMarkup(<PartnerHomeMeetings meeting={model} />);
    expect(html).not.toContain("<ul");
    expect(html).toContain("现在开会");
    feed.error = "没有读到会议";
    expect(renderToStaticMarkup(<PartnerMeetingInbox />)).toContain('role="alert"');
    expect(renderToStaticMarkup(<PartnerHomeMeetings meeting={model} />)).toContain("重试");
  });
});
