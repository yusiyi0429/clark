"use client";

import { useState } from "react";
import type { TMeetingCardConfirmation } from "@warmap/contracts";
import { DateTimePicker } from "@/components/ui/DatePicker";
import { monthDayTime } from "@/lib/companyTime";
import type { SyncRow } from "./meetingCardModel";
import type { ConfirmInput } from "./useMeetingCard";
import c from "./meeting-card.module.css";

export type FooterMode = "first" | "confirmed" | "editing" | "readonly";
const KINDS = [["correction", "更正原记录"], ["followup", "会后新决定"]] as const;

type RecordCardFooterProps = {
  mode: FooterMode;
  confirmation: TMeetingCardConfirmation | null;
  /** 同步状态（只给能编辑的人）。 */
  rows: SyncRow[];
  busy: boolean;
  /** 草稿已存好、内容齐全、有实际时间：可以确认。 */
  ready: boolean;
  /** 还没填实际时间：按钮旁边的时间输入框。 */
  time: { value: string; max: string; onChange: (value: string) => void } | null;
  /** 「不写进本体」默认开不开（修改时沿用上一版的选择）。 */
  skipWorld: boolean;
  error: string | null;
  onConfirm?: (input: ConfirmInput) => void;
  onModify?: () => void;
  onDiscard?: () => void;
  onRetry?: () => void;
};

/**
 * 会议卡底部：同步状态逐行（会议事件、每条对象修改），下面是这一刻能做的事——
 * 待确认：「不写进本体」开关 +「确认这份记录」；已确认：「已确认 · v<版本> · <时间>」+「修改」；
 * 修改中：「更正原记录／会后新决定」（不预选，没选不能确认）、原因、「放弃修改」「确认修改」。
 */
export function RecordCardFooter({ mode, confirmation, rows, busy, ready, time, skipWorld: skipDefault, error, onConfirm, onModify, onDiscard, onRetry }: RecordCardFooterProps) {
  const [skipWorld, setSkipWorld] = useState(skipDefault);
  const [kind, setKind] = useState<ConfirmInput["kind"] | null>(null);
  const [reason, setReason] = useState("");
  const confirmedLine = confirmation ? `已确认 · v${confirmation.revision} · ${monthDayTime(confirmation.confirmedAt)}` : null;
  const worldSwitch = (
    <label className={c.toggle}>
      <button type="button" role="switch" aria-checked={skipWorld} className={c.switch} disabled={busy} onClick={() => setSkipWorld((value) => !value)}>
        <span aria-hidden="true" />
      </button>
      <span>不写进本体</span>
    </label>
  );

  return (
    <footer className={c.footer}>
      {rows.length ? (
        <ul className={c.sync} aria-label="同步状态">
          {rows.map((row) => (
            <li key={row.key} data-tone={row.tone}>
              <span className={c.dot} aria-hidden="true" />
              <span>{row.text}</span>
              {row.retry && onRetry ? <button type="button" className={c.link} disabled={busy} onClick={onRetry}>重试</button> : null}
            </li>
          ))}
        </ul>
      ) : null}
      {error ? <p className={c.error} role="alert">{error}</p> : null}
      {mode === "first" ? (
        <div className={c.actions}>
          {worldSwitch}
          <span className={c.spacer} />
          {time ? <DateTimePicker label="实际" size="compact" className={c.timePicker} value={time.value} max={time.max} onChange={time.onChange} /> : null}
          <button type="button" className={c.primary} disabled={busy || !ready} onClick={() => onConfirm?.({ writeToWorld: !skipWorld })}>确认这份记录</button>
        </div>
      ) : mode === "editing" ? (
        <>
          <div className={c.kinds} role="radiogroup" aria-label="修改原因">
            {KINDS.map(([value, label]) => (
              <label key={value} className={c.kind}>
                <input type="radio" name="meeting-card-kind" value={value} checked={kind === value} onChange={() => setKind(value)} />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <input className={c.reason} aria-label="原因" placeholder="原因" maxLength={200} value={reason} onChange={(event) => setReason(event.target.value)} />
          <div className={c.actions}>
            {worldSwitch}
            <span className={c.spacer} />
            <button type="button" className={c.ghost} disabled={busy} onClick={onDiscard}>放弃修改</button>
            <button type="button" className={c.primary} disabled={busy || !ready || !kind}
              onClick={() => onConfirm?.({ writeToWorld: !skipWorld, kind: kind ?? undefined, reason })}>确认修改</button>
          </div>
        </>
      ) : confirmedLine ? (
        <div className={c.actions}>
          <span className={c.confirmed}>{confirmedLine}</span>
          <span className={c.spacer} />
          {mode === "confirmed" ? <button type="button" className={c.ghost} disabled={busy} onClick={onModify}>修改</button> : null}
        </div>
      ) : null}
    </footer>
  );
}
