import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { ConversationUiState } from "@/conversation/ConversationHost";

// 外壳持有深度讨论的开合：换页、打开对话层收起；Esc 先收深度讨论，再按原链路。
const harness = vi.hoisted(() => ({
  pathname: "/issues/issue-1", push: vi.fn(), refresh: vi.fn(),
  states: [] as unknown[], refs: [] as { current: unknown }[], deps: [] as (readonly unknown[] | undefined)[],
  stateIndex: 0, refIndex: 0, effectIndex: 0, queued: [] as (() => unknown)[], dirty: false,
  ui: null as ConversationUiState | null, keydown: null as ((event: KeyboardEvent) => void) | null, narrow: false,
  panelActive: null as boolean | null,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual,
    useState: (initial: unknown) => {
      const index = harness.stateIndex++;
      if (!(index in harness.states)) harness.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [harness.states[index], (update: unknown) => {
        const next = typeof update === "function" ? (update as (value: unknown) => unknown)(harness.states[index]) : update;
        if (!Object.is(next, harness.states[index])) harness.dirty = true;
        harness.states[index] = next;
      }];
    },
    useRef: (initial: unknown) => harness.refs[harness.refIndex++] ??= { current: initial },
    useEffect: (effect: () => unknown, deps?: readonly unknown[]) => {
      const index = harness.effectIndex++, previous = harness.deps[index];
      if (!previous || !deps || deps.some((value, offset) => !Object.is(value, previous[offset]))) {
        harness.deps[index] = deps; harness.queued.push(effect);
      }
    },
    useLayoutEffect: () => undefined,
  };
});
vi.mock("next/navigation", () => ({ usePathname: () => harness.pathname, useRouter: () => ({ push: harness.push, refresh: harness.refresh }) }));
vi.mock("@/components/onboarding/useHomeArrival", () => ({ useHomeArrival: () => false }));
vi.mock("@/conversation/references", () => ({ ReferenceProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/conversation/ConversationHost", () => ({ ConversationHost: ({ ui }: { ui: ConversationUiState }) => { harness.ui = ui; return null; } }));
vi.mock("@/conversation/CitationPanel", () => ({ CitationPanel: ({ active }: { active: boolean }) => { harness.panelActive = active; return null; } }));
vi.mock("./NoticeStrip", () => ({ NoticeStrip: () => null }));
vi.mock("./LoadingMask", () => ({ LoadingMask: () => null }));
vi.mock("@/components/whatsNew/WhatsNewCard", () => ({ WhatsNewCard: () => null }));

import { WorkspaceFrame } from "./WorkspaceFrame";
import { useWorkspace } from "./WorkspaceContext";
import type { WorkspaceApi } from "./WorkspaceContext";

let api: WorkspaceApi;
function Capture() { api = useWorkspace(); return <p>二级页</p>; }

beforeEach(() => {
  harness.pathname = "/issues/issue-1";
  harness.states = []; harness.refs = []; harness.deps = []; harness.ui = null; harness.keydown = null; harness.narrow = false;
  vi.clearAllMocks();
  const listen = (type: string, handler: (event: KeyboardEvent) => void) => { if (type === "keydown") harness.keydown = handler; };
  vi.stubGlobal("document", { body: {}, activeElement: null, querySelector: () => null, addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: harness.narrow }), addEventListener: listen, removeEventListener: vi.fn() });
  vi.stubGlobal("requestAnimationFrame", () => 0);
  vi.stubGlobal("cancelAnimationFrame", () => undefined);
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("HTMLElement", class {});
  vi.stubGlobal("Element", class {});
});
afterEach(() => vi.unstubAllGlobals());

function render() {
  for (let pass = 0; pass < 8; pass++) {
    harness.stateIndex = 0; harness.refIndex = 0; harness.effectIndex = 0; harness.queued = []; harness.dirty = false;
    renderToStaticMarkup(
      <WorkspaceFrame homeHref="/" viewerId="ceo" account={{ displayName: "CEO", role: "ceo" }} home={<p>首页</p>} notifications={() => null} agentTitle="天枢">
        <Capture />
      </WorkspaceFrame>,
    );
    harness.queued.forEach((effect) => effect());
    if (!harness.dirty) return harness.ui!;
  }
  throw new Error("WorkspaceFrame did not settle");
}

const escape = () => harness.keydown!({ key: "Escape", isComposing: false, defaultPrevented: false } as KeyboardEvent);

describe("外壳持有深度讨论", () => {
  it("⤢ 打开后在这一页保持；换页就收起，回到原页也不自己再展开", () => {
    expect(render().deskOpen).toBe(false);
    render().setDeskOpen!(true);
    expect(render().deskOpen).toBe(true);
    harness.pathname = "/meetings/meeting-1";
    expect(render().deskOpen).toBe(false);
    harness.pathname = "/issues/issue-1";
    expect(render().deskOpen).toBe(false);
  });

  it("打开对话层（全局对话 / 对话记录）就收起；关掉对话层不自己再展开", () => {
    render().setDeskOpen!(true);
    expect(render().deskOpen).toBe(true);
    render().setHistoryOpen(true);
    expect(render().deskOpen).toBe(false);
    render().setHistoryOpen(false);
    expect(render().deskOpen).toBe(false);
  });

  it("Esc：第一下只收深度讨论，第二下才离开二级页", () => {
    render().setDeskOpen!(true);
    render();
    escape();
    expect(render().deskOpen).toBe(false);
    expect(harness.push).not.toHaveBeenCalled();
    escape();
    render();
    expect(harness.push).toHaveBeenCalledWith("/");
  });

  it("Esc：宽屏上残留的窄屏浮层开关不占这一次，仍先收深度讨论", () => {
    render().setDeskOpen!(true);
    render().setRailMobileOpen(true);
    expect(render().deskOpen).toBe(true);
    escape();
    const ui = render();
    expect(ui.deskOpen).toBe(false);
    expect(ui.railMobileOpen).toBe(false);
    expect(harness.push).not.toHaveBeenCalled();
  });

  it("展开时左侧材料划词引用：引用进私聊输入条，深度讨论保持展开", () => {
    render().setDeskOpen!(true);
    render();
    api.quote("灯塔客户续约率 92%");
    const ui = render();
    expect(ui.prefill?.text).toBe("灯塔客户续约率 92%");
    expect(ui.historyOpen).toBe(false);
    expect(ui.deskOpen).toBe(true);
  });

  it("依据面板跟着放大走：右列深度讨论开着才可用，收起就一起收", () => {
    render();
    expect(harness.panelActive).toBe(false);
    render().setDeskOpen!(true);
    render();
    expect(harness.panelActive).toBe(true);
    escape();
    render();
    expect(harness.panelActive).toBe(false);
  });
});

describe("对话层放大（首页全局对话）", () => {
  beforeEach(() => { harness.pathname = "/"; });

  it("对话层开着才放大；Esc 先收放大、对话层还在，第二下才收对话层", () => {
    render().setSheetWide!(true);
    expect(render().sheetWide).toBe(false);
    render().setHistoryOpen(true);
    render().setSheetWide!(true);
    expect(render().sheetWide).toBe(true);
    expect(harness.panelActive).toBe(true);
    escape();
    let ui = render();
    expect(ui.sheetWide).toBe(false);
    expect(ui.historyOpen).toBe(true);
    expect(harness.panelActive).toBe(false);
    escape();
    ui = render();
    expect(ui.historyOpen).toBe(false);
  });

  it("收起对话层就收放大，再打开不自己放大；换页也收", () => {
    render().setHistoryOpen(true);
    render().setSheetWide!(true);
    expect(render().sheetWide).toBe(true);
    render().setHistoryOpen(false);
    expect(render().sheetWide).toBe(false);
    render().setHistoryOpen(true);
    expect(render().sheetWide).toBe(false);
    render().setSheetWide!(true);
    expect(render().sheetWide).toBe(true);
    harness.pathname = "/issues/issue-1";
    expect(render().sheetWide).toBe(false);
  });
});
