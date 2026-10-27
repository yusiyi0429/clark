/**
 * 给 Agent 看的只读工具结果里，时间一律换成北京时间文字。
 * 数据库与契约保存的是 UTC ISO 串（如 2026-10-09T08:20:00.000Z）；模型会把其中的 08:20 当成本地时间转述，
 * 于是 16:20 的群发言被说成“08:20”。这里只改交给模型的副本，不改存储与接口。
 */
const ISO_UTC = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,9})?)?Z$/;

export function beijingLabel(date: Date): string {
  const parts = Object.fromEntries(new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", hourCycle: "h23" })
    .formatToParts(date).map((part) => [part.type, part.value]));
  return `${parts.year}-${parts.month}-${parts.day} ${parts.hour}:${parts.minute}（北京时间）`;
}

const WEEKDAYS = ["周日", "周一", "周二", "周三", "周四", "周五", "周六"];
const DAY_MS = 24 * 60 * 60 * 1000;
/** 北京时间的那一天，用 UTC 字段承载，便于按天加减。 */
const beijingDay = (date: Date) => new Date(date.getTime() + 8 * 60 * 60 * 1000);
const dayLabel = (day: Date) => `${day.toISOString().slice(0, 10)} ${WEEKDAYS[day.getUTCDay()]}`;

/** 每轮告诉模型的「现在」：北京时间的此刻（含星期）、本周（周一到周日）和本月，「今天」「这周」「本月」都按它算。 */
export function nowContext(date: Date): { at: string; week: string; month: string } {
  const today = beijingDay(date);
  const monday = new Date(today.getTime() - ((today.getUTCDay() + 6) % 7) * DAY_MS);
  return {
    at: `${dayLabel(today)} ${today.toISOString().slice(11, 16)}（北京时间）`,
    week: `${dayLabel(monday)} 至 ${dayLabel(new Date(monday.getTime() + 6 * DAY_MS))}`,
    month: today.toISOString().slice(0, 7),
  };
}

export function withBeijingTimes<T>(value: T): T {
  if (typeof value === "string") {
    if (!ISO_UTC.test(value)) return value;
    const date = new Date(value);
    return (Number.isNaN(date.getTime()) ? value : beijingLabel(date)) as T;
  }
  if (Array.isArray(value)) return value.map((item) => withBeijingTimes(item)) as T;
  if (value && typeof value === "object" && !(value instanceof Date)) {
    return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, withBeijingTimes(item)])) as T;
  }
  if (value instanceof Date) return beijingLabel(value) as T;
  return value;
}
