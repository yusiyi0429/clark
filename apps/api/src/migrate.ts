import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";

const MIGRATIONS_DIR = join(import.meta.dirname, "..", "migrations");
const ADVISORY_LOCK_KEY = 727211; // warmap migration lock

/**
 * 顺序执行未应用的 SQL migration。
 * 持 advisory lock 防止多进程并发执行；失败时不进入 ready（由调用方决定）。
 */
export async function migrate(db: PoolClient | { query: PoolClient["query"] }): Promise<void> {
  await db.query("SELECT pg_advisory_lock($1)", [ADVISORY_LOCK_KEY]);
  try {
    await db.query(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
         id INTEGER PRIMARY KEY,
         filename TEXT NOT NULL,
         applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
       )`,
    );
    const applied = await db.query<{ id: number }>("SELECT id FROM schema_migrations");
    const appliedIds = new Set(applied.rows.map((r) => r.id));

    const files = (await readdir(MIGRATIONS_DIR)).filter((f) => f.endsWith(".sql")).sort();
    for (const file of files) {
      const id = Number(file.split("_")[0]);
      if (appliedIds.has(id)) continue;
      const sql = await readFile(join(MIGRATIONS_DIR, file), "utf8");
      try {
        await db.query("BEGIN");
        await db.query(sql);
        await db.query("INSERT INTO schema_migrations (id, filename) VALUES ($1, $2)", [id, file]);
        await db.query("COMMIT");
      } catch (err) {
        await db.query("ROLLBACK");
        throw new Error(`migration ${file} failed: ${String(err)}`, { cause: err });
      }
    }
  } finally {
    await db.query("SELECT pg_advisory_unlock($1)", [ADVISORY_LOCK_KEY]);
  }
}
