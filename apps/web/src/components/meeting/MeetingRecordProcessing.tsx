"use client";

/**
 * 记录交上去以后，这一行原地显示走到哪一步：读取妙记 → 生成会议卡（走用时），没生成出来写明。
 * 整行的流光和呼吸点见 meeting-record-drop.module.css 的 .processing；生成好了这一行转到「会议记录」待确认。
 */
import { progressClock } from "./MeetingProgress";
import { CARD_EXPECTED_MS, useNow } from "./MeetingHeader";
import d from "@/styles/meeting-record-drop.module.css";

export type RecordProcessing = { since: string | null; failed: boolean };

export function RecordProcessingMeta({ processing, label = "生成会议卡", expectedMs = CARD_EXPECTED_MS }: { processing: RecordProcessing; label?: string; expectedMs?: number | null }) {
  const now = useNow(1000);
  // 用 em / b：所在卡片按 span、i 定了样式（网格、竖条），这里不能被套上。
  if (processing.failed) return <em className={d.failed}>会议卡没生成</em>;
  return <em className={d.phase}>
    <b className={d.pulse} aria-hidden />{label}
    {processing.since ? <time role="timer" dateTime={processing.since} suppressHydrationWarning>{progressClock(processing.since, now, expectedMs)}</time> : null}
  </em>;
}
