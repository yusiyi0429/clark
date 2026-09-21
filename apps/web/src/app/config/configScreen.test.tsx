import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConfigScreen } from "./ConfigScreen";

// 页面是 client component；node 环境没有 App Router，只需 useRouter 存在即可做渲染冒烟。
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn() }) }));

const people = [
  { personId: "person-1", displayName: "白田田", roles: ["dri", "participant"] },
  { personId: "person-2", displayName: "刘明华", roles: ["ceo"] },
];
const battlefields = [{ id: "growth", name: "增长战场" }];

/** W5：配置页四张表单的渲染冒烟（写入路径本身由 API config.test.ts 覆盖）。 */
describe("配置页渲染", () => {
  const html = renderToStaticMarkup(<ConfigScreen people={people} battlefields={battlefields} />);

  it("渲染 Top Nav 与 SETTINGS header", () => {
    expect(html).toContain("SETTINGS");
    expect(html).toContain("返回首页");
  });

  it("渲染四张表单，且议题标题硬限 25 字", () => {
    for (const title of ["新建战场", "新建能力", "新建议题", "新建会议"]) expect(html).toContain(title);
    expect(html).toContain('maxLength="25"');
  });

  it("选项来自真实投影：战场 select 与 DRI 人员 select", () => {
    expect(html).toContain('<option value="growth"');
    expect(html).toContain('<option value="person-1"');
    expect(html).not.toContain("person-2");
  });

  it("会议卡只有创建并跳转一个动作，不在配置页做二段上传", () => {
    expect(html).toContain("创建 Meeting 并前往上传会前材料");
    expect(html.match(/type="submit"/g)).toHaveLength(4);
  });
});
