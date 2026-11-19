import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";

// 不起浏览器：把 react 的 useState 换成可重放的假实现，直接调组件函数拿到元素树，再调元素上的处理器。
const hooks = vi.hoisted(() => ({
  position: 0, values: [] as unknown[],
  useState(initial: unknown) {
    const key = hooks.position++;
    if (!(key in hooks.values)) hooks.values[key] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[key], (next: unknown) => { hooks.values[key] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[key]) : next; }];
  },
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useState: hooks.useState }));

import { MonthTaskRow } from "./MonthPage";
import type { MonthTask } from "./useMonthPage";

type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Children.toArray(node).flatMap((child) => isValidElement(child)
  ? [child as Element, ...nodes((child.props as { children?: ReactNode }).children)] : []);
const textOf = (node: ReactNode): string => Children.toArray(node).map((child) => isValidElement(child)
  ? textOf((child.props as { children?: ReactNode }).children) : String(child ?? "")).join("");

const task: MonthTask = { taskId: "t1", missionId: "m1", missionTitle: "天枢 11 月", missionOutcome: null, name: "甲",
  criteria: [{ text: "有题库打分结果", met: true }, { text: "有新人上手录屏", met: false }, { text: "过 75 分", met: false }],
  dueDate: "2026-11-18", disposition: "current", deferredTo: null, version: null, running: 0, blocked: 0, done: false, settlement: null, continuedFrom: null };
const go = vi.fn();
const row = () => { hooks.position = 0; return MonthTaskRow({ task, go }) as ReactNode; };
const toggle = (tree: ReactNode) => nodes(tree).find((node) => "aria-expanded" in node.props)!;
const criteria = (tree: ReactNode) => nodes(tree).filter((node) => node.props["data-testid"] === "month-criterion");

beforeEach(() => { hooks.position = 0; hooks.values = []; go.mockClear(); });

describe("本月页一行", () => {
  it("点一行展开看完成标准，达到的打勾；再点收起", () => {
    let tree = row();
    expect(toggle(tree).props["aria-expanded"]).toBe(false);
    expect(criteria(tree)).toHaveLength(0);

    (toggle(tree).props.onClick as () => void)();
    tree = row();
    expect(toggle(tree).props["aria-expanded"]).toBe(true);
    const lines = criteria(tree);
    expect(lines.map((line) => textOf(line.props.children as ReactNode))).toEqual(["有题库打分结果", "有新人上手录屏", "过 75 分"]);
    const ticked = lines.map((line) => nodes(line.props.children as ReactNode).some((node) => node.props["aria-label"] === "达到"));
    expect(ticked).toEqual([true, false, false]);
    // 展开里下面一行：验收时间点、去向；没挂项目、没有首页数据时给一个进详情的入口（原来点行去的地方）。
    const detail = textOf(nodes(tree).find((node) => node.props["data-testid"] === "month-detail")!.props.children as ReactNode);
    expect(detail).toContain("验收 11/18");
    expect(detail).toContain("本期验收");
    const info = nodes(tree).find((node) => node.type === "button" && textOf(node.props.children as ReactNode) === "详情")!;
    (info.props.onClick as () => void)();
    expect(go).toHaveBeenCalledWith("/me/work/tasks/t1");

    (toggle(tree).props.onClick as () => void)();
    tree = row();
    expect(toggle(tree).props["aria-expanded"]).toBe(false);
    expect(criteria(tree)).toHaveLength(0);
  });
});
