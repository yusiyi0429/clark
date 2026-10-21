import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MeetingCard } from "./MeetingCard";
import { meetingCard } from "./meetingWorkspace.test";

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
    expect(host).toContain("挂到");
    expect(host).toContain("接口全量切到 v2");
    expect(host).toContain(">改<");
    expect(host).not.toContain("记录 ·");
    expect(host.indexOf("接口全量切到 v2")).toBeLessThan(host.indexOf("p1主持") === -1 ? host.indexOf("主持") : host.indexOf("p1主持"));
    viewer.id = "someone-else";
    world.detail = { world: { excluded: false, excludedBy: null, record: null, at: null, anchors, edited: false, canEdit: false }, decisions: [] };
    const attendee = render();
    expect(attendee).toContain("接口全量切到 v2");
    expect(attendee).not.toContain(">改<");
    world.detail = null;
    expect(render()).not.toContain("挂到");
  });
});

describe("飞书会议入口", () => {
  const feishu = (status: string, extra: Record<string, unknown> = {}) => ({ feishuEvent: { status, joinUrl: null, organizerId: "p1", ...extra } });
  const retry = [{ actionId: "f1", actionType: "meeting.retry_feishu_booking", label: "重试飞书预约" }];
  const render = (payload: Record<string, unknown>, actions: { actionId: string; actionType: string; label: string }[] = []) => {
    const card = meetingCard(payload, actions);
    return renderToStaticMarkup(<MeetingCard card={card} collection={[card]} onCard={() => undefined} onNavigate={() => undefined} readOnly />);
  };

  it("约上了：会前那一行灰字后面是「进入飞书会议」，参会的人都看得到；开完了不再出", () => {
    const booked = feishu("booked", { joinUrl: "https://vc.feishu.cn/j/123456789" });
    viewer.id = "someone-else";
    expect(render(booked)).toContain('href="https://vc.feishu.cn/j/123456789"');
    expect(render(booked)).toContain("进入飞书会议");
    expect(render({ ...booked, hasEnded: true })).not.toContain("进入飞书会议");
    expect(render(feishu("pending"))).not.toContain("飞书");
  });

  it("等连飞书：只有约的人本人看到「连接飞书」", () => {
    viewer.id = "p1";
    expect(render(feishu("waiting_auth"))).toContain("连接飞书");
    viewer.id = "someone-else";
    expect(render(feishu("waiting_auth"))).not.toContain("连接飞书");
  });

  it("没约上：主持人看到短状态和「重试」，别人看不到", () => {
    viewer.id = "p1";
    const html = render(feishu("failed"), retry);
    expect(html).toContain("飞书未约上");
    expect(html).toMatch(/<button[^>]*>重试<\/button>/);
    viewer.id = "someone-else";
    expect(render(feishu("failed"), retry)).not.toContain("飞书未约上");
  });
});
