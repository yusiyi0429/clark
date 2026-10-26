import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import type { WorkspaceApi } from "./WorkspaceContext";

// Keep the shell's refs across simulated route commits, just as Next keeps its layout mounted.
const navigation = vi.hoisted(() => ({ pathname: "/me", push: vi.fn(), refresh: vi.fn(), refs: [] as { current: unknown }[], cursor: 0, reduced: true }));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return { ...actual, useRef: (value: unknown) => {
    const slot = navigation.cursor++;
    navigation.refs[slot] ??= { current: value };
    return navigation.refs[slot];
  } };
});
vi.mock("next/navigation", () => ({ usePathname: () => navigation.pathname, useRouter: () => ({ push: navigation.push, refresh: navigation.refresh }) }));
vi.mock("@/components/onboarding/useHomeArrival", () => ({ useHomeArrival: () => false }));
vi.mock("@/conversation/references", () => ({ ReferenceProvider: ({ children }: { children: ReactNode }) => children }));
vi.mock("@/conversation/ConversationHost", () => ({ ConversationHost: () => null }));
vi.mock("./NoticeStrip", () => ({ NoticeStrip: () => <nav>通知窄条</nav> }));

import { WorkspaceFrame } from "./WorkspaceFrame";
import { useWorkspace } from "./WorkspaceContext";

let api: WorkspaceApi;
function Capture() { api = useWorkspace(); return <h1>详情内容</h1>; }

class Source {
  isConnected = true;
  style = { removeProperty: vi.fn() };
  focus = vi.fn();
  getBoundingClientRect = () => ({ left: 20, top: 40, width: 280, height: 100 });
  closest(selector: string) { return selector.includes("global-controls") ? null : this; }
  contains = (other: unknown) => other === this;
  matches = () => true;
  querySelector = () => this;
}

beforeEach(() => {
  navigation.pathname = "/me";
  navigation.refs = [];
  navigation.cursor = 0;
  navigation.reduced = true;
  vi.clearAllMocks();
  vi.stubGlobal("Element", Source);
  vi.stubGlobal("HTMLElement", Source);
  vi.stubGlobal("document", { body: {}, activeElement: null, querySelector: () => null });
  vi.stubGlobal("window", { matchMedia: () => ({ matches: navigation.reduced }) });
  vi.stubGlobal("CSS", { escape: (value: string) => value });
});
afterEach(() => vi.unstubAllGlobals());

function render(homeHref: "/" | "/me" = "/me") {
  navigation.cursor = 0;
  return renderToStaticMarkup(
    <WorkspaceFrame homeHref={homeHref} viewerId="viewer" account={{ displayName: "成员", role: homeHref === "/me" ? "member" : "ceo" }} home={<p>保留首页</p>} notifications={() => <p>保留通知</p>} agentTitle="天枢">
      <Capture />
    </WorkspaceFrame>,
  );
}

describe("CEO 与成员共享的工作区开合", () => {
  it.each(["/", "/me"] as const)("%s 入口打开后关闭回来源，恢复触发按钮焦点", (homeHref) => {
    navigation.pathname = homeHref;
    const source = new Source();
    Object.assign(document, { activeElement: source });
    render(homeHref);
    const href = `${homeHref === "/" ? "" : homeHref}/mission-cards/card-01`;
    api.navigate(href, source as unknown as Element);
    expect(navigation.push).toHaveBeenLastCalledWith(href);
    navigation.pathname = href;
    const html = render(homeHref);
    expect(html).toContain("保留首页");
    expect(html).toContain('aria-hidden="true" inert=""');
    expect(html).toContain('data-testid="expanded-panel"');
    api.close();
    expect(navigation.push).toHaveBeenLastCalledWith(homeHref);
    expect(source.focus).toHaveBeenCalledExactlyOnceWith({ preventScroll: true });
    expect(navigation.refresh).toHaveBeenCalledOnce();
  });

  it("从任务卡转去战场再关闭，先回任务卡，下一次才回 /me", () => {
    render();
    api.navigate("/me/mission-cards/card-01");
    navigation.pathname = "/me/mission-cards/card-01";
    render();
    api.navigate("/me/battlefields/01");
    navigation.pathname = "/me/battlefields/01";
    render();
    api.close();
    expect(navigation.push).toHaveBeenLastCalledWith("/me/mission-cards/card-01");
    navigation.pathname = "/me/mission-cards/card-01";
    render();
    api.close();
    expect(navigation.push).toHaveBeenLastCalledWith("/me");
  });

  it("直接打开成员深链接，关闭仍回 /me，不跳到 CEO 首页", () => {
    navigation.pathname = "/me/mission-cards/card-01";
    const home = new Source();
    Object.assign(document, { querySelector: () => home });
    render();
    api.close();
    expect(navigation.push).toHaveBeenLastCalledWith("/me");
    expect(home.focus).toHaveBeenCalledWith({ preventScroll: true });
  });

  it("外壳右上角不放「约会议」：成员从首页操作区、CEO 从首页战场工具条打开建会抽屉", () => {
    expect(render("/me")).not.toContain("约会议");
    expect(render("/")).not.toContain("约会议");
    expect(api.bookMeeting).toBeTypeOf("function");
  });
});
