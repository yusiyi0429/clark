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

import { MissionBlock, MonthTaskRow } from "./MonthPage";
import type { MonthTask } from "./useMonthPage";

type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Children.toArray(node).flatMap((child) => isValidElement(child)
  ? [child as Element, ...nodes((child.props as { children?: ReactNode }).children)] : []);
const textOf = (node: ReactNode): string => Children.toArray(node).map((child) => isValidElement(child)
  ? textOf((child.props as { children?: ReactNode }).children) : String(child ?? "")).join("");

const task: MonthTask = { taskId: "t1", missionId: "m1", missionTitle: "天枢 11 月", missionOutcome: null, name: "甲",
  criteria: [{ text: "有题库打分结果", met: true, changed: false, original: null }, { text: "有新人上手录屏", met: false, changed: false, original: null },
    { text: "过 75 分", met: false, changed: false, original: null }], edited: null, added: false,
  dueDate: "2026-11-18", missionDueDate: "2026-11-18", disposition: "current", deferredTo: null, version: null, running: 0, blocked: 0, done: false, settlement: null, continuedFrom: null };
const go = vi.fn();
const row = () => { hooks.position = 0; return MonthTaskRow({ task, period: "2026-11", go }) as ReactNode; };
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

describe("本月页就地改名字和完成标准", () => {
  const edited: MonthTask = { ...task, name: "甲（V2）",
    criteria: [{ text: "有题库打分结果", met: true, changed: false, original: null }, { text: "有三个新人上手录屏", met: false, changed: true, original: "有新人上手录屏" },
      { text: "过 80 分", met: false, changed: true, original: null }],
    edited: { name: "甲", criteria: ["有题库打分结果", "有新人上手录屏", "过 75 分"] } };
  const actions = () => ({ setDueDate: vi.fn(async () => {}), setDisposition: vi.fn(async () => {}), setGoal: vi.fn(async () => {}), addTask: vi.fn(async () => {}) });
  const open = (item: MonthTask, acts: ReturnType<typeof actions>) => {
    hooks.position = 0;
    hooks.values = [];
    const first = MonthTaskRow({ task: item, period: "2026-11", go, actions: acts }) as ReactNode;
    (toggle(first).props.onClick as () => void)();
    hooks.position = 0;
    return MonthTaskRow({ task: item, period: "2026-11", go, actions: acts }) as ReactNode;
  };
  /** 就地改的字（InlineText、「+ 加一条」）：按读屏名字找。 */
  const field = (tree: ReactNode, label: string) => nodes(tree).find((node) => node.props.label === label)!;

  it("改过的行上淡色「未进本体」；展开里改过的标准一种底色、下面淡色「原 〈原文〉」；「恢复」把原文存回去", async () => {
    const acts = actions();
    // 收着时行上写「未进本体」；展开后行上只留「原 MM/DD」「延续自」，「未进本体 · 恢复」在展开里那一行。
    hooks.position = 0;
    hooks.values = [];
    const closed = MonthTaskRow({ task: edited, period: "2026-11", go, actions: acts }) as ReactNode;
    expect(textOf(nodes(closed).find((node) => node.props["data-testid"] === "month-task-line")!.props.children as ReactNode)).toContain("未进本体");
    const tree = open(edited, acts);
    expect(textOf(nodes(tree).find((node) => node.props["data-testid"] === "month-task-line")!.props.children as ReactNode)).not.toContain("未进本体");
    expect(textOf(nodes(tree).find((node) => node.props["data-testid"] === "month-detail")!.props.children as ReactNode)).toContain("未进本体 · 恢复");
    const lines = criteria(tree);
    expect(lines.map((line) => line.props["data-changed"] !== undefined)).toEqual([false, true, true]);
    expect(lines.map((line) => textOf(line.props.children as ReactNode))).toEqual(["", "原 有新人上手录屏", ""]);
    const restore = nodes(tree).find((node) => node.type === "button" && textOf(node.props.children as ReactNode) === "恢复")!;
    (restore.props.onClick as () => void)();
    expect(acts.setGoal).toHaveBeenCalledWith("t1", { name: "甲", criteria: ["有题库打分结果", "有新人上手录屏", "过 75 分"] });
    // 没改过的不出「未进本体」「恢复」。
    const plain = open(task, actions());
    expect(textOf(plain as ReactNode)).not.toContain("未进本体");
    expect(nodes(plain).some((node) => textOf(node.props.children as ReactNode) === "恢复")).toBe(false);
  });

  it("就地改：改一条存整份标准，清空一条再存就是删，「+ 加一条」加在最后，改名字只存名字", async () => {
    const acts = actions();
    const tree = open(task, acts);
    const save = (label: string, text: string) => (field(tree, label).props.onSave as (text: string) => Promise<void>)(text);
    await save("第 2 条完成标准", "有三个新人上手录屏");
    expect(acts.setGoal).toHaveBeenLastCalledWith("t1", { criteria: ["有题库打分结果", "有三个新人上手录屏", "过 75 分"] });
    await save("第 3 条完成标准", "  ");
    expect(acts.setGoal).toHaveBeenLastCalledWith("t1", { criteria: ["有题库打分结果", "有新人上手录屏"] });
    await save("加一条完成标准", "过 80 分");
    expect(acts.setGoal).toHaveBeenLastCalledWith("t1", { criteria: ["有题库打分结果", "有新人上手录屏", "过 75 分", "过 80 分"] });
    expect(field(tree, "加一条完成标准").props.placeholder).toBe("完成标准");
    await save("Task 名", "甲（V2）");
    expect(acts.setGoal).toHaveBeenLastCalledWith("t1", { name: "甲（V2）" });
    // 名字清空不存（服务端也不收空名字）。
    acts.setGoal.mockClear();
    await save("Task 名", " ");
    expect(acts.setGoal).not.toHaveBeenCalled();
  });
});

describe("本月页添一件", () => {
  const actions = () => ({ setDueDate: vi.fn(async () => {}), setDisposition: vi.fn(async () => {}), setGoal: vi.fn(async () => {}), addTask: vi.fn(async () => {}) });

  it("当月的 Mission 标题点了进 Mission 详情（只读）", () => {
    hooks.position = 0;
    const tree = MissionBlock({ tasks: [task], period: "2026-11", go, extraOf: () => undefined, today: "2026-11-19", linkMission: true }) as ReactNode;
    const title = nodes(tree).find((node) => node.type === "button" && textOf(node.props.children as ReactNode) === "天枢 11 月")!;
    (title.props.onClick as () => void)();
    expect(go).toHaveBeenCalledWith("/me/work/missions/m1");
    // 别的月份（没有首页数据，Mission 详情找不到它）只写字。
    hooks.position = 0;
    const other = MissionBlock({ tasks: [task], period: "2026-11", go, extraOf: () => undefined, today: "2026-11-19" }) as ReactNode;
    expect(nodes(other).some((node) => node.type === "button" && textOf(node.props.children as ReactNode) === "天枢 11 月")).toBe(false);
  });

  it("Mission 末尾「+ 添一件」写个名字回车就加在这个 Mission 下", async () => {
    const acts = actions();
    hooks.position = 0;
    const tree = MissionBlock({ tasks: [task], period: "2026-11", go, extraOf: () => undefined, today: "2026-11-19", actions: acts }) as ReactNode;
    const add = nodes(tree).find((node) => node.props.label === "添一件")!;
    expect(add.props.placeholder).toBe("Task 名");
    expect(add.props.text).toBe("添一件");
    await (add.props.onSave as (text: string) => Promise<void>)("  新人上手手册 ");
    expect(acts.addTask).toHaveBeenCalledWith("m1", "新人上手手册");
  });

  it("天枢里新加的行上淡色「未进本体」，展开里不出「恢复」", () => {
    const acts = actions();
    const added: MonthTask = { ...task, taskId: "ts-1", name: "新人上手手册", criteria: [], added: true };
    hooks.position = 0;
    hooks.values = [];
    const closed = MonthTaskRow({ task: added, period: "2026-11", go, actions: acts }) as ReactNode;
    expect(textOf(nodes(closed).find((node) => node.props["data-testid"] === "month-task-line")!.props.children as ReactNode)).toContain("未进本体");
    (toggle(closed).props.onClick as () => void)();
    hooks.position = 0;
    const open = MonthTaskRow({ task: added, period: "2026-11", go, actions: acts }) as ReactNode;
    expect(textOf(nodes(open).find((node) => node.props["data-testid"] === "month-detail")!.props.children as ReactNode)).toContain("未进本体");
    expect(nodes(open).some((node) => node.type === "button" && textOf(node.props.children as ReactNode) === "恢复")).toBe(false);
  });
});
