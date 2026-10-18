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
  timeBoundary: "", tradeoffs: "", keyPath: "", resources: "", humanAgentSplit: "", retrospect: "", placeholder: false, personalCard: null,
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

/** 非首条 Mission：deep link 必须展开它自己的内容，不能被首条覆盖。 */
const secondPayload: MissionPayload = {
  ...payload,
  missionId: "07-1",
  code: "07-1",
  title: "组织能力 Gap 与补位决策",
  ownerId: "person-002",
  ownerDisplayName: "秦梦怡",
  capabilityId: "talent-organization",
  capabilityCode: "08",
  capabilityName: "组织与人才",
  outcome: "把组织能力 Gap 转成可执行的补位决策。",
  why: "补位节奏滞后于业务。",
  sourceTitle: "秦梦怡｜2026 年 9 月 Mission Card",
};

const secondCard: Card = {
  schemaVersion: 1,
  id: "mission:07-1",
  version: 1,
  kind: "mission",
  objectRef: { type: "mission", id: "07-1", version: 1 },
  title: "07-1 组织能力 Gap 与补位决策",
  payload: secondPayload,
  actions: [{ actionId: "signed-action-2", actionType: "mission.edit", label: "编辑 Mission" }],
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
      [{ period: "2026/09" }, "周期需为 YYYY-MM（月份 01–12）"],
      [{ period: "2026-99" }, "周期需为 YYYY-MM（月份 01–12）"],
      [{ period: "2026-00" }, "周期需为 YYYY-MM（月份 01–12）"],
      [{ ownerId: "" }, "必须指定唯一负责人"],
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
    expect(html).toContain(">1 条<");
    expect(html).toContain("按编号、标题或负责人搜索");
    expect(html).toContain("LHR-A");
  });

  it("默认不展开编辑器，空态只写「未选择 Mission」", () => {
    expect(html).not.toContain("保存新版本");
    expect(html).toContain("未选择 Mission");
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
    expect(editing).not.toContain("保存后 version +1");
    expect(editing).toContain("取消");
    expect(editing).toContain("保存新版本");
  });

  it("非首条 deep link 展开目标 Mission，不套用首条内容", () => {
    const editing = renderToStaticMarkup(
      <MissionManagementScreen
        missions={[card, secondCard]}
        battlefields={battlefields}
        capabilities={capabilities}
        people={people}
        initialMissionId="07-1"
      />,
    );
    expect(editing).toContain("07-1 · 当前版本 v1");
    expect(editing).toContain('value="组织能力 Gap 与补位决策"');
    expect(editing).not.toContain('value="CEO Agent 架构与质量"');
    // 根因回归：草稿若错拿首条，patch 非空 → 保存按钮可点，会把首条内容写回目标 Mission
    const beforeSave = editing.slice(0, editing.indexOf("保存新版本"));
    expect(beforeSave.slice(beforeSave.lastIndexOf("<button"))).toContain("disabled");
  });

  it("deep link 未命中时不选中任何 row，也不回落到首条", () => {
    const editing = renderToStaticMarkup(
      <MissionManagementScreen missions={[card, secondCard]} battlefields={battlefields} capabilities={capabilities} people={people} initialMissionId="no-such-mission" />,
    );
    expect(editing).toContain("未选择 Mission");
    expect(editing).not.toContain("保存新版本");
    expect(editing).not.toContain('aria-current="true"');
  });

  it("空注册表仍渲染列表卡与空态", () => {
    const empty = renderToStaticMarkup(
      <MissionManagementScreen missions={[]} battlefields={battlefields} capabilities={capabilities} people={people} />,
    );
    expect(empty).toContain(">0 条<");
    expect(empty).toContain("未选择 Mission");
  });

  it("挂在任务卡上的 Mission 在配置里不展开可编辑表单，只给「打开任务卡」", () => {
    const locked = { ...card, actions: [], payload: { ...payload, placeholder: true, personalCard: { cardId: "personal-01", roundId: "round-01", status: "draft" } } } as Card;
    const html = renderToStaticMarkup(<MissionManagementScreen missions={[locked]} battlefields={battlefields} capabilities={capabilities} people={people} initialMissionId="lhr-a" />);
    expect(html).toContain("草稿 · 占位");
    expect(html).toContain("月度承诺 · 含待确认草稿");
    expect(html).not.toContain("Organization Fact · CEO 确认");
    expect(html).not.toContain("不能在配置页单独修改");
    expect(html).toContain("打开任务卡");
    expect(html).not.toContain("保存新版本");
    expect(html).not.toContain('value="CEO Agent 架构与质量"');
  });

  it("已确定任务卡继续锁住普通编辑，给「打开任务卡」去更正", () => {
    const locked = { ...card, actions: [], payload: { ...payload, personalCard: { cardId: "personal-01", roundId: "round-01", status: "confirmed" } } } as Card;
    const html = renderToStaticMarkup(<MissionManagementScreen missions={[locked]} battlefields={battlefields} capabilities={capabilities} people={people} initialMissionId="lhr-a" />);
    expect(html).toContain("打开任务卡");
    expect(html).toContain("Organization Fact · CEO 确认");
    expect(html).not.toContain("月度承诺 · 含待确认草稿");
    expect(html).not.toContain("保存新版本");
  });

  it("当前查看独立历史 Mission 时，不被列表里的未确认任务卡改变顶栏文案", () => {
    const draftCard = { ...secondCard, actions: [], payload: { ...secondPayload, personalCard: { cardId: "personal-02", roundId: "round-01", status: "open" } } } as Card;
    const html = renderToStaticMarkup(<MissionManagementScreen missions={[card, draftCard]} battlefields={battlefields} capabilities={capabilities} people={people} initialMissionId="lhr-a" />);
    expect(html).toContain("Organization Fact · CEO 确认");
    expect(html).not.toContain("月度承诺 · 含待确认草稿");
  });
});
