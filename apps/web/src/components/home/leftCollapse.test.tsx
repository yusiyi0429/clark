import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
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
import { LeftToggle, leftSnapshot, leftUnseen, useLeftCollapsed } from "./LeftResize";
import { LEFT_COLLAPSED_ATTR, LEFT_COLLAPSED_SCRIPT } from "@/lib/home/leftCollapse";

const KEY = "tianshu-home-left-collapsed-v1";
/** <html> 上的属性（首屏脚本写、开合时跟着改）。 */
const html = () => {
  const attrs = new Map<string, string>();
  vi.stubGlobal("document", { documentElement: { setAttribute: (key: string, value: string) => attrs.set(key, value), removeAttribute: (key: string) => attrs.delete(key) } });
  return attrs;
};
const run = () => { h.hooks = true; h.index = 0; try { return useLeftCollapsed(); } finally { h.hooks = false; } };
const flush = () => h.effects.splice(0).forEach((effect) => effect());
/** 新打开一页：状态清空，挂载后的 effect 跑一次。 */
const open = () => { h.states = []; h.effects = []; run(); flush(); return run(); };
const shell = () => renderToStaticMarkup(<HomeShell account={{ displayName: "孙铭泽", role: "member", personId: "p" }} />);

afterEach(() => { vi.unstubAllGlobals(); h.path = "/me/work"; h.phone = false; h.collapsed = null; });

describe("左栏能收起（设计 4.1）", () => {
  it("收起记在这台电脑上", () => {
    const store = new Map<string, string>();
    const attrs = html();
    vi.stubGlobal("localStorage", { getItem: (key: string) => store.get(key) ?? null, setItem: (key: string, value: string) => store.set(key, value), removeItem: (key: string) => store.delete(key) });
    expect(open().collapsed).toBe(false);
    run().toggle();
    expect(run().collapsed).toBe(true);
    expect(store.has(KEY)).toBe(true);
    expect(attrs.get(LEFT_COLLAPSED_ATTR)).toBe("closed");
    // 刷新以后照样收着；再展开就不记了。
    const again = open();
    expect(again.collapsed).toBe(true);
    again.toggle();
    expect(run().collapsed).toBe(false);
    expect(store.has(KEY)).toBe(false);
    expect(attrs.has(LEFT_COLLAPSED_ATTR)).toBe(false);
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

  it("刷新不闪：首屏脚本在画出来之前按这台电脑记的给 <html> 写上收起", () => {
    const run = (stored: string | null | Error) => {
      const attrs = new Map<string, string>();
      const document = { documentElement: { setAttribute: (key: string, value: string) => attrs.set(key, value) } };
      const localStorage = { getItem: (key: string) => { if (stored instanceof Error) throw stored; return key === KEY ? stored : null; } };
      new Function("document", "localStorage", LEFT_COLLAPSED_SCRIPT)(document, localStorage);
      return attrs.get(LEFT_COLLAPSED_ATTR) ?? null;
    };
    expect(run("1")).toBe("closed");
    expect(run(null)).toBeNull();
    expect(run(new Error("blocked"))).toBeNull();
    // 收着时外壳在挂载前就按 <html> 上那个属性收起（不等挂载后再收、不放过渡）；手机不受影响。
    const css = readFileSync(fileURLToPath(new URL("../../styles/home.module.css", import.meta.url)), "utf8");
    expect(css).toContain(`:global(html[${LEFT_COLLAPSED_ATTR}="closed"]) .app:not([data-phone])`);
  });

  const project = (unseen: boolean, lastActivityAt = "2026-11-17T01:00:00.000Z") => {
    const data = { period: "2026-11", projects: [{ projectId: "p1", name: "首页改版", lastActivityAt, budget: null, goals: [], transfer: null, unseen,
      summary: { running: 0, waiting: 0, queued: 0, done: 0, doneToday: 0, needsYou: 0 }, pipeline: { conversationId: null, scope: "project:p1" }, planning: false, subSessions: [], items: [] }],
      archivedCount: 0, month: { missions: [] }, waiting: [], other: { subSessions: [], items: [] } } as unknown as WorkHomeData;
    return data.projects.map((entry) => fromHome(entry, data, new Map()));
  };

  it("收起那一刻已有没看的项目，不亮", () => {
    const since = leftSnapshot(project(true), undefined, 2);
    expect(leftUnseen({ collapsed: true, projects: project(true), waitingCount: 2, since })).toBe(false);
    // 刷新后还没读到数据（还没记下那一刻）：不亮。
    expect(leftUnseen({ collapsed: true, projects: project(true), waitingCount: 5, since: null })).toBe(false);
  });

  it("收起期间项目来了新的，亮", () => {
    const quiet = leftSnapshot(project(false), undefined, 0);
    expect(leftUnseen({ collapsed: true, projects: project(true), waitingCount: 0, since: quiet })).toBe(true);
    // 收起时已经没看的那个，又来了更新的：亮。
    const already = leftSnapshot(project(true), undefined, 0);
    expect(leftUnseen({ collapsed: true, projects: project(true, "2026-11-17T02:00:00.000Z"), waitingCount: 0, since: already })).toBe(true);
    // 刚看过的（同一次停下）不算。
    expect(leftUnseen({ collapsed: true, projects: project(true), seen: new Map([["project:p1", "2026-11-17T01:00:00.000Z"]]), waitingCount: 0, since: quiet })).toBe(false);
  });

  it("等你件数变多，亮", () => {
    const since = leftSnapshot(project(false), undefined, 2);
    expect(leftUnseen({ collapsed: true, projects: project(false), waitingCount: 3, since })).toBe(true);
    expect(leftUnseen({ collapsed: true, projects: project(false), waitingCount: 2, since })).toBe(false);
    expect(leftUnseen({ collapsed: true, projects: project(false), waitingCount: 1, since })).toBe(false);
  });

  it("展开清掉", () => {
    const since = leftSnapshot(project(false), undefined, 0);
    expect(leftUnseen({ collapsed: false, projects: project(true), waitingCount: 9, since })).toBe(false);
    const dot = renderToStaticMarkup(<LeftToggle collapsed unseen onToggle={() => undefined} />);
    expect(dot).toMatch(/<button[^>]*aria-label="展开左栏"[^>]*data-unseen=""[^>]*data-testid="left-toggle"/);
    expect(dot).toContain("<i ");
    expect(renderToStaticMarkup(<LeftToggle collapsed={false} unseen={false} onToggle={() => undefined} />)).not.toContain("data-unseen");
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
