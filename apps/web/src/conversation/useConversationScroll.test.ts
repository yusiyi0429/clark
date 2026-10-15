import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 钩子只负责把 React 的时机接到滚动控制器（行为本身在 scrollController.test.ts 里验）：
 * 回答开始的那一刻置顶一次（乐观消息被服务端版本替换、进行中的重绘都不再重复）、回答结束收留白、
 * 换频道落底、从气泡打开定位一次、三个 ref 接到控制器、点 ↓ 交给控制器、↓ 的显隐来自控制器。
 */
const h = vi.hoisted(() => ({
  refs: [] as { current: unknown }[], refIndex: 0,
  states: [] as unknown[], stateIndex: 0,
  effects: [] as (readonly unknown[] | undefined)[], effectIndex: 0, queued: [] as (() => unknown)[],
  options: null as Record<string, unknown> | null,
  controller: {
    send: vi.fn(), streamEnd: vi.fn(), reset: vi.fn(), jump: vi.fn(), anchorReply: vi.fn(), stop: vi.fn(), reveal: vi.fn(),
    attachScroller: vi.fn(), attachContent: vi.fn(), attachReserve: vi.fn(),
  },
}));
vi.mock("react", () => {
  const effect = (run: () => unknown, deps?: readonly unknown[]) => {
    const index = h.effectIndex++, previous = h.effects[index];
    if (!previous || !deps || deps.some((value, offset) => !Object.is(value, previous[offset]))) { h.effects[index] = deps; h.queued.push(run); }
  };
  return {
    useRef: (initial: unknown) => h.refs[h.refIndex++] ??= { current: initial },
    useState: (initial: unknown) => {
      const index = h.stateIndex++;
      if (!(index in h.states)) h.states[index] = initial;
      return [h.states[index], (value: unknown) => { h.states[index] = value; }];
    },
    useCallback: (callback: unknown) => callback,
    useEffect: effect,
    useLayoutEffect: effect,
  };
});
vi.mock("./scrollController", () => ({
  createScrollController: (options: Record<string, unknown>) => { h.options = options; return h.controller; },
}));

import { useConversationScroll } from "./useConversationScroll";

function render(props: Parameters<typeof useConversationScroll>[0]) {
  h.refIndex = 0; h.stateIndex = 0; h.effectIndex = 0; h.queued = [];
  const view = useConversationScroll(props);
  h.queued.forEach((effect) => effect());
  return view;
}

beforeEach(() => {
  h.refs = []; h.states = []; h.effects = []; h.options = null;
  Object.values(h.controller).forEach((fn) => fn.mockClear());
});

describe("对话区滚动钩子", () => {
  it("打开时交给控制器默认落底跟随；在底部时不出 ↓", () => {
    const view = render({ streaming: false });
    expect(h.options).toMatchObject({ anchor: "end" });
    expect(view.atBottom).toBe(true);
    expect(h.controller.send).not.toHaveBeenCalled();
    expect(h.controller.anchorReply).not.toHaveBeenCalled();
  });

  it("回答开始的那一刻置顶一次；进行中的重绘（乐观消息被替换）不再重复；结束时收留白", () => {
    render({ streaming: false });
    render({ streaming: true });
    expect(h.controller.send).toHaveBeenCalledOnce();
    render({ streaming: true });
    render({ streaming: true });
    expect(h.controller.send).toHaveBeenCalledOnce();
    expect(h.controller.streamEnd).not.toHaveBeenCalled();
    render({ streaming: false });
    expect(h.controller.streamEnd).toHaveBeenCalledOnce();
    render({ streaming: true });
    expect(h.controller.send).toHaveBeenCalledTimes(2);
  });

  it("打开时已经在回答中：照旧落底，不补一次置顶", () => {
    render({ streaming: true });
    expect(h.controller.send).not.toHaveBeenCalled();
  });

  it("↓ 的显隐来自控制器；点 ↓ 交给控制器", () => {
    render({ streaming: true });
    (h.options!.onAtBottom as (value: boolean) => void)(false);
    const view = render({ streaming: true });
    expect(view.atBottom).toBe(false);
    view.jumpToLatest();
    expect(h.controller.jump).toHaveBeenCalledOnce();
  });

  it("换频道（resetKey 变了）落到底部", () => {
    render({ streaming: false, resetKey: "agent" });
    expect(h.controller.reset).not.toHaveBeenCalled();
    render({ streaming: false, resetKey: "group" });
    expect(h.controller.reset).toHaveBeenCalledOnce();
  });

  it("从气泡打开：只在打开时定位到最后一条回答一次", () => {
    render({ streaming: false, anchor: "reply" });
    expect(h.options).toMatchObject({ anchor: "reply" });
    expect(h.controller.anchorReply).toHaveBeenCalledOnce();
    render({ streaming: false, anchor: "reply" });
    expect(h.controller.anchorReply).toHaveBeenCalledOnce();
  });

  it("三个 ref 接到控制器，并保留 current 给划词引用用", () => {
    const view = render({ streaming: false });
    const scroller = {} as HTMLDivElement, content = {} as HTMLDivElement, reserve = {} as HTMLDivElement;
    view.scrollRef(scroller); view.contentRef(content); view.reserveRef(reserve);
    expect(h.controller.attachScroller).toHaveBeenCalledWith(scroller);
    expect(h.controller.attachContent).toHaveBeenCalledWith(content);
    expect(h.controller.attachReserve).toHaveBeenCalledWith(reserve);
    expect(view.scrollRef.current).toBe(scroller);
    expect(view.contentRef.current).toBe(content);
    view.scrollRef(null);
    expect(view.scrollRef.current).toBeNull();
    expect(render({ streaming: false }).scrollRef).toBe(view.scrollRef);
  });

  it("「待确认 N」把提案卡交给控制器滚过去", () => {
    const view = render({ streaming: false });
    const card = {} as HTMLElement;
    view.reveal(card);
    expect(h.controller.reveal).toHaveBeenCalledWith(card);
  });
});
