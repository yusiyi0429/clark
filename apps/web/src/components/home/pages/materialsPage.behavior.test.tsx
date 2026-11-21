import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

// 不起浏览器：react 的几个钩子换成可重放的假实现（状态按位置存，副作用在 commit 时跑、unmount 时清），直接调页面函数拿到它返回的元素。
const hooks = vi.hoisted(() => {
  type Effect = { deps?: unknown[]; cleanup?: (() => void) | void; pending?: () => (() => void) | void };
  const state = { position: 0, values: [] as unknown[], effects: [] as Effect[] };
  const changed = (prev: unknown[] | undefined, next: unknown[] | undefined) => !prev || !next || next.some((value, index) => !Object.is(value, prev[index]));
  return {
    state,
    useState(initial: unknown) {
      const key = state.position++;
      if (!(key in state.values)) state.values[key] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [state.values[key], (next: unknown) => { state.values[key] = typeof next === "function" ? (next as (value: unknown) => unknown)(state.values[key]) : next; }];
    },
    useRef(initial: unknown) {
      const key = state.position++;
      if (!(key in state.values)) state.values[key] = { current: initial };
      return state.values[key];
    },
    useCallback(fn: unknown) { return fn; },
    useEffect(fn: () => (() => void) | void, deps?: unknown[]) {
      const key = state.position++;
      const effect = (state.effects[key] ??= {});
      if (!("ran" in effect) || changed(effect.deps, deps)) effect.pending = fn;
      effect.deps = deps;
      (effect as { ran?: boolean }).ran = true;
    },
    commit() {
      for (const effect of state.effects) {
        if (!effect?.pending) continue;
        effect.cleanup?.();
        effect.cleanup = effect.pending();
        effect.pending = undefined;
      }
    },
    unmount() { for (const effect of state.effects) effect?.cleanup?.(); },
    reset() { state.position = 0; state.values = []; state.effects = []; },
  };
});
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()),
  useState: hooks.useState, useRef: hooks.useRef, useCallback: hooks.useCallback, useEffect: hooks.useEffect }));
const api = vi.hoisted(() => ({ saveNote: vi.fn(), readMaterials: vi.fn(), listRoles: vi.fn() }));
vi.mock("@/lib/home/colleagueMaterials", async (original) => ({ ...(await original<typeof import("@/lib/home/colleagueMaterials")>()),
  readMaterials: api.readMaterials, saveNote: api.saveNote }));
vi.mock("@/lib/team/roles", async (original) => ({ ...(await original<typeof import("@/lib/team/roles")>()), listRoles: api.listRoles }));

import { MaterialsPage } from "./MaterialsPage";

type ViewProps = { note: string; onNote: (text: string) => void };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const render = () => { hooks.state.position = 0; const element = MaterialsPage({ go: () => undefined }) as ReactElement<ViewProps>; hooks.commit(); return element; };

describe("对外资料页：离开时补存说明", () => {
  beforeEach(() => {
    hooks.reset();
    api.saveNote.mockReset().mockResolvedValue({ note: "", noteUpdatedAt: null, files: [] });
    api.readMaterials.mockReset().mockResolvedValue({ note: "旧说明", noteUpdatedAt: null, files: [] });
    api.listRoles.mockReset().mockResolvedValue({ roles: [], presets: [] });
  });
  const loaded = async () => {
    render();
    await flush();
    const view = render();
    expect(view.props.note).toBe("旧说明");
    return view;
  };

  it("改了说明、没离开输入框就卸载（后退、锁屏）：带最新的字存一次", async () => {
    const view = await loaded();
    view.props.onNote("新说明");
    expect(render().props.note).toBe("新说明");
    hooks.unmount();
    expect(api.saveNote).toHaveBeenCalledTimes(1);
    expect(api.saveNote).toHaveBeenCalledWith("新说明");
  });

  it("没改过就卸载：不存", async () => {
    await loaded();
    hooks.unmount();
    expect(api.saveNote).not.toHaveBeenCalled();
  });
});
