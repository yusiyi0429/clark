import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationTurns } from "./Transcript";

/** 语音输入整理成分点后发出去：消息气泡里按行显示（不并成一段）。 */
describe("用户消息里的换行", () => {
  it("引导句 + 「1. 」分点：引导句一段，分点是有序列表，每点一行", () => {
    const html = renderToStaticMarkup(
      <ConversationTurns messages={[{ sequence: 1, role: "user", content: "下周有三件事。\n1. 把合同发给客户。\n2. 催一下回款。\n3. 跟财务对一下口径。" }]} />,
    );
    expect(html).toContain("<p>下周有三件事。</p>");
    expect(html.match(/<li>/g)).toHaveLength(3);
    expect(html).toContain("<li>催一下回款。</li>");
  });

  it("不是分点的单个换行留在文字里，由样式（pre-line）按行显示", () => {
    const html = renderToStaticMarkup(<ConversationTurns messages={[{ sequence: 1, role: "user", content: "第一行\n第二行" }]} />);
    expect(html).toContain("<p>第一行\n第二行</p>");
    const css = readFileSync(join(__dirname, "../styles/conversation-transcript.module.css"), "utf8");
    expect(css).toMatch(/\.user \.prose p\{white-space:pre-line/);
  });
});
