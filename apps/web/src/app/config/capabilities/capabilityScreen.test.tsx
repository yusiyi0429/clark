import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { CapabilityScreen } from "./CapabilityScreen";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

const capabilities = [
  { id: "区域仓配服务", version: 1, name: "区域仓配服务", group: "供应链能力", description: "覆盖三国本地仓的仓配与退货能力" },
  { id: "agent-安全基线", version: 3, name: "Agent 安全基线", group: "平台能力", description: "权限限制、审批留痕与紧急停机" },
];

/** W3：能力管理页投影渲染冒烟（PATCH 写入链路由 API config.test.ts 覆盖）。 */
describe("能力管理页渲染", () => {
  const html = renderToStaticMarkup(<CapabilityScreen capabilities={capabilities} />);

  it("渲染 Top Nav、Page Header 与能力列表卡头", () => {
    expect(html).toContain("返回配置");
    expect(html).toContain("配置变更写入业务库并同步 Radar 监测范围");
    expect(html).toContain("CAPABILITY");
    expect(html).toContain("能力管理");
    expect(html).toContain("编辑已登记的组织能力：名称、分组与说明。修改后首页能力面板立即更新。");
    expect(html).toContain("2 项已登记能力 · 点击编辑");
  });

  it("每行标题与「分组 · 说明」元信息照设计，并给出铅笔编辑入口", () => {
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
    const empty = renderToStaticMarkup(<CapabilityScreen capabilities={[]} />);
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

  it("编辑弹层 320 宽、输入框与保存按钮取设计色值", () => {
    expect(source).toContain("width:320px;background:#fff;border-radius:14px;outline:1px solid #e6e9ed");
    expect(source).toContain("height:36px;border:0;outline:1px solid #d9dde5;border-radius:9px;background:#f7f8fa");
    expect(source).toContain(".save{background:#007aff");
  });
});
