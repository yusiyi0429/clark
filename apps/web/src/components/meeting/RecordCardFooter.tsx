"use client";

import { useEffect, useRef, useState } from "react";
import type { TMeetingCardConfirmation } from "@warmap/contracts";
import { DateTimePicker } from "@/components/ui/DatePicker";
import { monthDayTime } from "@/lib/companyTime";
import type { SyncRow } from "./meetingCardModel";
import type { ActionError, ConfirmInput } from "./useMeetingCard";
import c from "./meeting-card.module.css";

export type FooterMode = "first" | "confirmed" | "editing" | "readonly";
const KINDS = [["correction", "更正原记录"], ["followup", "会后新决定"]] as const;

type RecordCardFooterProps = {
  mode: FooterMode;
  confirmation: TMeetingCardConfirmation | null;
  /** 同步状态（会议事件、每条对象修改）。 */
  rows: SyncRow[];
  busy: boolean;
  /** 草稿已存好、内容齐全、实际时间有效：可以确认。 */
  ready: boolean;
  /** 草稿有挂点对象（写进本体时至少要一个）。 */
  anchored: boolean;
  /** 还没填实际时间：按钮旁边的时间输入框。 */
  time: { value: string; max: string; invalid: boolean; onChange: (value: string) => void } | null;
  /** 「不写进本体」默认开不开（修改时沿用上一版的选择）。 */
  skipWorld: boolean;
  error: ActionError | null;
  /** 刚确认完：焦点放到「已确认」这一行。 */
  focusLine?: boolean;
  onConfirm?: (input: ConfirmInput) => void;
  onModify?: () => void;
  onDiscard?: () => void;
  /** 只给能编辑的人（会议事件写入失败时的「重试」）。 */
  onRetry?: () => void;
};

/**
 * 会议卡底部：同步状态逐行（会议事件、每条对象修改），下面是这一刻能做的事——
 * 待确认：「不写进本体」开关 +「确认这份记录」；已确认：「已确认 · v<版本> · <时间>」+「修改」；
 * 修改中：「更正原记录／会后新决定」（不预选，没选不能确认）、原因、「放弃修改」「确认修改」。
 * 写进本体却没有挂点对象时开关旁标「未挂对象」，确认按钮不可点。
 */
export function RecordCardFooter(props: RecordCardFooterProps) {
  const { mode, confirmation, rows, busy, ready, anchored, time, skipWorld: skipDefault, error, focusLine, onConfirm, onModify, onDiscard, onRetry } = props;
  const [skipWorld, setSkipWorld] = useState(skipDefault);
  const [kind, setKind] = useState<ConfirmInput["kind"] | null>(null);
  const [reason, setReason] = useState("");
  const lineRef = useRef<HTMLSpanElement>(null);
  useEffect(() => { if (focusLine) lineRef.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const confirmedLine = confirmation ? `已确认 · v${confirmation.revision} · ${monthDayTime(confirmation.confirmedAt)}` : null;
  const noAnchor = !anchored && !skipWorld;
  const canConfirm = ready && !busy && !noAnchor;
  const worldSwitch = (
    <span className={c.worldChoice}>
      <label className={c.toggle}>
        <button type="button" role="switch" aria-checked={skipWorld} className={c.switch} disabled={busy} onClick={() => setSkipWorld((value) => !value)}>
          <span aria-hidden="true" />
        </button>
        <span>不写进本体</span>
      </label>
      {noAnchor ? <span className={c.flag} data-tone="warn">未挂对象</span> : null}
    </span>
  );
  const errorFlag = error ? <span className={c.flag} data-tone="fail" role="alert">{error}</span> : null;
  if (mode === "readonly" && !confirmedLine && !rows.length) return null;

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
      {mode === "first" ? (
        <div className={c.actions}>
          {worldSwitch}
          <span className={c.spacer} />
          {errorFlag}
          {time ? (
            <span className={c.timeField} data-invalid={time.invalid ? "" : undefined}>
              <DateTimePicker label="实际" size="compact" value={time.value} max={time.max} disabled={busy} onChange={time.onChange} />
            </span>
          ) : null}
          <button type="button" className={c.primary} disabled={!canConfirm} onClick={() => onConfirm?.({ writeToWorld: !skipWorld })}>确认这份记录</button>
        </div>
      ) : mode === "editing" ? (
        <>
          <div className={c.kinds} role="radiogroup" aria-label="修改原因">
            {KINDS.map(([value, label]) => (
              <label key={value} className={c.kind}>
                <input type="radio" name="meeting-card-kind" value={value} checked={kind === value} disabled={busy} onChange={() => setKind(value)} />
                <span>{label}</span>
              </label>
            ))}
          </div>
          <input className={c.reason} aria-label="原因" placeholder="原因" maxLength={200} value={reason} disabled={busy} onChange={(event) => setReason(event.target.value)} />
          <div className={c.actions}>
            {worldSwitch}
            <span className={c.spacer} />
            {errorFlag}
            <button type="button" className={c.ghost} disabled={busy} onClick={onDiscard}>放弃修改</button>
            <button type="button" className={c.primary} disabled={!canConfirm || !kind}
              onClick={() => onConfirm?.({ writeToWorld: !skipWorld, kind: kind ?? undefined, reason })}>确认修改</button>
          </div>
        </>
      ) : confirmedLine ? (
        <div className={c.actions}>
          <span ref={lineRef} tabIndex={-1} className={c.confirmed}>{confirmedLine}</span>
          <span className={c.spacer} />
          {errorFlag}
          {mode === "confirmed" ? <button type="button" className={c.ghost} disabled={busy} onClick={onModify}>修改</button> : null}
        </div>
      ) : null}
    </footer>
  );
}
