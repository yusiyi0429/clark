import { describe, expect, it } from "vitest";
import { colleagueAccess, colleagueNames } from "../src/colleagueAccess.js";
import type { Query } from "../src/meetingStore.js";

/** 钉住 R4b 和补充条款 A1 的约定：同事之间能不能读、能不能问、接不接活只在 colleagueAccess 一处判。 */
describe("能不能读、能不能问、接不接活", () => {
  const q = (async () => ({ rows: [], rowCount: 0 })) as unknown as Query;
  const colleagues = colleagueNames([
    { personId: "p-a", displayName: "甲", roles: ["dri", "participant"] },
    { personId: "p-b", displayName: "乙", roles: ["ceo"] },
    { personId: "p-c", displayName: "丙", roles: ["participant"] },
  ]);

  it("覆盖的人：人员目录里是 DRI 或 CEO 的", () => {
    expect([...colleagues]).toEqual([["p-a", "甲"], ["p-b", "乙"]]);
  });

  it("第一步：覆盖的人之间读和问一律可以，请对方动手一律不可以", async () => {
    expect(await colleagueAccess(q, colleagues, "p-a", "p-b", "read")).toEqual({ allowed: true, reason: null });
    expect(await colleagueAccess(q, colleagues, "p-a", "p-b", "ask")).toEqual({ allowed: true, reason: null });
    expect(await colleagueAccess(q, colleagues, "p-a", "p-b", "request")).toEqual({ allowed: false, reason: "请对方那边动手这一步还没开" });
  });

  it("问的人或被问的人不在覆盖里、问自己：都不可以，回话和没有这个人一样，不说原因", async () => {
    for (const [asker, owner] of [["p-a", "p-c"], ["p-c", "p-a"], ["p-a", "p-x"], ["p-a", "p-a"]])
      for (const kind of ["read", "ask", "request"] as const)
        expect(await colleagueAccess(q, colleagues, asker, owner, kind)).toEqual({ allowed: false, reason: null });
  });
});
