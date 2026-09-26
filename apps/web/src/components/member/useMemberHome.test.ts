import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const hooks = vi.hoisted(() => ({
  values: [] as unknown[], index: 0, callbacks: [] as ((...args: never[]) => unknown)[],
  useState(initial: unknown): [unknown, (next: unknown) => void] {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = initial;
    return [hooks.values[index], (next: unknown) => { hooks.values[index] = typeof next === "function" ? next(hooks.values[index]) : next; }];
  },
  useCallback(callback: (...args: never[]) => unknown) { hooks.callbacks.push(callback); return callback; },
  useEffect() {},
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
function online() {
  api.GET.mockImplementation(async (path: string) => ({ response: { status: 200, ok: true }, data: path === "/api/me/home" ? { myTasks: [task] } : { notifications: [notification] } }));
}

beforeEach(() => { hooks.values = []; vi.clearAllMocks(); vi.stubGlobal("window", { location: { assign: vi.fn() } }); });
afterEach(() => vi.unstubAllGlobals());

describe("常驻成员首页的网络恢复", () => {
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
