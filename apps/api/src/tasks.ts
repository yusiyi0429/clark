import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { TAcceptMyTaskRequest, TAddTaskCollaboratorsRequest, TCreateMyTaskRequest, TMeetingOutcomeItem, TPatchMyTaskRequest, TReturnMyTaskRequest,
  TTaskAcceptance, TTaskDetailResponse, TTaskProgressSource, TTaskStandardCheck, TTaskSubmission, TTaskView } from "@warmap/contracts";
import { companyPeriod } from "./monthlyPlans.js";
import { UUID_PATTERN, type Query } from "./meetingStore.js";
import { insertNotification } from "./notifications.js";
import { listTaskProgress } from "./taskProgress.js";
import { postThreadIntro, type ThreadIntroAgent } from "./threadIntro.js";
import { postCoAgentMessage, threadIntroInput, type ThreadRef } from "./threads.js";
import type { PeopleDirectory } from "./peopleDirectory.js";

type TaskRow = {
  id: string; version: number; title: string; status: TTaskView["status"]; created_by: TTaskView["source"];
  start_date: string | null; due_date: string | null; done_definition: string | null; judgment: string | null; judgment_at: Date | null;
  return_reason: string | null; origin_meeting_id: string | null; source_quote: string | null;
  meeting_title: string | null; lead_dri_id: string | null; owner_id: string; mission_id: string | null; plan_task_id: string | null;
  mission_title: string | null; card_id: string | null; period: string | null; battlefield_name: string | null;
  step_order: number | null; steps: number | null; previous_id: string | null; previous_title: string | null; previous_status: string | null;
  collaborators: string[]; created_at: Date; updated_at: Date;
  latest_progress_body: string | null; latest_progress_source: "web" | "codex" | "claude" | "github" | "other" | null;
  latest_progress_author_id: string | null; latest_progress_created_at: Date | null;
  submission: StoredSubmission | null; acceptance: StoredAcceptance | null;
  blocked_reason: string | null; waiting_on: string | null; blocked_at: Date | null;
};
/** tasks.submission / tasks.acceptance 里存的是人的 id，读的时候换成名字。 */
type StoredSubmission = Omit<TTaskSubmission, "by"> & { by: string };
type StoredAcceptance = Omit<TTaskAcceptance, "by"> & { by: string };

const TASK_SELECT = `SELECT t.id::text,t.version,t.title,t.status,t.created_by,t.start_date::text AS start_date,
 t.due_date::text AS due_date,t.done_definition,t.judgment,t.judgment_at,t.return_reason,t.origin_meeting_id::text,
 t.source_quote,mt.title AS meeting_title,mt.lead_dri_id,t.owner_id,t.mission_id,t.plan_task_id,t.step_order,
 CASE WHEN c.id IS NULL OR r.status='confirmed' THEN m.title ELSE NULL END AS mission_title,c.id::text AS card_id,m.period,COALESCE(b.name,mb.name,cap.name,'') AS battlefield_name,
 (SELECT count(*)::int FROM tasks s WHERE s.mission_id=t.mission_id) AS steps,
 prev.id::text AS previous_id,prev.title AS previous_title,prev.status AS previous_status,
 ARRAY(SELECT tm.person_id FROM task_members tm WHERE tm.task_id=t.id AND tm.role='collaborator' AND tm.left_at IS NULL ORDER BY tm.added_at,tm.person_id) AS collaborators,
 t.created_at,t.updated_at,lp.body AS latest_progress_body,lp.source AS latest_progress_source,
 lp.author_id AS latest_progress_author_id,lp.created_at AS latest_progress_created_at,t.submission,t.acceptance,
 t.blocked_reason,t.waiting_on,t.blocked_at
 FROM tasks t
 LEFT JOIN meetings mt ON mt.id=t.origin_meeting_id
 LEFT JOIN missions m ON m.id=t.mission_id
 LEFT JOIN personal_mission_cards c ON c.id=m.personal_mission_card_id
 LEFT JOIN mission_rounds r ON r.id=c.round_id
 LEFT JOIN battlefield_config b ON b.id=r.battlefield_id
 LEFT JOIN battlefield_config mb ON mb.id=m.battlefield_ids->>0
 LEFT JOIN capability_config cap ON cap.id=m.capability_id
 LEFT JOIN tasks prev ON prev.mission_id=t.mission_id AND prev.step_order=t.step_order-1
 LEFT JOIN LATERAL (SELECT body,source,author_id,created_at FROM task_progress WHERE task_id=t.id ORDER BY created_at DESC,id DESC LIMIT 1) lp ON true`;

const queryOf = (client: PoolClient): Query => (sql, params) => client.query(sql, params);
const person = (id: string, names: Map<string, string>) => ({ personId: id, name: names.get(id) ?? id });
function projectTask(row: TaskRow, names: Map<string, string>): TTaskView {
  return {
    id: row.id, version: row.version, title: row.title, status: row.status, source: row.created_by,
    startDate: row.start_date, dueDate: row.due_date, doneDefinition: row.done_definition,
    mission: row.mission_id && row.period && row.mission_title && row.step_order
      ? { missionId: row.mission_id, title: row.mission_title, cardId: row.card_id, period: row.period,
          battlefieldName: row.battlefield_name ?? "", step: row.step_order, steps: row.steps ?? 1 } : null,
    waitingOn: row.previous_id && row.previous_status !== "done" ? { taskId: row.previous_id, title: row.previous_title! } : null,
    owner: person(row.owner_id, names), collaborators: row.collaborators.map((id) => person(id, names)),
    latestProgress: row.latest_progress_body && row.latest_progress_source && row.latest_progress_author_id && row.latest_progress_created_at
      ? { body: row.latest_progress_body, source: row.latest_progress_source, author: person(row.latest_progress_author_id, names), createdAt: row.latest_progress_created_at.toISOString() } : null,
    returnReason: row.return_reason,
    origin: row.origin_meeting_id ? { type: "meeting", meetingId: row.origin_meeting_id,
      meetingTitle: row.meeting_title ?? "", quote: row.source_quote } : null,
    awaitingAcceptance: row.submission !== null && (row.status === "not_started" || row.status === "in_progress"),
    planTaskId: row.plan_task_id,
    blocker: row.blocked_reason && row.blocked_at && row.status !== "done"
      ? { reason: row.blocked_reason, waitingOn: row.waiting_on ? person(row.waiting_on, names) : null, since: row.blocked_at.toISOString() } : null,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}

/** 完成标准：doneDefinition 按行拆开，去掉空行和行首的列表记号（- * · • [ ] 1. 1、 (1) ①）。 */
export function taskStandards(doneDefinition: string | null): string[] {
  if (!doneDefinition) return [];
  return doneDefinition.split(/\r?\n/)
    .map((line) => line.trim()
      .replace(/^(?:[-*·•]\s*)?(?:\[[ xX]\]\s*)?/u, "")
      .replace(/^(?:\d{1,2}[.、)）](?!\d)|[(（]\d{1,2}[)）]|[①-⑳])\s*/u, "")
      .trim())
    .filter(Boolean).slice(0, 50);
}

/**
 * 推进人本人第一次动手（放材料、写进展、提交验收、让 Agent 改材料）时，未启动的执行事项自动进行中。
 * 协作者做同样的事不改状态：进度只认推进人自报，推进人的动作就是自报。和动作在同一个事务里调用。
 */
export async function startTaskByOwner(q: Query, ref: ThreadRef, personId: string): Promise<void> {
  if (ref.objectType !== "task" || !UUID_PATTERN.test(ref.objectId)) return;
  await q(`UPDATE tasks SET status='in_progress',version=version+1,updated_at=now()
    WHERE id=$1 AND owner_id=$2 AND status='not_started'`, [ref.objectId, personId]);
}
async function getTaskRow(q: Query, id: string): Promise<TaskRow | null> {
  if (!UUID_PATTERN.test(id)) return null;
  return (await q(`${TASK_SELECT} WHERE t.id=$1`, [id])).rows[0] as TaskRow | undefined ?? null;
}
export async function getTaskView(q: Query, id: string, names: Map<string, string>): Promise<TTaskView | null> {
  const row = await getTaskRow(q, id);
  return row ? projectTask(row, names) : null;
}
/** 一次取多条，按 ids 的顺序；不在了的跳过。 */
export async function getTaskViews(q: Query, ids: string[], names: Map<string, string>): Promise<TTaskView[]> {
  if (!ids.length) return [];
  const rows = new Map(((await q(`${TASK_SELECT} WHERE t.id=ANY($1::uuid[])`, [ids])).rows as TaskRow[]).map((row) => [row.id, row]));
  return ids.flatMap((id) => { const row = rows.get(id); return row ? [projectTask(row, names)] : []; });
}
export async function listMyTasks(q: Query, ownerId: string, names: Map<string, string>): Promise<TTaskView[]> {
  const rows = (await q(`${TASK_SELECT} WHERE t.owner_id=$1 ORDER BY t.created_at DESC,t.id`, [ownerId])).rows as TaskRow[];
  return rows.map((row) => projectTask(row, names));
}
export async function listMissionItems(q: Query, missionId: string, names: Map<string, string>): Promise<TTaskView[]> {
  const rows = (await q(`${TASK_SELECT} WHERE t.mission_id=$1 ORDER BY t.step_order,t.id`, [missionId])).rows as TaskRow[];
  return rows.map((row) => projectTask(row, names));
}
export async function canReadTask(q: Query, id: string, personId: string): Promise<boolean> {
  if (!UUID_PATTERN.test(id)) return false;
  const result = await q(`SELECT 1 FROM tasks t WHERE t.id=$1 AND (t.owner_id=$2 OR EXISTS
    (SELECT 1 FROM task_members tm WHERE tm.task_id=t.id AND tm.person_id=$2 AND tm.role='collaborator' AND tm.left_at IS NULL))`, [id, personId]);
  return !!result.rowCount;
}
export type TaskResult = { task: TTaskView } | { notFound: true } | { conflict: TTaskView } | { error: { status: number; code: string; message: string } };
const error = (status: number, code: string, message: string): TaskResult => ({ error: { status, code, message } });
/** Task 挂在 Mission 下，独立事项没有 Task 可挂。planTaskId 不回本体核对，原样存。 */
const independentWithTask = error(400, "INVALID_INPUT", "独立事项不能挂 Task");
const title = (text: string) => Array.from(text).slice(0, 120).join("");
export const validDate = (value:string):boolean => {
  const parsed=new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0,10)===value;
};
const validDates = (start: string | null, due: string | null) =>
  (!start || validDate(start)) && (!due || validDate(due)) && (!start || !due || start <= due);

/**
 * 本人能挂执行事项的 Mission：本人的、不是占位、月份未过；有任务卡的要等卡所在轮次确认，
 * 没有任务卡的（从本体载入的）不用等。事项上显示所属 Mission 也是同一条（TASK_SELECT 的 mission_title）：
 * 卡被退回、重新准备时，事项和私聊读不到这个 Mission。战场名取任务卡轮次的战场，没有卡时取 Mission 的第一个战场，再没有取能力域名。
 */
const AVAILABLE_MISSIONS = `SELECT m.id,m.code,m.title,m.period,COALESCE(rb.name,mb.name,cap.name,'') AS battlefield FROM missions m
  LEFT JOIN personal_mission_cards c ON c.id=m.personal_mission_card_id LEFT JOIN mission_rounds r ON r.id=c.round_id
  LEFT JOIN battlefield_config rb ON rb.id=r.battlefield_id LEFT JOIN battlefield_config mb ON mb.id=m.battlefield_ids->>0
  LEFT JOIN capability_config cap ON cap.id=m.capability_id
  WHERE m.owner_id=$1 AND NOT m.placeholder AND m.period >= $2 AND (c.id IS NULL OR r.status='confirmed')`;
type AvailableMission = { id: string; code: string; title: string; period: string; battlefield: string };
export async function missionAvailable(q: Query, ownerId: string, missionId: string, now: Date): Promise<boolean> {
  return !!(await q(`${AVAILABLE_MISSIONS} AND m.id=$3`, [ownerId, companyPeriod(now), missionId])).rowCount;
}
/** 本人此刻能挂执行事项的 Mission（与 missionAvailable 同一口径）。 */
export async function listAvailableMissions(q: Query, ownerId: string, now: Date): Promise<AvailableMission[]> {
  return (await q(`${AVAILABLE_MISSIONS} ORDER BY m.period,m.code,m.id`, [ownerId, companyPeriod(now)])).rows as AvailableMission[];
}
export async function renumberMission(client: PoolClient, missionId: string): Promise<void> {
  await client.query(`WITH numbered AS (SELECT id,row_number() OVER (ORDER BY step_order NULLS LAST,created_at,id)::int AS ord
    FROM tasks WHERE mission_id=$1) UPDATE tasks t SET step_order=n.ord FROM numbered n WHERE t.id=n.id AND t.step_order IS DISTINCT FROM n.ord`, [missionId]);
}
async function appendStep(client: PoolClient, missionId: string | null): Promise<number | null> {
  if (!missionId) return null;
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`task-mission:${missionId}`]);
  const result = await client.query<{ n: number }>("SELECT COALESCE(MAX(step_order),0)::int+1 AS n FROM tasks WHERE mission_id=$1", [missionId]);
  return result.rows[0].n;
}
async function threadMessage(client: PoolClient, taskId: string, content: string): Promise<number> {
  return postCoAgentMessage(client.query.bind(client), { objectType: "task", objectId: taskId }, content);
}
async function readThrough(client: PoolClient, taskId: string, personId: string, messageId: number): Promise<void> {
  await client.query(`INSERT INTO thread_reads(object_type,object_id,person_id,last_read_id) VALUES('task',$1,$2,$3)
    ON CONFLICT(object_type,object_id,person_id) DO UPDATE SET last_read_id=GREATEST(thread_reads.last_read_id,EXCLUDED.last_read_id),updated_at=now()`,
  [taskId, personId, messageId]);
}
async function createInTransaction(client: PoolClient, ownerId: string, names: Map<string, string>, input: {
  clientId: string; title: string; missionId: string | null; startDate?: string; dueDate?: string; doneDefinition?: string; planTaskId?: string; source: "self" | "plan" | "agent";
}): Promise<TaskResult> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`task-client:${ownerId}:${input.clientId}`]);
  const existing = await client.query<{ id: string; title: string; mission_id: string | null; start_date: string | null; due_date: string | null; done_definition: string | null; plan_task_id: string | null; created_by: string }>(
    "SELECT id::text,title,mission_id,start_date::text,due_date::text,done_definition,plan_task_id,created_by FROM tasks WHERE owner_id=$1 AND client_id=$2", [ownerId,input.clientId]);
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.title !== input.title || row.mission_id !== input.missionId || row.start_date !== (input.startDate ?? null)
      || row.due_date !== (input.dueDate ?? null) || row.done_definition !== (input.doneDefinition ?? null)
      || row.plan_task_id !== (input.planTaskId ?? null) || row.created_by !== input.source)
      return error(409,"CLIENT_ID_CONFLICT","此创建请求已用于另一项执行事项");
    return { task: (await getTaskView(queryOf(client),row.id,names))! };
  }
  if (!validDates(input.startDate ?? null,input.dueDate ?? null)) return error(400,"TASK_DATES_INVALID","计划开始不能晚于截止");
  const step = await appendStep(client,input.missionId);
  const id = randomUUID();
  await client.query(`INSERT INTO tasks(id,title,owner_id,created_by,status,mission_id,step_order,client_id,start_date,due_date,done_definition,plan_task_id)
    VALUES($1,$2,$3,$4,'not_started',$5,$6,$7,$8,$9,$10,$11)`,
  [id,input.title,ownerId,input.source,input.missionId,step,input.clientId,input.startDate ?? null,input.dueDate ?? null,input.doneDefinition ?? null,input.planTaskId ?? null]);
  await client.query("INSERT INTO task_members(task_id,person_id,role,added_by) VALUES($1,$2,'owner',$2)",[id,ownerId]);
  await client.query("INSERT INTO thread_members(object_type,object_id,person_id,added_by) VALUES('task',$1,$2,$2)",[id,ownerId]);
  const row = (await getTaskRow(queryOf(client),id))!;
  const ownerName = names.get(ownerId) ?? ownerId;
  // 开场写进群里就不再回改，所以不写会随拆分变化的「第 n 步，共 m 步」。
  const belonging = row.mission_title ? `所属个人任务「${row.mission_title}」` : "独立事项";
  const messageId = await threadMessage(client,id,`这个群讨论${ownerName}推进的执行事项「${input.title}」（${belonging}），截止 ${input.dueDate ?? "待定"}。`);
  await readThrough(client,id,ownerId,messageId);
  return { task: (await getTaskView(queryOf(client),id,names))! };
}
/** source=agent：外部工具通过 MCP 替本人建的，直接生效，和本人建的一样能改能删。 */
export async function createMyTask(pool: Pool, ownerId: string, names: Map<string,string>, input: TCreateMyTaskRequest, now: Date, source: "self" | "agent" = "self"): Promise<TaskResult> {
  if (input.planTaskId && !input.missionId) return independentWithTask;
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const replay = await client.query("SELECT 1 FROM tasks WHERE owner_id=$1 AND client_id=$2",[ownerId,input.clientId]);
    if (!replay.rowCount && input.missionId && !await missionAvailable(queryOf(client),ownerId,input.missionId,now)) {
      await client.query("ROLLBACK"); return error(404,"MISSION_NOT_AVAILABLE","个人任务不可用于创建执行事项");
    }
    const result = await createInTransaction(client,ownerId,names,{ ...input,source });
    await client.query("COMMIT"); return result;
  } catch (e) { await client.query("ROLLBACK").catch(()=>undefined); throw e; } finally { client.release(); }
}
async function lockedOwnerTask(client: PoolClient, ownerId: string, taskId: string): Promise<TaskRow | null> {
  if (!UUID_PATTERN.test(taskId)) return null;
  await client.query("SELECT id FROM tasks WHERE id=$1 AND owner_id=$2 FOR UPDATE",[taskId,ownerId]);
  const row = await getTaskRow(queryOf(client),taskId);
  return row?.owner_id === ownerId ? row : null;
}
async function ownerMutation(pool: Pool, ownerId: string, taskId: string, version: number, names: Map<string,string>,
  apply: (client: PoolClient,row: TaskRow)=>Promise<TaskResult | void>): Promise<TaskResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await lockedOwnerTask(client,ownerId,taskId);
    if (!row) { await client.query("ROLLBACK"); return { notFound:true }; }
    if (row.version !== version) { await client.query("ROLLBACK"); return { conflict:projectTask(row,names) }; }
    const failed = await apply(client,row);
    if (failed) { await client.query("ROLLBACK"); return failed; }
    const task = (await getTaskView(queryOf(client),taskId,names))!;
    await client.query("COMMIT"); return { task };
  } catch(e) { await client.query("ROLLBACK").catch(()=>undefined); throw e; } finally { client.release(); }
}
export function updateMyTaskStatus(pool: Pool, ownerId: string, taskId: string, input: TPatchMyTaskRequest, names: Map<string,string>, now: Date): Promise<TaskResult> {
  return ownerMutation(pool,ownerId,taskId,input.version,names,async(client,row)=>{
    if (input.status && row.status === "done") return error(409,"TASK_ALREADY_DONE","这件事已经验收完成；要继续做，请推进人在天枢里重新打开");
    const start = input.startDate === undefined ? row.start_date : input.startDate;
    const due = input.dueDate === undefined ? row.due_date : input.dueDate;
    if (!validDates(start,due)) return error(400,"TASK_DATES_INVALID","计划开始不能晚于截止");
    const missionId = input.missionId === undefined ? row.mission_id : input.missionId;
    // 换了 Mission，原来的 Task 不再对得上：同一请求没带新的就清掉。
    const planTaskId = input.planTaskId !== undefined ? input.planTaskId : missionId === row.mission_id ? row.plan_task_id : null;
    if (planTaskId && !missionId) return independentWithTask;
    // 卡住：清掉卡在哪就连同在等谁一起清；在等谁要是名单里的另一个人。
    const blockedReason = input.blockedReason === undefined ? row.blocked_reason : input.blockedReason;
    const waitingOn = blockedReason === null ? null : input.waitingOn === undefined ? row.waiting_on : input.waitingOn;
    if (waitingOn && (waitingOn === ownerId || !names.has(waitingOn))) return error(400,"INVALID_INPUT","在等的人不在人员名单里");
    if (missionId && missionId !== row.mission_id && !await missionAvailable(queryOf(client),ownerId,missionId,now))
      return error(404,"MISSION_NOT_AVAILABLE","个人任务不可用于执行事项");
    const step = missionId === row.mission_id ? row.step_order : await appendStep(client,missionId);
    await client.query(`UPDATE tasks SET status=COALESCE($2,status),title=COALESCE($3,title),start_date=$4,due_date=$5,
      done_definition=$6,judgment=$7,judgment_at=CASE WHEN $7::text IS NULL THEN NULL WHEN $7::text IS DISTINCT FROM judgment THEN now() ELSE judgment_at END,mission_id=$8,step_order=$9,return_reason=CASE WHEN $2 IS NOT NULL THEN NULL ELSE return_reason END,
      plan_task_id=$10,blocked_reason=$11,waiting_on=$12,blocked_at=CASE WHEN $11::text IS NULL THEN NULL ELSE COALESCE(blocked_at,now()) END,
      version=version+1,updated_at=now() WHERE id=$1`,
    [taskId,input.status ?? null,input.title ?? null,start,due,input.doneDefinition === undefined ? row.done_definition : input.doneDefinition,
      input.judgment === undefined ? row.judgment : input.judgment,missionId,step,planTaskId,blockedReason,waitingOn]);
    if (row.mission_id && row.mission_id !== missionId) await renumberMission(client,row.mission_id);
  });
}
export function returnMyTask(pool: Pool, ownerId: string, taskId: string, input: TReturnMyTaskRequest, names: Map<string,string>): Promise<TaskResult> {
  return ownerMutation(pool,ownerId,taskId,input.version,names,async(client,row)=>{
    if (row.created_by !== "meeting") return error(409,"TASK_NOT_RETURNABLE","只有会后分派的执行事项可以退回");
    // 退回了就不再等验收：外部工具先前的提交一并清掉，「等你验收」的通知标为已读。
    await client.query("UPDATE tasks SET status='returned',return_reason=$2,submission=NULL,version=version+1,updated_at=now() WHERE id=$1",[taskId,input.reason]);
    await settleSubmissionNotices(client,taskId);
    if (row.lead_dri_id && row.lead_dri_id !== ownerId)
      await insertNotification(client,{personId:row.lead_dri_id,kind:"task_returned",objectType:"task",objectId:taskId,actorId:ownerId});
  });
}
type CheckInput = Pick<TTaskStandardCheck, "index" | "met"> & { evidence?: string | null; materialId?: string | null };
const TOOL_NAME: Record<TTaskProgressSource, string> = { web: "网页", codex: " Codex ", claude: " Claude Code ", github: " GitHub ", other: "外部工具" };

/** 判断只能对现有的完成标准；交付结果和依据只能指向这件事现有的材料。 */
async function checkAcceptanceInput(client: PoolClient, taskId: string, standards: string[], checks: CheckInput[], deliverables: string[]): Promise<TaskResult | void> {
  if (checks.some((check) => check.index >= standards.length) || new Set(checks.map((check) => check.index)).size !== checks.length)
    return error(400,"ACCEPTANCE_STANDARD_INVALID","完成标准刚改过，请刷新后再验收");
  const materials = new Set((await client.query<{ id: string }>(
    "SELECT id::text FROM object_materials WHERE object_type='task' AND object_id=$1 AND deleted_at IS NULL",[taskId])).rows.map((item) => item.id));
  const referenced = [...deliverables, ...checks.flatMap((check) => check.materialId ? [check.materialId] : [])];
  if (referenced.some((id) => !materials.has(id))) return error(400,"ACCEPTANCE_MATERIAL_INVALID","选的材料已经不在这件事里，请刷新后再验收");
}
const settleSubmissionNotices = (client: PoolClient, taskId: string) => client.query(
  "UPDATE notifications SET read_at=now() WHERE kind='task_submitted' AND object_type='task' AND object_id=$1 AND read_at IS NULL",[taskId]);
/** 验收、重新打开、提交验收不写进进展（进展只放人和工具写的真实进展，本体每周拉它），由 Co-Agent 在事项群组里说一句。 */
const tellGroup = (client: PoolClient, taskId: string, ownerId: string, text: string) =>
  postCoAgentMessage(queryOf(client), { objectType: "task", objectId: taskId }, text, [ownerId]);

/** 推进人验收：逐条对完成标准，每一条都确认达到才算完成（没写完成标准的先写再验收；有一条没达到走退回）。
 *  存完成标准的文字快照和逐条判断、交付结果、一句结论；清掉待验收的提交。
 *  viaAgent：本人在对话里说了验收通过，由他自己的外部工具代为确认；群里记下工具和本人原话。 */
export function acceptMyTask(pool: Pool, ownerId: string, taskId: string, input: TAcceptMyTaskRequest, names: Map<string,string>, now: Date,
  viaAgent?: { client: TTaskProgressSource; userConfirmation: string }): Promise<TaskResult> {
  return ownerMutation(pool,ownerId,taskId,input.version,names,async(client,row)=>{
    if (row.status === "done") return error(409,"TASK_ALREADY_DONE","这件事已经验收过了");
    if (row.status === "returned") return error(409,"TASK_RETURNED","已退回的事项不能验收");
    const standards = taskStandards(row.done_definition);
    const deliverables = [...new Set(input.deliverableMaterialIds)];
    const failed = await checkAcceptanceInput(client,taskId,standards,input.standards,deliverables);
    if (failed) return failed;
    if (!standards.length) return error(400,"ACCEPTANCE_NO_STANDARDS","这件事还没写完成标准，先写完成标准再验收");
    const checks = new Map(input.standards.map((check) => [check.index, check]));
    if (standards.some((_, index) => !checks.get(index)?.met)) return error(400,"ACCEPTANCE_NOT_ALL_MET","还有完成标准没确认达到；没达到的请退回");
    const verdict = input.verdict?.trim() || null;
    const acceptance: StoredAcceptance = { by: ownerId, at: now.toISOString(), verdict, deliverableMaterialIds: deliverables,
      standards: standards.map((text, index) => {
        const check = checks.get(index)!;
        return { text, met: true, evidence: check.evidence?.trim() || null, materialId: check.materialId ?? null };
      }) };
    await client.query("UPDATE tasks SET status='done',acceptance=$2,submission=NULL,blocked_reason=NULL,waiting_on=NULL,blocked_at=NULL,version=version+1,updated_at=now() WHERE id=$1",
      [taskId,JSON.stringify(acceptance)]);
    await settleSubmissionNotices(client,taskId);
    const who = names.get(ownerId) ?? ownerId;
    await tellGroup(client,taskId,ownerId,viaAgent
      ? `${who}在${TOOL_NAME[viaAgent.client]}里确认验收（“${viaAgent.userConfirmation.trim()}”）${verdict ? `：${verdict}` : "。"}`
      : `${who}验收了这件事${verdict ? `：${verdict}` : "。"}`);
  });
}
/** 验收退回：逐条对完成标准时有没达到的，每条没达到的都写原因；清掉外部工具的提交（有的话），状态不变，群里记下哪几条没达到、为什么。 */
export function returnMyTaskAcceptance(pool: Pool, ownerId: string, taskId: string, input: { version: number; standards: CheckInput[] }, names: Map<string,string>): Promise<TaskResult> {
  return ownerMutation(pool,ownerId,taskId,input.version,names,async(client,row)=>{
    if (row.status === "done") return error(409,"TASK_ALREADY_DONE","这件事已经验收过了");
    if (row.status === "returned") return error(409,"TASK_RETURNED","已退回的事项不能验收");
    const standards = taskStandards(row.done_definition);
    const failed = await checkAcceptanceInput(client,taskId,standards,input.standards,[]);
    if (failed) return failed;
    const missed = input.standards.filter((check) => !check.met);
    if (!missed.length) return error(400,"ACCEPTANCE_NOTHING_MISSED","每条都达到了，直接验收完成");
    if (missed.some((check) => !check.evidence?.trim())) return error(400,"ACCEPTANCE_REASON_REQUIRED","没达到的每一条都写一句原因");
    await client.query("UPDATE tasks SET submission=NULL,version=version+1,updated_at=now() WHERE id=$1",[taskId]);
    await settleSubmissionNotices(client,taskId);
    const lines = missed.sort((a, b) => a.index - b.index).map((check) => `「${standards[check.index]}」：${check.evidence!.trim()}`);
    await tellGroup(client,taskId,ownerId,`${names.get(ownerId) ?? ownerId}验收没通过，退回接着做。没达到：${lines.join("；")}`);
  });
}
/** 重新打开：状态回进行中，清掉验收记录（不留历史，群里那句就是记录）。 */
export function reopenMyTask(pool: Pool, ownerId: string, taskId: string, version: number, names: Map<string,string>): Promise<TaskResult> {
  return ownerMutation(pool,ownerId,taskId,version,names,async(client,row)=>{
    if (row.status !== "done") return error(409,"TASK_NOT_DONE","只有已完成的事项能重新打开");
    await client.query("UPDATE tasks SET status='in_progress',acceptance=NULL,version=version+1,updated_at=now() WHERE id=$1",[taskId]);
    await tellGroup(client,taskId,ownerId,`${names.get(ownerId) ?? ownerId}重新打开了这件事。`);
  });
}
/**
 * 外部工具替推进人提交验收（可带草稿）：完成只能由推进人逐条对完成标准确认。未启动的同时变进行中（这是推进人自己的工具）；
 * 推进人收到「等你验收」，同一件事只留最新一条未读。
 */
export function submitMyTaskForAcceptance(pool: Pool, ownerId: string, taskId: string,
  input: { version: number; verdict?: string | null; standards?: CheckInput[]; deliverables?: string[] },
  via: TTaskProgressSource, names: Map<string,string>, now: Date): Promise<TaskResult> {
  return ownerMutation(pool,ownerId,taskId,input.version,names,async(client,row)=>{
    if (row.status === "done") return error(409,"TASK_ALREADY_DONE","这件事已经验收完成");
    if (row.status === "returned") return error(409,"TASK_RETURNED","已退回的事项不能提交验收");
    const standards = taskStandards(row.done_definition);
    const checks = input.standards ?? [];
    const deliverables = [...new Set(input.deliverables ?? [])];
    const failed = await checkAcceptanceInput(client,taskId,standards,checks,deliverables);
    if (failed) return failed;
    const verdict = input.verdict?.trim() || null;
    const submission: StoredSubmission = { by: ownerId, via, at: now.toISOString(), verdict,
      standards: checks.map((check) => ({ index: check.index, met: check.met, evidence: check.evidence?.trim() || null, materialId: check.materialId ?? null })),
      deliverableMaterialIds: deliverables };
    await client.query(`UPDATE tasks SET submission=$2,status=CASE WHEN status='not_started' THEN 'in_progress' ELSE status END,
      version=version+1,updated_at=now() WHERE id=$1`,[taskId,JSON.stringify(submission)]);
    await client.query("DELETE FROM notifications WHERE kind='task_submitted' AND object_type='task' AND object_id=$1 AND read_at IS NULL",[taskId]);
    await insertNotification(client,{personId:ownerId,kind:"task_submitted",objectType:"task",objectId:taskId,actorId:ownerId});
    await tellGroup(client,taskId,ownerId,`${names.get(ownerId) ?? ownerId}用${TOOL_NAME[via]}提交了验收。`);
  });
}
/** 网页上只删未启动的；anyStatus：推进人自己的外部工具整理事项（合并过碎、重复、过时的），什么状态都能删。会后分派的只能退回。 */
export async function deleteMyTask(pool: Pool, ownerId: string, taskId: string, version: number, names: Map<string,string>, anyStatus = false): Promise<TaskResult | { deleted:true }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await lockedOwnerTask(client,ownerId,taskId);
    if (!row) { await client.query("ROLLBACK"); return { notFound:true }; }
    if (row.version !== version) { await client.query("ROLLBACK"); return { conflict:projectTask(row,names) }; }
    if (row.created_by === "meeting") { await client.query("ROLLBACK"); return error(409,"TASK_NOT_DELETABLE","会后分派的事项不能删除，只能退回"); }
    if (row.status !== "not_started" && !anyStatus) { await client.query("ROLLBACK"); return error(409,"TASK_NOT_DELETABLE","只有未启动的自建或计划事项可以删除"); }
    for (const table of ["thread_reads","thread_messages","thread_members"]) await client.query(`DELETE FROM ${table} WHERE object_type='task' AND object_id=$1`,[taskId]);
    await client.query("DELETE FROM notifications WHERE object_type='task' AND object_id=$1",[taskId]);
    await client.query("UPDATE object_materials SET deleted_at=now() WHERE object_type='task' AND object_id=$1 AND deleted_at IS NULL",[taskId]);
    await client.query("DELETE FROM tasks WHERE id=$1",[taskId]);
    if (row.mission_id) await renumberMission(client,row.mission_id);
    await client.query("COMMIT"); return { deleted:true };
  } catch(e) { await client.query("ROLLBACK").catch(()=>undefined); throw e; } finally { client.release(); }
}
/** invitable：可以被邀请协作的人。CEO 工作台还打不开执行事项，先不在名单里（用户 2026-09-27）。 */
export async function getTaskDetail(q: Query, taskId: string, viewerId: string, names: Map<string,string>, now: Date, invitable: Set<string>): Promise<TTaskDetailResponse | null> {
  if (!await canReadTask(q,taskId,viewerId)) return null;
  const row = (await getTaskRow(q,taskId))!;
  const owner = row.owner_id === viewerId;
  const note = owner ? null : (await q("SELECT note,updated_at FROM task_notes WHERE task_id=$1 AND person_id=$2",[taskId,viewerId])).rows[0] as { note: string; updated_at: Date } | undefined;
  const missionOptions = owner ? (await listAvailableMissions(q,viewerId,now))
    .map((m)=>({ missionId:m.id,title:m.title,battlefieldName:m.battlefield,period:m.period })) : [];
  const excluded = new Set([row.owner_id,...row.collaborators]);
  const collaboratorOptions = owner ? [...names].filter(([id])=>!excluded.has(id) && invitable.has(id)).map(([id])=>person(id,names)) : [];
  return { task:projectTask(row,names),judgment:row.judgment,judgmentAt:row.judgment_at?.toISOString() ?? null,
    myNote:note?.note ?? null,myNoteAt:note?.updated_at.toISOString() ?? null,role:owner?"owner":"collaborator",missionOptions,collaboratorOptions,
    progress: await listTaskProgress(q,taskId,names), standards: taskStandards(row.done_definition),
    submission: row.submission && row.status !== "done" ? { ...row.submission, by: person(row.submission.by,names) } : null,
    acceptance: row.acceptance && row.status === "done" ? { ...row.acceptance, by: person(row.acceptance.by,names) } : null };
}
export async function putMyTaskNote(pool: Pool, viewerId: string, taskId: string, note: string | null): Promise<{ myNote:string | null } | { notFound:true }> {
  const q: Query = (sql,params)=>pool.query(sql,params);
  const row = await getTaskRow(q,taskId);
  if (!row || row.owner_id === viewerId || !await canReadTask(q,taskId,viewerId)) return { notFound:true };
  if (note === null) await pool.query("DELETE FROM task_notes WHERE task_id=$1 AND person_id=$2",[taskId,viewerId]);
  else await pool.query(`INSERT INTO task_notes(task_id,person_id,note,updated_at) VALUES($1,$2,$3,now())
    ON CONFLICT(task_id,person_id) DO UPDATE SET note=EXCLUDED.note,updated_at=now()`,[taskId,viewerId,note]);
  return { myNote:note };
}
export async function addTaskCollaborators(pool: Pool, ownerId: string, taskId: string, names: Map<string,string>, input: TAddTaskCollaboratorsRequest, invitable: Set<string>, intro?: { agent: ThreadIntroAgent; peopleDirectory: PeopleDirectory }): Promise<TaskResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await lockedOwnerTask(client,ownerId,taskId);
    if (!row) { await client.query("ROLLBACK"); return { notFound:true }; }
    const ids = [...new Set(input.personIds)].filter((id)=>id !== ownerId && !row.collaborators.includes(id));
    if (ids.some((id)=>!names.has(id) || !invitable.has(id))) { await client.query("ROLLBACK"); return error(400,"COLLABORATOR_NOT_AVAILABLE","这位同事暂时不能邀请协作"); }
    if (row.collaborators.length+ids.length>10) { await client.query("ROLLBACK"); return error(400,"COLLABORATOR_LIMIT","一件事项最多 10 位协作者"); }
    for (const id of ids) {
      await client.query(`INSERT INTO task_members(task_id,person_id,role,added_by) VALUES($1,$2,'collaborator',$3)
        ON CONFLICT(task_id,person_id) DO UPDATE SET role='collaborator',left_at=NULL,added_by=EXCLUDED.added_by`,[taskId,id,ownerId]);
      await client.query(`INSERT INTO thread_members(object_type,object_id,person_id,added_by) VALUES('task',$1,$2,$3)
        ON CONFLICT(object_type,object_id,person_id) DO UPDATE SET left_at=NULL`,[taskId,id,ownerId]);
      await client.query(`INSERT INTO thread_reads(object_type,object_id,person_id,last_read_id)
        SELECT 'task',$1,$2,COALESCE(MAX(id),0) FROM thread_messages WHERE object_type='task' AND object_id=$1
        ON CONFLICT(object_type,object_id,person_id) DO UPDATE SET last_read_id=GREATEST(thread_reads.last_read_id,EXCLUDED.last_read_id),updated_at=now()`,[taskId,id]);
      await insertNotification(client,{personId:id,kind:"task_collaborator_added",objectType:"task",objectId:taskId,actorId:ownerId});
    }
    if (ids.length) await client.query("UPDATE tasks SET version=version+1,updated_at=now() WHERE id=$1",[taskId]);
    const task = (await getTaskView(queryOf(client),taskId,names))!;
    await client.query("COMMIT");
    if (ids.length && intro) {
      const ref = { objectType: "task" as const, objectId: taskId };
      setImmediate(() => { void (async () => {
        const context = await threadIntroInput(pool.query.bind(pool), intro.peopleDirectory, ref, ownerId, ids);
        await postThreadIntro(pool, intro.agent, context, [ownerId, ...row.collaborators]);
      })().catch(() => undefined); });
    }
    return { task };
  } catch(e) { await client.query("ROLLBACK").catch(()=>undefined); throw e; } finally { client.release(); }
}

/** 会后推送保持原有幂等和通知规则，同时建立可访问的事项群组。会议卡的行动项没有逐字引用，quote 为 null。 */
export async function dispatchMeetingTodo(client: PoolClient, meeting: { id:string; leadDriId:string; ceoId:string; ownerName?:string; title?:string }, item:Pick<TMeetingOutcomeItem,"id"|"text"|"ownerPersonId"|"dueDate"> & { quote: string | null }): Promise<string | null> {
  const ownerId = item.ownerPersonId ?? meeting.leadDriId;
  if (ownerId === meeting.ceoId) return null;
  const inserted = await client.query<{id:string}>(`INSERT INTO tasks(id,title,due_date,status,owner_id,created_by,origin_meeting_id,origin_item_id,source_quote)
    VALUES($1,$2,$3,'not_started',$4,'meeting',$5,$6,$7)
    ON CONFLICT(origin_meeting_id,origin_item_id) WHERE origin_meeting_id IS NOT NULL DO NOTHING RETURNING id::text`,
  [randomUUID(),title(item.text),item.dueDate ?? null,ownerId,meeting.id,item.id,item.quote]);
  if (!inserted.rowCount) return (await client.query<{id:string}>("SELECT id::text FROM tasks WHERE origin_meeting_id=$1 AND origin_item_id=$2",[meeting.id,item.id])).rows[0].id;
  const taskId = inserted.rows[0].id;
  await client.query("INSERT INTO task_members(task_id,person_id,role,added_by) VALUES($1,$2,'owner','meeting')",[taskId,ownerId]);
  await client.query("INSERT INTO thread_members(object_type,object_id,person_id,added_by) VALUES('task',$1,$2,'meeting')",[taskId,ownerId]);
  const id = await threadMessage(client,taskId,`这个群讨论${meeting.ownerName ?? ownerId}推进的执行事项「${title(item.text)}」（独立事项${meeting.title ? `，来自会议「${meeting.title}」` : ""}），截止 ${item.dueDate ?? "待定"}。`);
  await readThrough(client,taskId,ownerId,id);
  await insertNotification(client,{personId:ownerId,kind:"meeting_action_assigned",objectType:"task",objectId:taskId});
  return taskId;
}
export async function deleteDispatchedTask(client:PoolClient, taskId:string): Promise<{ok:true}|{ok:false;code:string;message:string}> {
  const locked=await client.query<{status:string}>("SELECT status FROM tasks WHERE id=$1 FOR UPDATE",[taskId]);
  if (locked.rowCount!==1) return {ok:false,code:"TASK_NOT_FOUND",message:"执行事项不存在"};
  if (locked.rows[0].status!=="not_started") return {ok:false,code:"TASK_ALREADY_STARTED",message:"执行事项已被负责人处理，不能撤回"};
  for (const table of ["thread_reads","thread_messages","thread_members"]) await client.query(`DELETE FROM ${table} WHERE object_type='task' AND object_id=$1`,[taskId]);
  await client.query("DELETE FROM notifications WHERE object_type='task' AND object_id=$1",[taskId]);
  await client.query("DELETE FROM tasks WHERE id=$1",[taskId]);
  return {ok:true};
}

export { createInTransaction, queryOf };
