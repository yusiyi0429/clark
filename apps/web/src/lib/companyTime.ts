/** 公司时区（COMPANY_TIMEZONE）。时间只做展示格式化，不能直接截 ISO 字符串（那是 UTC）。 */
export const COMPANY_TIMEZONE = "Asia/Shanghai";

const valid = (iso: string | null | undefined): Date | null => {
  if (!iso) return null;
  const date = new Date(iso);
  return Number.isFinite(date.getTime()) ? date : null;
};

/** 「9/23 10:00」——与 clark 议题行上的会议时间同一格式。 */
export function monthDayTime(iso: string | null | undefined): string {
  const date = valid(iso);
  if (!date) return "";
  const day = date.toLocaleDateString("zh-CN", { month: "numeric", day: "numeric", timeZone: COMPANY_TIMEZONE });
  const time = date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: COMPANY_TIMEZONE });
  return `${day} ${time}`;
}

/** 信号的发布日期「2026/9/22」（公司时区）；没有日期时如实写「日期未提供」。 */
export const publishedDate = (value?: string | null) => {
  const date = valid(value);
  return date ? date.toLocaleDateString("zh-CN", { timeZone: COMPANY_TIMEZONE }) : "日期未提供";
};

/** 「2026-10-01」。纯日期字符串原样返回，带时间的按公司时区取日期。 */
export function calendarDate(value: string | null | undefined): string {
  if (!value) return "";
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = valid(value);
  return date ? date.toLocaleDateString("sv-SE", { timeZone: COMPANY_TIMEZONE }) : value;
}

/** 公司月「2026-09」：与 API 的 companyPeriod 同口径（按公司时区，不截 UTC 字符串）。 */
export function companyMonth(date: Date): string {
  return date.toLocaleDateString("sv-SE", { timeZone: COMPANY_TIMEZONE }).slice(0, 7);
}

const companyDay = (date: Date) => date.toLocaleDateString("sv-SE", { timeZone: COMPANY_TIMEZONE });
const clock = (date: Date) => date.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hourCycle: "h23", timeZone: COMPANY_TIMEZONE });

/** 封面卡片上那一行的时间：「今天 14:20」「昨天」「10 月 8 日」（不是今年的带年份）。 */
export function dayLabel(iso: string | null | undefined, now = new Date()): string {
  const date = valid(iso);
  if (!date) return "";
  const today = companyDay(now), day = companyDay(date);
  if (day === today) return `今天 ${clock(date)}`;
  if (day === companyDay(new Date(now.getTime() - 86_400_000))) return "昨天";
  const [year, month, dayOfMonth] = day.split("-").map(Number);
  return `${day.slice(0, 4) === today.slice(0, 4) ? "" : `${year} 年 `}${month} 月 ${dayOfMonth} 日`;
}

/** 「10 月 18 日 16:40」：验收记录上的时间。 */
export function monthDayClock(iso: string | null | undefined): string {
  const date = valid(iso);
  if (!date) return "";
  const [, month, dayOfMonth] = companyDay(date).split("-").map(Number);
  return `${month} 月 ${dayOfMonth} 日 ${clock(date)}`;
}

/** 某个时刻（公司时区的那一天）比截止日早几天：正数早、负数晚、0 按期。 */
export function daysBeforeDue(iso: string, dueDate: string): number | null {
  const date = valid(iso);
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(dueDate)) return null;
  return Math.round((Date.parse(`${dueDate}T00:00:00Z`) - Date.parse(`${companyDay(date)}T00:00:00Z`)) / 86_400_000);
}
