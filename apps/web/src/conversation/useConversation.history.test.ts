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

type Pending = { url: string; init?: RequestInit; resolve: (value: unknown) => void; reject: (cause: unknown) => void; done: boolean };
let requests: Pending[] = [];
/** 服务端已经回了、网络层没理会取消：只能靠 hook 自己丢掉迟到的结果。 */
let ignoreAbort = false;

beforeEach(() => {
  h.states = []; h.refs = []; h.memos = []; h.effects = [];
  requests = []; ignoreAbort = false;
  vi.stubGlobal("window", { dispatchEvent: vi.fn(), location: { assign: vi.fn() } });
  vi.stubGlobal("fetch", vi.fn((url: string, init?: RequestInit) => new Promise((resolve, reject) => {
    const request: Pending = { url, init, done: false,
      resolve: (value) => { request.done = true; resolve(value); }, reject: (cause) => { request.done = true; reject(cause); } };
    requests.push(request);
    init?.signal?.addEventListener("abort", () => { if (!ignoreAbort) request.reject(Object.assign(new Error("aborted"), { name: "AbortError" })); });
  })));
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

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
const flush = () => (vi.isFakeTimers() ? vi.advanceTimersByTimeAsync(0) : new Promise((resolve) => setTimeout(resolve, 0)));
/** 连接类失败 hook 会自己按退避再试：把每次重试都答成同样的失败，拨过重试时限（30 秒）。 */
async function keepFailing(answer: (request: Pending) => void) {
  for (let second = 0; second < 40; second++) {
    for (const request of requests.filter((item) => !item.init?.method && !item.done)) answer(request);
    await vi.advanceTimersByTimeAsync(1_000);
  }
}
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
    [404, "暂无法读取该对话：对象可能已移除，或无查看权限。"],
    [401, "登录状态已失效，请重新进入后再试。"],
  ])("接口返回 %s：要本人处理的失败，直接说原因，不是空历史", async (status, copy) => {
    scope = "global";
    render();
    historyRequest().resolve(failed(status));
    await flush();
    const view = render();
    expect(view).toMatchObject({ historyStatus: "error", historyError: copy, messages: [] });
    expect(view.historyError).not.toMatch(/boom|INTERNAL|\d{3}/);
  });

  it("接口返回 500：先自己按退避重试、仍是载入中；30 秒内都不行才记失败，没有原因文案", async () => {
    vi.useFakeTimers();
    scope = "global";
    render();
    historyRequest().resolve(failed(500));
    await flush();
    expect(render()).toMatchObject({ historyStatus: "loading", historyError: null, historyWaiting: { since: expect.any(Number), offline: false } });
    await keepFailing((request) => request.resolve(failed(500)));
    expect(render()).toMatchObject({ historyStatus: "error", historyError: null, historyWaiting: null, messages: [] });
    // 1、2、4、8、15 秒退避：30 秒里最多读 6 次，不是一直刷。
    expect(requests.filter((request) => !request.init?.method).length).toBeLessThanOrEqual(6);
  });

  it("网络断开：自己重试，网络回来后读到就正常显示，不出现失败", async () => {
    vi.useFakeTimers();
    scope = "global";
    render();
    historyRequest().reject(new TypeError("Failed to fetch"));
    await flush();
    expect(render().historyStatus).toBe("loading");
    await vi.advanceTimersByTimeAsync(1_000);
    historyRequest().resolve(ok([user(1, "上次的问题")]));
    await flush();
    expect(render()).toMatchObject({ historyStatus: "ready", historyError: null, historyWaiting: null, messages: [user(1, "上次的问题")] });
  });
});

describe("重试只重读历史", () => {
  it("失败后重试成功；重试期间已显示的消息和待发附件都在", async () => {
    vi.useFakeTimers();
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
    await keepFailing((request) => request.resolve(failed(503)));
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
  it("保留已显示的对话并接上这次回答；后台接着重读，仍不行才给可重试的提示，不清空", async () => {
    vi.useFakeTimers();
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
    expect(render()).toMatchObject({ status: "complete", partial: "", historyStatus: "ready" });
    await keepFailing((request) => request.resolve(failed(502)));
    const view = render();
    expect(view).toMatchObject({ status: "complete", historyStatus: "error", historyError: null });
    expect(view.messages.map((message) => [message.role, message.content])).toEqual([
      ["user", "早先的问题"], ["assistant", "早先的回答"], ["user", "新的问题"], ["assistant", "新的回答"],
    ]);
  });

  it("服务端没接下这句、重读也失败：撤掉本地那句，返回未接收让输入框放回原文", async () => {
    vi.useFakeTimers();
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
    await keepFailing((request) => request.resolve(failed(500)));
    const view = render();
    expect(view).toMatchObject({ status: "failed", error: "上一轮回答还没结束，请等它写完或点「停止」后再发。", historyStatus: "error", recovery: null });
    // 伙伴对话读回的本人那几句都算读到了（17.4 的两个勾）。
    expect(view.messages).toEqual([{ ...user(1, "早先的问题"), receipt: "read" }]);
  });
});

describe("首页切走、刷新回来：这一轮在服务端照常写，回来接上", () => {
  const RUN = "6f1c1a52-6a60-4f5e-9d36-0d9c3b2d6a11";
  const asked: Message = { sequence: 1, role: "user", content: "王总那边的进展？", runId: RUN };
  const followUrl = `/api/conversations/global/turns/${RUN}/stream`;
  const requestTo = (url: string) => requests.filter((request) => request.url === url).at(-1);
  it("伙伴页面接上排队后才开始的回答，同一轮只订阅一次", async () => {
    scope = "global";
    page();
    render();
    historyRequest().resolve(ok([]));
    await flush();
    const view = render();
    const refresh = view.followLatest();
    const read = historyRequest();
    await view.followLatest();
    expect(historyRequest()).toBe(read);
    read.resolve(ok([{ ...asked, running: true }]));
    await refresh;
    expect(requestTo(followUrl)).toBeDefined();
    await render().followLatest();
    expect(requests.filter(request => request.url === followUrl)).toHaveLength(1);
    expect(requests.some(request => request.init?.method === "POST")).toBe(false);
  });
  /** 页面前后台：visibilitychange 由测试触发。 */
  function page(visibility: "visible" | "hidden" = "visible") {
    const listeners = new Set<() => void>();
    const doc = { visibilityState: visibility, addEventListener: (_type: string, listener: () => void) => listeners.add(listener),
      removeEventListener: (_type: string, listener: () => void) => listeners.delete(listener) };
    vi.stubGlobal("document", doc);
    return { show: () => { doc.visibilityState = "visible"; listeners.forEach((listener) => listener()); } };
  }

  it("刷新回来最后一句还在回答：接上这一轮，进行中一行的用时从这一轮开始算，补发的正文接着写，写完换成读回的回答", async () => {
    scope = "global";
    page();
    render();
    historyRequest().resolve(ok([{ ...asked, running: true }]));
    await flush();
    const follow = requestTo(followUrl)!;
    expect(follow.init?.method).toBeUndefined();
    const startedAt = Date.now() - 40_000;
    const turn = stream([`data: {"type":"route","tier":"grounded","expectSeconds":30,"runId":"${RUN}"}\n\ndata: {"type":"message","delta":"前半段","runId":"${RUN}"}\n\n`,
      `data: {"type":"message","delta":"，后半段","runId":"${RUN}"}\n\ndata: {"type":"done","status":"completed","runId":"${RUN}"}\n\n`]);
    follow.resolve({ ...turn.response, headers: new Headers({ "x-turn-started-at": String(startedAt) }) });
    await flush();
    // 不是一句光秃秃的提问：同样的进行中一行，停止可用。
    expect(render()).toMatchObject({ status: "streaming", streaming: true, startedAt, partial: "前半段" });
    expect(render().messages).toEqual([{ ...asked, running: true, receipt: "read" }]);
    turn.release();
    await flush();
    historyRequest().resolve(ok([asked, { sequence: 2, role: "assistant", content: "前半段，后半段", runId: RUN }]));
    await flush();
    expect(render()).toMatchObject({ status: "complete", partial: "" });
    expect(render().messages.map((message) => message.content)).toEqual(["王总那边的进展？", "前半段，后半段"]);
  });

  it("回到前台时还在回答、服务端这里没有这一轮（服务重启过）：每 3 秒读一次历史，答完换成回答；最后一句不是在回答的不接", async () => {
    vi.useFakeTimers();
    scope = "global";
    const shown = page("hidden");
    render();
    historyRequest().resolve(ok([asked]));
    await flush();
    expect(requestTo(followUrl)).toBeUndefined();
    shown.show();
    historyRequest().resolve(ok([{ ...asked, running: true }]));
    await flush();
    requestTo(followUrl)!.resolve({ ok: true, status: 204, body: null, headers: new Headers() });
    await flush();
    expect(render()).toMatchObject({ status: "streaming", stage: "thinking" });
    await vi.advanceTimersByTimeAsync(3_000);
    historyRequest().resolve(ok([{ ...asked, running: true }]));
    await flush();
    expect(render().status).toBe("streaming");
    await vi.advanceTimersByTimeAsync(3_000);
    historyRequest().resolve(ok([asked, { sequence: 2, role: "assistant", content: "答完了", runId: RUN }]));
    await flush();
    expect(render()).toMatchObject({ status: "complete" });
    expect(render().messages.map((message) => message.content)).toEqual(["王总那边的进展？", "答完了"]);
  });

  it("停止：请服务端停下这一轮（首页 Chat 里断开连接不会停）；还不知道 runId 时等第一条事件带来再停，不先断开", async () => {
    scope = "global";
    page();
    render();
    historyRequest().resolve(ok([]));
    await flush();
    const turn = stream([`data: {"type":"route","tier":"grounded","expectSeconds":30,"runId":"${RUN}"}\n\n`,
      `data: {"type":"done","status":"aborted","runId":"${RUN}"}\n\n`]);
    const sending = render().send("写长一点", []);
    const post = requests.find((request) => request.init?.method === "POST")!;
    // 回应还没回来就点停止：先记下，不断开（断开了这一轮会在服务端接着写）。
    render().stop();
    expect(post.init?.signal?.aborted).toBe(false);
    post.resolve(turn.response);
    await flush();
    const stopUrl = `/api/conversations/global/turns/${RUN}/stop`;
    const stopRequest = requestTo(stopUrl)!;
    expect(stopRequest.init?.method).toBe("POST");
    expect(post.init?.signal?.aborted).toBe(false);
    // Chat 停下后回「已停止」，界面照旧显示已停止。
    turn.release();
    stopRequest.resolve({ ok: true, status: 200, json: async () => ({ runId: RUN, status: "aborted" }) });
    await flush();
    historyRequest().resolve(ok([user(1, "写长一点")]));
    await sending;
    expect(render()).toMatchObject({ status: "aborted", error: "已停止本次回答。" });
  });
});

describe("议题、Mission、战场页的对话：切走回来同样接上这一轮", () => {
  const RUN = "0b7c3f1e-2d4a-4c8b-9a51-7e6d5c4b3a21";
  const ISSUE = "issue:3f2b8c1d-6e4a-4b7f-8c9d-1a2b3c4d5e6f";
  const askedAt = "2026-11-02T12:00:00.000Z";
  const asked: Message = { sequence: 1, role: "user", content: "这个议题卡在哪？", runId: RUN, createdAt: askedAt };
  const turnUrl = (action: "stream" | "stop") => `/api/conversations/${encodeURIComponent(ISSUE)}/turns/${RUN}/${action}`;
  const requestTo = (url: string) => requests.filter((request) => request.url === url).at(-1);
  const noStream = { ok: true, status: 204, body: null, headers: new Headers() };
  function page() {
    vi.stubGlobal("document", { visibilityState: "visible", addEventListener: () => undefined, removeEventListener: () => undefined });
  }

  it("回来时最后一句还在回答：同样的进行中一行（用时从提问时算、停止可用），每 3 秒读一次历史，答完换成回答", async () => {
    vi.useFakeTimers();
    scope = ISSUE;
    page();
    render();
    historyRequest().resolve(ok([{ ...asked, running: true }]));
    await flush();
    // 对象页的对话服务端没有事件流可接（204）：改读历史。
    requestTo(turnUrl("stream"))!.resolve(noStream);
    await flush();
    expect(render()).toMatchObject({ status: "streaming", streaming: true, stage: "thinking", startedAt: Date.parse(askedAt) });
    expect(render().messages).toEqual([{ ...asked, running: true }]);
    await vi.advanceTimersByTimeAsync(3_000);
    historyRequest().resolve(ok([{ ...asked, running: true }]));
    await flush();
    expect(render().status).toBe("streaming");
    await vi.advanceTimersByTimeAsync(3_000);
    historyRequest().resolve(ok([asked, { sequence: 2, role: "assistant", content: "卡在报价确认。", runId: RUN }]));
    await flush();
    expect(render()).toMatchObject({ status: "complete", streaming: false });
    expect(render().messages.map((message) => message.content)).toEqual(["这个议题卡在哪？", "卡在报价确认。"]);
    expect(requestTo(turnUrl("stop"))).toBeUndefined();
  });

  it("停止：先请服务端停下这一轮（断开连接不会停），回来后再断开本地连接", async () => {
    scope = ISSUE;
    page();
    render();
    historyRequest().resolve(ok([]));
    await flush();
    const turn = stream([`data: {"type":"route","tier":"grounded","expectSeconds":30,"runId":"${RUN}"}\n\n`, `data: {"type":"message","delta":"写了一段","runId":"${RUN}"}\n\n`]);
    const sending = render().send("写长一点", []);
    const post = requests.find((request) => request.init?.method === "POST" && request.url.endsWith("/messages"))!;
    post.resolve(turn.response);
    await flush();
    render().stop();
    const stopRequest = requestTo(turnUrl("stop"))!;
    expect(stopRequest.init?.method).toBe("POST");
    expect(post.init?.signal?.aborted).toBe(false);
    stopRequest.resolve({ ok: true, status: 200, json: async () => ({ runId: RUN, status: "aborted" }) });
    await flush();
    expect(post.init?.signal?.aborted).toBe(true);
    turn.release();
    await flush();
    historyRequest().resolve(ok([user(1, "写长一点")]));
    await sending;
    expect(render().status).toBe("aborted");
  });

  it("接着读历史时切走（卸载）：不请服务端停，也不再读历史", async () => {
    vi.useFakeTimers();
    scope = ISSUE;
    page();
    render();
    historyRequest().resolve(ok([{ ...asked, running: true }]));
    await flush();
    requestTo(turnUrl("stream"))!.resolve(noStream);
    await flush();
    expect(render().status).toBe("streaming");
    const reads = requests.filter((request) => !request.init?.method).length;
    unmount();
    await vi.advanceTimersByTimeAsync(9_000);
    expect(requests.filter((request) => !request.init?.method)).toHaveLength(reads);
    expect(requests.filter((request) => request.init?.method === "POST")).toHaveLength(0);
  });
});
