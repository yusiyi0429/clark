import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

/**
 * 个人菜单（5.4.6）有哪几项。没有 jsdom：HeroUI 的 Dropdown 换成直接把内容画出来的桩（不管开没开），看菜单里的字；
 * 「开菜单时读到的开关」那份状态一开始就当全开（双角色、管理员、任务数据质量都开着），这样老代码会画出「任务数据质量」。
 */
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState: (initial: unknown) => actual.useState(initial && typeof initial === "object" && "switchView" in initial
      ? { switchView: true, admin: true, taskQuality: true } : initial),
  };
});
vi.mock("@heroui/react", () => {
  const pass = ({ children }: { children?: ReactNode }) => <div>{children}</div>;
  const Item = ({ children, id }: { children?: ReactNode; id?: string }) => <div data-item={id}>{children}</div>;
  return { Dropdown: Object.assign(pass, { Trigger: pass, Popover: pass, Menu: pass, Section: pass, Item }) };
});
vi.mock("@/components/avatar/PersonAvatar", () => ({ PersonAvatar: ({ children }: { children?: ReactNode }) => <span>{children}</span> }));

import { PersonRow } from "./PersonMenu";

describe("个人菜单", () => {
  it("技能、我的记忆在里面；「任务数据质量」不在新首页的菜单里（用户 11/08 定）", () => {
    const html = renderToStaticMarkup(<PersonRow account={{ displayName: "孙铭泽", loginId: "sunm", role: "member", personId: "sun-mingze" } as never}
      view={{ kind: "home" }} alert={false} go={() => undefined} />);
    const items = [...html.matchAll(/data-item="([^"]+)"/g)].map((match) => match[1]);
    // 连接、技能合成一项「连接和技能」（11/09 用户定）。
    expect(items).toEqual(["profile", "buddy", "connections", "memory", "preferences", "mode-manage", "mode-work", "admin", "lock", "logout"]);
    expect(html).toContain('data-item="connections">连接和技能<');
    expect(html).not.toContain("任务数据质量");
  });

  it("CEO 的两种模式（17.2 第 45 条）：一组两项「管理模式」「工作模式」，新首页里打勾的是工作模式；不写「切换到…」", () => {
    const html = renderToStaticMarkup(<PersonRow account={{ displayName: "王路遥", loginId: "wangluyao", role: "member", personId: "wang-luyao" } as never}
      view={{ kind: "home" }} alert={false} go={() => undefined} />);
    expect(html).toMatch(/data-item="mode-manage"><span[^>]*>管理模式<\/span><\/div>/);
    expect(html).toMatch(/data-item="mode-work"><span[^>]*>工作模式<\/span><svg/);
    expect(html).not.toContain("切换到");
  });
});
