import type { Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import { WorldError, worldErrorCode, worldRef, type WorldClient, type WorldObject } from "./worldClient.js";
import { worldDisplayText } from "./worldReader.js";

/**
 * 本人本月 Mission 的本体计划（给独立 Chat 的宿主只读接口 /internal/mission-plans，10/23 诊断方案二）：
 * 会上定的改期这类决定只写进本体 Mission 的计划块，天枢本地 Mission 不同步计划块，这里按人读一份。
 * - Mission 取本地 missions 表里本人的、本公司月的、不是占位的；经外部引用 mission:<code> 找本体 Mission，只读。
 * - 计划条目：Mission 计划块（mission_plan）里的里程碑在前，Task 全景块（execution_plan）的全部条目在后，块内按原顺序；
 *   每条文字最多 PLAN_TEXT_MAX 字，合计最多 PLAN_ITEMS_MAX 条；dates 是文字里认得出的全部日期。
 * - 本体没配、实例没开读、连不上或读失败：照样给本地 Mission，plan 为 null，planStatus 说原因，不报错。
 * - 逐个串行读（本体每次请求都会短暂锁 scope），每次请求限时 MISSION_PLAN_TIMEOUT_MS；连不上（超时、网络错），
 *   或整次读了超过 MISSION_PLAN_BUDGET_MS，剩下的 Mission 不再读、标 world_unreachable。不缓存。
 */
export const MISSION_PLAN_TIMEOUT_MS = 2_500;
export const MISSION_PLAN_BUDGET_MS = 5_000;
const PLAN_TEXT_MAX = 600;
const PLAN_ITEMS_MAX = 50;
export type MissionPlanWorld = Pick<WorldClient, "listObjects" | "getObject">;
/** 本体不读时的原因：没配地址或凭证；配了但实例没开读（和其他读本体的地方同一个开关）。 */
export type MissionPlanWorldOff = "world_not_configured" | "world_reads_off";
type MissionPlanStatus = "ok" | "not_linked" | "world_unreachable" | "world_error" | MissionPlanWorldOff;
type MissionPlanItem = { block: "mission_plan" | "execution_plan"; componentId: string; type: string; text: string; dates: string[] };
type MissionPlanRead = {
  missionId: string; code: string; title: string; planStatus: MissionPlanStatus;
  plan: { objectRef: string; title: string; items: MissionPlanItem[] } | null;
};

type Component = { id?: string; type?: string; text?: unknown };
type PlanBlock = { id: string; components?: Component[]; value?: { components?: Component[] } | null };

/** 2026-10-27、2026/10/27、2026年10月27日，或不写年的 10月27日、10/27；前后紧挨数字、字母、「/」「.」的不算。 */
const DATE = /(?<![\dA-Za-z/.])(?:(\d{4})[-/年](\d{1,2})[-/月](\d{1,2})|(\d{1,2})[/月](\d{1,2}))(?![\d/])/g;
/** 没写年：取离 period 最近的年份（月份差大于 6 就加减一年）。 */
function nearestYear(month: number, period: string): number {
  const year = Number(period.slice(0, 4));
  const current = Number(period.slice(5, 7));
  return month - current > 6 ? year - 1 : current - month > 6 ? year + 1 : year;
}
/** 文字里认得出的全部日期（YYYY-MM-DD），按出现顺序、去重；不是有效日期的跳过，接着往后找。 */
export function planItemDates(text: string, period: string): string[] {
  const dates: string[] = [];
  for (const [, fullYear, fullMonth, fullDay, shortMonth, shortDay] of text.matchAll(DATE)) {
    const month = Number(fullMonth ?? shortMonth);
    const year = fullYear ? Number(fullYear) : nearestYear(month, period);
    const value = `${year}-${String(month).padStart(2, "0")}-${(fullDay ?? shortDay).padStart(2, "0")}`;
    const parsed = new Date(`${value}T00:00:00Z`);
    if (!Number.isNaN(parsed.valueOf()) && parsed.toISOString().slice(0, 10) === value && !dates.includes(value)) dates.push(value);
  }
  return dates;
}
const clip = (text: string) => (text.length > PLAN_TEXT_MAX ? `${text.slice(0, PLAN_TEXT_MAX)}…` : text);

/**
 * 一个 Mission 的本体计划；外部引用找不到对象返回 null。引用对应多个对象或不是 Mission 时抛 INVALID_STATE（同 byExternalRef）。
 * 组件挂在块上（value.components 为空）也认。
 */
async function readWorldPlan(world: MissionPlanWorld, code: string, period: string): Promise<MissionPlanRead["plan"]> {
  const heads = await world.listObjects({ external_system: "tianshu", external_id: `mission:${code}` });
  if (!heads.length) return null;
  if (heads.length > 1 || heads[0].object_type !== "Mission") throw new WorldError(409, "INVALID_STATE", `mission:${code} 对应 ${heads.length} 个对象或不是 Mission`);
  const object: WorldObject = await world.getObject(heads[0].object_id);
  const business = object.business as WorldObject["business"] & { blocks?: PlanBlock[] };
  const componentsOf = (id: string) => {
    const block = business.blocks?.find((item) => item.id === id);
    return block?.value?.components?.length ? block.value.components : block?.components ?? [];
  };
  const items = (["mission_plan", "execution_plan"] as const).flatMap((blockId) => componentsOf(blockId).flatMap((item): MissionPlanItem[] => {
    const text = typeof item.text === "string" ? clip(worldDisplayText(item.text.trim())) : "";
    if (!item.id || !item.type || !text || (blockId === "mission_plan" && item.type !== "milestone")) return [];
    return [{ block: blockId, componentId: item.id, type: item.type, text, dates: planItemDates(text, period) }];
  })).slice(0, PLAN_ITEMS_MAX);
  return { objectRef: worldRef(business), title: worldDisplayText(business.title), items };
}

/** 本人在 period 的 Mission 和各自的本体计划（world 为字符串时不读本体，那就是原因）。 */
export async function readMissionPlans(q: Query, ownerId: string, period: string, world: MissionPlanWorld | MissionPlanWorldOff,
  budgetMs = MISSION_PLAN_BUDGET_MS): Promise<MissionPlanRead[]> {
  const rows = (await q(
    "SELECT id, code, title FROM missions WHERE owner_id = $1 AND period = $2 AND NOT placeholder ORDER BY code, id",
    [ownerId, period],
  )).rows as { id: string; code: string; title: string }[];
  const out: MissionPlanRead[] = [];
  const deadline = Date.now() + budgetMs;
  let unreachable = false;
  for (const row of rows) {
    const local = { missionId: row.id, code: row.code, title: row.title };
    if (typeof world !== "string" && !unreachable && Date.now() >= deadline) {
      unreachable = true;
      logEvent({ event: "mission_plan.read", objectRef: `mission:${row.code}`, status: "skipped", errorCode: "MISSION_PLAN_BUDGET_EXCEEDED" });
    }
    if (typeof world === "string" || unreachable) {
      out.push({ ...local, planStatus: typeof world === "string" ? world : "world_unreachable", plan: null });
      continue;
    }
    try {
      const plan = await readWorldPlan(world, row.code, period);
      out.push({ ...local, planStatus: plan ? "ok" : "not_linked", plan });
    } catch (error) {
      const code = worldErrorCode(error);
      unreachable = code === "NETWORK_ERROR";
      logEvent({ event: "mission_plan.read", objectRef: `mission:${row.code}`, status: "failed", errorCode: code });
      out.push({ ...local, planStatus: unreachable ? "world_unreachable" : "world_error", plan: null });
    }
  }
  return out;
}
