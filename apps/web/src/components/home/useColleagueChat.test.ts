import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { TChatView } from "@warmap/contracts";

// 同步的钩子：按位置存值，useEffect 依赖变了才跑（照 friendSheet.test.tsx）。
const hooks = vi.hoisted(() => ({
  position: 0, values: [] as unknown[],
  useState(initial: unknown) {
    const key = hooks.position++;
    if (!(key in hooks.values)) hooks.values[key] = typeof initial === "function" ? (initial as () => unknown)() : initial;
    return [hooks.values[key], (next: unknown) => { hooks.values[key] = typeof next === "function" ? (next as (value: unknown) => unknown)(hooks.values[key]) : next; }];
  },
  useEffect(effect: () => unknown, deps?: unknown[]) {
    const key = hooks.position++;
    const before = hooks.values[key] as unknown[] | undefined;
    if (before && deps && deps.every((dep, index) => Object.is(dep, before[index]))) return;
    hooks.values[key] = deps ?? [];
    effect();
  },
  useRef(initial: unknown) {
    const key = hooks.position++;
    if (!(key in hooks.values)) hooks.values[key] = { current: initial };
    return hooks.values[key];
  },
  useCallback: (fn: unknown) => { hooks.position++; return fn; },
}));
vi.mock("react", async (original) => ({ ...(await original<typeof import("react")>()),
  useState: hooks.useState, useEffect: hooks.useEffect, useRef: hooks.useRef, useCallback: hooks.useCallback }));
vi.mock("./PartnerTeam", () => ({ FAST_FREQUENCY: 3_000 }));
const api = vi.hoisted(() => ({ readChat: vi.fn(), markChatRead: vi.fn() }));
vi.mock("@/lib/home/colleagueChats", async (original) => ({ ...(await original<typeof import("@/lib/home/colleagueChats")>()), ...api }));
import { useColleagueChat } from "./useColleagueChat";

const view = (text: string): TChatView => ({ id: "00000000-0000-4000-8000-000000000009", side: "from", peer: { personId: "p", displayName: "测试乙", left: false },
  peerBuddy: null, relation: "friends", firstWaiting: null, messages: [{ id: "00000000-0000-4000-8000-000000000001", author: "owner", text, at: "2026-11-20T08:00:00.000Z",
    replyTo: null, sources: [], answer: null, wait: null, seen: false, retracted: false, correction: null }] });
const run = () => { hooks.position = 0; return useColleagueChat("from", "p"); };

beforeEach(() => {
  hooks.position = 0; hooks.values = [];
  vi.resetAllMocks();
  api.markChatRead.mockResolvedValue(undefined);
  vi.stubGlobal("document", { visibilityState: "visible", addEventListener: vi.fn(), removeEventListener: vi.fn() });
  vi.stubGlobal("window", { setInterval: vi.fn(() => 1), clearInterval: vi.fn(), dispatchEvent: vi.fn() });
});
afterEach(() => vi.unstubAllGlobals());

describe("一段同事对话的读取", () => {
  it("动作写进来以后，早先发出、晚到的那次读不盖掉它", async () => {
    let finish: (value: TChatView) => void = () => undefined;
    api.readChat.mockReturnValueOnce(new Promise<TChatView>((resolve) => { finish = resolve; }));
    run().setChat(view("刚发的"));
    finish(view("读的时候还没有"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run().chat?.messages[0].text).toBe("刚发的");
  });

  it("没有动作插进来时，读回来的照写", async () => {
    api.readChat.mockResolvedValueOnce(view("读到的"));
    run();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(run().chat?.messages[0].text).toBe("读到的");
  });
});
