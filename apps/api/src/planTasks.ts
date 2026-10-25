import type { THomePlanTask } from "@warmap/contracts";
import { logEvent } from "./observability.js";
import { worldErrorCode, type WorldClient, type WorldHead, type WorldObject } from "./worldClient.js";
import { worldDisplayText } from "./worldReader.js";

/** 一个本地 Mission；从本体载入的带本体身份（scope、对象 id、所在域），按它直接找 Task，不靠外部引用。 */
export type PlanTaskMission = { id: string; code: string; world?: { scopeId: string; objectId: string; domainId: string } | null };
/** 首页 Task 行的来源：本体里挂在这些 Mission 下的 Task。 */
export type PlanTaskSource = (missions: PlanTaskMission[]) => Promise<THomePlanTask[]>;

/** 还没接本体（或实例没开读）时的来源：一个 Task 都没有。 */
export const emptyPlanTaskSource: PlanTaskSource = async () => [];

/** 读 Task 最多等这么久：本体慢时首页、list_my_items 先不带 Task，照常出。 */
export const PLAN_TASKS_BUDGET_MS = 2_500;

/** 按时间预算读 Task：超时或出错都给空的、记一条日志，不让调用方等满一整轮本体请求。 */
export async function readPlanTasks(planTasks: PlanTaskSource, missions: PlanTaskMission[], budgetMs = PLAN_TASKS_BUDGET_MS): Promise<THomePlanTask[]> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), budgetMs); });
  try {
    const tasks = await Promise.race([planTasks(missions), timeout]);
    if (tasks !== "timeout") return tasks;
    logEvent({ event: "plan_tasks.read", status: "failed", errorCode: "PLAN_TASKS_TIMEOUT", durationMs: budgetMs });
  } catch (cause) {
    logEvent({ event: "plan_tasks.read", status: "failed", errorCode: "PLAN_TASKS_FAILED", reason: String((cause as Error)?.message ?? cause).slice(0, 300) });
  } finally {
    clearTimeout(timer);
  }
  return [];
}

type PlanTaskWorld = Pick<WorldClient, "listObjects" | "getObject">;
type Component = { type?: string; text?: unknown };
type TaskBusiness = WorldObject["business"] & {
  relations?: { field?: string; relation?: string; value?: unknown }[];
  blocks?: { id: string; components?: Component[]; value?: { components?: Component[] } | null }[];
};
/** 同时取对象的上限。 */
const READ_CONCURRENCY = 4;
/** 读过的结果保留这么久；过期后先给旧的，后台再读。 */
export const PLAN_TASKS_TTL_MS = 60_000;

/** 父引用：读回是带 object_id 的引用对象。字段名以实际返回为准，先认这几种。 */
function parentIds(business: TaskBusiness): string[] {
  return (business.relations ?? [])
    .filter((item) => item.field === "parent_ref" || item.relation === "parent" || item.relation === "belongs_to")
    .flatMap((item) => Array.isArray(item.value) ? item.value : [item.value])
    .flatMap((value) => typeof (value as { object_id?: unknown } | null)?.object_id === "string" ? [(value as { object_id: string }).object_id] : []);
}
const texts = (components: Component[], type: string) =>
  components.flatMap((item) => item.type === type && typeof item.text === "string" && item.text.trim() ? [worldDisplayText(item.text.trim())] : []);

/**
 * 斯一 10/22 定的存法：Task 是独立的 Task 对象，parent_ref 指向所属 Mission。
 * 从本体载入的 Mission 直接用记下的对象 id 和域，用它所在 scope 的读身份（scopes 里没有这个 scope 就没有 Task）；
 * 其余本地 Mission 经外部引用 mission:<code> 在主实例里找本体 Mission（找不到就没有 Task）。
 * 再按 Mission 所在的域列 Task、逐个取对象，留下父引用指向它的。
 * 用列表头而不是 byExternalRef：0.3 取对象的 business 里没有 domain_id，只有列表头带。
 * 短名取 title；doneDefinition 取 definition 块里 outcome 组件的文字，criteria 取同块 acceptance_criterion 组件，按出现顺序。只读。
 * 列表读失败整次作废（不再往下取对象）；单个对象取不到就跳过它、记日志。
 */
async function readWorldPlanTasks(world: PlanTaskWorld, missions: PlanTaskMission[], scopes: Map<string, PlanTaskWorld>): Promise<THomePlanTask[]> {
  const loaded = missions.flatMap((mission) => mission.world ? [mission.world.scopeId] : []);
  const reads = [...new Set(loaded)].flatMap((scopeId) => {
    const client = scopes.get(scopeId);
    return client ? [readTasksIn(client, missions.flatMap((mission) => mission.world?.scopeId === scopeId
      ? [{ missionId: mission.id, objectId: mission.world.objectId, domainId: mission.world.domainId }] : []))] : [];
  });
  const linked = missions.filter((mission) => !mission.world);
  if (linked.length) reads.push(Promise.all(linked.map(async (mission) =>
    ({ mission, head: (await world.listObjects({ external_system: "tianshu", external_id: `mission:${mission.code}` }))[0] ?? null })))
    .then((heads) => readTasksIn(world, heads.flatMap(({ mission, head }) => head?.domain_id ? [{ missionId: mission.id, objectId: head.object_id, domainId: head.domain_id }] : []))));
  return (await Promise.all(reads)).flat();
}

async function readTasksIn(world: PlanTaskWorld, missions: { missionId: string; objectId: string; domainId: string }[]): Promise<THomePlanTask[]> {
  const localMission = new Map(missions.map(({ objectId, missionId }) => [objectId, missionId] as const));
  if (!localMission.size) return [];
  const candidates: WorldHead[] = [];
  for (const domain of new Set(missions.map(({ domainId }) => domainId))) candidates.push(...await world.listObjects({ type: "Task", domain_id: domain }));
  const objects: (WorldObject | null)[] = new Array(candidates.length).fill(null);
  let next = 0;
  const worker = async () => {
    while (next < candidates.length) {
      const index = next++;
      try {
        objects[index] = await world.getObject(candidates[index].object_id);
      } catch (error) {
        logEvent({ event: "plan_tasks.object", status: "failed", objectRef: `world:${candidates[index].object_id}`, errorCode: worldErrorCode(error) });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, candidates.length) }, worker));
  return objects.flatMap((object) => {
    if (!object) return [];
    const business = object.business as TaskBusiness;
    const parents = parentIds(business);
    if (!parents.length) logEvent({ event: "plan_tasks.object", status: "skipped", objectRef: `world:${business.object_id}`, errorCode: "TASK_PARENT_MISSING" });
    const missionId = parents.map((id) => localMission.get(id)).find(Boolean);
    if (!missionId) return [];
    const definition = business.blocks?.find((block) => block.id === "definition");
    const components = definition?.value?.components?.length ? definition.value.components : definition?.components ?? [];
    return [{ taskId: business.object_id, missionId, name: worldDisplayText(business.title),
      doneDefinition: texts(components, "outcome")[0] ?? null, criteria: texts(components, "acceptance_criterion") }];
  });
}

/**
 * 本体来源，带一份按 Mission 组合记的结果：第一次要等（调用方用 readPlanTasks 限时）；之后直接给记下的，
 * 过了 ttlMs 就在后台重读一次（同一组合同时只读一份），读失败沿用旧的。
 */
export function createWorldPlanTaskSource(world: PlanTaskWorld, options: { ttlMs?: number; clock?: () => number; scopes?: Map<string, PlanTaskWorld> } = {}): PlanTaskSource {
  const ttl = options.ttlMs ?? PLAN_TASKS_TTL_MS;
  const clock = options.clock ?? Date.now;
  const cache = new Map<string, { value: THomePlanTask[] | null; at: number; pending: Promise<THomePlanTask[]> | null }>();
  return async (missions) => {
    const key = missions.map(({ id, code, world: source }) => [id, code, source?.scopeId ?? "", source?.objectId ?? ""].join("\u0000")).sort().join("\u0001");
    let entry = cache.get(key);
    if (!entry) cache.set(key, entry = { value: null, at: 0, pending: null });
    const current = entry;
    const refresh = () => current.pending ??= readWorldPlanTasks(world, missions, options.scopes ?? new Map())
      .then((value) => { current.value = value; current.at = clock(); return value; })
      .finally(() => { current.pending = null; });
    if (current.value === null) return refresh();
    if (clock() - current.at >= ttl) refresh().catch((error) =>
      logEvent({ event: "plan_tasks.read", status: "failed", errorCode: worldErrorCode(error), reason: "background_refresh" }));
    return current.value;
  };
}
