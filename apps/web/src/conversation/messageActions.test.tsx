import { readFileSync } from "node:fs";
import { isValidElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Check, Copy } from "lucide-react";

/**
 * 新首页两种对话里每块旁边那一排（本人 11/18）：回应、回复、复制；点过的表情在右下角；回复挂在输入框上、发出去带引用。
 * 没有浏览器：画出来的样子用 renderToStaticMarkup 看；点按钮时直接调组件，把这几个 hook 换成按顺序记账的版本（只在直接调的时候换）。
 */
const hooks = vi.hoisted(() => ({ on: false, values: [] as unknown[], at: 0, contexts: new Map<unknown, unknown>() }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial: unknown) => {
      if (!hooks.on) return react.useState(initial);
      const key = hooks.at++;
      const values = hooks.values;
      if (!(key in values)) values[key] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [values[key], (next: unknown) => { values[key] = typeof next === "function" ? (next as (value: unknown) => unknown)(values[key]) : next; }];
    },
    useRef: (initial: unknown) => {
      if (!hooks.on) return react.useRef(initial);
      const key = hooks.at++;
      if (!(key in hooks.values)) hooks.values[key] = { current: initial };
      return hooks.values[key];
    },
    useEffect: (run: () => void, deps?: readonly unknown[]) => (hooks.on ? undefined : react.useEffect(run, deps)),
    useMemo: (compute: () => unknown, deps: readonly unknown[]) => (hooks.on ? compute() : react.useMemo(compute, deps)),
    useContext: (context: import("react").Context<unknown>) => (hooks.on ? hooks.contexts.get(context) ?? null : react.useContext(context)),
  };
});
const toast = vi.hoisted(() => vi.fn());
vi.mock("@/lib/toast", () => ({ showWorkspaceToast: toast }));

import { ChatInput } from "@/components/home/Conversations";
import type { ConversationData, Message } from "./useConversation";
import { MessageActions, ReactionContext, useMessageReaction } from "./Reactions";
import { BubbleContext } from "./ReplyBubbles";
import { ReplyContext, SentReply, useReplyStore } from "./replyTo";
import { ConversationTurn } from "./Transcript";
import { MESSAGE_REPLY, quotedMessage } from "./quotes";
import b from "@/styles/conversation-bubbles.module.css";

const bubblesCss = readFileSync(new URL("../styles/conversation-bubbles.module.css", import.meta.url), "utf8");
/** 样式表里某条规则（选择器原样）花括号里的内容。 */
const rule = (selector: string) => {
  const at = bubblesCss.indexOf(`${selector} {`);
  return at < 0 ? "" : bubblesCss.slice(at, bubblesCss.indexOf("}", at));
};

/** 一个组件实例：直接调它时 hook 按顺序记在自己的一格里，调多次就是重画。 */
function instance() {
  const values: unknown[] = [];
  return <T,>(run: () => T, contexts: [unknown, unknown][] = []): T => {
    hooks.on = true; hooks.values = values; hooks.at = 0; hooks.contexts = new Map(contexts);
    try { return run(); } finally { hooks.on = false; }
  };
}
type Props = Record<string, unknown> & { children?: ReactNode };
/** 元素树里所有满足条件的元素（看 children，也看别的放元素的属性）。 */
function find(node: unknown, test: (element: ReactElement<Props>) => boolean, out: ReactElement<Props>[] = []): ReactElement<Props>[] {
  if (Array.isArray(node)) for (const child of node) find(child, test, out);
  else if (isValidElement<Props>(node)) {
    if (test(node)) out.push(node);
    for (const value of Object.values(node.props)) if (typeof value === "object") find(value, test, out);
  }
  return out;
}
const byLabel = (tree: unknown, label: string) => find(tree, (element) => element.props["aria-label"] === label)[0];
const byText = (tree: unknown, text: string) => find(tree, (element) => element.props.children === text)[0];
/** 把树里的某个自己写的组件（按名字）就地画一层。 */
const expand = (tree: unknown, name: string, own = instance()) => {
  const element = find(tree, (item) => typeof item.type === "function" && item.type.name === name)[0]!;
  return own(() => (element.type as (props: Props) => ReactNode)(element.props));
};

const answer: Message = { sequence: 2, role: "assistant", content: "第一段，先把清单发给财务。\n\n第二段，周三再确认一遍。", runId: "run-1" };
const mine: Message = { sequence: 1, role: "user", content: "交给你了", runId: "run-1" };
const reactions = { of: () => [] as { part: number; emoji: string }[], toggle: vi.fn() };
const idle = { target: null, to: vi.fn(), clear: vi.fn() };

const inBubbles = (message: Message, { store = reactions as typeof reactions | null, reply = idle as typeof idle | null, streaming = false } = {}) => renderToStaticMarkup(
  <ReactionContext.Provider value={store}><ReplyContext.Provider value={reply}><BubbleContext.Provider value={true}>
    <ConversationTurn message={message} streaming={streaming} />
  </BubbleContext.Provider></ReplyContext.Provider></ReactionContext.Provider>);

/** 从 at 处那个 <div 起，到和它配对的 </div> 为止。 */
const divAt = (html: string, at: number) => {
  const tags = /<div\b[^>]*>|<\/div>/g;
  tags.lastIndex = at;
  let depth = 0;
  for (let tag = tags.exec(html); tag; tag = tags.exec(html)) {
    depth += tag[0].startsWith("</") ? -1 : 1;
    if (depth === 0) return html.slice(at, tags.lastIndex);
  }
  return html.slice(at);
};
const divsWith = (html: string, attribute: string) => [...html.matchAll(new RegExp(`<div[^>]*${attribute}[^>]*>`, "g"))].map((match) => divAt(html, match.index!));
const labels = (html: string) => (html.match(/aria-label="[^"]+"/g) ?? []).map((label) => label.slice(12, -1));

beforeEach(() => { toast.mockReset(); reactions.toggle.mockReset(); });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("每块旁边一排：回应、回复、复制", () => {
  it("伙伴的每一块悬停时右边出一排三个按钮，底边没有加表情按钮", () => {
    const html = inBubbles(answer);
    const blocks = divsWith(html, 'data-bubble="buddy"');
    expect(blocks).toHaveLength(2);
    for (const block of blocks) {
      const [row] = divsWith(block, 'data-testid="message-actions"');
      expect(row).toContain(`class="${b.actions}"`);
      expect(labels(row!)).toEqual(["回应", "回复", "复制"]);
    }
    expect(html).not.toContain('data-testid="reaction-add"');
    // 卡片也是一块。
    const card = inBubbles({ ...answer, content: "先看这个。\n\n## 本周\n\n- 周二发清单\n- 周三确认" });
    expect(labels(divsWith(card.slice(card.indexOf("<section")), 'data-testid="message-actions"')[0]!)).toEqual(["回应", "回复", "复制"]);
    // 在块的右边外侧离 8（用内边距补上这段，鼠标移过去不断），上下居中；鼠标在这一块上、焦点进来、浮层开着时才出。
    expect(rule(".actions")).toContain("left: 100%;");
    expect(bubblesCss).toContain(":is(.buddy, .mine, .card):is(:hover, :focus-within) > .actions");
    // 有鼠标的窄窗口：气泡也给这一排让位，不伸出对话栏。
    expect(bubblesCss).toMatch(/@media \(hover: hover\) and \(max-width: 959px\) \{\s*\.buddy, \.mine \{ max-width: min\(85%, 100% - 96px\); \}/);
  });

  it("本人那句的按钮在左边", () => {
    const [bubble] = divsWith(inBubbles(mine), 'data-bubble="mine"');
    expect(labels(divsWith(bubble!, 'data-testid="message-actions"')[0]!)).toEqual(["回应", "回复", "复制"]);
    // 镜像：在气泡左边外侧，离 8，顺序反过来（回应挨着气泡）。
    expect(rule(".mine > .actions")).toContain("right: 100%;");
  });

  it("没有 runId 时只出回复和复制", () => {
    const html = inBubbles({ ...answer, runId: undefined });
    for (const block of divsWith(html, 'data-bubble="buddy"')) expect(labels(divsWith(block, 'data-testid="message-actions"')[0]!)).toEqual(["回复", "复制"]);
    expect(labels(divsWith(divsWith(inBubbles({ ...mine, runId: undefined }), 'data-bubble="mine"')[0]!, 'data-testid="message-actions"')[0]!)).toEqual(["回复", "复制"]);
  });

  it("正在写的那条不出按钮", () => {
    expect(inBubbles(answer, { streaming: true })).not.toContain('data-testid="message-actions"');
    // 别处（没有回复，不是新首页的两种对话）也不出。
    expect(inBubbles(answer, { reply: null })).not.toContain('data-testid="message-actions"');
    expect(renderToStaticMarkup(<ReplyContext.Provider value={idle}><ConversationTurn message={answer} /></ReplyContext.Provider>)).not.toContain('data-testid="message-actions"');
  });

  it("点复制把这一块的原文写进剪贴板并换成勾", async () => {
    vi.useFakeTimers();
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const own = instance();
    const draw = () => own(() => MessageActions({ text: "第一段，先把清单发给财务。", user: false, onReply: () => undefined }));
    const icon = () => (byLabel(draw(), "复制")!.props.children as ReactElement).type;
    expect(icon()).toBe(Copy);
    (byLabel(draw(), "复制")!.props.onPress as () => void)();
    await vi.advanceTimersByTimeAsync(0);
    expect(writeText).toHaveBeenCalledWith("第一段，先把清单发给财务。");
    expect(icon()).toBe(Check);
    expect(toast).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1600);
    expect(icon()).toBe(Copy);
    // 没复制上：说一声，不换勾。
    writeText.mockRejectedValueOnce(new Error("denied"));
    (byLabel(draw(), "复制")!.props.onPress as () => void)();
    await vi.advanceTimersByTimeAsync(0);
    expect(toast).toHaveBeenCalledWith({ text: "没复制上" });
    expect(icon()).toBe(Copy);
  });

  it("右键打开的浮层里有回复和复制", async () => {
    vi.stubGlobal("window", { getSelection: () => ({ toString: () => "" }) });
    const writeText = vi.fn(async () => undefined);
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    const replies = { ...idle, to: vi.fn() };
    const hook = instance();
    const contexts: [unknown, unknown][] = [[ReactionContext, reactions], [ReplyContext, replies]];
    hook(() => useMessageReaction(answer, true), contexts)!.target!.onContextMenu({ preventDefault: vi.fn(),
      target: { closest: () => ({ getAttribute: () => "1" }) } } as never);
    const actions = hook(() => useMessageReaction(answer, true), contexts)!.actions!;
    const row = actions(1, 2, "第二段，周三再确认一遍。");
    const own = instance();
    const tree = own(() => (row.type as (props: Props) => ReactNode)(row.props as Props));
    const menu = () => expand(tree, "ReactionMenu");
    expect(find(menu(), (element) => element.props.isOpen === true)).toHaveLength(1);
    // 上面照旧六个快捷表情加「更多」，下面一行「回复」「复制」。
    expect(find(menu(), (element) => typeof element.type === "function" && element.type.name === "QuickReactions")).toHaveLength(1);
    (byText(menu(), "回复")!.props.onClick as () => void)();
    expect(replies.to).toHaveBeenCalledWith("第二段，周三再确认一遍。");
    (byText(menu(), "复制")!.props.onClick as () => void)();
    await Promise.resolve();
    expect(writeText).toHaveBeenCalledWith("第二段，周三再确认一遍。");
  });

  it("伙伴块上点过的表情在右下角", () => {
    const html = inBubbles(answer, { store: { of: () => [{ part: 0, emoji: "👍" }], toggle: vi.fn() } });
    const [first] = divsWith(html, 'data-bubble="buddy"');
    const [edge] = divsWith(first!, `class="${b.edge}"`);
    expect(edge).toMatch(/aria-label="点赞"[^>]*>👍<\/button>/);
    expect(edge).not.toContain('data-testid="message-actions"');
    expect(rule(".edge")).toContain("right: 8px;");
  });
});

describe("回复", () => {
  const data = (send = vi.fn(async () => true)) => ({ scope: "global", streaming: false, interruptible: false, stop: () => undefined, send }) as unknown as ConversationData;
  /** 输入框：ChatInput 交给 InputBar 的那个元素；画出来看引用条。 */
  const input = (own: ReturnType<typeof instance>, replies: unknown, conversation = data(), context: { label: string; onClear: () => void } | null = null) =>
    own(() => ChatInput({ data: conversation, placeholder: "与伙伴讨论…", onHeight: () => undefined, context }), [[ReplyContext, replies]]) as ReactElement<Props>;
  const quoteBar = (element: ReactElement<Props>) => {
    const html = renderToStaticMarkup(element);
    return html.match(/<span[^>]*data-testid="input-quote"[^>]*>.*?<\/span>/)?.[0] ?? null;
  };
  /** 第 part 块的「回复」：直接调这一块那一排。 */
  const replyOn = (replies: unknown, part: number, text: string) => {
    const hook = instance();
    const row = hook(() => useMessageReaction(answer, true), [[ReactionContext, reactions], [ReplyContext, replies]])!.actions!(part, 2, text);
    const tree = instance()(() => (row.type as (props: Props) => ReactNode)(row.props as Props));
    (byLabel(tree, "回复")!.props.onPress as () => void)();
  };

  it("点回复后输入框上方出现这一块开头的引用条，再点另一块换掉，点 × 去掉", () => {
    const store = instance();
    const replies = () => store(() => useReplyStore("global"));
    const own = instance();
    expect(quoteBar(input(own, replies()))).toBeNull();
    replyOn(replies(), 0, "第一段，先把清单发给财务，周二之前要发出去。");
    const first = input(own, replies());
    expect(quoteBar(first)).toContain("回复 第一段，先把清单发给财务，周二之…");
    // 换了一条，输入框获得焦点（InputBar 按 key 换了聚焦）。
    const key = (first.props.quote as { key: string }).key;
    replyOn(replies(), 1, "第二段，周三再确认一遍。");
    const second = input(own, replies());
    expect(quoteBar(second)).toContain("回复 第二段，周三再确认一遍。");
    expect(quoteBar(second)).not.toContain("第一段");
    expect((second.props.quote as { key: string }).key).not.toBe(key);
    (second.props.quote as { onClear: () => void }).onClear();
    expect(quoteBar(input(own, replies()))).toBeNull();
    // 换对话清掉：回复属于那条对话。
    replyOn(replies(), 0, "第一段");
    expect(store(() => useReplyStore("project:p1")).target).toBeNull();
  });

  it("带回复发出的是 quotedMessage 格式，发出后引用条消失", async () => {
    const store = instance();
    const replies = () => store(() => useReplyStore("global"));
    replyOn(replies(), 1, "第二段，周三再确认一遍。");
    const id = replies().target!.id;
    // 没发出去：引用条留着。
    const failed = vi.fn(async () => false);
    await (input(instance(), replies(), data(failed)).props.onSend as (text: string, files: File[]) => Promise<boolean>)("好的", []);
    expect(replies().target?.id).toBe(id);
    const send = vi.fn(async () => true);
    const ok = await (input(instance(), replies(), data(send), { label: "关于：会议回流", onClear: () => undefined }).props.onSend as (text: string, files: File[]) => Promise<boolean>)("好的", []);
    expect(ok).toBe(true);
    expect(send).toHaveBeenCalledWith(quotedMessage("关于：会议回流\n\n好的", [{ id, text: "第二段，周三再确认一遍。", source: { scope: "global", intent: MESSAGE_REPLY } }]), [], { attachments: [] });
    expect(replies().target).toBeNull();
    expect(quoteBar(input(instance(), replies()))).toBeNull();
  });

  it("转给同事发出后引用条也清掉", async () => {
    const store = instance();
    const replies = () => store(() => useReplyStore("global"));
    replyOn(replies(), 0, "第一段，先把清单发给财务。");
    const send = vi.fn(async () => true);
    const intercept = vi.fn(async () => true);
    const element = instance()(() => ChatInput({ data: data(send), placeholder: "与伙伴讨论…", onHeight: () => undefined, intercept }), [[ReplyContext, replies()]]) as ReactElement<Props>;
    expect(await (element.props.onSend as (text: string, files: File[]) => Promise<boolean>)("给财务的", [])).toBe(true);
    expect(intercept).toHaveBeenCalledWith("给财务的", []);
    expect(send).not.toHaveBeenCalled();
    expect(replies().target).toBeNull();
  });

  it("发出的那句上方一行淡色回复摘要，点开看全文", () => {
    const full = "第二段，周三再确认一遍：清单里的三家供应商都要回签，没回签的周四打电话问。";
    const sent: Message = { ...mine, content: quotedMessage("好的", [{ id: "q", text: full, source: { scope: "global", intent: MESSAGE_REPLY } }]) };
    const html = inBubbles(sent);
    const line = html.match(/<button[^>]*data-testid="sent-reply"[^>]*>.*?<\/button>/)?.[0] ?? "";
    expect(line).toContain("第二段，周三再确认一遍：清单里的三家供应商都要回…");
    expect(html.indexOf('data-testid="sent-reply"')).toBeLessThan(html.indexOf('data-bubble="mine"'));
    // 旧的引用胶囊不出（新首页一种字号、不用写死的颜色）。
    expect(html).not.toContain("data-quote-chip");
    // 点开：浮层里是全文。
    const own = instance();
    const tree = () => own(() => SentReply({ text: full }));
    expect(find(tree(), (element) => element.props.isOpen === false)).toHaveLength(1);
    (find(tree(), (element) => "onOpenChange" in element.props)[0]!.props.onOpenChange as (open: boolean) => void)(true);
    expect(find(tree(), (element) => element.props.isOpen === true)).toHaveLength(1);
    expect(byText(tree(), full)).toBeDefined();
    // 旧界面照旧是引用胶囊。
    expect(renderToStaticMarkup(<ConversationTurn message={sent} />)).toContain("data-quote-chip");
  });
});
