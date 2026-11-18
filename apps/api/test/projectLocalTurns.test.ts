import { randomUUID } from "node:crypto";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { describe, expect, it } from "vitest";
import { PROJECT_CONVERSATION_RULES } from "@warmap/contracts";
import { boardFixture, type BoardFixture } from "./boardFixture.js";

const CHAT_TOKEN = "chat-token-local-turns";

/** 假 Chat（照 csl-actions 的接口形状，存在内存里）：开段、读历史、发一轮（直接答完）、补记一轮（有 running 的轮次时 409 TURN_RUNNING）。 */
async function memoryChat() {
  type Turn = { runId: string; status: string; user: string; answer: string; turnAt: string; source?: unknown };
  const conversations = new Map<string, Turn[]>();
  const recorded: Record<string, unknown>[] = [];
  const server = createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    const body = Buffer.concat(chunks).toString("utf8");
    const url = req.url ?? "";
    const send = (status: number, value: unknown) => { res.writeHead(status, { "content-type": "application/json" }); res.end(JSON.stringify(value)); };
    if (req.headers.authorization !== `Bearer ${CHAT_TOKEN}`) return send(401, { error: { code: "UNAUTHORIZED", message: "x" } });
    if (req.method === "GET" && url === "/conversations") return send(200, { conversations: [] });
    if (req.method === "POST" && url === "/conversations") {
      const id = randomUUID();
      conversations.set(id, []);
      return send(201, { conversationId: id });
    }
    const history = /^\/conversations\/([^/]+)\/messages\?limit=\d+&cursor=(\d+)$/.exec(url);
    if (req.method === "GET" && history) {
      const turns = history[2] === "0" ? conversations.get(history[1]) ?? [] : [];
      return send(200, { nextCursor: null, runs: turns.map((turn) => ({ runId: turn.runId, status: turn.status, turnAt: turn.turnAt })),
        messages: turns.flatMap((turn) => [{ role: "user", text: turn.user, runId: turn.runId, turnAt: turn.turnAt, attachments: [] },
          ...(turn.answer ? [{ role: "assistant", text: turn.answer, runId: turn.runId }] : [])]) });
    }
    const turnPath = /^\/conversations\/([^/]+)\/turns$/.exec(url);
    if (req.method === "POST" && turnPath) {
      const turns = conversations.get(turnPath[1])!;
      if (turns.some((turn) => turn.status === "running")) return send(409, { error: { code: "TURN_RUNNING", message: "本会话已有运行中的轮次" } });
      const command = JSON.parse(body) as { message: string };
      const runId = randomUUID();
      turns.push({ runId, status: "completed", user: command.message, answer: "云端回答", turnAt: new Date().toISOString() });
      res.writeHead(200, { "content-type": "text/event-stream" });
      for (const event of [{ type: "turn_started", userMessageId: randomUUID() }, { type: "message", delta: "云端回答" }, { type: "done", status: "completed" }])
        res.write(`data: ${JSON.stringify({ conversationId: turnPath[1], runId, ...event })}\n\n`);
      return res.end();
    }
    const recordPath = /^\/conversations\/([^/]+)\/recorded-turns$/.exec(url);
    if (req.method === "POST" && recordPath) {
      const turns = conversations.get(recordPath[1])!;
      if (turns.some((turn) => turn.status === "running")) return send(409, { error: { code: "TURN_RUNNING", message: "本会话已有运行中的轮次" } });
      const input = JSON.parse(body) as { runId: string; status: string; message: string; answer: string; startedAt: string; source: unknown };
      recorded.push(input);
      turns.push({ runId: input.runId, status: input.status, user: input.message, answer: input.answer, turnAt: input.startedAt, source: input.source });
      return send(200, { runId: input.runId, userMessageId: randomUUID(), assistantMessageId: input.answer ? randomUUID() : null, duplicate: false });
    }
    send(404, { error: { code: "NOT_FOUND", message: "没有这个接口" } });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, conversations, recorded,
    close: () => new Promise<void>((resolve) => { server.closeAllConnections(); server.close(() => resolve()); }) };
}

async function setup() {
  const chat = await memoryChat();
  const f = await boardFixture({}, { internalChatToken: CHAT_TOKEN, chatServiceUrl: chat.url, boardCloudAgents: false });
  const projectId = (await f.call("POST", "/api/me/projects", { name: "对话质量", taskId: "task-open" })).json().projectId as string;
  const machine = await f.local();
  const scope = `project:${projectId}`;
  const runner = (path: string, payload: unknown = {}) => f.t.app.inject({ method: "POST", url: path, headers: { authorization: `Bearer ${machine.token}` },
    payload: payload as Record<string, unknown> });
  const start = (message: string, clientTurnId: string = randomUUID()) => runner("/api/local-runner/project-turns",
    { projectId, clientTurnId, message, executor: { agent: "claude-code", modelLabel: "Opus 5.5" } });
  const say = (payload: Record<string, unknown>) => f.t.app.inject({ method: "POST", url: `/api/conversations/${encodeURIComponent(scope)}/messages`,
    headers: { cookie: f.member, origin: f.t.publicOrigin, accept: "text/event-stream" }, payload });
  const history = async () => (await f.call("GET", `/api/conversations/${encodeURIComponent(scope)}/messages`)).json();
  const mcp = (token: string, method: string, params?: Record<string, unknown>) => f.t.app.inject({ method: "POST", url: "/mcp/me",
    headers: { authorization: `Bearer ${token}`, accept: "application/json, text/event-stream" }, payload: { jsonrpc: "2.0", id: 1, method, ...(params ? { params } : {}) } });
  const tool = async (token: string, name: string, args: unknown) => {
    const result = (await mcp(token, "tools/call", { name, arguments: args })).json().result as { isError: boolean; content: { text: string }[] };
    return { isError: result.isError, value: JSON.parse(result.content[0].text) };
  };
  return { chat, f, projectId, machine, runner, start, say, history, mcp, tool, close: async () => { await f.close(); await chat.close(); } };
}
const toolNames = async (s: Awaited<ReturnType<typeof setup>>, token: string) =>
  ((await s.mcp(token, "tools/list")).json().result.tools as { name: string }[]).map((tool) => tool.name);

describe("项目对话在本人电脑上跑（17.2 第 38 条）", () => {
  it("项目钥匙挂 MCP 多出项目动作；开始一轮占住对话、带最近几轮和项目情况；本机占着时云端不发、手机看得到；结束写进 Chat，带来源和做成的动作", async () => {
    const s = await setup();
    try {
      expect((await s.f.call("PUT", "/api/me/buddy-authority", { authority: "full" })).statusCode).toBe(200);
      expect((await s.say({ message: "先在云端说一句" })).statusCode).toBe(200);

      // 项目钥匙：同一台电脑再取一次，旧的作废。设备令牌本身照旧只读、没有项目动作。
      const key = async () => (await s.runner("/api/local-runner/project-keys", { projectId: s.projectId })).json();
      const old = (await key()).token as string;
      const issued = await key();
      expect(issued.mcpUrl).toMatch(/\/mcp\/me$/);
      expect((await s.mcp(old, "tools/list")).statusCode).toBe(401);
      const names = await toolNames(s, issued.token);
      expect(names).toEqual(expect.arrayContaining(["split_cards", "sub_session_tell", "ask_user", "update_plan", "read_earlier_conversation", "get_task_context"]));
      expect(names).not.toContain("open_page");
      expect(names).not.toContain("message_project");
      expect(names).not.toContain("create_item");
      expect(await toolNames(s, s.machine.token)).not.toContain("split_cards");
      expect((await s.runner("/api/local-runner/project-keys", { projectId: randomUUID() })).statusCode).toBe(404);

      const clientTurnId = randomUUID();
      const started = await s.start("帮我把这个项目改个名", clientTurnId);
      expect(started.statusCode).toBe(200);
      const turn = started.json();
      expect(turn.scope).toBe(`project:${s.projectId}`);
      expect(turn.context.recent).toMatchObject([{ ranOn: "cloud", user: "先在云端说一句", assistant: "云端回答", status: "completed", actions: [] }]);
      expect(turn.context.earlier).toBe(0);
      expect(turn.context.project.project.name).toBe("对话质量");
      expect(Array.isArray(turn.context.project.subSessions)).toBe(true);
      expect(turn.rules).toBe(PROJECT_CONVERSATION_RULES);
      expect(turn.lease).toEqual({ heartbeatSeconds: 30, expiresAfterSeconds: 120 });
      // 同一个 clientTurnId 再来是同一轮；别的一轮、云端发消息都被挡住；手机读历史看得到正在本机回答。
      expect((await s.start("帮我把这个项目改个名", clientTurnId)).json().turnId).toBe(turn.turnId);
      expect((await s.start("另一句")).json())
        .toMatchObject({ code: "TURN_IN_PROGRESS", runningOn: "local" });
      expect((await s.say({ message: "手机上又说一句" })).json().code).toBe("TURN_IN_PROGRESS");
      expect((await s.history()).localTurn).toMatchObject({ turnId: turn.turnId, message: "帮我把这个项目改个名", deviceName: "我的电脑", source: "本机 · Claude Code · Opus 5.5" });

      // 项目会话里用项目动作：清单记在这一轮上、工具结果里带回清单；写动作记审计，结束时转成文字写进 Chat。
      const plan = await s.tool(issued.token, "update_plan", { entries: [{ content: "读项目", status: "completed" }, { content: "改名", status: "in_progress" }] });
      expect(plan.isError).toBe(false);
      expect(plan.value.plan.entries).toHaveLength(2);
      const renamed = await s.tool(issued.token, "rename_project", { projectId: s.projectId, name: "对话质量 2" });
      expect(renamed.isError).toBe(false);
      expect(renamed.value).toMatchObject({ undoable: true });
      // 工具结果带回界面要跟着变的（网页据此重读项目），和天枢自动打过勾的清单。
      expect(renamed.value.ui).toEqual([{ kind: "refresh", what: ["work_home", "project"], id: s.projectId }]);
      expect(renamed.value.plan.entries.map((entry: { status: string }) => entry.status)).toEqual(["completed", "completed"]);
      expect(plan.value.ui).toBeUndefined();
      expect((await s.tool(issued.token, "open_page", { target: { kind: "home" } })).isError).toBe(true);
      expect((await s.runner(`/api/local-runner/project-turns/${turn.turnId}/heartbeat`)).statusCode).toBe(204);

      const finished = await s.runner(`/api/local-runner/project-turns/${turn.turnId}/finish`, { status: "completed", answer: "改好了，叫「对话质量 2」。" });
      expect(finished.json()).toEqual({ turnId: turn.turnId, recorded: true });
      expect(s.chat.recorded).toMatchObject([{ runId: turn.turnId, clientRequestId: `local:${turn.turnId}`, message: "帮我把这个项目改个名", answer: "改好了，叫「对话质量 2」。",
        status: "completed", source: { kind: "local", label: "本机 · Claude Code · Opus 5.5" }, actions: [{ name: "rename_project", summary: "把项目「对话质量」改名为「对话质量 2」" }] }]);
      expect((await s.runner(`/api/local-runner/project-turns/${turn.turnId}/finish`, { status: "completed", answer: "再来一次" })).json()).toEqual({ turnId: turn.turnId, recorded: true });
      expect((await s.runner(`/api/local-runner/project-turns/${turn.turnId}/heartbeat`)).json().code).toBe("LOCAL_TURN_FINISHED");

      // 读历史：本机那一轮标 local 和执行方、模型，带清单；云端那一轮标 cloud；不再有 localTurn。云端又能发了。
      const after = await s.history();
      expect(after.localTurn).toBeUndefined();
      const answers = after.messages.filter((message: { role: string }) => message.role === "assistant");
      expect(answers.map((message: { ranOn: string }) => message.ranOn)).toEqual(["cloud", "local"]);
      expect(answers[1]).toMatchObject({ runId: turn.turnId, model: { provider: "Claude Code", model: "Opus 5.5" }, plan: { entries: [{ content: "读项目" }, { content: "改名" }], collapsed: true } });
      expect((await s.tool(issued.token, "read_earlier_conversation", {})).value).toMatchObject({ earlier: 0,
        turns: [{ ranOn: "cloud" }, { ranOn: "local", source: "本机 · Claude Code · Opus 5.5", actions: ["把项目「对话质量」改名为「对话质量 2」"] }] });
      expect((await s.tool(issued.token, "read_earlier_conversation", { beforeRunId: turn.turnId, turns: 5 })).value.turns).toHaveLength(1);
      expect((await s.say({ message: "回到云端" })).statusCode).toBe(200);

      // 项目归档以后钥匙不算数。
      await s.f.t.sql("UPDATE projects SET archived_at=now() WHERE id=$1", [s.projectId]);
      expect((await s.mcp(issued.token, "tools/list")).statusCode).toBe(401);
    } finally {
      await s.close();
    }
  }, 60_000);

  it("云端在回时本机开不了；本机没跑成放掉这一轮、改发云端标 fallback；太久没心跳放开，之后的结束不写进对话", async () => {
    const s = await setup();
    try {
      // 云端那一轮还在跑（Chat 里有 running 的轮次）。
      const conversationId = (await s.f.call("POST", `/api/me/projects/${s.projectId}/pipeline`)).json().conversationId as string;
      s.chat.conversations.get(conversationId)!.push({ runId: randomUUID(), status: "running", user: "云端在回", answer: "", turnAt: new Date().toISOString() });
      expect((await s.start("本机来一句")).json()).toMatchObject({ code: "TURN_IN_PROGRESS", runningOn: "cloud" });
      s.chat.conversations.get(conversationId)!.pop();

      // 额度用完：放掉，不写进 Chat；网页把同一句改发云端，读回历史标 fallback。
      const released = (await s.start("本机来一句")).json();
      expect((await s.runner(`/api/local-runner/project-turns/${released.turnId}/finish`, { status: "released", reason: "local_quota" })).json())
        .toEqual({ turnId: released.turnId, recorded: false });
      expect(s.chat.recorded).toHaveLength(0);
      expect((await s.say({ message: "本机来一句", fallback: "local_quota" })).statusCode).toBe(200);
      await expect.poll(async () => (await s.history()).messages.filter((message: { role: string }) => message.role === "assistant")
        .map((message: { ranOn: string; fallback?: string }) => [message.ranOn, message.fallback])).toEqual([["cloud", "local_quota"]]);

      // 本机程序挂了：太久没心跳，云端照常发，这一轮的结束回 LOCAL_TURN_EXPIRED、不写进对话。
      const lost = (await s.start("再来一句")).json();
      await s.f.t.sql("UPDATE project_local_turns SET heartbeat_at=started_at - interval '10 minutes' WHERE id=$1", [lost.turnId]);
      expect((await s.history()).localTurn).toBeUndefined();
      expect((await s.say({ message: "云端接着说" })).statusCode).toBe(200);
      expect((await s.runner(`/api/local-runner/project-turns/${lost.turnId}/finish`, { status: "completed", answer: "晚了" })).json().code).toBe("LOCAL_TURN_EXPIRED");
      expect(s.chat.recorded).toHaveLength(0);
      // 别的电脑碰不到这一轮。
      const other = await s.f.local("另一台");
      expect((await s.f.t.app.inject({ method: "POST", url: `/api/local-runner/project-turns/${lost.turnId}/heartbeat`, headers: { authorization: `Bearer ${other.token}` },
        payload: {} })).statusCode).toBe(404);
    } finally {
      await s.close();
    }
  }, 60_000);

  it("本机那一轮收起清单出错时，回答照样写进 Chat", async () => {
    const s = await setup();
    try {
      const turn = (await s.start("帮我看看进展")).json();
      // 收起清单的 UPDATE 一律报错。
      await s.f.t.sql(`CREATE FUNCTION fail_plan_update() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'plan update broken'; END $$`);
      await s.f.t.sql("CREATE TRIGGER fail_plan_update BEFORE UPDATE ON buddy_plans FOR EACH ROW EXECUTE FUNCTION fail_plan_update()");
      await s.f.t.sql("INSERT INTO buddy_plans(run_id,owner_id,entries,collapsed,updated_at) VALUES($1,$2,$3::jsonb,false,now())",
        [turn.turnId, (await s.f.t.sql("SELECT owner_id FROM project_local_turns WHERE id=$1", [turn.turnId]))[0].owner_id,
          JSON.stringify([{ content: "读项目", status: "in_progress" }, { content: "回话", status: "pending" }])]);
      const finished = await s.runner(`/api/local-runner/project-turns/${turn.turnId}/finish`, { status: "completed", answer: "进展都在这里。" });
      expect([finished.statusCode, finished.json()]).toEqual([200, { turnId: turn.turnId, recorded: true }]);
      expect(s.chat.recorded).toMatchObject([{ runId: turn.turnId, answer: "进展都在这里。" }]);
    } finally {
      await s.close();
    }
  }, 60_000);
});
