import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { BattlefieldScreen } from "./BattlefieldScreen";
import type { TBattlefieldManagementResponse } from "@warmap/contracts";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

type Issue = TBattlefieldManagementResponse["issues"][number];

const battlefields: TBattlefieldManagementResponse["battlefields"] = [
  { id: "growth", name: "增长战场", owner: "陈珂", pendingIssueCount: 2 },
  { id: "delivery", name: "交付战场", owner: "", pendingIssueCount: 1 },
];
const issues: Issue[] = [
  { id: "i1", title: "是否追加东南亚渠道预算 40%", urgencyLevel: "red", decisionBy: "2025-09-30", battlefieldIds: ["growth"] },
  { id: "i2", title: "明年研发预算向平台还是应用倾斜", urgencyLevel: "yellow", battlefieldIds: ["growth", "delivery"] },
  { id: "i3", title: "二期触发条件阈值口径", urgencyLevel: "gray", decisionBy: "2025-10-10", battlefieldIds: [] },
];

/** W6：战场管理页投影渲染冒烟（写入链路由 API config.test.ts 覆盖）。 */
describe("战场管理页渲染", () => {
  const html = renderToStaticMarkup(<BattlefieldScreen battlefields={battlefields} issues={issues} />);

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

  it("默认不展开删除确认，页脚给出两条完成出口", () => {
    expect(html).not.toContain("删除该战场？");
    expect(html).toContain("删除战场会解除其议题关联");
    expect(html.match(/完成/g)).toHaveLength(2);
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

  it("选中态、紧急度圆点与删除确认弹层取设计色值", () => {
    expect(source).toContain(".row[data-selected],.pickRow[data-member]{background:#e8f1ff}");
    expect(source).toContain(".dot[data-urgency=red]{background:#e34b43}");
    expect(source).toContain(".dot[data-urgency=yellow]{background:#c79624}");
    expect(source).toContain(".confirm{position:absolute;top:95px;left:310px;");
    expect(source).toContain("box-shadow:0 10px 28px #0a0f1e33");
    expect(source).toContain(".danger{background:#a1443c");
  });
});
