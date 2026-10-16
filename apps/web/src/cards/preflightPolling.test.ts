import { describe, expect, it } from "vitest";
import type { Card } from "@/lib/api/client";
import { MEETING_POLL_MS, meetingNeedsPolling } from "./MeetingCard";
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

  it("首页左栏：有会在预审中 5 秒一次，其余待开的会 20 秒一次，没有要等的就不轮询", () => {
    expect(railRefreshInterval([card("meeting", meeting({ preflightStatus: "running" }))])).toBe(5_000);
    expect(railRefreshInterval([card("meeting", meeting({ preflightStatus: "ready" }))])).toBe(20_000);
    expect(railRefreshInterval([card("meeting", meeting({ status: "reviewed" } as never))])).toBeNull();
    expect(railRefreshInterval([])).toBeNull();
  });
});
