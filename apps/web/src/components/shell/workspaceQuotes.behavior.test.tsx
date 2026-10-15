import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode } from "react";
import type { WorkspaceApi } from "./WorkspaceContext";
import type { ConversationUiState } from "@/conversation/ConversationHost";

const h = vi.hoisted(() => ({ pathname: "/me/mission-cards/card-01", states: [] as unknown[], refs: [] as { current: unknown }[], dependencies: [] as (readonly unknown[] | undefined)[],
  stateIndex: 0, refIndex: 0, effectIndex: 0, queued: [] as (() => unknown)[], dirty: false, ui: null as ConversationUiState | null,
  router: { push: vi.fn(), refresh: vi.fn() },
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
      h.dependencies[index] = deps; h.queued.push(effect);
    }
  } };
});
vi.mock("next/navigation", () => ({ usePathname: () => h.pathname, useRouter: () => h.router }));
vi.mock("@/components/onboarding/useHomeArrival", () => ({ useHomeArrival: () => false }));
vi.mock("@/conversation/references", () => ({ ReferenceProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/conversation/ConversationHost", () => ({ ConversationHost: ({ ui }: { ui: ConversationUiState }) => { h.ui = ui; return null; } }));
vi.mock("./NoticeStrip", () => ({ NoticeStrip: () => null }));
import { WorkspaceFrame } from "./WorkspaceFrame";
import { useWorkspace } from "./WorkspaceContext";

let api: WorkspaceApi;
function Capture() { api = useWorkspace(); return <h1>任务正文</h1>; }
beforeEach(() => {
  h.pathname = "/me/mission-cards/card-01"; h.states = []; h.refs = []; h.dependencies = []; vi.clearAllMocks();
  vi.stubGlobal("window", { matchMedia: () => ({ matches: false }), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() });
  vi.stubGlobal("document", { body: {}, activeElement: null, addEventListener: vi.fn(), removeEventListener: vi.fn(), querySelector: () => null });
  vi.stubGlobal("localStorage", { getItem: () => null, setItem: vi.fn() });
  vi.stubGlobal("requestAnimationFrame", () => 1); vi.stubGlobal("cancelAnimationFrame", vi.fn());
});
afterEach(() => vi.unstubAllGlobals());
function setup() {
  const props: ComponentProps<typeof WorkspaceFrame> = { homeHref: "/me", viewerId: "sun", account: { displayName: "孙铭泽", role: "member" },
    home: null, notifications: () => null, agentTitle: "天枢", children: <Capture /> };
  const render = (effects = true) => {
    for (let pass = 0; pass < 6; pass++) {
      h.stateIndex = 0; h.refIndex = 0; h.effectIndex = 0; h.dirty = false; h.queued = [];
      renderToStaticMarkup(<WorkspaceFrame {...props} />);
      if (!effects) return;
      h.queued.forEach((effect) => effect());
      if (!h.dirty) return;
    }
    throw new Error("Workspace did not settle");
  };
  render(); api.registerDetail({ scope: "mission-card:card-01", label: "孙铭泽 · 10月任务", mark: null, cards: [] }); render();
  return { props, render };
}
describe("对象私聊引用草稿", () => {
  it("引用保留真实选文及来源，消费聚焦事件后引用仍保留", () => {
    const { render } = setup(); api.quote("选中的一句话", { label: "战役结果", missionId: "mission-01", field: "outcome", sourceVersion: 3 }); render();
    expect(h.ui!.quotes[0]).toMatchObject({ text: "选中的一句话", source: { scope: "mission-card:card-01", label: "战役结果", sourceVersion: 3 } });
    const nonce = h.ui!.prefill!.nonce; h.ui!.consumePrefill(nonce); render();
    expect(h.ui!.prefill).toBeNull(); expect(h.ui!.quotes).toHaveLength(1);
  });
  it("先前聚焦事件的迟到回调不会消费后来新增的引用", () => {
    const { render } = setup(); api.quote("第一句"); render(); const old = h.ui!.prefill!.nonce;
    api.quote("第二句"); render(); h.ui!.consumePrefill(old); render();
    expect(h.ui!.prefill!.text).toBe("第二句"); expect(h.ui!.quotes).toHaveLength(2);
  });
  it("后加的相同选文替换引用id，先前发送成功只清旧id", () => {
    const { render } = setup(); api.quote("同一句"); render(); const old = h.ui!.quotes[0].id;
    api.quote("同一句"); render(); h.ui!.removeQuotes([old]); render();
    expect(h.ui!.quotes).toHaveLength(1); expect(h.ui!.quotes[0].id).not.toBe(old);
  });
  it("发送失败恢复引用（D5）：放回原来的位置，不覆盖、不重复期间新加的引用", () => {
    const { render } = setup(); api.quote("第一句"); render();
    const sent = h.ui!.quotes; h.ui!.removeQuotes(sent.map((item) => item.id)); render();
    api.quote("期间新加的"); render();
    h.ui!.restoreQuotes(sent); render();
    expect(h.ui!.quotes.map((item) => item.text)).toEqual(["第一句", "期间新加的"]);
    // 期间又引了同一句：只留新的那条，不重复。
    const again = h.ui!.quotes.filter((item) => item.text === "第一句");
    h.ui!.removeQuotes(again.map((item) => item.id)); render();
    api.quote("第一句"); render();
    h.ui!.restoreQuotes(again); render();
    expect(h.ui!.quotes.filter((item) => item.text === "第一句")).toHaveLength(1);
  });
  it("发送失败晚到时已换了对象：不把旧引用放进新对象", () => {
    const { render } = setup(); api.quote("旧对象里的一句"); render();
    const sent = h.ui!.quotes; const restore = h.ui!.restoreQuotes; h.ui!.removeQuotes(sent.map((item) => item.id)); render();
    h.pathname = "/me/mission-cards/card-02"; render();
    restore(sent); render();
    expect(h.ui!.quotes).toEqual([]);
  });
  it("对话正文里划词引用（B4）：进这条对话的引用条并聚焦输入框，全局对话层保持打开、不切回右列私聊", () => {
    const { render } = setup();
    h.ui!.setGlobalView(true); h.ui!.setHistoryOpen(true); render();
    h.ui!.quoteInConversation("先保灯塔交付", { scope: "global" }); render();
    expect(h.ui!.historyOpen).toBe(true);
    expect(h.ui!.globalView).toBe(true);
    expect(h.ui!.keyboard).toBe(true);
    expect(h.ui!.quotes).toEqual([expect.objectContaining({ text: "先保灯塔交付", source: { scope: "global" } })]);
    expect(h.ui!.prefill).toMatchObject({ text: "先保灯塔交付", source: { scope: "global" } });
    // 对照：页面上的「引用提问」仍进当前对象私聊并收起对话层。
    api.quote("页面上的一句"); render();
    expect(h.ui!.historyOpen).toBe(false);
  });
  it("Esc 收起对话层时输入条一起回到胶囊（D6）", () => {
    const { render } = setup();
    vi.stubGlobal("HTMLElement", class {});
    h.ui!.setKeyboard(true); h.ui!.setGlobalView(true); h.ui!.setHistoryOpen(true); render();
    const calls = (window.addEventListener as unknown as { mock: { calls: [string, (event: unknown) => void][] } }).mock.calls;
    const onKey = calls.filter(([type]) => type === "keydown").at(-1)![1];
    onKey({ key: "Escape", isComposing: false, defaultPrevented: false, metaKey: false, ctrlKey: false, altKey: false }); render();
    expect(h.ui!.historyOpen).toBe(false);
    expect(h.ui!.globalView).toBe(false);
    expect(h.ui!.keyboard).toBe(false);
  });
  it.each(["object", "viewer", "role"])("切换 %s 的首帧即不显示上一对象/身份的引用", (change) => {
    const { props, render } = setup(); api.quote("旧选文"); render();
    if (change === "object") h.pathname = "/me/mission-cards/card-02";
    if (change === "viewer") props.viewerId = "wang";
    if (change === "role") props.homeHref = "/";
    render(false); expect(h.ui!.quotes).toEqual([]); expect(h.ui!.prefill).toBeNull();
  });
});
