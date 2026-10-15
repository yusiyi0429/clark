import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
import type { ReactElement } from "react";
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
import { ArchiveEntry, ConversationArchive, NewConversationKey, archiveDate, archiveTitle } from "./ConversationArchive";
import { ConversationHistorySheet } from "./ConversationHistorySheet";
import { ConversationTurn } from "./Transcript";
import type { ConversationData, Message } from "./useConversation";

/**
 * 新建对话（存在感越低越好）与备用模型标注：静态渲染看结构，样式规则直接读 CSS 文件。
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
    uploadFiles: async () => undefined, removeAttachment: noop, send: async () => true, stop: noop,
    archivedCount: 0, startNew: async () => true, restoreArchived: async () => true, switching: false, switchError: null, revision: 0, ...patch } as unknown as ConversationData;
}

describe("「+ 新对话」小图标", () => {
  it("当前对话有内容时才有：13px 的「+」，悬停提示「新对话」，点了直接新建（不弹确认）", () => {
    const startNew = vi.fn(async () => true);
    const html = renderToStaticMarkup(<NewConversationKey data={data({ messages, startNew })} />);
    expect(html).toContain('title="新对话"');
    expect(html).toContain('aria-label="新对话"');
    expect(html).toMatch(/<svg[^>]*width="13"[^>]*height="13"/);
    const element = NewConversationKey({ data: data({ messages, startNew }) }) as ReactElement<{ onClick: () => void }>;
    element.props.onClick();
    expect(startNew).toHaveBeenCalledTimes(1);
  });

  it("空白对话、回答进行中都不出现", () => {
    expect(renderToStaticMarkup(<NewConversationKey data={data()} />)).toBe("");
    expect(renderToStaticMarkup(<NewConversationKey data={data({ messages, streaming: true })} />)).toBe("");
  });

  it("首页全局对话层：星标右边；对象对话层里没有", () => {
    const global = renderToStaticMarkup(<ConversationHistorySheet data={data({ messages })} label="天枢" global onClose={noop} />);
    expect(global).toContain('data-testid="conversation-new"');
    expect(global.indexOf("conversation-sheet-mark")).toBeLessThan(global.indexOf("conversation-new"));
    const object = renderToStaticMarkup(<ConversationHistorySheet data={data({ messages, scope: "issue:1" })} label="议题" global={false} onClose={noop} />);
    expect(object).not.toContain("conversation-new");
  });

  it("样式：低对比度灰色、没有底色和边框，不是玻璃圆键", () => {
    const rule = css("conversation-transcript.module.css").match(/\.newConversation\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/color:#a5a5af/);
    expect(rule).toMatch(/background:none/);
    expect(rule).toMatch(/border:0/);
    expect(css("app-shell.module.css")).toMatch(/\.historySheet \.sheetNewKey\{position:absolute;[^}]*left:56px/);
    expect(css("conversation-column.module.css")).toMatch(/\.newKey\.newKey \{[^}]*left: 12px;/);
  });
});

describe("历史对话入口默认看不到", () => {
  it("只有当前对话为空、且有归档过的对话时，空白处一行很淡的「查看历史对话」", () => {
    expect(renderToStaticMarkup(<ArchiveEntry data={data({ archivedCount: 2 })} onOpen={noop} />)).toContain("查看历史对话");
    expect(renderToStaticMarkup(<ArchiveEntry data={data({ archivedCount: 0 })} onOpen={noop} />)).toBe("");
    expect(renderToStaticMarkup(<ArchiveEntry data={data({ archivedCount: 2, messages })} onOpen={noop} />)).toBe("");
    const sheet = renderToStaticMarkup(<ConversationHistorySheet data={data({ archivedCount: 1 })} label="天枢" global onClose={noop} />);
    expect(sheet).toContain("查看历史对话");
    const rule = css("conversation-transcript.module.css").match(/\.archiveEntry\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/font-size:12px/);
    expect(rule).toMatch(/color:#a5a5af/);
  });

  it("历史对话面板先显示载入中", () => {
    vi.stubGlobal("fetch", vi.fn(() => new Promise(() => undefined)));
    try {
      expect(renderToStaticMarkup(<ConversationArchive data={data()} onClose={noop} />)).toContain("正在载入历史对话…");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("标题取首问（去掉页面前缀与引用格式）的前 20 字；日期是几月几日 时:分", () => {
    expect(archiveTitle("词元云集的长期目标是什么？")).toBe("词元云集的长期目标是什么？");
    expect(archiveTitle("【页面】正在讨论战场「增长」（G1，战场id=bf-growth）\n\n这个战场本月最大的风险在哪里，应该先处理哪一件事")).toBe("这个战场本月最大的风险在哪里，应该先处理…");
    expect(archiveTitle("   ")).toBe("未命名对话");
    expect(archiveDate("2026-10-13T09:53:28.000Z")).toBe("10月13日 17:53");
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
