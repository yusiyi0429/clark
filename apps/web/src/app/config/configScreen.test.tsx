import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigScreen } from "./ConfigScreen";

// 页面是 client component；node 环境没有 App Router，只需 useRouter 存在即可做渲染冒烟。
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const people = [
  { personId: "person-1", displayName: "白田田", roles: ["dri", "participant"] },
  { personId: "person-2", displayName: "刘明华", roles: ["ceo"] },
];
const battlefields = [{ id: "growth", name: "增长战场" }];
const strategy = { version: 3, ltco: "春节前完成核心业务第一次被真实证明" };

/** W5：配置页 2×2 卡片的渲染冒烟（写入路径本身由 API config.test.ts 覆盖）。 */
describe("配置页渲染", () => {
  const html = renderToStaticMarkup(<ConfigScreen people={people} battlefields={battlefields} strategy={strategy} />);

  it("渲染 Top Nav、Page Header 与 Draft Status", () => {
    expect(html).toContain("返回首页");
    expect(html).not.toContain("配置变更写入业务库并同步 Radar 监测范围");
    expect(html).toContain("退出登录");
    expect(html).toContain("SETTINGS");
    expect(html).not.toContain("创建与管理组织级对象");
  });

  it("按设计顺序渲染 LTCO 与四张卡片，议题标题硬限 25 字", () => {
    const order = ["公司长期目标", "新建会议", "新建议题", "新建战场", "新建能力"];
    const positions = order.map((title) => html.indexOf(title));
    expect(positions.every((position) => position >= 0)).toBe(true);
    expect([...positions].sort((a, b) => a - b)).toEqual(positions);
    expect(html).toContain('maxLength="25"');
    expect(html.match(/type="submit"/g)).toHaveLength(5);
    // 返回首页 + 管理 Mission + 退出登录 + 管理战场 + 管理能力：五个次级入口，都不提交表单；
    // 另有 6 个统一下拉 / 日期的触发器（主持人、会议日期、会议时刻、所属战场、决定期限、战场负责人），同样不提交
    const triggers = html.match(/data-slot="field-trigger"/g) ?? [];
    expect(triggers).toHaveLength(6);
    expect((html.match(/type="button"/g) ?? []).length - triggers.length).toBe(5);
  });

  it("战场/能力表单按设计收编号、顺序、六个月目标", () => {
    expect(html).toContain("显示编号 / 顺序");
    expect(html).toContain("六个月目标");
    expect(html).toContain("负责人");
    expect(html).toContain("所属分组（可选）");
    expect(html).not.toContain("长期目标更新后，下一次月度草案使用新版本");
    expect(html).toContain("春节前完成核心业务第一次被真实证明");
    expect(html.match(/max="9999"/g)).toHaveLength(2);
  });

  it("卡片页脚不写说明，主按钮文案照设计", () => {
    for (const hint of ["创建后进入会前预审", "议题进入待决策队列", "创建后进入战场管理", "出现在首页公司能力面板"]) expect(html).not.toContain(hint);
    expect(html).toContain("创建并进入会前预审");
    expect(html).toContain("管理战场");
    expect(html).toContain("管理能力");
  });

  it("会议卡内嵌会前材料上传区，说明只收 PDF/DOCX/Markdown", () => {
    expect(html).toContain("上传会前材料");
    expect(html).toContain("PDF、DOCX、Markdown · 可拖拽多个文件至此");
    expect(html).toContain('accept=".pdf,.docx,.md"');
    expect(html).toContain('type="file"');
  });

  it("选项来自真实投影：战场 select、DRI select 与负责人 select", () => {
    expect(html).toContain('<option value="growth"');
    expect(html).toContain('<option value="person-1"');
    // DRI 下拉只取 dri 角色；负责人下拉取全量人员（含 CEO），并可待指派
    expect(html).toContain('<option value="person-2"');
    expect(html).toMatch(/<option value="__select-empty__"( selected="")?>待指派<\/option>/);
    expect(html).not.toContain('type="datetime-local"');
    expect(html).not.toContain('type="date"');
  });
});

describe("配置页 CSS 基线", () => {
  const source = readFileSync(new URL("../../styles/config.module.css", import.meta.url), "utf8");

  it("页面留白与 2×2 卡片阵照设计", () => {
    expect(source).toContain("padding:36px 56px 60px");
    expect(source).toContain(".grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;max-width:2448px;align-items:start}");
    expect(source).toContain(".card{position:relative;box-sizing:border-box;height:460px");
    expect(source).toContain("border-radius:20px;outline:1px solid #e6e9ed");
  });

  it("LTCO 整行卡与战场/能力 610 高卡照设计", () => {
    expect(source).toContain(".ltco{grid-column:1/-1;height:236px}");
    expect(source).toContain(".tall{height:610px}");
    expect(source).toContain(".pair{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,1fr);gap:14px}");
    expect(source).toContain(".field textarea{width:100%;min-height:82px}");
    expect(source).toContain(".ltcoInput{width:100%;min-height:82px}");
  });

  it("输入框、图标芯片、上传条与页脚按钮取设计色值", () => {
    // 输入框的边、圆角、底色、聚焦走 globals.css 的统一输入框样式（--field-*），这里只管宽高；不再有 outline 描边与蓝色粗聚焦框。
    expect(source).toContain(".field input,.field select{width:100%;height:44px;padding:0 16px}");
    expect(source).not.toMatch(/.field[^{]*:focus{outline:2px/);
    expect(source).not.toContain("resize:vertical");
    expect(source).toContain(".iconChip{position:absolute;top:22px;right:24px");
    expect(source).toContain("background:#e8f1ff;color:#0a5dc2");
    expect(source).toContain("top:322px;left:24px;right:24px");
    expect(source).toContain("background:#f7f8fa;outline:1px solid #b9d6f8");
    expect(source).toContain(".primary{display:inline-flex;align-items:center;gap:8px;border:0;border-radius:11px;background:#007aff;padding:11px 17px");
  });
});
