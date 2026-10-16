import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { afterResize, beginResize, endResize, onResize, resizeWindow, resizing, SHEET_RESIZE_MS, SHEET_RESIZE_SETTLE_MS } from "./resizeGate";
import { createScrollController } from "./scrollController";
import { sameDockProps } from "./ConversationDock";
import type { ConversationData } from "./useConversation";

/**
 * 对话层放大 / 收起在 Agent 输出时不再卡（.superpowers/sdd/dock-animation-jank.md「修复」）：
 * 1. 过渡中正文不逐帧重排：滚动区一开始就是终态尺寸，只有外框在变；
 * 2. 过渡那 240ms 里流式上屏、思考追加、各处 ResizeObserver 都排着，结束一次补齐（resizeGate）；
 * 3. 平时也减负：输入条 memo（只看自己用到的那几项）。
 * 没有 jsdom：过渡窗口用假元素，滚动用假滚动区，样式读 CSS 文件。
 */
const css = (name: string) => readFileSync(new URL(`../styles/${name}`, import.meta.url), "utf8");

afterEach(() => {
  endResize();
  vi.useRealTimers();
});

describe("过渡窗口（resizeGate）", () => {
  it("过渡中排着的回调同一个只跑一次，结束时依次补上；不在过渡中立即执行", () => {
    const now = vi.fn();
    afterResize(now);
    expect(now).toHaveBeenCalledTimes(1);
    beginResize();
    expect(resizing()).toBe(true);
    const later = vi.fn(), other = vi.fn();
    afterResize(later); afterResize(later); afterResize(other);
    expect(later).not.toHaveBeenCalled();
    endResize();
    expect(resizing()).toBe(false);
    expect(later).toHaveBeenCalledTimes(1);
    expect(other).toHaveBeenCalledTimes(1);
    endResize();
    expect(later).toHaveBeenCalledTimes(1);
  });

  it("开始、结束各通知一次；退订后不再通知", () => {
    const start = vi.fn(), end = vi.fn();
    const off = onResize({ start, end });
    beginResize(); endResize();
    expect([start.mock.calls.length, end.mock.calls.length]).toEqual([1, 1]);
    off();
    beginResize(); endResize();
    expect([start.mock.calls.length, end.mock.calls.length]).toEqual([1, 1]);
  });

  it("对话层打上 data-resizing；外框宽高过渡结束就撤掉，子元素的过渡不算；没等到就兜底收尾", () => {
    vi.useFakeTimers();
    const attributes = new Map<string, string>();
    const listeners = new Map<string, (event: unknown) => void>();
    const element = {
      setAttribute: (name: string, value: string) => attributes.set(name, value),
      removeAttribute: (name: string) => attributes.delete(name),
      addEventListener: (type: string, handler: (event: unknown) => void) => listeners.set(type, handler),
      removeEventListener: (type: string) => listeners.delete(type),
    };
    resizeWindow(element as unknown as HTMLElement);
    expect(attributes.get("data-resizing")).toBe("true");
    expect(resizing()).toBe(true);
    listeners.get("transitionend")?.({ target: {}, propertyName: "background-color" });
    expect(resizing()).toBe(true);
    listeners.get("transitionend")?.({ target: element, propertyName: "width" });
    expect(resizing()).toBe(false);
    expect(attributes.has("data-resizing")).toBe(false);

    const finish = resizeWindow(element as unknown as HTMLElement);
    vi.advanceTimersByTime(SHEET_RESIZE_SETTLE_MS - 1);
    expect(resizing()).toBe(true);
    vi.advanceTimersByTime(1);
    expect(resizing()).toBe(false);
    finish();
    expect(resizing()).toBe(false);
  });
});

/** 假滚动区：内容高度可变，跟随模式下 layout 会追到底。 */
function fakeScroller() {
  const state = { height: 2000, width: 520, top: 0 };
  const scroller = {
    clientHeight: 600, offsetHeight: 600,
    get clientWidth() { return state.width; },
    get scrollHeight() { return state.height; },
    get scrollTop() { return state.top; },
    set scrollTop(value: number) { state.top = Math.max(0, Math.min(value, state.height - 600)); },
    getBoundingClientRect: () => ({ top: 0, height: 600 }),
    addEventListener: () => undefined, removeEventListener: () => undefined,
  };
  const content = { querySelectorAll: () => [] };
  return { state, scroller, content };
}

describe("滚动控制器在过渡里", () => {
  it("ResizeObserver 过渡中不做事；开始时按终态尺寸校正一次，结束再校正一次", () => {
    const dom = fakeScroller();
    let observed: (() => void) | null = null;
    class Observer { constructor(callback: () => void) { observed = callback; } observe() {} disconnect() {} }
    const controller = createScrollController({ resizeObserver: Observer, reduced: () => true, inset: () => 44 });
    controller.attachContent(dom.content as unknown as HTMLElement);
    controller.attachScroller(dom.scroller as unknown as HTMLElement);
    // 打开时跟随到底。
    expect(dom.state.top).toBe(1400);
    // 放大：滚动区一开始就是终态宽度（这里正文按新宽度排完变长了），开始时就按终值追到末尾。
    dom.state.width = 856; dom.state.height = 2300;
    beginResize();
    expect(dom.state.top).toBe(1700);
    // 过渡中尺寸又变（ResizeObserver 照样会报）：不逐帧追。
    dom.state.height = 2500;
    observed!();
    expect(dom.state.top).toBe(1700);
    // 结束：统一校正一次。
    endResize();
    expect(dom.state.top).toBe(1900);
    // 平时照常。
    dom.state.height = 2700;
    observed!();
    expect(dom.state.top).toBe(2100);
  });
});

describe("样式：外框过渡、滚动区定在终态", () => {
  const shell = css("app-shell.module.css");
  it("外框宽高仍是 240ms、同一条缓动、同样的终态尺寸", () => {
    expect(shell).toContain(".historySheet{transition:width 240ms cubic-bezier(.22,1,.36,1),height 240ms cubic-bezier(.22,1,.36,1)}");
    expect(SHEET_RESIZE_MS).toBe(240);
    expect(shell).toContain(".historySheet[data-wide]{width:min(58vw,calc(100vw - var(--shell-edge) * 2 - 360px));height:calc(100dvh - var(--shell-edge) - 14px)}");
    // 不在外框上改继承的自定义属性传终值（切换时整棵子树都要重算样式）。
    expect(shell).not.toContain("--sheet-w");
  });
  it("过渡中滚动区是终态尺寸（外框终态减去 1px 的边，不随外框逐帧变），毛玻璃与遮罩换实底", () => {
    expect(shell).toContain(".historySheet[data-resizing] .sheetScroll{flex:none;width:calc(min(592px,calc(100vw - var(--main-start) - var(--shell-edge))) - 2px);height:calc(100dvh - clamp(72px,10vh,136px) - 18px)}");
    expect(shell).toContain(".historySheet[data-resizing][data-wide] .sheetScroll{width:calc(min(58vw,calc(100vw - var(--shell-edge) * 2 - 360px)) - 2px);height:calc(100dvh - var(--shell-edge) - 16px)}");
    expect(shell).toContain(".historySheet[data-resizing]:not([data-wide]) .sheetScroll{width:calc(min(652px,calc(100vw - var(--main-start) - var(--shell-edge))) - 2px)}");
    expect(shell).toContain(".historySheet[data-resizing] .sheetFade{-webkit-backdrop-filter:none;backdrop-filter:none;-webkit-mask-image:none;mask-image:none}");
    expect(shell).toContain(".historySheet[data-resizing] .glassButton{background:#f8f9fb;-webkit-backdrop-filter:none;backdrop-filter:none}");
    expect(css("conversation-transcript.module.css")).toContain(":global([data-resizing]) .thinkingStream[data-clipped]{-webkit-mask-image:none;mask-image:none}");
  });
  it("减少动效：外框没有过渡，也不开过渡窗口", () => {
    expect(shell).toContain("@media(prefers-reduced-motion:reduce){.shell *{animation:none!important;transition:none!important;");
    const sheet = readFileSync(new URL("./ConversationHistorySheet.tsx", import.meta.url), "utf8");
    expect(sheet).toContain("if (!element || prefersReducedMotion()) return;");
    expect(sheet).toContain("return resizeWindow(element);");
  });
});

describe("输入条 memo", () => {
  const send = vi.fn(), stop = vi.fn(), uploadFiles = vi.fn(), removeAttachment = vi.fn(), onKeyboardChange = vi.fn();
  const base = { scope: "global", attachments: [], historyStatus: "ready", streaming: true, uploading: false, send, stop, uploadFiles, removeAttachment,
    partial: "首段", thought: null, progress: { label: null, checked: 0 }, messages: [] } as unknown as ConversationData;
  const props = (data: ConversationData, extra: Record<string, unknown> = {}) =>
    ({ data, label: "天枢", global: true, detail: false, keyboard: true, onKeyboardChange, historyOpen: true, references: [],
      onRemoveReference: vi.fn(), onClearReferences: vi.fn(), onRestoreReferences: vi.fn(), ...extra }) as Parameters<typeof sameDockProps>[0];
  it("流式中正文、思考、进度在变：输入条不重画", () => {
    const first = props(base);
    const next = { ...first, data: { ...base, partial: "首段次段", thought: { text: "先看", seconds: null }, progress: { label: "检索", checked: 1 } } as unknown as ConversationData };
    expect(sameDockProps(first, next)).toBe(true);
  });
  it("输入条用到的那几项、或别的属性变了：重画", () => {
    const first = props(base);
    expect(sameDockProps(first, { ...first, data: { ...base, streaming: false } as ConversationData })).toBe(false);
    expect(sameDockProps(first, { ...first, data: { ...base, attachments: [{ id: "a" }] } as unknown as ConversationData })).toBe(false);
    expect(sameDockProps(first, { ...first, keyboard: false })).toBe(false);
    expect(sameDockProps(first, { ...first, onKeyboardChange: vi.fn() })).toBe(false);
  });
});
