import type { CSSProperties } from "react";
import { calendarDate, monthDayTime } from "@/lib/companyTime";

/** Mission 卡片里各块共用的小工具。 */
export type Navigate = (href: string, origin?: Element | null) => void;

/** 「10/28」：月、日都不补零，和时间轴上的写法一样。 */
export const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

/** 卡片角上的最近一次动静：今天的写「HH:MM」，更早的写「M/D」（公司时区）。 */
export const activityTime = (iso: string, today: string) => calendarDate(iso) === today ? monthDayTime(iso).slice(-5) : shortDate(calendarDate(iso));

/** 行内颜色变量 --c（Mission 的颜色）。 */
export const tone = (color: string) => ({ "--c": color }) as CSSProperties;
