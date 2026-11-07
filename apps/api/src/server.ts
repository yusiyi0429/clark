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
import { loadPeopleDirectory } from "./peopleDirectory.js";
import { createCompanyContext } from "./companyContext.js";
import { assignLegacyConversations } from "./conversations.js";
import { settleActiveTurns } from "./routes/conversations.js";
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
import { homePushJobs } from "./homePush.js";
import { createCollectorRawPurgeScheduler } from "./collectorDistill.js";
import { createWeeklyReviewDraftAgent } from "./weeklyReviewAgent.js";
import { createWeeklyReviewService } from "./weeklyReviewService.js";
import { canUseMemberView, ensureLocalDevLogin } from "./memberAccess.js";
import { isLoopbackHttpOrigin } from "./routes/shared.js";
import { recoverStaleMissionDrafts } from "./missionRounds.js";
import { recoverInterruptedOutcome } from "./outcome.js";
import { personDisplayNames } from "./people.js";
import { createMeetingRecordingService, DEFAULT_RECORDING_STORAGE_DIR } from "./meetingRecordings.js";
import { resolveWorldEnv, resolveWorldTkEnv, WorldClient, worldConfigured } from "./worldClient.js";
import { missionAutoLoadJobs } from "./missionAutoLoad.js";
import { createJobWorker, exampleJobHandlers } from "./jobs.js";
import { usageReportJobs } from "./usage.js";
import { resolveFeishuEnv } from "./feishu/config.js";
import { parseAdminPersonIds } from "./admin.js";
import { createFeishuClient } from "./feishu/client.js";
import { ceoFeishuNoticeJobs } from "./ceoFeishuNotices.js";
import { feishuTokenJobs } from "./feishu/refresh.js";
import { feishuEventJobs, mergeFeishuEventHandlers, startFeishuEventStream } from "./feishu/events.js";
import { feishuNotifyJobs } from "./feishu/notify.js";

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
  internalChatToken: process.env.INTERNAL_CHAT_TOKEN || undefined,
  // 首页对话改走独立 Chat 服务的开关：设了地址才走（还要 INTERNAL_CHAT_TOKEN），不设照旧走天枢自己的对话。
  chatServiceUrl: process.env.CHAT_SERVICE_URL || undefined,
  // 微信 ClawBot 默认关（10/28 不稳定，生产先不上）；设 WECHAT_ENABLED=1 才开。
  wechatEnabled: process.env.WECHAT_ENABLED === "1",
  // 对话分段：值为 1 才开，缺省都关，由生产、预发的 env 显式打开。
  chatSessionRotation: process.env.CHAT_SESSION_ROTATION === "1",
  conversationSegments: process.env.CONVERSATION_SEGMENTS === "1",
  // 首页对话带上当前页面（要 Chat 先接 page 字段）：值为 1 才开。
  chatPageContext: process.env.CHAT_PAGE_CONTEXT === "1",
  // 本体：TKOS_WORLD_API_URL；凭证 TKOS_WORLD_AGENT_TOKEN 或 TKOS_WORLD_AGENT_TOKEN_FILE（只在内存里）；TKOS_WORLD_INSTANCE 选实例配置（缺省 mvp）。
  ...resolveWorldEnv(process.env),
  // 第二个只读实例（词元云集 TK scope）：TKOS_WORLD_TK_INSTANCE=tk 加 TKOS_WORLD_TK_TOKEN_FILE；不设就关闭。
  worldTk: resolveWorldTkEnv(process.env),
  companyPeopleSeed: requiredEnv("COMPANY_PEOPLE_SEED"),
  companyName: process.env.COMPANY_NAME,
  onboardingDelegationStep: process.env.ONBOARDING_DELEGATION_STEP === "1",
  // 签发月度计划后代记本体周期目标的门：设为 1 才启用（还要实例配置允许写）；不影响会议、周复盘等其他本体写入。
  worldPeriodGoalGates: process.env.TKOS_WORLD_PERIOD_GOAL_GATES === "1",
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
  // 个人记忆召回的快模型（可选）：不配时依次用 TRIAGE_MODEL、LIGHT_MODEL。
  memoryRecallModel: process.env.MEMORY_RECALL_MODEL || undefined,
  conversationApi: process.env.CONVERSATION_API || undefined,
  conversationBaseUrl: process.env.CONVERSATION_BASE_URL || undefined,
  conversationThinking: process.env.CONVERSATION_THINKING || undefined,
  // 会前预审模型与思考强度（可选）：不配时用 heavy 槽位、思考 high。
  preflightModel: process.env.PREFLIGHT_MODEL || undefined,
  preflightThinking: process.env.PREFLIGHT_THINKING || undefined,
  // 预研、会后提取、雷达的模型与思考强度（RESEARCH_MODEL / OUTCOME_MODEL / RADAR_MODEL 等，可选，agentModels.ts）。
  agentModels: agentModelEnvFrom(process.env),
  // 交付物评审与版本说明（可选，指向 TokenHub）：不配时用 PI_BASE_URL / PI_API_KEY / HEAVY_MODEL、思考 medium。
  review: { model: process.env.REVIEW_MODEL || undefined, baseUrl: process.env.REVIEW_BASE_URL || undefined,
    apiKey: process.env.REVIEW_API_KEY || undefined, thinking: process.env.REVIEW_THINKING || undefined },
  // 云端拆卡和云端 Agent 验收（缺省关，拆卡和验收在本人电脑上做）。
  boardCloudAgents: process.env.BOARD_CLOUD_AGENTS === "1",
  // 天枢自己的月度计划和月末复盘（缺省关，复盘和月初拆解只走 M2）。
  tianshuMonthlyCycle: process.env.TIANSHU_MONTHLY_CYCLE === "1",
  buildSha: process.env.BUILD_SHA ?? "dev",
  materialStorageDir: process.env.MEETING_MATERIAL_STORAGE_DIR,
  conversationAttachmentStorageDir: process.env.CONVERSATION_ATTACHMENT_STORAGE_DIR,
  recordingStorageDir: process.env.MEETING_RECORDING_STORAGE_DIR,
  // 本体公司事实（PR #12）：只读投影在 MEMORY_STORAGE_DIR/company；按人授权的域写在 COMPANY_WORLD_ACCESS_FILE（personId → domain 列表）。个人记忆在数据库里。
  companyStorageDir: process.env.MEMORY_STORAGE_DIR ? `${process.env.MEMORY_STORAGE_DIR}/company` : undefined,
  companyWorldAccessFile: process.env.COMPANY_WORLD_ACCESS_FILE || undefined,
  // 后台服务（雷达、预审、预研、月度起草与复盘、任务卡起草）读本体公司事实时用谁的授权；不配时这些服务如实说没读到本体。
  companySystemPersonId: process.env.COMPANY_SYSTEM_PERSON_ID || undefined,
  // 飞书：FEISHU_APP_ID / FEISHU_APP_SECRET / FEISHU_TOKEN_KEY（/ FEISHU_TOKEN_KEY_VERSION）；都不配时关闭。
  feishu: resolveFeishuEnv(process.env),
  // 管理员视图：TIANSHU_ADMIN_PERSON_IDS（逗号分隔的 personId）；不配时没有人能看。
  adminPersonIds: parseAdminPersonIds(process.env.TIANSHU_ADMIN_PERSON_IDS),
  // 会议事件的妙记链接：FEISHU_WEB_ORIGIN（如 https://tokenking.feishu.cn）；不配时不带链接。
  feishuWebOrigin: process.env.FEISHU_WEB_ORIGIN?.trim() || undefined,
  // 会议记录正文能不能写进本体（等斯一答复）：值为 1 才写，缺省只写已确认的决策和行动项。
  meetingRecordText: process.env.MEETING_WORLD_RECORD_TEXT === "1",
  collectionBitable: process.env.FEISHU_BITABLE_MODE === "live" ? "live" : "mock",
  // 信息收集、文档变更推送（D-56）：值为 1 才开，缺省关。
  collectionsEnabled: process.env.COLLECTIONS_ENABLED === "1",
  docChangeEnabled: process.env.DOC_CHANGE_ENABLED === "1",
};

const port = Number(process.env.PORT ?? "4000");

const pool = new Pool({ connectionString: requiredEnv("DATABASE_URL"), max: 10 });

const client = await pool.connect();
try {
  await migrate(client);
} finally {
  client.release();
}

// 本地开发（PUBLIC_ORIGIN 是本机 http）：固定测试账号 sunm / 8989 每次启动都可登录。
if (isLoopbackHttpOrigin(env.publicOrigin)) await ensureLocalDevLogin(pool.query.bind(pool), new Date());

const peopleDirectory = loadPeopleDirectory(env);
const company = createCompanyContext(env);
await assignLegacyConversations(pool.query.bind(pool), peopleDirectory);
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
    company,
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
    company,
    baseUrl: env.piBaseUrl,
    apiKey: env.piApiKey,
    // RADAR_MODEL / RADAR_THINKING 可改，不配时 LIGHT_MODEL、不开思考
    ...agentModel(env.agentModels, "radar", { modelId: env.lightModel }),
  }),
  // 10/28：雷达信号先不自动转议题（一号位还没在看，自动转出来的议题会淹没真正要定的事）。
  promoteIssues: false,
  onIssuePromoted: (issueId) => {
    // DB 抖动时 start 可能抛错：不能让 fire-and-forget 的 rejection 终止进程
    researchService.start(issueId).catch((err) => console.error("research start failed", err));
  },
});
// 个人雷达（ADR-0021）与公司雷达共用博查（同一请求间隔）和发布方 feed adapter；判定用轻模型
const personalRadarService = createPersonalRadarService({
  pool,
  peopleDirectory,
  web: radarWeb,
  outlets: outletAdapter,
  judge: createPersonalRadarJudge({
    query: pool.query.bind(pool),
    baseUrl: env.piBaseUrl,
    apiKey: env.piApiKey,
    // PERSONAL_RADAR_MODEL / PERSONAL_RADAR_THINKING 可改，不配时跟公司雷达
    ...agentModel(env.agentModels, "personalRadar", { modelId: env.lightModel }),
    personName: (personId) => personDisplayNames(peopleDirectory).get(personId),
  }),
  // 02b：GitHub Trending 没有订阅源、检索也限定不了站点，直接读榜单页面
  trending: createGithubTrendingReader(),
  articleText,
});
// 公司每日扫描结束（busy 除外）之后才排个人扫描
const scheduler = createRadarScheduler(radarService, 60_000, () => personalRadarService.runScheduled());
const monthlyPlanService = createMonthlyPlanService({
  pool,
  peopleDirectory,
  company,
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
  peopleDirectory,
  company,
  personalDraft: { storageDir: env.conversationAttachmentStorageDir ?? DEFAULT_CONVERSATION_ATTACHMENT_STORAGE_DIR,
    agent: createPersonalReviewDraftAgent({ ...reviewAgentOptions, personName: (personId) => personDisplayNames(peopleDirectory).get(personId) }) },
  agents: {
    draft: createMonthlyReviewDraftAgent(reviewAgentOptions),
    assess: createMonthlyReviewAssessAgent(reviewAgentOptions),
    summarize: createMonthlyReviewSummaryAgent(reviewAgentOptions),
  },
});
const monthlyReviewScheduler = createMonthlyReviewScheduler(monthlyReviewService);
// 周复盘（D-01）：只在本人要时起草（对话、周复盘页），每周五的自动起草 11/03 停了；与个人复盘同一个 heavy 模型槽位。
const weeklyReviewService = createWeeklyReviewService({ pool, agent: createWeeklyReviewDraftAgent(reviewAgentOptions),
  people: () => peopleDirectory.searchPeople(undefined).filter(canUseMemberView).map((person) => person.personId) });
// 本机采集器已下线：不再整理原文，已收到的原文照 14 天清空，每 5 分钟清一次。
const collectorRawPurgeScheduler = createCollectorRawPurgeScheduler(pool);
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
  peopleDirectory,
  publicOrigin: env.publicOrigin,
});
await recordingService.recoverInterrupted();
// 飞书（配了才启用）：一个开放接口客户端，免登路由与后台任务共用。
const feishuClient = env.feishu ? createFeishuClient(env.feishu) : undefined;
const feishuTokens = env.feishu && feishuClient ? feishuTokenJobs({ pool, env: env.feishu, client: feishuClient, now }) : undefined;
const app = await buildApp({
  pool,
  env,
  now,
  radarService,
  personalRadarService,
  researchService,
  monthlyPlanService,
  monthlyReviewService,
  weeklyReviewService,
  recordingService,
  webSearch: bochaSearch,
  outlets: outletAdapter,
  feishuClient,
});
// 公共后台任务（jobs.ts）：每 5 秒领一批；现有各功能的 setInterval 暂不迁移。
// 会后链路：妙记轮询与「妙记生成」事件、分层同步、提醒与代判、影响卡推送与写本体；飞书通知配了飞书才发。
const followThroughJobs = app.meetingFollowThrough.jobs();
// 文档变更：群里 @机器人 贴文档链接即发布（im.message.receive_v1），找候选走后台任务。私聊机器人 = 在首页对话里问（feishuChat.ts）。
const docChangeJobs = app.docChanges.jobs();
// 使用周报：每周一 08:00 之后生成上一周。
const usageJobs = usageReportJobs(pool.query.bind(pool), peopleDirectory, now);
// 战场进展汇总：每天 07:30 之后补齐当天各战场的。
const summaryJobs = app.battlefieldSummaries.jobs();
// 一号位要动手的事主动私信到飞书（复盘与拆解开放、周复盘待确认、红色议题）：配了飞书才发。
const ceoNoticeJobs = feishuClient ? ceoFeishuNoticeJobs({ pool, people: () => peopleDirectory.searchPeople(undefined), now }) : { handlers: {}, recurring: [] };
// 新首页「等你」里急的几件推到本人的「天枢伙伴」单聊（设计 13.2）：配了飞书才发。
const homePush = feishuClient ? homePushJobs({ pool, now, people: () => peopleDirectory.searchPeople(undefined).filter(canUseMemberView).map((person) => person.personId),
  readHome: (personId) => app.readWorkHome({ personId, role: "member" }) }) : { handlers: {}, recurring: [] };
// 每天从本体载入本月和下月的 Mission（设计 10.5，代替手动跑 missions:load-world）：TIANSHU_AUTO_LOAD_MISSIONS=1 且本体配了才开，缺省关；只读本体、用主实例。
const autoLoadMissions = process.env.TIANSHU_AUTO_LOAD_MISSIONS === "1";
const missionLoadJobs = missionAutoLoadJobs({ enabled: autoLoadMissions, pool, now,
  world: autoLoadMissions && worldConfigured(env) ? new WorldClient(pool.query.bind(pool), env) : null });
const jobWorker = createJobWorker({
  pool,
  handlers: {
    ...exampleJobHandlers, ...feishuTokens?.handlers, ...followThroughJobs.handlers, ...docChangeJobs.handlers, ...app.collectionJobs.handlers, ...usageJobs.handlers, ...summaryJobs.handlers, ...ceoNoticeJobs.handlers, ...homePush.handlers, ...app.taskPlacementJobs, ...missionLoadJobs.handlers,
    ...(env.feishu ? feishuEventJobs(pool, mergeFeishuEventHandlers(followThroughJobs.feishuEvents, docChangeJobs.feishuEvents, app.feishuChat?.events ?? {})) : {}),
    ...(feishuClient ? feishuNotifyJobs({ pool, client: feishuClient, publicOrigin: env.publicOrigin }) : {}),
  },
  recurring: [...(feishuTokens?.recurring ?? []), ...followThroughJobs.recurring, ...app.collectionJobs.recurring, ...usageJobs.recurring, ...summaryJobs.recurring, ...ceoNoticeJobs.recurring, ...homePush.recurring, ...missionLoadJobs.recurring],
});
let feishuEvents: { close: () => void } | undefined;
app.addHook("onClose", async () => {
  feishuEvents?.close();
  scheduler.close();
  monthlyScheduler.close();
  monthlyReviewScheduler.close();
  await monthlyReviewService.idle();
  missionRoundScheduler.close();
  await jobWorker.close();
  await weeklyReviewService.idle();
  await collectorRawPurgeScheduler.close();
});
scheduler.start();
// 天枢自己的月度计划草案和月末复盘：TIANSHU_MONTHLY_CYCLE=1 才自动起（缺省关，走 M2）。
if (env.tianshuMonthlyCycle) {
  monthlyScheduler.start();
  monthlyReviewScheduler.start();
}
missionRoundScheduler.start();
jobWorker.start();
collectorRawPurgeScheduler.start();
await app.listen({ port, host: "0.0.0.0" });
// 飞书长连接：收到事件只落库并排 jobs，3 秒内 ack；单聊消息落库后直接交给 worker 跑那一条，不等下一轮。
feishuEvents = env.feishu ? startFeishuEventStream(pool, env.feishu, jobWorker.runNow) : undefined;
// 微信 ClawBot：已绑定的人开始收消息，定时推送通知；停机时 app.close() 收尾。
void app.wechat?.start().catch((error: Error) => console.error("wechat start failed", error));
console.log(`warmap api listening on :${port} (${join(".", "migrations")} applied, build ${env.buildSha})`);
// 停机（部署换版本、重启）：正在写的对话先以「服务更新」收尾存档，界面连上新实例后自动接着写；再关服务和后台任务后退出。
let stopping = false;
const shutdown = async () => {
  if (stopping) return;
  stopping = true;
  await settleActiveTurns();
  await app.close().catch(() => undefined);
  process.exit(0);
};
process.once("SIGTERM", () => void shutdown());
process.once("SIGINT", () => void shutdown());
