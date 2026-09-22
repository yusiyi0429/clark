import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { BattlefieldScreen, battlefieldDraft, battlefieldEditPatch, formatMissions, parseMissions } from "./BattlefieldScreen";
import type { TBattlefieldManagementResponse } from "@warmap/contracts";
import type { PersonOption } from "@/lib/api/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

type Issue = TBattlefieldManagementResponse["issues"][number];

const battlefields: TBattlefieldManagementResponse["battlefields"] = [
  {
    id: "growth",
    version: 2,
    code: "01",
    sortOrder: 10,
    name: "增长战场",
    ownerId: "person-fixture-002",
    ownerDisplayName: "陈珂",
    sixMonthOutcome: "验证渠道结构与交付节奏",
    missions: [{ code: "01-1", title: "未来组织范式设计与确认" }],
    pendingIssueCount: 2,
  },
  { id: "delivery", version: 1, code: "02", sortOrder: 20, name: "交付战场", ownerId: "", ownerDisplayName: "", sixMonthOutcome: "", missions: [], pendingIssueCount: 1 },
];
const people: PersonOption[] = [{ personId: "person-fixture-002", displayName: "陈珂", roles: ["dri", "participant"] }];
const issues: Issue[] = [
  { id: "i1", title: "是否追加东南亚渠道预算 40%", urgencyLevel: "red", decisionBy: "2025-09-30", battlefieldIds: ["growth"] },
  { id: "i2", title: "明年研发预算向平台还是应用倾斜", urgencyLevel: "yellow", battlefieldIds: ["growth", "delivery"] },
  { id: "i3", title: "二期触发条件阈值口径", urgencyLevel: "gray", decisionBy: "2025-10-10", battlefieldIds: [] },
];

/** W6：战场管理页投影渲染冒烟（写入链路由 API config.test.ts 覆盖）。 */
describe("战场管理页渲染", () => {
  const html = renderToStaticMarkup(<BattlefieldScreen battlefields={battlefields} issues={issues} people={people} />);

  it("渲染页头与战场列表，默认选中第一个战场", () => {
    expect(html).toContain("战场管理");
    expect(html).toContain("选择战场后管理其关联议题：可以新建议题，也可以把已有议题加入战场。");
    expect(html).toContain("2 个战场 · 选择后管理关联议题");
    expect(html).toContain("负责人 陈珂 · 2 个议题");
    expect(html).toContain("负责人 待指派 · 1 个议题");
    expect(html.match(/data-selected="true"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="删除增长战场"');
    expect(html).toContain('aria-label="删除交付战场"');
  });

  it("关联议题只列当前战场的议题，并标注归属与期限", () => {
    expect(html).toContain("增长战场 · 2 个议题");
    expect(html).toContain("增长战场 · 期限 09-30");
    expect(html).toContain("增长战场、交付战场 · 待校准");
    expect(html).toContain("议题可同时关联多个战场");
    // i3 未归属增长战场，只出现在添加议题里
    expect(html.split("二期触发条件阈值口径")).toHaveLength(2);
  });

  it("添加议题列出全部待决策议题，勾选态即归属态", () => {
    expect(html).toContain("已有议题（3）");
    expect(html).toContain("从已有议题中选择加入本战场");
    expect(html).toContain("未归属 · 期限 10-10");
    // i1、i2 已属增长战场：行与勾选圆点各一处
    expect(html.match(/data-member="true"/g)).toHaveLength(4);
    expect(html).toContain("加入后议题会出现在该战场的关联议题中");
  });

  it("默认不展开删除确认与编辑弹层，页脚给出两条完成出口", () => {
    expect(html).not.toContain("删除该战场？");
    expect(html).not.toContain("编辑战场");
    expect(html).toContain("删除战场会解除其议题关联");
    expect(html.match(/完成/g)).toHaveLength(2);
  });

  it("每行给出铅笔编辑入口，删除仍独立", () => {
    expect(html).toContain('aria-label="编辑增长战场"');
    expect(html).toContain('aria-label="编辑交付战场"');
    expect(html).toContain('aria-label="删除增长战场"');
  });
});

describe("战场管理页 CSS 基线", () => {
  const source = readFileSync(new URL("../../../styles/battlefield-management.module.css", import.meta.url), "utf8");

  it("左 620 列表 + 右 400/630 卡片，间距照设计", () => {
    expect(source).toContain(".body{display:flex;align-items:flex-start;gap:20px;max-width:2448px}");
    expect(source).toContain(".left{flex:none;width:620px}");
    expect(source).toContain(".listCard{height:1050px}");
    expect(source).toContain(".relatedCard{height:400px}");
    expect(source).toContain(".pickCard{height:630px}");
  });

  it("行内编辑/删除图标与编辑弹层取设计色值", () => {
    expect(source).toContain(".rowIcon{display:grid;place-items:center;flex:none;width:24px;height:24px");
    expect(source).toContain(".save{background:#007aff");
    expect(source).toContain("height:36px;border:0;outline:1px solid #d9dde5;border-radius:9px;background:#f7f8fa");
  });

  it("选中态、紧急度圆点与删除确认弹层取设计色值", () => {
    expect(source).toContain(".row[data-selected],.pickRow[data-member]{background:#e8f1ff}");
    expect(source).toContain(".dot[data-urgency=red]{background:#e34b43}");
    expect(source).toContain(".dot[data-urgency=yellow]{background:#c79624}");
    expect(source).toContain(".confirm{position:absolute;top:95px;left:310px;");
    expect(source).toContain("box-shadow:0 10px 28px #0a0f1e33");
    expect(source).toContain(".danger{background:#a1443c");
  });

  it("编辑弹层 420 宽，含 Mission 文本域与编号/顺序双列", () => {
    expect(source).toContain(".wide{left:186px;width:420px}");
    expect(source).toContain(".pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:8px}");
    expect(source).toContain(".field textarea{box-sizing:border-box;width:100%;min-height:72px");
  });
});

/** 编辑弹层只提交改动字段：负责人可能是空串，未改动时不能把它当新值发出去（会被 400 拒）。 */
describe("战场编辑弹层提交字段", () => {
  const current = battlefieldDraft(battlefields[1]);

  it("未改动的空负责人不进 patch，只改六个月目标时只发 sixMonthOutcome", () => {
    expect(battlefieldEditPatch(current, current)).toEqual({ ok: true, patch: {} });
    expect(battlefieldEditPatch(current, { ...current, sixMonthOutcome: "锁定关键器件" })).toEqual({ ok: true, patch: { sixMonthOutcome: "锁定关键器件" } });
  });

  it("主动指定负责人提交 personId，改名发去空格后的名字", () => {
    expect(battlefieldEditPatch(current, { ...current, ownerId: "person-fixture-002" })).toEqual({ ok: true, patch: { ownerId: "person-fixture-002" } });
    expect(battlefieldEditPatch(current, { ...current, name: " 供应链战场 " })).toEqual({ ok: true, patch: { name: "供应链战场" } });
    expect(battlefieldEditPatch(current, { ...current, name: "   " })).toEqual({ ok: true, patch: {} });
  });

  it("编号/顺序以文本编辑，改动才转成数字下发", () => {
    expect(battlefieldEditPatch(current, { ...current, code: "07" })).toEqual({ ok: true, patch: { code: "07" } });
    expect(battlefieldEditPatch(current, { ...current, sortOrder: "70" })).toEqual({ ok: true, patch: { sortOrder: 70 } });
    expect(battlefieldEditPatch(current, { ...current, sortOrder: "abc" })).toEqual({ ok: true, patch: {} });
  });
});

/** Mission 只以「编号 标题」逐行文本编辑：存储仍是结构化 {code,title}。 */
describe("Mission 文本与结构化值互转", () => {
  it("格式化与解析对齐设计里的两行示例", () => {
    const missions = [
      { code: "01-1", title: "未来组织范式设计与确认" },
      { code: "01-2", title: "CEO Agent 常态化使用" },
    ];
    expect(formatMissions(missions)).toBe("01-1 未来组织范式设计与确认\n01-2 CEO Agent 常态化使用");
    expect(parseMissions(formatMissions(missions))).toEqual({ ok: true, missions });
  });

  it("空文本与空行合法，标题里的空格保留", () => {
    expect(parseMissions("")).toEqual({ ok: true, missions: [] });
    expect(parseMissions("\n  \n")).toEqual({ ok: true, missions: [] });
    expect(parseMissions("01-1  未来 组织范式 ")).toEqual({ ok: true, missions: [{ code: "01-1", title: "未来 组织范式" }] });
  });

  it("缺编号、缺标题、编号重复都报错并阻止下发", () => {
    expect(parseMissions("01-1 标题\n孤儿编号")).toEqual({ ok: false, error: "第 2 行缺少编号或标题：每行需为「编号 空格 标题」" });
    expect(parseMissions(" 只有标题")).toEqual({ ok: false, error: "第 1 行缺少编号" });
    expect(parseMissions("01-1 ")).toEqual({ ok: false, error: "第 1 行缺少标题" });
    expect(parseMissions("01-1 标题\n01-1 另一标题")).toEqual({ ok: false, error: "第 2 行编号 01-1 重复" });
    const current = battlefieldDraft(battlefields[0]);
    expect(battlefieldEditPatch(current, { ...current, missions: "01-1 标题\n01-1 重复" })).toEqual({ ok: false, error: "第 2 行编号 01-1 重复" });
  });

  it("编辑弹层比较文本：改一行才发 missions", () => {
    const current = battlefieldDraft(battlefields[0]);
    expect(battlefieldEditPatch(current, { ...current, missions: formatMissions(battlefields[0].missions) })).toEqual({ ok: true, patch: {} });
    expect(battlefieldEditPatch(current, { ...current, missions: "01-1 改过的标题" })).toEqual({ ok: true, patch: { missions: [{ code: "01-1", title: "改过的标题" }] } });
  });
});
