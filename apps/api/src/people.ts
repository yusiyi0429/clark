import type { CompanyMemoryRepository } from "./companyMemory.js";

/**
 * owner 只存 personId，显示名不落库：写入前用这份映射校验，投影时现查 displayName。
 * Person 来自只读企业知识人员目录，WarMap 不保存第二份事实。
 */
export function personDisplayNames(companyMemory: CompanyMemoryRepository): Map<string, string> {
  return new Map(companyMemory.searchPeople(undefined).map((person) => [person.personId, person.displayName]));
}

/** 空 ownerId 表示“待指派”，不需要命中目录；非空必须命中 company-people.v1。 */
export function isKnownOwner(names: Map<string, string>, ownerId: string | undefined): boolean {
  return ownerId === undefined || ownerId === "" || names.has(ownerId);
}
