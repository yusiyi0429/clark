import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

/**
 * 伙伴当场点的表情（设计 6.5）：派活成功后服务端在本人这一轮那句话上点 👍，对话流里来一帧 buddy_reaction（runId 是这一轮的），
 * 回答还没写完就出现在本人那句的气泡上；读回历史时随消息带回 buddyReactions。
 * useConversation 不经 React 渲染：只在调它的时候把这几个 hook 换成按顺序记账的版本（画气泡时用真的）。
 */
const state = vi.hoisted(() => ({ active: false, values: [] as unknown[], cursor: 0, refs: [] as { current: unknown }[], refCursor: 0 }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useCallback: (callback: unknown, deps: readonly unknown[]) => (state.active ? callback : react.useCallback(callback as () => void, deps)),
    useEffect: (run: () => void, deps?: readonly unknown[]) => (state.active ? undefined : react.useEffect(run, deps)),
    useRef: (initial: unknown) => (state.active ? state.refs[state.refCursor++] ??= { current: initial } : react.useRef(initial)),
    useState: (initial: unknown) => {
      if (!state.active) return react.useState(initial);
      const index = state.cursor++;
      if (!(index in state.values)) state.values[index] = initial;
      return [state.values[index], (next: unknown) => {
        state.values[index] = typeof next === "function" ? next(state.values[index]) : next;
      }];
    },
  };
});
import { useConversation, type Message } from "./useConversation";
import { ReactionContext } from "./Reactions";
import { BubbleContext } from "./ReplyBubbles";
import { ConversationTurn, sameTurn } from "./Transcript";

beforeEach(() => {
  state.values = []; state.refs = [];
  vi.stubGlobal("window", { dispatchEvent: vi.fn(), location: { assign: vi.fn() } });
});
afterEach(() => vi.unstubAllGlobals());

function snapshot() {
  state.cursor = 0; state.refCursor = 0; state.active = true;
  try { return useConversation("global"); } finally { state.active = false; }
}
const frame = (event: Record<string, unknown>) => new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`);
const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe("伙伴当场点的表情", () => {
  it("回答中收到伙伴的 👍 当场出现在本人那句上", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const frames = [frame({ type: "receipt", state: "read", messageId: "m1", runId: "r1" }), frame({ type: "message", delta: "开了一个会话去查。", runId: "r1" }),
      frame({ type: "buddy_reaction", role: "user", emojis: ["👍"], runId: "r1", scope: "global", sequence: 3 }),
      frame({ type: "done", status: "completed", runId: "r1" })];
    let step = 0;
    const read = async () => {
      if (step === 3) await gate;
      const value = frames[step++];
      return value ? { done: false, value } : { done: true, value: undefined };
    };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce({ ok: true, status: 200, body: { getReader: () => ({ read }) } })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ messages: [
        { sequence: 1, role: "user", content: "去查一下灯塔的回款", runId: "r1", buddyReactions: ["👍"] },
        { sequence: 2, role: "assistant", content: "开了一个会话去查。", runId: "r1" },
      ] }) }));
    const sending = snapshot().send("去查一下灯塔的回款", []);
    await vi.waitFor(() => expect(step).toBe(3));
    await tick();
    // 这一轮还没写完：本人那句（刚发出、还没有 runId）已经带上伙伴点的 👍。
    const live = snapshot();
    expect(live.status).toBe("streaming");
    const asked = live.messages.at(-1)!;
    expect(asked).toMatchObject({ role: "user", content: "去查一下灯塔的回款", buddyReactions: ["👍"] });
    // 气泡跟着重画（memo 认这个字段），角上念「小天 点了 👍」。
    const before: Message = { ...asked, buddyReactions: undefined };
    expect(sameTurn({ message: before }, { message: asked })).toBe(false);
    const store = { of: () => [], toggle: () => undefined, buddyName: "小天" };
    const html = renderToStaticMarkup(<ReactionContext.Provider value={store}><BubbleContext.Provider value={true}><ConversationTurn message={asked} /></BubbleContext.Provider></ReactionContext.Provider>);
    expect(html).toContain('aria-label="小天 点了 👍"');
    // 写完读回历史：照样在。
    release();
    await sending;
    expect(snapshot().messages[0]).toMatchObject({ role: "user", buddyReactions: ["👍"] });
  });
});
