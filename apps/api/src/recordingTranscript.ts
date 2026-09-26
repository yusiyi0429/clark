/**
 * 火山识别结果 → 会议记录候选的 turns（与妙记 Markdown 候选同一形状，走同一条说话人映射与确认路径）。
 *
 * 说话人编号**不用厂商给的号**：它可能从 0 起（屏幕上出现「说话人 0」），也可能不是数字（`speaker_2`）。
 * 按这份逐字稿里第一次开口的先后重新编号：谁先说话谁是「说话人 1」。（移植自概念版 `transcript.ts` 的 speakerLabel）
 *
 * 连续同一个人的句子并成一段 turn：候选 turns 就是存下来的会议记录正文，形状对齐妙记的「一人一段」，
 * 也让一小时一两千句的识别结果落在 2000 段上限之内；单段超过正文上限时另起一段。
 */
import { MAX_TRANSCRIPT_TURNS, MAX_TURN_TEXT_LENGTH, type ParsedTranscriptTurn } from "./transcriptMarkdown.js";
import type { RecordingSpeaker, RecordingUtterance } from "./volcAsr.js";

/** 按 idx 排（idx 是厂商返回次序），第一次开口的先后决定编号；只挂在 speakers 里没开口的排在最后。 */
function speakerOrder(utterances: RecordingUtterance[], speakers: RecordingSpeaker[]): Map<string, number> {
  const order = new Map<string, number>();
  for (const u of [...utterances].sort((a, b) => a.idx - b.idx)) if (!order.has(u.speakerId)) order.set(u.speakerId, order.size + 1);
  for (const s of speakers) if (!order.has(s.speakerId)) order.set(s.speakerId, order.size + 1);
  return order;
}

/** 展示名：已定死的名字优先（「未标注」），否则「说话人 N」。 */
export function speakerLabels(utterances: RecordingUtterance[], speakers: RecordingSpeaker[]): Map<string, string> {
  const order = speakerOrder(utterances, speakers);
  const labels = new Map<string, string>();
  for (const [speakerId, n] of order) {
    const named = speakers.find((s) => s.speakerId === speakerId)?.displayName;
    labels.set(speakerId, named || `说话人 ${n}`);
  }
  return labels;
}

/**
 * 句子 → turns。offsetSeconds 相对录音开始，向下取整到秒且保证不回退（确认时会校验发言顺序）。
 * 合并后仍超过 2000 段则整份拒绝，不保存部分结果。
 */
export function utterancesToTurns(utterances: RecordingUtterance[], speakers: RecordingSpeaker[]): ParsedTranscriptTurn[] {
  const labels = speakerLabels(utterances, speakers);
  const turns: ParsedTranscriptTurn[] = [];
  let lastOffset = 0;
  for (const u of [...utterances].sort((a, b) => a.idx - b.idx)) {
    const speakerName = labels.get(u.speakerId)!;
    const offsetSeconds = Math.max(lastOffset, Math.floor(Math.max(0, u.startMs) / 1000));
    lastOffset = offsetSeconds;
    const prev = turns[turns.length - 1];
    if (prev && prev.speakerName === speakerName && prev.text.length + u.text.length <= MAX_TURN_TEXT_LENGTH) {
      prev.text += u.text;
      continue;
    }
    turns.push({ speakerName, offsetSeconds, text: u.text });
  }
  if (turns.length > MAX_TRANSCRIPT_TURNS) {
    throw new Error(`识别结果合并后有 ${turns.length} 段发言，超过会议记录 ${MAX_TRANSCRIPT_TURNS} 段的上限。`);
  }
  return turns;
}

/** 候选的 fileName：`会议录音 9月26日 15:02.mp3`，按公司时区（Asia/Shanghai）显示录音开始时刻。 */
export function recordingFileName(startedAt: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", month: "numeric", day: "numeric", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
      .formatToParts(startedAt)
      .map((part) => [part.type, part.value]),
  );
  return `会议录音 ${parts.month}月${parts.day}日 ${parts.hour}:${parts.minute}.mp3`;
}
