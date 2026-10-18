import type { Query } from "../meetingStore.js";
import type { FeishuEnv } from "./config.js";
import { decryptTokenSecret, encryptTokenSecret } from "./crypto.js";

/** 飞书 token 接口（v3）的成功结果，字段已换成驼峰。 */
export type FeishuUserToken = {
  accessToken: string;
  expiresIn: number;
  refreshToken?: string;
  refreshExpiresIn?: number;
  scope: string;
};

type KeyEnv = Pick<FeishuEnv, "tokenKey" | "tokenKeyVersion">;

const plusSeconds = (at: Date, seconds: number) => new Date(at.getTime() + seconds * 1000);

/** 授权（或重新授权）后写入：authorized_at 重新计时，状态回到 active。调用方须已有 feishu_identities 行。 */
export async function saveAuthorizedToken(q: Query, env: KeyEnv, personId: string, token: FeishuUserToken, now: Date): Promise<void> {
  const ciphertext = encryptTokenSecret(env.tokenKey, personId, { accessToken: token.accessToken, refreshToken: token.refreshToken });
  await q(
    `INSERT INTO feishu_user_tokens (person_id, key_version, ciphertext, scope, access_expires_at, refresh_expires_at, authorized_at, status, reauth_reminder_at, last_refreshed_at, last_error, updated_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', NULL, NULL, NULL, now())
     ON CONFLICT (person_id) DO UPDATE SET key_version = EXCLUDED.key_version, ciphertext = EXCLUDED.ciphertext, scope = EXCLUDED.scope,
       access_expires_at = EXCLUDED.access_expires_at, refresh_expires_at = EXCLUDED.refresh_expires_at, authorized_at = EXCLUDED.authorized_at,
       status = 'active', reauth_reminder_at = NULL, last_refreshed_at = NULL, last_error = NULL, updated_at = now()`,
    [personId, env.tokenKeyVersion, ciphertext, token.scope, plusSeconds(now, token.expiresIn),
      token.refreshExpiresIn ? plusSeconds(now, token.refreshExpiresIn) : null, now],
  );
}

/** 续期成功后换上新的一对 token；authorized_at 不变（满 365 天仍须重新授权）。 */
export async function saveRefreshedToken(q: Query, env: KeyEnv, personId: string, token: FeishuUserToken, now: Date): Promise<void> {
  const ciphertext = encryptTokenSecret(env.tokenKey, personId, { accessToken: token.accessToken, refreshToken: token.refreshToken });
  await q(
    `UPDATE feishu_user_tokens SET key_version = $2, ciphertext = $3, scope = $4, access_expires_at = $5, refresh_expires_at = $6,
       last_refreshed_at = $7, last_error = NULL, updated_at = now()
     WHERE person_id = $1`,
    [personId, env.tokenKeyVersion, ciphertext, token.scope, plusSeconds(now, token.expiresIn),
      token.refreshExpiresIn ? plusSeconds(now, token.refreshExpiresIn) : null, now],
  );
}

export type StoredFeishuToken = {
  personId: string;
  accessToken: string;
  refreshToken?: string;
  accessExpiresAt: Date;
  status: "active" | "reauth_required";
};

/** 读出并解密本人的 token；没有授权过返回 null。密钥版本对不上时报错，不拿错钥匙硬解。 */
export async function loadUserToken(q: Query, env: KeyEnv, personId: string): Promise<StoredFeishuToken | null> {
  const row = (await q(
    "SELECT key_version, ciphertext, access_expires_at, status FROM feishu_user_tokens WHERE person_id = $1",
    [personId],
  )).rows[0] as { key_version: number; ciphertext: string; access_expires_at: Date; status: StoredFeishuToken["status"] } | undefined;
  if (!row) return null;
  if (row.key_version !== env.tokenKeyVersion) throw new Error(`飞书令牌密钥版本不符：库里是 ${row.key_version}，当前是 ${env.tokenKeyVersion}`);
  const secret = decryptTokenSecret(env.tokenKey, personId, row.ciphertext);
  return { personId, ...secret, accessExpiresAt: row.access_expires_at, status: row.status };
}
