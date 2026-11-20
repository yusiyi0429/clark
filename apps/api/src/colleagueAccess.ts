import type { Query } from "./meetingStore.js";
import type { DirectoryPerson } from "./peopleDirectory.js";

/**
 * 同事之间能不能读、能不能问、接不接活（R4b），只在这里判。覆盖的人（补充条款 A1）：人员目录里是 DRI 或 CEO 的；
 * 搜人、看目录、读全文、问、追问都只在覆盖的人之间，自己不算自己的同事。
 */

/** read：我的伙伴读他放出来的；ask：问他的伙伴；request：请他那边动手（派活，这一步不做）。 */
export type ColleagueAccessKind = "read" | "ask" | "request";
export type ColleagueAccess = { allowed: boolean; reason: string | null };

/** 覆盖的人：personId → 名字（人员目录的顺序）。 */
export function colleagueNames(people: Pick<DirectoryPerson, "personId" | "displayName" | "roles">[]): Map<string, string> {
  return new Map(people.filter((person) => person.roles.some((role) => role === "dri" || role === "ceo")).map((person) => [person.personId, person.displayName]));
}

/**
 * colleagues 是 colleagueNames 给的覆盖的人。问的人、被问的人有一个不在里面，或者问的是自己：一律不可以，回话和没有这个人一样，不说原因。
 * 第一步：read、ask 可以；request 一律不可以。每个人对自己伙伴的接收设置（另有设计）以后读进这里；现在不建表，q 先不用。
 */
export async function colleagueAccess(_q: Query, colleagues: ReadonlyMap<string, string>, asker: string, owner: string, kind: ColleagueAccessKind):
  Promise<ColleagueAccess> {
  if (asker === owner || !colleagues.has(asker) || !colleagues.has(owner)) return { allowed: false, reason: null };
  if (kind === "request") return { allowed: false, reason: "请对方那边动手这一步还没开" };
  return { allowed: true, reason: null };
}
