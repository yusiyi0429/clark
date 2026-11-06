import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Type } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
import type { CompanyEntry, CompanyReader, CompanyView } from "./company.js";
import type { Query } from "./meetingStore.js";
import type { PlanTaskSource } from "./planTasks.js";
import type { PlanTaskViewer } from "./planTaskAccess.js";
import { CITATION_SCHEME } from "./sourceCitations.js";
import { openPlanTask } from "./taskAgreements.js";
import { DeliverableError, readTaskDeliverable } from "./taskDeliverables.js";

/**
 * get_task_context（V2 第 21.2 节）：本机的规划员、执行 worker、验收员开工前读一个 Task 的上下文，只读。
 * 谁能读照约定（taskAgreements.openPlanTask：负责人、Mission 负责人、战场负责人、CEO、约定里的认可人），看不到的当找不到。
 * 本体里的事实按本人的授权范围读（company.ts，和伙伴对话同一个读法），每条带 cite:world:<id>@<版本>；天枢自己的数据（约定、交付物）不带本体出处。
 */

const TaskInput = Type.Object({ taskId: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false });

export const TASK_CONTEXT_TOOL: Tool = {
  name: "get_task_context",
  description: "读一个 Task 的上下文：Task 和约定（每条验收标准用什么证明、这次不包括什么）、所属 Mission 和战场目标、本体里相关的事实和最近进展（facts，每条带 cite，引用时照抄）、最近两版交付物和参考评审结果。只读。taskId 取开工交代里的 Task id。Read a plan task's context: agreement, mission and battlefield goals, ontology facts with citations, recent deliverable versions with reviews.",
  inputSchema: TaskInput as Tool["inputSchema"],
  annotations: { readOnlyHint: true },
};

export type TaskContextDeps = { q: Query; now: () => Date; planTasks: PlanTaskSource; names: Map<string, string>; company: CompanyReader };
const WORLD_TIMEOUT_MS = 30_000;
const VERSIONS = 2;

/** 执行 get_task_context：返回结果，或带错误码的失败；参数不合法时返回 null，由调用方报 INVALID_INPUT。 */
export async function readTaskContext(deps: TaskContextDeps, viewer: PlanTaskViewer, args: unknown, signal: AbortSignal):
  Promise<{ value: unknown; error?: string } | null> {
  if (!Value.Check(TaskInput, args)) return null;
  let opened: Awaited<ReturnType<typeof openPlanTask>>;
  try {
    opened = await openPlanTask(deps.q, deps.planTasks, viewer, deps.now(), args.taskId, deps.names);
  } catch (cause) {
    if (cause instanceof DeliverableError) return { value: { code: cause.code, message: cause.message }, error: cause.code };
    throw cause;
  }
  const { access, agreement } = opened;
  const mission = (await deps.q("SELECT id,title,milestones,owner_id FROM missions WHERE id=$1", [access.task.missionId])).rows[0] as
    { id: string; title: string; milestones: string[]; owner_id: string | null } | undefined;
  const battlefields = access.mission.battlefieldIds.length ? (await deps.q("SELECT id,name,six_month_outcome FROM battlefield_config WHERE id=ANY($1::text[]) ORDER BY sort_order,id",
    [access.mission.battlefieldIds])).rows as { id: string; name: string; six_month_outcome: string }[] : [];
  // 本体：先按 Task 和 Mission 的名字定位，再读本月目标（带上战场名字）；两次都只读定位到的几个对象。
  const company = { personId: viewer.personId, role: viewer.isCeo ? "ceo" as const : "member" as const };
  const bounded = AbortSignal.any([signal, AbortSignal.timeout(WORLD_TIMEOUT_MS)]);
  const reads: CompanyView[] = [];
  for (const query of [`${access.task.name} ${mission?.title ?? ""}`, `本月目标 ${battlefields.map((field) => field.name).join(" ")}`]) {
    reads.push(await deps.company.read(company, { query: query.trim(), locate: true }, bounded));
    if (reads[0].status !== "ready" && reads[0].status !== "empty") break;
  }
  const seen = new Set<string>();
  const facts = reads.flatMap((view) => view.entries).filter((entry) => !seen.has(entry.handle) && Boolean(seen.add(entry.handle)))
    .map((entry: CompanyEntry) => ({ cite: `${CITATION_SCHEME}world:${entry.ref}`, type: entry.type, title: entry.title, text: entry.text }));
  const world = reads.find((view) => view.status !== "ready") ?? reads[0];
  const deliverable = await readTaskDeliverable(deps.q, access, deps.names);
  return { value: {
    task: { taskId: access.task.taskId, name: access.task.name, missionId: access.task.missionId, basis: agreement.basis,
      responsible: access.responsibleId ? deps.names.get(access.responsibleId) ?? access.responsibleId : null, canEdit: access.canEdit,
      criteria: agreement.criteria.map(({ index, text, proof, acceptor }) => ({ index, text, proof, acceptor: acceptor?.name ?? null })), exclusions: agreement.exclusions },
    mission: mission ? { id: mission.id, title: mission.title, milestones: mission.milestones,
      owner: mission.owner_id ? deps.names.get(mission.owner_id) ?? mission.owner_id : null } : null,
    battlefields: battlefields.map((field) => ({ id: field.id, name: field.name, sixMonthGoal: field.six_month_outcome })),
    world: { status: facts.length ? "ready" : world.status, ...(world.message && !facts.length ? { message: world.message } : {}), facts },
    deliverable: { versions: deliverable.versions.slice(0, VERSIONS).map((version) => ({ number: version.number, statement: version.statement, createdAt: version.createdAt,
      deliveredAt: version.deliveredAt, items: version.items.map(({ kind, name, url }) => ({ kind, name, url })),
      review: { status: version.review.status, headline: version.review.headline, summary: version.review.summary, score: version.review.score, met: version.review.met,
        total: version.review.total, criteria: version.review.criteria.map(({ index, text, verdict, reason, fix }) => ({ index, text, verdict, reason, fix })),
        beyondScope: version.review.beyondScope } })) },
    citeRule: `引用本体里的事实时照抄 facts[].cite，写成 [标题](${CITATION_SCHEME}world:<id>@<版本>)；约定、交付物是天枢自己的数据，不挂本体出处。读不到本体时如实说没读到，不用别的资料补公司事实。`,
  } };
}
