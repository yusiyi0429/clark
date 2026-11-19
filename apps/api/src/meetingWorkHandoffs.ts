import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type {
  TContinueMeetingWork, TMeetingWorkAuthorization, TMeetingWorkConclusion, TMeetingWorkCriterionRef, TMeetingWorkFeedItem,
  TMeetingWorkHandoffs, TMeetingWorkReceipt, TMeetingWorkTarget, TMeetingWorkTargetOption, TNexusDriContent, TNexusDriRequest,
} from "@warmap/contracts";
import { inTransaction } from "./collector.js";
import type { Query } from "./meetingStore.js";
import { UUID_PATTERN } from "./meetingStore.js";
import { boardTask, CardError, type OpenPlanTask } from "./taskCards.js";
import { DeliverableError } from "./taskDeliverables.js";
import { taskStandards } from "./tasks.js";

type ConclusionRow = {
  confirmation_ref: string; request_id: string; item_id: string; meeting_id: string; revision: number;
  decision: "confirmed" | "amended"; confirmed_by_person_id: string; confirmed_at: Date;
  body: TNexusDriRequest; amended_content: TNexusDriContent | null; superseded_at: Date | null;
};
const conclusionColumns = `c.id AS confirmation_ref,c.decision,c.confirmed_by_person_id,c.confirmed_at,c.amended_content,
  r.request_id,r.item_id,r.meeting_id,r.revision,r.body,r.superseded_at`;
const conclusionTables = "nexus_dri_confirmations c JOIN nexus_dri_requests r ON r.id=c.request_row_id";
const visible = "c.confirmed_by_person_id=$1 AND r.confirmer_person_id=$1 AND c.decision IN ('amended','confirmed')";

function conclusion(row: ConclusionRow): TMeetingWorkConclusion {
  const { body, amended_content: amended } = row;
  const { id, version, hash, reference, turnId, quote } = body.source;
  return { confirmationRef: row.confirmation_ref, requestId: row.request_id, itemId: row.item_id, meetingId: row.meeting_id, revision: row.revision,
    decision: row.decision, confirmedAt: row.confirmed_at.toISOString(), confirmedBy: row.confirmed_by_person_id,
    question: body.question, content: amended ?? body.content, source: { id, version, hash, reference: reference ?? null, turnId: turnId ?? null,
      minutesRef: body.minutesRef, quote: quote || null, readState: quote ? "excerpt" : "reference_only" } };
}

type ReceiptRow = {
  id: string; confirmation_ref: string; authorized_by: string; authorized_at: Date; project_id: string; target_kind: TMeetingWorkTarget["kind"];
  target_id: string; instruction: string; status: TMeetingWorkReceipt["status"]; failure: string | null; delivered_at: Date | null;
};
const receipt = (row: ReceiptRow): TMeetingWorkReceipt => ({
  id: row.id, target: { projectId: row.project_id, kind: row.target_kind, id: row.target_id }, instruction: row.instruction,
  status: row.status, reason: row.failure, authorizedAt: row.authorized_at.toISOString(), deliveredAt: row.delivered_at?.toISOString() ?? null,
});

export async function listMeetingWorkHandoffs(q: Query, actor: string): Promise<TMeetingWorkHandoffs> {
  const rows = (await q(`SELECT ${conclusionColumns} FROM ${conclusionTables}
    WHERE ${visible} AND r.superseded_at IS NULL ORDER BY c.confirmed_at DESC,c.id`, [actor])).rows as ConclusionRow[];
  if (!rows.length) return { items: [] };
  const records = (await q(`SELECT * FROM meeting_work_handoffs WHERE authorized_by=$1 AND confirmation_ref=ANY($2::uuid[])
    ORDER BY authorized_at,id`, [actor, rows.map(row => row.confirmation_ref)])).rows as ReceiptRow[];
  const grouped = new Map<string, TMeetingWorkReceipt[]>();
  for (const row of records) {
    const group = grouped.get(row.confirmation_ref) ?? [];
    group.push(receipt(row));
    grouped.set(row.confirmation_ref, group);
  }
  return { items: rows.map(row => ({ conclusion: conclusion(row), receipts: grouped.get(row.confirmation_ref) ?? [] })) };
}

const subCard = "(s.role_id IS NOT NULL OR s.executor='claude_code') AND s.trashed_at IS NULL AND s.archived_at IS NULL AND s.status NOT IN ('done','returned')";
const subTopic = "s.status='active' AND s.trashed_at IS NULL";
const subGoal = "LEFT JOIN project_goals g ON g.task_id=s.plan_task_id AND g.owner_id=s.owner_id";
const subProject = "COALESCE(g.project_id,s.project_id)";

export async function meetingWorkTargets(q: Query, actor: string, open: OpenPlanTask): Promise<TMeetingWorkTargetOption[]> {
  // 「随手」项目和它的会话不当去向（收在幕后，本人 11/19）。
  const rows = (await q(`WITH mine AS (SELECT id,name FROM projects WHERE owner_id=$1 AND archived_at IS NULL AND NOT scratch)
    SELECT p.id AS "projectId",p.name AS "projectName",'project' AS kind,p.id::text AS id,p.name FROM mine p
    UNION ALL SELECT p.id,p.name,'task',g.task_id,g.task_name FROM project_goals g JOIN mine p ON p.id=g.project_id WHERE g.owner_id=$1
    UNION ALL SELECT p.id,p.name,'card',s.id::text,s.title FROM tasks s ${subGoal} JOIN mine p ON p.id=${subProject}
      WHERE s.owner_id=$1 AND ${subCard}
    UNION ALL SELECT p.id,p.name,'topic',s.id::text,s.title FROM research_topics s ${subGoal} JOIN mine p ON p.id=${subProject}
      WHERE s.owner_id=$1 AND ${subTopic}
    ORDER BY "projectName",kind,name,id`, [actor])).rows as TMeetingWorkTargetOption[];
  const allowed = await Promise.all(rows.map(async row => {
    if (row.kind !== "task") return row;
    try { return { ...row, name: (await boardTask(open, actor, row.id)).task.name }; }
    catch (e) { if (e instanceof CardError && (e.status === 404 || e.status === 403)) return null; throw e; }
  }));
  return allowed.filter((row): row is TMeetingWorkTargetOption => row !== null);
}

async function current(q: Query, actor: string, ref: string, revision: number) {
  // Nexus marks the old request row superseded under a row lock. Hold it through the commit that receives this version.
  const row = (await q(`SELECT ${conclusionColumns} FROM ${conclusionTables} WHERE ${visible} AND c.id=$2 FOR SHARE OF r,c`, [actor, ref])).rows[0] as ConclusionRow | undefined;
  if (!row) throw new CardError(404, "NOT_FOUND", "没有可递送的本人确认记录");
  if (row.revision !== revision || row.superseded_at) throw new CardError(409, "SUPERSEDED", "这条确认已经有新版本，请刷新");
}

type Destination = { target: TMeetingWorkTargetOption; criteria: TMeetingWorkCriterionRef[] };
const missing = () => new CardError(404, "TARGET_UNAVAILABLE", "去向已移走、归档或无法访问，请核对后重试");

/** Authorize against this project's current owner and the exact current goal / sub. Target names and standards never come from the caller. */
async function destination(q: Query, actor: string, target: TMeetingWorkTarget, open: OpenPlanTask): Promise<Destination> {
  const { projectId, kind, id } = target;
  const project = (await q("SELECT name FROM projects WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL FOR SHARE", [projectId, actor])).rows[0];
  if (!project) throw missing();
  let name = project.name as string;
  let criteria: TMeetingWorkCriterionRef[] = [];
  if (kind === "project") {
    if (projectId !== id) throw missing();
  } else if (kind === "task") {
    const goal = (await q("SELECT 1 FROM project_goals WHERE project_id=$1 AND owner_id=$2 AND task_id=$3 FOR SHARE", [projectId, actor, id])).rowCount;
    if (!goal) throw missing();
    const task = await boardTask(open, actor, id);
    name = task.task.name;
    criteria = task.criteria.map((text, index) => ({ kind, id, index: index + 1, revision: null, text }));
  } else {
    if (!UUID_PATTERN.test(id)) throw missing();
    const isCard = kind === "card";
    const row = (await q(`SELECT s.title,s.plan_task_id,s.project_id${isCard ? ",s.done_definition,s.agreement_revision,s.criterion_index,s.criterion_text" : ""}
      FROM ${isCard ? "tasks" : "research_topics"} s WHERE s.id=$1 AND s.owner_id=$2 AND ${isCard ? subCard : subTopic} FOR SHARE OF s`, [id, actor])).rows[0];
    if (!row) throw missing();
    const goal = row.plan_task_id ? (await q("SELECT project_id FROM project_goals WHERE task_id=$1 AND owner_id=$2 FOR SHARE", [row.plan_task_id, actor])).rows[0] : null;
    if ((goal?.project_id ?? row.project_id) !== projectId) throw missing();
    name = row.title;
    if (isCard) {
      criteria = taskStandards(row.done_definition).map((text, index) => ({ kind, id, index: index + 1, revision: row.agreement_revision, text }));
      if (row.plan_task_id && row.criterion_index && row.criterion_text) criteria.push({
        kind: "task", id: row.plan_task_id, index: row.criterion_index, revision: null, text: row.criterion_text,
      });
    }
    if (!isCard && row.plan_task_id) {
      // The topic owner may work in a topic without being allowed to open the Task. Include only its accessible criteria.
      try {
        const task = await open(actor, row.plan_task_id);
        criteria = task.criteria.map((text, index) => ({ kind: "task", id: row.plan_task_id, index: index + 1, revision: null, text }));
      } catch (cause) { if (!(cause instanceof DeliverableError && (cause.status === 403 || cause.status === 404))) throw cause; }
    }
  }
  return { target: { projectId, kind, id, projectName: project.name, name }, criteria };
}

/** Called after an explicit continue instruction, inside the same transaction as confirmation or authorization. Retries keep the original instruction. */
export async function authorizeMeetingTargets(q: Query, actor: string, ref: string, targets: TMeetingWorkAuthorization["targets"], at: Date) {
  const stored = new Map<string, string>();
  const canonical = targets.map(t => ({ ...t, projectId: t.projectId.toLowerCase(),
    id: t.kind !== "task" && UUID_PATTERN.test(t.id) ? t.id.toLowerCase() : t.id }));
  // Lock target keys in the same order when two tabs submit overlapping groups.
  const key = (t: TMeetingWorkTarget) => JSON.stringify([t.projectId, t.kind, t.id]);
  for (const target of [...canonical].sort((a, b) => key(a) < key(b) ? -1 : key(a) > key(b) ? 1 : 0)) {
    const id = (await q(`INSERT INTO meeting_work_handoffs (id,confirmation_ref,authorized_by,authorized_at,project_id,target_kind,target_id,instruction)
      VALUES ($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT (confirmation_ref,project_id,target_kind,target_id) DO NOTHING RETURNING id`,
      [randomUUID(), ref, actor, at, target.projectId, target.kind, target.id, target.instruction?.trim() ?? ""])).rows[0]?.id ??
      (await q("SELECT id FROM meeting_work_handoffs WHERE confirmation_ref=$1 AND project_id=$2 AND target_kind=$3 AND target_id=$4 AND authorized_by=$5",
        [ref, target.projectId, target.kind, target.id, actor])).rows[0].id;
    stored.set(key(target), id);
  }
  return [...new Set(canonical.map(target => stored.get(key(target))!))];
}

export type MeetingWorkDeps = { pool: Pool; open: (q: Query) => OpenPlanTask; now: () => Date };

async function deliverOne({ pool, open, now }: MeetingWorkDeps, actor: string, ref: string, revision: number, id: string): Promise<void> {
  await inTransaction(pool, async q => {
    const row = (await q("SELECT * FROM meeting_work_handoffs WHERE id=$1 AND confirmation_ref=$2 AND authorized_by=$3 FOR UPDATE", [id, ref, actor])).rows[0] as ReceiptRow;
    if (!row || row.status === "delivered") return;
    // Isolate this target so a failed write or temporarily unavailable destination leaves a retryable receipt.
    await q("SAVEPOINT target_delivery");
    try {
      await current(q, actor, ref, revision);
      const dest = await destination(q, actor, receipt(row).target, open(q));
      await q(`UPDATE meeting_work_handoffs SET status='delivered',failure=NULL,delivered_at=$2,destination=$3::jsonb,criteria=$4::jsonb WHERE id=$1`,
        [id, now(), JSON.stringify(dest.target), JSON.stringify(dest.criteria)]);
    } catch (e) {
      await q("ROLLBACK TO SAVEPOINT target_delivery");
      const reason = e instanceof CardError ? e.message : "递送未成功，请重试此去向";
      await q("UPDATE meeting_work_handoffs SET status='failed',failure=$2 WHERE id=$1", [id, reason]);
    }
  });
}

export async function continueMeetingWork(deps: MeetingWorkDeps, actor: string, ref: string, body: TContinueMeetingWork): Promise<TMeetingWorkReceipt[]> {
  let ids: string[] = [];
  await inTransaction(deps.pool, async q => {
    await current(q, actor, ref, body.revision);
    ids = await authorizeMeetingTargets(q, actor, ref, body.targets, deps.now());
  });
  // Separate transactions keep successful targets independent of failures. A disconnected client can resume pending targets.
  for (const id of ids) await deliverOne(deps, actor, ref, body.revision, id);
  const rows = (await deps.pool.query("SELECT * FROM meeting_work_handoffs WHERE authorized_by=$1 AND id=ANY($2::uuid[]) ORDER BY array_position($2::uuid[],id)", [actor, ids])).rows as ReceiptRow[];
  return rows.map(receipt);
}

/** A combined confirmation already recorded its exact target set in the confirmation transaction. */
export async function deliverNewMeetingWork(deps: MeetingWorkDeps, actor: string, ref: string): Promise<void> {
  const rows = (await deps.pool.query(`SELECT h.id,r.revision FROM meeting_work_handoffs h
    JOIN nexus_dri_confirmations c ON c.id=h.confirmation_ref JOIN nexus_dri_requests r ON r.id=c.request_row_id
    WHERE h.confirmation_ref=$1 AND h.authorized_by=$2 AND h.status='pending' ORDER BY h.id`, [ref, actor])).rows;
  for (const { id, revision } of rows) await deliverOne(deps, actor, ref, revision, id);
}

type DeliveredRow = ConclusionRow & {
  id: string; authorized_by: string; authorized_at: Date; delivered_at: Date; instruction: string;
  destination: TMeetingWorkTargetOption; criteria: TMeetingWorkCriterionRef[];
};
/** Check both the current source disclosure and current target owner when opening a project feed or sub's context. */
async function deliveredRows(q: Query, actor: string, scope: { projectId: string } | { kind: "card" | "topic"; id: string }) {
  const byProject = "projectId" in scope;
  return (await q(`SELECT ${conclusionColumns},h.id,h.authorized_by,h.authorized_at,h.instruction,h.delivered_at,h.destination,h.criteria
    FROM meeting_work_handoffs h JOIN projects p ON p.id=h.project_id
    JOIN nexus_dri_confirmations c ON c.id=h.confirmation_ref JOIN nexus_dri_requests r ON r.id=c.request_row_id
    WHERE ${visible} AND p.owner_id=$1 AND h.authorized_by=$1 AND h.status='delivered'
      AND (r.superseded_at IS NULL OR EXISTS (SELECT 1 FROM nexus_dri_requests latest
        WHERE latest.request_id=r.request_id AND latest.superseded_at IS NULL AND latest.confirmer_person_id=$1))
      AND ${byProject ? "h.project_id=$2" : "h.target_kind=$2 AND h.target_id=$3 AND r.superseded_at IS NULL"}
      AND CASE h.target_kind
        WHEN 'project' THEN true
        WHEN 'task' THEN EXISTS (SELECT 1 FROM project_goals g WHERE g.task_id=h.target_id AND g.owner_id=$1 AND g.project_id=p.id)
        WHEN 'card' THEN EXISTS (SELECT 1 FROM tasks s ${subGoal} WHERE s.id::text=h.target_id AND s.owner_id=$1 AND s.trashed_at IS NULL AND ${subProject}=p.id)
        WHEN 'topic' THEN EXISTS (SELECT 1 FROM research_topics s ${subGoal} WHERE s.id::text=h.target_id AND s.owner_id=$1 AND s.trashed_at IS NULL AND ${subProject}=p.id)
      END ORDER BY h.delivered_at,h.id`, byProject ? [actor, scope.projectId] : [actor, scope.kind, scope.id])).rows as DeliveredRow[];
}

export async function projectMeetingWork(q: Query, actor: string, projectId: string, accessibleTasks: ReadonlySet<string>): Promise<TMeetingWorkFeedItem[]> {
  const rows = await deliveredRows(q, actor, { projectId });
  return rows.filter(row => row.destination.kind !== "task" || accessibleTasks.has(row.destination.id)).map(row => ({
    kind: "meeting_handoff", id: row.id, at: row.delivered_at.toISOString(), target: row.destination, conclusion: conclusion(row),
    instruction: row.instruction, authorizedAt: row.authorized_at.toISOString(), authorizedBy: row.authorized_by,
    criteria: row.criteria.filter(c => c.kind !== "task" || accessibleTasks.has(c.id)),
    superseded: row.superseded_at !== null,
  }));
}

/** Only the chosen sub receives a brief addition, read when its existing execution entry asks for its brief; no dispatch. */
export async function withMeetingWorkBrief(q: Query, actor: string, kind: "card" | "topic", id: string, base: string):
  Promise<{ markdown: string; originalMarkdown?: string }> {
  const rows = await deliveredRows(q, actor, { kind, id });
  const original = base.slice(0, 20_000);
  if (!rows.length) return { markdown: original };
  const sections = rows.reverse().map(row => {
    const change = conclusion(row);
    return [`确认 ${change.confirmationRef} · 第 ${change.revision} 版 · ${change.confirmedBy} · ${change.confirmedAt}`, change.question,
      `来源：${change.source.reference ?? change.source.id} · ${change.source.version} · ${change.source.readState === "excerpt" ? "有摘录" : "仅出处"}`,
      row.instruction && `本次交代：${row.instruction}`, change.content.value ?? JSON.stringify(change.content)].filter(Boolean).join("\n");
  });
  const prefix = "\n\n## 已递送的会后变化\n\n";
  const work = sections.join("\n\n");
  const remaining = 20_000 - original.length - prefix.length;
  if (work.length <= remaining) return { markdown: original + prefix + work };
  // Even a full-length free session must see the receipt. Include explicit, authorized ways to read both complete inputs.
  const marker = `（原交代完整内容见 /api/me/${kind === "card" ? "cards" : "topics"}/${id}/brief 的 originalMarkdown 字段）`;
  const latest = rows[0]!;
  const summary = `确认 ${latest.confirmation_ref} · 第 ${latest.revision} 版 · 共 ${rows.length} 条；完整会后变化见 /api/me/projects/${latest.destination.projectId}/feed`;
  const budget = 20_000 - prefix.length - summary.length - 2;
  if (original.length <= budget) {
    const available = budget - original.length;
    return { markdown: original + prefix + summary + "\n\n" + work.slice(0, available) };
  }
  // Keep the machine-readable card agreement and standards together. For free text, keep both ends of the original.
  const agreementAt = kind === "card" ? original.indexOf("\n## 交代\n") : -1;
  const gap = original.length - budget + marker.length;
  let cut = Math.ceil((budget - marker.length) / 2);
  if (agreementAt >= 0) cut = agreementAt >= gap ? agreementAt - gap : original.length - gap;
  const preview = original.slice(0, cut) + marker + original.slice(cut + gap);
  return { markdown: preview + prefix + summary, originalMarkdown: original };
}
