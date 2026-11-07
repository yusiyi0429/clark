import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { BOARD_NOW, boardFixture, THIRD } from "./boardFixture.js";
import { TEST_MEMBER } from "./helpers.js";

/**
 * 新首页第 4.4 节：自动开工。接受草稿带 start、伙伴开探索子会话只登记「要开工」；配对电脑上的网页认领、放回；
 * 本机报上那张卡或专题的第一条执行时了结。另有本机同步条目 background（子 agent、后台命令）。
 */

const status = (state: string, title: string) => ["status", { status: state, title, agent: "claude-code", modelLabel: "订阅 · Sonnet" }] as [string, unknown];
const plan = (titles: string[]) => ({ revision: 1, summary: "先打分再录屏", steps: [], risks: [], modelLabel: "claude-opus-5.5", roleId: null, roleVersion: null,
  cards: titles.map((title) => ({ title, brief: "照交代做", doneDefinition: "有结果", criterionIndex: 1, role: null, modelTier: "normal", why: null })) });

async function fixture() {
  const f = await boardFixture({}, { boardCloudAgents: false, internalChatToken: "chat-token" });
  const machine = await f.local();
  /** 本机在一个会话里报几条，序号自己给（晚到的旧条目用更小的序号）。 */
  const sync = async (subject: Record<string, string>, items: [number, string, unknown][], session: string = randomUUID()) => {
    const res = await f.t.app.inject({ method: "POST", url: "/api/local-runner/sync", headers: { authorization: `Bearer ${machine.token}` }, payload: {
      deviceId: machine.device, runnerVersion: "0.1.0", slots: { max: 3, running: 1, queued: 0 },
      items: items.map(([seq, type, data]) => ({ key: `${machine.device}:${session}:${seq}`, sessionId: session, subject,
        occurredAt: new Date(Date.UTC(2026, 10, 6, 1, 0, seq)).toISOString(), type, data })) } });
    expect(res.statusCode).toBe(200);
    expect(res.json().rejected).toEqual([]);
    return session;
  };
  const claim = (deviceId: string) => f.call("POST", "/api/me/session-starts/claim", { deviceId });
  const claimed = async (deviceId: string) => {
    const res = await claim(deviceId);
    expect(res.statusCode).toBe(200);
    return res.json().starts as { id: string; kind: string; cardId: string | null; topicId: string | null; taskId: string | null }[];
  };
  const openTopic = (payload: Record<string, unknown>, owner: string = TEST_MEMBER.personId) => f.t.app.inject({ method: "POST", url: "/internal/me/topics",
    headers: { authorization: "Bearer chat-token", "x-owner-id": owner }, payload });
  return { ...f, machine, sync, claim, claimed, openTopic };
}

describe("自动开工（第 4.4 节）", { timeout: 30_000 }, () => {
  it("预算（设计 11.3）：缺省是自动、偏好里能改；Task 没单独设时用缺省；开工框带的预算存成 Task 的；设预算至少一项上限，别的模式清空上限；别人的 Task 不给", async () => {
    const f = await fixture();
    try {
      const AUTO = { mode: "auto", hours: null, weeklyPercent: null, money: null };
      expect((await f.call("GET", "/api/me/budget-default")).json()).toEqual(AUTO);
      expect((await f.call("PUT", "/api/me/budget-default", { ...AUTO, mode: "set" })).statusCode).toBe(400);
      expect((await f.call("PUT", "/api/me/budget-default", { mode: "unlimited", hours: 3, weeklyPercent: null, money: null })).json())
        .toEqual({ ...AUTO, mode: "unlimited" });
      expect((await f.call("GET", "/api/me/tasks/task-open/budget")).json()).toEqual({ taskId: "task-open", budget: { ...AUTO, mode: "unlimited" }, inherited: true });

      await f.sync({ kind: "plan", taskId: "task-open" }, [[1, "card_plan", plan(["跑题库"])]]);
      const draft = ((await f.call("GET", "/api/plan-tasks/task-open/cards")).json().drafts as { id: string }[])[0].id;
      const budget = { mode: "set", hours: 2.5, weeklyPercent: 10, money: { amount: 30, currency: "CNY" } };
      expect((await f.call("POST", "/api/plan-tasks/task-open/card-drafts/accept", { drafts: [{ id: draft }], start: true, budget })).statusCode).toBe(200);
      expect((await f.call("GET", "/api/me/tasks/task-open/budget")).json()).toEqual({ taskId: "task-open", budget, inherited: false });

      const changed = await f.call("PUT", "/api/me/tasks/task-open/budget", { ...AUTO, hours: null, weeklyPercent: 20, mode: "set" });
      expect(changed.json()).toEqual({ taskId: "task-open", budget: { ...AUTO, mode: "set", weeklyPercent: 20 }, inherited: false });
      expect((await f.call("PUT", "/api/me/tasks/task-open/budget", { ...AUTO, mode: "set" })).statusCode).toBe(400);
      expect((await f.call("GET", "/api/me/tasks/task-theirs/budget")).statusCode).toBeGreaterThanOrEqual(403);
    } finally { await f.close(); }
  });

  it("接受草稿带 start：交给 Claude Code 的卡各登记一条要开工，本人做的和不带 start 的不登记；网页认领一条只给一处，放回后能再认领，认领 5 分钟没了结的别处能认领；本机报上第一条执行就了结", async () => {
    const f = await fixture();
    try {
      await f.sync({ kind: "plan", taskId: "task-open" }, [[1, "card_plan", plan(["跑题库", "自己录屏", "写复盘"])]]);
      const drafts = (await f.call("GET", "/api/plan-tasks/task-open/cards")).json().drafts as { id: string; title: string }[];
      const draft = (title: string) => drafts.find((item) => item.title === title)!.id;
      const started = await f.call("POST", "/api/plan-tasks/task-open/card-drafts/accept",
        { drafts: [{ id: draft("跑题库") }, { id: draft("自己录屏"), executor: "self" }], start: true });
      expect(started.statusCode).toBe(200);
      const cards = started.json().cards as { id: string; title: string }[];
      const agentCard = cards.find((card) => card.title === "跑题库")!.id;
      const later = await f.call("POST", "/api/plan-tasks/task-open/card-drafts/accept", { drafts: [{ id: draft("写复盘") }] });
      expect(later.statusCode).toBe(200);

      // 第一次认领拿到那一张；马上再认领，同一台、别的电脑都拿不到。
      const first = await f.claimed(f.machine.device);
      expect(first).toEqual([expect.objectContaining({ kind: "card", cardId: agentCard, topicId: null, taskId: "task-open" })]);
      expect(await f.claimed(f.machine.device)).toEqual([]);
      const other = await f.local("另一台");
      expect(await f.claimed(other.device)).toEqual([]);

      // 本机拒了，放回；又能认领了，两台同时认领只有一台拿到。不存在的放回 404。
      expect((await f.call("POST", `/api/me/session-starts/${first[0].id}/release`, { deviceId: f.machine.device })).statusCode).toBe(204);
      const both = await Promise.all([f.claimed(other.device), f.claimed(f.machine.device)]);
      expect(both.flat().map((start) => start.id)).toEqual([first[0].id]);
      expect((await f.call("POST", `/api/me/session-starts/${randomUUID()}/release`, { deviceId: f.machine.device })).statusCode).toBe(404);
      expect((await f.call("POST", "/api/me/session-starts/not-a-uuid/release", { deviceId: f.machine.device })).statusCode).toBe(404);

      // 认领后网页关了：5 分钟内拿不到，超过 5 分钟能再认领。
      await f.t.sql("UPDATE session_starts SET claimed_at=$2 WHERE id=$1", [first[0].id, new Date(BOARD_NOW.getTime() - 4 * 60_000)]);
      expect(await f.claimed(f.machine.device)).toEqual([]);
      await f.t.sql("UPDATE session_starts SET claimed_at=$2 WHERE id=$1", [first[0].id, new Date(BOARD_NOW.getTime() - 6 * 60_000)]);
      expect((await f.claimed(f.machine.device)).map((start) => start.id)).toEqual([first[0].id]);

      // 别人的电脑、没配对的电脑不能认领。
      const login = await f.t.app.inject({ method: "POST", url: "/api/auth/login", headers: { origin: f.t.publicOrigin }, payload: { loginId: THIRD.loginId, passcode: THIRD.passcode } });
      const third = (login.headers["set-cookie"] as string).split(";")[0];
      const theirDevice = randomUUID();
      expect((await f.call("POST", "/api/me/local-devices", { deviceId: theirDevice, name: "别人的电脑", os: "win32" }, third)).statusCode).toBe(201);
      for (const deviceId of [theirDevice, randomUUID()]) {
        const res = await f.claim(deviceId);
        expect([res.statusCode, res.json().code]).toEqual([404, "DEVICE_NOT_FOUND"]);
      }

      // 本机报上这张卡的第一条执行：那条了结，放回、再认领都没有了。
      await f.machine.send({ kind: "card", cardId: agentCard }, [status("running", "跑题库")]);
      expect(await f.t.sql("SELECT count(*)::int AS n FROM session_starts WHERE closed_at IS NULL")).toEqual([{ n: 0 }]);
      await f.t.sql("UPDATE session_starts SET claimed_at=NULL,claimed_device=NULL");
      expect(await f.claimed(f.machine.device)).toEqual([]);
      expect((await f.call("POST", `/api/me/session-starts/${first[0].id}/release`, { deviceId: f.machine.device })).statusCode).toBe(404);
    } finally { await f.close(); }
  });

  it("放回只放这台电脑认领的那条：认领过期后别的电脑重新认领了，原来那台迟到的放回 404，认领还在别的电脑那里", async () => {
    const f = await fixture();
    try {
      const card = await f.card("跑题库");
      await f.t.sql(`INSERT INTO session_starts(id,owner_id,kind,card_id,plan_task_id,origin,requested_at) VALUES($1,$2,'card',$3,'task-open','web',$4)`,
        [randomUUID(), TEST_MEMBER.personId, card, BOARD_NOW]);
      const [start] = await f.claimed(f.machine.device);
      await f.t.sql("UPDATE session_starts SET claimed_at=$2 WHERE id=$1", [start.id, new Date(BOARD_NOW.getTime() - 6 * 60_000)]);
      const other = await f.local("另一台");
      expect((await f.claimed(other.device)).map((item) => item.id)).toEqual([start.id]);

      const stale = await f.call("POST", `/api/me/session-starts/${start.id}/release`, { deviceId: f.machine.device });
      expect([stale.statusCode, stale.json().code]).toEqual([404, "NOT_FOUND"]);
      expect(await f.t.sql("SELECT claimed_device FROM session_starts WHERE id=$1", [start.id])).toEqual([{ claimed_device: other.device }]);
      expect(await f.claimed(f.machine.device)).toEqual([]);
      // 不带 deviceId 的放回不收。
      expect((await f.call("POST", `/api/me/session-starts/${start.id}/release`)).statusCode).toBe(400);

      expect((await f.call("POST", `/api/me/session-starts/${start.id}/release`, { deviceId: other.device })).statusCode).toBe(204);
      expect((await f.claimed(f.machine.device)).map((item) => item.id)).toEqual([start.id]);
    } finally { await f.close(); }
  });

  it("卡完成了或退回了、专题归档了，登记着的要开工不再给认领", async () => {
    const f = await fixture();
    try {
      const done = await f.card("做完了的"), returned = await f.card("退回了的"), open = await f.card("还要做的");
      const topic = (await f.openTopic({ title: "归档了的专题" })).json().topicId as string;
      for (const card of [done, returned, open]) await f.t.sql(`INSERT INTO session_starts(id,owner_id,kind,card_id,plan_task_id,origin,requested_at)
        VALUES($1,$2,'card',$3,'task-open','web',$4)`, [randomUUID(), TEST_MEMBER.personId, card, BOARD_NOW]);
      await f.t.sql("UPDATE tasks SET status='done' WHERE id=$1", [done]);
      await f.t.sql("UPDATE tasks SET status='returned' WHERE id=$1", [returned]);
      await f.t.sql("UPDATE research_topics SET status='archived' WHERE id=$1", [topic]);
      expect((await f.claimed(f.machine.device)).map((start) => start.cardId)).toEqual([open]);
    } finally { await f.close(); }
  });

  it("伙伴开探索子会话：建专题配调研员、登记一条要开工；挂本人负责的 Task，不挂也行；别人负责的 Task 拒；本机报上第一条执行就了结", async () => {
    const f = await fixture();
    try {
      const res = await f.openTopic({ title: "竞品调研", planTaskId: "task-open" });
      expect(res.statusCode).toBe(201);
      const { topicId, start } = res.json();
      expect(start).toMatchObject({ kind: "topic", topicId, cardId: null, taskId: "task-open" });
      const topics = (await f.call("GET", "/api/me/topics")).json().topics as { id: string; title: string; planTaskId: string | null; role: { name: string } | null }[];
      expect(topics).toEqual([expect.objectContaining({ id: topicId, title: "竞品调研", planTaskId: "task-open", role: expect.objectContaining({ name: "调研员" }) })]);

      const loose = await f.openTopic({ title: "行业报告" });
      expect(loose.statusCode).toBe(201);
      expect(loose.json().start).toMatchObject({ kind: "topic", topicId: loose.json().topicId, taskId: null });
      // 两个专题共用本人的同一个调研员岗位。
      expect(await f.t.sql("SELECT count(DISTINCT role_id)::int AS n FROM research_topics")).toEqual([{ n: 1 }]);

      const theirs = await f.openTopic({ title: "不该建", planTaskId: "task-theirs" });
      expect([theirs.statusCode, theirs.json().code]).toEqual([403, "FORBIDDEN"]);
      expect((await f.openTopic({ title: "不该建", planTaskId: "task-other" })).statusCode).toBe(404);
      expect((await f.openTopic({ title: "不该建" }, "nobody")).json().code).toBe("OWNER_NOT_FOUND");
      expect((await f.t.app.inject({ method: "POST", url: "/internal/me/topics", headers: { authorization: "Bearer wrong", "x-owner-id": TEST_MEMBER.personId },
        payload: { title: "不该建" } })).statusCode).toBe(401);
      expect(await f.t.sql("SELECT count(*)::int AS n FROM research_topics")).toEqual([{ n: 2 }]);

      // 测试的时钟是定住的，两条登记时间相同，先后按 id，不比顺序。
      expect((await f.claimed(f.machine.device)).map((item) => item.topicId).sort()).toEqual([topicId, loose.json().topicId].sort());
      await f.machine.send({ kind: "topic", topicId }, [status("starting", "竞品调研")]);
      expect(await f.t.sql("SELECT topic_id::text FROM session_starts WHERE closed_at IS NULL")).toEqual([{ topic_id: loose.json().topicId }]);
    } finally { await f.close(); }
  });

  it("本机同步条目 background：子 agent、后台命令按会话和 id 存下，同一项新的覆盖旧的，晚到的旧序号不改", async () => {
    const f = await fixture();
    try {
      const card = await f.card("跑测试");
      const item = (state: string, finishedAt: string | null, stoppable: boolean, title = "跑单元测试") =>
        ({ id: "bash-1", title, kind: "command", state, startedAt: "2026-11-06T01:00:01.000Z", finishedAt, stoppable });
      const session = await f.sync({ kind: "card", cardId: card }, [[1, ...status("running", "跑测试")], [2, "background", item("running", null, true)],
        [3, "background", { id: "agent-1", title: "查资料", kind: "subagent", state: "running", startedAt: "2026-11-06T01:00:02.000Z", finishedAt: null, stoppable: true }]]);
      const rows = () => f.t.sql(`SELECT run_id::text,item_id,owner_id,kind,title,state,finished_at,stoppable,seq::int FROM local_background_items ORDER BY item_id`);
      expect(await rows()).toEqual([
        { run_id: session, item_id: "agent-1", owner_id: TEST_MEMBER.personId, kind: "subagent", title: "查资料", state: "running", finished_at: null, stoppable: true, seq: 3 },
        { run_id: session, item_id: "bash-1", owner_id: TEST_MEMBER.personId, kind: "command", title: "跑单元测试", state: "running", finished_at: null, stoppable: true, seq: 2 },
      ]);
      // 跑完了：新的覆盖旧的。
      await f.sync({ kind: "card", cardId: card }, [[5, "background", item("done", "2026-11-06T01:05:00.000Z", false)]], session);
      // 序号 4 的「还在跑」晚到了：不改。
      await f.sync({ kind: "card", cardId: card }, [[4, "background", item("running", null, true, "晚到的")]], session);
      expect((await rows())[1]).toMatchObject({ item_id: "bash-1", title: "跑单元测试", state: "done", finished_at: new Date("2026-11-06T01:05:00.000Z"), stoppable: false, seq: 5 });
      // 规划员的会话也收。
      const planner = await f.sync({ kind: "plan", taskId: "task-open" }, [[1, "background", { ...item("running", null, true), id: "bash-2" }]]);
      expect(await f.t.sql("SELECT run_id::text FROM local_background_items WHERE item_id='bash-2'")).toEqual([{ run_id: planner }]);
    } finally { await f.close(); }
  });
});
