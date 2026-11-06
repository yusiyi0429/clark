"use client";

/**
 * 子会话左边：和执行方的对话（本机实时，原型 v8.4 cardChat）。本人说的靠右；执行方说的是浅灰气泡，带名字；
 * 工具步骤一行一条（只写标题）；权限请求是一张小卡，带「批准」「这张卡都允许」「拒绝」；交回、产出、提醒各一行。
 * canAct=false（手机、别的电脑、本机没连）时权限请求只显示，不给按钮。
 */
import { useState } from "react";
import { ArrowUp, FileText } from "lucide-react";
import { HeroButton } from "@/components/HeroButton";
import type { SessionEntry } from "@/lib/local/sessionView";
import type { TLocalPermissionRequestView } from "@/lib/local/runner";
import s from "@/styles/v2-session.module.css";

const hhmm = (iso: string) => new Date(iso).toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23" });

export function SessionTranscript({ entries, agentName, canAct, onDecide, lead }: {
  entries: SessionEntry[];
  agentName: string;
  canAct: boolean;
  onDecide: (request: TLocalPermissionRequestView, decision: "allow" | "deny", forSession: boolean) => Promise<void>;
  /** 最上面一行（交代）。 */
  lead?: string;
}) {
  return (
    <div className={s.feed}>
      {lead ? <span className={s.evt}>{lead}</span> : null}
      {entries.map((entry) => {
        switch (entry.kind) {
          case "user": return <div key={entry.seq} className={s.me}>{entry.text}</div>;
          case "assistant": return <div key={entry.seq} className={s.bubble}><small className={s.who}>{agentName}</small><p>{entry.text}</p></div>;
          case "step": return <div key={entry.seq} className={s.step} data-done={entry.done || undefined} data-error={entry.isError || undefined}><time>{hhmm(entry.at)}</time><span>{entry.title}</span></div>;
          case "permission": return <Permission key={entry.seq} entry={entry} agentName={agentName} canAct={canAct} onDecide={onDecide} />;
          case "artifact": return <div key={entry.seq} className={s.step} data-done><time>{hhmm(entry.at)}</time><span><FileText size={12} aria-hidden /> 交出 {entry.fileName}</span></div>;
          case "handback": return <span key={entry.seq} className={s.evt}>{hhmm(entry.at)} · 交回：{entry.summary}（{entry.met}/{entry.total} 条自评达到）</span>;
          case "notice": return <span key={entry.seq} className={s.evt} data-level={entry.level}>{entry.text}</span>;
        }
      })}
    </div>
  );
}

function Permission({ entry, agentName, canAct, onDecide }: { entry: Extract<SessionEntry, { kind: "permission" }>; agentName: string; canAct: boolean; onDecide: Parameters<typeof SessionTranscript>[0]["onDecide"] }) {
  const [busy, setBusy] = useState(false);
  const decide = async (decision: "allow" | "deny", forSession = false) => {
    setBusy(true);
    try { await onDecide(entry.request, decision, forSession); } finally { setBusy(false); }
  };
  // 越界（碰允许的文件夹以外的路径）：标红写明路径，只能允许这一次（ADR 0031）。
  const outside = entry.request.outsidePaths ?? [];
  return (
    <div className={s.permission} data-testid="permission-request" data-outside={outside.length ? true : undefined}>
      <small className={s.who}>{agentName} 要权限</small>
      <p>{entry.request.title}</p>
      {outside.length ? <ul className={s.outside} aria-label="越界的路径">{outside.map((path) => <li key={path}>越界：{path}</li>)}</ul> : null}
      {entry.decision ? <span className={s.decided} data-decision={entry.decision}>{entry.decision === "allow" ? "已批准" : "已拒绝"}</span>
        : canAct ? (
          <div className={s.actions}>
            <HeroButton variant="primary" size="sm" onPress={() => void decide("allow")} isDisabled={busy}>{outside.length ? "允许这一次" : "批准"}</HeroButton>
            {entry.request.canAllowForSession && !outside.length ? <HeroButton variant="secondary" size="sm" onPress={() => void decide("allow", true)} isDisabled={busy}>这张卡都允许</HeroButton> : null}
            <HeroButton variant="ghost" size="sm" onPress={() => void decide("deny")} isDisabled={busy}>拒绝</HeroButton>
          </div>
        ) : null}
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
