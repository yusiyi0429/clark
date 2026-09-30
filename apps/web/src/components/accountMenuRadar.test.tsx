import { afterEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

// 菜单与弹窗都在浮层里，服务端渲染看不到：照 welcome.test 的办法直接调用组件、按真实的点击处理器走一遍。
const hooks = vi.hoisted(() => {
  let active = false;
  let slots: unknown[] = [];
  let cursor = 0;
  return {
    get active() { return active; },
    begin() { active = true; cursor = 0; },
    reset() { active = false; slots = []; cursor = 0; },
    useState<T>(initial: T | (() => T)) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [slots[index] as T, (value: T | ((previous: T) => T)) => {
        slots[index] = typeof value === "function" ? (value as (previous: T) => T)(slots[index] as T) : value;
      }] as const;
    },
  };
});
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return { ...react, useState: (initial?: unknown) => (hooks.active ? hooks.useState(initial) : react.useState(initial)),
    useRef: (initial?: unknown) => (hooks.active ? { current: initial } : react.useRef(initial)), useEffect: (...args: Parameters<typeof react.useEffect>) => (hooks.active ? undefined : react.useEffect(...args)) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));

import { AccountMenu, MenuDialog } from "./AccountMenu";
import { RadarSettingsEditor } from "@/components/radar/RadarSettingsEditor";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement(node) ? text((node as Element).props.children as ReactNode) : "";
}
function render(role: "ceo" | "member", onNavigate?: (href: string) => void) {
  hooks.begin();
  return AccountMenu({ account: { displayName: "孙铭泽", loginId: "sunm", role }, onNavigate });
}
const item = (tree: ReactNode, label: string) => elements(tree).find((element) => typeof element.props.onPress === "function" && text(element.props.children as ReactNode) === label);

afterEach(() => hooks.reset());

describe("个人菜单里的雷达", () => {
  it("CEO 和成员都显示连接入口", () => {
    expect(item(render("member"), "连接到外部工具")).toBeDefined();
    expect(item(render("ceo"), "连接到外部工具")).toBeDefined();
  });
  it("成员叫「我的雷达」；声纹状态未确认时不显示声纹入口；打开后能去看我的雷达信号", () => {
    const navigate = vi.fn();
    const labels = elements(render("member", navigate)).filter((element) => typeof element.props.onPress === "function").map((element) => text(element.props.children as ReactNode));
    expect(labels).toContain("我的雷达");
    expect(labels).not.toContain("我的声纹");
    (item(render("member", navigate), "我的雷达")!.props.onPress as () => void)();
    const tree = render("member", navigate);
    const dialog = elements(tree).find((element) => element.type === MenuDialog);
    expect(dialog?.props.title).toBe("我的雷达");
    expect(elements(tree).find((element) => element.type === RadarSettingsEditor)?.props.mode).toBe("person");
    const link = elements(tree).find((element) => element.type === "a");
    expect(link?.props.href).toBe("/me/radar");
    expect(text(link?.props.children as ReactNode)).toBe("看我的雷达信号");
    const click = { preventDefault: vi.fn() };
    (link!.props.onClick as (event: typeof click) => void)(click);
    expect(click.preventDefault).toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith("/me/radar");
    expect(elements(render("member", navigate)).some((element) => element.type === MenuDialog)).toBe(false);
  });

  it("CEO 叫「雷达设置」，改的是公司雷达，没有个人信号入口", () => {
    (item(render("ceo"), "雷达设置")!.props.onPress as () => void)();
    const tree = render("ceo");
    expect(elements(tree).find((element) => element.type === MenuDialog)?.props.title).toBe("雷达设置");
    expect(elements(tree).find((element) => element.type === RadarSettingsEditor)?.props.mode).toBe("company");
    expect(elements(tree).some((element) => element.type === "a")).toBe(false);
    expect(item(tree, "我的雷达")).toBeUndefined();
  });
});
