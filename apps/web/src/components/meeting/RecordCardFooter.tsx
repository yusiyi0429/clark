"use client";

import { useEffect, useRef, useState } from "react";
import type { TMeetingCardConfirmation, TMeetingDraftChange } from "@warmap/contracts";
import { DateTimePicker } from "@/components/ui/DatePicker";
import { monthDayTime } from "@/lib/companyTime";
import type { SyncRow } from "./meetingCardModel";
import type { ActionError, ConfirmInput } from "./useMeetingCard";
import c from "./meeting-card.module.css";

/** first：10/28 之前的会议卡待整卡确认；open：逐条确认的会议卡还没定版（只有「不写进本体」）。 */
export type FooterMode = "first" | "open" | "confirmed" | "editing" | "readonly";
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
  /** 会议写本体整个关掉了（会后链切到 Nexus 以后）：不出「不写进本体」开关，确认一律不写入。 */
  worldOff?: boolean;
  error: ActionError | null;
  /** 服务端给的草稿和确认版的差别：content 要选修改原因；items 只改了行动项（不出新版本，没有原因和本体开关）；none 没改（可以只改写不写本体）。 */
  change?: TMeetingDraftChange;
  /** 刚确认完：焦点放到「已确认」这一行。 */
  focusLine?: boolean;
  onConfirm?: (input: ConfirmInput) => void;
  onModify?: () => void;
  onDiscard?: () => void;
  /** 只给能编辑的人（会议事件写入失败时的「重试」）。 */
  onRetry?: () => void;
  /** open：「不写进本体」一点就存（定版时照它写不写）。 */
  onWorldChoice?: (writeToWorld: boolean) => void;
};

/**
 * 会议卡底部：同步状态逐行（会议事件、每条对象修改），下面是这一刻能做的事——
 * 待确认：「不写进本体」开关 +「确认这份记录」；已确认：「已确认 · v<版本> · <时间>」+「修改」；
 * 修改中：会议内容改了时「更正原记录／会后新决定」（不预选，没选不能确认）、原因；「放弃修改」「确认修改」。只改了行动项时没有原因和本体开关，直接「确认修改」。
 * 写进本体却没有挂点对象时开关旁标「未挂对象」，确认按钮不可点。
 */
export function RecordCardFooter(props: RecordCardFooterProps) {
  const { mode, confirmation, rows, busy, ready, anchored, time, worldOff = false, error, change = "none", focusLine, onConfirm, onModify, onDiscard, onRetry, onWorldChoice } = props;
  // 写本体关着时当作一直选了「不写进本体」。
  const skipDefault = worldOff || props.skipWorld;
  const [skipWorld, setSkipWorld] = useState(skipDefault);
  const [kind, setKind] = useState<ConfirmInput["kind"] | null>(null);
  const [reason, setReason] = useState("");
  const lineRef = useRef<HTMLSpanElement>(null);
  useEffect(() => { if (focusLine) lineRef.current?.focus(); }, []); // eslint-disable-line react-hooks/exhaustive-deps
  const confirmedLine = confirmation ? `已确认 · v${confirmation.revision} · ${monthDayTime(confirmation.confirmedAt)}` : null;
  // open：开关就是服务端存的选择，点了就存。
  const skipping = mode === "open" ? skipDefault : skipWorld;
  const noAnchor = !anchored && !skipping;
  const canConfirm = ready && !busy && !noAnchor;
  const worldSwitch = worldOff ? null : (
    <span className={c.worldChoice}>
      <label className={c.toggle}>
        <button type="button" role="switch" aria-checked={skipping} className={c.switch} disabled={busy}
          onClick={() => (mode === "open" ? onWorldChoice?.(skipping) : setSkipWorld((value) => !value))}>
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
      ) : mode === "open" ? (
        <div className={c.actions}>
          {worldSwitch}
          <span className={c.spacer} />
          {errorFlag}
        </div>
      ) : mode === "editing" ? (
        <>
          {change === "content" ? (
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
            </>
          ) : null}
          <div className={c.actions}>
            {change !== "items" ? worldSwitch : null}
            <span className={c.spacer} />
            {errorFlag}
            <button type="button" className={c.ghost} disabled={busy} onClick={onDiscard}>放弃修改</button>
            {change === "items" ? (
              <button type="button" className={c.primary} disabled={!ready || busy} onClick={() => onConfirm?.({ writeToWorld: !skipDefault })}>确认修改</button>
            ) : (
              <button type="button" className={c.primary} disabled={!canConfirm || (change === "content" && !kind)}
                onClick={() => onConfirm?.({ writeToWorld: !skipWorld, kind: kind ?? undefined, reason })}>确认修改</button>
            )}
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
