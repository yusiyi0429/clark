import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { Card } from "@/lib/api/client";
import { ConversationDock, ExpandedConversationDialog, ExpandedHeaderBrand, messagesEndpoint, sessionLabel, isAttachable, EXPANDED_PLACEHOLDER, conversationTitleFor, scopeChipFor } from "./ConversationDock";

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

const noop = () => undefined;
const railNode = (
  <>
    <header><span>本次引用</span><span>2 项</span></header>
    <ul><li>Issue · 增长战场</li><li>note.md</li></ul>
    <p>回答只引用以上对象，不检索其他数据。</p>
  </>
);
const dialogProps = {
  dialogRef: { current: null },
  label: "公司全局",
  sessions: [{ id: "s-aaaa1111", title: "渠道讨论", createdAt: "2026-09-20T02:00:00.000Z" }, { id: "s-bbbb2222" }],
  activeSessionId: "s-aaaa1111",
  sessionError: null,
  dragOver: false,
  deleteTarget: null,
  rail: railNode,
  onDismiss: noop,
  onCreateSession: noop,
  onSelectSession: noop,
  onDeleteSession: noop,
  onDeleteCancel: noop,
  onDeleteConfirm: noop,
  onUploadFiles: noop,
  onDragEnter: noop,
  onDragLeave: noop,
  header: null,
  transcript: null,
  feedback: null,
  tray: null,
  composer: null,
};

const originalFetch = global.fetch;

beforeEach(() => {
  global.fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ sessions: [], messages: [] }) })) as unknown as typeof fetch;
});

afterEach(() => {
  global.fetch = originalFetch;
  vi.restoreAllMocks();
});

function fetchCalls(): string[] {
  return (global.fetch as unknown as ReturnType<typeof vi.fn>).mock.calls.map((call) => String(call[0]));
}

describe("ConversationDock 扩展对话", () => {
  it("未选择会话回退 legacy 消息端点，选择后走 session 端点", () => {
    expect(messagesEndpoint("global", null)).toBe("/api/conversations/global/messages");
    expect(messagesEndpoint("global", "s-1")).toBe("/api/conversations/global/sessions/s-1/messages");
    expect(messagesEndpoint("issue:abc", null)).toBe("/api/conversations/issue%3Aabc/messages");
  });

  it("会话列渲染会话、当前选中与语义删除按钮", () => {
    const markup = renderToStaticMarkup(<ExpandedConversationDialog {...dialogProps} />);
    expect(markup).toContain("渠道讨论");
    expect(markup).toContain("会话 s-bbbb22");
    expect(markup).toContain('aria-current="true"');
    expect(markup).toContain("删除会话 渠道讨论");
    expect(markup).toContain("新建会话");
    expect(markup).toContain("当前会话独立保存消息与附件。");
  });

  it("未选择会话时提示 legacy 回退；上传反馈与错误通过 role=alert 渲染", () => {
    const markup = renderToStaticMarkup(
      <ExpandedConversationDialog
        {...dialogProps}
        activeSessionId={null}
        sessionError="会话列表加载失败"
        feedback={
          <>
            <p className="x" role="alert">仅支持 PDF、DOCX、Markdown（.md）附件。</p>
            <p className="y" aria-live="polite">附件上传中…</p>
          </>
        }
      />,
    );
    expect(markup).toContain("未选择会话：消息保存到本页默认会话。");
    expect(markup).toContain("会话列表加载失败");
    expect(markup).toContain("仅支持 PDF、DOCX、Markdown（.md）附件。");
    expect(markup).toContain("附件上传中");
  });

  it("本次引用栏渲染引用与附件并声明只引用声明对象", () => {
    const markup = renderToStaticMarkup(<ExpandedConversationDialog {...dialogProps} />);
    expect(markup).toContain('aria-label="本次引用"');
    expect(markup).toContain("本次引用");
    expect(markup).toContain("2 项");
    expect(markup).toContain("Issue · 增长战场");
    expect(markup).toContain("note.md");
    expect(markup).toContain("回答只引用以上对象，不检索其他数据。");
  });

  it("删除确认只在有待删会话时渲染为应用内弹层，不再使用 window.confirm", () => {
    const idle = renderToStaticMarkup(<ExpandedConversationDialog {...dialogProps} />);
    expect(idle).not.toContain("删除会话确认");

    const markup = renderToStaticMarkup(
      <ExpandedConversationDialog {...dialogProps} deleteTarget={{ id: "s-aaaa1111", title: "渠道讨论" }} />,
    );
    expect(markup).toContain('aria-label="删除会话确认"');
    expect(markup).toContain("删除会话");
    expect(markup).toContain("不再可见，且不可恢复");
    expect(markup).toContain("取消");
    expect(markup).toContain("删除");
    expect(markup).not.toContain("window.confirm");
  });

  it("扩展对话输入使用设计稿占位文案", () => {
    expect(EXPANDED_PLACEHOLDER).toBe("问天枢：可引用卡片与已签发计划，或拖入文件…");
  });

  it("Exp Header 标题从 scope 推导：全局与各对象域", () => {
    expect(conversationTitleFor("global")).toBe("天枢 · 全局对话");
    expect(conversationTitleFor("issue:11111111-1111-4111-8111-111111111111")).toBe("天枢 · 议题对话");
    expect(conversationTitleFor("meeting:11111111-1111-4111-8111-111111111111")).toBe("天枢 · 会议对话");
    expect(conversationTitleFor("signal:abc-123")).toBe("天枢 · 信号对话");
    expect(conversationTitleFor("monthly-plan:2026-09")).toBe("天枢 · 月度计划对话");
    expect(conversationTitleFor("custom:x")).toBe("天枢 · 对话");
  });

  it("Scope Chip 语义：global 固定首页全公司，对象域为页面 + 对象名", () => {
    expect(scopeChipFor("global", "公司全局")).toBe("作用域：首页 · 全公司");
    expect(scopeChipFor("meeting:11111111-1111-4111-8111-111111111111", "周会")).toBe("作用域：会议 · 周会");
    expect(scopeChipFor("issue:22222222", "追加东南亚渠道预算")).toBe("作用域：议题 · 追加东南亚渠道预算");
    expect(scopeChipFor("signal:s-1", "头部云厂商降价")).toBe("作用域：信号 · 头部云厂商降价");
    expect(scopeChipFor("monthly-plan:m-1", "月度计划 2026-09")).toBe("作用域：月度计划 · 月度计划 2026-09");
    expect(scopeChipFor("custom:x", "自定义")).toBe("作用域：自定义");
  });

  it("Exp Header 品牌区同行渲染标题与 Scope Chip（FRH4J）", () => {
    const global = renderToStaticMarkup(<ExpandedHeaderBrand scope="global" label="公司全局" />);
    expect(global).toContain("天枢 · 全局对话");
    expect(global).toContain("作用域：首页 · 全公司");
    expect(global).not.toContain("独立对话 · 公司全局");

    const meeting = renderToStaticMarkup(
      <ExpandedHeaderBrand scope="meeting:11111111-1111-4111-8111-111111111111" label="周会" />,
    );
    expect(meeting).toContain("天枢 · 会议对话");
    expect(meeting).toContain("作用域：会议 · 周会");
  });

  it("右栏头部是 Session Tools（新建 + 会话列表 pill），不再跳全局弹层", () => {
    const markup = renderToStaticMarkup(
      <ConversationDock
        scope="meeting:11111111-1111-4111-8111-111111111111"
        label="周会"
        availableCards={[card("issue:1", "关联议题")]}
        variant="sidebar"
        sidebar={{ title: "会前对话 · 本场会议", tone: "light", open: true, placeholder: "问点什么…" }}
      />,
    );
    expect(markup).toContain('aria-label="新建会话"');
    expect(markup).toContain('aria-label="会话列表，共 0 个"');
    expect(markup).toContain("会话 0");
    expect(markup).not.toContain("的会话管理");
    expect(markup).toContain('aria-label="折叠会前对话 · 本场会议"');
    expect(markup).toContain("问点什么…");
  });

  it("附件类型白名单只接受 PDF/DOCX/MD", () => {
    expect(isAttachable({ name: "brief.pdf" })).toBe(true);
    expect(isAttachable({ name: "brief.DOCX" })).toBe(true);
    expect(isAttachable({ name: "notes.md" })).toBe(true);
    expect(isAttachable({ name: "notes.txt" })).toBe(false);
    expect(isAttachable({ name: "deck.pptx" })).toBe(false);
  });

  it("会话标题回退到短 ID", () => {
    expect(sessionLabel({ id: "abcd1234-5678", title: "标题" })).toBe("标题");
    expect(sessionLabel({ id: "abcd1234-5678" })).toBe("会话 abcd1234");
  });
});
