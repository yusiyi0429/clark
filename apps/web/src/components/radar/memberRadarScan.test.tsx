import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { isValidElement, type ReactElement, type ReactNode } from "react";

// 「刷新」与轮询：直接调用页面组件，保留真实的扫描与轮询逻辑，只代替状态、ref 与 effect。
const hooks = vi.hoisted(() => {
  let slots: unknown[] = [];
  let cursor = 0;
  let effects: (() => void | (() => void))[] = [];
  return {
    get effects() { return effects; },
    begin() { cursor = 0; effects = []; },
    reset() { slots = []; cursor = 0; effects = []; },
    useState<T>(initial: T | (() => T)) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = typeof initial === "function" ? (initial as () => T)() : initial;
      return [slots[index] as T, (value: T | ((previous: T) => T)) => {
        slots[index] = typeof value === "function" ? (value as (previous: T) => T)(slots[index] as T) : value;
      }] as const;
    },
    useRef<T>(initial: T) {
      const index = cursor++;
      if (!(index in slots)) slots[index] = { current: initial };
      return slots[index] as { current: T };
    },
    useEffect(effect: () => void | (() => void)) { effects.push(effect); },
  };
});
vi.mock("react", async (original) => ({
  ...(await original<typeof import("react")>()),
  useState: hooks.useState,
  useRef: hooks.useRef,
  useEffect: hooks.useEffect,
  useMemo: (factory: () => unknown) => factory(),
}));
const router = vi.hoisted(() => ({ refresh: vi.fn() }));
vi.mock("next/navigation", () => ({ useRouter: () => router }));
vi.mock("@/components/shell/WorkspaceContext", () => ({ useWorkspace: () => ({ navigate: vi.fn(), close: vi.fn() }), useRegisterDetail: vi.fn() }));
const api = vi.hoisted(() => ({ GET: vi.fn(), POST: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ browserApi: api }));

import { MemberRadarScreen } from "./MemberRadarScreen";
import { DetailHeader } from "@/components/shell/DetailHeader";
import type { MyRadar } from "./personalRadar";

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode), ...elements(element.props.actions as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement(node) ? text((node as Element).props.children as ReactNode) : "";
}

const completed = { trigger: "manual" as const, status: "completed" as const, completedAt: "2026-09-27T01:00:00.000Z", createdSignals: 2, warnings: [] };
const radar: MyRadar = {
  enabled: true, directions: [{ id: "d_1", text: "Agent 的定价方式" }], sources: [], updatedAt: "2026-09-26T02:00:00.000Z",
  lastRun: { ...completed, trigger: "scheduled", createdSignals: 0 }, unreadCount: 0, webSearch: true, suggestions: { directions: [], sources: [] },
};
function render() {
  hooks.begin();
  return MemberRadarScreen({ radar, signals: [] });
}
const refreshButton = (tree: ReactNode) => elements(tree).find((element) => element.props["aria-label"] === "刷新我的雷达");
const status = (tree: ReactNode) => text(elements(tree).find((element) => element.props.role === "status")?.props.children as ReactNode);
/** 跑这一轮渲染登记的 effect（第 2 个是轮询）。 */
const runEffect = (index: number) => hooks.effects[index]();

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  vi.stubGlobal("window", { setInterval, clearInterval, addEventListener: vi.fn(), removeEventListener: vi.fn(), location: { assign: vi.fn(), pathname: "/me/radar", search: "" } });
});
afterEach(() => {
  hooks.reset();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("我的雷达的「刷新」", () => {
  it("202 后每 5 秒看一次进度，扫完才刷新页面", async () => {
    api.POST.mockResolvedValue({ response: { status: 202 } });
    const tree = render();
    expect(elements(tree).some((element) => element.type === DetailHeader)).toBe(true);
    await (refreshButton(tree)!.props.onPress as () => Promise<void>)();
    expect(api.POST).toHaveBeenCalledExactlyOnceWith("/api/me/radar/scan");
    const scanning = render();
    expect(status(scanning)).toBe("正在扫描外部信息");
    expect(elements(scanning).find((element) => element.props["aria-label"] === "正在扫描")?.props.isDisabled).toBe(true);
    const stop = runEffect(1);
    api.GET.mockResolvedValueOnce({ data: { ...radar, lastRun: { ...completed, status: "running" } }, response: { status: 200 } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(api.GET).toHaveBeenCalledWith("/api/me/radar");
    expect(router.refresh).not.toHaveBeenCalled();
    api.GET.mockResolvedValueOnce({ data: { ...radar, lastRun: completed }, response: { status: 200 } });
    await vi.advanceTimersByTimeAsync(5_000);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    expect(status(render())).not.toBe("正在扫描外部信息");
    if (typeof stop === "function") stop();
  });

  it("最多等 3 分钟：还没扫完也停下并刷新一次，不再无限轮询", async () => {
    api.POST.mockResolvedValue({ response: { status: 202 } });
    await (refreshButton(render())!.props.onPress as () => Promise<void>)();
    render();
    runEffect(1);
    api.GET.mockResolvedValue({ data: { ...radar, lastRun: { ...completed, status: "running", startedAt: "2026-09-27T01:00:00.000Z" } }, response: { status: 200 } });
    await vi.advanceTimersByTimeAsync(180_000);
    expect(router.refresh).toHaveBeenCalledTimes(1);
    const calls = api.GET.mock.calls.length;
    await vi.advanceTimersByTimeAsync(20_000);
    expect(api.GET.mock.calls.length).toBe(calls);
  });

  it("429／409 原样写服务端的话，不当成错误；已经在扫时直接接着看进度", async () => {
    api.POST.mockResolvedValueOnce({ response: { status: 429 }, error: { code: "RADAR_SCAN_RATE_LIMITED", message: "刚扫过，6 分钟后可以再扫一次" } });
    await (refreshButton(render())!.props.onPress as () => Promise<void>)();
    const limited = render();
    const note = elements(limited).find((element) => text(element.props.children as ReactNode) === "刚扫过，6 分钟后可以再扫一次");
    expect(note?.props.role).toBeUndefined();
    api.POST.mockResolvedValueOnce({ response: { status: 409 }, error: { code: "RADAR_SCAN_IN_PROGRESS", message: "正在扫描，稍等片刻" } });
    await (refreshButton(limited)!.props.onPress as () => Promise<void>)();
    expect(status(render())).toBe("正在扫描外部信息");
  });
});
