import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  TAdminActionRequest, TAdminCollectorDevice, TAdminCounter, TAdminIssue, TAdminMark, TAdminOverviewResponse, TAdminPersonRow,
  TAdminQualitySignal, TAdminStatus, TAdminSubjectType,
} from "@warmap/contracts";
import { collectorHealthOf, workdayHours } from "./collector.js";
import { REAUTH_AFTER_DAYS } from "./feishu/refresh.js";
import type { PeopleDirectory } from "./peopleDirectory.js";
import type { Query } from "./meetingStore.js";
import { insertNotification } from "./notifications.js";
import { isRealPerson } from "./people.js";

/**
 * 管理员视图（已定设计第 10 节）：只读运行数据——采集器健康、飞书令牌、周复盘写本体、jobs、本体台账、agent_runs 的质量信号，
 * 不读对话正文。操作（提醒、已接手、已解决、重试）一次一行记进 admin_incidents（迁移 095）。
 */

/** 环境变量 TIANSHU_ADMIN_PERSON_IDS：逗号分隔的 personId。 */
export function parseAdminPersonIds(value: string | undefined): string[] {
  return [...new Set((value ?? "").split(",").map((id) => id.trim()).filter(Boolean))];
}

const RANK: Record<TAdminStatus, number> = { red: 0, yellow: 1, none: 2, green: 3 };
const worst = (statuses: TAdminStatus[]): TAdminStatus => statuses.reduce((a, b) => (RANK[b] < RANK[a] ? b : a), "green" as TAdminStatus);
const iso = (value: Date | null | undefined) => value ? value.toISOString() : null;
/** 周复盘提交后超过一小时还没写完本体，记黄。 */
const WORLD_PENDING_MS = 60 * 60_000;
const QUALITY_WINDOW_DAYS = 7;
const LIST_LIMIT = 100;

type Mark = { action: string; actor_id: string; created_at: Date };
export type MarkIndex = { latest: Map<string, Mark>; reminded: Map<string, Date> };
const key = (type: TAdminSubjectType, id: string) => `${type}\u0000${id}`;

export async function readMarks(q: Query): Promise<MarkIndex> {
  const marks = await q(`SELECT DISTINCT ON (subject_type, subject_id) subject_type, subject_id, action, actor_id, created_at
    FROM admin_incidents WHERE action IN ('acknowledge', 'resolve') ORDER BY subject_type, subject_id, created_at DESC`);
  const reminders = await q(`SELECT subject_type, subject_id, max(created_at) AS at FROM admin_incidents WHERE action = 'remind' GROUP BY subject_type, subject_id`);
  return {
    latest: new Map((marks.rows as (Mark & { subject_type: TAdminSubjectType; subject_id: string })[]).map((row) => [key(row.subject_type, row.subject_id), row])),
    reminded: new Map((reminders.rows as { subject_type: TAdminSubjectType; subject_id: string; at: Date }[]).map((row) => [key(row.subject_type, row.subject_id), row.at])),
  };
}

/** 「已接手」只在最近一次标记是 acknowledge 时显示。 */
const acknowledged = (marks: MarkIndex, names: Map<string, string>, type: TAdminSubjectType, id: string): TAdminMark | null => {
  const mark = marks.latest.get(key(type, id));
  return mark?.action === "acknowledge" ? { actorName: names.get(mark.actor_id) ?? mark.actor_id, at: mark.created_at.toISOString() } : null;
};
/** 失败列表：解决时间不早于这次失败的，不再列出（之后又失败会重新出现）。 */
export const resolvedSince = (marks: MarkIndex, type: TAdminSubjectType, id: string, failedAt: Date) => {
  const mark = marks.latest.get(key(type, id));
  return mark?.action === "resolve" && mark.created_at.getTime() >= failedAt.getTime();
};

type CollectorRow = {
  person_id: string; device_name: string; platform: string; source: string; collector_version: string; source_status: string; error_code: string | null;
  first_seen_at: Date; last_attempt_at: Date; last_success_at: Date | null; coverage_until: Date | null; last_new_evidence_at: Date | null;
};
type FeishuRow = { person_id: string; status: "active" | "reauth_required"; authorized_at: Date; last_refreshed_at: Date | null; reauth_reminder_at: Date | null };
type WeeklyRow = { person_id: string; week_start: string; submitted_at: Date; world_sync_status: "pending" | "done" | "failed"; failed_targets: number; last_done_at: Date | null };

/** 名单：能用天枢的真人（CEO、DRI、参与人），不含会议纪要一类的记录账号。 */
export function adminPeople(peopleDirectory: PeopleDirectory) {
  return peopleDirectory.searchPeople(undefined)
    .filter((person) => isRealPerson(person) && person.roles.some((role) => role === "ceo" || role === "dri" || role === "participant"));
}

async function readPeople(q: Query, peopleDirectory: PeopleDirectory, marks: MarkIndex, names: Map<string, string>, now: Date): Promise<TAdminPersonRow[]> {
  const [collector, feishu, weekly] = await Promise.all([
    q(`SELECT person_id, device_name, platform, source, collector_version, source_status, error_code,
        first_seen_at, last_attempt_at, last_success_at, coverage_until, last_new_evidence_at
       FROM collector_health WHERE source_status <> 'not_found' ORDER BY person_id, last_success_at DESC NULLS LAST, device_name, source`),
    q("SELECT person_id, status, authorized_at, last_refreshed_at, reauth_reminder_at FROM feishu_user_tokens"),
    q(`SELECT DISTINCT ON (person_id) person_id, to_char(week_start, 'YYYY-MM-DD') AS week_start, submitted_at, world_sync_status,
        (SELECT count(*)::int FROM jsonb_array_elements(world_sync) AS item WHERE item->>'status' = 'failed') AS failed_targets,
        (SELECT max(submitted_at) FROM weekly_reviews done WHERE done.person_id = w.person_id AND done.world_sync_status = 'done') AS last_done_at
       FROM weekly_reviews w WHERE status = 'submitted' AND world_sync_status <> 'none'
       ORDER BY person_id, submitted_at DESC`),
  ]);
  const devicesOf = new Map<string, CollectorRow[]>();
  for (const row of collector.rows as CollectorRow[]) devicesOf.set(row.person_id, [...(devicesOf.get(row.person_id) ?? []), row]);
  const feishuOf = new Map((feishu.rows as FeishuRow[]).map((row) => [row.person_id, row]));
  const weeklyOf = new Map((weekly.rows as WeeklyRow[]).map((row) => [row.person_id, row]));
  const remindedAt = (type: TAdminSubjectType, id: string) => iso(marks.reminded.get(key(type, id)));
  const markOf = (type: TAdminSubjectType, id: string, status: TAdminStatus) =>
    status === "red" || status === "yellow" ? acknowledged(marks, names, type, id) : null;

  const rows = adminPeople(peopleDirectory).map((person): TAdminPersonRow & { since: number } => {
    const id = person.personId;
    // 采集器：多台设备、多个来源里最近一次成功同步；从没成功过的按首次出现算断档时长。
    const devices = devicesOf.get(id) ?? [];
    const lastSuccess = devices.reduce<Date | null>((best, row) => row.last_success_at && (!best || row.last_success_at > best) ? row.last_success_at : best, null);
    const firstSeen = devices.reduce<Date | null>((best, row) => !best || row.first_seen_at < best ? row.first_seen_at : best, null);
    const collectorStatus: TAdminStatus = devices.length ? collectorHealthOf(workdayHours(lastSuccess ?? firstSeen!, now)) : "none";
    // 飞书：需要重新授权记红，满 330 天该提醒重新授权记黄。
    const token = feishuOf.get(id);
    const feishuStatus: TAdminStatus = !token ? "none" : token.status === "reauth_required" ? "red" : token.reauth_reminder_at ? "yellow" : "green";
    // 本体：最近一份提交的周复盘写本体的结果。
    const review = weeklyOf.get(id);
    const worldStatus: TAdminStatus = !review ? "none" : review.world_sync_status === "failed" ? "red"
      : review.world_sync_status === "pending" && now.getTime() - review.submitted_at.getTime() > WORLD_PENDING_MS ? "yellow" : "green";
    const successes = [lastSuccess, token ? token.last_refreshed_at ?? token.authorized_at : null, review?.last_done_at ?? null];
    return {
      personId: id,
      displayName: person.displayName,
      collector: {
        status: collectorStatus, lastSuccessAt: iso(lastSuccess), acknowledged: markOf("collector", id, collectorStatus), remindedAt: remindedAt("collector", id),
        devices: devices.map((row): TAdminCollectorDevice => ({
          deviceName: row.device_name, platform: row.platform, source: row.source, version: row.collector_version, sourceStatus: row.source_status,
          errorCode: row.error_code, firstSeenAt: row.first_seen_at.toISOString(), lastAttemptAt: row.last_attempt_at.toISOString(),
          lastSuccessAt: iso(row.last_success_at), coverageUntil: iso(row.coverage_until), lastNewEvidenceAt: iso(row.last_new_evidence_at),
        })),
      },
      feishu: {
        status: feishuStatus, lastSuccessAt: iso(token ? token.last_refreshed_at ?? token.authorized_at : null),
        acknowledged: markOf("feishu", id, feishuStatus), remindedAt: remindedAt("feishu", id),
        tokenStatus: token?.status ?? null, authorizedAt: iso(token?.authorized_at), reauthDueAt: iso(token ? new Date(token.authorized_at.getTime() + REAUTH_AFTER_DAYS * 86_400_000) : null), reauthReminderAt: iso(token?.reauth_reminder_at),
      },
      world: {
        status: worldStatus, lastSuccessAt: iso(review?.last_done_at), acknowledged: markOf("world", id, worldStatus), remindedAt: remindedAt("world", id),
        lastWeek: review?.week_start ?? null, syncStatus: review?.world_sync_status ?? null, failedTargets: review?.failed_targets ?? 0,
      },
      // 排序：最差的状态在前；同一档里最久没成功过的在前（从没成功过的最前）。
      since: Math.min(...successes.map((at, index) => [collectorStatus, feishuStatus, worldStatus][index] === "none" ? Infinity : at ? at.getTime() : -Infinity)),
    };
  });
  rows.sort((a, b) => RANK[worst([a.collector.status, a.feishu.status, a.world.status])] - RANK[worst([b.collector.status, b.feishu.status, b.world.status])]
    || a.since - b.since || a.displayName.localeCompare(b.displayName, "zh-CN"));
  return rows.map(({ since: _since, ...row }) => row);
}

/** 失败列表，加上其中待核验的那几条（列出来，但不算「本体写入失败」）。 */
async function readIssues(q: Query, marks: MarkIndex, names: Map<string, string>): Promise<{ issues: TAdminIssue[]; unverified: ReadonlySet<TAdminIssue> }> {
  const [jobs, ledger, meetings] = await Promise.all([
    q(`SELECT id::text, kind, status, attempts, last_error, updated_at FROM jobs
       WHERE status = 'dead' OR (status = 'pending' AND last_error IS NOT NULL) ORDER BY updated_at DESC LIMIT ${LIST_LIMIT}`),
    // 同一幂等键只看最近一次：重放成功了就不算失败。
    q(`SELECT * FROM (SELECT DISTINCT ON (instance, idempotency_key) idempotency_key, action_type, target_ref, status, error_code, created_at
         FROM world_sync_ledger ORDER BY instance, idempotency_key, id DESC) latest
       WHERE status IN ('failed', 'network_error', 'unverified') ORDER BY created_at DESC LIMIT ${LIST_LIMIT}`),
    // 会后事件：同一场会之后有写成功的版本就不算。
    q(`SELECT e.id::text, e.meeting_id::text, e.error_code, e.created_at FROM world_meeting_events e
       WHERE e.status = 'failed' AND NOT EXISTS (SELECT 1 FROM world_meeting_events later
         WHERE later.instance = e.instance AND later.meeting_id = e.meeting_id AND later.id > e.id AND later.status = 'committed')
       ORDER BY e.created_at DESC LIMIT ${LIST_LIMIT}`),
  ]);
  const issues: TAdminIssue[] = [];
  const unverified = new Set<TAdminIssue>();
  for (const row of jobs.rows as { id: string; kind: string; status: string; attempts: number; last_error: string | null; updated_at: Date }[]) {
    if (resolvedSince(marks, "job", row.id, row.updated_at)) continue;
    issues.push({ subject: { type: "job", id: row.id }, status: row.status === "dead" ? "red" : "yellow", name: row.kind, target: null,
      code: row.last_error ? row.last_error.slice(0, 160) : null, attempts: row.attempts, at: row.updated_at.toISOString(),
      retryable: row.status === "dead", acknowledged: acknowledged(marks, names, "job", row.id) });
  }
  for (const row of ledger.rows as { idempotency_key: string; action_type: string; target_ref: string | null; status: string; error_code: string | null; created_at: Date }[]) {
    if (resolvedSince(marks, "world_write", row.idempotency_key, row.created_at)) continue;
    const issue: TAdminIssue = { subject: { type: "world_write", id: row.idempotency_key }, status: row.status === "failed" ? "red" : "yellow", name: row.action_type,
      target: row.target_ref, code: row.status === "unverified" ? "待核验" : row.error_code, attempts: null, at: row.created_at.toISOString(), retryable: false,
      acknowledged: acknowledged(marks, names, "world_write", row.idempotency_key) };
    issues.push(issue);
    if (row.status === "unverified") unverified.add(issue);
  }
  for (const row of meetings.rows as { id: string; meeting_id: string; error_code: string | null; created_at: Date }[]) {
    const id = `meeting-event:${row.id}`;
    if (resolvedSince(marks, "world_write", id, row.created_at)) continue;
    issues.push({ subject: { type: "world_write", id }, status: "red", name: "meeting_event", target: `meeting:${row.meeting_id}`,
      code: row.error_code, attempts: null, at: row.created_at.toISOString(), retryable: false, acknowledged: acknowledged(marks, names, "world_write", id) });
  }
  return { issues: issues.sort((a, b) => RANK[a.status] - RANK[b.status] || b.at.localeCompare(a.at)), unverified };
}

/** 最近 7 天：qualitySignals 里的每一项，以及失败的运行。只取信号名、计数、谁、什么时候，不取输入和输出。 */
async function readQuality(q: Query, marks: MarkIndex, names: Map<string, string>, now: Date): Promise<TAdminQualitySignal[]> {
  const result = await q(
    `SELECT id::text, kind, status, input_snapshot->'qualitySignals' AS signals, input_snapshot->>'viewerId' AS viewer_id, COALESCE(completed_at, started_at) AS at
     FROM agent_runs
     WHERE started_at >= $1::timestamptz - make_interval(days => ${QUALITY_WINDOW_DAYS}) AND (input_snapshot ? 'qualitySignals' OR status = 'failed')
     ORDER BY started_at DESC LIMIT ${LIST_LIMIT}`,
    [now],
  );
  const signals: TAdminQualitySignal[] = [];
  for (const row of result.rows as { id: string; kind: string; status: string; signals: unknown; viewer_id: string | null; at: Date }[]) {
    if (resolvedSince(marks, "quality", row.id, row.at)) continue;
    const entries = Array.isArray(row.signals)
      ? (row.signals as { signal?: unknown; ids?: unknown }[]).filter((item) => typeof item?.signal === "string")
        .map((item) => ({ signal: item.signal as string, count: Array.isArray(item.ids) && item.ids.length ? item.ids.length : 1 }))
      : [];
    if (row.status === "failed") entries.push({ signal: "run_failed", count: 1 });
    for (const entry of entries) {
      signals.push({ subject: { type: "quality", id: row.id }, signal: entry.signal, runKind: row.kind,
        personName: row.viewer_id ? names.get(row.viewer_id) ?? row.viewer_id : null, count: entry.count, at: row.at.toISOString(),
        acknowledged: acknowledged(marks, names, "quality", row.id) });
    }
  }
  return signals;
}

function counters(people: TAdminPersonRow[], issues: TAdminIssue[], unverified: ReadonlySet<TAdminIssue>): TAdminCounter[] {
  const tally = (statuses: TAdminStatus[]): Pick<TAdminCounter, "value" | "status"> => {
    const bad = statuses.filter((status) => status === "red" || status === "yellow");
    return { value: bad.length, status: bad.length ? worst(bad) : "green" };
  };
  return [
    { key: "collector_gap", ...tally(people.map((person) => person.collector.status)) },
    { key: "feishu_auth", ...tally(people.map((person) => person.feishu.status)) },
    // 会议链路、推送那条工作流合入后再接，先占位。
    { key: "meeting_stuck", value: 0, status: "none" },
    { key: "delivery_failed", value: 0, status: "none" },
    { key: "world_failed", ...tally(issues.filter((issue) => issue.subject.type === "world_write" && !unverified.has(issue)).map((issue) => issue.status)) },
    { key: "job_failed", ...tally(issues.filter((issue) => issue.subject.type === "job").map((issue) => issue.status)) },
  ];
}

export async function readAdminOverview(q: Query, peopleDirectory: PeopleDirectory, names: Map<string, string>, viewerId: string, now: Date): Promise<TAdminOverviewResponse> {
  const marks = await readMarks(q);
  const [people, { issues, unverified }, quality] = await Promise.all([
    readPeople(q, peopleDirectory, marks, names, now), readIssues(q, marks, names), readQuality(q, marks, names, now),
  ]);
  return { generatedAt: now.toISOString(), viewerId, counters: counters(people, issues, unverified), people, issues, quality };
}

export type AdminActionError = { status: number; code: string; message: string };

/**
 * 管理员操作，同一事务里做事并留痕；clientId 已经记过的直接返回（重放不再发提醒、不再重跑）。
 * - remind：经送达通道给本人发一条请求（发起人是管理员），本人在通知栏「请求」里收到；
 * - acknowledge / resolve：只记一行；
 * - retry：只对 dead 的后台任务，回到 pending、次数清零、马上可领。
 */
export async function executeAdminAction(pool: Pool, peopleDirectory: PeopleDirectory, actorId: string, input: TAdminActionRequest): Promise<AdminActionError | null> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    // 同一 clientId 的并发重放排队，第二个看到第一行后直接返回。
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [input.clientId]);
    if ((await client.query("SELECT 1 FROM admin_incidents WHERE id = $1", [input.clientId])).rowCount) {
      await client.query("ROLLBACK");
      return null;
    }
    const record = (subjectType: TAdminSubjectType, subjectId: string, detail: object = {}, requestId: string | null = null) => client.query(
      `INSERT INTO admin_incidents (id, action, subject_type, subject_id, actor_id, request_id, detail) VALUES ($1, $2, $3, $4, $5, $6, $7::jsonb)`,
      [input.clientId, input.action, subjectType, subjectId, actorId, requestId, JSON.stringify(detail)],
    );
    let error: AdminActionError | null = null;
    if (input.action === "remind") {
      if (input.personId === actorId) error = { status: 400, code: "INVALID_RECIPIENT", message: "不能提醒自己" };
      else if (!adminPeople(peopleDirectory).some((person) => person.personId === input.personId)) error = { status: 400, code: "INVALID_RECIPIENT", message: "这个人不在名单里" };
      else {
        const requestId = randomUUID();
        const title = input.title.trim(), body = input.body.trim();
        await client.query(`INSERT INTO requests (id, kind, initiator_id, prompt, title, body, status, sent_at)
          VALUES ($1, 'relay', $2, $3, $3, $4, 'open', now())`, [requestId, actorId, title, body]);
        await client.query("INSERT INTO request_recipients (request_id, person_id) VALUES ($1, $2)", [requestId, input.personId]);
        await insertNotification(client, { personId: input.personId, kind: "request_received", objectType: "request", objectId: requestId, actorId });
        await record(input.source, input.personId, {}, requestId);
      }
    } else if (input.action === "retry") {
      const job = (await client.query("SELECT id::text, kind, attempts, last_error FROM jobs WHERE id = $1::bigint AND status = 'dead' FOR UPDATE", [input.subject.id])).rows[0] as
        { id: string; kind: string; attempts: number; last_error: string | null } | undefined;
      if (!job) error = { status: 409, code: "JOB_NOT_DEAD", message: "这个任务已经不在失败状态" };
      else {
        await client.query("UPDATE jobs SET status = 'pending', attempts = 0, run_at = now(), lease_until = NULL, last_error = NULL, updated_at = now() WHERE id = $1::bigint", [job.id]);
        await record("job", job.id, { kind: job.kind, attempts: job.attempts, lastError: job.last_error?.slice(0, 500) ?? null });
      }
    } else {
      await record(input.subject.type, input.subject.id);
    }
    await client.query(error ? "ROLLBACK" : "COMMIT");
    return error;
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw cause;
  } finally {
    client.release();
  }
}
