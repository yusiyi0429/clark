import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { CapabilityScreen, capabilityDraft, capabilityEditPatch, supportKey } from "./CapabilityScreen";
import type { TBattlefieldManagementResponse, TCapabilityManagementResponse, TCapabilitySupportRef } from "@warmap/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const capabilities: TCapabilityManagementResponse["capabilities"] = [
  { id: "cap-delivery", version: 1, code: "02", sortOrder: 20, name: "区域仓配服务", group: "供应链能力", sixMonthOutcome: "覆盖三国本地仓的仓配与退货能力", supportRefs: [{ type: "battlefield", battlefieldId: "growth" }] },
  { id: "cap-agent", version: 3, code: "03", sortOrder: 30, name: "Agent 安全基线", group: "平台能力", sixMonthOutcome: "权限限制、审批留痕与紧急停机", supportRefs: [{ type: "all-battlefields" }] },
];
const battlefields: TBattlefieldManagementResponse["battlefields"] = [
  {
    id: "growth",
    version: 1,
    code: "01",
    sortOrder: 10,
    name: "增长战场",
    ownerId: "",
    ownerDisplayName: "",
    sixMonthOutcome: "",
    missionAnchors: [{ code: "01-1", title: "未来组织范式设计与确认" }],
    pendingIssueCount: 0,
  },
];

/** W3：能力管理页投影渲染冒烟（PATCH 写入链路由 API config.test.ts 覆盖）。 */
describe("能力管理页渲染", () => {
  const html = renderToStaticMarkup(<CapabilityScreen capabilities={capabilities} battlefields={battlefields} />);

  it("渲染 Top Nav、Page Header 与能力列表卡头", () => {
    expect(html).toContain("返回配置");
    expect(html).toContain("配置变更写入业务库并同步 Radar 监测范围");
    expect(html).toContain("CAPABILITY");
    expect(html).toContain("能力管理");
    expect(html).toContain("编辑已登记的组织能力：编号、分组、六个月目标与主要支撑。修改后首页能力面板立即更新。");
    expect(html).toContain("2 项已登记能力 · 点击编辑");
  });

  it("每行展示编号、名称与「分组 · 六个月目标」，并给出铅笔编辑入口", () => {
    expect(html).toContain("区域仓配服务");
    expect(html).toContain("供应链能力 · 覆盖三国本地仓的仓配与退货能力");
    expect(html).toContain("Agent 安全基线");
    expect(html).toContain("平台能力 · 权限限制、审批留痕与紧急停机");
    expect(html).toContain('aria-label="编辑区域仓配服务"');
    expect(html).toContain('aria-label="编辑Agent 安全基线"');
  });

  it("默认不展开编辑弹层，页脚给出提示与完成出口", () => {
    expect(html).not.toContain("编辑能力");
    expect(html).toContain("修改后立即生效，影响首页分组与议题归属显示");
    expect(html).toContain("完成");
  });

  it("空注册表仍渲染页头与页脚，不报错", () => {
    const empty = renderToStaticMarkup(<CapabilityScreen capabilities={[]} battlefields={battlefields} />);
    expect(empty).toContain("0 项已登记能力 · 点击编辑");
  });
});

describe("能力管理页 CSS 基线", () => {
  const source = readFileSync(new URL("../../../styles/capability-management.module.css", import.meta.url), "utf8");

  it("单张 1212 能力列表卡与行内选中态照设计", () => {
    expect(source).toContain("width:1212px");
    expect(source).toContain(".row[data-editing]{background:#e8f1ff}");
    expect(source).toContain(".row[data-editing] .dot{background:#007aff}");
    expect(source).toContain(".rowMeta{overflow:hidden;font-size:12px;color:#6e6e73");
  });

  it("编辑弹层 440 宽、输入框与保存按钮取设计色值", () => {
    expect(source).toContain("width:320px;background:#fff;border-radius:14px;outline:1px solid #e6e9ed");
    expect(source).toContain(".wide{width:440px;max-width:calc(100% - 48px)}");
    expect(source).toContain("height:36px;border:0;outline:1px solid #d9dde5;border-radius:9px;background:#f7f8fa");
    expect(source).toContain(".support{display:flex;flex-direction:column;gap:4px;max-height:132px");
    expect(source).toContain(".save{background:#007aff");
  });
});

/** 主要支撑是结构化联合：规范键用于比较勾选集合，勾选顺序不影响语义。 */
describe("能力编辑弹层提交字段", () => {
  const current = capabilityDraft(capabilities[0]);

  it("规范键区分全部战场 / 战场 / 战略锚点", () => {
    expect(supportKey({ type: "all-battlefields" })).toBe("all");
    expect(supportKey({ type: "battlefield", battlefieldId: "growth" })).toBe("bf:growth");
    expect(supportKey({ type: "mission-anchor", missionCode: "01-1" })).toBe("m:01-1");
  });

  it("未改动不发字段，改名去空格，顺序转数字", () => {
    expect(capabilityEditPatch(current, current)).toEqual({});
    expect(capabilityEditPatch(current, { ...current, name: " 区域仓配 " })).toEqual({ name: "区域仓配" });
    expect(capabilityEditPatch(current, { ...current, sortOrder: "90" })).toEqual({ sortOrder: 90 });
    expect(capabilityEditPatch(current, { ...current, sortOrder: "" })).toEqual({});
  });

  it("主要支撑按勾选集合比较：同集合不同顺序不算改动", () => {
    const refs: TCapabilitySupportRef[] = [{ type: "all-battlefields" }, { type: "mission-anchor", missionCode: "01-1" }];
    expect(capabilityEditPatch({ ...current, supportRefs: [...refs] }, { ...current, supportRefs: [...refs].reverse() })).toEqual({});
    expect(capabilityEditPatch(current, { ...current, supportRefs: [{ type: "mission-anchor", missionCode: "01-1" }] })).toEqual({
      supportRefs: [{ type: "mission-anchor", missionCode: "01-1" }],
    });
  });
});
