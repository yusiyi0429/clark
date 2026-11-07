import { beforeEach, describe, expect, it, vi } from "vitest";

/* 把飞书通知的 hook 当函数调用：useState 用按调用顺序存值的小仓库代替，useEffect 记下来手动跑（同 versionNote.behavior.test）。 */
const hooks = vi.hoisted(() => ({ values: [] as unknown[], index: 0, effects: [] as (() => void)[],
  useState(initial: unknown) {
    const index = hooks.index++;
    if (!(index in hooks.values)) hooks.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[index], (next: unknown) => {
      hooks.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[index]) : next;
    }];
  },
}));
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: hooks.useState,
  useCallback: (fn: unknown) => fn,
  useEffect: (fn: () => void) => { hooks.effects.push(fn); },
}));
vi.mock("@/lib/api/client", () => ({ browserApi: {} }));

import { budgetModeOf, useNotificationSettings, type NotifyApi } from "./usePreferences";

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const render = (api: NotifyApi) => { hooks.index = 0; hooks.effects = []; return useNotificationSettings(api); };

beforeEach(() => { hooks.values = []; });

describe("飞书通知开关（B 的 /api/me/notification-settings）", () => {
  it("读到之前是 null；读到以后是服务端的值", async () => {
    const api: NotifyApi = { read: vi.fn(async () => ({ feishu: true })), write: vi.fn() };
    expect(render(api).feishu).toBeNull();
    hooks.effects.forEach((run) => run());
    await flush();
    expect(render(api).feishu).toBe(true);
  });

  it("关掉：马上变成关；存上了就照服务端回的", async () => {
    const api: NotifyApi = { read: async () => ({ feishu: true }), write: vi.fn(async (next) => next) };
    render(api); hooks.effects.forEach((run) => run()); await flush();
    render(api).set(false);
    expect(render(api).feishu).toBe(false);
    await flush();
    expect(api.write).toHaveBeenCalledWith({ feishu: false });
    expect(render(api)).toMatchObject({ feishu: false, saveFailed: null });
  });

  it("没存上：回到原值，原处「失败 · 重试」（带原因）；重试再存一次", async () => {
    const write = vi.fn<NotifyApi["write"]>().mockRejectedValueOnce(new Error("403")).mockImplementation(async (next) => next);
    const api: NotifyApi = { read: async () => ({ feishu: true }), write };
    render(api); hooks.effects.forEach((run) => run()); await flush();
    render(api).set(false);
    await flush();
    const after = render(api);
    expect(after.feishu).toBe(true);
    expect(after.saveFailed?.reason).toBe("403");
    after.saveFailed!.retry();
    await flush();
    expect(write).toHaveBeenCalledTimes(2);
    expect(render(api)).toMatchObject({ feishu: false, saveFailed: null });
  });

  it("没读到：loadFailed 带原因和重试", async () => {
    const read = vi.fn<NotifyApi["read"]>().mockRejectedValueOnce(new Error("断网")).mockResolvedValue({ feishu: false });
    const api: NotifyApi = { read, write: vi.fn() };
    render(api); hooks.effects.forEach((run) => run()); await flush();
    const failed = render(api);
    expect(failed.loadFailed?.reason).toBe("断网");
    failed.loadFailed!.retry();
    await flush();
    expect(render(api)).toMatchObject({ feishu: false, loadFailed: null });
  });
});

describe("新 Task 默认的预算模式", () => {
  it("认得的三种原样，其余（没存过、旧值）是自动", () => {
    expect(["auto", "budget", "unlimited"].map(budgetModeOf)).toEqual(["auto", "budget", "unlimited"]);
    expect(budgetModeOf(null)).toBe("auto");
    expect(budgetModeOf("max")).toBe("auto");
  });
});
