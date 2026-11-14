import { describe, expect, it } from "vitest";
import { Fragment, isValidElement, type ReactElement, type ReactNode } from "react";
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

  it("独立事件在消息前后共用一个父数组，事件 key 与消息 key 分开", () => {
    const event = <article key="turn-0" data-event="handoff" />;
    const message: Message = { sequence: 1, role: "user", content: "继续" };
    const rows = (index: number) => (ConversationTurns({ messages: [message],
      insertions: (at) => at === index ? [event] : [],
    }).props as { children: ReactElement[] }).children;
    const before = rows(-1), after = rows(0);
    expect(before).toHaveLength(2);
    expect(after).toHaveLength(2);
    const outlet = (nodes: ReactElement[]) => nodes.find(node => node.key !== "turn-0")!;
    expect(outlet(before).key).toBe(outlet(after).key);
    expect(outlet(before).key).not.toBe("turn-0");
    expect(outlet(before).props).toEqual({ children: event });
    expect(before.map(row => row.key)).toEqual([...after.map(row => row.key)].reverse());
  });

  it("加事件仍保留 footer、after 与正在写的正文 → 状态 → trailing 次序", () => {
    const part = (name: string) => <span key={name} data-part={name} />;
    const tree = ConversationTurns({ messages: [{ sequence: 1, role: "user", content: "继续" }],
      footer: () => part("footer"), after: () => part("after"), partial: "reply",
      status: part("status"), trailing: part("trailing"), insertions: index => [part(index === -1 ? "leading" : "inserted")],
    });
    const order = (node: ReactNode): string[] => {
      if (Array.isArray(node)) return node.flatMap(order);
      if (!isValidElement<Record<string, unknown>>(node)) return [];
      if (node.props["data-part"]) return [String(node.props["data-part"])];
      if (node.props.message) return [(node.props.message as Message).content];
      return order(node.props.children as ReactNode);
    };
    expect(order(tree)).toEqual(["leading", "继续", "footer", "after", "inserted", "reply", "status", "trailing"]);
  });
});
