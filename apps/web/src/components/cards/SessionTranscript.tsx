"use client";

/**
 * 子会话的对话（本机实时，原型 v8.4 cardChat）。本人说的靠右；执行方说的是浅灰气泡，带名字；
 * 工具调用行（设计 5.4.3）：连续的步骤折成一行（ChevronRight · N 步 · 最后一步 · 用时；正在跑时箭头换成转圈），点开一步一行；只有一步就直接是那一行；
 * 要权限是选项框（批准 / 同类以后都批准 / 换个做法），几件一起等着时合成一个框翻页，放在第一件的位置；
 * 批过的、答过的收成一行（勾 · 问题 · 答案），不另起「问：」「答：」两行；没答就过去了的（被新的取代、作废、子会话停了）收成「已失效」。
 * 交回、产出、提醒各一行。
 * 本人那句话的回执（17.4，样子同伙伴台）：一个勾已送达、两个勾已读；没读到就没了写「没读到 · 重发」。本机补发的话没有回执。
 * canAct=false（手机、别的电脑、本机没连）时选项框不给选项，头上写「等你 · {电脑名}」。
 */
import { useState, type ReactNode } from "react";
import { ChevronRight } from "lucide-react";
import { questionNotice, type SessionEntry } from "@/lib/local/sessionView";
import type { LocalRunner, TLocalPermissionRequestView, TLocalQuestionRequestView, TLocalSessionStatus } from "@/lib/local/runner";
import { duration } from "@/lib/home/derive";
import { InputBar } from "@/components/home/InputBar";
import { FolderText, FootText } from "@/components/home/InputFooter";
import { sizeText, uploadToSubSession } from "@/lib/home/attachments";
import type { TLocalAttachmentRef, TLocalPermissionMode, TSessionAttachment } from "@warmap/contracts";
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
/** 一次提问折成一项：答了是答案，没答就过去了是 expired。 */
type Asked = { kind: "asked"; seq: number; question: string; answer: string | null };
type Item = Exclude<SessionEntry, Step> | { kind: "steps"; seq: number; steps: Step[] } | Asked;

/** sessionView 记的「问：…」「答：…」两行（questionNotice 和 question_resolved 写的）。 */
const ASK_PREFIX = "问：";
const ANSWER_PREFIX = "答：";
const noticeText = (entry: SessionEntry) => (entry.kind === "notice" ? entry.text : null);

/** 连续的工具步骤并成一组；产出（artifact）是交付物，不并，单独一行。「问：」和它后面的「答：」并成一项。 */
function groupSteps(entries: SessionEntry[]): Item[] {
  const items: Item[] = [];
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
    const last = items[items.length - 1];
    if (entry.kind === "step" && last?.kind === "steps") last.steps.push(entry);
    else items.push(entry.kind === "step" ? { kind: "steps", seq: entry.seq, steps: [entry] } : entry);
  });
  return items;
}

/** 没做完的那一步：会话还在跑就是进行中，不在跑了就是停在那儿了。 */
const stepState = (step: Step, live: boolean): IconState => step.isError ? "failed" : step.done ? "done" : live ? "running" : "stopped";

function StepRow({ step, live }: { step: Step; live: boolean }) {
  return <div className={s.step}><StateIcon state={stepState(step, live)} /><span className={s.stepText}>{step.title}</span><time>{hhmm(step.at)}</time></div>;
}

function StepGroup({ steps, live }: { steps: Step[]; live: boolean }) {
  const [open, setOpen] = useState(false);
  const first = steps[0]!;
  const last = steps[steps.length - 1]!;
  const took = Date.parse(last.at) - Date.parse(first.at) >= 1000 ? duration(first.at, last.at) : null;
  return (
    <div className={s.steps} data-open={open ? "" : undefined}>
      <button type="button" className={s.stepsHead} aria-expanded={open} onClick={() => setOpen(!open)}>
        {live && !last.done ? <StateIcon state="running" /> : <ChevronRight {...ICON} className={h.chevron} data-open={open ? "" : undefined} />}
        <span className={s.stepsCount}>{steps.length} 步</span>
        <span className={s.stepsSummary}>{last.title}</span>
        {took ? <span className={s.stepsTook}>{took}</span> : null}
      </button>
      <div className={s.stepsBody} inert={!open}>
        <div>{steps.map((step) => <StepRow key={step.seq} step={step} live={live} />)}</div>
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
  return (
    <div className={s.feed}>
      {lead ? <span className={s.evt}>{lead}</span> : null}
      {groupSteps(entries.filter((_, index) => index !== lastAsk)).map((entry) => {
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
          case "steps": return entry.steps.length === 1 ? <StepRow key={entry.seq} step={entry.steps[0]!} live={live} /> : <StepGroup key={entry.seq} steps={entry.steps} live={live} />;
          case "asked": return <DecisionBox key={entry.seq} kind="question" title={entry.question} options={[]} onPick={noop} resolved={entry.answer ?? undefined} expired={entry.answer === null} />;
          case "permission":
            if (entry.decision) return <DecisionBox key={entry.seq} kind="approval" title={entry.request.title} options={[]} onPick={noop} resolved={entry.decision === "allow" ? "已批准" : "换个做法"} />;
            if (ended) return <DecisionBox key={entry.seq} kind="approval" title={entry.request.title} options={[]} onPick={noop} expired />;
            if (entry.request.requestId !== firstPending) return null;
            return relay ? <RelayLine key={entry.seq} text={entry.request.title} onGo={relay} /> : <ApprovalDecision key={entry.seq} requests={pending} blocked={canAct ? null : awayChip(device)} onDecide={onDecide} />;
          case "artifact": return <div key={entry.seq} className={s.step}><StateIcon state="done" /><span className={s.stepText}>交出 {entry.fileName}</span><time>{hhmm(entry.at)}</time></div>;
          case "handback": return <span key={entry.seq} className={s.evt}>{hhmm(entry.at)} · 交回：{entry.summary}（{entry.met}/{entry.total} 条自评达到）</span>;
          case "notice": return <span key={entry.seq} className={s.evt} data-level={entry.level}>{entry.text}</span>;
        }
      })}
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
export function SessionComposer({ label, disabled, onSend, dock, subject, mode, place, model }: {
  label: string; disabled: boolean; onSend: (text: string, attachments: TLocalAttachmentRef[]) => Promise<boolean>; dock?: ReactNode;
  subject: TSessionAttachment["subject"];
  mode?: { modes: readonly TLocalPermissionMode[]; value: TLocalPermissionMode; set: (mode: TLocalPermissionMode) => void } | null;
  place?: { name: string; title: string } | null;
  model?: { label: string; title?: string } | null;
}) {
  return (
    <div className={s.composerDock}>
      <InputBar placeholder="" label={label} disabled={disabled} dock={dock} draftKey={`tianshu-home-draft-v1:${subject.kind}:${subject.id}`}
        footer={{
          left: place ? <FolderText name={place.name} title={place.title} /> : null,
          right: <>{model ? <FootText title={model.title} testId="session-model">{model.label}</FootText> : null}{mode ? <PermissionModeMenu modes={mode.modes} value={mode.value} disabled={disabled} onChange={mode.set} /> : null}</>,
        }}
        onSend={async (text, files) => onSend(text, files.length ? await uploadToSubSession(subject, files) : [])} />
    </div>
  );
}
