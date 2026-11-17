import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { WorkHomeData } from "@/lib/home/types";
import { fromHome } from "@/lib/home/projects";

/**
 * 左栏收起（设计 4.1）。没有 jsdom：
 * - 记在这台电脑上：React 的 useState / useEffect / useCallback 只在跑 useLeftCollapsed 时换成按调用顺序记账的版本，直接调这个 hook；
 * - 外壳：整个 HomeShell 静态画出来，收没收起、是不是手机由桩给。
 */
const h = vi.hoisted(() => ({
  hooks: false, states: [] as unknown[], index: 0, effects: [] as (() => void)[],
  path: "/me/work", phone: false, collapsed: null as boolean | null,
}));
vi.mock("react", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react")>();
  return {
    ...actual,
    useState: (initial: unknown) => {
      if (!h.hooks) return actual.useState(initial);
      const index = h.index++;
      if (!(index in h.states)) h.states[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [h.states[index], (update: unknown) => { h.states[index] = typeof update === "function" ? (update as (value: unknown) => unknown)(h.states[index]) : update; }];
    },
    useEffect: (effect: () => void, deps?: readonly unknown[]) => (h.hooks ? void h.effects.push(effect) : actual.useEffect(effect, deps)),
    useCallback: (callback: unknown, deps: readonly unknown[]) => (h.hooks ? callback : actual.useCallback(callback as () => void, deps)),
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => h.path, useSearchParams: () => new URLSearchParams() }));
vi.mock("./usePhone", async (importOriginal) => ({ ...(await importOriginal<typeof import("./usePhone")>()), usePhone: () => h.phone }));
vi.mock("./LeftResize", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./LeftResize")>();
  return { ...actual, useLeftCollapsed: () => (h.collapsed === null ? actual.useLeftCollapsed() : { collapsed: h.collapsed, toggle: () => undefined }) };
});

import { HomeShell } from "./HomeShell";
import { LeftToggle, leftUnseen, useLeftCollapsed } from "./LeftResize";

const KEY = "tianshu-home-left-collapsed-v1";
const run = () => { h.hooks = true; h.index = 0; try { return useLeftCollapsed(); } finally { h.hooks = false; } };
const flush = () => h.effects.splice(0).forEach((effect) => effect());
/** 新打开一页：状态清空，挂载后的 effect 跑一次。 */
const open = () => { h.states = []; h.effects = []; run(); flush(); return run(); };
const shell = () => renderToStaticMarkup(<HomeShell account={{ displayName: "孙铭泽", role: "member", personId: "p" }} />);

afterEach(() => { vi.unstubAllGlobals(); h.path = "/me/work"; h.phone = false; h.collapsed = null; });

describe("左栏能收起（设计 4.1）", () => {
  it("收起记在这台电脑上", () => {
    const store = new Map<string, string>();
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) });
    expect(open().collapsed).toBe(false);
    run().toggle();
    expect(run().collapsed).toBe(true);
    expect(store.has(KEY)).toBe(true);
    // 刷新以后照样收着；再展开就不记了。
    const again = open();
    expect(again.collapsed).toBe(true);
    again.toggle();
    expect(run().collapsed).toBe(false);
    expect(store.has(KEY)).toBe(false);
    // 存不了（隐私模式）：照样能收起，只是不记。
    vi.stubGlobal("localStorage", { getItem: () => { throw new Error("blocked"); }, setItem: () => { throw new Error("blocked"); }, removeItem: () => { throw new Error("blocked"); } });
    const blocked = open();
    expect(blocked.collapsed).toBe(false);
    expect(() => blocked.toggle()).not.toThrow();
    expect(run().collapsed).toBe(true);
  });

  it("收起后在首页、项目页都有展开按钮", () => {
    h.collapsed = true;
    for (const path of ["/me/work", "/me/work/projects/p1", "/me/work/month/2026-11"]) {
      h.path = path;
      const html = shell();
      expect(html).toMatch(/data-testid="work-home"/);
      expect(html).toMatch(/<div class="[^"]*"[^>]*data-left="closed"/);
      expect(html).toMatch(/<main[^>]*><button[^>]*aria-label="展开左栏"[^>]*data-testid="left-toggle"/);
      expect(html).not.toContain('data-testid="left-resize"');
    }
    h.collapsed = false;
    const open = shell();
    expect(open).toMatch(/<main[^>]*><button[^>]*aria-label="收起左栏"[^>]*data-testid="left-toggle"/);
    expect(open).not.toContain('data-left="closed"');
    expect(open).toContain('data-testid="left-resize"');
  });

  it("收起时有新东西，按钮上一个蓝点；展开清掉", () => {
    const data = { period: "2026-11", projects: [{ projectId: "p1", name: "首页改版", lastActivityAt: "2026-11-17T01:00:00.000Z", budget: null, goals: [], transfer: null, unseen: true,
      summary: { running: 0, waiting: 0, queued: 0, done: 0, doneToday: 0, needsYou: 0 }, pipeline: { conversationId: null, scope: "project:p1" }, planning: false, subSessions: [], items: [] }],
      archivedCount: 0, month: { missions: [] }, waiting: [], other: { subSessions: [], items: [] } } as unknown as WorkHomeData;
    const unseen = data.projects.map((project) => fromHome(project, data, new Map()));
    const quiet = unseen.map((project) => ({ ...project, unseen: false }));
    // 等你比收起那一刻多了：亮；没多：不亮。
    expect(leftUnseen({ collapsed: true, projects: quiet, waitingCount: 3, since: 2 })).toBe(true);
    expect(leftUnseen({ collapsed: true, projects: quiet, waitingCount: 2, since: 2 })).toBe(false);
    // 哪个项目出了没看过的蓝点：亮；刚看过的（同一次）不算。
    expect(leftUnseen({ collapsed: true, projects: unseen, waitingCount: 0, since: 0 })).toBe(true);
    expect(leftUnseen({ collapsed: true, projects: unseen, seen: new Map([["project:p1", "2026-11-17T01:00:00.000Z"]]), waitingCount: 0, since: 0 })).toBe(false);
    // 展开就清掉。
    expect(leftUnseen({ collapsed: false, projects: unseen, waitingCount: 9, since: 0 })).toBe(false);
    const dot = renderToStaticMarkup(<LeftToggle collapsed unseen onToggle={() => undefined} />);
    expect(dot).toMatch(/<button[^>]*aria-label="展开左栏"[^>]*data-unseen=""[^>]*data-testid="left-toggle"/);
    expect(dot).toContain("<i ");
    expect(renderToStaticMarkup(<LeftToggle collapsed unseen={false} onToggle={() => undefined} />)).not.toContain("data-unseen");
  });

  it("手机没有收起", () => {
    h.phone = true;
    h.collapsed = true;
    const html = shell();
    expect(html).toContain('data-phone=""');
    expect(html).not.toContain("left-toggle");
    expect(html).not.toContain('data-left="closed"');
  });
});
