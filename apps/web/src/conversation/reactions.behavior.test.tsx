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

/** 右键、长按落在哪：第 part 块里（没给就是块外面）。 */
const at = (part?: number) => ({ preventDefault: vi.fn(),
  target: { closest: (selector: string) => (part === undefined || selector !== "[data-reaction-part]" ? null : { getAttribute: () => String(part) }) } });

describe("对一条消息的一块右键、长按", () => {
  const store = { of: () => [] as { part: number; emoji: string }[], toggle: vi.fn() };
  type View = ReactElement<{ open: boolean; onToggle: (emoji: string) => void }>;

  it("右键出快捷表情（不出浏览器的菜单），开的是点的那一块；选一个交给这一块", () => {
    hooks.context = store;
    const first = render(() => useMessageReaction(answer))!;
    expect(first.view(1, 3).props.open).toBe(false);
    const event = at(1);
    first.target.onContextMenu(event as never);
    expect(event.preventDefault).toHaveBeenCalled();
    const opened = render(() => useMessageReaction(answer))!;
    expect((opened.view(1, 3) as View).props.open).toBe(true);
    expect((opened.view(0, 3) as View).props.open).toBe(false);
    (opened.view(1, 3) as View).props.onToggle("👍");
    expect(store.toggle).toHaveBeenCalledWith(answer, 1, 3, "👍");
  });

  it("块外面（老页面整条一块、本人那句）右键开最后一块", () => {
    hooks.context = store;
    render(() => useMessageReaction(answer))!.target.onContextMenu(at() as never);
    const opened = render(() => useMessageReaction(answer))!;
    expect((opened.view(2, 3) as View).props.open).toBe(true);
    expect((opened.view(0, 1) as View).props.open).toBe(true);
    expect((opened.view(0, 3) as View).props.open).toBe(false);
  });

  it("选了字的右键照浏览器的（复制）", () => {
    hooks.context = store;
    vi.stubGlobal("window", { getSelection: () => ({ toString: () => "一段字" }) });
    const event = at(0);
    render(() => useMessageReaction(answer))!.target.onContextMenu(event as never);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect((render(() => useMessageReaction(answer))!.view(0, 1) as View).props.open).toBe(false);
  });

  it("手机上长按半秒出那一块的；中途松手或滑动不出", () => {
    vi.useFakeTimers();
    hooks.context = store;
    const first = render(() => useMessageReaction(answer))!;
    first.target.onTouchStart(at(0) as never);
    vi.advanceTimersByTime(200);
    first.target.onTouchMove();
    vi.advanceTimersByTime(1000);
    expect((render(() => useMessageReaction(answer))!.view(0, 2) as View).props.open).toBe(false);
    first.target.onTouchStart(at(0) as never);
    vi.advanceTimersByTime(500);
    expect((render(() => useMessageReaction(answer))!.view(0, 2) as View).props.open).toBe(true);
  });

  it("没有回应的地方、还没写进历史的那条不出", () => {
    expect(render(() => useMessageReaction(answer))).toBeNull();
    hooks.context = store;
    expect(render(() => useMessageReaction({ ...answer, runId: undefined }))).toBeNull();
    expect(render(() => useMessageReaction(null))).toBeNull();
  });
});

describe("本人挂的表情存进天枢（每块一个）", () => {
  const put = (part: number, emoji: string | null, runId = "run-1") =>
    ["/api/conversations/{scope}/reactions", { params: { path: { scope: "global" } }, body: { runId, role: "assistant", part, emoji } }];

  it("两块各点各的；同一块点同一个取消、点另一个换掉：先在这一页改，按 runId + role + 块存", async () => {
    api.put.mockResolvedValue({ data: {}, error: undefined });
    render(() => useReactionStore("global")).toggle(answer, 0, 2, "👍");
    render(() => useReactionStore("global")).toggle(answer, 1, 2, "❤️");
    expect(render(() => useReactionStore("global")).of(answer)).toEqual([{ part: 0, emoji: "👍" }, { part: 1, emoji: "❤️" }]);
    expect(api.put.mock.calls).toEqual([put(0, "👍"), put(1, "❤️")]);
    render(() => useReactionStore("global")).toggle(answer, 0, 2, "😂");
    expect(api.put).toHaveBeenLastCalledWith(...put(0, "😂"));
    render(() => useReactionStore("global")).toggle(answer, 1, 2, "❤️");
    expect(api.put).toHaveBeenLastCalledWith(...put(1, null));
    expect(render(() => useReactionStore("global")).of(answer)).toEqual([{ part: 0, emoji: "😂" }]);
    // 读回的历史带着的表情是起点；老数据（-1）在最后一块上点改的是它。
    const old: Message = { ...answer, runId: "run-2", reactions: [{ part: -1, emoji: "🎉" }] };
    expect(render(() => useReactionStore("global")).of(old)).toEqual([{ part: -1, emoji: "🎉" }]);
    render(() => useReactionStore("global")).toggle(old, 1, 2, "👍");
    expect(api.put).toHaveBeenLastCalledWith(...put(-1, "👍", "run-2"));
    expect(render(() => useReactionStore("global")).of(old)).toEqual([{ part: -1, emoji: "👍" }]);
  });

  it("存不上改回去，说一声", async () => {
    api.put.mockResolvedValue({ data: undefined, error: { code: "X" } });
    const message: Message = { ...answer, reactions: [{ part: 0, emoji: "❤️" }] };
    render(() => useReactionStore("project:p1")).toggle(message, 1, 2, "👍");
    expect(render(() => useReactionStore("project:p1")).of(message)).toEqual([{ part: 0, emoji: "❤️" }, { part: 1, emoji: "👍" }]);
    await flush();
    expect(render(() => useReactionStore("project:p1")).of(message)).toEqual([{ part: 0, emoji: "❤️" }]);
    expect(toast).toHaveBeenCalledWith({ text: "表情没存上" });
  });
});
