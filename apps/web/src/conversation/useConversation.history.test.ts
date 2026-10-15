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

type Pending = { url: string; init?: RequestInit; resolve: (value: unknown) => void; reject: (cause: unknown) => void };
let requests: Pending[] = [];
/** 服务端已经回了、网络层没理会取消：只能靠 hook 自己丢掉迟到的结果。 */
let ignoreAbort = false;

beforeEach(() => {
  h.states = []; h.refs = []; h.memos = []; h.effects = [];
  requests = []; ignoreAbort = false;
  vi.stubGlobal("window", { dispatchEvent: vi.fn(), location: { assign: vi.fn() } });
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => new Promise((resolve, reject) => {
    requests.push({ url, init, resolve, reject });
    init?.signal?.addEventListener("abort", () => { if (!ignoreAbort) reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
  })));
});
afterEach(() => vi.unstubAllGlobals());

let scope = "global";
/** 渲染一遍并执行排队的 effect；返回这一遍看到的状态。 */
function render() {
  h.stateIndex = 0; h.refIndex = 0; h.memoIndex = 0; h.effectIndex = 0; h.queued = [];
  const result = useConversation(scope);
  const queued = h.queued; h.queued = [];
  queued.forEach((run) => run());
  return result;
}
/** 只读当前状态，不执行 effect（卸载之后用）。 */
function peek() {
  h.stateIndex = 0; h.refIndex = 0; h.memoIndex = 0; h.effectIndex = 0; h.queued = [];
  const result = useConversation(scope);
  h.queued = [];
  return result;
}
function unmount() {
  h.effects.forEach((slot) => { if (typeof slot?.cleanup === "function") slot.cleanup(); });
  h.effects = [];
}
const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const historyRequest = (index = -1) => requests.filter((request) => !request.init?.method).at(index)!;
const ok = (messages: Message[]) => ({ ok: true, status: 200, json: async () => ({ scope, messages }) });
const failed = (status: number) => ({ ok: false, status, json: async () => ({ code: "INTERNAL", message: "boom" }) });
const user = (sequence: number, content: string): Message => ({ sequence, role: "user", content });
const assistant = (sequence: number, content: string): Message => ({ sequence, role: "assistant", content });
function stream(chunks: string[]) {
  const encoder = new TextEncoder();
  let index = 0;
  let release!: () => void;
  const gate = new Promise<void>((resolve) => { release = resolve; });
  return {
    release,
    response: { ok: true, status: 200, body: { getReader: () => ({ read: async () => {
      if (index === 1) await gate; // 第一段之后停住，等测试放行
      if (index >= chunks.length) return { done: true, value: undefined };
      return { done: false, value: encoder.encode(chunks[index++]) };
    } }) } },
  };
}

describe("对话历史：载入中、真的没有、没读到是三种状态", () => {
  it("首次渲染即是载入中（不是空历史），读到 0 条才是真的没有记录", async () => {
    scope = "issue:issue-01";
    const first = render();
    expect(first.historyStatus).toBe("loading");
    expect(first.messages).toEqual([]);
    expect(historyRequest().url).toBe("/api/conversations/issue%3Aissue-01/messages");
    historyRequest().resolve(ok([]));
    await flush();
    expect(render()).toMatchObject({ historyStatus: "ready", historyError: null, messages: [] });
  });

  it.each([
    [500, "天枢服务读取对话记录时出错（已记录），可以点重试。"],
    [404, "暂无法读取该对话：对象可能已移除，或无查看权限。"],
    [401, "登录状态已失效，请重新进入后再试。"],
  ])("接口返回 %s：是可重试的失败，不是空历史", async (status, copy) => {
    scope = "global";
    render();
    historyRequest().resolve(failed(status));
    await flush();
    const view = render();
    expect(view).toMatchObject({ historyStatus: "error", historyError: copy, messages: [] });
    expect(view.historyError).not.toMatch(/boom|INTERNAL|\d{3}/);
  });

  it("网络断开同样记为失败", async () => {
    scope = "global";
    render();
    historyRequest().reject(new TypeError("Failed to fetch"));
    await flush();
    expect(render()).toMatchObject({ historyStatus: "error", historyError: "没有连上天枢服务，对话记录没读出来，可以点重试。" });
  });
});

describe("重试只重读历史", () => {
  it("失败后重试成功；重试期间已显示的消息和待发附件都在", async () => {
    scope = "issue:issue-01";
    render();
    historyRequest().resolve(ok([user(1, "上次的问题"), assistant(2, "上次的回答")]));
    await flush();
    // 先挂一份待发附件。
    const uploading = render().uploadFiles([{ name: "brief.pdf" } as File]);
    requests.find((request) => request.init?.method === "POST")!.resolve({ ok: true, status: 200,
      json: async () => ({ attachments: [{ id: "att-1", fileName: "brief.pdf", mimeType: "application/pdf" }] }) });
    await uploading;
    // 再一次读取失败：已显示的消息不清空。
    render().retryHistory();
    historyRequest().resolve(failed(503));
    await flush();
    expect(render()).toMatchObject({ historyStatus: "error", messages: [user(1, "上次的问题"), assistant(2, "上次的回答")] });
    expect(render().attachments).toEqual([{ id: "att-1", fileName: "brief.pdf", mimeType: "application/pdf" }]);
    // 重试：载入中也不清空，读到后换成服务端的全部。
    render().retryHistory();
    expect(render()).toMatchObject({ historyStatus: "loading", historyError: null });
    expect(render().messages).toHaveLength(2);
    historyRequest().resolve(ok([user(1, "上次的问题"), assistant(2, "上次的回答"), user(3, "后来在别处问的")]));
    await flush();
    const view = render();
    expect(view).toMatchObject({ historyStatus: "ready", historyError: null });
    expect(view.messages).toHaveLength(3);
    expect(view.attachments).toHaveLength(1);
  });

  it("回答流式进行中重试：不覆盖流式文字，刚发出的那句不重复", async () => {
    scope = "global";
    render();
    historyRequest().resolve(failed(500));
    await flush();
    const turn = stream(['data: {"type":"message","delta":"首段。"}\n\n', 'data: {"type":"done","status":"completed"}\n\n']);
    const sending = render().send("帮我看看本月目标", []);
    requests.find((request) => request.init?.method === "POST")!.resolve(turn.response);
    await flush();
    expect(render()).toMatchObject({ status: "streaming", partial: "首段。" });
    // 历史只读到了更早的记录：刚发出的那句补在最后。
    render().retryHistory();
    historyRequest().resolve(ok([user(1, "早先的问题"), assistant(2, "早先的回答")]));
    await flush();
    expect(render()).toMatchObject({ status: "streaming", partial: "首段。", historyStatus: "ready" });
    expect(render().messages.map((message) => message.content)).toEqual(["早先的问题", "早先的回答", "帮我看看本月目标"]);
    // 再读一次，这次服务端已经存下这句：不重复。
    render().retryHistory();
    historyRequest().resolve(ok([user(1, "早先的问题"), assistant(2, "早先的回答"), user(3, "帮我看看本月目标")]));
    await flush();
    expect(render().messages.map((message) => message.content)).toEqual(["早先的问题", "早先的回答", "帮我看看本月目标"]);
    expect(render().partial).toBe("首段。");
    // 回答完成后的重读给出最终记录。
    turn.release();
    await flush();
    historyRequest().resolve(ok([user(1, "早先的问题"), assistant(2, "早先的回答"), user(3, "帮我看看本月目标"), assistant(4, "首段。")]));
    expect(await sending).toBe(true);
    expect(render()).toMatchObject({ status: "complete", partial: "", historyStatus: "ready" });
    expect(render().messages).toHaveLength(4);
  });
});

describe("换对象与卸载：迟到的结果不串进来", () => {
  it("A 的历史在切到 B 之后才回来，不写进 B", async () => {
    ignoreAbort = true;
    scope = "issue:a";
    render();
    const late = historyRequest();
    scope = "issue:b";
    render();
    expect(historyRequest().url).toBe("/api/conversations/issue%3Ab/messages");
    expect(late.init?.signal?.aborted).toBe(true);
    historyRequest().resolve(ok([user(1, "B 的问题")]));
    await flush();
    late.resolve(ok([user(1, "A 的问题"), assistant(2, "A 的回答")]));
    await flush();
    const view = render();
    expect(view.messages).toEqual([user(1, "B 的问题")]);
    expect(view.historyStatus).toBe("ready");
  });

  it("A 读取失败迟到也不把 B 标成失败", async () => {
    ignoreAbort = true;
    scope = "issue:a";
    render();
    const late = historyRequest();
    scope = "issue:b";
    render();
    historyRequest().resolve(ok([]));
    await flush();
    late.resolve(failed(500));
    await flush();
    expect(render()).toMatchObject({ historyStatus: "ready", historyError: null, messages: [] });
  });

  it("A 的一轮回答在切到 B 后才结束：流式文字、状态和重读都不进 B，停止键也不再指向它", async () => {
    scope = "issue:a";
    render();
    historyRequest().resolve(ok([]));
    await flush();
    const turn = stream(['data: {"type":"message","delta":"A 的回答"}\n\n', 'data: {"type":"done","status":"completed"}\n\n']);
    const sending = render().send("问 A", []);
    const post = requests.find((request) => request.init?.method === "POST")!;
    post.resolve(turn.response);
    await flush();
    scope = "issue:b";
    render();
    historyRequest().resolve(ok([user(1, "B 的问题")]));
    await flush();
    render().stop();
    expect(post.init?.signal?.aborted).toBe(false);
    turn.release();
    expect(await sending).toBe(true);
    const view = render();
    expect(view).toMatchObject({ status: "idle", partial: "", lastReply: null, historyStatus: "ready" });
    expect(view.messages).toEqual([user(1, "B 的问题")]);
    expect(requests.filter((request) => !request.init?.method)).toHaveLength(2);
  });

  it("卸载后迟到的历史不改状态", async () => {
    ignoreAbort = true;
    scope = "global";
    render();
    const late = historyRequest();
    unmount();
    expect(late.init?.signal?.aborted).toBe(true);
    late.resolve(ok([user(1, "迟到的消息")]));
    await flush();
    expect(peek()).toMatchObject({ historyStatus: "loading", messages: [] });
  });
});

describe("发送后的重读失败", () => {
  it("保留已显示的对话并接上这次回答，给出可重试的提示而不是清空", async () => {
    scope = "global";
    render();
    historyRequest().resolve(ok([user(1, "早先的问题"), assistant(2, "早先的回答")]));
    await flush();
    const turn = stream(['data: {"type":"message","delta":"新的回答"}\n\n', 'data: {"type":"done","status":"completed"}\n\n']);
    const sending = render().send("新的问题", []);
    requests.find((request) => request.init?.method === "POST")!.resolve(turn.response);
    await flush();
    turn.release();
    await flush();
    historyRequest().resolve(failed(502));
    expect(await sending).toBe(true);
    const view = render();
    expect(view).toMatchObject({ status: "complete", partial: "", historyStatus: "error", historyError: "天枢服务读取对话记录时出错（已记录），可以点重试。" });
    expect(view.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "早先的问题"], ["assistant", "早先的回答"], ["user", "新的问题"], ["assistant", "新的回答"],
    ]);
  });

  it("服务端没接下这句、重读也失败：撤掉本地那句，返回未接收让输入框放回原文", async () => {
    scope = "global";
    render();
    historyRequest().resolve(ok([user(1, "早先的问题")]));
    await flush();
    const sending = render().send("又问一次", []);
    requests.find((request) => request.init?.method === "POST")!.resolve({ ok: false, status: 409, body: null,
      json: async () => ({ code: "TURN_IN_PROGRESS", message: "该 Conversation 正在运行" }) });
    await flush();
    historyRequest().resolve(failed(500));
    expect(await sending).toBe(false);
    const view = render();
    expect(view).toMatchObject({ status: "failed", error: "上一轮回答还没结束，请等它写完或点「停止」后再发。", historyStatus: "error", recovery: null });
    expect(view.messages).toEqual([user(1, "早先的问题")]);
  });
});
