import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { TEST_MEMBER } from "./helpers.js";
import { boardFixture, THIRD, type BoardFixture } from "./boardFixture.js";

/** 等你里的「忽略」（方案 A）：写了原因才收起，事情本身不动；这件事之后变了又回到等你；只管本人自己的等你。 */

type Waiting = { id: string; kind: string; title: string; source: string | null };
const waiting = async (f: BoardFixture, cookie = f.member): Promise<Waiting[]> => {
  const res = await f.call("GET", "/api/me/work-home", undefined, cookie);
  expect(res.statusCode).toBe(200);
  return res.json().waiting as Waiting[];
};
const ids = async (f: BoardFixture, cookie = f.member) => (await waiting(f, cookie)).map((item) => item.id);
const ignore = (f: BoardFixture, id: string, reason: unknown, cookie = f.member) =>
  f.call("POST", `/api/me/waiting/${encodeURIComponent(id)}/ignore`, { reason }, cookie);
/** 一张带岗位、交给 Claude Code 的卡：没有在线的电脑时等你里出「还没有配对的电脑」。 */
const roleCard = async (f: BoardFixture, title: string, options: { cookie?: string; missionId?: string; planTaskId?: string } = {}) => {
  const cookie = options.cookie ?? f.member;
  const role = await f.call("POST", "/api/me/roles", { name: `开发 ${randomUUID().slice(0, 4)}`, family: "dev", kind: "worker" }, cookie);
  const card = await f.call("POST", "/api/me/tasks", { clientId: randomUUID(), title, missionId: options.missionId ?? "mine", planTaskId: options.planTaskId ?? "task-open",
    doneDefinition: "有方案" }, cookie);
  expect(card.statusCode).toBe(200);
  expect((await f.call("PATCH", `/api/me/cards/${card.json().id}`, { version: 1, roleId: role.json().id, executor: "claude_code" }, cookie)).statusCode).toBe(200);
  return card.json().id as string;
};
const login = async (f: BoardFixture) => {
  const res = await f.t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: f.t.publicOrigin }, payload: { loginId: THIRD.loginId, passcode: THIRD.passcode } });
  return (res.headers["set-cookie"] as string).split(";")[0];
};

describe("等你：忽略", { timeout: 30_000 }, () => {
  it("写了原因忽略：这件不在等你里（条数也少一件），原因记下谁、哪一件、原因、时间、当时的样子；事情本身不动，变了又回来", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const first = await roleCard(f, "等开工的卡");
      expect(await ids(f)).toContain("device:this_computer");
      const before = (await f.call("GET", "/api/me/work-home/waiting-count")).json().count as number;

      expect((await ignore(f, "device:this_computer", "  先不配电脑  ")).statusCode).toBe(204);
      expect(await ids(f)).not.toContain("device:this_computer");
      expect((await f.call("GET", "/api/me/work-home/waiting-count")).json().count).toBe(before - 1);
      const rows = await f.t.sql("SELECT person_id,item_id,reason,version,ignored_at FROM waiting_ignores");
      expect(rows).toEqual([{ person_id: TEST_MEMBER.personId, item_id: "device:this_computer", reason: "先不配电脑", version: expect.stringMatching(/^[0-9a-f]{64}$/),
        ignored_at: expect.any(Date) }]);
      // 事情本身不动：卡还在、还是待开始。
      expect((await f.t.sql("SELECT status FROM tasks WHERE id=$1", [first]))[0].status).toBe("not_started");

      // 又多一件在等本机：这一行变了（「2 件在等」），回到等你。
      await roleCard(f, "又一张卡");
      expect((await waiting(f)).find((item) => item.id === "device:this_computer")?.source).toBe("2 件在等");
    } finally { await f.close(); }
  });

  it("原因为空（去掉首尾空白后）、太长、没有这一件：拒收，等你照旧", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      await roleCard(f, "等开工的卡");
      for (const reason of ["", "   \n ", "字".repeat(501), undefined]) expect((await ignore(f, "device:this_computer", reason)).statusCode).toBe(400);
      expect((await ignore(f, "device:no-such", "不要了")).statusCode).toBe(404);
      expect(await ids(f)).toContain("device:this_computer");
      expect(await f.t.sql("SELECT 1 FROM waiting_ignores")).toEqual([]);
      expect((await ignore(f, "device:this_computer", "字".repeat(500))).statusCode).toBe(204);
    } finally { await f.close(); }
  });

  it("只收起本人自己的：别人等你里同一个 id 的那件照旧", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const third = await login(f);
      await roleCard(f, "我的卡");
      await roleCard(f, "别人的卡", { cookie: third, missionId: "other", planTaskId: "task-other" });
      expect(await ids(f, third)).toContain("device:this_computer");

      expect((await ignore(f, "device:this_computer", "先不配电脑")).statusCode).toBe(204);
      expect(await ids(f)).not.toContain("device:this_computer");
      expect(await ids(f, third)).toContain("device:this_computer");
    } finally { await f.close(); }
  });

  it("批准：本机会话后来又同步（时间变了）还是同一次请求，不回来；换了一次新的请求，回来", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const card = await roleCard(f, "要批准");
      const laptop = await f.local();
      const permission = { requestId: "p-1", toolName: "Bash", title: "运行 pnpm test", outsidePaths: [] };
      const session = await laptop.send({ kind: "card", cardId: card }, [["status", { status: "waiting_permission", title: "要批准", agent: "claude-code",
        modelLabel: "订阅 · Sonnet", permission }]]);
      const id = (await waiting(f)).find((item) => item.kind === "approval")!.id;

      expect((await ignore(f, id, "这一步我自己来")).statusCode).toBe(204);
      expect(await ids(f)).not.toContain(id);
      await f.t.sql("UPDATE local_runs SET updated_at=updated_at + interval '5 minutes' WHERE id=$1", [session]);
      expect(await ids(f)).not.toContain(id);

      await f.t.sql(`UPDATE local_runs SET ask=jsonb_set(ask,'{request,requestId}','"p-2"') WHERE id=$1`, [session]);
      expect(await ids(f)).toContain(id);
    } finally { await f.close(); }
  });
  it("会议行（等你里从会议来的那几行，id 是 partner-meeting:<会议行 id>）：带当时的样子才能忽略，首页数据回 ignoredMeetings；只是本人的", async () => {
    const f = await boardFixture({}, { boardCloudAgents: false });
    try {
      const home = async (cookie = f.member) => (await f.call("GET", "/api/me/work-home", undefined, cookie)).json().ignoredMeetings;
      expect(await home()).toEqual([]);
      const id = encodeURIComponent("partner-meeting:pm1");
      expect((await f.call("POST", `/api/me/waiting/${id}/ignore`, { reason: "这场不用管" })).statusCode).toBe(400);
      expect((await f.call("POST", `/api/me/waiting/${id}/ignore`, { reason: "  ", version: "attention|录音转写失败|2026-11-16T00:46:00.000Z" })).statusCode).toBe(400);
      expect((await f.call("POST", `/api/me/waiting/${id}/ignore`, { reason: "这场不用管", version: "attention|录音转写失败|2026-11-16T00:46:00.000Z" })).statusCode).toBe(204);
      expect(await home()).toEqual([{ id: "pm1", version: "attention|录音转写失败|2026-11-16T00:46:00.000Z" }]);
      expect(await home(await login(f))).toEqual([]);
    } finally { await f.close(); }
  });
});
