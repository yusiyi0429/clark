import { describe, expect, it } from "vitest";
import type { Card } from "@/lib/api/client";
import { MEETING_POLL_MS, MINUTES_POLL_MS, meetingNeedsPolling, meetingPollMs } from "./MeetingCard";
import { preflightInFlight } from "./meetingIssueModel";
import { railRefreshInterval } from "@/components/NotificationRail";
import type { MeetingPayload } from "./payloads";

const meeting = (overrides: Partial<MeetingPayload> & { preflightStatus?: string } = {}) => {
  const { preflightStatus = "ready", ...rest } = overrides;
  return { status: "scheduled", recording: null, outcome: null, preflight: { status: preflightStatus }, ...rest } as unknown as MeetingPayload;
};
const card = (kind: string, payload: unknown) => ({ id: `${kind}:1`, kind, payload, objectRef: { type: kind, id: "1" } }) as unknown as Card;

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

  it("等妙记时 30 秒取一次、生成会议卡时 5 秒一次：到下一阶段卡片自己出来；成员视图的主持人也跟着取", () => {
    expect(MINUTES_POLL_MS).toBe(30_000);
    const waiting = meeting({ minutesStatus: "waiting" });
    expect(meetingNeedsPolling(waiting)).toBe(true);
    expect(meetingPollMs(waiting)).toBe(30_000);
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
