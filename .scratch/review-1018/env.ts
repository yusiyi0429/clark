/** 审核演示库（integration/review-1018）的共用环境：seed.ts 与 api.ts 都先调 loadReviewEnv()。
 * 模型网关只从主工作区 apps/api/.env 读白名单里的几项，进程内使用，不打印、不落盘；
 * 本体、飞书、LangSmith、对象存储、博查等其余凭据一概不读，演示库不会往外写。 */
import { mkdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";

export const WORKTREE = fileURLToPath(new URL("../../", import.meta.url));
export const MAIN_ROOT = process.env.REVIEW_MAIN_ROOT ?? resolve(WORKTREE, "../../..");
export const DATA_DIR = join(WORKTREE, ".data", "review-1018");
export const DB_NAME = "tianshu_review_1018";
export const PG_ADMIN_URL = process.env.REVIEW_PG_ADMIN_URL ?? "postgres://postgres:postgres@localhost:54329/postgres";
export const DATABASE_URL = PG_ADMIN_URL.replace(/\/[^/]+$/, `/${DB_NAME}`);
export const API_PORT = 4818;
export const WEB_PORT = 3818;
export const PEOPLE_FILE = join(DATA_DIR, "people.json");
/** 演示账号的统一口令（只存在于本地演示库）。 */
export const DEMO_PASSCODE = "8742";

const GATEWAY_KEYS = ["PI_BASE_URL", "PI_API_KEY", "LIGHT_MODEL", "HEAVY_MODEL", "COMPACTION_MODEL", "COMPANY_TIMEZONE"];

export function loadReviewEnv(): void {
  const mainEnv = parseEnv(readFileSync(join(MAIN_ROOT, "apps/api/.env"), "utf8"));
  for (const key of GATEWAY_KEYS) if (mainEnv[key]) process.env[key] = mainEnv[key];
  for (const key of ["PI_BASE_URL", "PI_API_KEY", "LIGHT_MODEL", "HEAVY_MODEL", "COMPACTION_MODEL"]) {
    if (!process.env[key]) throw new Error(`主工作区 apps/api/.env 缺少 ${key}`);
  }
  for (const dir of ["materials", "attachments", "recordings", "memory"]) mkdirSync(join(DATA_DIR, dir), { recursive: true });
  Object.assign(process.env, {
    DATABASE_URL,
    PORT: String(API_PORT),
    PUBLIC_ORIGIN: `http://localhost:${WEB_PORT}`,
    EXTRA_ALLOWED_ORIGINS: `http://127.0.0.1:${WEB_PORT}`,
    // 以下几项只是本地演示库的会话与服务令牌，不是任何线上凭据。
    SESSION_SECRET: "review-1018-local-demo-session",
    DRI_SERVICE_TOKEN: "review-1018-local-dri",
    COMPANY_MEMORY_MCP_TOKEN: "review-1018-local-mcp",
    COMPANY_MEMORY_SEED_DIR: join(WORKTREE, "seed", "memory"),
    COMPANY_PEOPLE_SEED: PEOPLE_FILE,
    COMPANY_NAME: "天枢（审核演示）",
    MEETING_MATERIAL_STORAGE_DIR: join(DATA_DIR, "materials"),
    CONVERSATION_ATTACHMENT_STORAGE_DIR: join(DATA_DIR, "attachments"),
    MEETING_RECORDING_STORAGE_DIR: join(DATA_DIR, "recordings"),
    BUILD_SHA: "review-1018",
  });
  for (const key of ["TKOS_WORLD_API_URL", "TKOS_WORLD_AGENT_TOKEN", "LANGSMITH_API_KEY", "LANGSMITH_TRACING", "FEISHU_APP_ID", "FEISHU_APP_SECRET", "BOCHA_API_KEY"]) delete process.env[key];
}
