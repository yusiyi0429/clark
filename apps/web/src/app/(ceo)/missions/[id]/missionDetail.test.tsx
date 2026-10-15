import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactElement } from "react";
import { WorkspaceTestProvider } from "@/components/shell/testing";
import type { MissionPayload } from "@/cards/payloads";
import { MissionDetailScreen, planRelation } from "./MissionDetailScreen";

const markup = (node: ReactElement) => renderToStaticMarkup(<WorkspaceTestProvider>{node}</WorkspaceTestProvider>);

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const mission: MissionPayload = {
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
  why: "上一季度返工集中在权限边界。",
  successEvidence: ["架构评审通过", "灰度两周无 P0"],
  milestones: ["09-15 评审", "09-30 灰度"],
  dependencies: "平台团队提供评测环境",
  risk: "节奏被打断",
  boundaries: "不含模型训练",
  timeBoundary: "", tradeoffs: "", keyPath: "", resources: "", humanAgentSplit: "", retrospect: "", placeholder: false, personalCard: null,
  sourceRef: "mission-cards/01",
  sourceDocumentId: "doc-01",
  sourceRevision: 3,
  sourceTitle: "刘人豪 2026 年 9 月 Mission Card",
};

const render = (overrides: Partial<MissionPayload> = {}, planStatus: string | null = null) =>
  markup(<MissionDetailScreen mission={{ ...mission, ...overrides }} planStatus={planStatus} />);

/** W3：详情只展示正式承诺与关系，生效中由同周期月度计划状态派生。 */
describe("Mission 详情渲染", () => {
  const html = render();

  it("页头眉题给出编号与周期，页头动作返回总览 / 编辑 Mission，正文写唯一负责人；未签发时不显示生效中", () => {
    expect(html).toContain("Mission LHR-A · 2026-09");
    expect(html).toContain("返回总览");
    expect(html).toContain("编辑 Mission");
    expect(html).toContain('aria-label="返回全局"');
    expect(html).toContain("唯一负责人 · 刘人豪");
    expect(html).not.toContain("生效中");
  });

  it("关系条展示能力域、关联战场、月度计划与来源", () => {
    expect(html).toContain("能力域");
    expect(html).toContain("04 Agent 能力");
    expect(html).toContain("灯塔项目");
    expect(html).toContain("2026-09 · 尚未签发");
    expect(html).toContain("刘人豪 2026 年 9 月 Mission Card");
  });

  it("Outcome Hero、成功证据、关键里程碑与侧栏四块都在", () => {
    expect(html).toContain("MISSION OUTCOME");
    expect(html).toContain("把 CEO Agent 的架构与质量基线定下来。");
    expect(html).toContain("背景 · 上一季度返工集中在权限边界。");
    expect(html).toContain("架构评审通过");
    expect(html).toContain("灰度两周无 P0");
    expect(html).toContain("09-15 评审");
    expect(html).toContain("09-30 灰度");
    expect(html).toContain("关键依赖");
    expect(html).toContain("最大风险");
    expect(html).toContain("边界");
    expect(html).toContain("来源追溯");
    expect(html).toContain("修订 revision 3");
    expect(html).toContain("外部文档更新不会自动覆盖当前正式版本");
  });

  it("同周期月度计划已签发时显示生效中，不显示进度或完成率", () => {
    const signed = render({}, "已签发");
    expect(signed).toContain("生效中");
    expect(signed).toContain("2026-09 · 已签发");
    expect(signed).not.toContain("完成率");
    expect(signed).not.toContain("执行状态");
  });

  it("空 why 不渲染背景行，空集合给出明确说明而不是空白", () => {
    const bare = render({ why: "", successEvidence: [], milestones: [], dependencies: "", risk: "", boundaries: "" });
    expect(bare).not.toContain("背景 ·");
    expect(bare).toContain("来源未给出成功证据。");
    expect(bare).toContain("来源未给出关键里程碑。");
    expect(bare).toContain("来源未给出。");
  });

  it("planRelation 在无同周期计划时明确写尚未签发", () => {
    expect(planRelation("2026-09", "协商中")).toBe("2026-09 · 协商中");
    expect(planRelation("2026-09", null)).toBe("2026-09 · 尚未签发");
  });

  it("签发月度目标不能让任务卡草稿冒充生效版本，也不提供普通编辑", () => {
    for (const status of ["draft", "open", "reviewing"] as const) {
      const html = render({ placeholder: true, personalCard: { cardId: "personal-01", roundId: "round-01", status } }, "已签发");
      expect(html).toContain("草稿 · 占位");
      expect(html).not.toContain("生效中");
      expect(html).not.toContain("编辑 Mission");
      expect(html).not.toContain("当前正式版本");
    }
  });

  it("已确认的任务卡标已确定，仍保留占位来源且没有普通编辑入口", () => {
    const html = render({ placeholder: true, personalCard: { cardId: "personal-01", roundId: "round-01", status: "confirmed" } }, "已签发");
    expect(html).toContain("已确定 · 占位");
    expect(html).not.toContain("编辑 Mission");
    expect(html).toContain('href="/mission-cards/personal-01"');
    expect(html).toContain("查看所属任务卡");
  });
});
