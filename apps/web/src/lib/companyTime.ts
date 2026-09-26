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
