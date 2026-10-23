import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode } from "react";
import type { WorkspaceApi } from "./WorkspaceContext";
import type { ConversationUiState } from "@/conversation/ConversationHost";

/** 唤醒输入框在外壳里：展开当前页的输入条、把光标放进输入框；语音交给微信输入法。hook 桩同 workspaceQuotes.behavior.test.tsx。 */
const h = vi.hoisted(() => ({ pathname: "/", states: [] as unknown[], refs: [] as { current: unknown }[], dependencies: [] as (readonly unknown[] | undefined)[],
  stateIndex: 0, refIndex: 0, effectIndex: 0, queued: [] as (() => unknown)[], cleanups: [] as unknown[], dirty: false, ui: null as ConversationUiState | null,
  router: { push: vi.fn(), refresh: vi.fn() }, saveColumnMode: vi.fn(),
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useState: (initial: unknown) => {
    const index = h.stateIndex++;
    if (!(index in h.states)) h.states[index] = typeof initial === "function" ? initial() : initial;
    return [h.states[index], (update: unknown) => {
      const next = typeof update === "function" ? update(h.states[index]) : update;
      if (!Object.is(next, h.states[index])) h.dirty = true;
      h.states[index] = next;
    }];
  }, useRef: (initial: unknown) => h.refs[h.refIndex++] ??= { current: initial },
  useEffect: (effect: () => unknown, deps?: readonly unknown[]) => {
    const index = h.effectIndex++, previous = h.dependencies[index];
    if (!previous || !deps || deps.some((value, offset) => !Object.is(value, previous[offset]))) {
      // 依赖变了重跑前先清理上一次（window 上的按键监听不叠加）。
      h.dependencies[index] = deps; h.queued.push(() => {
        const cleanup = h.cleanups[index];
        if (typeof cleanup === "function") cleanup();
        h.cleanups[index] = effect();
      });
    }
  } };
});
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname, useRouter: () => h.router }));
vi.mock("@/components/onboarding/useHomeArrival", () => ({ useHomeArrival: () => false }));
vi.mock("@/conversation/references", () => ({ ReferenceProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/conversation/ConversationHost", () => ({ ConversationHost: ({ ui }: { ui: ConversationUiState }) => { h.ui = ui; return null; } }));
vi.mock("@/conversation/useColumnMode", async (importOriginal) => ({ ...(await importOriginal<typeof import("@/conversation/useColumnMode")>()), saveColumnMode: h.saveColumnMode }));
vi.mock("./NoticeStrip", () => ({ NoticeStrip: () => null }));
import { WorkspaceFrame } from "./WorkspaceFrame";
import { useWorkspace } from "./WorkspaceContext";

let api: WorkspaceApi;
function Capture() { api = useWorkspace(); return <h1>正文</h1>; }
type Listener = (event: unknown) => void;
const listeners = new Map<string, Set<Listener>>();
/** 输入条里的输入框（document.querySelector(COMPOSER_FIELD) 找到的那个）。 */
const field = { value: "还没发的话", focus: vi.fn(), setSelectionRange: vi.fn(), tagName: "TEXTAREA", closest: () => ({}) };
let modal = false;
let narrow = false;
beforeEach(() => {
  h.pathname = "/"; h.states = []; h.refs = []; h.dependencies = []; h.cleanups = []; vi.clearAllMocks(); listeners.clear(); modal = false; narrow = false;
  vi.stubGlobal("window", { matchMedia: () => ({ matches: narrow }), dispatchEvent: vi.fn(),
    addEventListener: (type: string, listener: Listener) => { if (!listeners.has(type)) listeners.set(type, new Set()); listeners.get(type)!.add(listener); },
    removeEventListener: (type: string, listener: Listener) => listeners.get(type)?.delete(listener) });
  vi.stubGlobal("document", { body: {}, activeElement: null, addEventListener: vi.fn(), removeEventListener: vi.fn(),
    querySelector: (selector: string) => (selector.includes("textarea") ? field : modal && selector.includes("alertdialog") ? {} : null) });
  vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64)" });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", vi.fn());
  vi.stubGlobal("HTMLElement", class {});
});
afterEach(() => vi.unstubAllGlobals());

function setup(homeHref: "/" | "/me" = "/") {
  const props: ComponentProps<typeof WorkspaceFrame> = { homeHref, viewerId: "sun", account: { displayName: "孙铭泽", role: homeHref === "/" ? "ceo" : "member" },
    home: null, notifications: () => null, agentTitle: "天枢", children: <Capture /> };
  const render = () => {
    for (let pass = 0; pass < 6; pass++) {
      h.stateIndex = 0; h.refIndex = 0; h.effectIndex = 0; h.dirty = false; h.queued = [];
      renderToStaticMarkup(<WorkspaceFrame {...props} />);
      h.queued.forEach((effect) => effect());
      if (!h.dirty) return;
    }
    throw new Error("Workspace did not settle");
  };
  render();
  const press = (patch: Record<string, unknown>) => {
    const event = { key: "", code: "", ctrlKey: false, shiftKey: false, altKey: false, metaKey: false, repeat: false, isComposing: false, keyCode: 0,
      defaultPrevented: false, preventDefault: vi.fn(), ...patch };
    for (const listener of [...(listeners.get("keydown") ?? [])]) listener(event);
    render();
    return event;
  };
  return { render, press };
}

const COMBO = { key: " ", code: "Space", ctrlKey: true, shiftKey: true, keyCode: 32 };
const CTRL_WIN = { key: "Meta", code: "MetaLeft", ctrlKey: true, metaKey: true, keyCode: 91 };

describe("唤醒输入框（外壳）", () => {
  it.each(["/", "/me"] as const)("首页（%s）按 Ctrl+Shift+Space：展开输入条、升起对话层，光标放进输入框末尾", (home) => {
    h.pathname = home;
    const { press } = setup(home);
    const event = press(COMBO);
    expect(event.preventDefault).toHaveBeenCalled();
    expect(h.ui!.keyboard).toBe(true);
    expect(h.ui!.historyOpen).toBe(true);
    expect(field.focus).toHaveBeenCalledWith({ preventScroll: true });
    expect(field.setSelectionRange).toHaveBeenCalledWith(field.value.length, field.value.length);
  });

  it("Windows 上按微信语音键 Ctrl+Win：同样展开并聚焦，但不挡默认行为（交给微信）", () => {
    const { press } = setup();
    const event = press(CTRL_WIN);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(h.ui!.historyOpen).toBe(true);
    expect(field.focus).toHaveBeenCalledOnce();
  });

  it("macOS 上 Control+Command 不算唤醒", () => {
    vi.stubGlobal("navigator", { userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)" });
    const { press } = setup();
    press(CTRL_WIN);
    expect(h.ui!.historyOpen).toBe(false);
    expect(field.focus).not.toHaveBeenCalled();
  });

  it("二级页有右列：展开右列（不改看全局对话），光标进右列输入条", () => {
    h.pathname = "/me/mission-cards/card-01";
    const { press, render } = setup("/me");
    api.registerDetail({ scope: "mission-card:card-01", label: "孙铭泽 · 10月任务", mark: null, cards: [] }); render();
    press({ key: "F13", code: "F13" });
    expect(h.saveColumnMode).toHaveBeenCalledWith("expanded");
    expect(h.ui!.historyOpen).toBe(false);
    expect(h.ui!.globalView).toBe(false);
    expect(field.focus).toHaveBeenCalledOnce();
  });

  it("窄屏二级页：打开右列对话浮层", () => {
    narrow = true;
    h.pathname = "/me/mission-cards/card-01";
    const { press } = setup("/me");
    press(COMBO);
    expect(h.ui!.railMobileOpen).toBe(true);
    expect(h.saveColumnMode).not.toHaveBeenCalled();
    expect(field.focus).toHaveBeenCalledOnce();
  });

  it("焦点在别的输入框里：不抢焦点、不挡按键，微信语音照常写进那个框", () => {
    const { press } = setup();
    Object.assign(document, { activeElement: { tagName: "TEXTAREA", isContentEditable: false, closest: () => null } });
    for (const keys of [COMBO, CTRL_WIN, { key: "F13", code: "F13" }]) {
      const event = press(keys);
      expect(event.preventDefault).not.toHaveBeenCalled();
    }
    expect(h.ui!.historyOpen).toBe(false);
    expect(field.focus).not.toHaveBeenCalled();
  });

  it("光标已在输入条里：什么都不动", () => {
    const { press } = setup();
    press(COMBO);
    vi.clearAllMocks();
    Object.assign(document, { activeElement: field });
    press(COMBO);
    expect(field.focus).not.toHaveBeenCalled();
    expect(h.ui!.historyOpen).toBe(true);
  });

  it("有模态对话框（确认框等）开着：不触发；关掉后照常", () => {
    modal = true;
    const { press } = setup();
    const event = press(COMBO);
    expect(event.preventDefault).not.toHaveBeenCalled();
    expect(h.ui!.historyOpen).toBe(false);
    modal = false;
    press(COMBO);
    expect(h.ui!.historyOpen).toBe(true);
  });

  it("组词中、按住不放的自动重复：不触发", () => {
    const { press } = setup();
    press({ ...COMBO, key: "Process", isComposing: true, keyCode: 229 });
    press({ ...CTRL_WIN, repeat: true });
    expect(h.ui!.historyOpen).toBe(false);
  });
});
