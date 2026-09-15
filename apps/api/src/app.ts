import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { createHash, randomUUID, timingSafeEqual } from "node:crypto";
import { Type, type Static } from "@sinclair/typebox";
type ValidationItem = { instancePath?: string; dataPath?: string; message?: string };
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { Pool } from "pg";
import {
  ConversationMessageRequest,
  ConversationScope,
  ExecuteActionRequest,
  HealthResponse,
  LoginRequest,
  SessionResponse,
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
  compactionModel: string;
} & CompanyMemorySeedEnv;

export async function buildApp({
  pool,
  env,
  conversationRuntime,
  conversationTurnTimeoutMs = CONVERSATION_TURN_TIMEOUT_MS,
}: {
  pool: Pool;
  env: AppEnv;
  conversationRuntime?: ConversationRuntime;
  conversationTurnTimeoutMs?: number;
}): Promise<FastifyInstance> {
  // seed 缺失/不合规 → 启动即失败，不虚构人员或空目录（Ticket 16 装载真实 seed）
  const companyMemory = loadCompanyMemory(env);
  const runtime = conversationRuntime ?? await createPiConversationRuntime({
    companyMemory,
    baseUrl: env.piBaseUrl,
    apiKey: env.piApiKey,
    modelId: env.lightModel,
    compactionModelId: env.compactionModel,
  });
  const app = Fastify({ logger: false }).withTypeProvider<TypeBoxTypeProvider>();
  app.addHook("onClose", async () => runtime.close?.());
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
    return { cards: [projectHomeCard(row, env.sessionSecret)] };
  });

  const conversationParams = Type.Object({ scope: ConversationScope }, { additionalProperties: false });

  app.get(
    "/api/conversations/:scope/messages",
    { preHandler: requireCEO, schema: { params: conversationParams } },
    async (req, reply) => {
      const object = await getScopeObject(q, req.params.scope);
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
      const object = await getScopeObject(q, req.params.scope);
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
      schema: { params: Type.Object({ id: Type.String({ minLength: 1 }) }, { additionalProperties: false }) },
    },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const row = await getFixtureObject(q, "issue", req.params.id);
      if (!row?.visible_to_ceo) return fail(reply, 404, "CARD_NOT_FOUND", "Card 不存在");
      return { cards: [projectFixtureObjectCard(row)] };
    },
  );

  app.post(
    "/api/actions/execute",
    { preHandler: requireCEO, schema: { body: ExecuteActionRequest } },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const scope = verifyActionId(env.sessionSecret, req.body.actionId);
      if (!scope || scope.objectType !== "home") {
        return fail(reply, 404, "UNKNOWN_ACTION", "无效 actionId");
      }
      if (scope.actionType !== "home.dismiss_notice") {
        return fail(reply, 404, "UNKNOWN_ACTION", "未注册的 actionType");
      }
      const fingerprint = actionFingerprint(env.sessionSecret, req.body.actionId, req.body.input);
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
    { preHandler: requireServiceToken(env.driServiceToken) },
    async (_req, reply) => fail(reply, 501, "NOT_IMPLEMENTED", "DRI Issue 导入在 Ticket 07 实现"),
  );

  return app;
}
