import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { renderToStaticMarkup } from "react-dom/server";
import type { THomePlanDay } from "@warmap/contracts";

/**
 * 成员首页本月时间轴（一天一格）。
 * 没有 jsdom：结构用 renderToStaticMarkup 看；计划点的指针回调从 JSX 运行时截下来，按真实顺序直接调用；
 * useEffect 收下来，卸载时的清理手动跑。
 */
type Props = Record<string, unknown>;
const h = vi.hoisted(() => ({ elements: [] as { type: string; props: Record<string, unknown> }[], effects: [] as (() => unknown)[] }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: (effect: () => unknown) => void h.effects.push(effect) };
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

import { DayTimeline, workdaysLeftThisWeek } from "./DayTimeline";

/** 2026 年 10 月：10/1–10/7 国庆放假，10/10 周六调休上班，其余按周末。 */
const REST = new Set([1, 2, 3, 4, 5, 6, 7, 11, 17, 18, 24, 25, 31]);
const october: THomePlanDay[] = Array.from({ length: 31 }, (_, index) => ({
  date: `2026-10-${String(index + 1).padStart(2, "0")}`,
  workday: !REST.has(index + 1),
}));
const COLORS: Record<string, string> = { m1: "#2f63b0", m2: "#2f8a7a" };

const base = {
  days: october,
  today: "2026-10-22",
  weekStart: "2026-10-19",
  weekEnd: "2026-10-25",
  gates: [
    { missionId: "m1", date: "2026-10-28", label: "上线" },
    { missionId: "m2", date: "2026-10-12", label: "首次会面" },
  ],
  marks: [
    { id: "k1", missionId: "m1", date: "2026-10-23", label: "联调" },
    { id: "k2", missionId: "m2", date: "2026-10-28", label: "复盘" },
  ],
  colorOf: (missionId: string) => COLORS[missionId] ?? "#8a93a3",
  focus: null as string | null,
};
type TimelineProps = Parameters<typeof DayTimeline>[0];
const render = (overrides: Partial<TimelineProps> = {}) => {
  h.elements = [];
  h.effects = [];
  return renderToStaticMarkup(<DayTimeline {...base} {...overrides} />);
};
/** 一天那一格的开标签。 */
const dayTag = (html: string, date: string) => html.match(new RegExp(`<li[^>]*data-day="${date}"[^>]*>`))?.[0] ?? "";
/** 一天那一格的整段（格子里没有嵌套 li）。 */
const dayBlock = (html: string, date: string) => html.match(new RegExp(`<li[^>]*data-day="${date}"[^>]*>.*?</li>`))?.[0] ?? "";
/** 一套视图（data-view）的整段：到下一个 data-view 或结尾。 */
const view = (html: string, name: "days" | "line") => html.split(/(?=<[^>]+data-view=)/).find((part) => part.includes(`data-view="${name}"`)) ?? "";
/** 格子视图里一个点的 props（按 title 找）。 */
const marker = (title: string) => h.elements.find((element) => element.props["data-kind"] && element.props.title === title)!.props;
const tagOf = (html: string, title: string) => html.match(new RegExp(`<[^>]*title="${title}"[^>]*>`))?.[0] ?? "";

describe("workdaysLeftThisWeek：本周还剩几个工作日（只用 days 上的工作日标记）", () => {
  it("从今天（含）数到本周日与月末中较早的那天", () => {
    expect(workdaysLeftThisWeek(october, "2026-10-22", "2026-10-25")).toBe(2);
    expect(workdaysLeftThisWeek(october, "2026-10-25", "2026-10-25")).toBe(0);
    expect(workdaysLeftThisWeek(october, "2026-10-30", "2026-11-01")).toBe(1);
    expect(workdaysLeftThisWeek(october, "2026-10-26", "2026-11-01")).toBe(5);
  });

  it("本周里的法定假日不算、周六补班要算", () => {
    expect(workdaysLeftThisWeek(october, "2026-10-01", "2026-10-04")).toBe(0);
    expect(workdaysLeftThisWeek(october, "2026-10-05", "2026-10-11")).toBe(3);
  });

  it("今天已过月末时没有剩余工作日", () => {
    expect(workdaysLeftThisWeek(october, "2026-11-02", "2026-11-08")).toBe(0);
  });
});

describe("DayTimeline：一天一格", () => {
  it("每天一格：今天、过去、未到，带是否工作日", () => {
    const html = render();
    expect(html.match(/<li[^>]*data-day=/g)).toHaveLength(31);
    expect(dayTag(html, "2026-10-22")).toContain('data-state="today"');
    expect(dayTag(html, "2026-10-21")).toContain('data-state="past"');
    expect(dayTag(html, "2026-10-24")).toContain('data-state="future"');
    expect(dayTag(html, "2026-10-24")).toContain('data-workday="false"');
    expect(dayTag(html, "2026-10-23")).toContain('data-workday="true"');
  });

  it("格子下面只标 1 号、逢 5、今天（写今天）和月末", () => {
    const grid = render().match(/<ol[^>]*>.*<\/ol>/)?.[0] ?? "";
    const texts = [...grid.matchAll(/>([^<]+)</g)].map((match) => match[1]);
    expect(texts).toEqual(["1", "5", "10", "15", "20", "今天", "25", "30", "31"]);
  });

  it("读屏：根节点叫本月时间轴，每格读日期、今天、工作日或休息日", () => {
    const html = render();
    expect(html).toMatch(/^<div[^>]*role="group"[^>]*aria-label="本月时间轴"/);
    expect(dayTag(html, "2026-10-22")).toContain('aria-label="10月22日 今天 工作日"');
    expect(dayTag(html, "2026-10-24")).toContain('aria-label="10月24日 休息日"');
  });

  it("本周括线：圈住本周在本月里的格子，写本周还剩 N 个工作日", () => {
    const html = render();
    const brace = html.match(/<div[^>]*data-week[^>]*>.*?<\/div>/)?.[0] ?? "";
    expect(brace).toContain("grid-column:19 / 26");
    expect(brace).toContain("本周还剩 2 个工作日");
  });

  it("本周跨到下个月：括线截到月末，只数本月里的工作日", () => {
    const html = render({ today: "2026-10-30", weekStart: "2026-10-26", weekEnd: "2026-11-01" });
    const brace = html.match(/<div[^>]*data-week[^>]*>.*?<\/div>/)?.[0] ?? "";
    expect(brace).toContain("grid-column:26 / 32");
    expect(brace).toContain('data-edge="end"');
    expect(brace).toContain("本周还剩 1 个工作日");
  });

  it("showWeek=false：本周落在这个月里也不画括线，细线上没有本周底带和「本周」", () => {
    const html = render({ showWeek: false });
    expect(html).not.toContain("data-week");
    expect(html).not.toContain("本周");
    expect(dayTag(html, "2026-10-22")).toContain('data-state="today"');
    expect(render()).toContain("data-week");
  });

  it("本周不在这个月（回退显示上个月）：不画括线，也没有今天那格", () => {
    const html = render({ today: "2026-11-23", weekStart: "2026-11-23", weekEnd: "2026-11-29" });
    expect(html).not.toContain("data-week");
    expect(html).not.toContain('data-state="today"');
    expect(dayTag(html, "2026-10-31")).toContain('data-state="past"');
  });
});

describe("DayTimeline：关口和计划点", () => {
  it("关口是 gate、计划点是 mark，名字只在 title 和读屏文字里，不常显", () => {
    const html = render();
    const days = view(html, "days");
    expect(tagOf(days, "10/28 上线")).toContain('data-kind="gate"');
    expect(tagOf(days, "10/28 上线")).toContain('role="img"');
    expect(tagOf(days, "10/23 联调")).toContain('data-kind="mark"');
    expect(tagOf(days, "10/23 联调")).toContain('aria-label="计划点 10/23 联调"');
    expect(html.replace(/<[^>]+>/g, " ")).not.toMatch(/上线|联调|首次会面|复盘/);
  });

  it("颜色取 Mission 的颜色", () => {
    const days = view(render(), "days");
    expect(tagOf(days, "10/28 上线")).toContain("--c:#2f63b0");
    expect(tagOf(days, "10/12 首次会面")).toContain("--c:#2f8a7a");
  });

  it("同一天的关口和计划点都放在那一格上方，不藏", () => {
    const block = dayBlock(view(render(), "days"), "2026-10-28");
    expect(block).toContain('data-kind="gate"');
    expect(block).toContain('data-kind="mark"');
  });

  it("聚焦 m1 时，m2 的点淡掉，m1 的不淡；不聚焦时都不淡", () => {
    const days = view(render({ focus: "m1" }), "days");
    expect(tagOf(days, "10/12 首次会面")).toContain("data-dim");
    expect(tagOf(days, "10/28 复盘")).toContain("data-dim");
    expect(tagOf(days, "10/28 上线")).not.toContain("data-dim");
    expect(tagOf(days, "10/23 联调")).not.toContain("data-dim");
    expect(render()).not.toContain("data-dim");
  });

  it("签定关口没有任何拖动处理器；计划点有", () => {
    render({ onAddMark: vi.fn(), onMoveMark: vi.fn(), onDeleteMark: vi.fn() });
    const gate = marker("10/28 上线");
    expect(gate.draggable).toBeUndefined();
    expect(gate.onPointerDown).toBeUndefined();
    expect(gate.onContextMenu).toBeUndefined();
    const mark = marker("10/23 联调");
    expect(mark.onPointerDown).toBeTypeOf("function");
    expect(mark["data-movable"]).toBe(true);
  });

  it("没传回调：计划点不能拖、不能删，格子不能点", () => {
    const html = render();
    const mark = marker("10/23 联调");
    expect(mark.onPointerDown).toBeUndefined();
    expect(mark.onContextMenu).toBeUndefined();
    expect(mark["data-movable"]).toBeUndefined();
    expect(html).not.toContain("<button");
  });
});

describe("DayTimeline：加、拖、删计划点", () => {
  /** 格子那一排（含上方的点和下方的日期）：x 从 100 到 410，一格 10px；y 从 20 到 80。 */
  const list = { getBoundingClientRect: () => ({ left: 100, right: 410, top: 20, bottom: 80 }) };
  const pointer = (x: number, extra: Props = {}) => ({
    button: 0, pointerId: 1, pointerType: "mouse", clientX: x, clientY: 40,
    currentTarget: { setPointerCapture: vi.fn(), closest: () => list }, preventDefault: vi.fn(), ...extra,
  });
  type Handlers = Record<"onPointerDown" | "onPointerMove" | "onPointerUp" | "onPointerCancel" | "onLostPointerCapture" | "onContextMenu", (event: unknown) => void>;
  const handlersOf = (title: string) => marker(title) as unknown as Handlers;

  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("点一格：按那一天加计划点", () => {
    const onAddMark = vi.fn();
    render({ onAddMark });
    const button = h.elements.find((element) => element.type === "button" && element.props["aria-label"] === "加计划点 10月24日")!;
    (button.props.onClick as () => void)();
    expect(onAddMark).toHaveBeenCalledWith("2026-10-24");
  });

  it("按住计划点拖到别的格子：按整格吸附，松手时按落点那天改", () => {
    const onMoveMark = vi.fn();
    render({ onMoveMark });
    const mark = handlersOf("10/23 联调");
    mark.onPointerDown(pointer(100 + 225));
    mark.onPointerMove(pointer(100 + 261));
    mark.onPointerMove(pointer(100 + 269));
    mark.onPointerUp(pointer(100 + 269));
    expect(onMoveMark).toHaveBeenCalledTimes(1);
    expect(onMoveMark).toHaveBeenCalledWith("k1", "2026-10-27");
  });

  it("左右拖出格子那一排再松手：放回原处，不改", () => {
    const onMoveMark = vi.fn();
    render({ onMoveMark });
    const mark = handlersOf("10/23 联调");
    mark.onPointerDown(pointer(325));
    mark.onPointerMove(pointer(365));
    mark.onPointerMove(pointer(900));
    mark.onPointerUp(pointer(900));
    mark.onPointerDown(pointer(325));
    mark.onPointerMove(pointer(60));
    mark.onPointerUp(pointer(60));
    expect(onMoveMark).not.toHaveBeenCalled();
  });

  it("上下离开点和格子那一带再松手：不改；拖回来再松手照常改", () => {
    const onMoveMark = vi.fn();
    render({ onMoveMark });
    const mark = handlersOf("10/23 联调");
    mark.onPointerDown(pointer(325));
    mark.onPointerMove(pointer(365, { clientY: 200 }));
    mark.onPointerUp(pointer(365, { clientY: 200 }));
    mark.onPointerDown(pointer(325));
    mark.onPointerMove(pointer(365, { clientY: -40 }));
    mark.onPointerUp(pointer(365, { clientY: -40 }));
    expect(onMoveMark).not.toHaveBeenCalled();
    mark.onPointerDown(pointer(325));
    mark.onPointerMove(pointer(365, { clientY: -40 }));
    mark.onPointerMove(pointer(365, { clientY: 15 }));
    mark.onPointerUp(pointer(365, { clientY: 15 }));
    expect(onMoveMark).toHaveBeenCalledWith("k1", "2026-10-27");
  });

  it("拖动中指针捕获被夺走：这一下作废，随后的松手不改", () => {
    const onMoveMark = vi.fn();
    render({ onMoveMark });
    const mark = handlersOf("10/23 联调");
    mark.onPointerDown(pointer(325));
    mark.onPointerMove(pointer(365));
    mark.onLostPointerCapture(pointer(365));
    mark.onPointerUp(pointer(365));
    expect(onMoveMark).not.toHaveBeenCalled();
  });

  it("长按还没到点组件就卸载：不再删", () => {
    const onDeleteMark = vi.fn();
    render({ onDeleteMark });
    handlersOf("10/23 联调").onPointerDown(pointer(325, { pointerType: "touch" }));
    const cleanups = h.effects.map((effect) => effect());
    for (const cleanup of cleanups) if (typeof cleanup === "function") cleanup();
    vi.advanceTimersByTime(1000);
    expect(onDeleteMark).not.toHaveBeenCalled();
  });

  it("松手还在原来那天：不改", () => {
    const onMoveMark = vi.fn();
    render({ onMoveMark });
    const mark = handlersOf("10/23 联调");
    mark.onPointerDown(pointer(100 + 222));
    mark.onPointerMove(pointer(100 + 228));
    mark.onPointerUp(pointer(100 + 228));
    expect(onMoveMark).not.toHaveBeenCalled();
  });

  it("右键计划点：删除；不弹浏览器菜单", () => {
    const onDeleteMark = vi.fn();
    render({ onDeleteMark });
    const event = pointer(325, { button: 2 });
    handlersOf("10/23 联调").onContextMenu(event);
    expect(onDeleteMark).toHaveBeenCalledWith("k1");
    expect(event.preventDefault).toHaveBeenCalled();
  });

  it("手指长按计划点：删除一次（随后的系统菜单不再删），松手也不挪", () => {
    const onDeleteMark = vi.fn(), onMoveMark = vi.fn();
    render({ onDeleteMark, onMoveMark });
    const mark = handlersOf("10/23 联调");
    mark.onPointerDown(pointer(325, { pointerType: "touch" }));
    vi.advanceTimersByTime(500);
    expect(onDeleteMark).toHaveBeenCalledWith("k1");
    mark.onContextMenu(pointer(325, { pointerType: "touch" }));
    mark.onPointerMove(pointer(365, { pointerType: "touch" }));
    mark.onPointerUp(pointer(365, { pointerType: "touch" }));
    expect(onDeleteMark).toHaveBeenCalledTimes(1);
    expect(onMoveMark).not.toHaveBeenCalled();
  });

  it("手指按住后挪开：是拖，不是长按", () => {
    const onDeleteMark = vi.fn(), onMoveMark = vi.fn();
    render({ onDeleteMark, onMoveMark });
    const mark = handlersOf("10/23 联调");
    mark.onPointerDown(pointer(325, { pointerType: "touch" }));
    mark.onPointerMove(pointer(345, { pointerType: "touch" }));
    vi.advanceTimersByTime(800);
    mark.onPointerUp(pointer(345, { pointerType: "touch" }));
    expect(onDeleteMark).not.toHaveBeenCalled();
    expect(onMoveMark).toHaveBeenCalledWith("k1", "2026-10-25");
  });

  it("鼠标按住不动不算长按", () => {
    const onDeleteMark = vi.fn();
    render({ onDeleteMark, onMoveMark: vi.fn() });
    handlersOf("10/23 联调").onPointerDown(pointer(325));
    vi.advanceTimersByTime(2000);
    expect(onDeleteMark).not.toHaveBeenCalled();
  });
});

describe("DayTimeline：窄容器退成一根细线", () => {
  it("两套 DOM 都渲染：细线上按比例画今天、本周底带和点", () => {
    const line = view(render(), "line");
    expect(line).toMatch(/data-today[^>]*left:69.35%/);
    expect(line).toMatch(/data-week[^>]*left:58.06%;width:22.58%/);
    expect(tagOf(line, "10/28 上线")).toContain('role="img"');
    expect(line).toMatch(/left:88.71%[^>]*>(?:<[^>]+>)*?<[^>]*title="10\/28 上线"/);
    expect(line).toMatch(/left:69.35%[^>]*>本周</);
  });

  it("细线上本周被月末或月初截断：「本周」跟着那头的日期写，不单独摆", () => {
    const end = view(render({ today: "2026-10-30", weekStart: "2026-10-26", weekEnd: "2026-11-01" }), "line");
    expect(end).toMatch(/data-at="end"[^>]*>(?:<[^>]+>)*本周(?:<[^>]+>)*10\/31</);
    expect(end.match(/本周/g)).toHaveLength(1);
    const november = Array.from({ length: 30 }, (_, index) => ({ date: `2026-11-${String(index + 1).padStart(2, "0")}`, workday: true }));
    const start = view(render({ days: november, today: "2026-11-01", weekStart: "2026-10-26", weekEnd: "2026-11-01", gates: [], marks: [] }), "line");
    expect(start).toMatch(/data-at="start"[^>]*>11\/1(?:<[^>]+>)*本周</);
    expect(start.match(/本周/g)).toHaveLength(1);
  });

  it("容器宽度小于 560px 时显示细线、藏起格子", () => {
    const css = readFileSync(new URL("../../../styles/day-timeline.module.css", import.meta.url), "utf8");
    expect(css).toContain("container: day-timeline / inline-size;");
    expect(css).toMatch(/@container day-timeline \(max-width: 559px\) \{[^@]*\.days[^{]*\{ display: none; \}[^@]*\.line \{ display: block; \}/);
  });

  it("颜色照样稿：未到工作日深蓝、未到休息日浅蓝、过去统一灰", () => {
    const css = readFileSync(new URL("../../../styles/day-timeline.module.css", import.meta.url), "utf8");
    expect(css).toContain('.day[data-workday="true"] { background: #3d6fb6; }');
    expect(css).toContain('.day[data-workday="false"] { background: #dbe4f0; }');
    expect(css).toContain('.day[data-state="past"] { background: #c9d1dc; }');
  });
});
