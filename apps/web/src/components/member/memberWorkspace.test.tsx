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
    expect(html).not.toContain("发给你的信号");
    // 采集到的工作全部自动归到执行事项，首页没有计划外。
    expect(html).not.toContain("计划外");
  });

  it("首页换成操作区加 Mission 卡片：没有「我的本月卡」「参与的战场」和旧的执行事项网格，左栏没有「请求」页头和 ＋", () => {
    const html = renderToStaticMarkup(<MemberWorkspace displayName="孙铭泽" viewerId="sun" />);
    expect(html).toContain('aria-label="常用操作"');
    expect(html).toContain("等回复");
    // 战场进展一直在，进原来那张战场进展页。
    expect(html).toContain('data-origin="/me/progress"');
    // 旧执行事项区的工具条（「N 项执行事项在推进」）和区块都不在了；「开启执行事项」现在在 Mission 卡片的三栏里。
    for (const gone of ["我的本月卡", "参与的战场", "项执行事项在推进", 'aria-label="执行事项"', 'data-widget=']) expect(html).not.toContain(gone);
    expect(html).not.toContain('aria-label="打开请求列表"');
    expect(html).not.toContain('aria-label="新请求"');
    // 约会议只在操作区里有一个，右上角那个去掉了。
    expect(html.match(/约会议/g)).toHaveLength(1);
  });

  it("首页底部是自己的 Agent（全局对话输入条）", () => {
    const html = renderToStaticMarkup(<MemberWorkspace displayName="孙铭泽" />);
    expect(html).toContain('data-testid="global-controls"');
    expect(html).toContain('data-conversation-context="global"');
    // D2 / D6：没有历史键；收起时是语音胶囊，打字面与对话层一起开合。
    expect(html).toContain('data-composer="voice"');
    expect(html).not.toContain("的对话记录");
  });

  it("任务卡在展开区内，首页 DOM 保留并暂停交互，左侧通知折成同一窄条", () => {
    navigation.pathname = "/me/mission-cards/personal-01";
    const html = renderToStaticMarkup(<MemberWorkspace displayName="孙铭泽" viewerId="sun" ><h1>任务卡正文</h1></MemberWorkspace>);
    expect(html).toContain('data-detail-open="true"');
    expect(html).toContain('data-testid="expanded-panel"');
    expect(html).toContain('data-testid="notice-strip"');
    expect(html).toContain('aria-hidden="true" inert=""');
    expect(html).toContain("任务卡正文");
    expect(html).toContain('aria-label="常用操作"');
    expect(html).not.toContain('aria-label="配置"');
    navigation.pathname = "/me";
  });

  it("成员战场沿用展开区，不出现尚未开放的战场 Agent 右列", () => {
    navigation.pathname = "/me/battlefields/growth";
    const html = renderToStaticMarkup(<MemberWorkspace displayName="孙铭泽"><h1>战场目标</h1></MemberWorkspace>);
    expect(html).toContain('data-testid="expanded-panel"');
    expect(html).toContain('data-topic-rail="false"');
    navigation.pathname = "/me";
  });

  it.each(["/me/radar", "/me/radar/signals/0f0f0f0f-0000-4000-8000-000000000001"])("我的雷达 %s 在展开区里打开，不挂对话右列（成员只有全局对话）", (pathname) => {
    navigation.pathname = pathname;
    const html = renderToStaticMarkup(<MemberWorkspace displayName="孙铭泽"><h1>我的雷达</h1></MemberWorkspace>);
    expect(html).toContain('data-testid="expanded-panel"');
    expect(html).toContain('data-topic-rail="false"');
    navigation.pathname = "/me";
  });
});
