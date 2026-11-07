import type { Pool } from "pg";
import { feishuNotifier } from "./feishu/notify.js";
import type { JobHandler, RecurringJob } from "./jobs.js";
import type { DirectoryPerson } from "./peopleDirectory.js";
import { weekStartOf } from "./usage.js";
import { addDays, weeklyReviewHref } from "./weeklyReviews.js";
import { shanghaiDate } from "./workdays.js";

/**
 * 一号位要动手的事，主动私信到飞书（和通知栏同一时段出现；会议卡待确认在 meetingCard.ts 里已经发）：
 * - 复盘与拆解开放：月末倒数第 3 天到次月 7 日，每个时段发一次，去 M2；
 * - 周复盘写好了等确认：周五到周一，本人那份是 draft 时发一次；
 * - 需要尽快判断的议题（红色、待判断）：两天内新出现的，每条发一次。
 * 每 15 分钟看一次，只在上海时间 9–21 点发；同一件事按 dedupeKey 只发一次，没关联飞书的人直接跳过（notify.ts），「偏好」里关了飞书通知的不发。
 */
export const CEO_FEISHU_NOTICES_KIND = "feishu.ceo_notices";
const EVERY_MS = 15 * 60_000;
const QUIET_BEFORE = 9;
const QUIET_FROM = 21;

/** 公司时区（上海）的日期是否在复盘与拆解时段里：月末倒数第 3 天到次月 7 日（与通知栏的 M2 入口卡一致）。 */
export function inM2Window(day: string): boolean {
  const [year, month, date] = day.split("-").map(Number);
  return date <= 7 || date >= new Date(Date.UTC(year, month, 0)).getUTCDate() - 2;
}

/** 这个时段属于哪个月的复盘（次月 1–7 日算上个月的）：YYYY-MM。 */
export function m2WindowMonth(day: string): string {
  const [year, month, date] = day.split("-").map(Number);
  if (date > 7) return day.slice(0, 7);
  const previous = new Date(Date.UTC(year, month - 2, 1));
  return previous.toISOString().slice(0, 7);
}

export function ceoFeishuNoticeJobs({ pool, people, now }: { pool: Pool; people: () => DirectoryPerson[]; now: () => Date }):
  { handlers: Record<string, JobHandler>; recurring: RecurringJob[] } {
  const q = pool.query.bind(pool);
  const notify = feishuNotifier(q);

  async function tick(): Promise<void> {
    const at = now();
    const hour = Number(new Date(at.getTime() + 8 * 3_600_000).toISOString().slice(11, 13));
    if (hour < QUIET_BEFORE || hour >= QUIET_FROM) return;
    const day = shanghaiDate(at);
    const weekday = new Date(`${day}T00:00:00Z`).getUTCDay();
    // 「偏好」里关了飞书通知的不发（新首页 13.2）。
    const muted = new Set(((await q("SELECT person_id FROM person_notify WHERE NOT feishu")).rows as { person_id: string }[]).map((row) => row.person_id));
    const ceos = people().filter((person) => person.roles.includes("ceo") && !muted.has(person.personId)).map((person) => person.personId);
    if (!ceos.length) return;
    const issues = (await q(
      `SELECT id::text, title FROM issues WHERE status = 'pending' AND urgency->>'level' = 'red' AND created_at > $1::timestamptz - interval '2 days' ORDER BY created_at`,
      [at])).rows as { id: string; title: string }[];
    for (const personId of ceos) {
      if (inM2Window(day)) {
        await notify({ personId, title: "复盘与拆解开始了", body: "本月复盘和下月目标拆解已开放。", links: [{ label: "去复盘与拆解", path: "/m2/" }] },
          `ceo-m2:${personId}:${m2WindowMonth(day)}`);
      }
      // 周五到周一：本周的周复盘，周一时是上一周的。
      if (weekday === 5 || weekday === 6 || weekday === 0 || weekday === 1) {
        const weekStart = weekday === 1 ? addDays(weekStartOf(at), -7) : weekStartOf(at);
        const review = (await q("SELECT id::text FROM weekly_reviews WHERE person_id = $1 AND week_start = $2 AND status = 'draft'", [personId, weekStart])).rows[0] as
          { id: string } | undefined;
        if (review) {
          await notify({ personId, title: "周复盘等你确认", body: `${weekStart.slice(5)} 到 ${addDays(weekStart, 6).slice(5)} 这周的复盘已经起草好。`,
            links: [{ label: "去确认", path: weeklyReviewHref(review.id, true) }] }, `ceo-weekly:${review.id}`);
        }
      }
      for (const issue of issues) {
        await notify({ personId, title: "有议题需要尽快判断", body: issue.title, links: [{ label: "去看议题", path: `/issues/${issue.id}` }] },
          `ceo-issue:${personId}:${issue.id}`);
      }
    }
  }

  return { handlers: { [CEO_FEISHU_NOTICES_KIND]: tick }, recurring: [{ kind: CEO_FEISHU_NOTICES_KIND, everyMs: EVERY_MS }] };
}
