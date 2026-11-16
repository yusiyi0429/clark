import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { PartnerMeeting } from "@/lib/home/partnerMeetingFeed";
import type { WaitingItem } from "@/lib/home/types";
import { FocusMeetingRow, PartnerMeetingInbox, usePartnerMeetingFeed } from "./PartnerMeetings";
import { focusList } from "@/lib/home/focus";

// Run production row effects without introducing a DOM/browser dependency. SSR keeps real React hooks.
const hooks = vi.hoisted(() => ({
  active: false, position: 0, values: [] as unknown[], effects: [] as (() => void | (() => void))[],
  useState(initial: unknown) {
    const key = hooks.position++;
    if (!(key in hooks.values)) hooks.values[key] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[key], (next: unknown) => { hooks.values[key] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[key]) : next; }];
  },
  useRef(initial: unknown) {
    const key = hooks.position++;
    if (!(key in hooks.values)) hooks.values[key] = { current: initial };
    return hooks.values[key];
  },
}));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react,
    useState: (initial: unknown) => hooks.active ? hooks.useState(initial) : react.useState(initial),
    useRef: (initial: unknown) => hooks.active ? hooks.useRef(initial) : react.useRef(initial),
    useEffect: (effect: () => void | (() => void), dependencies?: unknown[]) => hooks.active ? void hooks.effects.push(effect) : react.useEffect(effect, dependencies),
  };
});

const feed = vi.hoisted(() => ({ items: [] as PartnerMeeting[], error: null as string | null, reload: vi.fn() }));
vi.mock("@/lib/home/partnerMeetingFeed", () => ({ usePartnerMeetings: () => feed, PartnerMeetingsProvider: () => null }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ navigate: vi.fn() }) }));
vi.mock("./MeetingControl", () => ({ MeetingControl: () => <button>现在开会</button> }));

const now = Date.parse("2026-11-13T05:30:00Z");
const meeting = (id: string, overrides: Partial<PartnerMeeting> = {}): PartnerMeeting => ({
  id: "meeting:" + id, meetingId: id, title: id, at: new Date(now).toISOString(), stage: "scheduled",
  statusText: "已预约", needsAction: false, source: "tianshu", href: "/me/work/meetings/" + id, joinUrl: null, ...overrides,
});
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(now); feed.items = []; feed.error = null; hooks.active = false; hooks.position = 0; hooks.values = []; hooks.effects = []; vi.clearAllMocks(); });
afterEach(() => { hooks.active = false; vi.useRealTimers(); vi.unstubAllGlobals(); });

type Node = { type?: unknown; props: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object" || !("props" in value)) return [];
  const node = value as Node;
  return [node, ...nodes(node.props.children)];
}
function call(node: unknown) {
  const element = node as Node;
  expect(typeof element.type).toBe("function");
  hooks.position = 0; hooks.effects = [];
  return (element.type as (props: Record<string, unknown>) => unknown)(element.props);
}
function feedRow(item: PartnerMeeting) {
  feed.items = [item];
  const surface = usePartnerMeetingFeed();
  const rows = surface.blocks.length ? call(surface.blocks[0].node) : call(nodes(surface.scheduled).find((node) => typeof node.type === "function"));
  return nodes(rows).find((node) => typeof node.type === "function")!;
}

describe("伙伴会议的统一时间线", () => {
  it("只将已发生状态放入稳定键和原始会议时间的块，预约单独收起", () => {
    const liveAt = "2026-11-13T01:00:00+08:00", pastAt = "2026-10-01T02:00:00Z";
    feed.items = [meeting("future", { at: "2026-12-01T02:00:00Z" }), meeting("live", { stage: "live", at: liveAt }),
      meeting("old", { stage: "ready", at: pastAt }), meeting("calendar", { meetingId: null, source: "feishu", at: "2026-12-03T02:00:00Z" })];
    const surface = usePartnerMeetingFeed();
    expect(surface.blocks.map(({ key, at }) => ({ key, at }))).toEqual([
      { key: "partner-meeting:meeting:live", at: liveAt }, { key: "partner-meeting:meeting:old", at: pastAt },
    ]);
    const events = surface.blocks.map(({ node }) => renderToStaticMarkup(node)).join("");
    expect(events).toContain("会议时间");
    expect(events).not.toContain("future");
    expect(events).not.toContain("calendar");
    const schedule = renderToStaticMarkup(surface.scheduled);
    expect(schedule).toMatch(/<details[^>]*><summary>会议安排/);
    expect(schedule).not.toMatch(/<details[^>]*\sopen/);
    expect(schedule).toContain("future"); expect(schedule).toContain("calendar");
    feed.items = [...feed.items].reverse();
    expect(usePartnerMeetingFeed().blocks.map(({ key }) => key).sort()).toEqual(["partner-meeting:meeting:live", "partner-meeting:meeting:old"]);
  });

  it.each(["unmatched", "scheduled"] as const)("%s 妙记的深链先展开所有安排祖先，再聚焦原对象", (stage) => {
    const item = meeting("minute", { id: "feishu-minute:token", meetingId: null, source: "feishu", stage, href: "/me/work/buddy#minute-token" });
    hooks.active = true;
    const row = call(feedRow(item));
    const li = nodes(row).find((node) => node.type === "li")!;
    expect(li.props.id).toBe("minute-token");
    expect(li.props.tabIndex).toBe(-1);
    const order: string[] = [];
    const outer = { set open(value: boolean) { if (value) order.push("outer-open"); }, parentElement: { closest: () => null } };
    const inner = { set open(value: boolean) { if (value) order.push("inner-open"); }, parentElement: { closest: () => outer } };
    const target = { closest: () => inner, focus: () => order.push("focus"), scrollIntoView: () => order.push("scroll") };
    (li.props.ref as { current: unknown }).current = target;
    vi.stubGlobal("location", { hash: "#minute-token" });
    const listeners = new Map<string, () => void>();
    vi.stubGlobal("window", { addEventListener: (event: string, callback: () => void) => listeners.set(event, callback), removeEventListener: vi.fn() });
    const cleanup = hooks.effects.map((effect) => effect());
    expect(order).toEqual(["inner-open", "outer-open", "focus", "scroll"]);
    listeners.get("hashchange")?.();
    expect(order).toHaveLength(4);
    cleanup.forEach((effect) => effect?.());
  });

  it("需处理的失败保持真实状态、可打开会议，来源细节默认折叠", () => {
    feed.items = [meeting("failed", { stage: "attention", statusText: "记录处理失败", needsAction: true, sourceUrl: "https://source.example.org/failed", preflightText: "预审失败" })];
    const html = renderToStaticMarkup(usePartnerMeetingFeed().blocks[0].node);
    expect(html).toContain('data-stage="attention"');
    expect(html).toContain("记录处理失败");
    expect(html).not.toContain("正在处理");
    expect(html).toMatch(/<a[^>]*href="\/me\/work\/meetings\/failed"[^>]*>处理会议事项<\/a>/);
    expect(html).toMatch(/<details[^>]*><summary>来源与详情/);
    expect(html).toContain("打开来源");
    expect(html).not.toContain("重试预审");
    feed.error = "没有读到会议";
    const notice = renderToStaticMarkup(usePartnerMeetingFeed().notice);
    expect(notice).toContain('role="alert"'); expect(notice).toContain("重试");
  });

  it.each([
    { stage: "ready" as const, statusText: "记录已到 · 3 条待你确认" },
    { stage: "attention" as const, statusText: "会后整理失败" },
  ])("$stage 有记录且需本人处理时，首要动作进入会议处理并保留次级阅读", ({ stage, statusText }) => {
    hooks.active = true;
    const row = call(feedRow(meeting("action-record", { stage, statusText, needsAction: true,
      recordHref: "/api/me/partner-meetings/action-record/record" })));
    const controls = nodes(row).filter((node) => node.type === "a" || node.type === "button");
    const primaryAction = controls[1]; // The first anchor is the title; next control is the prominent action.
    expect(primaryAction.type).toBe("a");
    expect(primaryAction.props.href).toBe("/me/work/meetings/action-record");
    expect(primaryAction.props.children).toBe("处理会议事项");
    const status = nodes(row).find((node) => node.type === "p" && node.props.children === statusText);
    expect(status?.props["data-needs-action"]).toBe(true);
    const sourceDetails = nodes(row).find((node) => node.type === "details")!;
    expect(sourceDetails.props.open).toBeUndefined();
    expect(nodes(sourceDetails).some((node) => node.type === "button" && node.props.children === "查看记录")).toBe(true);
  });

  it("记录就绪且无需本人处理时，仍以阅读记录为首要动作", () => {
    hooks.active = true;
    const row = call(feedRow(meeting("read-only", { stage: "ready", statusText: "记录已到", needsAction: false,
      recordHref: "/api/me/partner-meetings/read-only/record" })));
    const controls = nodes(row).filter((node) => node.type === "a" || node.type === "button");
    expect(controls[1].type).toBe("button");
    expect(controls[1].props.children).toBe("查看记录");
    expect(controls[1].props["aria-expanded"]).toBe(false);
    expect(controls.some((node) => node.props.children === "处理会议事项")).toBe(false);
  });

  it("读记录失败可重试，且不把来源失败改成会议正在运行", async () => {
    hooks.active = true;
    const rowNode = feedRow(meeting("read", { stage: "ready", recordHref: "/api/me/partner-meetings/read/record" }));
    let row = call(rowNode);
    const read = nodes(row).find((node) => node.type === "button" && node.props.children === "查看记录")!;
    (read.props.onClick as () => void)();
    row = call(rowNode);
    const record = nodes(row).find((node) => typeof node.type === "function")!;
    hooks.values = [];
    const fetchRecord = vi.fn().mockResolvedValueOnce({ ok: false, status: 403 }).mockResolvedValueOnce({ ok: true, json: async () => ({ title: "read", text: "重新读到正文", sourceUrl: null }) });
    vi.stubGlobal("fetch", fetchRecord);
    call(record); hooks.effects.forEach((effect) => effect());
    await Promise.resolve(); await Promise.resolve();
    const failure = call(record);
    expect(renderToStaticMarkup(failure as never)).toContain("这份记录已不可读");
    const alert = nodes(failure).find((node) => typeof node.type === "function")!;
    (alert.props.retry as () => void)();
    call(record); hooks.effects.forEach((effect) => effect());
    await Promise.resolve(); await Promise.resolve(); await Promise.resolve();
    const success = renderToStaticMarkup(call(record) as never);
    expect(success).toContain("重新读到正文"); expect(success).not.toContain('role="alert"');
    expect(fetchRecord.mock.calls.map(([href]) => href)).toEqual(["/api/me/partner-meetings/read/record", "/api/me/partner-meetings/read/record"]);
  });
});

describe("首页会议和伙伴收件使用同一条记录", () => {
  // 首页的会议区（homeMeetingGroups、PartnerHomeMeetings）11/16 退役，分组和页头入口改由会议页覆盖（meetingsPage.test.tsx）。
  it("伙伴收件里过去的会照样可读", () => {
    feed.items = [meeting("old", { at: "2026-11-01T02:00:00Z", stage: "ready" })];
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
    const meetingRows = focusList({ waiting, meetings: feed.items, offline: false, recordingMeetingId: null, now }).flatMap((row) => (row.kind === "meeting" ? [row] : []));
    expect(meetingRows.filter((row) => row.when === "after").map((row) => row.item)).toEqual([minute]);
    expect(meetingRows.some((row) => row.item.id === known.id)).toBe(false);
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
  it("收件为空不占位，读取失败给重试", () => {
    expect(renderToStaticMarkup(<PartnerMeetingInbox />)).toBe("");
    feed.error = "没有读到会议";
    const html = renderToStaticMarkup(<PartnerMeetingInbox />);
    expect(html).toContain('role="alert"');
    expect(html).toContain("重试");
  });
});

describe("等你里只在飞书日历里的会", () => {
  it("点了在新标签页开飞书，不把新首页（和正在录的会）换走", () => {
    const item = meeting("fs", { meetingId: null, source: "feishu", href: "https://example.feishu.cn/calendar/event/fs", sourceUrl: "https://example.feishu.cn/calendar/event/fs" });
    const html = renderToStaticMarkup(<FocusMeetingRow item={item} when="soon" time={null} go={vi.fn()} meeting={{ start: vi.fn() }} />);
    expect(html).toContain('href="https://example.feishu.cn/calendar/event/fs" target="_blank" rel="noopener noreferrer"');
  });
});
