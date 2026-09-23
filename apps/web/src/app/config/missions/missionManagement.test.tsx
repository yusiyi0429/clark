import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import type { MissionPayload } from "@/cards/payloads";
import { MissionManagementScreen, missionDraft, missionEditPatch, parseMissionLines } from "./MissionManagementScreen";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const payload: MissionPayload = {
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
  sourceRef: "mission-cards/01",
  sourceDocumentId: "doc-01",
  sourceRevision: 3,
  sourceTitle: "刘人豪 2026 年 9 月 Mission Card",
};

const card: Card = {
  schemaVersion: 1,
  id: "mission:lhr-a",
  version: 2,
  kind: "mission",
  objectRef: { type: "mission", id: "lhr-a", version: 2 },
  title: "LHR-A CEO Agent 架构与质量",
  payload,
  actions: [{ actionId: "signed-action", actionType: "mission.edit", label: "编辑 Mission" }],
} as unknown as Card;

const battlefields = [
  { id: "01", name: "灯塔项目" },
  { id: "02", name: "Token Ops" },
];
const capabilities = [{ id: "agent-能力", code: "04", name: "Agent 能力" }];
const people = [{ personId: "person-001", displayName: "刘人豪", roles: ["dri"] }];

/** W3：配置页编辑只提交改动字段，source metadata 不进入 patch。 */
describe("Mission 配置草稿与 patch", () => {
  const draft = missionDraft(payload);

  it("草稿保留多行字段，空行不产生空条目", () => {
    expect(draft.successEvidence).toBe("架构评审通过");
    expect(parseMissionLines("A\n\n  B  \n")).toEqual(["A", "B"]);
  });

  it("未改动时 patch 为空，保存按钮据此禁用", () => {
    const result = missionEditPatch(draft, draft);
    expect(result.ok).toBe(true);
    expect(result.ok && result.patch).toEqual({});
  });

  it("只提交改动字段，battlefieldIds 支持清空，文本与行集合都可改", () => {
    const result = missionEditPatch(draft, {
      ...draft,
      title: "新标题",
      battlefieldIds: [],
      successEvidence: "架构评审通过\n灰度两周无 P0",
      why: "补充背景",
    });
    expect(result).toEqual({
      ok: true,
      patch: { title: "新标题", battlefieldIds: [], successEvidence: ["架构评审通过", "灰度两周无 P0"], why: "补充背景" },
    });
  });

  it("编号、标题、周期、DRI、能力域与 Outcome 缺失时给出可读错误", () => {
    const cases: [Partial<typeof draft>, string][] = [
      [{ code: "  " }, "编号不能为空"],
      [{ title: "" }, "Mission 标题不能为空"],
      [{ period: "2026/09" }, "周期需为 YYYY-MM"],
      [{ ownerId: "" }, "必须指定唯一 DRI"],
      [{ capabilityId: "" }, "必须选择主要能力域"],
      [{ outcome: "" }, "Mission Outcome 不能为空"],
    ];
    for (const [override, error] of cases) {
      expect(missionEditPatch(draft, { ...draft, ...override })).toEqual({ ok: false, error });
    }
  });
});

describe("Mission 配置页渲染", () => {
  const html = renderToStaticMarkup(
    <MissionManagementScreen missions={[card]} battlefields={battlefields} capabilities={capabilities} people={people} />,
  );

  it("渲染 Top Nav、Page Header 与已登记列表", () => {
    expect(html).toContain("返回配置");
    expect(html).toContain("Organization Fact · CEO 确认");
    expect(html).toContain("MISSION SETTINGS");
    expect(html).toContain("Mission 配置");
    expect(html).toContain("1 条 · 按周期与能力域排序");
    expect(html).toContain("按编号、标题或 DRI 搜索");
    expect(html).toContain("LHR-A");
  });

  it("默认不展开编辑器，给出选中提示", () => {
    expect(html).not.toContain("保存新版本");
    expect(html).toContain("选择左侧 Mission 后编辑结果承诺与关系。");
  });

  it("带 missionId 进入时直接展开编辑器：版本、来源、关系选项与页脚都在", () => {
    const editing = renderToStaticMarkup(
      <MissionManagementScreen missions={[card]} battlefields={battlefields} capabilities={capabilities} people={people} initialMissionId="lhr-a" />,
    );
    expect(editing).toContain("编辑 Mission");
    expect(editing).toContain("当前版本 v2");
    expect(editing).toContain("来源 · 刘人豪 2026 年 9 月 Mission Card");
    expect(editing).toContain("主要能力域");
    expect(editing).toContain("关联战场");
    expect(editing).toContain("月度计划");
    expect(editing).toContain("Mission Outcome");
    expect(editing).toContain("Why / 背景");
    expect(editing).toContain("成功证据（每行一项）");
    expect(editing).toContain("关键里程碑（每行一项）");
    expect(editing).toContain("关键依赖");
    expect(editing).toContain("最大风险");
    expect(editing).toContain("边界");
    expect(editing).toContain("保存后 version +1；历史来源与旧版本保持可追溯。");
    expect(editing).toContain("取消");
    expect(editing).toContain("保存新版本");
  });

  it("空注册表仍渲染列表卡与空态", () => {
    const empty = renderToStaticMarkup(
      <MissionManagementScreen missions={[]} battlefields={battlefields} capabilities={capabilities} people={people} />,
    );
    expect(empty).toContain("0 条 · 按周期与能力域排序");
    expect(empty).toContain("选择左侧 Mission 后编辑结果承诺与关系。");
  });
});
