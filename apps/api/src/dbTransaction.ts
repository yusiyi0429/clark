import { rm } from "node:fs/promises";
import type { Pool } from "pg";
import type { Query } from "./meetingStore.js";

/** 一个事务：work 回什么就回什么；失败回滚，并删掉 work 记在 createdFiles 里的文件（提交时连接断开的除外，见下）。 */
export async function transact<T>(pool: Pool, work: (q: Query, createdFiles: string[]) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  const createdFiles: string[] = [];
  let committing = false;
  try {
    await client.query("BEGIN");
    const result = await work((sql, params) => client.query(sql, params), createdFiles);
    committing = true;
    await client.query("COMMIT");
    return result;
  } catch (cause) {
    await client.query("ROLLBACK").catch(() => undefined);
    // 连接在提交时断开，数据库可能已成功；此时不得删除已提交来件的原件。
    const dbCode = (cause as { code?: string }).code ?? "";
    if (!committing || /^(?:22|23|40)[0-9A-Z]{3}$/.test(dbCode)) {
      await Promise.all(createdFiles.map((path) => rm(path, { force: true })));
    }
    throw cause;
  } finally { client.release(); }
}
