import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import type { TFeishuMinuteInboxItem, TMyMeetingCard, TMyMeetingConfirm } from "@warmap/contracts";
import { confirmNotices, MeetingCardNoticeList, meetingCardNotices, minuteNotices, type ConfirmActs, type MinuteActs } from "./MeetingCardNotices";

const meeting = (overrides: Partial<TMyMeetingCard> = {}): TMyMeetingCard => ({
  meetingId: "m1", title: "接口切换会", endedAt: "2026-10-20T06:00:00.000Z", status: "failed", ...overrides,
});
const confirm = (overrides: Partial<TMyMeetingConfirm> = {}): TMyMeetingConfirm => ({
  meetingId: "m1", title: "AIDC 月中会", kind: "decision", id: "dec-1", text: "AIDC 11 月预算从 A 线挪 30 万到 B 线", dueDate: null, needsOwner: false, ...overrides,
});

describe("会后确认：只出要确认的决策和行动项，一次一条", () => {
  it("决策：标签「决策确认」、正文是决策本身、小字来自哪场会；当场确认，不对要写原因", async () => {
    const review = vi.fn<ConfirmActs["review"]>(async () => ({ ok: true }));
    const [notice] = confirmNotices([confirm()], { review, open: vi.fn() });
    expect(notice).toMatchObject({ label: "决策确认", title: "AIDC 11 月预算从 A 线挪 30 万到 B 线", detail: "来自「AIDC 月中会」" });
    expect(notice.onOpen).toBeUndefined();
    expect(notice.buttons.map((button) => button.label)).toEqual(["确认"]);
    expect(await notice.buttons[0].run()).toEqual({ ok: true, settled: "已确认" });
    expect(review).toHaveBeenCalledWith(confirm(), "confirm");
    expect(notice.reason).toMatchObject({ label: "不对", submitLabel: "提交" });
    expect(await notice.reason!.run("会上没定数")).toEqual({ ok: true, settled: "已标为不对" });
    expect(review).toHaveBeenLastCalledWith(confirm(), "reject", "会上没定数");
  });

  it("行动项：标签「执行事项确认」，带截止；接下 / 退回；失败照原因提示", async () => {
    const review = vi.fn<ConfirmActs["review"]>(async () => ({ ok: false, error: "已经处理过了" }));
    const [notice] = confirmNotices([confirm({ kind: "action", id: "act-1", text: "交 TK 试用 scope 写入演练报告", dueDate: "2026-10-31" })], { review, open: vi.fn() });
    expect(notice.label).toBe("执行事项确认");
    expect(notice.detail).toMatch(/^来自「AIDC 月中会」 · 截止 /);
    expect(notice.buttons.map((button) => button.label)).toEqual(["接下"]);
    expect(notice.reason?.label).toBe("退回");
    expect(await notice.buttons[0].run()).toEqual({ ok: false, error: "已经处理过了" });
  });

  it("没有责任人的决策（我是主持人）：标签「指定责任人」，点「去指定」或标题去会议页；不当场确认，交出去之前留着", async () => {
    const review = vi.fn<ConfirmActs["review"]>();
    const open = vi.fn<ConfirmActs["open"]>();
    const item = confirm({ needsOwner: true });
    const [notice] = confirmNotices([item], { review, open });
    expect(notice).toMatchObject({ label: "指定责任人", title: "AIDC 11 月预算从 A 线挪 30 万到 B 线", detail: "来自「AIDC 月中会」" });
    expect(notice.reason).toBeUndefined();
    expect(notice.buttons.map((button) => button.label)).toEqual(["去指定"]);
    expect(await notice.buttons[0].run()).toEqual({ ok: false, cancelled: true });
    expect(open).toHaveBeenCalledWith(item, null);
    notice.onOpen!(null);
    expect(open).toHaveBeenCalledTimes(2);
    expect(review).not.toHaveBeenCalled();
  });

  it("多条时只出第一条，底下「第 1 条 / 共 2 条」和左右箭头；一条时不出翻页", () => {
    const two = [confirm(), confirm({ id: "dec-2", text: "11 月起周会改到周一 10:00" })];
    const html = renderToStaticMarkup(<MeetingCardNoticeList meetings={[]} confirms={two} meetingBase="/me/meetings" onNavigate={() => undefined} />);
    expect(html).toContain("会后确认");
    expect(html).toContain("AIDC 11 月预算从 A 线挪 30 万到 B 线");
    expect(html).not.toContain("11 月起周会改到周一 10:00");
    expect(html).toContain("第 1 条 / 共 2 条");
    expect(html).toContain('aria-label="上一条"');
    expect(html).toContain('aria-label="下一条"');
    const one = renderToStaticMarkup(<MeetingCardNoticeList meetings={[]} confirms={[confirm()]} meetingBase="/me/meetings" onNavigate={() => undefined} />);
    expect(one).not.toContain("共 1 条");
    // 记录正文不进通知栏：没有「会议记录待确认」。
    expect(html).not.toContain("待确认");
  });

  it("写入失败的会议记录：卡上重试，点了去会议页", async () => {
    const navigate = vi.fn();
    const retry = vi.fn(async () => ({ ok: true as const, settled: "已重新写入" }));
    const [notice] = meetingCardNotices([meeting({ meetingId: "m2", title: "渠道预算会" })], "/meetings", navigate, retry);
    expect(notice).toMatchObject({ title: "渠道预算会", detail: "写入失败", tone: "red" });
    expect(notice.buttons.map((button) => button.label)).toEqual(["重试"]);
    await notice.buttons[0].run();
    expect(retry).toHaveBeenCalled();
    notice.onOpen?.(null);
    expect(navigate).toHaveBeenCalledWith("/meetings/m2", null);
  });

  it("没有要确认、也没有写入失败时不显示", () => {
    expect(renderToStaticMarkup(<MeetingCardNoticeList meetings={[]} meetingBase="/meetings" onNavigate={() => undefined} />)).toBe("");
  });
});

const item = (overrides: Partial<TFeishuMinuteInboxItem> = {}): TFeishuMinuteInboxItem => ({
  minuteToken: "obcn1", title: "产品周会", startsAt: "2026-10-23T06:00:00.000Z", endsAt: "2026-10-23T07:10:00.000Z",
  attendees: [{ personId: "p1", displayName: "孙铭泽" }], otherAttendees: 0, suggestion: null, ...overrides,
});
const now = new Date("2026-10-23T08:00:00.000Z");
const acts = (): MinuteActs => ({
  organize: vi.fn(async () => ({ ok: true as const })),
  attach: vi.fn(async () => ({ ok: true as const })),
  ignore: vi.fn(async () => ({ ok: true as const })),
});

describe("会议记录待整理：飞书里直接开的会", () => {
  it("待整理：标题、下一行和按钮", async () => {
    const act = acts();
    const minute = item();
    const [notice] = minuteNotices([minute], act, now);
    expect(notice).toMatchObject({ id: "feishu-minute:obcn1", title: "产品周会", detail: "飞书会议 · 今天 14:00–15:10 · 待整理", tone: "neutral" });
    expect(notice.onOpen).toBeUndefined();
    expect(notice.buttons.map((button) => [button.label, Boolean(button.emphasis)])).toEqual([["整理", true], ["忽略", false]]);
    await notice.buttons[0].run();
    expect(act.organize).toHaveBeenCalledWith(minute);
    await notice.buttons[1].run();
    expect(act.ignore).toHaveBeenCalledWith(minute);
  });

  it("属于天枢里约好的会", async () => {
    const act = acts();
    const minute = item({ suggestion: { meetingId: "m9", title: "Inception 设计会" }, startsAt: "2026-10-23T02:02:00.000Z", endsAt: "2026-10-23T03:15:00.000Z" });
    const [notice] = minuteNotices([minute], act, now);
    expect(notice.detail).toBe("飞书会议 · 今天 10:02–11:15");
    expect(notice.buttons.map((button) => [button.label, Boolean(button.emphasis)])).toEqual([["记到天枢里的「Inception 设计会」", true], ["不是这场，另建一场", false], ["忽略", false]]);
    await notice.buttons[1].run();
    expect(act.organize).toHaveBeenCalledWith(minute);
    expect(act.attach).not.toHaveBeenCalled();
    await notice.buttons[0].run();
    expect(act.attach).toHaveBeenCalledWith(minute);
  });

  it("不是今天写日期", () => {
    const [notice] = minuteNotices([item()], acts(), new Date("2026-10-24T08:00:00.000Z"));
    expect(notice.detail).toBe("飞书会议 · 10/23 14:00–15:10 · 待整理");
  });

  it("同一组里待整理在前，计数两样都算", () => {
    const html = renderToStaticMarkup(<MeetingCardNoticeList meetings={[meeting({})]} minutes={[item()]} meetingBase="/me/meetings" onNavigate={() => undefined} />);
    expect(html.indexOf("产品周会")).toBeGreaterThan(-1);
    expect(html.indexOf("产品周会")).toBeLessThan(html.indexOf("接口切换会"));
    expect(html).toContain('aria-label="2 项待处理"');
    const only = renderToStaticMarkup(<MeetingCardNoticeList meetings={[]} minutes={[item()]} meetingBase="/me/meetings" onNavigate={() => undefined} />);
    expect(only).toContain("产品周会");
    for (const mark of ["。", "！", "？"]) expect(only).not.toContain(mark);
  });
});
