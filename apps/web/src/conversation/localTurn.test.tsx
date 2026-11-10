import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationTurns, LocalTurnRow, turnSource } from "./Transcript";
import type { Message } from "./useConversation";

const text = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

describe("项目对话在本机跑（17.2 第 38 条，B 契约 7d6a62b3）", () => {
  it("每一轮回答旁边标在哪跑：「本机 · Opus 5.5」「云端 · claude-opus-5-5」；本机没跑成改发云端的也写「云端」；不是项目对话的不标", () => {
    expect(turnSource({ ranOn: "local", model: { provider: "Claude Code", model: "Opus 5.5" } })).toBe("本机 · Opus 5.5");
    expect(turnSource({ ranOn: "cloud", model: { provider: "wangsu", model: "claude-opus-5-5" } })).toBe("云端 · claude-opus-5-5");
    expect(turnSource({ ranOn: "cloud" })).toBe("云端");
    expect(turnSource({ model: { provider: "wangsu", model: "claude-opus-5-5" } })).toBeNull();
    const messages: Message[] = [
      { sequence: 1, role: "user", content: "看一下进度", createdAt: "2026-11-10T02:00:00.000Z" },
      { sequence: 2, role: "assistant", content: "做完两件。", createdAt: "2026-11-10T02:00:09.000Z", ranOn: "cloud", fallback: "local_unavailable", model: { provider: "wangsu", model: "claude-opus-5-5" } },
    ];
    const html = renderToStaticMarkup(<ConversationTurns messages={messages} />);
    expect(html).toMatch(/data-testid="turn-source">云端 · claude-opus-5-5</);
    expect(text(html)).toContain("|用时 9 秒|云端 · claude-opus-5-5|");
  });

  it("本机正跑着一轮（localTurn）：别的页面、手机上先画本人那一句和「正在回答」，后面写来源；没有停止按钮", () => {
    const html = renderToStaticMarkup(<LocalTurnRow turn={{ turnId: "00000000-0000-4000-8000-000000000001", message: "把首页改版拆一下",
      startedAt: "2026-11-10T02:00:00.000Z", deviceName: "孙铭泽的电脑", source: "本机 · Claude Code · Opus 5.5" }} />);
    expect(text(html)).toMatch(/把首页改版拆一下\|.*正在回答\|本机 · Claude Code · Opus 5.5\|/);
    expect(html).toContain('data-testid="conversation-local-turn"');
    expect(html).not.toContain("停止");
  });
});
