import type { Query } from "./meetingStore.js";
import type { PeopleDirectory } from "./peopleDirectory.js";

/**
 * 同事之间能不能读、能不能问、接不接活（R4b），只在这里判。覆盖的人（补充条款 A1）：人员目录里是 DRI 或 CEO 的；
 * 搜人、看目录、读全文、问、追问都只在覆盖的人之间，自己不算自己的同事。
 */

/** read：我的伙伴读他放出来的；ask：问他的伙伴；agent_ask：我的伙伴替我去问他的伙伴（要好友且他开放了）；request：请他那边动手（派活，这一步不做）。 */
export type ColleagueAccessKind = "read" | "ask" | "agent_ask" | "request";
export type ColleagueAccess = { allowed: boolean; reason: string | null };

/** 覆盖的人：人员目录里 roles 含 dri 或 ceo 的。调用方传人员目录。 */
export const isCovered = (directory: PeopleDirectory, personId: string): boolean =>
  directory.searchPeople(undefined).some((person) => person.personId === personId && person.roles.some((role) => role === "dri" || role === "ceo"));

/**
 * 问的人、被问的人有一个不在覆盖里，或者问的是自己：一律不可以，回话和没有这个人一样，不说原因。
 * read、ask 可以；agent_ask 要是好友、且被问的人给问的人开了这一项；request 一律不可以。
 */
export async function colleagueAccess(q: Query, directory: PeopleDirectory, asker: string, owner: string, kind: ColleagueAccessKind): Promise<ColleagueAccess> {
  if (asker === owner || !isCovered(directory, asker) || !isCovered(directory, owner)) return { allowed: false, reason: null };
  if (kind === "request") return { allowed: false, reason: "请对方那边动手这一步还没开" };
  if (kind === "agent_ask") {
    const granted = (await q(`SELECT g.agent_ask FROM colleague_friend_grants g
      JOIN colleague_friendships f ON f.low_id=least($1,$2) AND f.high_id=greatest($1,$2) AND f.status='friends'
      WHERE g.grantor_id=$1 AND g.grantee_id=$2`, [owner, asker])).rows[0]?.agent_ask === true;
    if (!granted) return { allowed: false, reason: "他没开放这一项" };
  }
  return { allowed: true, reason: null };
}
