"use client";

import { Fragment, createContext, memo, useContext, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ReactElement, type ReactNode, type RefObject } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import type { PluggableList } from "unified";
import remend from "remend";
import { ArrowDown, ArrowRight, Check, Paperclip, Quote } from "lucide-react";
import { WorkspaceContext } from "@/components/shell/WorkspaceContext";
import type { TConversationLocalTurn, TReadScope } from "@warmap/contracts";
import { ScopeChip } from "./ScopeChip";
import { HeroButton } from "@/components/HeroButton";
import { StepList, StepToggle, type Step } from "@/components/steps/StepList";
import { VIA_LABEL, feishuWaiting, isReportPrompt, type Message, type ThinkingStage, type TurnProgress, type TurnThought } from "./useConversation";
import { QuoteChips } from "./QuoteChips";
import { pageContextBattlefield, readQuotedMessage } from "./quotes";
import { createArrivalLog, rehypeArrival, type ArrivalLog } from "./arrival";
import { parseAnswerOptions } from "./answerOptions";
import { AnswerRecord, AskContext } from "./AskPanel";
import { splitStableBlocks, useSmoothText } from "./smoothText";
import { CITATION_MARKDOWN, MemoryUsedProvider } from "./citations";
import { holdOpenLink, remarkCitationMarks } from "./citationMarks";
import { RichPre, RichSkeleton } from "./richBlocks/RichBlocks";
import { CONVERSATION_REHYPE_PLUGINS, CONVERSATION_REMARK_PLUGINS, holdOpenMath } from "./richBlocks/markdown";
import { RichStreamProvider } from "./richBlocks/surface";
import { afterResize, resizing } from "./resizeGate";
import { modelLine } from "@/lib/local/runModel";
import { useMessageReaction } from "./Reactions";
import s from "@/styles/conversation-transcript.module.css";
import c from "@/styles/card-references.module.css";

const seconds = (ms: number) => `${Math.max(1, Math.round(ms / 1000))} 秒`;
/** 现场行的用时（5.4.3）：过 60 秒写「1 分 12 秒」。 */
const liveClock = (ms: number) => { const total = Math.max(1, Math.round(ms / 1000)); return total < 60 ? `${total} 秒` : `${Math.floor(total / 60)} 分${total % 60 ? ` ${total % 60} 秒` : "钟"}`; };
/** 预计：不到 1 分钟写「约 40 秒」，再长写「约 3 分钟」。 */
const aboutText = (sec: number) => (sec < 60 ? `约 ${sec} 秒` : `约 ${Math.round(sec / 60)} 分钟`);

/** 助手这一轮的实际用时：与前一条用户消息的创建时间差（历史里没有单独记录）。 */
function turnMs(messages: Message[], index: number): number | undefined {
  const reply = messages[index];
  const question = [...messages.slice(0, index)].reverse().find((message) => message.role === "user");
  if (!reply?.createdAt || !question?.createdAt) return undefined;
  const ms = Date.parse(reply.createdAt) - Date.parse(question.createdAt);
  return Number.isFinite(ms) && ms >= 0 ? ms : undefined;
}

/** 稳定下来的块多久以后把到达 span 合并掉：淡入 150ms（conversation-transcript.module.css arrivalFade），多留一点。 */
export const ARRIVAL_SETTLE_MS = 400;

/** 对话正文的 Markdown 组件：来源链接（citations）+ 富内容块（richBlocks：```metric-compare / ```timeline）。 */
const TURN_MARKDOWN = { ...CITATION_MARKDOWN, components: { ...CITATION_MARKDOWN.components, pre: RichPre } };
/** 对话正文的 remark 插件：共用的那一组，加上句末出处画成标记（citationMarks）。 */
const TURN_REMARK_PLUGINS = [...CONVERSATION_REMARK_PLUGINS, remarkCitationMarks];

/**
 * 正文用哪一套 Markdown 部件。伙伴对话是 TURN_PARTS（出处标记、公式、富内容块）；子会话传自己的（不认出处和公式，
 * 行内代码、链接对得上本会话的文件就能点开）。传进来的要是稳定的引用（模块常量），不然每次重画都重新解析。
 */
export type MarkdownParts = { components: Components; remarkPlugins: PluggableList; rehypePlugins: PluggableList };
const TURN_PARTS: MarkdownParts = { components: TURN_MARKDOWN.components, remarkPlugins: TURN_REMARK_PLUGINS, rehypePlugins: CONVERSATION_REHYPE_PLUGINS };

/**
 * 流式正文的一个顶层块：自己的到达记录（新放出的字淡入，旧字不重播）；文字没变就不重画、不重新解析。
 * `open`：还在长的最后一块，先用 remend（Streamdown 的未闭合 Markdown 补全）把没写完的加粗、代码、链接补齐再解析，
 * 块结构不在「** 原样」与「粗体」之间来回跳；末尾没写完的链接先不显示（holdOpenLink），句末的出处写完直接以标记出现。
 * 没写完的公式（$$ 没闭合、行内 $ 没配对）先不进 Markdown（holdOpenMath），块级的在原处画骨架；
 * 没收全的富内容块由 RichPre 按 RichStreamProvider 的 open 画骨架。公式（KaTeX）在到达淡入之前渲染，淡入不切进公式里。
 * 不再是还在长的最后一块以后，淡入播完（ARRIVAL_SETTLE_MS）就不再按到达切：一段段 span 合并回普通文字
 * （每个 span 都带着播完的动画，数量一多，每帧的样式与排版都更贵）。外层节点与非 span 元素的 key 不变，富内容块、链接不重挂。
 */
const ArrivalBlock = memo(function ArrivalBlock({ text, open, parts }: { text: string; open: boolean; parts: MarkdownParts }) {
  const arrival = useRef<ArrivalLog | null>(null);
  arrival.current ??= createArrivalLog();
  // 合并时的原文：原文再变（极少），就重新按到达切。
  const [settled, setSettled] = useState<string | null>(null);
  const merged = !open && settled === text;
  useEffect(() => {
    if (open || merged) return;
    const settle = () => setSettled(text);
    const timer = setTimeout(() => (resizing() ? afterResize(settle) : settle()), ARRIVAL_SETTLE_MS);
    return () => clearTimeout(timer);
  }, [open, merged, text]);
  if (merged) {
    return (
      <RichStreamProvider open={false}>
        <ReactMarkdown remarkPlugins={parts.remarkPlugins} rehypePlugins={parts.rehypePlugins} components={parts.components} urlTransform={TURN_MARKDOWN.urlTransform}>{text}</ReactMarkdown>
      </RichStreamProvider>
    );
  }
  const held = open ? holdOpenMath(text) : { text, pending: false };
  const source = open ? remend(holdOpenLink(held.text), { linkMode: "text-only" }) : text;
  return (
    <RichStreamProvider open={open}>
      <ReactMarkdown remarkPlugins={parts.remarkPlugins} rehypePlugins={[...parts.rehypePlugins, rehypeArrival(arrival.current, text)]} components={parts.components} urlTransform={TURN_MARKDOWN.urlTransform}>
        {source}
      </ReactMarkdown>
      {held.pending ? <RichSkeleton title="公式" /> : null}
    </RichStreamProvider>
  );
});

/**
 * 正文 Markdown。历史消息整段解析。
 * 在这里流式过的那条（同一个节点）：到达的文字按字匀速放出（useSmoothText，积压多就快、结束尽快补齐），
 * 按顶层块分开画——只有最后一块随出字重新解析，前面的块不动；新出现的字轻淡入。
 * 结束后这个节点继续这样画，结束那一刻不换内部节点、不打断淡入。
 * fresh：整段一次到的（子会话还没有逐字草稿时，页面开着时刚到的那段）也这样画：短的按字放出、长的整段淡入。
 * 伙伴对话、子会话共用（子会话传自己的 parts）。
 */
export const MarkdownBody = memo(function MarkdownBody({ text, streaming, fresh = false, parts = TURN_PARTS }: { text: string; streaming: boolean; fresh?: boolean; parts?: MarkdownParts }) {
  const streamed = useRef(streaming || fresh);
  if (streaming) streamed.current = true;
  const shown = useSmoothText(text, streamed.current, streaming);
  if (!streamed.current) return <ReactMarkdown remarkPlugins={parts.remarkPlugins} rehypePlugins={parts.rehypePlugins} components={parts.components} urlTransform={TURN_MARKDOWN.urlTransform}>{text}</ReactMarkdown>;
  const catchingUp = shown.length < text.length;
  const blocks = splitStableBlocks(shown);
  return (
    <>
      {blocks.map((block, index) => (
        <ArrivalBlock key={index} text={block} open={index === blocks.length - 1 && (streaming || catchingUp)} parts={parts} />
      ))}
    </>
  );
});

const NO_MEMORY: readonly string[] = [];

/** 已经收起的思考摘要：正文开始以后挂在这条回答的「用时」一行，点开看全文。 */
type SettledThought = { text: string; seconds: number };
type TurnProps = { message: Message; ms?: number; streaming?: boolean; thought?: SettledThought; steps?: Step[] };

const sameList = <T,>(left: T[] | undefined, right: T[] | undefined, id: (item: T) => string) =>
  (left ?? []).map(id).join("|") === (right ?? []).map(id).join("|");

/** 历史消息 memo 的比较：读回历史后是新对象，但内容没变就不重画（不重跑 Markdown 与引用解析）。 */
export function sameTurn(previous: TurnProps, next: TurnProps): boolean {
  const a = previous.message, b = next.message;
  return previous.ms === next.ms && Boolean(previous.streaming) === Boolean(next.streaming)
    && previous.thought?.text === next.thought?.text && previous.thought?.seconds === next.thought?.seconds
    && sameList(previous.steps, next.steps, (step) => `${step.id}:${step.status}:${step.result ?? ""}`)
    && a.role === b.role && a.content === b.content
    && (a.memoryUsed ?? []).join("|") === (b.memoryUsed ?? []).join("|")
    && a.readScope?.label === b.readScope?.label && a.kind === b.kind && a.via === b.via && a.meta?.href === b.meta?.href && a.answers?.askId === b.answers?.askId
    && a.receipt === b.receipt && (a.reactions ?? []).join("|") === (b.reactions ?? []).join("|")
    && sameList(a.attachments, b.attachments, (item) => item.id)
    && sameList(a.referencesSnapshot, b.referencesSnapshot, (item) => `${item.cardId}@${item.version}`);
}

/** 「重发」（17.4）：伙伴对话里收下了却没开成的那句，旁边一个小按钮，样式同失败行的「重试」。由对话时间线给出重发的办法。 */
export const ResendContext = createContext<((message: Message) => void) | null>(null);
/** 本人那句话旁的两个小勾（17.4）：送达亮第一个，读到亮第二个。伙伴对话和子会话共用。 */
export function ReceiptTicks({ state, className }: { state: "delivered" | "read"; className?: string }) {
  return (
    <span className={className ? `${s.receipt} ${className}` : s.receipt} data-receipt={state} role="img" aria-label={state === "read" ? "已读" : "已送达"} data-testid="message-receipt">
      <Check size={12} strokeWidth={2.2} aria-hidden /><Check size={12} strokeWidth={2.2} aria-hidden />
    </span>
  );
}
/** 子会话里先画出来、本机还没回的那句：勾的位置写「发送中」。 */
export function ReceiptSending({ className }: { className?: string }) {
  return <span className={className ? `${s.receipt} ${className}` : s.receipt} data-testid="message-sending"><span className={s.receiptNote}>发送中</span></span>;
}
/** 收下了却没读到：在勾的位置写「没读到」加「重发」（子会话）；伙伴对话只给「重发」。 */
export function ReceiptFailed({ label, onResend, className }: { label?: string; onResend?: () => void; className?: string }) {
  return <span className={className ? `${s.receipt} ${className}` : s.receipt} data-testid="message-resend">{label ? <span className={s.receiptNote}>{label}{onResend ? " ·" : ""}</span> : null}{onResend ? <HeroButton variant="ghost" size="sm" onPress={onResend}>重发</HeroButton> : null}</span>;
}
function ResendLine({ message }: { message: Message }) {
  const resend = useContext(ResendContext);
  if (!resend) return null;
  return <ReceiptFailed onResend={() => resend(message)} />;
}

/** 首页留痕行（转议题之后）：「已转到议题 X」，点击直达议题页。像聊天里的系统行，居中、浅灰、不占一条回答的版面。 */
function TraceLine({ message }: { message: Message }) {
  const workspace = useContext(WorkspaceContext);
  const href = message.meta?.href;
  return (
    <div className={s.trace} data-chat-role="trace" data-testid="conversation-trace">
      {href ? (
        <a href={href} onClick={(event) => { event.preventDefault(); if (workspace) workspace.navigate(href); else window.location.assign(href); }}>
          <span>{message.content}</span><ArrowRight size={13} aria-hidden />
        </a>
      ) : <span>{message.content}</span>}
    </div>
  );
}

/** 一条消息（clark `ConversationTurn`）：不显示角色名，读屏读「你 / 天枢」。 */
/**
 * 一轮回答用的模型（主循环第 67 条）：「来源 · 模型」，同 modelLine。本机跑的（ranOn = local）云端只记了执行方，不当来源写，只写模型。没带模型的为 null。
 */
export function turnModel(message: Pick<Message, "ranOn" | "model">): string | null {
  if (!message.model) return null;
  return modelLine({ source: message.ranOn === "local" ? null : message.model.provider, model: message.model.model });
}

/**
 * 换了模型的地方（67 条）：每条回答上方不再标模型；一条回答的模型和前一条带模型的回答不一样时，在这一轮本人那句前面（没有就在回答前面）画「换成 …」。
 * 第一条带模型的回答不画。返回 消息下标 → 换成的「来源 · 模型」。
 */
export function modelSwitches(messages: readonly Pick<Message, "role" | "ranOn" | "model">[]): Map<number, string> {
  const at = new Map<number, string>();
  let last: string | null = null;
  let asked: number | null = null;
  messages.forEach((message, index) => {
    if (message.role === "user") { asked ??= index; return; }
    const label = turnModel(message);
    if (label && last && label !== last) at.set(asked ?? index, label);
    if (label) last = label;
    asked = null;
  });
  return at;
}

/**
 * 项目对话正在本人电脑上跑、还没写进历史的那一轮（localTurn）：别的页面、手机上先画本人那一句和「正在回答」，写进来后换成那一轮。
 * 第一版这里停不了。
 */
export function LocalTurnRow({ turn }: { turn: TConversationLocalTurn }) {
  return (
    <>
      <ConversationTurn message={{ sequence: -2, role: "user", content: turn.message, createdAt: turn.startedAt }} />
      <div className={s.thinking} data-testid="conversation-local-turn">
        <span className={s.pulse} aria-hidden />
        <span role="status">正在回答</span>
        <span className={s.time}>{turn.source}</span>
      </div>
    </>
  );
}

export const ConversationTurn = memo(function ConversationTurn({ message, ms, streaming = false, thought, steps }: TurnProps) {
  if (message.kind === "trace") return <TraceLine message={message} />;
  return <ConversationTurnBody message={message} ms={ms} streaming={streaming} thought={thought} steps={steps} />;
}, sameTurn);

function ConversationTurnBody({ message, ms, streaming = false, thought, steps }: TurnProps) {
  const user = message.role === "user";
  const [thoughtOpen, setThoughtOpen] = useState(false);
  const [stepsOpen, setStepsOpen] = useState(false);
  const stepsId = useId();
  const scope = !user && message.readScope ? <ScopeChip scope={message.readScope} /> : null;
  const thoughtToggle = thought || steps?.length || scope ? (
    <>
      {scope}
      {thought ? <button type="button" className={s.thoughtToggle} aria-expanded={thoughtOpen} onClick={() => setThoughtOpen((open) => !open)}
        data-testid="conversation-thought-toggle">已思考 {thought.seconds} 秒</button> : null}
      {steps?.length ? <StepToggle steps={steps} open={stepsOpen} onToggle={() => setStepsOpen((open) => !open)} className={s.thoughtToggle} controls={stepsId} /> : null}
    </>
  ) : null;
  const attachments = message.attachments ?? [];
  // 回答末尾的选项块（answerOptions）在进 Markdown、remend 与到达淡入之前就拿掉，流式中没写完的也不露出。
  const quoted = useMemo(() => (user ? readQuotedMessage(message.content) : { message: parseAnswerOptions(message.content, streaming).body, quotes: [] }),
    [user, message.content, streaming]);
  const battlefield = user ? pageContextBattlefield(message.content) : null;
  const memoryKey = streaming ? "" : (message.memoryUsed ?? []).join("|");
  const memoryUsed = useMemo(() => (memoryKey ? memoryKey.split("|") : NO_MEMORY), [memoryKey]);
  // 新首页的对话里回答提问的那一句不另画：提问卡原处收成了一行（AskContext.inline）。
  const ask = useContext(AskContext);
  const reaction = useMessageReaction(streaming ? null : message);
  if (user && message.answers && ask?.inline) return null;
  return (
    <article className={user ? s.user : s.assistant} data-chat-role={message.role} aria-label={user ? "你" : "天枢"}
      data-testid={streaming ? "conversation-streaming-turn" : undefined} aria-busy={streaming || undefined} {...reaction?.target}>
      {!user && ms !== undefined ? (
        <div className={s.meta}>
          <span className={s.time}>用时 {seconds(ms)}</span>
          {thoughtToggle}
        </div>
      ) : !user && thoughtToggle ? (
        // 正文已经开始：思考收成「已思考 N 秒」放在这一行，结束后「用时」写在它前面。
        <div className={s.meta}>{thoughtToggle}</div>
      ) : !user && streaming ? (
        // 先占住「用时」那一行：结束后写上用时，正文不被往下推。
        <div className={s.meta} aria-hidden data-meta-placeholder="true" style={{ visibility: "hidden" }}>
          <span>用时</span>
        </div>
      ) : null}
      {thought && thoughtOpen ? <div className={s.thoughtFull} data-testid="conversation-thought-full">{thought.text}</div> : null}
      {steps?.length && stepsOpen ? <StepList steps={steps} id={stepsId} className={s.settledSteps} /> : null}
      {user && message.referencesSnapshot?.length ? (
        <details className={c.sentReferences}>
          <summary>
            <Quote size={12} />
            批注了 {message.referencesSnapshot.length} 项
          </summary>
          {message.referencesSnapshot.map((reference) => (
            <details key={reference.cardId}>
              <summary>{reference.title}</summary>
              <small>v{reference.version} · 发送时快照</small>
            </details>
          ))}
        </details>
      ) : null}
      {user && attachments.length ? (
        <details className={c.sentReferences}>
          <summary>
            <Paperclip size={12} />
            附了 {attachments.length} 份材料
          </summary>
          {attachments.map((attachment) => (
            <small key={attachment.id}>{attachment.fileName}</small>
          ))}
        </details>
      ) : null}
      {battlefield ? <div className={s.pageTag}>战场 · {battlefield}</div> : null}
      {user && message.via && message.via !== "report" ? <div className={s.pageTag} data-testid={`conversation-via-${message.via}`}>{VIA_LABEL[message.via]}</div> : null}
      {quoted.quotes.length ? <QuoteChips quotes={quoted.quotes} sent /> : null}
      {/* 回答 Agent 提问的那一句：画成紧凑的问答记录，不显示原文。 */}
      {user && message.answers ? <AnswerRecord record={message.answers} /> : (
        <div className={s.prose}>
          <MemoryUsedProvider value={memoryUsed}>
            <MarkdownBody text={quoted.message} streaming={streaming} />
          </MemoryUsedProvider>
        </div>
      )}
      {/* 伙伴对话的回执（17.4）：两个小勾，送达亮第一个，读到亮第二个。 */}
      {user && message.receipt ? (message.receipt === "failed" ? <ResendLine message={message} /> : <ReceiptTicks state={message.receipt} />) : null}
      {reaction?.view}
    </article>
  );
}

/** 从首页带过来的那一段（议题页对话的开头）：前面一行很淡的「首页 · 10月18日」。 */
function CarriedDivider({ message }: { message: Message }) {
  const day = message.createdAt ? new Intl.DateTimeFormat("zh-CN", { timeZone: "Asia/Shanghai", month: "long", day: "numeric" }).format(new Date(message.createdAt)) : "";
  return <div className={s.carried} data-testid="conversation-carried">首页{day ? ` · ${day}` : ""}</div>;
}

/**
 * 按位置给 key：流式那条占的就是最终回答的位置（messages.length），完成读回历史后最终回答落在同一个 key 上，
 * 是同一个节点更新内容，不卸载重挂（服务端的 sequence 与本地暂记的可能不同，不拿它做 key）。
 * 每条消息连同它后面插的卡（`after`，B5）包在同一个 key 的 Fragment 里；流式中插在当前输出之后的卡（`trailing`）
 * 放在流式那条的 Fragment 里，完成后同一张卡出现在同一个 Fragment 的同一位置（卡片自己的 key 不与 `turn-*` 冲突）。
 *
 * 进行中这一轮的呈现顺序（ConversationTimeline 的「呈现顺序」规则）：正在写的那条（开场 → 正文）→ 状态区（`status`：思考与进度）→ 本轮的卡。
 * 状态区紧贴在正在写的文字下面，正文第一个字就出现在思考原来的位置；卡先做好就先在下面淡入，正文往下长时把卡往下推。
 * 状态区占的是完成后选项（footer）的位置，卡的位置不变，读回历史时卡不重挂。
 */
export function ConversationTurns({ messages, partial = "", footer, after, insertions, trailing, thought, steps, status, modelRule }: {
  messages: Message[]; partial?: string;
  /** 本轮的步骤（正文开始后才给）：与思考摘要一样，流式中挂在正在写的那条，结束后挂在最后一条回答上。 */
  steps?: Step[] | null;
  /** 进行中这一轮的状态区（思考、进度、停止）：放在正在写的那条之后、本轮的卡之前。给了就表示这一轮还在进行。 */
  status?: ReactNode;
  /** 本轮的思考摘要（正文开始后才给）：流式中挂在正在写的那条，结束后挂在最后一条回答上。 */
  thought?: SettledThought | null;
  /** 紧贴第 index 条消息下方的内容（最新回答的选项），在提案卡之前。 */
  footer?: (index: number) => ReactNode;
  /** 第 index 条消息之后插的内容（提案卡）。 */
  after?: (index: number) => ReactNode;
  /** 独立事件：-1 为首条消息之前；每项需有全局唯一 key，与消息同层，换位置时保留交互状态。 */
  insertions?: (index: number) => readonly ReactElement[];
  /** 当前输出之后的内容（流式中本轮的提案卡）。 */
  trailing?: ReactNode;
  /** 画「换成 …」那一行的办法（67 条）：新首页的对话给（分隔线同「11 月目标」那一种）；别处不给，就不画。 */
  modelRule?: (label: string) => ReactNode;
}) {
  const switches = modelRule ? modelSwitches(messages) : null;
  // Every independent event belongs to this one flat array, including leading
  // events. A per-turn or nested array parent would remount it when its bucket
  // changes (e.g. timed history → an untimed optimistic message → timed history).
  // Namespace event outlets so caller keys cannot collide with turn-N/waiting.
  const insertedAt = (index: number) => (insertions?.(index) ?? []).map(node => <Fragment key={`insertion:${node.key}`}>{node}</Fragment>);
  const rows: ReactNode[] = [...insertedAt(-1)];
  messages.forEach((message, index) => {
    rows.push(
      <Fragment key={`turn-${index}`}>
        {switches?.has(index) ? modelRule!(switches.get(index)!) : null}
        {message.kind === "carried" && messages[index - 1]?.kind !== "carried" ? <CarriedDivider message={message} /> : null}
        {isReportPrompt(message) ? null : (
          <ConversationTurn message={message} ms={message.role === "assistant" ? turnMs(messages, index) : undefined}
            thought={!partial && thought && index === messages.length - 1 && message.role === "assistant" ? thought : undefined}
            steps={!partial && steps?.length && index === messages.length - 1 && message.role === "assistant" ? steps : undefined} />
        )}
        {footer?.(index) ?? null}
        {after?.(index) ?? null}
      </Fragment>,
      ...insertedAt(index),
    );
  });
  // 飞书或微信里刚问、还在答：这里先占一行，答完读回历史时换成回答。
  if (!partial && !status && feishuWaiting(messages)) rows.push(
    <div key="waiting" className={s.thinking} data-testid="conversation-feishu-waiting">
      <span className={s.pulse} aria-hidden />
      <span role="status">{isReportPrompt(messages.at(-1)!) ? "正在看子会话的回报" : `正在回答${VIA_LABEL[messages.at(-1)!.via as keyof typeof VIA_LABEL]}里的提问`}</span>
    </div>,
  );
  if (partial || trailing || status) rows.push(
    <Fragment key={`turn-${messages.length}`}>
      {partial ? <ConversationTurn message={{ sequence: -1, role: "assistant", content: partial }} streaming thought={thought ?? undefined} steps={steps?.length ? steps : undefined} /> : null}
      {/* 与上面 footer 同一个位置（流式中没有选项，这里放状态区）：完成后提案卡仍在同一位置，不重挂。 */}
      {status ?? null}
      {trailing ?? null}
    </Fragment>,
  );
  return <>{rows}</>;
}

/** 现场行的阶段（新首页设计 5.4.3）：拿到具体阶段以前（刚发出、模型在想）只有呼吸点，不写「正在思考」这类笼统的词。 */
export const STAGE_COPY: Record<ThinkingStage, string | null> = { understanding: null, thinking: null, researching: "正在查资料", answering: "正在整理回答",
  connecting: "正在连接", offline: "等待网络" };
/** 深度档（重要的战略问题），以及中途升级后的非深度档：进度行用同一口径。 */
export const DEEP_STAGE_COPY: Record<ThinkingStage, string | null> = { ...STAGE_COPY, thinking: "深入分析" };

/**
 * 进度行的细节（系统生成）：查证时是最近一步在查什么 / 读到了什么；思考时是推理摘要里的中文要点，没有就沿用最近读到的内容；
 * 后面跟已查几项。正文开始后只留「已查几项」。不知道在查什么（首页走 Chat 时工具不带说明）就不单独报数，进度行只留阶段和用时。
 */
export function progressDetail(stage: ThinkingStage, progress?: TurnProgress): string | null {
  if (!progress || (!progress.label && !progress.thought)) return null;
  const counted = progress.checked ? `已查 ${progress.checked} 项` : null;
  if (stage === "answering") return counted;
  const head = stage === "thinking" ? (progress.thought || progress.label) : stage === "researching" ? progress.label : null;
  const parts = [head, counted].filter(Boolean);
  return parts.length ? parts.join(" · ") : null;
}

/**
 * 正文开始之前，模型真实的思考摘要在进度区滚动显示：只露出最近四行；不编造，没有摘要就不显示。
 * 有人会读这一段：13px、比正文浅一级的灰，不加模糊。只有超过四行、最上面一行被切开时，那一行才淡出（data-clipped）。
 */
export function ThinkingStream({ text }: { text: string }) {
  const box = useRef<HTMLDivElement>(null);
  const [clipped, setClipped] = useState(false);
  useLayoutEffect(() => {
    const element = box.current;
    if (element) setClipped(element.scrollHeight > element.clientHeight + 1);
  }, [text]);
  return (
    <div ref={box} className={s.thinkingStream} data-testid="conversation-thinking-stream" aria-label="思考过程" data-clipped={clipped || undefined}>
      <p>{text}</p>
    </div>
  );
}

/**
 * 回答进行中的一行（clark `ConversationThinking`）：脉冲点、阶段、在查什么 / 思考要点、用时 / 预计（深度档、中途升级才有预计）、停止。
 * 非深度档中途升级（服务端给「预计还需约 X 秒」）不另起一行解释：阶段写「深入分析」，用时后面接「/ 约 N 秒」（升级那一刻的用时加 X）；
 * 正文开始后不再写预计，整行淡化。
 */
export function ConversationThinking({ stage, startedAt, onStop, route, progress, steps = [], thought, readScope }: {
  stage: ThinkingStage; startedAt: number; onStop: () => void;
  route?: { tier: "quick" | "grounded" | "deep"; expectSeconds: number } | null;
  progress?: TurnProgress;
  /** 服务端给的步骤：有步骤时替代进度行的单行文字和计数；正文开始后收成一个勾和步数。 */
  steps?: Step[];
  /** 思考摘要：正文开始前在进度行上方滚动显示，正文开始后收到这条回答的「已思考 N 秒」里。 */
  thought?: TurnThought | null;
  /** 这一轮跨对象读取的范围：先显示范围标签，再显示步骤。 */
  readScope?: TReadScope | null;
}) {
  const [elapsed, setElapsed] = useState(() => Date.now() - startedAt);
  useEffect(() => {
    const update = () => setElapsed(Date.now() - startedAt);
    const timer = setInterval(update, 500);
    return () => clearInterval(timer);
  }, [startedAt]);
  const deep = route?.tier === "deep";
  const escalated = deep ? null : progress?.escalation ?? null;
  // 升级那一刻的用时：预计写整轮（用时 / 约 N 秒），服务端给的是「还需约 X 秒」。按这一轮（startedAt）记，换轮、重挂载不会把预计越推越后。
  const escalationKey = escalated ? `${startedAt}:${escalated.expectSeconds}:${escalated.notice}` : null;
  const [escalatedAt, setEscalatedAt] = useState(() => ({ key: escalationKey, ms: elapsed }));
  if (escalatedAt.key !== escalationKey) setEscalatedAt({ key: escalationKey, ms: elapsed });
  const answering = stage === "answering";
  const escalation = answering ? null : escalated;
  const stepped = steps.length > 0;
  const detail = stepped ? null : progressDetail(stage, progress);
  const phase = (deep || escalation ? DEEP_STAGE_COPY : STAGE_COPY)[stage];
  // 没有可信的预计就不写：用时过了预计（深度档 2 分钟）就不再写。
  const expectTotal = escalation ? Math.ceil((escalatedAt.ms / 1000 + escalation.expectSeconds) / 10) * 10 : null;
  const estimate = answering ? null : deep ? (elapsed < 120_000 ? "约 1–2 分钟" : null)
    : expectTotal !== null && elapsed / 1000 < expectTotal ? aboutText(expectTotal) : null;
  return (
    <div className={s.thinkingGroup} data-stage={stage} data-steps={stepped && !answering ? "" : undefined}>
      {thought?.text && thought.seconds === null && stage !== "answering" ? <ThinkingStream text={thought.text} /> : null}
      <div className={s.thinking} data-testid="conversation-thinking" data-tier={route?.tier} data-stage={stage}>
        <span className={s.pulse} aria-hidden />
        {/* 状态区一直在（读屏才念得到后来出现的阶段）；没有阶段时视觉上藏起。 */}
        <span role="status">{phase ?? ""}</span>
        {detail ? <span className={s.progressDetail} data-testid="conversation-progress">{detail}</span> : null}
        <span className={s.elapsed}>{phase || detail ? "· " : ""}{liveClock(elapsed)}{estimate ? ` / ${estimate}` : ""}</span>
        <HeroButton variant="ghost" size="sm" onPress={onStop} aria-label="停止本次回答">
          停止
        </HeroButton>
      </div>
      {readScope && !answering ? <div className={s.liveScope}><ScopeChip scope={readScope} /></div> : null}
      {stepped && !answering ? <StepList steps={steps} /> : null}
    </div>
  );
}

/**
 * 本地产生、没有进入历史的失败或停止说明，按一条助手消息的样式显示。
 * action：这一轮能接着来时的按钮（「继续」从断点续写 / 「重新回答」用已查到的材料重答）。
 */
export function ConversationNotice({ text, action }: { text: string; action?: { label: string; run: () => void } | null }) {
  return (
    <article className={s.assistant} data-chat-role="assistant" aria-label="天枢" data-testid="conversation-notice">
      <div className={s.prose}>
        <p role={action ? "alert" : undefined}>{text}</p>
      </div>
      {action ? (
        <HeroButton variant="secondary" size="sm" onPress={action.run} data-testid="conversation-resume">
          {action.label}
        </HeroButton>
      ) : null}
    </article>
  );
}

/**
 * 「思考中」那一行的固定位置：回答中放思考行，结束后留着同样高度的空位，内容不在结束那一刻缩回。
 */
export function ConversationStatusSlot({ children }: { children?: ReactNode }) {
  return (
    <div className={s.statusSlot} data-testid="conversation-status-slot">
      {children}
    </div>
  );
}

/**
 * 圆形 ↓（B1 / D3）：不在底部时浮出，点了平滑回到最新并恢复跟随；在底部时藏起（不占位、不可聚焦）。
 * 位置由所在面板给（className）：底边贴在输入框上沿之上 JUMP_GAP。Agent 正在输出时球里是三个依次明暗的圆点，结束变回 ↓。
 */
export function JumpToLatest({ visible, onJump, className, streaming = false }: { visible: boolean; onJump: () => void; className?: string; streaming?: boolean }) {
  return (
    <div className={className ? `${s.jumpDock} ${className}` : s.jumpDock} data-visible={visible || undefined} aria-hidden={!visible || undefined} inert={!visible || undefined}>
      <HeroButton variant="ghost" size="sm" isIconOnly className={s.jump} onPress={onJump} aria-label="回到最新" data-testid="conversation-jump-latest" data-streaming={streaming || undefined}>
        {streaming ? <span className={s.jumpDots} aria-hidden><i /><i /><i /></span> : <ArrowDown size={18} strokeWidth={2} aria-hidden />}
      </HeroButton>
    </div>
  );
}

/** ↓ 的底边离输入框上沿多远（D3）。 */
export const JUMP_GAP = 12;
/** ↓ 离容器下沿多高：容器下沿到输入框上沿的距离再空 JUMP_GAP；量不到时至少 JUMP_GAP。 */
export function composerClearance(hostBottom: number, composerTop: number, gap = JUMP_GAP): number {
  return Math.max(gap, Math.round(hostBottom - composerTop + gap));
}

/**
 * 把 composerClearance 写成 host 上的 `--jump-bottom`（D3）：输入框长高（多行、引用行出现）、变矮，
 * 窗口变化，host 入场动画结束，都重新量。直接写 CSS 变量，不触发重渲染。
 */
export function useComposerClearance(host: RefObject<HTMLElement | null>, composer: RefObject<HTMLElement | null> | undefined) {
  useEffect(() => {
    const element = host.current, target = composer?.current;
    if (!element || !target) return;
    const measure = () => element.style.setProperty("--jump-bottom", `${composerClearance(element.getBoundingClientRect().bottom, target.getBoundingClientRect().top)}px`);
    measure();
    // 对话层放大 / 收起的过渡里外框每帧在变：不量，结束时量一次（下沿本来就不动）。
    const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => (resizing() ? afterResize(measure) : measure()));
    observer?.observe(element);
    observer?.observe(target);
    window.addEventListener("resize", measure);
    element.addEventListener("animationend", measure);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", measure);
      element.removeEventListener("animationend", measure);
    };
  }, [host, composer]);
}
