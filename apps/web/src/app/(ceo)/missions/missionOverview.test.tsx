import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { WorkspaceTestProvider } from "@/components/shell/testing";
import type { MissionPayload } from "@/cards/payloads";
import { MissionOverviewScreen, battlefieldScope, filterMissions, missionPeriods, missionStats } from "./MissionOverviewScreen";

const markup = (node: ReactElement) => renderToStaticMarkup(<WorkspaceTestProvider>{node}</WorkspaceTestProvider>);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

function mission(overrides: Partial<MissionPayload> = {}): MissionPayload {
  return {
    missionId: "lhr-a",
    code: "LHR-A",
    period: "2026-09",
    title: "CEO Agent 架构与质量",
    ownerId: "person-001",
    ownerDisplayName: "刘人豪",
    capabilityId: "agent-能力",
    capabilityCode: "04",
    capabilityName: "Agent 能力",
    battlefieldIds: ["01"],
    battlefieldNames: ["灯塔项目"],
    outcome: "把 CEO Agent 的架构与质量基线定下来。",
    why: "",
    successEvidence: ["架构评审通过"],
    milestones: ["09-15 评审"],
    dependencies: "平台团队",
    risk: "节奏被打断",
    boundaries: "不含模型训练",
    timeBoundary: "", tradeoffs: "", keyPath: "", resources: "", humanAgentSplit: "", retrospect: "", placeholder: false, personalCard: null,
    sourceRef: "mission-cards/01",
    sourceDocumentId: "doc-01",
    sourceRevision: 3,
    sourceTitle: "刘人豪 2026 年 9 月 Mission Card",
    ...overrides,
  };
}

const battlefields = [
  { id: "01", name: "灯塔项目" },
  { id: "02", name: "Token Ops" },
  { id: "03", name: "002 客户" },
];
const missions = [
  mission(),
  mission({ missionId: "btt-1", code: "BTT-1", title: "渠道成本治理", ownerId: "person-002", ownerDisplayName: "白田田", capabilityId: "e-o", capabilityCode: "05", capabilityName: "经营效率", battlefieldIds: ["02", "03"], battlefieldNames: ["Token Ops", "002 客户"] }),
  mission({ missionId: "old-1", code: "OLD-1", period: "2026-08", title: "上月 Mission", ownerId: "person-002", ownerDisplayName: "白田田" }),
];

/** W3：Mission 总览的筛选、统计与「全战场」派生都在 Web 侧纯函数里，可单独验证。 */
describe("Mission 总览派生", () => {
  it("周期倒序去重，统计只数当前集合里的真实关系", () => {
    expect(missionPeriods(missions)).toEqual(["2026-09", "2026-08"]);
    expect(missionStats(missions.filter((item) => item.period === "2026-09"))).toEqual({
      missions: 2,
      owners: 2,
      battlefields: 3,
      capabilities: 2,
    });
  });

  it("四个筛选维度都可叠加，空串表示不筛", () => {
    const all = { period: "", battlefieldId: "", capabilityId: "", ownerId: "" };
    expect(filterMissions(missions, all)).toHaveLength(3);
    expect(filterMissions(missions, { ...all, period: "2026-09" })).toHaveLength(2);
    expect(filterMissions(missions, { ...all, battlefieldId: "03" })).toHaveLength(1);
    expect(filterMissions(missions, { ...all, capabilityId: "agent-能力" })).toHaveLength(2);
    expect(filterMissions(missions, { ...all, ownerId: "person-002", period: "2026-08" })).toHaveLength(1);
    expect(filterMissions(missions, { ...all, ownerId: "person-999" })).toHaveLength(0);
  });

  it("覆盖全部已登记战场时显示「全战场」，否则按注册顺序列出战场名", () => {
    expect(battlefieldScope(mission(), ["01", "02", "03"])).toBe("灯塔项目");
    expect(battlefieldScope(mission({ battlefieldIds: ["01", "02", "03"] }), ["01", "02", "03"])).toBe("全战场");
    expect(battlefieldScope(mission({ battlefieldIds: ["01"] }), [])).toBe("灯塔项目");
  });
});

describe("Mission 总览渲染", () => {
  const html = markup(<MissionOverviewScreen missions={missions} battlefields={battlefields} />);

  it("标准页头（返回 + 眉题 + 标题 + 管理 Mission）与四项统计", () => {
    expect(html).toContain('class="ts-detail-header"');
    expect(html).toContain('<p class="ts-eyebrow">月度承诺</p>');
    expect(html).toContain("Mission 总览");
    expect(html).toContain("管理 Mission");
    expect(html).toContain("data-close-view");
    expect(html).toContain("本月 Mission");
    expect(html).toContain("负责人");
    expect(html).toContain("关联战场");
    expect(html).toContain("主要能力域");
  });

  it("默认只列最新周期的 Mission，行内给出编号/标题/DRI·能力域·战场", () => {
    expect(html).toContain("LHR-A");
    expect(html).toContain("CEO Agent 架构与质量");
    expect(html).toContain("刘人豪 · 04 Agent 能力 · 灯塔项目");
    expect(html).toContain("白田田 · 05 经营效率 · Token Ops · 002 客户");
    expect(html).not.toContain("上月 Mission");
    expect(html).toContain("2 条 · 按能力域与编号排序");
  });

  it("筛选面板覆盖周期/战场/能力域/DRI，并保留全战场选项", () => {
    expect(html).toContain("全部战场");
    expect(html).toContain("全部能力域");
    expect(html).toContain("全部负责人");
    expect(html).toContain("2026-09");
    expect(html).toContain("002 客户");
  });

  it("从能力面板带 capabilityId 进入时预选该能力域", () => {
    const filtered = markup(
      <MissionOverviewScreen missions={missions} battlefields={battlefields} initialFilters={{ capabilityId: "e-o" }} />,
    );
    expect(filtered).toContain("渠道成本治理");
    expect(filtered).not.toContain("CEO Agent 架构与质量");
  });

  it("战场覆盖全部注册战场时该行显示「全战场」", () => {
    const covering = markup(
      <MissionOverviewScreen missions={[mission({ battlefieldIds: ["01", "02", "03"] })]} battlefields={battlefields} />,
    );
    expect(covering).toContain("· 全战场");
  });

  it("空集合仍渲染页头与空态", () => {
    const empty = markup(<MissionOverviewScreen missions={[]} battlefields={battlefields} />);
    expect(empty).toContain("当前筛选没有 Mission。");
    expect(empty).toContain("共 0 条 Mission");
  });

  it("挂卡 Mission 确认前标草稿和占位，确认后保留占位来源", () => {
    const render = (status: "draft" | "confirmed") => markup(<MissionOverviewScreen missions={[mission({
      placeholder: true, personalCard: { cardId: "personal-01", roundId: "round-01", status },
      sourceTitle: "占位（Agent 未接入，沿用 9 月任务卡，待讨论修改）",
    })]} battlefields={battlefields} />);
    expect(render("draft")).toContain("草稿 · 占位");
    expect(render("draft")).toContain("沿用 9 月任务卡");
    expect(render("confirmed")).toContain("已确定 · 占位");
  });
});
