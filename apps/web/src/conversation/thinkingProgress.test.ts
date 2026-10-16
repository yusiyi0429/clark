import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** Claude 档的思考摘要（thinking 事件带 delta）：正文开始前逐段累积，正文第一个字到达时记下已思考秒数；GPT 档没有这段。 */
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

const NOTICE = "需要先核实硅基流动最近一次融资的相关信息：先查企业知识，不足部分再查公开来源。";
const sse = (events: Record<string, unknown>[]) => new TextEncoder().encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));

/** 一段一段地推 SSE：每次 step() 放行下一批，便于在两批之间看界面状态。 */
function steppedResponse(batches: Record<string, unknown>[][]) {
  let sent = 0;
  let credits = 0;
  let waiting: (() => void) | null = null;
  const step = () => { if (waiting) { const open = waiting; waiting = null; open(); } else credits += 1; };
  const read = async () => {
    if (credits > 0) credits -= 1; else await new Promise<void>((resolve) => { waiting = resolve; });
    if (sent >= batches.length) return { done: true };
    return { done: false, value: sse(batches[sent++]) };
  };
  const response = { ok: true, status: 200, body: { getReader: () => ({ cancel: async () => undefined, read }) } };
  return { response, step, read: () => sent };
}

describe("思考过程实时显示", () => {
  it("思考摘要逐段累积；正文开始前没有秒数，正文第一个字到达时记下已思考秒数；回答结束后仍保留，发下一句时清空", async () => {
    const { response, step } = steppedResponse([
      [{ type: "route", tier: "deep", source: "model", expectSeconds: 90, timeoutMs: 180000, notice: "开场说明。" }, { type: "thinking" }],
      [{ type: "thinking", delta: "先核对两家公司的递表时间。" }],
      [{ type: "tool", phase: "started", toolCallId: "t1", name: "web_search", label: "检索公开来源「硅基流动 递表」" }],
      [{ type: "thinking", delta: "\n\n再看融资金额与上市门槛。" }],
      [{ type: "message", delta: "两家的融资是上市准备的一部分。" }, { type: "done", status: "completed" }],
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [] }) }));
    const sending = snapshot().send("两家递表后又大额融资的原因是什么？", []);
    step(); await vi.waitFor(() => expect(snapshot().route?.tier).toBe("deep"));
    expect(snapshot().thought).toBeNull();
    step(); await vi.waitFor(() => expect(snapshot().thought).toEqual({ text: "先核对两家公司的递表时间。", seconds: null }));
    step(); await vi.waitFor(() => expect(snapshot().stage).toBe("researching"));
    step(); await vi.waitFor(() => expect(snapshot().thought?.text).toBe("先核对两家公司的递表时间。\n\n再看融资金额与上市门槛。"));
    // 进度行的要点不重复显示思考摘要
    expect(snapshot().progress.thought ?? null).toBeNull();
    step();
    expect(await sending).toBe(true);
    expect(snapshot().thought).toEqual({ text: "先核对两家公司的递表时间。\n\n再看融资金额与上市门槛。", seconds: 1 });
  });

  it("GPT 档没有思考摘要：thought 一直为空，进度行照旧显示要点", async () => {
    const { response, step } = steppedResponse([
      [{ type: "route", tier: "quick", source: "rule", expectSeconds: 10, timeoutMs: 90000 }, { type: "thinking", summary: "读取看板" }],
      [{ type: "message", delta: "6 个。" }, { type: "done", status: "completed" }],
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [] }) }));
    const sending = snapshot().send("这周待决策的议题有几个", []);
    step(); await vi.waitFor(() => expect(snapshot().progress.thought).toBe("读取看板"));
    step();
    expect(await sending).toBe(true);
    expect(snapshot().thought).toBeNull();
  });
});
