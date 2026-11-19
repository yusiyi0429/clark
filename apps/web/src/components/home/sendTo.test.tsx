import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/** 首页输入框的「发给」菜单。没有 jsdom：弹出菜单（Dropdown）换成直接画出来的桩（同 sessionsPanel.test）。 */
vi.mock("@heroui/react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@heroui/react")>();
  const { createElement, Fragment } = await import("react");
  type Props = { children?: unknown; [key: string]: unknown };
  const Dropdown = Object.assign(({ children }: Props) => createElement(Fragment, null, children as never), {
    Trigger: ({ children, ...rest }: Props) => createElement("button", { type: "button", ...rest }, children as never),
    Popover: ({ children }: Props) => createElement(Fragment, null, children as never),
    Menu: ({ children, "aria-label": label }: Props) => createElement("ul", { "aria-label": label }, children as never),
    Item: ({ children, id }: Props) => createElement("li", { "data-key": id }, children as never),
    Section: ({ children }: Props) => createElement(Fragment, null, children as never),
  });
  return { ...actual, Dropdown };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));

import type { Project } from "@/lib/home/projects";
import { HomeComposer } from "./HomeView";

const project = (id: string, name: string, extra: Partial<Project> = {}) => ({
  id, name, folder: null, archived: false, goals: [], current: [], subSessions: [], items: [], scope: `project:${id}`, waiting: 0, lastActivity: null, budget: null,
  unseen: false, transfer: null, scratch: false, ...extra,
}) as Project;

describe("首页「发给」菜单", () => {
  it("发给菜单不列随手", () => {
    const html = renderToStaticMarkup(<HomeComposer buddy={null} projects={[project("p1", "品牌建设"), project("s1", "随手", { scratch: true })]}
      route={async () => "main"} onSend={async () => undefined} />);
    expect(html).toContain('data-key="project:p1"');
    expect(html).toContain("品牌建设");
    expect(html).not.toContain('data-key="project:s1"');
    expect(html).not.toContain("随手");
  });
});
