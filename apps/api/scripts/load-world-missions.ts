import { Pool } from "pg";
import { WorldClient, WorldError, resolveWorldEnv, resolveWorldTkEnv } from "../src/worldClient.js";
import { loadWorldMissions } from "../src/worldMissionLoad.js";

/**
 * 从本体只读载入某个月的 Mission：pnpm --filter @warmap/api missions:load-world -- --period 2026-10 [--instance tk] [--dry-run]
 * --instance tk 用 TK 只读身份（TKOS_WORLD_TK_INSTANCE、TKOS_WORLD_TK_TOKEN_FILE，写死不能写），预发用它；缺省用主实例（正式 = TK scope）。
 * 整批一个事务；--dry-run 只读本体、列出会载入什么，不写库。凭据由进程环境提供，不读取、输出环境文件。
 */
const args = process.argv.slice(2);
const flag = (name: string) => { const at = args.indexOf(name); return at >= 0 ? args[at + 1] : undefined; };
const period = flag("--period");
const dryRun = args.includes("--dry-run");
if (!period || !/^\d{4}-(0[1-9]|1[0-2])$/.test(period) || args.includes("--help")) {
  console.log("用法：pnpm --filter @warmap/api missions:load-world -- --period YYYY-MM [--instance tk] [--dry-run]");
  process.exit(period ? 0 : 1);
}
const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 2 });
const client = await pool.connect();
try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL 未配置");
  const env = flag("--instance") === "tk" ? resolveWorldTkEnv(process.env) : resolveWorldEnv(process.env);
  if (!env) throw new Error("TKOS_WORLD_TK_INSTANCE 未配置");
  const world = new WorldClient(client.query.bind(client), env);
  await client.query("BEGIN");
  const report = await loadWorldMissions(client.query.bind(client), world, { period, dryRun });
  await client.query(dryRun ? "ROLLBACK" : "COMMIT");
  console.log(JSON.stringify({ dryRun, ...report }, null, 2));
} catch (error) {
  await client.query("ROLLBACK").catch(() => undefined);
  console.error(error instanceof WorldError ? `${error.status} ${error.code}: ${error.message}` : `载入失败：${(error as Error).message}`);
  process.exitCode = 1;
} finally {
  client.release();
  await pool.end();
}
