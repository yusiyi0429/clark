import { setMaterialClock } from "./objectMaterials.js";
import Fastify, { type FastifyError, type FastifyInstance, type FastifyReply, type FastifyRequest } from "fastify";
import { Value } from "@sinclair/typebox/value";
import { TypeBoxTypeProvider } from "@fastify/type-provider-typebox";
import type { Pool } from "pg";
import { RadarSources, type TApiError, type TRadarSources } from "@warmap/contracts";
import rateLimit from "@fastify/rate-limit";
import multipart from "@fastify/multipart";
import { loadPeopleDirectory, type PeopleDirectoryEnv } from "./peopleDirectory.js";
import { createCompanyContext, type CompanyContextEnv } from "./companyContext.js";
import { createPersonalMemory } from "./personalMemory.js";
import { createMemoryRecall, memoryRecallModels, type MemoryRecall } from "./personalMemoryRecall.js";
import { createPersonalDistillation } from "./personalDistillation.js";
import { registerPersonalMemoryRoutes } from "./routes/personalMemory.js";
import { registerMemoryImportRoutes } from "./routes/memoryImports.js";
import { createMemoryImports } from "./memoryImports.js";
import { createMemoryImportModel } from "./memoryImportAgent.js";
import type { MemoryImportModel } from "./memoryImport.js";
import { globalConversationContext, listConversationMissions } from "./conversationContext.js";
import { listBattlefieldRows } from "./battlefields.js";
import { createResponsesThinkingTranslator, createResponsesThoughtTranslator, createResponsesTriage } from "./conversationRouting.js";
import { conversationModelApi, conversationTierModels, parseTierThinking } from "./conversationModel.js";
import { createPiConversationRuntime } from "./piConversationRuntime.js";
import type { WebSearchAdapter } from "./webSearch.js";
import type { ConversationRuntime } from "./conversations.js";
import { createConversationCompaction, type ConversationCompactionOptions } from "./conversationCompaction.js";
import type { RadarOutletAdapter, RadarService } from "./radar.js";
import type { PersonalRadarService } from "./personalRadar.js";
import { resolveConfiguredOutletIds } from "./outletSources.js";
import { resumeResearch, type ResearchService } from "./research.js";
import { resumePreflights, type PreflightAgent } from "./meetingPreflight.js";
import { createPreflightAgent, createPreflightThoughtTranslator, preflightThinkingLevel } from "./preflightAgent.js";
import { agentModel, type AgentModelEnv } from "./agentModels.js";
import type { PostMeetingAgent } from "./outcome.js";
import { WorldClient, worldConfigured, type WorldEnv } from "./worldClient.js";
import { companyPeriod } from "./monthlyPlans.js";
import { createWorldReader, mergeWorldGoalsIntoContext, ontologyToolResult, type OntologyQuery } from "./worldReader.js";
import { createPostMeetingAgent } from "./postMeetingAgent.js";
import type { DriExporter, Query } from "./meetingStore.js";
import type { MonthlyPlanService } from "./monthlyDraft.js";
import type { MonthlyReviewService } from "./monthlyReviewService.js";
import type { WeeklyReviewService } from "./weeklyReviewService.js";
import { createWeeklyReviewWorldSync, type WeeklyReviewWorldSync } from "./weeklyReviewWorld.js";
import { createWorldPeriodGoalService, type WorldPeriodGoalService } from "./worldPeriodGoals.js";
import { logEvent } from "./observability.js";
import { clientTagFor, enterRequestClient, tracingEnabled } from "./tracing.js";
import type { FeishuEnv } from "./feishu/config.js";
import { createFeishuClient, type FeishuClient } from "./feishu/client.js";
import { createFeishuChat, type FeishuChat } from "./feishuChat.js";
import { registerFeishuAuthRoutes } from "./routes/feishu.js";
import { createMeetingFollowThrough, type MeetingFollowThrough } from "./meetingFollowThrough.js";
import type { ImpactAgent } from "./impactAgent.js";
import type { FeishuCalendarApi } from "./feishu/calendar.js";
import type { FeishuMinutesApi } from "./feishu/minutes.js";
import { registerMeetingFollowThroughRoutes } from "./routes/meetingFollowThrough.js";
import { registerInternalMeetingRoutes } from "./routes/internalMeetings.js";
import { createDocChangeAgent, type DocChangeAgent } from "./docChangeAgent.js";
import { createDocChangeService, type DocChangeService } from "./docChanges.js";
import { registerDocChangeRoutes } from "./routes/docChanges.js";
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
import { registerMcpOAuthRoutes } from "./routes/mcpOAuth.js";
import { registerCardRoutes } from "./routes/cards.js";
import { registerConfigRoutes } from "./routes/config.js";
import { registerRadarRoutes } from "./routes/radar.js";
import { registerConversationRoutes } from "./routes/conversations.js";
import { registerMeetingRoutes } from "./routes/meetings.js";
import { registerMaterialRoutes } from "./routes/materials.js";
import type { MaterialAnnotationAgent } from "./materialAnnotationAgent.js";
import type { MissionCardAnnotationAgent } from "./missionCardAnnotationAgent.js";
import type { MissionCardReviewAgent } from "./missionCardReview.js";
import { createMissionCardDraftAgent, type MissionCardDraftAgent } from "./missionCardDraftAgent.js";
import { registerActionRoutes } from "./routes/actions.js";
import { registerDriRoutes } from "./routes/dri.js";
import { registerSystemRoutes } from "./routes/system.js";
import { registerThreadRoutes } from "./routes/threads.js";
import { registerRecordingRoutes } from "./routes/recordings.js";
import { registerMeRoutes } from "./routes/me.js";
import { registerTaskQualityRoutes } from "./routes/taskQuality.js";
import { registerOnboardingRoutes } from "./routes/onboarding.js";
import { registerSeenMarkRoutes } from "./routes/seenMarks.js";
import { registerMissionCardRoutes } from "./routes/missionCards.js";
import { registerMyRadarRoutes } from "./routes/myRadar.js";
import { registerOntologyRoutes } from "./routes/ontology.js";
import { registerMonthlyReviewRoutes } from "./routes/monthlyReviews.js";
import { registerRequestRoutes } from "./routes/requests.js";
import { createRequestAgent, type RequestAgent } from "./delivery/requestAgent.js";
import { createCollectionAgent, type CollectionAgent } from "./collectionAgent.js";
import { collectionJobs, type CollectionDeps } from "./collections.js";
import { createFeishuBitable, createMockBitable, type BitableAdapter } from "./feishu/bitable.js";
import { feishuNotifier } from "./feishu/notify.js";
import { registerCollectionRoutes } from "./routes/collections.js";
import type { JobHandler, RecurringJob } from "./jobs.js";
import { registerCollectorRoutes } from "./routes/collector.js";
import { registerWeeklyReviewRoutes } from "./routes/weeklyReviews.js";
import { registerAdminRoutes } from "./routes/admin.js";
import { createUsageTracker } from "./usage.js";
import { registerProgressRoutes } from "./routes/progress.js";
import { createBattlefieldSummaries, type BattlefieldSummaries, type BattlefieldSummaryAgent } from "./battlefieldSummary.js";
import { createBattlefieldSummaryAgent } from "./battlefieldSummaryAgent.js";
import { createTaskPlacementAgent, taskPlacementJobs, type TaskPlacementAgent } from "./taskPlacement.js";
import { createMeetingRecordingService, DEFAULT_RECORDING_STORAGE_DIR, type MeetingRecordingService } from "./meetingRecordings.js";
import { realVoiceprintDeps, type VoiceprintDeps } from "./voiceprints.js";
import { realDictationDeps, type DictationDeps } from "./dictation.js";
import { realRealtimeSessionDeps, type RealtimeSessionDeps } from "./tencentAsrRealtime.js";
import { realDictationPolishDeps, type DictationPolishDeps } from "./dictationPolish.js";
import { createThreadIntroAgent, type ThreadIntroAgent } from "./threadIntro.js";
import { createTaskAcceptanceAgent, type TaskAcceptanceAgent } from "./taskAcceptanceDraft.js";
import { createWorldPlanTaskSource, emptyPlanTaskSource, type PlanTaskSource } from "./planTasks.js";
import { personDisplayNames } from "./people.js";
import { listPendingIssueSummaries } from "./issues.js";

type ValidationItem = { instancePath?: string; dataPath?: string; message?: string };

/**
 * 首页 Task 的本体来源：主实例开了读就用它（外部引用对上的 Mission 也在它里面找）；配了 TK 只读实例也能用。
 * 从本体载入的 Mission 按 scope 找读身份（主实例优先，TK 只读实例补它没有的 scope）；两个都没有就没有 Task。
 */
function worldPlanTaskSource(q: Query, env: AppEnv, mainReads: boolean): PlanTaskSource {
  const clients = [
    ...(mainReads ? [new WorldClient(q, env)] : []),
    ...(env.worldTk && worldConfigured(env.worldTk) ? [new WorldClient(q, env.worldTk)] : []),
  ];
  if (!clients.length) return emptyPlanTaskSource;
  const scopes = new Map<string, WorldClient>();
  for (const client of clients) if (!scopes.has(client.config.scope_id)) scopes.set(client.config.scope_id, client);
  return createWorldPlanTaskSource(clients[0], { scopes });
}

/**
 * 一轮对话的绝对上限：只防死循环，不用来截断正常的长回答（10/13 起取消 180 秒硬上限）。
 * 是否卡住按进展判断：一次模型调用连续 90 秒没有任何新事件就就地恢复（conversationRecovery.ts），
 * 整轮连续 CONVERSATION_STALL_TIMEOUT_MS 没有任何事件（恢复本身也卡住了）才停下，已写出的部分保留。
 */
export const CONVERSATION_TURN_TIMEOUT_MS = 600_000;
/** 整轮连续这么久没有任何事件（没有思考、正文、工具、恢复进度）才停下；要长于单次模型调用的卡住阈值（90 秒）加上恢复的等待。 */
export const CONVERSATION_STALL_TIMEOUT_MS = 150_000;
/** SSE 心跳：每隔这么久写一行注释，代理与浏览器不会因为长时间没有数据把连接当成断了。 */
export const CONVERSATION_HEARTBEAT_MS = 15_000;
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
  /** 上手流程显示「授权天枢替你记进本体」这一步（ONBOARDING_DELEGATION_STEP=1）；本体的网页授权页确认之前默认关闭。 */
  onboardingDelegationStep?: boolean;
  /** 签发月度计划后代记本体周期目标的门（TKOS_WORLD_PERIOD_GOAL_GATES=1）；本人委托登记好之前默认关闭，只管这一项，其他本体写入不受影响。 */
  worldPeriodGoalGates?: boolean;
  /** 旧配置兼容；正式自动起草不读取文件，人工导入须由 CLI 显式指定路径。 */
  missionCardDraftsDir?: string;
  /** 已知的本月任务（飞书任务卡、本体 Mission 导出），作为起草依据；未配置或文件缺失时照常起草。 */
  missionCardKnownMissionsFile?: string;
  driServiceToken: string;
  ontologyServiceToken?: string;
  /** 独立 Chat 读确认会议的服务凭据（INTERNAL_CHAT_TOKEN）；不配时 /internal/confirmed-meetings 不注册。 */
  internalChatToken?: string;
  /**
   * 独立 Chat 服务的地址（CHAT_SERVICE_URL，如预发的 http://chat:3101）：设了，首页对话（scope=global）的历史、发送、附件改走 Chat，
   * 用 INTERNAL_CHAT_TOKEN 转发本人身份；不设走天枢自己的对话。对象页的对话不受影响。
   */
  chatServiceUrl?: string;
  buildSha: string;
  piBaseUrl: string;
  piApiKey: string;
  lightModel: string;
  heavyModel: string;
  compactionModel: string;
  /** 一号位 / DRI 对话的主答模型；不配时用 heavyModel（10/13 止血：对话从 light 换到 Sol 档并打开思考）。 */
  conversationModel?: string;
  /** 主答模型的协议（openai-responses / anthropic-messages）；不配按模型 id 推断，claude-* 走 Anthropic 协议。 */
  conversationApi?: string;
  /** 主答模型的地址；不配时 Responses 用 PI_BASE_URL，Anthropic 协议用网关根地址 + /anthropic。 */
  conversationBaseUrl?: string;
  /** 按档位覆盖思考强度，如「quick=low,grounded=medium,deep=high」；不配沿用 conversationRouting.ts 的 TIER_SETTINGS。 */
  conversationThinking?: string;
  /** 对话每轮分档的快模型分诊；不配时用 lightModel（关思考）。 */
  triageModel?: string;
  /** 个人记忆召回的快模型（MEMORY_RECALL_MODEL）；不配时依次用 triageModel、lightModel（personalMemoryRecall.ts）。 */
  memoryRecallModel?: string;
  /** 会前预审模型；不配时用 heavyModel（10/13：预审从 light 换到 Sol 档并打开思考）。 */
  preflightModel?: string;
  /** 会前预审思考强度（off / low / medium / high / xhigh）；不配时 high。 */
  preflightThinking?: string;
  /** 会后提取等候选 Agent 的模型与思考强度（OUTCOME_MODEL 等，agentModels.ts）；不配时与之前一致。 */
  agentModels?: AgentModelEnv;
  materialStorageDir?: string;
  /** 会话附件 API 卷；与 Meeting 材料卷隔离。 */
  conversationAttachmentStorageDir?: string;
  /** 会议录音卷（分片、拼好的 webm、转码后的 mp3、厂商原文）；与材料卷隔离。 */
  recordingStorageDir?: string;
  /** 第二个只读实例（词元云集 TK scope）：resolveWorldTkEnv 给出；不设 TKOS_WORLD_TK_INSTANCE 时为空（关闭）。 */
  worldTk?: WorldEnv;
  /** 飞书企业自建应用（resolveFeishuEnv）；不配时飞书接入关闭。 */
  feishu?: FeishuEnv;
  /** 管理员（TIANSHU_ADMIN_PERSON_IDS，逗号分隔的 personId）：能看管理员视图；不配时没有人能看。 */
  adminPersonIds?: string[];
  /** 飞书网页域名（FEISHU_WEB_ORIGIN）：会议事件里拼妙记链接用；不配时不带链接。 */
  feishuWebOrigin?: string;
  /** ③ 信息收集的飞书多维表格：live 以发起人身份调开放接口（要先在飞书后台开通 base 权限，见 feishu/bitable.ts）；缺省 mock，不调飞书（FEISHU_BITABLE_MODE）。 */
  collectionBitable?: "live" | "mock";
  /** ③ 信息收集（COLLECTIONS_ENABLED=1 才开，D-56）：关着时不接收集路由、不跑每分钟的收集任务、对话里没有「发起信息收集」，定时任务里不列收集项。 */
  collectionsEnabled?: boolean;
  /** ⑧ 文档变更推送（DOC_CHANGE_ENABLED=1 才开，D-56）：关着时群里贴文档链接不触发；已有的变更照常能看、能处理。 */
  docChangeEnabled?: boolean;
} & PeopleDirectoryEnv & WorldEnv & CompanyContextEnv;

declare module "fastify" {
  interface FastifyInstance {
    /** 会后链路的服务；server.ts 用它注册后台任务。 */
    meetingFollowThrough: MeetingFollowThrough;
    /** ⑧ 文档变更；server.ts 用它注册后台任务和群消息事件。 */
    docChanges: DocChangeService;
    /** ③ 信息收集的后台任务（每分钟 collection.tick）；server.ts 注册给 jobs worker。 */
    collectionJobs: { handlers: Record<string, JobHandler>; recurring: RecurringJob[] };
    /** 战场进展汇总；server.ts 用它的 jobs() 注册每天 07:30 的生成。 */
    battlefieldSummaries: BattlefieldSummaries;
    /** 会后分派的归位（task.place）；server.ts 注册给 jobs worker。 */
    taskPlacementJobs: Record<string, JobHandler>;
    feishuChat: FeishuChat | undefined;
  }
}

export async function buildApp({
  pool,
  env,
  conversationRuntime,
  personalDistillationStream,
  personalMemoryRecall,
  memoryImportModel,
  radarService,
  personalRadarService,
  researchService,
  preflightAgent,
  outcomeAgent,
  driExporter,
  monthlyPlanService,
  monthlyReviewService,
  weeklyReviewService,
  recordingService,
  voiceprintDeps = realVoiceprintDeps,
  dictationDeps = realDictationDeps,
  dictationRealtimeDeps,
  dictationPolishDeps = realDictationPolishDeps,
  threadIntroAgent,
  taskAcceptanceAgent,
  planTasks,
  materialAnnotationAgent,
  missionCardAnnotationAgent,
  missionCardReviewAgent,
  missionCardDraftAgent,
  requestAgent,
  collectionAgent,
  bitable,
  webSearch,
  outlets,
  feishuClient,
  meetingFollowThroughAgents,
  docChangeAgent,
  battlefieldSummaryAgent,
  taskPlacementAgent,
  conversationTurnTimeoutMs = CONVERSATION_TURN_TIMEOUT_MS,
  conversationStallTimeoutMs = CONVERSATION_STALL_TIMEOUT_MS,
  conversationHeartbeatMs = CONVERSATION_HEARTBEAT_MS,
  conversationCompactionOptions,
  backgroundPreflight = true,
  resumeResearchOnReady = false,
  now = () => new Date(),
}: {
  pool: Pool;
  env: AppEnv;
  conversationRuntime?: ConversationRuntime;
  /** 个人记忆提炼用的模型流（测试注入假实现）；不给时按 PI_BASE_URL 调 light 模型。 */
  personalDistillationStream?: Parameters<typeof createPersonalDistillation>[0]["streamSimple"];
  /** 个人记忆的召回模型（测试注入替身，null 表示不用模型、只按字面重合选）；不给时按 PI_BASE_URL 调分诊用的快模型。 */
  personalMemoryRecall?: MemoryRecall | null;
  /** 记忆导入的分类与去重模型（测试注入替身）；不给时按 PI_BASE_URL 调 MEMORY_IMPORT_MODEL（不配时 LIGHT_MODEL）。 */
  memoryImportModel?: MemoryImportModel;
  radarService?: RadarService;
  /** 个人雷达扫描队列；缺省为不扫描的桩（server.ts 注入与公司雷达共用博查与发布方 adapter 的真实服务）。 */
  personalRadarService?: PersonalRadarService;
  researchService?: ResearchService;
  preflightAgent?: PreflightAgent;
  outcomeAgent?: PostMeetingAgent;
  driExporter?: DriExporter;
  monthlyPlanService?: MonthlyPlanService;
  /** 月末复盘的起草、评估、汇总；缺省时 open 返回 503，其余生成不运行。 */
  monthlyReviewService?: MonthlyReviewService;
  /** 周复盘生成（周五定时与本人重新生成）；缺省时重新生成返回 503。 */
  weeklyReviewService?: WeeklyReviewService;
  /** 会议录音流水线；缺省按 env.recordingStorageDir 装配真实 ffmpeg/TOS/火山依赖（server.ts 注入以便启动时恢复）。 */
  recordingService?: MeetingRecordingService;
  /** 本人声纹录入/删除用的 ffmpeg 与腾讯云依赖；缺省为真实实现（测试注入假实现）。 */
  voiceprintDeps?: VoiceprintDeps;
  /** 输入框语音转文字用的 ffmpeg 与火山极速版；缺省为真实实现（测试注入假实现）。 */
  dictationDeps?: DictationDeps;
  /** 实时听写签发用的配置读取与真实时钟；缺省为真实实现（测试只覆盖其中几项）。 */
  dictationRealtimeDeps?: Partial<RealtimeSessionDeps>;
  /** 听写快速整理用的方舟配置与客户端；缺省为真实实现（测试注入假实现）。 */
  dictationPolishDeps?: DictationPolishDeps;
  threadIntroAgent?: ThreadIntroAgent;
  taskAcceptanceAgent?: TaskAcceptanceAgent;
  /** 首页 Task 行的来源；缺省一个 Task 都没有（测试注入假实现）。 */
  planTasks?: PlanTaskSource;
  materialAnnotationAgent?: MaterialAnnotationAgent;
  missionCardAnnotationAgent?: MissionCardAnnotationAgent;
  missionCardReviewAgent?: MissionCardReviewAgent;
  /** 任务卡起草 Co-Agent；缺省用 heavy 模型槽位（测试注入假实现）。 */
  missionCardDraftAgent?: MissionCardDraftAgent;
  /** 送达通道（⑨ 传话）的起草、查答案、起草回答；缺省用 light 模型槽位（测试注入假实现）。 */
  requestAgent?: RequestAgent;
  /** ③ 信息收集的起草；缺省用 light 模型槽位（测试注入假实现）。 */
  collectionAgent?: CollectionAgent;
  /** ③ 信息收集的飞书多维表格适配层；缺省按 env.collectionBitable 装配（测试注入假表）。 */
  bitable?: BitableAdapter;
  /** Pi web_search Tool 的真实 Provider；缺失时 Tool 调用如实失败（不伪装已配置）。 */
  webSearch?: WebSearchAdapter;
  /** 发布方级 feed adapter：Radar、预研与全局对话共用同一白名单来源。 */
  outlets?: RadarOutletAdapter;
  /** 飞书开放接口；缺省按 env.feishu 装配真实客户端（测试注入假实现）。 */
  feishuClient?: FeishuClient;
  /** 影响卡追问、妙记与日历接口（测试注入假实现）；缺省用 heavy 模型与真实飞书接口。 */
  meetingFollowThroughAgents?: { impact?: ImpactAgent; minutesApi?: FeishuMinutesApi; calendarApi?: FeishuCalendarApi };
  /** 文档变更找候选的 Agent（测试注入假实现）；缺省用快模型。 */
  docChangeAgent?: DocChangeAgent;
  /** 战场进展汇总的 Agent（测试注入假实现）；缺省 PROGRESS_SUMMARY_MODEL，不配时 HEAVY_MODEL、思考 medium。 */
  battlefieldSummaryAgent?: BattlefieldSummaryAgent;
  /** 会后事项归位的 Agent（测试注入假实现）；缺省 TASK_PLACEMENT_MODEL，不配时 LIGHT_MODEL、不开思考。 */
  taskPlacementAgent?: TaskPlacementAgent;
  conversationTurnTimeoutMs?: number;
  conversationStallTimeoutMs?: number;
  conversationHeartbeatMs?: number;
  /** 对话历史后台压缩的阈值等（conversationCompaction.ts；测试用，缺省按模块常量）。 */
  conversationCompactionOptions?: Omit<ConversationCompactionOptions, "query" | "summarize">;
  /** 默认 true：内建的真实预审 Agent 在后台跑。测试夹具关掉，避免后台写入和断言抢版本号。 */
  backgroundPreflight?: boolean;
  /** 演示场次启用：启动后在后台为还没有预研的待决议题补跑预研（并发 3 个），会前预审等它跑完再补跑。默认关：正式环境仍等 CEO 显式重试。 */
  resumeResearchOnReady?: boolean;
  /** 业务时钟；通知与战场投影按公司月读取同一持久对象。 */
  now?: () => Date;
}): Promise<FastifyInstance> {
  // 材料上传与修订按本应用的业务时钟记时间（演示场次＝资料截至时间），与回执、计划修订同一时钟。
  setMaterialClock(pool, now);
  // seed 缺失/不合规 → 启动即失败，不虚构人员或空目录（Ticket 16 装载真实 seed）
  const peopleDirectory = loadPeopleDirectory(env);
  // 本体只读公司事实（company.ts）：对话按本人授权读；后台服务按 COMPANY_SYSTEM_PERSON_ID 的授权读。读不到时如实说没读到，不用本地资料兜底。
  const company = createCompanyContext(env);
  // 分诊与思考翻译用的快模型（TRIAGE_MODEL，不配时 LIGHT_MODEL）；TRIAGE_MODEL 出错时退回 LIGHT_MODEL 再试一次。
  const fastModels = { modelId: env.triageModel || env.lightModel, fallbackModelId: env.lightModel };
  // 真实预审 Agent 在后台跑：建会、加入会议、重试预审的接口写完就返回（巡检 P1-5/6）；注入的测试替身保持同步，除非自己声明 background。
  const preflight: PreflightAgent = preflightAgent ?? { ...await createPreflightAgent({
    query: pool.query.bind(pool),
    company,
    baseUrl: env.piBaseUrl,
    apiKey: env.piApiKey,
    // 预审换 Sol 档并打开思考（PREFLIGHT_MODEL / PREFLIGHT_THINKING 可改）；英文思考小标题由快模型译成中文要点。
    modelId: env.preflightModel || env.heavyModel,
    thinkingLevel: preflightThinkingLevel(env.preflightThinking),
    translateThought: env.piBaseUrl && env.piApiKey
      ? createPreflightThoughtTranslator({ baseUrl: env.piBaseUrl, apiKey: env.piApiKey, ...fastModels })
      : undefined,
  }), background: backgroundPreflight };
  // 会后提取：OUTCOME_MODEL / OUTCOME_THINKING 可改，不配时 HEAVY_MODEL、不开思考（agentModels.ts）。
  const outcome = outcomeAgent ?? createPostMeetingAgent({
    query: pool.query.bind(pool),
    baseUrl: env.piBaseUrl,
    apiKey: env.piApiKey,
    ...agentModel(env.agentModels, "outcome", { modelId: env.heavyModel }),
  });
  const readOutletFeed = outlets ? async (signal: AbortSignal) => {
    const config = await pool.query("SELECT lookback_hours, sources FROM radar_config WHERE id = 'default'");
    const row = config.rows[0] as { lookback_hours: number; sources: unknown } | undefined;
    if (!row || !Value.Check(RadarSources, row.sources)) throw new Error("RadarConfig is invalid");
    const outletIds = resolveConfiguredOutletIds(row.sources as TRadarSources);
    if (!outletIds.length) throw new Error("Radar 未配置启用的发布方媒体来源");
    return outlets.fetchLatest({ outletIds, lookbackHours: row.lookback_hours }, signal);
  } : undefined;
  // 本体（tkos.world）只读集成：未配置时 reader 不发请求；读失败一律回退本地，不影响启动和页面。
  // 读取时间用真实时钟（演示场次的业务时钟是资料截至时间，不能用来标「读自本体」的时刻）。
  const world = createWorldReader({ q: pool.query.bind(pool), env });
  // 第二个只读实例（TK scope，写死只读）：默认关闭；开了也只做健康探测和快照缓存，还没接进战场卡与 read_ontology。
  const worldTk = env.worldTk ? createWorldReader({ q: pool.query.bind(pool), env: env.worldTk }) : undefined;
  const baseGlobalContext = () => globalConversationContext(pool.query.bind(pool), now(), personDisplayNames(peopleDirectory));
  // 每轮上下文包不加本体摘要（对话质量诊断 §4-G：上下文包每轮整包进历史）；只把战场长期目标换成本体版本（字数不增），本体内容经按需工具 read_ontology 读。
  const globalContext = async () => {
    const context = await baseGlobalContext();
    const snapshot = world.enabled ? await world.snapshot(2_000).catch(() => null) : null;
    return snapshot ? mergeWorldGoalsIntoContext(context, snapshot) : context;
  };
  const readOntology = world.enabled ? async (query: OntologyQuery) => {
    const snapshot = await world.snapshot().catch(() => null);
    return snapshot ? ontologyToolResult(snapshot, companyPeriod(now()), query) : null;
  } : undefined;
  const tierModels = conversationTierModels({ defaultModel: env.heavyModel, conversationModel: env.conversationModel });
  // 个人记忆（PR #12）：只有本人可见，不写进本体；后台按对话提炼。每轮由快模型（MEMORY_RECALL_MODEL，与分诊分开配）从本人的记忆目录里挑相关条目（personalMemoryRecall.ts）。
  const recall = personalMemoryRecall === undefined
    ? (env.piBaseUrl && env.piApiKey ? createMemoryRecall({ baseUrl: env.piBaseUrl, apiKey: env.piApiKey, ...memoryRecallModels(env) }) : undefined)
    : personalMemoryRecall ?? undefined;
  const personalMemory = createPersonalMemory({ pool, recall });
  // 记忆导入（7a-3）：分类与去重用轻模型（MEMORY_IMPORT_MODEL / MEMORY_IMPORT_THINKING，不配时 LIGHT_MODEL、不开思考）。
  const importModelChoice = agentModel(env.agentModels, "memoryImport", { modelId: env.lightModel });
  const memoryImports = createMemoryImports({ pool, personalMemory, model: (personId) => memoryImportModel
    ?? (env.piBaseUrl && env.piApiKey ? createMemoryImportModel({ query: pool.query.bind(pool), baseUrl: env.piBaseUrl, apiKey: env.piApiKey, personId, ...importModelChoice }) : null) });
  const personalDistillation = createPersonalDistillation({ pool, memory: personalMemory, baseUrl: env.piBaseUrl, apiKey: env.piApiKey,
    modelId: env.lightModel, streamSimple: personalDistillationStream });
  const runtime = conversationRuntime ?? await createPiConversationRuntime({
    peopleDirectory,
    company: company.company,
    materialPool: pool,
    missionCardSecret: env.sessionSecret,
    now,
    baseUrl: env.piBaseUrl,
    apiKey: env.piApiKey,
    // 按档位选主答模型：CONVERSATION_MODEL 不配时快答 HEAVY_MODEL、检索问答 Sonnet、深度 Opus；配一个 id 时三档都用它（conversationModel.ts）。
    modelId: tierModels.quick,
    tierModels,
    // 各档都是同一个主答模型时（预发、正式站都是 HEAVY_MODEL）上游一出错就无处可换：LIGHT_MODEL 作最后的备用（10/26 网关约 70 秒只拒 sol 关思考的请求）。
    fallbackModelId: env.lightModel,
    ...(env.conversationApi ? { modelApi: conversationModelApi(tierModels.quick, env.conversationApi) } : {}),
    ...(env.conversationBaseUrl ? { modelBaseUrl: env.conversationBaseUrl } : {}),
    ...(env.conversationThinking ? { tierThinking: parseTierThinking(env.conversationThinking) } : {}),
    compactionModelId: env.compactionModel,
    triage: env.piBaseUrl && env.piApiKey
      ? createResponsesTriage({ baseUrl: env.piBaseUrl, apiKey: env.piApiKey, ...fastModels })
      : undefined,
    // 英文推理摘要的小标题译成一句中文思考要点（与分诊同一个快模型、关思考）。
    translateThought: env.piBaseUrl && env.piApiKey
      ? createResponsesThoughtTranslator({ baseUrl: env.piBaseUrl, apiKey: env.piApiKey, ...fastModels })
      : undefined,
    // Claude 的英文思考摘要按段译成中文上屏（同一个快模型、关思考）。
    translateThinking: env.piBaseUrl && env.piApiKey
      ? createResponsesThinkingTranslator({ baseUrl: env.piBaseUrl, apiKey: env.piApiKey, ...fastModels })
      : undefined,
    search: webSearch,
    outletFeed: readOutletFeed,
    globalContext,
    // 给分诊判断问题涉及哪些战场：只读战场配置表，不等本体快照。
    listBattlefields: async () => (await listBattlefieldRows(pool.query.bind(pool))).map(({ id, code, name }) => ({ id, code, name })),
    readOntology,
    listMissions: (filters, viewer) => listConversationMissions(pool.query.bind(pool), filters, viewer),
    // 对话只读工具：实时待决策 Issue 清单（不含签名 Action，不可写入）。
    listPendingIssues: () => listPendingIssueSummaries(pool.query.bind(pool)),
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
  // LangSmith 接入方（tags client:*）：按请求路径与部署判定，本请求派生的 Agent 执行都带它。追踪未启用时不注册。
  // 回调式 hook：enterWith 之后同步调用 done，后续处理函数继承这个上下文。
  if (tracingEnabled()) {
    const sandboxDeployment = Boolean(env.demoLoginId);
    app.addHook("onRequest", (req, _reply, done) => {
      try { enterRequestClient(clientTagFor(req.url, sandboxDeployment)); } catch { /* 追踪失败不影响请求 */ }
      done();
    });
  }
  // 未注入真实 Runner 时不虚构预研：Issue 保留 pending，等显式配置
  const research = researchService ?? {
    async start() {},
    async executeRun() {},
    async idle() {},
  };
  // 启动后在后台补跑：先补还没有预研的议题（演示场次），再补没跑过或被打断的会前预审——预审要读议题预研，等预研跑完（成功或失败）再开始。
  const resumeResearchFirst = resumeResearchOnReady && Boolean(researchService);
  let closing = false;
  if (preflight.background || resumeResearchFirst) app.addHook("onReady", async () => {
    void (async () => {
      if (resumeResearchFirst) {
        await resumeResearch(pool.query.bind(pool), research, { concurrency: 3, stopped: () => closing }).catch(() => app.log.error("research resume failed"));
      }
      if (preflight.background && !closing) {
        await resumePreflights(pool, peopleDirectory, preflight).catch(() => app.log.error("preflight resume failed"));
      }
    })();
  });
  // 对话历史的后台压缩：运行时提供写摘要的模型时才做（测试替身没有就只靠窗口兜底）。
  const conversationCompaction = createConversationCompaction({
    query: pool.query.bind(pool),
    ...(runtime.summarizeHistory ? { summarize: runtime.summarizeHistory.bind(runtime) } : {}),
    ...conversationCompactionOptions,
  });
  app.addHook("onReady", async () => {
    void conversationCompaction.recoverInterrupted().catch(() => app.log.error("conversation compaction recovery failed"));
  });
  app.addHook("onClose", async () => {
    closing = true;
    await research.idle();
    await personalRadar.idle();
    await conversationCompaction.idle();
    await runtime.close?.();
  });
  const q = pool.query.bind(pool);
  // 会后链路（妙记、分层确认、影响卡）：路由用它的服务；后台任务由 server.ts 的 jobs worker 按 app.meetingFollowThrough.jobs() 注册。
  // 写本体只按方案 A 一条决定记一条事件（实例配置允许写时）；原来「整场会记一条事件」已停用。
  const followThrough = createMeetingFollowThrough({ pool, env, peopleDirectory, world, outcomeAgent: outcome, now, ...meetingFollowThroughAgents });
  app.decorate("meetingFollowThrough", followThrough);
  // ③ 信息收集：路由、对话入口和后台任务共用一份依赖；飞书通知配了飞书才发。
  const collectionDeps: CollectionDeps = {
    pool,
    bitable: bitable ?? (env.collectionBitable === "live" && env.feishu ? createFeishuBitable() : createMockBitable()),
    feishu: env.feishu,
    notify: env.feishu ? feishuNotifier(q) : undefined,
    isCeo: (personId) => peopleDirectory.searchPeople(undefined).find((person) => person.personId === personId)?.roles.includes("ceo") ?? false,
    names: () => personDisplayNames(peopleDirectory),
    now,
  };
  app.decorate("collectionJobs", env.collectionsEnabled ? collectionJobs(collectionDeps) : { handlers: {}, recurring: [] });
  // 周复盘提交后按关联的 Mission、Task 写进展到本体：同样只在实例配置允许写时启用；不写时提交照常，等配好后补发。
  let weeklyReviewWorld: WeeklyReviewWorldSync | undefined;
  if (worldConfigured(env) && world.status().writes) {
    const sync = createWeeklyReviewWorldSync({ pool, client: new WorldClient(q, env), publicOrigin: env.publicOrigin, names: () => personDisplayNames(peopleDirectory) });
    weeklyReviewWorld = sync;
    app.addHook("onClose", async () => { await sync.close(); });
  }
  // 签发月度计划后代记本体同周期周期目标的门（代 RU DRI 承诺、代 CEO 确认）：实例配置允许写、且单独的开关打开时才启用。
  let worldPeriodGoals: WorldPeriodGoalService | undefined;
  if (worldConfigured(env) && world.status().writes && env.worldPeriodGoalGates) {
    const service = createWorldPeriodGoalService(pool, new WorldClient(q, env),
      () => peopleDirectory.searchPeople(undefined).find((person) => person.roles.includes("ceo"))?.personId);
    worldPeriodGoals = service;
    app.addHook("onClose", async () => { await service.close(); });
  }
  // 每个请求的结构化日志上下文：handler 里补充 action/run 字段，onResponse 统一落一条。
  const requestContext = new WeakMap<FastifyRequest, RequestContext>();
  // 使用周报的「哪天用过」：登录后发问或改动（非 GET 的请求；上手步骤上报本身不算），一人一天记一次。页面打开、轮询不算。
  const usage = createUsageTracker(q, now);
  app.addHook("onResponse", async (req, reply) => {
    if (req.person && reply.statusCode < 400 && req.method !== "GET" && req.method !== "HEAD" && req.routeOptions.url !== "/api/me/usage/onboarding-step") {
      usage.active(req.person.personId);
    }
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
  const recordings = recordingService ?? createMeetingRecordingService({ pool, storageDir: recordingStorageDir, peopleDirectory, publicOrigin: env.publicOrigin });
  // 关闭时只停轮询：在途的识别停在 transcribing，下次启动 recoverInterrupted 接着轮询
  app.addHook("onClose", async () => recordings.close());

  const fail = createFail(requestContext);
  const readSession = createReadSession(env, q, peopleDirectory);
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

  // 启动时验证本体连通（只读，后台进行）：失败只记进健康状态，不影响启动。
  // 第二个只读实例（TK）配了的话排在主实例之后探测：两个实例串行，不并发。
  const tkConfigured = Boolean(env.worldTk && worldConfigured(env.worldTk));
  if (worldConfigured(env) || tkConfigured) app.addHook("onReady", async () => {
    void (async () => {
      if (worldConfigured(env)) await world.check().catch(() => undefined);
      if (worldTk && tkConfigured) await worldTk.check().catch(() => undefined);
    })();
  });

  personalDistillation.start();
  app.addHook("onClose", async () => personalDistillation.close());

  const ctx: RouteContext = {
    world,
    worldTk,
    pool,
    q,
    env,
    peopleDirectory,
    company,
    personalMemory,
    personalDistillation,
    preflight,
    outcome,
    runtime,
    radar,
    personalRadar,
    research,
    driExporter,
    monthlyPlanService,
    monthlyReviewService,
    weeklyReviewService,
    weeklyReviewWorld,
    worldPeriodGoals,
    collections: env.collectionsEnabled ? { agent: collectionAgent ?? createCollectionAgent(pool, env), deps: collectionDeps } : undefined,
    recordings,
    voiceprints: voiceprintDeps,
    dictation: dictationDeps,
    dictationRealtime: { ...realRealtimeSessionDeps, ...dictationRealtimeDeps },
    dictationPolish: dictationPolishDeps,
    threadIntroAgent: threadIntroAgent ?? createThreadIntroAgent(pool, env),
    missionCardDraftAgent: missionCardDraftAgent ?? createMissionCardDraftAgent({ query: q, baseUrl: env.piBaseUrl, apiKey: env.piApiKey, modelId: env.heavyModel }),
    taskAcceptanceAgent: taskAcceptanceAgent ?? createTaskAcceptanceAgent(pool, env),
    // 首页 Task 行：本体配了、实例也开了读（和其他读本体的地方同一个开关），或配了 TK 只读实例，才从本体读（只读），否则没有 Task。
    planTasks: planTasks ?? worldPlanTaskSource(q, env, world.enabled),
    materialStorageDir,
    conversationAttachmentStorageDir,
    conversationTurnTimeoutMs,
    conversationStallTimeoutMs,
    conversationHeartbeatMs,
    conversationCompaction,
    maxTranscriptBytes: MAX_TRANSCRIPT_BYTES,
    now,
    usage,
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
  const feishuApi = feishuClient ?? (env.feishu ? createFeishuClient(env.feishu) : undefined);
  registerFeishuAuthRoutes(app, ctx, feishuApi);
  await registerMcpOAuthRoutes(app, ctx);
  registerCardRoutes(app, ctx);
  registerConfigRoutes(app, ctx);
  registerRadarRoutes(app, ctx);
  // 送达通道的轻量模型调用：请求页和对话里的「帮我问问」「请同事帮忙」共用一份。
  const deliveryAgent = requestAgent ?? createRequestAgent(pool, env);
  registerConversationRoutes(app, ctx, deliveryAgent);
  registerMeetingRoutes(app, ctx);
  registerMaterialRoutes(app, ctx, materialAnnotationAgent);
  registerActionRoutes(app, ctx);
  registerDriRoutes(app, ctx);
  registerOntologyRoutes(app, ctx);
  registerSystemRoutes(app, ctx);
  registerThreadRoutes(app, ctx);
  registerRecordingRoutes(app, ctx);
  registerMeRoutes(app, ctx);
  registerTaskQualityRoutes(app, ctx);
  registerOnboardingRoutes(app, ctx, feishuApi && env.feishu ? { client: feishuApi, env: env.feishu } : undefined);
  registerSeenMarkRoutes(app, ctx);
  registerMissionCardRoutes(app, ctx, missionCardAnnotationAgent, missionCardReviewAgent);
  registerMyRadarRoutes(app, ctx);
  registerMonthlyReviewRoutes(app, ctx);
  registerRequestRoutes(app, ctx, deliveryAgent);
  registerCollectionRoutes(app, ctx);
  registerPersonalMemoryRoutes(app, ctx);
  registerMemoryImportRoutes(app, ctx, memoryImports);
  registerCollectorRoutes(app, ctx);
  registerWeeklyReviewRoutes(app, ctx);
  registerAdminRoutes(app, ctx);
  // 战场进展汇总：页面打开时当天还没有就当场整理；每天 07:30 的生成由 server.ts 按 app.battlefieldSummaries.jobs() 注册。
  const battlefieldSummaries = createBattlefieldSummaries({
    pool, now, people: () => peopleDirectory.searchPeople(undefined),
    world: () => (world.enabled ? world.snapshot() : Promise.resolve(null)),
    agent: battlefieldSummaryAgent ?? createBattlefieldSummaryAgent({ query: q, baseUrl: env.piBaseUrl, apiKey: env.piApiKey,
      ...agentModel(env.agentModels, "progressSummary", { modelId: env.heavyModel, thinkingLevel: "medium" }) }),
  });
  app.decorate("battlefieldSummaries", battlefieldSummaries);
  app.decorate("taskPlacementJobs", taskPlacementJobs({ pool, now,
    agent: taskPlacementAgent ?? createTaskPlacementAgent({ query: q, baseUrl: env.piBaseUrl, apiKey: env.piApiKey,
      ...agentModel(env.agentModels, "taskPlacement", { modelId: env.lightModel, thinkingLevel: "off" }) }) }));
  app.addHook("onClose", async () => { await battlefieldSummaries.idle(); });
  registerProgressRoutes(app, ctx, battlefieldSummaries);
  registerMeetingFollowThroughRoutes(app, ctx, followThrough);
  registerInternalMeetingRoutes(app, ctx);
  // 文档变更：找候选用快模型；按作者身份读飞书文档元数据（不读正文）；后台任务与群消息事件由 server.ts 按 app.docChanges.jobs() 注册。
  const isCeo = (personId: string) => peopleDirectory.searchPeople(undefined).find((person) => person.personId === personId)?.roles.includes("ceo") ?? false;
  const docChanges = createDocChangeService({
    pool, now, names: () => personDisplayNames(peopleDirectory),
    agent: docChangeAgent ?? createDocChangeAgent({ query: q, baseUrl: env.piBaseUrl, apiKey: env.piApiKey, modelId: env.triageModel || env.lightModel }),
    ...(feishuApi && env.feishu ? { feishu: { client: feishuApi, env: env.feishu } } : {}),
    pathFor: (personId, requestId) => `${isCeo(personId) ? "" : "/me"}/requests/${requestId}`,
  });
  app.decorate("docChanges", env.docChangeEnabled ? docChanges : { ...docChanges, jobs: () => ({ ...docChanges.jobs(), feishuEvents: {} }) });
  registerDocChangeRoutes(app, ctx, docChanges);
  // 私聊天枢机器人：以本人身份走首页对话（feishuChat.ts）；事件由 server.ts 按 app.feishuChat.events 注册。
  const feishuChat = feishuApi ? createFeishuChat({ app, pool, client: feishuApi, env, peopleDirectory }) : undefined;
  app.decorate("feishuChat", feishuChat);
  if (feishuChat) app.addHook("onClose", async () => { await feishuChat.idle(); });

  return app;
}
