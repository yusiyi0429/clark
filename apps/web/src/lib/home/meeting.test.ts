import { describe, expect, it } from "vitest";
import type { TWorldAnchorOption } from "@warmap/contracts";
import { defaultAnchor, defaultMeetingTitle, elapsed, meetingHref, meetingSpan, startableMeetings } from "./meeting";

const option = (kind: TWorldAnchorOption["kind"], id: string, ownerId: string | null = null): TWorldAnchorOption =>
  ({ kind, id, title: `${kind}-${id}`, brief: null, lifecycle: null, ownerId, parentId: null });

describe("伙伴台开会的默认值（设计 2026-11-12 第二节）", () => {
  it("标题按公司时区写「11月12日 15:30 的会」，已约的会写「10:00–11:00」", () => {
    expect(defaultMeetingTitle(new Date("2026-11-12T07:30:00Z"))).toBe("11月12日 15:30 的会");
    expect(defaultMeetingTitle(new Date("2026-10-01T01:05:00Z"))).toBe("10月1日 09:05 的会");
    expect(meetingSpan("2026-11-12T02:00:00Z", "2026-11-12T03:00:00Z")).toBe("10:00–11:00");
    expect(meetingSpan("2026-11-12T02:00:00Z", null)).toBe("10:00–11:00");
  });

  it("我主持、开始前 15 分钟到结束之间、没开完的会才排上来，先开始的在前", () => {
    const now = Date.parse("2026-11-12T02:00:00Z");
    const at = (minutes: number) => new Date(now + minutes * 60_000).toISOString();
    const meetings = [
      { meetingId: "later", title: "b", at: at(20), endsAt: at(80), canStartRecording: true, stage: "scheduled" },
      { meetingId: "soon", title: "a", at: at(10), endsAt: at(70), canStartRecording: true, stage: "scheduled" },
      { meetingId: "on", title: "c", at: at(-30), endsAt: at(30), canStartRecording: true, stage: "live" },
      { meetingId: "over", title: "d", at: at(-90), endsAt: at(-30), canStartRecording: true, stage: "scheduled" },
      { meetingId: "ended", title: "e", at: at(-10), endsAt: at(50), canStartRecording: true, stage: "attention" },
      { meetingId: "others", title: "f", at: at(0), endsAt: at(60), canStartRecording: false, stage: "scheduled" },
      { meetingId: "busy", title: "g", at: at(0), endsAt: at(60), canStartRecording: true, stage: "processing" },
    ];
    expect(startableMeetings(meetings, now).map((meeting) => meeting.meetingId)).toEqual(["on", "soon"]);
  });

  it("挂点：项目本月目标的 Mission > 上次用的 > 我的第一个 Mission > 第一个 Mission；选项里没有的不用", () => {
    const options = [option("lto", "l1"), option("mission", "m-other", "p2"), option("mission", "m-mine", "me"), option("mission", "m-proj", "p3"), option("unit", "u1")];
    expect(defaultAnchor(options, { missionId: "m-proj", last: { kind: "lto", id: "l1" }, me: "me" })?.id).toBe("m-proj");
    expect(defaultAnchor(options, { missionId: "gone", last: { kind: "lto", id: "l1" }, me: "me" })?.id).toBe("l1");
    expect(defaultAnchor(options, { last: { kind: "mission", id: "gone" }, me: "me" })?.id).toBe("m-mine");
    expect(defaultAnchor(options, { me: "nobody" })?.id).toBe("m-other");
    expect(defaultAnchor([option("unit", "u1")], { me: "me" })).toBeNull();
  });

  it("会议页在新首页里", () => {
    expect(meetingHref("6a566198-f1fa")).toBe("/me/work/meetings/6a566198-f1fa");
  });

  it("走秒：一小时内 m:ss，过了 h:mm:ss", () => {
    expect(elapsed(42_000)).toBe("0:42");
    expect(elapsed(754_000)).toBe("12:34");
    expect(elapsed(3_754_000)).toBe("1:02:34");
    expect(elapsed(-5)).toBe("0:00");
  });
});
