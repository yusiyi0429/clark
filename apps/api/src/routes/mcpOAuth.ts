import { Type } from "@sinclair/typebox";
import { OAuthConsentRequest, OAuthConsentResponse, OAuthConsentDecisionResponse } from "@warmap/contracts";
import type { FastifyReply, FastifyRequest } from "fastify";
import { MCP_SCOPES, McpOAuthError, decideOAuthConsent, exchangeOAuthToken, oauthUrls, readOAuthConsent,
  registerOAuthClient, revokeOAuthToken, startOAuthRequest } from "../mcpOAuth.js";
import type { AppInstance, RouteContext } from "./shared.js";
import { isAllowedOrigin } from "./shared.js";

function params(input: unknown): Record<string, string> {
  if (!input || typeof input !== "object" || Array.isArray(input)) throw new McpOAuthError("invalid_request", "请求参数无效");
  const result: Record<string, string> = Object.create(null);
  for (const [key, value] of Object.entries(input)) {
    if (typeof value !== "string" || value.length > 4096) throw new McpOAuthError("invalid_request", "请求参数无效");
    result[key] = value;
  }
  return result;
}
export async function registerMcpOAuthRoutes(app: AppInstance, ctx: RouteContext) {
  const { issuer, resource } = oauthUrls(ctx.env.publicOrigin);
  const metadata = { issuer, authorization_endpoint: `${issuer}/api/mcp-oauth/authorize`, token_endpoint: `${issuer}/api/mcp-oauth/token`,
    registration_endpoint: `${issuer}/api/mcp-oauth/register`, revocation_endpoint: `${issuer}/api/mcp-oauth/revoke`,
    response_types_supported: ["code"], grant_types_supported: ["authorization_code", "refresh_token"],
    token_endpoint_auth_methods_supported: ["none"], revocation_endpoint_auth_methods_supported: ["none"],
    code_challenge_methods_supported: ["S256"], scopes_supported: MCP_SCOPES, authorization_response_iss_parameter_supported: true };
  const headers = (reply: FastifyReply) => reply.header("Cache-Control", "no-store").header("Pragma", "no-cache");
  const cors = (reply: FastifyReply) => headers(reply).header("Access-Control-Allow-Origin", "*");
  app.get("/.well-known/oauth-authorization-server", async (_req, reply) => { cors(reply); return metadata; });
  const resourceMetadata = { resource, authorization_servers: [issuer], scopes_supported: MCP_SCOPES, bearer_methods_supported: ["header"], resource_name: "天枢" };
  for (const path of ["/.well-known/oauth-protected-resource", "/.well-known/oauth-protected-resource/mcp/me"])
    app.get(path, async (_req, reply) => { cors(reply); return resourceMetadata; });

  // The SDK provides client metadata and native loopback callback validation; Fastify handles the HTTP boundary.
  await app.register(async (oauth) => {
    oauth.addContentTypeParser("application/x-www-form-urlencoded", { parseAs: "string", bodyLimit: 16_384 }, (_req, body, done) => {
      const values: Record<string, string> = Object.create(null);
      for (const [key, value] of new URLSearchParams(body as string)) {
        if (Object.hasOwn(values, key)) { done(new McpOAuthError("invalid_request", "参数不能重复")); return; }
        values[key] = value;
      }
      done(null, values);
    });
    oauth.setErrorHandler((error, _req, reply) => {
      cors(reply);
      const statusCode = (error as { statusCode?: number }).statusCode;
      const status = error instanceof McpOAuthError ? error.status : statusCode === 429 ? 429 : statusCode && statusCode < 500 ? statusCode : 500;
      return reply.code(status).send({ error: error instanceof McpOAuthError ? error.error : status === 429 ? "temporarily_unavailable" : status < 500 ? "invalid_request" : "server_error",
        error_description: error instanceof McpOAuthError ? error.message : status < 500 ? "请求格式无效或过于频繁" : "暂时无法完成授权，请重试" });
    });
    for (const path of ["/api/mcp-oauth/register", "/api/mcp-oauth/token", "/api/mcp-oauth/revoke"])
      oauth.options(path, async (_req, reply) => cors(reply).header("Access-Control-Allow-Methods", "POST, OPTIONS")
        .header("Access-Control-Allow-Headers", "Content-Type, Authorization, MCP-Protocol-Version").code(204).send());
    oauth.post("/api/mcp-oauth/register", { bodyLimit: 16_384, config: { rateLimit: { max: 30, timeWindow: "1 hour" } } }, async (req, reply) => {
      cors(reply); return reply.code(201).send(await registerOAuthClient(ctx.q, req.body, ctx.now()));
    });
    oauth.get("/api/mcp-oauth/authorize", { config: { rateLimit: { max: 100, timeWindow: "15 minutes" } } }, async (req, reply) => {
      headers(reply); return reply.redirect(await startOAuthRequest(ctx.q, issuer, params(req.query), ctx.now()));
    });
    oauth.post("/api/mcp-oauth/token", { bodyLimit: 16_384, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
      cors(reply);
      return exchangeOAuthToken(ctx.pool, issuer, ctx.env.sessionSecret, params(req.body), ctx.now(),
        (id) => ctx.peopleDirectory.searchPeople(undefined).some((person) => person.personId === id));
    });
    oauth.post("/api/mcp-oauth/revoke", { bodyLimit: 16_384, config: { rateLimit: { max: 120, timeWindow: "1 minute" } } }, async (req, reply) => {
      cors(reply); const input = params(req.body);
      if (!input.client_id || !input.token) throw new McpOAuthError("invalid_request", "缺少客户端身份或令牌");
      await revokeOAuthToken(ctx.q, input.client_id, input.token, ctx.env.sessionSecret, ctx.now());
      return {};
    });
  });
  const requestParams = Type.Object({ id: Type.String({ format: "uuid" }) }, { additionalProperties: false });
  app.get("/api/mcp-oauth/requests/:id", { preHandler: ctx.requirePerson, schema: { params: requestParams, response: { 200: OAuthConsentResponse } } }, async (req, reply) => {
    headers(reply);
    try { return await readOAuthConsent(ctx.q, req.params.id, req.person!, ctx.env.sessionSecret, ctx.now()); }
    catch (error) { if (!(error instanceof McpOAuthError)) throw error; return ctx.fail(reply, error.status, error.error, error.message); }
  });
  const sameOrigin = async (req: FastifyRequest, reply: FastifyReply) => {
    if (!isAllowedOrigin(ctx.env, req.headers.origin)) return ctx.fail(reply, 403, "ORIGIN_MISMATCH", "请从天枢授权页面操作");
  };
  app.post("/api/mcp-oauth/requests/:id", { preHandler: [ctx.requirePerson, sameOrigin], schema: { params: requestParams, body: OAuthConsentRequest,
    response: { 200: OAuthConsentDecisionResponse } } }, async (req, reply) => {
    headers(reply);
    try { return { redirect: await decideOAuthConsent(ctx.pool, issuer, req.params.id, req.person!, ctx.env.sessionSecret, req.body, ctx.now()) }; }
    catch (error) { if (!(error instanceof McpOAuthError)) throw error; return ctx.fail(reply, error.status, error.error, error.message); }
  });
}
