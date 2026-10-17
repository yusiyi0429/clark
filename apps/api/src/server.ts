import { join } from "node:path";
import { buildApp, DEFAULT_CONVERSATION_ATTACHMENT_STORAGE_DIR, type AppEnv } from "./app.js";
import { migrate } from "./migrate.js";
import { Pool } from "pg";
import { createRadarService } from "./radar.js";
import { createCoverImageFetcher } from "./signalCover.js";
import { createArticleFetcher } from "./articleText.js";
import { createRadarAgentAssessor } from "./radarAgent.js";
import { createRadarScheduler } from "./radarScheduler.js";
import { createPersonalRadarService } from "./personalRadar.js";
import { createPersonalRadarJudge } from "./personalRadarAgent.js";
import { createGithubTrendingReader } from "./githubTrending.js";
import { createBochaRadarWebAdapter, createWechatMcpAdapter } from "./radarSources.js";
import { createOutletFeedAdapter } from "./outletSources.js";
import { createBochaWebSearchAdapter } from "./webSearch.js";
import { recoverInterruptedResearch } from "./issues.js";
import { loadCompanyMemory } from "./companyMemory.js";
import { assignLegacyConversations } from "./conversations.js";
import { createResearchService } from "./research.js";
import { createResearchAgentRunner, researchTimeoutMs } from "./researchAgent.js";
import { agentModel, agentModelEnvFrom } from "./agentModels.js";
import { recoverInterruptedPreflight } from "./meetingPreflight.js";
import { createMonthlyPlanService } from "./monthlyDraft.js";
import { createMonthlyDraftAgent } from "./monthlyDraftAgent.js";
import { createMonthlyPlanScheduler } from "./monthlyPlanScheduler.js";
import { createMonthlyReviewService } from "./monthlyReviewService.js";
import { createPersonalReviewDraftAgent } from "./personalReviewAgent.js";
import { createMonthlyReviewAssessAgent, createMonthlyReviewDraftAgent, createMonthlyReviewSummaryAgent } from "./monthlyReviewAgents.js";
import { createMonthlyReviewScheduler } from "./monthlyReviewScheduler.js";
import { createMissionRoundScheduler } from "./missionRoundScheduler.js";
import { createCollectorHealthScheduler } from "./collector.js";
import { recoverStaleMissionDrafts } from "./missionRounds.js";
import { recoverInterruptedOutcome } from "./outcome.js";
import { personDisplayNames } from "./people.js";
import { createMeetingRecordingService, DEFAULT_RECORDING_STORAGE_DIR } from "./meetingRecordings.js";
import { resolveWorldEnv, resolveWorldTkEnv } from "./worldClient.js";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const env: AppEnv = {
  sessionSecret: requiredEnv("SESSION_SECRET"),
  sessionMaxAgeSeconds: Number(process.env.SESSION_MAX_AGE_SECONDS ?? "2592000"),
  publicOrigin: requiredEnv("PUBLIC_ORIGIN"),
  extraOrigins: (process.env.EXTRA_ALLOWED_ORIGINS ?? "").split(",").map((origin) => origin.trim()).filter(Boolean),
  driServiceToken: requiredEnv("DRI_SERVICE_TOKEN"),
  ontologyServiceToken: process.env.ONTOLOGY_SERVICE_TOKEN,
  // 本体：TKOS_WORLD_API_URL；凭证 TKOS_WORLD_AGENT_TOKEN 或 TKOS_WORLD_AGENT_TOKEN_FILE（只在内存里）；TKOS_WORLD_INSTANCE 选实例配置（缺省 mvp）。
  ...resolveWorldEnv(process.env),
  // 第二个只读实例（词元云集 TK scope）：TKOS_WORLD_TK_INSTANCE=tk 加 TKOS_WORLD_TK_TOKEN_FILE；不设就关闭。
  worldTk: resolveWorldTkEnv(process.env),
  mcpServiceToken: requiredEnv("COMPANY_MEMORY_MCP_TOKEN"),
  companyMemorySeedDir: requiredEnv("COMPANY_MEMORY_SEED_DIR"),
  companyPeopleSeed: requiredEnv("COMPANY_PEOPLE_SEED"),
  companyName: process.env.COMPANY_NAME,
  missionCardDraftsDir: process.env.MISSION_CARD_DRAFTS_DIR,
  missionCardKnownMissionsFile: process.env.MISSION_CARD_KNOWN_MISSIONS_FILE,
  piBaseUrl: requiredEnv("PI_BASE_URL"),
  piApiKey: requiredEnv("PI_API_KEY"),
  lightModel: requiredEnv("LIGHT_MODEL"),
  // 唯一预研深度使用 heavy 槽位；三槽位必须显式配置，不静默降级
  heavyModel: requiredEnv("HEAVY_MODEL"),
  compactionModel: requiredEnv("COMPACTION_MODEL"),
  // 一号位对话主答与分诊（可选）：不配时主答用 heavy 槽位、分诊用 light 槽位。
  conversationModel: process.env.CONVERSATION_MODEL || undefined,
  triageModel: process.env.TRIAGE_MODEL || undefined,
  conversationApi: process.env.CONVERSATION_API || undefined,
  conversationBaseUrl: process.env.CONVERSATION_BASE_URL || undefined,
  conversationThinking: process.env.CONVERSATION_THINKING || undefined,
  // 会前预审模型与思考强度（可选）：不配时用 heavy 槽位、思考 high。
  preflightModel: process.env.PREFLIGHT_MODEL || undefined,
  preflightThinking: process.env.PREFLIGHT_THINKING || undefined,
  // 预研、会后提取、雷达的模型与思考强度（RESEARCH_MODEL / OUTCOME_MODEL / RADAR_MODEL 等，可选，agentModels.ts）。
  agentModels: agentModelEnvFrom(process.env),
  buildSha: process.env.BUILD_SHA ?? "dev",
  materialStorageDir: process.env.MEETING_MATERIAL_STORAGE_DIR,
  conversationAttachmentStorageDir: process.env.CONVERSATION_ATTACHMENT_STORAGE_DIR,
  recordingStorageDir: process.env.MEETING_RECORDING_STORAGE_DIR,
};

const port = Number(process.env.PORT ?? "4000");

const pool = new Pool({ connectionString: requiredEnv("DATABASE_URL"), max: 10 });

const client = await pool.connect();
try {
  await migrate(client);
} finally {
  client.release();
}

const companyMemory = loadCompanyMemory(env);
await assignLegacyConversations(pool.query.bind(pool), companyMemory);
const outletAdapter = createOutletFeedAdapter({});
// 雷达与对话 web_search 共用一个博查实例：同一 BOCHA_API_KEY 的请求间隔与 429 重试只在一处生效
const bochaSearch = createBochaWebSearchAdapter({ apiKey: process.env.BOCHA_API_KEY });
const radarWeb = createBochaRadarWebAdapter(bochaSearch);
// 检索条目入库前抓原文页全文：公司雷达与个人雷达共用，每页 8 秒超时、只读前 3MB，失败如实退回检索摘要
const articleText = createArticleFetcher();
// 预研：RESEARCH_MODEL / RESEARCH_THINKING 可改，不配时 HEAVY_MODEL、不开思考；开思考或用 Claude 时时限放到 8 分钟。
const researchModel = agentModel(env.agentModels, "research", { modelId: env.heavyModel });
const researchService = createResearchService({
  pool,
  researchTimeoutMs: researchTimeoutMs(researchModel),
  runner: createResearchAgentRunner({
    query: pool.query.bind(pool),
    companyMemory,
    baseUrl: env.piBaseUrl,
    apiKey: env.piApiKey,
    ...researchModel,
    outlets: outletAdapter,
  }),
});
const radarService = createRadarService({
  pool,
  // Provider 未配置时不阻断启动：Radar Card 如实显示未配置（Ticket 16 装载真实凭据）
  web: radarWeb,
  wechat: createWechatMcpAdapter({
    url: process.env.WECHAT_MCP_URL,
    token: process.env.WECHAT_MCP_TOKEN,
  }),
  outlets: outletAdapter,
  // 原文封面：每页 4 秒超时，失败只是这条信号没有图
  coverImage: createCoverImageFetcher(),
  articleText,
  assessor: await createRadarAgentAssessor({
    query: pool.query.bind(pool),
    companyMemory,
    baseUrl: env.piBaseUrl,
    apiKey: env.piApiKey,
    // RADAR_MODEL / RADAR_THINKING 可改，不配时 LIGHT_MODEL、不开思考
    ...agentModel(env.agentModels, "radar", { modelId: env.lightModel }),
  }),
  onIssuePromoted: (issueId) => {
    // DB 抖动时 start 可能抛错：不能让 fire-and-forget 的 rejection 终止进程
    researchService.start(issueId).catch((err) => console.error("research start failed", err));
  },
});
// 个人雷达（ADR-0021）与公司雷达共用博查（同一请求间隔）和发布方 feed adapter；判定用轻模型
const personalRadarService = createPersonalRadarService({
  pool,
  companyMemory,
  web: radarWeb,
  outlets: outletAdapter,
  judge: createPersonalRadarJudge({
    query: pool.query.bind(pool),
    baseUrl: env.piBaseUrl,
    apiKey: env.piApiKey,
    // PERSONAL_RADAR_MODEL / PERSONAL_RADAR_THINKING 可改，不配时跟公司雷达
    ...agentModel(env.agentModels, "personalRadar", { modelId: env.lightModel }),
    personName: (personId) => personDisplayNames(companyMemory).get(personId),
  }),
  // 02b：GitHub Trending 没有订阅源、检索也限定不了站点，直接读榜单页面
  trending: createGithubTrendingReader(),
  articleText,
});
// 公司每日扫描结束（busy 除外）之后才排个人扫描
const scheduler = createRadarScheduler(radarService, 60_000, () => personalRadarService.runScheduled());
const monthlyPlanService = createMonthlyPlanService({
  pool,
  companyMemory,
  agent: createMonthlyDraftAgent({
    query: pool.query.bind(pool),
    baseUrl: env.piBaseUrl,
    apiKey: env.piApiKey,
    modelId: env.heavyModel,
  }),
});
const monthlyScheduler = createMonthlyPlanScheduler(monthlyPlanService);
const reviewAgentOptions = { query: pool.query.bind(pool), baseUrl: env.piBaseUrl, apiKey: env.piApiKey, modelId: env.heavyModel };
const monthlyReviewService = createMonthlyReviewService({
  pool,
  companyMemory,
  personalDraft: { storageDir: env.conversationAttachmentStorageDir ?? DEFAULT_CONVERSATION_ATTACHMENT_STORAGE_DIR,
    agent: createPersonalReviewDraftAgent({ ...reviewAgentOptions, personName: (personId) => personDisplayNames(companyMemory).get(personId) }) },
  agents: {
    draft: createMonthlyReviewDraftAgent(reviewAgentOptions),
    assess: createMonthlyReviewAssessAgent(reviewAgentOptions),
    summarize: createMonthlyReviewSummaryAgent(reviewAgentOptions),
  },
});
const monthlyReviewScheduler = createMonthlyReviewScheduler(monthlyReviewService);
const now = () => new Date();
const missionRoundScheduler = createMissionRoundScheduler(pool, now);
const collectorHealthScheduler = createCollectorHealthScheduler(pool, now);
await recoverStaleMissionDrafts(pool, now());
// 启动补偿：崩溃中断的 running 扫描标为 failed（不自动重跑）
await radarService.recoverStaleRuns();
await personalRadarService.recoverStaleRuns();
// Ticket 07：创建后、预研启动前崩溃留下的超时 pending research 标为 failed:trigger_not_started
await recoverInterruptedResearch(pool.query.bind(pool));
// Ticket 09：崩溃留下的未完成预审标为可见 failed，等待 CEO 显式重试
await recoverInterruptedPreflight(pool.query.bind(pool));
// Ticket 12：崩溃留下的未完成月度草案标为可见 failed，不自动重跑
await monthlyPlanService.recoverInterrupted();
// ADR-0024：崩溃留下的未完成复盘起草、评估、汇总标为可见 failed，等待手动重试
await monthlyReviewService.recoverInterrupted();
// Ticket 10：崩溃留下的未完成会后抽取同样标为可见 failed，等待 CEO 显式重试
await recoverInterruptedOutcome(pool.query.bind(pool));
// 02c：会议录音识别中的接着轮询（火山任务 id 已落库，不重复计费）；卡在拼接/转码/上传的标为可见 failed
const recordingService = createMeetingRecordingService({
  pool,
  storageDir: env.recordingStorageDir ?? DEFAULT_RECORDING_STORAGE_DIR,
  companyMemory,
});
await recordingService.recoverInterrupted();
const app = await buildApp({
  pool,
  env,
  now,
  radarService,
  personalRadarService,
  researchService,
  monthlyPlanService,
  monthlyReviewService,
  recordingService,
  webSearch: bochaSearch,
  outlets: outletAdapter,
});
app.addHook("onClose", async () => {
  scheduler.close();
  monthlyScheduler.close();
  monthlyReviewScheduler.close();
  await monthlyReviewService.idle();
  missionRoundScheduler.close();
  collectorHealthScheduler.close();
});
scheduler.start();
monthlyScheduler.start();
monthlyReviewScheduler.start();
missionRoundScheduler.start();
collectorHealthScheduler.start();
await app.listen({ port, host: "0.0.0.0" });
console.log(`warmap api listening on :${port} (${join(".", "migrations")} applied, build ${env.buildSha})`);
