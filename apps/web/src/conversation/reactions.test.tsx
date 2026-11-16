import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { InputBar } from "@/components/home/InputBar";
import { ConversationTurn } from "./Transcript";
import { EMOJIS, EmojiGrid, QUICK_REACTIONS, QuickReactions, ReactionContext, insertEmoji, toggleReaction } from "./Reactions";
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

  it("点一个挂上、再点取消、同一个只算一个；最多 3 个，再挂去掉最早的", () => {
    expect(toggleReaction([], "👍")).toEqual(["👍"]);
    expect(toggleReaction(["👍"], "👍")).toEqual([]);
    expect(toggleReaction(["👍", "❤️"], "❤️")).toEqual(["👍"]);
    expect(toggleReaction(["👍", "❤️", "😂"], "🙏")).toEqual(["❤️", "😂", "🙏"]);
  });

  it("挂的表情画在气泡下面，按下态、念中文名；气泡可以右键；没有回应的地方（别的页面）不出", () => {
    const store = { of: () => ["👍"], toggle: () => undefined };
    const html = renderToStaticMarkup(<ReactionContext.Provider value={store}><ConversationTurn message={answer} /></ReactionContext.Provider>);
    expect(html).toMatch(/<article[^>]*data-reactable=""/);
    expect(html).toMatch(/data-testid="message-reactions".*aria-pressed="true" aria-label="点赞"[^>]*>👍<\/button>.*aria-label="回应"/);
    expect(renderToStaticMarkup(<ConversationTurn message={answer} />)).not.toContain("message-reactions");
    // 还没写进历史的（没有 runId）不出。
    expect(renderToStaticMarkup(<ReactionContext.Provider value={store}><ConversationTurn message={{ ...answer, runId: undefined }} /></ReactionContext.Provider>))
      .not.toContain("message-reactions");
  });
});
