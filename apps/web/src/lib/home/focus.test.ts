import { describe, expect, it } from "vitest";
import type { PartnerMeeting } from "./partnerMeetingFeed";
import type { WaitingItem } from "./types";
import { AFTER_MEETING_MS, FOCUS_VISIBLE, focusList, visibleCount, type FocusRow } from "./focus";

// 此刻：北京时间 11 月 16 日 11:46。
const NOW = Date.parse("2026-11-16T03:46:00Z");
const MIN = 60_000;
const HOUR = 60 * MIN;
const iso = (ms: number) => new Date(NOW + ms).toISOString();

const wait = (extra: Partial<WaitingItem>): WaitingItem => ({
  id: "w1", kind: "verdict", title: "验收没过", source: "新版天枢应用", at: iso(-HOUR), open: { kind: "project", id: "p1" },
  taskId: null, projectId: "p1", sessionId: null, deviceId: null, deviceName: null, letter: null, dueAt: null, answer: "open",
  person: null, month: null, question: null, permission: null, ...extra,
} as WaitingItem);
const meet = (extra: Partial<PartnerMeeting>): PartnerMeeting => ({
  id: "pm1", meetingId: "m1", title: "11月16日 11:44 的会", at: iso(-2 * MIN), stage: "scheduled", statusText: "已到预约时间",
  href: "/me/work/meetings/m1", joinUrl: null, needsAction: false, source: "tianshu", ...extra,
} as PartnerMeeting);
const run = (input: Partial<Parameters<typeof focusList>[0]>) =>
  focusList({ waiting: [], meetings: [], offline: false, recordingMeetingId: null, now: NOW, ...input });
const ids = (rows: FocusRow[]) => rows.map((row) => row.kind === "machine" ? "machine" : row.kind === "meeting" ? `${row.when}:${row.item.id}` : row.item.id);

describe("focusList：会议什么时候进等你", () => {
  it("开始前 14 分钟进、16 分钟不进", () => {
    expect(ids(run({ meetings: [meet({ id: "a", at: iso(14 * MIN) }), meet({ id: "b", meetingId: "m2", at: iso(16 * MIN) })] }))).toEqual(["soon:a"]);
  });

  it("正在开的、到点还没结束的都算快开始", () => {
    const rows = run({ meetings: [
      meet({ id: "live", meetingId: "m3", stage: "live", at: iso(-10 * MIN), endsAt: iso(50 * MIN) }),
      meet({ id: "due", meetingId: "m4", at: iso(-2 * MIN), endsAt: iso(58 * MIN) }),
    ] });
    expect(ids(rows)).toEqual(["soon:live", "soon:due"]);
  });

  it("没有结束时间的按开始后一小时算结束", () => {
    expect(ids(run({ meetings: [meet({ id: "open", at: iso(-50 * MIN) })] }))).toEqual(["soon:open"]);
    expect(ids(run({ meetings: [meet({ id: "over", at: iso(-70 * MIN) })] }))).toEqual([]);
  });

  it("全天的会不算快开始", () => {
    expect(ids(run({ meetings: [meet({ id: "day", at: iso(-3 * HOUR), allDay: true, endsAt: iso(10 * HOUR) })] }))).toEqual([]);
  });

  it("开完要处理的会：71 小时内进，73 小时收走", () => {
    const rows = run({ meetings: [
      meet({ id: "fresh", meetingId: "m5", stage: "attention", needsAction: true, at: iso(-72 * HOUR), endsAt: iso(-71 * HOUR) }),
      meet({ id: "stale", meetingId: "m6", stage: "attention", needsAction: true, at: iso(-74 * HOUR), endsAt: iso(-73 * HOUR) }),
    ] });
    expect(ids(rows)).toEqual(["after:fresh"]);
    expect(AFTER_MEETING_MS).toBe(72 * HOUR);
  });

  it("已经不在开会阶段的（妙记待选场次、转写中出事的）要处理就进，不看预约的结束时间", () => {
    const rows = run({ meetings: [meet({ id: "minute", meetingId: null, stage: "unmatched", needsAction: true, at: iso(-5 * MIN), source: "feishu" })] });
    expect(ids(rows)).toEqual(["after:minute"]);
  });

  it("这台电脑正在录的那场不进", () => {
    expect(ids(run({ meetings: [meet({ id: "rec", stage: "live", at: iso(-5 * MIN) })], recordingMeetingId: "m1" }))).toEqual([]);
  });

  it("服务端等你里已经有的那场会只留一行", () => {
    const rows = run({
      waiting: [wait({ id: "w-meeting", kind: "confirmation" as WaitingItem["kind"], open: { kind: "meeting", id: "m7" } as WaitingItem["open"] })],
      meetings: [meet({ id: "dup", meetingId: "m7", stage: "attention", needsAction: true, at: iso(-3 * HOUR), endsAt: iso(-2 * HOUR) })],
    });
    expect(ids(rows)).toEqual(["w-meeting"]);
  });
});

describe("focusList：四档排序", () => {
  it("快开始的会 → 卡着活的 → 24 小时内到期的 → 其余", () => {
    const rows = run({
      waiting: [
        wait({ id: "rest-old", at: iso(-5 * HOUR) }),
        wait({ id: "due-late", dueAt: iso(20 * HOUR), at: iso(-HOUR) }),
        wait({ id: "q-new", kind: "question", at: iso(-10 * MIN) }),
        wait({ id: "rest-new", at: iso(-20 * MIN) }),
        wait({ id: "due-past", dueAt: iso(-HOUR), at: iso(-2 * HOUR) }),
        wait({ id: "a-old", kind: "approval", at: iso(-3 * HOUR) }),
        wait({ id: "due-far", dueAt: iso(30 * HOUR), at: iso(-30 * MIN) }),
      ],
      meetings: [
        meet({ id: "m-later", meetingId: "m8", at: iso(10 * MIN) }),
        meet({ id: "m-now", meetingId: "m9", at: iso(-2 * MIN) }),
        meet({ id: "after", meetingId: "m10", stage: "attention", needsAction: true, at: iso(-25 * MIN), endsAt: iso(-15 * MIN) }),
      ],
    });
    expect(ids(rows)).toEqual(["soon:m-now", "soon:m-later", "a-old", "q-new", "due-past", "due-late", "rest-new", "after:after", "due-far", "rest-old"]);
  });

  it("按真实时刻比较，不按字符串", () => {
    const rows = run({ waiting: [
      wait({ id: "plus8", at: "2026-11-16T11:40:00+08:00" }),
      wait({ id: "zulu", at: "2026-11-16T03:45:00Z" }),
    ] });
    expect(ids(rows)).toEqual(["zulu", "plus8"]);
  });
});

describe("focusList：这台电脑没连上", () => {
  it("有活在等这台电脑时排在卡着活的最前面", () => {
    const rows = run({ offline: true, waiting: [wait({ id: "q", kind: "question", at: iso(-3 * HOUR), answer: "inline_local" }), wait({ id: "rest" })] });
    expect(ids(rows)).toEqual(["machine", "q", "rest"]);
  });

  it("没有活在等时排最后", () => {
    const rows = run({ offline: true, waiting: [wait({ id: "q", kind: "question", at: iso(-3 * HOUR) }), wait({ id: "rest" })] });
    expect(ids(rows)).toEqual(["q", "rest", "machine"]);
  });
});

describe("首页露几件", () => {
  it("露 5 件，正好 6 件时全露", () => {
    expect(FOCUS_VISIBLE).toBe(5);
    expect([visibleCount(0), visibleCount(5), visibleCount(6), visibleCount(7), visibleCount(12)]).toEqual([0, 5, 6, 5, 5]);
  });
});
