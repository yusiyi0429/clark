import type { CSSProperties } from "react";
import type { THomePlanMissionWorld } from "@warmap/contracts";
import { calendarDate, monthDayTime } from "@/lib/companyTime";

/** Mission 卡片里各块共用的小工具。 */
export type Navigate = (href: string, origin?: Element | null) => void;

/** 「10/28」：月、日都不补零，和时间轴上的写法一样。 */
export const shortDate = (date: string) => `${Number(date.slice(5, 7))}/${Number(date.slice(8, 10))}`;

/** 卡片角上的最近一次动静：今天的写「HH:MM」，更早的写「M/D」（公司时区）。 */
export const activityTime = (iso: string, today: string) => calendarDate(iso) === today ? monthDayTime(iso).slice(-5) : shortDate(calendarDate(iso));

/** 本体里已经成立的状态：这几种不再标；其余（草稿、已承诺等）在名字旁标本体给的中文名。 */
const ESTABLISHED = new Set(["confirmed", "closed"]);
export const worldPending = (world: THomePlanMissionWorld | null): string | null => world && !ESTABLISHED.has(world.status) ? world.label : null;

/** 详情页头的一行：「草稿 · 本体 v5 · 10/25 读 · 缺 Task 全景、时间边界」；不是从本体载入的为 null。 */
export const worldMeta = (world: THomePlanMissionWorld | null): string | null => world
  ? [worldPending(world), `本体 v${world.version}`, `${shortDate(calendarDate(world.readAt))} 读`, world.gaps.length ? `缺 ${world.gaps.join("、")}` : null].filter(Boolean).join(" · ")
  : null;

/** 行内颜色变量 --c（Mission 的颜色）。 */
export const tone = (color: string) => ({ "--c": color }) as CSSProperties;
