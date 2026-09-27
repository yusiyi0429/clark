import { createHash, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";
import type { TCreatePersonalTokenRequest, TPersonalTokenClient, TPersonalTokenView } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";

type Row = { id: string; person_id: string; name: string; client: TPersonalTokenClient; secret_hash: string;
  created_at: Date; expires_at: Date | null; last_used_at: Date | null; revoked_at: Date | null };
const view = (row: Row): TPersonalTokenView => ({ id: row.id, name: row.name, client: row.client,
  createdAt: row.created_at.toISOString(), expiresAt: row.expires_at?.toISOString() ?? null,
  lastUsedAt: row.last_used_at?.toISOString() ?? null });
const hash = (random: string, pepper: string) => createHash("sha256").update(random).update(pepper).digest();
const TOKEN = /^tsm_([0-9a-f]{32})_([A-Za-z0-9_-]{43})$/;

export async function listPersonalTokens(q: Query, personId: string): Promise<TPersonalTokenView[]> {
  const rows = (await q("SELECT * FROM personal_tokens WHERE person_id=$1 AND revoked_at IS NULL ORDER BY created_at DESC,id DESC", [personId])).rows as Row[];
  return rows.map(view);
}

export async function createPersonalToken(pool: Pool, personId: string, input: TCreatePersonalTokenRequest, pepper: string, now: Date) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`personal-tokens:${personId}`]);
    const count = Number((await client.query("SELECT count(*) AS n FROM personal_tokens WHERE person_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$2)", [personId, now])).rows[0].n);
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

export async function revokePersonalToken(q: Query, personId: string, id: string): Promise<boolean> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return false;
  return Boolean((await q("UPDATE personal_tokens SET revoked_at=now() WHERE id=$1 AND person_id=$2 AND revoked_at IS NULL", [id, personId])).rowCount);
}

export async function authenticatePersonalToken(q: Query, authorization: string | undefined, pepper: string, now: Date,
  personExists: (personId: string) => boolean): Promise<{ tokenId: string; personId: string; client: TPersonalTokenClient } | null> {
  const match = /^Bearer (\S+)$/.exec(authorization ?? "");
  const parsed = match && TOKEN.exec(match[1]);
  if (!parsed) return null;
  const id = parsed[1].replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, "$1-$2-$3-$4-$5");
  const row = (await q("SELECT * FROM personal_tokens WHERE id=$1", [id])).rows[0] as Row | undefined;
  if (!row || row.revoked_at || row.expires_at && row.expires_at <= now || !personExists(row.person_id)) return null;
  const actual = hash(parsed[2], pepper);
  const expected = Buffer.from(row.secret_hash, "hex");
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
  await q("UPDATE personal_tokens SET last_used_at=$2 WHERE id=$1 AND revoked_at IS NULL", [id, now]);
  // Recheck after the update: revocation committed between SELECT and UPDATE must reject this request.
  const fresh = (await q("SELECT revoked_at,expires_at FROM personal_tokens WHERE id=$1", [id])).rows[0] as Pick<Row, "revoked_at" | "expires_at"> | undefined;
  return fresh && !fresh.revoked_at && (!fresh.expires_at || fresh.expires_at > now) ? { tokenId: id, personId: row.person_id, client: row.client } : null;
}
