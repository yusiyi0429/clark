"use client";

/**
 * 伙伴的回复成气泡和卡片（设计 6.1–6.3）：只在新首页的伙伴主线、项目对话里（WorkTimeline 给 BubbleContext = true）；
 * CEO 管理模式、对象页对话、子会话正文、转交、历史抽屉照旧。
 * 一条回复按 splitReply 拆成块：普通的话是气泡，标题开头的一节、表格、代码、长清单是卡片。气泡整段显示；
 * 卡片写完后放得下（不超过 12 行、没有横向溢出）就原地是全文，放不下才是摘要加「打开」（在右边看全文，手机上就地展开；本人 11/18）。
 * 怎么出现（本人 11/17 定：短段整段出，等久了先出）：
 * - 写完的块马上出，只错开 60ms 的入场；不藏已经到了的内容。
 * - 还没写完的那一段（tail）从它开始写起 2 秒内不出，期间露「•••」；过了 2 秒还没写完，就以气泡（卡片是壳子：标题 +「…」）出现，在里面边写边长。
 * - 读历史来的一次出齐，没有入场；减少动态效果时没有入场动画。
 * - 这一轮第一个块出来时报给页头（RevealContext → revealTurn），形象从在想变正在输入。
 */
import { createContext, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, useSyncExternalStore, type CSSProperties, type HTMLAttributes, type ReactNode } from "react";
import { X } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import { SideContent, useSideDetail } from "@/components/home/SideDetail";
import { ICON } from "@/components/home/StateIcon";
import { calendarDate, clock, monthDayTime } from "@/lib/companyTime";
import { splitReply } from "./replySegments";
import { ARRIVAL_SETTLE_MS, MarkdownBody, TURN_PARTS, type MarkdownParts } from "./Transcript";
import { ThreadNamesContext, rehypeThreadNames, type ThreadName } from "./threadNames";
import b from "@/styles/conversation-bubbles.module.css";
import ts from "@/styles/conversation-transcript.module.css";
import vs from "@/styles/v2-session.module.css";
import { FadeText } from "@/lib/home/overflowFade";

/** 这里的对话用气泡：WorkTimeline 给 true；TransferHistory 里包 false。 */
export const BubbleContext = createContext(false);
/** 这一轮第一个块出来时调一下（WorkTimeline 给，记到 revealTurn）。 */
export const RevealContext = createContext<(() => void) | null>(null);

/** 没写完的那一段等多久先出。 */
export const HOLD_MS = 2000;
/** 卡片正文在卡里直接显示全文的上限：画出来不超过这么多行（再多，或横向放不下，就收成摘要加「打开」）。 */
export const CARD_FULL_LINES = 12;
/** 一起到的几块入场错开多少；最多错开几步（再多的和第 3 步一起出）。 */
const STAGGER_MS = 60;
const STAGGER_STEPS = 3;

/** 一个小订阅：值变了叫一声，订了的组件重画。 */
function signal<T>(initial: T) {
  let value = initial;
  const listeners = new Set<() => void>();
  const get = () => value;
  const subscribe = (listener: () => void) => {
    listeners.add(listener);
    return () => { listeners.delete(listener); };
  };
  return {
    get,
    set(next: T) {
      if (Object.is(next, value)) return;
      value = next;
      listeners.forEach((listener) => listener());
    },
    useValue: (): T => useSyncExternalStore(subscribe, get, get),
  };
}

/** 最近一轮出了内容的是哪一轮（`scope@startedAt`）。 */
const revealed = signal<string | null>(null);
export function revealTurn(scope: string, startedAt: number) {
  revealed.set(`${scope}@${startedAt}`);
}
/** 页头：这一轮的第一个块出没出。 */
export function useTurnRevealed(scope: string, startedAt: number): boolean {
  return revealed.useValue() === `${scope}@${startedAt}`;
}

/** 右边那一格里现在是哪张卡（同一时间只放一张）。 */
const openCard = signal<string | null>(null);

/** 正在写的那条回复上一次画到的字、没写完的那段出没出：同一页里它重挂（key 换了）时接着露，不重藏。 */
let streamed: { markdown: string; shown: boolean } | null = null;

/** 测试之间清掉模块里记着的东西（这一轮出没出、右边开着哪张卡、正在写的那条画到哪）。 */
export function resetReplyBubbles() {
  revealed.set(null);
  openCard.set(null);
  streamed = null;
}

/** 伙伴气泡的样子：靠左、--default 底、圆角 18。 */
export function BuddyBubble({ children, ...rest }: { children: ReactNode } & HTMLAttributes<HTMLDivElement>) {
  return <div className={b.buddy} data-bubble="buddy" {...rest}>{children}</div>;
}

/** 本人气泡的样子：靠右、--accent-soft 底、圆角 18。 */
export function UserBubble({ children }: { children: ReactNode }) {
  return <div className={b.mine} data-bubble="mine">{children}</div>;
}

/** 「•••」：内容还没到时。 */
export function TypingBubble() {
  return <div className={`${b.buddy} ${b.typing}`} data-testid="typing" aria-hidden><i /><i /><i /></div>;
}

/** 入场：第一次出现时淡入，几块一起到的错开；读历史来的（delay 为 null）不动。 */
const enter = (delay: number | null) => (delay === null ? {} : { "data-enter": "", style: { "--enter-delay": `${delay}ms` } as CSSProperties });

type Piece = { kind: "bubble" | "card"; markdown: string; title: string; summary: string; open: boolean };

/**
 * edge(part, parts)：挂在每一块底边上的东西（本人在这一块点的表情，设计 6.5）；给了的每块标上第几块、按块悬停。
 * actions(part, parts, text)：每块旁边那一排（回应、回复、复制，本人 11/18），text 是这一块的原文 markdown；它自己定位到块外。
 */
export function ReplyBubbles({ markdown, streaming, at, edge, actions }: {
  markdown: string; streaming: boolean; at?: string; edge?: (part: number, parts: number) => ReactNode; actions?: (part: number, parts: number, text: string) => ReactNode;
}) {
  const { segments, tail } = useMemo(() => splitReply(markdown, streaming), [markdown, streaming]);
  // 在这里流式过的：入场有动画；一挂上就是写完的（读历史来的）一次出齐。
  const live = useRef(streaming);
  const mounted = useRef(false);
  const [, wake] = useState(0);
  /** 没写完的那一段从什么时候开始写、出没出；seen：它以气泡出着时已经到了多少字。 */
  const hold = useRef<{ index: number; since: number; shown: boolean; seen: number } | null>(null);
  /** 每块第一次出现时定下的入场延迟（null 不动）。 */
  const delays = useRef<(number | null)[]>([]);
  const reveal = useContext(RevealContext);

  // 写到一半挂上的（刷新后接上、换了 key 重挂）：挂上时已经在的内容算露过，不再等、不再淡入。
  // 这一轮从第一帧挂上时只有一块（没写完的一段，或整段交来的一段），照常等、照常淡入；同一页里重挂时看上一次画到哪。
  if (!mounted.current) {
    mounted.current = true;
    const earlier = streaming && (segments.length + (tail ? 1 : 0) > 1 || (!!streamed?.shown && markdown.startsWith(streamed.markdown)));
    if (earlier) {
      delays.current = Array<null>(segments.length + (tail ? 1 : 0)).fill(null);
      if (tail) hold.current = { index: segments.length, since: Date.now(), shown: true, seen: 0 };
    }
  }

  let shown = false;
  if (tail) {
    const index = segments.length;
    const now = Date.now();
    let current = hold.current;
    if (!current || current.index !== index) {
      // 前一段出着时，这一段已经在它里面露过了：接着出，不收回去。
      const start = markdown.trimEnd().length - tail.markdown.length;
      current = hold.current = { index, since: now, shown: !!current?.shown && start < current.seen, seen: 0 };
    }
    if (!current.shown && now - current.since >= HOLD_MS) current.shown = true;
    // 卡片的壳子只露标题，里面的字不算露过。
    if (current.shown && tail.kind === "bubble") current.seen = markdown.length;
    shown = current.shown;
  } else hold.current = null;
  if (streaming) streamed = { markdown, shown };
  else if (streamed && markdown.startsWith(streamed.markdown)) streamed = null;
  // 等满 2 秒计时器直接把它标成出了（计时器比 Date.now() 先到一点时，不靠重画时再算）。
  const held = tail && !shown ? hold.current : null;
  useEffect(() => {
    if (!held) return;
    const timer = setTimeout(() => { held.shown = true; wake((n) => n + 1); }, Math.max(0, held.since + HOLD_MS - Date.now()));
    return () => clearTimeout(timer);
  }, [held]);

  const pieces: Piece[] = segments.map((segment) => (segment.kind === "card"
    ? { kind: "card", markdown: segment.markdown, title: segment.title, summary: segment.summary, open: false }
    : { kind: "bubble", markdown: segment.markdown, title: "", summary: "", open: false }));
  if (tail && shown) pieces.push({ kind: tail.kind, markdown: tail.markdown, title: tail.title, summary: "", open: true });
  const first = delays.current.length;
  for (let index = first; index < pieces.length; index += 1) delays.current[index] = live.current ? Math.min(index - first, STAGGER_STEPS) * STAGGER_MS : null;

  const visible = pieces.length > 0;
  useLayoutEffect(() => {
    if (streaming && visible) reveal?.();
  }, [streaming, visible, reveal]);

  return (
    <div className={b.group}>
      {pieces.map((piece, index) => {
        const onEdge = <>{edge ? <div className={b.edge}>{edge(index, pieces.length)}</div> : null}{actions?.(index, pieces.length, piece.markdown)}</>;
        const part = edge ? { "data-reaction-part": index, "data-reactable": "" } : undefined;
        return piece.kind === "card"
          ? <ReplyCard key={index} markdown={piece.markdown} title={piece.title} summary={piece.summary} open={piece.open} at={streaming ? undefined : at} delay={delays.current[index] ?? null} edge={onEdge} part={part} />
          : <TextBubble key={index} markdown={piece.markdown} open={piece.open} delay={delays.current[index] ?? null} edge={onEdge} part={part} />;
      })}
      {streaming && tail && !shown ? <TypingBubble /> : null}
    </div>
  );
}

/** 带会话名下划线的那套部件，按名字列表记住：同一份名字是同一个引用（MarkdownBody 不重新解析）；没有名字就是 TURN_PARTS 本身。 */
const withNames = new WeakMap<readonly ThreadName[], MarkdownParts>();
function threadParts(names: readonly ThreadName[]): MarkdownParts {
  if (!names.length) return TURN_PARTS;
  let parts = withNames.get(names);
  if (!parts) withNames.set(names, (parts = { ...TURN_PARTS, rehypePlugins: [rehypeThreadNames(names), ...TURN_PARTS.rehypePlugins] }));
  return parts;
}
/**
 * 气泡的正文部件：伙伴主线上（有 ThreadNamesContext）写完的气泡认会话名。在这里写过的，写完再等 ARRIVAL_SETTLE_MS，
 * 到达淡入的那几段合并成普通文字以后再换（换的时候不重挂已经出过的字、不重新淡入）；读历史来的一挂上就认。
 */
function useSettledThreadParts(open: boolean): MarkdownParts {
  const names = useContext(ThreadNamesContext);
  const [settled, setSettled] = useState(!open);
  useEffect(() => {
    if (open || settled) return;
    const timer = setTimeout(() => setSettled(true), ARRIVAL_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [open, settled]);
  return open || !settled ? TURN_PARTS : threadParts(names);
}

/** 本人能按块点表情时块上的标记（第几块、按块悬停）。 */
type PartMark = { "data-reaction-part": number; "data-reactable": string } | undefined;

/** 一个气泡：整段显示（本人 11/18 去掉了收起和「展开」）。open：还在写（还在写时不认会话名）。 */
function TextBubble({ markdown, open, delay, edge, part }: { markdown: string; open: boolean; delay: number | null; edge?: ReactNode; part: PartMark }) {
  const parts = useSettledThreadParts(open);
  return (
    <BuddyBubble {...part} {...enter(delay)}>
      <div className={ts.prose}>
        <MarkdownBody text={markdown} streaming={open} parts={parts} />
      </div>
      {edge}
    </BuddyBubble>
  );
}

/** 卡片上的时间：今天的只写几点，更早的带日期。 */
function cardTime(iso: string | undefined): string {
  if (!iso || !Number.isFinite(Date.parse(iso))) return "";
  return calendarDate(iso) === calendarDate(new Date().toISOString()) ? clock(new Date(iso)) : monthDayTime(iso);
}

/** 全文去掉开头那个和标题一样的标题行（# 标题，或单独一行的加粗小标题，行尾可带冒号）：标题已经在卡片、右边那一格的页头上，不再写一遍。 */
function withoutTitle(markdown: string, title: string): string {
  const [first = "", ...rest] = markdown.split("\n");
  const heading = /^ {0,3}#{1,6}[ \t]+/;
  const bold = /^\s*\*\*(?:(?!\*\*).)+\*\*[：:]?\s*$/;
  const same = heading.test(first) ? first.replace(heading, "").replace(/\*\*|`/g, "").trim() === title
    : bold.test(first) && first.replace(/\*\*|`/g, "").trim().replace(/[：:]$/, "") === title;
  return same ? rest.join("\n").trimStart() : markdown;
}

/** 卡片全文放不下：比 CARD_FULL_LINES 行高，或里面的表格、代码、公式横向溢出。 */
function overflows(element: HTMLElement): boolean {
  if (element.scrollHeight > element.clientHeight + 1) return true;
  return [element, ...Array.from(element.querySelectorAll<HTMLElement>("pre, table, .katex-display"))].some((box) => box.scrollWidth > box.clientWidth + 1);
}

/**
 * 一张卡：标题、时间（淡色）、正文。写完后全文放得下就原地显示全文；放不下才是摘要（淡色）加「打开」：
 * 电脑上「打开」在右边文件预览那一格看全文；手机上（没有那一格）就地展开。
 * 放不放得下在绘制前量（读历史不闪）；放不下时全文还留着、不占位置也看不见，窗口变了照样重新量。
 * 收起以后限高少一行再量：要少到 11 行才回全文，竖滚动条一出一收、宽度差十几像素时，卡在 12 行附近的卡片不来回切。
 * open：还在写，只出壳子（标题 + 正在输入的「•••」，同气泡），写完那一刻再定。
 */
function ReplyCard({ markdown, title, summary, open, at, delay, edge, part }: { markdown: string; title: string; summary: string; open: boolean; at?: string; delay: number | null; edge?: ReactNode; part: PartMark }) {
  const side = useSideDetail();
  const id = useId();
  // 卡片写完才挂全文（还在写时是壳子），全文没有到达淡入：直接认会话名。
  const parts = threadParts(useContext(ThreadNamesContext));
  const [inPlace, setInPlace] = useState(false);
  const full = useRef<HTMLDivElement>(null);
  const [fold, setFold] = useState(false);
  useLayoutEffect(() => {
    const element = full.current;
    if (open || !element) return;
    const measure = () => setFold(overflows(element));
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    return () => observer.disconnect();
  }, [open, markdown]);
  const sideRef = useRef(side);
  sideRef.current = side;
  // 右边开着的是这张、它卸载了（换会话、重读历史重挂）：右边那一格跟着关，不留个空面板。
  useEffect(() => () => {
    if (openCard.get() !== id) return;
    openCard.set(null);
    if (sideRef.current?.shown === "file") sideRef.current.show(null);
  }, [id]);
  const panel = openCard.useValue() === id && side?.shown === "file";
  const time = cardTime(at);
  const show = () => {
    if (!side) { setInPlace(true); return; }
    openCard.set(id);
    side.show("file");
  };
  const close = () => {
    openCard.set(null);
    side?.show(null);
  };
  return (
    <section className={b.card} data-card="" aria-label={title} {...part} {...enter(delay)}>
      <div className={b.cardHead}>
        <span className={b.cardTitle}>{title}</span>
        {time ? <span className={b.faint}>{time}</span> : null}
      </div>
      {open ? <div className={`${b.typing} ${b.cardTyping}`} data-testid="card-typing" aria-hidden><i /><i /><i /></div> : fold && summary && !inPlace ? <FadeText as="div" className={b.summary}>{summary}</FadeText> : null}
      {open || inPlace ? null : (
        <div ref={full} className={`${ts.prose} ${b.cardFull}`} data-fold={fold ? "" : undefined} style={{ maxHeight: `${fold ? CARD_FULL_LINES - 1 : CARD_FULL_LINES}lh` }}>
          <MarkdownBody text={withoutTitle(markdown, title)} streaming={false} parts={parts} />
        </div>
      )}
      {inPlace ? <div className={`${ts.prose} ${b.cardBody}`}><MarkdownBody text={withoutTitle(markdown, title)} streaming={false} parts={parts} /></div> : null}
      {open || inPlace || !fold ? null : <div className={b.acts}><button type="button" className={b.open} onClick={show}>打开</button></div>}
      {side && panel ? <SideContent side={side} kind="file"><CardPreview title={title} markdown={markdown} parts={parts} onClose={close} /></SideContent> : null}
      {edge}
    </section>
  );
}

/** 右边那一格里的全文：照文件预览的样子，页头名字和关闭，Esc 关。 */
function CardPreview({ title, markdown, parts, onClose }: { title: string; markdown: string; parts: MarkdownParts; onClose: () => void }) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => { root.current?.focus(); }, [markdown]);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest("input, textarea, select, [contenteditable=\"true\"], [role=dialog], [role=menu], [role=listbox]")) return;
      event.preventDefault();
      event.stopPropagation();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose]);
  return (
    <aside ref={root} className={vs.preview} aria-label={title} tabIndex={-1} data-testid="card-preview">
      <header className={vs.previewHead}>
        <b title={title}>{title}</b>
        <span className={vs.previewGap} />
        <HeroButton variant="ghost" size="sm" isIconOnly aria-label="关闭" title="关闭" onPress={onClose}><X {...ICON} /></HeroButton>
      </header>
      <div className={vs.previewBody}>
        <article className={`${ts.prose} ${vs.md} ${vs.previewDoc}`}><MarkdownBody text={withoutTitle(markdown, title)} streaming={false} parts={parts} /></article>
      </div>
    </aside>
  );
}
