import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

/* 把传版本的放置区当函数调用：hooks 用按调用顺序存值的小仓库代替（同 meetingBooking.behavior.test），按下「说说现状」再调一次看写现状的框。 */
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0, refs: [] as { current: unknown }[], refIndex: 0,
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[index]) : next;
    }];
  },
  useRef(initial: unknown) { return hooks.refs[hooks.refIndex++] ??= { current: initial }; },
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useState: hooks.useState, useRef: hooks.useRef }));

import { HeroButton } from "@/components/HeroButton";
import { DeliverableComposer } from "./DeliverableComposer";

type Node = { type?: unknown; props?: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const node = value as Node;
  return node.props ? [node, ...nodes(node.props.children)] : [];
}
const text = (node: Node): string => {
  const children = node.props?.children;
  return (Array.isArray(children) ? children : [children]).map((child) => (typeof child === "string" ? child : child && typeof child === "object" ? text(child as Node) : "")).join("");
};
const render = (startWithStatement = false) => {
  hooks.index = 0; hooks.refIndex = 0;
  return nodes(DeliverableComposer({ previous: null, startWithStatement, onSubmit: async () => null, onCancel: null }) as ReactElement);
};
/** 按钮是 HeroButton（新首页设计 5.2 的四种按钮），按下是 onPress。 */
const press = (tree: Node[], label: string) => (tree.find((node) => node.type === HeroButton && text(node) === label)!.props!.onPress as () => void)();
const statement = (tree: Node[]) => tree.find((node) => node.type === "textarea");

beforeEach(() => { hooks.values = []; hooks.refs = []; });

describe("传新版本：说说现状", () => {
  it("点放置区里的「说说现状」：写现状的框出来，光标就在里面", () => {
    const before = render();
    expect(statement(before)).toBeUndefined();
    press(before, "说说现状");
    expect(statement(render())?.props?.autoFocus).toBe(true);
  });

  it("框已经开着时再点「说说现状」：光标回到框里", () => {
    press(render(), "说说现状");
    const tree = render();
    const focus = vi.fn();
    const ref = statement(tree)!.props!.ref as { current: unknown };
    ref.current = { focus };
    press(tree, "说说现状");
    expect(focus).toHaveBeenCalled();
  });

  it("从底部「说说现状」进来：框一打开光标就在里面", () => {
    expect(statement(render(true))?.props?.autoFocus).toBe(true);
  });
});
