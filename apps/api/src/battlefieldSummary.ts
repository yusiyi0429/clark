import type { Pool } from "pg";
import type { TBattlefieldSummariesResponse, TBattlefieldSummary } from "@warmap/contracts";
import { groupMissions } from "./battlefieldProgress.js";
import type { JobHandler, RecurringJob } from "./jobs.js";
import type { Query } from "./meetingStore.js";
import { companyPeriod } from "./monthlyPlans.js";
import { logEvent } from "./observability.js";
import { isRealPerson } from "./people.js";
import type { DirectoryPerson } from "./peopleDirectory.js";
import { deadlineGap, missionDeadline, plainReviewText, shanghaiDay, slowReason, workdaysBetween, type PlanTask } from "./progress.js";
import { addDays, BATTLEFIELD_MEMBERS } from "./weeklyReviews.js";
import type { WorldSnapshot } from "./worldReader.js";

/**
 * 战场进展汇总：每个战场每天一份，Agent 对照本期目标读最近 14 天的进展写 3–4 段（battlefieldSummaryAgent.ts），存 battlefield_summaries（212）。
 * - 每天 07:30（北京时间）之后后台任务补齐当天的；页面打开时当天还没有就当场开始整理，页面轮询看阶段和已用时间。
 * - 可见范围与进展读取同一口径（progressAccess.ts）：CEO 看全部战场，其他人看这个月自己所在的战场（周复盘那份战场名单）。
 * - 本期目标：本体里这个战场本月的本期目标优先，其次月度计划里写的战场结果；都没有就是「本期目标未载入」。
 * 整理中、没整理出来只记在进程里（单进程部署）；没整理出来的 10 分钟内不再自动重试。
 */

const LOOKBACK_DAYS = 14;
const PROGRESS_LIMIT = 80;
const PROGRESS_CHARS = 500;
const REVIEW_CHARS = 600;
const DAY_MS = 86_400_000;
/** 每天这个时刻（北京时间）之后，后台任务补齐当天的汇总。 */
const DAILY_AT_MINUTES = 7 * 60 + 30;
export const BATTLEFIELD_SUMMARY_KIND = "progress.battlefield_summaries";
const STATUS_TEXT: Record<string, string> = { not_started: "未开始", in_progress: "进行中", done: "已完成" };

export type BattlefieldSummaryInput = {
  battlefield: string; today: string; period: string;
  goal: { source: "本体" | "月度计划"; items: { title: string | null; outcome: string; successCriteria: string | null }[] } | null;
  members: { name: string; role: "负责人" | "参与人" | "成员" }[];
  missions: {
    title: string; owner: string; outcome: string; deadline: string; servesGoal: string | null; signals: string[];
    tasks: { title: string; status: string; startDate: string | null; dueDate: string | null; blockedReason: string | null; waitingOn: string | null;
      blockedSince: string | null; lastProgressAt: string | null; signals: string[] }[];
  }[];
  progress: { at: string; person: string; mission: string; task: string; text: string; links: number }[];
  weeklyReviews: { person: string; weekStart: string; overall: string; progress: string; issues: string; actions: string }[];
  counts: { progress: number; weeklyReviews: number };
};
export type BattlefieldSummaryAgent = {
  modelId: string;
  summarize(input: BattlefieldSummaryInput, battlefieldId: string, signal: AbortSignal): Promise<string[]>;
};
type Battlefield = { id: string; name: string };
type Viewer = { personId: string; role: string };

/** 「2026-10-26 14:30」（北京时间）：给模型看的时间，省得它自己换时区。 */
const localTime = (at: Date) => new Date(at.getTime() + 8 * 3_600_000).toISOString().slice(0, 16).replace("T", " ");
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text);
const oneLine = (text: string) => text.replace(/\s*\n\s*/g, " ").trim();

/** 读一个战场的汇总输入；goalLine 是存下来、页面上那一行本期目标，progressUntil 是输入里最新一条进展的时间。 */
export async function collectBattlefieldSummaryInput(q: Query, battlefield: Battlefield, at: Date, people: DirectoryPerson[], world: WorldSnapshot | null):
  Promise<{ input: BattlefieldSummaryInput; goalLine: string | null; progressUntil: Date | null }> {
  const today = shanghaiDay(at), period = companyPeriod(at);
  const directory = new Map(people.map((person) => [person.personId, person]));
  const name = (id: string | null) => (id ? directory.get(id)?.displayName ?? id : null);
  const real = (id: string) => !directory.get(id) || isRealPerson(directory.get(id)!);

  // 本期目标：本体里本月的本期目标优先，其次月度计划里写的战场结果。
  const pos = (world?.units.find((unit) => unit.battlefieldId === battlefield.id)?.periodGoals ?? [])
    .filter((goal) => goal.period === period && (goal.outcome || goal.title));
  let goal: BattlefieldSummaryInput["goal"] = null;
  if (pos.length) {
    goal = { source: "本体", items: pos.map((item) => ({ title: item.title, outcome: item.outcome ?? item.title, successCriteria: item.successCriteria })) };
  } else {
    const plan = (await q("SELECT battlefields FROM monthly_plans WHERE period = $1 ORDER BY version DESC LIMIT 1", [period])).rows[0] as
      { battlefields: { battlefieldId: string; outcome?: string }[] } | undefined;
    const outcome = plan?.battlefields.find((entry) => entry.battlefieldId === battlefield.id)?.outcome?.trim();
    if (outcome) goal = { source: "月度计划", items: [{ title: null, outcome, successCriteria: null }] };
  }
  const goalLine = goal ? goal.items.map((item) => oneLine(item.outcome)).join("；") : null;

  const roles = (await q("SELECT owner_id, participant_ids FROM battlefield_config WHERE id = $1", [battlefield.id])).rows[0] as
    { owner_id: string | null; participant_ids: string[] | null } | undefined;
  const memberIds = ((await q(`WITH members(person_id, battlefield_id) AS (${BATTLEFIELD_MEMBERS})
    SELECT DISTINCT person_id FROM members WHERE battlefield_id = $1 AND COALESCE(person_id, '') <> '' ORDER BY person_id`, [battlefield.id, period])).rows as { person_id: string }[])
    .map((row) => row.person_id).filter(real);
  const members = memberIds.map((id) => ({ name: name(id)!,
    role: id === roles?.owner_id ? "负责人" as const : roles?.participant_ids?.includes(id) ? "参与人" as const : "成员" as const }));

  const missions = await groupMissions(q, { id: battlefield.id, name: battlefield.name, kind: "battlefield", goal: null, members: memberIds }, period);
  const missionIds = missions.map((mission) => mission.id);
  const tasks = missionIds.length ? (await q(`SELECT t.id::text AS id, t.title, t.status, t.mission_id, to_char(t.start_date,'YYYY-MM-DD') AS start_date,
      to_char(t.due_date,'YYYY-MM-DD') AS due_date, t.blocked_reason, t.waiting_on, t.blocked_at,
      (SELECT max(tp.created_at) FROM task_progress tp WHERE tp.task_id = t.id) AS last_progress_at,
      (SELECT max(tp.created_at) FROM task_progress tp WHERE tp.task_id = t.id
        AND (jsonb_array_length(tp.links) > 0 OR EXISTS (SELECT 1 FROM collector_progress cp WHERE cp.task_progress_id = tp.id))) AS last_verified_at
    FROM tasks t WHERE t.mission_id = ANY($1) AND t.status <> 'returned' ORDER BY t.step_order NULLS LAST, t.created_at, t.id`, [missionIds])).rows as {
    id: string; title: string; status: string; mission_id: string; start_date: string | null; due_date: string | null; blocked_reason: string | null;
    waiting_on: string | null; blocked_at: Date | null; last_progress_at: Date | null; last_verified_at: Date | null;
  }[] : [];

  const goalTitles = new Map(pos.map((item) => [item.objectId, item.title]));
  const missionInputs = missions.map((mission) => {
    const own = tasks.filter((task) => task.mission_id === mission.id);
    const deadline = missionDeadline(mission.milestones, mission.period);
    const dated = own.filter((task): task is typeof task & { start_date: string; due_date: string } =>
      task.status !== "done" && !!task.start_date && !!task.due_date);
    const plan = (task: (typeof dated)[number]): PlanTask =>
      ({ status: task.status as PlanTask["status"], startDate: task.start_date, dueDate: task.due_date, lastVerifiedAt: task.last_verified_at });
    const gap = dated.length ? deadlineGap(dated.map(plan), deadline, today) : null;
    return {
      title: mission.title, owner: name(mission.owner_id)!, outcome: mission.outcome, deadline,
      servesGoal: (mission.world_goal_id && goalTitles.get(mission.world_goal_id)) || null,
      signals: gap ? [`按截止做不完：还需 ${gap.neededDays} 个工作日，剩 ${gap.leftDays} 个`] : [],
      tasks: own.map((task) => {
        const signals: string[] = [];
        const datedTask = dated.find((item) => item.id === task.id);
        const reason = datedTask ? slowReason(plan(datedTask), today) : null;
        if (reason === "overdue") signals.push(`已过截止 ${workdaysBetween(addDays(task.due_date!, 1), today)} 个工作日`);
        if (reason === "no_progress") signals.push("开始 3 个工作日仍没有核实过的进展");
        return {
          title: task.title, status: STATUS_TEXT[task.status] ?? task.status, startDate: task.start_date, dueDate: task.due_date,
          blockedReason: task.blocked_reason, waitingOn: name(task.waiting_on), blockedSince: task.blocked_at ? shanghaiDay(task.blocked_at) : null,
          lastProgressAt: task.last_progress_at ? localTime(task.last_progress_at) : null, signals,
        };
      }),
    };
  });

  const since = new Date(at.getTime() - LOOKBACK_DAYS * DAY_MS);
  const progressRows = tasks.length ? (await q(`SELECT tp.author_id, tp.body, tp.links, tp.created_at, t.title AS task_title, t.mission_id
      FROM task_progress tp JOIN tasks t ON t.id = tp.task_id
     WHERE tp.task_id = ANY($1::uuid[]) AND tp.created_at >= $2 AND tp.created_at <= $3
     ORDER BY tp.created_at DESC, tp.id DESC LIMIT ${PROGRESS_LIMIT}`, [tasks.map((task) => task.id), since, at])).rows as
    { author_id: string; body: string; links: unknown[]; created_at: Date; task_title: string; mission_id: string }[] : [];
  const reviewRows = memberIds.length ? (await q(`SELECT person_id, to_char(week_start,'YYYY-MM-DD') AS week_start, body, submitted_at FROM weekly_reviews
     WHERE status = 'submitted' AND person_id = ANY($1) AND week_start >= $2::date AND submitted_at <= $3
     ORDER BY week_start DESC, person_id`, [memberIds, addDays(today, -LOOKBACK_DAYS), at])).rows as
    { person_id: string; week_start: string; body: Record<string, { text?: string }> | null; submitted_at: Date }[] : [];
  const missionTitle = new Map(missions.map((mission) => [mission.id, mission.title]));
  const reviewText = (row: (typeof reviewRows)[number], field: string) => clip(plainReviewText(row.body?.[field]?.text ?? ""), REVIEW_CHARS);

  const times = [...progressRows.map((row) => row.created_at.getTime()), ...reviewRows.map((row) => row.submitted_at.getTime())];
  return {
    goalLine,
    progressUntil: times.length ? new Date(Math.max(...times)) : null,
    input: {
      battlefield: battlefield.name, today, period, goal, members, missions: missionInputs,
      progress: progressRows.map((row) => ({ at: localTime(row.created_at), person: name(row.author_id)!, mission: missionTitle.get(row.mission_id) ?? "",
        task: row.task_title, text: clip(row.body.trim(), PROGRESS_CHARS), links: Array.isArray(row.links) ? row.links.length : 0 })),
      weeklyReviews: reviewRows.map((row) => ({ person: name(row.person_id)!, weekStart: row.week_start,
        overall: reviewText(row, "overall"), progress: reviewText(row, "progress"), issues: reviewText(row, "issues"), actions: reviewText(row, "actions") })),
      counts: { progress: progressRows.length, weeklyReviews: reviewRows.length },
    },
  };
}

/** 看得到哪些战场：CEO 全部；其他人是这个月自己所在的战场（progressAccess.ts 同一份名单）。 */
async function visibleBattlefields(q: Query, viewer: Viewer, period: string): Promise<Battlefield[]> {
  if (viewer.role === "ceo") return (await q("SELECT id, name FROM battlefield_config ORDER BY sort_order, code, id")).rows as Battlefield[];
  return (await q(`WITH members(person_id, battlefield_id) AS (${BATTLEFIELD_MEMBERS})
    SELECT b.id, b.name FROM battlefield_config b WHERE b.id IN (SELECT battlefield_id FROM members WHERE person_id = $1)
    ORDER BY b.sort_order, b.code, b.id`, [viewer.personId, period])).rows as Battlefield[];
}

type SummaryRow = { battlefield_id: string; day: string; goal: string | null; body: string; progress_until: Date | null; summarized_at: Date };
type Running = { phase: "reading" | "writing"; startedAt: Date; done: Promise<void> };

export function createBattlefieldSummaries({ pool, agent, people, world, now, timeoutMs = 4 * 60_000, retryAfterMs = 10 * 60_000 }: {
  pool: Pool;
  agent: BattlefieldSummaryAgent;
  people: () => DirectoryPerson[];
  /** 本体快照（读本期目标）；本体没配或读不到为 null。 */
  world: () => Promise<WorldSnapshot | null>;
  /** 业务时钟：哪一天、读哪段进展。整理中的已用时间、没整理出来的时刻用真实时钟（页面按真实时间算已用）。 */
  now: () => Date;
  timeoutMs?: number;
  retryAfterMs?: number;
}) {
  const q: Query = pool.query.bind(pool);
  const running = new Map<string, Running>();
  const failed = new Map<string, Date>();
  const key = (battlefieldId: string, day: string) => `${battlefieldId}:${day}`;

  function start(battlefield: Battlefield, day: string): Running {
    const k = key(battlefield.id, day);
    const state: Running = { phase: "reading", startedAt: new Date(), done: Promise.resolve() };
    running.set(k, state);
    const startedAt = Date.now();
    state.done = (async () => {
      const at = now();
      const snapshot = await world().catch(() => null);
      const { input, goalLine, progressUntil } = await collectBattlefieldSummaryInput(q, battlefield, at, people(), snapshot);
      state.phase = "writing";
      const abort = new AbortController();
      const timer = setTimeout(() => abort.abort(new Error("battlefield summary timed out")), timeoutMs);
      let paragraphs: string[];
      try { paragraphs = await agent.summarize(input, battlefield.id, abort.signal); } finally { clearTimeout(timer); }
      const body = paragraphs.map((text) => oneLine(text)).filter(Boolean).join("\n\n");
      if (!body) throw new Error("battlefield summary is empty");
      await q(`INSERT INTO battlefield_summaries (battlefield_id, day, period, goal, body, progress_until, summarized_at, model)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8) ON CONFLICT (battlefield_id, day) DO NOTHING`,
      [battlefield.id, day, companyPeriod(at), goalLine, body, progressUntil, now(), agent.modelId]);
      failed.delete(k);
      logEvent({ event: "progress.battlefield_summary", objectRef: `battlefield:${battlefield.id}`, status: "ok", durationMs: Date.now() - startedAt });
    })().catch((error) => {
      failed.set(k, new Date());
      logEvent({ event: "progress.battlefield_summary", objectRef: `battlefield:${battlefield.id}`, status: "failed",
        error: (error as Error).message || String(error), durationMs: Date.now() - startedAt });
    }).finally(() => { running.delete(k); });
    return state;
  }

  /** 当天还没有的开始整理（正在整理的、10 分钟内没整理出来的不动）；返回这几个战场今天已存的汇总。 */
  async function startMissing(battlefields: Battlefield[], day: string): Promise<Map<string, SummaryRow>> {
    const rows = battlefields.length ? (await q(`SELECT DISTINCT ON (battlefield_id) battlefield_id, to_char(day,'YYYY-MM-DD') AS day, goal, body, progress_until, summarized_at
      FROM battlefield_summaries WHERE battlefield_id = ANY($1) AND day <= $2::date ORDER BY battlefield_id, day DESC`,
    [battlefields.map((item) => item.id), day])).rows as SummaryRow[] : [];
    const latest = new Map(rows.map((row) => [row.battlefield_id, row]));
    for (const battlefield of battlefields) {
      const k = key(battlefield.id, day), failedAt = failed.get(k);
      if (latest.get(battlefield.id)?.day === day || running.has(k)) continue;
      if (failedAt && Date.now() - failedAt.getTime() < retryAfterMs) continue;
      start(battlefield, day);
    }
    return latest;
  }

  return {
    /** 本人看得到的战场各一份：最近一份汇总，加上今天这份的整理状态。 */
    async read(viewer: Viewer): Promise<TBattlefieldSummariesResponse> {
      const at = now(), today = shanghaiDay(at);
      const battlefields = await visibleBattlefields(q, viewer, companyPeriod(at));
      const latest = await startMissing(battlefields, today);
      return {
        today,
        battlefields: battlefields.map((battlefield): TBattlefieldSummary => {
          const row = latest.get(battlefield.id);
          const state = running.get(key(battlefield.id, today)), failedAt = failed.get(key(battlefield.id, today));
          return {
            battlefieldId: battlefield.id, name: battlefield.name,
            summary: row ? { day: row.day, goal: row.goal, paragraphs: row.body.split(/\n\s*\n/).map((text) => text.trim()).filter(Boolean),
              progressUntil: row.progress_until?.toISOString() ?? null, summarizedAt: row.summarized_at.toISOString() } : null,
            generation: row?.day === today ? null
              : state ? { state: "running", phase: state.phase, startedAt: state.startedAt.toISOString() }
              : failedAt ? { state: "failed", at: failedAt.toISOString() } : null,
          };
        }),
      };
    },
    /** 每 10 分钟看一次：07:30（北京时间）之后补齐当天各战场的汇总，等它们整理完。 */
    jobs(): { handlers: Record<string, JobHandler>; recurring: RecurringJob[] } {
      return {
        handlers: { [BATTLEFIELD_SUMMARY_KIND]: async () => {
          const at = now(), local = new Date(at.getTime() + 8 * 3_600_000);
          if (local.getUTCHours() * 60 + local.getUTCMinutes() < DAILY_AT_MINUTES) return;
          const day = shanghaiDay(at);
          const battlefields = await visibleBattlefields(q, { personId: "", role: "ceo" }, companyPeriod(at));
          await startMissing(battlefields, day);
          await Promise.all(battlefields.map((battlefield) => running.get(key(battlefield.id, day))?.done));
        } },
        recurring: [{ kind: BATTLEFIELD_SUMMARY_KIND, everyMs: 10 * 60_000 }],
      };
    },
    /** 等正在整理的都结束（关闭时、测试里用）。 */
    async idle(): Promise<void> { await Promise.all([...running.values()].map((state) => state.done)); },
  };
}
export type BattlefieldSummaries = ReturnType<typeof createBattlefieldSummaries>;
