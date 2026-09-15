import type { Pool, PoolClient } from "pg";
import type { TCard } from "@warmap/contracts";
import { projectHomeCard } from "./fixture.js";
import type { ActionScope } from "./actionToken.js";

export type ExecuteResult =
  | { card: TCard; conflict?: false }
  | { conflict: true; latestCard: TCard };

/**
 * Action 执行顺序（.tech/01 §9）：
 * 1. 行锁；2. fingerprint 已有效果 → 直接返回当前 Card；3. 未命中才校验 version；4. 执行并记录 fingerprint。
 * 不建立 Action 实体：fingerprint 记录在所属业务效果上（此处为 fixture_home.notice_fingerprint）。
 */
export async function executeDismissNotice(
  pool: Pool,
  secret: string,
  scope: ActionScope,
  fingerprint: string,
): Promise<ExecuteResult> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const locked = await client.query<FixtureHomeRow>(
      "SELECT id, version, notice_dismissed, notice_fingerprint FROM fixture_home WHERE id = $1 FOR UPDATE",
      [scope.objectId],
    );
    if (locked.rowCount !== 1) throw new Error("fixture_home row missing");
    const row = locked.rows[0];

    // fingerprint 已有效果：幂等返回当前 Card，不再校验 version
    if (row.notice_fingerprint === fingerprint) {
      const card = projectHomeCard(row, secret);
      await client.query("COMMIT");
      return { card };
    }

    // 未命中既有效果：校验 version
    if (row.version !== scope.objectVersion) {
      const latestCard = projectHomeCard(row, secret);
      await client.query("ROLLBACK");
      return { conflict: true, latestCard };
    }

    const updated = await client.query<FixtureHomeRow>(
      `UPDATE fixture_home
       SET version = version + 1, notice_dismissed = true, notice_fingerprint = $1, updated_at = now()
       WHERE id = $2 AND version = $3
       RETURNING id, version, notice_dismissed, notice_fingerprint`,
      [fingerprint, scope.objectId, scope.objectVersion],
    );
    const card = projectHomeCard(updated.rows[0], secret);
    await client.query("COMMIT");
    return { card };
  } catch (err) {
    await client.query("ROLLBACK").catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

type FixtureHomeRow = {
  id: string;
  version: number;
  notice_dismissed: boolean;
  notice_fingerprint: string | null;
};
