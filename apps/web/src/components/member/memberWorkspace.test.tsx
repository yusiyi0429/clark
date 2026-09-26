import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemberWorkspace } from "./MemberWorkspace";

describe("成员工作台外壳", () => {
  it("写出是谁、左上角是退出登录，通知栏为空时说明", () => {
    const html = renderToStaticMarkup(<MemberWorkspace displayName="孙铭泽" />);
    expect(html).toContain('data-testid="member-workspace"');
    expect(html).toContain(">孙铭泽<");
    expect(html).toContain('aria-label="退出登录"');
    expect(html).toContain("暂时没有新通知");
    expect(html).not.toContain('aria-label="配置"');
  });
});
