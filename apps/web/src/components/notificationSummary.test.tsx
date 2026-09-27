import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { TMissionRoundSummary } from "@warmap/contracts";
import type { Card } from "@/lib/api/client";
import { NotificationRail, railGroups } from "./NotificationRail";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

function card(kind: string, id: string, title: string, payload: unknown, extra: Partial<Card> = {}): Card {
  return { schemaVersion: 1, id: `${kind}:${id}`, version: 1, kind, objectRef: { type: kind, id, version: 1 }, title, payload, actions: [], ...extra } as unknown as Card;
}

const issue = (id: string, title: string, origin: string, urgency: "red" | "normal", location: unknown) =>
  card("issue", id, title, { origin, originRef: null, status: "pending", location, urgency: { level: urgency === "red" ? "red" : "yellow" } }, { urgency });

const battlefield = card("battlefield", "01", "灯塔项目", { battlefieldId: "01" });
const monthly = card("monthly-plan", "p", "月度计划 2026-09", { period: "2026-09", status: "negotiating" });
const signed = card("monthly-plan", "q", "月度计划 2026-08", { period: "2026-08", status: "confirmed" });
const meeting = (id: string, scheduledAt: string, lead = "bai") =>
  card("meeting", id, `会议 ${id}`, { status: "scheduled", scheduledAt, leadDriId: lead, participants: [{ personId: "bai", displayName: "白田田" }], issueIds: [] });

describe("通知栏分组（clark 三组）", () => {
  it("只收需要行动的：未签发月度计划、已排期会议、红色待决议题；顺序固定", () => {
    const now = new Date("2026-09-23T01:00:00Z");
    const groups = railGroups(
      [
        battlefield,
        monthly,
        signed,
        meeting("m1", "2026-09-23T02:00:00Z"),
        issue("i1", "首次交付承诺，是否必须包含语音体验？", "dri", "red", { level: "battlefield", battlefieldId: "01" }),
        issue("i2", "黄色议题不进通知栏", "dri", "normal", { level: "company", relatedBattlefieldIds: [] }),
        issue("i3", "雷达升级的议题", "radar", "red", { level: "company", relatedBattlefieldIds: [] }),
      ],
      now,
    );
    expect(groups.map((group) => group.title)).toEqual(["战略决策更新", "战略会议安排", "战略问题研究"]);
    expect(groups[0].items.map((item) => item.title)).toEqual(["月度计划 2026-09"]);
    expect(groups[0].items[0].meta).toBe("协商中 · 待签发");
    expect(groups[1].subtitle).toBe("今天 · 白田田主持");
    expect(groups[1].items[0].meta).toBe("10:00");
    expect(groups[2].items.map((item) => item.meta)).toEqual(["灯塔项目 · 提请", "雷达 · 需要尽快判断"]);
    expect(groups[2].items.some((item) => item.title === "黄色议题不进通知栏")).toBe(false);
  });

  it("没有待处理事项的分组整组不出现", () => {
    expect(railGroups([signed])).toEqual([]);
  });

  it("不是今天的会议写日期，副标题写场数", () => {
    const groups = railGroups([meeting("m1", "2026-09-25T02:00:00Z")], new Date("2026-09-23T01:00:00Z"));
    expect(groups[0].subtitle).toBe("1 场待开");
    expect(groups[0].items[0].meta).toBe("9/25 10:00");
  });

  it("没有「稍后处理」与条数上限（C-05：待拍板事项不能被藏起）；左上角是锁屏（退出登录）；胶囊回首页；左下角是自己的名字", () => {
    const many = Array.from({ length: 8 }, (_, index) => issue(`r${index}`, `议题 ${index}`, "radar", "red", { level: "company", relatedBattlefieldIds: [] }));
    const html = renderToStaticMarkup(<NotificationRail cards={many} onNavigate={() => undefined} account={{ displayName: "刘明华", loginId: "lium", role: "ceo" }} />);
    expect(html).not.toContain("稍后处理");
    expect(html.match(/data-tone="red"/g)).toHaveLength(8);
    expect(html).toContain('aria-label="退出登录"');
    expect(html).toContain('aria-label="刘明华，打开个人菜单"');
    expect(html).toContain('aria-label="天枢，返回首页"');
    expect(html).toContain('aria-label="8 项通知"');
  });
});

describe("本月 Mission Card 的 CEO 通知入口", () => {
  const round: TMissionRoundSummary = {
    roundId: "round-01", period: "2026-10", battlefieldId: "01", battlefieldName: "灯塔项目", version: 1,
    phase: "draft", round: 1, openedAt: null, closesAt: null, reviewAt: null, serverNow: "2026-10-01T02:00:00.000Z",
    approver: true, deciderName: "刘明华", todo: null, placeholder: true, draftOrigin: "placeholder", goals: null,
    counts: { cards: 1, feedback: 0, pending: 0, conflicts: 0, dependencies: 0, late: 0, corrections: 0 }, cards: [],
  };
  const summaryCard = (overrides: Partial<TMissionRoundSummary> = {}) => card("mission-round", "round-01", "10 月 Mission Card · 灯塔项目", { ...round, ...overrides });

  it("没有轮次的 slot 与月度计划在战略决策更新同组，不冒充已整理", () => {
    const draft = card("mission-round", "slot-01", "10 月 Mission Card · 灯塔项目", {
      period: "2026-10", battlefieldId: "01", battlefieldName: "灯塔项目", placeholder: true,
      todo: "让 Co-Agent 整理个人卡草稿（占位）", serverNow: round.serverNow,
    }, { objectRef: { type: "mission-round-slot", id: "01:2026-10", version: 1 }, actions: [{ actionId: "signed-slot", actionType: "mission-round.draft", label: "整理个人卡草稿" }] });
    const group = railGroups([monthly, draft])[0];
    expect(group.title).toBe("战略决策更新");
    expect(group.items).toHaveLength(2);
    expect(group.items[1].meta).toBe("可以整理个人卡草稿");
    const html = renderToStaticMarkup(<NotificationRail cards={[draft]} onNavigate={() => undefined} onCard={() => undefined} />);
    expect(html).toContain("10 月 Mission Card · 灯塔项目，可以整理个人卡草稿");
  });

  it.each([
    [{ phase: "drafting" }, "Co-Agent 正在起草"],
    [{ phase: "draft" }, "草稿 · 可以统一开放讨论"],
    [{ phase: "open", closesAt: "2026-10-02T09:24:00.000Z" }, "讨论中 · 31 小时 24 分"],
    [{ phase: "closed" }, "已截止 · 汇总中"],
    [{ phase: "reviewing", counts: { ...round.counts, pending: 5 } }, "5 条待你处理"],
    [{ phase: "reviewing" }, "意见已全部处理，待你确认"],
  ] as const)("已建轮次按服务端阶段给出 %s", (overrides, expected) => {
    expect(railGroups([summaryCard(overrides)], new Date("2030-01-01"))[0].items[0].meta).toBe(expected);
  });

  it("越过服务端截止时刻时不显示负数，确认后退出通知栏", () => {
    expect(railGroups([summaryCard({ phase: "open", closesAt: round.serverNow })])[0].items[0].meta).toBe("已截止 · 汇总中");
    expect(railGroups([summaryCard({ phase: "confirmed" })])).toEqual([]);
  });

  it("已确定后，拍板人有更正申请待处理时这一轮回到通知栏（GAP-04）", () => {
    const row = { cardId: "card-01", ownerId: "sun", ownerName: "孙铭泽", roleLabel: null, missionCount: 2, line: "2 条更正申请", pending: 0,
      firstPendingFeedbackId: null, pendingCorrections: 2, firstPendingCorrectionId: "correction-01", mine: false, placeholder: false };
    const corrections = summaryCard({ phase: "confirmed", todo: "2 条更正申请待你处理", counts: { ...round.counts, corrections: 2 }, cards: [row] });
    expect(railGroups([corrections])[0].items[0]).toMatchObject({ meta: "2 条更正申请待你处理", missionRound: corrections });
    const html = renderToStaticMarkup(<NotificationRail cards={[corrections]} onNavigate={() => undefined} onCard={() => undefined} />);
    expect(html).toContain('aria-label="2 条更正申请待你处理"');
    expect(html).toContain('data-origin="/mission-cards/card-01?correction=correction-01"');
  });
});
