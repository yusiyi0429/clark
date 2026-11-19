import type { THomePlanTask } from "@warmap/contracts";
import { logEvent } from "./observability.js";
import { WorldError, worldErrorCode, type WorldClient, type WorldHead, type WorldObject } from "./worldClient.js";
import { worldDisplayText } from "./worldReader.js";

/**
 * 本体 Task 的 definition 块里带的约定（12 月起斯一加的 proof / acceptor / exclusions，约定与对表设计 v0.2 第 2 节）：
 * proofs、acceptorIds 和标准一一对应（有验收标准时按 acceptance_criterion，没有时按完成定义那一条）；acceptorIds 已换成天枢 personId，对不上为 null。
 * 这几项一样都没有时 Task 上不带 agreement。
 */
export type WorldAgreement = { proofs: (string | null)[]; acceptorIds: (string | null)[]; exclusions: string[] };
/** 首页 Task 行，外加本体里的约定（只在 api 里用，首页响应按契约不带）。 */
export type PlanTask = THomePlanTask & { agreement?: WorldAgreement };

/** 一个本地 Mission；从本体载入的带本体身份（scope、对象 id、所在域），按它直接找 Task，不靠外部引用。 */
export type PlanTaskMission = { id: string; code: string; world?: { scopeId: string; objectId: string; domainId: string } | null };
/**
 * 按 id 读一件本体 Task（跨月找 Task 用，planTaskAccess.locatePlanTask 的第三步）：parents 是它父引用指向的本体对象 id（所属 Mission），
 * task 是 Task 行，missionId 由调用方按 parents 找本地 Mission 补上（天枢里新加的 Task 直接给 missionId）。本体里没有这件（或不是 Task）为 null。
 */
export type PlanTaskById = (taskId: string) => Promise<{ parents: string[]; missionId?: string; task: Omit<PlanTask, "missionId"> } | null>;
/** 首页 Task 行的来源：本体里挂在这些 Mission 下的 Task。byId：按 id 读一件（本体来源有；测试的假来源可以不给，不给就没有第三步）。 */
export type PlanTaskSource = ((missions: PlanTaskMission[]) => Promise<PlanTask[]>) & { byId?: PlanTaskById };

/** 还没接本体（或实例没开读）时的来源：一个 Task 都没有。 */
export const emptyPlanTaskSource: PlanTaskSource = async () => [];

/** 读 Task 最多等这么久：本体慢时首页、list_my_items 先不带 Task，照常出。 */
export const PLAN_TASKS_BUDGET_MS = 2_500;

/** 按时间预算读 Task：超时或出错都给空的、记一条日志，不让调用方等满一整轮本体请求。 */
export async function readPlanTasks(planTasks: PlanTaskSource, missions: PlanTaskMission[], budgetMs = PLAN_TASKS_BUDGET_MS): Promise<PlanTask[]> {
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

/** 按 id 读一件 Task 时也照 readPlanTasks 限时：超时、出错都当没有，记一条日志。没有 byId 的来源直接给 null。 */
export async function readPlanTaskById(planTasks: PlanTaskSource, taskId: string, budgetMs = PLAN_TASKS_BUDGET_MS): ReturnType<PlanTaskById> {
  if (!planTasks.byId) return null;
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<"timeout">((resolve) => { timer = setTimeout(() => resolve("timeout"), budgetMs); });
  try {
    const found = await Promise.race([planTasks.byId(taskId), timeout]);
    if (found !== "timeout") return found;
    logEvent({ event: "plan_tasks.read_one", status: "failed", objectRef: `world:${taskId}`, errorCode: "PLAN_TASKS_TIMEOUT", durationMs: budgetMs });
  } catch (cause) {
    logEvent({ event: "plan_tasks.read_one", status: "failed", objectRef: `world:${taskId}`, errorCode: worldErrorCode(cause) });
  } finally {
    clearTimeout(timer);
  }
  return null;
}

type PlanTaskWorld = Pick<WorldClient, "listObjects" | "getObject">;
/** 本体主体 id → 天枢 personId（实例配置的 people 反查）；对不上给 null。 */
type PersonOf = (principal: string) => string | null;
type Component = { type?: string; text?: unknown; proof?: unknown; acceptor?: unknown };
type TaskObject = WorldObject & { identity?: { responsible?: { principals?: { principal_id?: string }[] } } };
type TaskBusiness = WorldObject["business"] & {
  relations?: { field?: string; relation?: string; value?: unknown }[];
  blocks?: { id: string; components?: Component[]; exclusions?: unknown; value?: { components?: Component[]; exclusions?: unknown } | null }[];
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
const hasText = (item: Component, type: string) => item.type === type && typeof item.text === "string" && !!item.text.trim();
const texts = (components: Component[], type: string) =>
  components.flatMap((item) => hasText(item, type) ? [worldDisplayText((item.text as string).trim())] : []);
const optionalText = (value: unknown) => typeof value === "string" && value.trim() ? worldDisplayText(value.trim()) : null;
/** 认可人：主体 id 字符串，或带 principal_id 的引用对象。字段名以斯一 12 月实际加的为准，先认这两种。 */
const principalOf = (value: unknown) => typeof value === "string" && value.trim() ? value.trim()
  : typeof (value as { principal_id?: unknown } | null)?.principal_id === "string" ? (value as { principal_id: string }).principal_id : null;

/**
 * definition 块里的约定：每条标准组件上的 proof、acceptor（没有验收标准时看完成定义那个 outcome 组件），
 * 「这次不包括」认块上的 exclusions 字符串数组，或 exclusion 组件的文字。一样都没有返回 undefined。
 */
function worldAgreementOf(definition: NonNullable<TaskBusiness["blocks"]>[number] | undefined, components: Component[], personOf: PersonOf,
  objectId: string): WorldAgreement | undefined {
  const criteria = components.filter((item) => hasText(item, "acceptance_criterion"));
  const basis = criteria.length ? criteria : components.filter((item) => hasText(item, "outcome")).slice(0, 1);
  const proofs = basis.map((item) => optionalText(item.proof));
  const principals = basis.map((item) => principalOf(item.acceptor));
  const listed = definition?.value?.exclusions ?? definition?.exclusions;
  const exclusions = [...(Array.isArray(listed) ? listed.flatMap((item) => optionalText(item) ?? []) : []), ...texts(components, "exclusion")];
  if (!proofs.some(Boolean) && !principals.some(Boolean) && !exclusions.length) return undefined;
  const acceptorIds = principals.map((principal) => {
    const personId = principal ? personOf(principal) : null;
    if (principal && !personId) logEvent({ event: "plan_tasks.object", status: "skipped", objectRef: `world:${objectId}`, errorCode: "AGREEMENT_ACCEPTOR_UNMAPPED" });
    return personId;
  });
  return { proofs, acceptorIds, exclusions };
}

/**
 * 斯一 10/22 定的存法：Task 是独立的 Task 对象，parent_ref 指向所属 Mission。
 * 从本体载入的 Mission 直接用记下的对象 id 和域，用它所在 scope 的读身份（scopes 里没有这个 scope 就没有 Task）；
 * 其余本地 Mission 经外部引用 mission:<code> 在主实例里找本体 Mission（找不到就没有 Task）。
 * 再按 Mission 所在的域列 Task、逐个取对象，留下父引用指向它的。
 * 用列表头而不是 byExternalRef：0.3 取对象的 business 里没有 domain_id，只有列表头带。
 * 负责人取 identity.responsible 第一个主体（没有再看 attributes.responsible），经 personOf 换成天枢的人，对不上为 null。
 * 短名取 title；doneDefinition 取 definition 块里 outcome 组件的文字，criteria 取同块 acceptance_criterion 组件，按出现顺序；
 * 同块里有约定（proof / acceptor / exclusions）时带 agreement（worldAgreementOf）。只读。
 * 列表读失败整次作废（不再往下取对象）；单个对象取不到就跳过它、记日志。
 */
async function readWorldPlanTasks(world: PlanTaskWorld, missions: PlanTaskMission[], scopes: Map<string, PlanTaskWorld>, personOf: PersonOf): Promise<PlanTask[]> {
  const loaded = missions.flatMap((mission) => mission.world ? [mission.world.scopeId] : []);
  const reads = [...new Set(loaded)].flatMap((scopeId) => {
    const client = scopes.get(scopeId);
    return client ? [readTasksIn(client, personOf, missions.flatMap((mission) => mission.world?.scopeId === scopeId
      ? [{ missionId: mission.id, objectId: mission.world.objectId, domainId: mission.world.domainId }] : []))] : [];
  });
  const linked = missions.filter((mission) => !mission.world);
  if (linked.length) reads.push(Promise.all(linked.map(async (mission) =>
    ({ mission, head: (await world.listObjects({ external_system: "tianshu", external_id: `mission:${mission.code}` }))[0] ?? null })))
    .then((heads) => readTasksIn(world, personOf, heads.flatMap(({ mission, head }) => head?.domain_id ? [{ missionId: mission.id, objectId: head.object_id, domainId: head.domain_id }] : []))));
  return (await Promise.all(reads)).flat();
}

async function readTasksIn(world: PlanTaskWorld, personOf: PersonOf, missions: { missionId: string; objectId: string; domainId: string }[]): Promise<PlanTask[]> {
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
    const missionId = parentsOf(object).map((id) => localMission.get(id)).find(Boolean);
    return missionId ? [{ ...taskRow(object, personOf), missionId }] : [];
  });
}

/** Task 对象的父引用（所属 Mission 的对象 id）；一个都没有记一条日志。 */
function parentsOf(object: WorldObject): string[] {
  const business = object.business as TaskBusiness;
  const parents = parentIds(business);
  if (!parents.length) logEvent({ event: "plan_tasks.object", status: "skipped", objectRef: `world:${business.object_id}`, errorCode: "TASK_PARENT_MISSING" });
  return parents;
}

/** 一个 Task 对象换成 Task 行（不含 missionId）。 */
function taskRow(object: WorldObject, personOf: PersonOf): Omit<PlanTask, "missionId"> {
  const business = object.business as TaskBusiness;
  const definition = business.blocks?.find((block) => block.id === "definition");
  const components = definition?.value?.components?.length ? definition.value.components : definition?.components ?? [];
  // 负责人和 Mission 载入同一个取法；本体没登记时不带这一项（首页按 null 显示）。
  const principal = (object as TaskObject).identity?.responsible?.principals?.[0]?.principal_id ?? business.attributes?.responsible;
  const agreement = worldAgreementOf(definition, components, personOf, business.object_id);
  return { taskId: business.object_id, name: worldDisplayText(business.title),
    doneDefinition: texts(components, "outcome")[0] ?? null, criteria: texts(components, "acceptance_criterion"),
    ...(principal ? { responsibleId: personOf(principal) } : {}), ...(agreement ? { agreement } : {}) };
}

/**
 * 按 id 取一件 Task：先主实例，再各 scope 的读身份（Task 在哪个 scope 事先不知道），本体回「没有」或「无权」就换下一个，其余错误照抛。
 * 取到的不是 Task 当没有。
 */
async function readWorldPlanTask(clients: PlanTaskWorld[], personOf: PersonOf, taskId: string): ReturnType<PlanTaskById> {
  for (const client of clients) {
    let object: WorldObject;
    try {
      object = await client.getObject(taskId);
    } catch (error) {
      if (error instanceof WorldError && (error.status === 404 || error.status === 403)) continue;
      throw error;
    }
    return object.business.object_type === "Task" ? { parents: parentsOf(object), task: taskRow(object, personOf) } : null;
  }
  return null;
}

/**
 * 本体来源，带一份按 Mission 组合记的结果：第一次要等（调用方用 readPlanTasks 限时）；之后直接给记下的，
 * 过了 ttlMs 就在后台重读一次（同一组合同时只读一份），读失败沿用旧的。
 * byId 按 id 读一件，按 Task id 同样记一份、同样过期重读（调用方用 readPlanTaskById 限时）。
 */
export function createWorldPlanTaskSource(world: PlanTaskWorld, options: { ttlMs?: number; clock?: () => number; scopes?: Map<string, PlanTaskWorld>; personOf?: PersonOf } = {}): PlanTaskSource {
  const ttl = options.ttlMs ?? PLAN_TASKS_TTL_MS;
  const clock = options.clock ?? Date.now;
  const personOf = options.personOf ?? (() => null);
  /** 按 key 记读到的结果：第一次等着读；过期了先给旧的、后台重读（同一 key 同时只读一份），读失败沿用旧的。 */
  const remembered = <T>(read: (key: string) => Promise<T>, event: string) => {
    const cache = new Map<string, { value: T | undefined; at: number; pending: Promise<T> | null }>();
    return async (key: string): Promise<T> => {
      let entry = cache.get(key);
      if (!entry) cache.set(key, entry = { value: undefined, at: 0, pending: null });
      const current = entry;
      const refresh = () => current.pending ??= read(key)
        .then((value) => { current.value = value; current.at = clock(); return value; })
        .finally(() => { current.pending = null; });
      if (current.value === undefined) return refresh();
      if (clock() - current.at >= ttl) refresh().catch((error) =>
        logEvent({ event, status: "failed", errorCode: worldErrorCode(error), reason: "background_refresh" }));
      return current.value;
    };
  };
  const missionSets = new Map<string, PlanTaskMission[]>();
  const tasksOf = remembered((key) => readWorldPlanTasks(world, missionSets.get(key)!, options.scopes ?? new Map(), personOf), "plan_tasks.read");
  const clients = [...new Set([world, ...(options.scopes?.values() ?? [])])];
  const byId = remembered((taskId) => readWorldPlanTask(clients, personOf, taskId), "plan_tasks.read_one");
  return Object.assign(async (missions: PlanTaskMission[]) => {
    const key = missions.map(({ id, code, world: source }) => [id, code, source?.scopeId ?? "", source?.objectId ?? ""].join("\u0000")).sort().join("\u0001");
    missionSets.set(key, missions);
    return tasksOf(key);
  }, { byId });
}
