import { createHash, randomUUID } from "node:crypto";
import type { Pool } from "pg";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { Value } from "@sinclair/typebox/value";
import {
  PROJECT_CONVERSATION_RULES, PROJECT_MCP_ACTIONS, READ_EARLIER_CONVERSATION_TOOL, ReadEarlierConversationParams, SUB_SESSION_REPORT_PREFIX,
  type TBuddyPlan, type TBuddyUiEffect, type TConversationCard, type TConversationLocalTurn, type TConversationModel, type TLocalProjectExecutor, type TLocalProjectKeyResponse,
  type TLocalProjectTurnFinishRequest, type TLocalProjectTurnFinishResponse, type TLocalProjectTurnStartRequest, type TLocalProjectTurnStartResponse,
  type TProjectDetailResponse, type TProjectMcpToolResult, type TProjectTurnRecord, type TReadEarlierConversationResult, type TSubSession, type TWorkHomeResponse,
} from "@warmap/contracts";
import { BuddyError, actionList, callAsPerson, closeQuestions, collapsePlan, readAuthority, runAction, type BuddyDeps } from "./buddyActions.js";
import { BUDDY_FORWARD_PREFIX, ChatServiceError, type ChatService } from "./chatService.js";
import { resetAutoRelay } from "./autoRelay.js";
import type { Query } from "./meetingStore.js";
import { logEvent } from "./observability.js";
import { issueLocalToken } from "./personalTokens.js";
import { ownerSpoke } from "./projectTransfers.js";
import { ensureProjectPipeline, pipelineViewer, projectPipelineConversation } from "./taskPipelines.js";
import { recordProjectReply } from "./workSeen.js";

/**
 * 项目对话在本人电脑上跑（设计稿 17.2 第 38 条，契约 projectLocalTurns.ts）：项目钥匙、本机一轮的开始 / 心跳 / 结束（占住这段对话、写进 Chat）、
 * 项目会话的天枢 MCP 工具，以及读历史时要的本机那一轮。云端那边（发消息、读历史）调这里的 localTurnBusy、historyLocalTurn、localTurnExtras。
 */

export const LEASE = { heartbeatSeconds: 30, expiresAfterSeconds: 120 };
const KEY_DAYS = 30;
const RECENT_TURNS = 8;
const RECENT_CHARS = 40_000;
/** 结束了还没写进 Chat 的那一轮，这么久以内算占着（写进去之前云端不发，免得顺序乱）；更久的不再挡。 */
const PENDING_RECORD_MS = 15 * 60_000;
const RECORD_RETRY_MS = 5_000;
const RECORD_GIVE_UP_MS = 10 * 60_000;
const AGENT_NAME: Record<TLocalProjectExecutor["agent"], string> = { "claude-code": "Claude Code", codex: "Codex" };

export class LocalTurnError extends Error {
  constructor(readonly status: number, readonly code: string, message: string, readonly extra: Record<string, unknown> = {}) {
    super(message);
  }
}

export type LocalTurnDeps = {
  pool: Pool;
  q: Query;
  chat?: ChatService;
  now: () => Date;
  pepper: string;
  publicOrigin: string;
  /** 以本人身份执行伙伴动作、读首页和项目（buddyActions.ts）。 */
  buddy: BuddyDeps;
};

type TurnRow = { id: string; owner_id: string; project_id: string; device_id: string; client_turn_id: string; request_hash: string; conversation_id: string;
  message: string; agent: TLocalProjectExecutor["agent"]; model_label: string; status: string; answer: string | null; error_code: string | null;
  started_at: Date; heartbeat_at: Date; finished_at: Date | null; recorded_at: Date | null };

const sourceLabel = (agent: TLocalProjectExecutor["agent"], modelLabel: string) => `本机 · ${AGENT_NAME[agent]} · ${modelLabel}`;
const hashOf = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** 本人的、没归档的项目；没有 404。 */
async function liveProject(q: Query, ownerId: string, projectId: string): Promise<{ id: string; name: string }> {
  const row = (await q("SELECT id::text,name FROM projects WHERE id=$1 AND owner_id=$2 AND archived_at IS NULL", [projectId, ownerId])).rows[0] as
    { id: string; name: string } | undefined;
  if (!row) throw new LocalTurnError(404, "PROJECT_NOT_FOUND", "找不到这个项目，或者已经归档了");
  return row;
}

// ───────────────────────── 项目钥匙 ─────────────────────────

/** 给这台电脑上这个项目的项目会话发一把 MCP 钥匙；同一台电脑同一个项目的旧钥匙作废。 */
export async function issueProjectKey(deps: LocalTurnDeps, ownerId: string, deviceId: string, projectId: string): Promise<TLocalProjectKeyResponse> {
  const project = await liveProject(deps.q, ownerId, projectId);
  const now = deps.now();
  const expiresAt = new Date(now.getTime() + KEY_DAYS * 24 * 60 * 60_000);
  const client = await deps.pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`project-key:${ownerId}:${deviceId}:${projectId}`]);
    await client.query(`UPDATE personal_tokens SET revoked_at=$4 WHERE revoked_at IS NULL AND id IN
      (SELECT token_id FROM local_project_keys WHERE owner_id=$1 AND device_id=$2 AND project_id=$3)`, [ownerId, deviceId, projectId, now]);
    const token = await issueLocalToken(client, ownerId, `项目 · ${project.name}`, deps.pepper, now, { expiresAt });
    await client.query("INSERT INTO local_project_keys(token_id,owner_id,device_id,project_id,created_at) VALUES($1,$2,$3,$4,$5)",
      [token.id, ownerId, deviceId, projectId, now]);
    await client.query("COMMIT");
    return { token: token.token, expiresAt: expiresAt.toISOString(), mcpUrl: `${deps.publicOrigin.replace(/\/$/, "")}/mcp/me` };
  } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
}

// ───────────────────────── 占着 ─────────────────────────

/** 超过租期没心跳的那一轮放开（本机程序挂了）。 */
async function expireStale(q: Query, projectId: string, now: Date) {
  await q(`UPDATE project_local_turns SET status='expired',finished_at=$2 WHERE project_id=$1 AND status='running' AND heartbeat_at < $2::timestamptz - make_interval(secs => $3)`,
    [projectId, now, LEASE.expiresAfterSeconds]);
}

/** 本机正占着这段对话的那一轮：在跑的，或结束了还没写进 Chat 的（15 分钟以内）。 */
async function occupying(q: Query, projectId: string, now: Date): Promise<(TurnRow & { device_name: string | null }) | null> {
  await expireStale(q, projectId, now);
  return ((await q(`SELECT t.*,d.name AS device_name FROM project_local_turns t LEFT JOIN local_devices d ON d.owner_id=t.owner_id AND d.id=t.device_id
    WHERE t.project_id=$1 AND (t.status='running' OR (t.status IN ('completed','aborted','failed') AND t.recorded_at IS NULL AND t.finished_at > $2::timestamptz - make_interval(secs => $3)))
    ORDER BY t.started_at DESC LIMIT 1`, [projectId, now, PENDING_RECORD_MS / 1000])).rows[0] ?? null) as (TurnRow & { device_name: string | null }) | null;
}

/** 云端发消息前（网页、伙伴转来、子会话回报）：本机正占着就不发。 */
export async function localTurnBusy(q: Query, projectId: string, now: Date): Promise<boolean> {
  return Boolean(await occupying(q, projectId, now));
}

/** 读历史时给的本机那一轮（ConversationHistory.localTurn）。 */
export async function historyLocalTurn(q: Query, projectId: string, now: Date): Promise<TConversationLocalTurn | null> {
  const row = await occupying(q, projectId, now);
  return row ? { turnId: row.id, message: row.message, startedAt: row.started_at.toISOString(), deviceName: row.device_name ?? "本机",
    source: sourceLabel(row.agent, row.model_label) } : null;
}

/** 读历史时接到本机跑的那几轮回答上的：在哪跑、执行方和模型。 */
export async function localTurnExtras(q: Query, ownerId: string, runIds: string[]): Promise<Map<string, { ranOn: "local"; model: TConversationModel }>> {
  const ids = runIds.filter((id) => /^[0-9a-f-]{36}$/i.test(id));
  if (!ids.length) return new Map();
  const rows = (await q("SELECT id::text,agent,model_label FROM project_local_turns WHERE owner_id=$1 AND id=ANY($2::uuid[])", [ownerId, ids])).rows as
    { id: string; agent: TLocalProjectExecutor["agent"]; model_label: string }[];
  return new Map(rows.map((row) => [row.id, { ranOn: "local" as const, model: { provider: AGENT_NAME[row.agent], model: row.model_label } }]));
}

// ───────────────────────── 对话的几轮 ─────────────────────────

/** Chat 里这段对话已经结束的每一轮（从早到晚），带在哪跑、来源和做成的动作。 */
async function turnRecords(deps: LocalTurnDeps, chat: ChatService, ownerId: string, conversationId: string, requestId: string): Promise<TProjectTurnRecord[]> {
  const viewer = pipelineViewer(ownerId);
  type Page = Awaited<ReturnType<ChatService["messagesPage"]>>;
  const messages: Page["messages"] = [];
  let runs: Page["runs"] = [];
  for (let cursor: string | null = "0"; cursor !== null;) {
    const page: Page = await chat.messagesPage(viewer, requestId, conversationId, cursor);
    messages.push(...page.messages);
    runs = page.runs;
    cursor = page.nextCursor;
  }
  const done = runs.filter((run) => run.status !== "running");
  const ids = done.map((run) => run.runId);
  const [local, models, actions] = await Promise.all([
    localTurnExtras(deps.q, ownerId, ids),
    deps.q("SELECT run_id,model FROM chat_turn_models WHERE owner_id=$1 AND run_id=ANY($2::text[]) AND model IS NOT NULL", [ownerId, ids]),
    deps.q("SELECT run_id,summary FROM buddy_actions WHERE owner_id=$1 AND run_id=ANY($2::text[]) ORDER BY at,id", [ownerId, ids]),
  ]);
  const cloudModel = new Map((models.rows as { run_id: string; model: string }[]).map((row) => [row.run_id, row.model]));
  const done_ = new Map<string, string[]>();
  for (const row of actions.rows as { run_id: string; summary: string }[]) done_.set(row.run_id, [...(done_.get(row.run_id) ?? []), row.summary]);
  return done.map((run) => {
    const own = messages.filter((message) => message.runId === run.runId);
    const asked = own.find((message) => message.role === "user")?.text ?? "";
    const forwarded = asked.startsWith(BUDDY_FORWARD_PREFIX) ? { prefix: BUDDY_FORWARD_PREFIX, via: "buddy" as const }
      : asked.startsWith(SUB_SESSION_REPORT_PREFIX) ? { prefix: SUB_SESSION_REPORT_PREFIX, via: "report" as const } : null;
    const channel = own.find((message) => message.role === "user")?.channel;
    const via = forwarded?.via ?? (channel === "feishu" || channel === "wechat" ? channel : undefined);
    const ranLocal = local.get(run.runId);
    return {
      runId: run.runId, at: run.turnAt ?? new Date(0).toISOString(), ranOn: ranLocal ? "local" : "cloud",
      source: ranLocal ? `本机 · ${ranLocal.model.provider} · ${ranLocal.model.model}` : cloudModel.has(run.runId) ? `云端 · ${cloudModel.get(run.runId)}` : null,
      ...(via ? { via } : {}),
      user: forwarded ? asked.slice(forwarded.prefix.length) : asked,
      assistant: own.filter((message) => message.role === "assistant").map((message) => message.text).join("\n"),
      status: run.status === "aborted" || run.status === "failed" ? run.status : "completed",
      actions: done_.get(run.runId) ?? [],
    } satisfies TProjectTurnRecord;
  });
}

/** 最近几轮：最多 RECENT_TURNS 轮、总共约 RECENT_CHARS 字以内（至少一轮）。 */
function recentOf(records: TProjectTurnRecord[]): TProjectTurnRecord[] {
  const recent = records.slice(-RECENT_TURNS);
  const size = (turn: TProjectTurnRecord) => turn.user.length + turn.assistant.length;
  while (recent.length > 1 && recent.reduce((sum, turn) => sum + size(turn), 0) > RECENT_CHARS) recent.shift();
  return recent;
}

// ───────────────────────── 开始、心跳、结束 ─────────────────────────

async function startResponse(deps: LocalTurnDeps, chat: ChatService, row: TurnRow, requestId: string): Promise<TLocalProjectTurnStartResponse> {
  const records = (await turnRecords(deps, chat, row.owner_id, row.conversation_id, requestId)).filter((turn) => turn.runId !== row.id);
  const recent = recentOf(records);
  const path = `/api/me/projects/${encodeURIComponent(row.project_id)}`;
  const [detail, home] = await Promise.all([callAsPerson<TProjectDetailResponse>(deps.buddy, row.owner_id, "GET", path),
    callAsPerson<TWorkHomeResponse>(deps.buddy, row.owner_id, "GET", "/api/me/work-home")]);
  const subSessions: TSubSession[] = home.projects.find((project) => project.projectId === row.project_id)?.subSessions ?? [];
  return { turnId: row.id, scope: `project:${row.project_id}`, startedAt: row.started_at.toISOString(),
    context: { recent, earlier: records.length - recent.length, project: { ...detail, subSessions } }, rules: PROJECT_CONVERSATION_RULES, lease: LEASE };
}

/** 本机要开始一轮：占住这段对话（云端在回、别处占着时 409 TURN_IN_PROGRESS），回最近几轮、项目情况和共用规矩。 */
export async function startLocalTurn(deps: LocalTurnDeps, ownerId: string, deviceId: string, body: TLocalProjectTurnStartRequest, requestId: string):
  Promise<TLocalProjectTurnStartResponse> {
  const chat = deps.chat;
  if (!chat) throw new LocalTurnError(409, "CHAT_NOT_CONNECTED", "没接对话服务，这一轮存不下，请走云端");
  const hash = hashOf({ projectId: body.projectId, message: body.message, buddyQuestionId: body.buddyQuestionId ?? null, executor: body.executor });
  const existing = (await deps.q("SELECT * FROM project_local_turns WHERE owner_id=$1 AND client_turn_id=$2", [ownerId, body.clientTurnId])).rows[0] as TurnRow | undefined;
  if (existing) {
    if (existing.request_hash !== hash || existing.device_id !== deviceId) throw new LocalTurnError(409, "IDEMPOTENCY_CONFLICT", "同一个 clientTurnId 不能换内容");
    return startResponse(deps, chat, existing, requestId);
  }
  await liveProject(deps.q, ownerId, body.projectId);
  const { conversationId } = await ensureProjectPipeline({ pool: deps.pool, chat }, { personId: ownerId }, body.projectId, requestId);
  const now = deps.now();
  const client = await deps.pool.connect();
  let row: TurnRow;
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`project-turn:${body.projectId}`]);
    const q: Query = (sql, params) => client.query(sql, params);
    if (await occupying(q, body.projectId, now)) throw new LocalTurnError(409, "TURN_IN_PROGRESS", "这个项目对话正在本机回答上一句", { runningOn: "local" });
    const page = await chat.messagesPage(pipelineViewer(ownerId), requestId, conversationId, "0", 1);
    if (page.runs.some((run) => run.status === "running")) throw new LocalTurnError(409, "TURN_IN_PROGRESS", "这个项目对话正在云端回答上一句", { runningOn: "cloud" });
    row = (await client.query(`INSERT INTO project_local_turns(id,owner_id,project_id,device_id,client_turn_id,request_hash,conversation_id,message,agent,model_label,status,started_at,heartbeat_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,'running',$11,$11) RETURNING *`,
    [randomUUID(), ownerId, body.projectId, deviceId, body.clientTurnId, hash, conversationId, body.message, body.executor.agent, body.executor.modelLabel, now])).rows[0] as TurnRow;
    await client.query("COMMIT");
  } catch (cause) { await client.query("ROLLBACK").catch(() => undefined); throw cause; }
  finally { client.release(); }
  // 同云端发一句：选项框收掉（回答的那张标 answered）；接手人说了第一句；本人说了话，自动接力清零。
  await closeQuestions(deps.q, ownerId, `project:${body.projectId}`, body.buddyQuestionId, now);
  await ownerSpoke(deps.q, ownerId, body.projectId);
  await resetAutoRelay(deps.q, body.projectId);
  return startResponse(deps, chat, row, requestId);
}

/** 这台电脑的这一轮；不是的 404。超过租期没心跳的先放开。 */
async function deviceTurn(deps: LocalTurnDeps, ownerId: string, deviceId: string, turnId: string): Promise<TurnRow> {
  const found = /^[0-9a-f-]{36}$/i.test(turnId)
    ? (await deps.q("SELECT project_id::text FROM project_local_turns WHERE id=$1 AND owner_id=$2 AND device_id=$3", [turnId, ownerId, deviceId])).rows[0] as { project_id: string } | undefined
    : undefined;
  if (!found) throw new LocalTurnError(404, "NOT_FOUND", "没有这台电脑的这一轮");
  await expireStale(deps.q, found.project_id, deps.now());
  return (await deps.q("SELECT * FROM project_local_turns WHERE id=$1", [turnId])).rows[0] as TurnRow;
}

export async function heartbeatLocalTurn(deps: LocalTurnDeps, ownerId: string, deviceId: string, turnId: string): Promise<void> {
  const row = await deviceTurn(deps, ownerId, deviceId, turnId);
  if (row.status === "expired") throw new LocalTurnError(409, "LOCAL_TURN_EXPIRED", "太久没有心跳，这一轮已经放开了");
  if (row.status !== "running") throw new LocalTurnError(409, "LOCAL_TURN_FINISHED", "这一轮已经结束了");
  await deps.q("UPDATE project_local_turns SET heartbeat_at=$2 WHERE id=$1 AND status='running'", [turnId, deps.now()]);
}

/** 本机这一轮结束：记下结果，写进 Chat（写不进先回 recorded=false，后台隔几秒再写）。released 不写、当没发生。 */
export async function finishLocalTurn(deps: LocalTurnDeps, ownerId: string, deviceId: string, turnId: string, body: TLocalProjectTurnFinishRequest,
  requestId: string): Promise<TLocalProjectTurnFinishResponse> {
  const row = await deviceTurn(deps, ownerId, deviceId, turnId);
  if (row.status === "expired") throw new LocalTurnError(409, "LOCAL_TURN_EXPIRED", "太久没有心跳，这一轮已经放开了，回答不再写进对话");
  if (row.status !== "running") return { turnId, recorded: row.recorded_at !== null };
  if (body.status === "released" && !body.reason) throw new LocalTurnError(400, "INVALID_ARGS", "released 要带 reason");
  const finished = (await deps.q(`UPDATE project_local_turns SET status=$2,answer=$3,error_code=$4,reason=$5,finished_at=$6 WHERE id=$1 AND status='running' RETURNING *`,
    [turnId, body.status, body.status === "released" ? null : body.answer ?? "", body.errorCode ?? null, body.reason ?? null, deps.now()])).rows[0] as TurnRow | undefined;
  if (!finished) return { turnId, recorded: false };
  if (body.status === "released") return { turnId, recorded: false };
  // 这一轮的计划清单收起（同云端一轮结束），网页读回历史时拿到。失败只记日志，不连累写回答。
  await collapsePlan(deps.q, turnId).catch((error) => logEvent({ event: "local_turn.collapse_plan_failed", requestId, turnId, error: (error as Error)?.message }));
  if (await recordOnce(deps, finished, requestId)) return { turnId, recorded: true };
  recordLater(deps, finished, requestId);
  return { turnId, recorded: false };
}

/** 写进 Chat 一次：成了记下时间、项目亮蓝点（有回答时）；Chat 正在回答或连不上返回 false。 */
async function recordOnce(deps: LocalTurnDeps, row: TurnRow, requestId: string): Promise<boolean> {
  const actions = ((await deps.q("SELECT action,summary FROM buddy_actions WHERE owner_id=$1 AND run_id=$2 ORDER BY at,id", [row.owner_id, row.id])).rows as
    { action: string; summary: string }[]).slice(0, 50).map((action) => ({ name: action.action.slice(0, 60), summary: action.summary.slice(0, 300) }));
  try {
    await deps.chat!.recordTurn(pipelineViewer(row.owner_id), requestId, row.conversation_id, {
      runId: row.id, clientRequestId: `local:${row.id}`, message: row.message, answer: row.answer ?? "",
      status: row.status as "completed" | "aborted" | "failed", ...(row.error_code ? { errorCode: row.error_code.slice(0, 60) } : {}),
      startedAt: row.started_at.toISOString(), finishedAt: (row.finished_at ?? row.started_at).toISOString(),
      source: { kind: "local", label: sourceLabel(row.agent, row.model_label).slice(0, 80) }, actions });
  } catch (cause) {
    if (cause instanceof ChatServiceError && ["TURN_IN_PROGRESS", "CHAT_UNAVAILABLE", "CHAT_FAILED"].includes(cause.code)) return false;
    throw cause;
  }
  await deps.q("UPDATE project_local_turns SET recorded_at=$2 WHERE id=$1", [row.id, deps.now()]);
  if ((row.answer ?? "").trim()) await recordProjectReply(deps.q, row.project_id, deps.now());
  return true;
}

function recordLater(deps: LocalTurnDeps, row: TurnRow, requestId: string): void {
  void (async () => {
    const startedAt = Date.now();
    while (Date.now() - startedAt < RECORD_GIVE_UP_MS) {
      await new Promise((resolve) => setTimeout(resolve, RECORD_RETRY_MS));
      if (await recordOnce(deps, row, requestId)) return;
    }
    logEvent({ event: "local_turn.record_gave_up", requestId, turnId: row.id });
  })().catch((error) => logEvent({ event: "local_turn.record_failed", requestId, turnId: row.id, error: (error as Error)?.message }));
}

// ───────────────────────── 项目会话的天枢 MCP 工具 ─────────────────────────

const READ_EARLIER_TOOL: Tool = { name: READ_EARLIER_CONVERSATION_TOOL,
  description: "读这个项目对话更早的几轮（开始时只带了最近几轮）。beforeRunId 之前的 turns 轮（默认 10，最多 20），不带 beforeRunId 从最新一轮往前读；回 turns（从早到晚）和再往前还有几轮 earlier。",
  inputSchema: ReadEarlierConversationParams as Tool["inputSchema"], annotations: { readOnlyHint: true } };
const PROJECT_ACTIONS = new Set<string>(PROJECT_MCP_ACTIONS);

/** 项目钥匙在 MCP 里多出的工具：照本人的伙伴授权（没完全授权时不列写的）。 */
export async function projectToolDefinitions(q: Query, personId: string): Promise<Tool[]> {
  const actions = actionList(await readAuthority(q, personId), true).filter((action) => PROJECT_ACTIONS.has(action.name));
  return [...actions.map((action): Tool => ({ name: action.name, description: action.description, inputSchema: action.parameters as Tool["inputSchema"],
    ...(action.kind === "read" ? { annotations: { readOnlyHint: true } } : {}) })), READ_EARLIER_TOOL];
}
export const isProjectTool = (name: string) => PROJECT_ACTIONS.has(name) || name === READ_EARLIER_CONVERSATION_TOOL;

/** 执行一个项目工具：伙伴动作照云端项目对话执行（这一轮是这个项目正占着的本机那一轮），带回这一下出的卡、清单和界面要跟着变的。 */
export async function callProjectTool(deps: LocalTurnDeps, who: { personId: string; projectId: string }, tool: string, args: unknown, requestId: string):
  Promise<{ value: TProjectMcpToolResult | TReadEarlierConversationResult | { code: string; message: string }; isError: boolean }> {
  try {
    if (tool === READ_EARLIER_CONVERSATION_TOOL) {
      if (!Value.Check(ReadEarlierConversationParams, args)) return { value: { code: "INVALID_ARGS", message: "参数不对：beforeRunId 是轮次 id，turns 是 1 到 20" }, isError: true };
      const conversationId = await projectPipelineConversation(deps.q, who.projectId, who.personId);
      if (!conversationId || !deps.chat) return { value: { turns: [], earlier: 0 }, isError: false };
      const records = await turnRecords(deps, deps.chat, who.personId, conversationId, requestId);
      const before = args.beforeRunId ? records.findIndex((turn) => turn.runId === args.beforeRunId) : records.length;
      const end = before < 0 ? records.length : before;
      const start = Math.max(0, end - (args.turns ?? 10));
      return { value: { turns: records.slice(start, end), earlier: start }, isError: false };
    }
    const conversationId = deps.chat ? (await ensureProjectPipeline({ pool: deps.pool, chat: deps.chat }, { personId: who.personId }, who.projectId, requestId)).conversationId
      : await projectPipelineConversation(deps.q, who.projectId, who.personId);
    const runId = ((await deps.q("SELECT id::text FROM project_local_turns WHERE project_id=$1 AND owner_id=$2 AND status='running'", [who.projectId, who.personId])).rows[0]
      ?.id ?? null) as string | null;
    let card: TConversationCard | undefined;
    let plan: TBuddyPlan | undefined;
    const ui: TBuddyUiEffect[] = [];
    const stream: BuddyDeps["stream"] = (_runId, event) => {
      if (event.type === "card") card = event.card as TConversationCard;
      if (event.type === "plan") plan = event.plan as TBuddyPlan;
      if (event.type === "ui") ui.push(event.ui as TBuddyUiEffect);
      return true;
    };
    const outcome = await runAction({ ...deps.buddy, stream }, { personId: who.personId, conversationId, runId }, tool, args);
    return { value: { ...outcome, ...(card ? { card } : {}), ...(plan ? { plan } : {}), ...(ui.length ? { ui } : {}) }, isError: false };
  } catch (cause) {
    if (cause instanceof BuddyError || cause instanceof LocalTurnError || cause instanceof ChatServiceError) return { value: { code: cause.code, message: cause.message }, isError: true };
    throw cause;
  }
}
