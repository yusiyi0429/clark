import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/** 没有 jsdom：带 data-testid 的元素的 props 从 JSX 运行时截下来，直接调它们的处理器（同 threadChip.test）。 */
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
vi.mock("next/navigation", () => ({ useRouter: () => ({ push: vi.fn(), replace: vi.fn() }), usePathname: () => "/me/work/buddy" }));

import type { ConversationData } from "@/conversation/useConversation";
import type { SubSession } from "@/lib/home/types";
import { WorkTimeline } from "@/components/work/WorkTimeline";
import { DispatchChip, type DispatchCard } from "./DispatchChip";
import type { SideDetail } from "./SideDetail";
import { mainOpener } from "./ThreadChip";

const TOPIC = "00000000-0000-4000-8000-0000000000a1";
const PROJECT = "00000000-0000-4000-8000-000000000001";
const sub = (extra: Partial<SubSession> = {}) => ({
  id: TOPIC, kind: "topic", letter: null, title: "首页换深色", state: "running", unseen: false, waiting: null, queueReason: null, holdUntil: null, role: null,
  sessionId: null, deviceId: null, autoStart: false, updatedAt: "2026-11-18T01:00:00.000Z", merge: null, free: true, ...extra,
}) as unknown as SubSession;
const project = (extra: Partial<{ name: string; archived: boolean; unseen: boolean }> = {}) => ({ id: PROJECT, name: "品牌建设", archived: false, unseen: false, ...extra });
const card = (extra: Partial<DispatchCard> = {}): DispatchCard => ({
  kind: "buddy_dispatch", dispatchId: "00000000-0000-4000-8000-0000000000d1", projectId: PROJECT, projectName: "品牌建设",
  sub: { kind: "topic", id: TOPIC, title: "首页换深色" }, state: "active", ...extra,
});
const text = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");
const chip = (props: Partial<Parameters<typeof DispatchChip>[0]> = {}) => renderToStaticMarkup(
  <DispatchChip card={card()} subs={[sub()]} projects={[project()]} waitingFolder={() => false} onOpenSub={vi.fn()} onOpenProject={vi.fn()} {...props} />);
const side = () => ({ open: false, toggle: vi.fn(), node: null, shown: null, show: vi.fn(), wide: false, setWide: vi.fn(), openThread: vi.fn() }) as SideDetail & { openThread: ReturnType<typeof vi.fn> };

describe("伙伴主线的派活卡（本人 11/18）", () => {
  it("主线这一轮下面画会话小条：项目名、会话名、状态", () => {
    const dispatch = (value: DispatchCard) => <DispatchChip card={value} subs={[sub({ title: "首页换深色（改名后）" })]} projects={[project()]} waitingFolder={() => false} onOpenSub={vi.fn()} onOpenProject={vi.fn()} />;
    const data = (extra: Partial<ConversationData>) => ({
      scope: "global", streaming: false, thinking: false, partial: "", send: vi.fn(), rescope: vi.fn(), steps: [], stage: "answering",
      messages: [{ sequence: 1, role: "user", content: "首页换个深色" }, { sequence: 2, role: "assistant", content: "开了一个会话去做。", cards: [card()] }], ...extra,
    }) as unknown as ConversationData;
    // 读历史的那一轮：画在那条回答后面；名字、状态跟着首页数据里那个会话走（改了名跟着变）。
    const history = renderToStaticMarkup(<WorkTimeline data={data({})} blocks={[]} dispatch={dispatch} />);
    expect(history).toContain('data-testid="dispatch-chip"');
    expect(text(history)).toContain("|品牌建设 · |首页换深色（改名后）|在跑|");
    expect(history.indexOf("开了一个会话去做。")).toBeLessThan(history.indexOf('data-testid="dispatch-chip"'));
    // 项目对话不传 dispatch：派活卡不画。
    expect(renderToStaticMarkup(<WorkTimeline data={data({})} blocks={[]} />)).not.toContain("dispatch-chip");
    // 正在回答的那一轮：卡一到就画在状态那一块里，不等这一轮结束。
    const live = renderToStaticMarkup(<WorkTimeline blocks={[]} dispatch={dispatch} data={data({ streaming: true, thinking: true, partial: "开了",
      messages: [{ sequence: 1, role: "user", content: "首页换个深色" }], turnCards: [card()] } as Partial<ConversationData>)} />);
    expect(text(live)).toContain("|品牌建设 · |首页换深色（改名后）|在跑|");
    // 点了交给打开函数，带上项目名（右边页头写「品牌建设 · 从主线开的」）。
    const onOpenSub = vi.fn();
    chip({ onOpenSub });
    (tap.props.get("thread-chip")?.onClick as () => void)();
    expect(onOpenSub).toHaveBeenCalledWith(expect.objectContaining({ kind: "topic", id: TOPIC }), "品牌建设");
  });

  it("手机上点小条全屏打开那个会话", () => {
    const go = vi.fn();
    // 手机上没有右边的面板位：去那个会话。
    mainOpener(null, [sub()], go)({ kind: "topic", id: TOPIC }, "品牌建设");
    expect(go).toHaveBeenCalledWith(`/me/work/topics/${TOPIC}`);
    // 电脑上在右边开，带上项目名，不跳。
    const panel = side();
    const desk = vi.fn();
    mainOpener(panel, [sub()], desk)({ kind: "topic", id: TOPIC }, "品牌建设");
    expect(panel.openThread).toHaveBeenCalledWith({ kind: "topic", id: TOPIC }, "品牌建设");
    expect(desk).not.toHaveBeenCalled();
    // 电脑上、首页数据里还没有它（刚开、还没读回来）：照旧去那个会话，不开一块空的。
    const fresh = side();
    mainOpener(fresh, [], desk)({ kind: "topic", id: TOPIC }, "品牌建设");
    expect(fresh.openThread).not.toHaveBeenCalled();
    expect(desk).toHaveBeenCalledWith(`/me/work/topics/${TOPIC}`);
  });

  it("转给项目的小条写项目名，点了去那个项目的对话", () => {
    const onOpenProject = vi.fn();
    const html = chip({ card: card({ sub: null }), onOpenProject });
    expect(text(html)).toContain("|品牌建设 ›|");
    expect(html).not.toContain("thread-dot");
    (tap.props.get("dispatch-project")?.onClick as () => void)();
    expect(onOpenProject).toHaveBeenCalledWith(PROJECT);
    // 项目对话里有没看过的新回复：一颗蓝点。项目改了名跟着变。
    const unseen = chip({ card: card({ sub: null }), projects: [project({ unseen: true, name: "品牌建设二期" })] });
    expect(unseen).toContain('data-testid="thread-dot"');
    expect(text(unseen)).toContain("|品牌建设二期 ›|");
  });

  it("会话归档或删了，小条变成不能点的淡色名字", () => {
    for (const value of [card({ state: "archived" }), card({ state: "gone", sub: { kind: "topic", id: null, title: "首页换深色" } })]) {
      const html = chip({ card: value, subs: [] });
      expect(text(html)).toContain("|品牌建设 · 首页换深色|");
      expect(html).not.toContain("<button");
      expect(html).toContain('data-testid="dispatch-faded"');
    }
    // 项目归档了的项目小条同理。
    const archived = chip({ card: card({ sub: null, state: "archived" }) });
    expect(text(archived)).toContain("|品牌建设|");
    expect(archived).not.toContain("<button");
    expect(archived).not.toContain("›");
  });

  it("等文件夹的会话小条写等你，右边能就地选文件夹", () => {
    const waitingFolder = vi.fn((projectId: string) => projectId === PROJECT);
    const html = chip({ waitingFolder });
    expect(html).toMatch(/data-wait="">等你</);
    expect(waitingFolder).toHaveBeenCalledWith(PROJECT);
    // 不等文件夹时照会话自己的状态。
    expect(chip()).not.toContain("等你");
  });
});
