import { join } from "node:path";
import { buildApp, type AppEnv } from "./app.js";
import { migrate } from "./migrate.js";
import { Pool } from "pg";

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

const app = await buildApp({ pool, env });
await app.listen({ port, host: "0.0.0.0" });
console.log(`warmap api listening on :${port} (${join(".", "migrations")} applied, build ${env.buildSha})`);
