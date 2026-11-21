import { createHash, randomBytes, randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { auth, type OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { call, executionFixture, newTask, type Fixture } from "./executionFixture.js";

const path = "/api/mcp-oauth";
const verifier = () => randomBytes(32).toString("base64url");
const rpc = (name: string, args?: Record<string, unknown>) => ({ jsonrpc: "2.0", id: 1,
  method: args === undefined ? name : "tools/call", ...(args === undefined ? {} : { params: { name, arguments: args } }) });
async function client(f: Fixture, name = "Codex") {
  const response = await f.t.app.inject({ method: "POST", url: `${path}/register`, payload: {
    client_name: name, redirect_uris: ["http://127.0.0.1/callback"], token_endpoint_auth_method: "none",
  } });
  expect(response.statusCode).toBe(201);
  expect(response.headers["cache-control"]).toBe("no-store");
  expect(response.json().client_secret).toBeUndefined();
  return response.json().client_id as string;
}
async function request(f: Fixture, clientId: string, scope = "tianshu:read tianshu:write") {
  const key = verifier(), redirect = "http://127.0.0.1:54321/callback";
  const query = new URLSearchParams({ client_id: clientId, redirect_uri: redirect, response_type: "code", state: "caller-state",
    code_challenge: createHash("sha256").update(key).digest("base64url"), code_challenge_method: "S256", scope,
    resource: `${f.t.publicOrigin}/mcp/me` });
  const response = await f.t.app.inject({ method: "GET", url: `${path}/authorize?${query}` });
  expect(response.statusCode).toBe(302);
  const id = new URL(String(response.headers.location)).searchParams.get("request")!;
  expect(id).toMatch(/^[0-9a-f-]{36}$/);
  return { id, key, redirect, query, clientId };
}
async function approve(f: Fixture, pending: Awaited<ReturnType<typeof request>>, allow = true, name = "我的电脑") {
  const consent = await call(f, f.member, "GET", `${path}/requests/${pending.id}`);
  expect(consent.statusCode).toBe(200);
  const response = await call(f, f.member, "POST", `${path}/requests/${pending.id}`, { allow, csrfToken: consent.json().csrfToken, name });
  expect(response.statusCode).toBe(200);
  return new URL(response.json().redirect);
}
function token(f: Fixture, input: Record<string, string>) {
  return f.t.app.inject({ method: "POST", url: `${path}/token`, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: new URLSearchParams(input).toString() });
}
const codeInput = (f: Fixture, pending: Awaited<ReturnType<typeof request>>, code: string) => ({ grant_type: "authorization_code",
  client_id: pending.clientId, code, code_verifier: pending.key, redirect_uri: pending.redirect, resource: `${f.t.publicOrigin}/mcp/me` });
async function connect(f: Fixture, scope?: string, name?: string) {
  const pending = await request(f, await client(f), scope);
  const callback = await approve(f, pending, true, name);
  expect(callback.searchParams.get("state")).toBe("caller-state");
  expect(callback.searchParams.get("iss")).toBe(f.t.publicOrigin);
  const input = codeInput(f, pending, callback.searchParams.get("code")!);
  const response = await token(f, input);
  expect(response.statusCode).toBe(200);
  expect(response.json().expires_in).toBe(900);
  return { pending, input, tokens: response.json() as OAuthTokens };
}
const mcp = (f: Fixture, access: string, payload: unknown) => f.t.app.inject({ method: "POST", url: "/mcp/me",
  headers: { authorization: `Bearer ${access}`, accept: "application/json, text/event-stream" }, payload });
const refreshInput = (f: Fixture, connection: Awaited<ReturnType<typeof connect>>, refresh = connection.tokens.refresh_token!) => ({ grant_type: "refresh_token",
  client_id: connection.pending.clientId, refresh_token: refresh, resource: `${f.t.publicOrigin}/mcp/me` });

describe("MCP OAuth", () => {
  it("discovers standard endpoints and rejects unregistered callbacks, insecure redirects and unsupported clients", async () => {
    const f = await executionFixture();
    try {
      const challenge = await f.t.app.inject({ method: "POST", url: "/mcp/me", payload: rpc("tools/list") });
      expect(challenge.statusCode).toBe(401);
      expect(challenge.headers["www-authenticate"]).toContain("/.well-known/oauth-protected-resource/mcp/me");
      const resource = (await f.t.app.inject("/.well-known/oauth-protected-resource/mcp/me")).json();
      expect(resource.resource).toBe(`${f.t.publicOrigin}/mcp/me`);
      const metadata = (await f.t.app.inject("/.well-known/oauth-authorization-server")).json();
      expect(metadata.issuer).toBe(f.t.publicOrigin);
      expect(metadata.code_challenge_methods_supported).toEqual(["S256"]);
      expect(metadata.authorization_response_iss_parameter_supported).toBe(true);
      for (const uri of ["https://evil.example/cb", "https://evil.example/cb#fragment", "http://192.168.1.10/callback", "javascript:alert(1)", "https://user:pass@example.com/cb"]) {
        const response = await f.t.app.inject({ method: "POST", url: `${path}/register`, payload: { redirect_uris: [uri] } });
        expect(response.statusCode).toBe(400);
      }
      expect((await f.t.app.inject({ method: "POST", url: `${path}/register`, payload: { redirect_uris: ["http://127.0.0.1/cb"], token_endpoint_auth_method: "client_secret_post" } })).statusCode).toBe(400);
      const pending = await request(f, await client(f));
      for (const changed of [{ redirect_uri: "https://evil.example/callback" }, { redirect_uri: "http://localhost:54321/callback" }, { client_id: "unknown" }]) {
        const query = new URLSearchParams(pending.query); for (const [key, value] of Object.entries(changed)) query.set(key, value);
        const response = await f.t.app.inject(`${path}/authorize?${query}`);
        expect(response.statusCode).toBe(400); expect(response.headers.location).toBeUndefined();
      }
      for (const changed of [{ code_challenge_method: "plain" }, { resource: "https://wrong.example/mcp" }, { scope: "admin" }]) {
        const query = new URLSearchParams(pending.query); for (const [key, value] of Object.entries(changed)) query.set(key, value);
        const response = await f.t.app.inject(`${path}/authorize?${query}`);
        expect(new URL(String(response.headers.location)).searchParams.get("error")).toBeTruthy();
      }
    } finally { await f.t.close(); }
  });

  it("requires a signed-in account, same origin and account-bound consent; cancellation never creates credentials", async () => {
    const f = await executionFixture();
    try {
      const pending = await request(f, await client(f));
      expect((await f.t.app.inject(`${path}/requests/${pending.id}`)).statusCode).toBe(401);
      const consent = (await call(f, f.member, "GET", `${path}/requests/${pending.id}`)).json();
      const body = { allow: true, csrfToken: consent.csrfToken, name: "电脑" };
      expect((await call(f, f.ceo, "POST", `${path}/requests/${pending.id}`, body)).statusCode).toBe(403);
      expect((await call(f, f.member, "POST", `${path}/requests/${pending.id}`, { ...body, csrfToken: "0".repeat(64) })).statusCode).toBe(403);
      expect((await call(f, f.member, "POST", `${path}/requests/${pending.id}`, { ...body, csrfToken: "中".repeat(64) })).statusCode).toBe(403);
      expect((await f.t.app.inject({ method: "POST", url: `${path}/requests/${pending.id}`, headers: { cookie: f.member, origin: "https://evil.example" }, payload: body })).statusCode).toBe(403);
      const cancelled = await approve(f, pending, false);
      expect(cancelled.searchParams.get("error")).toBe("access_denied");
      expect(cancelled.searchParams.get("state")).toBe("caller-state");
      expect(cancelled.searchParams.get("iss")).toBe(f.t.publicOrigin);
      expect((await call(f, f.member, "GET", "/api/me/tokens")).json().tokens).toEqual([]);
      expect((await call(f, f.member, "POST", `${path}/requests/${pending.id}`, body)).statusCode).toBe(400);
    } finally { await f.t.close(); }
  });

  it("reads and writes as the authorizing person, stores only hashes, retains PAT access and revokes both token types", async () => {
    const f = await executionFixture();
    try {
      const task = (await call(f, f.member, "POST", "/api/me/tasks", newTask())).json();
      const connection = await connect(f);
      const response = await mcp(f, connection.tokens.access_token, rpc("append_progress", { itemId: task.id, body: "OAuth 完成验证" }));
      expect(response.json().result.isError).toBe(false);
      const progress = await f.t.sql("SELECT author_id,source,token_id FROM task_progress WHERE task_id=$1", [task.id]);
      const listing = (await call(f, f.member, "GET", "/api/me/tokens")).json();
      expect(listing.mcpUrl).toBe(`${f.t.publicOrigin}/mcp/me`);
      const listed = listing.tokens;
      expect(listed[0].authType).toBe("oauth"); expect(listed[0].lastUsedAt).toBeTruthy(); expect(listed[0].lastProgressAt).toBeTruthy();
      expect(progress[0]).toMatchObject({ source: "codex", token_id: listed[0].id });
      const stored = await f.t.sql("SELECT secret_hash FROM mcp_oauth_credentials");
      expect(stored).toHaveLength(2); expect(JSON.stringify(stored)).not.toContain(connection.tokens.access_token);
      expect(JSON.stringify(stored)).not.toContain(connection.tokens.refresh_token);
      const personal = (await call(f, f.member, "POST", "/api/me/tokens", { name: "备用", client: "claude", expiresInDays: 90 })).json();
      expect((await mcp(f, personal.token, rpc("tools/list"))).statusCode).toBe(200);
      expect((await call(f, f.ceo, "DELETE", `/api/me/tokens/${listed[0].id}`)).statusCode).toBe(404);
      expect((await call(f, f.member, "DELETE", `/api/me/tokens/${listed[0].id}`)).statusCode).toBe(204);
      expect((await mcp(f, connection.tokens.access_token, rpc("tools/list"))).statusCode).toBe(401);
      expect((await token(f, refreshInput(f, connection))).json().error).toBe("invalid_grant");
      expect((await mcp(f, personal.token, rpc("tools/list"))).statusCode).toBe(200);
    } finally { await f.t.close(); }
  });

  it("enforces read-only scope at both discovery and the HTTP write boundary", async () => {
    const f = await executionFixture();
    try {
      const connection = await connect(f, "tianshu:read");
      const tools = (await mcp(f, connection.tokens.access_token, rpc("tools/list"))).json().result.tools;
      expect(tools.map((tool: { name: string }) => tool.name)).toContain("list_my_items");
      expect(tools.map((tool: { name: string }) => tool.name)).not.toContain("append_progress");
      // 约定与对表：只读的两个照列，交版本是写工具，只读连接里没有。
      expect(tools.map((tool: { name: string }) => tool.name)).toEqual(expect.arrayContaining(["get_task_agreement", "check_task"]));
      expect(tools.map((tool: { name: string }) => tool.name)).not.toContain("add_deliverable_version");
      const denied = await mcp(f, connection.tokens.access_token, rpc("append_progress", { itemId: randomUUID(), body: "不应写入" }));
      expect(denied.statusCode).toBe(403); expect(denied.headers["www-authenticate"]).toContain("insufficient_scope");
      const repairDenied = await mcp(f, connection.tokens.access_token, rpc("report_task_repair_receipt", {
        viewerRole: "member", proposalId: randomUUID(), receipt: { stage: "change" },
      }));
      expect(repairDenied.statusCode).toBe(403);
      expect(repairDenied.headers["www-authenticate"]).toContain("insufficient_scope");
      expect((await token(f, { ...refreshInput(f, connection), scope: "tianshu:read tianshu:write" })).json().error).toBe("invalid_scope");
    } finally { await f.t.close(); }
  });

  it("binds codes to the client, resource, PKCE verifier and exact callback, and expires unconsumed codes", async () => {
    const f = await executionFixture();
    try {
      const pending = await request(f, await client(f));
      const callback = await approve(f, pending);
      const input = codeInput(f, pending, callback.searchParams.get("code")!);
      for (const changed of [{ client_id: await client(f) }, { resource: "https://wrong.example/mcp" }, { redirect_uri: "http://127.0.0.1:54322/callback" }, { code_verifier: verifier() }]) {
        expect((await token(f, { ...input, ...changed })).statusCode).toBe(400);
      }
      expect((await token(f, input)).statusCode).toBe(200);
      expect((await token(f, input)).json().error).toBe("invalid_grant");
      const another = await request(f, pending.clientId); const second = await approve(f, another);
      f.setNow(new Date("2026-10-10T02:01:01Z"));
      expect((await token(f, codeInput(f, another, second.searchParams.get("code")!))).json().error).toBe("invalid_grant");
      const stale = await request(f, pending.clientId);
      f.setNow(new Date("2026-10-10T02:12:00Z"));
      expect((await call(f, f.member, "GET", `${path}/requests/${stale.id}`)).statusCode).toBe(400);
    } finally { await f.t.close(); }
  });

  it("rotates refresh tokens, rejects expired access and revokes the connection on refresh-token replay", async () => {
    const f = await executionFixture();
    try {
      const connection = await connect(f);
      f.setNow(new Date("2026-10-10T02:15:01Z"));
      expect((await mcp(f, connection.tokens.access_token, rpc("tools/list"))).statusCode).toBe(401);
      const refreshed = await token(f, refreshInput(f, connection));
      expect(refreshed.statusCode).toBe(200);
      expect(refreshed.json().refresh_token).not.toBe(connection.tokens.refresh_token);
      expect((await mcp(f, refreshed.json().access_token, rpc("tools/list"))).statusCode).toBe(200);
      expect((await token(f, refreshInput(f, connection))).json().error).toBe("invalid_grant");
      expect((await mcp(f, refreshed.json().access_token, rpc("tools/list"))).statusCode).toBe(401);
      expect((await token(f, refreshInput(f, connection, refreshed.json().refresh_token))).json().error).toBe("invalid_grant");
    } finally { await f.t.close(); }
  });

  it("replaces an earlier connection with the same name when a device signs in again", async () => {
    const f = await executionFixture();
    try {
      const first = await connect(f);
      const again = await connect(f);
      const elsewhere = await connect(f, undefined, "家里电脑");
      expect((await mcp(f, first.tokens.access_token, rpc("tools/list"))).statusCode).toBe(401);
      expect((await token(f, refreshInput(f, first))).json().error).toBe("invalid_grant");
      for (const live of [again, elsewhere]) expect((await mcp(f, live.tokens.access_token, rpc("tools/list"))).statusCode).toBe(200);
      expect((await call(f, f.member, "GET", "/api/me/tokens")).json().tokens.map((view: { name: string }) => view.name).sort()).toEqual(["家里电脑", "我的电脑"].sort());
    } finally { await f.t.close(); }
  });

  it("supports standard revocation, password reset invalidation, connection limits and duplicate form rejection", async () => {
    const f = await executionFixture();
    try {
      const connection = await connect(f);
      const revoked = await f.t.app.inject({ method: "POST", url: `${path}/revoke`, payload: { client_id: connection.pending.clientId, token: connection.tokens.refresh_token } });
      expect(revoked.statusCode).toBe(200); expect((await mcp(f, connection.tokens.access_token, rpc("tools/list"))).statusCode).toBe(401);
      expect((await f.t.app.inject({ method: "POST", url: `${path}/token`, headers: { "content-type": "application/x-www-form-urlencoded" }, payload: "client_id=a&client_id=b" })).json().error).toBe("invalid_request");
      const second = await connect(f);
      await f.t.sql("UPDATE member_access SET session_version=session_version+1 WHERE person_id=(SELECT person_id FROM personal_tokens WHERE auth_type='oauth' AND revoked_at IS NULL LIMIT 1)");
      expect((await mcp(f, second.tokens.access_token, rpc("tools/list"))).statusCode).toBe(401);
      expect((await token(f, refreshInput(f, second))).json().error).toBe("invalid_grant");
      f.member = await f.t.memberCookie();
      for (let i = 0; i < 4; i++) await call(f, f.member, "POST", "/api/me/tokens", { name: `设备${i}`, client: "codex", expiresInDays: 90 });
      const pending = await request(f, second.pending.clientId);
      const consent = (await call(f, f.member, "GET", `${path}/requests/${pending.id}`)).json();
      expect((await call(f, f.member, "POST", `${path}/requests/${pending.id}`, { allow: true, csrfToken: consent.csrfToken, name: "第六个" })).statusCode).toBe(409);
    } finally { await f.t.close(); }
  });

  it("completes discovery, dynamic registration, PKCE and refresh using the official MCP SDK client", async () => {
    const f = await executionFixture();
    try {
      let registered: OAuthClientInformationMixed | undefined, tokens: OAuthTokens | undefined, key = "", authorization: URL | undefined;
      const provider: OAuthClientProvider = {
        redirectUrl: "http://127.0.0.1:54321/callback", clientMetadata: { client_name: "Claude Code", redirect_uris: ["http://127.0.0.1:54321/callback"], token_endpoint_auth_method: "none" },
        clientInformation: () => registered, saveClientInformation: (value) => { registered = value; },
        tokens: () => tokens, saveTokens: (value) => { tokens = value; }, saveCodeVerifier: (value) => { key = value; }, codeVerifier: () => key,
        state: () => "sdk-state", redirectToAuthorization: (url) => { authorization = url; },
      };
      const fetchFn: typeof fetch = async (input, init) => {
        const url = new URL(String(input));
        const response = await f.t.app.inject({ method: (init?.method ?? "GET") as "GET" | "POST", url: `${url.pathname}${url.search}`,
          headers: Object.fromEntries(new Headers(init?.headers)), ...(init?.body ? { payload: String(init.body) } : {}) });
        return new Response(response.statusCode === 204 ? null : response.body, { status: response.statusCode, headers: response.headers as Record<string, string> });
      };
      const options = { serverUrl: `${f.t.publicOrigin}/mcp/me`, fetchFn };
      expect(await auth(provider, options)).toBe("REDIRECT");
      expect(registered?.client_id).toBeTruthy();
      const start = await f.t.app.inject(`${authorization!.pathname}${authorization!.search}`);
      const id = new URL(String(start.headers.location)).searchParams.get("request")!;
      const consent = (await call(f, f.member, "GET", `${path}/requests/${id}`)).json();
      const approved = (await call(f, f.member, "POST", `${path}/requests/${id}`, { allow: true, csrfToken: consent.csrfToken, name: "SDK 客户端" })).json();
      const callback = new URL(approved.redirect);
      expect(callback.searchParams.get("state")).toBe("sdk-state");
      expect(await auth(provider, { ...options, authorizationCode: callback.searchParams.get("code")! })).toBe("AUTHORIZED");
      expect((await mcp(f, tokens!.access_token, rpc("tools/list"))).statusCode).toBe(200);
      const oldRefresh = tokens!.refresh_token;
      expect(await auth(provider, options)).toBe("AUTHORIZED");
      expect(tokens!.refresh_token).not.toBe(oldRefresh);
    } finally { await f.t.close(); }
  });
});
