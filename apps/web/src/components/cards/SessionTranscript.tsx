"use client";

/**
 * 子会话的对话（本机实时，原型 v8.4 cardChat）。本人说的靠右；执行方说的是浅灰气泡，带名字；
 * 过程（28 条，照 Claude Code）：两句对话之间的步骤、批过的权限合成一行，收着写总结（运行 N 条命令 · 读 N 个文件 · … · 用时），正在跑时是转圈加当前那一步，点开一步一行、不写时间；
 * 要权限是选项框（批准 / 同类以后都批准 / 换个做法），几件一起等着时合成一个框翻页，放在第一件的位置，批完就消失：批准的不留行，换了做法的在那一步行尾写「换个做法」；
 * 答过的问题收成一行（勾 · 问题 · 答案），不另起「问：」「答：」两行，AskUserQuestion 那一步不画；没答就过去了的（被新的取代、作废、子会话停了）收成「已失效」。
 * 交回、产出、提醒各一行。
 * 本人那句话的回执（17.4，样子同伙伴台）：一个勾已送达、两个勾已读；没读到就没了写「没读到 · 重发」。本机补发的话没有回执。
 * 一按发送就先画出来（useSessionSend）：淡一点、写「发送中」，事件流里同编号的那句来了换成真的；没发出去写「没发出去 · 重发」。
 * canAct=false（手机、别的电脑、本机没连）时选项框不给选项，头上写「等你 · {电脑名}」。
 */
import { TurnFilesLine } from "./TurnFiles";
import { createContext, memo, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Components } from "react-markdown";
import { ChevronRight } from "lucide-react";
import { questionNotice, type SessionEntry, type SessionView } from "@/lib/local/sessionView";
import type { LocalRunner, TLocalModelProfile, TLocalSessionSummary, TLocalPermissionRequestView, TLocalQuestionRequestView, TLocalSessionStatus } from "@/lib/local/runner";
import { duration } from "@/lib/home/derive";
import { relativeDayTime } from "@/lib/companyTime";
import { HeroButton } from "@/components/HeroButton";
import { REMARK_PLUGINS } from "@/lib/markdown";
import { InputBar } from "@/components/home/InputBar";
import { ContextRing, FolderText, FootText, QuotaRing } from "@/components/home/InputFooter";
import { ModelPanel } from "@/components/home/ModelPanel";
import { AUTO_EFFORT, QUOTA_RING_LEFT, localPanelRows, pickLocal, sourceQuota, type PanelRowKey } from "@/lib/local/modelPanel";
import { usageCells } from "@/lib/home/quota";
import { sizeText, uploadToSubSession } from "@/lib/home/attachments";
import type { TLocalHold, TLocalAttachmentRef, TLocalEffort, TLocalPermissionMode, TLocalPlanEntry, TLocalSessionModelRequest, TLocalStatusResponse, TSessionAttachment } from "@warmap/contracts";
import { PermissionModeMenu } from "./PermissionMode";
import { ApprovalDecision, DENY_MAX, awayChip } from "@/components/work/decisions";
import { DecisionBox, FailedLine } from "@/components/work/DecisionBox";
import { ICON, StateIcon, type IconState } from "@/components/home/StateIcon";
import { Elapsed, WorkingMark, planDoing } from "./ActivityLine";
import { MarkdownBody, ReceiptFailed, ReceiptSending, ReceiptTicks, type MarkdownParts } from "@/conversation/Transcript";
import h from "@/styles/home.module.css";
import s from "@/styles/v2-session.module.css";
import ts from "@/styles/conversation-transcript.module.css";

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export type DecideOptions = { forSession?: boolean; message?: string };

type Step = Extract<SessionEntry, { kind: "step" }>;
type Permission = Extract<SessionEntry, { kind: "permission" }>;
/** 一次提问折成一项：答了是答案，没答就过去了是 expired。 */
type Asked = { kind: "asked"; seq: number; question: string; answer: string | null };
/** 过程里的一行：一步；denied = 本人让它换了做法（批准时选的「换个做法」），voided = 本机程序重启时作废的（不是本人拒的）；note = 过程里的一句提示（换了模型），不算步数。 */
type ProcessRow = { step: Step; denied: boolean; voided?: boolean; note?: boolean };
/** 归进过程的提示（32 条：换模型那一句进过程行，不单独一行）。 */
const PROCESS_NOTICES = new Set(["model_changed"]);
/** 一段过程（28 条）：两句对话之间的步骤、批过的权限并成一段，start/end 是这一段第一条和最后一条记录的时间。 */
type Process = { kind: "process"; seq: number; start: string; end: string; rows: ProcessRow[] };
type Item = Exclude<SessionEntry, Step> | Process | Asked;

/** 执行方问本人那一步：不画，留问答那一行。 */
const ASK_TOOL = "AskUserQuestion";
/** 收起时按类型数（标题是本机 describeTool 写的「运行 …」「读文件 …」等）。 */
const STEP_KINDS: { prefixes: string[]; text: (count: number) => string }[] = [
  { prefixes: ["运行 "], text: (count) => `运行 ${count} 条命令` },
  { prefixes: ["读文件 ", "读 "], text: (count) => `读 ${count} 个文件` },
  { prefixes: ["改文件 ", "写文件 ", "改 ", "写 "], text: (count) => `改 ${count} 个文件` },
  { prefixes: ["搜索 ", "找文件 ", "联网搜索 "], text: (count) => `搜索 ${count} 次` },
];

/** 一段过程的总结：「运行 5 条命令 · 读 3 个文件 · 改 2 个文件 · 搜索 2 次」，别的工具写「其他 N 步」。 */
export function processSummary(titles: string[]): string {
  const counts = STEP_KINDS.map(() => 0);
  let other = 0;
  for (const title of titles) {
    const at = STEP_KINDS.findIndex((kind) => kind.prefixes.some((prefix) => title.startsWith(prefix)));
    if (at < 0) other += 1; else counts[at]! += 1;
  }
  return [...STEP_KINDS.flatMap((kind, at) => (counts[at] ? [kind.text(counts[at]!)] : [])), ...(other ? [`其他 ${other} 步`] : [])].join(" · ");
}

/** 换了做法的批准挂到同名的那一步上（离它最近、还没挂过的）；没有那一步就自己算一行。 */
function processRows(steps: Step[], denied: Permission[], notes: Step[]): ProcessRow[] {
  const rows: ProcessRow[] = steps.map((step) => ({ step, denied: false }));
  for (const permission of denied) {
    const match = rows.filter((row) => !row.denied && row.step.title === permission.request.title)
      .sort((a, b) => Math.abs(a.step.seq - permission.seq) - Math.abs(b.step.seq - permission.seq))[0];
    if (match) { match.denied = true; match.voided = Boolean(permission.voided); }
    else rows.push({ step: { kind: "step", seq: permission.seq, at: permission.at, toolUseId: permission.request.requestId, title: permission.request.title, done: true, isError: false }, denied: true, voided: Boolean(permission.voided) });
  }
  for (const step of notes) rows.push({ step, denied: false, note: true });
  return rows.sort((a, b) => a.step.seq - b.step.seq);
}

/** sessionView 记的「问：…」「答：…」两行（questionNotice 和 question_resolved 写的）。 */
const ASK_PREFIX = "问：";
const ANSWER_PREFIX = "答：";
const noticeText = (entry: SessionEntry) => (entry.kind === "notice" ? entry.text : null);

/**
 * 两句对话之间的过程并成一段（28 条）：对话是本人说的、执行方说的、交回、交出产出、问答、提醒；过程是步骤和批过的权限（批准、换个做法）。
 * 还没批的、失效的权限照旧单独一项（选项框、「已失效」）。AskUserQuestion 那一步不要。「问：」和它后面的「答：」并成一项。
 */
function groupEntries(entries: SessionEntry[]): Item[] {
  const items: Item[] = [];
  const denied = new Map<Process, Permission[]>();
  const steps = new Map<Process, Step[]>();
  const notes = new Map<Process, Step[]>();
  const used = new Set<number>();
  entries.forEach((entry, index) => {
    if (used.has(index)) return;
    const text = noticeText(entry);
    if (text?.startsWith(ASK_PREFIX)) {
      // 下一次提问之前的第一行「答：」就是它的答案；没有就是没答就过去了。
      let answer: string | null = null;
      for (let at = index + 1; at < entries.length; at += 1) {
        const next = noticeText(entries[at]!);
        if (next?.startsWith(ASK_PREFIX)) break;
        if (next?.startsWith(ANSWER_PREFIX)) { answer = next.slice(ANSWER_PREFIX.length); used.add(at); break; }
      }
      items.push({ kind: "asked", seq: entry.seq, question: text.slice(ASK_PREFIX.length).trim(), answer });
      return;
    }
    if (entry.kind === "step" && entry.title === ASK_TOOL) return;
    const note = entry.kind === "notice" && entry.code !== undefined && PROCESS_NOTICES.has(entry.code);
    if (entry.kind !== "step" && !note && !(entry.kind === "permission" && entry.decision)) { items.push(entry); return; }
    let last = items[items.length - 1];
    if (last?.kind !== "process") {
      last = { kind: "process", seq: entry.seq, start: entry.at, end: entry.at, rows: [] };
      items.push(last);
      steps.set(last, []);
      denied.set(last, []);
      notes.set(last, []);
    }
    last.end = entry.at;
    if (entry.kind === "step") steps.get(last)!.push(entry);
    else if (entry.kind === "notice") notes.get(last)!.push({ kind: "step", seq: entry.seq, at: entry.at, toolUseId: `note-${entry.seq}`, title: entry.text, done: true, isError: false });
    else if (entry.kind === "permission" && entry.decision === "deny") denied.get(last)!.push(entry);
  });
  for (const [process, list] of steps) process.rows = processRows(list, denied.get(process)!, notes.get(process)!);
  // 只有批过的权限、那一步还没来的一段先不画。
  return items.filter((item) => item.kind !== "process" || item.rows.length > 0);
}

/** 回答里提到的一处（行内代码、链接的地址）能不能点开看：对得上本会话改过的文件或交出的产出才给，回 null 就照原样画。 */
export type OpenFile = (mention: string) => (() => void) | null;
/**
 * 打开文件的办法走 context，不进 Markdown 的部件：改动清单一刷新，只有提到文件的那几处重画（能不能点跟着最新的清单），
 * 整段回答不重新解析。
 */
const OpenFileContext = createContext<OpenFile | null>(null);
const decoded = (href: string) => { try { return decodeURIComponent(href); } catch { return href; } };
/** 回答里的链接：对得上文件就是打开它的按钮，不然新开一页。 */
function MentionLink({ href, children }: { href?: string; children?: ReactNode }) {
  const onFile = useContext(OpenFileContext);
  const open = href ? onFile?.(decoded(href)) ?? null : null;
  return open ? <button type="button" className={s.fileLink} onClick={open} data-testid="file-open">{children}</button> : <a href={href} target="_blank" rel="noopener noreferrer">{children}</a>;
}
/** 行内代码：只认行内的一小段（代码块带 language- 类或有换行）。 */
function MentionCode({ className, children }: { className?: string; children?: ReactNode }) {
  const onFile = useContext(OpenFileContext);
  const text = typeof children === "string" && !className && !children.includes("\n") ? children : null;
  const open = text ? onFile?.(text) ?? null : null;
  return open ? <code><button type="button" className={s.fileLink} onClick={open} data-testid="file-open">{text}</button></code> : <code className={className}>{children}</code>;
}
/** 子会话正文的 Markdown 部件（不认伙伴对话的出处标记和公式：命令里的 $ 不当公式）。 */
const SESSION_PARTS: MarkdownParts = { components: { a: MentionLink, code: MentionCode } as Components, remarkPlugins: REMARK_PLUGINS, rehypePlugins: [] };

/**
 * 执行方说的话按 Markdown 排（41 条）：标题、列表、表格、加粗、代码、链接；字号行距跟着这条回答，不比正文大。
 * 用伙伴对话的出字组件（MarkdownBody）和它的排法（.prose，一套）：按顶层块分开解析、文字没变就不重排；fresh（页面开着时刚到的）新字淡入。
 */
export const AgentText = memo(function AgentText({ text, fresh = false }: { text: string; fresh?: boolean }) {
  return <div className={`${ts.prose} ${s.md}`}><MarkdownBody text={text} streaming={false} fresh={fresh} parts={SESSION_PARTS} /></div>;
});

/** 执行方正在写的那一段（本机推的草稿）：按字匀速放出、新字淡入，这一段写完换成真的那条。 */
function DraftBubble({ text, agentName }: { text: string; agentName: string }) {
  return <div className={s.bubble} data-testid="session-draft"><small className={s.who}>{agentName}</small><div className={`${ts.prose} ${s.md}`}><MarkdownBody text={text} streaming parts={SESSION_PARTS} /></div></div>;
}

/** 刚到多久以内算「页面开着时到的」（打开时从头重放的历史早于它，不淡入）。 */
const FRESH_MS = 5000;
/** 执行方的一段话：挂上那一刻看它是不是刚到的，之后不再变。drafted：这一段已经按草稿一个字一个字出过了，换成真的时不再整段淡入。 */
function AssistantBubble({ entry, agentName, drafted }: { entry: Extract<SessionEntry, { kind: "assistant" }>; agentName: string; drafted: boolean }) {
  const [fresh] = useState(() => !drafted && Date.now() - Date.parse(entry.at) < FRESH_MS);
  return <div className={s.bubble}><small className={s.who}>{agentName}</small><AgentText text={entry.text} fresh={fresh} /></div>;
}

/** 没做完的那一步：会话还在跑就是进行中，不在跑了就是停在那儿了。 */
const stepState = (step: Step, live: boolean): IconState => step.isError ? "failed" : step.done ? "done" : live ? "running" : "stopped";

/**
 * 这一轮从什么时候算起（27 条「在跑」那一行的时长）：最近一句本人说的（含交代）；一句都还没有时取第一条记录的时间；什么都没有为 null（只转圈不写时长）。
 */
export function roundStart(entries: SessionEntry[]): string | null {
  for (let index = entries.length - 1; index >= 0; index -= 1) if (entries[index]!.kind === "user") return entries[index]!.at;
  return entries[0]?.at ?? null;
}

/**
 * 「在跑」那一行（27 条；11/16 起照 Claude Code 的「在做什么」那一行，ActivityLine）：模型在两步之间想、或在写回答的时候界面也在动——
 * 字符动画、计划里在做的那条、这一轮跑了多久（每秒走一下）。只在会话在跑、最后不是正在跑的那段过程、也没在等你批准或回答时出。不写解释句。
 * starting（本机在拉起执行方）：写「启动中」，running 以后照旧。
 */
function WorkingRow({ since, starting = false, doing }: { since: string | null; starting?: boolean; doing: string | null }) {
  const text = starting ? "启动中" : doing;
  return (
    <div className={`${s.step} ${s.activity}`} data-testid="session-working">
      <WorkingMark label={starting ? "启动中" : "在跑"} />
      {text ? <span className={s.stepText}>{text}</span> : null}
      {since ? <Elapsed since={since} /> : null}
    </div>
  );
}

/** 点开后的一步一行：不写时间；换了做法的行尾一个淡色「换个做法」，本机程序重启作废的写「已作废」。 */
function StepRow({ row, live }: { row: ProcessRow; live: boolean }) {
  return (
    <div className={s.step}>
      <StateIcon state={row.denied ? "stopped" : stepState(row.step, live)} />
      <span className={s.stepText}>{row.step.title}</span>
      {row.denied ? <span className={s.stepsTook}>{row.voided ? "已作废" : "换个做法"}</span> : null}
    </div>
  );
}

/**
 * 一段过程一行（28 条，照 Claude Code）：收着时写总结和这一段的用时，点开一步一行。
 * running（会话在跑、这一段在最后、还没开始写回答）：这一段就是「在做什么」那一行（11/16，ActivityLine）——字符动画、当前那一步
 * （执行方写的 description，没有就写标题）、这一轮的用时（since）、行尾 › 点开一步一行；做完了收成总结。
 */
const ProcessGroup = memo(function ProcessGroup({ process, live, running, since }: { process: Process; live: boolean; running: boolean; since: string | null }) {
  const [open, setOpen] = useState(false);
  const counted = process.rows.filter((row) => !row.note);
  const summary = counted.length ? processSummary(counted.map((row) => row.step.title)) : process.rows.map((row) => row.step.title).join(" · ");
  const current = [...process.rows].reverse().find((row) => !row.denied && !row.step.done) ?? process.rows[process.rows.length - 1]!;
  const doing = current.step.description ?? current.step.title;
  const took = !running && Date.parse(process.end) - Date.parse(process.start) >= 1000 ? duration(process.start, process.end) : null;
  const said = running ? doing : [summary, took].filter(Boolean).join(" · ");
  const chevron = <ChevronRight {...ICON} className={h.chevron} data-open={open ? "" : undefined} />;
  return (
    <div className={running ? `${s.steps} ${s.activity}` : s.steps} data-open={open ? "" : undefined}>
      <button type="button" className={s.stepsHead} aria-expanded={open} aria-label={`${said}，${open ? "收起" : "展开"}`} onClick={() => setOpen(!open)}>
        {running ? <WorkingMark label="进行中" /> : chevron}
        <span className={s.stepsSummary}>{running ? doing : summary}</span>
        {took ? <span className={s.stepsTook}>{took}</span> : null}
        {running && since ? <Elapsed since={since} /> : null}
        {running ? chevron : null}
      </button>
      <div className={s.stepsBody} inert={!open}>
        <div>{process.rows.map((row) => <StepRow key={row.step.seq} row={row} live={live} />)}</div>
      </div>
    </div>
  );
}, (a, b) => a.live === b.live && a.running === b.running && a.since === b.since && sameProcess(a.process, b.process));

/** 一段过程画出来一样不一样（每来一条事件都重新分组，对象是新的，按内容比）。 */
function sameProcess(a: Process, b: Process): boolean {
  return a.seq === b.seq && a.start === b.start && a.end === b.end && a.rows.length === b.rows.length
    && a.rows.every((row, index) => { const other = b.rows[index]!; return row.denied === other.denied && row.note === other.note && row.step.seq === other.step.seq && row.step.title === other.step.title && row.step.description === other.step.description && row.step.done === other.step.done && row.step.isError === other.step.isError; });
}

const noop = () => undefined;

/** 会话结束了（退出、失败、交完收工）：还挂着的提问、批准都算失效。 */
export const sessionEnded = (status: TLocalSessionStatus | null) => status === "exited" || status === "failed" || status === "done";

/**
 * 子会话底下的输入框发一句话（5.4.3「和底部输入框的关系」）：有没批的批准时，这句话 = 「换个做法：{这句话}」，批准框收起；
 * 超过「换个做法」的上限时批准那边只记换个做法，整句照常插话。没有要批的就是插话。messageId 见 useSessionSend。
 */
export async function sayToSession(runner: LocalRunner, sessionId: string, pending: TLocalPermissionRequestView[], text: string, attachments: TLocalAttachmentRef[] = [], messageId?: string): Promise<boolean> {
  const waiting = pending[0];
  if (!waiting || isCompact(text, attachments.length > 0)) { await runner.sendMessage(sessionId, text, undefined, attachments, messageId); return true; }
  // 带了附件的，批准那边只记换个做法，整句（连附件）照常插话。
  const fits = text.length <= DENY_MAX && !attachments.length;
  await runner.decidePermission(sessionId, waiting.requestId, { decision: "deny", ...(fits && text ? { message: text } : {}) });
  if (!fits) await runner.sendMessage(sessionId, text, undefined, attachments, messageId);
  return true;
}

/** 这句话会不会交给本机发（会才有 user_message 回来、才能先画）：有没批的批准且放得进「换个做法」的，只记换个做法、不发。 */
const sendsMessage = (pending: readonly TLocalPermissionRequestView[], text: string, withFiles: boolean) => !isCompact(text, withFiles) && (!pending[0] || text.length > DENY_MAX || withFiles);
/** 手打的 /compact（本人 11/18；带压缩要求、大小写不同也算，同本机）：本机照「压缩」处理，不记成一句话、不回 user_message。 */
const isCompact = (text: string, withFiles: boolean) => !withFiles && /^\/compact(\s|$)/i.test(text.trim());

/** 网页先画的一句（还没在事件流里见到）。 */
export type Outgoing = { sessionId: string; messageId: string; at: string; text: string; files: File[]; failed: boolean };

/** 先画的那几句接在对话最后（事件流里已经有同编号的就不画了，不重复）。 */
export function withOutgoing(view: Pick<SessionView, "entries" | "lastSeq">, outgoing: readonly Pick<Outgoing, "messageId" | "at" | "text" | "files" | "failed">[]): SessionEntry[] {
  const arrived = new Set(view.entries.flatMap((entry) => (entry.kind === "user" && entry.messageId ? [entry.messageId] : [])));
  const left = outgoing.filter((item) => !arrived.has(item.messageId));
  if (!left.length) return view.entries;
  return [...view.entries, ...left.map((item, index): SessionEntry => ({
    kind: "user", seq: view.lastSeq + (index + 1) / 1000, at: item.at, text: item.text, messageId: item.messageId, local: item.failed ? "unsent" : "sending",
    ...(item.files.length ? { attachments: item.files.map((file) => ({ name: file.name, size: file.size })) } : {}),
  }))];
}

/** 发话那一头要读的（每次读最新的）：本机、会话、没批的批准、先画着的那几句。 */
type OutboxState = { runner: LocalRunner; sessionId: string | null; pending: readonly TLocalPermissionRequestView[]; list: readonly Outgoing[] };

/**
 * 子会话里说一句（输入框、「继续」、专题那几个按钮都走这里）：本机收 messageId 时，一按就先画出来（发送中），附件先传云端、再交给本机；
 * 没发出去（传附件或发话报错）那句变「没发出去 · 重发」，重发用同一个编号（本机去重），附件传好了不再传，输入框不动。
 * 本机不收 messageId、或这句话只记成「换个做法」时照原来：等发完才算发出去，没发出去由输入框放回去。
 * 不碰 React：先画着的那几句由 update 交给调用方存（useSessionSend 存在 state 里），测试直接用。
 */
export function sessionOutbox(read: () => OutboxState, update: (change: (list: Outgoing[]) => Outgoing[]) => void, upload: (files: File[]) => Promise<TLocalAttachmentRef[]>) {
  const uploaded = new Map<string, TLocalAttachmentRef[]>();
  const mark = (messageId: string, failed: boolean) => update((list) => list.map((item) => (item.messageId === messageId ? { ...item, failed } : item)));
  const deliver = async (item: Outgoing) => {
    try {
      let refs = uploaded.get(item.messageId);
      if (!refs) { refs = item.files.length ? await upload(item.files) : []; uploaded.set(item.messageId, refs); }
      const now = read();
      await sayToSession(now.runner, item.sessionId, [...now.pending], item.text, refs, item.messageId);
    } catch { mark(item.messageId, true); }
  };
  return {
    say: async (text: string, files: File[] = []): Promise<boolean> => {
      const { runner, sessionId, pending } = read();
      if (!sessionId) return false;
      if (!runner.clientMessageIds || !sendsMessage(pending, text, files.length > 0)) return sayToSession(runner, sessionId, [...pending], text, files.length ? await upload(files) : []);
      const item: Outgoing = { sessionId, messageId: crypto.randomUUID(), at: new Date().toISOString(), text, files, failed: false };
      update((list) => [...list, item]);
      void deliver(item);
      return true;
    },
    retry: (messageId: string) => {
      const item = read().list.find((entry) => entry.messageId === messageId && entry.failed);
      if (!item) return;
      mark(messageId, false);
      void deliver(item);
    },
  };
}

/** 页面里用的 sessionOutbox：先画的几句存在 state 里，和事件流折出来的拼成对话（entries）；真的那条来了本地那句就不要了。 */
export function useSessionSend(runner: LocalRunner, sessionId: string | null, view: Pick<SessionView, "entries" | "pending" | "lastSeq">, subject: TSessionAttachment["subject"]) {
  const [outgoing, setOutgoing] = useState<Outgoing[]>([]);
  const latest = useRef<OutboxState & { subject: TSessionAttachment["subject"] }>({ runner, sessionId, pending: view.pending, list: outgoing, subject });
  latest.current = { runner, sessionId, pending: view.pending, list: outgoing, subject };
  const [outbox] = useState(() => sessionOutbox(() => latest.current, setOutgoing, (files) => uploadToSubSession(latest.current.subject, files)));
  const mine = useMemo(() => outgoing.filter((item) => item.sessionId === sessionId), [outgoing, sessionId]);
  const entries = useMemo(() => withOutgoing(view, mine), [view, mine]);
  useEffect(() => {
    const arrived = new Set(view.entries.flatMap((entry) => (entry.kind === "user" && entry.messageId ? [entry.messageId] : [])));
    setOutgoing((list) => (list.some((item) => arrived.has(item.messageId)) ? list.filter((item) => !arrived.has(item.messageId)) : list));
  }, [view.entries]);
  return { entries, say: outbox.say, retry: outbox.retry };
}


type UserEntry = Extract<SessionEntry, { kind: "user" }>;

const NO_DRAFTED: ReadonlySet<number> = new Set();

const HOLD: Record<TLocalHold["reason"], string> = { usage_limit: "额度用完", balance: "余额不足", budget: "预算用完" };
/** 停下那一行的字（主循环第 65 条）：你停的 / 本机程序重启 / 出错：一句话 / 额度用完，几点恢复。 */
export function stopText(stopped: NonNullable<SessionView["stopped"]>): string {
  switch (stopped.why) {
    case "interrupted": return "你停的";
    case "killed": return "强停";
    case "runner_restart": return "本机程序重启";
    case "error": return stopped.reason ? `出错：${stopped.reason}` : "出错";
    case "held": {
      const what = stopped.hold ? HOLD[stopped.hold.reason] : "停着等";
      return stopped.hold?.until ? `${what}，${relativeDayTime(stopped.hold.until)} 恢复` : what;
    }
  }
}

/** 对话末尾那一行：为什么停了，行尾「接着做」（这台电脑上才给）。 */
export function StopLine({ stopped, onResume }: { stopped: NonNullable<SessionView["stopped"]>; onResume?: () => void }) {
  return (
    <div className={s.stopLine} data-testid="stop-line">
      <span>{stopText(stopped)}</span>
      {onResume ? <HeroButton variant="ghost" size="sm" onPress={onResume}>接着做</HeroButton> : null}
    </div>
  );
}

export function SessionTranscript({ entries, agentName, canAct, device, onDecide, lead, tail, asking, live, starting = false, ended = false, pinned = false, onResend, onRetry, onFile, draft = null, drafted = NO_DRAFTED, stopped = null, onResume, plan }: {
  entries: SessionEntry[];
  agentName: string;
  canAct: boolean;
  /** 跑这个会话的电脑：这里答不了时选项框头上写「等你 · {它}」。 */
  device?: string | null;
  onDecide: (request: TLocalPermissionRequestView, decision: "allow" | "deny", options: DecideOptions) => Promise<void>;
  /** 最上面一行（交代）。 */
  lead?: string;
  /** 接在最后的（执行方在问本人时的选项框）。 */
  tail?: ReactNode;
  /** 停了（不是做完一轮）：末尾一行写原因，行尾「接着做」（onResume，这台电脑上才给）。 */
  stopped?: SessionView["stopped"];
  onResume?: () => void;
  /** 还没答的那次提问：它的「问：…」一行不画，选项框就是它。 */
  asking?: TLocalQuestionRequestView | null;
  /** 会话还在跑（running(view.status)）：没做完的步骤转圈；结束了的没做完的步骤画方块。 */
  live: boolean;
  /** 本机在拉起执行方（状态 starting）：「在跑」那一行写「启动中 · N 秒」。 */
  starting?: boolean;
  /** 会话已经结束（退出、失败、交完收工）：没批的权限收成「已失效」。 */
  ended?: boolean;
  /** 没答的批准钉在输入框上方（第 54 条）：对话里那一处先不画，答了、失效了照常收成一行。 */
  pinned?: boolean;
  /** 没读到的那句再发一遍（只发原话；这里答不了时不给）。 */
  onResend?: (entry: UserEntry) => void;
  /** 先画出来却没发出去的那句再发一遍（useSessionSend.retry，同一个编号）。 */
  onRetry?: (messageId: string) => void;
  /** 「交出 文件名」那一行能不能点开看（41 条）：对得上交出的产出时回打开的办法，对不上回 null（不能点，不猜）。 */
  onFile?: OpenFile;
  /** 执行方正在写的那一段（useSessionEvents 的草稿）；没有为 null。drafted：按草稿出过的那几段的编号。 */
  draft?: string | null;
  drafted?: ReadonlySet<number>;
  /** 本机报的计划（view.plan）：两步之间「在跑」那一行写计划里在做的那条。 */
  plan?: readonly TLocalPlanEntry[];
}) {
  const pending = ended ? [] : entries.flatMap((entry) => (entry.kind === "permission" && !entry.decision ? [entry.request] : []));
  const firstPending = pending[0]?.requestId;
  const askingText = asking ? questionNotice(asking) : null;
  const lastAsk = askingText ? entries.map((entry) => entry.kind === "notice" && entry.text === askingText).lastIndexOf(true) : -1;
  const items = useMemo(() => groupEntries(entries.filter((_, index) => index !== lastAsk)), [entries, lastAsk]);
  // 在跑、没在等你：最后一段过程就是「在做什么」那一行（当前那一步）；最后不是过程（刚说完、在想）或已经在写回答时，最下面出「在跑」那一行。
  const busy = live && !pending.length && !asking;
  const tailProcess = items[items.length - 1]?.kind === "process" && !draft;
  const since = roundStart(entries);
  return (
    <OpenFileContext.Provider value={onFile ?? null}>
    <div className={s.feed}>
      {lead ? <span className={s.evt}>{lead}</span> : null}
      {items.map((entry, index) => {
        switch (entry.kind) {
          case "user": return [
            <div key={entry.seq} className={s.me} data-sending={entry.local === "sending" ? "" : undefined}>
              {entry.attachments?.length ? (
                <ul className={h.bubbleAtts} aria-label="附件">
                  {entry.attachments.map((file, index) => (
                    <li key={`${index}:${file.name}`} className={h.att}><span className={h.attName}><b title={file.name}>{file.name}</b><span className={h.num}>{sizeText(file.size)}</span></span></li>
                  ))}
                </ul>
              ) : null}
              {entry.initial ? <AgentText text={entry.text} /> : entry.text}
            </div>,
            entry.local === "sending" ? <ReceiptSending key={`${entry.seq}:receipt`} className={s.meReceipt} />
              : entry.local === "unsent" ? <ReceiptFailed key={`${entry.seq}:receipt`} className={s.meReceipt} label="没发出去" onResend={canAct && onRetry && entry.messageId ? () => onRetry(entry.messageId!) : undefined} />
              : entry.receipt === "failed" ? <ReceiptFailed key={`${entry.seq}:receipt`} className={s.meReceipt} label="没读到" onResend={canAct && entry.text ? () => onResend?.(entry) : undefined} />
              : entry.receipt ? <ReceiptTicks key={`${entry.seq}:receipt`} className={s.meReceipt} state={entry.receipt} /> : null,
          ];
          case "assistant": return <AssistantBubble key={entry.seq} entry={entry} agentName={agentName} drafted={drafted.has(entry.seq)} />;
          case "process": return <ProcessGroup key={entry.seq} process={entry} live={live} running={busy && tailProcess && index === items.length - 1} since={since} />;
          case "asked": return <DecisionBox key={entry.seq} kind="question" title={entry.question} options={[]} onPick={noop} resolved={entry.answer ?? undefined} expired={entry.answer === null} />;
          case "permission":
            if (ended) return <DecisionBox key={entry.seq} kind="approval" title={entry.request.title} options={[]} onPick={noop} expired />;
            if (entry.request.requestId !== firstPending) return null;
            return pinned ? null : <ApprovalDecision key={entry.seq} requests={pending} blocked={canAct ? null : awayChip(device)} onDecide={onDecide} />;
          case "artifact": {
            const open = onFile?.(entry.fileName) ?? null;
            return <div key={entry.seq} className={s.step}><StateIcon state="done" />
              <span className={s.stepText}>交出 {open ? <button type="button" className={s.fileLink} onClick={open} data-testid="artifact-open">{entry.fileName}</button> : entry.fileName}</span><time>{hhmm(entry.at)}</time></div>;
          }
          case "handback": return <span key={entry.seq} className={s.evt}>{hhmm(entry.at)} · 交回：{entry.summary}（{entry.met}/{entry.total} 条自评达到）</span>;
          case "notice": return <span key={entry.seq} className={s.evt} data-level={entry.level}>{entry.text}</span>;
          case "files": return <TurnFilesLine key={entry.seq} seq={entry.seq} turn={entry.turn} files={entry.files} more={entry.more} />;
        }
      })}
      {draft ? <DraftBubble text={draft} agentName={agentName} /> : null}
      {busy && !tailProcess ? <WorkingRow since={since} starting={starting} doing={planDoing(plan)} /> : null}
      {stopped && !live ? <StopLine stopped={stopped} onResume={onResume} /> : null}
      {tail}
    </div>
    </OpenFileContext.Provider>
  );
}

/**
 * 子会话底下的输入框（5.4.3「输入框」、14.5）：和首页、管线一样是 InputBar，不放占位字（空着就是一行），读屏名字「给{子会话名}插话」。发给执行方（进行中在下一个工具步骤生效）。
 * 附件先存到云端（POST /api/me/sub-sessions/:kind/:id/attachments），这句话带着引用交给本机，本机取回存进工作区；只带附件不说话也行。
 * dock：「N 个问题等你 / 回到最新」那一条（PendingDock），放在输入框上方。
 * 输入框下面一行（同首页、项目对话）：左边在哪个文件夹里跑（place，悬停出完整路径），右边模型（model，悬停出 title）和权限档（mode，useSessionMode；还没开工时不给）。
 */
/**
 * 子会话能换的来源、模型和思考（32、36、40 条）：三行面板的每一行和选了以后做什么。来源右边的数和状态词照本机状态（status，同右栏）。
 * 选了交给本机（PUT /v1/sessions/:id/model；换来源、换模型时思考档留不留由本机算），换好或记下「这一轮做完后换」后重读摘要，没成 onFail。
 * 在「执行方」那一行换执行方（Claude Code ↔ Codex，D 契约 5a217add）：会话还是这一个，摘要的 agent、权限档跟着变；规划员、验收员只能用 Claude Code。
 * canAddSource：本机有添加来源的接口（第 52 条），来源那一层最底下出「+ 添加来源」。
 */
export function sessionModels(runner: LocalRunner, models: readonly TLocalModelProfile[], session: TLocalSessionSummary | null | undefined, refresh: () => unknown, onFail: () => void,
  status?: Pick<TLocalStatusResponse, "quota" | "agents"> | null, canAddSource = false) {
  if (!session) return null;
  const change = (body: TLocalSessionModelRequest): Promise<void> => runner.setSessionModel(session.id, body).then(async () => { await refresh(); }, onFail);
  const modelId = session.pendingModel?.modelProfileId ?? session.modelProfileId;
  const effort = (session.pendingModel ? session.pendingModel.effort : session.effort) ?? null;
  const now = Date.now();
  // 规划员、验收员只用 Claude Code（换到 Codex 本机回 400），Codex 的来源灰着。
  const fixed = session.subject.kind === "plan" || session.subject.kind === "verify";
  const cells = usageCells(status?.quota ?? [], now);
  return {
    /** 现在这个来源剩多少（模型旁边的圆环，第 73 条）。 */
    quota: sourceQuota(models, modelId, cells),
    rows: localPanelRows({ models, modelId, effort, cells, agents: status?.agents ?? [], now, agentsAllowed: fixed ? ["claude-code"] : undefined, canAddSource }),
    /** 选了一项：交给本机，回的是「换好了」；没有要换的为 null。 */
    pick: (row: PanelRowKey, id: string): Promise<void> | null => {
      if (row === "effort") return change({ effort: id === AUTO_EFFORT ? null : id as TLocalEffort });
      const next = pickLocal(models, { modelId, effort }, row, id);
      return next && next.modelId !== modelId ? change({ modelProfileId: next.modelId }) : null;
    },
  };
}

/**
 * 子会话输入框下面那个面板用的：sessionModels 加上「正在换」——换执行方时本机要等新的那家起来才回（几秒），
 * 这期间那一行转圈、先写选的那个，三行都点不了，不会重复点。
 */
export function useSessionModels(runner: LocalRunner, models: readonly TLocalModelProfile[], session: TLocalSessionSummary | null | undefined, refresh: () => unknown, onFail: () => void,
  status?: Pick<TLocalStatusResponse, "quota" | "agents"> | null, canAddSource = false) {
  const [busy, setBusy] = useState<{ row: PanelRowKey; id: string } | null>(null);
  const base = sessionModels(runner, models, session, refresh, onFail, status, canAddSource);
  if (!base) return null;
  return {
    rows: base.rows, quota: base.quota, busy,
    onPick: (row: PanelRowKey, id: string) => {
      if (busy) return;
      const run = base.pick(row, id);
      if (!run) return;
      setBusy({ row, id });
      void run.finally(() => setBusy(null));
    },
  };
}

/**
 * 本机报了换好模型（notice model_changed）、换好执行方（harness_changed）就马上重读摘要：下面那一行从「当前 → 新」回到新模型，
 * 执行方的名字、能选的权限档跟着换，不等 10 秒一次的刷新。
 */
export function useModelChangedRefresh(entries: SessionEntry[], refresh: () => unknown) {
  const changed = [...entries].reverse().find((entry) => entry.kind === "notice" && (entry.code === "model_changed" || entry.code === "harness_changed"))?.seq ?? null;
  useEffect(() => { if (changed !== null) void refresh(); }, [changed, refresh]);
}

export function SessionComposer({ label, disabled, onSend, dock, pinned, subject, mode, place, model, models, context, onCompact, compacting = false, compactBlocked = false, busy = false, onStop, fill }: {
  /** 发一句（useSessionSend.say）：附件由它传云端（POST /api/me/sub-sessions/:kind/:id/attachments）再交给本机。 */
  label: string; disabled: boolean; onSend: (text: string, files: File[]) => Promise<boolean>; dock?: ReactNode;
  subject: TSessionAttachment["subject"];
  mode?: { modes: readonly TLocalPermissionMode[]; value: TLocalPermissionMode; set: (mode: TLocalPermissionMode) => void } | null;
  place?: { name: string; title: string; path?: string } | null;
  model?: { label: string; title?: string } | null;
  /** 能换的模型（32、40 条，这台电脑上跑着的子会话才给）：右边的模型成胶囊，点开三行面板，选了 onPick。 */
  models?: ReturnType<typeof useSessionModels>;
  /** 上下文用了多少（42 条，contextUsage 算的）：模型胶囊旁边一个小圆环加百分比；还没有就不画。 */
  context?: { percent: number; warn: boolean; tip: string; amount?: string } | null;
  /** 压缩上下文（本人 11/18，这台电脑上跑着的子会话才给）：圆环点开「压缩」；会话在跑（busy）时点不了。 */
  onCompact?: () => Promise<unknown>;
  /** 本机报着正在压缩（view.compacting）：「正在压缩」；调用方同时把 busy 算上它（出停止按钮）。在问本人（compactBlocked）时「压缩」点不了。 */
  compacting?: boolean;
  compactBlocked?: boolean;
  /** 会话在跑（27 条）：右边没字时是停止方块（onStop，本机 interrupt），有字时照样能发（插话），同项目对话、伙伴台。 */
  busy?: boolean;
  onStop?: () => void;
  /** 等本人处理的框（第 54 条）：钉在输入框上方。 */
  pinned?: ReactNode;
  /** 往框里填一段、聚焦（等你补的「我来补」）：nonce 变了才填。 */
  fill?: { text: string; nonce: number } | null;
}) {
  return (
    <div className={s.composerDock}>
      {pinned ? <div className={s.pinned} data-testid="pinned">{pinned}</div> : null}
      <InputBar placeholder="" label={label} disabled={disabled} dock={dock} busy={busy} interruptible onStop={onStop} draftKey={`tianshu-home-draft-v1:${subject.kind}:${subject.id}`} fill={fill}
        footer={{
          left: place ? <FolderText name={place.name} title={place.title} path={place.path} /> : null,
          right: <>{context ? <ContextRing {...context} busy={busy} blocked={compactBlocked} compacting={compacting} onCompact={disabled ? undefined : onCompact} /> : null}{models?.quota && models.quota.percent !== null && models.quota.percent <= QUOTA_RING_LEFT ? <QuotaRing used={100 - models.quota.percent} /> : null}{model && models?.rows.length && !disabled ? <ModelPanel label={model.label} title={model.title} rows={models.rows} onPick={models.onPick} busy={models.busy} testId="session-model" />
            : model ? <FootText title={model.title} testId="session-model">{model.label}</FootText> : null}{mode ? <PermissionModeMenu modes={mode.modes} value={mode.value} disabled={disabled} onChange={mode.set} /> : null}</>,
        }}
        onSend={onSend} />
    </div>
  );
}
