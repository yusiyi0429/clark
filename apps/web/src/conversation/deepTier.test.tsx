import { afterEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ConversationThinking, ConversationTurn, progressDetail } from "./Transcript";
import { failureCopy, withNotice } from "./useConversation";

/** 10/13 验收会后：重要的战略问题走深度档，开头先告诉一号位要多想一会儿、大约多久，之后进度行持续显示在查什么。 */
const NOTICE = "这个问题涉及资本动作背后逻辑的战略判断，需要更深入地查证和推演。";
const noop = () => undefined;
afterEach(() => vi.useRealTimers());

describe("深度档的开场说明与进度", () => {
  it("开场说明就是这条回答的第一段，与正文同样式；存进记录时也是同样拼法，读回历史不跳", () => {
    const streaming = renderToStaticMarkup(<ConversationTurn message={{ sequence: -1, role: "assistant", content: withNotice(NOTICE, "") }} streaming />);
    expect(streaming).toContain(NOTICE);
    expect(withNotice(NOTICE, "开头一段判断")).toBe(`${NOTICE}\n\n开头一段判断`);
    const saved = renderToStaticMarkup(<ConversationTurn message={{ sequence: 2, role: "assistant", content: withNotice(NOTICE, "开头一段判断") }} />);
    expect(saved.indexOf(NOTICE)).toBeLessThan(saved.indexOf("开头一段判断"));
    expect(saved.match(/<p>/g)?.length).toBe(2);
  });

  it("深度档的进度行：查资料、在查什么、已查几项、预计用时", () => {
    const html = renderToStaticMarkup(<ConversationThinking stage="researching" startedAt={Date.now()} onStop={noop}
      route={{ tier: "deep", expectSeconds: 90 }} progress={{ label: "检索公开来源「无问芯穹 递表」", checked: 3 }} />);
    expect(html).toContain("正在查资料");
    expect(html).toContain("检索公开来源「无问芯穹 递表」 · 已查 3 项");
    // 现场行写法（新首页设计 5.4.3）：用时 / 预计。
    expect(html).toContain("1 秒 / 约 1–2 分钟");
    expect(html).toContain('data-tier="deep"');
  });

  it("其他档不显示预计用时；没有进度时与原来一样", () => {
    const html = renderToStaticMarkup(<ConversationThinking stage="researching" startedAt={Date.now()} onStop={noop} route={{ tier: "grounded", expectSeconds: 30 }} />);
    expect(html).toContain("正在查资料");
    expect(html).not.toContain("约");
    expect(html).not.toContain("conversation-progress");
  });

  it("正文开始后不再显示在查什么，只留已查几项；不知道在查什么时不单独报数", () => {
    expect(progressDetail("answering", { label: "阅读企业知识原文", checked: 2 })).toBe("已查 2 项");
    expect(progressDetail("answering", { label: "阅读企业知识原文", checked: 0 })).toBeNull();
    expect(progressDetail("researching", { label: null, checked: 0 })).toBeNull();
    expect(progressDetail("thinking", { label: null, checked: 2 })).toBeNull();
    expect(progressDetail("answering", { label: null, checked: 2 })).toBeNull();
  });

  it("整轮超过绝对上限：用服务端给的中文说明（已写出的部分保留、点「继续」），英文原文不上屏", () => {
    const copy = "这次回答已经持续 10 分钟，为防止陷入循环先停在这里。已写出的部分保留在上方，点「继续」从断点接着写。";
    expect(failureCopy("TURN_TIMEOUT", copy)).toBe(copy);
    expect(failureCopy("TURN_TIMEOUT", "Conversation turn exceeded 600 seconds")).toBe("这次回答没有完成。");
  });
});

describe("分段进度行：理解问题、思考要点、中途升级、正文开始后淡化", () => {
  it("拿到具体阶段以前（刚发出、模型在想）只有呼吸点，不写「正在理解问题」「正在思考」这类笼统的词（新首页设计 5.4.3）", () => {
    for (const stage of ["understanding", "thinking"] as const) {
      const html = renderToStaticMarkup(<ConversationThinking stage={stage} startedAt={Date.now()} onStop={noop} />);
      expect(html).toContain('data-testid="conversation-thinking"');
      expect(html).not.toMatch(/正在理解问题|正在思考|思考中|处理中/);
      expect(html).toContain('<span role="status"></span>');
      expect(html).not.toContain("conversation-progress");
      expect(html).toContain("停止");
    }
  });

  it("思考时有中文要点就显示要点，没有就沿用最近读到的内容", () => {
    expect(progressDetail("thinking", { label: "已读企业知识《集团经营上下文》", checked: 3, thought: "比较现金消耗" })).toBe("比较现金消耗 · 已查 3 项");
    expect(progressDetail("thinking", { label: "已读企业知识《集团经营上下文》", checked: 3, thought: null })).toBe("已读企业知识《集团经营上下文》 · 已查 3 项");
    expect(progressDetail("researching", { label: "检索公开来源「硅基流动」", checked: 1, thought: "不该显示" })).toBe("检索公开来源「硅基流动」 · 已查 1 项");
  });

  it("非深度档中途升级：不另起一行解释，现场行写「深入分析」和整轮预计（升级时的用时 + 还需的秒数）；正文开始后不再写预计", () => {
    const escalation = { notice: "这个问题需要更深入的分析，预计还需约 40 秒。", expectSeconds: 40 };
    const html = renderToStaticMarkup(<ConversationThinking stage="thinking" startedAt={Date.now() - 21_000} onStop={noop}
      route={{ tier: "grounded", expectSeconds: 30 }} progress={{ label: null, checked: 2, escalation }} />);
    expect(html).not.toContain("这个问题需要更深入的分析");
    expect(html).not.toContain("conversation-escalation");
    expect(html).toContain('<span role="status">深入分析</span>');
    // 21 秒时升级、还需约 40 秒：整轮约 61 秒，向上取到 70 秒，过了 1 分钟写成分钟。
    expect(html).toContain("· 21 秒 / 约 1 分钟");
    const answering = renderToStaticMarkup(<ConversationThinking stage="answering" startedAt={Date.now()} onStop={noop}
      route={{ tier: "grounded", expectSeconds: 30 }} progress={{ label: null, checked: 2, escalation }} />);
    expect(answering).not.toContain("深入分析");
    expect(answering).not.toContain("约");
    expect(answering).toContain('data-stage="answering"');
    expect(answering).not.toContain("已查");
  });

  it("措辞不出现称呼和运行环境字眼", () => {
    const html = renderToStaticMarkup(<ConversationThinking stage="researching" startedAt={Date.now()} onStop={noop}
      route={{ tier: "grounded", expectSeconds: 30 }} progress={{ label: "检索公开来源", checked: 1, escalation: { notice: "这个问题需要更深入的分析，预计还需约 20 秒。", expectSeconds: 20 } }} />);
    expect(html).not.toMatch(/王总|您好|领导|演示|本场|demo/i);
  });
});
