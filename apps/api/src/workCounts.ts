import type { TWorkCountRow, TWorkCountsResponse } from "@warmap/contracts";
import { adminPeople } from "./admin.js";
import { effectiveOutcome } from "./cardProjection.js";
import type { Query } from "./meetingStore.js";
import type { PeopleDirectory } from "./peopleDirectory.js";
import { weekStartOf } from "./usage.js";

/**
 * 使用计数（设计第 70 条，契约 usage.ts 的 WorkCountsResponse）：每人每周只计数、不记内容，都从现有的表现算，不另存。
 * 一周是周一到周日（北京时间），本周算到现在为止。
 */

const OFFSET_MS = 8 * 3_600_000;
const DAY_MS = 86_400_000;
const NOT_COUNTED = ["批准（批准、换个做法、作废）：只在本机，云端没有记录", "恢复文件的次数：只在本机，云端没有记录"];

type PersonCount = Map<string, number>;
const bump = (counts: PersonCount, personId: string, by = 1) => counts.set(personId, (counts.get(personId) ?? 0) + by);
const tally = (rows: { person_id: string; n: number }[]) => new Map(rows.map((row) => [row.person_id, Number(row.n)]));

export async function readWorkCounts(q: Query, peopleDirectory: PeopleDirectory, week: string | undefined, now: Date): Promise<TWorkCountsResponse> {
  const weekStart = week ?? weekStartOf(now);
  const from = new Date(Date.parse(`${weekStart}T00:00:00Z`) - OFFSET_MS);
  const to = new Date(Math.min(from.getTime() + 7 * DAY_MS, now.getTime()));
  const weekEnd = new Date(from.getTime() + 6 * DAY_MS + OFFSET_MS).toISOString().slice(0, 10);
  const range = [from, to];
  const counted = async (sql: string) => tally((await q(sql, range)).rows as { person_id: string; n: number }[]);

  // 对话轮数：走 Chat 的每一轮（chat_turn_models 记了是哪一种），项目对话在本机跑的那几轮另算（没跑成、改走云端的不算两次）。
  const buddyTurns = await counted(`SELECT owner_id AS person_id,count(*)::int AS n FROM chat_turn_models WHERE scope_kind='buddy' AND recorded_at>=$1 AND recorded_at<$2 GROUP BY 1`);
  const projectTurns = await counted(`SELECT person_id,sum(n)::int AS n FROM (
      SELECT owner_id AS person_id,count(*) AS n FROM chat_turn_models WHERE scope_kind='project' AND recorded_at>=$1 AND recorded_at<$2 GROUP BY 1
      UNION ALL SELECT owner_id,count(*) FROM project_local_turns WHERE status IN ('running','completed','aborted') AND started_at>=$1 AND started_at<$2 GROUP BY 1) t GROUP BY 1`);
  // 派活单：这一周有草稿放进看板 / 被点了不要的派活单数；规划员按本人的话又出了一次（revision > 1）的。
  const plansStarted = await counted(`SELECT owner_id AS person_id,count(DISTINCT plan_id)::int AS n FROM card_drafts
    WHERE status='accepted' AND decided_at>=$1 AND decided_at<$2 GROUP BY 1`);
  const plansDropped = await counted(`SELECT owner_id AS person_id,count(DISTINCT plan_id)::int AS n FROM card_drafts
    WHERE status='dismissed' AND decided_at>=$1 AND decided_at<$2 GROUP BY 1`);
  const plansRevised = await counted(`SELECT owner_id AS person_id,count(*)::int AS n FROM card_plans
    WHERE revision>1 AND COALESCE(finished_at,created_at)>=$1 AND COALESCE(finished_at,created_at)<$2 GROUP BY 1`);
  // 卡开工：这一周第一次在本机开起来的卡。
  const cardsStarted = await counted(`SELECT owner_id AS person_id,count(*)::int AS n FROM (SELECT owner_id,task_id,min(started_at) AS first FROM local_runs
    WHERE kind='card' AND task_id IS NOT NULL GROUP BY 1,2) r WHERE first>=$1 AND first<$2 GROUP BY 1`);
  const handedBack = await counted(`SELECT owner_id AS person_id,count(*)::int AS n FROM card_handbacks WHERE created_at>=$1 AND created_at<$2 GROUP BY 1`);
  // 结论：按出结论的时间数；受阻是这一次没过让连续没过到 2（等你补的那次跳过，同卡的投影）。就到这里按推翻的时间。
  const judged = (await q(`SELECT h.task_id::text,h.owner_id,h.attempt,h.status,h.outcome,h.overruled_at,h.finished_at FROM card_handbacks h
    WHERE h.task_id IN (SELECT task_id FROM card_handbacks WHERE (finished_at>=$1 AND finished_at<$2) OR (overruled_at>=$1 AND overruled_at<$2))
    ORDER BY h.task_id,h.attempt`, range)).rows as { task_id: string; owner_id: string; attempt: number; status: string; outcome: "pass" | "fail" | "needs_person" | null;
    overruled_at: Date | null; finished_at: Date | null }[];
  const passed: PersonCount = new Map(), failed: PersonCount = new Map(), blocked: PersonCount = new Map(), needsPerson: PersonCount = new Map(),
    closedWithGap: PersonCount = new Map();
  const within = (at: Date | null) => at !== null && at >= from && at < to;
  let card = "", streak = 0;
  for (const row of judged) {
    if (row.task_id !== card) { card = row.task_id; streak = 0; }
    if (row.status !== "done" || !row.outcome) continue;
    if (row.outcome === "fail") streak++; else if (row.outcome === "pass") streak = 0;
    if (within(row.finished_at)) {
      if (row.outcome === "pass") bump(passed, row.owner_id);
      if (row.outcome === "fail") { bump(failed, row.owner_id); if (streak === 2) bump(blocked, row.owner_id); }
      if (row.outcome === "needs_person") bump(needsPerson, row.owner_id);
    }
    if (row.outcome !== "pass" && within(row.overruled_at)) bump(closedWithGap, row.owner_id);
    // 推翻以后按本人的判断算，连续没过从头数。
    if (effectiveOutcome(row) === "pass") streak = 0;
  }
  // 全部放行的会话：这一周有动静、本机最后报的权限模式是全部放行。
  const bypass = await counted(`SELECT owner_id AS person_id,count(*)::int AS n FROM local_runs WHERE permission_mode='bypassPermissions'
    AND updated_at>=$1 AND started_at<$2 GROUP BY 1`);
  const activeDays = tally((await q(`SELECT person_id,count(DISTINCT day)::int AS n FROM usage_events WHERE kind='active' AND day>=$1::date AND day<=$2::date GROUP BY 1`,
    [weekStart, weekEnd])).rows as { person_id: string; n: number }[]);

  const of = (counts: PersonCount, personId: string) => counts.get(personId) ?? 0;
  const rows: TWorkCountRow[] = adminPeople(peopleDirectory).map((person) => ({
    personId: person.personId, name: person.displayName,
    buddyTurns: of(buddyTurns, person.personId), projectTurns: of(projectTurns, person.personId),
    plans: { started: of(plansStarted, person.personId), revised: of(plansRevised, person.personId), dropped: of(plansDropped, person.personId) },
    cards: { started: of(cardsStarted, person.personId), handedBack: of(handedBack, person.personId), passed: of(passed, person.personId), failed: of(failed, person.personId),
      blocked: of(blocked, person.personId), needsPerson: of(needsPerson, person.personId), closedWithGap: of(closedWithGap, person.personId) },
    bypassSessions: of(bypass, person.personId), activeDays: Math.min(7, of(activeDays, person.personId)),
  })).sort((a, b) => a.name.localeCompare(b.name, "zh-CN") || a.personId.localeCompare(b.personId));
  return { weekStart, weekEnd, rows, notCounted: NOT_COUNTED };
}
