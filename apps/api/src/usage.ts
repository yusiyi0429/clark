import type {
  TOnboardingStepName, TUsageBreak, TUsageLedgerItem, TUsagePath, TUsagePersonRow, TUsageResponse, TUsageStep, TUsageSummary, TUsageWeekReport,
} from "@warmap/contracts";
import { adminPeople, readMarks, resolvedSince, type MarkIndex } from "./admin.js";
import type { JobHandler, RecurringJob } from "./jobs.js";
import type { Query } from "./meetingStore.js";
import type { PeopleDirectory } from "./peopleDirectory.js";

/**
 * 使用周报（迁移 210）：周一到周日（北京时间）一周一份。能从现有表推导的都现算——
 * 对话（agent_runs kind=conversation）、会议卡（meeting_cards / meeting_card_confirmations / meeting_card_syncs）、
 * 个人记忆（回答里的记忆标记、被替代、被忘掉）、上手完成（person_onboarding）、问题台账（与管理员视图同源：质量信号、失败的运行、后台任务、本体写入，
 * 以及影响卡「和我无关」）；推导不了的（哪天用过、登录、界面上原地改 / 彻底删记忆、上手走到哪一步）记在 usage_events。
 * 只读计数、时间和 personId；判断「说不对」只在库里比对开头几个字，正文不出库。
 */

const OFFSET_MS = 8 * 3_600_000; // Asia/Shanghai，无夏令时
const DAY_MS = 86_400_000;
/** 每周一 08:00（北京时间）之后生成上一周。 */
const REPORT_HOUR = 8;
const LEDGER_LIMIT = 10;
export const USAGE_REPORT_KIND = "usage.weekly_report";

/** 下一句开头是这些，算这一轮回答被否定。 */
const REJECTION = "^[[:space:]，。,.!！]*(不对|错了|你错了|说错了|答错了|搞错了|不准确|有误|不是这样|不是这个|不是我要|不是我问)";

export type UsageKind = "active" | "login" | "memory_edit" | "memory_purge" | "onboarding_step";

const localDay = (at: Date) => new Date(at.getTime() + OFFSET_MS).toISOString().slice(0, 10);
const addDays = (day: string, days: number) => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
const startOf = (day: string) => new Date(Date.parse(`${day}T00:00:00Z`) - OFFSET_MS);
/** 这一刻所在那一周的周一（北京时间）。 */
export function weekStartOf(at: Date): string {
  const day = localDay(at);
  return addDays(day, -((new Date(`${day}T00:00:00Z`).getUTCDay() + 6) % 7));
}
export const isWeekStart = (day: string) => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`)) && weekStartOf(startOf(day)) === day;

/** 埋点：一次一行，失败不影响请求本身。active 一人一天只写一次（进程里先挡一道，库里有唯一索引兜底）。 */
export function createUsageTracker(q: Query, now: () => Date) {
  const activeDay = new Map<string, string>();
  const insert = (personId: string, kind: UsageKind, detail: string | null, at: Date) => q(
    `INSERT INTO usage_events (person_id, kind, detail, day, created_at) VALUES ($1, $2, $3, ($4::timestamptz AT TIME ZONE 'Asia/Shanghai')::date, $4)
     ON CONFLICT DO NOTHING`, [personId, kind, detail, at]);
  return {
    active(personId: string): void {
      const at = now();
      const day = localDay(at);
      if (activeDay.get(personId) === day) return;
      activeDay.set(personId, day);
      insert(personId, "active", null, at).catch(() => activeDay.delete(personId));
    },
    async record(personId: string, kind: Exclude<UsageKind, "active">, detail: string | null = null): Promise<void> {
      await insert(personId, kind, detail, now()).catch(() => undefined);
    },
  };
}
export type UsageTracker = ReturnType<typeof createUsageTracker>;

type Range = { from: Date; to: Date; at: Date };
const count = <T>(items: T[], pick: (item: T) => boolean) => items.filter(pick).length;
const distinct = <T>(items: T[], key: (item: T) => string | null | undefined) => new Set(items.map(key).filter(Boolean)).size;

/** 漏斗：每一步的到达数不增；流失最多的那一步（没到的那一步）是 stuckStep。 */
function funnel(steps: TUsageStep[]): string | null {
  let worst = 0;
  let stuck: string | null = null;
  for (let index = 1; index < steps.length; index += 1) {
    const drop = steps[index - 1].units - steps[index].units;
    if (drop > worst) { worst = drop; stuck = steps[index].key; }
  }
  return stuck;
}

type Turn = { person_id: string; status: string; timed_out: boolean; retried: boolean; rejected: boolean | null };

/** 全局对话：发问 → 写完回答 → 没被否定。「继续」「重新回答」那一轮不另算发问，算原问题的「点了重答」。 */
async function conversationPath(q: Query, range: Range): Promise<{ path: Omit<TUsagePath, "previousUnits">; breaksOf: Map<string, number> }> {
  const turns = (await q(
    `SELECT r.input_snapshot->>'viewerId' AS person_id, r.status, COALESCE(r.error, '') ~* '(exceeded|stalled)' AS timed_out,
       EXISTS (SELECT 1 FROM agent_runs x WHERE x.kind = 'conversation' AND x.input_snapshot->>'resumeOf' = r.id::text) AS retried,
       (SELECT n.content ~ $3 FROM conversation_messages u
          JOIN conversation_messages n ON n.conversation_id = u.conversation_id AND n.role = 'user' AND n.kind = 'message' AND n.sequence > u.sequence
         WHERE u.conversation_id = (r.input_snapshot->>'conversationId')::uuid AND u.run_id = r.id AND u.role = 'user'
         ORDER BY n.sequence LIMIT 1) AS rejected
     FROM agent_runs r
     WHERE r.kind = 'conversation' AND r.input_snapshot->>'scope' = 'global' AND NOT (r.input_snapshot ? 'resumeOf')
       AND r.started_at >= $1 AND r.started_at < $2`,
    [range.from, range.to, REJECTION],
  )).rows as Turn[];
  const answered = turns.filter((turn) => turn.status === "succeeded");
  const accepted = answered.filter((turn) => !turn.rejected);
  const failed = turns.filter((turn) => turn.status === "failed" || turn.status === "aborted");
  const step = (key: string, label: string, list: Turn[]): TUsageStep => ({ key, label, units: list.length, people: distinct(list, (turn) => turn.person_id) });
  const steps = [step("asked", "发问", turns), step("answered", "写完回答", answered), step("accepted", "没被否定", accepted)];
  const breaks: TUsageBreak[] = [
    { step: "answered", label: "失败", count: count(failed, (turn) => turn.status === "failed" && !turn.timed_out) },
    { step: "answered", label: "超时", count: count(failed, (turn) => turn.status === "failed" && turn.timed_out) },
    { step: "answered", label: "停止", count: count(failed, (turn) => turn.status === "aborted") },
    { step: "answered", label: "点了重答", count: count(failed, (turn) => turn.retried) },
    { step: "accepted", label: "说「不对」", count: answered.length - accepted.length },
  ].filter((item) => item.count > 0);
  const breaksOf = new Map<string, number>();
  for (const turn of [...failed, ...answered.filter((item) => item.rejected)]) breaksOf.set(turn.person_id, (breaksOf.get(turn.person_id) ?? 0) + 1);
  return { path: { key: "conversation", title: "全局对话", unit: "次", shape: "funnel", steps, stuckStep: funnel(steps), breaks }, breaksOf };
}

type MeetingRow = { host: string; minutes_status: string; carded: boolean; confirmed: boolean; syncs: string[] | null };

/** 会议写入：会议结束 → 会议卡生成 → 主持人确认 → 写入本体（会议卡 B 方案的三张表，迁移 200）。 */
async function meetingPath(q: Query, range: Range): Promise<Omit<TUsagePath, "previousUnits">> {
  const labels: [string, string][] = [["ended", "会议结束"], ["carded", "会议卡生成"], ["confirmed", "主持人确认"], ["written", "写入本体"]];
  const base = { key: "meeting" as const, title: "会议写入", unit: "场", shape: "funnel" as const };
  const rows = (await q(
    `SELECT m.lead_dri_id AS host, m.minutes_status,
       COALESCE(c.draft_status = 'draft_ready' OR c.current_revision IS NOT NULL, false) AS carded,
       EXISTS (SELECT 1 FROM meeting_card_confirmations f WHERE f.meeting_id = m.id) AS confirmed,
       (SELECT array_agg(DISTINCT s.event_status) FROM meeting_card_syncs s WHERE s.meeting_id = m.id) AS syncs
     FROM meetings m LEFT JOIN meeting_cards c ON c.meeting_id = m.id
     WHERE m.status <> 'cancelled' AND COALESCE(m.ended_at, m.ends_at) >= $1 AND COALESCE(m.ended_at, m.ends_at) < $2 AND COALESCE(m.ended_at, m.ends_at) <= $3`,
    [range.from, range.to, range.at],
  )).rows as MeetingRow[];
  const written = (row: MeetingRow) => row.syncs?.includes("succeeded") ?? false;
  const reached = [rows, rows.filter((row) => row.carded), rows.filter((row) => row.confirmed), rows.filter(written)];
  const steps = labels.map(([key, label], index) => ({ key, label, units: reached[index].length, people: distinct(reached[index], (row) => row.host) }));
  const noCard = rows.filter((row) => !row.carded && !row.confirmed);
  const unwritten = rows.filter((row) => row.confirmed && !written(row));
  const breaks: TUsageBreak[] = [
    { step: "carded", label: "妙记未生成", count: count(noCard, (row) => row.minutes_status === "waiting") },
    { step: "carded", label: "妙记读取失败", count: count(noCard, (row) => row.minutes_status === "failed") },
    { step: "carded", label: "待上传逐字稿", count: count(noCard, (row) => row.minutes_status === "manual") },
    { step: "carded", label: "会议卡未生成", count: count(noCard, (row) => row.minutes_status === "ready" || row.minutes_status === "none") },
    { step: "confirmed", label: "待确认", count: count(rows, (row) => row.carded && !row.confirmed) },
    { step: "written", label: "写入失败", count: count(unwritten, (row) => row.syncs?.includes("failed") ?? false) },
    { step: "written", label: "写入中", count: count(unwritten, (row) => !row.syncs?.includes("failed") && (row.syncs?.includes("pending") ?? false)) },
    { step: "written", label: "选了不写入", count: count(unwritten, (row) => !row.syncs?.some((status) => status === "failed" || status === "pending") && (row.syncs?.includes("skipped") ?? false)) },
  ].filter((item) => item.count > 0);
  return { ...base, steps, stuckStep: funnel(steps), breaks };
}

/** 个人记忆：被用到（回答里出现记忆标记）、被改（替代 + 界面上原地改）、被删（忘掉 + 彻底删除）。三项各自计数。 */
async function memoryPath(q: Query, range: Range): Promise<Omit<TUsagePath, "previousUnits">> {
  const [used, edited, deleted] = await Promise.all([
    q(`SELECT c.owner_id AS person_id FROM conversation_messages m JOIN conversations c ON c.id = m.conversation_id
       WHERE m.role = 'assistant' AND m.memory_used IS NOT NULL AND position('(cite:pmem:' IN m.content) > 0 AND m.created_at >= $1 AND m.created_at < $2`, [range.from, range.to]),
    q(`SELECT person_id FROM personal_memory_items WHERE status = 'superseded' AND updated_at >= $1 AND updated_at < $2
       UNION ALL SELECT person_id FROM usage_events WHERE kind = 'memory_edit' AND created_at >= $1 AND created_at < $2`, [range.from, range.to]),
    q(`SELECT person_id FROM personal_memory_items WHERE status = 'forgotten' AND updated_at >= $1 AND updated_at < $2
       UNION ALL SELECT person_id FROM usage_events WHERE kind = 'memory_purge' AND created_at >= $1 AND created_at < $2`, [range.from, range.to]),
  ]);
  const step = (key: string, label: string, rows: { person_id: string }[]): TUsageStep => ({ key, label, units: rows.length, people: distinct(rows, (row) => row.person_id) });
  const steps = [step("used", "被用到", used.rows), step("edited", "被改", edited.rows), step("deleted", "被删", deleted.rows)];
  return { key: "memory", title: "个人记忆", unit: "次", shape: "counts", steps, stuckStep: null, breaks: [] };
}

/** 上手流程的步骤，顺序与 WelcomeFlow 一致（按角色和配置会跳过其中几步）。 */
const ONBOARDING_STEPS: [TOnboardingStepName, string][] = [
  ["hello", "欢迎"], ["tour-notifications", "通知栏"], ["tour-board", "工作台"], ["mission-flow", "Mission 形成"], ["work", "本月工作"],
  ["radar", "雷达"], ["voiceprint", "声纹"], ["connect", "连 AI 工具"], ["collector", "采集器"], ["scan", "扫描"], ["review", "确认清单"],
  ["delegation", "委托"], ["start", "可以开始"],
];

/**
 * 上手：登录 → 各步 → 完成。只看这一周之前还没完成上手的人；每人取走到的最远一步（跳过的中间步骤算走过），所以各步到达数不增。
 * 中途点「先进入工作台」的人也记了完成（person_onboarding），这里算在走到的那一步之后「跳过」。
 */
async function onboardingPath(q: Query, range: Range): Promise<Omit<TUsagePath, "previousUnits">> {
  const rows = (await q(
    `SELECT e.person_id, e.kind, e.detail, o.completed_at FROM usage_events e LEFT JOIN person_onboarding o ON o.person_id = e.person_id
     WHERE e.kind IN ('login', 'onboarding_step') AND e.created_at >= $1 AND e.created_at < $2 AND (o.completed_at IS NULL OR o.completed_at >= $1)`,
    [range.from, range.to],
  )).rows as { person_id: string; kind: string; detail: string | null; completed_at: Date | null }[];
  const keys = ["login", ...ONBOARDING_STEPS.map(([key]) => key), "done"];
  const furthest = new Map<string, number>();
  const completed = new Map<string, boolean>();
  for (const row of rows) {
    const index = row.kind === "login" ? 0 : keys.indexOf(row.detail ?? "");
    if (index >= 0) furthest.set(row.person_id, Math.max(furthest.get(row.person_id) ?? 0, index));
    completed.set(row.person_id, row.completed_at !== null && row.completed_at < range.to);
  }
  const start = keys.indexOf("start");
  const skipped: number[] = [];
  for (const [person, index] of furthest) {
    if (!completed.get(person)) continue;
    if (index === start) furthest.set(person, start + 1);
    else skipped.push(index + 1);
  }
  const labels = ["登录", ...ONBOARDING_STEPS.map(([, label]) => label), "完成"];
  const steps = keys.map((key, index) => {
    const people = [...furthest.values()].filter((value) => value >= index).length;
    return { key, label: labels[index], units: people, people };
  });
  const breaks = keys.map((key, index) => ({ step: key, label: "跳过", count: skipped.filter((value) => value === index).length })).filter((item) => item.count > 0);
  return { key: "onboarding", title: "上手", unit: "人", shape: "funnel", steps, stuckStep: funnel(steps), breaks };
}

type LedgerRow = { key: string; source: TUsageLedgerItem["source"]; label: string; person: string | null; at: Date; open: boolean };

/** 问题台账：与管理员视图同源（质量信号、失败的运行、后台任务、本体写入），加上影响卡「和我无关」；在管理员视图里标了「已解决」的不算未处理。 */
async function ledgerRows(q: Query, range: Range, marks: MarkIndex): Promise<LedgerRow[]> {
  const [runs, jobs, ledger, meetingEvents, irrelevant] = await Promise.all([
    q(`SELECT id::text, kind, status, input_snapshot->'qualitySignals' AS signals, input_snapshot->>'viewerId' AS viewer_id, COALESCE(completed_at, started_at) AS at
       FROM agent_runs WHERE started_at >= $1 AND started_at < $2 AND (input_snapshot ? 'qualitySignals' OR status = 'failed')`, [range.from, range.to]),
    q(`SELECT id::text, kind, updated_at FROM jobs WHERE (status = 'dead' OR (status = 'pending' AND last_error IS NOT NULL)) AND updated_at >= $1 AND updated_at < $2`, [range.from, range.to]),
    q(`SELECT * FROM (SELECT DISTINCT ON (instance, idempotency_key) idempotency_key, action_type, status, created_at
         FROM world_sync_ledger ORDER BY instance, idempotency_key, id DESC) latest
       WHERE status IN ('failed', 'network_error') AND created_at >= $1 AND created_at < $2`, [range.from, range.to]),
    q(`SELECT e.id::text, e.created_at FROM world_meeting_events e
       WHERE e.status = 'failed' AND e.created_at >= $1 AND e.created_at < $2 AND NOT EXISTS (SELECT 1 FROM world_meeting_events later
         WHERE later.instance = e.instance AND later.meeting_id = e.meeting_id AND later.id > e.id AND later.status = 'committed')`, [range.from, range.to]),
    q(`SELECT person_id, irrelevant_at FROM impact_cards WHERE status = 'irrelevant' AND irrelevant_at >= $1 AND irrelevant_at < $2`, [range.from, range.to]),
  ]);
  const rows: LedgerRow[] = [];
  for (const run of runs.rows as { id: string; kind: string; status: string; signals: unknown; viewer_id: string | null; at: Date }[]) {
    const open = !resolvedSince(marks, "quality", run.id, run.at);
    const push = (key: string, label: string) => rows.push({ key, source: "quality", label, person: run.viewer_id, at: run.at, open });
    for (const item of Array.isArray(run.signals) ? run.signals as { signal?: unknown; kind?: unknown; tool?: unknown }[] : []) {
      if (item?.kind === "tool_error") push(`tool_error:${String(item.tool)}`, `工具报错 · ${String(item.tool)}`);
      else if (item?.signal === "memory_mark_unknown_id") push("memory_mark_unknown_id", "记忆标记对不上");
      else if (typeof item?.signal === "string") push(item.signal, item.signal);
    }
    if (run.status === "failed") push(`run_failed:${run.kind}`, `运行失败 · ${run.kind === "conversation" ? "对话" : run.kind}`);
  }
  for (const job of jobs.rows as { id: string; kind: string; updated_at: Date }[]) {
    rows.push({ key: `job:${job.kind}`, source: "job", label: `后台任务失败 · ${job.kind}`, person: null, at: job.updated_at, open: !resolvedSince(marks, "job", job.id, job.updated_at) });
  }
  for (const write of ledger.rows as { idempotency_key: string; action_type: string; created_at: Date }[]) {
    rows.push({ key: `world:${write.action_type}`, source: "world", label: `本体写入失败 · ${write.action_type}`, person: null, at: write.created_at,
      open: !resolvedSince(marks, "world_write", write.idempotency_key, write.created_at) });
  }
  for (const event of meetingEvents.rows as { id: string; created_at: Date }[]) {
    rows.push({ key: "world:meeting_event", source: "world", label: "本体写入失败 · 会后事件", person: null, at: event.created_at,
      open: !resolvedSince(marks, "world_write", `meeting-event:${event.id}`, event.created_at) });
  }
  for (const card of irrelevant.rows as { person_id: string; irrelevant_at: Date }[]) {
    rows.push({ key: "impact_irrelevant", source: "feedback", label: "影响卡「和我无关」", person: card.person_id, at: card.irrelevant_at, open: true });
  }
  return rows;
}

function groupLedger(rows: LedgerRow[], previous: LedgerRow[]): TUsageLedgerItem[] {
  const groups = new Map<string, LedgerRow[]>();
  for (const row of rows) groups.set(row.key, [...(groups.get(row.key) ?? []), row]);
  return [...groups.entries()].map(([key, items]) => ({
    key, source: items[0].source, label: items[0].label, count: items.length, people: distinct(items, (item) => item.person), open: count(items, (item) => item.open),
    previousCount: count(previous, (item) => item.key === key), lastAt: new Date(Math.max(...items.map((item) => item.at.getTime()))).toISOString(),
  })).sort((a, b) => b.count - a.count || b.lastAt.localeCompare(a.lastAt)).slice(0, LEDGER_LIMIT);
}

type Week = { range: Range; days: Map<string, Set<string>>; asks: Map<string, number>; paths: Omit<TUsagePath, "previousUnits">[]; breaksOf: Map<string, number>; ledger: LedgerRow[] };

async function readWeek(q: Query, weekStart: string, at: Date, marks: MarkIndex): Promise<Week> {
  const range = { from: startOf(weekStart), to: startOf(addDays(weekStart, 7)), at };
  const [days, asks, conversation, meeting, memory, onboarding, ledger] = await Promise.all([
    q(`SELECT DISTINCT person_id, to_char(day, 'YYYY-MM-DD') AS day FROM (
         SELECT person_id, day FROM usage_events WHERE kind IN ('active', 'login') AND created_at >= $1 AND created_at < $2
         UNION ALL SELECT input_snapshot->>'viewerId', (started_at AT TIME ZONE 'Asia/Shanghai')::date FROM agent_runs
           WHERE kind = 'conversation' AND input_snapshot ? 'viewerId' AND started_at >= $1 AND started_at < $2) active`, [range.from, range.to]),
    q(`SELECT input_snapshot->>'viewerId' AS person_id, count(*)::int AS asks FROM agent_runs
       WHERE kind = 'conversation' AND NOT (input_snapshot ? 'resumeOf') AND started_at >= $1 AND started_at < $2 GROUP BY 1`, [range.from, range.to]),
    conversationPath(q, range), meetingPath(q, range), memoryPath(q, range), onboardingPath(q, range), ledgerRows(q, range, marks),
  ]);
  const activeDays = new Map<string, Set<string>>();
  for (const row of days.rows as { person_id: string; day: string }[]) activeDays.set(row.person_id, (activeDays.get(row.person_id) ?? new Set()).add(row.day));
  return {
    range, days: activeDays, asks: new Map((asks.rows as { person_id: string; asks: number }[]).map((row) => [row.person_id, row.asks])),
    paths: [conversation.path, meeting, memory, onboarding], breaksOf: conversation.breaksOf, ledger,
  };
}

function summaryOf(week: Week, roster: string[]): TUsageSummary {
  const active = roster.filter((id) => week.days.has(id));
  const days = active.reduce((sum, id) => sum + week.days.get(id)!.size, 0);
  return {
    roster: roster.length, activePeople: active.length, avgActiveDays: active.length ? Math.round((days / active.length) * 10) / 10 : 0,
    asks: roster.reduce((sum, id) => sum + (week.asks.get(id) ?? 0), 0),
  };
}

/** 算一周的周报（本周还没过完时 live = true）；上一周现算作对比。 */
export async function buildUsageReport(q: Query, peopleDirectory: PeopleDirectory, weekStart: string, now: Date): Promise<TUsageWeekReport> {
  const roster = adminPeople(peopleDirectory);
  const ids = roster.map((person) => person.personId);
  const marks = await readMarks(q);
  const [week, previous] = await Promise.all([readWeek(q, weekStart, now, marks), readWeek(q, addDays(weekStart, -7), now, marks)]);
  const people: TUsagePersonRow[] = roster.map((person) => ({
    personId: person.personId, displayName: person.displayName, days: [...(week.days.get(person.personId) ?? [])].sort(),
    asks: week.asks.get(person.personId) ?? 0, breaks: week.breaksOf.get(person.personId) ?? 0, previousActiveDays: previous.days.get(person.personId)?.size ?? 0,
  })).sort((a, b) => b.days.length - a.days.length || b.asks - a.asks || a.displayName.localeCompare(b.displayName, "zh-CN"));
  return {
    weekStart, weekEnd: addDays(weekStart, 6), generatedAt: now.toISOString(), live: now < week.range.to,
    summary: summaryOf(week, ids), previous: summaryOf(previous, ids), people,
    paths: week.paths.map((path, index) => ({ ...path, previousUnits: previous.paths[index].steps.map((step) => step.units) })),
    ledger: groupLedger(week.ledger, previous.ledger),
  };
}

/** 周一 08:00 之后补上一周的周报；已经有了就不再算。 */
export async function ensureLastWeekReport(q: Query, peopleDirectory: PeopleDirectory, now: Date): Promise<string | null> {
  const thisWeek = weekStartOf(now);
  if (now.getTime() < startOf(thisWeek).getTime() + REPORT_HOUR * 3_600_000) return null;
  const weekStart = addDays(thisWeek, -7);
  if ((await q("SELECT 1 FROM usage_weekly_reports WHERE week_start = $1", [weekStart])).rows.length) return null;
  const report = await buildUsageReport(q, peopleDirectory, weekStart, now);
  await q("INSERT INTO usage_weekly_reports (week_start, report, generated_at) VALUES ($1, $2::jsonb, $3) ON CONFLICT (week_start) DO NOTHING",
    [weekStart, JSON.stringify(report), now]);
  return weekStart;
}

/** 每小时看一次：周一 08:00 之后第一次跑时生成上一周的周报（服务那时没起来，之后补）。 */
export function usageReportJobs(q: Query, peopleDirectory: PeopleDirectory, now: () => Date): { handlers: Record<string, JobHandler>; recurring: RecurringJob[] } {
  return { handlers: { [USAGE_REPORT_KIND]: async () => { await ensureLastWeekReport(q, peopleDirectory, now()); } }, recurring: [{ kind: USAGE_REPORT_KIND, everyMs: 3_600_000 }] };
}

/** 管理员视图「使用」：本周现算，过去各周读存下的那一份。 */
export async function readUsage(q: Query, peopleDirectory: PeopleDirectory, week: string | undefined, now: Date): Promise<TUsageResponse | null> {
  const current = weekStartOf(now);
  const stored = (await q("SELECT to_char(week_start, 'YYYY-MM-DD') AS week_start FROM usage_weekly_reports WHERE week_start < $1 ORDER BY week_start DESC", [current])).rows as { week_start: string }[];
  const weeks = [{ weekStart: current, live: true }, ...stored.map((row) => ({ weekStart: row.week_start, live: false }))];
  const selected = week ?? current;
  if (selected === current) return { weeks, report: await buildUsageReport(q, peopleDirectory, current, now) };
  const row = (await q("SELECT report FROM usage_weekly_reports WHERE week_start = $1", [selected])).rows[0] as { report: TUsageWeekReport } | undefined;
  return row ? { weeks, report: row.report } : null;
}

const signed = (value: number) => (value > 0 ? `+${value}` : value < 0 ? `${value}` : "±0");
const percent = (part: number, whole: number) => (whole ? `${Math.round((part / whole) * 100)}%` : "—");
const shortDay = (day: string) => `${Number(day.slice(5, 7))}/${Number(day.slice(8, 10))}`;
const cell = (text: string) => text.replace(/\|/g, "\\|");

/** 导出 Markdown（贴到飞书）：概况、谁在用、关键路径、问题台账。 */
export function usageMarkdown(report: TUsageWeekReport): string {
  const { summary: now, previous: before } = report;
  const lines = [
    `# 天枢使用周报 · ${shortDay(report.weekStart)}–${shortDay(report.weekEnd)}${report.live ? "（本周进行中）" : ""}`,
    "",
    `生成于 ${new Date(new Date(report.generatedAt).getTime() + OFFSET_MS).toISOString().slice(0, 16).replace("T", " ")}`,
    "",
    "## 概况",
    "",
    "| 指标 | 本周 | 上周 | 变化 |",
    "| --- | --- | --- | --- |",
    `| 活跃人数 | ${now.activePeople}/${now.roster} | ${before.activePeople}/${before.roster} | ${signed(now.activePeople - before.activePeople)} |`,
    `| 人均活跃天数 | ${now.avgActiveDays} | ${before.avgActiveDays} | ${signed(Math.round((now.avgActiveDays - before.avgActiveDays) * 10) / 10)} |`,
    `| 发问 | ${now.asks} | ${before.asks} | ${signed(now.asks - before.asks)} |`,
    "",
    "## 谁在用",
    "",
    "| 人 | 活跃天数 | 上周 | 发问 | 对话中断 |",
    "| --- | --- | --- | --- | --- |",
    ...report.people.map((person) => `| ${cell(person.displayName)} | ${person.days.length} | ${person.previousActiveDays} | ${person.asks} | ${person.breaks} |`),
    "",
    "## 关键路径",
  ];
  for (const path of report.paths) {
    lines.push("", `### ${path.title}（${path.unit}）`, "");
    if (path.shape === "counts") {
      lines.push("| 项 | 次数 | 人 | 上周 |", "| --- | --- | --- | --- |",
        ...path.steps.map((step, index) => `| ${step.label} | ${step.units} | ${step.people} | ${path.previousUnits[index] ?? 0} |`));
      continue;
    }
    if (!path.steps[0]?.units) { lines.push(`无（上周 ${path.previousUnits[0] ?? 0}）`); continue; }
    lines.push(`| 步骤 | 到达 | 人 | 转化 | 上周 |`, "| --- | --- | --- | --- | --- |",
      ...path.steps.map((step, index) => `| ${step.key === path.stuckStep ? `**${step.label}**` : step.label} | ${step.units} | ${step.people} | ${index ? percent(step.units, path.steps[index - 1].units) : "—"} | ${path.previousUnits[index] ?? 0} |`));
    const stuck = path.steps.find((step) => step.key === path.stuckStep);
    if (stuck) {
      const index = path.steps.indexOf(stuck);
      const reasons = path.breaks.filter((item) => item.step === stuck.key).map((item) => `${item.label} ${item.count}`).join("、");
      lines.push("", `卡住最多：${path.steps[index - 1].label} → ${stuck.label}（−${path.steps[index - 1].units - stuck.units}${reasons ? `：${reasons}` : ""}）`);
    }
    const others = path.breaks.filter((item) => item.step !== path.stuckStep);
    if (others.length) lines.push("", `其他中断：${others.map((item) => `${path.steps.find((step) => step.key === item.step)?.label ?? item.step} · ${item.label} ${item.count}`).join("、")}`);
  }
  lines.push("", `## 问题台账（前 ${LEDGER_LIMIT}）`, "");
  if (!report.ledger.length) lines.push("无");
  else lines.push("| 问题 | 次数 | 人 | 未处理 | 上周 |", "| --- | --- | --- | --- | --- |",
    ...report.ledger.map((item) => `| ${cell(item.label)} | ${item.count} | ${item.people} | ${item.open} | ${item.previousCount} |`));
  return `${lines.join("\n")}\n`;
}

