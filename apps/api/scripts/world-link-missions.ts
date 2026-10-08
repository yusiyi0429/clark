import { Pool } from "pg";
import { WorldClient, WorldError } from "../src/worldClient.js";
import { linkWorldMissions } from "../src/worldMissions.js";

// 凭据由进程环境（或 Node --env-file）提供；不读取、输出环境文件。
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
try {
  if (!process.env.DATABASE_URL) throw new Error("DATABASE_URL 未配置");
  const client = new WorldClient(pool.query.bind(pool), { worldApiUrl: process.env.TKOS_WORLD_API_URL, worldAgentToken: process.env.TKOS_WORLD_AGENT_TOKEN });
  for (const head of await linkWorldMissions(client)) console.log(JSON.stringify({ title: head.title, object_id: head.object_id }));
} catch (error) {
  console.error(error instanceof WorldError ? `${error.status} ${error.code}: ${error.message}` : "world Mission 关联失败，请检查配置及迁移");
  process.exitCode = 1;
} finally {
  await pool.end();
}
