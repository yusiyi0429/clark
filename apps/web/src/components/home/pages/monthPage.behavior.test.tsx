import { beforeEach, describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ReactElement, type ReactNode } from "react";

// 不起浏览器：把 react 的 useState 换成可重放的假实现，直接调组件函数拿到元素树，再调元素上的处理器。
// useEffect 当场跑，useRef 给一个能记「滚到可见」的假元素。
const hooks = vi.hoisted(() => ({
  position: 0, values: [] as unknown[], scrolled: [] as unknown[],
  useRef() { return { current: { scrollIntoView: (options: unknown) => { hooks.scrolled.push(options); } } }; },
  useEffect(run: () => void) { run(); },
  useState(initial: unknown) {
    const key = hooks.position++;
    if (!(key in hooks.values)) hooks.values[key] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[key], (next: unknown) => { hooks.values[key] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[key]) : next; }];
  },
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()), useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect }));

import { MissionBlock, MonthTaskRow } from "./MonthPage";
import type { MonthTask } from "./useMonthPage";

type Element = ReactElement<Record<string, unknown>>;
const nodes = (node: ReactNode): Element[] => Children.toArray(node).flatMap((child) => isValidElement(child)
  ? [child as Element, ...nodes((child.props as { children?: ReactNode }).children)] : []);
const textOf = (node: ReactNode): string => Children.toArray(node).map((child) => isValidElement(child)
  ? textOf((child.props as { children?: ReactNode }).children) : String(child ?? "")).join("");

const task: MonthTask = { taskId: "t1", missionId: "m1", missionTitle: "天枢 11 月", missionOutcome: null, name: "甲",
  criteria: [{ text: "有题库打分结果", met: true, changed: false, original: null, removed: false }, { text: "有新人上手录屏", met: false, changed: false, original: null, removed: false },
    { text: "过 75 分", met: false, changed: false, original: null, removed: false }], edited: null, added: false,
  dueDate: "2026-11-18", missionDueDate: "2026-11-18", disposition: "current", deferredTo: null, version: null, running: 0, blocked: 0, done: false, settlement: null, continuedFrom: null };
const go = vi.fn();
const row = () => { hooks.position = 0; return MonthTaskRow({ task, period: "2026-11", go }) as ReactNode; };
const toggle = (tree: ReactNode) => nodes(tree).find((node) => "aria-expanded" in node.props)!;
const criteria = (tree: ReactNode) => nodes(tree).filter((node) => node.props["data-testid"] === "month-criterion");

beforeEach(() => { hooks.position = 0; hooks.values = []; hooks.scrolled = []; go.mockClear(); });
/** 点一下（带一个点在别处的事件：不在名字、输入框、按钮上）。 */
const click = (node: Element, target: { closest: (selector: string) => unknown } = { closest: () => null }) =>
  (node.props.onClick as (event: unknown) => void)({ target, stopPropagation: () => {} });

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
    criteria: [{ text: "有题库打分结果", met: true, changed: false, original: null, removed: false }, { text: "有三个新人上手录屏", met: false, changed: true, original: "有新人上手录屏", removed: false },
      { text: "过 80 分", met: false, changed: true, original: null, removed: false }],
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
    // 名字平时是字，点了字才变输入框。
    expect(nodes(tree).some((node) => node.props.label === "Task 名")).toBe(false);
    click(nodes(tree).find((node) => node.props["data-testid"] === "month-name")!);
    hooks.position = 0;
    const naming = MonthTaskRow({ task, period: "2026-11", go, actions: acts }) as ReactNode;
    const name = (text: string) => (field(naming, "Task 名").props.onSave as (text: string) => Promise<void>)(text);
    expect(field(naming, "Task 名").props.autoFocus).toBe(true);
    await name("甲（V2）");
    expect(acts.setGoal).toHaveBeenLastCalledWith("t1", { name: "甲（V2）" });
    // 名字清空不存（服务端也不收空名字）。
    acts.setGoal.mockClear();
    await name(" ");
    expect(acts.setGoal).not.toHaveBeenCalled();
  });

  it("展开后点这一行名字以外的地方收起，点名字的字才进改名；收起时也是点一下就展开", () => {
    const acts = actions();
    const tree = open(task, acts);
    const line = nodes(tree).find((node) => node.props["data-testid"] === "month-task-line")!;
    click(line);
    hooks.position = 0;
    const closed = MonthTaskRow({ task, period: "2026-11", go, actions: acts }) as ReactNode;
    expect(toggle(closed).props["aria-expanded"]).toBe(false);
    expect(criteria(closed)).toHaveLength(0);
    // 点在输入框、按钮上（改名、收起按钮）不算点这一行。
    const again = open(task, acts);
    click(nodes(again).find((node) => node.props["data-testid"] === "month-task-line")!, { closest: () => ({}) });
    hooks.position = 0;
    expect(criteria(MonthTaskRow({ task, period: "2026-11", go, actions: acts }) as ReactNode)).toHaveLength(3);
  });

  it("改过名字：展开时名字下面淡色「原 〈原名〉」，收着时名字也是那一种底色", () => {
    const acts = actions();
    hooks.position = 0;
    hooks.values = [];
    const closed = MonthTaskRow({ task: edited, period: "2026-11", go, actions: acts }) as ReactNode;
    expect(nodes(closed).find((node) => node.props["data-testid"] === "month-name")!.props["data-changed"]).toBe("");
    expect(textOf(closed)).not.toContain("原 甲");
    const tree = open(edited, acts);
    expect(nodes(tree).find((node) => node.props["data-testid"] === "month-name")!.props["data-changed"]).toBe("");
    expect(textOf(nodes(tree).find((node) => node.props["data-testid"] === "month-task-line")!.props.children as ReactNode)).toContain("原 甲");
    // 没改名字的不写。
    expect(textOf(open({ ...edited, name: "甲", edited: { name: null, criteria: edited.edited!.criteria } }, acts))).not.toContain("原 甲");
  });

  it("删掉的本体标准在原位置画一行删除线，点「恢复」放回原位置；改别的条时不带它", async () => {
    const acts = actions();
    const removed: MonthTask = { ...task, criteria: [{ text: "有题库打分结果", met: true, changed: false, original: null, removed: false },
      { text: "有新人上手录屏", met: false, changed: false, original: null, removed: true }, { text: "过 75 分", met: false, changed: false, original: null, removed: false }],
    edited: { name: null, criteria: ["有题库打分结果", "有新人上手录屏", "过 75 分"] } };
    const tree = open(removed, acts);
    expect(criteria(tree)).toHaveLength(2);
    const gone = nodes(tree).filter((node) => node.props["data-testid"] === "month-criterion-removed");
    expect(gone.map((line) => textOf(line.props.children as ReactNode))).toEqual(["有新人上手录屏恢复"]);
    // 改第 2 条（删掉的那条不算）：存的标准里没有删掉的那条。
    await (field(tree, "第 2 条完成标准").props.onSave as (text: string) => Promise<void>)("过 80 分");
    expect(acts.setGoal).toHaveBeenLastCalledWith("t1", { criteria: ["有题库打分结果", "过 80 分"] });
    click(nodes(gone[0]!.props.children as ReactNode).find((node) => node.type === "button")!);
    expect(acts.setGoal).toHaveBeenLastCalledWith("t1", { criteria: ["有题库打分结果", "有新人上手录屏", "过 75 分"] });
  });

  it("只剩一条标准时不能删：清空了不存，换回原来的", () => {
    const acts = actions();
    const one: MonthTask = { ...task, criteria: [{ text: "有题库打分结果", met: false, changed: false, original: null, removed: false },
      { text: "有新人上手录屏", met: false, changed: false, original: null, removed: true }] };
    expect(field(open(one, acts), "第 1 条完成标准").props.required).toBe(true);
    expect(field(open(task, acts), "第 1 条完成标准").props.required).toBe(false);
  });

  it("展开着的行改了验收时间点：滚到可见（挪到新段时还是展开的，见 MissionBlock 那条）", () => {
    open(task, actions());
    expect(hooks.scrolled).toContainEqual({ block: "nearest" });
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

  it("一行改了验收时间点挪到别的段，还是同一个父元素下的同一个 key：展开着的照样展开", () => {
    hooks.position = 0;
    const block = MissionBlock({ tasks: [task, { ...task, taskId: "t2", dueDate: "2026-11-30" }], period: "2026-11", go, extraOf: () => undefined, today: "2026-11-19" }) as Element;
    const children = Children.toArray(block.props.children as ReactNode).filter(isValidElement) as Element[];
    expect(children.filter((node) => node.type === MonthTaskRow).map((node) => (node.props.task as MonthTask).taskId)).toEqual(["t1", "t2"]);
    expect(children.filter((node) => node.props["data-testid"] === "month-segment")).toHaveLength(2);
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
