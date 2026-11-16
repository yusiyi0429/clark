import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ReactElement } from "react";

// 不起浏览器：把 react 的几个 hook 换成可重放的假实现，直接调生产代码里的 hook 和回调。
const hooks = vi.hoisted(() => ({
  position: 0, values: [] as unknown[], context: null as unknown,
  useState(initial: unknown) {
    const key = hooks.position++;
    if (!(key in hooks.values)) hooks.values[key] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[key], (next: unknown) => { hooks.values[key] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[key]) : next; }];
  },
  useRef(initial: unknown) {
    const key = hooks.position++;
    if (!(key in hooks.values)) hooks.values[key] = { current: initial };
    return hooks.values[key];
  },
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()),
  useState: hooks.useState, useRef: hooks.useRef, useMemo: (factory: () => unknown) => factory(), useContext: () => hooks.context,
}));
const api = vi.hoisted(() => ({ put: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ browserApi: { PUT: api.put } }));
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({ showWorkspaceToast: toast }));
import { useMessageReaction, useReactionStore } from "./Reactions";
import type { Message } from "./useConversation";

const answer: Message = { sequence: 2, role: "assistant", content: "好的", runId: "run-1" };
const render = <T,>(hook: () => T) => { hooks.position = 0; return hook(); };
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

beforeEach(() => {
  hooks.values = [];
  hooks.context = null;
  api.put.mockReset();
  toast.mockReset();
  vi.stubGlobal("window", { getSelection: () => ({ toString: () => "" }) });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("对一条消息右键、长按", () => {
  const store = { of: () => [] as string[], toggle: vi.fn() };
  type View = ReactElement<{ open: boolean; onToggle: (emoji: string) => void }>;

  it("右键出快捷表情（不出浏览器的菜单）；选一个交给这条消息", () => {
    hooks.context = store;
    const first = render(() => useMessageReaction(answer))!;
    expect(first.open).toBe(false);
    const event = { preventDefault: vi.fn() };
    first.target.onContextMenu(event as never);
    expect(event.preventDefault).toHaveBeenCalled();
    const opened = render(() => useMessageReaction(answer))!;
    expect(opened.open).toBe(true);
    (opened.view as View).props.onToggle("👍");
    expect(store.toggle).toHaveBeenCalledWith(answer, "👍");
  });

  it("选了字的右键照浏览器的（复制）", () => {
    hooks.context = store;
    vi.stubGlobal("window", { getSelection: () => ({ toString: () => "一段字" }) });
    const event = { preventDefault: vi.fn() };
    render(() => useMessageReaction(answer))!.target.onContextMenu(event as never);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(render(() => useMessageReaction(answer))!.open).toBe(false);
  });

  it("手机上长按半秒出；中途松手或滑动不出", () => {
    vi.useFakeTimers();
    hooks.context = store;
    const first = render(() => useMessageReaction(answer))!;
    first.target.onTouchStart();
    vi.advanceTimersByTime(200);
    first.target.onTouchMove();
    vi.advanceTimersByTime(1000);
    expect(render(() => useMessageReaction(answer))!.open).toBe(false);
    first.target.onTouchStart();
    vi.advanceTimersByTime(500);
    expect(render(() => useMessageReaction(answer))!.open).toBe(true);
  });

  it("没有回应的地方、还没写进历史的那条不出", () => {
    expect(render(() => useMessageReaction(answer))).toBeNull();
    hooks.context = store;
    expect(render(() => useMessageReaction({ ...answer, runId: undefined }))).toBeNull();
    expect(render(() => useMessageReaction(null))).toBeNull();
  });
});

describe("本人挂的表情存进天枢", () => {
  it("挂上、再点取消：先在这一页改，按 runId + role 整组存", async () => {
    api.put.mockResolvedValue({ data: {}, error: undefined });
    render(() => useReactionStore("global")).toggle(answer, "👍");
    expect(render(() => useReactionStore("global")).of(answer)).toEqual(["👍"]);
    expect(api.put).toHaveBeenLastCalledWith("/api/conversations/{scope}/reactions",
      { params: { path: { scope: "global" } }, body: { runId: "run-1", role: "assistant", emojis: ["👍"] } });
    render(() => useReactionStore("global")).toggle(answer, "👍");
    expect(render(() => useReactionStore("global")).of(answer)).toEqual([]);
    expect(api.put.mock.lastCall?.[1].body.emojis).toEqual([]);
    // 读回的历史带着的表情是起点。
    expect(render(() => useReactionStore("global")).of({ ...answer, runId: "run-2", reactions: ["🙏"] })).toEqual(["🙏"]);
  });

  it("存不上改回去，说一声", async () => {
    api.put.mockResolvedValue({ data: undefined, error: { code: "X" } });
    render(() => useReactionStore("project:p1")).toggle({ ...answer, reactions: ["❤️"] }, "👍");
    expect(render(() => useReactionStore("project:p1")).of({ ...answer, reactions: ["❤️"] })).toEqual(["❤️", "👍"]);
    await flush();
    expect(render(() => useReactionStore("project:p1")).of({ ...answer, reactions: ["❤️"] })).toEqual(["❤️"]);
    expect(toast).toHaveBeenCalledWith({ text: "表情没存上" });
  });
});
