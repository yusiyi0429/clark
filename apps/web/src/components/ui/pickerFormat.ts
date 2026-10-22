import { COMPANY_TIMEZONE } from "@/lib/companyTime";

const WEEKDAY = "日一二三四五六";
const ISO_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;

/** 公司时区的今天「2026-10-12」。 */
export const companyToday = (now = new Date()) => now.toLocaleDateString("sv-SE", { timeZone: COMPANY_TIMEZONE });

/** 「10 月 15 日 周四」；不在今年才带年份「2027 年 1 月 4 日 周一」。值不是 YYYY-MM-DD 时返回空串。 */
export function dateLabel(iso: string | null | undefined, now = new Date()): string {
  const match = iso ? ISO_DAY.exec(iso) : null;
  if (!match) return "";
  const [, y, m, d] = match;
  const weekday = WEEKDAY[new Date(Date.UTC(Number(y), Number(m) - 1, Number(d))).getUTCDay()];
  const year = y === companyToday(now).slice(0, 4) ? "" : `${Number(y)} 年 `;
  return `${year}${Number(m)} 月 ${Number(d)} 日 周${weekday}`;
}

/** datetime-local 形状的值「2026-10-15T10:00」拆成日期与时刻；拆不开的部分是空串。 */
export function splitDateTime(value: string | null | undefined): { date: string; time: string } {
  const [date = "", time = ""] = (value ?? "").split("T");
  return { date: ISO_DAY.test(date) ? date : "", time: /^\d{2}:\d{2}/.test(time) ? time.slice(0, 5) : "" };
}

/** 「10 月 15 日 周四 10:00」。 */
export function dateTimeLabel(value: string | null | undefined, now = new Date()): string {
  const { date, time } = splitDateTime(value);
  const day = dateLabel(date, now);
  return day && time ? `${day} ${time}` : day;
}

/** 时刻选项：每 step 分钟一档（默认 15），给了 latest 时晚于它的不放；当前值不在档上也放进去，按时间排序。 */
export function timeOptions(current = "", step = 15, latest = ""): string[] {
  const slots: string[] = [];
  for (let minute = 0; minute < 24 * 60; minute += step) {
    const slot = `${String(Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}`;
    if (!latest || slot <= latest) slots.push(slot);
  }
  if (/^\d{2}:\d{2}$/.test(current) && !slots.includes(current)) slots.push(current);
  return slots.sort();
}
