import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work/settings/connections" }));

// 不起浏览器：把 react 的 useState、useContext 换成可重放的假实现；元素的 props 从 JSX 运行时截下来，直接调它们的处理器。
const hooks = vi.hoisted(() => ({
  position: 0, values: [] as unknown[], context: null as unknown,
  useState(initial: unknown) {
    const key = hooks.position++;
    if (!(key in hooks.values)) hooks.values[key] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[key], (next: unknown) => { hooks.values[key] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[key]) : next; }];
  },
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useState: hooks.useState, useContext: () => hooks.context }));
const tap = vi.hoisted(() => ({ props: [] as Record<string, unknown>[] }));
const capture = vi.hoisted(() => <T,>(fn: T) => ((type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
  if (props) tap.props.push(props);
  return (fn as unknown as (...args: unknown[]) => unknown)(type, props, ...rest);
}) as unknown as T);
vi.mock("react/jsx-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-runtime")>();
  return { ...actual, jsx: capture(actual.jsx), jsxs: capture(actual.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-dev-runtime")>();
  return { ...actual, jsxDEV: capture(actual.jsxDEV) };
});

import type { TLocalFolder } from "@warmap/contracts";
import { Folders } from "./ConnectionsPage";

const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const folder = (n: number): TLocalFolder => ({ id: `f${n}`, label: `project-${n}`, path: `C:/work/project-${n}`, addedAt: "2026-11-18T00:00:00.000Z" });

type Local = { folders: TLocalFolder[]; error: string | null; pickFolder: ReturnType<typeof vi.fn> };
const render = () => { hooks.position = 0; tap.props = []; return renderToStaticMarkup(<Folders run={vi.fn()} />); };
/** 整块「文件夹 N 个」那个按钮。 */
const toggle = () => tap.props.find((props) => "aria-expanded" in props)!;
/** 「添加」按钮。 */
const add = () => tap.props.find((props) => props.children === "添加")!;

let local: Local;
beforeEach(() => {
  hooks.values = [];
  local = { folders: [folder(1), folder(2), folder(3)], error: null, pickFolder: vi.fn(async () => null) };
  hooks.context = local;
});

describe("连接页「文件夹」那一行", () => {
  it("连接页文件夹列表默认收起，点了展开，添加一直在", async () => {
    const collapsed = render();
    expect(text(collapsed)).toBe("文件夹 3 个 添加");
    expect(toggle()["aria-expanded"]).toBe(false);
    expect(collapsed).toMatch(/<button[^>]*aria-expanded="false"/);
    expect(collapsed).not.toContain("C:/work/project-1");

    (toggle().onClick as () => void)();
    const open = render();
    expect(toggle()["aria-expanded"]).toBe(true);
    expect(text(open)).toContain("project-1 C:/work/project-1");
    expect(text(open)).toContain("project-3 C:/work/project-3");
    expect(text(open)).toContain("添加");

    // 点「添加」（这次没选）：列表不折起来。
    (add().onPress as () => void)();
    await flush();
    expect(local.pickFolder).toHaveBeenCalledTimes(1);
    render();
    expect(toggle()["aria-expanded"]).toBe(true);

    // 再点一下收起；收起时报错照样显示。
    (toggle().onClick as () => void)();
    local.error = "没选上，请重试";
    const failed = render();
    expect(toggle()["aria-expanded"]).toBe(false);
    expect(failed).not.toContain("C:/work/project-1");
    expect(failed).toMatch(/role="alert"[^>]*>没选上，请重试/);
  });

  it("刚添加文件夹后列表展开", async () => {
    render();
    expect(toggle()["aria-expanded"]).toBe(false);
    local.pickFolder.mockImplementation(async () => { local.folders = [...local.folders, folder(4)]; return folder(4); });
    (add().onPress as () => void)();
    await flush();
    const html = render();
    expect(toggle()["aria-expanded"]).toBe(true);
    expect(text(html)).toContain("文件夹 4 个");
    expect(text(html)).toContain("project-4 C:/work/project-4");
  });
});
