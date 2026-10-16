import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { pageContextBattlefield } from "./quotes";
import { ConversationTurns } from "./Transcript";

const asked = (name: string, text: string) => `【页面】正在讨论战场「${name}」（B02，战场id=bf-1）\n\n${text}`;

describe("战场页共用对话：每条提问标出战场（巡检 P1-18）", () => {
  it("从消息最前面的页面上下文认出战场；其它页面发的没有", () => {
    expect(pageContextBattlefield(asked("房懂懂", "状态灯改黄"))).toBe("房懂懂");
    expect(pageContextBattlefield("正在讨论战场「AIDC」（B01，战场id=aidc）\n\n给个建议")).toBe("AIDC");
    expect(pageContextBattlefield("普通的一句话")).toBeNull();
  });

  it("提问上方写「战场 · 名字」，正文不带页面上下文；回答不标", () => {
    const html = renderToStaticMarkup(<ConversationTurns messages={[
      { sequence: 1, role: "user", content: asked("AIDC", "你来判断 AIDC 状态灯") },
      { sequence: 2, role: "assistant", content: "建议黄灯。" },
      { sequence: 3, role: "user", content: "首页上问的" },
    ]} />);
    expect(html.match(/战场 · AIDC/g)).toHaveLength(1);
    expect(html).not.toContain("【页面】");
    expect(html).not.toContain("战场id=");
  });
});
