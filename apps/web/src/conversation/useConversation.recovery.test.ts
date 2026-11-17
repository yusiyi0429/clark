import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 10/13 P0：一号位看着回答快写完时整条消失，只剩一句「对话服务暂不可用，页面操作不受影响。」
 * 不管这一轮怎么结束（服务端报错、连接中途断开、一直没数据、一号位停止），已经写出的正文和思考都留在界面上，
 * 说明具体到哪一环出了问题，能接着来的给「继续」/「重新回答」。
 */
const state = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, refs: [] as { current: unknown }[], refCursor: 0 }));
vi.mock("react", () => {
  return {
    useCallback: (callback: unknown) => callback,
    useEffect: () => {},
    useRef: (initial: unknown) => state.refs[state.refCursor++] ??= { current: initial },
    useState: (initial: unknown) => {
      const index = state.cursor++;
      if (!(index in state.values)) state.values[index] = initial;
      return [state.values[index], (next: unknown) => {
        state.values[index] = typeof next === "function" ? (next as (value: unknown) => unknown)(state.values[index]) : next;
      }];
    },
  };
});
import { STREAM_SILENCE_MS, useConversation } from "./useConversation";

beforeEach(() => {
  state.values = []; state.refs = [];
  vi.stubGlobal("window", { dispatchEvent: vi.fn(), location: { assign: vi.fn() } });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

function snapshot() {
  state.cursor = 0; state.refCursor = 0;
  return useConversation("global");
}
const RUN = "6f1c1a52-6a60-4f5e-9d36-0d9c3b2d6a11";
const encoder = new TextEncoder();
const sse = (...events: Record<string, unknown>[]) => encoder.encode(events.map((event) => `data: ${JSON.stringify({ runId: RUN, ...event })}\n\n`).join(""));
/** 按给定的读取结果依次返回；最后一个之后由 tail 决定（结束 / 抛错 / 永远不回来）。 */
function streamResponse(chunks: Uint8Array[], tail: "end" | Error | "hang" = "end") {
  let index = 0;
  return { ok: true, status: 200, body: { getReader: () => ({
    cancel: vi.fn(async () => undefined),
    read: () => {
      if (index < chunks.length) return Promise.resolve({ done: false, value: chunks[index++] });
      if (tail === "end") return Promise.resolve({ done: true, value: undefined });
      if (tail === "hang") return new Promise(() => undefined);
      return Promise.reject(tail);
    },
  }) } };
}
const history = (messages: unknown[]) => ({ ok: true, json: async () => ({ messages }) });
/** 接上那一轮时服务端这里没有它（天枢自己的对话、服务重启过）：204，照旧自动「继续」。 */
const notFollowing = { ok: true, status: 204, body: null, headers: new Headers() };
const followUrl = `/api/conversations/global/turns/${RUN}/stream`;

describe("一轮没完成时，已经写出的内容留在界面上", () => {
  it("服务端报错（网络中断、已存档）：读回的历史里有那条半截回答，说明是服务端的中文，给「继续」，按钮接上那一轮", async () => {
    const saved = "第一段判断，写到一半\n\n（这次回答在这里中断了，以上是已经写出的部分。）";
    const copy = "和模型服务的网络连接中断了，已自动恢复 3 次仍未成功（多半是本机网络或代理切换）。已写出的部分保留在上方，点「继续」从断点接着写。";
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse([sse({ type: "thinking", delta: "先想清楚对标。" }), sse({ type: "message", delta: "第一段判断，" }), sse({ type: "message", delta: "写到一半" }),
        sse({ type: "error", code: "NETWORK_INTERRUPTED", message: copy, resume: "continue", partial: true })]))
      .mockResolvedValueOnce(history([{ sequence: 1, role: "user", content: "集团该怎么定位？", runId: RUN }, { sequence: 2, role: "assistant", content: saved, runId: RUN }]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await snapshot().send("集团该怎么定位？", [])).toBe(true);
    const view = snapshot();
    expect(view.status).toBe("failed");
    expect(view.messages.map((message) => message.content)).toEqual(["集团该怎么定位？", saved]);
    expect(view.error).toBe(copy);
    expect(view.thought).toMatchObject({ text: "先想清楚对标。" });
    expect(view.recovery).toMatchObject({ mode: "continue", label: "继续" });

    // 点「继续」：发「继续」，带上那一轮的 runId，不带页面前缀。
    fetchMock.mockResolvedValueOnce(streamResponse([sse({ type: "message", delta: "接着写完。" }), sse({ type: "done", status: "completed" })]))
      .mockResolvedValueOnce(history([]));
    view.recovery!.run();
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(4));
    expect(JSON.parse((fetchMock.mock.calls[2][1] as { body: string }).body)).toMatchObject({ message: "继续", resumeRunId: RUN });
  });

  it("连接在回答途中断开：进度行写「正在连接」，连上后自动「继续」（带那一轮的 runId），本人不用点", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse([sse({ type: "message", delta: "第一段" })], new TypeError("network error")))
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(history([{ sequence: 1, role: "user", content: "问题", runId: RUN }]))
      .mockResolvedValueOnce(notFollowing)
      .mockResolvedValueOnce(streamResponse([sse({ type: "message", delta: "接着写完。" }), sse({ type: "done", status: "completed" })]))
      .mockResolvedValueOnce(history([]));
    vi.stubGlobal("fetch", fetchMock);
    let settled = false;
    const sending = snapshot().send("问题", []).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot()).toMatchObject({ status: "streaming", stage: "connecting", error: null, recovery: null });
    for (let step = 0; step < 10 && !settled; step += 1) await vi.advanceTimersByTimeAsync(1_000);
    expect(await sending).toBe(true);
    expect(fetchMock.mock.calls[3][0]).toBe(followUrl);
    expect(JSON.parse((fetchMock.mock.calls[4][1] as { body: string }).body)).toMatchObject({ message: "继续", resumeRunId: RUN });
    expect(snapshot()).toMatchObject({ status: "complete", error: null });
  });

  it("首页 Chat：回答途中连接断了，这一轮在服务端照常写：连上后接上它、补发的正文写到完，不发「继续」", async () => {
    vi.useFakeTimers();
    const asked = { sequence: 1, role: "user", content: "问题", runId: RUN, running: true };
    const followed = { ...streamResponse([sse({ type: "route", tier: "grounded", expectSeconds: 30 }), sse({ type: "message", delta: "第一段" }),
      sse({ type: "message", delta: "，第二段" }), sse({ type: "done", status: "completed" })]), headers: new Headers({ "x-turn-started-at": String(Date.now()) }) };
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse([sse({ type: "message", delta: "第一段" })], new TypeError("network error")))
      .mockResolvedValueOnce(history([asked]))
      .mockResolvedValueOnce(history([asked]))
      .mockResolvedValueOnce(followed)
      .mockResolvedValueOnce(history([{ ...asked, running: undefined }, { sequence: 2, role: "assistant", content: "第一段，第二段", runId: RUN }]));
    vi.stubGlobal("fetch", fetchMock);
    let settled = false;
    const sending = snapshot().send("问题", []).finally(() => { settled = true; });
    for (let step = 0; step < 10 && !settled; step += 1) await vi.advanceTimersByTimeAsync(1_000);
    expect(await sending).toBe(true);
    expect(fetchMock.mock.calls[3][0]).toBe(followUrl);
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toHaveLength(1);
    const view = snapshot();
    expect(view).toMatchObject({ status: "complete", error: null, recovery: null, partial: "" });
    expect(view.messages.map((message) => message.content)).toEqual(["问题", "第一段，第二段"]);
  });

  it("回答途中连接断了，连上时服务端已写完、没有事件流可接（对象页的对话）：显示读回的回答，不发「继续」", async () => {
    vi.useFakeTimers();
    const answered = history([{ sequence: 1, role: "user", content: "问题", runId: RUN }, { sequence: 2, role: "assistant", content: "第一段，写完了", runId: RUN }]);
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse([sse({ type: "message", delta: "第一段" })], new TypeError("network error")))
      .mockResolvedValueOnce(answered)
      .mockResolvedValueOnce(answered)
      .mockResolvedValueOnce(notFollowing);
    vi.stubGlobal("fetch", fetchMock);
    let settled = false;
    const sending = snapshot().send("问题", []).finally(() => { settled = true; });
    for (let step = 0; step < 10 && !settled; step += 1) await vi.advanceTimersByTimeAsync(1_000);
    expect(await sending).toBe(true);
    expect(fetchMock.mock.calls[3][0]).toBe(followUrl);
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toHaveLength(1);
    const view = snapshot();
    expect(view).toMatchObject({ status: "complete", error: null, recovery: null });
    expect(view.messages.map((message) => message.content)).toEqual(["问题", "第一段，写完了"]);
  });

  it("服务停机前先存了档（SERVER_RESTARTING）：连上新实例后自动接着写", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(streamResponse([sse({ type: "message", delta: "写到一半" }),
        sse({ type: "error", code: "SERVER_RESTARTING", message: "天枢服务在更新。已写出的部分保留在上方，点「继续」从断点接着写。", resume: "continue", partial: true })]))
      .mockResolvedValueOnce(history([{ sequence: 1, role: "user", content: "问题", runId: RUN }, { sequence: 2, role: "assistant", content: "写到一半\n\n（这次回答在这里中断了，以上是已经写出的部分。）", runId: RUN }]))
      .mockResolvedValueOnce(history([{ sequence: 1, role: "user", content: "问题", runId: RUN }, { sequence: 2, role: "assistant", content: "写到一半", runId: RUN }]))
      .mockResolvedValueOnce(notFollowing)
      .mockResolvedValueOnce(streamResponse([sse({ type: "message", delta: "写完。" }), sse({ type: "done", status: "completed" })]))
      .mockResolvedValueOnce(history([]));
    vi.stubGlobal("fetch", fetchMock);
    const sending = snapshot().send("问题", []);
    await vi.advanceTimersByTimeAsync(2_000);
    expect(await sending).toBe(true);
    expect(fetchMock.mock.calls[3][0]).toBe(followUrl);
    expect(JSON.parse((fetchMock.mock.calls[4][1] as { body: string }).body)).toMatchObject({ message: "继续", resumeRunId: RUN });
    expect(snapshot().status).toBe("complete");
  });

  it("一分钟内都没连上：在本地补上这条半截回答和一句说明，这时才给「继续」", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(streamResponse([sse({ type: "route", tier: "grounded", expectSeconds: 30, notice: "需要先查证企业知识和公开来源再作答。" }),
        sse({ type: "message", delta: "硅基流动 9 月完成融资" })], new TypeError("network error")))
      .mockRejectedValue(new TypeError("Failed to fetch")));
    const sending = snapshot().send("硅基流动最近融资？", []);
    await vi.advanceTimersByTimeAsync(70_000);
    expect(await sending).toBe(true);
    const view = snapshot();
    expect(view.messages.at(-1)).toMatchObject({ role: "assistant", runId: RUN,
      content: "需要先查证企业知识和公开来源再作答。\n\n硅基流动 9 月完成融资\n\n（连接在这里中断了，以上是已经写出的部分。）" });
    expect(view.error).toBe("连接中断了。已写出的部分保留在上方，点「继续」从断点接着写。");
    expect(view.error).not.toMatch(/暂不可用|network|服务出错|已记录/);
    expect(view.recovery).toMatchObject({ mode: "continue" });
    expect(view.partial).toBe("");
  });

  it("等连上时点「停止」：不再自动接，按停止处理，已写出的部分可以「继续」", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(streamResponse([sse({ type: "message", delta: "写了一段" })], new TypeError("network error")))
      .mockRejectedValue(new TypeError("Failed to fetch")));
    const sending = snapshot().send("问题", []);
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot().stage).toBe("connecting");
    snapshot().stop();
    expect(await sending).toBe(true);
    expect(snapshot()).toMatchObject({ status: "aborted", recovery: { mode: "continue" } });
  });

  it("只思考了、还没出正文就断了：思考收成「已思考 N 秒」挂在本地补的一条说明上，给「重新回答」", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(streamResponse([sse({ type: "thinking", delta: "比较几家的现金消耗。" })], "end"))
      .mockResolvedValueOnce(history([{ sequence: 1, role: "user", content: "问题", runId: RUN }]))
      .mockRejectedValue(new TypeError("Failed to fetch")));
    const sending = snapshot().send("问题", []);
    await vi.advanceTimersByTimeAsync(70_000);
    await sending;
    const view = snapshot();
    expect(view.messages.at(-1)).toMatchObject({ role: "assistant", content: "（这次回答没有完成。）" });
    expect(view.thought).toMatchObject({ text: "比较几家的现金消耗。", seconds: expect.any(Number) });
    expect(view.recovery).toMatchObject({ mode: "retry", label: "重新回答" });
    expect(view.error).toContain("点「重新回答」再试一次");
  });

  it("回答途中一直没有任何数据（连心跳都没有）：一分钟后当连接断了处理，不一直停在「正在思考」", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce(streamResponse([sse({ type: "message", delta: "写了一句" })], "hang"))
      .mockResolvedValueOnce(history([]))
      .mockRejectedValue(new TypeError("Failed to fetch")));
    let settled = false;
    const sending = snapshot().send("问题", []).finally(() => { settled = true; });
    // 第二次读一直不回来，之后也连不上：按 5 秒一步往前拨，最多拨到三分钟（一分钟静默 + 一分钟自己重连）。
    for (let step = 0; step < 36 && !settled; step += 1) await vi.advanceTimersByTimeAsync(5_000);
    expect(settled).toBe(true);
    expect(await sending).toBe(true);
    const view = snapshot();
    expect(view.status).toBe("failed");
    expect(view.error).toContain("超过一分钟没有数据");
    expect(view.messages.at(-1)).toMatchObject({ role: "assistant", content: expect.stringContaining("写了一句") });
  });

  it("恢复中的进度（重连、换备用模型、从断点接着写）显示在进度行，已写出的正文不动", async () => {
    let release!: (value: { done: boolean; value?: Uint8Array }) => void;
    let reads = 0;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, status: 200, body: { getReader: () => ({ read: () => {
      reads += 1;
      if (reads === 1) return Promise.resolve({ done: false, value: sse({ type: "message", delta: "前半段" }),
      });
      if (reads === 2) return Promise.resolve({ done: false, value: sse({ type: "recovery", reason: "network", action: "continue", attempt: 2, notice: "和模型服务的网络连接中断了，正在从断点接着写（第 1 次）" }) });
      return new Promise((resolve) => { release = resolve; });
    } }) } }));
    void snapshot().send("问题", []);
    await vi.waitFor(() => expect(reads).toBe(3));
    const view = snapshot();
    expect(view).toMatchObject({ status: "streaming", stage: "thinking", partial: "前半段" });
    expect(view.progress.label).toBe("和模型服务的网络连接中断了，正在从断点接着写（第 1 次）");
    void release;
  });

  it("服务端没接下（500、代理没回 JSON）：不自动重发，一句「没发出去」、原文放回输入框，不给「继续」", async () => {
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 500, body: null, json: async () => { throw new Error("not json"); } })
      .mockResolvedValueOnce(history([]));
    vi.stubGlobal("fetch", fetchMock);
    expect(await snapshot().send("问题", [])).toBe(false);
    const view = snapshot();
    expect(view.error).toBe("没发出去，原文已放回输入框。");
    expect(view.recovery).toBeNull();
    expect(fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST")).toHaveLength(1);
  });

  it("代理连不上正在重启的服务（502）：这句留在对话里、进度行写「正在连接」，自己重发成功，只有一条提问", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 502, body: null, json: async () => ({}) })
      .mockResolvedValueOnce(streamResponse([sse({ type: "message", delta: "回答" }), sse({ type: "done", status: "completed" })]))
      .mockResolvedValueOnce(history([{ sequence: 1, role: "user", content: "问题", runId: RUN }, { sequence: 2, role: "assistant", content: "回答", runId: RUN }]));
    vi.stubGlobal("fetch", fetchMock);
    let settled = false;
    const sending = snapshot().send("问题", []).finally(() => { settled = true; });
    await vi.advanceTimersByTimeAsync(0);
    expect(snapshot()).toMatchObject({ status: "streaming", stage: "connecting" });
    expect(snapshot().messages.filter((message) => message.role === "user")).toHaveLength(1);
    for (let step = 0; step < 5 && !settled; step += 1) await vi.advanceTimersByTimeAsync(1_000);
    expect(await sending).toBe(true);
    expect(snapshot()).toMatchObject({ status: "complete", error: null });
    expect(snapshot().messages.map((message) => message.content)).toEqual(["问题", "回答"]);
  });

  it("没连上但其实已经送到（读回的历史里有这句）：不重发，按回答中途断了自动接上", async () => {
    vi.useFakeTimers();
    const fetchMock = vi.fn()
      .mockRejectedValueOnce(new TypeError("Failed to fetch"))
      .mockResolvedValueOnce(history([{ sequence: 1, role: "user", content: "问题", runId: RUN }]))
      .mockResolvedValueOnce(history([{ sequence: 1, role: "user", content: "问题", runId: RUN }]))
      .mockResolvedValueOnce(history([{ sequence: 1, role: "user", content: "问题", runId: RUN }]))
      .mockResolvedValueOnce(notFollowing)
      .mockResolvedValueOnce(streamResponse([sse({ type: "message", delta: "回答" }), sse({ type: "done", status: "completed" })]))
      .mockResolvedValueOnce(history([]));
    vi.stubGlobal("fetch", fetchMock);
    const sending = snapshot().send("问题", []);
    await vi.advanceTimersByTimeAsync(5_000);
    expect(await sending).toBe(true);
    const posts = fetchMock.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === "POST");
    expect(posts.map(([, init]) => JSON.parse((init as { body: string }).body).message)).toEqual(["问题", "重新回答"]);
    expect(JSON.parse((posts[1][1] as { body: string }).body)).toMatchObject({ resumeRunId: RUN });
  });

  it("登录过期：去登录页，按没接下返回，原文放回输入框（存成草稿，回来还在）", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: false, status: 401, body: null, json: async () => ({}) }));
    expect(await snapshot().send("问题", [])).toBe(false);
    expect(window.location.assign).toHaveBeenCalledWith("/access");
  });

  it("停止：先请服务端停下这一轮，再断开；已写出的部分留着，可以「继续」", async () => {
    let reject!: (cause: unknown) => void;
    let reads = 0;
    const fetchMock = vi.fn().mockImplementationOnce(async (_url: string, init: RequestInit) => ({ ok: true, status: 200, body: { getReader: () => ({
      read: () => {
        reads += 1;
        if (reads === 1) return Promise.resolve({ done: false, value: sse({ type: "message", delta: "写了一段" }) });
        return new Promise((_resolve, fail) => { reject = fail; init.signal?.addEventListener("abort", () => fail(Object.assign(new Error("aborted"), { name: "AbortError" }))); });
      },
    }) } })).mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ runId: RUN, status: "aborted" }) }).mockResolvedValueOnce(history([]));
    vi.stubGlobal("fetch", fetchMock);
    const sending = snapshot().send("问题", []);
    await vi.waitFor(() => expect(reads).toBe(2));
    snapshot().stop();
    await sending;
    expect(fetchMock.mock.calls[1]).toEqual([`/api/conversations/global/turns/${RUN}/stop`, { method: "POST" }]);
    const view = snapshot();
    expect(view.status).toBe("aborted");
    expect(view.error).toBe("已停止。已写出的部分保留在上方，点「继续」可以接着写。");
    expect(view.messages.at(-1)).toMatchObject({ role: "assistant", content: "写了一段\n\n（已停止，以上是停止前写出的部分。）" });
    expect(view.recovery).toMatchObject({ mode: "continue" });
    void reject;
  });
});

/** 跳顶（11/17 A）：网页先放进对话的消息没有时间，按时间插的块就全挪到最后一条后面；读回历史又挪回去。 */
describe("网页先放进对话的消息带时间", () => {
  const stamped = (message: { createdAt?: string } | undefined) => Number.isFinite(Date.parse(message?.createdAt ?? ""));
  /** 读一下就停、本页停下或被打断时断开的事件流。 */
  const abortable = (delta: string) => async (_url: string, init: RequestInit) => {
    let reads = 0;
    return { ok: true, status: 200, body: { getReader: () => ({
      read: () => (reads++ === 0 ? Promise.resolve({ done: false, value: sse({ type: "message", delta }) })
        : new Promise((_resolve, fail) => init.signal?.addEventListener("abort", () => fail(Object.assign(new Error("aborted"), { name: "AbortError" }))))),
    }) } };
  };

  it.each([
    ["一轮写完、读不回历史", async () => {
      vi.stubGlobal("fetch", vi.fn()
        .mockResolvedValueOnce(streamResponse([sse({ type: "message", delta: "写完了" }), sse({ type: "done", status: "completed" })]))
        .mockResolvedValue({ ok: false, status: 404, json: async () => ({}) }));
      expect(await snapshot().send("问一句", [])).toBe(true);
      return snapshot().messages;
    }],
    ["停下时服务端没存下这一轮", async () => {
      vi.stubGlobal("fetch", vi.fn().mockImplementationOnce(abortable("写了一段"))
        .mockResolvedValueOnce({ ok: true, status: 200, json: async () => ({ runId: RUN, status: "aborted" }) }).mockResolvedValueOnce(history([])));
      const sending = snapshot().send("问一句", []);
      await vi.waitFor(() => expect(snapshot().partial).toBe("写了一段"));
      snapshot().stop();
      await sending;
      return snapshot().messages;
    }],
    ["回复中本人再发，已写出的先留在原处", async () => {
      vi.stubGlobal("fetch", vi.fn().mockImplementationOnce(abortable("写了一段")).mockReturnValue(new Promise(() => undefined)));
      void snapshot().send("问一句", []);
      await vi.waitFor(() => expect(snapshot().partial).toBe("写了一段"));
      void snapshot().send("再问一句", []);
      return snapshot().messages;
    }],
  ])("网页本地补进去的伙伴回答也带时间（%s）", async (_name, run) => {
    const messages = await run();
    expect(messages.some((message) => message.role === "assistant")).toBe(true);
    for (const message of messages) expect(stamped(message), JSON.stringify(message)).toBe(true);
  });
});

