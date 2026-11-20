import { describe, expect, it } from "vitest";
import { colleagueAccess } from "../src/colleagueAccess.js";
import type { Query } from "../src/meetingStore.js";
import type { PeopleDirectory } from "../src/peopleDirectory.js";

/** 钉住 R4b 和补充条款 A1 的约定：同事之间能不能读、能不能问、接不接活只在 colleagueAccess 一处判，覆盖的人（DRI、CEO）在函数里按人员目录算。 */
describe("能不能读、能不能问、接不接活", () => {
  const q = (async () => ({ rows: [], rowCount: 0 })) as unknown as Query;
  const person = (personId: string, displayName: string, roles: string[]) => ({ personId, displayName, roles, sourceRef: "fixture", updatedAt: "2026-11-20T00:00:00.000Z" });
  const directory: PeopleDirectory = { searchPeople: () => [person("p-a", "甲", ["dri", "participant"]), person("p-b", "乙", ["ceo"]), person("p-c", "丙", ["participant"])] };

  it("第一步：覆盖的人（DRI、CEO）之间读和问一律可以，请对方动手一律不可以", async () => {
    expect(await colleagueAccess(q, directory, "p-a", "p-b", "read")).toEqual({ allowed: true, reason: null });
    expect(await colleagueAccess(q, directory, "p-b", "p-a", "ask")).toEqual({ allowed: true, reason: null });
    expect(await colleagueAccess(q, directory, "p-a", "p-b", "request")).toEqual({ allowed: false, reason: "请对方那边动手这一步还没开" });
  });

  it("目录里的参与人、目录里没有的人、问自己：都不可以，回话和没有这个人一样，不说原因", async () => {
    for (const [asker, owner] of [["p-a", "p-c"], ["p-c", "p-a"], ["p-a", "p-x"], ["p-a", "p-a"]])
      for (const kind of ["read", "ask", "request"] as const)
        expect(await colleagueAccess(q, directory, asker, owner, kind)).toEqual({ allowed: false, reason: null });
  });
});
