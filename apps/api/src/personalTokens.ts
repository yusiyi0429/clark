import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { TCreatePersonalTokenRequest, TPersonalTokenClient, TPersonalTokenView } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";

/**
 * local：本机程序的设备令牌（localDevices.ts）；local_project：本机项目会话的项目钥匙（projectLocalTurns.ts，17.2 第 38 条）。
 * 这两种不占 5 把的名额、不在设置页列，也不能当个人令牌用。
 */
type StoredClient = TPersonalTokenClient | "local" | "local_project";
const MACHINE = "('local','local_project')";
type Row = { id: string; person_id: string; name: string; client: StoredClient; secret_hash: string;
  created_at: Date; expires_at: Date | null; last_used_at: Date | null; revoked_at: Date | null; last_progress_at?: Date | null; auth_type?: "personal" | "oauth" };
const view = (row: Row): TPersonalTokenView => ({ id: row.id, name: row.name, client: row.client as TPersonalTokenClient,
  authType: row.auth_type ?? "personal", createdAt: row.created_at.toISOString(), expiresAt: row.expires_at?.toISOString() ?? null,
  lastUsedAt: row.last_used_at?.toISOString() ?? null, lastProgressAt: row.last_progress_at?.toISOString() ?? null });
const hash = (random: string, pepper: string) => createHash("sha256").update(random).update(pepper).digest();
const TOKEN = /^tsm_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;

export async function listPersonalTokens(q: Query, personId: string): Promise<TPersonalTokenView[]> {
  const rows = (await q(`SELECT t.*, (SELECT max(p.created_at) FROM task_progress p WHERE p.token_id=t.id) AS last_progress_at
    FROM personal_tokens t WHERE t.person_id=$1 AND t.revoked_at IS NULL AND t.client NOT IN ${MACHINE} ORDER BY t.created_at DESC,t.id DESC`, [personId])).rows as Row[];
  return rows.map(view);
}

export async function createPersonalToken(pool: Pool, personId: string, input: TCreatePersonalTokenRequest, pepper: string, now: Date) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`personal-tokens:${personId}`]);
    const count = Number((await client.query(`SELECT count(*) AS n FROM personal_tokens WHERE person_id=$1 AND revoked_at IS NULL AND client NOT IN ${MACHINE} AND (expires_at IS NULL OR expires_at>$2)`, [personId, now])).rows[0].n);
    if (count >= 5) { await client.query("ROLLBACK"); return null; }
    const id = randomUUID(), random = randomBytes(32).toString("base64url");
    const expiresAt = input.expiresInDays === null ? null : new Date(now.getTime() + input.expiresInDays * 86_400_000);
    const row = (await client.query(`INSERT INTO personal_tokens(id,person_id,name,client,secret_hash,created_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7) RETURNING *`, [id, personId, input.name.trim(), input.client, hash(random, pepper).toString("hex"), now, expiresAt])).rows[0] as Row;
    await client.query("COMMIT");
    return { token: `tsm_${id.replaceAll("-", "")}_${random}`, view: view(row) };
  } catch (e) { await client.query("ROLLBACK").catch(() => undefined); throw e; }
  finally { client.release(); }
}

/** 设置页只能吊销外部工具的令牌；本机设备的令牌在插件页随设备一起吊销。 */
export async function revokePersonalToken(q: Query, personId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  return Boolean((await q(`UPDATE personal_tokens SET revoked_at=now() WHERE id=$1 AND person_id=$2 AND revoked_at IS NULL AND client NOT IN ${MACHINE}`, [id, personId])).rowCount);
}

/**
 * 本机设备令牌：在调用方的事务里建（同一台电脑再配对时调用方先吊销旧的），不过期、不占 5 把的名额。
 * project：本机项目会话的项目钥匙（client = local_project，expiresAt 到期）。
 */
export async function issueLocalToken(client: PoolClient, personId: string, name: string, pepper: string, now: Date,
  project?: { expiresAt: Date }): Promise<{ id: string; token: string }> {
  const id = randomUUID(), random = randomBytes(32).toString("base64url");
  await client.query(`INSERT INTO personal_tokens(id,person_id,name,client,secret_hash,created_at,expires_at) VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [id, personId, name.trim().slice(0, 40) || "本机", project ? "local_project" : "local", hash(random, pepper).toString("hex"), now, project?.expiresAt ?? null]);
  return { id, token: `tsm_${id.replaceAll("-", "")}_${random}` };
}

/** 外部工具的个人令牌（MCP、采集器）；本机设备令牌不算，它只能走 authenticateLocalToken。 */
export async function authenticatePersonalToken(q: Query, authorization: string | undefined, pepper: string, now: Date,
  personExists: (personId: string) => boolean): Promise<{ tokenId: string; personId: string; client: TPersonalTokenClient } | null> {
  const identity = await verifyToken(q, authorization, pepper, now, personExists);
  return identity && identity.client !== "local" && identity.client !== "local_project" ? { ...identity, client: identity.client } : null;
}

/** 本机程序的设备令牌（client=local）：只给 /api/local-runner/* 用。 */
export async function authenticateLocalToken(q: Query, authorization: string | undefined, pepper: string, now: Date,
  personExists: (personId: string) => boolean): Promise<{ tokenId: string; personId: string } | null> {
  const identity = await verifyToken(q, authorization, pepper, now, personExists);
  return identity?.client === "local" ? { tokenId: identity.tokenId, personId: identity.personId } : null;
}

/**
 * 本机项目会话的项目钥匙（client=local_project，projectLocalTurns.ts）：只给天枢 MCP 用。
 * 本人还是项目负责人、项目没归档没删、发钥匙的那台电脑没吊销才算数。
 */
export async function authenticateProjectKeyToken(q: Query, authorization: string | undefined, pepper: string, now: Date,
  personExists: (personId: string) => boolean): Promise<{ tokenId: string; personId: string; projectId: string; deviceId: string } | null> {
  const identity = await verifyToken(q, authorization, pepper, now, personExists);
  if (identity?.client !== "local_project") return null;
  const key = (await q(`SELECT k.project_id::text,k.device_id::text FROM local_project_keys k JOIN projects p ON p.id=k.project_id
    JOIN local_devices d ON d.owner_id=k.owner_id AND d.id=k.device_id
    WHERE k.token_id=$1 AND k.owner_id=$2 AND p.owner_id=$2 AND p.archived_at IS NULL AND d.revoked_at IS NULL`, [identity.tokenId, identity.personId])).rows[0] as
    { project_id: string; device_id: string } | undefined;
  return key ? { tokenId: identity.tokenId, personId: identity.personId, projectId: key.project_id, deviceId: key.device_id } : null;
}

async function verifyToken(q: Query, authorization: string | undefined, pepper: string, now: Date,
  personExists: (personId: string) => boolean): Promise<{ tokenId: string; personId: string; client: StoredClient } | null> {
  const match = /^Bearer (\S+)$/.exec(authorization ?? "");
  const parsed = match && TOKEN.exec(match[1]);
  if (!parsed) return null;
  const id = parsed[1].replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
  const row = (await q("SELECT * FROM personal_tokens WHERE id=$1", [id])).rows[0] as Row | undefined;
  if (!row || row.auth_type === "oauth" || row.revoked_at || row.expires_at && row.expires_at <= now || !personExists(row.person_id)) return null;
  const actual = hash(parsed[2], pepper);
  const expected = Buffer.from(row.secret_hash, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  await q("UPDATE personal_tokens SET last_used_at=$2 WHERE id=$1 AND revoked_at IS NULL", [id, now]);
  // Recheck after the update: revocation committed between SELECT and UPDATE must reject this request.
  const fresh = (await q("SELECT revoked_at,expires_at FROM personal_tokens WHERE id=$1", [id])).rows[0] as Pick<Row, "revoked_at" | "expires_at"> | undefined;
  return fresh && !fresh.revoked_at && (!fresh.expires_at || fresh.expires_at > now) ? { tokenId: id, personId: row.person_id, client: row.client } : null;
}
