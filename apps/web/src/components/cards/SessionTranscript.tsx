"use client";

/**
 * 子会话的对话（本机实时，原型 v8.4 cardChat）。本人说的靠右；执行方说的是浅灰气泡，带名字；
 * 工具调用行（设计 5.4.3）：连续的步骤折成一行（ChevronRight · N 步 · 最后一步 · 用时；正在跑时箭头换成转圈），点开一步一行；只有一步就直接是那一行；
 * 要权限是选项框（批准 / 同类以后都批准 / 换个做法），几件一起等着时合成一个框翻页，放在第一件的位置；
 * 批过的收成一行。交回、产出、提醒各一行。
 * canAct=false（手机、别的电脑、本机没连）时选项框灰着，写去哪儿批。
 */
import { useState } from "react";
import { ArrowUp, ChevronRight } from "lucide-react";
import { questionNotice, type SessionEntry } from "@/lib/local/sessionView";
import type { TLocalPermissionRequestView, TLocalQuestionRequestView } from "@/lib/local/runner";
import { duration } from "@/lib/home/derive";
import { ApprovalDecision } from "@/components/work/decisions";
import { DecisionBox, FailedLine } from "@/components/work/DecisionBox";
import { ICON, StateIcon, type IconState } from "@/components/home/StateIcon";
import h from "@/styles/home.module.css";
import s from "@/styles/v2-session.module.css";

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export type DecideOptions = { forSession?: boolean; message?: string };

type Step = Extract<SessionEntry, { kind: "step" }>;
type Item = Exclude<SessionEntry, Step> | { kind: "steps"; seq: number; steps: Step[] };

/** 连续的工具步骤并成一组；产出（artifact）是交付物，不并，单独一行。 */
function groupSteps(entries: SessionEntry[]): Item[] {
  const items: Item[] = [];
  for (const entry of entries) {
    const last = items[items.length - 1];
    if (entry.kind === "step" && last?.kind === "steps") last.steps.push(entry);
    else items.push(entry.kind === "step" ? { kind: "steps", seq: entry.seq, steps: [entry] } : entry);
  }
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

export function SessionTranscript({ entries, agentName, canAct, onDecide, lead, tail, asking, live }: {
  entries: SessionEntry[];
  agentName: string;
  canAct: boolean;
  onDecide: (request: TLocalPermissionRequestView, decision: "allow" | "deny", options: DecideOptions) => Promise<void>;
  /** 最上面一行（交代）。 */
  lead?: string;
  /** 接在最后的（执行方在问本人时的选项框）。 */
  tail?: React.ReactNode;
  /** 还没答的那次提问：它的「问：…」一行不画，选项框就是它。 */
  asking?: TLocalQuestionRequestView | null;
  /** 会话还在跑（running(view.status)）：没做完的步骤转圈；结束了的没做完的步骤画方块。 */
  live: boolean;
}) {
  const pending = entries.flatMap((entry) => (entry.kind === "permission" && !entry.decision ? [entry.request] : []));
  const firstPending = pending[0]?.requestId;
  const askingText = asking ? questionNotice(asking) : null;
  const lastAsk = askingText ? entries.map((entry) => entry.kind === "notice" && entry.text === askingText).lastIndexOf(true) : -1;
  return (
    <div className={s.feed}>
      {lead ? <span className={s.evt}>{lead}</span> : null}
      {groupSteps(entries.filter((_, index) => index !== lastAsk)).map((entry) => {
        switch (entry.kind) {
          case "user": return <div key={entry.seq} className={s.me}>{entry.text}</div>;
          case "assistant": return <div key={entry.seq} className={s.bubble}><small className={s.who}>{agentName}</small><p>{entry.text}</p></div>;
          case "steps": return entry.steps.length === 1 ? <StepRow key={entry.seq} step={entry.steps[0]!} live={live} /> : <StepGroup key={entry.seq} steps={entry.steps} live={live} />;
          case "permission":
            if (entry.decision) return <DecisionBox key={entry.seq} kind="approval" title={entry.request.title} options={[]} onPick={() => undefined} resolved={entry.decision === "allow" ? "已批准" : "已拒绝"} />;
            return entry.request.requestId === firstPending ? <ApprovalDecision key={entry.seq} requests={pending} blocked={canAct ? null : "到电脑上处理"} onDecide={onDecide} /> : null;
          case "artifact": return <div key={entry.seq} className={s.step}><StateIcon state="done" /><span className={s.stepText}>交出 {entry.fileName}</span><time>{hhmm(entry.at)}</time></div>;
          case "handback": return <span key={entry.seq} className={s.evt}>{hhmm(entry.at)} · 交回：{entry.summary}（{entry.met}/{entry.total} 条自评达到）</span>;
          case "notice": return <span key={entry.seq} className={s.evt} data-level={entry.level}>{entry.text}</span>;
        }
      })}
      {tail}
    </div>
  );
}

/** 子会话底下的输入条：发给执行方（进行中在下一个工具步骤生效）。 */
export function SessionComposer({ placeholder, disabled, onSend }: { placeholder: string; disabled: boolean; onSend: (text: string) => Promise<boolean> }) {
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  /** 没发出去：字放回框里，框里原处写「失败 · 重试」（原因在 title 里），不弹 toast。 */
  const [failed, setFailed] = useState<string | null>(null);
  const send = async () => {
    const value = text.trim();
    if (!value || busy || disabled) return;
    setBusy(true);
    setFailed(null);
    setText("");
    const ok = await onSend(value).catch((error: unknown) => { setFailed(error instanceof Error ? error.message : ""); return false; });
    if (!ok) setText(value);
    setBusy(false);
  };
  return (
    <form className={s.composer} onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <textarea rows={1} value={text} disabled={disabled} placeholder={placeholder} aria-label={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      {failed !== null && !busy ? <FailedLine inline reason={failed} onRetry={() => void send()} /> : null}
      <button type="submit" className={s.send} disabled={disabled || busy || !text.trim()} aria-label="发送"><ArrowUp size={15} aria-hidden /></button>
    </form>
  );
}
