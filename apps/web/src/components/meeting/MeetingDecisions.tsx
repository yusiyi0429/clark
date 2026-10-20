"use client";

/**
 * 会议页「会上定了」：分层后的几条（战略项给 CEO、其余给主持人），每条一句、带原话和状态。
 * 主持人在这里三选一：对 / 改一下 / 其实没定；已经办过的（包括 Agent 代判的）可以改判。
 * 头部一条是这场会在本体里挂到哪、会议记录写了没有；生效的每条下面是它落到的对象和写入状态（回流设计稿 3.1、3.2）。
 * 这些单独取（GET /api/meetings/:id/world，不进会议卡）：打开时取一次，办完一条后再取（影响卡在后台推，过几秒再取一次）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { TMeetingDecisionView, TMeetingDecisionVerdict, TMeetingDecisionWorld, TMeetingDecisionWorldItem, TMeetingWorldResponse } from "@warmap/contracts";
import { MEETING_DECISIONS_CHANGED, decisionStatusLabel, getMeetingWorld, reviewMeetingDecision } from "./meetingDecisionApi";
import { MeetingWorldBar } from "./MeetingWorldBar";
import { WorldAnchors, type AnchorTone } from "./WorldAnchors";
import s from "@/styles/meeting-workspace.module.css";
import d from "./meeting-decisions.module.css";

/** 没定的（主持人说其实没定、CEO 不同意、代判为没定）划掉。 */
const off = (decision: TMeetingDecisionView) =>
  decision.status === "not_decided" || decision.status === "rejected" || (decision.status === "agent_judged" && decision.recommendation === "not_decided");
const tone = (decision: TMeetingDecisionView) =>
  decision.status === "pending" ? "wait" : off(decision) ? "off" : decision.status === "agent_judged" ? "agent" : "done";
const ANCHOR_TONE: Record<TMeetingDecisionWorld, AnchorTone> = { waiting: "wait", committed: "ok", failed: "fail", off: "off" };

const RELOAD_AFTER_MS = 5_000;

export function MeetingDecisions({ decisions: initial, meetingId }: { decisions: TMeetingDecisionView[]; meetingId?: string }) {
  const [decisions, setDecisions] = useState(initial);
  useEffect(() => setDecisions(initial), [initial]);
  const [detail, setDetail] = useState<TMeetingWorldResponse | null>(null);
  const load = useCallback(() => {
    if (meetingId) void getMeetingWorld(meetingId).then(setDetail, () => undefined);
  }, [meetingId]);
  useEffect(() => { load(); }, [load]);
  // 办完一条：马上取一次，影响卡推完后再取一次。
  const reload = useCallback(() => { load(); window.setTimeout(load, RELOAD_AFTER_MS); }, [load]);
  // 通知栏上办完的也换到这里。
  useEffect(() => {
    const changed = (event: Event) => {
      const next = (event as CustomEvent<{ decision?: TMeetingDecisionView }>).detail?.decision;
      if (next) { setDecisions((current) => current.map((item) => (item.id === next.id ? next : item))); reload(); }
    };
    window.addEventListener(MEETING_DECISIONS_CHANGED, changed);
    return () => window.removeEventListener(MEETING_DECISIONS_CHANGED, changed);
  }, [reload]);
  const world = detail?.world;
  if (!decisions.length && !world) return null;
  const pending = decisions.filter((item) => item.status === "pending").length;
  return (
    <section className={s.reviewSection} data-outline="decisions" aria-labelledby="meeting-decisions">
      <header>
        <h3 id="meeting-decisions">会上定了</h3>
        <span className={s.count}>{pending ? `${pending} 条待确认` : `${decisions.length} 条`}</span>
      </header>
      {world && meetingId ? <MeetingWorldBar meetingId={meetingId} world={world} onChange={setDetail} /> : null}
      {decisions.length ? (
        <ol className={d.list}>
          {decisions.map((decision, index) => (
            <DecisionRow key={decision.id} number={index + 1} decision={decision} world={detail?.decisions.find((item) => item.id === decision.id)}
              excluded={world?.excluded ?? false} onChange={(next) => setDecisions((current) => current.map((item) => (item.id === next.id ? next : item)))} />
          ))}
        </ol>
      ) : null}
    </section>
  );
}

function DecisionRow({ number, decision, world, excluded, onChange }: {
  number: number; decision: TMeetingDecisionView; world?: TMeetingDecisionWorldItem; excluded: boolean; onChange: (next: TMeetingDecisionView) => void;
}) {
  const open = decision.status === "pending" || decision.status === "agent_judged";
  const [choosing, setChoosing] = useState(false);
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState(decision.statement);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const field = useRef<HTMLTextAreaElement>(null);
  useEffect(() => { if (editing) field.current?.focus(); }, [editing]);

  const review = async (verdict: TMeetingDecisionVerdict, statement?: string) => {
    setBusy(true); setError("");
    try {
      onChange(await reviewMeetingDecision(decision.meetingId, decision.id, verdict, statement));
      setEditing(false); setChoosing(false);
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  };
  const showChoices = decision.canReview && (open || choosing) && !editing;

  return (
    <li className={d.row} data-status={decision.status} data-off={off(decision) || undefined}>
      <span className={d.ordinal} aria-hidden="true">{number}</span>
      <div className={d.body}>
        <div className={d.head}>
          {decision.tier === "strategic" ? <span className={d.tier}>战略 · CEO</span> : null}
          <span className={d.status} data-tone={tone(decision)}>{decisionStatusLabel(decision)}</span>
          {decision.status === "pending" && decision.tier === "host" && decision.recommendation === "not_decided" ? <span className={d.hint}>Agent 判断没定</span> : null}
        </div>
        {editing ? (
          <div className={d.edit}>
            <textarea ref={field} aria-label="改成" rows={2} maxLength={300} value={text} disabled={busy} onChange={(event) => setText(event.target.value)} />
            <div className={d.actions}>
              <button type="button" className={d.ghost} disabled={busy} onClick={() => { setEditing(false); setText(decision.statement); }}>取消</button>
              <button type="button" className={d.primary} disabled={busy || !text.trim() || text.trim() === decision.statement} onClick={() => void review("edited", text.trim())}>保存</button>
            </div>
          </div>
        ) : (
          <p className={d.statement}>{decision.statement}</p>
        )}
        {decision.status === "edited" && !editing ? <p className={d.was}>原：{decision.originalStatement}</p> : null}
        {decision.quote ? <p className={d.quote}>「{decision.quote}」{decision.speakerName ? <span> — {decision.speakerName}</span> : null}</p> : null}
        {!editing && world ? <WorldAnchors anchors={world.anchors} tone={world.world ? ANCHOR_TONE[excluded ? "off" : world.world] : undefined} /> : null}
        {showChoices ? (
          <div className={d.actions}>
            <button type="button" className={d.primary} disabled={busy} onClick={() => void review("confirmed")}>对</button>
            <button type="button" className={d.ghost} disabled={busy} onClick={() => { setText(decision.statement); setEditing(true); }}>改一下</button>
            <button type="button" className={d.ghost} disabled={busy} onClick={() => void review("not_decided")}>其实没定</button>
          </div>
        ) : decision.canReview && !open && !editing ? (
          <div className={d.actions}><button type="button" className={d.link} onClick={() => setChoosing(true)}>改判</button></div>
        ) : null}
        {error ? <p className={s.error} role="alert">{error}</p> : null}
      </div>
    </li>
  );
}
