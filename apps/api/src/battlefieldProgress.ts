import type { TBattlefieldHelpItem, TBattlefieldPersonCard, TBattlefieldProgressGroup, TBattlefieldProgressResponse, TProgressPerson } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { companyPeriod } from "./monthlyPlans.js";
import { isRealPerson } from "./people.js";
import type { DirectoryPerson } from "./peopleDirectory.js";
import { deadlineGap, missionDeadline, shanghaiDay, slowReason, workdaysBetween, type PlanTask } from "./progress.js";
import { addDays, BATTLEFIELD_MEMBERS, weekStartOf } from "./weeklyReviews.js";

/**
 * 成员的「战场进展」：按我所在的战场分组（与周复盘同一份战场名单）；本月一个战场都对不上时，按我本月 Mission 的业务域（能力域）分组。
 * 只放宽这一页：同组的人互相看得到本组 Mission、事项进度、最近一条进展和卡点；周复盘和 Agent 读进展仍按战场。
 * 红线（慢了 / 按截止做不完）沿用 progress.ts 的判法；卡住来自推进人写的「卡在哪」。
 */

type Group = { id: string; name: string; kind: TBattlefieldProgressGroup["kind"]; goal: string | null; members: string[] };
type MissionRow = { id: string; title: string; owner_id: string; period: string; milestones: string[] };
type TaskRow = {
  id: string; title: string; status: string; owner_id: string; mission_id: string; start_date: string | null; due_date: string | null;
  blocked_reason: string | null; waiting_on: string | null; blocked_at: Date | null; last_verified_at: Date | null; mine: boolean;
};
const DAY_MS = 86_400_000;
const HELP_ORDER: Record<TBattlefieldHelpItem["kind"], number> = { blocked: 0, deadline: 1, overdue: 2, no_progress: 3 };

/** 我所在的组：先看战场；一个都没有时看我本月 Mission 的业务域。 */
async function viewerGroups(q: Query, viewerId: string, period: string): Promise<Group[]> {
  const battlefields = (await q(`WITH members(person_id, battlefield_id) AS (${BATTLEFIELD_MEMBERS})
    SELECT b.id, b.name, array_agg(DISTINCT other.person_id) AS members
      FROM members me JOIN members other ON other.battlefield_id = me.battlefield_id JOIN battlefield_config b ON b.id = me.battlefield_id
     WHERE me.person_id = $1 AND other.person_id IS NOT NULL GROUP BY b.id, b.name ORDER BY b.name`, [viewerId, period]))
    .rows as { id: string; name: string; members: string[] }[];
  if (battlefields.length) {
    const plan = (await q("SELECT battlefields FROM monthly_plans WHERE period = $1 ORDER BY version DESC LIMIT 1", [period])).rows[0] as
      { battlefields: { battlefieldId: string; outcome?: string }[] } | undefined;
    return battlefields.map((row) => ({ id: row.id, name: row.name, kind: "battlefield", members: row.members,
      goal: plan?.battlefields.find((entry) => entry.battlefieldId === row.id)?.outcome?.trim() || null }));
  }
  const domains = (await q(`SELECT c.id, c.name, array_agg(DISTINCT other.owner_id) AS members
      FROM missions me JOIN missions other ON other.capability_id = me.capability_id AND other.period = me.period AND NOT other.placeholder
      JOIN capability_config c ON c.id = me.capability_id
     WHERE me.owner_id = $1 AND me.period = $2 AND NOT me.placeholder GROUP BY c.id, c.name ORDER BY c.name`, [viewerId, period]))
    .rows as { id: string; name: string; members: string[] }[];
  return domains.map((row) => ({ id: row.id, name: row.name, kind: "capability", goal: null, members: row.members }));
}

/** 组里这个月的 Mission：战场组看挂了这个战场的（或任务卡在这个战场轮次里的），业务域组看同一能力域的。 */
async function groupMissions(q: Query, group: Group, period: string): Promise<MissionRow[]> {
  const where = group.kind === "battlefield"
    ? `(m.battlefield_ids ? $3 OR EXISTS (SELECT 1 FROM personal_mission_cards c JOIN mission_rounds r ON r.id = c.round_id
         WHERE c.id = m.personal_mission_card_id AND r.battlefield_id = $3))`
    : "m.capability_id = $3";
  return (await q(`SELECT m.id, m.title, m.owner_id, m.period, m.milestones FROM missions m
    WHERE m.period = $1 AND NOT m.placeholder AND m.owner_id = ANY($2) AND ${where} ORDER BY m.code, m.id`, [period, group.members, group.id])).rows as MissionRow[];
}

export async function readBattlefieldProgress(q: Query, viewerId: string, people: DirectoryPerson[], now: Date): Promise<TBattlefieldProgressResponse> {
  const today = shanghaiDay(now), period = companyPeriod(now);
  const names = new Map(people.map((item) => [item.personId, item.displayName]));
  const directory = new Map(people.map((item) => [item.personId, item]));
  const person = (id: string): TProgressPerson => ({ personId: id, name: names.get(id) ?? id });
  const weekStart = new Date(`${weekStartOf(now)}T00:00:00+08:00`);
  const groups: TBattlefieldProgressGroup[] = [];
  for (const group of await viewerGroups(q, viewerId, period)) {
    const missions = await groupMissions(q, group, period);
    const missionIds = missions.map((mission) => mission.id);
    const tasks = missionIds.length ? (await q(`SELECT t.id::text AS id, t.title, t.status, t.owner_id, t.mission_id,
        to_char(t.start_date,'YYYY-MM-DD') AS start_date, to_char(t.due_date,'YYYY-MM-DD') AS due_date, t.blocked_reason, t.waiting_on, t.blocked_at,
        (SELECT max(tp.created_at) FROM task_progress tp WHERE tp.task_id = t.id
          AND (jsonb_array_length(tp.links) > 0 OR EXISTS (SELECT 1 FROM collector_progress cp WHERE cp.task_progress_id = tp.id))) AS last_verified_at,
        (t.owner_id = $2 OR EXISTS (SELECT 1 FROM task_members tm WHERE tm.task_id = t.id AND tm.person_id = $2 AND tm.role = 'collaborator' AND tm.left_at IS NULL)) AS mine
      FROM tasks t WHERE t.mission_id = ANY($1) AND t.status <> 'returned'
      ORDER BY t.step_order NULLS LAST, t.created_at, t.id`, [missionIds, viewerId])).rows as TaskRow[] : [];
    const taskIds = tasks.map((task) => task.id);
    const progress = taskIds.length ? (await q(`SELECT DISTINCT ON (t.owner_id) t.owner_id, tp.body, tp.created_at
        FROM task_progress tp JOIN tasks t ON t.id = tp.task_id WHERE tp.task_id = ANY($1::uuid[])
       ORDER BY t.owner_id, tp.created_at DESC, tp.id DESC`, [taskIds])).rows as { owner_id: string; body: string; created_at: Date }[] : [];
    const moved = taskIds.length ? (await q(`SELECT t.owner_id, count(DISTINCT t.id)::int AS n FROM task_progress tp JOIN tasks t ON t.id = tp.task_id
        WHERE tp.task_id = ANY($1::uuid[]) AND tp.created_at >= $2 GROUP BY t.owner_id`, [taskIds, weekStart])).rows as { owner_id: string; n: number }[] : [];

    const help: TBattlefieldHelpItem[] = [];
    const flags = new Map<string, TBattlefieldPersonCard["missions"][number]["flag"]>();
    const raise = (missionId: string, flag: "blocked" | "deadline" | "slow") => {
      const order = { blocked: 0, deadline: 1, slow: 2 } as const, current = flags.get(missionId);
      if (!current || order[flag] < order[current]) flags.set(missionId, flag);
    };
    for (const mission of missions) {
      const open = tasks.filter((task) => task.mission_id === mission.id && task.status !== "done");
      const base = { person: person(mission.owner_id), mission: { missionId: mission.id, title: mission.title }, reason: null, waitingOn: null, waitingOnMe: false,
        days: null, dueDate: null, neededDays: null, leftDays: null };
      for (const task of open) {
        const ref = { taskId: task.id, title: task.title };
        if (task.blocked_reason && task.blocked_at) {
          raise(mission.id, "blocked");
          help.push({ ...base, kind: "blocked", task: ref, reason: task.blocked_reason, waitingOn: task.waiting_on ? person(task.waiting_on) : null,
            waitingOnMe: task.waiting_on === viewerId, days: Math.max(0, Math.floor((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${shanghaiDay(task.blocked_at)}T00:00:00Z`)) / DAY_MS)),
            canOpen: task.mine });
        }
      }
      const dated = open.filter((task): task is TaskRow & { start_date: string; due_date: string } => !!task.start_date && !!task.due_date);
      const plan = (task: TaskRow & { start_date: string; due_date: string }): PlanTask =>
        ({ status: task.status as PlanTask["status"], startDate: task.start_date, dueDate: task.due_date, lastVerifiedAt: task.last_verified_at });
      const gap = dated.length ? deadlineGap(dated.map(plan), missionDeadline(mission.milestones, mission.period), today) : null;
      if (gap) {
        raise(mission.id, "deadline");
        help.push({ ...base, kind: "deadline", task: null, neededDays: gap.neededDays, leftDays: gap.leftDays, canOpen: false });
      }
      for (const task of dated) {
        if (task.blocked_reason) continue;
        const reason = slowReason(plan(task), today);
        if (!reason) continue;
        raise(mission.id, "slow");
        help.push({ ...base, kind: reason, task: { taskId: task.id, title: task.title }, dueDate: task.due_date,
          days: reason === "overdue" ? workdaysBetween(addDays(task.due_date, 1), today) : null, canOpen: task.mine });
      }
    }
    // 卡住 > 做不完 > 过了截止 > 没进展；卡住久的、过期久的在前。
    help.sort((a, b) => HELP_ORDER[a.kind] - HELP_ORDER[b.kind] || (b.days ?? 0) - (a.days ?? 0) || (b.neededDays ?? 0) - (a.neededDays ?? 0));

    const cards: TBattlefieldPersonCard[] = group.members
      .filter((id) => id === viewerId || missions.some((mission) => mission.owner_id === id))
      .filter((id) => id === viewerId || !directory.get(id) || isRealPerson(directory.get(id)!))
      .map((id) => {
        const latest = progress.find((row) => row.owner_id === id);
        const line = latest?.body.split(/\r?\n/).map((text) => text.trim()).find(Boolean);
        return {
          person: person(id), me: id === viewerId, movedThisWeek: moved.find((row) => row.owner_id === id)?.n ?? 0,
          latest: latest && line ? { text: line, at: latest.created_at.toISOString() } : null,
          missions: missions.filter((mission) => mission.owner_id === id).map((mission) => {
            const own = tasks.filter((task) => task.mission_id === mission.id);
            return { missionId: mission.id, title: mission.title, done: own.filter((task) => task.status === "done").length, total: own.length, flag: flags.get(mission.id) ?? null };
          }),
        };
      });
    const rank = (card: TBattlefieldPersonCard) => card.me ? -1 : card.missions.some((m) => m.flag === "blocked") ? 0 : card.missions.some((m) => m.flag) ? 1 : 2;
    cards.sort((a, b) => rank(a) - rank(b) || a.person.name.localeCompare(b.person.name, "zh-CN"));
    const blocked = missions.filter((mission) => flags.get(mission.id) === "blocked").length;
    const slow = missions.filter((mission) => flags.get(mission.id) === "deadline" || flags.get(mission.id) === "slow").length;
    groups.push({ id: group.id, name: group.name, kind: group.kind, goal: group.goal,
      counts: { missions: missions.length, onTrack: missions.length - blocked - slow, slow, blocked }, help, people: cards });
  }
  return { today, groups };
}
