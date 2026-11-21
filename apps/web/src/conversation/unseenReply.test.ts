import { describe, expect, it } from "vitest";
import type { Message } from "./useConversation";
import { hasUnseenReply, lastReplyKey, seenAfter, type ReplySeen } from "./unseenReply";

const user = (sequence: number, content = "问"): Message => ({ sequence, role: "user", content });
const reply = (sequence: number, content = "答", extra: Partial<Message> = {}): Message => ({ sequence, role: "assistant", content, ...extra });

/** 按顺序走几帧：每帧先看提醒，再记下看过的那一句（同 useUnseenReply 的 effect）。 */
function frames(steps: { messages: Message[]; open: boolean; streaming?: boolean; ready?: boolean }[]): boolean[] {
  let seen: ReplySeen = undefined;
  return steps.map(({ messages, open, streaming = false, ready = true }) => {
    const key = lastReplyKey(messages);
    const state = { open, streaming, ready };
    const attention = hasUnseenReply(seen, key, state);
    seen = seenAfter(seen, key, state);
    return attention;
  });
}

describe("收着时伙伴有没看过的新话", () => {
  it("只看最后一句伙伴的话；飞书、微信里说的和留痕行不算", () => {
    expect(lastReplyKey([user(1), reply(2, "好的")])).toBe("2:2");
    expect(lastReplyKey([user(1), reply(2), reply(3, "飞书里答的", { via: "feishu" }), reply(4, "已转到议题", { kind: "trace" })])).toBe("2:1");
    expect(lastReplyKey([user(1)])).toBeNull();
  });

  it("打开页面时已有的话不算新；收着时回答写完了才提醒，写的过程中不提醒；打开就消", () => {
    const asked = [user(1), reply(2), user(3)];
    expect(frames([
      { messages: [user(1), reply(2)], open: false, ready: false },
      { messages: [user(1), reply(2)], open: false },
      { messages: [...asked, reply(4, "写到一半")], open: false, streaming: true },
      { messages: [...asked, reply(4, "写完了的回答")], open: false },
      { messages: [...asked, reply(4, "写完了的回答")], open: true },
      { messages: [...asked, reply(4, "写完了的回答")], open: false },
    ])).toEqual([false, false, false, true, false, false]);
  });

  it("开着对话层看着它写完，再收起来，不提醒；收着时它主动来了一句，提醒", () => {
    expect(frames([
      { messages: [user(1), reply(2)], open: true },
      { messages: [user(1), reply(2), user(3), reply(4, "…")], open: true, streaming: true },
      { messages: [user(1), reply(2), user(3), reply(4, "答完")], open: true },
      { messages: [user(1), reply(2), user(3), reply(4, "答完")], open: false },
      { messages: [user(1), reply(2), user(3), reply(4, "答完"), reply(5, "明天的评审材料还差一份")], open: false },
    ])).toEqual([false, false, false, false, true]);
  });
});
