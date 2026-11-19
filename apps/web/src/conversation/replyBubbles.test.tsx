import { readFileSync } from "node:fs";
import { isValidElement, type Context, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { Buddy } from "@/components/buddy/useBuddy";
import type { ConversationData, Message } from "./useConversation";

/**
 * 伙伴回复成气泡和卡片（设计 6.1–6.3）。没有 jsdom：
 * - 画出来看样子：renderToStaticMarkup；
 * - 计时、点按钮、量高度：React 的 hook 只在 hooks.active 时换成按调用顺序记账的版本（每个组件一本账），直接调组件，按真实的处理器走。
 */
type Slot = { deps?: readonly unknown[]; ran?: readonly unknown[]; run?: () => void | (() => void); cleanup?: void | (() => void) };
const hooks = vi.hoisted(() => {
  let active = false;
  let cursor = 0;
  let book = "";
  const books = new Map<string, unknown[]>();
  const provided = new Map<unknown, unknown>();
  let queue: Slot[] = [];
  const slots = () => { if (!books.has(book)) books.set(book, []); return books.get(book)!; };
  const changed = (slot: Slot) => !slot.ran || !slot.deps || slot.deps.some((dep, i) => !Object.is(dep, slot.ran![i]));
  return {
    get active() { return active; },
    begin(name: string) { active = true; cursor = 0; book = name; },
    end() { active = false; },
    reset() { active = false; books.clear(); provided.clear(); queue = []; },
    /** 卸载：这个组件的 effect 都清掉，账本扔掉（再调就是新挂上的）。 */
    unmount(name: string) {
      for (const slot of books.get(name) ?? []) if (slot && typeof (slot as Slot).cleanup === "function") (slot as Slot).cleanup!();
      books.delete(name);
    },
    provide(context: unknown, value: unknown) { provided.set(context, value); },
    useState(initial: unknown) {
      const list = slots();
      const index = cursor++;
      if (!(index in list)) list[index] = typeof initial === "function" ? (initial as () => unknown)() : initial;
      return [list[index], (value: unknown) => { list[index] = typeof value === "function" ? (value as (previous: unknown) => unknown)(list[index]) : value; }];
    },
    useRef(initial: unknown) {
      const list = slots();
      const index = cursor++;
      if (!(index in list)) list[index] = { current: initial };
      return list[index];
    },
    useMemo(compute: () => unknown, deps?: readonly unknown[]) {
      const list = slots();
      const index = cursor++;
      const slot = list[index] as { deps?: readonly unknown[]; value: unknown } | undefined;
      if (slot && deps && slot.deps && deps.every((dep, i) => Object.is(dep, slot.deps![i]))) return slot.value;
      const value = compute();
      list[index] = { deps, value };
      return value;
    },
    useId() { const index = cursor++; return `:${book}${index}:`; },
    useContext(context: Context<unknown>) { return provided.has(context) ? provided.get(context) : (context as unknown as { _currentValue: unknown })._currentValue; },
    useEffect(run: () => void | (() => void), deps?: readonly unknown[]) {
      const list = slots();
      const index = cursor++;
      const slot = (list[index] ??= {}) as Slot;
      slot.run = run;
      slot.deps = deps;
      queue.push(slot);
    },
    /** 提交：依赖变了的 effect 先清上一次再跑。 */
    flush() {
      for (const slot of queue) {
        if (!changed(slot)) continue;
        if (typeof slot.cleanup === "function") slot.cleanup();
        slot.cleanup = slot.run!();
        slot.ran = slot.deps;
      }
      queue = [];
    },
  };
});
const env = vi.hoisted(() => ({ meeting: { listening: false, clock: null as string | null, href: null as string | null } }));
vi.mock("react", async (original) => {
  const react = await original<typeof import("react")>();
  return {
    ...react,
    useState: (initial?: unknown) => (hooks.active ? hooks.useState(initial) : react.useState(initial)),
    useRef: (initial?: unknown) => (hooks.active ? hooks.useRef(initial) : react.useRef(initial)),
    useMemo: (compute: () => unknown, deps: readonly unknown[]) => (hooks.active ? hooks.useMemo(compute, deps) : react.useMemo(compute, deps)),
    useId: () => (hooks.active ? hooks.useId() : react.useId()),
    useContext: (context: Context<unknown>) => (hooks.active ? hooks.useContext(context) : react.useContext(context)),
    useEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => (hooks.active ? hooks.useEffect(run, deps) : react.useEffect(run, deps)),
    useLayoutEffect: (run: () => void | (() => void), deps?: readonly unknown[]) => (hooks.active ? hooks.useEffect(run, deps) : react.useLayoutEffect(run, deps)),
    useSyncExternalStore: <T,>(subscribe: (listener: () => void) => () => void, get: () => T, server?: () => T) =>
      (hooks.active ? get() : react.useSyncExternalStore(subscribe, get, server)),
  };
});
vi.mock("@/components/home/meetingState", () => ({ useHomeMeetingState: () => env.meeting }));
vi.mock("./dictationSignal", () => ({ useDictationSignal: () => null }));

import { SideDetailContext, type SideDetail } from "@/components/home/SideDetail";
import { Presence } from "@/components/home/Presence";
import { TransferHistory } from "@/components/home/Transfer";
import { WorkTimeline } from "@/components/work/WorkTimeline";
import { BubbleContext, CARD_FULL_LINES, HOLD_MS, ReplyBubbles, RevealContext, TypingBubble, resetReplyBubbles } from "./ReplyBubbles";
import { ARRIVAL_SETTLE_MS, ConversationTurn, ConversationTurns, MarkdownBody, TURN_PARTS, type MarkdownParts } from "./Transcript";
import { ThreadNamesContext, type ThreadName } from "./threadNames";
import { AnswerOptions, QuickReplyContext } from "./AnswerOptionRow";

const css = readFileSync(new URL("../styles/conversation-bubbles.module.css", import.meta.url), "utf8");
const miles = { name: "小天", form: "miles" } as Buddy;

type Element = ReactElement<Record<string, unknown>>;
function elements(node: ReactNode): Element[] {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement(node)) return [];
  const element = node as Element;
  return [element, ...elements(element.props.children as ReactNode)];
}
function text(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(text).join("");
  return isValidElement(node) ? text((node as Element).props.children as ReactNode) : "";
}
const named = (tree: ReactNode, name: string) => elements(tree).filter((element) => typeof element.type === "function" && element.type.name === name);
const button = (tree: ReactNode, label: string) => elements(tree).find((element) => element.type === "button" && text(element) === label);
/** 调一次组件（不经 React 渲染），拿到它这一层的元素树；book 是这个组件的那本账。 */
function call(book: string, render: () => ReactNode, flush = true): ReactNode {
  hooks.begin(book);
  let tree: ReactNode;
  try { tree = render(); } finally { hooks.end(); }
  if (flush) hooks.flush();
  return tree;
}
/** 调一个子组件元素。 */
const expand = (book: string, element: Element) => call(book, () => (element.type as (props: unknown) => ReactNode)(element.props));
/** 气泡和卡片：一块一样，按顺序。 */
const pieces = (tree: ReactNode) => elements(tree).filter((element) => typeof element.type === "function" && ["TextBubble", "ReplyCard"].includes(element.type.name))
  .map((element) => ({ kind: (element.type as { name: string }).name === "ReplyCard" ? "card" : "bubble", markdown: element.props.markdown, open: element.props.open }));
const typing = (tree: ReactNode) => elements(tree).some((element) => element.type === TypingBubble);
/** 卡片挂上以后量全文：给它量到的尺寸（wide：里面横向溢出的表格、代码）；ResizeObserver 有桩时记下它的回调。 */
type CardBox = { scrollHeight: number; clientHeight: number; wide?: { scrollWidth: number; clientWidth: number }[] };
function measureCard(book: string, element: Element, box: CardBox) {
  const first = call(book, () => (element.type as (props: unknown) => ReactNode)(element.props), false);
  const full = elements(first).find((child) => child.props.ref);
  if (full) (full.props.ref as { current: unknown }).current = { scrollWidth: 500, clientWidth: 500, ...box, querySelectorAll: () => box.wide ?? [] };
  hooks.flush();
}
const FITS: CardBox = { scrollHeight: 120, clientHeight: 120 };
const TALL: CardBox = { scrollHeight: 400, clientHeight: 312 };
const fullOf = (tree: ReactNode) => elements(tree).find((element) => element.props.ref);

const inBubbles = (node: ReactNode) => renderToStaticMarkup(<BubbleContext.Provider value={true}>{node}</BubbleContext.Provider>);
const assistant = (content: string, extra: Partial<Message> = {}): Message => ({ sequence: 2, role: "assistant", content, ...extra });

const data = (extra: Partial<ConversationData> = {}) => ({
  scope: "global", status: "streaming", streaming: true, thinking: true, partial: "", stage: "thinking", startedAt: Date.now() - 5_000,
  steps: [], plan: null, progress: undefined, thought: null, stop: vi.fn(), messages: [{ sequence: 1, role: "user", content: "帮我排一下" }],
  send: vi.fn(), rescope: vi.fn(), ...extra,
}) as unknown as ConversationData;

afterEach(() => {
  hooks.reset();
  // 模块里记着的（这一轮出没出、右边开着哪张卡、正在写的那条画到哪）：每个测试从空的开始。
  resetReplyBubbles();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("伙伴回复成气泡和卡片（设计 6.1–6.3）", () => {
  it("伙伴的回复按块成气泡和卡片，「打开」在右边打开", () => {
    const reply = "先说结论：先保灯塔。\n\n| 事 | 状态 |\n|---|---|\n| 灯塔交付 | 进行中 |\n| 回款 | 等对方 |\n\n其余的下周再说。";
    const html = inBubbles(<ConversationTurn message={assistant(reply, { createdAt: "2026-11-17T01:31:00.000Z" })} />);
    // 两个气泡夹一张卡；短的表格放得下，卡里直接是全文（放不下的才收成摘要加「打开」，见下面几条）。
    expect(html.match(/data-bubble="buddy"/g)).toHaveLength(2);
    expect(html.match(/data-card=""/g)).toHaveLength(1);
    expect(html.indexOf("先说结论")).toBeLessThan(html.indexOf("data-card"));
    expect(html.indexOf("data-card")).toBeLessThan(html.indexOf("其余的下周再说"));
    expect(html).toContain("09:31");
    expect(html).toContain("<table");
    expect(html).not.toContain(">打开</button>");
    // 本人的话：靠右的本人气泡。
    expect(inBubbles(<ConversationTurn message={{ sequence: 1, role: "user", content: "排一下本月" }} />)).toMatch(/data-bubble="mine"[^>]*>[\s\S]*排一下本月/);

    // 电脑上：「打开」→ 右边文件预览那一格，全文用 MarkdownBody 画，带关闭。
    const shown: { value: SideDetail["shown"] } = { value: null };
    const side = { get shown() { return shown.value; }, node: {} as HTMLElement, open: false, wide: false, toggle: vi.fn(), setWide: vi.fn(),
      show: vi.fn((kind: SideDetail["shown"]) => { shown.value = kind; }) } as unknown as SideDetail;
    hooks.provide(SideDetailContext, side);
    const card = named(call("bubbles", () => ReplyBubbles({ markdown: reply, streaming: false })), "ReplyCard")[0]!;
    measureCard("card", card, TALL);
    const before = expand("card", card);
    expect(text(before)).toContain("事 · 状态");
    expect(named(before, "SideContent")).toHaveLength(0);
    (button(before, "打开")!.props.onClick as () => void)();
    expect(side.show).toHaveBeenCalledWith("file");
    const opened = expand("card", card);
    const slot = named(opened, "SideContent")[0]!;
    expect(slot.props.kind).toBe("file");
    const preview = named(slot.props.children as ReactNode, "CardPreview")[0]!;
    vi.stubGlobal("window", { addEventListener: vi.fn(), removeEventListener: vi.fn() });
    const panel = expand("preview", preview);
    expect(elements(panel).find((element) => element.type === MarkdownBody)?.props.text).toBe(card.props.markdown);
    expect(text(panel)).toContain("事 · 状态");
    (elements(panel).find((element) => element.props["aria-label"] === "关闭")!.props.onPress as () => void)();
    expect(side.show).toHaveBeenLastCalledWith(null);
    expect(named(expand("card", card), "SideContent")).toHaveLength(0);

    // 手机上（没有右边那一格）：「打开」就地展开全文，「打开」收起来。
    hooks.reset();
    const phone = named(call("bubbles", () => ReplyBubbles({ markdown: reply, streaming: false })), "ReplyCard")[0]!;
    measureCard("card", phone, TALL);
    (button(expand("card", phone), "打开")!.props.onClick as () => void)();
    const inPlace = expand("card", phone);
    expect(elements(inPlace).find((element) => element.type === MarkdownBody)?.props.text).toBe(phone.props.markdown);
    expect(button(inPlace, "打开")).toBeUndefined();
    // 标题开头的一节：标题已经在页头上，全文里不再写一遍。
    hooks.reset();
    const section = named(call("bubbles", () => ReplyBubbles({ markdown: "## 这周安排\n\n- 周二：发清单\n- 周三：确认", streaming: false })), "ReplyCard")[0]!;
    measureCard("card", section, TALL);
    (button(expand("card", section), "打开")!.props.onClick as () => void)();
    expect(elements(expand("card", section)).find((element) => element.type === MarkdownBody)?.props.text).toBe("- 周二：发清单\n- 周三：确认");
    // 卡片：--surface 底、--hairline-strong 边、圆角 --r-card，最宽 560；手机上占满。
    expect(css).toMatch(/\.card \{[^}]*var\(--surface\)[^}]*var\(--hairline-strong\)[^}]*var\(--r-card\)[^}]*max-width: 560px/);
  });

  it("很长的气泡整段显示，没有展开", () => {
    const long = "这一段很长。".repeat(60);
    const bubble = named(call("bubbles", () => ReplyBubbles({ markdown: long, streaming: false })), "TextBubble")[0]!;
    const tree = expand("bubble", bubble);
    expect(elements(tree).find((element) => element.type === MarkdownBody)?.props.text).toBe(long);
    expect(button(tree, "展开")).toBeUndefined();
    expect(elements(tree).some((element) => "data-clamp" in element.props || "data-over" in element.props)).toBe(false);
    expect(bubble.props).not.toHaveProperty("collapsible");
    // 收起的样式和「展开」都不留。
    expect(css).not.toMatch(/data-clamp|\.more\b/);
  });

  it("短的小节写完后直接显示全文，没有打开", () => {
    vi.useFakeTimers();
    const bubbles = (markdown: string, streaming: boolean) => call("bubbles", () => ReplyBubbles({ markdown, streaming }));
    bubbles("## 用法\n\n- 装好", true);
    vi.advanceTimersByTime(HOLD_MS);
    // 还在写：照旧是壳子加「•••」，不先铺全文。
    const shell = expand("card", named(bubbles("## 用法\n\n- 装好以后", true), "ReplyCard")[0]!);
    expect(elements(shell).some((element) => element.props["data-testid"] === "card-typing")).toBe(true);
    expect(elements(shell).find((element) => element.type === MarkdownBody)).toBeUndefined();
    expect(button(shell, "打开")).toBeUndefined();
    // 写完：量下来放得下，原地是全文（标题不重复），没有摘要、没有「打开」。
    const card = named(bubbles("## 用法\n\n- 装好以后运行 `pstack`。", false), "ReplyCard")[0]!;
    measureCard("card", card, FITS);
    const done = expand("card", card);
    expect(fullOf(done)?.props["data-fold"]).toBeUndefined();
    expect(elements(fullOf(done)!.props.children as ReactNode).find((element) => element.type === MarkdownBody)?.props.text).toBe("- 装好以后运行 `pstack`。");
    expect(named(done, "FadeText")).toHaveLength(0);
    expect(button(done, "打开")).toBeUndefined();
    // 标题行、时间照旧在。
    expect(text(done)).toContain("用法");
  });

  it("超过 12 行或横向放不下的小节，显示摘要和打开", () => {
    // 放得下的上限是 12 行：写成常量，正文按它限高来量。
    expect(CARD_FULL_LINES).toBe(12);
    const markdown = "## 注意事项\n\n第一条要说清楚。\n\n第二条也很长。";
    const card = () => named(call("bubbles", () => ReplyBubbles({ markdown, streaming: false })), "ReplyCard")[0]!;
    // 竖着超过 12 行。
    let observed: (() => void) | null = null;
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { observed = callback; } observe() {} disconnect() {} });
    const tall = card();
    measureCard("tall", tall, TALL);
    let tree = expand("tall", tall);
    expect(fullOf(tree)!.props["data-fold"]).toBe("");
    expect(named(tree, "FadeText")[0]?.props.children).toBe("第一条要说清楚。");
    expect(button(tree, "打开")).toBeDefined();
    // 窗口变宽、放得下了：重新量，换成全文。
    Object.assign((fullOf(tree)!.props.ref as { current: CardBox }).current, FITS);
    observed!();
    tree = expand("tall", tall);
    expect(fullOf(tree)!.props["data-fold"]).toBeUndefined();
    expect(fullOf(tree)!.props.style).toEqual({ maxHeight: `${CARD_FULL_LINES}lh` });
    expect(button(tree, "打开")).toBeUndefined();
    // 不高，但里面的宽表格、长代码行横向放不下。
    const wide = card();
    measureCard("wide", wide, { ...FITS, wide: [{ scrollWidth: 900, clientWidth: 500 }] });
    tree = expand("wide", wide);
    expect(fullOf(tree)!.props["data-fold"]).toBe("");
    expect(button(tree, "打开")).toBeDefined();
    // 收起时正文不占位置、看不见（只留着量），摘要、「打开」照旧。
    expect(css).toMatch(/\.cardFull\[data-fold\] \{[^}]*position: absolute[^}]*visibility: hidden/);
    // 收起时左右和卡片内边距读同一个变量。
    expect(css).toMatch(/\.card \{[^}]*--card-pad-x: 16px;[^}]*padding: 14px var\(--card-pad-x\)/);
    expect(css).toMatch(/\.cardFull\[data-fold\] \{[^}]*left: var\(--card-pad-x\); right: var\(--card-pad-x\)/);
  });

  it("卡片卡在阈值附近时，宽度小幅变化不来回切", () => {
    // 对话区的竖滚动条一出一收，宽度差十几像素，正好卡在 12 行附近的卡片会被反复重新量。
    // 收起以后要回到全文，得比阈值少一行（11 行）才行：收起时全文那一格限高 11 行来量。
    const LH = 26;
    let observed: (() => void) | null = null;
    vi.stubGlobal("ResizeObserver", class { constructor(callback: () => void) { observed = callback; } observe() {} disconnect() {} });
    const card = named(call("bubbles", () => ReplyBubbles({ markdown: "## 注意事项\n\n第一条。\n\n第二条。", streaming: false })), "ReplyCard")[0]!;
    let lines = 12.4;
    let tree: ReactNode = call("near", () => (card.type as (props: unknown) => ReactNode)(card.props), false);
    // 全文那一格照它当前的 maxHeight（几行）限高：scrollHeight 是内容高，clientHeight 是限高后的高。
    const cap = () => parseFloat(String((fullOf(tree)!.props.style as { maxHeight: string }).maxHeight));
    (fullOf(tree)!.props.ref as { current: unknown }).current = {
      scrollWidth: 500, clientWidth: 500, querySelectorAll: () => [],
      get scrollHeight() { return lines * LH; }, get clientHeight() { return Math.min(lines, cap()) * LH; },
    };
    hooks.flush();
    const state = () => { tree = expand("near", card); return fullOf(tree)!.props["data-fold"] === "" ? "fold" : "full"; };
    // 窄了一点、12.4 行：收起，收起后限高 11 行。
    expect(state()).toBe("fold");
    expect(fullOf(tree)!.props.style).toEqual({ maxHeight: `${CARD_FULL_LINES - 1}lh` });
    // 滚动条收回、宽了一点：11.6 行，放得进 12 行但没少到 11 行，仍是摘要；再窄回去也不动。
    lines = 11.6; observed!(); expect(state()).toBe("fold");
    lines = 12.4; observed!(); expect(state()).toBe("fold");
    lines = 11.6; observed!(); expect(state()).toBe("fold");
    // 真的宽了很多、只剩 10 行：换回全文，限高回到 12 行。
    lines = 10; observed!(); expect(state()).toBe("full");
    expect(fullOf(tree)!.props.style).toEqual({ maxHeight: `${CARD_FULL_LINES}lh` });
    // 全文时 11.6 行照旧全文：不超过 12 行不收。
    lines = 11.6; observed!(); expect(state()).toBe("full");
  });

  it("读历史时短卡直接是全文，不先出摘要再换", () => {
    // 第一次画（还没量）就是全文：短卡量完不变，不会先出摘要再换成全文。
    const html = inBubbles(<ConversationTurn message={assistant("先说一句。\n\n## 用法\n\n- 装好以后运行 `pstack`。")} />);
    expect(html).toMatch(/data-card=""[\s\S]*装好以后运行/);
    expect(html).not.toContain(">打开</button>");
    const card = named(call("bubbles", () => ReplyBubbles({ markdown: "## 用法\n\n- 装好以后运行。", streaming: false })), "ReplyCard")[0]!;
    const first = call("card", () => (card.type as (props: unknown) => ReactNode)(card.props), false);
    expect(fullOf(first)?.props["data-fold"]).toBeUndefined();
    expect(button(first, "打开")).toBeUndefined();
    expect(named(first, "FadeText")).toHaveLength(0);
  });

  it("卡片全文不重复标题：单独一行加粗的标题也去掉", () => {
    const markdown = "**用法：**\n\n```bash\npstack run\n```";
    const card = named(call("bubbles", () => ReplyBubbles({ markdown, streaming: false })), "ReplyCard")[0]!;
    expect(card.props.title).toBe("用法");
    const tree = expand("card", card);
    expect(elements(fullOf(tree)!.props.children as ReactNode).find((element) => element.type === MarkdownBody)?.props.text).toBe("```bash\npstack run\n```");
    // 加粗的不是标题那一句，照旧留着。
    const other = named(call("other", () => ReplyBubbles({ markdown: "## 用法\n\n**先装好**\n\n```bash\npstack run\n```", streaming: false })), "ReplyCard")[0]!;
    expect(elements(fullOf(expand("otherCard", other))!.props.children as ReactNode).find((element) => element.type === MarkdownBody)?.props.text).toBe("**先装好**\n\n```bash\npstack run\n```");
  });

  it("清单卡：冒号引子当标题、全文里不再写一遍；没有标题就不画标题那一行", () => {
    const list = `- **甲**：${"说明".repeat(40)}\n- **乙**：${"说明".repeat(40)}`;
    const bodyText = (tree: ReactNode) => elements(fullOf(tree)!.props.children as ReactNode).find((element) => element.type === MarkdownBody)?.props.text;
    for (const markdown of [`下午有两件事：\n\n${list}`, `下午有两件事：\n${list}`]) {
      hooks.reset();
      const card = named(call("bubbles", () => ReplyBubbles({ markdown, streaming: false })), "ReplyCard")[0]!;
      expect(card.props.title).toBe("下午有两件事");
      measureCard("card", card, FITS);
      expect(bodyText(expand("card", card))).toBe(list);
    }
    // 没有引子：标题空，不画标题那一行、不留占位；正文照常。
    hooks.reset();
    const bare = named(call("bubbles", () => ReplyBubbles({ markdown: list, streaming: false })), "ReplyCard")[0]!;
    expect(bare.props.title).toBe("");
    measureCard("card", bare, FITS);
    const tree = expand("card", bare);
    expect(elements(tree).filter((element) => element.type === "span")).toEqual([]);
    expect(bodyText(tree)).toBe(list);
    // 第一块不留上边距：没有标题那一行时，正文、摘要贴着卡片的内边距。
    expect(css).toMatch(/\.card > :first-child \{ margin-top: 0; \}/);
  });

  it("写完的块马上出，没写完的 2 秒内露「•••」，过了 2 秒在气泡里边写边长", () => {
    vi.useFakeTimers();
    // 一轮刚开始、还没有内容：对话底部马上「•••」。
    expect(renderToStaticMarkup(<WorkTimeline data={data()} blocks={[]} />)).toContain('data-testid="typing"');
    const bubbles = (markdown: string, streaming = true) => call("bubbles", () => ReplyBubbles({ markdown, streaming }));

    // 这一轮的第一帧：只有没写完的一段，先露「•••」。
    expect(typing(bubbles("第一"))).toBe(true);
    // 两段一起写完到的：马上都出，入场错开 60ms；第三段还在写，先露「•••」。
    let tree = bubbles("第一段。\n\n第二段。\n\n第三段在写");
    expect(pieces(tree)).toEqual([{ kind: "bubble", markdown: "第一段。", open: false }, { kind: "bubble", markdown: "第二段。", open: false }]);
    expect(named(tree, "TextBubble").map((element) => element.props.delay)).toEqual([0, 60]);
    expect(typing(tree)).toBe(true);
    vi.advanceTimersByTime(HOLD_MS - 1);
    tree = bubbles("第一段。\n\n第二段。\n\n第三段在写，又写了几个字");
    expect(pieces(tree)).toHaveLength(2);
    expect(typing(tree)).toBe(true);
    // 写了 2 秒还没写完：以气泡出现，在里面边写边长；「•••」收起。
    vi.advanceTimersByTime(1);
    tree = bubbles("第一段。\n\n第二段。\n\n第三段在写，又写了几个字");
    expect(pieces(tree)).toEqual([
      { kind: "bubble", markdown: "第一段。", open: false }, { kind: "bubble", markdown: "第二段。", open: false },
      { kind: "bubble", markdown: "第三段在写，又写了几个字", open: true },
    ]);
    expect(named(tree, "TextBubble")[2]!.props.delay).toBe(0);
    expect(typing(tree)).toBe(false);
    tree = bubbles("第一段。\n\n第二段。\n\n第三段在写，又写了几个字，还在长");
    expect(pieces(tree)[2]).toEqual({ kind: "bubble", markdown: "第三段在写，又写了几个字，还在长", open: true });
    // 边写边长过的气泡写完了照旧出着；之前已经出的不重播入场。
    tree = bubbles("第一段。\n\n第二段。\n\n第三段在写，又写了几个字，还在长。\n\n第四");
    expect(pieces(tree)[2]).toEqual({ kind: "bubble", markdown: "第三段在写，又写了几个字，还在长。", open: false });
    expect(named(tree, "TextBubble").map((element) => element.props.delay)).toEqual([0, 60, 0]);
    // 新起的第四段从头算 2 秒。
    expect(pieces(tree)).toHaveLength(3);
    expect(typing(tree)).toBe(true);
    // 一轮结束：没写完的那段马上出，「•••」消失。
    tree = bubbles("第一段。\n\n第二段。\n\n第三段在写，又写了几个字，还在长。\n\n第四段。", false);
    expect(pieces(tree)).toHaveLength(4);
    expect(typing(tree)).toBe(false);
    // 前一段边写边长时已经露出来的字，分成下一段以后接着出，不收回去等 2 秒。
    hooks.reset();
    bubbles("看三件事：");
    vi.advanceTimersByTime(HOLD_MS);
    expect(pieces(bubbles("看三件事：\n\n1"))).toEqual([{ kind: "bubble", markdown: "看三件事：\n\n1", open: true }]);
    tree = bubbles("看三件事：\n\n1个人在做");
    expect(pieces(tree)).toEqual([{ kind: "bubble", markdown: "看三件事：", open: false }, { kind: "bubble", markdown: "1个人在做", open: true }]);
    expect(typing(tree)).toBe(false);
    // 入场淡入错开、减少动态效果时不动。
    expect(css).toMatch(/\[data-enter\] \{[^}]*animation:[^}]*var\(--enter-delay/);
    expect(css).toMatch(/prefers-reduced-motion: reduce/);
    expect(css).toMatch(/\[data-reduce-motion='true'\]/);
  });

  it("历史一次出齐", () => {
    const reply = "第一段。\n\n第二段。\n\n## 本月\n\n灯塔、回款。";
    const html = inBubbles(<ConversationTurn message={assistant(reply)} ms={9_000} steps={[{ id: "1", label: "读本月目标", status: "done" }]} />);
    expect(html.match(/data-bubble="buddy"/g)).toHaveLength(2);
    expect(html.match(/data-card=""/g)).toHaveLength(1);
    expect(html).not.toContain("data-enter");
    expect(html).not.toContain('data-testid="typing"');
    // 每轮的「用时 / 步骤」那一排挪到这一组气泡下面。
    expect(html.indexOf("用时 9 秒")).toBeGreaterThan(html.indexOf("data-card"));
    expect(html).toContain("1 步");
    // 一轮还在进行：步骤只在页头胶囊下面，对话里没有那一排（也不预留）。
    const live = inBubbles(<ConversationTurn message={assistant("第一段。\n\n第二")} streaming steps={[{ id: "1", label: "读本月目标", status: "active" }]} />);
    expect(live).not.toContain("用时");
    expect(live).not.toContain("步");
    expect(live).not.toContain("data-meta-placeholder");
    // 那一排电脑上鼠标移上去才出，手机上一直淡色出。
    expect(css).toMatch(/\.meta \{[^}]*opacity: 0/);
    expect(css).toMatch(/\.turn:hover \.meta/);
    expect(css).toMatch(/@media \(max-width: 959px\), \(hover: none\) \{[^@]*\.meta \{ opacity: 1/);
  });

  it("TransferHistory 里照旧不用气泡", () => {
    const history = { messages: [{ sequence: 1, role: "user", content: "接着做" }, { sequence: 2, role: "assistant", content: "好。\n\n先看日程。" }] };
    const props = { history, from: { personId: "chen", name: "陈晨星" } } as unknown as Parameters<typeof TransferHistory>[0];
    const toggle = elements(call("transfer", () => TransferHistory(props))).find((element) => element.type === "button")!;
    (toggle.props.onClick as () => void)();
    const html = inBubbles(call("transfer", () => TransferHistory(props)));
    expect(html).toContain("先看日程");
    expect(html).not.toContain("data-bubble");
    expect(html).not.toContain("data-card");
  });

  it("第一个内容出来时页头从 thinking 变 typing", () => {
    vi.useFakeTimers();
    const live = data({ partial: "还在写第一段", stage: "answering" });
    const state = () => elements(call("presence", () => Presence({ buddy: miles, data: live, go: vi.fn() })))
      .find((element) => "state" in element.props && "buddy" in element.props)?.props.state;
    expect(state()).toBe("thinking");
    // 对话这边（WorkTimeline 给的）在第一个气泡出来时报给页头。
    const timeline = call("timeline", () => WorkTimeline({ data: live, blocks: [] }));
    expect(elements(timeline).find((element) => element.type === BubbleContext || element.type === BubbleContext.Provider)?.props.value).toBe(true);
    const reveal = elements(timeline).find((element) => element.type === RevealContext || element.type === RevealContext.Provider)!.props.value;
    hooks.provide(RevealContext, reveal);
    // 字到了但还在 2 秒里没出：页头还是在想。
    call("bubbles", () => ReplyBubbles({ markdown: live.partial, streaming: true }));
    expect(state()).toBe("thinking");
    vi.advanceTimersByTime(HOLD_MS);
    call("bubbles", () => ReplyBubbles({ markdown: `${live.partial}，又写了几个字`, streaming: true }));
    expect(state()).toBe("typing");
  });
});

describe("出字的边角", () => {
  const bubbles = (markdown: string, streaming = true) => call("bubbles", () => ReplyBubbles({ markdown, streaming }));
  const delays = (tree: ReactNode) => elements(tree).filter((element) => typeof element.type === "function" && ["TextBubble", "ReplyCard"].includes(element.type.name))
    .map((element) => element.props.delay);

  it("重挂不重藏：挂上时已经在的内容算露过，不再等、不再淡入；后来一起到的几块错开最多 3 步", () => {
    vi.useFakeTimers();
    // 刷新后接上这一轮（或流式那条换了 key 重挂）：挂上时已有写完的段和在写的一段。
    let tree = bubbles("一。\n\n二。\n\n三在写");
    expect(pieces(tree)).toEqual([
      { kind: "bubble", markdown: "一。", open: false }, { kind: "bubble", markdown: "二。", open: false }, { kind: "bubble", markdown: "三在写", open: true },
    ]);
    expect(delays(tree)).toEqual([null, null, null]);
    expect(typing(tree)).toBe(false);
    // 之后新到的照常淡入。
    tree = bubbles("一。\n\n二。\n\n三写完了。\n\n四。\n\n五");
    expect(delays(tree)).toEqual([null, null, null, 0]);

    // 同一页里重挂：这一轮第一段已经在气泡里边写边长，重挂后接着露，不收回去等 2 秒。
    hooks.reset();
    bubbles("第一段在写");
    vi.advanceTimersByTime(HOLD_MS);
    expect(pieces(bubbles("第一段在写，长了"))).toEqual([{ kind: "bubble", markdown: "第一段在写，长了", open: true }]);
    hooks.reset();
    tree = bubbles("第一段在写，长了，又长");
    expect(pieces(tree)).toEqual([{ kind: "bubble", markdown: "第一段在写，长了，又长", open: true }]);
    expect(delays(tree)).toEqual([null]);
    expect(typing(tree)).toBe(false);

    // 新的一轮第一帧就是整段交来的一段：照常淡入。
    hooks.reset();
    expect(delays(bubbles("整段交来的一段。\n\n"))).toEqual([0]);
    // 新的一轮从第一帧挂上：一下到了六段，入场错开 0、60、120、180，之后不再往后推。
    hooks.reset();
    expect(typing(bubbles("开"))).toBe(true);
    tree = bubbles("开头。\n\n1。\n\n2。\n\n3。\n\n4。\n\n5。\n\n6");
    expect(delays(tree)).toEqual([0, 60, 120, 180, 180, 180]);
  });

  it("流式卡片壳子用正在输入的点，不出省略号", () => {
    vi.useFakeTimers();
    const bubbles = (markdown: string) => call("bubbles", () => ReplyBubbles({ markdown, streaming: true }));
    bubbles("## 计划\n\n- 先做");
    vi.advanceTimersByTime(HOLD_MS);
    const tree = bubbles("## 计划\n\n- 先做，再");
    expect(pieces(tree)).toEqual([{ kind: "card", markdown: "## 计划\n\n- 先做，再", open: true }]);
    const html = renderToStaticMarkup(<>{expand("card", named(tree, "ReplyCard")[0]!)}</>);
    expect(html).toContain("计划");
    expect(html).not.toContain("…");
    expect(html).toMatch(/data-testid="card-typing"[^>]*><i><\/i><i><\/i><i><\/i><\/div>/);
  });

  it("没写完的那段等满 2 秒一定会出：计时器到了、没有新字也出", () => {
    // 只换计时器、不换 Date：计时器比 Date.now() 先到一点（浏览器里常有）。
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    expect(typing(bubbles("在写第一段"))).toBe(true);
    vi.advanceTimersByTime(HOLD_MS);
    // 计时器叫醒重画一次，字没变。
    const tree = bubbles("在写第一段");
    expect(pieces(tree)).toEqual([{ kind: "bubble", markdown: "在写第一段", open: true }]);
    expect(typing(tree)).toBe(false);
  });

  it("右边开着的那张卡卸载了（换会话、重读历史），右边那一格关上", () => {
    const shown: { value: SideDetail["shown"] } = { value: null };
    const side = { get shown() { return shown.value; }, node: {} as HTMLElement, open: false, wide: false, toggle: vi.fn(), setWide: vi.fn(),
      show: vi.fn((kind: SideDetail["shown"]) => { shown.value = kind; }) } as unknown as SideDetail;
    hooks.provide(SideDetailContext, side);
    const card = named(bubbles("## 本周\n\n- 周二发清单\n- 周三确认", false), "ReplyCard")[0]!;
    measureCard("card", card, TALL);
    (button(expand("card", card), "打开")!.props.onClick as () => void)();
    expect(named(expand("card", card), "SideContent")).toHaveLength(1);
    // 没开着的卡卸载不碰右边。
    const other = named(call("other", () => ReplyBubbles({ markdown: "## 下周\n\n- 周一\n- 周二", streaming: false })), "ReplyCard")[0]!;
    expand("otherCard", other);
    hooks.unmount("otherCard");
    expect(side.show).toHaveBeenLastCalledWith("file");
    hooks.unmount("card");
    expect(side.show).toHaveBeenLastCalledWith(null);
    // 再挂上同一张（同一个 id）也不当它还开着。
    shown.value = "file";
    expect(named(expand("card", card), "SideContent")).toHaveLength(0);
  });

  it("只有选项块、正文还空着：露「•••」", () => {
    const html = renderToStaticMarkup(<WorkTimeline data={data({ partial: "```options\n[{\"label\":\"先做灯塔\"}]\n```", stage: "answering" })} blocks={[]} />);
    expect(html).toContain('data-testid="typing"');
  });
});

describe("用时（本人 11/18）", () => {
  // 伙伴主线的历史来自 Chat：本人那句和回答的时间都是这一轮的开始时间，一模一样。
  const at = "2026-11-18T03:00:00.000Z";
  const turn = (runId = "r1", replyAt = at) => [{ sequence: 1, role: "user", content: "ANT 适合打新吗", createdAt: at, runId },
    { sequence: 2, role: "assistant", content: "先说结论。", createdAt: replyAt, runId }] as Message[];
  const done = { streaming: false, status: "complete", thinking: false, stage: "answering", steps: [{ id: "1", label: "查新股资料", status: "done" }] } as Partial<ConversationData>;
  const timeline = (extra: Partial<ConversationData>) => renderToStaticMarkup(<WorkTimeline data={data({ ...done, ...extra })} blocks={[]} />);

  it("提问和回答时间一样时不写用时", () => {
    const html = timeline({ messages: turn() });
    expect(html).not.toContain("用时");
    // 「看过程」入口还在，这一行只剩入口。
    expect(html).toContain("1 步");
    expect(html).not.toMatch(/<span>用时/);
    // 真正很快的一轮至少也有几十毫秒差：照常写「1 秒」。
    expect(timeline({ messages: turn("r1", "2026-11-18T03:00:00.040Z") })).toContain("用时 1 秒");
    // 旧界面也不写错的数。
    expect(renderToStaticMarkup(<ConversationTurns messages={turn()} />)).not.toContain("用时");
  });

  it("刚答完的那一轮用网页量到的用时", () => {
    expect(timeline({ messages: turn(), lastReply: { text: "先说结论。", ms: 29_000, runId: "r1" } })).toContain("用时 29 秒");
    // 不是这一轮（换了对话、读回的是别的轮）：不借这个数。
    expect(timeline({ messages: turn("r2"), lastReply: { text: "先说结论。", ms: 29_000, runId: "r1" } })).not.toContain("用时");
  });
});

describe("快捷回复（设计 6.4）", () => {
  it("重读历史后（新的消息对象、内容一样）胶囊还在最后一个气泡下面，点了照样直接发出", () => {
    const reply = "两条路都行。\n\n```options\n[{\"label\":\"先做灯塔\"},{\"label\":\"先补发票\"}]\n```";
    const history = () => [{ sequence: 1, role: "user", content: "先做哪个？", runId: "r1" }, { sequence: 2, role: "assistant", content: reply, runId: "r1" }] as Message[];
    const send = vi.fn(async () => true);
    const quickOf = (messages: Message[]) => elements(call("timeline", () => WorkTimeline({ data: data({ streaming: false, status: "complete", thinking: false, messages, send }), blocks: [] })))
      .find((element) => element.type === QuickReplyContext || element.type === QuickReplyContext.Provider)!.props.value;
    const shown = history();
    quickOf(shown);
    // 切回来、对话重读（quiet）：读回的是新对象，内容不变。ConversationTurn 的 memo 认内容没变不重画，
    // 这条回答拿着旧的 message 跟着新的上下文重画。
    const quick = quickOf(history());
    hooks.provide(BubbleContext, true);
    hooks.provide(QuickReplyContext, quick);
    const body = (ConversationTurn as unknown as { type: (props: unknown) => Element }).type({ message: shown[1] });
    const tree = expand("turn", body);
    const row = named(tree, "AnswerOptions")[0];
    expect(row?.props.options).toEqual(["先做灯塔", "先补发票"]);
    // 在这一组气泡下面。
    const children = elements(tree);
    expect(children.indexOf(row!)).toBeGreaterThan(children.findIndex((element) => element.type === ReplyBubbles));
    // 点一个：选项原文作为本人的话发出去。
    const pills = AnswerOptions(row!.props as Parameters<typeof AnswerOptions>[0]) as ReactElement<{ children: ReactElement<{ onClick: () => void }>[] }>;
    pills.props.children[1]!.props.onClick();
    expect(send).toHaveBeenCalledWith("先补发票", []);
  });
});

describe("浅色下对话看得清（本人 11/18）", () => {
  it("新首页里对话的加粗、链接、代码块用颜色变量", () => {
    // 旧规则写死了深色主题的颜色（#f7f7f9、#a9caff、#18181b、#ffffff20），浅色修正只挂在 [data-tone=light] 上；
    // 右边那一格（SideDetail 的 portal）、子会话里没有这个祖先。新首页的前缀挂在根上，portal 出去的也吃得到。
    const transcript = readFileSync(new URL("../styles/conversation-transcript.module.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");
    const NEW_HOME = ':global(:root:has([data-type-scale="one"]))';
    const declared = (selector: string, property: string) => [...transcript.matchAll(/([^{}]+)\{([^{}]*)\}/g)]
      .filter((match) => match[1].split(",").some((part) => part.trim().replace(/\s+/g, " ") === `${NEW_HOME} ${selector}`))
      .map((match) => new RegExp(`(?:^|[;\\s])${property}\\s*:\\s*([^;]+)`).exec(match[2])?.[1].trim())
      .find(Boolean);
    expect(declared(".prose strong", "color")).toBe("var(--ink)");
    expect(declared(".prose a", "color")).toBe("var(--link)");
    expect(declared(".prose pre", "background")).toBe("var(--neutral-wash)");
    expect(declared(".prose pre", "color")).toBe("var(--ink)");
    expect(declared(".prose code", "color")).toBe("var(--ink)");
    expect(declared(".prose td", "border-bottom-color")).toBe("var(--hairline)");
    expect(declared(".prose th", "border-bottom-color")).toBe("var(--hairline)");
  });
});

describe("伙伴话里的会话名（本人 11/18）", () => {
  const NAMES: ThreadName[] = [{ key: "topic:00000000-0000-4000-8000-0000000000a1", title: "首页深色方案" }];
  const REPLY = "我开了首页深色方案去做，做完告诉你。";
  const bodyOf = (tree: ReactNode) => elements(tree).find((element) => element.type === MarkdownBody)!;

  it("出字过程中不加下划线；这一轮结束时已经出过的字不重新淡入", () => {
    vi.useFakeTimers();
    hooks.provide(ThreadNamesContext, NAMES);
    const bubbles = (markdown: string, streaming: boolean) => call("bubbles", () => ReplyBubbles({ markdown, streaming }));
    const html = (body: Element) => renderToStaticMarkup(<MarkdownBody text={REPLY} streaming={false} parts={body.props.parts as MarkdownParts} />);
    bubbles("我开了首页", true);
    vi.advanceTimersByTime(HOLD_MS);
    // 还在写的气泡：用的还是对话本来那套部件，画出来没有会话名。
    const open = named(bubbles(REPLY, true), "TextBubble")[0]!;
    expect(open.props.open).toBe(true);
    const during = bodyOf(expand("bubble", open));
    expect(during.props.streaming).toBe(true);
    expect(during.props.parts).toBe(TURN_PARTS);
    // 写完：到达淡入的那几段合并（ARRIVAL_SETTLE_MS）之前不换部件，已经出过的字不重挂、不重新淡入。
    expect(ARRIVAL_SETTLE_MS).toBe(400);
    const closed = named(bubbles(REPLY, false), "TextBubble")[0]!;
    expect(closed.props.open).toBe(false);
    expect(bodyOf(expand("bubble", closed)).props.parts).toBe(TURN_PARTS);
    vi.advanceTimersByTime(ARRIVAL_SETTLE_MS - 1);
    expect(html(bodyOf(expand("bubble", closed)))).not.toContain("data-thread");
    // 稳下来以后：带会话名的部件，同一份名字是同一个引用（不重新解析）。
    vi.advanceTimersByTime(1);
    const after = bodyOf(expand("bubble", closed));
    expect(after.props.parts).not.toBe(TURN_PARTS);
    expect(html(after)).toContain('data-thread="topic:00000000-0000-4000-8000-0000000000a1"');
    expect(bodyOf(expand("bubble", closed)).props.parts).toBe(after.props.parts);
    // 读历史来的气泡没有在这里写过：一挂上就有。
    hooks.reset();
    hooks.provide(ThreadNamesContext, NAMES);
    const history = named(call("history", () => ReplyBubbles({ markdown: REPLY, streaming: false })), "TextBubble")[0]!;
    expect(html(bodyOf(expand("history-bubble", history)))).toContain("data-thread");
  });

  it("项目对话、别的对话页不加", () => {
    // 没有 ThreadNamesContext（项目对话、对象页对话、转交历史）：气泡、卡片全文用的还是 TURN_PARTS 本身。
    const tree = call("bubbles", () => ReplyBubbles({ markdown: `${REPLY}\n\n## 首页深色方案\n\n首页深色方案的说明。`, streaming: false }));
    expect(bodyOf(expand("bubble", named(tree, "TextBubble")[0]!)).props.parts).toBe(TURN_PARTS);
    const card = named(tree, "ReplyCard")[0]!;
    measureCard("card", card, FITS);
    expect(bodyOf(expand("card", card)).props.parts).toBe(TURN_PARTS);
    expect(inBubbles(<ConversationTurn message={assistant(REPLY)} />)).not.toContain("data-thread");
    // 伙伴主线给了名字：卡片全文里也加。
    hooks.provide(ThreadNamesContext, NAMES);
    const withNames = call("bubbles2", () => ReplyBubbles({ markdown: `${REPLY}\n\n## 首页深色方案\n\n首页深色方案的说明。`, streaming: false }));
    const card2 = named(withNames, "ReplyCard")[0]!;
    measureCard("card2", card2, FITS);
    const full = bodyOf(expand("card2", card2));
    expect(full.props.parts).not.toBe(TURN_PARTS);
    expect(renderToStaticMarkup(<MarkdownBody text={full.props.text as string} streaming={false} parts={full.props.parts as MarkdownParts} />)).toContain('data-thread="topic:00000000-0000-4000-8000-0000000000a1"');
  });
});
