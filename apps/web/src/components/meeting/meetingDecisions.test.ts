import { describe, expect, it, vi } from "vitest";
import type { TMeetingDecisionView, TMyMeetingDecisionGroup, TRequestListItem } from "@warmap/contracts";
import { hostDecisionNotices } from "./HostDecisionNotices";
import { decisionStatusLabel } from "./meetingDecisionApi";
import { impactNotices, requestNotices } from "../requests/RequestNotices";

const decision = (overrides: Partial<TMeetingDecisionView> = {}): TMeetingDecisionView => ({
  id: "d1", meetingId: "m1", tier: "host", ordinal: 1, statement: "接口统一改成 v2，月底前切换", originalStatement: "接口统一改成 v2，月底前切换",
  quote: "接口统一改成 v2", speakerName: "林晓", recommendation: "confirmed", why: null, status: "pending", revision: 0,
  reviewerName: null, reviewedAt: null, dueAt: "2026-10-21T08:00:00.000Z", canReview: true, ...overrides,
});

describe("会上定了：通知栏置顶", () => {
  it("每条一句、带会名和代判时间；对 / 其实没定一点就办，改一下从原说法改起", async () => {
    const groups: TMyMeetingDecisionGroup[] = [{ meetingId: "m1", meetingTitle: "co-agent 交互评审", scheduledAt: "2026-10-20T06:00:00.000Z", dueAt: null,
      decisions: [decision(), decision({ id: "d2", statement: "企业微信暂不接入", originalStatement: "企业微信暂不接入", recommendation: "not_decided" })] }];
    const review = vi.fn(async () => ({ ok: true as const }));
    const navigate = vi.fn();
    const notices = hostDecisionNotices(groups, "/me/meetings", navigate, review);
    expect(notices.map((notice) => notice.title)).toEqual(["接口统一改成 v2，月底前切换", "企业微信暂不接入"]);
    expect(notices[0].detail).toBe("co-agent 交互评审 · 10/21 16:00 前");
    expect(notices[1].detail).toContain("Agent 判断没定");
    expect(notices[0].buttons.map((button) => button.label)).toEqual(["对", "其实没定"]);
    expect(notices[0].reason).toMatchObject({ label: "改一下", initial: "接口统一改成 v2，月底前切换" });
    await notices[0].buttons[1].run();
    await notices[0].reason!.run("接口统一改成 v2，下月 15 日前切换");
    expect(review.mock.calls).toEqual([["m1", "d1", "not_decided"], ["m1", "d1", "edited", "接口统一改成 v2，下月 15 日前切换"]]);
    notices[0].onOpen?.(null);
    expect(navigate).toHaveBeenCalledWith("/me/meetings/m1", null);
  });

  it("状态标：代判分「定了」「没定」，战略项写 CEO", () => {
    expect(decisionStatusLabel({ status: "agent_judged", tier: "host", recommendation: "confirmed" })).toBe("Agent 代判 · 定了");
    expect(decisionStatusLabel({ status: "agent_judged", tier: "host", recommendation: "not_decided" })).toBe("Agent 代判 · 没定");
    expect(decisionStatusLabel({ status: "pending", tier: "strategic", recommendation: "confirmed" })).toBe("待 CEO 确认");
    expect(decisionStatusLabel({ status: "rejected", tier: "strategic", recommendation: "confirmed" })).toBe("CEO 不同意");
  });

  it("代判过、主持人还没点的留在置顶里，写明代判成了什么", () => {
    const groups: TMyMeetingDecisionGroup[] = [{ meetingId: "m1", meetingTitle: "co-agent 交互评审", scheduledAt: "2026-10-20T06:00:00.000Z", dueAt: null,
      decisions: [decision({ status: "agent_judged" }), decision({ id: "d2", status: "agent_judged", recommendation: "not_decided" })] }];
    const notices = hostDecisionNotices(groups, "/me/meetings", vi.fn(), vi.fn(async () => ({ ok: true as const })));
    expect(notices.map((notice) => notice.detail)).toEqual(["co-agent 交互评审 · Agent 代判 · 定了", "co-agent 交互评审 · Agent 代判 · 没定"]);
    expect(notices[0].buttons.map((button) => button.label)).toEqual(["对", "其实没定"]);
  });
});

describe("会后影响：单独一组，不混进请求", () => {
  const item = (overrides: Partial<TRequestListItem>): TRequestListItem => ({
    id: "r1", kind: "relay", title: "填备案表", status: "open", initiatorName: "林晓", createdAt: "2026-10-18T14:00:00.000Z", sentAt: "2026-10-18T14:00:00.000Z",
    myStatus: "pending", recipientNames: ["陈一凡"], recipientsDone: 0, openQuestions: 0, unread: false, ...overrides,
  });
  it("影响卡只进「会后影响」；处理过且已读的不再列", () => {
    const inbox = [item({}), item({ id: "r2", kind: "impact", title: "会议页改接新纪要接口", unread: true }), item({ id: "r3", kind: "impact", myStatus: "done" })];
    expect(impactNotices(inbox).map((notice) => [notice.id, notice.tone])).toEqual([["r2", "amber"]]);
    expect(requestNotices(inbox, []).map((notice) => notice.id)).toEqual(["r1"]);
  });
});
