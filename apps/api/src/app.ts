import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Type, type Static, type TSchema } from "@sinclair/typebox";
import { Value } from "@sinclair/typebox/value";
type ValidationItem = { instancePath?: string; dataPath?: string; message?: string };
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { Pool } from "pg";
import {
  ConversationMessageRequest,
  ConversationScope,
  CreateMeetingRequest,
  DriIssueImportRequest,
  DriMeetingImportRequest,
  ExecuteActionRequest,
  HealthResponse,
  JoinMeetingRequest,
  LoginRequest,
  RadarScanResponse,
  RequestSupplementRequest,
  SessionResponse,
  SignalStateRequest,
  UpdateMeetingDraftRequest,
  type TApiError,
  type TCardCollection,
} from "@warmap/contracts";
import rateLimit from "@fastify/rate-limit";
import {
  SESSION_COOKIE,
  parseCookies,
  sessionClearCookie,
  sessionSetCookie,
  verifyPassword,
  verifySessionToken,
} from "./session.js";
import { getFixtureHome, projectHomeCard } from "./fixture.js";
import { actionFingerprint, verifyActionId } from "./actionToken.js";
import { executeDismissNotice } from "./actions.js";
import { loadCompanyMemory, type CompanyMemorySeedEnv } from "./companyMemory.js";
import { createCompanyMemoryMcpSession } from "./mcpCompanyMemory.js";
import { createPiConversationRuntime } from "./piConversationRuntime.js";
import {
  getConversationHistory,
  getFixtureObject,
  getScopeObject,
  projectFixtureObjectCard,
  resolveReferenceSnapshots,
  type ConversationRuntime,
} from "./conversations.js";
import type { RadarService } from "./radar.js";
import { getSignalCard, listSignalCards, projectRadarCard, setSignalState } from "./signals.js";
import { getIssueRow, executeIssueAction, importDriIssue, listPendingRedIssueCards, projectIssueCard } from "./issues.js";
import type { ResearchService } from "./research.js";
import {
  executeCancelMeeting,
  executeCreateMeeting,
  executeJoinMeeting,
  executeRequestSupplement,
  executeRetryPreflight,
  executeUpdateDraft,
  getMeetingRow,
  importDriMeeting,
  listMeetingRows,
  projectMeetingCard,
  type DriExporter,
  type MeetingActionOutcome,
  type PreflightAgent,
} from "./meetings.js";
import { createPreflightAgent } from "./preflightAgent.js";

export const CONVERSATION_TURN_TIMEOUT_MS = 180_000;

export type AppEnv = {
  sessionSecret: string;
  ceoPasswordHash: string;
  sessionMaxAgeSeconds: number;
  publicOrigin: string;
  driServiceToken: string;
  mcpServiceToken: string;
  buildSha: string;
  piBaseUrl: string;
  piApiKey: string;
  lightModel: string;
  heavyModel: string;
  compactionModel: string;
} & CompanyMemorySeedEnv;

export async function buildApp({
  pool,
  env,
  conversationRuntime,
  radarService,
  researchService,
  preflightAgent,
  driExporter,
  conversationTurnTimeoutMs = CONVERSATION_TURN_TIMEOUT_MS,
}: {
  pool: Pool;
  env: AppEnv;
  conversationRuntime?: ConversationRuntime;
  radarService?: RadarService;
  researchService?: ResearchService;
  preflightAgent?: PreflightAgent;
  driExporter?: DriExporter;
  conversationTurnTimeoutMs?: number;
}): Promise<FastifyInstance> {
  // seed 缺失/不合规 → 启动即失败，不虚构人员或空目录（Ticket 16 装载真实 seed）
  const companyMemory = loadCompanyMemory(env);
  const preflight = preflightAgent ?? createPreflightAgent({
    query: pool.query.bind(pool),
    baseUrl: env.piBaseUrl,
    apiKey: env.piApiKey,
    modelId: env.lightModel,
  });
  const runtime = conversationRuntime ?? await createPiConversationRuntime({
    companyMemory,
    baseUrl: env.piBaseUrl,
    apiKey: env.piApiKey,
    modelId: env.lightModel,
    compactionModelId: env.compactionModel,
  });
  const radar = radarService ?? {
    providerStatus: { web: false, wechat: false },
    async recoverStaleRuns() {},
    runManual: async () => ({ trigger: "manual" as const, status: "failed" as const, companyDay: new Date().toISOString().slice(0, 10), createdSignals: 0, warnings: ["Radar providers are not configured"] }),
    runScheduled: async () => ({ trigger: "scheduled" as const, status: "failed" as const, companyDay: new Date().toISOString().slice(0, 10), createdSignals: 0, warnings: ["Radar providers are not configured"] }),
  };
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  // 未注入真实 Runner 时不虚构预研：Issue 保留 pending，等显式配置
  const research = researchService ?? {
    async start() {},
    async executeRun() {},
    async idle() {},
  };
  app.addHook("onClose", async () => {
    await research.idle();
    await runtime.close?.();
  });
  const q = pool.query.bind(pool);

  // ponytail: 登录限速用进程内计数器，单进程 MVP 足够；多实例部署时换共享存储
  await app.register(rateLimit, { global: false });

  function fail(
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
    extra?: Partial<TApiError>,
  ): FastifyReply {
    return reply.status(status).send({ code, message, retryable: false, requestId: reply.request.id, ...extra });
  }

  /** CEO 浏览器写请求边界：session + 同源 Origin（CSRF）。 */
  function requireCEO(req: FastifyRequest, reply: FastifyReply, done: () => void): void {
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    if (!verifySessionToken(env.sessionSecret, cookie)) {
      fail(reply, 401, "UNAUTHORIZED", "未登录");
      return;
    }
    if (req.method !== "GET" && req.headers.origin !== env.publicOrigin) {
      fail(reply, 403, "ORIGIN_MISMATCH", "Origin 不符");
      return;
    }
    done();
  }

  /** 服务身份边界：独立 bearer token，与 CEO session 不可互换。 */
  function requireServiceToken(expected: string) {
    return (req: FastifyRequest, reply: FastifyReply, done: () => void): void => {
      const header = req.headers.authorization ?? "";
      const token = header.startsWith("Bearer ") ? header.slice(7) : "";
      const a = Buffer.from(token);
      const b = Buffer.from(expected);
      if (a.length !== b.length || !timingSafeEqual(a, b)) {
        fail(reply, 401, "UNAUTHORIZED", "无效服务凭据");
        return;
      }
      done();
    };
  }

  function invalidInput(reply: FastifyReply, schema: TSchema, input: unknown): FastifyReply {
    const fieldErrors: Record<string, string> = {};
    for (const error of Value.Errors(schema, input)) {
      fieldErrors[(error.path || "/").replace(/^\//, "") || "input"] = error.message;
    }
    return fail(reply, 400, "INVALID_INPUT", "输入校验失败", { fieldErrors });
  }

  /** Action 结果 → HTTP：error 用统一 ApiError，version 冲突携带 latestCard，成功返回新 Card。 */
  function respond(reply: FastifyReply, outcome: MeetingActionOutcome): TCardCollection | FastifyReply {
    if ("error" in outcome) {
      return fail(reply, outcome.error.status, outcome.error.code, outcome.error.message, outcome.error.fieldErrors ? { fieldErrors: outcome.error.fieldErrors } : undefined);
    }
    if (outcome.conflict) {
      return fail(reply, 409, "VERSION_CONFLICT", "对象已被修改，请基于最新 Card 重试", { latestCard: outcome.latestCard });
    }
    return { cards: [outcome.card] };
  }

  app.setErrorHandler((rawErr, req, reply) => {
    const err = rawErr as FastifyError & { validation?: ValidationItem[] };
    if (err.statusCode === 429) {
      return fail(reply, 429, "RATE_LIMITED", "尝试过于频繁，请稍后再试");
    }
    const validation = err.validation;
    if (validation) {
      const fieldErrors: Record<string, string> = {};
      for (const v of validation) {
        fieldErrors[(v.instancePath ?? v.dataPath ?? "/").replace(/^\//, "") || "body"] = v.message ?? "invalid";
      }
      return fail(reply, 400, "INVALID_INPUT", "输入校验失败", { fieldErrors });
    }
    if (err.statusCode && err.statusCode >= 400 && err.statusCode < 500) {
      const body = err as unknown as TApiError;
      if (body.code) return reply.status(err.statusCode).send(body);
    }
    return fail(reply, 500, "INTERNAL", "服务内部错误");
  });

  app.setNotFoundHandler((_req, reply) => fail(reply, 404, "NOT_FOUND", "路径不存在"));

  app.post(
    "/api/auth/login",
    {
      preHandler: (req, reply, done) => {
        if (req.headers.origin !== env.publicOrigin) {
          fail(reply, 403, "ORIGIN_MISMATCH", "Origin 不符");
          return;
        }
        done();
      },
      config: { rateLimit: { max: 5, timeWindow: "1 minute" } },
      schema: { body: LoginRequest },
    },
    async (req, reply) => {
      if (!verifyPassword(env.ceoPasswordHash, req.body.password)) {
        return fail(reply, 401, "INVALID_CREDENTIALS", "密码错误");
      }
      reply.header(
        "set-cookie",
        sessionSetCookie(env.sessionSecret, env.sessionMaxAgeSeconds),
      );
      return { authenticated: true };
    },
  );

  app.post(
    "/api/auth/logout",
    { preHandler: requireCEO },
    async (_req, reply) => {
      reply.header("set-cookie", sessionClearCookie());
      return { authenticated: false };
    },
  );

  app.get("/api/auth/session", { schema: { response: { 200: SessionResponse } } }, async (req) => {
    const cookie = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    return { authenticated: verifySessionToken(env.sessionSecret, cookie) };
  });

  app.get("/api/cards/home", { preHandler: requireCEO }, async (_req, reply): Promise<TCardCollection> => {
    const row = await getFixtureHome(q);
    // 通知投影只读同一 issues 表：pending + red 的 Issue Card 与详情页完全同源
    const notifications = await listPendingRedIssueCards(q, env.sessionSecret);
    return { cards: [projectHomeCard(row, env.sessionSecret), ...notifications] };
  });

  const idParams = Type.Object({ id: Type.String({ minLength: 1 }) }, { additionalProperties: false });

  app.get("/api/cards/radar", { preHandler: requireCEO }, async (): Promise<TCardCollection> => ({
    cards: [await projectRadarCard(q, radar.providerStatus)],
  }));

  app.get("/api/cards/signals", { preHandler: requireCEO }, async (): Promise<TCardCollection> => ({
    cards: await listSignalCards(q),
  }));

  app.get(
    "/api/cards/signals/:id",
    { preHandler: requireCEO, schema: { params: idParams } },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const card = await getSignalCard(q, req.params.id);
      return card ? { cards: [card] } : fail(reply, 404, "CARD_NOT_FOUND", "Card 不存在");
    },
  );

  app.patch(
    "/api/signals/:id/state",
    { preHandler: requireCEO, schema: { params: idParams, body: SignalStateRequest } },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const card = await setSignalState(q, req.params.id, req.body);
      return card ? { cards: [card] } : fail(reply, 404, "CARD_NOT_FOUND", "Signal 不存在");
    },
  );

  app.post(
    "/api/radar/scans/manual",
    { preHandler: requireCEO, schema: { response: { 200: RadarScanResponse } } },
    async (_req, reply) => {
      const result = await radar.runManual();
      if (result.status === "busy") return fail(reply, 409, "RADAR_SCAN_IN_PROGRESS", "Radar 正在运行");
      return result;
    },
  );

  const conversationParams = Type.Object({ scope: ConversationScope }, { additionalProperties: false });

  app.get(
    "/api/conversations/:scope/messages",
    { preHandler: requireCEO, schema: { params: conversationParams } },
    async (req, reply) => {
      const object = await getScopeObject(q, req.params.scope, env.sessionSecret);
      if (!object.visible) return fail(reply, 404, "CONVERSATION_SCOPE_NOT_FOUND", "Conversation scope 不存在");
      return getConversationHistory(q, req.params.scope);
    },
  );

  app.post(
    "/api/conversations/:scope/messages",
    {
      preHandler: requireCEO,
      schema: { params: conversationParams, body: ConversationMessageRequest },
    },
    async (req, reply) => {
      const object = await getScopeObject(q, req.params.scope, env.sessionSecret);
      if (!object.visible) return fail(reply, 404, "CONVERSATION_SCOPE_NOT_FOUND", "Conversation scope 不存在");
      const references = await resolveReferenceSnapshots(q, req.body.references ?? [], env.sessionSecret);
      if (!("snapshots" in references)) {
        return fail(reply, references.status, references.code, references.message);
      }

      const client = await pool.connect();
      const locked = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [req.params.scope]);
      if (!locked.rows[0]?.locked) {
        client.release();
        return fail(reply, 409, "TURN_IN_PROGRESS", "该 Conversation 正在运行");
      }

      const runId = randomUUID();
      const abort = new AbortController();
      let streamFinished = false;
      let eventSequence = 0;
      try {
        const conversationId = randomUUID();
        const piSessionId = randomUUID();
        await client.query(
          `INSERT INTO conversations (id, scope, pi_session_id)
           VALUES ($1, $2, $3)
           ON CONFLICT (scope) DO NOTHING`,
          [conversationId, req.params.scope, piSessionId],
        );
        const conversation = await client.query<{ id: string; pi_session_id: string; runtime_entries: unknown[] }>(
          "SELECT id, pi_session_id, runtime_entries FROM conversations WHERE scope = $1",
          [req.params.scope],
        );
        const row = conversation.rows[0];
        const next = await client.query<{ sequence: number }>(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
             FROM conversation_messages WHERE conversation_id = $1`,
          [row.id],
        );
        const userSequence = next.rows[0].sequence;
        await client.query(
          `INSERT INTO conversation_messages
             (conversation_id, sequence, role, content, references_snapshot, run_id)
           VALUES ($1, $2, 'user', $3, $4::jsonb, $5)`,
          [row.id, userSequence, req.body.message, JSON.stringify(references.snapshots), runId],
        );
        const recent = await client.query<{ role: "user" | "assistant"; content: string; created_at: Date }>(
          `SELECT role, content, created_at
             FROM conversation_messages
            WHERE conversation_id = $1 AND run_id <> $2
            ORDER BY sequence DESC LIMIT 20`,
          [row.id, runId],
        );
        await client.query(
          `INSERT INTO agent_runs (id, kind, object_ref, status, model_slot, prompt_hash, input_snapshot)
           VALUES ($1, 'conversation', $2::jsonb, 'running', $3, $4, $5::jsonb)`,
          [
            runId,
            JSON.stringify(object.snapshot?.objectRef ?? null),
            runtime.modelSlot ?? "light",
            runtime.promptHash ?? createHash("sha256").update("conversation-runtime").digest("hex"),
            JSON.stringify({
              scope: req.params.scope,
              message: req.body.message,
              currentObject: object.snapshot,
              references: references.snapshots,
            }),
          ],
        );

        reply.hijack();
        reply.raw.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        reply.raw.on("close", () => {
          if (!streamFinished) abort.abort(Object.assign(new Error("Conversation client disconnected"), { code: "CLIENT_DISCONNECTED" }));
        });
        let runUsage: Record<string, unknown> | null = null;
        const emit = (event: Record<string, unknown>) => {
          if (event.type === "usage") {
            const { type: _type, ...usage } = event;
            runUsage = usage;
          }
          if (reply.raw.destroyed) return;
          const data = { ...event, runId, scope: req.params.scope, sequence: ++eventSequence };
          reply.raw.write(`event: ${String(event.type)}\ndata: ${JSON.stringify(data)}\n\n`);
        };

        const timeout = setTimeout(() => {
          abort.abort(Object.assign(new Error("Conversation turn exceeded 180 seconds"), { code: "TURN_TIMEOUT" }));
        }, conversationTurnTimeoutMs);
        timeout.unref();
        try {
          const result = await runtime.run({
            scope: req.params.scope,
            message: req.body.message,
            currentObject: object.snapshot,
            referencesSnapshot: references.snapshots,
            recentMessages: recent.rows.reverse().map((message) => ({
              role: message.role,
              content: message.content,
              createdAt: message.created_at.toISOString(),
            })),
            runtimeEntries: row.runtime_entries,
            piSessionId: row.pi_session_id,
            signal: abort.signal,
            emit,
            checkpoint: async (runtimeEntries) => {
              await client.query(
                "UPDATE conversations SET runtime_entries = $2::jsonb, runtime_updated_at = now() WHERE id = $1",
                [row.id, JSON.stringify(runtimeEntries)],
              );
            },
          });
          if (abort.signal.aborted) {
            const reason = abort.signal.reason as { code?: string; message?: string } | undefined;
            await client.query(
              "UPDATE agent_runs SET status = 'aborted', error = $2, usage = $3::jsonb, completed_at = now() WHERE id = $1",
              [runId, reason?.message ?? "Conversation aborted", JSON.stringify(runUsage)],
            );
            if (reason?.code === "TURN_TIMEOUT") emit({ type: "error", code: "TURN_TIMEOUT", message: reason.message });
            else emit({ type: "done", status: "aborted" });
          } else {
            await client.query("BEGIN");
            await client.query(
              `INSERT INTO conversation_messages
                 (conversation_id, sequence, role, content, references_snapshot, run_id)
               VALUES ($1, $2, 'assistant', $3, '[]'::jsonb, $4)`,
              [row.id, userSequence + 1, result.assistantMessage, runId],
            );
            await client.query(
              `UPDATE conversations
                  SET runtime_entries = $2::jsonb,
                      pi_session_id = $3,
                      runtime_updated_at = now(),
                      recreated_at = CASE WHEN $4::boolean THEN now() ELSE recreated_at END,
                      runtime_warning = COALESCE($5, runtime_warning)
                WHERE id = $1`,
              [
                row.id,
                JSON.stringify(result.runtimeEntries),
                result.piSessionId ?? row.pi_session_id,
                result.recovery?.recreated === true,
                result.recovery?.warning ?? null,
              ],
            );
            await client.query(
              `UPDATE agent_runs
                  SET status = 'succeeded', candidate_output = $2::jsonb, usage = $3::jsonb, completed_at = now()
                WHERE id = $1`,
              [runId, JSON.stringify({ assistantMessage: result.assistantMessage }), JSON.stringify(runUsage)],
            );
            await client.query("COMMIT");
            emit({ type: "done", status: "completed" });
          }
        } catch (err) {
          await client.query("ROLLBACK").catch(() => undefined);
          const reason = abort.signal.reason as { code?: string; message?: string } | undefined;
          await client.query(
            "UPDATE agent_runs SET status = $2, error = $3, usage = $4::jsonb, completed_at = now() WHERE id = $1",
            [
              runId,
              abort.signal.aborted ? "aborted" : "failed",
              reason?.message ?? (err as Error).message ?? "Pi Runtime 失败",
              JSON.stringify(runUsage),
            ],
          );
          if (reason?.code === "TURN_TIMEOUT") {
            emit({ type: "error", code: "TURN_TIMEOUT", message: reason.message ?? "Conversation turn exceeded 180 seconds" });
          } else if (!abort.signal.aborted) {
            const code = (err as { code?: string }).code === "SEARCH_BUDGET_EXHAUSTED"
              ? "SEARCH_BUDGET_EXHAUSTED"
              : "RUNTIME_FAILED";
            emit({ type: "error", code, message: (err as Error).message || "Pi Runtime 失败" });
          }
        } finally {
          clearTimeout(timeout);
        }
        streamFinished = true;
        reply.raw.end();
      } finally {
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [req.params.scope]).catch(() => undefined);
        client.release();
      }
    },
  );

  app.get(
    "/api/cards/issues/:id",
    {
      preHandler: requireCEO,
      schema: { params: idParams },
    },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      // 默认只读：真实 Issue 优先，Ticket 04 的 fixture 仅在迁移期兼容
      const issue = await getIssueRow(q, req.params.id);
      if (issue) return { cards: [projectIssueCard(issue, env.sessionSecret)] };
      const row = await getFixtureObject(q, "issue", req.params.id);
      if (!row?.visible_to_ceo) return fail(reply, 404, "CARD_NOT_FOUND", "Card 不存在");
      return { cards: [projectFixtureObjectCard(row)] };
    },
  );

  app.get("/api/cards/meetings", { preHandler: requireCEO }, async (): Promise<TCardCollection> => {
    const rows = await listMeetingRows(q);
    return { cards: rows.map((row) => projectMeetingCard(row, env.sessionSecret)) };
  });

  app.get(
    "/api/cards/meetings/:id",
    { preHandler: requireCEO, schema: { params: idParams } },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const meeting = await getMeetingRow(q, req.params.id);
      return meeting ? { cards: [projectMeetingCard(meeting, env.sessionSecret)] } : fail(reply, 404, "CARD_NOT_FOUND", "Card 不存在");
    },
  );

  // 会前通知与 Meeting 详情是同一 projector 的投影，不保存第二份 Meeting。
  app.get("/api/cards/notifications", { preHandler: requireCEO }, async (): Promise<TCardCollection> => {
    const rows = (await listMeetingRows(q)).filter((row) => row.status === "scheduled");
    return { cards: rows.map((row) => projectMeetingCard(row, env.sessionSecret)) };
  });

  app.post(
    "/api/actions/execute",
    { preHandler: requireCEO, schema: { body: ExecuteActionRequest } },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const scope = verifyActionId(env.sessionSecret, req.body.actionId);
      if (!scope) {
        return fail(reply, 404, "UNKNOWN_ACTION", "无效 actionId");
      }
      const fingerprint = actionFingerprint(env.sessionSecret, req.body.actionId, req.body.input);
      const input = req.body.input;

      // Ticket 09：Issue 侧 Meeting Action 先于 Ticket 08 的通用 Issue Action 分派
      if (scope.actionType === "issue.create_meeting") {
        if (!Value.Check(CreateMeetingRequest, input)) return invalidInput(reply, CreateMeetingRequest, input);
        return respond(reply, await executeCreateMeeting(pool, companyMemory, preflight, env.sessionSecret, scope, input, fingerprint));
      }
      if (scope.actionType === "issue.join_meeting") {
        if (!Value.Check(JoinMeetingRequest, input)) return invalidInput(reply, JoinMeetingRequest, input);
        return respond(reply, await executeJoinMeeting(pool, companyMemory, preflight, env.sessionSecret, scope, input, fingerprint));
      }
      if (scope.actionType === "meeting.update_draft") {
        if (!Value.Check(UpdateMeetingDraftRequest, input)) return invalidInput(reply, UpdateMeetingDraftRequest, input);
        return respond(reply, await executeUpdateDraft(pool, env.sessionSecret, scope, input, fingerprint));
      }
      if (scope.actionType === "meeting.request_supplement") {
        if (!Value.Check(RequestSupplementRequest, input)) return invalidInput(reply, RequestSupplementRequest, input);
        return respond(reply, await executeRequestSupplement(pool, companyMemory, driExporter, env.sessionSecret, scope, input, fingerprint));
      }
      if (scope.actionType === "meeting.cancel") {
        return respond(reply, await executeCancelMeeting(pool, env.sessionSecret, scope, fingerprint));
      }
      if (scope.actionType === "meeting.retry_preflight") {
        return respond(reply, await executeRetryPreflight(pool, companyMemory, preflight, env.sessionSecret, scope, fingerprint));
      }

      if (scope.objectType === "issue") {
        const result = await executeIssueAction(pool, env.sessionSecret, scope, fingerprint, req.body.input);
        if (!result.ok) {
          return fail(reply, result.status, result.code, result.message, result.latestCard ? { latestCard: result.latestCard } : undefined);
        }
        // 重跑已进入 running：提交后异步执行，不阻塞返回
        if (result.startResearch) {
          research.executeRun(result.startResearch.issueId, result.startResearch.runId)
            .catch((err) => console.error("research run failed", err));
        }
        return { cards: [result.card] };
      }
      if (scope.objectType !== "home") {
        return fail(reply, 404, "UNKNOWN_ACTION", "未注册的 actionType");
      }
      if (scope.actionType !== "home.dismiss_notice") {
        return fail(reply, 404, "UNKNOWN_ACTION", "未注册的 actionType");
      }
      const result = await executeDismissNotice(pool, env.sessionSecret, scope, fingerprint);
      if (result.conflict) {
        return fail(reply, 409, "VERSION_CONFLICT", "对象已被修改，请基于最新 Card 重试", {
          latestCard: result.latestCard,
        });
      }
      return { cards: [result.card] };
    },
  );

  app.get("/healthz", { schema: { response: { 200: HealthResponse } } }, async (): Promise<Static<typeof HealthResponse>> => {
    let database = true;
    try {
      await q("SELECT 1");
    } catch {
      database = false;
    }
    const status: Static<typeof HealthResponse>["status"] = database ? "ok" : "degraded";
    return { status, database, buildSha: env.buildSha };
  });

  // CompanyMemory MCP：独立服务凭据，只读（ADR-0004/0013）；GET/DELETE 会话协商由无状态 transport 拒绝。
  app.post(
    "/mcp/company-memory",
    { preHandler: requireServiceToken(env.mcpServiceToken) },
    async (req, reply) => {
      reply.hijack();
      const { server, transport } = await createCompanyMemoryMcpSession(companyMemory);
      reply.raw.on("close", () => {
        void server.close();
      });
      await transport.handleRequest(req.raw, reply.raw, req.body);
    },
  );
  app.post(
    "/api/dri/issues",
    // 服务身份用 onRequest：未鉴权调用先得到 401，而不是从 400 推断字段
    { onRequest: requireServiceToken(env.driServiceToken), schema: { body: DriIssueImportRequest } },
    async (req, reply) => {
      const result = await importDriIssue(pool, companyMemory, req.body, env.sessionSecret);
      if ("code" in result) {
        return fail(reply, result.status, result.code, result.message, result.fieldErrors ? { fieldErrors: result.fieldErrors } : undefined);
      }
      // 创建后立即展示，随后启动唯一深度预研；不阻塞响应，也不让 rejection 终止进程
      if (result.status === 201) {
        research.start(result.card.objectRef.id).catch((err) => console.error("research start failed", err));
      }
      return reply.status(result.status).send({ cards: [result.card] });
    },
  );
  app.post(
    "/api/dri/meetings",
    { onRequest: requireServiceToken(env.driServiceToken), schema: { body: DriMeetingImportRequest } },
    async (req, reply) => {
      const result = await importDriMeeting(pool, companyMemory, preflight, env.sessionSecret, req.body);
      if ("code" in result) {
        return fail(reply, result.status, result.code, result.message, result.fieldErrors ? { fieldErrors: result.fieldErrors } : undefined);
      }
      return reply.status(result.status).send({ cards: [result.card] });
    },
  );

  return app;
}
