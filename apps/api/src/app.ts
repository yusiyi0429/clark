import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { Value } from "@sinclair/typebox/value";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { Pool } from "pg";
import { RadarSources, type TApiError, type TRadarSources } from "@warmap/contracts";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { loadCompanyMemory, type CompanyMemorySeedEnv } from "./companyMemory.js";
import { globalConversationContext, listConversationMissions } from "./conversationContext.js";
import { createPiConversationRuntime } from "./piConversationRuntime.js";
import type { WebSearchAdapter } from "./webSearch.js";
import type { ConversationRuntime } from "./conversations.js";
import type { RadarOutletAdapter, RadarService } from "./radar.js";
import { resolveConfiguredOutletIds } from "./outletSources.js";
import type { ResearchService } from "./research.js";
import type { PreflightAgent } from "./meetingPreflight.js";
import { createPreflightAgent } from "./preflightAgent.js";
import type { PostMeetingAgent } from "./outcome.js";
import { createPostMeetingAgent } from "./postMeetingAgent.js";
import type { DriExporter } from "./meetingStore.js";
import type { MonthlyPlanService } from "./monthlyDraft.js";
import { logEvent } from "./observability.js";
import { configureLangSmith } from "./langsmith.js";
import { ensureMaterialStorage } from "./materialParser.js";
import {
  createFail,
  createInvalidInput,
  createReadSession,
  createRequireCEO,
  createRequirePerson,
  createRequireServiceToken,
  createRespond,
  createRespondTranscriptImport,
  materialMultipartLimitError,
  type RequestContext,
  type RouteContext,
} from "./routes/shared.js";
import { registerAuthRoutes } from "./routes/auth.js";
import { registerCardRoutes } from "./routes/cards.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerRadarRoutes } from "./routes/radar.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerMeetingRoutes } from "./routes/meetings.js";
import { registerActionRoutes } from "./routes/actions.js";
import { registerDriRoutes } from "./routes/dri.js";
import { registerSystemRoutes } from "./routes/system.js";

type ValidationItem = { instancePath?: string; dataPath?: string; message?: string };

export const CONVERSATION_TURN_TIMEOUT_MS = 180_000;
/** warmap-transcript.v1 单文件上限；Web multipart 与 service API 共用。 */
export const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const DEFAULT_MATERIAL_STORAGE_DIR = "/tmp/warmap-meeting-materials";
const DEFAULT_CONVERSATION_ATTACHMENT_STORAGE_DIR = "/tmp/warmap-conversation-attachments";

export type AppEnv = {
  sessionSecret: string;
  sessionMaxAgeSeconds: number;
  publicOrigin: string;
  /** 本地开发额外允许的浏览器来源（如 127.0.0.1、局域网 IP）；线上不配，只认 publicOrigin。 */
  extraOrigins?: string[];
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
    globalContext: () => globalConversationContext(pool.query.bind(pool), new Date()),
    listMissions: (filters) => listConversationMissions(pool.query.bind(pool), filters),
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
  const requestContext = new WeakMap<FastifyRequest, RequestContext>();
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
  app.decorateRequest("person", null);
  await app.register(rateLimit, { global: false });
  // Transcript 是唯一上传格式；大小上限与 service API 共用（各上传路由用 per-request limits 收紧）
  await app.register(multipart, { limits: { fileSize: MAX_TRANSCRIPT_BYTES, files: 1, fields: 5 } });
  const materialStorageDir = env.materialStorageDir ?? DEFAULT_MATERIAL_STORAGE_DIR;
  await ensureMaterialStorage(materialStorageDir);
  const conversationAttachmentStorageDir = env.conversationAttachmentStorageDir ?? DEFAULT_CONVERSATION_ATTACHMENT_STORAGE_DIR;
  await ensureMaterialStorage(conversationAttachmentStorageDir);

  const fail = createFail(requestContext);
  const readSession = createReadSession(env, q, companyMemory);
  const requirePerson = createRequirePerson(env, readSession, fail);
  const requireCEO = createRequireCEO(requirePerson, fail);
  const requireServiceToken = createRequireServiceToken(fail);
  const invalidInput = createInvalidInput(fail);
  const respond = createRespond(fail);
  const respondTranscriptImport = createRespondTranscriptImport(fail);

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

  const ctx: RouteContext = {
    pool,
    q,
    env,
    companyMemory,
    preflight,
    outcome,
    runtime,
    radar,
    research,
    driExporter,
    monthlyPlanService,
    materialStorageDir,
    conversationAttachmentStorageDir,
    conversationTurnTimeoutMs,
    maxTranscriptBytes: MAX_TRANSCRIPT_BYTES,
    now,
    requestContext,
    fail,
    requireCEO,
    requirePerson,
    readSession,
    requireServiceToken,
    invalidInput,
    respond,
    respondTranscriptImport,
    materialMultipartLimitError,
  };

  registerAuthRoutes(app, ctx);
  registerCardRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerRadarRoutes(app, ctx);
  registerConversationRoutes(app, ctx);
  registerMeetingRoutes(app, ctx);
  registerActionRoutes(app, ctx);
  registerDriRoutes(app, ctx);
  registerSystemRoutes(app, ctx);

  return app;
}
