import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  TActionDescriptor, TWeeklyReviewBoard, TWeeklyReviewBody, TWeeklyReviewField, TWeeklyReviewGenerationStep, TWeeklyReviewOrigin,
  TWeeklyReviewPayload, TWeeklyReviewRevision, TWeeklyReviewStatus, TWeeklyReviewUpdateInput,
} from "@warmap/contracts";
import { signActionId, type ActionScope } from "./actionToken.js";
import type { Query } from "./meetingStore.js";
import type { ReviewViewer } from "./monthlyReviews.js";
import { weekRange } from "./weeklyProgress.js";

/**
 * 周复盘仓储（D-01）：表 weekly_reviews（083）。可见范围在这一层判：本人、同一战场的人、CEO；
 * 别人只在提交后看得到正文。修改、提交、重新生成只有本人能做；每次改动记一条修改记录。
 */

export const WEEKLY_REVIEW_FIELDS: TWeeklyReviewField[] = ["overall", "progress", "issues", "implications", "actions"];
/** 提交前必须写的段。 */
export const WEEKLY_REVIEW_REQUIRED: TWeeklyReviewField[] = ["overall", "progress"];
export const WEEKLY_REVIEW_FIELD_LABELS: Record<TWeeklyReviewField, string> = {
  overall: "本周总体判断", progress: "关键进展与 Evidence", issues: "最重要的问题及 Why", implications: "判断变化 / Implication", actions: "当前处理",
};
type StepId = TWeeklyReviewGenerationStep["id"];
const STEP_LABELS: Record<StepId, string> = {
  missions: "读 Mission 卡", progress: "读 Mission 与 Task 进展", meetings: "读会议结论", collector: "读采集记录", previous: "读上周复盘", draft: "起草",
};
export const pendingWeeklySteps = (): TWeeklyReviewGenerationStep[] =>
  (Object.keys(STEP_LABELS) as StepId[]).map((id) => ({ id, label: STEP_LABELS[id], status: "pending" }));

type RevisionSource = "co_agent" | "manual" | "agent_tool" | "import";
/** 存在库里的修改记录：比接口多「改之前的原文」。 */
export type StoredRevision = { at: string; kind: TWeeklyReviewRevision["kind"]; by: string | null; source: RevisionSource;
  fields: TWeeklyReviewField[]; previous?: Partial<Record<TWeeklyReviewField, string>> };
const MAX_REVISIONS = 100;

export type WeeklyReviewRow = {
  id: string; version: number; person_id: string; week_start: string; status: TWeeklyReviewStatus; origin: TWeeklyReviewOrigin;
  body: TWeeklyReviewBody | null; draft_source: RevisionSource | null; draft_error: TWeeklyReviewPayload["draftError"];
  generation_steps: TWeeklyReviewGenerationStep[]; edited_fields: TWeeklyReviewField[]; revisions: StoredRevision[];
  import_source: { title: string; url: string } | null; action_fingerprints: string[]; submitted_at: Date | null;
  world_sync_status: "none" | "pending" | "done" | "failed"; world_sync: unknown[]; created_at: Date; updated_at: Date;
};
const COLUMNS = `id, version, person_id, to_char(week_start,'YYYY-MM-DD') AS week_start, status, origin, body, draft_source, draft_error,
  generation_steps, edited_fields, revisions, import_source, action_fingerprints, submitted_at, world_sync_status, world_sync, created_at, updated_at`;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const DAY_MS = 86_400_000;

// ---------- 周 ----------

/** 上海时间所在周的周一（YYYY-MM-DD）。 */
export const weekStartOf = (at: Date): string => weekRange(undefined, at).from.slice(0, 10);
export const addDays = (day: string, days: number): string => new Date(Date.parse(`${day}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
export const isWeekStart = (day: string): boolean => /^\d{4}-\d{2}-\d{2}$/.test(day) && !Number.isNaN(Date.parse(`${day}T00:00:00Z`))
  && new Date(`${day}T00:00:00Z`).getUTCDay() === 1 && new Date(`${day}T00:00:00Z`).toISOString().startsWith(day);
/** 这一周按周五所在的月算（跨月的周归到周五那个月）：Mission 卡、战场名单都按这个月取。 */
export const weekPeriod = (weekStart: string): string => addDays(weekStart, 4).slice(0, 7);
/** 这一周在上海时间的起止 [start, end)。 */
export const weekWindow = (weekStart: string) => ({ start: new Date(`${weekStart}T00:00:00+08:00`), end: new Date(`${addDays(weekStart, 7)}T00:00:00+08:00`) });

/** 五段正文拼成一段文字（月度复盘读周复盘、对话里引用周复盘时用）。 */
export function weeklyReviewText(body: TWeeklyReviewBody): string {
  return WEEKLY_REVIEW_FIELDS.filter((field) => body[field]?.text.trim())
    .map((field) => `${WEEKLY_REVIEW_FIELD_LABELS[field]}\n${body[field].text.trim()}`).join("\n\n");
}

// ---------- 可见范围 ----------

/** 某月里每个人所在的战场：战场负责人、参与人、这个月 Mission 挂的战场、这个月任务卡所在的战场。 */
const BATTLEFIELD_MEMBERS = `
  SELECT b.owner_id AS person_id, b.id AS battlefield_id FROM battlefield_config b WHERE b.owner_id IS NOT NULL
  UNION SELECT p #>> '{}', b.id FROM battlefield_config b, jsonb_array_elements(COALESCE(b.participant_ids, '[]'::jsonb)) p
  UNION SELECT m.owner_id, x #>> '{}' FROM missions m, jsonb_array_elements(m.battlefield_ids) x WHERE m.period = $2
  UNION SELECT c.owner_id, r.battlefield_id FROM personal_mission_cards c JOIN mission_rounds r ON r.id = c.round_id WHERE r.period = $2`;

/** 看得到谁这一周的周复盘：CEO 看全部（null）；其他人看自己和同一战场的人。 */
export async function visibleOwners(q: Query, viewer: ReviewViewer, weekStart: string): Promise<Set<string> | null> {
  if (viewer.role === "ceo") return null;
  const peers = await q(`WITH members(person_id, battlefield_id) AS (${BATTLEFIELD_MEMBERS})
    SELECT DISTINCT other.person_id FROM members me JOIN members other ON other.battlefield_id = me.battlefield_id WHERE me.person_id = $1`,
  [viewer.personId, weekPeriod(weekStart)]);
  return new Set([viewer.personId, ...peers.rows.map((row) => row.person_id as string)]);
}

export async function getWeeklyReviewRow(q: Query, id: string): Promise<WeeklyReviewRow | null> {
  if (!UUID.test(id)) return null;
  return (await q(`SELECT ${COLUMNS} FROM weekly_reviews WHERE id=$1`, [id])).rows[0] as WeeklyReviewRow | undefined ?? null;
}

/** 按可见范围读一份；看不到的当作不存在。 */
export async function readWeeklyReviewForViewer(q: Query, viewer: ReviewViewer, id: string): Promise<WeeklyReviewRow | null> {
  const row = await getWeeklyReviewRow(q, id);
  if (!row) return null;
  const owners = await visibleOwners(q, viewer, row.week_start);
  return !owners || owners.has(row.person_id) ? row : null;
}

// ---------- 投影 ----------

export const weeklyReviewHref = (id: string, isCeo: boolean) => `${isCeo ? "" : "/me"}/weekly-reviews/${id}`;
function action(secret: string, row: WeeklyReviewRow, actionType: string, label: string): TActionDescriptor {
  return { actionType, label, actionId: signActionId(secret, { actionType, objectType: "weekly-review", objectId: row.id, objectVersion: row.version }) };
}
const EDITABLE: TWeeklyReviewStatus[] = ["draft", "draft_failed"];
const SOURCE_NAMES: Record<RevisionSource, string> = { co_agent: "Co-Agent", import: "飞书导入", agent_tool: "你的 AI 工具", manual: "" };

export function projectWeeklyReview(row: WeeklyReviewRow, viewer: ReviewViewer, names: Map<string, string>, secret: string): TWeeklyReviewPayload {
  const isSelf = row.person_id === viewer.personId, isCeo = viewer.role === "ceo";
  const actions: TActionDescriptor[] = [];
  if (isSelf && EDITABLE.includes(row.status)) {
    actions.push(action(secret, row, "weekly-review.update", "保存"));
    if (row.status === "draft") actions.push(action(secret, row, "weekly-review.submit", "提交"));
    actions.push(action(secret, row, "weekly-review.generate", row.body ? "重新生成" : "生成"));
  }
  const name = (who: string | null, source: RevisionSource) => who ? names.get(who) ?? who : SOURCE_NAMES[source] || "—";
  return {
    weeklyReviewId: row.id, version: row.version, personId: row.person_id, personName: names.get(row.person_id) ?? row.person_id,
    weekStart: row.week_start, weekEnd: addDays(row.week_start, 6), status: row.status, origin: row.origin, importSource: row.import_source,
    body: isSelf || row.status === "submitted" ? row.body : null, draftError: isSelf ? row.draft_error : null,
    generationSteps: isSelf ? row.generation_steps : [], editedFields: isSelf ? row.edited_fields : [],
    revisions: [...row.revisions].reverse().map((item) => ({ at: item.at, kind: item.kind, byName: name(item.by, item.source), fields: item.fields })),
    submittedAt: row.submitted_at?.toISOString() ?? null, viewer: { isSelf, isCeo }, actions,
  };
}

/** 本人在最前，其次未提交的，再按姓名。 */
export async function readWeeklyReviewBoard(q: Query, viewer: ReviewViewer, names: Map<string, string>, now: Date, week?: string): Promise<TWeeklyReviewBoard | null> {
  const current = weekStartOf(now);
  let weekStart = week;
  if (!weekStart) {
    // 不带 week：本周有看得到的周复盘就取本周，否则取最近有周复盘的一周（不晚于本周）。
    const recent = (await q(`SELECT DISTINCT to_char(week_start,'YYYY-MM-DD') AS week FROM weekly_reviews WHERE week_start <= $1 ORDER BY week DESC LIMIT 8`, [current])).rows as { week: string }[];
    for (const { week: candidate } of recent) {
      const owners = await visibleOwners(q, viewer, candidate);
      const found = await q("SELECT 1 FROM weekly_reviews WHERE week_start=$1 AND ($2::text[] IS NULL OR person_id = ANY($2)) LIMIT 1", [candidate, owners ? [...owners] : null]);
      if (found.rowCount) { weekStart = candidate; break; }
    }
    if (!weekStart) return null;
  }
  const owners = await visibleOwners(q, viewer, weekStart);
  const filter = owners ? [...owners] : null;
  const rows = (await q(`SELECT ${COLUMNS} FROM weekly_reviews WHERE week_start=$1 AND ($2::text[] IS NULL OR person_id = ANY($2))`, [weekStart, filter])).rows as WeeklyReviewRow[];
  const display = (row: WeeklyReviewRow) => names.get(row.person_id) ?? row.person_id;
  rows.sort((a, b) => Number(b.person_id === viewer.personId) - Number(a.person_id === viewer.personId)
    || Number(a.status === "submitted") - Number(b.status === "submitted")
    || display(a).localeCompare(display(b), "zh-CN") || a.person_id.localeCompare(b.person_id));
  // 前后一周只看自己看得到的人（战场名单按各自那一周算，这里用这一周的名单近似）。
  const neighbour = async (direction: "<" | ">") => ((await q(`SELECT to_char(week_start,'YYYY-MM-DD') AS week FROM weekly_reviews
    WHERE week_start ${direction} $1 AND ($2::text[] IS NULL OR person_id = ANY($2)) ORDER BY week_start ${direction === "<" ? "DESC" : "ASC"} LIMIT 1`,
  [weekStart, filter])).rows[0]?.week as string | undefined) ?? null;
  return {
    weekStart, weekEnd: addDays(weekStart, 6), isCurrentWeek: weekStart === current,
    counts: { total: rows.length, submitted: rows.filter((row) => row.status === "submitted").length },
    rows: rows.map((row) => ({ weeklyReviewId: row.id, personId: row.person_id, personName: display(row), status: row.status, origin: row.origin,
      isSelf: row.person_id === viewer.personId, href: weeklyReviewHref(row.id, viewer.role === "ceo") })),
    previousWeek: await neighbour("<"), nextWeek: weekStart < current ? await neighbour(">") : null,
  };
}

// ---------- 写 ----------

const emptyBody = (): TWeeklyReviewBody => Object.fromEntries(WEEKLY_REVIEW_FIELDS.map((field) => [field, { text: "", sources: [] as string[] }])) as unknown as TWeeklyReviewBody;
export const appendRevision = (revisions: StoredRevision[], revision: StoredRevision): StoredRevision[] => [...revisions, revision].slice(-MAX_REVISIONS);

/** 给这些人建这一周的周复盘（状态 drafting，等 Co-Agent 起草）；已有的不动。返回新建的。 */
export async function ensureWeeklyReviewDrafts(q: Query, personIds: string[], weekStart: string, now: Date): Promise<{ id: string; version: number }[]> {
  const created: { id: string; version: number }[] = [];
  for (const personId of personIds) {
    const inserted = await q(`INSERT INTO weekly_reviews (id, person_id, week_start, status, generation_steps, created_at, updated_at)
      VALUES ($1, $2, $3, 'drafting', $4::jsonb, $5, $5) ON CONFLICT (person_id, week_start) DO NOTHING RETURNING id, version`,
    [randomUUID(), personId, weekStart, JSON.stringify(pendingWeeklySteps()), now]);
    if (inserted.rows[0]) created.push(inserted.rows[0] as { id: string; version: number });
  }
  return created;
}

/**
 * 本人要生成（对话里的「生成我的周复盘」）：没有就建，草稿或失败的转成生成中；已提交的不动。
 * 返回 drafting 时调用方按 id + version 启动（或接上进行中的）那一次生成。
 */
export async function requestWeeklyReviewDraft(pool: Pool, personId: string, weekStart: string, now: Date):
  Promise<{ id: string; version: number; status: TWeeklyReviewStatus }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const q: Query = client.query.bind(client);
    await ensureWeeklyReviewDrafts(q, [personId], weekStart, now);
    const row = (await q(`SELECT ${COLUMNS} FROM weekly_reviews WHERE person_id=$1 AND week_start=$2 FOR UPDATE`, [personId, weekStart])).rows[0] as WeeklyReviewRow;
    let result = { id: row.id, version: row.version, status: row.status };
    if (EDITABLE.includes(row.status)) {
      await q(`UPDATE weekly_reviews SET status='drafting', draft_error=NULL, generation_steps=$2::jsonb, version=version+1, updated_at=$3 WHERE id=$1`,
        [row.id, JSON.stringify(pendingWeeklySteps()), now]);
      result = { id: row.id, version: row.version + 1, status: "drafting" };
    }
    await client.query("COMMIT");
    return result;
  } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
}

export type WeeklyReviewEffect = { type: "generate"; weeklyReviewId: string; version: number } | { type: "world_sync"; weeklyReviewId: string };
export type WeeklyReviewActionOutcome = { ok: true; effects: WeeklyReviewEffect[] } | { conflict: true }
  | { error: { status: number; code: string; message: string; fieldErrors?: Record<string, string> } };
const failure = (status: number, code: string, message: string, fieldErrors?: Record<string, string>): WeeklyReviewActionOutcome =>
  ({ error: { status, code, message, ...(fieldErrors ? { fieldErrors } : {}) } });

/** 本人的修改、提交、重新生成；锁行，按指纹幂等重放，版本对不上 409。 */
export async function executeWeeklyReviewAction(pool: Pool, viewer: ReviewViewer, scope: ActionScope, input: unknown, fingerprint: string, now: Date,
  source: "manual" | "agent_tool" = "manual"): Promise<WeeklyReviewActionOutcome> {
  if (!UUID.test(scope.objectId)) return failure(404, "WEEKLY_REVIEW_NOT_FOUND", "周复盘不存在");
  const client = await pool.connect();
  const q: Query = client.query.bind(client);
  try {
    await client.query("BEGIN");
    const row = (await q(`SELECT ${COLUMNS} FROM weekly_reviews WHERE id=$1 FOR UPDATE`, [scope.objectId])).rows[0] as WeeklyReviewRow | undefined;
    const finish = async (result: WeeklyReviewActionOutcome) => { await client.query("ok" in result ? "COMMIT" : "ROLLBACK"); return result; };
    if (!row) return await finish(failure(404, "WEEKLY_REVIEW_NOT_FOUND", "周复盘不存在"));
    if (row.person_id !== viewer.personId) return await finish(failure(403, "FORBIDDEN", "只有本人能改自己的周复盘"));
    if (row.action_fingerprints.includes(fingerprint)) return await finish({ ok: true, effects: [] });
    if (row.version !== scope.objectVersion) return await finish({ conflict: true });
    if (!EDITABLE.includes(row.status)) return await finish(failure(409, "WEEKLY_REVIEW_STATE", "当前状态不能执行这个操作"));
    const fingerprints = JSON.stringify([...row.action_fingerprints, fingerprint].slice(-100));
    const write = (assignments: string, params: unknown[] = []) => q(`UPDATE weekly_reviews SET ${assignments},
      version=version+1, updated_at=$2, action_fingerprints=$3::jsonb WHERE id=$1`, [row.id, now, fingerprints, ...params]);
    const effects: WeeklyReviewEffect[] = [];
    switch (scope.actionType) {
      case "weekly-review.update": {
        const fields = (input as TWeeklyReviewUpdateInput).fields;
        if (new Set(fields.map((item) => item.field)).size !== fields.length) return await finish(failure(400, "INVALID_INPUT", "同一段只能改一次"));
        const body = row.body ? structuredClone(row.body) : emptyBody();
        const edited = new Set(row.edited_fields);
        const changed: TWeeklyReviewField[] = [], previous: Partial<Record<TWeeklyReviewField, string>> = {};
        for (const item of fields) {
          if (item.text !== body[item.field].text) { edited.add(item.field); changed.push(item.field); previous[item.field] = body[item.field].text; }
          body[item.field] = { text: item.text, sources: item.sources ?? body[item.field].sources };
        }
        const revisions = changed.length ? appendRevision(row.revisions, { at: now.toISOString(), kind: "edit", by: viewer.personId, source, fields: changed, previous }) : row.revisions;
        await write("status='draft', body=$4::jsonb, draft_source=COALESCE(draft_source,$5), draft_error=NULL, edited_fields=$6::jsonb, revisions=$7::jsonb",
          [JSON.stringify(body), source, JSON.stringify(WEEKLY_REVIEW_FIELDS.filter((field) => edited.has(field))), JSON.stringify(revisions)]);
        break;
      }
      case "weekly-review.submit": {
        if (row.status !== "draft") return await finish(failure(409, "WEEKLY_REVIEW_STATE", "请先写好草稿"));
        const missing = WEEKLY_REVIEW_REQUIRED.filter((field) => !row.body?.[field].text.trim());
        if (missing.length) return await finish(failure(400, "WEEKLY_REVIEW_INCOMPLETE", `请填写${missing.map((field) => WEEKLY_REVIEW_FIELD_LABELS[field]).join("、")}`,
          Object.fromEntries(missing.map((field) => [field, "required"]))));
        await write("status='submitted', submitted_at=$2, world_sync_status='pending', revisions=$4::jsonb",
          [JSON.stringify(appendRevision(row.revisions, { at: now.toISOString(), kind: "submit", by: viewer.personId, source, fields: [] }))]);
        effects.push({ type: "world_sync", weeklyReviewId: row.id });
        break;
      }
      case "weekly-review.generate":
        await write("status='drafting', draft_error=NULL, generation_steps=$4::jsonb", [JSON.stringify(pendingWeeklySteps())]);
        effects.push({ type: "generate", weeklyReviewId: row.id, version: row.version + 1 });
        break;
      default: return await finish(failure(404, "UNKNOWN_ACTION", "无效 actionId"));
    }
    return await finish({ ok: true, effects });
  } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
}

/** 生成中超过 10 分钟没写回（进程重启、模型卡住）：标为失败，本人可以重试。 */
export async function recoverStaleWeeklyDrafts(q: Query, now: Date): Promise<number> {
  const result = await q(`UPDATE weekly_reviews SET status='draft_failed', version=version+1, updated_at=$1::timestamptz,
    draft_error=jsonb_build_object('code','weekly_review_interrupted','message','生成中断，请重试','at',$1::text)
    WHERE status='drafting' AND updated_at < $2`, [now.toISOString(), new Date(now.getTime() - 10 * 60_000)]);
  return result.rowCount ?? 0;
}
