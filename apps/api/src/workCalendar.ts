/**
 * 公司工作日历（北京时间）：周一到周五上班，再叠加法定节假日与调休补班。
 * 日期一律是 YYYY-MM-DD 字符串，内部按 UTC 做日历运算，不受本机时区影响。
 * 节假日表只覆盖 2026 年；表外的日期只按周末算。
 */

/**
 * 2026 年放假的每一天。
 * 来源：国务院办公厅《关于2026年部分节假日安排的通知》（国办发明电〔2025〕7号）
 * https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm
 */
export const HOLIDAYS_2026: readonly string[] = [
  // 元旦：1月1日（周四）至1月3日（周六）放假，共3天
  "2026-01-01", "2026-01-02", "2026-01-03",
  // 春节：2月15日（周日，农历腊月二十八）至2月23日（周一，农历正月初七）放假，共9天
  "2026-02-15", "2026-02-16", "2026-02-17", "2026-02-18", "2026-02-19", "2026-02-20", "2026-02-21", "2026-02-22", "2026-02-23",
  // 清明节：4月4日（周六）至4月6日（周一）放假，共3天
  "2026-04-04", "2026-04-05", "2026-04-06",
  // 劳动节：5月1日（周五）至5月5日（周二）放假，共5天
  "2026-05-01", "2026-05-02", "2026-05-03", "2026-05-04", "2026-05-05",
  // 端午节：6月19日（周五）至6月21日（周日）放假，共3天
  "2026-06-19", "2026-06-20", "2026-06-21",
  // 中秋节：9月25日（周五）至9月27日（周日）放假，共3天
  "2026-09-25", "2026-09-26", "2026-09-27",
  // 国庆节：10月1日（周四）至10月7日（周三）放假，共7天
  "2026-10-01", "2026-10-02", "2026-10-03", "2026-10-04", "2026-10-05", "2026-10-06", "2026-10-07",
];

/**
 * 2026 年调休上班的日子（同一通知）。
 * 元旦 1月4日（周日）；春节 2月14日（周六）、2月28日（周六）；劳动节 5月9日（周六）；国庆节 9月20日（周日）、10月10日（周六）。
 */
export const MAKEUP_2026: readonly string[] = [
  "2026-01-04",
  "2026-02-14", "2026-02-28",
  "2026-05-09",
  "2026-09-20", "2026-10-10",
];

const HOLIDAYS = new Set(HOLIDAYS_2026);
const MAKEUPS = new Set(MAKEUP_2026);
const DAY_MS = 86_400_000;

const toMs = (date: string) => Date.parse(`${date}T00:00:00Z`);
const toDate = (ms: number) => new Date(ms).toISOString().slice(0, 10);

/** 这一天要不要上班：放假不上，调休补班要上，其余看是不是周一到周五。 */
export function isWorkday(date: string): boolean {
  if (HOLIDAYS.has(date)) return false;
  if (MAKEUPS.has(date)) return true;
  const weekday = new Date(toMs(date)).getUTCDay();
  return weekday !== 0 && weekday !== 6;
}

/** 当月（YYYY-MM）每一天及是否工作日。 */
export function monthDays(period: string): { date: string; workday: boolean }[] {
  const start = toMs(`${period}-01`);
  const next = new Date(start);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const days: { date: string; workday: boolean }[] = [];
  for (let ms = start; ms < next.getTime(); ms += DAY_MS) {
    const date = toDate(ms);
    days.push({ date, workday: isWorkday(date) });
  }
  return days;
}

/** today 所在周的周一和周日（周一为一周之始）。 */
export function weekOf(today: string): { weekStart: string; weekEnd: string } {
  const ms = toMs(today);
  const sinceMonday = (new Date(ms).getUTCDay() + 6) % 7;
  const weekStart = ms - sinceMonday * DAY_MS;
  return { weekStart: toDate(weekStart), weekEnd: toDate(weekStart + 6 * DAY_MS) };
}
