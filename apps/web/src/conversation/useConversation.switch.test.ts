import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 一个只够跑这个 hook 的 React：状态按调用顺序保存，effect 按依赖重跑并先执行上一次的清理。 */
const h = vi.hoisted(() => ({
  states: [] as unknown[], refs: [] as { current: unknown }[],
  memos: [] as ({ deps?: readonly unknown[]; value: unknown } | undefined)[],
  effects: [] as ({ deps?: readonly unknown[]; cleanup?: unknown } | undefined)[],
  stateIndex: 0, refIndex: 0, memoIndex: 0, effectIndex: 0, queued: [] as (() => void)[],
}));
const same = (next?: readonly unknown[], previous?: readonly unknown[]) =>
  !!next && !!previous && next.length === previous.length && next.every((value, index) => Object.is(value, previous[index]));
vi.mock("react", () => ({
  useState: (initial: unknown) => {
    const index = h.stateIndex++;
    if (!(index in h.states)) h.states[index] = initial;
    return [h.states[index], (next: unknown) => {
      h.states[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(h.states[index]) : next;
    }];
  },
  useRef: (initial: unknown) => h.refs[h.refIndex++] ??= { current: initial },
  useCallback: (callback: unknown, deps?: readonly unknown[]) => {
    const index = h.memoIndex++, previous = h.memos[index];
    if (previous && same(deps, previous.deps)) return previous.value;
    h.memos[index] = { deps, value: callback };
    return callback;
  },
  useEffect: (effect: () => unknown, deps?: readonly unknown[]) => {
    const index = h.effectIndex++, previous = h.effects[index];
    if (previous && same(deps, previous.deps)) return;
    const slot: { deps?: readonly unknown[]; cleanup?: unknown } = { deps };
    h.effects[index] = slot;
    h.queued.push(() => {
      if (typeof previous?.cleanup === "function") previous.cleanup();
      slot.cleanup = effect();
    });
  },
}));
import { useConversation, type Message } from "./useConversation";

/**
 * 新建对话 / 切回历史对话（存在感很低的入口，useConversation 这一层）：切换成功后清掉本轮展示态、重读历史；
 * 回答进行中、服务端说忙时不切，已显示的对话不动。以及备用模型标注随 done 事件带回。
 */
type Pending = { url: string; init?: RequestInit; resolve: (value: unknown) => void; reject: (cause: unknown) => void };
let requests: Pending[] = [];

beforeEach(() => {
  h.states = []; h.refs = []; h.memos = []; h.effects = [];
  requests = [];
  vi.stubGlobal("window", { dispatchEvent: vi.fn(), location: { assign: vi.fn() } });
  vi.stubGlobal("CustomEvent", class { constructor(public type: string, public init?: unknown) {} });
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => new Promise((resolve, reject) => {
    requests.push({ url, init, resolve, reject });
    init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
  })));
});
afterEach(() => vi.unstubAllGlobals());

function render() {
  h.stateIndex = 0; h.refIndex = 0; h.memoIndex = 0; h.effectIndex = 0; h.queued = [];
  const result = useConversation("global");
  const queued = h.queued; h.queued = [];
  queued.forEach((run) => run());
  return result;
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const gets = () => requests.filter((request) => !request.init?.method);
const posts = () => requests.filter((request) => request.init?.method === "POST");
const history = (messages: Message[], archivedCount = 0) => ({ ok: true, status: 200, json: async () => ({ scope: "global", messages, archivedCount }) });
const json = (status: number, body: unknown) => ({ ok: status < 400, status, json: async () => body });
const user = (sequence: number, content: string): Message => ({ sequence, role: "user", content, runId: `run-${sequence}` });
const assistant = (sequence: number, content: string): Message => ({ sequence, role: "assistant", content, runId: `run-${sequence - 1}` });

describe("新建对话与切回历史对话", () => {
  it("历史里带着已归档条数；新建对话：POST /new，成功后清空、重读历史", async () => {
    render();
    gets().at(-1)!.resolve(history([user(1, "旧问题"), assistant(2, "旧回答")], 2));
    await flush();
    const loaded = render();
    expect(loaded).toMatchObject({ archivedCount: 2, messages: [expect.objectContaining({ content: "旧问题" }), expect.anything()] });

    const switching = loaded.startNew();
    await flush();
    expect(posts().at(-1)!.url).toBe("/api/conversations/global/new");
    expect(render().switching).toBe(true);
    posts().at(-1)!.resolve(json(200, { conversationId: "c-2", archived: true }));
    await flush();
    expect(render().messages).toEqual([]);
    gets().at(-1)!.resolve(history([], 3));
    expect(await switching).toBe(true);
    const fresh = render();
    expect(fresh).toMatchObject({ messages: [], archivedCount: 3, switching: false, switchError: null, error: null, historyStatus: "ready" });
    expect(fresh.revision).toBe(1);
    expect((window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls.map(([event]) => (event as { type: string }).type)).toContain("conversation-switched");
  });

  it("服务端说上一轮还没结束（409）：不切，已显示的对话不动，只给一句说明", async () => {
    render();
    gets().at(-1)!.resolve(history([user(1, "问题"), assistant(2, "回答")]));
    await flush();
    const switching = render().startNew();
    await flush();
    posts().at(-1)!.resolve(json(409, { code: "TURN_IN_PROGRESS", message: "上一轮回答还没结束" }));
    expect(await switching).toBe(false);
    const view = render();
    expect(view.messages).toHaveLength(2);
    expect(view.switchError).toBe("上一轮回答还没结束，请等它写完或点「停止」后再切换对话。");
    expect(view.switching).toBe(false);
  });

  it("切回一段历史对话：POST 到那一段的 restore；网络断了说清楚，不写英文", async () => {
    render();
    gets().at(-1)!.resolve(history([], 1));
    await flush();
    const switching = render().restoreArchived("c-1");
    await flush();
    expect(posts().at(-1)!.url).toBe("/api/conversations/global/archived/c-1/restore");
    posts().at(-1)!.reject(new TypeError("Failed to fetch"));
    expect(await switching).toBe(false);
    expect(render().switchError).toBe("没有连上天枢服务，对话没有切换，可以稍后再试。");
  });

  it("这一轮走过恢复：done 带回那行说明；读不回历史时本地补上的那条回答也带着它", async () => {
    render();
    gets().at(-1)!.resolve(history([]));
    await flush();
    const note = { text: "本轮中途重连一次，已续写", detail: "原因：和模型服务的网络连接中断了。处理：从断点续写 1 次。" };
    const chunks = [
      `event: message\ndata: ${JSON.stringify({ type: "message", delta: "回答正文", runId: "r1", scope: "global", sequence: 1 })}\n\n`,
      `event: done\ndata: ${JSON.stringify({ type: "done", status: "completed", recoveryNote: note, runId: "r1", scope: "global", sequence: 2 })}\n\n`,
    ];
    let index = 0;
    const encoder = new TextEncoder();
    const sending = render().send("问一个", []);
    await flush();
    posts().at(-1)!.resolve({ ok: true, status: 200, body: { getReader: () => ({
      read: async () => (index < chunks.length ? { done: false, value: encoder.encode(chunks[index++]) } : { done: true, value: undefined }),
      cancel: async () => undefined,
    }) } });
    for (let i = 0; i < 5 && !gets()[1]; i++) await flush();
    gets().at(-1)!.resolve({ ok: false, status: 500, json: async () => ({}) });
    expect(await sending).toBe(true);
    const view = render();
    expect(view.messages.at(-1)).toMatchObject({ role: "assistant", content: "回答正文", recoveryNote: note });
  });
});
