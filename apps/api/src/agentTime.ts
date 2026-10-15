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
