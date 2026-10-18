/**
 * 工作日（北京时间，周一到周五；法定节假日与调休这一版不算）。
 * 会后确认用：散会当天提醒一次，下一个工作日上午再提醒一次；满一个工作日没确认由 Agent 代判。
 */
const OFFSET_MS = 8 * 60 * 60_000;
const DAY_MS = 24 * 60 * 60_000;

/** 北京时间的日期（UTC 零点表示）与星期几（0 = 周日）。 */
function shanghaiDay(at: Date): { day: number; weekday: number } {
  const local = at.getTime() + OFFSET_MS;
  const day = Math.floor(local / DAY_MS) * DAY_MS;
  return { day, weekday: new Date(day).getUTCDay() };
}
const isWorkday = (weekday: number) => weekday >= 1 && weekday <= 5;

/** 下一个工作日（不含当天）的北京时间 hh:mm。 */
export function nextWorkdayAt(at: Date, hour: number, minute: number): Date {
  let { day } = shanghaiDay(at);
  do day += DAY_MS; while (!isWorkday(new Date(day).getUTCDay()));
  return new Date(day + (hour * 60 + minute) * 60_000 - OFFSET_MS);
}

/** 满一个工作日：下一个工作日的同一时刻（周末开始的按周一同一时刻算）。 */
export function addWorkday(at: Date): Date {
  const { day } = shanghaiDay(at);
  const clock = at.getTime() + OFFSET_MS - day;
  let next = day;
  do next += DAY_MS; while (!isWorkday(new Date(next).getUTCDay()));
  return new Date(next + clock - OFFSET_MS);
}

/** 北京时间「10月20日 16:00」。 */
export function shanghaiLabel(at: Date): string {
  const local = new Date(at.getTime() + OFFSET_MS);
  return `${local.getUTCMonth() + 1}月${local.getUTCDate()}日 ${String(local.getUTCHours()).padStart(2, "0")}:${String(local.getUTCMinutes()).padStart(2, "0")}`;
}

/** 北京时间的 YYYY-MM-DD。 */
export function shanghaiDate(at: Date): string {
  return new Date(at.getTime() + OFFSET_MS).toISOString().slice(0, 10);
}
