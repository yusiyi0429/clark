import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { THomePlanActivity, THomePlanResponse, TTaskView } from "@warmap/contracts";

/**
 * 成员首页的 Mission 卡片与 useHomePlan。
 * 没有 jsdom（仓库惯例）：React 的 useState/useRef/useCallback/useEffect 换成按调用顺序记账的版本，renderToStaticMarkup 反复渲染到不再变；
 * 原生元素的 props 从 JSX 运行时截下来，按真实顺序直接调它们的处理器。时间轴换成桩，只收它拿到的 props。
 * ts-design 的 Popover 换成按 isOpen 渲染内容的桩（Esc、点外面关由它负责，这里直接调 onOpenChange(false)）；
 * Button 渲染成原生按钮，在 Popover 里又没有 onPress 时按一下就开合（同 DialogTrigger）。
 */
type Props = Record<string, unknown>;
const h = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], callbacks: [] as { callback: unknown; deps: readonly unknown[] }[],
  effects: [] as { deps?: readonly unknown[]; cleanup?: unknown }[],
  stateIndex: 0, refIndex: 0, callbackIndex: 0, effectIndex: 0, queued: [] as (() => void)[], dirty: false,
  elements: [] as { type: string; props: Record<string, unknown> }[],
  timeline: null as Record<string, unknown> | null,
  popovers: [] as { open: boolean; change: (open: boolean) => void }[],
  api: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = h.stateIndex++;
      if (!(index in h.states)) h.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [h.states[index], (update: unknown) => {
        const next = typeof update === "function" ? (update as (value: unknown) => unknown)(h.states[index]) : update;
        if (!Object.is(next, h.states[index])) h.dirty = true;
        h.states[index] = next;
      }];
    },
    useRef: (initial: unknown) => h.refs[h.refIndex++] ??= { current: initial },
    useCallback: (callback: unknown, deps: readonly unknown[]) => {
      const index = h.callbackIndex++, previous = h.callbacks[index];
      if (!previous || deps.some((value, offset) => !Object.is(value, previous.deps[offset]))) h.callbacks[index] = { callback, deps };
      return h.callbacks[index].callback;
    },
    useEffect: (effect: () => unknown, deps?: readonly unknown[]) => {
      const index = h.effectIndex++, previous = h.effects[index];
      if (previous && deps && deps.every((value, offset) => Object.is(value, previous.deps?.[offset]))) return;
      const slot: { deps?: readonly unknown[]; cleanup?: unknown } = { deps };
      h.effects[index] = slot;
      h.queued.push(() => {
        if (typeof previous?.cleanup === "function") (previous.cleanup as () => void)();
        slot.cleanup = effect();
      });
    },
  };
});
const { capture } = vi.hoisted(() => ({
  capture: <T,>(fn: T) => ((type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
    if (typeof type === "string") h.elements.push({ type, props });
    return (fn as unknown as (...args: unknown[]) => unknown)(type, props, ...rest);
  }) as unknown as T,
}));
vi.mock("react/jsx-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-runtime")>();
  return { ...actual, jsx: capture(actual.jsx), jsxs: capture(actual.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-dev-runtime")>();
  return { ...actual, jsxDEV: capture(actual.jsxDEV) };
});
vi.mock("ts-design", () => ({ TianshuPortalTheme: ({ children }: { children: ReactNode }) => <>{children}</> }));
vi.mock("ts-design/primitives", async () => {
  const { createContext, useContext } = await vi.importActual<typeof import("react")>("react");
  type Control = { open: boolean; change: (open: boolean) => void };
  const Open = createContext<Control>({ open: false, change: () => undefined });
  const Popover = Object.assign(({ children, isOpen, onOpenChange }: { children: ReactNode; isOpen?: boolean; onOpenChange?: (open: boolean) => void }) => {
    const control = { open: Boolean(isOpen), change: (open: boolean) => onOpenChange?.(open) };
    h.popovers.push(control);
    return <Open.Provider value={control}>{children}</Open.Provider>;
  }, {
    Content: ({ children }: { children: ReactNode }) => (useContext(Open).open ? <>{children}</> : null),
    Dialog: ({ children, className: _className, ...props }: { children: ReactNode; className?: string }) => <div role="dialog" {...props}>{children}</div>,
  });
  const Button = ({ children, onPress, isDisabled, variant: _variant, size: _size, isIconOnly: _icon, ...props }: {
    children: ReactNode; onPress?: (event: unknown) => void; isDisabled?: boolean; variant?: string; size?: string; isIconOnly?: boolean;
  }) => {
    const popover = useContext(Open);
    return <button type="button" disabled={isDisabled} {...props} onClick={(event) => (onPress ? onPress(event) : popover.change(!popover.open))}>{children}</button>;
  };
  return { Button, Popover };
});
vi.mock("./DayTimeline", () => ({ DayTimeline: (props: Record<string, unknown>) => { h.timeline = props; return null; } }));
vi.mock("@/components/tours/StartTaskButton", () => ({ StartTaskButton: () => null }));
vi.mock("@/lib/api/client", () => ({ browserApi: h.api }));

import { MissionPlanCard } from "./MissionPlanCard";
import { HOME_PLAN_CHANGED, useHomePlan } from "./useHomePlan";

const item = (id: string, title: string, extra: Partial<TTaskView> = {}): TTaskView => ({
  id, version: 1, title, status: "in_progress", source: "self", startDate: null, dueDate: null, doneDefinition: null,
  mission: null, waitingOn: null, owner: { personId: "sun", name: "孙铭泽" }, collaborators: [], latestProgress: null,
  returnReason: null, origin: null, awaitingAcceptance: false, planTaskId: null,
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...extra,
});
const confirmedRef = { missionId: "m1", title: "CEO / DRI Agent 从能用到在用", cardId: "card-1", period: "2026-10", battlefieldName: "天枢", step: 1, steps: 1 };
const renhao = [{ personId: "renhao", name: "人豪" }];

/** 2026 年 10 月，今天 10/22（周四）。a3 的任务卡还没确认（item.mission 为空），按 activity.missionId 仍归 m1。 */
const plan = (overrides: Partial<THomePlanResponse> = {}): THomePlanResponse => ({
  period: "2026-10",
  fallbackFrom: null,
  today: "2026-10-22",
  weekStart: "2026-10-19",
  weekEnd: "2026-10-25",
  days: Array.from({ length: 31 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, "0")}`, workday: true })),
  missions: [
    { missionId: "m1", code: "M1", title: "CEO / DRI Agent 从能用到在用", cardId: "card-1", color: "#2f63b0" },
    { missionId: "m2", code: "M2", title: "灯塔首次会面", cardId: null, color: "#2f8a7a" },
  ],
  gates: [
    { missionId: "m1", date: "2026-10-12", label: "需求冻结" },
    { missionId: "m1", date: "2026-10-30", label: "复盘" },
    { missionId: "m1", date: "2026-10-28", label: "上线" },
    { missionId: "m2", date: "2026-10-22", label: "首次会面" },
  ],
  marks: [{ id: "k1", missionId: "m1", date: "2026-10-23", label: "联调" }],
  tasks: [
    { taskId: "t1", missionId: "m1", name: "会议写进本体", doneDefinition: "会后自动出会议卡，整卡确认后写进本体。", criteria: ["真实工作会走完全链路，读回一致", "飞书里直接开的会也接得住"] },
    { taskId: "t2", missionId: "m1", name: "对话质量达标", doneDefinition: null, criteria: [] },
    { taskId: "t3", missionId: "m2", name: "Chat 客户版", doneDefinition: null, criteria: [] },
  ],
  activities: [
    { item: item("a1", "回流方案定稿", { status: "done", dueDate: "2026-10-21", planTaskId: "t1", mission: confirmedRef, collaborators: renhao }), missionId: "m1", column: "done", overdue: false },
    { item: item("a2", "对话架构与分工", { status: "done", dueDate: "2026-10-20", mission: confirmedRef }), missionId: "m1", column: "done", overdue: false },
    { item: item("a3", "真实会议跑通", { dueDate: "2026-10-24", planTaskId: "t1", collaborators: renhao }), missionId: "m1", column: "week", overdue: false },
    { item: item("a4", "Chat 服务抽出", { dueDate: "2026-10-16", planTaskId: "t2", mission: confirmedRef }), missionId: "m1", column: "week", overdue: true },
    { item: item("a5", "客户版演示", { planTaskId: "t3", collaborators: renhao }), missionId: "m2", column: "week", overdue: false },
    { item: item("a6", "新 Chat 题库打分", { status: "not_started", startDate: "2026-10-27", planTaskId: "t-gone", mission: confirmedRef }), missionId: "m1", column: "later", overdue: false },
    { item: item("a7", "报销", { dueDate: "2026-10-23" }), missionId: null, column: "week", overdue: false },
  ] satisfies THomePlanActivity[],
  ...overrides,
});

const event = () => ({ currentTarget: { id: "origin" }, target: { id: "origin" }, preventDefault: vi.fn(), stopPropagation: vi.fn() });

function mount(initial = plan()) {
  let current = initial;
  const onNavigate = vi.fn();
  h.states = []; h.refs = []; h.callbacks = []; h.effects = [];
  let html = "";
  const render = () => {
    for (let pass = 0; pass < 8; pass++) {
      h.stateIndex = 0; h.refIndex = 0; h.callbackIndex = 0; h.effectIndex = 0; h.dirty = false; h.queued = []; h.elements = []; h.popovers = [];
      html = renderToStaticMarkup(<MissionPlanCard plan={current} onNavigate={onNavigate} />);
      h.queued.forEach((run) => run());
      if (!h.dirty) return html;
    }
    throw new Error("卡片没有稳定下来");
  };
  render();
  const find = (predicate: (props: Props) => boolean) => h.elements.find((element) => predicate(element.props))?.props;
  const get = (predicate: (props: Props) => boolean, what: string) => {
    const props = find(predicate);
    if (!props) throw new Error(`找不到：${what}`);
    return props;
  };
  const call = (props: Props, handler: string, arg: unknown = event()) => { (props[handler] as (value: unknown) => unknown)(arg); return render(); };
  return {
    get html() { return html; },
    onNavigate, render, find,
    setPlan: (next: THomePlanResponse) => { current = next; return render(); },
    /** 开着的浮层数（Popover 的 isOpen）。 */
    openPopovers: () => h.popovers.filter((popover) => popover.open).length,
    /** Esc 或点外面：Popover 调 onOpenChange(false)。 */
    dismiss: () => { h.popovers.find((popover) => popover.open)!.change(false); return render(); },
    mission: (id: string) => call(get((props) => props["data-mission"] === id, `Mission ${id}`), "onClick"),
    task: (id: string) => call(get((props) => props["data-task"] === id, `Task ${id}`), "onClick"),
    info: () => call(get((props) => props["data-info"] !== undefined, "ⓘ"), "onClick"),
    activity: (id: string) => get((props) => props["data-activity"] === id, `卡片 ${id}`),
    click: (predicate: (props: Props) => boolean, what: string) => call(get(predicate, what), "onClick"),
    type: (value: string) => call(get((props) => props["data-mark-name"] !== undefined, "名字输入框"), "onChange", { target: { value } }),
    key: (key: string, isComposing = false) => call(get((props) => props["data-mark-name"] !== undefined, "名字输入框"), "onKeyDown", { key, nativeEvent: { isComposing }, preventDefault: vi.fn() }),
    timeline: (handler: "onAddMark" | "onMoveMark" | "onDeleteMark", ...args: string[]) => { (h.timeline![handler] as (...values: string[]) => void)(...args); return render(); },
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 一栏的整段（栏不嵌套）。 */
const column = (html: string, name: "done" | "week" | "later") => html.match(new RegExp(`<section[^>]*data-column="${name}"[^>]*>.*?</section>`))?.[0] ?? "";
const cardsIn = (html: string, name: "done" | "week" | "later") => [...column(html, name).matchAll(/data-activity="([^"]+)"/g)].map((match) => match[1]);
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
const ok = (data: unknown = undefined) => ({ data, response: { ok: true, status: 200 } });

beforeEach(() => {
  vi.resetAllMocks();
  h.timeline = null;
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe("MissionPlanCard：Mission 行", () => {
  it("默认「全部」：三栏的卡片数等于 activities 按 column 分组的数目；栏名照写", () => {
    const view = mount();
    expect(view.find((props) => props["data-mission"] === "all")!["aria-pressed"]).toBe(true);
    expect(cardsIn(view.html, "done")).toHaveLength(2);
    expect(cardsIn(view.html, "week")).toHaveLength(4);
    expect(cardsIn(view.html, "later")).toHaveLength(1);
    expect(text(view.html)).toContain("已完成 · 2");
    expect(text(view.html)).toContain("本周 10/19–10/25");
    expect(text(column(view.html, "later"))).toContain("之后");
    expect(view.html).not.toContain("Mission 卡 ›");
  });

  it("选 Mission m1：只剩 m1 的 Activity（按 activity.missionId，任务卡没确认的也在），出现「Mission 卡 ›」并进 Mission 卡页", () => {
    const view = mount();
    view.mission("m1");
    expect(cardsIn(view.html, "done").sort()).toEqual(["a1", "a2"]);
    expect(cardsIn(view.html, "week").sort()).toEqual(["a3", "a4"]);
    expect(cardsIn(view.html, "later")).toEqual(["a6"]);
    expect(h.timeline!.focus).toBe("m1");
    expect(view.html).toContain("Mission 卡 ›");
    view.click((props) => props["data-mission-card"] !== undefined, "Mission 卡 ›");
    expect(view.onNavigate).toHaveBeenCalledWith("/me/mission-cards/card-1", expect.anything());
  });

  it("聚焦的 Mission 没有 cardId：不出「Mission 卡 ›」；点回「全部」恢复所有 Activity", () => {
    const view = mount();
    view.mission("m2");
    expect(cardsIn(view.html, "week")).toEqual(["a5"]);
    expect(view.html).not.toContain("Mission 卡 ›");
    view.mission("all");
    expect(h.timeline!.focus).toBeNull();
    expect(cardsIn(view.html, "week")).toHaveLength(4);
  });

  it("每个 Mission 上面的小字：今天起最近的一个签定关口「M/D 名字」；没有就什么都不写", () => {
    const html = mount().html;
    expect(text(html)).toContain("10/28 上线");
    expect(text(html)).toContain("10/22 首次会面");
    expect(text(html)).not.toMatch(/需求冻结|10\/30 复盘/);
    const pastOnly = mount(plan({ gates: [{ missionId: "m1", date: "2026-10-12", label: "需求冻结" }] })).html;
    expect(text(pastOnly)).not.toContain("需求冻结");
  });

  it("回退显示上个月：「全部」上面写「9 月」，时间轴不画本周括线", () => {
    const html = mount(plan({ period: "2026-09", fallbackFrom: "2026-09", days: [{ date: "2026-09-30", workday: true }] })).html;
    expect(text(html)).toContain("9 月");
    expect(h.timeline!.showWeek).toBe(false);
    const current = mount().html;
    expect(text(current)).not.toMatch(/\d+ 月/);
    expect(h.timeline!.showWeek).toBe(true);
    expect(h.timeline!.weekStart).toBe("2026-10-19");
  });

  it("时间轴拿到 Mission 的颜色", () => {
    mount();
    const colorOf = h.timeline!.colorOf as (id: string) => string;
    expect(colorOf("m1")).toBe("#2f63b0");
    expect(colorOf("m2")).toBe("#2f8a7a");
  });
});

describe("MissionPlanCard：Task 行", () => {
  it("选 Task t1：只剩 planTaskId = t1 的；再点一次取消", () => {
    const view = mount();
    view.task("t1");
    expect(cardsIn(view.html, "done")).toEqual(["a1"]);
    expect(cardsIn(view.html, "week")).toEqual(["a3"]);
    expect(cardsIn(view.html, "later")).toEqual([]);
    expect(text(column(view.html, "later"))).toContain("—");
    view.task("t1");
    expect(cardsIn(view.html, "week")).toHaveLength(4);
  });

  it("「其他 N」：N = 没挂 Task 或挂的 Task 对不上的 Activity 数；选中只看它们", () => {
    const view = mount();
    expect(text(view.html)).toContain("其他 3");
    view.task("other");
    expect([...cardsIn(view.html, "done"), ...cardsIn(view.html, "week"), ...cardsIn(view.html, "later")].sort()).toEqual(["a2", "a6", "a7"]);
    view.mission("m1");
    expect(text(view.html)).toContain("其他 2");
  });

  it("「全部」视图下 Task 前有 Mission 色点；聚焦后只列这个 Mission 的 Task、不带色点", () => {
    const view = mount();
    expect(view.html).toMatch(/data-task="t3"[^>]*>(?:<[^>]+>)*?<[^>]*--c:#2f8a7a/);
    view.mission("m1");
    expect(view.html).not.toContain('data-task="t3"');
    expect(view.html).not.toMatch(/data-task="t1"[^>]*>(?:<[^>]+>)*?<[^>]*--c:/);
  });

  it("重取回来选中的 Task 不在了：当没选，三栏回到全部", () => {
    const view = mount();
    view.task("t1");
    view.setPlan(plan({ tasks: plan().tasks.filter((task) => task.taskId !== "t1") }));
    expect(cardsIn(view.html, "week")).toHaveLength(4);
    expect(view.html).not.toContain('aria-pressed="true" data-task');
    expect(view.find((props) => props["data-task"] === "t2")!["aria-pressed"]).toBe(false);
  });

  it("所有 Activity 都挂上了 Task：不出「其他」；选着「其他」时重取变成 0，就当没选", () => {
    const matched = plan({ activities: plan().activities.filter(({ item }) => ["t1", "t2", "t3"].includes(item.planTaskId ?? "")) });
    expect(mount(matched).html).not.toContain('data-task="other"');
    const view = mount();
    view.task("other");
    expect(cardsIn(view.html, "week")).toEqual(["a7"]);
    view.setPlan(matched);
    expect(view.html).not.toContain('data-task="other"');
    expect(cardsIn(view.html, "week").sort()).toEqual(["a3", "a4", "a5"]);
  });

  it("tasks 为空：没有 Task 行（连「其他」也没有），三栏照常", () => {
    const view = mount(plan({ tasks: [] }));
    expect(view.html).not.toContain("data-task-row");
    expect(text(view.html)).not.toContain("其他");
    expect(cardsIn(view.html, "week")).toHaveLength(4);
  });

  it("聚焦的 Mission 一个 Task 都没有：Task 行不渲染", () => {
    const view = mount(plan({ tasks: plan().tasks.filter((task) => task.missionId === "m1") }));
    expect(view.html).toContain("data-task-row");
    view.mission("m2");
    expect(view.html).not.toContain("data-task-row");
    expect(cardsIn(view.html, "week")).toEqual(["a5"]);
  });

  it("ⓘ 选中 Task 后才出现；浮层默认不渲染，点开后有「做到什么算完」和每一条验收标准", () => {
    const view = mount();
    expect(view.find((props) => props["data-info"] !== undefined)).toBeUndefined();
    view.task("t1");
    expect(view.html).not.toContain("会后自动出会议卡");
    expect(view.html).not.toContain("飞书里直接开的会也接得住");
    view.info();
    expect(text(view.html)).toContain("会后自动出会议卡，整卡确认后写进本体。");
    expect(text(view.html)).toContain("真实工作会走完全链路，读回一致");
    expect(text(view.html)).toContain("飞书里直接开的会也接得住");
    view.info();
    expect(view.html).not.toContain("飞书里直接开的会也接得住");
  });

  it("没有完成定义也没有验收标准的 Task，选中也不出 ⓘ", () => {
    const view = mount();
    view.task("t2");
    expect(view.find((props) => props["data-info"] !== undefined)).toBeUndefined();
  });

  it("ⓘ 浮层 Esc 或点外面（Popover 的 onOpenChange(false)）就关", () => {
    const view = mount();
    view.task("t1");
    view.info();
    expect(view.openPopovers()).toBe(1);
    expect(view.dismiss()).not.toContain('role="dialog"');
    expect(view.openPopovers()).toBe(0);
  });

  it("ⓘ 浮层开着时重取回来那个 Task 没有完成定义和验收标准了：浮层关掉，状态清掉，内容回来也不重开", () => {
    const view = mount();
    view.task("t1");
    view.info();
    view.setPlan(plan({ tasks: plan().tasks.map((task) => ({ ...task, doneDefinition: null, criteria: [] })) }));
    expect(view.html).not.toContain('role="dialog"');
    expect(view.openPopovers()).toBe(0);
    view.setPlan(plan());
    expect(view.html).not.toContain('role="dialog"');
    expect(view.openPopovers()).toBe(0);
  });
});

describe("MissionPlanCard：三栏的卡片", () => {
  it("一行小字：本周、之后写「主体 · 截止日」，有哪个写哪个；已完成只写日期；逾期的日期带 data-overdue", () => {
    const html = mount().html;
    const card = (id: string) => html.match(new RegExp(`<button[^>]*data-activity="${id}"[^>]*>.*?</button>`))?.[0] ?? "";
    const small = (id: string) => text(card(id).match(/<small[^>]*>.*<\/small>/)?.[0] ?? "").trim();
    expect(small("a3")).toBe("你＋人豪 · 10/24");
    expect(small("a5")).toBe("你＋人豪");
    expect(small("a7")).toBe("10/23");
    expect(small("a1")).toBe("10/21");
    expect(card("a6")).not.toContain("<small");
    expect(card("a4")).toMatch(/<span[^>]*data-overdue[^>]*>10\/16</);
    expect(card("a3")).not.toContain("data-overdue");
  });

  it("每栏按日期排，没日期的在后", () => {
    expect(cardsIn(mount().html, "week")).toEqual(["a4", "a7", "a3", "a5"]);
  });

  it("「全部」视图下卡片左边是 Mission 色条，独立事项没有；聚焦后不画色条", () => {
    const view = mount();
    expect(String((view.activity("a3").style as Record<string, string>)["--bar"])).toBe("#2f63b0");
    expect(String((view.activity("a5").style as Record<string, string>)["--bar"])).toBe("#2f8a7a");
    expect(view.activity("a7").style).toBeUndefined();
    view.mission("m1");
    expect(view.activity("a3").style).toBeUndefined();
  });

  it("点卡片进事项详情", () => {
    const view = mount();
    const origin = event();
    (view.activity("a3").onClick as (value: unknown) => void)(origin);
    expect(view.onNavigate).toHaveBeenCalledWith("/me/tasks/a3", origin.currentTarget);
  });

  it("页面里不出现 Mission 描述（outcome），Task 的完成定义收起", () => {
    const html = mount().html;
    expect(html).not.toMatch(/outcome/i);
    expect(html).not.toContain("会后自动出会议卡");
  });
});

describe("MissionPlanCard：计划点", () => {
  const radios = () => h.elements.filter((element) => element.props.role === "radio");

  it("「全部」视图下点某一格：浮层里有 Mission 色点可选，提交挂到选中的 Mission", async () => {
    h.api.POST.mockResolvedValue(ok({ id: "k9", missionId: "m2", date: "2026-10-24", label: "演示" }));
    const view = mount();
    view.timeline("onAddMark", "2026-10-24");
    expect(view.html).toContain('role="radiogroup"');
    expect(radios()).toHaveLength(2);
    view.click((props) => props["data-pick"] === "m2", "m2 色点");
    view.type("演示");
    view.key("Enter");
    expect(h.api.POST).toHaveBeenCalledWith("/api/me/plan-marks", { body: { missionId: "m2", date: "2026-10-24", label: "演示" } });
  });

  it("聚焦 m1 时点某一格：浮层里没有 Mission 选择，提交的 missionId 是 m1；先画上再等接口，存好后通知重取", async () => {
    h.api.POST.mockResolvedValue(ok({ id: "k9", missionId: "m1", date: "2026-10-24", label: "评审" }));
    const view = mount();
    view.mission("m1");
    view.timeline("onAddMark", "2026-10-24");
    expect(view.html).toContain('data-mark-pop="add"');
    expect(view.html).not.toContain('role="radiogroup"');
    view.type("评审");
    view.key("Enter");
    expect(h.api.POST).toHaveBeenCalledWith("/api/me/plan-marks", { body: { missionId: "m1", date: "2026-10-24", label: "评审" } });
    expect(view.html).not.toContain("data-mark-pop");
    expect((h.timeline!.marks as { label: string; date: string }[]).map((mark) => `${mark.date} ${mark.label}`)).toContain("2026-10-24 评审");
    await settle();
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: HOME_PLAN_CHANGED }));
  });

  it("中文输入法还在拼字时按 Enter 不提交；空名字不提交；名字最多 10 个字", () => {
    const view = mount();
    view.timeline("onAddMark", "2026-10-24");
    expect(view.find((props) => props["data-mark-name"] !== undefined)!.maxLength).toBe(10);
    view.key("Enter");
    view.type("评审");
    view.key("Enter", true);
    expect(h.api.POST).not.toHaveBeenCalled();
    expect(view.html).toContain('data-mark-pop="add"');
  });

  it("加点浮层 Esc 或点外面（Popover 的 onOpenChange(false)）就关，不提交", () => {
    const view = mount();
    view.timeline("onAddMark", "2026-10-24");
    view.type("评审");
    expect(view.openPopovers()).toBe(1);
    expect(view.dismiss()).not.toContain("data-mark-pop");
    expect(view.openPopovers()).toBe(0);
    expect(h.api.POST).not.toHaveBeenCalled();
  });

  it("右键或长按计划点：先出「删除」，点了才删；点之前时间轴上还在", async () => {
    h.api.DELETE.mockResolvedValue({ response: { ok: true, status: 204 } });
    const view = mount();
    view.timeline("onDeleteMark", "k1");
    expect(view.html).toContain('data-mark-pop="delete"');
    expect(h.api.DELETE).not.toHaveBeenCalled();
    expect((h.timeline!.marks as { id: string }[]).map((mark) => mark.id)).toEqual(["k1"]);
    view.click((props) => props["data-delete"] !== undefined, "删除");
    expect(h.api.DELETE).toHaveBeenCalledWith("/api/me/plan-marks/{id}", { params: { path: { id: "k1" } } });
    expect(h.timeline!.marks).toEqual([]);
    await settle();
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: HOME_PLAN_CHANGED }));
  });

  it("拖到别的日子：马上挪；接口失败退回原处并写一句错", async () => {
    h.api.PATCH.mockResolvedValue({ error: { message: "日期不在这个 Mission 的月份里" }, response: { ok: false, status: 400 } });
    const view = mount();
    view.timeline("onMoveMark", "k1", "2026-10-27");
    expect(h.api.PATCH).toHaveBeenCalledWith("/api/me/plan-marks/{id}", { params: { path: { id: "k1" } }, body: { date: "2026-10-27" } });
    expect((h.timeline!.marks as { date: string }[])[0].date).toBe("2026-10-27");
    await settle();
    const html = view.render();
    expect((h.timeline!.marks as { date: string }[])[0].date).toBe("2026-10-23");
    expect(html).toMatch(/role="alert"[^>]*>日期不在这个 Mission 的月份里</);
    expect(window.dispatchEvent).not.toHaveBeenCalled();
    expect(view.timeline("onAddMark", "2026-10-24")).not.toContain('role="alert"');
  });

  it("断网：退回并写「没存上」", async () => {
    h.api.DELETE.mockRejectedValue(new TypeError("Failed to fetch"));
    const view = mount();
    view.timeline("onDeleteMark", "k1");
    view.click((props) => props["data-delete"] !== undefined, "删除");
    await settle();
    const html = view.render();
    expect((h.timeline!.marks as { id: string }[]).map((mark) => mark.id)).toEqual(["k1"]);
    expect(text(html)).toContain("没存上");
  });

  it("重取回来的新计划替掉本地先画上的", async () => {
    h.api.POST.mockResolvedValue(ok({ id: "k9", missionId: "m1", date: "2026-10-24", label: "评审" }));
    const view = mount();
    view.mission("m1");
    view.timeline("onAddMark", "2026-10-24");
    view.type("评审");
    view.key("Enter");
    await settle();
    const fresh = plan({ marks: [...plan().marks, { id: "k9", missionId: "m1", date: "2026-10-24", label: "评审" }] });
    view.setPlan(fresh);
    expect(h.timeline!.marks).toBe(fresh.marks);
  });

  const deferred = () => {
    let resolve!: (value: unknown) => void;
    return { promise: new Promise((done) => { resolve = done; }), resolve };
  };
  const markIds = () => (h.timeline!.marks as { id: string }[]).map((mark) => mark.id);
  const markDates = () => Object.fromEntries((h.timeline!.marks as { id: string; date: string }[]).map((mark) => [mark.id, mark.date]));

  it("删除还在路上时轮询回来的旧计划不会把点画回来；存好、重取看不到它之后这条才撤掉", async () => {
    const sent = deferred();
    h.api.DELETE.mockReturnValue(sent.promise);
    const view = mount();
    view.timeline("onDeleteMark", "k1");
    view.click((props) => props["data-delete"] !== undefined, "删除");
    expect(markIds()).toEqual([]);
    view.setPlan(plan());
    expect(markIds()).toEqual([]);
    sent.resolve({ response: { ok: true, status: 204 } });
    await settle();
    view.render();
    view.setPlan(plan());
    expect(markIds()).toEqual([]);
    view.setPlan(plan({ marks: [] }));
    expect(markIds()).toEqual([]);
    // 已经撤掉：之后服务端再有 k1，照服务端画。
    view.setPlan(plan());
    expect(markIds()).toEqual(["k1"]);
  });

  it("一条失败只撤它自己：另一条还在路上的照样画着", async () => {
    const moving = deferred();
    h.api.PATCH.mockReturnValue(moving.promise);
    h.api.POST.mockResolvedValue({ error: { message: "一个 Mission 下最多 20 个计划点" }, response: { ok: false, status: 409 } });
    const view = mount();
    view.timeline("onMoveMark", "k1", "2026-10-27");
    view.mission("m1");
    view.timeline("onAddMark", "2026-10-24");
    view.type("评审");
    view.key("Enter");
    expect(markDates()).toEqual({ k1: "2026-10-27", [markIds()[1]]: "2026-10-24" });
    await settle();
    const html = view.render();
    expect(markDates()).toEqual({ k1: "2026-10-27" });
    expect(html).toContain("一个 Mission 下最多 20 个计划点");
    view.setPlan(plan());
    expect(markDates()).toEqual({ k1: "2026-10-27" });
    moving.resolve(ok({ id: "k1", missionId: "m1", date: "2026-10-27", label: "联调" }));
    await settle();
    view.render();
    expect(markDates()).toEqual({ k1: "2026-10-27" });
  });

  it("新加的点在 POST 回来之前不能拖、不能删；回来后换成真 id，可以删", async () => {
    const posting = deferred();
    h.api.POST.mockReturnValue(posting.promise);
    const view = mount();
    view.mission("m1");
    view.timeline("onAddMark", "2026-10-24");
    view.type("评审");
    view.key("Enter");
    const temp = markIds()[1];
    expect(temp).toMatch(/^pending-/);
    view.timeline("onMoveMark", temp, "2026-10-27");
    view.timeline("onDeleteMark", temp);
    expect(h.api.PATCH).not.toHaveBeenCalled();
    expect(view.html).not.toContain("data-mark-pop");
    posting.resolve(ok({ id: "k9", missionId: "m1", date: "2026-10-24", label: "评审" }));
    await settle();
    view.render();
    expect(markIds()).toEqual(["k1", "k9"]);
    view.timeline("onDeleteMark", "k9");
    expect(view.html).toContain('data-mark-pop="delete"');
  });

  it("删点浮层对着的点重取后不在了：浮层关掉、状态清掉，点再回来也不重开", () => {
    const view = mount();
    view.timeline("onDeleteMark", "k1");
    expect(view.openPopovers()).toBe(1);
    view.setPlan(plan({ marks: [] }));
    expect(view.html).not.toContain("data-mark-pop");
    expect(view.openPopovers()).toBe(0);
    view.setPlan(plan());
    expect(view.html).not.toContain("data-mark-pop");
    expect(view.openPopovers()).toBe(0);
  });
});

describe("Mission 卡片样式", () => {
  const css = readFileSync(new URL("../../../styles/mission-plan-card.module.css", import.meta.url), "utf8");
  it("本周那栏最宽、打浅蓝底", () => {
    expect(css).toMatch(/grid-template-columns: minmax\(0, 1fr\) minmax\(0, 1\.35fr\) minmax\(0, 1fr\);/);
    expect(css).toMatch(/\.column\[data-column="week"\] \{[^}]*background: rgba\(33, 91, 161, \.07\);/);
  });
  it("卡片窄于 560px：三栏上下排，本周、之后、已完成", () => {
    expect(css).toContain("container: plan-card / inline-size;");
    const narrow = css.match(/@container plan-card \(max-width: 559px\) \{([\s\S]*?)\n\}/)?.[1] ?? "";
    expect(narrow).toContain(".columns { grid-template-columns: minmax(0, 1fr); }");
    expect(narrow).toContain('.column[data-column="week"] { order: -1; }');
    expect(narrow).toContain('.column[data-column="done"] { order: 1; }');
  });
});

describe("useHomePlan：读首页计划", () => {
  /** 直接调 hook：按同一套记账的 useState/useRef/useCallback/useEffect。 */
  const run = () => {
    h.stateIndex = 0; h.refIndex = 0; h.callbackIndex = 0; h.effectIndex = 0; h.queued = [];
    const value = useHomePlan();
    const queued = h.queued;
    return { value, effects: () => queued.forEach((effect) => effect()) };
  };
  const reply = (marks: number) => ({ data: plan({ marks: plan().marks.slice(0, marks) }), response: { ok: true, status: 200 } });

  it("挂上就读一次；页面在前台时每 20 秒读；计划点存好后（HOME_PLAN_CHANGED）马上再读", async () => {
    h.states = []; h.refs = []; h.callbacks = []; h.effects = [];
    const events = new EventTarget();
    let poll: (() => void) | undefined;
    vi.stubGlobal("window", {
      addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events),
      setInterval: (callback: () => void, ms: number) => { if (ms === 20_000) poll = callback; return 1; }, clearInterval: vi.fn(),
      location: { assign: vi.fn() },
    });
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
    h.api.GET.mockResolvedValue(reply(1));
    run().effects();
    await vi.waitFor(() => expect(run().value.plan?.marks).toHaveLength(1));
    expect(h.api.GET).toHaveBeenCalledWith("/api/me/home-plan");
    h.api.GET.mockResolvedValue(reply(0));
    events.dispatchEvent(new Event(HOME_PLAN_CHANGED));
    await vi.waitFor(() => expect(run().value.plan?.marks).toHaveLength(0));
    poll!();
    expect(h.api.GET).toHaveBeenCalledTimes(3);
  });

  it("读失败保留上次的计划，给出错误；未登录去登录页", async () => {
    h.states = []; h.refs = []; h.callbacks = []; h.effects = [];
    const assign = vi.fn();
    vi.stubGlobal("window", { location: { assign } });
    h.api.GET.mockResolvedValue(reply(1));
    await (run().value.refresh());
    h.api.GET.mockRejectedValue(new TypeError("Failed to fetch"));
    await (run().value.refresh());
    expect(run().value.plan?.marks).toHaveLength(1);
    expect(run().value.error).toBeTruthy();
    h.api.GET.mockResolvedValue({ response: { ok: false, status: 401 } });
    await (run().value.refresh());
    expect(assign).toHaveBeenCalledWith("/access?next=%2Fme");
  });
});
