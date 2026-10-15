import type { PeopleDirectory } from "./peopleDirectory.js";

/**
 * owner 只存 personId，显示名不落库：写入前用这份映射校验，投影时现查 displayName。
 * Person 来自独立人员目录；公司认知变更不改变登录身份。
 */
export function personDisplayNames(peopleDirectory: PeopleDirectory): Map<string, string> {
  return new Map(peopleDirectory.searchPeople(undefined).map((person) => [person.personId, person.displayName]));
}

/** 空 ownerId 表示“待指派”，不需要命中目录；非空必须命中 company-people.v1。 */
export function isKnownOwner(names: Map<string, string>, ownerId: string | undefined): boolean {
  return ownerId === undefined || ownerId === "" || names.has(ownerId);
}
