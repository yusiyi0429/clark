import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, refs: [] as { current: unknown }[], refCursor: 0 }));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
  useRef: (initial: unknown) => state.refs[state.refCursor++] ??= { current: initial },
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.values)) state.values[index] = initial;
    return [state.values[index], (next: unknown) => {
      state.values[index] = typeof next === "function" ? next(state.values[index]) : next;
    }];
  },
}));
import { useConversation } from "./useConversation";

beforeEach(() => {
  state.values = []; state.refs = [];
  vi.stubGlobal("window", { dispatchEvent: vi.fn(), location: { assign: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());

function snapshot() {
  state.cursor = 0; state.refCursor = 0;
  return useConversation("global");
}

describe("真实 SSE 分段进入对话", () => {
  it("模型拒绝回答后保留已保存的用户请求，中文通知不推断修改是否完成", async () => {
    const input = "请修改当前判断";
    const response = { ok: true, status: 200, body: { getReader: () => ({ read: async () => ({
      done: false, value: new TextEncoder().encode('data: {"type":"error","code":"CONTENT_FILTER","message":"Provider rejected request: content_filter"}\n\n'),
    }) }) } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce({
      ok: true, json: async () => ({ messages: [{ sequence: 1, role: "user", content: input }] }),
    }));
    expect(await snapshot().send(input, [])).toBe(true);
    const failed = snapshot();
    expect(failed).toMatchObject({ status: "failed", partial: "", lastReply: null });
    expect(failed.messages).toEqual([{ sequence: 1, role: "user", content: input, receipt: "read" }]);
    expect(failed.error).toBe("模型服务没有受理这次请求（内容审核未通过）。问题已保留，可以换个说法后重试。");
    // 换个说法才有用：不给「重新回答」。
    expect(failed.recovery).toBeNull();
    expect(failed.error).not.toMatch(/Provider|content_filter|没有接通|未完成修改|已修改/);
  });

  it("首段在下一段和done之前可见，重读历史期间保留完整文字，完成后不重复", async () => {
    const encoder = new TextEncoder();
    let nextChunk!: (value: { done: boolean; value?: Uint8Array }) => void;
    let history!: (value: unknown) => void;
    let reads = 0;
    const response = { ok: true, status: 200, body: { getReader: () => ({ read: () => {
      reads++;
      if (reads === 1) return Promise.resolve({ done: false, value: encoder.encode('data: {"type":"message","delta":"首段。"}\n\n') });
      if (reads === 2) return new Promise((resolve) => { nextChunk = resolve; });
      return Promise.resolve({ done: true });
    } }) } };
    const fetchMock = vi.fn().mockResolvedValueOnce(response).mockImplementationOnce(() => new Promise((resolve) => { history = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const sending = snapshot().send("开始回答", []);
    await vi.waitFor(() => expect(reads).toBe(2));
    expect(snapshot()).toMatchObject({ status: "streaming", partial: "首段。", stage: "answering" });
    nextChunk({ done: false, value: encoder.encode('data: {"type":"message","delta":"末段。"}\n\ndata: {"type":"done","status":"completed"}\n\n') });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    expect(snapshot()).toMatchObject({ status: "streaming", partial: "首段。末段。" });
    history({ ok: true, json: async () => ({ messages: [
      { sequence: 1, role: "user", content: "开始回答" },
      { sequence: 2, role: "assistant", content: "首段。末段。" },
    ] }) });
    expect(await sending).toBe(true);
    expect(snapshot()).toMatchObject({ status: "complete", partial: "", lastReply: { text: "首段。末段。" } });
    expect(snapshot().messages).toHaveLength(2);
  });
  it("收到 done 就撤掉「正在整理回答」：连接迟迟不关也不再等，立刻重读历史并完成", async () => {
    const encoder = new TextEncoder();
    let reads = 0;
    const cancel = vi.fn(async () => undefined);
    let history!: (value: unknown) => void;
    const response = { ok: true, status: 200, body: { getReader: () => ({ cancel, read: () => {
      reads++;
      if (reads === 1) return Promise.resolve({ done: false, value: encoder.encode('data: {"type":"message","delta":"回答正文。"}\n\ndata: {"type":"usage","input":1,"output":1,"cacheRead":0,"cacheWrite":0,"totalTokens":2}\n\ndata: {"type":"done","status":"completed"}\n\n') });
      // 服务端或代理在 done 之后迟迟不关连接：这一读永远不回来。
      return new Promise(() => undefined);
    } }) } };
    const fetchMock = vi.fn().mockResolvedValueOnce(response).mockImplementationOnce(() => new Promise((resolve) => { history = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const sending = snapshot().send("最让我担心哪家", []);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // 正文已经完整：阶段提示撤掉，文字留着直到历史读回。
    expect(snapshot()).toMatchObject({ thinking: false, partial: "回答正文。" });
    expect(cancel).toHaveBeenCalled();
    history({ ok: true, json: async () => ({ messages: [
      { sequence: 1, role: "user", content: "最让我担心哪家" },
      { sequence: 2, role: "assistant", content: "回答正文。" },
    ] }) });
    expect(await sending).toBe(true);
    expect(snapshot()).toMatchObject({ status: "complete", thinking: false, partial: "" });
  });

  it("回答进行中（还没 done）阶段提示一直在", async () => {
    const encoder = new TextEncoder();
    let reads = 0;
    const response = { ok: true, status: 200, body: { getReader: () => ({ read: () => {
      reads++;
      if (reads === 1) return Promise.resolve({ done: false, value: encoder.encode('data: {"type":"message","delta":"首段。"}\n\n') });
      return new Promise(() => undefined);
    } }) } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response));
    void snapshot().send("开始", []);
    await vi.waitFor(() => expect(reads).toBe(2));
    expect(snapshot()).toMatchObject({ status: "streaming", thinking: true, stage: "answering" });
  });

  it("同一帧里到达的多段只渲染一次；完成时先补上没画出的字，再重读历史", async () => {
    const frames: (FrameRequestCallback | null)[] = [];
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
    vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames[id - 1] = null; });
    const runFrames = () => frames.splice(0).forEach((callback) => callback?.(0));
    const encoder = new TextEncoder();
    let finish!: (value: { done: boolean; value?: Uint8Array }) => void;
    let history!: (value: unknown) => void;
    let reads = 0;
    const response = { ok: true, status: 200, body: { getReader: () => ({ read: () => {
      reads++;
      if (reads === 1) return Promise.resolve({ done: false, value: encoder.encode('data: {"type":"message","delta":"首段。"}\n\ndata: {"type":"message","delta":"次段。"}\n\n') });
      if (reads === 2) return Promise.resolve({ done: false, value: encoder.encode('data: {"type":"message","delta":"三段。"}\n\n') });
      if (reads === 3) return new Promise((resolve) => { finish = resolve; });
      return Promise.resolve({ done: true });
    } }) } };
    const fetchMock = vi.fn().mockResolvedValueOnce(response).mockImplementationOnce(() => new Promise((resolve) => { history = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const sending = snapshot().send("开始回答", []);
    await vi.waitFor(() => expect(reads).toBe(3));
    // 两次网络读、三段文字：还没到下一帧，一个字都不画；整段只排了一帧。
    expect(snapshot().partial).toBe("");
    expect(frames).toHaveLength(1);
    runFrames();
    expect(snapshot()).toMatchObject({ status: "streaming", partial: "首段。次段。三段。", stage: "answering" });
    finish({ done: false, value: encoder.encode('data: {"type":"message","delta":"末段。"}\n\ndata: {"type":"done","status":"completed"}\n\n') });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    // 没等下一帧：结束时直接补齐，重读历史期间显示完整回答。
    expect(snapshot().partial).toBe("首段。次段。三段。末段。");
    history({ ok: true, json: async () => ({ messages: [
      { sequence: 1, role: "user", content: "开始回答" },
      { sequence: 2, role: "assistant", content: "首段。次段。三段。末段。" },
    ] }) });
    expect(await sending).toBe(true);
    runFrames();
    expect(snapshot()).toMatchObject({ status: "complete", partial: "", lastReply: { text: "首段。次段。三段。末段。" } });
  });
});

describe("带引用发送：提问气泡立刻带上引用", () => {
  it("发出的那一刻用户消息就有引用快照与附件，请求里只发 cardId / version，读回历史后形态一致", async () => {
    let history!: (value: unknown) => void;
    let release!: (value: { done: boolean; value?: Uint8Array }) => void;
    const response = { ok: true, status: 200, body: { getReader: () => ({ read: () => new Promise((resolve) => { release = resolve; }) }) } };
    const fetchMock = vi.fn().mockResolvedValueOnce(response).mockImplementationOnce(() => new Promise((resolve) => { history = resolve; }));
    vi.stubGlobal("fetch", fetchMock);
    const sending = snapshot().send("这个议题怎么推进？", [{ cardId: "card-7", version: 3, kind: "issue", title: "华东回款节奏" }]);
    const sent = snapshot().messages.at(-1);
    expect(sent).toMatchObject({ role: "user", content: "这个议题怎么推进？", referencesSnapshot: [{ cardId: "card-7", version: 3, kind: "issue", title: "华东回款节奏" }] });
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    expect(JSON.parse((fetchMock.mock.calls[0][1] as { body: string }).body).references).toEqual([{ cardId: "card-7", version: 3 }]);
    release({ done: false, value: new TextEncoder().encode('data: {"type":"message","delta":"先说结论。"}\n\ndata: {"type":"done","status":"completed"}\n\n') });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    history({ ok: true, json: async () => ({ messages: [
      { sequence: 1, role: "user", content: "这个议题怎么推进？", referencesSnapshot: [{ cardId: "card-7", version: 3, kind: "issue", title: "华东回款节奏" }] },
      { sequence: 2, role: "assistant", content: "先说结论。" },
    ] }) });
    expect(await sending).toBe(true);
    expect(snapshot().messages[0].referencesSnapshot).toEqual(sent?.referencesSnapshot);
  });

  it("回答进行中读回的历史还没有这句时，补上的那句仍带着引用", async () => {
    const { withPendingTurn, pendingUserMessage } = await import("./useConversation");
    const pending = pendingUserMessage(0, "问一句", [{ cardId: "c", version: 1, kind: "issue", title: "议题甲" }], [{ id: "a", fileName: "纪要.md", mimeType: "text/markdown" }]);
    const merged = withPendingTurn([{ sequence: 4, role: "assistant", content: "上一轮" }], pending);
    expect(merged.at(-1)).toMatchObject({ sequence: 5, content: "问一句", referencesSnapshot: [{ title: "议题甲" }], attachments: [{ fileName: "纪要.md" }] });
  });
});

describe("伙伴对话流里的回执、计划清单、界面效果、卡（17.4）", () => {
  it("计划清单后一条取代前一条；ui 事件发给页面；卡挂在这一轮上；读回的本人那句是已读", async () => {
    const events = [
      { type: "receipt", state: "delivered", messageId: "m1" }, { type: "receipt", state: "read", messageId: "m1" },
      { type: "plan", plan: { entries: [{ content: "归档", status: "in_progress" }, { content: "转达", status: "pending" }], collapsed: false } },
      { type: "plan", plan: { entries: [{ content: "归档", status: "completed" }, { content: "转达", status: "in_progress" }], collapsed: false } },
      { type: "ui", ui: { kind: "appearance", appearance: "dark" } },
      { type: "card", card: { kind: "buddy_message", draftId: "00000000-0000-4000-8000-0000000000a1" } },
      { type: "message", delta: "好的" }, { type: "done", status: "completed" },
    ].map((event) => `data: ${JSON.stringify({ ...event, runId: "r1" })}\n\n`).join("");
    let sent = false;
    const response = { ok: true, status: 200, body: { getReader: () => ({ read: async () => (sent ? { done: true, value: undefined } : (sent = true, { done: false, value: new TextEncoder().encode(events) })) }) } };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce({
      ok: true, json: async () => ({ messages: [{ sequence: 1, role: "user", content: "归档再转达" }, { sequence: 2, role: "assistant", content: "好的", runId: "r1" }] }),
    }));
    expect(await snapshot().send("归档再转达", [])).toBe(true);
    const view = snapshot();
    expect(view.plan?.entries.map((entry) => entry.status)).toEqual(["completed", "in_progress"]);
    expect(view.turnCards).toEqual([{ kind: "buddy_message", draftId: "00000000-0000-4000-8000-0000000000a1" }]);
    const ui = (window.dispatchEvent as ReturnType<typeof vi.fn>).mock.calls.map(([event]) => event as CustomEvent).find((event) => event.type === "buddy-ui");
    expect(ui?.detail).toEqual({ kind: "appearance", appearance: "dark" });
    expect(view.messages[0]).toMatchObject({ role: "user", receipt: "read" });
  });
});

describe("两个勾的取法（17.4，契约 06e5ae77）", () => {
  const frame = (event: Record<string, unknown>) => new TextEncoder().encode(`data: ${JSON.stringify(event)}

`);
  const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

  it("中途插话：delivered（不带 runId）先亮第一个勾，新一轮开了 read（带 runId）亮第二个，两帧按 messageId 对上", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const frames = [frame({ type: "receipt", state: "delivered", messageId: "m2" }), frame({ type: "receipt", state: "read", messageId: "m2", runId: "r2" }),
      frame({ type: "message", delta: "好", runId: "r2" }), frame({ type: "done", status: "completed", runId: "r2" })];
    let step = 0;
    const read = async () => {
      if (step === 1) await gate;
      const value = frames[step++];
      return value ? { done: false, value } : { done: true, value: undefined };
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, status: 200, body: { getReader: () => ({ read }) } })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [{ sequence: 1, role: "user", content: "停一下" }] }) }));
    const sending = snapshot().send("停一下", []);
    await tick();
    expect(snapshot().messages.at(-1)).toMatchObject({ role: "user", receipt: "delivered", messageId: "m2" });
    release();
    await sending;
    expect(snapshot().messages[0]).toMatchObject({ role: "user", receipt: "read" });
  });

  it("delivered 以后没开成（流里一帧 error，不带 runId）：撤掉第一个勾，这句标成 failed（旁边给「重发」）", async () => {
    const frames = [frame({ type: "receipt", state: "delivered", messageId: "m3" }), frame({ type: "error", code: "CHAT_UNAVAILABLE", message: "对话服务暂时不可用" })];
    let step = 0;
    const read = async () => { const value = frames[step++]; return value ? { done: false, value } : { done: true, value: undefined }; };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, status: 200, body: { getReader: () => ({ read }) } })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [{ sequence: 1, role: "user", content: "停一下" }] }) }));
    await snapshot().send("停一下", []);
    expect(snapshot().messages).toEqual([{ sequence: 1, role: "user", content: "停一下", receipt: "failed", messageId: "m3" }]);
  });
});
