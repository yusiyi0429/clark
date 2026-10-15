import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * 流式上屏合帧（dock-animation-jank「修复」第 2、3 条）：思考摘要、进度与正文同一帧写进去；
 * 对话层放大 / 收起的过渡里一帧都不写，结束时一次补齐。hook 用最小的 React 桩跑。
 */
const state = vi.hoisted(() => ({ values: [] as unknown[], cursor: 0, refs: [] as { current: unknown }[], refCursor: 0, writes: 0 }));
vi.mock("react", () => ({
  useCallback: (callback: unknown) => callback,
  useEffect: () => {},
  useRef: (initial: unknown) => state.refs[state.refCursor++] ??= { current: initial },
  useState: (initial: unknown) => {
    const index = state.cursor++;
    if (!(index in state.values)) state.values[index] = initial;
    return [state.values[index], (next: unknown) => {
      state.writes++;
      state.values[index] = typeof next === "function" ? next(state.values[index]) : next;
    }];
  },
}));
import { useConversation } from "./useConversation";
import { beginResize, endResize } from "./resizeGate";

let frames: (FrameRequestCallback | null)[] = [];
const runFrames = () => frames.splice(0).forEach((callback) => callback?.(0));

beforeEach(() => {
  state.values = []; state.refs = []; state.writes = 0; frames = [];
  vi.stubGlobal("window", { dispatchEvent: vi.fn(), location: { assign: vi.fn() } });
  vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => frames.push(callback));
  vi.stubGlobal("cancelAnimationFrame", (id: number) => { frames[id - 1] = null; });
});
afterEach(() => {
  endResize();
  vi.unstubAllGlobals();
});

function snapshot() {
  state.cursor = 0; state.refCursor = 0;
  return useConversation("global");
}

const encoder = new TextEncoder();
const sse = (...events: object[]) => encoder.encode(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join(""));

/** 一轮回答：每次读给一段，最后一读挂起（回答还在进行）。 */
function stream(chunks: Uint8Array[]) {
  let reads = 0;
  const response = { ok: true, status: 200, body: { getReader: () => ({ read: () => {
    const chunk = chunks[reads++];
    return chunk ? Promise.resolve({ done: false, value: chunk }) : new Promise(() => undefined);
  } }) } };
  vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(response));
  return () => reads;
}

describe("思考、进度与正文按帧合并", () => {
  it("两次网络读、多段思考与进度：下一帧之前一个都不写，整段只排一帧，一帧写完", async () => {
    const reads = stream([
      sse({ type: "thinking", delta: "先看增长战场" }, { type: "thinking", delta: "的两项指标，", summary: "核对指标" }),
      sse({ type: "tool", phase: "started", name: "search", label: "检索会前预审" }, { type: "thinking", delta: "再对照预审。" }),
    ]);
    void snapshot().send("增长战场怎么样", []);
    await vi.waitFor(() => expect(reads()).toBe(3));
    const before = snapshot();
    expect(before.thought).toBeNull();
    expect(before.progress).toEqual({ label: null, checked: 0 });
    expect(frames).toHaveLength(1);
    runFrames();
    const after = snapshot();
    expect(after.thought).toEqual({ text: "先看增长战场的两项指标，再对照预审。", seconds: null });
    expect(after.progress).toMatchObject({ label: "检索会前预审", thought: null });
    // 阶段照旧即时切换（工具开始→查证，之后又在思考→思考），不在这一帧里合并。
    expect(after.stage).toBe("thinking");
  });

  it("正文第一批字与「已思考 N 秒」同一帧写进去", async () => {
    const reads = stream([sse({ type: "thinking", delta: "先看指标。" }, { type: "message", delta: "先说结论：" })]);
    void snapshot().send("增长战场怎么样", []);
    await vi.waitFor(() => expect(reads()).toBe(2));
    expect(snapshot()).toMatchObject({ thought: null, partial: "" });
    runFrames();
    const after = snapshot();
    expect(after.partial).toBe("先说结论：");
    expect(after.thought?.seconds).toBeGreaterThanOrEqual(1);
    expect(after.stage).toBe("answering");
  });

  it("放大 / 收起的过渡里：帧到了也不写，过渡结束一次补齐", async () => {
    const reads = stream([sse({ type: "thinking", delta: "先看指标。" }, { type: "message", delta: "先说结论：" })]);
    void snapshot().send("增长战场怎么样", []);
    await vi.waitFor(() => expect(reads()).toBe(2));
    beginResize();
    runFrames();
    expect(snapshot()).toMatchObject({ thought: null, partial: "" });
    endResize();
    expect(snapshot()).toMatchObject({ partial: "先说结论：", stage: "answering" });
    expect(snapshot().thought?.text).toBe("先看指标。");
  });
});
