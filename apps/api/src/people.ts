import type { PeopleDirectory } from "./peopleDirectory.js";

/**
 * owner 只存 personId，显示名不落库：写入前用这份映射校验，投影时现查 displayName。
 * Person 来自只读人员目录（company-people.v1），WarMap 不保存第二份事实。
 */
export function personDisplayNames(peopleDirectory: PeopleDirectory): Map<string, string> {
  return new Map(peopleDirectory.searchPeople(undefined).map((person) => [person.personId, person.displayName]));
}

/** 空 ownerId 表示“待指派”，不需要命中目录；非空必须命中 company-people.v1。 */
export function isKnownOwner(names: Map<string, string>, ownerId: string | undefined): boolean {
  return ownerId === undefined || ownerId === "" || names.has(ownerId);
}

/**
 * 人员目录里有些条目不是人：资料包为了给会议纪要等材料标作者，会放一个「会议纪要」这样的记录账号。
 * 它们照样能显示名字，但不进拉人进群、参与人、负责人这些「选人」名单，Agent 也不把事派给它们（巡检 P2-23）。
 */
const RECORD_ACCOUNT_NAMES = new Set(["会议纪要", "会议记录", "纪要", "记录"]);
export function isRealPerson(person: { personId: string; displayName: string }): boolean {
  return !RECORD_ACCOUNT_NAMES.has(person.displayName.trim()) && !/^(?:minutes|record)(?:-|$)/i.test(person.personId);
}
