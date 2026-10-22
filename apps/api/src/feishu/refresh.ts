import type { Pool } from "pg";
import { enqueueJob, type JobHandler, type RecurringJob } from "../jobs.js";
import type { FeishuEnv } from "./config.js";
import { FeishuApiError, type FeishuClient } from "./client.js";
import { decryptTokenSecret } from "./crypto.js";
import { saveRefreshedToken } from "./tokens.js";

export const FEISHU_REFRESH_SCAN_KIND = "feishu.token_refresh_scan";
export const FEISHU_REFRESH_KIND = "feishu.token_refresh";
/** 每 10 分钟扫一次；access token 15 分钟内到期（或已过期）的排进续期。 */
const SCAN_EVERY_MS = 10 * 60_000;
const REFRESH_AHEAD_MS = 15 * 60_000;
/** 授权满 330 天打提醒；满 365 天飞书一律要求重新授权。 */
const REMIND_AFTER_DAYS = 330;
export const REAUTH_AFTER_DAYS = 365;
/**
 * refresh token 已不能再用、重试也没用的错误：20037 过期（含满 365 天）、20026 无效、20064 已撤销、20073 已用过。
 * 遇到就标「需重新授权」，不进 jobs 重试。
 */
const REAUTH_CODES = new Set([20037, 20026, 20064, 20073]);

export type RefreshOutcome = "refreshed" | "skipped" | "reauth_required";

/** 扫描：打 330 天提醒；把快到期的 token 按「人 + 当前到期时间」入队，同一代 token 只排一次。 */
export async function scanDueTokens(pool: Pool, now: Date): Promise<number> {
  await pool.query(
    `UPDATE feishu_user_tokens SET reauth_reminder_at = $1, updated_at = now()
     WHERE status = 'active' AND reauth_reminder_at IS NULL AND authorized_at <= $1::timestamptz - make_interval(days => $2)`,
    [now, REMIND_AFTER_DAYS],
  );
  const due = await pool.query(
    "SELECT person_id, access_expires_at FROM feishu_user_tokens WHERE status = 'active' AND access_expires_at <= $1",
    [new Date(now.getTime() + REFRESH_AHEAD_MS)],
  );
  let queued = 0;
  for (const row of due.rows as { person_id: string; access_expires_at: Date }[]) {
    if (await enqueueJob(pool.query.bind(pool), {
      kind: FEISHU_REFRESH_KIND,
      dedupeKey: `${FEISHU_REFRESH_KIND}:${row.person_id}:${row.access_expires_at.getTime()}`,
      payload: { personId: row.person_id },
      runAt: now,
    })) queued += 1;
  }
  return queued;
}

/**
 * 续期一个人的 token。refresh token 只能用一次，所以整个过程锁住这个人的那一行（FOR UPDATE）：
 * 并发的第二个续期等到锁时发现已经换过（到期时间推后了）就跳过，不会把用过的 refresh token 再交一次。
 * 不可恢复的错误标「需重新授权」后正常返回；其他错误记下 last_error 再抛出，交给 jobs 退避重试。
 */
export async function refreshPersonToken({ pool, env, client, personId, now }: {
  pool: Pool;
  env: Pick<FeishuEnv, "tokenKey" | "tokenKeyVersion">;
  client: Pick<FeishuClient, "refreshUserToken">;
  personId: string;
  now: Date;
}): Promise<RefreshOutcome> {
  const db = await pool.connect();
  const q = db.query.bind(db);
  try {
    await q("BEGIN");
    const row = (await q(
      "SELECT key_version, ciphertext, access_expires_at, status FROM feishu_user_tokens WHERE person_id = $1 FOR UPDATE",
      [personId],
    )).rows[0] as { key_version: number; ciphertext: string; access_expires_at: Date; status: string } | undefined;
    if (!row || row.status !== "active" || row.access_expires_at.getTime() > now.getTime() + REFRESH_AHEAD_MS) {
      await q("COMMIT");
      return "skipped";
    }
    if (row.key_version !== env.tokenKeyVersion) throw new Error(`飞书令牌密钥版本不符：库里是 ${row.key_version}，当前是 ${env.tokenKeyVersion}`);
    const { refreshToken } = decryptTokenSecret(env.tokenKey, personId, row.ciphertext);
    const markReauth = async (reason: string) => {
      await q("UPDATE feishu_user_tokens SET status = 'reauth_required', last_error = $2, updated_at = now() WHERE person_id = $1", [personId, reason]);
      await q("COMMIT");
      return "reauth_required" as const;
    };
    if (!refreshToken) return await markReauth("没有 refresh token（授权时未包含 offline_access）");
    let token;
    try {
      token = await client.refreshUserToken(refreshToken);
    } catch (error) {
      if (error instanceof FeishuApiError && REAUTH_CODES.has(error.code)) return await markReauth(`飞书 ${error.code}：${error.message}`);
      await q("UPDATE feishu_user_tokens SET last_error = $2, updated_at = now() WHERE person_id = $1",
        [personId, error instanceof FeishuApiError ? `飞书 ${error.code}：${error.message}` : (error as Error).message]);
      await q("COMMIT");
      throw error;
    }
    await saveRefreshedToken(q, env, personId, token, now);
    await q("COMMIT");
    return "refreshed";
  } catch (error) {
    await q("ROLLBACK").catch(() => undefined);
    throw error;
  } finally {
    db.release();
  }
}

/** 续期用到的 jobs kind 与周期扫描。 */
export function feishuTokenJobs({ pool, env, client, now = () => new Date() }: {
  pool: Pool;
  env: Pick<FeishuEnv, "tokenKey" | "tokenKeyVersion">;
  client: Pick<FeishuClient, "refreshUserToken">;
  now?: () => Date;
}): { handlers: Record<string, JobHandler>; recurring: RecurringJob[] } {
  return {
    handlers: {
      [FEISHU_REFRESH_SCAN_KIND]: async () => { await scanDueTokens(pool, now()); },
      [FEISHU_REFRESH_KIND]: async (payload) => {
        await refreshPersonToken({ pool, env, client, personId: String((payload as { personId?: unknown }).personId), now: now() });
      },
    },
    recurring: [{ kind: FEISHU_REFRESH_SCAN_KIND, everyMs: SCAN_EVERY_MS }],
  };
}
