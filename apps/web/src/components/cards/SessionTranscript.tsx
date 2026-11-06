"use client";

/**
 * 子会话的对话（本机实时，原型 v8.4 cardChat）。本人说的靠右；执行方说的是浅灰气泡，带名字；
 * 工具步骤一行一条（只写标题）；要权限是选项框（批准 / 同类以后都批准 / 换个做法），几件一起等着时合成一个框翻页，放在第一件的位置；
 * 批过的收成一行。交回、产出、提醒各一行。
 * canAct=false（手机、别的电脑、本机没连）时选项框灰着，写去哪儿批。
 */
import { useState } from "react";
import { ArrowUp, FileText } from "lucide-react";
import type { SessionEntry } from "@/lib/local/sessionView";
import type { TLocalPermissionRequestView } from "@/lib/local/runner";
import { ApprovalDecision } from "@/components/work/decisions";
import { DecisionBox } from "@/components/work/DecisionBox";
import s from "@/styles/v2-session.module.css";

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export type DecideOptions = { forSession?: boolean; message?: string };

export function SessionTranscript({ entries, agentName, canAct, onDecide, lead, tail }: {
  entries: SessionEntry[];
  agentName: string;
  canAct: boolean;
  onDecide: (request: TLocalPermissionRequestView, decision: "allow" | "deny", options: DecideOptions) => Promise<void>;
  /** 最上面一行（交代）。 */
  lead?: string;
  /** 接在最后的（执行方在问本人时的选项框）。 */
  tail?: React.ReactNode;
}) {
  const pending = entries.flatMap((entry) => (entry.kind === "permission" && !entry.decision ? [entry.request] : []));
  const firstPending = pending[0]?.requestId;
  return (
    <div className={s.feed}>
      {lead ? <span className={s.evt}>{lead}</span> : null}
      {entries.map((entry) => {
        switch (entry.kind) {
          case "user": return <div key={entry.seq} className={s.me}>{entry.text}</div>;
          case "assistant": return <div key={entry.seq} className={s.bubble}><small className={s.who}>{agentName}</small><p>{entry.text}</p></div>;
          case "step": return <div key={entry.seq} className={s.step} data-done={entry.done || undefined} data-error={entry.isError || undefined}><time>{hhmm(entry.at)}</time><span>{entry.title}</span></div>;
          case "permission":
            if (entry.decision) return <DecisionBox key={entry.seq} kind="approval" title={entry.request.title} options={[]} onPick={() => undefined} resolved={entry.decision === "allow" ? "已批准" : "已拒绝"} />;
            return entry.request.requestId === firstPending ? <ApprovalDecision key={entry.seq} requests={pending} blocked={canAct ? null : "到电脑上处理"} onDecide={onDecide} /> : null;
          case "artifact": return <div key={entry.seq} className={s.step} data-done><time>{hhmm(entry.at)}</time><span><FileText size={12} aria-hidden /> 交出 {entry.fileName}</span></div>;
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
  const send = async () => {
    const value = text.trim();
    if (!value || busy || disabled) return;
    setBusy(true);
    setText("");
    const ok = await onSend(value).catch(() => false);
    if (!ok) setText(value);
    setBusy(false);
  };
  return (
    <form className={s.composer} onSubmit={(event) => { event.preventDefault(); void send(); }}>
      <textarea rows={1} value={text} disabled={disabled} placeholder={placeholder} aria-label={placeholder}
        onChange={(event) => setText(event.target.value)}
        onKeyDown={(event) => { if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); void send(); } }} />
      <button type="submit" className={s.send} disabled={disabled || busy || !text.trim()} aria-label="发送"><ArrowUp size={15} aria-hidden /></button>
    </form>
  );
}
