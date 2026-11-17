import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/** 没有 jsdom：带 data-testid 的元素的 props 从 JSX 运行时截下来，直接调它们的处理器（同 sessionsPanel.test）。 */
const tap = vi.hoisted(() => ({ props: new Map<string, Record<string, unknown>>() }));
const capture = vi.hoisted(() => <T,>(fn: T) => ((type: unknown, props: Record<string, unknown>, ...rest: unknown[]) => {
  if (typeof props?.["data-testid"] === "string") tap.props.set(props["data-testid"] as string, props);
  return (fn as unknown as (...args: unknown[]) => unknown)(type, props, ...rest);
}) as unknown as T);
vi.mock("react/jsx-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-runtime")>();
  return { ...actual, jsx: capture(actual.jsx), jsxs: capture(actual.jsxs) };
});
vi.mock("react/jsx-dev-runtime", async (importOriginal) => {
  const actual = await importOriginal<typeof import("react/jsx-dev-runtime")>();
  return { ...actual, jsxDEV: capture(actual.jsxDEV) };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work" }));

import type { Project } from "@/lib/home/projects";
import type { SubSession } from "@/lib/home/types";
import type { Resources } from "@/lib/work/useWork";
import { LocalContext, type LocalRunnerState } from "@/lib/local/LocalRunnerProvider";
import { createMockRunner } from "@/lib/local/mock";
import { SeenContext } from "./SubRows";
import { SessionsPanel } from "./SessionsPanel";
import type { SideDetail } from "./SideDetail";
import { ThreadChip, inCenter, threadOpener } from "./ThreadChip";

const sub = (extra: Partial<SubSession> = {}) => ({
  id: "t1", kind: "topic", letter: null, title: "首页手机检查", state: "running", unseen: false, waiting: null, queueReason: null, holdUntil: null, role: null,
  sessionId: null, deviceId: null, autoStart: false, updatedAt: "2026-11-17T01:00:00.000Z", merge: null, ...extra,
}) as unknown as SubSession;
const side = () => ({ open: false, toggle: vi.fn(), node: null, shown: null, show: vi.fn(), wide: false, setWide: vi.fn(), openThread: vi.fn() }) as SideDetail & { openThread: ReturnType<typeof vi.fn> };
const text = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
const chip = (value: SubSession, onOpen: (sub: SubSession) => void = vi.fn()) => renderToStaticMarkup(<ThreadChip sub={value} onOpen={onOpen} />);

describe("thread 小条（设计 6.6）", () => {
  it("小条写名字、状态，没看过一颗蓝点，电脑上点了开右边", () => {
    // 名字 + 和会话面板同一个短状态；在跑没有蓝点。
    const running = chip(sub());
    expect(running).toContain('data-testid="thread-chip"');
    expect(text(running)).toContain("|首页手机检查|在跑|");
    expect(running).not.toContain("thread-dot");
    // 等你：字用 --judgment（data-wait）。
    const waiting = chip(sub({ state: "waiting", waiting: "question" }));
    expect(waiting).toMatch(/data-wait="">等你</);
    // 停了、没看过：一颗蓝点（只有 unseen 布尔，没有条数）；这一页里刚看过的不画。
    const unseen = sub({ state: "done", unseen: true });
    expect(chip(unseen)).toContain('data-testid="thread-dot"');
    const seen = renderToStaticMarkup(<SeenContext.Provider value={{ seen: new Map([["sub:t1", unseen.updatedAt]]) }}><ThreadChip sub={unseen} onOpen={vi.fn()} /></SeenContext.Provider>);
    expect(seen).not.toContain("thread-dot");
    // 电脑上（新首页有右边的面板位）：点了在右边开 thread，不换页。
    const panel = side();
    const go = vi.fn();
    chip(sub(), threadOpener(panel, go));
    (tap.props.get("thread-chip")?.onClick as () => void)();
    expect(panel.openThread).toHaveBeenCalledWith(expect.objectContaining({ kind: "topic", id: "t1" }));
    expect(go).not.toHaveBeenCalled();
  });

  it("中间已经是这个子会话：再点它的行或小条不在右边再开一份", () => {
    expect(inCenter({ kind: "topic", id: "t1" }, { kind: "topic", id: "t1" })).toBe(true);
    expect(inCenter({ kind: "card", id: "c1" }, { kind: "card", id: "c1" })).toBe(true);
    // 别的子会话、同 id 不同种、项目对话：照常开。
    expect(inCenter({ kind: "topic", id: "t2" }, { kind: "topic", id: "t1" })).toBe(false);
    expect(inCenter({ kind: "card", id: "t1" }, { kind: "topic", id: "t1" })).toBe(false);
    expect(inCenter({ kind: "project", id: "t1" }, { kind: "topic", id: "t1" })).toBe(false);
  });

  it("手机上点小条全屏打开", () => {
    const go = vi.fn();
    chip(sub({ kind: "card", id: "c1" }), threadOpener(null, go));
    (tap.props.get("thread-chip")?.onClick as () => void)();
    expect(go).toHaveBeenCalledWith("/me/work/cards/c1");
  });

  it("会话面板点行开 thread", () => {
    const panel = side();
    const go = vi.fn();
    const project = { id: "p1", name: "天枢新版", folder: null, archived: false, goals: [], current: [], subSessions: [sub()], items: [], scope: "project:p1", waiting: 0,
      lastActivity: null, budget: null, unseen: false, transfer: null } as unknown as Project;
    const resources: Resources = { local: { online: true, name: null, used: 0, cap: 3 }, models: [], todayUsd: null, quota: [] };
    const local = { runner: createMockRunner(), phase: "offline", version: null, status: null, models: [], folders: [], sessions: [], pairing: null, error: null,
      refresh: vi.fn(), pair: vi.fn(), unpair: vi.fn(), pickFolder: vi.fn(), setIncludePersonal: vi.fn() } as unknown as LocalRunnerState;
    renderToStaticMarkup(<LocalContext.Provider value={local}><SessionsPanel view={{ kind: "project", id: "p1" }} projects={[project]} other={[]} archivedSubs={[]} actions={null} go={go}
      items={[]} onStop={async () => undefined} resources={resources} onOpenSub={threadOpener(panel, go)} /></LocalContext.Provider>);
    (tap.props.get("tree-sub")?.onClick as () => void)();
    expect(panel.openThread).toHaveBeenCalledWith(expect.objectContaining({ kind: "topic", id: "t1" }));
    expect(go).not.toHaveBeenCalled();
  });
});
