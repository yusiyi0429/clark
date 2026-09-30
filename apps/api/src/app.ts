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
import type { PersonalRadarService } from "./personalRadar.js";
import { resolveConfiguredOutletIds } from "./outletSources.js";
import type { ResearchService } from "./research.js";
import type { PreflightAgent } from "./meetingPreflight.js";
import { createPreflightAgent } from "./preflightAgent.js";
import { onOutcomeReviewed, pendingOntologyUpdater, type OntologyUpdater, type PostMeetingAgent } from "./outcome.js";
import { WorldClient, worldConfigured, type WorldEnv } from "./worldClient.js";
import { createWorldMeetingService } from "./worldMeetingEvents.js";
import { createPostMeetingAgent } from "./postMeetingAgent.js";
import type { DriExporter } from "./meetingStore.js";
import type { MonthlyPlanService } from "./monthlyDraft.js";
import type { MonthlyReviewService } from "./monthlyReviewService.js";
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
import { registerMaterialRoutes } from "./routes/materials.js";
import { registerActionRoutes } from "./routes/actions.js";
import { registerDriRoutes } from "./routes/dri.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerThreadRoutes } from "./routes/threads.js";
import { registerRecordingRoutes } from "./routes/recordings.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerMissionCardRoutes } from "./routes/missionCards.js";
import { registerMyRadarRoutes } from "./routes/myRadar.js";
import { registerOntologyRoutes } from "./routes/ontology.js";
import { registerMonthlyReviewRoutes } from "./routes/monthlyReviews.js";
import { createMeetingRecordingService, DEFAULT_RECORDING_STORAGE_DIR, type MeetingRecordingService } from "./meetingRecordings.js";
import { realVoiceprintDeps, type VoiceprintDeps } from "./voiceprints.js";
import { realDictationDeps, type DictationDeps } from "./dictation.js";
import { createThreadIntroAgent, type ThreadIntroAgent } from "./threadIntro.js";

type ValidationItem = { instancePath?: string; dataPath?: string; message?: string };

export const CONVERSATION_TURN_TIMEOUT_MS = 180_000;
/** warmap-transcript.v1 单文件上限；Web multipart 与 service API 共用。 */
export const MAX_TRANSCRIPT_BYTES = 1024 * 1024;
const DEFAULT_MATERIAL_STORAGE_DIR = "/tmp/warmap-meeting-materials";
export const DEFAULT_CONVERSATION_ATTACHMENT_STORAGE_DIR = "/tmp/warmap-conversation-attachments";

export type AppEnv = {
  sessionSecret: string;
  sessionMaxAgeSeconds: number;
  publicOrigin: string;
  /** 本地开发额外允许的浏览器来源（如 127.0.0.1、局域网 IP）；线上不配，只认 publicOrigin。 */
  extraOrigins?: string[];
  /**
   * 演示入口：登录页右下角「天枢系统」免口令进入这个登录 ID。只有时间机器在代码里设置；
   * 正式环境不从环境变量读取，接口不注册。
   */
  demoLoginId?: string;
  /** 引导中的公司名，可空；不从其他资料猜测。 */
  companyName?: string;
  /** mission-card-drafts.v1 占位文件目录；未配置时使用仓库 seed/placeholders。 */
  missionCardDraftsDir?: string;
  driServiceToken: string;
  ontologyServiceToken?: string;
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
  /** 会议录音卷（分片、拼好的 webm、转码后的 mp3、厂商原文）；与材料卷隔离。 */
  recordingStorageDir?: string;
} & CompanyMemorySeedEnv & WorldEnv;

export async function buildApp({
  pool,
  env,
  conversationRuntime,
  radarService,
  personalRadarService,
  researchService,
  preflightAgent,
  outcomeAgent,
  driExporter,
  ontologyUpdater = pendingOntologyUpdater,
  monthlyPlanService,
  monthlyReviewService,
  recordingService,
  voiceprintDeps = realVoiceprintDeps,
  dictationDeps = realDictationDeps,
  threadIntroAgent,
  webSearch,
  outlets,
  conversationTurnTimeoutMs = CONVERSATION_TURN_TIMEOUT_MS,
  now = () => new Date(),
}: {
  pool: Pool;
  env: AppEnv;
  conversationRuntime?: ConversationRuntime;
  radarService?: RadarService;
  /** 个人雷达扫描队列；缺省为不扫描的桩（server.ts 注入与公司雷达共用博查与发布方 adapter 的真实服务）。 */
  personalRadarService?: PersonalRadarService;
  researchService?: ResearchService;
  preflightAgent?: PreflightAgent;
  outcomeAgent?: PostMeetingAgent;
  driExporter?: DriExporter;
  /** CEO 确认战略议题后的本体更新；缺省不做事、请求保持 pending（co-agent 同事实现真实 Agent）。 */
  ontologyUpdater?: OntologyUpdater;
  monthlyPlanService?: MonthlyPlanService;
  /** 月末复盘的起草、评估、汇总；缺省时 open 返回 503，其余生成不运行。 */
  monthlyReviewService?: MonthlyReviewService;
  /** 会议录音流水线；缺省按 env.recordingStorageDir 装配真实 ffmpeg/TOS/火山依赖（server.ts 注入以便启动时恢复）。 */
  recordingService?: MeetingRecordingService;
  /** 本人声纹录入/删除用的 ffmpeg 与腾讯云依赖；缺省为真实实现（测试注入假实现）。 */
  voiceprintDeps?: VoiceprintDeps;
  /** 输入框语音转文字用的 ffmpeg 与火山极速版；缺省为真实实现（测试注入假实现）。 */
  dictationDeps?: DictationDeps;
  threadIntroAgent?: ThreadIntroAgent;
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
    materialPool: pool,
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
    runManual: async () => ({ trigger: "manual" as const, status: "failed" as const, companyDay: new Date().toISOString().slice(0, 10), createdSignals: 0, warnings: ["雷达服务尚未配置，请联系运营者完成配置。"] }),
    runScheduled: async () => ({ trigger: "scheduled" as const, status: "failed" as const, companyDay: new Date().toISOString().slice(0, 10), createdSignals: 0, warnings: ["雷达服务尚未配置，请联系运营者完成配置。"] }),
  };
  const personalRadar: PersonalRadarService = personalRadarService ?? {
    providerStatus: { webSearch: false },
    enqueue() {},
    async runScheduled() {},
    async recoverStaleRuns() {},
    async idle() {},
  };
  // 线上链路是 宿主机 Nginx → Caddy → API，两跳都经 Docker 内网：信任内网地址上的代理，
  // req.ip（登录限流的键）才是用户而不是 Caddy；用户在最前面伪造的 X-Forwarded-For 越不过第一个公网地址
  const app = Fastify({ logger: false, trustProxy: "loopback,uniquelocal" }).withTypeProvider<TypeBoxTypeProvider>();
  // 未注入真实 Runner 时不虚构预研：Issue 保留 pending，等显式配置
  const research = researchService ?? {
    async start() {},
    async executeRun() {},
    async idle() {},
  };
  app.addHook("onClose", async () => {
    await research.idle();
    await personalRadar.idle();
    await runtime.close?.();
  });
  const q = pool.query.bind(pool);
  if (worldConfigured(env)) {
    const worldMeetings = createWorldMeetingService(pool, new WorldClient(q, env), env.publicOrigin, now);
    const unsubscribe = onOutcomeReviewed(pool, worldMeetings.schedule);
    app.addHook("onClose", async () => { unsubscribe(); await worldMeetings.close(); });
  }
  // 每个请求的结构化日志上下文：handler 里补充 action/run 字段，onResponse 统一落一条。
  const requestContext = new WeakMap<FastifyRequest, RequestContext>();
  app.addHook("onResponse", async (req, reply) => {
    const ctx = requestContext.get(req) ?? {};
    logEvent({
      event: "http.request",
      requestId: String(req.id),
      method: req.method,
      url: req.url,
      clientIp: req.ip,
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
  const recordingStorageDir = env.recordingStorageDir ?? DEFAULT_RECORDING_STORAGE_DIR;
  await ensureMaterialStorage(recordingStorageDir);
  const recordings = recordingService ?? createMeetingRecordingService({ pool, storageDir: recordingStorageDir, companyMemory });
  // 关闭时只停轮询：在途的识别停在 transcribing，下次启动 recoverInterrupted 接着轮询
  app.addHook("onClose", async () => recordings.close());

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
    personalRadar,
    research,
    driExporter,
    ontologyUpdater,
    monthlyPlanService,
    monthlyReviewService,
    recordings,
    voiceprints: voiceprintDeps,
    dictation: dictationDeps,
    threadIntroAgent: threadIntroAgent ?? createThreadIntroAgent(pool, env),
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
  registerMaterialRoutes(app, ctx);
  registerActionRoutes(app, ctx);
  registerDriRoutes(app, ctx);
  registerOntologyRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
  registerThreadRoutes(app, ctx);
  registerRecordingRoutes(app, ctx);
  registerMeRoutes(app, ctx);
  registerOnboardingRoutes(app, ctx);
  registerMissionCardRoutes(app, ctx);
  registerMyRadarRoutes(app, ctx);
  registerMonthlyReviewRoutes(app, ctx);

  return app;
}
