import { shanghaiDate } from "./workdays.js";

/**
 * 对话分段（首页 Chat 和天枢页面同一套规则，10/28 定）：上一次发言距现在满 12 小时，或上一次发言在北京时间今天凌晨 4 点之前，就换一段。
 * 模型每轮只带当前这一段，上一段靠会话目录里的纪要交接（conversationRecall.ts）；界面上还是一条连续的对话，段之间一行日期。
 */
export const SEGMENT_IDLE_MS = 12 * 60 * 60 * 1000;
const DAY_STARTS_AT_MS = 4 * 60 * 60 * 1000;

/** 对话日：北京时间凌晨 4 点换天。 */
const conversationDay = (at: Date) => shanghaiDate(new Date(at.getTime() - DAY_STARTS_AT_MS));

export function startsNewSegment(lastAt: Date, now: Date): boolean {
  return now.getTime() - lastAt.getTime() >= SEGMENT_IDLE_MS || conversationDay(lastAt) < conversationDay(now);
}

/** 按时间先后的几条消息里，当前这一段的那些（从最后一次换段起；只按普通问答判，转议题带来的消息跟着前后的问答走）。 */
export function currentSegmentOf<T extends { kind: string; created_at: Date }>(messages: T[]): T[] {
  let start = 0;
  let previous: Date | undefined;
  messages.forEach((message, index) => {
    if (message.kind !== "message") return;
    if (previous && startsNewSegment(previous, message.created_at)) start = index;
    previous = message.created_at;
  });
  return messages.slice(start);
}

/** 同一条规则的 SQL 写法：prev、at 是两次发言的时间列。 */
export const startsNewSegmentSql = (prev: string, at: string) =>
  `(${at} - ${prev} >= interval '12 hours' OR ((${prev} AT TIME ZONE 'Asia/Shanghai') - interval '4 hours')::date < ((${at} AT TIME ZONE 'Asia/Shanghai') - interval '4 hours')::date)`;

/** 段之间那一行日期（北京时间）：「10月28日」。 */
export function segmentDateLabel(at: Date): string {
  const [, month, day] = shanghaiDate(at).split("-");
  return `${Number(month)}月${Number(day)}日`;
}
