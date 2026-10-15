import { existsSync, readFileSync, statSync } from "node:fs";
import { Value } from "@sinclair/typebox/value";
import { CompanyPeopleSeed, type TCompanyPeopleSeed, type TPersonResult } from "@warmap/contracts";

/** 稳定身份目录，独立于公司认知正文及 World 业务对象。 */
export type DirectoryPerson = TPersonResult;
export type PeopleDirectory = { searchPeople(query: string | undefined): DirectoryPerson[] };
export type PeopleDirectoryEnv = { companyPeopleSeed: string };

function firstErrors(schema: Parameters<typeof Value.Check>[0], value: unknown): string {
  return [...Value.Errors(schema, value)]
    .slice(0, 3)
    .map((e) => `${e.path || "/"} ${e.message}`)
    .join("; ");
}

export function loadPeople(seedPath: string): DirectoryPerson[] {
  if (!existsSync(seedPath)) {
    throw new Error(`人员 seed 不存在: ${seedPath}（不虚构人员，启动失败）`);
  }
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(seedPath, "utf8"));
  } catch (err) {
    throw new Error(`人员 seed 不是合法 JSON: ${seedPath}: ${(err as Error).message}`);
  }
  if (!Value.Check(CompanyPeopleSeed, raw)) {
    throw new Error(`人员 seed 不符合 company-people.v1: ${seedPath}: ${firstErrors(CompanyPeopleSeed, raw)}`);
  }
  const updatedAt = statSync(seedPath).mtime.toISOString();
  const people = (raw as TCompanyPeopleSeed).people.map((p): DirectoryPerson => ({
    personId: p.personId,
    displayName: p.displayName,
    roles: [...p.roles],
    sourceRef: `${seedPath}#${p.personId}`,
    updatedAt,
  }));
  const seen = new Set<string>();
  for (const person of people) {
    if (seen.has(person.personId)) {
      throw new Error(`人员 seed 存在重复 personId: ${person.personId}`);
    }
    seen.add(person.personId);
  }
  return people;
}


export function loadPeopleDirectory(env: PeopleDirectoryEnv): PeopleDirectory {
  const people = loadPeople(env.companyPeopleSeed);
  return {
    searchPeople(query) {
      const needle = query?.trim().toLowerCase();
      const matched = needle ? people.filter((person) => person.displayName.toLowerCase().includes(needle)) : people;
      return matched.map((person) => ({ ...person, roles: [...person.roles] }));
    },
  };
}
