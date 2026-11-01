import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { ColumnComposer } from "./ColumnComposer";
import { ComposerAction } from "./ComposerPill";
import { ConversationColumn, type ConversationChannel } from "./ConversationColumn";
import { readColumnMode } from "./useColumnMode";
import type { ConversationData } from "./useConversation";

const noop = () => undefined;
const agent: ConversationChannel[] = [{ id: "agent", kind: "agent", label: "天枢", title: "我的对话", unread: 0 }];

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
  it("页头只写「我的对话」一行，不再写当前对话对象；收起后留一颗「天枢」频道钮", () => {
    const html = renderToStaticMarkup(
      <ConversationColumn channels={agent} channel="agent" onChannel={noop} mode="expanded" onMode={noop} mobileOpen={false} onMobileOpen={noop} composerHeight={90} ariaLabel="灯塔 · 对话" testId="rail">
        <p>正文</p>
      </ConversationColumn>,
    );
    expect(html).toContain("我的对话");
    expect(html).not.toContain("围绕");
    expect(html).toContain('data-mode="expanded"');
    expect(html).toContain('aria-label="收起对话栏"');
    expect(html).toContain("展开对话栏：天枢");
  });

  it("胶囊上写着伙伴名字（Miles）时，伙伴频道页头不再画 logo 和名字；别的外形、群聊、没有胶囊时照旧", () => {
    const group: ConversationChannel[] = [...agent, { id: "group", kind: "group", label: "事项群组 · 3", title: "事项群组 · 3", unread: 0 }];
    const header = (patch: { channel?: string; coagent?: boolean; coagentNamed?: boolean }) => {
      const html = renderToStaticMarkup(
        <ConversationColumn channels={group} channel={patch.channel ?? "agent"} onChannel={noop} mode="expanded" onMode={noop} mobileOpen={false} onMobileOpen={noop}
          composerHeight={90} ariaLabel="灯塔 · 对话" testId="rail" coagent={patch.coagent ? <span data-skin="miles" /> : undefined} coagentNamed={patch.coagentNamed}>
          <p>正文</p>
        </ConversationColumn>,
      );
      return html.match(/<header[\s\S]*?<\/header>/)?.[0] ?? "";
    };
    const named = header({ coagent: true, coagentNamed: true });
    expect(named).not.toContain("我的对话");
    expect(named).not.toContain("data-tianshu-mark");
    expect(named).not.toContain("<h2");
    for (const plain of [header({ coagent: true }), header({ coagentNamed: true })]) {
      expect(plain).toContain("我的对话");
      expect(plain).toContain("data-tianshu-mark");
    }
    expect(header({ channel: "group", coagent: true, coagentNamed: true })).toContain("事项群组 · 3");
  });

  it("收起偏好只认 strip，其余一律展开", () => {
    expect(readColumnMode("strip")).toBe("strip");
    expect(readColumnMode("expanded")).toBe("expanded");
    expect(readColumnMode(null)).toBe("expanded");
    expect(readColumnMode("garbage")).toBe("expanded");
  });
});

describe("右列底下的两行输入条", () => {
  it("只有「天枢」时宽屏不画频道开关；窄屏画这一颗，作为打开浮层的入口", () => {
    expect(composer()).not.toContain("data-channel-switch");
    const narrow = composer({ narrow: true });
    expect(narrow).toContain("data-channel-switch");
    expect(narrow).toContain("天枢");
  });

  it("提示文字是「与天枢讨论…」，空着时右端是停用的发送钮，旁边是附件和小麦克风", () => {
    const html = composer();
    expect(html).toContain('placeholder="与天枢讨论…"');
    const send = html.match(/<button[^>]*data-state="send"[^>]*>/)?.[0] ?? "";
    expect(send).toContain("disabled");
    const mic = html.indexOf('aria-label="语音输入"');
    expect(mic).toBeGreaterThan(html.indexOf("上传附件"));
    expect(html.indexOf('data-state="send"')).toBeGreaterThan(mic);
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

describe("深度讨论（并排）在右列里", () => {
  const rail = (patch: Partial<Parameters<typeof ConversationColumn>[0]> = {}, body = <p>正文</p>) => renderToStaticMarkup(
    <ConversationColumn channels={agent} channel="agent" onChannel={noop} mode="expanded" onMode={noop} mobileOpen={false} onMobileOpen={noop}
      composerHeight={90} ariaLabel="标准交付 · 对话" testId="rail" {...patch}>
      {body}
    </ConversationColumn>,
  );
  /** 从右列面板开始到正文之间的标签序列：切换时这一段不能变（变了就是重挂了正文）。 */
  const pathToBody = (html: string, marker = "正文") => html.slice(html.indexOf("<aside"), html.indexOf(marker)).replace(/<button[\s\S]*?<\/button>/g, "").match(/<\w+/g);

  it("平时：列头右侧一颗「深度讨论」键（aria-expanded=false）；宿主不给 onDesk 就没有", () => {
    const html = rail({ onDesk: noop });
    expect(html).toContain('aria-label="深度讨论"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain("data-desk-key");
    expect(html).toContain("data-has-desk-key");
    expect(html).not.toContain("data-desk=");
    expect(rail()).not.toContain("深度讨论");
  });

  it("展开：键变「收起」，收起对话栏的把手不画；页头标题不变、不加字；没有右栏、抽屉、inert", () => {
    const html = rail({ onDesk: noop, deskWidth: 600 });
    expect(html).toContain('data-desk="true"');
    expect(html).toContain('aria-label="收起"');
    expect(html).toContain('aria-expanded="true"');
    expect(html).not.toContain("收起对话栏");
    expect(html).toContain("我的对话");
    expect(html).not.toContain("data-desk-stage");
    expect(html).not.toContain("data-drawer");
    expect(html).not.toContain("对象与台账");
    // 只有收起后的那一溜频道钮是 inert 的（右列展开着）；右列本身不 inert。
    expect(html.slice(html.indexOf("<aside"), html.indexOf("</aside>"))).not.toContain("inert");
  });

  it("窄屏（浮层）一律当没给", () => {
    expect(rail({ onDesk: noop, deskWidth: null })).not.toContain("data-desk=");
  });

  it("回答流式输出中切换：正文前面的包裹层不变（对话、滚动区、草稿不重挂）", () => {
    const streaming = <div role="log"><p>已经输出的一段</p><span data-streaming>正文</span></div>;
    const plain = pathToBody(rail({ onDesk: noop }, streaming));
    expect(plain).not.toBeNull();
    expect(pathToBody(rail({ onDesk: noop, deskWidth: 600 }, streaming))).toEqual(plain);
    expect(pathToBody(rail({ onDesk: noop, deskWidth: 680 }, streaming))).toEqual(plain);
  });
});
