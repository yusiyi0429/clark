import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import { readFileSync } from "node:fs";
// 历史层的时间线会读提案（演示外不发请求），只需要一个路由桩。
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: () => undefined }) }));
import { ConversationDock } from "./ConversationDock";
import { ConversationHistorySheet } from "./ConversationHistorySheet";
import { JumpToLatest, JUMP_GAP, composerClearance } from "./Transcript";
import type { ConversationData } from "./useConversation";
import type { TextQuote } from "./quotes";

/**
 * 全局对话第三轮（spec D1–D4、D6）：页头横条去掉（两角留圆形玻璃键）、历史键删掉而附件进输入条、
 * ↓ 贴着输入框上沿且流式中是三点、引用进输入框、输入条上方的气泡去掉。
 * 没有 jsdom：静态渲染看结构，样式规则直接读 CSS 文件。
 */
const noop = () => undefined;
const css = (name: string) => readFileSync(new URL(`../styles/${name}`, import.meta.url), "utf8");

function data(patch: Partial<ConversationData> = {}): ConversationData {
  return { scope: "global", messages: [], status: "idle", streaming: false, partial: "", stage: "thinking", startedAt: 0, error: null, lastReply: null,
    historyStatus: "ready", historyError: null, retryHistory: noop, attachments: [], uploading: false, attachmentError: null,
    uploadFiles: async () => undefined, removeAttachment: noop, send: async () => true, stop: noop, ...patch } as unknown as ConversationData;
}
function dock(patch: Partial<Parameters<typeof ConversationDock>[0]> = {}) {
  return renderToStaticMarkup(<ConversationDock data={data()} label="天枢" global detail={false} keyboard={false} onKeyboardChange={noop}
    historyOpen={false} references={[]} onRemoveReference={noop} onClearReferences={noop} onRestoreReferences={noop} {...patch} />);
}
/** 从 start 处的 `<div` 起，找到与它配对的 `</div>` 的位置。 */
function closingDiv(html: string, start: number): number {
  const tags = /<div\b|<\/div>/g;
  tags.lastIndex = start;
  let depth = 0;
  for (let match = tags.exec(html); match; match = tags.exec(html)) {
    depth += match[0] === "</div>" ? -1 : 1;
    if (depth === 0) return match.index;
  }
  return -1;
}
const quote: TextQuote ={ id: "quote-1", text: "先保灯塔交付，再推 TokenOps", source: { scope: "global" } };

describe("D1 对话层没有页头横条", () => {
  it("没有页头横条；顶上正中是伙伴（不可点），右上是「收起 ⌄」，左上不再有天枢标识；附件不在对话层里；正文从顶部开始", () => {
    const html = renderToStaticMarkup(<ConversationHistorySheet data={data()} label="天枢" global onClose={noop} />);
    expect(html).not.toContain("<header");
    expect(html).toContain('aria-label="收起对话记录"');
    expect(html).toMatch(/<span[^>]*data-testid="conversation-sheet-buddy"><span[^>]*data-place="sheet" data-skin="classic"[^>]*aria-hidden="true"/);
    expect(html).not.toContain("conversation-sheet-mark");
    expect(html).not.toContain("上传附件");
    // 拖拽条、两颗角键之后就是滚动正文，中间没有别的一层。
    expect(html).toMatch(/<section[^>]*><div[^>]*aria-hidden="true"[^>]*><\/div><span[^>]*conversation-sheet-buddy[\s\S]*?<\/span><\/span><button[^>]*收起对话记录[\s\S]*?<\/button><div[^>]*data-testid="conversation-scroll"/);
  });
  it("附件上传状态仍在对话层里显示", () => {
    expect(renderToStaticMarkup(<ConversationHistorySheet data={data({ uploading: true })} label="天枢" global onClose={noop} />)).toContain("附件上传中…");
  });
  it("样式：没有页头那一套；两颗角键是圆形液态玻璃（半透明白底 + 模糊 + 细高光边）", () => {
    const shell = css("app-shell.module.css");
    expect(shell).not.toMatch(/\.historySheet \.sheetHeader/);
    expect(shell).not.toMatch(/historyHeaderActions/);
    const glass = shell.match(/\.historySheet \.glassButton\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(glass).toMatch(/border-radius:\s*50%/);
    expect(glass).toMatch(/backdrop-filter:\s*blur/);
    expect(glass).toMatch(/background:\s*#ffffff[0-9a-f]{2}/);
    expect(glass).toMatch(/border:\s*1px solid #ffffff/);
  });
});

describe("D2 输入条：没有历史键；打字面左边是 [附件] [小麦克风]", () => {
  it("键盘面：[附件] [小麦克风] 输入框；没有历史键", () => {
    const html = dock({ keyboard: true });
    const attach = html.indexOf("上传附件（PDF/DOCX/Markdown）");
    const mic = html.indexOf('aria-label="语音输入"');
    expect(attach).toBeGreaterThan(-1);
    expect(mic).toBeGreaterThan(attach);
    expect(html.indexOf("<textarea")).toBeGreaterThan(mic);
    expect(html).not.toContain("对话记录");
  });
  it("收起时：只有主按钮，没有历史键、附件键、麦克风", () => {
    const html = dock();
    expect(html).not.toContain("对话记录");
    expect(html).not.toContain("上传附件");
    expect(html).not.toContain("语音输入");
    expect(css("conversation-dock.module.css")).toMatch(/\.layer \.dock:not\(\.typing\)\{width:calc\(10px \+ 136px \+ 2px\)/);
  });
  it("主按钮不用主题蓝（主题蓝只留给约会议）", () => {
    const rule = css("conversation-dock.module.css").match(/\.dock \.entryButton\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(rule).toMatch(/background:/);
    expect(rule).not.toMatch(/#3a83f7|#007aff/i);
  });
});

describe("D3 ↓ 圆球贴着输入框上沿；流式中是「正在输出」三点", () => {
  it("间距按实际位置算：容器下沿到输入框上沿的距离 + 12", () => {
    expect(JUMP_GAP).toBe(12);
    expect(composerClearance(900, 828)).toBe(84);
    expect(composerClearance(900, 760)).toBe(152);
    // 量不到（输入框还没排好）时也不会沉到容器外面。
    expect(composerClearance(900, 950)).toBe(JUMP_GAP);
  });
  it("流式中球里是三个圆点，结束变回 ↓；点击都是回到最新", () => {
    const streaming = renderToStaticMarkup(<JumpToLatest visible streaming onJump={noop} />);
    expect(streaming).toContain('data-streaming="true"');
    expect(streaming).toContain('aria-label="回到最新"');
    expect(streaming.match(/<i><\/i>/g)).toHaveLength(3);
    expect(streaming).not.toContain("<svg");
    const idle = renderToStaticMarkup(<JumpToLatest visible onJump={noop} />);
    expect(idle).not.toContain("data-streaming");
    expect(idle).toContain("<svg");
  });
  it("全局对话层：流式中把三点传给球；球不在滚动区里（按对话层定位，不再 sticky）", () => {
    const html = renderToStaticMarkup(<ConversationHistorySheet data={data({ streaming: true, thinking: true, status: "streaming", partial: "先核对" })} label="天枢" global onClose={noop} />);
    expect(html).toContain('data-streaming="true"');
    // 滚动区先结束，球在它后面、仍在对话层 section 里。
    const jump = html.indexOf('data-testid="conversation-jump-latest"');
    expect(jump).toBeGreaterThan(closingDiv(html, html.lastIndexOf("<div", html.indexOf('data-testid="conversation-scroll"'))));
    expect(jump).toBeLessThan(html.indexOf("</section>"));
  });
  it("不再用写死的 --jump-bottom；对话层读输入条实际位置，右列读 --conversation-composer-height", () => {
    const shell = css("app-shell.module.css");
    expect(shell).not.toMatch(/--jump-bottom:\s*\d+px/);
    const sheetJump = shell.match(/\.historySheet \.historyJump\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(sheetJump).toMatch(/position:\s*absolute/);
    expect(sheetJump).toMatch(/bottom:\s*var\(--jump-bottom/);
    const column = css("conversation-column.module.css");
    const railJump = column.match(/\.panel \.latestJump\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(railJump).toMatch(/position:\s*absolute/);
    expect(railJump).toMatch(/bottom:\s*calc\(var\(--conversation-composer-height[^)]*\)\s*\+\s*24px/);
  });
  it("圆点在减少动态效果时不动画", () => {
    expect(css("conversation-transcript.module.css")).toMatch(/@media\s*\(prefers-reduced-motion:\s*reduce\)\s*\{[^}]*\.jumpDots i\s*\{[^}]*animation:\s*none/);
  });
});

describe("D4 引用放进输入框里", () => {
  it("待发送的引用在输入框内部（文字行上方那一行），输入框随之长高；不再是框外的浮条", () => {
    const html = dock({ keyboard: true, historyOpen: true, textQuotes: [quote], onRemoveQuotes: noop });
    const inside = html.slice(html.indexOf('data-testid="conversation-dock"'));
    expect(inside).toContain('aria-label="待发送的文字批注"');
    expect(inside.indexOf("待发送的文字批注")).toBeLessThan(inside.indexOf("<textarea"));
    expect(html).toContain('data-has-tray="true"');
    // 只有文字引用时不按卡片引用那样把输入条撑成整宽。
    expect(html).toContain('data-has-references="false"');
  });
  it("没有引用时不留那一行", () => {
    const html = dock({ keyboard: true });
    expect(html).toContain('data-has-tray="false"');
    expect(html).not.toContain("待发送的文字批注");
  });
  it("样式：没有框外引用浮条；引用行跟卡片引用同一行高；输入框里的引用块浅灰小底、无外框", () => {
    const rules = css("conversation-dock.module.css");
    expect(rules).not.toContain("textQuoteTray");
    expect(rules).toMatch(/\.layer\[data-has-tray=true\] \.dock\s*\{[^}]*padding-top:\s*45px/);
    const chip = rules.match(/\.dock \[data-quote-chip\]\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(chip).toMatch(/border-color:\s*transparent/);
    expect(chip).toMatch(/background:\s*#/);
  });
});

describe("D6 输入条上方没有气泡：消息都在对话层里", () => {
  it("回答、刚问的话、失败说明都不在输入条上方", () => {
    for (const patch of [{ streaming: true, thinking: true, status: "streaming", stage: "answering", partial: "先核对本月签约目标。" },
      { lastReply: { text: "先核对本月签约目标。", ms: 900 } }, { error: "先核对本月签约目标。" }] as Partial<ConversationData>[]) {
      const html = dock({ data: data(patch) });
      expect(html).not.toContain("先核对本月签约目标。");
      expect(html).not.toContain("关闭本次对话气泡");
    }
  });
  it("样式里没有气泡那一套", () => {
    expect(css("conversation-dock.module.css")).not.toMatch(/caption/i);
  });
  it("听写出错的提示、发送失败的说明在对话层里", () => {
    const html = renderToStaticMarkup(<ConversationHistorySheet data={data({ error: "和模型服务的网络连接中断了，已自动恢复 3 次仍未成功（多半是本机网络或代理切换）。已写出的部分保留在上方，点「继续」从断点接着写。" })} label="天枢" global onClose={noop}
      notice="麦克风未授权，无法语音输入。可在浏览器地址栏左侧开启麦克风权限。" />);
    expect(html).toContain("和模型服务的网络连接中断了，已自动恢复 3 次仍未成功（多半是本机网络或代理切换）。已写出的部分保留在上方，点「继续」从断点接着写。");
    expect(html).toContain("麦克风未授权，无法语音输入。");
  });
  it("对话层升起与输入条展开是同一个动作：同一时长、同一缓动", () => {
    const rise = css("app-shell.module.css").match(/\.historySheet\{[^}]*animation:historyRise (\d+ms) ([^ ]+\)) both/);
    expect(rise?.[1]).toBe("340ms");
    expect(css("conversation-dock.module.css")).toContain(`width ${rise?.[1]} ${rise?.[2]}`);
  });
});
