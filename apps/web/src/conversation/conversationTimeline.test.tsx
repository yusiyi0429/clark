import { describe, expect, it } from "vitest";
import { Fragment, type ReactElement } from "react";
import type { Message } from "./useConversation";

import { ConversationTurns } from "./Transcript";

/** B5：每条消息连同它后面插的卡包在同一个 key 之下，流式结束不卸载重挂。 */

describe("卡片进时间线（B5）", () => {
  it("流式那条结束后，卡片仍在同一个 key 之下（不卸载重挂）", () => {
    const card = <article key="proposal-p-1" />;
    const question: Message = { sequence: 1, role: "user", content: "要不要加复核人？" };
    const tree = (element: ReactElement) => ((element.props as { children: unknown[] }).children.flat().filter(Boolean) as ReactElement[])
      .map((child) => ({ key: child.key, type: child.type, inner: ([] as unknown[]).concat((child.props as { children?: unknown }).children).flat()
        .filter(Boolean).map((item) => (item as ReactElement).key) }));
    const during = tree(ConversationTurns({ messages: [question], partial: "建议先立", trailing: [card] }) as ReactElement);
    const after = tree(ConversationTurns({ messages: [question, { sequence: 2, role: "assistant", content: "建议先立一个议题。" }], after: (index) => index === 1 ? [card] : null }) as ReactElement);
    expect(during.map((item) => item.key)).toEqual(["turn-0", "turn-1"]);
    expect(after.map((item) => item.key)).toEqual(["turn-0", "turn-1"]);
    expect(during[1].type).toBe(Fragment);
    expect(during[1].inner).toContain("proposal-p-1");
    expect(after[1].inner).toContain("proposal-p-1");
  });
});
