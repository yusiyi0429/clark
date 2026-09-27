import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, callbacks: [] as ((...args: never[]) => unknown)[], effects: [] as (() => void | (() => void))[],
  useState(initial: unknown): [unknown, (next: unknown) => void] {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }];
  },
  useCallback(callback: (...args: never[]) => unknown) { hooks.callbacks.push(callback); return callback; },
  useRef(initial: unknown) { const [ref] = hooks.useState({ current: initial }); return ref; },
  useEffect(effect: () => void | (() => void)) { hooks.effects.push(effect); },
}));
const api = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock("react", () => hooks);
vi.mock("@/lib/api/client", () => ({ browserApi: api }));

import { useMemberHome } from "./useMemberHome";

function render() { hooks.index = 0; hooks.callbacks = []; return useMemberHome(); }
// The first callback is the same load function used by mount, the 20-second poll and settle.
function refresh() { return hooks.callbacks[0]() as Promise<void>; }
const task = { id: "task-01", title: "已载入的执行事项" };
const notification = { id: "notice-01", text: "已载入的通知" };
const work = { period: "2026-10", planStatus: "confirmed", battlefields: [{ id: "growth", monthTargetText: "已签发目标" }], missions: [], missionCards: [{ cardId: "mine", phase: "confirmed" }] };
function online() {
  api.GET.mockImplementation(async (path: string) => ({ response: { status: 200, ok: true }, data: path === "/api/me/home" ? { myTasks: [task], work } : path === "/api/me/mission-cards" ? { rounds: [{ roundId: "round-01", phase: "open" }] } : { notifications: [notification] } }));
}

beforeEach(() => { hooks.values = []; hooks.effects = []; vi.clearAllMocks(); vi.stubGlobal("window", { location: { assign: vi.fn() } }); });
afterEach(() => vi.unstubAllGlobals());

describe("常驻成员首页的网络恢复", () => {
  it("首页读取同一份本月工作，断网保留卡，恢复后使用服务端新内容", async () => {
    online(); expect(render().work).toBeNull(); await refresh();
    expect(render().work).toEqual(work);
    api.GET.mockRejectedValue(new TypeError("Failed to fetch"));
    await refresh(); expect(render().work).toEqual(work);
    online(); await refresh(); expect(render().work).toEqual(work);
  });
  it("首页HTTP失败区分加载失败与没有登记，重试成功后清除提示", async () => {
    api.GET.mockResolvedValue({ response: { status: 503, ok: false } });
    render(); await refresh(); expect(render().homeError).toContain("连接"); expect(render().work).toBeNull();
    online(); await refresh(); expect(render().homeError).toBeNull();
  });
  it("本人拍板后立即重取通知，等进行中的旧请求结束再取一次最新状态", async () => {
    const events = new EventTarget();
    vi.stubGlobal("window", { addEventListener: events.addEventListener.bind(events), removeEventListener: events.removeEventListener.bind(events), setInterval: vi.fn(), clearInterval: vi.fn() });
    vi.stubGlobal("document", { addEventListener: vi.fn(), removeEventListener: vi.fn(), visibilityState: "visible" });
    let release!: (value: unknown) => void;
    api.GET.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    render(); const cleanup = hooks.effects[0]();
    api.GET.mockResolvedValue({ response: { status: 200, ok: true }, data: { myTasks: [], notifications: [], rounds: [] } });
    events.dispatchEvent(new Event("mission-round-changed"));
    expect(api.GET).toHaveBeenCalledTimes(3);
    release({ response: { status: 200, ok: true }, data: { myTasks: [], notifications: [], rounds: [{ roundId: "round-01" }] } });
    await vi.waitFor(() => expect(api.GET).toHaveBeenCalledTimes(6));
    expect(render().rounds).toEqual([]);
    cleanup?.();
  });
  it("倒计时、轮询同时请求时共用一次读取，避免旧结果覆盖确认后的退组", async () => {
    let release!: (value: unknown) => void;
    api.GET.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    render();
    const first = refresh(); const second = refresh();
    expect(api.GET).toHaveBeenCalledTimes(3);
    release({ response: { status: 200, ok: true }, data: { myTasks: [], notifications: [], rounds: [] } });
    await Promise.all([first, second]);
  });
  it("通知加载未确认个人卡轮次，确认后的下一次投影可清退整组", async () => {
    online(); render(); await refresh();
    expect(render().rounds).toEqual([{ roundId: "round-01", phase: "open" }]);
    expect(api.GET).toHaveBeenCalledWith("/api/me/mission-cards");
    api.GET.mockImplementation(async (path: string) => ({ response: { status: 200, ok: true }, data: path === "/api/me/home" ? { myTasks: [task] } : path === "/api/me/mission-cards" ? { rounds: [] } : { notifications: [notification] } }));
    await refresh(); expect(render().rounds).toEqual([]);
  });

  it("首次载入断网时 load 自行处理失败，不向后台 effect 抛出未处理拒绝", async () => {
    api.GET.mockRejectedValue(new TypeError("Failed to fetch"));
    render();
    await expect(refresh()).resolves.toBeUndefined();
    const state = render();
    expect(state.tasks).toEqual([]); expect(state.notifications).toEqual([]);
    expect(state.taskError).toContain("连接");
    expect(state.taskError).not.toContain("Failed to fetch");
  });

  it("轮询断网保留已有事项与通知，恢复连接后自动去掉连接错误", async () => {
    online(); render(); await refresh();
    api.GET.mockRejectedValue(new TypeError("Failed to fetch"));
    render(); await expect(refresh()).resolves.toBeUndefined();
    const offline = render();
    expect(offline.tasks).toEqual([task]); expect(offline.notifications).toEqual([notification]);
    expect(offline.taskError).toContain("保留");
    online(); await refresh();
    const recovered = render();
    expect(recovered.tasks).toEqual([task]); expect(recovered.notifications).toEqual([notification]);
    expect(recovered.taskError).toBeNull();
  });
});
