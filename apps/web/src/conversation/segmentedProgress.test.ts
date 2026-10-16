import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/** 分段输出（spec §5.1）在界面上的顺序：理解问题 → 开场说明 → 思考 / 查证进度（系统生成）→ 中途升级提示 → 正文。 */
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

describe("检索问答档的分段进度", () => {
  it("发出后先是「理解问题」，档位到达后开场说明上屏、转为思考；查证时显示在查什么与读到了什么；思考要点；升级提示；正文开始后只留已查几项", async () => {
    const { response, step, read } = steppedResponse([
      [{ type: "route", tier: "grounded", source: "model", expectSeconds: 30, timeoutMs: 120000, notice: NOTICE }],
      [{ type: "thinking" }],
      [{ type: "tool", phase: "started", toolCallId: "t1", name: "web_search", label: "检索公开来源「硅基流动 融资」" }],
      [{ type: "tool", phase: "completed", toolCallId: "t1", name: "web_search", detail: "「硅基流动 融资」找到 12 条公开来源，如《硅基流动完成新一轮融资》" }],
      [{ type: "thinking", summary: "核对融资时间与金额" }],
      [{ type: "escalation", reason: "slow", expectSeconds: 40, notice: "这个问题需要更深入的分析，预计还需约 40 秒。" }],
      [{ type: "message", delta: "九月完成新一轮融资。" }, { type: "done", status: "completed" }],
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [] }) }));
    const sending = snapshot().send("硅基流动最近一次融资是什么时候？", []);
    await vi.waitFor(() => expect(snapshot().status).toBe("streaming"));
    expect(snapshot()).toMatchObject({ stage: "understanding", partial: "", route: null });

    step(); await vi.waitFor(() => expect(read()).toBe(1));
    await vi.waitFor(() => expect(snapshot().route).toMatchObject({ tier: "grounded", notice: NOTICE }));
    expect(snapshot()).toMatchObject({ stage: "thinking", partial: NOTICE });

    step(); await vi.waitFor(() => expect(read()).toBe(2));
    step(); await vi.waitFor(() => expect(snapshot().stage).toBe("researching"));
    expect(snapshot().progress).toMatchObject({ label: "检索公开来源「硅基流动 融资」", checked: 0 });

    step(); await vi.waitFor(() => expect(snapshot().progress.checked).toBe(1));
    expect(snapshot().progress.label).toBe("「硅基流动 融资」找到 12 条公开来源，如《硅基流动完成新一轮融资》");
    // 工具都结束了：模型拿着结果在想下一步，进度行回到「正在思考」，细节保留刚读到的内容。
    expect(snapshot().stage).toBe("thinking");

    step(); await vi.waitFor(() => expect(snapshot().progress.thought).toBe("核对融资时间与金额"));
    expect(snapshot().stage).toBe("thinking");

    step(); await vi.waitFor(() => expect(snapshot().progress.escalation).toEqual({ notice: "这个问题需要更深入的分析，预计还需约 40 秒。", expectSeconds: 40 }));

    step();
    expect(await sending).toBe(true);
    expect(snapshot().lastReply?.text).toBe(`${NOTICE}\n\n九月完成新一轮融资。`);
  });

  it("没有推理摘要时只显示思考状态，不出现空要点", async () => {
    const { response, step } = steppedResponse([
      [{ type: "route", tier: "quick", source: "rule", expectSeconds: 10, timeoutMs: 90000 }, { type: "thinking" }],
      [{ type: "message", delta: "好的。" }, { type: "done", status: "completed" }],
    ]);
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response).mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [] }) }));
    const sending = snapshot().send("谢谢", []);
    step(); await vi.waitFor(() => expect(snapshot().route?.tier).toBe("quick"));
    expect(snapshot()).toMatchObject({ stage: "thinking", partial: "" });
    expect(snapshot().progress.thought ?? null).toBeNull();
    step();
    expect(await sending).toBe(true);
  });
});
