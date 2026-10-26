import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
// 历史层的时间线会读提案（演示外不发请求），只需要一个路由桩。
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
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
    historyStatus: "ready",
    historyError: null,
    retryHistory: noop,
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


  it("失败文案按出错的环节说清楚，没有笼统的「暂不可用」，也不显示英文原文（C-04）", () => {
    expect(failureCopy("UNREACHABLE", "Failed to fetch")).toBe("没发出去，原文已放回输入框。");
    expect(failureCopy("STREAM_BROKEN", "network error")).toBe("连接中断了。");
    expect(failureCopy("HTTP_502", "")).toBe("没发出去，原文已放回输入框。");
    expect(failureCopy("RUNTIME_FAILED", "terminated")).toBe("这次回答没有完成。");
    expect(failureCopy("NETWORK_INTERRUPTED", "和模型服务的网络连接中断了。已写出的部分保留在上方，点「继续」从断点接着写。"))
      .toBe("和模型服务的网络连接中断了。已写出的部分保留在上方，点「继续」从断点接着写。");
    for (const code of [undefined, "RUNTIME_FAILED", "TURN_TIMEOUT", "HTTP_500", "STREAM_ENDED", "STREAM_SILENT", "X"]) {
      const text = failureCopy(code, "OpenAI API error (503): Unknown service error");
      expect(text).not.toMatch(/暂不可用|OpenAI|Unknown/);
    }
  });

  it("模型拒绝回答时显示中文说明，不推断修改是否完成", () => {
    const text = failureCopy("CONTENT_FILTER", "Provider rejected request: content_filter");
    expect(text).toBe("模型服务没有受理这次请求（内容审核未通过）。问题已保留，可以换个说法后重试。");
    expect(text).not.toMatch(/Provider|content_filter|没有接通|未完成修改|已修改/);
  });
});

describe("全局输入条（clark workspace 614–640）", () => {
  it("收起时只有一颗主按钮「对话天枢」：没有「点击说话」、切换键和麦克风", () => {
    const html = dock();
    expect(html).toContain("对话天枢");
    expect(html).toContain('aria-expanded="false"');
    expect(html).not.toContain("点击说话");
    expect(html).not.toContain("语音输入");
    expect(html).not.toContain("切换键盘输入");
    // D2：没有历史键。
    expect(html).not.toContain("对话记录");
  });

  it("键盘面：首页占位「输入问题或指令…」，二级页「继续讨论…」，批注后改为围绕批注", () => {
    expect(dock({ keyboard: true })).toContain('placeholder="输入问题或指令…"');
    expect(dock({ keyboard: true })).toContain('aria-label="全局对话输入"');
    // 展开后附件旁边是小麦克风（天枢自己的听写，存在感放低）。
    expect(dock({ keyboard: true })).toContain('aria-label="语音输入"');
    const detail = dock({ keyboard: true, detail: true, global: false, label: "交付力量先支持灯塔" });
    expect(detail).toContain('placeholder="继续讨论…"');
    expect(detail).toContain('aria-label="交付力量先支持灯塔对话输入"');
    expect(dock({ keyboard: true, references: [card("c1", "议题")] })).toContain('placeholder="围绕批注的内容输入问题或判断…"');
  });

  it("回答进行中：收起时主按钮仍是「对话天枢」，停止在输入框右边（发送键的位置）", () => {
    const html = dock({ data: data({ streaming: true, thinking: true, status: "streaming" }) });
    expect(html).toContain("对话天枢");
    expect(html).not.toContain("停止回答");
    expect(dock({ keyboard: true, data: data({ streaming: true, thinking: true, status: "streaming" }) })).toContain('aria-label="停止本次回答"');
  });

  it("输入条上方没有气泡（D6）：回答、刚问的话、失败说明都只在对话层里", () => {
    const streaming = dock({ data: data({ streaming: true, thinking: true, status: "streaming", stage: "answering", partial: "先核对本月签约目标。" }) });
    expect(streaming).not.toContain("先核对本月签约目标。");
    expect(streaming).not.toContain("关闭本次对话气泡");
    expect(streaming).not.toContain("完整对话记录");
    expect(dock({ data: data({ lastReply: { text: "## 结论" + String.fromCharCode(10) + "**增长**放缓", ms: 1200 } }) })).not.toContain("增长");
    expect(dock({ data: data({ error: "服务暂时没接通（*重试*）" }) })).not.toContain("服务暂时没接通");
  });

  it("输入条标出历史读取状态，供页面与验收脚本识别", () => {
    expect(dock({ data: data({ historyStatus: "error", historyError: null }) })).toContain('data-history-status="error"');
    expect(dock()).toContain('data-history-status="ready"');
  });

  it("引用只属于全局对话：二级页不显示引用托盘，改为「在全局讨论」", () => {
    const refs = [card("c1", "交付力量先支持灯塔，还是 TokenOps？")];
    expect(dock({ references: refs })).toContain("交付力量先支持灯塔，还是 TokenOps？");
    const detail = dock({ references: refs, global: false, detail: true, pendingGlobalReferences: 1, onDiscussGlobal: noop });
    expect(detail).toContain("在全局讨论已批注的 1 项");
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

  it("历史层：空对话不写欢迎语，全局空态只留历史入口", () => {
    const global = renderToStaticMarkup(<ConversationHistorySheet data={data()} label="公司全局" global onClose={noop} />);
    expect(global).not.toContain("可从当前关注的问题开始讨论。");
    const topic = renderToStaticMarkup(<ConversationHistorySheet data={data({ scope: "issue:1" })} label="灯塔" global={false} onClose={noop} />);
    expect(topic).not.toContain("待澄清的问题开始讨论");
  });

  it("历史层记录归属写在 data-conversation-owner 上；不再写「… · 仅你可见」", () => {
    const global = renderToStaticMarkup(<ConversationHistorySheet data={data()} label="天枢" global onClose={noop} />);
    expect(global).not.toContain("全局对话 · 仅你可见");
    expect(global).toContain('data-conversation-owner="global"');
    const topic = renderToStaticMarkup(<ConversationHistorySheet data={data({ scope: "issue:1" })} label="灯塔" global={false} onClose={noop} />);
    expect(topic).not.toContain("仅你可见");
    expect(topic).toContain('data-conversation-owner="object"');
    expect(topic).not.toContain("全局对话");
  });

  it("历史层：载入中、真的没有、没读到三种画法不同，没读到不显示欢迎语", () => {
    const sheet = (patch: Partial<ConversationData>) =>
      renderToStaticMarkup(<ConversationHistorySheet data={data({ scope: "issue:1", ...patch })} label="灯塔" global={false} onClose={noop} />);
    const loading = sheet({ historyStatus: "loading" });
    expect(loading).toContain("正在载入对话记录…");
    expect(loading).toContain('data-history="loading"');
    expect(loading).toContain('data-empty="false"');
    expect(loading).not.toContain("你最想弄清的地方开始");
    const failed = sheet({ historyStatus: "error", historyError: null });
    expect(failed).toContain("对话记录暂未载入");
    expect(failed).not.toMatch(/服务出错|已记录/);
    // 连接类自己重试过仍没读到：一行灰字（status），不是醒目的告警；登录、权限类才用 alert。
    expect(failed).toContain('role="status"');
    expect(sheet({ historyStatus: "error", historyError: "登录状态已失效，请重新进入后再试。" })).toContain('role="alert"');
    expect(failed).toContain("重试");
    expect(failed).toContain('data-empty="false"');
    expect(failed).not.toContain("你最想弄清的地方开始");
    const empty = sheet({});
    expect(empty).toContain('data-empty="true"');
    expect(empty).not.toContain("待澄清的问题开始讨论");
    expect(empty).not.toContain("正在载入对话记录");
    expect(empty).not.toContain("重试");
  });

  it("历史层：已显示的消息在刷新失败、重新载入时都留着，提示接在下面", () => {
    const messages = [{ sequence: 1, role: "user" as const, content: "灯塔的付费意愿怎么判断？" }];
    const failed = renderToStaticMarkup(<ConversationHistorySheet data={data({ messages, historyStatus: "error", historyError: null })} label="天枢" global onClose={noop} />);
    expect(failed).toContain("灯塔的付费意愿怎么判断？");
    expect(failed).toContain("对话记录暂未刷新");
    expect(failed.indexOf("灯塔的付费意愿怎么判断？")).toBeLessThan(failed.indexOf("对话记录暂未刷新"));
    const reloading = renderToStaticMarkup(<ConversationHistorySheet data={data({ messages, historyStatus: "loading" })} label="天枢" global onClose={noop} />);
    expect(reloading).toContain("灯塔的付费意愿怎么判断？");
    expect(reloading).toContain("正在刷新对话记录…");
  });

  it("历史层在完成前显示流式正文，完成后只显示保存的回复，并保持浅色", () => {
    const first = renderToStaticMarkup(<ConversationHistorySheet data={data({ streaming: true, thinking: true, status: "streaming", partial: "先核对本月签约目标。" })} label="公司全局" global onClose={noop} />);
    expect(first).toContain('data-tone="light"');
    expect(first).toContain('data-testid="conversation-streaming-turn"');
    expect(first).toContain("先核对本月签约目标。");
    const saved = renderToStaticMarkup(<ConversationHistorySheet data={data({ status: "complete", messages: [{ sequence: 2, role: "assistant", content: "先核对本月签约目标。再看管线。" }] })} label="公司全局" global onClose={noop} />);
    expect(saved).not.toContain('data-testid="conversation-streaming-turn"');
    expect(saved.match(/先核对本月签约目标。再看管线。/g)).toHaveLength(1);
  });

  it("历史层：「思考中」那一行的位置一直留着（结束时不缩回）；底部有 ↓ 回到最新，在底部时藏起", () => {
    const streaming = renderToStaticMarkup(<ConversationHistorySheet data={data({ streaming: true, thinking: true, status: "streaming", partial: "先核对" })} label="公司全局" global onClose={noop} />);
    const idle = renderToStaticMarkup(<ConversationHistorySheet data={data({ status: "complete", messages: [{ sequence: 2, role: "assistant", content: "先核对。" }] })} label="公司全局" global onClose={noop} />);
    for (const html of [streaming, idle]) {
      expect(html).toContain('data-testid="conversation-status-slot"');
      expect(html).toMatch(/data-testid="conversation-jump-latest"/);
      expect(html).not.toContain("data-visible");
    }
    expect(streaming).toContain('data-testid="conversation-thinking"');
    expect(idle).not.toContain('data-testid="conversation-thinking"');
  });
});
