import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ColumnComposer } from "./ColumnComposer";
import { ComposerAction } from "./ComposerPill";
import { ConversationColumn, type ConversationChannel } from "./ConversationColumn";
import { readColumnMode } from "./useColumnMode";
import type { ConversationData } from "./useConversation";

const noop = () => undefined;
const agent: ConversationChannel[] = [{ id: "agent", kind: "agent", label: "我的 Agent", title: "CEO Agent", unread: 0 }];

function data(patch: Partial<ConversationData> = {}): ConversationData {
  return { scope: "issue:1", streaming: false, attachments: [], removeAttachment: noop, send: async () => true, stop: noop, ...patch } as unknown as ConversationData;
}

function composer(patch: Partial<Parameters<typeof ColumnComposer>[0]> = {}) {
  return renderToStaticMarkup(
    <ColumnComposer
      data={data()}
      label="灯塔"
      channels={agent}
      channel="agent"
      onChannel={noop}
      narrow={false}
      mobileOpen={false}
      onMobileOpen={noop}
      references={[]}
      onHeightChange={noop}
      {...patch}
    />,
  );
}

describe("二级页右列（clark ConversationColumn）", () => {
  it("页头写明是谁的 Agent；收起后留一颗「我的 Agent」频道钮", () => {
    const html = renderToStaticMarkup(
      <ConversationColumn channels={agent} channel="agent" onChannel={noop} mode="expanded" onMode={noop} mobileOpen={false} onMobileOpen={noop} composerHeight={90} ariaLabel="灯塔 · 对话" testId="rail">
        <p>正文</p>
      </ConversationColumn>,
    );
    expect(html).toContain("CEO Agent");
    expect(html).toContain('data-mode="expanded"');
    expect(html).toContain('aria-label="收起对话栏"');
    expect(html).toContain("展开对话栏：我的 Agent");
  });

  it("收起偏好只认 strip，其余一律展开", () => {
    expect(readColumnMode("strip")).toBe("strip");
    expect(readColumnMode("expanded")).toBe("expanded");
    expect(readColumnMode(null)).toBe("expanded");
    expect(readColumnMode("garbage")).toBe("expanded");
  });
});

describe("右列底下的两行输入条", () => {
  it("只有「我的 Agent」时宽屏不画频道开关；窄屏画这一颗，作为打开浮层的入口", () => {
    expect(composer()).not.toContain("data-channel-switch");
    const narrow = composer({ narrow: true });
    expect(narrow).toContain("data-channel-switch");
    expect(narrow).toContain("我的 Agent");
  });

  it("提示文字是「问你的 Agent…」，空着时右端是能按的麦克风（语音输入）", () => {
    const html = composer();
    expect(html).toContain('placeholder="问你的 Agent…"');
    expect(html).toContain('aria-label="语音输入"');
    expect(html).toContain('data-state="mic"');
    expect(html).not.toContain("语音对话尚未接入");
  });

  it("回答进行中右端变成停止", () => {
    expect(composer({ data: data({ streaming: true }) })).toContain('aria-label="停止本次回答"');
  });

  it("有字时右端是提交用的发送钮", () => {
    const html = renderToStaticMarkup(<ComposerAction state="send" />);
    expect(html).toContain('aria-label="发送"');
    expect(html).toContain('type="submit"');
  });

  it("二级页上已引用卡片时，输入条上方给出「在全局讨论 · N」", () => {
    const card = { id: "issue:1", title: "灯塔", version: 1 } as never;
    expect(composer({ references: [card], onDiscussGlobal: noop })).toContain("在全局讨论 · 1");
  });

  it("附件在输入条最上面一行，能单独移除", () => {
    const html = composer({ data: data({ attachments: [{ id: "a1", fileName: "纪要.pdf", mimeType: "application/pdf" }] }) });
    expect(html).toContain("纪要.pdf");
    expect(html).toContain('aria-label="移除附件 纪要.pdf"');
  });
});
