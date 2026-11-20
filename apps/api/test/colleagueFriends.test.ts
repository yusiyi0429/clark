import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { colleagueAccess, type ColleagueAccessKind } from "../src/colleagueAccess.js";
import type { Query } from "../src/meetingStore.js";
import { loadPeopleDirectory } from "../src/peopleDirectory.js";
import { boardFixture, THIRD } from "./boardFixture.js";
import { TEST_CEO, TEST_MEMBER } from "./helpers.js";

/** 甲 CEO、乙问的人、丙被问的人（DRI）、丁参与人（不被覆盖）。 */
const 乙 = TEST_MEMBER.personId;
const 丙 = THIRD.personId;
const 丁 = "person-fixture-004";
let seedPath: Promise<string> | undefined;
const peopleSeed = () => seedPath ??= (async () => {
  const path = join(await mkdtemp(join(tmpdir(), "buddy-friends-")), "people.json");
  await writeFile(path, JSON.stringify({ schemaVersion: "company-people.v1", people: [
    { personId: TEST_CEO.personId, displayName: "测试甲", roles: ["ceo"] },
    { personId: 乙, displayName: "测试乙", roles: ["dri", "participant"] },
    { personId: 丙, displayName: "测试丙", roles: ["dri"] },
    { personId: 丁, displayName: "测试丁", roles: ["participant"] },
  ] }));
  return path;
})();

async function setup() {
  const companyPeopleSeed = await peopleSeed();
  const f = await boardFixture({}, { companyPeopleSeed });
  const login = await f.call("POST", "/api/auth/login", { loginId: THIRD.loginId, passcode: THIRD.passcode });
  const third = String(login.headers["set-cookie"]).split(";")[0];
  const json = (method: "GET" | "POST" | "PUT" | "DELETE") => async (url: string, body?: unknown, cookie = f.member) => (await f.call(method, url, body, cookie)).json();
  const get = json("GET"), post = json("POST"), put = json("PUT"), del = json("DELETE");
  const q: Query = (sql, params) => f.t.pool.query(sql, params);
  const directory = loadPeopleDirectory({ companyPeopleSeed });
  const access = (asker: string, owner: string, kind: ColleagueAccessKind) => colleagueAccess(q, directory, asker, owner, kind);
  return { f, third, get, post, put, del, access };
}
const F = (id: string) => "/api/me/friends/" + id;

describe("好友、设置、授权、找人", { timeout: 60_000 }, () => {
  it("直接通过：各用各的默认；删了马上失效，问照旧", async () => {
    const { f, third, post, put, del, access } = await setup();
    try {
      await put("/api/me/friend-settings", { admission: "auto", defaults: { agentAsk: false } }, third);
      expect(await post(F(丙) + "/request")).toMatchObject({ relation: "friends", theirs: { agentAsk: false }, mine: { agentAsk: true } });
      expect(await access(乙, 丙, "agent_ask")).toEqual({ allowed: false, reason: "他没开放这一项" });
      expect((await access(丙, 乙, "agent_ask")).allowed).toBe(true);
      expect(await access(乙, 丁, "agent_ask")).toEqual({ allowed: false, reason: null });
      expect((await del(F(丙))).relation).toBe("none");
      expect((await access(丙, 乙, "agent_ask")).allowed).toBe(false);
      expect((await access(乙, 丙, "ask")).allowed).toBe(true);
    } finally { await f.close(); }
  });

  it("要我同意：加了先等，开放照勾的算，暂不回到没加", async () => {
    const { f, third, post, put } = await setup();
    try {
      await put("/api/me/friend-settings", { admission: "approve", defaults: { agentAsk: true } }, third);
      expect((await post(F(丙) + "/request")).relation).toBe("pending_out");
      expect(await post(F(乙) + "/accept", { agentAsk: false }, third)).toMatchObject({ relation: "friends", mine: { agentAsk: false }, theirs: { agentAsk: true } });
    } finally { await f.close(); }
  });

  it("找人：不足两个字不搜，带命中原因和关系", async () => {
    const { f, get } = await setup();
    try {
      const find = (s: string) => get("/api/me/colleagues?query=" + encodeURIComponent(s));
      expect(await find("丙")).toEqual({ people: [], more: 0 });
      expect((await find("测试丁")).people).toEqual([]);
      expect((await find("测试丙")).people).toEqual([{ personId: 丙, displayName: "测试丙", matched: ["名字"], relation: "none" }]);
    } finally { await f.close(); }
  });
});
