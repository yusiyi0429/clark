import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { components } from "@/lib/api/schema";

const hooks = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, effects: [] as (() => void | (() => void))[],
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }];
  },
  useRef(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = { current: initial };
    return hooks.values[index];
  },
  useCallback(callback: unknown) { return callback; },
  useEffect(effect: () => void | (() => void)) { hooks.effects.push(effect); },
}));
const api = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock("react", () => hooks);
vi.mock("@/lib/api/client", () => ({ browserApi: api }));

import { useOnboardingData } from "./useOnboardingData";

const initial: components["schemas"]["OnboardingResponse"] = {
  role: "ceo", displayName: "测试", companyName: null,
  voiceprint: { configured: false, enrolled: false, updatedAt: null },
  radar: { configured: false, enabled: true, directions: 0 },
  company: { sixMonthGoal: "", battlefields: [], capabilities: [], people: [] },
  next: { text: "3 条意见待你处理", action: "查看 10 月任务卡", href: "/mission-cards/first" },
};
const latest = { ...initial, next: { text: "意见已全部处理，待你确认", action: "查看 10 月任务卡", href: "/mission-cards/first" } };
const cleanups: (() => void)[] = [];
function render() { hooks.index = 0; hooks.effects = []; return useOnboardingData(initial); }
function mount() { const state = render(); hooks.effects.forEach((effect) => { const cleanup = effect(); if (cleanup) cleanups.push(cleanup); }); return state; }

beforeEach(() => {
  vi.useFakeTimers(); vi.clearAllMocks(); hooks.values = [];
  vi.stubGlobal("window", Object.assign(new EventTarget(), { setInterval, clearInterval }));
  vi.stubGlobal("document", Object.assign(new EventTarget(), { visibilityState: "visible" }));
  api.GET.mockResolvedValue({ data: latest, response: { ok: true } });
});
afterEach(() => { cleanups.splice(0).forEach((cleanup) => cleanup()); vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("长留引导的轮次状态", () => {
  it("每 20 秒重新读取快照与下一件事，离开时移除计时和焦点监听", async () => {
    mount();
    expect(api.GET).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.GET).toHaveBeenCalledExactlyOnceWith("/api/me/onboarding");
    expect(render().data.next).toEqual(latest.next);
    cleanups.splice(0).forEach((cleanup) => cleanup());
    await vi.advanceTimersByTimeAsync(20_000);
    window.dispatchEvent(new Event("focus"));
    expect(api.GET).toHaveBeenCalledTimes(1);
  });
  it("隐藏时不轮询，返回前台马上对表；截止回调也能调用同一个刷新", async () => {
    const state = mount();
    Object.defineProperty(document, "visibilityState", { value: "hidden", configurable: true });
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.GET).not.toHaveBeenCalled();
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
    await vi.advanceTimersByTimeAsync(0);
    expect(render().data.next).toEqual(latest.next);
    await state.refresh();
    expect(api.GET).toHaveBeenCalledTimes(2);
  });
  it("断网或失败响应保留快照与下一件事，恢复后去掉连接提示", async () => {
    const state = mount();
    api.GET.mockRejectedValueOnce(new TypeError("Failed to fetch"));
    await expect(state.refresh()).resolves.toBeUndefined();
    expect(render().data).toEqual(initial);
    expect(render().refreshError).toContain("已保留当前内容");
    api.GET.mockResolvedValueOnce({ response: { ok: false } });
    await state.refresh();
    expect(render().data).toEqual(initial);
    await state.refresh();
    expect(render().data).toEqual(latest);
    expect(render().refreshError).toBeNull();
  });
  it("同时收到轮询、焦点与截止时只发一个请求", async () => {
    let resolve!: (value: unknown) => void;
    api.GET.mockImplementation(() => new Promise((done) => { resolve = done; }));
    const state = mount();
    const pending = state.refresh();
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.GET).toHaveBeenCalledTimes(1);
    resolve({ data: latest, response: { ok: true } });
    await pending;
    expect(render().data).toEqual(latest);
  });
});
