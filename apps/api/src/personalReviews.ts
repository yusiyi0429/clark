import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  TActionDescriptor, TMonthlyReviewField, TMonthlyReviewSelfReview, TPersonalReviewBoard,
  TPersonalReviewDraftSource, TPersonalReviewPayload, TPersonalReviewStatus, TPersonalReviewUpdateInput,
} from "@warmap/contracts";
import { signActionId, type ActionScope } from "./actionToken.js";
import type { MemoryPerson } from "./companyMemory.js";
import { listConversationAttachments } from "./conversations.js";
import type { Query } from "./meetingStore.js";
import { advanceMonthlyReviewIfReady, type MonthlyReviewActionError, type MonthlyReviewEffect, type ReviewViewer } from "./monthlyReviews.js";

export type PersonalReviewRow = {
  id: string; version: number; monthly_review_id: string; period: string; person_id: string;
  status: TPersonalReviewStatus; draft_source: TPersonalReviewDraftSource;
  draft_error: TPersonalReviewPayload["draftError"]; self_review: TMonthlyReviewSelfReview | null;
  submitted_at: Date | null; skipped_by: string | null; skipped_at: Date | null;
  action_fingerprints: string[]; created_at: Date; updated_at: Date;
};
export const PERSONAL_REVIEW_FIELDS: TMonthlyReviewField[] = ["overall", "judgments", "nextFocus", "escalations"];
const EDITABLE: TPersonalReviewStatus[] = ["waiting", "draft", "draft_failed"];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const terminal = (status: TPersonalReviewStatus) => status === "submitted" || status === "skipped";
export const personalReviewHref = (id: string, isCeo: boolean) => `${isCeo ? "" : "/me"}/reviews/personal/${id}`;

/** 调用方事务内持有月度复盘行锁（创建时持创建锁）；新增和倒计时起点一起提交。 */
export type PersonalReviewDraftRun = { personalReviewId: string; version: number };
export async function ensurePersonalReviewsInTransaction(q: Query, reviewId: string, people: MemoryPerson[], now: Date): Promise<PersonalReviewDraftRun[]> {
  const review = (await q("SELECT period, status FROM monthly_reviews WHERE id=$1 FOR UPDATE", [reviewId])).rows[0];
  if (!review || review.status !== "collecting") return [];
  const owners = (await q("SELECT DISTINCT owner_id FROM missions WHERE period=$1 AND owner_id=ANY($2::text[]) ORDER BY owner_id",
    [review.period, people.map((person) => person.personId)])).rows as { owner_id: string }[];
  const runs: PersonalReviewDraftRun[] = [];
  for (const owner of owners) {
    const inserted = await q(`INSERT INTO personal_reviews (id,version,monthly_review_id,period,person_id,status,created_at,updated_at)
      VALUES ($1,1,$2,$3,$4,'drafting',$5,$5) ON CONFLICT (monthly_review_id,person_id) DO NOTHING RETURNING id`,
    [randomUUID(), reviewId, review.period, owner.owner_id, now]);
    if (inserted.rows[0]) runs.push({ personalReviewId: inserted.rows[0].id as string, version: 1 });
  }
  if (runs.length) await q("UPDATE monthly_reviews SET cycle_started_at=COALESCE(cycle_started_at,$2) WHERE id=$1", [reviewId, now]);
  return runs;
}

export async function ensurePersonalReviews(pool: Pool, reviewId: string, people: MemoryPerson[], now: Date): Promise<PersonalReviewDraftRun[]> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const runs = await ensurePersonalReviewsInTransaction(client.query.bind(client), reviewId, people, now);
    await client.query("COMMIT");
    return runs;
  } catch (error) { await client.query("ROLLBACK").catch(() => undefined); throw error; }
  finally { client.release(); }
}

export async function getPersonalReview(q: Query, id: string): Promise<PersonalReviewRow | null> {
  if (!UUID.test(id)) return null;
  return (await q("SELECT * FROM personal_reviews WHERE id=$1", [id])).rows[0] as PersonalReviewRow | undefined ?? null;
}
export async function getCurrentPersonalReview(q: Query, personId: string): Promise<PersonalReviewRow | null> {
  return (await q(`SELECT p.* FROM personal_reviews p JOIN monthly_reviews r ON r.id=p.monthly_review_id
    WHERE r.status='collecting' AND p.person_id=$1 ORDER BY r.period DESC LIMIT 1`, [personId])).rows[0] as PersonalReviewRow | undefined ?? null;
}
function action(secret: string, row: PersonalReviewRow, actionType: string, label: string): TActionDescriptor {
  return { actionType, label, actionId: signActionId(secret, { actionType, objectType: "personal-review", objectId: row.id, objectVersion: row.version }) };
}
export async function readPersonalReviewBoard(q: Query, viewer: ReviewViewer, names: Map<string, string>, secret: string,
  reviewId?: string): Promise<TPersonalReviewBoard | null> {
  const review = (await q(reviewId ? "SELECT id,period FROM monthly_reviews WHERE id=$1"
    : "SELECT id,period FROM monthly_reviews WHERE status='collecting' ORDER BY period DESC LIMIT 1", reviewId ? [reviewId] : [])).rows[0];
  if (!review) return null;
  const rows = (await q("SELECT * FROM personal_reviews WHERE monthly_review_id=$1", [review.id])).rows as PersonalReviewRow[];
  rows.sort((a, b) => Number(terminal(a.status)) - Number(terminal(b.status))
    || (names.get(a.person_id) ?? a.person_id).localeCompare(names.get(b.person_id) ?? b.person_id, "zh-CN")
    || a.person_id.localeCompare(b.person_id));
  return {
    monthlyReviewId: review.id, period: review.period,
    counts: { total: rows.length, submitted: rows.filter((row) => row.status === "submitted").length, skipped: rows.filter((row) => row.status === "skipped").length },
    complete: rows.every((row) => terminal(row.status)),
    rows: rows.map((row) => ({ personalReviewId: row.id, personId: row.person_id, personName: names.get(row.person_id) ?? row.person_id,
      status: row.status, draftSource: row.draft_source, submittedAt: row.submitted_at?.toISOString() ?? null,
      isSelf: row.person_id === viewer.personId,
      href: row.person_id === viewer.personId || viewer.role === "ceo" ? personalReviewHref(row.id, viewer.role === "ceo") : null,
      actions: viewer.role === "ceo" && EDITABLE.includes(row.status) ? [action(secret, row, "personal-review.skip", "不等了，继续")] : [],
    })),
  };
}

/** 对话按本人 × scope 隔离；上传未发送的附件和用户消息各计一次，助手回复不算材料。 */
export async function readPersonalReviewMaterials(q: Query, row: PersonalReviewRow, storageDir: string) {
  const conversations = (await q("SELECT id FROM conversations WHERE owner_id=$1 AND scope=$2 AND deleted_at IS NULL ORDER BY created_at,id",
    [row.person_id, `personal-review:${row.id}`])).rows as { id: string }[];
  const attachments = (await Promise.all(conversations.map(({ id }) => listConversationAttachments(storageDir, id)))).flat()
    .map(({ id, fileName, extractedText }) => ({ id, fileName, extractedText }));
  const messages = conversations.length ? (await q(`SELECT conversation_id AS "conversationId", sequence, content, created_at AS "createdAt"
    FROM conversation_messages WHERE conversation_id=ANY($1::uuid[]) AND role='user' ORDER BY created_at,sequence`,
  [conversations.map(({ id }) => id)])).rows as { conversationId: string; sequence: number; content: string; createdAt: Date }[] : [];
  return { attachments, messages: messages.map((message) => ({ ...message, createdAt: message.createdAt.toISOString() })) };
}

/** 与单元复盘的周进展查询相同时间范围（允许次月首周补记），按执行事项负责人过滤。 */
export async function personalReviewContext(q: Query, row: PersonalReviewRow) {
  const missions = (await q(`SELECT id,code,title,outcome,time_boundary AS "timeBoundary",tradeoffs,why,success_evidence AS "successEvidence",milestones,boundaries,
    key_path AS "keyPath",resources,dependencies,human_agent_split AS "humanAgentSplit",risk,retrospect
    FROM missions WHERE period=$1 AND owner_id=$2 ORDER BY code,id`, [row.period, row.person_id])).rows;
  const [year, month] = row.period.split("-").map(Number);
  const weeklyProgress = (await q(`SELECT to_char(p.created_at AT TIME ZONE 'Asia/Shanghai','YYYY-MM-DD') AS date,
    COALESCE(m.title,'') AS "missionTitle", t.title AS "taskTitle", p.author_id AS author, p.body
    FROM task_progress p JOIN tasks t ON t.id=p.task_id LEFT JOIN missions m ON m.id=t.mission_id
    WHERE p.created_at >= $1 AND p.created_at < $2 AND (m.period=$3 OR t.mission_id IS NULL) AND t.owner_id=$4
    ORDER BY p.created_at DESC,p.id DESC LIMIT 60`,
  [new Date(Date.UTC(year, month - 1, 1, -8)), new Date(Date.UTC(year, month, 8, -8)), row.period, row.person_id])).rows;
  return { period: row.period, personId: row.person_id, missions, weeklyProgress };
}
export type PersonalReviewDraftInput = Awaited<ReturnType<typeof personalReviewContext>> & Awaited<ReturnType<typeof readPersonalReviewMaterials>>;

export async function projectPersonalReview(q: Query, row: PersonalReviewRow, viewer: ReviewViewer, names: Map<string, string>,
  secret: string, storageDir: string, now: Date): Promise<TPersonalReviewPayload> {
  const materials = await readPersonalReviewMaterials(q, row, storageDir);
  const materialCount = materials.attachments.length + materials.messages.length;
  const isSelf = row.person_id === viewer.personId, isCeo = viewer.role === "ceo";
  const actions: TActionDescriptor[] = [];
  if (isSelf && EDITABLE.includes(row.status)) {
    actions.push(action(secret, row, "personal-review.update", "保存"));
    if (row.status === "draft") actions.push(action(secret, row, "personal-review.submit", "确认提交"));
    if (materialCount) actions.push(action(secret, row, "personal-review.draft_with_co_agent", "按材料重新起草"));
  }
  if (isCeo && EDITABLE.includes(row.status)) actions.push(action(secret, row, "personal-review.skip", "不等了，继续"));
  const missions = (await q("SELECT id,code,title,outcome FROM missions WHERE period=$1 AND owner_id=$2 ORDER BY code,id", [row.period, row.person_id])).rows as TPersonalReviewPayload["missions"];
  const connected = await q("SELECT 1 FROM personal_tokens WHERE person_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$2) LIMIT 1", [row.person_id, now]);
  return { personalReviewId: row.id, monthlyReviewId: row.monthly_review_id, period: row.period, version: row.version,
    personId: row.person_id, personName: names.get(row.person_id) ?? row.person_id, status: row.status,
    draftSource: row.draft_source, draftError: row.draft_error, selfReview: row.self_review, missions,
    toolConnected: !!connected.rowCount, materialCount, conversationScope: `personal-review:${row.id}`,
    submittedAt: row.submitted_at?.toISOString() ?? null,
    skipped: row.skipped_by && row.skipped_at ? { byName: names.get(row.skipped_by) ?? row.skipped_by, at: row.skipped_at.toISOString() } : null,
    viewer: { isSelf, isCeo }, actions };
}

type PersonalReviewEffect = MonthlyReviewEffect | { type: "personal_draft"; personalReviewId: string; version: number };
export type PersonalReviewActionOutcome = { ok: true; effects: PersonalReviewEffect[] } | { conflict: true } | { error: MonthlyReviewActionError };
const error = (status: number, code: string, message: string): PersonalReviewActionOutcome => ({ error: { status, code, message } });

/** 先锁月度复盘再锁个人行，序列化并发交齐判断；重放不再触发 Agent。 */
export async function executePersonalReviewAction(pool: Pool, viewer: ReviewViewer, scope: ActionScope, input: unknown,
  fingerprint: string, now: Date, storageDir: string, source: "manual" | "agent_tool" = "manual"): Promise<PersonalReviewActionOutcome> {
  if (!UUID.test(scope.objectId)) return error(404, "PERSONAL_REVIEW_NOT_FOUND", "个人复盘不存在");
  const client = await pool.connect();
  const q: Query = client.query.bind(client);
  try {
    await client.query("BEGIN");
    const found = await getPersonalReview(q, scope.objectId);
    if (!found) { await client.query("ROLLBACK"); return error(404, "PERSONAL_REVIEW_NOT_FOUND", "个人复盘不存在"); }
    const parent = (await q("SELECT status FROM monthly_reviews WHERE id=$1 FOR UPDATE", [found.monthly_review_id])).rows[0];
    const row = (await q("SELECT * FROM personal_reviews WHERE id=$1 FOR UPDATE", [found.id])).rows[0] as PersonalReviewRow;
    const finish = async (result: PersonalReviewActionOutcome) => { await client.query("ok" in result ? "COMMIT" : "ROLLBACK"); return result; };
    const skip = scope.actionType === "personal-review.skip";
    if (skip ? viewer.role !== "ceo" : viewer.personId !== row.person_id) return await finish(error(403, "FORBIDDEN", "没有权限处理这份个人复盘"));
    if (row.action_fingerprints.includes(fingerprint)) return await finish({ ok: true, effects: [] });
    if (row.version !== scope.objectVersion) return await finish({ conflict: true });
    if (parent.status !== "collecting" || !EDITABLE.includes(row.status)) return await finish(error(409, "PERSONAL_REVIEW_STATE", "当前状态不能执行这个操作"));
    const effects: PersonalReviewEffect[] = [];
    const fingerprints = JSON.stringify([...row.action_fingerprints, fingerprint].slice(-100));
    const write = (assignments: string, params: unknown[] = []) => q(`UPDATE personal_reviews SET ${assignments},
      version=version+1,updated_at=$2,action_fingerprints=$3::jsonb WHERE id=$1`, [row.id, now, fingerprints, ...params]);
    switch (scope.actionType) {
      case "personal-review.update": {
        const fields = (input as TPersonalReviewUpdateInput).fields;
        if (new Set(fields.map((field) => field.field)).size !== fields.length) return await finish(error(400, "INVALID_INPUT", "同一栏只能更新一次"));
        const selfReview = row.self_review ?? { overall: { text: "", sources: [] }, judgments: { text: "", sources: [] }, nextFocus: { text: "", sources: [] }, escalations: { text: "", sources: [] } };
        for (const field of fields) selfReview[field.field] = { text: field.text, sources: field.sources ?? selfReview[field.field].sources };
        await write("status='draft',self_review=$4::jsonb,draft_source=$5,draft_error=NULL", [JSON.stringify(selfReview), source === "agent_tool" ? source : row.draft_source ?? "manual"]);
        break;
      }
      case "personal-review.submit":
        if (row.status !== "draft") return await finish(error(409, "PERSONAL_REVIEW_STATE", "请先写好草稿"));
        if (!PERSONAL_REVIEW_FIELDS.filter((field) => field !== "escalations").every((field) => row.self_review?.[field].text.trim())) return await finish(error(400, "PERSONAL_REVIEW_INCOMPLETE", "请填写总体结果、关键判断和下周期重点"));
        await write("status='submitted',submitted_at=$2");
        break;
      case "personal-review.skip":
        await write("status='skipped',skipped_by=$4,skipped_at=$2", [viewer.personId]);
        break;
      case "personal-review.draft_with_co_agent": {
        const materials = await readPersonalReviewMaterials(q, row, storageDir);
        if (!materials.attachments.length && !materials.messages.length) return await finish(error(400, "PERSONAL_REVIEW_MATERIAL_REQUIRED", "请先上传材料或粘贴草稿"));
        await write("status='drafting',draft_error=NULL");
        effects.push({ type: "personal_draft", personalReviewId: row.id, version: row.version + 1 });
        break;
      }
      default: return await finish(error(404, "UNKNOWN_ACTION", "无效 actionId"));
    }
    if (skip || scope.actionType === "personal-review.submit") {
      const remaining = await q("SELECT 1 FROM personal_reviews WHERE monthly_review_id=$1 AND status NOT IN ('submitted','skipped') LIMIT 1", [row.monthly_review_id]);
      if (!remaining.rowCount) {
        const items = (await q("SELECT id,status FROM monthly_review_items WHERE review_id=$1 AND subject_type='battlefield' AND status IN ('waiting','draft','returned') ORDER BY id FOR UPDATE", [row.monthly_review_id])).rows;
        for (const item of items) {
          const runId = randomUUID();
          await q(`UPDATE monthly_review_items SET status=CASE WHEN status='waiting' THEN 'drafting' ELSE status END,
            draft_run=$2::jsonb,version=version+1,updated_at=$3 WHERE id=$1`, [item.id, JSON.stringify({ runId, error: null, suggestions: item.status !== "waiting" }), now]);
          effects.push({ type: "draft", itemId: item.id, runId });
        }
        effects.push(...await advanceMonthlyReviewIfReady(q, row.monthly_review_id, now));
      }
    }
    return await finish({ ok: true, effects });
  } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
}

export async function recoverStalePersonalReviewDrafts(q: Query, now: Date): Promise<number> {
  const result = await q(`UPDATE personal_reviews SET status='draft_failed',version=version+1,updated_at=$1::timestamptz,
    draft_error=jsonb_build_object('code','personal_review_interrupted','message','起草中断，请重试','at',$1::text)
    WHERE status='drafting' AND updated_at < $2`, [now.toISOString(), new Date(now.getTime() - 10 * 60_000)]);
  return result.rowCount ?? 0;
}
