import type { Pool } from "pg";
import type { TMonthPlanResponse, TSaveMonthPlanRequest, TTaskView } from "@warmap/contracts";
import { companyPeriod } from "./monthlyPlans.js";
import type { Query } from "./meetingStore.js";
import { createInTransaction, getTaskView, queryOf, validDate } from "./tasks.js";

type Mission = { id:string; title:string; card_id:string; battlefield_name:string; milestones:string[] };
type PlanError = { status:number; code:string; message:string; latestTask?:TTaskView };
export type PlanResult = { plan:TMonthPlanResponse } | { error:PlanError };
const error = (status:number,code:string,message:string):PlanResult => ({error:{status,code,message}});
const localDay = (now:Date) => {
  const parts = new Intl.DateTimeFormat("en-CA",{timeZone:"Asia/Shanghai",year:"numeric",month:"2-digit",day:"2-digit"}).formatToParts(now);
  const p = Object.fromEntries(parts.map((part)=>[part.type,part.value]));
  return `${p.year}-${p.month}-${p.day}`;
};
export function milestoneDate(text:string,period:string):string|null {
  const iso = /^(\d{4}-\d{2}-\d{2})(?=$|\D)/.exec(text);
  const short = /^(\d{1,2})\/(\d{1,2})(?=$|\D)/.exec(text);
  const value = iso?.[1] ?? (short ? `${period.slice(0,4)}-${short[1].padStart(2,"0")}-${short[2].padStart(2,"0")}` : null);
  if (!value) return null;
  const parsed = new Date(`${value}T00:00:00Z`);
  return !Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0,10) === value ? value : null;
}
/** 一个月计划里的执行事项：本人挂在这些 Mission 下的；独立事项要日期落在这个月里，或没写日期且没完成。首页计划用同一条规则。 */
export async function listPlanItems(q:Query,ownerId:string,missionIds:string[],firstDay:string,lastDay:string,names:Map<string,string>):Promise<TTaskView[]> {
  const result=await q(`SELECT id::text
    FROM tasks WHERE owner_id=$1 AND (mission_id=ANY($2::text[]) OR (mission_id IS NULL AND
      (((start_date IS NULL OR start_date BETWEEN $3 AND $4) AND (due_date IS NULL OR due_date BETWEEN $3 AND $4)
        AND (start_date IS NOT NULL OR due_date IS NOT NULL)) OR
       (start_date IS NULL AND due_date IS NULL AND status<>'done'))))
    ORDER BY step_order NULLS LAST,created_at,id`,[ownerId,missionIds,firstDay,lastDay]);
  const tasks=await Promise.all(result.rows.map((row)=>getTaskView(q,row.id as string,names)));
  return tasks.filter((task):task is TTaskView=>!!task);
}
async function monthMissions(q:Query,ownerId:string,period:string):Promise<{ cards:{status:string}[]; missions:Mission[] }> {
  const cards = (await q(`SELECT r.status FROM personal_mission_cards c JOIN mission_rounds r ON r.id=c.round_id
    WHERE c.owner_id=$1 AND r.period=$2 ORDER BY c.sort_order,c.id`,[ownerId,period])).rows as {status:string}[];
  const missions = (await q(`SELECT m.id,m.title,c.id::text AS card_id,b.name AS battlefield_name,m.milestones
    FROM missions m JOIN personal_mission_cards c ON c.id=m.personal_mission_card_id
    JOIN mission_rounds r ON r.id=c.round_id JOIN battlefield_config b ON b.id=r.battlefield_id
    WHERE c.owner_id=$1 AND r.period=$2 AND r.status='confirmed' ORDER BY c.sort_order,m.code,m.id`,[ownerId,period])).rows as Mission[];
  return {cards,missions};
}
export async function readMonthPlan(q:Query,ownerId:string,period:string,names:Map<string,string>,now:Date):Promise<TMonthPlanResponse> {
  const {cards,missions}=await monthMissions(q,ownerId,period);
  const today=localDay(now);
  const firstDay=`${period}-01`;
  const lastDay=new Date(Date.UTC(Number(period.slice(0,4)),Number(period.slice(5,7)),0)).toISOString().slice(0,10);
  // 已确定的卡就能拆；同月别的战场还在讨论的卡，确定后再出现在计划里。
  const closedReason=!cards.length ? "这个月还没有你的任务卡" : !cards.some((card)=>card.status==="confirmed")
    ? "任务卡确定之后才能拆成执行事项" : period<companyPeriod(now) ? "月份已过，计划只读" : null;
  const views=await listPlanItems(q,ownerId,missions.map((m)=>m.id),firstDay,lastDay,names);
  const groups: TMonthPlanResponse["groups"] = missions.map((m)=>({missionId:m.id,title:m.title,battlefieldName:m.battlefield_name,
    cardId:m.card_id,milestones:m.milestones.map((text)=>({date:milestoneDate(text,period),text})),
    items:views.filter((task)=>task.mission?.missionId===m.id)}));
  groups.push({missionId:null,title:"独立事项",battlefieldName:null,cardId:null,milestones:[],items:views.filter((task)=>!task.mission)});
  return {period,firstDay,lastDay,today,editable:!closedReason,closedReason,groups};
}
export async function saveMonthPlan(pool:Pool,ownerId:string,names:Map<string,string>,input:TSaveMonthPlanRequest,now:Date):Promise<PlanResult> {
  const client=await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))",[`month-plan:${ownerId}:${input.period}`]);
    const q=queryOf(client);
    let current=await readMonthPlan(q,ownerId,input.period,names,now);
    if (!current.editable) { await client.query("ROLLBACK"); return error(409,"PLAN_NOT_EDITABLE",current.closedReason!); }
    for (const clientId of input.groups.flatMap(group=>group.items.flatMap(item=>item.clientId ? [item.clientId] : [])).sort())
      await q("SELECT pg_advisory_xact_lock(hashtext($1))",[`task-client:${ownerId}:${clientId}`]);
    for (const taskId of [...new Set(input.groups.flatMap(group=>group.items.flatMap(item=>item.taskId ? [item.taskId] : [])))].filter(id=>/^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i.test(id)).sort())
      await q("SELECT id FROM tasks WHERE id=$1 AND owner_id=$2 FOR UPDATE",[taskId,ownerId]);
    for (const missionId of input.groups.map(group=>group.missionId).filter((id):id is string=>!!id).sort())
      await q("SELECT pg_advisory_xact_lock(hashtext($1))",[`task-mission:${missionId}`]);
    current=await readMonthPlan(q,ownerId,input.period,names,now);
    if (!current.editable) { await client.query("ROLLBACK"); return error(409,"PLAN_NOT_EDITABLE",current.closedReason!); }
    const groups=new Map(current.groups.map((group)=>[group.missionId ?? "",group]));
    const seenGroups=new Set<string>();
    for (const group of input.groups) {
      const key=group.missionId ?? "";
      if (!groups.has(key) || seenGroups.has(key)) { await client.query("ROLLBACK"); return error(400,"PLAN_GROUP_INVALID","计划分组不存在或重复"); }
      seenGroups.add(key);
      const existing=groups.get(key)!.items;
      const seen=new Set<string>();
      const versioned=new Set<string>();
      const ordered:string[]=[];
      for (const item of group.items) {
        if (item.startDate != null && !validDate(item.startDate) || item.dueDate != null && !validDate(item.dueDate)) {
          await client.query("ROLLBACK"); return error(400,"PLAN_DATES_INVALID","日期无效，或开始晚于截止");
        }
        if (item.taskId) {
          const task=existing.find((value)=>value.id===item.taskId);
          if (!task) { await client.query("ROLLBACK"); return error(409,"PLAN_STALE","这一步已经在别处移走或删了，请刷新计划"); }
          if (seen.has(task.id) || item.clientId) { await client.query("ROLLBACK"); return error(400,"PLAN_ITEM_INVALID","计划事项重复或身份不明确"); }
          const start=item.startDate===undefined ? task.startDate : item.startDate;
          const due=item.dueDate===undefined ? task.dueDate : item.dueDate;
          if (start && due && start>due) { await client.query("ROLLBACK"); return error(400,"PLAN_DATES_INVALID","日期无效，或开始晚于截止"); }
          if (item.title!==undefined && item.title!==task.title || item.startDate!==undefined && item.startDate!==task.startDate ||
            item.dueDate!==undefined && item.dueDate!==task.dueDate) versioned.add(task.id);
          await q(`UPDATE tasks SET title=CASE WHEN $2::boolean THEN $3 ELSE title END,
            start_date=CASE WHEN $4::boolean THEN $5::date ELSE start_date END,
            due_date=CASE WHEN $6::boolean THEN $7::date ELSE due_date END,
            version=version+CASE WHEN ($2::boolean AND title IS DISTINCT FROM $3) OR ($4::boolean AND start_date IS DISTINCT FROM $5::date)
              OR ($6::boolean AND due_date IS DISTINCT FROM $7::date) THEN 1 ELSE 0 END,
            updated_at=CASE WHEN ($2::boolean AND title IS DISTINCT FROM $3) OR ($4::boolean AND start_date IS DISTINCT FROM $5::date)
              OR ($6::boolean AND due_date IS DISTINCT FROM $7::date) THEN now() ELSE updated_at END
            WHERE id=$1`,[task.id,item.title!==undefined,item.title??null,item.startDate!==undefined,item.startDate??null,item.dueDate!==undefined,item.dueDate??null]);
          seen.add(task.id); ordered.push(task.id);
        } else if (item.clientId && item.title?.trim()) {
          if (seen.has(item.clientId)) { await client.query("ROLLBACK"); return error(400,"PLAN_ITEM_INVALID","新步骤重复"); }
          if (item.startDate && item.dueDate && item.startDate>item.dueDate) {
            await client.query("ROLLBACK"); return error(400,"PLAN_DATES_INVALID","日期无效，或开始晚于截止");
          }
          const result=await createInTransaction(client,ownerId,names,{clientId:item.clientId,title:item.title,missionId:group.missionId,
            ...(item.startDate ? {startDate:item.startDate} : {}),...(item.dueDate ? {dueDate:item.dueDate} : {}),source:"plan"});
          if ("error" in result) { await client.query("ROLLBACK"); return {error:result.error}; }
          if (!("task" in result)) { await client.query("ROLLBACK"); return error(409,"PLAN_STALE","这一步已经在别处移走或删了，请刷新计划"); }
          if (result.task.mission?.missionId!==group.missionId && !(group.missionId===null && result.task.mission===null)) {
            await client.query("ROLLBACK"); return error(409,"PLAN_STALE","这一步已经在别处移走或删了，请刷新计划");
          }
          seen.add(item.clientId); seen.add(result.task.id); versioned.add(result.task.id); ordered.push(result.task.id);
        } else { await client.query("ROLLBACK"); return error(400,"PLAN_ITEM_INVALID","新步骤需要 clientId 和标题"); }
      }
      if (group.missionId) {
        ordered.push(...existing.filter(task=>!seen.has(task.id)).map(task=>task.id));
        for (const [index,id] of ordered.entries()) await q(`UPDATE tasks SET step_order=$2,
          version=version+CASE WHEN step_order IS DISTINCT FROM $2::integer AND NOT $4::boolean THEN 1 ELSE 0 END,
          updated_at=CASE WHEN step_order IS DISTINCT FROM $2::integer THEN now() ELSE updated_at END
          WHERE id=$1 AND mission_id=$3`,[id,index+1,group.missionId,versioned.has(id)]);
      }
    }
    const plan=await readMonthPlan(q,ownerId,input.period,names,now);
    await client.query("COMMIT"); return {plan};
  } catch(e) { await client.query("ROLLBACK").catch(()=>undefined); throw e; } finally { client.release(); }
}
