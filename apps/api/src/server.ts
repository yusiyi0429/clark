import { join } from "node:path";
import { buildApp, type AppEnv } from "./app.js";
import { migrate } from "./migrate.js";
import { Pool } from "pg";
import { createRadarService } from "./radar.js";
import { createRadarAgentAssessor } from "./radarAgent.js";
import { createRadarScheduler } from "./radarScheduler.js";
import { createBraveRadarWebAdapter, createWechatAccountHttpAdapter } from "./radarSources.js";
import { recoverInterruptedResearch } from "./issues.js";
import { loadCompanyMemory } from "./companyMemory.js";
import { createResearchService } from "./research.js";
import { createResearchAgentRunner } from "./researchAgent.js";
import { recoverInterruptedPreflight } from "./meetings.js";
import { createMonthlyPlanService } from "./monthlyDraft.js";
import { createMonthlyDraftAgent } from "./monthlyDraftAgent.js";
import { createMonthlyPlanScheduler } from "./monthlyPlanScheduler.js";
import { recoverInterruptedOutcome } from "./outcome.js";

function requiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
}

const env: AppEnv = {
  sessionSecret: requiredEnv("SESSION_SECRET"),
  ceoPasswordHash: requiredEnv("CEO_ACCESS_PASSWORD_HASH"),
  sessionMaxAgeSeconds: Number(process.env.SESSION_MAX_AGE_SECONDS ?? "28800"),
  publicOrigin: requiredEnv("PUBLIC_ORIGIN"),
  driServiceToken: requiredEnv("DRI_SERVICE_TOKEN"),
  mcpServiceToken: requiredEnv("COMPANY_MEMORY_MCP_TOKEN"),
  companyMemorySeedDir: requiredEnv("COMPANY_MEMORY_SEED_DIR"),
  companyPeopleSeed: requiredEnv("COMPANY_PEOPLE_SEED"),
  piBaseUrl: requiredEnv("PI_BASE_URL"),
  piApiKey: requiredEnv("PI_API_KEY"),
  lightModel: requiredEnv("LIGHT_MODEL"),
  // 唯一预研深度使用 heavy 槽位；三槽位必须显式配置，不静默降级
  heavyModel: requiredEnv("HEAVY_MODEL"),
  compactionModel: requiredEnv("COMPACTION_MODEL"),
  buildSha: process.env.BUILD_SHA ?? "dev",
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
const researchService = createResearchService({
  pool,
  runner: createResearchAgentRunner({
    query: pool.query.bind(pool),
    companyMemory,
    baseUrl: env.piBaseUrl,
    apiKey: env.piApiKey,
    modelId: env.heavyModel,
  }),
});
const radarService = createRadarService({
  pool,
  // Provider 未配置时不阻断启动：Radar Card 如实显示未配置（Ticket 16 装载真实凭据）
  web: createBraveRadarWebAdapter({ apiKey: process.env.SEARCH_API_KEY }),
  wechat: createWechatAccountHttpAdapter({
    endpoint: process.env.WECHAT_PROVIDER,
    credentials: process.env.WECHAT_CREDENTIALS,
  }),
  assessor: createRadarAgentAssessor({
    query: pool.query.bind(pool),
    baseUrl: env.piBaseUrl,
    apiKey: env.piApiKey,
    modelId: env.lightModel,
  }),
  onIssuePromoted: (issueId) => {
    // DB 抖动时 start 可能抛错：不能让 fire-and-forget 的 rejection 终止进程
    researchService.start(issueId).catch((err) => console.error("research start failed", err));
  },
});
const scheduler = createRadarScheduler(radarService);
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
// 启动补偿：崩溃中断的 running 扫描标为 failed（不自动重跑）
await radarService.recoverStaleRuns();
// Ticket 07：创建后、预研启动前崩溃留下的超时 pending research 标为 failed:trigger_not_started
await recoverInterruptedResearch(pool.query.bind(pool));
// Ticket 09：崩溃留下的未完成预审标为可见 failed，等待 CEO 显式重试
await recoverInterruptedPreflight(pool.query.bind(pool));
// Ticket 12：崩溃留下的未完成月度草案标为可见 failed，不自动重跑
await monthlyPlanService.recoverInterrupted();
// Ticket 10：崩溃留下的未完成会后抽取同样标为可见 failed，等待 CEO 显式重试
await recoverInterruptedOutcome(pool.query.bind(pool));
const app = await buildApp({ pool, env, radarService, researchService, monthlyPlanService });
app.addHook("onClose", async () => {
  scheduler.close();
  monthlyScheduler.close();
});
scheduler.start();
monthlyScheduler.start();
await app.listen({ port, host: "0.0.0.0" });
console.log(`warmap api listening on :${port} (${join(".", "migrations")} applied, build ${env.buildSha})`);
