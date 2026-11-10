import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationThinking, ConversationTurn, ConversationTurns } from "./Transcript";

/** 思考过程（模型返回的思考摘要）的样子：正文开始前在进度区滚动显示最近几行；正文开始后收成「已思考 N 秒」，挂在这条回答的「用时」一行。 */
const noop = () => undefined;
const TEXT = "先核对两家公司的递表时间。\n\n再看融资金额与上市门槛。";

describe("思考过程的显示", () => {
  it("正文开始前：进度行上方滚动显示思考摘要，进度行照常显示阶段与已用时长", () => {
    const html = renderToStaticMarkup(<ConversationThinking stage="thinking" startedAt={Date.now()} onStop={noop}
      route={{ tier: "deep", expectSeconds: 90 }} thought={{ text: TEXT, seconds: null }} />);
    expect(html).toContain('data-testid="conversation-thinking-stream"');
    expect(html).toContain("再看融资金额与上市门槛。");
    expect(html).toContain("深入分析");
    expect(html.indexOf("conversation-thinking-stream")).toBeLessThan(html.indexOf('data-testid="conversation-thinking"'));
  });

  it("正文开始后进度区不再滚动显示；没有思考摘要时与原来一样", () => {
    const answering = renderToStaticMarkup(<ConversationThinking stage="answering" startedAt={Date.now()} onStop={noop} thought={{ text: TEXT, seconds: 9 }} />);
    expect(answering).not.toContain("conversation-thinking-stream");
    const none = renderToStaticMarkup(<ConversationThinking stage="thinking" startedAt={Date.now()} onStop={noop} />);
    expect(none).not.toContain("conversation-thinking-stream");
  });

  it("正文开始后：正在写的回答顶部是「已思考 N 秒」，默认收起；写完后与「用时」同一行", () => {
    const streaming = renderToStaticMarkup(<ConversationTurn message={{ sequence: -1, role: "assistant", content: "两家的融资是上市准备的一部分。" }} streaming thought={{ text: TEXT, seconds: 9 }} />);
    expect(streaming).toContain("已思考 9 秒");
    expect(streaming).toContain('aria-expanded="false"');
    expect(streaming).not.toContain("conversation-thought-full");
    expect(streaming).not.toContain("data-meta-placeholder");
    const turns = renderToStaticMarkup(<ConversationTurns thought={{ text: TEXT, seconds: 9 }} messages={[
      { sequence: 1, role: "user", content: "原因是什么？", createdAt: "2026-10-13T08:00:00Z" },
      { sequence: 2, role: "assistant", content: "上一轮回答。", createdAt: "2026-10-13T08:00:30Z" },
      { sequence: 3, role: "user", content: "两家递表后又融资的原因？", createdAt: "2026-10-13T08:01:00Z" },
      { sequence: 4, role: "assistant", content: "两家的融资是上市准备的一部分。", createdAt: "2026-10-13T08:02:10Z" },
    ]} />);
    expect(turns).toContain("用时 70 秒");
    // 只挂在本轮那条回答上
    expect(turns.match(/已思考 9 秒/g)?.length).toBe(1);
    expect(turns.indexOf("已思考 9 秒")).toBeGreaterThan(turns.indexOf("上一轮回答。"));
  });
});
