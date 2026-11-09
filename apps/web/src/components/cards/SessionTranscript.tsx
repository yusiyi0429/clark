"use client";

/**
 * 子会话的对话（本机实时，原型 v8.4 cardChat）。本人说的靠右；执行方说的是浅灰气泡，带名字；
 * 过程（28 条，照 Claude Code）：两句对话之间的步骤、批过的权限合成一行，收着写总结（运行 N 条命令 · 读 N 个文件 · … · 用时），正在跑时是转圈加当前那一步，点开一步一行、不写时间；
 * 要权限是选项框（批准 / 同类以后都批准 / 换个做法），几件一起等着时合成一个框翻页，放在第一件的位置，批完就消失：批准的不留行，换了做法的在那一步行尾写「换个做法」；
 * 答过的问题收成一行（勾 · 问题 · 答案），不另起「问：」「答：」两行，AskUserQuestion 那一步不画；没答就过去了的（被新的取代、作废、子会话停了）收成「已失效」。
 * 交回、产出、提醒各一行。
 * 本人那句话的回执（17.4，样子同伙伴台）：一个勾已送达、两个勾已读；没读到就没了写「没读到 · 重发」。本机补发的话没有回执。
 * canAct=false（手机、别的电脑、本机没连）时选项框不给选项，头上写「等你 · {电脑名}」。
 */
import { useEffect, useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { questionNotice, type SessionEntry } from "@/lib/local/sessionView";
import type { LocalRunner, TLocalModelProfile, TLocalSessionSummary, TLocalPermissionRequestView, TLocalQuestionRequestView, TLocalSessionStatus } from "@/lib/local/runner";
import { duration } from "@/lib/home/derive";
import { InputBar } from "@/components/home/InputBar";
import { FolderText, FootText, SessionModelMenu } from "@/components/home/InputFooter";
import { sizeText, uploadToSubSession } from "@/lib/home/attachments";
import type { TLocalAttachmentRef, TLocalEffort, TLocalPermissionMode, TLocalSessionModelRequest, TSessionAttachment } from "@warmap/contracts";
import { PermissionModeMenu } from "./PermissionMode";
import { ApprovalDecision, DENY_MAX, awayChip } from "@/components/work/decisions";
import { DecisionBox, FailedLine } from "@/components/work/DecisionBox";
import { HeroButton } from "@/components/HeroButton";
import { ICON, StateIcon, type IconState } from "@/components/home/StateIcon";
import { ReceiptFailed, ReceiptTicks } from "@/conversation/Transcript";
import h from "@/styles/home.module.css";
import s from "@/styles/v2-session.module.css";

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export type DecideOptions = { forSession?: boolean; message?: string };

type Step = Extract<SessionEntry, { kind: "step" }>;
type Permission = Extract<SessionEntry, { kind: "permission" }>;
/** 一次提问折成一项：答了是答案，没答就过去了是 expired。 */
type Asked = { kind: "asked"; seq: number; question: string; answer: string | null };
/** 过程里的一行：一步；denied = 本人让它换了做法（批准时选的「换个做法」）；note = 过程里的一句提示（换了模型），不算步数。 */
type ProcessRow = { step: Step; denied: boolean; note?: boolean };
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
    if (match) match.denied = true;
    else rows.push({ step: { kind: "step", seq: permission.seq, at: permission.at, toolUseId: permission.request.requestId, title: permission.request.title, done: true, isError: false }, denied: true });
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
 * 「在跑」那一行（27 条，照 Claude Code 底部那行）：模型在两步之间想的时候界面也在动——转圈加这一轮跑了多久（每秒走一下）。
 * 只在会话在跑、最后不是一段过程、也没在等你批准或回答时出；最后那段过程在转圈时不重复出。不写解释句。
 */
function WorkingRow({ since }: { since: string | null }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return (
    <div className={s.step} data-testid="session-working">
      <StateIcon state="running" label="在跑" />
      {since ? <span className={`${s.stepText} ${h.num}`}>{duration(since, now)}</span> : null}
    </div>
  );
}

/** 点开后的一步一行：不写时间；换了做法的行尾一个淡色「换个做法」。 */
function StepRow({ row, live }: { row: ProcessRow; live: boolean }) {
  return (
    <div className={s.step}>
      <StateIcon state={row.denied ? "stopped" : stepState(row.step, live)} />
      <span className={s.stepText}>{row.step.title}</span>
      {row.denied ? <span className={s.stepsTook}>换个做法</span> : null}
    </div>
  );
}

/**
 * 一段过程一行（28 条，照 Claude Code）：收着时写总结和这一段的用时，点开一步一行。
 * running（会话在跑、这一段在最后）：转圈加当前那一步的标题；做完了收成总结。
 */
function ProcessGroup({ process, live, running }: { process: Process; live: boolean; running: boolean }) {
  const [open, setOpen] = useState(false);
  const counted = process.rows.filter((row) => !row.note);
  const summary = counted.length ? processSummary(counted.map((row) => row.step.title)) : process.rows.map((row) => row.step.title).join(" · ");
  const current = [...process.rows].reverse().find((row) => !row.denied && !row.step.done) ?? process.rows[process.rows.length - 1]!;
  const took = !running && Date.parse(process.end) - Date.parse(process.start) >= 1000 ? duration(process.start, process.end) : null;
  const said = running ? current.step.title : [summary, took].filter(Boolean).join(" · ");
  return (
    <div className={s.steps} data-open={open ? "" : undefined}>
      <button type="button" className={s.stepsHead} aria-expanded={open} aria-label={`${said}，${open ? "收起" : "展开"}`} onClick={() => setOpen(!open)}>
        {running ? <StateIcon state="running" /> : <ChevronRight {...ICON} className={h.chevron} data-open={open ? "" : undefined} />}
        <span className={s.stepsSummary}>{running ? current.step.title : summary}</span>
        {took ? <span className={s.stepsTook}>{took}</span> : null}
      </button>
      <div className={s.stepsBody} inert={!open}>
        <div>{process.rows.map((row) => <StepRow key={row.step.seq} row={row} live={live} />)}</div>
      </div>
    </div>
  );
}

const noop = () => undefined;

/** 会话结束了（退出、失败、交完收工）：还挂着的提问、批准都算失效。 */
export const sessionEnded = (status: TLocalSessionStatus | null) => status === "exited" || status === "failed" || status === "done";

/**
 * 子会话底下的输入框发一句话（5.4.3「和底部输入框的关系」）：有没批的批准时，这句话 = 「换个做法：{这句话}」，批准框收起；
 * 超过「换个做法」的上限时批准那边只记换个做法，整句照常插话。没有要批的就是插话。
 */
export async function sayToSession(runner: LocalRunner, sessionId: string, pending: TLocalPermissionRequestView[], text: string, attachments: TLocalAttachmentRef[] = []): Promise<boolean> {
  const waiting = pending[0];
  if (!waiting) { await runner.sendMessage(sessionId, text, undefined, attachments); return true; }
  // 带了附件的，批准那边只记换个做法，整句（连附件）照常插话。
  const fits = text.length <= DENY_MAX && !attachments.length;
  await runner.decidePermission(sessionId, waiting.requestId, { decision: "deny", ...(fits && text ? { message: text } : {}) });
  if (!fits) await runner.sendMessage(sessionId, text, undefined, attachments);
  return true;
}

/** 子会话页里转给 Task 管线去答的那一处（14.3）：一行问题原话，加「去回答」（次按钮），点了跳到 Task 管线那个框。 */
export function RelayLine({ text, onGo }: { text: string; onGo: () => void }) {
  return <p className={s.relay} data-testid="relay-line"><span>{text}</span><HeroButton variant="tertiary" size="sm" onPress={onGo}>去回答</HeroButton></p>;
}

type UserEntry = Extract<SessionEntry, { kind: "user" }>;

export function SessionTranscript({ entries, agentName, canAct, device, onDecide, lead, tail, asking, live, ended = false, relay, onResend }: {
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
  /** 还没答的那次提问：它的「问：…」一行不画，选项框就是它。 */
  asking?: TLocalQuestionRequestView | null;
  /** 会话还在跑（running(view.status)）：没做完的步骤转圈；结束了的没做完的步骤画方块。 */
  live: boolean;
  /** 会话已经结束（退出、失败、交完收工）：没批的权限收成「已失效」。 */
  ended?: boolean;
  /** 提问、批准由 Task 管线转达（新首页 14.3）：这里不画选项框，只一行原话加「去回答」。 */
  relay?: (() => void) | null;
  /** 没读到的那句再发一遍（只发原话；这里答不了时不给）。 */
  onResend?: (entry: UserEntry) => void;
}) {
  const pending = ended ? [] : entries.flatMap((entry) => (entry.kind === "permission" && !entry.decision ? [entry.request] : []));
  const firstPending = pending[0]?.requestId;
  const askingText = asking ? questionNotice(asking) : null;
  const lastAsk = askingText ? entries.map((entry) => entry.kind === "notice" && entry.text === askingText).lastIndexOf(true) : -1;
  const items = groupEntries(entries.filter((_, index) => index !== lastAsk));
  // 在跑、没在等你：最后一段过程就是正在做的（转圈加当前那一步）；最后不是过程（刚说完、在想）时出「在跑」那一行。
  const busy = live && !pending.length && !asking;
  const tailProcess = items[items.length - 1]?.kind === "process";
  return (
    <div className={s.feed}>
      {lead ? <span className={s.evt}>{lead}</span> : null}
      {items.map((entry, index) => {
        switch (entry.kind) {
          case "user": return [
            <div key={entry.seq} className={s.me}>
              {entry.attachments?.length ? (
                <ul className={h.bubbleAtts} aria-label="附件">
                  {entry.attachments.map((file, index) => (
                    <li key={`${index}:${file.name}`} className={h.att}><span className={h.attName}><b title={file.name}>{file.name}</b><span className={h.num}>{sizeText(file.size)}</span></span></li>
                  ))}
                </ul>
              ) : null}
              {entry.text}
            </div>,
            entry.receipt === "failed" ? <ReceiptFailed key={`${entry.seq}:receipt`} className={s.meReceipt} label="没读到" onResend={canAct && entry.text ? () => onResend?.(entry) : undefined} />
              : entry.receipt ? <ReceiptTicks key={`${entry.seq}:receipt`} className={s.meReceipt} state={entry.receipt} /> : null,
          ];
          case "assistant": return <div key={entry.seq} className={s.bubble}><small className={s.who}>{agentName}</small><p>{entry.text}</p></div>;
          case "process": return <ProcessGroup key={entry.seq} process={entry} live={live} running={busy && index === items.length - 1} />;
          case "asked": return <DecisionBox key={entry.seq} kind="question" title={entry.question} options={[]} onPick={noop} resolved={entry.answer ?? undefined} expired={entry.answer === null} />;
          case "permission":
            if (ended) return <DecisionBox key={entry.seq} kind="approval" title={entry.request.title} options={[]} onPick={noop} expired />;
            if (entry.request.requestId !== firstPending) return null;
            return relay ? <RelayLine key={entry.seq} text={entry.request.title} onGo={relay} /> : <ApprovalDecision key={entry.seq} requests={pending} blocked={canAct ? null : awayChip(device)} onDecide={onDecide} />;
          case "artifact": return <div key={entry.seq} className={s.step}><StateIcon state="done" /><span className={s.stepText}>交出 {entry.fileName}</span><time>{hhmm(entry.at)}</time></div>;
          case "handback": return <span key={entry.seq} className={s.evt}>{hhmm(entry.at)} · 交回：{entry.summary}（{entry.met}/{entry.total} 条自评达到）</span>;
          case "notice": return <span key={entry.seq} className={s.evt} data-level={entry.level}>{entry.text}</span>;
        }
      })}
      {busy && !tailProcess ? <WorkingRow since={roundStart(entries)} /> : null}
      {tail}
    </div>
  );
}

/**
 * 子会话底下的输入框（5.4.3「输入框」、14.5）：和首页、管线一样是 InputBar，不放占位字（空着就是一行），读屏名字「给{子会话名}插话」。发给执行方（进行中在下一个工具步骤生效）。
 * 附件先存到云端（POST /api/me/sub-sessions/:kind/:id/attachments），这句话带着引用交给本机，本机取回存进工作区；只带附件不说话也行。
 * dock：「N 个问题等你 / 回到最新」那一条（PendingDock），放在输入框上方。
 * 输入框下面一行（同首页、项目对话）：左边在哪个文件夹里跑（place，悬停出完整路径），右边模型（model，悬停出 title）和权限档（mode，useSessionMode；还没开工时不给）。
 */
/**
 * 子会话能换的模型和思考程度（32、36 条）：同一个执行方的模型；思考程度只列现在这个模型支持的几档。
 * 选了交给本机（PUT /v1/sessions/:id/model），换好或记下「这一轮做完后换」后重读摘要，没成 onFail。
 */
export function sessionModels(runner: LocalRunner, models: readonly TLocalModelProfile[], session: TLocalSessionSummary | null | undefined, refresh: () => unknown, onFail: () => void) {
  if (!session) return null;
  const change = (body: TLocalSessionModelRequest) => void runner.setSessionModel(session.id, body).then(() => refresh(), onFail);
  const value = session.pendingModel?.modelProfileId ?? session.modelProfileId;
  return {
    list: models.filter((model) => model.agent === session.agent),
    value,
    onPick: (id: string) => change({ modelProfileId: id }),
    efforts: models.find((model) => model.id === value)?.efforts ?? [],
    effort: (session.pendingModel ? session.pendingModel.effort : session.effort) ?? null,
    onEffort: (effort: TLocalEffort | null) => change({ effort }),
  };
}

/** 本机报了换好模型（notice model_changed）就马上重读摘要：下面那一行从「当前 → 新」回到新模型，不等 10 秒一次的刷新。 */
export function useModelChangedRefresh(entries: SessionEntry[], refresh: () => unknown) {
  const changed = [...entries].reverse().find((entry) => entry.kind === "notice" && entry.code === "model_changed")?.seq ?? null;
  useEffect(() => { if (changed !== null) void refresh(); }, [changed, refresh]);
}

export function SessionComposer({ label, disabled, onSend, dock, subject, mode, place, model, models, busy = false, onStop }: {
  label: string; disabled: boolean; onSend: (text: string, attachments: TLocalAttachmentRef[]) => Promise<boolean>; dock?: ReactNode;
  subject: TSessionAttachment["subject"];
  mode?: { modes: readonly TLocalPermissionMode[]; value: TLocalPermissionMode; set: (mode: TLocalPermissionMode) => void } | null;
  place?: { name: string; title: string } | null;
  model?: { label: string; title?: string } | null;
  /** 能换的模型（32 条，这台电脑上跑着的子会话才给）：右边的模型成下拉，选了 onPick。 */
  models?: ReturnType<typeof sessionModels>;
  /** 会话在跑（27 条）：右边没字时是停止方块（onStop，本机 interrupt），有字时照样能发（插话），同项目对话、伙伴台。 */
  busy?: boolean;
  onStop?: () => void;
}) {
  return (
    <div className={s.composerDock}>
      <InputBar placeholder="" label={label} disabled={disabled} dock={dock} busy={busy} interruptible onStop={onStop} draftKey={`tianshu-home-draft-v1:${subject.kind}:${subject.id}`}
        footer={{
          left: place ? <FolderText name={place.name} title={place.title} /> : null,
          right: <>{model && models && !disabled ? <SessionModelMenu label={model.label} title={model.title} models={models.list} value={models.value} onPick={models.onPick} efforts={models.efforts} effort={models.effort} onEffort={models.onEffort} />
            : model ? <FootText title={model.title} testId="session-model">{model.label}</FootText> : null}{mode ? <PermissionModeMenu modes={mode.modes} value={mode.value} disabled={disabled} onChange={mode.set} /> : null}</>,
        }}
        onSend={async (text, files) => onSend(text, files.length ? await uploadToSubSession(subject, files) : [])} />
    </div>
  );
}
