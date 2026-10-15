import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";

import { WorkspaceTestProvider } from "@/components/shell/testing";
import { BattlefieldDetailScreen, missionsByOwner, type BattlefieldTab } from "./BattlefieldDetailScreen";

function card(kind: string, id: string, title: string, payload: unknown): Card {
  return { schemaVersion: 1, id: `${kind}:${id}`, version: 1, kind, objectRef: { type: kind, id, version: 1 }, title, payload, actions: [] } as unknown as Card;
}

const feedback = (text: string, observedAt: string) => ({ text, observedAt, sourceRef: `dri://${text}`, evidenceRef: null });

function battlefield(overrides: Record<string, unknown> = {}): Card {
  return card("battlefield", "growth", "增长战场", {
    battlefieldId: "growth",
    code: "01",
    sortOrder: 10,
    name: "增长战场",
    ownerId: "person-bai",
    ownerDisplayName: "白田田",
    sixMonthOutcome: "六个月内渠道跑通",
    missionAnchors: [{ code: "01-1", title: "渠道切换" }],
    period: "2026-09",
    target: "九月完成渠道切换",
    pendingIssues: [{ id: "i1", title: "是否追加渠道预算", urgency: "red", location: { level: "battlefield", battlefieldId: "growth" } }],
    todos: [{ id: "t1", title: "整理渠道名单", ownerId: "person-bai", dueAt: "2026-09-20", sourceRef: "x", exportStatus: "delivered", exportRef: null }],
    latestFeedback: feedback("最新反馈", "2026-09-12T02:00:00.000Z"),
    feedback: [feedback("最新反馈", "2026-09-12T02:00:00.000Z"), feedback("较早反馈", "2026-09-05T02:00:00.000Z")],
    ...overrides,
  });
}

const mission = (id: string, code: string, owner: string, battlefieldIds = ["growth"]) =>
  card("mission", id, code, {
    missionId: id,
    code,
    title: `${code} 的标题`,
    ownerId: owner,
    ownerDisplayName: owner,
    battlefieldIds,
    successEvidence: ["证据一", "证据二"],
    milestones: ["9/15 评审"],
  });

const issue = card("issue", "i1", "是否追加渠道预算", { status: "pending", location: { level: "battlefield", battlefieldId: "growth" }, urgency: { level: "red" } });

const cards = [issue, mission("m1", "01-1", "刘人豪"), mission("m2", "01-2", "孙铭泽"), mission("m3", "01-3", "刘人豪"), mission("m4", "02-1", "王创峰", ["token-ops"])];

const render = (tab: BattlefieldTab, bf = battlefield(), viewerId: string | null = null) =>
  renderToStaticMarkup(
    <WorkspaceTestProvider api={{ viewerId }}>
      <BattlefieldDetailScreen battlefield={bf} cards={cards} initialTab={tab} />
    </WorkspaceTestProvider>,
  );

describe("战场二级页", () => {
  it("本战场本月的 Mission 按负责人分组（只含归属这个战场的）", () => {
    const groups = missionsByOwner(cards, "growth");
    expect(groups.map((group) => group.owner)).toEqual(["刘人豪", "孙铭泽"]);
    expect(groups[0].missions.map((item) => item.code)).toEqual(["01-1", "01-3"]);
  });

  it("页头是战场名 + 「决策 / 战况」切换；负责人是别人时写出负责人", () => {
    const html = render("decisions");
    expect(html).toContain(">增长战场<");
    expect(html).toContain('role="radiogroup" aria-label="战场视角"');
    expect(html).toMatch(/role="radio"[^>]*aria-checked="true"[^>]*>决策</);
    expect(html).toContain(">决策<");
    expect(html).toContain(">战况<");
    expect(html).not.toContain(">待决策<");
    expect(html).toContain("负责人 · 白田田");
  });

  it("待决策：负责人反馈、议题、六个月与本月目标、战役", () => {
    const html = render("decisions");
    expect(html).toContain("最新反馈");
    expect(html).toContain("是否追加渠道预算");
    expect(html).toContain("六个月内渠道跑通");
    expect(html).toContain("九月完成渠道切换");
    expect(html).toContain("渠道切换");
    // 待决策页签不展开进展明细。
    expect(html).not.toContain("整理渠道名单");
  });

  it("进展：汇总不出百分比；按负责人列 Mission；普通待办与反馈历史都在", () => {
    const html = render("progress");
    expect(html).toContain("本月 3 条 Mission · 成功证据 6 项");
    // 没有真实核对数据时不写「未报告」「尚未登记」，也不放不可用的「按战役 / 甘特图」切换。
    expect(html).not.toContain("未报告");
    expect(html).not.toContain("尚未登记");
    expect(html).not.toContain("甘特图");
    expect(html).not.toMatch(/\d+%/);
    expect(html).toContain("01-3 的标题");
    expect(html).not.toContain("02-1 的标题");
    expect(html).toContain("整理渠道名单");
    expect(html).toContain("已送达");
    expect(html).toContain("较早反馈");
  });

  it("CEO 兼任负责人：「战况」页签带皇冠，不再写负责人", () => {
    const html = render("decisions", battlefield({ ownerId: "person-ceo", ownerDisplayName: "刘明华" }), "person-ceo");
    expect(html).toContain('aria-label="战况（一号位为本战场负责人）"');
    expect(html).not.toContain("负责人 · 刘明华");
  });

  it("没有签发计划、没有反馈、没有议题时照实写空态", () => {
    const html = render("decisions", battlefield({ period: null, target: null, latestFeedback: null, feedback: [], pendingIssues: [] }));
    expect(html).toContain("尚未签发当月目标");
    expect(html).toContain("尚未收到负责人反馈");
    expect(html).toContain(">无待决策议题<");
    expect(html).not.toContain("暂无待决策议题");
  });
});
