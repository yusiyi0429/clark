import { describe, expect, it } from "vitest";
import type { Card } from "@/lib/api/client";
import { meetingTimesByIssue } from "./IssueRow";

const meeting = (id: string, status: string, scheduledAt: string, issueIds: string[]) =>
  ({ schemaVersion: 1, id: `meeting:${id}`, version: 1, kind: "meeting", objectRef: { type: "meeting", id, version: 1 }, title: id, payload: { status, scheduledAt, issueIds }, actions: [] }) as unknown as Card;

describe("议题行上的会议时间", () => {
  it("只取已排期会议，同一议题取最早一场，按公司时区显示「月/日 时:分」", () => {
    const times = meetingTimesByIssue([
      meeting("m1", "scheduled", "2026-09-24T02:00:00.000Z", ["i1"]),
      meeting("m2", "scheduled", "2026-09-23T06:30:00.000Z", ["i1", "i2"]),
      meeting("m3", "held", "2026-09-20T02:00:00.000Z", ["i3"]),
    ]);
    expect(times.get("i1")).toBe("9/23 14:30");
    expect(times.get("i2")).toBe("9/23 14:30");
    expect(times.has("i3")).toBe(false);
  });
});
