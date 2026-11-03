import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { THomePlanDay } from "@warmap/contracts";

/**
 * 成员首页的月历卡内容。
 * 没有 jsdom：结构用 renderToStaticMarkup 看；按钮的处理器从 JSX 运行时截下来直接调。
 */
type Props = Record<string, unknown>;
const h = vi.hoisted(() => ({ elements: [] as { type: string; props: Record<string, unknown> }[] }));
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

import { MonthCalendar, workdaysLeftThisMonth } from "./MonthCalendar";

/** 2026 年 10 月：10/1–10/7 国庆放假，10/10 周六调休上班，其余按周末。 */
const REST = new Set([1, 2, 3, 4, 5, 6, 7, 11, 17, 18, 24, 25, 31]);
const october: THomePlanDay[] = Array.from({ length: 31 }, (_, index) => ({
  date: `2026-10-${String(index + 1).padStart(2, "0")}`,
  workday: !REST.has(index + 1),
}));
const COLORS: Record<string, string> = { m1: "#2f63b0", m2: "#2f8a7a" };

const base = {
  period: "2026-10",
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
type CalendarProps = Parameters<typeof MonthCalendar>[0];
const render = (overrides: Partial<CalendarProps> = {}) => {
  h.elements = [];
  return renderToStaticMarkup(<MonthCalendar onPickDay={vi.fn()} onEditMark={vi.fn()} {...base} {...overrides} />);
};
const text = (html: string) => html.replace(/<[^>]+>/g, " ").replace(/\s+/g, " ").trim();
/** 一天那一格的开标签。 */
const dayTag = (html: string, date: string) => html.match(new RegExp(`<li[^>]*data-day="${date}"[^>]*>`))?.[0] ?? "";
/** 一天那一格的整段（格子里没有嵌套 li）。 */
const dayBlock = (html: string, date: string) => html.match(new RegExp(`<li[^>]*data-day="${date}"[^>]*>.*?</li>`))?.[0] ?? "";
const find = (predicate: (props: Props) => boolean) => h.elements.find((element) => predicate(element.props))?.props;

beforeEach(() => { h.elements = []; });

describe("workdaysLeftThisMonth：本月还剩几个工作日（按 days 上的中国工作日历）", () => {
  it("从今天数到月末，今天是工作日就算上", () => {
    expect(workdaysLeftThisMonth(october, "2026-10-22")).toBe(7);
    expect(workdaysLeftThisMonth(october, "2026-10-30")).toBe(1);
  });

  it("今天是休息日不算今天；放假不算、调休上班日要算", () => {
    expect(workdaysLeftThisMonth(october, "2026-10-24")).toBe(5);
    expect(workdaysLeftThisMonth(october, "2026-10-31")).toBe(0);
    expect(workdaysLeftThisMonth(october, "2026-10-01")).toBe(18);
    expect(workdaysLeftThisMonth(october.map((day) => (day.date === "2026-10-10" ? { ...day, workday: false } : day)), "2026-10-01")).toBe(17);
  });

  it("今天已过月末时没有剩余工作日", () => {
    expect(workdaysLeftThisMonth(october, "2026-11-02")).toBe(0);
  });
});

describe("MonthCalendar：月历", () => {
  it("标题「M 月」，右上角写「还剩 N 个工作日」（本月从今天到月底），没有「本月」「本周」字样", () => {
    const html = render();
    expect(html).toMatch(/<h2>10 月<\/h2>/);
    expect(text(html)).toContain("还剩 7 个工作日");
    expect(text(html)).not.toMatch(/本月还剩|本周/);
  });

  it("7 列周一起：表头一到日，1 号从它是星期几那一列开始（2026-10-01 是周四）", () => {
    const html = render();
    expect(text(html).startsWith("10 月 还剩 7 个工作日 一 二 三 四 五 六 日")).toBe(true);
    expect(dayTag(html, "2026-10-01")).toContain("grid-column-start:4");
    expect(dayTag(html, "2026-10-02")).not.toContain("grid-column-start");
    expect(html.match(/<li[^>]*data-day=/g)).toHaveLength(31);
  });

  it("每格带今天 / 过去 / 未到、是否工作日（调休上班日是工作日）", () => {
    const html = render();
    expect(dayTag(html, "2026-10-22")).toContain('data-state="today"');
    expect(dayTag(html, "2026-10-21")).toContain('data-state="past"');
    expect(dayTag(html, "2026-10-24")).toContain('data-state="future"');
    expect(dayTag(html, "2026-10-24")).toContain('data-workday="false"');
    expect(dayTag(html, "2026-10-10")).toContain('data-workday="true"');
    expect(dayTag(html, "2026-10-22")).toMatch(/aria-label="10月22日 今天 工作日"/);
  });

  it("本周那一行（周一到周日）标出来，两头记 first / last", () => {
    const html = render();
    const week = october.filter((day) => dayTag(html, day.date).includes("data-week=")).map((day) => day.date.slice(8));
    expect(week).toEqual(["19", "20", "21", "22", "23", "24", "25"]);
    expect(dayTag(html, "2026-10-19")).toContain('data-week="first"');
    expect(dayTag(html, "2026-10-22")).toContain('data-week="mid"');
    expect(dayTag(html, "2026-10-25")).toContain('data-week="last"');
  });

  it("本周跨到下个月：只标本月里的那几天", () => {
    const html = render({ today: "2026-10-30", weekStart: "2026-10-26", weekEnd: "2026-11-01" });
    expect(october.filter((day) => dayTag(html, day.date).includes("data-week=")).map((day) => day.date.slice(8))).toEqual(["26", "27", "28", "29", "30", "31"]);
    expect(dayTag(html, "2026-10-31")).toContain('data-week="last"');
  });

  it("翻到别的月份（current=false）：不标本周、不写还剩几个工作日", () => {
    const html = render({ current: false });
    expect(html).not.toContain("data-week");
    expect(text(html)).not.toContain("还剩");
  });

  it("翻月：标题右边一对箭头，点了交出 -1 / 1；不是今年的标题写年；不传 onMonth 不出箭头", () => {
    const onMonth = vi.fn();
    render({ onMonth });
    (find((props) => props["aria-label"] === "上个月")!.onClick as () => void)();
    (find((props) => props["aria-label"] === "下个月")!.onClick as () => void)();
    expect(onMonth.mock.calls).toEqual([[-1], [1]]);
    expect(text(render({ period: "2027-01", current: false }))).toContain("2027 年 1 月");
    expect(text(render())).toMatch(/^10 月 还剩/);
    expect(find((props) => props["aria-label"] === "下个月")).toBeUndefined();
  });

  it("关口是小菱形（只读、不是按钮），节点是空心圆按钮；颜色是 Mission 色，名字在 title 和读屏文字里", () => {
    const html = render();
    expect(dayBlock(html, "2026-10-28")).toMatch(/<span[^>]*data-kind="gate"[^>]*role="img"[^>]*aria-label="关口 10\/28 上线"[^>]*style="--c:#2f63b0"/);
    expect(dayBlock(html, "2026-10-28")).toMatch(/<button[^>]*data-kind="mark"[^>]*data-mark="k2"[^>]*aria-label="节点 10\/28 复盘"[^>]*style="--c:#2f8a7a"/);
    const gate = find((props) => props["data-kind"] === "gate")!;
    expect(gate.onClick).toBeUndefined();
    expect(Object.keys(gate).filter((key) => key.startsWith("onPointer"))).toEqual([]);
  });

  it("聚焦某个 Mission 时，其他 Mission 的关口和节点淡掉", () => {
    const html = render({ focus: "m1" });
    expect(dayBlock(html, "2026-10-12")).toMatch(/data-kind="gate"[^>]*data-dim="true"/);
    expect(dayBlock(html, "2026-10-28")).toMatch(/data-kind="gate"(?![^>]*data-dim)/);
    expect(dayBlock(html, "2026-10-28")).toMatch(/data-mark="k2"[^>]*data-dim="true"/);
    expect(render({ focus: null })).not.toContain("data-dim");
  });

  it("点日期看这一天：每格一个铺满格子的按钮，按下交出那一天", () => {
    const onPickDay = vi.fn();
    render({ onPickDay });
    const hit = find((props) => props["aria-label"] === "看 10月26日")!;
    (hit.onClick as () => void)();
    expect(onPickDay).toHaveBeenCalledWith("2026-10-26");
    expect(render({ onPickDay: undefined })).not.toContain("看 10月");
  });

  it("点节点交出它的 id（改名或删）；没有拖动；没传回调时点不了", () => {
    const onEditMark = vi.fn();
    render({ onEditMark });
    const mark = find((props) => props["data-mark"] === "k1")!;
    expect(mark.disabled).toBe(false);
    (mark.onClick as () => void)();
    expect(onEditMark).toHaveBeenCalledWith("k1");
    expect(Object.keys(mark).filter((key) => /^on(Pointer|ContextMenu|Drag)/.test(key))).toEqual([]);
    render({ onEditMark: undefined });
    expect(find((props) => props["data-mark"] === "k1")!.disabled).toBe(true);
  });
});
