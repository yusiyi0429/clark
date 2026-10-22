import { afterEach, describe, expect, it, vi } from "vitest";
import type { Card } from "@/lib/api/client";
import { MEETING_POLL_MS, followMeetingCard, meetingNeedsPolling, meetingPollMs } from "./MeetingCard";
import { preflightInFlight } from "./meetingIssueModel";
import { railRefreshInterval } from "@/components/NotificationRail";
import type { MeetingPayload } from "./payloads";

const meeting = (overrides: Partial<MeetingPayload> & { preflightStatus?: string } = {}) => {
  const { preflightStatus = "ready", ...rest } = overrides;
  return { status: "scheduled", recording: null, outcome: null, preflight: { status: preflightStatus }, ...rest } as unknown as MeetingPayload;
};
const card = (kind: string, payload: unknown) => ({ id: `${kind}:1`, kind, payload, objectRef: { type: kind, id: "1" } }) as unknown as Card;

describe("会议页跟着后台取会议卡", () => {
  afterEach(() => { vi.useRealTimers(); vi.unstubAllGlobals(); });
  const stubPage = () => {
    const listeners = new Map<string, () => void>();
    const page = { visibilityState: "hidden", addEventListener: vi.fn((name: string, fn: () => void) => listeners.set(`document:${name}`, fn)), removeEventListener: vi.fn() };
    vi.stubGlobal("document", page);
    vi.stubGlobal("window", { setInterval, clearInterval, addEventListener: vi.fn((name: string, fn: () => void) => listeners.set(`window:${name}`, fn)), removeEventListener: vi.fn() });
    return { page, fire: (key: string) => listeners.get(key)!() };
  };

  it("每 5 秒取一次；撤掉以后不再取", async () => {
    vi.useFakeTimers();
    stubPage();
    const refetch = vi.fn(async () => undefined);
    const stop = followMeetingCard(5_000, refetch);
    await vi.advanceTimersByTimeAsync(4_999);
    expect(refetch).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(refetch).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(refetch).toHaveBeenCalledTimes(2);
    stop();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(refetch).toHaveBeenCalledTimes(2);
  });

  it("从后台切回来（标签页变可见、窗口拿回焦点）马上取一次，不等下一拍；上一次没取回来时不叠着取", async () => {
    vi.useFakeTimers();
    const { page, fire } = stubPage();
    let finish!: () => void;
    const refetch = vi.fn(() => new Promise<void>((resolve) => { finish = resolve; }));
    followMeetingCard(5_000, refetch);
    // 还在后台：标签页的可见性变化不取。
    fire("document:visibilitychange");
    expect(refetch).not.toHaveBeenCalled();
    page.visibilityState = "visible";
    fire("document:visibilitychange");
    expect(refetch).toHaveBeenCalledTimes(1);
    // 切回来时可见性变化和拿回焦点一起来：只取一次。
    fire("window:focus");
    expect(refetch).toHaveBeenCalledTimes(1);
    finish();
    await Promise.resolve(); await Promise.resolve();
    fire("window:focus");
    expect(refetch).toHaveBeenCalledTimes(2);
  });
});

describe("会前预审在后台跑时接着刷新", () => {
  it("只有待开的会、预审进行中才算", () => {
    expect(preflightInFlight(meeting({ preflightStatus: "running" }))).toBe(true);
    expect(preflightInFlight(meeting({ preflightStatus: "ready" }))).toBe(false);
    expect(preflightInFlight(meeting({ preflightStatus: "running", status: "held" } as never))).toBe(false);
  });

  it("会议页：预审中每 5 秒重取卡片，出结果就停；成员只读视图不取", () => {
    expect(MEETING_POLL_MS).toBe(5000);
    expect(meetingNeedsPolling(meeting({ preflightStatus: "running" }))).toBe(true);
    expect(meetingNeedsPolling(meeting({ preflightStatus: "ready" }))).toBe(false);
    expect(meetingNeedsPolling(meeting({ preflightStatus: "failed" }))).toBe(false);
    expect(meetingNeedsPolling(meeting({ preflightStatus: "running" }), true)).toBe(false);
    expect(meetingNeedsPolling(meeting({ status: "held", outcome: { status: "running" } } as never))).toBe(true);
  });

  it("等妙记、生成会议卡、等飞书会议开始和结束时都是 5 秒一次：到下一阶段卡片自己出来；成员视图的主持人也跟着取", () => {
    const waiting = meeting({ minutesStatus: "waiting" });
    expect(meetingNeedsPolling(waiting)).toBe(true);
    expect(meetingPollMs(waiting)).toBe(5_000);
    expect(meetingNeedsPolling(meeting({}), true, "waiting")).toBe(true);
    expect(meetingNeedsPolling(meeting({}), true, "live")).toBe(true);
    expect(meetingPollMs(meeting({}))).toBe(5_000);
    expect(meetingNeedsPolling(meeting({ minutesStatus: "failed", minutesFailure: "not_ready" }))).toBe(true);
    expect(meetingNeedsPolling(meeting({ minutesStatus: "failed", minutesFailure: "no_permission" }))).toBe(false);
    expect(meetingNeedsPolling(meeting({ minutesStatus: "manual" }))).toBe(false);
    expect(meetingNeedsPolling(waiting, true)).toBe(true);
    const generating = meeting({ status: "held", outcome: { status: "pending" } } as never);
    expect(meetingNeedsPolling(generating, true)).toBe(true);
    expect(meetingPollMs(generating)).toBe(5_000);
    expect(meetingPollMs(meeting({ preflightStatus: "running" }))).toBe(2_000);
  });

  it("首页左栏：有会在预审中 5 秒一次，其余待开的会 20 秒一次，没有要等的就不轮询", () => {
    expect(railRefreshInterval([card("meeting", meeting({ preflightStatus: "running" }))])).toBe(5_000);
    expect(railRefreshInterval([card("meeting", meeting({ preflightStatus: "ready" }))])).toBe(20_000);
    expect(railRefreshInterval([card("meeting", meeting({ status: "reviewed" } as never))])).toBeNull();
    expect(railRefreshInterval([])).toBeNull();
  });
});
