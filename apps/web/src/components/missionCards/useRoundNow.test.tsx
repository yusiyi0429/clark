import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
const ui = vi.hoisted(() => ({ hooks: [] as { subscribe: (listener: () => void) => () => void; snapshot: () => number }[], effects: [] as (() => void)[] }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useEffect: (effect: () => void) => ui.effects.push(effect), useSyncExternalStore: (subscribe: (listener: () => void) => () => void, snapshot: () => number, server: () => number) => { ui.hooks.push({ subscribe, snapshot }); return server(); } };
});
import { useRoundNow } from "./useRoundNow";
function ReadClock({ closesAt = "2026-10-03T00:00:30.000Z", serverNow = "2026-10-01T00:00:00.000Z", onDeadline }: { closesAt?: string | null; serverNow?: string; onDeadline?: () => void }) { return <span>{useRoundNow(closesAt, serverNow, onDeadline)}</span>; }
let cleanup: (() => void)[] = [];
beforeEach(() => { vi.useFakeTimers(); vi.setSystemTime(new Date("2026-01-01T00:00:00.000Z")); ui.hooks = []; ui.effects = []; vi.stubGlobal("window", new EventTarget()); vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" })); });
afterEach(() => { cleanup.forEach((fn) => fn()); cleanup = []; vi.useRealTimers(); vi.unstubAllGlobals(); });
describe("个人卡共享分钟时钟", () => {
  it("同一截止时刻只有一个定时器，用serverNow校正并对齐截止秒位", () => {
    renderToStaticMarkup(<><ReadClock /><ReadClock /></>);
    cleanup = ui.hooks.map((hook) => hook.subscribe(vi.fn()));
    ui.effects.forEach((effect) => effect());
    expect(vi.getTimerCount()).toBe(1);
    const initial = Date.parse("2026-10-01T00:00:00.000Z");
    expect(ui.hooks[0].snapshot()).toBe(initial);
    vi.advanceTimersByTime(30_019);
    expect(ui.hooks[0].snapshot()).toBe(initial);
    vi.advanceTimersByTime(1);
    expect(ui.hooks[0].snapshot()).toBe(initial + 30_020);
    expect(ui.hooks[1].snapshot()).toBe(initial + 30_020);
  });
  it("恢复前台立即对表，最后一个订阅离开才清定时器", () => {
    renderToStaticMarkup(<><ReadClock /><ReadClock /></>);
    cleanup = ui.hooks.map((hook) => hook.subscribe(vi.fn()));
    vi.setSystemTime(new Date("2026-01-01T00:05:00.000Z"));
    window.dispatchEvent(new Event("focus"));
    expect(ui.hooks[0].snapshot()).toBe(Date.parse("2026-10-01T00:05:00.000Z"));
    cleanup.shift()!(); expect(vi.getTimerCount()).toBe(1);
    cleanup.shift()!(); expect(vi.getTimerCount()).toBe(0);
  });
  it("未开放时不启动演示倒计时", () => {
    renderToStaticMarkup(<ReadClock closesAt={null} />);
    cleanup = ui.hooks.map((hook) => hook.subscribe(vi.fn()));
    expect(vi.getTimerCount()).toBe(0);
  });
  it("后来挂载的通知不能用旧投影把页头时钟拨回去", () => {
    renderToStaticMarkup(<ReadClock />);
    cleanup.push(ui.hooks[0].subscribe(vi.fn()));
    ui.effects.forEach((effect) => effect());
    vi.advanceTimersByTime(90_020);
    const before = ui.hooks[0].snapshot();
    ui.effects = [];
    renderToStaticMarkup(<ReadClock />);
    cleanup.push(ui.hooks[1].subscribe(vi.fn()));
    ui.effects.forEach((effect) => effect());
    expect(ui.hooks[0].snapshot()).toBe(before);
    expect(ui.hooks[1].snapshot()).toBe(before);
    expect(vi.getTimerCount()).toBe(1);
  });
  it("新投影立即对表，迟到的旧响应不能覆盖更新的服务端时间", () => {
    renderToStaticMarkup(<ReadClock serverNow="2026-10-01T01:00:00.000Z" />);
    cleanup.push(ui.hooks[0].subscribe(vi.fn()));
    ui.effects.forEach((effect) => effect());
    ui.effects = [];
    renderToStaticMarkup(<ReadClock />);
    cleanup.push(ui.hooks[1].subscribe(vi.fn()));
    ui.effects.forEach((effect) => effect());
    expect(ui.hooks[0].snapshot()).toBe(Date.parse("2026-10-01T01:00:00.000Z"));
    expect(ui.hooks[1].snapshot()).toBe(ui.hooks[0].snapshot());
  });
  it("两处跨过截止同一tick各自重新拉取，聚焦不重复触发截止", () => {
    const railRefresh = vi.fn(), headerRefresh = vi.fn();
    const deadline = "2026-10-01T00:00:30.000Z";
    renderToStaticMarkup(<><ReadClock closesAt={deadline} onDeadline={railRefresh} /><ReadClock closesAt={deadline} onDeadline={headerRefresh} /></>);
    cleanup = ui.hooks.map((hook) => hook.subscribe(vi.fn()));
    ui.effects.forEach((effect) => effect());
    vi.advanceTimersByTime(30_019);
    expect(railRefresh).not.toHaveBeenCalled(); expect(headerRefresh).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(railRefresh).toHaveBeenCalledTimes(1); expect(headerRefresh).toHaveBeenCalledTimes(1);
    expect(ui.hooks[0].snapshot()).toBe(ui.hooks[1].snapshot());
    window.dispatchEvent(new Event("focus"));
    vi.advanceTimersByTime(60_000);
    expect(railRefresh).toHaveBeenCalledTimes(1); expect(headerRefresh).toHaveBeenCalledTimes(1);
  });
});
