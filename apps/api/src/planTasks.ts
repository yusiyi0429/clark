import type { THomePlanTask } from "@warmap/contracts";
import type { WorldClient, WorldObject } from "./worldClient.js";

/** 首页 Task 行的来源：本体里挂在这些 Mission 下的 Task。 */
export type PlanTaskSource = (missions: { id: string; code: string }[]) => Promise<THomePlanTask[]>;

/** 还没接本体时的来源：一个 Task 都没有。 */
export const emptyPlanTaskSource: PlanTaskSource = async () => [];

type PlanTaskWorld = Pick<WorldClient, "listObjects" | "getObject">;
type Component = { type?: string; text?: unknown };
type TaskBusiness = WorldObject["business"] & {
  relations?: { field?: string; relation?: string; value?: unknown }[];
  blocks?: { id: string; components?: Component[]; value?: { components?: Component[] } | null }[];
};
/** 同时取对象的上限。 */
const READ_CONCURRENCY = 4;

/** 父引用：读回是带 object_id 的引用对象（也接受写入时的「id@版本」字符串）。字段名以实际返回为准，先认这几种。 */
function parentIds(business: TaskBusiness): string[] {
  return (business.relations ?? [])
    .filter((item) => item.field === "parent_ref" || item.relation === "parent" || item.relation === "belongs_to")
    .flatMap((item) => Array.isArray(item.value) ? item.value : [item.value])
    .flatMap((value) => typeof value === "string" ? [value.split("@")[0]]
      : value && typeof value === "object" && typeof (value as { object_id?: unknown }).object_id === "string" ? [(value as { object_id: string }).object_id] : []);
}
const texts = (components: Component[], type: string) =>
  components.flatMap((item) => item.type === type && typeof item.text === "string" && item.text.trim() ? [item.text.trim()] : []);

/**
 * 斯一 10/22 定的存法：Task 是独立的 Task 对象，parent_ref 指向所属 Mission。
 * 本地 Mission 经外部引用 mission:<code> 找到本体 Mission（找不到就没有 Task），按 Mission 所在的域列 Task、逐个取对象，留下父引用指向它的。
 * 用列表头而不是 byExternalRef：0.3 取对象的 business 里没有 domain_id，只有列表头带。
 * 短名取 title；doneDefinition 取 definition 块里 outcome 组件的文字，criteria 取同块 acceptance_criterion 组件，按出现顺序。只读，不缓存。
 */
export function createWorldPlanTaskSource(world: PlanTaskWorld): PlanTaskSource {
  return async (missions) => {
    const heads = await Promise.all(missions.map(async (mission) => {
      const found = await world.listObjects({ external_system: "tianshu", external_id: `mission:${mission.code}` });
      // 外部引用在 scope 内唯一；对不上唯一一个就当找不到。
      return { mission, head: found.length === 1 ? found[0] : null };
    }));
    const localMission = new Map(heads.flatMap(({ mission, head }) => head ? [[head.object_id, mission.id] as const] : []));
    if (!localMission.size) return [];
    const domains = [...new Set(heads.flatMap(({ head }) => head ? [head.domain_id] : []))];
    const candidates = (await Promise.all(domains.map((domain) => world.listObjects({ type: "Task", domain_id: domain })))).flat();
    const objects: WorldObject[] = new Array(candidates.length);
    let next = 0;
    const worker = async () => {
      while (next < candidates.length) {
        const index = next++;
        objects[index] = await world.getObject(candidates[index].object_id);
      }
    };
    await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, candidates.length) }, worker));
    return objects.flatMap((object) => {
      const business = object.business as TaskBusiness;
      const missionId = parentIds(business).map((id) => localMission.get(id)).find(Boolean);
      if (!missionId) return [];
      const definition = business.blocks?.find((block) => block.id === "definition");
      const components = definition?.value?.components ?? definition?.components ?? [];
      return [{ taskId: business.object_id, missionId, name: business.title,
        doneDefinition: texts(components, "outcome")[0] ?? null, criteria: texts(components, "acceptance_criterion") }];
    });
  };
}
