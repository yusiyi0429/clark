import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { OAuthClientMetadataSchema, type OAuthClientInformationFull } from "@modelcontextprotocol/sdk/shared/auth.js";
import { redirectUriMatches } from "@modelcontextprotocol/sdk/server/auth/handlers/authorize.js";
import type { TPersonalTokenClient } from "@warmap/contracts";
import type { Query } from "./meetingStore.js";
import { authenticatePersonalToken } from "./personalTokens.js";
import type { SessionPerson } from "./routes/shared.js";

export const MCP_SCOPES = ["tianshu:read", "tianshu:write"];
export const MCP_WRITE_TOOLS = new Set(["create_item", "update_item", "delete_item", "return_item", "accept_item", "append_progress", "update_status", "submit_for_acceptance", "add_link", "save_review_draft", "edit_mission_card"]);
const ACCESS_SECONDS = 15 * 60;
const GRANT_MS = 90 * 86_400_000;
const digest = (value: string, pepper: string) => createHmac("sha256", pepper).update(`mcp-oauth:${value}`).digest("hex");
const secret = (prefix: string) => `${prefix}_${randomBytes(32).toString("base64url")}`;
const equal = (a: string, b: string) => {
  const left = Buffer.from(a), right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
};
export class McpOAuthError extends Error {
  constructor(public error: string, description: string, public status = 400) { super(description); }
}
const invalidGrant = () => new McpOAuthError("invalid_grant", "授权已失效，请重新连接");
export function oauthUrls(origin: string) {
  const url = new URL(origin);
  if ((url.protocol !== "https:" && !(url.protocol === "http:" && ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname))) ||
      url.username || url.password || url.search || url.hash || url.pathname !== "/") throw new Error("OAuth PUBLIC_ORIGIN must be an HTTPS origin (HTTP loopback is allowed for development)");
  return { issuer: url.origin, resource: `${url.origin}/mcp/me`, metadata: `${url.origin}/.well-known/oauth-protected-resource/mcp/me` };
}
export function parseScopes(scope?: string): string[] {
  const scopes = scope === undefined || scope === "" ? [...MCP_SCOPES] : [...new Set(scope.split(" ").filter(Boolean))];
  if (!scopes.includes("tianshu:read") || scopes.some((value) => !MCP_SCOPES.includes(value)))
    throw new McpOAuthError("invalid_scope", "请求了不支持的权限");
  return scopes;
}
// 只接受本机回环回调：动态注册无需鉴权，放行任意 HTTPS 会让冒名客户端把授权码送到外部服务器。
function validRedirect(uri: string) {
  const url = new URL(uri);
  return !url.hash && !url.username && !url.password && (url.protocol === "http:" || url.protocol === "https:") &&
    ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
}
export async function registerOAuthClient(q: Query, input: unknown, now: Date): Promise<OAuthClientInformationFull> {
  const parsed = OAuthClientMetadataSchema.safeParse(input);
  if (!parsed.success) throw new McpOAuthError("invalid_client_metadata", "客户端信息不完整");
  const data = parsed.data;
  if (!data.redirect_uris.length || data.redirect_uris.length > 10 || data.redirect_uris.some((uri) => !validRedirect(uri)))
    throw new McpOAuthError("invalid_redirect_uri", "回调地址须为本机回环地址");
  if (data.token_endpoint_auth_method && data.token_endpoint_auth_method !== "none" ||
      data.grant_types?.some((grant) => !["authorization_code", "refresh_token"].includes(grant)) ||
      data.response_types?.some((type) => type !== "code"))
    throw new McpOAuthError("invalid_client_metadata", "仅支持使用 PKCE 的公共客户端");
  if (data.scope) parseScopes(data.scope);
  const client: OAuthClientInformationFull = { ...data, client_id: randomUUID(), client_id_issued_at: Math.floor(now.getTime() / 1000),
    token_endpoint_auth_method: "none", grant_types: ["authorization_code", "refresh_token"], response_types: ["code"] };
  await q("INSERT INTO mcp_oauth_clients(id,metadata,created_at) VALUES($1,$2::jsonb,$3)", [client.client_id, JSON.stringify(client), now]);
  return client;
}
type RequestRow = { id: string; client_id: string; redirect_uri: string; resource: string; scopes: string[]; state: string | null;
  challenge: string; expires_at: Date; decided_at: Date | null; grant_id: string | null; code_expires_at: Date | null; consumed_at: Date | null };
export async function startOAuthRequest(q: Query, issuer: string, input: Record<string, string>, now: Date) {
  const { rows } = await q("SELECT metadata FROM mcp_oauth_clients WHERE id=$1", [input.client_id]);
  const client = rows[0]?.metadata as OAuthClientInformationFull | undefined;
  if (!client) throw new McpOAuthError("invalid_client", "客户端尚未注册");
  const redirect = input.redirect_uri ?? (client.redirect_uris.length === 1 ? client.redirect_uris[0] : "");
  if (!validRedirectSafe(redirect) || !client.redirect_uris.some((uri) => redirectUriMatches(redirect, uri)))
    throw new McpOAuthError("invalid_request", "回调地址与注册信息不符");
  // Only redirect after both the client and its callback have been validated.
  try {
    if (input.response_type !== "code" || input.code_challenge_method !== "S256" || !/^[A-Za-z0-9_-]{43}$/.test(input.code_challenge ?? ""))
      throw new McpOAuthError("invalid_request", "必须使用 S256 PKCE 授权码流程");
    const resource = oauthUrls(issuer).resource;
    if (input.resource !== resource) throw new McpOAuthError("invalid_target", "授权目标与天枢 MCP 不符");
    const scopes = parseScopes(input.scope);
    const id = randomUUID();
    await q(`INSERT INTO mcp_oauth_requests(id,client_id,redirect_uri,resource,scopes,state,challenge,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8)`, [id, client.client_id, redirect, resource, scopes, input.state ?? null, input.code_challenge, new Date(now.getTime() + 10 * 60_000)]);
    return `${issuer}/oauth/consent?request=${id}`;
  } catch (error) {
    if (!(error instanceof McpOAuthError)) throw error;
    return callbackUrl(redirect, issuer, input.state, { error: error.error, error_description: error.message });
  }
}
function validRedirectSafe(uri: string) { try { return validRedirect(uri); } catch { return false; } }
function callbackUrl(uri: string, issuer: string, state: string | null | undefined, values: Record<string, string>) {
  const url = new URL(uri);
  for (const [key, value] of Object.entries({ ...values, iss: issuer })) url.searchParams.set(key, value);
  if (state != null) url.searchParams.set("state", state);
  return url.href;
}
export async function readOAuthConsent(q: Query, id: string, person: SessionPerson, pepper: string, now: Date) {
  const row = (await q(`SELECT r.*, c.metadata FROM mcp_oauth_requests r JOIN mcp_oauth_clients c ON c.id=r.client_id
    WHERE r.id=$1 AND r.decided_at IS NULL AND r.expires_at>$2`, [id, now])).rows[0];
  if (!row) throw new McpOAuthError("invalid_request", "连接请求已过期，请从 AI 工具重新登录");
  const name = String(row.metadata.client_name ?? "AI 工具").slice(0, 80);
  return { clientName: name, callbackHost: new URL(row.redirect_uri).host, scopes: row.scopes as string[],
    csrfToken: digest(`${id}:${person.personId}:${person.sessionVersion}`, pepper) };
}
export async function decideOAuthConsent(pool: Pool, issuer: string, id: string, person: SessionPerson, pepper: string,
  input: { allow: boolean; csrfToken: string; name: string }, now: Date) {
  if (!equal(input.csrfToken, digest(`${id}:${person.personId}:${person.sessionVersion}`, pepper)))
    throw new McpOAuthError("invalid_request", "授权页面已失效，请刷新后重试", 403);
  const db = await pool.connect();
  try {
    await db.query("BEGIN");
    const row = (await db.query<RequestRow>("SELECT * FROM mcp_oauth_requests WHERE id=$1 FOR UPDATE", [id])).rows[0];
    if (!row || row.decided_at || row.expires_at <= now) throw invalidGrant();
    let redirect: string;
    if (!input.allow) {
      redirect = callbackUrl(row.redirect_uri, issuer, row.state, { error: "access_denied", error_description: "用户取消了授权" });
    } else {
      await db.query("SELECT pg_advisory_xact_lock(hashtext($1))", [`personal-tokens:${person.personId}`]);
      const name = input.name.trim() || "我的 AI 工具";
      // 同一台设备重新登录会沿用同一个名字：替换旧连接，避免堆到 5 个上限。
      await db.query("UPDATE personal_tokens SET revoked_at=$3 WHERE person_id=$1 AND name=$2 AND auth_type='oauth' AND revoked_at IS NULL",
        [person.personId, name, now]);
      const count = Number((await db.query("SELECT count(*) AS n FROM personal_tokens WHERE person_id=$1 AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at>$2)", [person.personId, now])).rows[0].n);
      if (count >= 5) throw new McpOAuthError("access_denied", "最多保留 5 个连接，请撤销不用的连接后重试", 409);
      const client = (await db.query("SELECT metadata FROM mcp_oauth_clients WHERE id=$1", [row.client_id])).rows[0].metadata;
      const label = String(client.client_name ?? "").toLowerCase();
      const kind: TPersonalTokenClient = label.includes("codex") ? "codex" : label.includes("claude") ? "claude" : "other";
      const grant = randomUUID(), code = secret("tsc");
      await db.query(`INSERT INTO personal_tokens(id,person_id,name,client,secret_hash,created_at,expires_at,auth_type)
        VALUES($1,$2,$3,$4,$5,$6,$7,'oauth')`, [grant, person.personId, name, kind,
        digest(secret("unused"), pepper), now, new Date(now.getTime() + GRANT_MS)]);
      await db.query("INSERT INTO mcp_oauth_grants(id,client_id,resource,scopes,session_version) VALUES($1,$2,$3,$4,$5)",
        [grant, row.client_id, row.resource, row.scopes, person.sessionVersion]);
      await db.query("UPDATE mcp_oauth_requests SET grant_id=$2,code_hash=$3,code_expires_at=$4 WHERE id=$1", [id, grant, digest(code, pepper), new Date(now.getTime() + 60_000)]);
      redirect = callbackUrl(row.redirect_uri, issuer, row.state, { code });
    }
    await db.query("UPDATE mcp_oauth_requests SET decided_at=$2 WHERE id=$1", [id, now]);
    await db.query("COMMIT");
    return redirect;
  } catch (error) { await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}
type GrantRow = { id: string; client_id: string; resource: string; scopes: string[]; session_version: number;
  person_id: string; expires_at: Date; revoked_at: Date | null; current_version: number };
async function lockGrant(db: PoolClient, id: string, now: Date): Promise<GrantRow> {
  const row = (await db.query<GrantRow>(`SELECT g.*,t.person_id,t.expires_at,t.revoked_at,a.session_version AS current_version
    FROM mcp_oauth_grants g JOIN personal_tokens t ON t.id=g.id JOIN member_access a ON a.person_id=t.person_id
    WHERE g.id=$1 FOR UPDATE OF t`, [id])).rows[0];
  if (!row || row.revoked_at || row.expires_at <= now || row.current_version !== row.session_version) throw invalidGrant();
  return row;
}
async function issueCredentials(db: PoolClient, grant: GrantRow, scopes: string[], pepper: string, now: Date) {
  const access = secret("tso"), refresh = secret("tsr");
  const expires = Math.min(ACCESS_SECONDS, Math.floor((grant.expires_at.getTime() - now.getTime()) / 1000));
  if (expires < 1) throw invalidGrant();
  await db.query(`INSERT INTO mcp_oauth_credentials(secret_hash,grant_id,kind,scopes,expires_at) VALUES
    ($1,$2,'access',$3,$4),($5,$2,'refresh',$3,$6)`, [digest(access, pepper), grant.id, scopes, new Date(now.getTime() + expires * 1000), digest(refresh, pepper), grant.expires_at]);
  return { access_token: access, token_type: "Bearer", expires_in: expires, refresh_token: refresh, scope: scopes.join(" ") };
}
export async function exchangeOAuthToken(pool: Pool, issuer: string, pepper: string, input: Record<string, string>, now: Date,
  personExists: (id: string) => boolean) {
  if (!input.client_id) throw new McpOAuthError("invalid_client", "缺少客户端身份");
  if (input.resource !== oauthUrls(issuer).resource) throw new McpOAuthError("invalid_target", "授权目标与天枢 MCP 不符");
  const db = await pool.connect();
  let committed = false;
  try {
    await db.query("BEGIN");
    if (input.grant_type === "authorization_code") {
      const row = (await db.query<RequestRow>("SELECT * FROM mcp_oauth_requests WHERE code_hash=$1 FOR UPDATE", [digest(input.code ?? "", pepper)])).rows[0];
      if (!row || !row.grant_id || row.client_id !== input.client_id || row.resource !== input.resource || row.redirect_uri !== input.redirect_uri ||
          !/^[A-Za-z0-9._~-]{43,128}$/.test(input.code_verifier ?? "") ||
          !equal(createHash("sha256").update(input.code_verifier).digest("base64url"), row.challenge)) throw invalidGrant();
      const grant = await lockGrant(db, row.grant_id, now);
      if (!personExists(grant.person_id)) throw invalidGrant();
      if (row.consumed_at) {
        await db.query("UPDATE personal_tokens SET revoked_at=$2 WHERE id=$1", [grant.id, now]);
        await db.query("COMMIT"); committed = true; throw invalidGrant();
      }
      if (!row.code_expires_at || row.code_expires_at <= now) throw invalidGrant();
      const tokens = await issueCredentials(db, grant, row.scopes, pepper, now);
      await db.query("UPDATE mcp_oauth_requests SET consumed_at=$2 WHERE id=$1", [row.id, now]);
      await db.query("COMMIT"); committed = true; return tokens;
    }
    if (input.grant_type !== "refresh_token") throw new McpOAuthError("unsupported_grant_type", "不支持这种授权方式");
    // Lock the connection before inspecting the refresh token, serializing rotation/revocation.
    const credential = (await db.query("SELECT * FROM mcp_oauth_credentials WHERE secret_hash=$1 AND kind='refresh'", [digest(input.refresh_token ?? "", pepper)])).rows[0];
    if (!credential) throw invalidGrant();
    const grant = await lockGrant(db, credential.grant_id, now);
    if (grant.client_id !== input.client_id || grant.resource !== input.resource || !personExists(grant.person_id)) throw invalidGrant();
    const fresh = (await db.query("SELECT * FROM mcp_oauth_credentials WHERE secret_hash=$1", [credential.secret_hash])).rows[0];
    if (fresh.used_at) {
      await db.query("UPDATE personal_tokens SET revoked_at=$2 WHERE id=$1", [grant.id, now]);
      await db.query("COMMIT"); committed = true; throw invalidGrant();
    }
    if (fresh.expires_at <= now) throw invalidGrant();
    const scopes = input.scope === undefined ? fresh.scopes as string[] : parseScopes(input.scope);
    if (scopes.some((scope) => !fresh.scopes.includes(scope))) throw new McpOAuthError("invalid_scope", "续期不能扩大授权范围");
    const tokens = await issueCredentials(db, grant, scopes, pepper, now);
    await db.query("UPDATE mcp_oauth_credentials SET used_at=$2 WHERE secret_hash=$1", [fresh.secret_hash, now]);
    await db.query("COMMIT"); committed = true; return tokens;
  } catch (error) { if (!committed) await db.query("ROLLBACK"); throw error; }
  finally { db.release(); }
}
export async function revokeOAuthToken(q: Query, clientId: string, token: string, pepper: string, now: Date) {
  await q(`UPDATE personal_tokens t SET revoked_at=$4 FROM mcp_oauth_grants g,mcp_oauth_credentials c
    WHERE t.id=g.id AND c.grant_id=g.id AND g.client_id=$1 AND c.secret_hash=$2 AND t.revoked_at IS NULL AND c.kind=ANY($3::text[])`,
    [clientId, digest(token, pepper), ["access", "refresh"], now]);
}
/** 采集器令牌只能调 /api/collector，不能连 MCP。 */
export type McpIdentity = { tokenId: string; personId: string; client: Exclude<TPersonalTokenClient, "collector">; scopes?: string[] };
export async function authenticateMcpToken(q: Query, authorization: string | undefined, pepper: string, now: Date,
  personExists: (id: string) => boolean, resource?: string): Promise<McpIdentity | null> {
  const token = /^Bearer (tso_[A-Za-z0-9_-]{43})$/.exec(authorization ?? "")?.[1];
  if (!token) {
    const identity = await authenticatePersonalToken(q, authorization, pepper, now, personExists);
    return identity && identity.client !== "collector" ? { tokenId: identity.tokenId, personId: identity.personId, client: identity.client } : null;
  }
  const row = (await q(`SELECT t.id,t.person_id,t.client,c.scopes FROM mcp_oauth_credentials c
    JOIN mcp_oauth_grants g ON g.id=c.grant_id JOIN personal_tokens t ON t.id=g.id
    JOIN member_access a ON a.person_id=t.person_id WHERE c.secret_hash=$1 AND c.kind='access' AND c.expires_at>$2
    AND t.revoked_at IS NULL AND t.expires_at>$2 AND a.session_version=g.session_version AND g.resource=$3`, [digest(token, pepper), now, resource])).rows[0];
  if (!row || !personExists(row.person_id)) return null;
  const updated = await q("UPDATE personal_tokens SET last_used_at=$2 WHERE id=$1 AND revoked_at IS NULL AND expires_at>$2 RETURNING id", [row.id, now]);
  if (!updated.rows.length) return null;
  return { tokenId: row.id, personId: row.person_id, client: row.client, scopes: row.scopes };
}
