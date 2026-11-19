import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));
vi.mock("@/lib/board/cloud", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/lib/board/cloud")>()), acceptDrafts: vi.fn(async () => []), decideNexusConfirmation: vi.fn(async () => undefined) }));
const feed = vi.hoisted(() => ({ items: [] as unknown[], error: null as string | null, loaded: true, reload: () => undefined }));
vi.mock("@/lib/home/partnerMeetingFeed", () => ({ usePartnerMeetings: () => feed, PartnerMeetingsProvider: () => null }));
vi.mock("./InputBar", () => ({ InputBar: () => <div data-testid="input-bar" /> }));
vi.mock("./MeetingControl", () => ({ MeetingControl: () => <button>现在开会</button> }));

import type { FocusRow } from "@/lib/home/focus";
import type { PartnerMeeting } from "@/lib/home/partnerMeetingFeed";
import type { WaitingItem, WorkHomeData } from "@/lib/home/types";
import type { WorkHomeApi } from "@/lib/home/useWorkHome";
import { LocalContext, type LocalRunnerState } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";
import type { HomeMeeting } from "./MeetingControl";
import { HomeView, HomeWaiting, waitTime } from "./HomeView";

// 此刻：北京时间 11 月 16 日 11:46。
const NOW = Date.parse("2026-11-16T03:46:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(NOW + ms).toISOString();

const wait = (id: string, extra: Partial<WaitingItem> = {}): WaitingItem => ({
  id, kind: "verdict", title: `事情 ${id}`, source: "新版天枢应用", at: iso(-HOUR), open: { kind: "project", id: "p1" },
  taskId: null, projectId: "p1", sessionId: null, deviceId: null, deviceName: null, letter: null, dueAt: null, answer: "open",
  person: null, month: null, question: null, permission: null, ...extra,
} as WaitingItem);
const meet = (extra: Partial<PartnerMeeting>): PartnerMeeting => ({
  id: "pm1", meetingId: "m1", title: "11月16日 11:44 的会", at: "2026-11-16T03:44:00Z", endsAt: "2026-11-16T04:44:00Z", stage: "scheduled",
  statusText: "已到预约时间", href: "/me/work/meetings/m1", joinUrl: null, needsAction: false, source: "tianshu", ...extra,
} as PartnerMeeting);
const local = { runner: createMockRunner(), phase: "ready", version: null, status: null, models: [], folders: [], sessions: [], pairing: null, error: null,
  refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), setIncludePersonal: vi.fn() } as unknown as LocalRunnerState;
const api = { deviceId: "d1", known: true, work: { workers: [], boards: {} }, refresh: vi.fn(), planFailed: true, retryPlan: vi.fn() } as unknown as WorkHomeApi;
const meeting = { account: { personId: "sun", displayName: "孙铭泽", role: "member" }, start: vi.fn(async () => null) } as unknown as HomeMeeting;
const data = (waiting: WaitingItem[], projects: unknown[] = []) => ({ waiting, projects, month: { missions: [] }, period: "2026-11", other: { subSessions: [] } }) as unknown as WorkHomeData;
const render = (waiting: WaitingItem[], { offline = false, known = true, projects = [] as unknown[] } = {}) => renderToStaticMarkup(
  <LocalContext.Provider value={local}>
    <HomeWaiting data={data(waiting, projects)} api={{ ...api, known }} go={() => undefined} offline={offline} recordingMeetingId={null} meeting={meeting} />
  </LocalContext.Provider>);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const rows = (html: string) => (html.match(/<li /g) ?? []).length;

beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(NOW); feed.items = []; feed.error = null; feed.loaded = true; });
afterEach(() => { vi.useRealTimers(); });

describe("首页「等你」露几件", () => {
  it("8 件露 5 件，最后一行「还有 3 件」", () => {
    const html = render(Array.from({ length: 8 }, (_, index) => wait(`w${index}`)));
    expect(rows(html)).toBe(6);
    expect(text(html)).toContain("还有 3 件");
  });

  it("正好 6 件全露，不折叠", () => {
    const html = render(Array.from({ length: 6 }, (_, index) => wait(`w${index}`)));
    expect(rows(html)).toBe(6);
    expect(text(html)).not.toContain("还有");
  });
});

describe("首页「等你」空和加载", () => {
  it("读完了也没有：一行「没有等你的事」", () => {
    expect(text(render([]))).toContain("没有等你的事");
  });

  it("会议还没读到：空着等，不闪「没有等你的事」", () => {
    feed.loaded = false;
    const html = render([]);
    expect(html).toContain('aria-busy="true"');
    expect(text(html)).not.toContain("没有等你的事");
  });

  it("云端首页还没回：不写「没有等你的事」", () => {
    const html = render([], { known: false });
    expect(html).toContain('aria-busy="true"');
    expect(text(html)).not.toContain("没有等你的事");
  });

  it("会议没读到：清单最后一行「没有读到会议」加重试，其余照常", () => {
    feed.error = "没有读到会议";
    const html = render([wait("w1")]);
    expect(text(html)).toMatch(/事情 w1 .*没有读到会议 重试/);
  });
});

describe("首页「等你」里的随手会话", () => {
  it("来源不写「随手」，写那个会话的名字；找不到会话不写来源；别的项目照旧", () => {
    const scratch = { projectId: "s1", name: "随手", scratch: true, subSessions: [{ id: "t8", kind: "topic", title: "比对合同", sessionId: "sess-8" }] };
    const html = render([
      wait("w1", { kind: "approval", title: "要运行命令", source: "随手", projectId: "s1", sessionId: "sess-8" }),
      wait("w2", { kind: "question", title: "先比哪两份？", source: "随手", projectId: "s1", sessionId: "sess-9" }),
      wait("w3", { kind: "question", title: "用哪个字体？", source: "新版天枢应用", projectId: "p1" }),
    ], { projects: [scratch, { projectId: "p1", name: "新版天枢应用", subSessions: [] }] });
    expect(html).not.toContain("随手");
    expect(text(html)).toContain("要运行命令 比对合同");
    expect(text(html)).toContain("用哪个字体？ 新版天枢应用");
  });
});

describe("首页「等你」里的会", () => {
  it("快开始的会：第二行时间段，行尾「加入会议」", () => {
    feed.items = [meet({ joinUrl: "https://vc.feishu.cn/j/1" })];
    const html = render([]);
    expect(text(html)).toContain("11月16日 11:44 的会 会议 · 11:44–12:44");
    expect(text(html)).toContain("已到时间");
    expect(html).toMatch(/<button[^>]*>加入会议<\/button>/);
  });

  it("能在这台电脑录音的：行尾「开始录音」", () => {
    feed.items = [meet({ at: iso(10 * MIN), endsAt: iso(70 * MIN), canStartRecording: true })];
    expect(render([])).toMatch(/<button[^>]*>开始录音<\/button>/);
  });

  it("开完要处理的会：第二行日期和状态，整行是链接，不放按钮", () => {
    feed.items = [meet({ id: "pm2", meetingId: "m2", title: "11月16日 11:41 的会", at: "2026-11-16T03:41:00Z", endsAt: "2026-11-16T03:41:30Z",
      stage: "attention", statusText: "录音转写失败", needsAction: true, href: "/me/work/meetings/m2" })];
    const html = render([]);
    expect(text(html)).toContain("11月16日 11:41 的会 会议 · 今天 11:41 · 录音转写失败");
    expect(html).toMatch(/<a [^>]*href="\/me\/work\/meetings\/m2"/);
    expect(html).not.toMatch(/<button[^>]*>(加入会议|开始录音)<\/button>/);
  });
});

describe("行尾时间位", () => {
  const meetingRow = (extra: Partial<PartnerMeeting>): FocusRow => ({ kind: "meeting", when: "soon", item: meet(extra) });
  it("会议：还没到点「11:50 开始」，到点「已到时间」，正在开「进行中」", () => {
    expect(waitTime(meetingRow({ at: "2026-11-16T03:50:00Z" }), NOW)).toEqual({ text: "11:50 开始", warn: true });
    expect(waitTime(meetingRow({}), NOW)).toEqual({ text: "已到时间", warn: true });
    expect(waitTime(meetingRow({ stage: "live" }), NOW)).toEqual({ text: "进行中", warn: true });
  });

  it("截止：沿用原来的写法", () => {
    expect(waitTime({ kind: "waiting", item: wait("a", { dueAt: iso(5 * HOUR + 10 * MIN) }) }, NOW)).toEqual({ text: "剩 5 小时", warn: true });
    expect(waitTime({ kind: "waiting", item: wait("b", { dueAt: iso(-MIN) }) }, NOW)).toEqual({ text: "已过截止", warn: true });
    expect(waitTime({ kind: "waiting", item: wait("c", { dueAt: iso(30 * HOUR) }) }, NOW)).toEqual({ text: "剩 1 天", warn: false });
    expect(waitTime({ kind: "waiting", item: wait("d") }, NOW)).toBeNull();
    expect(waitTime({ kind: "machine" }, NOW)).toBeNull();
  });
});

describe("首页只剩「等你」和输入框", () => {
  it("没有会议区、本月区和「本体读取失败」", () => {
    const html = renderToStaticMarkup(
      <LocalContext.Provider value={local}>
        <HomeView data={data([wait("w1")])} api={api} buddy={null} today="11 月 16 日 周一" go={() => undefined} route={async () => "main"} onSend={async () => undefined}
          projects={{ projects: [], all: [] } as never} meeting={meeting} recordingMeetingId={null} />
      </LocalContext.Provider>);
    expect(html).toContain('aria-label="等你"');
    expect(html).not.toContain('aria-label="会议"');
    expect(html).not.toContain('aria-label="本月"');
    expect(text(html)).not.toContain("本体读取失败");
    expect(html).toContain('data-testid="input-bar"');
  });
});
