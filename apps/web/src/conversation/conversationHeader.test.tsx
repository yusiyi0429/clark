import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
import { ConversationHistorySheet } from "./ConversationHistorySheet";
import { ConversationTurn } from "./Transcript";
import type { ConversationData, Message } from "./useConversation";

/**
 * 一条连续的对话（已定设计第 1 节）：对话层里没有「新建对话」「+」、没有历史对话列表；以及备用模型标注。静态渲染看结构，样式规则直接读 CSS 文件。
 */
const noop = () => undefined;
const css = (name: string) => readFileSync(new URL(`../styles/${name}`, import.meta.url), "utf8");
const messages: Message[] = [
  { sequence: 1, role: "user", content: "词元云集的长期目标是什么？", runId: "r1" },
  { sequence: 2, role: "assistant", content: "长期目标是……", runId: "r1" },
];
function data(patch: Partial<ConversationData> = {}): ConversationData {
  return { scope: "global", messages: [], status: "idle", streaming: false, partial: "", stage: "thinking", startedAt: 0, error: null, lastReply: null,
    historyStatus: "ready", historyError: null, retryHistory: noop, attachments: [], uploading: false, attachmentError: null,
    uploadFiles: async () => undefined, removeAttachment: noop, send: async () => true, stop: noop, ...patch } as unknown as ConversationData;
}

describe("一条连续的对话", () => {
  it("首页对话层与对象对话层：有内容、空白时都没有「新对话」「+」和「查看历史对话」", () => {
    for (const sheet of [
      renderToStaticMarkup(<ConversationHistorySheet data={data({ messages })} label="天枢" global onClose={noop} />),
      renderToStaticMarkup(<ConversationHistorySheet data={data()} label="天枢" global onClose={noop} />),
      renderToStaticMarkup(<ConversationHistorySheet data={data({ messages, scope: "issue:1" })} label="议题" global={false} onClose={noop} />),
    ]) {
      expect(sheet).not.toContain("conversation-new");
      expect(sheet).not.toContain("新对话");
      expect(sheet).not.toContain("历史对话");
      expect(sheet).not.toMatch(/session/i);
    }
  });
});

describe("备用模型标注", () => {
  const note = { text: "本轮因上游异常改由备用模型完成", detail: "原因：模型服务这次没有响应。处理：换用备用模型 1 次。" };
  it("回答末尾一行 12px 的淡字，悬停看说明；提问、正在写的回答不显示", () => {
    const html = renderToStaticMarkup(<ConversationTurn message={{ ...messages[1], recoveryNote: note }} />);
    expect(html).toContain("本轮因上游异常改由备用模型完成");
    expect(html).toContain(`title="${note.detail}"`);
    expect(html.indexOf("长期目标是")).toBeLessThan(html.indexOf("本轮因上游异常"));
    expect(renderToStaticMarkup(<ConversationTurn message={{ ...messages[1], recoveryNote: note }} streaming />)).not.toContain("conversation-recovery-note");
    expect(renderToStaticMarkup(<ConversationTurn message={{ ...messages[0], recoveryNote: note }} />)).not.toContain("conversation-recovery-note");
    expect(renderToStaticMarkup(<ConversationTurn message={messages[1]} />)).not.toContain("conversation-recovery-note");
    const rule = css("conversation-transcript.module.css").match(/\.recoveryNote\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/font-size:12px/);
    expect(rule).toMatch(/color:#a5a5af/);
  });
});
