import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { ConversationDock } from "./ConversationDock";
import { ConversationHistorySheet } from "./ConversationHistorySheet";
import { ConversationThinking, ConversationTurn } from "./Transcript";
import { failureCopy, isAttachable, messagesEndpoint, type ConversationData } from "./useConversation";

const noop = () => undefined;

function card(id: string, title: string): Card {
  return {
    schemaVersion: 1,
    id,
    version: 3,
    kind: "issue",
    objectRef: { type: "issue", id, version: 3 },
    title,
    payload: {},
    actions: [],
  } as unknown as Card;
}

function data(patch: Partial<ConversationData> = {}): ConversationData {
  return {
    scope: "global",
    messages: [],
    status: "idle",
    streaming: false,
    partial: "",
    stage: "thinking",
    startedAt: 0,
    error: null,
    lastReply: null,
    attachments: [],
    uploading: false,
    attachmentError: null,
    uploadFiles: async () => undefined,
    removeAttachment: noop,
    send: async () => true,
    stop: noop,
    ...patch,
  } as unknown as ConversationData;
}

function dock(patch: Partial<Parameters<typeof ConversationDock>[0]> = {}) {
  return renderToStaticMarkup(
    <ConversationDock
      data={data()}
      label="公司全局"
      global
      detail={false}
      keyboard={false}
      onKeyboardChange={noop}
      historyOpen={false}
      onToggleHistory={noop}
      references={[]}
      onRemoveReference={noop}
      onClearReferences={noop}
      onRestoreReferences={noop}
      {...patch}
    />,
  );
}

describe("对话端点与附件", () => {
  it("历史与发送都走这一页的那条对话，没有会话端点", () => {
    expect(messagesEndpoint("global")).toBe("/api/conversations/global/messages");
    expect(messagesEndpoint("issue:abc")).toBe("/api/conversations/issue%3Aabc/messages");
  });

  it("附件类型白名单只接受 PDF/DOCX/MD", () => {
    expect(isAttachable({ name: "brief.pdf" })).toBe(true);
    expect(isAttachable({ name: "brief.DOCX" })).toBe(true);
    expect(isAttachable({ name: "notes.md" })).toBe(true);
    expect(isAttachable({ name: "notes.txt" })).toBe(false);
    expect(isAttachable({ name: "deck.pptx" })).toBe(false);
  });


  it("失败文案按错误码说明后果，未知错误说明页面操作仍可用（C-04）", () => {
    expect(failureCopy("TURN_TIMEOUT")).toContain("已停止");
    expect(failureCopy(undefined)).toBe("对话服务暂时没有接通。页面操作仍可用。");
  });
});

describe("全局输入条（clark workspace 614–640）", () => {
  it("默认是语音面：主按钮「点击说话」（语音输入），渲染时不请求麦克风", () => {
    const html = dock();
    expect(html).toContain("点击说话");
    expect(html).toContain('aria-label="语音输入"');
    expect(html).not.toContain("语音未接入");
    expect(html).toContain('aria-label="切换键盘输入"');
    expect(html).toContain("查看“公司全局”的对话记录");
  });

  it("键盘面：首页占位「输入你的想法…」，二级页「继续聊聊…」，引用后改为围绕引用", () => {
    expect(dock({ keyboard: true })).toContain('placeholder="输入你的想法…"');
    expect(dock({ keyboard: true })).toContain('aria-label="全局对话输入"');
    const detail = dock({ keyboard: true, detail: true, global: false, label: "交付力量先支持灯塔" });
    expect(detail).toContain('placeholder="继续聊聊…"');
    expect(detail).toContain('aria-label="交付力量先支持灯塔对话输入"');
    expect(dock({ keyboard: true, references: [card("c1", "议题")] })).toContain('placeholder="围绕引用的卡片，聊聊你的判断…"');
  });

  it("回答进行中主按钮变成「停止回答」", () => {
    const html = dock({ data: data({ streaming: true, status: "streaming" }) });
    expect(html).toContain("停止回答");
    expect(html).toContain('aria-label="停止本次回答"');
  });

  it("引用只属于全局对话：二级页不显示引用托盘，改为「在全局讨论」", () => {
    const refs = [card("c1", "交付力量先支持灯塔，还是 TokenOps？")];
    expect(dock({ references: refs })).toContain("交付力量先支持灯塔，还是 TokenOps？");
    const detail = dock({ references: refs, global: false, detail: true, pendingGlobalReferences: 1, onDiscussGlobal: noop });
    expect(detail).toContain("在全局讨论已引用的 1 张卡片");
  });
});

describe("对话记录", () => {
  it("一轮对话不写角色名，只用无障碍名称区分你与天枢，并写出用时与引用", () => {
    const html = renderToStaticMarkup(
      <ConversationTurn
        message={{
          sequence: 2,
          role: "assistant",
          content: "先确认灯塔的付费意愿。",
          createdAt: "2026-09-23T02:00:12.000Z",
          referencesSnapshot: [{ cardId: "c1", version: 1, kind: "issue", title: "灯塔" }],
        }}
        ms={12000}
      />,
    );
    expect(html).toContain("先确认灯塔的付费意愿。");
    expect(html).toContain("天枢");
    expect(html).not.toContain(">助手<");
  });

  it("思考中显示阶段文案与停止入口", () => {
    const html = renderToStaticMarkup(<ConversationThinking stage="researching" startedAt={Date.now()} onStop={noop} />);
    expect(html).toContain("正在快速查证");
  });

  it("历史层：全局欢迎语与对象欢迎语不同", () => {
    const global = renderToStaticMarkup(<ConversationHistorySheet data={data()} label="公司全局" global onClose={noop} />);
    expect(global).toContain("从你正在想的事情开始。");
    const topic = renderToStaticMarkup(<ConversationHistorySheet data={data({ scope: "issue:1" })} label="灯塔" global={false} onClose={noop} />);
    expect(topic).toContain("从“灯塔”里你最想弄清的地方开始。");
  });
});
