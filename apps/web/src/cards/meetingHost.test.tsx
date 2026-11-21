import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MeetingCard, meetingNeedsPolling } from "./MeetingCard";
import { meetingCard } from "./meetingWorkspace.test";
import { feishuLive } from "@/components/meeting/MeetingHeader";

const viewer = vi.hoisted(() => ({ id: "none" }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ homeCards: [], viewerId: viewer.id }) }));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined, push: () => undefined }) }));
// 会议记录用会议卡还是旧格式，由会议卡接口决定（静态渲染问不到）：这里的会议都是旧格式。
vi.mock("@/components/meeting/useMeetingCardProbe", () => ({ useMeetingCardProbe: () => ({ status: "legacy" }) }));
// 页头的挂点条：会议页单独取的「这场会在本体里」（静态渲染取不到，这里直接给）。
const world = vi.hoisted(() => ({ detail: null as unknown }));
vi.mock("@/components/meeting/meetingDecisionApi", async (original) => ({
  ...(await original<typeof import("@/components/meeting/meetingDecisionApi")>()), useMeetingWorld: () => [world.detail, () => undefined] }));

describe("成员主持会议", () => {
  it("主持人能重新安排并上传文字记录，普通参会人保持只读", () => {
    const card = meetingCard({ hasEnded: true }, [{ actionId: "reschedule", actionType: "meeting.reschedule", label: "重新安排会议" }]);
    const render = () => renderToStaticMarkup(<MeetingCard card={card} collection={[card]} onCard={() => undefined} onNavigate={() => undefined} readOnly />);
    viewer.id = "p1";
    expect(render()).toContain("重新安排会议");
    expect(render()).toContain("选择会议记录文件");
    viewer.id = "someone-else";
    expect(render()).not.toContain("重新安排会议");
    expect(render()).not.toContain("选择会议记录文件");
  });
  it("这一版主持人和其他参会人都没有开始会议，双方都有材料下拉钮那一格", () => {
    const card = meetingCard({ purpose: "对齐预算" }, [{ actionId: "end", actionType: "meeting.end", label: "会议已结束" }]);
    const render = () => renderToStaticMarkup(<MeetingCard card={card} collection={[card]} onCard={() => undefined}
      onNavigate={() => undefined} readOnly />);
    viewer.id = "p1";
    expect(render()).not.toContain("开始会议");
    expect(render()).toContain("data-header-tools");
    viewer.id = "someone-else";
    expect(render()).not.toContain("开始会议");
    expect(render()).toContain("data-header-tools");
  });
  it("会前也能看到挂点条：主持人在页头看到挂点和「改」，参会人只看挂点", () => {
    const anchors = [{ kind: "mission", id: "m-v2", title: "接口全量切到 v2" }];
    const card = meetingCard({});
    const render = () => renderToStaticMarkup(<MeetingCard card={card} collection={[card]} onCard={() => undefined} onNavigate={() => undefined} readOnly />);
    viewer.id = "p1";
    world.detail = { world: { excluded: false, excludedBy: null, record: { status: "pending", version: 0, eventId: null, confirmedAt: null }, at: null,
      anchors, edited: false, canEdit: true }, decisions: [] };
    const host = render();
    expect(host).toContain("所属");
    expect(host).toContain("接口全量切到 v2");
    expect(host).toContain(">更换<");
    expect(host).not.toContain("记录 ·");
    expect(host.indexOf("接口全量切到 v2")).toBeLessThan(host.indexOf("p1主持") === -1 ? host.indexOf("主持") : host.indexOf("p1主持"));
    // 挂到一行：挂到 → 挂点 → 「改」，进度线在它上面（页头正下方那一行）。
    expect(host.indexOf(">所属<")).toBeLessThan(host.indexOf("接口全量切到 v2"));
    expect(host.indexOf("接口全量切到 v2")).toBeLessThan(host.indexOf(">更换<"));
    expect(host.indexOf('aria-label="进度"')).toBeLessThan(host.indexOf(">所属<"));
    viewer.id = "someone-else";
    world.detail = { world: { excluded: false, excludedBy: null, record: null, at: null, anchors, edited: false, canEdit: false }, decisions: [] };
    const attendee = render();
    expect(attendee).toContain("接口全量切到 v2");
    expect(attendee).not.toContain(">更换<");
    world.detail = null;
    expect(render()).not.toContain("所属");
    // 看不到挂点的人也看得到进度线。
    expect(render()).toContain('aria-label="进度"');
  });

  it("已取消的会不显示进度线", () => {
    viewer.id = "p1";
    const card = meetingCard({ status: "cancelled" });
    const html = renderToStaticMarkup(<MeetingCard card={card} collection={[card]} onCard={() => undefined} onNavigate={() => undefined} readOnly />);
    expect(html).not.toContain('aria-label="进度"');
  });
});

describe("飞书会议入口", () => {
  const feishu = (status: string, extra: Record<string, unknown> = {}) => ({ feishuEvent: { status, joinUrl: null, organizerId: "p1", ...extra } });
  const retry = [{ actionId: "f1", actionType: "meeting.retry_feishu_booking", label: "重试飞书预约" }];
  const render = (payload: Record<string, unknown>, actions: { actionId: string; actionType: string; label: string }[] = []) => {
    const card = meetingCard(payload, actions);
    return renderToStaticMarkup(<MeetingCard card={card} collection={[card]} onCard={() => undefined} onNavigate={() => undefined} readOnly />);
  };

  it("还没约上时显示创建进度，即使残留旧链接也不提供入会", () => {
    viewer.id = "someone-else";
    const html = render(feishu("pending", { joinUrl: "https://vc.feishu.cn/j/old" }));
    expect(html).toContain("正在飞书创建日程");
    expect(html).not.toContain("进入飞书会议");
    expect(html).not.toContain("https://vc.feishu.cn/j/old");
  });

  it("等连飞书：都看到「未同步到飞书日历」，只有约的人本人看到「连接飞书」", () => {
    viewer.id = "p1";
    expect(render(feishu("waiting_auth"))).toContain("连接飞书");
    expect(render(feishu("waiting_auth"))).toContain("未同步到飞书日历");
    viewer.id = "someone-else";
    expect(render(feishu("waiting_auth"))).not.toContain("连接飞书");
    expect(render(feishu("waiting_auth"))).toContain("未同步到飞书日历");
  });

  it("没约上双方都看到原因，只有持有对应动作的主持人能重试", () => {
    viewer.id = "p1";
    const html = render(feishu("failed"), retry);
    expect(html).toContain("飞书未约上");
    expect(html).toMatch(/<button[^>]*>重试<\/button>/);
    viewer.id = "someone-else";
    const attendee = render(feishu("failed", { joinUrl: "https://vc.feishu.cn/j/old" }), retry);
    expect(attendee).toContain("飞书未约上");
    expect(attendee).not.toMatch(/<button[^>]*>重试<\/button>/);
    expect(attendee).not.toContain("https://vc.feishu.cn/j/old");
  });
});

// 在飞书约上的会跟着飞书会议真实开始和结束（不按预约时间）。时间都相对现在取：渲染时取的是真实时钟。
describe("在飞书约上的会跟着飞书会议开始和结束", () => {
  const MIN = 60_000;
  const at = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();
  const JOIN = "https://vc.feishu.cn/j/923851390";
  const booked = (start: number, end: number, extra: Record<string, unknown> = {}) => ({
    scheduledAt: at(start), endsAt: at(end), feishuEvent: { status: "booked", joinUrl: JOIN, organizerId: "p1" }, ...extra });
  const hostActions = [
    { actionId: "reschedule", actionType: "meeting.reschedule", label: "重新安排会议" },
    { actionId: "end", actionType: "meeting.end", label: "结束会议" },
  ];
  const render = (payload: Record<string, unknown>) => {
    const card = meetingCard(payload, hostActions);
    return renderToStaticMarkup(<MeetingCard card={card} collection={[card]} onCard={() => undefined} onNavigate={() => undefined} readOnly />);
  };
  /** 页头最右那一格（进入飞书会议、重新安排会议）。 */
  const headerEnd = (html: string) => /<span[^>]*data-header-end[^>]*>([\s\S]*?)<\/span><\/div>/.exec(html)?.[1] ?? "";
  /** 进度线上正在的那一步（连同它后面的入口，只有待交记录才有）。 */
  const current = (html: string) => /<li [^>]*aria-current="step"[^>]*>[\s\S]*?<\/li>/.exec(html)?.[0] ?? "";
  const lead = (html: string) => /data-header-lead[^>]*data-timeline="(\w+)"/.exec(html)?.[1];

  it("阶段：没开始、开着、开完了、没开成；不在飞书约上的为 null", () => {
    const now = Date.parse("2026-10-22T03:00:00Z");
    const base = { status: "scheduled" as const, endsAt: "2026-10-22T03:30:00Z", endedAt: null, transcriptCandidate: null,
      feishuEvent: { status: "booked" as const, joinUrl: JOIN, organizerId: "p1" } };
    expect(feishuLive(base, now)).toBe("waiting");
    expect(feishuLive({ ...base, startedAt: "2026-10-22T02:05:00Z" }, now)).toBe("live");
    expect(feishuLive({ ...base, startedAt: "2026-10-22T02:05:00Z", endedAt: "2026-10-22T02:55:00Z" }, now)).toBe("ended");
    // 开着但没收到结束、过了预约结束后台已进等妙记：开完了。
    expect(feishuLive({ ...base, startedAt: "2026-10-22T02:05:00Z", minutesStatus: "waiting" }, now)).toBe("ended");
    expect(feishuLive(base, Date.parse("2026-10-22T03:59:00Z"))).toBe("waiting");
    expect(feishuLive(base, Date.parse("2026-10-22T04:00:00Z"))).toBe("missed");
    // 没开成后轮询找到了妙记：照常进会后。
    expect(feishuLive({ ...base, minutesStatus: "ready" }, Date.parse("2026-10-22T04:30:00Z"))).toBe("ended");
    expect(feishuLive({ ...base, feishuEvent: null }, now)).toBeNull();
    expect(feishuLive({ ...base, feishuEvent: { ...base.feishuEvent, status: "failed" } }, now)).toBeNull();
    expect(feishuLive({ ...base, status: "held" }, now)).toBeNull();
  });

  it("还没到预约时间：进度线上等开会是这一步（不呼吸），不插按钮；页头最右是安静的「重新安排会议」和唯一的主按钮「进入飞书会议」", () => {
    viewer.id = "p1";
    const html = render(booked(30 * MIN, 90 * MIN));
    expect(current(html)).toContain('data-step="waiting" data-state="current" data-tone="still"');
    expect(current(html)).not.toMatch(/<a |<button/);
    expect(headerEnd(html)).toMatch(new RegExp(`<button[^>]*aria-label="重新安排会议"[^>]*>[\\s\\S]*?</button><a [^>]*href="${JOIN}"[^>]*>进入飞书会议</a>`));
  });

  it("到了预约时间、飞书会议还没开：不显示进行中；进度线上等开会开始呼吸，页头最右是「重新安排会议」「进入飞书会议」，没有「结束会议」；跟着取会议卡", () => {
    viewer.id = "p1";
    const html = render(booked(-10 * MIN, 50 * MIN));
    expect(lead(html)).toBe("upcoming");
    expect(html).toContain("未开始");
    expect(html).not.toContain("会议中");
    expect(current(html)).toContain('data-step="waiting" data-state="current" data-tone="breathe"');
    expect(current(html)).not.toContain("进入飞书会议");
    expect(headerEnd(html)).toContain(`href="${JOIN}"`);
    expect(headerEnd(html)).toContain("进入飞书会议");
    expect(headerEnd(html)).toContain("重新安排会议");
    expect(html.match(/>重新安排会议</g)).toHaveLength(1);
    expect(html.match(/进入飞书会议/g)).toHaveLength(1);
    expect(html).not.toContain("结束会议");
    const payload = meetingCard(booked(-10 * MIN, 50 * MIN)).payload as Parameters<typeof meetingNeedsPolling>[0];
    expect(meetingNeedsPolling(payload, true, "waiting")).toBe(true);
    // 参会的人只看到进入飞书会议。
    viewer.id = "someone-else";
    const attendee = render(booked(-10 * MIN, 50 * MIN));
    expect(headerEnd(attendee)).toContain("进入飞书会议");
    expect(attendee).not.toContain("重新安排会议");
  });

  it("飞书会议开始了：页头写会议中（不再另走一份计时）；进度线上进行中（红点）从真实开始走用时，页头最右只留「进入飞书会议」，没有「结束会议」", () => {
    viewer.id = "p1";
    const startedAt = at(-3 * MIN);
    const html = render(booked(-10 * MIN, 50 * MIN, { startedAt }));
    expect(lead(html)).toBe("live");
    expect(html).toContain("会议中");
    expect(current(html)).toContain('data-step="live" data-state="current" data-tone="live"');
    expect(current(html)).toContain(`role="timer" dateTime="${startedAt}"`);
    expect(html.match(/role="timer"/g)).toHaveLength(1);
    expect(headerEnd(html)).toContain("进入飞书会议");
    expect(headerEnd(html)).not.toContain("重新安排会议");
    expect(html).not.toContain("结束会议");
  });

  it("飞书会议结束了：进会后流程（会议记录、等妙记），页头右边不再有飞书入口", () => {
    viewer.id = "p1";
    const html = render(booked(-60 * MIN, -5 * MIN, { startedAt: at(-58 * MIN), endedAt: at(-10 * MIN), hasEnded: true,
      minutesStatus: "waiting", minutesWaitingSince: at(-10 * MIN) }));
    expect(lead(html)).toBe("ended");
    expect(html).toContain("等妙记");
    expect(html).toContain('aria-checked="true" tabindex="0" data-selected="true">会议记录');
    expect(html).not.toContain("进入飞书会议");
    expect(html).not.toContain("结束会议");
  });

  it("过了预约结束还没收到开始和结束：先给补救的「结束会议」；再过 30 分钟写没开成，主持人在页头改期", () => {
    viewer.id = "p1";
    const overdue = render(booked(-70 * MIN, -10 * MIN, { hasEnded: true }));
    expect(lead(overdue)).toBe("upcoming");
    expect(overdue).toContain("结束会议");
    expect(headerEnd(overdue)).toContain("重新安排会议");

    const missed = render(booked(-120 * MIN, -60 * MIN, { hasEnded: true }));
    expect(missed).toContain("没开成");
    expect(missed).not.toContain("会议中");
    expect(current(missed)).toContain('data-step="waiting" data-state="current" data-tone="fail"');
    expect(current(missed)).toContain("没开成");
    expect(missed).not.toContain('data-state="todo"');
    expect(headerEnd(missed)).toContain("重新安排会议");
    expect(missed).not.toContain("进入飞书会议");
    expect(missed).toContain("结束会议");
    const payload = meetingCard(booked(-120 * MIN, -60 * MIN, { hasEnded: true })).payload as Parameters<typeof meetingNeedsPolling>[0];
    expect(meetingNeedsPolling(payload, true, "missed")).toBe(false);
  });

  it("没在飞书约上的会照旧：到点就是会议中，工具栏里有「重新安排会议」「结束会议」", () => {
    viewer.id = "p1";
    const html = render({ scheduledAt: at(-10 * MIN), endsAt: at(50 * MIN) });
    expect(lead(html)).toBe("live");
    expect(html).toContain("会议中");
    expect(headerEnd(html)).toBe("");
    expect(current(html)).toContain('data-step="live" data-state="current" data-tone="live"');
    expect(current(html)).not.toContain("重新安排会议");
    expect(html).toContain("重新安排会议");
    expect(html).toContain("结束会议");
    // 页头正下方一行：左边进度线、右边两个文字操作；挂点和主持、参会那一行在它下面，再往下才是会议内容。
    const order = ['aria-label="进度"', ">重新安排会议<", ">结束会议<", "主持 · ", 'aria-label="AI 预审：'].map((mark) => html.indexOf(mark));
    expect(order.every((index) => index > -1)).toBe(true);
    expect(order).toEqual([...order].sort((a, b) => a - b));
  });
});
