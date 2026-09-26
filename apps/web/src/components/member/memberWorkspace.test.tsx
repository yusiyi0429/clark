import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { MemberWorkspace } from "./MemberWorkspace";

const navigation = vi.hoisted(() => ({ pathname: "/me" }));
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname, useSearchParams: () => null, useRouter: () => ({ push: vi.fn(), refresh: vi.fn() }) }));

describe("成员工作台外壳", () => {
  it("写出是谁、左上角是退出登录，通知栏为空时说明", () => {
    const html = renderToStaticMarkup(<MemberWorkspace displayName="孙铭泽" />);
    expect(html).toContain('data-testid="member-workspace"');
    expect(html).toContain(">孙铭泽<");
    expect(html).toContain('aria-label="退出登录"');
    expect(html).toContain("暂时没有新通知");
    expect(html).not.toContain('aria-label="配置"');
    expect(html).toContain('aria-label="孙铭泽，打开个人菜单"');
    // 声纹收进个人菜单，首页不再直接放声纹卡片
    expect(html).not.toContain("我的声纹");
  });

  it("首页底部是自己的 Agent（全局对话输入条）", () => {
    const html = renderToStaticMarkup(<MemberWorkspace displayName="孙铭泽" />);
    expect(html).toContain('data-testid="global-controls"');
    expect(html).toContain('data-conversation-context="global"');
    expect(html).toContain("查看“我的 Agent”的对话记录");
  });

  it("个人卡在展开区内，首页 DOM 保留并暂停交互，左侧通知折成同一窄条", () => {
    navigation.pathname = "/me/mission-cards/personal-01";
    const html = renderToStaticMarkup(<MemberWorkspace displayName="孙铭泽" viewerId="sun" ><h1>个人卡正文</h1></MemberWorkspace>);
    expect(html).toContain('data-detail-open="true"');
    expect(html).toContain('data-testid="expanded-panel"');
    expect(html).toContain('data-testid="notice-strip"');
    expect(html).toContain('aria-hidden="true" inert=""');
    expect(html).toContain("个人卡正文");
    expect(html).toContain('aria-label="执行事项"');
    expect(html).not.toContain('aria-label="配置"');
    navigation.pathname = "/me";
  });
});
