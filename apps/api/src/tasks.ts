import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { TAddTaskCollaboratorsRequest, TCreateMyTaskRequest, TMeetingOutcomeItem, TPatchMyTaskRequest, TReturnMyTaskRequest, TTaskDetailResponse, TTaskView } from "@warmap/contracts";
import { companyPeriod } from "./monthlyPlans.js";
import { UUID_PATTERN, type Query } from "./meetingStore.js";
import { insertNotification } from "./notifications.js";
import { listTaskProgress } from "./taskProgress.js";
import { postThreadIntro, type ThreadIntroAgent } from "./threadIntro.js";
import { threadIntroInput } from "./threads.js";
import type { CompanyMemoryRepository } from "./companyMemory.js";

type TaskRow = {
  id: string; version: number; title: string; status: TTaskView["status"]; created_by: TTaskView["source"];
  start_date: string | null; due_date: string | null; done_definition: string | null; judgment: string | null; judgment_at: Date | null;
  return_reason: string | null; origin_meeting_id: string | null; source_quote: string | null;
  meeting_title: string | null; lead_dri_id: string | null; owner_id: string; mission_id: string | null;
  mission_title: string | null; card_id: string | null; period: string | null; battlefield_name: string | null;
  step_order: number | null; steps: number | null; previous_id: string | null; previous_title: string | null; previous_status: string | null;
  collaborators: string[]; created_at: Date; updated_at: Date;
  latest_progress_body: string | null; latest_progress_source: "web" | "codex" | "claude" | "github" | null;
  latest_progress_author_id: string | null; latest_progress_created_at: Date | null;
};

const TASK_SELECT = `SELECT t.id::text,t.version,t.title,t.status,t.created_by,t.start_date::text AS start_date,
 t.due_date::text AS due_date,t.done_definition,t.judgment,t.judgment_at,t.return_reason,t.origin_meeting_id::text,
 t.source_quote,mt.title AS meeting_title,mt.lead_dri_id,t.owner_id,t.mission_id,t.step_order,
 m.title AS mission_title,c.id::text AS card_id,r.period,b.name AS battlefield_name,
 (SELECT count(*)::int FROM tasks s WHERE s.mission_id=t.mission_id) AS steps,
 prev.id::text AS previous_id,prev.title AS previous_title,prev.status AS previous_status,
 ARRAY(SELECT tm.person_id FROM task_members tm WHERE tm.task_id=t.id AND tm.role='collaborator' AND tm.left_at IS NULL ORDER BY tm.added_at,tm.person_id) AS collaborators,
 t.created_at,t.updated_at,lp.body AS latest_progress_body,lp.source AS latest_progress_source,
 lp.author_id AS latest_progress_author_id,lp.created_at AS latest_progress_created_at
 FROM tasks t
 LEFT JOIN meetings mt ON mt.id=t.origin_meeting_id
 LEFT JOIN missions m ON m.id=t.mission_id
 LEFT JOIN personal_mission_cards c ON c.id=m.personal_mission_card_id
 LEFT JOIN mission_rounds r ON r.id=c.round_id
 LEFT JOIN battlefield_config b ON b.id=r.battlefield_id
 LEFT JOIN tasks prev ON prev.mission_id=t.mission_id AND prev.step_order=t.step_order-1
 LEFT JOIN LATERAL (SELECT body,source,author_id,created_at FROM task_progress WHERE task_id=t.id ORDER BY created_at DESC,id DESC LIMIT 1) lp ON true`;

const queryOf = (client: PoolClient): Query => (sql, params) => client.query(sql, params);
const person = (id: string, names: Map<string, string>) => ({ personId: id, name: names.get(id) ?? id });
function projectTask(row: TaskRow, names: Map<string, string>): TTaskView {
  return {
    id: row.id, version: row.version, title: row.title, status: row.status, source: row.created_by,
    startDate: row.start_date, dueDate: row.due_date, doneDefinition: row.done_definition,
    mission: row.mission_id && row.card_id && row.period && row.mission_title && row.step_order
      ? { missionId: row.mission_id, title: row.mission_title, cardId: row.card_id, period: row.period,
          battlefieldName: row.battlefield_name ?? "", step: row.step_order, steps: row.steps ?? 1 } : null,
    waitingOn: row.previous_id && row.previous_status !== "done" ? { taskId: row.previous_id, title: row.previous_title! } : null,
    owner: person(row.owner_id, names), collaborators: row.collaborators.map((id) => person(id, names)),
    latestProgress: row.latest_progress_body && row.latest_progress_source && row.latest_progress_author_id && row.latest_progress_created_at
      ? { body: row.latest_progress_body, source: row.latest_progress_source, author: person(row.latest_progress_author_id, names), createdAt: row.latest_progress_created_at.toISOString() } : null,
    returnReason: row.return_reason,
    origin: row.origin_meeting_id ? { type: "meeting", meetingId: row.origin_meeting_id,
      meetingTitle: row.meeting_title ?? "", quote: row.source_quote } : null,
    createdAt: row.created_at.toISOString(), updatedAt: row.updated_at.toISOString(),
  };
}
async function getTaskRow(q: Query, id: string): Promise<TaskRow | null> {
  if (!UUID_PATTERN.test(id)) return null;
  return (await q(`${TASK_SELECT} WHERE t.id=$1`, [id])).rows[0] as TaskRow | undefined ?? null;
}
export async function getTaskView(q: Query, id: string, names: Map<string, string>): Promise<TTaskView | null> {
  const row = await getTaskRow(q, id);
  return row ? projectTask(row, names) : null;
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
const title = (text: string) => Array.from(text).slice(0, 120).join("");
export const validDate = (value:string):boolean => {
  const parsed=new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0,10)===value;
};
const validDates = (start: string | null, due: string | null) =>
  (!start || validDate(start)) && (!due || validDate(due)) && (!start || !due || start <= due);

/** 归属校验与计划共用；卡必须属于本人且该月轮次已经确定。 */
export async function missionAvailable(q: Query, ownerId: string, missionId: string, now: Date): Promise<boolean> {
  const result = await q(`SELECT 1 FROM missions m JOIN personal_mission_cards c ON c.id=m.personal_mission_card_id
    JOIN mission_rounds r ON r.id=c.round_id WHERE m.id=$1 AND c.owner_id=$2 AND r.status='confirmed' AND r.period >= $3`,
  [missionId, ownerId, companyPeriod(now)]);
  return !!result.rowCount;
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
  const result = await client.query<{ id: string }>(`INSERT INTO thread_messages(object_type,object_id,kind,content)
    VALUES ('task',$1,'co-agent',$2) RETURNING id::text`, [taskId, content]);
  return Number(result.rows[0].id);
}
async function readThrough(client: PoolClient, taskId: string, personId: string, messageId: number): Promise<void> {
  await client.query(`INSERT INTO thread_reads(object_type,object_id,person_id,last_read_id) VALUES('task',$1,$2,$3)
    ON CONFLICT(object_type,object_id,person_id) DO UPDATE SET last_read_id=GREATEST(thread_reads.last_read_id,EXCLUDED.last_read_id),updated_at=now()`,
  [taskId, personId, messageId]);
}
async function createInTransaction(client: PoolClient, ownerId: string, names: Map<string, string>, input: {
  clientId: string; title: string; missionId: string | null; startDate?: string; dueDate?: string; doneDefinition?: string; source: "self" | "plan";
}): Promise<TaskResult> {
  await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`task-client:${ownerId}:${input.clientId}`]);
  const existing = await client.query<{ id: string; title: string; mission_id: string | null; start_date: string | null; due_date: string | null; done_definition: string | null; created_by: string }>(
    "SELECT id::text,title,mission_id,start_date::text,due_date::text,done_definition,created_by FROM tasks WHERE owner_id=$1 AND client_id=$2", [ownerId,input.clientId]);
  if (existing.rows[0]) {
    const row = existing.rows[0];
    if (row.title !== input.title || row.mission_id !== input.missionId || row.start_date !== (input.startDate ?? null)
      || row.due_date !== (input.dueDate ?? null) || row.done_definition !== (input.doneDefinition ?? null) || row.created_by !== input.source)
      return error(409,"CLIENT_ID_CONFLICT","此创建请求已用于另一项执行事项");
    return { task: (await getTaskView(queryOf(client),row.id,names))! };
  }
  if (!validDates(input.startDate ?? null,input.dueDate ?? null)) return error(400,"TASK_DATES_INVALID","计划开始不能晚于截止");
  const step = await appendStep(client,input.missionId);
  const id = randomUUID();
  await client.query(`INSERT INTO tasks(id,title,owner_id,created_by,status,mission_id,step_order,client_id,start_date,due_date,done_definition)
    VALUES($1,$2,$3,$4,'not_started',$5,$6,$7,$8,$9,$10)`,
  [id,input.title,ownerId,input.source,input.missionId,step,input.clientId,input.startDate ?? null,input.dueDate ?? null,input.doneDefinition ?? null]);
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
export async function createMyTask(pool: Pool, ownerId: string, names: Map<string,string>, input: TCreateMyTaskRequest, now: Date): Promise<TaskResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const replay = await client.query("SELECT 1 FROM tasks WHERE owner_id=$1 AND client_id=$2",[ownerId,input.clientId]);
    if (!replay.rowCount && input.missionId && !await missionAvailable(queryOf(client),ownerId,input.missionId,now)) {
      await client.query("ROLLBACK"); return error(404,"MISSION_NOT_AVAILABLE","个人任务不可用于创建执行事项");
    }
    const result = await createInTransaction(client,ownerId,names,{ ...input,source:"self" });
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
    const start = input.startDate === undefined ? row.start_date : input.startDate;
    const due = input.dueDate === undefined ? row.due_date : input.dueDate;
    if (!validDates(start,due)) return error(400,"TASK_DATES_INVALID","计划开始不能晚于截止");
    const missionId = input.missionId === undefined ? row.mission_id : input.missionId;
    if (missionId && missionId !== row.mission_id && !await missionAvailable(queryOf(client),ownerId,missionId,now))
      return error(404,"MISSION_NOT_AVAILABLE","个人任务不可用于执行事项");
    const step = missionId === row.mission_id ? row.step_order : await appendStep(client,missionId);
    await client.query(`UPDATE tasks SET status=COALESCE($2,status),title=COALESCE($3,title),start_date=$4,due_date=$5,
      done_definition=$6,judgment=$7,judgment_at=CASE WHEN $7::text IS NULL THEN NULL WHEN $7::text IS DISTINCT FROM judgment THEN now() ELSE judgment_at END,mission_id=$8,step_order=$9,return_reason=CASE WHEN $2 IS NOT NULL THEN NULL ELSE return_reason END,
      version=version+1,updated_at=now() WHERE id=$1`,
    [taskId,input.status ?? null,input.title ?? null,start,due,input.doneDefinition === undefined ? row.done_definition : input.doneDefinition,
      input.judgment === undefined ? row.judgment : input.judgment,missionId,step]);
    if (row.mission_id && row.mission_id !== missionId) await renumberMission(client,row.mission_id);
  });
}
export function returnMyTask(pool: Pool, ownerId: string, taskId: string, input: TReturnMyTaskRequest, names: Map<string,string>): Promise<TaskResult> {
  return ownerMutation(pool,ownerId,taskId,input.version,names,async(client,row)=>{
    if (row.created_by !== "meeting") return error(409,"TASK_NOT_RETURNABLE","只有会后分派的执行事项可以退回");
    await client.query("UPDATE tasks SET status='returned',return_reason=$2,version=version+1,updated_at=now() WHERE id=$1",[taskId,input.reason]);
    if (row.lead_dri_id && row.lead_dri_id !== ownerId)
      await insertNotification(client,{personId:row.lead_dri_id,kind:"task_returned",objectType:"task",objectId:taskId,actorId:ownerId});
  });
}
export async function deleteMyTask(pool: Pool, ownerId: string, taskId: string, version: number, names: Map<string,string>): Promise<TaskResult | { deleted:true }> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const row = await lockedOwnerTask(client,ownerId,taskId);
    if (!row) { await client.query("ROLLBACK"); return { notFound:true }; }
    if (row.version !== version) { await client.query("ROLLBACK"); return { conflict:projectTask(row,names) }; }
    if (row.status !== "not_started" || row.created_by === "meeting") {
      await client.query("ROLLBACK"); return error(409,"TASK_NOT_DELETABLE","只有未启动的自建或计划事项可以删除");
    }
    for (const table of ["thread_reads","thread_messages","thread_members"]) await client.query(`DELETE FROM ${table} WHERE object_type='task' AND object_id=$1`,[taskId]);
    await client.query("DELETE FROM notifications WHERE object_type='task' AND object_id=$1",[taskId]);
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
  const missionOptions = owner ? (await q(`SELECT m.id AS "missionId",m.title,b.name AS "battlefieldName",r.period FROM missions m
    JOIN personal_mission_cards c ON c.id=m.personal_mission_card_id JOIN mission_rounds r ON r.id=c.round_id
    JOIN battlefield_config b ON b.id=r.battlefield_id WHERE c.owner_id=$1 AND r.status='confirmed' AND r.period >= $2 ORDER BY r.period,m.code,m.id`,
  [viewerId,companyPeriod(now)])).rows : [];
  const excluded = new Set([row.owner_id,...row.collaborators]);
  const collaboratorOptions = owner ? [...names].filter(([id])=>!excluded.has(id) && invitable.has(id)).map(([id])=>person(id,names)) : [];
  return { task:projectTask(row,names),judgment:row.judgment,judgmentAt:row.judgment_at?.toISOString() ?? null,
    myNote:note?.note ?? null,myNoteAt:note?.updated_at.toISOString() ?? null,role:owner?"owner":"collaborator",missionOptions,collaboratorOptions,
    progress: await listTaskProgress(q,taskId,names) };
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
export async function addTaskCollaborators(pool: Pool, ownerId: string, taskId: string, names: Map<string,string>, input: TAddTaskCollaboratorsRequest, invitable: Set<string>, intro?: { agent: ThreadIntroAgent; companyMemory: CompanyMemoryRepository }): Promise<TaskResult> {
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
        const context = await threadIntroInput(pool.query.bind(pool), intro.companyMemory, ref, ownerId, ids);
        await postThreadIntro(pool, intro.agent, context, [ownerId, ...row.collaborators]);
      })().catch(() => undefined); });
    }
    return { task };
  } catch(e) { await client.query("ROLLBACK").catch(()=>undefined); throw e; } finally { client.release(); }
}

/** 会后推送保持原有幂等和通知规则，同时建立可访问的事项群组。 */
export async function dispatchMeetingTodo(client: PoolClient, meeting: { id:string; leadDriId:string; ceoId:string; ownerName?:string; title?:string }, item:TMeetingOutcomeItem): Promise<string | null> {
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
