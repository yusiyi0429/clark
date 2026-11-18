import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/* 直接调用组件：useState / useRef 按调用顺序存值，useEffect 记下来由测试按依赖变化执行。 */
const hooks = vi.hoisted(() => {
  const store = {
    values: [] as unknown[], refs: [] as { current: unknown }[], effects: [] as { fn: () => void | (() => void); deps?: unknown[]; ran?: unknown[] }[],
    index: 0, refIndex: 0, effectIndex: 0,
    useState(initial: unknown) {
      const index = store.index++;
      if (!(index in store.values)) store.values[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [store.values[index], (next: unknown) => {
        store.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(store.values[index]) : next;
      }];
    },
    useRef(initial: unknown) {
      const index = store.refIndex++;
      if (!(index in store.refs)) store.refs[index] = { current: initial };
      return store.refs[index];
    },
    useEffect(fn: () => void | (() => void), deps?: unknown[]) {
      const index = store.effectIndex++;
      const previous = store.effects[index];
      store.effects[index] = { fn, deps, ran: previous?.ran };
    },
  };
  return store;
});
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()),
  useState: hooks.useState, useRef: hooks.useRef, useEffect: hooks.useEffect, useCallback: (fn: unknown) => fn }));
const api = vi.hoisted(() => ({ GET: vi.fn() }));
vi.mock("@/lib/api/client", () => ({ browserApi: api }));
vi.mock("@/lib/home/noEllipsis", () => ({ useDots: () => (text: string) => text }));

import { TranscriptReader } from "./TranscriptReader";

type Node = { type?: unknown; props?: Record<string, unknown> };
function nodes(value: unknown): Node[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (!value || typeof value !== "object") return [];
  const node = value as Node;
  return node.props ? [node, ...nodes(node.props.children)] : [];
}

function render(props: { meetingId: string; focusTurnId: string | null }) {
  hooks.index = 0; hooks.refIndex = 0; hooks.effectIndex = 0;
  return TranscriptReader(props);
}
/** 依赖变了的 effect 才跑（和 React 一样）。 */
function runEffects() {
  for (const effect of hooks.effects) {
    const changed = !effect.ran || !effect.deps || effect.deps.some((dep, index) => !Object.is(dep, effect.ran![index]));
    if (!changed) continue;
    effect.ran = effect.deps ?? [];
    effect.fn();
  }
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

const turn = (id: string, text: string) => ({ id, speakerName: "测试乙", startedAt: "2026-06-01T02:00:00.000Z", text });

beforeEach(() => {
  hooks.values = []; hooks.refs = []; hooks.effects = [];
  vi.clearAllMocks();
  vi.stubGlobal("CSS", { escape: (value: string) => value });
  vi.stubGlobal("window", { setTimeout: () => 0, matchMedia: () => ({ matches: true }) });
});
afterEach(() => vi.unstubAllGlobals());

describe("逐字稿阅读器", () => {
  it("打开时定位到那一段", async () => {
    api.GET.mockResolvedValue({ data: { turns: [turn("t41", "先看数据"), turn("t42", "接口统一改成 v2"), turn("t43", "好")], nextTurn: null, total: 3 }, response: { ok: true, status: 200 } });
    render({ meetingId: "m1", focusTurnId: "t42" });
    runEffects();
    await flush();
    expect(api.GET).toHaveBeenCalledWith("/api/meetings/{id}/transcript", { params: { path: { id: "m1" }, query: {} } });

    const tree = render({ meetingId: "m1", focusTurnId: "t42" });
    const rows = nodes(tree).filter((node) => node.type === "li");
    expect(rows.map((row) => row.props!.id)).toEqual(["turn-t41", "turn-t42", "turn-t43"]);
    // 一行：说话人、时间、正文。
    expect(JSON.stringify(rows[1])).toContain("测试乙");
    expect(JSON.stringify(rows[1])).toContain("接口统一改成 v2");

    const target = { dataset: {} as Record<string, string>, closest: () => null, scrollIntoView: vi.fn() };
    const list = nodes(tree).find((node) => node.type === "ol")!;
    (list.props!.ref as { current: unknown }).current = { querySelector: (selector: string) => (selector === "#turn-t42" ? target : null) };
    runEffects();
    expect(target.scrollIntoView).toHaveBeenCalledTimes(1);
    expect(target.dataset.flash).toBe("true");
  });

  it("要定位的那一段不在第一页时接着取，直到取到为止", async () => {
    api.GET
      .mockResolvedValueOnce({ data: { turns: [turn("t1", "一")], nextTurn: "t2", total: 2 }, response: { ok: true, status: 200 } })
      .mockResolvedValueOnce({ data: { turns: [turn("t2", "二")], nextTurn: null, total: 2 }, response: { ok: true, status: 200 } });
    render({ meetingId: "m1", focusTurnId: "t2" });
    runEffects();
    await flush();
    render({ meetingId: "m1", focusTurnId: "t2" });
    runEffects();
    await flush();
    expect(api.GET).toHaveBeenLastCalledWith("/api/meetings/{id}/transcript", { params: { path: { id: "m1" }, query: { from: "t2" } } });
    const tree = render({ meetingId: "m1", focusTurnId: "t2" });
    expect(nodes(tree).filter((node) => node.type === "li").map((row) => row.props!.id)).toEqual(["turn-t1", "turn-t2"]);
  });
});
