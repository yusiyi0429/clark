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
  ConversationSessionId,
  CreateConversationSessionRequest,
  CreateBattlefieldRequest,
  CreateCapabilityRequest,
  CreateCeoIssueRequest,
  CreateConfigMeetingRequest,
  AssignBattlefieldIssueRequest,
  CreateMeetingRequest,
  PeopleDirectoryResponse,
  DriIssueImportRequest,
  DriMeetingImportRequest,
  DriMonthlyPlanFeedbackRequest,
  DriMonthlyPlanTodoFeedbackRequest,
  ExecuteActionRequest,
  HealthResponse,
  JoinMeetingRequest,
  LoginRequest,
  MeetingConfirmItemInput,
  MeetingDismissItemInput,
  MeetingRevokeEffectInput,
  RadarScanResponse,
  RadarSources,
  ReplaceTranscriptRequest,
  RequestSupplementRequest,
  SessionResponse,
  SignalStateRequest,
  SignMonthlyPlanRequest,
  DriMonthlyExportDeliveredRequest,
  DriMonthlyExportFailedRequest,
  UpdateMeetingDraftRequest,
  UpdateMonthlyPlanDraftRequest,
  type TApiError,
  type TCardCollection,
  type TConversationAttachment,
  type TConversationMessageRequest,
  type TConversationScope,
  type TUpdateMonthlyPlanDraftRequest,
  type TRadarSources,
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
import { actionFingerprint, verifyActionId } from "./actionToken.js";
import { loadCompanyMemory, type CompanyMemorySeedEnv } from "./companyMemory.js";
import { createCompanyMemoryMcpSession } from "./mcpCompanyMemory.js";
import { createPiConversationRuntime } from "./piConversationRuntime.js";
import type { WebSearchAdapter } from "./webSearch.js";
import {
  conversationAttachmentInfo,
  createConversationSession,
  getConversationHistory,
  getConversationSession,
  getConversationSessionHistory,
  getScopeObject,
  listConversationSessions,
  loadConversationAttachments,
  removeConversationAttachmentFiles,
  resolveReferenceSnapshots,
  storeConversationAttachments,
  type ConversationRuntime,
} from "./conversations.js";
import type { RadarOutletAdapter, RadarService } from "./radar.js";
import { resolveConfiguredOutletIds } from "./outletSources.js";
import { getSignalCard, getSignalImageSource, listSignalCards, projectRadarCard, setSignalState } from "./signals.js";
import { getIssueRow, executeIssueAction, createCeoIssue, importDriIssue, listPendingIssueCards, projectIssueCard, assignIssueBattlefield, unassignIssueBattlefield } from "./issues.js";
import type { ResearchService } from "./research.js";
import {
  executeCancelMeeting,
  executeConfirmItem,
  createConfigMeeting,
  executeCreateMeeting,
  executeDismissItem,
  executeEditMaterials,
  executeJoinMeeting,
  executeReplaceTranscript,
  executeRequestSupplement,
  executeRetryOutcome,
  executeRegeneratePreflight,
  executeRetryPreflight,
  executeRunPreflight,
  executeRevokeEffect,
  executeUpdateDraft,
  getMeetingRow,
  importDriMeeting,
  importTranscript,
  listMeetingRows,
  projectMeetingCard,
  replaceMeetingMaterials,
  appendSupplementMaterial,
  type DriExporter,
  type MeetingActionOutcome,
  type PreflightAgent,
  type TranscriptImportResult,
} from "./meetings.js";
import { createPreflightAgent } from "./preflightAgent.js";
import {
  appendDriMonthlyFeedback,
  companyPeriod,
  executeRetryMonthlyPlanDraft,
  executeSignMonthlyPlan,
  executeUpdateMonthlyPlanDraft,
  getMonthlyPlanNotice,
  getMonthlyPlanRow,
  listMonthlyPlanRows,
  listMonthlyExports,
  mutateMonthlyExport,
  projectMonthlyPlanCard,
} from "./monthlyPlans.js";
import { deleteBattlefield, listBattlefieldCards, registerBattlefield } from "./battlefields.js";
import { listCapabilityCards, registerCapability } from "./capabilities.js";
import type { MonthlyPlanService } from "./monthlyDraft.js";
import { recoverInterruptedOutcome, type PostMeetingAgent } from "./outcome.js";
import { createPostMeetingAgent } from "./postMeetingAgent.js";
import multipart from "@fastify/multipart";
import { logEvent } from "./observability.js";
import { configureLangSmith, recordAgentTrace } from "./langsmith.js";
import { cleanupMaterialTemp, ensureMaterialStorage, MAX_MATERIAL_FILE_BYTES, MAX_MATERIAL_FILES, MaterialParseError, parseMaterialBatch, readStoredMaterial } from "./materialParser.js";
import { renderMaterialPreview } from "./materialPreview.js";

export const CONVERSATION_TURN_TIMEOUT_MS = 180_000;
/** warmap-transcript.v1 单文件上限；Web multipart 与 service API 共用。 */
export const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const DEFAULT_MATERIAL_STORAGE_DIR = "/tmp/warmap-meeting-materials";
const DEFAULT_CONVERSATION_ATTACHMENT_STORAGE_DIR = "/tmp/warmap-conversation-attachments";

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
  /** 可选 LangSmith adapter；缺失时完全 no-op（.tech/07 §7）。 */
  langsmithApiKey?: string;
  langsmithProject?: string;
  materialStorageDir?: string;
  /** 会话附件 API 卷；与 Meeting 材料卷隔离。 */
  conversationAttachmentStorageDir?: string;
} & CompanyMemorySeedEnv;

export async function buildApp({
  pool,
  env,
  conversationRuntime,
  radarService,
  researchService,
  preflightAgent,
  outcomeAgent,
  driExporter,
  monthlyPlanService,
  webSearch,
  outlets,
  conversationTurnTimeoutMs = CONVERSATION_TURN_TIMEOUT_MS,
  now = () => new Date(),
}: {
  pool: Pool;
  env: AppEnv;
  conversationRuntime?: ConversationRuntime;
  radarService?: RadarService;
  researchService?: ResearchService;
  preflightAgent?: PreflightAgent;
  outcomeAgent?: PostMeetingAgent;
  driExporter?: DriExporter;
  monthlyPlanService?: MonthlyPlanService;
  /** Pi web_search Tool 的真实 Provider；缺失时 Tool 调用如实失败（不伪装已配置）。 */
  webSearch?: WebSearchAdapter;
  /** 发布方级 feed adapter：Radar、预研与全局对话共用同一白名单来源。 */
  outlets?: RadarOutletAdapter;
  conversationTurnTimeoutMs?: number;
  /** 业务时钟；通知与战场投影按公司月读取同一持久对象。 */
  now?: () => Date;
}): Promise<FastifyInstance> {
  configureLangSmith({ apiKey: env.langsmithApiKey, project: env.langsmithProject });
  // seed 缺失/不合规 → 启动即失败，不虚构人员或空目录（Ticket 16 装载真实 seed）
  const companyMemory = loadCompanyMemory(env);
  const preflight = preflightAgent ?? await createPreflightAgent({
    query: pool.query.bind(pool),
    companyMemory,
    baseUrl: env.piBaseUrl,
    apiKey: env.piApiKey,
    modelId: env.lightModel,
  });
  const outcome = outcomeAgent ?? createPostMeetingAgent({
    query: pool.query.bind(pool),
    baseUrl: env.piBaseUrl,
    apiKey: env.piApiKey,
    modelId: env.heavyModel,
  });
  const readOutletFeed = outlets ? async (signal: AbortSignal) => {
    const config = await pool.query("SELECT lookback_hours, sources FROM radar_config WHERE id = 'default'");
    const row = config.rows[0] as { lookback_hours: number; sources: unknown } | undefined;
    if (!row || !Value.Check(RadarSources, row.sources)) throw new Error("RadarConfig is invalid");
    const outletIds = resolveConfiguredOutletIds(row.sources as TRadarSources);
    if (!outletIds.length) throw new Error("Radar 未配置启用的发布方媒体来源");
    return outlets.fetchLatest({ outletIds, lookbackHours: row.lookback_hours }, signal);
  } : undefined;
  const runtime = conversationRuntime ?? await createPiConversationRuntime({
    companyMemory,
    baseUrl: env.piBaseUrl,
    apiKey: env.piApiKey,
    modelId: env.lightModel,
    compactionModelId: env.compactionModel,
    search: webSearch,
    outletFeed: readOutletFeed,
    // 对话只读工具：实时待决策 Issue 清单（不含签名 Action，不可写入）。
    listPendingIssues: async () => {
      const result = await pool.query(
        `SELECT id, title, location, urgency, research->>'status' AS research_status, created_at
           FROM issues WHERE status = 'pending' ORDER BY created_at, id`,
      );
      return result.rows.map((row) => ({
        id: String(row.id),
        title: String(row.title),
        location: row.location,
        urgency: row.urgency,
        researchStatus: String(row.research_status ?? "none"),
        createdAt: new Date(row.created_at).toISOString(),
      }));
    },
  });
  const radar = radarService ?? {
    providerStatus: { web: false, wechat: false, outlets: false },
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
  // 每个请求的结构化日志上下文：handler 里补充 action/run 字段，onResponse 统一落一条。
  const requestContext = new WeakMap<FastifyRequest, { runId?: string; scope?: string; objectRef?: string; actionType?: string; errorCode?: string }>();
  app.addHook("onResponse", async (req, reply) => {
    const ctx = requestContext.get(req) ?? {};
    logEvent({
      event: "http.request",
      requestId: String(req.id),
      method: req.method,
      url: req.url,
      status: String(reply.statusCode),
      durationMs: Math.round(reply.elapsedTime),
      errorCode: reply.statusCode >= 400 ? (ctx.errorCode ?? `HTTP_${reply.statusCode}`) : undefined,
      runId: ctx.runId,
      scope: ctx.scope,
      objectRef: ctx.objectRef,
      actionType: ctx.actionType,
    });
  });

  // ponytail: 登录限速用进程内计数器，单进程 MVP 足够；多实例部署时换共享存储
  await app.register(rateLimit, { global: false });
  // Transcript 是唯一上传格式；大小上限与 service API 共用
  // Transcript 是唯一上传格式；大小上限与 service API 共用（各上传路由用 per-request limits 收紧）
  await app.register(multipart, { limits: { fileSize: MAX_TRANSCRIPT_BYTES, files: 1, fields: 5 } });
  const materialStorageDir = env.materialStorageDir ?? DEFAULT_MATERIAL_STORAGE_DIR;
  await ensureMaterialStorage(materialStorageDir);
  const conversationAttachmentStorageDir = env.conversationAttachmentStorageDir ?? DEFAULT_CONVERSATION_ATTACHMENT_STORAGE_DIR;
  await ensureMaterialStorage(conversationAttachmentStorageDir);

  function fail(
    reply: FastifyReply,
    status: number,
    code: string,
    message: string,
    extra?: Partial<TApiError>,
  ): FastifyReply {
    requestContext.set(reply.request, { ...requestContext.get(reply.request), errorCode: code });
    return reply.status(status).send({ code, message, retryable: false, requestId: reply.request.id, ...extra });
  }

  type MaterialLimit = { status: 413 | 400; code: string; message: string };
  /**
   * 材料上传的 multipart 上限错误 → 深思熟虑的 4xx；返回 null 表示不是上限错误，调用方必须继续抛出（不吞解析/内部错误）。
   * - FST_REQ_FILE_TOO_LARGE（文件超过 fileSize）→ 413
   * - FST_FILES_LIMIT（文件份数超过 files）→ 调用方按语义给 413（主材料整批）或 400（补充材料恰好一份）
   * - ERR_STREAM_PREMATURE_CLOSE：files 上限触发的清理会销毁当前 part 流，常以此错误呈现（同族客户端错误）→ truncated 映射
   */
  function materialMultipartLimitError(error: unknown, tooLarge: MaterialLimit, tooMany: MaterialLimit, truncated: MaterialLimit): MaterialLimit | null {
    const code = (error as { code?: string }).code;
    if (code === "FST_REQ_FILE_TOO_LARGE") return tooLarge;
    if (code === "FST_FILES_LIMIT") return tooMany;
    if (code === "ERR_STREAM_PREMATURE_CLOSE") return truncated;
    return null;
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
    if (err.statusCode === 413) {
      return fail(reply, 413, "PAYLOAD_TOO_LARGE", "请求体超过大小上限");
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

  // 首页一次返回真实 Card 集合；战略/战场/能力/Radar/通知都是这些持久对象的固定投影。
  // 人员目录：Issue 页新建 Meeting 表单选择 personId 使用；只读，来源于 CompanyMemory。
  app.get("/api/people", { preHandler: requireCEO, schema: { response: { 200: PeopleDirectoryResponse } } }, async () => ({
    people: companyMemory.searchPeople(undefined).map((person) => ({
      personId: person.personId,
      displayName: person.displayName,
      roles: [...person.roles],
    })),
  }));
  app.get("/api/cards/home", { preHandler: requireCEO }, async (): Promise<TCardCollection> => {
    const [radarCard, battlefields, issues, capabilities, meetingRows, monthlyNotice] = await Promise.all([
      projectRadarCard(q, radar.providerStatus),
      listBattlefieldCards(q, companyPeriod(now())),
      listPendingIssueCards(q, env.sessionSecret),
      listCapabilityCards(q),
      listMeetingRows(q),
      getMonthlyPlanNotice(q, env.sessionSecret, now()),
    ]);
    const meetings = meetingRows
      .filter((row) => row.status === "scheduled")
      .map((row) => projectMeetingCard(row, env.sessionSecret));
    const monthly = monthlyNotice && (monthlyNotice.payload as { status?: string }).status !== "confirmed" ? [monthlyNotice] : [];
    return { cards: [radarCard, ...battlefields, ...capabilities, ...issues, ...meetings, ...monthly] };
  });

  // CEO 配置页：确定性表单写入 Organization Fact。创建新对象，没有既有 Card version 可锚，所以不走 opaque-action。
  app.post(
    "/api/config/battlefields",
    { preHandler: requireCEO, schema: { body: CreateBattlefieldRequest } },
    async (req, reply): Promise<FastifyReply> => {
      const result = await registerBattlefield(q, req.body);
      if (!result.ok) return fail(reply, 409, result.code, result.message);
      const cards = await listBattlefieldCards(q, companyPeriod(now()));
      return reply.status(201).send({ cards: cards.filter((card) => card.objectRef.id === result.id) });
    },
  );
  app.post(
    "/api/config/capabilities",
    { preHandler: requireCEO, schema: { body: CreateCapabilityRequest } },
    async (req, reply): Promise<FastifyReply> => {
      const result = await registerCapability(q, req.body);
      if (!result.ok) return fail(reply, 409, result.code, result.message);
      const cards = (await listCapabilityCards(q)).filter((card) => card.objectRef.id === result.id);
      return reply.status(201).send({ cards });
    },
  );
  app.post(
    "/api/config/issues",
    { preHandler: requireCEO, schema: { body: CreateCeoIssueRequest } },
    async (req, reply): Promise<FastifyReply> => {
      const result = await createCeoIssue(pool, env.sessionSecret, req.body);
      if (result.status !== 201) {
        return fail(reply, result.status, result.code, result.message, result.fieldErrors ? { fieldErrors: result.fieldErrors } : undefined);
      }
      // 与其他 Issue 创建路径一致：立即启动唯一深度预研，不阻塞响应
      research.start(result.card.objectRef.id).catch((err) => console.error("research start failed", err));
      return reply.status(201).send({ cards: [result.card] });
    },
  );
  app.post(
    "/api/config/meetings",
    { preHandler: requireCEO, schema: { body: CreateConfigMeetingRequest } },
    async (req, reply): Promise<FastifyReply> => {
      const result = await createConfigMeeting(pool, companyMemory, preflight, env.sessionSecret, req.body);
      if ("error" in result) {
        return fail(reply, result.error.status, result.error.code, result.error.message, result.error.fieldErrors ? { fieldErrors: result.error.fieldErrors } : undefined);
      }
      return reply.status(201).send({ cards: [result.card] });
    },
  );

  const idParams = Type.Object({ id: Type.String({ minLength: 1 }) }, { additionalProperties: false });

  app.delete(
    "/api/config/battlefields/:id",
    { preHandler: requireCEO, schema: { params: idParams } },
    async (req, reply): Promise<FastifyReply> => {
      const result = await deleteBattlefield(pool, req.params.id);
      if (!result.ok) return fail(reply, result.status, result.code, result.message);
      return reply.code(204).send();
    },
  );

  // CEO 配置页的议题↔战场关联集合：确定性配置语义，不走 opaque-action。
  app.post(
    "/api/config/battlefields/:id/issues",
    { preHandler: requireCEO, schema: { params: idParams, body: AssignBattlefieldIssueRequest } },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const result = await assignIssueBattlefield(pool, env.sessionSecret, req.params.id, req.body.issueId);
      return result.ok ? { cards: [result.card] } : fail(reply, result.status, result.code, result.message);
    },
  );
  app.delete(
    "/api/config/battlefields/:id/issues/:issueId",
    { preHandler: requireCEO, schema: { params: Type.Object({ id: Type.String({ minLength: 1 }), issueId: Type.String({ minLength: 1 }) }, { additionalProperties: false }) } },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const result = await unassignIssueBattlefield(pool, env.sessionSecret, req.params.id, req.params.issueId);
      return result.ok ? { cards: [result.card] } : fail(reply, result.status, result.code, result.message);
    },
  );
  const signalImageParams = Type.Object({
    id: Type.String({ minLength: 1 }),
    index: Type.String({ pattern: "^[0-9]+$" }),
  }, { additionalProperties: false });

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

  app.get(
    "/api/signals/:id/images/:index",
    { preHandler: requireCEO, schema: { params: signalImageParams } },
    async (req, reply): Promise<FastifyReply> => {
      const image = await getSignalImageSource(q, req.params.id, Number(req.params.index));
      if (!image) return fail(reply, 404, "SIGNAL_IMAGE_NOT_FOUND", "原文图片不存在");
      let source: Response;
      try {
        source = await fetch(image.url, {
          headers: { "user-agent": "Mozilla/5.0 (compatible; WarMapRadar/1.0)", referer: image.referer },
        });
      } catch {
        return fail(reply, 502, "SIGNAL_IMAGE_FETCH_FAILED", "原文图片抓取失败");
      }
      const type = source.headers.get("content-type")?.split(";", 1)[0]?.toLowerCase();
      if (!source.ok || !type || !["image/jpeg", "image/png", "image/webp", "image/gif"].includes(type)) {
        return fail(reply, 502, "SIGNAL_IMAGE_FETCH_FAILED", "原文图片不可用");
      }
      const limit = 10 * 1024 * 1024;
      const declared = Number(source.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > limit) return fail(reply, 413, "SIGNAL_IMAGE_TOO_LARGE", "原文图片超过 10MiB");
      const reader = source.body?.getReader();
      if (!reader) return fail(reply, 502, "SIGNAL_IMAGE_FETCH_FAILED", "原文图片读取失败");
      const chunks: Uint8Array[] = [];
      let size = 0;
      while (true) {
        const next = await reader.read();
        if (next.done) break;
        size += next.value.byteLength;
        if (size > limit) {
          await reader.cancel();
          return fail(reply, 413, "SIGNAL_IMAGE_TOO_LARGE", "原文图片超过 10MiB");
        }
        chunks.push(next.value);
      }
      return reply.header("content-type", type).header("cache-control", "private, max-age=3600").send(Buffer.concat(chunks));
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
  const conversationSessionParams = Type.Object(
    { scope: ConversationScope, sessionId: ConversationSessionId },
    { additionalProperties: false },
  );
  const conversationScopeVisible = async (scope: TConversationScope) =>
    (await getScopeObject(q, scope, env.sessionSecret)).visible;

  app.get(
    "/api/conversations/:scope/messages",
    { preHandler: requireCEO, schema: { params: conversationParams } },
    async (req, reply) => {
      const object = await getScopeObject(q, req.params.scope, env.sessionSecret);
      if (!object.visible) return fail(reply, 404, "CONVERSATION_SCOPE_NOT_FOUND", "Conversation scope 不存在");
      return getConversationHistory(q, req.params.scope);
    },
  );

  /** 一轮对话的完整流程；conversationId 为 null 时走 legacy 默认会话语义。 */
  const sendConversationTurn = async (
    req: FastifyRequest<{ Params: { scope: TConversationScope }; Body: TConversationMessageRequest }>,
    reply: FastifyReply,
    conversationId: string | null,
  ): Promise<void> => {
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

      let scopeLockHeld = true;
      const runId = randomUUID();
      requestContext.set(req, { runId, scope: req.params.scope });
      const runStartedAt = Date.now();
      const abort = new AbortController();
      let streamFinished = false;
      let eventSequence = 0;
      const runToolEvents: { name: string; isError?: boolean }[] = [];
      let runStatus = "aborted";
      let runError: string | undefined;
      let runOutput: unknown;
      try {
        let row: { id: string; pi_session_id: string; runtime_entries: unknown[] };
        if (conversationId) {
          const found = await client.query<{ id: string; pi_session_id: string; runtime_entries: unknown[] }>(
            "SELECT id, pi_session_id, runtime_entries FROM conversations WHERE id = $1::uuid AND scope = $2 AND deleted_at IS NULL",
            [conversationId, req.params.scope],
          );
          if (!found.rows[0]) {
            return fail(reply, 404, "CONVERSATION_SESSION_NOT_FOUND", "会话不存在");
          }
          row = found.rows[0];
        } else {
          // legacy 路由：默认会话 = 最早未删除；不存在则在锁内惰性创建（scope 唯一约束已随会话化移除）。
          const existing = await client.query<{ id: string; pi_session_id: string; runtime_entries: unknown[] }>(
            "SELECT id, pi_session_id, runtime_entries FROM conversations WHERE scope = $1 AND deleted_at IS NULL ORDER BY created_at ASC, id ASC LIMIT 1",
            [req.params.scope],
          );
          if (existing.rows[0]) {
            row = existing.rows[0];
          } else {
            row = { id: randomUUID(), pi_session_id: randomUUID(), runtime_entries: [] };
            await client.query(
              "INSERT INTO conversations (id, scope, pi_session_id) VALUES ($1, $2, $3)",
              [row.id, req.params.scope, row.pi_session_id],
            );
          }
        }
        // 附件：只信服务端 sidecar（客户端只能传 id）；原件不进入 Runtime，只拼接有界抽取文本。
        let attachments: TConversationAttachment[] = [];
        if (req.body.attachments?.length) {
          try {
            attachments = await loadConversationAttachments(
              conversationAttachmentStorageDir,
              row.id,
              req.body.attachments.map((item) => item.id),
            );
          } catch (error) {
            if ((error as { code?: string }).code === "ATTACHMENT_NOT_FOUND") {
              return fail(reply, 400, "ATTACHMENT_NOT_FOUND", (error as Error).message);
            }
            throw error;
          }
        }
        const runtimeMessage = attachments.length
          ? `${req.body.message}\n\n${attachments.map((attachment) => `[附件 ${attachment.fileName}]\n${attachment.extractedText}`).join("\n\n")}`
          : req.body.message;
        const next = await client.query<{ sequence: number }>(
          `SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence
             FROM conversation_messages WHERE conversation_id = $1`,
          [row.id],
        );
        const userSequence = next.rows[0].sequence;
        await client.query(
          `INSERT INTO conversation_messages
             (conversation_id, sequence, role, content, references_snapshot, attachments, run_id)
           VALUES ($1, $2, 'user', $3, $4::jsonb, $5::jsonb, $6)`,
          [row.id, userSequence, req.body.message, JSON.stringify(references.snapshots), JSON.stringify(attachments), runId],
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
              conversationId: row.id,
              message: req.body.message,
              currentObject: object.snapshot,
              references: references.snapshots,
              attachments: attachments.map(conversationAttachmentInfo),
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
          if (event.type === "tool" && event.phase === "completed") {
            runToolEvents.push({ name: String(event.name), isError: event.isError === true });
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
            message: runtimeMessage,
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
            runError = reason?.message ?? "Conversation aborted";
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
            runStatus = "succeeded";
            runOutput = { assistantMessage: result.assistantMessage };
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
          runStatus = abort.signal.aborted ? "aborted" : "failed";
          runError = reason?.message ?? (err as Error).message ?? "Pi Runtime 失败";
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
        const durationMs = Date.now() - runStartedAt;
        const provider = "warmap";
        const model = runtime.modelId ?? env.lightModel;
        logEvent({
          event: "agent.run",
          requestId: String(req.id),
          runId,
          agentKind: "conversation",
          scope: req.params.scope,
          objectRef: object.snapshot ? `${object.snapshot.objectRef.type}:${object.snapshot.objectRef.id}` : undefined,
          provider,
          model,
          durationMs,
          status: runStatus,
          errorCode: runError ? (runStatus === "aborted" ? "ABORTED" : "RUNTIME_FAILED") : undefined,
          error: runError,
        });
        void recordAgentTrace({
          runId,
          name: "conversation",
          agentKind: "conversation",
          promptHash: runtime.promptHash,
          objectRef: object.snapshot?.objectRef ?? { type: "global", id: "global" },
          inputs: { message: req.body.message, currentObject: object.snapshot, references: references.snapshots },
          outputs: runOutput,
          toolEvents: runToolEvents,
          usage: runUsage,
          error: runError,
          status: runStatus,
          startedAt: runStartedAt,
          durationMs,
        });
        streamFinished = true;
        // Fastify inject/browser may observe SSE end before this function's finally runs.
        // Release first so an immediate next turn/delete cannot spuriously see TURN_IN_PROGRESS.
        await client.query("SELECT pg_advisory_unlock(hashtext($1))", [req.params.scope]).catch(() => undefined);
        scopeLockHeld = false;
        reply.raw.end();
      } finally {
        if (scopeLockHeld) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [req.params.scope]).catch(() => undefined);
        client.release();
      }
    };

  // legacy 路由：读写默认会话，老调用方与既有测试行为不变。
  app.post(
    "/api/conversations/:scope/messages",
    {
      preHandler: requireCEO,
      schema: { params: conversationParams, body: ConversationMessageRequest },
    },
    async (req: FastifyRequest<{ Params: { scope: TConversationScope }; Body: TConversationMessageRequest }>, reply) =>
      sendConversationTurn(req, reply, null),
  );

  app.get(
    "/api/conversations/:scope/sessions",
    { preHandler: requireCEO, schema: { params: conversationParams } },
    async (req, reply) => {
      if (!await conversationScopeVisible(req.params.scope)) return fail(reply, 404, "CONVERSATION_SCOPE_NOT_FOUND", "Conversation scope 不存在");
      return listConversationSessions(q, req.params.scope);
    },
  );

  app.post(
    "/api/conversations/:scope/sessions",
    { preHandler: requireCEO, schema: { params: conversationParams, body: CreateConversationSessionRequest } },
    async (req, reply) => {
      if (!await conversationScopeVisible(req.params.scope)) return fail(reply, 404, "CONVERSATION_SCOPE_NOT_FOUND", "Conversation scope 不存在");
      const session = await createConversationSession(q, req.params.scope, req.body.title);
      return reply.code(201).send(session);
    },
  );

  app.get(
    "/api/conversations/:scope/sessions/:sessionId/messages",
    { preHandler: requireCEO, schema: { params: conversationSessionParams } },
    async (req, reply) => {
      if (!await conversationScopeVisible(req.params.scope)) return fail(reply, 404, "CONVERSATION_SCOPE_NOT_FOUND", "Conversation scope 不存在");
      const session = await getConversationSession(q, req.params.scope, req.params.sessionId);
      if (!session) return fail(reply, 404, "CONVERSATION_SESSION_NOT_FOUND", "会话不存在");
      return getConversationSessionHistory(q, req.params.scope, req.params.sessionId);
    },
  );

  app.post(
    "/api/conversations/:scope/sessions/:sessionId/messages",
    {
      preHandler: requireCEO,
      schema: { params: conversationSessionParams, body: ConversationMessageRequest },
    },
    async (req: FastifyRequest<{ Params: { scope: TConversationScope; sessionId: string }; Body: TConversationMessageRequest }>, reply) => {
      if (!await conversationScopeVisible(req.params.scope)) return fail(reply, 404, "CONVERSATION_SCOPE_NOT_FOUND", "Conversation scope 不存在");
      const session = await getConversationSession(q, req.params.scope, req.params.sessionId);
      if (!session) return fail(reply, 404, "CONVERSATION_SESSION_NOT_FOUND", "会话不存在");
      return sendConversationTurn(req, reply, session.id);
    },
  );

  // 会话附件：复用 Meeting 材料的受限解析器（PDF/DOCX/Markdown、同一大小/数量/超时限制），API 卷独立。
  app.post(
    "/api/conversations/:scope/sessions/:sessionId/attachments",
    { preHandler: requireCEO, schema: { params: conversationSessionParams }, bodyLimit: 101 * 1024 * 1024 },
    async (req, reply) => {
      let parsed: Awaited<ReturnType<typeof parseMaterialBatch>> | undefined;
      try {
        if (!await conversationScopeVisible(req.params.scope)) return fail(reply, 404, "CONVERSATION_SCOPE_NOT_FOUND", "Conversation scope 不存在");
        const session = await getConversationSession(q, req.params.scope, req.params.sessionId);
        if (!session) return fail(reply, 404, "CONVERSATION_SESSION_NOT_FOUND", "会话不存在");
        const files: { filename: string; mimetype: string; buffer: Buffer }[] = [];
        for await (const part of req.files({ limits: { fileSize: MAX_MATERIAL_FILE_BYTES, files: MAX_MATERIAL_FILES } })) {
          if (part.type !== "file" || part.fieldname !== "files") return fail(reply, 400, "INVALID_ATTACHMENT", "multipart 只接受 files 文件字段");
          files.push({ filename: part.filename, mimetype: part.mimetype, buffer: await part.toBuffer() });
        }
        if (!files.length) return fail(reply, 400, "INVALID_ATTACHMENT", "缺少附件文件");
        parsed = await parseMaterialBatch(files);
        const stored = await storeConversationAttachments(conversationAttachmentStorageDir, session.id, parsed.materials);
        return { attachments: stored.map(conversationAttachmentInfo) };
      } catch (error) {
        if (error instanceof MaterialParseError) return fail(reply, 400, error.code, error.message);
        const code = (error as { code?: string }).code;
        if (code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT") return fail(reply, 413, "MATERIAL_BATCH_TOO_LARGE", "附件文件或数量超出上限");
        throw error;
      } finally {
        if (parsed) await cleanupMaterialTemp(parsed.directory);
      }
    },
  );

  // 删除会话：与轮次共用 scope 级 advisory lock，拿到锁即可保证没有进行中的轮次。
  app.delete(
    "/api/conversations/:scope/sessions/:sessionId",
    { preHandler: requireCEO, schema: { params: conversationSessionParams } },
    async (req, reply): Promise<FastifyReply> => {
      if (!await conversationScopeVisible(req.params.scope)) return fail(reply, 404, "CONVERSATION_SCOPE_NOT_FOUND", "Conversation scope 不存在");
      const client = await pool.connect();
      let locked = false;
      try {
        const lock = await client.query<{ locked: boolean }>("SELECT pg_try_advisory_lock(hashtext($1)) AS locked", [req.params.scope]);
        locked = lock.rows[0]?.locked === true;
        if (!locked) return fail(reply, 409, "SESSION_BUSY", "会话正在运行一轮对话，稍后再删");
        await client.query("BEGIN");
        const row = await client.query<{ id: string }>(
          "SELECT id FROM conversations WHERE id = $1::uuid AND scope = $2 AND deleted_at IS NULL FOR UPDATE",
          [req.params.sessionId, req.params.scope],
        );
        if (!row.rows[0]) {
          await client.query("ROLLBACK");
          return fail(reply, 404, "CONVERSATION_SESSION_NOT_FOUND", "会话不存在");
        }
        await client.query("DELETE FROM conversation_messages WHERE conversation_id = $1", [row.rows[0].id]);
        await client.query("UPDATE conversations SET deleted_at = now() WHERE id = $1", [row.rows[0].id]);
        await client.query("COMMIT");
        // DB 删除已提交后才清文件；清理失败只留孤儿文件，不影响删除语义。
        await removeConversationAttachmentFiles(conversationAttachmentStorageDir, row.rows[0].id);
        return reply.code(204).send();
      } catch (error) {
        await client.query("ROLLBACK").catch(() => undefined);
        throw error;
      } finally {
        if (locked) await client.query("SELECT pg_advisory_unlock(hashtext($1))", [req.params.scope]).catch(() => undefined);
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
      const issue = await getIssueRow(q, req.params.id);
      return issue
        ? { cards: [projectIssueCard(issue, env.sessionSecret)] }
        : fail(reply, 404, "CARD_NOT_FOUND", "Card 不存在");
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
  // 月度通知与月度页面同样读取同一 MonthlyPlan 持久对象。
  app.get("/api/cards/notifications", { preHandler: requireCEO }, async (): Promise<TCardCollection> => {
    const rows = (await listMeetingRows(q)).filter((row) => row.status === "scheduled");
    const monthlyNotice = await getMonthlyPlanNotice(q, env.sessionSecret, now());
    return { cards: [...(monthlyNotice ? [monthlyNotice] : []), ...rows.map((row) => projectMeetingCard(row, env.sessionSecret))] };
  });

  app.get("/api/cards/monthly-plans", { preHandler: requireCEO }, async (): Promise<TCardCollection> => {
    const rows = await listMonthlyPlanRows(q);
    return { cards: rows.map((row) => projectMonthlyPlanCard(row, env.sessionSecret)) };
  });

  app.get(
    "/api/cards/monthly-plans/:id",
    { preHandler: requireCEO, schema: { params: idParams } },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const row = await getMonthlyPlanRow(q, req.params.id);
      return row ? { cards: [projectMonthlyPlanCard(row, env.sessionSecret)] } : fail(reply, 404, "CARD_NOT_FOUND", "Card 不存在");
    },
  );

  // 战场 Card：正面读已签发计划目标，背面按 battlefieldId 投影 todo/feedback，与通知同源。
  app.get("/api/cards/battlefields", { preHandler: requireCEO }, async (): Promise<TCardCollection> => ({
    cards: await listBattlefieldCards(q, companyPeriod(now())),
  }));

  /** Transcript 导入结果 → HTTP；Web multipart 与 service API 共用同一个边界。 */
  function respondTranscriptImport(reply: FastifyReply, result: TranscriptImportResult): TCardCollection | FastifyReply {
    if (result.status === 200) return { cards: [result.card] };
    return fail(reply, result.status, result.code, result.message, result.fieldErrors ? { fieldErrors: result.fieldErrors } : undefined);
  }

  // CEO Web 上传：multipart/form-data 单文件；大小与 schema 校验与 service API 完全一致。
  app.post(
    "/api/meetings/:id/transcript",
    { preHandler: requireCEO, schema: { params: idParams }, bodyLimit: MAX_TRANSCRIPT_BYTES * 2 },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      let buffer: Buffer;
      try {
        const upload = await req.file({ limits: { fileSize: MAX_TRANSCRIPT_BYTES, files: 1 } });
        if (!upload) return fail(reply, 400, "INVALID_TRANSCRIPT", "multipart 缺少 Transcript 文件");
        buffer = await upload.toBuffer();
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === "FST_REQ_FILE_TOO_LARGE" || code === "FST_FILES_LIMIT") {
          return fail(reply, 413, "TRANSCRIPT_TOO_LARGE", `Transcript 超过 ${MAX_TRANSCRIPT_BYTES} 字节上限`);
        }
        throw err;
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(buffer));
      } catch (err) {
        const encoding = (err as { code?: string }).code === "ERR_ENCODING_INVALID_ENCODED_DATA";
        return fail(reply, 400, encoding ? "INVALID_TRANSCRIPT_ENCODING" : "INVALID_TRANSCRIPT", encoding ? "Transcript 不是合法 UTF-8" : "Transcript 不是合法 JSON");
      }
      return respondTranscriptImport(reply, await importTranscript(pool, outcome, env.sessionSecret, req.params.id, parsed));
    },
  );

  // Meeting Material 使用独立 endpoint，绝不复用 Transcript 语义或 DRI service 身份。
  app.post(
    "/api/meetings/:id/materials",
    { preHandler: requireCEO, schema: { params: idParams }, bodyLimit: 101 * 1024 * 1024 },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      let parsed: Awaited<ReturnType<typeof parseMaterialBatch>> | undefined;
      try {
        const files: { filename: string; mimetype: string; buffer: Buffer }[] = [];
        let totalBytes = 0;
        for await (const part of req.files({ limits: { fileSize: MAX_MATERIAL_FILE_BYTES, files: MAX_MATERIAL_FILES } })) {
          if (part.type !== "file" || part.fieldname !== "files") return fail(reply, 400, "INVALID_MATERIAL", "multipart 只接受 files 文件字段");
          const buffer = await part.toBuffer();
          totalBytes += buffer.length;
          if (totalBytes > 100 * 1024 * 1024) return fail(reply, 413, "MATERIAL_BATCH_TOO_LARGE", "材料总大小超过 100 MiB");
          files.push({ filename: part.filename, mimetype: part.mimetype, buffer });
        }
        parsed = await parseMaterialBatch(files);
        const result = await replaceMeetingMaterials(pool, env.sessionSecret, req.params.id, parsed.materials, materialStorageDir);
        return respond(reply, result);
      } catch (error) {
        if (error instanceof MaterialParseError) return fail(reply, 400, error.code, error.message);
        const limited = materialMultipartLimitError(
          error,
          { status: 413, code: "MATERIAL_BATCH_TOO_LARGE", message: "材料文件或数量超出上限" },
          { status: 400, code: "MATERIAL_BATCH_TOO_LARGE", message: `每批最多 ${MAX_MATERIAL_FILES} 份材料文件` },
          { status: 400, code: "MATERIAL_BATCH_TOO_LARGE", message: `每批最多 ${MAX_MATERIAL_FILES} 份材料文件` },
        );
        if (limited) return fail(reply, limited.status, limited.code, limited.message);
        throw error;
      } finally {
        if (parsed) await cleanupMaterialTemp(parsed.directory);
      }
    },
  );

  // 预览同样仅 CEO 鉴权：PDF inline 字节、Markdown 纯文本、DOCX 按需 sanitize HTML（不持久化）。
  // 补充材料文件组：CEO 把会外收到的回应文件归档到已记录请求；scheduled only；不重置/不触发预审。
  app.post(
    "/api/meetings/:id/materials/supplement",
    { preHandler: requireCEO, schema: { params: idParams }, bodyLimit: MAX_MATERIAL_FILE_BYTES * 2 },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      let parsed: Awaited<ReturnType<typeof parseMaterialBatch>> | undefined;
      try {
        let requestId: string | null = null;
        let file: { filename: string; mimetype: string; buffer: Buffer } | null = null;
        for await (const part of req.parts({ limits: { fileSize: MAX_MATERIAL_FILE_BYTES, files: 1 } })) {
          if (part.type === "file") {
            if (part.fieldname !== "files") return fail(reply, 400, "INVALID_MATERIAL", "multipart 文件必须放在 files 字段");
            if (file) return fail(reply, 400, "INVALID_MATERIAL", "补充材料一次只能上传一份");
            file = { filename: part.filename, mimetype: part.mimetype, buffer: await part.toBuffer() };
          } else if (part.fieldname === "requestId") {
            requestId = String(part.value ?? "").trim() || null;
          }
        }
        if (!file || !requestId) return fail(reply, 400, "INVALID_MATERIAL", "multipart 需要 files 文件与 requestId 字段");
        parsed = await parseMaterialBatch([file]);
        const result = await appendSupplementMaterial(pool, env.sessionSecret, req.params.id, requestId, parsed.materials[0], materialStorageDir);
        return respond(reply, result);
      } catch (error) {
        if (error instanceof MaterialParseError) return fail(reply, 400, error.code, error.message);
        const limited = materialMultipartLimitError(
          error,
          { status: 413, code: "MATERIAL_FILE_TOO_LARGE", message: "补充材料超出 20 MiB 上限" },
          { status: 400, code: "INVALID_MATERIAL", message: "补充材料一次只能上传一份" },
          { status: 400, code: "INVALID_MATERIAL", message: "补充材料必须恰好一份，或上传在完成前中断" },
        );
        if (limited) return fail(reply, limited.status, limited.code, limited.message);
        throw error;
      } finally {
        if (parsed) await cleanupMaterialTemp(parsed.directory);
      }
    },
  );

  app.get(
    "/api/meetings/:id/materials/:materialId/preview",
    { preHandler: requireCEO, schema: { params: Type.Object({ id: Type.String(), materialId: Type.String() }) } },
    async (req, reply): Promise<FastifyReply> => {
      const meeting = await getMeetingRow(q, req.params.id);
      const material = meeting?.materials.find((candidate) => candidate.id === req.params.materialId);
      if (!material) return fail(reply, 404, "MATERIAL_NOT_FOUND", "材料不存在");
      try {
        const buffer = await readStoredMaterial(materialStorageDir, material.storageKey);
        const preview = await renderMaterialPreview(buffer, material.mimeType);
        return reply.type(preview.contentType)
          .header("content-disposition", "inline")
          .header("x-content-type-options", "nosniff")
          .header("content-security-policy", "default-src 'none'; sandbox")
          .send(preview.body);
      } catch {
        return fail(reply, 404, "MATERIAL_NOT_FOUND", "材料原件不存在");
      }
    },
  );

  app.get(
    "/api/meetings/:id/materials/:materialId/download",
    { preHandler: requireCEO, schema: { params: Type.Object({ id: Type.String(), materialId: Type.String() }) } },
    async (req, reply): Promise<FastifyReply> => {
      const meeting = await getMeetingRow(q, req.params.id);
      const material = meeting?.materials.find((candidate) => candidate.id === req.params.materialId);
      if (!material) return fail(reply, 404, "MATERIAL_NOT_FOUND", "材料不存在");
      try {
        const buffer = await readStoredMaterial(materialStorageDir, material.storageKey);
        return reply.type(material.mimeType).header("content-disposition", `attachment; filename*=UTF-8''${encodeURIComponent(material.fileName)}`).send(buffer);
      } catch {
        return fail(reply, 404, "MATERIAL_NOT_FOUND", "材料原件不存在");
      }
    },
  );

  // 集成客户端上传：同一 warmap-transcript.v1 与同一导入函数，仅服务身份不同。
  app.post(
    "/api/dri/meetings/:id/transcript",
    { onRequest: requireServiceToken(env.driServiceToken), bodyLimit: MAX_TRANSCRIPT_BYTES, schema: { params: idParams } },
    async (req, reply): Promise<TCardCollection | FastifyReply> =>
      respondTranscriptImport(reply, await importTranscript(pool, outcome, env.sessionSecret, req.params.id, req.body)),
  );

  app.post(
    "/api/actions/execute",
    { preHandler: requireCEO, schema: { body: ExecuteActionRequest } },
    async (req, reply): Promise<TCardCollection | FastifyReply> => {
      const scope = verifyActionId(env.sessionSecret, req.body.actionId);
      if (!scope) {
        return fail(reply, 404, "UNKNOWN_ACTION", "无效 actionId");
      }
      requestContext.set(req, { actionType: scope.actionType, objectRef: `${scope.objectType}:${scope.objectId}` });
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
      if (scope.actionType === "meeting.edit_materials") {
        return respond(reply, await executeEditMaterials(pool, env.sessionSecret, scope, fingerprint));
      }
      if (scope.actionType === "meeting.run_preflight") {
        return respond(reply, await executeRunPreflight(pool, companyMemory, preflight, env.sessionSecret, scope, fingerprint));
      }
      if (scope.actionType === "meeting.cancel") {
        return respond(reply, await executeCancelMeeting(pool, env.sessionSecret, scope, fingerprint));
      }
      if (scope.actionType === "meeting.retry_preflight") {
        return respond(reply, await executeRetryPreflight(pool, companyMemory, preflight, env.sessionSecret, scope, fingerprint));
      }
      if (scope.actionType === "meeting.regenerate_preflight") {
        return respond(reply, await executeRegeneratePreflight(pool, companyMemory, preflight, env.sessionSecret, scope, fingerprint));
      }
      // Ticket 10：Transcript 替换是危险 Action，要求二次确认
      if (scope.actionType === "meeting.replace_transcript") {
        if (!Value.Check(ReplaceTranscriptRequest, input)) return invalidInput(reply, ReplaceTranscriptRequest, input);
        return respond(reply, await executeReplaceTranscript(pool, outcome, env.sessionSecret, scope, input, fingerprint));
      }
      if (scope.actionType === "meeting.retry_outcome") {
        return respond(reply, await executeRetryOutcome(pool, outcome, env.sessionSecret, scope, fingerprint));
      }
      // Ticket 11：逐项确认/忽略/撤回；itemId 由签名 actionId 携带
      if (scope.actionType === "meeting.confirm_item") {
        if (!Value.Check(MeetingConfirmItemInput, input ?? {})) return invalidInput(reply, MeetingConfirmItemInput, input ?? {});
        return respond(reply, await executeConfirmItem(pool, driExporter, env.sessionSecret, scope, fingerprint));
      }
      if (scope.actionType === "meeting.dismiss_item") {
        const dismissInput = input ?? {};
        if (!Value.Check(MeetingDismissItemInput, dismissInput)) return invalidInput(reply, MeetingDismissItemInput, dismissInput);
        return respond(reply, await executeDismissItem(pool, env.sessionSecret, scope, fingerprint, dismissInput.reason));
      }
      if (scope.actionType === "meeting.revoke_effect") {
        const revokeInput = input ?? {};
        if (!Value.Check(MeetingRevokeEffectInput, revokeInput)) return invalidInput(reply, MeetingRevokeEffectInput, revokeInput);
        return respond(reply, await executeRevokeEffect(pool, env.sessionSecret, scope, fingerprint, revokeInput.reason));
      }

      if (scope.actionType === "monthly-plan.update_draft") {
        const monthlyInput = input ?? {};
        if (!Value.Check(UpdateMonthlyPlanDraftRequest, monthlyInput)) {
          return invalidInput(reply, UpdateMonthlyPlanDraftRequest, monthlyInput);
        }
        return respond(reply, await executeUpdateMonthlyPlanDraft(pool, companyMemory, env.sessionSecret, scope, monthlyInput as TUpdateMonthlyPlanDraftRequest, fingerprint));
      }
      if (scope.actionType === "monthly-plan.retry_draft") {
        const result = await executeRetryMonthlyPlanDraft(pool, env.sessionSecret, scope, fingerprint);
        // 重跑已进入 running：提交后异步执行，不阻塞返回
        if ("startDraft" in result && result.startDraft) {
          const { planId, runId } = result.startDraft;
          monthlyPlanService?.executeRun(planId, runId).catch((err) => console.error("monthly draft run failed", err));
        }
        return respond(reply, result);
      }
      if (scope.actionType === "monthly-plan.sign") {
        const signInput = input ?? {};
        if (!Value.Check(SignMonthlyPlanRequest, signInput)) return invalidInput(reply, SignMonthlyPlanRequest, signInput);
        return respond(reply, await executeSignMonthlyPlan(pool, companyMemory, env.sessionSecret, scope, fingerprint));
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
      return fail(reply, 404, "UNKNOWN_ACTION", "未注册的 actionType");
    },
  );

  // Health 只读进程状态与已装配依赖，不发起模型/Search 调用，也不写任何持久化状态。
  // 同时挂在 /healthz 与 /api/healthz：后者让 Caddy 的 /api/* 边界把 API health 暴露到公网（无 secret）。
  const healthz = async (): Promise<Static<typeof HealthResponse>> => {
    let database = true;
    try {
      await q("SELECT 1");
    } catch {
      database = false;
    }
    const dependencies = {
      // 启动不变量：任一为 false 时 API 不可能对外服务；字段来自已装配对象而非环境名。
      piRuntime: Boolean(runtime),
      modelSlots: Boolean(env.lightModel && env.heavyModel && env.compactionModel),
      companyMemoryMcp: Boolean(companyMemory),
      // Provider 可选项：安装时就能诚实区分，不发起外部调用。
      search: radar.providerStatus.web,
      wechat: radar.providerStatus.wechat,
      outlets: radar.providerStatus.outlets ?? false,
    };
    const status: Static<typeof HealthResponse>["status"] =
      database && dependencies.piRuntime && dependencies.modelSlots && dependencies.companyMemoryMcp ? "ok" : "degraded";
    return { status, api: true, database, buildSha: env.buildSha, dependencies };
  };
  app.get("/healthz", { schema: { response: { 200: HealthResponse } } }, healthz);
  app.get("/api/healthz", { schema: { response: { 200: HealthResponse } } }, healthz);

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
  // DRI 叙述性 feedback：只追加到同一个 MonthlyPlan，不修改 todo 执行状态。
  app.post(
    "/api/dri/monthly-feedback",
    { onRequest: requireServiceToken(env.driServiceToken), schema: { body: DriMonthlyPlanFeedbackRequest } },
    async (req, reply) => {
      const result = await appendDriMonthlyFeedback(pool, companyMemory, req.body, env.sessionSecret);
      if ("code" in result) {
        return fail(reply, result.status, result.code, result.message, result.fieldErrors ? { fieldErrors: result.fieldErrors } : undefined);
      }
      return reply.status(result.status).send({ cards: [result.card] });
    },
  );
  app.post(
    "/api/dri/todo-feedback",
    { onRequest: requireServiceToken(env.driServiceToken), schema: { body: DriMonthlyPlanTodoFeedbackRequest } },
    async (req, reply) => {
      const result = await appendDriMonthlyFeedback(pool, companyMemory, req.body, env.sessionSecret);
      if ("code" in result) {
        return fail(reply, result.status, result.code, result.message, result.fieldErrors ? { fieldErrors: result.fieldErrors } : undefined);
      }
      return reply.status(result.status).send({ cards: [result.card] });
    },
  );

  // DRI 出站：普通 todo 的真实 pending_export/delivered/failed 状态；WarMap 不跟踪执行进度。
  const exportParams = Type.Object({ effectRef: Type.String({ minLength: 1 }) }, { additionalProperties: false });
  const exportStatusQuery = Type.Object(
    { status: Type.Optional(Type.Union([Type.Literal("pending_export"), Type.Literal("delivered"), Type.Literal("failed")])) },
    { additionalProperties: false },
  );
  app.get(
    "/api/dri/monthly-exports",
    { onRequest: requireServiceToken(env.driServiceToken), schema: { querystring: exportStatusQuery } },
    async (req) => ({ exports: await listMonthlyExports(q, req.query.status) }),
  );
  app.post(
    "/api/dri/monthly-exports/:effectRef/delivered",
    { onRequest: requireServiceToken(env.driServiceToken), schema: { params: exportParams, body: DriMonthlyExportDeliveredRequest } },
    async (req, reply) => {
      const result = await mutateMonthlyExport(pool, req.params.effectRef, { status: "delivered", exportRef: req.body.exportRef });
      return result.status === 200 ? { exports: result.exports } : fail(reply, result.status, result.code, result.message);
    },
  );
  app.post(
    "/api/dri/monthly-exports/:effectRef/failed",
    { onRequest: requireServiceToken(env.driServiceToken), schema: { params: exportParams, body: DriMonthlyExportFailedRequest } },
    async (req, reply) => {
      const result = await mutateMonthlyExport(pool, req.params.effectRef, { status: "failed", error: req.body.error });
      return result.status === 200 ? { exports: result.exports } : fail(reply, result.status, result.code, result.message);
    },
  );
  // failed → pending_export 只在显式再导出时发生，不自动重试
  app.post(
    "/api/dri/monthly-exports/:effectRef/re-export",
    { onRequest: requireServiceToken(env.driServiceToken), schema: { params: exportParams } },
    async (req, reply) => {
      const result = await mutateMonthlyExport(pool, req.params.effectRef, { status: "pending_export" });
      return result.status === 200 ? { exports: result.exports } : fail(reply, result.status, result.code, result.message);
    },
  );

  return app;
}
