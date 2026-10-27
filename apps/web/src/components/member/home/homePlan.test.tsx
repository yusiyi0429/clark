import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import type { ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { THomePlanActivity, THomePlanResponse, TTaskView } from "@warmap/contracts";

/**
 * 成员首页主区（HomePlan：月历、Mission、快捷、Mission 详情）与 useHomePlan。
 * 没有 jsdom（仓库惯例）：React 的 useState/useRef/useCallback/useEffect 换成按调用顺序记账的版本，renderToStaticMarkup 反复渲染到不再变；
 * 原生元素的 props 从 JSX 运行时截下来，按真实顺序直接调它们的处理器。月历换成桩，只收它拿到的 props。
 * ts-design 的 Popover 换成按 isOpen 渲染内容的桩（Esc、点外面关由它负责，这里直接调 onOpenChange(false)）；
 * Button 渲染成原生按钮，在 Popover 里又没有 onPress 时按一下就开合（同 DialogTrigger）。
 */
type Props = Record<string, unknown>;
const h = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[], callbacks: [] as { callback: unknown; deps: readonly unknown[] }[],
  effects: [] as { deps?: readonly unknown[]; cleanup?: unknown }[],
  stateIndex: 0, refIndex: 0, callbackIndex: 0, effectIndex: 0, queued: [] as (() => void)[], dirty: false,
  elements: [] as { type: string; props: Record<string, unknown> }[],
  calendar: null as Record<string, unknown> | null,
  popovers: [] as { open: boolean; change: (open: boolean) => void }[],
  api: { GET: vi.fn(), POST: vi.fn(), PATCH: vi.fn(), DELETE: vi.fn() },
  accept: null as Record<string, unknown> | null,
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
vi.mock("./MonthCalendar", () => ({ MonthCalendar: (props: Record<string, unknown>) => { h.calendar = props; return null; } }));
vi.mock("@/components/tours/StartTaskButton", () => ({ StartTaskButton: () => null }));
vi.mock("@/components/tasks/AcceptDialog", () => ({ AcceptDialog: (props: Record<string, unknown>) => { h.accept = props; return <div data-accept-dialog="true" />; } }));
vi.mock("@/lib/api/client", () => ({ browserApi: h.api }));

import { HomePlan } from "./HomePlan";
import { HOME_PLAN_CHANGED, useHomePlan } from "./useHomePlan";


const item = (id: string, title: string, extra: Partial<TTaskView> = {}): TTaskView => ({
  id, version: 1, title, status: "in_progress", source: "self", startDate: null, dueDate: null, doneDefinition: null,
  mission: null, waitingOn: null, owner: { personId: "sun", name: "孙铭泽" }, collaborators: [], latestProgress: null,
  returnReason: null, origin: null, awaitingAcceptance: false, planTaskId: null, blocker: null,
  createdAt: "2026-10-01T00:00:00Z", updatedAt: "2026-10-01T00:00:00Z", ...extra,
});
const confirmedRef = { missionId: "m1", title: "CEO / DRI Agent 从能用到在用", cardId: "card-1", period: "2026-10", battlefieldName: "天枢", step: 1, steps: 1 };
const renhao = [{ personId: "renhao", name: "人豪" }];
const progress = (body: string, createdAt: string) => ({ body, createdAt, source: "web" as const, author: { personId: "sun", name: "孙铭泽" } });

/** 2026 年 10 月，今天 10/22（周四）。a3 的任务卡还没确认（item.mission 为空），按 activity.missionId 仍归 m1。 */
const plan = (overrides: Partial<THomePlanResponse> = {}): THomePlanResponse => ({
  period: "2026-10",
  fallbackFrom: null,
  today: "2026-10-22",
  weekStart: "2026-10-19",
  weekEnd: "2026-10-25",
  days: Array.from({ length: 31 }, (_, index) => ({ date: `2026-10-${String(index + 1).padStart(2, "0")}`, workday: true })),
  missions: [
    { missionId: "m1", code: "M1", title: "CEO / DRI Agent 从能用到在用", cardId: "card-1", color: "#2f63b0",
      world: { status: "draft", label: "草稿", version: 5, readAt: "2026-10-25T04:40:00.000Z", gaps: ["Task 全景", "时间边界"] } },
    { missionId: "m2", code: "M2", title: "灯塔首次会面", cardId: null, color: "#2f8a7a", world: null },
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
  unplaced: [],
  activities: [
    { item: item("a1", "回流方案定稿", { status: "done", dueDate: "2026-10-21", planTaskId: "t1", mission: confirmedRef, collaborators: renhao, latestProgress: progress("方案定稿", "2026-10-22T03:40:00Z") }), missionId: "m1", column: "done", overdue: false, lastActivityAt: "2026-10-22T03:40:00Z", idleDays: null },
    { item: item("a2", "对话架构与分工", { status: "done", dueDate: "2026-10-20", mission: confirmedRef }), missionId: "m1", column: "done", overdue: false, lastActivityAt: "2026-10-01T00:00:00Z", idleDays: null },
    { item: item("a3", "真实会议跑通", { dueDate: "2026-10-24", planTaskId: "t1", collaborators: renhao, latestProgress: progress("最终评审修复合入，等预发实测", "2026-10-22T05:08:00Z") }), missionId: "m1", column: "week", overdue: false, lastActivityAt: "2026-10-22T05:08:00Z", idleDays: null },
    { item: item("a4", "Chat 服务抽出", { dueDate: "2026-10-16", planTaskId: "t2", mission: confirmedRef, latestProgress: progress("拆出进程", "2026-10-19T02:00:00Z") }), missionId: "m1", column: "week", overdue: true, lastActivityAt: "2026-10-19T02:00:00Z", idleDays: 3 },
    { item: item("a5", "客户版演示", { planTaskId: "t3", collaborators: renhao, latestProgress: progress("演示稿写完", "2026-10-21T12:26:00Z") }), missionId: "m2", column: "week", overdue: false, lastActivityAt: "2026-10-21T12:26:00Z", idleDays: null },
    { item: item("a6", "新 Chat 题库打分", { status: "not_started", startDate: "2026-10-27", planTaskId: "t-gone", mission: confirmedRef, latestProgress: progress("题库整理", "2026-10-18T02:00:00Z") }), missionId: "m1", column: "later", overdue: false, lastActivityAt: "2026-10-18T02:00:00Z", idleDays: null },
    { item: item("a7", "报销", { dueDate: "2026-10-23", latestProgress: progress("\n发票交了\n还差一张", "2026-10-20T01:00:00Z") }), missionId: null, column: "week", overdue: false, lastActivityAt: "2026-10-20T01:00:00Z", idleDays: null },
  ] satisfies THomePlanActivity[],
  ...overrides,
});

const event = () => ({ currentTarget: { id: "origin" }, target: { id: "origin" }, preventDefault: vi.fn(), stopPropagation: vi.fn() });

function mount(initial: THomePlanResponse | null = plan()) {
  let current = initial;
  const onNavigate = vi.fn();
  h.states = []; h.refs = []; h.callbacks = []; h.effects = [];
  let html = "";
  const render = () => {
    for (let pass = 0; pass < 8; pass++) {
      h.stateIndex = 0; h.refIndex = 0; h.callbackIndex = 0; h.effectIndex = 0; h.dirty = false; h.queued = []; h.elements = []; h.popovers = [];
      html = renderToStaticMarkup(<HomePlan plan={current} actions={<span data-actions="quick" />} onNavigate={onNavigate} />);
      h.queued.forEach((run) => run());
      if (!h.dirty) return html;
    }
    throw new Error("首页没有稳定下来");
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
    /** 点开两栏下面的「已完成 · N」。 */
    openDone: () => call(get((props) => props["data-done-toggle"] !== undefined, "已完成"), "onClick"),
    click: (predicate: (props: Props) => boolean, what: string) => call(get(predicate, what), "onClick"),
    type: (value: string) => call(get((props) => props["data-mark-name"] !== undefined, "名字输入框"), "onChange", { target: { value } }),
    key: (key: string, isComposing = false) => call(get((props) => props["data-mark-name"] !== undefined, "名字输入框"), "onKeyDown", { key, nativeEvent: { isComposing }, preventDefault: vi.fn() }),
    calendar: (handler: "onPickDay" | "onEditMark", ...args: string[]) => { (h.calendar![handler] as (...values: string[]) => void)(...args); return render(); },
    /** 点一天，再点「＋ 加节点」。 */
    addOn: (date: string) => {
      (h.calendar!.onPickDay as (value: string) => void)(date);
      render();
      return call(get((props) => props["data-day-add"] !== undefined, "＋ 加节点"), "onClick");
    },
  };
}
const settle = () => new Promise<void>((resolve) => setImmediate(resolve));

/** 一栏的整段（栏不嵌套）。 */
const column = (html: string, name: "done" | "week" | "later") => html.match(new RegExp(`<section[^>]*data-column="${name}"[^>]*>.*?</section>`))?.[0] ?? "";
const cardsIn = (html: string, name: "done" | "week" | "later") => [...column(html, name).matchAll(/data-activity="([^"]+)"/g)].map((match) => match[1]);
const allCards = (html: string) => [...cardsIn(html, "done"), ...cardsIn(html, "week"), ...cardsIn(html, "later")].sort();
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
/** 详情卡头部（h2）的字。 */
const heading = (html: string) => text(html.match(/<section[^>]*aria-label="Mission 详情"[^>]*>.*?<\/h2>/)?.[0] ?? "").trim();
/** 一张 Task 小卡（按 data-task）的整段。 */
const taskCard = (html: string, id: string) => html.match(new RegExp(`<button[^>]*data-task="${id}"[^>]*>.*?</button>`))?.[0] ?? "";
/** 一个 Mission 项的字。 */
const missionText = (html: string, id: string) => text(html.match(new RegExp(`<button[^>]*data-mission="${id}"[^>]*>.*?</button>`))?.[0] ?? "").trim();
const ok = (data: unknown = undefined) => ({ data, response: { ok: true, status: 200 } });

beforeEach(() => {
  vi.resetAllMocks();
  h.calendar = null;
  vi.stubGlobal("window", { dispatchEvent: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

/** Mission 卡里一项的 props。 */
const tab = (view: ReturnType<typeof mount>, id: string) => view.find((props) => props["data-mission"] === id)!;

describe("HomePlan：版式", () => {
  it("从前到后：快捷、月历、Mission、Mission 详情（手持一列时就是这个顺序）；没有「最近进展」卡", () => {
    const html = mount().html;
    const at = (needle: string) => {
      const index = html.indexOf(needle);
      expect(index, needle).toBeGreaterThan(-1);
      return index;
    };
    const order = [at('data-actions="quick"'), at('aria-label="月历"'), at('aria-label="本月 Mission"'), at('aria-label="Mission 详情"')];
    expect(order).toEqual([...order].sort((a, b) => a - b));
    expect(html).not.toContain("最近进展");
  });

  it("计划还没读到：快捷卡照样出，其余不出", () => {
    const html = mount(null).html;
    expect(html).toContain('data-actions="quick"');
    expect(html).not.toMatch(/aria-label="(月历|本月 Mission|Mission 详情)"/);
  });

  it("去掉的东西：没有横条时间轴、Task 胶囊行、「全部 Task」、「Mission 卡 ›」", () => {
    const view = mount();
    view.mission("m1");
    expect(view.html).not.toMatch(/本月时间轴|data-task-row|全部 Task|Mission 卡 ›/);
  });
});

describe("HomePlan：月历", () => {
  it("月历拿到本月的日子、本周、关口、计划点、Mission 颜色；聚焦跟着 Mission 卡走", () => {
    const view = mount();
    expect(h.calendar).toMatchObject({ period: "2026-10", today: "2026-10-22", weekStart: "2026-10-19", weekEnd: "2026-10-25", current: true, focus: null });
    const colorOf = h.calendar!.colorOf as (id: string) => string;
    expect([colorOf("m1"), colorOf("m2")]).toEqual(["#2f63b0", "#2f8a7a"]);
    view.mission("m1");
    expect(h.calendar!.focus).toBe("m1");
  });

  it("回退显示上个月：月历 current=false（不画本周、不写还剩几个工作日），Mission 标题旁写「9 月」", () => {
    const html = mount(plan({ period: "2026-09", fallbackFrom: "2026-09", days: [{ date: "2026-09-30", workday: true }] })).html;
    expect(h.calendar!.current).toBe(false);
    expect(html).toMatch(/<h2>Mission<span class="[^"]*_month_[^"]*">9 月<\/span><\/h2>/);
    expect(mount().html).not.toMatch(/\d+ 月<\/span>/);
    expect(h.calendar!.current).toBe(true);
  });
});

describe("HomePlan：Mission 卡", () => {
  it("竖排的一组按钮：第一行「全部」写执行事项件数，每个 Mission 写完整名字和下一个关口（今天及以后最近的那个）", () => {
    const view = mount();
    expect(view.html).toMatch(/role="group" aria-label="Mission"/);
    expect(view.html).not.toMatch(/role="tab(list)?"/);
    expect(missionText(view.html, "all")).toBe("全部 7 件");
    expect(missionText(view.html, "m1")).toBe("CEO / DRI Agent 从能用到在用 草稿 10/28 上线");
    expect(missionText(view.html, "m2")).toBe("灯塔首次会面 10/22 首次会面");
    for (const id of ["all", "m1", "m2"]) expect(tab(view, id).type).toBe("button");
  });

  it("色点和选中底色用 Mission 色（行内 --c），「全部」是中性灰；名字本身不带颜色", () => {
    const view = mount();
    expect(String((tab(view, "m2").style as Record<string, string>)["--c"])).toBe("#2f8a7a");
    expect(String((tab(view, "all").style as Record<string, string>)["--c"])).toBe("var(--ink-faint)");
    expect(view.html).not.toMatch(/_missionName_[^"]*" style=/);
  });

  it("默认「全部」；点哪个选哪个（aria-pressed，和 Task 列一样）", () => {
    const view = mount();
    expect(tab(view, "all")["aria-pressed"]).toBe(true);
    view.mission("m1");
    expect(tab(view, "all")["aria-pressed"]).toBe(false);
    expect(tab(view, "m1")["aria-pressed"]).toBe(true);
  });

  it("从本体载入、还没成立的 Mission：名字后面标本体给的中文名；详情页头下一行写状态、本体版本、读取时间和缺项；不是本体载入的、已确认的都不标", () => {
    const view = mount();
    expect(view.html).toMatch(/data-world-status="draft"[^>]*>草稿<\/span>/);
    expect(view.html).not.toContain("data-world-meta");
    view.mission("m1");
    expect(text(view.html.match(/<p[^>]*data-world-meta[^>]*>.*?<\/p>/)?.[0] ?? "").trim()).toBe("草稿 · 本体 v5 · 10/25 读 · 缺 Task 全景、时间边界");
    view.mission("m2");
    expect(view.html).not.toContain("data-world-meta");
    const confirmed = mount(plan({ missions: plan().missions.map((m) => m.world ? { ...m, world: { ...m.world, status: "confirmed", label: "已确认", gaps: [] } } : m) }));
    expect(confirmed.html).not.toContain("data-world-status");
    confirmed.mission("m1");
    expect(text(confirmed.html.match(/<p[^>]*data-world-meta[^>]*>.*?<\/p>/)?.[0] ?? "").trim()).toBe("本体 v5 · 10/25 读");
  });

  it("没有关口的 Mission 不写右边小字；关口都过去了也不写", () => {
    const html = mount(plan({ gates: [{ missionId: "m1", date: "2026-10-12", label: "需求冻结" }] })).html;
    expect(missionText(html, "m1")).toBe("CEO / DRI Agent 从能用到在用 草稿");
    expect(missionText(html, "m2")).toBe("灯塔首次会面");
  });
});

describe("HomePlan：选「全部」时的详情", () => {
  it("头部写「全部 Mission」，不出 Task 列；三栏是全部事项", () => {
    const view = mount();
    expect(heading(view.html)).toBe("全部 Mission");
    expect(view.html).not.toContain("data-task-list");
    expect(cardsIn(view.html, "week")).toHaveLength(4);
    expect(cardsIn(view.html, "later")).toHaveLength(1);
    expect(text(view.html)).toContain("本周 10/19–10/25");
    // 已完成不占栏：两栏下面一行「已完成 · 2」，点开才列出。
    expect(cardsIn(view.html, "done")).toEqual([]);
    expect(text(view.html)).toContain("已完成 · 2");
    view.openDone();
    expect(cardsIn(view.html, "done")).toHaveLength(2);
  });

  it("卡片小字写它属于哪个 Mission；不属于任何 Mission 的写「不属于 Mission」", () => {
    const html = mount().html;
    const small = (id: string) => text(html.match(new RegExp(`<button[^>]*data-activity="${id}"[^>]*>.*?</button>`))![0].match(/<small[^>]*>.*<\/small>/)?.[0] ?? "").trim();
    expect(small("a3")).toBe("CEO / DRI Agent 从能用到在用 · 10/24");
    expect(small("a5")).toBe("灯塔首次会面");
    expect(small("a7")).toBe("不属于 Mission · 10/23");
  });

  it("挂在之前月份 Mission 下没做完的：只在「全部」里，小字写它任务卡上的 Mission 名", () => {
    const earlier = { item: item("a8", "九月没收尾", { dueDate: "2026-09-28", mission: { ...confirmedRef, missionId: "sep-1", title: "九月的 Mission" } }), missionId: "sep-1", column: "week", overdue: true, lastActivityAt: "2026-10-01T00:00:00Z", idleDays: null } satisfies THomePlanActivity;
    const view = mount(plan({ activities: [...plan().activities, earlier] }));
    expect(text(view.html.match(/<button[^>]*data-activity="a8"[^>]*>.*?<\/button>/)![0])).toContain("九月的 Mission · 9/28");
    for (const missionId of ["m1", "m2"]) {
      view.mission(missionId);
      expect(allCards(view.html)).not.toContain("a8");
    }
  });
});

describe("HomePlan：选某个 Mission 时的详情", () => {
  it("头部「● Mission 名 / Task 名」；默认选有本周事项的第一个 Task，三栏只剩它的事项", () => {
    const view = mount();
    view.mission("m1");
    expect(heading(view.html)).toBe("CEO / DRI Agent 从能用到在用 / 会议写进本体");
    expect(view.find((props) => props["data-task"] === "t1")!["aria-pressed"]).toBe(true);
    view.openDone();
    expect(cardsIn(view.html, "done")).toEqual(["a1"]);
    expect(cardsIn(view.html, "week")).toEqual(["a3"]);
    expect(cardsIn(view.html, "later")).toEqual([]);
    expect(text(column(view.html, "later"))).toContain("—");
  });

  it("默认 Task：前面的 Task 没有本周事项就往后找；都没有就第一个", () => {
    const quiet = { taskId: "t0", missionId: "m1", name: "先放着", doneDefinition: null, criteria: [] };
    const view = mount(plan({ tasks: [quiet, ...plan().tasks] }));
    view.mission("m1");
    expect(heading(view.html)).toBe("CEO / DRI Agent 从能用到在用 / 会议写进本体");
    const other = mount(plan({ tasks: [quiet, ...plan().tasks], activities: plan().activities.filter((activity) => activity.column !== "week") }));
    other.mission("m1");
    expect(heading(other.html)).toBe("CEO / DRI Agent 从能用到在用 / 先放着");
  });

  it("Task 小卡：名字、「已完成 a / b」、最近的未完成截止日、进度线；没有「全部 Task」", () => {
    const view = mount();
    view.mission("m1");
    expect(text(taskCard(view.html, "t1")).trim()).toBe("会议写进本体 已完成 1 / 2 10/24");
    expect(taskCard(view.html, "t1")).toMatch(/_bar_[^>]*aria-hidden="true"><span style="width:50%"/);
    expect(text(taskCard(view.html, "t2")).trim()).toBe("对话质量达标 已完成 0 / 1 10/16");
    expect(view.html).not.toContain("全部 Task");
  });

  it("点另一个 Task：它浮起来（aria-pressed、data-selected），头部换名字，三栏换成它的事项；再点一次不取消", () => {
    const view = mount();
    view.mission("m1");
    view.task("t2");
    expect(view.find((props) => props["data-task"] === "t2")!["aria-pressed"]).toBe(true);
    expect(view.html).toMatch(/<div class="[^"]*_task_[^"]*" data-selected="true"><button[^>]*data-task="t2"/);
    expect(heading(view.html)).toBe("CEO / DRI Agent 从能用到在用 / 对话质量达标");
    expect(allCards(view.html)).toEqual(["a4"]);
    view.task("t2");
    expect(allCards(view.html)).toEqual(["a4"]);
  });

  it("「未归入 Task」在最后，写件数：这个 Mission 下没挂 Task、或挂的 Task 不在这里的；选中只看它们", () => {
    const view = mount();
    view.mission("m1");
    expect(view.html.indexOf('data-task="loose"')).toBeGreaterThan(view.html.indexOf('data-task="t2"'));
    expect(text(taskCard(view.html, "loose")).trim()).toBe("未归入 Task 2 件");
    view.task("loose");
    expect(heading(view.html)).toBe("CEO / DRI Agent 从能用到在用 / 未归入 Task");
    view.openDone();
    expect(allCards(view.html)).toEqual(["a2", "a6"]);
  });

  it("所有事项都挂上了 Task：不出「未归入 Task」；选着它时重取变成 0，回到默认 Task", () => {
    const matched = plan({ activities: plan().activities.filter(({ item }) => ["t1", "t2", "t3"].includes(item.planTaskId ?? "")) });
    const view = mount();
    view.mission("m1");
    view.task("loose");
    view.setPlan(matched);
    expect(view.html).not.toContain('data-task="loose"');
    expect(heading(view.html)).toBe("CEO / DRI Agent 从能用到在用 / 会议写进本体");
  });

  it("重取回来选中的 Task 不在了：回到默认 Task", () => {
    const view = mount();
    view.mission("m1");
    view.task("t2");
    view.setPlan(plan({ tasks: plan().tasks.filter((task) => task.taskId !== "t2") }));
    expect(heading(view.html)).toBe("CEO / DRI Agent 从能用到在用 / 会议写进本体");
    view.openDone();
    expect(allCards(view.html)).toEqual(["a1", "a3"]);
  });

  it("Mission 没有任何 Task：不出 Task 列，头部只写 Mission 名，三栏是这个 Mission 的全部事项", () => {
    const view = mount(plan({ tasks: plan().tasks.filter((task) => task.missionId === "m2") }));
    view.mission("m1");
    expect(view.html).not.toContain("data-task-list");
    expect(heading(view.html)).toBe("CEO / DRI Agent 从能用到在用");
    view.openDone();
    expect(allCards(view.html)).toEqual(["a1", "a2", "a3", "a4", "a6"]);
  });

  it("切换 Mission：Task 回到新 Mission 的默认；跨月重取后聚焦的 Mission 不在了，回到「全部」", () => {
    const view = mount();
    view.mission("m1");
    view.task("t2");
    view.mission("m2");
    expect(heading(view.html)).toBe("灯塔首次会面 / Chat 客户版");
    expect(view.html).not.toContain('data-task="loose"');
    view.setPlan(plan({ missions: plan().missions.filter((mission) => mission.missionId !== "m2") }));
    expect(heading(view.html)).toBe("全部 Mission");
  });

  it("详情卡底色用 Mission 色（行内 --c），「全部」不带；Mission 有任务卡时名字点进 Mission 卡页", () => {
    const view = mount();
    expect(view.html).toMatch(/<section class="[^"]*" data-detail="all" aria-label="Mission 详情">/);
    view.mission("m1");
    expect(view.html).toMatch(/data-detail="m1" style="--c:#2f63b0" aria-label="Mission 详情"/);
    view.click((props) => props["data-mission-card"] !== undefined, "Mission 名");
    expect(view.onNavigate).toHaveBeenCalledWith("/me/mission-cards/card-1", expect.anything());
    view.mission("m2");
    expect(view.find((props) => props["data-mission-card"] !== undefined)).toBeUndefined();
  });

  it("ⓘ 只在选中且有完成定义或验收标准的 Task 上；点开有「做到什么算完」和每一条验收标准，再点收起", () => {
    const view = mount();
    view.mission("m1");
    expect(view.html).not.toContain("会后自动出会议卡");
    view.info();
    expect(text(view.html)).toContain("会后自动出会议卡，整卡确认后写进本体。");
    expect(text(view.html)).toContain("真实工作会走完全链路，读回一致");
    expect(text(view.html)).toContain("飞书里直接开的会也接得住");
    view.info();
    expect(view.html).not.toContain("飞书里直接开的会也接得住");
    view.task("t2");
    expect(view.find((props) => props["data-info"] !== undefined)).toBeUndefined();
  });

  it("ⓘ 浮层 Esc 或点外面就关；开着时重取回来那个 Task 没有说明了：关掉、状态清掉，内容回来也不重开", () => {
    const view = mount();
    view.mission("m1");
    view.info();
    expect(view.openPopovers()).toBe(1);
    expect(view.dismiss()).not.toContain('role="dialog"');
    view.info();
    view.setPlan(plan({ tasks: plan().tasks.map((task) => ({ ...task, doneDefinition: null, criteria: [] })) }));
    expect(view.openPopovers()).toBe(0);
    view.setPlan(plan());
    expect(view.html).not.toContain('role="dialog"');
  });
});

describe("HomePlan：三栏的卡片", () => {
  it("标题、日期（进行中的再加最近一次动静）：有截止写截止日，没有截止写「M/D 起」，已完成只写截止日；不写协作人；逾期的日期带 data-overdue", () => {
    const view = mount();
    view.mission("m1");
    view.task("loose");
    view.openDone();
    const card = (id: string) => view.html.match(new RegExp(`<button[^>]*data-activity="${id}"[^>]*>.*?</button>`))?.[0] ?? "";
    expect(text(card("a6")).trim()).toBe("新 Chat 题库打分 10/27 起");
    expect(text(card("a2")).trim()).toBe("对话架构与分工 10/20");
    view.task("t1");
    expect(text(card("a3")).trim()).toBe("真实会议跑通 13:08 10/24");
    expect(text(column(view.html, "week"))).not.toContain("人豪");
    view.task("t2");
    expect(card("a4")).toMatch(/<span data-overdue="true">10\/16</);
  });

  it("每栏按日期排，没日期的在后", () => {
    expect(cardsIn(mount().html, "week")).toEqual(["a4", "a7", "a3", "a5"]);
  });

  it("没完成的卡右下角「验收」：读事项详情和材料，当场弹出和二级页同一个验收弹窗；没写完成标准时「写完成标准」去二级页并直接打开编辑；读不到就直接去二级页验收；已完成的卡没有", async () => {
    const detail = { task: { id: "a3", version: 1, title: "真实会议跑通" }, standards: ["跑通"], submission: null };
    const materials = [{ id: "m-1", fileName: "纪要.md" }];
    vi.stubGlobal("fetch", vi.fn(async () => ({ ok: true, json: async () => ({ materials }) })));
    h.accept = null;
    h.api.GET.mockResolvedValue(ok(detail));
    const view = mount();
    view.click((props) => props["data-accept"] === "a3", "验收");
    await settle();
    view.render();
    expect(h.api.GET).toHaveBeenCalledWith("/api/me/tasks/{id}", { params: { path: { id: "a3" } } });
    expect(fetch).toHaveBeenCalledWith("/api/materials/task/a3", expect.anything());
    expect(view.html).toContain("data-accept-dialog");
    expect(h.accept).toMatchObject({ detail, materials });
    expect(h.accept).not.toHaveProperty("quick");
    (h.accept!.onEditStandards as () => void)();
    expect(view.onNavigate).toHaveBeenCalledWith("/me/tasks/a3?edit=1", expect.anything());
    (h.accept!.onClose as () => void)();
    expect(view.render()).not.toContain("data-accept-dialog");

    h.api.GET.mockResolvedValue({ data: undefined, response: { ok: false, status: 404 } });
    view.click((props) => props["data-accept"] === "a4", "验收");
    await settle();
    expect(view.onNavigate).toHaveBeenLastCalledWith("/me/tasks/a4?accept=1", expect.anything());
    view.openDone();
    expect(view.find((props) => props["data-accept"] === "a1")).toBeUndefined();
  });

  it("点卡片进事项详情", () => {
    const view = mount();
    const origin = event();
    (view.activity("a3").onClick as (value: unknown) => void)(origin);
    expect(view.onNavigate).toHaveBeenCalledWith("/me/tasks/a3", origin.currentTarget);
  });
});

describe("HomePlan：事项卡上的最近一次动静", () => {
  it("进行中的卡右上角写最近一次动静：今天写 HH:MM，更早写 M/D（公司时区）；停滞的写「N 天没动」；未开始、已完成的不写", () => {
    const view = mount();
    view.mission("m1");
    view.task("t1");
    view.openDone();
    const signal = (id: string) => {
      const match = view.html.match(new RegExp(`data-activity="${id}"[^>]*>(.*?)</button>`));
      expect(match, id).toBeTruthy();
      return match![1].match(/data-signal="true"[^>]*>([^<]*)</)?.[1] ?? null;
    };
    expect(signal("a3")).toBe("13:08");
    expect(signal("a1")).toBeNull();
    view.task("t2");
    expect(signal("a4")).toBe("3 天没动");
    expect(view.html).toMatch(/data-activity="a4"[^>]*data-idle="true"/);
    view.mission("all");
    expect(signal("a5")).toBe("10/21");
    expect(signal("a7")).toBe("10/20");
    expect(signal("a6")).toBeNull();
  });
});

describe("HomePlan：月历上的「这一天」与节点", () => {
  const radios = () => h.elements.filter((element) => element.props.role === "radio");

  it("点一天先看这一天：关口、我的节点、这天截止分组列出，空的组不出；截止的事项点进去是详情", () => {
    const view = mount();
    view.calendar("onPickDay", "2026-10-23");
    const day = text(view.html);
    expect(view.html).toContain('data-mark-pop="day"');
    expect(day).toContain("10 月 23 日 周五");
    expect(day).toContain("还有 1 个工作日");
    expect(day).toMatch(/我的节点 联调 CEO \/ DRI Agent 从能用到在用/);
    expect(day).toMatch(/这天截止 报销/);
    expect(day).not.toContain("关口");
    expect(day).toContain("＋ 加节点");
    view.click((props) => props["data-day-item"] === "a7", "报销");
    expect(view.onNavigate).toHaveBeenCalledWith("/me/tasks/a7", { id: "origin" });
    expect(view.html).not.toContain("data-mark-pop");

    view.calendar("onPickDay", "2026-10-22");
    expect(text(view.html)).toMatch(/10 月 22 日 周四 今天 关口 首次会面 灯塔首次会面/);
    // 做完的事项不算这天截止；什么都没有时只有日期和「＋ 加节点」。
    view.calendar("onPickDay", "2026-10-21");
    expect(text(view.html)).not.toMatch(/截止|关口|我的节点|还有/);
    expect(text(view.html)).toContain("＋ 加节点");
  });

  it("「全部」视图下加节点：Mission 按名字列出，默认第一个；提交挂到选中的 Mission，回到「看这一天」", async () => {
    h.api.POST.mockResolvedValue(ok({ id: "k9", missionId: "m2", date: "2026-10-24", label: "演示" }));
    const view = mount();
    view.addOn("2026-10-24");
    expect(view.html).toContain('data-mark-pop="add"');
    expect(text(view.html)).toContain("10 月 24 日 周六 · 加节点");
    expect(radios()).toHaveLength(2);
    expect(radios().map((radio) => radio.props["aria-checked"])).toEqual([true, false]);
    expect(text(view.html)).toContain("灯塔首次会面");
    view.click((props) => props["data-pick"] === "m2", "m2 色点");
    view.type("演示");
    view.key("Enter");
    expect(h.api.POST).toHaveBeenCalledWith("/api/me/plan-marks", { body: { missionId: "m2", date: "2026-10-24", label: "演示" } });
    expect(view.html).toContain('data-mark-pop="day"');
    expect(text(view.html)).toMatch(/我的节点 演示 灯塔首次会面/);
  });

  it("聚焦 m2 时加节点：默认选 m2；先画上再等接口，存好后通知重取", async () => {
    h.api.POST.mockResolvedValue(ok({ id: "k9", missionId: "m2", date: "2026-10-24", label: "评审" }));
    const view = mount();
    view.mission("m2");
    view.addOn("2026-10-24");
    expect(view.html).toContain('data-mark-pop="add"');
    expect(radios().map((radio) => radio.props["aria-checked"])).toEqual([false, true]);
    view.type("评审");
    view.key("Enter");
    expect(h.api.POST).toHaveBeenCalledWith("/api/me/plan-marks", { body: { missionId: "m2", date: "2026-10-24", label: "评审" } });
    expect(view.html).toContain('data-mark-pop="day"');
    expect((h.calendar!.marks as { label: string; date: string }[]).map((mark) => `${mark.date} ${mark.label}`)).toContain("2026-10-24 评审");
    await settle();
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: HOME_PLAN_CHANGED }));
  });

  it("中文输入法还在拼字时按 Enter 不提交；空名字不提交；名字最多 10 个字；Esc 关掉不提交", () => {
    const view = mount();
    view.addOn("2026-10-24");
    expect(view.find((props) => props["data-mark-name"] !== undefined)!.maxLength).toBe(10);
    view.key("Enter");
    view.type("评审");
    view.key("Enter", true);
    expect(h.api.POST).not.toHaveBeenCalled();
    expect(view.openPopovers()).toBe(1);
    expect(view.dismiss()).not.toContain("data-mark-pop");
    expect(h.api.POST).not.toHaveBeenCalled();
  });

  it("没有 Mission 时点日期只看、不出「＋ 加节点」", () => {
    const view = mount(plan({ missions: [] }));
    view.calendar("onPickDay", "2026-10-24");
    expect(view.html).toContain('data-mark-pop="day"');
    expect(view.html).not.toContain("data-day-add");
  });

  it("点月历上的节点：开那一天并原地改名；没改不发请求、回到「看」；在「看」里点节点也能改名；改了才发 PATCH，先改上再等接口", async () => {
    h.api.PATCH.mockResolvedValue(ok({ id: "k1", missionId: "m1", date: "2026-10-23", label: "联调二" }));
    const view = mount();
    view.calendar("onEditMark", "k1");
    expect(view.html).toContain('data-mark-pop="edit"');
    expect(view.find((props) => props["data-mark-name"] !== undefined)!.value).toBe("联调");
    // 浮层按钮深灰：确认和「开启执行事项」同一个样子，删除是深灰字（主题蓝只留给约会议，不用红）。
    expect(String(view.find((props) => props["aria-label"] === "存好")!.className)).toContain("_plainButton_");
    expect(String(view.find((props) => props["data-delete"] !== undefined)!.className)).toContain("_popDelete_");
    view.key("Enter");
    expect(h.api.PATCH).not.toHaveBeenCalled();
    expect(view.html).toContain('data-mark-pop="day"');
    view.click((props) => props["data-day-mark"] === "k1", "联调");
    expect(view.html).toContain('data-mark-pop="edit"');
    view.type("联调二");
    view.key("Enter");
    expect(h.api.PATCH).toHaveBeenCalledWith("/api/me/plan-marks/{id}", { params: { path: { id: "k1" } }, body: { label: "联调二" } });
    expect((h.calendar!.marks as { label: string }[])[0].label).toBe("联调二");
    await settle();
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: HOME_PLAN_CHANGED }));
  });

  it("改名失败：退回原名并写一句错；下次开浮层时那句错收起来", async () => {
    h.api.PATCH.mockResolvedValue({ error: { message: "名字最多 10 个字" }, response: { ok: false, status: 400 } });
    const view = mount();
    view.calendar("onEditMark", "k1");
    view.type("新名字");
    view.key("Enter");
    await settle();
    const html = view.render();
    expect((h.calendar!.marks as { label: string }[])[0].label).toBe("联调");
    expect(html).toMatch(/role="alert"[^>]*>.*?名字最多 10 个字<\/p>/);
    expect(window.dispatchEvent).not.toHaveBeenCalled();
    expect(view.calendar("onPickDay", "2026-10-24")).not.toContain('role="alert"');
  });

  it("浮层里点「删除」才删；点之前月历上还在", async () => {
    h.api.DELETE.mockResolvedValue({ response: { ok: true, status: 204 } });
    const view = mount();
    view.calendar("onEditMark", "k1");
    expect(h.api.DELETE).not.toHaveBeenCalled();
    expect((h.calendar!.marks as { id: string }[]).map((mark) => mark.id)).toEqual(["k1"]);
    view.click((props) => props["data-delete"] !== undefined, "删除");
    expect(h.api.DELETE).toHaveBeenCalledWith("/api/me/plan-marks/{id}", { params: { path: { id: "k1" } } });
    expect(h.calendar!.marks).toEqual([]);
    expect(view.html).toContain('data-mark-pop="day"');
    await settle();
    expect(window.dispatchEvent).toHaveBeenCalledWith(expect.objectContaining({ type: HOME_PLAN_CHANGED }));
  });

  it("断网：退回并写「没存上」", async () => {
    h.api.DELETE.mockRejectedValue(new TypeError("Failed to fetch"));
    const view = mount();
    view.calendar("onEditMark", "k1");
    view.click((props) => props["data-delete"] !== undefined, "删除");
    await settle();
    const html = view.render();
    expect((h.calendar!.marks as { id: string }[]).map((mark) => mark.id)).toEqual(["k1"]);
    expect(text(html)).toContain("没存上");
  });

  it("重取回来的新计划替掉本地先画上的", async () => {
    h.api.POST.mockResolvedValue(ok({ id: "k9", missionId: "m1", date: "2026-10-24", label: "评审" }));
    const view = mount();
    view.mission("m1");
    view.addOn("2026-10-24");
    view.type("评审");
    view.key("Enter");
    await settle();
    const fresh = plan({ marks: [...plan().marks, { id: "k9", missionId: "m1", date: "2026-10-24", label: "评审" }] });
    view.setPlan(fresh);
    expect(h.calendar!.marks).toBe(fresh.marks);
  });

  const deferred = () => {
    let resolve!: (value: unknown) => void;
    return { promise: new Promise((done) => { resolve = done; }), resolve };
  };
  const markIds = () => (h.calendar!.marks as { id: string }[]).map((mark) => mark.id);
  const markLabels = () => Object.fromEntries((h.calendar!.marks as { id: string; label: string }[]).map((mark) => [mark.id, mark.label]));

  it("删除还在路上时轮询回来的旧计划不会把点画回来；存好、重取看不到它之后这条才撤掉", async () => {
    const sent = deferred();
    h.api.DELETE.mockReturnValue(sent.promise);
    const view = mount();
    view.calendar("onEditMark", "k1");
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
    const renaming = deferred();
    h.api.PATCH.mockReturnValue(renaming.promise);
    h.api.POST.mockResolvedValue({ error: { message: "一个 Mission 下最多 20 个计划点" }, response: { ok: false, status: 409 } });
    const view = mount();
    view.calendar("onEditMark", "k1");
    view.type("联调二");
    view.key("Enter");
    view.mission("m1");
    view.addOn("2026-10-24");
    view.type("评审");
    view.key("Enter");
    expect(markLabels()).toEqual({ k1: "联调二", [markIds()[1]]: "评审" });
    await settle();
    const html = view.render();
    expect(markLabels()).toEqual({ k1: "联调二" });
    expect(html).toContain("一个 Mission 下最多 20 个计划点");
    view.setPlan(plan());
    expect(markLabels()).toEqual({ k1: "联调二" });
    renaming.resolve(ok({ id: "k1", missionId: "m1", date: "2026-10-23", label: "联调二" }));
    await settle();
    view.render();
    expect(markLabels()).toEqual({ k1: "联调二" });
  });

  it("新加的点在 POST 回来之前点不开；回来后换成真 id，可以改", async () => {
    const posting = deferred();
    h.api.POST.mockReturnValue(posting.promise);
    const view = mount();
    view.mission("m1");
    view.addOn("2026-10-24");
    view.type("评审");
    view.key("Enter");
    const temp = markIds()[1];
    expect(temp).toMatch(/^pending-/);
    view.calendar("onEditMark", temp);
    expect(view.html).not.toContain('data-mark-pop="edit"');
    posting.resolve(ok({ id: "k9", missionId: "m1", date: "2026-10-24", label: "评审" }));
    await settle();
    view.render();
    expect(markIds()).toEqual(["k1", "k9"]);
    view.calendar("onEditMark", "k9");
    expect(view.html).toContain('data-mark-pop="edit"');
  });

  it("正在改名的节点重取后不在了：回到「看这一天」，节点再回来也不重新进入改名", () => {
    const view = mount();
    view.calendar("onEditMark", "k1");
    expect(view.openPopovers()).toBe(1);
    view.setPlan(plan({ marks: [] }));
    expect(view.html).toContain('data-mark-pop="day"');
    expect(view.openPopovers()).toBe(1);
    view.setPlan(plan());
    expect(view.html).not.toContain('data-mark-pop="edit"');
  });
});

describe("首页样式的护栏", () => {
  it("Mission 色只在若有若无的底色里：没有侧边色条，本周栏不用主题蓝", () => {
    const css = readFileSync(new URL("../../../styles/home-plan.module.css", import.meta.url), "utf8");
    expect(css).not.toMatch(/--bar|#215ba1|rgba\(33, 91, 161/);
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
