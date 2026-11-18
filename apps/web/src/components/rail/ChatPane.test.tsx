import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ConversationData } from "@/conversation/useConversation";
import { createScrollController, SEND_PIN_MS, type ScrollControllerOptions } from "@/conversation/scrollController";

/**
 * 新首页两种对话（ChatColumn）发出后到底部、跟着往下长，像微信；别处（ChatPane：Task 页、对话页；子会话页、旧界面直接用钩子）照旧置顶。
 * 真的钩子把选项交给真的控制器：这里记下 ChatColumn / ChatPane 交出去的选项，再用同样的选项在一个假滚动区上把控制器走一遍。
 */
const seen = vi.hoisted(() => ({ options: [] as ScrollControllerOptions[] }));
vi.mock("@/conversation/scrollController", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/conversation/scrollController")>();
  return { ...actual, createScrollController: (options: ScrollControllerOptions) => { seen.options.push(options); return actual.createScrollController(options); } };
});
const conversation = vi.hoisted(() => ({ data: null as unknown }));
vi.mock("@/conversation/useConversation", () => ({ useConversation: () => conversation.data }));

import { ChatColumn, ChatPane } from "./ChatPane";
import { useConversationScroll } from "@/conversation/useConversationScroll";

const data = { scope: "global", streaming: false, messages: [], historyStatus: "ready", error: null } as unknown as ConversationData;
conversation.data = data;
const bare = { timeline: () => null, input: () => null };

/** 假滚动区：上留白 44、下留白 130，内容高度可变；最后一条是刚发的那条。 */
function fakeDom({ viewport = 600, height = 2000, sentTop = 1900 } = {}) {
  const pad = 44, bottom = 130;
  const listeners = new Map<string, (event: unknown) => void>();
  const reserve = { style: { height: "" } };
  const state = { height };
  const reserveHeight = () => parseFloat(reserve.style.height) || 0;
  let top = 0;
  const scroller = {
    clientHeight: viewport, offsetHeight: viewport, clientWidth: 360,
    get scrollHeight() { return pad + state.height + bottom + reserveHeight(); },
    get scrollTop() { return top; },
    set scrollTop(value: number) { top = Math.max(0, Math.min(value, this.scrollHeight - viewport)); },
    getBoundingClientRect: () => ({ top: 100, height: viewport }),
    addEventListener: (type: string, handler: (event: unknown) => void) => listeners.set(type, handler),
    removeEventListener: (type: string) => listeners.delete(type),
  };
  const content = {
    querySelectorAll: (selector: string) => (selector.includes('"user"') ? [{ getBoundingClientRect: () => ({ top: 100 + pad + sentTop - top, bottom: 100 + pad + sentTop - top + 60, height: 60 }) }] : []),
  };
  const fire = (type: string, event: unknown = {}) => listeners.get(type)?.(event);
  const userScroll = (to: number) => { fire("wheel", { deltaY: to - top }); scroller.scrollTop = to; fire("scroll"); };
  const end = () => pad + state.height + bottom - viewport;
  return { scroller, content, reserve, state, reserveHeight, fire, userScroll, end };
}

/** 用 ChatColumn / ChatPane 交出去的选项开一个真的控制器，接到假滚动区上。 */
function drive(options: ScrollControllerOptions, dom = fakeDom()) {
  const frames: (() => void)[] = [];
  let clock = 0;
  const onAtBottom = vi.fn();
  const controller = createScrollController({
    ...options, onAtBottom, reduced: () => false, inset: () => 44, now: () => clock, resizeObserver: null, resizeGate: null,
    raf: (callback) => { frames.push(callback); return frames.length; }, caf: () => { frames.length = 0; },
  });
  controller.attachContent(dom.content as unknown as HTMLElement);
  controller.attachReserve(dom.reserve as unknown as HTMLElement);
  controller.attachScroller(dom.scroller as unknown as HTMLElement);
  const runFrames = () => {
    for (let elapsed = 0; elapsed <= SEND_PIN_MS + 20 && frames.length; elapsed += 16) {
      clock += 16;
      frames.splice(0).forEach((callback) => callback());
    }
    dom.fire("scroll");
  };
  return { ...dom, controller, onAtBottom, runFrames, advance: (ms: number) => { clock += ms; } };
}

/** 渲染一次，拿到它交给控制器的选项（不含测试自己的 onAtBottom 等）。 */
function optionsOf(node: React.ReactElement) {
  seen.options = [];
  renderToStaticMarkup(node);
  expect(seen.options).toHaveLength(1);
  const { anchor, onSend } = seen.options[0];
  return { anchor, onSend };
}

beforeEach(() => { seen.options = []; });

describe("新首页对话发出后到底部（像微信）", () => {
  it("ChatColumn 发出后滚到最底，不留置顶留白", () => {
    const t = drive(optionsOf(<ChatColumn data={data} buddy={null} {...bare} />));
    t.state.height = 2060; // 刚发的那条出现
    t.controller.layout();
    t.controller.send();
    t.runFrames();
    expect(t.scroller.scrollTop).toBe(t.end());
    expect(t.reserveHeight()).toBe(0);
    expect(t.controller.mode()).toBe("follow");
    expect(t.controller.atBottom()).toBe(true);
  });

  it("回答进行中新内容到达时跟着底部；往上翻后不跟，出 ↓；点 ↓ 回到底部并接着跟", () => {
    const t = drive(optionsOf(<ChatColumn data={data} buddy={null} {...bare} />));
    t.advance(2000);
    t.controller.send();
    t.runFrames();
    // 新气泡、「•••」一点点长出来：视图贴着底部。
    t.state.height = 2100;
    t.controller.layout();
    expect(t.scroller.scrollTop).toBe(t.end());
    // 一整段到了（超过半屏）：滑过去，停在底部。
    t.state.height = 2500;
    t.controller.layout();
    t.runFrames();
    expect(t.scroller.scrollTop).toBe(t.end());
    // 往上翻：不再跟，↓ 出来。
    t.userScroll(1200);
    t.state.height = 2700;
    t.controller.layout();
    expect(t.scroller.scrollTop).toBe(1200);
    expect(t.onAtBottom).toHaveBeenLastCalledWith(false);
    // 点 ↓：回到底部，接着跟。
    t.controller.jump();
    t.runFrames();
    expect(t.scroller.scrollTop).toBe(t.end());
    expect(t.onAtBottom).toHaveBeenLastCalledWith(true);
    t.state.height = 2760;
    t.controller.layout();
    expect(t.scroller.scrollTop).toBe(t.end());
    // 一轮结束：还在底部，不跳。
    const before = t.scroller.scrollTop;
    t.controller.streamEnd();
    expect(t.scroller.scrollTop).toBe(before);
    expect(t.controller.mode()).toBe("follow");
  });

  it("别处（子会话页、旧界面）发出后仍置顶", () => {
    // ChatPane（Task 页、对话页）和直接用钩子的子会话页、旧界面：刚发的那条推到顶部留白之下，下面留白。
    const pane = optionsOf(<ChatPane buddy={null} {...bare} />);
    function Direct() { useConversationScroll({ streaming: false }); return null; }
    const direct = optionsOf(<Direct />);
    for (const options of [pane, direct]) {
      const t = drive(options);
      t.state.height = 2060;
      t.controller.layout();
      t.controller.send();
      t.runFrames();
      expect(t.controller.mode()).toBe("pinned");
      expect(t.scroller.scrollTop).toBe(1900);
      expect(t.reserveHeight()).toBeGreaterThan(0);
    }
  });
});
