import type { Query } from "./meetingStore.js";
import type { PeopleDirectory } from "./peopleDirectory.js";

/**
 * 同事之间能不能读、能不能问、接不接活（R4b），只在这里判。覆盖的人（补充条款 A1）：人员目录里是 DRI 或 CEO 的；
 * 搜人、看目录、读全文、问、追问都只在覆盖的人之间，自己不算自己的同事。
 */

/** read：我的伙伴读他放出来的；ask：问他的伙伴；request：请他那边动手（派活，这一步不做）。 */
export type ColleagueAccessKind = "read" | "ask" | "request";
export type ColleagueAccess = { allowed: boolean; reason: string | null };

/** 覆盖的人：人员目录里 roles 含 dri 或 ceo 的。只在这个文件里算，调用方传人员目录。 */
const covered = (directory: PeopleDirectory, personId: string) =>
  directory.searchPeople(undefined).some((person) => person.personId === personId && person.roles.some((role) => role === "dri" || role === "ceo"));

/**
 * 问的人、被问的人有一个不在覆盖里，或者问的是自己：一律不可以，回话和没有这个人一样，不说原因。
 * 第一步：read、ask 可以；request 一律不可以。每个人对自己伙伴的接收设置（另有设计）以后读进这里；现在不建表，q 先不用。
 */
export async function colleagueAccess(_q: Query, directory: PeopleDirectory, asker: string, owner: string, kind: ColleagueAccessKind): Promise<ColleagueAccess> {
  if (asker === owner || !covered(directory, asker) || !covered(directory, owner)) return { allowed: false, reason: null };
  if (kind === "request") return { allowed: false, reason: "请对方那边动手这一步还没开" };
  return { allowed: true, reason: null };
}
