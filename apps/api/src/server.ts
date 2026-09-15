import { join } from "node:path";
import { buildApp, type AppEnv } from "./app.js";
import { migrate } from "./migrate.js";
import { Pool } from "pg";
import { createRadarService } from "./radar.js";
import { createRadarAgentAssessor } from "./radarAgent.js";
import { createRadarScheduler } from "./radarScheduler.js";
import { createBraveRadarWebAdapter, createWechatAccountHttpAdapter } from "./radarSources.js";
import { recoverInterruptedResearch } from "./issues.js";

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
});
const scheduler = createRadarScheduler(radarService);
// 启动补偿：崩溃中断的 running 扫描标为 failed（不自动重跑）
await radarService.recoverStaleRuns();
// Ticket 07：创建后、预研启动前崩溃留下的超时 pending research 标为 failed:trigger_not_started
await recoverInterruptedResearch(pool.query.bind(pool));
const app = await buildApp({ pool, env, radarService });
app.addHook("onClose", async () => scheduler.close());
scheduler.start();
await app.listen({ port, host: "0.0.0.0" });
console.log(`warmap api listening on :${port} (${join(".", "migrations")} applied, build ${env.buildSha})`);
