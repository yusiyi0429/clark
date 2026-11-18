import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { PROJECT_MCP_ACTIONS } from "@warmap/contracts";
import { boardFixture, THIRD } from "./boardFixture.js";
import { runAction, runExtras, type BuddyDeps } from "../src/buddyActions.js";
import type { Query } from "../src/meetingStore.js";
import { projectHistoryReader } from "../src/sourceWords.js";
import { TEST_MEMBER } from "./helpers.js";

/**
 * 伙伴主线借鉴 dots（本人 11/18）：简单的伙伴自己做，项目级的在某个项目里开一个会话（open_session），一次性的活放进「随手」项目。
 * 做成后回一张派活卡（buddy_dispatch），读历史时还在那一轮上；从主线开的会话做完一轮，主线事件里出一行。
 */

const TOKEN = "chat-token";

async function fixture() {
  const f = await boardFixture({}, { boardCloudAgents: false, internalChatToken: TOKEN });
  const act = (name: string, args: unknown, options: { turn?: { runId: string; conversationId: string } } = {}) => f.t.app.inject({ method: "POST",
    url: `/internal/me/buddy-actions/${name}`, headers: { authorization: `Bearer ${TOKEN}`, "x-owner-id": TEST_MEMBER.personId }, payload: { args, ...options.turn } });
  const grant = () => f.call("PUT", "/api/me/buddy-authority", { authority: "full" });
  const project = async (name: string) => (await f.call("POST", "/api/me/projects", { name })).json().projectId as string;
  const listed = async (conversationId?: string) => ((await f.t.app.inject({ method: "GET",
    url: `/internal/me/buddy-actions${conversationId ? `?conversationId=${conversationId}` : ""}`,
    headers: { authorization: `Bearer ${TOKEN}`, "x-owner-id": TEST_MEMBER.personId } })).json().actions as { name: string }[]).map((action) => action.name);
  /** 时钟一步一毫秒往前走的 deps（同一轮几张卡按出的先后排要用）。 */
  const deps = (streamed: { runId: string; event: Record<string, unknown> }[] = []): BuddyDeps => {
    const q = f.t.pool.query.bind(f.t.pool) as Query;
    let tick = Date.parse("2026-11-18T02:00:00.000Z");
    return { app: f.t.app, q, env: f.t.env, now: () => new Date(tick++), names: () => new Map(),
      stream: (run, event) => { streamed.push({ runId: run, event }); return true; }, history: projectHistoryReader({ q, conversationTurnTimeoutMs: 10_000 }) };
  };
  /** 本人在这段对话里说一句，回这一句的 runId。 */
  const ask = async (scope: string, message: string) => {
    expect((await f.t.app.inject({ method: "POST", url: `/api/conversations/${encodeURIComponent(scope)}/messages`,
      headers: { cookie: f.member, origin: f.t.publicOrigin, accept: "text/event-stream" }, payload: { message } })).statusCode).toBe(200);
    const messages = (await f.t.app.inject({ method: "GET", url: `/api/conversations/${encodeURIComponent(scope)}/messages`, headers: { cookie: f.member } }))
      .json().messages as { role: string; runId: string; buddyReactions?: string[] }[];
    return messages.filter((message) => message.role === "user").at(-1)!.runId;
  };
  const said = async (scope: string, runId: string) => ((await f.t.app.inject({ method: "GET", url: `/api/conversations/${encodeURIComponent(scope)}/messages`,
    headers: { cookie: f.member } })).json().messages as { role: string; runId: string; buddyReactions?: string[] }[])
    .find((message) => message.role === "user" && message.runId === runId)!;
  return { ...f, act, grant, project, listed, deps, ask, said };
}
type Fixture = Awaited<ReturnType<typeof fixture>>;

const turn = () => ({ runId: randomUUID(), conversationId: randomUUID() });
const BRIEF = "把首页配色改成深色系。本人原话：「按钮也一起改，别的不动」";

describe("伙伴主线开会话（open_session）", { timeout: 60_000 }, () => {
  it("在指定项目里开一个会话：建了自由会话、登记了开工、名字是 title、交代是 brief", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const projectId = await f.project("品牌建设");
      const res = await f.act("open_session", { projectId, title: "首页换深色", brief: BRIEF }, { turn: turn() });
      expect(res.statusCode, res.body).toBe(200);
      const body = res.json();
      expect(body.result).toEqual({ dispatchId: expect.any(String), projectId, projectName: "品牌建设", kind: "topic", id: expect.any(String), title: "首页换深色" });
      expect(body).toMatchObject({ summary: "在项目「品牌建设」里开了「首页换深色」，本人电脑上开着的网页接下后就开始", undoable: false, auditId: expect.any(String) });
      expect(await f.t.sql("SELECT id::text,free,project_id::text,title,first_message FROM research_topics")).toEqual([
        { id: body.result.id, free: true, project_id: projectId, title: "首页换深色", first_message: BRIEF }]);
      expect(await f.t.sql("SELECT topic_id::text FROM session_starts WHERE closed_at IS NULL")).toEqual([{ topic_id: body.result.id }]);
    } finally { await f.close(); }
  });

  it("带 scratch：没有随手项目就建一个，再开第二个会话还是同一个项目", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const first = (await f.act("open_session", { scratch: true, title: "查一下汇率", brief: "查今天美元兑人民币" }, { turn: turn() })).json();
      const second = (await f.act("open_session", { scratch: true, title: "改简历", brief: "把简历改短一页" }, { turn: turn() })).json();
      expect(first.result).toMatchObject({ projectName: "随手", kind: "topic" });
      expect(second.result.projectId).toBe(first.result.projectId);
      expect(await f.t.sql("SELECT id::text,name FROM projects WHERE owner_id=$1 AND scratch", [TEST_MEMBER.personId])).toEqual([
        { id: first.result.projectId, name: "随手" }]);
      expect(await f.t.sql("SELECT count(*)::int AS n FROM research_topics WHERE project_id=$1", [first.result.projectId])).toEqual([{ n: 2 }]);
    } finally { await f.close(); }
  });

  it("随手项目归档了，再用时自动恢复", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const first = (await f.act("open_session", { scratch: true, title: "查一下汇率", brief: "查今天美元兑人民币" }, { turn: turn() })).json();
      expect((await f.call("PATCH", `/api/me/projects/${first.result.projectId}`, { archived: true })).statusCode).toBe(200);
      const again = await f.act("open_session", { scratch: true, title: "改简历", brief: "把简历改短一页" }, { turn: turn() });
      expect(again.statusCode, again.body).toBe(200);
      expect(again.json().result.projectId).toBe(first.result.projectId);
      expect(await f.t.sql("SELECT archived_at FROM projects WHERE id=$1", [first.result.projectId])).toEqual([{ archived_at: null }]);
    } finally { await f.close(); }
  });

  it("projectId 和 scratch 都带或都不带，回 400 INVALID_ARGS，不建任何东西", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const projectId = await f.project("品牌建设");
      for (const args of [{ projectId, scratch: true, title: "两样都带", brief: BRIEF }, { title: "都不带", brief: BRIEF }]) {
        const res = await f.act("open_session", args, { turn: turn() });
        expect([res.statusCode, res.json().code]).toEqual([400, "INVALID_ARGS"]);
      }
      expect(await f.t.sql("SELECT * FROM research_topics")).toEqual([]);
      expect(await f.t.sql("SELECT * FROM projects WHERE scratch")).toEqual([]);
      expect(await f.t.sql("SELECT * FROM buddy_dispatches")).toEqual([]);
    } finally { await f.close(); }
  });

  it("同一轮同一句交代重放只开一个会话", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const projectId = await f.project("品牌建设");
      const same = turn();
      const first = (await f.act("open_session", { projectId, title: "首页换深色", brief: BRIEF }, { turn: same })).json();
      const second = (await f.act("open_session", { projectId, title: "首页换深色", brief: BRIEF }, { turn: same })).json();
      expect(second.result).toEqual(first.result);
      expect(await f.t.sql("SELECT count(*)::int AS n FROM research_topics")).toEqual([{ n: 1 }]);
      expect(await f.t.sql("SELECT count(*)::int AS n FROM buddy_dispatches")).toEqual([{ n: 1 }]);
      // 经对话流重放：只出一张卡。
      const streamed: { runId: string; event: Record<string, unknown> }[] = [];
      const deps = f.deps(streamed);
      const call = { personId: TEST_MEMBER.personId, conversationId: randomUUID(), runId: randomUUID() };
      for (let i = 0; i < 2; i++) await runAction(deps, call, "open_session", { projectId, title: "按钮换深色", brief: "只改按钮" });
      expect(streamed.filter(({ event }) => event.type === "card")).toHaveLength(1);
      // 换一轮同一句是本人又要了一次：再开一个。
      expect((await f.act("open_session", { projectId, title: "首页换深色", brief: BRIEF }, { turn: turn() })).json().result.id).not.toBe(first.result.id);
    } finally { await f.close(); }
  });

  it("做成后在本人那句话上点 👍，并经对话流推出派活卡", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const projectId = await f.project("品牌建设");
      const runId = await f.ask("global", "首页换成深色，按钮也一起改");
      const streamed: { runId: string; event: Record<string, unknown> }[] = [];
      const outcome = await runAction(f.deps(streamed), { personId: TEST_MEMBER.personId, conversationId: randomUUID(), runId }, "open_session",
        { projectId, title: "首页换深色", brief: BRIEF });
      const result = outcome.result as { dispatchId: string; id: string };
      expect(streamed.filter(({ event }) => event.type === "card")).toEqual([{ runId, event: { type: "card", card: { kind: "buddy_dispatch",
        dispatchId: result.dispatchId, projectId, projectName: "品牌建设", sub: { kind: "topic", id: result.id, title: "首页换深色" } } } }]);
      expect(streamed.filter(({ event }) => event.type === "ui")).toEqual([{ runId, event: { type: "ui",
        ui: { kind: "refresh", what: ["work_home", "sub_session", "project"], id: result.id } } }]);
      expect((await f.said("global", runId)).buddyReactions).toEqual(["👍"]);
    } finally { await f.close(); }
  });

  it("读历史时派活卡还在那一轮上", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const projectId = await f.project("品牌建设");
      const deps = f.deps();
      const call = (runId: string) => ({ personId: TEST_MEMBER.personId, conversationId: randomUUID(), runId });
      const question = { header: "配色", question: "深到什么程度？", options: [{ label: "纯黑", detail: "对比最强" }, { label: "深灰", detail: "柔和一些" }] };
      // 这一轮先问再开；另一轮先开再问。
      const asking = randomUUID(), opening = randomUUID();
      const asked1 = (await runAction(deps, call(asking), "ask_user", { questions: [question] })).result as { questionId: string };
      const opened1 = (await runAction(deps, call(asking), "open_session", { projectId, title: "首页换深色", brief: BRIEF })).result as { dispatchId: string; id: string };
      const opened2 = (await runAction(deps, call(opening), "open_session", { projectId, title: "按钮换深色", brief: "只改按钮" })).result as { dispatchId: string; id: string };
      const asked2 = (await runAction(deps, call(opening), "ask_user", { questions: [question] })).result as { questionId: string };
      const extras = await runExtras(deps.q, TEST_MEMBER.personId, [asking, opening]);
      const shape = (run: string) => extras.get(run)!.cards!.map((card) => card.kind === "buddy_dispatch" ? card.dispatchId : card.kind === "buddy_question" ? card.questionId : card.kind);
      expect(shape(asking)).toEqual([asked1.questionId, opened1.dispatchId]);
      expect(shape(opening)).toEqual([opened2.dispatchId, asked2.questionId]);
      expect(extras.get(asking)!.cards![1]).toEqual({ kind: "buddy_dispatch", dispatchId: opened1.dispatchId, projectId, projectName: "品牌建设",
        sub: { kind: "topic", id: opened1.id, title: "首页换深色" } });
      // 会话、项目后来改了名：卡上照现在的名字。
      await f.call("PATCH", `/api/me/sub-sessions/topic/${opened1.id}`, { title: "深色首页" });
      await f.call("PATCH", `/api/me/projects/${projectId}`, { name: "品牌" });
      expect((await runExtras(deps.q, TEST_MEMBER.personId, [asking])).get(asking)!.cards![1]).toMatchObject({ projectName: "品牌", sub: { title: "深色首页" } });
    } finally { await f.close(); }
  });

  it("message_project 也回一张派活卡，sub 为 null", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const projectId = await f.project("品牌建设");
      const streamed: { runId: string; event: Record<string, unknown> }[] = [];
      const deps = f.deps(streamed);
      const runId = randomUUID();
      await runAction(deps, { personId: TEST_MEMBER.personId, conversationId: randomUUID(), runId }, "message_project", { projectId, text: "录屏先停" });
      const card = streamed.find(({ event }) => event.type === "card")!.event.card as Record<string, unknown>;
      expect(card).toEqual({ kind: "buddy_dispatch", dispatchId: expect.any(String), projectId, projectName: "品牌建设", sub: null });
      expect((await runExtras(deps.q, TEST_MEMBER.personId, [runId])).get(runId)!.cards).toEqual([card]);
    } finally { await f.close(); }
  });

  it("项目对话里调 open_session 回 409 MAIN_ONLY；带项目对话的 conversationId 取动作清单时没有它", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const projectId = await f.project("品牌建设");
      const conversationId = randomUUID();
      await f.t.sql("INSERT INTO project_pipelines(project_id,owner_id,conversation_id) VALUES($1,$2,$3)", [projectId, TEST_MEMBER.personId, conversationId]);
      const res = await f.act("open_session", { projectId, title: "首页换深色", brief: BRIEF }, { turn: { runId: randomUUID(), conversationId } });
      expect([res.statusCode, res.json().code]).toEqual([409, "MAIN_ONLY"]);
      expect(await f.t.sql("SELECT * FROM research_topics")).toEqual([]);
      expect(await f.listed(conversationId)).not.toContain("open_session");
      expect(await f.listed(randomUUID())).toContain("open_session");
      expect(await f.listed()).toContain("open_session");
    } finally { await f.close(); }
  });

  it("本机项目会话的工具里没有 open_session", () => {
    expect(PROJECT_MCP_ACTIONS).not.toContain("open_session");
  });

  it("项目在交接中，回 409 PROJECT_PAUSED，不建会话", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const projectId = await f.project("品牌建设");
      await f.t.sql("UPDATE projects SET quiet_since=now() WHERE id=$1", [projectId]);
      const res = await f.act("open_session", { projectId, title: "首页换深色", brief: BRIEF }, { turn: turn() });
      expect([res.statusCode, res.json().code]).toEqual([409, "PROJECT_PAUSED"]);
      expect(await f.t.sql("SELECT * FROM research_topics")).toEqual([]);
      expect(await f.t.sql("SELECT * FROM buddy_dispatches")).toEqual([]);
    } finally { await f.close(); }
  });

  it("随手项目不能转交，回 409 SCRATCH_PROJECT", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const scratch = (await f.act("open_session", { scratch: true, title: "查一下汇率", brief: "查今天美元兑人民币" }, { turn: turn() })).json().result.projectId as string;
      const res = await f.call("POST", `/api/me/projects/${scratch}/transfers`, { toPersonId: THIRD.personId });
      expect([res.statusCode, res.json().code]).toEqual([409, "SCRATCH_PROJECT"]);
      expect(await f.t.sql("SELECT * FROM project_transfers")).toEqual([]);
    } finally { await f.close(); }
  });

  it("首页和项目列表里随手项目带 scratch: true，别的项目不带", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const plain = await f.project("品牌建设");
      const scratch = (await f.act("open_session", { scratch: true, title: "查一下汇率", brief: "查今天美元兑人民币" }, { turn: turn() })).json().result.projectId as string;
      const home = (await f.call("GET", "/api/me/work-home")).json().projects as { projectId: string; scratch?: boolean }[];
      expect(home.find((entry) => entry.projectId === scratch)!.scratch).toBe(true);
      expect(home.find((entry) => entry.projectId === plain)).not.toHaveProperty("scratch");
      const list = (await f.call("GET", "/api/me/projects")).json().projects as { projectId: string; scratch?: boolean }[];
      expect(list.find((entry) => entry.projectId === scratch)!.scratch).toBe(true);
      expect(list.find((entry) => entry.projectId === plain)).not.toHaveProperty("scratch");
    } finally { await f.close(); }
  });
});

describe("从主线开的会话做完一轮，主线出一行", { timeout: 60_000 }, () => {
  /** 本机在一个会话里按序号往下报（每条时间往后一秒）。 */
  const machineFor = async (f: Fixture, topicId: string) => {
    const machine = await f.local();
    const session = randomUUID();
    let seq = 0;
    return async (type: string, data: unknown) => {
      seq += 1;
      const res = await f.t.app.inject({ method: "POST", url: "/api/local-runner/sync", headers: { authorization: `Bearer ${machine.token}` }, payload: {
        deviceId: machine.device, runnerVersion: "0.1.0", slots: { max: 3, running: 1, queued: 0 }, items: [{ key: `${machine.device}:${session}:${seq}`, sessionId: session,
          subject: { kind: "topic", topicId }, occurredAt: new Date(Date.UTC(2026, 10, 6, 1, 0, seq)).toISOString(), type, data }] } });
      expect(res.json().rejected).toEqual([]);
    };
  };
  const running = ["status", { status: "running", title: "首页换深色", agent: "claude-code", modelLabel: "Opus 5.5" }] as const;
  const events = async (f: Fixture) => (await f.call("GET", "/api/me/partner-work-events")).json().items as Record<string, unknown>[];
  const reportIds = async (f: Fixture, topicId: string) => (await f.t.sql("SELECT id::text FROM sub_session_reports WHERE subject_id=$1 ORDER BY created_at",
    [topicId])).map((row) => row.id as string);

  it("从主线开的会话正常做完一轮，主线事件里有一条 done", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const projectId = await f.project("品牌建设");
      const topic = (await f.act("open_session", { projectId, title: "首页换深色", brief: BRIEF }, { turn: turn() })).json().result.id as string;
      const report = await machineFor(f, topic);
      await report(...running);
      await report("stopped", { why: "turn_done", summary: "首页和按钮都换成深色了。", blocker: null, outputs: [] });
      const [id] = await reportIds(f, topic);
      expect(await events(f)).toEqual([{ id, at: "2026-11-06T01:00:02.000Z", projectId, projectName: "品牌建设", title: "首页换深色",
        detail: "首页和按钮都换成深色了。", subjectKind: "topic", subjectId: topic, waitingId: null, done: true, fromMain: true }]);
      // 项目、会话后来改了名：照现在的名字。
      await f.call("PATCH", `/api/me/projects/${projectId}`, { name: "品牌" });
      await f.call("PATCH", `/api/me/sub-sessions/topic/${topic}`, { title: "深色首页" });
      expect(await events(f)).toMatchObject([{ projectName: "品牌", title: "深色首页" }]);
      // 归档的项目照旧不出。
      await f.call("PATCH", `/api/me/projects/${projectId}`, { archived: true });
      expect(await events(f)).toEqual([]);
    } finally { await f.close(); }
  });

  it("同一个会话只留最新一行做完一轮；最新一次卡住时不出", async () => {
    const f = await fixture();
    try {
      await f.grant();
      const projectId = await f.project("品牌建设");
      const topic = (await f.act("open_session", { projectId, title: "首页换深色", brief: BRIEF }, { turn: turn() })).json().result.id as string;
      const report = await machineFor(f, topic);
      await report(...running);
      await report("stopped", { why: "turn_done", summary: "第一轮", blocker: null, outputs: [] });
      await report(...running);
      await report("stopped", { why: "turn_done", summary: null, blocker: null, outputs: [] });
      const [, latest] = await reportIds(f, topic);
      expect((await events(f)).map((event) => [event.id, event.detail, event.done])).toEqual([[latest, "", true]]);
      await report(...running);
      await report("stopped", { why: "held", summary: null, blocker: "订阅额度用完，14:00 恢复", outputs: [] });
      const [, , stuck] = await reportIds(f, topic);
      expect(await events(f)).toEqual([{ id: stuck, at: expect.any(String), projectId, projectName: "品牌建设", title: "首页换深色",
        detail: "订阅额度用完，14:00 恢复", subjectKind: "topic", subjectId: topic, waitingId: null, fromMain: true }]);
    } finally { await f.close(); }
  });

  it("项目里自己开的会话正常做完，主线事件里没有", async () => {
    const f = await fixture();
    try {
      const projectId = await f.project("品牌建设");
      const topic = (await f.call("POST", "/api/me/topics", { free: true, projectId, firstMessage: "改首页配色" })).json().id as string;
      const report = await machineFor(f, topic);
      await report(...running);
      await report("stopped", { why: "turn_done", summary: "改好了", blocker: null, outputs: [] });
      expect(await events(f)).toEqual([]);
      // 卡住的照旧出，不带 fromMain。
      await report(...running);
      await report("stopped", { why: "held", summary: null, blocker: "等素材", outputs: [] });
      expect(await events(f)).toEqual([expect.not.objectContaining({ fromMain: true })]);
      expect(await events(f)).toMatchObject([{ detail: "等素材", subjectId: topic }]);
    } finally { await f.close(); }
  });
});
