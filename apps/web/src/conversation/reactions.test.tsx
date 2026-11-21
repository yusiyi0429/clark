import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InputBar } from "@/components/home/InputBar";
import { ConversationTurn } from "./Transcript";
import { EMOJIS, EmojiGrid, QUICK_REACTIONS, QuickReactions, ReactionContext, insertEmoji, reactionAt, toggleReaction } from "./Reactions";
import { BubbleContext } from "./ReplyBubbles";
import type { Message } from "./useConversation";

const answer: Message = { sequence: 2, role: "assistant", content: "好的", runId: "run-1" };

describe("表情面板", () => {
  it("插到光标处，选中的那段被换掉，光标落在表情后面", () => {
    expect(insertEmoji("你好世界", 2, 2, "👍")).toEqual({ text: "你好👍世界", caret: 4 });
    expect(insertEmoji("你好世界", 2, 4, "🎉")).toEqual({ text: "你好🎉", caret: 4 });
    expect(insertEmoji("", 0, 0, "😂")).toEqual({ text: "😂", caret: 2 });
  });

  it("几十个常用表情，每个读屏念中文名；没有重复", () => {
    expect(EMOJIS.length).toBeGreaterThanOrEqual(30);
    expect(new Set(EMOJIS.map((emoji) => emoji.char)).size).toBe(EMOJIS.length);
    const html = renderToStaticMarkup(<EmojiGrid onPick={() => undefined} />);
    expect(html.match(/<button/g)).toHaveLength(EMOJIS.length);
    expect(html).toContain('aria-label="点赞"');
    expect(html).toContain('aria-label="爱心"');
  });

  it("伙伴台、项目对话的输入框下面一行左边有表情按钮；别处不给不出", () => {
    expect(renderToStaticMarkup(<InputBar placeholder="" onSend={async () => true} emoji />)).toMatch(/data-testid="input-footer">.*aria-label="表情"/);
    expect(renderToStaticMarkup(<InputBar placeholder="" onSend={async () => true} />)).not.toContain('aria-label="表情"');
  });
});

describe("对一条消息回应表情", () => {
  it("快捷那一排：点赞、爱心、笑哭、惊讶、难过、合十，加「更多」；挂过的按下", () => {
    expect(QUICK_REACTIONS.map((emoji) => emoji.char)).toEqual(["👍", "❤️", "😂", "😮", "😢", "🙏"]);
    const html = renderToStaticMarkup(<QuickReactions onPick={() => undefined} onMore={() => undefined} selected={["❤️"]} />);
    expect(html.match(/aria-label="[^"]+"/g)).toEqual(['aria-label="回应"', 'aria-label="点赞"', 'aria-label="爱心"', 'aria-label="笑哭"',
      'aria-label="惊讶"', 'aria-label="难过"', 'aria-label="合十"', 'aria-label="更多表情"']);
    expect(html).toMatch(/aria-label="爱心"[^>]*aria-pressed="true"|aria-pressed="true"[^>]*aria-label="爱心"/);
  });

  it("每块一个：点了挂上、点同一个取消、点另一个换掉；只动这一块", () => {
    expect(toggleReaction([], 0, 2, "👍")).toEqual({ entries: [{ part: 0, emoji: "👍" }], saved: { part: 0, emoji: "👍" } });
    expect(toggleReaction([{ part: 0, emoji: "👍" }], 0, 2, "👍")).toEqual({ entries: [], saved: { part: 0, emoji: null } });
    expect(toggleReaction([{ part: 0, emoji: "👍" }, { part: 1, emoji: "🙏" }], 0, 2, "❤️"))
      .toEqual({ entries: [{ part: 1, emoji: "🙏" }, { part: 0, emoji: "❤️" }], saved: { part: 0, emoji: "❤️" } });
  });

  it("老数据（-1）算最后一块：在最后一块上点改的就是它；这一块有自己的就不看 -1", () => {
    expect(reactionAt([{ part: -1, emoji: "🎉" }], 2, 3)).toEqual({ part: -1, emoji: "🎉" });
    expect(reactionAt([{ part: -1, emoji: "🎉" }], 0, 3)).toBeUndefined();
    expect(reactionAt([{ part: -1, emoji: "🎉" }, { part: 2, emoji: "👍" }], 2, 3)).toEqual({ part: 2, emoji: "👍" });
    expect(toggleReaction([{ part: -1, emoji: "🎉" }], 2, 3, "👍")).toEqual({ entries: [{ part: -1, emoji: "👍" }], saved: { part: -1, emoji: "👍" } });
    expect(toggleReaction([{ part: -1, emoji: "🎉" }], 2, 3, "🎉")).toEqual({ entries: [], saved: { part: -1, emoji: null } });
    expect(toggleReaction([{ part: -1, emoji: "🎉" }], 0, 3, "👍").saved).toEqual({ part: 0, emoji: "👍" });
  });

  it("挂的表情画在气泡下面，按下态、念中文名；气泡可以右键；没有回应的地方（别的页面）不出", () => {
    const store = { of: () => [{ part: -1, emoji: "👍" }], toggle: () => undefined };
    const html = renderToStaticMarkup(<ReactionContext.Provider value={store}><ConversationTurn message={answer} /></ReactionContext.Provider>);
    expect(html).toMatch(/<article[^>]*data-reactable=""/);
    expect(html).toMatch(/data-testid="message-reactions".*aria-pressed="true" aria-label="点赞"[^>]*>👍<\/button>.*aria-label="回应"/);
    expect(renderToStaticMarkup(<ConversationTurn message={answer} />)).not.toContain("message-reactions");
    // 还没写进历史的（没有 runId）不出。
    expect(renderToStaticMarkup(<ReactionContext.Provider value={store}><ConversationTurn message={{ ...answer, runId: undefined }} /></ReactionContext.Provider>))
      .not.toContain("message-reactions");
  });
});

describe("新首页的两种对话里：表情挂在气泡底边（设计 6.5）", () => {
  /** 从 at 处那个 <div 起，到和它配对的 </div> 为止。 */
  const divAt = (html: string, at: number) => {
    const tags = /<div\b[^>]*>|<\/div>/g;
    tags.lastIndex = at;
    let depth = 0;
    for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
      depth += tag[0].startsWith("</") ? -1 : 1;
      if (depth === 0) return html.slice(at, tags.lastIndex);
    }
    return html.slice(at);
  };
  /** 第 n 个（-1 是最后一个）带这个属性的 div。 */
  const bubbleOf = (html: string, attribute: string, nth = -1) => {
    const all = [...html.matchAll(new RegExp(`<div[^>]*${attribute}[^>]*>`, "g"))];
    return divAt(html, all.at(nth)!.index!);
  };
  type Store = { of: () => { part: number; emoji: string }[]; toggle: () => void; buddyName?: string };
  const inBubbles = (message: Message, store: Store | null) => renderToStaticMarkup(
    <ReactionContext.Provider value={store}><BubbleContext.Provider value={true}><ConversationTurn message={message} /></BubbleContext.Provider></ReactionContext.Provider>);

  it("每块各挂各的：表情在那一块的底边；底边上不再有加表情的按钮（挪到块旁边那一排）", () => {
    const store = { of: () => [{ part: 0, emoji: "👍" }, { part: 1, emoji: "❤️" }], toggle: () => undefined };
    const html = inBubbles({ ...answer, content: "第一段。\n\n第二段。" }, store);
    expect(html.match(/data-bubble="buddy"/g)).toHaveLength(2);
    const [first, second] = [bubbleOf(html, 'data-bubble="buddy"', 0), bubbleOf(html, 'data-bubble="buddy"', 1)];
    expect(first).toMatch(/<div[^>]*data-edge=""[^>]*data-testid="message-reactions"/);
    expect(first).toMatch(/aria-pressed="true" aria-label="点赞"[^>]*>👍<\/button>/);
    expect(first).not.toContain("❤️");
    expect(second).toMatch(/aria-pressed="true" aria-label="爱心"[^>]*>❤️<\/button>/);
    expect(second).not.toContain("👍");
    // 悬停跟着那一块：块上有 data-reactable，整条回答上没有。
    expect(first).toMatch(/^<div[^>]*data-reactable=""/);
    expect(second).toMatch(/^<div[^>]*data-reactable=""/);
    expect(html).not.toMatch(/<article[^>]*data-reactable/);
    expect(html).not.toContain('data-testid="reaction-add"');
    // 卡片也是一块。
    const card = inBubbles({ ...answer, content: "先看这个。\n\n## 本周\n\n- 周二发清单\n- 周三确认" }, { of: () => [{ part: 1, emoji: "👍" }], toggle: () => undefined });
    expect(card.slice(card.indexOf("<section"), card.indexOf("</section>"))).toMatch(/aria-label="点赞"[^>]*>👍<\/button>/);
    expect(bubbleOf(card, 'data-bubble="buddy"')).not.toContain(">👍</button>");
  });

  it("老数据（-1）落在最后一块；老页面（不用气泡的）整条算一块", () => {
    const store = { of: () => [{ part: -1, emoji: "🎉" }], toggle: () => undefined };
    const html = inBubbles({ ...answer, content: "第一段。\n\n第二段。" }, store);
    expect(bubbleOf(html, 'data-bubble="buddy"', 0)).not.toContain("🎉");
    expect(bubbleOf(html, 'data-bubble="buddy"', 1)).toContain(">🎉</button>");
    const old = (of: Store["of"]) => renderToStaticMarkup(<ReactionContext.Provider value={{ of, toggle: () => undefined }}><ConversationTurn message={{ ...answer, content: "第一段。\n\n第二段。" }} /></ReactionContext.Provider>);
    expect(old(() => [{ part: -1, emoji: "🎉" }]).match(/data-testid="message-reactions"/g)).toHaveLength(1);
    expect(old(() => [{ part: -1, emoji: "🎉" }])).toContain(">🎉</button>");
    expect(old(() => [{ part: 0, emoji: "👍" }, { part: 1, emoji: "❤️" }])).toContain(">👍</button>");
    expect(old(() => [{ part: 0, emoji: "👍" }, { part: 1, emoji: "❤️" }])).not.toContain("❤️");
  });

  it("伙伴点的表情只读，读屏念谁点的", () => {
    const store = { of: () => [{ part: 0, emoji: "❤️" }], toggle: () => undefined, buddyName: "小天" };
    const mine: Message = { sequence: 1, role: "user", content: "交给你了", runId: "run-1", buddyReactions: ["👍"] };
    const bubble = bubbleOf(inBubbles(mine, store), 'data-bubble="mine"');
    // 伙伴的在气泡角上、不是按钮（点了不切换），念「小天 点了 👍」；和本人自己点的分开画。
    expect(bubble).toMatch(/<span[^>]*aria-label="小天 点了 👍"[^>]*>👍<\/span>/);
    expect(bubble).not.toMatch(/<button[^>]*aria-label="小天 点了/);
    expect(bubbleOf(bubble, 'data-testid="message-reactions"')).not.toContain("点了");
    expect(bubble).toMatch(/aria-pressed="true" aria-label="爱心"/);
    // 刚发出、还没写进历史的那句（没有 runId）：自己点不了，伙伴点的照样出。
    expect(bubbleOf(inBubbles({ ...mine, runId: undefined }, store), 'data-bubble="mine"')).toContain('aria-label="小天 点了 👍"');
    // 没给伙伴名时叫「伙伴」；老页面（不用气泡的）不出。
    expect(inBubbles(mine, { of: () => [], toggle: () => undefined })).toContain('aria-label="伙伴 点了 👍"');
    expect(renderToStaticMarkup(<ReactionContext.Provider value={store}><ConversationTurn message={mine} /></ReactionContext.Provider>)).not.toContain("点了");
  });

  it("本人那句的两个勾放在气泡里，不另占一行", () => {
    const html = inBubbles({ sequence: 1, role: "user", content: "交给你了", receipt: "read" }, null);
    expect(bubbleOf(html, 'data-bubble="mine"')).toContain('data-testid="message-receipt"');
    // 老页面照旧在气泡下面一行。
    expect(renderToStaticMarkup(<ConversationTurn message={{ sequence: 1, role: "user", content: "交给你了", receipt: "read" }} />)).toContain('data-testid="message-receipt"');
  });
});
