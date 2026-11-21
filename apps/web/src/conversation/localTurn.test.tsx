import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationTurns, LocalTurnRow, modelSwitches, turnModel } from "./Transcript";
import type { Message } from "./useConversation";

const text = (html: string) => html.replace(/<[^>]+>/g, "|").replace(/\|+/g, "|");

describe("项目对话在本机跑（17.2 第 38 条，B 契约 7d6a62b3）", () => {
  it("每条回答上方不再标模型（主循环第 67 条）；换了模型的那一轮，本人那句前面画「换成 来源 · 模型」，第一轮不画；本机跑的只写模型", () => {
    expect(turnModel({ ranOn: "cloud", model: { provider: "wangsu", model: "claude-opus-5-5" } })).toBe("TokenHub · Opus 5.5");
    expect(turnModel({ model: { provider: "tokenhub", model: "wangsu/claude-opus-5-5" } })).toBe("TokenHub · Opus 5.5");
    expect(turnModel({ ranOn: "local", model: { provider: "Claude Code", model: "Opus 5.5" } })).toBe("Opus 5.5");
    expect(turnModel({ ranOn: "cloud" })).toBeNull();
    const opus = { provider: "tokenhub", model: "wangsu/claude-opus-5-5" };
    const messages: Message[] = [
      { sequence: 1, role: "user", content: "看一下进度", createdAt: "2026-11-10T02:00:00.000Z" },
      { sequence: 2, role: "assistant", content: "做完两件。", createdAt: "2026-11-10T02:00:09.000Z", ranOn: "cloud", fallback: "local_unavailable", model: opus },
      { sequence: 3, role: "user", content: "再看看", createdAt: "2026-11-10T02:01:00.000Z" },
      { sequence: 4, role: "assistant", content: "还是两件。", createdAt: "2026-11-10T02:01:05.000Z", model: opus },
      { sequence: 5, role: "user", content: "换个快的", createdAt: "2026-11-10T02:02:00.000Z" },
      { sequence: 6, role: "assistant", content: "好。", createdAt: "2026-11-10T02:02:03.000Z", model: { provider: "tokenhub", model: "wangsu/deepseek-v4.1-flash" } },
      { sequence: 7, role: "assistant", content: "没带模型的老记录" },
      { sequence: 8, role: "user", content: "换回来" },
      { sequence: 9, role: "assistant", content: "好。", model: opus },
    ];
    expect([...modelSwitches(messages)]).toEqual([[4, "TokenHub · deepseek-v4.1-flash"], [7, "TokenHub · Opus 5.5"]]);
    const plain = renderToStaticMarkup(<ConversationTurns messages={messages.slice(0, 2)} />);
    expect(plain).not.toContain("Opus");
    expect(text(plain)).toContain("|用时 9 秒|");
    const html = renderToStaticMarkup(<ConversationTurns messages={messages} modelRule={(label) => <p data-testid="model-rule">换成 {label}</p>} />);
    expect(html.match(/data-testid="model-rule">[^<]*/g)).toEqual(['data-testid="model-rule">换成 TokenHub · deepseek-v4.1-flash', 'data-testid="model-rule">换成 TokenHub · Opus 5.5']);
    expect(html.indexOf("换成 TokenHub · deepseek")).toBeLessThan(html.indexOf("换个快的"));
    // 没给画法的地方（老页面）不画。
    expect(renderToStaticMarkup(<ConversationTurns messages={messages} />)).not.toContain("换成");
  });

  it("本机正跑着一轮（localTurn）：别的页面、手机上先画本人那一句和「正在回答」，后面写来源；没有停止按钮", () => {
    const html = renderToStaticMarkup(<LocalTurnRow turn={{ turnId: "00000000-0000-4000-8000-000000000001", message: "把首页改版拆一下",
      startedAt: "2026-11-10T02:00:00.000Z", deviceName: "孙铭泽的电脑", source: "本机 · Claude Code · Opus 5.5" }} />);
    expect(text(html)).toMatch(/把首页改版拆一下\|.*正在回答\|本机 · Claude Code · Opus 5.5\|/);
    expect(html).toContain('data-testid="conversation-local-turn"');
    expect(html).not.toContain("停止");
  });
});
