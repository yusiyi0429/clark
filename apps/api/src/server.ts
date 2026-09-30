import { join } from "node:path";
import { buildApp, DEFAULT_CONVERSATION_ATTACHMENT_STORAGE_DIR, type AppEnv } from "./app.js";
import { migrate } from "./migrate.js";
import { Pool } from "pg";
import { createRadarService } from "./radar.js";
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
import { createResearchAgentRunner } from "./researchAgent.js";
import { recoverInterruptedPreflight } from "./meetingPreflight.js";
import { createMonthlyPlanService } from "./monthlyDraft.js";
import { createMonthlyDraftAgent } from "./monthlyDraftAgent.js";
import { createMonthlyPlanScheduler } from "./monthlyPlanScheduler.js";
import { createMonthlyReviewService } from "./monthlyReviewService.js";
import { createPersonalReviewDraftAgent } from "./personalReviewAgent.js";
import { createMonthlyReviewAssessAgent, createMonthlyReviewDraftAgent, createMonthlyReviewSummaryAgent } from "./monthlyReviewAgents.js";
import { createMonthlyReviewScheduler } from "./monthlyReviewScheduler.js";
import { createMissionRoundScheduler } from "./missionRoundScheduler.js";
import { recoverStaleMissionDrafts } from "./missionRounds.js";
import { recoverInterruptedOutcome } from "./outcome.js";
import { personDisplayNames } from "./people.js";
import { createMeetingRecordingService, DEFAULT_RECORDING_STORAGE_DIR } from "./meetingRecordings.js";

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
  worldApiUrl: process.env.TKOS_WORLD_API_URL,
  worldAgentToken: process.env.TKOS_WORLD_AGENT_TOKEN,
  mcpServiceToken: requiredEnv("COMPANY_MEMORY_MCP_TOKEN"),
  companyMemorySeedDir: requiredEnv("COMPANY_MEMORY_SEED_DIR"),
  companyPeopleSeed: requiredEnv("COMPANY_PEOPLE_SEED"),
  companyName: process.env.COMPANY_NAME,
  missionCardDraftsDir: process.env.MISSION_CARD_DRAFTS_DIR,
  piBaseUrl: requiredEnv("PI_BASE_URL"),
  piApiKey: requiredEnv("PI_API_KEY"),
  lightModel: requiredEnv("LIGHT_MODEL"),
  // 唯一预研深度使用 heavy 槽位；三槽位必须显式配置，不静默降级
  heavyModel: requiredEnv("HEAVY_MODEL"),
  compactionModel: requiredEnv("COMPACTION_MODEL"),
  buildSha: process.env.BUILD_SHA ?? "dev",
  // 可选观测：未配置时 LangSmith 完全 no-op，不阻断启动或业务
  langsmithApiKey: process.env.LANGSMITH_API_KEY,
  langsmithProject: process.env.LANGSMITH_PROJECT,
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
const researchService = createResearchService({
  pool,
  runner: createResearchAgentRunner({
    query: pool.query.bind(pool),
    companyMemory,
    baseUrl: env.piBaseUrl,
    apiKey: env.piApiKey,
    modelId: env.heavyModel,
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
  assessor: await createRadarAgentAssessor({
    query: pool.query.bind(pool),
    companyMemory,
    baseUrl: env.piBaseUrl,
    apiKey: env.piApiKey,
    modelId: env.lightModel,
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
    modelId: env.lightModel,
    personName: (personId) => personDisplayNames(companyMemory).get(personId),
  }),
  // 02b：GitHub Trending 没有订阅源、检索也限定不了站点，直接读榜单页面
  trending: createGithubTrendingReader(),
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
});
scheduler.start();
monthlyScheduler.start();
monthlyReviewScheduler.start();
missionRoundScheduler.start();
await app.listen({ port, host: "0.0.0.0" });
console.log(`warmap api listening on :${port} (${join(".", "migrations")} applied, build ${env.buildSha})`);
